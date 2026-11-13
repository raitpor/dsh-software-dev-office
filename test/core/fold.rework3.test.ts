import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectFoldFail, signedIntent, TestFolder, validDecision } from './folder.js';

const ENGINE = { version: 'sdo-engine/1', criteria_manifest_hash: 'cm-1' };

function baselinePayload(hash: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash,
    engine: ENGINE,
    policy: {},
    criteria: [],
    gates: {},
    thresholds: {},
    assurance: {},
    ...overrides,
  };
}

function readyTask(folder: TestFolder, id = 'TASK-1'): void {
  folder.push('task.created', id, { seq: 1, title: 't', kind: 'implement', status: 'ready' });
}

test('P1-1 release.superseded：缺 decision/无效/指向别版/交付版缺产物/未交付带产物 全拒', () => {
  const base = (): TestFolder => {
    const folder = new TestFolder();
    folder.push('release.frozen', 'REL-1', {
      frontier: 'f', baseline_hash: 'h', scope_spec_set: 's', items: [],
    });
    return folder;
  };

  const missing = base();
  missing.push('release.superseded', 'REL-1', {
    release_id: 'REL-1', frontier: 'f', artifact_sha256: null,
  });
  expectFoldFail(() => missing.fold(), /payload\.decision_id must be a non-empty string/);

  const invalid = base();
  validDecision(invalid, 'd-rb', 'rollback', {
    release_id: 'REL-1', frontier: 'f', artifact_sha256: null,
  });
  invalid.push('decision.revoked', 'd-rb', { reason: 'compromised' });
  invalid.push('release.superseded', 'REL-1', {
    release_id: 'REL-1', frontier: 'f', artifact_sha256: null, decision_id: 'd-rb',
  });
  expectFoldFail(() => invalid.fold(), /decision d-rb is not valid/);

  const wrongTarget = base();
  validDecision(wrongTarget, 'd-rb', 'rollback', {
    release_id: 'REL-2', frontier: 'f', artifact_sha256: null,
  });
  wrongTarget.push('release.superseded', 'REL-1', {
    release_id: 'REL-1', frontier: 'f', artifact_sha256: null, decision_id: 'd-rb',
  });
  expectFoldFail(() => wrongTarget.fold(), /decision d-rb does not target release REL-1/);

  const frozenArtifact = base();
  validDecision(frozenArtifact, 'd-rb', 'rollback', {
    release_id: 'REL-1', frontier: 'f', artifact_sha256: 'sha-1',
  });
  frozenArtifact.push('release.superseded', 'REL-1', {
    release_id: 'REL-1', frontier: 'f', artifact_sha256: 'sha-1', decision_id: 'd-rb',
  });
  expectFoldFail(() => frozenArtifact.fold(), /requires payload\.artifact_sha256 = null/);

  const delivered = base();
  delivered.push('release.delivered', 'REL-1', {});
  validDecision(delivered, 'd-rb', 'rollback', {
    release_id: 'REL-1', frontier: 'f', artifact_sha256: null,
  });
  delivered.push('release.superseded', 'REL-1', {
    release_id: 'REL-1', frontier: 'f', artifact_sha256: null, decision_id: 'd-rb',
  });
  expectFoldFail(() => delivered.fold(), /requires payload\.artifact_sha256/);
});

test('P1-1 release.superseded 正例：delivered + 产物 sha256 收尾进 rolled_back', () => {
  const folder = new TestFolder();
  folder.push('release.frozen', 'REL-1', {
    frontier: 'f', baseline_hash: 'h', scope_spec_set: 's', items: [],
  });
  folder.push('release.delivered', 'REL-1', {});
  validDecision(folder, 'd-rb', 'rollback', {
    release_id: 'REL-1', frontier: 'f', artifact_sha256: 'sha-1',
  });
  folder.push('release.superseded', 'REL-1', {
    release_id: 'REL-1', frontier: 'f', artifact_sha256: 'sha-1', decision_id: 'd-rb',
  });
  assert.equal(folder.fold().tables.release['REL-1']?.['status'], 'rolled_back');
});

test('P2-1 task.dropped：planned/dropped 拒；done 只许 delivered_deferred 且要凭据', () => {
  const planned = new TestFolder();
  planned.push('task.created', 'TASK-1', { seq: 1, title: 't', kind: 'implement' });
  planned.push('task.dropped', 'TASK-1', { drop_kind: 'never_done', reason: 'r' });
  expectFoldFail(() => planned.fold(), /drop requires ready\/done/);

  const twice = new TestFolder();
  readyTask(twice);
  twice.push('task.dropped', 'TASK-1', { drop_kind: 'never_done', reason: 'r' });
  twice.push('task.dropped', 'TASK-1', { drop_kind: 'never_done', reason: 'r2' });
  expectFoldFail(() => twice.fold(), /drop requires ready\/done/);

  const doneNever = new TestFolder();
  doneNever.push('task.created', 'TASK-1', { seq: 1, title: 't', kind: 'implement' });
  doneNever.push('task.claimed', 'TASK-1', {});
  doneNever.push('task.done', 'TASK-1', {});
  doneNever.push('task.dropped', 'TASK-1', { drop_kind: 'never_done', reason: 'r' });
  expectFoldFail(() => doneNever.fold(), /drop_kind must be delivered_deferred/);

  const noCredential = new TestFolder();
  noCredential.push('task.created', 'TASK-1', { seq: 1, title: 't', kind: 'implement' });
  noCredential.push('task.claimed', 'TASK-1', {});
  noCredential.push('task.done', 'TASK-1', {});
  noCredential.push('task.dropped', 'TASK-1', { drop_kind: 'delivered_deferred', reason: 'r' });
  expectFoldFail(() => noCredential.fold(), /requires payload\.credential/);
});

test('P2-2 baseline 链：二次 frozen 拒；amendment 的 prev 必须是当前 head', () => {
  const secondFrozen = new TestFolder();
  secondFrozen.push('baseline.frozen', 'B-1', baselinePayload('h1'));
  secondFrozen.push('baseline.frozen', 'B-2', baselinePayload('h2'));
  expectFoldFail(() => secondFrozen.fold(), /only for the first baseline/);

  const notHead = new TestFolder();
  notHead.push('baseline.frozen', 'B-1', baselinePayload('h1'));
  notHead.push('baseline.amended', 'B-2', baselinePayload('h2', { prev: 'B-1', direction: 'tighten' }));
  validDecision(notHead, 'd-base', 'baseline');
  notHead.push('baseline.loosened', 'B-3', baselinePayload('h3', {
    prev: 'B-1', direction: 'loosen', decision_id: 'd-base',
  }));
  expectFoldFail(() => notHead.fold(), /prev baseline B-1 is not the current head B-2/);
});

test('P2-3 goal 载荷树：node_ids/tree/parent_id/kind 与事件不一致都拒', () => {
  const missingId = new TestFolder();
  signedIntent(missingId);
  validDecision(missingId, 'd-1', 'plan', {
    node_ids: ['GOAL-1'],
    tree: [{ id: 'GOAL-1', parent_id: null, kind: 'intent', goal: 'root' }],
  });
  missingId.push('goal.declared', 'GOAL-1', {
    kind: 'intent', intent_id: 'INT-1', decision_id: 'd-1', goal: 'root',
  });
  missingId.push('goal.declared', 'GOAL-2', {
    kind: 'part', parent_id: 'GOAL-1', decision_id: 'd-1', goal: 'part',
  });
  expectFoldFail(() => missingId.fold(), /node_ids must include goal GOAL-2/);

  const mismatch = planFolder();
  mismatch.push('goal.declared', 'GOAL-1', {
    kind: 'intent', intent_id: 'INT-1', decision_id: 'd-1', goal: 'root',
  });
  mismatch.push('goal.declared', 'GOAL-2', {
    kind: 'part', parent_id: 'GOAL-1', decision_id: 'd-1', goal: 'other',
  });
  expectFoldFail(() => mismatch.fold(), /does not match the signed plan node/);

  const reparentRoot = new TestFolder();
  signedIntent(reparentRoot);
  validDecision(reparentRoot, 'd-1', 'plan', {
    node_ids: ['GOAL-1', 'GOAL-2'],
    tree: [
      { id: 'GOAL-1', parent_id: null, kind: 'intent', goal: 'root' },
      { id: 'GOAL-2', parent_id: 'GOAL-1', kind: 'part', goal: 'part' },
    ],
  });
  reparentRoot.push('goal.declared', 'GOAL-1', {
    kind: 'intent', intent_id: 'INT-1', decision_id: 'd-1', goal: 'root',
  });
  reparentRoot.push('goal.declared', 'GOAL-2', {
    kind: 'part', parent_id: 'GOAL-1', decision_id: 'd-1', goal: 'part',
  });
  validDecision(reparentRoot, 'd-2', 'plan', {
    node_ids: ['GOAL-2'],
    tree: [{ id: 'GOAL-2', parent_id: null, kind: 'part', goal: 'part' }],
  });
  reparentRoot.push('goal.reparented', 'GOAL-2', { parent_id: null, decision_id: 'd-2' });
  expectFoldFail(() => reparentRoot.fold(), /must keep a parent on reparent/);
});

function planFolder(): TestFolder {
  const folder = new TestFolder();
  signedIntent(folder);
  validDecision(folder, 'd-1', 'plan', {
    node_ids: ['GOAL-1', 'GOAL-2'],
    tree: [
      { id: 'GOAL-1', parent_id: null, kind: 'intent', goal: 'root' },
      { id: 'GOAL-2', parent_id: 'GOAL-1', kind: 'part', goal: 'part' },
    ],
  });
  return folder;
}
