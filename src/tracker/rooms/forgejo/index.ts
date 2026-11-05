/**
 * src/tracker/rooms/forgejo/index.ts —— Forgejo 后端的装配点：把房内各件拼成注册表认的模块。
 *
 * 这一间房只经 `fj`（forgejo-cli）读写，不直连 HTTP API，也不读凭据文件。`fj` 的能力边界
 * 决定了房内的分工：
 *
 *  - `text.ts` 把人类可读输出翻成结构（`fj` 没有 `--json`），
 *  - `repo.ts` 认出「哪台实例上的哪个仓库」（Forgejo 是自建软件，仓库坐标必须带实例地址），
 *  - `issues.ts` / `writes.ts` / `graph.ts` / `counts.ts` 是读写主路，
 *  - `capability-register.ts` 是这一家的能力账，`docs/tracker/capability-forgejo.md` 是它的视图。
 *
 * 少实现的成员由注册表按名录补「我不支持」的桩；本文件不写能力表、不在运行时按能力分支。
 */

import type { BackendContext } from '../../contract/contexts.js'
import type { BackendModule } from '../../contract/backend-module.js'
import type { RepositoryRef } from '../../contract/entities.js'
import type { Tracker } from '../../contract/operations.js'
import type {
  ProvidedCapability,
  PartiallyProvidedCapability,
} from '../../contract/capability-answer.js'
import { attachFjOpUsage } from './client.js'
import type { FORGEJO_CAPABILITY_REGISTER } from './capability-register.js'
import { fjPreflight } from './preflight.js'
import { describeForgejo, getRepoKey, issueAddressOf, matchesForgejo, repoOfHandle } from './repo.js'
import { listIssues, getIssue } from './issues.js'
import { createIssue, closeIssue, updateIssue } from './write-issues.js'
import { addComment, setLabels, setAssignees, setParent, setBlockedBy } from './writes.js'
import { getDependencies, listSubIssues } from './graph.js'
import { counts, listPage, listMaps } from './counts.js'
import { getCurrentUser } from './identity-ops.js'
import { readForgejoBudget } from './budget.js'
import { listLabels, setLabelColors } from './labels.js'

/** 这一家实例上应当出现的成员：`id` 加全部真提供与部分提供的能力。 */
export type ForgejoBackendMembers =
  | 'id'
  | (
      | ProvidedCapability<typeof FORGEJO_CAPABILITY_REGISTER>
      | PartiallyProvidedCapability<typeof FORGEJO_CAPABILITY_REGISTER>
    )

/** 成员集合与签名一起交给编译器核对（`capability-assertions.ts` 用它）。 */
export type ForgejoBackendShape = { [K in ForgejoBackendMembers]: Tracker[K] }

/**
 * 认领判定：只认「远端指向一台已登录的 Forgejo 实例」或声明文件里的显式选择，
 * 不在正文里找 `forgejo` 字样。判据的细节写在 `repo.ts` 的 `matchesForgejo`。
 */
async function matches(handle: unknown, ctx: unknown): Promise<boolean> {
  return matchesForgejo(
    handle as Parameters<typeof matchesForgejo>[0],
    ctx as Parameters<typeof matchesForgejo>[1],
  )
}

/** 仓库身份（同步；只用句柄里已有的坐标，不起进程）。 */
export function describe(handle: unknown, backendId?: string): RepositoryRef {
  return describeForgejo(handle as Parameters<typeof describeForgejo>[0], backendId || 'forgejo')
}

/** 一张票的网页地址：`<实例地址>/<owner>/<name>/issues/<key>`。 */
export function issueAddress(ref: Partial<RepositoryRef> | null | undefined, key: string | number): string {
  return issueAddressOf(ref as RepositoryRef | null | undefined, String(key))
}

/** 按名搜仓库：Forgejo 的仓库内搜索落在 issues 列表的 `q` 参数上。 */
export function repoSearchAddress(
  name: string | null | undefined,
  ref?: Partial<RepositoryRef> | null,
): string {
  const origin = ref && typeof ref.host === 'string' && ref.host
    ? ref.host.replace(/\/+$/, '')
    : ref && typeof ref.url === 'string'
      ? (/^(https?:\/\/[^/]+)/.exec(ref.url) || [])[1] || ''
      : ''
  const refId = ref && typeof ref.refId === 'string' ? ref.refId : ''
  if (!origin || !refId) return ''
  return origin + '/' + refId + '/issues?q=' + encodeURIComponent(String(name || ''))
}

/**
 * 认票的写法：任意主机上的 `/<owner>/<name>/issues/<号>`。
 * 故意不写死实例域名：Forgejo 是自建软件，域名由用户决定。
 */
export const issueRefPattern = /\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/g

/** 开仓方式：远程后端的仓库、票、容器都是网页，交给浏览器打开。 */
const openRepository = 'url'

/**
 * 创建 Forgejo 后端适配器。
 *
 * 交出来的成员由 `capability-register.ts` 推出：真提供与部分提供的那些，加上 `id`。
 * 少的三条（`reopen` / `getRepoPermissions` / `initProject`）由注册表补桩；
 * 配色文件那条按设计不支持，同样由注册表补。
 */
export function createForgejoBackend(ctx: BackendContext) {
  const backend = {
    id: 'forgejo',
    describe: (handle) => describe(handle, 'forgejo'),
    issueAddress: (ref, key) => issueAddress(ref, key),
    getRepoKey: (cwd, opCtx) => getRepoKey(cwd, opCtx || ctx),
    preflight: (handle, opCtx) => fjPreflight(handle, opCtx || ctx),
    list: (repo, filter, opCtx) => listIssues(repo, filter, opCtx || ctx),
    get: (repo, key, opts, opCtx) => getIssue(repo, key, opts, opCtx || ctx),
    getDependencies: (repo, key, opts, opCtx) => getDependencies(repo, key, opts, opCtx || ctx),
    create: (repo, input, opCtx) => createIssue(repo, input, opCtx || ctx),
    close: (repo, key, opts, opCtx) => closeIssue(repo, key, opts, opCtx || ctx),
    comment: (repo, key, body, opCtx) => addComment(repo, key, body, opCtx || ctx),
    update: (repo, key, patch, opCtx) => updateIssue(repo, key, patch, opCtx || ctx),
    setLabels: (repo, key, labels, opts, opCtx) => setLabels(repo, key, labels, opts, opCtx || ctx),
    setAssignees: (repo, key, assignees, opts, opCtx) => setAssignees(repo, key, assignees, opts, opCtx || ctx),
    setParent: (repo, key, parentKey, opts, opCtx) => setParent(repo, key, parentKey, opts, opCtx || ctx),
    setBlockedBy: (repo, key, blockers, opts, opCtx) => setBlockedBy(repo, key, blockers, opts, opCtx || ctx),
    counts: (repo, filter, opCtx) => counts(repo, filter, opCtx || ctx),
    listPage: (repo, filter, opts, opCtx) => listPage(repo, filter, opts, opCtx || ctx),
    listLabels: (repo, opCtx) => listLabels(repo, opCtx || ctx),
    setLabelColors: (repo, changes, opCtx) => setLabelColors(repo, changes, opCtx || ctx),
    getCurrentUser: (repo, opCtx) => getCurrentUser(repo, opCtx || ctx),
    listSubIssues: (repo, mapKey, opts, opCtx) => listSubIssues(repo, mapKey, opts, opCtx || ctx),
    listMaps: (repo, opCtx) => listMaps(repo, opCtx || ctx),
    readBudget: (opCtx) => readForgejoBudget(opCtx || ctx),
  } satisfies ForgejoBackendShape
  return attachFjOpUsage(backend)
}

/** 修复契约注入文案（Forgejo 后端，双语单源）。 */
export const prompts = {
  commandVocabulary: { cli: 'fj', cliBrand: 'Forgejo' },
  fjInstallFix: {
    zh: '请为 DSH 安装 Forgejo CLI（fj，forgejo-cli）。安装说明以它的上游仓库为准：https://codeberg.org/forgejo-contrib/forgejo-cli，按那一页的指引做，不要凭记忆写安装命令。\n1. 先检查：终端执行 fj version；有版本号就直接汇报已装版本，不要重复安装；\n2. 没有 fj 时，打开上面那一页，按你的系统对应的那一节装；那一页打不开就如实说打不开，不要编命令；\n3. 装完请用户点「重查」；如果重查仍说找不到，先用绝对路径跑一次 fj version 证明装好了，再请用户重启宿主（宿主只在启动时读 PATH）。',
    en: 'Install the Forgejo CLI (fj, forgejo-cli) for DSH. The upstream repository is the install guide: https://codeberg.org/forgejo-contrib/forgejo-cli — follow that page, do not write install commands from memory.\n1. Check first: fj version; if a version is reported, report it and do not reinstall;\n2. If missing, open the page above and follow the section for your OS; if the page cannot be opened, say so plainly and do not invent commands;\n3. After install, ask the user to re-check; if it still reports missing, prove the install with an absolute-path fj version, then ask the user to restart the host (the host reads PATH only at startup).',
  },
  fjLoginFix: {
    zh: '请完成 fj 登录：先跑 fj auth login，它会在浏览器里打开授权页，在页面上完成授权；如果这条走不通，就在实例的「设置 → 应用」里建一枚访问令牌，用 fj auth add-token -H <实例地址> 从标准输入喂进去（不要把令牌写在命令行参数里，那会留在记录中）。完成后用 fj auth list 确认这台实例在名单里，再请用户点「重查」。',
    en: 'Complete fj login: run fj auth login, which opens an authorization page in the browser; finish it there. If that path does not work, create an access token in the instance settings (Applications) and feed it to fj auth add-token -H <instance> on standard input (never as a command-line argument, which stays in the record). Then verify the host appears in fj auth list and ask the user to re-check.',
  },
  cliInstall: {
    zh: '请为 DSH 安装 Forgejo CLI（fj，forgejo-cli）。安装说明以它的上游仓库为准：https://codeberg.org/forgejo-contrib/forgejo-cli，按那一页的指引做，不要凭记忆写安装命令。\n1. 先检查：终端执行 fj version；有版本号就直接汇报已装版本，不要重复安装；\n2. 没有 fj 时，打开上面那一页，按你的系统对应的那一节装；那一页打不开就如实说打不开，不要编命令；\n3. 装完请用户点「重查」；如果重查仍说找不到，先用绝对路径跑一次 fj version 证明装好了，再请用户重启宿主（宿主只在启动时读 PATH）。',
    en: 'Install the Forgejo CLI (fj, forgejo-cli) for DSH. The upstream repository is the install guide: https://codeberg.org/forgejo-contrib/forgejo-cli — follow that page, do not write install commands from memory.\n1. Check first: fj version; if a version is reported, report it and do not reinstall;\n2. If missing, open the page above and follow the section for your OS; if the page cannot be opened, say so plainly and do not invent commands;\n3. After install, ask the user to re-check; if it still reports missing, prove the install with an absolute-path fj version, then ask the user to restart the host (the host reads PATH only at startup).',
  },
  cliLogin: {
    zh: '请完成 fj 登录：先跑 fj auth login，它会在浏览器里打开授权页，在页面上完成授权；如果这条走不通，就在实例的「设置 → 应用」里建一枚访问令牌，用 fj auth add-token -H <实例地址> 从标准输入喂进去（不要把令牌写在命令行参数里，那会留在记录中）。完成后用 fj auth list 确认这台实例在名单里，再请用户点「重查」。',
    en: 'Complete fj login: run fj auth login, which opens an authorization page in the browser; finish it there. If that path does not work, create an access token in the instance settings (Applications) and feed it to fj auth add-token -H <instance> on standard input (never as a command-line argument, which stays in the record). Then verify the host appears in fj auth list and ask the user to re-check.',
  },
  fjRepoFix: {
    zh: '当前工作区未解析出 Forgejo 仓库。请先向用户确认意图：\nA. 本地项目（不需要 Forgejo）→ 切换到「本地 Markdown」后端；\nB. 确实要用 Forgejo → 核对 remote 指向（git remote get-url origin 应指向你的实例），或在网页上建好仓库后把 remote 指过去；\n完成后请用户点「重查」。',
    en: 'No Forgejo repository resolved for this workspace. Confirm intent: A. local project → switch to "Local Markdown"; B. Forgejo really wanted → verify the remote (git remote get-url origin should point at your instance), or create the repo on the web and point the remote at it; then ask the user to re-check.',
  },
  healthCheck: {
    zh: '**游离的开放票**在这条后端上的落地口径：这张票**没有关闭**、**自己不是地图**、**不在任何地图的子票里** —— 与另外两条远端后端同一套。\n\n**动手时只做两件结构动作**，都走工具：\n1. 建边，把票挂到合适的地图下：deck_map_link 的 parentKey（Forgejo 没有原生父子边，归属落在票正文文件头的隐藏标记）；\n2. 为人点过头的票开一张新地图：deck_map_plan_create 先写最小的 Destination 草稿。\n\n**本后端做不到的地方，如实写出来**：fj 不打印更新时间，父子边只能落在正文隐藏标记里；动手之前先量一次解析率，量与不出来的原因都写进报告，**不要硬来**。\n\n**不碰**：已关闭的票、任何票的标题与正文、标签与认领状态、别的仓库；不关票、不删评论、不改源码、不发版、不提交。',
    en: '**How "orphaned open ticket" lands on this backend**: the ticket is **not closed**, it is **not itself a map**, and it is **not inside any map as a sub-ticket** — the same rules as the other remote backends.\n\n**When acting, only two structural actions**, both through the tools:\n1. Wire the edge that attaches the ticket under a suitable map: deck_map_link with parentKey (Forgejo has no native parent edge; the relation lands as a hidden marker in the ticket body header);\n2. Open a new map for a ticket the human has nodded on: deck_map_plan_create, writing only the minimal Destination draft.\n\n**State plainly what this backend cannot do**: fj prints no update timestamps, and the parent edge can only live in a hidden body marker; measure the resolution rate once before acting, write both the measurement and any reason it fails into the report, and **do not force it**.\n\n**Never touch**: closed tickets, any ticket title or body, labels and claim state, other repositories; do not close tickets, delete comments, change source code, publish a release, or commit.',
  },
}

/** 修复契约（检查失败 → 修复指引）。 */
export const fixes = Object.freeze({
  'fj:installed': {
    hint: {
      zh: 'fj（Forgejo CLI）未安装。点「安装指引」按上游仓库安装，完成后重查。',
      en: 'fj (Forgejo CLI) is not installed. Use the install guide, then re-check.',
    },
    actions: [
      { type: 'inject-prompt', prompt: 'fjInstallFix', label: { zh: '安装指引', en: 'Install guide' } },
      { type: 'refresh', target: 'chain' },
    ],
  },
  'fj:authed': {
    hint: {
      zh: 'fj 尚未登录。点「登录指引」注入 fj auth login 操作步骤，完成后重查。',
      en: 'fj is not logged in. Use the login guide, then re-check.',
    },
    actions: [
      { type: 'inject-prompt', prompt: 'fjLoginFix', label: { zh: '登录指引', en: 'Login guide' } },
      { type: 'refresh', target: 'chain' },
    ],
  },
  'fj:repoAccess': {
    hint: {
      zh: '此目录未关联 Forgejo 仓库。核对 git remote 是否指向你的实例，或在网页上建好仓库后把 remote 指过去，再重查。',
      en: 'This directory is not linked to a Forgejo repo. Check that git remote points at your instance, or create the repo on the web and point the remote at it, then re-check.',
    },
    actions: [
      { type: 'inject-prompt', prompt: 'fjRepoFix', label: { zh: '仓库指引', en: 'Repository guide' } },
      { type: 'refresh', target: 'chain' },
    ],
  },
})

/** BackendModule（注册表可插拔）。 */
export const forgejoBackend = {
  id: 'forgejo',
  label: 'Forgejo',
  setupPrompt: {
    trackerLine: 'setup.forgejo.trackerLine',
    trackerChoice: 'setup.forgejo.trackerChoice',
    backendNote: 'setup.forgejo.backendNote',
    labelReqs: 'setup.forgejo.labelReqs',
  },
  describe,
  issueAddress,
  repoSearchAddress,
  issueRefPattern,
  openRepository,
  openIssue: 'url',
  openContainer: 'url',
  presentation: {
    color: '#ff6600',
    darkColor: '#ffa04d',
    bg: 'light-dark(rgba(255,102,0,.12), rgba(255,160,77,.14))',
    border: 'light-dark(rgba(255,102,0,.25), rgba(255,160,77,.30))',
  },
  create: createForgejoBackend,
  matches,
  budget: { kind: 'requests-only', countsRequests: true, countsPoints: false, independentBuckets: false },
  prompts,
  fixes,
} satisfies BackendModule

export default createForgejoBackend

/** 供房外做类型核对用的仓库坐标 helper（不对外当操作）。 */
export { repoOfHandle }
