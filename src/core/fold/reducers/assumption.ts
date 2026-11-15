import {
  createOnce,
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
import { parseDispositionEntry } from '../../assumption/index.js';
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
  createOnce(state, event, 'spec', id, specRow(event, id, 'assumption'));
}

/**
 * docs/03:70 / docs/04 §5.2：覆盖名单只认签名载荷的 `spec_ids[]` + `dispositions[]`。
 * C2：**不再回退到 `covered_spec_ids`**（M1-0 第 52 轮洞：事件/载荷自带名单不可信）。
 */
function decisionCovers(decision: Row, assumptionId: string, disposition: string): boolean {
  const payload = decisionPayload(decision);
  const ids = Array.isArray(payload?.['spec_ids']) ? (payload['spec_ids'] as unknown[]) : [];
  if (!ids.includes(assumptionId)) {
    return false;
  }
  const dispositions = Array.isArray(payload?.['dispositions']) ? (payload['dispositions'] as unknown[]) : [];
  return dispositions.some((item) => {
    const entry = parseDispositionEntry(item);
    return entry !== undefined && entry.spec_id === assumptionId && entry.disposition === disposition;
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

/**
 * `assumption.invalidated` 是 **fold 派生读数**，不是可写事件（台账 D-078）：
 * 失效由 `propagateInvalidations` 在 inputs hash 变化/目标消失时自动产生（回 open + 幂等键），
 * 不允许任何人靠 append 这个 kind 撤销已签处置——否则 C4「处置是唯一迁移生产者」就是假的。
 *
 * kind 仍登记在 003 种子里只为旧库 FK 兼容；写网关已在入口前置拒（`assumption_invalidated_is_derived`），
 * 这里再拒一次，保证绕过网关直接 fold 旧事件时也不会被当成状态迁移。v2.1 删 kind。
 */
export function assumptionInvalidated(_state: FoldWorking, event: Event): void {
  return fail(
    event,
    'assumption.invalidated 是派生读数，不是可写事件（assumption_invalidated_is_derived）',
  );
}

export const ASSUMPTION_REDUCERS = {
  'assumption.recorded': assumptionRecorded,
  'assumption.disposed': assumptionDisposed,
  'assumption.invalidated': assumptionInvalidated,
} as const;
