/**
 * baseline JSON 的形状收窄（M1-3）：只在内存里把 unknown 收成结构化字段，不做 IO。
 *
 * 这里是**严格解析**：任何类型/枚举不合法都在解析层短路，不再“先过滤再判”——
 * 过滤会把 `kinds: ["requirement", "bogus"]`、`policy_mode: "ANY_OF"`、`waivable: "true"`、
 * `after: "req"`、`criteria: [123]` 这类非法输入悄悄收成安全值（fail-open）。
 *
 * 结构错的分工（P2-3）：
 * - `stage_bad_kind`：stage 形状错——id 空/非字符串、`kinds` 非数组/空/含非法 kind；
 * - `duplicate_gate_id`：`gates[]` 里出现重复 gate id（首条生效会含混，直接拒）；
 * - `invalid_baseline`：其余结构错——非对象（`index.ts`）、`stages` 非数组/为空、
 *   stage/gate 不是对象、`after` 非字符串数组、`gates` 非数组、`criteria` 非字符串数组、
 *   `policy_mode` 不在 `{all_of, any_of}`、`waivable` 非 boolean、`policy.gates` 不是
 *   stage→string[] 的映射、`assurance.na_stages` 不是合法 stage kind 的字符串数组。
 *
 * 优先级：generic 结构错（先 return）> stage 形状错 > 重复 gate id；形状坏的 stage 不再校验其 `after`。
 *
 * 两类都短路：调用方只拿到这一个码，业务码/级联码与 delta 都不产（见 `validate.ts`）。
 */

import { isStageKind, isStageKindList } from './types.js';
import type { BaselineGate, BaselineStage, KnownStageKind } from './types.js';

export type AnyRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is AnyRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export const asRecord = (value: unknown): AnyRecord => (isRecord(value) ? value : {});
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

export interface Parsed {
  readonly engineOk: boolean;
  readonly reviewOk: boolean;
  readonly artifactKindsOk: boolean;
  readonly stages: readonly BaselineStage[];
  readonly gateDefs: readonly BaselineGate[];
  readonly gatesByStage: Readonly<Record<string, readonly string[]>>;
  readonly naStages: readonly KnownStageKind[];
}

/**
 * 结构错时只回一个码：`stage_bad_kind`（stage 形状）/ `duplicate_gate_id`（gates[] 重复 id）/
 * `invalid_baseline`（其余结构）。三者都短路，不产业务码/级联码。
 */
export type StructuralCode = 'stage_bad_kind' | 'duplicate_gate_id' | 'invalid_baseline';

export type ParseOutcome =
  | { readonly ok: true; readonly baseline: Parsed }
  | { readonly ok: false; readonly structuralCode: StructuralCode };

const invalid = (): ParseOutcome => ({ ok: false, structuralCode: 'invalid_baseline' });

export function parse(input: AnyRecord): ParseOutcome {
  const policy = asRecord(input['policy']);
  const stageValues = policy['stages'];
  const gateValues = input['gates'];
  const gatesMapValue = policy['gates'];

  if (!Array.isArray(stageValues) || stageValues.length === 0) return invalid();
  if (!Array.isArray(gateValues)) return invalid();
  if (!isRecord(gatesMapValue)) return invalid();

  let stageShapeBad = false;
  const stages: BaselineStage[] = [];
  for (const raw of stageValues) {
    if (!isRecord(raw)) return invalid();
    const id = raw['id'];
    const kinds = raw['kinds'];
    if (!isNonEmptyString(id) || !isStageKindList(kinds)) {
      // stage 形状错优先：该 stage 的 `after` 不再校验，记下形状坏后继续扫其余 stage/gate；
      // 若别处另有 generic 结构错（非对象/类型不对等），以 invalid_baseline 为准（先 return）。
      stageShapeBad = true;
      continue;
    }
    const after = raw['after'];
    if (!Array.isArray(after) || !after.every(isNonEmptyString)) return invalid();
    stages.push({ id, kinds, after });
  }

  const gateDefs: BaselineGate[] = [];
  const gateIds = new Set<string>();
  let duplicateGateId = false;
  for (const raw of gateValues) {
    if (!isRecord(raw)) return invalid();
    const id = raw['id'];
    const stage = raw['stage'];
    const criteria = raw['criteria'];
    const policyMode = raw['policy_mode'];
    const waivable = raw['waivable'];
    if (!isNonEmptyString(id) || !isNonEmptyString(stage)) return invalid();
    if (!Array.isArray(criteria) || !criteria.every(isNonEmptyString)) return invalid();
    if (policyMode !== 'all_of' && policyMode !== 'any_of') return invalid();
    if (typeof waivable !== 'boolean') return invalid();
    if (gateIds.has(id)) duplicateGateId = true;
    gateIds.add(id);
    gateDefs.push({ id, stage, criteria, policy_mode: policyMode, waivable });
  }

  const gatesByStage: Record<string, readonly string[]> = {};
  for (const [stage, ids] of Object.entries(gatesMapValue)) {
    if (!Array.isArray(ids) || !ids.every(isNonEmptyString)) return invalid();
    gatesByStage[stage] = ids;
  }

  const naStages = asRecord(input['assurance'])['na_stages'];
  if (!Array.isArray(naStages) || !naStages.every(isStageKind)) return invalid();

  // 结构短路优先级：generic 结构错（上面已 return）> stage 形状错 > 重复 gate id。
  if (stageShapeBad) return { ok: false, structuralCode: 'stage_bad_kind' };
  if (duplicateGateId) return { ok: false, structuralCode: 'duplicate_gate_id' };

  const engine = asRecord(input['engine']);
  const review = asRecord(policy['review']);
  const sampleEvery = review['sample_every'];
  const sampleSeed = review['sample_seed'];
  return {
    ok: true,
    baseline: {
      engineOk: isNonEmptyString(engine['version'])
        && isNonEmptyString(engine['criteria_manifest_hash']),
      reviewOk: Number.isInteger(sampleEvery) && (sampleEvery as number) >= 2
        && (sampleEvery as number) <= 10 && Number.isInteger(sampleSeed),
      artifactKindsOk: hasArtifactKinds(policy['artifact_kinds']),
      stages,
      gateDefs,
      gatesByStage,
      naStages,
    },
  };
}

function hasArtifactKinds(value: unknown): boolean {
  const required = ['prototype', 'product', 'throwaway'];
  if (Array.isArray(value)) return required.every((kind) => value.includes(kind));
  const record = asRecord(value);
  return required.every((kind) => kind in record);
}
