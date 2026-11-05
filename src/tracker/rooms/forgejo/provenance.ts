/**
 * src/tracker/rooms/forgejo/provenance.ts —— 这一间房的读结果「来源与完整度」组装。
 *
 * 契约里的 `ReadProvenance` 要求每条读操作交回：实际来源、按字段组完整度、缺失字段组、
 * 耗时与取数开始版本。另外三间房各写各的组装；Forgejo 房只有一条渠道（`fj` 的文本输出），
 * 所以这里的组装只有一件事要做：**把「这一趟取了哪几组、哪组不全」如实写下来**。
 *
 * 三条与 `fj` 有关的判断：
 *  1. 来源固定写 `forgejo-cli`：这一间房所有的读都来自 `fj`，没有第二条渠道可降级。
 *  2. `list` 的行组永远不完整：`fj issue search` 只打印编号、标题与作者，
 *     没有指派人、没有时间。标题与状态在，其余字段不在，按 `truncated` 记，不按 `complete`。
 *  3. 没取的组写 `unexpressed`，不写 `complete`：`fj` 没有这个字段就是没有，不是「确实为空」。
 */

import { FIELD_GROUPS } from '../../contract/operations-encyclopedia.js'
import type { FieldGroup, ReadOperationName } from '../../contract/operations-encyclopedia.js'
import type { FieldGroupCompleteness, ReadCompleteness, ReadProvenance } from '../../contract/read-provenance.js'

/** 这一间房唯一的取数渠道名。 */
export const FORGEJO_READ_SOURCE = 'forgejo-cli'

/**
 * 组装一份读来源。
 *
 * @param operation 读操作名（契约百科里标成读的那些）
 * @param groups 这一趟真的碰过的字段组；没写进来的组不出现在结果里
 * @param startedAt `Date.now()` 的起点，用来算耗时
 */
export function provenanceOf(
  operation: ReadOperationName,
  groups: Partial<Record<FieldGroup, FieldGroupCompleteness>>,
  startedAt: number,
): ReadProvenance {
  const declared = Object.keys(groups) as FieldGroup[]
  const values = declared.map((group) => groups[group] as FieldGroupCompleteness)
  const completeness: ReadCompleteness = values.indexOf('truncated') >= 0
    ? 'truncated'
    : values.indexOf('unexpressed') >= 0
      ? 'partial'
      : 'complete'
  return {
    operation,
    source: FORGEJO_READ_SOURCE,
    completeness,
    fieldGroups: groups,
    missingFieldGroups: FIELD_GROUPS.filter((group) => {
      const state = groups[group]
      return state === 'truncated' || state === 'unexpressed'
    }),
    durationMs: Math.max(0, Date.now() - startedAt),
    startVersion: new Date().toISOString(),
  }
}

export default provenanceOf
