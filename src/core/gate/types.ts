import { CODE } from '../errors/codes.js';
/**
 * M2-2 门禁判定数据类型（纯数据，无 IO）。
 *
 * 判定行绑一版已冻结 baseline；`readings[]` 是“这一次判定”里每条判据的
 * 三态 + 有效绑定证据，verdict 由 readings 聚合，不可手填（docs/03:39）。
 */
export type GateReadingVerdict = 'pass' | 'fail' | 'na';



export interface GateReading {
  readonly criterion_id: string;
  readonly verdict: GateReadingVerdict;
  /** 机器可见的原因码；`na` 恒为 `not_enforced_in_m2`（非 core 判据 M3 起强制）。 */
  readonly reason_code: GateReadingReasonCode;
  readonly effective: boolean;
  readonly binding_reasons: readonly string[];
  /** 判据实现/绑定给出的原因码（core_not_effective / insufficient_data 等）。 */
  readonly reasons: readonly string[];
}

export type GateVerdict = 'pass' | 'changes_requested' | 'na';

export interface GateEvaluation {
  readonly stage: string;
  readonly baseline_hash: string;
  readonly gate_ids: readonly string[];
  readonly verdict: GateVerdict;
  readonly readings: readonly GateReading[];
  /** 判定级原因码：core_not_effective / gate_empty / stage_unknown 等。 */
  readonly reasons: readonly string[];
}


export const GateReadingReasonCode_CODES = [
  CODE.checked,
  CODE.core_not_effective,
  CODE.criterion_not_effective,
  CODE.not_enforced_in_m2,
  CODE.policy_mode_any_of,
  CODE.waivable_gate,
] as const;
export type GateReadingReasonCode = (typeof GateReadingReasonCode_CODES)[number];
