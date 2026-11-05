/**
 * src/tracker/rooms/forgejo/write-issues.ts —— 建票、关票、改票（#1875 从 issues.ts 拆出）。
 *
 * 为什么单独一份：issues.ts 是读的主路（列、详情、收集），写路径各条命令只改一个字段，
 * 两批放在一个文件里会越过单文件 350 有效行的门禁，也让「读为什么慢」与「写为什么不是原子」
 * 两段说明挤在一起。读写之间只有 getIssue 这一条依赖，拆开没有循环。
 *
 * 三件事今天必须记住：
 *  1. 建票先验幂等键、再按锚回查；命中就一个字节都不写。补标签与指派人失败不回滚（票已经在了）。
 *  2. 改票没有原子写：标题、正文、里程碑各一条命令，中途失败时前面的字段已经落盘。
 *  3. 去标签与去依赖在 Forgejo 17.0.1 上会重置连接，这里不碰它们（见 writes.ts）。
 */

import type { OpContext } from '../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../contract/entities.js'
import type { OpResult, TrackerError } from '../../contract/results.js'
import type { CreateInput, UpdatePatch } from '../../contract/inputs.js'
import type { ErrorKind } from '../../contract/identity.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { fail } from '../../kernel/preflight.js'
import { anchorLineFor, checkIdempotencyKey } from '../../../refresh/contract/idempotency-keys.js'
import { fjClient, repoOpts } from './client.js'
import { failureOf, getIssue, targetOf, type CtxLike } from './issues.js'
import type { ForgejoRepo } from './repo.js'
import { parseCreatedKey, parseIssueView } from './text.js'
import { searchAll } from './search.js'
import { rewriteDescriptionWithHiddenParent } from './description-markers.js'
import { emitReadDegraded } from './read-log.js'
import {
  FORGEJO_CREATE_TIMEOUT_MS,
  FORGEJO_READ_TIMEOUT_MS,
  FORGEJO_SLOW_READ_TIMEOUT_MS,
} from '../../../shared/time-config/src/values.js'
import { PAGINATION } from '../../contract/pagination.js'

/** 幂等锚回查最多看几页候选；再多的候选按「回查拿不准」处理，不无限翻。 */
const ANCHOR_MAX_PAGES = PAGINATION.forgejo.anchorLookupMaxPages

/** 回查时最多逐张读几张候选的正文。 */
const ANCHOR_MAX_CANDIDATES = PAGINATION.forgejo.anchorLookupMaxCandidates

/** 按幂等锚回查。命中回那张票的编号；确定没有回 null；拿不准按失败回。 */
async function lookupByAnchor(
  ctx: CtxLike | null | undefined,
  repo: ForgejoRepo,
  anchor: string,
): Promise<{ ok: true; hit: string | null } | { ok: false; error: TrackerError }> {
  const searched = await searchAll(ctx, repo, { state: 'all', query: anchor }, ANCHOR_MAX_PAGES)
  if (!searched.ok) return { ok: false, error: searched.error }
  const rows = searched.data.rows.slice(0, ANCHOR_MAX_CANDIDATES)
  for (const row of rows) {
    const view = await fjClient(ctx).run(['issue', 'view', row.key], {
      ...repoOpts(repo),
      cwd: ctx?.cwd,
      timeout: FORGEJO_READ_TIMEOUT_MS,
    })
    if (view.code !== 0) continue
    const parsed = parseIssueView(view.stdout)
    if (parsed && parsed.body.indexOf(anchorLineFor(anchor).trim()) >= 0) return { ok: true, hit: parsed.key }
  }
  return { ok: true, hit: null }
}

/**
 * 建票。
 *
 * 先验幂等键，再按锚回查；命中就直接返回那张票，一个字节都不写。建完之后才补标签与指派人：
 * 这两步失败不回滚（票已经在了），只记降级，票照常交回。
 */
export async function createIssue(
  repo: RepositoryRef | null | undefined,
  input: CreateInput,
  ctx: CtxLike | null | undefined,
): Promise<OpResult<Issue>> {
  const startedAt = Date.now()
  const target = await targetOf(repo, ctx, 'create')
  if (!target.ok) return target
  const title = input && typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) return fail(ERROR_KIND.PARSE as ErrorKind, 'create: 标题不能为空', '')
  const checked = input.idempotencyKey === undefined || input.idempotencyKey === null
    ? null
    : checkIdempotencyKey(input.idempotencyKey)
  if (checked && !checked.ok) {
    return fail(ERROR_KIND.PARSE as ErrorKind, 'create: idempotencyKey 不能用：' + checked.reason, String(input.idempotencyKey))
  }
  const anchor = checked ? checked.key : ''
  if (anchor) {
    const found = await lookupByAnchor(ctx, target.repo, anchor)
    if (!found.ok) return found
    if (found.hit) {
      return getIssue(repo, found.hit, { comments: { first: 0 } }, ctx) as Promise<OpResult<Issue>>
    }
  }

  let body = typeof input.body === 'string' ? input.body : ''
  if (anchor) body = anchorLineFor(anchor) + body
  if (input.parentKey !== undefined && input.parentKey !== null) {
    body = rewriteDescriptionWithHiddenParent(body, String(input.parentKey))
  }
  const result = await fjClient(ctx).run(['issue', 'create', title, '--body', body], {
    ...repoOpts(target.repo),
    cwd: ctx?.cwd,
    timeout: FORGEJO_CREATE_TIMEOUT_MS,
  })
  if (result.code !== 0) return failureOf(result, ctx, '建票没有成功')
  const created = parseCreatedKey(result.stdout)
  if (!created) {
    // 命令成功了但回执认不出来：票可能已经建好，按「拿不准」如实失败，不重试第二次写。
    return fail(ERROR_KIND.PARSE as ErrorKind, '建票命令跑成了，但看不懂回执里的票号（可能已经建好，请先查一下再重试）', result.stdout)
  }

  const names = Array.isArray(input.labels)
    ? input.labels.map((label) => (typeof label === 'string' ? label : label && typeof label.name === 'string' ? label.name : '')).filter((name) => name !== '')
    : []
  if (names.length > 0) {
    const args = ['issue', 'edit', created, 'labels']
    for (const name of names) args.push('--add', name)
    const labelled = await fjClient(ctx).run(args, { ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_CREATE_TIMEOUT_MS })
    if (labelled.code !== 0) emitReadDegraded(ctx as OpContext, 'create', 'create:partial', Date.now() - startedAt)
  }
  const people = Array.isArray(input.assignees)
    ? input.assignees.map((person) => (typeof person === 'string' ? person : person && typeof person.login === 'string' ? person.login : '')).filter((login) => login !== '')
    : []
  if (people.length > 0) {
    const assigned = await fjClient(ctx).run(['issue', 'assign', created].concat(people), {
      ...repoOpts(target.repo),
      cwd: ctx?.cwd,
      timeout: FORGEJO_CREATE_TIMEOUT_MS,
    })
    if (assigned.code !== 0) emitReadDegraded(ctx as OpContext, 'create', 'create:partial', Date.now() - startedAt)
  }
  return getIssue(repo, created, { comments: { first: 0 } }, ctx) as Promise<OpResult<Issue>>
}

/** 关票。关完读回一张完整的票；读不回来就只交回一张带编号与状态的薄票。 */
export async function closeIssue(
  repo: RepositoryRef | null | undefined,
  key: string,
  opts: unknown,
  ctx: CtxLike | null | undefined,
): Promise<OpResult<Issue>> {
  void opts
  const target = await targetOf(repo, ctx, 'close')
  if (!target.ok) return target
  const id = String(key || '').trim()
  if (!id) return fail(ERROR_KIND.PARSE as ErrorKind, 'close: 票号是空的', '')
  const result = await fjClient(ctx).run(['issue', 'close', id], {
    ...repoOpts(target.repo),
    cwd: ctx?.cwd,
    timeout: FORGEJO_SLOW_READ_TIMEOUT_MS,
  })
  if (result.code !== 0) return failureOf(result, ctx, '关票没有成功')
  return getIssue(repo, id, { comments: { first: 0 } }, ctx) as Promise<OpResult<Issue>>
}

/**
 * 改票。
 *
 * 标题、正文、里程碑各是一条命令，按顺序写；不是原子操作，中途失败时前面的字段已经落盘。
 * 自定义字段在 Forgejo 上没有对应物，按 `unsupported` 如实拒绝，不静默丢掉。
 */
export async function updateIssue(
  repo: RepositoryRef | null | undefined,
  key: string,
  patch: UpdatePatch,
  ctx: CtxLike | null | undefined,
): Promise<OpResult<Issue>> {
  const target = await targetOf(repo, ctx, 'update')
  if (!target.ok) return target
  const id = String(key || '').trim()
  if (!id) return fail(ERROR_KIND.PARSE as ErrorKind, 'update: 票号是空的', '')
  if (!patch || typeof patch !== 'object') return fail(ERROR_KIND.PARSE as ErrorKind, 'update: 补丁是空的', '')
  if (Array.isArray(patch.customFields) && patch.customFields.length > 0) {
    return fail(ERROR_KIND.UNSUPPORTED as ErrorKind, 'Forgejo 没有自定义字段', JSON.stringify(patch.customFields))
  }
  const client = fjClient(ctx)
  let changed = false
  if (typeof patch.title === 'string') {
    const result = await client.run(['issue', 'edit', id, 'title', patch.title], {
      ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_SLOW_READ_TIMEOUT_MS,
    })
    if (result.code !== 0) return failureOf(result, ctx, '改标题没有成功')
    changed = true
  }
  if (typeof patch.body === 'string') {
    const result = await client.run(['issue', 'edit', id, 'body', patch.body], {
      ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_SLOW_READ_TIMEOUT_MS,
    })
    if (result.code !== 0) return failureOf(result, ctx, '改正文没有成功')
    changed = true
  }
  if ('milestone' in patch) {
    const milestone = patch.milestone
    const args = milestone && typeof milestone.name === 'string'
      ? ['issue', 'edit', id, 'milestone', milestone.name]
      : ['issue', 'edit', id, 'milestone', '--unset']
    const result = await client.run(args, {
      ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_SLOW_READ_TIMEOUT_MS,
    })
    if (result.code !== 0) return failureOf(result, ctx, '改里程碑没有成功')
    changed = true
  }
  if (!changed) return getIssue(repo, id, {}, ctx) as Promise<OpResult<Issue>>
  return getIssue(repo, id, { comments: { first: 0 } }, ctx) as Promise<OpResult<Issue>>
}
