/** M4-3/C4：单写者切换的 fold 级守卫（不只依赖网关/能力）。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fold } from '../../../src/core/fold/index.js';
import { chain, seed } from '../../db/append-helpers.js';

const CH = (n: number, from: string | null, to: string, at: string, actor = 'operator') =>
  seed(n, 'publicface.writer_changed', to, { from, to, at }, { actor });

test('C4: initial assignment projects exactly one writer row', () => {
  const state = fold(undefined, chain([CH(1, null, 'alice', '2026-11-17T00:00:00.000Z')]));
  assert.deepEqual(Object.keys(state.tables.public_face_writer), ['1']);
  assert.equal(state.tables.public_face_writer['1']!['actor'], 'alice');
  assert.equal(state.tables.public_face_writer['1']!['held_since'], '2026-11-17T00:00:00.000Z');
});

test('C4: bootstrap with non-null from is rejected (no silent overwrite)', () => {
  assert.throws(
    () => fold(undefined, chain([CH(1, 'ghost', 'alice', '2026-11-17T00:00:00.000Z')])),
    /no writer has been assigned yet/,
  );
});

test('C4: transfer requires from===current writer, to!==current, and monotonic time', () => {
  assert.throws(
    () => fold(undefined, chain([CH(1, null, 'alice', '2026-11-17T00:00:00.000Z'), CH(2, 'bob', 'bob', '2026-11-17T01:00:00.000Z')])),
    /does not match current writer alice/,
  );
  assert.throws(
    () => fold(undefined, chain([CH(1, null, 'alice', '2026-11-17T00:00:00.000Z'), CH(2, 'alice', 'alice', '2026-11-17T01:00:00.000Z')])),
    /already the current writer/,
  );
  assert.throws(
    () => fold(undefined, chain([CH(1, null, 'alice', '2026-11-17T02:00:00.000Z'), CH(2, 'alice', 'bob', '2026-11-17T01:00:00.000Z')])),
    /must not precede held_since/,
  );
  const state = fold(undefined, chain([CH(1, null, 'alice', '2026-11-17T00:00:00.000Z'), CH(2, 'alice', 'bob', '2026-11-17T01:00:00.000Z')]));
  assert.deepEqual(Object.keys(state.tables.public_face_writer), ['1']);
  assert.equal(state.tables.public_face_writer['1']!['actor'], 'bob');
});
