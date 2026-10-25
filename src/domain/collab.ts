import { dirname } from 'node:path'
/**
 * 协同协议（设计 §8.4 / T-M4-05）。
 *
 * 四条硬规则：
 *   ① **认领走 CAS**：必须带 `expectedRevision`，对不上就是冲突（不做"后写覆盖"）；
 *   ② **只有 owner 能回报**：别人不能替它结单；
 *   ③ **done 必须带证据**：没有证据的"完成"不算完成；
 *   ④ **失联不自动释放**：超时只报告"疑似失联"，释放必须显式 `release` / `reassign`（留痕）。
 */
import type { Journal } from '../infra/journal.js'
import { withProbeEpoch } from '../infra/journal.js'
import { textOf } from '../infra/scalar.js'
import type { SdoStore } from '../infra/store.js'
import type { EvidenceItem, JournalEvent, MitigatesWaiver, TaskCard } from '../types.js'
import { listTasks, producesProductArtifacts, scopeIntersections, writeTask } from './plan.js'
import { DISPATCH_ABORTED_EVENT, orphanLocks, unsettledDispatch } from './dispatchHealth.js'
import { normalizeScopePath, scopeOverlaps, scopePathWithin } from './scopePaths.js'

/**
 * **流程官身份**（DEF-012）：`sdo_task` 的 `actor` 是自由文本，流程官历来以 `human` / `office` /
 * `cockpit` 落账（`office` 还是本项目的角色之一）。这里只做**身份白名单**，不含任何项目/语言假设。
 */
const COCKPIT_ACTORS: readonly string[] = ['human', 'office', 'cockpit']
import { listDefects, findingHashOf, listTestResults, reviewContentHash, reviewReproIssue } from './records.js'
import type { Review } from './records.js'
import { auditDoneEvidence } from './evidence.js'
import { changedFilesSince } from './workspaceChanges.js'
import { describeTestFirstGaps, testFirstGaps } from './testFirst.js'
import {
  adoptionTable,
  affectedReviewIds,
  blockingReview,
  listReviewsCached,
  reviewAdoption,
  reviewAdoptionLabel,
  reviewAdoptions,
  reviewsOfCard,
} from './reviewVerification.js'
import type { ReviewAdoption } from './reviewVerification.js'
import { describeUndigestedChanges, undigestedChanges } from './change.js'
import { loadProcess } from './process.js'
import { staleEntryGateOf } from './entryGate.js'
import { fmt, t } from './i18n.js'
import {
  CONSTRUCTION_PHASES,
  claimGaps as constructionClaimGaps,
  doneGaps as constructionDoneGaps,
  doneNaNotes as constructionDoneNaNotes,
  readConstructionProfile,
} from './construction.js'
import { readProjectConfig } from '../config.js'
import type { EvidenceAuditCode } from './evidence.js'
import { auditWriteScopes } from '../integration/orchestrator.js'

function now(): string {
  return new Date().toISOString()
}

/**
 * 一条 `fixes` 声明对应的**缺陷现状行**（DEF-050 / TASK-072，判据 `C-63`）。
 *
 * 为什么这个形状由域层定、文案由语言包出：门禁 `gates.ts` 被 i18n 棘轮钉在硬编码中文 0
 * （`test/m7.test.ts` 基线 `src/domain/gates.ts: 0`），所以"现 status / 缺什么"这种人话
 * 一律走 `uiGates.kFix*`；`gates.ts` 只把这里的三态翻成判据的三态，不再自己写一句话。
 */
export interface FixStatusRow {
  id: string
  /** 台账里的现状态（`open` / `fixed` / `closed` / `wontfix`） */
  status: string
  waiveReason: string
  waiveApprovedBy: string
  /** 放行条件是否成立：`fixed` / `closed`，或 `wontfix` + 免责两字段去空白后**都非空** */
  closable: boolean
  /** 不成立时缺什么（人类可读，直接进判红详情） */
  missing: string
}

/**
 * **`fixes` 声明的唯一出口**（判据 `C-63` 与 `done` 回显共用同一份口径）。
 *
 * 判定表（与卡上落点二逐字对应）：
 *
 * | # | 台账现状态 | 结论 |
 * |---|---|---|
 * | ① | `fixed` / `closed` | 成立 —— 修复已落地并闭合 |
 * | ② | `wontfix` + `waiveReason`/`waiveApprovedBy` 去空白后**都非空** | 成立 —— **署名放弃** |
 * | ③ | `wontfix` 但任一字段为空/缺 | **不成立**，缺什么要点名（口径同 DEF-038，不新造） |
 * | ④ | `open`（或任何其它状态） | **不成立** —— 卡说修完了，台账说还开着 |
 *
 * **为什么不用 `isBlockerWaived`**：`records.ts` 那个出口是**阻塞级专用**（它先要求
 * `severity === 'blocker'`），而本判据要覆盖 major/minor —— 卡上背景第③条点名的正是
 * "C-51 只覆盖 blocker，已修未闭合的 major/minor 会无限期沉在 open 里"。
 * 所以这里复用**同一套免责语义**（两个字段 + 去空白非空），但不复用那个 blocker 前置条件。
 */
export function fixStatusRows(
  fixes: readonly string[],
  defects: readonly { id: string; status: string; waiveReason?: string | undefined; waiveApprovedBy?: string | undefined }[],
): FixStatusRow[] {
  const byId = new Map(defects.map((defect) => [defect.id, defect]))
  return fixes.map((id) => {
    const defect = byId.get(id)
    if (defect === undefined) {
      return {
        id,
        status: 'missing',
        waiveReason: '',
        waiveApprovedBy: '',
        closable: false,
        missing: fmt('uiGates.kFixMissingDetail', { p1: id }),
      }
    }
    const status = defect.status
    if (status === 'fixed' || status === 'closed') {
      return { id, status, waiveReason: '', waiveApprovedBy: '', closable: true, missing: '' }
    }
    const reason = textOf(defect.waiveReason).trim()
    const approver = textOf(defect.waiveApprovedBy).trim()
    if (status === 'wontfix' && reason !== '' && approver !== '') {
      return { id, status, waiveReason: reason, waiveApprovedBy: approver, closable: true, missing: '' }
    }
    if (status === 'wontfix') {
      const absent: string[] = []
      if (reason === '') absent.push(t('uiGates.kDefectWaiveFieldReason'))
      if (approver === '') absent.push(t('uiGates.kDefectWaiveFieldApprover'))
      return {
        id,
        status,
        waiveReason: reason,
        waiveApprovedBy: approver,
        closable: false,
        missing: fmt('uiGates.kFixWaiveIncomplete', { p1: absent.join('、') }),
      }
    }
    return {
      id,
      status,
      waiveReason: reason,
      waiveApprovedBy: approver,
      closable: false,
      missing: fmt('uiGates.kFixStatusOpen', { p1: status }),
    }
  })
}

/** 判据与回执共用的**判红修法**（一条命令能照抄执行；文案在语言包）。 */
export function fixesRemedy(): string {
  return t('uiGates.kFixRemedy')
}

/**
 * 一条 `mitigates` 声明对应的**风险现状行**（DEF-051 / TASK-080，判据 `C-64`）。
 *
 * 与 `FixStatusRow` 逐字同族（同一个读者问题：卡说这件事了结了，台账认不认），
 * 差别只有一处：风险台账**没有 `wontfix`**（`RiskItem.status` 只有 `open` / `mitigated` / `closed`），
 * 所以"仍要开着"的表达不在风险行上，而在**卡**上（`mitigatesWaiver`，署名理由）。
 */
export interface MitigatesRow {
  /** 被声明的风险 id（`RISK-*`；台账里没有它时也原样带出来点名）。 */
  id: string
  /** 台账里的现状态（`open` / `mitigated` / `closed`；找不到该条时是 `missing`）。 */
  status: string
  /** 放行条件是否成立：`mitigated`/`closed`，或卡上有一条两字段齐备的豁免。 */
  closable: boolean
  /** 不成立时缺什么（人类可读，直接进判红详情）。 */
  missing: string
}

/**
 * **`mitigates` 声明的唯一出口**（判据 `C-64` 与 `done` 回显共用同一份口径）。
 *
 * 判定表（与卡上落点二逐字对应）：
 *
 * | # | 台账现状态 | 卡上的豁免 | 结论 |
 * |---|---|---|---|
 * | ① | `mitigated` / `closed` | — | 成立 —— 风险确实被消除了 |
 * | ② | `open` | 有，且 `waiveReason`/`waiveApprovedBy` 去空白后**都非空** | 成立 —— **署名接受它仍开着** |
 * | ③ | `open` | 有，但任一字段为空/缺 | **不成立**，缺哪个字段要点名（口径同 DEF-038，不新造） |
 * | ④ | `open` | 没有 | **不成立** —— 卡说把风险处理掉了，台账说还开着 |
 * | ⑤ | 台账里没有这个 id | — | **不成立** —— 声明落在空气上（写错号看不出来） |
 *
 * 为什么豁免在**卡**上而不是在风险行上：本缺陷的形态正是"卡做完了、风险还是 open，
 * 而两边都不说话"。把理由放在卡上，`done` 的那一刻就能看见"这张卡为什么没关掉它"；
 * 放在风险行上则读者要先知道去看哪条风险。
 */
export function mitigatesRows(
  mitigates: readonly string[],
  risks: readonly { id: string; status: string }[],
  waivers: readonly MitigatesWaiver[] = [],
): MitigatesRow[] {
  const byId = new Map(risks.map((risk) => [risk.id, risk]))
  const waiverById = new Map(waivers.map((waiver) => [textOf(waiver.id).trim(), waiver]))
  return mitigates.map((raw) => {
    const id = textOf(raw).trim()
    const risk = byId.get(id)
    if (risk === undefined) {
      return { id, status: 'missing', closable: false, missing: fmt('uiGates.kMitigatesRowMissing', { p1: id }) }
    }
    const status = textOf(risk.status)
    if (status === 'mitigated' || status === 'closed') {
      return { id, status, closable: true, missing: '' }
    }
    const waiver = waiverById.get(id)
    if (waiver === undefined) {
      // 单参数键（`kMitigatesStatusOpen` 的模板只有一个槽位）：卡层只负责说"现状态还开着"，
      // 卡 id 与风险 id 由判据层拼进外层模板（`kMitigatesRowOpen`）—— 两个键各管一件事。
      return { id, status, closable: false, missing: fmt('uiGates.kMitigatesStatusOpen', { p1: status }) }
    }
    const reason = textOf(waiver.waiveReason).trim()
    const approver = textOf(waiver.waiveApprovedBy).trim()
    if (reason !== '' && approver !== '') {
      return { id, status, closable: true, missing: '' }
    }
    const absent: string[] = []
    if (reason === '') absent.push(t('uiGates.kMitigatesWaiveFieldReason'))
    if (approver === '') absent.push(t('uiGates.kMitigatesWaiveFieldApprover'))
    return {
      id,
      status,
      closable: false,
      missing: fmt('uiGates.kMitigatesWaiveIncomplete', { p1: absent.join('、') }),
    }
  })
}

/** 判据与回执共用的**判红修法**（一条命令能照抄执行；文案在语言包）。 */
export function mitigatesRemedy(): string {
  return t('uiGates.kMitigatesRemedy')
}

/**
 * **卡级 `inputs` / `outputs` 声明的唯一出口**（DEF-051 / TASK-080，判据 `C-64` 的第二、三子句；
 * **DEF-064 收敛**：按**形态判别**只核对路径形态的声明，散文声明逐条回显但不参与判据）。
 *
 * 这两格此前**读了、也下发了**（`integration/orchestrator.ts` 把它们渲染进派发提示的
 * 「输入：…／输出：…」两行），却**没有任何判据核对** —— 读者会以为卡面声明是被核过的。
 * 现在做两件机械的事：
 *   ① **路径形态**的声明（见 `isPathShapedDeclaration`）必须在该卡自己的 `artifact` 证据里出现
 *      （去掉 `./` 与前后空白后按相等/包含匹配）—— 不出现就判红、逐条点名；
 *   ② **非路径形态**的声明（散文职责、能力名、编号清单）**不参与判据**，但必须**逐条回显**
 *      并写明它为什么未参与 —— 判据不许静默放过。
 *
 * 为什么用 `artifact` 而不是别的证据：`command` 只是一行命令摘要，`workspace-changes` 只是一个
 * 会话序号，两者都不点"做出了哪个文件"；而"声明的输出/输入"恰恰是**文件**。
 *
 * **形态判别而不是"恰好为空"**（DEF-064 / REV-043 发现 1 + 2）：第一版把"这两格全库为空"当作既成
 * 事实，于是选了口径"参与判据、零误伤"；实测那句话是错的 —— 存量完成卡里确有**散文**声明
 * （职责全文、REQ 验收标准、能力名），而一句散文永远不可能被一条文件路径包含 ⇒ 逐条假红。
 * 因此收敛成形态判别：**判据只对"确实是文件路径"的声明负责**，散文声明不进判据（也**不做存量
 * 数据迁移** —— 台账不该被本卡重写），但它必须在回执里被看见。
 *
 * 为什么"不参与"要回显而不是悄悄跳过：静默跳过与原来的假红是同一族病的两面（"判据对什么负责"
 * 说不清）；回显让人一眼看到"这几条声明没有被核过，因为它们不是路径"，从而能自己决定要不要把
 * 声明改写成路径形态。
 */
export interface DeclaredItemVerdict {
  /** 判红行：**路径形态**的声明没有被本卡 `artifact` 证据覆盖（逐条点名）。 */
  gaps: string[]
  /** **显式处置回显**：非路径形态的声明 —— 未参与判据，逐条说明为什么（不静默放过）。 */
  prose: string[]
  /** 参与判据的声明条数（路径形态且去空白后非空）—— 回执用它说清"核了几条"。 */
  judged: number
}

export function declaredItemVerdict(
  taskId: string,
  declared: { inputs: readonly string[]; outputs: readonly string[] },
  evidence: readonly EvidenceItem[],
): DeclaredItemVerdict {
  const artifacts = evidence
    .filter((item) => textOf(item.kind) === 'artifact')
    .map((item) => normalizePath(textOf(item.detail)))
    .filter((detail) => detail !== '')
  const gaps: string[] = []
  const prose: string[] = []
  let judged = 0
  const check = (field: string, values: readonly string[]): void => {
    for (const raw of values) {
      const value = textOf(raw).trim()
      if (value === '') continue
      // **形态判别**（DEF-064 的收敛点）：不是路径形态 ⇒ 不参与判据，改为逐条回显处置。
      if (!isPathShapedDeclaration(value)) {
        prose.push(fmt('uiGates.kDeclaredItemProseRow', { p1: taskId, p2: field, p3: value }))
        continue
      }
      judged += 1
      const wanted = normalizePath(value)
      const covered = artifacts.some((detail) => detail === wanted || detail.includes(wanted))
      if (covered) continue
      gaps.push(fmt('uiGates.kDeclaredItemMissing', { p1: taskId, p2: field, p3: value }))
    }
  }
  check('inputs', declared.inputs)
  check('outputs', declared.outputs)
  return { gaps, prose, judged }
}

/**
 * **形态判别式**：这条声明是不是"路径形态"（DEF-064 的收敛点，判据据此决定参不参与）。
 *
 * 口径刻意**偏保守**（宁可少判、不可假红）：只有读起来明确是一条路径/文件名的声明才参与判据。
 *   · 含空白 ⇒ 不是一条路径（散文、清单、"A / B 的实现"这类拼接都在此列）；
 *   · 含 `/`（`\` 已在上一步归一）⇒ 路径形态：`src/domain/x.ts`、`docs/`；
 *   · 无分隔符但形如 `name.ext` ⇒ 文件名形态：`out.js`、`REQ-024.yml`；
 *   · 其余（裸词、能力名、`REQ-045、REQ-046` 这类编号）⇒ **不参与**：它们无法被一条文件路径覆盖，
 *     判它们红只会产生假红（存量完成卡的声明正是这一类）。
 *
 * 与语言无关：只认分隔符与扩展名两种形态，不认任何特定语言/项目的写法。
 */
export function isPathShapedDeclaration(raw: string): boolean {
  const value = normalizePath(textOf(raw))
  if (value === '') return false
  if (/\s/u.test(value)) return false
  if (value.includes('/')) return true
  if (/^[^\s/]+\.[A-Za-z0-9]{1,8}$/u.test(value)) return true
  return false
}

/** 归一化一条声明/证据里的路径：去前后空白、去 `./` 前缀、统一分隔符。 */
function normalizePath(raw: string): string {
  return raw.trim().replace(/^\.\//u, '').replace(/\\/gu, '/')
}

/** `fixes` 声明里不合法的条目（可读拒绝用：重复 id / 空串）。 */
export interface FixesProblem {
  kind: 'duplicate' | 'blank'
  id: string
}

/**
 * **可读拒绝**的第一半（不依赖台账，可纯函数自证）：重复 id 与空串。
 *
 * 纪律（对照知识库 `tq_ff348198`）：参数校验**不得静默丢弃** —— 重复 = 声明了两遍同一件事
 * （多半是拼接错误），空串 = 写了个不存在的缺陷号却看不出来；两种都当场说清楚是哪一条。
 */
export function fixesListProblems(fixes: readonly string[]): FixesProblem[] {
  const problems: FixesProblem[] = []
  const seen = new Set<string>()
  for (const raw of fixes) {
    const id = textOf(raw).trim()
    if (id === '') {
      problems.push({ kind: 'blank', id: raw })
      continue
    }
    if (seen.has(id)) problems.push({ kind: 'duplicate', id })
    seen.add(id)
  }
  return problems
}

function save(store: SdoStore, task: TaskCard): TaskCard {
  writeTask(store, task)
  return task
}

export interface ClaimInput {
  /** 认领发生在哪个会话（A2：`done` 用它取"本会话的变更清单"做写范围对账）。 */
  sessionId?: string | undefined
  taskId: string
  owner: string
  /** 认领者看到的版本号（CAS） */
  expectedRevision: number
  /** 当前阶段（增量 3：构造阶段才检查实现阶段方法包；不传则从台账现读）。 */
  phase?: string | undefined
}

export type ClaimResult =
  | { ok: true; task: TaskCard }
  | {
      ok: false
      code:
        | 'not-found'
        | 'revision-mismatch'
        | 'not-claimable'
        | 'change-not-digested'
        // **DEF-040**：当前阶段的**入口门禁签字失效**（`stale`）—— 与上面那条"未消化变更"
        // 同族（都属"这条流程的入口承诺已经变了"），但判据不同源：这条读签字台账。
        | 'gate-stale'
        | 'write-scope-conflict'
        | 'test-case-missing'
        | 'construction-profile-missing'
        | 'contract-not-frozen'
      detail: string
      current?: TaskCard | undefined
    }

/** 认领一张任务卡（CAS + 写范围互斥兜底）。 */
export function claim(store: SdoStore, journal: Journal, input: ClaimInput): ClaimResult {
  // 让下面那行 `journal.loadProject()` 的读位置一眼可见：本函数**只读一次项目真源**，
  // gate-stale 与 phase 两条判据共用同一份读数（避免"两次读之间真源变了"的自我打架）。
  /**
   * **统一的拒绝出口**（DEF-059）：认领被拒**本身必须留痕**，否则「这张卡被争用了多少次」在真源里数不出
   * （真机：TASK-106 的会话被 `write-scope-conflict` 拒两次，全库零痕迹）。事件带**拒绝码** ⇒ 可按种类计数；
   * 且**不复用** `task/claim-blocked`（那是 `block` 动作的语义，混用会毁掉审计可分性）。
   */
  const reject = (
    code: Extract<ClaimResult, { ok: false }>['code'],
    detail: string,
    current?: TaskCard | undefined,
  ): ClaimResult => {
    journal.append('task/claim-rejected', {
      id: input.taskId,
      by: input.owner,
      code,
      detail,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    })
    return { ok: false, code, detail, ...(current === undefined ? {} : { current }) }
  }
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return reject('not-found', `找不到任务卡 ${input.taskId}`)
  if (task.revision !== input.expectedRevision) {
    return reject('revision-mismatch', `${task.id} 已变到 r${task.revision}（你看到的是 r${input.expectedRevision}）——重新读一遍再认领`, task)
  }
  if (task.status !== 'planned' && task.status !== 'ready') {
    return reject('not-claimable', `${task.id} 当前状态 ${task.status}${task.owner === undefined ? '' : `（owner=${task.owner}）`}，不可认领`, task)
  }
  // **语义 A（2026-10-04）**：批准但**未消化**的需求变更 ⇒ 拒绝认领。
  // 为什么必须拦在这里：`claim` 是唯一"不需要动文件就能开工"的入口，**不受阶段纪律约束**
  // （阶段纪律只管 `write`/`edit` 打到 `src/`、`test/`）—— 真机上 `CR-001` 批准 23 秒后
  // `task/claimed` 照常发生，正是从这个口子漏过去的。
  // 消化的定义（现算，不新增真源）：批准之后**重新基线**覆盖了该需求，且此后**重过设计门**。
  const project = journal.loadProject().project
  const process = loadProcess(project?.process ?? 'waterfall')
  const pendingChanges = undigestedChanges(store, journal, process)
  // **SDO-16 / SDO-17（2026-10-05 真机，blocker）**：**解冻路径不能被自己要解的冻锁住**。
  // 消化路径是「更新需求 → 重签 G2 → 重走设计过 G3」，而这条路上的卡（需求/架构角色）本身
  // 也要先认领 —— 真机上 TASK-128「重新冻结需求基线」被同一检查连拒 4 轮，6 张卡零开工，
  // 只能靠"无卡直接执行 + 流程官显式授权"绕行（那不是产品，是临场发挥）。
  // ⇒ 冻结只针对**施工/验证/交付**角色；流程侧角色（analyst / architect / office）可以开工去消化它。
  const digestingRole = task.role === 'analyst' || task.role === 'architect' || task.role === 'office'
  if (pendingChanges.length > 0 && !digestingRole) {
    return reject('change-not-digested', describeUndigestedChanges(pendingChanges, process) + '\n' + t('uiChange.notDigestedDigestPath'), task)
  }
  // **DEF-040 第三刀（认领面）**：当前阶段的**入口门禁签字失效**（`stale`）⇒ 拒绝认领。
  //
  // 为什么认领面也要拦：`claim` 是**唯一"不需要动文件就能开工"的入口**（不受阶段纪律约束，
  // 阶段纪律只管 `write`/`edit` 打到 `src/`、`test/`）—— 派发面拦住了，这里漏一个口子等于没拦
  // （与上面 `change-not-digested` 的成因逐字同源）。
  //
  // 判别位与派发面**同源**：一律走 `staleEntryGateOf`（唯一出口），只拦 `stale`，
  // **`missing` 放行** —— 从没签过 ≠ 失效，否则所有还没走到该门禁的正常流程会停摆。
  //
  // **解冻路径同样不能被自己要解的冻锁住**（SDO-16 / SDO-17 的同一课，见上一条注释）：
  // 门禁失效的补救动作是「按流程回到上游改真源 → 重签」，而那条路上的卡（analyst / architect /
  // office）本身也要先认领 ⇒ 与 `change-not-digested` 共用同一个 `digestingRole` 豁免。
  const staleGate = staleEntryGateOf(store, journal, project)
  if (staleGate !== undefined && !digestingRole) {
    return reject(
      'gate-stale',
      fmt('uiCollab.kGateStale', {
        p1: String(project?.phase ?? ''),
        p2: staleGate.gate,
        p3: staleGate.reason,
      }),
      task,
    )
  }
  // 写范围相交的运行时兜底（`REQ-066` / `ADR-025`）。
  //
  // 修前（`DEF-067` 时代）：相交**一律拒签**。`ADR-025` 之后口径变了：相交默认**照派**，
  // 两边各自在**自己的工作副本**（主仓库的 git worktree）里写，完成时靠**真三路合并**接回主干
  // ——「同一文件的不同区域」git 本来就能干净合并，用"文件级锁"把它拦下反而是缺陷。
  //
  // 两个面**必须同时改**（只改派发面 ⇒ 派得出来、认领不了 = 白烧一轮会话，正是 `DEF-067` 的病）：
  // 判定走**唯一出口** `scopeIntersections` / `scopeSerialKindOf`，与派发面 `scopeHeldTasks`
  // 是**同一份实现**；显式声明过先后的（`blockedBy` 任一方向、含 `'*'`）不算意外相交。
  //
  // **认领面只拦「声明了独占窗口」这一支**（`exclusive-window`）—— 它出自**声明**，不是猜测，
  // 拦下没有假阳性（两边都明说要独占同一段时间，同时开工正是 `DEF-127` 那类假红的来源）。
  // `unknown-scope`（写范围为空/缺失）**不在这里拦**：任务书 §2.1.4 把那条 fail-closed 写在
  // **派发**面上（"这两类情形下**不派发**"），因为能在那一层**补救**（补写范围 / 拆卡）；
  // 而在认领面拦它只会把「本来就不该由派发流程处理的卡」（驾驶舱 inline / 人工直接开工、
  // 以及 `writeScopes` 为空的文书/复核卡）一起钉死 —— 那是认领面的假阳性，且修不了计划缺陷。
  const serial = scopeIntersections(listTasks(store)).find((row) => row.task.id === task.id && row.kind === 'exclusive-window')
  if (serial !== undefined) {
    const clash = serial.holder
    // **DEF-053 落点②**：挡路的若是**孤儿锁**（卡在 in-progress，而拥有它的子会话早已结算），
    // 就地说明并给出**唯一安全出路** —— 不再让执行者自己排查"拦我的到底是不是活会话"。
    const orphan = orphanLocks(listTasks(store), journal.read().events).find((row) => row.taskId === clash.id)
    // **DEF-067 落点二**：拒签回执**点名重叠的那个路径**（旧实现倒出对方**全量**写范围，
    // 读者还得自己算哪一条撞上了），并给出三条出路。
    const detail = orphan === undefined
      ? fmt('uiCollab.kScopeConflict', {
          p1: clash.id,
          p2: clash.owner ?? t('uiCollab.unblockNoOwner'),
          p3: serial.overlap.join(t('uiCollab.kListSep')),
          p4: clash.status,
        })
      : fmt('uiCollab.kScopeConflictOrphan', {
          p1: clash.id,
          p2: clash.owner ?? t('uiCollab.unblockNoOwner'),
          p3: serial.overlap.join(t('uiCollab.kListSep')),
          p4: orphan.reason === '' ? t('uiCollab.kOrphanReasonUnknown') : orphan.reason,
          p5: orphan.command,
          p6: String(orphan.atSeq),
        })
    return reject('write-scope-conflict', detail, task)
  }
  // C7：测试先行 —— `normal`/`critical` 档的项目里，卡上的需求在**认领前**就要有用例计划
  const claimGaps = testFirstGaps(store, task, 'claim', journal)
  if (claimGaps.length > 0) {
    return reject('test-case-missing', describeTestFirstGaps(task.id, 'claim', claimGaps), task)
  }
  // 增量 3：**实现阶段方法包**的开工关（只在构造阶段生效；没到构造/没这套机制的项目行为不变）
  const phase = input.phase ?? project?.phase
  if (phase !== undefined && CONSTRUCTION_PHASES.has(String(phase))) {
    const read = readConstructionProfile(store)
    if (read.status !== 'ok') {
      return reject(
        'construction-profile-missing',
        read.status === 'invalid'
          ? fmt('uiConstruction.c22', { p1: read.problems.join('；') })
          : t('uiConstruction.c23'),
        task,
      )
    }
    // 认领事件自身还没写：用"当前最后一条 + 1"估计本次认领的序号。
    // 估低只会让检查更严（fail-safe）；正常台账下它与 journal 的分配一致。
    const events = journal.read().events
    const thisClaimSeq = (events[events.length - 1]?.seq ?? 0) + 1
    const contractGaps = constructionClaimGaps(store, journal, task, thisClaimSeq, read.profile)
    if (contractGaps.length > 0) {
      return reject('contract-not-frozen', contractGaps.map((item) => item.detail).join('；'), task)
    }
  }
  const next: TaskCard = { ...task, status: 'in-progress', owner: input.owner, revision: task.revision + 1, updatedAt: now() }
  // A2：认领事件**自身**就是写范围对账的基线（它带 sessionId，seq 由 journal 分配）
  journal.append('task/claimed', {
    id: next.id,
    owner: input.owner,
    revision: next.revision,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  })
  return { ok: true, task: save(store, next) }
}

export interface ReportInput {
  taskId: string
  owner: string
  status: 'done' | 'blocked'
  /**
   * **本次 `done` 未冻结的兄弟卡**（DEF-033 / 第三批 §3.13）：逐条点名"哪些在飞卡的工作没有并进来"。
   * 形状与校验见 `TaskCard.unfrozen`（每条必须存在且**当前确实在飞**，否则可读拒绝）。
   */
  unfrozen?: string[] | undefined
  evidence?: EvidenceItem[] | undefined
  note?: string | undefined
  /** 当前阶段（增量 3：收工关按所选方法包检查时用得到；不传则从台账现读）。 */
  phase?: string | undefined
  /**
   * **执行者自报的实际写入文件**（DEF-016 降级路径）。
   *
   * 为什么需要它：宿主只为**顶层轮次**公告 `workspace/changes`，子会话**永远采不到** ⇒
   * 写范围对账退化为人工比对（今日每张卡 done 都带「未对账」）。这是**上游能力边界**，
   * 插件侧只能让执行者**自报**，再用**同一个出口**（`auditWriteScopes`）机械核对。
   *
   * ⚠️ 自报是**声明**，不是观测 —— 回执与事件必须如实标注来源，绝不冒充宿主观测。
   */
  reportedFiles?: string[] | undefined
  /**
   * **公共面**（`settings.disciplineAllowPaths`，默认 `.sdo/` `docs/` `test/`），由 `office.ts` 传下来。
   *
   * **`DEN-198` 落点一**：写入闸门（`domain/writeScope.ts` 3a）早就把公共面当"不受卡范围约束"的面，
   * 而 `done` 的 A2 对账（`auditWriteScopes`）不认它 ⇒ **同一份改动，闸门放行、结算判越界**。
   * 现在对账也认这个面，但**不静默**：见回执里的「公共面改动」一行与 `task/done` 事件上的
   * `publicFace` 字段（谁改了哪几份公共面，台账里可查）。
   */
  sharedPaths?: readonly string[] | undefined
}

/**
 * **`impact` 的 done 面对账**（R5 / 第三批 §3.7）—— 只核**声明过的**影响面"有没有被处理过"。
 *
 * 背景：DEF-036 给了两条出口（`impact` 逐条点名 / `undecidable` 声明推不出来），但那**只在拆卡期**
 * 判"有没有声明"；"点名的既有夹具**真的**被跑过 / 改过 / 豁免过"此前**完全靠纪律**（角色卡里
 * 连落点都没有）。用户长期准则：**凡是能机械强制的纪律，不要靠提醒记住** ⇒ 本条做成**机械面**。
 *
 * 机械口径（**全部结构化**，不解析任何散文；二者之一即视为"处理过"）：
 *   ① 该路径在**本卡写范围**内 —— 本卡就是改它的那条路（路径代数走唯一出口 `scopeOverlaps`）；
 *   ② 有一条 **pass 的测试结果**把它绑成 `artifact` —— `sdo_test action=record artifact=<路径>`
 *      就是"跑过它"的机械证据（DEF-011 起该哈希还必须与现算值一致）。
 *
 * ⚠️ **本实现刻意不留第三条**（初版曾把"出现在自报写入清单里"也当作一条出路）：实测它是**死路** ——
 * 自报清单里只要出现写范围**之外**的路径，`done` 会先被 `write-scope-violation` 拒掉（DEF-016 的对账
 * 就是干这个的）⇒ 能走到"清单含该路径"这一步的，必然已经在写范围内（即 ① 已成立）。留一条永不
 * 独立成立的出路只会让读者以为有第三种绕法。`test/m168` M168-01 把这个反例钉住了。
 *
 * 声明了 `undecidable` 的卡**不逐条要求**（那条出口的语义就是"影响面推不出来"）；
 * 没声明 `impact` 的卡同样不判（存量卡零噪声）。
 */
function impactGaps(store: SdoStore, task: TaskCard): string[] {
  if (textOf(task.undecidable).trim() !== '') return []
  const declared = task.impact ?? []
  if (declared.length === 0) return []
  const normalize = (path: unknown): string => textOf(path).replace(/^\.\//u, '').trim()
  const scopes = task.writeScopes.map((scope) => normalize(scope)).filter((scope) => scope !== '')
  const boundToPass = new Set(
    listTestResults(store)
      .filter((result) => result.status === 'pass')
      .map((result) => normalize(result.artifact))
      .filter((path) => path !== ''),
  )
  const gaps: string[] = []
  for (const raw of declared) {
    const path = normalize(raw)
    if (path === '') continue
    if (scopes.length > 0 && scopeOverlaps(scopes, [path]).length > 0) continue
    if (boundToPass.has(path)) continue
    gaps.push(path)
  }
  return gaps
}

export type ReportResult =
  | {
      ok: true
      task: TaskCard
      /**
       * 收工时的写范围对账读数。`selfReported`（**DEF-016**）= 这次对账用的是**执行者自报**的清单
       * （宿主观测拿不到）—— 提醒读者：这是声明，不是观测，不得当成独立证据。
       */
      workspaceAudit?: { checked: boolean; changed: number; selfReported?: boolean | undefined }
      /**
       * **本卡判 N/A 的判据及理由**（TASK-056 落点三 / DEF-009·019·026）。
       *
       * 为什么必须由这一层带出来：判据"不判"与"为什么可以不判"是两件事 —— 只把判据跳过、
       * 回执里什么都不说，就把**漏判伪装成了 N/A**（正是这类缺陷的成因）。回执文本由
       * `src/index.ts` 拼装，它只拿得到本返回值，所以理由必须挂在这里。
       * 已写 `exempt` 的条目**不出现在这里**（豁免是人批的，N/A 是判据按写范围自己认出来的）。
       */
      naNotes?: string[]
      /**
       * **声明过却没被"处理过"的影响面**（R5 / 第三批 §3.7）：逐条点名，并给可执行出路。
       * **不拒绝收工**（拒绝会让"改既有语义"的卡永远收不了工 —— 与 `DEF-033` 的顾虑同类）；
       * 键为空时不出现（既有调用方形状不变）。
       */
      impactGaps?: string[]
      /**
       * **本次 `done` 已声明的未冻结兄弟卡**（DEF-033）：非空 = 本次是**局部绿**（本卡范围绿，全项目未冻结）。
       * 键为空时不出现。
       */
      unfrozen?: string[]
      /**
       * **本卡声明的未冻结清单之外的、处于在飞的兄弟卡**（DEF-033 返工 / 第四批 §3.4）——
       * ⚠️ 这个键**已不再出现**：漏声明现在**当场拒绝**（`unfrozen-undeclared`，零写盘），
       * 所以"成功返回里还带着一份漏声明读数"这个形态不存在了。类型里保留说明、不再有字段。
       *
       * 为什么删掉而不是继续返回：`ADR-014` 要求**不得漏声明**；留着"成功 + 点名"会让人以为
       * "反正会提醒我"，而那正是修前的形态。
       */
      // （无 `unfrozenMissing` 字段：见上）
      /**
       * **卡上 `fixes` 声明的逐条回显**（DEF-050 落点三）：每行形如
       * `DEF-xxx: fixed` / `DEF-xxx: open（需先闭合）` / `DEF-xxx: wontfix（理由…；批准人…）`。
       *
       * 为什么必须在 `done` 的回执里当场回显：本缺陷的成因就是"文档说已修"与"台账状态"
       * 各说各话，而两者对不上**没有任何地方报出来** —— 回显让对齐发生在当下，
       * 而不是靠人记得去 `.sdo/defects/*.yml` 逐条查。
       * 只在这一刻问一次台账（`done` 是唯一有意义的时刻：卡没完成时"缺陷还没修"是正常的）。
       */
      fixEcho?: string[]
      /**
       * **本卡评审状态的逐条回显**（DEF-051 落点三 / TASK-080）：每行形如
       * `REV-xxx: changes-requested（1 条发现待核实）` / `REV-xxx: pass（已采纳）`。
       *
       * 为什么是**回显**而不是收紧 `C-42` 的过滤：`C-42`（`review.required`）只覆盖
       * `size >= medium`，而 `small` 卡的评审此前**在 `done` 回执里完全看不见** ——
       * 问题只能靠人记得（本批 TASK-023/039 是 medium 才被逮住）。收紧过滤会把**历史**
       * `changes-requested` 评审翻出来重判（与刚修掉的判红噪音同族），而回显是纯加法：
       * **只在"这张卡确实有评审记录"时出现**，无评审的卡一个字都不加（不误伤 small 卡的常态）。
       *
       * 注意它**不是拦截**：拦截是 `blockingReview`（`review-open-findings`）的活 ——
       * 本字段只负责"看得见"。
       */
      reviewEcho?: string[]
    }
  | {
      ok: false
      code:
        | 'not-found'
        | 'not-owner'
        | 'no-evidence'
        | 'write-scope-violation'
        | 'test-case-missing'
        | 'test-result-missing'
        | 'test-failing'
        | 'test-skip-unjustified'
        | 'construction-profile-missing'
        | 'tdd-red-green-missing'
        | 'unfrozen-bad-id'
        // **DEF-033 返工（第四批 §3.4）**：漏声明是**另一种**拒绝（"你写的这条不成立" vs "你还有几条没写"）
        | 'unfrozen-undeclared'
        | 'review-open-findings'
        /**
         * **完成点评审硬拦截**（`TASK-195` 落点一）：中大卡（`size ≥ medium`）且产出产品工件、
         * 且不是 `reviewer` 角色的卡，没有「`pass` 且已核实采纳」的评审 ⇒ 拒绝 `done`。
         *
         * 为什么单列一个 code 而不是复用 `review-open-findings`：那条说的是「评审要求改动，发现没核实」
         * （`blockingReview`），这条说的是「**根本没有可用的通过评审**」—— 两条的修法完全不同
         * （一条去核实/去修，一条去**派评审卡**），混用 code 会让调用方与读者各猜一半。
         */
        | 'review-required'
        | 'tdd-result-untraceable'
        | 'tdd-mutation-missing'
        | 'contract-test-missing'
        | EvidenceAuditCode
      detail: string
    }

/**
 * **「中大卡必须已被评审」的唯一现算出口**（`TASK-195`）。
 *
 * 一处判据，三个消费点 —— 这是本卡的全部设计约束（`DEF-044` 的教训：同一概念两处判据必然分叉）：
 *   ① `gates.ts` 的 `review.required`（判据 `C-42`，门禁 G5 那一侧）；
 *   ② `report()` 的**完成点硬拦截**（`sdo_task action=done` 当场拒）；
 *   ③ `office.ts` 的**状态块那一行**（每轮可见，`inject.ts` 只负责排版）。
 *
 * 三处**不得**各写一份过滤/采纳口径：`producesProductArtifacts`（是否产出产品工件）、
 * `reviewAdoption`（`pass` 是否已被核实采纳）都必须走这里的两个函数。
 * 本模块不含任何用户可见文案（返回结构化读数），渲染由各消费点按自己的语言面负责 ——
 * `gates.ts` 走语言包（那条棘轮基线是 0），`collab.ts`/`office.ts` 走各自既有形态。
 */
export interface BigCardReviewVerdict {
  /** 是否落在判据的**考虑集**里：`size ≥ medium` 且非 `reviewer` 且产出产品工件 */
  considered: boolean
  /** `adopted`=有已采纳的 pass 评审；`unadopted`=有 pass 但没被核实采纳；`missing`=一条 pass 都没有 */
  state: 'adopted' | 'unadopted' | 'missing'
  /** `unadopted` 时逐条点名这次参与判定的 `pass` 评审（id + 采纳态）—— 回执与门禁共用 */
  reviews: { id: string; state: string }[]
}

/**
 * 单卡的评审满足状态（判据的最小单位）。
 *
 * `reviews` / `adoptions` 由调用方**读一次**再传进来：状态块与门禁都要批量判，
 * 让每张卡各自去读台账会把 O(n) 的现算变成 O(n²)（真账上 199 张卡 × 全部评审）。
 */
export function bigCardReviewVerdict(
  card: Pick<TaskCard, 'id' | 'size' | 'role' | 'writeScopes'>,
  reviews: readonly Review[],
  adoptions: ReadonlyMap<string, ReviewAdoption>,
): BigCardReviewVerdict {
  // **考虑集与 `C-42` 逐字同一口径**：`size ≥ medium`、非 `reviewer`（评审卡自我递归没有意义，
  // SDO-35）、且**产出产品工件**（R-12：复核/代核/文书类卡不参与 —— 否则它一 done 就要求自己被评审）。
  const big = (card.size === 'medium' || card.size === 'large')
    && card.role !== 'reviewer'
    && producesProductArtifacts(card)
  if (!big) return { considered: false, state: 'adopted', reviews: [] }
  const pass = reviews.filter((review) => review.verdict === 'pass' && review.taskId === card.id)
  return { considered: true, ...verdictOfPass(pass, adoptions) }
}

/** `pass` 评审集合 → 三态（`adopted` 优先，其次 `unadopted`，否则 `missing`）。 */
function verdictOfPass(
  pass: readonly Review[],
  adoptions: ReadonlyMap<string, ReviewAdoption>,
): Pick<BigCardReviewVerdict, 'state' | 'reviews'> {
  const rows = pass.map((review) => ({ id: review.id, state: adoptions.get(review.id)?.state ?? 'unverified' }))
  if (rows.some((row) => row.state === 'adopted')) return { state: 'adopted', reviews: rows }
  if (rows.length > 0) return { state: 'unadopted', reviews: rows }
  return { state: 'missing', reviews: [] }
}

/**
 * 「已完成但仍待评审」的中大卡集合 —— **`C-42` 与状态块用的是同一个函数**（本卡落点二）。
 *
 * 口径与 `review.required` 修前逐字相同（`status === 'done'`，**不含** `verified`：改口径会翻出历史卡重判），
 * 差别只有一个：**过滤与采纳判定搬到了这里**，`gates.ts` 只剩渲染。
 */
export interface PendingReviewBigCards {
  /** 参与判据的全集（已 done 的中大卡） */
  considered: string[]
  /** 一条 `pass` 评审都没有 */
  missing: string[]
  /** 有 `pass` 但**没被核实采纳**（逐条点名 id + 采纳态） */
  unadopted: { id: string; reviews: { id: string; state: string }[] }[]
  /** 点名集（`missing` 在前、`unadopted` 在后，各自保序）—— 门禁与状态块都念这一份 */
  pending: string[]
}

export function pendingReviewBigCards(store: SdoStore, journal: Journal): PendingReviewBigCards {
  /**
   * **一次读、整本用**（`TASK-213` 落点二）。
   *
   * 修前这句注释写着"读一次台账"，但 `reviewAdoptions` 内部**每条评审各读一次**（每条还要读 4 次：
   * recorded / hashed / verified / dispatch）⇒ 实测一次调用 **279 次 `read()` / 3706ms / 解析 166 万行**。
   * 现在把这一份事件数组交给下游，下游不再自己去读。
   *
   * **`TASK-220`**：整张判定结果再按 `(台账路径, 代次)` **记忆化** —— 门禁 / 状态块 / `done` 关在一轮
   * 里会重复问它（真账实测三次同价 43.09 / 42.45 / 43.60ms，零记忆化）。来源 YAML 被动过（探针失配）
   * 就整张作废：**同一个代次源**，不各算一套。
   *
   * **`TASK-230`**：代次变了不再整张作废 —— 写入只是**追加**事件，所以把「新追加的那几条」**增量应用**
   * 进来（见 {@link applyPendingReviewBigCards}）；只有换 inode / 截断 / 全量重解析（读层走全量那一支）
   * 才整张重算。实测：写 1 条事件后紧接读 **39.4 / 43.9 / 39.7ms** ⇒ 目标 < 2ms。
   *
   * 探针是**内容级**的（`REV-100` 第 1 条 / `DEF-218`）：`tasks/`、`reviews/` 两个目录都**逐条目** stat
   * （名字 + 尺寸 + mtime），所以"就地改一张已有卡的 `status`"也能看见（`M236-09` 钉住）。
   * 只 stat 目录本身不够 —— 目录 mtime/size 只在增删改名时变，而 `edit` / `echo >` 是同 inode 就地写。
   * 边界：写完把 mtime 回拨、或两次写落在同一时间刻度内 ⇒ 看不见（要挡住得做内容哈希，等于取消记忆化）。
   */
  /**
   * **探针作用域**（`TASK-230`）：一次查询里的 4 张表共用同一轮 `stat`。
   *
   * 不加它，同一次 `pendingReviewBigCards` 会把 `tasks/`（真账 256 项）与 `reviews/`（121 项）
   * 各 stat 两到四遍（单遍实测 0.3–0.8ms）—— 光探针就吃掉本卡"< 2ms"的大半预算。
   * 作用域内全是同步代码，不存在"作用域里有人手改 YAML"的时间窗（见 `withProbeEpoch` 的说明）。
   */
  return withProbeEpoch(() => {
    // 一次链里只读一次台账（`M234-05` 的"一次调用只读一次"）：这份事件数组一路传下去，下游不再 stat
    const events = journal.read().events
    return journal.memoDerived(
      'pending-review-big-cards',
      [store.path('tasks'), store.path('reviews'), store.path('reviews', 'verified.yml')],
      () => computePendingReviewBigCards(store, journal, events),
      { apply: (previous, appended) => applyPendingReviewBigCards(store, journal, events, previous, appended) },
    )
  })
}

/**
 * **任务卡整表**的只读记忆化视图（`TASK-230`）。
 *
 * 为什么需要它：`listTasks` 要读 `tasks/*.yml` **256 个文件**（真账实测 27.9ms），而它一个事件都不读
 * —— 修前每写一条事件就被整批作废并重读一遍，是"写后读 30–40ms"里最大的一块。
 *
 * `dependsOnEvents: false` 的依据是**读 compute 的体**：`listTasks(store)` 只碰 `tasks/` 目录
 * （`listTaskIds` + `readTask`）。将来若让它读 `roles.yml` / config / 事件，**必须**把那些路径加进
 * `probes`，否则会安静地读到旧表（`REV-100` 的扩探针义务）。
 */
function listTasksCached(store: SdoStore, journal: Journal): TaskCard[] {
  return journal.memoDerived('tasks-table', [store.path('tasks')], () => listTasks(store), {
    dependsOnEvents: false,
  })
}

/** {@link pendingReviewBigCards} 的实心实现（只在记忆化未命中时跑一次）。 */
function computePendingReviewBigCards(
  store: SdoStore,
  journal: Journal,
  events: readonly JournalEvent[],
): PendingReviewBigCards {
  const reviews = listReviewsCached(store, journal)
  // 采纳表与下面逐张卡的判定是**同一张**（记忆化视图）：不传就会再读一遍 98 个 YAML 与整张留痕表
  const adoptions = adoptionTable(store, journal, events)
  const considered: string[] = []
  const missing: string[] = []
  const unadopted: { id: string; reviews: { id: string; state: string }[] }[] = []
  for (const task of listTasksCached(store, journal)) {
    if (task.status !== 'done') continue
    const verdict = bigCardReviewVerdict(task, reviews, adoptions)
    if (!verdict.considered) continue
    considered.push(task.id)
    if (verdict.state === 'adopted') continue
    if (verdict.state === 'missing') {
      missing.push(task.id)
      continue
    }
    unadopted.push({ id: task.id, reviews: verdict.reviews })
  }
  return { considered, missing, unadopted, pending: [...missing, ...unadopted.map((row) => row.id)] }
}

/**
 * **增量应用**（`TASK-230`）：只重判"被新事件点名的那几张卡"，未受影响的卡**原样沿用**旧结论。
 *
 * 为什么这样是对的（台账是 append-only）：写一条事件只会在**末尾**多一行，已有的 `task/*.yml`、
 * `reviews/*.yml` 一个字节都没变（变了就走探针失配 ⇒ 整批重算，轮不到这里）。而一张卡的判定只由
 * ①它的卡面（YAML）②它的 `pass` 评审（YAML）③这些评审的**采纳态**（事件）决定 —— 前两项由探针把关，
 * 所以"新事件"能影响的**只能**是「被它点名的那些评审所归属的卡」。
 *
 * **顺序与全集都要与整批重算逐字相同**：仍然按 `listTasksCached` 的卡序走一遍（256 次 `Set` 查询 ≈ 0.02ms），
 * 未受影响的卡从旧结论里**继承成员关系**（在 `considered` / `missing` / `unadopted` 的哪一档），
 * 受影响的卡现算一遍 `bigCardReviewVerdict`（与整批重算**同一个函数**，不另写一套判据）。
 *
 * 三种情形返回**同一份旧结论**：① 新事件一条都没点名评审（例如 `task/updated` 这类与采纳无关的类型）
 * ⇒ 结论不可能变；② 点名的评审不属于任何在册卡；③ 受影响的卡都不在中大卡考虑集里。
 */
function applyPendingReviewBigCards(
  store: SdoStore,
  journal: Journal,
  events: readonly JournalEvent[],
  previous: PendingReviewBigCards,
  appended: readonly JournalEvent[],
): PendingReviewBigCards | undefined {
  const affectedReviews = affectedReviewIds(appended)
  if (affectedReviews.size === 0) return previous
  const reviews = listReviewsCached(store, journal)
  const affectedCards = new Set(
    reviews.filter((review) => affectedReviews.has(review.id)).map((review) => review.taskId),
  )
  if (affectedCards.size === 0) return previous
  const adoptions = adoptionTable(store, journal, events)
  const before = new Set(previous.considered)
  const beforeMissing = new Set(previous.missing)
  const beforeUnadopted = new Map(previous.unadopted.map((row) => [row.id, row.reviews]))
  const considered: string[] = []
  const missing: string[] = []
  const unadopted: { id: string; reviews: { id: string; state: string }[] }[] = []
  let changed = false
  for (const task of listTasksCached(store, journal)) {
    if (!before.has(task.id) && !affectedCards.has(task.id)) continue
    if (affectedCards.has(task.id)) {
      const verdict = bigCardReviewVerdict(task, reviews, adoptions)
      const wasConsidered = before.has(task.id)
      const nowConsidered = verdict.considered
      if (wasConsidered !== nowConsidered) changed = true
      if (!nowConsidered) continue
      considered.push(task.id)
      if (verdict.state === 'adopted') {
        if (beforeMissing.has(task.id) || beforeUnadopted.has(task.id)) changed = true
        continue
      }
      if (verdict.state === 'missing') {
        if (!beforeMissing.has(task.id)) changed = true
        missing.push(task.id)
        continue
      }
      if (beforeMissing.has(task.id) || !beforeUnadopted.has(task.id)) changed = true
      unadopted.push({ id: task.id, reviews: verdict.reviews })
      continue
    }
    // 未受影响的卡：成员关系照旧搬过来（判据没有重算，也不该重算）
    considered.push(task.id)
    if (beforeMissing.has(task.id)) {
      missing.push(task.id)
      continue
    }
    const rows = beforeUnadopted.get(task.id)
    if (rows !== undefined) unadopted.push({ id: task.id, reviews: rows })
  }
  const next = { considered, missing, unadopted, pending: [...missing, ...unadopted.map((row) => row.id)] }
  // 连 `pending` 都没变（很常见：`review/verified` 事件改了采纳态但结论仍是"待核实"）⇒ 交回旧对象
  if (!changed && samePendingBigCards(previous, next)) return previous
  return next
}

/** 两份判定读数是否**逐字段相同**（用于"增量算完发现结论没变 ⇒ 交回旧对象"）。 */
function samePendingBigCards(a: PendingReviewBigCards, b: PendingReviewBigCards): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 完成点评审拦截的**拒绝文案**（`TASK-195` 落点一）。三个要素缺一不可：
 *   ① **点名卡 id**（"哪张卡被拦"）；② **可执行修法**（先派一张 `reviewer` 卡评审，再回来 done）；
 *   ③ **两条出路**（把卡拆小 / 项目显式关开关）—— 没有出路的拒绝等于把卡永久钉死（`DEF-049` 的教训）。
 *
 * 文案落在本模块而不是语言包：本卡的写范围不含 `src/data/lang/*.yml`，而 `gates.ts` 被 i18n 棘轮
 * 钉在「零硬编码中文」。本文件本来就有同类用户可见文案（`not-owner` / `no-evidence` / 写范围越界），
 * 口径与它们一致；后续要做 i18n 时这三句话与它们一起迁（见交付说明里的跟卡建议）。
 */
function describeReviewGateRefusal(task: TaskCard, verdict: BigCardReviewVerdict): string {
  const gate = '完成点评审硬拦截（`.sdo/config.yml` 的 `review.requireOnDone` 默认开）'
  if (verdict.state === 'missing') {
    return `${gate}：${task.id} 是**中大卡**（size=${task.size}）且产出产品工件，但**没有任何 verdict=pass 的评审** ⇒ 拒绝完成。`
      + `\n修法（先派 reviewer 卡评审）：① 拆一张评审卡 —— \`sdo_plan action=decompose suggestions=[{"title":"评审 ${task.id}","role":"reviewer","size":"small"}]\`；`
      + `② 由**非作者**的评审会话记结论 —— \`sdo_review action=record taskId=${task.id} reviewer=<非作者> verdict=pass findings=["<一条可核实的发现>"]\`；`
      + `③ 发现逐条核实（\`sdo_task action=verify-review review=REV-… index=1 outcome=reproduced|refuted proof=…\`）—— 评审被**采纳**后本拦截即解除，再回来 done。`
      + `\n两条出路：确实不该被评审 ⇒ 把卡拆小（size 降到 small/trivial，用 \`sdo_task action=update\` 改 size）；`
      + `项目整体不做完成点拦截 ⇒ 在 \`.sdo/config.yml\` 写 \`review.requireOnDone: false\`（此后回执会**明说已关闭**）。`
  }
  const rows = verdict.reviews.map((row) => `${row.id}：${reviewAdoptionLabel(row.state as never)}`).join('，')
  return `${gate}：${task.id} 的通过评审**待核实采纳** —— ${rows} ⇒ 拒绝完成（有 pass 评审 ≠ 评审已算数）。`
    + `\n修法：由该卡的实现会话逐条核实评审发现 —— \`sdo_task action=verify-review review=<REV-id> index=<第几条，从 1 起> outcome=reproduced|refuted proof=<复现命令与结果 / 反证>\`；`
    + '每条发现都核实过（或被明确驳回）之后评审才被采纳，届时本拦截解除。'
    + `\n说明：\`reviewer\` 角色不承担复现（掩码里没有 \`bash\`）；实现会话已退役时由**同角色**会话代核。`
}

/** 开关**显式关闭**时的那一行（放行但明说 —— 不许静默放行）。 */
function describeReviewGateOff(task: TaskCard): string {
  return `**完成点评审拦截已关闭**（\`.sdo/config.yml\` 的 \`review.requireOnDone: false\`）：`
    + `${task.id} 是中大卡（size=${task.size}）且产出产品工件，本次 done **没有**校验「已采纳的通过评审」。`
    + '中大卡仍要在验证门禁（G5 `C-42` / G6 `C-52`）前拿到已采纳的通过评审 —— 那两条判据不受本开关影响。'
}

/** 回报：done 必须有证据；blocked 必须说明原因。 */
export function report(store: SdoStore, journal: Journal, input: ReportInput): ReportResult {
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return { ok: false, code: 'not-found', detail: `找不到任务卡 ${input.taskId}` }
  if (task.owner !== input.owner) {
    // **SDO-21（2026-10-05 真机）**：认领被门禁拒后卡**没有 owner**，于是 `block` 也被 `not-owner` 拒
    // ⇒ 台账上看不出"这张卡被机制卡住了"，同角色池还会反复派它（真机 6 张卡连拒 4 轮）。
    // 允许**无主卡**上报阻塞：记为 `task/claim-blocked`（与真正的 block 分开，便于审计）。
    if (input.status === 'blocked' && (task.owner === undefined || task.owner === '')) {
      const blocked: TaskCard = {
        ...task,
        status: 'blocked',
        blockedReason: input.note ?? '（未说明）',
        revision: task.revision + 1,
        updatedAt: now(),
      }
      journal.append('task/claim-blocked', { id: blocked.id, by: input.owner, reason: blocked.blockedReason })
      return { ok: true, task: save(store, blocked) }
    }
    return {
      ok: false,
      code: 'not-owner',
      detail: `${task.id} 的 owner 是 ${task.owner ?? '（无）'}，不是 ${input.owner}——只有 owner 能回报（设计 §8.4）`,
    }
  }
  if (input.status === 'done') {
    const evidence = input.evidence ?? []
    if (evidence.length === 0) {
      return { ok: false, code: 'no-evidence', detail: 'done 必须带证据（命令输出 / 产物路径 / workspace-changes 引用），空口完成不算完成' }
    }
    // A1：证据与**卡上声明的种类**、以及**工作区里真实存在的东西**对账（越界/缺种类/哈希不符/命令非 0 都判红）。
    // **TASK-056 落点二**：把 `store` 一并传进去 —— `mutation` / `contractTest` 这两类要求改读
    // `.sdo/construction/` 的方法产物台账（`dirname(store.root)` 只有路径、造不出台账读句柄）。
    const audit = auditDoneEvidence(task, evidence, dirname(store.root), store)
    if (!audit.ok) return { ok: false, code: audit.code, detail: audit.detail }
    // **2026-10-08 评审核实口径**：卡上**最新一条**评审还在要求改动（changes-requested / reject）且发现
    // 没被逐条核实时，不许 `done` —— "没核实就改、改完就说完成"这条路要被堵死。
    // 评审是**主张**不是结论：实现方要自己复现（reproduced）或给出反证（refuted），逐条留痕。
    const blocking = blockingReview(store, journal, task.id)
    if (blocking !== undefined) {
      const open = [...blocking.pending, ...blocking.stale, ...blocking.forged].map((index) => String(index + 1))
      return {
        ok: false,
        code: 'review-open-findings',
        detail: fmt('uiReview.openFindings', {
          p1: task.id,
          p2: blocking.review.id,
          p3: blocking.review.verdict,
          p4: open.join('、'),
          p5: task.id,
        }),
      }
    }
    // C7：测试先行 —— 卡上的需求在 **done 前**必须有结果（pass，或 skip + 理由）
    const doneGaps = testFirstGaps(store, task, 'done', journal)
    if (doneGaps.length > 0) {
      const code = doneGaps.some((gap) => gap.kind === 'untraceable')
        ? 'tdd-result-untraceable'
        : doneGaps.some((gap) => gap.kind === 'failing')
          ? 'test-failing'
          : doneGaps.some((gap) => gap.kind === 'no-result')
            ? 'test-result-missing'
            : doneGaps.some((gap) => gap.kind === 'skip-unjustified')
              ? 'test-skip-unjustified'
              : 'test-case-missing'
      return { ok: false, code, detail: describeTestFirstGaps(task.id, 'done', doneGaps) }
    }
    // A2：写范围对账 —— 拿"认领基线"之后本会话真实改动的文件，与卡的 writeScopes 比。
    // **R-4**：基线取"认领"与"派发"里更早的那个 —— 否则"先写后领"的写入不会被对账看见
    const baseline = reconcileBaseline(journal, task.id)
    const changed = changedFilesSince(store, baseline?.sessionId, baseline?.seq)
    // **SDO-34（真机）**：`.sdo/` 下的**台账写入**（`sdo_test` / `sdo_gate` / `sdo_risk` 等工具自己落的）
    // **不占卡的写范围** —— 真机上「DoD 要求如实闭合缺陷」的卡因此与写范围打架，执行者只能二选一
    // （要么违写范围、要么违 DoD）。台账由工具负责，卡只对**产品文件**负责。
    const auditable = changed.files.filter((file) => !String(file).replace(/^\.\//u, '').startsWith('.sdo/'))
    // **DEF-016 降级路径**：宿主观测拿不到时，用**执行者自报**的清单做同一套机械核对。
    const selfReported = (input.reportedFiles ?? [])
      .map((file) => textOf(file).replace(/^\.\//u, ''))
      .filter((file) => file !== '' && !file.startsWith('.sdo/'))
    const fromSelfReport = changed.entries === 0 && selfReported.length > 0
    const audited = changed.entries > 0 ? auditable : selfReported
    /**
     * **`DEN-198` 落点一：A2 对账认得公共面，但**单列可审计**。**
     *
     * 病灶：写入闸门（`writeScope.ts` 3a）把 `disciplineAllowPaths`（`.sdo/` `docs/` `test/`）当公共面
     * ——不受卡范围约束；而这里不认 ⇒ 同一份改动**闸门放行、done 判越界**（真机：改 `test/m189.test.ts`
     * 的棘轮登记被拒，只能改卡）。公共面本来就是"大家都要碰"的面（登记/棘轮同步）。
     *
     * 两条纪律（缺一就会变成滥用口）：
     *   ① **只对账产品面**：越界判定只拿 `productFace` 去比卡的 `writeScopes`；
     *   ② **公共面改动必须自己说出来**：回执单列一行 + `task/done` 事件带 `publicFace` 字段
     *      （哪张卡改了哪几份公共面，台账里可查，不是只靠执行者自报）。
     *
     * `sharedPaths` 由 `office.ts` 从设置里传下来；**没传 ⇒ 旧行为逐字不变**（不认公共面）。
     */
    const sharedPaths = (input.sharedPaths ?? []).map((path) => normalizeScopePath(textOf(path))).filter((path) => path !== '')
    const isSharedFace = (file: string): boolean => {
      const normalized = normalizeScopePath(textOf(file))
      return normalized !== '' && sharedPaths.some((scope) => scopePathWithin(normalized, scope))
    }
    const publicFace = audited.filter((file) => isSharedFace(file))
    const productFace = audited.filter((file) => !isSharedFace(file))
    const scopeAudit = auditWriteScopes(productFace, task.writeScopes.map((scope) => textOf(scope)).filter((scope) => scope !== ''))

    // **DEF-033（第三批 §3.13）**：完成语义的"局部绿 / 全局冻结"之分 —— `done` 时逐条对账。
    // ① 声明的每条必须是**存在且当前确实在飞**的卡（假声明可读拒绝：写错 id、或写一张已 done 的卡）；
    // ② 有在飞兄弟卡却**漏声明** ⇒ 不拦收工，但回执逐条点名（"卡 done ≠ 全局冻结"）；
    // ③ 一条在飞兄弟卡都没有 ⇒ 回执明说"本次 done 等同于全量冻结"。
    const declaredUnfrozen = (input.unfrozen ?? []).map((id) => textOf(id).trim()).filter((id) => id !== '')
    if (input.status === 'done' && declaredUnfrozen.length > 0) {
      const known = new Map(listTasks(store).map((item) => [item.id, item]))
      const self = declaredUnfrozen.filter((id) => id === task.id)
      const unknown = declaredUnfrozen.filter((id) => !known.has(id))
      const settled = declaredUnfrozen.filter((id) => known.get(id)?.status !== 'in-progress' && id !== task.id)
      if (self.length > 0 || unknown.length > 0 || settled.length > 0) {
        return {
          ok: false,
          code: 'unfrozen-bad-id',
          detail: fmt('uiCollab.kUnfrozenBadId', {
            p1: [...new Set([...self, ...unknown, ...settled])].join(t('uiCollab.kListSep')),
            p2: String([...known.values()].filter((item) => item.status === 'in-progress').length),
          }),
        }
      }
    }
    const inFlightSiblings = input.status === 'done'
      ? listTasks(store).filter((item) => item.id !== task.id && item.status === 'in-progress')
      : []
    // **DEF-033 返工（第四批 §3.4）**：**漏声明 ⇒ 拒绝**（不再"照常成功 + 逐条点名"）。
    // 用户裁决（`ADR-014`）：允许局部绿 + 留痕，但**不得漏声明** —— 有在飞兄弟卡却未逐条点名 ⇒
    // 明确拒绝、点名缺哪几张、零写盘（写在任何 `save`/`journal.append` 之前）。
    // **两类拒绝不混文案**：假声明（写错 / 已 done / 本卡自己）走上面的 `unfrozen-bad-id`；
    // 漏声明走 `unfrozen-undeclared` —— 一个说"你写的这条不成立"，一个说"你还有几条没写"。
    const unfrozenMissing = inFlightSiblings.filter((item) => !declaredUnfrozen.includes(item.id)).map((item) => item.id)
    if (unfrozenMissing.length > 0) {
      return {
        ok: false,
        code: 'unfrozen-undeclared',
        detail: fmt('uiCollab.kUnfrozenUndeclared', {
          p1: unfrozenMissing.join(t('uiCollab.kListSep')),
          p2: String(inFlightSiblings.length),
          p3: task.id,
        }),
      }
    }
    if (audited.length > 0 && !scopeAudit.ok) {
      return {
        ok: false,
        code: 'write-scope-violation',
        detail: fromSelfReport
          ? fmt('uiCollab.kScopeViolationSelfReported', {
              p1: task.id,
              p2: scopeAudit.violations.join(t('uiCollab.kListSep')),
              p3: task.writeScopes.map((scope) => textOf(scope)).join(t('uiCollab.kListSep')) || t('uiCollab.kScopeUnbounded'),
            })
          : `${task.id} 越界写：${scopeAudit.violations.join('、')}（写范围：${task.writeScopes.join('、') || '（未限定）'}）；把改动挪回写范围，或让流程官改卡后重新认领`,
      }
    }
    // 增量 3：**实现阶段方法包**的收工关（按所选包逐条检查；豁免已写进 profile 的 exempt）
    const profileRead = readConstructionProfile(store)
    if (profileRead.status === 'invalid') {
      return { ok: false, code: 'construction-profile-missing', detail: fmt('uiConstruction.c22', { p1: profileRead.problems.join('；') }) }
    }
    let naNotes: string[] = []
    /**
     * **`DEN-198` 落点一**：公共面改动**单列一行**（不静默放过）。
     *
     * 行文用**语言中立 ASCII**（`public-face changes (registry/ratchet sync): <path> × N`）：
     * 语言包文件不在本卡写范围（`src/data/lang/*.yml`），而这一行是**给复验者看的读数**、
     * 不是终端用户的散文 —— 与 `domain/pool.ts` 的 `poolReadingLine`、`domain/snapshot.ts` 的
     * `renderQueueTable` 同口径（同一个先例，不是新造的规矩）。
     */
    if (publicFace.length > 0) {
      const counts = new Map<string, number>()
      for (const file of publicFace) counts.set(file, (counts.get(file) ?? 0) + 1)
      naNotes.push(
        `public-face changes (registry/ratchet sync, NOT counted as out-of-scope): `
        + `${[...counts.entries()].map(([file, count]) => `${file} × ${String(count)}`).join('; ')}`
        + ` (${String(publicFace.length)} file(s))`,
      )
    }
    if (profileRead.status === 'ok') {
      const packageGaps = constructionDoneGaps(store, journal, task, profileRead.profile, { scale: readProjectConfig(store).config.scale })
      if (packageGaps.length > 0) {
        const first = packageGaps[0]
        const code =
          first !== undefined
          && (first.check === 'tdd-red-green-missing'
            || first.check === 'tdd-result-untraceable'
            || first.check === 'tdd-mutation-missing'
            || first.check === 'contract-test-missing')
          ? first.check
          : 'tdd-red-green-missing'
        return { ok: false, code, detail: packageGaps.map((item) => item.detail).join('；') }
      }
      // **TASK-056 落点三**：没判红不等于"什么都没发生" —— 该判 N/A 的条目要把**为什么**带进回执
      naNotes = constructionDoneNaNotes(store, task, profileRead.profile, { scale: readProjectConfig(store).config.scale })
    }
    /**
     * **完成点评审硬拦截**（`TASK-195` 落点一，主措施）。
     *
     * 位置刻意放在**所有既有拒绝之后、任何写盘之前**：
     *   · 在既有拒绝之后 ⇒ 既有判据的优先级与文案一字不变（不让新闸门遮住"缺证据/缺用例"那些更根本的拒绝）；
     *   · 在任何 `journal.append` / `save` 之前 ⇒ 拒绝是**零写盘**的（卡不会留下"半个 done"）。
     *
     * 判据只有一处：`bigCardReviewVerdict`（与 `C-42`、状态块同一个函数）。开关是项目级的
     * `review.requireOnDone`（默认开；显式 `false` 才关闭，关闭时在本回执的 N/A 行里明说）。
     */
    const requireOnDone = readProjectConfig(store).config.review.requireOnDone
    // **`TASK-213`**：本卡的采纳表与下面的逐条回显读同一份台账 ⇒ 只在上面读一次/下面各读一次会重复
    const doneLog = journal.read().events
    const cardAdoptions = new Map(reviewAdoptions(store, journal, doneLog).map((item) => [item.review.id, item]))
    // **`TASK-230` 落点二**：改走**记忆化评审表**（修前每张卡 done 都重读 121 个 YAML，真账 6.6~14.5ms）
    const reviewVerdict = bigCardReviewVerdict(task, listReviewsCached(store, journal), cardAdoptions)
    if (reviewVerdict.considered && reviewVerdict.state !== 'adopted') {
      if (requireOnDone) {
        return { ok: false, code: 'review-required', detail: describeReviewGateRefusal(task, reviewVerdict) }
      }
      // **开关显式关闭**：放行，但**必须在回执里明说**（不许静默放行 —— 那正是"忘评审"的温床）
      naNotes = [...naNotes, describeReviewGateOff(task)]
    }
    const next: TaskCard = {
      ...task,
      status: 'done',
      // **DEF-033**：把"本次 done 未冻结哪些在飞卡"写进卡（缺省不落键 ⇒ 存量形状不变）
      ...(declaredUnfrozen.length === 0 ? {} : { unfrozen: declaredUnfrozen }),
      evidence: [...task.evidence, ...evidence],
      revision: task.revision + 1,
      updatedAt: now(),
    }
    journal.append('task/done', {
      id: next.id,
      owner: input.owner,
      evidence: evidence.length,
      note: input.note ?? '',
      // **`DEN-198`**：公共面改动逐条落事件（"这个卡改了哪几份公共面"在台账里可查）
      ...(publicFace.length === 0 ? {} : { publicFace }),
      // 对账来源如实标注（自报 vs 宿主观测）—— 公共面这一批也同源
      ...(publicFace.length === 0 ? {} : { publicFaceSource: fromSelfReport ? 'self-reported' : 'observed' }),
    })
    const savedTask = save(store, next)
    // **DEF-050 落点三**：声明的修复逐条回显现状态。文案在语言包（gates.ts 那条棘轮不适用于
    // 本文件，但口径仍与判据共用一个出口 `fixStatusRows` —— 两处各写一套正是 DEF-038 的成因）。
    const fixesDeclared = savedTask.fixes ?? []
    const fixEcho = fixesDeclared.length === 0
      ? undefined
      : fixStatusRows(fixesDeclared, listDefects(store)).map((row) => {
        if (!row.closable) return fmt('uiGates.kFixEchoOpen', { p1: row.id, p2: row.status, p3: row.missing })
        // **署名放弃与被修好是两种结局**，回显必须分开说：写成同一句"已闭合"就把
        // "放弃必须有人署名"这条纪律在回执里抹平了（理由与批准人恰恰是要当场看见的东西）。
        return row.status === 'wontfix'
          ? fmt('uiGates.kFixEchoWaived', { p1: row.id, p2: row.waiveReason, p3: row.waiveApprovedBy })
          : fmt('uiGates.kFixEchoClosed', { p1: row.id, p2: row.status })
      })
    // **DEF-051 落点三**：本卡的评审状态逐条回显（可见即约束；**只在确有评审记录时**出现，
    // 于是 small 卡（本就不要求评审）的常态一个字都不加 —— 不误伤）。
    const cardReviews = reviewsOfCard(store, savedTask.id)
    const reviewEcho = cardReviews.length === 0
      ? undefined
      : cardReviews.map((review) => {
        const adoption = reviewAdoption(store, journal, review, doneLog)
        return fmt('uiGates.kReviewEchoRow', {
          p1: review.id,
          p2: review.verdict,
          p3: String(review.findings.length),
          p4: reviewAdoptionLabel(adoption.state),
        })
      })
    // **R5（第三批 §3.7）**：`impact` 的 **done 面对账** —— 声明过的影响面里，哪些**既没被本卡改、
    // 也没被跑过、也没在自报清单里**（逐条点名；不拒绝收工，见下面 `impactGaps` 的口径）。
    const unresolvedImpact = impactGaps(store, task)
    return {
      ok: true,
      task: savedTask,
      // 采不到数据、或采到的条目**没有文件信息**，都如实报告"未对账"（不判红也不冒充已核对）
      workspaceAudit: { checked: changed.audited || fromSelfReport, changed: fromSelfReport ? selfReported.length : changed.files.length, ...(fromSelfReport ? { selfReported: true } : {}) },
      // N/A 理由（空数组时不写这个键，保持既有返回形状对历史调用方透明）
      ...(naNotes.length === 0 ? {} : { naNotes }),
      ...(fixEcho === undefined ? {} : { fixEcho }),
      ...(reviewEcho === undefined ? {} : { reviewEcho }),
      ...(unresolvedImpact.length === 0 ? {} : { impactGaps: unresolvedImpact }),
      // **DEF-033**：完成语义的读数 —— 未冻结清单（空数组时**不写**这个键，既有调用方形状不变）。
      // 漏声明已在上面**拒绝**（`unfrozen-undeclared`）⇒ 这里只剩"声明齐备的局部绿"。
      ...(declaredUnfrozen.length === 0 ? {} : { unfrozen: declaredUnfrozen }),
    }
  }
  const next: TaskCard = {
    ...task,
    status: 'blocked',
    blockedReason: input.note ?? '（未说明）',
    revision: task.revision + 1,
    updatedAt: now(),
  }
  journal.append('task/blocked', { id: next.id, owner: input.owner, reason: next.blockedReason })
  return { ok: true, task: save(store, next) }
}

// —————————————————————— 评审：向**既有**评审追加发现项（TASK-108 / DEF-065 拆出项） ——————————————————————

/**
 * 一条评审上已经发生的**追加次数**（回读入口）。
 *
 * 真源就是 append-only 的 `review/appended` 事件：`appendCount` 是写进去的字段，事件条数是它的机械对照 ——
 * 两者都由这里现算，不另存一份计数（另存一份必然有一次会与事件流打架）。
 */
export function reviewAppendCount(journal: Journal, reviewId: string): number {
  return journal
    .read()
    .events.filter((event) => event.type === 'review/appended' && textOf(event.data['id']) === reviewId)
    .length
}

export interface AppendReviewFindingsInput {
  /** 追加到**哪一条**既有评审（`REV-*`）—— 不存在就拒绝，绝不新建一条同 verdict 的记录 */
  reviewId: string
  /** 追加的发现项（工具层已归一：数组 / JSON 文本解析出来的值）；**形状与空值在这里判** */
  findings: unknown
  /** 谁追加的（缺省 `human`） */
  by?: string | undefined
  /** 追加者的会话 id（与 `review/recorded` 同口径留痕：谁动过这条评审要查得到） */
  sessionId?: string | undefined
  /**
   * **补上"当前仍失败的复现命令"**（DEF-048 / 第三批 §3.16）：目标评审是非 `pass` 待修主张时，
   * 它身上必须有 `repro` 或 `unreproducible` —— 缺了就在这次补录里补上（也可由原记录带上）。
   * 两个都给 ⇒ 可读拒绝（读者判不出哪个作准）。
   */
  repro?: string | undefined
  /** 补上「无法复现 + 为什么」（DEF-048）：与 `repro` 二选一。 */
  unreproducible?: string | undefined
  /**
   * **本次补录的是原文的第几条**（DEF-072 / §3E 族 5）：1 起，指本次**第一条**发现项在原评审里的条号。
   *
   * 为什么必须由调用方**声明**而不是插件自算：`fromIndex = findings.length` 只是"这条记录现在有几条"，
   * 它推不出"这是补原文第几条"——真机正是因此让"标题写原第 4 条 / 正文写原第 2 条"写进了台账
   * （REV-047 / REV-053）。声明之后，**重号 / 跳号 / 超界**都能在写盘前被可读拒绝。
   * 与 {@link originalTotal} **必须成对**给（只给一个 ⇒ `original-meta-incomplete`）；两个都不给 = 不声明
   * （存量口径：旧调用方与旧记录照常工作）。
   */
  originalIndex?: number | undefined
  /** **原文（来源评审）共几条**（DEF-072）：与 `originalIndex` 成对；用来判超界。 */
  originalTotal?: number | undefined
}

/** 从 append-only 真源读回**已声明的**原条号区间（未声明的历史追加不参与，存量不追溯）。 */
function declaredOriginalRanges(journal: Journal, reviewId: string): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = []
  for (const event of journal.read().events) {
    if (event.type !== 'review/appended' || textOf(event.data.id) !== reviewId) continue
    const from = Number(event.data.originalIndex)
    const count = Number(event.data.appended)
    if (!Number.isInteger(from) || from < 1 || !Number.isInteger(count) || count < 1) continue
    ranges.push({ from, to: from + count - 1 })
  }
  return ranges
}

export type AppendReviewFindingsResult =
  | {
      ok: true
      review: Review
      appendCount: number
      appended: string[]
      fromIndex: number
      total: number
      /** 本次声明的原条号（没声明就没有）—— 回执据此回显"补的是原文第几条" */
      originalIndex?: number | undefined
      originalTotal?: number | undefined
    }
  | {
      ok: false
      code:
        | 'no-review'
        | 'tampered'
        | 'empty-findings'
        | 'bad-findings'
        // **DEF-072**：条号自洽的五条可读拒绝（写入前判，零写盘）
        | 'original-meta-incomplete'
        | 'original-index-invalid'
        | 'original-overflow'
        | 'original-overlap'
        | 'original-gap'
        // **DEF-048**：待修主张缺复现出路 / 两条出路都给了（与 `recordReview` 同一份判据）
        | 'repro-missing'
        | 'repro-ambiguous'
      detail: string
    }

/**
 * **向既有评审追加发现项**（`sdo_review action=append`）—— 只追加、不改写。
 *
 * 真机病因（DEF-065 拆出项）：一条评审的发现项写入被宿主 schema 拒之后，只能**另起一条同 verdict 的记录**
 * 来补录 ⇒ 一条评审在台账里碎成 9 条（`REV-044` 与 `REV-047…REV-054`），读者要自己拼、核实要跨记录追。
 *
 * 四条纪律：
 *   ① **只追加**：`verdict` 是原评审的结论，本函数**没有**这个入参 —— 从签名上就改不了它；
 *      已有发现正文按原顺序原样保留，新发现项一律**接在尾部**（下标因此稳定，旧核实不因追加失效）。
 *   ② **必须留痕**：每次追加写一条 `review/appended`（`appendCount` / `fromIndex` / `appendedFindings` /
 *      `appendHashes`）—— 第几次、追加了哪些、追加者是谁，都能从 append-only 真源离线读回来。
 *   ③ **拒绝路径可读且可区分**：评审不存在 / 正文被改过（`tampered`）/ findings 为空 / 形状不对 —— 四类四种文案。
 *   ④ **篡改判据只有一份**：复用 `reviewAdoption`（采纳判定的**唯一**入口），不在这里另写一套"改没改过"的判据。
 *      被改过的评审**拒绝追加** —— 否则"补录"就成了把改动洗白的通道（`rehashReview` 拒绝补记是同一个道理）。
 */
export function appendReviewFindings(
  store: SdoStore,
  journal: Journal,
  input: AppendReviewFindingsInput,
): AppendReviewFindingsResult {
  // **`TASK-230` 落点二**：改走**记忆化评审表**（修前每次追加发现都重读 121 个 YAML）
  const review = listReviewsCached(store, journal).find((item) => item.id === input.reviewId)
  if (review === undefined) {
    return { ok: false, code: 'no-review', detail: fmt('uiReview.appendNoReview', { p1: input.reviewId }) }
  }
  const adoption = reviewAdoption(store, journal, review)
  if (adoption.state === 'tampered') {
    return { ok: false, code: 'tampered', detail: fmt('uiReview.appendTampered', { p1: review.id }) }
  }
  if (!Array.isArray(input.findings)) {
    return { ok: false, code: 'bad-findings', detail: fmt('uiReview.appendBadShape', { p1: typeof input.findings }) }
  }
  const notText = input.findings.findIndex((item) => typeof item !== 'string')
  if (notText >= 0) {
    return {
      ok: false,
      code: 'bad-findings',
      detail: fmt('uiReview.appendBadShape', { p1: fmt('uiReview.appendBadShapeItem', { p1: String(notText + 1), p2: typeof input.findings[notText] }) }),
    }
  }
  const appended = input.findings.map((item) => textOf(item).trim()).filter((item) => item !== '')
  if (appended.length === 0) {
    return { ok: false, code: 'empty-findings', detail: fmt('uiReview.appendEmpty', { p1: review.id }) }
  }
  // ——— **DEF-048（第三批 §3.16）**：待修主张的"复现出路"也必须齐 ———
  // 目标评审是非 `pass` 时，它身上（或本次补录里）必须有 `repro` / `unreproducible` 之一。
  // 为什么在 append 面也要判：`append` 是**第三条写入路径**（另外两条是 `recordReview` 与工具面），
  // 不判就等于留了一个"先记一条空口待修、再补录发现"的绕行通道。
  const reproIssue = reviewReproIssue({
    verdict: review.verdict,
    repro: input.repro ?? review.repro,
    unreproducible: input.unreproducible ?? review.unreproducible,
  })
  if (reproIssue !== undefined) return { ok: false, code: reproIssue.code, detail: reproIssue.detail }

  // ——— **DEF-072 / §3E 族 5**：补录的**条号自洽**（原第 k 条 / 原共 m 条）———
  // 为什么必须在这里拒：`fromIndex = findings.length` 是"这条记录现在有几条"**自算**的，推不出
  // "补的是原文第几条" —— 真机正是因此让「标题写原第 4 条 / 正文写原第 2 条」写进了台账
  // （REV-047 / REV-053 两条逐字仍在）。声明之后，重号 / 跳号 / 超界都在**写盘前**被可读拒绝。
  const { originalIndex, originalTotal } = input
  if ((originalIndex === undefined) !== (originalTotal === undefined)) {
    return { ok: false, code: 'original-meta-incomplete', detail: fmt('uiReview.appendOriginalPair', { p1: review.id }) }
  }
  const priorRanges = declaredOriginalRanges(journal, review.id)
  // **评审自身的正文就是原文的前 N 条**（补录语义：正文 = 原第 1..N 条）⇒ 基线必须含它，
  // 否则"从原第 3 条开始补"会被自己的正文误判成跳号（本卡第一版正是这么写错的，被 M151-01 当场逮住）。
  const bodyEnd = (review.findings ?? []).length
  const coverage = bodyEnd === 0 ? priorRanges : [{ from: 1, to: bodyEnd }, ...priorRanges]
  if (originalIndex !== undefined && originalTotal !== undefined) {
    if (!Number.isInteger(originalIndex) || originalIndex < 1 || !Number.isInteger(originalTotal) || originalTotal < 1) {
      return {
        ok: false,
        code: 'original-index-invalid',
        detail: fmt('uiReview.appendOriginalInvalid', { p1: review.id, p2: String(originalIndex), p3: String(originalTotal) }),
      }
    }
    const last = originalIndex + appended.length - 1
    if (last > originalTotal) {
      return {
        ok: false,
        code: 'original-overflow',
        detail: fmt('uiReview.appendOriginalOverflow', {
          p1: review.id,
          p2: String(originalIndex),
          p3: String(appended.length),
          p4: String(last),
          p5: String(originalTotal),
        }),
      }
    }
    // **点名要精确**（M151-03 的教训）：与「已声明的追加区间」撞 ⇒ 点名那段区间；只与**正文**已占的
    // 原第 1..N 条撞 ⇒ 明说"正文里已经有了"，不把两件事混成一句含糊的"重叠"。
    const overlapAppend = priorRanges.find((range) => originalIndex <= range.to && last >= range.from)
    if (overlapAppend !== undefined) {
      return {
        ok: false,
        code: 'original-overlap',
        detail: fmt('uiReview.appendOriginalOverlap', { p1: review.id, p2: `${overlapAppend.from}-${overlapAppend.to}` }),
      }
    }
    if (bodyEnd > 0 && originalIndex <= bodyEnd) {
      return {
        ok: false,
        code: 'original-overlap',
        detail: fmt('uiReview.appendOriginalOverlapBody', { p1: review.id, p2: `1-${bodyEnd}` }),
      }
    }
    const previousEnd = coverage.reduce((max, range) => Math.max(max, range.to), 0)
    if (originalIndex > previousEnd + 1) {
      return {
        ok: false,
        code: 'original-gap',
        detail: fmt('uiReview.appendOriginalGap', { p1: review.id, p2: String(previousEnd + 1), p3: String(originalIndex) }),
      }
    }
  }

  const findings = (review.findings ?? []).map((item) => textOf(item))
  const fromIndex = findings.length
  const next: Review = {
    ...review,
    findings: [...findings, ...appended],
    // **封印前缀**：只记"记录当时有几条"，正文一字不改 ⇒ 内容指纹仍覆盖原正文，旧封印不因追加失效。
    sealedFindings: review.sealedFindings ?? findings.length,
    // **DEF-072**：把"原文共几条"这个**声明**落进记录（缺省不落键，存量口径不变）
    ...(originalTotal === undefined ? {} : { originalTotal }),
    // **DEF-048**：本次补录里带来的"复现出路"也落进记录（缺省不落键 ⇒ 存量形状不变）
    ...(input.repro === undefined ? {} : { repro: input.repro }),
    ...(input.unreproducible === undefined ? {} : { unreproducible: input.unreproducible }),
  }
  store.writeYaml(['reviews', `${review.id}.yml`], { review: next })
  const appendCount = reviewAppendCount(journal, review.id) + 1
  journal.append('review/appended', {
    id: review.id,
    taskId: review.taskId,
    // verdict 只**回显**原结论（追加路径没有这个入参）：留痕能让第三人核对"结论确实没被改"
    verdict: review.verdict,
    appendCount,
    fromIndex,
    appended: appended.length,
    appendedFindings: appended,
    // **DEF-072**：本次声明的原条号（没声明就没有）—— 条号自洽的判定与事后复核都读这几个字段
    ...(originalIndex === undefined ? {} : { originalIndex, originalTotal }),
    // 逐条指纹：追加的正文被换掉时，离线也能查出换的是哪一条（核实记录绑的是同一套指纹）
    appendHashes: appended.map((item) => findingHashOf(item)),
    total: next.findings.length,
    // 本次追加之后的内容指纹（应等于记录/补记时的封印值：追加不动封印前缀）
    contentHash: reviewContentHash(next),
    by: textOf(input.by).trim() === '' ? 'human' : textOf(input.by).trim(),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  })
  return {
    ok: true,
    review: next,
    appendCount,
    appended,
    fromIndex,
    total: next.findings.length,
    ...(originalIndex === undefined ? {} : { originalIndex, originalTotal: originalTotal as number }),
  }
}

/**
 * 取某卡最近一次认领基线（A2）：直接用 `task/claimed` 事件自己的 `seq` 与它带的 `sessionId`。
 * 没有就返回 undefined —— 对账会如实报"未对账"，而不是猜一个基线。
 */
/**
 * **本卡被派发给某个子会话**的时刻（`dispatch/started`）—— R-4（sdo-test-new 2026-10-08，major）。
 *
 * 真机：子代理先落盘产品文件（16:23:35）、77 秒后才认领成功（16:24:52，首次认领被 test-first 拦下，
 * 它先补用例计划再回来领）⇒ 写范围对账的基线取"认领那一刻"，**认领前的写入整个在窗口之外**；
 * 而子代理会话本来就不发 `workspace/changes`（既有已知限制），于是这段窗口没有任何机器约束。
 */
export function dispatchBaseline(journal: Journal, taskId: string): { sessionId: string; seq: number } | undefined {
  const events = journal
    .read()
    .events.filter((event) => event.type === 'dispatch/started' && textOf(event.data.task) === taskId)
  const first = events.find((event) => textOf(event.data.childSessionId) !== '')
  if (first === undefined) return undefined
  return { sessionId: textOf(first.data.childSessionId), seq: first.seq }
}

/**
 * **收工对账用的基线**：认领时刻与派发时刻里**更早**的那个。
 *
 * 只有把窗口起点挪到"派发"（或认领，取更早者），"先写后领"才落进对账范围；
 * 同一个子会话时直接取更早的那条；换人（不同会话）时仍以**认领会话**为准，但窗口也放宽到更早的 seq
 * （那一段是同一个会话在认领前的写入）。
 */
export function reconcileBaseline(journal: Journal, taskId: string): { sessionId: string; seq: number } | undefined {
  const claimed = claimBaseline(journal, taskId)
  const dispatched = dispatchBaseline(journal, taskId)
  if (claimed === undefined) return dispatched
  if (dispatched === undefined) return claimed
  if (dispatched.sessionId === claimed.sessionId) return dispatched.seq < claimed.seq ? dispatched : claimed
  return { sessionId: claimed.sessionId, seq: Math.min(dispatched.seq, claimed.seq) }
}

export function claimBaseline(journal: Journal, taskId: string): { sessionId: string; seq: number } | undefined {
  const events = journal.read().events.filter((event) => event.type === 'task/claimed' && event.data.id === taskId)
  const last = events[events.length - 1]
  if (last === undefined) return undefined
  const sessionId = textOf(last.data.sessionId)
  if (sessionId === '') return undefined
  return { sessionId, seq: last.seq }
}

/** 显式释放（回到 ready，清空 owner）。 */
/**
 * **改卡**（`sdo_task action=update`，SDO-14(3) / SDO-15(3)）。
 *
 * 为什么需要：真机上「写范围与 DoD 打架」「关键卡排序被同类卡挤掉」都只能靠**人肉改 YAML** 或重新立卡 ——
 * 卡是流程真源，却没有一个受约束的修改入口。这里给出入口，并守住三条：
 *   · 已完成/已核销/已作废的卡**不改**（历史不重写）；
 *   · 卡**有人在做**时不得改 `writeScopes`（会造出两个写者）—— 除非调用方就是 owner；
 *   · 给了 `expectedRevision` 就按 CAS 判（防并发覆盖）。
 */
export function updateTask(
  store: SdoStore,
  journal: Journal,
  input: {
    taskId: string
    by: string
    expectedRevision?: number | undefined
    title?: string | undefined
    dod?: string[] | undefined
    writeScopes?: string[] | undefined
    blockedBy?: string[] | undefined
    evidenceRequired?: string[] | undefined
    requirements?: string[] | undefined
    /**
     * **本卡声称修好的缺陷 id**（DEF-050 / TASK-072）。给了就**整份替换**（与 `requirements`
     * 同款：这是声明，不是补丁），给空数组表示撤回全部声明。
     *
     * 三条可读拒绝（**不静默丢弃**，对照知识库 `tq_ff348198` 的教训）：重复 id / 空串 /
     * 台账里不存在的缺陷 id —— 每条都当场点名，并给可执行修法。
     * 为什么"不存在的 id"必须拒绝：写错一个号 = 声明落在空气上，卡照常 done、
     * 判据看空集 ⇒ 正是本缺陷要消灭的"静默漏过"。
     */
    fixes?: string[] | undefined
    /**
     * **本卡声称消除的风险 id**（DEF-051 / TASK-080）。给了就**整份替换**（与 `fixes` 同款：
     * 这是声明，不是补丁），给空数组表示撤回全部声明。
     *
     * 两条可读拒绝（**不静默丢弃**，对照知识库 `tq_ff348198` 的教训）：重复 id / 空串 ——
     * 每条都当场点名。**不**拒绝"台账里不存在的风险 id"：与缺陷不同，风险可能由**同批的另一张卡**
     * 先登记（`RISK-*` 是流水号，先声明后登记是正常顺序）⇒ 那一条留给判据 `C-64` 判红点名，
     * 而不是在这里把合法的协作顺序堵死。
     */
    mitigates?: string[] | undefined
    /** 仍要开着的风险及其署名理由（整份替换；键名逐字复用豁免两字段）。 */
    mitigatesWaiver?: MitigatesWaiver[] | undefined
    /**
     * **本卡点名的影响面**（DEF-036）：列出本卡的改动会影响到哪些文件/用例。整份替换
     * （与 `fixes` / `mitigates` 同款：这是**声明**，不是补丁），空数组表示撤回声明。
     *
     * 为什么要在**改卡**面也接收它：拆卡期判据 `impact-undeclared` 判红后，出路必须是**当场可执行**的
     * —— 如果声明只能建卡时给（而卡已经建好），那"判红"就成了一条没有出口的判词。三条可读拒绝
     * （空白串 / 重复 / 形状）都当场点名，**不静默丢弃**（对照知识库 `tq_ff348198` 的教训）。
     */
    impact?: string[] | undefined
    /**
     * **影响面推不出来的显式声明**（DEF-036）：与 `impact` 二者有其一即视为已声明。
     * 传空串 = **撤回**这条声明（键随之从卡面消失，不留空值）；其它值按 `textOf` 去空白后落盘。
     */
    undecidable?: string | undefined
    /**
     * **本卡声明的变异自证条数**（DEF-027 的补口）。
     *
     * 为什么在这里出现：`sdo_task action=update` 的 schema 与 `execute` 映射**早就**收这个参数
     * （`tools.ts`），但这张入参面（`updateTask`）没有 `mutationExpected` ⇒ index 层传进来的值
     * 被**静默丢弃**，真机上"卡建好后补声明条数"这条路其实走不通（工具面说收、域层不认）。
     * 这正是本批 `tq_ff348198`「多处同改，缺一处就静默丢弃」的形态，随本卡一并接通。
     * 拒绝口径：非整数或负数 ⇒ 可读拒绝（`mutation-expected-invalid`），不静默丢弃。
     */
    mutationExpected?: number | undefined
    /**
     * **追加**写范围（DEF-012 / 2026-10-14 机制缺陷批）。与 `writeScopes`（整份替换）**互斥**。
     *
     * 为什么必须有它：卡在飞（`owner` 非空）时整份替换会被 `scope-locked` 挡住，而流程官改范围
     * 又只能**先 release** —— release 会丢掉 `in-progress` 与认领痕迹（真机实测撞上：改一次范围
     * 要绕三道手续）。追加是**无损**通道：`status` 与 `owner` 原样保留，只把新路径并进声明。
     *
     * 三条机械约束（都当场可读拒绝，绝不静默）：
     *   · 调用方必须是**流程官**（`human` / `office` / `cockpit`）或**本卡 owner**；
     *   · 必须带 `reason`（留痕：这是计划变更，理由进 `task/updated` 事件）；
     *   · 追加的每条范围**不得与另一张在飞卡相交**（判定走 `scopeOverlaps`，与认领期同一出口）——
     *     否则等于造出两个写者，而那正是这把锁要防的事。
     */
    addWriteScopes?: string[] | undefined
    /**
     * **公共面**（`settings.disciplineAllowPaths`，由 `office.ts` 传下来）。
     *
     * **`DEN-198` 落点二**：两卡要共用**同一份台账/棘轮文件**（`test/m189.test.ts` 这类）时，
     * 旧口径把公共面与产品面一视同仁 ⇒ `add-scope-conflict` ⇒ **没有合法通道**能声明"这张
     * 公共面我们俩都要碰"（真机只能等对方收工，或把卡拆成一张只为改一行的卡）。
     * 现在：公共面路径**允许与在飞卡相交**，但**不静默** —— 回执里点名"与哪张卡共享哪条路径"，
     * 并落一条 `task/scopes-shared` 事件（双方均已声明这件事台账里可查）。
     * **产品面不受影响**：`src/**` 等照样被重叠锁拒（`DEN-197` 的教训：那把锁对产品文件是必要的）。
     * 没传 ⇒ 旧行为逐字不变。
     */
    sharedPaths?: readonly string[] | undefined
    /** 计划变更的理由（`addWriteScopes` 必填；进 `task/updated` 事件，事后可复核） */
    reason?: string | undefined
    /**
     * **本卡是否产出用户可见文案**（DEF-055）：`true` ⇒ 判据 `ui-text-scope` 要求写范围含
     * **项目声明的文案面**（`.sdo/config.yml` 的 `plan.textPaths`）；`false` = **撤回**声明
     * （键随之从卡面消失，不留 `false` 这种"写着但没声明"的形态）。
     */
    uiText?: boolean | undefined
    /**
     * **本卡声称要落地的路径**（DEF-018）：`validatePlan` 的 `landing-outside-scope` 逐条核对它是否
     * 落在本卡写范围内。整份替换（与 `writeScopes` 同款：这是**声明**，不是补丁）。
     */
    landing?: string[] | undefined
    /**
     * **本卡要独占的窗口组名**（DEF-007）：同组同时只能有一张卡在跑。
     * 空串 = **撤回声明**（删键，口径同 `undecidable` / `uiText`）。自由文本，插件不校验、不内置组名。
     */
    exclusive?: string | undefined
    size?: string | undefined
  },
):
  | { ok: true; task: TaskCard; changed: string[] }
  | {
      ok: false
      code:
        | 'not-found'
        | 'not-updatable'
        | 'revision-mismatch'
        | 'scope-locked'
        | 'fixes-invalid'
        | 'mitigates-invalid'
        // **DEF-036**：影响面声明与（补口的）变异条数声明的可读拒绝
        | 'impact-invalid'
        | 'mutation-expected-invalid'
        // **DEF-012**：追加写范围这条通道的四条可读拒绝
        | 'add-scope-ambiguous'
        | 'add-scope-empty'
        | 'add-scope-forbidden'
        | 'add-scope-reason-required'
        | 'add-scope-conflict'
      detail: string
    } {
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return { ok: false, code: 'not-found', detail: `找不到任务卡 ${input.taskId}` }
  if (task.status === 'done' || task.status === 'verified' || task.status === 'dropped') {
    return { ok: false, code: 'not-updatable', detail: `${task.id} 已是 ${task.status}：历史不重写（要改就新立一张卡）` }
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== task.revision) {
    return { ok: false, code: 'revision-mismatch', detail: `${task.id} 已变到 r${task.revision}（你看到的是 r${input.expectedRevision}）` }
  }
  if (input.addWriteScopes !== undefined) {
    if (input.writeScopes !== undefined) {
      return { ok: false, code: 'add-scope-ambiguous', detail: fmt('uiCollab.kAddScopeAmbiguous', { p1: task.id }) }
    }
    const existing = new Set(task.writeScopes.map((scope) => normalizeScopePath(textOf(scope))))
    const added: string[] = []
    for (const raw of input.addWriteScopes) {
      const scope = normalizeScopePath(textOf(raw))
      if (scope === '' || existing.has(scope)) continue
      existing.add(scope)
      added.push(scope)
    }
    if (added.length === 0) {
      return { ok: false, code: 'add-scope-empty', detail: fmt('uiCollab.kAddScopeEmpty', { p1: task.id }) }
    }
    const by = textOf(input.by).trim()
    const owner = textOf(task.owner ?? '').trim()
    if (by === '' || (by !== owner && !COCKPIT_ACTORS.includes(by))) {
      return {
        ok: false,
        code: 'add-scope-forbidden',
        detail: fmt('uiCollab.kAddScopeForbidden', {
          p1: task.id,
          p2: owner === '' ? t('uiCollab.unblockNoOwner') : owner,
          p3: by,
        }),
      }
    }
    const reason = textOf(input.reason ?? '').trim()
    if (reason === '') {
      return { ok: false, code: 'add-scope-reason-required', detail: fmt('uiCollab.kAddScopeReasonRequired', { p1: task.id }) }
    }
    /**
     * **两个写者的机械防线**：追加的范围不得与**另一张在飞卡**相交（判定走唯一出口）。
     *
     * **`DEN-198` 落点二**：**公共面**（`sharedPaths`）例外 —— 那本来就是"大家都要碰"的面
     * （登记/棘轮同步），允许与在飞卡相交；相交的每一条都收进 `shared`，回执点名 + 落事件。
     * **产品面一条都不放**（`DEN-197`：那把锁对产品文件是必要的）。
     */
    const sharedPaths = (input.sharedPaths ?? []).map((path) => normalizeScopePath(textOf(path))).filter((path) => path !== '')
    const isSharedFace = (scope: string): boolean => sharedPaths.some((shared) => scopePathWithin(scope, shared))
    const shared: { taskId: string; path: string; otherScope: string }[] = []
    const others = listTasks(store).filter((item) => item.id !== task.id && item.status === 'in-progress')
    for (const scope of added) {
      for (const other of others) {
        const overlap = scopeOverlaps([scope], other.writeScopes)
        if (overlap.length > 0) {
          if (isSharedFace(scope)) {
            for (const otherScope of overlap) shared.push({ taskId: other.id, path: scope, otherScope })
            continue
          }
          return {
            ok: false,
            code: 'add-scope-conflict',
            detail: fmt('uiCollab.kAddScopeConflict', {
              p1: overlap.join(t('uiCollab.kListSep')),
              p2: other.id,
              p3: textOf(other.owner ?? '').trim() === '' ? t('uiCollab.unblockNoOwner') : textOf(other.owner ?? ''),
            }),
          }
        }
      }
    }
    // 追加是**无损**的：`status` / `owner` 原样保留，只并进写范围
    const merged = [...task.writeScopes, ...added]
    const next: TaskCard = { ...task, writeScopes: merged, revision: task.revision + 1, updatedAt: now() }
    const saved = save(store, next)
    journal.append('task/updated', { id: saved.id, by, fields: ['writeScopes'], added, reason })
    /**
     * **`DEN-198` 落点二的留痕**：公共面共享**不是静默放行** ——
     *   · 落一条 `task/updated` 事件，`shared` 字段逐条记「与哪张在飞卡共享哪条路径」（双方均已声明）；
     *   · 回执侧由 `office.ts` 把它变成可见的一行（`changed` 里的 `shared:<path>@<卡>` 记号）。
     *
     * 为什么不新造事件名 `task/scopes-shared`：事件类型联合在 `src/types.ts`（**不在本卡写范围**），
     * 而"共享了哪条面"是**写范围变更**这件事的一部分 ⇒ 挂在 `task/updated` 上语义也正；
     * 结构化字段 `shared[]` 照样可单独查询（`event.data.shared`），不依赖散文。
     */
    if (shared.length > 0) {
      journal.append('task/updated', {
        id: saved.id,
        by,
        fields: ['writeScopes'],
        added,
        reason,
        shared: shared.map((row) => ({ with: row.taskId, path: row.path, otherScope: row.otherScope })),
      })
    }
    return {
      ok: true,
      task: saved,
      // 共享记号进 `changed`：回执会原样打印（`writeScopes、shared:test/m189.test.ts@TASK-21401`）
      changed: shared.length === 0
        ? ['writeScopes']
        : ['writeScopes', ...shared.map((row) => `shared:${row.path}@${row.taskId}`)],
      ...(shared.length === 0 ? {} : { shared }),
    }
  }
  if (input.writeScopes !== undefined && task.owner !== undefined && task.owner !== '' && task.owner !== input.by) {
    return {
      ok: false,
      code: 'scope-locked',
      detail: `${task.id} 正被 ${task.owner} 做着：改写范围会造出两个写者（先 release，或让 owner 来改）`,
    }
  }
  if (input.fixes !== undefined) {
    const trimmed = input.fixes.map((item) => textOf(item).trim())
    const problems = fixesListProblems(trimmed)
    if (problems.length > 0) {
      return {
        ok: false,
        code: 'fixes-invalid',
        detail: problems.map((problem) =>
          problem.kind === 'blank'
            ? fmt('uiGates.kFixBlank', { p1: task.id })
            : fmt('uiGates.kFixDuplicate', { p1: task.id, p2: problem.id })).join('；'),
      }
    }
    const known = new Set(listDefects(store).map((defect) => defect.id))
    const unknown = trimmed.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      return {
        ok: false,
        code: 'fixes-invalid',
        detail: fmt('uiGates.kFixUnknown', {
          p1: task.id,
          p2: unknown.join('、'),
          p3: String(known.size),
        }),
      }
    }
  }
  if (input.mitigates !== undefined) {
    // 形状可读拒绝（重复 / 空串）：与 `fixes` 同一套纪律。**不做**"风险 id 必须已存在"的校验，
    // 理由见入参注释（风险可能由同批另一张卡先登记；不存在的 id 由判据 C-64 判红点名即可）。
    const trimmed = input.mitigates.map((item) => textOf(item).trim())
    const blank = trimmed.filter((id) => id === '').length
    if (blank > 0) {
      return { ok: false, code: 'mitigates-invalid', detail: fmt('uiGates.kMitigatesBlank', { p1: task.id }) }
    }
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const id of trimmed) {
      if (seen.has(id)) duplicates.push(id)
      seen.add(id)
    }
    if (duplicates.length > 0) {
      return {
        ok: false,
        code: 'mitigates-invalid',
        detail: fmt('uiGates.kMitigatesDuplicate', { p1: task.id, p2: duplicates.join('、') }),
      }
    }
  }
  // **DEF-036**：影响面声明的形状校验（空白串 / 重复 ⇒ 可读拒绝，不静默丢弃；口径与 `mitigates` 同款）
  if (input.impact !== undefined) {
    const trimmed = input.impact.map((item) => textOf(item).trim())
    if (trimmed.some((item) => item === '')) {
      return { ok: false, code: 'impact-invalid', detail: fmt('uiGates.kImpactBlank', { p1: task.id }) }
    }
    const seen = new Set<string>()
    const duplicates: string[] = []
    for (const item of trimmed) {
      if (seen.has(item)) duplicates.push(item)
      seen.add(item)
    }
    if (duplicates.length > 0) {
      return { ok: false, code: 'impact-invalid', detail: fmt('uiGates.kImpactDuplicate', { p1: task.id, p2: duplicates.join('、') }) }
    }
  }
  if (input.mutationExpected !== undefined && (!Number.isInteger(input.mutationExpected) || input.mutationExpected < 0)) {
    return {
      ok: false,
      code: 'mutation-expected-invalid',
      detail: fmt('uiGates.kMutationExpectedInvalid', { p1: task.id, p2: String(input.mutationExpected) }),
    }
  }
  const changed: string[] = []
  const next: TaskCard = { ...task, revision: task.revision + 1, updatedAt: now() }
  const record = next as unknown as Record<string, unknown>
  const apply = (key: string, value: unknown): void => {
    if (value === undefined) return
    changed.push(key)
    record[key] = value
  }
  apply('title', input.title)
  apply('dod', input.dod)
  apply('writeScopes', input.writeScopes)
  apply('blockedBy', input.blockedBy)
  apply('evidenceRequired', input.evidenceRequired)
  apply('requirements', input.requirements)
  apply('fixes', input.fixes)
  apply('mitigates', input.mitigates)
  apply('mitigatesWaiver', input.mitigatesWaiver)
  apply('impact', input.impact === undefined ? undefined : input.impact.map((item) => textOf(item).trim()))
  // **DEF-036**：`undecidable` 传空串 = **撤回**这条声明（键从卡面消失，不留空值 —— 否则读端
  // 的"空白视为未声明"与卡面的"写着但空"会并存成两种形态）
  if (input.undecidable !== undefined) {
    const declared = textOf(input.undecidable).trim()
    changed.push('undecidable')
    if (declared === '') delete record.undecidable
    else record.undecidable = declared
  }
  apply('landing', input.landing === undefined ? undefined : input.landing.map((item) => textOf(item).trim()))
  // **DEF-007**：`exclusive` 传空串 = **撤回**独占声明（键从卡面消失，不留空值 —— 口径同上）
  if (input.exclusive !== undefined) {
    const declared = textOf(input.exclusive).trim()
    changed.push('exclusive')
    if (declared === '') delete record.exclusive
    else record.exclusive = declared
  }
  apply('mutationExpected', input.mutationExpected)
  // **DEF-055**：`uiText=false` 是**撤回**声明（键从卡面消失，不留 `false`）—— 与 `undecidable` 空串同款口径：
  // "写着但为假"和"没声明"必须是同一种形态，否则读端与判据要各学一套。
  if (input.uiText !== undefined) {
    changed.push('uiText')
    if (input.uiText) record.uiText = true
    else delete record.uiText
  }
  apply('size', input.size)
  if (changed.length === 0) return { ok: false, code: 'not-updatable', detail: '没有给出要改的字段' }
  const saved = save(store, next)
  journal.append('task/updated', { id: saved.id, by: input.by, fields: changed })
  return { ok: true, task: saved, changed }
}

/**
 * **给卡追加一条勘误**（DEF-071）：**只能追加**，绝不改写任何历史正文。
 *
 * 为什么必须存在：done 卡不可改（历史不重写）是对的，但没有勘误通道时，拆卡之后
 * 「说明说本卡不做」与「落点原文要求做」会永久并存 —— 下一位读卡人只能判「没做完」。
 * 勘误是**计划的补充说明**，不是状态迁移：不改 `status`、不改 `dod`、不改任何落点。
 */
export function addErrata(
  store: SdoStore,
  journal: Journal,
  input: { taskId: string; by: string; note: string },
):
  | { ok: true; task: TaskCard; count: number }
  | { ok: false; code: 'not-found' | 'note-required'; detail: string } {
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return { ok: false, code: 'not-found', detail: fmt('uiCollab.kErrataNotFound', { p1: input.taskId }) }
  const note = textOf(input.note).trim()
  if (note === '') return { ok: false, code: 'note-required', detail: fmt('uiCollab.kErrataNoteRequired', { p1: task.id }) }
  const entry = { at: now(), by: textOf(input.by).trim(), note }
  const next: TaskCard = { ...task, errata: [...(task.errata ?? []), entry], revision: task.revision + 1, updatedAt: now() }
  const saved = save(store, next)
  journal.append('task/errata', { id: saved.id, by: entry.by, note: entry.note, count: entry === undefined ? 0 : (saved.errata ?? []).length })
  return { ok: true, task: saved, count: (saved.errata ?? []).length }
}

/**
 * **显式释放**（回到 `ready`，清空 `owner`）。
 *
 * **`TASK-237` / `DEF-224` 落点二：release 必须收口。** 放手的卡若还有一笔**未结算的派发**
 * （`dispatch/started` 之后没有任何终态事件），就先把那一轮派发落一条 `dispatch/aborted`
 * —— 否则台账留下「`dispatch/started` 还在、卡却 `ready` 且无 `owner`」的第四种不一致形态：
 * 读者看到"有派发"，却没有任何地方说"这一轮已经作废了"（现盘实测 20 次落到这一形态）。
 *
 * **顺序有意如此**（先收口、后改状态）：卡的**最后一条**事件仍然是 `task/released`
 * ⇒ 所有"读该卡最后一条事件"的既有读者（孤儿锁、阶段推进）读数一字不变。
 * 判定与读侧同源：`unsettledDispatch`（`domain/dispatchHealth.ts`）是唯一出口，
 * 收口事件本身也进它的终态表，因此**重复 release 不会重复收口**。
 */
export function release(store: SdoStore, journal: Journal, input: { taskId: string; actor: string; reason: string }): TaskCard | undefined {
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return undefined
  const open = unsettledDispatch(journal.read().events, task.id)
  if (open !== undefined) {
    journal.append(DISPATCH_ABORTED_EVENT, {
      task: task.id,
      childSessionId: open.childSessionId,
      startedSeq: open.startedSeq,
      reason: input.reason,
      actor: input.actor,
    })
  }
  const { owner: _owner, blockedReason: _blocked, ...rest } = task
  const next: TaskCard = { ...rest, status: 'ready', revision: task.revision + 1, updatedAt: now() }
  journal.append('task/released', { id: next.id, actor: input.actor, reason: input.reason, previousOwner: task.owner ?? '' })
  return save(store, next)
}

export interface UnblockInput {
  taskId: string
  /** 本次恢复的**理由**（必填：恢复不是静默动作，回执与事件里都要看得见）。 */
  reason: string
  /** 谁在恢复（驾驶舱 / owner / 代核者），落进 `task/unblocked` 事件。 */
  by: string
  /**
   * **授权判定由调用方给**，而不是在这里重算一遍。理由（与 `block` 的既有口径一致）：
   * "谁是这张卡的 owner"有两个来源 —— 卡上的 `owner` 字段，与 `task/claimed` 事件里的**会话 id**
   * （`claimBaseline`）。两者未必同时在场（真机上认领被门禁拒后卡可能没有 owner），
   * 而"当前调用是哪个会话"只有工具层（`index.ts` 的 `call.sessionId`）拿得到。
   * 域层再造一套只会与工具层**分叉**，所以这里只**执行裁决**：`authorized=false` 一律可读拒绝。
   */
  authorized: boolean
}

/**
 * **从 blocked 恢复为 ready**（DEF-049 / TASK-078 的落点一）。
 *
 * 为什么必须有这个动作：`blocked` 在修复前是卡生命周期的**死胡同** —— `readyTasks` 的派发准入
 * 只认 `planned` / `ready`，工具面又没有恢复动作，而 `block` 恰恰是本项目**写在每张卡派发协议里
 * 鼓励**的行为（"做不下去就 block，不要硬撑也不要静默改范围"）⇒ 鼓励的动作把人送进死胡同，
 * 真机上驾驶舱只能**语义外地**用 `release` 把卡捞回 ready（release 的语义是"放手"，
 * 不是"阻塞条件已解除"）。
 *
 * 三条硬约束（对应 DoD）：
 *   · **限驾驶舱或该卡原 owner**（由 `input.authorized` 裁决，越权一律拒绝）；
 *   · **必须带原因**：空白理由拒绝（"恢复了但说不出为什么"正是要消灭的静默）；
 *   · **留痕是追加式的**：`task/unblocked` 带上**原阻塞原因**与**本次恢复理由**，不删任何历史。
 *
 * 与 `release` 的分工写在回执里：`release` = 我不做了、把卡让回去；`unblock` = 阻塞条件解除了、
 * 这张卡接着做。两者都回到 `ready`，但**语义不同**，所以事件类型也必须不同（不能共用一个）。
 */
export type UnblockResult =
  | { ok: true; task: TaskCard; previousOwner: string; blockedReason: string }
  | { ok: false; code: 'not-found' | 'not-blocked' | 'not-authorized' | 'reason-missing'; detail: string }

export function unblock(store: SdoStore, journal: Journal, input: UnblockInput): UnblockResult {
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return { ok: false, code: 'not-found', detail: fmt('uiCollab.unblockNotFound', { p1: input.taskId }) }
  // **位置很关键**：审核（authorized）排在状态检查**之前** —— 越权者不该从错误文案里
  // 反推出这张卡此刻的状态（信息泄露），且"越权"与"这卡不是 blocked"是两条必须能分开的拒绝。
  if (!input.authorized) {
    return {
      ok: false,
      code: 'not-authorized',
      detail: fmt('uiCollab.unblockNotAuthorized', { p1: task.id, p2: task.owner === undefined || task.owner === '' ? t('uiCollab.unblockNoOwner') : task.owner }),
    }
  }
  if (input.reason.trim() === '') {
    return { ok: false, code: 'reason-missing', detail: fmt('uiCollab.unblockReasonMissing', { p1: task.id }) }
  }
  if (task.status !== 'blocked') {
    return { ok: false, code: 'not-blocked', detail: fmt('uiCollab.unblockNotBlocked', { p1: task.id, p2: task.status }) }
  }
  const { owner: _owner, blockedReason: blocked, ...rest } = task
  const next: TaskCard = { ...rest, status: 'ready', revision: task.revision + 1, updatedAt: now() }
  journal.append('task/unblocked', {
    id: next.id,
    by: input.by,
    reason: input.reason,
    // **原阻塞原因随事件留档**：卡上的 `blockedReason` 字段会被清掉，而"当时为什么停"是审计要看的东西
    blockedReason: blocked ?? '',
    previousOwner: task.owner ?? '',
  })
  return { ok: true, task: save(store, next), previousOwner: task.owner ?? '', blockedReason: blocked ?? '' }
}

/** 显式改派（换 owner，状态保持 in-progress）。 */
export function reassign(store: SdoStore, journal: Journal, input: { taskId: string; actor: string; owner: string; reason: string }): TaskCard | undefined {
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return undefined
  const next: TaskCard = { ...task, owner: input.owner, revision: task.revision + 1, updatedAt: now() }
  journal.append('task/released', {
    id: next.id,
    actor: input.actor,
    reason: input.reason,
    reassignedTo: input.owner,
    previousOwner: task.owner ?? '',
  })
  return save(store, next)
}

/**
 * 疑似失联的卡：**只报告，不自动释放**（设计 §8.4）。
 * 自动释放会让"正在写"的 agent 与接管者同时改同一批文件。
 */
export function staleClaims(tasks: TaskCard[], ttlMs: number, at = Date.now()): TaskCard[] {
  return tasks.filter((task) => task.status === 'in-progress' && at - Date.parse(task.updatedAt) > ttlMs)
}
