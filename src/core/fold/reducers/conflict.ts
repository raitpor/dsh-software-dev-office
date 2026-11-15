/**
 * M3-2 · 冲突行投影（docs/02 §3：冲突是事件派生的，不是网关直接写表）。
 *
 * `conflict.detected`：写一行 status=open（同 id 同内容幂等、异内容拒）。
 * `conflict.resolved`：只认已签名 decision（`conflict_resolution` 载荷，D-089）。
 * 事件 actor = 失败写入方（lead 裁定：便于追责；检测器不额外要权）。
 */

import { createOnce, fail, payloadOf, patchRow, reqEnum, reqString, rowOf } from '../guards.js';
import { requireSignedDecision } from '../decisions.js';
import type { Event, FoldWorking } from '../types.js';
import { CONFLICT_DETECTED, CONFLICT_RESOLVED, CONFLICT_SIDES } from '../../conflict/types.js';
import { verifyResolutionDecision } from '../../conflict/resolve.js';

export function conflictDetected(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const conflictId = reqString(event, payload, 'conflict_id');
  createOnce(state, event, 'conflict', conflictId, {
    id: conflictId,
    subject: reqString(event, payload, 'subject'),
    field: reqString(event, payload, 'field'),
    base_hash: reqString(event, payload, 'base_hash'),
    current_hash: reqString(event, payload, 'current_hash'),
    winner_actor: reqString(event, payload, 'winner_actor'),
    loser_actor: reqString(event, payload, 'loser_actor'),
    winner_value: reqString(event, payload, 'winner_value'),
    loser_value: reqString(event, payload, 'loser_value'),
    status: 'open',
    resolution_decision_id: null,
    resolved_by: null,
    resolved_at: null,
    at: event.at,
  });
}

export function conflictResolved(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const conflictId = reqString(event, payload, 'conflict_id');
  const decisionId = reqString(event, payload, 'decision_id');
  const side = reqEnum(event, payload, 'side', CONFLICT_SIDES);
  const row = rowOf(state, 'conflict', conflictId);
  if (row === undefined) return fail(event, `conflict ${conflictId} does not exist`);
  if (row['status'] !== 'open') return fail(event, `conflict ${conflictId} is already ${String(row['status'])}`);
  const decision = requireSignedDecision(state, event, decisionId, 'sign');
  const check = verifyResolutionDecision(decision, conflictId, side, {
    winner: String(row['winner_actor']),
    loser: String(row['loser_actor']),
  });
  if (!check.ok) return fail(event, check.message);
  patchRow(state, 'conflict', conflictId, event, {
    status: 'resolved',
    resolution_decision_id: decisionId,
    resolved_by: check.value.signer,
    resolved_at: event.at,
  });
}

export const CONFLICT_REDUCERS = {
  [CONFLICT_DETECTED]: conflictDetected,
  [CONFLICT_RESOLVED]: conflictResolved,
} as const;
