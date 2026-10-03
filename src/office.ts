/**
 * SDO 门面：从"会话 / 工作目录"解析出项目，并把领域模块（需求、审讯、门禁、渲染）暴露给界面层。
 *
 * 设计对应：§4.4/§4.5（.sdo 布局）、§5（需求工程）、§7（阶段与门禁）、§9.1（工具能力）、§10.1（渲染）。
 *
 * 纪律：
 *   · 一切写入都经 `SdoStore`（路径沙箱 + 原子写）与 `Journal`（唯一真源）；
 *   · 投影（project.json）只是派生视图，随时可由 journal 重建（AC-006）。
 */
import { statSync } from 'node:fs'
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
import { readBudgetChecked } from './integration/cost.js'
import type { FieldShapeNote } from './infra/scalar.js'
import { readAssessment, listScenarios, recordScenario, writeAssessment } from './domain/quality.js'
import type { RecordScenarioInput } from './domain/quality.js'
import { linkMany, renderTraceReport, report, unlink } from './domain/trace.js'
import { capacityPlan, independenceViolations } from './integration/orchestrator.js'
import { budgetAdvice, crossingTier, defaultBudget, describeBudgetLine, readCostSnapshot, summarize, usedRatio } from './integration/cost.js'
import type { Budget, BudgetChoice, CostSnapshot, UsageRow, UsageSummary } from './integration/cost.js'
import { claim, reassign, release, report as reportTask, staleClaims } from './domain/collab.js'
import type { ClaimInput, ClaimResult, ReportInput, ReportResult } from './domain/collab.js'
import { closeIteration, decompose, dropTask, listTasks, readIteration, readyTasks, startIteration, validatePlan } from './domain/plan.js'
import type { DecomposeInput, PlanIssue } from './domain/plan.js'
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
  renderTestPlan,
  updateDefect,
  verificationStats,
} from './domain/records.js'
import type {
  DeliveryManifest,
  Defect,
  PackageInput,
  Review,
  TestCase,
  TestResult,
} from './domain/records.js'
import { createChange, listChanges } from './domain/change.js'
import { renderHeader } from './infra/render.js'
import type { CreateChangeInput } from './domain/change.js'
import { evaluateDor, isEffectivelyOpen } from './domain/dor.js'
import type { DorResult } from './domain/dor.js'
import { assess, readFeasibility } from './domain/feasibility.js'
import type { AssessInput } from './domain/feasibility.js'
import { evaluateGate, satisfiedGates } from './domain/gates.js'
import type { GateContext } from './domain/gates.js'
import { disposeIssue, listIssues, openIssue, openIssues } from './domain/issues.js'
import { exitGates, exitGatesFrom, legalRollbackTargets, listProcessIds, loadProcess, nextPhase, pendingGate, phaseLabel } from './domain/process.js'
import {
  applicabilityLines,
  applicabilityState,
  confirmApplicability,
  draftApplicability,
  readApplicability,
} from './domain/applicability.js'
import { recordSignature, signoffInput, signatureState } from './domain/signature.js'
import { gateIdOf, fmt, t } from './domain/i18n.js'
import type { RiskConclusion } from './domain/risks.js'
import { listRisks, logRisk, readConclusion, riskStats, updateRisk, writeConclusion } from './domain/risks.js'
import { answerQuestion, askQuestions, listQuestions, validateProposed, weakDimensions, writeProposedQuestions } from './domain/grill.js'
import type { AnswerInput, AskInput, ProposedQuestion } from './domain/grill.js'
import {
  baselineRequirements,
  captureRequirement,
  listRequirementIds,
  listRequirements,
  readRequirement,
  scoringContext,
  updateRequirement,
  writeRequirement,
} from './domain/requirements.js'
import type { CaptureInput, UpdateInput } from './domain/requirements.js'
import { loadScoring, normalizeModelDimensions, scoreRequirement } from './domain/scoring.js'
import { Journal } from './infra/journal.js'
import { nextId } from './infra/ids.js'
import { renderSrs } from './infra/render.js'
import { SdoStore } from './infra/store.js'
import type {
  Adr,
  ChangeRequest,
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
  UiView,
} from './types.js'
import { SURFACES } from './types.js'
import type { ApplicabilityDraftInput, ApplicabilityState } from './domain/applicability.js'
import type { SignatureState } from './domain/signature.js'
import { methodDocStatus } from './domain/methodDocs.js'
import type { MethodDocStatus } from './domain/methodDocs.js'
import { recordWorkspaceChanges, unresolvedSeqs } from './domain/workspaceChanges.js'
import { readChildFaces, recordChildFace } from './domain/dispatchFace.js'
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
}

const REJECT_KEY: Record<string, string> = {
  empty: 'redteam.fileEmpty',
  tooShort: 'redteam.fileTooShort',
  tooLong: 'redteam.fileTooLong',
  notQuestion: 'redteam.fileNotQuestion',
  noKeyword: 'redteam.fileNoKeyword',
  duplicate: 'redteam.fileDuplicate',
}

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
   * **上层目录里别的项目**（实测 `/home/raiptor/.sdo/` 让所有在 `$HOME` 下的会话都读同一个项目，
   * 即"仍串工作区"）。因此现在**只认本层**：
   *   · 本层没有 `.sdo/` → 视为未初始化（`sdo_status` 报"尚未初始化"），
   *   · **绝不向上爬、绝不猜别的项目**（宁可少显示，也不显示错的）。
   * `findProjectRoot` 仍保留在 `infra/discovery.ts`（供显式探测/测试用），但**不参与定位**。
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

  /** 追加一条事件（真源写入的统一入口）。 */
  appendEvent(call: OfficeCall, type: SdoEventType, data: Record<string, unknown>, actor = 'sdo'): void {
    this.journalFor(this.requireWorkspace(call)).append(type, data, actor)
  }

  /** 初始化项目（幂等）：建目录、写 config.yml、追加 project/created。 */
  init(call: OfficeCall, options: InitOptions = {}): InitResult {
    const workspace = this.requireWorkspace(call)
    const store = this.storeFor(workspace)
    store.ensureLayout()
    const journal = new Journal(store)

    const existing = journal.loadProject().project
    if (existing !== undefined) {
      return { project: existing, created: false, dataDir: store.root }
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
      // **§7.1 不得静默（注入块那一处）**：声明的内容必须每轮都出现在状态块里，
      // 用户才能在模型动手之前看到"哪些视图做、哪些不做及理由"。
      applicabilityLines: applicabilityLines(readApplicability(store)),
      applicabilityConfirmed: applicabilityState(store).declaration?.confirmed !== undefined,
      gateSigned: signatureState(store, new Journal(store), 'G3').status === 'valid',
      ...(() => {
        const budget = readBudgetChecked(store).budget
        if (budget === undefined) return {}
        // 状态块里不重复调用宿主计量：只显示"预算已设 + 已问档位"
        const consumed = readCostSnapshot(store)?.amount ?? 0
        const line = describeBudgetLine(
          {
            at: new Date().toISOString(),
            sessions: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            perModel: [],
            ...(budget.total === undefined ? {} : { estimatedCost: { amount: consumed, currency: budget.currency, label: '估算' as const } }),
            unpricedTokens: 0,
          },
          budget,
        )
        const advice = budgetAdvice(
          {
            at: new Date().toISOString(),
            sessions: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            perModel: [],
            estimatedCost: { amount: consumed, currency: budget.currency, label: '估算' as const },
            unpricedTokens: 0,
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
    return captureRequirement(store, journal, project, input)
  }

  /** 更新一条需求（含追加验收标准）。 */
  update(call: OfficeCall, input: UpdateInput): { requirement: Requirement; flags: string[] } | undefined {
    const { store, journal, project } = this.contextFor(call)
    return updateRequirement(store, journal, project, input)
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
    journal.append('phase/exited', { phase: 'requirements' })
    journal.append('phase/entered', { phase: 'architecture' })
    return { ok: true, dor, baselined, gate }
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
  render(call: OfficeCall, which: 'srs' = 'srs'): string {
    const { store, journal, project, workspace } = this.contextFor(call)
    const seq = journal.read().events.length
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
          store.writeJson(['gates', `${gateId}.json`], failure)
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
    const evaluation = evaluateGate(process, id, context)
    store.writeJson(['gates', `${id}.json`], evaluation)
    journal.append('gate/result', {
      gate: evaluation.gate,
      status: evaluation.status,
      phase: evaluation.phase,
      ...gateResultDetail(evaluation),
    })
    return evaluation
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
    const exits = exitGates(process, project.phase)
    const evaluations = exits.map((gate) => evaluateGate(process, gate, context))
    const blocked = evaluations.find((evaluation) => evaluation.status !== 'passed' && evaluation.status !== 'waived')
    if (blocked !== undefined) {
      store.writeJson(['gates', `${blocked.gate}.json`], blocked)
      journal.append('gate/result', { gate: blocked.gate, status: blocked.status, phase: project.phase, ...gateResultDetail(blocked) })
      return { advanced: false, from: project.phase, blockedBy: blocked.gate, remedy: blocked.remedy }
    }
    for (const evaluation of evaluations) {
      // 现算结果**照写留痕**：即便与盘上旧记录不同，也以本次判定为准（这正是 D2 的语义）。
      store.writeJson(['gates', `${evaluation.gate}.json`], evaluation)
      journal.append('gate/result', { gate: evaluation.gate, status: evaluation.status, phase: project.phase, ...gateResultDetail(evaluation) })
    }
    const next = nextPhase(process, project.phase)
    journal.append('phase/exited', { phase: project.phase })
    if (next === undefined) {
      return { advanced: false, from: project.phase }
    }
    journal.append('phase/entered', { phase: next.id })
    return { advanced: true, from: project.phase, to: next.id }
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
   */
  signGate(call: OfficeCall, input: {
    gate: string
    by: string
    basis: string
    channel: 'command' | 'question'
    turn?: string | undefined
    basisChecked?: 'session' | 'unavailable' | undefined
  }): GateSignature {
    const { store, journal } = this.contextFor(call)
    return recordSignature(store, journal, input)
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

  /** 原话核对 + **核对口径**（R-7：调用点应把 `basisChecked` 落进签字台账）。 */
  checkUserQuote(call: OfficeCall, quote: string): { ok: boolean; basisChecked: 'session' | 'unavailable' } {
    const wanted = quote.trim().replace(/\s+/gu, ' ')
    if (wanted === '') return { ok: false, basisChecked: 'session' }
    const agent = call.agent as {
      session?: { deriveMessages?: () => { role?: unknown; content?: unknown }[] }
    } | undefined
    const derive = agent?.session?.deriveMessages
    if (typeof derive !== 'function') return { ok: true, basisChecked: 'unavailable' }
    let messages: { role?: unknown; content?: unknown }[]
    try {
      messages = agent?.session?.deriveMessages?.() ?? []
    } catch {
      return { ok: true, basisChecked: 'unavailable' }
    }
    const texts: string[] = []
    for (const message of messages) {
      if (message.role !== 'user') continue
      const content = message.content
      if (typeof content === 'string') {
        texts.push(content)
        continue
      }
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (typeof block === 'string') {
          texts.push(block)
          continue
        }
        if (typeof block === 'object' && block !== null) {
          const text = (block as { text?: unknown }).text
          if (typeof text === 'string') texts.push(text)
        }
      }
    }
    return { ok: texts.some((text) => text.replace(/\s+/gu, ' ').includes(wanted)), basisChecked: 'session' }
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
  waiveGate(call: OfficeCall, gateId: string, reason: string, approver: string): GateEvaluation {
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
    const resolved = normalizeGateId(gateId, processOfProject(project))
    const waivedGates = [...new Set([...tailoring.waivedGates, resolved])]
    journal.append('project/updated', {
      patch: { tailoring: { ...tailoring, waivedGates, reason, approver, at: new Date().toISOString() } },
    })
    journal.append('tailoring/updated', { waivedGates, reason, approver })
    const refreshed = this.gateContext(call, approver)
    const evaluation = evaluateGate(refreshed.process, resolved, refreshed.context)
    const recorded: GateEvaluation = { ...evaluation, status: 'waived', remedy: [] }
    store.writeJson(['gates', `${resolved}.json`], recorded)
    journal.append('gate/result', { gate: resolved, status: 'waived', phase: recorded.phase, reason, approver })
    return recorded
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
   * 基线后走变更控制：建 CR（含影响分析）；`approved` 才应用变更。
   *
   * **§6.7**：重算评分时**规则维度按新内容重算、模型维度沿用**（`input.dimensions`
   * 显式重给时优先）—— 旧实现两次都没传，模型通道的语义分被规则基线抹掉，
   * "变更 → 重新基线"于是被 C1 误拦。
   */
  change(call: OfficeCall, input: CreateChangeInput): {
    change: ChangeRequest
    applied: boolean
    reason?: string | undefined
    /** 本次重算评分时语义分的来源（回执要如实写出来，不静默） */
    dimensionsFrom?: 'explicit' | 'carried' | 'none' | undefined
  } {
    const { store, journal } = this.contextFor(call)
    const requirement = readRequirement(store, input.requirement)
    if (requirement === undefined) return { change: createChange(store, journal, input), applied: false, reason: `找不到需求 ${input.requirement}` }
    if (requirement.status !== 'baselined' && requirement.status !== 'changed') {
      return {
        change: createChange(store, journal, input),
        applied: false,
        reason: '需求尚未基线：直接更新即可，不必走变更控制（设计 §5.5）',
      }
    }
    const change = createChange(store, journal, input)
    if (input.decision !== 'approved') {
      return { change, applied: false, reason: `决策为 ${input.decision}，未应用变更（已留档）` }
    }
    const next: Requirement = {
      ...requirement,
      ...(input.patch ?? {}),
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
    return {
      change,
      applied: true,
      dimensionsFrom: input.dimensions !== undefined ? 'explicit' : modelDimensions !== undefined ? 'carried' : 'none',
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
  confirmDesign(call: OfficeCall, target: string, basis: string, by: string): DesignConfirmation | undefined {
    const { store, journal } = this.contextFor(call)
    return confirmDesign(store, journal, target, basis, by)
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
    writeDesignDoc(workspace, text)
    // 字节数由**刚渲染出来的文本**给出：再去读一遍盘既多余，也容易被沙箱差异带偏（回执报 0 字节）
    const bytes = Buffer.byteLength(text, 'utf8')
    // **R-10**：把渲染时的**阶段**也写进事件 —— 头里的 `phase` 只有能被事件背书才可信，
    // 否则任何人都能把它改成"我是在交付阶段渲染的"（阶段只出现在头里、不进正文，
    // 整份文件比对拦不住它）。
    journal.append('design/rendered', { kind: 'DESIGN.md', seq, bytes, phase: project?.phase ?? '' })
    if (target === undefined) return { path: 'docs/DESIGN.md', bytes }
    const pumlPath = target.path
    const pumlBytes = writePlantUml(workspace, pumlPath, plantUmlText(readUiView(store)))
    // F-1：puml 骨架同样记 `phase`（同一渲染动作的两份产物，记录口径一致）
    journal.append('design/rendered', { kind: pumlPath, seq, bytes: pumlBytes, phase: project?.phase ?? '' })
    return { path: 'docs/DESIGN.md', bytes, pumlPath, pumlBytes }
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
  planDecompose(call: OfficeCall, input: DecomposeInput = {}): { tasks: TaskCard[]; issues: PlanIssue[]; notes?: string[] | undefined } {
    const { store, journal } = this.contextFor(call)
    const current = readIteration(store)
    // 已经有进行中的迭代时，拆出来的卡自动归入该迭代（否则迭代门禁无从判定）
    return decompose(store, journal, listRequirements(store), {
      ...input,
      ...(input.iteration === undefined && current !== undefined ? { iteration: current.number } : {}),
    })
  }

  tasks(call: OfficeCall): TaskCard[] {
    return listTasks(this.storeFor(this.requireWorkspace(call)))
  }

  taskById(call: OfficeCall, id: string): TaskCard | undefined {
    return this.tasks(call).find((task) => task.id === id)
  }

  planIssues(call: OfficeCall): PlanIssue[] {
    return validatePlan(this.tasks(call))
  }

  readyForDispatch(call: OfficeCall, limit = 4): TaskCard[] {
    return readyTasks(this.tasks(call), limit)
  }

  /** 认领（CAS）。 */
  /** D3-3：把卡置为 dropped（回收路径）。 */
  dropTask(call: OfficeCall, taskId: string, reason: string): TaskCard | undefined {
    const { store, journal } = this.contextFor(call)
    return dropTask(store, journal, taskId, reason)
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
    const outcome = claim(store, journal, sessionId === undefined ? input : { ...input, sessionId })
    this.roleCacheVersion += 1
    return outcome
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

  /** 容量预算内的派发计划。 */
  dispatchPlan(call: OfficeCall, maxParallel = this.settings.maxParallelDispatch): { dispatch: TaskCard[]; queued: TaskCard[] } {
    const tasks = this.tasks(call)
    const inProgress = tasks.filter((task) => task.status === 'in-progress').length
    return capacityPlan(readyTasks(tasks, 64), inProgress, maxParallel)
  }

  /** 记录派发决策（含后端与降级原因）。 */
  recordDispatch(call: OfficeCall, input: { taskId: string; backend: string; owner: string; degradedReason?: string | undefined }): void {
    const { journal } = this.contextFor(call)
    journal.append('dispatch/decided', {
      task: input.taskId,
      backend: input.backend,
      owner: input.owner,
      degradedReason: input.degradedReason ?? '',
    })
  }

  /**
   * **真派发留痕（P-1）**：宿主真的起了一次子代理运行 —— 记下 provider、子会话 id 与下发的工具数。
   * （只在 `startDispatch` 返回 `started:true` 时调用；失败只写 `dispatch/decided`，不写这里。）
   */
  recordDispatchStarted(call: OfficeCall, input: { taskId: string; provider: string; childSessionId: string; tools: number; role?: string | undefined }): void {
    const { journal } = this.contextFor(call)
    journal.append('dispatch/started', {
      task: input.taskId,
      provider: input.provider,
      childSessionId: input.childSessionId,
      tools: input.tools,
      ...(input.role === undefined ? {} : { role: input.role }),
    })
  }

  /**
   * **补记文件清单**（A2 的竞态修法）：宿主先 append `workspace/changes` 事件、之后才写摘要记录，
   * 所以采集当时拿不到文件清单。`done` 时（会话仍活着）再取一次，取到就补一条带摘要的记录。
   */
  noteResolvedWorkspaceChanges(call: OfficeCall, input: { sessionId: string; seq: number; files: string[] }): void {
    const { store } = this.contextFor(call)
    recordWorkspaceChanges({
      store,
      sessionId: input.sessionId,
      seq: input.seq,
      summary: { files: input.files.map((path) => ({ path })) },
      enabled: true,
      hasProject: true,
    })
  }

  /** 本会话派发出去的子会话（来自 `dispatch/started`；带卡上的角色，用于算"掩码外工具"）。 */
  dispatchedChildren(call: OfficeCall): { childSessionId: string; taskId: string; role: string; provider: string }[] {
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
      }))
      .filter((item) => item.childSessionId !== '')
  }

  /** 记一条"子代理工具面观测"（评审 §4.2：把"是否收窄"变成可核对的事实）。 */
  noteChildFace(call: OfficeCall, input: { childSessionId: string; tools: string[]; violations: string[]; calls?: string[] | undefined; callCount?: number | undefined }): void {
    const { store } = this.contextFor(call)
    recordChildFace(store, input)
  }

  /** 读回观测（供回执里如实展示）。 */
  childFaces(call: OfficeCall): ChildFaceEntry[] {
    return readChildFaces(this.storeFor(this.requireWorkspace(call))).faces
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
    return recordTestCase(store, journal, input)
  }

  addTestResult(call: OfficeCall, input: Omit<TestResult, 'id' | 'at'>): TestResult {
    const { store, journal } = this.contextFor(call)
    return recordTestResult(store, journal, input)
  }

  defects(call: OfficeCall): Defect[] {
    return listDefects(this.storeFor(this.requireWorkspace(call)))
  }

  addDefect(call: OfficeCall, input: Omit<Defect, 'id' | 'at'>): Defect {
    const { store, journal } = this.contextFor(call)
    return recordDefect(store, journal, input)
  }

  setDefectStatus(call: OfficeCall, id: string, status: Defect['status']): Defect | undefined {
    const { store, journal } = this.contextFor(call)
    return updateDefect(store, journal, id, status)
  }

  verification(call: OfficeCall): ReturnType<typeof verificationStats> {
    return verificationStats(this.storeFor(this.requireWorkspace(call)))
  }

  reviews(call: OfficeCall): Review[] {
    return listReviews(this.storeFor(this.requireWorkspace(call)))
  }

  addReview(call: OfficeCall, input: Omit<Review, 'id' | 'at'>): Review {
    const { store, journal } = this.contextFor(call)
    return recordReview(store, journal, input)
  }

  /** 评审独立性问题（作者 = 评审者）。 */
  reviewViolations(call: OfficeCall): { reviewId: string; detail: string }[] {
    return independenceViolations(this.reviews(call), this.tasks(call))
  }

  // 交付

  manifest(call: OfficeCall): DeliveryManifest | undefined {
    return readManifest(this.storeFor(this.requireWorkspace(call)))
  }

  packageDelivery(call: OfficeCall, input: Omit<PackageInput, 'workspace' | 'prototypeDir'>): { manifest: DeliveryManifest; missingArtifacts: string[] } {
    const { store, journal, workspace } = this.contextFor(call)
    const config = readProjectConfig(store).config
    return packageDelivery(store, journal, { ...input, workspace, prototypeDir: config.prototype.dir })
  }

  /** 渲染 `docs/TESTPLAN.md` 与 `docs/DELIVERY.md`。 */
  renderVerificationDocs(call: OfficeCall): string[] {
    const { store, journal, workspace } = this.contextFor(call)
    const seq = journal.read().events.length
    const written: string[] = []
    written.push(
      this.relativize(
        workspace,
        new SdoStore(workspace).writeText(
          ['docs', 'TESTPLAN.md'],
          renderTestPlan({
            cases: listTestCases(store),
            defects: listDefects(store),
            header: renderHeader('.sdo/tests/', seq),
          }),
        ),
      ),
    )
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
    const line = describeBudgetLine(summary, budget)
    const advice = budgetAdvice(summary, budget)
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
