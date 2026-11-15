import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { evaluateStageGate } from '../../../src/core/gate/evaluate.js';
import { emptyState } from '../../../src/core/fold/state.js';
import type { FoldState } from '../../../src/core/fold/types.js';

const baseline = (fixture: string) => {
  const file = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/baseline', fixture), 'utf8')) as Record<string, unknown>;
  return { id: String(file['id']), hash: String(file['hash']), policy: file['policy'], gates: file['gates'] };
};

const stateWith = (tables: Partial<Record<string, Record<string, Record<string, unknown>>>>): FoldState => {
  const s = emptyState();
  return {
    ...s,
    tables: { ...s.tables, ...tables } as FoldState['tables'],
  } as FoldState;
};

test('C3: 逐判据现算有效绑定，readings 覆盖 gate 内全部判据', () => {
  const result = evaluateStageGate(stateWith({}), baseline('waterfall.json'), 'req');
  assert.equal(result.stage, 'req');
  assert.equal(result.baseline_hash, String(baseline('waterfall.json')['hash']));
  assert.deepEqual(result.gate_ids, ['G_req_exit']);
  const ids = result.readings.map((r) => r.criterion_id);
  assert.ok(ids.includes('spec_set.signed'));
  assert.ok(ids.includes('provenance.present'));
  assert.equal(new Set(ids).size, ids.length, 'no duplicate criterion rows');
  for (const reading of result.readings) {
    if (reading.verdict === 'na') {
      assert.equal(reading.reason_code, 'not_enforced_in_m2', `${reading.criterion_id} na must be machine-visible`);
    }
  }
});

test('C4/C7: core 三条未生效 ⇒ changes_requested + core_not_effective', () => {
  const result = evaluateStageGate(stateWith({}), baseline('waterfall.json'), 'req');
  assert.equal(result.verdict, 'changes_requested');
  assert.ok(result.reasons.includes('core_not_effective'));
  const spec = result.readings.find((r) => r.criterion_id === 'spec_set.signed');
  assert.equal(spec?.verdict, 'fail', 'empty state cannot satisfy spec_set.signed');
});

test('C4: any_of 门不算有效绑定 ⇒ core 未生效', () => {
  const result = evaluateStageGate(stateWith({}), baseline('core-any-of.json'), 'req');
  assert.equal(result.verdict, 'changes_requested');
  const reading = result.readings.find((r) => r.criterion_id === 'spec_set.signed');
  assert.equal(reading?.effective, false);
  assert.ok(reading?.reasons.includes('policy_mode_any_of'));
});

test('C4: 可豁免 gate 不算有效绑定', () => {
  const result = evaluateStageGate(stateWith({}), baseline('core-waivable.json'), 'req');
  const reading = result.readings.find((r) => r.criterion_id === 'spec_set.signed');
  assert.equal(reading?.effective, false);
  assert.ok(reading?.reasons.includes('waivable_gate'));
  assert.equal(result.verdict, 'changes_requested');
});

test('C4: 检查点不连续（core 只在一个 stage 绑过）⇒ fail', () => {
  const result = evaluateStageGate(stateWith({}), baseline('core-unbound-stage.json'), 'deliver');
  assert.equal(result.verdict, 'changes_requested');
  assert.ok(result.reasons.includes('core_not_effective'));
});

test('C3: stage 不在 baseline policy ⇒ na/stage_unknown', () => {
  const result = evaluateStageGate(stateWith({}), baseline('waterfall.json'), 'nope');
  assert.equal(result.verdict, 'na');
  assert.deepEqual(result.reasons, ['stage_unknown']);
});

test('C6: 同一 fold 状态下 core 判据结果可复算（两次调用逐字节相同）', () => {
  const first = evaluateStageGate(stateWith({}), baseline('waterfall.json'), 'req');
  const second = evaluateStageGate(stateWith({}), baseline('waterfall.json'), 'req');
  assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
});
