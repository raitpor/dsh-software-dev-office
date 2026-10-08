/**
 * **评审发现的核实**（2026-10-08 用户口径）：
 *
 * > 评审的（任务）完成不需要被评审，但**评审结果需要被核实才能采纳**；
 * > 评审结果发给开发者角色改动时，**开发者应自行核实**（就像"评审员报的每条发现，
 * > 实现者要先自己复现，复现不了要给出反证"）。
 *
 * 所以这里的口径是：**评审是一份"主张"，不是"结论"**。它的每条 `finding` 必须由
 * **该卡的实现会话**逐条核实并留痕，才谈得上采纳：
 *
 *   · `reproduced`（复现）：照发现能复现出来 ⇒ 才动手改；
 *   · `refuted`（反驳）：复现不出来 ⇒ 留下反证，该条**不予采信**（= 规格里的"无法复现的不采信"）。
 *
 * 两条机械后果：
 *   ① **采纳**：`pass` 评审要满足 C-42 / C-52 的覆盖要求，必须 `adoption.state === 'adopted'`（每条发现都核实过）；
 *   ② **闭合**：卡的最新一条评审是 `changes-requested` / `reject` 且还有未核实发现时，**不允许 `done`**
 *      （"没核实就改、改完就说完成"这条路被堵死）。
 *
 * 三条防腐（与 D4/R1 的"文件 vs journal"同一纪律，评审台账是**手可编辑**的）：
 *   ① **绑发现正文**：核实记录存 `findingHash`；发现正文被改 ⇒ 旧核实 `stale`，不再算数；
 *   ② **journal 佐证**：核实必须伴随 `review/verified` 事件（只有 `reviews/verified.yml` 里的记录 = 伪造）；
 *   ③ **评审自身也要对得上**：`review/recorded.contentHash` 与当前文件内容不一致 ⇒ `tampered`
 *      （否则"把 `changes-requested` 手改成 `pass`、再补一套核实"就能凭空造出一条通过的评审）。
 *
 * 谁能核实：**该卡最新认领会话**（实现方），且**不能**是记录这条评审的会话（自己核实自己 = 自证）。
 * 拿不到认领（老台账/无主卡）时放行但**如实标注** `ownerChecked: 'no-claim'`（与"用户原话核对在拿不到会话时
 * 退回引用非空"同口径：宁可少一层，也不把老数据变成没法干活）。
 */
import { fmt, t } from './i18n.js'
import { pushShapeNote, recordListOf, textOf } from '../infra/scalar.js'
import { findingHashOf, listReviews, reviewContentHash } from './records.js'
import { listTasks } from './plan.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { JournalEvent } from '../types.js'
import type { Review } from './records.js'
import type { FieldShapeNote } from '../infra/scalar.js'

/** 核实台账（放在 `reviews/` 下；`listReviews` 只认 `REV-*.yml`，不会被它干扰）。 */
export const REVIEW_VERIFICATIONS_FILE = 'verified.yml'

export type ReviewFindingOutcome = 'reproduced' | 'refuted'

/** 一条**核实留痕**：某条发现被谁、以什么结论、拿什么证据核实过。 */
export interface ReviewFindingDisposition {
  reviewId: string
  /** 0 起的发现下标（与 `review.findings` 对齐）。 */
  index: number
  /** 被核实的那条发现的**正文指纹**（发现被改 ⇒ 这条失效）。 */
  findingHash: string
  outcome: ReviewFindingOutcome
  /** 复现/反证的依据（命令与结果、或反证说明）。必填。 */
  evidence: string
  by: string
  /** 核实者会话（拿得到就记；用于"实现会话之外的人不许核实"的判定与审计）。 */
  sessionId?: string | undefined
  /**
   * **实现方身份是怎么认定的**（每一种都如实记，审计能看出"这次核实是谁、凭什么"）：
   *   · `session`：核实者就是该卡的**最新认领会话**（理想路径）；
   *   · `no-claim`：该卡没有任何认领记录（老台账），放行但标注；
   *   · `owner-tenure-over`：认领会话**任期已结束** —— 卡已离开 `in-progress`（done/blocked/dropped/ready）
   *     或卡已不存在。一次性子代理跑完就退役，这时**没人能替代它**（真机实测：卡 done 后原实现会话
   *     无法再被唤醒，重新认领也进不去）⇒ 放行并标注，否则该评审**永久**不可采纳、C-42/C-52 不可达；
   *   · `owner-settled`：认领会话被派发过且**已结算**（`dispatch/finished`）⇒ 看不到活的执行者；同上放行并标注。
   */
  ownerChecked: 'session' | 'no-claim' | 'owner-tenure-over' | 'owner-settled'
  at: string
}

/** 一条评审的采纳状态。 */
/**
 * 采纳状态的**短标签**（回执与门禁 detail 共用同一份口径，不许各写一套）。
 */
export function reviewAdoptionLabel(state: ReviewAdoptionState): string {
  switch (state) {
    case 'adopted': return t('uiReview.stateVerified')
    case 'partial': return t('uiReview.statePartial')
    case 'stale': return t('uiReview.stateStale')
    case 'forged': return t('uiReview.stateForged')
    case 'tampered': return t('uiReview.stateTampered')
    case 'unrecorded': return t('uiReview.stateUnrecorded')
    default: return t('uiReview.stateUnverified')
  }
}

export type ReviewAdoptionState =
  /** 每条发现都核实过（且评审自身、核实留痕都能被 journal 佐证）⇒ 可采纳 */
  | 'adopted'
  /** 一条都没核实 */
  | 'unverified'
  /** 核实了一部分 */
  | 'partial'
  /** 核实过，但发现正文后来被改了（旧核实失效） */
  | 'stale'
  /** 台账里有核实记录、journal 里没有对应 `review/verified` ⇒ 伪造，不采纳 */
  | 'forged'
  /** 评审文件与 `review/recorded.contentHash` 对不上（verdict/正文被改过）⇒ 整条不采纳 */
  | 'tampered'
  /** 连 `review/recorded` 事件都没有（手写的评审文件）⇒ 不采纳 */
  | 'unrecorded'

/**
 * **防篡改保护的有无**（G-2，sdo-test 2026-10-08 报告）：
 *   · `content-hash`：`review/recorded`（新格式）或 `review/hashed`（补记）里有内容指纹 ⇒ 改 verdict/正文可判 `tampered`；
 *   · `none-legacy`：老格式评审没有指纹 ⇒ **改 verdict 查不出来**（实测：`changes-requested` 手改成 `pass` 不被检出）。
 *     这种条目不静默放行：门禁与 `sdo_review action=list` 都会写明"该条不具备防篡改保护"，并给出补记通道
 *     `sdo_review action=rehash`（补记之后即可检出；补记**之前**的改动仍然不可校验，如实说明）。
 */
export type TamperGuard = 'content-hash' | 'none-legacy'

export interface ReviewAdoption {
  review: Review
  /** 该评审的防篡改保护（老格式为 `none-legacy`，必须显式标注） */
  tamperGuard: TamperGuard
  state: ReviewAdoptionState
  /** 一条核实都没有的发现下标 */
  pending: number[]
  /** 核实过但发现已改的下标 */
  stale: number[]
  /** 有核实记录但 journal 无佐证的下标 */
  forged: number[]
}

export type VerifyFailure =
  | 'no-review'
  | 'bad-index'
  | 'empty-evidence'
  | 'bad-outcome'
  | 'self-verify'
  | 'not-implementer'

export type VerifyResult =
  | { ok: true; disposition: ReviewFindingDisposition; coverage: { verified: number; total: number }; adopted: boolean }
  | { ok: false; code: VerifyFailure; detail: string }

export interface VerifyInput {
  reviewId: string
  index: number
  outcome: ReviewFindingOutcome
  evidence: string
  /** 核实者（缺省 human）。 */
  by?: string | undefined
  sessionId?: string | undefined
}

/** 读核实台账（手可编辑 ⇒ 形状归一化，绝不因为手写成标量就抛）。 */
export function readDispositionsChecked(store: SdoStore): { dispositions: ReviewFindingDisposition[]; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ verifications: unknown }>('reviews', REVIEW_VERIFICATIONS_FILE)?.verifications
  if (raw === undefined || raw === null) return { dispositions: [], notes: [] }
  const read = recordListOf<ReviewFindingDisposition>(raw, (text) => ({
    reviewId: text,
    index: 0,
    findingHash: '',
    outcome: 'reproduced',
    evidence: '',
    by: '',
    ownerChecked: 'session',
    at: '',
  }))
  pushShapeNote(notes, 'review-verification', REVIEW_VERIFICATIONS_FILE, 'verifications', read.issue)
  const dispositions = read.value
    .map((item) => ({
      reviewId: textOf(item.reviewId),
      index: Number(item.index),
      findingHash: textOf(item.findingHash),
      outcome: (textOf(item.outcome) === 'refuted' ? 'refuted' : 'reproduced') as ReviewFindingOutcome,
      evidence: textOf(item.evidence),
      by: textOf(item.by),
      ...(item.sessionId === undefined ? {} : { sessionId: textOf(item.sessionId) }),
      ownerChecked: normalizeOwnerChecked(textOf(item.ownerChecked)),
      at: textOf(item.at),
    }))
    .filter((item) => item.reviewId !== '' && Number.isFinite(item.index) && item.index >= 0)
  return { dispositions, notes }
}

export function listDispositions(store: SdoStore): ReviewFindingDisposition[] {
  return readDispositionsChecked(store).dispositions
}

/** 某个会话在某张卡上的**最新认领**（"谁是实现方"的唯一判据；与 `claimBaseline` 同源同口径）。 */
function latestClaimSession(journal: Journal, taskId: string): string | undefined {
  const claims = journal
    .read()
    .events.filter((event) => event.type === 'task/claimed' && String(event.data['id'] ?? '') === taskId)
  const sessionId = claims[claims.length - 1]?.data['sessionId']
  return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
}

function normalizeOwnerChecked(value: string): 'session' | 'no-claim' | 'owner-tenure-over' | 'owner-settled' {
  switch (value) {
    case 'no-claim': return 'no-claim'
    case 'owner-tenure-over': return 'owner-tenure-over'
    case 'owner-settled': return 'owner-settled'
    default: return 'session'
  }
}

/** 认领会话的派发状态：`none`（台账里查不到它被派发过）／`live`（在飞）／`settled`（已结算）。 */
function dispatchState(journal: Journal, childSessionId: string | undefined): 'none' | 'live' | 'settled' {
  if (childSessionId === undefined || childSessionId === '') return 'none'
  const events = journal.read().events
  const started = events.some(
    (event) => event.type === 'dispatch/started' && String(event.data['childSessionId'] ?? '') === childSessionId,
  )
  if (!started) return 'none'
  const finished = events.some(
    (event) => event.type === 'dispatch/finished' && String(event.data['childSessionId'] ?? '') === childSessionId,
  )
  return finished ? 'settled' : 'live'
}

function recordedEvent(journal: Journal, reviewId: string): JournalEvent | undefined {
  const events = journal
    .read()
    .events.filter((event) => event.type === 'review/recorded' && String(event.data['id'] ?? '') === reviewId)
  return events[events.length - 1]
}

/** 最新一条**补记指纹**（`review/hashed`）的内容哈希；没有则 `undefined`。 */
function latestHashEvent(journal: Journal, reviewId: string): string | undefined {
  const events = journal
    .read()
    .events.filter((event) => event.type === 'review/hashed' && String(event.data['id'] ?? '') === reviewId)
  const value = events[events.length - 1]?.data['contentHash']
  return typeof value === 'string' && value !== '' ? value : undefined
}

export type RehashResult =
  | { ok: true; review: Review; contentHash: string; alreadySealed: boolean }
  | { ok: false; code: 'no-review' | 'already-tampered'; detail: string }

/**
 * **补记评审内容指纹**（G-2 建议的通道，`sdo_review action=rehash`）：给**老格式**评审补一条 `review/hashed`，
 * 之后改 `verdict` / 改发现正文就能判 `tampered`。
 *
 * **不许洗白**：已存在指纹（记录时带的或此前补记的）而与当前内容**不一致** ⇒ 拒绝 —— 那正是"改过"的证据，
 * 补记只会把证据抹掉。补记只对"从来没有指纹"的评审开放，且回执/事件里写明"补记之前的改动不可校验"。
 */
export function rehashReview(store: SdoStore, journal: Journal, input: { reviewId: string; by?: string | undefined }): RehashResult {
  const review = listReviews(store).find((item) => item.id === input.reviewId)
  if (review === undefined) return { ok: false, code: 'no-review', detail: fmt('uiReview.noReview', { p1: input.reviewId }) }
  const current = reviewContentHash(review)
  const recorded = recordedEvent(journal, review.id)
  const recordedHash = typeof recorded?.data['contentHash'] === 'string' ? recorded.data['contentHash'] : undefined
  const existing = recordedHash ?? latestHashEvent(journal, review.id)
  if (existing !== undefined) {
    if (existing === current) return { ok: true, review, contentHash: current, alreadySealed: true }
    return {
      ok: false,
      code: 'already-tampered',
      detail: fmt('uiReview.rehashTampered', { p1: review.id }),
    }
  }
  const by = textOf(input.by).trim() === '' ? 'human' : textOf(input.by).trim()
  journal.append('review/hashed', { id: review.id, contentHash: current, by, source: 'backfill' })
  return { ok: true, review, contentHash: current, alreadySealed: false }
}

function verifiedEvents(journal: Journal, reviewId: string): JournalEvent[] {
  return journal
    .read()
    .events.filter((event) => event.type === 'review/verified' && String(event.data['id'] ?? '') === reviewId)
}

/**
 * 一条评审的**采纳状态**（唯一的判定入口：门禁、`done` 关、回执都读它，不各写一份）。
 */
export function reviewAdoption(store: SdoStore, journal: Journal, review: Review): ReviewAdoption {
  const base = { review, tamperGuard: 'none-legacy' as TamperGuard, pending: [] as number[], stale: [] as number[], forged: [] as number[] }
  const recorded = recordedEvent(journal, review.id)
  if (recorded === undefined) return { ...base, state: 'unrecorded' }
  const recordedHash = typeof recorded.data['contentHash'] === 'string' ? recorded.data['contentHash'] : undefined
  // **G-2**：老事件没有 `contentHash` ⇒ 允许 `sdo_review action=rehash` 补记一条 `review/hashed`。
  // 两者都没有 ⇒ `none-legacy`（不静默：门禁与 list 会标注"该条不具备防篡改保护"）。
  const sealedHash = latestHashEvent(journal, review.id)
  const expected = recordedHash ?? sealedHash
  const tamperGuard: TamperGuard = expected === undefined ? 'none-legacy' : 'content-hash'
  if (expected !== undefined && expected !== reviewContentHash(review)) return { ...base, state: 'tampered', tamperGuard }

  const mine = listDispositions(store).filter((item) => item.reviewId === review.id)
  const backed = verifiedEvents(journal, review.id)
  const findings = (review.findings ?? []).map((item) => textOf(item))
  const pending: number[] = []
  const stale: number[] = []
  const forged: number[] = []
  for (let index = 0; index < findings.length; index += 1) {
    const wanted = findingHashOf(findings[index] ?? '')
    const disposition = mine.find((item) => item.index === index)
    if (disposition === undefined) {
      pending.push(index)
      continue
    }
    if (disposition.findingHash !== wanted) {
      stale.push(index)
      continue
    }
    const hit = backed.some(
      (event) => Number(event.data['index']) === index && String(event.data['findingHash'] ?? '') === wanted,
    )
    if (!hit) forged.push(index)
  }
  const state: ReviewAdoptionState =
    findings.length === 0
      ? 'unverified'
      : pending.length === 0 && stale.length === 0 && forged.length === 0
        ? 'adopted'
        : forged.length > 0
          ? 'forged'
          : stale.length > 0
            ? 'stale'
            : pending.length === findings.length
              ? 'unverified'
              : 'partial'
  return { review, tamperGuard, state, pending, stale, forged }
}

/** 全部评审的采纳状态（按 id 序，回执与门禁共用）。 */
export function reviewAdoptions(store: SdoStore, journal: Journal): ReviewAdoption[] {
  return listReviews(store)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((review) => reviewAdoption(store, journal, review))
}

/** 某张卡的评审（按 id 序 = 记录顺序）。 */
export function reviewsOfCard(store: SdoStore, taskId: string): Review[] {
  return listReviews(store)
    .filter((review) => review.taskId === taskId)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** 某张卡**已被采纳**的 `pass` 评审（C-42 / C-52 的覆盖判据只认它）。 */
export function adoptedPassReviews(store: SdoStore, journal: Journal, taskId: string): Review[] {
  return reviewsOfCard(store, taskId).filter(
    (review) => review.verdict === 'pass' && reviewAdoption(store, journal, review).state === 'adopted',
  )
}

/**
 * 某张卡**还没核实完**的评审（任意 verdict，按 id 序）—— `done` 关与回执用它说清"还欠哪几条"。
 *
 * 只把**有发现**的评审算进来：一条 `changes-requested` 若一条发现都没写，没有任何可核实的东西
 * （`sdo_review action=record` 也不允许这种空壳，见那边的守卫）。
 */
export function unverifiedReviewsOfCard(store: SdoStore, journal: Journal, taskId: string): ReviewAdoption[] {
  return reviewsOfCard(store, taskId)
    .map((review) => reviewAdoption(store, journal, review))
    .filter((item) => item.review.findings.length > 0 && item.state !== 'adopted')
}

/**
 * `done` 关：卡上**最新一条**评审是 `changes-requested` / `reject` 且还没核实完 ⇒ 返回它（**拦**）。
 *
 * 为什么只看最新一条：一条更新的 `pass` 评审就是"上次要求改动已经过了"的凭据，
 * 老的非通过评审不该永远拦住这张卡（评审是追加式的，永远不删）。
 */
export function blockingReview(store: SdoStore, journal: Journal, taskId: string): ReviewAdoption | undefined {
  const all = reviewsOfCard(store, taskId)
    .map((review) => reviewAdoption(store, journal, review))
  const latest = all[all.length - 1]
  if (latest === undefined) return undefined
  if (latest.review.verdict === 'pass') return undefined
  if (latest.review.findings.length === 0) return undefined
  return latest.state === 'adopted' ? undefined : latest
}

/** 核实一条发现：写台账 + 落 `review/verified`（两侧一起写，缺一不可）。 */
export function verifyReviewFinding(
  store: SdoStore,
  journal: Journal,
  input: VerifyInput,
): VerifyResult {
  const review = listReviews(store).find((item) => item.id === input.reviewId)
  if (review === undefined) return { ok: false, code: 'no-review', detail: fmt('uiReview.noReview', { p1: input.reviewId }) }
  const findings = (review.findings ?? []).map((item) => textOf(item))
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= findings.length) {
    return { ok: false, code: 'bad-index', detail: fmt('uiReview.badIndex', { p1: input.reviewId, p2: String(findings.length), p3: String(input.index + 1) }) }
  }
  if (input.outcome !== 'reproduced' && input.outcome !== 'refuted') {
    return { ok: false, code: 'bad-outcome', detail: fmt('uiReview.badOutcome', { p1: String(input.outcome) }) }
  }
  const evidence = textOf(input.evidence).trim()
  if (evidence === '') {
    return { ok: false, code: 'empty-evidence', detail: t('uiReview.emptyEvidence') }
  }
  // **不能自己核实自己**：记录这条评审的会话不许给自己发"已核实"（拿得到记录会话时才做）
  const recorded = recordedEvent(journal, review.id)
  const recordedSession = typeof recorded?.data['sessionId'] === 'string' ? recorded.data['sessionId'] : undefined
  if (input.sessionId !== undefined && recordedSession !== undefined && input.sessionId === recordedSession) {
    return { ok: false, code: 'self-verify', detail: fmt('uiReview.selfVerify', { p1: review.id, p2: recordedSession }) }
  }
  // **实现方才能核实**：该卡最新认领会话。拿不到认领、或实现方**已经不可达**（任期结束／派发已结算）
  // ⇒ 放行并**如实标注**（G-1：否则一次性子代理退役后，它留下的评审**永久**不可采纳）。
  const claimSession = latestClaimSession(journal, review.taskId)
  const card = listTasks(store).find((item) => item.id === review.taskId)
  const ownerChecked: 'session' | 'no-claim' | 'owner-tenure-over' | 'owner-settled' = (() => {
    if (claimSession === undefined) return 'no-claim'
    if (input.sessionId !== undefined && claimSession === input.sessionId) return 'session'
    // 卡已离开 in-progress（或卡不存在）⇒ 实现方对这张卡的任期已结束
    if (card === undefined || card.status !== 'in-progress') return 'owner-tenure-over'
    // 卡还在进行中，但那个子会话的派发已结算 ⇒ 看不到活的执行者
    if (dispatchState(journal, claimSession) === 'settled') return 'owner-settled'
    return 'session'
  })()
  if (ownerChecked === 'session' && claimSession !== undefined && input.sessionId !== undefined && claimSession !== input.sessionId) {
    return {
      ok: false,
      code: 'not-implementer',
      detail: fmt('uiReview.notImplementer', { p1: review.id, p2: review.taskId, p3: claimSession }),
    }
  }

  const disposition: ReviewFindingDisposition = {
    reviewId: review.id,
    index: input.index,
    findingHash: findingHashOf(findings[input.index] ?? ''),
    outcome: input.outcome,
    evidence,
    by: textOf(input.by).trim() === '' ? 'human' : textOf(input.by).trim(),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ownerChecked,
    at: new Date().toISOString(),
  }
  const existing = listDispositions(store).filter(
    (item) => !(item.reviewId === disposition.reviewId && item.index === disposition.index),
  )
  store.writeYaml(['reviews', REVIEW_VERIFICATIONS_FILE], { verifications: [...existing, disposition] })
  journal.append('review/verified', {
    id: disposition.reviewId,
    index: disposition.index,
    findingHash: disposition.findingHash,
    outcome: disposition.outcome,
    by: disposition.by,
    ...(disposition.sessionId === undefined ? {} : { sessionId: disposition.sessionId }),
    ownerChecked: disposition.ownerChecked,
  })
  const after = reviewAdoption(store, journal, review)
  const verified = findings.length - after.pending.length - after.stale.length - after.forged.length
  return { ok: true, disposition, coverage: { verified: Math.max(0, verified), total: findings.length }, adopted: after.state === 'adopted' }
}
