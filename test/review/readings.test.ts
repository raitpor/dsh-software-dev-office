import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectClauseReadings,
  renderSpecSetPayload,
  verifySpecSetPayload,
  type SpecSetPayload,
} from '../../src/review/index.js';
import { criterionRow, makeState, specRow, stageRow } from './state-helpers.js';

const SPEC_AT = '2026-11-13T00:00:00Z';
const READ_AT = '2026-11-14T10:00:00Z';
const ALIGN = 'alignment.examples_present';
const REDTEAM = 'redteam.disposed';

function readyState(readings: ReadonlyArray<{ criterion: string; verdict: 'pass' | 'na' }> = [
  { criterion: ALIGN, verdict: 'pass' },
]) {
  return makeState({
    spec: { 'SPEC-1': specRow('SPEC-1', 'requirement', SPEC_AT) },
    criterion: {
      [ALIGN]: criterionRow(ALIGN, 'SPEC-1'),
      [REDTEAM]: criterionRow(REDTEAM, 'SPEC-1'),
    },
    stage_run: { 'SR-1': stageRow('SR-1', READ_AT, readings) },
  });
}

const FRONTIER = ['e-1', 'e-2'];

function renderOk(state = readyState(), frontier: readonly string[] = FRONTIER): SpecSetPayload {
  const rendered = renderSpecSetPayload(state, { spec_ids: ['SPEC-1'], as_of_frontier: [...frontier] });
  assert.equal(rendered.ok, true, rendered.ok ? '' : rendered.message);
  if (!rendered.ok) throw new Error('render failed');
  return rendered.payload;
}

test('C5 渲染 clause_readings/readings_hash/content_hash（六字段、确定性）', () => {
  const state = readyState();
  const payload = renderOk(state);
  assert.equal(payload.decision_kind, 'spec_set');
  assert.deepEqual(payload.spec_ids, ['SPEC-1']);
  assert.deepEqual(payload.dispositions, []);
  assert.deepEqual(payload.as_of_frontier, FRONTIER);
  assert.equal(payload.clause_readings.length, 1);
  const reading = payload.clause_readings[0]!;
  assert.deepEqual(Object.keys(reading).sort(), [
    'criterion',
    'data_hash',
    'spec_id',
    'spec_version_hash',
    'stage_run_id',
    'verdict',
  ]);
  assert.equal(reading.spec_id, 'SPEC-1');
  assert.equal(reading.criterion, ALIGN);
  assert.equal(reading.verdict, 'pass');
  assert.equal(reading.stage_run_id, 'SR-1');
  assert.match(reading.spec_version_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(reading.data_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(payload.readings_hash, /^sha256:[0-9a-f]{64}$/);
  assert.match(payload.content_hash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(payload, renderOk(state), '同输入两次渲染逐字段相同');
  assert.deepEqual(verifySpecSetPayload(payload), { ok: true });
});

test('C5 多条读数按 (spec_id, criterion) 稳定排序', () => {
  const state = readyState([
    { criterion: REDTEAM, verdict: 'na' },
    { criterion: ALIGN, verdict: 'pass' },
  ]);
  const payload = renderOk(state);
  assert.deepEqual(payload.clause_readings.map((reading) => reading.criterion), [ALIGN, REDTEAM]);
  const collected = collectClauseReadings(state, ['SPEC-1']);
  assert.equal(collected.ok, true);
  assert.deepEqual(payload, renderOk(state));
});

test('C5 模型无写入口：调用方自带 clause_readings/readings_hash/content_hash 一律拒', () => {
  const state = readyState();
  for (const extra of [
    { clause_readings: [] },
    { readings_hash: 'sha256:00' },
    { content_hash: 'sha256:00' },
  ]) {
    const result = renderSpecSetPayload(state, {
      spec_ids: ['SPEC-1'],
      as_of_frontier: FRONTIER,
      ...extra,
    });
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.reason_code, 'invalid_field', JSON.stringify(extra));
  }
});

test('C5 spec_ids 必须恰好是当前全部 requirement', () => {
  const state = readyState();
  for (const specIds of [[], ['SPEC-1', 'SPEC-2']]) {
    const result = renderSpecSetPayload(state, { spec_ids: specIds, as_of_frontier: FRONTIER });
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.reason_code, 'spec_ids_mismatch');
  }
});

test('C5 无读数 / 无 requirement ⇒ 结构化失败', () => {
  const noReading = makeState({
    spec: { 'SPEC-1': specRow('SPEC-1', 'requirement', SPEC_AT) },
    criterion: { [ALIGN]: criterionRow(ALIGN, 'SPEC-1') },
    stage_run: { 'SR-1': stageRow('SR-1', READ_AT, []) },
  });
  const missing = renderSpecSetPayload(noReading, { spec_ids: ['SPEC-1'], as_of_frontier: FRONTIER });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason_code, 'clause_unjudged');

  const empty = makeState({});
  const none = renderSpecSetPayload(empty, { spec_ids: [], as_of_frontier: FRONTIER });
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.reason_code, 'no_requirement');
});

test('C5 手改任一字段 ⇒ 哈希不复算通过（签名失效）', () => {
  const payload = renderOk();
  const tamperedReadings = structuredClone(payload) as unknown as {
    clause_readings: Array<Record<string, unknown>>;
  };
  tamperedReadings.clause_readings[0]!['verdict'] = 'fail';
  const first = verifySpecSetPayload(tamperedReadings);
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.reason_code, 'readings_hash_mismatch');

  const tamperedHash = structuredClone(payload) as unknown as Record<string, unknown>;
  tamperedHash['readings_hash'] = 'sha256:0000';
  const second = verifySpecSetPayload(tamperedHash);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason_code, 'readings_hash_mismatch');

  // 改 spec_ids 后 clause_readings 不再覆盖声明集合 ⇒ 先报“不完整”（P1 的防线先于 hash 复算）。
  const tamperedIds = structuredClone(payload) as unknown as Record<string, unknown>;
  tamperedIds['spec_ids'] = ['SPEC-OTHER'];
  const third = verifySpecSetPayload(tamperedIds);
  assert.equal(third.ok, false);
  if (!third.ok) assert.equal(third.reason_code, 'clause_readings_incomplete');

  const tamperedDisposition = structuredClone(payload) as unknown as Record<string, unknown>;
  tamperedDisposition['dispositions'] = [{ subject: 'SPEC-1', verdict: 'accept' }];
  const fourth = verifySpecSetPayload(tamperedDisposition);
  assert.equal(fourth.ok, false);
  if (!fourth.ok) assert.equal(fourth.reason_code, 'content_hash_mismatch');
});

test('C5 每条 requirement 都要有读数：一条缺读数 ⇒ clause_unjudged；verify 也拒', () => {
  const state = makeState({
    spec: {
      'SPEC-1': specRow('SPEC-1', 'requirement', SPEC_AT),
      'SPEC-2': specRow('SPEC-2', 'requirement', SPEC_AT),
    },
    criterion: { [ALIGN]: criterionRow(ALIGN, 'SPEC-1') },
    stage_run: { 'SR-1': stageRow('SR-1', READ_AT, [{ criterion: ALIGN, verdict: 'pass' }]) },
  });
  const rendered = renderSpecSetPayload(state, { spec_ids: ['SPEC-1', 'SPEC-2'], as_of_frontier: FRONTIER });
  assert.equal(rendered.ok, false);
  if (rendered.ok) return;
  assert.equal(rendered.reason_code, 'clause_unjudged');
  assert.match(rendered.message, /SPEC-2/);

  // 手工构造“只覆盖 SPEC-1 却声称 spec_ids 两条”的载荷：verify 必须拒。
  const tampered = structuredClone(renderOk()) as unknown as Record<string, unknown>;
  (tampered['spec_ids'] as string[]).push('SPEC-2');
  const verified = verifySpecSetPayload(tampered);
  assert.equal(verified.ok, false);
  if (verified.ok) return;
  assert.equal(verified.reason_code, 'clause_readings_incomplete');
});
