import { createOnce, fail, optString, payloadOf, reqString, rowOf, subjectId, upsert } from '../guards.js';
import { reqStringArray } from '../guards.js';
import { decisionPayload, requireSignedDecision } from '../decisions.js';
import type { Event, FoldWorking } from '../types.js';
import { materializeReleaseItems } from './release-items.js';

/** docs/09：package_version 可以冻结后才填；冻结行其他字段由库层触发器保护。 */
export function releaseFrozen(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  const baselineId = optString(event, payload, 'baseline_id');
  if (baselineId !== undefined && rowOf(state, 'baseline', baselineId) === undefined) {
    fail(event, `baseline ${baselineId} does not exist`);
  }
  // docs/09:37：frozen_by 是 JSON 数组，至少两个 human actor（写库口径按冻结设计的 DDL）。
  const frozenBy = reqStringArray(event, payload, 'frozen_by');
  if (frozenBy.length < 2) {
    return fail(event, 'release.frozen requires payload.frozen_by[] with at least two humans');
  }
  createOnce(state, event, 'release', id, {
    id,
    package_version: optString(event, payload, 'package_version') ?? null,
    status: 'frozen',
    frozen_at: event.at,
    frozen_by: frozenBy,
    frontier: reqString(event, payload, 'frontier'),
    baseline_hash: reqString(event, payload, 'baseline_hash'),
    scope_spec_set: reqString(event, payload, 'scope_spec_set'),
    note: optString(event, payload, 'note') ?? null,
  });
  materializeReleaseItems(state, event, id, payload);
}

export function releaseDelivered(state: FoldWorking, event: Event): void {
  const id = subjectId(event);
  const row = rowOf(state, 'release', id);
  if (row === undefined) {
    return fail(event, `release ${id} does not exist`);
  }
  if (row['status'] !== 'frozen') {
    return fail(event, `release ${id} must be frozen before delivery`);
  }
  upsert(state, 'release', id, {
    ...row,
    status: 'delivered',
    package_version: optString(event, payloadOf(event), 'package_version') ?? row['package_version'],
  });
}

/**
 * docs/09:145：回滚必须凭人签 decision(kind=rollback)；delivered 版必须带产物 sha256，
 * frozen 未交付版必须为 null。只改状态，不建 successor 行。
 */
export function releaseSuperseded(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  const row = rowOf(state, 'release', id);
  if (row === undefined) {
    return fail(event, `release ${id} does not exist`);
  }
  const status = String(row['status']);
  if (status !== 'frozen' && status !== 'delivered') {
    return fail(event, `release ${id} is ${status}; only frozen/delivered can be superseded`);
  }
  const releaseId = reqString(event, payload, 'release_id');
  if (releaseId !== id) {
    return fail(event, `payload.release_id ${releaseId} does not match release ${id}`);
  }
  const decisionId = reqString(event, payload, 'decision_id');
  const decision = requireSignedDecision(state, event, decisionId, 'rollback');
  const body = decisionPayload(decision);
  if (body === undefined) {
    return fail(event, `decision ${decisionId} must carry a payload`);
  }
  if (body['release_id'] !== id) {
    return fail(event, `decision ${decisionId} does not target release ${id}`);
  }
  const frontier = reqString(event, payload, 'frontier');
  if (String(row['frontier']) !== frontier) {
    return fail(event, `payload.frontier does not match release ${id} frontier`);
  }
  if (typeof body['frontier'] !== 'string') {
    return fail(event, `decision ${decisionId} payload.frontier must be a string`);
  }
  if (body['frontier'] !== frontier) {
    return fail(event, `decision ${decisionId} frontier mismatch with payload.frontier`);
  }
  const artifact = payload['artifact_sha256'];
  const signedArtifact = body['artifact_sha256'];
  if (status === 'delivered') {
    if (typeof artifact !== 'string' || artifact.length === 0) {
      return fail(event, 'release.superseded on delivered release requires payload.artifact_sha256');
    }
    if (signedArtifact !== artifact) {
      return fail(event, `decision ${decisionId} artifact_sha256 does not match the delivered artifact`);
    }
  } else {
    if (artifact !== null) {
      return fail(event, 'release.superseded on frozen release requires payload.artifact_sha256 = null');
    }
    if (signedArtifact !== null) {
      return fail(event, `decision ${decisionId} artifact_sha256 must be null for a frozen release`);
    }
  }
  upsert(state, 'release', id, { ...row, status: 'rolled_back' });
}

export const RELEASE_REDUCERS = {
  'release.frozen': releaseFrozen,
  'release.delivered': releaseDelivered,
  'release.superseded': releaseSuperseded,
} as const;
