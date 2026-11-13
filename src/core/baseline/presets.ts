/**
 * 三个内置 preset（`docs/08` §1 的 stage DAG + §1.1 的 gate 目录）。
 * preset 只是把字段填好的一组初始值；P15 校验的是字段，不是 preset 名。
 * `lite` 是 policy 档而不是 preset 键，示例在 `test/fixtures/baseline/lite.policy.json`。
 */

import type { BaselineGate, BaselineStage, KnownStageKind } from './types.js';

export type PresetId = 'waterfall' | 'prototype' | 'incremental';

export interface Preset {
  readonly id: PresetId;
  readonly stages: readonly BaselineStage[];
  /** stage id → gate id；`gateDefs` 是 gate 实体。 */
  readonly gates: Readonly<Record<string, readonly string[]>>;
  readonly gateDefs: readonly BaselineGate[];
}

const G = (id: string, stage: string, criteria: readonly string[]): BaselineGate => ({
  id,
  stage,
  criteria,
  policy_mode: 'all_of',
  waivable: false,
});

const S = (id: string, kinds: readonly KnownStageKind[], after: readonly string[]): BaselineStage => ({
  id,
  kinds,
  after,
});

const CORE = ['spec_set.signed', 'assumption_set.signed', 'provenance.present'] as const;

const WATERFALL_STAGES: readonly BaselineStage[] = [
  S('req', ['requirement'], []),
  S('design', ['design'], ['req']),
  S('build', ['implement'], ['design']),
  S('verify', ['review'], ['build']),
  S('deliver', ['deliver'], ['verify']),
];

const WATERFALL_GATES: readonly BaselineGate[] = [
  G('G_req_exit', 'req', ['stage.requirement_complete', 'intent.restated_consistent',
    'alignment.examples_present', 'scope.present', 'intent.explicit_for_risk',
    'redteam.disposed', ...CORE]),
  G('G_design_exit', 'design', ['stage.design_traceable', 'design.covers_spec',
    'design.no_spec_creep', 'design.alternatives_declared', 'node.acceptance_bound', ...CORE]),
  G('G_build_exit', 'build', ['task.complete', 'assumption.disposed', 'mandate.revalidated', ...CORE]),
  G('G_verify_exit', 'verify', ['review.round_bound', 'review.required', ...CORE]),
  G('G_deliver_exit', 'deliver', ['design.code_matches', 'node.integration_listed',
    'mandate.revalidated', ...CORE]),
];

const PROTOTYPE_STAGES: readonly BaselineStage[] = [
  S('explore', ['implement'], []),
  S('harden', ['requirement', 'design', 'implement', 'review'], ['explore']),
  S('deliver', ['deliver'], ['harden']),
];

const PROTOTYPE_GATES: readonly BaselineGate[] = [
  G('G_explore_exit', 'explore', ['task.complete', ...CORE]),
  G('G_harden_exit', 'harden', ['stage.requirement_complete', 'intent.restated_consistent',
    'alignment.examples_present', 'scope.present', 'intent.explicit_for_risk', 'redteam.disposed',
    'stage.design_traceable', 'design.covers_spec', 'design.no_spec_creep',
    'design.alternatives_declared', 'node.acceptance_bound', 'task.complete',
    'assumption.disposed', 'mandate.revalidated', 'review.round_bound', 'review.required', ...CORE]),
  G('G_deliver_exit', 'deliver', ['design.code_matches', 'node.integration_listed',
    'mandate.revalidated', ...CORE]),
];

const INCREMENTAL_STAGES: readonly BaselineStage[] = [
  S('req_design', ['requirement', 'design'], []),
  S('build', ['implement'], ['req_design']),
  S('verify', ['review'], ['build']),
  S('integrate', ['deliver'], ['verify']),
];

const INCREMENTAL_GATES: readonly BaselineGate[] = [
  G('G_req_design', 'req_design', ['stage.requirement_complete', 'intent.restated_consistent',
    'alignment.examples_present', 'scope.present', 'intent.explicit_for_risk', 'redteam.disposed',
    'stage.design_traceable', 'design.covers_spec', 'design.no_spec_creep',
    'design.alternatives_declared', 'node.acceptance_bound', ...CORE]),
  G('G_build_exit', 'build', ['task.complete', 'assumption.disposed', 'mandate.revalidated', ...CORE]),
  G('G_verify_exit', 'verify', ['review.round_bound', 'review.required', ...CORE]),
  G('G_integrate', 'integrate', ['node.integration_listed', 'design.code_matches',
    'mandate.revalidated', ...CORE]),
];

function indexGates(defs: readonly BaselineGate[]): Readonly<Record<string, readonly string[]>> {
  const map: Record<string, readonly string[]> = {};
  for (const gate of defs) map[gate.stage] = [...(map[gate.stage] ?? []), gate.id];
  return map;
}

export const PRESETS: Readonly<Record<PresetId, Preset>> = {
  waterfall: { id: 'waterfall', stages: WATERFALL_STAGES, gates: indexGates(WATERFALL_GATES), gateDefs: WATERFALL_GATES },
  prototype: { id: 'prototype', stages: PROTOTYPE_STAGES, gates: indexGates(PROTOTYPE_GATES), gateDefs: PROTOTYPE_GATES },
  incremental: { id: 'incremental', stages: INCREMENTAL_STAGES, gates: indexGates(INCREMENTAL_GATES), gateDefs: INCREMENTAL_GATES },
};
