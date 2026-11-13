/**
 * 门预览（M1-4 C6/C7）：gate 结构一律来自 `src/core/baseline/presets.ts` 的常量，
 * `effective` 一律来自 `src/core/criteria/binding.ts`；本模块不复制 `applies_to`/`guarantee`。
 */

import type { SdoDatabase } from '../db/driver.js';
import type { FoldState } from '../core/fold/types.js';
import type { Preset, PresetId } from '../core/baseline/presets.js';
import { PRESETS } from '../core/baseline/presets.js';
import type { Policy, PolicyMode } from '../core/criteria/binding.js';
import type { StageKind } from '../core/criteria/catalog.js';
import {
  evaluateCriterionCode,
  registeredCriteria,
  stageGap,
  type CheckReason,
  type CheckVerdict,
  type CriterionCheck,
} from './evaluate.js';

export interface GateRowCheck {
  readonly id: string;
  readonly stage: string;
  readonly policy_mode: PolicyMode;
  readonly waivable: boolean;
  readonly criteria: readonly CriterionCheck[];
  readonly result: CheckVerdict;
}

export interface GateCheck {
  readonly preset: PresetId;
  readonly stage: string;
  readonly kinds: readonly StageKind[];
  readonly gates: readonly GateRowCheck[];
  readonly criteria: readonly CriterionCheck[];
  readonly result: CheckVerdict;
  readonly gaps: readonly CheckReason[];
}

export function isPresetId(value: string): value is PresetId {
  return Object.hasOwn(PRESETS, value);
}

/** preset → 有效绑定用的 Policy（结构照抄，不做任何再解释）。 */
export function presetPolicy(preset: Preset): Policy {
  return {
    stages: preset.stages.map((stage) => ({ id: stage.id, kinds: stage.kinds as readonly StageKind[] })),
    gates: preset.gateDefs.map((gate) => ({
      id: gate.id,
      stage: gate.stage,
      criteria: gate.criteria,
      policy_mode: gate.policy_mode as PolicyMode,
      waivable: gate.waivable,
    })),
  };
}

/** 聚合判据三态（导出给单测钉住 `na ⇒ fail` 分支；生产调用点只有 `evaluateGate`）。 */
export function aggregateChecks(checks: readonly CriterionCheck[]): CheckVerdict {
  if (checks.length === 0) return 'fail';
  if (checks.some((check) => check.result === 'fail')) return 'fail';
  if (checks.some((check) => check.result === 'unknown')) return 'unknown';
  // M1-4 第 1 轮评审 P1：na 一律按 fail 处理。M1 里 core 三条已不产 na；
  // 这条是纵深防御，避免未来某判据的 na 被聚合洗成 pass（docs/04 §6 的 na
  // 不阻塞语义由 M2 的门判定自己按 stage_run/waiver 口径处理）。
  if (checks.some((check) => check.result === 'na')) return 'fail';
  return 'pass';
}

/** 预览一个 stage 出口。stage 不在该 preset ⇒ `undefined`（调用方映射 `unknown_stage`）。 */
export function evaluateGate(
  db: SdoDatabase,
  state: FoldState,
  preset: Preset,
  stageId: string,
  options: { readonly repoRoot?: string } = {},
): GateCheck | undefined {
  const stage = preset.stages.find((candidate) => candidate.id === stageId);
  if (stage === undefined) return undefined;

  const policy = presetPolicy(preset);
  const registered = registeredCriteria();
  const gateIds = preset.gates[stageId] ?? [];
  const gateDefs = gateIds
    .map((gateId) => preset.gateDefs.find((gate) => gate.id === gateId))
    .filter((gate): gate is NonNullable<typeof gate> => gate !== undefined);

  const gates: GateRowCheck[] = gateDefs.map((gate) => {
    const criteria = gate.criteria.map((code) =>
      evaluateCriterionCode(db, state, code, policy, registered, options),
    );
    return {
      id: gate.id,
      stage: gate.stage,
      policy_mode: gate.policy_mode as PolicyMode,
      waivable: gate.waivable,
      criteria,
      result: aggregateChecks(criteria),
    };
  });

  const criteria: CriterionCheck[] = [];
  for (const row of gates) {
    for (const check of row.criteria) {
      if (!criteria.some((existing) => existing.criterion_id === check.criterion_id)) {
        criteria.push(check);
      }
    }
  }

  const gaps: CheckReason[] = [];
  for (const candidate of preset.stages) {
    const gap = stageGap(candidate.id, candidate.kinds as readonly StageKind[], registered);
    if (gap !== undefined) gaps.push(gap);
  }

  return {
    preset: preset.id,
    stage: stage.id,
    kinds: stage.kinds as readonly StageKind[],
    gates,
    criteria,
    result: aggregateChecks(criteria),
    gaps,
  };
}
