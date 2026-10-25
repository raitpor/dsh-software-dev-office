/**
 * 门禁检查器注册表 + 判定引擎（设计 §7.1 的 `criteria[].check` / §7.3 的判定与证据）。
 *
 * 分工：
 *   · **流程数据**（`src/data/processes/*.yml`）声明"这个门禁由哪些准则构成"；
 *   · **本模块**实现每条准则的检查（确定性、可复现）；
 *   · 未实现的检查器**一律判失败并说明**——门禁绝不允许"检查不到就算通过"。
 *
 * G2 的 7 条准则直接复用 DoR 实现（`evaluateDor`），保证"需求基线门禁"只有一份判定逻辑。
 */
import { LANGUAGES, fmt, gateWithId, locale, t, withLocale } from './i18n.js'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { SdoStore } from '../infra/store.js'
import { stripTrailingNewlines } from '../infra/render.js'
import { textOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import type { Journal } from '../infra/journal.js'
import {
  DESIGN_DOC_SOURCE_EVENTS,
  QUALITY_DOC_SOURCE_EVENTS,
  isDerivedDocTruthPath,
  isDesignDocTruthPath,
} from '../types.js'
import type {
  FeasibilityAssessment,
  GateCriterionDef,
  GateCriterionResult,
  GateDef,
  GateEvaluation,
  GrillQuestion,
  JournalEvent,
  ProcessDef,
  RedTeamIssue,
  Release,
  Requirement,
  RiskItem,
  SdoProject,
} from '../types.js'
// **`REQ-063` / `C-71`（TASK-174）**：作用域判定读的是发布计划层的**派生结果**（`deriveFor`），
// 不是实体上的手填字段（`AC-287`：字段一律派生，权威是 release 文件的集合）。
// 依赖方向是「判据 → 派生层」；反向那条被 `test/m213.test.ts` 的静态守卫钉死
// （`release.ts` 不许 import gates、也不许出现判据字面量）。
//
// **`TASK-171`（0.1.7 批 2）**：`C-73` / `C-75` 的**判定核心**在 `release.ts`（`deferTraceFindings` /
// `freezeTraceFindings`，`TASK-176` 交付），本模块只把它们挂上门禁并渲染回执 —— 判定口径不在这里重写。
import {
  currentRelease,
  deferLimitOf,
  deferTraceFindings,
  deferredIdsOf,
  deriveFor,
  freezeTraceFindings,
  listReleases,
  packageVersionOf,
} from './release.js'
// **`TASK-171`**：`C-70` 的判定核心（声明—判据覆盖）在 `claimCoverage.ts`；`owner` 的角色解析与
// `C-76` 的读数也在那里（认领面 / 建卡面 / 收口判据三处共用一份口径，见该模块文件头）。
import {
  CLAIM_COVERAGE_CHECK,
  CLAIM_COVERAGE_CRITERION_ID,
  CLAIM_KINDS,
  assessClaimCoverage,
  ownerRoleFindings,
} from './claimCoverage.js'
import type { ClaimKind, ClaimRow } from './claimCoverage.js'
import { adrCompleteness } from './adr.js'
import {
  absentArtifacts,
  applicabilityLines,
  applicabilityState,
  artifactLabel,
  readApplicability,
  missingArtifacts,
  requiredArtifacts,
  viewLabel,
  viewRules,
} from './applicability.js'
import { isMeasurable, listScenarios, readAssessment } from './quality.js'
import { derivedDocRelativePath, derivedDocSections, renderQualityDoc } from './derivedDocs.js'
import { contractCoverage, contractDirectionAnomalies, contractFieldNoteLines, contractFieldNotes, listContracts } from './contracts.js'
import { viewsCompleteness } from './architecture.js'
import {
  DESIGN_DOC_SECTIONS,
  confirmGaps,
  isEffectivelyOpenDesign as isEffectivelyOpen,
  listDesignQuestions,
  parseRenderLang,
  parseRenderPhase,
  parseRenderSeq,
  renderDesignDocCached,
  uiConfirmation,
  uiDecision,
} from './design.js'
import { evaluateDor } from './dor.js'
import { assessOutline, describeOutlineVerdict, outlineRemedy } from './acceptance.js'
import type { CoverageAssessment, CoverageReadingAssessment } from './coverage.js'
import { assessCoverageFromStore, coverageRemedy, describeCoverage, meetsThresholdText } from './coverage.js'
import { assessRegressionFromStore, changeSetFromLedger, describeRegression, regressionRemedy } from './regression.js'
import { writeValidatedTestingSource } from './testingShapes.js'
import type { TestingShapeKnown, TestingValidatedWriteResult } from './testingShapes.js'
import { readTestingClass } from './testingStore.js'
import {
  TESTING_DOC_META,
  TESTING_SOURCE_FILES,
  docHandEdited,
  docSourceFingerprint,
  readTestingSource,
  renderStale,
} from './testingStore.js'
// **`DEF-126`（TASK-157）**：`skip` 的处置核对**复用**未覆盖项那一套校验器（`resolveDisposition`
// 的唯一包装），不在这里另造一份词表 —— REQ-057 的处置词汇只有 `types.ts` 的 `TESTING_DISPOSITIONS` 一份。
import { assessCoverageItem } from './mutation.js'
import { issueClosure } from './issues.js'
import { methodConsistency, methodLabel, methodProducts, methodSelection } from './method.js'
import { claimGaps, contractTestGaps, doneGaps, readConstructionProfile, scopeCovers } from './construction.js'
import { deliveryBinding } from './records.js'
import { readProjectConfig } from '../config.js'
import { methodDocHeader, methodDocStatus } from './methodDocs.js'
import { gateDef, gatePhase, legalRollbackTargets, loadAllProcesses } from './process.js'
import { listRisks, riskStats } from './risks.js'
import { channelLabel, signoffInput, signatureInvalidatingEventLine, signatureState } from './signature.js'
import { checkWantsShapeNotes, collectShapeNotes, shapeNoteLines, shapeNotesForCheck } from './shapeNotes.js'
import { assessDefectLinks, defectLinksExemptionLines, defectLinksRemedy, describeDefectLinks, readLinksChecked, report } from './trace.js'
import { iterationTasks, listTasks, planStats, readIteration, textPathsOf, validatePlan } from './plan.js'
import {
  declaredItemVerdict,
  fixesRemedy,
  fixStatusRows,
  mitigatesRemedy,
  mitigatesRows,
  pendingReviewBigCards,
} from './collab.js'
import { claimedSessionsByCard } from './roles.js'
import { independenceAudit } from '../integration/orchestrator.js'
import {
  blockerBreakdown,
  deliveryCompleteness,
  listDefects,
  listTestCases,
  listTestResults,
  verificationStats,
  fixedDefectsWithoutTestResult,
} from './records.js'
import type { Review } from './records.js'
import {
  adoptionTable,
  fixedDefectsWithoutAdoptedReview,
  listReviewsCached,
  reviewAdoptionLabel,
} from './reviewVerification.js'
import type { ReviewAdoption } from './reviewVerification.js'
import { unfrozenFullGreenState } from './unfrozen.js'
import { producesProductArtifacts } from './plan.js'

/** 判定所需的全部输入（由 office 组装）。 */
export interface GateContext {
  workspace: string
  /** 读盘用（视图、契约、追溯图、ADR 都在文件里） */
  store: SdoStore
  /** 真源日志：门禁签字按 journal 序号判失效、阶段回退留痕都要读它 */
  journal: Journal
  /** 当前流程定义（阶段回退的**合法回退边**按流程数据声明，不硬编码） */
  process: ProcessDef
  project: SdoProject | undefined
  requirements: Requirement[]
  questions: GrillQuestion[]
  risks: RiskItem[]
  issues: RedTeamIssue[]
  feasibility: FeasibilityAssessment | undefined
  redTeamExecuted: boolean
  redTeamDisabled: boolean
  approvedBy?: string | undefined
  /** 已豁免的门禁（来自 tailoring.waivedGates） */
  waivedGates: string[]
  /** 原型目录名与 discard 标记（`.sdo/config.yml`） */
  prototypeDir: string
  prototypeThrowaway: boolean
  /** 螺旋流程的本圈风险结论 */
  riskConclusion: string | undefined
  /**
   * **正在判定的门禁 id**（`evaluateGate` 注入；规范编号，如 `G6` / `GI`）。
   *
   * 为什么检查器需要它（C-59 / TASK-062）：测试报告签字判据要报出"**签哪个门禁**"
   * （修法里的 `sdo_gate action=sign gate=…` 得写对名字）与"从哪张签字台账里找签字"。
   * 旧检查器都能从"判据只挂在一个门禁上"反推门禁名，本判据同时挂在四个流程的多个门禁上
   * （waterfall/prototype/spiral 的 G6、agile 的 GI），反推就不成立了 —— 于是**由引擎如实注入**，
   * 而不是让检查器去猜。直接调 `CHECKERS[...]`（单测/审计脚本）时不填，检查器按惯例退回 `G6`。
   */
  gate?: string | undefined
  /**
   * **本版作用域**（`REQ-063` / `C-71`，TASK-174）：只在实现/验证/交付类门禁（`G4`/`G6`/`G7`）上注入。
   *
   * 为什么不给所有门禁都填：`AC-267` / `AC-275` 的另一半是"需求/设计类门禁（G2/G3）**不按版本切片**" ——
   * 全基线的判据（重号、跨版本矛盾、`coverage.uncovered`）必须看见**每一条**需求，否则切片切掉的
   * 恰恰是"这条需求没人管"。不填 ⇒ 全基线口径（`undefined` 与"全在作用域内"在行为上**不等价**：
   * 前者连作用域都不算，后者算了但全部归入 —— 见 `versionScopeOf` 的 fail-closed 口径）。
   */
  versionScope?: VersionScopeView | undefined
}

function ok(id: string, detail: string, warnings?: string[] | undefined): GateCriterionResult {
  return { id, ok: true, detail, ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }) }
}

function fail(id: string, detail: string, remedy: string): GateCriterionResult {
  return { id, ok: false, detail, remedy }
}

/**
 * **不适用**（N/A）：该准则对这个项目没有意义（增量 1 / §2.1）。
 *
 * 三态语义：`ok: true` 通过 / `ok: false` 失败 / `na: true` 不适用。
 * N/A **既不算失败也不算通过** —— `evaluateGate` 里它不阻止放行，但也不计入通过数；
 * 回执必须显式打印 N/A 与理由（`describeGate` 负责）。
 */
function na(id: string, reason: string): GateCriterionResult {
  return { id, ok: false, na: true, naReason: reason, detail: reason }
}

/**
 * **门禁里的采纳表**（`TASK-220`）：三条判据读到的都是**同一张记忆化表**（`adoptionTable`，键 = 代次）。
 *
 * 病根（修前实测）：`review.independent` 对**同一个参数**调了两次 `reviewAdoptions`（自评独立性 +
 * 已采纳 pass 评审各一遍），`review.required` 又把 `pendingReviewBigCards` 内部算过的那张表**再算一遍**
 * —— 一次门禁检查里同一份台账被折三遍（真账 98 条评审时 ~30-38ms/遍）。
 *
 * 现在三条判据（`review.independent` / `review.required` / `defects.fixed-reviewed`）都直接向
 * `adoptionTable` 要表：**真算 ≤ 1 次**（`reviewAdoptionStats.computes` 实测），`reviewAdoptions(...)`
 * 的调用次数在门禁里降到 **0**。表的新鲜度由代次 + 来源探针负责（`bumpGeneration` 一写就作废），
 * 不再需要"一次检查一个临时缓存"那种作用域状态 —— 也就没有"同一个 ctx 复用导致读到旧表"的坑。
 */
function gateAdoptions(ctx: GateContext, events?: readonly JournalEvent[]): ReadonlyMap<string, ReviewAdoption> {
  return adoptionTable(ctx.store, ctx.journal, events)
}

/** 被采纳、但**没有内容指纹**（老格式）的 `pass` 评审 id（G-2 的可见性标注）。 */
function adoptedPassIds(
  taskIds: string[],
  reviews: Review[],
  adoptions: ReadonlyMap<string, { state: string; tamperGuard?: string }>,
): string[] {
  const wanted = new Set(taskIds)
  return reviews
    .filter((review) => wanted.has(review.taskId) && review.verdict === 'pass')
    .filter((review) => adoptions.get(review.id)?.state === 'adopted' && adoptions.get(review.id)?.tamperGuard === 'none-legacy')
    .map((review) => review.id)
}

/** 该目录下是否有"实质内容"（忽略 README.md 与隐藏文件）。 */
function hasSubstantiveContent(dir: string): boolean {  if (!existsSync(dir)) return false
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    if (name === 'README.md') continue
    const target = join(dir, name)
    if (statSync(target).isDirectory()) {
      if (hasSubstantiveContent(target)) return true
      continue
    }
    return true
  }
  return false
}

/** 读文本；读不到返回 undefined（调用方必须据此**判失败**，不允许"查不到就算过"）。 */
function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 门禁检查器：键与流程数据里的 `criteria[].check` 一一对应。 */
/** 原型是否在本项目「在局」：流程是原型流程，或工作区里已有原型目录（**D3**）。 */
/**
 * **判据的产物面**：哪些 `check` 键**硬性要求**某份人读文档。
 *
 * 为什么需要它（REQ-044 / AC-228、AC-229，DEF-004）：审核单的「本门相关产物」表过去只列流程数据里的
 * `suggestedArtifacts`（**建议**，不入门禁），于是签字人看到的是"建议了什么"，而判据真正**强制**的
 * 文档（`C-25` 的 `docs/DESIGN.md`、`C-2G` 的 `docs/QUALITY.md`）混在同一张单栏表里，
 * 名字还可能与建议名不同（历史事故：建议 `SDD.md`、判据要 `DESIGN.md`）⇒ 长期显示补不上的"假缺失"。
 * 名字以**判据**（本表）为唯一真源，与流程数据的建议面分开呈现，两栏都给出**规范渲染路径**。
 *
 * 只收**固定名**的人读文档（含 `docs/` 落点）：方法包文档 `docs/METHOD-<包>.md` 是**按选择**才存在的
 * 一族文件，不在本表里冒充单一规范名。
 */
const CRITERION_ARTIFACTS: Readonly<Record<string, string>> = {
  'design.doc': 'DESIGN.md',
  'quality.doc': 'QUALITY.md',
  'testing.report': 'TESTREPORT.md',
  // **C-59（TASK-062）**：签的是**报告正文**，所以这份文档不是"建议产物"而是判据硬性要求的。
  // 列进本表（而不是另开一张）的用意：审核单的「必需产物」栏由 `requiredArtifactNames` 现算，
  // 判据读哪份文档、签字人就该在哪一栏看到它（REQ-044 / DEF-004 的口径）。
  'testing.report-signed': 'TESTREPORT.md',
}

/** 门禁强制的人读文档名（去重；顺序即判据顺序，便于复核）。 */
export function requiredArtifactNames(gate: GateDef | undefined): string[] {
  const names: string[] = []
  for (const criterion of gate?.criteria ?? []) {
    const name = CRITERION_ARTIFACTS[criterion.check]
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * **声明过的质量属性**：从 append-only 的 `quality/recorded` 事件里现算（AC-227 的"某条**声明的**"）。
 *
 * 为什么读 journal 而不是读 `.sdo/quality`：`recordScenario` 每次登记都写 `quality/recorded{id, attribute}`，
 * 事件是追加式的 —— 场景文件被删掉之后，"这个属性曾经被声明过"这件事**仍然在真源里**。
 * 这正是"真源归零"与"从来没声明过质量"的机械分界：前者判红（AC-227），后者仍走 N/A（与 C-2C 同口径）。
 * 只收 `attribute` 非空的事件（ATAM 的 `quality/recorded{atam:true}` 不算属性声明）。
 */
function declaredQualityAttributes(ctx: GateContext): { id: string; attribute: string }[] {
  const out: { id: string; attribute: string }[] = []
  for (const event of ctx.journal.read().events) {
    if (event.type !== 'quality/recorded') continue
    const attribute = textOf(event.data['attribute'])
    if (attribute.trim() === '') continue
    out.push({ id: textOf(event.data['id']), attribute })
  }
  return out
}

export function prototypeInPlay(ctx: GateContext): boolean {
  if (ctx.project?.process === 'prototype') return true
  return existsSync(join(ctx.workspace, ctx.prototypeDir))
}

/**
 * 一条回退事件**发生时**合法的回退边集合（R-3）。
 *
 * 新事件自带 `legalAtThatTime`（回退当时由流程数据算出的合法边）→ **以事件自证为准**：
 * 之后流程数据把某条边改名/删掉，也不会追溯性地把一条当时合法的回退判红。
 * 老事件（本字段引入之前写的）没有它 → 退回用**当前**流程数据复核，即旧行为，
 * 因此兼容期内不会比过去更严（不会因为"缺字段"本身把历史事件判红）。
 */
function legalRollbackEdgesAtEvent(event: JournalEvent, process: ProcessDef, from: string): string[] {
  const recorded = event.data['legalAtThatTime']
  if (Array.isArray(recorded)) {
    return recorded.filter((item): item is string => typeof item === 'string')
  }
  return legalRollbackTargets(process, from)
}

/**
 * 追溯坏行的**统一前置检查**（P-8）。
 *
 * 凡是用 `report()` 的判据（`trace.orphans` / `trace.coverage` / `tests.passed`）都必须先过它 ——
 * 旧实现只有前两条查坏行，"must 需求都有通过的用例"那条会在同一份**不完整的图**上判绿。
 * 现在只有一处实现（口径不可能再分叉）。
 */
function traceBadLinesFailure(ctx: GateContext, criterionId: string): GateCriterionResult | undefined {
  const data = report(ctx.store, ctx.requirements)
  if (data.badLines === 0) return undefined
  return fail(
    criterionId,
    fmt('uiGates.kTraceBadLines', { p1: String(data.badLines), p2: String(data.totalLines), p3: String(data.total) }),
    t('uiGates.kTraceBadLinesRemedy'),
  )
}

/**
 * **§3（第四份评审员报告，2026-10-02）**：`journal` 被坏行截断时，「以事件流为证据」的判据
 * **不得自信作答** —— `read()` 只返回最后一致前缀，坏行之后的事件一条都读不到，
 * 于是「签字之后改过真源」「渲染过」「跑过红队」这类结论都会**静默冻结在坏行之前**（实测：截断期改需求后
 * G3 签字仍报 `valid`；截断期合法重渲染后 C-25 反而宣布「从来没有任何 `design/rendered` 事件」，
 * 而且按 remedy 再渲染一次也修不好）。
 *
 * 这里统一转成**判红 + 点名坏行**：不是「判不过」，而是「**查不动**」（口径同 `gate.unreadable`）。
 * 修好 `journal.jsonl` 那一行之后，判据自然恢复。
 */
function journalTruncatedFailure(ctx: GateContext, criterionId: string): GateCriterionResult | undefined {
  const read = ctx.journal.read()
  if (!read.truncated) return undefined
  return fail(
    criterionId,
    fmt('uiGates.kJournalTruncated', { p1: String(read.badLine ?? '?') }),
    t('uiGates.kJournalTruncatedRemedy'),
  )
}

/**
 * **`DEF-126`（TASK-157）：`skip` 不算「已覆盖」—— 处置核对（唯一出处）。**
 *
 * 病根（真机 `TC-030`）：`tests.passed` 的 `failed` 只数 `fail`、`unrun` 只数「**完全没有结果**」的用例
 * ⇒ 一条 must 用例**一次都没真跑**（只记了 `skip`）既不进 failed 也不进 unrun，判据照绿 = 假绿口子。
 * 旧口径下"跑过了"与"跳过了"在门禁眼里没有区别。
 *
 * 修法口径（**三面都不许越界**）：
 *   · **不把 `skip` 直接判成 fail** —— 平台相关用例要能表达「这条在我这儿跑不了」；
 *   · **不放宽 fail 面** —— `fail` / `unrun` / 未采纳 / 未覆盖 must 那几条判红的语义一字不动；
 *   · `skip` 必须**走 REQ-057 既有的处置词汇**（`.sdo/testing/coverage.yml` 的未覆盖项处置：
 *     `补用例` / `不可达` / `等价`，后两档**必须给理由**）才允许不算红，否则逐条点名。
 *
 * 判定的**词表与校验器不在这里**：调 `mutation.ts` 的 `assessCoverageItem`（= 同一份
 * `DISPOSITION_RULES` / `DISPOSITION_SCOPE_RULE` + 同一个 `resolveDisposition`，`coverage.ts` 也走它）。
 * 本函数只负责两件事：**怎么把一条未覆盖项指到某条用例**（`useCase` 字段逐字相等）与**把结论收成缺口**。
 *
 * 匹配键有意只有**一个**（`uncovered[i].useCase` **逐字等于**用例 id）：`item` 是散文（写的是"哪条分支没覆盖"），
 * 拿它做子串匹配等于让"名字里带 TC-030"的任意条目都算处置 —— 那才是真正会被写歪的地方。
 */
function skippedCaseGaps(store: SdoStore, skippedCaseIds: readonly string[]): { caseId: string; reason: string }[] {
  const gaps: { caseId: string; reason: string }[] = []
  const knownCaseIds = listTestCases(store).map((item) => textOf(item.id))
  const ref = TESTING_SOURCE_FILES.coverage[0]
  const read = ref === undefined ? undefined : readTestingSource(store, ref)
  const rawBody = read === undefined || !read.present || read.unreadable || read.value === null || typeof read.value !== 'object'
    ? undefined
    : (read.value as Record<string, unknown>)['uncovered']
  const uncovered = Array.isArray(rawBody)
    ? rawBody.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
    : []
  const fieldOf = new Map<Record<string, unknown>, string>()
  uncovered.forEach((item, index) => fieldOf.set(item, `uncovered[${index}]`))
  for (const caseId of skippedCaseIds) {
    const hit = uncovered.find((item) => textOf(item['useCase']).trim() === textOf(caseId).trim())
    if (hit === undefined) {
      // 连处置条目都没有 ⇒ 点名并给出**怎么写**（回执里那半句在 `uiGates.kTestsSkippedRemedy`）
      gaps.push({ caseId, reason: t('uiGates.kTestsSkippedNoDisposition') })
      continue
    }
    const assessment = assessCoverageItem(fieldOf.get(hit) ?? 'uncovered[0]', hit, { knownCaseIds })
    if (assessment.outcome === 'ok') continue
    // 条目在、但**不成立**（缺词表取值 / 缺理由 / 理由不必要 / 补的用例查不到…）⇒ 逐条带出问题原文
    gaps.push({ caseId, reason: assessment.issues.map((issue) => issue.message).join('; ') })
  }
  return gaps
}

/**
 * **回归一等纪律**（REQ-052 / TASK-037）的判据 id —— 流程数据里的 `criteria[].check` 与它一一对应
 * （四个流程的 G6 都声明了 `C-57`）。
 */
const REGRESSION_CRITERION_ID = 'regression.discipline'

/**
 * **测试报告签字判据的编号**（C-59）——`testing.report-signed` 检查器的唯一使用方是它。
 *
 * 为什么把它做成常量：回执里的"签完怎么核"必须点名**这条判据**（`sdo_gate action=check` 之后
 * 该看哪一条转绿），而判据编号写在**流程数据**里、检查器里不该再抄一遍字面量
 * （抄一遍就会出现"流程数据改了编号、回执还在说旧编号"的分叉）。
 */
const GATE_REPORT_SIGNED_CRITERION = 'C-59'

/**
 * 回归链的判据（**只接线，不重写判定**）。
 *
 * 判定逻辑**全部**在 `regression.ts`（TASK-019 交付）：变更集从台账现取、影响集由追溯图多跳闭包推出、
 * 回归集的每条结果绑被测产物哈希。这里只做三件事，且每一件都是"翻译"而不是"再判一次"：
 *
 * | # | 这里做什么 | 依据 |
 * |---|---|---|
 * | ① | 取变更集 | `changeSetFromLedger(ctx.store)`（已批准的 `CR-*` / 已修 `DEF-*` / `workspace/changes`） |
 * | ② | 读真源并判定 | `assessRegressionFromStore(store, workspace, changeSet, 用例登记表)` |
 * | ③ | 把三态翻成门禁的三态 | 真源**缺失 / 为空 / 读不动** ⇒ **看变更集**（见下）；`ok` ⇒ 通过；其余（`stale` / `incomplete` / `unknown`）⇒ **判红**并附 `regressionRemedy()` |
 *
 * **`present:false` 的两态（TASK-055：把 TASK-037 上报的 N/A 收窄补回来）**：
 *   · 变更集**为空** ⇒ **N/A**：没有变更就没有回归义务，不误伤无变更的卡；
 *   · 变更集**非空** ⇒ **判红**（`describeRegression(assessment, true)` + `regressionRemedy(true)`）：
 *     有变更却完全没记回归 ⇒ 按 REQ-052 不许声称本次变更已完成。
 *     原先无条件转 N/A 的写法等于把这一档从 G6 下面漏过去（本卡的落点一）。
 *
 * 两条硬约束：
 *   · **fail-closed**：`ok` 只有一个来源（判定层逐条核过）。`unknown`（判不动）同样判红 ——
 *     "查不动"不许当"没问题"。
 *   · **文案不在本文件**：`gates.ts` 被 i18n 棘轮钉在「零硬编码中文」（`test/m7.test.ts` 的基线
 *     `src/domain/gates.ts: 0`），人话由 `describeRegression` / `regressionRemedy` 产出 ——
 *     与 `tests.passed` 用 `describeCoverage` / `coverageRemedy` 的处置**同款**。
 */
export function assessRegressionCriterion(ctx: GateContext): GateCriterionResult {
  const changeSet = changeSetFromLedger(ctx.store)
  const assessment = assessRegressionFromStore(
    ctx.store,
    ctx.workspace,
    changeSet,
    listTestCases(ctx.store).map((item) => textOf(item.id)),
  )
  if (!assessment.present && changeSet.items.length === 0) return na(REGRESSION_CRITERION_ID, describeRegression(assessment))
  if (!assessment.present) return fail(REGRESSION_CRITERION_ID, describeRegression(assessment, true), regressionRemedy(true))
  if (assessment.outcome === 'ok') return ok(REGRESSION_CRITERION_ID, describeRegression(assessment))
  // 真源在盘上、但判定层说"**本次变更未记回归**"（空真源那一档）⇒ 修法用同一份"先补记真源"的表述：
  // 两种形态（没这个文件 / 有文件没内容）对执行者是同一件事，回执不该给两套说法。
  const notRecorded = assessment.violations.some((issue) => issue.code === 'source-not-recorded')
  return fail(REGRESSION_CRITERION_ID, describeRegression(assessment), regressionRemedy(notRecorded))
}

/**
 * **"在册无守"的收口**（第十二批 §3.4 `DEF-105` ③ / 复活 `TASK-003` 的意图）：
 * 把"**未覆盖的 must 需求**"变成门禁判据 —— 一条 must 约束**没有任何机制接住**时，门禁必须红。
 *
 * 覆盖口径**只认结构**：该 `must` 需求在 `trace/links.jsonl` 里有**一条 `req-tc` 边**（有用例覆盖它）。
 * 不读需求正文、不猜实现形态 —— 这正是 `AC-241`（`REQ-060`）要的"项目声明 + 格式无关的通用比较"。
 * 坏行必须如实上报（沿用 `traceBadLinesFailure`：被静默缩短的边集合会让"覆盖率"无声变小）。
 */
export const MUST_COVERAGE_CRITERION_ID = 'C-must-coverage'

function mustCoverage(ctx: GateContext): GateCriterionResult {
  // **项目声明才启用**（`AC-241`）：判据本身与项目无关，但"要不要把 must 需求的用例覆盖当门禁"是项目选择
  // （有的项目不用用例覆盖需求）。声明位置 `.sdo/config.yml` 的 `trace.mustCoverage: true`。
  const declared = ((): boolean => {
    try {
      const raw = ctx.store.readYaml<{ trace?: { mustCoverage?: unknown } }>('config.yml')
      return raw?.trace?.mustCoverage === true
    } catch {
      return false // 读不到配置 ⇒ 不启用（fail-open：不许因为配置读不动把门禁打开）
    }
  })()
  if (!declared) return na(MUST_COVERAGE_CRITERION_ID, t('uiGates.kMustCoverageUndeclared'))
  const broken = traceBadLinesFailure(ctx, MUST_COVERAGE_CRITERION_ID)
  if (broken !== undefined) return broken
  const must = ctx.requirements.filter((item) => textOf(item.priority) === 'must')
  if (must.length === 0) return na(MUST_COVERAGE_CRITERION_ID, t('uiGates.kMustCoverageNone'))
  const covered = new Set(
    readLinksChecked(ctx.store).links.filter((link) => link.kind === 'req-tc').map((link) => textOf(link.from)),
  )
  const gaps = must.map((item) => textOf(item.id)).filter((id) => id !== '' && !covered.has(id))
  if (gaps.length === 0) return ok(MUST_COVERAGE_CRITERION_ID, fmt('uiGates.kMustCoverageOk', { p1: String(must.length) }))
  return fail(
    MUST_COVERAGE_CRITERION_ID,
    fmt('uiGates.kMustCoverageGaps', { p1: gaps.join(' / '), p2: String(gaps.length), p3: String(must.length) }),
    fmt('uiGates.kMustCoverageRemedy', { p1: gaps.join(' / ') }),
  )
}

/**
 * **`DEF-106`（第十二批 §3.5）**：契约的**契约测试**覆盖 —— 每份契约至少一条记录，或项目**显式豁免并给理由**。
 * 判据只认 id 与记录（`contractTestGaps` 现算），不认实现形态；**项目声明才启用**（`contractTests.enforce: true`）。
 */
export const CONTRACTS_TESTED_CRITERION_ID = 'C-contracts-tested'

function contractsTested(ctx: GateContext): GateCriterionResult {
  const declared = ((): boolean => {
    try {
      const raw = ctx.store.readYaml<{ contractTests?: { enforce?: unknown } }>('config.yml')
      return raw?.contractTests?.enforce === true
    } catch {
      return false
    }
  })()
  if (!declared) return na(CONTRACTS_TESTED_CRITERION_ID, t('uiGates.kContractsTestedUndeclared'))
  const assessment = contractTestGaps(ctx.store)
  if (assessment.contracts.length === 0) return na(CONTRACTS_TESTED_CRITERION_ID, t('uiGates.kContractsTestedNone'))
  if (assessment.gaps.length === 0) {
    return ok(CONTRACTS_TESTED_CRITERION_ID, fmt('uiGates.kContractsTestedOk', {
      p1: String(assessment.contracts.length), p2: String(assessment.exempt.length),
    }))
  }
  return fail(
    CONTRACTS_TESTED_CRITERION_ID,
    fmt('uiGates.kContractsTestedGaps', {
      p1: assessment.gaps.map((gap) => `${gap.id}（${gap.reason}）`).join(' / '),
      p2: String(assessment.gaps.length),
      p3: String(assessment.contracts.length),
    }),
    t('uiGates.kContractsTestedRemedy'),
  )
}

/**
 * **`DEF-107`（第十二批 §3.5）**：**交付绑定** —— 形态由项目声明（`delivery.bind: 'commit' | 'manifest'`），
 * 插件按声明核对：commit ⇒ 最近一次提交信息里要能查到 **40/64 位十六进制**；manifest ⇒ 声明的清单落点
 * 必须存在且含至少一个 hex。未声明 ⇒ N/A 并说明原因（与 `DEF-105③`/`DEF-106` 同一口径）。
 */
export const DELIVERY_BOUND_CRITERION_ID = 'C-delivery-bound'

function deliveryBound(ctx: GateContext): GateCriterionResult {
  const assessment = deliveryBinding(ctx.store, ctx.workspace)
  if (!assessment.declared) return na(DELIVERY_BOUND_CRITERION_ID, t('uiGates.kDeliveryBoundUndeclared'))
  if (assessment.ok) return ok(DELIVERY_BOUND_CRITERION_ID, fmt('uiGates.kDeliveryBoundOk', { p1: assessment.kind }))
  return fail(
    DELIVERY_BOUND_CRITERION_ID,
    fmt('uiGates.kDeliveryBoundFail', { p1: assessment.kind, p2: assessment.detail }),
    t('uiGates.kDeliveryBoundRemedy'),
  )
}

/* ———————————————————— 本版作用域（`C-71`，`REQ-063` / `TASK-174`） ———————————————————— */

/**
 * **发布计划层的作用域判定**（`REQ-063`：`AC-266` / `AC-267` / `AC-269` / `AC-275` / `AC-287`，判据 `C-71`）。
 *
 * 一句话：**实现/验证/交付类门禁（G4/G6/G7）只对「本版 scope」判定；需求/设计类门禁（G2/G3）仍对全基线。**
 * 为什么必须按类分工（`AC-266` 的原话）：台账一旦跨版本累积，全量判据只剩两条路 —— 永久红，或被迫放宽；
 * 0.1.6 走的是第三条（手写「已知缺口」糊过去），于是那条"清单必须与台账一致"的 ADR 条款**不可机械核对**。
 *
 * **作用域 = 当前 release 的 `scope` ∪ 缺省归入者（未规划）∪ 顺延到账者（只在旧版 `nonScope` 里、目标已到账）**
 * （规格 §3.1）。三个分量都参与判定，但回执里**后两个分量必须分开点名** —— 把"顺延到账"混进"未规划"，
 * 点名就失去意义（`REV-076` findingIndex 第 3 条；派生侧已按 `failClosed` / `landedFrom` 拆成两态）。
 *
 * 四条硬口径：
 *   · **没有 release 文件＝fail-closed**（规格 R8/R9）：一切实体都视为属于当前版本。不许把"没有集合"
 *     当成"集合为空"放过 —— 那样老台账会在门禁下面整片漏过去（`R8` / `R9` 就是这两条反例）。
 *   · **`nonScope` 只认当前版**（派生侧口径，本模块不重算）：本版明确不进 ⇒ 本版不判它；只在**旧版**
 *     `nonScope` 里的**不构成永久豁免** —— 那是 `C-73` 要判红的"静默顺延"。
 *   · **只做作用域过滤，不改既有判据语义**（规格 §7 的边界）：`C-51` / `C-65` / `C-66` / `C-50` 的判定逻辑
 *     一字不动，它们看到的**实体集合**被这一层收窄（`inScopeByVersion`）。
 *   · **读不动不静默缩小判定面**：release 文件存在但形状不合法 ⇒ `deriveFor` 侧报错（点名文件与字段），
 *     这里把错误原样带进 `C-71` 的判红详情，其余实体**照常参与**判定。
 *
 * **`C-71` 的挂点写在流程数据里**（`TASK-171` / `TASK-174` 交接；旧实现是引擎补充挂载，已删）：
 * 判据的"挂点"是**数据**（`src/data/processes/*.yml` 的 `criteria[]`），引擎不替数据决定"有哪条判据"。
 * 旧实现在 `release` 文件存在时由 `versionScopeCriteria()` 往 `G4`/`G6`/`G7` 上**补一条** —— 那让
 * "流程数据说这个门禁由哪些准则构成"变成半真半假（`m32` 的原话：判据没挂上 = 这条约束不存在）。
 * 现在两个面都归数据：
 *   · **判据本身**（`id` / `check` / 中文 `desc`）写在 `waterfall.yml` 的 `G6`；
 *   · **激活条件**（`when: releases` = 发布计划层已被采纳才参与）也写在那个条目上，
 *     本模块只解释这个条件（`criterionActive`，对任何判据一视同仁，不认判据身份）。
 */

/** `C-71` 的判据 id（与规格 §3.1 同名）与检查器键。 */
export const VERSION_SCOPE_CRITERION_ID = 'C-71'
export const VERSION_SCOPE_CHECK = 'release.scope-closure'

/**
 * 「实现/验证/交付类」门禁：**只有这些门禁按本版作用域判定**（`AC-266` / `AC-275`，规格 §3.4）。
 *
 * 需求/设计类门禁（`G2`/`G3`）**不在这里** —— 它们对整条基线判定（`AC-267`：跨版本的需求不许矛盾、
 * AC 编号不许重号），把那两条也切片等于把"这条需求没人管"切出判定面。
 */
export const VERSION_SCOPED_GATE_IDS: readonly string[] = ['G4', 'G6', 'G7']

/**
 * 旧实现「补充挂载」时用的英文占位说明。
 *
 * **`TASK-171` 起不再是判据的说明来源**：`C-71` 的中文 `desc` 已写进 `waterfall.yml`（数据才是
 * "判据由什么构成"的真源）。这个常量只为兼容既有的导出面而保留（`VERSION_SCOPE_DESC` 有过外部引用），
 * 内容保持原文，**不再参与任何判定或渲染**。
 */
export const VERSION_SCOPE_DESC = 'C-71 release-scope closure: only entities inside the current release scope '
  + '(scope + fail-closed members + landed deferrals) are judged: defects fixed/closed (wontfix needs both waiver fields), '
  + 'tasks done/verified/dropped, must requirements with an adopted pass, contracts with a contractTest record. '
  + 'G4/G6/G7 only; G2/G3 stay full-baseline.'

/** 归属细分：回执要把「缺省归入」与「顺延到账」**分开点名**（`REV-076` 第 3 条）。 */
export type VersionMembershipKind = 'scope' | 'failClosed' | 'landed' | 'deferred' | 'otherVersion'

/** 本版作用域视图（由 `versionScopeOf` 现算；`evaluateGate` 在 G4/G6/G7 上注入到 `ctx.versionScope`）。 */
export interface VersionScopeView {
  /** 台账里有没有 release 文件：`false` ⇒ 一切实体都归入当前版本（fail-closed，规格 R8/R9）。 */
  hasReleases: boolean
  /** 当前 release 的 id（`r-0.1.7`）；没有 release 文件时为空串。 */
  releaseId: string
  /** 当前 release 的包版本（`0.1.7`）；没有 release 文件时为空串。 */
  packageVersion: string
  /** 算作用域时读盘失败的原因。有值 ⇒ 判据必须判红（读不动 ≠ "没有作用域"）。 */
  error: string | undefined
  /** 归属细分（`scope` / `failClosed` / `landed` / `deferred` / `otherVersion`）。 */
  classify: (entityId: string) => VersionMembershipKind
  /** 这个实体**本版要不要判**：`deferred`（本版明确不进）与 `otherVersion`（属于更晚的版本）为 `false`。 */
  includes: (entityId: string) => boolean
}

/** 读作用域失败时的视图：**不静默缩小判定面**（一切照常参与），把错误交给 `C-71` 判红。 */
function scopeViewError(message: string): VersionScopeView {
  return {
    hasReleases: true,
    releaseId: '',
    packageVersion: '',
    error: message,
    classify: () => 'failClosed',
    includes: () => true,
  }
}

/**
 * 现算本版作用域（**只读**，不写盘）。
 *
 * 归属判定**全部**来自派生层（`deriveFor`），本函数只做一件事：把派生结果翻成"本版判不判它"：
 * | 派生结果 | 本版 |
 * |---|---|
 * | `deferredFrom` 有值（当前版 `nonScope` 点了名） | **不判**（本版明确不进，`R2`） |
 * | `targetVersion === 当前版` | **判**（`scope` / `failClosed` 缺省归入 / `landed` 顺延到账） |
 * | `targetVersion === 更晚的版本` | **不判**（属于那一版；`AC-275` 的那一侧） |
 * | 一份 release 都没有（`unknown`） | **判**（fail-closed：一切都属于当前版本，规格 R8/R9） |
 *
 * 注意最后一行与"作用域为空集"是**两件相反的事**：前者把全部实体拉进判定，后者把它们全放过去。
 */
export function versionScopeOf(store: SdoStore): VersionScopeView {
  let releases: Release[]
  try {
    releases = listReleases(store)
  } catch (error) {
    return scopeViewError(error instanceof Error ? error.message : String(error))
  }
  const current = currentRelease(releases)
  const currentVersion = current === undefined ? '' : packageVersionOf(current)
  const cache = new Map<string, VersionMembershipKind>()
  const resolve = (entityId: string): VersionMembershipKind => {
    // **fail-closed**（规格 R8/R9）：没有 release 文件 ⇒ 没有集合可对，一切属于当前版本。
    if (releases.length === 0) return 'failClosed'
    const detail = deriveFor(releases, entityId)
    if (detail.deferredFrom !== undefined) return 'deferred'
    if (detail.targetVersion !== undefined && detail.targetVersion === currentVersion) {
      if (detail.landedFrom !== undefined) return 'landed'
      return detail.failClosed === true ? 'failClosed' : 'scope'
    }
    return 'otherVersion'
  }
  const classify = (entityId: string): VersionMembershipKind => {
    const id = textOf(entityId).trim()
    const known = cache.get(id)
    if (known !== undefined) return known
    const kind = resolve(id)
    cache.set(id, kind)
    return kind
  }
  return {
    hasReleases: releases.length > 0,
    releaseId: current === undefined ? '' : current.id,
    packageVersion: currentVersion,
    error: undefined,
    classify,
    includes: (entityId) => {
      const kind = classify(entityId)
      return kind !== 'deferred' && kind !== 'otherVersion'
    },
  }
}

/** 这个门禁是否属于「实现/验证/交付类」（只有它们按本版作用域判定）。 */
export function isVersionScopedGate(gateId: string | undefined): boolean {
  return gateId !== undefined && VERSION_SCOPED_GATE_IDS.includes(gateId)
}

/**
 * 判据的**激活条件**（数据声明；本引擎只解释条件，不认判据身份）。
 *
 * `when` 的语义见 `GateCriterionDef.when`：`releases` = 台账里有至少一份 release（发布计划层已被采纳），
 * 或 release 文件**读不动**（读不动必须照样判红 —— 那是最需要判据说话的一态）。
 *
 * 为什么未声明 / 未知取值一律"恒参与"：宁可按老口径判，也**不许**因为条件写错把一条判据静默关掉
 * （判据消失比判红更贵：它不会有人发现）。
 */
function criterionActive(criterion: GateCriterionDef, presence: ReleasePresence): boolean {
  if (criterion.when === undefined) return true
  if (criterion.when === 'releases') return presence.adopted
  return true
}

/** 发布计划层"在不在场"的读数（只算一次，供所有带 `when` 的判据共用）。 */
interface ReleasePresence {
  /** 有 release 文件，或读不动（读不动也算"在"：不然错误就没人报了）。 */
  adopted: boolean
}

function releasePresenceOf(store: SdoStore): ReleasePresence {
  try {
    return { adopted: listReleases(store).length > 0 }
  } catch {
    // 读不动 ⇒ 视为"发布计划层在场"：让判据跑起来判红并点名文件，而不是当成"没这套机制"
    return { adopted: true }
  }
}

/**
 * 外层作用域过滤：`ctx.versionScope` 存在时（＝正在判 G4/G6/G7）只留下本版要判的实体。
 *
 * 这是"**只在外层过滤**"的落点：既有判据（`C-51` / `C-65` / `C-66`）的判定逻辑一字不动，
 * 它们拿到的**名单**被收窄。`ctx.versionScope` 不存在（G2/G3/G5/直接调检查器）⇒ 原样返回。
 */
function inScopeByVersion<T>(ctx: GateContext, list: readonly T[], idOf: (item: T) => string): T[] {
  const view = ctx.versionScope
  if (view === undefined) return [...list]
  return list.filter((item) => view.includes(idOf(item)))
}

/** 本版在册的契约 id（`dropped` 的不算；没有需求来源的缺省归入本版 —— 证不出它属于别版）。 */
function contractIdsInScope(ctx: GateContext, view: VersionScopeView): string[] {
  return listContracts(ctx.store)
    .filter((contract) => contract.dropped !== true)
    .filter((contract) => {
      const requires = (contract.requires ?? []).map((id) => textOf(id).trim()).filter((id) => id !== '')
      if (requires.length === 0) return true
      return requires.some((id) => view.includes(id))
    })
    .map((contract) => contract.id)
}

/** 契约面的启用声明（与 `contractsTested` 同一条口径：项目在 `config.yml` 里声明才启用）。 */
function contractTestsDeclared(ctx: GateContext): boolean {
  try {
    const raw = ctx.store.readYaml<{ contractTests?: { enforce?: unknown } }>('config.yml')
    return raw?.contractTests?.enforce === true
  } catch {
    return false
  }
}

/**
 * **`C-71 作用域闭合`**（规格 §3.1）：作用域内**逐类闭合**，作用域外**不判红**。
 *
 * | 对象 | 闭合条件（口径全部沿用既有判据，不另造） |
 * |---|---|
 * | 缺陷 | `fixed` / `closed`；`wontfix` 须带 `waiveReason` + `waiveApprovedBy`（`DEF-038`，走 `fixStatusRows`） |
 * | 卡 | `done` / `verified` / `dropped`（`dropped` 是显式放弃的终态，不是"未完成"） |
 * | `must` 需求 | 至少一条 `pass` **且已采纳**的用例（`report` 的两态：没有 `req-tc` 边 / 有边但没核实） |
 * | 契约 | 有 `contractTest` 记录（`contractTestGaps`，项目声明 `contractTests.enforce` 才启用） |
 *
 * 回执分两侧点名：**缺省归入者**（`failClosed`）与**顺延到账者**（`landedFrom`）各自列出 id ——
 * 两类都参与判定，但把它们并成一堆会让"这条红是为什么进来的"不可回答（`REV-076` 第 3 条）。
 */
function versionScopeClosure(ctx: GateContext): GateCriterionResult {
  const criterionId = VERSION_SCOPE_CRITERION_ID
  const view = ctx.versionScope ?? versionScopeOf(ctx.store)
  // ① **读不动判红**（口径同 `gate.internal`：查不动不许当"没问题"）
  if (view.error !== undefined) {
    return fail(criterionId, fmt('uiGates.kCheckerThrew', { p1: view.error }), t('uiGates.kCheckerThrewRemedy'))
  }
  const badLines = traceBadLinesFailure(ctx, criterionId)
  if (badLines !== undefined) return badLines

  // ② 四类对象各自取"本版要判"的那一份。
  // **必须用本函数自己的 `view` 过滤**（不是 `inScopeByVersion`）：本判据既可能由引擎在作用域门禁上
  // 调（此时 `ctx.versionScope` 已注入），也可能被直接调用（单测 / 审计脚本 / 将来别的门禁）——
  // 只靠注入的上下文过滤，会让"直接调用"这一侧读到**全量**名单，而回执里的 `failClosed` / `landedFrom`
  // 又按 `view` 算 ⇒ 回执与判定不一致（`M214-02` 就是这么逮到它的：nonScope 里的缺陷被判了）。
  const defects = listDefects(ctx.store).filter((defect) => view.includes(defect.id))
  const tasks = listTasks(ctx.store).filter((task) => view.includes(task.id))
  const requirements = ctx.requirements.filter((requirement) => view.includes(textOf(requirement.id)))
  const contractIds = contractIdsInScope(ctx, view)
  const musts = requirements.filter((requirement) => textOf(requirement.priority) === 'must')

  // ③ 逐类求缺口（口径全部复用既有出口）
  const defectRows = fixStatusRows(defects.map((defect) => defect.id), defects).filter((row) => !row.closable)
  const taskGaps = tasks
    .filter((task) => task.status !== 'done' && task.status !== 'verified' && task.status !== 'dropped')
    .map((task) => `${task.id}(${textOf(task.status)})`)
  const trace = report(ctx.store, requirements)
  const uncovered = trace.uncoveredMust
  const unverified = trace.registeredButUnverified
  const contractsEnabled = contractTestsDeclared(ctx)
  const contractGaps = ((): { id: string; reason: string }[] => {
    if (!contractsEnabled) return []
    const declared = new Set([...contractIds])
    return contractTestGaps(ctx.store).gaps.filter((gap) => declared.has(gap.id))
  })()

  // ④ 两个"参与判定但不许混同"的分量：分开点名（`REV-076` 第 3 条 / 规格 §3.1）
  const judged = [
    ...defects.map((defect) => defect.id),
    ...tasks.map((task) => task.id),
    ...requirements.map((requirement) => textOf(requirement.id)),
    ...contractIds,
  ]
  const failClosed = judged.filter((entityId) => view.classify(entityId) === 'failClosed')
  const landed = judged.filter((entityId) => view.classify(entityId) === 'landed')
  /**
   * 回执的**两行**（`TASK-171` / `TASK-174` 交接：C-71 的回执文案进语言包）：
   *
   * · `headline` —— 人读的一行：判的是哪一版、四类各多少、两个"参与判定但必须分开点名"的分量；
   * · `tokens` —— **机器读的一行**（`scope=… failClosed=[…] landedFrom=[…]`）。
   *
   * 为什么机器串留着（而不是"换掉"）：`test/m214.test.ts` 的 M214-01/03/04/05/06 **逐字断言**
   * 那几个 token（`scope=r-0.1.7@0.1.7` / `failClosed=[DEF-002 TASK-002]` / `landedFrom=[DEF-009]` /
   * `defects=1`）—— 改 token 等于改一份**契约**，必须与守卫一起改。本轮的边界是"文案一字不出本文件"，
   * 所以两行都从语言包来：token 的**拼法**（`scope=` 这些 ASCII 前缀）也在语言包里，
   * 翻译时只翻译前后的人话，机器串保持可解析（回执被脚本与人工同时读，两件事都要成立）。
   */
  const label = view.hasReleases
    ? fmt('uiGates.kScopeLabel', { p1: view.releaseId, p2: view.packageVersion })
    : t('uiGates.kScopeNoRelease')
  const none = t('uiGates.kScopeNone')
  const headline = fmt('uiGates.kScopeHeadline', {
    p1: label,
    p2: String(defects.length),
    p3: String(tasks.length),
    p4: String(musts.length),
    p5: String(contractIds.length),
  })
  const failClosedLine = fmt('uiGates.kScopeFailClosed', {
    p1: String(failClosed.length),
    p2: failClosed.length === 0 ? none : failClosed.join(' '),
  })
  const landedLine = fmt('uiGates.kScopeLanded', {
    p1: String(landed.length),
    p2: landed.length === 0 ? none : landed.join(' '),
  })
  const scopeLine = fmt('uiGates.kScopeTokens', {
    p1: label,
    p2: String(defects.length),
    p3: String(tasks.length),
    p4: String(musts.length),
    p5: String(contractIds.length),
    p6: failClosed.join(' '),
    p7: landed.join(' '),
  })
  const scopeBlock = [headline, failClosedLine, landedLine, scopeLine].join('\n')

  // ⑤ 回执
  const lines: string[] = []
  if (defectRows.length > 0) {
    const rows = defectRows
      .map((row) => {
        const missing = row.missing
        return fmt('uiGates.kFixRowOpen', { p1: row.id, p2: row.status, p3: missing })
      })
      .join(' ')
    lines.push(fmt('uiGates.kFixUnclosed', { p1: rows }))
  }
  if (taskGaps.length > 0) {
    const list = taskGaps.join(' ')
    lines.push(fmt('gate.tasksIncomplete', { list: list }))
  }
  if (uncovered.length > 0) {
    const list = uncovered.join(' ')
    lines.push(fmt('uiGates.k108', { p1: list }))
  }
  if (unverified.length > 0) {
    const list = unverified.map((item) => `${item.requirementId}<-${item.caseIds.join('/')}`).join(' ')
    lines.push(fmt('uiGates.kCoverageUnverified', { p1: list }))
  }
  if (contractGaps.length > 0) {
    const gaps = contractGaps.map((gap) => `${gap.id}(${gap.reason})`).join(' / ')
    const missing = String(contractGaps.length)
    const total = String(contractIds.length)
    lines.push(fmt('uiGates.kContractsTestedGaps', { p1: gaps, p2: missing, p3: total }))
  }
  if (lines.length > 0) {
    const remedies: string[] = []
    if (defectRows.length > 0) remedies.push(t('uiGates.kFixedTestedRemedy'))
    if (taskGaps.length > 0) remedies.push(t('gate.tasksAllDoneRemedy'))
    if (uncovered.length > 0 || unverified.length > 0) remedies.push(t('uiGates.k109'))
    if (contractGaps.length > 0) remedies.push(t('uiGates.kContractsTestedRemedy'))
    return fail(criterionId, [...lines, scopeBlock].join('\n'), remedies.join('\n'))
  }
  return ok(criterionId, scopeBlock)
}

/* ———————————————————————— 声明—判据覆盖（`C-70`，`TASK-171` / `REQ-060`） ———————————————————————— */

/**
 * **`C-70 声明—判据覆盖`（元判据）**：每条"必须成立"的声明都要有**机判器**，或一条能机械核对的
 * **署名豁免**（理由 + 批准人 + **真实存在的判据键**）；两样都没有的进「未设防清单」，被计数、被点名。
 *
 * 判定核心在 `claimCoverage.ts`（五类声明怎么算"被守"，口径只有那一份）；本函数只做三件事：
 * 把"哪些判据键算真实存在"喂给它（流程数据 ∪ `CHECKERS` —— 豁免引用一个不存在的键就是散文）、
 * 把读数按语言包渲染成回执、按**棘轮**（`claimCoverage.baseline`：只减不增）决定红/绿。
 *
 * 三条边界：
 *   · 台账里**一条声明都没有** ⇒ N/A（不是绿：空台账证明不了任何事）；
 *   · `config.yml` 读不动 ⇒ **判红**（判不动不许判绿）；
 *   · 追溯图有坏行 ⇒ 走既有的坏行判红口径（在一份不完整的图上判"都有守"就是假绿）。
 */
export const CLAIM_KIND_LABELS: Readonly<Record<ClaimKind, string>> = {
  requirement: 'uiGates.kClaimKindRequirement',
  acceptance: 'uiGates.kClaimKindAcceptance',
  designElement: 'uiGates.kClaimKindDesignElement',
  contract: 'uiGates.kClaimKindContract',
  discipline: 'uiGates.kClaimKindDiscipline',
}

/** 逐类点名时最多写几个 id（验收准则动辄上百条 —— 其余的交给"完整清单"读数，不靠回执逞能）。 */
const CLAIM_NAMES_LIMIT: Readonly<Record<ClaimKind, number>> = {
  requirement: Number.POSITIVE_INFINITY,
  acceptance: 20,
  designElement: Number.POSITIVE_INFINITY,
  contract: Number.POSITIVE_INFINITY,
  discipline: Number.POSITIVE_INFINITY,
}

/** 真实存在的判据键：**流程数据里声明了的** ∪ `CHECKERS` 里注册了的（两处都要在，见 `m32`）。 */
function knownCriterionChecks(process: ProcessDef | undefined): string[] {
  const out = new Set<string>(Object.keys(CHECKERS))
  for (const candidate of [process, ...loadAllProcesses()]) {
    for (const gate of candidate?.gates ?? []) {
      for (const criterion of gate.criteria) if (criterion.check.trim() !== '') out.add(criterion.check)
    }
  }
  return [...out]
}

/** 点名一串 id（超过上限时明说还剩多少 —— 截断本身不许静默）。 */
function claimNames(rows: readonly ClaimRow[], kind: ClaimKind): string {
  const limit = CLAIM_NAMES_LIMIT[kind]
  const ids = rows.map((row) => row.id)
  if (ids.length <= limit) return ids.join(' ')
  return `${ids.slice(0, limit).join(' ')} ${fmt('uiGates.kClaimNamesOmitted', { p1: String(ids.length - limit) })}`
}

function claimCoverageCriterion(ctx: GateContext): GateCriterionResult {
  const criterionId = CLAIM_COVERAGE_CRITERION_ID
  const broken = traceBadLinesFailure(ctx, criterionId)
  if (broken !== undefined) return broken
  const assessment = assessClaimCoverage({
    store: ctx.store,
    requirements: ctx.requirements,
    knownChecks: knownCriterionChecks(ctx.process),
  })
  if (!assessment.configReadable) {
    return fail(criterionId, t('uiGates.kClaimConfigUnreadable'), t('uiGates.kClaimRemedy'))
  }
  if (!assessment.declared) return na(criterionId, t('uiGates.kClaimNa'))

  // ① 逐类一行（`claimCoverage` 的顺序 = 需求在前，`REQ-060` 必须一眼可读）
  const lines: string[] = [fmt('uiGates.kClaimHead', {
    p1: String(assessment.totals.declared),
    p2: String(assessment.totals.gated),
    p3: String(assessment.totals.exempted),
    p4: String(assessment.totals.unguarded),
  })]
  for (const kind of CLAIM_KINDS) {
    const count = assessment.counts[kind]
    if (count.declared === 0) continue
    const rows = assessment.unguarded.filter((row) => row.kind === kind)
    lines.push(fmt('uiGates.kClaimKindLine', {
      p1: t(CLAIM_KIND_LABELS[kind]),
      p2: String(count.declared),
      p3: String(count.gated),
      p4: String(count.exempted),
      p5: String(count.unguarded),
      p6: rows.length === 0 ? t('uiGates.kClaimNone') : claimNames(rows, kind),
    }))
  }
  // ② 判红面：豁免不成立 / 不在基线里的新增未设防 / 幽灵 trace 端点
  const problems: string[] = []
  for (const issue of assessment.issues) {
    const key = issue.code === 'exemption-no-id' ? 'uiGates.kClaimIssueNoId'
      : issue.code === 'exemption-no-reason' ? 'uiGates.kClaimIssueNoReason'
        : issue.code === 'exemption-no-approver' ? 'uiGates.kClaimIssueNoApprover'
          : issue.code === 'exemption-unknown-criterion' ? 'uiGates.kClaimIssueUnknownCriterion'
            : issue.code === 'exemption-no-target' ? 'uiGates.kClaimIssueNoTarget'
              : 'uiGates.kClaimConfigUnreadable'
    problems.push(fmt(key, { p1: issue.id === '' ? t('uiGates.kClaimBlankId') : issue.id, p2: issue.criterion }))
  }
  if (assessment.ghostEdges.length > 0) {
    const pairs = assessment.ghostEdges.map((ghost) => `${ghost.requirement}->${ghost.caseId}`).join(' ')
    problems.push(fmt('uiGates.kClaimGhostEdge', { p1: pairs, p2: String(assessment.ghostEdges.length) }))
  }
  // 棘轮只在"有东西要棘"的时候说话：未设防为 0 ⇒ 没有基线也是绿的（不然新项目一进门就红）
  if (assessment.unguarded.length > 0 && assessment.baseline.length === 0) {
    problems.push(t('uiGates.kClaimNoBaseline'))
  } else if (assessment.newUnguarded.length > 0) {
    problems.push(fmt('uiGates.kClaimNewUnguarded', {
      p1: assessment.newUnguarded.map((row) => row.id).join(' '),
      p2: String(assessment.newUnguarded.length),
    }))
  }
  if (assessment.retirableBaseline.length > 0) {
    lines.push(fmt('uiGates.kClaimRetirable', { p1: assessment.retirableBaseline.join(' ') }))
  }
  const body = [...lines, ...problems].join('\n')
  if (problems.length === 0) {
    return ok(criterionId, body)
  }
  return fail(criterionId, body, t('uiGates.kClaimRemedy'))
}

/* ———————————————————————— 收口判据：owner 的角色（`C-76`，`DEF-162` 第③条） ———————————————————————— */

/**
 * **`C-76 收口时的 owner 角色`**：已 `done` / `verified` 的卡，`owner` 的角色必须**等于**卡的 `role`。
 *
 * 这是 `C-70` 的第一个**真实**反例：`DEF-162` 的原话是「流程官只记账、实现派给该角色的执行者」
 * 这条分工**只写在文档里，没有任何机械判据守着**。认领面（`C-70` 之外，`office.ts`）按 fail-open 放行
 * 认不出形态的 owner；**收口**这一面 fail-closed：写完、验完、证据落盘之后，"谁做的"就是台账事实。
 */
export const OWNER_ROLE_CRITERION_ID = 'C-76'
export const OWNER_ROLE_CHECK = 'tasks.owner-role'

function ownerRoleCriterion(ctx: GateContext): GateCriterionResult {
  const criterionId = OWNER_ROLE_CRITERION_ID
  const tasks = listTasks(ctx.store).map((task) => ({
    id: task.id,
    status: String(task.status),
    role: textOf(task.role),
    ...(task.owner === undefined ? {} : { owner: task.owner }),
  }))
  const settled = tasks.filter((task) => task.status === 'done' || task.status === 'verified')
  if (settled.length === 0) return na(criterionId, t('uiGates.kOwnerRoleNa'))
  const findings = ownerRoleFindings(tasks)
  if (findings.length === 0) {
    return ok(criterionId, fmt('uiGates.kOwnerRoleOk', { p1: String(settled.length) }))
  }
  const rows = findings.map((finding) => {
    const reason = finding.reason === 'owner-empty'
      ? t('uiGates.kOwnerRoleNoOwner')
      : finding.reason === 'owner-role-unknown'
        ? t('uiGates.kOwnerRoleUnknown')
        : t('uiGates.kOwnerRoleMismatch')
    return fmt('uiGates.kOwnerRoleRow', {
      p1: finding.taskId,
      p2: finding.status,
      p3: finding.cardRole,
      p4: finding.owner === '' ? t('uiGates.kOwnerRoleNoOwner') : finding.owner,
      p5: finding.ownerRole ?? t('uiGates.kOwnerRoleUnknownRole'),
      p6: reason,
    })
  })
  return fail(
    criterionId,
    fmt('uiGates.kOwnerRoleGaps', {
      p1: rows.join(' '),
      p2: String(findings.length),
      p3: String(settled.length),
    }),
    t('uiGates.kOwnerRoleRemedy'),
  )
}

/* ———————————————————————— 发布计划层：C-73 / C-75 / C-72 的挂载面（`TASK-171`） ———————————————————————— */

/**
 * **`C-73 顺延留痕与次数上限`**：判定核心是 `release.ts` 的 `deferTraceFindings`（`TASK-176` 交付）。
 *
 * 本函数只做三件事：取**读数**（台账里的 release、已终结实体、真源里的 `release/deferred` 记录、上限）、
 * 把 findings 渲染成回执、以及**没有 release 文件时给 N/A**（发布计划层尚未被采纳 ——
 * 那不是"没有缺口"，而是这套机制还没上线，判它红只会训练读者忽略判据）。
 *
 * 「真源留痕」这一路豁免（`AC-277` 的"不许静默顺延"）读的是 `journal` 里的 `release/deferred` 事件
 * （`TASK-171` 补的事件类型 + `office.ts` 的写入面）—— 不再是调用方凭空的集合。
 */
export const DEFER_TRACE_CRITERION_ID = 'C-73'
export const DEFER_TRACE_CHECK = 'release.defer-trace'

/** 已**终结**的实体 id（顺延面的三路豁免之一：做完了就不算顺延）。口径：缺陷 `fixed`/`closed`、卡 `done`/`verified`/`dropped`。 */
function settledEntityIdsOf(store: SdoStore): string[] {
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

/** 真源里**点名过顺延**的实体 id（`release/deferred` 事件；`id` 单条与 `ids` 批量两种形态都认）。 */
function deferredRecordIdsOf(journal: Journal): string[] {
  const out = new Set<string>()
  for (const event of journal.read().events) {
    if (event.type !== 'release/deferred') continue
    const data = event.data
    const single = textOf(data['id']).trim()
    if (single !== '') out.add(single)
    const many = data['ids']
    if (Array.isArray(many)) {
      for (const item of many) {
        const id = textOf(item).trim()
        if (id !== '') out.add(id)
      }
    }
  }
  return [...out]
}

/** 台账里的 release 清单（读不动 ⇒ 交给调用方判红：读不动不等于没有）。 */
function releasesOf(ctx: GateContext): { ok: true; releases: Release[] } | { ok: false; error: string } {
  try {
    return { ok: true, releases: listReleases(ctx.store) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function deferTraceCriterion(ctx: GateContext): GateCriterionResult {
  const criterionId = DEFER_TRACE_CRITERION_ID
  const read = releasesOf(ctx)
  if (!read.ok) {
    return fail(criterionId, fmt('uiGates.kReleaseUnreadable', { p1: read.error }), t('uiGates.kReleaseUnreadableRemedy'))
  }
  if (read.releases.length === 0) return na(criterionId, t('uiGates.kReleaseLayerNotAdopted'))
  const truncated = journalTruncatedFailure(ctx, criterionId)
  if (truncated !== undefined) return truncated
  const findings = deferTraceFindings({
    releases: read.releases,
    settled: settledEntityIdsOf(ctx.store),
    deferredRecords: deferredRecordIdsOf(ctx.journal),
    limit: deferLimitOf(ctx.store),
  })
  if (findings.length === 0) {
    return ok(criterionId, fmt('uiGates.kDeferTraceOk', { p1: String(read.releases.length) }))
  }
  const rows = findings.map((finding) => fmt('uiGates.kDeferTraceRow', {
    p1: finding.subjectId,
    p2: finding.kind,
    p3: finding.detail,
  }))
  return fail(
    criterionId,
    fmt('uiGates.kDeferTraceGaps', { p1: rows.join(' '), p2: String(findings.length) }),
    t('uiGates.kDeferTraceRemedy'),
  )
}

/**
 * **`C-75 冻结人签与冻结后改集合`**：判定核心是 `release.ts` 的 `freezeTraceFindings`（`TASK-176`）。
 *
 * 为什么需要 `journal` 的事件：`frozenAtSeq` 与"冻结之后有没有被绕过 `change` 改过"都是**对真源的断言**，
 * 光看文件核不了（`.sdo/**\/*.yml` 是手可编辑的）。
 */
export const FREEZE_TRACE_CRITERION_ID = 'C-75'
export const FREEZE_TRACE_CHECK = 'release.freeze-trace'

function freezeTraceCriterion(ctx: GateContext): GateCriterionResult {
  const criterionId = FREEZE_TRACE_CRITERION_ID
  const read = releasesOf(ctx)
  if (!read.ok) {
    return fail(criterionId, fmt('uiGates.kReleaseUnreadable', { p1: read.error }), t('uiGates.kReleaseUnreadableRemedy'))
  }
  if (read.releases.length === 0) return na(criterionId, t('uiGates.kReleaseLayerNotAdopted'))
  const truncated = journalTruncatedFailure(ctx, criterionId)
  if (truncated !== undefined) return truncated
  const findings = freezeTraceFindings({ releases: read.releases, events: ctx.journal.read().events })
  if (findings.length === 0) {
    return ok(criterionId, fmt('uiGates.kFreezeTraceOk', { p1: String(read.releases.length) }))
  }
  const rows = findings.map((finding) => fmt('uiGates.kFreezeTraceRow', {
    p1: finding.subjectId,
    p2: finding.kind,
    p3: finding.detail,
  }))
  return fail(
    criterionId,
    fmt('uiGates.kFreezeTraceGaps', { p1: rows.join(' '), p2: String(findings.length) }),
    t('uiGates.kFreezeTraceRemedy'),
  )
}

/**
 * **`C-72 缺口清单与台账集合恰好相等`**：`CHANGELOG.md` 本版「已知缺口」点到的 id 集合
 * 必须与当前 release 的 `nonScope` **恰好相等**（多写＝粉饰、少写＝隐瞒）。
 *
 * 两条口径（与 `scripts/gen-changelog.mjs` 的判定**同源**）：
 *   · **对账面**只有一份：`deferredIdsOf(currentRelease(...))`（派生字段不算）；
 *   · 清单条目必须写成 `` - `<id>` ``（id 在行首的反引号里）—— 理由文字里顺带提到的 id 不算点名。
 *
 * 为什么这里也有一份解析器（而不是调那个脚本）：门禁必须是**纯函数**（不 spawn 子进程、不依赖编译产物），
 * 而脚本是给人在 CI 里跑的入口。两处**不许分叉**，由 `test/m219.test.ts` 拿同一份夹具
 * 交叉核对（脚本的 `checkGapParity` 与本判据必须给同一个结论）。
 */
export const GAP_PARITY_CRITERION_ID = 'C-72'
export const GAP_PARITY_CHECK = 'release.gap-reconciled'

const GAP_BEGIN_PREFIX = '<!-- sdo:gap:begin release='
const GAP_END_MARK = '<!-- sdo:gap:end -->'
const GAP_ITEM_ID = /^[-*]\s+`([A-Za-z][A-Za-z0-9]*-\d+)`/u
const GAP_LIST_ITEM = /^[-*]\s+/u

interface GapBlock {
  present: boolean
  malformed: boolean
  release: string
  ids: string[]
  unparsable: string[]
}

function parseGapBlock(text: string): GapBlock {
  const beginAt = text.indexOf(GAP_BEGIN_PREFIX)
  if (beginAt === -1) return { present: false, malformed: false, release: '', ids: [], unparsable: [] }
  const lineEnd = text.indexOf('\n', beginAt)
  const headEnd = lineEnd === -1 ? text.length : lineEnd
  const head = text.slice(beginAt, headEnd)
  const closeAt = head.indexOf(' -->')
  const release = (closeAt === -1 ? head.slice(GAP_BEGIN_PREFIX.length) : head.slice(GAP_BEGIN_PREFIX.length, closeAt)).trim()
  const endAt = text.indexOf(GAP_END_MARK, headEnd)
  const malformed = closeAt === -1 || endAt === -1
  const body = endAt === -1 ? text.slice(headEnd) : text.slice(headEnd, endAt)
  const ids: string[] = []
  const unparsable: string[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const matched = GAP_ITEM_ID.exec(line)
    if (matched !== null) {
      const id = (matched[1] ?? '').trim()
      if (id !== '' && !ids.includes(id)) ids.push(id)
      continue
    }
    if (GAP_LIST_ITEM.test(line)) unparsable.push(line)
  }
  return { present: true, malformed, release, ids, unparsable }
}

function gapParityCriterion(ctx: GateContext): GateCriterionResult {
  const criterionId = GAP_PARITY_CRITERION_ID
  const read = releasesOf(ctx)
  if (!read.ok) {
    return fail(criterionId, fmt('uiGates.kReleaseUnreadable', { p1: read.error }), t('uiGates.kReleaseUnreadableRemedy'))
  }
  if (read.releases.length === 0) return na(criterionId, t('uiGates.kReleaseLayerNotAdopted'))
  const current = currentRelease(read.releases)
  if (current === undefined) return na(criterionId, t('uiGates.kReleaseLayerNotAdopted'))
  const declared = deferredIdsOf(current)
  const text = readFileSyncSafe(join(ctx.workspace, 'CHANGELOG.md'))
  if (text === undefined) {
    return fail(criterionId, fmt('uiGates.kGapNoChangelog', { p1: current.id }), t('uiGates.kGapRemedy'))
  }
  const block = parseGapBlock(text)
  const problems: string[] = []
  if (!block.present) {
    if (declared.length > 0) {
      problems.push(fmt('uiGates.kGapMissingBlock', { p1: declared.join(' '), p2: String(declared.length) }))
    }
  } else {
    if (block.malformed) problems.push(t('uiGates.kGapMalformed'))
    if (block.release !== current.id) {
      problems.push(fmt('uiGates.kGapMarkerMismatch', {
        p1: block.release === '' ? t('uiGates.kGapMarkerBlank') : block.release,
        p2: current.id,
      }))
    }
    const padding = block.ids.filter((id) => !declared.includes(id))
    const hidden = declared.filter((id) => !block.ids.includes(id))
    if (padding.length > 0) problems.push(fmt('uiGates.kGapPadding', { p1: padding.join(' '), p2: String(padding.length) }))
    if (hidden.length > 0) problems.push(fmt('uiGates.kGapHidden', { p1: hidden.join(' '), p2: String(hidden.length) }))
    if (block.unparsable.length > 0) {
      problems.push(fmt('uiGates.kGapUnparsable', { p1: block.unparsable.join(' / '), p2: String(block.unparsable.length) }))
    }
  }
  if (problems.length === 0) {
    return ok(criterionId, declared.length === 0
      ? fmt('uiGates.kGapOkEmpty', { p1: current.id })
      : fmt('uiGates.kGapOk', { p1: current.id, p2: String(declared.length), p3: declared.join(' ') }))
  }
  return fail(criterionId, fmt('uiGates.kGapGaps', { p1: problems.join('；'), p2: current.id }), t('uiGates.kGapRemedy'))
}

export const CHECKERS: Record<string, (ctx: GateContext) => GateCriterionResult> = {
  // **`C-70`（TASK-171）**：声明—判据覆盖（元判据）—— 没机判器也没署名豁免的声明进「未设防清单」
  [CLAIM_COVERAGE_CHECK]: (ctx) => claimCoverageCriterion(ctx),
  // **`C-76`（TASK-171 / DEF-162 ③）**：已收口的卡，owner 的角色必须等于卡的 role
  [OWNER_ROLE_CHECK]: (ctx) => ownerRoleCriterion(ctx),
  // **`C-73` / `C-75` / `C-72`（TASK-171 接线；判定核心在 release.ts / CHANGELOG 对账面）**
  [DEFER_TRACE_CHECK]: (ctx) => deferTraceCriterion(ctx),
  [FREEZE_TRACE_CHECK]: (ctx) => freezeTraceCriterion(ctx),
  [GAP_PARITY_CHECK]: (ctx) => gapParityCriterion(ctx),
  // **`C-71`（TASK-174）**：作用域闭合（挂点与激活条件都在流程数据里，见 `waterfall.yml` 的 G6）
  [VERSION_SCOPE_CHECK]: (ctx) => versionScopeClosure(ctx),
  // **`DEF-105` ③**：未覆盖的 must 需求 ⇒ 红并点名（`REQ-060` 就是它的第一个实例）
  'coverage.uncovered': (ctx) => mustCoverage(ctx),
  // **`DEF-106`**：契约的契约测试覆盖（记录或项目豁免；缺一份即红并点名契约 id）
  'contracts.tested': (ctx) => contractsTested(ctx),
  // **`DEF-107`**：交付绑定形态（commit 提交信息含哈希 / manifest 清单含哈希；未声明 ⇒ N/A）
  'delivery.bound': (ctx) => deliveryBound(ctx),
  // —————————————— G2 的 DoR 判据：**按 check 键**挂载（B1） ——————————————
  //
  // 旧实现把 `evaluateDor` 的产出按**判据 id** 顶掉同名判据，于是"配置假装数据驱动，
  // 实际被硬编码劫持"：任何门禁里只要出现同 id 的判据，无论声明的 `check` 是什么都会被顶掉；
  // 而 `baseline` 又根本不走 `evaluateGate`，自己拼一个 `status:'passed'` 落盘 →
  // 流程数据里声明的第 8 条判据（C8 红队议题闭环）**从不被判定**。
  // 现在每个判据都由它自己的 `check` 键唯一决定，`baseline` 走 `evaluateGate` 现算。
  'dor.per_requirement': (ctx) => dorCriterion(ctx, 'C1-dor-per-requirement'),
  'questions.open_p0': (ctx) => dorCriterion(ctx, 'C2-open-questions'),
  'dor.must_has_ac': (ctx) => dorCriterion(ctx, 'C3-must-has-ac'),

  /**
   * **验收大纲左移到需求基线**（REQ-046 / TASK-013）：G2 冻结前，验收依据必须已经写清。
   *
   * 为什么钉在 G2 而不是交付期：V 模型要求"左边写下什么，右边就验什么"。等交付期再倒推验收项，
   * 就只能凭印象列，也就无法反过来说"这条 AC 没验"。于是这条判据把 REQ-046 的硬要求钉在冻结那一刻：
   *   · 大纲不存在 ⇒ 判红（**并点名缺多少条 AC**）；
   *   · 需求真源指纹与生成时不一致 ⇒ 判红（**需求变更 ⇒ 整份大纲失效**，须重新生成并随 G2 重签）；
   *   · 指纹一致但缺条目 / 判定基准为空 ⇒ 判红（**逐条点名**缺哪条、哪条没写判定基准）。
   *
   * 判定与点名都在 `acceptance.ts` 里现算（`assessOutline` **只读**、不写盘）；这里只把结论翻成三态。
   * 用户可见句子由 `describeOutlineVerdict` / `outlineRemedy` 产出 —— 本文件被 i18n 棘轮钉在
   * 「零硬编码中文」（`test/m7.test.ts` 的基线 `src/domain/gates.ts: 0`），所以文案统一由那个模块给；
   * 迁到 `uiGates.*` 语言键属后续卡（写范围不含 `src/data/lang/`）。
   */
  'dor.acceptance_outline': (ctx) => {
    const assessment = assessOutline(ctx.store, ctx.requirements)
    if (assessment.verdict === 'ok') {
      return ok('dor.acceptance_outline', describeOutlineVerdict(assessment))
    }
    return fail('dor.acceptance_outline', describeOutlineVerdict(assessment), outlineRemedy())
  },

  /**
   * **P-5**：验收标准编号**全局唯一**。
   *
   * N-2 只堵住了"以后写不进来"，存量重号（实测某项目 `AC-001`…`AC-005` 被两条需求各用一遍）
   * 既查不出、也没有任何判据会报 —— 而 AC 编号正是交付验收矩阵的追溯键，重号即错配。
   * 这条判据让"查一查"变成一次 `sdo_gate action=check gate=G2`（并点名每一个重号与其归属）。
   */
  'dor.ac_ids_unique': (ctx) => {
    const owners = new Map<string, string[]>()
    for (const requirement of ctx.requirements) {
      for (const ac of requirement.acceptance) {
        owners.set(ac.id, [...(owners.get(ac.id) ?? []), requirement.id])
      }
    }
    const duplicated = [...owners.entries()].filter(([, ids]) => ids.length > 1)
    if (duplicated.length === 0) {
      return ok('dor.ac_ids_unique', fmt('uiGates.kAcIdsUnique', { p1: String(owners.size) }))
    }
    return fail(
      'dor.ac_ids_unique',
      fmt('uiGates.kAcIdsDuplicated', {
        p1: duplicated.map(([id, ids]) => `${id}（${ids.join(' ')}）`).join('；'),
      }),
      t('uiGates.kAcIdsDuplicatedRemedy'),
    )
  },

  'project.scope.in': (ctx) =>
    (ctx.project?.scope.in.length ?? 0) > 0
      ? ok('project.scope.in', fmt('uiGates.k1', { p1: ctx.project?.scope.in.length ?? 0 }))
      : fail('project.scope.in', t('uiGates.k2'), t('uiGates.k3')),

  'project.scope.out': (ctx) =>
    (ctx.project?.scope.out.length ?? 0) > 0
      ? ok('project.scope.out', fmt('uiGates.k4', { p1: ctx.project?.scope.out.length ?? 0 }))
      : fail('project.scope.out', t('uiGates.k5'), t('uiGates.k6')),

  'project.stakeholders': (ctx) =>
    (ctx.project?.stakeholders.length ?? 0) > 0
      ? ok('project.stakeholders', fmt('uiGates.k7', { p1: ctx.project?.stakeholders.length ?? 0 }))
      : fail('project.stakeholders', t('uiGates.k8'), t('uiGates.k9')),

  'project.metrics': (ctx) => {
    const metrics = ctx.project?.metrics.success ?? []
    if (metrics.length === 0) {
      return fail('project.metrics', t('uiGates.k10'), t('uiGates.k11'))
    }
    const measurable = metrics.some((metric) => /\d/u.test(metric))
    return measurable
      ? ok('project.metrics', fmt('uiGates.k12', { p1: metrics.length }))
      : fail('project.metrics', fmt('uiGates.k13', { p1: metrics.join('；') }), t('uiGates.k14'))
  },

  'project.glossary': (ctx) => {
    const terms = Object.keys(ctx.project?.glossary ?? {})
    return terms.length > 0
      ? ok('project.glossary', fmt('uiGates.k15', { p1: terms.length }))
      : fail('project.glossary', t('uiGates.k16'), t('uiGates.k17'))
  },

  'feasibility.verdict': (ctx) => {
    const assessment = ctx.feasibility
    if (assessment === undefined) return fail('feasibility.verdict', t('uiGates.k18'), t('uiGates.k19'))
    return assessment.verdict === 'go'
      ? ok('feasibility.verdict', t('uiGates.k20'))
      : fail('feasibility.verdict', fmt('uiGates.k21', { p1: assessment.verdict }), t('uiGates.k22'))
  },

  'feasibility.risks': (ctx) => {
    const stats = riskStats(ctx.risks)
    if (stats.total === 0) return fail('feasibility.risks', t('uiGates.k23'), t('uiGates.k24'))
    if (stats.unmitigated.length > 0) {
      return fail(
        'feasibility.risks',
        fmt('uiGates.k25', { p1: stats.unmitigated.map((risk) => risk.id).join(' ') }),
        t('uiGates.k26'),
      )
    }
    return ok('feasibility.risks', fmt('uiGates.k27', { p1: stats.total, p2: stats.high, p3: stats.blockers }))
  },

  'feasibility.poc': (ctx) => {
    const poc = ctx.feasibility?.poc ?? []
    return poc.length > 0
      ? ok('feasibility.poc', fmt('uiGates.k28', { p1: poc.length }))
      : fail('feasibility.poc', t('uiGates.k29'), t('uiGates.k30'))
  },

  'redteam.executed': (ctx) => {
    // §3：截断期不得拿「最后一致前缀」自信作答（先报「查不动」）
    const truncated = journalTruncatedFailure(ctx, 'redteam.executed')
    if (truncated !== undefined) return truncated
    const scale = ctx.project?.tailoring?.scale ?? 'normal'
    if (scale === 'trivial') return ok('redteam.executed', t('uiGates.k31'))
    if (ctx.redTeamExecuted) return ok('redteam.executed', t('uiGates.k32'))
    if (ctx.redTeamDisabled) return ok('redteam.executed', t('uiGates.k33'))
    return fail('redteam.executed', t('uiGates.k34'), t('uiGates.k35'))
  },

  'redteam.closed': (ctx) => {
    if (ctx.issues.length === 0) {
      return fail('redteam.closed', t('uiGates.k36'), t('uiGates.k37'))
    }
    const open = ctx.issues.filter((issue) => !issueClosure(issue, ctx.questions, ctx.risks).closed)
    if (open.length === 0) return ok('redteam.closed', fmt('uiGates.k38', { p1: ctx.issues.length }))
    return fail(
      'redteam.closed',
      fmt('uiGates.k39', { p1: open.map((issue) => issue.id).join(' ') }),
      t('uiGates.k40'),
    )
  },

  /**
   * 人类签字（G2 的 C7）—— **以签字台账为准**（D1）。
   *
   * 旧实现只看 `approvedBy` 这个**入参字符串**（模型能自授）。现在：
   *   · 通过与失败**只**由 `signatureState(store, journal, 'G2')` 决定；
   *   · `approvedBy` 作为**附加信息**照实写进 detail（不静默忽略，但不再是放行依据）；
   *   · detail 里同时给出该门禁的**失效事件集合**（与判定同源），
   *     读回执的人一眼能看到"签字之后哪些真源变更会让它失效"。
   */
  'human.signoff': (ctx) => {
    const ledger = signatureState(ctx.store, ctx.journal, 'G2')
    const signer = (ctx.approvedBy ?? '').trim()
    const extra = signer === '' ? t('uiGates.kSignoffApprovedByAbsent') : fmt('uiGates.kSignoffApprovedByExtra', { p1: signer })
    const events = signatureInvalidatingEventLine('G2')
    // **R3**：同上 —— 与真源事件对不上的签字不得算有效
    if (ledger.status === 'valid' && ledger.inconsistent !== true) {
      return ok('human.signoff', `${ledger.reason}${extra}${events}`)
    }
    return fail('human.signoff', `${ledger.reason}${extra}${events}`, t('uiGates.kSignoffRemedy'))
  },

  'prototype.timebox': (ctx) => {
    // **D3 / §一.5 统一**：本流程不涉及原型（且没有原型目录）时判 **N/A + 理由**。
    // 旧写法在这里返回 `ok`：语义上把"不适用"混进了"通过"，回执看不出区别，
    // 也会让"通过数"虚高。现在与 `ui.confirmed` 同一口径（三态 N/A）。
    if (!prototypeInPlay(ctx)) return na('prototype.timebox', t('uiGates.kPrototypeNa'))
    const dir = join(ctx.workspace, ctx.prototypeDir)
    const hasContent = hasSubstantiveContent(dir)
    if (!hasContent) {
      return fail('prototype.timebox', fmt('uiGates.k44', { p1: ctx.prototypeDir }), t('uiGates.k45'))
    }
    return ctx.prototypeThrowaway
      ? ok('prototype.timebox', t('uiGates.k47'))
      : fail('prototype.timebox', t('uiGates.k48'), t('uiGates.k49'))
  },

  'prototype.backfilled': (ctx) => {
    // 同上：不适用 → N/A + 理由（不是"通过"）
    if (!prototypeInPlay(ctx)) return na('prototype.backfilled', t('uiGates.kPrototypeBackfilledNa'))
    const fromPrototype = ctx.requirements.filter((requirement) => requirement.source.prototype === true)
    if (fromPrototype.length > 0) {
      return ok('prototype.backfilled', fmt('uiGates.k51', { p1: fromPrototype.length }))
    }
    const protoExists = existsSync(join(ctx.workspace, ctx.prototypeDir))
    return fail(
      'prototype.backfilled',
      protoExists ? t('uiGates.k52') : t('uiGates.k53'),
      t('uiGates.k54'),
    )
  },

  'prototype.excluded': (ctx) => {
    const dir = join(ctx.workspace, ctx.prototypeDir)
    if (!existsSync(dir)) return ok('prototype.excluded', fmt('uiGates.k55', { p1: ctx.prototypeDir }))
    if (!hasSubstantiveContent(dir)) return ok('prototype.excluded', fmt('uiGates.k56', { p1: ctx.prototypeDir }))
    return fail(
      'prototype.excluded',
      fmt('uiGates.k57', { p1: ctx.prototypeDir }),
      fmt('uiGates.k58', { p1: ctx.prototypeDir }),
    )
  },

  'risks.logged': (ctx) => {
    const stats = riskStats(ctx.risks)
    return stats.total > 0
      ? ok('risks.logged', fmt('uiGates.k59', { p1: stats.total, p2: stats.open }))
      : fail('risks.logged', t('uiGates.k60'), t('uiGates.k61'))
  },

  'risks.mitigated': (ctx) => {
    const stats = riskStats(ctx.risks)
    return stats.unmitigated.length === 0
      ? ok('risks.mitigated', t('uiGates.k62'))
      : fail(
          'risks.mitigated',
          fmt('uiGates.k63', { p1: stats.unmitigated.map((risk) => risk.id).join(' ') }),
          t('uiGates.k64'),
        )
  },

  /**
   * **设计适用性声明**（§7.1 / §7.5）—— 本判据只查"声明本身"。
   *
   * 存量项目没有声明 → **判红**，detail 必须写「未声明适用性」（§7.6 第 6 条要求
   * 提示是"未声明适用性"而不是其它原因）。
   * 声明有结构问题（缺 focus / 某个视图**既未列入 present 也未说明 absent** /
   * `viewsAbsent` 缺理由）→ 判红并逐条列出（§7.4「必须显式二选一」）。
   */
  'design.applicability': (ctx) => {
    const state = applicabilityState(ctx.store)
    if (state.status === 'missing') return fail('design.applicability', t('uiGates.kApplicabilityMissing'), t('uiGates.kApplicabilityRemedy'))
    // 声明的**逐条内容**（哪些视图做、哪些不做及理由）必须出现在回执里 ——
    // 「不得静默」是 §7.1 的硬要求，回执是模型唯一能读到它的地方之一。
    const shown = applicabilityLines(state.declaration).join('；')
    if (state.status === 'incomplete') {
      return fail(
        'design.applicability',
        fmt('uiGates.kApplicabilityIncomplete', { p1: state.problems.join('；') }),
        t('uiGates.kApplicabilityRemedy'),
      )
    }
    const app = state.declaration
    return ok(
      'design.applicability',
      fmt('uiGates.kApplicabilityOk', {
        p1: app?.viewsPresent.length ?? 0,
        p2: app?.viewsAbsent.length ?? 0,
        p3: shown,
      }),
    )
  },

  /**
   * 五视图（§7.4）：`viewsPresent` 的视图必须**非空**（受影响部分有内容即可）；
   * `viewsAbsent` 的视图判 **N/A + 该条声明理由**；既未列入 present 也未说明 absent 的视图
   * → 判红（必须显式二选一）。没有声明时不在这里重复判红（由 `design.applicability` 负责）。
   *
   * **Y-4（本报告）**：声明里还可以写第 6 个视图 `ui`，而它此前**不产生任何规则** ——
   * 声明说"界面视图：做"，门禁却一个字都不查（只靠 C-27 兜底；而 C-27 在
   * `surfaces` 未声明时直接 N/A），于是"声明了但无人检查"。现在：声明 `ui` 为 present
   * 就必须真有界面证据（`uiDecision`），否则判红。
   *
   * **§3.2（第二轮整体评审）**：方向 ① 只堵了一半 —— 声明 `viewsAbsent:[{kind:ui}]`（"不做界面视图"）
   * 时 `ui` 照样**不产生规则**，于是"项目 `surfaces:[web]` + 声明说不做界面"能一路 N/A/绿，
   * 而把同一件事写成 `viewsPresent:[ui]` 却判红（同一份声明换个方向结论相反）。修后口径只有一句：
   * **声明里的 `ui` 必须与 `uiDecision` 方向一致（`present ⟺ hasUi`）**；两个方向矛盾都判红。
   * `ui` 方向一致时本条不重复判"界面是否确认"——那是 C-27（`ui.confirmed`）的职责。
   */
  'design.views': (ctx) => {
    const app = applicabilityState(ctx.store).declaration
    if (app === undefined) return fail('design.views', t('uiGates.kApplicabilityMissing'), t('uiGates.kApplicabilityRemedy'))
    const rules = viewRules(app)
    if (rules.length === 0) return fail('design.views', t('uiGates.kNoPresentView'), t('uiGates.kNoPresentViewRemedy'))
    // M7：同一份声明里既 present 又 absent = 自相矛盾 → 判红（不再静默取 present）
    const conflicted = rules.filter((rule) => rule.conflict === true).map((rule) => viewLabel(rule.kind))
    if (conflicted.length > 0) {
      return fail('design.views', fmt('uiGates.kViewConflict', { p1: conflicted.join(' ') }), t('uiGates.kViewConflictRemedy'))
    }
    // 声明里的 `ui` 与界面真源必须**方向一致**：present ⟺ hasUi
    const ui = uiDecision(ctx.project, ctx.requirements)
    const uiAbsent = app.viewsAbsent.some((item) => item.kind === 'ui')
    if (app.viewsPresent.includes('ui') && !ui.hasUi) {
      return fail('design.views', t('uiGates.kViewsUiDeclaredButAbsent'), t('uiGates.kViewsUiRemedy'))
    }
    // §3.2：说要"不做"、真源里却有界面（surfaces / 界面类需求）⇒ 同样判红。N/A 会让人以为门禁默认同意，
    // 而这里的真相是"你签字绑定的声明与项目自己的声明打架"。
    if (uiAbsent && ui.hasUi) {
      return fail(
        'design.views',
        fmt('uiGates.kViewsUiAbsentButReal', { p1: ui.reason }),
        t('uiGates.kViewsUiAbsentButRealRemedy'),
      )
    }
    const views = viewsCompleteness(ctx.store)
    const presentRules = rules.filter((rule) => rule.state === 'present')
    const missing: string[] = []
    const empty: string[] = []
    for (const rule of presentRules) {
      if (!views.present.includes(rule.kind)) missing.push(viewLabel(rule.kind))
      else if (views.empty.includes(rule.kind)) empty.push(viewLabel(rule.kind))
    }
    if (missing.length > 0) return fail('design.views', fmt('uiGates.k66', { p1: missing.join(' ') }), t('uiGates.k68'))
    if (empty.length > 0) return fail('design.views', fmt('uiGates.k67', { p1: empty.join(' ') }), t('uiGates.k68'))
    const absent = rules.filter((rule) => rule.state === 'absent')
    if (absent.length === 0) {
      return ok('design.views', fmt('uiGates.k65', { p1: presentRules.length }))
    }
    // 有 absent 视图：**判 N/A + 逐条理由**（"不适用"必须让用户看见，不是静默通过）
    return na(
      'design.views',
      fmt('uiGates.kViewsNa', {
        p1: presentRules.length,
        p2: absent.map((rule) => `${viewLabel(rule.kind)}（${rule.why}）`).join('；'),
      }),
    )
  },

  /**
   * **声明的必需工件**（§7.1「`artifacts` 里的工件必须齐备；未列入的不要求」）。
   *
   * 三态：
   *   · 声明里 `artifacts` 与 `artifactsAbsent` **都没列** → **N/A + 理由**（本项目不做这些工件）；
   *   · `artifactsAbsent` 有条目但**缺 why** → **判红并点名**（D5：声明为不做却没写理由，
   *     与 `viewsAbsent` 同口径 —— "不做"必须给得出理由，不能沉默）；
   *   · 声明了要做但缺 → 判红。更严的同类检查在 `design.method-products`（`porting` 包）。
   */
  'design.artifacts': (ctx) => {
    const app = applicabilityState(ctx.store).declaration
    if (app === undefined) return fail('design.artifacts', t('uiGates.kApplicabilityMissing'), t('uiGates.kApplicabilityRemedy'))
    const required = requiredArtifacts(app)
    const absent = absentArtifacts(app)
    // D5：逐条 why 必填 —— 先于"要不要工件"判定，因为"不做"本身也要给理由。
    const noWhy = absent.filter((item) => textOf(item.why).trim() === '')
    if (noWhy.length > 0) {
      return fail(
        'design.artifacts',
        fmt('uiGates.kArtifactsAbsentNoWhy', { p1: noWhy.map((item) => artifactLabel(item.kind)).join('、') }),
        t('uiGates.kArtifactsRemedy'),
      )
    }
    if (required.length === 0 && absent.length === 0) {
      return na('design.artifacts', t('uiGates.kArtifactsNa'))
    }
    // D5：也不许"既说做又说不做"自相矛盾（`normalizeApplicability` 会去掉这种写法，
    // 但手写真源能绕过去 —— 门禁必须判红而不是静默取一边）。
    const both = required.filter((kind) => absent.some((item) => item.kind === kind))
    if (both.length > 0) {
      return fail(
        'design.artifacts',
        fmt('uiGates.kArtifactsBoth', { p1: both.map((kind) => artifactLabel(kind)).join('、') }),
        t('uiGates.kArtifactsRemedy'),
      )
    }
    if (required.length === 0) {
      // 只声明了"不做"：这是**显式的**不做（逐条带理由），与"一个都没声明"不同 —— 回执要写出理由。
      return ok(
        'design.artifacts',
        fmt('uiGates.kArtifactsAbsentOk', {
          p1: absent.map((item) => `${artifactLabel(item.kind)}（${item.why}）`).join('；'),
        }),
      )
    }
    const missing = missingArtifacts(app, ctx.store)
    if (missing.length === 0) {
      return ok('design.artifacts', fmt('uiGates.kArtifactsOk', { p1: required.map((kind) => artifactLabel(kind)).join('、') }))
    }
    return fail(
      'design.artifacts',
      fmt('uiGates.kArtifactsMissing', { p1: missing.map((kind) => artifactLabel(kind)).join('、') }),
      t('uiGates.kArtifactsRemedy'),
    )
  },

  /**
   * **门禁级用户签字**（§7.2）—— 未签字 / 无引用 / 签字后真源变更 → **判红**，
   * 即便其余判据全绿也不可通过。
   *
   * 「无引用文本的签字视为无效」是本检查器的核心：`signatureState` 只承认带
   * 用户原话引用或所选选项原文的签字记录（防模型代签）。
   */
  'design.signed': (ctx) => {
    const state = signatureState(ctx.store, ctx.journal, 'G3')
    // **R3（复审 minor）**：`inconsistent` 以前没有任何判据消费 ⇒ 手写的签字照样 `valid`（只是理由多一句 ⚠️）。
    // 现在：台账与真源事件对不上 ⇒ 不算有效签字（理由里已经写清是哪一种不一致）。
    if (state.status === 'valid' && state.inconsistent !== true) {
      const signature = state.signature
      return ok(
        'design.signed',
        fmt('uiGates.kSigned', {
          p1: signature?.by ?? '',
          p2: signature?.basis ?? '',
          p3: channelLabel(signature?.channel ?? 'question'),
        }),
      )
    }
    return fail('design.signed', state.reason, t('uiGates.kSignedRemedy'))
  },

  /**
   * **测试总结报告必须由用户签字**（C-59 / TASK-062 / REQ-059）。
   *
   * 用户裁定（2026-10-13）：「测试报告必须签字确认才能过 G6」—— 于是本判据把"报告交用户签字"
   * 从**渲染能力**变成**门禁硬要求**。四态（每一态都点名到具体对象，不许只报一句"不通过"）：
   *
   * | # | 情形 | 判定 |
   * |---|---|---|
   * | ① | 报告真源不在盘（`.sdo/testing/report.yml`） | **判红**：没有报告就没有可签的对象（fail-closed） |
   * | ② | 报告在、但**不是当前真源的渲染**（没登记/登记指纹不符/稿子被手改） | **判红**：先渲染再签（不许签来路不明的稿子） |
   * | ③ | 报告齐备、本门**没有签字** | **判红 + 可执行修法**（签哪条命令、走哪条通道、签完怎么核） |
   * | ④ | 报告齐备 + 存在**当前指纹**的签字 | **绿**：回执给报告路径 / 内容指纹 / 签字时刻 |
   *
   * **口径全部复用，不另造**（本文件被 i18n 棘轮钉在「零硬编码中文」，文案一律走语言包）：
   *   · 签字有效性 = `signatureState(store, journal, gate)`（与 `design.signed` 同一实现路径，
   *     含 `inconsistent` 那条"台账与真源对不上 ⇒ 不算有效签字"）；
   *   · 内容指纹 = `docSourceFingerprint(store,'report')`（**报告渲染头里那一个口径**
   *     —— `.sdo/testing/report.yml` 的规范化内容哈希，不另造哈希）；
   *   · 渲染登记与"真源改了 / 来路不明 / 稿子被手改" = `renderStale` + `docHandEdited`（TASK-001 交付）。
   *
   * **态③为什么不能只看 `sourceChanged`**（与既有 `stale` 口径的**语义分界**，写在这里免得后人混用）：
   *   · `signature.reportFingerprint` 判的是「**签字之后**那份报告变了没有」——这才是"签字失效"；
   *   · `sourceChanged` / `stale` 判的是「报告 ⇄ **当前**真源自洽不自洽」——那是**签字前**的降级口径。
   *   两者混用会把"渲染滞后但真源没变"的正常签字判成**假红**；反过来只看后者又会漏掉
   *   "签字之后有人手改了渲染稿"（真源一个字节都没动）那一档。故：
   *   **有指纹 ⇒ 只比指纹（+ 手改）；没指纹（历史签字 / G2・G3 那类）⇒ 落回 `sourceChanged || stale`，
   *   并在回执里如实写明这是降级判定** —— 绝不因为"读不到指纹"就判红。
   *
   * **本判据不引入 plan mode**（用户明确）：报告正文由**既有签字通道**弹出来（`office.signReview`
   * 在验证/交付阶段把 `docs/TESTREPORT.md` 整篇投影进受审载荷），签字人看过再点选，通道不变。
   */
  'testing.report-signed': (ctx) => {
    const id = 'testing.report-signed'
    const meta = TESTING_DOC_META.report
    const path = meta.relativePath
    const reportSourceRef = TESTING_SOURCE_FILES.report.find((ref) => ref.file === 'report') ?? { class: 'report' as const, file: 'report' as const, path: meta.source }
    const state = signatureState(ctx.store, ctx.journal, ctx.gate ?? 'G6')
    // **回执要能照着做**：签哪个门禁 + 签完怎么核 —— 门禁名由引擎按判据所在的门禁注入
    //（`evaluateGate` 填 `ctx.gate`）；直接调检查器（单测/审计脚本）时退回判据惯例门禁 G6。
    const gateId = ctx.gate ?? 'G6'
    // **门禁名带编号**（`验证门禁（G6）`）：修法里的 `sdo_gate action=sign gate=…` 要能**原样照抄**，
    // 而 `signatureState` 的理由串里用的也是带编号的名字 —— 两处同形，读者不会以为是两个门禁。
    const gateText = gateWithId(gateId)
    // ① 没有报告真源 ⇒ 没有可签的对象（fail-closed）
    // ⚠️ 路径语义有两套，别混（`testingStore` 里两条注释都写了）：
    //   · `TESTING_SOURCE_FILES[*].path` 是**相对 `.sdo/` 根**的（`testing/report.yml`）；
    //   · `TESTING_DOC_META[*].relativePath` 是**相对工作区**的（`docs/TESTREPORT.md`）。
    // 这里要的是**真源**，所以取前者、交给 `store.path()`（SdoStore 的根就是 `.sdo/`）。
    if (!existsSync(ctx.store.path(...reportSourceRef.path.split('/')))) {
      return fail(
        id,
        fmt('uiGates.kReportSignedMissing', { p1: path }),
        fmt('uiGates.kReportSignedMissingRemedy', { p1: path }),
      )
    }
    const stale = renderStale(ctx.store, 'report', ctx.journal)
    // **宽松取值 `unregistered`**（与 `reviewDoc.renderTestReportSignable` 同款手法，别改成硬属性名）：
    // `test/task001-red-baseline.test.ts` 会把本模块与一份**冻结的**修正前 `testingStore.ts` 组合成
    // 一棵临时树再 `tsc` —— 那份旧类型里没有这个字段，硬写属性名会让那棵树**编译不过**（实测踩过）。
    const unregistered = (stale as unknown as { unregistered?: boolean }).unregistered === true
    const fingerprint = docSourceFingerprint(ctx.store, 'report')
    // ② 盘上没有稿子、或这份稿子不是"当前真源的渲染" ⇒ 先渲染再谈签字
    //（与 `renderStale` 同一口径：`missing` / `sourceChanged` / `unregistered` 三态，理由分别命名）
    // **三档分开写而不是套一个模板**：套模板会让"稿子不在盘"那一档把路径说两遍
    //（实测回执长这样：`docs/TESTREPORT.md 不是当前真源的渲染：docs/TESTREPORT.md 不在盘上…`）——
    // 人读的回执宁可多三行代码，也不要一句话里同一个路径出现两次。
    if (stale.missing) {
      return fail(
        id,
        fmt('uiGates.kReportSignedDocMissing', { p1: path }),
        fmt('uiGates.kReportSignedStaleRemedy', { p1: path, p2: t('uiGates.kReportSignedDocMissingReason') }),
      )
    }
    if (unregistered || stale.sourceChanged) {
      const why = unregistered
        ? fmt('uiGates.kReportSignedUnregistered', { p1: path })
        : fmt('uiGates.kReportSignedSourceChanged', { p1: stale.recordedFingerprint, p2: fingerprint })
      return fail(
        id,
        fmt('uiGates.kReportSignedNotRendered', { p1: path, p2: why }),
        fmt('uiGates.kReportSignedStaleRemedy', { p1: path, p2: why }),
      )
    }
    const signature = state.signature
    const signed = signature?.reportFingerprint
    const reportRemedy = fmt('uiGates.kReportSignedRemedy', { p1: gateText, p2: GATE_REPORT_SIGNED_CRITERION })
    // ③ **签字绑的报告版本 ⇄ 当前报告版本** —— 这一比才是"签字失效，需重签"（态③）。
    //
    // 三档都要覆盖，缺哪一档都会漏（**三条各自独立判断**，别写成互斥的 else 链 ——
    // 否则只改渲染稿（真源指纹不变）那一档会被"指纹一致"直接跳过，判据静默放过）：
    //   · **报告真源被改** ⇒ 签字绑的指纹 ≠ 当前指纹；
    //   · **渲染稿被人手改**（真源一个字节都没动）⇒ 指纹相同，但盘上那份正文不是渲染器写下的字节；
    //   · **签字已被判失效**（真源直写会落 `truth/file-written`，按黑名单口径作废签字）⇒ 失效理由
    //     只说明"有事件"，**必须补上"报告版本变了"这一条**，否则读者不知道失效的正是报告签字。
    // 语义分界：这里**只**由报告指纹 + 稿子字节说话，不动 `signatureState` 的既有口径（`design.signed` 不受影响）。
    if (signed !== undefined) {
      const changed = signed !== fingerprint
        ? fmt('uiGates.kReportSignedFingerprint', { p1: signed, p2: fingerprint })
        : docHandEdited(ctx.store, 'report')
          ? fmt('uiGates.kReportSignedFingerprintEdited', { p1: signed, p2: fingerprint, p3: path })
          : state.status === 'stale'
            // 指纹一致却仍失效：失效事件不是"报告真源变了"这一类 —— 如实说清是哪一条，别赖到报告头上
            ? fmt('uiGates.kReportSignedUnclassified', { p1: state.reason })
            : ''
      if (changed !== '') return fail(id, fmt('uiGates.kReportSignedInvalidated', { p1: changed }), reportRemedy)
    }
    // ④ 没有**有效**签字（缺失 / 无引用 / 已失效 / 台账与真源不一致）⇒ 判红 + 可执行修法
    if (state.status !== 'valid' || state.inconsistent === true) {
      return fail(
        id,
        fmt('uiGates.kReportSignedUnsigned', { p1: gateText, p2: path, p3: fingerprint }) + `；${state.reason}`,
        reportRemedy,
      )
    }
    // ⑤ 降级判定：这条签字没有记录报告指纹（历史签字 / 非本通道）⇒ 只核"当前真源自洽"，
    //    并**如实写明**这是降级（否则读者会把弱口径当强口径）
    const detail = fmt('uiGates.kReportSignedOk', {
      p1: path,
      p2: fingerprint,
      p3: signature?.at ?? '',
      p4: signature?.by ?? '',
      p5: signature?.basis ?? '',
    })
    return ok(
      id,
      signed === undefined ? `${detail}\n${t('uiGates.kReportSignedOkDegraded')}` : detail,
    )
  },

  /**
   * 阶段回退留痕（§6.1 / R-3）：回退必须有 reason，且只能沿**事件发生时**声明的合法边。
   *
   * 与旧实现的区别有两点，都是为了可追溯性：
   *   · **逐条校验全部**回退事件（旧实现只看最后一条，中间某条非法不会被发现）；
   *   · 合法性以**事件自证**（`legalAtThatTime`）为准，不再用「当前」流程数据追溯历史
   *     （旧实现会在流程数据改名/删边后，把一条当时合法的历史回退判红，诊断指向错误对象）。
   */
  'phase.rollback-recorded': (ctx) => {
    // §3：截断期不得拿「最后一致前缀」自信作答（先报「查不动」）
    const truncated = journalTruncatedFailure(ctx, 'phase.rollback-recorded')
    if (truncated !== undefined) return truncated
    const rolled = ctx.journal.read().events.filter((event) => event.type === 'phase/rolled-back')
    if (rolled.length === 0) return ok('phase.rollback-recorded', t('uiGates.kRollbackNone'))

    // **Z-4**：本判据的**强度**必须让审计者看得见 —— 合法性以事件自带的 `legalAtThatTime` 自证，
    // 不用当前流程数据追溯历史（有意如此：流程数据改名/删边不该把当时合法的回退追溯判非法）。
    // 代价是"手写一条自证合法的事件"能过，所以详情里必须写明来源，而不是让人以为它校验了流程数据。
    const evidenceNote = t('uiGates.kRollbackEvidenceNote')
    const problems: string[] = []
    const recorded: string[] = []
    for (const event of rolled) {
      const from = String(event.data['from'] ?? '')
      const to = String(event.data['to'] ?? '')
      if (String(event.data['reason'] ?? '').trim() === '') {
        problems.push(fmt('uiGates.kRollbackNoReasonAt', { p1: from, p2: to }))
        continue
      }
      const legal = legalRollbackEdgesAtEvent(event, ctx.process, from)
      if (!legal.includes(to)) {
        problems.push(fmt('uiGates.kRollbackIllegal', { p1: from, p2: to, p3: legal.join(' ') }))
        continue
      }
      recorded.push(fmt('uiGates.kRollbackOk', { p1: from, p2: to }))
    }
    if (problems.length > 0) {
      return fail('phase.rollback-recorded', `${problems.join('\n')}\n${evidenceNote}`, t('uiGates.kRollbackRemedy'))
    }
    // 全部合规：把每一条都列出来（不是只报最后一条）
    return ok('phase.rollback-recorded', `${recorded.join('\n')}\n${evidenceNote}`)
  },

  'design.adr': (ctx) => {
    const result = adrCompleteness(ctx.store)
    if (result.ok) return ok('design.adr', fmt('uiGates.k69', { p1: result.total }))
    if (result.total === 0) return fail('design.adr', t('uiGates.k70'), t('uiGates.k71'))
    return fail('design.adr', fmt('uiGates.k72', { p1: result.incomplete.join(' ') }), t('uiGates.k73'))
  },

  'trace.orphans': (ctx) => {
    const data = report(ctx.store, ctx.requirements)
    const orphans = [...data.orphans.design, ...data.orphans.tasks, ...data.orphans.tests]
    if (ctx.requirements.length === 0) return fail('trace.orphans', t('uiGates.k74'), t('uiGates.k75'))
    // **N-3 / P-8**：坏行不得静默（判红而不是只告警：本项目纪律是"查不到不能算过"）
    const bad = traceBadLinesFailure(ctx, 'trace.orphans')
    if (bad !== undefined) return bad
    if (orphans.length === 0) return ok('trace.orphans', fmt('uiGates.k76', { p1: Math.round(data.coverage * 100) }))
    return fail(
      'trace.orphans',
      fmt('uiGates.k77', { p1: orphans.join(' ') }),
      t('uiGates.k78'),
    )
  },

  'design.contracts': (ctx) => {
    const result = contractCoverage(ctx.store)
    // F-16：**名字与字段方向矛盾**的存量契约（D4-2 之前的写入）只做提示，不改判据通过与否 ——
    // 报告 §6.6.1 证明自动判定哪边错会改错一半记录，所以只把它摆到门禁详情里让人核对。
    const anomalies = contractDirectionAnomalies(ctx.store)
    const anomalyNote = anomalies.length === 0
      ? ''
      : `；${fmt('uiGates.kContractsDirectionAnomaly', { p1: String(anomalies.length), p2: anomalies.slice(0, 8).map((item) => item.id).join(' ') })}`
    // F-20：手写 YAML 把契约字段写成 number/boolean/对象时的类型提示。
    // number/boolean 只提示写法（已按字符串使用，**不判红**）；对象/数组按空缺处理（判红，但给可读的修正办法）。
    const fieldNoteLines = contractFieldNoteLines(contractFieldNotes(ctx.store))
    const fieldNote = fieldNoteLines.length === 0
      ? ''
      : `；${fmt('uiGates.kContractsFieldNote', { p1: fieldNoteLines.join('；') })}`
    if (result.ok) return ok('design.contracts', fmt('uiGates.k79', { p1: result.covered, p2: result.totalEdges }) + anomalyNote + fieldNote)
    const problems: string[] = []
    if (result.totalEdges === 0) problems.push(t('uiGates.k80'))
    if (result.missing.length > 0) {
      problems.push(fmt('uiGates.k81', { p1: result.missing.map((edge) => `${edge.consumer}→${edge.producer}`).join(' ') }))
    }
    if (result.incompleteSemantics.length > 0) problems.push(fmt('uiGates.k82', { p1: result.incompleteSemantics.join(' ') }))
    return fail('design.contracts', problems.join('；') + anomalyNote + fieldNote, t('uiGates.k83'))
  },

  // —————————————— 增量 1：设计交互闭环（A）+ 界面视图（C）+ 设计文档（D） ——————————————

  /**
   * 开放设计问题 = 0（§5）。
   *
   * 口径：**只看设计问题**（`origin === 'design'`）。需求问题由 G2 的 DoR 判据管，
   * 两条门禁各管自己的问题账本，不互相污染。
   * 未回答、或"未获用户授权的假设"都算未决（`isEffectivelyOpen` 口径）。
   */
  'design.no-open-questions': (ctx) => {
    const all = listDesignQuestions(ctx.store)
    const open = all.filter((question) => isEffectivelyOpen(question))
    if (all.length === 0) {
      // 一条设计问题都没有 = 从来没问过 —— 这不是"通过"，而是**没做交互**（§1.3 的根因所在）
      return fail('design.no-open-questions', t('uiGates.kNoQuestionsAsked'), t('uiGates.kNoOpenQuestionsRemedy'))
    }
    return open.length === 0
      ? ok('design.no-open-questions', t('uiGates.kNoOpenQuestions'))
      : fail(
          'design.no-open-questions',
          fmt('uiGates.kOpenQuestions', { p1: open.length }) + `（${open.map((question) => question.id).join(' ')}）`,
          t('uiGates.kNoOpenQuestionsRemedy'),
        )
  },

  /** 关键条目（元素 / 契约 / 界面条目）均有用户确认戳（§5）。 */
  'design.confirmed': (ctx) => {
    const gaps = confirmGaps(ctx.store, ctx.project, ctx.requirements)
    // Y-7：**已找不到对应条目的旧确认戳**不进"必须确认"清单（它们不是待办），
    // 但必须在门禁详情里被看见 —— 否则"用户以为确认过、门禁不再提"就是静默。
    const orphanNote = gaps.orphan.length === 0
      ? ''
      : `；${fmt('uiGates.kOrphanConfirmations', {
          p1: String(gaps.orphan.length),
          p2: gaps.orphan.map((item) => item.target).join(' '),
        })}`
    if (gaps.required.length === 0) {
      return na('design.confirmed', t('uiGates.kNoKeyItems') + orphanNote)
    }
    const ui = uiDecision(ctx.project, ctx.requirements)
    const uiItems = ui.hasUi
      ? gaps.required.filter((target) => target.startsWith('ui:') || target.includes(':columns') || target.includes(':layout')).length
      : 0
    const structural = gaps.required.length - uiItems
    if (gaps.missing.length === 0) {
      return ok('design.confirmed', fmt('uiGates.kConfirmed', { p1: structural, p2: listContracts(ctx.store).filter((contract) => contract.dropped !== true).length, p3: uiItems }) + orphanNote)
    }
    // F-19：把"从未确认"与"确认过但**内容已变**"分开说 —— 后者是"你的确认被静默作废了"，
    // 与"你还没确认"是完全不同的两件事，混作一句会让用户以为自己在原地踏步。
    const staleTargets = new Set(gaps.stale.map((item) => item.target))
    const never = gaps.missing.filter((target) => !staleTargets.has(target))
    const changed = gaps.missing.filter((target) => staleTargets.has(target))
    const problems: string[] = []
    if (never.length > 0) problems.push(fmt('uiGates.kUnconfirmed', { p1: never.join(' ') }))
    if (changed.length > 0) problems.push(fmt('uiGates.kUnconfirmedStale', { p1: changed.join(' ') }))
    return fail('design.confirmed', problems.join('；'), t('uiGates.kConfirmedRemedy'))
  },

  /**
   * `docs/DESIGN.md` 存在、含 11 个固定章节，**且由当前真源渲染**（X-1）。
   *
   * 旧实现只做两件事：`existsSync` + 检查 11 个标题字符串是否出现 ——
   * 于是"任意一份含这 11 个标题的旧文件"都能过门禁：文档里与真源**直接相反**的陈述
   * （实测：文档写"缺省未声明 layout.stack"，而真源已有 6 处 `stack: vertical`）照样判绿。
   * 现在渲染头写入 `<!-- source: .sdo/design @ journal seq N -->`，判定比对：
   *   · 头缺失 → 无法证明由真源渲染 → **判红**；
   *   · 渲染之后又出现会改变文档内容的事件（`DESIGN_DOC_SOURCE_EVENTS`）→ **判红**。
   */
  'design.doc': (ctx) => {
    // §3：截断期不得拿「最后一致前缀」自信作答（先报「查不动」）
    const truncated = journalTruncatedFailure(ctx, 'design.doc')
    if (truncated !== undefined) return truncated
    const path = join(ctx.workspace, 'docs', 'DESIGN.md')
    if (!existsSync(path)) {
      return fail('design.doc', t('uiGates.kDesignDocMissing'), t('uiGates.kDesignDocRemedy'))
    }
    const text = readFileSyncSafe(path)
    if (text === undefined) {
      // 读不到就是查不了 —— 不允许"查不到就算过"
      return fail('design.doc', fmt('uiGates.kDesignDocUnreadable', { p1: 'docs/DESIGN.md' }), t('uiGates.kDesignDocRemedy'))
    }
    // **P-15**：声明的语言必须是**随包语言**之一。旧实现接受任意串并静默回落当前语言，
    // 于是 `<!-- meta: lang en -->` 配中文正文会报"缺英文标题"、remedy 指向"重新渲染"——
    // 原因（头在撒谎/写错）与提示完全不符。
    const declaredLang = parseRenderLang(text)
    if (declaredLang !== undefined && !LANGUAGES.includes(declaredLang)) {
      return fail(
        'design.doc',
        fmt('uiGates.kDesignDocLangUnknown', { p1: declaredLang, p2: LANGUAGES.join(' / ') }),
        t('uiGates.kDesignDocRemedy'),
      )
    }
    // **R-10**：阶段声明必须是**当前流程里真实存在**的 id（语言那一侧早有白名单，阶段这侧此前没有）。
    // 阶段只出现在渲染头里、不进正文，所以"整份文件比对"拦不住伪造 —— 实测把它改成
    // `delivery` / `99` 都照样判绿，于是文档在审计上可以说"我是在交付阶段渲染的"。
    const declaredPhase = parseRenderPhase(text)
    if (declaredPhase !== undefined && declaredPhase !== '' && !ctx.process.phases.some((item) => item.id === declaredPhase)) {
      return fail(
        'design.doc',
        fmt('uiGates.kDesignDocPhaseUnknown', { p1: declaredPhase, p2: ctx.process.phases.map((item) => item.id).join(' / ') }),
        t('uiGates.kDesignDocRemedy'),
      )
    }
    // **N-11：先定"这份文档是哪种语言渲染的"**，后面每一关都按它取文案 ——
    // 否则中文渲染的文档在 en 会话里会因为"找不到英文标题"被判缺章节（假红），
    // 照着 remedy 重渲染成英文后，切回 zh-CN 又反向假红。
    const lang = declaredLang ?? locale()
    const missing = withLocale(lang, () => DESIGN_DOC_SECTIONS.filter((key) => !text.includes(t(key))))
    if (missing.length > 0) {
      return fail('design.doc', withLocale(lang, () => fmt('uiGates.kDesignDocIncomplete', { p1: missing.map((key) => t(key)).join('；') })), t('uiGates.kDesignDocRemedy'))
    }
    const seq = parseRenderSeq(text)
    if (seq === undefined) {
      return fail('design.doc', t('uiGates.kDesignDocUnproven'), t('uiGates.kDesignDocRemedy'))
    }
    // **N-8 ①：序号必须有上界。** 旧实现只做 `event.seq > seq` 的单侧比较，
    // 于是把渲染头伪造成一个**未来序号**（`journal seq 99999999`）就能让任何陈旧/伪造文档
    // 永久判绿 —— "文档即证据"变成了"文档对自己的声明"。
    const events = ctx.journal.read().events
    const maxSeq = events.at(-1)?.seq ?? 0
    if (seq < 1 || seq > maxSeq) {
      return fail(
        'design.doc',
        fmt('uiGates.kDesignDocSeqOutOfRange', { p1: String(seq), p2: String(maxSeq) }),
        t('uiGates.kDesignDocRemedy'),
      )
    }
    // **P-14 / R-10**：让"渲染过"与"渲染时的阶段"都**可证**。
    //
    // **F-1（sdo-test 回归报告，blocker）**：一次渲染会写**两条**同 `seq` 的 `design/rendered`
    // 事件 —— 文档一条（`kind: DESIGN.md`，带 `phase`）、可选的 puml 骨架一条（`kind: <路径>.puml`）。
    // 旧实现只按 `type + seq` 过滤后取 `.at(-1)`，于是**后写的 puml 事件顶替了文档事件**：
    // 它的 `phase` 为空 → 判据报"头里的阶段被改过"，把工具自身的行为说成用户伪造（`render --puml` 后必红）。
    // 现在：只让**文档自己**的事件参与背书（`kind` 是文档；同 seq 的其它产物一律不参与）。
    const renderEvents = events.filter(
      (event) => event.type === 'design/rendered' && Number(event.data['seq']) === seq,
    )
    const docEvents = renderEvents.filter((event) => String(event.data['kind'] ?? '') === 'DESIGN.md')
    const attested = (docEvents.length > 0 ? docEvents : renderEvents).at(-1)
    if (renderEvents.length === 0) {
      return fail(
        'design.doc',
        fmt('uiGates.kDesignDocNoRenderEvent', { p1: String(seq) }),
        t('uiGates.kDesignDocRemedy'),
      )
    }
    // 头里写了阶段时，必须与事件载荷里的阶段**完全一致**（事件在追加式真源里，伪造不了）
    const attestedPhase = String(attested?.data['phase'] ?? '')
    if (declaredPhase !== undefined && declaredPhase !== '' && declaredPhase !== attestedPhase) {
      return fail(
        'design.doc',
        fmt('uiGates.kDesignDocPhaseForged', { p1: declaredPhase, p2: attestedPhase === '' ? t('uiGates.kDesignDocPhaseNone') : attestedPhase }),
        t('uiGates.kDesignDocRemedy'),
      )
    }
    // **P-14**：让"渲染过"这件事**可证**。旧实现只认头里的数字，没有任何一处校验该序号上
    // 真的发生过一次 `design/rendered` —— 于是"头声称渲染过"与"真的渲染过"在判据眼里没有区别。
    // 注意事件**自身**的 seq 是下一条，这里比的是事件载荷里的 `seq`（= 渲染前的序号）。
    const changed = events
      .filter((event) => event.seq > seq)
      // **SDO-18（2026-10-05 真机）**：`trace/linked` 也在这张"会改文档"的表里，但**施工期覆盖边**
      // （`req-task` / `req-tc`）不进 `DESIGN.md` 的追溯矩阵（§8 只有设计侧四列）。真机上子代理
      // 补两条覆盖边就把刚渲染好的文档判陈旧（`#1279 trace/linked` 让 C-25 翻红），流程官自己也踩过。
      // 这里与 C-2D（`isSignatureInvalidatingEvent`）**同一口径**：按 `kind` 分流；拿不到 `kind` 时保守
      // 视为"会改文档"（黑名单方向不变）。
      .filter((event) => isDesignDocSourceEvent(event))
    if (changed.length > 0) {
      const first = changed[0]
      return fail(
        'design.doc',
        fmt('uiGates.kDesignDocStale', { p1: String(seq), p2: String(first?.seq ?? 0), p3: first?.type ?? '' }),
        t('uiGates.kDesignDocRemedy'),
      )
    }
    // **N-8 ② + P-15：整份文件必须等于"当前真源按头里的元信息重渲染"的结果。**
    // 比的是**整份文件**（含开头注释区）而不只是正文 —— 旧实现剥掉头部注释再比，
    // 于是任何人都能在文档顶部写任意声明（实测 `<!-- 已人工核对… -->`）而门禁一个字都不看。
    // 语言、阶段都取**头里声明的值**（它们是说明性元数据，与真源无关，见 N-8 的设计说明），
    // 因此 advance/rollback 或切语言都不会把文档判成"与真源不一致"。
    const expected = withLocale(lang, () =>
      renderDesignDocCached({
        workspace: ctx.workspace,
        store: ctx.store,
        project: ctx.project,
        requirements: ctx.requirements,
        questions: ctx.questions,
        seq,
        meta: { phase: parseRenderPhase(text) ?? ctx.project?.phase ?? '' },
      }),
    )
    // 写盘会补一个尾换行（`SdoStore.writeText`），比对前把两侧的尾空白归一。
    // **R-12**：行尾也要归一 —— Windows 编辑器把整份文档存成 CRLF 时，内容一字未改却会判红，
    // 而错误文案只说"被手工改过"（用户在 Windows 上会看到"什么都没改却一直红"）。
    const normalize = (value: string): string => stripTrailingNewlines(value.replace(/\r\n?/gu, '\n'))
    if (normalize(text) !== normalize(expected)) {
      return fail('design.doc', t('uiGates.kDesignDocBodyMismatch'), t('uiGates.kDesignDocRemedy'))
    }
    return ok('design.doc', fmt('uiGates.kDesignDoc', { p1: String(seq) }))
  },

  /**
   * **C-2G：质量场景与质量文档**（DEF-005 / DEF-006，2026-10-12 狗粮台账）。
   *
   * 缺陷原文："质量需求既不在人读文档里也不受门禁约束" / "质量场景与 ATAM 无任何人读文档承载"。
   * 本判据一次堵两头：
   *   ① **真源为空**时必须**显式**在「设计适用性声明」的 `artifactsAbsent` 里声明不做质量场景/ATAM
   *      并给理由（与视图缺席同一口径）—— 不允许"默默没有"；
   *   ② **真源非空**时必须有 `docs/QUALITY.md`，且它由当前真源渲染（渲染序号可证、真源未在渲染后变更、
   *      整份文件等于按头里元信息重渲染的结果）；
   *   ③ 无论哪条路径，**每条质量场景都必须可度量**（质量需求要能验收）。
   *
   * **2026-10-13 收紧（TASK-049 / AC-227：REQ-010「每个**声明的**质量属性至少一条场景；缺失即判红并点名」）**：
   * 旧实现把"真源为空"整片读成 N/A，于是**声明过的质量属性被删光**与"从来没提过质量"看起来一模一样 ——
   * "默默删掉证据"这条捷径在门禁上不留痕（TASK-023 的守卫实测：删掉唯一场景后 C-2G 判 N/A 而不是判红）。
   * 现在三态**分开**：
   *   · 显式声明不做（`artifactsAbsent` 里带理由）⇒ **N/A**（合法的"我们不谈质量"）；
   *   · 声明过质量属性（journal 里有 `quality/recorded`，属性名从中取）却**没有一条场景**、也没有 ATAM ⇒
   *     **判红并点名**是哪个属性、以及被判据点名的文档；
   *   · 从未声明过 ⇒ N/A（既没说要做、也没说不做，与 C-2C 同口径，不给存量项目平白加强制产物）。
   * 判据只看**真源**（journal + `.sdo/quality`），不吃"文件曾经存在过"这种缓存性证据。
   */
  'quality.doc': (ctx) => {
    const truncated = journalTruncatedFailure(ctx, 'quality.doc')
    if (truncated !== undefined) return truncated
    const scenarios = listScenarios(ctx.store)
    const assessment = readAssessment(ctx.store)
    const relative = derivedDocRelativePath('quality')

    // ① 真源为空：先分「显式声明不做」与「声明过质量属性却没有场景」——后者是**漏判**，必须判红。
    if (scenarios.length === 0 && assessment === undefined) {
      const qualityEntries = (readApplicability(ctx.store)?.artifactsAbsent ?? []).filter((item) =>
        item.kind.includes('quality'),
      )
      if (qualityEntries.some((item) => item.why.trim() === '')) {
        return fail('quality.doc', t('uiGates.kQualityDocUndeclared'), t('uiGates.kQualityDocRemedy'))
      }
      // 声明过质量属性（`quality/recorded` 事件）却一条场景都没有 ⇒ 判红并点名属性（AC-227）。
      const declared = declaredQualityAttributes(ctx)
      if (declared.length > 0) {
        return fail(
          'quality.doc',
          fmt('uiGates.kQualityDocTruthCleared', {
            p1: declared.map((item) => item.attribute).join(' '),
            p2: declared.map((item) => item.id).join(' '),
            p3: relative,
          }),
          t('uiGates.kQualityDocTruthClearedRemedy'),
        )
      }
      return na(
        'quality.doc',
        qualityEntries.length > 0 ? t('uiGates.kQualityDocNaDeclared') : t('uiGates.kQualityDocNaEmpty'),
      )
    }

    const path = join(ctx.workspace, ...relative.split('/'))
    if (!existsSync(path)) return fail('quality.doc', t('uiGates.kQualityDocMissing'), t('uiGates.kQualityDocRemedy'))
    const text = readFileSyncSafe(path)
    if (text === undefined) {
      return fail('quality.doc', fmt('uiGates.kQualityDocUnreadable', { p1: relative }), t('uiGates.kQualityDocRemedy'))
    }
    const declaredLang = parseRenderLang(text)
    if (declaredLang !== undefined && !LANGUAGES.includes(declaredLang)) {
      return fail('quality.doc', fmt('uiGates.kQualityDocLangUnknown', { p1: declaredLang, p2: LANGUAGES.join(' / ') }), t('uiGates.kQualityDocRemedy'))
    }
    const lang = declaredLang ?? locale()
    const missing = withLocale(lang, () => derivedDocSections('quality').filter((key) => !text.includes(t(key))))
    if (missing.length > 0) {
      return fail(
        'quality.doc',
        withLocale(lang, () => fmt('uiGates.kQualityDocIncomplete', { p1: missing.map((key) => t(key)).join('；') })),
        t('uiGates.kQualityDocRemedy'),
      )
    }
    const seq = parseRenderSeq(text)
    if (seq === undefined) return fail('quality.doc', t('uiGates.kQualityDocUnproven'), t('uiGates.kQualityDocRemedy'))
    const events = ctx.journal.read().events
    const maxSeq = events.at(-1)?.seq ?? 0
    if (seq < 1 || seq > maxSeq) {
      return fail('quality.doc', fmt('uiGates.kQualityDocSeqOutOfRange', { p1: String(seq), p2: String(maxSeq) }), t('uiGates.kQualityDocRemedy'))
    }
    // 渲染必须**可证**：该序号上真的发生过一次写这份文档的 `doc/rendered`（头里的数字不算证据）
    const renderEvents = events.filter(
      (event) => event.type === 'doc/rendered' && Number(event.data['seq']) === seq && String(event.data['doc'] ?? '') === relative,
    )
    if (renderEvents.length === 0) {
      return fail('quality.doc', fmt('uiGates.kQualityDocNoRenderEvent', { p1: String(seq) }), t('uiGates.kQualityDocRemedy'))
    }
    // 渲染之后真源又变过 ⇒ 陈旧
    const changed = events
      .filter((event) => event.seq > seq)
      .filter((event) => (QUALITY_DOC_SOURCE_EVENTS as readonly string[]).includes(event.type))
      .filter((event) => {
        const path = String(event.data['path'] ?? event.data['file'] ?? '')
        return path === '' ? true : isDerivedDocTruthPath('quality', path)
      })
    if (changed.length > 0) {
      const first = changed[0]
      return fail(
        'quality.doc',
        fmt('uiGates.kQualityDocStale', { p1: String(seq), p2: String(first?.seq ?? 0), p3: first?.type ?? '' }),
        t('uiGates.kQualityDocRemedy'),
      )
    }
    // ② 每条场景必须可度量（质量需求要能验收）
    const unmeasurable = scenarios.filter((scenario) => !isMeasurable(scenario))
    if (unmeasurable.length > 0) {
      return fail(
        'quality.doc',
        fmt('uiGates.kQualityDocUnmeasurable', { p1: unmeasurable.map((scenario) => scenario.id).join(' ') }),
        t('uiGates.kQualityDocUnmeasurableRemedy'),
      )
    }
    // ③ 整份文件必须等于"按头里的元信息重渲染"的结果（手改与伪造都堵在这里）
    const expected = withLocale(lang, () =>
      renderQualityDoc({
        project: ctx.project,
        scenarios,
        assessment,
        seq,
        phase: parseRenderPhase(text) ?? ctx.project?.phase ?? '',
      }),
    )
    const normalize = (value: string): string => stripTrailingNewlines(value.replace(/\r\n?/gu, '\n'))
    if (normalize(text) !== normalize(expected)) {
      return fail('quality.doc', t('uiGates.kQualityDocBodyMismatch'), t('uiGates.kQualityDocRemedy'))
    }
    return ok('quality.doc', fmt('uiGates.kQualityDoc', { p1: String(seq), p2: String(scenarios.length) }))
  },

  // —————————————— 增量 2：设计方法论方法包（结构化 / 面向对象 / 敏捷-演进式） ——————————————

  /**
   * 方法答案**必须能机械解析**成 `structured|oo|evolutionary|none`（含可多选）。
   *
   * 未回答 / 空答案 / 解析不出来 → **判失败** —— 这是增量 2 要堵的漏洞：
   * 不允许"不选方法就全 N/A 蒙过去"。只有**显式**选择 `none` 才合法。
   *
   * **2026-09-30 合并（C-26 → C-28 的唯一判据）**：此前另有一条 `design.method-chosen`
   * （"选择题已回答"）与它并存，于是同一个问题上回执出现**两条相关判据**，其中一条
   * 还更松（不校验答案能不能解析）。现在只保留本检查器：它的语义严格覆盖前者
   * （未回答 = reason 说明未回答 → 失败），流程数据里也只挂这一条。
   */
  'design.method-selected': (ctx) => {
    const selection = methodSelection(ctx.store)
    if (selection.status === 'chosen') {
      return ok(
        'design.method-selected',
        fmt('uiGates.kMethodSelectedOk', { p1: selection.methods.map((id) => methodLabel(id)).join(' + ') }),
      )
    }
    if (selection.status === 'none') return ok('design.method-selected', t('uiGates.kMethodSelectedNone'))
    return fail('design.method-selected', selection.reason, t('uiGates.kMethodSelectedRemedy'))
  },

  /**
   * 对**每个选中的包**逐条检查最小必产项；缺任一即失败。
   *
   * 三态：显式 `none` → N/A + 理由；未选中的包在 `detail` 里逐包写 N/A + 理由；
   * 方法未回答/非法 → 失败（查不到就算过是禁止的）。
   */
  'design.method-products': (ctx) => {
    const result = methodProducts(ctx.store, ctx.requirements, ctx.workspace)
    if (result.na) return na('design.method-products', result.naReason ?? '')
    return result.ok
      ? ok('design.method-products', result.detail)
      : fail('design.method-products', result.detail, t('uiGates.kMethodProductsRemedy'))
  },

  /**
   * **方法包的人审文档**（用户要求）：选中某包时，`docs/METHOD-<包>.md` 必须存在，
   * 且与台账一致 —— 文档头写 `<!-- method-doc: package=<包> basis=<指纹> -->`，
   * 指纹由插件按该包产物内容现算；台账一改指纹就变 → 旧文档判红（与 C-25 同口径）。
   * 正文还必须提到该包每个条目的 id（否则"文档"可能只是一段感想）。
   */
  'design.method-docs': (ctx) => {
    // 与 `design.method-products` 同源：选择状态现算（没回答/非法 → 该判据 N/A，由方法选择判据去报红）
    const selection = methodSelection(ctx.store)
    if (selection.status === 'none') return na('design.method-docs', t('uiMethod.selectionNone'))
    if (selection.status !== 'chosen') return na('design.method-docs', fmt('uiMethod.pkgUndecided', { p1: '', p2: selection.reason }))
    const packages = selection.methods
    if (packages.length === 0) return na('design.method-docs', t('uiMethod.selectionNone'))
    const problems: string[] = []
    const okLines: string[] = []
    for (const pkg of packages) {
      const label = methodLabel(pkg)
      const status = methodDocStatus(ctx.store, ctx.workspace, pkg)
      if (!status.exists) {
        problems.push(
          fmt('uiGates.kMethodDocMissing', { p1: label, p2: status.path, p3: status.expectedBasis, p4: methodDocHeader(pkg, status.expectedBasis) }),
        )
        continue
      }
      if (status.stale) {
        problems.push(fmt('uiGates.kMethodDocStale', { p1: status.path, p2: status.declaredBasis ?? t('uiGates.kMethodDocNoHeader'), p3: status.expectedBasis }))
        continue
      }
      if (status.missingIds.length > 0) {
        problems.push(fmt('uiGates.kMethodDocIncomplete', { p1: status.path, p2: status.missingIds.join(' ') }))
        continue
      }
      okLines.push(fmt('uiMethod.pkgDocOk', { p1: label, p2: status.path }))
    }
    if (problems.length > 0) return fail('design.method-docs', problems.join('；'), t('uiGates.kMethodDocRemedy'))
    return ok('design.method-docs', okLines.join('；'))
  },

  /** 选中包的产物之间不得自相矛盾（悬空引用 / DFD 流不在数据字典 / 依赖方向违规）。 */
  'design.method-consistency': (ctx) => {
    const result = methodConsistency(ctx.store, ctx.requirements)
    if (result.na) return na('design.method-consistency', result.naReason ?? '')
    return result.ok
      ? ok('design.method-consistency', t('uiGates.kMethodConsistencyOk'))
      : fail(
          'design.method-consistency',
          fmt('uiGates.kMethodConsistencyFail', { p1: result.problems.join('；') }),
          t('uiGates.kMethodConsistencyRemedy'),
        )
  },

  /**
   * 界面确认（§2.1 / §5）：**仅当「含 UI」判定为真**。
   *
   * 判定为假 → **N/A + 理由**（不是失败、也不是通过）。
   * 判定为真但视图为空/未确认 → **判失败**（该做没做）。
   * 判定每次都从需求真源现算（`uiDecision`），所以后期新增 UI 需求立刻翻真。
   */
  'ui.confirmed': (ctx) => {
    const decision = uiDecision(ctx.project, ctx.requirements)
    if (!decision.hasUi) return na('ui.confirmed', decision.reason)
    const result = uiConfirmation(ctx.store)
    if (result.ok) return ok('ui.confirmed', t('uiGates.kUiConfirmed'))
    const stale = new Set(result.stale)
    const problems = [...result.missing, ...result.unconfirmed.filter((target) => !stale.has(target))]
    const parts: string[] = []
    if (problems.length > 0) parts.push(fmt('uiGates.kUiMissing', { p1: problems.join(' ') }))
    // F-19：界面条目确认过但内容改了 → 与"从未确认"分开报。
    if (result.stale.length > 0) parts.push(fmt('uiGates.kUiMissingStale', { p1: result.stale.join(' ') }))
    return fail('ui.confirmed', parts.join('；'), t('uiGates.kUiRemedy'))
  },

  'plan.tasks': (ctx) => {
    const tasks = listTasks(ctx.store)
    if (tasks.length === 0) {
      return fail('plan.tasks', t('uiGates.k84'), t('uiGates.k85'))
    }
    // **DEF-055**：判据要看到**项目声明的文案面**（`plan.textPaths`），否则把"声明了但写范围不含"
    // 与"项目还没声明"报成同一句话（两种红的处置动作不同）。
    const issues = validatePlan(tasks, { textPaths: textPathsOf(ctx.store) })
    if (issues.length === 0) return ok('plan.tasks', fmt('uiGates.k86', { p1: tasks.length }))
    return fail(
      'plan.tasks',
      fmt('uiGates.k87', { p1: issues.map((issue) => `${issue.taskId}:${issue.detail}`).join('；') }),
      issues[0]?.remedy ?? t('uiGates.kFixCards'),
    )
  },

  'plan.testplan': (ctx) => {
    const cases = listTestCases(ctx.store)
    if (cases.length === 0) return fail('plan.testplan', t('uiGates.k88'), t('uiGates.k89'))
    const musts = ctx.requirements.filter((requirement) => requirement.priority === 'must')
    const uncovered = musts
      .filter((requirement) => !cases.some((testCase) => testCase.requirement === requirement.id))
      .map((requirement) => requirement.id)
    if (uncovered.length === 0) return ok('plan.testplan', fmt('uiGates.k90', { p1: cases.length, p2: musts.length }))
    return fail('plan.testplan', fmt('uiGates.k91', { p1: uncovered.join(' ') }), fmt('uiGates.k92', { p1: uncovered.join(' ') }))
  },

  /**
   * **实现阶段方法包已决定**（C-33 / C-83）：进构造阶段前必须跑过 `sdo_plan action=profile`。
   *
   * 三态口径与 `design.method-selected` 一致：**显式不选任何包**是合法 N/A（但必须写理由）；
   * profile **坏结构一律判红**（查不到就当过是禁止的）。
   */
  'construction.profile-decided': (ctx) => {
    const read = readConstructionProfile(ctx.store)
    if (read.status === 'invalid') {
      return fail('construction.profile-decided', read.problems.join('；'), t('uiGates.kConstructionProfileRemedy'))
    }
    if (read.status === 'missing' || read.profile === undefined) {
      return fail('construction.profile-decided', t('uiGates.kConstructionProfileMissing'), t('uiGates.kConstructionProfileRemedy'))
    }
    const profile = read.profile
    if (profile.packages.length === 0) {
      return na('construction.profile-decided', fmt('uiGates.kConstructionProfileOptOut', { p1: profile.reason }))
    }
    return ok(
      'construction.profile-decided',
      fmt('uiGates.kConstructionProfileOk', {
        p1: profile.packages.join(' + '),
        p2: profile.scope === 'all' ? 'all' : fmt('uiGates.kConstructionScopeTasks', { p1: String(profile.scope.length) }),
      }),
    )
  },

  /**
   * **范围内的卡满足所选包**（C-43 / C-84）：按**当前** profile 复核范围内**已完成**的卡。
   *
   * 用的是与 `claim`/`done` **同一套**检查器（现算）：开工侧"契约先冻结"（拿台账里那次认领的序号比）、
   * 收工侧"红→绿 / critical 变异 / 契约测试"。复议本身不追溯，但要放过历史卡请写**豁免**（有据可查）。
   */
  'construction.packages-satisfied': (ctx) => {
    const read = readConstructionProfile(ctx.store)
    if (read.status !== 'ok' || read.profile === undefined) {
      return na('construction.packages-satisfied', t('uiGates.kConstructionProfileNa'))
    }
    const profile = read.profile
    if (profile.packages.length === 0) {
      return na('construction.packages-satisfied', t('uiGates.kConstructionProfileNa'))
    }
    const scale = readProjectConfig(ctx.store).config.scale
    const inScope = listTasks(ctx.store).filter((card) => card.status === 'done' && scopeCovers(profile, card.id))
    const gaps: string[] = []
    // **`TASK-213` 落点二**：`claims` 逐卡读一次台账（N+1）⇒ 先读一次、循环里只过滤
    const claimEvents = ctx.journal.read().events.filter((event) => event.type === 'task/claimed')
    for (const card of inScope) {
      const claims = claimEvents.filter((event) => event.data.id === card.id)
      const claimSeq = claims[claims.length - 1]?.seq
      if (claimSeq !== undefined) {
        gaps.push(...claimGaps(ctx.store, ctx.journal, card, claimSeq, profile).map((item) => `${card.id}：${item.detail}`))
      }
      gaps.push(...doneGaps(ctx.store, ctx.journal, card, profile, { scale }).map((item) => `${card.id}：${item.detail}`))
    }
    return gaps.length === 0
      ? ok('construction.packages-satisfied', fmt('uiGates.kConstructionPackagesOk', { p1: String(inScope.length) }))
      : fail('construction.packages-satisfied', gaps.join('；'), t('uiGates.kConstructionPackagesRemedy'))
  },

  'tasks.all_done': (ctx) => {
    const stats = planStats(listTasks(ctx.store))
    if (stats.total === 0) return fail('tasks.all_done', t('uiGates.k93'), t('uiGates.k94'))
    if (stats.allDone) {
      // **D7**：dropped 卡本就没有证据，不得算进"完成但无证据"
      const missingEvidence = listTasks(ctx.store).filter(
        (task) => task.status !== 'dropped' && task.evidence.length === 0,
      )
      const droppedNote = stats.total === stats.active ? '' : t('gate.tasksDroppedNote').replace('{n}', String(stats.total - stats.active))
      return missingEvidence.length === 0
        ? ok('tasks.all_done', `${fmt('gate.tasksAllDone', { n: stats.active })}${droppedNote}`)
        : fail(
            'tasks.all_done',
            `${fmt('gate.tasksMissingEvidence', { ids: missingEvidence.map((task) => task.id).join(' ') })}`,
            t('gate.tasksMissingEvidenceRemedy'),
          )
    }
    // **DEF-049 / TASK-078 落点三**：只报"已阻塞 N"是不够的 —— `blocked` 卡**不会**自己回到派发
    // 队列（`readyTasks` 的准入只认 `planned`/`ready`），所以这条判据会一直红到**有人处置**。
    // 判红文案必须把数字与**处置动作**连起来（unblock / reassign / drop），否则读者只看到一个
    // 数字，不知道该做什么（真机上驾驶舱为此白走两轮）。
    const blockedIds = listTasks(ctx.store)
      .filter((task) => task.status === 'blocked')
      .map((task) => task.id)
    const blockedAdvice = blockedIds.length === 0
      ? ''
      : `\n${fmt('gate.tasksBlockedAdvice', { p1: String(blockedIds.length) })}`
    return fail(
      'tasks.all_done',
      fmt('gate.tasksIncomplete', {
        list: Object.entries(stats.byStatus)
          // **D7**：dropped 是显式放弃的终态，不是"未完成"
          .filter(([status]) => status !== 'done' && status !== 'verified' && status !== 'dropped')
          .map(([status, count]) => `${t(`taskStatus.${status}`, status)} ${count}`)
          .join('，'),
      }) + blockedAdvice,
      t('gate.tasksAllDoneRemedy'),
    )
  },

  'trace.coverage': (ctx) => {
    const data = report(ctx.store, ctx.requirements)
    const orphans = [...data.orphans.design, ...data.orphans.tasks, ...data.orphans.tests]
    // **N-3 / P-8**：同 `trace.orphans` —— 覆盖率也不得在坏行上判绿。
    const bad = traceBadLinesFailure(ctx, 'trace.coverage')
    if (bad !== undefined) return bad
    if (orphans.length > 0) return fail('trace.coverage', fmt('uiGates.k95', { p1: orphans.join(' ') }), t('uiGates.k96'))
    if (data.uncoveredMust.length > 0) return fail('trace.coverage', fmt('uiGates.k97', { p1: data.uncoveredMust.join(' ') }), t('uiGates.k98'))
    // **DEF-149** (TASK-167 A2): a req-tc edge proves a case EXISTS, not that it was verified.
    // Third state: must requirements whose linked cases have no "pass + adopted" result. Named as
    // `REQ-x<-TC-y` so the reader can go straight to the case. C-21 turning red here is the point.
    if (data.registeredButUnverified.length > 0) {
      return fail(
        'trace.coverage',
        fmt('uiGates.kCoverageUnverified', {
          p1: data.registeredButUnverified
            .map((item) => `${item.requirementId}<-${item.caseIds.join('/')}`)
            .join(' '),
        }),
        t('uiGates.kCoverageUnverifiedRemedy'),
      )
    }
    return ok('trace.coverage', fmt('uiGates.k99', { p1: Math.round(data.coverage * 100) }))
  },

  'tests.passed': (ctx) => {
    const stats = verificationStats(ctx.store, ctx.journal)
    if (stats.cases === 0) return fail('tests.passed', t('uiGates.k100'), t('uiGates.k101'))
    if (stats.results === 0) return fail('tests.passed', t('uiGates.k102'), t('uiGates.k103'))
    // **D4 硬化（整仓评审 major）**：结果必须有真源事件（`test/recorded`）佐证 ——
    // 旧实现只读 `tests/results/*.yml`，于是「手写一条 pass 的 YAML」（journal 零事件）就能把这条判据判绿，
    // 而 `recordTestResult(fail)` 之后把文件改成 pass 也查不出来。
    // 判据：
    //   ① journal 被坏行**截断** ⇒ 无法证明（可能只是记在坏行之后）⇒ 按"无法判定"判红（附修法，不假装绿）；
    //   ② 有结果文件却查不到事件 ⇒ 判红并点名，话术给出"用工具重记/重跑"的补救动作。
    // **R1（复审 major）**：文件状态 ≠ 真源事件状态 ⇒ 结果文件被改写（"把红改成绿"）⇒ 判红并点名
    if (stats.tampered.length > 0) {
      const list = stats.tampered.map((item) => fmt('uiGates.kTestsTamperedItem', { p1: item.id, p2: item.journal, p3: item.file })).join('; ')
      return fail('tests.passed', fmt('uiGates.kTestsTampered', { p1: list }), t('uiGates.kTestsTamperedRemedy'))
    }
    if (stats.unjournaled.length > 0) {
      if (ctx.journal.read().truncated) {
        return fail('tests.passed', fmt('uiGates.kTestsUnknown', { p1: String(stats.unjournaled.length) }), t('uiGates.kTestsUnknownRemedy'))
      }
      return fail(
        'tests.passed',
        fmt('uiGates.kTestsUnjournaled', { p1: String(stats.unjournaled.length), p2: stats.unjournaled.join(' ') }),
        t('uiGates.kTestsUnjournaledRemedy'),
      )
    }
    // **DEF-143** (0.1.6): only failures of REGISTERED cases may redden this criterion.
    // Orphan results (caseId not in the case registry) are variant-proving observations / history,
    // not case conclusions: counting them as failures makes this criterion permanently red with no
    // way to settle it (results are append-only and the write face rejects unknown caseIds).
    // Do NOT widen back: the red set is derived from stats.failedRegisteredCaseIds alone.
    if (stats.failedRegisteredCaseIds.length > 0) {
      return fail('tests.passed', fmt('uiGates.k104', { p1: stats.failedRegisteredCaseIds.join(' ') }), t('uiGates.k105'))
    }
    const unrun = listTestCases(ctx.store)
      .filter((testCase) => !listTestResults(ctx.store).some((result) => result.caseId === testCase.id))
      .map((testCase) => testCase.id)
    if (unrun.length > 0) return fail('tests.passed', fmt('uiGates.k106', { p1: unrun.join(' ') }), t('uiGates.k107'))
    // **`DEF-126`（TASK-157）**：**`skip` 不算「已覆盖」**。上一行只接住"完全没有结果"的用例，
    // 而"最新结果只是 `skip`"既不进 `failed` 也不进 `unrun` ⇒ 一条 must 用例一次都没真跑也照绿（假绿）。
    // 三面边界（DoD 逐字）：**不把 skip 判成 fail**（平台相关用例要能表达）、**不放宽 fail 面**、
    // 只要求它走 REQ-057 既有处置（`不可达` / `等价` + 理由）—— 没处置就逐条点名。
    // **DEF-145** (TASK-166): the skip face takes registered cases only. Orphan skip results
    // (caseId not in the case registry) are history/observations, not "an unhandled case".
    const skippedGaps = skippedCaseGaps(ctx.store, stats.skippedRegisteredCaseIds)
    if (skippedGaps.length > 0) {
      return fail(
        'tests.passed',
        fmt('uiGates.kTestsSkippedUnsettled', {
          p1: skippedGaps
            .map((gap) => fmt('uiGates.kTestsSkippedItem', { p1: gap.caseId, p2: gap.reason }))
            .join('; '),
        }),
        t('uiGates.kTestsSkippedRemedy'),
      )
    }
    // **REQ-053（TASK-039）**：「测试全过」不能只看"台账里有几条 pass" —— 开发者自己跑一遍自己盖章
    // 也是一条 `pass`。`verificationStats` 已经把"没被独立采纳的 pass"逐条列进 `unadopted`
    // （执行者缺登记 / 采纳者缺登记 / 采纳者就是执行者 / 判定基准缺或不成立），这里按 REQ-053 的降级口径
    // **不予计入 + 点名**：有未采纳的 pass ⇒ 判红并逐条点名（既有 `passed` 读数语义**不变**，
    // m52/m56/m85 仍按它断言；新的"已采纳"计数是 `passedAdopted`）。
    // **DEF-145** (TASK-166): same rule for the adoption face. `unadopted` stays the full reading;
    // only registered cases may redden this criterion (orphan results are not case conclusions).
    if (stats.unadoptedRegistered.length > 0) {
      return fail(
        'tests.passed',
        fmt('uiGates.kTestsUnadopted', { p1: String(stats.unadoptedRegistered.length), p2: stats.unadoptedRegistered.join(' ') }),
        t('uiGates.kTestsUnadoptedRemedy'),
      )
    }
    // **G-02**：判据描述承诺「全部 must REQ 有通过的测试用例」，实现却只数用例计数 ——
    // 于是"删掉一条用例"或"新增 must 需求"都不会让这条判据变红（假保证）。这里补上真覆盖校验。
    // **P-8**：同族判据的坏行前置检查也要有 —— 否则一旦 C-21 被豁免，这条就会在坏行上判绿。
    const bad = traceBadLinesFailure(ctx, 'tests.passed')
    if (bad !== undefined) return bad
    const trace = report(ctx.store, ctx.requirements)
    if (trace.uncoveredMust.length > 0) {
      return fail(
        'tests.passed',
        fmt('uiGates.k108', { p1: trace.uncoveredMust.join(' ') }),
        t('uiGates.k109'),
      )
    }
    // **REQ-049 AC-197/198 / REQ-017 的降级口径**：结果所绑产物被改动时，「该结果**与依赖它的覆盖读数**
    // 一并判过期并点名」—— 这条判据正是"依赖它的结论"（`tests.passed` 是 G6 唯一判"测试全过"的判据）。
    // 因此读数过期 / 不成立（缺报告、报告哈希不符、缺被测产物哈希、未达阈值…）时，这里一并判红并点名。
    //
    // 收窄（**有意**）：只在 `.sdo/testing/coverage.yml` **真有读数**时生效 ——
    //   · 没记过读数 ⇒ 不因此判红（"没记"与"记了但过期"是两件事，前者属覆盖真源本身的缺口）；
    //   · 逐条判定，**不许用整体达标掩盖个别项**（REQ-057 的同一纪律：这里是它的读数侧）。
    // 判定与人话都在 `coverage.ts`（`assessCoverageFromStore` / `describeCoverage` / `coverageRemedy`）——
    // 本文件被 i18n 棘轮钉在「零硬编码中文」，文案统一由那个模块给（同 `dor.acceptance_outline`）。
    const coverage = assessCoverageFromStore(ctx.store, ctx.workspace, listTestCases(ctx.store).map((item) => textOf(item.id)))
    if (coverage.readings.length > 0 && (coverage.outcome === 'stale' || coverage.outcome === 'invalid')) {
      return fail('tests.passed', describeCoverage(coverage), coverageRemedy())
    }
    // **REQ-053（TASK-039）**：走到这里 ⇒ `unadopted` 为空，`passedAdopted === passed`（都是"最新一条"口径）。
    // 报 `passedAdopted` 是把"读的是**已采纳**的通过数"写在回执上，读者不必再猜这个数字算不算独立验证过的。
    const passed = fmt('uiGates.k110', { p1: stats.cases, p2: stats.passedAdopted })
    // **DEF-143**: orphan results must be NAMED on the green path too — "cannot be resolved" is never
    // "all good". They do not redden the criterion, but swallowing them silently would be the exact
    // failure mode this project keeps paying for.
    if (stats.orphanResultCaseIds.length === 0) return ok('tests.passed', passed)
    return ok('tests.passed', `${passed}\n${fmt('uiGates.kTestsOrphanResults', {
      p1: String(stats.orphanResultCaseIds.length),
      p2: stats.orphanResultCaseIds.join(' '),
    })}`)
  },

  /**
   * **回归一等纪律**（REQ-052 / TASK-037，判据 `C-57`，四个流程的 G6）。
   *
   * `tests.passed` 问的是"我们测过了吗"，这一条问的是**"这一次改动之后，该重跑的东西重跑了吗"** ——
   * 判定与点名都在 `regression.ts`（TASK-019），本文件只把它的结论翻成门禁的三态
   * （见 `assessRegressionCriterion` 的注释）。
   */
  'regression.discipline': (ctx) => assessRegressionCriterion(ctx),

  /**
   * **缺陷追溯：孤儿缺陷**（REQ-058 / TASK-038，判据 `C-58`）。
   *
   * 缺陷此前**只可见不可拦**：`req-defect` 边能建、`orphans.defects` 能算、TRACE.md 也列，
   * 但门禁一个字都不判 ⇒ 缺陷长期不挂需求无人发现。这一条把"每条缺陷都要能回到一条**已基线**需求"
   * 钉成施工收口的一等纪律。
   *
   * 与 `trace.orphans`（C-21）的分工（**有意不合并**）：那条判"设计 / 任务 / 用例"三类孤儿，
   * 口径是"有没有需求来源"；这一条只管缺陷，且多两个必须一起看的因素 ——
   * 「边指向失效目标」（**有边 ≠ 有效**，AC-234）与「显式豁免」（AC-232：不计孤儿但必须列出）。
   * 两者都不动对方的实现：判定全在 `trace.ts` 的**唯一出口** `assessDefectLinks`，
   * 本检查器只做三件事，且每一件都是"翻译"而不是"再判一次"：
   *
   * | # | 这里做什么 | 依据 |
   * |---|---|---|
   * | ① | 现算缺陷追溯读数 | `assessDefectLinks(ctx.store, ctx.requirements)`（只读、不写盘） |
   * | ② | 翻三态 | `ok` / `empty` ⇒ 通过（empty 是"没有缺陷要挂"，**不是**"判不动"）；`unreadable` / `violations` ⇒ 判红 |
   * | ③ | 豁免清单**单列** | `defectLinksExemptionLines` —— 卡上落点三：合规豁免不得**静默**放过 |
   *
   * 两条硬约束：
   *   · **fail-closed**：`unreadable`（台账读不动）同样判红 —— "查不动"不许当"没问题"。
   *   · **文案不在本文件**：`gates.ts` 被 i18n 棘轮钉在「零硬编码中文」（`test/m7.test.ts` 的基线
   *     `src/domain/gates.ts: 0`），人话由 `describeDefectLinks` / `defectLinksRemedy` 产出、
   *     它们从语言包的 `uiTrace.*` 取 —— 与 `regression.discipline` / `tests.passed` 同款处置。
   */
  'trace.defect-links': (ctx) => {
    const assessment = assessDefectLinks(ctx.store, ctx.requirements)
    // 豁免清单**永远**跟进回执（通过与否都跟）：它是"放过"的证据，不是失败项的补充说明。
    const detail = [describeDefectLinks(assessment), ...defectLinksExemptionLines(assessment)].join('；')
    if (assessment.ok) return ok('trace.defect-links', detail)
    return fail('trace.defect-links', detail, defectLinksRemedy())
  },

  /**
   * **C-51 缺陷闭合**（waterfall/prototype/spiral 的 G6、agile 的 GI）。
   *
   * | # | 情形 | 期望 |
   * |---|---|---|
   * | ① | 阻塞级 + `wontfix`，免责依据（理由/批准人）**未齐备** | 判红并**点名 `DEF-id`** + 可执行修法 |
   * | ② | 阻塞级 + `wontfix`，另字段**齐备** | 放行，但回执**单列**「以 wontfix 放行的阻塞级缺陷」 |
   * | ③ | 非阻塞级 + `wontfix` | 语义不变（**不读**这两个字段）—— 不误伤 |
   * | ④ | 阻塞级 + `open` / `fixed` | 仍判红（原行为不变） |
   *
   * **DEF-038（TASK-063，用户 2026-10-13 裁定）**：旧口径把 `wontfix` 与 `closed` 一起排除在
   * "阻塞"之外 ⇒ 阻塞级缺陷标一个 `wontfix` 就让计数归零、本判据直接绿。语义从
   * 「放弃即不存在」改成「**放弃必须有人署名**」。
   * 过滤条件**只此一处**（`records.ts` 的 `blockerBreakdown`）—— 判据与读数共用同一个出口，
   * 免得像 DEF-038 那样两处各抄一份再各自漂移。文案不在本文件（`gates.ts` 被 i18n 棘轮钉在
   * 硬编码中文 0），全部走 `uiGates.*` 的 `t()` / `fmt()`。
   */
  // **DEF-075（第三批 §3.8）**：`fixed` 缺陷必须有**绑定的测试结论**（判据面缺的那条缺陷线）。
  // 归属 G6（用户裁决/驾驶舱建议）：测试结论是**验证阶段**的产物，与 `tests.passed` / `trace.coverage` /
  // `review.independent` 同属一族；不塞进 G7 —— 那会让 73 条历史缺陷一次性变成交付阻塞。
  'defects.fixed-tested': (ctx) => {
    // **`C-71` 外层作用域过滤（TASK-174）**：判定逻辑一字不动，只把**名单**收窄到本版作用域。
    // 本判据在 G6 上被判（作用域门禁），故 `ctx.versionScope` 有值；直接调检查器/非作用域门禁 ⇒ 原样全量。
    const missing = inScopeByVersion(ctx, fixedDefectsWithoutTestResult(ctx.store), (item) => item.id)
    if (missing.length === 0) return ok('defects.fixed-tested', t('uiGates.kFixedTestedOk'))
    const named = missing
      .map((item) => (item.failingResults.length === 0
        ? item.id
        : fmt('uiGates.kFixedTestedWithFail', { p1: item.id, p2: item.failingResults.join(' ') })))
      .join(' ')
    return fail('defects.fixed-tested', fmt('uiGates.kFixedTestedMissing', { p1: String(missing.length), p2: named }), t('uiGates.kFixedTestedRemedy'))
  },

  // **DEF-076（第四批 §3.3）**：`fixed` 缺陷在**拿到 pass 测试结论**之前/同时，必须有一条**已采纳**的
  // 评审点名它 —— 把用户的裁决「先评审、后测试」（`ADR-013`：`closed` = 已核实且已测试通过）变成机械后果。
  // 与 `C-65` **分工不重复**：`C-65` 管"有没有 pass 的 TR"，本条管"有没有核实过的评审"；同一条缺陷若
  // 两样都缺，只会被 `C-65` 点名一次（本条只对**已有 pass TR** 的那些判红）。
  // 归属同样在 G6（验证面）：它是**验证阶段**的产物序列问题，与 `defects.fixed-tested` 同族；
  // 不塞 G7 —— 那会与 `DEF-075` 一样把历史缺陷一次性变成交付阻塞（历史缺陷的补评审是**驾驶舱的活**）。
  'defects.fixed-reviewed': (ctx) => {
    // 作用域过滤同 `C-65`：口径不变，只收窄名单（`C-71` 的外层过滤）。
    // **`TASK-220`**：把门禁里**已经算好**的采纳表传下去（修前它会自己再折一遍整张表）
    const missing = inScopeByVersion(ctx, fixedDefectsWithoutAdoptedReview(ctx.store, ctx.journal, gateAdoptions(ctx)), (id) => id)
    if (missing.length === 0) return ok('defects.fixed-reviewed', t('uiGates.kFixedReviewedOk'))
    return fail(
      'defects.fixed-reviewed',
      fmt('uiGates.kFixedReviewedMissing', { p1: String(missing.length), p2: missing.join(' ') }),
      t('uiGates.kFixedReviewedRemedy'),
    )
  },

  // **DEF-033 第三面（第四批 §3.5）**：`unfrozen` 非空的卡 ⇒ 交付前必须有一次**全量绿**。
  // 归属 **G7 交付门禁**（`ADR-015`：按"交付前"的字面期限），**不在 G6 重复声明**
  // —— 同一概念两处判据是 `DEF-044` 的教训（G6 已有 `defects.fixed-tested` / `defects.fixed-reviewed`，
  // 那两条管"每条缺陷的依据"，本条管"局部收工之后有没有重新收成全局冻结"）。
  'defects.unfrozen-full-green': (ctx) => {
    const state = unfrozenFullGreenState(ctx.store, ctx.journal)
    if (state.cards.length === 0) return na('defects.unfrozen-full-green', t('uiGates.kUnfrozenFullNa'))
    if (state.satisfiedBy !== undefined) {
      return ok('defects.unfrozen-full-green', fmt('uiGates.kUnfrozenFullOk', {
        p1: state.satisfiedBy,
        p2: String(state.cards.length),
      }))
    }
    return fail(
      'defects.unfrozen-full-green',
      fmt('uiGates.kUnfrozenFullMissing', {
        p1: String(state.cards.length),
        p2: state.cards.map((card) => card.id).join(t('uiCollab.kListSep')),
        p3: state.lastDoneAt === '' ? t('uiGates.kUnfrozenFullNoTime') : state.lastDoneAt,
      }),
      t('uiGates.kUnfrozenFullRemedy'),
    )
  },

  'defects.closed': (ctx) => {
    const stats = verificationStats(ctx.store)
    // **`C-71` 外层作用域过滤（TASK-174）**：判定口径（`blockerBreakdown` / `isBlockerWaived`）一字不动，
    // 只是**名单**收窄到本版作用域 —— 本版明确不进（`nonScope`）或属于更晚版本的缺陷不在本版判红。
    // 绿侧那句"未关闭总计 {p1}"仍读全台账读数（`stats.defectsOpen`）：它是**信息性**计数，
    // 不是判定依据；作用域内的闭合情况由 `C-71` 逐类点名（本卡的落点二）。
    const breakdown = blockerBreakdown(inScopeByVersion(ctx, listDefects(ctx.store), (defect) => defect.id))
    if (breakdown.blocking.length > 0) {
      // 判红**必然点名**：缺哪一条依据要在名单里看得见，否则"补依据"这个动作无从下手。
      const named = breakdown.blocking
        .map((defect) => (defect.status === 'wontfix'
          ? fmt('uiGates.kDefectWaiveIncomplete', {
            p1: defect.id,
            p2: fmt('uiGates.kDefectWaiveFieldReason'),
            p3: fmt('uiGates.kDefectWaiveFieldApprover'),
          })
          : defect.id))
        .join(' ')
      return fail('defects.closed', fmt('uiGates.k111', { p1: named }), t('uiGates.k112'))
    }
    // 放行：但**以 wontfix 放行的那些要单列**（可见即约束）—— 清单为空时一个字都不加。
    const waived = breakdown.waived.length === 0
      ? ''
      : '\n' + t('uiGates.kDefectWaivedHeading') + '\n' + breakdown.waived
        .map((defect) => fmt('uiGates.kDefectWaivedLine', {
          p1: defect.id,
          p2: defect.waiveReason ?? '',
          p3: defect.waiveApprovedBy ?? '',
        }))
        .join('\n')
    return ok('defects.closed', fmt('uiGates.k113', { p1: stats.defectsOpen }) + waived)
  },

  /**
   * **已声明修复的缺陷必须闭合或署名放弃**（DEF-050 / TASK-072，判据 `C-63`）。
   *
   * 由来：缺陷（`.sdo/defects/*.yml`）与卡（`.sdo/tasks/*.yml`）是两本独立真源，此前
   * **没有任何地方**把"卡做完了"与"它要修的那条缺陷该闭合了"连起来 —— 卡完成 ⇄ 评审有
   * C-42/C-52、缺陷 ⇄ 需求有 C-58，唯独这条边缺失。实测两种后果都发生了：
   * ① 修复已落地的缺陷长期停在 `open`（DEF-004/005/006/009/022）；② 反向更危险 ——
   * 文档写"已修"而代码一字未动（DEF-008）。
   *
   * | # | 卡的状态 | 结论 |
   * |---|---|---|
   * | ① | 非 `done` / `verified` | **不参与**（卡还没做完时"缺陷还没修"是正常的 —— 不误伤） |
   * | ② | `done`/`verified` + `fixes` 为空集 | **不适用**（`na`）：这张卡没有声明修任何缺陷 |
   * | ③ | `done`/`verified` + 每条 `fixes` 都 `fixed`/`closed` | 绿 |
   * | ④ | `done`/`verified` + `wontfix` + 免责两字段齐备 | 绿，且回执**单列**署名放弃项 |
   * | ⑤ | 其余（`open`/`fixes` 空串…） | 判红并**逐条点名**（卡 id + 缺陷 id + 现状态 + 缺什么）+ 可执行修法 |
   *
   * 三条纪律：
   *   · **口径同源**：免责语义（两个字段 + 去空白非空）与 DEF-038 完全一致，复用 `collab.ts`
   *     的 `fixStatusRows`（判据与 `done` 回显共用同一个出口，免得像 DEF-038 那样两处各抄一份）。
   *     与 `isBlockerWaived` 的唯一差别是**不要求 `severity === 'blocker'`** —— C-51 只覆盖
   *     blocker，本判据要管的正是"已修未闭合的 major/minor 无限期沉在 open 里"。
   *   · **存量不追溯**：`fixes` 是本轮新增字段，新字段生效前建的卡读回来是**空集** ⇒ 命中 ②，
   *     不适用。本判据**没有**替全库核对过历史卡与历史缺陷的关系，那是另一件事。
   *   · **文案不在本文件**：`gates.ts` 被 i18n 棘轮钉在硬编码中文 0（`test/m7.test.ts`
   *     基线 `src/domain/gates.ts: 0`），人话全部走 `uiGates.kFix*`。
   */
  'details.fixes-closed': (ctx) => {
    const tasks = listTasks(ctx.store)
    const defects = listDefects(ctx.store)
    const rows: string[] = []
    const waived: string[] = []
    let checked = 0
    for (const task of tasks) {
      if (task.status !== 'done' && task.status !== 'verified') continue
      const declared = task.fixes ?? []
      if (declared.length === 0) continue
      for (const row of fixStatusRows(declared, defects)) {
        checked += 1
        if (row.closable) {
          if (row.status === 'wontfix') {
            waived.push(fmt('uiGates.kDefectWaivedLine', { p1: row.id, p2: row.waiveReason, p3: row.waiveApprovedBy }))
          }
          continue
        }
        rows.push(fmt('uiGates.kFixRowOpen', { p1: task.id, p2: row.id, p3: row.missing }))
      }
    }
    // **不误伤**：一条 `fixes` 声明都没有（存量卡全是这种）⇒ 判 N/A，不阻止放行、也不计入通过。
    if (checked === 0) return na('details.fixes-closed', t('uiGates.kFixNa'))
    if (rows.length > 0) {
      return fail('details.fixes-closed', fmt('uiGates.kFixUnclosed', { p1: rows.join('；') }), fixesRemedy())
    }
    const waivedBlock = waived.length === 0
      ? ''
      : '\n' + t('uiGates.kDefectWaivedHeading') + '\n' + waived.join('\n')
    return ok('details.fixes-closed', fmt('uiGates.kFixOk', { p1: String(checked) }) + waivedBlock)
  },

  /**
   * **声明消除的风险必须真的消除，或署名接受它仍开着**（DEF-051 / TASK-080，判据 `C-64`）。
   *
   * 由来（与 `C-63` 同族，只是换了一本台账）：风险（`.sdo/risks/RISK-*.yml`）此前是
   * **只进不退**的 —— 全库 7 条清一色 `open`，而 `risks.*` 系列判据**只在螺旋流程出现**，
   * waterfall 只在 G1 由 `feasibility.risks` 引用过一次 ⇒ **卡完成之后没有任何判据回头看风险状态**，
   * 且卡与风险之间**没有链接字段** ⇒ "一张就是为消除某风险的卡做完了、风险还是 open"没有任何地方说话。
   *
   * 本判据同时管四件事（都是同一形态：**卡面上声明了，却没有任何判据核对** —— 或核对得不对）：
   *
   * | 子句 | 对象 | 结论 |
   * |---|---|---|
   * | ① 风险 | 每张 `done`/`verified` 卡的 `mitigates` | 每条风险须 `mitigated`/`closed`，**或**卡上带一条两字段齐备的署名豁免 |
   * | ② 输出 | 完成卡 `outputs` 里**路径形态**的声明 | 每条须在该卡自己的 `artifact` 证据里出现 |
   * | ③ 输入 | 完成卡 `inputs` 里**路径形态**的声明 | 同上（两格此前**读了、也下发了**，却无人核对） |
   * | ④ 处置 | 两格里**非路径形态**的声明 | **不参与判据**，但**逐条回显**未参与的理由（不静默放过） |
   *
   * | # | 卡的状态 | 结论 |
   * |---|---|---|
   * | ① | 非 `done` / `verified` | **不参与**（卡还没做完时"风险还没关"是正常的 —— 不误伤） |
   * | ② | 完成卡但三格都空 | **不适用**（`na`）—— 这张卡没有任何声明 |
   * | ③ | 全部成立 | 绿，且**单列 open 风险清单**（可见即约束） |
   * | ④ | 其余 | 判红并**逐条点名**（卡 id + 风险 id / 声明的条目 + 现状态 + 缺什么）+ 可执行修法 |
   *
   * 三条纪律：
   *   · **口径同源**：豁免语义（`waiveReason` / `waiveApprovedBy` 去空白非空）与 DEF-038 / `C-63`
   *     逐字一致，复用 `collab.ts` 的 `mitigatesRows`（判据与 `done` 回显共用同一个出口）。
   *   · **形态判别，不是"恰好为空"**（DEF-064 / REV-043 发现 1 + 2）：子句 ②③ 只核对**路径形态**的
   *     声明（`collab.ts#isPathShapedDeclaration`：含 `/` 或形如 `name.ext`）；**非路径形态**的声明
   *     （散文职责、能力名、编号清单 —— 存量完成卡里真有，例如 TASK-001/TASK-007）**不参与判据**，
   *     但会**逐条回显**并写明未参与的理由（绿红两侧都回显，不静默放过、也不做存量数据迁移）。
   *     本判据**没有**替全库核对过历史卡与历史风险的关系，那是另一件事。
   *   · **文案不在本文件**：`gates.ts` 被 i18n 棘轮钉在硬编码中文 0（`test/m7.test.ts`），
   *     人话全部走 `uiGates.kMitigates*` / `uiGates.kDeclaredItem*`。
   */
  'details.mitigates-closed': (ctx) => {
    const tasks = listTasks(ctx.store)
    // 风险现读自台账（**不**用 `ctx.risks`）：注入的上下文可能来自更早的一次读盘，
    // 而本判据问的正是"此刻台账怎么说的"。
    const risks = listRisks(ctx.store)
    const rows: string[] = []
    // **显式处置回显**（DEF-064 落点二）：非路径形态的声明逐条回显 —— 它们不参与判据，
    // 但读者必须看得见"这几条没有被核过、以及为什么"。
    const prose: string[] = []
    let checked = 0
    let declared = 0
    for (const task of tasks) {
      if (task.status !== 'done' && task.status !== 'verified') continue
      const mitigates = task.mitigates ?? []
      const outputs = task.outputs ?? []
      const inputs = task.inputs ?? []
      if (mitigates.length === 0 && outputs.length === 0 && inputs.length === 0) continue
      declared += 1
      for (const row of mitigatesRows(mitigates, risks, task.mitigatesWaiver ?? [])) {
        checked += 1
        if (row.closable) continue
        // 先把"缺什么"取出来再进 `fmt`：写成内联的 `fmt(k, { p1: task.id, p2: row.id, p3: row.missing })`
        // 也可以，但 `test/m82.test.ts` 的占位符守卫按非贪婪正则取参数对象、在第一个 `)` 处截断 ⇒
        // 它会只看到 `p1` 而报"模板要 p2 p3，调用点只给 p1"的假红（那里确实是三个键，守卫看不见）。
        // 拆一步既不改变行为，也让守卫读得对。
        const missing = row.missing
        rows.push(fmt('uiGates.kMitigatesRowOpen', { p1: task.id, p2: row.id, p3: missing }))
      }
      const judged = declaredItemVerdict(task.id, { inputs, outputs }, task.evidence ?? [])
      checked += judged.judged
      rows.push(...judged.gaps)
      prose.push(...judged.prose)
    }
    // **不误伤**：三格一条声明都没有 ⇒ 判 N/A，不阻止放行、也不计入通过（此时没有回显可说）。
    if (declared === 0) return na('details.mitigates-closed', t('uiGates.kMitigatesNa'))
    // **open 风险清单**：无论绿红都印出来 —— 可见即约束（本缺陷的成因就是"没人回头看"）。
    const openRisks = risks.filter((risk) => risk.status === 'open')
    const openBlock = openRisks.length === 0
      ? ''
      : '\n' + fmt('uiGates.kMitigatesOpenRisks', { p1: openRisks.map((risk) => risk.id).join(' ') })
    // **未参与判据的声明**：绿红两侧都挂上去（只有真的没有这类声明时才为空）。
    const proseBlock = prose.length === 0
      ? ''
      : '\n' + t('uiGates.kDeclaredItemProseHeading') + '\n' + prose.join('\n')
    if (rows.length > 0) {
      return fail(
        'details.mitigates-closed',
        fmt('uiGates.kMitigatesUnclosed', { p1: rows.join('；') }) + proseBlock + openBlock,
        mitigatesRemedy(),
      )
    }
    return ok('details.mitigates-closed', fmt('uiGates.kMitigatesOk', { p1: String(checked) }) + proseBlock + openBlock)
  },

  'review.independent': (ctx) => {
    // **`TASK-220`**：评审表走记忆化视图（与门禁里其它判据读的是同一批 YAML）
    const reviews = listReviewsCached(ctx.store, ctx.journal)
    const tasks = listTasks(ctx.store)
    // **DEF-042**：判据按**会话 uuid** —— 材料是 `task/claimed` 事件里的会话（不看卡当前状态）。
    // **2026-10-21 收窄两条**（用户裁定）：只有「`pass` 自评 + 这张卡没有可依据的独立面」才判红；
    // 自我否定与"已被独立采纳评审覆盖"的自评进 `noted`（留痕、不判红）—— 判据**只在这里判一次**，
    // 两个桶一起拿（`DEF-044` 的教训：同一概念两处判据必然分叉）。
    /**
     * **`TASK-213` 落点二**：本判据要两次「全部评审的采纳态」（自评独立性 + 已采纳 pass 评审），
     * 修前各算一遍 ⇒ 同一份台账被解析两遍。
     * **`TASK-220`**：现在**只请求一次**（`gateAdoptions`：一次 `evaluateGate` 里至多一次真算），
     * 两次判定共用同一张表 —— 判据与文案一字未改。
     */
    const adoptions = gateAdoptions(ctx)
    const adoptedPassReviewIds = new Set(
      [...adoptions.values()]
        .filter((item) => item.state === 'adopted' && item.review.verdict === 'pass')
        .map((item) => item.review.id),
    )
    const audit = independenceAudit(reviews, tasks, claimedSessionsByCard(ctx.journal), adoptedPassReviewIds)
    const violations = audit.violations
    if (violations.length > 0) {
      return fail('review.independent', violations.map((item) => item.detail).join('；'), t('uiGates.k114'))
    }
    // **2026-10-08 口径**：评审「任务」完成不需要被评审，但**评审结果要被核实才能采纳** ——
    //   · `role === 'reviewer'` 的卡不在此列（与 SDO-35 / C-42 同一理由：评审卡自我递归没有意义）；
    //   · 其余完成卡的 `pass` 评审必须是**已采纳**的（每条发现都由实现会话核实过，评审与核实都能被真源佐证）。
    // **R-12**：不只排 `role === 'reviewer'`，还排掉**不产出产品工件**的卡（复核/代核/文书）。
    // 只排 role 的旧口径漏掉了"实质在做复核、却因 R-11 挂在 tester 下"的卡 ⇒ 它一 done 就要求自己被评审（自我递归）。
    const doneTasks = tasks.filter(
      (task) => (task.status === 'done' || task.status === 'verified')
        && task.role !== 'reviewer'
        && producesProductArtifacts(task),
    )
    // **`TASK-220`**：修前这里还有一次**同参** `reviewAdoptions(...)`（与上面那次完全一样）—— 合并掉
    const unreviewed: string[] = []
    const unadopted: string[] = []
    for (const task of doneTasks) {
      const pass = reviews.filter((review) => review.taskId === task.id && review.verdict === 'pass')
      if (pass.some((review) => adoptions.get(review.id)?.state === 'adopted')) continue
      if (pass.length === 0) {
        unreviewed.push(task.id)
        continue
      }
      unadopted.push(
        `${task.id}（${pass
          .map((review) => `${review.id}：${reviewAdoptionLabel(adoptions.get(review.id)?.state ?? 'unverified')}`)
          .join('，')}）`,
      )
    }
    // **G-1（sdo-test 2026-10-08 报告）**：两个桶**一起报** —— 旧实现先在 `unreviewed` 上提前 return，
    // 于是"有 pass 评审但永远采纳不了"的那几张卡被挡在身后（真机：22 张无评审的卡把 2 张死锁卡藏了）。
    if (unreviewed.length > 0 || unadopted.length > 0) {
      const parts: string[] = []
      const remedies: string[] = []
      if (unreviewed.length > 0) {
        parts.push(fmt('uiGates.k115', { p1: unreviewed.join(' ') }))
        remedies.push(t('uiGates.k116'))
      }
      if (unadopted.length > 0) {
        parts.push(fmt('uiGates.kReviewUnadopted', { p1: unadopted.join(' ') }))
        remedies.push(t('uiGates.kReviewUnadoptedRemedy'))
      }
      return fail('review.independent', parts.join('；'), remedies.join('；'))
    }
    // **G-2 可见性**：被采纳的 `pass` 评审里若有**老格式**（没有内容指纹）的，如实标注 ——
    // 否则"已采纳"会读成"已防篡改"，而老条目其实检出不了"改 verdict / 改正文"。
    const legacy = adoptedPassIds(doneTasks.map((task) => task.id), reviews, adoptions)
    return ok(
      'review.independent',
      fmt('uiGates.k117', { p1: reviews.length })
        + (legacy.length === 0 ? '' : '；' + fmt('uiGates.kReviewLegacyAdopted', { p1: legacy.join(' ') }))
        // **收窄两条**：被判绿时也要说清"另有几条自评只留痕"（否则读者会以为一条自评都没有）
        + (audit.noted.length === 0 ? '' : '；' + fmt('uiGates.kReviewSelfNoted', {
          p1: String(audit.noted.length),
          p2: audit.noted.map((item) => item.reviewId).join(' '),
        })),
    )
  },

  /**
   * **D9：中大卡在完成前就要有通过评审**（`size ≥ medium`）。
   *
   * 与 G6 的 `review.independent` 的分工：那条在**验证门禁**要求"所有完成卡都有 pass 评审 + 作者≠评审者"；
   * 这条把**大卡**的评审要求**提前到开发完成门禁**，小卡（trivial/small）不在 G5 被拦。
   * 两条的口径不冲突：G5 更早、更窄；G6 更晚、更全。
   */
  'review.required': (ctx) => {
    /**
     * **口径不在这里**（`TASK-195`）：考虑集（`size ≥ medium` / 非 `reviewer` / 产出产品工件）与
     * 采纳口径（`pass` 必须已被核实采纳）都搬进了 `collab.ts` 的 `pendingReviewBigCards` ——
     * 同一个函数**三处共用**：本判据、`sdo_task action=done` 的完成点硬拦截、状态块的「待评审中大卡」那一行。
     *
     * 为什么必须共用一个出口：`DEF-044` 的教训（同一概念两处判据必然分叉）在这里后果翻倍 ——
     * 完成点拦了、门禁却绿（或反之），真机上就会演变成"按哪条算"的争论。
     * 本文件只负责**渲染**（i18n 棘轮基线 0，一个中文字面量都不许加）。
     */
    // **`TASK-213` 落点二**：`pendingReviewBigCards` 内部已读一次台账。
    // **`TASK-220`**：修前这里还会「再读一次重算采纳表」（`:3035-3039`）—— 现在改用`gateAdoptions`里
    // 那一张表（同一代次、同一探针；一次门禁检查里至多真算一次），评审表也走记忆化视图。
    // **`REV-095` 必核四③（`TASK-279`）**：`pendingReviewBigCards(...)` 与 `gateAdoptions(ctx)` 各自
    // 还会 `read()` 一次（命中缓存也只是 stat），于是**这一条判据读两次台账**。现在**本条判定只读一次**：
    // 这一次读出来的事件既交给 `pendingReviewBigCards`（它不再读盘），也交给采纳表（同上）。
    const events = ctx.journal.read().events
    const set = pendingReviewBigCards(ctx.store, ctx.journal, events)
    if (set.considered.length === 0) return ok('review.required', t('uiGates.kWorkReviewNone'))
    const reviews = listReviewsCached(ctx.store, ctx.journal)
    const adoptions = gateAdoptions(ctx, events)
    const missing = set.missing
    const unadopted = set.unadopted.map(
      (row) => `${row.id}（${row.reviews.map((item) => `${item.id}：${reviewAdoptionLabel(item.state as never)}`).join('，')}）`,
    )
    if (missing.length > 0 || unadopted.length > 0) {
      const parts: string[] = []
      const remedies: string[] = []
      if (missing.length > 0) {
        parts.push(fmt('uiGates.kWorkReviewMissing', { p1: missing.join(' ') }))
        remedies.push(t('uiGates.kWorkReviewRemedy'))
      }
      if (unadopted.length > 0) {
        parts.push(fmt('uiGates.kReviewUnadopted', { p1: unadopted.join(' ') }))
        remedies.push(t('uiGates.kReviewUnadoptedRemedy'))
      }
      return fail('review.required', parts.join('；'), remedies.join('；'))
    }
    const legacy = adoptedPassIds(set.considered, reviews, adoptions)
    return ok(
      'review.required',
      fmt('uiGates.kWorkReviewOk', { p1: String(set.considered.length) })
        + (legacy.length === 0 ? '' : '；' + fmt('uiGates.kReviewLegacyAdopted', { p1: legacy.join(' ') })),
    )
  },

  'iteration.increment': (ctx) => {
    const current = readIteration(ctx.store)
    if (current === undefined) return fail('iteration.increment', t('uiGates.k118'), t('uiGates.k119'))
    const tasks = iterationTasks(ctx.store, current.number)
    if (tasks.length === 0) return fail('iteration.increment', fmt('uiGates.k120', { p1: current.number }), t('uiGates.k121'))
    // **D-20（sdo-test-new 2026-10-09，major）**：`dropped` **不算未完成**。
    // 旧实现只看"不是 done/verified"，于是**迭代内做过任何作废**都会让 C-80 永久判红，
    // 而卡一旦创建就带死 `iteration` 号、`drop` 不清除它、也没有"移出迭代"的动作 ⇒ 工具面无出路
    // （真机：6 张结构通道粒度产物被显式 drop，GI 直接卡死）。
    // 口径与 `readyTasks`（`plan.js`：`!== 'dropped'`）和 waterfall 的 C-40（"另有 N 张已显式放弃"）对齐。
    const unfinished = tasks
      .filter((task) => task.status !== 'done' && task.status !== 'verified' && task.status !== 'dropped')
      .map((task) => task.id)
    if (unfinished.length > 0) return fail('iteration.increment', fmt('uiGates.k122', { p1: unfinished.join(' ') }), t('uiGates.k123'))
    const dropped = tasks.filter((task) => task.status === 'dropped').length
    return ok(
      'iteration.increment',
      fmt('uiGates.k124', { p1: current.number, p2: tasks.length })
      // **如实报告**：作废了多少张要看得见（C-40 的写法："另有 N 张已显式放弃，不计入完成率"）
      + (dropped === 0 ? '' : fmt('uiGates.k124b', { p1: dropped })),
    )
  },

  'iteration.dod': (ctx) => {
    const current = readIteration(ctx.store)
    if (current === undefined) return fail('iteration.dod', t('uiGates.k125'), t('uiGates.k126'))
    if (textOf(current.goal).trim() === '') return fail('iteration.dod', t('uiGates.k127'), t('uiGates.k128'))
    const tasks = iterationTasks(ctx.store, current.number)
    const noEvidence = tasks.filter((task) => task.status === 'done' && task.evidence.length === 0).map((task) => task.id)
    if (noEvidence.length > 0) return fail('iteration.dod', fmt('uiGates.k129', { p1: noEvidence.join(' ') }), t('uiGates.k130'))
    const stats = verificationStats(ctx.store)
    if (stats.results === 0) return fail('iteration.dod', t('uiGates.k131'), t('uiGates.k132'))
    return ok('iteration.dod', fmt('uiGates.k133', { p1: current.number, p2: stats.results }))
  },

  'delivery.manifest': (ctx) => {
    const result = deliveryCompleteness(ctx.store, ctx.requirements, ctx.prototypeDir)
    if (result.ok) {
      // **R-22**：通过也要把 warnings 交出去（"带已知偏差通过"必须与"干净通过"在回执上区分开）
      return ok(
        'delivery.manifest',
        fmt('uiGates.k134', { p1: result.manifest?.id ?? '', p2: result.manifest?.artifacts.length ?? 0, p3: result.manifest?.acceptance.length ?? 0 }),
        result.warnings,
      )
    }
    return fail('delivery.manifest', result.problems.join('；'), t('uiGates.k135'))
  },

  'risks.conclusion': (ctx) =>
    ctx.riskConclusion === undefined
      ? fail('risks.conclusion', t('uiGates.k136'), t('uiGates.k137'))
      : ok('risks.conclusion', fmt('uiGates.k138', { p1: ctx.riskConclusion })),

  /**
   * **准出准则逐条现算（禁止加权）** —— TASK-017 / REQ-050，判据 `C-53`。
   *
   * 准则由**项目自己声明**（`.sdo/testing/plan.yml` 的 `exitCriteria`：准则 / 指标 / 阈值 / 范围），
   * 门禁在这里**逐条现算**并逐条点名。三条口径是这条判据的全部内容：
   *
   * | # | 口径 | 为什么 |
   * |---|---|---|
   * | ① | **逐条**判，不做任何合并 | "测够了没有"不许折算成一个总分：0 分项会被高分项盖住 |
   * | ② | 任一条不达标 ⇒ 整体不成立并**点名那一条** | 只说"覆盖不达标"等于把定位工作推回给人 |
   * | ③ | 声明里的 `weight` / `权重` / `score` / `得分` **原样报出但不进判定** | 加权求和正是 ① 要禁的合并形式；写了就得让作者看见"你写的权重没被采用"，而不是悄悄生效或悄悄丢掉 |
   *
   * 实测来源**有优先序**（不另造第二套测量）：
   *   · 优先**覆盖读数**（`coverage.yml` 的 `readings[]`）："八项齐备 / 报告哈希 / 产物哈希 / 过期"
   *     一律由 `coverage.ts`（TASK-016）判，本条判据**只读它的结论**（`outcome === 'ok'`），
   *     不重复实现那套核对；
   *   · 覆盖读数里没有同名准则时，回落**测试报告结论**（`report.yml` 的 `exitCriteria[]`：
   *     `measured` + `verdict`）；
   *   · 两处都找不到实测 ⇒ **判红（fail-closed）**：判不动不许判绿。
   *
   * 两来源**矛盾**（报告结论说 pass 而实测没到声明阈值，或反之）同样判红 —— 门禁不许"挑一个好看的来源"。
   */
  'exit.criteria': (ctx) => renderExitCriteria(assessExitCriteriaFromStore(ctx.store, ctx.workspace)),
}

// —————————————————————— 回归真源的**落盘闸门**（REQ-052 / TASK-037） ——————————————————————
//
// 为什么落在这里：`regression.ts`（TASK-019）是**只读判定层**（它明确声明"只读、不写盘"），
// 而回归真源 `.sdo/testing/regression.yml` 要靠人/工具写下来 —— 本卡的写范围里只有本文件能承载
// 这个出口，于是它落在门禁模块：判据读它、写它，口径各自只有一份。
//
// **形状校验不在本文件**（也不在本卡）：唯一的那一份在 `testingShapes.ts`（TASK-012）——
// `validateTestingSet` 逐字段校验 + `writeValidatedTestingSet` **校验通过才落盘**（非法形状一个字节都不写）。
// 本函数只是给 `regression` 这一类真源一个**具名出口**：调用方不必自己知道
// `{ class: 'regression', file: 'regression' }` 这对映射，回执也统一走形状报告（点名到字段）。
// 与 TASK-016 的 `coverage.yml` 走的是**同一个**闸门（`test/m35.test.ts` 的 M35-17 是那一侧的守卫）。

/**
 * 写 `.sdo/testing/regression.yml`（**形状合法才落盘**）。
 *
 * 语义完全由 `writeValidatedTestingSource` 决定（本函数不复制任何校验分支）：
 *   · 形状非法 / 判不动 ⇒ `ok: false`，**一个字节都不写**，`report.issues[].field` 点名到字段；
 *   · 形状合法 ⇒ 落盘（`root:` 单键包裹，与其它真源同形）并返回写后指纹；
 *   · `classes` 的落点由 `TESTING_SOURCE_FILES.regression` 给定（`.sdo/testing/regression.yml`）。
 *
 * ⚠️ **形状合法 ≠ 判定通过**：这一层只核"这份真源读不读得动"，"该跑的跑没跑、产物变没变"
 * 由 `assessRegressionCriterion`（判据 `C-57`）判 —— 两层分开，回执才说得出人话。
 */
export function writeRegressionSource(
  store: SdoStore,
  value: unknown,
  options: { known?: TestingShapeKnown | undefined; journal?: Journal | undefined; actor?: string | undefined } = {},
): TestingValidatedWriteResult {
  return writeValidatedTestingSource(store, { class: 'regression', file: 'regression', value }, options)
}

// —————————————————————— 准出准则：逐条现算（TASK-017 / REQ-050，判据 C-53） ——————————————————————
//
// 为什么判定逻辑放在本文件而不是新模块：本卡的写范围**只有**这五个文件，且 `gates.ts` 被 i18n
// 棘轮钉在「零硬编码中文」（`test/m7.test.ts` 的基线 `src/domain/gates.ts: 0`，本卡**不许放宽、
// 也不许把它摘掉**）。因此这里的做法是：**文案一律走 `uiGates.*` 语言键**（与既有判据同款），
// 本文件里只留标识、结构与人话之外的判定 —— 例如权重键名是**数据里的键名**（`weight` / `score` /
// 中文的「权重」「得分」），它们是"机械识别的标识"、不是面向用户的文案：前两个直接写，
// 后两个写 `\uXXXX` 转义（原因见 `EXIT_IGNORED_KEYS` 的注释：棘轮要 0、而 `en.yml` 又不许有中文）。
//
// 与 `coverage.ts`（TASK-016）的分工：那边判"**这条读数还算数吗**"（八项齐备 / 报告哈希 / 产物哈希 /
// 过期），这边判"**项目声明的准出准则达标了吗**"。本文件**不复用也不重写**那套核对，只读它的结论
// （`CoverageAssessment`）；本侧独有的只是"要比的阈值来自项目**自己声明的**那一条"（可能与读数自己的
// 阈值不同）—— 至于"怎么比"（解析 / 边界 / 一边带 `%` 一边不带）**没有第二份实现**：
// `meetsThresholdText` 从 `coverage.ts` 取（TASK-050 收敛，见 `exitVerdictFor` 的注释）。

/**
 * 权重类键名（**机械识别的标识**，不是面向用户的文案）：写在这些键下的内容一律**原样报出、不进判定**。
 *
 * ⚠️ **为什么中文键名写成 `\uXXXX` 转义（而不是直接写汉字、也不是放进语言包）**：
 *   · 本文件被 i18n 棘轮钉在「零硬编码中文」（`test/m7.test.ts` 的基线 `src/domain/gates.ts: 0`，
 *     本卡**不许放宽也不许摘掉**）—— 直接写汉字立即判红（实测 `2 !== 0`）；
 *   · 放进语言包也**不行**：`en.yml` 的守卫明确要求"en 里不得残留中文"（`m7.test.ts` §②），
 *     而键名表在两种语言下必须是**同一个值**（否则"什么算权重"会随界面语言变化）⇒ 实测判红
 *     `en.yml 里仍有中文：uiGates.kExitIgnoredKeys`。
 *   转义写法把这两条同时满足：运行时仍是那两个汉字（数据里写的 `权重:` 能被识别），
 *   而源码里一个 CJK 码点都没有（`countCjkLiterals` 扫描字符串字面量 ⇒ 0）。
 */
const EXIT_IGNORED_KEYS: readonly string[] = ['weight', 'score', '\u6743\u91cd', '\u5f97\u5206']

export type ExitCriterionVerdict = 'pass' | 'fail' | 'unmeasured'

/** 被**原样报出**、但不进判定的一处声明（`weight: 0.9`）。 */
export interface ExitIgnoredDeclaration {
  /** 来源（`.sdo/testing/plan.yml` / `report.yml` / 覆盖读数 id）。 */
  source: string
  /** 键名（原样，不改写）。 */
  key: string
  /** 取值（原样，不改写）。 */
  value: string
}

/** 一条准则的现算结论。 */
export interface ExitCriterionAssessment {
  id: string
  /** 准则（项目自己写的措辞）。 */
  criterion: string
  metric: string
  threshold: string
  scope: string
  verdict: ExitCriterionVerdict
  /** 实测来自哪里（覆盖读数 id / `report` / 空 = 找不到实测）。 */
  source: string
  /** 实测值（原样）。 */
  measured: string
  /** 判红 / 判不动的原因（**稳定码**：文案在语言包里）。 */
  reason: string
}

export interface ExitCriteriaAssessment {
  /** 声明了几条（一条都没有 ⇒ 下面 `passed` 必为 false）。 */
  declared: number
  criteria: ExitCriterionAssessment[]
  /** 整体是否成立：**每条**都 pass 且至少有一条。 */
  passed: boolean
  /** 逐条判红 / 判不动的准则 id（点名用；不许用整体结论掩盖个别项）。 */
  offenders: string[]
  /** 原样报出的权重 / 得分声明（**不进判定**）。 */
  ignored: ExitIgnoredDeclaration[]
  /** `coverage.ts` 的结论（读数侧的口径由它一份承担）。 */
  coverageOutcome: CoverageAssessment['outcome']
  /** 覆盖真源在不在盘上。 */
  coveragePresent: boolean
}

/**
 * 判定输入：**声明**（plan）+ 两个实测来源（覆盖读数判定结论 + 测试报告）。
 *
 * 形状故意取得松（`unknown`）：真源是手写 YAML，读出来可能是任何东西 —— 判不动要落在
 * `unmeasured` / `fail` 上，而不是让 `undefined.xxx` 把整条门禁抛掉。
 */
export interface ExitCriteriaInput {
  criteria?: unknown
  reportCriteria?: unknown
  coverage?: CoverageAssessment | undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordOf).filter((item): item is Record<string, unknown> => item !== undefined) : []
}

/** 取文本（数字 / 布尔也算：`score: 90` 要原样报出）。 */
function exitText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? textOf(value).trim() : ''
}

/**
 * 从**声明条目**里挑出权重 / 得分（原样报出、不进判定）。
 *
 * 只认上面那张键表：写在这些键下的内容一律不参与判定；没写就没有。
 */
function collectIgnored(source: string, item: Record<string, unknown>): ExitIgnoredDeclaration[] {
  const found: ExitIgnoredDeclaration[] = []
  for (const key of EXIT_IGNORED_KEYS) {
    if (item[key] === undefined) continue
    found.push({ source, key, value: exitText(item[key]) })
  }
  return found
}

/**
 * 实测的**裁定结果**：数值有没有达到**声明**的阈值（判不动 ⇒ `undefined`，调用方据此判红）。
 *
 * ⚠️ **不再自带一份 parse/compare（TASK-050 收敛）**：解析与比较的**唯一一份**在
 * `coverage.ts`（`parseMeasure` / `meetsThreshold`），由 `meetsThresholdText` 把两者合成一次调用，
 * 本模块**直接 import 用它**。理由：覆盖读数侧（`assessReading` 判 `measured-below-threshold`）与
 * 本侧判的是**同一件事** —— 两边各写一份就是"同一规则两处实现"，一处改了另一处不会跟着改
 * （本卡之前正是如此：旧注释写着"有意重复，因为 `coverage.ts` 不在写范围里"）。
 * 守卫在 `test/m35.test.ts` 的 M35-18：逐样本（边界 / 非法 / 缺阈值）比对两侧 verdict，
 * 并在源码面钉住"两侧都取同一个共享实现"，防止这份重复再长回来。
 */
function exitVerdictFor(threshold: string, measured: string): boolean | undefined {
  return meetsThresholdText(threshold, measured)
}

/**
 * 覆盖读数里与同名准则对应的那些读数（**结论**由 `coverage.ts` 给，这里只挑不判）。
 *
 * 为什么要连**不合格**的读数一起拿：只有"完全没记过读数"才是 `unmeasured`（判不动）。
 * 记了读数但 `coverage.ts` 判它不成立 / 过期（例如实测 70% 未达它自己的阈值 90%、或产物改动后
 * 读数过期）—— 那是**有实测、且实测不合格**，必须判红并**点名那条读数**，
 * 否则回执会把"读数不达标"说成"没找到实测"，把定位工作推回给人。
 */
function coverageReadingsFor(assessment: CoverageAssessment | undefined, criterion: string): CoverageReadingAssessment[] {
  if (assessment === undefined) return []
  return assessment.readings.filter((reading) => reading.criterion === criterion)
}

/**
 * **纯函数**判定：给定声明与两个实测来源，逐条现算（不读盘、不写盘）。
 *
 * 守卫用例（`test/m36.test.ts` 的 M36-13）拿它构造「同一声明 ± 权重」两版，断言
 * 逐条 verdict **逐字相同** —— 那是"禁止加权"的可观察形式。
 */
export function assessExitCriteria(input: ExitCriteriaInput): ExitCriteriaAssessment {
  const declared = recordsOf(input.criteria)
  const reported = recordsOf(input.reportCriteria)
  const coverage = input.coverage
  const ignored: ExitIgnoredDeclaration[] = []
  const criteria: ExitCriterionAssessment[] = []
  const usedReadings = new Set<string>()

  for (const item of declared) {
    // ① 权重 / 得分：原样报出，**不进**下面任何判定
    ignored.push(...collectIgnored('plan', item))

    const id = exitText(item.id)
    const criterion = exitText(item.criterion)
    const metric = exitText(item.metric)
    const threshold = exitText(item.threshold)
    const scope = exitText(item.scope)
    const base = { id, criterion, metric, threshold, scope }

    if (threshold === '') {
      criteria.push({ ...base, verdict: 'fail', source: '', measured: '', reason: 'threshold-missing' })
      continue
    }

    // ② 实测来源一：覆盖读数（结论由 `coverage.ts` 判：过期 / 不成立 / 判不动一律**不采信**）
    const readings = coverageReadingsFor(coverage, criterion)
    const reading = readings.find((item2) => item2.outcome === 'ok') ?? readings[0]
    if (reading !== undefined) {
      usedReadings.add(reading.id)
      ignored.push(...collectIgnored(reading.id === '' ? 'coverage' : `coverage:${reading.id}`, reading as unknown as Record<string, unknown>))
      if (reading.outcome !== 'ok') {
        // 记了读数但 coverage.ts 判它不成立 / 过期 / 判不动 ⇒ **不采信哪条读数、为什么**由它说了算，
        // 本条判据只按结论判红并点名那条读数（绝不重复实现"八项齐备 / 哈希 / 过期"的核对）。
        criteria.push({ ...base, verdict: 'fail', source: reading.id, measured: reading.measured, reason: `reading-${reading.outcome}` })
        continue
      }
      const met = exitVerdictFor(threshold, reading.measured)
      criteria.push({
        ...base,
        verdict: met === true ? 'pass' : 'fail',
        source: reading.id,
        measured: reading.measured,
        reason: met === true ? 'ok' : met === false ? 'below-threshold' : 'measure-unparsable',
      })
      continue
    }

    // ③ 实测来源二：测试报告结论（`measured` + `verdict`）；两来源矛盾按判红处理
    const fromReport = reported.find((item2) => exitText(item2.id) === id || (criterion !== '' && exitText(item2.criterion) === criterion))
    if (fromReport !== undefined) {
      ignored.push(...collectIgnored('report', fromReport))
      const measured = exitText(fromReport.measured)
      const verdict = exitText(fromReport.verdict).toLowerCase()
      const met = exitVerdictFor(threshold, measured)
      if (verdict === 'pass') {
        criteria.push({
          ...base,
          verdict: met === true ? 'pass' : 'fail',
          source: 'report',
          measured,
          reason: met === true ? 'ok' : met === undefined ? 'report-measure-unparsable' : 'report-conflicts',
        })
      } else if (verdict === 'fail') {
        criteria.push({ ...base, verdict: 'fail', source: 'report', measured, reason: 'report-fail' })
      } else {
        // 只写了实测、没给结论（或结论取值不在词表里）⇒ 按实测现算；算不出就判不动
        criteria.push({
          ...base,
          verdict: met === true ? 'pass' : 'fail',
          source: 'report',
          measured,
          reason: met === true ? 'ok' : 'report-no-verdict',
        })
      }
      continue
    }

    // ④ fail-closed：两处都没有这条准则的实测 ⇒ 判不动（不许判绿）
    criteria.push({ ...base, verdict: 'unmeasured', source: '', measured: '', reason: 'no-measurement' })
  }

  // 覆盖读数里"没被任何准则用上"的权重声明也要报出来（否则写在那儿的东西会凭空消失）
  for (const reading of coverage?.readings ?? []) {
    if (usedReadings.has(reading.id)) continue
    ignored.push(...collectIgnored(reading.id === '' ? 'coverage' : `coverage:${reading.id}`, reading as unknown as Record<string, unknown>))
  }

  const offenders = criteria.filter((item) => item.verdict !== 'pass').map((item) => item.id)
  return {
    declared: criteria.length,
    criteria,
    passed: criteria.length > 0 && offenders.length === 0,
    offenders,
    ignored,
    coverageOutcome: coverage?.outcome ?? 'unknown',
    coveragePresent: coverage?.present ?? false,
  }
}

/**
 * 走**真实接线**读一次判定输入：`.sdo/testing/plan.yml`（声明）+ `coverage.yml`（读数，判定由
 * `coverage.ts` 现算）+ `report.yml`（兜底结论）。
 *
 * 为什么用 `readTestingClass(store, 'plan')` 而不是自己拼路径：真源位置与根键只有
 * `testingStore.ts` 那一份映射表说了算（另造一套读法迟早与它分叉）。
 */
export function assessExitCriteriaFromStore(store: SdoStore, workspace: string): ExitCriteriaAssessment {
  try {
    const plan = readTestingClass(store, 'plan')[0]
    const report = readTestingClass(store, 'report')[0]
    const coverage = assessCoverageFromStore(store, workspace)
    const fromPlan = plan?.value.exitCriteria
    const fromReport = report?.value.exitCriteria
    return assessExitCriteria({
      ...(Array.isArray(fromPlan) ? { criteria: fromPlan } : {}),
      ...(Array.isArray(fromReport) ? { reportCriteria: fromReport } : {}),
      coverage,
    })
  } catch {
    // fail-closed：读不动就是"判不动"，一律落成 0 条声明 + 不许通过（绝不冒泡把整门打塌）
    return {
      declared: 0,
      criteria: [],
      passed: false,
      offenders: [],
      ignored: [],
      coverageOutcome: 'unknown',
      coveragePresent: false,
    }
  }
}

/**
 * 逐条结论的人话（三态 + 判红原因 + 实测来源），全部走 `uiGates.*` 语言键。
 *
 * 为什么"原因"要翻成人话而不是打印稳定码：回执是给人看的 —— 稳定码（`reading-stale`）
 * 留着做分类，人话由语言包给（同一份结论在 en 下也要读得懂）。
 */
function exitVerdictText(verdict: ExitCriterionVerdict): string {
  switch (verdict) {
    case 'pass':
      return t('uiGates.kExitVerdictPass')
    case 'fail':
      return t('uiGates.kExitVerdictFail')
    default:
      return t('uiGates.kExitVerdictUnmeasured')
  }
}

function exitReasonText(reason: string): string {
  const table: Record<string, string> = {
    ok: 'uiGates.kExitReasonOk',
    'threshold-missing': 'uiGates.kExitReasonThresholdMissing',
    'below-threshold': 'uiGates.kExitReasonBelowThreshold',
    'measure-unparsable': 'uiGates.kExitReasonMeasureUnparsable',
    'reading-stale': 'uiGates.kExitReasonReadingStale',
    'reading-invalid': 'uiGates.kExitReasonReadingInvalid',
    'reading-unknown': 'uiGates.kExitReasonReadingUnknown',
    'report-fail': 'uiGates.kExitReasonReportFail',
    'report-conflicts': 'uiGates.kExitReasonReportConflicts',
    'report-no-verdict': 'uiGates.kExitReasonReportNoVerdict',
    'report-measure-unparsable': 'uiGates.kExitReasonReportMeasureUnparsable',
    'no-measurement': 'uiGates.kExitReasonNoMeasurement',
  }
  const key = table[reason]
  return key === undefined ? reason : t(key)
}

function exitSourceText(source: string): string {
  return source === '' ? t('uiGates.kExitSourceNone') : source
}

/**
 * 把判定结论落成门禁判据（`GateCriterionResult`）。
 *
 * `ignored` 给了就把它**单独加成一行**（原样报出）—— 只加在**回执**上，不进判定，
 * 因此"± 权重"两版的 `detail` 仍逐字相同，而写了权重的人会在同一份回执里看到自己的权重与
 * 「未被采用」的明确说法（两条要求因此不冲突）。
 */
export function renderExitCriteria(assessment: ExitCriteriaAssessment, ignored?: readonly ExitIgnoredDeclaration[]): GateCriterionResult {
  const verdicts = assessment.criteria
    .map((item) => fmt('uiGates.kExitCriterionItem', {
      p1: item.id,
      p2: `${exitVerdictText(item.verdict)}（${exitReasonText(item.reason)}）`,
      p3: item.measured === '' ? '—' : item.measured,
      p4: exitSourceText(item.source),
    }))
    .join('；')
  const base = assessment.passed
    ? fmt('uiGates.kExitOk', { p1: assessment.declared, p2: verdicts })
    : fmt('uiGates.kExitFail', { p1: assessment.declared, p2: verdicts })
  const notice = (ignored ?? []).length === 0
    ? ''
    : fmt('uiGates.kExitWeightIgnored', {
        p1: (ignored ?? []).map((item) => `${item.source}:${item.key}（${item.value}）`).join('、'),
      })
  const detail = notice === '' ? base : `${base}；${notice}`
  if (assessment.passed) return ok('exit.criteria', detail)
  return fail('exit.criteria', detail, t('uiGates.kExitRemedy'))
}

/** G2 的 DoR 判据：**按"检查器键"取**，不按判据 id 硬编码匹配。 */
function dorCriterion(ctx: GateContext, id: string): GateCriterionResult {
  const dor = evaluateDor({
    project: ctx.project,
    requirements: ctx.requirements,
    questions: ctx.questions,
    risks: ctx.risks,
    redTeamExecuted: ctx.redTeamExecuted,
    redTeamDisabled: ctx.redTeamDisabled,
    signoff: signoffInput(ctx.store, ctx.journal, 'G2'),
    ...(ctx.approvedBy === undefined ? {} : { approvedBy: ctx.approvedBy }),
  })
  const found = dor.criteria.find((criterion) => criterion.id === id)
  if (found === undefined) {
    // 语言包/流程数据脱节：绝不"查不到就算过"
    return fail(id, fmt('uiGates.kDorCriterionUnknown', { p1: id }), t('uiGates.kGateUnknownRemedy'))
  }
  return {
    id,
    ok: found.ok,
    detail: found.detail,
    ...(found.remedy === undefined ? {} : { remedy: found.remedy }),
  }
}

/** 判定一个门禁。 */
/**
 * 判定一个门禁（**P-11：整条调用都不允许把异常抛给调用方**）。
 *
 * 为什么需要**外层**兜底：判据检查器只是读取真源的一部分 —— 判据之后的**形状提示收集**
 * （`collectShapeNotes`，F-21）同样要读全部手写真源。实测：把 `design/component.yml` 的缩进写坏，
 * `design.views` 检查器那条 try/catch 还没轮到，异常就在形状提示收集里抛了出来，
 * 于是 `evaluateGate` 直接冒泡 → **连 `office.status()` 的注入状态块都一起失败**。
 * 两层兜底各司其职：内层让"某一条判据查不动"只影响那一条（其余照常判定、信息最多），
 * 外层保证"无论哪里抛，都是一条可读的判红"。
 */
export function evaluateGate(process: ProcessDef, gateId: string, ctx: GateContext): GateEvaluation {
  try {
    return evaluateGateInner(process, gateId, ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const phase = gatePhase(process, gateId) ?? ctx.project?.phase ?? ''
    const detail = fmt('uiGates.kCheckerThrew', { p1: message })
    return {
      gate: gateId,
      phase,
      status: 'failed',
      at: new Date().toISOString(),
      criteria: [{ id: 'gate.internal', ok: false, detail, remedy: t('uiGates.kCheckerThrewRemedy') }],
      remedy: [t('uiGates.kCheckerThrewRemedy')],
    }
  }
}

function evaluateGateInner(process: ProcessDef, gateId: string, ctx: GateContext): GateEvaluation {
  const definition = gateDef(process, gateId)
  const at = new Date().toISOString()
  const phase = gatePhase(process, gateId) ?? ctx.project?.phase ?? ''

  if (definition === undefined) {
    return {
      gate: gateId,
      phase,
      status: 'failed',
      at,
      criteria: [
        {
          id: 'gate.unknown',
          ok: false,
          detail: fmt('uiGates.k139', { p1: process.id, p2: gateId }),
          remedy: fmt('uiGates.k140', { p1: process.gates.map((gate) => gate.id).join(' ') }),
        },
      ],
      remedy: [fmt('uiGates.k141', { p1: process.id, p2: gateId })],
    }
  }

  // **C-59（TASK-062）**：把**正在判定的门禁 id** 如实注入 —— 本判据同时挂在四个流程的多个门禁上
  // （waterfall/prototype/spiral 的 G6、agile 的 GI），"签哪个门禁"只能由引擎告诉它，不能靠猜。
  const checkerContext: GateContext = { ...ctx, gate: gateId }
  // **`C-71`（`REQ-063` / TASK-174）**：只有实现/验证/交付类门禁（`G4`/`G6`/`G7`）按**本版作用域**判定。
  // 两处动作都在"外层"，既有判据的语义一字不动：
  //   ① 注入 `versionScope`，让逐类判据把自己的**实体名单**收窄（`inScopeByVersion`）；
  //   ② 收窄 `requirements`，于是「must 需求必须有通过用例」这类判据只问**本版**的 must（`AC-266`）——
  //      而 G2 的 `coverage.uncovered` 仍然看见全基线（`AC-267` / `AC-275` 的另一侧，反例 `R11`）。
  const versionScope = isVersionScopedGate(gateId) ? versionScopeOf(ctx.store) : undefined
  if (versionScope !== undefined) {
    checkerContext.versionScope = versionScope
    checkerContext.requirements = ctx.requirements.filter((requirement) => versionScope.includes(textOf(requirement.id)))
  }
  // **`TASK-171`（原 `versionScopeCriteria` 已删）**：门禁判哪些判据**完全由流程数据决定** ——
  // 判据条目上的 `when` 是数据声明的激活条件（例如 `C-71` 的 `when: releases`），引擎只按它过滤，
  // 不认判据身份、也不再往数据之外**补**任何一条判据。
  // 为什么必须改成这样（`m32` 的原话）：判据只活在代码里、流程数据里没有它 ⇒
  // "这个门禁由哪些准则构成"这份数据是假的，而**判据没挂上就等于这条约束不存在**。
  const presence = releasePresenceOf(ctx.store)
  const activeDefs = definition.criteria.filter((criterion) => criterionActive(criterion, presence))
  const criteria: GateCriterionResult[] = activeDefs.map((criterion) => {
    const checker = CHECKERS[criterion.check]
    if (checker === undefined) {
      return fail(
        criterion.id,
        fmt('uiGates.k142', { p1: criterion.check }),
        t('uiGates.k143'),
      )
    }
    // **P-11**：检查器自己抛异常（典型来源：手写真源 YAML 写坏，`readYaml` 抛 `YamlSubsetError`）
    // 绝不能冒泡出去 —— 那会让**整条门禁说不出话**（`evaluateGate` 的调用方没有 try/catch），
    // 而 `office.status()` 的"待判定门禁"走同一条现算路径，于是连注入状态块都会一起失败。
    // 本项目纪律是"查不到不能算过"：转成**该判据判红 + 带上异常信息与补救**，其余判据照常判定。
    let result: GateCriterionResult
    try {
      result = checker(checkerContext)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(criterion.id, fmt('uiGates.kCheckerThrew', { p1: message }), t('uiGates.kCheckerThrewRemedy'))
    }
    // 三态：`ok: true` 通过 / `ok: false` 失败 / `na: true` 不适用（不阻止放行，也不计入通过）
    return { ...result, id: criterion.id }
  })
  // F-21：手写 YAML 的**形状提示**（列表/映射位置写成了别的形状、`dropped` 不是布尔）
  // 必须出现在**相关判据**的详情里 —— 否则作者改了 YAML 却只看到"判据不通过"，
  // 不知道是形状写坏了。按判据的 `check` 键匹配实体（编号在不同流程里不同）。
  //
  // **R-7 后半**：这一段在判据循环**之后**、且要读**全部**手写真源（`collectShapeNotes`）——
  // 之前它没有 try/catch，坏 YAML 会从这里冒泡到外层兜底，于是**整门塌成一条 `gate.internal`**
  // （实测 G3：14 条判据 → 1 条），与 remedy 承诺的"其余判据照常判定"正相反。
  // 现在形状提示查不动**只影响它自己**：判据照常逐条判定，并在相关判据的 detail 里写明"查不动"。
  let shapeNoteError: string | undefined
  const shapeNotesByCheck = new Map<string, FieldShapeNote[]>()
  for (const criterion of criteria) {
    // 用 `activeDefs`（而不是 `definition.criteria`）：被 `when` 过滤掉的判据不在判定里，
    // 而参与判定的每一条都**必须在数据里**（`TASK-171` 起引擎不再补充任何判据条目）。
    // 按 `activeDefs` 找才不会丢掉 `desc`/`check`（缺 `check` 会让形状提示静默跳过）。
    const defined = activeDefs.find((candidate) => candidate.id === criterion.id)
    if (criterion.desc === undefined && defined?.desc !== undefined) criterion.desc = defined.desc
    const check = defined?.check ?? ''
    if (!checkWantsShapeNotes(check)) continue
    try {
      let notes = shapeNotesByCheck.get(check)
      if (notes === undefined) {
        notes = collectShapeNotes(ctx.store)
        shapeNotesByCheck.set(check, notes)
      }
      const lines = shapeNoteLines(shapeNotesForCheck(check, notes))
      if (lines.length > 0) {
        criterion.detail = `${criterion.detail}；${fmt('uiGates.kShapeNote', { p1: lines.join('；') })}`
      }
    } catch (error) {
      // R-14：区分"查不动"与"判不过"，并把原始报错（含文件名）带出来
      shapeNoteError ??= error instanceof Error ? error.message : String(error)
      criterion.detail = `${criterion.detail}；${fmt('uiGates.kShapeNoteFailed', { p1: shapeNoteError })}`
    }
  }

  const waived = ctx.waivedGates.includes(gateId)
  // N/A **不算失败**（它对这个项目没有意义），但也**不写进通过数** —— 它自成一态。
  const allOk = criteria.every((criterion) => criterion.ok || criterion.na === true)
  const status = waived ? 'waived' : allOk ? 'passed' : 'failed'
  const remedy = criteria
    .filter((criterion) => !criterion.ok && criterion.na !== true)
    .map((criterion) => criterion.remedy ?? criterion.detail)
  return { gate: gateId, phase, status, at, criteria, remedy }
}

/** 已通过/已豁免的门禁集合（用于算"待判定门禁"与阶段推进）。 */
export function satisfiedGates(evaluations: Iterable<GateEvaluation>): Set<string> {
  const set = new Set<string>()
  for (const evaluation of evaluations) {
    if (evaluation.status === 'passed' || evaluation.status === 'waived') set.add(evaluation.gate)
  }
  return set
}

/**
 * 该事件是否算「会改 `DESIGN.md` 的真源变更」（C-25 的唯一判据，导出以便单测）。
 *
 * 三条口径（都由真机缺陷换来，缺一条就会误判）：
 *   · 类型不在 {@link DESIGN_DOC_SOURCE_EVENTS} 里 ⇒ 不算；
 *   · `trace/linked|unlinked` 按 `kind` 分流：施工期覆盖边（`req-task`/`req-tc`）不进文档（SDO-18）；
 *   · `truth/file-written` 按**路径**分流：只有设计文档真正渲染的那几个真源目录算（SDO-19 复审），
 *     手改构造/测试/成本类真源不再让文档判陈旧（报警疲劳）。缺 `docSource` 的旧事件回退到路径判定；
 *     路径也读不出 ⇒ **保守算作会改文档**（黑名单方向不变）。
 */
export function isDesignDocSourceEvent(event: { type: string; data?: unknown }): boolean {
  if (!(DESIGN_DOC_SOURCE_EVENTS as readonly string[]).includes(event.type)) return false
  if (nonDocTraceEdge(event)) return false
  if (event.type !== 'truth/file-written') return true
  const data = (event.data ?? {}) as { docSource?: unknown; path?: unknown }
  if (typeof data.docSource === 'boolean') return data.docSource
  return typeof data.path === 'string' ? isDesignDocTruthPath(data.path) : true
}

/** `trace/linked|unlinked` 且 `kind` 是施工期覆盖边（`req-task`/`req-tc`）⇒ 不进设计文档（SDO-18）。 */
function nonDocTraceEdge(event: { type: string; data?: unknown }): boolean {
  if (event.type !== 'trace/linked' && event.type !== 'trace/unlinked') return false
  const kind = (event.data as { kind?: unknown } | undefined)?.kind
  return kind === 'req-task' || kind === 'req-tc'
}

