import {
  createOnce,
  fail,
  optEnum,
  optString,
  optStringArray,
  patchRow,
  payloadOf,
  reqEnum,
  reqInteger,
  reqString,
  rowOf,
  subjectId,
} from '../guards.js';
import type { Event, FoldWorking } from '../types.js';
import { materializeWorkUnit } from './workunit.js';

const TASK_KINDS = ['implement', 'design', 'review', 'docs'] as const;
const TASK_STATUS = ['planned', 'ready', 'in_progress', 'blocked', 'done', 'dropped'] as const;
const BLOCK_CODES = ['lease_expired', 'lease_revoked', 'upstream_changed', 'clause_unjudged',
  'awaiting_signature', 'verify_failed', 'dirty_main_tree', 'redteam_deferred'] as const;
const SUBJECT_KINDS = ['task', 'spec'] as const;
const DROP_KINDS = ['never_done', 'delivered_deferred'] as const;

function requireTask(state: FoldWorking, event: Event): Record<string, unknown> {
  const row = rowOf(state, 'task', subjectId(event));
  if (row === undefined) {
    return fail(event, `task ${subjectId(event)} does not exist`);
  }
  return row;
}
function requireStatus(event: Event, row: Record<string, unknown>, allowed: readonly string[], action: string): void {
  const status = String(row['status']);
  if (!allowed.includes(status)) {
    fail(event, `task ${subjectId(event)} is ${status}; ${action} requires ${allowed.join('/')}`);
  }
}
export function taskCreated(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  const status = optString(event, payload, 'status') ?? 'planned';
  if (!(TASK_STATUS as readonly string[]).includes(status)) {
    return fail(event, `payload.status must be one of ${TASK_STATUS.join('|')}`);
  }
  createOnce(state, event, 'task', id, {
    id,
    seq: reqInteger(event, payload, 'seq'),
    title: reqString(event, payload, 'title'),
    kind: reqEnum(event, payload, 'kind', TASK_KINDS),
    created_by: optString(event, payload, 'created_by') ?? event.actor,
    producer: optString(event, payload, 'producer') ?? event.actor,
    owner: null,
    status,
    blocked_by: optStringArray(event, payload, 'blocked_by') ?? [],
    scope_paths: optStringArray(event, payload, 'scope_paths') ?? [],
    inputs: optStringArray(event, payload, 'inputs') ?? [],
    subject_kind: optEnum(event, payload, 'subject_kind', SUBJECT_KINDS) ?? null,
    subject_id: optString(event, payload, 'subject_id') ?? null,
    block_code: null,
    at: event.at,
  });
}
export function taskClaimed(state: FoldWorking, event: Event): void {
  const row = requireTask(state, event);
  const status = row['status'];
  if (status !== 'planned' && status !== 'ready') {
    return fail(event, `task ${subjectId(event)} is ${String(status)}; only planned/ready can be claimed`);
  }
  patchRow(state, 'task', subjectId(event), event, {
    owner: optString(event, payloadOf(event), 'owner') ?? event.actor,
    status: 'in_progress',
    claimed_at: event.at,
    reserved_by: null,
    reserved_until: null,
  });
}
export function taskAssigned(state: FoldWorking, event: Event): void {
  const row = requireTask(state, event);
  requireStatus(event, row, ['planned', 'ready', 'in_progress'], 'assignment');
  const payload = payloadOf(event);
  patchRow(state, 'task', subjectId(event), event, {
    reserved_by: reqString(event, payload, 'assignee'),
    reserved_until: reqString(event, payload, 'reserved_until'),
  });
}
export function taskUnassigned(state: FoldWorking, event: Event): void {
  const row = requireTask(state, event);
  requireStatus(event, row, ['planned', 'ready', 'in_progress'], 'unassignment');
  if (row['reserved_by'] === null || row['reserved_by'] === undefined) {
    return fail(event, `task ${subjectId(event)} has no reservation to clear`);
  }
  patchRow(state, 'task', subjectId(event), event, { reserved_by: null, reserved_until: null });
}
export function taskBlocked(state: FoldWorking, event: Event): void {
  const row = requireTask(state, event);
  requireStatus(event, row, ['planned', 'ready', 'in_progress'], 'block');
  const payload = payloadOf(event);
  patchRow(state, 'task', subjectId(event), event, {
    status: 'blocked',
    block_code: reqEnum(event, payload, 'block_code', BLOCK_CODES),
    blocked_reason: optString(event, payload, 'reason') ?? null,
    blocked_at: event.at,
  });
}
export function taskUnblocked(state: FoldWorking, event: Event): void {
  const row = requireTask(state, event);
  requireStatus(event, row, ['blocked'], 'unblock');
  patchRow(state, 'task', subjectId(event), event, {
    status: 'ready',
    block_code: null,
    blocked_reason: null,
    reserved_by: null,
    reserved_until: null,
    unblocked_at: event.at,
  });
}
export function taskDone(state: FoldWorking, event: Event): void {
  const row = requireTask(state, event);
  if (row['status'] !== 'in_progress') {
    return fail(event, `task ${subjectId(event)} is ${String(row['status'])}; done requires in_progress`);
  }
  const payload = payloadOf(event);
  const evidenceId = optString(event, payload, 'evidence_id') ?? null;
  patchRow(state, 'task', subjectId(event), event, {
    status: 'done',
    producer: row['owner'] ?? row['producer'],
    evidence_id: evidenceId,
    done_at: event.at,
  });
  const criterionId = optString(event, payload, 'criterion_id') ?? null;
  if (evidenceId !== null && criterionId !== null) {
    materializeWorkUnit(state, event, subjectId(event), criterionId, evidenceId);
  }
}
export function taskReopened(state: FoldWorking, event: Event): void {
  const row = requireTask(state, event);
  if (row['status'] !== 'done') {
    return fail(event, `task ${subjectId(event)} is ${String(row['status'])}; reopened requires done`);
  }
  const payload = payloadOf(event);
  patchRow(state, 'task', subjectId(event), event, {
    status: 'in_progress',
    reopened_reason: reqString(event, payload, 'reason'),
    reopened_at: event.at,
  });
}
export function taskDropped(state: FoldWorking, event: Event): void {
  const row = requireTask(state, event);
  requireStatus(event, row, ['ready', 'done'], 'drop');
  const payload = payloadOf(event);
  const dropKind = reqEnum(event, payload, 'drop_kind', DROP_KINDS);
  const status = String(row['status']);
  if (status === 'done' && dropKind !== 'delivered_deferred') {
    return fail(event, `task ${subjectId(event)} is done; drop_kind must be delivered_deferred`);
  }
  if (status === 'ready' && dropKind !== 'never_done') {
    return fail(event, `task ${subjectId(event)} is ready; drop_kind must be never_done`);
  }
  const credential = optString(event, payload, 'credential');
  if (dropKind === 'delivered_deferred' && (credential === undefined || credential.length === 0)) {
    return fail(event, 'delivered_deferred requires payload.credential');
  }
  patchRow(state, 'task', subjectId(event), event, {
    status: 'dropped',
    drop_kind: dropKind,
    drop_reason: reqString(event, payload, 'reason'),
    drop_credential: credential ?? null,
    dropped_at: event.at,
  });
}
export const TASK_REDUCERS = {
  'task.created': taskCreated,
  'task.claimed': taskClaimed,
  'task.assigned': taskAssigned,
  'task.unassigned': taskUnassigned,
  'task.blocked': taskBlocked,
  'task.unblocked': taskUnblocked,
  'task.done': taskDone,
  'task.reopened': taskReopened,
  'task.dropped': taskDropped,
} as const;
