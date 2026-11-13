import { requireValidDecision } from '../decisions.js';
import {
  fail,
  optString,
  payloadOf,
  reqEnum,
  reqString,
  rowOf,
  subjectId,
  upsert,
} from '../guards.js';
import type { Event, FoldWorking } from '../types.js';

/**
 * intent.signed：intent 行只由签字事务产生（docs/02 §11：decision.signed 后同事务写）。
 * 行必须带有效 decision(kind='intent')、非空 content_hash 与完整意图字段——
 * 缺任一即非法投影，fold 直接拒（docs/03「意图」行：decision_id / content_hash NOT NULL）。
 */
export function intentSigned(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  if (rowOf(state, 'intent', id) !== undefined) {
    return fail(event, `intent ${id} already signed`);
  }
  const decisionId = reqString(event, payload, 'decision_id');
  requireValidDecision(state, event, decisionId, 'intent');
  upsert(state, 'intent', id, {
    id,
    statement: reqString(event, payload, 'statement'),
    source_text: optString(event, payload, 'source_text') ?? reqString(event, payload, 'statement'),
    owner: reqString(event, payload, 'owner'),
    decision_id: decisionId,
    strength: reqEnum(event, payload, 'strength', ['explicit', 'inferred'] as const),
    baseline_hash: optString(event, payload, 'baseline_hash') ?? null,
    content_hash: reqString(event, payload, 'content_hash'),
    status: 'signed',
    at: event.at,
  });
}

export const INTENT_REDUCERS = {
  'intent.signed': intentSigned,
} as const;
