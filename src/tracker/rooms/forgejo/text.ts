/**
 * src/tracker/rooms/forgejo/text.ts —— 把 `fj` 的人类可读输出读成结构化数据（纯函数）
 *
 * 为什么这一层必须单独存在：`fj` 0.7.0 没有 `--json`（只有 `--style fancy|minimal`，管的是
 * 颜色与字符，不是数据形状），所以这一间房的每一条读路径都只能读文本。文本格式散落在十几条
 * 命令里，如果解析散在操作实现里，改一处格式就得满屋找；收在这里之后，格式变化只改这一个文件，
 * 操作层只认这里给出的结构。
 *
 * 三条约定：
 *  1. 这里只做文本到结构的翻译，不判断业务、不发日志、不抛异常。认不出来就回 null 或空数组，
 *     由调用方按「这一趟没读到」处理（与契约的「未知不是空」一致）。
 *  2. 解析只认实测过的英文模板（夹具在 tests/fixtures/forgejo/）。`fj` 的界面文案是本地化的，
 *     但这台机器与插件派生的子进程都落在英文上；换到德语等界面后这里会认不出来，调用方会如实
 *     报读不到，而不是猜一个错值。要支持别的界面语言，先给这一类输出加夹具再改这里。
 *  3. 正文与评论的每一行都带 `> ` 前缀（单独的 `>` 表示原始空行）。这里负责剥掉一层，
 *     原始正文里本来以 `> ` 开头的引用行会变成 `> > `，剥一层正好还原。
 */

/** 搜索结果里的一行。`author` 是 `fj` 打印的登录名原文。 */
export interface SearchRow {
  key: string
  title: string
  author: string
}

/** 搜索结果的分页头。`pages` 为 0 表示这个仓库一张票都没有。 */
export interface SearchPage {
  page: number
  pages: number
  total: number
}

/** 单票视图解析出来的字段。时间与指派人不在这个输出里，调用方另外补。 */
export interface IssueView {
  key: string
  title: string
  state: 'open' | 'closed'
  author: string
  labels: string[]
  body: string
  commentCount: number
}

/** 一条评论。`fj` 只给显示名与登录名，不给评论 id 与时间。 */
export interface CommentView {
  login: string
  name: string
  body: string
}

/** 一个指派人。 */
export interface AssigneeView {
  login: string
  name: string
}

/** 一个仓库标签。`color` 是不带井号的六位小写十六进制，取不到时是空串。 */
export interface LabelView {
  id: string
  name: string
  color: string
  description: string
}

/** 依赖或阻塞清单里的一行。 */
export interface DependencyView {
  key: string
  title: string
  state: 'open' | 'closed' | ''
}

/** `fj whoami` 的输出。 */
export interface WhoAmIView {
  login: string
  host: string
}

/** `fj repo view` 的输出里这一间房用得上的三格。 */
export interface RepoView {
  refId: string
  description: string
  url: string
}

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g

/** 去掉终端颜色与样式码，保留可见文字。 */
export function stripAnsi(text: string): string {
  return String(text === null || text === undefined ? '' : text).replace(ANSI_PATTERN, '')
}

/**
 * 从一行标签输出里取背景色。
 *
 * `fj` 把标签颜色画成终端背景色（`48;2;R;G;B`），这是它唯一暴露颜色的地方。
 * 取不到就回空串，调用方按「没有颜色」处理；不要按标签名猜一个色。
 */
function backgroundHexOf(rawLine: string): string {
  const match = /\x1b\[48;2;(\d+);(\d+);(\d+)m/.exec(rawLine)
  if (!match) return ''
  const hex = (value: string): string => {
    const n = Number(value)
    if (!isFinite(n) || n < 0 || n > 255) return ''
    return ('0' + Math.round(n).toString(16)).slice(-2)
  }
  const parts = [hex(match[1]), hex(match[2]), hex(match[3])]
  return parts.every((part) => part.length === 2) ? parts.join('') : ''
}

/** 把远程地址或 `fj` 输出的主机名归一成小写的主机名（去掉协议、用户信息与尾部斜杠）。 */
export function normalizeHost(value: unknown): string {
  let host = String(value === null || value === undefined ? '' : value).trim().toLowerCase()
  if (!host) return ''
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  host = host.replace(/^[^@/]*@/, '')
  host = host.replace(/\/.*$/, '')
  host = host.replace(/:\d+$/, '')
  return host
}

/** 把一段文本按行切开，兼容 CRLF 与 LF。 */
function linesOf(text: string): string[] {
  return String(text === null || text === undefined ? '' : text).split(/\r?\n/)
}

/** 一行是不是正文/评论的内容行（`fj` 用 `>` 或 `> ` 表示这一行属于正文，单独的 `>` 是空行）。 */
function isQuotedLine(line: string): boolean {
  return line === '>' || line.startsWith('> ')
}

/** 剥掉正文/评论的一层引用前缀。 */
function unquote(line: string): string {
  if (line === '>') return ''
  if (line.startsWith('> ')) return line.slice(2)
  return line
}

/** 解析 `fj issue search` 的头部；认不出来回 null。 */
export function parseSearchPage(text: string): SearchPage | null {
  for (const raw of linesOf(text)) {
    const line = stripAnsi(raw).trim()
    const paged = /^Page (\d+) out of (\d+) pages? in total \((\d+) issues?\)$/.exec(line)
    if (paged) {
      return { page: Number(paged[1]), pages: Number(paged[2]), total: Number(paged[3]) }
    }
    const all = /^(\d+) issues?$/.exec(line)
    if (all) {
      return { page: 1, pages: 1, total: Number(all[1]) }
    }
  }
  return null
}

/** 解析 `fj issue search` 的行。头部与认不出的行都跳过。 */
export function parseSearchRows(text: string): SearchRow[] {
  const rows: SearchRow[] = []
  for (const raw of linesOf(text)) {
    const line = stripAnsi(raw).trim()
    const row = /^#(\d+): (.*) \(by ([^)]+)\)$/.exec(line)
    if (!row) continue
    rows.push({ key: String(Number(row[1])), title: row[2], author: row[3].trim() })
  }
  return rows
}

/**
 * 解析 `fj issue view <id>`。
 *
 * 输出形状（实测）：
 *
 *     <标题> #<编号>"
 *     By <作者> — <Open|Closed>
 *     <标签，一行一个；没有标签就紧接空行>
 *
 *     > <正文第一行>
 *     >
 *     > <正文第二行>
 *
 *
 *     <评论条数> comments
 *
 * 标题行末尾那个引号是 `fj` 模板自带的，不属于标题，这里剥掉。认不出标题或状态行就回 null。
 */
export function parseIssueView(text: string): IssueView | null {
  const lines = linesOf(text)
  if (lines.length < 2) return null
  const header = stripAnsi(lines[0]).trimEnd()
  const head = /^(.*) #(\d+)"?$/.exec(header)
  const stateLine = stripAnsi(lines[1]).trim()
  const stateMatch = /^By (.+?) — (Open|Closed)$/.exec(stateLine)
  if (!head || !stateMatch) return null

  const labels: string[] = []
  let cursor = 2
  for (; cursor < lines.length; cursor += 1) {
    const line = stripAnsi(lines[cursor]).trim()
    if (line === '') break
    if (isQuotedLine(lines[cursor])) break
    labels.push(line)
  }

  const bodyLines: string[] = []
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (line.trim() === '') continue
    if (!isQuotedLine(line)) break
    bodyLines.push(unquote(line))
  }

  let commentCount = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /^(\d+) comments?$/.exec(stripAnsi(lines[i]).trim())
    if (match) {
      commentCount = Number(match[1])
      break
    }
  }

  return {
    key: String(Number(head[2])),
    title: head[1].trim(),
    state: stateMatch[2] === 'Closed' ? 'closed' : 'open',
    author: stateMatch[1].trim(),
    labels,
    body: bodyLines.join('\n'),
    commentCount,
  }
}

/**
 * 解析 `fj issue view <id> comments`。
 *
 * 每条评论以 `<显示名> (<登录名>) said:` 开头，正文带一层 `> ` 前缀，评论之间隔两个空行。
 * 没有评论时命令不输出任何东西，这里回空数组。
 */
export function parseComments(text: string): CommentView[] {
  const lines = linesOf(text)
  const out: CommentView[] = []
  let current: CommentView | null = null
  let body: string[] = []
  const flush = (): void => {
    if (!current) return
    current.body = trimTrailingBlankLines(body).join('\n')
    out.push(current)
    current = null
    body = []
  }
  for (const raw of lines) {
    const line = stripAnsi(raw)
    const head = /^(.*) \(([^()]*)\) said:$/.exec(line.trim())
    if (head) {
      flush()
      current = { name: head[1].trim(), login: head[2].trim(), body: '' }
      continue
    }
    if (!current) continue
    if (isQuotedLine(line)) {
      body.push(unquote(line))
      continue
    }
    if (line.trim() === '') continue
    flush()
  }
  flush()
  return out
}

/** 去掉数组末尾的空行；正文自身的空行保留。 */
function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length
  while (end > 0 && lines[end - 1] === '') end -= 1
  return lines.slice(0, end)
}

/**
 * 解析 `fj issue view <id> assignees`。
 *
 * 有指派人时输出 `Assigned to (N users):` 再逐行 `• <显示名> (<登录名>)`；没有时输出
 * `No one is assigned.`。两种情况都回数组，空数组表示明确没有指派人。
 */
export function parseAssignees(text: string): AssigneeView[] {
  const out: AssigneeView[] = []
  for (const raw of linesOf(text)) {
    const match = /^\s*• (.*) \(([^()]+)\)\s*$/.exec(stripAnsi(raw))
    if (!match) continue
    out.push({ name: match[1].trim(), login: match[2].trim() })
  }
  return out
}

/**
 * 解析 `fj repo labels view`。
 *
 * 输出是一块一块的，每块两行：
 *
 *     <背景色码> <标签名>  <标签 id>
 *       <说明，或者 (no description)>
 *
 * 颜色只以终端背景色的形式出现，所以这里从原始行里抠 RGB；标签名可能带冒号与空格，
 * 因此用行尾的 id 作锚点，而不是按空格切。
 */
export function parseLabels(text: string): LabelView[] {
  const out: LabelView[] = []
  const rawLines = linesOf(text)
  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i]
    const visible = stripAnsi(raw)
    const first = /^\s*(.*?)\s{2,}(\d+)\s*$/.exec(visible)
    if (!first) continue
    const name = first[1].trim()
    if (!name) continue
    const next = i + 1 < rawLines.length ? stripAnsi(rawLines[i + 1]).trim() : ''
    const description = next === '(no description)' ? '' : next
    out.push({ id: first[2], name, color: backgroundHexOf(raw), description })
    i += 1
  }
  return out
}

/**
 * 解析 `fj issue depend list <id>` 与 `fj issue block list <id>`。
 *
 * 头部一行写清楚这是谁的依赖，下面每行是 `  #<编号> <标题> (<open|closed>)`。
 * 没有关系时输出 `No dependencies.` 或 `No blockers.`，这里回空数组。
 */
export function parseDependencyRows(text: string): DependencyView[] {
  const out: DependencyView[] = []
  for (const raw of linesOf(text)) {
    const match = /^\s*#(\d+) (.*) \((open|closed)\)\s*$/.exec(stripAnsi(raw))
    if (!match) continue
    out.push({ key: String(Number(match[1])), title: match[2].trim(), state: match[3] as 'open' | 'closed' })
  }
  return out
}

/** 解析 `fj whoami`：`currently signed into <登录名>@<主机>`。 */
export function parseWhoAmI(text: string): WhoAmIView | null {
  const match = /^currently signed into (.+)@(.+)$/.exec(stripAnsi(text).trim())
  if (!match) return null
  return { login: match[1].trim(), host: match[2].trim() }
}

/** 解析 `fj auth list`：一行一个已登录主机。 */
export function parseAuthHosts(text: string): string[] {
  const out: string[] = []
  for (const raw of linesOf(text)) {
    const host = stripAnsi(raw).trim()
    if (!host) continue
    out.push(host)
  }
  return out
}

/** 解析 `fj repo view`：第一行是 `owner/name`，`> ` 行是简介，最后一行带网页地址。 */
export function parseRepoView(text: string): RepoView | null {
  const lines = linesOf(text)
  let refId = ''
  let description = ''
  let url = ''
  for (const raw of lines) {
    const line = stripAnsi(raw).trim()
    if (!line) continue
    if (!refId && /^[^/\s]+\/[^/\s]+$/.test(line)) {
      refId = line
      continue
    }
    if (!description && line.startsWith('> ')) {
      description = line.slice(2).trim()
      continue
    }
    const online = /^View online at (\S+)$/.exec(line)
    if (online) url = online[1]
  }
  return refId ? { refId, description, url } : null
}

/** 解析 `fj issue create` 的成功回执：`created issue #<编号>: <标题>`。 */
export function parseCreatedKey(text: string): string | null {
  const match = /created issue #(\d+):/.exec(stripAnsi(text))
  return match ? String(Number(match[1])) : null
}
