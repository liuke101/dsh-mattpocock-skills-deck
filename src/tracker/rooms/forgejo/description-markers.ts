/**
 * src/tracker/rooms/forgejo/description-markers.ts —— 票面正文文件头里的归属与阻塞标记。
 *
 * Forgejo 平台本身没有「父票」这个概念（fj 也没有任何建父子边的命令），所以归属只能像
 * GitLab 房那样落在票正文文件头的隐藏标记 `<!-- DSH-PARENT: <地图号> -->` 里：
 * 渲染后看不见，读回来还是原文，正文中间手写的同一句话不算（只认第一个标题之前那一段）。
 * 阻塞边有原生接口（`fj issue depend`），这一份里的阻塞回退写法只在原生读不到时兜底；
 * 写侧成对维护「人读的可见行 + 程序读的隐藏表」，读侧隐藏优先。
 *
 * 口径与共享包 `marker.ts` 的 `markerKindInHeader` 同一处：标记是文件元数据，写在标题之前；
 * 两处任一处改口径，另一处必须跟着改。
 */
const HIDDEN_PARENT_RE = /^<!--\s*DSH-PARENT\s*:\s*(\d+)\s*-->$/
const LEGACY_PART_OF_RE = /^Part of #(\d+)\s*$/
const ANCHOR_LINE_RE = /^\s*<!--\s*DSH-IDEMPOTENCY-KEY\s*:/

/** 取正文的「文件头」：第一个 `#` 标题之前那一段；没有标题时只看前十行。 */
function headerOf(body: string): string {
  const h = /^#+\s+/m.exec(body)
  if (h && typeof h.index === 'number') return body.slice(0, h.index)
  return body.split('\n').slice(0, 10).join('\n')
}

/** 文件头里有没有隐藏归属标记；有返回地图号，没有返回 null（正文里的不算）。 */
export function parseHiddenParent(body: unknown): string | null {
  if (typeof body !== 'string' || !body) return null
  for (const line of headerOf(body).split('\n')) {
    const m = HIDDEN_PARENT_RE.exec(line.trim())
    if (m) return m[1] as string
  }
  return null
}

/** 过渡期回退认：文件头里的旧 `Part of #<号>` 行。新写的票不再有这一行。 */
export function parseLegacyPartOf(body: unknown): string | null {
  if (typeof body !== 'string' || !body) return null
  for (const line of headerOf(body).split('\n')) {
    const m = LEGACY_PART_OF_RE.exec(line.trim())
    if (m) return m[1] as string
  }
  return null
}

/** 建出隐藏归属标记那一行。 */
function buildHiddenParentLine(mapKey: string): string {
  return `<!-- DSH-PARENT: ${mapKey} -->`
}

/**
 * 把隐藏归属标记写进文件头；传 null 表示拆掉标记，其余正文一个字不动。
 *
 * 位置在幂等锚之后：锚回查只认行首，不受影响。散在正文中间的旧行一并清掉，免得下次读回来认错。
 */
export function rewriteDescriptionWithHiddenParent(oldBody: string | null | undefined, mapKey: string | null): string {
  const kept: string[] = []
  for (const line of String(oldBody || '').split('\n')) {
    const trimmed = line.trim()
    if (HIDDEN_PARENT_RE.test(trimmed)) continue
    if (LEGACY_PART_OF_RE.test(trimmed)) continue
    kept.push(line)
  }
  while (kept.length > 0 && kept[0].trim() === '') kept.shift()
  if (mapKey === null) return kept.join('\n')
  let at = 0
  while (at < kept.length && ANCHOR_LINE_RE.test(kept[at])) at += 1
  kept.splice(at, 0, buildHiddenParentLine(String(mapKey)))
  return kept.join('\n')
}

const HIDDEN_BLOCKED_RE = /^<!--\s*DSH-BLOCKED-BY\s*:\s*(.*?)\s*-->$/
const VISIBLE_BLOCKED_ANY_RE = /^Blocked by:\s*.+$/m

/** 文件头里的阻塞机器表；没有这一行返回 null（区别于「有行但是空的」），空行返回 []。 */
export function parseHiddenBlockedBy(body: unknown): string[] | null {
  if (typeof body !== 'string' || !body) return null
  for (const rawLine of headerOf(body).split('\n')) {
    const m = HIDDEN_BLOCKED_RE.exec(rawLine.trim())
    if (!m) continue
    const inner = (m[1] as string).trim()
    if (!inner) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const part of inner.split(/[\s,]+/)) {
      const key = part.replace(/^#/, '').trim()
      if (!/^\d+$/.test(key) || seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
    return out
  }
  return null
}

/** 建出阻塞机器表那一行（空集时值留空）。 */
function buildHiddenBlockedLine(keys: string[]): string {
  return `<!-- DSH-BLOCKED-BY:${keys.length > 0 ? ' ' + keys.join(', ') : ''} -->`
}

/**
 * 阻塞成对写：可见 `Blocked by:` 行（人读）与隐藏机器表（程序读）一次写齐。
 * 空集表示两处都拆掉；已有可见行就在它后面紧跟机器表。
 */
export function rewriteDescriptionWithBlockedPair(oldBody: string | null | undefined, keys: string[]): string {
  const wanted: string[] = [...new Set((Array.isArray(keys) ? keys : []).map(String).filter(Boolean))]
  const body = String(oldBody || '')
  const cleared = body.split('\n').filter((line) => !HIDDEN_BLOCKED_RE.test(line.trim())).join('\n')
  if (wanted.length === 0) {
    if (!VISIBLE_BLOCKED_ANY_RE.test(cleared)) return cleared
    return cleared.replace(VISIBLE_BLOCKED_ANY_RE, '').replace(/^\n+/, '')
  }
  const visible = `Blocked by: ${wanted.map((key) => '#' + key).join(', ')}`
  const hidden = buildHiddenBlockedLine(wanted)
  if (VISIBLE_BLOCKED_ANY_RE.test(cleared)) return cleared.replace(VISIBLE_BLOCKED_ANY_RE, visible + '\n' + hidden)
  const lines = cleared.split('\n')
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  let at = 0
  while (at < lines.length && (ANCHOR_LINE_RE.test(lines[at]) || HIDDEN_PARENT_RE.test(lines[at].trim()))) at += 1
  lines.splice(at, 0, visible, hidden)
  return lines.join('\n')
}

export default parseHiddenParent
