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
import { evaluateDor } from './dor.js'
import { issueClosure } from './issues.js'
import { gateDef, gatePhase } from './process.js'
import { riskStats } from './risks.js'

/** 判定所需的全部输入（由 office 组装）。 */
export interface GateContext {
  workspace: string
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
