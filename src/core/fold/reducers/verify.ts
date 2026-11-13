import {
  optString,
  optStringArray,
  patchRow,
  payloadOf,
  reqEnum,
  reqString,
  rowOf,
  subjectId,
  upsert,
  fail,
} from '../guards.js';
import type { Event, FoldWorking } from '../types.js';
import { materializeWorkUnit } from './workunit.js';

const VERDICTS = ['pass', 'changes_requested', 'na'] as const;

export function criterionRegistered(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  if (rowOf(state, 'criterion', id) !== undefined) {
    return fail(event, `criterion ${id} already registered; use criterion.revised`);
  }
  const remedy = reqString(event, payload, 'remedy');
  upsert(state, 'criterion', id, {
    id,
    spec_id: reqString(event, payload, 'spec_id'),
    kind: optString(event, payload, 'kind') ?? null,
    status_enum: optString(event, payload, 'status_enum') ?? 'draft',
    remedy,
    at: event.at,
  });
}

export function criterionRevised(state: FoldWorking, event: Event): void {
  if (rowOf(state, 'criterion', subjectId(event)) === undefined) {
    return fail(event, `criterion ${subjectId(event)} does not exist`);
  }
  const payload = payloadOf(event);
  patchRow(state, 'criterion', subjectId(event), event, {
    remedy: reqString(event, payload, 'remedy'),
    status_enum: optString(event, payload, 'status_enum') ?? 'draft',
    revised_at: event.at,
  });
}

export function evidenceAttached(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  if (rowOf(state, 'evidence', id) !== undefined) {
    return fail(event, `evidence ${id} already attached`);
  }
  upsert(state, 'evidence', id, {
    id,
    criterion_id: reqString(event, payload, 'criterion_id'),
    artifact_uri: reqString(event, payload, 'artifact_uri'),
    artifact_sha256: reqString(event, payload, 'artifact_sha256'),
    command: optString(event, payload, 'command') ?? null,
    output_digest: optString(event, payload, 'output_digest') ?? null,
    snapshot_id: optString(event, payload, 'snapshot_id') ?? null,
    at: event.at,
  });
  const taskId = optString(event, payload, 'task_id');
  if (taskId !== undefined) {
    materializeWorkUnit(state, event, taskId, reqString(event, payload, 'criterion_id'), id);
  }
}

export function stageEntered(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  upsert(state, 'stage_run', id, {
    id,
    stage: reqString(event, payload, 'stage'),
    gate_id: optString(event, payload, 'gate_id') ?? null,
    baseline_hash: optString(event, payload, 'baseline_hash') ?? null,
    entered_at: event.at,
    exited_at: null,
    verdict: null,
    criteria: optStringArray(event, payload, 'criteria') ?? [],
    at: event.at,
  });
}

export function stageExited(state: FoldWorking, event: Event): void {
  const verdict = reqEnum(event, payloadOf(event), 'verdict', VERDICTS);
  patchRow(state, 'stage_run', subjectId(event), event, {
    exited_at: event.at,
    verdict,
  });
}

export function gateJudged(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  patchRow(state, 'stage_run', subjectId(event), event, {
    verdict: reqEnum(event, payload, 'verdict', VERDICTS),
    judged_at: event.at,
  });
}

export const VERIFY_REDUCERS = {
  'criterion.registered': criterionRegistered,
  'criterion.revised': criterionRevised,
  'evidence.attached': evidenceAttached,
  'stage.entered': stageEntered,
  'stage.exited': stageExited,
  'gate.judged': gateJudged,
} as const;
