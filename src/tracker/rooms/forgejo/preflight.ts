/**
 * src/tracker/rooms/forgejo/preflight.ts —— 环境预检：工具在不在、登录没有、仓库连不连得上。
 *
 * 只判环境，不预判能力：这里回答的是「这条路现在通不通」，不是「能不能建票」。
 * 三项门禁与另外两间房一致：
 *  1. `fj` 可执行文件解析得到；
 *  2. 这台机器上至少登录了一台实例，且目标仓库所在的那台在名单里；
 *  3. 目标仓库读得回来（`fj repo view <owner/name>`）。
 *
 * 失败一律带原文三段式 `{kind, message, raw}`：界面要能展开看 `fj` 的原话，
 * 日志里也要能从档位看出下一步是「装工具」「登录」还是「查网络」。
 */

import type { BackendContext, OpContext, RepoHandle } from '../../contract/contexts.js'
import type { RepositoryRef } from '../../contract/entities.js'
import type { PreflightResult } from '../../contract/results.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { ErrorKind } from '../../contract/identity.js'
import { fail, HINT_UNRECOGNIZED } from '../../kernel/preflight.js'
import { classifyFjError, hintFor } from './errors.js'
import { authenticatedHosts, parseForgejoRemote, resolveRepo } from './repo.js'
import { parseAuthHosts, parseRepoView } from './text.js'
import { fjClient } from './client.js'
import { emitPreflightGatePass, emitReadDegraded } from './read-log.js'
import { FORGEJO_PROBE_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'

type PreflightHandle = Partial<OpContext> & Partial<BackendContext> & Partial<RepoHandle> & Partial<RepositoryRef>

/** 从任意入参里取本次要用的上下文；两边都可能给，取并集。 */
function ctxOf(handle: PreflightHandle | null | undefined, opCtx: PreflightHandle | null | undefined): PreflightHandle {
  return Object.assign({}, handle || {}, opCtx || {})
}

/**
 * 第二关失败时把 not-found 收敛成 env。
 *
 * `fj auth list` 不会回 not-found，但「目标实例不在登录名单里」与「仓库不存在」长得像；
 * 这一关问的是登录态，登录名单里没有它说明凭据没配好，归 env 让用户去登录。
 */
function loginProbeKind(kind: ErrorKind): ErrorKind {
  return kind === (ERROR_KIND.NOTFOUND as ErrorKind) ? (ERROR_KIND.ENV as ErrorKind) : kind
}

/**
 * 三项门禁。
 *
 * @param handle 仓库身份或句柄（两边形状都收，只取 refId、host 与 cwd）
 * @param opCtx 本次调用的上下文（平台与执行器从这里取）
 */
export async function fjPreflight(
  handle: PreflightHandle | null | undefined,
  opCtx: PreflightHandle | null | undefined,
): Promise<PreflightResult> {
  const ctx = ctxOf(handle, opCtx)
  const started = Date.now()

  // 第一关：工具在不在。`fj version` 不碰网络，冷启动也快。
  const platform = ctx.platform
  if (!platform || typeof platform.resolveExecutable !== 'function') {
    emitReadDegraded(ctx as OpContext, 'preflight', 'preflight:fj', Date.now() - started)
    return { ok: false, error: { kind: ERROR_KIND.ENV as ErrorKind, message: '平台没有提供可执行文件解析能力，无法启动 fj', raw: '' } }
  }
  let exe: string | null = null
  try { exe = await platform.resolveExecutable('fj') } catch { exe = null }
  if (!exe) {
    emitReadDegraded(ctx as OpContext, 'preflight', 'preflight:fj', Date.now() - started)
    return { ok: false, error: { kind: ERROR_KIND.ENV as ErrorKind, message: '这台机器上找不到 fj（Forgejo CLI）', raw: 'fj: command not found' } }
  }
  const version = await fjClient(ctx as OpContext).run(['version'], { timeout: FORGEJO_PROBE_TIMEOUT_MS })
  if (version.code === 127) {
    emitReadDegraded(ctx as OpContext, 'preflight', 'preflight:fj', Date.now() - started)
    return { ok: false, error: { kind: ERROR_KIND.ENV as ErrorKind, message: '这台机器上找不到 fj（Forgejo CLI）', raw: version.stderr || version.stdout } }
  }
  emitPreflightGatePass(ctx as OpContext, 1, Date.now() - started)

  // 第二关：登录没有。只读本地凭据，不碰远端。
  const loginStarted = Date.now()
  const repo = await resolveRepo(handle, ctx)
  const hosts = await authenticatedHosts(ctx)
  const authList = await fjClient(ctx as OpContext).run(['auth', 'list'], { timeout: FORGEJO_PROBE_TIMEOUT_MS })
  const rawHosts = authList.code === 0 ? parseAuthHosts(authList.stdout || authList.stderr) : []
  if (repo && rawHosts.length > 0) {
    const known = rawHosts.some((host) => parseForgejoRemote('https://' + host + '/x/y')?.hostKey === repo.hostKey)
    if (!known) {
      emitReadDegraded(ctx as OpContext, 'preflight', 'preflight:auth', Date.now() - loginStarted)
      return { ok: false, error: { kind: ERROR_KIND.ENV as ErrorKind, message: '这台实例还没登录（fj auth login）', raw: rawHosts.join('\n') } }
    }
  } else if (rawHosts.length === 0) {
    const verdict = classifyFjError(authList, ctx as OpContext)
    const kind = loginProbeKind(verdict.kind)
    emitReadDegraded(ctx as OpContext, 'preflight', 'preflight:auth', Date.now() - loginStarted)
    return fail(kind, hintFor({ kind, fallback: verdict.fallback }, '这台机器上还没有登录任何 Forgejo 实例'), authList.stderr || authList.stdout)
  }
  emitPreflightGatePass(ctx as OpContext, 2, Date.now() - loginStarted)

  // 第三关：目标仓库读得回来。没有仓库坐标时这一关算「无事可做」，前两关过了就通过。
  const repoStarted = Date.now()
  if (repo) {
    const view = await fjClient(ctx as OpContext).run(['repo', 'view', repo.refId], { host: repo.host, cwd: (ctx as OpContext).cwd, timeout: FORGEJO_PROBE_TIMEOUT_MS })
    const parsed = parseRepoView(view.stdout || '')
    if (view.code !== 0 || !parsed) {
      const verdict = classifyFjError(view, ctx as OpContext)
      emitReadDegraded(ctx as OpContext, 'preflight', 'preflight:repo-view', Date.now() - repoStarted)
      return fail(verdict.kind, verdict.fallback ? HINT_UNRECOGNIZED : '读不到这个仓库（' + repo.refId + '）', view.stderr || view.stdout)
    }
  }
  emitPreflightGatePass(ctx as OpContext, 3, Date.now() - repoStarted)

  return { ok: true }
}

export default fjPreflight
