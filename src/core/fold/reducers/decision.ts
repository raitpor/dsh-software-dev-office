import {
  createOnce,
  fail,
  optEnum,
  optString,
  payloadOf,
  reqEnum,
  reqString,
  rowOf,
  subjectId,
  upsert,
} from '../guards.js';
import type { Event, FoldWorking } from '../types.js';
import { applyAssumptionSetRevocation } from '../../assumption/cascade.js';

const DECISION_KINDS = [
  'sign', 'intent', 'plan', 'spec_set', 'assumption_set', 'freeze', 'baseline', 'waiver', 'rollback',
] as const;

/**
 * docs/06:189：decision 只增不改。valid 先建行（signature=null），signed 再补签名，
 * 任何一步都不许整行覆盖，否则“先签 plan 再签 spec_set”能换掉授权。
 */
export function decisionValid(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  createOnce(state, event, 'decision', id, {
    id,
    decision_kind: reqEnum(event, payload, 'decision_kind', DECISION_KINDS),
    status: 'valid',
    payload: payload['payload'] ?? null,
    payload_hash: reqString(event, payload, 'payload_hash'),
    signature: null,
    key_id: null,
    signer: null,
    frontier: optString(event, payload, 'frontier') ?? null,
    at: event.at,
    revoked_at: null,
    revoke_reason: null,
  });
}

export function decisionSigned(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  const row = rowOf(state, 'decision', id);
  if (row === undefined) {
    return fail(event, `decision ${id} does not exist; decision.valid must come first`);
  }
  if (row['status'] !== 'valid') {
    return fail(event, `decision ${id} is ${String(row['status'])}; only valid decisions can be signed`);
  }
  if (row['signature'] !== null) {
    return fail(event, `decision ${id} is already signed; decisions are append-only`);
  }
  const payloadHash = reqString(event, payload, 'payload_hash');
  if (payloadHash !== row['payload_hash']) {
    return fail(event, `decision ${id} payload_hash mismatch with decision.valid`);
  }
  // C12/D-047：channel 与 key_id 都从**已验签的载荷**投影（网关已核过回执）；
  // channel 对旧 fixture 允许缺省为 null，但真实签发路径必填。
  upsert(state, 'decision', id, {
    ...row,
    signature: reqString(event, payload, 'signature'),
    key_id: reqString(event, payload, 'key_id'),
    channel: optEnum(event, payload, 'channel', ['ui', 'cli'] as const) ?? null,
    signer: reqString(event, payload, 'signer'),
    at: event.at,
  });
}

export function decisionRevoked(state: FoldWorking, event: Event): void {
  const id = subjectId(event);
  const row = rowOf(state, 'decision', id);
  if (row === undefined) {
    return fail(event, `decision ${id} does not exist`);
  }
  if (row['status'] !== 'valid') {
    return fail(event, `decision ${id} is ${String(row['status'])}; only valid decisions can transition`);
  }
  if (row['signature'] === null) {
    return fail(event, `decision ${id} is not signed yet; nothing to revoke`);
  }
  upsert(state, 'decision', id, {
    ...row,
    status: 'revoked',
    revoked_at: event.at,
    revoke_reason: reqString(event, payloadOf(event), 'reason'),
  });
  // C6：撤销 assumption_set 时把该 decision 投影出的处置级联回 open（幂等派生，不另存状态）。
  if (row['decision_kind'] === 'assumption_set') {
    applyAssumptionSetRevocation(state, event, id);
  }
}

export function decisionRejected(state: FoldWorking, event: Event): void {
  const id = subjectId(event);
  const row = rowOf(state, 'decision', id);
  if (row === undefined) {
    return fail(event, `decision ${id} does not exist`);
  }
  if (row['status'] !== 'valid') {
    return fail(event, `decision ${id} is ${String(row['status'])}; only valid decisions can transition`);
  }
  // P2-1（第 1 轮评审）：已签决策不能再被 rejected——否则已投影的处置会被卡死
  // （verify 红 assumption_decision_invalid，revoke 与 re-dispose 都被拒）。
  // 撤销已签决策的唯一路径是 decision.revoked（带签字、级联回 open）。
  if (String(row['signature'] ?? '').length > 0) {
    return fail(
      event,
      `decision ${id} is already signed (decision_already_signed); use decision.revoked to revoke a signed decision`,
    );
  }
  upsert(state, 'decision', id, {
    ...row,
    status: 'invalid',
    rejected_at: event.at,
    rejected_reason: optString(event, payloadOf(event), 'reason') ?? null,
  });
}

export const DECISION_REDUCERS = {
  'decision.valid': decisionValid,
  'decision.signed': decisionSigned,
  'decision.revoked': decisionRevoked,
  'decision.rejected': decisionRejected,
} as const;
