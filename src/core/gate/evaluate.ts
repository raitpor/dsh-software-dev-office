/**
 * M2-2 判定求值（纯函数）：从**已冻结 baseline 行**取 stage/gate 结构，
 * 逐判据现算有效绑定（复用 M1-1 `evaluateBinding`，不抄 P15），再给三态。
 *
 * 分层（卡 A2）：本模块在 `src/core/`，不依赖 `src/db/`、`src/check/`。
 * M2 现阶段判据三态覆盖 core 三条；其余目录判据记 `na`（M3 补求值器），
 * 但都要先过有效绑定；core 三条未生效一律 fail（C7 无后门）。
 */
import type { FoldState, Row } from '../fold/types.js';
import { CORE_CODES, catalogCodes, type StageKind } from '../criteria/catalog.js';
import { evaluateBinding, evaluateCoreBinding, policyHasRequirementKind, type Policy } from '../criteria/binding.js';
import type { GateEvaluation, GateReading, GateReadingReasonCode, GateReadingVerdict, GateVerdict } from './types.js';
import {
  assumptionCoverageMissing,
  coveredSpecIdsOfSigned,
  validateAssumptionStatuses,
} from '../assumption/index.js';

export interface BaselineRowLike {
  readonly id: string;
  readonly hash: string;
  readonly policy: unknown;
  /** baseline 文件/行的 gate 定义数组（`policy.gates` 是 stage→gate_ids 的索引）。 */
  readonly gates?: unknown;
}

const CORE_SET = new Set<string>(CORE_CODES);

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** baseline 行里的 policy JSON → M1-1 的 `Policy`（结构照抄，不再解释）。 */
export function policyFromBaseline(policy: unknown, gateDefs?: unknown): Policy {
  const record = (policy !== null && typeof policy === 'object' ? policy : {}) as Record<string, unknown>;
  const stages = asRows(record['stages']).map((stage) => ({
    id: textOf(stage['id']),
    kinds: asRows(stage['kinds']).map(textOf) as readonly StageKind[],
  }));
  const sourceGates = Array.isArray(gateDefs) ? gateDefs : asRows(record['gates']);
  const gates = asRows(sourceGates).map((gate) => ({
    id: textOf(gate['id']),
    stage: textOf(gate['stage']),
    criteria: asRows(gate['criteria']).map(textOf),
    policy_mode: (gate['policy_mode'] === 'any_of' ? 'any_of' : 'all_of') as 'all_of' | 'any_of',
    waivable: gate['waivable'] === true,
  }));
  return { stages, gates };
}

/** 已注册判据 = 目录 codes ∪ `criterion` 表行 id（M1-1 口径）。 */
export function registeredCriteria(state: FoldState): ReadonlySet<string> {
  const ids = new Set<string>(catalogCodes());
  for (const row of Object.values(state.tables.criterion)) ids.add(String(row['id']));
  return ids;
}

function signedDecision(state: FoldState, kind: string): readonly Row[] {
  return Object.values(state.tables.decision).filter(
    (row) => row['decision_kind'] === kind && row['status'] === 'valid' && textOf(row['signature']).length > 0,
  );
}

function coveredSpecIds(state: FoldState, kind: string): readonly string[] {
  // P3-③（第 2 轮）：与 check 共用同一个覆盖实现，不再自算。
  return coveredSpecIdsOfSigned(state, kind);
}

function coreVerdict(state: FoldState, code: string): GateReadingVerdict {
  switch (code) {
    case 'spec_set.signed': {
      const decisions = signedDecision(state, 'spec_set');
      if (decisions.length === 0 || !decisions.some((row) => textOf(row['frontier']).length > 0)) return 'fail';
      const requirements = Object.values(state.tables.spec).filter(
        (row) => row['kind'] === 'requirement' && String(row['status'] ?? '') !== 'rejected',
      );
      if (requirements.length === 0) return 'fail';
      const covered = new Set(coveredSpecIds(state, 'spec_set'));
      return requirements.every((row) => covered.has(String(row['id']))) ? 'pass' : 'fail';
    }
    case 'assumption_set.signed': {
      const decisions = signedDecision(state, 'assumption_set');
      if (decisions.length === 0 || !decisions.some((row) => textOf(row['frontier']).length > 0)) return 'fail';
      if (validateAssumptionStatuses(state).length > 0) return 'fail';
      const covered = new Set(coveredSpecIds(state, 'assumption_set'));
      return assumptionCoverageMissing(state, covered).length === 0 ? 'pass' : 'fail';
    }
    case 'provenance.present': {
      const createdBy = (row: Row): boolean =>
        textOf(row['created_by']).length > 0 || textOf(row['producer']).length > 0;
      const tasks = Object.values(state.tables.task);
      const specs = Object.values(state.tables.spec);
      return tasks.every(createdBy) && specs.every(createdBy) ? 'pass' : 'fail';
    }
    default:
      return 'na';
  }
}

/** 判定一个 stage 出口（纯函数）。stage 不在 baseline ⇒ `na/stage_unknown`。 */
export function evaluateStageGate(state: FoldState, baseline: BaselineRowLike, stage: string): GateEvaluation {
  const policy = policyFromBaseline(baseline.policy, baseline.gates);
  const registered = registeredCriteria(state);
  const stageDef = policy.stages.find((candidate) => candidate.id === stage);
  if (stageDef === undefined) {
    return { stage, baseline_hash: baseline.hash, gate_ids: [], verdict: 'na', readings: [], reasons: ['stage_unknown'] };
  }
  const gates = policy.gates.filter((gate) => gate.stage === stage);
  if (gates.length === 0) {
    return { stage, baseline_hash: baseline.hash, gate_ids: [], verdict: 'changes_requested', readings: [], reasons: ['gate_empty'] };
  }
  if (gates.length > 1) {
    // M2 只支持每 stage 单 gate；全量记录 gate_ids 但结构化拒，M3 再补多 gate 聚合。
    return {
      stage,
      baseline_hash: baseline.hash,
      gate_ids: gates.map((gate) => gate.id),
      verdict: 'changes_requested',
      readings: [],
      reasons: ['multiple_gates_unsupported'],
    };
  }

  const reasons: string[] = [];
  if (!policyHasRequirementKind(policy)) reasons.push('core_not_effective');
  const coreBindings = evaluateCoreBinding({ policy, registered });
  const coreBound = coreBindings.every((binding) => binding.effective);
  if (!coreBound) reasons.push('core_not_effective');

  const readings: GateReading[] = [];
  for (const gate of gates) {
    for (const criterionId of gate.criteria) {
      if (readings.some((reading) => reading.criterion_id === criterionId)) continue;
      const binding = evaluateBinding(criterionId, { registered, policy });
      const isCore = CORE_SET.has(criterionId);
      const structurallyReady = gate.policy_mode === 'all_of' && !gate.waivable;
      const effective = structurallyReady && binding.effective;
      let verdict: GateReadingVerdict;
      let reasonCode: GateReadingReasonCode;
      const codeReasons: string[] = [...binding.reasons];
      if (!structurallyReady) {
        verdict = 'na';
        reasonCode = 'not_enforced_in_m2';
        codeReasons.push(gate.policy_mode === 'any_of' ? 'policy_mode_any_of' : 'waivable_gate');
      } else if (!binding.effective) {
        verdict = isCore ? 'fail' : 'na';
        reasonCode = isCore ? 'core_not_effective' : 'not_enforced_in_m2';
        codeReasons.push('criterion_not_effective');
      } else if (isCore) {
        verdict = coreVerdict(state, criterionId);
        reasonCode = verdict === 'pass' ? 'checked' : 'core_not_effective';
        codeReasons.push(verdict === 'pass' ? 'checked' : 'core_not_effective');
      } else {
        verdict = 'na';
        reasonCode = 'not_enforced_in_m2';
        codeReasons.push('not_enforced_in_m2');
      }
      readings.push({
        criterion_id: criterionId,
        verdict,
        reason_code: reasonCode,
        effective,
        binding_reasons: binding.reasons,
        reasons: codeReasons,
      });
    }
  }

  const coreReadings = readings.filter((reading) => CORE_SET.has(reading.criterion_id));
  const coreFails = CORE_CODES.some((code) => {
    const reading = coreReadings.find((candidate) => candidate.criterion_id === code);
    return reading === undefined || reading.verdict !== 'pass';
  });
  const anyCorePass = coreReadings.some((reading) => reading.verdict === 'pass');
  if (coreFails || !coreBound) reasons.push('core_not_effective');
  const hasFail = readings.some((reading) => reading.verdict === 'fail') || coreFails || !coreBound;
  const hasPass = anyCorePass;
  const verdict: GateVerdict = hasFail ? 'changes_requested' : hasPass ? 'pass' : 'na';
  return {
    stage,
    baseline_hash: baseline.hash,
    gate_ids: gates.map((gate) => gate.id),
    verdict,
    readings,
    reasons: [...new Set(reasons)],
  };
}
