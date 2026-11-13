import { fail, optString, optStringArray, payloadOf, reqEnum, reqInteger, reqString, subjectId, upsert } from '../guards.js';
import type { Event, FoldWorking } from '../types.js';

const ACTOR_KINDS = ['human', 'service', 'agent'] as const;
const CONFIG_KEYS = [
  'limits.max_members',
  'limits.max_pending_attention',
  'limits.max_payload_bytes',
  'limits.cleanup_timeout_s',
] as const;

function verifyRun(state: FoldWorking, event: Event, result: 'pass' | 'fail'): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  upsert(state, 'verify_run', id, {
    id,
    at: event.at,
    actor_kind: reqEnum(event, payload, 'actor_kind', ACTOR_KINDS),
    actor: reqString(event, payload, 'actor'),
    groups: optStringArray(event, payload, 'groups') ?? [],
    result,
    signed_by: optString(event, payload, 'signed_by') ?? null,
    note: optString(event, payload, 'note') ?? null,
  });
}

export function verifyPassed(state: FoldWorking, event: Event): void {
  verifyRun(state, event, 'pass');
}

export function verifyFailed(state: FoldWorking, event: Event): void {
  verifyRun(state, event, 'fail');
}

/** docs/12 §6.1：白名单四键、value 整数且 ≥1，max_payload_bytes ≥1024。 */
export function configChanged(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const key = subjectId(event);
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    fail(event, `config key ${key} is not in the whitelist`);
  }
  const value = reqInteger(event, payload, 'after');
  if (value < 1) {
    fail(event, 'config value must be >= 1');
  }
  if (key === 'limits.max_payload_bytes' && value < 1024) {
    fail(event, 'limits.max_payload_bytes must be >= 1024');
  }
  upsert(state, 'config', key, {
    key,
    value,
    updated_by: reqString(event, payload, 'actor'),
    updated_at: event.at,
  });
}

export const OPS_REDUCERS = {
  'verify.passed': verifyPassed,
  'verify.failed': verifyFailed,
  'config.changed': configChanged,
} as const;
