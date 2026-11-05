/**
 * src/tracker/rooms/forgejo/read-log.ts —— Forgejo 房读路径「这一趟没读成」的结论线。
 *
 * 事件名沿用全仓已登记的两个：常驻 #108 `read.degraded` 与常驻 #109 `preflight.gate`，
 * 不新开 `fj.*`。字段形状与 GitHub / GitLab 两房逐格相同：`{op, reason, latencyMs, opId}`。
 * 票号、命令原文、上游报错原文、仓库地址原文一个字都不记。
 *
 * 为什么这一间房尤其需要它：`fj` 的失败很多时候退出码也是 0（它把错误打在文本里），
 * 只靠进程退出码看不出这一趟读成没成。所以每一次「文本认不出 / 命令没跑成 / 拿不全」
 * 都必须在日志里留一行，否则事后拿导出包的人只能看到「几条命令」，分不清是哪一步折了。
 *
 * 字段白名单见 `tests/verify-log-fields.ts`；记日志那层壳与耗时归一化在
 * `src/tracker/kernel/log-emit.ts`。读路径的日志失败不许影响操作结果。
 */

import type { BackendContext, OpContext } from '../../contract/contexts.js'
import { LIST_TRUNCATED_REASON } from '../../contract/results.js'
import { guardEmit, ms } from '../../kernel/log-emit.js'

/** 会报降级的读操作。`matches` 与 `preflight` 不是契约操作，但同样是读，一并列。 */
export const READ_DEGRADED_OPS = Object.freeze([
  'matches',
  'preflight',
  'list',
  'get',
  'getDependencies',
  'listSubIssues',
  'counts',
  'listPage',
  'labels',
  'maps',
  'currentUser',
  'repoKey',
] as const)

/**
 * 这一趟为什么算「没读成」。格式是「操作名:这一步」，冒号后是短枚举：
 *  - `fj`         : 起不了 fj（解析不出可执行文件）
 *  - `auth`       : 登录状态这一项门禁没过
 *  - `repo-view`  : 从当前目录认不出仓库这一项门禁没过
 *  - `repo-ref`   : 入参给的仓库标识缺了或形状不对，连进程都没起
 *  - `transport`  : 命令没跑成（起不了进程、超时、非 0 退出），房间这层没拿到可用回包
 *  - `text`       : 回包是文本，但这一趟必须的字段认不出来
 *  - `empty`      : 回包是空串，读不到东西
 *  - `stat`       : 计数那一笔的数缺了或不是非负整数（拒绝猜一个数）
 *  - `total`      : 分页要的总数缺失或不是非负整数
 *  - `cursor`     : 游标已失效，界面据此丢游标重取第一页
 *  - `partial`    : 只拿到一部分就按成功返回（拿不全但没失败）
 *  - `truncated`  : 条数到了上限，被截断（拿不全但没失败）
 *  - `notfound`   : 远端明确说这张票 / 这个仓库不在
 *  - `fs-unavailable` : 连文件服务都拿不到，识别这一趟根本没跑起来
 *  - `git-config` : 读工作区里的 `.git/config` 这一步没给出答案
 *  - `tracker-doc`: 读工作区里的 `docs/agents/issue-tracker.md` 这一步没给出答案
 *  - `unknown`    : 上面都不像（新增分支时回来加取值，不许拿它当默认值）
 */
export const READ_DEGRADED_REASONS = Object.freeze([
  'matches:fs-unavailable',
  'matches:git-config',
  'matches:tracker-doc',
  'matches:auth-probe',
  'matches:unknown',
  'preflight:fj',
  'preflight:auth',
  'preflight:repo-view',
  'list:repo-ref',
  'list:transport',
  'list:text',
  'list:partial',
  LIST_TRUNCATED_REASON,
  'get:repo-ref',
  'get:transport',
  'get:text',
  'get:notfound',
  'getDependencies:transport',
  'listSubIssues:transport',
  'create:partial',
  'counts:repo-ref',
  'counts:transport',
  'counts:text',
  'counts:stat',
  'listPage:repo-ref',
  'listPage:transport',
  'listPage:text',
  'listPage:total',
  'listPage:cursor',
  'labels:repo-ref',
  'labels:transport',
  'labels:text',
  'labels:partial',
  'maps:repo-ref',
  'maps:transport',
  'maps:text',
  'maps:truncated',
  'currentUser:transport',
  'currentUser:text',
  'repoKey:notfound',
  'repoKey:unknown',
] as const)

/** 探测那几项门禁的编号：1 起 fj 可执行、2 登录状态、3 认得出仓库且连得上接口。 */
export const PREFLIGHT_GATES = Object.freeze([1, 2, 3] as const)

/** 三项门禁没过时的原因取值，与 READ_DEGRADED_REASONS 里那三条同一份。 */
export const PREFLIGHT_GATE_REASONS = Object.freeze({
  1: 'preflight:fj',
  2: 'preflight:auth',
  3: 'preflight:repo-view',
} as const)

/** 门禁编号必须是登记过的那三个之一；不认识的编号不许悄悄记出去。 */
export function isPreflightGate(gate: unknown): boolean {
  return PREFLIGHT_GATES.indexOf(gate as 1) >= 0
}

/** 半份上下文也认：房间写路径只拿得到进程级上下文，日志这一层不要求它齐全。 */
type LoggerCtx = Partial<OpContext> & Partial<BackendContext>

/** 记一行「这一趟读没读成」（`read.degraded`）。成功且完整的读不记。 */
export function emitReadDegraded(
  ctx: LoggerCtx | null | undefined,
  op: string,
  reason: string,
  latencyMs: unknown,
): void {
  guardEmit(ctx, (c) => {
    c.logEvent?.('warn', 'read.degraded', {
      op: String(op || ''),
      reason: String(reason || ''),
      latencyMs: ms(latencyMs),
      opId: String(c.opId || ''),
    })
  })
}

/** 记一行「探测的那一项门禁过了」（`preflight.gate`）。过了也记，否则日志分不清走到第几关。 */
export function emitPreflightGatePass(
  ctx: LoggerCtx | null | undefined,
  gate: number,
  latencyMs: unknown,
): void {
  guardEmit(ctx, (c) => {
    c.logEvent?.('warn', 'preflight.gate', {
      gate: gate,
      reason: 'ok',
      latencyMs: ms(latencyMs),
      opId: String(c.opId || ''),
    })
  }, () => isPreflightGate(gate))
}

/** 记一行「仓库坐标这一趟从第几层认出来的」（`repo.resolve.tier`）。只记层号、成没成、耗时。 */
export function emitRepoTier(
  ctx: LoggerCtx | null | undefined,
  tier: number,
  ok: boolean,
  startedAt: number,
): void {
  guardEmit(ctx, (c) => {
    c.logEvent?.('info', 'repo.resolve.tier', {
      tier: tier,
      ok: ok === true,
      latencyMs: ms(Date.now() - startedAt),
    })
  })
}

export default {
  emitReadDegraded,
  emitPreflightGatePass,
  emitRepoTier,
  READ_DEGRADED_OPS,
  READ_DEGRADED_REASONS,
  PREFLIGHT_GATES,
  PREFLIGHT_GATE_REASONS,
}
