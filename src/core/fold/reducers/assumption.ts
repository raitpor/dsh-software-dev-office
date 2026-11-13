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
import { decisionPayload, requireSignedDecision } from '../decisions.js';
import { TABLE_NAMES, type Event, type FoldWorking, type InputEdge, type Row } from '../types.js';
import { rowHash } from '../canonical.js';
import { specRow } from './spec.js';

/** docs/03:54：`inputs` 是 `{kind,id,hash}` 的派生边；形状不对一律 fail-closed。 */
function parseInputEdges(event: Event, payload: Record<string, unknown>): InputEdge[] {
  const raw = payload['inputs'];
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return fail(event, 'payload.inputs must be an array');
  }
  const edges: InputEdge[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return fail(event, 'payload.inputs entries must be objects');
    }
    const edge = item as Record<string, unknown>;
    const kind = edge['kind'];
    const id = edge['id'];
    const hash = edge['hash'];
    if (typeof kind !== 'string' || !(TABLE_NAMES as readonly string[]).includes(kind)) {
      return fail(event, 'payload.inputs kind must be one of TABLE_NAMES');
    }
    if (typeof id !== 'string' || id.length === 0) {
      return fail(event, 'payload.inputs.id must be a non-empty string');
    }
    if (typeof hash !== 'string' || hash.length === 0) {
      return fail(event, 'payload.inputs.hash must be a non-empty string');
    }
    edges.push({ kind, id, hash });
  }
  return edges;
}

const DISPOSITIONS = ['confirmed', 'rejected', 'converted'] as const;

/** docs/02:296：recorded 只建 open，status 不是它的入参。 */
export function assumptionRecorded(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  if (rowOf(state, 'spec', id) !== undefined) {
    return fail(event, `spec ${id} already defined; use spec.revised`);
  }
  if (payload['status'] !== undefined) {
    return fail(event, 'assumption.recorded must not carry payload.status (it only creates open)');
  }
  const edges = parseInputEdges(event, payload);
  for (const edge of edges) {
    const target = state.tables[edge.kind as keyof FoldWorking['tables']]?.[edge.id];
    if (target !== undefined && rowHash(target) !== edge.hash) {
      fail(event, `input ${edge.kind}/${edge.id} hash does not match the current row`);
    }
  }
  state.inputs[id] = edges;
  upsert(state, 'spec', id, specRow(event, id, 'assumption'));
}

/** docs/03:70：覆盖名单只认签名载荷，不是事件回填。 */
function decisionCovers(decision: Row, assumptionId: string, disposition: string): boolean {
  const payload = decisionPayload(decision);
  const ids = Array.isArray(payload?.['spec_ids'])
    ? (payload['spec_ids'] as unknown[])
    : Array.isArray(payload?.['covered_spec_ids'])
      ? (payload['covered_spec_ids'] as unknown[])
      : [];
  if (!ids.includes(assumptionId)) {
    return false;
  }
  const dispositions = Array.isArray(payload?.['dispositions'])
    ? (payload['dispositions'] as unknown[])
    : [];
  return dispositions.some((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return false;
    }
    const entry = item as Record<string, unknown>;
    return (
      (entry['spec_id'] === assumptionId || entry['id'] === assumptionId) &&
      entry['disposition'] === disposition
    );
  });
}

export function assumptionDisposed(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  const row = rowOf(state, 'spec', id);
  if (row === undefined) {
    return fail(event, `assumption ${id} does not exist`);
  }
  if (row['kind'] !== 'assumption') {
    return fail(event, `spec ${id} is not an assumption`);
  }
  if (row['status'] !== 'open') {
    return fail(event, `assumption ${id} is already ${String(row['status'])}; only open can be disposed`);
  }
  const decisionId = reqString(event, payload, 'decision_id');
  const disposition = reqEnum(event, payload, 'disposition', DISPOSITIONS);
  if (payload['covered_spec_ids'] !== undefined || payload['dispositions'] !== undefined) {
    return fail(event, 'assumption.disposed must not carry coverage lists; the signed decision is the only source');
  }
  const decision = requireSignedDecision(state, event, decisionId, 'assumption_set');
  if (!decisionCovers(decision, id, disposition)) {
    return fail(event, `decision ${decisionId} does not cover assumption ${id} with ${disposition}`);
  }
  upsert(state, 'spec', id, {
    ...row,
    status: disposition,
    decision_id: decisionId,
    successor_ref: optString(event, payload, 'successor_ref') ?? null,
    disposed_at: event.at,
  });
}

export function assumptionInvalidated(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  const row = rowOf(state, 'spec', id);
  if (row === undefined) {
    return fail(event, `assumption ${id} does not exist`);
  }
  if (row['kind'] !== 'assumption') {
    return fail(event, `spec ${id} is not an assumption; only assumptions can be invalidated`);
  }
  upsert(state, 'spec', id, {
    ...row,
    status: 'open',
    invalidated_reason: reqString(event, payload, 'reason'),
    invalidated_at: event.at,
  });
}

export const ASSUMPTION_REDUCERS = {
  'assumption.recorded': assumptionRecorded,
  'assumption.disposed': assumptionDisposed,
  'assumption.invalidated': assumptionInvalidated,
} as const;
