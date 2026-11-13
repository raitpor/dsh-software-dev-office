import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fold, FoldError } from '../../src/core/fold/index.js';
import { rowHash } from '../../src/core/fold/canonical.js';
import { eventFactory } from './helpers.js';
import { expectFoldFail, signedIntent, TestFolder, validDecision } from './folder.js';

const ENGINE = { version: 'sdo-engine/1', criteria_manifest_hash: 'cm-1' };

test('P1-1 assumption.disposed 的覆盖名单只认签名载荷，事件回填即拒', () => {
  const folder = new TestFolder();
  validDecision(folder, 'd-other', 'assumption_set', {
    spec_ids: ['A-OTHER'],
    dispositions: [{ spec_id: 'A-OTHER', disposition: 'confirmed' }],
  });
  folder.push('assumption.recorded', 'A-1', { clause: 'c', blast_radius: 'core' });
  folder.push('assumption.disposed', 'A-1', {
    decision_id: 'd-other',
    disposition: 'confirmed',
    covered_spec_ids: ['A-1'],
    dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }],
  });
  expectFoldFail(() => folder.fold(), /must not carry coverage lists/);
});

test('P1-2 goal.reparented 把新 decision_id 写回节点；缺 decision 仍拒', () => {
  const folder = new TestFolder();
  validDecision(folder, 'd-1', 'plan', {
    node_ids: ['GOAL-1', 'GOAL-2', 'GOAL-3'],
    tree: [
      { id: 'GOAL-1', parent_id: null, kind: 'intent', goal: 'root' },
      { id: 'GOAL-2', parent_id: 'GOAL-1', kind: 'part', goal: 'p2' },
      { id: 'GOAL-3', parent_id: 'GOAL-1', kind: 'part', goal: 'p3' },
    ],
  });
  signedIntent(folder, 'INT-1');
  folder.push('goal.declared', 'GOAL-1', { kind: 'intent', intent_id: 'INT-1', decision_id: 'd-1', goal: 'root' });
  folder.push('goal.declared', 'GOAL-2', { kind: 'part', parent_id: 'GOAL-1', decision_id: 'd-1', goal: 'p2' });
  folder.push('goal.declared', 'GOAL-3', { kind: 'part', parent_id: 'GOAL-1', decision_id: 'd-1', goal: 'p3' });
  validDecision(folder, 'd-2', 'plan', {
    node_ids: ['GOAL-2'],
    tree: [{ id: 'GOAL-2', parent_id: 'GOAL-3', kind: 'part', goal: 'p2' }],
  });
  folder.push('goal.reparented', 'GOAL-2', { parent_id: 'GOAL-3', decision_id: 'd-2' });
  assert.equal(folder.fold().tables.goal_node['GOAL-2']?.['decision_id'], 'd-2');

  const missing = new TestFolder();
  validDecision(missing, 'd-1', 'plan', {
    node_ids: ['GOAL-1'],
    tree: [{ id: 'GOAL-1', parent_id: null, kind: 'intent', goal: 'root' }],
  });
  signedIntent(missing, 'INT-1');
  missing.push('goal.declared', 'GOAL-1', { kind: 'intent', intent_id: 'INT-1', decision_id: 'd-1', goal: 'root' });
  missing.push('goal.reparented', 'GOAL-1', { parent_id: null });
  expectFoldFail(() => missing.fold(), /payload\.decision_id must be a non-empty string/);
});

test('P2 baseline：amended/loosened 必须有 prev；loosened 必须 direction=loosen', () => {
  const noPrev = new TestFolder();
  noPrev.push('baseline.frozen', 'B-1', {
    hash: 'h1', engine: ENGINE, policy: {}, criteria: [], gates: {}, thresholds: {}, assurance: {},
  });
  validDecision(noPrev, 'd-base', 'baseline');
  noPrev.push('baseline.loosened', 'B-2', {
    direction: 'loosen', decision_id: 'd-base', hash: 'h2', engine: ENGINE,
  });
  expectFoldFail(() => noPrev.fold(), /require payload\.prev/);

  const badDirection = new TestFolder();
  badDirection.push('baseline.frozen', 'B-1', {
    hash: 'h1', engine: ENGINE, policy: {}, criteria: [], gates: {}, thresholds: {}, assurance: {},
  });
  badDirection.push('baseline.loosened', 'B-2', { direction: 'tighten', prev: 'B-1', hash: 'h2', engine: ENGINE });
  expectFoldFail(() => badDirection.fold(), /requires direction=loosen/);

  const ok = new TestFolder();
  ok.push('baseline.frozen', 'B-1', {
    hash: 'h1', engine: ENGINE, policy: {}, criteria: [], gates: {}, thresholds: {}, assurance: {},
  });
  validDecision(ok, 'd-base', 'baseline');
  ok.push('baseline.loosened', 'B-2', {
    direction: 'loosen', decision_id: 'd-base', prev: 'B-1', hash: 'h2', engine: ENGINE,
  });
  assert.equal(ok.fold().tables.baseline['B-2']?.['prev'], 'B-1');
  assert.equal(ok.fold().tables.baseline['B-2']?.['direction'], 'loosen');
});

test('P2 release/decision 状态守卫：重复 freeze、rolled_back 再 supersede、非 valid 再 revoke 都拒', () => {
  const dup = new TestFolder();
  dup.push('release.frozen', 'REL-1', { frontier: 'f', baseline_hash: 'h', scope_spec_set: 's', items: [] });
  dup.push('release.frozen', 'REL-1', { frontier: 'f2', baseline_hash: 'h', scope_spec_set: 's', items: [] });
  expectFoldFail(() => dup.fold(), /already exists/);

  const twice = new TestFolder();
  twice.push('release.frozen', 'REL-1', { frontier: 'f', baseline_hash: 'h', scope_spec_set: 's', items: [] });
  validDecision(twice, 'd-rb', 'rollback', { release_id: 'REL-1', frontier: 'f', artifact_sha256: null });
  const supersede = {
    release_id: 'REL-1', frontier: 'f', artifact_sha256: null, decision_id: 'd-rb',
  };
  twice.push('release.superseded', 'REL-1', supersede);
  twice.push('release.superseded', 'REL-1', supersede);
  expectFoldFail(() => twice.fold(), /only frozen\/delivered can be superseded/);

  const revoked = new TestFolder();
  validDecision(revoked, 'd-1', 'intent');
  revoked.push('decision.revoked', 'd-1', { reason: 'r' });
  revoked.push('decision.revoked', 'd-1', { reason: 'r2' });
  expectFoldFail(() => revoked.fold(), /only valid decisions can transition/);
});

test('P2 task 守卫：done 不能 blocked、非 blocked 不能 unblock、done 不能 assigned/clear', () => {
  const blockedAfterDone = new TestFolder();
  blockedAfterDone.push('task.created', 'TASK-1', { seq: 1, title: 't', kind: 'implement' });
  blockedAfterDone.push('task.claimed', 'TASK-1', {});
  blockedAfterDone.push('task.done', 'TASK-1', {});
  blockedAfterDone.push('task.blocked', 'TASK-1', { block_code: 'verify_failed', reason: 'r' });
  expectFoldFail(() => blockedAfterDone.fold(), /block requires planned\/ready\/in_progress/);

  const unblock = new TestFolder();
  unblock.push('task.created', 'TASK-2', { seq: 2, title: 't2', kind: 'implement' });
  unblock.push('task.claimed', 'TASK-2', {});
  unblock.push('task.unblocked', 'TASK-2', {});
  expectFoldFail(() => unblock.fold(), /unblock requires blocked/);

  const unassign = new TestFolder();
  unassign.push('task.created', 'TASK-3', { seq: 3, title: 't3', kind: 'implement' });
  unassign.push('task.claimed', 'TASK-3', {});
  unassign.push('task.unassigned', 'TASK-3', {});
  expectFoldFail(() => unassign.fold(), /has no reservation to clear/);

  const assigned = new TestFolder();
  assigned.push('task.created', 'TASK-4', { seq: 4, title: 't4', kind: 'implement' });
  assigned.push('task.claimed', 'TASK-4', {});
  assigned.push('task.done', 'TASK-4', {});
  assigned.push('task.assigned', 'TASK-4', { assignee: 'bob', reserved_until: '2026-01-02T00:00:00Z' });
  expectFoldFail(() => assigned.fold(), /assignment requires/);
});

test('P2 assumption.recorded 的 inputs hash 与当前行不一致即拒', () => {
  const bad = new TestFolder();
  bad.push('spec.defined', 'SPEC-1', { clause: 'c', kind: 'requirement' });
  bad.push('assumption.recorded', 'A-1', {
    clause: 'a', blast_radius: 'core', inputs: [{ kind: 'spec', id: 'SPEC-1', hash: 'not-the-row-hash' }],
  });
  expectFoldFail(() => bad.fold(), /hash does not match the current row/);

  const folder = new TestFolder();
  folder.push('spec.defined', 'SPEC-1', { clause: 'c', kind: 'requirement' });
  const row = folder.fold().tables.spec['SPEC-1'] ?? {};
  // 用与 fold 相同的规范化序列化算 hash，再构造一条带正确 hash 的边。
  const good = new TestFolder();
  good.push('spec.defined', 'SPEC-1', { clause: 'c', kind: 'requirement' });
  good.push('assumption.recorded', 'A-1', {
    clause: 'a', blast_radius: 'core', inputs: [{ kind: 'spec', id: 'SPEC-1', hash: rowHash(row) }],
  });
  assert.equal(good.fold().tables.spec['A-1']?.['status'], 'open');
});

test('P3 index.ts 的 event.id 空值也是 FoldError 风格，消息带 kind', () => {
  const { ev } = eventFactory('empty-id');
  const event = ev('intent.proposed', 'INT-1', { statement: 's', owner: 'a', strength: 'explicit' }, { id: '' });
  assert.throws(() => fold(undefined, [event]), (error: unknown) => {
    assert.ok(error instanceof FoldError);
    assert.match(error.message, /event\.id must be a non-empty string/);
    assert.match(error.message, /kind intent\.proposed/);
    return true;
  });
});

test('P3 spec.revised 只改给出的字段，未重给的保留旧值', () => {
  const folder = new TestFolder();
  folder.push('spec.defined', 'SPEC-1', {
    clause: 'c1', kind: 'requirement', risk_flags: ['x'], alternatives: ['alt'],
  });
  folder.push('spec.revised', 'SPEC-1', { reason: 'narrow', content_hash: 'ch-2' });
  const row = folder.fold().tables.spec['SPEC-1'] ?? {};
  assert.equal(row['clause'], 'c1');
  assert.deepEqual(row['risk_flags'], ['x']);
  assert.deepEqual(row['alternatives'], ['alt']);
  assert.equal(row['content_hash'], 'ch-2');
});
