/**
 * 冻结方向判定（M2-1 C5；`docs/04` §5.2 规则 2、`docs/06` §5）。
 *
 * 纯函数：只比较两份规范化 baseline 结构。判定集见 README「方向可判定子集」；
 * 无法归类的字段变化一律按**放宽**处理（A2，宁可严），并在 `undetermined[]` 里留证据。
 * 收紧可事后追认，放宽必须事前人签——所以“判不出来”不能猜成收紧。
 */

export interface DirectionBody {
  readonly stages: readonly { id: string; kinds: readonly string[] }[];
  readonly gates: readonly { id: string; stage: string; criteria: readonly string[]; policy_mode: string; waivable: boolean }[];
  readonly gatesByStage: Readonly<Record<string, readonly string[]>>;
  readonly criteria: readonly string[];
  readonly thresholds: Readonly<Record<string, unknown>>;
  readonly assurance: Readonly<Record<string, unknown>>;
  readonly artifactKinds: readonly string[];
  readonly sampleEvery: number | null;
  readonly engineVersion: string;
  readonly criteriaManifestHash: string;
}

export type FreezeDirection = 'initial' | 'tighten' | 'loosen' | 'unchanged';

export interface DirectionVerdict {
  readonly direction: FreezeDirection;
  readonly tighten: readonly string[];
  readonly loosen: readonly string[];
  readonly undetermined: readonly string[];
}

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function criterionValues(gate: DirectionBody['gates'][number]): Set<string> {
  return new Set(gate.criteria);
}

/** 阈值：数值升高=收紧、降低=放宽；非数值或类型变化记为不可判定。 */
function compareThresholds(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  tighten: string[],
  loosen: string[],
  undetermined: string[],
): void {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (typeof a === 'number' && typeof b === 'number') {
      (b > a ? tighten : loosen).push(`thresholds.${key}`);
      continue;
    }
    undetermined.push(`thresholds.${key}`);
  }
}

export function classifyDirection(before: DirectionBody | null, after: DirectionBody): DirectionVerdict {
  if (before === null) {
    return { direction: 'initial', tighten: [], loosen: [], undetermined: [] };
  }
  const tighten: string[] = [];
  const loosen: string[] = [];
  const undetermined: string[] = [];

  const beforeGates = new Map(before.gates.map((gate) => [gate.id, gate]));
  for (const gate of after.gates) {
    const old = beforeGates.get(gate.id);
    if (old === undefined) {
      tighten.push(`gates.${gate.id} 新增`);
      continue;
    }
    beforeGates.delete(gate.id);
    const oldCriteria = criterionValues(old);
    const newCriteria = criterionValues({ ...gate, criteria: gate.criteria });
    for (const code of newCriteria) if (!oldCriteria.has(code)) tighten.push(`gates.${gate.id}.criteria.${code} 新增`);
    for (const code of oldCriteria) if (!newCriteria.has(code)) loosen.push(`gates.${gate.id}.criteria.${code} 删除`);
    if (old.policy_mode !== gate.policy_mode) {
      if (gate.policy_mode === 'all_of') tighten.push(`gates.${gate.id}.policy_mode -> all_of`);
      else loosen.push(`gates.${gate.id}.policy_mode -> ${gate.policy_mode}`);
    }
    if (old.waivable !== gate.waivable) {
      (gate.waivable ? loosen : tighten).push(`gates.${gate.id}.waivable=${String(gate.waivable)}`);
    }
    if (old.stage !== gate.stage) undetermined.push(`gates.${gate.id}.stage`);
  }
  for (const id of beforeGates.keys()) loosen.push(`gates.${id} 删除`);

  const oldStages = new Map(before.stages.map((stage) => [stage.id, stage]));
  for (const stage of after.stages) {
    const old = oldStages.get(stage.id);
    if (old === undefined) {
      tighten.push(`stages.${stage.id} 新增`);
      continue;
    }
    oldStages.delete(stage.id);
    const oldKinds = new Set(old.kinds);
    const newKinds = new Set(stage.kinds);
    for (const kind of newKinds) if (!oldKinds.has(kind)) tighten.push(`stages.${stage.id}.kinds.${kind} 新增`);
    for (const kind of oldKinds) if (!newKinds.has(kind)) loosen.push(`stages.${stage.id}.kinds.${kind} 删除`);
  }
  for (const id of oldStages.keys()) loosen.push(`stages.${id} 删除`);

  const oldCriteria = new Set(before.criteria);
  const newCriteria = new Set(after.criteria);
  for (const code of newCriteria) if (!oldCriteria.has(code)) tighten.push(`criteria.${code} 新增`);
  for (const code of oldCriteria) if (!newCriteria.has(code)) loosen.push(`criteria.${code} 删除`);

  compareThresholds(before.thresholds, after.thresholds, tighten, loosen, undetermined);

  const oldNa = new Set(asStringArray(before.assurance['na_stages']));
  const newNa = new Set(asStringArray(after.assurance['na_stages']));
  for (const stage of newNa) if (!oldNa.has(stage)) loosen.push(`assurance.na_stages.${stage} 转 na`);
  for (const stage of oldNa) if (!newNa.has(stage)) tighten.push(`assurance.na_stages.${stage} 取消 na`);

  for (const key of Object.keys(before.assurance)) {
    const a = before.assurance[key];
    const b = after.assurance[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (key === 'db_confidentiality' && typeof a === 'boolean' && typeof b === 'boolean') {
      (b ? tighten : loosen).push(`assurance.${key}`);
    } else if (key !== 'na_stages') {
      undetermined.push(`assurance.${key}`);
    }
  }
  for (const key of Object.keys(after.assurance)) {
    if (!(key in before.assurance) && key !== 'na_stages') undetermined.push(`assurance.${key} 新增`);
  }

  const oldArtifacts = new Set(before.artifactKinds);
  const newArtifacts = new Set(after.artifactKinds);
  for (const kind of newArtifacts) if (!oldArtifacts.has(kind)) tighten.push(`policy.artifact_kinds.${kind} 新增`);
  for (const kind of oldArtifacts) if (!newArtifacts.has(kind)) loosen.push(`policy.artifact_kinds.${kind} 删除`);

  if (before.sampleEvery !== after.sampleEvery) {
    if (before.sampleEvery !== null && after.sampleEvery !== null) {
      (after.sampleEvery < before.sampleEvery ? tighten : loosen).push('policy.review.sample_every');
    } else undetermined.push('policy.review.sample_every');
  }
  if (before.engineVersion !== after.engineVersion) undetermined.push('engine.version');
  if (before.criteriaManifestHash !== after.criteriaManifestHash) undetermined.push('engine.criteria_manifest_hash');

  const direction: FreezeDirection = loosen.length > 0 || undetermined.length > 0 ? 'loosen' : tighten.length > 0 ? 'tighten' : 'unchanged';
  return { direction, tighten, loosen, undetermined };
}
