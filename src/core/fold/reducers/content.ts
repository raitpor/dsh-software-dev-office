import { optString, optStringArray, payloadOf, reqString, subjectId, upsert } from '../guards.js';
import type { Event, FoldWorking } from '../types.js';

/** snapshot.taken：写 snapshot + snapshot_parent 链接（G1 的父链表）。 */
export function snapshotTaken(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  upsert(state, 'snapshot', id, {
    id,
    git_oid: reqString(event, payload, 'git_oid'),
    external_ref: optString(event, payload, 'external_ref') ?? null,
    at: event.at,
  });
  for (const parentId of optStringArray(event, payload, 'parent_ids') ?? []) {
    upsert(state, 'snapshot_parent', `${id}/${parentId}`, {
      snapshot_id: id,
      parent_id: parentId,
    });
  }
}

export const CONTENT_REDUCERS = {
  'snapshot.taken': snapshotTaken,
} as const;
