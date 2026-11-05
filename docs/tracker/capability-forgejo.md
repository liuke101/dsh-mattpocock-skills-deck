# Forgejo 后端能力登记表

`#1875` 的交付物（2026-11-05）。登记口径同 GitHub、GitLab 那两份：**明确提供功能**——今天就能干活且有调用方在用；**明确不支持**——形态不合、永远不会有；**做了但没做到位**——有实现，但有某几种输入或承诺对不上；**当前不支持、未来会开发**——说得通、今天没做。一条一条审过实现才落笔，不估。

实现真源：`src/tracker/rooms/forgejo/index.ts`（工厂成员由 `capability-register.ts` 推出来）。这一家的路只有一条：所有远端读写都经 `fj`（forgejo-cli 0.7.0）起进程，没有任何直接调 REST 的旁路。今天 **27 条 = 14 条明确提供功能、9 条做了但没做到位、3 条当前不支持、未来会开发、1 条明确不支持**。

实测环境是自建 Forgejo 17.0.1 + forgejo-cli 0.7.0（2026-11-05），样本收在 `tests/fixtures/forgejo/`。三件必须记住的事：`fj` 没有 `--json`，所有读都是文本解析；它不打印时间戳与关闭原因；去标签与去依赖两个接口在 17.0.1 上会重置连接（`os error 104`），加是正常的。

## 操作（24 条中：11 条明确提供功能、9 条做了但没做到位、3 条当前不支持、未来会开发、1 条明确不支持）

| 能力 | 登记 | 依据 |
|---|---|---|
| preflight | 明确提供功能 | `preflight.ts`，三关：`fj version` → `fj auth list` → `fj repo view`；每关都如实区分「没装 / 没登录 / 仓库不可达 / 网络失败」 |
| list | 做了但没做到位 | `issues.ts` + `search.ts`，`fj issue search` 的行只有编号、标题、作者；正文、指派人、时间读不到，标签靠逐标签搜索另补 |
| get | 做了但没做到位 | `issues.ts` + `text.ts`，详情读得到标题、状态、作者、标签、正文、评论、指派人、原生依赖；`fj` 不打印创建时间、更新时间和关闭原因 |
| getDependencies | 明确提供功能 | `graph.ts`，原生 `depend list` 与 `block list` 两向都读，缺一边会标明 |
| create | 做了但没做到位 | `write-issues.ts`，建票后补写标签与指派人；幂等锚回查依赖全文搜索，实例关闭搜索索引时可能落空 |
| close | 明确提供功能 | `write-issues.ts`，`fj issue close` 后读回票面 |
| reopen | 当前不支持、未来会开发 | `fj` 0.7.0 没有 reopen 子命令；平台本身支持重开，等 CLI 补命令后接上（承接票 `#1875`） |
| comment | 明确提供功能 | `writes.ts`，`fj issue comment <票号> <正文>`（正文是位置参数，没有 `--body` 开关），作者取 `fj whoami` |
| update | 做了但没做到位 | `write-issues.ts`，标题、正文、里程碑是三条独立命令，不是原子写；中途失败时前面的字段已经落盘 |
| setLabels | 做了但没做到位 | `writes.ts`，加标签正常；去标签在 Forgejo 17.0.1 + fj 0.7.0 上会重置连接；`expectedUpdatedAt` 无法比对，因为没有可读的更新时间 |
| setAssignees | 明确提供功能 | `writes.ts`，`issue assign` / `issue unassign` 按最终集合增删 |
| setParent | 明确提供功能 | `writes.ts`，父子边落在正文文件头的隐藏标记 `<!-- DSH-PARENT: <地图> -->`（`fj` 没有原生的父级命令）；写后读回核对，旧 `Part of #n` 可见行过渡期回退认 |
| setBlockedBy | 做了但没做到位 | `writes.ts`，加依赖正常；去依赖会重置连接（与去标签同源）。自环与成环在写之前就拦下 |
| counts | 明确提供功能 | `counts.ts`，读搜索回包头部的总数；多标签时逐个枚举再取合计 |
| listPage | 做了但没做到位 | `counts.ts`，没有时间戳，排序退回 Forgejo 搜索顺序；不筛状态时开着的一批排在关着的一批前面，不是跨状态的时间序 |
| listLabels | 明确提供功能 | `labels.ts`，`fj repo labels <仓库> view`；同名标签逐条去重 |
| setLabelColors | 明确提供功能 | `labels.ts`，`fj repo labels <仓库> edit <标签 id> -c <颜色>`，先精确后忽略大小写匹配，逐条记账 |
| getCurrentUser | 明确提供功能 | `identity-ops.ts`，`fj whoami` 只给登录名；显示名与头像 CLI 不提供 |
| getRepoPermissions | 当前不支持、未来会开发 | `fj` 0.7.0 没有查询仓库权限的命令；问不出来就按未知处理，不捏造（承接票 `#1875`） |
| listSubIssues | 做了但没做到位 | `graph.ts`，先按标记文本搜索召回候选，再逐张读票面确认父标记；候选超过 200 张或搜索翻页到顶时记 capped，总数只能等于本次确认的条数 |
| initProject | 当前不支持、未来会开发 | `fj repo create` 存在，但建仓、初始化本地 git、提交、推送这一整条发布流程本轮没落地（承接票 `#1875`） |
| ensureLabelColorsFile | 明确不支持 | 这条能力承诺「放一份用户可以手改、改了就生效的标签配色文件」。Forgejo 的颜色真源是远端仓库标签，工作区里那份文件没有读者，手改也不会影响颜色，形态不合。要读颜色用 `listLabels`，要改颜色用 `setLabelColors`。理由与 GitHub / GitLab 两家同一条 |
| readBudget | 明确提供功能 | `budget.ts`，Forgejo 没有限额接口、`fj` 也不打印剩余额度，读数固定回「没量过」（`not-measured`），不回 0、不编数 |
| listMaps | 做了但没做到位 | `counts.ts`，地图票按 `wayfinder:map` 标签筛（开着关着两批分别搜）；没有时间戳，无法按更新时间倒序，返回的是 Forgejo 搜索顺序 |

## 定位口（3 条全部提供）

| 能力 | 登记 | 依据 |
|---|---|---|
| getRepoKey | 明确提供功能 | `repo.ts`，三层兜底：git remote → `.git/config` → `fj repo view`；同时认出实例域名 |
| describe | 明确提供功能 | `index.ts` 内联，refId 含 `/` 且认得出实例域名时拼出仓库地址 |
| issueAddress | 明确提供功能 | `index.ts` 内联，拼 `<实例>/<owner>/<repo>/issues/<n>` 地址 |

## 与另外两家不一样的地方

- **列表是薄的。** `fj issue search` 只回编号、标题、作者三格；正文、指派人、时间、关闭原因都没有。列表页因此只够画一行，规格票在列表里会被读成普通票（类型不是从标题推出来的，是靠 `wayfinder:map` 标签与票面里的类型标记）。要完整信息必须逐张 `get`。
- **父子边不是原生的。** `fj` 0.7.0 没有「设置父票」的命令，归属写在子票正文文件头的隐藏标记里；`listSubIssues` 靠全文搜索找出带标记的候选，再逐张读票面确认。别把它说成 Forgejo 的原生层级。
- **写操作的失败面是真的。** 去标签与去依赖在 17.0.1 上会让连接被重置。这不是插件的问题，也不是网络抖动；`setLabels` 与 `setBlockedBy` 因此登记成「做了但没做到位」，而不是假装成功。
- **没有额度可观。** Forgejo 的 REST 接口没有限额响应头，`fj` 也不打印额度；读数固定是「没量过」。这不等于「额度无限」，只是插件量不到。

## 变更

- 2026-11-05（`#1875` 首次交付）：新建本表。27 条里 14 条明确提供功能、9 条做了但没做到位、3 条当前不支持、未来会开发、1 条明确不支持。`list`、`get`、`create`、`update`、`setLabels`、`setBlockedBy`、`listPage`、`listSubIssues`、`listMaps` 的缺口都逐条写在表里；`reopen`、`getRepoPermissions`、`initProject` 由 `#1875` 继续承接。

## 交接

接手这一房的人先读 `src/tracker/rooms/forgejo/README.md`：那一份写的是这一房与另外两家不一样的地方，以及哪些缺口是 `fj` 本身没有、哪些是平台接口坏了。本表与 `src/tracker/rooms/forgejo/capability-register.ts` 逐条对齐，改表要同时改数据，门禁会抓。
