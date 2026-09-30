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
import { listAdrs, recordAdr, supersedeAdr } from './domain/adr.js'
import type { RecordAdrInput } from './domain/adr.js'
import { dropContract, listContracts, recordContract } from './domain/contracts.js'
import type { RecordContractInput } from './domain/contracts.js'
import { readAssessment, listScenarios, recordScenario, writeAssessment } from './domain/quality.js'
import type { RecordScenarioInput } from './domain/quality.js'
import { linkMany, renderTraceReport, report } from './domain/trace.js'
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
import { evaluateDor } from './domain/dor.js'
import type { DorResult } from './domain/dor.js'
import { assess, readFeasibility } from './domain/feasibility.js'
import type { AssessInput } from './domain/feasibility.js'
import { evaluateGate, satisfiedGates } from './domain/gates.js'
import type { GateContext } from './domain/gates.js'
import { disposeIssue, listIssues, openIssue, openIssues } from './domain/issues.js'
import { exitGates, listProcessIds, loadProcess, nextPhase, pendingGate, phaseLabel } from './domain/process.js'
import { gateIdOf, t } from './domain/i18n.js'
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
import { loadScoring, scoreRequirement } from './domain/scoring.js'
import { Journal } from './infra/journal.js'
import { nextId } from './infra/ids.js'
import { renderSrs } from './infra/render.js'
import { SdoStore } from './infra/store.js'
import type {
  Adr,
  ChangeRequest,
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
  ProcessDef,
  RedTeamIssue,
  Requirement,
  RiskItem,
  Scale,
  SdoEventType,
  SdoProject,
} from './types.js'

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

/** 当前阶段的**待判定**出口门禁（已通过/已豁免的不算）。 */
export function pendingGateOf(project: SdoProject | undefined, evaluations: Iterable<GateEvaluation>): string | undefined {
  if (project === undefined) return undefined
  const process = processOfProject(project)
  return pendingGate(process, project.phase, satisfiedGates(evaluations))
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
      }
    }
    const context = this.contextFor(call)
    const { store, project } = context
    const configRead = readProjectConfig(store)
    const questions = listQuestions(store)
    const gates = this.gatesFor(call)
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
      pendingGate: pendingGateOf(project, gates),
      lastGate: gates.at(-1),
      riskConclusion: context.riskConclusion,
      risks: (() => {
        const stats = riskStats(listRisks(store))
        return { total: stats.total, open: stats.open, blockers: stats.blockers, high: stats.high }
      })(),
      openIssues: openIssues(store, questions, listRisks(store)).length,
      feasibilityVerdict: readFeasibility(store)?.verdict,
      changes: listChanges(store).length,
      ...(() => {
        const budget = store.readYaml<{ budget: Budget }>('budget.yml')?.budget
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
    return snapshot
  }

  /** 显式重建投影（`sdo_status --rebuild` / `/sdo-status --rebuild`）。 */
  rebuild(call: OfficeCall): { rebuilt: boolean; truncated: boolean } {
    const result = this.journalFor(this.requireWorkspace(call)).rebuild()
    return { rebuilt: result.project !== undefined, truncated: result.truncated }
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
      if (!String(event.type).startsWith('gate/')) continue
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
    return answerQuestion(store, journal, project, input)
  }

  /** 问题账本。 */
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
        && question.status === 'open'
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
    const { store, project } = this.contextFor(call)
    return evaluateDor({
      project,
      requirements: listRequirements(store),
      questions: listQuestions(store),
      redTeamExecuted: this.redTeamExecuted(call),
      redTeamDisabled: this.redTeamDisabled(call),
      ...(approvedBy === undefined ? {} : { approvedBy }),
    })
  }

  /** 基线冻结：DoR 通过才允许；写 `requirement/baselined` + `gate/result` + `gates/G2.json`。 */
  baseline(call: OfficeCall, options: { approvedBy?: string | undefined; evidence?: string | undefined } = {}): BaselineOutcome {
    const { store, journal, project } = this.contextFor(call)
    const requirements = listRequirements(store)
    const dor = evaluateDor({
      project,
      requirements,
      questions: listQuestions(store),
      redTeamExecuted: this.redTeamExecuted(call),
      redTeamDisabled: this.redTeamDisabled(call),
      ...(options.approvedBy === undefined ? {} : { approvedBy: options.approvedBy }),
    })
    if (!dor.ok) {
      return { ok: false, dor, baselined: [] }
    }
    const evidence = options.evidence ?? `DoR 通过（评分阈值 ${loadScoring().threshold}/16）`
    const baselined = baselineRequirements(
      store,
      journal,
      requirements.map((requirement) => requirement.id),
      { by: options.approvedBy ?? 'human', evidence },
    )
    const gate: GateEvaluation = {
      gate: 'G2',
      phase: project?.phase ?? 'requirements',
      status: 'passed',
      at: new Date().toISOString(),
      criteria: dor.criteria.map((criterion) => ({
        id: criterion.id,
        ok: criterion.ok,
        detail: criterion.detail,
        ...(criterion.remedy === undefined ? {} : { remedy: criterion.remedy }),
      })),
      remedy: [],
    }
    store.writeJson(['gates', 'G2.json'], gate)
    journal.append('gate/result', { gate: 'G2', status: 'passed', phase: 'requirements' })
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

  /** 判定一个门禁（**只算不写**）。 */
  evaluate(call: OfficeCall, gateId: string, approvedBy?: string): GateEvaluation {
    const { process, context } = this.gateContext(call, approvedBy)
    return evaluateGate(process, normalizeGateId(gateId, process), context)
  }

  /** 判定并落盘（写 `gates/<id>.json` + `gate/result`）。 */
  checkGate(call: OfficeCall, gateId: string, approvedBy?: string): GateEvaluation {
    const { store, journal, process, context } = this.gateContext(call, approvedBy)
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
      failed: evaluation.criteria.filter((criterion) => !criterion.ok).map((criterion) => criterion.id),
    })
    return evaluation
  }

  /** 推进到下一阶段：当前阶段的出口门禁必须全部通过/豁免。 */
  advance(call: OfficeCall): {
    advanced: boolean
    from: string
    to?: string | undefined
    blockedBy?: string | undefined
    remedy?: string[] | undefined
  } {
    const { store, journal, project, process, context } = this.gateContext(call)
    if (project === undefined) throw new Error('项目尚未初始化：请先调用 `sdo_init`。')
    const exits = exitGates(process, project.phase)
    const satisfied = satisfiedGates(this.gatesFor(call))
    const blocked = exits.find((gate) => !satisfied.has(gate))
    if (blocked !== undefined) {
      const evaluation = evaluateGate(process, blocked, context)
      store.writeJson(['gates', `${blocked}.json`], evaluation)
      journal.append('gate/result', { gate: blocked, status: evaluation.status, phase: project.phase })
      return { advanced: false, from: project.phase, blockedBy: blocked, remedy: evaluation.remedy }
    }
    const next = nextPhase(process, project.phase)
    journal.append('phase/exited', { phase: project.phase })
    if (next === undefined) {
      return { advanced: false, from: project.phase }
    }
    journal.append('phase/entered', { phase: next.id })
    return { advanced: true, from: project.phase, to: next.id }
  }

  /** 豁免一个门禁（留痕：写 tailoring.waivedGates + `gate/result: waived`）。 */
  waiveGate(call: OfficeCall, gateId: string, reason: string, approver: string): GateEvaluation {
    const { store, journal, project } = this.gateContext(call, approver)
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

  /** 当前阶段的门禁一览（流程定义 + 判定记录）。 */
  gateOverview(call: OfficeCall): { phase: string; exits: string[]; evaluations: GateEvaluation[] } {
    const { project, process } = this.gateContext(call)
    return {
      phase: project?.phase ?? '',
      exits: project === undefined ? [] : exitGates(process, project.phase),
      evaluations: this.gatesFor(call),
    }
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

  /** 基线后走变更控制：建 CR（含影响分析）；`approved` 才应用变更。 */
  change(call: OfficeCall, input: CreateChangeInput): { change: ChangeRequest; applied: boolean; reason?: string | undefined } {
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
    const scored = scoreRequirement({
      requirement: next,
      model: loadScoring(),
      context: scoringContext(this.contextFor(call).project),
    })
    next.ambiguity = scored.ambiguity
    writeRequirement(store, next)
    journal.append('requirement/updated', { id: next.id, via: change.id, version: next.version })
    return { change, applied: true }
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

  claimTask(call: OfficeCall, input: ClaimInput): ClaimResult {
    const { store, journal } = this.contextFor(call)
    return claim(store, journal, input)
  }

  /** 回报（done 必须带证据）。 */
  reportTask(call: OfficeCall, input: ReportInput): ReportResult {
    const { store, journal } = this.contextFor(call)
    const result = reportTask(store, journal, input)
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
    return this.storeFor(this.requireWorkspace(call)).readYaml<{ budget: Budget }>('budget.yml')?.budget
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
