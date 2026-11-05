/**
 * src/tracker/rooms/forgejo/labels.ts —— 仓库标签清单，以及「哪些票带哪些标签」的补全。
 *
 * 两件事住在同一个文件里，因为它们读的是同一份远端事实，而且第二件完全依赖第一件：
 *
 *  1. `fj repo labels <owner/name> view` 列出仓库标签与颜色。颜色只以终端背景色出现，
 *     解析在 `text.ts`；这里只负责发命令、判失败、拼契约的 `LabelColor[]`。
 *  2. 搜索结果没有标签。为了让列表行带上三态标签（面板上的 triage 圆点靠它），
 *     这里按「一个标签搜一次」把 编号 → 标签名 的对应关系补出来。代价是每个标签一次进程，
 *     所以结果缓存 2 分钟：刷新几拍之内不会重复跑。
 *
 * 两处缓存都按「实例 + 仓库」分键。缓存过期后拿不到新结果不算失败，按「这一拍没有标签」处理，
 * 并记一行 `read.degraded`：列表照常出，只是这一拍的行薄一点。
 */

import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { Label, LabelColor, LabelColorChange } from '../../contract/entities.js'
import type { LabelColorBatchResult, LabelListResult, OpResult, TrackerError } from '../../contract/results.js'
import type { ErrorKind } from '../../contract/identity.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { fail } from '../../kernel/preflight.js'
import { classifyFjError } from './errors.js'
import { fjClient } from './client.js'
import { repoOfHandle } from './repo.js'
import type { ForgejoRepo } from './repo.js'
import { parseLabels } from './text.js'
import type { LabelView } from './text.js'
import { searchAll } from './search.js'
import { emitReadDegraded } from './read-log.js'
import { provenanceOf } from './provenance.js'
import { FORGEJO_SLOW_READ_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'
import { PAGINATION } from '../../contract/pagination.js'

type CtxLike = Partial<OpContext> & Partial<BackendContext>

/** 标签清单缓存 60 秒；成员表缓存 120 秒（它要跑更多进程）。 */
const LABEL_LIST_TTL_MS = 60_000
const MEMBERSHIP_TTL_MS = 120_000

/** 一个标签搜一次，最多读几页；超过就按「这一拍没补全」处理，不无限翻。 */
const MEMBERSHIP_MAX_PAGES = PAGINATION.forgejo.labelMembershipMaxPages

interface LabelCacheEntry {
  at: number
  labels: LabelView[]
}

interface MembershipCacheEntry {
  at: number
  byKey: Map<string, string[]>
}

const labelCache = new Map<string, LabelCacheEntry>()
const membershipCache = new Map<string, MembershipCacheEntry>()

/** 缓存键：同一台实例上的同名仓库才算同一个。 */
function cacheKeyOf(repo: ForgejoRepo): string {
  return repo.hostKey + '|' + repo.refId
}

/**
 * 读一次仓库标签。成功回解析后的标签；`fj` 非 0 退出或输出认不出按失败回。
 *
 * 输出为空是合法的「这个仓库没有标签」，不是失败：`fj` 对没有标签的仓库什么都不打印。
 */
export async function fetchLabels(
  ctx: CtxLike | null | undefined,
  repo: ForgejoRepo,
): Promise<{ ok: true; labels: LabelView[]; raw: string } | { ok: false; error: TrackerError; raw: string }> {
  const result = await fjClient(ctx).run(['repo', 'labels', repo.refId, 'view'], {
    host: repo.host,
    cwd: ctx?.cwd,
    timeout: FORGEJO_SLOW_READ_TIMEOUT_MS,
  })
  const raw = result.stderr || result.stdout
  if (result.code !== 0) {
    const verdict = classifyFjError(result, ctx || undefined)
    return { ok: false, error: fail(verdict.kind, '读不到这个仓库的标签清单', raw).error, raw }
  }
  const labels = parseLabels(result.stdout).slice()
  // 同名标签在 Forgejo 上是允许的（重复建标签不会被拦）。契约按名字定位颜色，
  // 所以同一名字只保留第一次出现的那一条；`setLabelColors` 也只改得到这一条。
  const seen = new Set<string>()
  const unique = labels.filter((label) => {
    if (seen.has(label.name)) return false
    seen.add(label.name)
    return true
  })
  return { ok: true, labels: unique, raw: result.stdout }
}

/** 带缓存地读标签；缓存命中直接回，过期才起进程。 */
export async function fetchLabelsCached(
  ctx: CtxLike | null | undefined,
  repo: ForgejoRepo,
): Promise<{ ok: true; labels: LabelView[]; raw: string } | { ok: false; error: TrackerError; raw: string }> {
  const key = cacheKeyOf(repo)
  const now = Date.now()
  const hit = labelCache.get(key)
  if (hit && now - hit.at < LABEL_LIST_TTL_MS) return { ok: true, labels: hit.labels, raw: '' }
  const outcome = await fetchLabels(ctx, repo)
  if (outcome.ok) labelCache.set(key, { at: now, labels: outcome.labels })
  return outcome
}

/** 契约的 `listLabels`：取不全就整条失败，不返回半份清单。 */
export async function listLabels(
  repo: { refId?: string; host?: string } | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<LabelListResult> {
  const startedAt = Date.now()
  const resolved = await resolveOf(repo, ctx)
  if (!resolved) {
    emitReadDegraded(ctx, 'labels', 'labels:repo-ref', Date.now() - startedAt)
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'listLabels: 认不出这个仓库', '') as LabelListResult
  }
  const outcome = await fetchLabelsCached(ctx, resolved)
  if (!outcome.ok) {
    emitReadDegraded(ctx, 'labels', 'labels:transport', Date.now() - startedAt)
    return { ok: false, error: outcome.error } as LabelListResult
  }
  const data: LabelColor[] = outcome.labels.map((label) => {
    const out: LabelColor = { name: label.name, color: label.color }
    if (label.description) out.description = label.description
    return out
  })
  return {
    ok: true,
    data,
    provenance: provenanceOf('listLabels', { labels: 'complete' }, startedAt),
  } as LabelListResult
}

/**
 * 「编号 → 标签名」的对应关系。
 *
 * 做法：对仓库里每个标签跑一次全状态搜索（`-l <名字>`），把搜到的编号记到这个标签名下。
 * 所有标签都成功才回表；任何一个标签搜失败就回 null，调用方按「这一拍没有标签」处理，
 * 并在日志里留一行——不拿半份表冒充全量（半份表会让票「少标签」而不报错）。
 */
export async function labelMembership(
  ctx: CtxLike | null | undefined,
  repo: ForgejoRepo,
): Promise<Map<string, string[]> | null> {
  const key = cacheKeyOf(repo)
  const now = Date.now()
  const hit = membershipCache.get(key)
  if (hit && now - hit.at < MEMBERSHIP_TTL_MS) return hit.byKey
  const labels = await fetchLabelsCached(ctx, repo)
  if (!labels.ok) return null
  if (labels.labels.length === 0) {
    const empty = new Map<string, string[]>()
    membershipCache.set(key, { at: now, byKey: empty })
    return empty
  }
  const byKey = new Map<string, string[]>()
  for (const label of labels.labels) {
    const outcome = await searchAll(ctx, repo, { state: 'all', labels: [label.name] }, MEMBERSHIP_MAX_PAGES)
    if (!outcome.ok) return null
    for (const row of outcome.data.rows) {
      const list = byKey.get(row.key)
      if (list) list.push(label.name)
      else byKey.set(row.key, [label.name])
    }
  }
  membershipCache.set(key, { at: now, byKey })
  return byKey
}

/** 把一串标签名拼成契约的 `Label[]`，颜色从标签清单里查；查不到写空串（不猜一个颜色）。 */
export function labelsWithColors(names: string[] | null | undefined, colors: Map<string, string>): Label[] {
  const out: Label[] = []
  const seen = new Set<string>()
  for (const raw of Array.isArray(names) ? names : []) {
    const name = String(raw || '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, color: colors.get(name) || '' })
  }
  return out
}

/** 标签清单里 名字 → 颜色 的表（给 `labelsWithColors` 用）。 */
export async function labelColors(
  ctx: CtxLike | null | undefined,
  repo: ForgejoRepo,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const outcome = await fetchLabelsCached(ctx, repo)
  if (!outcome.ok) return map
  for (const label of outcome.labels) map.set(label.name, label.color)
  return map
}

/** 入参仓库可能是 `RepositoryRef`，也可能只带 refId/host；能从任一形状认出坐标就返回。 */
async function resolveOf(
  repo: { refId?: string; host?: string } | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<ForgejoRepo | null> {
  const refId = repo && typeof repo.refId === 'string' ? repo.refId : ''
  const host = repo && typeof repo.host === 'string' ? repo.host : ''
  if (!refId || !host) return null
  return repoOfHandle({ refId, host })
}

/** 清空缓存（测试用；生产代码不许调）。 */
export function clearLabelCaches(): void {
  labelCache.clear()
  membershipCache.clear()
}

export default listLabels

/**
 * 批量改标签颜色。
 *
 * 颜色只认六位十六进制（带不带井号都收）；不合规的那一条记进 `failed`，不碰远端。
 * 找标签先按原名精确匹配，再按大小写不敏感匹配一次——Forgejo 的标签名大小写敏感，
 * 但用户填的颜色表里大小写写错是常事，能对上就不该报「没有这个标签」。
 * 逐条记账：每一条恰好落在 applied 或 failed 之一；部分成功是合法结果。
 */
export async function setLabelColors(
  repo: { refId?: string; host?: string } | null | undefined,
  changes: LabelColorChange[],
  ctx: CtxLike | null | undefined,
): Promise<OpResult<LabelColorBatchResult>> {
  const resolved = await resolveOf(repo, ctx)
  if (!resolved) {
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, 'setLabelColors: 认不出这个仓库', '')
  }
  const listed = await fetchLabels(ctx, resolved)
  if (!listed.ok) return { ok: false, error: listed.error }
  const byName = new Map<string, LabelView>()
  for (const label of listed.labels) byName.set(label.name, label)
  const byLower = new Map<string, LabelView>()
  for (const label of listed.labels) {
    if (!byLower.has(label.name.toLowerCase())) byLower.set(label.name.toLowerCase(), label)
  }
  const applied: { name: string; color: string }[] = []
  const failed: { name: string; reason: TrackerError }[] = []
  for (const change of Array.isArray(changes) ? changes : []) {
    const name = String(change && change.name ? change.name : '').trim()
    const color = String(change && change.color ? change.color : '').trim().replace(/^#/, '').toLowerCase()
    if (!name) {
      failed.push({ name, reason: fail(ERROR_KIND.PARSE as ErrorKind, '标签名是空的', '').error })
      continue
    }
    if (!/^[0-9a-f]{6}$/.test(color)) {
      failed.push({ name, reason: fail(ERROR_KIND.PARSE as ErrorKind, '颜色必须是六位十六进制', color).error })
      continue
    }
    const label = byName.get(name) || byLower.get(name.toLowerCase())
    if (!label) {
      failed.push({ name, reason: fail(ERROR_KIND.NOTFOUND as ErrorKind, '仓库里没有这个标签', name).error })
      continue
    }
    const result = await fjClient(ctx).run(['repo', 'labels', resolved.refId, 'edit', label.id, '-c', color], {
      host: resolved.host,
      cwd: ctx?.cwd,
      timeout: FORGEJO_SLOW_READ_TIMEOUT_MS,
    })
    if (result.code !== 0) {
      const verdict = classifyFjError(result, ctx || undefined)
      failed.push({ name, reason: fail(verdict.kind, '改颜色没有成功', result.stderr || result.stdout).error })
      continue
    }
    applied.push({ name: label.name, color })
  }
  // 改过颜色就丢掉标签缓存，下一次读拿到的是远端真值。
  if (applied.length > 0) labelCache.delete(cacheKeyOf(resolved))
  return { ok: true, data: { applied, failed } }
}
