/**
 * 发布计划层的**工具面**（`sdo_release`：`show` / `propose` / `sign` / `write` / `change`）。
 *
 * ## 为什么要有这个模块
 *
 * `writeRelease` / `readRelease` / `deriveFor` / `deferTraceFindings` / `freezeTraceFindings` 已经在
 * `release.ts` 里实现并被守卫覆盖，`office.releaseWrite` / `office.releaseDefer` 也提供了**域层写入面**
 * （`TASK-171`）。但域层写入面不是**工具面**：落盘 `r-0.1.7` 时只能由驾驶舱跑一段 `node` 脚本直调域函数 ——
 * 那条路径**没有问答通道**（没有人签字）、**没有参数面**（`frozenAtSeq` 由脚本手填），于是
 * `AC-276` 要的那道闸（集合的权威来自冻结那次人签）在真机上只能靠人自律。本模块把这条路径包成工具：
 * 签字走问答通道、`frozenAtSeq` 由工具在落盘时取**真实事件序号**、改已冻结集合走一条**可核**的变更路径。
 *
 * ## 五个动作的分工（谁写盘、谁不写）
 *
 * | 动作 | 写盘 | 允许的前提 |
 * |---|---|---|
 * | `show` | **不写** | 无 |
 * | `propose` | **不写** | 无（按台账现算提案 + 预演两条判据） |
 * | `sign` | 只追加一条 `release/signed` | 问答通道可用且用户选了「签字」 |
 * | `write` | 写 release 文件 + `release/written` | **已有待用人签**，且待签集合的 digest 与本次一致 |
 * | `change` | 写 release 文件 + `release/changed` + `release/written` | release **已冻结**、有待用人签、`reason` + `approvedBy=human` + 改动的 id 列表齐备 |
 *
 * ## `change` 的三条硬约束（卡上的 ①②③）
 *
 * ① **冻结前不许 `change`**：没有冻结就没有可变更的对象 —— 一份没签字的草稿本来就该直接改。
 * ② **每一次 `change` 必须能在真源里核到那一次人签**：与 `freeze-unwitnessed` 同口径 —— 签字由
 *    `sign` 落一条 `release/signed`（`by: human` + `channel: question` + 集合 digest + `add`/`remove`/`reason`），
 *    `change` 只认**这一份签过的东西**：digest 对不上、或 `add`/`remove`/`reason` 与签字时不符 ⇒ 拒绝。
 *    调用方**不许**手填 `frozenAtSeq`（`write` / `change` 收到这个参数一律拒绝）：那一刻由**工具**在落盘时
 *    从 journal 取真实序号，并把它写进文件的 `frozenAtSeq` —— 这不是装饰，`freezeTraceFindings` 会拿它去
 *    真源里核「那一刻是不是一次人签」。
 * ③ **`C-75` 认这条合法路径**：判据侧读数在 {@link changeTraceFindings}（三格见那里的注释）。
 *    它与 `release.ts` 的 `freezeTraceFindings` **互补**而不是重复：后者按**条数**判"冻结后集合被改过"，
 *    本函数按**id 差集**判"这次改动有没有一条对得上的 `release/changed`"。
 *    **一段必须说清的边界**：把本函数挂到门禁的 `C-75` 判据上需要改 `gates.ts`（`TASK-183` 的写范围不含它），
 *    所以**今天**的挂载面是两条：`release.ts` 的核心判据（条数面，`sdo_release` 的合法路径在它下面**是绿的**，
 *    见下节）+ 本函数的读数（`show` 回执第三条面；门禁挂载留给后续卡）。
 *
 * ## 为什么合法变更在**现有**核心判据下也是绿的（不需要改 `release.ts`）
 *
 * `freezeTraceFindings` 的基线是**`frozenAtSeq` 指向的那次带签字的落盘**（找不到才退到最早那次）。
 * 于是「改集合再签一次」这件事只要真的**重新落一次盘并把 `frozenAtSeq` 指到新的那次落盘**，
 * 基线条数就跟着走到新集合上 ⇒ 条数相减为 0 ⇒ 不判红；而**手改文件**（不重新落盘）基线还停在旧的那次
 * ⇒ 条数对不上且冻结后没有任何已决策的变更 ⇒ 照旧判红。这正是 `AC-276` 后半要的形状。
 *
 * 由此定下落盘的**两段写**（{@link writeFrozen}）：① 先落一次**不冻结**的盘（形状关允许：冻结的两个字段
 * 要么都在、要么都不在），拿到这条文件的**真实事件序号**；② 再落一次**带冻结**的盘，`frozenAtSeq` 指向
 * ①之后紧邻的那一条（同一次调用里就是它），落完再按**实测**序号核对 —— 对不上就用实测值重落一次
 * （`frozenAtSeq` 是一句可核对的声明，绝不猜）。
 *
 * ## 事件类型：`release/changed` / `release/signed` 的登记不在本卡写范围
 *
 * `SdoEventType` 是 `src/types.ts` 里的**闭合联合**，而 `src/types.ts` 不在 `TASK-183` 的写范围里。
 * 因此与 `scrub.ts` / `dispatchFace.ts` 里 `dispatch/reuse-skipped` 的处置**同一套**：
 * **写侧**走最小结构化接口 {@link ReleaseEventSink}（`Journal` 天然满足），**读侧**按**字形**比字符串
 * （台账是跨版本 append-only 的，别的构建写过的事件本构建照样要读得回来）。登记这一步留给后续卡。
 *
 * ## i18n
 *
 * 文案一律走语言包（`uiRelease.*` + 本工具的 `sdo.release` 描述），本文件的**字符串字面量里没有中文**
 * （注释不算：`countCjkLiterals` 只数字面量）。判据 id 只许活在注释里，代码面不碰。
 */
import { createHash } from 'node:crypto'

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { Journal } from '../infra/journal.js'
import { textOf } from '../infra/scalar.js'
import type { SdoStore } from '../infra/store.js'
import type { JournalEvent, Release, ReleaseNote } from '../types.js'
import { fmt, t } from './i18n.js'
import { listTasks } from './plan.js'
import { listDefects } from './records.js'
import {
  HUMAN_APPROVER,
  currentRelease,
  deferLimitOf,
  deferTraceFindings,
  freezeTraceFindings,
  listReleases,
  packageVersionOf,
  readRelease,
  releaseShapeProblems,
  writeRelease,
} from './release.js'
import type { ReleaseTraceFinding } from './release.js'
import { listRequirements } from './requirements.js'

/* ———————————————————————————————— 常量与最小接口 ———————————————————————————————— */

/** `sdo_release` 的动作面（唯一一份；工具 schema 的 `action` 描述由它生成）。 */
export const RELEASE_ACTIONS = ['show', 'propose', 'sign', 'write', 'change'] as const
export type ReleaseAction = (typeof RELEASE_ACTIONS)[number]

/** 变更事件名（**尚未**登记进 `SdoEventType`：见模块注释「事件类型」一节）。 */
export const RELEASE_CHANGED_EVENT = 'release/changed'

/** 人签事件名（同上：按字形读写，等后续卡登记）。 */
export const RELEASE_SIGNED_EVENT = 'release/signed'

/**
 * **写侧的最小结构化接口**：`Journal` 结构上满足它（`append(type: SdoEventType, …)` 的参数比 `string` 窄，
 * 所以 `Journal` 可以直接当 `ReleaseEventSink` 用）。为什么不用 `as` 强转：强转会把"忘了登记"这件事
 * 变成一处静默的谎言；这个接口把"这条事件还没登记"如实写在类型面上（与 `scrub.ts` 的 `EventSink` 同一处置）。
 */
export interface ReleaseEventSink {
  append(type: string, data: Record<string, unknown>, actor?: string): unknown
}

/** 一次调用要用的台账入口（域层不自己拼绝对路径：`SdoStore` 才是路径沙箱的唯一出口）。 */
export interface ReleaseLedger {
  store: SdoStore
  journal: Journal
}

/**
 * 调用上下文（**最小结构**：工作区 / 身份 / 一个不解读的 agent 引用）。
 *
 * `agent` 只为**问答通道**存在：宿主的人机问答要一个活的 agent 才问得出去，"拒绝代签"这件事
 * 全靠那条通道自己发问、自己收选项原文。本模块不解读它，原样交给注入的 `ask`。
 */
export interface ReleaseCall {
  cwd?: string | undefined
  sessionId?: string | undefined
  agent?: unknown
}

/* ———————————————————————————————— 事件读取小工具 ———————————————————————————————— */

/** 事件负载（`data` 是 `Record<string, unknown>`，直接点取会到处是 `unknown`）。 */
function eventData(event: JournalEvent): Record<string, unknown> {
  const data = event.data
  return data === null || typeof data !== 'object' || Array.isArray(data) ? {} : data
}

/** 事件类型按**字形**比（闭合联合里还没登记的那些也只认字形，见模块注释）。 */
function typeOf(event: JournalEvent): string {
  return String(event.type)
}

/** 事件里的一串 id（非数组 ⇒ 空；空串项丢掉；不去重，调用方按需去重）。 */
function idListOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => textOf(item).trim()).filter((item) => item !== '')
}

/** 事件里记的条数（缺字段给 -1：与"记了 0 条"区分开）。 */
function recordedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : -1
}

/** 这条事件是不是**这一份** release 的落盘。 */
function isWriteOf(event: JournalEvent, releaseId: string): boolean {
  return typeOf(event) === 'release/written' && textOf(eventData(event)['id']).trim() === releaseId
}

/** 按 seq 升序的读法（`journal.read()` 本来就是升序，这里只防调用方传进来的乱序数组）。 */
function bySeq(events: readonly JournalEvent[]): JournalEvent[] {
  return [...events].sort((left, right) => left.seq - right.seq)
}

/* ———————————————————————————————— 集合与摘要 ———————————————————————————————— */

/** 一份 release 的**三面集合**（判据与事件都按它对齐：scope 两面 + 顺延名单）。 */
export interface ReleaseSets {
  requirements: string[]
  acceptance: string[]
  nonScope: string[]
}

/** 去重 + 排序：集合语义只认"有哪些"，不认写的顺序（同一份集合换个顺序不算改动）。 */
function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => textOf(id).trim()).filter((id) => id !== ''))].sort()
}

/** 一份 release 的三面集合。 */
export function releaseSets(release: Release): ReleaseSets {
  return {
    requirements: normalizeIds(release.scope.requirements ?? []),
    acceptance: normalizeIds(release.scope.acceptance ?? []),
    nonScope: normalizeIds((release.nonScope ?? []).map((note) => note.id)),
  }
}

/** 两个集合的差（`left` 有而 `right` 没有的）。 */
function minus(left: readonly string[], right: readonly string[]): string[] {
  const other = new Set(right)
  return normalizeIds(left).filter((id) => !other.has(id))
}

/** 集合相等（两边都先归一；顺序无关）。 */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return normalizeIds(left).join('\u0000') === normalizeIds(right).join('\u0000')
}

/**
 * 集合的**内容摘要**（`sha256`，逐键排序后取哈希）。
 *
 * 用途：把"用户签字时看到的那一份"与"这次要写的那一份"对起来 —— 只比条数会被"删一条、加一条"骗过去
 * （`release/written` 的事件面只有条数，这个盲区在 `release.ts` 里已如实登记；签字面因此按**内容**摘要）。
 */
export function setsDigest(sets: ReleaseSets): string {
  const canonical = JSON.stringify({
    requirements: normalizeIds(sets.requirements),
    acceptance: normalizeIds(sets.acceptance),
    nonScope: normalizeIds(sets.nonScope),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/* ———————————————————————————————— 人签 ———————————————————————————————— */

/** 一条人签记录的读侧投影（`release/signed` 的 `data`）。 */
export interface ReleaseSignature {
  seq: number
  /** 这份签字是给**哪种动作**的：落盘（`write`）还是改已冻结集合（`change`）。 */
  kind: 'write' | 'change'
  /** 用户签字时看到的三面集合的内容摘要。 */
  digest: string
  /** 用户所选选项的**原文**（宿主回传，不经过模型）。 */
  label: string
  /** 作答时刻（宿主交回选项的那一刻）。 */
  at: string
  /** `kind=change` 时这一份签字批准的具体改动。 */
  add: string[]
  remove: string[]
  reason: string
}

/** 某份 release 的人签读数：全部人签 + 仍未被人签落盘消费的那一条。 */
export interface SignatureReadout {
  /** 按 seq 升序的全部人签（`by: human` 的 `release/signed`）。 */
  signed: ReleaseSignature[]
  /** 最新一条**还没被任何人签落盘消费**的人签。 */
  pending?: ReleaseSignature | undefined
  /** 最后一次**带人签**的落盘（`release/written` 且 `frozen=true`）的序号。 */
  lastSignedWrite?: number | undefined
}

/**
 * 读出某份 release 的人签面。
 *
 * 「待用」的判法：这条人签之后**没有**任何带签字的落盘 —— 一次 `write` / `change` 落完盘，
 * 它之前的那条人签就消费掉了（否则同一份签字可以无限次落盘，签字就退化成一次性的口号）。
 */
export function signatureReadout(events: readonly JournalEvent[], releaseId: string): SignatureReadout {
  const ordered = bySeq(events)
  const signed: ReleaseSignature[] = []
  let lastSignedWrite: number | undefined
  for (const event of ordered) {
    if (isWriteOf(event, releaseId) && eventData(event)['frozen'] === true) {
      lastSignedWrite = event.seq
      continue
    }
    if (typeOf(event) !== RELEASE_SIGNED_EVENT) continue
    const data = eventData(event)
    if (textOf(data['id']).trim() !== releaseId) continue
    if (textOf(data['by']).trim() !== HUMAN_APPROVER) continue
    signed.push({
      seq: event.seq,
      kind: textOf(data['kind']).trim() === 'change' ? 'change' : 'write',
      digest: textOf(data['digest']).trim(),
      label: textOf(data['label']).trim(),
      at: textOf(data['answeredAt']).trim(),
      add: normalizeIds(idListOf(data['add'])),
      remove: normalizeIds(idListOf(data['remove'])),
      reason: textOf(data['reason']).trim(),
    })
  }
  const pending = signed.filter((item) => lastSignedWrite === undefined || item.seq > lastSignedWrite).at(-1)
  return {
    signed,
    ...(pending === undefined ? {} : { pending }),
    ...(lastSignedWrite === undefined ? {} : { lastSignedWrite }),
  }
}

/* ———————————————————————————————— 落盘（两段写） ———————————————————————————————— */

/** 一次冻结落盘的结果：文件、锚点序号（第一段写）与冻结序号（`frozenAtSeq` 指向的那一条）。 */
export interface FrozenWriteOutcome {
  release: Release
  /** 第一段（不冻结）那条 `release/written` 的真实序号。 */
  anchorSeq: number
  /** `frozenAtSeq` 指向的那条**带签字落盘**的真实序号。 */
  frozenSeq: number
}

/** 这条 release 最近一次落盘的事件序号（`undefined` = 一次都没落过）。 */
function lastWriteSeq(ledger: ReleaseLedger, releaseId: string): number | undefined {
  return bySeq(ledger.journal.read().events).filter((event) => isWriteOf(event, releaseId)).at(-1)?.seq
}

/**
 * 去掉冻结两字段（第一段写要的是"形状合法但不冻结"的那一份）。
 *
 * 为什么显式重建而不是解构掉两个键：`exactOptionalPropertyTypes` 下"没有这个键"与"键是 undefined"
 * 是两件事，重建能把这件事写死（也顺手复制了集合，不让调用方的数组被写穿）。
 */
function withoutFreeze(release: Release): Release {
  return {
    id: release.id,
    ...(release.packageVersion === undefined ? {} : { packageVersion: release.packageVersion }),
    scope: {
      requirements: [...release.scope.requirements],
      acceptance: [...release.scope.acceptance],
    },
    ...(release.nonScope === undefined ? {} : { nonScope: release.nonScope.map((note) => ({ ...note })) }),
  }
}

/** 第一段写要保留的**旧冻结记号**（文件本来已冻结时用它，免得两段写之间出现"无主"的窗口）。 */
export interface KeepFrozen {
  frozenBy: string
  frozenAtSeq: number
}

/**
 * **带人签的落盘**（两段写；为什么必须是两段见模块注释）。
 *
 * ① 先落一次不冻结的盘 —— 拿到这条文件的**真实事件序号**（绝不预测绝对序号：journal 被截断时
 *    预测会指向一条不存在的事件，而 `frozenAtSeq` 是一句可核对的声明）；本来就冻结着的文件，
 *    这一段**沿用旧的冻结记号**，免得两段写之间出现一个"文件在盘上却没有签字"的窗口；
 * ② 再落一次带冻结的盘，`frozenAtSeq` 指向紧邻的那一条；落完按**实测**序号核对，
 *    对不上（同一瞬间有别的写者插了一条）就用实测值重落一次 —— 收敛后用实测值，猜错也只会 fail-closed
 *    （`frozenAtSeq` 指向一条核不到人签的事件 ⇒ `freeze-unwitnessed` 判红），不会变成假绿。
 */
export function writeFrozen(ledger: ReleaseLedger, release: Release, keep?: KeepFrozen | undefined): FrozenWriteOutcome {
  writeRelease(ledger.store, ledger.journal, keep === undefined ? withoutFreeze(release) : { ...withoutFreeze(release), ...keep })
  const anchorSeq = lastWriteSeq(ledger, release.id) ?? 0
  let written = writeRelease(ledger.store, ledger.journal, {
    ...release,
    frozenBy: HUMAN_APPROVER,
    frozenAtSeq: anchorSeq + 1,
  })
  const frozenSeq = lastWriteSeq(ledger, release.id) ?? 0
  if (frozenSeq !== anchorSeq + 1) {
    written = writeRelease(ledger.store, ledger.journal, { ...written, frozenAtSeq: frozenSeq })
  }
  return { release: written, anchorSeq, frozenSeq }
}

/* ———————————————————————————————— 判据侧读数：冻结后改集合 ———————————————————————————————— */

/**
 * **冻结后改集合**的判据侧读数（`AC-276` 后半 / `C-75` 对应的那一族）：空数组＝绿。
 *
 * 三格（卡上的三条反例格，逐条对应）：
 * ① `changed-without-event` —— **改了集合但没有任何 `release/changed`**：现盘三面条数与
 *    「最早那次带签字的落盘」记下的条数对不上，而那份落盘之后一条变更事件都没有 ⇒ 冻结后绕过变更控制
 *    直接改了集合（反例 R13）；
 * ② 有 `release/changed` 且**前后差集一致** ⇒ **绿**（这一格是"合法路径"，不许被判红）；
 * ③ `changed-mismatch` —— 变更事件**说的与做的不一致**：`added` / `removed` 与它自己声明的 before/after
 *    对不上、或链上一条的 after 与这一条的 before 对不上、或最后一条的 after 与**现盘**对不上
 *    ⇒ 事件说改 A，实际改的是 B。
 *
 * 为什么基线取**最早**那次带签字的落盘（而不是 `frozenAtSeq`）：`frozenAtSeq` 会随每次合法重签往后走
 * （`release.ts` 的核心判据就是这么取基线的），用它做基线会把"改过"这件事本身抹掉 —— 那么第 ③ 格的
 * "现盘与事件对不上"就永远无从比较。两份读数因此**互补**：核心判据管条数面（且认**重新落盘**这条合法路径），
 * 本函数管 id 差集面（认**变更事件**这条合法路径）。
 *
 * @param input.releases 台账里的全部 release（顺序随意）
 * @param input.events   真源事件（`journal.read().events`）；不给 ⇒ 一次都判不了（返回空数组不是"绿"，是"没读"）
 */
export interface ReleaseChangeInput {
  releases: readonly Release[]
  events?: readonly JournalEvent[] | undefined
}

/** 一条变更面的判红读数（`kind` 是机器面，`detail` 是点名到 id 的人读面）。 */
export interface ReleaseChangeFinding {
  kind: 'changed-without-event' | 'changed-mismatch'
  subjectId: string
  detail: string
}

/** 事件里声明的三面集合（坏形状 ⇒ 空集合：故意不"猜"，坏形状会在比对时判红）。 */
function declaredSets(value: unknown): ReleaseSets {
  const record = value === null || typeof value !== 'object' || Array.isArray(value) ? {} : (value as Record<string, unknown>)
  return {
    requirements: normalizeIds(idListOf(record['requirements'])),
    acceptance: normalizeIds(idListOf(record['acceptance'])),
    nonScope: normalizeIds(idListOf(record['nonScope'])),
  }
}

/** 三面集合是否逐面相等。 */
function sameSets(left: ReleaseSets, right: ReleaseSets): boolean {
  return sameSet(left.requirements, right.requirements)
    && sameSet(left.acceptance, right.acceptance)
    && sameSet(left.nonScope, right.nonScope)
}

/**
 * 三面集合写成一句话（点名用）：条数 + **id 本身**。
 *
 * 为什么不能只给条数：两条判据里"差集对不上"的那一格，只报 `1 -> 2` 读者根本不知道差的是哪个 id
 * （`REQ-009` 与 `REQ-002` 在条数面长得一模一样）—— 判红要能回答"改的是谁"。超过 {@link DESCRIBE_LIMIT}
 * 个 id 时截断并给出`+N`，免得把 56 条顺延名单整篇灌进回执。
 */
const DESCRIBE_LIMIT = 8

function describeIds(ids: readonly string[]): string {
  const sorted = normalizeIds(ids)
  if (sorted.length === 0) return '-'
  if (sorted.length <= DESCRIBE_LIMIT) return sorted.join(' ')
  return `${sorted.slice(0, DESCRIBE_LIMIT).join(' ')} +${sorted.length - DESCRIBE_LIMIT}`
}

/** 三面集合写成一句话（条数 + id 点名）。 */
function describeSets(sets: ReleaseSets): string {
  return `scope [${describeIds(sets.requirements)}] / AC [${describeIds(sets.acceptance)}], `
    + `nonScope [${describeIds(sets.nonScope)}] (${sets.requirements.length}/${sets.acceptance.length}/${sets.nonScope.length})`
}

export function changeTraceFindings(input: ReleaseChangeInput): ReleaseChangeFinding[] {
  const releases = [...input.releases]
  const events = bySeq(input.events ?? [])
  const out: ReleaseChangeFinding[] = []
  if (events.length === 0) return out // 没给真源 ⇒ 一次都判不了（调用方必须知道这不是"绿"）

  for (const release of releases) {
    const signedWrites = events.filter((event) => isWriteOf(event, release.id) && eventData(event)['frozen'] === true)
    const baseline = signedWrites[0]
    // 一次带签字的落盘都没有 ⇒ 这是 `freeze-unwitnessed` 的活，这里不抢（免得同一个病报两遍）
    if (baseline === undefined) continue
    const recorded = eventData(baseline)
    const disk = releaseSets(release)
    const changes = events.filter(
      (event) => typeOf(event) === RELEASE_CHANGED_EVENT
        && textOf(eventData(event)['id']).trim() === release.id
        && event.seq > baseline.seq,
    )
    const countsMatch = recordedCount(recorded['requirements']) === disk.requirements.length
      && recordedCount(recorded['acceptance']) === disk.acceptance.length
      && recordedCount(recorded['nonScope']) === disk.nonScope.length

    // ① 条数变了却一条变更事件都没有 ⇒ 冻结后绕过变更控制直接改了集合
    if (!countsMatch && changes.length === 0) {
      out.push({
        kind: 'changed-without-event',
        subjectId: release.id,
        detail:
          `${release.id} was written frozen at seq ${baseline.seq} with `
          + `${recordedCount(recorded['requirements'])}/${recordedCount(recorded['acceptance'])} requirements/AC and `
          + `${recordedCount(recorded['nonScope'])} nonScope entries, the file now has ${describeSets(disk)}, `
          + 'and no release/changed event follows that write - the frozen set was edited outside change control',
      })
      continue
    }
    if (changes.length === 0) continue

    // ② / ③ 变更事件必须自洽、必须成链、最后一条必须与现盘一致
    let previousAfter: ReleaseSets | undefined
    for (const event of changes) {
      const data = eventData(event)
      const before = declaredSets(data['before'])
      const after = declaredSets(data['after'])
      const added = normalizeIds(idListOf(data['added']))
      const removed = normalizeIds(idListOf(data['removed']))
      const addedWanted = minus(after.requirements.concat(after.acceptance), before.requirements.concat(before.acceptance))
      const removedWanted = minus(before.requirements.concat(before.acceptance), after.requirements.concat(after.acceptance))
      if (!sameSet(added, addedWanted) || !sameSet(removed, removedWanted)) {
        out.push({
          kind: 'changed-mismatch',
          subjectId: release.id,
          detail:
            `${release.id}: the release/changed event at seq ${event.seq} declares added [${added.join(' ')}] / `
            + `removed [${removed.join(' ')}] but its own before/after sets imply added [${addedWanted.join(' ')}] / `
            + `removed [${removedWanted.join(' ')}] - the event says A, the bookkeeping says B`,
        })
        continue
      }
      if (previousAfter !== undefined && !sameSets(previousAfter, before)) {
        out.push({
          kind: 'changed-mismatch',
          subjectId: release.id,
          detail:
            `${release.id}: the release/changed event at seq ${event.seq} declares before (${describeSets(before)}) `
            + `but the previous change left (${describeSets(previousAfter)}) - the chain of changes does not join`,
        })
        continue
      }
      previousAfter = after
    }
    if (previousAfter !== undefined && !sameSets(previousAfter, disk)) {
      out.push({
        kind: 'changed-mismatch',
        subjectId: release.id,
        detail:
          `${release.id}: the latest release/changed event declares after (${describeSets(previousAfter)}) `
          + `but the file on disk has (${describeSets(disk)}) - the event says A, the file shows B`,
      })
    }
  }
  return out
}

/* ———————————————————————————————— 已终结实体（顺延判据的输入） ———————————————————————————————— */

/**
 * 已**终结**的实体 id（`deferTraceFindings` 的三路豁免之一：做完了就不算顺延）。
 *
 * 口径与 `gates.ts` 的 `settledEntityIdsOf` **同一个**（缺陷 `fixed`/`closed`、卡 `done`/`verified`/`dropped`）：
 * 这里是**工具回执**用的现算，不去 import 判据模块（依赖方向是「判据 → 派生层」，反向那条会把门禁的判断
 * 塞进工具面）。两处口径若将来分叉，以 `gates.ts` 为准 —— 门禁的读数是权威，工具回执是预览。
 */
function settledIdsOf(store: SdoStore): string[] {
  const out: string[] = []
  for (const defect of listDefects(store)) {
    const status = String(defect.status)
    if (status === 'fixed' || status === 'closed') out.push(defect.id)
  }
  for (const task of listTasks(store)) {
    const status = String(task.status)
    if (status === 'done' || status === 'verified' || status === 'dropped') out.push(task.id)
  }
  return [...new Set(out)]
}

/** 真源里**点名过顺延**的实体 id（`release/deferred` 事件的 `id` / `ids` 两种形态都认）。 */
function deferredRecordIdsOf(journal: Journal): string[] {
  const out = new Set<string>()
  for (const event of bySeq(journal.read().events)) {
    if (typeOf(event) !== 'release/deferred') continue
    const data = eventData(event)
    const single = textOf(data['id']).trim()
    if (single !== '') out.add(single)
    for (const id of idListOf(data['ids'])) out.add(id)
  }
  return [...out]
}

/* ———————————————————————————————— 收口：失败读数 ———————————————————————————————— */

/** 拒绝的机器面原因（回执按它渲染；测试按它断言，语言无关）。 */
export type ReleaseRejectCode =
  | 'unknown-action'
  | 'no-workspace'
  | 'read-failed'
  | 'frozen-at-seq-forbidden'
  | 'shape'
  | 'no-release'
  | 'not-frozen'
  | 'reason-missing'
  | 'approver-not-human'
  | 'ids-empty'
  | 'id-conflict'
  | 'id-already-in-scope'
  | 'id-not-in-scope'
  | 'id-not-in-non-scope'
  | 'signature-missing'
  | 'signature-mismatch'
  | 'change-unsigned'
  | 'sign-channel-unavailable'
  | 'sign-declined'

/** 一次工具动作的结果：`ok=false` 时 `code` 是机器面、`text` 是人读回执（文案一律来自语言包）。 */
export type ReleaseResult<T> = ({ ok: true } & T) | { ok: false; code: ReleaseRejectCode; text: string }

/** 拒绝回执（一处收口：所有动作都以同样的形状说话）。 */
function reject(code: ReleaseRejectCode, key: string, params: Record<string, string | number> = {}): {
  ok: false
  code: ReleaseRejectCode
  text: string
} {
  return { ok: false, code, text: fmt(key, params) }
}

/** 调用方**不许**填的那两个字段（收到就拒：那一刻由工具取，见模块注释 ②）。 */
function forbiddenFrozenArgs(input: { frozenAtSeq?: unknown; frozenBy?: unknown }): boolean {
  return input.frozenAtSeq !== undefined || input.frozenBy !== undefined
}

/* ———————————————————————————————— show ———————————————————————————————— */

export interface ReleaseShowResult {
  ok: true
  /** 台账里有几份 release（0 是合法读数：这套机制还没被采纳）。 */
  releases: number
  current?: Release | undefined
  /** 当前版的集合（`undefined` = 一份 release 都没有）。 */
  sets?: ReleaseSets | undefined
  frozen: boolean
  signatures: SignatureReadout
  /** 三条判据侧读数（`show` 只读它们，不改台账）。 */
  findings: {
    freeze: ReleaseTraceFinding[]
    defer: ReleaseTraceFinding[]
    change: ReleaseChangeFinding[]
  }
  text: string
}

/**
 * `action=show`：**只读**回报当前发布计划（当前版、scope / nonScope 计数、冻结状态、判据侧读数）。
 *
 * 为什么把三条判据读数一起摆出来：落盘/变更前最常问的两件事就是"现在算不算绿""哪一条会红" ——
 * 让读者自己去跑三个工具或一段脚本，等于把这两件事留在门外。
 */
export function releaseShow(ledger: ReleaseLedger): ReleaseResult<ReleaseShowResult> {
  let releases: Release[]
  try {
    releases = listReleases(ledger.store)
  } catch (error) {
    return reject('read-failed', 'uiRelease.kReleaseReadFailed', { p1: error instanceof Error ? error.message : String(error) })
  }
  const events = ledger.journal.read().events
  const current = currentRelease(releases)
  const lines: string[] = [fmt('uiRelease.kReleaseShowHeader', { p1: String(releases.length) })]
  if (releases.length === 0) lines.push(t('uiRelease.kReleaseShowNone'))
  for (const release of releases) {
    const sets = releaseSets(release)
    lines.push(fmt('uiRelease.kReleaseShowRow', {
      p1: release.id,
      p2: String(sets.requirements.length),
      p3: String(sets.acceptance.length),
      p4: String(sets.nonScope.length),
      p5: textOf(release.frozenBy).trim() === HUMAN_APPROVER && typeof release.frozenAtSeq === 'number' ? 'true' : 'false',
      p6: String(release.frozenAtSeq ?? '-'),
    }))
  }
  const signatures = signatureReadout(events, current?.id ?? '')
  const findings = {
    freeze: current === undefined ? [] : freezeTraceFindings({ releases, events }),
    defer: current === undefined
      ? []
      : deferTraceFindings({
        releases,
        settled: settledIdsOf(ledger.store),
        deferredRecords: deferredRecordIdsOf(ledger.journal),
        limit: deferLimitOf(ledger.store),
      }),
    change: changeTraceFindings({ releases, events }),
  }
  if (current !== undefined) {
    lines.push(fmt('uiRelease.kReleaseShowCurrent', { p1: current.id, p2: packageVersionOf(current) }))
    if (typeof current.frozenAtSeq === 'number') {
      lines.push(fmt('uiRelease.kReleaseShowFrozenAt', { p1: String(current.frozenAtSeq) }))
    }
    const pending = signatures.pending
    if (pending === undefined) {
      lines.push(t('uiRelease.kReleaseShowNoPending'))
    } else {
      lines.push(fmt('uiRelease.kReleaseShowPending', {
        p1: String(pending.seq),
        p2: pending.kind,
        p3: pending.at === '' ? '-' : pending.at,
      }))
    }
  }
  const rows = [
    ...findings.freeze.map((item) => fmt('uiRelease.kReleaseShowFindingRow', { p1: 'freeze', p2: item.kind, p3: item.subjectId })),
    ...findings.defer.map((item) => fmt('uiRelease.kReleaseShowFindingRow', { p1: 'defer', p2: item.kind, p3: item.subjectId })),
    ...findings.change.map((item) => fmt('uiRelease.kReleaseShowFindingRow', { p1: 'change', p2: item.kind, p3: item.subjectId })),
  ]
  if (current === undefined) {
    // 一份 release 都没有：三条判据都"**不判**"（不是绿）—— 回执必须说清这件事，别让"没说红"被读成绿
    lines.push(t('uiRelease.kReleaseShowNoJudgement'))
  } else if (rows.length === 0) {
    lines.push(t('uiRelease.kReleaseShowClean'))
  } else {
    lines.push(t('uiRelease.kReleaseShowFindingsHeader'))
    lines.push(...rows)
  }
  return {
    ok: true,
    releases: releases.length,
    ...(current === undefined ? {} : { current, sets: releaseSets(current) }),
    frozen: current !== undefined && textOf(current.frozenBy).trim() === HUMAN_APPROVER && typeof current.frozenAtSeq === 'number',
    signatures,
    findings,
    text: lines.join('\n'),
  }
}

/* ———————————————————————————————— propose ———————————————————————————————— */

export interface ReleaseProposeInput {
  /** 提案针对的 release id（`r-x.y.z`，允许后缀）。 */
  id: string
  /** 包版本号（缺省从 id 的 `x.y.z` 段取）。 */
  packageVersion?: string | undefined
}

export interface ReleaseProposeResult {
  ok: true
  /** 提案本体（**没有落盘**：这是内存里的一份 `Release`）。 */
  proposal: Release
  sets: ReleaseSets
  /** 承接的顺延项（来自当前版 nonScope、且还没终结）。 */
  carried: string[]
  /** 已在冻结版本 scope 里（已交付），因此不进本版的实体。 */
  delivered: string[]
  /** 两条判据的**预演**（把提案当成"已落盘"去算）。 */
  preview: {
    freeze: ReleaseTraceFinding[]
    defer: ReleaseTraceFinding[]
  }
  text: string
}

/**
 * `action=propose`：按台账**现算**一份提案，**只回显不落盘**，并预演 freeze / defer 两条判据。
 *
 * 现算口径（三条，全部可从台账复算，不含猜测）：
 * ① `scope.requirements` = 台账里 `status ∈ {baselined, changed}`、`priority ≠ wont`、且**不在任何已冻结
 *    release 的 scope 里**的需求 id（后者 = 已交付的承诺，历史不重写、也不该再进本版）；
 * ② `scope.acceptance` 一律 **空**：现存 `r-0.1.7` 的读数就是 `acceptance: []`，提案不擅自把上千条 AC
 *    塞进集合（要把某条 AC 拉进本版，由人在 `change` / `write` 里显式点名）；
 * ③ `nonScope` = 承接**当前版**（`currentRelease`）的顺延登记里**仍未终结**的条目，`deferCount` **+1**
 *    （它们又要被顺延一版了）—— 超过上限的那几条会在预演里被点名，由用户裁决，工具不放宽。
 *
 * **不写盘**这一条不是靠自律：本函数只读 `store`（`listReleases` / `listRequirements` / `listDefects` /
 * `listTasks`），写盘口只有 `writeRelease`，它在本函数里一次都没被调用。
 */
export function releasePropose(ledger: ReleaseLedger, input: ReleaseProposeInput): ReleaseResult<ReleaseProposeResult> {
  const id = textOf(input.id).trim()
  let releases: Release[]
  try {
    releases = listReleases(ledger.store)
  } catch (error) {
    return reject('read-failed', 'uiRelease.kReleaseReadFailed', { p1: error instanceof Error ? error.message : String(error) })
  }
  const current = currentRelease(releases)
  // ① 需求面：基线过、不是 wont、且还没被任何一个**已冻结**的版本收进 scope
  const delivered = new Set<string>()
  for (const release of releases) {
    const frozen = textOf(release.frozenBy).trim() === HUMAN_APPROVER && typeof release.frozenAtSeq === 'number'
    if (!frozen) continue
    for (const requirementId of releaseSets(release).requirements) delivered.add(requirementId)
  }
  const requirements: string[] = []
  for (const requirement of listRequirements(ledger.store)) {
    const status = String(requirement.status)
    if (status !== 'baselined' && status !== 'changed') continue
    if (String(requirement.priority ?? '') === 'wont') continue
    if (delivered.has(requirement.id)) continue
    requirements.push(requirement.id)
  }
  // ② 判定"还欠着"的 id（`failClosed` 的未规划者不在这里出现：提案只写台账里点得出名字的东西）
  const settled = new Set(settledIdsOf(ledger.store))
  const carried: ReleaseNote[] = []
  const carriedIds: string[] = []
  for (const note of current?.nonScope ?? []) {
    const entityId = textOf(note.id).trim()
    if (entityId === '' || settled.has(entityId)) continue
    carriedIds.push(entityId)
    carried.push({
      id: entityId,
      reason: textOf(note.reason).trim(),
      deferCount: (Number.isInteger(note.deferCount) ? note.deferCount : 0) + 1,
      approvedBy: HUMAN_APPROVER,
    })
  }
  // 同一实体不能既进 scope 又不进：承接来的 id 从 scope 提议里让位（顺延登记是更具体的声明）
  const carriedSet = new Set(carriedIds)
  const proposal: Release = {
    id,
    ...(textOf(input.packageVersion).trim() === '' ? {} : { packageVersion: textOf(input.packageVersion).trim() }),
    scope: { requirements: normalizeIds(requirements.filter((item) => !carriedSet.has(item))), acceptance: [] },
    nonScope: carried,
  }
  const problems = releaseShapeProblems(proposal)
  if (problems.length > 0) return reject('shape', 'uiRelease.kRejectShape', { p1: problems.join(' / ') })
  const sets = releaseSets(proposal)
  // ③ 预演：把提案当成"已在册的一份"去算两条判据（**只读**：`freezeTraceFindings` 与
  //    `deferTraceFindings` 都是纯函数，不碰台账）
  const virtual = [...releases.filter((item) => item.id !== proposal.id), proposal]
  const preview = {
    freeze: freezeTraceFindings({ releases: virtual, events: ledger.journal.read().events }),
    defer: deferTraceFindings({
      releases: virtual,
      settled: [...settled],
      deferredRecords: deferredRecordIdsOf(ledger.journal),
      limit: deferLimitOf(ledger.store),
    }),
  }
  const previewLine = (findings: readonly (ReleaseTraceFinding | ReleaseChangeFinding)[]): string => (
    findings.length === 0
      ? t('uiRelease.kProposePreviewClean')
      : findings.map((item) => `${item.kind}:${item.subjectId}`).join(' ')
  )
  const lines = [
    fmt('uiRelease.kProposeHeader', { p1: proposal.id, p2: packageVersionOf(proposal) }),
    fmt('uiRelease.kProposeCounts', {
      p1: String(sets.requirements.length),
      p2: String(sets.acceptance.length),
      p3: String(sets.nonScope.length),
      p4: String(carriedIds.length),
    }),
    fmt('uiRelease.kProposeRequirements', {
      p1: sets.requirements.length === 0 ? t('uiRelease.kProposeNone') : sets.requirements.join(' '),
    }),
  ]
  if (carriedIds.length > 0) lines.push(fmt('uiRelease.kProposeCarried', { p1: carriedIds.join(' ') }))
  if (delivered.size > 0) lines.push(fmt('uiRelease.kProposeDelivered', { p1: [...delivered].sort().join(' ') }))
  lines.push(t('uiRelease.kProposePreviewHeader'))
  lines.push(fmt('uiRelease.kProposePreviewFreeze', { p1: previewLine(preview.freeze) }))
  lines.push(fmt('uiRelease.kProposePreviewDefer', { p1: previewLine(preview.defer) }))
  lines.push(t('uiRelease.kProposeNoWrite'))
  return {
    ok: true,
    proposal,
    sets,
    carried: normalizeIds(carriedIds),
    delivered: [...delivered].sort(),
    preview,
    text: lines.join('\n'),
  }
}

/* ———————————————————————————————— sign ———————————————————————————————— */

export interface ReleaseNonScopeInput {
  id: string
  reason?: string | undefined
  deferCount?: number | undefined
}

export interface ReleaseSignInput {
  /** 签哪一份 release。 */
  id: string
  /** 这份签字给哪种动作（`write` = 冻结落盘；`change` = 改已冻结集合）。 */
  kind: 'write' | 'change'
  packageVersion?: string | undefined
  /** `kind=write` 时**要签的**三面集合；缺省 ⇒ 签**现盘**那一份。 */
  requirements?: readonly string[] | undefined
  acceptance?: readonly string[] | undefined
  nonScope?: readonly ReleaseNonScopeInput[] | undefined
  /** `kind=change` 时这一份签字批准的具体改动。 */
  add?: readonly string[] | undefined
  remove?: readonly string[] | undefined
  reason?: string | undefined
  /** 用户所选选项的**原文**（宿主回传，不经过模型）。 */
  label: string
  /** 作答时刻（宿主交回选项的那一刻）。 */
  answeredAt: string
}

export interface ReleaseSignResult {
  ok: true
  release: Release
  sets: ReleaseSets
  digest: string
  /** 这条人签在真源里的序号（`write` / `change` 会消费它）。 */
  seq: number
  text: string
}

/** 把入参的 nonScope 条目补成合法形状（`approvedBy` 固定 human：批准权只认人）。 */
function nonScopeOf(entries: readonly ReleaseNonScopeInput[] | undefined, release: Release | undefined): ReleaseNote[] {
  const out: ReleaseNote[] = []
  for (const entry of entries ?? []) {
    const entityId = textOf(entry.id).trim()
    if (entityId === '') continue
    const existing = (release?.nonScope ?? []).find((note) => textOf(note.id).trim() === entityId)
    out.push({
      id: entityId,
      reason: textOf(entry.reason).trim() === '' ? textOf(existing?.reason).trim() : textOf(entry.reason).trim(),
      deferCount: Number.isInteger(entry.deferCount) ? Number(entry.deferCount) : (existing?.deferCount ?? 0),
      approvedBy: HUMAN_APPROVER,
    })
  }
  return out
}

/**
 * 把 `kind=change` 的 add / remove 应用到一份**已冻结**的 release 上（纯函数；`change` 与 `sign` 共用一处
 * 口径 —— 签字时算出的"改完长什么样"与真正落盘时算出的必须是同一份，否则 digest 立刻对不上）。
 */
export function applyChange(
  release: Release,
  add: readonly string[],
  remove: readonly string[],
  reason: string,
  deferCountOf: (id: string) => number = () => 0,
): Release {
  const sets = releaseSets(release)
  const added = normalizeIds(add)
  const removed = normalizeIds(remove)
  // `AC-` 前缀的 id 进 `scope.acceptance`，其余进 `scope.requirements`（"加一个 id"只有这两种落法；
  // 前缀判不了别的语义 —— 前缀本身就是本仓唯一的 id 约定）
  const addedAcceptance = added.filter((id) => id.startsWith('AC-'))
  const addedRequirements = added.filter((id) => !id.startsWith('AC-'))
  const nextRequirements = sets.requirements
    .filter((id) => !removed.includes(id))
    .concat(addedRequirements.filter((id) => !sets.requirements.includes(id)))
  const nextAcceptance = sets.acceptance
    .filter((id) => !removed.includes(id))
    .concat(addedAcceptance.filter((id) => !sets.acceptance.includes(id)))
  // 移出 scope 的 id 必须**同时登记进 nonScope**：只从范围里消失、没有任何顺延记录＝静默顺延（`AC-277`）
  const nextNotes: ReleaseNote[] = (release.nonScope ?? []).filter((note) => !added.includes(textOf(note.id).trim()))
  for (const entityId of removed) {
    if (nextNotes.some((note) => textOf(note.id).trim() === entityId)) continue
    const prior = (release.nonScope ?? []).find((note) => textOf(note.id).trim() === entityId)
    nextNotes.push({
      id: entityId,
      reason: reason === '' ? textOf(prior?.reason).trim() : reason,
      deferCount: deferCountOf(entityId),
      approvedBy: HUMAN_APPROVER,
    })
  }
  const { frozenAtSeq: _seq, frozenBy: _by, ...rest } = release
  void _seq
  void _by
  return {
    ...(rest as Release),
    scope: { requirements: normalizeIds(nextRequirements), acceptance: normalizeIds(nextAcceptance) },
    nonScope: nextNotes,
  }
}

/** 这份 release 的**冻结记号**（已冻结 ⇒ 返回两个字段；没冻结 ⇒ `undefined`）。 */
function keepFrozenOf(release: Release | undefined): KeepFrozen | undefined {
  if (release === undefined) return undefined
  if (textOf(release.frozenBy).trim() !== HUMAN_APPROVER) return undefined
  if (typeof release.frozenAtSeq !== 'number') return undefined
  return { frozenBy: HUMAN_APPROVER, frozenAtSeq: release.frozenAtSeq }
}

/** 某实体在**全部** release 的 nonScope 里记过的最大顺延次数（没有记录 ⇒ 0）。 */
function priorDeferCount(releases: readonly Release[], entityId: string): number {
  let max = 0
  for (const release of releases) {
    for (const note of release.nonScope ?? []) {
      if (textOf(note.id).trim() !== entityId) continue
      const count = Number(note.deferCount)
      if (Number.isInteger(count) && count > max) max = count
    }
  }
  return max
}

/**
 * `action=sign` 的**落账半**（人机交互在工具层：先问、拿到用户所选选项原文，再落到这里）。
 *
 * 记的是**这一份签字管什么**：`kind`（落盘 / 变更）、三面集合的 digest、`add` / `remove` / `reason`
 * （`kind=change` 时）与作答时刻。于是 `write` / `change` 都能回答同一个问题：
 * 「我这次要做的，是不是用户**那一份**签过的东西」。
 */
export function releaseSign(ledger: ReleaseLedger, input: ReleaseSignInput): ReleaseResult<ReleaseSignResult> {
  const id = textOf(input.id).trim()
  if (id === '') return reject('shape', 'uiRelease.kRejectShape', { p1: 'id' })
  let disk: Release | undefined
  let releases: Release[] = []
  try {
    releases = listReleases(ledger.store)
    disk = readRelease(ledger.store, id)
  } catch (error) {
    return reject('read-failed', 'uiRelease.kReleaseReadFailed', { p1: error instanceof Error ? error.message : String(error) })
  }
  const add = normalizeIds(input.add ?? [])
  const remove = normalizeIds(input.remove ?? [])
  const reason = textOf(input.reason).trim()
  let target: Release
  if (input.kind === 'change') {
    if (disk === undefined) return reject('no-release', 'uiRelease.kRejectNoRelease', { p1: id })
    if (textOf(disk.frozenBy).trim() !== HUMAN_APPROVER || typeof disk.frozenAtSeq !== 'number') {
      return reject('not-frozen', 'uiRelease.kRejectNotFrozen', { p1: id })
    }
    target = applyChange(disk, add, remove, reason, (entityId) => priorDeferCount(releases, entityId) + 1)
  } else if (input.requirements === undefined && input.acceptance === undefined && input.nonScope === undefined) {
    if (disk === undefined) return reject('no-release', 'uiRelease.kSignNoRelease', { p1: id })
    target = disk
  } else {
    target = {
      id,
      ...(textOf(input.packageVersion).trim() === '' ? {} : { packageVersion: textOf(input.packageVersion).trim() }),
      scope: {
        requirements: normalizeIds(input.requirements ?? []),
        acceptance: normalizeIds(input.acceptance ?? []),
      },
      nonScope: nonScopeOf(input.nonScope, disk),
    }
  }
  // 签字时就把形状关过一遍：签一份写不下去的集合，等于让用户白签一次
  const signProblems = releaseShapeProblems({ ...target, frozenBy: HUMAN_APPROVER, frozenAtSeq: 1 })
  if (signProblems.length > 0) return reject('shape', 'uiRelease.kRejectShape', { p1: signProblems.join(' / ') })
  const sets = releaseSets(target)
  const digest = setsDigest(sets)
  const data: Record<string, unknown> = {
    id,
    kind: input.kind,
    by: HUMAN_APPROVER,
    channel: 'question',
    label: textOf(input.label).trim(),
    answeredAt: textOf(input.answeredAt).trim(),
    digest,
    requirements: sets.requirements.length,
    acceptance: sets.acceptance.length,
    nonScope: sets.nonScope.length,
  }
  if (add.length > 0) data['add'] = add
  if (remove.length > 0) data['remove'] = remove
  if (reason !== '') data['reason'] = reason
  const sink: ReleaseEventSink = ledger.journal
  const event = sink.append(RELEASE_SIGNED_EVENT, data)
  const seq = event !== null && typeof event === 'object' && 'seq' in event ? Number((event as { seq: unknown }).seq) : 0
  return {
    ok: true,
    release: target,
    sets,
    digest,
    seq,
    text: fmt('uiRelease.kSignDone', { p1: String(seq), p2: input.kind, p3: digest.slice(0, 12) }),
  }
}

/* ———————————————————————————————— write ———————————————————————————————— */

export interface ReleaseWriteInput {
  id: string
  packageVersion?: string | undefined
  requirements?: readonly string[] | undefined
  acceptance?: readonly string[] | undefined
  nonScope?: readonly ReleaseNonScopeInput[] | undefined
  /** **陷阱参数**：收到就拒（那一刻由工具取真实序号，见模块注释 ②）。 */
  frozenAtSeq?: unknown
  frozenBy?: unknown
}

export interface ReleaseWriteResult {
  ok: true
  release: Release
  sets: ReleaseSets
  /** 第一段（不冻结）落盘的事件序号。 */
  anchorSeq: number
  /** `frozenAtSeq` 指向的那条**带签字落盘**的序号。 */
  frozenSeq: number
  text: string
}

/**
 * `action=write`：**仅当已有待用人签**时落盘；`frozenAtSeq` 由工具取真实事件序号。
 *
 * 三道闸，缺一不可：
 * ① **不许调用方填 `frozenAtSeq` / `frozenBy`** —— 手填就把"那一刻真的一次人签"降级成一句自述
 *    （`freeze-unwitnessed` 就是专门抓它的判据）；
 * ② **必须有待用人签**（`action=sign` 落的 `release/signed`，且之后还没有人签落盘消费它）：
 *    没有 ⇒ 拒绝，绝不"先写下来再补签"；
 * ③ **签的那一份必须就是写的这一份**（集合 digest 逐面比对）：用户签 A、工具写 B 也是代签的一种。
 */
export function releaseWrite(ledger: ReleaseLedger, input: ReleaseWriteInput): ReleaseResult<ReleaseWriteResult> {
  if (forbiddenFrozenArgs(input)) return reject('frozen-at-seq-forbidden', 'uiRelease.kRejectFrozenAtSeq')
  const id = textOf(input.id).trim()
  if (id === '') return reject('shape', 'uiRelease.kRejectShape', { p1: 'id' })
  let disk: Release | undefined
  try {
    disk = readRelease(ledger.store, id)
  } catch (error) {
    return reject('read-failed', 'uiRelease.kReleaseReadFailed', { p1: error instanceof Error ? error.message : String(error) })
  }
  const release: Release = {
    id,
    ...(textOf(input.packageVersion).trim() === '' ? {} : { packageVersion: textOf(input.packageVersion).trim() }),
    // 三面集合**一个都没给** ⇒ 写成"现盘那一份"（重新落一次同一份集合**不是**在猜：用户签的就是它）。
    // 一份盘上没有、参数里也没有的集合**不许**落成空集合 —— 那会把"没规划"写成"本版什么都不做"。
    scope: {
      requirements: normalizeIds(input.requirements ?? disk?.scope.requirements ?? []),
      acceptance: normalizeIds(input.acceptance ?? disk?.scope.acceptance ?? []),
    },
    nonScope: input.nonScope === undefined
      ? (disk?.nonScope ?? []).map((note) => ({ ...note }))
      : nonScopeOf(input.nonScope, disk),
  }
  if (disk === undefined && input.requirements === undefined && input.acceptance === undefined && input.nonScope === undefined) {
    return reject('shape', 'uiRelease.kRejectShape', { p1: 'scope' })
  }
  const problems = releaseShapeProblems({ ...release, frozenBy: HUMAN_APPROVER, frozenAtSeq: 1 })
  if (problems.length > 0) return reject('shape', 'uiRelease.kRejectShape', { p1: problems.join(' / ') })
  const sets = releaseSets(release)
  const digest = setsDigest(sets)
  const signature = signatureReadout(ledger.journal.read().events, id).pending
  if (signature === undefined || signature.kind !== 'write') return reject('signature-missing', 'uiRelease.kRejectSignatureMissing')
  if (signature.digest !== digest) {
    return reject('signature-mismatch', 'uiRelease.kRejectSignatureMismatch', {
      p1: signature.digest.slice(0, 12),
      p2: digest.slice(0, 12),
    })
  }
  const outcome = writeFrozen(ledger, release, keepFrozenOf(disk))
  return {
    ok: true,
    release: outcome.release,
    sets: releaseSets(outcome.release),
    anchorSeq: outcome.anchorSeq,
    frozenSeq: outcome.frozenSeq,
    text: fmt('uiRelease.kToolWriteDone', {
      p1: outcome.release.id,
      p2: String(outcome.anchorSeq),
      p3: String(outcome.release.frozenAtSeq ?? '-'),
    }),
  }
}

/* ———————————————————————————————— change ———————————————————————————————— */

export interface ReleaseChangeRequest {
  id: string
  add?: readonly string[] | undefined
  remove?: readonly string[] | undefined
  reason: string
  approvedBy: string
  /** **陷阱参数**：收到就拒（见 `write` 的同名说明）。 */
  frozenAtSeq?: unknown
  frozenBy?: unknown
}

export interface ReleaseChangeResult {
  ok: true
  release: Release
  before: ReleaseSets
  after: ReleaseSets
  added: string[]
  removed: string[]
  /** 变更事件（`release/changed`）的序号。 */
  seq: number
  /** 这次变更的人签序号（真源里核得到的那一条）。 */
  signatureSeq: number
  anchorSeq: number
  frozenSeq: number
  text: string
}

/**
 * `action=change`：改**已冻结**的集合（`scope` / `nonScope` 的增删），走一条**可核**的变更路径。
 *
 * 与 `write` 同的是"必须有人签"，不同的是**签的是哪一份**：`change` 的签字
 * （`action=sign kind=change` 落的 `release/signed`）记着 `add` / `remove` / `reason` —— 于是"这一次变更"
 * 与"那一次人签"是同一个东西，而不是"这一版有一次签字所以之后随便改"（那正是 `C-75` 要判红的形态）。
 *
 * 落盘顺序：先 `release/changed`（前后计数 + id 差集），再两段写（见 {@link writeFrozen}）——
 * 事件先于文件，是为了让"文件改了但事件没落"这种半成品在任何时刻都能被读出来（`changeTraceFindings`）。
 */
export function releaseChange(ledger: ReleaseLedger, input: ReleaseChangeRequest): ReleaseResult<ReleaseChangeResult> {
  if (forbiddenFrozenArgs(input)) return reject('frozen-at-seq-forbidden', 'uiRelease.kRejectFrozenAtSeq')
  const id = textOf(input.id).trim()
  if (id === '') return reject('shape', 'uiRelease.kRejectShape', { p1: 'id' })
  const reason = textOf(input.reason).trim()
  if (reason === '') return reject('reason-missing', 'uiRelease.kRejectReason')
  if (textOf(input.approvedBy).trim() !== HUMAN_APPROVER) return reject('approver-not-human', 'uiRelease.kRejectApprover')
  const add = normalizeIds(input.add ?? [])
  const remove = normalizeIds(input.remove ?? [])
  if (add.length === 0 && remove.length === 0) return reject('ids-empty', 'uiRelease.kRejectIds')
  const conflicted = add.filter((item) => remove.includes(item))
  if (conflicted.length > 0) return reject('id-conflict', 'uiRelease.kRejectIdConflict', { p1: conflicted.join(' ') })

  let releases: Release[] = []
  let disk: Release | undefined
  try {
    releases = listReleases(ledger.store)
    disk = readRelease(ledger.store, id)
  } catch (error) {
    return reject('read-failed', 'uiRelease.kReleaseReadFailed', { p1: error instanceof Error ? error.message : String(error) })
  }
  if (disk === undefined) return reject('no-release', 'uiRelease.kRejectNoRelease', { p1: id })
  // ① 冻结前不许 change：一份没签字的草稿本来就该直接改（没有可变更的对象）
  if (textOf(disk.frozenBy).trim() !== HUMAN_APPROVER || typeof disk.frozenAtSeq !== 'number') {
    return reject('not-frozen', 'uiRelease.kRejectNotFrozen', { p1: id })
  }
  const before = releaseSets(disk)
  const alreadyIn = add.filter((item) => before.requirements.includes(item) || before.acceptance.includes(item))
  if (alreadyIn.length > 0) {
    return reject('id-already-in-scope', 'uiRelease.kRejectIdAlready', { p1: alreadyIn.join(' '), p2: id })
  }
  const notInScope = remove.filter((item) => !before.requirements.includes(item) && !before.acceptance.includes(item))
  if (notInScope.length > 0) {
    return reject('id-not-in-scope', 'uiRelease.kRejectIdNotInScope', { p1: notInScope.join(' '), p2: id })
  }
  const next = applyChange(disk, add, remove, reason, (entityId) => priorDeferCount(releases, entityId) + 1)
  const after = releaseSets(next)
  const addedIds = minus(after.requirements.concat(after.acceptance), before.requirements.concat(before.acceptance))
  const removedIds = minus(before.requirements.concat(before.acceptance), after.requirements.concat(after.acceptance))
  for (const entityId of removedIds) {
    if (!after.nonScope.includes(entityId)) {
      return reject('id-not-in-non-scope', 'uiRelease.kRejectIdNotInNonScope', { p1: entityId, p2: id })
    }
  }
  const problems = releaseShapeProblems({ ...next, frozenBy: HUMAN_APPROVER, frozenAtSeq: 1 })
  if (problems.length > 0) return reject('shape', 'uiRelease.kRejectShape', { p1: problems.join(' / ') })
  // ② 这一次变更必须能核到**那一次人签**：签字里记着 add / remove / reason（同一条口径，不认"这一版签过字"）
  const signature = signatureReadout(ledger.journal.read().events, id).pending
  if (signature === undefined || signature.kind !== 'change') return reject('signature-missing', 'uiRelease.kRejectSignatureMissing')
  if (
    signature.digest !== setsDigest(after)
    || !sameSet(signature.add, add)
    || !sameSet(signature.remove, remove)
    || signature.reason !== reason
  ) {
    return reject('change-unsigned', 'uiRelease.kRejectChangeUnsigned', { p1: String(signature.seq) })
  }
  const sink: ReleaseEventSink = ledger.journal
  const event = sink.append(RELEASE_CHANGED_EVENT, {
    id,
    reason,
    approvedBy: HUMAN_APPROVER,
    signedAtSeq: signature.seq,
    before: {
      requirements: before.requirements,
      acceptance: before.acceptance,
      nonScope: before.nonScope,
    },
    after: {
      requirements: after.requirements,
      acceptance: after.acceptance,
      nonScope: after.nonScope,
    },
    added: addedIds,
    removed: removedIds,
    beforeCounts: { requirements: before.requirements.length, acceptance: before.acceptance.length, nonScope: before.nonScope.length },
    afterCounts: { requirements: after.requirements.length, acceptance: after.acceptance.length, nonScope: after.nonScope.length },
  })
  const seq = event !== null && typeof event === 'object' && 'seq' in event ? Number((event as { seq: unknown }).seq) : 0
  const outcome = writeFrozen(ledger, next, keepFrozenOf(disk))
  return {
    ok: true,
    release: outcome.release,
    before,
    after: releaseSets(outcome.release),
    added: addedIds,
    removed: removedIds,
    seq,
    signatureSeq: signature.seq,
    anchorSeq: outcome.anchorSeq,
    frozenSeq: outcome.frozenSeq,
    text: [
      fmt('uiRelease.kToolChangeDone', {
        p1: outcome.release.id,
        p2: String(seq),
        p3: addedIds.length === 0 ? '-' : addedIds.join(' '),
        p4: removedIds.length === 0 ? '-' : removedIds.join(' '),
        p5: `${before.requirements.length}/${before.acceptance.length}/${before.nonScope.length}`,
        p6: `${after.requirements.length}/${after.acceptance.length}/${after.nonScope.length}`,
      }),
      fmt('uiRelease.kToolChangeReason', { p1: reason, p2: HUMAN_APPROVER, p3: String(signature.seq) }),
    ].join('\n'),
  }
}

/* ———————————————————————————————— 工具面（注册出口） ———————————————————————————————— */

/** 一次签字问询的**形状**（由工具拼好、宿主原样渲染；选项原文由宿主交回）。 */
export interface ReleaseAskRequest {
  header: string
  question: string
  detail: string
  options: { label: string; description?: string | undefined }[]
}

/** 用户的作答（`selected` 是**选项原文**；`custom` 是自由文本）。 */
export interface ReleaseAskAnswer {
  selectedLabel: string
  custom?: string | undefined
}

/** 工具行为依赖：由插件入口注入（域层不 import 门面，也不自己拼绝对路径）。 */
export interface ReleaseToolDeps {
  /** 工作区根（与会话 cwd 分开取：与其它工具同一条口径）。认不出时给空串。 */
  workspace(call: ReleaseCall): string
  store(root: string): SdoStore
  journal(root: string): Journal
  /** 人机签字问答通道（宿主没装配 ⇒ `undefined`；那时 `sign` 只能拒绝，不许代签）。 */
  ask?(call: ReleaseCall, request: ReleaseAskRequest): Promise<ReleaseAskAnswer | undefined>
}

/** 解析 JSON 文本参数；也接受已经解好的对象/数组（宿主宽松路径）。解析不出 ⇒ `undefined`。 */
function jsonArg<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object') return value as T
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

/** 一个列表型参数（字符串 / 数组 / JSON 文本都收）。 */
function listArg(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return normalizeIds(value.map((item) => textOf(item)))
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const text = value.trim()
  if (text.startsWith('[')) {
    const parsed = jsonArg<unknown>(text)
    return Array.isArray(parsed) ? normalizeIds(parsed.map((item) => textOf(item))) : undefined
  }
  return normalizeIds(text.split(/[,，;；]/u))
}

const OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
}

/**
 * 建 `sdo_release` 的工具定义（**注册出口**；由 `src/index.ts` 挂进工具面）。
 *
 * 为什么工具定义落在这个文件而不是 `src/interface/tools.ts`：那是**这张卡的写范围**决定的
 * （`TASK-183` 只许动 `src/domain/releaseTool.ts` / `src/index.ts` / 两份语言包 / `test/m222.test.ts`）。
 * 代价是本模块多了一个宿主依赖（`defineTool`），因此**行为与文案**仍然全在本文件与语言包里，
 * 工具定义只做参数解析 —— 与 `interface/tools.ts` 的既有分工一致。
 */
export function createReleaseTool(deps: ReleaseToolDeps): ToolDefinition {
  const ledgerOf = (call: ReleaseCall): ReleaseLedger | undefined => {
    const root = deps.workspace(call)
    if (root === '') return undefined
    return { store: deps.store(root), journal: deps.journal(root) }
  }
  return defineTool({
    name: 'sdo_release',
    // 描述来自语言包的 `sdo.release`（卡片 DoD 点名的位置）
    description: t('sdo.release'),
    parameters: {
      action: { type: 'string', required: true, description: RELEASE_ACTIONS.join(' / ') },
      id: { type: 'string', description: t('param.id') },
      packageVersion: { type: 'string', description: t('uiRelease.kParamPackageVersion') },
      requirements: {
        oneOf: [{ type: 'string' as const }, { type: 'array' as const, items: { type: 'json' as const } }],
        description: t('uiRelease.kParamScopeRequirements'),
      },
      acceptance: {
        oneOf: [{ type: 'string' as const }, { type: 'array' as const, items: { type: 'json' as const } }],
        description: t('uiRelease.kParamScopeAcceptance'),
      },
      nonScope: {
        oneOf: [{ type: 'string' as const }, { type: 'array' as const, items: { type: 'json' as const } }],
        description: t('uiRelease.kParamNonScope'),
      },
      add: {
        oneOf: [{ type: 'string' as const }, { type: 'array' as const, items: { type: 'json' as const } }],
        description: t('uiRelease.kParamAdd'),
      },
      remove: {
        oneOf: [{ type: 'string' as const }, { type: 'array' as const, items: { type: 'json' as const } }],
        description: t('uiRelease.kParamRemove'),
      },
      reason: { type: 'string', description: t('param.reason') },
      approvedBy: { type: 'string', description: t('param.approvedBy') },
      kind: { type: 'string', description: "'write' (freeze/land) | 'change' (edit a frozen set) - only for action=sign." },
      channel: { type: 'string', description: t('uiRelease.kParamSignChannel') },
    },
    output: OUTPUT,
    async execute(args, exec) {
      // 一律**点号**读参数（不用 `args['x']`）：`test/m15` 的 F-7 守卫从**编译产物**里静态抽
      // `args.<名>` 并与 schema 的 properties 对账 —— 方括号写法会让它读不到，那个工具的 schema 与
      // 行为的脱节就再也没有守卫（守卫的盲区比多写几行更贵）。
      const agent = (exec as unknown as { agent?: unknown }).agent
      const releaseCall: ReleaseCall = agent === undefined ? {} : { agent }
      const holder = agent as { session?: { header?: { cwd?: unknown } }; cwd?: unknown } | undefined
      const cwd = holder?.session?.header?.cwd ?? holder?.cwd
      if (typeof cwd === 'string' && cwd !== '') releaseCall.cwd = cwd
      const ledger = ledgerOf(releaseCall)
      const action = textOf(args.action).trim() === '' ? 'show' : textOf(args.action).trim()
      if (!(RELEASE_ACTIONS as readonly string[]).includes(action)) {
        return fmt('uiRelease.kReleaseUnknownAction', { p1: action, p2: RELEASE_ACTIONS.join(' / ') })
      }
      if (ledger === undefined) return t('uiRelease.kReleaseNoWorkspace')
      if (action === 'show') return releaseShow(ledger).text
      const id = textOf(args.id).trim()
      const packageVersion = textOf(args.packageVersion).trim() === '' ? undefined : textOf(args.packageVersion).trim()
      if (action === 'propose') return releasePropose(ledger, { id, packageVersion }).text
      const nonScopeRows = (jsonArg<ReleaseNonScopeInput[]>(args.nonScope) ?? [])
        .filter((row): row is ReleaseNonScopeInput => row !== null && typeof row === 'object')
      if (action === 'sign') {
        const kind = textOf(args.kind).trim() === 'change' ? 'change' : 'write'
        const add = listArg(args.add) ?? []
        const remove = listArg(args.remove) ?? []
        const reason = textOf(args.reason).trim()
        const channel = textOf(args.channel).trim()
        if (channel !== '' && channel !== 'question') {
          // 只认问答通道：`statement` 那条路的引用文本会经过模型之手，那正是代签的入口
          return t('uiRelease.kSignNoChannel')
        }
        if (deps.ask === undefined) return t('uiRelease.kSignNoChannel')
        // 先把"待签内容"从台账现读现算（不经过模型），再发问答卡
        const preview = kind === 'change'
          ? ((): string => {
            let disk: Release | undefined
            try {
              disk = readRelease(ledger.store, id)
            } catch {
              disk = undefined
            }
            if (disk === undefined) return id
            const next = applyChange(disk, add, remove, reason)
            return `${id}: ${describeSets(releaseSets(disk))} -> ${describeSets(releaseSets(next))}`
          })()
          : describeSets({
            requirements: normalizeIds(listArg(args.requirements) ?? []),
            acceptance: normalizeIds(listArg(args.acceptance) ?? []),
            nonScope: normalizeIds(nonScopeRows.map((row) => row.id)),
          })
        const result = await deps.ask(releaseCall, {
          header: 'sdo_release',
          question: kind === 'change'
            ? fmt('uiRelease.kSignQuestionChange', { p1: id, p2: add.concat(remove).join(' ') })
            : fmt('uiRelease.kSignQuestionWrite', { p1: id }),
          detail: [t('uiRelease.kSignDetail'), preview].join('\n'),
          options: [
            { label: t('uiRelease.kSignOption'), description: t('uiRelease.kSignCost') },
            { label: t('uiRelease.kSignDeclineOption'), description: t('uiRelease.kSignDeclineCost') },
          ],
        })
        if (result === undefined) return t('uiRelease.kSignNoChannel')
        if (result.selectedLabel.trim() !== t('uiRelease.kSignOption')) {
          return fmt('uiRelease.kSignDeclined', { p1: result.selectedLabel })
        }
        return releaseSign(ledger, {
          id,
          kind,
          packageVersion,
          requirements: listArg(args.requirements),
          acceptance: listArg(args.acceptance),
          nonScope: nonScopeRows,
          add,
          remove,
          reason,
          label: result.selectedLabel,
          answeredAt: new Date().toISOString(),
        }).text
      }
      // **`frozenAtSeq` / `frozenBy` 不在参数面里**（`M222-01` 钉着这件事），工具面因此**不读**它们 ——
      // 这不是"防到了却不报"：宿主按规定不会把 schema 之外的参数交下来；万一松口径交下来了，
      // 这里也索引不到它们，于是那个值**影响不到任何判定**（`frozenAtSeq` 永远由工具从真源取）。
      // 域层（`releaseWrite` / `releaseChange`）另有一道口：显式传进来就**拒**（`frozen-at-seq-forbidden`）。
      if (action === 'write') {
        return releaseWrite(ledger, {
          id,
          packageVersion,
          requirements: listArg(args.requirements),
          acceptance: listArg(args.acceptance),
          nonScope: nonScopeRows,
        }).text
      }
      return releaseChange(ledger, {
        id,
        add: listArg(args.add),
        remove: listArg(args.remove),
        reason: textOf(args.reason).trim(),
        approvedBy: textOf(args.approvedBy).trim(),
      }).text
    },
  })
}
