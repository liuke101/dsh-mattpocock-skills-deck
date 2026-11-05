/**
 * src/tracker/rooms/forgejo/normalize.ts —— `fj` 读回来的行与票面 → 契约的 `Issue`。
 *
 * 这一层要把两种来源分开对待，因为它们知道的字段不一样：
 *
 *  - 列表行（`fj issue search`）：只有编号、标题、作者。标签由 `labels.ts` 另外补；
 *    正文、指派人、时间一概没有。没有的字段**不写**（省略 = 不知道），不拿空串冒充。
 *  - 单票（`fj issue view` 加可选的三条子命令）：标题、状态、作者、标签、正文、
 *    评论条数都在；指派人、评论正文、依赖、时间由调用方按需补。
 *
 * 票据种类按全仓统一判据：正文文件头里的规格标记最前，其次是 `wayfinder:map` 标签。
 * 列表行没有正文，所以列表里的规格票只能读成普通票——这是房登记里写明的缺口，
 * 详情页会读对，列表不会。
 */

import { ISSUE_TYPE, STATE } from '../../contract/vocabulary.js'
import type { Actor, IssueType, State } from '../../contract/identity.js'
import type { Comment, Issue, IssueRef, Label, RepositoryRef } from '../../contract/entities.js'
import { markerKindInHeader } from '../../../shared/issue-file/src/marker.js'
import { labelsWithColors } from './labels.js'
import { parseHiddenBlockedBy, parseHiddenParent, parseLegacyPartOf } from './description-markers.js'
import { issueAddressOf } from './repo.js'
import type { CommentView, DependencyView, IssueView, SearchRow } from './text.js'

/** 单票归一需要的补充件；不给就是「这一趟没取」。 */
export interface NormalizeDetailOpts {
  /** 仓库坐标：拼票的网页地址用。 */
  repo: RepositoryRef
  /** 选中的标签颜色（名字 → 六位十六进制）。 */
  colors?: Map<string, string>
  /** `fj issue view <id> assignees` 的结果。 */
  assignees?: { login: string; name: string }[]
  /** `fj issue view <id> comments` 的结果。 */
  comments?: CommentView[]
  /** `fj issue depend list <id>` 的结果（原生阻塞边，优先于正文回退）。 */
  dependencies?: DependencyView[]
}

/** 列表行归一的补充件。 */
export interface NormalizeRowOpts {
  repo: RepositoryRef
  /** 这一行的状态；`fj issue search` 不打印状态，由查询时选的 `-s` 决定。 */
  state: State
  /** 这一行的标签名（由 `labels.ts` 的成员表补）。 */
  labels?: string[]
  colors?: Map<string, string>
}

/** 把显示名与登录名收成契约的 `Actor`。没有显示名就不写 `name`。 */
function actorOf(login: unknown, name?: unknown): Actor {
  const out: Actor = { login: String(login || '') }
  const display = typeof name === 'string' ? name.trim() : ''
  if (display) out.name = display
  return out
}

/** 票的种类：规格标记 → 地图标签 → 普通票（与另外两间房同一顺序）。 */
function typeOf(body: string, labelNames: string[]): IssueType {
  if (markerKindInHeader(body) === 'spec') return ISSUE_TYPE.SPEC as IssueType
  if (labelNames.indexOf('wayfinder:map') >= 0) return ISSUE_TYPE.MAP as IssueType
  return ISSUE_TYPE.ISSUE as IssueType
}

/** 正文回退读阻塞（机器表优先，可见行兜底）；两种写法都没有回 null。 */
function blockedKeysFromBody(body: string): string[] | null {
  const table = parseHiddenBlockedBy(body)
  if (table !== null) return table
  const match = /^Blocked by:\s*(.+)$/m.exec(body)
  if (!match) return null
  const keys: string[] = []
  for (const part of (match[1] as string).split(',')) {
    const found = /#?(\d+)\s*$/.exec(part.trim())
    if (found && keys.indexOf(found[1] as string) < 0) keys.push(found[1] as string)
  }
  return keys
}

/** 把编号串收成 `IssueRef[]`；状态未知时省略（缺省不是 open）。 */
function refsOfKeys(keys: string[], deps?: DependencyView[]): IssueRef[] {
  const byKey = new Map<string, DependencyView>()
  for (const dep of Array.isArray(deps) ? deps : []) byKey.set(dep.key, dep)
  return keys.map((key) => {
    const dep = byKey.get(key)
    const ref: IssueRef = { key, title: dep ? dep.title : '#' + key, type: ISSUE_TYPE.ISSUE as IssueType }
    if (dep && (dep.state === 'open' || dep.state === 'closed')) ref.state = dep.state as State
    return ref
  })
}

/** 一页列表行 → 契约的票（薄行：只有这一趟真拿到的字段）。 */
export function issueFromRow(row: SearchRow, opts: NormalizeRowOpts): Issue {
  const labelNames = Array.isArray(opts.labels) ? opts.labels : []
  const issue: Issue = {
    key: row.key,
    effortId: '',
    type: typeOf('', labelNames),
    title: row.title,
    state: opts.state === STATE.CLOSED ? (STATE.CLOSED as State) : (STATE.OPEN as State),
    body: '',
    url: issueAddressOf(opts.repo, row.key),
    createdAt: '',
    updatedAt: '',
    closedAt: null,
    parentKey: null,
  }
  // 只有真的补到成员表时才写 labels：写 `[]` 等于声称「这张票确实没有标签」，
  // 而搜索结果本来就不带标签，那一拍没补到就只能是「不知道」。
  if (Array.isArray(opts.labels)) issue.labels = labelsWithColors(labelNames, opts.colors || new Map())
  if (row.author) issue.author = actorOf(row.author)
  return issue
}

/** 单票视图 → 契约的票。 */
export function issueFromView(view: IssueView, opts: NormalizeDetailOpts): Issue {
  const body = view.body || ''
  const labelNames = Array.isArray(view.labels) ? view.labels : []
  const parentKey = parseHiddenParent(body) || parseLegacyPartOf(body)
  const native = Array.isArray(opts.dependencies) ? opts.dependencies.map((dep) => dep.key) : null
  const blockedKeys = native !== null ? native : blockedKeysFromBody(body)
  const issue: Issue = {
    key: view.key,
    effortId: '',
    type: typeOf(body, labelNames),
    title: view.title,
    state: view.state === 'closed' ? (STATE.CLOSED as State) : (STATE.OPEN as State),
    body,
    url: issueAddressOf(opts.repo, view.key),
    createdAt: '',
    updatedAt: '',
    closedAt: null,
    parentKey,
    author: actorOf(view.author),
    labels: labelsWithColors(labelNames, opts.colors || new Map()),
  }
  if (Array.isArray(opts.assignees)) {
    issue.assignees = opts.assignees.map((person) => actorOf(person.login, person.name))
  }
  if (Array.isArray(opts.comments)) {
    issue.comments = opts.comments.map((comment): Comment => ({
      author: actorOf(comment.login, comment.name),
      authorAssociation: '',
      body: comment.body,
      createdAt: '',
      updatedAt: '',
    }))
  }
  if (blockedKeys !== null) issue.blockedBy = refsOfKeys(blockedKeys, opts.dependencies)
  // 评论条数是票面自带的；取到 0 也照写（明确没有评论与「没取到」不是一回事）。
  issue.commentCount = view.commentCount
  return issue
}

export default issueFromView
