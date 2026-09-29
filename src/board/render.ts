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
import type { GateEvaluation, Phase, Priority, ProcessDef, SdoProject, TaskCard } from '../types.js'

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
  if (project === undefined) return '（尚未初始化）'
  const passed = gates.filter((gate) => gate.status === 'passed').map((gate) => gate.gate)
  const waived = gates.filter((gate) => gate.status === 'waived').map((gate) => gate.gate)
  const failed = gates.filter((gate) => gate.status === 'failed').map((gate) => gate.gate)
  const parts = [`待判定 ${pending ?? '（无）'}`]
  if (passed.length > 0) parts.push(`已通过 ${passed.join(' ')}`)
  if (waived.length > 0) parts.push(`已豁免 ${waived.join(' ')}`)
  if (failed.length > 0) parts.push(`未通过 ${failed.join(' ')}`)
  if (!all && gates.length > 5) {
    parts.push(`最近 5 条 ${gates.slice(-5).map((gate) => `${gate.gate}:${gate.status}`).join(' ')}`)
  }
  return parts.join(' ｜ ')
}

/** 渲染文本看板。 */
export function renderBoard(model: BoardModel, options: BoardOptions = {}): string {
  const lines: string[] = ['# SDO 看板', '']
  const { project } = model

  if (project === undefined) {
    lines.push(`尚未初始化：当前工作目录下没有 \`${model.dataDirName}/\`。`)
    lines.push('')
    lines.push('下一步：调用 `sdo_init`（或在交互式会话里用 `/sdo-status` 查看原因）。')
    return `${lines.join('\n')}\n`
  }

  lines.push(`项目　${project.id} ${project.name}`)
  lines.push(
    `流程　${project.process} ｜ 规模　${project.tailoring?.scale ?? model.config.scale} ｜ 阶段　${project.phase}`
    + ` ｜ 需求　${model.counts.requirements} 条`,
  )
  lines.push(`门禁　${gateSummary(project, model.gates, options.all === true, model.pendingGate)}`)
  lines.push(`审讯　问题账本 ${model.counts.questions} 条（未决 ${model.counts.openQuestions}）｜ 门禁记录 ${model.counts.gates} ｜ 证据 ${model.counts.evidence}`)
  lines.push('')
  lines.push('## 阶段')
  lines.push('')
  lines.push(`- ${phaseLine(project, model.gates, model.process)}`)
  if (model.iteration !== undefined) {
    lines.push(`- 迭代 ${model.iteration.number}（${model.iteration.status}）：${model.iteration.goal}`)
  }
  lines.push('')

  if (model.truncated) {
    lines.push(`> ⚠️ journal 尾部损坏（第 ${model.badLine ?? '?'} 行），看板只反映最后一个一致前缀。`)
    lines.push('')
  }

  const window = model.config.board.window
  const shown = options.all === true ? model.requirements : model.requirements.slice(0, window)
  if (shown.length > 0) {
    lines.push(`## 需求${options.all === true ? '（全部）' : `（前 ${shown.length}/${model.requirements.length}，--all 看全部）`}`)
    lines.push('')
    for (const requirement of shown) {
      const detail = options.expand === true ? `　${requirement.status}　${requirement.score}/16　未决 ${requirement.open}` : ''
      lines.push(`- ${requirement.id}　[${requirement.priority}]　${requirement.title}${detail}`)
    }
    lines.push('')
  } else {
    lines.push('## 需求')
    lines.push('')
    lines.push('（暂无；`sdo_requirement action=capture` 开始收集）')
    lines.push('')
  }

  if (options.expand === true) {
    const redTeamDefault =
      model.config.redTeam === 'on' ||
      (model.config.redTeam === 'auto' && (project.tailoring?.scale ?? model.config.scale) !== 'trivial')
    const enabled = project.redTeam?.enabled ?? redTeamDefault
    lines.push('## 展开信息')
    lines.push('')
    lines.push(
      `- 红队：${enabled ? '启用' : '停用'}（默认 ${redTeamDefault ? '启用' : '停用'}${project.redTeam?.reason === undefined ? '' : `，${project.redTeam.reason}`}）`,
    )
    if (project.scope.in.length > 0) lines.push(`- 范围（in）：${project.scope.in.join('；')}`)
    if (project.scope.out.length > 0) lines.push(`- 非目标（out）：${project.scope.out.join('；')}`)
    if (project.stakeholders.length > 0) {
      lines.push(`- 干系人：${project.stakeholders.map((stakeholder) => `${stakeholder.id} ${stakeholder.role}`).join('；')}`)
    }
    if (project.metrics.success.length > 0) lines.push(`- 成功度量：${project.metrics.success.join('；')}`)
    lines.push(`- 数据目录：\`${model.dataDirName}/\`（真源 journal.jsonl；project.json 为派生视图）`)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

/** 阶段的中文名：从流程数据取（数据缺失时退回 id）。 */
export function phaseLabel(process: ProcessDef, phase: Phase): string {
  return process.phases.find((item) => item.id === phase)?.name ?? phase
}
