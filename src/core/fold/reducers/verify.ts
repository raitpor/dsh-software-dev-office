import {
  createOnce,
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
  const remedy = reqString(event, payload, 'remedy');
  createOnce(state, event, 'criterion', id, {
    id,
    spec_id: reqString(event, payload, 'spec_id'),
    kind: optString(event, payload, 'kind') ?? null,
    status_enum: optString(event, payload, 'status_enum') ?? 'draft',
    remedy,
    at: event.at,
  });
  // P1-3：唯一写路径上的机械门——新建判据必须带 >=1 正例 + >=1 负例夹具。
  // 迁移例外 `legacy: true` 只给 M1-6 的 v1 导入用，且由 verify 的 legacy 计数暴露。
  const legacy = payload['legacy'] === true;
  const fixtures = payload['fixtures'];
  if (fixtures === undefined) {
    if (!legacy) {
      return fail(event, 'criterion.registered requires fixtures[] with >=1 positive and >=1 negative');
    }
  } else {
    if (!Array.isArray(fixtures)) return fail(event, 'criterion.registered fixtures must be an array');
    const seen = new Set<string>();
    let positives = 0;
    let negatives = 0;
    fixtures.forEach((fixture, index) => {
      if (fixture === null || typeof fixture !== 'object') {
        return fail(event, `fixtures[${index}] must be an object`);
      }
      const raw = fixture as Record<string, unknown>;
      const polarity = raw['polarity'];
      if (polarity !== 'positive' && polarity !== 'negative') {
        return fail(event, `fixtures[${index}].polarity must be positive|negative`);
      }
      const input = raw['input'];
      if (typeof input !== 'string' || input.length === 0) {
        return fail(event, `fixtures[${index}].input must be a non-empty string`);
      }
      const expected = raw['expected_status'];
      if (expected !== 'pass' && expected !== 'fail' && expected !== 'na') {
        return fail(event, `fixtures[${index}].expected_status must be pass|fail|na`);
      }
      const key = `${polarity}\u0000${input}`;
      if (seen.has(key)) return fail(event, `duplicate fixture ${polarity}:${input}`);
      seen.add(key);
      if (polarity === 'positive') positives += 1;
      else negatives += 1;
      upsert(state, 'criterion_fixture', `${id}/fx/${index + 1}`, {
        id: `${id}/fx/${index + 1}`,
        criterion_id: id,
        polarity,
        input,
        expected_status: expected,
      });
    });
    if (!legacy && (positives === 0 || negatives === 0)) {
      return fail(event, 'criterion.registered requires fixtures[] with >=1 positive and >=1 negative');
    }
  }
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
  createOnce(state, event, 'evidence', id, {
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
  createOnce(state, event, 'stage_run', id, {
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
  const existing = rowOf(state, 'stage_run', subjectId(event));
  const gateId = optString(event, payload, 'gate_id') ?? (existing?.['gate_id'] as string | undefined);
  const baselineHash = optString(event, payload, 'baseline_hash') ?? (existing?.['baseline_hash'] as string | undefined);
  if (gateId === undefined || gateId === null || gateId.length === 0) {
    return fail(event, 'gate.judged requires gate_id (none on stage.entered either)');
  }
  if (baselineHash === undefined || baselineHash === null || baselineHash.length === 0) {
    return fail(event, 'gate.judged requires baseline_hash (none on stage.entered either)');
  }
  patchRow(state, 'stage_run', subjectId(event), event, {
    verdict: reqEnum(event, payload, 'verdict', VERDICTS),
    gate_id: gateId,
    baseline_hash: baselineHash,
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
