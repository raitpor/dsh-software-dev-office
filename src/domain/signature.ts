/**
 * **门禁级用户签字**（规格 §7.2）—— 与"逐条确认戳"（`design/confirmed.yml`）是两个层级：
 * 逐条确认管"每个元素/契约/界面条目对不对"，本模块管"**整个门禁**由用户批准放行"。
 *
 * 三条硬规则（§7.2 原文口径）：
 *   ① **来源只承认两种**：① 用户在会话中**明确表述**签字确认；② 用户在**人机关口问答**
 *      里**明确选择**签字选项。工具是模型调的 → 模型技术上能"替用户签"，
 *      因此下面第 ②' 条是**唯一**可审计的保障。
 *   ②' **签字必须带引用文本**：用户原话引用或所选选项原文（`basis`）。空引用 → **签字无效**。
 *      模型若凭空记录，引用对不上即暴露。
 *   ③ **未签字 → 该门禁不可通过**（其余判据全绿也不行）；签字后**真源变更 → 签字失效**
 *      （按 journal 序号比较；每个门禁有自己的失效事件集合，见 `types.ts` 的
 *      `G2_SIGNATURE_INVALIDATING_EVENTS` 与 `SIGNATURE_INVALIDATING_EVENTS`）。
 *
 * 落盘：`.sdo/gates/signatures.yml`（追加式，同一门禁保留全部历史，取**最新一条**判定）。
 */
import type { Journal } from '../infra/journal.js'
import { pushShapeNote, recordListOf, textOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import type { SdoStore } from '../infra/store.js'
import { G2_SIGNATURE_INVALIDATING_EVENTS, isNeutralEvent, isSignatureInvalidatingEvent } from '../types.js'
import type { GateSignature } from '../types.js'
import { fmt, t } from './i18n.js'

/** 签字台账文件（`.sdo/gates/signatures.yml`）。 */
export const SIGNATURES_FILE = 'signatures.yml'

/**
 * 读签字台账并**做形状归一化**（F-21 ①）。
 *
 * `.sdo/gates/signatures.yml` 是手可编辑真源：`signatures` 是记录列表，
 * 手写成标量会让 `listSignatures().filter` 抛异常（`?? []` 只挡住 null/undefined）。
 */
export function readSignaturesChecked(
  store: SdoStore,
): { signatures: GateSignature[]; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ signatures: unknown }>('gates', SIGNATURES_FILE)?.signatures
  if (raw === undefined || raw === null) return { signatures: [], notes: [] }
  const read = recordListOf<GateSignature>(raw, (text) => ({ gate: text, by: '', basis: '', channel: 'command', at: '', atSeq: 0 }))
  pushShapeNote(notes, 'signature', SIGNATURES_FILE, 'signatures', read.issue)
  const signatures = read.value.map((item) => ({
    ...item,
    gate: textOf(item.gate),
    by: textOf(item.by),
    basis: textOf(item.basis),
    channel: textOf(item.channel) as GateSignature['channel'],
    at: textOf(item.at),
    atSeq: typeof item.atSeq === 'number' && Number.isFinite(item.atSeq) ? item.atSeq : Number(textOf(item.atSeq)) || 0,
    ...(item.turn === undefined ? {} : { turn: textOf(item.turn) }),
  }))
  return { signatures, notes }
}

/** 全部签字记录（按落盘顺序）。 */
export function listSignatures(store: SdoStore): GateSignature[] {
  return readSignaturesChecked(store).signatures
}

/** 签字台账上的形状提示（回执 / 门禁详情共用）。 */
export function signatureShapeNotes(store: SdoStore): FieldShapeNote[] {
  return readSignaturesChecked(store).notes
}

/** 某个门禁**最新**一条签字（历史保留；判定只看最新一条 → 重新签字即可覆盖旧失效签字）。 */
export function latestSignature(store: SdoStore, gate: string): GateSignature | undefined {
  return listSignatures(store)
    .filter((signature) => signature.gate === gate)
    .sort((a, b) => a.atSeq - b.atSeq)
    .at(-1)
}

export interface RecordSignatureInput {
  gate: string
  by: string
  /** 用户原话引用 / 所选选项原文（**必填**） */
  basis: string
  channel: 'command' | 'question'
  turn?: string | undefined
  /** R-7：引用是否与本次会话的用户发言核对过（拿不到会话历史时如实记 `unavailable`） */
  basisChecked?: 'session' | 'unavailable' | undefined
}

/**
 * 记录一次签字。
 *
 * **`basis` 为空即拒绝**（抛错、不落盘）—— 这是"防代签"的唯一机械闸门：
 * 没有引用文本的签字不被承认，门禁照样红。
 */
export function recordSignature(store: SdoStore, journal: Journal, input: RecordSignatureInput): GateSignature {
  const basis = input.basis.trim()
  if (basis === '') {
    throw new Error(t('uiSignature.basisRequired'))
  }
  const by = input.by.trim() === '' ? 'human' : input.by.trim()
  const event = journal.append('gate/signed', {
    gate: input.gate,
    by,
    basis,
    channel: input.channel,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    // R-7：核对口径也要进事件（审计要能看出"这一次到底核没过"）
    ...(input.basisChecked === undefined ? {} : { basisChecked: input.basisChecked }),
  })
  const signature: GateSignature = {
    gate: input.gate,
    by,
    basis,
    channel: input.channel,
    at: event.at,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    ...(input.basisChecked === undefined ? {} : { basisChecked: input.basisChecked }),
    atSeq: event.seq,
  }
  const existing = listSignatures(store)
  store.writeYaml(['gates', SIGNATURES_FILE], { signatures: [...existing, signature] })
  return signature
}

/**
 * 一个门禁签字的状态：缺失 / 无引用（无效） / 已失效 / 有效 / **无法判定**。
 *
 * **`unknown`（第四份评审员报告 §3.1）**：`journal` 被坏行截断时，签字台账（`gates/signatures.yml`）
 * 本身读得动，但"签字之后有没有发生过失效事件"**读不出来** —— 此时绝不能报 `valid`（假绿），
 * 也说不清是 `stale`，只能如实报"无法判定"。
 */
export type SignatureStatus = 'missing' | 'unquoted' | 'stale' | 'valid' | 'unknown'

/** `signatureState` 的**紧凑投影**（D1）：给 `evaluateDor` 这类纯函数用的入参形状。 */
export interface SignoffInput {
  status: SignatureStatus
  reason: string
  signer?: string | undefined
}

/**
 * 把 `signatureState` 压成纯函数入参（D1）。
 *
 * 单点定义的原因：DoR（`office.dor` / `baseline`）与门禁检查器（`dorCriterion`）
 * 必须看到**同一份**签字状态 —— 两处各写一次就会出现"工具回执说有效、门禁说失效"。
 */
export function signoffInput(store: SdoStore, journal: Journal, gate: string): SignoffInput {
  const state = signatureState(store, journal, gate)
  return {
    status: state.status,
    reason: state.reason,
    ...(state.signature === undefined ? {} : { signer: state.signature.by }),
  }
}

export interface SignatureState {
  status: SignatureStatus
  signature?: GateSignature | undefined
  /** 人读理由（回执与门禁 detail 都用它） */
  reason: string
}

/**
 * 判定一个门禁的签字状态（**确定性**：只读台账 + journal，不采信模型自述）。
 *
 * 失效判定用 **journal 序号**而非墙上时钟：签字事件本身的 seq 记在 `atSeq`，
 * 之后只要出现该门禁**自己的**失效事件集合里的任一事件 → 真源变了 → 失效。
 * 为什么不用时间比较：同一毫秒内可发生多条事件（实测测试里大量如此），时间比不出先后。
 *
 * **每个门禁用自己的一份集合**（D1）：G2（需求基线）背书的是需求/项目/问题/风险/红队真源，
 * G3（架构）背书的是设计/契约/需求真源 —— 用一份集合必然漏掉一半（见 `types.ts` 的两份常量）。
 */
export function signatureState(store: SdoStore, journal: Journal, gate: string): SignatureState {
  const signature = latestSignature(store, gate)
  if (signature === undefined) {
    return { status: 'missing', reason: fmt('uiSignature.missing', { p1: gate }) }
  }
  if (textOf(signature.basis).trim() === '') {
    return {
      status: 'unquoted',
      signature,
      reason: fmt('uiSignature.unquoted', { p1: gate, p2: signature.by }),
    }
  }
  const read = journal.read()
  // **§3.1（第四份评审员报告）**：`journal` 被截断时，`read()` 只给"最后一致前缀"，
  // 于是坏行之后写入的失效事件**一条都看不到** —— 旧实现会据此自信地报 `valid`，
  // 把 D1/N-7 的签字失效机制**静默废掉**（实测：截断期改需求后 G3 仍 valid）。
  // 这里如实退成"无法判定"：签字记录读得动，但"之后是否发生过失效"证不出来。
  if (read.truncated) {
    return {
      status: 'unknown',
      signature,
      reason: fmt('uiSignature.truncated', { p1: gate, p2: String(read.badLine ?? '?') }),
    }
  }
  const invalidating = (type: string): boolean => isSignatureInvalidatingEvent(gate, type)
  const changed = read.events.filter((event) => event.seq > signature.atSeq).filter((event) => invalidating(event.type))
  if (changed.length > 0) {
    // **P-13**：只报第一条会把读者指向"早已无关的旧事件"（真因可能是一条**尚未被分类**的新事件）。
    // 现在：列前 3 条（共 N 条），并对中性表里没有的事件类型**明确标注"按保守口径视为真源变更"**。
    const shown = changed.slice(0, 3).map((event) => `#${event.seq} ${event.type}`).join('、')
    const more = changed.length > 3 ? fmt('uiSignature.staleMore', { p1: String(changed.length) }) : ''
    const unclassified = [
      ...new Set(changed.map((event) => String(event.type)).filter((type) => !isNeutralEvent(type))),
    ]
    const note = unclassified.length === 0
      ? ''
      : fmt('uiSignature.staleUnclassified', { p1: unclassified.join(' ') })
    return {
      status: 'stale',
      signature,
      reason: fmt('uiSignature.staleMany', { p1: gate, p2: `${shown}${more}` }) + note,
    }
  }
  return {
    status: 'valid',
    signature,
    // R-7：把"这一次核没过"如实挂进理由 —— 门禁 C7/C-2D 与回执都读这一行，
    // 于是"静默降级"变成"看得见的降级"（用户与审计都能据此决定要不要重签）。
    reason: signature.basisChecked === 'unavailable'
      ? fmt('uiSignature.validUnchecked', { p1: gate, p2: signature.by, p3: signature.basis })
      : fmt('uiSignature.valid', { p1: gate, p2: signature.by, p3: signature.basis }),
  }
}

/**
 * 该门禁的**失效口径**（人可读的一行，回执里必须写出来）。
 *
 * 「签字后什么会让它失效」是流程承诺的一部分 —— 承诺必须能在回执里读到，
 * 而且与判定用的是**同一口径**（`isSignatureInvalidatingEvent`），不会各说各话。
 *
 * G3 用黑名单（N-7）：逐个列出白名单会让"漏一个真源"变成静默的洞，因此这一行改成
 * 说清**默认方向**（除纯读/渲染/计量外一律失效）。
 */
export function signatureInvalidatingEventLine(gate: string): string {
  if (gate !== 'G2') return fmt('uiSignature.invalidatingEventsBlacklist', { p1: gate })
  return fmt('uiSignature.invalidatingEvents', { p1: gate, p2: G2_SIGNATURE_INVALIDATING_EVENTS.join(' ') })
}

/** 签字来源通道的展示名（回执里如实标注强/弱签字，§6.3 方案 C）。 */
export function channelLabel(channel: GateSignature['channel']): string {
  // 语言包是**两层扁平表**（`section.key`），嵌套映射会被当成"值不是字符串"——
  // 因此这里用扁平键 `channelCommand` / `channelQuestion`，不做三层查找。
  return t(channel === 'command' ? 'uiSignature.channelCommand' : 'uiSignature.channelQuestion')
}
