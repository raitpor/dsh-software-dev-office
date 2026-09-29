/**
 * 面向模型/人的文本输出（工具与命令共用一套口径）。
 *
 * 设计对应：§9.1（`sdo_status` 要给阶段、门禁缺口、开环问题、追溯覆盖率、产物清单）、
 * NFR-009（只出现相对路径）、NFR-012（成本类数字必须标注"估算"——M5 起）。
 */
import { DIMENSIONS } from '../types.js'
import type { ChangeRequest, FeasibilityAssessment, GateEvaluation, GrillQuestion, Requirement, RiskItem, SdoProject } from '../types.js'
import type { BaselineOutcome, InitResult, StatusSnapshot } from '../office.js'
import { processOfProject } from '../office.js'
import type { DorResult } from '../domain/dor.js'
import { TELOS_DIMENSIONS, TELOS_LABEL } from '../domain/feasibility.js'
import { riskStats } from '../domain/risks.js'

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
    lines.push('- 下一步：`sdo_project action=update` 补齐非目标/干系人/术语表/成功度量，再 `sdo_requirement action=capture` 收集需求。')
  } else {
    lines.push(`项目已存在，未做改动：${result.project.id} ${result.project.name}`)
    const process = processOfProject(result.project)
    lines.push(`- 当前阶段：${result.project.phase}（${process.phases.find((item) => item.id === result.project.phase)?.name ?? result.project.phase}）`)
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

  const pending = status.pendingGate ?? '（无）'
  lines.push(`- 项目：${project.id} ${project.name}`)
  lines.push(
    `- 流程：${project.process} ｜ 规模：${project.tailoring?.scale ?? status.config.scale} ｜ 阶段：${project.phase}`,
  )
  lines.push(`- 门禁缺口：待判定 ${pending} ｜ 最近判定：${status.lastGate === undefined ? '（无记录）' : `${status.lastGate.gate} ${status.lastGate.status} @ ${status.lastGate.at}`}`)
  lines.push(
    `- 需求：${status.counts.requirements} 条 ｜ 开环问题：${status.counts.openQuestions}（账本共 ${status.counts.questions} 条）`
    + ` ｜ 追溯覆盖率：—（M2 起提供）`,
  )
  lines.push(
    `- 可行性：${status.feasibilityVerdict ?? '（未评估）'} ｜ 风险：${status.risks.total} 条（未关闭 ${status.risks.open}，高 ${status.risks.high}，阻塞 ${status.risks.blockers}）`,
  )
  lines.push(`- 红队未闭环议题：${status.openIssues} ｜ 变更请求：${status.changes} 条`)
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

/** `sdo_project action=update` 的回执。 */
export function describeProjectUpdate(result: { project: SdoProject; changed: string[] }): string {
  if (result.changed.length === 0) {
    return [
      '本次没有写入任何字段（本工具只写显式给出的字段）。',
      '- 可用字段：name / process / scale / scopeIn / scopeOut / stakeholders / metricsSuccess / glossary',
    ].join('\n')
  }
  const lines: string[] = [`已更新项目台账：${result.project.id} ${result.project.name}`]
  lines.push(`- 本次写入字段：${result.changed.join('、')}`)
  lines.push(`- 范围（in）：${result.project.scope.in.length === 0 ? '（空）' : result.project.scope.in.join('；')}`)
  lines.push(`- 非目标（out）：${result.project.scope.out.length === 0 ? '（空 —— G2 会拦）' : result.project.scope.out.join('；')}`)
  lines.push(`- 术语表：${Object.keys(result.project.glossary).length} 个术语`)
  lines.push(`- 成功度量：${result.project.metrics.success.length === 0 ? '（空）' : result.project.metrics.success.join('；')}`)
  return lines.join('\n')
}

/** `sdo_project action=show` 的回执。 */
export function describeProject(status: StatusSnapshot, dataDirName: string): string {
  const project = status.project
  if (project === undefined) return `尚未初始化（没有 \`${dataDirName}/\`）：先调用 \`sdo_init\`。`
  const lines: string[] = [`项目台账：${project.id} ${project.name}`]
  lines.push(`- 流程：${project.process} ｜ 规模：${project.tailoring?.scale ?? status.config.scale} ｜ 阶段：${project.phase}`)
  lines.push(`- 范围（in）：${project.scope.in.length === 0 ? '（空）' : project.scope.in.join('；')}`)
  lines.push(`- 非目标（out）：${project.scope.out.length === 0 ? '（空 —— 门禁 G0/G2 会拦）' : project.scope.out.join('；')}`)
  lines.push(`- 干系人：${project.stakeholders.length === 0 ? '（空）' : project.stakeholders.map((item) => `${item.id} ${item.role}`).join('；')}`)
  lines.push(`- 术语表：${Object.keys(project.glossary).length === 0 ? '（空 —— 门禁 G2 会拦）' : Object.entries(project.glossary).map(([term, definition]) => `${term}：${definition}`).join('；')}`)
  lines.push(`- 成功度量：${project.metrics.success.length === 0 ? '（空）' : project.metrics.success.join('；')}`)
  lines.push(`- 裁剪：${project.tailoring === undefined ? '（未设置）' : `${project.tailoring.scale}（豁免 ${project.tailoring.waivedGates.join(' ') || '无'}）`}`)
  return lines.join('\n')
}

/** `sdo_gate action=check` 的回执。 */
export function describeGate(evaluation: GateEvaluation): string {
  const head = `门禁 ${evaluation.gate}（阶段 ${evaluation.phase}）：${evaluation.status === 'passed' ? '✅ 通过' : evaluation.status === 'waived' ? '⚠️ 已豁免' : '❌ 未通过'}`
  const lines: string[] = [head]
  for (const criterion of evaluation.criteria) {
    lines.push(`- ${criterion.ok ? '✅' : '❌'} ${criterion.id}　${criterion.detail}`)
    if (criterion.remedy !== undefined) lines.push(`    补救：${criterion.remedy}`)
  }
  if (evaluation.status === 'failed') {
    lines.push(`未满足：${evaluation.criteria.filter((criterion) => !criterion.ok).map((criterion) => criterion.id).join(', ')}（未通过前不得进入下一阶段）`)
  }
  lines.push('- 记录已写入 `.sdo/gates/' + evaluation.gate + '.json`。')
  return lines.join('\n')
}

/** `sdo_gate action=advance` 的回执。 */
export function describeAdvance(result: { advanced: boolean; from: string; to?: string | undefined; blockedBy?: string | undefined; remedy?: string[] | undefined }): string {
  if (result.advanced) return `已从阶段 ${result.from} 推进到 ${result.to ?? '（流程末尾）'}。`
  if (result.blockedBy === undefined) return `阶段 ${result.from} 已是流程末尾，无可推进。`
  const lines = [`无法推进：阶段 ${result.from} 的出口门禁 ${result.blockedBy} 尚未通过。`]
  for (const remedy of result.remedy ?? []) lines.push(`- 补救：${remedy}`)
  lines.push(`- 先运行 \`sdo_gate action=check gate=${result.blockedBy}\` 看逐条准则；确有正当理由时用 \`sdo_gate action=waive\`（会留痕）。`)
  return lines.join('\n')
}

/** `sdo_feasibility action=assess` 的回执。 */
export function describeFeasibility(assessment: FeasibilityAssessment): string {
  const lines: string[] = [`可行性评估已记录（${assessment.id}，结论：${assessment.verdict}）`]
  for (const dimension of TELOS_DIMENSIONS) {
    const item = assessment.telos[dimension]
    lines.push(`- ${TELOS_LABEL[dimension]}：${item.verdict}${item.rationale === '' ? '' : `　${item.rationale}`}`)
  }
  lines.push(`- 理由：${assessment.rationale}`)
  if (assessment.poc.length > 0) {
    lines.push(`- PoC / 验证建议：${assessment.poc.join('；')}`)
  } else {
    lines.push('- ⚠️ 未给出 PoC / 验证建议：G1 会因此拒绝（高风险项必须先验证）')
  }
  lines.push('- 下一步：`sdo_risk action=log …` 登记风险，然后 `sdo_gate action=check gate=G1`。')
  return lines.join('\n')
}

/** 风险登记表。 */
export function describeRisks(risks: RiskItem[]): string {
  if (risks.length === 0) return '风险登记为空。用 `sdo_risk action=log title=… level=… mitigation=… owner=…` 登记。'
  const stats = riskStats(risks)
  const lines: string[] = [`风险共 ${stats.total} 条（未关闭 ${stats.open}｜高 ${stats.high}｜阻塞 ${stats.blockers}）：`]
  for (const risk of risks) {
    lines.push(`- ${risk.id}　[${risk.level}/${risk.probability}]　${risk.status}　${risk.title}${risk.origin === undefined ? '' : `　（来源 ${risk.origin}）`}`)
    if (risk.mitigation.trim() === '' || risk.owner.trim() === '') {
      lines.push('    ⚠️ 缺应对或责任人：G1/GR 会因此拒绝')
    }
  }
  return lines.join('\n')
}

/** `sdo_requirement action=change` 的回执。 */
export function describeChange(result: { change: ChangeRequest; applied: boolean; reason?: string | undefined }): string {
  const { change } = result
  const lines: string[] = [`变更请求 ${change.id}（需求 ${change.requirement}，决策 ${change.decision}）`]
  lines.push(`- 理由：${change.reason}`)
  for (const item of change.changes) lines.push(`- 变更：${item}`)
  lines.push(`- 影响分析：设计 ${change.impact.design.length} 项 ｜ 任务 ${change.impact.tasks.length} 项 ｜ 测试 ${change.impact.tests.length} 项`)
  lines.push(`  （${change.impact.note}）`)
  lines.push(`- 决策人：${change.decidedBy}`)
  lines.push(result.applied ? '- ✅ 变更已应用（需求状态 changed，版本 +0.1）' : `- ⚠️ 未应用：${result.reason ?? change.decision}`)
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
