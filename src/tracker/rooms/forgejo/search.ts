/**
 * src/tracker/rooms/forgejo/search.ts —— 把 `fj issue search` 翻成「一页行」或「全部行」。
 *
 * `fj issue search` 是这一间房唯一的列表入口，原因是别的命令都只能一次读一张票。它的输出
 * 分页（实例默认每页 25 条），头部写明「第几页 / 共几页 / 共几条」，每一行只有
 * `#编号: 标题 (by 作者)`。这里把这套翻页读完，认不出的头部按失败处理，不猜一个总数。
 *
 * 一条必须写下来的事实：搜索结果**没有正文、标签、指派人、时间**。要这些东西只能再跑
 * `fj issue view`（一张票一个进程）。所以列表行天然是不完整的，调用方要按能力区的缺口读它，
 * 不许拿空字符串当成「确实为空」。
 */

import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { TrackerError } from '../../contract/results.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { ErrorKind } from '../../contract/identity.js'
import { fail } from '../../kernel/preflight.js'
import { fjClient } from './client.js'
import type { ForgejoRepo } from './repo.js'
import { classifyFjError } from './errors.js'
import { parseSearchPage, parseSearchRows } from './text.js'
import type { SearchPage, SearchRow } from './text.js'
import { emitReadDegraded } from './read-log.js'
import { FORGEJO_SLOW_READ_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'

type CtxLike = Partial<OpContext> & Partial<BackendContext>

/** 一次搜索请求的参数。 */
export interface SearchQuery {
  /** `open` / `closed` / `all`；省略按 `all`（列票要两种状态都看）。 */
  state?: 'open' | 'closed' | 'all'
  /** 必须同时带上的标签；空数组与省略相同，不往命令行上拼 `-l`。 */
  labels?: string[]
  /** 全文关键词（幂等锚回查与子票回查用它）。 */
  query?: string
  /** 页码，从 1 开始。 */
  page?: number
}

/** 一页搜索的结果。 */
export interface SearchPageOutcome {
  rows: SearchRow[]
  page: SearchPage | null
}

/** 搜索失败时带回来的原文，供调用方组装失败信封。 */
export interface SearchFailure {
  error: TrackerError
  raw: string
}

/** 一次「读一页」。失败不抛，回 `ok:false`；由调用方决定这一趟是整条失败还是降级。 */
export async function searchPage(
  ctx: CtxLike | null | undefined,
  repo: Pick<ForgejoRepo, 'host' | 'refId'>,
  query: SearchQuery,
): Promise<{ ok: true; data: SearchPageOutcome } | { ok: false } & SearchFailure> {
  const args: string[] = ['issue', 'search']
  if (query.query) args.push(query.query)
  args.push('-r', repo.refId)
  args.push('-s', query.state || 'all')
  const labels = Array.isArray(query.labels) ? query.labels.filter((name) => typeof name === 'string' && name !== '') : []
  if (labels.length > 0) args.push('-l', labels.join(','))
  if (query.page && query.page > 1) args.push('-p', String(query.page))
  const result = await fjClient(ctx).run(args, { host: repo.host, cwd: ctx?.cwd, timeout: FORGEJO_SLOW_READ_TIMEOUT_MS })
  const raw = result.stderr || result.stdout
  if (result.code !== 0) {
    const verdict = classifyFjError(result, ctx || undefined)
    emitReadDegraded(ctx, 'list', 'list:transport', 0)
    return { ok: false, error: fail(verdict.kind, '读不到这个仓库的票列表', raw).error, raw }
  }
  const header = parseSearchPage(result.stdout)
  const rows = parseSearchRows(result.stdout)
  // 「0 条」也有头部；没有头部只在空输出时算合法的空结果，其余一律按「认不出来」处理。
  if (!header && result.stdout.trim() !== '') {
    emitReadDegraded(ctx, 'list', 'list:text', 0)
    return { ok: false, error: fail(ERROR_KIND.PARSE as ErrorKind, '看不懂 fj 的搜索结果（头部格式变了？）', result.stdout).error, raw: result.stdout }
  }
  return { ok: true, data: { rows, page: header } }
}

/** 读完所有页的结果。`truncated` 表示到了调用方给的页数上限还没读完。 */
export interface SearchAllOutcome {
  rows: SearchRow[]
  total: number
  truncated: boolean
}

/**
 * 把所有页读完。
 *
 * @param maxPages 最多读几页；到了上限还没读完就回 `truncated: true`，调用方据此不许当成整仓
 * @param first 已经读到的第一页（列表经常先读一页再决定要不要全读，避免重复起进程）
 */
export async function searchAll(
  ctx: CtxLike | null | undefined,
  repo: Pick<ForgejoRepo, 'host' | 'refId'>,
  query: SearchQuery,
  maxPages: number,
  first?: SearchPageOutcome | null,
): Promise<{ ok: true; data: SearchAllOutcome } | { ok: false } & SearchFailure> {
  const rows: SearchRow[] = []
  let total = 0
  let page = first || null
  let number = 1
  let finished = false
  while (true) {
    if (!page) {
      const outcome = await searchPage(ctx, repo, Object.assign({}, query, { page: number }))
      if (!outcome.ok) return outcome
      page = outcome.data
    }
    for (const row of page.rows) rows.push(row)
    if (page.page) total = page.page.total
    const pages = page.page ? page.page.pages : 1
    if (number >= pages) { finished = true; break }
    if (number >= maxPages) break
    number += 1
    page = null
  }
  return { ok: true, data: { rows, total, truncated: !finished } }
}

/** 去重（翻页期间票被改动时可能在同一编号上出现两次；保留第一次出现的行）。 */
export function uniqueRows(rows: SearchRow[]): SearchRow[] {
  const seen = new Set<string>()
  const out: SearchRow[] = []
  for (const row of rows) {
    if (seen.has(row.key)) continue
    seen.add(row.key)
    out.push(row)
  }
  return out
}

export default searchPage
