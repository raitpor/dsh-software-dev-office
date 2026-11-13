import {
  fail,
  optString,
  patchRow,
  payloadOf,
  reqEnum,
  reqString,
  rowOf,
  subjectId,
  upsert,
} from '../guards.js';
import type { Event, FoldWorking } from '../types.js';

const REVIEW_VERDICTS = ['reproduced', 'refuted'] as const;
const ROUND_VERDICTS = ['pass', 'changes_requested'] as const;
const REDTEAM_SUBJECTS = ['spec', 'task'] as const;
const DISPOSITIONS = ['accepted', 'rejected', 'deferred'] as const;

export function reviewRecorded(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  if (rowOf(state, 'review', id) !== undefined) {
    return fail(event, `review ${id} already recorded`);
  }
  upsert(state, 'review', id, {
    id,
    task_id: reqString(event, payload, 'task_id'),
    reviewer: reqString(event, payload, 'reviewer'),
    subject_hash: reqString(event, payload, 'subject_hash'),
    subject_producer: reqString(event, payload, 'subject_producer'),
    finding: reqString(event, payload, 'finding'),
    verified_by: null,
    verdict: reqEnum(event, payload, 'verdict', REVIEW_VERDICTS),
    reason: optString(event, payload, 'reason') ?? null,
    at: event.at,
  });
}

export function reviewFindingVerified(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  patchRow(state, 'review', subjectId(event), event, {
    verified_by: optString(event, payload, 'verified_by') ?? event.actor,
    verified_at: event.at,
  });
}

/** design/02：verdict=pass 的前置是全部 finding 已核实。 */
export function reviewRoundClosed(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const taskId = reqString(event, payload, 'task_id');
  const verdict = reqEnum(event, payload, 'verdict', ROUND_VERDICTS);
  if (verdict === 'pass') {
    for (const row of Object.values(state.tables.review)) {
      if (row['task_id'] === taskId && row['verified_by'] === null) {
        return fail(event, `review pass requires every finding verified (open finding ${String(row['id'])})`);
      }
    }
  }
  const id = subjectId(event);
  upsert(state, 'review_round', id, {
    id,
    task_id: taskId,
    baseline_hash: reqString(event, payload, 'baseline_hash'),
    frontier: reqString(event, payload, 'frontier'),
    verdict,
    signer: reqString(event, payload, 'signer'),
    at: event.at,
  });
}

export function redteamRecorded(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  upsert(state, 'redteam', id, {
    id,
    subject_kind: reqEnum(event, payload, 'subject_kind', REDTEAM_SUBJECTS),
    subject_id: reqString(event, payload, 'subject_id'),
    criterion_id: reqString(event, payload, 'criterion_id'),
    criterion_fixture_id: reqString(event, payload, 'criterion_fixture_id'),
    use_case: reqString(event, payload, 'use_case'),
    disposition: null,
    at: event.at,
  });
}

export function redteamDisposed(state: FoldWorking, event: Event): void {
  patchRow(state, 'redteam', subjectId(event), event, {
    disposition: reqEnum(event, payloadOf(event), 'disposition', DISPOSITIONS),
    disposed_at: event.at,
  });
}

export const REVIEW_REDUCERS = {
  'review.recorded': reviewRecorded,
  'review.finding_verified': reviewFindingVerified,
  'review.round_closed': reviewRoundClosed,
  'redteam.recorded': redteamRecorded,
  'redteam.disposed': redteamDisposed,
} as const;
