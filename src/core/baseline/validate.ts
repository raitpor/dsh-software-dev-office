/**
 * P15 校验实现（M1-3）。对外入口在 `index.ts`；本文件只做结构与规则计算。
 * `guarantee_delta` 由工具按目录保证元数据 + `docs/04` §6 有效绑定算出，文件里手写的 delta 被忽略。
 *
 * 结构错短路（P2-3）：解析层不合法 ⇒ 只出一个结构码（`stage_bad_kind` / `duplicate_gate_id` /
 * `invalid_baseline`），
 * 不产任何业务码/级联码，delta 三项统一 `degraded`（fail-closed）、不带 `missing`。
 * 业务码只在结构合法时出现。
 */

import { CRITERIA_CATALOG, CORE_CODES, appliesToKinds, catalogCodes, type CriterionMeta } from '../criteria/catalog.js';
import {
  evaluateCoreBinding,
  type Gate,
  type Policy,
  type Stage,
} from '../criteria/binding.js';
import { checkGraph } from './graph.js';
import {
  STAGE_KINDS,
  type BaselineReasonCode,
  type Guarantee, type GuaranteeDelta, type MissingCriterionGroup, type P15Result,
} from './types.js';

import { parse, type AnyRecord, type Parsed, type StructuralCode } from './parse.js';

const STRUCTURAL_DELTA: GuaranteeDelta = { 1: 'degraded', 2: 'degraded', 3: 'degraded' };

/** 结构错：只出该码、三项 degraded、无 `missing`（没有可信的判据级推导）。 */
function structuralFailure(code: StructuralCode): P15Result {
  return { ok: false, guarantee_delta: STRUCTURAL_DELTA, reason_codes: [code] };
}

function bindingPolicy(parsed: Parsed): Policy {
  const stages: Stage[] = parsed.stages.map((stage) => ({ id: stage.id, kinds: stage.kinds }));
  const gates: Gate[] = parsed.gateDefs.map((gate) => ({
    id: gate.id,
    stage: gate.stage,
    criteria: gate.criteria,
    policy_mode: gate.policy_mode,
    waivable: gate.waivable,
  }));
  return { stages, gates };
}

/**
 * 非 core 判据按 `docs/04` §6 的「存在一个合格 gate」判定（②–⑤ + 已注册）。
 * core 三条另按 §5.2 的检查点连续性走 `evaluateCoreBinding`（每适用 stage 出口都要有）。
 */
function boundSomewhere(meta: CriterionMeta, policy: Policy, registered: ReadonlySet<string>): boolean {
  if (!registered.has(meta.code)) return false;
  if (meta.applies_to.length === 0) return true;
  const applicableStageIds = new Set(policy.stages
    .filter((stage) => appliesToKinds(meta, stage.kinds))
    .map((stage) => stage.id));
  if (applicableStageIds.size === 0) return false;
  return policy.gates.some((gate) => gate.criteria.includes(meta.code)
    && gate.policy_mode === 'all_of'
    && !gate.waivable
    && applicableStageIds.has(gate.stage));
}

function guaranteeOf(meta: CriterionMeta): Guarantee | undefined {
  return meta.guarantee === '1' || meta.guarantee === '2' || meta.guarantee === '3'
    ? (Number(meta.guarantee) as Guarantee)
    : undefined;
}

function computeDelta(catalog: readonly CriterionMeta[], policy: Policy,
  registered: ReadonlySet<string>, reasonCodes: BaselineReasonCode[]): {
    guarantee_delta: GuaranteeDelta;
    missing: MissingCriterionGroup[];
  } {
  const input = { registered, policy };
  const core = new Map(evaluateCoreBinding(input).map((result) => [result.criterion_id, result.effective]));
  if ([...core.values()].some((effective) => !effective)) reasonCodes.push('core_not_effective');
  const missingIds: Record<Guarantee, string[]> = { 1: [], 2: [], 3: [] };
  for (const meta of catalog) {
    const guarantee = guaranteeOf(meta);
    if (guarantee === undefined) continue;
    const isCore = (CORE_CODES as readonly string[]).includes(meta.code);
    const effective = isCore ? (core.get(meta.code) ?? false) : boundSomewhere(meta, policy, registered);
    if (!effective) missingIds[guarantee].push(isCore ? `core:${meta.code}` : meta.code);
  }
  const delta: GuaranteeDelta = {
    1: missingIds[1].length > 0 ? 'degraded' : 'kept',
    2: missingIds[2].length > 0 ? 'degraded' : 'kept',
    3: missingIds[3].length > 0 ? 'degraded' : 'kept',
  };
  const missing: MissingCriterionGroup[] = [];
  for (const guarantee of [1, 2, 3] as const) {
    if (missingIds[guarantee].length > 0) {
      missing.push({ guarantee, criteria: [...missingIds[guarantee]] });
    }
  }
  return { guarantee_delta: delta, missing };
}

export function validateBaselineFile(input: AnyRecord): P15Result {
  const outcome = parse(input);
  if (!outcome.ok) return structuralFailure(outcome.structuralCode);
  const parsed = outcome.baseline;

  const reasonCodes: BaselineReasonCode[] = [];
  const unregistered: string[] = [];
  const registered = new Set<string>([...catalogCodes()]);
  const stageIds = new Set(parsed.stages.map((stage) => stage.id));

  if (!parsed.engineOk) reasonCodes.push('engine_missing');
  if (!parsed.reviewOk) reasonCodes.push('review_params_invalid');
  if (!parsed.artifactKindsOk) reasonCodes.push('artifact_kinds_incomplete');

  const graph = checkGraph(parsed.stages);
  if (graph.duplicateIds.length > 0) reasonCodes.push('stage_bad_kind');
  if (graph.missingEdges.length > 0 || graph.cycles.length > 0 || graph.unreachable.length > 0) {
    reasonCodes.push('stage_bad_after');
  }

  for (const [stageId, gateIds] of Object.entries(parsed.gatesByStage)) {
    if (!stageIds.has(stageId)) reasonCodes.push('stage_unknown');
    if (gateIds.length === 0) reasonCodes.push('stage_no_gate');
  }
  for (const stage of parsed.stages) {
    const bound = parsed.gatesByStage[stage.id] ?? [];
    if (bound.length === 0) { reasonCodes.push('stage_no_gate'); continue; }
    for (const gateId of bound) {
      const gate = parsed.gateDefs.find((candidate) => candidate.id === gateId);
      if (gate === undefined || gate.stage !== stage.id) reasonCodes.push('stage_no_gate');
    }
  }
  for (const gate of parsed.gateDefs) {
    if (!stageIds.has(gate.stage)) reasonCodes.push('stage_unknown');
    if (gate.criteria.length === 0) reasonCodes.push('gate_empty');
    for (const criterionId of gate.criteria) {
      if (registered.has(criterionId)) continue;
      reasonCodes.push('criterion_unregistered');
      unregistered.push(criterionId);
    }
  }

  // `na_stages` 已在解析层严格校验为合法 stage kind 数组（解析层 fail-closed），这里直接比较值。
  const declaredNa = new Set(parsed.naStages);
  const derivedNa = STAGE_KINDS.filter((kind) => !parsed.stages.some((stage) => stage.kinds.includes(kind)));
  const sameNa = declaredNa.size === derivedNa.length && derivedNa.every((kind) => declaredNa.has(kind));
  if (!sameNa) reasonCodes.push('na_stages_mismatch');

  const policy = bindingPolicy(parsed);
  const delta = computeDelta(CRITERIA_CATALOG, policy, registered, reasonCodes);

  const unique = [...new Set(reasonCodes)];
  return {
    ok: unique.length === 0,
    guarantee_delta: delta.guarantee_delta,
    reason_codes: unique,
    ...(delta.missing.length > 0 ? { missing: delta.missing } : {}),
    ...(unregistered.length > 0 ? { unregistered_criteria: [...new Set(unregistered)] } : {}),
  };
}
