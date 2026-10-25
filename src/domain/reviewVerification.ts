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
import { findingHashOf, listDefects, listReviews, listTestResults, reviewContentHash } from './records.js'
import { listTasks } from './plan.js'
import type { EventIndex, Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { JournalEvent } from '../types.js'
import type { Review } from './records.js'
import type { FieldShapeNote } from '../infra/scalar.js'

/** 核实台账（放在 `reviews/` 下；`listReviews` 只认 `REV-*.yml`，不会被它干扰）。 */
export const REVIEW_VERIFICATIONS_FILE = 'verified.yml'

/** 评审真源所在目录（评审表 / 处置表 / 采纳表的来源探针都盯它）。 */
const REVIEWS_DIR = 'reviews'

/**
 * **派生表记忆化**（`TASK-220`）—— 评审表 / 处置表 / 采纳表，键 = `(台账绝对路径, journal 代次)`。
 *
 * 病根（本卡实测，真账 `.sdo/journal.jsonl` 近 7.6k 事件 / 98 条评审）：
 *   · `reviewAdoptions` 连测 **37.62 / 33.64 / 30.62ms**、`pendingReviewBigCards` **43.09 / 42.45 / 43.60ms** ——
 *     **三次同价**就是"零记忆化"的指纹：同一个参数每问一次都从头折一遍；
 *   · 其中主项是"按 type 的全文重扫"：98 条评审 ×（recorded / hashed / verified）各扫一遍七千多事件。
 *
 * 口径（与读层缓存 `TASK-213` **同一个代次源**，不各算一套）：
 *   · 事件索引 / 采纳表：键 = `(路径, 代次)`；代次由 `journal` 单调递增（任何 append / 重解析都换代）；
 *   · 评审表 / 处置表：它们**不是**从 journal 折出来的（真源是 `reviews/*.yml`，手可编辑）⇒
 *     除代次外再加一组**来源探针**（`reviews/` 目录 + `verified.yml`）。
 *     产品代码写这两份 YAML 时会同时 append 事件（换代次），但**手改 / 夹具直写**不会 ——
 *     只认代次就会永远读到旧表（= 静默错判采纳）。
 *
 *     探针是**内容级**的（`REV-100` 第 1 条 / `DEF-218`）：目录**逐条目** stat，聚合 `名字:尺寸:mtimeMs`；
 *     只 stat 目录本身是不够的 —— 目录的 mtime/size 只在**增删改名**时变，而宿主 `edit` / `echo >` /
 *     `cp` 覆盖都是**同 inode 就地写**（改一条已有 `REV-xxx.yml` 的内容），目录 stat 一动不动。
 *     逐文件聚合之后这种"内容被就地改"也能看见（`M236-08` 钉住；反例形态见 `mutant-D`）。
 *     边界（**不许声称挡住**）：写完把 mtime 回拨、或两次写落在同一时间刻度内 ⇒ 看不见。
 *
 *     **扩探针的义务**：本组探针只覆盖 `reviews/`（四张表的 compute 也只读它 + `tasks/` + 事件；
 *     `roles.yml` / config / 工具分组**都不是**输入）。将来若把 `defects/` / `tests/` / `gates/` 等真源
 *     拉进任何一张记忆化表，**必须同时把该目录加进 `probes`** —— 漏了不报错，只会安静地读旧表。
 */
function reviewProbes(store: SdoStore): string[] {
  return [store.path(REVIEWS_DIR), store.path(REVIEWS_DIR, REVIEW_VERIFICATIONS_FILE)]
}

/**
 * **采纳表的计数器**（`TASK-220` 的可测面：本卡的判据必须是**实测**，不是估算）。
 *
 *   · `calls`：`reviewAdoptions(...)` 被**请求**了几次（门禁一次检查里 ≤ 1 就是读它）；
 *   · `computes`：其中**真的逐条算**了几次（命中记忆化不计）。
 *
 * 只累加、不进任何回执（与 `journalReadStats` 同一路数）。
 */
export const reviewAdoptionStats = {
  calls: 0,
  computes: 0,
}

/** 清零采纳表计数器（守卫与复现脚本用；不影响记忆化内容）。 */
export function resetReviewAdoptionStats(): void {
  reviewAdoptionStats.calls = 0
  reviewAdoptionStats.computes = 0
}

/**
 * **评审表**（`reviews/REV-*.yml`）的**只读**记忆化视图 —— 键 = `(台账路径, 来源探针)`。
 *
 * 这是 `listReviews`（真源读取）的批量形态：门禁、状态块、`done` 关读的都是同一批 YAML，
 * 修前各自 `listReviews` 一遍（真账 98 个文件 ~5.4ms）。返回的是**共享只读视图**：要排序/改就先拷。
 *
 * **`TASK-230`**：`dependsOnEvents: false` —— 这张表的 compute 一个事件都不读（真源是 YAML），
 * 修前却在**每一次 append 之后**被整批作废并重读 121 个文件（真账 14.5ms）。判"变没变"只该看
 * 来源探针（`reviews/` 逐条目 stat），代次是"台账变了"的记号，不是"这张表的输入变了"的记号。
 */
export function listReviewsCached(store: SdoStore, journal: Journal): Review[] {
  return journal.memoDerived('reviews-table', reviewProbes(store), () => listReviews(store), {
    dependsOnEvents: false,
  })
}

/**
 * **核实留痕整表**（`reviews/verified.yml`）的只读记忆化视图 —— 同 `listReviewsCached` 的口径
 * （含 `TASK-230` 的 `dependsOnEvents: false`：它同样一个事件都不读，修前每次 append 后被重读 12.3ms）。
 *
 * 修前 `listDispositions(store)` 单次 ~8.5ms，而 `verifyReviewFinding` 一次要问两遍、采纳判定
 * 每条评审还要各问一遍（`TASK-213` 已经收到"批量只读一次"，本卡再把**单次形态**也记忆化）。
 */
export function listDispositionsCached(store: SdoStore, journal: Journal): ReviewFindingDisposition[] {
  return journal.memoDerived('dispositions-table', reviewProbes(store), () => listDispositions(store), {
    dependsOnEvents: false,
  })
}

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
   *   · **`claim-released`（`DEF-099` 真机第三副面孔，2026-10-18）**：认领之后**已被释放**
   *     （`task/released`）⇒ 当前**没有** owner。旧实现只看"最后一次认领"，释放之后仍把前一个会话当
   *     实现方 ⇒ 驾驶舱"认领后释放、让位给评审会话代录"仍被判 `not-implementer`（真机 TASK-145 就是这样被堵死）。
   */
  ownerChecked: 'session' | 'no-claim' | 'owner-tenure-over' | 'owner-settled' | 'claim-released'
  /**
   * **R-16（sdo-test-new 2026-10-08）**：核实者的角色码 + 它与该卡角色的关系。
   *
   * 用户口径：核实评审**默认归实现者**（产品卡 = developer —— 他是按评审去修代码的人，
   * 也最需要判断"这条是真的坏了"还是"这是有意的设计取舍"）；实现会话退役后可以**代核**，
   * 但代核要"优先同角色"，且代核者**只负责复现/反证，不替作者做处置决定**。
   * 记下这两个字段，事后才统计得出"谁核的、核到什么程度、是不是同角色代核"。
   */
  verifierRole?: string | undefined
  roleMatch?: 'same-role' | 'cross-role' | 'unknown' | undefined
  /**
   * **`DEF-117`（第十三批 §1.3）**：这条核实与**评审作者**是不是同一个人。
   *
   * 旧台账**无法区分** independent / same-author（真机：同一会话既是 `REV-056` 的作者、又落了 9 条
   * verify-review ⇒ 自证，事后读账看不出）。新记录必须带这个字段；**历史记录缺省 `unknown`**（不改写历史）。
   */
  independence?: 'independent' | 'same-author' | 'unknown' | undefined
  /** **被本次覆盖掉的那条核实**（R-19 A）：只记最关键的三个字段，台账里能看出"这里曾被改判"。 */
  revisedFrom?: { outcome: ReviewFindingOutcome; by: string; at: string } | undefined
  at: string
}

/**
 * 某个子会话被派发成什么角色（取最新一条 `dispatch/started`；拿不到 ⇒ 空串）。
 *
 * **`REV-095` 必核四③（`TASK-279`）**：第三个参数可选地吃**已经算好的按 type 分组索引** ——
 * 调用方若刚为别的判据读过台账（`verifyReviewFinding` 就是），传下来就**不再 `journal.read()` 一遍**。
 * 判据一字未改（仍然是"按台账顺序扫 `dispatch/started`，取最后一条非空 `role`"），改的只是别重复读。
 */
export function dispatchRoleOf(journal: Journal, sessionId: string, index?: EventIndex): string {
  const dispatchEvents = index === undefined
    ? journal.read().events.filter((event) => event.type === 'dispatch/started')
    : index.of('dispatch/started')
  let role = ''
  for (const event of dispatchEvents) {
    if (textOf(event.data['childSessionId']) !== sessionId) continue
    const found = textOf(event.data['role'])
    if (found !== '') role = found
  }
  return role
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
  /**
   * **D-23**：这份状态**有没有真的逐条看过发现**。
   *
   * `tampered`（评审自身对不上真源）与 `unrecorded`（连 `review/recorded` 都没有）都在"看发现"
   * **之前**就返回了 ⇒ 此时 `pending`/`stale`/`forged` 恒为空数组，而回执旧写法按
   * `总数 - 空数组长度` 打印「核实 8/8」—— **假绿**：真机 D-23 就是这样同时显示
   * 「评审文件与真源不符（被改过）」与「核实 8/8」。没看过就说没看过。
   */
  examined: boolean
}

export type VerifyFailure =
  | 'no-review'
  | 'bad-index'
  | 'empty-evidence'
  /** **`DEF-100`（第十二批 §3.5）**：`reproduced` 的证词必须含**可读的读数形态**（占位文本不算复现）。 */
  | 'placeholder-evidence'
  | 'bad-outcome'
  | 'self-verify'
  | 'not-implementer'
  /** **代核必须同角色**（2026-10-08 用户口径）：实现会话退役时，跨角色代核被拒。 */
  | 'cross-role-verifier'
  /** **同一 (评审, 发现) 已有核实**（R-19 A）：默认拒绝，要覆盖得显式传 `revise: true`。 */
  | 'already-verified'

/**
 * **证词挂靠到哪条发现**（DEF-043 落点二）。
 *
 * 为什么必须有：核实台账是审计链的核心，而旧实现成功后**只记 0 起的 index**，
 * 回执里也不出现该条发现的任何字样 ⇒ 「证词挂到哪条发现」事后无从核对，
 * 挂错条等于让审计链说谎（本批实测至少两个会话为此试错）。
 */
export interface VerifiedFindingRef {
  /** **参数基准**的序号（1 起）—— 与使用者输入、与回执里印的「第 N 条」同口径。 */
  findingIndex: number
  /** 该条发现的**首句**（截断后的），让人一眼看出挂的是哪条。 */
  findingExcerpt: string
}

export type VerifyResult =
  | {
      ok: true
      disposition: ReviewFindingDisposition
      coverage: { verified: number; total: number }
      adopted: boolean
      /** **双写**：参数第 N 条 ⇒ 台账第 N-1 条 ⇒ 该条发现的首句。 */
      findingIndex: number
      findingExcerpt: string
    }
  | { ok: false; code: VerifyFailure; detail: string }

/** 一条发现的**首句摘录**上限（够认出是哪条即可，不把正文塞进回执与事件）。 */
const FINDING_EXCERPT_MAX = 80

/**
 * **可读的读数形态**（`DEF-100`，第十二批 §3.5）：`⇒` / `=>` / `exitCode` / 64 位十六进制。
 *
 * 为什么只认这几种：它们是**判据形态**（不是措辞）—— 一条"复现"要么把**读数**摆出来（命令行输出、
 * 退出码、产物哈希），要么就只是**断言**。占位文本（`'x'`、`'复现成功'`）一律不算复现。
 * 只对 `reproduced` 生效（`refuted` 给的是**反证**，本来就可能是散文）。
 */
const READABLE_PROOF = /⇒|=>|\bexitCode\b|\b[0-9a-f]{64}\b/u

/**
 * 取一条发现的**首句**（到第一个句号/分号/换行，或上限截断）。
 *
 * 之所以取"首句"而不是全文：回执与 journal 事件都要带上它，全文会让两者都变重；
 * 而本仓评审发现的写法是「【标签·结论】要点…」，**首句就足以认出是哪一条**。
 */
export function findingExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const stop = flat.search(/[。；;]/)
  const head = stop === -1 ? flat : flat.slice(0, stop)
  return head.length <= FINDING_EXCERPT_MAX ? head : `${head.slice(0, FINDING_EXCERPT_MAX)}…`
}


export interface VerifyInput {
  reviewId: string
  index: number
  outcome: ReviewFindingOutcome
  evidence: string
  /** 核实者（缺省 human）。 */
  by?: string | undefined
  sessionId?: string | undefined
  /**
   * **允许覆盖同一 `(评审, 发现)` 上已有的核实记录**（R-19 A，sdo-test-new 2026-10-08）。
   *
   * 缺省**拒绝再次核实**：真机发生过同一 `(REV-018, index 1)` 先落"同角色代核"、后落"实现者本人核"
   * （两条依据不同：`owner-tenure-over` vs `session`），派生视图按写入顺序**静默留后写的那条**，
   * 先落的那条在视图里没有任何痕迹；若两位核实者给出**相反判定**，采纳结论就由写入顺序决定。
   * 要复核就显式传 `revise: true`。
   */
  revise?: boolean | undefined
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
      ...(textOf(item.verifierRole) === '' ? {} : { verifierRole: textOf(item.verifierRole) }),
      ...(typeof item.revisedFrom === 'object' && item.revisedFrom !== null
        ? {
            revisedFrom: {
              outcome: textOf((item.revisedFrom as Record<string, unknown>)['outcome']) as ReviewFindingOutcome,
              by: textOf((item.revisedFrom as Record<string, unknown>)['by']),
              at: textOf((item.revisedFrom as Record<string, unknown>)['at']),
            },
          }
        : {}),
      ...(['same-role', 'cross-role', 'unknown'].includes(textOf(item.roleMatch))
        ? { roleMatch: textOf(item.roleMatch) as 'same-role' | 'cross-role' | 'unknown' }
        : {}),
      // **`DEF-117`**：历史记录没有这个字段 ⇒ 不写（保持 `undefined` = 未声明），不假装 `independent`
      ...(['independent', 'same-author', 'unknown'].includes(textOf(item.independence))
        ? { independence: textOf(item.independence) as 'independent' | 'same-author' | 'unknown' }
        : {}),
      at: textOf(item.at),
    }))
    .filter((item) => item.reviewId !== '' && Number.isFinite(item.index) && item.index >= 0)
  return { dispositions, notes }
}

export function listDispositions(store: SdoStore): ReviewFindingDisposition[] {
  return readDispositionsChecked(store).dispositions
}

/**
 * 某张卡的**当前**认领会话（"谁是实现方"的唯一判据；与 `claimBaseline` 同源同口径）。
 *
 * **`DEF-099`（真机第三副面孔，2026-10-18）**：必须把 `task/released` 算进去 —— 认领之后若**释放**了，
 * 当前就**没有** owner。旧实现只看"最后一次 `task/claimed`"，于是释放后仍把旧会话当实现方：
 * 真机 TASK-145 上驾驶舱"认领后代录评审"被拒，按机制让位**释放**之后**仍然**被拒（报"由 session-… 认领"），
 * 最终只能把卡 drop 掉、评审结论改由 `errata` 承载。
 *
 * 返回 `released`：卡是否存在"认领之后又被释放"（供 `ownerChecked` 如实标注，不把它混成 `no-claim`）。
 */
function currentClaim(index: EventIndex, taskId: string): { sessionId: string | undefined; released: boolean } {
  // **`TASK-220`**：只在该 type 的分组里扫（修前每次 `filter` 整个七千多事件数组）
  const events = [...index.of('task/claimed'), ...index.of('task/released')]
    .sort((a, b) => a.seq - b.seq)
    .filter((event) => String(event.data['id'] ?? '') === taskId)
  let sessionId: string | undefined
  let released = false
  for (const event of events) {
    if (event.type === 'task/claimed') {
      const claimed = event.data['sessionId']
      sessionId = typeof claimed === 'string' && claimed !== '' ? claimed : undefined
      released = false
    } else {
      released = true
    }
  }
  return { sessionId: released ? undefined : sessionId, released }
}


function normalizeOwnerChecked(value: string): 'session' | 'no-claim' | 'owner-tenure-over' | 'owner-settled' | 'claim-released' {
  switch (value) {
    case 'no-claim': return 'no-claim'
    case 'claim-released': return 'claim-released'
    case 'owner-tenure-over': return 'owner-tenure-over'
    case 'owner-settled': return 'owner-settled'
    default: return 'session'
  }
}

/**
 * 认领会话的派发状态：`none`（台账里查不到它被派发过）／`live`（在飞）／`settled`（已结算）。
 *
 * **`TASK-213` 落点二**：参数从 `Journal` 换成**一次读出来的事件数组** —— 采纳判定对同一份台账
 * 要问四件事（recorded / hashed / verified / dispatch），修前每问一次都 `journal.read()` 一次，
 * 一叠就是 N+1（实测 `pendingReviewBigCards` 一次调用 279 次读）。判据一个字都没改，只是**别重复读**。
 * **`TASK-220`**：参数再进一步收成**按 type 分组的事件索引** —— 不再全文重扫（判据仍然一字未改）。
 */
function dispatchState(index: EventIndex, childSessionId: string | undefined): 'none' | 'live' | 'settled' {
  if (childSessionId === undefined || childSessionId === '') return 'none'
  const started = index.of('dispatch/started').some(
    (event) => String(event.data['childSessionId'] ?? '') === childSessionId,
  )
  if (!started) return 'none'
  const finished = index.of('dispatch/finished').some(
    (event) => String(event.data['childSessionId'] ?? '') === childSessionId,
  )
  return finished ? 'settled' : 'live'
}

/** 某条评审最近一条 `review/recorded`（吃**按 type 分组的索引**，见 `dispatchState` 的说明）。 */
function recordedEvent(index: EventIndex, reviewId: string): JournalEvent | undefined {
  const hits = index.of('review/recorded').filter((event) => String(event.data['id'] ?? '') === reviewId)
  return hits[hits.length - 1]
}

/** 最新一条**补记指纹**（`review/hashed`）的内容哈希；没有则 `undefined`。 */
function latestHashEvent(index: EventIndex, reviewId: string): string | undefined {
  const hits = index.of('review/hashed').filter((event) => String(event.data['id'] ?? '') === reviewId)
  const value = hits[hits.length - 1]?.data['contentHash']
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
  // **`TASK-230` 落点二**：改走**记忆化评审表**（修前这里每问一次就读一遍 121 个 YAML，真账 6.6~14.5ms）
  const review = listReviewsCached(store, journal).find((item) => item.id === input.reviewId)
  if (review === undefined) return { ok: false, code: 'no-review', detail: fmt('uiReview.noReview', { p1: input.reviewId }) }
  const current = reviewContentHash(review)
  // **`TASK-213`**：两条判定读同一份台账 ⇒ 读一次（修前这里读两次）
  // **`TASK-220`**：这一份换成记忆化的**按 type 分组索引**（两条判定各取一组，不再重扫整份台账）
  const index = journal.eventsIndex()
  const recorded = recordedEvent(index, review.id)
  const recordedHash = typeof recorded?.data['contentHash'] === 'string' ? recorded.data['contentHash'] : undefined
  const existing = recordedHash ?? latestHashEvent(index, review.id)
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

function verifiedEvents(index: EventIndex, reviewId: string): JournalEvent[] {
  return index.of('review/verified').filter((event) => String(event.data['id'] ?? '') === reviewId)
}

/**
 * 一条评审的**采纳状态**（唯一的判定入口：门禁、`done` 关、回执都读它，不各写一份）。
 *
 * **`TASK-220`**：内部收成 `adoptionOf(review, index, dispositions)` —— 事件视图换成**按 type 分组的
 * 索引**、核实留痕整表换成**记忆化视图**。判据一个字都没改，改的只是"别把同一份台账重扫一遍"。
 */
export function reviewAdoption(
  store: SdoStore,
  journal: Journal,
  review: Review,
  /**
   * **已经读出来的事件数组**（`TASK-213` 落点二）。
   *
   * 不传 ⇒ 走本台账**当次代次**的记忆化索引（`journal.eventsIndex()`）；传了 ⇒ 用调用方那一份
   * （三指纹与规范视图相同就直接复用记忆化的索引，否则现建一份，语义仍以调用方给的为准）。
   */
  events?: readonly JournalEvent[] | undefined,
  /**
   * **已经读出来的核实留痕整表**（`TASK-213` 落点二，第二个 N+1）。
   *
   * 不传 ⇒ `listDispositionsCached`（记忆化，命中 ~0.02ms）。批量路径必须只读一次、逐条传下去。
   */
  dispositions?: readonly ReviewFindingDisposition[] | undefined,
): ReviewAdoption {
  const index = events === undefined ? journal.eventsIndex() : journal.indexOf(events)
  return adoptionOf(review, index, dispositions ?? listDispositionsCached(store, journal))
}

/**
 * 采纳判定的**实心实现**（不经记忆化的唯一形态：索引 + 留痕整表都由调用方给）。
 *
 * 为什么要把"取数据"和"判定"分开：批量路径必须先取一次、再逐条判 —— 否则又回到 N+1（`TASK-213` 的教训）。
 */
function adoptionOf(
  review: Review,
  index: EventIndex,
  dispositions: readonly ReviewFindingDisposition[],
): ReviewAdoption {
  const base = { review, tamperGuard: 'none-legacy' as TamperGuard, pending: [] as number[], stale: [] as number[], forged: [] as number[], examined: false }
  const recorded = recordedEvent(index, review.id)
  if (recorded === undefined) return { ...base, state: 'unrecorded' }
  const recordedHash = typeof recorded.data['contentHash'] === 'string' ? recorded.data['contentHash'] : undefined
  // **G-2**：老事件没有 `contentHash` ⇒ 允许 `sdo_review action=rehash` 补记一条 `review/hashed`。
  // 两者都没有 ⇒ `none-legacy`（不静默：门禁与 list 会标注"该条不具备防篡改保护"）。
  const sealedHash = latestHashEvent(index, review.id)
  const expected = recordedHash ?? sealedHash
  const tamperGuard: TamperGuard = expected === undefined ? 'none-legacy' : 'content-hash'
  if (expected !== undefined && expected !== reviewContentHash(review)) return { ...base, state: 'tampered', tamperGuard }

  const mine = dispositions.filter((item) => item.reviewId === review.id)
  const backed = verifiedEvents(index, review.id)
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
  return { review, tamperGuard, state, pending, stale, forged, examined: true }
}

/**
 * **采纳表**（全部评审的采纳态，按 id 序）的**记忆化视图** —— 键 = `(台账路径, 代次)` + 来源探针，
 * 并且**能增量应用**（`TASK-230`）。
 *
 * 为什么要有这一层（`TASK-220`）：门禁 / `done` 关 / 状态块 / 报告都要"全部评审的采纳态"，
 * 修前每处各折一遍（实测 37.62 / 33.64 / 30.62ms，三次同价 = 零记忆化）。
 *
 * **`TASK-230` 的增量判据**（与读层同一个判据）：写一条事件之后，代次变了但**来源文件一字未动**，
 * 且 `g` 之后每一次换代都是"只追加"（`appendedSince` 给得出那几条事件）⇒ 只把**受影响的评审**
 * 重判一遍（`applyAdoptionTable`），其余条目原样沿用 —— append-only 台账里，已有结论不会因为
 * 末尾多了一条事件而改变。换 inode / 截断 / 全量重解析 ⇒ `appendedSince` 给 `undefined` ⇒ 整批重算。
 *
 * 返回的是**共享只读表**：调用方要改先自己拷一份（判据不改、只是别重算）。
 */
export function adoptionTable(
  store: SdoStore,
  journal: Journal,
  /**
   * **已经读出来的事件数组**（可选）。
   *
   * 不传 ⇒ 本函数自己 `read()` 一次（命中 0.04ms）；传了 ⇒ **不再读盘**（调用方刚读过，
   * 用 `journal.indexOf` 复用它那一份建索引）。`M234-05` 的"一次 `pendingReviewBigCards` 只读一次台账"
   * 就是靠这条守住的：一次调用链里只 stat 一次，其余全部走记忆化。
   */
  events?: readonly JournalEvent[] | undefined,
): ReadonlyMap<string, ReviewAdoption> {
  const log = events ?? journal.read().events
  // 调用方给的若不是**规范全量视图**（子集），现算但**不进记忆化**：否则子集结果会被记成"全量采纳表"
  if (events !== undefined && !journal.isCanonicalView(events)) {
    reviewAdoptionStats.computes += 1
    return adoptionsOf(store, journal, log)
  }
  return journal.memoDerived<ReadonlyMap<string, ReviewAdoption>>('review-adoptions', reviewProbes(store), () => {
    reviewAdoptionStats.computes += 1
    return adoptionsOf(store, journal, log)
  }, {
    apply: (previous, appended) => applyAdoptionTable(store, journal, previous, appended),
  })
}

/** 采纳表的实心实现（只在记忆化未命中时跑一次）。 */
function adoptionsOf(
  store: SdoStore,
  journal: Journal,
  events: readonly JournalEvent[],
): Map<string, ReviewAdoption> {
  const index = journal.eventsIndex(events)
  const dispositions = listDispositionsCached(store, journal)
  const items = listReviewsCached(store, journal)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((review) => adoptionOf(review, index, dispositions))
  return new Map(items.map((item) => [item.review.id, item]))
}

/**
 * **能改掉某条评审采纳态的事件类型**（`TASK-230` 的增量白名单）。
 *
 * 为什么这三种是**完备**的：采纳判定只读三处事件 —— `recordedEvent`（`review/recorded`）、
 * `latestHashEvent`（`review/hashed`）、`verifiedEvents`（`review/verified`），
 * 逐条核过 {@link adoptionOf} 的函数体（其余输入是评审 YAML 与 `reviews/verified.yml`，
 * 二者都由**来源探针**把关：探针一变就整批重算，轮不到增量）。
 * 将来若让 `adoptionOf` 多读一种事件，**必须**往这里加 —— 漏了不会报错，只会安静地少判一条。
 */
const ADOPTION_EVENT_TYPES: readonly string[] = ['review/recorded', 'review/hashed', 'review/verified']

/**
 * 一批新事件里**点名**的评审 id（只认上面三种类型；没有 `id` 的事件等于没点名）。
 *
 * **对外导出**（`TASK-230`）：`pendingReviewBigCards` 的增量应用要用**同一个**白名单 ——
 * 两处各写一份必然分叉（`DEF-044` 的教训：同一概念两处判据）。
 */
export function affectedReviewIds(appended: readonly JournalEvent[]): Set<string> {
  const ids = new Set<string>()
  for (const event of appended) {
    if (!ADOPTION_EVENT_TYPES.includes(event.type)) continue
    const id = String(event.data['id'] ?? '')
    if (id !== '') ids.add(id)
  }
  return ids
}

/**
 * **增量应用**：只重判"被新事件点名"的评审，其余条目原样搬过来（`TASK-230`）。
 *
 * 三种情形：① 一条都没点名 ⇒ 原样返回**同一份表**（结论不可能变）；② 点名的评审不在表里
 * （表是 `listReviews` 的全集）⇒ 同样无事发生；③ 否则新建一份 Map（浅拷 + 逐条覆盖）。
 * 顺序不变：`new Map(previous)` 保住 id 序，`set` 已有键不挪位置。
 */
function applyAdoptionTable(
  store: SdoStore,
  journal: Journal,
  previous: ReadonlyMap<string, ReviewAdoption>,
  appended: readonly JournalEvent[],
): ReadonlyMap<string, ReviewAdoption> | undefined {
  const affected = affectedReviewIds(appended)
  if (affected.size === 0) return previous
  const index = journal.eventsIndex()
  const dispositions = listDispositionsCached(store, journal)
  const next = new Map(previous)
  let touched = false
  for (const review of listReviewsCached(store, journal)) {
    if (!affected.has(review.id)) continue
    next.set(review.id, adoptionOf(review, index, dispositions))
    touched = true
  }
  return touched ? next : previous
}

/**
 * 全部评审的采纳状态（按 id 序，回执与门禁共用）。
 *
 * **`TASK-220`**：不带 `events` / `reviews` 时走 {@link adoptionTable}（记忆化，第二次调用实测 <1ms）；
 * 调用方自带的视图若就是**当次代次的规范全量视图**（三指纹），也复用同一张表 —— 语义相同，
 * 只是不再重算。带**非规范视图**（子集）时才现算，判据仍以调用方给的那一份为准。
 */
export function reviewAdoptions(
  store: SdoStore,
  journal: Journal,
  /** 已经读出来的事件数组（批量路径必须传：一次读、逐条判定 —— `TASK-213` 落点二） */
  events?: readonly JournalEvent[] | undefined,
  /**
   * 已经读出来的评审清单（可选）。
   *
   * 调用方往往**已经**读过一遍（例如 `pendingReviewBigCards`），不传就会再读一遍 98 个 YAML
   * —— 真账实测单次 ~5.4ms。判据不变，只是别重复读同一批文件。
   */
  reviews?: readonly Review[] | undefined,
): ReviewAdoption[] {
  reviewAdoptionStats.calls += 1
  if (reviews === undefined) {
    // 一次链里只读一次台账：这里读，下面全部复用（`adoptionTable` 命中记忆化时连读都省不了这一次
    // stat —— 那正是读层"新鲜度"的责任，不能因为记忆化就跳过）
    const log = events ?? journal.read().events
    return [...adoptionTable(store, journal, log).values()]
  }
  reviewAdoptionStats.computes += 1
  // 调用方自带**评审清单**（可能只是子集）⇒ 现算；索引与留痕整表仍走记忆化视图（与视图无关）
  const index = events === undefined ? journal.eventsIndex() : journal.indexOf(events)
  const dispositions = listDispositionsCached(store, journal)
  return reviews
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((review) => adoptionOf(review, index, dispositions))
}

/**
 * 某张卡的评审（按 id 序 = 记录顺序）。
 *
 * **`TASK-230` 落点二**：没有 `Journal` 入参 ⇒ 没法走记忆化视图，只能在**真源读取**上直接筛。
 * 需要批量/热路径的调用方请用 {@link adoptedPassReviews}（它走 `reviewsOfCardCached`）。
 * 这一格保留原形是为了不改既有签名（门禁与回执里都在用）。
 */
export function reviewsOfCard(store: SdoStore, taskId: string): Review[] {
  return listReviews(store)
    .filter((review) => review.taskId === taskId)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** 某张卡**已被采纳**的 `pass` 评审（C-42 / C-52 的覆盖判据只认它）。 */
export function adoptedPassReviews(store: SdoStore, journal: Journal, taskId: string): Review[] {
  // **`TASK-213`**：同一批评审判定用的是同一份台账 ⇒ 读一次（修前每条评审各读一次）
  // **`TASK-220`**：索引与留痕整表都走记忆化视图（同一次判定里不再各读一遍）
  const index = journal.eventsIndex()
  const dispositions = listDispositionsCached(store, journal)
  return reviewsOfCardCached(store, journal, taskId).filter(
    (review) => review.verdict === 'pass' && adoptionOf(review, index, dispositions).state === 'adopted',
  )
}

/** 某张卡的评审（**记忆化评审表**上过滤，按 id 序）—— `reviewsOfCard` 的批量形态。 */
function reviewsOfCardCached(store: SdoStore, journal: Journal, taskId: string): Review[] {
  return listReviewsCached(store, journal)
    .filter((review) => review.taskId === taskId)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * **有 `pass` 测试结论、却没有被已采纳评审点名的 `fixed` 缺陷**（DEF-076 / 第四批 §3.3）—— 判据的唯一出口。
 *
 * 病根：缺陷的"已评审"状态过去**没有结构化真源**（`sdo_review` 只能绑卡、不能点名缺陷）⇒ 一条 `fixed`
 * 缺陷可以跳过评审直接拿到 `pass` 测试结论并 `closed`，而判据无从察觉（`C-65` 只看"有没有 pass 的 TR 绑定"）。
 * 用户裁决的顺序是**先评审、后测试**（`ADR-013`：`closed` = 已核实**且**已测试通过），本条把它变成机械后果。
 *
 * 口径（与 `C-65` 分工，不重复点名同一件事）：
 *   · **触发**：`status === 'fixed'` **且**有一条 `pass` 的 TR 把它绑进 `defects`（`fixed` 却**没有** TR 的行
 *     是 `C-65` 的红，不在这里重复 —— 同一概念两处判据必然分叉，`DEF-044` 的教训）；
 *   · **依据**：存在一条**已采纳**（`reviewAdoption().state === 'adopted'`）**且 `pass`** 的评审，
 *     它的 `defects` 里点了这个 id（= `adoptedPassReviews` 的"跨卡"版口径；`adopted` 本身就要求
 *     每条 finding 都被实现方核实过，所以"已采纳"就是"核实过"）；
 *   · **只看评审的 `defects` 声明**，不解析散文 —— 结构化真源是这条判据成立的前提。
 */
export function fixedDefectsWithoutAdoptedReview(
  store: SdoStore,
  journal: Journal,
  /**
   * 已经算好的采纳表（可选）。门禁一次检查里它已经有这张表了 —— 传下来就不会再问一遍
   * （`TASK-220`：同一参数重复调用在门禁里一处都不留）。不传 ⇒ 走记忆化视图（命中也只是 0.02ms）。
   */
  adoptions?: ReadonlyMap<string, ReviewAdoption> | undefined,
): string[] {
  const passing = new Set<string>()
  for (const result of listTestResults(store)) {
    if (result.status !== 'pass') continue
    for (const raw of result.defects ?? []) {
      const id = textOf(raw).trim()
      if (id !== '') passing.add(id)
    }
  }
  const reviewed = new Set<string>()
  for (const adoption of (adoptions ?? adoptionTable(store, journal)).values()) {
    if (adoption.state !== 'adopted' || adoption.review.verdict !== 'pass') continue
    for (const raw of adoption.review.defects ?? []) {
      const id = textOf(raw).trim()
      if (id !== '') reviewed.add(id)
    }
  }
  return listDefects(store)
    .filter((defect) => defect.status === 'fixed')
    .filter((defect) => passing.has(defect.id) && !reviewed.has(defect.id))
    .map((defect) => defect.id)
}

/**
 * 某张卡**还没核实完**的评审（任意 verdict，按 id 序）—— `done` 关与回执用它说清"还欠哪几条"。
 *
 * 只把**有发现**的评审算进来：一条 `changes-requested` 若一条发现都没写，没有任何可核实的东西
 * （`sdo_review action=record` 也不允许这种空壳，见那边的守卫）。
 */
export function unverifiedReviewsOfCard(store: SdoStore, journal: Journal, taskId: string): ReviewAdoption[] {
  /**
   * **`TASK-220`**：修前是「每条评审各读一次台账 + 各读一次留痕整表」的 N+1（一条卡有 k 条评审就是
   * 2k 次读盘）。现在三样各取一次、逐条判 —— 判据（`findings.length > 0 && state !== 'adopted'`）一字未改。
   */
  const index = journal.eventsIndex()
  const dispositions = listDispositionsCached(store, journal)
  return reviewsOfCardCached(store, journal, taskId)
    .map((review) => adoptionOf(review, index, dispositions))
    .filter((item) => item.review.findings.length > 0 && item.state !== 'adopted')
}

/**
 * `done` 关：卡上**最新一条**评审是 `changes-requested` / `reject` 且还没核实完 ⇒ 返回它（**拦**）。
 *
 * 为什么只看最新一条：一条更新的 `pass` 评审就是"上次要求改动已经过了"的凭据，
 * 老的非通过评审不该永远拦住这张卡（评审是追加式的，永远不删）。
 */
export function blockingReview(store: SdoStore, journal: Journal, taskId: string): ReviewAdoption | undefined {
  // **`TASK-213`**：一张卡的多条评审读同一份台账 ⇒ 读一次
  // **`TASK-220`**：索引 / 留痕整表 / 评审表都取记忆化视图（各一次，不再每条评审各读一遍）
  const index = journal.eventsIndex()
  const dispositions = listDispositionsCached(store, journal)
  const all = reviewsOfCardCached(store, journal, taskId)
    .map((review) => adoptionOf(review, index, dispositions))
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
  // **`TASK-220`**：评审表走记忆化视图（同一次核实里它被问一次；门禁/回执那边已经热了）
  const review = listReviewsCached(store, journal).find((item) => item.id === input.reviewId)
  if (review === undefined) return { ok: false, code: 'no-review', detail: fmt('uiReview.noReview', { p1: input.reviewId }) }
  const findings = (review.findings ?? []).map((item) => textOf(item))
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= findings.length) {
    // **DEF-043 落点一（统一基准 + 双写）**：越界回执与成功回执用**同一形式** ——
    // 既点名**参数基准**的序号（1 起，`input.index + 1`），又点名**台账基准**的 index（0 起），
    // 并给出**合法范围**。旧实现只印 `input.index + 1`（参数 0 ⇒ "找不到第 0 条"，读起来与成功回执不同基准）
    // ⇒ 使用者只能靠试错摸清两套基准的关系。
    return {
      ok: false,
      code: 'bad-index',
      detail: fmt('uiReview.badIndex', {
        p1: input.reviewId,
        p2: String(findings.length),
        p3: String(input.index + 1),
        p4: String(input.index),
        p5: findings.length === 0 ? '0' : `1-${findings.length}`,
      }),
    }
  }
  if (input.outcome !== 'reproduced' && input.outcome !== 'refuted') {
    return { ok: false, code: 'bad-outcome', detail: fmt('uiReview.badOutcome', { p1: String(input.outcome) }) }
  }
  const evidence = textOf(input.evidence).trim()
  if (evidence === '') {
    return { ok: false, code: 'empty-evidence', detail: t('uiReview.emptyEvidence') }
  }
  // **不能自己核实自己**：记录这条评审的会话不许给自己发"已核实"（拿得到记录会话时才做）
  // **`TASK-213` 落点二**：这个函数要问台账四件事（recorded / 认领状态 / 派发角色 / 派发是否结算），
  // 修前每件都各读一次；现在读一次、四处共用（判据一字未改）。
  // **`TASK-220`**：`log` 换成记忆化的**按 type 分组索引**（recorded / claimed / dispatch 各取一组，
  // 不再对整份台账重扫三遍）；留痕整表也只取一次、两处共用（修前这里读两遍 8.5ms/遍）。
  // **`REV-095` 必核四③（`TASK-279`）**：`dispatchRoleOf` 过去自己再 `journal.read()` 一次、
  // 收尾的 `reviewAdoption` 又 `journal.eventsIndex()` 读一次 ⇒ 一次核实 **3 次** `read()`。
  // 现在**第一次读就是唯一一次**：`log` 交给索引（`eventsIndex(log)` 不再读盘），索引交给
  // `dispatchRoleOf`，`log` 与留痕整表一起交给 `reviewAdoption`。
  const log = journal.read().events
  const index = journal.eventsIndex(log)
  const dispositions = listDispositionsCached(store, journal)
  const recorded = recordedEvent(index, review.id)
  const recordedSession = typeof recorded?.data['sessionId'] === 'string' ? recorded.data['sessionId'] : undefined
  if (input.sessionId !== undefined && recordedSession !== undefined && input.sessionId === recordedSession) {
    return { ok: false, code: 'self-verify', detail: fmt('uiReview.selfVerify', { p1: review.id, p2: recordedSession }) }
  }
  // **实现方才能核实**：该卡最新认领会话。拿不到认领、或实现方**已经不可达**（任期结束／派发已结算）
  // ⇒ 放行并**如实标注**（G-1：否则一次性子代理退役后，它留下的评审**永久**不可采纳）。
  const claimed = currentClaim(index, review.taskId)
  const claimSession = claimed.sessionId
  const card = listTasks(store).find((item) => item.id === review.taskId)
  // 核实者的角色：从"这个会话被派发成什么角色"现算（拿不到就是 unknown，编不出来）
  // 传 `index`：这一次核实的台账读在函数开头已经发生过一次，别在这里再读一遍（`REV-095` 必核四③）
  const verifierRole = input.sessionId === undefined ? '' : dispatchRoleOf(journal, input.sessionId, index)
  const ownerChecked: 'session' | 'no-claim' | 'owner-tenure-over' | 'owner-settled' | 'claim-released' = (() => {
    // **`DEF-099`（真机，2026-10-18）**：认领后**释放** ⇒ 当前没有 owner（旧实现把释放后的旧会话当 owner）。
    if (claimed.released) return 'claim-released'
    if (claimSession === undefined) return 'no-claim'
    if (input.sessionId !== undefined && claimSession === input.sessionId) return 'session'
    // 卡已离开 in-progress（或卡不存在）⇒ 实现方对这张卡的任期已结束
    if (card === undefined || card.status !== 'in-progress') return 'owner-tenure-over'
    // 卡还在进行中，但那个子会话的派发已结算 ⇒ 看不到活的执行者
    if (dispatchState(index, claimSession) === 'settled') return 'owner-settled'
    return 'session'
  })()
  if (ownerChecked === 'session' && claimSession !== undefined && input.sessionId !== undefined && claimSession !== input.sessionId) {
    return {
      ok: false,
      code: 'not-implementer',
      detail: fmt('uiReview.notImplementer', { p1: review.id, p2: review.taskId, p3: claimSession }),
    }
  }
  // **代核必须同角色**（2026-10-08 用户口径）：实现会话退役 ⇒ 首选**同角色**的会话代核，
  // 而不是"谁有 bash 谁上"（真机就是这么把 developer 卡的 29 条发现交给 tester 代核的）。
  // 判据用**评审自己记下的 `taskRole`**（记录时从卡上抄的）—— 卡 drop/重建/改角色都不会让它漂。
  // 拿不到角色关系（老评审没记 `taskRole`、或核实者不是子会话/是人工）⇒ 不判，如实标 `unknown`。
  const cardRole = textOf(review.taskRole).trim() !== '' ? textOf(review.taskRole).trim() : (card?.role ?? '')
  if (ownerChecked !== 'session' && verifierRole !== '' && cardRole !== '' && verifierRole !== cardRole) {
    return {
      ok: false,
      code: 'cross-role-verifier',
      detail: fmt('uiReview.crossRoleVerifier', { p1: review.id, p2: review.taskId, p3: cardRole, p4: verifierRole }),
    }
  }

  // **`DEF-117`（第十三批 §1.3）**：与**评审作者**的会话比对（作者会话来自 `review/recorded` 事件）。
  // 拿不到作者会话（老评审 / 人工记录）⇒ `unknown`（不假装独立，也不假装同人）。
  const independence: 'independent' | 'same-author' | 'unknown' =
    input.sessionId === undefined || recordedSession === undefined
      ? 'unknown'
      : input.sessionId === recordedSession
        ? 'same-author'
        : 'independent'
  const roleMatch: 'same-role' | 'cross-role' | 'unknown' =
    verifierRole === '' || card === undefined ? 'unknown' : verifierRole === card.role ? 'same-role' : 'cross-role'
  // **R-19 A**：同一 `(评审, 发现)` 已有核实 ⇒ 默认拒绝（回执说清"已由谁、什么时候、判成什么"）
  const previous = dispositions.find((item) => item.reviewId === review.id && item.index === input.index)
  if (previous !== undefined && input.revise !== true) {
    return {
      ok: false,
      code: 'already-verified',
      detail: fmt('uiReview.alreadyVerified', {
        p1: review.id,
        p2: String(input.index + 1),
        p3: previous.by,
        p4: previous.outcome,
        p5: previous.at,
      }),
    }
  }
  // **`DEF-100`（第十二批 §3.5）**：`reproduced` 的证词必须含**读数形态**（占位文本不算复现）。
  // 放在授权类判定（自己核自己 / 谁实现谁核 / 代核角色 / 已核过）**之后**：先回答"谁能核"，再要求"核得像读数"。
  if (input.outcome === 'reproduced' && !READABLE_PROOF.test(evidence)) {
    return { ok: false, code: 'placeholder-evidence', detail: t('uiReview.placeholderEvidence') }
  }
  // **R-19 A**：覆盖时要留痕（台账里看得出"这里曾被改判"）
  const revised = previous === undefined ? undefined : { outcome: previous.outcome, by: previous.by, at: previous.at }
  const disposition: ReviewFindingDisposition = {
    reviewId: review.id,
    index: input.index,
    findingHash: findingHashOf(findings[input.index] ?? ''),
    outcome: input.outcome,
    evidence,
    // **R-19 B**：有 `sessionId` 时缺省 `by` 不许落成 `human`（真机：子会话按实现者身份核实，却被标成 human，
    // 与同一行的 `sessionId` + `ownerChecked: session` 自相矛盾；去重后存活的恰好是这条被标错的）
    by: textOf(input.by).trim() !== ''
      ? textOf(input.by).trim()
      : input.sessionId === undefined
        ? 'human'
        : `${verifierRole === '' ? 'session' : `subagent:${verifierRole}`}:${input.sessionId.slice(0, 8)}`,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ownerChecked,
    ...(verifierRole === '' ? {} : { verifierRole }),
    roleMatch,
    independence,
    ...(revised === undefined ? {} : { revisedFrom: revised }),
    at: new Date().toISOString(),
  }
  const existing = dispositions.filter(
    (item) => !(item.reviewId === disposition.reviewId && item.index === disposition.index),
  )
  store.writeYaml(['reviews', REVIEW_VERIFICATIONS_FILE], { verifications: [...existing, disposition] })
  const excerpt = findingExcerpt(findings[input.index] ?? '')
  journal.append('review/verified', {
    id: disposition.reviewId,
    index: disposition.index,
    findingHash: disposition.findingHash,
    // **DEF-043 落点二（回写挂靠）**：事件里带上"挂到哪条发现"，两个基准当场可见。
    // 旧实现只记 0 起 index ⇒ 事后看不出这条证词是给哪条发现的。
    findingIndex: disposition.index + 1,
    findingExcerpt: excerpt,
    outcome: disposition.outcome,
    by: disposition.by,
    ...(disposition.sessionId === undefined ? {} : { sessionId: disposition.sessionId }),
    ownerChecked: disposition.ownerChecked,
    // **`DEF-117`**：事件里显式写「这条核实与评审作者是不是同一个人」（旧事件没有该字段 = `unknown`）
    independence: disposition.independence ?? 'unknown',
    // **`DEF-100`**：覆盖时把**被覆盖的那条**写进事件（派生视图只计最新，但审计要看得出"改过判"）
    ...(revised === undefined ? {} : { supersedes: revised }),
  })
  /**
   * **这里的读不能省**（`REV-095` 必核四③ 的边界，如实写清）：上面那一次读是**写之前**的快照，
   * 而这一行要判的是**刚刚写下去**的那两条真源（`reviews/verified.yml` 的新留痕 + `review/verified` 新事件）
   * ⇒ 必须按新代次重新取一次。把 `log` / `dispositions` 传进去会让它读到**写前**的旧表，
   * 于是"最后一条发现核实完 ⇒ 可采纳"永远不成立（实测：`M67-01` 当场红）。
   * 所以本函数的读数是 **写前 1 次（四处共用）+ 写后 1 次（判新状态）**，不是"全程 1 次"。
   */
  const after = reviewAdoption(store, journal, review)
  const verified = findings.length - after.pending.length - after.stale.length - after.forged.length
  return {
    ok: true,
    disposition,
    coverage: { verified: Math.max(0, verified), total: findings.length },
    adopted: after.state === 'adopted',
    findingIndex: disposition.index + 1,
    findingExcerpt: excerpt,
  }
}
