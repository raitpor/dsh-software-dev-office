/**
 * M2-2 C10/P1：`gate.judged` 载荷的运行时 schema。
 *
 * 写路径（`src/db/write.ts`）与判定流程共用这一份校验；不接受外部传入的
 * readings（判定读数由门禁现算），也不允许未知字段混入。
 */
import { canonicalJson, sha256Hex } from '../fold/canonical.js';

export type GateJudgedVerdict = 'pass' | 'changes_requested' | 'na';

export interface ValidatedReading {
  readonly criterion_id: string;
  readonly verdict: 'pass' | 'fail' | 'na';
  readonly reason_code: string;
  readonly effective: boolean;
  readonly binding_reasons: readonly string[];
  readonly reasons: readonly string[];
}

export interface ValidatedGateJudgedPayload {
  readonly stage_run_id: string;
  readonly baseline_hash: string;
  readonly gate_id: string;
  readonly verdict: GateJudgedVerdict;
  readonly criteria: readonly ValidatedReading[];
  readonly reasons: readonly string[];
}

export type PayloadValidation =
  | { readonly ok: true; readonly value: ValidatedGateJudgedPayload }
  | { readonly ok: false; readonly message: string };

const READING_KEYS = new Set([
  'criterion_id',
  'verdict',
  'reason_code',
  'effective',
  'binding_reasons',
  'reasons',
]);
const PAYLOAD_KEYS = new Set(['stage_run_id', 'baseline_hash', 'gate_id', 'verdict', 'criteria', 'reasons']);
const READING_VERDICTS = new Set(['pass', 'fail', 'na']);
const GATE_VERDICTS = new Set(['pass', 'changes_requested', 'na']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function validateReading(value: unknown, index: number): ValidatedReading | string {
  if (!isRecord(value)) return `criteria[${index}] must be an object`;
  for (const key of Object.keys(value)) {
    if (!READING_KEYS.has(key)) return `criteria[${index}] has unknown field ${key}`;
  }
  const criterionId = value['criterion_id'];
  if (typeof criterionId !== 'string' || criterionId.length === 0) {
    return `criteria[${index}].criterion_id must be a non-empty string`;
  }
  const verdict = value['verdict'];
  if (typeof verdict !== 'string' || !READING_VERDICTS.has(verdict)) {
    return `criteria[${index}].verdict must be pass|fail|na`;
  }
  const reasonCode = value['reason_code'];
  if (typeof reasonCode !== 'string' || reasonCode.length === 0) {
    return `criteria[${index}].reason_code must be a non-empty string`;
  }
  if (verdict === 'na' && reasonCode !== 'not_enforced_in_m2') {
    return `criteria[${index}] na requires reason_code not_enforced_in_m2`;
  }
  const effective = value['effective'];
  if (typeof effective !== 'boolean') return `criteria[${index}].effective must be a boolean`;
  if (!stringArray(value['binding_reasons'])) return `criteria[${index}].binding_reasons must be string[]`;
  if (!stringArray(value['reasons'])) return `criteria[${index}].reasons must be string[]`;
  return {
    criterion_id: criterionId,
    verdict: verdict as 'pass' | 'fail' | 'na',
    reason_code: reasonCode,
    effective,
    binding_reasons: value['binding_reasons'],
    reasons: value['reasons'],
  };
}

/** 校验 `gate.judged` 载荷；失败返回人读消息（写路径转 `invalid_field`）。 */
export function validateGateJudgedPayload(payload: unknown): PayloadValidation {
  if (!isRecord(payload)) return { ok: false, message: 'gate.judged payload must be an object' };
  for (const key of Object.keys(payload)) {
    if (!PAYLOAD_KEYS.has(key)) return { ok: false, message: `gate.judged payload has unknown field ${key}` };
  }
  const stageRunId = payload['stage_run_id'];
  if (typeof stageRunId !== 'string' || stageRunId.length === 0) {
    return { ok: false, message: 'payload.stage_run_id must be a non-empty string' };
  }
  const baselineHash = payload['baseline_hash'];
  if (typeof baselineHash !== 'string' || baselineHash.length === 0) {
    return { ok: false, message: 'payload.baseline_hash must be a non-empty string' };
  }
  const gateId = payload['gate_id'];
  if (typeof gateId !== 'string' || gateId.length === 0) {
    return { ok: false, message: 'payload.gate_id must be a non-empty string' };
  }
  const verdict = payload['verdict'];
  if (typeof verdict !== 'string' || !GATE_VERDICTS.has(verdict)) {
    return { ok: false, message: 'payload.verdict must be pass|changes_requested|na' };
  }
  const criteria = payload['criteria'];
  if (!Array.isArray(criteria)) return { ok: false, message: 'payload.criteria must be an array' };
  const readings: ValidatedReading[] = [];
  for (let index = 0; index < criteria.length; index += 1) {
    const reading = validateReading(criteria[index], index);
    if (typeof reading === 'string') return { ok: false, message: reading };
    readings.push(reading);
  }
  if (readings.length === 0) return { ok: false, message: 'payload.criteria must not be empty' };
  if (!stringArray(payload['reasons'])) return { ok: false, message: 'payload.reasons must be string[]' };
  return {
    ok: true,
    value: {
      stage_run_id: stageRunId,
      baseline_hash: baselineHash,
      gate_id: gateId,
      verdict: verdict as GateJudgedVerdict,
      criteria: readings,
      reasons: payload['reasons'],
    },
  };
}

/** 载荷摘要，用于授权能力绑定。 */
export function gateJudgedPayloadHash(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}
