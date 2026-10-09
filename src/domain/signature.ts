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
    // **R-28**：依据是本次当场取回的（question 通道）
    ...(item.basisFresh === true ? { basisFresh: true } : {}),
    // **R-27**：依据在会话里的位置（允许"用户又原样说了一次"）
    ...(typeof item.basisAt === 'number' && Number.isFinite(item.basisAt) ? { basisAt: item.basisAt } : {}),
    // **R-27**：依据的首次使用序号（读回时保留，审计与重放判定都要用）
    ...(typeof item.basisFirstSeq === 'number' && Number.isFinite(item.basisFirstSeq)
      ? { basisFirstSeq: item.basisFirstSeq }
      : textOf(item.basisFirstSeq) === ''
        ? {}
        : { basisFirstSeq: Number(textOf(item.basisFirstSeq)) || 0 }),
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

/**
 * 签字台账里的门禁名 → **比对键**。
 *
 * **F-1（2026-10-05 真机，major）**：`sdo_gate action=sign` 曾把调用方传入的字符串**原样落盘**
 * （真机留下 `gate: 架构门禁（G3）`），而判定侧按内部编号 `'G3'` **精确过滤** ⇒ 那条签字
 * **永远不被看见**（同一次调用的回执却自证"当前有效"）。现在两层一起补：
 *   · 写入侧：`office.signGate` 落盘前归一成内部编号（复用 `normalizeGateId`）；
 *   · 读取侧：这里把"带括号编号的中文全名"也认成同一个门禁（**兼容盘上已有的脏记录**，不必手改台账）。
 */
export function gateKeyOf(value: string): string {
  const bracketed = /[（(]\s*(G\d+|GP|GI|GR)\s*[）)]/iu.exec(value)
  if (bracketed !== null) return (bracketed[1] ?? '').toUpperCase()
  return value.trim().toUpperCase()
}

/** 某个门禁**最新**一条签字（历史保留；判定只看最新一条 → 重新签字即可覆盖旧失效签字）。 */
export function latestSignature(store: SdoStore, gate: string): GateSignature | undefined {
  const wanted = gateKeyOf(gate)
  return listSignatures(store)
    .filter((signature) => gateKeyOf(signature.gate) === wanted)
    .sort((a, b) => a.atSeq - b.atSeq)
    .at(-1)
}

/**
 * **依据文本的归一化**（唯一实现，H1/H2/H3 共用）。
 *
 * 为什么必须只有一份：H3 的绕过正是"来源核对把空白归一了、防重放却只 `trim()`"——
 * 同一句话加一个空格就能把旧授权重新盖到新内容上。凡是要比较"这句话是不是同一句"的地方
 * （来源核对 / 签字重放 / 设计确认重放）都走这里。
 */
export function normalizeBasis(text: string): string {
  return text.trim().replace(/\s+/gu, ' ')
}

/**
 * **本门最近一次"失效事件"的序号**（R-27）：没有失效事件 ⇒ `undefined`。
 *
 * 失效判据复用签字状态那一侧的同一条函数（`isSignatureInvalidatingEvent`）—— 两处口径必须一致，
 * 否则会出现"状态判 stale、重放判定却当它新鲜"的分叉。
 */
export function lastInvalidationSeq(journal: Journal, gate: string): number | undefined {
  const events = journal.read().events.filter((event) => isSignatureInvalidatingEvent(gate, event.type, event.data))
  return events.length === 0 ? undefined : events[events.length - 1]?.seq
}

/**
 * **依据重放判定**（R-27，major）：同一句用户原话**只代表一次表态**。
 *
 * 规则（机械、只用台账 + journal）：这句话此前被用作**本门**签字的依据（首次使用序号 `usedAtSeq`），
 * 而**此后本门又失效过**（`lastInvalidation > usedAtSeq`）⇒ 这次再拿它签字就是**重放**，必须拒绝。
 * 反过来说：本门签完之后没再失效过（用户同一句话仍然"当前有效"）⇒ 允许原样再签一次。
 *
 * 为什么不直接比对"用户消息的时间"：插件拿到的只有宿主派生的消息文本（没有与 journal 可比的序号），
 * 所以这里用"**这句话上一次被用来签字的事件序号**"作为它出现时刻的可核对代理 —— 它只会**偏晚**
 * （用户更早说的），于是判定偏**保守**（宁可要求用户重新表态）。
 */
export function basisReplay(
  store: SdoStore,
  journal: Journal,
  gate: string,
  basis: string,
  /**
   * **这次依据的出处身份**（H2a/H4，2026-10-09 整体评审）：
   *   · `basisMsgId` = 命中那条**用户消息的稳定 id**（跨压缩不变）——**首选**判据；
   *   · `basisAt` = 会话派生消息的**下标**，只作提示/审计（压缩会让它变小，不能当判据）。
   */
  occurrence?: { basisAt?: number | undefined; basisMsgId?: string | undefined },
): {
  replayed: boolean
  usedAtSeq?: number | undefined
  lastInvalidation?: number | undefined
  sameOccurrence?: boolean | undefined
  /** 判定用的是哪一种身份（审计与回执要能说清） */
  by: 'message-id' | 'text-fallback'
} {
  const wanted = normalizeBasis(basis)
  const lastInvalidation = lastInvalidationSeq(journal, gate)
  const mine = listSignatures(store)
    .filter((signature) => gateKeyOf(signature.gate) === gateKeyOf(gate))
    .sort((a, b) => a.atSeq - b.atSeq)
  // **H2a 修法（关键）**：先按**消息身份**查 —— 一次表态只算一次背书，与"调用方引用了这句话的哪一段"无关。
  // 旧口径先按"整串相等"筛，于是同一句话换个片段就找不到旧记录 ⇒ 判成新表态（报告里的 (a) 绕行）。
  const msgId = occurrence?.basisMsgId
  const byMessage = msgId === undefined || msgId === '' ? [] : mine.filter((signature) => signature.basisMsgId === msgId)
  if (byMessage.length > 0) {
    const usedAt = byMessage[0]!.atSeq
    const staleMessage = lastInvalidation !== undefined && usedAt < lastInvalidation
    return {
      replayed: staleMessage,
      by: 'message-id',
      usedAtSeq: usedAt,
      sameOccurrence: true,
      ...(lastInvalidation === undefined ? {} : { lastInvalidation }),
    }
  }
  const uses = mine.filter((signature) => normalizeBasis(signature.basis) === wanted)
  const first = uses[0]
  if (first === undefined) {
    return { replayed: false, by: 'message-id', ...(lastInvalidation === undefined ? {} : { lastInvalidation }) }
  }
  const stale = lastInvalidation !== undefined && first.atSeq < lastInvalidation
  // **H2a/H4 修法**：身份是**消息**，不是调用方挑的片段（`includes` 命中哪条消息就是哪条），
  // 也不是会随压缩漂移的下标。
  //   · 本次给得出消息 id、且**历史上用过这条消息** ⇒ 同一次表态被复用 ⇒ 重放；
  //   · 历史上用过同文本、但**是另一条消息**（用户又原样说了一次）⇒ 新的表态 ⇒ 放行；
  //   · 拿不到消息 id（旧宿主/直接调 API/老签字）⇒ 退回老口径（同文本即重放），保守方向不变。
  const withId = uses.filter((signature) => (signature.basisMsgId ?? '') !== '')
  if (msgId !== undefined && msgId !== '' && withId.length > 0) {
    const sameMessage = withId.some((signature) => signature.basisMsgId === msgId)
    return {
      replayed: stale && sameMessage,
      by: 'message-id',
      usedAtSeq: first.atSeq,
      sameOccurrence: sameMessage,
      ...(lastInvalidation === undefined ? {} : { lastInvalidation }),
    }
  }
  const basisAt = occurrence?.basisAt
  const freshOccurrence = basisAt !== undefined && first.basisAt !== undefined && basisAt > first.basisAt
  return {
    replayed: stale && !freshOccurrence,
    by: 'text-fallback',
    usedAtSeq: first.atSeq,
    ...(basisAt === undefined ? {} : { sameOccurrence: !freshOccurrence }),
    ...(lastInvalidation === undefined ? {} : { lastInvalidation }),
  }
}

export interface RecordSignatureInput {
  gate: string
  by: string
  /** 用户原话引用 / 所选选项原文（**必填**） */
  basis: string
  channel: 'command' | 'question'
  turn?: string | undefined
  /**
   * R-7：引用是否与本次会话的用户发言核对过。
   *   · `session`：与**人类出处**（`source.kind === 'user'`）的发言核对过（强口径）；
   *   · `role-only`：宿主消息没有出处信息，只按 `role === 'user'` 退而求其次（**弱口径，H1**）；
   *   · `unavailable`：宿主拿不到会话历史（如实记，不当成核对过）。
   */
  basisChecked?: 'session' | 'role-only' | 'unavailable' | undefined
  /**
   * **R-27**：这条依据在会话派生消息里的位置（最后一条命中它的用户消息下标）。
   * **H4**：只作审计/提示 —— 压缩会让下标变小，判定不再依赖它（见 `basisMsgId`）。
   */
  basisAt?: number | undefined
  /**
   * **H2a/H4（2026-10-09 整体评审）**：命中这条依据的**用户消息 id**（跨压缩稳定）。
   *
   * 为什么它是更对的键：旧口径让调用方**自选片段**（`includes` 命中即可），于是"同一句话换个片段"
   * 就能重签；而"用户又说了一次"与"复用旧话"的区别，只有**消息身份**能说清（下标会被压缩改小）。
   */
  basisMsgId?: string | undefined
  /**
   * **依据是本次调用当场取回的**（`channel=question`：工具自己问用户、原话不经过模型）。
   *
   * 为什么必须区分（R-27 的回归）：`channel=question` 的"原话"是**固定的选项标签**
   * （如「确认签字」），逐字重复是**设计使然**；若不区分，同一个门禁第二次点选会被当成"复读旧话"拒绝
   * —— 而那恰是 R-27 报告推荐的出路，等于把最安全的通道堵死。
   */
  basisFresh?: boolean | undefined
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
  // **R-27**：依据不许重放 —— 强制在**落盘这一步**（工具层另有更友好的拒绝回执，
  // 但任何直接调用 `recordSignature` 的路径也必须被拦住，否则"合规靠自律"）。
  // `basisFresh=true`（question 通道：本次当场问的用户）**不参与**重放判定。
  const replay = input.basisFresh === true
    ? { replayed: false, usedAtSeq: undefined, lastInvalidation: undefined, by: 'message-id' as const }
    : basisReplay(store, journal, input.gate, basis, {
        ...(input.basisAt === undefined ? {} : { basisAt: input.basisAt }),
        ...(input.basisMsgId === undefined ? {} : { basisMsgId: input.basisMsgId }),
      })
  if (replay.replayed) {
    throw new Error(fmt('uiSignature.basisReplayed', {
      p1: input.gate,
      p2: String(replay.usedAtSeq ?? '?'),
      p3: String(replay.lastInvalidation ?? '?'),
    }))
  }
  const by = input.by.trim() === '' ? 'human' : input.by.trim()
  // 依据的**首次使用序号**（本条是首次使用时等于本条自己的 seq，稍后回填）
  const prior = listSignatures(store)
    .filter((signature) => gateKeyOf(signature.gate) === gateKeyOf(input.gate))
    .filter((signature) => normalizeBasis(signature.basis) === normalizeBasis(basis))
    .sort((a, b) => a.atSeq - b.atSeq)[0]
  const event = journal.append('gate/signed', {
    gate: input.gate,
    by,
    basis,
    channel: input.channel,
    // **R-27**：依据的出处要进真源（审计一眼可见"这句话最早用在哪儿"）
    ...(prior === undefined ? {} : { basisFirstSeq: prior.atSeq }),
    ...(input.basisAt === undefined ? {} : { basisAt: input.basisAt }),
    // **H2a/H4**：消息身份进真源（判定与审计都用它）
    ...(input.basisMsgId === undefined ? {} : { basisMsgId: input.basisMsgId }),
    // **R-28**：依据是本次当场取回的（question 通道）⇒ 进真源，审计能看出"为什么它不算复读"
    ...(input.basisFresh === true ? { basisFresh: true } : {}),
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
    // 首次使用 ⇒ 记自己的序号（审计读作"这句话出现于本条"）
    basisFirstSeq: prior?.atSeq ?? event.seq,
    ...(input.basisAt === undefined ? {} : { basisAt: input.basisAt }),
    ...(input.basisMsgId === undefined ? {} : { basisMsgId: input.basisMsgId }),
    ...(input.basisFresh === true ? { basisFresh: true } : {}),
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

/**
 * **D8（整仓评审 major）**：签字状态判定 + **与真源事件的交叉核对**。
 *
 * 只**追加标记**，不改任何既有判据（`missing`/`unquoted`/`stale`/`valid`/`unknown` 的语义一字不动）：
 *   · 台账里**没有**这条签字，但 journal 有该门禁的 `gate/signed` 事件 ⇒ 文件被删/被改写（不是"没签过"）；
 *   · 台账里**有**这条签字，但 journal 里找不到对应事件 ⇒ 手写/绕过工具写入。
 * 两种情况都置 `inconsistent`，并在理由后面接一句人读告警 —— "删文件就变成没签"与"手写一条没人知道"到此可见。
 */
export function signatureState(store: SdoStore, journal: Journal, gate: string): SignatureState {
  const state = signatureStateCore(store, journal, gate)
  const signedEvents = journal.read().events.filter(
    (event) => event.type === 'gate/signed' && String(event.data.gate ?? '') === gate,
  )
  if (state.signature === undefined) {
    if (signedEvents.length === 0) return state
    return {
      ...state,
      inconsistent: true,
      reason: `${state.reason} ${fmt('uiSignature.journalOnly', { p1: String(signedEvents.length) })}`,
    }
  }
  if (signedEvents.some((event) => String(event.at) === String(state.signature?.at))) return state
  return {
    ...state,
    inconsistent: true,
    reason: `${state.reason} ${fmt('uiSignature.noEvent', { p1: state.signature.by, p2: state.signature.at })}`,
  }
}

export interface SignatureState {
  status: SignatureStatus
  signature?: GateSignature | undefined
  /** 人读理由（回执与门禁 detail 都用它） */
  reason: string
  /**
   * **D8（整仓评审 major）**：签字台账（`gates/signatures.yml`）与真源事件（journal 的 `gate/signed`）
   * **不一致** —— 要么文件被删/被改写（事件还在），要么文件里有签字而**没有任何事件佐证**（手写/绕过工具）。
   * 实测过：删掉 YAML 就报 `missing`，与"从来没签过"**长得一模一样**；手写一条则无人知晓。
   */
  inconsistent?: boolean | undefined
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
function signatureStateCore(store: SdoStore, journal: Journal, gate: string): SignatureState {
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
  // 事件**连 payload 一起**交给判定（2026-10-05）：`trace/linked` / `trace/unlinked` 要看 `kind`
  // 才能区分「设计侧边（改 DESIGN.md 的追溯矩阵）」与「施工期覆盖边（`req-task`/`req-tc`，属记账）」。
  // 只传 type 会让所有追溯边一律失效 —— 那样签完 G3 一开工就会被自己的覆盖边作废。
  const invalidating = (type: string, data?: unknown): boolean => isSignatureInvalidatingEvent(gate, type, data)
  const changed = read.events.filter((event) => event.seq > signature.atSeq).filter((event) => invalidating(event.type, event.data))
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
