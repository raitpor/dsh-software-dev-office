/**
 * 可行性评估（设计 §2.1 的 TELOS 框架 / §9.1 的 `sdo_feasibility(action=assess)`）。
 *
 * 产物：`.sdo/feasibility.yml`（一条评估） + `feasibility/assessed` 事件。
 * 门禁 G1 直接读它：结论必须是 `go`，且必须登记风险并给出 PoC 建议。
 */
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { FeasibilityAssessment } from '../types.js'

export const FEASIBILITY_FILE = 'feasibility.yml'

/** TELOS 五个维度。 */
export const TELOS_DIMENSIONS = ['technical', 'economic', 'legal', 'operational', 'schedule'] as const
export type TelosDimension = (typeof TELOS_DIMENSIONS)[number]

/** 维度中文名（展示用）。 */
export const TELOS_LABEL: Record<TelosDimension, string> = {
  technical: '技术',
  economic: '经济',
  legal: '法律/合规',
  operational: '运营',
  schedule: '进度',
}

export function readFeasibility(store: SdoStore): FeasibilityAssessment | undefined {
  return store.readYaml<{ feasibility: FeasibilityAssessment }>(FEASIBILITY_FILE)?.feasibility
}

export function writeFeasibility(store: SdoStore, assessment: FeasibilityAssessment): void {
  store.writeYaml([FEASIBILITY_FILE], { feasibility: assessment })
}

export interface AssessInput {
  telos?: Partial<Record<TelosDimension, { verdict: string; rationale: string }>> | undefined
  verdict: FeasibilityAssessment['verdict']
  rationale: string
  poc?: string[] | undefined
}

/** 记录一次可行性评估（覆盖式：一个项目一条当前评估，历史在 journal 里）。 */
export function assess(store: SdoStore, journal: Journal, input: AssessInput, by: string): FeasibilityAssessment {
  const previous = readFeasibility(store)
  const telos = {} as FeasibilityAssessment['telos']
  for (const dimension of TELOS_DIMENSIONS) {
    const given = input.telos?.[dimension]
    const fallback = previous?.telos[dimension]
    telos[dimension] = {
      verdict: given?.verdict ?? fallback?.verdict ?? '未评估',
      rationale: given?.rationale ?? fallback?.rationale ?? '',
    }
  }
  const assessment: FeasibilityAssessment = {
    id: previous?.id ?? 'FEAS-001',
    at: new Date().toISOString(),
    by,
    telos,
    verdict: input.verdict,
    rationale: input.rationale,
    poc: input.poc ?? previous?.poc ?? [],
  }
  writeFeasibility(store, assessment)
  journal.append('feasibility/assessed', {
    verdict: assessment.verdict,
    by,
    poc: assessment.poc.length,
  })
  return assessment
}

/** 未评估的维度（展示用）。 */
export function unevaluatedDimensions(assessment: FeasibilityAssessment | undefined): TelosDimension[] {
  if (assessment === undefined) return [...TELOS_DIMENSIONS]
  return TELOS_DIMENSIONS.filter((dimension) => assessment.telos[dimension].verdict === '未评估')
}
