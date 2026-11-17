import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fold } from '../../../src/core/fold/index.js';
import { chain } from '../../db/append-helpers.js';
import { seed } from '../../db/append-helpers.js';

const ACQ = (n: number, prefix: string, card: string, actor: string, extra: Record<string, unknown> = {}) => seed(n, 'lock.acquired', prefix, {
  card_id: card,
  acquired_at: '2026-11-16T00:00:00.000Z',
  expires_at: '2026-11-16T02:00:00.000Z',
  ...extra,
}, { actor });
const REL = (n: number, prefix: string, extra: Record<string, unknown> = {}, actor = 'alice') => seed(n, 'lock.released', prefix, {
  released_at: '2026-11-16T00:00:00.000Z',
  released_by: 'released',
  ...extra,
}, { actor });

test('C1: lock.acquired projects an active row; lock.released keeps the row as released', () => {
  const state = fold(undefined, chain([ACQ(1, 'src/core', 'CARD-1', 'alice'), REL(2, 'src/core')]));
  const row = state.tables.lock['src/core'];
  assert.ok(row !== undefined);
  assert.equal(row['status'], 'released');
  assert.equal(row['released_by'], 'released');
  assert.equal(row['card_id'], 'CARD-1');
});

test('C1: a second active lock on the same prefix is rejected (no silent overwrite)', () => {
  assert.throws(
    () => fold(undefined, chain([ACQ(1, 'src/core', 'CARD-1', 'alice'), ACQ(2, 'src/core', 'CARD-2', 'bob')])),
    /is held by /,
  );
});

test('C4: lease.revoked marks released_by but keeps the lock active', () => {
  const state = fold(undefined, chain([
    ACQ(1, 'src/core', 'CARD-1', 'alice'),
    seed(2, 'lease.issued', 'CARD-1', { card: 'CARD-1', actor: 'alice', scope: 'domain:core', frontier: 'sha256:f', ttl_s: 3600, expires_at: '2026-11-17T10:00:00Z' }),
    seed(3, 'lease.revoked', 'CARD-1', { lease_id: 'e-m1-2', card_id: 'CARD-1', scope: 'domain:core', revoked_by: 'actor-1' }),
  ]));
  const row = state.tables.lock['src/core'];
  assert.equal(row?.['status'], 'active');
  assert.equal(row?.['released_by'], 'lease_revoked');
});

test('C4: same actor can re-claim after lease revocation; another actor still conflicts', () => {
  const base = [ACQ(1, 'src/core', 'CARD-1', 'alice'), seed(2, 'lease.issued', 'CARD-1', { card: 'CARD-1', actor: 'alice', scope: 'domain:core', frontier: 'sha256:f', ttl_s: 3600, expires_at: '2026-11-17T10:00:00Z' }), seed(3, 'lease.revoked', 'CARD-1', { lease_id: 'e-m1-2', card_id: 'CARD-1', scope: 'domain:core', revoked_by: 'actor-1' })];
  const reclaimed = fold(undefined, chain([...base, ACQ(4, 'src/core', 'CARD-1', 'alice')]));
  assert.equal(reclaimed.tables.lock['src/core']?.['status'], 'active');
  assert.equal(reclaimed.tables.lock['src/core']?.['released_by'], null);
  assert.throws(
    () => fold(undefined, chain([...base, ACQ(4, 'src/core', 'CARD-2', 'bob')])),
    /is held by /,
  );
});

test('C4/P1-2: only the holder can release (fold guard)', () => {
  assert.throws(
    () => fold(undefined, chain([ACQ(1, 'src/core', 'CARD-1', 'alice'), REL(2, 'src/core', {}, 'bob')])),
    /cannot release it/,
  );
});

test('C4: released rows can be re-acquired; duplicate release and unknown release fail', () => {
  const released = fold(undefined, chain([ACQ(1, 'src/core', 'CARD-1', 'alice'), REL(2, 'src/core')]));
  assert.equal(released.tables.lock['src/core']?.['status'], 'released');
  assert.throws(() => fold(undefined, chain([REL(1, 'src/ui')])), /does not exist|is not active/);
  assert.throws(
    () => fold(undefined, chain([ACQ(1, 'src/core', 'CARD-1', 'alice'), REL(2, 'src/core'), REL(3, 'src/core')])),
    /is not active/,
  );
});

test('C6: invalid prefix in lock.acquired is rejected by the reducer', () => {
  assert.throws(() => fold(undefined, chain([ACQ(1, '/etc', 'CARD-1', 'alice')])), /invalid_field|relative prefix/);
});
