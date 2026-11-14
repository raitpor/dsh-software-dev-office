import {
  createOnce,
  fail,
  optBool,
  optString,
  optStringArray,
  payloadOf,
  reqEnum,
  reqString,
  reqStringArray,
  rowOf,
  subjectId,
  upsert,
} from '../guards.js';
import type { Event, FoldWorking } from '../types.js';

const SPEC_KINDS = ['requirement', 'design', 'contract', 'impact', 'assumption'] as const;
const DIFF_KINDS = ['agree', 'missing', 'extra', 'conflict'] as const;
const DIFF_DISPOSITIONS = ['accept', 'reject', 'defer'] as const;

/** docs/03 spec 行；assumption 的 status 由 assumption 专用 reducer 管（本文件不写 payload.status）。 */
export function specRow(event: Event, id: string, kind: string): Record<string, unknown> {
  const payload = payloadOf(event);
  const mechCheckable = optBool(event, payload, 'mech_checkable');
  const scenarioId = optString(event, payload, 'scenario_id');
  if (mechCheckable === true && scenarioId === undefined) {
    fail(event, 'spec.mech_checkable=1 requires payload.scenario_id');
  }
  const blastRadius =
    optString(event, payload, 'blast_radius') ??
    (kind === 'assumption' ? fail(event, 'assumption requires payload.blast_radius') : null);
  return {
    id,
    kind,
    intent_id: optString(event, payload, 'intent_id') ?? null,
    clause: reqString(event, payload, 'clause'),
    mech_checkable: mechCheckable ?? false,
    scenario_id: scenarioId ?? null,
    is_core: optBool(event, payload, 'is_core') ?? false,
    status: kind === 'assumption' ? 'open' : null,
    blast_radius: blastRadius,
    created_by: optString(event, payload, 'created_by') ?? event.actor,
    producer: optString(event, payload, 'producer') ?? event.actor,
    content_hash: optString(event, payload, 'content_hash') ?? null,
    design_artifact_sha256: optString(event, payload, 'design_artifact_sha256') ?? null,
    code_artifact_sha256: null,
    code_artifact_ref: optString(event, payload, 'code_artifact_ref') ?? null,
    risk_flags: optStringArray(event, payload, 'risk_flags') ?? [],
    alternatives: optStringArray(event, payload, 'alternatives') ?? [],
    no_alternative_reason: optString(event, payload, 'no_alternative_reason') ?? null,
    at: event.at,
  };
}

function defineNewSpec(state: FoldWorking, event: Event, kind: string): void {
  const id = subjectId(event);
  createOnce(state, event, 'spec', id, specRow(event, id, kind));
}

export function specDefined(state: FoldWorking, event: Event): void {
  defineNewSpec(state, event, reqEnum(event, payloadOf(event), 'kind', SPEC_KINDS));
}

export function contractDefined(state: FoldWorking, event: Event): void {
  defineNewSpec(state, event, 'contract');
}

export function specRevised(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  const existing = rowOf(state, 'spec', id);
  if (existing === undefined) {
    return fail(event, `spec ${id} does not exist (define it first)`);
  }
  reqString(event, payload, 'reason');
  // 载荷契约：只改给出的字段，未重给的保留旧值（不重建整行）。
  const next: Record<string, unknown> = { ...existing };
  const has = (field: string): boolean => payload[field] !== undefined;
  if (has('clause')) next['clause'] = reqString(event, payload, 'clause');
  if (has('intent_id')) next['intent_id'] = optString(event, payload, 'intent_id') ?? null;
  if (has('mech_checkable')) next['mech_checkable'] = optBool(event, payload, 'mech_checkable') ?? false;
  if (has('scenario_id')) next['scenario_id'] = optString(event, payload, 'scenario_id') ?? null;
  if (has('is_core')) next['is_core'] = optBool(event, payload, 'is_core') ?? false;
  if (has('blast_radius')) next['blast_radius'] = reqString(event, payload, 'blast_radius');
  if (has('content_hash')) next['content_hash'] = optString(event, payload, 'content_hash') ?? null;
  if (has('design_artifact_sha256')) next['design_artifact_sha256'] = optString(event, payload, 'design_artifact_sha256') ?? null;
  if (has('code_artifact_ref')) next['code_artifact_ref'] = optString(event, payload, 'code_artifact_ref') ?? null;
  if (has('risk_flags')) next['risk_flags'] = reqStringArray(event, payload, 'risk_flags');
  if (has('alternatives')) next['alternatives'] = reqStringArray(event, payload, 'alternatives');
  if (has('no_alternative_reason')) next['no_alternative_reason'] = optString(event, payload, 'no_alternative_reason') ?? null;
  if (next['mech_checkable'] === true && next['scenario_id'] === null) {
    return fail(event, 'spec.mech_checkable=1 requires payload.scenario_id');
  }
  upsert(state, 'spec', id, { ...next, revised_at: event.at });
}

export function scopeDeclared(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  createOnce(state, event, 'scope_decl', id, {
    id,
    stage: reqString(event, payload, 'stage'),
    paths: reqStringArray(event, payload, 'paths'),
    created_by: optString(event, payload, 'created_by') ?? event.actor,
    at: event.at,
  });
}

export function designLocked(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  createOnce(state, event, 'design_lock', id, {
    id,
    spec_id: reqString(event, payload, 'spec_id'),
    spec_version_hash: reqString(event, payload, 'spec_version_hash'),
    design_sha256: reqString(event, payload, 'design_sha256'),
    at: event.at,
  });
}

export function restatementRecorded(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  createOnce(state, event, 'restatement', id, {
    id,
    intent_id: reqString(event, payload, 'intent_id'),
    draft_specs: payload['draft_specs'] ?? [],
    inputs: payload['inputs'] ?? [],
    by: optString(event, payload, 'by') ?? event.actor,
    at: event.at,
    invalid_reason: null,
    accepted_spec_ids: optStringArray(event, payload, 'accepted_spec_ids') ?? [],
  });
}

export function restatementDiffDispositioned(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const id = subjectId(event);
  const next = {
    id,
    restatement_id: reqString(event, payload, 'restatement_id'),
    kind: reqEnum(event, payload, 'kind', DIFF_KINDS),
    target_ref: reqString(event, payload, 'target_ref'),
    disposition: reqEnum(event, payload, 'disposition', DIFF_DISPOSITIONS),
    reason: optString(event, payload, 'reason') ?? null,
    at: event.at,
  };
  // D-039：同一 subject 的派生行只能出现一次；同内容幂等、不同内容显式拒绝，不静默覆盖。
  createOnce(state, event, 'restatement_diff', id, next);
}

export function restatementInvalidated(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  patchRestatement(state, event, reqString(event, payload, 'reason'));
}

function patchRestatement(state: FoldWorking, event: Event, reason: string): void {
  const id = subjectId(event);
  const row = rowOf(state, 'restatement', id);
  if (row === undefined) {
    return fail(event, `restatement ${id} does not exist`);
  }
  upsert(state, 'restatement', id, { ...row, invalid_reason: reason });
}

export const SPEC_REDUCERS = {
  'spec.defined': specDefined,
  'spec.revised': specRevised,
  'contract.defined': contractDefined,
  'scope.declared': scopeDeclared,
  'design.locked': designLocked,
  'restatement.recorded': restatementRecorded,
  'restatement.diff_dispositioned': restatementDiffDispositioned,
  'restatement.invalidated': restatementInvalidated,
} as const;
