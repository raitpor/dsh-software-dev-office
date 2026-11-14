import test from 'node:test';
import assert from 'node:assert/strict';

import { append, chainHead } from '../../src/db/write.js';
import { primaryKeyColumns } from '../../src/db/write-materialize.js';
import { chain, seed, withWriteDb } from './append-helpers.js';
import { worldSeeds } from './world-seeds.js';

test('C1 config uses key as the DDL primary key: same key updates, never duplicates', () => {
  withWriteDb((db) => {
    const first = chain([seed(1, 'config.changed', 'limits.max_members', { after: 5, actor: 'alice' })]);
    assert.equal(append(db, first).ok, true);
    const second = chain([seed(2, 'config.changed', 'limits.max_members', { after: 7, actor: 'bob' })], chainHead(db));
    assert.equal(append(db, second).ok, true);
    const rows = db.prepare('SELECT * FROM config').all() as Array<{ key: string; value: number }>;
    assert.deepEqual(rows.map((row) => [row.key, row.value]), [['limits.max_members', 7]]);
  });
});

test('C1 snapshot_parent uses (snapshot_id,parent_id): replay does not duplicate links', () => {
  withWriteDb((db) => {
    const events = chain(worldSeeds());
    assert.equal(append(db, events).ok, true);
    const before = db.prepare('SELECT count(*) AS n FROM snapshot_parent').get() as { n: number };
    assert.equal(before.n, 1, 'world chain links SNAP-1 -> SNAP-0 exactly once');
    assert.equal(append(db, events).ok, true, 'replay is idempotent');
    const after = db.prepare('SELECT count(*) AS n FROM snapshot_parent').get() as { n: number };
    assert.equal(after.n, 1);
  });
});

test('C1 release_item uses (release_id,kind,target): rerun keeps the same rows', () => {
  withWriteDb((db) => {
    const events = chain(worldSeeds());
    assert.equal(append(db, events).ok, true);
    const rows = db
      .prepare('SELECT release_id, kind, target FROM release_item ORDER BY release_id, kind, target')
      .all() as Array<{ release_id: string; kind: string; target: string }>;
    assert.equal(rows.length, 2);
    assert.equal(append(db, events).ok, true);
    assert.equal((db.prepare('SELECT count(*) AS n FROM release_item').get() as { n: number }).n, rows.length);
  });
});

test('C1 a table without a primary key fails closed instead of guessing a key', () => {
  withWriteDb((db) => {
    db.exec('CREATE TABLE nopk (a TEXT, b TEXT)');
    assert.throws(
      () => primaryKeyColumns(db, 'nopk' as never),
      /table nopk has no primary key; cannot materialize/,
    );
  });
});

test('append-only projection: an unexpected baseline row fails the next append cleanly', () => {
  withWriteDb((db) => {
    assert.equal(append(db, chain(worldSeeds())).ok, true);
    const eventCount = (db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n;
    // 手工插一行事件外的 baseline（baseline 没有 INSERT 触发器，只有 UPDATE/DELETE）。
    db.prepare(
      `INSERT INTO baseline (id, frozen_by, engine_version, criteria_manifest_hash, policy, criteria, gates, thresholds, assurance, prev, direction, hash, at)
       VALUES ('B-extra', '[]', 'e', 'm', '{}', '{}', '{}', '{}', '{}', NULL, NULL, 'sha256:extra', '2026-01-01')`,
    ).run();
    const next = chain([seed(99, 'config.changed', 'limits.max_members', { after: 9, actor: 'alice' })], chainHead(db));
    const result = append(db, next);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'materialize_failed');
    assert.match(result.message ?? '', /baseline rows are append-only|append-only/);
    assert.equal((db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n, eventCount);
    const config = db.prepare("SELECT count(*) AS n FROM config WHERE key = 'limits.max_members'").get() as { n: number };
    assert.equal(config.n, 0, 'failed append must not leave the new config key behind');
  });
});

test('create semantics (P1-1): restatement.recorded with different content is rejected, row survives', () => {
  withWriteDb((db) => {
    assert.equal(append(db, chain(worldSeeds())).ok, true);
    const before = db.prepare("SELECT * FROM restatement WHERE id = 'R-1'").get() as Record<string, unknown>;
    const conflicting = chain(
      [seed(500, 'restatement.recorded', 'R-1', { intent_id: 'INT-1', draft_specs: [{ id: 'different' }], inputs: [] })],
      chainHead(db),
    );
    const result = append(db, conflicting);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'materialize_failed');
    assert.match(result.message ?? '', /restatement R-1 already exists with different content/);
    assert.deepEqual(db.prepare("SELECT * FROM restatement WHERE id = 'R-1'").get(), before);
  });
});
