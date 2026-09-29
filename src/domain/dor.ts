/**
 * DoR（需求就绪定义）——门禁 G2 的判定（设计 §5.2.5 + §15.3 的 `G2 需求基线`）。
 *
 * 判定是**纯函数**：给定项目、需求集、问题账本与红队状态，输出每条准则的通过与 remedy。
 * 这样门禁既可单测，也可被工具层与（M3 的）流程状态机复用。
 */
import { DIMENSIONS } from '../types.js'
import type { GrillQuestion, Requirement, SdoProject } from '../types.js'
import { loadScoring, meetsThreshold } from './scoring.js'

/** 一条门禁准则的判定结果。 */
export interface DorCriterion {
  id: string
  label: string
  ok: boolean
  detail: string
  remedy?: string | undefined
}

export interface DorResult {
  ok: boolean
  criteria: DorCriterion[]
  /** 未通过的准则 id（便于工具层给出可执行 remedy） */
  failed: string[]
}

export interface DorInput {
  project: SdoProject | undefined
  requirements: Requirement[]
  questions: GrillQuestion[]
  /** 本会话红队是否已执行过（`redteam/attack` 事件） */
  redTeamExecuted: boolean
  /** 本会话红队是否被显式停用（`redteam/mode` 留痕） */
  redTeamDisabled: boolean
  /** 人类签字（设计 §15.3 G2 末条） */
  approvedBy?: string | undefined
  /** P1 未决问题的上限（设计 §5.2.5） */
  maxOpenP1?: number | undefined
}

/** 每条需求的门禁画像，便于给出精确 remedy。 */
interface PerRequirement {
  id: string
  ok: boolean
  problems: string[]
}

function inspect(requirement: Requirement): PerRequirement {
  const model = loadScoring()
  const problems: string[] = []
  const threshold = meetsThreshold(requirement.ambiguity, model)
  if (!threshold.ok) {
    problems.push(`评分 ${requirement.ambiguity.score}/16 未达 ${model.threshold}${threshold.zeroDimensions.length > 0 ? `，且维度为 0：${threshold.zeroDimensions.join('/')}` : ''}`)
  }
  if (requirement.priority === undefined) problems.push('未定优先级（must/should/could/wont）')
  if (requirement.source.stakeholder === undefined && (requirement.source.raw ?? '') === '') {
    problems.push('无来源（干系人或原始诉求）')
  }
  if (requirement.acceptance.length === 0) {
    problems.push('无验收标准')
  } else if (!requirement.acceptance.every((ac) => ac.given !== '' && ac.when !== '' && ac.then !== '')) {
    problems.push('验收标准不是完整的 Given/When/Then')
  }
  return { id: requirement.id, ok: problems.length === 0, problems }
}

/** 评估 G2（需求基线门禁）。 */
export function evaluateDor(input: DorInput): DorResult {
  const model = loadScoring()
  const criteria: DorCriterion[] = []
  const maxOpenP1 = input.maxOpenP1 ?? 2

  // C1：每条需求达到阈值、无 0 分维度、有优先级/来源/AC
  const perRequirement = input.requirements.map(inspect)
  const bad = perRequirement.filter((item) => !item.ok)
  criteria.push({
    id: 'C1-dor-per-requirement',
    label: `每条需求满足 DoR（评分 ≥ ${model.threshold}/16、无 0 分维度、有优先级/来源/Given-When-Then 验收标准）`,
    ok: input.requirements.length > 0 && bad.length === 0,
    detail:
      input.requirements.length === 0
        ? '还没有任何需求'
        : bad.length === 0
          ? `全部 ${input.requirements.length} 条通过`
          : bad.map((item) => `${item.id}：${item.problems.join('；')}`).join(' | '),
    remedy:
      bad.length === 0
        ? undefined
        : '用 `sdo_requirement action=grill` 就最弱维度提问、`action=answer` 回答并更新语义分，再补优先级/来源/验收标准',
  })

  // C2：无 P0 未决；P1 未决 ≤ 上限
  const open = input.questions.filter((question) => question.status === 'open')
  const openP0 = open.filter((question) => question.severity === 'P0')
  const openP1 = open.filter((question) => question.severity === 'P1')
  criteria.push({
    id: 'C2-open-questions',
    label: `无 P0 未决问题；P1 未决不超过 ${maxOpenP1} 条`,
    ok: openP0.length === 0 && openP1.length <= maxOpenP1,
    detail:
      openP0.length === 0 && openP1.length === 0
        ? '无未决问题'
        : `P0 未决 ${openP0.length} 条${openP0.length > 0 ? `（${openP0.map((q) => q.id).join(' ')}）` : ''}；P1 未决 ${openP1.length} 条${openP1.length > 0 ? `（${openP1.map((q) => q.id).join(' ')}）` : ''}`,
    remedy:
      openP0.length === 0 && openP1.length <= maxOpenP1
        ? undefined
        : '先把 P0 问题全部回答（`sdo_requirement action=answer`）；P1 超过 2 条时需转入风险登记或补答',
  })

  // C3：每条 must 需求至少一条 Given/When/Then 验收标准（§15.3 G2）
  const mustWithoutAc = input.requirements.filter(
    (requirement) =>
      requirement.priority === 'must' &&
      !requirement.acceptance.some((ac) => ac.given !== '' && ac.when !== '' && ac.then !== ''),
  )
  criteria.push({
    id: 'C3-must-has-ac',
    label: '每条 must 需求有 ≥1 条 Given/When/Then 验收标准',
    ok: mustWithoutAc.length === 0,
    detail: mustWithoutAc.length === 0 ? '全部 must 需求均有 AC' : `${mustWithoutAc.map((r) => r.id).join(' ')} 缺少 AC`,
    remedy: mustWithoutAc.length === 0 ? undefined : '为这些 must 需求补 AC（`sdo_requirement action=update` 带 acceptance）',
  })

  // C4：术语表（覆盖度检查依赖 M2 追溯引擎；这里先要求存在且非空，并写明局限）
  const glossaryTerms = Object.keys(input.project?.glossary ?? {})
  criteria.push({
    id: 'C4-glossary',
    label: '术语表存在且非空（完整覆盖度检查待 M2 追溯引擎）',
    ok: glossaryTerms.length > 0,
    detail: glossaryTerms.length === 0 ? '术语表为空' : `收录 ${glossaryTerms.length} 个术语`,
    remedy:
      glossaryTerms.length === 0
        ? '用 `sdo_project action=update glossary={"术语":"定义"}` 补领域术语（G2 硬条件）'
        : undefined,
  })

  // C5：非目标已声明（G0/G2 共用硬条件）
  const nonGoals = input.project?.scope.out ?? []
  criteria.push({
    id: 'C5-non-goals',
    label: '非目标已显式声明（≥1 条）',
    ok: nonGoals.length > 0,
    detail: nonGoals.length === 0 ? '未声明非目标' : `已声明 ${nonGoals.length} 条`,
    remedy: nonGoals.length === 0 ? '用 `sdo_project action=update scopeOut=…` 补非目标（G0/G2 硬条件）' : undefined,
  })

  // C6：红队质询已执行或已显式停用（normal/critical 档默认要求；设计 §15.3 G2 / Q-03）
  const scale = input.project?.tailoring?.scale ?? 'normal'
  const redTeamRequired = scale !== 'trivial'
  const redTeamOk = !redTeamRequired || input.redTeamExecuted || input.redTeamDisabled
  criteria.push({
    id: 'C6-red-team',
    label: '红队质询已执行（或本会话已显式停用并留痕）',
    ok: redTeamOk,
    detail: !redTeamRequired
      ? '规模档为 trivial，默认不要求红队'
      : input.redTeamExecuted
        ? '已执行'
        : input.redTeamDisabled
          ? '本会话已停用（留痕）'
          : '未执行',
    remedy: redTeamOk ? undefined : '调用 `sdo_redteam action=attack` 跑一轮红队，或明确要求停用（会写 `redteam/mode` 留痕）',
  })

  // C7：人类签字（§15.3 G2 末条）
  const approved = (input.approvedBy ?? '').trim()
  criteria.push({
    id: 'C7-signoff',
    label: '人类签字',
    ok: approved !== '',
    detail: approved === '' ? '缺少签字人' : `签字人：${approved}`,
    remedy: approved === '' ? '基线时提供 `approvedBy`（人类签字；设计 §15.3 G2 要求）' : undefined,
  })

  const failed = criteria.filter((criterion) => !criterion.ok).map((criterion) => criterion.id)
  return { ok: failed.length === 0, criteria, failed }
}

/** 供状态块/看板使用：DoR 的一行摘要。 */
export function dorSummary(result: DorResult): string {
  if (result.ok) return 'DoR 通过'
  return `DoR 未通过（${result.failed.length} 条未满足：${result.failed.join(', ')}）`
}

/** 尚未达到阈值的需求（用于提示）。 */
export function belowThreshold(requirements: Requirement[]): Requirement[] {
  const model = loadScoring()
  return requirements.filter((requirement) => !meetsThreshold(requirement.ambiguity, model).ok)
}

/** 所有维度都有分的需求（便于自检）。 */
export function fullyScored(requirement: Requirement): boolean {
  return DIMENSIONS.every((dimension) => (requirement.ambiguity.dimensions[dimension] ?? 0) > 0)
}
