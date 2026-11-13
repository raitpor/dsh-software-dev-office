/**
 * 有效绑定（M1-1 / C4–C7）。真源：`docs/04` §6「有效绑定」五条件：
 * ① 已注册；② 某 gate 的 `criteria[]` 含它；③ 该 gate 的 stage 与 `applies_to` 有交集；
 * ④ `policy_mode='all_of'`；⑤ `waivable=false`。缺任一 ⇒ 不算被查（`core_not_effective`）。
 *
 * 本卡额外要求「检查点不连续」可见（C6）：某 stage 的 `kinds` 与判据 `applies_to` 相交，
 * 却没有一个合格 gate 在该 stage 出口绑它 ⇒ `stage_gap`。
 *
 * 这里**只有结构**：不读 `assurance.guarantee_delta`，也不接受任何"降级声明"入参——
 * C7 的“core 没有后门”靠 API 形状保证（M1-3 的 P15 只消费本模块结果）。
 */

import {
  CORE_CODES,
  criterionMeta,
  appliesToKinds,
  type CoreCode,
  type StageKind,
} from './catalog.js';

export type PolicyMode = 'all_of' | 'any_of';

export interface Gate {
  readonly id: string;
  readonly stage: string;
  readonly criteria: readonly string[];
  readonly policy_mode: PolicyMode;
  readonly waivable: boolean;
}

export interface Stage {
  readonly id: string;
  readonly kinds: readonly StageKind[];
}

export interface Policy {
  readonly stages: readonly Stage[];
  readonly gates: readonly Gate[];
}

export type BindingReason =
  | 'not_registered'
  | 'not_in_gate'
  | 'stage_not_applicable'
  | 'policy_mode_any_of'
  | 'waivable_gate'
  | 'stage_gap'
  | 'missing_required_kind'
  | 'invalid_policy';

export interface BindingResult {
  readonly criterion_id: string;
  readonly effective: boolean;
  readonly reasons: readonly BindingReason[];
}

export interface BindingInput {
  readonly registered: ReadonlySet<string> | readonly string[];
  readonly policy: Policy;
}

function registeredSet(input: BindingInput): ReadonlySet<string> {
  return input.registered instanceof Set ? input.registered : new Set(input.registered);
}

function uniq(reasons: BindingReason[]): BindingReason[] {
  return [...new Set(reasons)];
}

/**
 * P1-1 结构性前置：lite preset 可以缺 design/review，但**不能缺 requirement**——
 * 否则 `spec_set.signed` 无处可绑。该规则立在本层（不动 catalog 的 `applies_to`），
 * 并导出给 M1-3 的 P15 复用。
 */
export function policyHasRequirementKind(policy: Policy): boolean {
  return Array.isArray(policy.stages)
    && policy.stages.some((stage) => Array.isArray(stage.kinds) && stage.kinds.includes('requirement'));
}

function isPolicyShaped(policy: Policy): boolean {
  if (!Array.isArray(policy.stages) || !Array.isArray(policy.gates)) return false;
  return policy.stages.every((stage) => stage !== null && typeof stage === 'object'
    && typeof stage.id === 'string' && Array.isArray(stage.kinds))
    && policy.gates.every((gate) => gate !== null && typeof gate === 'object'
      && typeof gate.id === 'string' && typeof gate.stage === 'string'
      && Array.isArray(gate.criteria));
}

/** 单条判据的有效绑定判定；未知 code 视为未注册（调用方应先过目录）。 */
export function evaluateBinding(criterionId: string, input: BindingInput): BindingResult {
  if (!isPolicyShaped(input.policy)) {
    return { criterion_id: criterionId, effective: false, reasons: ['invalid_policy'] };
  }
  const meta = criterionMeta(criterionId);
  if (meta === undefined) {
    return { criterion_id: criterionId, effective: false, reasons: ['not_registered'] };
  }
  if (!registeredSet(input).has(criterionId)) {
    return { criterion_id: criterionId, effective: false, reasons: ['not_registered'] };
  }
  // 表约束型判据（applies_to=[]）永远生效、不绑 gate，不参与 core_not_effective（P2-2）。
  if (meta.applies_to.length === 0) {
    return { criterion_id: criterionId, effective: true, reasons: [] };
  }

  const applicableStages = input.policy.stages.filter((stage) => appliesToKinds(meta, stage.kinds));
  if (applicableStages.length === 0) {
    return { criterion_id: criterionId, effective: false, reasons: ['stage_not_applicable'] };
  }

  const gatesForCriterion = input.policy.gates.filter((gate) => gate.criteria.includes(criterionId));
  if (gatesForCriterion.length === 0) {
    return { criterion_id: criterionId, effective: false, reasons: ['not_in_gate'] };
  }

  const reasons: BindingReason[] = [];
  for (const stage of applicableStages) {
    const gatesAtStage = gatesForCriterion.filter((gate) => gate.stage === stage.id);
    const qualifying = gatesAtStage.filter((gate) => gate.policy_mode === 'all_of' && !gate.waivable);
    if (qualifying.length > 0) continue;
    if (gatesAtStage.length === 0) {
      reasons.push('stage_gap');
      continue;
    }
    for (const gate of gatesAtStage) {
      if (gate.policy_mode === 'any_of') reasons.push('policy_mode_any_of');
      if (gate.waivable) reasons.push('waivable_gate');
    }
  }

  const unique = uniq(reasons);
  return { criterion_id: criterionId, effective: unique.length === 0, reasons: unique };
}

/** 仅对 core 三条算（C4）；其余 21 条“未实现”不参与拒绝。 */
export function evaluateCoreBinding(input: BindingInput): readonly BindingResult[] {
  // P1-1：结构性前置先于逐条绑定——没有 requirement stage 的 policy，三条 core 全不算生效。
  if (!isPolicyShaped(input.policy)) {
    return CORE_CODES.map((code: CoreCode) => ({ criterion_id: code, effective: false, reasons: ['invalid_policy'] }));
  }
  if (!policyHasRequirementKind(input.policy)) {
    return CORE_CODES.map((code: CoreCode) => ({ criterion_id: code, effective: false, reasons: ['missing_required_kind'] }));
  }
  return CORE_CODES.map((code: CoreCode) => evaluateBinding(code, input));
}

export function coreEffectiveCount(input: BindingInput): number {
  return evaluateCoreBinding(input).filter((result) => result.effective).length;
}
