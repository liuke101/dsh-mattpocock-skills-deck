/**
 * src/tracker/rooms/forgejo/repo.ts —— Forgejo 仓库坐标：从工作区与远端地址认出「哪一台实例上的哪个仓库」。
 *
 * 这一间房与 GitHub / GitLab 最大的不同：Forgejo 是自建软件，没有唯一的默认域名。
 * 同一个 `owner/name` 可以同时存在于好几台实例上，所以仓库坐标必须带上实例地址（`host`），
 * 光有 `owner/name` 不足以定位。这里的解析因此多出一格 `host`，`-H` 参数与网页地址都从它来。
 *
 * 解析只认 git 记下的远端地址（`.git/config` 的 `[remote ...]` 段），不在整份 config 文本里
 * 找 `forgejo` 字样：分支名里带这个词会把别人的仓库误认成自己的（#1533 在 GitLab 房踩过）。
 *
 * 远端地址的四种写法都要认：
 *   http(s)://host[:port]/owner/name.git
 *   ssh://git@host[:port]/owner/name.git
 *   git@host:owner/name.git（scp 写法）
 *   host:owner/name（少数自建实例的手写写法）
 *
 * 认不出来一律回 null，不抛异常，也不猜一个默认实例。
 */

import type { BackendContext, OpContext, RepoHandle } from '../../contract/contexts.js'
import type { RepositoryRef } from '../../contract/entities.js'
import { remoteUrlsOfGitConfig } from '../../kernel/git-remote.js'
import { parseIssueTracker, normalizeTrackerText } from '../../kernel/issue-tracker-declaration.js'
import { fjClient } from './client.js'
import { parseAuthHosts, parseRepoView, normalizeHost } from './text.js'
import { emitReadDegraded, emitRepoTier } from './read-log.js'
import { FORGEJO_FALLBACK_TIMEOUT_MS, FORGEJO_PROBE_TIMEOUT_MS, FORGEJO_REPO_GIT_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'

/** 一台实例上的一个仓库。`host` 是网页 origin（含协议与端口），`hostKey` 只用于比较。 */
export interface ForgejoRepo {
  host: string
  hostKey: string
  owner: string
  name: string
  refId: string
  /** 本地 git 里指向这个仓库的远端名；认不出来是空串。 */
  remote: string
  /** 网页地址；认不出来是空串。 */
  url: string
}

/** 上下文只取用到的几格，允许半份上下文；缺了按「没认出」回。 */
type RepoCtx = Partial<OpContext> & Partial<BackendContext>

/**
 * 解析一条远端地址。认不出回 null。
 *
 * @param raw 远端地址原文（允许带尾部 `.git`、查询串与井号）
 * @returns 实例 origin、比较用主机键、owner/name 与网页地址
 */
export function parseForgejoRemote(raw: unknown): ForgejoRepo | null {
  const text = String(raw === null || raw === undefined ? '' : raw).trim()
  if (!text) return null
  const cleaned = text.replace(/[?#].*$/, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  let scheme = ''
  let authority = ''
  let path = ''
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)\/(.+)$/i.exec(cleaned)
  if (url) {
    scheme = url[1].toLowerCase()
    authority = url[2]
    path = url[3]
  } else {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(cleaned)
    if (!scp) return null
    authority = scp[1]
    path = scp[2]
  }
  // 去掉用户信息（ssh 地址里的 git@）。
  authority = authority.replace(/^[^@/]*@/, '')
  const segments = path.split('/').filter((part) => part !== '')
  if (segments.length < 2) return null
  const owner = segments[segments.length - 2]
  const name = segments[segments.length - 1]
  if (!owner || !name) return null
  const hostKey = normalizeHost(authority)
  if (!hostKey) return null
  // ssh 的 2222 是转运端口，不是网页端口；网页 origin 仍用 https 默认端口。
  const webScheme = scheme === 'http' ? 'http' : 'https'
  const host = scheme === 'http' || scheme === 'https' ? scheme + '://' + authority : webScheme + '://' + authority.replace(/:\d+$/, '')
  return {
    host,
    hostKey,
    owner,
    name,
    refId: owner + '/' + name,
    remote: '',
    url: host + '/' + owner + '/' + name,
  }
}

/** 从 `refId` 里取 owner/name（`owner/name` 或 `host/owner/name` 两种都收）。 */
export function splitRefId(refId: unknown): { owner: string; name: string } | null {
  const text = String(refId === null || refId === undefined ? '' : refId).trim().replace(/^\/+|\/+$/g, '')
  if (!text) return null
  const parts = text.split('/').filter((part) => part !== '')
  if (parts.length < 2) return null
  return { owner: parts[parts.length - 2], name: parts[parts.length - 1] }
}

/** 从工作区目录与句柄里取 refId 与 host，拼成仓库坐标；缺主机时回 null，调用方再去看远端。 */
export function repoOfHandle(handle: RepoHandle | Partial<RepositoryRef> | null | undefined): ForgejoRepo | null {
  if (!handle) return null
  const refId = typeof handle.refId === 'string' ? handle.refId : ''
  const names = splitRefId(refId)
  if (!names) return null
  const hostRaw = typeof (handle as Partial<RepositoryRef>).host === 'string' ? (handle as Partial<RepositoryRef>).host : ''
  if (!hostRaw) return null
  const host = String(hostRaw).replace(/\/+$/, '')
  const hostKey = normalizeHost(host)
  if (!hostKey) return null
  return { host, hostKey, owner: names.owner, name: names.name, refId: names.owner + '/' + names.name, remote: '', url: host + '/' + names.owner + '/' + names.name }
}

/** 按文件服务的规矩读一个工作区文件；读不出来回 null。 */
async function readWorkspaceFile(fs: OpContext['fs'] | undefined, cwd: string, rel: string): Promise<string | null> {
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.readText !== 'function') return null
  try {
    const target = await fs.resolve(rel, { cwd })
    const text = await fs.readText(target)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/** 已经登录的实例地址（比较用主机键）。给 `matches` 与远端筛选共用。 */
let authHostsCache: { at: number; hosts: string[] } = { at: 0, hosts: [] }
const AUTH_HOSTS_TTL_MS = 30_000

/**
 * 问一次 `fj auth list` 拿到这台机器上已经登录的实例。
 *
 * 结果缓存 30 秒：判定层会在一次扫描里对同一个工作区问好几次，每次都起一个进程太重。
 * 30 秒也是用户 `fj auth login` 之后最多等多久才被认出来的上限。
 */
export async function authenticatedHosts(ctx: RepoCtx): Promise<string[]> {
  const now = Date.now()
  if (now - authHostsCache.at < AUTH_HOSTS_TTL_MS) return authHostsCache.hosts
  const result = await fjClient(ctx).run(['auth', 'list'], { timeout: FORGEJO_PROBE_TIMEOUT_MS })
  const hosts = result.code === 0 ? parseAuthHosts(result.stdout || result.stderr).map(normalizeHost).filter((host) => host !== '') : []
  authHostsCache = { at: now, hosts }
  return hosts
}

/**
 * 在 `.git/config` 的远端里找一条指向已登录 Forgejo 实例的地址。
 *
 * 优先选 `origin`：多远端时它是最常见的那个；`origin` 不是 Forgejo 时才看别的远端。
 * `refId` 给了就同时要求 owner/name 对得上，避免把同一个工作区里另一个仓库的远端认成目标。
 */
export async function forgejoRemoteOf(
  cwd: string,
  ctx: RepoCtx,
  refId?: string,
): Promise<ForgejoRepo | null> {
  const fs = (ctx as OpContext).fs
  const config = await readWorkspaceFile(fs, cwd, '.git/config')
  if (!config) return null
  const hosts = await authenticatedHosts(ctx)
  if (hosts.length === 0) return null
  const want = splitRefId(refId)
  const urls = remoteUrlsOfGitConfig(config)
  const parsed: ForgejoRepo[] = []
  for (const url of urls) {
    const repo = parseForgejoRemote(url)
    if (!repo) continue
    if (hosts.indexOf(repo.hostKey) < 0) continue
    if (want && (repo.owner !== want.owner || repo.name !== want.name)) continue
    parsed.push(repo)
  }
  if (parsed.length === 0) return null
  for (const repo of parsed) repo.remote = remoteNameOf(config, repo)
  const origin = parsed.find((repo) => repo.remote === 'origin')
  return origin || parsed[0]
}

/**
 * 在 `.git/config` 里找出指向某个仓库的远端名。
 *
 * 比较的是解析后的 owner/name 与主机键，不是地址字符串：同一个仓库可以同时有 https 与 ssh
 * 两个远端，地址写法不同但指向同一个仓库。`fj` 的 `-R` 要的是远端名，认不出来时回空串，
 * 调用方退回 `-C`。
 */
export function remoteNameOf(configText: string, repo: ForgejoRepo | null): string {
  if (!repo) return ''
  let current = ''
  for (const raw of String(configText || '').split(/\r?\n/)) {
    const line = raw.trim()
    const head = /^\[remote\s+"([^"]+)"\]$/.exec(line)
    if (head) { current = head[1]; continue }
    if (!current) continue
    const url = /^url\s*=\s*(.+)$/i.exec(line)
    if (!url) continue
    const candidate = parseForgejoRemote(url[1].trim())
    if (!candidate) continue
    if (candidate.hostKey === repo.hostKey && candidate.owner === repo.owner && candidate.name === repo.name) return current
  }
  return ''
}

/** 这个工作区里指向 Forgejo 的远端名（给 `fj` 的 `-R` 用）；没有就回空串。 */
export async function remoteNameFor(
  cwd: string,
  ctx: RepoCtx,
  repo: ForgejoRepo | null,
): Promise<string> {
  if (!repo) return ''
  const config = await readWorkspaceFile((ctx as OpContext).fs, cwd, '.git/config')
  if (!config) return ''
  return remoteNameOf(config, repo)
}

/**
 * 解析出这一趟要操作的仓库。
 *
 * 顺序：句柄里的 refId + host → `.git/config` 里指向已登录实例的远端 → null。
 * 给了 refId 但没给 host 时，远端要同时满足 owner/name，避免选错仓库。
 */
export async function resolveRepo(
  handle: RepoHandle | Partial<RepositoryRef> | null | undefined,
  ctx: RepoCtx,
): Promise<ForgejoRepo | null> {
  const direct = repoOfHandle(handle)
  if (direct) {
    const cwd = handle && typeof (handle as RepoHandle).cwd === 'string' ? (handle as RepoHandle).cwd : (ctx as OpContext).cwd
    if (!direct.remote && cwd) direct.remote = await remoteNameFor(cwd, ctx, direct)
    return direct
  }
  const cwd = handle && typeof (handle as RepoHandle).cwd === 'string' ? (handle as RepoHandle).cwd : (ctx as OpContext).cwd
  if (!cwd) return null
  const refId = handle && typeof handle.refId === 'string' ? handle.refId : ''
  return forgejoRemoteOf(cwd, ctx, refId || undefined)
}

/**
 * `getRepoKey`：从目录解析出 `owner/name`。
 *
 * 三层兜底，顺序与另外两间房一致：
 *  1. 问 git（`git -C <cwd> remote get-url origin`）；
 *  2. 直读 `.git/config` 的远端段；
 *  3. 问 `fj repo view`（它自己会从 cwd 的远端认仓库）。
 *
 * 任何一层成功就回；全都不成回 null，不抛。
 */
export async function getRepoKey(
  cwd: string,
  ctx: RepoCtx,
): Promise<{ owner: string; name: string } | null> {
  if (!cwd) return null
  const started = Date.now()
  const platform = ctx.platform
  const exec = (ctx as OpContext).exec
  if (platform && typeof platform.resolveExecutable === 'function' && exec) {
    try {
      const exe = await platform.resolveExecutable('git')
      if (exe) {
        const res = await exec('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { cwd, timeout: FORGEJO_REPO_GIT_TIMEOUT_MS })
        const bag = res as unknown as Record<string, unknown>
        const out = String((bag && bag['stdout']) || (bag && bag['text']) || '')
        const repo = parseForgejoRemote(out)
        if (repo) {
          emitRepoTier(ctx, 1, true, started)
          return { owner: repo.owner, name: repo.name }
        }
      }
    } catch { /* 这一层没给出答案，往下走 */ }
  }
  emitRepoTier(ctx, 1, false, started)

  const config = await readWorkspaceFile((ctx as OpContext).fs, cwd, '.git/config')
  if (config) {
    for (const url of remoteUrlsOfGitConfig(config)) {
      const repo = parseForgejoRemote(url)
      if (repo) {
        emitRepoTier(ctx, 2, true, started)
        return { owner: repo.owner, name: repo.name }
      }
    }
  }
  emitRepoTier(ctx, 2, false, started)

  const view = await fjClient(ctx).run(['repo', 'view'], { cwd, timeout: FORGEJO_PROBE_TIMEOUT_MS })
  const parsed = parseRepoView(view.stdout || '')
  const names = parsed ? splitRefId(parsed.refId) : null
  if (names) {
    emitRepoTier(ctx, 3, true, started)
    return { owner: names.owner, name: names.name }
  }
  emitRepoTier(ctx, 3, false, started)
  emitReadDegraded(ctx, 'repoKey', 'repoKey:unknown', Date.now() - started)
  return null
}

/** 同步版本的仓库身份（`describe` 用）：只用句柄与已学到的远端，不起进程。 */
export function describeForgejo(
  handle: RepoHandle | Partial<RepositoryRef> | null | undefined,
  backendId: string,
): RepositoryRef {
  const direct = repoOfHandle(handle)
  const refId = direct ? direct.refId : (handle && typeof handle.refId === 'string' ? handle.refId : '')
  const cwd = handle && typeof (handle as RepoHandle).cwd === 'string' ? (handle as RepoHandle).cwd : ''
  const name = refId || (cwd ? cwd.split(/[\\/]/).filter((part: string) => part !== '').pop() || '' : '') || backendId
  const host = direct ? direct.host : undefined
  const url = host && refId ? host + '/' + refId : ''
  const out: RepositoryRef = { backend: backendId, refId, name, url }
  if (host) out.host = host
  return out
}

/** 一张票的网页地址：`<origin>/<owner>/<name>/issues/<key>`；缺 origin 或 refId 时回空串。 */
export function issueAddressOf(ref: RepositoryRef | null | undefined, key: string): string {
  if (!ref || typeof ref.refId !== 'string' || !ref.refId) return ''
  let origin = typeof ref.host === 'string' ? ref.host : ''
  if (!origin && typeof ref.url === 'string') {
    const match = /^(https?:\/\/[^/]+)/.exec(ref.url)
    if (match) origin = match[1]
  }
  if (!origin) return ''
  return origin.replace(/\/+$/, '') + '/' + ref.refId.replace(/^\/+|\/+$/g, '') + '/issues/' + String(key)
}

/**
 * 这个工作区是不是 Forgejo。
 *
 * 判据与另外两间房同一套：只认「远端地址指向一台已登录的 Forgejo 实例」这一条硬证据，
 * 不拿正文里出现 `forgejo` 字样当认领。声明文件是第二条硬证据（`# Issue tracker: Forgejo`）。
 * 都不成立就回 false —— 不确定时不许认领，否则会把 GitHub / GitLab 的工作区拉进多命中。
 */
export async function matchesForgejo(
  handle: RepoHandle | Partial<RepositoryRef> | null | undefined,
  ctx: RepoCtx,
): Promise<boolean> {
  const cwd = handle && typeof (handle as RepoHandle).cwd === 'string' ? (handle as RepoHandle).cwd : (ctx as OpContext).cwd
  const started = Date.now()
  try {
    if (!cwd) return false

    const config = await readWorkspaceFile((ctx as OpContext).fs, cwd, '.git/config')
    if (config === null) {
      emitReadDegraded(ctx, 'matches', 'matches:git-config', Date.now() - started)
    } else {
      const hosts = await authenticatedHosts(ctx)
      for (const url of remoteUrlsOfGitConfig(config)) {
        const repo = parseForgejoRemote(url)
        if (repo && hosts.indexOf(repo.hostKey) >= 0) return true
      }
    }

    const doc = await readWorkspaceFile((ctx as OpContext).fs, cwd, 'docs/agents/issue-tracker.md')
    if (doc === null) {
      emitReadDegraded(ctx, 'matches', 'matches:tracker-doc', Date.now() - started)
    } else {
      const parsed = parseIssueTracker(normalizeTrackerText(doc))
      if (parsed.confidence === 'high' && parsed.explicitBackendId === 'forgejo') return true
    }

    const platform = ctx.platform
    const exec = (ctx as OpContext).exec
    if (platform && typeof platform.resolveExecutable === 'function' && exec) {
      try {
        const exe = await platform.resolveExecutable('git')
        if (exe) {
          const res = await exec('git', ['remote', 'get-url', 'origin'], { cwd, timeout: FORGEJO_FALLBACK_TIMEOUT_MS })
          const bag = res as unknown as Record<string, unknown>
          const out = String((bag && bag['stdout']) || (bag && bag['text']) || '')
          const repo = parseForgejoRemote(out)
          if (repo) {
            const hosts = await authenticatedHosts(ctx)
            if (hosts.indexOf(repo.hostKey) >= 0) return true
          }
        }
      } catch { /* 兜底这一层没答案，按不认领 */ }
    }
    return false
  } catch {
    emitReadDegraded(ctx, 'matches', 'matches:unknown', Date.now() - started)
    return false
  }
}
