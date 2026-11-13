/**
 * 判据目录快照（M1-1 / C1）。真源：`docs/04` §4（24 条阶段判据的「保证」列）与 §4.1（`applies_to` 列）。
 *
 * `guarantee`/`applies_to` 是**判据 code 的目录属性**，不是项目侧可填字段（D-026）：
 * `criterion` 表只有 `id/spec_id/kind/status_enum/remedy`，这里只读快照，不落库、不加列。
 * 本文件不依赖 DB，M1-3（P15）与 M1-4（sdo_check）可直接 import。
 */

export const STAGE_KINDS = ['requirement', 'design', 'implement', 'review', 'deliver'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];

export type Guarantee = '1' | '2' | '3' | '—';

export interface CriterionMeta {
  readonly code: string;
  readonly guarantee: Guarantee;
  /** 空数组 = 表约束型判据（`work_unit.evidence_consistent`），永远生效、不绑 gate。 */
  readonly applies_to: readonly StageKind[];
}

/** M1 只强制这三条（docs/04 §6 的 `core_not_effective`）；其余 21 条实现前按 `na` 处理。 */
export const CORE_CODES = ['spec_set.signed', 'assumption_set.signed', 'provenance.present'] as const;
export type CoreCode = (typeof CORE_CODES)[number];

const ALL_KINDS: readonly StageKind[] = STAGE_KINDS;

/**
 * 24 条快照。逐项与 `docs/04` §4 表格的「保证」列、§4.1 表格的「applies_to」列对应；
 * `work_unit.evidence_consistent` 在 §4.1 没有行：它是表约束型判据，不绑 gate（`applies_to=[]`）。
 * 改动本数组必须同步 `docs/04`（C1 的解析测试会红）。
 */
export const CRITERIA_CATALOG: readonly CriterionMeta[] = [
  { code: 'stage.requirement_complete', guarantee: '1', applies_to: ['requirement'] },
  { code: 'stage.design_traceable', guarantee: '1', applies_to: ['design'] },
  { code: 'design.covers_spec', guarantee: '1', applies_to: ['design'] },
  { code: 'design.no_spec_creep', guarantee: '1', applies_to: ['design'] },
  { code: 'intent.restated_consistent', guarantee: '1', applies_to: ['requirement'] },
  { code: 'work_unit.evidence_consistent', guarantee: '—', applies_to: [] },
  { code: 'node.acceptance_bound', guarantee: '1', applies_to: ['design'] },
  { code: 'node.integration_listed', guarantee: '1', applies_to: ['deliver'] },
  { code: 'intent.explicit_for_risk', guarantee: '1', applies_to: ['requirement'] },
  { code: 'mandate.revalidated', guarantee: '1', applies_to: ['implement', 'deliver'] },
  { code: 'provenance.present', guarantee: '3', applies_to: ALL_KINDS },
  { code: 'scope.present', guarantee: '1', applies_to: ['requirement'] },
  { code: 'redteam.disposed', guarantee: '2', applies_to: ['requirement'] },
  { code: 'review.round_bound', guarantee: '3', applies_to: ['review'] },
  { code: 'spec_set.signed', guarantee: '1', applies_to: ALL_KINDS },
  { code: 'design.code_matches', guarantee: '3', applies_to: ['implement', 'deliver'] },
  { code: 'stage.gate_bound', guarantee: '—', applies_to: ALL_KINDS },
  { code: 'task.complete', guarantee: '3', applies_to: ['implement'] },
  { code: 'review.required', guarantee: '3', applies_to: ['review', 'implement'] },
  { code: 'design.alternatives_declared', guarantee: '2', applies_to: ['design'] },
  { code: 'alignment.examples_present', guarantee: '1', applies_to: ['requirement'] },
  { code: 'change.rework_counted', guarantee: '—', applies_to: ALL_KINDS },
  { code: 'assumption.disposed', guarantee: '2', applies_to: ['implement'] },
  { code: 'assumption_set.signed', guarantee: '2', applies_to: ALL_KINDS },
];

const BY_CODE: ReadonlyMap<string, CriterionMeta> = new Map(
  CRITERIA_CATALOG.map((meta) => [meta.code, meta] as const),
);

export function isStageKind(value: unknown): value is StageKind {
  return typeof value === 'string' && (STAGE_KINDS as readonly string[]).includes(value);
}

export function isGuarantee(value: unknown): value is Guarantee {
  return value === '1' || value === '2' || value === '3' || value === '—';
}

export function criterionMeta(code: string): CriterionMeta | undefined {
  return BY_CODE.get(code);
}

export function isCoreCriterion(code: string): code is CoreCode {
  return (CORE_CODES as readonly string[]).includes(code);
}

export function catalogCodes(): readonly string[] {
  return CRITERIA_CATALOG.map((meta) => meta.code);
}

/** 判据在该 stage `kinds` 集合上是否适用（`applies_to=[]` 的表约束型永远返回 false）。 */
export function appliesToKinds(meta: CriterionMeta, kinds: readonly StageKind[]): boolean {
  return meta.applies_to.some((kind) => kinds.includes(kind));
}
