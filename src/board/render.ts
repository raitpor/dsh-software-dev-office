/**
 * 文本看板：**只读、确定性、可幂等重放**（设计 §10.5 / REQ-026/027）。
 *
 * 约定：
 *   · 输出只由输入状态决定，同样的状态必须逐字节相同；
 *   · 默认只显示"活动 + 最近 N 条已完成"（Q-12），`--all` 才展开全部；
 *   · 任何口径都写清（金额是估算等），M5 起生效。
 */
import type { ProjectConfig } from '../config.js'
import type { ProjectCounts } from '../office.js'
import { processOfProject } from '../office.js'
import type { OfficeCall, SoftwareDevOffice, StatusSnapshot } from '../office.js'
import type { GateEvaluation, Phase, Priority, ProcessDef, SdoProject, TaskCard } from '../types.js'
import { fmt, gateWithId, label, phaseText, t } from '../domain/i18n.js'

/** 看板上一条需求。 */
export interface BoardRequirement {
  id: string
  title: string
  priority: Priority
  status: string
  /** 歧义评分 0..16 */
  score: number
  /** 未决问题数 */
  open: number
}

export interface BoardModel {
  project: SdoProject | undefined
  config: ProjectConfig
  counts: ProjectCounts
  gates: GateEvaluation[]
  /** 当前项目所用流程（阶段与门禁由数据决定） */
  process: ProcessDef
  /** 当前阶段待判定的门禁 */
  pendingGate: string | undefined
  /** **R-7 可见性**：读真源失败的说明（有它时看板必须显式说明「下面的数字不可信」） */
  truthError?: string | undefined
  /** 任务卡（M6：看板显示各角色的工作内容） */
  tasks?: TaskCard[] | undefined
  /** 当前迭代 */
  iteration?: { number: number; goal: string; status: string } | undefined
  requirements: BoardRequirement[]
  dataDirName: string
  truncated: boolean
  badLine?: number | undefined
}

export interface BoardOptions {
  expand?: boolean | undefined
  all?: boolean | undefined
}

/**
 * 组装看板用的门禁一览：**当前阶段的出口门禁走现算**，其余按留痕（N-10）。
 *
 * 为什么必须这样：D2 之后 `advance` 现算出口门禁，而看板此前直接印 `gates/*.json` 留痕 ——
 * 于是同一次渲染里会出现"待判定 G3"（现算）与"已通过 … G3"（留痕）两个相反结论，
 * 用户不知道该信谁。留痕只对**不再作为出口门禁**的历史门禁有意义（它们是历史事实）。
 */
export function boardGates(ledger: GateEvaluation[], fresh: GateEvaluation[]): GateEvaluation[] {
  const freshByGate = new Map(fresh.map((evaluation) => [evaluation.gate, evaluation]))
  const substituted = ledger.map((evaluation) => freshByGate.get(evaluation.gate) ?? evaluation)
  for (const evaluation of fresh) {
    if (!substituted.some((item) => item.gate === evaluation.gate)) substituted.push(evaluation)
  }
  return substituted
}

const PHASE_MARK = { done: '✓', current: '▶', waived: '~', todo: '·' } as const

function phaseLine(project: SdoProject, gates: GateEvaluation[], process: ProcessDef): string {
  const waived = new Set(gates.filter((gate) => gate.status === 'waived').map((gate) => gate.gate))
  const marks: string[] = []
  for (const definition of process.phases) {
    const record = project.phaseHistory.find((item) => item.phase === definition.id)
    const label = definition.name ?? definition.id
    if (record === undefined) {
      marks.push(`${PHASE_MARK.todo} ${label}`)
      continue
    }
    if (record.exited !== undefined) {
      const waivedHere = definition.exit.some((gate) => waived.has(gate))
      marks.push(`${waivedHere ? PHASE_MARK.waived : PHASE_MARK.done} ${label}`)
      continue
    }
    marks.push(`${PHASE_MARK.current} ${label}`)
  }
  return marks.join(' → ')
}

function gateSummary(project: SdoProject | undefined, gates: GateEvaluation[], all: boolean, pending: string | undefined): string {
  if (project === undefined) return t('uiRender.k1')
  const passed = gates.filter((gate) => gate.status === 'passed').map((gate) => gate.gate)
  const waived = gates.filter((gate) => gate.status === 'waived').map((gate) => gate.gate)
  const failed = gates.filter((gate) => gate.status === 'failed').map((gate) => gate.gate)
  const parts = [fmt('uiRender.k39', { p1: pending === undefined || pending === '' ? t('uiRender.k41') : gateWithId(pending) })]
  if (passed.length > 0) parts.push(fmt('uiRender.k2', { p1: passed.join(' ') }))
  if (waived.length > 0) parts.push(fmt('uiRender.k3', { p1: waived.join(' ') }))
  if (failed.length > 0) parts.push(fmt('uiRender.k4', { p1: failed.join(' ') }))
  if (!all && gates.length > 5) {
    parts.push(fmt('uiRender.k5', { p1: gates.slice(-5).map((gate) => `${gate.gate}:${gate.status}`).join(' ') }))
  }
  return parts.join(' ｜ ')
}

/**
 * 装配看板模型（**§4.1/§4.2，评审员**）：把 index.ts 里那段拼装抽出来，good 处有三：
 *
 *   1. **可测**：看板是**命令**（`/sdo-board`），不经工具面，抽出来才能在测试里走真实装配；
 *   2. **读真源失败不整条失败**：`boardRequirements` 会读需求真源，真源写坏时旧实现**装配自身**就抛，
 *      于是只读展示整条打不开。这里转成"空列表 + readError"，看板照常出图并在顶部告警；
 *   3. **`truthError` 一路带到渲染**：`status.truthError` 必须出现在看板正文里（不能只是 API 字段）。
 */
export function boardModelFor(
  office: Pick<
    SoftwareDevOffice,
    'gatesFor' | 'currentExitGates' | 'boardRequirements' | 'process' | 'tasks' | 'iteration'
  >,
  status: StatusSnapshot,
  call: OfficeCall,
  dataDirName: string,
): { model: BoardModel; readError?: string | undefined } {
  const problems: string[] = []
  /** 统一的"读得动就用、读不动就记下并降级"包装（§5.3：`process` 此前没兜，`/sdo-board` 整条失败）。 */
  const guarded = <T>(label: string, read: () => T, fallback: T): T => {
    try {
      return read()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      problems.push(fmt('uiIndex.truthReadFailed', { p1: label, p2: message }))
      return fallback
    }
  }
  const requirements = guarded('boardRequirements', () => office.boardRequirements(call), [])
  // 流程定义读不出时退回瀑布流程（随包数据），这样看板仍能出图并在顶部告警
  const process = guarded('process', () => office.process(call), processOfProject(undefined))
  const gates = guarded('gatesFor', () => boardGates(office.gatesFor(call), office.currentExitGates(call)), [])
  const tasks = guarded('tasks', () => office.tasks(call), undefined)
  const iteration = guarded('iteration', () => office.iteration(call), undefined)
  const readError = problems.length === 0 ? undefined : problems.join('；')
  const truthError = [status.truthError, readError].filter((item): item is string => item !== undefined && item !== '').join('；')
  const model: BoardModel = {
    project: status.project,
    config: status.config,
    counts: status.counts,
    gates,
    requirements,
    process,
    pendingGate: status.pendingGate,
    ...(tasks === undefined ? {} : { tasks }),
    ...(iteration === undefined ? {} : { iteration }),
    dataDirName,
    truncated: status.truncated,
    ...(status.badLine === undefined ? {} : { badLine: status.badLine }),
    ...(truthError === '' ? {} : { truthError }),
  }
  return { model, ...(readError === undefined ? {} : { readError }) }
}

/** 渲染文本看板。 */
export function renderBoard(model: BoardModel, options: BoardOptions = {}): string {
  const lines: string[] = [t('uiRender.k40'), '']
  const { project } = model
  if (model.truthError !== undefined && model.truthError !== '') {
    lines.push(fmt('uiRender.truthError', { p1: model.truthError }))
  }

  if (project === undefined) {
    lines.push(fmt('uiRender.k6', { p1: model.dataDirName }))
    lines.push('')
    lines.push(t('uiRender.k7'))
    return `${lines.join('\n')}\n`
  }

  lines.push(fmt('uiRender.k8', { p1: project.id, p2: project.name }))
  lines.push(
    fmt('uiRender.k9', { p1: t(`process.${project.process}`, project.process), p2: label('scale', project.tailoring?.scale ?? model.config.scale) })
    + fmt('uiRender.k10', { p1: phaseText(project.phase) })
    + fmt('uiRender.k11', { p1: model.counts.requirements }),
  )
  lines.push(fmt('uiRender.k12', { p1: gateSummary(project, model.gates, options.all === true, model.pendingGate) }))
  lines.push(fmt('uiRender.k13', { p1: model.counts.questions, p2: model.counts.openQuestions, p3: model.counts.gates, p4: model.counts.evidence }))
  lines.push('')
  lines.push(t('uiRender.k14'))
  lines.push('')
  lines.push(`- ${phaseLine(project, model.gates, model.process)}`)
  if (model.iteration !== undefined) {
    lines.push(fmt('uiRender.k15', { p1: model.iteration.number, p2: label('iterationStatus', model.iteration.status), p3: model.iteration.goal }))
  }
  lines.push('')

  if (model.truncated) {
    lines.push(fmt('uiRender.k16', { p1: model.badLine ?? '?' }))
    lines.push('')
  }

  lines.push(t('uiRender.k17'))
  lines.push('')
  const boardTasks = model.tasks ?? []
  if (boardTasks.length === 0) {
    lines.push(t('uiRender.k18'))
  } else {
    const counts: Record<string, number> = {}
    for (const task of boardTasks) counts[task.status] = (counts[task.status] ?? 0) + 1
    lines.push(
      fmt('uiRender.k19', { p1: boardTasks.length, p2: Object.entries(counts).map(([status, count]) => `${label('taskStatus', status)} ${count}`).join('，') }),
    )
    lines.push('')
    for (const task of boardTasks) {
      const owner = task.owner === undefined || task.owner === '' ? t('uiRender.k42') : task.owner
      lines.push(`- ${task.id}　${label('role', task.role)}　${label('taskStatus', task.status)}　${owner}　${task.title}`)
      if (options.expand === true || options.all === true) {
        lines.push(fmt('uiRender.k20', { p1: task.dod.join('；') || t('uiRender.k34'), p2: task.writeScopes.join('、') || t('uiRender.k35') }))
        if (task.evidence.length > 0) lines.push(fmt('uiRender.k21', { p1: task.evidence.map((item) => `${item.kind}:${item.detail}`).join('；') }))
        if (task.blockedReason !== undefined) lines.push(fmt('uiRender.k22', { p1: task.blockedReason }))
      }
    }
  }
  lines.push('')

  const window = model.config.board.window
  const shown = options.all === true ? model.requirements : model.requirements.slice(0, window)
  if (shown.length > 0) {
    lines.push(fmt('uiRender.k23', { p1: options.all === true ? t('uiRender.k43') : fmt('uiRender.k36', { p1: shown.length, p2: model.requirements.length }) }))
    lines.push('')
    for (const requirement of shown) {
      const detail =
        options.expand === true
          ? fmt('uiRender.k24', { p1: label('requirementStatus', requirement.status), p2: requirement.score, p3: requirement.open })
          : ''
      lines.push(`- ${requirement.id}　[${label('priority', requirement.priority)}]　${requirement.title}${detail}`)
    }
    lines.push('')
  } else {
    lines.push(t('uiRender.k25'))
    lines.push('')
    lines.push(t('uiRender.k26'))
    lines.push('')
  }

  if (options.expand === true) {
    const redTeamDefault =
      model.config.redTeam === 'on' ||
      (model.config.redTeam === 'auto' && (project.tailoring?.scale ?? model.config.scale) !== 'trivial')
    const enabled = project.redTeam?.enabled ?? redTeamDefault
    lines.push(t('uiRender.k27'))
    lines.push('')
    lines.push(
      fmt('uiRender.k28', { p1: enabled ? t('uiRender.k44') : t('uiRender.k37'), p2: redTeamDefault ? t('uiRender.k45') : t('uiRender.k38'), p3: project.redTeam?.reason === undefined ? '' : `，${project.redTeam.reason}` }),
    )
    if (project.scope.in.length > 0) lines.push(fmt('uiRender.k29', { p1: project.scope.in.join('；') }))
    if (project.scope.out.length > 0) lines.push(fmt('uiRender.k30', { p1: project.scope.out.join('；') }))
    if (project.stakeholders.length > 0) {
      lines.push(fmt('uiRender.k31', { p1: project.stakeholders.map((stakeholder) => `${stakeholder.id} ${stakeholder.role}`).join('；') }))
    }
    if (project.metrics.success.length > 0) lines.push(fmt('uiRender.k32', { p1: project.metrics.success.join('；') }))
    lines.push(fmt('uiRender.k33', { p1: model.dataDirName }))
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

/** 阶段的中文名：从流程数据取（数据缺失时退回 id）。 */
export function phaseLabel(process: ProcessDef, phase: Phase): string {
  return process.phases.find((item) => item.id === phase)?.name ?? phase
}
