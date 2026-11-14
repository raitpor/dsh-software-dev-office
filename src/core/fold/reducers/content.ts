import { createOnce, fail, optString, optStringArray, payloadOf, reqString, rowOf, subjectId, upsert } from '../guards.js';
import type { Event, FoldWorking } from '../types.js';

/** snapshot.taken：写 snapshot + snapshot_parent 链接（G1 的父链表）。 */
export function snapshotTaken(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  const parentIds = optStringArray(event, payload, 'parent_ids') ?? [];
  const existed = rowOf(state, 'snapshot', id) !== undefined;
  createOnce(state, event, 'snapshot', id, {
    id,
    git_oid: reqString(event, payload, 'git_oid'),
    external_ref: optString(event, payload, 'external_ref') ?? null,
    at: event.at,
  });
  if (existed) {
    const current = Object.values(state.tables.snapshot_parent)
      .filter((row) => row['snapshot_id'] === id)
      .map((row) => String(row['parent_id']))
      .sort();
    const next = [...parentIds].sort();
    if (current.join('\u0000') !== next.join('\u0000')) {
      return fail(event, `snapshot ${id} already exists with different parent_ids; this projection is append-only`);
    }
  }
  for (const parentId of parentIds) {
    upsert(state, 'snapshot_parent', `${id}/${parentId}`, {
      snapshot_id: id,
      parent_id: parentId,
    });
  }
}

export const CONTENT_REDUCERS = {
  'snapshot.taken': snapshotTaken,
} as const;
