// check.ts —— 同票写互斥的有限穷举交错检查。
//
// 用法（在仓库根目录跑）：
//   node --import ./scripts/ts-hook.mts .claude/skills/verify-write-mutex/check.ts
//
// 它不做手写模型，而是直接驱动 src/deck/shell/write-mutex.ts 的真实实现：
// 每一笔「写」都是一个真实调用，只有三件事由检查控制——什么时候开始、什么时候等锁超时、
// 什么时候持锁的写做完。检查按广度优先枚举这些事件的有限序列（最多 3 笔写、最多 6 个事件），
// 每一步之后都把 Promise 队列排空，然后看三条判据：
//
//   1. 互斥：同一把键上，任意时刻最多只有一笔写在自己的 fn 里。
//   2. 诚实：回 { ok:false, timedOut:true } 的那一笔，从未进入过 fn。
//   3. 干净：所有写都结算之后，锁表回到空（keyLockSnapshot() 的 keys 与 waiters 都是 0）。
//
// 找到反例就按「最短事件序列」原样打印，退出码 1；全部通过退出码 0。
// 范围之外的结论不作数：这里只覆盖最多 3 笔写、6 个事件的交错，不覆盖 fn 内部逻辑、
// 不覆盖真实时钟（超时由检查显式触发），也不覆盖跨进程。

import { keyLockSnapshot, withKeyLock } from '../../../src/deck/shell/write-mutex.js'

/** 一次检查里最多几笔写。再加一笔，状态空间会成倍变大，跑起来就不再是「每次改完都顺手跑」。 */
const CLIENT_COUNT = 3

/** 一次检查里最多几个可控事件。互斥被打破的最短路径只需要 4 个事件，留一点余量给别的形状。 */
const MAX_EVENTS = 6

type Status = 'not-started' | 'waiting' | 'running' | 'timed-out' | 'finished'

type EventKind = 'start' | 'timeout' | 'finish'

interface Event {
  kind: EventKind
  client: number
}

/** 一个状态里检查看得见的东西。未来只由它决定，所以可以拿它给状态去重。 */
interface Observed {
  status: Status[]
  /** 还在排队的写，按开始排队的先后。排队顺序是队列未来行为的一部分，必须进状态。 */
  waitingOrder: number[]
  /** 此刻在自己的 fn 里的写；没被打破时长度是 0 或 1。 */
  running: number[]
  /** 曾经进入过 fn 的写。 */
  entered: number[]
}

type ViolationKind = 'mutex' | 'timeout-entered' | 'leak'

interface Violation {
  kind: ViolationKind
  /** 事件序列里的下标：第几个事件之后看到了它。 */
  at: number
  running: number[]
  detail?: string
}

interface ReplayResult {
  observed: Observed
  violation: Violation | null
}

/** 让已经排好的微任务全部跑完：setImmediate 是宏任务，排在它之前的微任务都会先结算。 */
async function drain(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

let replayId = 0

/**
 * 从零重放一串事件，交回重放结束时的可见状态与第一个反例。
 * 每盘用独立的锁键（键里带 replayId），所以盘与盘之间不会互相看见。
 */
async function replay(events: readonly Event[]): Promise<ReplayResult> {
  replayId += 1
  const lockKey = 'ticket-' + replayId
  const repo = { refId: 'formal-write-mutex' }

  const status: Status[] = new Array(CLIENT_COUNT).fill('not-started')
  const startOrder: number[] = []
  const running = new Set<number>()
  const entered = new Set<number>()
  const fnRelease: Array<() => void> = []
  const sleepRelease: Array<() => void> = []
  const started: boolean[] = new Array(CLIENT_COUNT).fill(false)
  let violation: Violation | null = null

  // 两扇门只在对应事件里放行：finish 放 fn 门，timeout 放等待门。
  const fnGates: Array<Promise<void>> = []
  const sleepGates: Array<Promise<void>> = []
  for (let i = 0; i < CLIENT_COUNT; i += 1) {
    fnGates.push(new Promise<void>((resolve) => { fnRelease[i] = resolve }))
    sleepGates.push(new Promise<void>((resolve) => { sleepRelease[i] = resolve }))
  }

  function startClient(i: number, eventIndex: number): void {
    if (started[i]) return
    started[i] = true
    startOrder.push(i)
    status[i] = 'waiting'
    const result = withKeyLock(repo, lockKey, async () => {
      entered.add(i)
      running.add(i)
      status[i] = 'running'
      if (running.size > 1 && violation === null) {
        violation = { kind: 'mutex', at: eventIndex, running: [...running] }
      }
      await fnGates[i]
      running.delete(i)
      status[i] = 'finished'
      return i
    }, {
      timeoutMs: 1,
      sleep: () => sleepGates[i],
    })
    result.then(
      (value: unknown) => {
        const timedOut = Boolean(value && typeof value === 'object' && (value as { timedOut?: unknown }).timedOut === true)
        status[i] = timedOut ? 'timed-out' : 'finished'
        if (timedOut && entered.has(i) && violation === null) {
          violation = { kind: 'timeout-entered', at: eventIndex, running: [...running] }
        }
      },
      () => { status[i] = 'finished' },
    )
  }

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    const i = event.client
    if (event.kind === 'start') {
      startClient(i, index)
    } else if (event.kind === 'timeout') {
      if (status[i] === 'waiting') sleepRelease[i]()
    } else if (event.kind === 'finish') {
      if (status[i] === 'running') fnRelease[i]()
    }
    await drain()
    if (running.size > 1 && violation === null) {
      violation = { kind: 'mutex', at: index, running: [...running] }
    }
  }

  const observed: Observed = {
    status: [...status],
    waitingOrder: startOrder.filter((i) => status[i] === 'waiting'),
    running: [...running],
    entered: [...entered],
  }

  // 无论这一盘走到哪里，都把它结算干净，锁表才能回到空、下一盘才从同一个起点开始。
  for (let guard = 0; guard < CLIENT_COUNT * 3 + 4; guard += 1) {
    const runners = [...running]
    if (runners.length > 0) {
      for (const i of runners) fnRelease[i]()
      await drain()
      continue
    }
    const waiters = startOrder.filter((i) => status[i] === 'waiting')
    if (waiters.length === 0) break
    for (const i of waiters) sleepRelease[i]()
    await drain()
  }

  const snapshot = keyLockSnapshot()
  if (violation === null && (snapshot.keys !== 0 || snapshot.waiters !== 0)) {
    violation = {
      kind: 'leak',
      at: events.length - 1,
      running: [...running],
      detail: '结算后锁表仍有 ' + snapshot.keys + ' 个键 / ' + snapshot.waiters + ' 个等待',
    }
  }

  return { observed, violation }
}

/** 一个可见状态下一步允许的事件。只列此刻真的能发生的事，避免把不可能的顺序当成反例。 */
function applicableEvents(observed: Observed): Event[] {
  const events: Event[] = []
  for (let i = 0; i < CLIENT_COUNT; i += 1) {
    if (observed.status[i] === 'not-started') events.push({ kind: 'start', client: i })
  }
  for (let i = 0; i < CLIENT_COUNT; i += 1) {
    if (observed.status[i] === 'waiting') events.push({ kind: 'timeout', client: i })
  }
  for (let i = 0; i < CLIENT_COUNT; i += 1) {
    if (observed.status[i] === 'running') events.push({ kind: 'finish', client: i })
  }
  return events
}

/** 状态去重用的键：每个客户端的状态、排队顺序、正在执行的写。 */
function stateKey(observed: Observed): string {
  return observed.status.join(',') + '|' + observed.waitingOrder.join('>') + '|' + observed.running.join('>')
}

function emptyObserved(): Observed {
  return {
    status: new Array(CLIENT_COUNT).fill('not-started'),
    waitingOrder: [],
    running: [],
    entered: [],
  }
}

const EVENT_WORDS: Record<EventKind, string> = {
  start: '开始一笔写',
  timeout: '等锁到上限，放弃等待',
  finish: '持锁的那一笔写完，放锁',
}

function describe(events: readonly Event[], violation: Violation): string {
  const lines: string[] = []
  for (let i = 0; i < events.length; i += 1) {
    const mark = i === violation.at ? '  ← 反例发生在这里' : ''
    lines.push('  ' + (i + 1) + '. 第 ' + (events[i].client + 1) + ' 笔：' + EVENT_WORDS[events[i].kind] + mark)
  }
  return lines.join('\n')
}

async function main(): Promise<void> {
  const startObserved = emptyObserved()
  const queue: Array<{ events: Event[]; observed: Observed }> = [{ events: [], observed: startObserved }]
  const seen = new Set<string>([stateKey(startObserved)])
  let replays = 0
  let maxDepth = 0

  while (queue.length > 0) {
    const node = queue.shift()
    if (!node) break
    if (node.events.length >= MAX_EVENTS) continue
    for (const event of applicableEvents(node.observed)) {
      const events = [...node.events, event]
      const result = await replay(events)
      replays += 1
      if (result.violation) {
        reportViolation(events, result.violation, replays)
        process.exitCode = 1
        return
      }
      const key = stateKey(result.observed)
      if (seen.has(key)) continue
      seen.add(key)
      if (events.length > maxDepth) maxDepth = events.length
      queue.push({ events, observed: result.observed })
    }
  }

  console.log('同票写互斥检查通过：' + replays + ' 次重放、' + seen.size + ' 个不同状态、最深 ' + maxDepth + ' 个事件。')
  console.log('覆盖范围：最多 ' + CLIENT_COUNT + ' 笔写、' + MAX_EVENTS + ' 个事件；不含 fn 内部逻辑、真实时钟与跨进程。')
}

function reportViolation(events: readonly Event[], violation: Violation, replays: number): void {
  console.log('同票写互斥检查失败（' + replays + ' 次重放后找到反例）。')
  if (violation.kind === 'mutex') {
    const who = violation.running.map((i) => '第 ' + (i + 1) + ' 笔').join(' 与 ')
    console.log('判据 1（互斥）被打破：' + who + ' 同时在自己的 fn 里。')
    console.log('两笔同时做「先读回、再整批替换」的写，就会丢掉其中一次改动。')
  } else if (violation.kind === 'timeout-entered') {
    console.log('判据 2（诚实）被打破：已经回超时的那一笔仍然进入了 fn。')
  } else {
    console.log('判据 3（干净）被打破：所有写结算之后锁表没有回到空。' + (violation.detail ? violation.detail : ''))
  }
  console.log('最短事件序列：')
  console.log(describe(events, violation))
}

main().catch((error: unknown) => {
  console.error('检查自身出错（不是被检查代码的结论）：')
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
