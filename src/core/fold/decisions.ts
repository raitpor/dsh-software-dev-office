import { fail, rowOf } from './guards.js';
import type { Event, FoldWorking, Row } from './types.js';

/** docs/02 §11/§12：授权先于动作；decision 必须存在、valid、且（可选）kind 匹配。 */
export function requireValidDecision(
  state: FoldWorking,
  event: Event,
  decisionId: string,
  kind?: string,
): Row {
  const row = rowOf(state, 'decision', decisionId);
  if (row === undefined) {
    return fail(event, `decision ${decisionId} does not exist`);
  }
  if (row['status'] !== 'valid') {
    return fail(event, `decision ${decisionId} is not valid`);
  }
  if (kind !== undefined && row['decision_kind'] !== kind) {
    return fail(event, `decision ${decisionId} must be kind ${kind}`);
  }
  return row;
}

/**
 * docs/06:189：授权只能消费“已签名”的 decision。`decision.valid` 只是中间行，
 * `decision.signed` 之后 signature/key_id/signer 才非空；只 valid 不 signed 不算授权。
 */
export function requireSignedDecision(
  state: FoldWorking,
  event: Event,
  decisionId: string,
  kind?: string,
): Row {
  const row = requireValidDecision(state, event, decisionId, kind);
  for (const field of ['signature', 'key_id', 'signer'] as const) {
    const value = row[field];
    if (typeof value !== 'string' || value.length === 0) {
      return fail(event, `decision ${decisionId} is not signed; authorization requires a signed decision`);
    }
  }
  return row;
}

export function decisionPayload(row: Row): Record<string, unknown> | undefined {
  const payload = row['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return undefined;
  }
  return payload as Record<string, unknown>;
}
