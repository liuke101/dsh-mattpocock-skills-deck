/**
 * src/tracker/rooms/forgejo/counts.ts —— 数票、按页取票、取全部地图薄行。
 *
 * 三件事共用同一个事实：`fj issue search` 的头部写着「一共几条」。数票读的就是这一格，
 * 不枚举全仓；翻页用的是它的 `-p`，游标里只装「下一次从第几页第几行开始」与第一次算出的总数。
 *
 * 三条与这一间房有关的限制，都登记在能力表里：
 *  1. 搜索结果没有时间戳。`listPage` 承诺按创建时间倒序，`listMaps` 承诺按更新时间倒序，
 *     Forgejo 都做不到；排序退回 Forgejo 自己的搜索顺序（实测是创建时间倒序，但没有接口保证）。
 *  2. 不筛状态时要把开、关两份结果拼起来：每张票的状态只有「从哪一份结果里读到的」这一条证据，
 *     所以拼接顺序是「开着的一批在前、关着的一批在后」，不是跨状态的时间序。
 *  3. 一张票的状态由查询时选的 `-s` 决定，单张票的状态值永远来自它所在的那份结果，不猜。
 */

import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../contract/entities.js'
import type { CountsResult, MapListOpResult, MapRow, ReadPageResult, TrackerError } from '../../contract/results.js'
import type { ListFilter, PageOpts } from '../../contract/inputs.js'
import type { ErrorKind, State } from '../../contract/identity.js'
import { ERROR_KIND, STATE } from '../../contract/vocabulary.js'
import { fail } from '../../kernel/preflight.js'
import { parseSearchPage } from './text.js'
import type { SearchRow } from './text.js'
import { fjClient } from './client.js'
import { targetOf, collect } from './issues.js'
import { issueAddressOf } from './repo.js'
import { labelMembership, labelColors } from './labels.js'
import { searchPage } from './search.js'
import { issueFromRow } from './normalize.js'
import { provenanceOf } from './provenance.js'
import { emitReadDegraded } from './read-log.js'
import { FORGEJO_SLOW_READ_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'
import { PAGINATION } from '../../contract/pagination.js'

type CtxLike = Partial<OpContext> & Partial<BackendContext>

/** 一页缺省 50 行、最多 200 行（契约口径）；实例自己的搜索页是 25 行，内部按需多翻几页。 */
const DEFAULT_LIMIT = PAGINATION.forgejo.limitDefault
const MAX_LIMIT = PAGINATION.forgejo.limitMax

/** 数一档状态的总数；`fj` 只为这一格起一个进程。 */
async function countState(
  ctx: CtxLike | null | undefined,
  repo: { host: string; refId: string },
  state: 'open' | 'closed',
  labels: string[],
): Promise<{ ok: true; total: number } | { ok: false; error: TrackerError }> {
  const args = ['issue', 'search', '-r', repo.refId, '-s', state]
  if (labels.length > 0) args.push('-l', labels.join(','))
  const result = await fjClient(ctx).run(args, { host: repo.host, cwd: ctx?.cwd, timeout: FORGEJO_SLOW_READ_TIMEOUT_MS })
  if (result.code !== 0) {
    return { ok: false, error: fail(ERROR_KIND.NETWORK as ErrorKind, '数票没有成功', result.stderr || result.stdout).error }
  }
  const header = parseSearchPage(result.stdout)
  if (!header) {
    return { ok: false, error: fail(ERROR_KIND.PARSE as ErrorKind, '看不懂搜索结果的计数（头部格式变了？）', result.stdout).error }
  }
  return { ok: true, total: header.total }
}

/**
 * 数票：开、关各问一次，总数是两者相加。
 *
 * 多标签同时存在时先枚举再取交集（服务端的逗号语义不保证是「全部满足」）；
 * 单标签与无标签直接读头部，一次进程。
 */
export async function counts(
  repo: RepositoryRef | null | undefined,
  filter: ListFilter | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<CountsResult> {
  const startedAt = Date.now()
  const target = await targetOf(repo, ctx, 'counts')
  if (!target.ok) return target as CountsResult
  const labels = Array.isArray(filter?.labels) ? filter.labels.filter((name) => typeof name === 'string' && name !== '') : []
  if (filter?.type === 'map' && labels.indexOf('wayfinder:map') < 0) labels.push('wayfinder:map')
  if (labels.length > 1) {
    const collected = await collect(ctx, target.repo, undefined, labels)
    if (!collected.ok) return collected as CountsResult
    let open = 0
    let closed = 0
    for (const row of collected.rows) {
      if (collected.stateOf.get(row.key) === STATE.CLOSED) closed += 1
      else open += 1
    }
    return {
      ok: true,
      data: { open, closed, total: open + closed },
      provenance: provenanceOf('counts', { counts: 'complete' }, startedAt),
    } as CountsResult
  }
  const open = await countState(ctx, target.repo, 'open', labels)
  if (!open.ok) {
    emitReadDegraded(ctx as OpContext, 'counts', 'counts:stat', Date.now() - startedAt)
    return open as CountsResult
  }
  const closed = await countState(ctx, target.repo, 'closed', labels)
  if (!closed.ok) {
    emitReadDegraded(ctx as OpContext, 'counts', 'counts:stat', Date.now() - startedAt)
    return closed as CountsResult
  }
  return {
    ok: true,
    data: { open: open.total, closed: closed.total, total: open.total + closed.total },
    provenance: provenanceOf('counts', { counts: 'complete' }, startedAt),
  } as CountsResult
}

/** 游标里的一次位置：第几页的第几行（行号从 0 开始）。 */
interface Position { page: number; index: number }

/** 解析后的翻页状态：开、关两份位置，加上第一次算出的总数（0 表示还没算）。 */
interface CursorState {
  open: Position
  closed: Position
  total: number
}

const FIRST: CursorState = {
  open: { page: 1, index: 0 },
  closed: { page: 1, index: 0 },
  total: 0,
}

/**
 * 解析游标。
 *
 * 形状是 `f:<openPage>:<openIndex>:<closedPage>:<closedIndex>:<total>`；空串是第一页。
 * 认不出按失效处理（调用方丢游标重取第一页），不猜一个位置。
 */
export function parseCursor(cursor: unknown): CursorState | null {
  const text = String(cursor === null || cursor === undefined ? '' : cursor).trim()
  if (!text) return { open: { page: 1, index: 0 }, closed: { page: 1, index: 0 }, total: 0 }
  const match = /^f:(\d+):(\d+):(\d+):(\d+):(\d+)$/.exec(text)
  if (!match) return null
  const numbers = [match[1], match[2], match[3], match[4], match[5]].map(Number)
  if (numbers.some((n) => !isFinite(n) || n < 0)) return null
  return {
    open: { page: Math.max(1, numbers[0] as number), index: numbers[1] as number },
    closed: { page: Math.max(1, numbers[2] as number), index: numbers[3] as number },
    total: numbers[4] as number,
  }
}

/** 位置编码成游标。 */
export function encodeCursor(state: CursorState): string {
  return 'f:' + state.open.page + ':' + state.open.index + ':' + state.closed.page + ':' + state.closed.index + ':' + state.total
}

/** 从某一档状态的当前位置开始取 `need` 行。 */
async function takeFrom(
  ctx: CtxLike | null | undefined,
  repo: { host: string; refId: string },
  state: 'open' | 'closed',
  labels: string[],
  position: Position,
  need: number,
): Promise<{ ok: true; rows: SearchRow[]; next: Position; exhausted: boolean } | { ok: false; error: TrackerError }> {
  const rows: SearchRow[] = []
  let page = position.page
  let index = position.index
  while (rows.length < need) {
    const outcome = await searchPage(ctx, repo, { state, labels, page })
    if (!outcome.ok) return { ok: false, error: outcome.error }
    const pageRows = outcome.data.rows
    const pages = outcome.data.page ? outcome.data.page.pages : (pageRows.length > 0 ? page : 0)
    for (; index < pageRows.length && rows.length < need; index += 1) rows.push(pageRows[index] as SearchRow)
    if (rows.length >= need) return { ok: true, rows, next: { page, index }, exhausted: false }
    if (index >= pageRows.length) {
      if (page >= pages) return { ok: true, rows, next: { page: 1, index: 0 }, exhausted: true }
      page += 1
      index = 0
    }
  }
  return { ok: true, rows, next: { page, index }, exhausted: false }
}

/**
 * 按页取票。
 *
 * 给了状态就只翻那一份；没给状态就先读完开着的那份，再读关着的那份（理由见文件头）。
 * 每一行的状态来自它所在的那份结果，不猜。总数在第一次调用时算好写进游标，后面几页不再问。
 */
export async function listPage(
  repo: RepositoryRef | null | undefined,
  filter: ListFilter | null | undefined,
  opts: PageOpts | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<ReadPageResult> {
  const startedAt = Date.now()
  const target = await targetOf(repo, ctx, 'listPage')
  if (!target.ok) return target as ReadPageResult
  const cursor = parseCursor(opts?.cursor)
  if (!cursor) {
    emitReadDegraded(ctx as OpContext, 'listPage', 'listPage:cursor', Date.now() - startedAt)
    return fail(ERROR_KIND.PARSE as ErrorKind, 'listPage: 游标无效，请丢掉游标从第一页重取', String(opts?.cursor)) as ReadPageResult
  }
  const limitRaw = typeof opts?.limit === 'number' && isFinite(opts.limit) ? Math.floor(opts.limit) : DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(MAX_LIMIT, limitRaw))
  const state = filter && (filter.state === STATE.OPEN || filter.state === STATE.CLOSED) ? filter.state : undefined
  const labels = Array.isArray(filter?.labels) ? filter.labels.filter((name) => typeof name === 'string' && name !== '') : []
  if (filter?.type === 'map' && labels.indexOf('wayfinder:map') < 0) labels.push('wayfinder:map')
  const rows: SearchRow[] = []
  const stateOf = new Map<string, State>()
  let next: CursorState = cursor
  let total = cursor.total
  if (total <= 0) {
    if (state) {
      const counted = await countState(ctx, target.repo, state, labels)
      if (!counted.ok) {
        emitReadDegraded(ctx as OpContext, 'listPage', 'listPage:total', Date.now() - startedAt)
        return counted as ReadPageResult
      }
      total = counted.total
    } else {
      const openCount = await countState(ctx, target.repo, 'open', labels)
      const closedCount = await countState(ctx, target.repo, 'closed', labels)
      if (!openCount.ok || !closedCount.ok) {
        emitReadDegraded(ctx as OpContext, 'listPage', 'listPage:total', Date.now() - startedAt)
        return (openCount.ok ? closedCount : openCount) as ReadPageResult
      }
      total = openCount.total + closedCount.total
    }
    next = { open: cursor.open, closed: cursor.closed, total }
  }

  if (state) {
    const outcome = await takeFrom(ctx, target.repo, state, labels, next[state], limit)
    if (!outcome.ok) {
      emitReadDegraded(ctx as OpContext, 'listPage', 'listPage:transport', Date.now() - startedAt)
      return outcome as ReadPageResult
    }
    for (const row of outcome.rows) { rows.push(row); stateOf.set(row.key, state) }
    next = Object.assign({}, next, { [state]: outcome.next })
  } else {
    const open = await takeFrom(ctx, target.repo, 'open', labels, next.open, limit)
    if (!open.ok) {
      emitReadDegraded(ctx as OpContext, 'listPage', 'listPage:transport', Date.now() - startedAt)
      return open as ReadPageResult
    }
    for (const row of open.rows) { rows.push(row); stateOf.set(row.key, STATE.OPEN as State) }
    next = Object.assign({}, next, { open: open.next })
    if (rows.length < limit) {
      const closed = await takeFrom(ctx, target.repo, 'closed', labels, next.closed, limit - rows.length)
      if (!closed.ok) {
        emitReadDegraded(ctx as OpContext, 'listPage', 'listPage:transport', Date.now() - startedAt)
        return closed as ReadPageResult
      }
      for (const row of closed.rows) { rows.push(row); stateOf.set(row.key, STATE.CLOSED as State) }
      next = Object.assign({}, next, { closed: closed.next })
    }
  }

  const hasMore = rows.length >= limit
  const membership = await labelMembership(ctx, target.repo)
  const colors = membership ? await labelColors(ctx, target.repo) : new Map<string, string>()
  const items: Issue[] = rows.map((row) => issueFromRow(row, {
    repo: target.ref,
    state: stateOf.get(row.key) || (STATE.OPEN as State),
    labels: membership ? (membership.get(row.key) || []) : undefined,
    colors,
  }))
  return {
    ok: true,
    data: {
      items,
      nextCursor: hasMore ? encodeCursor(next) : null,
      total,
    },
    provenance: provenanceOf('listPage', {
      row: 'truncated',
      labels: membership ? 'complete' : 'unexpressed',
    }, startedAt),
  } as ReadPageResult
}

/**
 * 全部地图薄行。
 *
 * 服务端按 `wayfinder:map` 标签筛，内存里再按标签复核一次（标签大小写在远端可能不敏感）。
 * 状态分两份读，行按「开着的一批、关着的一批」拼起来；没有时间戳可用于排序，见文件头。
 */
export async function listMaps(
  repo: RepositoryRef | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<MapListOpResult> {
  const startedAt = Date.now()
  const target = await targetOf(repo, ctx, 'maps')
  if (!target.ok) return target as MapListOpResult
  const outcome = await collect(ctx, target.repo, undefined, ['wayfinder:map'])
  if (!outcome.ok) {
    emitReadDegraded(ctx as OpContext, 'maps', 'maps:transport', Date.now() - startedAt)
    return outcome as MapListOpResult
  }
  const rows: MapRow[] = []
  for (const row of outcome.rows) {
    rows.push({
      key: row.key,
      title: row.title,
      state: outcome.stateOf.get(row.key) === STATE.CLOSED ? (STATE.CLOSED as string) : (STATE.OPEN as string),
      url: issueAddressOf(target.ref, row.key),
    })
  }
  return {
    ok: true,
    data: { rows, total: rows.length, truncated: outcome.truncated },
    provenance: provenanceOf('listMaps', { row: 'truncated', labels: 'complete' }, startedAt),
  } as MapListOpResult
}

export default counts
