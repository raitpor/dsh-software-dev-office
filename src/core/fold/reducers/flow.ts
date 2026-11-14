import {
  createOnce,
  fail,
  optString,
  optStringArray,
  patchRow,
  payloadOf,
  reqEnum,
  reqString,
  rowOf,
  subjectId,
} from '../guards.js';
import type { Event, FoldWorking } from '../types.js';

const REPORT_STATES = ['progress', 'ready', 'blocked', 'failed', 'dropped'] as const;
const ATTENTION_STATES = ['open', 'answered', 'withdrawn'] as const;
const DEFECT_KINDS = ['criterion', 'integration', 'consistency'] as const;
const DEFECT_SEVERITY = ['low', 'medium', 'high'] as const;

export function reportRecorded(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  createOnce(state, event, 'report', id, {
    id,
    task_id: reqString(event, payload, 'task_id'),
    state: reqEnum(event, payload, 'state', REPORT_STATES),
    evidence_id: optString(event, payload, 'evidence_id') ?? null,
    note: optString(event, payload, 'note') ?? null,
    at: event.at,
  });
}

export function attentionRaised(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  createOnce(state, event, 'attention', id, {
    id,
    task_id: reqString(event, payload, 'task_id'),
    raised_by: optString(event, payload, 'raised_by') ?? event.actor,
    asked_of: reqString(event, payload, 'asked_of'),
    question: reqString(event, payload, 'question'),
    options: optStringArray(event, payload, 'options') ?? [],
    state: 'open' satisfies (typeof ATTENTION_STATES)[number],
    expires_at: reqString(event, payload, 'expires_at'),
    answered_by: null,
    withdrawn_by: null,
    supersedes: optString(event, payload, 'supersedes') ?? null,
    at: event.at,
  });
}

export function attentionAnswered(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const row = rowOf(state, 'attention', subjectId(event));
  if (row === undefined) {
    return fail(event, `attention ${subjectId(event)} does not exist`);
  }
  if (row['state'] !== 'open') {
    return fail(event, `attention ${subjectId(event)} is ${String(row['state'])}; only open can be answered`);
  }
  patchRow(state, 'attention', subjectId(event), event, {
    state: 'answered' satisfies (typeof ATTENTION_STATES)[number],
    answer: reqString(event, payload, 'answer'),
    answered_by: optString(event, payload, 'answered_by') ?? event.actor,
    answered_at: event.at,
  });
}

/** docs/03 不变式：撤回人必须是提出人。 */
export function attentionWithdrawn(state: FoldWorking, event: Event): void {
  const row = rowOf(state, 'attention', subjectId(event));
  if (row === undefined) {
    return fail(event, `attention ${subjectId(event)} does not exist`);
  }
  if (row['state'] !== 'open') {
    return fail(event, `attention ${subjectId(event)} is ${String(row['state'])}; only open can be withdrawn`);
  }
  const withdrawnBy = optString(event, payloadOf(event), 'withdrawn_by') ?? event.actor;
  if (withdrawnBy !== row['raised_by']) {
    return fail(event, 'attention.withdrawn_by must equal raised_by');
  }
  patchRow(state, 'attention', subjectId(event), event, {
    state: 'withdrawn' satisfies (typeof ATTENTION_STATES)[number],
    withdrawn_by: withdrawnBy,
    withdrawn_at: event.at,
  });
}

export function defectRecorded(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  createOnce(state, event, 'defect', id, {
    id,
    criterion_id: reqString(event, payload, 'criterion_id'),
    spec_id: optString(event, payload, 'spec_id') ?? null,
    task_id: optString(event, payload, 'task_id') ?? null,
    kind: reqEnum(event, payload, 'kind', DEFECT_KINDS),
    severity: reqEnum(event, payload, 'severity', DEFECT_SEVERITY),
    family: optString(event, payload, 'family') ?? null,
    status: 'open',
    evidence: optString(event, payload, 'evidence') ?? null,
    verify_run_id: null,
    closed_by: null,
    at: event.at,
  });
}

/** docs/03 不变式：关闭必须命中 pass 的 verify_run，且 closed_by = 该 run 的 actor。 */
export function defectClosed(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const defect = rowOf(state, 'defect', subjectId(event));
  if (defect === undefined) {
    return fail(event, `defect ${subjectId(event)} does not exist`);
  }
  if (defect['status'] !== 'open') {
    return fail(event, `defect ${subjectId(event)} is ${String(defect['status'])}; only open can be closed`);
  }
  const verifyRunId = reqString(event, payload, 'verify_run_id');
  const closedBy = reqString(event, payload, 'closed_by');
  const verifyRun = rowOf(state, 'verify_run', verifyRunId);
  if (verifyRun === undefined) {
    return fail(event, `verify_run ${verifyRunId} does not exist`);
  }
  if (verifyRun['result'] !== 'pass') {
    return fail(event, `defect close requires verify_run.result = pass`);
  }
  if (verifyRun['actor'] !== closedBy) {
    return fail(event, 'defect close: closed_by must equal verify_run.actor');
  }
  patchRow(state, 'defect', subjectId(event), event, {
    status: 'closed',
    verify_run_id: verifyRunId,
    closed_by: closedBy,
    closed_at: event.at,
  });
}

export const FLOW_REDUCERS = {
  'report.recorded': reportRecorded,
  'attention.raised': attentionRaised,
  'attention.answered': attentionAnswered,
  'attention.withdrawn': attentionWithdrawn,
  'defect.recorded': defectRecorded,
  'defect.closed': defectClosed,
} as const;
