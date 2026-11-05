/**
 * src/tracker/rooms/forgejo/issues.ts —— 票的读写主路：列、读、建、关、改。
 *
 * `fj` 的能力边界决定了这一间房的形状，写在前头，免得后来的人以为是实现偷懒：
 *
 *  1. 列表只有搜索一条路。`fj issue search` 一行只给编号、标题、作者；没有正文、标签、
 *     指派人、时间。标签靠 `labels.ts` 按「一个标签搜一次」补；其余字段列表里没有，
 *     详情页才有。所以列表行是薄行，登记为 `partial`。
 *  2. 单票读一次要起几个进程：`view` 是票面，`view assignees` 是指派人，
 *     `view comments` 是评论，`depend list` 是原生阻塞边。四个都读才拼得出一张完整的票，
 *     所以 `get` 比另外两间房慢，但每一项都是真数据，不猜。
 *  3. 写路径一条命令只改一个字段（标题、正文、里程碑各一条）。多字段补丁只能顺序执行，
 *     中途失败时前面的字段已经落盘——登记为 `partial`，不假装原子。
 *  4. 没有 `fj issue reopen`。重开在登记表里记成欠账（等 forgejo-cli 补命令），
 *     注册表会给它补「我不支持」的桩。
 */

import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../contract/entities.js'
import type {
  IssueDetailResult,
  IssueListResult,
  OpResult,
  TrackerError,
} from '../../contract/results.js'
import type { GetOpts, ListFilter } from '../../contract/inputs.js'
import type { ErrorKind, State } from '../../contract/identity.js'
import { ERROR_KIND, STATE } from '../../contract/vocabulary.js'
import { fail } from '../../kernel/preflight.js'
import { fjClient, repoOpts } from './client.js'
import { classifyFjError, hintFor } from './errors.js'
import { resolveRepo } from './repo.js'
import type { ForgejoRepo } from './repo.js'
import { parseAssignees, parseComments, parseDependencyRows, parseIssueView } from './text.js'
import { issueFromRow, issueFromView } from './normalize.js'
import { labelMembership, labelColors } from './labels.js'
import { searchAll } from './search.js'
import type { SearchRow } from './text.js'
import { READ_DEGRADED_REASONS, emitReadDegraded } from './read-log.js'
import { provenanceOf } from './provenance.js'
import { FORGEJO_READ_TIMEOUT_MS, FORGEJO_SLOW_READ_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'
import { PAGINATION } from '../../contract/pagination.js'

/** 上下文只取用到的几格，允许半份；缺了按「这一趟做不成」如实失败。 */
export type CtxLike = Partial<OpContext> & Partial<BackendContext>

/** 列表最多翻多少页（实例每页 25 条，60 页约 1500 张）；到顶就回 truncated，不冒充整仓。 */
const LIST_MAX_PAGES = PAGINATION.forgejo.listMaxPages

/** 幂等锚回查最多看几页候选；再多的候选按「回查拿不准」处理，不无限翻。 */
const ANCHOR_MAX_PAGES = PAGINATION.forgejo.anchorLookupMaxPages

/** 回查时最多逐张读几张候选的正文。 */
const ANCHOR_MAX_CANDIDATES = PAGINATION.forgejo.anchorLookupMaxCandidates

/** 从契约仓库引用里取出这一间房认的坐标。 */
function repoRefOf(repo: RepositoryRef | null | undefined, resolved: ForgejoRepo): RepositoryRef {
  const refId = resolved.refId || (repo && typeof repo.refId === 'string' ? repo.refId : '')
  const out: RepositoryRef = {
    backend: 'forgejo',
    refId,
    name: refId,
    url: resolved.url || '',
  }
  if (resolved.host) out.host = resolved.host
  return out
}

/** 把一次 `fj` 进程结果收成失败信封；消息用本家那句话，原文带上。 */
export function failureOf(result: { stdout: string; stderr: string; code: number }, ctx: CtxLike | null | undefined, message: string): { ok: false; error: TrackerError } {
  const verdict = classifyFjError(result, ctx || undefined)
  return fail(verdict.kind, hintFor(verdict, message), result.stderr || result.stdout)
}

/** 解析目标仓库；认不出按 not-found 失败（这一间房没有「默认实例」可退）。 */
export async function targetOf(
  repo: RepositoryRef | null | undefined,
  ctx: CtxLike | null | undefined,
  op: string,
): Promise<{ ok: true; repo: ForgejoRepo; ref: RepositoryRef } | { ok: false; error: TrackerError }> {
  const resolved = await resolveRepo(repo || null, ctx || {})
  if (!resolved) {
    // 只有登记过的读操作才记降级；写路径没有 `read.degraded` 的口径，不硬塞一条假事件。
    const reason = op + ':repo-ref'
    if ((READ_DEGRADED_REASONS as readonly string[]).indexOf(reason) >= 0) emitReadDegraded(ctx as OpContext, op, reason, 0)
    return fail(ERROR_KIND.NOTFOUND as ErrorKind, op + ': 认不出这个 Forgejo 仓库（缺实例地址或远端）', '')
  }
  return { ok: true, repo: resolved, ref: repoRefOf(repo, resolved) }
}

/** 读一次票面（写路径只需要票面时用它，不额外拉评论与指派人）。 */
export async function viewIssue(
  repo: RepositoryRef | null | undefined,
  key: string,
  ctx: CtxLike | null | undefined,
): Promise<{ ok: true; parsed: ReturnType<typeof parseIssueView> & {}; ref: RepositoryRef; target: ForgejoRepo } | { ok: false; error: TrackerError }> {
  const target = await targetOf(repo, ctx, 'update')
  if (!target.ok) return target
  const id = String(key || '').trim()
  if (!id) return fail(ERROR_KIND.PARSE as ErrorKind, '票号是空的', '')
  const result = await fjClient(ctx).run(['issue', 'view', id], {
    ...repoOpts(target.repo),
    cwd: ctx?.cwd,
    timeout: FORGEJO_SLOW_READ_TIMEOUT_MS,
  })
  if (result.code !== 0) return failureOf(result, ctx, '读不到这张票')
  const parsed = parseIssueView(result.stdout)
  if (!parsed) return fail(ERROR_KIND.PARSE as ErrorKind, '看不懂 fj 的票面输出（格式变了？）', result.stdout)
  return { ok: true, parsed, ref: target.ref, target: target.repo }
}

/**
 * 按状态收集搜索结果。
 *
 * 状态省略时分开搜 `open` 与 `closed` 两次再合并：搜索结果本身不打印每一行的状态，
 * 分开搜是唯一能知道「这一行是开是关」的办法；拿一次 `all` 再把状态猜成 open 是撒谎。
 */
export async function collect(
  ctx: CtxLike | null | undefined,
  repo: Pick<ForgejoRepo, 'host' | 'refId'>,
  state: State | undefined,
  labels: string[],
): Promise<{ ok: true; rows: SearchRow[]; stateOf: Map<string, State>; truncated: boolean } | { ok: false; error: TrackerError }> {
  const states: State[] = state ? [state] : [STATE.OPEN as State, STATE.CLOSED as State]
  const rows: SearchRow[] = []
  const stateOf = new Map<string, State>()
  let truncated = false
  for (const one of states) {
    let pageRows: SearchRow[]
    if (labels.length > 1) {
      // 多标签要同时满足：一个标签搜一次再取交集，不指望服务端的逗号语义与我们的「全部满足」一致。
      const sets: SearchRow[][] = []
      for (const label of labels) {
        const outcome = await searchAll(ctx, repo, { state: one, labels: [label] }, LIST_MAX_PAGES)
        if (!outcome.ok) return { ok: false, error: outcome.error }
        if (outcome.data.truncated) truncated = true
        sets.push(outcome.data.rows)
      }
      const first = sets[0] || []
      const common = new Set((sets[1] || []).map((row) => row.key))
      for (const set of sets.slice(2)) {
        for (const key of [...common]) if (!set.some((row) => row.key === key)) common.delete(key)
      }
      pageRows = first.filter((row) => common.has(row.key))
    } else {
      const outcome = await searchAll(ctx, repo, { state: one, labels }, LIST_MAX_PAGES)
      if (!outcome.ok) return { ok: false, error: outcome.error }
      if (outcome.data.truncated) truncated = true
      pageRows = outcome.data.rows
    }
    for (const row of pageRows) {
      if (stateOf.has(row.key)) continue
      rows.push(row)
      stateOf.set(row.key, one)
    }
  }
  return { ok: true, rows, stateOf, truncated }
}

/**
 * 列票（薄行）。
 *
 * 过滤器里能下推到远端的只有状态与标签；`keys` 在内存里筛。`parentKey` 与 `type: 'spec'`
 * 需要正文，搜索结果没有正文，所以这一趟做不到——按 `list:partial` 记一行，行照常返回，
 * 不拿「筛过」冒充「筛全了」。
 */
export async function listIssues(
  repo: RepositoryRef | null | undefined,
  filter: ListFilter | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<IssueListResult> {
  const startedAt = Date.now()
  const target = await targetOf(repo, ctx, 'list')
  if (!target.ok) return target
  const state = filter && (filter.state === STATE.OPEN || filter.state === STATE.CLOSED) ? filter.state : undefined
  const wanted = Array.isArray(filter?.labels) ? filter.labels.filter((name) => typeof name === 'string' && name !== '') : []
  if (filter && filter.type === 'map' && wanted.indexOf('wayfinder:map') < 0) wanted.push('wayfinder:map')
  const outcome = await collect(ctx, target.repo, state, wanted)
  if (!outcome.ok) return outcome

  // 需要按种类筛（map/issue）或按 parentKey 筛时，标签成员表必须补到；补不到就不筛，并记降级。
  const needsMembership = filter?.type !== undefined || filter?.parentKey !== undefined
  const membership = await labelMembership(ctx, target.repo)
  if (!membership && needsMembership) {
    emitReadDegraded(ctx as OpContext, 'list', 'list:partial', Date.now() - startedAt)
  }
  if (filter?.parentKey !== undefined) {
    emitReadDegraded(ctx as OpContext, 'list', 'list:partial', Date.now() - startedAt)
  }
  const colors = membership ? await labelColors(ctx, target.repo) : new Map<string, string>()
  const wantedKeys = Array.isArray(filter?.keys) ? new Set(filter.keys.map(String)) : null
  const issues: Issue[] = []
  for (const row of outcome.rows) {
    if (wantedKeys && !wantedKeys.has(row.key)) continue
    const names = membership ? membership.get(row.key) : undefined
    if (filter?.type === 'map' && !(names || []).some((name) => name === 'wayfinder:map')) continue
    if (filter?.type === 'issue' && (names || []).some((name) => name === 'wayfinder:map')) continue
    const issue = issueFromRow(row, {
      repo: target.ref,
      state: outcome.stateOf.get(row.key) || (STATE.OPEN as State),
      labels: membership ? (names || []) : undefined,
      colors,
    })
    issues.push(issue)
  }
  const result: IssueListResult = {
    ok: true,
    data: issues,
    provenance: provenanceOf('list', {
      row: 'truncated',
      labels: membership ? 'complete' : 'unexpressed',
    }, startedAt),
  }
  if (outcome.truncated) {
    result.truncated = true
    emitReadDegraded(ctx as OpContext, 'list', 'list:truncated', Date.now() - startedAt)
  }
  return result
}

/**
 * 读单票。
 *
 * `opts.comments.first === 0` 时只读条数、不起评论那一趟；其余情况把评论一次读全
 * （`fj` 没有评论分页参数），再用 `first` 截断。`after` 无法表达，按「从第一条开始」处理。
 */
export async function getIssue(
  repo: RepositoryRef | null | undefined,
  key: string,
  opts: GetOpts | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<IssueDetailResult> {
  const startedAt = Date.now()
  const target = await targetOf(repo, ctx, 'get')
  if (!target.ok) return target
  const id = String(key || '').trim()
  if (!id) return fail(ERROR_KIND.PARSE as ErrorKind, 'get: 票号是空的', '')
  const client = fjClient(ctx)
  const view = await client.run(['issue', 'view', id], {
    ...repoOpts(target.repo),
    cwd: ctx?.cwd,
    timeout: FORGEJO_SLOW_READ_TIMEOUT_MS,
  })
  if (view.code !== 0) {
    emitReadDegraded(ctx as OpContext, 'get', 'get:transport', Date.now() - startedAt)
    return failureOf(view, ctx, '读不到这张票')
  }
  const parsed = parseIssueView(view.stdout)
  if (!parsed) {
    emitReadDegraded(ctx as OpContext, 'get', 'get:text', Date.now() - startedAt)
    return fail(ERROR_KIND.PARSE as ErrorKind, '看不懂 fj 的票面输出（格式变了？）', view.stdout)
  }

  const assignees = await client.run(['issue', 'view', id, 'assignees'], {
    ...repoOpts(target.repo),
    cwd: ctx?.cwd,
    timeout: FORGEJO_READ_TIMEOUT_MS,
  })
  const commentsWanted = !opts?.comments || opts.comments.first !== 0
  let comments: ReturnType<typeof parseComments> = []
  let commentsOk = false
  if (commentsWanted) {
    const commentRun = await client.run(['issue', 'view', id, 'comments'], {
      ...repoOpts(target.repo),
      cwd: ctx?.cwd,
      timeout: FORGEJO_SLOW_READ_TIMEOUT_MS,
    })
    if (commentRun.code === 0) {
      comments = parseComments(commentRun.stdout)
      commentsOk = true
      if (opts?.comments && opts.comments.first > 0) comments = comments.slice(0, opts.comments.first)
    } else {
      // 评论读不到不拖垮整张票：票面自带条数，正文这一组按未表达处理。
      emitReadDegraded(ctx as OpContext, 'get', 'get:transport', Date.now() - startedAt)
    }
  }

  const depend = await client.run(['issue', 'depend', 'list', id], {
    ...repoOpts(target.repo),
    cwd: ctx?.cwd,
    timeout: FORGEJO_READ_TIMEOUT_MS,
  })
  const dependencies = depend.code === 0 ? parseDependencyRows(depend.stdout) : undefined
  const colors = await labelColors(ctx, target.repo)
  const issue = issueFromView(parsed, {
    repo: target.ref,
    colors,
    assignees: assignees.code === 0 ? parseAssignees(assignees.stdout) : undefined,
    comments: commentsOk ? comments : undefined,
    dependencies,
  })
  return {
    ok: true,
    data: issue,
    provenance: provenanceOf('get', {
      row: 'complete',
      body: 'complete',
      comments: commentsOk ? 'complete' : 'unexpressed',
      parents: 'complete',
      dependencies: dependencies ? 'complete' : 'unexpressed',
      subIssues: 'unexpressed',
      review: 'unexpressed',
      mergeInfo: 'unexpressed',
    }, startedAt),
  }
}


export default { listIssues, getIssue }
