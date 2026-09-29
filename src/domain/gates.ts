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
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { SdoStore } from '../infra/store.js'
import type {
  FeasibilityAssessment,
  GateCriterionResult,
  GateEvaluation,
  GrillQuestion,
  ProcessDef,
  RedTeamIssue,
  Requirement,
  RiskItem,
  SdoProject,
} from '../types.js'
import { adrCompleteness } from './adr.js'
import { contractCoverage } from './contracts.js'
import { viewsCompleteness } from './architecture.js'
import { evaluateDor } from './dor.js'
import { issueClosure } from './issues.js'
import { gateDef, gatePhase } from './process.js'
import { riskStats } from './risks.js'
import { report } from './trace.js'
import { iterationTasks, listTasks, planStats, readIteration, validatePlan } from './plan.js'
import { independenceViolations } from '../integration/orchestrator.js'
import {
  deliveryCompleteness,
  listDefects,
  listReviews,
  listTestCases,
  listTestResults,
  verificationStats,
} from './records.js'

/** 判定所需的全部输入（由 office 组装）。 */
export interface GateContext {
  workspace: string
  /** 读盘用（视图、契约、追溯图、ADR 都在文件里） */
  store: SdoStore
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
}

function ok(id: string, detail: string): GateCriterionResult {
  return { id, ok: true, detail }
}

function fail(id: string, detail: string, remedy: string): GateCriterionResult {
  return { id, ok: false, detail, remedy }
}

/** 该目录下是否有"实质内容"（忽略 README.md 与隐藏文件）。 */
function hasSubstantiveContent(dir: string): boolean {
  if (!existsSync(dir)) return false
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

/** 门禁检查器：键与流程数据里的 `criteria[].check` 一一对应。 */
export const CHECKERS: Record<string, (ctx: GateContext) => GateCriterionResult> = {
  'project.scope.in': (ctx) =>
    (ctx.project?.scope.in.length ?? 0) > 0
      ? ok('project.scope.in', `范围（in）${ctx.project?.scope.in.length ?? 0} 条`)
      : fail('project.scope.in', '范围（in）为空', '用 `sdo_project action=update scopeIn=…` 写明做什么'),

  'project.scope.out': (ctx) =>
    (ctx.project?.scope.out.length ?? 0) > 0
      ? ok('project.scope.out', `非目标（out）${ctx.project?.scope.out.length ?? 0} 条`)
      : fail('project.scope.out', '未声明非目标（out）', '用 `sdo_project action=update scopeOut=…` 明确不做什么'),

  'project.stakeholders': (ctx) =>
    (ctx.project?.stakeholders.length ?? 0) > 0
      ? ok('project.stakeholders', `干系人 ${ctx.project?.stakeholders.length ?? 0} 个`)
      : fail('project.stakeholders', '干系人为空', '用 `sdo_project action=update stakeholders=…` 列出干系人'),

  'project.metrics': (ctx) => {
    const metrics = ctx.project?.metrics.success ?? []
    if (metrics.length === 0) {
      return fail('project.metrics', '成功度量为空', '用 `sdo_project action=update metricsSuccess=…` 给出可测指标')
    }
    const measurable = metrics.some((metric) => /\d/u.test(metric))
    return measurable
      ? ok('project.metrics', `成功度量 ${metrics.length} 条（含数值）`)
      : fail('project.metrics', `成功度量不可测：${metrics.join('；')}`, '把度量写成"指标 + 条件 + 阈值"（含数值）')
  },

  'project.glossary': (ctx) => {
    const terms = Object.keys(ctx.project?.glossary ?? {})
    return terms.length > 0
      ? ok('project.glossary', `术语表 ${terms.length} 条`)
      : fail('project.glossary', '术语表为空', '用 `sdo_project action=update glossary={"术语":"定义"}` 补术语')
  },

  'feasibility.verdict': (ctx) => {
    const assessment = ctx.feasibility
    if (assessment === undefined) return fail('feasibility.verdict', '尚未做可行性评估', '调用 `sdo_feasibility action=assess`')
    return assessment.verdict === 'go'
      ? ok('feasibility.verdict', 'TELOS 结论：Go')
      : fail('feasibility.verdict', `TELOS 结论：${assessment.verdict}`, '消解阻塞项后重新评估为 Go，或明确终止项目')
  },

  'feasibility.risks': (ctx) => {
    const stats = riskStats(ctx.risks)
    if (stats.total === 0) return fail('feasibility.risks', '风险登记为空', '用 `sdo_risk action=log` 登记风险')
    if (stats.unmitigated.length > 0) {
      return fail(
        'feasibility.risks',
        `高/阻塞级风险缺应对或责任人：${stats.unmitigated.map((risk) => risk.id).join(' ')}`,
        '为每条高风险补 `mitigation` 与 `owner`',
      )
    }
    return ok('feasibility.risks', `风险 ${stats.total} 条（高 ${stats.high} / 阻塞 ${stats.blockers}）`)
  },

  'feasibility.poc': (ctx) => {
    const poc = ctx.feasibility?.poc ?? []
    return poc.length > 0
      ? ok('feasibility.poc', `PoC/验证建议 ${poc.length} 条`)
      : fail('feasibility.poc', '未给出 PoC 或验证建议', '在 `sdo_feasibility action=assess` 里给出 `poc`（高风险项必须验证）')
  },

  'redteam.executed': (ctx) => {
    const scale = ctx.project?.tailoring?.scale ?? 'normal'
    if (scale === 'trivial') return ok('redteam.executed', '规模档 trivial，默认不要求红队')
    if (ctx.redTeamExecuted) return ok('redteam.executed', '红队质询已执行')
    if (ctx.redTeamDisabled) return ok('redteam.executed', '本会话已显式停用（留痕）')
    return fail('redteam.executed', '红队质询未执行', '调用 `sdo_redteam action=attack`，或明确要求停用（写 `redteam/mode` 留痕）')
  },

  'redteam.closed': (ctx) => {
    if (ctx.issues.length === 0) {
      return fail('redteam.closed', '没有红队议题记录', '先执行 `sdo_redteam action=attack`（会为每条需求开议题）')
    }
    const open = ctx.issues.filter((issue) => !issueClosure(issue, ctx.questions, ctx.risks).closed)
    if (open.length === 0) return ok('redteam.closed', `红队议题 ${ctx.issues.length} 个已全部闭环`)
    return fail(
      'redteam.closed',
      `未闭环议题：${open.map((issue) => issue.id).join(' ')}（每条必须回到需求或转为风险）`,
      '回答议题下的质询问题（`sdo_requirement action=answer`），或登记一条指向该议题的风险：`sdo_risk action=log origin=<议题 id> …`',
    )
  },

  'human.signoff': (ctx) => {
    const signer = (ctx.approvedBy ?? '').trim()
    return signer === ''
      ? fail('human.signoff', '缺少人类签字', '基线时提供 `approvedBy`（人类签字，设计 §15.3 硬条件）')
      : ok('human.signoff', `签字人：${signer}`)
  },

  'prototype.timebox': (ctx) => {
    const dir = join(ctx.workspace, ctx.prototypeDir)
    const hasContent = hasSubstantiveContent(dir)
    if (!hasContent) {
      return fail('prototype.timebox', `原型目录 \`${ctx.prototypeDir}/\` 没有实质内容`, '把可运行原型放进该目录（并保持它可被整目录删除）')
    }
    return ctx.prototypeThrowaway
      ? ok('prototype.timebox', `原型已产出且标记 throwaway`)
      : fail('prototype.timebox', '原型未标记 throwaway', '在 `.sdo/config.yml` 里设置 `prototype: {throwaway: true}`')
  },

  'prototype.backfilled': (ctx) => {
    const fromPrototype = ctx.requirements.filter((requirement) => requirement.source.prototype === true)
    if (fromPrototype.length > 0) {
      return ok('prototype.backfilled', `已从原型回填 ${fromPrototype.length} 条需求`)
    }
    const protoExists = existsSync(join(ctx.workspace, ctx.prototypeDir))
    return fail(
      'prototype.backfilled',
      protoExists ? '原型存在但没有回填需求' : '尚未从原型回填需求',
      '用 `sdo_requirement action=capture prototypeSource=true …` 把原型结论回填为需求',
    )
  },

  'prototype.excluded': (ctx) => {
    const dir = join(ctx.workspace, ctx.prototypeDir)
    if (!existsSync(dir)) return ok('prototype.excluded', `没有 \`${ctx.prototypeDir}/\` 目录`)
    if (!hasSubstantiveContent(dir)) return ok('prototype.excluded', `\`${ctx.prototypeDir}/\` 只剩说明文件`)
    return fail(
      'prototype.excluded',
      `\`${ctx.prototypeDir}/\` 仍有内容，不得进入交付产物（Q-05 / REQ-034）`,
      `删除 \`${ctx.prototypeDir}/\`（原型是 throwaway），或先把结论回填为需求再删除`,
    )
  },

  'risks.logged': (ctx) => {
    const stats = riskStats(ctx.risks)
    return stats.total > 0
      ? ok('risks.logged', `风险 ${stats.total} 条（未关闭 ${stats.open}）`)
      : fail('risks.logged', '本圈没有风险登记', '用 `sdo_risk action=log` 记录本圈风险')
  },

  'risks.mitigated': (ctx) => {
    const stats = riskStats(ctx.risks)
    return stats.unmitigated.length === 0
      ? ok('risks.mitigated', '高/阻塞级风险均有应对与责任人')
      : fail(
          'risks.mitigated',
          `缺应对或责任人的风险：${stats.unmitigated.map((risk) => risk.id).join(' ')}`,
          '补 `mitigation` 与 `owner`，或把风险降级/关闭（`sdo_risk action=update`）',
        )
  },

  'design.views': (ctx) => {
    const result = viewsCompleteness(ctx.store)
    if (result.ok) return ok('design.views', `五视图齐备（${result.present.length} 张，均有元素）`)
    const problems: string[] = []
    if (result.missing.length > 0) problems.push(`缺 ${result.missing.join(' ')}`)
    if (result.empty.length > 0) problems.push(`空视图 ${result.empty.join(' ')}`)
    return fail('design.views', problems.join('；'), '用 `sdo_design action=create` 逐张补齐五视图（上下文/组件/运行时/数据/部署）')
  },

  'design.adr': (ctx) => {
    const result = adrCompleteness(ctx.store)
    if (result.ok) return ok('design.adr', `ADR ${result.total} 条，均含备选与后果`)
    if (result.total === 0) return fail('design.adr', '还没有 ADR', '用 `sdo_adr action=record` 记录关键决策（必须含备选方案与后果）')
    return fail('design.adr', `缺备选或后果：${result.incomplete.join(' ')}`, '为这些 ADR 补 `alternatives` 与 `consequences`（设计 §6.3）')
  },

  'trace.orphans': (ctx) => {
    const data = report(ctx.store, ctx.requirements)
    const orphans = [...data.orphans.design, ...data.orphans.tasks, ...data.orphans.tests]
    if (ctx.requirements.length === 0) return fail('trace.orphans', '没有需求可追溯', '先完成需求基线（G2）')
    if (orphans.length === 0) return ok('trace.orphans', `无孤儿；需求覆盖率 ${Math.round(data.coverage * 100)}%`)
    return fail(
      'trace.orphans',
      `孤儿元素：${orphans.join(' ')}`,
      '用 `sdo_trace action=link from=REQ-001 to=DES-001 kind=req-des` 把每个设计元素挂到需求上',
    )
  },

  'design.contracts': (ctx) => {
    const result = contractCoverage(ctx.store)
    if (result.ok) return ok('design.contracts', `契约覆盖 ${result.covered}/${result.totalEdges} 条跨组件交互`)
    const problems: string[] = []
    if (result.totalEdges === 0) problems.push('组件视图没有跨组件依赖边')
    if (result.missing.length > 0) {
      problems.push(`缺契约：${result.missing.map((edge) => `${edge.consumer}→${edge.producer}`).join(' ')}`)
    }
    if (result.incompleteSemantics.length > 0) problems.push(`失败语义不全：${result.incompleteSemantics.join(' ')}`)
    return fail('design.contracts', problems.join('；'), '用 `sdo_design action=contract` 为每条交互补契约（含超时/重试/幂等）')
  },

  'plan.tasks': (ctx) => {
    const tasks = listTasks(ctx.store)
    if (tasks.length === 0) {
      return fail('plan.tasks', '还没有任务卡', '用 `sdo_plan action=decompose` 按追溯图拆分任务卡')
    }
    const issues = validatePlan(tasks)
    if (issues.length === 0) return ok('plan.tasks', `任务卡 ${tasks.length} 张，六条机械校验全过`)
    return fail(
      'plan.tasks',
      `拆分校验不通过：${issues.map((issue) => `${issue.taskId}:${issue.detail}`).join('；')}`,
      issues[0]?.remedy ?? '修正这些卡再试',
    )
  },

  'plan.testplan': (ctx) => {
    const cases = listTestCases(ctx.store)
    if (cases.length === 0) return fail('plan.testplan', '还没有测试用例', '用 `sdo_test action=plan` 写用例（覆盖每条 must 需求）')
    const musts = ctx.requirements.filter((requirement) => requirement.priority === 'must')
    const uncovered = musts
      .filter((requirement) => !cases.some((testCase) => testCase.requirement === requirement.id))
      .map((requirement) => requirement.id)
    if (uncovered.length === 0) return ok('plan.testplan', `用例 ${cases.length} 条，覆盖全部 must 需求（${musts.length}）`)
    return fail('plan.testplan', `must 需求缺用例：${uncovered.join(' ')}`, `为 ${uncovered.join(' ')} 各写至少一条用例（\`sdo_test action=plan requirement=…\`）`)
  },

  'tasks.all_done': (ctx) => {
    const stats = planStats(listTasks(ctx.store))
    if (stats.total === 0) return fail('tasks.all_done', '还没有任务卡', '先 `sdo_plan action=decompose`')
    if (stats.allDone) {
      const missingEvidence = listTasks(ctx.store).filter((task) => task.evidence.length === 0)
      return missingEvidence.length === 0
        ? ok('tasks.all_done', `任务卡 ${stats.total} 张全部完成且有证据`)
        : fail('tasks.all_done', `完成但无证据：${missingEvidence.map((task) => task.id).join(' ')}`, '补证据（`sdo_task action=done` 必须带 evidence）')
    }
    return fail(
      'tasks.all_done',
      `未完成：${Object.entries(stats.byStatus)
        .filter(([status]) => status !== 'done' && status !== 'verified')
        .map(([status, count]) => `${status} ${count}`)
        .join('，')}`,
      '推进或显式放弃剩余任务卡（`sdo_task action=done|block`）',
    )
  },

  'trace.coverage': (ctx) => {
    const data = report(ctx.store, ctx.requirements)
    const orphans = [...data.orphans.design, ...data.orphans.tasks, ...data.orphans.tests]
    if (orphans.length > 0) return fail('trace.coverage', `仍有孤儿：${orphans.join(' ')}`, '把孤儿元素挂回需求（`sdo_trace action=link`）')
    if (data.uncoveredMust.length > 0) return fail('trace.coverage', `must 需求缺测试用例：${data.uncoveredMust.join(' ')}`, '补 req-tc 边')
    return ok('trace.coverage', `覆盖率 ${Math.round(data.coverage * 100)}%，无孤儿`)
  },

  'tests.passed': (ctx) => {
    const stats = verificationStats(ctx.store)
    if (stats.cases === 0) return fail('tests.passed', '没有测试用例', '用 `sdo_test action=plan` 写用例')
    if (stats.results === 0) return fail('tests.passed', '用例都没有执行结果', '用 `sdo_test action=record` 记录结果（附证据）')
    if (stats.failed > 0) return fail('tests.passed', `失败用例：${stats.failedCaseIds.join(' ')}`, '修好并重跑；失败用例不允许带着过门禁')
    const unrun = listTestCases(ctx.store)
      .filter((testCase) => !listTestResults(ctx.store).some((result) => result.caseId === testCase.id))
      .map((testCase) => testCase.id)
    if (unrun.length > 0) return fail('tests.passed', `有用例没跑：${unrun.join(' ')}`, '把每条用例都跑掉')
    return ok('tests.passed', `用例 ${stats.cases} 条全部有结果（通过 ${stats.passed}）`)
  },

  'defects.closed': (ctx) => {
    const stats = verificationStats(ctx.store)
    if (stats.blockersOpen > 0) {
      const open = listDefects(ctx.store)
        .filter((defect) => defect.severity === 'blocker' && defect.status !== 'closed' && defect.status !== 'wontfix')
        .map((defect) => defect.id)
      return fail('defects.closed', `阻塞级缺陷未关闭：${open.join(' ')}`, '修掉并关闭（`sdo_test action=defect id=… status=closed`）')
    }
    return ok('defects.closed', `无未关闭的阻塞级缺陷（未关闭总计 ${stats.defectsOpen}）`)
  },

  'review.independent': (ctx) => {
    const reviews = listReviews(ctx.store)
    const tasks = listTasks(ctx.store)
    const violations = independenceViolations(reviews, tasks)
    if (violations.length > 0) {
      return fail('review.independent', violations.map((item) => item.detail).join('；'), '换一个评审者（作者不得评审自己的产出）')
    }
    const doneTasks = tasks.filter((task) => task.status === 'done' || task.status === 'verified')
    const unreviewed = doneTasks.filter((task) => !reviews.some((review) => review.taskId === task.id && review.verdict === 'pass')).map((task) => task.id)
    if (unreviewed.length > 0) {
      return fail('review.independent', `已完成但无通过评审：${unreviewed.join(' ')}`, '用 `sdo_review action=record`（评审者 ≠ 作者）')
    }
    return ok('review.independent', `评审 ${reviews.length} 条，独立性无违规`)
  },

  'iteration.increment': (ctx) => {
    const current = readIteration(ctx.store)
    if (current === undefined) return fail('iteration.increment', '还没有开迭代', '用 `sdo_plan action=iteration goal=…` 开一个迭代')
    const tasks = iterationTasks(ctx.store, current.number)
    if (tasks.length === 0) return fail('iteration.increment', `迭代 ${current.number} 没有任务卡`, '为这个迭代拆出任务卡')
    const unfinished = tasks.filter((task) => task.status !== 'done' && task.status !== 'verified').map((task) => task.id)
    if (unfinished.length > 0) return fail('iteration.increment', `迭代内未完成：${unfinished.join(' ')}`, '完成或移出这些卡')
    return ok('iteration.increment', `迭代 ${current.number} 产出增量（${tasks.length} 张卡全部完成）`)
  },

  'iteration.dod': (ctx) => {
    const current = readIteration(ctx.store)
    if (current === undefined) return fail('iteration.dod', '还没有开迭代', '用 `sdo_plan action=iteration`')
    if (current.goal.trim() === '') return fail('iteration.dod', '迭代没有目标', '给迭代写目标（否则"完成"无从判定）')
    const tasks = iterationTasks(ctx.store, current.number)
    const noEvidence = tasks.filter((task) => task.status === 'done' && task.evidence.length === 0).map((task) => task.id)
    if (noEvidence.length > 0) return fail('iteration.dod', `完成但无证据：${noEvidence.join(' ')}`, '补证据')
    const stats = verificationStats(ctx.store)
    if (stats.results === 0) return fail('iteration.dod', '迭代内没有任何测试结果', '跑用例并记录结果')
    return ok('iteration.dod', `迭代 ${current.number} 的 DoD 满足（含 ${stats.results} 条测试结果）`)
  },

  'delivery.manifest': (ctx) => {
    const result = deliveryCompleteness(ctx.store, ctx.requirements, ctx.prototypeDir)
    if (result.ok) {
      return ok('delivery.manifest', `交付清单 ${result.manifest?.id ?? ''}：产物 ${result.manifest?.artifacts.length ?? 0} 项，验收行 ${result.manifest?.acceptance.length ?? 0} 条`)
    }
    return fail('delivery.manifest', result.problems.join('；'), '用 `sdo_deliver action=package` 生成完整清单（含 sha256、验收矩阵、回滚点）')
  },

  'risks.conclusion': (ctx) =>
    ctx.riskConclusion === undefined
      ? fail('risks.conclusion', '本圈还没有风险结论', '用 `sdo_risk action=conclude conclusion=continue|adjust|stop rationale=…` 给出结论')
      : ok('risks.conclusion', `本圈结论：${ctx.riskConclusion}`),
}

/** G2 的 7 条准则复用 DoR 判定（同一份实现，避免两套口径）。 */
function dorCriteria(ctx: GateContext): Record<string, GateCriterionResult> {
  const dor = evaluateDor({
    project: ctx.project,
    requirements: ctx.requirements,
    questions: ctx.questions,
    redTeamExecuted: ctx.redTeamExecuted,
    redTeamDisabled: ctx.redTeamDisabled,
    ...(ctx.approvedBy === undefined ? {} : { approvedBy: ctx.approvedBy }),
  })
  const map: Record<string, GateCriterionResult> = {}
  for (const criterion of dor.criteria) {
    map[criterion.id] = {
      id: criterion.id,
      ok: criterion.ok,
      detail: criterion.detail,
      ...(criterion.remedy === undefined ? {} : { remedy: criterion.remedy }),
    }
  }
  return map
}

/** 判定一个门禁。 */
export function evaluateGate(process: ProcessDef, gateId: string, ctx: GateContext): GateEvaluation {
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
          detail: `流程 ${process.id} 里没有定义门禁 ${gateId}`,
          remedy: `可用门禁：${process.gates.map((gate) => gate.id).join(' ')}`,
        },
      ],
      remedy: [`流程 ${process.id} 未定义门禁 ${gateId}`],
    }
  }

  const dor = dorCriteria(ctx)
  const criteria: GateCriterionResult[] = definition.criteria.map((criterion) => {
    const fromDor = dor[criterion.id]
    if (fromDor !== undefined) return fromDor
    const checker = CHECKERS[criterion.check]
    if (checker === undefined) {
      return fail(
        criterion.id,
        `检查器 \`${criterion.check}\` 尚未实现（后续里程碑）`,
        '该准则的实现排在后续里程碑；在此之前该门禁无法通过（不允许"查不到就算过"）',
      )
    }
    const result = checker(ctx)
    return { ...result, id: criterion.id }
  })

  const waived = ctx.waivedGates.includes(gateId)
  const allOk = criteria.every((criterion) => criterion.ok)
  const status = waived ? 'waived' : allOk ? 'passed' : 'failed'
  const remedy = criteria.filter((criterion) => !criterion.ok).map((criterion) => criterion.remedy ?? criterion.detail)
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
