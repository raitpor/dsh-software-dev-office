/**
 * SDO 门面：从"会话 / 工作目录"解析出项目，并把领域模块（需求、审讯、门禁、渲染）暴露给界面层。
 *
 * 设计对应：§4.4/§4.5（.sdo 布局）、§5（需求工程）、§7（阶段与门禁）、§9.1（工具能力）、§10.1（渲染）。
 *
 * 纪律：
 *   · 一切写入都经 `SdoStore`（路径沙箱 + 原子写）与 `Journal`（唯一真源）；
 *   · 投影（project.json）只是派生视图，随时可由 journal 重建（AC-006）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

import type { BoardRequirement } from './board/render.js'
import type { ProjectConfig, Settings } from './config.js'
import { defaultProjectConfig, readProjectConfig, writeProjectConfig } from './config.js'
import { listViews, upsertElement } from './domain/architecture.js'
import type { UpsertElementInput } from './domain/architecture.js'
import {
  DEFAULT_PUML_PATH,
  answerDesign,
  askDesignQuestions,
  assumeDesign,
  confirmDesign,
  confirmGaps,
  designDraft,
  grillDesign,
  listDesignQuestions,
  openDesignQuestions,
  plantUmlText,
  readUiView,
  renderDesignDoc,
  resolvePumlPath,
  staleConfirmations,
  uiConfirmation,
  uiDecision,
  writeDesignDoc,
  writePlantUml,
  writeUiView,
} from './domain/design.js'
import type { DesignDraft, GrillDesignInput, GrillDesignResult, StaleConfirmation } from './domain/design.js'
import {
  METHOD_TARGET,
  listMethodArtifacts,
  methodConsistency,
  methodProducts,
  methodSelection,
  refreshMethodSnapshot,
  writeMethodArtifact,
} from './domain/method.js'
import type {
  MethodArtifactInput,
  MethodConsistencyResult,
  MethodProductsResult,
  MethodSelection,
} from './domain/method.js'
import { listAdrs, recordAdr, supersedeAdr } from './domain/adr.js'
import type { RecordAdrInput } from './domain/adr.js'
import { contractDirectionAnomalies, contractFieldNotes, dropContract, listContracts, recordContract } from './domain/contracts.js'
import type { ContractDirectionAnomaly, ContractFieldNote, RecordContractInput } from './domain/contracts.js'
import { collectShapeNotes } from './domain/shapeNotes.js'
// **DEF-004**：`DECISIONS.md` / `QUALITY.md` 的渲染器与路径（与判据同一份映射）
import { derivedDocRelativePath, renderDecisionsDoc, renderQualityDoc } from './domain/derivedDocs.js'
import type { DerivedDocKind } from './domain/derivedDocs.js'
import { readBudgetChecked } from './integration/cost.js'
import type { FieldShapeNote } from './infra/scalar.js'
import { readAssessment, listScenarios, recordScenario, writeAssessment } from './domain/quality.js'
import type { RecordScenarioInput } from './domain/quality.js'
import { linkMany, renderTraceReport, report, unlink } from './domain/trace.js'
import { capacityPlan, independenceViolations } from './integration/orchestrator.js'
import { budgetAdvice, crossingTier, defaultBudget, describeBudgetLine, describeBudgetLineNoUsage, readCostSnapshot, summarize, usedRatio } from './integration/cost.js'
import type { Budget, BudgetChoice, CostSnapshot, UsageRow, UsageSummary } from './integration/cost.js'
import { addErrata, claim, reassign, release, report as reportTask, staleClaims, unblock, updateTask } from './domain/collab.js'
import { staleEntryGateOf } from './domain/entryGate.js'
import type { UnblockResult } from './domain/collab.js'
import type { ClaimInput, ClaimResult, ReportInput, ReportResult } from './domain/collab.js'
import { orphanLocks, claimMissing, reuseDeliveries as reuseDeliveriesOf } from './domain/dispatchHealth.js'
import type { ClaimMissing, OrphanLock, ReuseDelivery } from './domain/dispatchHealth.js'
import type { ScopeHold } from './domain/plan.js'
import { closeIteration, classifyNonDispatchable, scopeHeldTasks, scopeIntersections, decompose, dropDependents, dirtyScopeHolds, dropTask, dropTaskChecked, listTasks, readIteration, readyTasks, reopenTask, restoreTask, startIteration, structuralPlanOf, textPathsOf, validatePlan  } from './domain/plan.js'
import type { DropOutcome, LifecycleOutcome } from './domain/plan.js'
import type { DecomposeInput, DirtyRead, NonDispatchablePlan, PlanIssue, StaleGate } from './domain/plan.js'
import {
  listDefects,
  listReviews,
  listTestCases,
  packageDelivery,
  readManifest,
  recordDefect,
  recordReview,
  recordTestCase,
  recordTestResult,
  renderDelivery,
  updateDefect,
  verificationStats, listRuns, recordRun, type DefectUpdate, evidenceFreshness,
  orphanTestResults, reviewReproIssue, ReviewReproError} from './domain/records.js'
import type { RunInput, RunRecord } from './domain/records.js'
import type {
  DeliveryManifest,
  Defect,
  PackageInput,
  Review,
  TestCase,
  TestResult,
} from './domain/records.js'
import { createChange, listChanges, markChangeNoop, undigestedChanges as listUndigestedChanges } from './domain/change.js'
import { isDesignDocTruthPath } from './types.js'
import type { Release } from './types.js'
// **`TASK-171`（`DEF-162` 第①条）**：认领面的角色判定与合法形态文案 —— 与收口判据 `C-76` 共用**同一份**
// owner→角色口径（`claimCoverage.ts` 的 `ownerRoleOf`）：两份口径分叉正是 `DEF-044` 的教训。
import {
  COCKPIT_OWNER,
  OWNER_ROLE_FORMS,
  OWNER_SESSION_LENGTH,
  ownerClaimVerdict,
  ownerOf,
  ownerRoleOf,
  ownerSessionCollisions,
} from './domain/claimCoverage.js'
// **`TASK-171`（`TASK-176` 交接）**：发布计划层的写入口 —— 落盘与顺延留痕都必须在真源留痕
// （`release/written` / `release/deferred`），手写 YAML 的 `frozenBy: human` 核不到任何东西。
import { HUMAN_APPROVER, currentRelease, deferredIdsOf, listReleases, packageVersionOf, writeRelease } from './domain/release.js'
import { textOf } from './infra/scalar.js'
import { admitDispatch, foldPoolChildren, isStaleDispatch, rolePools, unresolvedBlock as findUnresolvedBlock } from './domain/pool.js'
import type { PoolAdmission, PoolChild, RolePool } from './domain/pool.js'
import type { UndigestedChange } from './domain/change.js'
import { renderHeader } from './infra/render.js'
import type { CreateChangeInput } from './domain/change.js'
import { evaluateDor, isEffectivelyOpen } from './domain/dor.js'
import type { DorResult } from './domain/dor.js'
import { assess, readFeasibility } from './domain/feasibility.js'
import type { AssessInput } from './domain/feasibility.js'
import { evaluateGate, requiredArtifactNames, satisfiedGates } from './domain/gates.js'
import type { GateContext } from './domain/gates.js'
import { ensureOutline, refreshOutlineIfPresent } from './domain/acceptance.js'
import { disposeIssue, listIssues, openIssue, openIssues } from './domain/issues.js'
import { exitGates, exitGatesFrom, gateDef, legalRollbackTargets, listProcessIds, loadProcess, nextPhase, pendingGate, phaseDef, phaseLabel } from './domain/process.js'
import { renderSignReviewDoc, renderSignReviewSummary, renderTestReportSignable } from './domain/reviewDoc.js'
// **C-59（TASK-062）**：签字时绑定报告内容指纹 ⇒ 读报告真源的两个既有入口（口径与判据同一份）
import { TESTING_SOURCE_FILES, docSourceFingerprint, readTestingFile } from './domain/testingStore.js'
import { writeTestingDoc } from './domain/testingRender.js'
import {
  diffPayloadIndex,
  payloadIndex,
  readReviewPayload,
  renderedDocReviewItem,
  reviewFingerprint,
} from './domain/reviewPayload.js'
import type { ReviewPayloadSection as SignReviewPayloadSection } from './domain/reviewPayload.js'
import type { SignReviewRecord } from './domain/reviewPayload.js'
import { canonicalArtifactOf } from './domain/reviewDoc.js'
import type { SignReviewArtifact, SignReviewCriterion, SignReviewDoc } from './domain/reviewDoc.js'
import {
  applicabilityLines,
  applicabilityState,
  confirmApplicability,
  draftApplicability,
  readApplicability,
} from './domain/applicability.js'
import { basisReplay, normalizeBasis, recordSignature, signoffInput, signatureState } from './domain/signature.js'
import { gateIdOf, gateLabel, fmt, textOrProcess, t } from './domain/i18n.js'
import type { RiskConclusion } from './domain/risks.js'
import { listRisks, logRisk, readConclusion, riskStats, updateRisk, writeConclusion } from './domain/risks.js'
import { answerQuestion, askQuestions, listQuestions, validateProposed, weakDimensions, writeProposedQuestions } from './domain/grill.js'
import type { AnswerInput, AskInput, ProposedQuestion } from './domain/grill.js'
import {
  baselineRequirements,
  captureRequirement,
  listRequirementIds,
  listRequirements,
  mergeAcceptance,
  readRequirement,
  sameAcceptance,
  scoringContext,
  updateRequirement,
  writeRequirement,
} from './domain/requirements.js'
import type { CaptureInput, UpdateInput } from './domain/requirements.js'
import { loadScoring, normalizeModelDimensions, scoreRequirement } from './domain/scoring.js'
import { Journal } from './infra/journal.js'
import { nextId } from './infra/ids.js'
import { renderSrs } from './infra/render.js'
import { readDirtyWorktree } from './infra/git.js'
import {
  commitWorktree,
  createWorktree as createGitWorktree,
  listWorktrees,
  mergeWorktree as mergeGitWorktree,
  pendingWorkOf,
  removeWorktree as removeGitWorktree,
  repoTopOf,
} from './integration/worktree.js'
import { SdoStore } from './infra/store.js'
import type {
  Adr,
  ChangeRequest,
  ChangeRollback,
  DesignApplicability,
  DesignConfirmation,
  GateSignature,
  Iteration,
  TaskCard,
  Contract,
  DesignElement,
  DesignView,
  QualityAssessment,
  QualityScenario,
  TraceReport,
  FeasibilityAssessment,
  GateEvaluation,
  GrillQuestion,
  MethodArtifact,
  MethodArtifactKind,
  MethodSnapshot,
  ProcessDef,
  RedTeamIssue,
  Requirement,
  RiskItem,
  Scale,
  SdoEventType,
  SdoProject,
  StructuralPlan,
  UiView,
} from './types.js'
import { SURFACES } from './types.js'
import type { ApplicabilityDraftInput, ApplicabilityState } from './domain/applicability.js'
import type { SignatureState } from './domain/signature.js'
import { methodDocStatus } from './domain/methodDocs.js'
import type { MethodDocStatus } from './domain/methodDocs.js'
import { recordWorkspaceChanges, unresolvedSeqs, readWorkspaceChanges} from './domain/workspaceChanges.js'
import {
  observationOf,
  readChildFaces,
  readChildObservations,
  recordChildFace,
  recordChildObserved,
} from './domain/dispatchFace.js'
import { EXECUTOR_DENIED_TOOLS, READ_ONLY_INSPECTION_TOOLS, attributeRole, capabilityGaps, claimedSessionsByCard, claimsBySession, listRoleCards, maskFingerprint, toolAllowList } from './domain/roles.js'
import { isRole } from './domain/plan.js'
import { readChildReportAt, writeChildReport, CHILD_REPORT_MIN_BYTES} from './domain/dispatchReports.js'
import { listDispositions, rehashReview, reviewAdoptions, verifyReviewFinding } from './domain/reviewVerification.js'
import type { RehashResult, ReviewAdoption, VerifyResult } from './domain/reviewVerification.js'
import type { DispatchFinished } from './domain/dispatchReports.js'
import {
  SCOPE_ALL,
  deadExemptions,
  readConstructionProfile,
  recordContractTest,
  recordMutation,
  validateDerivation,
  writeConstructionProfile,
} from './domain/construction.js'
import { CONSTRUCTION_CHECKS, CONSTRUCTION_PACKAGES } from './types.js'
import type { ConstructionPackage } from './types.js'
import type { ConstructionExemption, ConstructionProfile, ContractTestRecord, MutationRecord, ProfileRead } from './domain/construction.js'
import type { ChildFaceEntry } from './domain/dispatchFace.js'
import { claimBaseline } from './domain/collab.js'

/**
 * 该阶段是否是"架构/设计"阶段（增量 1 / §1.3 第 2 条）。
 *
 * 判据是**流程数据**而不是硬编码阶段名：该阶段的出口门禁里有 G3（架构门禁）。
 * 因此新增流程只要把 G3 放在某个阶段出口，注入块就会在那个阶段主动提示设计问题——
 * 不需要改代码、也不会误伤别的阶段。
 */
export function designPhaseOf(phase: string): boolean {
  for (const id of listProcessIds()) {
    const process = loadProcess(id)
    if (process === undefined) continue
    const definition = process.phases.find((item) => item.id === phase)
    if (definition !== undefined) return definition.exit.includes('G3')
  }
  return false
}

/**
 * 文本内容的 sha256（十六进制）。
 *
 * 与 `truthFileHash` 用**同一个算法**，但那份是"读盘现算"，这份是"按**实际写盘的那份内容**算" ——
 * §2.5b 要判的是"盘上这份还是不是我们上次渲染写下的"，所以两边必须对同一份字节算。
 */
function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** 旧台账的"已读"退化键：一笔无 `finishedSeq` 的旧登记按 `(子会话, 报告落点)` 顶一笔结算。 */
function reportKey(childSessionId: string, report: string): string {
  return `${childSessionId}|${report}`
}

/**
 * `gate/result` 的事件载荷（**M4**）。
 *
 * 旧实现用 `!criterion.ok` 过滤 `failed`，而 N/A 判据是 `ok:false, na:true`（放行逻辑认 `na`）——
 * 于是 journal 里出现"通过且失败"的**自相矛盾**记录（实测 G3：`status:"passed"` 且
 * `failed:["C-2C"]`，而 C-2C 实际是 N/A）。journal 是唯一真源（`project.json` 只是投影），
 * 后续任何审计都会据此误报。
 * 现在：`failed` **排除 N/A**，N/A 另列 `notApplicable`，并带上通过计数。
 */
function gateResultDetail(evaluation: GateEvaluation): Record<string, unknown> {
  // R-14：`unjudged` = 判据**没有逐条判定**（读真源失败）。有它时 `failed` 里的 id 不是
  // 流程数据里的判据，审计必须据此分辨"查不动"与"判不过"。
  const criteria = evaluation.criteria
  return {
    ...(evaluation.unjudged === true ? { unjudged: true } : {}),
    failed: criteria.filter((criterion) => !criterion.ok && criterion.na !== true).map((criterion) => criterion.id),
    notApplicable: criteria.filter((criterion) => criterion.na === true).map((criterion) => criterion.id),
    passed: criteria.filter((criterion) => criterion.ok).length,
  }
}

/** 门禁 id 归一：接受「立项门禁」这类中文名、`交付门禁（G7）` 这种带编号的全名，也接受 `G0` 标识。 */
export function normalizeGateId(input: string, process: ProcessDef): string {
  // **D1**：中文全名后面常带编号（工具说明里就是这么写的），先把括号里的编号抽出来。
  // 旧实现只认「标签本身」与短别名，于是 `交付门禁（G7）` 被原样当成门禁 id →
  // "流程 waterfall 里没有定义门禁 交付门禁（G7）"，而且这个原串还会被当作落盘文件名。
  const bracketed = /[（(]\s*(G\d+|GP|GI|GR)\s*[）)]/iu.exec(input)
  if (bracketed !== null) {
    const id = bracketed[1]!.toUpperCase()
    if (process.gates.some((gate) => gate.id === id)) return id
  }
  // 去掉括号部分后再按标签查一次（`交付门禁（G7）` → `交付门禁`）
  const bare = input.replace(/[（(][^）)]*[）)]/gu, '').trim()
  const byLabelBare = gateIdOf(bare)
  if (byLabelBare !== undefined && process.gates.some((gate) => gate.id === byLabelBare)) return byLabelBare
  const byLabel = gateIdOf(input)
  if (byLabel !== undefined && process.gates.some((gate) => gate.id === byLabel)) return byLabel
  const trimmed = input.trim().toUpperCase()
  const alias =
    trimmed === '立项' ? 'G0'
    : trimmed === '可行性' ? 'G1'
    : trimmed === '需求基线' || trimmed === '基线' ? 'G2'
    : trimmed === '架构' ? 'G3'
    : trimmed === '计划' || trimmed === '详细设计' ? 'G4'
    : trimmed === '开发完成' || trimmed === '开发' ? 'G5'
    : trimmed === '验证' ? 'G6'
    : trimmed === '交付' ? 'G7'
    : input.trim()
  return process.gates.some((gate) => gate.id === alias) ? alias : input.trim()
}

/** 当前项目所用的流程定义（数据缺失即报错——随包数据不该缺）。 */
export function processOfProject(project: SdoProject | undefined): ProcessDef {
  const fallback = loadProcess('waterfall')
  const process = loadProcess(project?.process ?? 'waterfall') ?? fallback
  if (process === undefined) throw new Error('sdo: 随包流程数据缺失（src/data/processes/waterfall.yml）')
  return process
}

/**
 * 当前阶段的**待判定**出口门禁：出口门禁里第一个"当前不通过"的（已通过/已豁免的不算）。
 *
 * **统一的调用口径（勿绕过）**：`evaluations` 必须是 `evaluateGate` 的**现算**结果，
 * 不能喂 `gates/*.json` 的判定留痕 —— 留痕是审计记录，真源变坏之后它仍然是 `passed`，
 * 于是状态块会显示"门禁都过了"而 `advance` 当场拦人（D2 之后两者判据必须同源）。
 * 现算结果**不落盘**：判定的留痕只由 `checkGate` / `advance` 写，算"待判定门禁"不产生副作用。
 */
export function pendingGateOf(
  project: SdoProject | undefined,
  evaluations: () => Iterable<GateEvaluation>,
): string | undefined {
  if (project === undefined) return undefined
  const process = processOfProject(project)
  return pendingGate(process, project.phase, satisfiedGates(evaluations()))
}

export interface InitOptions {
  name?: string | undefined
  process?: string | undefined
  scale?: Scale | undefined
  scopeIn?: string[] | undefined
  scopeOut?: string[] | undefined
  stakeholders?: string[] | undefined
  metricsSuccess?: string[] | undefined
  glossary?: Record<string, string> | undefined
  surfaces?: string[] | undefined
}

export interface InitResult {
  project: SdoProject
  created: boolean
  dataDir: string
}

/** 项目台账更新（设计 v0.9 §9.1：第 19 个工具 `sdo_project`）。 */
export interface ProjectUpdateInput {
  name?: string | undefined
  process?: string | undefined
  scale?: Scale | undefined
  scopeIn?: string[] | undefined
  scopeOut?: string[] | undefined
  stakeholders?: string[] | undefined
  metricsSuccess?: string[] | undefined
  glossary?: Record<string, string> | undefined
  /** 项目级界面面（§2.1）：web / desktop / mobile；给出即覆盖，空数组不生效 */
  surfaces?: string[] | undefined
}

export interface ProjectUpdateResult {
  project: SdoProject
  /** 本次实际写入的字段名；为空表示"什么都没改" */
  changed: string[]
}

export interface ProjectCounts {
  requirements: number
  questions: number
  openQuestions: number
  gates: number
  evidence: number
}

export interface StatusSnapshot {
  dataDir: string
  project: SdoProject | undefined
  rebuilt: boolean
  truncated: boolean
  badLine?: number | undefined
  counts: ProjectCounts
  config: ProjectConfig
  configSource: 'file' | 'default'
  pendingGate: string | undefined
  /** 最近一次门禁判定（无记录时 undefined） */
  lastGate: GateEvaluation | undefined
  /** 本圈风险结论（螺旋流程用） */
  riskConclusion: string | undefined
  /** 风险统计（门禁 G1/GR 与状态块用） */
  risks: { total: number; open: number; blockers: number; high: number }
  /** 未闭环红队议题数 */
  openIssues: number
  /** 可行性结论 */
  feasibilityVerdict: string | undefined
  /** 变更请求数 */
  changes: number
  /** 成本行（只有设了预算才出现；没设 total 时只报已消耗） */
  costLine?: string | undefined
  /** 超预算提示（不硬停，只提醒） */
  budgetAdvice?: string | undefined
  /** 工作区未知（既无会话 cwd 也无 agent cwd）：**友好降级**，不抛错、不读外部目录 */
  workspaceUnknown?: boolean | undefined
  /**
   * **R-7**：读真源失败时的降级说明（含文件名）。
   *
   * 出现它就说明这份快照**不是**从真源算出来的 —— 注入块/`sdo_status` 必须显式说出来，
   * 绝不能让它看起来像"门禁都过了"（`pendingGate` 同时被设成最保守值）。
   */
  truthError?: string | undefined
  /**
   * 未决的**设计**问题数（增量 1 / §1.3）。架构阶段要据此主动提示
   * 「有 N 个待你确认的设计问题」——不让模型静默推进。
   */
  openDesignQuestions?: number | undefined
  /**
   * **待核实的评审**（2026-10-08 口径）：评审结果不会被自动采纳 —— 要由该卡的**实现会话**
   * 逐条核实（`reproduced` / `refuted`）后才算数。状态块每轮如实列出，别让"有评审但没核实"
   * 看起来像"没有评审"（那是两种不同的红）。
   */
  pendingReviewVerifications?: { count: number; ids: string[] } | undefined
  /**
   * **N-11（R-16② 的折中）**：已核实**成立**（`reproduced`）的评审发现。
   *
   * 为什么要有：R-16② 指出「`verify-review` 只给评审盖章，没有任何机制保证成立的发现被处置」——
   * 自动开修复卡会替人做范围决定（不做），但**静默躺着**是真风险。这里只做**状态化披露**：
   * 每轮把「已核实成立」的条数点出来，让「核实不是终点」在模型动手之前就可见；
   * **不声称**它们未被处置（插件判不出来），只提醒处置要落到改动或明确不修。
   */
  reproducedFindings?: { count: number; items: string[] } | undefined
  /** 当前阶段是否已进入"架构/设计"语境（按流程阶段 id 判断，不看项目类型） */
  designPhase?: boolean | undefined
  /**
   * 设计适用性声明给用户看的渲染行（§7.1「不得静默」的**注入块**那一处）。
   *
   * 未起草声明时给出"尚未声明"的提示 —— 存量项目（§7.5）就靠它被提醒去补声明。
   */
  applicabilityLines?: string[] | undefined
  /** 声明是否已由用户签字绑定（注入块据此提醒"还差签字"） */
  applicabilityConfirmed?: boolean | undefined
  /** G3 签字状态（设计阶段注入块据此提醒"等待用户签字确认"） */
  gateSigned?: boolean | undefined
}

/** 一次工具/命令调用携带的上下文。 */
/**
 * **顺延留痕的入参**（`TASK-171` / `AC-277`）。
 *
 * 五个字段都是判据要读的：`ids`（哪些条目被顺延）、`fromVersion` / `toVersion`（从哪版到哪版）、
 * `deferCount`（第几次：与上限比）、`approvedBy`（只认 human）。`reason` 供人复核，判据不解析它。
 */
export interface ReleaseDeferInput {
  ids: string[]
  /** 登记这次顺延的那一版；留空 ⇒ 取当前 release 的包版本。 */
  fromVersion?: string | undefined
  /** 顺延目标版本；目标未在册时留空（不许凭空造版本号）。 */
  toVersion?: string | undefined
  deferCount: number
  /** 批准人：只认 `human`（`ADR-022` 裁决①）。 */
  approvedBy: string
  reason: string
}

export interface OfficeCall {
  sessionId?: string | undefined
  /**
   * 本次调用的工作目录（由工具/命令层从 agent 上取，最可靠）。
   * 有它就优先用它——**绝不**跨会话猜。
   */
  cwd?: string | undefined
  /**
   * 宿主 agent 的不透明引用：只用于 plan mode 适配器（`planMode.get/set(agent)`），
   * office 自身不解读它。
   */
  agent?: unknown
}

/** 门禁判定结果（工具层用）。 */
export interface BaselineOutcome {
  ok: boolean
  dor: DorResult
  baselined: Requirement[]
  gate?: GateEvaluation | undefined
  /**
   * **N-9**：被拦住时把门禁的**现算结果**也交出去。
   *
   * B1 让 G2 从"7 条硬编码"变成"8 条真判定"，但失败分支只回 DoR —— 于是 DoR 7 条全绿、
   * C8（红队议题未闭环）判红时，回执显示"❌ 基线未通过 + 7 条全 ✅"，**没有任何原因和 remedy**。
   */
  evaluation?: GateEvaluation | undefined
  /**
   * **R-2（sdo-test-new 2026-10-08，minor）**：本次是否**真的**写了 `phase/entered`。
   *
   * D-6 修好"不重放阶段转移"之后，回执尾行还是**无条件**印「据 `phase/entered` 事件进入 architecture」
   * ⇒ 刚修好的结论被同一份回执讲反。渲染必须按这个字段说实话。
   */
  phaseEntered?: boolean | undefined
  /** 本次调用之后项目所处的阶段（`phaseEntered=false` 时回执要如实说"当前阶段仍是它"） */
  phase?: string | undefined
}

const REJECT_KEY: Record<string, string> = {
  empty: 'redteam.fileEmpty',
  tooShort: 'redteam.fileTooShort',
  tooLong: 'redteam.fileTooLong',
  notQuestion: 'redteam.fileNotQuestion',
  noKeyword: 'redteam.fileNoKeyword',
  duplicate: 'redteam.fileDuplicate',
}

/**
 * `.sdo/evidence/file-history/` 里**每个真源**最多保留的旧稿份数（§2.5a，第二轮整体评审）。
 *
 * 为什么要有上限：这份快照是"直接 `write`/`edit` 覆盖真源"的最后一道可恢复副本，但它**不是真源**、
 * 也没人读 —— 不设上限就会随直写次数无界增长（真源本身很小，但一次重写就是一份全量副本）。
 * 20 份足够覆盖"发现改坏了、回头找上一版"的实际窗口；同一个真源更早的旧稿按时间从最旧删起。
 */
export const FILE_HISTORY_KEEP = 20

export class SoftwareDevOffice {
  /** 会话 → 工作目录。多会话并存在不同目录时也不会串。 */
  private readonly cwdBySession = new Map<string, string>()

  constructor(readonly settings: Settings) {}

  /** 记录会话的工作目录（由 `session/created` 事件驱动）。 */
  noteSession(sessionId: string, cwd: string | undefined): void {
    // 只记录"会话 → cwd"的映射；**不再保留"最近活跃会话"**（那是跨会话串味的源头）
    if (typeof cwd === 'string' && cwd !== '') this.cwdBySession.set(sessionId, cwd)
  }

  /**
   * 供**提示注入**这类"没有显式调用者"的入口定位上下文。
   *
   * `systemPrompt.context` 的取数回调只拿到 `AssembleContext.scope`（没有 agent/session），
   * 因此这里**只认作用域**：
   *   · 作用域能对上已登记的会话 → 用那个会话的工作区；
   *   · 对不上 → 返回空上下文，由 `workspaceFor` 落到**进程 cwd**（宿主启动时的工作区）。
   * 绝不以"最近活跃会话"兜底 —— 那会让 A 会话的状态块读 B 的工作区。
   */
  callForScope(scope: unknown): OfficeCall {
    if (scope === undefined || scope === null) return {}
    const key = String(scope)
    return this.cwdBySession.has(key) ? { sessionId: key } : {}
  }

  /**
   * 解析本次调用应当作用的**工作目录**。
   *
   * 优先级：显式 > 本次调用携带的 cwd（取自 agent.cwd）> 本会话记录的 cwd > **进程 cwd（只看本层）**。
   *
   * **DEF（真机实测）**：曾经加过"从进程 cwd 向上查找含 `.sdo/` 的目录"作为兜底 —— 那会命中
   * **上层目录里别的项目**（实测 `~/.sdo/` 让所有在 `$HOME` 下的会话都读同一个项目，
   * 即"仍串工作区"）。因此现在**只认本层**：
   *   · 本层没有 `.sdo/` → 视为未初始化（`sdo_status` 报"尚未初始化"），
   *   · **绝不向上爬、绝不猜别的项目**（宁可少显示，也不显示错的）。
   * `findProjectRoot` 仍保留在 `infra/discovery.ts`（供显式探测/测试用），但**不参与定位**
   * —— 钩子侧同理：它用 `workspaceRootFor`（本契约内的两个来源，只认本层），
   * **修前它用 `findProjectRoot` 向上爬**（`dab49d5` 引入的跨项目串账，DEF-054 已修）。
   */
  workspaceFor(call: OfficeCall, explicit?: string): string | undefined {
    if (typeof explicit === 'string' && explicit !== '') return resolve(explicit)
    if (typeof call.cwd === 'string' && call.cwd !== '') return resolve(call.cwd)
    if (call.sessionId !== undefined) {
      const known = this.cwdBySession.get(call.sessionId)
      if (known !== undefined) return resolve(known)
    }
    // **没有兜底**：不读 process.cwd()、不向上查找、不猜别的项目。
    // 真源是工作区里的 `.sdo/`；工作区未知时宁可明确报错，也不显示错的项目。
    return undefined
  }

  /**
   * **钩子侧的工作区根**（DEF-054 / 第三批 §3.17）—— 与 `workspaceFor` **同一契约**（只认本层、
   * 绝不向上爬、绝不猜别的项目），只多一条**择一**规则：两个契约内来源（本次调用携带的 `cwd` /
   * 本会话登记的 `cwd`）里，**只有真的含 `.sdo/` 的那个**算数；都不含 ⇒ `undefined`
   * （调用方按 **fail-closed** 处理）。
   *
   * 为什么必须这样：子代理的 `agent.cwd` 可能是工作区的**子目录**（DEF-047：按子目录读认领台账
   * 会一条都读不到 ⇒ 闸门拿不到写范围 ⇒ 范围内的路径被误拒），而"**向上找最近的 `.sdo/`**"会认到
   * **祖先项目**（DEF-054：跨项目串账，`dab49d5` 引入的回归）。这条规则两边都不违背 ——
   * 答案只可能是"本次 cwd"或"本会话登记的 cwd"**本身**，绝不越过它们去爬。
   */
  workspaceRootFor(call: OfficeCall): string | undefined {
    const candidates: (string | undefined)[] = [
      typeof call.cwd === 'string' && call.cwd !== '' ? resolve(call.cwd) : undefined,
      call.sessionId === undefined ? undefined : this.cwdBySession.get(call.sessionId),
    ]
    for (const dir of candidates) {
      if (dir === undefined || dir === '') continue
      try {
        if (existsSync(join(dir, this.settings.projectDirName))) return dir
      } catch {
        continue
      }
    }
    // **第三步：凭据（不是爬）**。子代理的 `agent.cwd` 可能是工作区子目录（DEF-047 的真机现场：
    // 绝对路径写范围内的文件被误拒）。既然不许爬，就必须有**另一条契约内的来源**证明"这个会话属于哪个工作区"——
    // 那就是**认领台账**：本会话在某个**已登记会话的**工作区里认领过卡 ⇒ 那个工作区就是它的工作区。
    // 候选只有"进程里登记过的会话 cwd"（`cwdBySession`，来自宿主的 `session/created`），**不含任何上溯目录**
    // ⇒ 既不会认到祖先项目（DEF-054），也不会把 DEF-047 的子目录会话打回 fail-closed。
    if (call.sessionId === undefined) return undefined
    const seen = new Set<string>()
    for (const dir of this.cwdBySession.values()) {
      if (dir === '' || seen.has(dir)) continue
      seen.add(dir)
      try {
        if (!existsSync(join(dir, this.settings.projectDirName))) continue
        const store = this.storeFor(dir)
        if (claimsBySession(store, this.journalFor(dir)).some((claim) => claim.sessionId === call.sessionId)) return resolve(dir)
      } catch {
        continue
      }
    }
    return undefined
  }

  /** 取工作区；未知即抛错（错误信息面向人，说明该怎么办）。 */
  requireWorkspace(call: OfficeCall, explicit?: string): string {
    const workspace = this.workspaceFor(call, explicit)
    if (workspace === undefined) {
      throw new Error(
        'SDO 无法确定本会话的工作区（不提供外部目录兜底）：'
        + '请在项目工作区内发起调用，或确认该会话有工作目录（`.sdo/` 应位于工作区之内）。',
      )
    }
    return workspace
  }

  storeFor(workspace: string): SdoStore {
    return new SdoStore(join(resolve(workspace), this.settings.projectDirName))
  }

  journalFor(workspace: string): Journal {
    return new Journal(this.storeFor(workspace))
  }

  /** 一次性取出本次调用的存储 + 日志 + 投影（**只读一次 journal**，避免重复重建把状态读花）。 */
  contextFor(call: OfficeCall): {
    workspace: string
    store: SdoStore
    journal: Journal
    project: SdoProject | undefined
    rebuilt: boolean
    truncated: boolean
    badLine?: number | undefined
    riskConclusion: string | undefined
  } {
    const workspace = this.requireWorkspace(call)
    const store = this.storeFor(workspace)
    const journal = new Journal(store)
    const loaded = journal.loadProject()
    return {
      workspace,
      store,
      journal,
      project: loaded.project,
      rebuilt: loaded.rebuilt,
      truncated: loaded.truncated,
      riskConclusion: readConclusion(store)?.conclusion,
      ...(loaded.badLine === undefined ? {} : { badLine: loaded.badLine }),
    }
  }

  /**
   * **写前快照**（SDO-19 / SDO-26，2026-10-05 真机事故）：直接 `write`/`edit` 覆盖 `.sdo/` 下
   * **手可编辑真源**之前，先把旧内容存一份到 `.sdo/evidence/file-history/`。
   *
   * 为什么需要它：真机上 `.sdo/design/deviations.yml` 被后续卡用 `write` 整篇重写 ⇒ 27 条 DEV 与
   * A1–A10 裁决正文**永久丢失**（journal 里没有正文、宿主机存档也没有）。直接写文件既不受门禁监控、
   * 也不产生事件，所以唯一能救的就是**留一份可恢复的副本**。这不改任何行为（不拦、不判红），
   * 调用方 fail-open：快照失败绝不影响写操作。
   */
  snapshotTruthFile(call: OfficeCall, relative: string): string | undefined {
    const workspace = this.requireWorkspace(call)
    const store = this.storeFor(workspace)
    const normalized = relative.replace(/^\.\//u, '')
    if (!normalized.startsWith('.sdo/')) return undefined
    // 不给自己/台账留副本：journal 是真源且已被纪律禁止直接写；file-history 自身避免递归
    if (normalized.includes('journal.jsonl') || normalized.includes('file-history')) return undefined
    // 注意：`store` 已经扎根在 `.sdo/`，所以要从相对 `.sdo` 的路径切（带上 `.sdo` 会拼成 `.sdo/.sdo/...`）
    const segments = normalized.slice('.sdo/'.length).split('/').filter((item) => item !== '')
    const source = store.path(...segments)
    if (!existsSync(source)) return undefined
    return this.snapshotContent(workspace, normalized, readFileSync(source, 'utf8'))
  }

  /**
   * **快照正文**（§2.5a/b，第二轮整体评审）：把 `relative` 的当前正文存成一份旧稿，返回落点。
   *
   * 两个口径都在这里收口：
   *   · **名字必须唯一到毫秒以内**：旧实现只用 ISO 时间戳（毫秒级），同一毫秒内的连续写入会
   *     **互相覆盖** —— 探针实测 `25 次写入 ⇒ 盘上只剩 5 份`，即"防丢正文的机制"自己在丢正文。
   *     现在追加同毫秒内单调的 4 位序号（`-0001`），名字序 == 时间序（补零保证字典序不乱）；
   *   · **份数有上限**：每个真源只保留最近 {@link FILE_HISTORY_KEEP} 份（旧的按时间从最旧删起）。
   *     这是**观测产物**（`evidence/`，不是真源），不产生 journal 事件 —— 新事件类型会流进
   *     "签字失效/中性表"那两张表，把一次例行清理变成门禁事件（详见 `types.ts` 的 `isNeutralEvent`）。
   *     上限本身写在 README 里给人看。
   *
   * fail-open 由调用方保证（快照失败绝不影响写操作）；这里自己也不抛。
   */
  private snapshotContent(workspace: string, relative: string, text: string): string | undefined {
    try {
      const store = this.storeFor(workspace)
      const slug = relative.replace(/[^A-Za-z0-9._-]/gu, '_')
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
      let name = `${slug}.${stamp}-0001.bak`
      // 同毫秒撞名 ⇒ 顺延序号（不会覆盖任何已有旧稿）。4 位意味着同一毫秒 9999 次以上才可能回绕，
      // 那时宁可不写（返回 undefined = 调用方 fail-open），也不覆盖既有副本。
      let sequence = 1
      while (existsSync(store.path('evidence', 'file-history', name))) {
        sequence += 1
        if (sequence > 9999) return undefined
        name = `${slug}.${stamp}-${String(sequence).padStart(4, '0')}.bak`
      }
      const target = store.writeText(['evidence', 'file-history', name], text)
      this.pruneFileHistory(store, slug)
      return this.relativize(workspace, target)
    } catch {
      return undefined
    }
  }

  /** 把某个真源的旧稿裁到 {@link FILE_HISTORY_KEEP} 份（`listNames` 已排序 ⇒ 从头删 = 删最旧）。 */
  private pruneFileHistory(store: SdoStore, slug: string): void {
    const names = store
      .listNames('evidence', 'file-history')
      .filter((name) => name.startsWith(`${slug}.`) && name.endsWith('.bak'))
    const excess = names.length - FILE_HISTORY_KEEP
    for (const name of names.slice(0, Math.max(0, excess))) {
      try {
        store.remove('evidence', 'file-history', name)
      } catch {
        /* fail-open：删不掉旧稿不影响本次写入 */
      }
    }
  }

  /**
   * **SDO-19（2026-10-05 真机）**：把「绕过 SDO 直接 `write`/`edit` 改 `.sdo/` 真源」记成**真源事件**。
   *
   * 两个洞是同一机制的两面（报告的结论 #2）：直接写文件**既不掀签字、也不让文档判陈旧**（过松），
   * 同一机制又被用来在不触发任何门禁反应的情况下整篇覆盖真源（事故 SDO-26，23 条 DEV 正文永久丢失）。
   * 现在写成功后落一条 `truth/file-written`（含 sha256）：它不在中性表里 ⇒ G3 签字自然失效；
   * 同时列进 `DESIGN_DOC_SOURCE_EVENTS` ⇒ C-25 判 `DESIGN.md` 陈旧。
   *
   * 只认 `.sdo/` 下的**真源**：`journal.jsonl`（纪律已禁直接写）与 `evidence/`（观测产物）不算。
   */
  /**
   * **真源文件当前内容的 sha256**（R2 复审：只记"内容真的变了"的写）。
   *
   * 与 `noteTruthFileWrites` 用**同一套路径归一化与哈希口径**（`.sdo/` 相对路径 → `store.path`，
   * `createHash('sha256')`），读不到 ⇒ 空串（当"新文件/读不到"，调用方按"变了"处理）。
   */
  truthFileHash(call: OfficeCall, path: string): string {
    const normalized = String(path).replace(/^\.\//u, '')
    if (!normalized.startsWith('.sdo/')) return ''
    const store = this.storeFor(this.requireWorkspace(call))
    const segments = normalized.slice('.sdo/'.length).split('/').filter((item) => item !== '')
    const source = store.path(...segments)
    if (!existsSync(source)) return ''
    try {
      return createHash('sha256').update(readFileSync(source, 'utf8')).digest('hex')
    } catch {
      return ''
    }
  }

  noteTruthFileWrites(call: OfficeCall, paths: readonly string[]): number {
    const workspace = this.requireWorkspace(call)
    const store = this.storeFor(workspace)
    const journal = new Journal(store)
    let recorded = 0
    for (const raw of paths) {
      const normalized = String(raw).replace(/^\.\//u, '')
      if (!normalized.startsWith('.sdo/')) continue
      if (normalized.includes('journal.jsonl') || normalized.startsWith('.sdo/evidence/')) continue
      const segments = normalized.slice('.sdo/'.length).split('/').filter((item) => item !== '')
      const source = store.path(...segments)
      if (!existsSync(source)) continue
      const text = readFileSync(source, 'utf8')
      journal.append('truth/file-written', {
        path: normalized,
        bytes: text.length,
        sha256: createHash('sha256').update(text).digest('hex'),
        // **SDO-19 复审**：是不是"会改 DESIGN.md"的那类真源 —— 由写入侧算一次（口径在 types.ts），
        // C-25 只读这个字段；**G3 签字失效不受它影响**（任何真源直写都失效）。
        docSource: isDesignDocTruthPath(normalized),
      })
      recorded += 1
    }
    return recorded
  }

  /** 追加一条事件（真源写入的统一入口）。 */
  appendEvent(call: OfficeCall, type: SdoEventType, data: Record<string, unknown>, actor = 'sdo'): void {
    this.journalFor(this.requireWorkspace(call)).append(type, data, actor)
  }

  /** 初始化项目（幂等）：建目录、写 config.yml、追加 project/created。 */
  /** 插件版本（读随包 `package.json`；读不到回 `unknown`，绝不假装）。 */
  private version(): string {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown }
      return typeof pkg.version === 'string' ? pkg.version : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  init(call: OfficeCall, options: InitOptions = {}): InitResult {
    const workspace = this.requireWorkspace(call)
    const store = this.storeFor(workspace)
    store.ensureLayout()
    const journal = new Journal(store)

    const existing = journal.loadProject().project
    if (existing !== undefined) {
      return { project: existing, created: false, dataDir: store.root }
    }
    // **SDO-08（真机）**：台账不记版本 ⇒ 跨版本复现只能靠外部线索。落一条环境事件（元数据，不作废签字）。
    try {
      journal.append('project/environment', {
        plugin: 'dsh-software-dev-office',
        pluginVersion: this.version(),
        hostVersion: process.env.DSH_VERSION ?? 'unknown',
        node: process.versions.node,
      })
    } catch {
      /* fail-open：版本读不到不影响立项 */
    }

    const config: ProjectConfig = defaultProjectConfig()
    if (typeof options.process === 'string' && options.process !== '') config.process = options.process
    if (options.scale !== undefined) config.scale = options.scale
    // 快速原型：原型目录必须物理隔离且标记可丢弃（Q-05 / 设计 §7.2）
    if (config.process === 'prototype') {
      config.prototype = { dir: 'prototype', throwaway: true }
    }
    writeProjectConfig(store, config)
    if (config.prototype.throwaway) {
      // 注意：原型目录在工作区根（物理隔离），不在 `.sdo/` 里
      new SdoStore(workspace).writeText(
        [config.prototype.dir, 'README.md'],
        [
          '# 原型目录（THROWAWAY）',
          '',
          '> 本目录内容**不得进入交付产物**（设计 Q-05 / REQ-034）。',
          '> 原型结束后：用 `sdo_requirement action=capture prototypeSource=true …` 把结论回填为需求，',
          '> 然后可以整目录删除。交付门禁 G7 会检查本目录是否仍有内容。',
          '',
        ].join('\n'),
      )
    }

    const now = new Date().toISOString()
    const scale = options.scale ?? config.scale
    const stakeholders = (options.stakeholders ?? []).map((role, index) => ({
      id: `STK-${String(index + 1).padStart(2, '0')}`,
      role,
      concerns: [] as string[],
    }))
    const project: SdoProject = {
      id: nextId('PRJ', this.projectIds(store)),
      name:
        typeof options.name === 'string' && options.name.trim() !== ''
          ? options.name.trim()
          : basename(workspace),
      created: now,
      process: processIdOf(config.process),
      phase: 'intake',
      phaseHistory: [{ phase: 'intake', entered: now }],
      scope: { in: options.scopeIn ?? [], out: options.scopeOut ?? [] },
      stakeholders,
      glossary: options.glossary ?? {},
      surfaces: (options.surfaces ?? []).filter((surface) => (SURFACES as readonly string[]).includes(surface)),
      metrics: { success: options.metricsSuccess ?? [], guardrail: [] },
      tailoring: {
        scale,
        waivedGates: scale === 'trivial' ? ['G1', 'G4', 'G6'] : [],
        reason: scale === 'trivial' ? '小改动走裁剪路径（设计 §7.5）' : '默认裁剪：不豁免任何门禁',
        approver: 'human',
        at: now,
      },
    }
    journal.append('project/created', { project })
    return { project, created: true, dataDir: store.root }
  }

  /** 更新项目台账（`sdo_project action=update`）：**只写显式给出的字段**。 */
  updateProject(call: OfficeCall, input: ProjectUpdateInput): ProjectUpdateResult {
    const { store, journal, project } = this.contextFor(call)
    if (project === undefined) throw new Error('项目尚未初始化：请先调用 `sdo_init`。')
    const patch: Partial<SdoProject> = {}
    if (typeof input.name === 'string' && input.name.trim() !== '' && input.name.trim() !== project.name) {
      patch.name = input.name.trim()
    }
    if (typeof input.process === 'string' && input.process !== '') {
      const available = listProcessIds()
      if (!available.includes(input.process)) {
        throw new Error(`未知流程：${input.process}（可用：${available.join(' / ')}）`)
      }
      const next = processIdOf(input.process)
      if (next !== project.process) {
        const target = loadProcess(next)
        if (target === undefined) throw new Error(`流程数据缺失：${next}`)
        // 中途切流程必须落在新流程的阶段序列上，否则项目会卡在一个"不存在的阶段"里
        if (!target.phases.some((phase) => phase.id === project.phase)) {
          throw new Error(
            `不能切换到流程 ${next}：当前阶段 ${project.phase} 不在它的阶段序列里`
            + `（${target.phases.map((phase) => phase.id).join(' → ')}）。`
            + '请先把阶段推进/豁免到新流程里存在的阶段，或新建项目。',
          )
        }
        patch.process = next
      }
    }
    if (input.scopeIn !== undefined && input.scopeIn.length > 0) {
      patch.scope = { in: input.scopeIn, out: project.scope.out }
    }
    if (input.scopeOut !== undefined && input.scopeOut.length > 0) {
      patch.scope = { in: patch.scope?.in ?? project.scope.in, out: input.scopeOut }
    }
    if (input.stakeholders !== undefined && input.stakeholders.length > 0) {
      patch.stakeholders = input.stakeholders.map((role, index) => ({
        id: `STK-${String(index + 1).padStart(2, '0')}`,
        role,
        concerns: [] as string[],
      }))
    }
    if (input.metricsSuccess !== undefined && input.metricsSuccess.length > 0) {
      patch.metrics = { success: input.metricsSuccess, guardrail: project.metrics.guardrail }
    }
    if (input.glossary !== undefined && Object.keys(input.glossary).length > 0) {
      patch.glossary = { ...project.glossary, ...input.glossary }
    }
    if (input.surfaces !== undefined && input.surfaces.length > 0) {
      // 项目级界面面（§2.1）：只接受 web/desktop/mobile，其余值静默丢弃（判定只看这三个）
      const allowed = input.surfaces.filter((surface) => (SURFACES as readonly string[]).includes(surface))
      if (allowed.length > 0) patch.surfaces = allowed
    }
    if (input.scale !== undefined) {
      patch.tailoring = {
        scale: input.scale,
        waivedGates: input.scale === 'trivial' ? ['G1', 'G4', 'G6'] : [],
        reason: project.tailoring?.reason ?? '按规模档调整',
        approver: project.tailoring?.approver ?? 'human',
        at: new Date().toISOString(),
      }
    }
    const changed = Object.keys(patch)
    if (changed.length === 0) return { project, changed: [] }

    // 项目级配置跟随：流程写回 config.yml；切到原型时同时建立原型目录与 throwaway 标记
    const config = readProjectConfig(store).config
    if (patch.process !== undefined) {
      config.process = patch.process
      if (patch.process === 'prototype') {
        config.prototype = { dir: config.prototype.dir, throwaway: true }
      }
      writeProjectConfig(store, config)
      if (patch.process === 'prototype' && config.prototype.throwaway) {
        new SdoStore(this.requireWorkspace(call)).writeText(
          [config.prototype.dir, 'README.md'],
          [
            '# 原型目录（THROWAWAY）',
            '',
            '> 本目录内容**不得进入交付产物**（设计 Q-05 / REQ-034）。',
            '> 原型结束后：用 `sdo_requirement action=capture source=prototype …` 把结论回填为需求，',
            '> 然后可以整目录删除。交付门禁 G7 会检查本目录是否仍有内容。',
            '',
          ].join('\n'),
        )
      }
    }

    journal.append('project/updated', { patch })
    return { project: journal.loadProject().project ?? project, changed }
  }

  /** 读取状态快照（必要时重建投影）。 */
  status(call: OfficeCall): StatusSnapshot {
    const workspace = this.workspaceFor(call)
    if (workspace === undefined) {
      // **友好降级（DEF 回归修复）**：工作区未知时旧实现直接抛错，用户只看到"会话报错"，
      // 既不知道原因也无法继续。现在返回一个空快照：状态显示"尚未初始化"，
      // 并明确告知工作区未知；**仍然不读任何外部目录**（那是另一个 DEF）。
      return {
        dataDir: '',
        project: undefined,
        rebuilt: false,
        truncated: false,
        counts: { requirements: 0, questions: 0, openQuestions: 0, gates: 0, evidence: 0 },
        config: defaultProjectConfig(),
        configSource: 'default',
        pendingGate: undefined,
        lastGate: undefined,
        riskConclusion: undefined,
        risks: { total: 0, open: 0, blockers: 0, high: 0 },
        openIssues: 0,
        feasibilityVerdict: undefined,
        changes: 0,
        workspaceUnknown: true,
        openDesignQuestions: 0,
        designPhase: false,
      }
    }
    // **R-7（blocker）**：注入状态块走的就是这条路径，而它自己会读四类手写真源
    // （`listQuestions` / `listRisks` / `listRequirements` / `readApplicability`…）。
    // 旧实现没有兜底：任意一处 YAML 被手改坏，**模型每轮拿到的门禁状态就直接消失**。
    // 现在读不动就返回一份"降级快照"：如实说明读不出什么（含文件名的报错）+
    // 待判定门禁取**最保守**的值（当前阶段第一个出口门禁），绝不因为读不出而显得"全绿"。
    try {
      return this.statusInner(call)
    } catch (error) {
      return this.degradedStatus(call, error)
    }
  }

  /** 读真源失败时的降级快照（R-7）：不抛、不假装绿。 */
  private degradedStatus(call: OfficeCall, error: unknown): StatusSnapshot {
    const message = error instanceof Error ? error.message : String(error)
    let project: SdoProject | undefined
    let dataDir = ''
    let truncated = false
    let config = defaultProjectConfig()
    let configSource: 'file' | 'default' = 'default'
    let phase = ''
    try {
      const context = this.contextFor(call)
      project = context.project
      dataDir = context.store.root
      truncated = context.truncated
      phase = project?.phase ?? ''
      const read = readProjectConfig(context.store)
      config = read.config
      configSource = read.source
    } catch {
      /* 连项目都读不出：保持最小快照 */
    }
    return {
      dataDir,
      project,
      rebuilt: false,
      truncated,
      counts: { requirements: 0, questions: 0, openQuestions: 0, gates: 0, evidence: 0 },
      config,
      configSource,
      // 读不出真源 ⇒ 无法证明门禁已过 ⇒ 报最保守的"待判定"（绝不显示成"没有待判定的门禁"）
      pendingGate: project === undefined ? undefined : exitGates(processOfProject(project), project.phase)[0],
      lastGate: undefined,
      riskConclusion: undefined,
      risks: { total: 0, open: 0, blockers: 0, high: 0 },
      openIssues: 0,
      feasibilityVerdict: undefined,
      changes: 0,
      openDesignQuestions: 0,
      designPhase: project !== undefined && designPhaseOf(phase),
      truthError: message,
    }
  }

  private statusInner(call: OfficeCall): StatusSnapshot {
    const context = this.contextFor(call)
    const { store, project } = context
    const configRead = readProjectConfig(store)
    const questions = listQuestions(store)
    const gates = this.gatesFor(call)
    // **R-7**：`status()` 自己不解析**需求** YAML（只数文件名），所以"需求真源写坏"在这里不会抛 ——
    // 但门禁现算读得动/读不动是可以直接看到的。把这条降级信息也带回状态块，
    // 否则注入块会显得一切正常（需求数照数、门禁待判定），而真相是"读不出来"。
    const exitEvaluations = this.currentExitGates(call, project)
    const gateTruthError = exitEvaluations.find((evaluation) => evaluation.unjudged === true)?.criteria[0]?.detail
    const snapshot: StatusSnapshot = {
      dataDir: store.root,
      project,
      rebuilt: context.rebuilt,
      truncated: context.truncated,
      counts: {
        requirements: listRequirementIds(store).length,
        questions: questions.length,
        openQuestions: questions.filter((question) => question.status === 'open').length,
        gates: gates.length,
        evidence: store.listNames('evidence').length,
      },
      config: configRead.config,
      configSource: configRead.source,
      // **D2 同源**：待判定门禁按 `evaluateGate` **现算**（与 `advance` 同一判据），
      // 不读 `gates/*.json` 留痕 —— 注入块/看板是模型的主要指引，宁可它说"当前不通过"。
      pendingGate: pendingGateOf(project, () => exitEvaluations),
      lastGate: gates.at(-1),
      riskConclusion: context.riskConclusion,
      risks: (() => {
        const stats = riskStats(listRisks(store))
        return { total: stats.total, open: stats.open, blockers: stats.blockers, high: stats.high }
      })(),
      openIssues: openIssues(store, questions, listRisks(store)).length,
      feasibilityVerdict: readFeasibility(store)?.verdict,
      changes: listChanges(store).length,
      openDesignQuestions: openDesignQuestions(store).length,
      designPhase: project !== undefined && designPhaseOf(project.phase),
      pendingReviewVerifications: (() => {
        const pending = reviewAdoptions(store, new Journal(store)).filter(
          (item) => item.review.findings.length > 0 && item.state !== 'adopted',
        )
        return { count: pending.length, ids: pending.map((item) => item.review.id) }
      })(),
      // **N-11**：已核实成立（reproduced）的发现 —— 逐条列出「评审#序号」，只陈述事实
      reproducedFindings: (() => {
        const items = listDispositions(store)
          .filter((item) => item.outcome === 'reproduced')
          .map((item) => `${item.reviewId}#${item.index + 1}`)
        return { count: [...new Set(items)].length, items: [...new Set(items)] }
      })(),
      // **§7.1 不得静默（注入块那一处）**：声明的内容必须每轮都出现在状态块里，
      // 用户才能在模型动手之前看到"哪些视图做、哪些不做及理由"。
      applicabilityLines: applicabilityLines(readApplicability(store)),
      applicabilityConfirmed: applicabilityState(store).declaration?.confirmed !== undefined,
      // **R3**：展示口径也要消费 `inconsistent`（与真源对不上的签字不得显示成"已签"）
      gateSigned: (() => {
        const state = signatureState(store, new Journal(store), 'G3')
        return state.status === 'valid' && state.inconsistent !== true
      })(),
      ...(() => {
        const budget = readBudgetChecked(store).budget
        if (budget === undefined) return {}
        // 状态块里不重复调用宿主计量：只显示"预算已设 + 已问档位"。
        // **P-9**：消耗数字必须读**快照里记的那个值**（旧实现恒传 0 ⇒ 有数据时也印"已消耗 0 tokens"）；
        // 快照不存在（从没跑过 cost report / 拿不到计量）时如实说"无用量来源"。
        const cost = readCostSnapshot(store)
        const consumed = cost?.amount ?? 0
        const line = cost === undefined
          ? describeBudgetLineNoUsage(budget)
          : describeBudgetLine(
              {
                at: new Date().toISOString(),
                sessions: 0,
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: cost.totalTokens,
                perModel: [],
                ...(budget.total === undefined ? {} : { estimatedCost: { amount: consumed, currency: budget.currency, label: '估算' as const } }),
                unpricedTokens: cost.unpricedTokens,
              },
              budget,
            )
        const advice = cost === undefined
          ? undefined
          : budgetAdvice(
              {
                at: new Date().toISOString(),
                sessions: 0,
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: cost.totalTokens,
                perModel: [],
                estimatedCost: { amount: consumed, currency: budget.currency, label: '估算' as const },
                unpricedTokens: cost.unpricedTokens,
              },
              budget,
            )
        return { costLine: line, ...(advice === undefined ? {} : { budgetAdvice: advice }) }
      })(),
    }
    if (context.badLine !== undefined) snapshot.badLine = context.badLine
    if (gateTruthError !== undefined) snapshot.truthError = gateTruthError
    return snapshot
  }

  /** 显式重建投影（`sdo_status --rebuild` / `/sdo-status --rebuild`）。 */
  /**
   * **显式**重建投影（`sdo_status --rebuild` / `/sdo-status --rebuild`）。
   *
   * §4.4：这是**唯一**允许在"journal 被截断"时覆盖投影的入口（用户明确要求按现有真源重建）；
   * 自动路径（`append()` / `loadProject()`）在截断时一律拒绝对已有投影的覆盖。
   */
  rebuild(call: OfficeCall): { rebuilt: boolean; truncated: boolean; badLine?: number | undefined } {
    const result = this.journalFor(this.requireWorkspace(call)).rebuild({ force: true })
    return {
      rebuilt: result.project !== undefined,
      truncated: result.truncated,
      ...(result.badLine === undefined ? {} : { badLine: result.badLine }),
    }
  }

  /** 读取门禁判定记录（按文件名字典序）。 */
  gatesFor(call: OfficeCall): GateEvaluation[] {
    const store = this.storeFor(this.requireWorkspace(call))
    const records: { record: GateEvaluation; name: string }[] = []
    for (const name of store.listNames('gates')) {
      if (!name.endsWith('.json')) continue
      const record = store.readJson<GateEvaluation>('gates', name)
      if (record !== undefined && typeof record.gate === 'string') records.push({ record, name })
    }
    // **D2 兜底**：同一毫秒内的两次判定 `at` 会相等，此时按**文件写入时间（mtime）**排序，
    // 这才是真实的先后顺序（只用 `at` 会在同毫秒时退回字典序，仍可能取到最旧的那条）。
    const mtimeOf = (name: string): number => {
      try {
        return statSync(join(store.root, 'gates', name)).mtimeMs
      } catch {
        return 0
      }
    }
    // **D2**：必须按**判定时间**排序，不能依赖文件名字典序 ——
    // 旧实现用 `store.listNames('gates')`（字典序）+ `at(-1)`，而中文名文件排在 ASCII 之后，
    // 于是「最近判定」显示的是**最旧**的那条。
    // **D2 权威顺序 = journal 的单调 `seq`**：同一毫秒内 `at` 会相等、文件 mtime 也可能相同，
    // 只有追加式真源的事件序号能稳定表达"先后"。`at` 与 mtime 作为兜底。
    const order = new Map<string, number>()
    for (const event of this.journalFor(this.requireWorkspace(call)).read().events) {
      // **P-18**：只认 `gate/result`。旧实现用 `startsWith('gate/')`，把 `gate/signed` 也算了进来 ——
      // 于是一个"只被签过字、判定更早"的门禁会拿到更新的排序键，冒充"最近判定留痕"。
      // 既然 N-5 已经把"留痕"这个词摆到用户眼前，排序口径就必须只认判定事件。
      if (event.type !== 'gate/result') continue
      const gate = event.data['gate']
      if (typeof gate === 'string') order.set(gate, event.seq)
    }
    const rank = (item: { record: GateEvaluation; name: string }): number =>
      order.get(item.record.gate) ?? Number.MAX_SAFE_INTEGER
    return records
      .sort((a, b) => {
        const bySeq = rank(a) - rank(b)
        if (bySeq !== 0) return bySeq
        const byAt = String(a.record.at ?? '').localeCompare(String(b.record.at ?? ''))
        if (byAt !== 0) return byAt
        return mtimeOf(a.name) - mtimeOf(b.name)
      })
      .map((item) => item.record)
  }

  /** 看板所需的需求摘要。 */
  // ⚠️ **分层说明（评审员 §4.2 建议）**：本类"列表读取"方法**不吞异常** —— 真源写坏时它会抛，
  // 这是**有意**的：静默返回空列表会把"读不出"伪装成"没有数据"，比异常更危险。
  // 用户可见的兜底在**调用面**：工具/命令走 `guardedRead`（`src/index.ts`），看板走 `boardModelFor`。
  boardRequirements(call: OfficeCall): BoardRequirement[] {
    const store = this.storeFor(this.requireWorkspace(call))
    return listRequirements(store).map((requirement) => ({
      id: requirement.id,
      title: requirement.title,
      priority: requirement.priority ?? 'must',
      status: requirement.status,
      score: requirement.ambiguity.score,
      open: requirement.ambiguity.open.length,
    }))
  }

  /** 工作目录内的相对路径（展示用；越界时回落原值）。 */
  relativize(workspace: string, target: string): string {
    const rel = relative(resolve(workspace), resolve(target))
    return rel === '' || rel.startsWith('..') ? target : rel.split(sep).join('/')
  }

  // —————————————————————— M1：需求工程 ——————————————————————

  /** 捕获一条需求。 */
  capture(call: OfficeCall, input: CaptureInput): { requirement: Requirement; flags: string[] } {
    const { store, journal, project } = this.contextFor(call)
    const result = captureRequirement(store, journal, project, input)
    // 需求真源变了 ⇒ 让**派生**的验收大纲跟上（已生成过才刷新；没冻结过就不凭空生成）。
    this.refreshAcceptanceOutline(store, 'human')
    return result
  }

  /** 更新一条需求（含追加验收标准）。 */
  update(call: OfficeCall, input: UpdateInput): { requirement: Requirement; flags: string[] } | undefined {
    const { store, journal, project } = this.contextFor(call)
    const result = updateRequirement(store, journal, project, input)
    this.refreshAcceptanceOutline(store, 'human')
    return result
  }

  /** 列出需求。 */
  // ⚠️ **分层说明（评审员 §4.2 建议）**：本类"列表读取"方法**不吞异常** —— 真源写坏时它会抛，
  // 这是**有意**的：静默返回空列表会把"读不出"伪装成"没有数据"，比异常更危险。
  // 用户可见的兜底在**调用面**：工具/命令走 `guardedRead`（`src/index.ts`），看板走 `boardModelFor`。
  requirements(call: OfficeCall): Requirement[] {
    return listRequirements(this.storeFor(this.requireWorkspace(call)))
  }

  /** 审讯：生成下一批问题（≤4）。 */
  grill(call: OfficeCall, input: AskInput): { questions: GrillQuestion[]; skipped: string[] } {
    const { store, journal, project } = this.contextFor(call)
    return askQuestions(store, journal, project, input)
  }

  /** 回答问题。 */
  answer(call: OfficeCall, input: AnswerInput) {
    const { store, journal, project } = this.contextFor(call)
    const result = answerQuestion(store, journal, project, input)
    // **§7.2 时机迁移**：方法论选择题现在在需求阶段回答（走本入口而不是 `answerDesign`），
    // 因此这里也要刷新"本项目启用了哪些方法"快照；否则快照会一直空着
    //（门禁从账本现算、不受影响，但 `sdo_design action=issues` 与看板读的是快照）。
    if (result !== undefined && result.question.targets.includes(METHOD_TARGET)) {
      refreshMethodSnapshot(store, journal)
    }
    return result
  }

  /** 问题账本。 */
  // ⚠️ **分层说明（评审员 §4.2 建议）**：本类"列表读取"方法**不吞异常** —— 真源写坏时它会抛，
  // 这是**有意**的：静默返回空列表会把"读不出"伪装成"没有数据"，比异常更危险。
  // 用户可见的兜底在**调用面**：工具/命令走 `guardedRead`（`src/index.ts`），看板走 `boardModelFor`。
  questions(call: OfficeCall): GrillQuestion[] {
    return listQuestions(this.storeFor(this.requireWorkspace(call)))
  }

  /** 红队是否已执行（`redteam/attack` 事件）。 */
  redTeamExecuted(call: OfficeCall): boolean {
    return this.journalFor(this.requireWorkspace(call))
      .read()
      .events.some((event) => event.type === 'redteam/attack')
  }

  /** 本会话红队是否被显式停用（最近一次 `redteam/mode`）。 */
  redTeamDisabled(call: OfficeCall): boolean {
    const project = this.contextFor(call).project
    return project?.redTeam?.enabled === false
  }

  /** 红队开关（会话内；写 `redteam/mode` 留痕）。 */
  setRedTeam(call: OfficeCall, enabled: boolean, reason?: string, actor = 'human'): void {
    const { journal, store, project } = this.contextFor(call)
    journal.append('redteam/mode', { enabled, ...(reason === undefined ? {} : { reason }) }, actor)
    // 让投影立即反映开关（供状态块与看板读取）
    if (project !== undefined) journal.loadProject()
    void store
  }

  /** 红队攻击：生成质询问题并留 `redteam/attack` 事件。 */
  /**
   * **方案 B：红队质询由模型针对具体需求生成**。
   * 插件不调模型，只负责：① 把需求原文与薄弱维度交给模型；② 给出必须遵守的产出格式与校验规则。
   * 生成结果通过 `fileRedTeam` 回填，由插件**校验**（引用原文用词、不重复、是问句）。
   */
  proposeRedTeam(call: OfficeCall, requirementIds: string[], count = 3): string {
    const { store, journal } = this.contextFor(call)
    const requirements = requirementIds
      .map((id) => readRequirement(store, id))
      .filter((requirement): requirement is Requirement => requirement !== undefined)
    if (requirements.length === 0) return t('redteam.proposeNone')
    journal.append('redteam/propose', { ids: requirements.map((r) => r.id), count })
    const blocks = requirements.map((requirement) => {
      const weak = weakDimensions(requirement)
      const weakText = weak.length === 0
        ? t('redteam.proposeWeakNone')
        : weak.map((dimension) => t(`dimension.${dimension}`, dimension)).join('、')
      return `--- ${requirement.id}｜${requirement.title} ---\n`
        + `${t('redteam.proposeStatement')}: ${requirement.statement}\n`
        + `${t('redteam.proposeWeak')}: ${weakText}`
    })
    return [
      t('redteam.proposeHeader'),
      t('redteam.proposeInstruction').replace('{count}', String(count)),
      t('redteam.proposeMustQuote'),
      '',
      ...blocks,
      '',
      t('redteam.proposeCallHint'),
    ].join('\n')
  }

  /** 回填模型生成的红队问题：**通过校验才落库**，并把未通过的原因讲清楚。 */
  fileRedTeam(
    call: OfficeCall,
    requirementId: string,
    questions: ProposedQuestion[],
  ): { accepted: GrillQuestion[]; rejected: { text: string; reason: string }[] } {
    const { store, journal } = this.contextFor(call)
    const requirement = readRequirement(store, requirementId)
    if (requirement === undefined) throw new Error(t('redteam.fileNoRequirement').replace('{id}', requirementId))
    const existing = listQuestions(store)
    const result = validateProposed(questions, requirement.statement, existing, 8)
    const created = writeProposedQuestions(store, journal, requirementId, result.accepted)
    if (created.length > 0) {
      journal.append('redteam/file', { target: requirementId, questions: created.map((question) => question.id) })
      openIssue(store, journal, {
        target: requirementId,
        angles: ['model-proposed'],
        questionIds: created.map((question) => question.id),
      })
    }
    return {
      accepted: created,
      rejected: result.rejected.map((item) => ({ text: item.text, reason: t(REJECT_KEY[item.reason] ?? 'redteam.fileEmpty') })),
    }
  }

  redTeamAttack(
    call: OfficeCall,
    requirementIds: string[],
    limit = 4,
  ): { questions: GrillQuestion[]; skipped: string[]; blocked?: string | undefined } {
    const { store, journal, project } = this.contextFor(call)
    // **防"反复问同一题"**：若目标上还有未决的红队问题，先让用户答完再来攻击。
    // 实测反馈：agent 反复调用 attack，用户看到的就是同一个问题被反复提出。
    const openRedTeam = listQuestions(store).filter(
      (question) =>
        question.origin === 'red-team'
        // **P-6**：与门禁同源 —— 未获用户授权的 `assumed` 仍算未决，先让用户答完再攻击
        && isEffectivelyOpen(question)
        && question.targets.some((target) => requirementIds.includes(target)),
    )
    if (openRedTeam.length > 0) {
      const ids = openRedTeam.slice(0, 3).map((question) => question.id).join('、')
      return {
        questions: [],
        skipped: requirementIds,
        blocked:
          `这些需求上还有 ${openRedTeam.length} 个红队问题未决（${ids}${openRedTeam.length > 3 ? ' 等' : ''}）。`
          + '请先用提问工具把**这些问题问用户**并 `sdo_requirement action=answer` 记录答案，再继续红队攻击；'
          + '不要重复提出同一个问题。',
      }
    }
    const result = askQuestions(store, journal, project, {
      requirementIds,
      limit,
      includeRedTeam: true,
      onlyRedTeam: true,
    })
    if (result.questions.length > 0) {
      journal.append('redteam/attack', {
        questions: result.questions.map((question) => question.id),
        targets: requirementIds,
      })
      // 为每条被攻击的需求开一个议题：它必须闭环（问题答完或显式转为风险）
      for (const target of requirementIds) {
        const owned = result.questions.filter((question) => question.targets.includes(target))
        if (owned.length === 0) continue
        openIssue(store, journal, {
          target,
          angles: [...new Set(owned.map((question) => (question.why.match(/#(redteam-[a-z-]+)/u)?.[1] ?? 'unknown')))],
          questionIds: owned.map((question) => question.id),
        })
      }
    }
    return result
  }

  /** DoR 判定（不写盘）。 */
  dor(call: OfficeCall, approvedBy?: string): DorResult {
    const { store, journal, project } = this.contextFor(call)
    return evaluateDor({
      project,
      requirements: listRequirements(store),
      questions: listQuestions(store),
      risks: listRisks(store),
      redTeamExecuted: this.redTeamExecuted(call),
      redTeamDisabled: this.redTeamDisabled(call),
      // **D1**：C7 的唯一放行依据是 G2 的**签字台账**（不是 `approvedBy` 入参字符串）。
      signoff: signoffInput(store, journal, 'G2'),
      ...(approvedBy === undefined ? {} : { approvedBy }),
    })
  }

  /**
   * 基线冻结：DoR 通过才允许；写 `requirement/baselined` + `gate/result` + `gates/G2.json`。
   *
   * **D1**：`options.approvedBy` 只是**附加信息**（写进 C7 的 detail 与冻结事实里），
   * **不再是放行依据** —— 放行要求签字台账里有一条**带用户原话引用**的 G2 签字。
   */
  baseline(call: OfficeCall, options: { approvedBy?: string | undefined; evidence?: string | undefined } = {}): BaselineOutcome {
    const { store, journal, project, process, context } = this.gateContext(call, options.approvedBy)
    const requirements = listRequirements(store)
    // D1：C7 的唯一放行依据 = 签字台账；`approvedBy` 只是附加信息（不静默，也不再是必填）。
    const signoff = signoffInput(store, journal, 'G2')
    const dor = evaluateDor({
      project,
      requirements,
      questions: listQuestions(store),
      risks: listRisks(store),
      redTeamExecuted: this.redTeamExecuted(call),
      redTeamDisabled: this.redTeamDisabled(call),
      signoff,
      ...(options.approvedBy === undefined ? {} : { approvedBy: options.approvedBy }),
    })
    // **REQ-046 / C10（TASK-013）**：验收大纲**在判定之前生成**（"G2 冻结时生成"的落点）。
    //
    // 为什么必须在 `evaluateGate` **之前**：C10 判据是**只读**的（checker 不写台账），
    // 它只会报"缺 / 过期 / 不齐备"；若不在判定前生成，用户就会撞上一个**没有生成路径**的红。
    // `ensureOutline` 幂等（已最新不写盘），因此反复 `baseline` 不产生噪声、不覆盖任何东西。
    // 生成逻辑与 `checkGate('G2')` 共用同一个入口 `ensureAcceptanceOutline`（避免两条判定路径行为分叉）。
    this.ensureAcceptanceOutline('G2', context, options.approvedBy ?? signoff.signer)
    // **B1（本报告）**：基线判定改为**走 `evaluateGate` 现算**，不再自己拼一个
    // `status:'passed'` 落盘。旧实现有两处后果：
    //   ① 流程数据里 G2 声明的第 8 条判据（C8 红队议题闭环）**从不被判定**；
    //   ② 日后给 G2 加任何判据都不会生效（配置假装数据驱动，实际被硬编码劫持）。
    const evaluation = evaluateGate(process, 'G2', context)
    if (!dor.ok || (evaluation.status !== 'passed' && evaluation.status !== 'waived')) {
      // N-9：把门禁现算结果一并交出去（失败回执必须说清是**哪一条判据**拦的）
      return { ok: false, dor, baselined: [], evaluation }
    }
    const evidence = options.evidence ?? `DoR 通过（评分阈值 ${loadScoring().threshold}/16）`
    const baselined = baselineRequirements(
      store,
      journal,
      requirements.map((requirement) => requirement.id),
      // 冻结事实里的"谁签的"以**台账签字人**为准（`approvedBy` 只是可选的展示用附加信息）。
      { by: options.approvedBy ?? signoff.signer ?? 'human', evidence },
    )
    const gate: GateEvaluation = evaluation
    store.writeJson(['gates', 'G2.json'], gate)
    journal.append('gate/result', {
      gate: 'G2',
      status: gate.status,
      phase: gate.phase,
      ...gateResultDetail(gate),
    })
    // **D-6（sdo-test-new 2026-10-08，minor）**：阶段转移**只写一次**，而且如实写"退出的到底是哪个阶段"。
    // 旧实现无条件写死 `exited requirements` + `entered architecture` —— 于是
    //   ① 「先 `advance` 再 `baseline`」会**重放**一次转移（真机 journal seq 97/98 与 101/102），
    //      `phaseHistory` 出现两个 architecture 条目，requirements 被"退出"两次 ⇒ 时长统计与审计失效；
    //   ② 在 requirements **之前**的阶段（真机夹具里是 intake）调 baseline，台账会记一条
    //      "退出了 requirements"的**假事件**。
    // 冻结需求这件事本身照做（那是 baseline 的本职），只有"转移"这一步受这条闸门约束。
    const phaseOrder = process.phases.map((item) => item.id)
    const currentPhase = project?.phase ?? ''
    const currentIndex = phaseOrder.indexOf(currentPhase)
    const architectureIndex = phaseOrder.indexOf('architecture')
    const phaseEntered = architectureIndex >= 0 && (currentIndex === -1 ? true : currentIndex < architectureIndex)
    if (phaseEntered) {
      journal.append('phase/exited', { phase: currentPhase === '' ? 'requirements' : currentPhase })
      journal.append('phase/entered', { phase: 'architecture' })
    }
    // **R-2**：把"这次到底转没转阶段"交给渲染层 —— 回执不许讲与台账相反的话
    return { ok: true, dor, baselined, gate, phaseEntered, phase: phaseEntered ? 'architecture' : currentPhase }
  }

  /** **死豁免诊断**（R-8 附录）：`exempt` 里的卡不存在或已 dropped ⇒ 回执要主动说。 */
  deadExemptions(call: OfficeCall): { task: string; check: string; why: string; reason: 'missing' | 'dropped' }[] {
    const { store } = this.contextFor(call)
    return deadExemptions(store)
  }

  /** 设计阶段前置检查（G2 已过的硬前置；M2 才实现真正的设计工具）。 */
  designCheck(call: OfficeCall): { allowed: boolean; reason: string; remedy?: string | undefined; dor: DorResult } {
    const { store } = this.contextFor(call)
    const requirements = listRequirements(store)
    const dor = this.dor(call)
    if (requirements.length === 0) {
      return { allowed: false, reason: '没有任何需求，无法进入设计', remedy: '先用 `sdo_requirement action=capture` 收集需求', dor }
    }
    const notBaselined = requirements.filter((requirement) => requirement.status !== 'baselined')
    if (notBaselined.length > 0) {
      return {
        allowed: false,
        reason: `需求尚未基线（${notBaselined.map((r) => r.id).join(' ')}）`,
        remedy: '先让需求达到 DoR 并通过 `sdo_requirement action=baseline`（G2）',
        dor,
      }
    }
    return { allowed: true, reason: 'G2 已通过', dor }
  }

  /** 渲染文档（M1：srs；其余在后续里程碑补齐）。 */
  /**
   * 渲染人读文档：`srs` / `decisions` / `quality`（**DEF-004**）。
   *
   * 为什么是一个入口：架构阶段声明的建议产物（`DECISIONS.md` / `QUALITY.md`）此前**没有渲染器** ——
   * 声明落不了地、判据只能判红。三份文档共用"路径映射"这一处口径（`derivedDocRelativePath`），
   * 与判据同源，避免"渲染写一处、判据读另一处"。
   */
  render(call: OfficeCall, which: 'srs' | 'decisions' | 'quality' = 'srs'): string {
    const { store, journal, project, workspace } = this.contextFor(call)
    const seq = journal.read().events.length
    if (which !== 'srs') {
      const kind: DerivedDocKind = which
      const derived = kind === 'decisions'
        ? renderDecisionsDoc({ project, adrs: listAdrs(store), seq })
        : renderQualityDoc({
            project,
            scenarios: listScenarios(store),
            assessment: readAssessment(store),
            seq,
          })
      const relative = derivedDocRelativePath(kind)
      const target = new SdoStore(workspace).writeText(relative.split('/'), derived)
      // **DEF-005 / DEF-006（TASK-023）**：登记进 journal 的 `doc/rendered`（与 `derivedDocs` 的读侧同一口径）：
      // 判据据此证明"盘上这份是按**当前真源**写的"，并靠 `sha256` 判"渲染之后被手改过没有"。
      // 只写 `evidence/recorded` 是不够的 —— `quality.doc` 明确要求"该序号上真的发生过一次写这份文档"。
      journal.append('doc/rendered', {
        doc: relative,
        seq,
        sha256: createHash('sha256').update(derived).digest('hex'),
      })
      return this.relativize(workspace, target)
    }
    const text = renderSrs({
      project,
      requirements: listRequirements(store),
      questions: listQuestions(store),
      seq,
    })
    if (which === 'srs') {
      const target = new SdoStore(workspace).writeText(['docs', 'SRS.md'], text)
      journal.append('evidence/recorded', { kind: 'render', doc: 'SRS.md', seq })
      return this.relativize(workspace, target)
    }
    return ''
  }

  // —————————————————————— M3：流程与门禁 ——————————————————————

  /** 当前项目的流程定义。 */
  process(call: OfficeCall): ProcessDef {
    return processOfProject(this.contextFor(call).project)
  }

  /** 组装门禁判定所需的全部输入。 */
  private gateContext(call: OfficeCall, approvedBy?: string): {
    workspace: string
    store: SdoStore
    journal: Journal
    project: SdoProject | undefined
    process: ProcessDef
    context: GateContext
  } {
    const { workspace, store, journal, project, riskConclusion } = this.contextFor(call)
    const config = readProjectConfig(store).config
    const context: GateContext = {
      workspace,
      store,
      journal,
      process: processOfProject(project),
      project,
      requirements: listRequirements(store),
      questions: listQuestions(store),
      risks: listRisks(store),
      issues: listIssues(store),
      feasibility: readFeasibility(store),
      redTeamExecuted: journal.read().events.some((event) => event.type === 'redteam/attack'),
      redTeamDisabled: project?.redTeam?.enabled === false,
      waivedGates: project?.tailoring?.waivedGates ?? [],
      prototypeDir: config.prototype.dir,
      prototypeThrowaway: config.prototype.throwaway,
      riskConclusion,
      ...(approvedBy === undefined ? {} : { approvedBy }),
    }
    return { workspace, store, journal, project, process: processOfProject(project), context }
  }

  /**
   * 读真源 + 组装门禁上下文，**失败不抛**（R-7）。
   *
   * 为什么必须在这里兜住：`gateContext` 在调用 `evaluateGate` **之前**就读四类手写真源
   * （requirements/questions/risks/issues），而 `evaluateGate` 的 try/catch 在它**之后** ——
   * 于是 `.sdo/requirements|questions|risks|issues` 任一 YAML 被手改坏，
   * `evaluate()` / `advance()` / `status()`（注入状态块）全都直接抛异常。
   */
  private safeGateContext(call: OfficeCall, approvedBy?: string):
    | { ok: true; value: ReturnType<SoftwareDevOffice['gateContext']> }
    | { ok: false; error: unknown; phase: string } {
    try {
      return { ok: true, value: this.gateContext(call, approvedBy) }
    } catch (error) {
      let phase = ''
      try {
        phase = this.contextFor(call).project?.phase ?? ''
      } catch {
        /* 连项目都读不出 */
      }
      return { ok: false, error, phase }
    }
  }

  /**
   * **需求真源变更后的派生刷新**：让已存在的验收大纲跟上当前真源（没生成过则不动）。
   *
   * 与 `ensureAcceptanceOutline` 的分工：
   *   · 这里管"**需求改了**"（`capture` / `update` / `change`）—— 派生件必须跟着源走；
   *   · 那里管"**要判 G2 了**"—— 判定前必须有一份当前的大纲，否则判红却没有修复路径。
   * 两条都走同一个域函数（`refreshOutlineIfPresent` / `ensureOutline`），口径不分叉。
   */
  private refreshAcceptanceOutline(store: SdoStore, generatedBy: string): void {
    refreshOutlineIfPresent({
      store,
      requirements: listRequirements(store),
      generatedAt: new Date().toISOString(),
      generatedBy,
    })
  }

  /**
   * **G2 的验收大纲准备**（REQ-046 / C10，TASK-013）。
   *
   * 为什么要有这么一个**统一入口**：判定 G2 的路径不止一条 —— `baseline()`（冻结）与
   * `checkGate('G2')`（回退后重判、体检、交付前复算）都会现算 G2。验收大纲必须在**判定之前**
   * 处于当前状态，否则：
   *   · 只读判据只会报"缺 / 过期 / 不齐备"，而**没有任何生成路径** —— 用户撞上一个不知道怎么补的红
   *     （本项目明令禁止"判红却给不出可执行修法"）；
   *   · 回退后重判会莫名其妙地红（实测：M13-09 正是这条路径）。
   * 所以：凡是"要判 G2"的地方，都先走这里生成（幂等：已最新则不写盘）。
   *
   * 只在 `gateId === 'G2'` 时动手（其它门禁与验收大纲无关，不该顺手写台账）。
   */
  private ensureAcceptanceOutline(
    gateId: string,
    context: GateContext,
    generatedBy: string | undefined,
  ): void {
    if (gateId !== 'G2') return
    ensureOutline({
      store: context.store,
      requirements: context.requirements,
      generatedAt: new Date().toISOString(),
      generatedBy: generatedBy ?? 'human',
    })
  }

  /** 读真源失败时的可读判红（R-7 / R-14）：判据 id 用 `gate.unreadable`，并标 `unjudged`。 */
  private truthFailure(gateId: string, phase: string, error: unknown): GateEvaluation {
    const message = error instanceof Error ? error.message : String(error)
    return {
      gate: gateId,
      phase,
      status: 'failed',
      at: new Date().toISOString(),
      criteria: [
        {
          id: 'gate.unreadable',
          ok: false,
          // R-14：与"判不过"区分开 —— 这条不是"某个判据不满足"，而是"真源读不出来，判据没逐条判"
          detail: fmt('uiOffice.truthReadFailed', { p1: message }),
          remedy: t('uiOffice.truthReadFailedRemedy'),
        },
      ],
      remedy: [t('uiOffice.truthReadFailedRemedy')],
      unjudged: true,
    }
  }

  /** 判定一个门禁（**只算不写**）。 */
  evaluate(call: OfficeCall, gateId: string, approvedBy?: string): GateEvaluation {
    const prepared = this.safeGateContext(call, approvedBy)
    if (!prepared.ok) return this.truthFailure(gateId, prepared.phase, prepared.error)
    const { process, context } = prepared.value
    return evaluateGate(process, normalizeGateId(gateId, process), context)
  }

  /**
   * 门禁签字的**审核单**（完整 Markdown）——签字问答里给用户通读的"审核内容"。
   *
   * 为什么要有它：签字入口过去只给一句固定文案，用户**看不到自己签的是什么**（真机教训
   * 2026-10-09：复用旧原话补签，本质是"替人签字"）。这里把待签对象摆全：
   *   ① 逐条判据的三态判定（✅ 通过 / ❌ 失败 / ➖ N/A，与 `describeGate` **同一口径**）；
   *   ② 未通过项的实测与修法；
   *   ③ 本门**流程数据**声明的建议产物（`suggestedArtifacts`）**清单**（路径 / 在不在 / 多大）。
   *
   * **只读真源**（`evaluate` 只算不写；产物只读不写）。真源读不出来时如实渲染"没有逐条判定"，
   * 绝不假装判过（与 `truthFailure` 同口径）。
   *
   * **返回摘要与全文两份**（用户裁定 2026-10-10）：提问卡只放**摘要**（判定总览那 5 行），
   * 全文落盘到 `.sdo/reviews/` 供**侧边栏**通读 —— 卡片与侧边栏的分工就此确定。
   */
  signReview(call: OfficeCall, gateId: string): { summary: string; full: string; record: SignReviewRecord } {
    let workspace = call.cwd ?? ''
    try {
      workspace = this.requireWorkspace(call)
    } catch {
      /* 工作区都定位不到时下面的产物一律按"缺失"处理 */
    }
    const prepared = this.safeGateContext(call)
    let process: ProcessDef | undefined
    let evaluation: GateEvaluation
    if (prepared.ok) {
      process = prepared.value.process
      evaluation = evaluateGate(process, normalizeGateId(gateId, process), prepared.value.context)
    } else {
      evaluation = this.truthFailure(gateId, prepared.phase, prepared.error)
    }

    const criteria: SignReviewCriterion[] = evaluation.criteria.map((item) => ({
      id: item.id,
      ok: item.ok === true,
      na: item.na === true,
      desc: textOrProcess(`criterion.${item.id}`, item.desc),
      detail: item.na === true ? (item.naReason ?? item.detail) : item.detail,
      remedy: item.remedy ?? '',
      warnings: item.warnings ?? [],
    }))

    // 建议产物：名字以**流程数据**为唯一真源（阶段 → suggestedArtifacts）。
    // **只列清单（路径 / 在不在 / 多大），不内联原文** —— 2026-10-09 真机反馈：
    // 内联产物原文会把问答卡撑成一堵墙；签字要看的是判据与未通过项。
    const phase = process === undefined ? undefined : phaseDef(process, evaluation.phase)
    // **受审载荷**：集合名以流程数据的 `reviewPayload` 为唯一真源。
    // 真源读不出来（store 构造失败等）⇒ 载荷为空 + 指纹按空集算，**不静默假装读过**：
    // 文档里会显示"（无）"，且签字前的机械核对仍会把它与真源对一遍。
    const collections = phase?.reviewPayload ?? []
    let payload: SignReviewPayloadSection[] = []
    let fingerprint = reviewFingerprint(evaluation.gate, [])
    let seq = 0
    if (workspace !== '') {
      try {
        const store = this.storeFor(workspace)
        payload = readReviewPayload(store, collections)
        // **TASK-007 / REQ-051**：验证门（G6）的签字人要通读的是**测试总结报告正文**，
        // 而它的真源是 YAML、受审正文是渲染稿 ⇒ 走 `renderTestReportSignable` 投影成受审段
        // （指纹取同一个 `docSourceFingerprint` 口径，故签字仍绑定报告真源，真源一改即拒签）。
        // 只在**验证阶段**追加：报告是那个阶段的产物，别的阶段签的多半还没有报告，追加空段只会增加噪声。
        if (evaluation.phase === 'verification' || evaluation.phase === 'delivery') {
          // **`DEF-151`**：与 `renderVerificationDocs` 共用同一份页眉元信息（只修一处 ⇒
          // `C-59` 签字对上的仍是一份页眉被削的投影）
          const signable = renderTestReportSignable({ store, ...this.testingRenderMeta(call) })
          payload = [...payload, {
            collection: signable.payload.collection,
            items: signable.payload.items.map((item) => renderedDocReviewItem({
              collection: item.collection,
              id: item.id,
              path: item.path,
              text: String(item.content),
            })),
          }]
        }
        fingerprint = reviewFingerprint(evaluation.gate, payload)
        seq = this.journalFor(workspace).read().events.at(-1)?.seq ?? 0
      } catch {
        payload = []
      }
    }

    // **产物面（REQ-044 / AC-228、AC-229）**：两张来源**分开**摆，不能混成一张单栏表 ——
    //   ① **必需** = 本门判据**强制**的人读文档（`requiredArtifactNames`，名字以判据为真源）：
    //      缺了判据就红，所以这一栏是"必须有的"；
    //   ② **建议** = 流程数据的 `suggestedArtifacts`（只作建议、不入门禁）。
    // 两栏各自给出**规范渲染路径**，并对"建议名 ≠ 规范名"的行显式给出**对齐关系**与**可执行修法**：
    // 历史事故（DEF-004）正是建议名与判据/渲染名不一致 ⇒ 审核单长期显示补不上的"假缺失"。
    const gate = process === undefined ? undefined : gateDef(process, evaluation.gate)
    const requiredNames = requiredArtifactNames(gate)
    const suggestedNames = phase?.suggestedArtifacts ?? []
    const artifacts: SignReviewArtifact[] = []
    for (const [name, required] of [
      ...requiredNames.map((item) => [item, true] as const),
      ...suggestedNames.map((item) => [item, false] as const),
    ]) {
      // 规范名（与判据/渲染器的名字对齐）——没有规范名时退回声明名（纯建议文件，如 `VISION.md`）。
      const canonical = canonicalArtifactOf(name)
      const canonicalPath = canonical?.path ?? ''
      // 找文件：先是**规范落点**（`docs/<规范名>`），再是声明名自己的落点（交付类文档在 `docs/<名字>`，
      // 也容忍工作区根下的手写产物）。顺序很关键：规范名要**先**找，否则"建议名对不上、文件其实在规范名上"
      // 会被读成"缺失"（假缺失）。声明名 = 规范名时，第二条只是同一个路径，无副作用。
      const roots = [...new Set([canonicalPath, `docs/${name}`, name].filter((item) => item !== ''))]
      const candidates = roots.map((rel) => ({ rel, abs: join(workspace, ...rel.split('/')) }))
      const hit = candidates.find((item) => workspace !== '' && existsSync(item.abs))
      if (hit === undefined) {
        const path = candidates[0]?.rel ?? name
        // **AC-229**：缺失项的修法必须**可执行**，且分得清"补文件"与"把名字对齐到规范名"。
        const remedy = canonicalPath === '' || canonicalPath === path
          ? fmt('uiSignReview.artifactRemedyMissing', { p1: path })
          : fmt('uiSignReview.artifactRemedyAlign', { p1: name, p2: canonicalPath, p3: path })
        artifacts.push({ name, path, exists: false, bytes: 0, required, canonical: canonical?.name ?? canonicalPath, canonicalPath, remedy })
        continue
      }
      let bytes = 0
      try {
        bytes = statSync(hit.abs).size
      } catch {
        const remedy = canonicalPath === '' || canonicalPath === hit.rel
          ? fmt('uiSignReview.artifactRemedyMissing', { p1: hit.rel })
          : fmt('uiSignReview.artifactRemedyAlign', { p1: name, p2: canonicalPath, p3: hit.rel })
        artifacts.push({ name, path: hit.rel, exists: false, bytes: 0, required, canonical: canonical?.name ?? canonicalPath, canonicalPath, remedy })
        continue
      }
      artifacts.push({ name, path: hit.rel, exists: true, bytes, required, canonical: canonical?.name ?? canonicalPath, canonicalPath, remedy: '' })
    }

    const record: SignReviewRecord = {
      gate: evaluation.gate,
      at: evaluation.at,
      seq,
      hash: fingerprint,
      collections: [...collections],
      items: payloadIndex(payload),
    }
    const doc: SignReviewDoc = {
      gate: evaluation.gate,
      gateText: process === undefined ? evaluation.gate : gateLabel(evaluation.gate),
      phaseText: process === undefined ? evaluation.phase : phaseLabel(process, evaluation.phase),
      statusText: evaluation.status === 'passed'
        ? t('uiSignReview.statusPassed')
        : evaluation.status === 'waived'
          ? t('uiSignReview.statusWaived')
          : t('uiSignReview.statusFailed'),
      at: evaluation.at,
      criteria,
      artifacts,
      unjudged: evaluation.unjudged === true,
      // **受审载荷**（方案 3，2026-10-12 用户裁定）：按流程数据的 `reviewPayload` 逐条内联真源正文。
      // 集合名以**流程数据**为唯一真源（与 `suggestedArtifacts` 同纪律：只展示、不入门禁）。
      payload,
      fingerprint,
      seq,
    }
    const full = renderSignReviewDoc(doc)
    const summary = renderSignReviewSummary(doc)
    // 全文**落盘**：`evidence/sign-reviews/<门禁>.md` 按门禁归档（"用户签字时看到过什么"的审计件），
    // `latest.md` 是**固定名** —— 客户端半只按固定路径取全文，所以它不能带门禁名。
    // **为什么不在 `reviews/`**：那是**评审台账**（`REV-*.yml` + `review-verifications.yml`），
    // 把签字审核单混进去会让"评审"与"签字快照"两个概念在同一目录里打架。
    // 落盘失败**不影响签字**：卡片摘要与签字流程都不依赖它。
    if (workspace !== '') {
      try {
        const store = this.storeFor(workspace)
        store.writeText(['evidence', 'sign-reviews', `${doc.gate}.md`], full)
        store.writeText(['evidence', 'sign-reviews', 'latest.md'], full)
        // **机器可校验的指纹记录**：签字前会重算真源指纹并与它比对，不一致即拒签。
        // 存的是逐条 `(collection, id, path, hash)` —— 这样拒签时能**点名哪条变了**，
        // 而不是只报一句"审核单已失效"。
        const json = `${JSON.stringify(record, null, 2)}\n`
        store.writeText(['evidence', 'sign-reviews', `${doc.gate}.json`], json)
        store.writeText(['evidence', 'sign-reviews', 'latest.json'], json)
      } catch {
        /* 只读不写的那条路（摘要）仍然成立 */
      }
    }
    return { summary, full, record }
  }

  /**
   * 读某门禁**最后一次生成的审核单记录**（`.sdo/evidence/sign-reviews/<门禁>.json`）。
   *
   * 找不到 ⇒ `undefined`：调用方据此**拒绝签字**（"没有审核单 ⇒ 不许盲签"）。
   */
  /** 把门禁入参归一成**内部编号**（拿不到流程定义时退回原串，不猜）。 */
  private normalizeGateFor(call: OfficeCall, gateId: string): string {
    try {
      const prepared = this.safeGateContext(call)
      if (prepared.ok) return normalizeGateId(gateId, prepared.value.process)
    } catch {
      /* 读不出流程就用原串 */
    }
    return gateId
  }

  signReviewRecord(call: OfficeCall, gateId: string): SignReviewRecord | undefined {
    try {
      const workspace = this.requireWorkspace(call)
      const store = this.storeFor(workspace)
      // **DEF-002**：文件名必须是**规范门禁名**（落盘时写的是 `evaluation.gate`）。
      // 传中文全名（`需求基线门禁`）时旧实现直接拼文件名 ⇒ 找不到 ⇒ 被误判成"没有审核单"。
      const raw = store.readText('evidence', 'sign-reviews', `${this.normalizeGateFor(call, gateId)}.json`)
      if (raw === undefined) return undefined
      const parsed = JSON.parse(raw) as SignReviewRecord
      if (typeof parsed?.hash !== 'string' || !Array.isArray(parsed.items)) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  /**
   * **审核单新鲜度核对**：按当前真源重算受审载荷指纹，与记录里的指纹比对。
   *
   * 返回**差异行**（空数组 = 一致）。差异按逐条 `(collection, id, hash)` 算，
   * 所以能点名"哪条变了/新增/删除"，而不是只报一句"已失效"。
   *
   * 三档各不相同、都要能区分：① 真源变了（`~ REQ-007 内容已变`）；
   * ② 加了新的真源条目（`+ RISK-013 新增`）；③ 受审集合声明本身变了（整篇指纹变、
   * 逐条差异为空）——第三档用 `uiSignPayload.diffScopeChanged` 单独说明。
   */
  signReviewDrift(call: OfficeCall, gateId: string, record: SignReviewRecord): string[] {
    let workspace = ''
    try {
      workspace = this.requireWorkspace(call)
    } catch {
      return []
    }
    let collections = Array.isArray(record.collections) ? record.collections : []
    // **DEF-002**：指纹里的门禁名必须与**生成时**用的那一个完全一致 —— 生成侧用的是
    // `evaluate.gate`（规范化后的 `G2`）。旧实现拿**入参原串**重算，传中文全名（`需求基线门禁`）
    // 时指纹恒不相等 ⇒ 明明真源没变也报"审核单已失效"，签字被无理由拒。
    // 以记录里的 `gate` 为准（它就是生成时那个串），入参只作兜底。
    const gate = record.gate !== '' && record.gate !== undefined ? record.gate : gateId
    try {
      const prepared = this.safeGateContext(call)
      if (prepared.ok) {
        // 门禁所属阶段 = "出口是本门禁"的那个阶段（与 `evaluateGate` 判定的阶段同源）
        const gate = normalizeGateId(gateId, prepared.value.process)
        const phase = prepared.value.process.phases.find((item) => (item.exit ?? []).includes(gate))
        const declared = phase?.reviewPayload
        if (declared !== undefined) collections = [...declared]
      }
    } catch {
      /* 取不到声明就用记录里的那批（同批比对仍然有效） */
    }
    const payload = readReviewPayload(this.storeFor(workspace), collections)
    const now = reviewFingerprint(gate, payload)
    if (now === record.hash) return []
    const lines = diffPayloadIndex(record.items ?? [], payloadIndex(payload))
    // 逐条没差异却整篇不同 ⇒ 是**受审集合声明**变了（覆盖面变了），如实说明，别报个空列表
    if (lines.length === 0) return [t('uiSignPayload.diffScopeChanged')]
    return lines
  }

  /**
   * 当前阶段的出口门禁**现算**结果（只算不写，供"待判定门禁"与看板使用）。
   *
   * 与 `advance` 同源：都走 `evaluateGate` + 同一个 `GateContext`。
   * `project` 可由调用方传入（`status()` 已从 `contextFor` 拿到同一份投影，避免重复读 journal）。
   */
  currentExitGates(call: OfficeCall, project?: SdoProject | undefined): GateEvaluation[] {
    const prepared = this.safeGateContext(call)
    if (!prepared.ok) {
      // 读不出真源 ⇒ 无法证明任何出口门禁已过。返回一条 `gate.unreadable` 的失败评估：
      // `pendingGateOf` 因此会报"当前阶段第一个出口门禁待判定"（最保守），而不是"没有待判定的门禁"。
      return [this.truthFailure('gate.unreadable', prepared.phase, prepared.error)]
    }
    const { process, context, project: current } = prepared.value
    const target = project ?? current
    if (target === undefined) return []
    return exitGates(process, target.phase).map((gate) => evaluateGate(process, gate, context))
  }

  /** 判定并落盘（写 `gates/<id>.json` + `gate/result`）。 */
  checkGate(call: OfficeCall, gateId: string, approvedBy?: string): GateEvaluation {
    const prepared = this.safeGateContext(call, approvedBy)
    if (!prepared.ok) {
      // R-14：把"读不动"这件事也写进台账（否则事后分不清"当时查不动"与"当时真的不过"）。
      // **§5.2（评审员）**：这一支**不能再用 `contextFor`** —— 它正是刚刚失败的那一步
      //（`.sdo/project.json` 坏 JSON 时它会抛 `JSON.parse` 的 `SyntaxError`），
      // 于是 `sdo_gate action=check`（用户卡住时最该能用的入口）会以异常收场。
      // 改用**最小路径**：只按工作区拿到 store/journal，落盘整段再包一层 try/catch；
      // 落不下也不影响返回值（回执里说明"本次未落盘"）。
      const failure = this.truthFailure(gateId, prepared.phase, prepared.error)
      const workspace = this.workspaceFor(call)
      if (workspace !== undefined) {
        try {
          const store = this.storeFor(workspace)
          const journal = new Journal(store)
          store.writeJson(['gates', `${gateId}.json`], { ...failure, persisted: true })
          journal.append('gate/result', { gate: gateId, status: failure.status, phase: failure.phase, unjudged: true, ...gateResultDetail(failure) })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          failure.criteria[0]!.detail = `${failure.criteria[0]!.detail}；本次未落盘（${message}）`
        }
      }
      return failure
    }
    const { store, journal, process, context } = prepared.value
    // **G-01**：归一结果只算一次，落盘与回执都用它 ——
    // 旧实现把**原始入参**当文件名（`架构门禁（G3）.json`），而回执声称写的是 `G3.json`：
    // 回执与事实不符，且别名文件会积累成"最后一次判定"的多个副本（并集语义下可能掩盖后续失败）。
    const id = normalizeGateId(gateId, process)
    // **REQ-046 / C10**：判 G2 前先把验收大纲对齐到当前需求真源（与 `baseline` 同一入口）。
    // 「回退后重判 G2」正是这条路径 —— 不在这里生成，回退后就会红得没有道理（实测 M13-09）。
    this.ensureAcceptanceOutline(id, context, approvedBy ?? context.approvedBy)
    const evaluation = evaluateGate(process, id, context)
    const persisted: GateEvaluation = { ...evaluation, persisted: true }
    store.writeJson(['gates', `${id}.json`], persisted)
    journal.append('gate/result', {
      gate: persisted.gate,
      status: persisted.status,
      phase: persisted.phase,
      ...gateResultDetail(persisted),
    })
    return persisted
  }

  /**
   * 推进到下一阶段：当前阶段的**出口门禁现算**必须全部通过/豁免。
   *
   * **D2**：旧实现只看 `gates/*.json` 里"曾经通过"的记录的并集 —— 门禁于是从
   * "阶段出口的当前事实"退化成"历史通过记录的存在性"：基线之后把需求改坏，
   * 只要不显式 `check`，`advance` 仍放行。现在对**每个出口门禁**调用 `evaluateGate`
   * 重新判定，只有 `passed` / `waived` 才放行；`gates/*.json` 退化为**判定留痕**
   * （照写不误，供审计/看板使用，但不再参与放行）。
   * `waiveGate` 仍是合法豁免出口：豁免记录在 `tailoring.waivedGates`，
   * `evaluateGate` 会返回 `waived`。
   */
  advance(call: OfficeCall): {
    advanced: boolean
    from: string
    to?: string | undefined
    blockedBy?: string | undefined
    remedy?: string[] | undefined
    /** **R-26**：推进成功、但账本里仍有"已批准却未重新基线"的变更时必须点名（判定通过 ≠ 已重新冻结） */
    notes?: string[] | undefined
  } {
    const prepared = this.safeGateContext(call)
    if (!prepared.ok) {
      const message = prepared.error instanceof Error ? prepared.error.message : String(prepared.error)
      return {
        advanced: false,
        from: prepared.phase,
        blockedBy: 'gate.unreadable',
        remedy: [t('uiOffice.truthReadFailedRemedy'), message],
      }
    }
    const { store, journal, project, process, context } = prepared.value
    if (project === undefined) throw new Error('项目尚未初始化：请先调用 `sdo_init`。')
    // **R-26**：推进成功时也要如实说"账本里还有已批准却**没重新基线**的变更"——
    // 真机形态：G2 判 ✅、阶段也推进了，可 `requirement/baselined` 事件始终没写 ⇒ 变更仍算未消化，
    // 直到下一次 `claim` 才被 `change-not-digested` 拦住（白跑一张探测卡）。
    const pendingBaseline = listUndigestedChanges(store, journal, process)
      .filter((item) => item.rebaselinedSeq === undefined)
      .map((item) => item.id)
    const advanceNotes = pendingBaseline.length === 0
      ? []
      : [fmt('uiIndex.kAdvanceBaselinePending', { p1: pendingBaseline.join('、') })]
    const exits = exitGates(process, project.phase)
    // **REQ-046 / C10**：本阶段出口含 G2 时，先让验收大纲对齐当前真源再判定。
    // 为什么这里也要做：`advance` 是**走到 G2 的另一条真实路径**（实测 D2 用例正是如此 ——
    // 它从不用 `baseline`，直接靠 `advance` 判需求阶段出口）。不在这里生成，用户会撞上
    // "改了需求也补了 AC，却仍被 G2 拦住"且没有修复入口的红。
    for (const gate of exits) this.ensureAcceptanceOutline(gate, context, context.approvedBy)
    const evaluations = exits.map((gate) => evaluateGate(process, gate, context))
    const blocked = evaluations.find((evaluation) => evaluation.status !== 'passed' && evaluation.status !== 'waived')
    if (blocked !== undefined) {
      store.writeJson(['gates', `${blocked.gate}.json`], { ...blocked, persisted: true })
      journal.append('gate/result', { gate: blocked.gate, status: blocked.status, phase: project.phase, ...gateResultDetail(blocked) })
      return { advanced: false, from: project.phase, blockedBy: blocked.gate, remedy: blocked.remedy }
    }
    for (const evaluation of evaluations) {
      // 现算结果**照写留痕**：即便与盘上旧记录不同，也以本次判定为准（这正是 D2 的语义）。
      store.writeJson(['gates', `${evaluation.gate}.json`], { ...evaluation, persisted: true })
      journal.append('gate/result', { gate: evaluation.gate, status: evaluation.status, phase: project.phase, ...gateResultDetail(evaluation) })
    }
    const next = nextPhase(process, project.phase)
    // **D-6**：同一阶段的"转移"是重放（`baseline` 触发过一次的那类 bug），不是推进 —— 不写、且如实说没推进。
    if (next !== undefined && next.id === project.phase) return { advanced: false, from: project.phase }
    journal.append('phase/exited', { phase: project.phase })
    if (next === undefined) {
      return { advanced: false, from: project.phase, ...(advanceNotes.length === 0 ? {} : { notes: advanceNotes }) }
    }
    journal.append('phase/entered', { phase: next.id })
    return { advanced: true, from: project.phase, to: next.id, ...(advanceNotes.length === 0 ? {} : { notes: advanceNotes }) }
  }

  // —————————————— §7.1 设计适用性声明 ——————————————

  /** 读声明（未起草时为 `undefined`）。 */
  applicability(call: OfficeCall): DesignApplicability | undefined {
    const store = this.storeFor(this.requireWorkspace(call))
    return readApplicability(store)
  }

  /** 声明的结构判读（缺失 / 有结构问题 / 可用）。 */
  applicabilityCheck(call: OfficeCall): ApplicabilityState {
    return applicabilityState(this.storeFor(this.requireWorkspace(call)))
  }

  /** 起草（或覆盖）声明：**这是"模型"的动作**，不等于用户已签字。 */
  draftApplicability(call: OfficeCall, input: ApplicabilityDraftInput): DesignApplicability {
    const { store, journal } = this.contextFor(call)
    return draftApplicability(store, journal, input)
  }

  /** 声明给用户看的渲染行（注入块 / `action=issues` / `docs/DESIGN.md` 三处共用，§7.1）。 */
  applicabilityLines(call: OfficeCall): string[] {
    const store = this.storeFor(this.requireWorkspace(call))
    return applicabilityLines(readApplicability(store))
  }

  /** 用户签字绑定声明（`basis` = 用户原话或所选选项原文，空则拒绝）。 */
  confirmApplicability(call: OfficeCall, basis: string, by: string): DesignApplicability | undefined {
    const { store, journal } = this.contextFor(call)
    return confirmApplicability(store, journal, basis, by)
  }

  // —————————————— §7.2 门禁级签字 ——————————————

  /**
   * 记录一次门禁签字。
   *
   * **无引用文本即拒绝**（`recordSignature` 抛错）：这是防止模型"替用户签"的唯一机械闸门。
   *
   * **C-59（TASK-062）**：若本门禁声明了 `testing.report-signed` 判据（测试报告签字通道），
   * 落签字时**一并绑定报告当前的内容指纹** —— 没有它，事后无法回答"签字之后报告被改过没有"。
   * 指纹口径**复用**报告渲染头里那一个（`docSourceFingerprint(store,'report')`），不另造哈希；
   * 报告真源还没落盘时**不记该字段**（历史签字 / G2・G3 通道的行为因此完全不变）。
   */
  signGate(call: OfficeCall, input: {
    gate: string
    by: string
    basis: string
    channel: 'command' | 'question'
    /** **`DEF-112`**：陈述面只能记**弱签字**（只入账、不冻结门禁）。 */
    weak?: boolean | undefined
    turn?: string | undefined
    basisChecked?: 'session' | 'role-only' | 'unavailable' | undefined
    /**
     * **R-27**：依据在会话派生消息里的位置（用户又原样说了一次时更大）。
     * **H4**：只作审计/提示 —— 压缩会让它变小，重放判定不再依赖它（用 `basisMsgId`）。
     */
    basisAt?: number | undefined
    /** **H2a/H4**：命中这条依据的**用户消息 id**（跨压缩稳定）——重放判定的键 */
    basisMsgId?: string | undefined
    /** **R-27**：依据是本次调用当场取回的（`channel=question`）⇒ 不参与重放判定 */
    basisFresh?: boolean | undefined
  }): GateSignature {
    const { store, journal, project } = this.contextFor(call)
    // **F-1（2026-10-05 真机，major）**：签字**落盘前**归一成内部编号。旧实现原样落盘调用方字符串
    // （真机留下 `gate: 架构门禁（G3）`），而判定侧按 `'G3'` 精确过滤 ⇒ 签字永远不被看见。
    // 复用 `check` 侧同一个解析函数（两侧口径一致），回执里印的是**落盘后的**那个 id。
    const gate = normalizeGateId(input.gate, processOfProject(project))
    return recordSignature(store, journal, { ...input, gate, ...this.reportFingerprintFor(store, gate, project) })
  }

  /**
   * **本门禁要不要绑报告内容指纹**（C-59 / TASK-062）——要就给出**当前**指纹，不要就什么都不给。
   *
   * "本门禁声明了报告签字判据"以**流程数据**为唯一真源（`gateDef(process, gate).criteria`），
   * 不在这里硬编码门禁名：waterfall/prototype/spiral 是 G6、agile 是 GI —— 硬编码一处就会漏掉另一处。
   * 报告真源还没落盘 ⇒ 返回空对象（**不记字段**）：那种情况下"签字绑了哪一版报告"本就无从谈起，
   * 由判据按降级口径处理，而不是在这里编一个假指纹。
   */
  private reportFingerprintFor(
    store: SdoStore,
    gate: string,
    project: SdoProject | undefined,
  ): { reportFingerprint?: string } {
    try {
      const process = processOfProject(project)
      const declared = process === undefined
        ? false
        : gateDef(process, gate)?.criteria?.some((criterion) => criterion.check === 'testing.report-signed') === true
      if (!declared) return {}
      // ⚠️ 报告真源是**相对 `.sdo/` 根**的路径（`TESTING_SOURCE_FILES` 的 `testing/report.yml`），
      // 而 `TESTING_DOC_META.report.source` 只是给人读的展示串 —— 判定/写盘一律以映射表为准。
      const sourcePath = TESTING_SOURCE_FILES.report.find((ref) => ref.file === 'report')?.path
      if (sourcePath === undefined) return {}
      if (!existsSync(store.path(...sourcePath.split('/')))) return {}
      return { reportFingerprint: docSourceFingerprint(store, 'report') }
    } catch {
      // 读不动真源时**不阻断签字**（签字本身有它自己的机械闸门）：如实不记指纹，判据按降级口径判
      return {}
    }
  }

  /**
   * **签字依据重放预检**（R-27）：这句话是不是"上次失效之前的老话"？
   *
   * 工具层用它给出**可操作的拒绝回执**（让用户重新表态，或改用 `channel=question` 当场问）；
   * `recordSignature` 里还有一道强制拒绝（任何直接调用都绕不过去）。
   */
  basisReplay(
    call: OfficeCall,
    gate: string,
    basis: string,
    occurrence?: { basisAt?: number | undefined; basisMsgId?: string | undefined },
  ): {
    replayed: boolean
    usedAtSeq?: number | undefined
    lastInvalidation?: number | undefined
    sameOccurrence?: boolean | undefined
    /** 判定用的是哪一种身份（`message-id` = 消息 id；`text-fallback` = 只有文本/下标） */
    by: 'message-id' | 'text-fallback'
  } {
    const { store, journal, project } = this.contextFor(call)
    return basisReplay(store, journal, normalizeGateId(gate, processOfProject(project)), basis, occurrence)
  }

  /**
   * **记录一次被拒的签字尝试**（R-28 建议 5）：`gate/sign-rejected`。
   *
   * 三条设计约束：① 只记"谁在什么时候想对哪个门签什么字、为什么被拒"，**不改任何真源**；
   * ② 它在 `SIGNATURE_NEUTRAL_EVENTS` 里 ⇒ 不会顺带作废已有的签字（被拒 ≠ 真源变更）；
   * ③ 依据原文照录（审计要看得出"被拒的是哪句话"）。
   */
  /**
   * **`DEF-110`（第十三批 §2.2）**：问答通道**不可用**（宿主没装配 `userQuestions` / 没弹出来）
   * 与"用户**拒签**"必须分开记账 —— 旧实现两者都落 `gate/sign-rejected`，事后读账分不出
   * "没问过"和"问过被拒"（真机：seq 3484 把插件自己的诊断「侧边栏没弹出」记成了拒签）。
   */
  noteSignUnavailable(call: OfficeCall, gate: string, channel: 'question', reason: string): void {
    const { journal, project } = this.contextFor(call)
    journal.append('gate/sign-unavailable', {
      gate: normalizeGateId(gate, processOfProject(project)),
      channel,
      reason: reason.slice(0, 200),
    })
  }

  noteSignRejected(call: OfficeCall, gate: string, channel: 'command' | 'question', basis: string): void {
    const { journal, project } = this.contextFor(call)
    journal.append('gate/sign-rejected', {
      gate: normalizeGateId(gate, processOfProject(project)),
      channel,
      basis: basis.slice(0, 200),
    })
  }

  /** 某门禁的签字状态（缺失 / 无引用 / 已失效 / 有效）。 */
  signatureState(call: OfficeCall, gate: string): SignatureState {
    const { store, journal } = this.contextFor(call)
    return signatureState(store, journal, gate)
  }

  /**
   * **用户原话核对**（§7.2 "用户原话引用"的可审计实现）。
   *
   * 引用文本必须能在**本次会话的用户发言**里找到 —— 模型凭空写一句话即被拒。
   * 这是一条**额外的收紧**：判定时只在会话历史拿得到时才做（拿不到就只靠"引用非空"，
   * 即规格的最低要求），因此不会把"宿主读不到会话"变成"没法签字"。
   *
   * 取用户发言：dsh-agent 0.2.0-rc.1 的 `agent.session.deriveMessages()` 返回派生消息历史；
   * 只取 `role === 'user'` 的文本块（模型/工具发言不算）。
   *
   * **R-7**：这条口径**必须留痕**（`basisChecked`）—— 旧实现在"拿不到会话历史"时
   * `return true`，静默把防线降级成"引用非空"，用户与审计都不知道这一次到底核没过。
   */
  answerMatchesUserQuote(call: OfficeCall, quote: string): boolean {
    return this.checkUserQuote(call, quote).ok
  }

  /**
   * 原话核对 + **核对口径**（R-7：调用点应把 `basisChecked` 落进签字台账）。
   *
   * **H1（critical，2026-10-09 整体评审）：只按 `role === 'user'` 过滤不算"人说的"。**
   * 宿主把**注入块**（`runtime-context`）、压缩检查点、工具回执回灌、技能调用等**都当 user 角色**交给模型
   * ⇒ 旧实现里"在没有用户在场的情况下引用注入块里的一句话"就能签成字（真机教训换了一条路又成立）。
   * 现在按**消息出处**（`Message.source.kind`）白名单：只有 `kind === 'user'`（真正的人类输入，
   * 含 `user-rpc` 别名）才算"用户原话"，其余一律不计。
   *
   * **H1 的第二半（本插件自己在子会话里的情形）**：派发子会话时，父会话写的那段任务提示
   * 在子会话里也是 `source.kind === 'user'`（宿主 `continuation.js` 就是这么投递的）——
   * 但那是**机器写的文本**。所以 `delegationDepth ≥ 1` 的会话里不再接受这种"用户原话"，
   * 如实回报 `basisChecked: 'role-only'` 并要求由驾驶舱会话取得背书。拿不到 depth 时按 depth=0 处理（老宿主）。
   *
   * **0.2.1-alpha.1 新增出处 `user-question-reply`**（人类对**宿主**提问的回答，0.2.0-rc.1 没有）：
   * 本白名单**只认 `'user'`**，所以这类消息在**陈述通道**会被如实拒绝 —— 这是有意的：
   * 项目纪律是"签字一律现场取得"，现场通道就是本工具自己的 `channel=question`（`basisFresh` 旁路，
   * 且依据由工具直接取回、不经过模型）；而宿主的提问回答**无法与自动应答区分**（已知信任边界）。
   * 拒绝回执已经点名"改用 `channel=question`"，因此不会把用户堵死在死路上。
   *
   * **H2a/H4**：返回值里给出命中消息的**稳定 id**（`basisMsgId`）——签字的重放判定用它，
   * 不再用会随压缩漂移的下标（`basisAt` 只作审计/提示）。
   */
  checkUserQuote(call: OfficeCall, quote: string): {
    ok: boolean
    basisChecked: 'session' | 'role-only' | 'unavailable'
    /** **R-27**：最后一条命中这句话的用户消息下标（只作提示 —— 压缩会让它变小，见 `basisMsgId`） */
    basisAt?: number | undefined
    /** **H2a/H4**：命中那条消息的稳定 id（跨压缩不变），签字重放判定的键 */
    basisMsgId?: string | undefined
  } {
    const wanted = normalizeBasis(quote)
    if (wanted === '') return { ok: false, basisChecked: 'session' }
    const agent = call.agent as {
      session?: {
        header?: { delegationDepth?: unknown } | undefined
        deriveMessages?: () => { id?: unknown; role?: unknown; content?: unknown; source?: unknown }[]
      }
    } | undefined
    const depthRaw = agent?.session?.header?.delegationDepth
    const delegated = typeof depthRaw === 'number' && depthRaw >= 1
    const derive = agent?.session?.deriveMessages
    if (typeof derive !== 'function') return { ok: true, basisChecked: 'unavailable' }
    let messages: { id?: unknown; role?: unknown; content?: unknown; source?: unknown }[]
    try {
      messages = agent?.session?.deriveMessages?.() ?? []
    } catch {
      return { ok: true, basisChecked: 'unavailable' }
    }
    // **H1**：口径 = `source.kind === 'user'`（人类输入）。`source` 缺失才是老宿主 ⇒ 退回 role 口径，
    // 但如实标成 `role-only`（弱口径），别把"角色是 user"说成"核对过用户发言"。
    let sawSource = false
    let sawRoleOnly = false
    const texts: { index: number; id: string; text: string }[] = []
    for (const [index, message] of messages.entries()) {
      if (message.role !== 'user') continue
      const source = message.source
      const kind = typeof source === 'object' && source !== null ? (source as { kind?: unknown }).kind : undefined
      if (typeof kind === 'string') {
        sawSource = true
        // 非人类出处（注入块 / 压缩检查点 / 回执回灌 / 技能调用…）一律不计 —— H1 的要害
        if (kind !== 'user') continue
        // 子会话里的 "user" 消息是**父会话写的任务提示**（机器文本），不是人说的
        if (delegated) continue
      } else {
        sawRoleOnly = true
      }
      const content = message.content
      let joined = ''
      if (typeof content === 'string') {
        joined = content
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'string') { joined += block; continue }
          if (typeof block === 'object' && block !== null) {
            const text = (block as { text?: unknown }).text
            if (typeof text === 'string') joined += text
          }
        }
      }
      if (joined !== '') texts.push({ index, id: typeof message.id === 'string' ? message.id : '', text: joined })
    }
    const hits = texts.filter((item) => normalizeBasis(item.text).includes(wanted))
    if (hits.length === 0) {
      // 有出处信息却一条都不合格 ⇒ 是"拿注入块/派发提示冒充用户原话"这一类，口径如实回报
      const basisChecked = sawSource && !sawRoleOnly ? 'session' : sawRoleOnly ? 'role-only' : 'session'
      return { ok: false, basisChecked }
    }
    const last = hits[hits.length - 1]
    return {
      ok: true,
      // 老宿主（消息没有 source）⇒ 弱口径；有出处且命中人类消息 ⇒ 强口径
      basisChecked: sawRoleOnly ? 'role-only' : 'session',
      basisAt: last?.index,
      ...(last !== undefined && last.id !== '' ? { basisMsgId: last.id } : {}),
    }
  }

  // —————————————— §6.1 阶段回退 ——————————————

  /** 当前阶段允许回退到的阶段（**按流程数据声明**）。 */
  rollbackTargets(call: OfficeCall): string[] {
    const { project, process } = this.gateContext(call)
    return project === undefined ? [] : legalRollbackTargets(process, project.phase)
  }

  /**
   * 回退阶段（§6.1）：设计阶段发现需求问题 → 退回需求阶段。
   *
   * 纪律：
   *   · `reason` 非空（写清发现了什么需求缺口）；
   *   · 目标必须是**流程数据声明的合法回退边**（不允许任意跳阶段）；
   *   · 落 journal：谁、何时、因何回退、从哪退到哪（含**当时**合法的边集合 `legalAtThatTime`）；
   *   · **门禁失效**：删掉**目标阶段及其之后所有阶段**的出口门禁记录 —— 回来后必须**重新通过**。
   *     只删目标阶段是不够的：离开的阶段与更靠后的陈旧 `passed` 会让重走被直接放行（R-2）。
   *   · **豁免不受回退影响**：`tailoring.waivedGates` 是用户的显式决定，回退不撤销它；
   *     因此被作废的门禁里可能仍有**处于豁免状态**的（回来时 `evaluateGate` 直接返回 `waived`，
   *     不会重新判红）。语义保持不变，但这件事必须在回执里**可见**（`stillWaivedGates`）。
   */
  rollbackPhase(call: OfficeCall, input: {
    to: string
    reason: string
    by?: string | undefined
  }): {
    ok: boolean
    from: string
    to: string
    invalidatedGates: string[]
    stillWaivedGates: string[]
    error?: string | undefined
  } {
    const { store, journal, project, process } = this.gateContext(call)
    const from = project?.phase ?? ''
    if (project === undefined) {
      return { ok: false, from, to: input.to, invalidatedGates: [], stillWaivedGates: [], error: t('uiOffice.rollbackNoProject') }
    }
    const reason = input.reason.trim()
    if (reason === '') {
      return { ok: false, from, to: input.to, invalidatedGates: [], stillWaivedGates: [], error: t('uiOffice.rollbackNoReason') }
    }
    const legal = legalRollbackTargets(process, from)
    if (!legal.includes(input.to)) {
      return {
        ok: false,
        from,
        to: input.to,
        invalidatedGates: [],
        stillWaivedGates: [],
        error: legal.length === 0
          ? fmt('uiOffice.rollbackNoEdge', { p1: phaseLabel(process, from) })
          : fmt('uiOffice.rollbackIllegal', { p1: phaseLabel(process, from), p2: input.to, p3: legal.join(' ') }),
      }
    }
    // 门禁留痕作废（R-2，方案 1）：「目标阶段及其之后的所有阶段」的判定留痕全部删除。
    // 删除的语义在 D2 之后变了 —— `advance` 不再看留痕（每次都现算），所以这里删的是
    // **审计/展示层的派生记录**（`gates/*.json` 仅供看板与 `lastGate` 展示）。
    //
    // **P-17（把承诺说准）**：journal 的 `gate/result` 只能复原**结论与清单**
    // （`status` / 判红的判据 id / N/A 的 id / 通过数），**复不了每个判据的 detail/remedy**
    // —— 而"当时为什么不过、该怎么修"恰恰是审计最想看的。因此这里**在删之前**把判据明细
    // 一并写进 `phase/rolled-back`（一次事件的成本，换永久可审计）。
    const invalidatedGates = exitGatesFrom(process, input.to)
    const invalidatedDetails = invalidatedGates.flatMap((gate) => {
      const record = store.readJson<GateEvaluation>('gates', `${gate}.json`)
      if (record === undefined || typeof record.gate !== 'string') return []
      return [
        {
          gate,
          status: record.status,
          // **R-11**：补上 `desc`（"这条判据是什么"）—— 只有 id 时审计读不出判据语义。
          // **R-13**：只保留**审计需要的**明细（判红/N-A 的 detail + remedy），通过的判据只留 id/ok，
          // 既让"为什么不过"永久可查，又不让一次回退事件动辄 7.9KB。
          criteria: (record.criteria ?? []).map((criterion) => {
            const interesting = !criterion.ok || criterion.na === true
            return {
              id: criterion.id,
              ok: criterion.ok,
              ...(criterion.na === true ? { na: true } : {}),
              ...(criterion.desc === undefined ? {} : { desc: criterion.desc }),
              ...(interesting
                ? {
                    detail: criterion.detail,
                    ...(criterion.remedy === undefined ? {} : { remedy: criterion.remedy }),
                  }
                : {}),
            }
          }),
        },
      ]
    })
    for (const gate of invalidatedGates) store.remove('gates', `${gate}.json`)
    // **豁免不随回退作废**：`tailoring.waivedGates` 是用户的显式决定，保留本身合理；
    // 但作废清单里这些门禁回来时会被 `evaluateGate` 直接判 `waived`（不会重新判红），
    // 必须如实回报，否则用户以为"全部都要重新通过"。
    const waived = new Set(project.tailoring?.waivedGates ?? [])
    const stillWaivedGates = invalidatedGates.filter((gate) => waived.has(gate))
    journal.append('phase/rolled-back', {
      from,
      to: input.to,
      reason,
      by: input.by ?? 'human',
      invalidatedGates,
      // P-17：判据明细（detail/remedy）在这里永久留痕 —— `gates/*.json` 删掉之后就靠它审计。
      invalidatedDetails,
      // 与回执同源的可见性：留痕里也写清"这些作废的门禁仍处于豁免状态"。
      stillWaivedGates,
      // R-3：把**事件发生时**合法的边集合写进事件本身，判定时以事件自证 ——
      // 之后流程数据改名/删边不会追溯性地把一条当时合法的回退判红。
      legalAtThatTime: legal,
    })
    // D2：下一次 `advance` 会为每个出口门禁**现算**（§6.1「回退后 G2 需重新通过」不再靠提示，
    // 也不靠"删掉已通过这个事实"——判据是当前真源，留痕只作审计）。
    return { ok: true, from, to: input.to, invalidatedGates, stillWaivedGates }
  }

  /** 豁免一个门禁（留痕：写 tailoring.waivedGates + `gate/result: waived`）。 */
  waiveGate(
    call: OfficeCall,
    gateId: string,
    reason: string,
    approver: string,
    /**
     * **R-27 连带（sdo-test-new 2026-10-09）**：这次豁免的**用户原话依据**（可选）。
     *
     * 为什么要有：`approver` 是**调用方自述**的批准人（模型可以写任何名字）。豁免是"自救出口"，
     * 不该被依据卡死（那会在真机最需要它的时候失效）；但**有没有依据**必须留在真源里、印在回执上 ——
     * 否则一条"我编的批准人"看起来就是一次正常的人类批准。
     */
    basis?: { quote: string; checked: 'session' | 'role-only' | 'unavailable' } | undefined,
  ): GateEvaluation {
    // **R-7**：豁免只需要项目台账（tailoring），不必读 requirements/questions/risks/issues ——
    // 用 `gateContext` 会让"某类真源被写坏"顺带把豁免也弄成异常，而豁免恰恰是用户此时的自救手段。
    const { store, journal, project } = this.contextFor(call)
    if (project === undefined) throw new Error('项目尚未初始化：请先调用 `sdo_init`。')
    const tailoring = project.tailoring ?? {
      scale: 'normal' as const,
      waivedGates: [],
      reason: '',
      approver,
      at: new Date().toISOString(),
    }
    const process = processOfProject(project)
    const resolved = normalizeGateId(gateId, process)
    // **R-23（sdo-test-new 2026-10-09）**：先校验这个门禁**属于当前流程**。旧实现在校验之前就写了
    // `project/updated` + `tailoring/updated` —— 一处"豁免某个用不上的门禁"的探索动作会：
    //   ① 把一条**指向不存在门禁**的豁免留在项目裁剪里（该流程日后新增同名门禁就**静默生效**）；
    //   ② 连带作废刚签的人类签字（这两类写入都在 G2 的失效集合里）。
    // 现在：不属于当前流程 ⇒ 直接拒绝（不写 tailoring、不写门禁记录、不作废签字）。
    if (!process.gates.some((gate) => gate.id === resolved)) {
      return {
        gate: resolved,
        phase: project.phase,
        status: 'failed',
        at: new Date().toISOString(),
        // **R-29**：这条路径**没有**写任何文件（也不该写）⇒ 回执不许说"判定记录已写入"
        persisted: false,
        criteria: [
          {
            id: 'gate.unknown',
            ok: false,
            detail: fmt('uiGates.k139', { p1: process.id, p2: resolved }),
            remedy: fmt('uiGates.k140', { p1: process.gates.map((gate) => gate.id).join(' ') }),
          },
        ],
        remedy: [fmt('uiGates.k141', { p1: process.id, p2: resolved })],
      }
    }
    const waivedGates = [...new Set([...tailoring.waivedGates, resolved])]
    journal.append('project/updated', {
      patch: { tailoring: { ...tailoring, waivedGates, reason, approver, at: new Date().toISOString() } },
    })
    // **R-27 连带**：批准人的**依据口径**要留痕（`none` = 调用方自述、没有任何用户原话背书）
    const approverBasis = basis === undefined
      ? { approverChecked: 'none' as const }
      : { approverBasis: basis.quote, approverChecked: basis.checked }
    journal.append('tailoring/updated', { waivedGates, reason, approver, ...approverBasis })
    const refreshed = this.gateContext(call, approver)
    const evaluation = evaluateGate(refreshed.process, resolved, refreshed.context)
    const recorded: GateEvaluation = { ...evaluation, status: 'waived', remedy: [], persisted: true }
    store.writeJson(['gates', `${resolved}.json`], recorded)
    journal.append('gate/result', { gate: resolved, status: 'waived', phase: recorded.phase, reason, approver, ...approverBasis })
    return recorded
  }

  /**
   * **N-10（R-23③ / R-29③）：撤销一条豁免**（误探自愈的唯一出口）。
   *
   * 为什么必须有：`waivedGates` 是 append-only 真源，旧实现**只增不减** —— 一次误探（真机：豁免了
   * 一个当时不存在的门禁 `原型验收门禁（GP）`）就永久留在裁剪里，且没有任何动作能清掉它，
   * 只能靠散文披露（R-29 的处置就是"如实交代"，那不该是唯一出路）。
   *
   * 口径：
   *   · **只认"当前确实在 `waivedGates` 里"的门禁**（不在里面 ⇒ 拒绝并列出真正豁免了的门禁）；
   *   · 与 `waive` **对称**：同两条留痕（`project/updated` 的 tailoring 补丁 + `tailoring/updated`），
   *     所以**签字的失效口径也一样**（`tailoring/updated` 在 G2 的失效集合里）—— 回执必须如实说；
   *   · 被撤销的门禁**不属于当前流程**时（R-29 的残留正是这种），回执额外说明"现行判据不受影响"，
   *     免得用户以为撤销残留会改变当前判定。
   */
  unwaiveGate(
    call: OfficeCall,
    gateId: string,
    reason: string,
    approver: string,
  ):
    | { ok: true; gate: string; waivedGates: string[]; inProcess: boolean }
    | { ok: false; code: 'no-project' | 'not-waived'; detail: string; waivedGates: string[] } {
    const { journal, project } = this.contextFor(call)
    if (project === undefined) {
      return { ok: false, code: 'no-project', detail: '项目尚未初始化：请先调用 `sdo_init`。', waivedGates: [] }
    }
    const process = processOfProject(project)
    const waived = [...new Set(project.tailoring?.waivedGates ?? [])]
    const normalized = normalizeGateId(gateId, process)
    // 先按原串精确匹配（历史上写进去的可能就是全名），再按归一后的 id 匹配
    const removed = waived.includes(gateId) ? gateId : waived.includes(normalized) ? normalized : undefined
    if (removed === undefined) {
      return {
        ok: false,
        code: 'not-waived',
        // **§1.3（2026-10-09 整体评审）**：这里曾复用 `uiGates.k142`「检查器 {p1} 尚未实现」——
        // 回执说了**没发生的事**；而且我传的 `p2`（真正豁免的门禁清单）在那个键里并不存在、被静默丢掉。
        detail: fmt('uiIndex.kUnwaiveNotWaived', {
          p1: gateId,
          p2: waived.length === 0 ? t('uiIndex.kUnwaiveNone') : waived.join(' '),
        }),
        waivedGates: waived,
      }
    }
    const next = waived.filter((gate) => gate !== removed)
    const tailoring = {
      ...(project.tailoring ?? { scale: 'normal' as const }),
      waivedGates: next,
      reason,
      approver,
      at: new Date().toISOString(),
    }
    journal.append('project/updated', { patch: { tailoring } })
    journal.append('tailoring/updated', { waivedGates: next, reason, approver, unwaived: removed })
    return { ok: true, gate: removed, waivedGates: next, inProcess: process.gates.some((gate) => gate.id === removed) }
  }

  /** 阶段的中文名（数据驱动）。 */
  phaseLabel(call: OfficeCall, phase?: string): string {
    const { project, process } = this.gateContext(call)
    return phaseLabel(process, phase ?? project?.phase ?? '')
  }

  // —————————————————————— M1：可行性 / 风险 / 议题 / 变更 ——————————————————————

  feasibility(call: OfficeCall): FeasibilityAssessment | undefined {
    return readFeasibility(this.storeFor(this.requireWorkspace(call)))
  }

  /** 记录一次 TELOS 可行性评估（G1 的输入）。 */
  assessFeasibility(call: OfficeCall, input: AssessInput, by = 'human'): FeasibilityAssessment {
    const { store, journal } = this.contextFor(call)
    return assess(store, journal, input, by)
  }

  // ⚠️ **分层说明（评审员 §4.2 建议）**：本类"列表读取"方法**不吞异常** —— 真源写坏时它会抛，
  // 这是**有意**的：静默返回空列表会把"读不出"伪装成"没有数据"，比异常更危险。
  // 用户可见的兜底在**调用面**：工具/命令走 `guardedRead`（`src/index.ts`），看板走 `boardModelFor`。
  risks(call: OfficeCall): RiskItem[] {
    return listRisks(this.storeFor(this.requireWorkspace(call)))
  }

  logRisk(call: OfficeCall, input: Parameters<typeof logRisk>[2]): RiskItem {
    const { store, journal } = this.contextFor(call)
    return logRisk(store, journal, input)
  }

  updateRisk(call: OfficeCall, id: string, patch: Parameters<typeof updateRisk>[3]): RiskItem | undefined {
    const { store, journal } = this.contextFor(call)
    return updateRisk(store, journal, id, patch)
  }

  /** 写本圈风险结论（螺旋流程 GR 门禁的输入）。 */
  concludeRisk(call: OfficeCall, conclusion: RiskConclusion['conclusion'], rationale: string, by = 'human'): RiskConclusion {
    const { store, journal } = this.contextFor(call)
    const record: RiskConclusion = { at: new Date().toISOString(), conclusion, rationale, by }
    writeConclusion(store, journal, record)
    return record
  }

  /** 本圈风险结论。 */
  riskConclusion(call: OfficeCall): string | undefined {
    return readConclusion(this.storeFor(this.requireWorkspace(call)))?.conclusion
  }

  // ⚠️ **分层说明（评审员 §4.2 建议）**：本类"列表读取"方法**不吞异常** —— 真源写坏时它会抛，
  // 这是**有意**的：静默返回空列表会把"读不出"伪装成"没有数据"，比异常更危险。
  // 用户可见的兜底在**调用面**：工具/命令走 `guardedRead`（`src/index.ts`），看板走 `boardModelFor`。
  issues(call: OfficeCall): RedTeamIssue[] {
    return listIssues(this.storeFor(this.requireWorkspace(call)))
  }

  /** 未闭环的红队议题（G2 的 `redteam.closed` 准则）。 */
  openIssues(call: OfficeCall): { issue: RedTeamIssue; reason: string }[] {
    const { store } = this.contextFor(call)
    return openIssues(store, listQuestions(store), listRisks(store))
  }

  /** 处置一个红队议题（转为风险 / 回到需求）。 */
  disposeIssue(call: OfficeCall, id: string, disposition: 'risk' | 'requirement', note: string): RedTeamIssue | undefined {
    const { store, journal } = this.contextFor(call)
    return disposeIssue(store, journal, id, disposition, note)
  }

  changes(call: OfficeCall): ChangeRequest[] {
    const { store } = this.contextFor(call)
    return listChanges(store)
  }

  /**
   * **已批准但尚未消化的需求变更**（语义 A）：`claim` 会因此被拒，所以"为什么被拒"必须能主动查出来 ——
   * 尤其是插件重启 / 上下文压缩之后，那条回执已经不在上下文里了。
   */
  undigestedChanges(call: OfficeCall): UndigestedChange[] {
    const { store, journal } = this.contextFor(call)
    return listUndigestedChanges(store, journal, this.process(call))
  }

  /**
   * 基线后走变更控制：建 CR（含影响分析）；`approved` 才应用变更。
   *
   * **§6.7**：重算评分时**规则维度按新内容重算、模型维度沿用**（`input.dimensions`
   * 显式重给时优先）—— 旧实现两次都没传，模型通道的语义分被规则基线抹掉，
   * "变更 → 重新基线"于是被 C1 误拦。
   *
   * **语义 A（2026-10-04）**：批准后**强制回退到需求阶段**（`change/rollback` 留痕）。
   * 真机证据：`CR-001` 批准 23 秒后 `task/claimed` 照常发生 —— 变更控制此前只登记/决策/算影响面，
   * 不改阶段、不碰基线，"需求变了"于是对开发阶段毫无约束。现在两半一起上：
   *   ① 阶段拉回需求阶段（实现代码写入随即被阶段纪律挡住）；
   *   ② `claim` 由 `change-not-digested` 拦住，直到"重新基线 + 重过设计门"两件都做完。
   * ②是硬约束（①只挡写入，`claim` 本不受阶段纪律约束）——回执必须把两半都写出来。
   */
  change(call: OfficeCall, input: CreateChangeInput): {
    change: ChangeRequest
    applied: boolean
    reason?: string | undefined
    /** 本次重算评分时语义分的来源（回执要如实写出来，不静默） */
    dimensionsFrom?: 'explicit' | 'carried' | 'none' | undefined
    /** 语义 A：批准触发的阶段回退（未触发时为 `undefined`） */
    rollback?: ChangeRollback | undefined
    /** **D-21 / R-25**：`replaceAcceptance` 造成的 AC 编号变动（交付矩阵的追溯键会失配） */
    acceptanceRenumbered?: { from: string; to: string }[] | undefined
  } {
    const { store, journal } = this.contextFor(call)
    const requirement = readRequirement(store, input.requirement)
    // **D-21**：AC 的合并与唯一性校验在**写 CR 之前**做完 —— 校验抛错时若 CR 已落盘，
    // 就会留下"变更单在册、内容没动"的半写状态（本项目最忌讳的"无声"）。
    // 合并实现与 `update` **同一份**（`mergeAcceptance`），两个入口不许漂移。
    const acceptance =
      requirement === undefined ? undefined : mergeAcceptance(store, requirement.acceptance, input)
    if (requirement === undefined) {
      const change = createChange(store, journal, input)
      markChangeNoop(journal, change, 'no-requirement')
      return { change, applied: false, reason: `找不到需求 ${input.requirement}` }
    }
    if (requirement.status !== 'baselined' && requirement.status !== 'changed') {
      const change = createChange(store, journal, input)
      // 需求还是草稿 ⇒ 没有任何"已冻结的内容"需要走变更控制（回执让调用方改用 `update`）：
      // 这条 CR 同样无内容可消化，不许拿它去锁 claim。
      markChangeNoop(journal, change, 'requirement-not-baselined')
      return {
        change,
        applied: false,
        reason: '需求尚未基线：直接更新即可，不必走变更控制（设计 §5.5）',
      }
    }
    const change = createChange(store, journal, input)
    if (input.decision !== 'approved') {
      return { change, applied: false, reason: `决策为 ${input.decision}，未应用变更（已留档）` }
    }
    // **D-22**：批准一条**什么都没改**的 CR 不许产生任何副作用（真机：空批准把阶段从 iteration
    // 打回 requirements、作废 G2/G3/GI/G6/G7、锁死全部 `claim`，代价是两次人工签字）。
    // 判定按**载荷与现值的差异**算，不解析 `changes[]` 的人读文案（文案会被改写、也会被本地化）。
    // 逐字段比现值的意义：把"同一个 statement 又提交了一遍"也如实算作"没有可变更的内容"。
    const patch = input.patch ?? {}
    const changedFields = (['title', 'statement', 'rationale', 'priority', 'kind'] as const).filter(
      (field) => field in patch && patch[field] !== requirement[field],
    )
    const acceptanceChanged = acceptance !== undefined && !sameAcceptance(requirement.acceptance, acceptance)
    if (changedFields.length === 0 && !acceptanceChanged) {
      markChangeNoop(journal, change, 'no-content-change')
      return {
        change,
        applied: false,
        reason: '本次变更**未改动任何字段**（与现值逐字段相同、验收标准也未变）：未改需求、未涨版本、未回退阶段、未作废门禁、认领不受影响',
      }
    }
    const next: Requirement = {
      ...requirement,
      ...(input.patch ?? {}),
      ...(acceptance === undefined ? {} : { acceptance }),
      status: 'changed',
      version: Math.round((requirement.version + 0.1) * 10) / 10,
      updatedAt: new Date().toISOString(),
    }
    const modelDimensions = normalizeModelDimensions(input.dimensions ?? requirement.ambiguity.modelDimensions)
    const scored = scoreRequirement({
      requirement: next,
      model: loadScoring(),
      ...(modelDimensions === undefined ? {} : { modelDimensions }),
      context: scoringContext(this.contextFor(call).project),
    })
    next.ambiguity = scored.ambiguity
    writeRequirement(store, next)
    journal.append('requirement/updated', { id: next.id, via: change.id, version: next.version })
    // **R-25 在变更路径上的同一条病**：`replaceAcceptance` 会改号，而 AC 编号是交付验收矩阵的
    // 追溯键 —— 编号变了必须**当场报出来**，否则"改一条 AC 文本"会静默作废已出的交付包。
    const renumbered =
      input.replaceAcceptance === undefined
        ? []
        : next.acceptance
            .map((ac, index) => ({ from: requirement.acceptance[index]?.id ?? '', to: ac.id }))
            .filter((item) => item.from !== '' && item.from !== item.to)
    return {
      change,
      applied: true,
      dimensionsFrom: input.dimensions !== undefined ? 'explicit' : modelDimensions !== undefined ? 'carried' : 'none',
      rollback: this.rollbackForChange(call, change, next.id, input.decidedBy),
      ...(renumbered.length === 0 ? {} : { acceptanceRenumbered: renumbered }),
    }
  }

  /**
   * 语义 A：批准的变更把阶段**拉回需求阶段**（`change/rollback` + `phase/rolled-back` 留痕）。
   *
   * 三处判断都有理由（都不静默）：
   *   · 已经在需求阶段 ⇒ 无需回退（`alreadyThere`）——没有回退边，也不该报错；
   *   · 有合法回退边 ⇒ 走 `rollbackPhase`（沿用 R-3/C-2E 的全部留痕与门禁作废口径）；
   *   · 没有合法回退边 ⇒ 照实回报 `error`（拦截仍由 `change-not-digested` 承担，不假装回退了）。
   */
  private rollbackForChange(call: OfficeCall, change: ChangeRequest, requirementId: string, by: string): ChangeRollback {
    const { journal, project } = this.contextFor(call)
    const process = processOfProject(project)
    // 需求阶段 = 出口门禁是 G2 的那个阶段（与 `baseline` 同源；四个随包流程都叫 requirements）
    const target = process.phases.find((phase) => phase.exit.includes('G2'))?.id ?? 'requirements'
    const from = project?.phase ?? ''
    const base: ChangeRollback = { from, to: target, invalidatedGates: [], stillWaivedGates: [], alreadyThere: false }
    if (project === undefined) return { ...base, error: t('uiOffice.rollbackNoProject') }
    if (from === target) return { ...base, alreadyThere: true }
    const outcome = this.rollbackPhase(call, { to: target, reason: fmt('uiChange.rollbackReason', { p1: change.id }), by })
    if (!outcome.ok) return { ...base, ...(outcome.error === undefined ? {} : { error: outcome.error }) }
    journal.append('change/rollback', {
      id: change.id,
      requirement: requirementId,
      from: outcome.from,
      to: outcome.to,
      by,
    })
    return {
      from: outcome.from,
      to: outcome.to,
      invalidatedGates: outcome.invalidatedGates,
      stillWaivedGates: outcome.stillWaivedGates,
      alreadyThere: false,
    }
  }

  // —————————————————————— M2：架构工程 ——————————————————————

  views(call: OfficeCall): DesignView[] {
    return listViews(this.storeFor(this.requireWorkspace(call)))
  }

  /** 新增/更新设计元素（`sdo_design action=create`）。 */
  upsertElement(call: OfficeCall, input: UpsertElementInput): { element: DesignElement; view: DesignView; created: boolean } {
    const { store, journal } = this.contextFor(call)
    return upsertElement(store, journal, input)
  }

  // —————————————— 增量 1：设计交互闭环（A）+ 界面视图（C）+ 设计文档（D） ——————————————

  /**
   * 生成设计问题（`sdo_design action=grill`）。
   *
   * **不看 G2/计划评审门禁**：它正是用来把门禁缺的东西问出来的 ——
   * 如果它也被门禁拦住，"未与我交流"就永远无解。
   */
  grillDesign(call: OfficeCall, input: GrillDesignInput = {}): GrillDesignResult {
    const { store, journal, project } = this.contextFor(call)
    return grillDesign(store, journal, project, listRequirements(store), input)
  }

  /** 回答一个设计问题（`sdo_design action=answer`）。 */
  answerDesign(call: OfficeCall, id: string, choice: string, note?: string, by?: string): GrillQuestion | undefined {
    const { store, journal } = this.contextFor(call)
    return answerDesign(store, journal, id, choice, note, by)
  }

  /** 把设计问题记为"用户授权按建议处理"。 */
  assumeDesign(call: OfficeCall, id: string, by: string): GrillQuestion | undefined {
    const { store, journal } = this.contextFor(call)
    return assumeDesign(store, journal, id, by)
  }

  /**
   * **需求阶段**提出规划级设计问题（§7.2 时机迁移）：方法论选择题。
   *
   * 复用同一个问题账本；幂等（已有则原样返回）。需求还没收集时返回 `undefined`。
   */
  askDesignQuestions(call: OfficeCall, input: {
    recommendation?: { method?: string | undefined; rationale?: string | undefined } | undefined
    by?: string | undefined
  } = {}): { question: GrillQuestion; created: boolean } | undefined {
    const { store, journal, project } = this.contextFor(call)
    return askDesignQuestions(store, journal, project, listRequirements(store), input)
  }

  /** 设计问题账本（`sdo_design action=issues`）：未决 + 已回答。 */
  designIssues(call: OfficeCall): { open: GrillQuestion[]; closed: GrillQuestion[] } {
    const { store } = this.contextFor(call)
    const all = listDesignQuestions(store)
    const open = all.filter(
      (question) => question.status === 'open' || (question.status === 'assumed' && question.authorizedByUser !== true),
    )
    const openIds = new Set(open.map((question) => question.id))
    return {
      open: open.sort((a, b) => a.id.localeCompare(b.id)),
      closed: all.filter((question) => !openIds.has(question.id)).sort((a, b) => a.id.localeCompare(b.id)),
    }
  }

  /**
   * 打用户确认戳（`sdo_design action=confirm`）。
   *
   * Y-1：目标在当前真源里解析不出内容时**拒绝写入**并返回 `undefined`
   * （旧实现照写一条 `contentHash: ''` 的记录，回执却说"确认成功" —— 那条确认永远不被承认，
   * 还顺手作废了 G3 签字）。调用方必须如实报告"没有确认成功"。
   */
  confirmDesign(
    call: OfficeCall,
    target: string,
    basis: string,
    by: string,
    basisSource: 'user' | 'proxy' = 'user',
    basisChecked?: 'session' | 'role-only' | 'unavailable' | undefined,
  ): { confirmation: DesignConfirmation } | { refused: 'no-basis' | 'replayed-basis' | 'unresolvable' } {
    const { store, journal } = this.contextFor(call)
    return confirmDesign(store, journal, target, basis, by, basisSource, basisChecked)
  }

  /** 关键条目确认缺口（`confirm` 的目标校验与门禁提示用）。 */
  designConfirmGaps(call: OfficeCall): ReturnType<typeof confirmGaps> {
    const { store, project } = this.contextFor(call)
    return confirmGaps(store, project, listRequirements(store))
  }

  /**
   * **内容已变、确认戳因此失效**的条目（F-19）。
   *
   * 写入动作的回执用它回答"这次改动让哪些确认失效了"，不需要重判整个门禁。
   */
  staleConfirmations(call: OfficeCall): StaleConfirmation[] {
    const { store } = this.contextFor(call)
    return staleConfirmations(store)
  }

  /** **名字与字段方向矛盾**的契约（F-16 存量残留诊断；只报不改）。 */
  contractDirectionAnomalies(call: OfficeCall): ContractDirectionAnomaly[] {
    const { store } = this.contextFor(call)
    return contractDirectionAnomalies(store)
  }

  /**
   * 契约字段的**YAML 类型提示**（F-20）：手写 YAML 把字段写成 number/boolean/对象时，
   * 回执与门禁详情要能点名"哪个契约、哪个字段、当前什么类型、建议写成什么"。
   */
  contractFieldNotes(call: OfficeCall): ContractFieldNote[] {
    const { store } = this.contextFor(call)
    return contractFieldNotes(store)
  }

  /**
   * **手写 YAML 的形状提示**（F-21）：列表 / 映射位置被写成别的形状、`dropped` 不是布尔时，
   * 回执、只读视图与相关门禁详情要能点名"哪个实体、哪个字段、实际形状、建议写法"。
   *
   * 报的是**当前真源整体状态**（与 F-16 的方向矛盾清单、F-20 的字段提示同口径）。
   */
  shapeNotes(call: OfficeCall): FieldShapeNote[] {
    const { store } = this.contextFor(call)
    return collectShapeNotes(store)
  }

  /** 设计草案（`grill` 返回体的第 ① 段）。 */
  designDraft(call: OfficeCall): DesignDraft {
    const { store, project } = this.contextFor(call)
    return designDraft(store, project, listRequirements(store))
  }

  /** 界面视图 + 确认状态 + 含 UI 判定（`sdo_design action=view kind=ui`）。 */
  uiView(call: OfficeCall): {
    view: UiView | undefined
    check: ReturnType<typeof uiConfirmation>
    decision: ReturnType<typeof uiDecision>
  } {
    const { store, project } = this.contextFor(call)
    return {
      view: readUiView(store),
      check: uiConfirmation(store),
      decision: uiDecision(project, listRequirements(store)),
    }
  }

  /** 写入界面视图（`sdo_design action=create kind=ui`，F-9）。返回落盘后的视图。 */
  writeUiView(call: OfficeCall, view: UiView): UiView {
    const { store, journal } = this.contextFor(call)
    return writeUiView(store, journal, view)
  }

  // —————————————— 增量 2：设计方法论方法包 ——————————————

  /** 现算「本项目启用了哪些方法包」（从问题账本解析，**不采信快照**）。 */
  /**
   * **方法包人审文档**的逐包状态（存在 / 指纹是否与台账一致 / 缺哪些条目 id）。
   *
   * 回执用它把"当前指纹"告诉模型（模型据此写文档头），判据 `design.method-docs` 用它判红绿。
   */
  methodDocStatuses(call: OfficeCall): MethodDocStatus[] {
    const workspace = this.requireWorkspace(call)
    const store = this.storeFor(workspace)
    const selection = methodSelection(store)
    if (selection.status !== 'chosen') return []
    return selection.methods.map((pkg) => methodDocStatus(store, workspace, pkg))
  }

  methodSelection(call: OfficeCall): MethodSelection {
    return methodSelection(this.storeFor(this.requireWorkspace(call)))
  }

  /** 全部方法产物（一个种类一个文件）。 */
  methodArtifacts(call: OfficeCall): MethodArtifact[] {
    return listMethodArtifacts(this.storeFor(this.requireWorkspace(call)))
  }

  /** 写入/合并一份方法产物（`sdo_design action=artifact`）。 */
  writeMethodArtifact(call: OfficeCall, kind: MethodArtifactKind, input: MethodArtifactInput): MethodArtifact {
    const { store, journal } = this.contextFor(call)
    return writeMethodArtifact(store, journal, kind, input)
  }

  /** 各包最小必产项判定（`design.method-products` 的判定核心）。 */
  methodProducts(call: OfficeCall): MethodProductsResult {
    const { store, workspace } = this.contextFor(call)
    // **工作区要传下去**：`porting` 包的"引用真实存在的模块/类型"需要工作区文件清单；
    // 不传会让查询路径比门禁路径**更松**（同一份真源判定不一致 = 口径分叉）。
    return methodProducts(store, listRequirements(store), workspace)
  }

  /** 方法产物之间的一致性判定（`design.method-consistency` 的判定核心）。 */
  methodConsistency(call: OfficeCall): MethodConsistencyResult {
    const { store } = this.contextFor(call)
    return methodConsistency(store, listRequirements(store))
  }

  /** 按账本刷新「本项目启用方法」快照（答案缺失/非法时返回 undefined，不覆盖旧快照）。 */
  refreshMethodSnapshot(call: OfficeCall): MethodSnapshot | undefined {
    const { store, journal } = this.contextFor(call)
    return refreshMethodSnapshot(store, journal)
  }

  /**
   * 渲染 `docs/DESIGN.md`（`sdo_design action=render`）。
   * **派生视图**：只读台账、只写文档，绝不反向写回台账。
   *
   * `puml`：**可选**。给了（或用 `true` 走默认落点 {@link DEFAULT_PUML_PATH}）就**额外**
   * 写一份 PlantUML **骨架源码**。⚠️ 本仓库没有 PlantUML 渲染器：这里只写 `.puml` 文件，
   * **不会**（也不声称会）把它渲染成图。
   *
   * **§2.5b（第二轮整体评审）**：`docs/DESIGN.md` 是人审交付物，可能被人手改（加批注）。
   * 手改**有人察觉**（C-25 逐字节比对判红），但旧实现的下一次渲染会把它**静默销毁**：既不留副本，
   * 渲染事件里也没有"覆盖了谁"的痕迹。现在：覆盖前先判断盘上那份**是不是我们上次渲染写下的**
   * （比 `design/rendered` 事件里记的 `sha256`），不是就先按 `file-history` 口径留一份副本，
   * 并把副本落点记进渲染事件（`snapshot`）。
   */
  renderDesign(call: OfficeCall, puml?: string | boolean | undefined): { path: string; bytes: number; pumlPath?: string | undefined; pumlBytes?: number | undefined } {
    const { store, journal, project, workspace } = this.contextFor(call)
    const seq = journal.read().events.length
    // 落点先算好再渲染：回执与实际写盘必须用**同一个**路径（口径分叉是这类功能的经典缺陷）。
    // `true` 与 `'true'` 都表示"要 PlantUML，走默认落点"（工具传字符串，直接调用更方便传布尔）。
    const target = puml === undefined || puml === false ? undefined : resolvePumlPath(puml === true || puml === 'true' ? undefined : String(puml))
    if (target !== undefined && 'error' in target) throw new Error(target.error)
    const text = renderDesignDoc({
      workspace,
      store,
      project,
      requirements: listRequirements(store),
      questions: listQuestions(store),
      seq,
    })
    // 覆盖前先看盘上那份是不是**上次渲染写下的**（§2.5b）：不是 ⇒ 有人手改过，先留副本再覆盖。
    const body = text.endsWith('\n') ? text : `${text}\n`
    const overwritten = this.snapshotHandEditedDesignDoc(call, workspace)
    writeDesignDoc(workspace, text)
    // 字节数由**刚渲染出来的文本**给出：再去读一遍盘既多余，也容易被沙箱差异带偏（回执报 0 字节）
    const bytes = Buffer.byteLength(text, 'utf8')
    // **R-10**：把渲染时的**阶段**也写进事件 —— 头里的 `phase` 只有能被事件背书才可信，
    // 否则任何人都能把它改成"我是在交付阶段渲染的"（阶段只出现在头里、不进正文，
    // 整份文件比对拦不住它）。
    // **§2.5b**：`sha256` 让"盘上这份是不是我们写的"变成可判定（下次渲染据此决定要不要留副本），
    // `snapshot` 则记下"这次覆盖前给谁留了副本"（没留就不写这个键）。
    journal.append('design/rendered', {
      kind: 'DESIGN.md',
      seq,
      bytes,
      phase: project?.phase ?? '',
      sha256: sha256Of(body),
      ...(overwritten === undefined ? {} : { snapshot: overwritten }),
    })
    if (target === undefined) return { path: 'docs/DESIGN.md', bytes }
    const pumlPath = target.path
    const pumlBytes = writePlantUml(workspace, pumlPath, plantUmlText(readUiView(store)))
    // F-1：puml 骨架同样记 `phase`（同一渲染动作的两份产物，记录口径一致）
    journal.append('design/rendered', { kind: pumlPath, seq, bytes: pumlBytes, phase: project?.phase ?? '' })
    return { path: 'docs/DESIGN.md', bytes, pumlPath, pumlBytes }
  }

  /**
   * **手改交付物在被覆盖前留副本**（§2.5b）。
   *
   * 判定"手改"的依据是**真源事件**，不是猜：上一条 `design/rendered`（`kind: DESIGN.md`）记了
   * 它当时写下的内容哈希；盘上这份对不上 ⇒ 渲染之后有人动过它。留副本走的是与 `.sdo/` 真源
   * **同一套** `file-history` 口径（同一上限、同一命名），落点返回给调用方记进渲染事件。
   *
   * 旧台账兼容：没有 `sha256` 的老事件只有 `bytes`（= **渲染文本**的字节数，而盘上文件由
   * `writeText` 补过一个尾换行，所以可能差 1）—— 差超过 1 字节才算"被动过"（一定改过 ⇒ 留副本）；
   * 差在 1 以内 = 无法判定 ⇒ **不留**，宁可少留也不把每次渲染都变成一次备份。
   * 新事件一律带 `sha256`（按**实际写盘的那份内容**算），这个模糊窗口从此关闭。任何异常都 fail-open。
   */
  private snapshotHandEditedDesignDoc(call: OfficeCall, workspace: string): string | undefined {
    try {
      const rooted = new SdoStore(workspace)
      const previous = rooted.readText('docs', 'DESIGN.md')
      if (previous === undefined) return undefined
      const last = this.contextFor(call)
        .journal.read()
        .events.filter((event) => event.type === 'design/rendered' && String(event.data['kind'] ?? '') === 'DESIGN.md')
        .at(-1)
      if (last === undefined) return undefined
      const recordedHash = typeof last.data['sha256'] === 'string' ? last.data['sha256'] : undefined
      const touched = recordedHash === undefined
        ? Math.abs(Buffer.byteLength(previous, 'utf8') - Number(last.data['bytes'] ?? -1)) > 1
        : sha256Of(previous) !== recordedHash
      if (!touched) return undefined
      // 留的是**被覆盖掉的那份**（人手改过的），不是即将写入的新渲染。
      return this.snapshotContent(workspace, 'docs/DESIGN.md', previous)
    } catch {
      return undefined
    }
  }

  adrs(call: OfficeCall): Adr[] {
    return listAdrs(this.storeFor(this.requireWorkspace(call)))
  }

  recordAdr(call: OfficeCall, input: RecordAdrInput & { supersedes?: string | undefined }): Adr {
    const { store, journal } = this.contextFor(call)
    return input.supersedes === undefined
      ? recordAdr(store, journal, input)
      : supersedeAdr(store, journal, { ...input, supersedes: input.supersedes })
  }

  scenarios(call: OfficeCall): QualityScenario[] {
    return listScenarios(this.storeFor(this.requireWorkspace(call)))
  }

  recordScenario(call: OfficeCall, input: RecordScenarioInput): QualityScenario {
    const { store, journal } = this.contextFor(call)
    return recordScenario(store, journal, input)
  }

  assessQuality(call: OfficeCall, input: { risks: string[]; sensitivities: string[]; tradeoffs: string[]; by: string }): QualityAssessment {
    const { store, journal } = this.contextFor(call)
    return writeAssessment(store, journal, input)
  }

  qualityAssessment(call: OfficeCall): QualityAssessment | undefined {
    return readAssessment(this.storeFor(this.requireWorkspace(call)))
  }

  contracts(call: OfficeCall): Contract[] {
    return listContracts(this.storeFor(this.requireWorkspace(call)))
  }

  recordContract(call: OfficeCall, input: RecordContractInput): Contract {
    const { store, journal } = this.contextFor(call)
    return recordContract(store, journal, input)
  }

  /** 建立追溯边（`sdo_trace action=link`）。 */
  linkTrace(call: OfficeCall, inputs: { from: string; to: string; kind: string }[]): { created: number } {
    const { store, journal } = this.contextFor(call)
    return linkMany(store, journal, inputs)
  }

  /** **F-5**：撤销一条追溯边（`links.jsonl` 里的坏行原样保留）。 */
  unlinkTrace(call: OfficeCall, input: { from: string; to: string; kind?: string | undefined }): { removed: number } {
    const { store, journal } = this.contextFor(call)
    return unlink(store, journal, input)
  }

  /** 追溯报告（覆盖率 + 孤儿）。 */
  traceReport(call: OfficeCall): TraceReport {
    const { store } = this.contextFor(call)
    return report(store, listRequirements(store))
  }

  /** 渲染 `docs/TRACE.md`（派生视图）。 */
  renderTrace(call: OfficeCall): string {
    const { store, journal, workspace } = this.contextFor(call)
    const seq = journal.read().events.length
    const text = renderTraceReport({
      report: report(store, listRequirements(store)),
      seq,
      header: renderHeader('.sdo/trace/links.jsonl', seq),
    })
    const target = new SdoStore(workspace).writeText(['docs', 'TRACE.md'], text)
    journal.append('evidence/recorded', { kind: 'render', doc: 'TRACE.md', seq })
    return this.relativize(workspace, target)
  }

  // —————————————————————— M2-06：架构阶段的计划评审（两道门） ——————————————————————

  /** 计划评审状态（源自 journal：`plan/mode` 与 `plan/review-blocked`）。 */
  planState(call: OfficeCall): {
    entered: boolean
    reviewed: boolean
    blockedReason?: string | undefined
    approvedBy?: string | undefined
    waivedReason?: string | undefined
  } {
    const events = this.journalFor(this.requireWorkspace(call)).read().events
    const modes = events.filter((event) => event.type === 'plan/mode')
    const firstEnter = modes.findIndex((event) => event.data['active'] === true)
    const entered = firstEnter >= 0
    const reviewed = entered && modes.slice(firstEnter + 1).some((event) => event.data['active'] === false)
    const blocked = [...events].reverse().find((event) => event.type === 'plan/review-blocked')
    const reason = blocked?.data['reason']
    // **出口（D1 修复）**：无 plan mode 时，用户仍可"在本会话内评审"或"显式豁免"，二者都留痕。
    const approved = [...events].reverse().find((event) => event.type === 'plan/review-approved')
    const waived = [...events].reverse().find((event) => event.type === 'plan/review-waived')
    return {
      entered,
      reviewed,
      ...(typeof reason === 'string' ? { blockedReason: reason } : {}),
      ...(typeof approved?.data['approvedBy'] === 'string' ? { approvedBy: approved.data['approvedBy'] } : {}),
      ...(typeof waived?.data['reason'] === 'string' ? { waivedReason: waived.data['reason'] } : {}),
    }
  }

  /** SDO 主动驱动进入 plan mode 后留痕。 */
  markPlanEntered(call: OfficeCall): void {
    this.journalFor(this.requireWorkspace(call)).append('plan/mode', { active: true, by: 'sdo' })
  }

  /** 观察到计划评审已结束（离开 plan mode）→ 留痕。 */
  markPlanReviewed(call: OfficeCall): void {
    this.journalFor(this.requireWorkspace(call)).append('plan/mode', { active: false, by: 'human' })
  }

  /** 用户在**本会话内**完成了计划评审（无 plan mode 时的出口之一）。 */
  markPlanApproved(call: OfficeCall, approvedBy: string, note?: string | undefined): void {
    this.journalFor(this.requireWorkspace(call)).append('plan/review-approved', {
      approvedBy,
      ...(note === undefined ? {} : { note }),
      at: new Date().toISOString(),
    })
  }

  /** 显式豁免计划评审（出口之二）：按设计"可显式豁免并留痕"，必须写明理由与豁免人。 */
  waivePlanReview(call: OfficeCall, reason: string, by: string): void {
    this.journalFor(this.requireWorkspace(call)).append('plan/review-waived', {
      reason,
      by,
      at: new Date().toISOString(),
    })
  }

  /** 无交互评审通道：按 Q-20 阻塞（留痕 `plan/review-blocked`，不触达 G3）。 */
  markPlanBlocked(call: OfficeCall, reason: string): void {
    this.journalFor(this.requireWorkspace(call)).append('plan/review-blocked', { reason, at: new Date().toISOString() })
  }

  /**
   * 架构阶段的前置判定（设计 §8.5 / Q-17 / Q-20）：
   *   G2 未过 → gate-blocked；无评审通道 → blocked-no-reviewer；未进 plan mode → needs-plan-mode；
   *   仍在 plan mode → plan-review-pending；评审完成 → ready。
   */
  designPrecondition(
    call: OfficeCall,
    plan: { available: boolean; active: boolean },
  ):
    | { kind: 'no-project' }
    | { kind: 'gate-blocked'; check: ReturnType<SoftwareDevOffice['designCheck']> }
    | { kind: 'blocked-no-reviewer'; reason: string }
    | { kind: 'needs-plan-mode' }
    | { kind: 'plan-review-pending' }
    | { kind: 'ready' } {
    const check = this.designCheck(call)
    if (check.reason.includes('没有任何需求')) return { kind: 'gate-blocked', check }
    if (!plan.available) {
      // 没有 plan mode **不等于没有出口**（D1 修复）：① 用户在本会话内评审过；② 显式豁免过。
      const reviewed = this.planState(call)
      if (reviewed.approvedBy !== undefined || reviewed.waivedReason !== undefined) {
        if (!check.allowed) return { kind: 'gate-blocked', check }
        return { kind: 'ready' }
      }
      const reason = 'plan review requires an interactive reviewer'
      if (this.planState(call).blockedReason !== reason) this.markPlanBlocked(call, reason)
      return { kind: 'blocked-no-reviewer', reason }
    }
    const state = this.planState(call)
    if (!state.entered) return { kind: 'needs-plan-mode' }
    if (plan.active) return { kind: 'plan-review-pending' }
    if (!state.reviewed) this.markPlanReviewed(call)
    if (!check.allowed) return { kind: 'gate-blocked', check }
    return { kind: 'ready' }
  }

  // —————————————————————— M4：拆分、协同与验证 ——————————————————————

  /** 拆分任务（结构通道 + 模型建议）。 */
  planDecompose(call: OfficeCall, input: DecomposeInput = {}): { tasks: TaskCard[]; issues: PlanIssue[]; notes?: string[] | undefined; structuralCount?: number | undefined; structural?: StructuralPlan | undefined } {
    const { store, journal } = this.contextFor(call)
    const current = readIteration(store)
    // 已经有进行中的迭代时，拆出来的卡自动归入该迭代（否则迭代门禁无从判定）
    return decompose(store, journal, listRequirements(store), {
      ...input,
      ...(input.iteration === undefined && current !== undefined ? { iteration: current.number } : {}),
    })
  }

  /**
   * **结构通道的判定/护栏读数**（TASK-074 落点三）：`sdo_plan action=next` 的回执要逐条列出
   * 这批结构卡（标题 + 写范围 + 判定依据），而 `next` 自己不拆卡 ⇒ 它从同一份判定现算。
   *
   * 注意它是**计划**不是"本次新建"：`next` 这一轮一张卡都没建，回执说的是"当前这批结构卡的
   * 判定结果"（该建的建了没有、哪些元素没建、为什么）。
   */
  structuralPlan(call: OfficeCall): StructuralPlan {
    const { store } = this.contextFor(call)
    return structuralPlanOf(store, listRequirements(store))
  }

  tasks(call: OfficeCall): TaskCard[] {
    return listTasks(this.storeFor(this.requireWorkspace(call)))
  }

  taskById(call: OfficeCall, id: string): TaskCard | undefined {
    return this.tasks(call).find((task) => task.id === id)
  }

  planIssues(call: OfficeCall): PlanIssue[] {
    // **DEF-055**：把**项目声明的文案面**（`.sdo/config.yml` 的 `plan.textPaths`）交给判据 ——
    // 否则 `ui-text-scope` 只能看到"项目没声明"，把"声明了但本卡写范围不含"这种真红报成同一句话。
    return validatePlan(this.tasks(call), { textPaths: textPathsOf(this.storeFor(this.requireWorkspace(call))) })
  }

  /**
   * **"为什么这一轮派不出去"的分类**（DEF-049 落点二）：blocked 卡 / 写范围冲突 / 依赖未满足
   * 三类**分列**。以前只有一句笼统的"没有可派发的任务卡"，于是有 blocked 卡的情形被读成"活干完了"。
   * 结构化结果（无文案）由 `index.ts` 渲染成语言包文案 —— `plan.ts` 的 i18n 棘轮基线是 0。
   *
   * **DEF-040**：第四类 `gate-stale`（当前阶段入口门禁签字失效）也在这里带出去 —— 失效期间
   * `readyForDispatch` 返回空，若回执不点名门禁，读者看到的就是"本轮没有可派发的卡"（读成"活干完了"）。
   */
  nonDispatchable(call: OfficeCall): NonDispatchablePlan {
    // **DEF-080（第六批 §3.6）**：把"被跟踪文件的未提交改动"也交给分类器 —— 写范围互斥过去只查
    // **认领卡**与**卡与卡**，而"别人未提交的交付"不属于任何卡。`git` 读不动（不是仓库/没有 git）
    // ⇒ 传 `undefined` ⇒ 这一类**不判**（判不了不拦，与 `DEF-054`/`R17` 同一方向），原因在 `reason` 里。
    const root = this.workspaceRootFor(call) ?? call.cwd
    // **第七批 §3.1 F4**：这里也必须把**三种状态**如实传下去（上一批只传 `ok ? tracked : undefined`
    // ⇒ 诊断面把"读不动"折叠成了"没判"＝与"干净"逐字节相同 —— 同一判据的**两个消费点**都得改）。
    const dirty: DirtyRead = root === undefined
      ? { ok: false, reason: '无法确定工作区根（拿不到 cwd / 会话登记）' }
      : ((): DirtyRead => {
          const read = readDirtyWorktree(root)
          return read.ok ? { ok: true, tracked: read.tracked } : { ok: false, reason: read.reason ?? '' }
        })()
    return classifyNonDispatchable(this.tasks(call), this.staleEntryGate(call), dirty)
  }

  /**
   * **DEF-081（第六批 §3.7）**：`drop` 之前的**依赖者扫描**（只读）。
   *
   * 真正作废仍走 `dropTask` 唯一出口；这里只回答"作废它会把谁永久吊住"，由调用方决定拒还是放行。
   */
  dropBlockers(call: OfficeCall, taskId: string): { direct: TaskCard[]; downstream: TaskCard[] } {
    return dropDependents(this.tasks(call), taskId)
  }

  /**
   * **复用投递的消费观测**（DEF-014）：现算每一笔**复用投递**（`dispatch/started reused=true`）
   * 之后有没有可观测的消费信号（认领 / 结算）；窗口内没动静的不报，窗口外报「未见消费」。
   * 判据在 `domain/dispatchHealth.ts`（纯函数，`test/m158` 直接测它）。
   */
  reuseDeliveries(call: OfficeCall, windowMs?: number | undefined): ReuseDelivery[] {
    const { journal } = this.contextFor(call)
    return reuseDeliveriesOf(
      this.tasks(call),
      journal.read().events,
      windowMs === undefined ? {} : { windowMs },
    )
  }

  /**
   * **某个会话是不是"有资格处置卡的生命周期"的驾驶舱**。
   *
   * 为什么不能只写 `roleOf(call) === 'cockpit'`：`roleOf` → `attributeRole` 的口径里
   * **根会话永远是驾驶舱**（R-1），而 `roleOf` 这条路径**不传** `delegationDepth`/`parentSessionId`
   * ⇒ 认不出的会话一律**回落到 `cockpit`**（fail-open）。于是"只看角色"等于**任何会话都能 unblock
   * 任何卡**，落点一形同虚设。
   *
   * 本仓里唯一**正面**可证的信号是：这个会话是不是被**派发出去**的子代理
   * （`dispatch/started.childSessionId`，插件自己记的追加式真源）。据此这条判定的完整口径是：
   *   · 是某个派发的**子代理** ⇒ **不是**驾驶舱（它只有自己那张卡的处置权，凭"原 owner"走另一条路）；
   *   · **认得出是根会话**（`roleOf` 返回 `cockpit`，即无父会话且深度 0）且不是子代理 ⇒ 驾驶舱。
   *
   * **诚实边界**：本仓没有"驾驶舱令牌"这类正面凭证，所以一个**既没认领过卡、也没被派发过**的
   * 根会话（例如同一进程里另开的一个普通会话）在现有身份口径下**与技术上的驾驶舱不可区分** ——
   * 它会被这条规则放行。要收紧它得动 `attributeRole` 的全局身份口径（不在本卡写范围内），
   * 因此这里如实写明，而不是假装已经挡住（也不单方面改全局策略）。
   */
  canAdministerTasks(call: OfficeCall): boolean {
    if (this.isDispatchedChild(call)) return false
    return this.roleOf(call) === 'cockpit'
  }

  /**
   * **从 blocked 恢复为 ready**（DEF-049 落点一）。
   *
   * 授权判定**在工具层算好**（"当前调用是哪个会话"只有那里拿得到），这里只执行裁决。
   * 允许两种身份：该卡**原 owner**（本会话就是它最后一次 `task/claimed` 的会话，
   * 凭 `claimBaseline` 的 `sessionId` 证，与 `release`/`update` 同一口径），或**驾驶舱**
   * （口径与边界见 `canAdministerTasks`）。
   */
  unblockTask(call: OfficeCall, input: { taskId: string; reason: string; by: string }): UnblockResult {
    const { store, journal } = this.contextFor(call)
    const ownSession = call.sessionId !== undefined && call.sessionId !== '' && claimBaseline(journal, input.taskId)?.sessionId === call.sessionId
    return unblock(store, journal, { ...input, authorized: ownSession || this.canAdministerTasks(call) })
  }

  /**
   * **当前阶段入口门禁的失效状态**（DEF-040 / §3E 族 6）。
   *
   * 为什么在 `office.ts` 这一层做：`signatureState` 需要 store + journal，而 `plan.ts` 是纯函数层
   * （保持可穷举测试）⇒ 这里把"结论"（`StaleGate`）算好再传进去，而不是把 journal 灌进域层。
   * 门禁 id 取自**流程数据**的 `phases[].entry`（`entryGates`，**不硬编码 `G3`**）。
   *
   * ⚠️ **只认 `status === 'stale'`**（签过字但按口径失效 —— B-28 真机剧本要拦的正是它）。
   * `missing`（从来没签过）**返回 `undefined` 即放行**：把它也当"不许派"，会让所有还没走到该门禁
   * 签字的正常流程一律停摆（本仓 `construction` 阶段就是 `entry: [G3]`，历史卡在多种签字状态下派出）。
   */
  /**
   * **当前阶段入口门禁的签字状态**（DEF-040）—— 派发面的入口。
   *
   * 判据本身**不在这里**：`staleEntryGateOf`（`domain/entryGate.ts`）是唯一出口，
   * 认领面（`collab.ts` 的 `claim`）调的是同一个函数 —— 两处各写一遍必然漂移。
   */
  private staleEntryGate(call: OfficeCall): StaleGate | undefined {
    const { store, journal, project } = this.contextFor(call)
    return staleEntryGateOf(store, journal, project)
  }

  readyForDispatch(call: OfficeCall, limit = 4): TaskCard[] {
    // **DEF-040**：当前阶段入口门禁失效（`stale`）⇒ 这里就返回空（缺省时行为与以前逐字节相同）
    return readyTasks(this.tasks(call), limit, this.staleEntryGate(call))
  }

  /** 认领（CAS）。 */
  /** D3-3：把卡置为 dropped（回收路径）。 */
  dropTask(call: OfficeCall, taskId: string, reason: string): TaskCard | undefined {
    const { store, journal } = this.contextFor(call)
    return dropTask(store, journal, taskId, reason)
  }

  /** **`DEF-118`**：带判定细节的 drop（已完成卡会被拒并给出路）。工具面走这一个。 */
  dropTaskChecked(call: OfficeCall, taskId: string, reason: string): DropOutcome {
    const { store, journal } = this.contextFor(call)
    return dropTaskChecked(store, journal, taskId, reason)
  }

  /** **`DEF-118`**：`reopen`（done/verified → in-progress，须带 reason + approvedBy）。 */
  reopenTask(call: OfficeCall, input: { taskId: string; reason: string; approvedBy: string }): LifecycleOutcome {
    const { store, journal } = this.contextFor(call)
    return reopenTask(store, journal, input)
  }

  /** **`DEF-118`**：`restore`（dropped → 上一状态，须带 reason + approvedBy）。 */
  restoreTask(call: OfficeCall, input: { taskId: string; reason: string; approvedBy: string }): LifecycleOutcome {
    const { store, journal } = this.contextFor(call)
    return restoreTask(store, journal, input)
  }

  /** 作废契约（回收路径，留痕）。 */
  dropContract(call: OfficeCall, contractId: string, reason: string): Contract | undefined {
    const { store, journal } = this.contextFor(call)
    return dropContract(store, journal, contractId, reason)
  }

  /**
   * **B5 的角色缓存版本号**：只在"会话 ↔ 卡"关系会变的事件（认领/回报）后 +1。
   * 工具钩子是热路径，不能每次都重读 journal 来推角色；版本号一变才重算。
   */
  roleCacheVersion = 0

  claimTask(call: OfficeCall, input: ClaimInput): ClaimResult {
    const { store, journal } = this.contextFor(call)
    // A2：认领时记下"发生在哪个会话"，`done` 据此取本会话的真实改动做写范围对账
    const sessionId = input.sessionId ?? call.sessionId
    /**
     * **`DEF-162` 第①条（`TASK-171`）：认领面的角色校验** —— 「流程官只记账、实现派给该角色的执行者」
     * 这条分工过去**只写在文档里**（真机样本：驾驶舱以 `owner=cockpit` 认领了 `role=developer` 的卡，
     * 并且真的开工了）。现在它在两个面上有机械对手方，本处是**认领面**：
     *
     * · **驾驶舱 / 流程官**认领 `role ∈ {developer, tester}` 的卡 ⇒ **拒绝**，回执点名卡的 role、
     *   owner 认出的角色、以及合法形态；
     * · owner 形态**认不出角色**（`dev-a` / `张三`…）⇒ **放行**（fail-open）：认不出人不该变成干不了活，
     *   这一面由**收口判据** `C-76` 兜底（那时"谁做的"是台账事实，认不出即点名）；
     * · 角色对得上 ⇒ 照旧走 `claim()` 的 CAS / 写范围 / 门禁陈旧等全部既有判定（一字不改）。
     *
     * 拒绝要**留痕**（`task/claim-rejected`，与 `DEF-059` 同口径）：不带事件就数不出"争用了几次"。
     * `code` 沿用既有的 `not-claimable`（拒绝码集合在 `collab.ts`，不在本卡写范围），另带
     * `cause: 'owner-role'` 让这一类能单独聚合 —— 不标注就等于没分类。
     */
    const card = listTasks(store).find((task) => task.id === input.taskId)
    if (card !== undefined) {
      const verdict = ownerClaimVerdict(input.owner, textOf(card.role))
      if (!verdict.ok) {
        const detail = fmt('uiCollab.kOwnerClaimRejected', {
          p1: card.id,
          p2: textOf(card.role),
          p3: input.owner,
          p4: verdict.role,
          p5: OWNER_ROLE_FORMS,
        })
        journal.append('task/claim-rejected', {
          id: card.id,
          by: input.owner,
          code: 'not-claimable',
          cause: 'owner-role',
          detail,
          ...(sessionId === undefined ? {} : { sessionId }),
        })
        this.roleCacheVersion += 1
        return { ok: false, code: 'not-claimable', detail, current: card }
      }
    }
    /**
     * **owner 的新形态**（`ADR-022` 裁决③ / `DEF-133` / `DEF-165` ②）：有会话 uuid 就**现算**
     * `<角色>-<uuid 前 8 位>`，不再采信调用方自报的槽位名。
     *
     * 为什么在这里算而不是在 `claim()` 里：`claim()` 是**通用**入口（不知道调用方是谁的会话），
     * 而"身份"的唯一可靠来源是宿主给的 `call.sessionId` —— 它在这一层。三类**不折算**：
     *   · 驾驶舱 / 流程官（`cockpit`）—— `inline` 后端就是它，`ADR-022` 明写保留；
     *   · 认不出角色的 owner —— 不猜（认不出人不该变成干不了活，收口 `C-76` 再点名）；
     *   · 拿不到会话 id（历史调用面 / 测试夹具）—— 保持原样，**不改写历史**（`ADR-022`：老卡不迁移）。
     */
    const declaredOwner = textOf(input.owner).trim()
    const claimedRole = ownerRoleOf(declaredOwner)
    const sessionText = textOf(sessionId).trim()
    const canonicalOwner = card === undefined
      || sessionText.length < OWNER_SESSION_LENGTH
      || claimedRole === undefined
      || claimedRole === COCKPIT_OWNER
      || claimedRole === 'office'
      ? declaredOwner
      : ownerOf(textOf(card.role), sessionText)
    /**
     * **一个 owner 串只对应一个会话**（`DEF-165` ② 的判据面）。
     *
     * 反例格（真机）：`subagent:developer:1` 同时指过 `e4d9fbaf` 与 `ebcd8a06` —— 那时投递会**同时唤醒
     * 两个会话**。新形态由会话 uuid 现算，正常不会撞；所以这里判的是**撞了就不许落账**（8 位前缀
     * 真撞上、或调用方手塞了一个已被别的会话用过的串）。判据只认 `task/claimed` 事件（工具写的，改不动）。
     *
     * **门槛必须是 `minSessions: 1`**（`TASK-172` 修）：修前用的是回执那份 `minSessions: 2` 的读数
     * （只列"已经被两个会话共用过"的 owner）⇒ 第二次认领时台账里还只有**一个**会话用过它 ⇒ 判不出来，
     * 要等两个会话都把卡占下来才"看得见" —— 而那时"一个 owner 指向两个会话"已经落账了。
     * 认领面要问的是**将来会不会撞**，所以这里读"这个串被哪些会话用过（≥1）"。
     *
     * **只对"认得出角色的 owner 形态"判**（`claimedRole !== undefined`）：这条守据治的是**可投递的地址**
     * 被两个会话共用（`subagent:developer:1` 那种槽位名，拿它投递会同时唤醒两个人）。认不出角色的名字
     * （`dev` / `张三`）**不是地址**，跟 `ownerClaimVerdict` 一样 fail-open —— 它们在**收口**由 `C-76`
     * 点名（"谁做的"必须说得出来）。把匿名名也拦下只会让同一个人的不同会话互相打架，治不了本缺陷。
     */
    if (canonicalOwner !== '' && sessionText !== '' && claimedRole !== undefined) {
      const users = this.ownerCollisions(call, 1).filter((row) => row.owner === canonicalOwner)
      const clash = users.find((row) => row.sessions.some((id) => id !== sessionText))
      if (clash !== undefined) {
        const detail = fmt('uiCollab.kOwnerCollision', {
          p1: canonicalOwner,
          p2: sessionText,
          p3: clash.sessions.filter((id) => id !== sessionText).join(' / '),
          p4: clash.taskIds.join(' ') || (card?.id ?? input.taskId),
        })
        journal.append('task/claim-rejected', {
          id: input.taskId,
          by: canonicalOwner,
          code: 'not-claimable',
          cause: 'owner-collision',
          detail,
          sessionId: sessionText,
        })
        this.roleCacheVersion += 1
        return { ok: false, code: 'not-claimable', detail, ...(card === undefined ? {} : { current: card }) }
      }
    }
    const claimInput = { ...input, ...(canonicalOwner === declaredOwner ? {} : { owner: canonicalOwner }) }
    const outcome = claim(store, journal, sessionId === undefined ? claimInput : { ...claimInput, sessionId })
    this.roleCacheVersion += 1
    return outcome
  }

  /**
   * **同一个 owner 串被几个会话用过**（`DEF-165` ② / `DEF-133` 的可定位性读数）。
   *
   * 只读 `task/claimed`（`owner` 与 `sessionId` 都是工具写的）；`minSessions` 缺省 2 ⇒
   * 一条 owner 对应一个会话时不出行，"有行"本身就是缺陷形态：那个 owner 拿来投递会指向不确定的人。
   * 现盘的历史记录（`subagent:developer:1` 指过两个会话）就靠这一行**可见**，而不是靠记忆。
   *
   * @param minSessions 认领面传 **1**（问"将来会不会撞"）；回执/诊断用缺省 2（只报已经脏了的）
   */
  ownerCollisions(call: OfficeCall, minSessions = 2): { owner: string; sessions: string[]; taskIds: string[] }[] {
    const { journal } = this.contextFor(call)
    return ownerSessionCollisions(
      journal.read().events
        .filter((event) => event.type === 'task/claimed')
        .map((event) => ({
          owner: textOf(event.data['owner']),
          sessionId: textOf(event.data['sessionId']),
          taskId: textOf(event.data['id']),
        })),
      minSessions,
    )
  }

  /**
   * **发布计划落盘**（`TASK-176` / `TASK-178` 的写入口）。
   *
   * 为什么必须走这里而不是手写 YAML：`writeRelease` 在落盘的同时写一条 `release/written`
   * （带 `frozen` 与条数）—— `C-75` 的 `frozenAtSeq` 要能核到"那一刻真的一次人签"；
   * 手写的 `frozenBy: human` 核不到任何东西（`freeze-unwitnessed`）。
   * 形状不合法 ⇒ 整次拒绝（`writeRelease` 抛错），不许落半成品让别人读到。
   */
  releaseWrite(call: OfficeCall, release: Release): {
    ok: boolean
    detail: string
    release?: Release | undefined
    seq?: number | undefined
  } {
    const { store, journal } = this.contextFor(call)
    try {
      const written = writeRelease(store, journal, release)
      const seq = journal.read().events.filter((event) => event.type === 'release/written').at(-1)?.seq
      return {
        ok: true,
        release: written,
        ...(seq === undefined ? {} : { seq }),
        detail: fmt('uiRelease.kReleaseWritten', {
          p1: written.id,
          p2: String(seq ?? '?'),
          p3: textOf(written.frozenBy) === HUMAN_APPROVER ? 'true' : 'false',
        }),
      }
    } catch (error) {
      return {
        ok: false,
        detail: fmt('uiRelease.kReleaseWriteRejected', { p1: error instanceof Error ? error.message : String(error) }),
      }
    }
  }

  /**
   * **顺延留痕的写入面**（`TASK-176` 交接 / `AC-277`）：把"这几条这一版不做"写成 `release/deferred`。
   *
   * 必须交代的三件事实（缺一个这条留痕就核不了）：**哪些 id**、**从哪一版到哪一版**、**第几次**；
   * 外加**批准人只认 human**（`ADR-022` 裁决①）。
   *
   * 为什么还要求"这些 id 必须已经在当前版 `nonScope` 里登记"：留痕与登记是两件事，但只认**成对**的
   * —— 否则谁都能凭空落一条"顺延留痕"去豁免 `C-73` 的静默顺延判定（那等于给假绿开一条通道）。
   * 反过来说，登记了却没留痕，正是 `C-73` 要判红的形态（`AC-277`）。
   */
  releaseDefer(call: OfficeCall, input: ReleaseDeferInput): {
    ok: boolean
    detail: string
    ids?: string[] | undefined
    seq?: number | undefined
  } {
    const { store, journal } = this.contextFor(call)
    const ids = [...new Set((input.ids ?? []).map((id) => textOf(id).trim()).filter((id) => id !== ''))]
    if (ids.length === 0) return { ok: false, detail: t('uiRelease.kDeferIdsEmpty') }
    if (textOf(input.approvedBy).trim() !== HUMAN_APPROVER) return { ok: false, detail: t('uiRelease.kDeferApprover') }
    if (!Number.isInteger(input.deferCount) || input.deferCount < 1) return { ok: false, detail: t('uiRelease.kDeferCountInvalid') }
    let releases: Release[]
    try {
      releases = listReleases(store)
    } catch (error) {
      return {
        ok: false,
        detail: fmt('uiRelease.kDeferRejected', { p1: error instanceof Error ? error.message : String(error) }),
      }
    }
    const current = currentRelease(releases)
    if (current === undefined) return { ok: false, detail: t('uiRelease.kDeferNoRelease') }
    const fromVersion = textOf(input.fromVersion).trim() === '' ? packageVersionOf(current) : textOf(input.fromVersion).trim()
    const registered = new Set(deferredIdsOf(current))
    const unregistered = ids.filter((id) => !registered.has(id))
    if (unregistered.length > 0) {
      return { ok: false, detail: fmt('uiRelease.kDeferNotRegistered', { p1: unregistered.join(' '), p2: current.id }) }
    }
    const data: Record<string, unknown> = {
      ids,
      fromVersion,
      deferCount: input.deferCount,
      approvedBy: HUMAN_APPROVER,
      reason: textOf(input.reason).trim(),
      releaseId: current.id,
    }
    const toVersion = textOf(input.toVersion).trim()
    if (toVersion !== '') data['toVersion'] = toVersion
    const event = journal.append('release/deferred', data)
    return {
      ok: true,
      ids,
      seq: event.seq,
      detail: fmt('uiRelease.kDeferWritten', {
        p1: ids.join(' '),
        p2: fromVersion,
        p3: toVersion === '' ? t('uiRelease.kDeferToUnknown') : toVersion,
        p4: String(input.deferCount),
        p5: HUMAN_APPROVER,
        p6: String(event.seq),
      }),
    }
  }

  /** 回报（done 必须带证据）。 */
  reportTask(call: OfficeCall, input: ReportInput): ReportResult {
    const { store, journal } = this.contextFor(call)
    const result = reportTask(store, journal, input)
    if (result.ok) this.roleCacheVersion += 1
    if (result.ok && input.status === 'done') {
      // 完成的卡自动挂上"任务→需求"的追溯边（覆盖率与影响分析都靠它）
      const task = result.task
      if (task.requirements.length > 0) {
        linkMany(
          store,
          journal,
          task.requirements.map((requirement) => ({ from: requirement, to: task.id, kind: 'req-task' })),
        )
      }
    }
    return result
  }

  /** **追加式勘误**（DEF-071）：done 卡也能补说明，但**只能追加**、不改写历史正文。 */
  addErrata(call: OfficeCall, input: { taskId: string; by: string; note: string }): ReturnType<typeof addErrata> {
    const { store, journal } = this.contextFor(call)
    return addErrata(store, journal, input)
  }

  releaseTask(call: OfficeCall, input: { taskId: string; actor: string; reason: string }): TaskCard | undefined {
    const { store, journal } = this.contextFor(call)
    return release(store, journal, input)
  }

  reassignTask(call: OfficeCall, input: { taskId: string; actor: string; owner: string; reason: string }): TaskCard | undefined {
    const { store, journal } = this.contextFor(call)
    return reassign(store, journal, input)
  }

  /** 疑似失联（只报告，不自动释放）。 */
  staleTasks(call: OfficeCall, ttlMs = 15 * 60_000): TaskCard[] {
    return staleClaims(this.tasks(call), ttlMs)
  }

  /**
   * **派发健康度**（DEF-053）：孤儿写锁 + 派发未认领。
   *
   * 只**报告**（真源纪律：失联 owner 不自动释放，防误抢），产出 `release` 命令与可审计事件。
   */
  dispatchHealth(call: OfficeCall, options: { nowMs?: number | undefined; claimWindowMs?: number | undefined } = {}): {
    orphans: OrphanLock[]
    claimMissing: ClaimMissing[]
  } {
    const { journal } = this.contextFor(call)
    const events = journal.read().events
    const tasks = this.tasks(call)
    return {
      orphans: orphanLocks(tasks, events),
      claimMissing: claimMissing(tasks, events, {
        ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
        ...(options.claimWindowMs === undefined ? {} : { windowMs: options.claimWindowMs }),
      }),
    }
  }

  /**
   * **认领争用的可数读数**（DEF-059）：真源是 `task/claim-rejected` 事件，按 `拒绝码 × 卡` 聚合。
   */
  claimRejections(call: OfficeCall): { total: number; rows: { code: string; taskId: string; by: string; count: number }[] } {
    const { journal } = this.contextFor(call)
    const counts = new Map<string, { code: string; taskId: string; by: string; count: number }>()
    let total = 0
    for (const event of journal.read().events) {
      if (event.type !== 'task/claim-rejected') continue
      total += 1
      const code = textOf(event.data['code'])
      const taskId = textOf(event.data['id'])
      const by = textOf(event.data['by'])
      const key = `${taskId}|${code}|${by}`
      const row = counts.get(key) ?? { code, taskId, by, count: 0 }
      row.count += 1
      counts.set(key, row)
    }
    const rows = [...counts.values()].sort((a, b) => b.count - a.count || a.taskId.localeCompare(b.taskId))
    return { total, rows }
  }

  /** 给"派发未认领"落一条**可审计**事件（同一笔派发只落一次：按 `startedSeq` 去重）。 */
  noteClaimMissing(call: OfficeCall, rows: readonly ClaimMissing[]): number {
    const { journal } = this.contextFor(call)
    const events = journal.read().events
    const noted = new Set(
      events
        .filter((event) => event.type === 'dispatch/claim-missing')
        .map((event) => Number(event.data['startedSeq'])),
    )
    let appended = 0
    for (const row of rows) {
      if (noted.has(row.startedSeq)) continue
      journal.append('dispatch/claim-missing', {
        task: row.taskId,
        childSessionId: row.childSessionId,
        startedSeq: row.startedSeq,
        minutes: row.minutes,
        ended: row.ended,
        reason: row.reason,
      })
      appended += 1
    }
    return appended
  }

  /** 容量预算内的派发计划。 */
  dispatchPlan(call: OfficeCall, maxParallel = this.settings.maxParallelDispatch): { dispatch: TaskCard[]; queued: TaskCard[]; held: ScopeHold[] } {
    const tasks = this.tasks(call)
    const inProgress = tasks.filter((task) => task.status === 'in-progress').length
    // **DEF-067 落点一**：写范围与在飞卡相交的卡**不派**（派了也认领失败）—— 判定走 `scopeHeldTasks`。
    const held = scopeHeldTasks(tasks)
    const heldIds = new Set(held.map((row) => row.task.id))
    const plan = capacityPlan(
      readyTasks(tasks, 64, this.staleEntryGate(call)).filter((task) => !heldIds.has(task.id)),
      inProgress,
      maxParallel,
    )
    return { ...plan, held }
  }

  /** 记录派发决策（含后端、降级原因与"显式指定覆盖了迭代锁"的留痕）。 */
  recordDispatch(call: OfficeCall, input: { taskId: string; backend: string; owner: string; degradedReason?: string | undefined; overrideNote?: string | undefined }): void {
    const { journal } = this.contextFor(call)
    journal.append('dispatch/decided', {
      task: input.taskId,
      backend: input.backend,
      owner: input.owner,
      degradedReason: input.degradedReason ?? '',
      // **D-15**：与 `degradedReason` 分开记 —— 降级 = 结果不等于请求；覆盖 = 结果等于请求（锁让路）。
      overrideNote: input.overrideNote ?? '',
    })
  }

  /**
   * **真派发留痕（P-1）**：宿主真的起了一次子代理运行 —— 记下 provider、子会话 id 与下发的工具数。
   * （只在 `startDispatch` 返回 `started:true` 时调用；失败只写 `dispatch/decided`，不写这里。）
   */
  recordDispatchStarted(call: OfficeCall, input: {
    taskId: string
    provider: string
    childSessionId: string
    /**
     * **派发它的父会话**（DEF-066）：宿主只允许父会话复用**自己**的子会话
     *（跨父会话报 `belongs to another parent session`）。不记它，池读数就分不清
     * "本会话真能投"与"跨父会话会被拒" —— 真机读数与行为直接矛盾（空闲 31 vs 永远 spawn）。
     */
    parentSessionId?: string | undefined
    /** **SDO 流程面白名单**条数（受角色职责分离控制的那一部分） */
    tools: number
    /** **实际下发的 deny 面**条数（通用面硬禁止 ∪ SDO 补集） */
    denyTools?: number | undefined
    /** 实际下发的 deny 名单（审计用：回执里说"挡了什么"要有台账可查） */
    deny?: string[] | undefined
    /** 该角色在 SDO 流程面可用的工具（审计用） */
    sdoAllow?: string[] | undefined
    role?: string | undefined
    /** 宿主给这个子代理的模式：`continuable` 才能被复用（老事件没这个字段 ⇒ 按 one-shot 读） */
    mode?: 'continuable' | 'one-shot' | undefined
    /** 这次是**复用**已有子代理（真复用）还是新起一个 */
    reused?: boolean | undefined
    /** 这一轮子代理的**掩码指纹**（SDO-52）：复用前要比对，不符即强制新起 */
    maskHash?: string | undefined
    /**
     * **复用投递的宿主回执**（DEF-014）：`sendMessage` 的返回值归一成的一行文本。
     * 不记它，「指令投出去没有」就无从查证（旧实现直接丢弃返回值）。
     */
    messageReceipt?: string | undefined
    /**
     * **这次派发的 owner 身份**（`ADR-022` 裁决③ = `<角色>-<会话 uuid 前 8 位>`）。
     *
     * 为什么在**派发之后**才写：派发之前拿不到子会话 id（它就是派发的产物），所以
     * `dispatch/decided.owner` 记的是**声明的角色面**，这里记的是**可定位的身份**。
     * 认领时 `ownerOf(卡的角色, 会话 id)` 现算，两者一致 ⇒ 一个 owner 串只对应一个会话。
     */
    owner?: string | undefined
  }): void {
    const { journal } = this.contextFor(call)
    journal.append('dispatch/started', {
      task: input.taskId,
      provider: input.provider,
      childSessionId: input.childSessionId,
      ...(input.owner === undefined ? {} : { owner: input.owner }),
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      tools: input.tools,
      ...(input.denyTools === undefined ? {} : { denyTools: input.denyTools }),
      ...(input.deny === undefined ? {} : { deny: input.deny }),
      ...(input.sdoAllow === undefined ? {} : { sdoAllow: input.sdoAllow }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.maskHash === undefined ? {} : { maskHash: input.maskHash }),
      ...(input.reused === undefined ? {} : { reused: input.reused }),
      // **DEF-014**：复用投递的宿主回执进真源（旧实现把它丢了 ⇒「投出去没有」无从查证）
      ...(input.messageReceipt === undefined ? {} : { messageReceipt: input.messageReceipt }),
    })
    // **§2 第 1 条**：派发（尤其**复用**同一子会话换角色）会改变这个会话的血缘角色 ⇒ 让角色缓存立刻失效，
    // 否则新掩码最多滞后一个 TTL（旧实现只认领/回报时 +1）。
    this.roleCacheVersion += 1
  }

  /* ———————————— 工作副本（主仓库 worktree）与合并：`REQ-066` / `AC-304` / `AC-305` ———————————— */

  /**
   * 仓库 top level（**副本建在它与它的索引之外**）。不是 git 仓库 ⇒ `undefined`：
   * 判不了就不做副本（**不阻断派发** —— 副本是隔离手段，不是派发的前置承诺）。
   */
  private repoTopFor(call: OfficeCall): string | undefined {
    const root = this.workspaceRootFor(call) ?? call.cwd
    if (root === undefined || root === '') return undefined
    const top = repoTopOf(root)
    return top === '' ? undefined : top
  }

  /**
   * **这张卡的工作副本**（`worktree/created` 里记的现场；被 `worktree/removed` 抹掉后为 `undefined`）。
   * 读的是**追加式事件**而不是目录存在性：目录在不在是派生事实，台账才是真源。
   */
  worktreeFor(call: OfficeCall, taskId: string): { path: string; branch: string; base: string } | undefined {
    const { journal } = this.contextFor(call)
    const events = journal.read().events.filter(
      (event) => (event.type === 'worktree/created' || event.type === 'worktree/removed')
        && String(event.data['task'] ?? '') === taskId,
    )
    const last = events.at(-1)
    if (last === undefined || last.type === 'worktree/removed') return undefined
    const path = String(last.data['path'] ?? '')
    if (path === '') return undefined
    return { path, branch: String(last.data['branch'] ?? ''), base: String(last.data['base'] ?? '') }
  }

  /**
   * **派发时建工作副本**（`AC-304` 的前半：子代理在**自己的副本**里写，不写别人的树）。
   *
   * 三种结果如实回报：`created` / `exists`（上一轮建的还在，不重复建）/ `skipped`
   * （不是 git 仓库、或 `git worktree add` 失败 —— 原因带出去，**不假装有副本**）。
   */
  prepareWorktree(call: OfficeCall, taskId: string): {
    state: 'created' | 'exists' | 'skipped'
    path: string
    branch: string
    base: string
    detail: string
  } {
    const existing = this.worktreeFor(call, taskId)
    if (existing !== undefined) return { state: 'exists', ...existing, detail: '' }
    const top = this.repoTopFor(call)
    if (top === undefined) return { state: 'skipped', path: '', branch: '', base: '', detail: 'not-a-repo' }
    const { journal } = this.contextFor(call)
    const created = createGitWorktree({ repoRoot: top, taskId })
    if (!created.ok) {
      return { state: 'skipped', path: '', branch: '', base: '', detail: `${created.code}: ${created.detail}` }
    }
    journal.append('worktree/created', {
      task: taskId,
      path: created.ref.path,
      branch: created.ref.branch,
      base: created.ref.base,
      head: created.ref.head,
    })
    return { state: 'created', ...created.ref, detail: '' }
  }

  /**
   * **完成时：把副本里的工作提交、合并回主干、清场**（`AC-304` 的后半 / `AC-305`）。
   *
   * 四态（**不许混**，混了就没法给人可执行的下一步）：
   *   · `none` —— 这张卡没有副本（非 git 仓库 / 已清场）⇒ 什么都不做（旧路径照旧）；
   *   · `merged` —— 提交 + 合并完成（`changedFiles` 就是回执要报的那份清单），**随后清场**；
   *   · `conflict` —— 两边真改了同一处：**主工作树已还原、副本现场保留**，`conflictFiles` 点名；
   *     调用方**不得**把这样的卡当"完成"（合并被阻断，见 `AC-305` 第三档）；
   *   · `failed` —— 压根没开始合并（主工作树脏 / 分支不在 / git 不可用），原因带出去。
   *
   * **不自动解决冲突**：本方法不传 `-X ours/theirs`、不跳过、不 `--continue`（见 `worktree.ts`）。
   */
  finishWorktree(call: OfficeCall, input: { taskId: string; message?: string | undefined }):
    | { state: 'none' }
    | { state: 'merged'; path: string; branch: string; base: string; changedFiles: string[]; commit: string; committed: boolean }
    | { state: 'conflict'; path: string; branch: string; conflictFiles: string[] }
    | { state: 'failed'; path: string; detail: string } {
    const site = this.worktreeFor(call, input.taskId)
    if (site === undefined) return { state: 'none' }
    const top = this.repoTopFor(call)
    if (top === undefined) return { state: 'failed', path: site.path, detail: 'not-a-repo' }
    const { journal } = this.contextFor(call)
    // ① 副本里**未提交**的工作必须先收进分支（`git merge` 只搬提交 —— 不提交就是"零变更"假绿）
    const commit = commitWorktree({ path: site.path, ...(input.message === undefined ? {} : { message: input.message }) })
    if (!commit.ok) return { state: 'failed', path: site.path, detail: `${commit.code}: ${commit.detail}` }
    // ② 真三路合并（`worktree.ts` 里没有任何 `-X ours/theirs`）
    const merged = mergeGitWorktree({
      repoRoot: top,
      taskId: input.taskId,
      ...(input.message === undefined ? {} : { message: input.message }),
    })
    if (merged.ok) {
      journal.append('worktree/merged', {
        task: input.taskId,
        path: site.path,
        branch: merged.branch,
        base: merged.base,
        changedFiles: merged.changedFiles,
        commit: merged.commit,
        committed: commit.committed,
      })
      // ③ 合并成功 ⇒ 清场（`AC-304` 的"建 → 写 → 合并 → 移除"闭环）
      const removed = removeGitWorktree({ repoRoot: top, taskId: input.taskId, base: merged.base })
      if (removed.ok) journal.append('worktree/removed', { task: input.taskId, path: removed.path, branch: site.branch, reason: 'merged' })
      return {
        state: 'merged',
        path: site.path,
        branch: merged.branch,
        base: merged.base,
        changedFiles: merged.changedFiles,
        commit: merged.commit,
        committed: commit.committed,
      }
    }
    if (merged.kind === 'conflict') {
      journal.append('worktree/conflict', {
        task: input.taskId,
        path: site.path,
        branch: merged.branch,
        conflictFiles: merged.conflictFiles,
      })
      return { state: 'conflict', path: site.path, branch: merged.branch, conflictFiles: merged.conflictFiles }
    }
    return { state: 'failed', path: site.path, detail: merged.detail }
  }

  /**
   * **清场**（合并成功之后，或卡被 `drop`）：`git worktree remove` + 删分支，并留 `worktree/removed`。
   *
   * `force: true` 给 `drop` 那一路（`AC-305` 的口径：冲突现场**不许**被默认行为抹掉 ——
   * 只有显式的强制清场才可能删掉未合并的副本）。
   */
  dropWorktree(call: OfficeCall, taskId: string, force = false): { state: 'removed' | 'kept' | 'none'; detail: string } {
    const site = this.worktreeFor(call, taskId)
    if (site === undefined) return { state: 'none', detail: '' }
    const top = this.repoTopFor(call)
    if (top === undefined) return { state: 'kept', detail: 'not-a-repo' }
    const removed = removeGitWorktree({ repoRoot: top, taskId, force })
    if (!removed.ok) return { state: 'kept', detail: `${removed.code}: ${removed.detail}` }
    this.contextFor(call).journal.append('worktree/removed', {
      task: taskId,
      path: removed.path,
      branch: site.branch,
      reason: force ? 'dropped' : 'merged',
    })
    return { state: 'removed', detail: removed.detail }
  }

  /** 副本里**还没提交**的工作（诊断面：完成时先看它，别让合并变成"零变更"）。 */
  worktreePending(call: OfficeCall, taskId: string): { ok: boolean; files: string[]; detail: string } {
    const site = this.worktreeFor(call, taskId)
    if (site === undefined) return { ok: true, files: [], detail: 'none' }
    return pendingWorkOf(site.path)
  }

  /** 现盘**全部**副本（诊断/守卫用：`git worktree list` 的投影，含主工作树）。 */
  worktrees(call: OfficeCall): ReturnType<typeof listWorktrees> {
    const top = this.repoTopFor(call)
    return top === undefined ? [] : listWorktrees(top)
  }

  /**
   * **角色池现状**（子代理复用）：从 `dispatch/started`/`dispatch/finished` 现算 ——
   * 谁在飞、谁空闲可复用、还能收几张卡。插件重启不会丢（真源是 append-only 台账）。
   */
  poolView(call: OfficeCall): RolePool[] {
    return this.poolSnapshot(call).pools
  }

  /** 池快照（**只读一次 journal**）：孩子状态 + 每个角色的池 + 待派卡。 */
  private poolSnapshot(call: OfficeCall, orphanTtlMinutes?: number): { children: PoolChild[]; pools: RolePool[]; ready: TaskCard[] } {
    const { journal } = this.contextFor(call)
    const children = [
      ...foldPoolChildren(journal.read().events.map((event) => ({ type: event.type, data: event.data, at: event.at }))).values(),
    ]
    // **DEF-040**：门禁失效时池快照的 ready 也必须是空（否则回执会怂恿驾驶舱派卡）
    const ready = readyTasks(this.tasks(call), 64, this.staleEntryGate(call))
    return {
      children,
      ready,
      pools: rolePools({
        children,
        // **DEF-066**：把"空闲可复用"按**宿主会不会拒**分栏（本会话 / 跨父会话 / 父会话未知）
        viewerSessionId: call.sessionId ?? '',
        reuseBudget: { maxRounds: this.settings.reuseMaxRounds },
        roles: ready.map((task) => task.role),
        caps: this.settings.poolCaps,
        defaultCap: this.settings.maxParallelDispatch,
        // 真机缺陷修复：未结算的僵尸派发不再永久占位（超时即孤儿），TTL 可配
        // **R-9**：TTL 覆盖也要进池快照（否则状态行说"在飞"、派发路径却按覆盖后的 TTL 放行 —— 又是两套口径）
        orphanTtlMs: (orphanTtlMinutes ?? this.settings.dispatchOrphanTtlMinutes) * 60_000,
        nowMs: Date.now(),
        reuseBlockedOf: this.reuseBlockedOf(call),
        // **R-6**：掩码指纹判据**就在这里**（纯函数，从 `roles.yml` 现算）—— 以前只有
        // `admitDispatch` 内部判，于是池视图把"掩码过期的空闲会话"算成可复用、`freeSlots` 被占掉，
        // 真机上 developer 的有效并发从 4 掉到 2 且回执自相矛盾（池满 + 空闲可复用 N）。
        maskHashOf: (role: string) => (isRole(role) ? maskFingerprint(role) : ''),
      }),
    }
  }

  /**
   * **R-1（sdo-test-new 2026-10-08 复测，major）**：该空闲子代理**有没有"能用"的证据**。
   *
   * 真机事实：修复前构建创建的 `f4ae86fa`（descriptor `toolFilter.allow: []`）在修复后**又被复用了两次**，
   * 两次都是"无工具 → 把工具调用写成正文 → 1 轮结束"。复用判定当时只比 `maskHash`（角色 allow∪deny 的指纹），
   * 而"这个会话**创建时**实际拿到几个工具"是**创建期**的事实 —— 掩码指纹覆盖不到它。
   *
   * 现在的口径：**复用要求正面证据** —— `child-tools.jsonl` 里观测到这个子会话**公告面非空**。
   * 观测到零工具、或根本没有观测记录，一律**强制新起**（新起永远是对的；复用只是省一次会话创建的优化），
   * 原因写进 `reuseSkipped` 由回执点名，并且这类会话**不再占池位**（否则 `cap=1` 的角色会永久排队）。
   *
   * **DEF-021（族 2，2026-10-14）**：再加一条**与工具面无关**的判据 —— 这个空闲会话**手上是不是还有在飞卡**。
   * 数据源是**卡的在飞状态**（`claimsBySession`），不是 `dispatch/*` 事件：两者会分叉 —— 子代理结算了一轮
   * （`dispatch/finished` ⇒ 池里显示空闲可复用），却**没回报卡**（卡仍 `in-progress`）。此时把新卡投进去
   * = 同一个会话里两张卡互相踩（真机：池把 TASK-018 复用给持在飞卡的 `20af1d60`）。
   * ⇒ 这类会话**不许复用**，回执点名它手上那张卡。
   *
   * 这一条**必须只在这里写一次**：`rolePools`（池视图）与 `admitDispatch`（准入）拿的是**同一个**闭包
   * ⇒ 读数与行为不可能分叉（R-6 的教训；DEF-040 同款"唯一出口"口径）。
   */
  private reuseBlockedOf(call: OfficeCall): (child: PoolChild) => string | undefined {
    let faces: ChildFaceEntry[] | undefined
    try {
      faces = this.childFaces(call)
    } catch {
      faces = undefined // 读不到观测 ⇒ 一律"没有证据"（下面按没有观测处理）
    }
    const byId = new Map((faces ?? []).map((face) => [face.childSessionId, face]))
    // **`DEF-165` ①（`TASK-172`）**：**观测事件**是 R-1 的**第一证据**（可引用、带序号）；
    // `child-tools.jsonl` 那份退为**兼容面**（本卡之前的历史会话只有文件、没有事件）。
    let observed = new Map<string, ReturnType<typeof readChildObservations>[number]>()
    try {
      observed = new Map(readChildObservations(this.contextFor(call).journal).map((row) => [row.childSessionId, row]))
    } catch {
      observed = new Map()
    }
    // **DEF-021**：会话 ↔ 在飞卡 的唯一出口（同一份真源 `task/claimed` × 卡状态现算）
    const { store, journal } = this.contextFor(call)
    const heldBySession = new Map(claimsBySession(store, journal).map((claim) => [claim.sessionId, claim.cardId]))
    return (child: PoolChild): string | undefined => {
      // 先判"手上有卡"：它比工具面观测更上游 —— 一个连工具面都没观测到的会话，也不该在持卡时被复用
      const held = heldBySession.get(child.childSessionId)
      if (held !== undefined) return fmt('uiPool.kReuseHoldsCard', { p1: held })
      const face = byId.get(child.childSessionId)
      const event = observed.get(child.childSessionId)
      if (event === undefined && face === undefined) return '没有该子会话的工具面观测（无法确认它手里有工具）→ 强制新起'
      // 两条证据任一为"零工具"就判不可复用；工具数取两者里**更宽**的那一份（证据不互相遮掩）
      const toolCount = Math.max(event?.toolCount ?? 0, face?.tools.length ?? 0)
      if (toolCount === 0) return '该会话创建时拿到 0 个工具（历史零工具派发）→ 强制新起'
      return undefined
    }
  }

  /**
   * 该卡是否「挂起后**原样重派**」（`task/blocked` 之后卡内容没改过就又被派）——派发回执要如实提示。
   * 真机教训：同一张卡、同一理由挂起后原样重派，等于让它再撞一次同一堵墙。
   */
  unresolvedBlock(call: OfficeCall, taskId: string): { reason: string; seq: number } | undefined {
    const { journal } = this.contextFor(call)
    return findUnresolvedBlock(
      journal.read().events.map((event) => ({ type: event.type, data: event.data, at: event.at })),
      taskId,
    )
  }

  /**
   * **派发准入（池 + 队列）**：先全局并行预算、再逐角色池；池满的卡**排队**（不丢）。
   *
   * @param options.reuseIdle 宿主有没有可续聊入口 —— 没有时"空闲子代理"不可投递（one-shot 结算即消失），
   *   此时池退化为**并发上限**（这一点必须在回执里说清，不能假装在复用）。
   */
  poolPlan(call: OfficeCall, options: {
    reuseIdle?: boolean | undefined
    freshChild?: boolean | undefined
    /** **孤儿 TTL 覆盖**（R-9 的逃生口）：`sdo_plan action=next orphanTtlMinutes=N` —— 卡被未结算派发冻住时不必改 preset 重启 */
    orphanTtlMinutes?: number | undefined
  } = {}): PoolAdmission {
    const snapshot = this.poolSnapshot(call, options.orphanTtlMinutes)
    const { journal } = this.contextFor(call)
    const tasks = this.tasks(call)
    const inProgress = tasks.filter((task) => task.status === 'in-progress').length
    // **一张卡不许同时在两个子代理里**：已有"在飞"派发（started 未 finished）的卡不重复派 ——
    // 队列语义是"每张卡只入队一次"。代价要如实说：派发丢了的卡会一直算在飞，直到结算或人工处置。
    const ttlMinutes = options.orphanTtlMinutes ?? this.settings.dispatchOrphanTtlMinutes
    const orphanTtlMs = ttlMinutes * 60_000
    const nowMs = Date.now()
    // 只有**活着的**在飞才挡住同一张卡的重复派发；超时未结算（孤儿）不挡（否则那张卡永远派不出去）
    //
    // **R-9（sdo-test-new 2026-10-08，major）**：判据还要看"卡是不是**被显式放回来**过" ——
    // 真机：4 张卡的子会话被停（`dispatch/started` 有、`finished` 无 ⇒ 孤儿），操作者把卡 `release`
    // 回 `ready` 之后再派，回执却是"没有可派发的任务卡"：因为这里只看**派发记录**、不看卡状态，
    // 卡被冻结到孤儿 TTL（默认 60 分钟），而 TTL 只能从 preset 改。
    // 现在：该卡的 `task/released` 事件若**晚于**它的 `dispatch/started`，就说明操作者已判定那个子会话没了
    // ⇒ **不再冻结**（"一张卡不许同时在两个子代理里"防的是并行，而 release 就是操作者的显式判定）。
    const releasedAfterDispatch = new Set<string>()
    {
      const lastDispatch = new Map<string, number>()
      const lastRelease = new Map<string, number>()
      for (const event of journal.read().events) {
        const id = String(event.data['id'] ?? event.data['task'] ?? '')
        if (id === '') continue
        if (event.type === 'dispatch/started') lastDispatch.set(id, event.seq)
        if (event.type === 'task/released') lastRelease.set(id, event.seq)
      }
      for (const [id, seq] of lastRelease) {
        if ((lastDispatch.get(id) ?? -1) < seq) releasedAfterDispatch.add(id)
      }
    }
    const liveChildren = snapshot.children.filter((child) => child.state === 'busy' && !isStaleDispatch(child, nowMs, orphanTtlMs))
    const inFlight = new Set(
      liveChildren.map((child) => child.task).filter((taskId) => !releasedAfterDispatch.has(taskId)),
    )
    // **R-9**：把"被谁冻着、冻了多久"交回给回执（否则 `k30` 那句"都已认领/完成"是假话）
    const heldByDispatch = liveChildren
      .filter((child) => inFlight.has(child.task))
      .map((child) => ({
        taskId: child.task,
        childSessionId: child.childSessionId,
        minutes: Math.max(0, Math.round((nowMs - (Date.parse(child.startedAt) || nowMs)) / 60_000)),
      }))
    // **SDO-30（2026-10-05 真机）**：把「最近派发过」的卡排到后面 —— 旧实现固定按 `size → id` 排序，
    // 关键的小卡（如解冻卡）排在 8 张同类卡之后被反复跳过（真机只能靠人肉 `send_message` 直指卡号）。
    // 「最近派发时间」从 `dispatch/started` 的 `startedAt` 现算：**没派过的排最前**。
    const lastDispatched = new Map<string, string>()
    for (const child of snapshot.children) {
      if (child.task === '') continue
      if (child.startedAt > (lastDispatched.get(child.task) ?? '')) lastDispatched.set(child.task, child.startedAt)
    }
    const fairReady = [...snapshot.ready].sort((a, b) =>
      (lastDispatched.get(a.id) ?? '').localeCompare(lastDispatched.get(b.id) ?? '') || a.id.localeCompare(b.id),
    )
    // **`REQ-066` / `ADR-025` · `AC-303`（`TASK-172`）**：相交**默认照派**、只点名；只有两类串行。
    // 所以这里要**两份读数**：`scopeIntersections` 全量（回执点名用）与 `serialScopeIds`（真挡用）。
    // 修前只有一份 —— 于是"挡住"与"点名"被绑死：想不挡就只能丢掉可见性（m32 那类"约束不存在"）。
    const intersections = scopeIntersections(tasks)
    const heldByScope = intersections.map((row) => ({
      taskId: row.task.id,
      holderId: row.holder.id,
      holderOwner: row.holder.owner ?? '',
      overlap: row.overlap,
      kind: row.kind,
    }))
    const serialScopeIds = new Set(intersections.filter((row) => row.kind !== 'merge').map((row) => row.task.id))
    // **DEF-080（第七批 §3.1 F1/F2）—— 真拦**：写范围压在**未提交的被跟踪改动**上的卡**本轮不派**。
    // 为什么必须在这一层拦：这一层（`admission`）是**两条派发路径共用的候选筛选**（`plan.dispatch`），
    // 而上一批只把 `dirty` 接进 `describeNonDispatchable` ⇒ 它只出现在 `why=true` / 队列满 / 无卡三支，
    // **派发主路径（`sdo_plan action=next`）既不停卡、回执也一个字不提**（F1 的真机读数）。
    // 口径与 `heldByScope` 完全同构：**跳过该卡、不阻断整轮**；回执单列一行点名**相交的那条未提交路径**。
    const dirtyRead = ((): DirtyRead | undefined => {
      const root = this.workspaceRootFor(call) ?? call.cwd
      if (root === undefined) return undefined
      const read = readDirtyWorktree(root)
      return read.ok ? { ok: true, tracked: read.tracked } : { ok: false, reason: read.reason ?? '' }
    })()
    const dirtyRows = dirtyRead?.ok === true ? dirtyScopeHolds(tasks, dirtyRead.tracked) : []
    const dirtyByScope = dirtyRows.filter((row) => row.grade === 'block').map((row) => ({
      taskId: row.task.id,
      over: row.over,
    }))
    // **F5**：超宽 glob（分档键 = **字面前缀段数** ≤1：`**` / `src/**` / `src/*` …）**只提示不拦**
    // —— 否则任何脏文件都会挡住这种卡（`DEF-090` 起把键名写进注释，与判据表同源）
    const dirtyHints = dirtyRows.filter((row) => row.grade === 'hint').map((row) => ({
      taskId: row.task.id,
      over: row.over,
    }))
    const dirtyScopeIds = new Set(dirtyByScope.map((row) => row.taskId))
    const admission = admitDispatch({
      // **`REQ-066` 收窄（`ADR-025`）**：只有**真需要串行**的两类才拦（任一方声明独占窗口 /
      // 写范围无法判定 fail-closed）；其余相交只点名、照派。`DEF-067` 原来的"相交即不派"已按用户
      // 2026-10-22 的裁定收窄 —— 拦截本身也会让合法卡白等（`AC-303` 的反向守卫：拦住 `merge` 也红）。
      ready: fairReady.filter((task) =>
        !inFlight.has(task.id) && !serialScopeIds.has(task.id) && !dirtyScopeIds.has(task.id)),
      pools: snapshot.pools,
      globalRoom: Math.max(0, this.settings.maxParallelDispatch - inProgress),
      // **R-5 症状 D**：全局预算拒收回执要报**真实**的"进行中"张数（旧实现硬编码 0）
      inProgress,
      reuseIdle: options.reuseIdle === true,
      // **DEF-069**：余量阈值**由项目声明**（`reuseMaxRounds`，默认 0=未声明 ⇒ 不判）；与池视图同一判据
      reuseBudget: { maxRounds: this.settings.reuseMaxRounds },
      // **R-13**：强制新起时，"可复用空闲"不参与容量计算（否则 freshChild 在池满时等于自锁）
      ...(options.freshChild === true ? { forceNew: true } : {}),
      // 与 `poolSnapshot` **同一个**纯函数（`rolePools` 的 `unusable` 也用它）⇒ 池视图与准入永不分叉
      maskHashOf: (role: string) => (isRole(role) ? maskFingerprint(role) : ''),
      // **R-1**：复用还要**证据**（该子会话被观测到手里有工具），不只是掩码指纹一致
      reuseBlockedOf: this.reuseBlockedOf(call),
    })
    // **R-14**：派发前的静态可行性（只看机械可判的两条；文案在界面层）
    const infeasible = [...fairReady, ...snapshot.ready]
      .map((task) => ({ task, gaps: capabilityGaps(task, task.role) }))
      .filter((row) => row.gaps.length > 0)
      .map((row) => ({ taskId: row.task.id, role: row.task.role, gaps: [...row.gaps] }))
      // 同一张卡可能出现两次（fairReady 是 snapshot.ready 的重排）⇒ 去重
      .filter((row, index, all) => all.findIndex((item) => item.taskId === row.taskId) === index)
    return {
      ...admission,
      heldByDispatch,
      infeasible,
      ...(heldByScope.length === 0 ? {} : { heldByScope }),
      ...(dirtyByScope.length === 0 ? {} : { dirtyByScope }),
      ...(dirtyHints.length === 0 ? {} : { dirtyHints }),
      ...(dirtyRead?.ok === false ? { dirtyUnjudgeable: { reason: dirtyRead.reason } } : {}),
    }
  }

  /**
   * **补记文件清单**（A2 的竞态修法）：宿主先 append `workspace/changes` 事件、之后才写摘要记录，
   * 所以采集当时拿不到文件清单。`done` 时（会话仍活着）再取一次，取到就补一条带摘要的记录。
   */
  noteResolvedWorkspaceChanges(call: OfficeCall, input: { sessionId: string; seq: number; files: string[] }): void {
    const { store, journal } = this.contextFor(call)
    // **§2.1（第二轮评审 HIGH）**：补记以前**不带 `journalSeq`**，而读者（`changedFilesSince`）要求它 ——
    // 于是补记出来的条目**永远不命中**：`unresolvedSeqs` 反复列同一批、越界写永不告警（真机 seq 42）。
    // 修法：与原记录**同量纲** —— 复用同一 `(sessionId, hostSeq)` 已有条目的 `journalSeq`；
    // 找不到就退回"该会话最近一条 `workspace/changes` 事件的 journal seq"；两者都拿不到 ⇒ 不写（如实"未对账"）。
    const existing = readWorkspaceChanges(store).entries.find(
      (entry) => entry.sessionId === input.sessionId && entry.seq === input.seq && entry.journalSeq !== undefined,
    )
    // 抓不到原条目（宿主事件没进插件真源）时，退回"补记这一刻的 journal 序号"——它**同样 > 认领序号**，
    // 语义是"这批文件是在这个时点被对账到的"，读者照样能命中（关键是**不能缺这个键**）。
    const journalSeq = existing?.journalSeq ?? journal.read().events.at(-1)?.seq
    // 连一个 journal 序号都拿不到（真源为空）⇒ **不写**：写一条没有量纲键的条目正是修前那种"永远不命中、
    // 还被反复列为未对账"的坏状态；宁可让回执如实说"未对账"。
    if (journalSeq === undefined) return
    recordWorkspaceChanges({
      store,
      sessionId: input.sessionId,
      seq: input.seq,
      journalSeq,
      summary: { files: input.files.map((path) => ({ path })) },
      enabled: true,
      hasProject: true,
    })
  }

  /**
   * **决定实现阶段方法包**（增量 3）：把"选了哪些包 / 依据 / 范围 / 豁免"落成真源。
   *
   * 设计要点：**不问用户**（由模型自选），但必须**有据可查** —— `derivedFrom` 至少一条能被机械核对，
   * 校验不通过就整次拒绝（不写盘）。复议 = 再调一次：覆盖 profile，并把这一次追加进 `history`。
   */
  decideConstructionProfile(
    call: OfficeCall,
    input: {
      packages: string[]
      scope: typeof SCOPE_ALL | string[]
      derivedFrom: string[]
      reason: string
      exempt: ConstructionExemption[]
      by: string
    },
  ):
    | { ok: true; profile: ConstructionProfile; checked: string[]; unchecked: string[] }
    | { ok: false; problems: string[] } {
    const { store, journal } = this.contextFor(call)
    const problems: string[] = []
    if (input.packages.length === 0) problems.push(t('uiConstruction.c18'))
    for (const name of input.packages) {
      if (!(CONSTRUCTION_PACKAGES as readonly string[]).includes(name)) problems.push(fmt('uiConstruction.c02', { p1: name }))
    }
    if (input.derivedFrom.length === 0) problems.push(t('uiConstruction.c04'))
    for (const name of input.scope === SCOPE_ALL ? [] : input.scope) {
      if (!listTasks(store).some((task) => task.id === name)) problems.push(fmt('uiConstruction.c19', { p1: name }))
    }
    // **R1 附带（第三批实测）**：`.trim()` 只对**字符串**安全 —— 除"缺键"之外，**类型不对**也必须走
    // **可读拒绝**而不是崩栈（实测：把 `impact` 照抄成 `sdo_task` 的**数组**形态时，这里抛
    // `(item.impact ?? '').trim is not a function` —— 工具面直接炸，而不是给一句人话）。
    // 口径：只有非空**字符串**才算"写了"；其余（缺键 / 数组 / 数字 / 对象）一律按"没写"处理 ⇒ 由 c40/c41 点名。
    const exemptText = (value: unknown): string => (typeof value === 'string' ? value : '')
    for (const item of input.exempt) {
      if (exemptText(item.why).trim() === '') problems.push(fmt('uiConstruction.c20', { p1: item.task, p2: item.check }))
      if (!(CONSTRUCTION_CHECKS as readonly string[]).includes(item.check)) problems.push(fmt('uiConstruction.c21', { p1: item.check }))
      // **DEF-030**：豁免是"跳过一条判据"的动作 ⇒ 新的豁免必须当场说清**谁批准**、**放掉的是什么**。
      // 旧条目不受影响（读端宽容 + 状态面标"未署名"）；但**新写进来**的缺一即整次拒绝（不写盘）。
      if (exemptText(item.approvedBy).trim() === '') problems.push(fmt('uiConstruction.c40', { p1: item.task, p2: item.check }))
      if (exemptText(item.impact).trim() === '') problems.push(fmt('uiConstruction.c41', { p1: item.task, p2: item.check }))
    }
    const derivation = validateDerivation(store, input.derivedFrom)
    problems.push(...derivation.problems)
    if (problems.length > 0) return { ok: false, problems }
    const previous = readConstructionProfile(store).profile
    const at = new Date().toISOString()
    const profile: ConstructionProfile = {
      version: 1,
      decidedAt: at,
      decidedBy: input.by,
      packages: input.packages as ConstructionPackage[],
      scope: input.scope,
      derivedFrom: input.derivedFrom,
      reason: input.reason,
      exempt: input.exempt,
      // history 记的是**被覆盖掉的历次决定**（当前选择在 profile.packages 里，不重复记；
      // 这样"复议"的历史读起来就是"上一次选了什么、为什么改"）
      history:
        previous === undefined
          ? []
          : [
              ...previous.history,
              { at: previous.decidedAt, packages: previous.packages, reason: previous.reason },
            ],
    }
    writeConstructionProfile(store, profile)
    journal.append('plan/profile-decided', {
      packages: input.packages.join(' '),
      scope: input.scope === SCOPE_ALL ? SCOPE_ALL : input.scope.join(' '),
      derivedFrom: input.derivedFrom.join(' | '),
      reason: input.reason,
      by: input.by,
    })
    return { ok: true, profile, checked: derivation.checked, unchecked: derivation.unchecked }
  }

  /**
   * 记一条**变异自证**（增量 3 的交付物通道）：写 `.sdo/construction/tdd.yml` + journal。
   *
   * 只在 `scale=critical`（或卡另有要求）时才被收工关读取；记录本身不判断"够不够" ——
   * 判据现算，`killed = 0` 也允许落盘（它是有价值的事实：变异没被杀掉）。
   */
  recordMutation(call: OfficeCall, input: { task: string; tool: string; target: string; killed: number; survived: number }):
    | { ok: true; record: MutationRecord; targetMissing: boolean }
    | { ok: false; problems: string[] } {
    const { store, journal } = this.contextFor(call)
    const problems: string[] = []
    if (input.task.trim() === '') problems.push(t('uiConstruction.c25'))
    if (input.tool.trim() === '') problems.push(t('uiConstruction.c26'))
    if (!Number.isFinite(input.killed) || input.killed < 0) problems.push(t('uiConstruction.c27'))
    if (!Number.isFinite(input.survived) || input.survived < 0) problems.push(t('uiConstruction.c28'))
    if (problems.length > 0) return { ok: false, problems }
    const record: MutationRecord = { ...input, at: new Date().toISOString() }
    recordMutation(store, record)
    journal.append('test/mutation-recorded', { task: input.task, tool: input.tool, target: input.target, killed: input.killed, survived: input.survived })
    // 评审建议 2：`target` 允许为空（不判红），但**建议写清** —— 否则复核者无法跟着复跑一遍
    return { ok: true, record, targetMissing: input.target.trim() === '' }
  }

  /** 记一条**契约测试**（增量 3 的交付物通道）：契约必须存在，否则拒收。 */
  recordContractTest(call: OfficeCall, input: { task: string; contract: string; tool: string; cmd: string }):
    | { ok: true; record: ContractTestRecord }
    | { ok: false; problems: string[] } {
    const { store, journal } = this.contextFor(call)
    const problems: string[] = []
    if (input.task.trim() === '') problems.push(t('uiConstruction.c25'))
    if (input.contract.trim() === '') problems.push(t('uiConstruction.c29'))
    else if (!listContracts(store).some((item) => item.id === input.contract)) problems.push(fmt('uiConstruction.c30', { p1: input.contract }))
    if ((input.tool + input.cmd).trim() === '') problems.push(t('uiConstruction.c31'))
    if (problems.length > 0) return { ok: false, problems }
    const record: ContractTestRecord = { ...input, at: new Date().toISOString() }
    recordContractTest(store, record)
    journal.append('test/contract-test-recorded', { task: input.task, contract: input.contract, tool: input.tool, cmd: input.cmd })
    return { ok: true, record }
  }

  /**
   * **子代理结算**（取汇报 ②）：写报告文件 + 记 `dispatch/finished`。
   *
   * 内容 = 它最后一条助手消息的全文（调用方在 `turn/end` 时把缓存交进来）。
   */
  noteDispatchFinished(
    call: OfficeCall,
    input: { childSessionId: string; task: string; role: string; turn: number; reason: string; startedAt: string; report: string },
  ): DispatchFinished {
    const { store, journal } = this.contextFor(call)
    const finishedAt = new Date().toISOString()
    const report = writeChildReport(store, input.childSessionId, input.report, input.task)
    const started = Date.parse(input.startedAt)
    const record: Omit<DispatchFinished, 'seq'> = {
      childSessionId: input.childSessionId,
      task: input.task,
      role: input.role,
      turn: input.turn,
      reason: input.reason,
      startedAt: input.startedAt,
      finishedAt,
      durationMs: Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0,
      report,
    }
    const event = journal.append('dispatch/finished', { ...record })
    return { ...record, seq: event.seq }
  }

  /**
   * **观测/采集失败留痕**：采集类失败仍然 fail-open（不阻塞任何写操作），但**必须记账** ——
   * 否则"没数据"和"没问题"看起来一模一样（真机上就丢过三次派发的观测）。
   */
  noteObserveFailure(call: OfficeCall, input: { childSessionId: string; eventType: string; error: string }): void {
    const { journal } = this.contextFor(call)
    journal.append('dispatch/observe-failed', { sessionId: input.childSessionId, eventType: input.eventType, error: input.error.slice(0, 300) })
  }

  /**
   * **子代理报告体检**（SDO-58）。
   *
   * 真机现象：`TASK-187` 的子代理报告落盘仅 **235 字节**（同批其他轮次 KB 级）⇒ 审计链断裂，
   * 那一轮的调色板复算等关键内容无处可查。报告是子代理自己写的，插件能做的**机械**动作是：
   * 结算之后**量一下**，异常短/缺失就**显式告警**（而不是让人事后去翻文件大小）。
   * 口径：`dispatch/finished.report` 是权威落点（不自己拼文件名）；没结算过 ⇒ `none`（卡可能是内联做的，不告警）。
   */
  childReportHealth(call: OfficeCall, taskId: string): {
    state: 'ok' | 'short' | 'missing' | 'none'
    report?: string | undefined
    bytes?: number | undefined
    /** **DEF-045**：逐笔结算里所有残缺的（可能被后续正常报告"遮住"），按发生顺序。 */
    fragments?: { reason: string; report: string; bytes: number; seq: number }[] | undefined
  } {
    const { store, journal } = this.contextFor(call)
    // **DEF-045（§3E 族 5）**：旧实现 `.pop()` **只看最后一次**结算 ⇒ 某轮留下 78B 残片、后续轮次正常
    // （2599B）时，残片**永远不会告警** —— `CHILD_REPORT_MIN_BYTES` 对它是**死判据**（真实台账实测：
    // TASK-104 有两笔结算，error@01:14 落 78B、completed@04:12 落 2599B）。这里**逐笔**看。
    const finished = journal
      .read()
      .events.filter((event) => event.type === 'dispatch/finished' && String(event.data.task ?? '') === taskId)
    if (finished.length === 0) return { state: 'none' }
    const seen = finished.map((event) => {
      const report = String(event.data.report ?? '')
      const text = report === '' ? undefined : readChildReportAt(store, report)
      const bytes = text === undefined ? 0 : Buffer.byteLength(text, 'utf8')
      const state: 'ok' | 'short' | 'missing' = report === '' || text === undefined
        ? 'missing'
        : bytes < CHILD_REPORT_MIN_BYTES ? 'short' : 'ok'
      return { state, report, bytes, reason: String(event.data.reason ?? ''), seq: event.seq }
    })
    const bad = seen.filter((item) => item.state !== 'ok')
    // 有残缺 ⇒ 报**最早那笔残缺**（"被遮住"的那一笔才是有信息量的），并把全部残缺列出来；
    // 全都正常 ⇒ 照旧报最后一笔（口径不变，老回执读数不动）。
    const worst = bad[0] ?? (seen[seen.length - 1] as (typeof seen)[number])
    return {
      state: worst.state,
      report: worst.report,
      bytes: worst.bytes,
      ...(bad.length === 0
        ? {}
        : { fragments: bad.map((item) => ({ reason: item.reason, report: item.report, bytes: item.bytes, seq: item.seq })) }),
    }
  }

  /** 已结算的派发（取汇报 ①/③：状态块与回执用）。 */
  finishedDispatches(call: OfficeCall): DispatchFinished[] {
    const { journal } = this.contextFor(call)
    return journal
      .read()
      .events.filter((event) => event.type === 'dispatch/finished')
      .map((event) => ({
        childSessionId: String(event.data.childSessionId ?? ''),
        task: String(event.data.task ?? ''),
        role: String(event.data.role ?? ''),
        turn: Number(event.data.turn ?? 0),
        reason: String(event.data.reason ?? ''),
        startedAt: String(event.data.startedAt ?? ''),
        finishedAt: String(event.data.finishedAt ?? ''),
        durationMs: Number(event.data.durationMs ?? 0),
        report: String(event.data.report ?? ''),
        seq: event.seq,
      }))
  }

  /**
   * **未读的子代理报告**（③ 的「推」半）：把驾驶舱还没看过的 `dispatch/finished` 取出来。
   *
   * 交付过一次就记 `dispatch/reported`（append-only）⇒「未读」= finished − reported，**重启也不丢**。
   *
   * **身份口径（第二轮整体评审 §2.3）**：新登记以 `finishedSeq`（那笔结算事件的 journal `seq`）认身份。
   * 为什么不能用 `(childSessionId, report)`：同一子会话为**同一张卡**可以结算多次（多轮子代理），
   * 那时的 `task` 与报告落点逐字相同 —— 键去重会把第二笔算成"第一笔的重复"，于是第一笔送达后
   * **后面每一笔结算都永远不再推送**（真机形态：第一笔送达 ⇒ 之后再结算 ⇒ `pending` 直接是 0）。
   * 旧台账里没有 `finishedSeq` 的登记退化为**一条键额度**（一笔旧登记顶一笔结算，按时间顺序消耗）：
   * 升级既不重推历史，也不会再顺带吞掉后来同键的新结算。
   */
  pendingDispatchReports(call: OfficeCall): DispatchFinished[] {
    const { journal } = this.contextFor(call)
    const bySeq = new Set<number>()
    const legacyCredits = new Map<string, number>()
    for (const event of journal.read().events) {
      if (event.type !== 'dispatch/reported') continue
      const finishedSeq = Number(event.data.finishedSeq)
      if (Number.isFinite(finishedSeq) && finishedSeq > 0) {
        bySeq.add(finishedSeq)
        continue
      }
      const key = reportKey(String(event.data.childSessionId ?? ''), String(event.data.report ?? ''))
      legacyCredits.set(key, (legacyCredits.get(key) ?? 0) + 1)
    }
    const pending: DispatchFinished[] = []
    for (const item of this.finishedDispatches(call)) {
      if (bySeq.has(item.seq)) continue
      const key = reportKey(item.childSessionId, item.report)
      const credit = legacyCredits.get(key) ?? 0
      if (credit > 0) {
        legacyCredits.set(key, credit - 1)
        continue
      }
      pending.push(item)
    }
    return pending
  }

  /** 标记这些报告已经**送达驾驶舱**（下次不再重复推）。 */
  markDispatchReported(call: OfficeCall, items: { childSessionId: string; report: string; seq?: number }[]): void {
    const { journal } = this.contextFor(call)
    for (const item of items) {
      journal.append('dispatch/reported', {
        childSessionId: item.childSessionId,
        report: item.report,
        ...(item.seq === undefined ? {} : { finishedSeq: item.seq }),
      })
    }
  }


  /**
   * 子代理报告全文（③ 的"回注"：状态块/回执给摘要，模型不必自己翻文件）。
   *
   * **按记录的落点读**（`dispatch/finished.report`），不按 childSessionId 拼文件名 ——
   * 报告名含卡 id（复用时不覆盖），拼名会漂。
   */
  reportText(call: OfficeCall, report: string): string | undefined {
    return readChildReportAt(this.storeFor(this.requireWorkspace(call)), report)
  }

  /** 读回实现阶段方法包（供 `claim`/`done`/门禁/状态共用，口径只有一份）。 */
  constructionProfile(call: OfficeCall): ProfileRead {
    return readConstructionProfile(this.storeFor(this.requireWorkspace(call)))
  }

  /** 本会话派发出去的子会话（来自 `dispatch/started`；带卡上的角色，用于算"掩码外工具"）。 */
  dispatchedChildren(call: OfficeCall): { childSessionId: string; taskId: string; role: string; provider: string; startedAt: string }[] {
    const { store, journal } = this.contextFor(call)
    const roleOfCard = new Map(listTasks(store).map((task) => [task.id, task.role]))
    return journal
      .read()
      .events.filter((event) => event.type === 'dispatch/started')
      .map((event) => ({
        childSessionId: String(event.data.childSessionId ?? ''),
        taskId: String(event.data.task ?? ''),
        provider: String(event.data.provider ?? ''),
        role: String(event.data.role ?? roleOfCard.get(String(event.data.task ?? '')) ?? ''),
        startedAt: String((event as { at?: unknown }).at ?? ''),
      }))
      .filter((item) => item.childSessionId !== '')
  }

  /**
   * **这个子会话被派发时记下的角色**（血缘角色；第一轮整仓评审 §2 第 1 条）。
   *
   * 掩码归属不能只看"认领事实"：卡一旦离开 `in-progress`（done / dropped / blocked / ready），
   * `claimsBySession` 就不再认这个会话 ⇒ 旧实现在钩子里退回 `unclaimed-child`、**整段跳过掩码**
   * （实测：驾驶舱 drop 掉卡、等过 5 秒角色缓存 TTL 后，仍在飞的 reviewer 子会话调 `write` 由 DENY 变 ALLOW）。
   * 这里的角色来自追加式真源（`dispatch/started`），不随可手改的卡状态改变；同一会话被复用多次时取
   * **最新一条**（掩码跟着最近一次派发）。取不到（不是我们派发的会话）就返回 `undefined` = 原口径 fail-open。
   */
  dispatchedRoleOf(call: OfficeCall): string | undefined {
    if (call.sessionId === undefined || call.sessionId === '') return undefined
    try {
      const role = this.dispatchedChildren(call)
        .filter((item) => item.childSessionId === call.sessionId)
        .at(-1)?.role
      return role === undefined || role === '' ? undefined : role
    } catch {
      return undefined
    }
  }

  /**
   * 记一条"子代理工具面观测"（评审 §4.2：把"是否收窄"变成可核对的事实）。
   *
   * **`DEF-165` ①（`TASK-172`）：一次观测要落**两个**地方** ——
   *   · `evidence/child-tools.jsonl`：**证据原件**（历史读数、`faceMismatches` 还读它）；
   *   · `dispatch/observed` **事件**：可引用、可统计的台账记录。
   * 修前只有前者 ⇒ journal 里含 `observ` 的事件计数为 0 ⇒ 复用判据 R-1「该子会话被**观测到**手里有工具」
   * 对**新起的**子会话**结构性无法满足**（它不可能有历史证据），于是每张卡都新起、复用形同不存在。
   * 两个落点由**这一处**触发（口径唯一）；写失败一律 fail-open（观测是记账，不该挡住子代理干活）。
   */
  noteChildFace(call: OfficeCall, input: { childSessionId: string; tools: string[]; violations: string[]; calls?: string[] | undefined; callCount?: number | undefined }): void {
    const { store, journal } = this.contextFor(call)
    recordChildFace(store, input)
    try {
      recordChildObserved(journal, {
        childSessionId: input.childSessionId,
        // **被公告的工具数**（`request/header` 那份清单的长度；`tool/call` 观测记 0）
        toolCount: input.tools.length,
        // **掩码外的调用次数**（观测面事件记 0）—— 与 `readChildFaces` 的合并口径同量纲
        deniedOutsideCount: input.callCount ?? input.calls?.length ?? 0,
      })
    } catch {
      /* fail-open：观测落事件失败不该挡住任何东西（文件那份仍在） */
    }
  }

  /** 读回观测（供回执里如实展示）。 */
  childFaces(call: OfficeCall): ChildFaceEntry[] {
    return readChildFaces(this.storeFor(this.requireWorkspace(call))).faces
  }

  /** **观测事件**的读侧投影（`dispatch/observed`；按子会话折叠，见 `readChildObservations`）。 */
  childObservations(call: OfficeCall): ReturnType<typeof readChildObservations> {
    return readChildObservations(this.contextFor(call).journal)
  }

  /**
   * **复用的依据**（`DEF-165` ① 的验收面）：该子会话最近一条 `dispatch/observed`。
   *
   * 回执照这个引用"依据哪条观测"（事件序号 + 公告面工具数 + 掩码外调用次数 + 观测时刻）——
   * 没有它，回执里的"复用"就只是一句声明（正是这条缺陷的成因）。
   */
  reuseEvidence(call: OfficeCall, childSessionId: string): ReturnType<typeof observationOf> {
    return observationOf(this.contextFor(call).journal, childSessionId)
  }

  /**
   * 认领这张卡的**会话 id**（SDO-36：评审独立性要按可验证的身份判，而不是调用方自报的名字）。
   */
  /**
   * **调用方的角色归属**（D6）：与 `tools/pre-execute` 钩子**同一口径**（没有认领 ⇒ 驾驶舱）。
   * 用途：卡是计划产物，`drop`/`reassign` 之类属流程官职权 —— 不能只看调用方自报的 `actor`。
   */
  /**
   * **这个会话是不是被派发出去的子代理**（D6 的权威判据）。
   *
   * 为什么不看血缘字段：工具层拿不到 `delegationDepth`（`callOf(exec)` 只给 sessionId/cwd），
   * 而 `attributeRole` 对"无血缘"的会话按驾驶舱处理 ⇒ 只看它会把子代理当驾驶舱放行。
   * 真源里 `dispatch/started.childSessionId` 是**插件自己记的**，用它判"谁是被派出去的"最稳。
   */
  isDispatchedChild(call: OfficeCall): boolean {
    if (call.sessionId === undefined || call.sessionId === '') return false
    try {
      const { journal } = this.contextFor(call)
      return journal.read().events.some(
        (event) => event.type === 'dispatch/started' && String(event.data.childSessionId ?? '') === call.sessionId,
      )
    } catch {
      return false
    }
  }

  roleOf(call: OfficeCall): string {
    try {
      const { store, journal } = this.contextFor(call)
      // 与钩子同一口径：没有活的认领时用**血缘角色**兜底（卡被 drop/done 掉不等于这个会话就不是派发角色）
      return attributeRole({
        sessionId: call.sessionId,
        claims: claimsBySession(store, journal),
        dispatchedRole: this.dispatchedRoleOf(call),
      }).role
    } catch {
      return 'cockpit'
    }
  }

  claimSession(call: OfficeCall, taskId: string): string | undefined {
    const { journal } = this.contextFor(call)
    return claimBaseline(journal, taskId)?.sessionId
  }

  /** A2：列出该卡认领之后、**还缺文件清单**的 `(sessionId, seq)`（供 `done` 时补取）。 */
  pendingWorkspaceChanges(call: OfficeCall, taskId: string): { sessionId: string; seq: number }[] {
    const { store, journal } = this.contextFor(call)
    const baseline = claimBaseline(journal, taskId)
    if (baseline === undefined) return []
    return unresolvedSeqs(store, baseline.sessionId, baseline.seq).map((seq) => ({ sessionId: baseline.sessionId, seq }))
  }

  /** 迭代。 */
  iteration(call: OfficeCall): Iteration | undefined {
    return readIteration(this.storeFor(this.requireWorkspace(call)))
  }

  startIteration(call: OfficeCall, goal: string): Iteration {
    const { store, journal } = this.contextFor(call)
    return startIteration(store, journal, goal)
  }

  closeIteration(call: OfficeCall): Iteration | undefined {
    const { store, journal } = this.contextFor(call)
    return closeIteration(store, journal)
  }

  // 验证与评审

  testCases(call: OfficeCall): TestCase[] {
    return listTestCases(this.storeFor(this.requireWorkspace(call)))
  }

  addTestCase(call: OfficeCall, input: Omit<TestCase, 'id' | 'at'>): TestCase {
    const { store, journal } = this.contextFor(call)
    // **DEF-079**：把"谁建的"记进事件 `actor`（缺会话 id 时才退回缺省 `sdo`）
    return recordTestCase(store, journal, input, call.sessionId ?? 'sdo')
  }

  /**
   * **登记当前环境指纹**（SDO-57 的 C 口径）：`project/environment` 从"立项记一次"变成**时序账本** ——
   * 每次环境真的变了（换 JDK、升探针、改类路径）就再登记一条；此后记录的证据按**最近一条**归属，
   * 而"这条证据是不是在当前环境下得出的"从此可判。
   */
  noteEnvironment(
    call: OfficeCall,
    input: { env: string; note?: string | undefined; by?: string | undefined },
  ): {
    ok: true
    env: string
    at: string
    /** 登记**之前**的当前环境（从未登记过 ⇒ 不给这个键） */
    previousEnv?: string | undefined
    /**
     * **这次登记的"影响面"**（DEF-025 / 第三批 §3.10）：登记是**项目级**动作，一次登记会让别的卡
     * 绑着旧环境的证据集体变成"证据过期" —— 回执必须点名是**哪些**，并给可执行的补做出路。
     *
     * 判据**复用唯一出口** `evidenceFreshness`（不另造一套"哪条会过期"的算法）：
     * 影响面 = 按**新环境**判过期的那些 **减去** 登记**前**就已过期的 ⇒ 只报"**因这次登记而新过期**"的。
     */
    newlyStale: { resultId: string; caseId: string; reason: string }[]
  } | { ok: false; detail: string } {
    const declared = input.env.trim()
    if (declared === '') return { ok: false, detail: '环境指纹不能为空（空指纹等于没登记）' }
    const { store, journal, workspace } = this.contextFor(call)
    const previous = this.currentEnvironment(call)
    const already = new Set(evidenceFreshness(store, workspace, previous).stale.map((row) => row.resultId))
    const newlyStale = evidenceFreshness(store, workspace, declared).stale.filter((row) => !already.has(row.resultId))
    const at = new Date().toISOString()
    journal.append('project/environment', {
      plugin: 'dsh-software-dev-office',
      pluginVersion: this.version(),
      hostVersion: process.env.DSH_VERSION ?? 'unknown',
      node: process.versions.node,
      env: declared,
      reason: 'declared',
      ...(input.note === undefined ? {} : { note: input.note }),
      by: input.by ?? 'human',
      at,
    })
    void store
    return { ok: true, env: declared, at, ...(previous === undefined ? {} : { previousEnv: previous }), newlyStale }
  }

  /**
   * **当前环境状态**（只读，DEF-025 的 ③）：最近一次登记的环境串 + 它的登记时刻。
   * 从未登记过 ⇒ `{ env: '', at: '' }`（**如实说没有**，而不是编一个"当前环境"）。
   */
  environmentStatus(call: OfficeCall): { env: string; at: string } {
    const { journal } = this.contextFor(call)
    const events = journal.read().events.filter((event) => event.type === 'project/environment')
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const env = String(events[i]?.data.env ?? '').trim()
      if (env !== '') return { env, at: String(events[i]?.data.at ?? '') }
    }
    return { env: '', at: '' }
  }

  /** 最近登记的**环境指纹**（没登记过 ⇒ `undefined`，此时一切"时效"都只能标"无法核验"）。 */
  currentEnvironment(call: OfficeCall): string | undefined {
    const { journal } = this.contextFor(call)
    const events = journal.read().events.filter((event) => event.type === 'project/environment')
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const env = String(events[i]?.data.env ?? '').trim()
      if (env !== '') return env
    }
    return undefined
  }

  /**
   * **工具面差异**（SDO-53）：把「我们声明给这个角色的面」（`roles.yml` 的掩码）与
   * 「子代理实测拿到/公告的面」（`evidence/child-tools.jsonl`）**逐个子会话**对起来，
   * 返回有差异的那些。只报事实，不做"宿主应该收窄"的承诺。
   */
  faceMismatches(call: OfficeCall): { childSessionId: string; role: string; task: string; missing: string[]; extra: string[] }[] {
    const { store, journal } = this.contextFor(call)
    const declaredByChild = new Map<string, { role: string; task: string }>()
    for (const event of journal.read().events) {
      if (event.type !== 'dispatch/started') continue
      const child = String(event.data.childSessionId ?? '')
      if (child === '') continue
      declaredByChild.set(child, { role: String(event.data.role ?? ''), task: String(event.data.task ?? '') })
    }
    const rows: { childSessionId: string; role: string; task: string; missing: string[]; extra: string[] }[] = []
    const knownRoles = new Set<string>(listRoleCards().map((card) => String(card.code)))
    for (const face of readChildFaces(store).faces) {
      if (face.tools.length === 0) continue
      const declared = declaredByChild.get(face.childSessionId)
      if (declared === undefined || !knownRoles.has(declared.role)) continue
      // **R-10（sdo-test-new 2026-10-08，minor）**：旧实现拿 `toolAllowList(role)` 当"声明面" —— 那是
      // **白名单时代**的口径。新口径是两层（`sdo_*` 白名单 + 通用面黑名单继承宿主默认），
      // 于是"通用面"必然全被算成"多出来的"，**每个子会话都挂一条误导警告**（真机列了 14 项，
      // 全是有意继承的记忆/技巧/`send_message`…）。
      // 现在的差集只在**真的不一致**时才报：
      //   · 「缺」= 本角色**声明的 `sdo_*`** 里、公告面没有的（流程面是真的白名单）；
      //   · 「多」= 公告面里**被离场规则禁止**的：`roles.yml` 的 `deny` ∪ 执行者禁用面
      //     ∪（`sdo_*` 里不在本角色 allow 的补集）。
      // 通用面里那些"没在 allow 里"的名字**不再算多**（黑名单语义下它们本来就该在）。
      const allow = toolAllowList(declared.role as never)
      const card = listRoleCards().find((item) => String(item.code) === declared.role)
      const forbidden = new Set<string>([...(card?.deny ?? []), ...EXECUTOR_DENIED_TOOLS])
      // "声明面"= **真正的白名单那两层**：`sdo_*` 流程面 + 只读检视面（`read`/`grep`/`glob`/`read_image`，
      // 设计上人人可用）。其余通用面继承宿主默认，**不在声明面里**（正是 R-10 的误报来源）。
      const declaredSdo = allow.filter((name) => name.startsWith('sdo_') || (READ_ONLY_INSPECTION_TOOLS as readonly string[]).includes(name))
      const missing = declaredSdo.filter((name) => !face.tools.includes(name)).sort()
      const extra = face.tools
        .filter((name) => forbidden.has(name) || (name.startsWith('sdo_') && !allow.includes(name)))
        .sort()
      if (missing.length === 0 && extra.length === 0) continue
      rows.push({ childSessionId: face.childSessionId, role: declared.role, task: declared.task, missing, extra })
    }
    return rows
  }

  /** **证据时效**（SDO-57）：哪些通过结果已过期、哪些没记环境指纹（交付回执与看板用它说话）。 */
  evidenceFreshness(call: OfficeCall): ReturnType<typeof evidenceFreshness> {
    const workspace = this.requireWorkspace(call)
    const store = this.storeFor(workspace)
    return evidenceFreshness(store, workspace, this.currentEnvironment(call))
  }

  /**
   * 记录一条用例结果。
   *
   * **REQ-053（TASK-039）**：`executedBy` / `adoptedBy` 在这里**逐字段透传**（下面显式列出，而不是只靠
   * `...input` 展开）—— 这一层是"域层收不收得到"的最后一跳：少写一个字段，工具面就拿不到，
   * 而回执照旧说"已记录"（真机上 `τ_ff348198` 那类静默丢弃就是这么发生的）。
   * 归一化口径**不在这里**再抄一份：采纳时刻由 `records.ts` 的 `recordTestResult` 盖（一处实现）。
   */
  addTestResult(call: OfficeCall, input: Omit<TestResult, 'id' | 'at'>): ReturnType<typeof recordTestResult> {
    const { store, journal } = this.contextFor(call)
    const workspace = this.requireWorkspace(call)
    // **SDO-57**：没声明环境就**按最近登记的环境归属**（并如实标注 `inherited`，不假装是声明的）；
    // 给了被检产物就**当场绑定 sha256**（交付时重算比对 ⇒ 产物一变，证据立刻"过期"）。
    const declared = (input.env ?? '').trim()
    const inherited = declared === '' ? this.currentEnvironment(call) : undefined
    const env = declared !== '' ? declared : inherited
    const artifact = (input.artifact ?? '').trim()
    // **DEF-011**：这里**不再**一把覆盖成现算值 —— 把 `workspace` 交给域层，由**唯一出口**
    //（`reconcileArtifactSha256`）对账：调用方声明了哈希就必须与现算值一致（不一致 ⇒ 可读拒绝、零写盘）；
    // 没声明 ⇒ 域层照旧现算（零破坏）。
    return recordTestResult(store, journal, {
      ...input,
      ...(input.executedBy === undefined ? {} : { executedBy: input.executedBy }),
      ...(input.adoptedBy === undefined ? {} : { adoptedBy: input.adoptedBy }),
      ...(env === undefined || env === '' ? {} : { env, envSource: declared !== '' ? 'declared' as const : 'inherited' as const }),
      ...(artifact === '' ? {} : { artifact }),
    }, { workspace })
  }

  defects(call: OfficeCall): Defect[] {
    return listDefects(this.storeFor(this.requireWorkspace(call)))
  }

  /**
   * 登记一条缺陷。
   *
   * **REQ-055（TASK-039）**：根因面三字段（`rootCause` / `discoveryLevel` / `escaped`）在这里**逐字段
   * 透传**到域层的 `defect/recorded` append-only 事件（下面显式列出）—— 归一化口径只有一处实现
   * （`records.ts` 的 `recordDefect`：空串不落键、`escaped` 只认真正的布尔值），这里**不再抄一份**，
   * 否则"什么算填了"会有两个会打架的真值口径。
   *
   * **DEF-038（TASK-063）**：免责依据两字段（`waiveReason` / `waiveApprovedBy`）与根因面一族**同款**：
   * 也在下面**逐字段显式列出**（`...input` 本来就能带过去，但显式列出是这一处的既有纪律 ——
   * 漏掉一处就等于工具面静默丢弃，而那种丢法不报错、回执还说成功）。
   */
  addDefect(call: OfficeCall, input: Omit<Defect, 'id' | 'at'>): Defect {
    const { store, journal } = this.contextFor(call)
    return recordDefect(store, journal, {
      ...input,
      ...(input.rootCause === undefined ? {} : { rootCause: input.rootCause }),
      ...(input.discoveryLevel === undefined ? {} : { discoveryLevel: input.discoveryLevel }),
      ...(input.escaped === undefined ? {} : { escaped: input.escaped }),
      ...(input.waiveReason === undefined ? {} : { waiveReason: input.waiveReason }),
      ...(input.waiveApprovedBy === undefined ? {} : { waiveApprovedBy: input.waiveApprovedBy }),
    })
  }

  updateDefect(call: OfficeCall, id: string, patch: DefectUpdate, by = 'human'): ReturnType<typeof updateDefect> {
    const { store, journal } = this.contextFor(call)
    return updateDefect(store, journal, id, patch, by)
  }

  /** **`DEF-115`**：指向不存在用例的结果（幽灵用例），回执要点名。 */
  orphanTestResults(call: OfficeCall): { id: string; caseId: string }[] {
    const { store } = this.contextFor(call)
    return orphanTestResults(store)
  }

  verification(call: OfficeCall): ReturnType<typeof verificationStats> {
    const { store, journal } = this.contextFor(call)
    return verificationStats(store, journal)
  }

  reviews(call: OfficeCall): Review[] {
    return listReviews(this.storeFor(this.requireWorkspace(call)))
  }

  addReview(call: OfficeCall, input: Omit<Review, 'id' | 'at'>): Review {
    const { store, journal } = this.contextFor(call)
    // **DEF-048（第三批 §3.16）**：待修主张（非 `pass`）必须带"当前仍失败的复现命令"或显式声明"无法复现"
    // —— 判据走**唯一出口** `reviewReproIssue`（与 `recordReview` / `appendReviewFindings` 同一份）。
    // 违反即抛 `ReviewReproError`（与域层同一类）：工具边界把它转成**可读回执**，异常不越过工具面。
    const issue = reviewReproIssue({ verdict: input.verdict, repro: input.repro, unreproducible: input.unreproducible })
    if (issue !== undefined) throw new ReviewReproError(issue.code, issue.detail)
    // **用户口径（2026-10-08）**：把**原卡所属角色**标在评审上 —— 这样"该由哪个角色来核实"这件事
    // 不依赖卡还在不在（卡会被 drop/重建/改角色），代核才判得出"同角色"。
    const card = this.tasks(call).find((task) => task.id === input.taskId)
    const taskRole = textOf(input.taskRole).trim() !== '' ? textOf(input.taskRole).trim() : (card?.role ?? '')
    return recordReview(store, journal, { ...input, ...(taskRole === '' ? {} : { taskRole }) })
  }

  /**
   * **核实一条评审发现**（2026-10-08 口径：评审结果是主张，要由实现方逐条核实才能采纳）。
   *
   * 会话 id 一并交给域层：它据此拦住"记录评审的会话自己核实自己"，并核对"是不是该卡的实现会话"。
   */
  verifyReviewFinding(call: OfficeCall, input: {
    reviewId: string
    index: number
    outcome: 'reproduced' | 'refuted'
    evidence: string
    /** 核实者（缺省 human） */
    by?: string | undefined
  }): VerifyResult {
    const { store, journal } = this.contextFor(call)
    return verifyReviewFinding(store, journal, { ...input, sessionId: call.sessionId })
  }

  /** **补记老格式评审的内容指纹**（G-2；`sdo_review action=rehash`）。 */
  rehashReview(call: OfficeCall, input: { reviewId: string; by?: string | undefined }): RehashResult {
    const { store, journal } = this.contextFor(call)
    return rehashReview(store, journal, input)
  }

  /** 全部评审的采纳状态（回执/状态块/门禁同一份口径）。 */
  reviewAdoptions(call: OfficeCall): ReviewAdoption[] {
    const { store, journal } = this.contextFor(call)
    return reviewAdoptions(store, journal)
  }

  /**
   * 评审独立性问题（作者 = 评审者）。
   *
   * **DEF-042**：与 `C-52` 同一份材料（`task/claimed` 事件里的会话 uuid）。
   *
   * **2026-10-21 收窄两条**：这里必须和 `C-52` **传同一份采纳集** —— 否则"自评 `pass` + 独立已采纳 `pass`"
   * 那一态会分叉：判据绿、而 `sdo_review action=list` 仍把它印成「⚠️ 独立性违规」（两处口径分家，
   * 正是 `DEF-044` 教过的那种病）。所以采纳集从同一个方法取，只算 `adopted` 且 `verdict=pass` 的。
   */
  reviewViolations(call: OfficeCall): { reviewId: string; detail: string }[] {
    const { journal } = this.contextFor(call)
    const adoptedPassReviewIds = new Set(
      this.reviewAdoptions(call)
        .filter((item) => item.state === 'adopted' && item.review.verdict === 'pass')
        .map((item) => item.review.id),
    )
    return independenceViolations(this.reviews(call), this.tasks(call), claimedSessionsByCard(journal), adoptedPassReviewIds)
  }

  // 交付

  manifest(call: OfficeCall): DeliveryManifest | undefined {
    return readManifest(this.storeFor(this.requireWorkspace(call)))
  }

  /** **改卡**（`sdo_task action=update`）：见 `updateTask` 的三条约束。 */
  updateTask(call: OfficeCall, input: Parameters<typeof updateTask>[2]): ReturnType<typeof updateTask> {
    const { store, journal } = this.contextFor(call)
    return updateTask(store, journal, input)
  }

  /** **真机运行记录**（用户要求：真机测试才能交付）。 */
  recordRun(call: OfficeCall, input: Omit<RunInput, 'workspace'>): { ok: true; run: RunRecord } | { ok: false; detail: string } {
    const workspace = this.requireWorkspace(call)
    const { store, journal } = this.contextFor(call)
    return recordRun(store, journal, { ...input, workspace })
  }

  runs(call: OfficeCall): RunRecord[] {
    return listRuns(this.storeFor(this.requireWorkspace(call)))
  }

  packageDelivery(call: OfficeCall, input: Omit<PackageInput, 'workspace' | 'prototypeDir'>): { manifest: DeliveryManifest; missingArtifacts: string[] } {
    const { store, journal, workspace } = this.contextFor(call)
    const config = readProjectConfig(store).config
    return packageDelivery(store, journal, { ...input, workspace, prototypeDir: config.prototype.dir })
  }

  /**
   * 渲染页眉的项目元信息（**`DEF-151`**）：项目 / 流程 / 阶段三格。
   *
   * **只有这一处实现，两个渲染入口共用**（`renderVerificationDocs` 与 `signReview` 的报告投影）。
   * 这是 `DEF-142` 的教训：同一件事两份实现 ⇒ 两套口径，谁后写谁生效。
   *
   * **读台账是 `office` 的职责，渲染层仍是纯函数**：`testingRender` 只按入参定文本、自己不碰
   * `.sdo/` —— 否则「同一入参两次渲染逐字节一致」（`REQ-035`）这条不变量就失效了。
   *
   * **空值一律不传**（不是传空串）：`metaBlock` 的缺省文案「（无）」只在**真没读到**时出现；
   * 传 `''` 会渲染出一个没有任何字的格子，把"台账缺名字"藏成空白 —— 比「（无）」更难发现。
   * 台账读不出来（或根本没有台账）⇒ 返回 `{}`，**fail-open，不抛**：渲染照常进行，页眉写「（无）」。
   *
   * 口径（与 `src/infra/render.ts:94` 的**公共页眉**同一条规则）：项目 = `${id} ${name}`；流程 = 原始 id
   * （`waterfall`，不是展示名）；阶段 = 展示名（`开发`，不是 `construction`）。
   *
   * 项目为什么带 id（2026-10-21 驾驶舱裁定 ①）：`DESIGN` / `DECISIONS` / `QUALITY` 三份盘上值与运行时
   * 横幅都是 `PRJ-001 SDO 研发办公室插件本体（dsh-software-dev-office）`；只有 TESTPLAN/TESTREPORT
   * 两份是"有 id、但名字被截断"的异常值（一次性渲染的产物，无规则可推）⇒ 以公共页眉为基准，不迁就异常值。
   */
  private testingRenderMeta(call: OfficeCall): { projectName?: string; process?: string; phase?: string } {
    let project: SdoProject | undefined
    try {
      project = this.contextFor(call).project
    } catch {
      return {}
    }
    if (project === undefined) return {}
    const def = processOfProject(project)
    const name = String(project.name ?? '').trim()
    const id = String(project.id ?? '').trim()
    const process = String(project.process ?? '').trim()
    const phase = phaseLabel(def, String(project.phase ?? '').trim()).trim()
    return {
      ...(name === '' ? {} : { projectName: `${id} ${name}`.trim() }),
      ...(process === '' ? {} : { process }),
      ...(phase === '' ? {} : { phase }),
    }
  }

  /**
   * 渲染 `docs/TESTPLAN.md` 与 `docs/DELIVERY.md`。
   *
   * **`DEF-142`（0.1.6 收尾）**：`docs/TESTPLAN.md` 此前有**两个渲染器、两套真源** —— 这里是
   * `records.renderTestPlan`（真源 `.sdo/tests/`），而 `testingRender.writeTestingDoc`（真源
   * `.sdo/testing/plan.yml`，REQ-047 的计划真源）**零调用点**。谁后写谁生效，且没有冲突提示。
   * 现在只剩一个来源：计划真源。**没有真源就不写**（回执点名缺哪份），绝不退回旧渲染器写一份不同口径的文档。
   */
  renderVerificationDocs(call: OfficeCall): string[] {
    const { store, journal, workspace } = this.contextFor(call)
    const seq = journal.read().events.length
    const written: string[] = []
    if (readTestingFile(store, 'plan', 'plan').present) {
      // **`DEF-151`**：页眉三格由 `testingRenderMeta` 统一供给（此前两处入口都不传 ⇒ 好文档被渲成「（无）」）
      written.push(this.relativize(workspace, writeTestingDoc(store, 'plan', { store, seq, ...this.testingRenderMeta(call) }, journal).path))
    } else {
      written.push(fmt('uiIndex.kTestingPlanSkipped', { p1: '.sdo/testing/plan.yml' }))
    }
    const manifest = readManifest(store)
    if (manifest !== undefined) {
      written.push(
        this.relativize(
          workspace,
          new SdoStore(workspace).writeText(['docs', 'DELIVERY.md'], renderDelivery(manifest, renderHeader('.sdo/delivery/manifest.yml', seq))),
        ),
      )
    }
    return written
  }

  // —————————————————————— M5：成本与预算 ——————————————————————

  /** 预算（`.sdo/budget.yml`）；没设过则为 undefined。 */
  budget(call: OfficeCall): Budget | undefined {
    // F-21：预算的三个列表位置（tiers / askedTiers / decisions）在手写标量时会被展开成字符，
    // 读取边界统一归一（`[...budget.tiers]` 不再见到字符串）
    return readBudgetChecked(this.storeFor(this.requireWorkspace(call))).budget
  }

  /** 设置/更新预算（不传 total 就是"只报消耗"）。 */
  setBudget(call: OfficeCall, input: { total?: number | undefined; currency?: string | undefined; tiers?: number[] | undefined }): Budget {
    const { store, journal } = this.contextFor(call)
    const previous = this.budget(call) ?? defaultBudget()
    const budget: Budget = {
      ...previous,
      ...(input.total === undefined ? {} : { total: input.total }),
      currency: input.currency ?? previous.currency,
      tiers: input.tiers ?? previous.tiers,
    }
    store.writeYaml(['budget.yml'], { budget })
    journal.append('cost/updated', {
      total: budget.total ?? null,
      currency: budget.currency,
      tiers: budget.tiers,
    })
    return budget
  }

  /**
   * 成本报告。`source` 由宿主提供（tokenMeter 适配）；拿不到计量时如实说明"不可得"。
   */
  costReport(
    call: OfficeCall,
    source: { rows: UsageRow[]; available: boolean; note?: string | undefined },
  ): { summary: UsageSummary; budget: Budget | undefined; line: string; advice?: string | undefined; tier?: { tier: string; message: string } | undefined } {
    const { store, journal } = this.contextFor(call)
    const budget = this.budget(call)
    const summary = summarize(source.rows, {
      currency: this.settings.cost.currency,
      perTokens: this.settings.cost.perTokens,
      prices: this.settings.cost.prices,
    })
    // **P-9**：拿不到计量来源时，不许渲染「已消耗 0 tokens」，也不许把 0 写进台账 ——
    // 那会把"没有数据"固化成一条假事实（`cost.yml` + `cost/updated` 都会被后续读成"确实零消耗"）。
    const line = source.available ? describeBudgetLine(summary, budget) : describeBudgetLineNoUsage(budget)
    const advice = source.available ? budgetAdvice(summary, budget) : undefined
    if (!source.available) {
      void store
      return { summary, budget, line, ...(advice === undefined ? {} : { advice }) }
    }
    // 成本快照写进 `.sdo/`：真源是 journal（追加事件），`cost.yml` 是可重建的派生视图。
    // 状态块**只从 `.sdo/` 读**，因此换会话/换进程都一致（不再依赖内存缓存）。
    const snapshot: CostSnapshot = {
      at: summary.at,
      totalTokens: summary.totalTokens,
      currency: summary.estimatedCost?.currency ?? this.settings.cost.currency,
      unpricedTokens: summary.unpricedTokens,
    }
    const withAmount =
      summary.estimatedCost === undefined ? snapshot : { ...snapshot, amount: summary.estimatedCost.amount }
    store.writeYaml(['cost.yml'], { cost: withAmount })
    journal.append('cost/updated', { ...withAmount })
    const tier = budget === undefined || summary.estimatedCost === undefined
      ? undefined
      : crossingTier(summary.estimatedCost.amount, budget)
    void store
    return {
      summary,
      budget,
      line,
      ...(advice === undefined ? {} : { advice }),
      ...(tier === undefined ? {} : { tier: { tier: tier.tier, message: tier.message } }),
    }
  }

  /** 记录"已问过某档"（每档只问一次）。 */
  markTierAsked(call: OfficeCall, tier: string): void {
    const { store, journal } = this.contextFor(call)
    const budget = this.budget(call) ?? defaultBudget()
    if (budget.askedTiers.includes(tier)) return
    const next: Budget = { ...budget, askedTiers: [...budget.askedTiers, tier] }
    store.writeYaml(['budget.yml'], { budget: next })
    journal.append('cost/updated', { askedTier: tier })
  }

  /** 超支三选一（追加预算/继续并记豁免/收敛范围）——留痕，且**绝不自动停**。 */
  decideBudget(call: OfficeCall, choice: BudgetChoice, note: string, at = new Date().toISOString()): Budget {
    const { store, journal } = this.contextFor(call)
    const budget = this.budget(call) ?? defaultBudget()
    const decision = { at, tier: `${Math.round((usedRatio(0, budget) ?? 0) * 100)}%`, choice, note }
    const next: Budget = { ...budget, decisions: [...budget.decisions, decision] }
    store.writeYaml(['budget.yml'], { budget: next })
    journal.append('budget/decision', { choice, note, at })
    return next
  }

  budgetAdviceLine(call: OfficeCall, used: number): string | undefined {
    const budget = this.budget(call)
    return budgetAdvice({ at: new Date().toISOString(), sessions: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, perModel: [], estimatedCost: { amount: used, currency: budget?.currency ?? 'CNY', label: '估算' }, unpricedTokens: 0 }, budget)
  }

  private projectIds(store: SdoStore): string[] {
    const cached = store.readJson<SdoProject>('project.json')
    return cached === undefined ? [] : [cached.id]
  }
}

/** 把流程字符串收敛到已知流程 ID。 */
function processIdOf(value: string): SdoProject['process'] {
  const known = ['waterfall', 'prototype', 'agile', 'spiral'] as const
  return (known as readonly string[]).includes(value) ? (value as SdoProject['process']) : 'waterfall'
}
