/**
 * src/tracker/rooms/forgejo/budget.ts —— Forgejo 房的额度读数。
 *
 * Forgejo 的 REST 接口没有限额响应头，`fj` 也不打印任何剩余额度。这一间房能给出的诚实答案
 * 只有一个：**没量过**（`not-measured`）。不回 0（那等于声称「额度用完」而拒绝写操作），
 * 也不回任何编出来的数。
 *
 * 记账口径照旧是「只计请求」：每一次真的起过 `fj` 进程的调用都记一条请求，
 * 记账由会话管线按模块对象上的 `budget` 进行，本文件只负责读数。
 */

import type { BudgetReading } from '../../contract/budget-model.js'
import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { BudgetResult } from '../../contract/results.js'

/**
 * 读一次额度。永远回成功信封。
 *
 * 参数收下但不用：读数不依赖任何仓库或登录状态，`fj` 也没有可问的接口。
 */
export async function readForgejoBudget(ctx: (Partial<OpContext> & Partial<BackendContext>) | null | undefined): Promise<BudgetResult> {
  void ctx
  const reading: BudgetReading = { known: false, reason: 'not-measured' }
  return { ok: true, data: reading }
}

export default readForgejoBudget
