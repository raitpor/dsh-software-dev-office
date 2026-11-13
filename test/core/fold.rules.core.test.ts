import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fold } from '../../src/core/fold/index.js';
import { eventFactory, signedDecision } from './helpers.js';
import { expectFoldFail, TestFolder, validDecision } from './folder.js';

test('规则 intent.signed：正例签字落行；反例缺 content_hash/缺决策/重复签字被拒', () => {
  const t = new TestFolder();
  validDecision(t);
  t.push('intent.signed', 'INT-1', {
    decision_id: 'd-1', statement: 's', owner: 'alice', strength: 'explicit', content_hash: 'ch-1',
  });
  const intent = t.fold().tables.intent['INT-1'];
  assert.equal(intent?.['status'], 'signed');
  assert.equal(intent?.['decision_id'], 'd-1');
  assert.equal(intent?.['content_hash'], 'ch-1');

  const noHash = new TestFolder();
  validDecision(noHash);
  noHash.push('intent.signed', 'INT-1', {
    decision_id: 'd-1', statement: 's', owner: 'alice', strength: 'explicit',
  });
  expectFoldFail(() => noHash.fold(), /payload\.content_hash/);

  const badDecision = new TestFolder();
  badDecision.push('intent.signed', 'INT-1', {
    decision_id: 'd-missing', statement: 's', owner: 'alice', strength: 'explicit', content_hash: 'ch-1',
  });
  expectFoldFail(() => badDecision.fold(), /decision d-missing does not exist/);

  const duplicate = new TestFolder();
  validDecision(duplicate);
  duplicate.push('intent.signed', 'INT-1', {
    decision_id: 'd-1', statement: 's', owner: 'alice', strength: 'explicit', content_hash: 'ch-1',
  });
  duplicate.push('intent.signed', 'INT-1', {
    decision_id: 'd-1', statement: 's2', owner: 'alice', strength: 'inferred', content_hash: 'ch-2',
  });
  expectFoldFail(() => duplicate.fold(), /already signed/);
});

test('规则 spec.defined：正例建条款；反例 mech_checkable=1 缺 scenario_id 被拒', () => {
  const ok = new TestFolder();
  ok.push('spec.defined', 'SPEC-1', { intent_id: 'INT-1', clause: 'c', kind: 'requirement' });
  assert.equal(ok.fold().tables.spec['SPEC-1']?.['clause'], 'c');

  const bad = new TestFolder();
  bad.push('spec.defined', 'SPEC-1', { clause: 'c', kind: 'requirement', mech_checkable: true });
  expectFoldFail(() => bad.fold(), /scenario_id/);
});

test('规则 assumption.recorded/disposed：正例有效且覆盖的 decision 才改状态；反例无效 decision ⇒ FoldError', () => {
  const ok = new TestFolder();
  validDecision(ok, 'd-a', 'assumption_set', {
    spec_ids: ['A-1'],
    dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }],
  });
  ok.push('assumption.recorded', 'A-1', { clause: 'assumption clause', blast_radius: 'core' });
  ok.push('assumption.disposed', 'A-1', { decision_id: 'd-a', disposition: 'confirmed' });
  assert.equal(ok.fold().tables.spec['A-1']?.['status'], 'confirmed');

  const noValidDecision = new TestFolder();
  noValidDecision.push('assumption.recorded', 'A-1', { clause: 'c', blast_radius: 'core' });
  noValidDecision.push('assumption.disposed', 'A-1', { decision_id: 'd-missing', disposition: 'confirmed' });
  expectFoldFail(() => noValidDecision.fold(), /decision d-missing does not exist/);

  const uncovered = new TestFolder();
  validDecision(uncovered, 'd-b', 'assumption_set', {
    spec_ids: ['OTHER'],
    dispositions: [{ spec_id: 'OTHER', disposition: 'confirmed' }],
  });
  uncovered.push('assumption.recorded', 'A-1', { clause: 'c', blast_radius: 'core' });
  uncovered.push('assumption.disposed', 'A-1', { decision_id: 'd-b', disposition: 'confirmed' });
  expectFoldFail(() => uncovered.fold(), /does not cover assumption A-1/);

  const noBlast = new TestFolder();
  noBlast.push('assumption.recorded', 'A-1', { clause: 'c' });
  expectFoldFail(() => noBlast.fold(), /blast_radius/);

  const statusPayload = new TestFolder();
  statusPayload.push('assumption.recorded', 'A-1', { clause: 'c', blast_radius: 'core', status: 'confirmed' });
  expectFoldFail(() => statusPayload.fold(), /must not carry payload.status/);
});

test('规则 goal.declared：正例根节点；反例同一 intent 第二个根被拒', () => {
  const { ev } = eventFactory('goal');
  const d = signedDecision(ev, 'd-1', 'plan', {
    node_ids: ['GOAL-1', 'GOAL-2'],
    tree: [
      { id: 'GOAL-1', parent_id: null, kind: 'intent', goal: 'root' },
      { id: 'GOAL-2', parent_id: null, kind: 'intent', goal: 'root2' },
    ],
  });
  const di = signedDecision(ev, 'd-i', 'intent');
  const i = ev('intent.signed', 'INT-1', {
    decision_id: 'd-i', statement: 's', owner: 'o', strength: 'explicit', content_hash: 'ch-1',
  });
  const root = ev('goal.declared', 'GOAL-1', { kind: 'intent', intent_id: 'INT-1', decision_id: 'd-1', goal: 'root' });
  assert.equal(fold(undefined, [...di, i, ...d, root]).tables.goal_node['GOAL-1']?.['kind'], 'intent');

  const second = ev('goal.declared', 'GOAL-2', { kind: 'intent', intent_id: 'INT-1', decision_id: 'd-1', goal: 'root2' });
  assert.throws(() => fold(undefined, [...di, i, ...d, root, second]), /already has root goal/);
});

test('规则 task.created/claimed/blocked/unblocked：正例生命周期；反例非法 block_code 被拒', () => {
  const ok = new TestFolder();
  ok.push('task.created', 'TASK-1', { seq: 1, title: 'card', kind: 'implement' });
  ok.push('task.claimed', 'TASK-1', {});
  ok.push('task.blocked', 'TASK-1', { block_code: 'verify_failed', reason: 'red' });
  ok.push('task.unblocked', 'TASK-1', {});
  const task = ok.fold().tables.task['TASK-1'];
  assert.equal(task?.['status'], 'ready');
  assert.equal(task?.['block_code'], null);

  const bad = new TestFolder();
  bad.push('task.created', 'TASK-1', { seq: 1, title: 'card', kind: 'implement' });
  bad.push('task.blocked', 'TASK-1', { block_code: 'made_up' });
  expectFoldFail(() => bad.fold(), /block_code/);
});

test('规则 task.dependencies_changed：正例改依赖；反例成环被拒', () => {
  const ok = new TestFolder();
  ok.push('task.created', 'TASK-1', { seq: 1, title: 'a', kind: 'implement' });
  ok.push('task.created', 'TASK-2', { seq: 2, title: 'b', kind: 'implement', blocked_by: ['TASK-1'] });
  assert.deepEqual(ok.fold().tables.task['TASK-2']?.['blocked_by'], ['TASK-1']);

  const cycle = new TestFolder();
  cycle.push('task.created', 'TASK-1', { seq: 1, title: 'a', kind: 'implement', blocked_by: ['TASK-2'] });
  cycle.push('task.created', 'TASK-2', { seq: 2, title: 'b', kind: 'implement', blocked_by: ['TASK-1'] });
  cycle.push('task.dependencies_changed', 'TASK-1', { blocked_by: ['TASK-2', 'TASK-1'] });
  expectFoldFail(() => cycle.fold(), /dependency cycle/);
});
