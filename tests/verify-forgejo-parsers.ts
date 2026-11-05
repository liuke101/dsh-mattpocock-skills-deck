/**
 * tests/verify-forgejo-parsers.ts —— Forgejo 房间的文本解析器对实测输出逐字段核对。
 *
 * 为什么要这一扇门禁：Forgejo 后端没有 JSON 出口（`fj` 0.7.0 只有人类可读输出），
 * 这一间房的每一条读路径都建在 `src/tracker/rooms/forgejo/text.ts` 的解析器上。
 * 解析器认错一个字段，界面上不会报错，只会安静地显示错值——这类错只能靠夹具钉住。
 *
 * 夹具 `tests/fixtures/forgejo/*.txt` 是 2026-11-05 在本地 Forgejo（17.0.1）上
 * 用 `fj v0.7.0` 的真实输出采样后去掉人名与主机名得到的；格式变了先换夹具，再改解析器。
 *
 * 运行：node --import ./scripts/ts-hook.mts tests/verify-forgejo-parsers.ts
 *
 * 门禁归属: src/tracker/rooms/forgejo/text.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeHost,
  parseAssignees,
  parseAuthHosts,
  parseComments,
  parseCreatedKey,
  parseDependencyRows,
  parseIssueView,
  parseLabels,
  parseRepoView,
  parseSearchPage,
  parseSearchRows,
  parseWhoAmI,
  stripAnsi,
} from '../src/tracker/rooms/forgejo/text.ts'
import { planGates } from '../scripts/lib/discover-gates.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'forgejo')

let failed = false
const check = (ok: boolean, msg: string) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + msg)
  if (!ok) failed = true
}
const fixture = (name: string): string => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

async function main(): Promise<void> {
  console.log('== ① 搜索结果：分页头与行 ==')
  {
    const page = parseSearchPage(fixture('search-page1.txt'))
    check(page !== null, '分页头认得出')
    check(page?.page === 1 && page?.pages === 2 && page?.total === 26, '分页头三格是 1 / 2 / 26（实得 ' + JSON.stringify(page) + '）')

    const all = parseSearchPage(fixture('search-all.txt'))
    check(all?.page === 1 && all?.pages === 1 && all?.total === 3, '`--all` 的无分页头按 1 / 1 / 3 读')

    const rows = parseSearchRows(fixture('search-all.txt'))
    check(rows.length === 3, '三行票都读出来（实得 ' + rows.length + '）')
    check(rows[0].key === '3' && rows[0].title === 'Third closed issue' && rows[0].author === 'alice', '第一行编号、标题、作者都对（实得 ' + JSON.stringify(rows[0]) + '）')

    const open = parseSearchPage(fixture('search-open.txt'))
    const closed = parseSearchPage(fixture('search-closed.txt'))
    check(open?.total === 2 && closed?.total === 1, '按状态筛的两个头分别读成 2 与 1')
  }

  console.log('\n== ② 单票视图：标题、状态、标签、正文、评论数 ==')
  {
    const issue = parseIssueView(fixture('view-open.txt'))
    check(issue !== null, '开放票认得出')
    check(issue?.key === '1', '编号是 1（实得 ' + issue?.key + '）')
    check(issue?.title === 'First probe issue', '标题末尾的模板引号被剥掉（实得 ' + JSON.stringify(issue?.title) + '）')
    check(issue?.state === 'open', '状态是 open')
    check(issue?.author === 'alice', '作者是 alice')
    check(JSON.stringify(issue?.labels) === JSON.stringify(['bug', 'wayfinder:map']), '两个标签按出现顺序读出来（实得 ' + JSON.stringify(issue?.labels) + '）')
    check(issue?.body.startsWith('First paragraph.\n\n## Acceptance'), '正文剥掉一层引用前缀（实得 ' + JSON.stringify(issue?.body.slice(0, 40)) + '）')
    check(issue?.body.includes('\n- one\n- two\n'), '正文里的空行与列表行保持原样')
    check(issue?.commentCount === 1, '评论数是 1')

    const closed = parseIssueView(fixture('view-closed.txt'))
    check(closed?.state === 'closed', '关闭票的状态是 closed')
    check(closed?.labels.length === 0, '没有标签时标签是空数组')
    check(closed?.commentCount === 0, '没有评论时评论数是 0')
  }

  console.log('\n== ③ 评论：显示名、登录名、正文 ==')
  {
    const comments = parseComments(fixture('comments.txt'))
    check(comments.length === 2, '两条评论都读出来（实得 ' + comments.length + '）')
    check(comments[0]?.name === 'Alice' && comments[0]?.login === 'alice', '第一条的显示名与登录名对')
    check(comments[0]?.body === 'A comment body\n\nwith two paragraphs.', '第一条正文的空行保留（实得 ' + JSON.stringify(comments[0]?.body) + '）')
    check(comments[1]?.body === 'Second comment', '第二条正文对')
    check(parseComments('').length === 0, '没有评论输出时回空数组')
  }

  console.log('\n== ④ 指派人 ==')
  {
    const assignees = parseAssignees(fixture('assignees.txt'))
    check(assignees.length === 1, '一个指派人读出来（实得 ' + assignees.length + '）')
    check(assignees[0]?.login === 'alice' && assignees[0]?.name === 'Alice', '登录名与显示名对')
    check(parseAssignees('No one is assigned.\n').length === 0, '「没人指派」回空数组')
  }

  console.log('\n== ⑤ 标签：名字、id、颜色、说明 ==')
  {
    const labels = parseLabels(fixture('labels.txt'))
    check(labels.length === 3, '三个标签都读出来（实得 ' + labels.length + '）')
    const byName = new Map(labels.map((label) => [label.name, label]))
    check(byName.get('bug')?.id === '49' && byName.get('bug')?.color === 'ff0000', 'bug 的 id 与颜色对（实得 ' + JSON.stringify(byName.get('bug')) + '）')
    check(byName.get('bug')?.description === 'Bug report', 'bug 的说明对')
    check(byName.get('wayfinder:map')?.color === '8b5cf6', '带冒号的名字与颜色都能读出来')
    check(byName.get('wayfinder:map')?.description === '', '「(no description)」读成空说明，不把提示语当说明')
  }

  console.log('\n== ⑥ 依赖与阻塞清单 ==')
  {
    const depend = parseDependencyRows(fixture('depend.txt'))
    check(depend.length === 1 && depend[0].key === '1' && depend[0].state === 'open', '依赖行读出编号、标题与状态')
    const block = parseDependencyRows(fixture('block.txt'))
    check(block.length === 1 && block[0].key === '2', '阻塞行读出反向关系')
    check(parseDependencyRows('No dependencies.\n').length === 0, '「没有依赖」回空数组')
  }

  console.log('\n== ⑦ 身份与仓库信息 ==')
  {
    const who = parseWhoAmI(fixture('whoami.txt'))
    check(who?.login === 'alice' && who?.host === 'forgejo.example.com', 'whoami 的登录名与主机对')
    const repo = parseRepoView(fixture('repo.txt'))
    check(repo?.refId === 'acme/probe', '仓库坐标对')
    check(repo?.description === 'throwaway probe', '仓库简介对')
    check(repo?.url === 'http://forgejo.example.com/acme/probe', '网页地址对')
    const hosts = parseAuthHosts(fixture('auth.txt'))
    check(hosts.length === 1 && hosts[0] === 'forgejo.example.com', '已登录主机读得出来')
    check(parseCreatedKey('created issue #17: Some title') === '17', '建票回执里的编号读得出来')
    check(parseCreatedKey('nothing here') === null, '没有建票回执时回 null，不猜')
  }

  console.log('\n== ⑧ 主机名归一与颜色剥离 ==')
  {
    check(normalizeHost('https://Forgejo.Example.com/acme/probe.git') === 'forgejo.example.com', '协议、大小写、路径与端口都不影响主机比较')
    check(normalizeHost('ssh://git@forgejo.example.com:2222/acme/probe') === 'forgejo.example.com', 'ssh 地址与自定义端口也能归一')
    check(stripAnsi('\x1b[48;2;1;2;3m x') === ' x', '颜色码被剥掉，可见文字留下')
  }

  // ── 本门禁必须在 verify 链里（不挂进链就等于没跑）──
  {
    const mine = planGates(ROOT).filter((step: { file: string }) => step.file.indexOf('verify-forgejo-parsers') >= 0)
    check(mine.length === 1, '本门禁挂在 verify 链里且只挂一次（实得 ' + mine.length + ' 次）')
  }

  console.log('\nverify-forgejo-parsers: ' + (failed ? '有失败项' : '全部通过'))
  if (failed) process.exit(1)
  console.log('FORGEJO PARSERS OK')
}

main().catch((e) => {
  console.log('  FAIL 门禁抛错：' + String((e && (e as Error).message) || e))
  process.exit(1)
})
