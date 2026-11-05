/**
 * src/tracker/rooms/forgejo/client.ts —— `fj`（forgejo-cli）的唯一进程出口。
 *
 * 这一间房只经这里起 `fj`，别处不许直接调 `exec`。理由与 GitLab 房的 client 相同：
 * 可执行文件解析、超时、取消、回包归一与额度记账都只该有一份实现；散到每个操作里，
 * 迟早出现「某一处忘了传 signal」或「某一处把 127 当成业务失败」。
 *
 * 三条今天必须知道的约定：
 *  1. `fj` 的超时由这里统一给（缺省读档），调用方可以更短，但不许自己写数字。
 *  2. 只有真正起了进程才记一条请求。没装 `fj`、平台缺执行器这两种情况一个字节都没发出去，
 *     不能记成「花了一条额度」。
 *  3. `fj` 把仓库选在哪个远端上，取决于它的默认规则（按远端名字母序取第一个），
 *     一个工作区有多个远端时会选错。所以调用方必须显式给仓库：支持 `-r owner/name` 的命令
 *     用 `-r`，不支持的命令用 `-R <远端名>`。这里不替调用方猜。
 */

import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { OpResult } from '../../contract/results.js'
// 本域 tsconfig 有意不加载任何类型包（types 为空），node:async_hooks 的类型声明随 @types/node
// 一起被挡在门外；运行时一定是 Node。写法与 GitLab 房 client 的同一处相同。
// @ts-expect-error 本域类型配置没有加载 @types/node
import { AsyncLocalStorage } from 'node:async_hooks'
import { FORGEJO_READ_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'

/** 上下文只取平台与执行器两样，且都允许缺失；缺了按 127 如实回，不抛。 */
type FjCtx = Partial<OpContext> & Partial<BackendContext>

/** 单次执行 `fj` 的入参。 */
export interface FjRunOpts {
  cwd?: string
  timeout?: number
  signal?: AbortSignal
  /** 实例地址（`http://host:port` 或 `https://host`）。给了就拼在子命令前面。 */
  host?: string
  /** 本地仓库里的远端名；命令支持时用它把仓库钉死（`-R`），避免多远端时 `fj` 自己选错。 */
  remote?: string
}

/** `fj` 一次执行的回包三件套。 */
export interface FjRunResult {
  stdout: string
  stderr: string
  code: number
}

/** 客户端的唯一入口。 */
export interface FjClient {
  run(args: string[], opts?: FjRunOpts): Promise<FjRunResult>
}

/** 一次操作自己的计数器：真正发出去的请求条数。 */
interface FjUsageBox { requests: number; points: number }

/** AsyncLocalStorage 的最小视图（本域没有 Node 类型，按用到的两格声明）。 */
interface FjUsageStore {
  run<T>(box: FjUsageBox, fn: () => T): T
  getStore(): FjUsageBox | undefined
}

const fjUsageStore = new AsyncLocalStorage() as FjUsageStore

/** 把仓库坐标翻成 `fj` 的定位参数：实例地址，以及能认出来时带上的远端名。 */
export function repoOpts(repo: { host: string; remote?: string } | null | undefined): { host?: string; remote?: string } {
  if (!repo) return {}
  return repo.remote ? { host: repo.host, remote: repo.remote } : { host: repo.host }
}

/** 一次 `fj` 真正起进程时调一次（解析出可执行文件之后、exec 之前）。 */
function noteFjUsage(): void {
  const box = fjUsageStore.getStore()
  if (!box) return
  box.requests += 1
}

/**
 * 把房间操作表整体包一层：函数成员在成功信封上补 `usage`。
 *
 * 只补成功信封：失败信封没有 `data`，用量跟着失败一起丢掉；失败那一笔花没花由记账侧按口径定。
 * 同步成员（`describe` / `issueAddress`）原样交回，不改签名。
 */
export function attachFjOpUsage<T extends object>(table: T): T {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(table)) {
    const value = (table as Record<string, unknown>)[key]
    if (typeof value !== 'function') { out[key] = value; continue }
    out[key] = function (this: unknown, ...args: unknown[]): unknown {
      // 必须在计数器的作用域里「调用」函数：操作可能在第一个 await 之前就发起命令，
      // 先调用再进作用域会漏记。
      const box: FjUsageBox = { requests: 0, points: 0 }
      const result = fjUsageStore.run(box, function () { return (value as (...a: unknown[]) => unknown).apply(table, args) })
      if (!result || typeof (result as Promise<unknown>).then !== 'function') return result
      return (result as Promise<unknown>).then(function (envelope) {
        const reply = envelope as OpResult<unknown> | null
        if (reply && reply.ok === true) {
          // 零也照附：零是「量过了，这一笔没有出站」，与「没量」不是一回事。
          return Object.assign({}, reply, { usage: { requests: box.requests, points: box.points } })
        }
        return reply
      })
    }
  }
  return out as T
}

/**
 * 构造一次调用的客户端。
 *
 * @param opCtx 单次调用上下文（`create` 只给进程级上下文时也能用，执行时按缺省读档超时）
 */
export function fjClient(opCtx: FjCtx | null | undefined): FjClient {
  const platform = opCtx && opCtx.platform
  const exec = opCtx && opCtx.exec
  async function run(args: string[], opts: FjRunOpts = {}): Promise<FjRunResult> {
    if (!platform || typeof platform.resolveExecutable !== 'function') {
      return { stdout: '', stderr: 'platform unavailable', code: 127 }
    }
    if (!exec || typeof exec !== 'function') {
      return { stdout: '', stderr: 'exec unavailable', code: 127 }
    }
    const exe = await platform.resolveExecutable('fj')
    if (!exe) {
      return { stdout: '', stderr: 'fj: command not found', code: 127 }
    }
    const cwd = opts.cwd || opCtx?.cwd || undefined
    const signal = opts.signal || opCtx?.signal || undefined
    const timeout = typeof opts.timeout === 'number' ? opts.timeout : FORGEJO_READ_TIMEOUT_MS
    const argv: string[] = []
    if (opts.host) argv.push('-H', String(opts.host))
    if (cwd) argv.push('-C', String(cwd))
    for (const arg of args) argv.push(arg)
    // `-R` 是子命令选项（不是全局选项），所以放在参数末尾。只有 `issue search` 的 `-r` 才是
    // 「按 owner/name 选仓库」；`issue edit labels` 的 `-r` 是「去掉标签」，不能拿它当已有仓库参数。
    const alreadyHasRepo = args.indexOf('-R') >= 0 || args.indexOf('--remote') >= 0 ||
      (args[0] === 'issue' && args[1] === 'search' && args.indexOf('-r') >= 0)
    if (opts.remote && !alreadyHasRepo) {
      argv.push('-R', String(opts.remote))
    }
    try {
      noteFjUsage()
      const res = await exec('fj', argv, { cwd, signal, timeout })
      const bag = res as unknown as Record<string, unknown>
      if (bag && typeof bag['code'] === 'number') {
        return {
          stdout: typeof bag['stdout'] === 'string' ? (bag['stdout'] as string) : '',
          stderr: typeof bag['stderr'] === 'string' ? (bag['stderr'] as string) : '',
          code: bag['code'] as number,
        }
      }
      // 兼容只给合并输出的执行器：有 text 就把它当 stdout。
      if (bag && typeof bag['text'] === 'string') {
        return { stdout: bag['text'] as string, stderr: '', code: 0 }
      }
      return { stdout: String((res as unknown) ?? ''), stderr: '', code: 0 }
    } catch (e: unknown) {
      const bag = (e !== null && typeof e === 'object' ? e : {}) as Record<string, unknown>
      const msgSource = bag['message'] ?? bag['stderr'] ?? bag['stdout'] ?? e
      const msg = msgSource ? String(msgSource) : String(e)
      const code = typeof bag['code'] === 'number' ? (bag['code'] as number) : 1
      const out = typeof bag['stdout'] === 'string' ? String(bag['stdout']) : ''
      return { stdout: out, stderr: msg, code }
    }
  }
  return { run }
}

export default fjClient
