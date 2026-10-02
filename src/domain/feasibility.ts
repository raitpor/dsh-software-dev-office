/**
 * 可行性评估（设计 §2.1 的 TELOS 框架 / §9.1 的 `sdo_feasibility(action=assess)`）。
 *
 * 产物：`.sdo/feasibility.yml`（一条评估） + `feasibility/assessed` 事件。
 * 门禁 G1 直接读它：结论必须是 `go`，且必须登记风险并给出 PoC 建议。
 */
import type { Journal } from '../infra/journal.js'
import { pushShapeNote, recordOf, textListOf, textOf, typeNameOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
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

/**
 * 读可行性评估并**做形状归一化**（F-21 ①）。
 *
 * `.sdo/feasibility.yml` 是手可编辑真源，两个容器位置：
 * `telos`（五维映射，每个维度是 `{verdict, rationale}` 映射）与 `poc`（列表）。
 * 旧实现 `assessment.telos[dimension].verdict` 在 `telos: 技术可行` 这类手写下抛
 * `Cannot read properties of undefined`；`poc.join` 同理。口径：
 *   · 标量写在列表位置 → 单元素 + 提示；映射写在列表位置 / 任何东西写在映射位置 → 空 + 提示；
 *   · `telos` 缺失的维度补成空映射（**不猜**内容），判据与回执照旧能读。
 */
export function readFeasibilityChecked(
  store: SdoStore,
): { assessment: FeasibilityAssessment | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ feasibility: unknown }>(FEASIBILITY_FILE)?.feasibility
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) {
      pushShapeNote(notes, 'feasibility', FEASIBILITY_FILE, 'feasibility', {
        position: 'map',
        actualType: typeNameOf(raw),
        handling: 'empty',
        text: textOf(raw),
      })
    }
    return { assessment: undefined, notes }
  }
  const record = raw as Record<string, unknown>
  const telosRaw = recordOf(record.telos)
  pushShapeNote(notes, 'feasibility', FEASIBILITY_FILE, 'telos', telosRaw.issue)
  const telos = {} as FeasibilityAssessment['telos']
  for (const dimension of TELOS_DIMENSIONS) {
    const entry = recordOf(telosRaw.value[dimension])
    pushShapeNote(notes, 'feasibility', FEASIBILITY_FILE, `telos.${dimension}`, entry.issue)
    telos[dimension] = { verdict: textOf(entry.value['verdict']), rationale: textOf(entry.value['rationale']) }
  }
  const poc = textListOf(record.poc)
  pushShapeNote(notes, 'feasibility', FEASIBILITY_FILE, 'poc', poc.issue)
  const assessment: FeasibilityAssessment = {
    ...(record as unknown as FeasibilityAssessment),
    id: textOf(record.id),
    at: textOf(record.at),
    by: textOf(record.by),
    telos,
    verdict: textOf(record.verdict) as FeasibilityAssessment['verdict'],
    rationale: textOf(record.rationale),
    poc: poc.value,
  }
  return { assessment, notes }
}

export function readFeasibility(store: SdoStore): FeasibilityAssessment | undefined {
  return readFeasibilityChecked(store).assessment
}

/** 可行性评估上的形状提示（回执 / 只读视图 / 门禁详情共用）。 */
export function feasibilityShapeNotes(store: SdoStore): FieldShapeNote[] {
  return readFeasibilityChecked(store).notes
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
