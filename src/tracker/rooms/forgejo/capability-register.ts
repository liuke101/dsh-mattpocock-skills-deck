/**
 * src/tracker/rooms/forgejo/capability-register.ts —— Forgejo 后端对 27 条能力的回答（数据）。
 *
 * 四档的判据只在 `src/tracker/contract/capability-answer.ts` 的文件头写一份，这里不重复。
 * 这一份只回答「Forgejo 通过 `fj` 这一条路，今天能做到什么程度」，每条 `partial` 都写清缺口、
 * 每条 `planned` 都写清承接的票。判据来自 2026-11-05 对 forgejo-cli 0.7.0 与 Forgejo 17.0.1
 * 的实测，样本收在 `tests/fixtures/forgejo/`。
 *
 * 与谁是一对：
 *  - 给人读的表：`docs/tracker/capability-forgejo.md`（门禁逐条比对，两边不许打架）
 *  - 实现真源：`src/tracker/rooms/forgejo/index.ts`（工厂交出来的成员由本文件推出来）
 *  - 接手的人先读：`src/tracker/rooms/forgejo/README.md`
 *
 * 三条今天必须记住的事实：
 *  1. `fj` 没有 `--json`，所有读都是文本解析；时间戳与关闭原因它根本不打印。
 *  2. 去标签、去依赖两个接口在 Forgejo 17.0.1 上会重置连接（`os error 104`），加是正常的。
 *  3. `fj issue search` 的行只有编号、标题、作者；列表行因此是薄的。
 */
import type { CapabilityRegister } from '../../contract/capability-answer.js'

/**
 * Forgejo 后端：27 条能力里 14 条真提供、9 条做了但有明确缺口、3 条欠账、1 条形态不合。
 *
 * 顺序照契约名录（24 条操作在前、3 条定位口在后）。
 */
export const FORGEJO_CAPABILITY_REGISTER = {
  // —— 操作 24 条 ——
  preflight: { tier: 'provided' },
  // 搜索结果只有编号、标题、作者；正文、指派人、时间没有，标签要靠逐标签搜索另补。
  list: {
    tier: 'partial',
    gap: '列表行只有编号、标题、作者与（另补的）标签；正文恒为空、更新时间恒为空、指派人不可知，规格票在列表里读成普通票。',
    ticket: '1875',
  },
  // 详情页读得到标题、状态、作者、标签、正文、评论、指派人、原生依赖；时间戳与关闭原因读不到。
  get: {
    tier: 'partial',
    gap: 'fj 不打印创建时间、更新时间与关闭原因，这三个核心字段恒为空/空值；父子边只有正文文件头里的隐藏标记。',
    ticket: '1875',
  },
  getDependencies: { tier: 'provided' },
  create: {
    tier: 'partial',
    gap: '幂等锚回查依赖 Forgejo 全文搜索召回候选，实例关闭搜索索引时可能落空；标签与指派人建票后补写，失败时票已创建但缺这两项。',
    ticket: '1875',
  },
  close: { tier: 'provided' },
  // fj 0.7.0 没有 reopen 子命令；平台本身支持重开，等 CLI 补命令后接上。
  reopen: { tier: 'planned', ticket: '1875' },
  comment: { tier: 'provided' },
  update: {
    tier: 'partial',
    gap: '标题、正文、里程碑是三条独立命令，不是原子写；中途失败时前面的字段已经落盘。',
    ticket: '1875',
  },
  setLabels: {
    tier: 'partial',
    gap: '去标签在 Forgejo 17.0.1 + fj 0.7.0 上会重置连接（加标签正常）；expectedUpdatedAt 无法比对，因为没有可读的更新时间。',
    ticket: '1875',
  },
  setAssignees: { tier: 'provided' },
  setParent: { tier: 'provided' },
  setBlockedBy: {
    tier: 'partial',
    gap: '加依赖正常；去依赖会重置连接（与去标签同源）。成环与自环在写之前就拦下。',
    ticket: '1875',
  },
  counts: { tier: 'provided' },
  listPage: {
    tier: 'partial',
    gap: '没有时间戳，排序退回 Forgejo 搜索顺序；不筛状态时开着的一批排在关着的一批前面，不是跨状态的时间序。',
    ticket: '1875',
  },
  listLabels: { tier: 'provided' },
  setLabelColors: { tier: 'provided' },
  getCurrentUser: { tier: 'provided' },
  // fj 0.7.0 没有查询仓库权限的命令；问不出来就按未知处理，不捏造。
  getRepoPermissions: { tier: 'planned', ticket: '1875' },
  listSubIssues: {
    tier: 'partial',
    gap: '没有服务端子票总数：先按标记文本搜索召回，再逐张读票面确认，候选超过 200 张或搜索翻页到顶时记 capped，总数只能等于本次确认的条数。',
    ticket: '1875',
  },
  // fj repo create 存在，但建仓、初始化本地 git、提交、推送这一整条发布流程本轮没落地。
  initProject: { tier: 'planned', ticket: '1875' },
  // 颜色真源是远端仓库标签，工作区里放一份手改文件没有读者，形态不成立。
  ensureLabelColorsFile: { tier: 'unsupported-by-design', stubBy: 'registry' },
  // Forgejo 没有限额接口，fj 也不打印剩余额度：读数固定是「没量过」，这是诚实的答案。
  readBudget: { tier: 'provided' },
  listMaps: {
    tier: 'partial',
    gap: '没有时间戳，无法按更新时间倒序；返回的是 Forgejo 搜索顺序，状态分开的两批拼在一起。',
    ticket: '1875',
  },

  // —— 定位口 3 条：全部提供 ——
  getRepoKey: { tier: 'provided' },
  describe: { tier: 'provided' },
  issueAddress: { tier: 'provided' },
} as const satisfies CapabilityRegister

export default FORGEJO_CAPABILITY_REGISTER
