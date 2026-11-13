import assert from 'node:assert/strict';
import { test } from 'node:test';

import { disposeDiff } from '../../src/align/diff.js';
import { listDiffs, listRestatements, readAlignmentState } from '../../src/align/gate.js';
import { invalidateRestatement, proposeRestatement } from '../../src/align/restatement.js';
import {
  ALIGN_AT,
  appendIntent,
  draft,
  eventCount,
  intentEdge,
  withAlignDb,
} from './helpers.js';

function propose(db: Parameters<typeof proposeRestatement>[0]): string {
  const result = proposeRestatement(db, {
    intentId: 'INT-1',
    draftSpecs: [draft('d1'), draft('d2'), draft('d3')],
    inputs: [intentEdge('INT-1', 'ch:intent-1')],
    actor: 'agent-alpha',
    at: ALIGN_AT,
  });
  assert.equal(result.ok, true);
  const restatement = listRestatements(readAlignmentState(db))[0];
  assert.ok(restatement !== undefined);
  return restatement.id;
}

test('C3：accept/reject/defer 三种处置都能落事件（defer 由门另行挡）', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const restatementId = propose(db);
    const before = eventCount(db);

    const accept = disposeDiff(db, {
      restatementId, targetRef: 'd1', kind: 'missing', disposition: 'accept',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    const reject = disposeDiff(db, {
      restatementId, targetRef: 'd2', kind: 'extra', disposition: 'reject',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT, reason: '多出的条款不在意图里',
    });
    const defer = disposeDiff(db, {
      restatementId, targetRef: 'd3', kind: 'conflict', disposition: 'defer',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.deepEqual([accept.ok, reject.ok, defer.ok], [true, true, true]);
    assert.equal(eventCount(db), before + 3);

    const diffs = listDiffs(readAlignmentState(db), restatementId);
    assert.equal(diffs.length, 3);
    assert.deepEqual(
      diffs.map((row) => [row.target_ref, row.disposition]),
      [['d1', 'accept'], ['d2', 'reject'], ['d3', 'defer']],
    );
    const rejected = diffs.find((row) => row.target_ref === 'd2');
    assert.ok(rejected !== undefined);
    assert.equal(rejected.reason, '多出的条款不在意图里');
  });
});

test('C3：非法 kind/disposition ⇒ invalid_args，不写事件', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const restatementId = propose(db);
    const before = eventCount(db);

    const badKind = disposeDiff(db, {
      restatementId, targetRef: 'd1',
      kind: 'agree-ish' as unknown as 'agree', disposition: 'accept',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(badKind.ok, false);
    if (!badKind.ok) assert.equal(badKind.reason_code, 'invalid_args');

    const badDisposition = disposeDiff(db, {
      restatementId, targetRef: 'd1', kind: 'agree',
      disposition: 'block' as unknown as 'accept',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(badDisposition.ok, false);
    if (!badDisposition.ok) assert.equal(badDisposition.reason_code, 'invalid_args');

    assert.equal(eventCount(db), before);
  });
});

test('C3：同一差异重复处置 ⇒ diff_already_disposed（不被 fold upsert 覆盖）', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const restatementId = propose(db);
    const first = disposeDiff(db, {
      restatementId, targetRef: 'd1', kind: 'agree', disposition: 'accept',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(first.ok, true);

    const before = eventCount(db);
    const second = disposeDiff(db, {
      restatementId, targetRef: 'd1', kind: 'agree', disposition: 'reject',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason_code, 'diff_already_disposed');
    assert.equal(eventCount(db), before);
  });
});

test('C4：agent/service 的处置被拒且不写事件；human 才放行（M1 只是标注）', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const restatementId = propose(db);
    const before = eventCount(db);

    for (const actorKind of ['agent', 'service'] as const) {
      const denied = disposeDiff(db, {
        restatementId, targetRef: 'd1', kind: 'agree', disposition: 'accept',
        actor: 'agent-alpha', actorKind, at: ALIGN_AT,
      });
      assert.equal(denied.ok, false);
      if (!denied.ok) {
        assert.equal(denied.reason_code, 'not_human');
        assert.ok(denied.message.includes('不是签章防伪'));
      }
    }
    assert.equal(eventCount(db), before);

    const allowed = disposeDiff(db, {
      restatementId, targetRef: 'd1', kind: 'agree', disposition: 'accept',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(allowed.ok, true);
    assert.equal(eventCount(db), before + 1);
  });
});

test('C3：复述不存在/已作废的差异处置被拒', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const restatementId = propose(db);

    const missing = disposeDiff(db, {
      restatementId: 'RST-missing', targetRef: 'd1', kind: 'agree', disposition: 'accept',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason_code, 'restatement_not_found');

    const invalidated = invalidateRestatement(db, {
      restatementId, reason: 'intent 改动', actor: 'agent-alpha', at: ALIGN_AT,
    });
    assert.equal(invalidated.ok, true);

    const denied = disposeDiff(db, {
      restatementId, targetRef: 'd1', kind: 'agree', disposition: 'accept',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reason_code, 'restatement_invalidated');
  });
});

test('P1-2：同一 targetRef 重复处置 ⇒ diff_already_disposed（id 一律派生，绕不过去）', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const restatementId = propose(db);

    const first = disposeDiff(db, {
      restatementId, targetRef: 'd1', kind: 'agree', disposition: 'accept',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(first.ok, true);

    const second = disposeDiff(db, {
      restatementId, targetRef: 'd1', kind: 'agree', disposition: 'defer',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason_code, 'diff_already_disposed');
  });
});

test('P1-2：targetRef 不属于该复述的 draft_specs ⇒ invalid_args', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const restatementId = propose(db);
    const result = disposeDiff(db, {
      restatementId, targetRef: 'd-not-in-drafts', kind: 'agree', disposition: 'accept',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_code, 'invalid_args');
  });
});

test('P1-2：先 defer 后 accept 同样被拒（顺序不能改结论）', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const restatementId = propose(db);

    const first = disposeDiff(db, {
      restatementId, targetRef: 'd1', kind: 'agree', disposition: 'defer',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(first.ok, true);

    const second = disposeDiff(db, {
      restatementId, targetRef: 'd1', kind: 'agree', disposition: 'accept',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason_code, 'diff_already_disposed');
  });
});
