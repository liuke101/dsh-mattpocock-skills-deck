/**
 * src/tracker/rooms/forgejo/graph.ts —— 依赖边与「挂在某张地图下的票」。
 *
 * 依赖边有原生命令（`fj issue depend list` / `block list`），读回来直接就是票号列表，
 * 不需要扫全仓。两侧各一条命令，都成功才算那一侧完整；反向边读不到时把
 * `blockingComplete` 写成 false 并给一句人话，不把「没看到」当成「没有」。
 *
 * 父子边没有原生命令：归属落在票正文文件头的隐藏标记 `<!-- DSH-PARENT: <地图号> -->`。
 * 找子票的办法是先按标记文本搜一遍（`fj issue search DSH-PARENT`），再逐张读票面确认标记里的
 * 编号对得上——搜索是召回，逐张读才是判据，搜索命中不会直接当成子票。
 */

import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { Issue, IssueRef, RepositoryRef } from '../../contract/entities.js'
import type { DependenciesResult, SubIssueListResult } from '../../contract/results.js'
import type { DepsOpts } from '../../contract/inputs.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { ErrorKind, State } from '../../contract/identity.js'
import { fail } from '../../kernel/preflight.js'
import { fjClient, repoOpts } from './client.js'
import { parseDependencyRows, parseIssueView } from './text.js'
import type { DependencyView } from './text.js'
import { targetOf, failureOf } from './issues.js'
import { parseHiddenParent, parseLegacyPartOf } from './description-markers.js'
import { issueFromView } from './normalize.js'
import { labelColors } from './labels.js'
import { searchAll } from './search.js'
import { provenanceOf } from './provenance.js'
import { emitReadDegraded } from './read-log.js'
import { FORGEJO_READ_TIMEOUT_MS, FORGEJO_SLOW_READ_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'
import { PAGINATION } from '../../contract/pagination.js'

type CtxLike = Partial<OpContext> & Partial<BackendContext>

/** 子票回查最多翻几页、最多逐张读几张；到顶就记截断。 */
const SUB_MAX_PAGES = PAGINATION.forgejo.subIssuesMaxPages
const SUB_MAX_CANDIDATES = PAGINATION.forgejo.subIssuesMaxCandidates

/** 依赖行 → 契约的 `IssueRef`。状态只写明确读到的那个，读不到就省略。 */
function refOf(dep: DependencyView): IssueRef {
  const ref: IssueRef = { key: dep.key, title: dep.title }
  if (dep.state === 'open' || dep.state === 'closed') ref.state = dep.state as State
  return ref
}

/**
 * 依赖边：谁阻塞我（原生 depend list）与我阻塞了谁（原生 block list）。
 *
 * 两侧都不翻页：`fj` 一次给出完整清单。任何一侧命令失败时该侧回空数组并把
 * `Complete` 写成 false，另一侧照常返回；整条操作只有在仓库本身认不出时才失败。
 */
export async function getDependencies(
  repo: RepositoryRef | null | undefined,
  key: string,
  opts: DepsOpts | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<DependenciesResult> {
  void opts
  const startedAt = Date.now()
  const target = await targetOf(repo, ctx, 'getDependencies')
  if (!target.ok) return target as DependenciesResult
  const id = String(key || '').trim()
  if (!id) return fail(ERROR_KIND.PARSE as ErrorKind, 'getDependencies: 票号是空的', '') as DependenciesResult
  const client = fjClient(ctx)
  const incoming = await client.run(['issue', 'depend', 'list', id], {
    ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_READ_TIMEOUT_MS,
  })
  const outgoing = await client.run(['issue', 'block', 'list', id], {
    ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_READ_TIMEOUT_MS,
  })
  const incomingOk = incoming.code === 0
  const outgoingOk = outgoing.code === 0
  if (!incomingOk) emitReadDegraded(ctx as OpContext, 'getDependencies', 'getDependencies:transport', Date.now() - startedAt)
  const data = {
    blockedBy: incomingOk ? parseDependencyRows(incoming.stdout).map(refOf) : [],
    blocking: outgoingOk ? parseDependencyRows(outgoing.stdout).map(refOf) : [],
    blockedByComplete: incomingOk,
    blockingComplete: outgoingOk,
    blockingSource: 'native' as const,
    ...(incomingOk && outgoingOk
      ? {}
      : { blockingNote: 'Forgejo 的依赖清单这一趟没读全；空的一侧表示「没看到」，不表示「没有」。' }),
  }
  return {
    ok: true,
    data,
    provenance: provenanceOf('getDependencies', {
      dependencies: incomingOk && outgoingOk ? 'complete' : 'truncated',
    }, startedAt),
  } as DependenciesResult
}

/**
 * 一张地图的全部子票。
 *
 * 搜索只负责召回，逐张读票面确认隐藏标记才是判据。读不到票面的候选计进 `dropped`，
 * 候选太多或搜索翻页到顶时记 `capped`，调用方据此说清「还有更多、这次没全取回」。
 */
export async function listSubIssues(
  repo: RepositoryRef | null | undefined,
  mapKey: string,
  opts: Record<string, never> | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<SubIssueListResult> {
  void opts
  const startedAt = Date.now()
  const target = await targetOf(repo, ctx, 'listSubIssues')
  if (!target.ok) return target as SubIssueListResult
  const wanted = String(mapKey || '').trim()
  if (!wanted) return fail(ERROR_KIND.PARSE as ErrorKind, 'listSubIssues: 地图号是空的', '') as SubIssueListResult
  const searched = await searchAll(ctx, target.repo, { state: 'all', query: 'DSH-PARENT' }, SUB_MAX_PAGES)
  if (!searched.ok) {
    emitReadDegraded(ctx as OpContext, 'listSubIssues', 'listSubIssues:transport', Date.now() - startedAt)
    return { ok: false, error: searched.error } as SubIssueListResult
  }
  const candidates = searched.data.rows.slice(0, SUB_MAX_CANDIDATES)
  const capped = searched.data.truncated || searched.data.rows.length > SUB_MAX_CANDIDATES
  const colors = await labelColors(ctx, target.repo)
  const items: Issue[] = []
  let dropped = 0
  for (const row of candidates) {
    const view = await fjClient(ctx).run(['issue', 'view', row.key], {
      ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_SLOW_READ_TIMEOUT_MS,
    })
    if (view.code !== 0) { dropped += 1; continue }
    const parsed = parseIssueView(view.stdout)
    if (!parsed) { dropped += 1; continue }
    const parent = parseHiddenParent(parsed.body) || parseLegacyPartOf(parsed.body)
    if (parent !== wanted) continue
    items.push(issueFromView(parsed, { repo: target.ref, colors }))
  }
  return {
    ok: true,
    data: {
      items,
      total: items.length,
      fetched: items.length,
      capped,
      missing: 0,
      dropped,
    },
    provenance: provenanceOf('listSubIssues', {
      subIssues: capped ? 'truncated' : 'complete',
      row: dropped > 0 ? 'truncated' : 'complete',
    }, startedAt),
  } as SubIssueListResult
}

export default getDependencies
