# Forgejo 房（后端房间）交接说明

这份文件写给「以后要改这一房的人」。房间的通用规矩在上一级的 `src/tracker/rooms/README.md`，契约层的书面承诺在 `src/tracker/contract/README.md`，这里不重复。**这一份只讲这一家与 GitHub、GitLab、本地 Markdown 不一样的地方**。

能力账在 `docs/tracker/capability-forgejo.md`（27 条逐条登记：哪条真提供、哪条有缺口、哪条欠账、哪条按设计不做）。程序侧的同一份答案是 `capability-register.ts`，两边由门禁 `tests/verify-capability-register.ts` 逐条比对。

用户第一次配 Forgejo（装 `fj`、登录、准备一个仓库）时，把同目录的 `SETUP-PROMPT.md` 整段贴进对话框。那一份写给用户，与改这一房的代码无关。

## 一、这一家最要紧的几条不同

### 1. `fj` 只有文本输出，没有 `--json`

`fj`（forgejo-cli）0.7.0 没有结构化输出开关，`--style fancy|minimal` 只控制颜色与字符，不改变数据形状。所以这一间房的每条读路径都在解析人类可读文本。解析集中在 `text.ts`：它只把文本翻成结构，不判断业务、不发日志、不抛异常，认不出就回 `null` 或空数组，由调用方按「这一趟没读到」处理。

解析只认实测过的英文模板，样本在 `tests/fixtures/forgejo/`。`fj` 的界面文案会跟随系统语言，换到德语等界面后这里会认不出来；调用方会如实报读不到，而不是猜一个错值。要支持别的界面语言，先补这一类输出的夹具，再改 `text.ts`。

另一个必须记住的事实：`fj` 的失败经常仍然返回退出码 0，错误只打在文本里。只看退出码分不出这一趟读成没成，所以每次「文本认不出 / 命令没跑成 / 拿不全」都要在 `read-log.ts` 落一行。

### 2. 仓库坐标必须带实例地址

Forgejo 是自建软件，没有唯一的默认域名。同一个 `owner/name` 可以同时存在于好几台实例上，所以 `RepositoryRef` 多出一格 `host`，`-H` 参数与网页地址都从它来。

`repo.ts` 只认 git 记下的远端地址（`.git/config` 的 `[remote ...]` 段），认四种写法：`http(s)://host/owner/name.git`、`ssh://git@host/owner/name.git`、`git@host:owner/name.git`、`host:owner/name`。认不出来一律回 `null`，不猜一个默认实例，也不在整份 config 文本里找 `forgejo` 字样。

`fj` 自己选仓库时按远端名字母序取第一个，一个工作区有多个远端时会选错。所以调用方必须显式给仓库：支持 `-r owner/name` 的命令用 `-r`，不支持的命令用 `-R <远端名>`。客户端不替调用方猜。

### 3. 列表行是薄的

`fj issue search` 是唯一的列表入口，一行只有编号、标题、作者。正文、标签、指派人、时间都不在搜索结果里。要这些东西只能再跑 `fj issue view`，一张票一个进程。所以：

- 列表行天然不完整，`normalize.ts` 对没有的字段**不写**（省略表示不知道），不拿空串冒充。
- 标签由 `labels.ts` 按「一个标签搜一次」补出来，结果缓存 2 分钟；过期后拿不到新结果不算失败，按「这一拍没有标签」处理并记一行 `read.degraded`。
- 不筛状态时要把开、关两份搜索结果拼起来。每张票的状态只有「从哪一份结果里读到的」这一条证据，所以拼接顺序是开着的一批在前、关着的一批在后，不是跨状态的时间序。
- 搜索结果没有时间戳，`listPage` 与 `listMaps` 承诺的时间排序做不到，退回 Forgejo 自己的搜索顺序。这一条登记为 `partial`，不要假装排过。

### 4. 归属落在正文文件头的隐藏标记，依赖边用原生命令

Forgejo 平台与 `fj` 都没有「父票」这个概念。归属因此落在票正文文件头的隐藏标记 `<!-- DSH-PARENT: <地图号> -->` 里，渲染后看不见，读回来还是原文；只认第一个标题之前那一段，正文中间手写的同一句话不算。找子票时先按标记文本搜一遍，再逐张读票面确认编号对得上：搜索只是召回，逐张读才是判据。

阻塞边有原生命令（`fj issue depend list` / `block list`），读回来直接是票号列表。写侧的加边正常，**去边在 Forgejo 17.0.1 上会重置连接**（`os error 104`），所以去标签与去依赖都不保证成功，登记为 `partial`。自环与成环在写之前就拦下，一条命令都不发。

### 5. 标签颜色只认终端背景色，同名标签允许存在

`fj repo labels <owner/name> view` 用终端背景色表示颜色，解析在 `text.ts`。改色走 `fj repo labels <owner/name> edit <标签编号> -c <颜色>`，颜色只收六位十六进制，带不带井号都行。

同名标签在 Forgejo 上是允许的（重复建标签不会被拦）。契约按名字定位颜色，本房找不到唯一的那一条时不猜，把这一条记进 `failed`。按标签名搜索成员时，同名标签可能只命中其中一个编号，于是列表行会少显示一条标签；这是远端数据本身分不清名字，本地不猜是哪一条。`ensureLabelColorsFile` 在本房形态不合：颜色真源是远端仓库的标签，工作区里那份文件没有读者，登记为明确不支持。

### 6. 欠账与额度：不假装量过

`fj` 0.7.0 没有 `issue reopen`、没有查仓库成员角色的命令、也没有建项目（里程碑之外的项目容器）的命令。这三条登记为 `planned`，由注册表补「我不支持」的桩，调用方按未知处理，不许拿它当「不能写」去拦住用户。

额度读数只有一句诚实的答案：**没量过**（`not-measured`）。Forgejo 的 REST 接口没有限额响应头，`fj` 也不打印剩余额度；不回 0，也不编数字。记账口径照旧是「只计请求」，每一次真的起过 `fj` 进程的调用记一条请求。

## 二、房间里的两个唯一出口

改这一房之前先认准这两处，别在别的地方另开一个：

- **日志**：`read-log.ts`。读路径每一条「没读成」的分支都要在失败之前调 `emitReadDegraded`，探环境与识别档位另有 `emitPreflightGatePass` / `emitRepoTier`。事件名沿用全仓已登记的 `read.degraded`、`preflight.gate`、`repo.resolve.tier`，本房没有自己的 `fj.*` 事件名；`reason` 只能取 `READ_DEGRADED_REASONS` 里登记过的值。
- **错误判档**：`errors.ts` 的 `classifyFjError` / `failFj`。失败类别只在这里判一次，别的地方按结果写话，不自己写正则判第二遍。

## 三、文件一览

| 文件 | 管什么 |
|---|---|
| `index.ts` | 工厂：把各文件的操作拼成 `Tracker` 成员，并挂上能力登记表与修复契约 |
| `capability-register.ts` | 27 条能力的数据化回答（纯数据，不许有分支） |
| `client.ts` | 唯一跑 `fj` 的地方；超时、取消、回包归一到这一层 |
| `text.ts` | `fj` 文本 → 结构（纯函数） |
| `repo.ts` | 仓库坐标解析、`-H` 的目标、认领判定 |
| `preflight.ts` | 探本机环境（`fj` 装没装、登没登、仓库读不读得到） |
| `search.ts` | `fj issue search` 的翻页与整份读完 |
| `counts.ts` | 数票、按页取票、取全部地图薄行 |
| `issues.ts` | 列票与单票详情（读的主路） |
| `write-issues.ts` | 建票、关票、改票 |
| `writes.ts` | 评论、标签、指派人、归属、阻塞五种写 |
| `graph.ts` | 依赖边与「挂在某张地图下的票」 |
| `description-markers.ts` | 正文文件头里的归属与阻塞标记 |
| `labels.ts` | 仓库标签清单、列表行的标签补全、批量改色 |
| `normalize.ts` | `fj` 的行与票面 → 契约的 `Issue` |
| `provenance.ts` | 读结果的来源与完整度组装 |
| `identity-ops.ts` | 当前登录人；仓库权限问不出来就说问不出来 |
| `errors.ts` | 错误判档的唯一出口 |
| `read-log.ts` | 读路径降级与预检结论的日志出口 |
| `budget.ts` | 额度读数（诚实回答「没量过」） |

## 四、怎么验这一房

单扇门禁：

```
node --import ./scripts/ts-hook.mts tests/verify-forgejo-parsers.ts
node --import ./scripts/ts-hook.mts tests/verify-capability-register.ts
```

解析层的夹具在 `tests/fixtures/forgejo/`。改任何一条命令的输出形状之前，先把新样本放进夹具，再改 `text.ts`，让门禁先红后绿。改到 `tests/**`、`scripts/**`、`docs/**` 或任何 `*.md` 时要跑全链 `npm run verify:parallel`，档位规则见 `docs/agents/verification.md`。
