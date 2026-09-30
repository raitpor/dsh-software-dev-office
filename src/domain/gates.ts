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
import { fmt, t } from './i18n.js'
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
/** 原型是否在本项目「在局」：流程是原型流程，或工作区里已有原型目录（**D3**）。 */
export function prototypeInPlay(ctx: GateContext): boolean {
  if (ctx.project?.process === 'prototype') return true
  return existsSync(join(ctx.workspace, ctx.prototypeDir))
}

export const CHECKERS: Record<string, (ctx: GateContext) => GateCriterionResult> = {
  'project.scope.in': (ctx) =>
    (ctx.project?.scope.in.length ?? 0) > 0
      ? ok('project.scope.in', fmt('uiGates.k1', { p1: ctx.project?.scope.in.length ?? 0 }))
      : fail('project.scope.in', t('uiGates.k2'), t('uiGates.k3')),

  'project.scope.out': (ctx) =>
    (ctx.project?.scope.out.length ?? 0) > 0
      ? ok('project.scope.out', fmt('uiGates.k4', { p1: ctx.project?.scope.out.length ?? 0 }))
      : fail('project.scope.out', t('uiGates.k5'), t('uiGates.k6')),

  'project.stakeholders': (ctx) =>
    (ctx.project?.stakeholders.length ?? 0) > 0
      ? ok('project.stakeholders', fmt('uiGates.k7', { p1: ctx.project?.stakeholders.length ?? 0 }))
      : fail('project.stakeholders', t('uiGates.k8'), t('uiGates.k9')),

  'project.metrics': (ctx) => {
    const metrics = ctx.project?.metrics.success ?? []
    if (metrics.length === 0) {
      return fail('project.metrics', t('uiGates.k10'), t('uiGates.k11'))
    }
    const measurable = metrics.some((metric) => /\d/u.test(metric))
    return measurable
      ? ok('project.metrics', fmt('uiGates.k12', { p1: metrics.length }))
      : fail('project.metrics', fmt('uiGates.k13', { p1: metrics.join('；') }), t('uiGates.k14'))
  },

  'project.glossary': (ctx) => {
    const terms = Object.keys(ctx.project?.glossary ?? {})
    return terms.length > 0
      ? ok('project.glossary', fmt('uiGates.k15', { p1: terms.length }))
      : fail('project.glossary', t('uiGates.k16'), t('uiGates.k17'))
  },

  'feasibility.verdict': (ctx) => {
    const assessment = ctx.feasibility
    if (assessment === undefined) return fail('feasibility.verdict', t('uiGates.k18'), t('uiGates.k19'))
    return assessment.verdict === 'go'
      ? ok('feasibility.verdict', t('uiGates.k20'))
      : fail('feasibility.verdict', fmt('uiGates.k21', { p1: assessment.verdict }), t('uiGates.k22'))
  },

  'feasibility.risks': (ctx) => {
    const stats = riskStats(ctx.risks)
    if (stats.total === 0) return fail('feasibility.risks', t('uiGates.k23'), t('uiGates.k24'))
    if (stats.unmitigated.length > 0) {
      return fail(
        'feasibility.risks',
        fmt('uiGates.k25', { p1: stats.unmitigated.map((risk) => risk.id).join(' ') }),
        t('uiGates.k26'),
      )
    }
    return ok('feasibility.risks', fmt('uiGates.k27', { p1: stats.total, p2: stats.high, p3: stats.blockers }))
  },

  'feasibility.poc': (ctx) => {
    const poc = ctx.feasibility?.poc ?? []
    return poc.length > 0
      ? ok('feasibility.poc', fmt('uiGates.k28', { p1: poc.length }))
      : fail('feasibility.poc', t('uiGates.k29'), t('uiGates.k30'))
  },

  'redteam.executed': (ctx) => {
    const scale = ctx.project?.tailoring?.scale ?? 'normal'
    if (scale === 'trivial') return ok('redteam.executed', t('uiGates.k31'))
    if (ctx.redTeamExecuted) return ok('redteam.executed', t('uiGates.k32'))
    if (ctx.redTeamDisabled) return ok('redteam.executed', t('uiGates.k33'))
    return fail('redteam.executed', t('uiGates.k34'), t('uiGates.k35'))
  },

  'redteam.closed': (ctx) => {
    if (ctx.issues.length === 0) {
      return fail('redteam.closed', t('uiGates.k36'), t('uiGates.k37'))
    }
    const open = ctx.issues.filter((issue) => !issueClosure(issue, ctx.questions, ctx.risks).closed)
    if (open.length === 0) return ok('redteam.closed', fmt('uiGates.k38', { p1: ctx.issues.length }))
    return fail(
      'redteam.closed',
      fmt('uiGates.k39', { p1: open.map((issue) => issue.id).join(' ') }),
      t('uiGates.k40'),
    )
  },

  'human.signoff': (ctx) => {
    const signer = (ctx.approvedBy ?? '').trim()
    return signer === ''
      ? fail('human.signoff', t('uiGates.k41'), t('uiGates.k42'))
      : ok('human.signoff', fmt('uiGates.k43', { p1: signer }))
  },

  'prototype.timebox': (ctx) => {
    const dir = join(ctx.workspace, ctx.prototypeDir)
    const hasContent = hasSubstantiveContent(dir)
    if (!hasContent) {
      return fail('prototype.timebox', fmt('uiGates.k44', { p1: ctx.prototypeDir }), t('uiGates.k45'))
    }
    // **D3**：本流程不涉及原型（且没有原型目录）时，原型类判据**不适用**——
    // 否则 waterfall 的 G7 会有一条永远为红、与项目事实无关的判据（"不做原型"没有出路）。
    if (!prototypeInPlay(ctx)) return ok('prototype.timebox', t('uiGates.k46'))
    return ctx.prototypeThrowaway
      ? ok('prototype.timebox', t('uiGates.k47'))
      : fail('prototype.timebox', t('uiGates.k48'), t('uiGates.k49'))
  },

  'prototype.backfilled': (ctx) => {
    if (!prototypeInPlay(ctx)) return ok('prototype.backfilled', t('uiGates.k50'))
    const fromPrototype = ctx.requirements.filter((requirement) => requirement.source.prototype === true)
    if (fromPrototype.length > 0) {
      return ok('prototype.backfilled', fmt('uiGates.k51', { p1: fromPrototype.length }))
    }
    const protoExists = existsSync(join(ctx.workspace, ctx.prototypeDir))
    return fail(
      'prototype.backfilled',
      protoExists ? t('uiGates.k52') : t('uiGates.k53'),
      t('uiGates.k54'),
    )
  },

  'prototype.excluded': (ctx) => {
    const dir = join(ctx.workspace, ctx.prototypeDir)
    if (!existsSync(dir)) return ok('prototype.excluded', fmt('uiGates.k55', { p1: ctx.prototypeDir }))
    if (!hasSubstantiveContent(dir)) return ok('prototype.excluded', fmt('uiGates.k56', { p1: ctx.prototypeDir }))
    return fail(
      'prototype.excluded',
      fmt('uiGates.k57', { p1: ctx.prototypeDir }),
      fmt('uiGates.k58', { p1: ctx.prototypeDir }),
    )
  },

  'risks.logged': (ctx) => {
    const stats = riskStats(ctx.risks)
    return stats.total > 0
      ? ok('risks.logged', fmt('uiGates.k59', { p1: stats.total, p2: stats.open }))
      : fail('risks.logged', t('uiGates.k60'), t('uiGates.k61'))
  },

  'risks.mitigated': (ctx) => {
    const stats = riskStats(ctx.risks)
    return stats.unmitigated.length === 0
      ? ok('risks.mitigated', t('uiGates.k62'))
      : fail(
          'risks.mitigated',
          fmt('uiGates.k63', { p1: stats.unmitigated.map((risk) => risk.id).join(' ') }),
          t('uiGates.k64'),
        )
  },

  'design.views': (ctx) => {
    const result = viewsCompleteness(ctx.store)
    if (result.ok) return ok('design.views', fmt('uiGates.k65', { p1: result.present.length }))
    const problems: string[] = []
    if (result.missing.length > 0) problems.push(fmt('uiGates.k66', { p1: result.missing.join(' ') }))
    if (result.empty.length > 0) problems.push(fmt('uiGates.k67', { p1: result.empty.join(' ') }))
    return fail('design.views', problems.join('；'), t('uiGates.k68'))
  },

  'design.adr': (ctx) => {
    const result = adrCompleteness(ctx.store)
    if (result.ok) return ok('design.adr', fmt('uiGates.k69', { p1: result.total }))
    if (result.total === 0) return fail('design.adr', t('uiGates.k70'), t('uiGates.k71'))
    return fail('design.adr', fmt('uiGates.k72', { p1: result.incomplete.join(' ') }), t('uiGates.k73'))
  },

  'trace.orphans': (ctx) => {
    const data = report(ctx.store, ctx.requirements)
    const orphans = [...data.orphans.design, ...data.orphans.tasks, ...data.orphans.tests]
    if (ctx.requirements.length === 0) return fail('trace.orphans', t('uiGates.k74'), t('uiGates.k75'))
    if (orphans.length === 0) return ok('trace.orphans', fmt('uiGates.k76', { p1: Math.round(data.coverage * 100) }))
    return fail(
      'trace.orphans',
      fmt('uiGates.k77', { p1: orphans.join(' ') }),
      t('uiGates.k78'),
    )
  },

  'design.contracts': (ctx) => {
    const result = contractCoverage(ctx.store)
    if (result.ok) return ok('design.contracts', fmt('uiGates.k79', { p1: result.covered, p2: result.totalEdges }))
    const problems: string[] = []
    if (result.totalEdges === 0) problems.push(t('uiGates.k80'))
    if (result.missing.length > 0) {
      problems.push(fmt('uiGates.k81', { p1: result.missing.map((edge) => `${edge.consumer}→${edge.producer}`).join(' ') }))
    }
    if (result.incompleteSemantics.length > 0) problems.push(fmt('uiGates.k82', { p1: result.incompleteSemantics.join(' ') }))
    return fail('design.contracts', problems.join('；'), t('uiGates.k83'))
  },

  'plan.tasks': (ctx) => {
    const tasks = listTasks(ctx.store)
    if (tasks.length === 0) {
      return fail('plan.tasks', t('uiGates.k84'), t('uiGates.k85'))
    }
    const issues = validatePlan(tasks)
    if (issues.length === 0) return ok('plan.tasks', fmt('uiGates.k86', { p1: tasks.length }))
    return fail(
      'plan.tasks',
      fmt('uiGates.k87', { p1: issues.map((issue) => `${issue.taskId}:${issue.detail}`).join('；') }),
      issues[0]?.remedy ?? t('uiGates.kFixCards'),
    )
  },

  'plan.testplan': (ctx) => {
    const cases = listTestCases(ctx.store)
    if (cases.length === 0) return fail('plan.testplan', t('uiGates.k88'), t('uiGates.k89'))
    const musts = ctx.requirements.filter((requirement) => requirement.priority === 'must')
    const uncovered = musts
      .filter((requirement) => !cases.some((testCase) => testCase.requirement === requirement.id))
      .map((requirement) => requirement.id)
    if (uncovered.length === 0) return ok('plan.testplan', fmt('uiGates.k90', { p1: cases.length, p2: musts.length }))
    return fail('plan.testplan', fmt('uiGates.k91', { p1: uncovered.join(' ') }), fmt('uiGates.k92', { p1: uncovered.join(' ') }))
  },

  'tasks.all_done': (ctx) => {
    const stats = planStats(listTasks(ctx.store))
    if (stats.total === 0) return fail('tasks.all_done', t('uiGates.k93'), t('uiGates.k94'))
    if (stats.allDone) {
      // **D7**：dropped 卡本就没有证据，不得算进"完成但无证据"
      const missingEvidence = listTasks(ctx.store).filter(
        (task) => task.status !== 'dropped' && task.evidence.length === 0,
      )
      const droppedNote = stats.total === stats.active ? '' : t('gate.tasksDroppedNote').replace('{n}', String(stats.total - stats.active))
      return missingEvidence.length === 0
        ? ok('tasks.all_done', `${fmt('gate.tasksAllDone', { n: stats.active })}${droppedNote}`)
        : fail(
            'tasks.all_done',
            `${fmt('gate.tasksMissingEvidence', { ids: missingEvidence.map((task) => task.id).join(' ') })}`,
            t('gate.tasksMissingEvidenceRemedy'),
          )
    }
    return fail(
      'tasks.all_done',
      fmt('gate.tasksIncomplete', {
        list: Object.entries(stats.byStatus)
          // **D7**：dropped 是显式放弃的终态，不是"未完成"
          .filter(([status]) => status !== 'done' && status !== 'verified' && status !== 'dropped')
          .map(([status, count]) => `${t(`taskStatus.${status}`, status)} ${count}`)
          .join('，'),
      }),
      t('gate.tasksAllDoneRemedy'),
    )
  },

  'trace.coverage': (ctx) => {
    const data = report(ctx.store, ctx.requirements)
    const orphans = [...data.orphans.design, ...data.orphans.tasks, ...data.orphans.tests]
    if (orphans.length > 0) return fail('trace.coverage', fmt('uiGates.k95', { p1: orphans.join(' ') }), t('uiGates.k96'))
    if (data.uncoveredMust.length > 0) return fail('trace.coverage', fmt('uiGates.k97', { p1: data.uncoveredMust.join(' ') }), t('uiGates.k98'))
    return ok('trace.coverage', fmt('uiGates.k99', { p1: Math.round(data.coverage * 100) }))
  },

  'tests.passed': (ctx) => {
    const stats = verificationStats(ctx.store)
    if (stats.cases === 0) return fail('tests.passed', t('uiGates.k100'), t('uiGates.k101'))
    if (stats.results === 0) return fail('tests.passed', t('uiGates.k102'), t('uiGates.k103'))
    if (stats.failed > 0) return fail('tests.passed', fmt('uiGates.k104', { p1: stats.failedCaseIds.join(' ') }), t('uiGates.k105'))
    const unrun = listTestCases(ctx.store)
      .filter((testCase) => !listTestResults(ctx.store).some((result) => result.caseId === testCase.id))
      .map((testCase) => testCase.id)
    if (unrun.length > 0) return fail('tests.passed', fmt('uiGates.k106', { p1: unrun.join(' ') }), t('uiGates.k107'))
    // **G-02**：判据描述承诺「全部 must REQ 有通过的测试用例」，实现却只数用例计数 ——
    // 于是"删掉一条用例"或"新增 must 需求"都不会让这条判据变红（假保证）。这里补上真覆盖校验。
    const trace = report(ctx.store, ctx.requirements)
    if (trace.uncoveredMust.length > 0) {
      return fail(
        'tests.passed',
        fmt('uiGates.k108', { p1: trace.uncoveredMust.join(' ') }),
        t('uiGates.k109'),
      )
    }
    return ok('tests.passed', fmt('uiGates.k110', { p1: stats.cases, p2: stats.passed }))
  },

  'defects.closed': (ctx) => {
    const stats = verificationStats(ctx.store)
    if (stats.blockersOpen > 0) {
      const open = listDefects(ctx.store)
        .filter((defect) => defect.severity === 'blocker' && defect.status !== 'closed' && defect.status !== 'wontfix')
        .map((defect) => defect.id)
      return fail('defects.closed', fmt('uiGates.k111', { p1: open.join(' ') }), t('uiGates.k112'))
    }
    return ok('defects.closed', fmt('uiGates.k113', { p1: stats.defectsOpen }))
  },

  'review.independent': (ctx) => {
    const reviews = listReviews(ctx.store)
    const tasks = listTasks(ctx.store)
    const violations = independenceViolations(reviews, tasks)
    if (violations.length > 0) {
      return fail('review.independent', violations.map((item) => item.detail).join('；'), t('uiGates.k114'))
    }
    const doneTasks = tasks.filter((task) => task.status === 'done' || task.status === 'verified')
    const unreviewed = doneTasks.filter((task) => !reviews.some((review) => review.taskId === task.id && review.verdict === 'pass')).map((task) => task.id)
    if (unreviewed.length > 0) {
      return fail('review.independent', fmt('uiGates.k115', { p1: unreviewed.join(' ') }), t('uiGates.k116'))
    }
    return ok('review.independent', fmt('uiGates.k117', { p1: reviews.length }))
  },

  'iteration.increment': (ctx) => {
    const current = readIteration(ctx.store)
    if (current === undefined) return fail('iteration.increment', t('uiGates.k118'), t('uiGates.k119'))
    const tasks = iterationTasks(ctx.store, current.number)
    if (tasks.length === 0) return fail('iteration.increment', fmt('uiGates.k120', { p1: current.number }), t('uiGates.k121'))
    const unfinished = tasks.filter((task) => task.status !== 'done' && task.status !== 'verified').map((task) => task.id)
    if (unfinished.length > 0) return fail('iteration.increment', fmt('uiGates.k122', { p1: unfinished.join(' ') }), t('uiGates.k123'))
    return ok('iteration.increment', fmt('uiGates.k124', { p1: current.number, p2: tasks.length }))
  },

  'iteration.dod': (ctx) => {
    const current = readIteration(ctx.store)
    if (current === undefined) return fail('iteration.dod', t('uiGates.k125'), t('uiGates.k126'))
    if (current.goal.trim() === '') return fail('iteration.dod', t('uiGates.k127'), t('uiGates.k128'))
    const tasks = iterationTasks(ctx.store, current.number)
    const noEvidence = tasks.filter((task) => task.status === 'done' && task.evidence.length === 0).map((task) => task.id)
    if (noEvidence.length > 0) return fail('iteration.dod', fmt('uiGates.k129', { p1: noEvidence.join(' ') }), t('uiGates.k130'))
    const stats = verificationStats(ctx.store)
    if (stats.results === 0) return fail('iteration.dod', t('uiGates.k131'), t('uiGates.k132'))
    return ok('iteration.dod', fmt('uiGates.k133', { p1: current.number, p2: stats.results }))
  },

  'delivery.manifest': (ctx) => {
    const result = deliveryCompleteness(ctx.store, ctx.requirements, ctx.prototypeDir)
    if (result.ok) {
      return ok('delivery.manifest', fmt('uiGates.k134', { p1: result.manifest?.id ?? '', p2: result.manifest?.artifacts.length ?? 0, p3: result.manifest?.acceptance.length ?? 0 }))
    }
    return fail('delivery.manifest', result.problems.join('；'), t('uiGates.k135'))
  },

  'risks.conclusion': (ctx) =>
    ctx.riskConclusion === undefined
      ? fail('risks.conclusion', t('uiGates.k136'), t('uiGates.k137'))
      : ok('risks.conclusion', fmt('uiGates.k138', { p1: ctx.riskConclusion })),
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
          detail: fmt('uiGates.k139', { p1: process.id, p2: gateId }),
          remedy: fmt('uiGates.k140', { p1: process.gates.map((gate) => gate.id).join(' ') }),
        },
      ],
      remedy: [fmt('uiGates.k141', { p1: process.id, p2: gateId })],
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
        fmt('uiGates.k142', { p1: criterion.check }),
        t('uiGates.k143'),
      )
    }
    const result = checker(ctx)
    return { ...result, id: criterion.id }
  })
  for (const criterion of criteria) {
    if (criterion.desc === undefined) {
      const defined = definition.criteria.find((candidate) => candidate.id === criterion.id)
      if (defined?.desc !== undefined) criterion.desc = defined.desc
    }
  }

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
