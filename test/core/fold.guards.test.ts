import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectFoldFail, TestFolder } from './folder.js';

const ENGINE = { version: 'sdo-engine/1', criteria_manifest_hash: 'cm-1' };

function baseline(folder: TestFolder): void {
  folder.push('baseline.frozen', 'B-1', {
    hash: 'h-B-1', engine: ENGINE, policy: {}, criteria: [], gates: {}, thresholds: {}, assurance: {},
  });
}

test('P2-2 重复定义守卫生效：spec.defined / criterion.registered 不许 upsert 覆盖', () => {
  const spec = new TestFolder();
  spec.push('spec.defined', 'SPEC-1', { kind: 'requirement', clause: 'c1' });
  spec.push('spec.defined', 'SPEC-1', { kind: 'requirement', clause: 'c2' });
  expectFoldFail(() => spec.fold(), /already defined; use spec.revised/);

  const criterion = new TestFolder();
  criterion.push('criterion.registered', 'CRIT-1', { spec_id: 'SPEC-1', remedy: 'r1' });
  criterion.push('criterion.registered', 'CRIT-1', { spec_id: 'SPEC-1', remedy: 'r2' });
  expectFoldFail(() => criterion.fold(), /already registered; use criterion.revised/);
});

test('P2-2 task 状态守卫：blocked 不能 claim、ready 不能 done、in_progress 不能 reopened', () => {
  const blockedClaim = new TestFolder();
  blockedClaim.push('task.created', 'TASK-1', { seq: 1, title: 't', kind: 'implement' });
  blockedClaim.push('task.claimed', 'TASK-1', {});
  blockedClaim.push('task.blocked', 'TASK-1', { block_code: 'verify_failed', reason: 'red' });
  blockedClaim.push('task.claimed', 'TASK-1', {});
  expectFoldFail(() => blockedClaim.fold(), /only planned\/ready can be claimed/);

  const readyDone = new TestFolder();
  readyDone.push('task.created', 'TASK-2', { seq: 2, title: 't2', kind: 'implement' });
  readyDone.push('task.done', 'TASK-2', {});
  expectFoldFail(() => readyDone.fold(), /done requires in_progress/);

  const reopened = new TestFolder();
  reopened.push('task.created', 'TASK-3', { seq: 3, title: 't3', kind: 'implement' });
  reopened.push('task.claimed', 'TASK-3', {});
  reopened.push('task.reopened', 'TASK-3', {});
  expectFoldFail(() => reopened.fold(), /reopened requires done/);
});

test('P2-2 attention / defect 状态守卫：非 open 不能被答/撤/关', () => {
  const answered = new TestFolder();
  answered.push('attention.raised', 'ATT-1', {
    task_id: 'TASK-1', asked_of: 'alice', question: 'q', expires_at: '2026-01-02T00:00:00Z',
  });
  answered.push('attention.withdrawn', 'ATT-1', {});
  answered.push('attention.answered', 'ATT-1', { answered_by: 'bob', answer: 'a' });
  expectFoldFail(() => answered.fold(), /only open can be answered/);

  const closedDefect = new TestFolder();
  closedDefect.push('criterion.registered', 'CRIT-1', { spec_id: 'SPEC-1', remedy: 'r' });
  closedDefect.push('defect.recorded', 'DEF-1', { criterion_id: 'CRIT-1', kind: 'criterion', severity: 'high' });
  closedDefect.push('verify.passed', 'VR-1', { actor_kind: 'service', actor: 'ci' });
  closedDefect.push('defect.closed', 'DEF-1', { verify_run_id: 'VR-1', closed_by: 'ci' });
  closedDefect.push('defect.closed', 'DEF-1', { verify_run_id: 'VR-1', closed_by: 'ci' });
  expectFoldFail(() => closedDefect.fold(), /only open can be closed/);
});

test('P1-4 release.frozen 的 package_version 可空，交付时补写', () => {
  const folder = new TestFolder();
  baseline(folder);
  folder.push('release.frozen', 'REL-1', {
    frontier: 'f', baseline_hash: 'h-B-1', scope_spec_set: 's', items: [],
  });
  assert.equal(folder.fold().tables.release['REL-1']?.['package_version'], null);
  folder.push('release.delivered', 'REL-1', { package_version: '1.0.0' });
  assert.equal(folder.fold().tables.release['REL-1']?.['package_version'], '1.0.0');
  assert.equal(folder.fold().tables.release['REL-1']?.['status'], 'delivered');
});
