/**
 * src/tracker/rooms/forgejo/errors.ts —— `fj` 失败原文到契约八档的判档出口。
 *
 * 判据不在本文件：真源是全仓唯一那张有序规则表 `src/tracker/kernel/error-rules.ts`。
 * 这里只补 `fj` 专有的几条，通用表已经认得出的（命令没装、DNS、超时、403 限流）一条都不抄。
 *
 * 今天只补三条，每条都有实测样本：
 *  1. `the response from forgejo was not properly structured`：仓库或票不存在时，Forgejo 的
 *     反代有时回 HTML 而不是 JSON，`fj` 把这句甩出来。它不是网络故障，是「拿回来的东西读不了」，
 *     归 parse；调用方据此说「这个仓库或这张票在这个实例上读不到」。
 *  2. `reference 'refs/heads/...' not found`：`fj` 在一个还没有任何提交的仓库里读票时会撞上这个
 *     本地 git 错误。归 env：问题在本机仓库状态，不在远端；让用户先提交一次再重试。
 *  3. `unexpected argument`：参数形状不对，`fj` 在起请求之前就拒绝了。归 parse，并把原文带回去，
 *     让调用方知道是这一间房拼错了命令，而不是用户的操作有问题。
 */

import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { ErrorKind } from '../../contract/identity.js'
import type { TrackerError } from '../../contract/results.js'
import { HINT_UNRECOGNIZED, HINT_UNSUPPORTED, fail } from '../../kernel/preflight.js'
import type { ClassifyCtx } from '../../kernel/preflight.js'
import { emitPassthrough, factsFromError, judgeFactsDetailed } from '../../kernel/error-rules.js'
import type { ErrorRule } from '../../kernel/error-rules.js'

const KIND_VALUES: ReadonlySet<string> = new Set(Object.values(ERROR_KIND))

/** 判档结果只交档位与是否兜底；层信息留给日志，不进返回。 */
export interface FjVerdict {
  kind: ErrorKind
  fallback: boolean
}

/**
 * `fj` 这一家的前置扩展表（判档时先试它，再试通用表）。
 *
 * 三条规矩与 GitLab 房同一套：只放通用表认不出的；每条自带 `example` 并会被门禁逐条自证；
 * 不许与通用项同层同模式。
 */
export const FJ_ERROR_RULES: readonly ErrorRule[] = [
  {
    kind: ERROR_KIND.PARSE as ErrorKind,
    layer: 'phrase',
    pattern: /not properly structured/i,
    example: { text: 'Error: the response from forgejo was not properly structured' },
    note: 'Forgejo 的接口在仓库或票不存在时可能回 HTML，fj 解析不了 JSON 就甩这句。'
      + '它不是网络故障，归 parse；让调用方说「这条读不到」而不是让用户去查网络。',
  },
  {
    kind: ERROR_KIND.ENV as ErrorKind,
    layer: 'phrase',
    pattern: /reference 'refs\/heads\/[^']*' not found/i,
    example: { text: "Error: reference 'refs/heads/master' not found; class=Reference (4); code=UnbornBranch (-9)" },
    note: 'fj 在还没有任何提交的本地仓库里读票时会撞上这个 git 错误。问题在本机仓库状态，'
      + '不在远端；归 env，提示先提交一次再重试，而不是让用户重新登录。',
  },
  {
    kind: ERROR_KIND.PARSE as ErrorKind,
    layer: 'phrase',
    pattern: /unexpected argument/i,
    example: { text: "error: unexpected argument '-r' found" },
    note: '参数形状不对，fj 在起请求之前就拒绝。归 parse，并保留原文，'
      + '让排查的人先去看本房拼错的命令，而不是把它当成用户操作失败。',
  },
]

/** `err` 已经是规范档位了吗（顶层 `kind` 或 `error.kind` 命中八档取值之一）。 */
function carriedKind(err: unknown): ErrorKind | null {
  if (!err || typeof err !== 'object') return null
  const bag = err as Record<string, unknown>
  const top = bag['kind']
  if (typeof top === 'string' && KIND_VALUES.has(top)) return top as ErrorKind
  const inner = bag['error']
  if (inner !== null && typeof inner === 'object') {
    const innerKind = (inner as Record<string, unknown>)['kind']
    if (typeof innerKind === 'string' && KIND_VALUES.has(innerKind)) return innerKind as ErrorKind
  }
  return null
}

/**
 * 把 `fj` 的任意错误值判成八档之一。
 *
 * 顺序与全仓一致：已经是规范档位的失败原样透传，其余走「本家扩展表 → 通用表」。
 */
export function classifyFjError(err: unknown, ctx?: ClassifyCtx): FjVerdict {
  const carried = carriedKind(err)
  if (carried) {
    emitPassthrough(ctx, carried)
    return { kind: carried, fallback: false }
  }
  const judged = judgeFactsDetailed(factsFromError(err), FJ_ERROR_RULES, ctx)
  return { kind: judged.kind, fallback: judged.fallback }
}

/** 挑这次失败给用户看的那句话：兜底与「不支持」两档换成全仓统一提示。 */
export function hintFor(verdict: FjVerdict | null | undefined, nativeMessage: string): string {
  if (verdict && verdict.fallback) return HINT_UNRECOGNIZED
  if (verdict && verdict.kind === (ERROR_KIND.UNSUPPORTED as ErrorKind)) return HINT_UNSUPPORTED
  return nativeMessage
}

/**
 * 这一家统一的失败构造：判档、挑话、带原文，三步一处做完。
 *
 * @param err 原始错误值（进程结果 / Error / 一段文本），判档与取原文都用它
 * @param nativeMessage 本家那句话；兜底与 unsupported 两档会被换成通用提示
 * @param raw 原文（默认就是 `err` 本身）
 * @param ctx 判档上下文（留 error.normalize 轨迹用）
 */
export function failFj(
  err: unknown,
  nativeMessage: string,
  raw?: unknown,
  ctx?: ClassifyCtx,
): { ok: false; error: TrackerError } {
  const verdict = classifyFjError(err, ctx)
  return fail(verdict.kind, hintFor(verdict, nativeMessage), arguments.length > 2 ? raw : err)
}

export default classifyFjError
