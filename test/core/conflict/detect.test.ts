import assert from 'node:assert/strict';
import { test } from 'node:test';

import { valueHash } from '../../../src/core/conflict/hash.js';
import { detectConflict, extractConflictClaim } from '../../../src/core/conflict/detect.js';
import type { Event } from '../../../src/core/fold/types.js';

const ROW = { id: 'SPEC-1', clause: 'original', title: 'original title', kind: 'requirement' };

function makeEvent(payload: Record<string, unknown>, actor = 'bob', kind = 'spec.revised'): Event {
  return {
    id: 'e-test-1',
    at: '2026-11-15T00:00:00Z',
    actor,
    kind,
    subject: 'SPEC-1',
    payload,
    caused_by: [],
    request_id: 'req-test-1',
    prev: 'sha256:genesis',
    hash: 'sha256:h',
  };
}

test('C1: stale base_hash from another actor is a conflict (field-value hash)', () => {
  const detected = detectConflict({
    currentRow: ROW,
    winnerActor: 'alice',
    event: makeEvent({ field: 'clause', base_hash: 'sha256:stale', value: 'b' }),
  });
  assert.ok(detected);
  assert.equal(detected.base_hash, 'sha256:stale');
  assert.equal(detected.current_hash, valueHash('original'));
  assert.equal(detected.winner_actor, 'alice');
  assert.equal(detected.loser_actor, 'bob');
  assert.equal(detected.field, 'clause');
  assert.equal(detected.winner_value, JSON.stringify('original'));
  assert.equal(detected.loser_value, JSON.stringify('b'));
});

test('C1 negative: matching base_hash of the current field value is not a conflict', () => {
  const detected = detectConflict({
    currentRow: ROW,
    winnerActor: 'alice',
    event: makeEvent({ field: 'clause', base_hash: valueHash('original'), value: 'b' }),
  });
  assert.equal(detected, undefined);
});

test('P1-1: same actor with a stale base_hash is still a conflict (no self-exemption)', () => {
  const detected = detectConflict({
    currentRow: ROW,
    winnerActor: 'bob',
    event: makeEvent({ field: 'clause', base_hash: valueHash('old own value'), value: 'b' }, 'bob'),
  });
  assert.ok(detected);
  assert.equal(detected.winner_actor, 'bob');
  assert.equal(detected.loser_actor, 'bob');
});

test('P2-1: editing a different field does not conflict', () => {
  const detected = detectConflict({
    currentRow: ROW,
    winnerActor: 'alice',
    event: makeEvent({ field: 'title', base_hash: valueHash('original title'), value: 'new' }, 'carol'),
  });
  assert.equal(detected, undefined);
});

test('first write (no current row) and events without base_hash are not CAS writes', () => {
  assert.equal(
    detectConflict({ currentRow: undefined, winnerActor: undefined, event: makeEvent({ field: 'clause', base_hash: 'x' }) }),
    undefined,
  );
  assert.equal(detectConflict({ currentRow: ROW, winnerActor: 'alice', event: makeEvent({ clause: 'x' }) }), undefined);
  assert.equal(extractConflictClaim(makeEvent({ field: 'clause' })), undefined);
});

test('conflict.* events are never CAS candidates', () => {
  assert.equal(
    extractConflictClaim(makeEvent({ field: 'clause', base_hash: 'sha256:x' }, 'bob', 'conflict.detected')),
    undefined,
  );
});
