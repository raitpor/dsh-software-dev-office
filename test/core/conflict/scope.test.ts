import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFLICT_TRACKED_FIELDS, CONFLICT_TRACKED_KINDS, trackedField } from '../../../src/core/conflict/scope.js';
import { REDUCERS } from '../../../src/core/fold/registry.js';

/** 固化清单：只收内容编辑类（并发改同一字段会静默丢内容）。 */
const EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ['criterion.revised', 'remedy'],
  ['spec.revised', 'clause'],
];

test('tracked list is the frozen snapshot (content edits only)', () => {
  const actual = Object.entries(CONFLICT_TRACKED_FIELDS).sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(actual, EXPECTED.map(([kind, field]) => [kind, field]));
  assert.deepEqual([...CONFLICT_TRACKED_KINDS].sort(), EXPECTED.map(([kind]) => kind).sort());
});

test('every tracked kind has a reducer and a non-empty field', () => {
  for (const [kind, field] of EXPECTED) {
    assert.ok(Object.hasOwn(REDUCERS, kind), `${kind} must be a registered reducer kind`);
    assert.equal(typeof field, 'string');
    assert.ok(field.length > 0, `${kind} must declare a field`);
  }
});

test('lifecycle transitions and single-writer kinds are NOT tracked (lease/permission/signerd)', () => {
  for (const kind of [
    'task.claimed',
    'task.done',
    'task.reopened',
    'task.blocked',
    'assumption.disposed',
    'restatement.invalidated',
    'config.changed',
    'stage.exited',
    'gate.judged',
    'decision.signed',
    'decision.revoked',
    'release.frozen',
    'release.delivered',
    'release.superseded',
    'assumption.invalidated',
  ]) {
    assert.equal(trackedField(kind), undefined, `${kind} must not require CAS declarations`);
  }
});

test('prototype-chain keys are not treated as tracked kinds', () => {
  for (const kind of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(trackedField(kind), undefined, `${kind} must not resolve through Object.prototype`);
  }
});
