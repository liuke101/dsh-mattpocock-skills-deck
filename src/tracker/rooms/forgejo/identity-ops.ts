/**
 * src/tracker/rooms/forgejo/identity-ops.ts —— 当前登录人，以及「问不出来就说问不出来」的仓库权限。
 *
 * `fj whoami` 的输出只有一行：`currently signed into <登录名>@<主机>`。登录名是真数据，
 * 显示名与头像 `fj` 不给，所以 `Actor` 上只有 `login` 一格。
 *
 * 仓库写权限在 `fj` 0.7.0 上没有对应命令：`repo view` 不打印成员角色，也没有 `repo permissions`
 * 之类的子命令。这一条登记为欠账（`planned`），由注册表补「我不支持」的桩；调用方按未知处理，
 * 不许拿它当「不能写」去拦住用户。
 */

import type { BackendContext, OpContext } from '../../contract/contexts.js'
import type { RepositoryRef } from '../../contract/entities.js'
import type { Actor } from '../../contract/identity.js'
import type { ActorResult } from '../../contract/results.js'
import type { ErrorKind } from '../../contract/identity.js'
import { ERROR_KIND } from '../../contract/vocabulary.js'
import { fail } from '../../kernel/preflight.js'
import { fjClient } from './client.js'
import { resolveRepo } from './repo.js'
import { parseWhoAmI } from './text.js'
import { emitReadDegraded } from './read-log.js'
import { provenanceOf } from './provenance.js'
import { FORGEJO_PROBE_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'

type CtxLike = Partial<OpContext> & Partial<BackendContext>

/** 登录名缓存 60 秒；`fj auth login` 之后最多等这么久。 */
let loginCache: { at: number; host: string; login: string } = { at: 0, host: '', login: '' }
const LOGIN_TTL_MS = 60_000

/**
 * 当前登录名；问不出来回空串（不抛）。
 *
 * 评论回执要写作者，调用方不想为了一个名字把整条写路径弄失败，所以这个 helper 只回值，
 * 失败由 `getCurrentUser` 那条正式路径负责说话。
 */
export async function currentLogin(
  ctx: CtxLike | null | undefined,
  host: string,
): Promise<string> {
  const now = Date.now()
  if (loginCache.login && loginCache.host === host && now - loginCache.at < LOGIN_TTL_MS) return loginCache.login
  const result = await fjClient(ctx).run(['whoami'], { host, cwd: ctx?.cwd, timeout: FORGEJO_PROBE_TIMEOUT_MS })
  if (result.code !== 0) return ''
  const parsed = parseWhoAmI(result.stdout)
  if (!parsed) return ''
  loginCache = { at: now, host, login: parsed.login }
  return parsed.login
}

/**
 * 当前登录人。
 *
 * 没给仓库时直接问 `fj whoami`（不带 `-H` 时它问默认实例）；给了仓库就带上那台实例的地址。
 */
export async function getCurrentUser(
  repo: RepositoryRef | null | undefined,
  ctx: CtxLike | null | undefined,
): Promise<ActorResult> {
  const startedAt = Date.now()
  const resolved = await resolveRepo(repo || null, ctx || {})
  const host = resolved ? resolved.host : ''
  const result = await fjClient(ctx).run(['whoami'], { host: host || undefined, cwd: ctx?.cwd, timeout: FORGEJO_PROBE_TIMEOUT_MS })
  if (result.code !== 0) {
    emitReadDegraded(ctx as OpContext, 'currentUser', 'currentUser:transport', Date.now() - startedAt)
    return fail(ERROR_KIND.AUTH as ErrorKind, '问不到当前登录人（先 fj auth login）', result.stderr || result.stdout) as ActorResult
  }
  const parsed = parseWhoAmI(result.stdout)
  if (!parsed || !parsed.login) {
    emitReadDegraded(ctx as OpContext, 'currentUser', 'currentUser:text', Date.now() - startedAt)
    return fail(ERROR_KIND.PARSE as ErrorKind, '看不懂 fj whoami 的输出', result.stdout) as ActorResult
  }
  const actor: Actor = { login: parsed.login }
  return {
    ok: true,
    data: actor,
    provenance: provenanceOf('getCurrentUser', { identity: 'complete' }, startedAt),
  } as ActorResult
}

export default getCurrentUser
