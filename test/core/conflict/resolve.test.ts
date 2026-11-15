import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifyResolutionDecision } from '../../../src/core/conflict/resolve.js';

const SIGNED = {
  id: 'd-1',
  status: 'valid',
  signature: 'sig',
  key_id: 'key-1',
  signer: 'alice',
  payload: { conflict_resolution: { conflict_id: 'cf-1', adopted_actor: 'alice', note: 'alice wrote first' } },
};

const ACTORS = { winner: 'alice', loser: 'bob' } as const;

test('C4: a signed decision with the matching conflict_resolution payload resolves', () => {
  const check = verifyResolutionDecision(SIGNED, 'cf-1', 'winner', ACTORS);
  assert.equal(check.ok, true);
  if (check.ok) {
    assert.equal(check.value.signer, 'alice');
    assert.equal(check.value.adopted_actor, 'alice');
    assert.equal(check.value.note, 'alice wrote first');
  }
});

test('C4 negative: unsigned decision cannot resolve', () => {
  const check = verifyResolutionDecision({ ...SIGNED, signature: '' }, 'cf-1', 'winner', ACTORS);
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(check.reason_code, 'resolution_not_signed');
});

test('C4 negative: decision for another conflict / side is rejected', () => {
  const otherConflict = verifyResolutionDecision(SIGNED, 'cf-2', 'winner', ACTORS);
  assert.equal(otherConflict.ok, false);
  const otherSide = verifyResolutionDecision(SIGNED, 'cf-1', 'loser', ACTORS);
  assert.equal(otherSide.ok, false);
  if (!otherSide.ok) assert.equal(otherSide.reason_code, 'resolution_payload_mismatch');
});

test('C4 negative: adopted_actor must be the actor on the chosen side', () => {
  const wrong = { ...SIGNED, payload: { conflict_resolution: { conflict_id: 'cf-1', adopted_actor: 'bob', note: '' } } };
  const check = verifyResolutionDecision(wrong, 'cf-1', 'winner', ACTORS);
  assert.equal(check.ok, false);
  if (!check.ok) assert.equal(check.reason_code, 'resolution_payload_mismatch');
});

test('C4 negative: decision without conflict_resolution payload is rejected', () => {
  const check = verifyResolutionDecision({ ...SIGNED, payload: { decision_kind: 'sign' } }, 'cf-1', 'winner', ACTORS);
  assert.equal(check.ok, false);
});
