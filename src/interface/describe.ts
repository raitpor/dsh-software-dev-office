/**
 * 面向模型/人的文本输出（工具与命令共用一套口径）。
 *
 * 设计对应：§9.1（`sdo_status` 要给阶段、门禁缺口、开环问题、追溯覆盖率、产物清单）、
 * NFR-009（只出现相对路径）、NFR-012（成本类数字必须标注"估算"——M5 起）。
 */
import { DIMENSIONS } from '../types.js'
import type { GrillQuestion, Requirement } from '../types.js'
import type { BaselineOutcome, InitResult, StatusSnapshot } from '../office.js'
import { gateAfterPhase } from '../office.js'
import type { DorResult } from '../domain/dor.js'
import { phaseLabel } from '../board/render.js'

/** `sdo_init` 的回执。 */
export function describeInit(result: InitResult, dataDirName: string): string {
  const lines: string[] = []
  if (result.created) {
    lines.push(`已初始化 SDO 项目：${result.project.id} ${result.project.name}`)
    lines.push(`- 流程：${result.project.process} ｜ 规模：${result.project.tailoring?.scale ?? 'normal'} ｜ 阶段：${result.project.phase}`)
    lines.push(`- 数据目录：\`${dataDirName}/\`（真源 \`journal.jsonl\`）`)
    if (result.project.scope.out.length === 0) {
      lines.push('- ⚠️ 还没有非目标（out）——G0/G2 的硬条件，请与用户确认后补上。')
    }
    lines.push('- 下一步：用 `sdo_requirement action=capture` 收集需求（含干系人原话），再 `action=grill` 追问。')
  } else if (result.updated) {
    lines.push(`已更新项目台账：${result.project.id} ${result.project.name}`)
    lines.push(`- 本次写入字段：${result.updatedFields.join('、')}`)
    lines.push(`- 当前非目标：${result.project.scope.out.length === 0 ? '（无，G2 会拦）' : result.project.scope.out.join('；')}`)
    lines.push(`- 术语表：${Object.keys(result.project.glossary).length} 个术语`)
  } else {
    lines.push(`项目已存在，未做改动：${result.project.id} ${result.project.name}`)
    lines.push(`- 当前阶段：${result.project.phase}（${phaseLabel(result.project.phase)}）`)
    lines.push(`- 数据目录：\`${dataDirName}/\``)
  }
  return lines.join('\n')
}

/** 看板写盘等附加说明（单独成段，避免污染看板正文的确定性）。 */
export function describeBoardNote(note: string): string {
  return `> ${note}`
}

/** `sdo_status` / `/sdo-status` 的文本。 */
export function describeStatus(status: StatusSnapshot, dataDirName: string): string {
  const lines: string[] = ['SDO 状态']
  const { project } = status

  if (project === undefined) {
    lines.push(`- 尚未初始化：当前工作目录下没有 \`${dataDirName}/\`。`)
    lines.push('- 下一步：调用 `sdo_init`（项目名/流程/规模）。')
    return lines.join('\n')
  }

  const pending = status.pendingGate ?? gateAfterPhase(project.phase)
  lines.push(`- 项目：${project.id} ${project.name}`)
  lines.push(
    `- 流程：${project.process} ｜ 规模：${project.tailoring?.scale ?? status.config.scale} ｜ 阶段：${project.phase}（${phaseLabel(project.phase)}）`,
  )
  lines.push(`- 门禁缺口：待判定 ${pending} ｜ 最近判定：${status.lastGate === undefined ? '（无记录）' : `${status.lastGate.gate} ${status.lastGate.status} @ ${status.lastGate.at}`}`)
  lines.push(
    `- 需求：${status.counts.requirements} 条 ｜ 开环问题：${status.counts.openQuestions}（账本共 ${status.counts.questions} 条）`
    + ` ｜ 追溯覆盖率：—（M2 起提供）`,
  )
  lines.push(`- 证据：${status.counts.evidence} 条`)
  lines.push(
    `- 投影：${status.rebuilt ? '已从 journal 重建' : '来自 project.json'} ｜ 真源：`
    + `${status.truncated ? `journal.jsonl 尾部损坏（第 ${status.badLine ?? '?'} 行，已截断）` : 'journal.jsonl 正常'}`,
  )
  if (status.configSource === 'default') {
    lines.push(`- 提示：\`${dataDirName}/config.yml\` 缺失或不可读，当前用默认项目配置（流程 ${status.config.process} ｜ 规模 ${status.config.scale}）。`)
  }

  lines.push('- 产物清单：')
  lines.push(`  \`${dataDirName}/journal.jsonl\`（真源，追加式）`)
  lines.push(`  \`${dataDirName}/project.json\`（派生视图，可重建）`)
  lines.push(`  \`${dataDirName}/requirements/*.yml\` 与 \`${dataDirName}/questions/*.yml\`（需求与问题账本）`)
  lines.push(`  \`${dataDirName}/config.yml\`（项目级配置，人类可编辑）`)

  return lines.join('\n')
}

/** 需求评分的一行摘要。 */
export function describeScore(requirement: Requirement): string {
  const parts = DIMENSIONS.map((dimension) => `${dimension} ${requirement.ambiguity.dimensions[dimension] ?? 0}`)
  const review = requirement.ambiguity.needsReview === true ? '（规则/模型不一致，取更严者，需复核）' : ''
  return `${requirement.ambiguity.score}/16${review} ｜ ${parts.join(' ｜ ')}`
}

/** `sdo_requirement action=capture` 的回执。 */
export function describeCapture(result: { requirement: Requirement; flags: string[] }): string {
  const { requirement, flags } = result
  const lines: string[] = [`已捕获需求 ${requirement.id}：${requirement.title}`]
  lines.push(`- 类型：${requirement.kind} ｜ 优先级：${requirement.priority ?? '（未定，DoR 会拦）'} ｜ 状态：${requirement.status}`)
  lines.push(`- 歧义评分：${describeScore(requirement)}`)
  if (flags.length > 0) {
    lines.push(`- 硬信号：${flags.join('、')}（其中 \`banned:*\` 会生成强制量化问题）`)
  }
  lines.push(`- 下一步：\`sdo_requirement action=grill id=${requirement.id}\` 追问最弱维度（每轮 ≤4 问）。`)
  return lines.join('\n')
}

/** 一批问题的渲染（工具与命令共用）。 */
export function describeQuestions(questions: GrillQuestion[], skipped: string[] = []): string {
  if (questions.length === 0) {
    const lines = ['本轮没有问题。']
    if (skipped.length > 0) lines.push(`- 跳过的需求（未找到）：${skipped.join(' ')}`)
    lines.push('- 若需求仍未达 DoR，请用 `sdo_requirement action=update` 补充语义分/验收标准，或直接补全陈述。')
    return lines.join('\n')
  }
  const lines: string[] = [`本轮 ${questions.length} 问（批量上限 4；每题必带选项与代价）：`]
  questions.forEach((question, index) => {
    lines.push('')
    lines.push(`${index + 1}. [${question.severity}／${question.dimension}] ${question.id}　${question.text}`)
    lines.push(`   - 目标：${question.targets.join(' ')}`)
    lines.push(`   - 为什么问：${question.why}`)
    lines.push(`   - 不问的后果：${question.consequenceIfUnasked}`)
    question.options.forEach((option, optionIndex) => {
      lines.push(`   - 选项 ${optionIndex}：${option.label}（代价：${option.cost}）`)
    })
    lines.push(`   - 默认建议（用户答"不知道"时采用并记为假设）：${question.defaultRecommendation}`)
  })
  lines.push('')
  lines.push('回答方式：`sdo_requirement action=answer id=<问题ID> answer="…" pickedOption=<下标>`；若用户说不知道，用 `assume=true`。')
  return lines.join('\n')
}

/** `sdo_requirement action=answer` 的回执。 */
export function describeAnswer(result: { question: GrillQuestion; updated: Requirement[] }): string {
  const { question, updated } = result
  const lines: string[] = [`已记录回答 ${question.id}（状态：${question.status}）`]
  lines.push(`- 答案：${question.answer ?? '（空）'}`)
  lines.push(`- 回答者：${question.answeredBy ?? 'human'}`)
  for (const requirement of updated) {
    lines.push(`- 目标 ${requirement.id} 更新后评分：${describeScore(requirement)}`)
  }
  if (question.status === 'assumed') {
    lines.push('- ⚠️ 记为**假设**（用户答"不知道"）：请把该假设登记为风险，并在交付文档中披露。')
  }
  return lines.join('\n')
}

/** `sdo_requirement action=list` 的回执。 */
export function describeRequirementList(requirements: Requirement[]): string {
  if (requirements.length === 0) return '还没有需求。用 `sdo_requirement action=capture` 开始收集。'
  const lines: string[] = [`需求共 ${requirements.length} 条：`]
  for (const requirement of requirements) {
    lines.push(
      `- ${requirement.id}　[${requirement.priority ?? '未定'}/${requirement.kind}]　${requirement.status}`
      + `　${requirement.ambiguity.score}/16　未决 ${requirement.ambiguity.open.length}　${requirement.title}`,
    )
  }
  const below = requirements.filter((requirement) => requirement.ambiguity.score < 14)
  if (below.length > 0) {
    lines.push(`- 未达阈值（<14）：${below.map((requirement) => requirement.id).join(' ')}`)
  }
  return lines.join('\n')
}

/** `sdo_requirement action=baseline` 的回执（含门禁负例的 remedy）。 */
export function describeBaseline(outcome: BaselineOutcome): string {
  if (outcome.ok) {
    const lines = [`G2 通过：${outcome.baselined.length} 条需求已基线冻结。`]
    for (const requirement of outcome.baselined) {
      lines.push(`- ${requirement.id}　v${requirement.version}　签字：${requirement.baseline?.by ?? 'human'}`)
    }
    lines.push('- 已写 `gates/G2.json`，并据 `phase/entered` 事件进入 `architecture` 阶段。')
    lines.push('- 下一步：`sdo_design action=create` 开始架构设计（M2 实现）。')
    return lines.join('\n')
  }
  return `G2 未通过（需求基线被拒）：\n${describeDor(outcome.dor)}`
}

/** DoR 判定文本（失败时逐条给 remedy）。 */
export function describeDor(dor: DorResult): string {
  const lines: string[] = []
  for (const criterion of dor.criteria) {
    lines.push(`- ${criterion.ok ? '✅' : '❌'} ${criterion.id}　${criterion.label}`)
    lines.push(`    现状：${criterion.detail}`)
    if (criterion.remedy !== undefined) lines.push(`    补救：${criterion.remedy}`)
  }
  if (!dor.ok) lines.push(`未满足：${dor.failed.join(', ')}（未通过前不得进入架构设计）`)
  return lines.join('\n')
}

/** 红队动作的回执。 */
export function describeRedTeam(action: string, payload: { questions?: GrillQuestion[]; skipped?: string[]; enabled?: boolean; executed?: boolean; reason?: string | undefined }): string {
  const lines: string[] = []
  if (action === 'attack') {
    lines.push(`红队质询已执行：生成 ${payload.questions?.length ?? 0} 个 P0 问题（攻击角度见设计 §5.4）。`)
    lines.push('')
    lines.push(describeQuestions(payload.questions ?? [], payload.skipped ?? []))
    return lines.join('\n')
  }
  if (action === 'off' || action === 'on') {
    lines.push(`红队已在**本会话**${action === 'off' ? '停用' : '启用'}（已写 \`redteam/mode\` 留痕${payload.reason === undefined ? '' : `，理由：${payload.reason}`}）。`)
    lines.push('- 这是会话级开关：换会话需重新表达（Q-15）。')
    return lines.join('\n')
  }
  lines.push(`红队状态：本会话${payload.enabled === false ? '已停用' : '启用（默认）'}；本轮流程${payload.executed === true ? '已执行过攻击' : '尚未执行攻击'}。`)
  lines.push('- `sdo_redteam action=attack` 跑一轮；`action=off` 停用本会话（写留痕）。')
  return lines.join('\n')
}

/** `sdo_render` 的回执。 */
export function describeRender(target: string, path: string, seq: number): string {
  return [
    `已渲染 ${target} → \`${path}\``,
    `- 渲染头包含真源位置与 journal seq ${seq}；同一状态重渲染逐字节相同（幂等）。`,
    '- 该文件是**生成物**：请改 `.sdo/` 真源后重新渲染，不要手改产物。',
  ].join('\n')
}

/** `sdo_design` 的门禁回执。 */
export function describeDesignGate(check: { allowed: boolean; reason: string; remedy?: string | undefined; dor: DorResult }, action: string): string {
  if (!check.allowed) {
    return [
      `${action === 'view' ? '查看' : '进入'}设计被拒：${check.reason}`,
      check.remedy === undefined ? '' : `- 补救：${check.remedy}`,
      '',
      '当前 DoR 判定：',
      describeDor(check.dor),
    ].join('\n')
  }
  return [
    `门禁通过（${check.reason}）。`,
    '- 架构设计引擎在 M2 实现（`sdo_design` 目前只负责把 G2 门禁守住）。',
  ].join('\n')
}
