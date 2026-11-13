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

/** 只发 decision.valid、不发 decision.signed：中间行，不得当授权用。 */
function validOnly(
  folder: TestFolder,
  id: string,
  kind: string,
  payload?: unknown,
): void {
  folder.push('decision.valid', id, {
    decision_kind: kind,
    payload_hash: `ph-${id}`,
    ...(payload === undefined ? {} : { payload }),
  });
}

const NOT_SIGNED = /is not signed; authorization requires a signed decision/;

test('P2-1 只 valid 不 signed：assumption/baseline/release/goal 消费处全拒', () => {
  const assumption = new TestFolder();
  assumption.push('assumption.recorded', 'A-1', { clause: 'c', blast_radius: 'b' });
  validOnly(assumption, 'd-a', 'assumption_set', {
    spec_ids: ['A-1'],
    dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }],
  });
  assumption.push('assumption.disposed', 'A-1', { decision_id: 'd-a', disposition: 'confirmed' });
  expectFoldFail(() => assumption.fold(), NOT_SIGNED);

  const baseline = new TestFolder();
  baseline.push('baseline.frozen', 'B-1', baselinePayload('h1'));
  validOnly(baseline, 'd-base', 'baseline');
  baseline.push('baseline.loosened', 'B-2', baselinePayload('h2', {
    prev: 'B-1', direction: 'loosen', decision_id: 'd-base',
  }));
  expectFoldFail(() => baseline.fold(), NOT_SIGNED);

  const release = new TestFolder();
  release.push('release.frozen', 'REL-1', {
    frontier: 'f', baseline_hash: 'h', scope_spec_set: 's', items: [],
  });
  validOnly(release, 'd-rb', 'rollback', {
    release_id: 'REL-1', frontier: 'f', artifact_sha256: null,
  });
  release.push('release.superseded', 'REL-1', {
    release_id: 'REL-1', frontier: 'f', decision_id: 'd-rb', artifact_sha256: null,
  });
  expectFoldFail(() => release.fold(), NOT_SIGNED);

  const goal = new TestFolder();
  signedIntent(goal);
  validOnly(goal, 'd-1', 'plan', {
    node_ids: ['GOAL-1'],
    tree: [{ id: 'GOAL-1', parent_id: null, kind: 'intent', goal: 'root' }],
  });
  goal.push('goal.declared', 'GOAL-1', {
    kind: 'intent', intent_id: 'INT-1', decision_id: 'd-1', goal: 'root',
  });
  expectFoldFail(() => goal.fold(), NOT_SIGNED);

  const reparent = new TestFolder();
  signedIntent(reparent);
  validDecision(reparent, 'd-1', 'plan', {
    node_ids: ['GOAL-1', 'GOAL-2'],
    tree: [
      { id: 'GOAL-1', parent_id: null, kind: 'intent', goal: 'root' },
      { id: 'GOAL-2', parent_id: 'GOAL-1', kind: 'part', goal: 'part' },
    ],
  });
  reparent.push('goal.declared', 'GOAL-1', {
    kind: 'intent', intent_id: 'INT-1', decision_id: 'd-1', goal: 'root',
  });
  reparent.push('goal.declared', 'GOAL-2', {
    kind: 'part', parent_id: 'GOAL-1', decision_id: 'd-1', goal: 'part',
  });
  validOnly(reparent, 'd-2', 'plan', {
    node_ids: ['GOAL-2'],
    tree: [{ id: 'GOAL-2', parent_id: 'GOAL-1', kind: 'part', goal: 'part' }],
  });
  reparent.push('goal.reparented', 'GOAL-2', { parent_id: 'GOAL-1', decision_id: 'd-2' });
  expectFoldFail(() => reparent.fold(), NOT_SIGNED);
});

test('P2-2 release.superseded：payload.frontier 必须等于 release 行 frontier', () => {
  const folder = new TestFolder();
  folder.push('release.frozen', 'REL-1', {
    frontier: 'f-1', baseline_hash: 'h', scope_spec_set: 's', items: [],
  });
  validDecision(folder, 'd-rb', 'rollback', {
    release_id: 'REL-1', frontier: 'f-2', artifact_sha256: null,
  });
  folder.push('release.superseded', 'REL-1', {
    release_id: 'REL-1', frontier: 'f-2', decision_id: 'd-rb', artifact_sha256: null,
  });
  expectFoldFail(() => folder.fold(), /payload\.frontier does not match release REL-1 frontier/);
});

test('P3-2 goal.declared 比对 acceptance_criterion_id（与 plan 树逐字段）', () => {
  const folder = new TestFolder();
  signedIntent(folder);
  validDecision(folder, 'd-1', 'plan', {
    node_ids: ['GOAL-1'],
    tree: [{
      id: 'GOAL-1', parent_id: null, kind: 'intent', goal: 'root', acceptance_criterion_id: 'C-1',
    }],
  });
  folder.push('goal.declared', 'GOAL-1', {
    kind: 'intent',
    intent_id: 'INT-1',
    decision_id: 'd-1',
    goal: 'root',
    acceptance_criterion_id: 'C-2',
  });
  expectFoldFail(() => folder.fold(), /acceptance_criterion_id/);
});
