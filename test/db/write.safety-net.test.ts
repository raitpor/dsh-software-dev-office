import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MATERIALIZED_TABLES, ensureNoUnknownFoldOnlyColumns, materialize } from '../../src/db/write-materialize.js';
import { chain, seed, withWriteDb } from './append-helpers.js';

test('safety net: fold output outside the materialized set fails closed', () => {
  withWriteDb((db) => {
    const events = chain([
      seed(50, 'design.locked', 'DL-1', {
        spec_id: 'SPEC-1',
        spec_version_hash: 'v-1',
        design_sha256: 'sha256:d',
      }),
    ]);
    const insert = db.prepare(
      `INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const event of events) {
      insert.run(
        event.id,
        event.at,
        event.actor,
        event.kind,
        event.subject,
        JSON.stringify(event.payload),
        JSON.stringify(event.caused_by),
        event.request_id,
        event.prev,
        event.hash,
      );
    }
    const tables = MATERIALIZED_TABLES.filter((table) => table !== 'design_lock');
    assert.throws(() => materialize(db, { tables }), /outside the materialized set/u);
  });
});

test('P2-5: one unexpected fold-only column fails the guard', () => {
  assert.throws(
    () =>
      ensureNoUnknownFoldOnlyColumns(
        'spec',
        'SPEC-X',
        { id: 'SPEC-X', revised_at: 't', bogus_column: 'x' },
        ['id', 'revised_at'],
      ),
    /bogus_column/u,
  );
});
