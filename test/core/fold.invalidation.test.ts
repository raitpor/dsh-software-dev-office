import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rowHash } from '../../src/core/fold/canonical.js';
import { fold } from '../../src/core/fold/index.js';
import { TestFolder, validDecision } from './folder.js';

function statusOf(state: ReturnType<typeof fold>, id: string): unknown {
  return state.tables.spec[id]?.['status'];
}

test('P1-5 inputs 边按 hash 失效：确认后再改上游 ⇒ 回 open，幂等键只落一次', () => {
  const folder = new TestFolder();
  folder.push('spec.defined', 'SPEC-1', { kind: 'requirement', clause: 'v1' });
  const firstHash = rowHash(folder.fold().tables.spec['SPEC-1']!);
  validDecision(folder, 'd-a', 'assumption_set', {
    spec_ids: ['A-1'],
    dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }],
  });
  folder.push('assumption.recorded', 'A-1', {
    clause: 'depends on SPEC-1',
    blast_radius: 'core',
    inputs: [{ kind: 'spec', id: 'SPEC-1', hash: firstHash }],
  });
  folder.push('assumption.disposed', 'A-1', { decision_id: 'd-a', disposition: 'confirmed' });
  assert.equal(statusOf(folder.fold(), 'A-1'), 'confirmed');

  folder.push('spec.revised', 'SPEC-1', { clause: 'v2', reason: 'upstream changed' });
  const state = folder.fold();
  assert.equal(statusOf(state, 'A-1'), 'open');
  assert.equal(state.tables.spec['A-1']?.['invalidated_reason'], 'inputs hash changed');
  const keys = state.invalidatedKeys;
  assert.equal(keys.length, 1);
  assert.equal(keys[0]?.split('|').length, 3, '幂等键是 spec_id|input_id|旧 hash');

  const replay = fold(state, []);
  assert.deepEqual(replay.invalidatedKeys, keys);
});

test('P1-5 回 open 后按新 hash 重建边：下一次上游变更又是新键', () => {
  const folder = new TestFolder();
  folder.push('spec.defined', 'SPEC-1', { kind: 'requirement', clause: 'v1' });
  const h1 = rowHash(folder.fold().tables.spec['SPEC-1']!);
  folder.push('assumption.recorded', 'A-1', {
    clause: 'a', blast_radius: 'core', inputs: [{ kind: 'spec', id: 'SPEC-1', hash: h1 }],
  });
  folder.push('spec.revised', 'SPEC-1', { clause: 'v2', reason: 'one' });
  const afterFirst = folder.fold();
  const h2 = rowHash(afterFirst.tables.spec['SPEC-1']!);
  assert.notEqual(h1, h2);
  folder.push('spec.revised', 'SPEC-1', { clause: 'v3', reason: 'two' });
  const afterSecond = folder.fold();
  assert.equal(afterSecond.invalidatedKeys.length, 2);
  assert.equal(statusOf(afterSecond, 'A-1'), 'open');
});

test('P1-5 与 assumption 无关的事件不触发失效', () => {
  const folder = new TestFolder();
  folder.push('spec.defined', 'SPEC-1', { kind: 'requirement', clause: 'v1' });
  const h = rowHash(folder.fold().tables.spec['SPEC-1']!);
  folder.push('assumption.recorded', 'A-1', {
    clause: 'a', blast_radius: 'core', inputs: [{ kind: 'spec', id: 'SPEC-1', hash: h }],
  });
  folder.push('task.created', 'TASK-1', { seq: 1, title: 't', kind: 'implement' });
  const state = folder.fold();
  assert.equal(state.invalidatedKeys.length, 0);
  assert.equal(statusOf(state, 'A-1'), 'open');
});
