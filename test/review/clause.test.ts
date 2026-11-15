import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PRE_WORK_CRITERIA, checkAdmission, clauseUnjudgedTasks, latestPreWorkReading, preWorkReadingsForSpec } from '../../src/review/index.js';
import { criterionRow, makeState, specRow, stageRow, taskRow } from './state-helpers.js';

const SPEC_AT = '2026-11-13T00:00:00Z';
const READ_AT = '2026-11-14T10:00:00Z';
const ALIGN = 'alignment.examples_present';

function base(overrides: {
  readonly revisedAt?: string | null;
  readonly judgeAt?: string;
  readonly verdict?: 'pass' | 'na';
  readonly extraReadings?: ReadonlyArray<{ criterion: string; verdict: 'pass' | 'fail' | 'na' }>;
} = {}) {
  const readings = [{ criterion: ALIGN, verdict: overrides.verdict ?? 'na' }, ...(overrides.extraReadings ?? [])];
  return makeState({
    task: {
      T1: taskRow('T1', 1, ['spec:SPEC-1']),
      T2: taskRow('T2', 2, ['criterion:CRIT-1']),
      T3: taskRow('T3', 3, ['requirement:SPEC-1']),
    },
    spec: {
      'SPEC-1': specRow('SPEC-1', 'requirement', SPEC_AT, overrides.revisedAt ?? null),
      'SPEC-2': specRow('SPEC-2', 'requirement', SPEC_AT),
    },
    criterion: {
      [ALIGN]: criterionRow(ALIGN, 'SPEC-1'),
      'CRIT-1': criterionRow('CRIT-1', 'SPEC-1'),
    },
    stage_run: {
      'SR-1': stageRow('SR-1', overrides.judgeAt ?? READ_AT, readings),
    },
  });
}

test('C4 四情况：无读数 / 读数早于修订 / 读数晚于修订 / 未被引用', () => {
  // 有读数、无修订 ⇒ 通过
  assert.equal(checkAdmission(base(), 'T1').ok, true);

  // 无读数：删掉 stage_run 判定
  const noReading = makeState({
    task: { T1: taskRow('T1', 1, ['spec:SPEC-1']) },
    spec: { 'SPEC-1': specRow('SPEC-1', 'requirement', SPEC_AT) },
    criterion: { [ALIGN]: criterionRow(ALIGN, 'SPEC-1') },
    stage_run: { 'SR-1': stageRow('SR-1', READ_AT, []) },
  });
  const missing = checkAdmission(noReading, 'T1');
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.deepEqual(missing.details, [{
    spec_id: 'SPEC-1',
    cause: 'no_reading',
    revised_at: SPEC_AT,
  }]);

  // 读数早于修订（条款晚到）⇒ reading_before_revision
  const late = base({ revisedAt: '2026-11-14T11:00:00Z' });
  const stale = checkAdmission(late, 'T1');
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.reason_code, 'clause_unjudged');
  assert.deepEqual(stale.details, [{
    spec_id: 'SPEC-1',
    cause: 'reading_before_revision',
    revised_at: '2026-11-14T11:00:00Z',
    reading_at: READ_AT,
  }]);

  // 读数晚于修订 ⇒ 通过
  const fixed = base({ revisedAt: '2026-11-14T09:00:00Z', judgeAt: READ_AT });
  assert.equal(checkAdmission(fixed, 'T1').ok, true);

  // 未被引用的条款：无读数也不算未判
  assert.deepEqual(clauseUnjudgedTasks(base(), 'SPEC-2'), []);
});

test('C4 只查 pre-work 类判据：post-work 读数不能替条款解围', () => {
  const state = makeState({
    task: { T1: taskRow('T1', 1, ['spec:SPEC-1']) },
    spec: { 'SPEC-1': specRow('SPEC-1', 'requirement', SPEC_AT) },
    criterion: { 'task.complete': criterionRow('task.complete', 'SPEC-1') },
    stage_run: { 'SR-1': stageRow('SR-1', READ_AT, [{ criterion: 'task.complete', verdict: 'pass' }]) },
  });
  assert.equal(PRE_WORK_CRITERIA.includes('task.complete' as never), false);
  const result = checkAdmission(state, 'T1');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.details.map((detail) => detail.cause), ['no_reading']);
});

test('C4 na 也是读数（门禁在 M2 对 non-core 判 na，那是判过、不是没判）', () => {
  const state = base({ verdict: 'na' });
  const readings = preWorkReadingsForSpec(state, 'SPEC-1');
  assert.equal(readings.length, 1);
  assert.equal(readings[0]?.verdict, 'na');
  assert.equal(checkAdmission(state, 'T1').ok, true);
});

test('C6 改一条被 3 张卡引用的 requirement ⇒ 3 张都因读数陈旧被点名（复用 C4 判定）', () => {
  const state = base({ revisedAt: '2026-11-14T11:00:00Z' });
  assert.deepEqual(clauseUnjudgedTasks(state, 'SPEC-1'), ['T1', 'T2', 'T3']);
  for (const taskId of ['T1', 'T2', 'T3']) {
    assert.equal(checkAdmission(state, taskId).ok, false, `${taskId} must be blocked`);
  }
  // 未受影响的任务/条款不受牵连
  assert.deepEqual(clauseUnjudgedTasks(state, 'SPEC-2'), []);
});

test('C4 task 不存在 ⇒ task_not_found（结构化，不抛裸异常）', () => {
  assert.deepEqual(checkAdmission(base(), 'T-NOPE'), { ok: false, reason_code: 'task_not_found', details: [] });
});

test('C4 时区偏移按真实时刻：修订 05:30-05:00（=10:30Z）晚于 10:00Z 读数 ⇒ clause_unjudged', () => {
  // 字符串序会把 `05:30` 排在 `10:00` 之前而误放行；必须按 Date.parse 比较。
  const state = base({ revisedAt: '2026-11-14T05:30:00-05:00', judgeAt: READ_AT });
  const result = checkAdmission(state, 'T1');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason_code, 'clause_unjudged');
  assert.deepEqual(result.details, [{
    spec_id: 'SPEC-1',
    cause: 'reading_before_revision',
    revised_at: '2026-11-14T05:30:00-05:00',
    reading_at: READ_AT,
  }]);
});

test('C6 评审卡不计入重判点名（卡面“恰好 3 张”口径）', () => {
  const state = makeState({
    task: {
      T1: taskRow('T1', 1, ['spec:SPEC-1']),
      T2: taskRow('T2', 2, ['criterion:CRIT-1']),
      T3: taskRow('T3', 3, ['requirement:SPEC-1']),
      T4: taskRow('T4', 4, ['spec:SPEC-1'], { kind: 'review' }),
    },
    spec: { 'SPEC-1': specRow('SPEC-1', 'requirement', SPEC_AT, '2026-11-14T11:00:00Z') },
    criterion: { [ALIGN]: criterionRow(ALIGN, 'SPEC-1'), 'CRIT-1': criterionRow('CRIT-1', 'SPEC-1') },
    stage_run: { 'SR-1': stageRow('SR-1', READ_AT, [{ criterion: ALIGN, verdict: 'na' }]) },
  });
  assert.deepEqual(clauseUnjudgedTasks(state, 'SPEC-1'), ['T1', 'T2', 'T3']);
});

test('C4 多条读数按真实时刻取最新（-05:00 偏移 vs Z；排序层不能再用字符串序）', () => {
  // 实际最新读数：05:30-05:00 = 10:30Z（pass）；另一条 10:00Z（fail）；修订 10:15Z。
  // 字符串序会把 05:30 排前、取 10:00Z 的 fail ⇒ 误报 clause_unjudged。
  const state = makeState({
    task: { T1: taskRow('T1', 1, ['spec:SPEC-1']) },
    spec: { 'SPEC-1': specRow('SPEC-1', 'requirement', SPEC_AT, '2026-11-14T10:15:00Z') },
    criterion: { [ALIGN]: criterionRow(ALIGN, 'SPEC-1') },
    stage_run: {
      'SR-OFFSET': stageRow('SR-OFFSET', '2026-11-14T05:30:00-05:00', [{ criterion: ALIGN, verdict: 'pass' }]),
      'SR-Z': stageRow('SR-Z', READ_AT, [{ criterion: ALIGN, verdict: 'fail' }]),
    },
  });
  assert.equal(checkAdmission(state, 'T1').ok, true);
  assert.equal(latestPreWorkReading(state, 'SPEC-1')?.verdict, 'pass');
});
