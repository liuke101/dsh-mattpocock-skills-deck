/**
 * src/tracker/rooms/forgejo/writes.ts —— 票面上的四种写：评论、标签、指派人、归属、阻塞。
 *
 * 每一条都先把「现在是什么」读回来再算差量，只发真正需要的命令。这不是为了省命令，
 * 是因为 `fj` 的编辑命令全是增量式（`--add` / `--rm` / `assign` / `unassign`），
 * 不先读就不知道要加什么、要去什么，覆盖式写根本表达不出来。
 *
 * 三个必须写在明处的边界：
 *  1. 去标签在 Forgejo 17.0.1 上会失败：`fj issue edit labels --rm` 打到 `DELETE /labels/{name}`
 *     时对端重置连接（实测 os error 104）。加标签正常，去标签不保证。这一条登记为 `partial`。
 *  2. 改阻塞关系同样是「加正常、删失败」；自环与成环在写之前就拦下，一条命令都不发。
 *  3. `SetOpts.expectedUpdatedAt` 在 Forgejo 上没有可比对的时间戳（fj 不打印更新时间），
 *     这一格无法履行，登记为 `partial` 并在文档里写明；不假装比对过。
 */

import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { Comment, Issue, RepositoryRef } from '../../contract/entities.js'
import type { OpResult, TrackerError } from '../../contract/results.js'
import type { AssigneeInput, LabelInput, SetOpts } from '../../contract/inputs.js'
import type { ErrorKind } from '../../contract/identity.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { fail } from '../../kernel/preflight.js'
import { fjClient, repoOpts } from './client.js'
import { parseAssignees, parseDependencyRows } from './text.js'
import { getIssue, targetOf, failureOf, viewIssue } from './issues.js'
import type { ForgejoRepo } from './repo.js'
import { rewriteDescriptionWithHiddenParent } from './description-markers.js'
import { currentLogin } from './identity-ops.js'
import {
  FORGEJO_CREATE_TIMEOUT_MS,
  FORGEJO_READ_TIMEOUT_MS,
  FORGEJO_SLOW_READ_TIMEOUT_MS,
} from '../../../shared/time-config/src/values.js'

type CtxLike = Partial<OpContext> & Partial<BackendContext>

/** 环检最多看多少个节点；超过按「查不清」拒绝写，不赌。 */
const CYCLE_MAX_NODES = 80

/** 把裸字符串或完整形状收成标签名。 */
function labelNamesOf(labels: LabelInput[] | null | undefined): string[] {
  const out: string[] = []
  for (const label of Array.isArray(labels) ? labels : []) {
    const name = typeof label === 'string' ? label : label && typeof label.name === 'string' ? label.name : ''
    const trimmed = String(name || '').trim()
    if (trimmed && out.indexOf(trimmed) < 0) out.push(trimmed)
  }
  return out
}

/** 把裸字符串或完整形状收成登录名。 */
function loginsOf(assignees: AssigneeInput[] | null | undefined): string[] {
  const out: string[] = []
  for (const person of Array.isArray(assignees) ? assignees : []) {
    const login = typeof person === 'string' ? person : person && typeof person.login === 'string' ? person.login : ''
    const trimmed = String(login || '').trim()
    if (trimmed && out.indexOf(trimmed) < 0) out.push(trimmed)
  }
  return out
}

/** 两边差集：`left` 里不在 `right` 里的那些。 */
function minus(left: string[], right: string[]): string[] {
  return left.filter((item) => right.indexOf(item) < 0)
}

/**
 * 发一条评论。
 *
 * `fj` 不回评论编号与时间，所以回执里这两格是省略与空串；作者用 `fj whoami` 补，
 * 问不到就留空串（不编一个人）。
 */
export async function addComment(
  repo: RepositoryRef | null | undefined,
  key: string,
  body: string,
  ctx: CtxLike | null | undefined,
): Promise<OpResult<Comment>> {
  const target = await targetOf(repo, ctx, 'comment')
  if (!target.ok) return target
  const id = String(key || '').trim()
  if (!id) return fail(ERROR_KIND.PARSE as ErrorKind, 'comment: 票号是空的', '')
  const text = typeof body === 'string' ? body : ''
  if (!text.trim()) return fail(ERROR_KIND.PARSE as ErrorKind, 'comment: 评论正文是空的', '')
  const result = await fjClient(ctx).run(['issue', 'comment', id, '--body', text], {
    ...repoOpts(target.repo),
    cwd: ctx?.cwd,
    timeout: FORGEJO_CREATE_TIMEOUT_MS,
  })
  if (result.code !== 0) return failureOf(result, ctx, '评论没有发出去')
  const login = await currentLogin(ctx, target.repo.host)
  const comment: Comment = {
    author: { login },
    authorAssociation: '',
    body: text,
    createdAt: '',
    updatedAt: '',
  }
  return { ok: true, data: comment }
}

/**
 * 覆盖式改标签：先读现有标签，再加缺的、再去多的。
 *
 * 去标签这一步在 Forgejo 上有已知故障（见文件头），失败时如实回错并带上原文；
 * 此时「加」可能已经生效，票面处于半改状态——调用方重试同一份输入会收敛（差量会消失），
 * 所以这是一次可重试的失败，不是不可恢复的中间态。
 */
export async function setLabels(
  repo: RepositoryRef | null | undefined,
  key: string,
  labels: LabelInput[],
  opts: SetOpts | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<OpResult<Issue>> {
  void opts
  const current = await viewIssue(repo, key, ctx)
  if (!current.ok) return current
  const wanted = labelNamesOf(labels)
  const have = current.parsed.labels.slice()
  const add = minus(wanted, have)
  const remove = minus(have, wanted)
  const client = fjClient(ctx)
  if (add.length > 0) {
    const args = ['issue', 'edit', current.parsed.key, 'labels']
    for (const name of add) args.push('--add', name)
    const result = await client.run(args, { ...repoOpts(current.target), cwd: ctx?.cwd, timeout: FORGEJO_SLOW_READ_TIMEOUT_MS })
    if (result.code !== 0) return failureOf(result, ctx, '加标签没有成功')
  }
  if (remove.length > 0) {
    const args = ['issue', 'edit', current.parsed.key, 'labels']
    for (const name of remove) args.push('--rm', name)
    const result = await client.run(args, { ...repoOpts(current.target), cwd: ctx?.cwd, timeout: FORGEJO_SLOW_READ_TIMEOUT_MS })
    if (result.code !== 0) return failureOf(result, ctx, '去标签没有成功（Forgejo 的删标签接口已知会重置连接）')
  }
  return getIssue(repo, current.parsed.key, {}, ctx) as Promise<OpResult<Issue>>
}

/** 覆盖式改指派人：读现有名单，加缺的、去多的（assign/unassign 两条命令都正常）。 */
export async function setAssignees(
  repo: RepositoryRef | null | undefined,
  key: string,
  assignees: AssigneeInput[],
  opts: SetOpts | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<OpResult<Issue>> {
  void opts
  const target = await targetOf(repo, ctx, 'setAssignees')
  if (!target.ok) return target
  const id = String(key || '').trim()
  if (!id) return fail(ERROR_KIND.PARSE as ErrorKind, 'setAssignees: 票号是空的', '')
  const client = fjClient(ctx)
  const listed = await client.run(['issue', 'view', id, 'assignees'], { ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_READ_TIMEOUT_MS })
  if (listed.code !== 0) return failureOf(listed, ctx, '读不到当前的指派人')
  const have = parseAssignees(listed.stdout).map((person) => person.login)
  const wanted = loginsOf(assignees)
  const add = minus(wanted, have)
  const remove = minus(have, wanted)
  if (add.length > 0) {
    const result = await client.run(['issue', 'assign', id].concat(add), { ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_SLOW_READ_TIMEOUT_MS })
    if (result.code !== 0) return failureOf(result, ctx, '加指派人没有成功')
  }
  if (remove.length > 0) {
    const result = await client.run(['issue', 'unassign', id].concat(remove), { ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_SLOW_READ_TIMEOUT_MS })
    if (result.code !== 0) return failureOf(result, ctx, '去指派人没有成功')
  }
  return getIssue(repo, id, {}, ctx) as Promise<OpResult<Issue>>
}

/**
 * 改父地图：写正文文件头的隐藏标记。
 *
 * Forgejo 没有原生父子边，`fj` 也没有建层级的命令，所以归属只能落在正文里。
 * 传 null 表示拆掉标记；其余正文一个字不动。
 */
export async function setParent(
  repo: RepositoryRef | null | undefined,
  key: string,
  parentKey: string | null,
  opts: SetOpts | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<OpResult<Issue>> {
  void opts
  const current = await viewIssue(repo, key, ctx)
  if (!current.ok) return current
  const body = rewriteDescriptionWithHiddenParent(current.parsed.body, parentKey === null ? null : String(parentKey))
  const result = await fjClient(ctx).run(['issue', 'edit', current.parsed.key, 'body', body], {
    ...repoOpts(current.target),
    cwd: ctx?.cwd,
    timeout: FORGEJO_SLOW_READ_TIMEOUT_MS,
  })
  if (result.code !== 0) return failureOf(result, ctx, '改归属没有成功')
  return getIssue(repo, current.parsed.key, {}, ctx) as Promise<OpResult<Issue>>
}

/**
 * 从 `from` 出发能不能走到 `target`（含 `from === target`）。环检用。
 *
 * 返回 `'yes'` / `'no'` / `'unknown'`：命令失败或图太大时回 `'unknown'`，
 * 调用方据此拒绝写——「查不清」不许当成「没有环」。
 */
async function reaches(
  ctx: CtxLike | null | undefined,
  repo: ForgejoRepo,
  from: string,
  target: string,
): Promise<'yes' | 'no' | 'unknown'> {
  const seen = new Set<string>()
  const queue: string[] = [from]
  while (queue.length > 0) {
    const key = queue.shift() as string
    if (key === target) return 'yes'
    if (seen.has(key)) continue
    if (seen.size >= CYCLE_MAX_NODES) return 'unknown'
    seen.add(key)
    const result = await fjClient(ctx).run(['issue', 'depend', 'list', key], {
      ...repoOpts(repo),
      cwd: ctx?.cwd,
      timeout: FORGEJO_READ_TIMEOUT_MS,
    })
    if (result.code !== 0) return 'unknown'
    for (const dep of parseDependencyRows(result.stdout)) {
      if (!seen.has(dep.key)) queue.push(dep.key)
    }
  }
  return 'no'
}

/**
 * 覆盖式改阻塞关系。
 *
 * 先用原生 `depend list` 读现状，再算差量；写之前做自环与成环检查：
 * 任何一个新阻塞者（直接或间接）已经依赖这张票，就回 `conflict`，一条命令都不发。
 * 去依赖在 Forgejo 上有已知故障（与去标签同源），失败时如实回错。
 */
export async function setBlockedBy(
  repo: RepositoryRef | null | undefined,
  key: string,
  blockers: string[],
  opts: SetOpts | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<OpResult<Issue>> {
  void opts
  const target = await targetOf(repo, ctx, 'setBlockedBy')
  if (!target.ok) return target
  const id = String(key || '').trim()
  if (!id) return fail(ERROR_KIND.PARSE as ErrorKind, 'setBlockedBy: 票号是空的', '')
  const wanted: string[] = []
  for (const raw of Array.isArray(blockers) ? blockers : []) {
    const blocker = String(raw || '').trim()
    if (blocker && wanted.indexOf(blocker) < 0) wanted.push(blocker)
  }
  if (wanted.indexOf(id) >= 0) {
    return fail(ERROR_KIND.CONFLICT as ErrorKind, 'setBlockedBy: 一张票不能阻塞自己', id)
  }
  for (const blocker of wanted) {
    const verdict = await reaches(ctx, target.repo, blocker, id)
    if (verdict === 'unknown') {
      return fail(ERROR_KIND.CONFLICT as ErrorKind, 'setBlockedBy: 无法确认这张阻塞边会不会成环，这次没有写', blocker)
    }
    if (verdict === 'yes') {
      return fail(ERROR_KIND.CONFLICT as ErrorKind, 'setBlockedBy: 这条阻塞边会成环，这次没有写', blocker)
    }
  }
  const client = fjClient(ctx)
  const listed = await client.run(['issue', 'depend', 'list', id], { ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_READ_TIMEOUT_MS })
  if (listed.code !== 0) return failureOf(listed, ctx, '读不到当前的依赖关系')
  const have = parseDependencyRows(listed.stdout).map((dep) => dep.key)
  const add = minus(wanted, have)
  const remove = minus(have, wanted)
  if (add.length > 0) {
    const result = await client.run(['issue', 'depend', 'add', id].concat(add), { ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_SLOW_READ_TIMEOUT_MS })
    if (result.code !== 0) return failureOf(result, ctx, '加依赖没有成功')
  }
  if (remove.length > 0) {
    const result = await client.run(['issue', 'depend', 'remove', id].concat(remove), { ...repoOpts(target.repo), cwd: ctx?.cwd, timeout: FORGEJO_SLOW_READ_TIMEOUT_MS })
    if (result.code !== 0) return failureOf(result, ctx, '去依赖没有成功（Forgejo 的删依赖接口已知会重置连接）')
  }
  return getIssue(repo, id, {}, ctx) as Promise<OpResult<Issue>>
}

export default { addComment, setLabels, setAssignees, setParent, setBlockedBy }
