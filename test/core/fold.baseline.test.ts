import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rowHash } from '../../src/core/fold/canonical.js';
import { type FoldState } from '../../src/core/fold/index.js';
import { expectFoldFail, TestFolder, validDecision } from './folder.js';

const ENGINE = { version: 'sdo-engine/1', criteria_manifest_hash: 'cm-1' };

function baselinePayload(hash: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash,
    engine: ENGINE,
    policy: {},
    criteria: [],
    gates: {},
    thresholds: {},
    assurance: {},
    ...extra,
  };
}

function row(state: FoldState, id: string): Record<string, unknown> {
  const value = state.tables.baseline[id];
  assert.ok(value !== undefined, `baseline ${id} missing`);
  return value;
}

test('P1-1 baseline.loosened：放宽落新行（prev + direction），旧行 hash 不变', () => {
  const folder = new TestFolder();
  folder.push('baseline.frozen', 'B-1', baselinePayload('h-baseline-1'));
  const hashBefore = rowHash(row(folder.fold(), 'B-1'));
  validDecision(folder, 'd-base', 'baseline');
  folder.push('baseline.loosened', 'B-2', baselinePayload('h-baseline-2', {
    prev: 'B-1',
    direction: 'loosen',
    decision_id: 'd-base',
  }));
  const state = folder.fold();
  assert.equal(row(state, 'B-2')['prev'], 'B-1');
  assert.equal(row(state, 'B-2')['direction'], 'loosen');
  assert.equal(row(state, 'B-2')['hash'], 'h-baseline-2');
  assert.equal(rowHash(row(state, 'B-1')), hashBefore, '旧行必须原地不动，hash 可复算');
  assert.equal(row(state, 'B-2')['criteria_manifest_hash'], 'cm-1');
});

test('P1-1 baseline.loosened 无有效 decision ⇒ FoldError（放宽必须事前签）', () => {
  const folder = new TestFolder();
  folder.push('baseline.frozen', 'B-1', baselinePayload('h-1'));
  folder.push('baseline.loosened', 'B-2', baselinePayload('h-2', {
    prev: 'B-1', direction: 'loosen', decision_id: 'd-missing',
  }));
  expectFoldFail(() => folder.fold(), /decision d-missing does not exist/);
});

test('P1-1 baseline.amended 只收收紧：direction=loosen 被拒', () => {
  const folder = new TestFolder();
  folder.push('baseline.frozen', 'B-1', baselinePayload('h-1'));
  folder.push('baseline.amended', 'B-2', baselinePayload('h-2', {
    prev: 'B-1', direction: 'loosen',
  }));
  expectFoldFail(() => folder.fold(), /only records tighten/);
});

test('P1-1 baseline.frozen 缺 engine、二次 frozen、重复 id ⇒ FoldError', () => {
  const noEngine = new TestFolder();
  noEngine.push('baseline.frozen', 'B-1', { hash: 'h' });
  expectFoldFail(() => noEngine.fold(), /payload.engine/);

  const frozenTwice = new TestFolder();
  frozenTwice.push('baseline.frozen', 'B-1', baselinePayload('h-1'));
  frozenTwice.push('baseline.frozen', 'B-2', baselinePayload('h-2'));
  expectFoldFail(() => frozenTwice.fold(), /only for the first baseline/);

  const duplicate = new TestFolder();
  duplicate.push('baseline.frozen', 'B-1', baselinePayload('h-1'));
  validDecision(duplicate, 'd-base', 'baseline');
  duplicate.push('baseline.amended', 'B-1', baselinePayload('h-2', {
    prev: 'B-1', direction: 'tighten', decision_id: 'd-base',
  }));
  expectFoldFail(() => duplicate.fold(), /already exists; amendments are new rows/);
});
