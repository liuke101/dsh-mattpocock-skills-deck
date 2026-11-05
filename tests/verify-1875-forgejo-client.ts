/**
 * tests/verify-1875-forgejo-client.ts —— Forgejo 房的进程出口与仓库定位。
 *
 * 为什么单独一扇：`fj` 的大多数命令只收 `-R <远端名>`，不收 `-r owner/name`。
 * 一个工作区有多个远端时，`fj` 自己按远端名字母序取第一个，可能操作到别的仓库。
 * 这一扇钉住两件事：
 *   ① 调用方给了远端名时，`fj` 的参数里必须出现 `-R`；调用方已经显式给了 `-r`/`-R` 时不重复。
 *   ② 从句柄解析仓库时，会把 `.git/config` 里指向同一仓库的远端名补到坐标上。
 *
 * 运行：node --import ./scripts/ts-hook.mts tests/verify-1875-forgejo-client.ts
 *
 * 门禁归属: src/tracker/rooms/forgejo/client.ts、src/tracker/rooms/forgejo/repo.ts
 */
import { isWriteFjArgs } from '../src/tracker/kernel/outbound-tiers.ts'
import { fjClient, repoOpts } from '../src/tracker/rooms/forgejo/client.ts'
import { resolveRepo } from '../src/tracker/rooms/forgejo/repo.ts'

const CONFIG = [
  '[remote "upstream"]',
  '\turl = https://fj.example/acme/other.git',
  '[remote "origin"]',
  '\turl = https://fj.example/acme/repo.git',
  '',
].join('\n')

let failed = false
let total = 0
const check = (ok: boolean, msg: string): void => {
  total += 1
  console.log((ok ? '  PASS ' : '  FAIL ') + msg)
  if (!ok) failed = true
}

function makeCtx(): { ctx: any; calls: Array<{ cmd: string; argv: string[] }> } {
  const calls: Array<{ cmd: string; argv: string[] }> = []
  const ctx = {
    cwd: '/ws',
    platform: { resolveExecutable: async (name: string) => (name === 'fj' ? '/usr/bin/fj' : null) },
    exec: async (cmd: string, argv: string[]) => {
      calls.push({ cmd, argv })
      if (argv.indexOf('auth') >= 0 && argv.indexOf('list') >= 0) return { stdout: 'fj.example\n', stderr: '', code: 0 }
      return { stdout: '', stderr: '', code: 0 }
    },
    fs: {
      resolve: async (rel: string, opts?: { cwd?: string }) => (opts && opts.cwd ? opts.cwd + '/' + rel : rel),
      readText: async (file: string) => {
        if (String(file).endsWith('.git/config')) return CONFIG
        throw new Error('no-file')
      },
    },
  }
  return { ctx, calls }
}

async function main(): Promise<void> {
  console.log('== ① 该带 -R 的时候带上，已经给了就不重复 ==')
  {
    const { ctx, calls } = makeCtx()
    await fjClient(ctx).run(['issue', 'view', '7'], { host: 'https://fj.example', remote: 'origin', cwd: '/ws' })
    const argv = calls[0] ? calls[0].argv : []
    check(JSON.stringify(argv) === JSON.stringify(['-H', 'https://fj.example', '-C', '/ws', 'issue', 'view', '7', '-R', 'origin']),
      '一条读命令带上实例、目录与远端（实得 ' + JSON.stringify(argv) + '）')

    await fjClient(ctx).run(['issue', 'search', '-r', 'acme/repo'], { host: 'https://fj.example', remote: 'origin' })
    const searchArgv = calls[1] ? calls[1].argv : []
    check(searchArgv.indexOf('-R') < 0, '已经显式给了 -r 的搜索命令不再追加 -R（实得 ' + JSON.stringify(searchArgv) + '）')

    await fjClient(ctx).run(['issue', 'edit', '7', 'labels', '--add', 'bug', '-r', 'old'], { host: 'https://fj.example', remote: 'origin' })
    const editArgv = calls[2] ? calls[2].argv : []
    check(editArgv.lastIndexOf('-R') >= 0, 'edit labels 的 -r 是去掉标签，不是选仓库，仍然追加 -R（实得 ' + JSON.stringify(editArgv) + '）')

    await fjClient(ctx).run(['issue', 'close', '7'], { host: 'https://fj.example' })
    const noRemoteArgv = calls[3] ? calls[3].argv : []
    check(noRemoteArgv.indexOf('-R') < 0, '不知道远端名时不编一个 -R（实得 ' + JSON.stringify(noRemoteArgv) + '）')
  }

  console.log('\n== ② repoOpts：有远端名才带 ==')
  {
    check(JSON.stringify(repoOpts({ host: 'https://fj.example', remote: 'origin' })) === JSON.stringify({ host: 'https://fj.example', remote: 'origin' }), '有远端名时两格都给')
    check(JSON.stringify(repoOpts({ host: 'https://fj.example', remote: '' })) === JSON.stringify({ host: 'https://fj.example' }), '没有远端名时只给实例地址')
    check(JSON.stringify(repoOpts(null)) === '{}', '没有仓库时给空对象，不崩')
  }

  console.log('\n== ③ 从工作区的 .git/config 补远端名 ==')
  {
    const { ctx } = makeCtx()
    const byHandle = await resolveRepo({ cwd: '/ws', refId: 'acme/repo', host: 'https://fj.example' }, ctx)
    check(!!byHandle && byHandle.refId === 'acme/repo' && byHandle.remote === 'origin',
      '句柄给了仓库时，仍会从本地远端补出 origin（实得 ' + JSON.stringify(byHandle && byHandle.remote) + '）')

    const byRemote = await resolveRepo({ cwd: '/ws', refId: 'acme/repo' }, ctx)
    check(!!byRemote && byRemote.refId === 'acme/repo' && byRemote.remote === 'origin' && byRemote.host === 'https://fj.example',
      '句柄只给 owner/name 时，远端解析出仓库与实例（实得 ' + JSON.stringify(byRemote) + '）')
  }

  console.log('\n== ④ 写动词分类覆盖房间真正发出的命令形状 ==')
  {
    check(isWriteFjArgs(['issue', 'create', '标题', '--body', '正文']), '建票算写')
    check(isWriteFjArgs(['issue', 'edit', '7', 'labels', '--add', 'bug']), '改标签算写')
    check(isWriteFjArgs(['issue', 'depend', 'add', '7', '8']), '加依赖算写（三层形状，第三格才是动词）')
    check(isWriteFjArgs(['issue', 'block', 'remove', '7', '8']), '去阻塞算写')
    check(isWriteFjArgs(['repo', 'labels', 'acme/repo', 'edit', '12', '-c', '#ff0000']), '改标签颜色算写（第四格才是动词）')
    check(!isWriteFjArgs(['issue', 'view', '7']), '读票不算写')
    check(!isWriteFjArgs(['issue', 'search', '-r', 'acme/repo']), '搜索不算写')
    check(!isWriteFjArgs(['repo', 'labels', 'acme/repo', 'view']), '看标签清单不算写')
  }

  console.log(failed ? '\n存在失败' : '\n全部通过')
  if (failed) process.exit(1)
}

main().catch((e) => { console.error('FAIL', e); process.exit(1) })
