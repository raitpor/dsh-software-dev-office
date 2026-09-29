/**
 * SDO 门面：从"会话 / 工作目录"解析出项目，并把领域模块（需求、审讯、门禁、渲染）暴露给界面层。
 *
 * 设计对应：§4.4/§4.5（.sdo 布局）、§5（需求工程）、§7（阶段与门禁）、§9.1（工具能力）、§10.1（渲染）。
 *
 * 纪律：
 *   · 一切写入都经 `SdoStore`（路径沙箱 + 原子写）与 `Journal`（唯一真源）；
 *   · 投影（project.json）只是派生视图，随时可由 journal 重建（AC-006）。
 */
import { basename, join, relative, resolve, sep } from 'node:path'

import type { BoardRequirement } from './board/render.js'
import type { ProjectConfig, Settings } from './config.js'
import { defaultProjectConfig, readProjectConfig, writeProjectConfig } from './config.js'
import { evaluateDor } from './domain/dor.js'
import type { DorResult } from './domain/dor.js'
import { answerQuestion, askQuestions, listQuestions } from './domain/grill.js'
import type { AnswerInput, AskInput } from './domain/grill.js'
import {
  baselineRequirements,
  captureRequirement,
  listRequirementIds,
  listRequirements,
  updateRequirement,
} from './domain/requirements.js'
import type { CaptureInput, UpdateInput } from './domain/requirements.js'
import { loadScoring } from './domain/scoring.js'
import { Journal } from './infra/journal.js'
import { nextId } from './infra/ids.js'
import { renderSrs } from './infra/render.js'
import { SdoStore } from './infra/store.js'
import type { GateStatus, GrillQuestion, Phase, Requirement, Scale, SdoEventType, SdoProject } from './types.js'

/** 阶段 → 进入该阶段时**已经过**的门禁（设计 §15.3 的门禁链）。 */
export const GATE_BEFORE_PHASE: Record<Phase, string | undefined> = {
  intake: undefined,
  feasibility: 'G0',
  requirements: 'G1',
  architecture: 'G2',
  design: 'G3',
  construction: 'G4',
  verification: 'G5',
  delivery: 'G6',
}

/** 阶段顺序（瀑布主干）。 */
export const PHASE_ORDER: readonly Phase[] = [
  'intake',
  'feasibility',
  'requirements',
  'architecture',
  'design',
  'construction',
  'verification',
  'delivery',
]

/** 该阶段的**出口**门禁（判定通过才能进入下一阶段）。 */
export function gateAfterPhase(phase: Phase): string {
  const index = PHASE_ORDER.indexOf(phase)
  const next = PHASE_ORDER[index + 1]
  return GATE_BEFORE_PHASE[next ?? 'delivery'] ?? 'G7'
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
  /** 项目已存在、但本次补齐/更新了台账字段 */
  updated: boolean
  /** 本次实际写入的字段名（供回执展示） */
  updatedFields: string[]
  dataDir: string
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
  /** 最近一次 G2 判定（无记录时 undefined） */
  lastGate: GateRecord | undefined
}

/** 门禁记录（`.sdo/gates/*.json`）。 */
export interface GateRecord {
  gate: string
  phase: Phase
  status: GateStatus
  at: string
  criteria: string[]
  remedy: string[]
}

/** 一次工具/命令调用携带的上下文。 */
export interface OfficeCall {
  sessionId?: string | undefined
}

/** 门禁判定结果（工具层用）。 */
export interface BaselineOutcome {
  ok: boolean
  dor: DorResult
  baselined: Requirement[]
  gate?: GateRecord | undefined
}

export class SoftwareDevOffice {
  /** 会话 → 工作目录。多会话并存在不同目录时也不会串。 */
  private readonly cwdBySession = new Map<string, string>()
  private lastCwd: string | undefined
  private lastSessionId: string | undefined

  constructor(readonly settings: Settings) {}

  /** 记录会话的工作目录（由 `session/created` 事件驱动）。 */
  noteSession(sessionId: string, cwd: string | undefined): void {
    this.lastSessionId = sessionId
    if (typeof cwd === 'string' && cwd !== '') {
      this.cwdBySession.set(sessionId, cwd)
      this.lastCwd = cwd
    }
  }

  /** 最近活跃会话的调用上下文（提示注入这类没有显式调用者的入口用）。 */
  currentCall(): OfficeCall {
    return this.lastSessionId === undefined ? {} : { sessionId: this.lastSessionId }
  }

  /** 解析本次调用应当作用的**工作目录**：会话 > 最近已知 > 进程 cwd。 */
  workspaceFor(call: OfficeCall, explicit?: string): string {
    if (typeof explicit === 'string' && explicit !== '') return resolve(explicit)
    if (call.sessionId !== undefined) {
      const known = this.cwdBySession.get(call.sessionId)
      if (known !== undefined) return resolve(known)
    }
    return resolve(this.lastCwd ?? process.cwd())
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
  } {
    const workspace = this.workspaceFor(call)
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
      ...(loaded.badLine === undefined ? {} : { badLine: loaded.badLine }),
    }
  }

  /** 追加一条事件（真源写入的统一入口）。 */
  appendEvent(call: OfficeCall, type: SdoEventType, data: Record<string, unknown>, actor = 'sdo'): void {
    this.journalFor(this.workspaceFor(call)).append(type, data, actor)
  }

  /** 初始化项目（幂等）：建目录、写 config.yml、追加 project/created。 */
  init(call: OfficeCall, options: InitOptions = {}): InitResult {
    const workspace = this.workspaceFor(call)
    const store = this.storeFor(workspace)
    store.ensureLayout()
    const journal = new Journal(store)

    const existing = journal.loadProject().project
    if (existing !== undefined) {
      // 已存在：**只补齐显式给出的字段**（幂等；不给字段就什么都不改）。
      const patch: Partial<SdoProject> = {}
      if (typeof options.name === 'string' && options.name.trim() !== '' && options.name.trim() !== existing.name) {
        patch.name = options.name.trim()
      }
      if (typeof options.process === 'string' && options.process !== '' && processIdOf(options.process) !== existing.process) {
        patch.process = processIdOf(options.process)
      }
      if (options.scopeIn !== undefined && options.scopeIn.length > 0) {
        patch.scope = { in: options.scopeIn, out: existing.scope.out }
      }
      if (options.scopeOut !== undefined && options.scopeOut.length > 0) {
        patch.scope = { in: patch.scope?.in ?? existing.scope.in, out: options.scopeOut }
      }
      if (options.stakeholders !== undefined && options.stakeholders.length > 0) {
        patch.stakeholders = options.stakeholders.map((role, index) => ({
          id: `STK-${String(index + 1).padStart(2, '0')}`,
          role,
          concerns: [] as string[],
        }))
      }
      if (options.metricsSuccess !== undefined && options.metricsSuccess.length > 0) {
        patch.metrics = { success: options.metricsSuccess, guardrail: existing.metrics.guardrail }
      }
      if (options.glossary !== undefined && Object.keys(options.glossary).length > 0) {
        patch.glossary = { ...existing.glossary, ...options.glossary }
      }
      if (options.scale !== undefined) {
        patch.tailoring = {
          scale: options.scale,
          waivedGates: options.scale === 'trivial' ? ['G1', 'G4', 'G6'] : [],
          reason: existing.tailoring?.reason ?? '按规模档调整',
          approver: existing.tailoring?.approver ?? 'human',
          at: new Date().toISOString(),
        }
      }
      const fields = Object.keys(patch)
      if (fields.length === 0) {
        return { project: existing, created: false, updated: false, updatedFields: [], dataDir: store.root }
      }
      journal.append('project/updated', { patch })
      const refreshed = journal.loadProject().project ?? existing
      return { project: refreshed, created: false, updated: true, updatedFields: fields, dataDir: store.root }
    }

    const config: ProjectConfig = defaultProjectConfig()
    if (typeof options.process === 'string' && options.process !== '') config.process = options.process
    if (options.scale !== undefined) config.scale = options.scale
    writeProjectConfig(store, config)

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
    return { project, created: true, updated: false, updatedFields: [], dataDir: store.root }
  }

  /** 读取状态快照（必要时重建投影）。 */
  status(call: OfficeCall): StatusSnapshot {
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
      pendingGate: project === undefined ? undefined : gateAfterPhase(project.phase),
      lastGate: gates.at(-1),
    }
    if (context.badLine !== undefined) snapshot.badLine = context.badLine
    return snapshot
  }

  /** 显式重建投影（`sdo_status --rebuild` / `/sdo-status --rebuild`）。 */
  rebuild(call: OfficeCall): { rebuilt: boolean; truncated: boolean } {
    const result = this.journalFor(this.workspaceFor(call)).rebuild()
    return { rebuilt: result.project !== undefined, truncated: result.truncated }
  }

  /** 读取门禁记录（按文件名字典序）。 */
  gatesFor(call: OfficeCall): GateRecord[] {
    const store = this.storeFor(this.workspaceFor(call))
    const records: GateRecord[] = []
    for (const name of store.listNames('gates')) {
      if (!name.endsWith('.json')) continue
      const record = store.readJson<GateRecord>('gates', name)
      if (record !== undefined && typeof record.gate === 'string') records.push(record)
    }
    return records
  }

  /** 看板所需的需求摘要。 */
  boardRequirements(call: OfficeCall): BoardRequirement[] {
    const store = this.storeFor(this.workspaceFor(call))
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
    return listRequirements(this.storeFor(this.workspaceFor(call)))
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
    return listQuestions(this.storeFor(this.workspaceFor(call)))
  }

  /** 红队是否已执行（`redteam/attack` 事件）。 */
  redTeamExecuted(call: OfficeCall): boolean {
    return this.journalFor(this.workspaceFor(call))
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
  redTeamAttack(call: OfficeCall, requirementIds: string[], limit = 4): { questions: GrillQuestion[]; skipped: string[] } {
    const { store, journal, project } = this.contextFor(call)
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
    const gate: GateRecord = {
      gate: 'G2',
      phase: 'requirements',
      status: 'passed',
      at: new Date().toISOString(),
      criteria: dor.criteria.map((criterion) => `${criterion.id}: ${criterion.detail}`),
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
