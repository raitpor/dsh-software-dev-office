/**
 * 面向模型/人的文本输出（工具与命令共用一套口径）。
 *
 * 设计对应：§9.1（`sdo_status` 要给阶段、门禁缺口、开环问题、追溯覆盖率、产物清单）、
 * NFR-009（只出现相对路径）、NFR-012（成本类数字必须标注"估算"——M5 起）。
 */
import { DIMENSIONS } from '../types.js'
import type { DeliveryManifest } from '../domain/records.js'
import type { Adr, ChangeRequest, Contract, DesignElement, DesignView, FeasibilityAssessment, GateEvaluation, GrillQuestion, QualityAssessment, QualityScenario, Requirement, RiskItem, SdoProject, TaskCard, TraceReport } from '../types.js'
import type { BaselineOutcome, InitResult, StatusSnapshot } from '../office.js'
import { processOfProject } from '../office.js'
import type { DorResult } from '../domain/dor.js'
import { TELOS_DIMENSIONS, TELOS_LABEL } from '../domain/feasibility.js'
import { riskStats } from '../domain/risks.js'
import { VIEW_KINDS } from '../types.js'
import { VIEW_LABEL } from '../domain/architecture.js'
import { fmt, gateLabel, gateWithId, label, phaseText, t, textOrProcess } from '../domain/i18n.js'
import { planStats } from '../domain/plan.js'
import type { PlanIssue } from '../domain/plan.js'
import type { DispatchRequest } from '../integration/orchestrator.js'

/** `sdo_init` 的回执。 */
/**
 * 语言状态回执（用户可见）：当前语言、可选语言包、覆盖率与**如何永久设置**。
 * 覆盖率是判别性的：它来自"目标语言包实际有多少键"，而不是"能取到多少文案"（后者永远 100%，因为会回退）。
 */
export function describeLang(state: {
  locale: string
  base: string
  languages: readonly string[]
  covered: number
  total: number
  extra: number
}): string {
  const lines = [
    fmt('uiLang.current', { p1: state.locale, p2: state.base }),
    fmt('uiLang.available', { p1: state.languages.join(' / ') }),
  ]
  if (state.locale !== state.base) {
    lines.push(fmt('uiLang.coverage', { p1: state.covered, p2: state.total }))
    if (state.extra > 0) lines.push(fmt('uiLang.extraKeys', { p1: state.extra }))
  }
  lines.push(t('uiLang.usage'))
  return lines.join('\n')
}

export function describeInit(result: InitResult, dataDirName: string): string {
  const lines: string[] = []
  if (result.created) {
    lines.push(fmt('uiDescribe.m1', { p1: result.project.id, p2: result.project.name }))
    lines.push(fmt('uiDescribe.m2', { p1: result.project.process, p2: result.project.tailoring?.scale ?? 'normal', p3: result.project.phase }))
    lines.push(fmt('uiDescribe.m3', { p1: dataDirName }))
    if (result.project.scope.out.length === 0) {
      lines.push(t('uiDescribe.m4'))
    }
    lines.push(t('uiDescribe.m5'))
  } else {
    lines.push(fmt('uiDescribe.m6', { p1: result.project.id, p2: result.project.name }))
    const process = processOfProject(result.project)
    lines.push(fmt('uiDescribe.m7', { p1: result.project.phase, p2: process.phases.find((item) => item.id === result.project.phase)?.name ?? result.project.phase }))
    lines.push(fmt('uiDescribe.k8', { p1: dataDirName }))
  }
  return lines.join('\n')
}

/** 看板写盘等附加说明（单独成段，避免污染看板正文的确定性）。 */
export function describeBoardNote(note: string): string {
  return `> ${note}`
}

/** `sdo_status` / `/sdo-status` 的文本。 */
export function describeStatus(status: StatusSnapshot, dataDirName: string): string {
  const lines: string[] = [t('uiDescribe.k177')]
  const { project } = status

  if (project === undefined) {
    lines.push(fmt('uiDescribe.k9', { p1: dataDirName }))
    lines.push(t('uiDescribe.k10'))
    return lines.join('\n')
  }

  const pending = status.pendingGate ?? t('uiDescribe.k11')
  lines.push(fmt('uiDescribe.k12', { p1: project.id, p2: project.name }))
  lines.push(
    fmt('uiDescribe.k13', { p1: project.process, p2: project.tailoring?.scale ?? status.config.scale, p3: project.phase }),
  )
  lines.push(fmt('uiDescribe.k14', { p1: pending, p2: status.lastGate === undefined ? t('uiDescribe.k207') : `${status.lastGate.gate} ${status.lastGate.status} @ ${status.lastGate.at}` }))
  lines.push(
    fmt('uiDescribe.k15', { p1: status.counts.requirements, p2: status.counts.openQuestions, p3: status.counts.questions })
    + t('uiDescribe.k16'),
  )
  lines.push(
    fmt('uiDescribe.k17', { p1: status.feasibilityVerdict ?? t('uiDescribe.k152'), p2: status.risks.total, p3: status.risks.open, p4: status.risks.high, p5: status.risks.blockers }),
  )
  lines.push(fmt('uiDescribe.k18', { p1: status.openIssues, p2: status.changes }))
  lines.push(fmt('uiDescribe.k19', { p1: status.counts.evidence }))
  lines.push(
    fmt('uiDescribe.k20', { p1: status.rebuilt ? t('uiDescribe.k208') : t('uiDescribe.k153') })
    + fmt('uiDescribe.k237', { p1: status.truncated ? fmt('uiDescribe.k235', { p1: status.badLine ?? '?' }) : t('uiDescribe.k236') }),
  )
  if (status.configSource === 'default') {
    lines.push(fmt('uiDescribe.k21', { p1: dataDirName, p2: status.config.process, p3: status.config.scale }))
  }

  lines.push(t('uiDescribe.k22'))
  lines.push(fmt('uiDescribe.k23', { p1: dataDirName }))
  lines.push(fmt('uiDescribe.k24', { p1: dataDirName }))
  lines.push(fmt('uiDescribe.k25', { p1: dataDirName, p2: dataDirName }))
  lines.push(fmt('uiDescribe.k154', { p1: dataDirName }))

  return lines.join('\n')
}

/** `sdo_project action=update` 的回执。 */
export function describeProjectUpdate(result: { project: SdoProject; changed: string[] }): string {
  if (result.changed.length === 0) {
    return [
      t('uiDescribe.m1'),
      t('uiDescribe.k26'),
    ].join('\n')
  }
  const lines: string[] = [fmt('uiDescribe.k178', { p1: result.project.id, p2: result.project.name })]
  lines.push(fmt('uiDescribe.k27', { p1: result.changed.join('、') }))
  lines.push(fmt('uiDescribe.k28', { p1: result.project.scope.in.length === 0 ? t('uiDescribe.k209') : result.project.scope.in.join('；') }))
  lines.push(fmt('uiDescribe.k29', { p1: result.project.scope.out.length === 0 ? t('uiDescribe.k210') : result.project.scope.out.join('；') }))
  lines.push(fmt('uiDescribe.k30', { p1: Object.keys(result.project.glossary).length }))
  lines.push(fmt('uiDescribe.k31', { p1: result.project.metrics.success.length === 0 ? t('uiDescribe.k211') : result.project.metrics.success.join('；') }))
  return lines.join('\n')
}

/** `sdo_project action=show` 的回执。 */
export function describeProject(status: StatusSnapshot, dataDirName: string): string {
  const project = status.project
  if (project === undefined) return fmt('uiDescribe.k32', { p1: dataDirName })
  const lines: string[] = [fmt('uiDescribe.k179', { p1: project.id, p2: project.name })]
  lines.push(fmt('uiDescribe.k33', { p1: project.process, p2: project.tailoring?.scale ?? status.config.scale, p3: project.phase }))
  lines.push(fmt('uiDescribe.k34', { p1: project.scope.in.length === 0 ? t('uiDescribe.k212') : project.scope.in.join('；') }))
  lines.push(fmt('uiDescribe.k35', { p1: project.scope.out.length === 0 ? t('uiDescribe.k213') : project.scope.out.join('；') }))
  lines.push(fmt('uiDescribe.k36', { p1: project.stakeholders.length === 0 ? t('uiDescribe.k214') : project.stakeholders.map((item) => `${item.id} ${item.role}`).join('；') }))
  lines.push(fmt('uiDescribe.k37', { p1: Object.keys(project.glossary).length === 0 ? t('uiDescribe.k215') : Object.entries(project.glossary).map(([term, definition]) => `${term}：${definition}`).join('；') }))
  lines.push(fmt('uiDescribe.k38', { p1: project.metrics.success.length === 0 ? t('uiDescribe.k216') : project.metrics.success.join('；') }))
  lines.push(fmt('uiDescribe.k39', { p1: project.tailoring === undefined ? t('uiDescribe.k217') : fmt('uiDescribe.k156', { p1: project.tailoring.scale, p2: project.tailoring.waivedGates.join(' ') || t('uiDescribe.k155') }) }))
  return lines.join('\n')
}

/** `sdo_gate action=check` 的回执。 */
export function describeGate(evaluation: GateEvaluation): string {
  const head = fmt('uiDescribe.k40', { p1: gateWithId(evaluation.gate), p2: phaseText(evaluation.phase), p3: evaluation.status === 'passed' ? t('uiDescribe.k218') : evaluation.status === 'waived' ? t('uiDescribe.k219') : t('uiDescribe.k157') })
  const lines: string[] = [head]
  for (const criterion of evaluation.criteria) {
    lines.push(
      `- ${criterion.ok ? '✅' : '❌'} ${textOrProcess(`criterion.${criterion.id}`, criterion.desc)}`
      + `（${criterion.id}）　${criterion.detail}`,
    )
    if (criterion.remedy !== undefined) lines.push(fmt('uiDescribe.k41', { p1: criterion.remedy }))
  }
  if (evaluation.status === 'failed') {
    lines.push(fmt('uiDescribe.k42', { p1: evaluation.criteria.filter((criterion) => !criterion.ok).map((criterion) => criterion.id).join(', ') }))
  }
  lines.push(fmt('uiDescribe.k43', { p1: evaluation.gate }))
  return lines.join('\n')
}

/** `sdo_gate action=advance` 的回执。 */
export function describeAdvance(result: { advanced: boolean; from: string; to?: string | undefined; blockedBy?: string | undefined; remedy?: string[] | undefined }): string {
  if (result.advanced) return fmt('uiDescribe.k44', { p1: phaseText(result.from), p2: phaseText(result.to ?? ''), p3: result.to === undefined ? t('uiDescribe.k220') : '' })
  if (result.blockedBy === undefined) return fmt('uiDescribe.k45', { p1: phaseText(result.from) })
  const lines = [fmt('uiDescribe.k180', { p1: phaseText(result.from), p2: gateWithId(result.blockedBy) })]
  for (const remedy of result.remedy ?? []) lines.push(fmt('uiDescribe.k46', { p1: remedy }))
  lines.push(fmt('uiDescribe.k47', { p1: gateLabel(result.blockedBy) }))
  return lines.join('\n')
}

/** `sdo_feasibility action=assess` 的回执。 */
export function describeFeasibility(assessment: FeasibilityAssessment): string {
  const lines: string[] = [fmt('uiDescribe.k181', { p1: assessment.id, p2: assessment.verdict })]
  for (const dimension of TELOS_DIMENSIONS) {
    const item = assessment.telos[dimension]
    lines.push(`- ${TELOS_LABEL[dimension]}：${item.verdict}${item.rationale === '' ? '' : `　${item.rationale}`}`)
  }
  lines.push(fmt('uiDescribe.k48', { p1: assessment.rationale }))
  if (assessment.poc.length > 0) {
    lines.push(fmt('uiDescribe.k49', { p1: assessment.poc.join('；') }))
  } else {
    lines.push(t('uiDescribe.k50'))
  }
  lines.push(t('uiDescribe.k51'))
  return lines.join('\n')
}

/** 风险登记表。 */
export function describeRisks(risks: RiskItem[]): string {
  if (risks.length === 0) return t('uiDescribe.k52')
  const stats = riskStats(risks)
  const lines: string[] = [fmt('uiDescribe.k182', { p1: stats.total, p2: stats.open, p3: stats.high, p4: stats.blockers })]
  for (const risk of risks) {
    lines.push(fmt('uiDescribe.k239', { p1: risk.id, p2: risk.level, p3: risk.probability, p4: risk.status, p5: risk.title, p6: risk.origin === undefined ? '' : fmt('uiDescribe.k238', { p1: risk.origin }) }))
    if (risk.mitigation.trim() === '' || risk.owner.trim() === '') {
      lines.push(t('uiDescribe.k53'))
    }
  }
  return lines.join('\n')
}

/** `sdo_requirement action=change` 的回执。 */
export function describeChange(result: { change: ChangeRequest; applied: boolean; reason?: string | undefined }): string {
  const { change } = result
  const lines: string[] = [fmt('uiDescribe.k183', { p1: change.id, p2: change.requirement, p3: change.decision })]
  lines.push(fmt('uiDescribe.k54', { p1: change.reason }))
  for (const item of change.changes) lines.push(fmt('uiDescribe.k55', { p1: item }))
  lines.push(fmt('uiDescribe.k56', { p1: change.impact.design.length, p2: change.impact.tasks.length, p3: change.impact.tests.length }))
  lines.push(`  （${change.impact.note}）`)
  lines.push(fmt('uiDescribe.k57', { p1: change.decidedBy }))
  lines.push(result.applied ? t('uiDescribe.k221') : fmt('uiDescribe.k58', { p1: result.reason ?? change.decision }))
  return lines.join('\n')
}

/** `sdo_design action=view` 的回执：五视图 + 契约覆盖。 */
export function describeDesign(views: DesignView[], contracts: Contract[]): string {
  if (views.length === 0) return t('uiDescribe.k59')
  const lines: string[] = [fmt('uiDescribe.k184', { p1: views.length })]
  for (const view of views) {
    lines.push(fmt('uiDescribe.k60', { p1: VIEW_LABEL[view.kind], p2: view.kind, p3: view.elements.length, p4: view.summary === '' ? '' : `　${view.summary}` }))
    for (const element of view.elements) {
      lines.push(fmt('uiDescribe.k241', { p1: element.id, p2: element.name, p3: element.kind, p4: element.dependsOn.length === 0 ? '' : fmt('uiDescribe.k240', { p1: element.dependsOn.join('、') }) }))
    }
  }
  const missing = VIEW_KINDS.filter((kind) => !views.some((view) => view.kind === kind))
  if (missing.length > 0) lines.push(fmt('uiDescribe.k61', { p1: missing.join(' ') }))
  lines.push(fmt('uiDescribe.k62', { p1: contracts.length }))
  return lines.join('\n')
}

/** 写入设计元素的回执。 */
export function describeDesignElement(result: { element: DesignElement; view: DesignView; created: boolean }): string {
  const { element, view, created } = result
  const lines: string[] = [fmt('uiDescribe.k186', { p1: created ? t('uiDescribe.k222') : t('uiDescribe.k185'), p2: element.id, p3: element.name, p4: VIEW_LABEL[view.kind] })]
  lines.push(fmt('uiDescribe.k63', { p1: element.kind, p2: element.responsibility === '' ? t('uiDescribe.k223') : element.responsibility }))
  if (element.dependsOn.length > 0) {
    lines.push(fmt('uiDescribe.k64', { p1: element.dependsOn.join('、') }))
  }
  lines.push(fmt('uiDescribe.k65', { p1: element.id }))
  return lines.join('\n')
}

/** 契约记录的回执。 */
export function describeContract(contract: Contract, coverage: { totalEdges: number; covered: number; missing: { consumer: string; producer: string }[]; incompleteSemantics: string[] }): string {
  const lines = [fmt('uiDescribe.k187', { p1: contract.id, p2: contract.name, p3: contract.kind })]
  lines.push(fmt('uiDescribe.k66', { p1: contract.failureSemantics.timeout || t('uiDescribe.k158'), p2: contract.failureSemantics.retry || t('uiDescribe.k159'), p3: contract.failureSemantics.idempotency || t('uiDescribe.k160') }))
  lines.push(fmt('uiDescribe.k67', { p1: coverage.covered, p2: coverage.totalEdges }))
  if (coverage.missing.length > 0) {
    lines.push(fmt('uiDescribe.k68', { p1: coverage.missing.map((edge) => `${edge.consumer}→${edge.producer}`).join(' ') }))
    // D4-1：口径写死并**逐条给出该填的值**（consumer = 依赖方元素 name；producer = 被依赖方的 dependsOn 原串）
    lines.push(
      coverage.missing
        .slice(0, 6)
        .map((edge) => fmt('uiDescribe.contractMissingExact', { p1: edge.consumer, p2: edge.producer }))
        .join('\n'),
    )
  }
  if (coverage.incompleteSemantics.length > 0) {
    lines.push(fmt('uiDescribe.k69', { p1: coverage.incompleteSemantics.join(' ') }))
  }
  return lines.join('\n')
}

/** ADR 的回执。 */
export function describeAdr(adr: Adr, supersedes?: string | undefined): string {
  const lines = [fmt('uiDescribe.k188', { p1: adr.id, p2: adr.title, p3: adr.status })]
  if (supersedes !== undefined) lines.push(fmt('uiDescribe.k70', { p1: supersedes }))
  lines.push(fmt('uiDescribe.k71', { p1: adr.alternatives.length, p2: adr.consequences.length }))
  lines.push(fmt('uiDescribe.k72', { p1: adr.decision }))
  return lines.join('\n')
}

/** ADR 列表。 */
export function describeAdrList(adrs: Adr[]): string {
  if (adrs.length === 0) return t('uiDescribe.k73')
  const lines = [fmt('uiDescribe.k189', { p1: adrs.length })]
  for (const adr of adrs) {
    lines.push(fmt('uiDescribe.k74', { p1: adr.id, p2: adr.status, p3: adr.title, p4: adr.alternatives.length, p5: adr.consequences.length }))
  }
  return lines.join('\n')
}

/** 质量场景的回执。 */
export function describeScenario(scenario: QualityScenario): string {
  return [
    fmt('uiDescribe.m2', { p1: scenario.id, p2: scenario.attribute, p3: scenario.priority }),
    fmt('uiDescribe.k75', { p1: scenario.stimulus, p2: scenario.response }),
    fmt('uiDescribe.k76', { p1: scenario.measure }),
    scenario.targets.length === 0 ? t('uiDescribe.k224') : fmt('uiDescribe.k77', { p1: scenario.targets.join(' ') }),
  ].join('\n')
}

/** 质量场景列表。 */
export function describeScenarioList(scenarios: QualityScenario[]): string {
  if (scenarios.length === 0) return t('uiDescribe.k78')
  const lines = [fmt('uiDescribe.k190', { p1: scenarios.length })]
  for (const scenario of scenarios) {
    const measurable = /\d/u.test(scenario.measure) || /[≥≤<>]=?/u.test(scenario.measure)
    lines.push(fmt('uiDescribe.k243', { p1: scenario.id, p2: scenario.attribute, p3: scenario.priority, p4: scenario.measure, p5: measurable ? '' : t('uiDescribe.k242') }))
  }
  return lines.join('\n')
}

/** ATAM-lite 回执。 */
export function describeAssessment(assessment: QualityAssessment): string {
  const lines = [t('uiDescribe.k191')]
  lines.push(fmt('uiDescribe.k79', { p1: assessment.risks.length, p2: assessment.risks.length === 0 ? t('uiDescribe.k225') : '' }))
  for (const risk of assessment.risks) lines.push(`    · ${risk}`)
  lines.push(fmt('uiDescribe.k80', { p1: assessment.sensitivities.length }))
  for (const item of assessment.sensitivities) lines.push(`    · ${item}`)
  lines.push(fmt('uiDescribe.k81', { p1: assessment.tradeoffs.length }))
  for (const item of assessment.tradeoffs) lines.push(`    · ${item}`)
  lines.push(fmt('uiDescribe.k82', { p1: assessment.by }))
  return lines.join('\n')
}

/** 追溯查询回执。 */
export function describeTrace(data: TraceReport): string {
  const lines = [t('uiDescribe.k192')]
  lines.push(fmt('uiDescribe.k83', { p1: data.total, p2: Math.round(data.coverage * 100) }))
  lines.push(fmt('uiDescribe.k84', { p1: data.orphans.design.length === 0 ? t('uiDescribe.k226') : data.orphans.design.join(' ') }))
  lines.push(fmt('uiDescribe.k85', { p1: data.orphans.tasks.length === 0 ? t('uiDescribe.k227') : data.orphans.tasks.join(' ') }))
  lines.push(fmt('uiDescribe.k86', { p1: data.orphans.tests.length === 0 ? t('uiDescribe.k228') : data.orphans.tests.join(' ') }))
  lines.push(fmt('uiDescribe.k87', { p1: data.uncoveredMust.length === 0 ? t('uiDescribe.k229') : data.uncoveredMust.join(' ') }))
  for (const item of data.perRequirement) {
    lines.push(fmt('uiDescribe.k88', { p1: item.id, p2: item.design.join(' ') || t('uiDescribe.k161'), p3: item.tasks.join(' ') || t('uiDescribe.k162'), p4: item.tests.join(' ') || t('uiDescribe.k163') }))
  }
  return lines.join('\n')
}

/** 拆分结果：卡片 + 六条机械校验结果。 */
export function describePlan(tasks: TaskCard[], issues: PlanIssue[]): string {
  const stats = planStats(tasks)
  const lines: string[] = [fmt('uiDescribe.k194', { p1: stats.total, p2: Object.entries(stats.byStatus).map(([status, count]) => `${status} ${count}`).join('，') || t('uiDescribe.k193') })]
  for (const task of tasks) {
    lines.push(`- ${task.id}　[${task.role}/${task.size}]　${task.status}${task.owner === undefined ? '' : `（${task.owner}）`}　${task.title}`)
    lines.push(fmt('uiDescribe.k245', { p1: task.dod.join('；') || t('uiDescribe.k244') }))
    lines.push(fmt('uiDescribe.k89', { p1: task.writeScopes.join('、') || t('uiDescribe.k164'), p2: task.blockedBy.length === 0 ? '' : fmt('uiDescribe.k165', { p1: task.blockedBy.join(' ') }) }))
    lines.push(fmt('uiDescribe.k90', { p1: task.evidenceRequired.join('/'), p2: task.requirements.join(' ') || t('uiDescribe.k166') }))
  }
  if (issues.length === 0) {
    lines.push(t('uiDescribe.k91'))
  } else {
    lines.push(fmt('uiDescribe.k92', { p1: issues.length }))
    for (const issue of issues) lines.push(`    · [${issue.code}] ${issue.taskId}：${issue.detail}　→ ${issue.remedy}`)
  }
  return lines.join('\n')
}

/** 单张任务卡。 */
export function describeTask(task: TaskCard): string {
  const lines = [`${task.id}　[${task.role}/${task.size}]　${task.status}${task.owner === undefined ? '' : `（owner=${task.owner}）`}　r${task.revision}`]
  lines.push(fmt('uiDescribe.k93', { p1: task.goal }))
  lines.push(fmt('uiDescribe.k247', { p1: task.dod.join('；') || t('uiDescribe.k246') }))
  lines.push(fmt('uiDescribe.k94', { p1: task.writeScopes.join('、') || t('uiDescribe.k167') }))
  if (task.evidence.length > 0) {
    lines.push(fmt('uiDescribe.k95', { p1: task.evidence.length, p2: task.evidence.map((item) => `${item.kind}:${item.detail}`).join('；') }))
  }
  if (task.blockedReason !== undefined) lines.push(fmt('uiDescribe.k96', { p1: task.blockedReason }))
  return lines.join('\n')
}

/** 认领冲突（CAS 失败等）。 */
export function describeTaskConflict(detail: string, current: TaskCard | undefined, code: string): string {
  const lines = [fmt('uiDescribe.k195', { p1: code, p2: detail })]
  if (current !== undefined) {
    lines.push(fmt('uiDescribe.k97', { p1: current.status, p2: current.revision, p3: current.owner === undefined ? '' : `　owner=${current.owner}` }))
    lines.push(fmt('uiDescribe.k98', { p1: current.revision }))
  }
  return lines.join('\n')
}

/** 任务看板（文本）。 */
export function describeTaskBoard(input: {
  tasks: TaskCard[]
  ready: TaskCard[]
  stale: TaskCard[]
  issues: PlanIssue[]
  iteration?: { number: number; goal: string; status: string } | undefined
}): string {
  const { tasks, ready, stale, issues, iteration } = input
  if (tasks.length === 0) return t('uiDescribe.k99')
  const stats = planStats(tasks)
  const lines = [fmt('uiDescribe.k196', { p1: stats.total, p2: stats.done, p3: stats.byStatus['in-progress'] ?? 0, p4: stats.byStatus['blocked'] ?? 0 })]
  if (iteration !== undefined) lines.push(fmt('uiDescribe.k100', { p1: iteration.number, p2: iteration.status, p3: iteration.goal }))
  lines.push(fmt('uiDescribe.k101', { p1: ready.length, p2: ready.map((task) => task.id).join(' ') || t('uiDescribe.k168') }))
  for (const task of tasks) {
    lines.push(`- ${task.id}　[${task.role}/${task.size}]　${task.status}${task.owner === undefined ? '' : `（${task.owner}）`}　${task.title}`)
  }
  if (stale.length > 0) {
    lines.push(fmt('uiDescribe.k102', { p1: stale.length, p2: stale.map((task) => task.id).join(' ') }))
  }
  if (issues.length > 0) lines.push(fmt('uiDescribe.k103', { p1: issues.length }))
  return lines.join('\n')
}

/** 派发请求（宿主后端）。 */
export function describeDispatch(request: DispatchRequest, degradedReason?: string | undefined): string {
  const lines = [fmt('uiDescribe.k197', { p1: request.task.id, p2: request.owner, p3: request.backend, p4: request.persona })]
  lines.push(
    t('uiDescribe.k104')
    + t('uiDescribe.k105'),
  )
  if (degradedReason !== undefined) lines.push(`- ⚠️ ${degradedReason}`)
  lines.push(fmt('uiDescribe.k106', { p1: request.toolFilter.join(' '), p2: request.writeScopes.join('、') || t('uiDescribe.k169') }))
  lines.push(fmt('uiDescribe.k107', { p1: request.expectedRevision }))
  lines.push('')
  lines.push(request.prompt)
  return lines.join('\n')
}

/** 就地执行（inline 降级）：把任务卡交给主模型。 */
export function describeInlineHandoff(request: DispatchRequest, degradedReason?: string | undefined): string {
  const lines = [fmt('uiDescribe.k198', { p1: request.task.id, p2: degradedReason === undefined ? '' : `：${degradedReason}` })]
  lines.push(fmt('uiDescribe.k108', { p1: request.owner, p2: request.task.id, p3: request.owner }))
  lines.push('')
  lines.push(request.prompt)
  return lines.join('\n')
}

/** 交付清单。 */
export function describeManifest(manifest: DeliveryManifest): string {
  const lines = [fmt('uiDescribe.k199', { p1: manifest.id, p2: manifest.by, p3: manifest.at })]
  lines.push(fmt('uiDescribe.k109', { p1: manifest.artifacts.length }))
  for (const artifact of manifest.artifacts) lines.push(`    · ${artifact.path}　[${artifact.kind}]　${artifact.sha256.slice(0, 12)}…`)
  lines.push(fmt('uiDescribe.k110', { p1: manifest.acceptance.length, p2: manifest.acceptance.map((row) => `${row.requirement}:${row.verdict}`).join(' ') }))
  lines.push(fmt('uiDescribe.k111', { p1: manifest.rollbackPoint }))
  lines.push(fmt('uiDescribe.k112', { p1: manifest.prototypeExcluded ? t('uiDescribe.k230') : t('uiDescribe.k170') }))
  return lines.join('\n')
}

/** `sdo_requirement action=update` 的回执（**不能**复用 capture 的"已捕获"，那是误导）。 */
export function describeRequirementUpdate(result: { requirement: Requirement; flags: string[] }): string {
  const { requirement, flags } = result
  const lines = [fmt('uiDescribe.k200', { p1: requirement.id, p2: requirement.title })]
  lines.push(
    fmt('uiDescribe.k113', { p1: label('requirementKind', String(requirement.kind ?? 'functional')), p2: label('priority', String(requirement.priority ?? 'should')) })
    + fmt('uiDescribe.k114', { p1: label('requirementStatus', String(requirement.status ?? 'draft')), p2: requirement.ambiguity.score }),
  )
  lines.push(fmt('uiDescribe.k115', { p1: requirement.acceptance.length }))
  if (flags.length > 0) lines.push(`- ⚠️ ${flags.join('；')}`)
  return lines.join('\n')
}

/** 需求评分的一行摘要。 */
export function describeScore(requirement: Requirement): string {
  const parts = DIMENSIONS.map((dimension) => `${dimension} ${requirement.ambiguity.dimensions[dimension] ?? 0}`)
  const review = requirement.ambiguity.needsReview === true ? t('uiDescribe.k231') : ''
  return `${requirement.ambiguity.score}/16${review} ｜ ${parts.join(' ｜ ')}`
}

/** `sdo_requirement action=capture` 的回执。 */
export function describeCapture(result: { requirement: Requirement; flags: string[] }): string {
  const { requirement, flags } = result
  const lines: string[] = [fmt('uiDescribe.k201', { p1: requirement.id, p2: requirement.title })]
  lines.push(fmt('uiDescribe.k116', { p1: requirement.kind, p2: requirement.priority ?? t('uiDescribe.k171'), p3: requirement.status }))
  lines.push(fmt('uiDescribe.k117', { p1: describeScore(requirement) }))
  if (flags.length > 0) {
    lines.push(fmt('uiDescribe.k118', { p1: flags.join('、') }))
  }
  lines.push(fmt('uiDescribe.k119', { p1: requirement.id }))
  return lines.join('\n')
}

/** 一批问题的渲染（工具与命令共用）。 */
export function describeQuestions(questions: GrillQuestion[], skipped: string[] = []): string {
  if (questions.length === 0) {
    const lines = [t('uiDescribe.k202')]
    if (skipped.length > 0) lines.push(fmt('uiDescribe.k120', { p1: skipped.join(' ') }))
    lines.push(t('uiDescribe.k121'))
    return lines.join('\n')
  }
  const lines: string[] = [fmt('uiDescribe.k203', { p1: questions.length })]
  questions.forEach((question, index) => {
    lines.push('')
    lines.push(`${index + 1}. [${question.severity}／${question.dimension}] ${question.id}　${question.text}`)
    lines.push(fmt('uiDescribe.k122', { p1: question.targets.join(' ') }))
    lines.push(fmt('uiDescribe.k123', { p1: question.why }))
    lines.push(fmt('uiDescribe.k124', { p1: question.consequenceIfUnasked }))
    question.options.forEach((option, optionIndex) => {
      lines.push(fmt('uiDescribe.k125', { p1: optionIndex, p2: option.label, p3: option.cost }))
    })
    lines.push(fmt('uiDescribe.k126', { p1: question.defaultRecommendation }))
  })
  lines.push('')
  lines.push(t('uiDescribe.k127'))
  return lines.join('\n')
}

/** `sdo_requirement action=answer` 的回执。 */
export function describeAnswer(result: { question: GrillQuestion; updated: Requirement[] }): string {
  const { question, updated } = result
  const lines: string[] = [fmt('uiDescribe.k204', { p1: question.id, p2: question.status })]
  lines.push(fmt('uiDescribe.k128', { p1: question.answer ?? t('uiDescribe.k172') }))
  lines.push(fmt('uiDescribe.k129', { p1: question.answeredBy ?? 'human' }))
  for (const requirement of updated) {
    lines.push(fmt('uiDescribe.k130', { p1: requirement.id, p2: describeScore(requirement) }))
  }
  if (question.status === 'assumed') {
    lines.push(t('uiDescribe.k131'))
  }
  return lines.join('\n')
}

/** `sdo_requirement action=list` 的回执。 */
export function describeRequirementList(requirements: Requirement[]): string {
  if (requirements.length === 0) return t('uiDescribe.k132')
  const lines: string[] = [fmt('uiDescribe.k205', { p1: requirements.length })]
  for (const requirement of requirements) {
    lines.push(
      fmt('uiDescribe.k249', { p1: requirement.id, p2: requirement.priority ?? t('uiDescribe.k248'), p3: requirement.kind, p4: requirement.status })
      + fmt('uiDescribe.k133', { p1: requirement.ambiguity.score, p2: requirement.ambiguity.open.length, p3: requirement.title }),
    )
  }
  const below = requirements.filter((requirement) => requirement.ambiguity.score < 14)
  if (below.length > 0) {
    lines.push(fmt('uiDescribe.k134', { p1: below.map((requirement) => requirement.id).join(' ') }))
  }
  return lines.join('\n')
}

/** `sdo_requirement action=baseline` 的回执（含门禁负例的 remedy）。 */
export function describeBaseline(outcome: BaselineOutcome): string {
  if (outcome.ok) {
    const lines = [fmt('uiDescribe.k206', { p1: outcome.baselined.length })]
    for (const requirement of outcome.baselined) {
      lines.push(fmt('uiDescribe.k135', { p1: requirement.id, p2: requirement.version, p3: requirement.baseline?.by ?? 'human' }))
    }
    lines.push(t('uiDescribe.k136'))
    lines.push(t('uiDescribe.k137'))
    return lines.join('\n')
  }
  return fmt('uiDescribe.k138', { p1: describeDor(outcome.dor) })
}

/** DoR 判定文本（失败时逐条给 remedy）。 */
export function describeDor(dor: DorResult): string {
  const lines: string[] = []
  for (const criterion of dor.criteria) {
    lines.push(`- ${criterion.ok ? '✅' : '❌'} ${criterion.id}　${criterion.label}`)
    lines.push(fmt('uiDescribe.k139', { p1: criterion.detail }))
    if (criterion.remedy !== undefined) lines.push(fmt('uiDescribe.k140', { p1: criterion.remedy }))
  }
  if (!dor.ok) lines.push(fmt('uiDescribe.k141', { p1: dor.failed.join(', ') }))
  return lines.join('\n')
}

/** 红队动作的回执。 */
export function describeRedTeam(action: string, payload: { questions?: GrillQuestion[]; skipped?: string[]; enabled?: boolean; executed?: boolean; reason?: string | undefined }): string {
  const lines: string[] = []
  if (action === 'attack') {
    lines.push(fmt('uiDescribe.k142', { p1: payload.questions?.length ?? 0 }))
    lines.push('')
    lines.push(describeQuestions(payload.questions ?? [], payload.skipped ?? []))
    return lines.join('\n')
  }
  if (action === 'off' || action === 'on') {
    lines.push(fmt('uiDescribe.k143', { p1: action === 'off' ? t('uiDescribe.k232') : t('uiDescribe.k173'), p2: payload.reason === undefined ? '' : fmt('uiDescribe.k174', { p1: payload.reason }) }))
    lines.push(t('uiDescribe.k144'))
    return lines.join('\n')
  }
  lines.push(fmt('uiDescribe.k145', { p1: payload.enabled === false ? t('uiDescribe.k233') : t('uiDescribe.k175'), p2: payload.executed === true ? t('uiDescribe.k234') : t('uiDescribe.k176') }))
  lines.push(t('uiDescribe.k146'))
  return lines.join('\n')
}

/** `sdo_render` 的回执。 */
export function describeRender(target: string, path: string, seq: number): string {
  return [
    fmt('uiDescribe.m3', { p1: target, p2: path }),
    fmt('uiDescribe.k147', { p1: seq }),
    t('uiDescribe.k148'),
  ].join('\n')
}

/** `sdo_design` 的门禁回执。 */
export function describeDesignGate(check: { allowed: boolean; reason: string; remedy?: string | undefined; dor: DorResult }, action: string): string {
  if (!check.allowed) {
    return [
      fmt('uiDescribe.m4', { p1: action === 'view' ? t('uiDescribe.m5') : t('uiDescribe.m6'), p2: check.reason }),
      check.remedy === undefined ? '' : fmt('uiDescribe.k149', { p1: check.remedy }),
      '',
      t('uiDescribe.k150'),
      describeDor(check.dor),
    ].join('\n')
  }
  return [
    fmt('uiDescribe.m7', { p1: check.reason }),
    t('uiDescribe.k151'),
  ].join('\n')
}
