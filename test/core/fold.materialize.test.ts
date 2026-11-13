import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectFoldFail, TestFolder } from './folder.js';

const ENGINE = { version: 'sdo-engine/1', criteria_manifest_hash: 'cm-1' };

function baseline(folder: TestFolder, id = 'B-1'): void {
  folder.push('baseline.frozen', id, {
    hash: `h-${id}`, engine: ENGINE, policy: {}, criteria: [], gates: {}, thresholds: {}, assurance: {},
  });
}

test('P2-1 work_unit：task.claimed + evidence.attached(task_id) ⇒ 一卡一行', () => {
  const folder = new TestFolder();
  folder.push('task.created', 'TASK-1', { seq: 1, title: 'card', kind: 'implement' });
  folder.push('task.claimed', 'TASK-1', {});
  folder.push('criterion.registered', 'CRIT-1', { spec_id: 'SPEC-1', remedy: 'r' });
  folder.push('evidence.attached', 'EV-1', {
    criterion_id: 'CRIT-1', artifact_uri: 'file://x', artifact_sha256: 'sha', task_id: 'TASK-1',
  });
  const workUnit = folder.fold().tables.work_unit['wu:TASK-1'];
  assert.equal(workUnit?.['task_id'], 'TASK-1');
  assert.equal(workUnit?.['criterion_id'], 'CRIT-1');
  assert.equal(workUnit?.['spec_id'], 'SPEC-1');
  assert.equal(workUnit?.['evidence_id'], 'EV-1');
});

test('P2-1 work_unit：task.done 带 evidence_id + criterion_id 同样物化', () => {
  const folder = new TestFolder();
  folder.push('task.created', 'TASK-2', { seq: 2, title: 'card2', kind: 'implement' });
  folder.push('task.claimed', 'TASK-2', {});
  folder.push('criterion.registered', 'CRIT-2', { spec_id: 'SPEC-2', remedy: 'r' });
  folder.push('evidence.attached', 'EV-2', { criterion_id: 'CRIT-2', artifact_uri: 'file://y', artifact_sha256: 'sha' });
  folder.push('task.done', 'TASK-2', { evidence_id: 'EV-2', criterion_id: 'CRIT-2' });
  assert.equal(folder.fold().tables.work_unit['wu:TASK-2']?.['evidence_id'], 'EV-2');
});

test('P2-1 release_item：release.frozen 载荷 in/out 逐项物化（含主键与出局原因）', () => {
  const folder = new TestFolder();
  baseline(folder);
  folder.push('release.frozen', 'REL-1', {
    frontier: 'f-1', baseline_hash: 'h-B-1', scope_spec_set: 's-1',
    items: [
      { kind: 'spec', target: 'SPEC-1', requirement_id: 'REQ-1', disposition: 'in' },
      { kind: 'defect', target: 'DEF-1', requirement_id: 'REQ-1', disposition: 'out', reason: 'deferred' },
      { kind: 'requirement', target: 'REQ-2', disposition: 'in' },
    ],
  });
  const items = folder.fold().tables.release_item;
  assert.equal(Object.keys(items).length, 3);
  assert.equal(items['REL-1/spec/SPEC-1']?.['release_id'], 'REL-1');
  assert.equal(items['REL-1/defect/DEF-1']?.['reason'], 'deferred');
  assert.equal(items['REL-1/requirement/REQ-2']?.['requirement_id'], null);
});

test('P2-1 release_item 负例：非 requirement 缺 requirement_id、out 缺 reason 都被拒', () => {
  const missingRequirement = new TestFolder();
  baseline(missingRequirement);
  missingRequirement.push('release.frozen', 'REL-1', {
    frontier: 'f', baseline_hash: 'h-B-1', scope_spec_set: 's',
    items: [{ kind: 'spec', target: 'SPEC-1', disposition: 'in' }],
  });
  expectFoldFail(() => missingRequirement.fold(), /need requirement_id/);

  const missingReason = new TestFolder();
  baseline(missingReason);
  missingReason.push('release.frozen', 'REL-1', {
    frontier: 'f', baseline_hash: 'h-B-1', scope_spec_set: 's',
    items: [{ kind: 'defect', target: 'DEF-1', requirement_id: 'REQ-1', disposition: 'out' }],
  });
  expectFoldFail(() => missingReason.fold(), /out requires reason/);

  const missingItems = new TestFolder();
  baseline(missingItems);
  missingItems.push('release.frozen', 'REL-1', { frontier: 'f', baseline_hash: 'h-B-1', scope_spec_set: 's' });
  expectFoldFail(() => missingItems.fold(), /payload.items/);
});
