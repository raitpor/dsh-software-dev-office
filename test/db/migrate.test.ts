import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openEncryptedDatabase } from '../../src/db/driver.js';
import {
  currentUserVersion,
  listMigrations,
  runMigrations,
} from '../../src/db/migrate.js';
import { PASSPHRASE, tableNames } from './helpers.js';

function withEmptyDb(run: (file: string, close: () => void, db: ReturnType<typeof openEncryptedDatabase>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m0-1-migrate-'));
  const file = join(dir, 'sdo.db');
  const db = openEncryptedDatabase(file, PASSPHRASE);
  try {
    run(file, () => db.close(), db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('migrate: migration files are versioned 001..N', () => {
  const migrations = listMigrations();
  assert.deepEqual(
    migrations.map((migration) => migration.version),
    [1, 2, 3, 4, 5],
    'M0-3 adds 002 (views), M1-0 adds 003 (event_kind seed), M1-7 adds 004 (stage_run nullable gate), M1-6 adds 005 (claim append-only guards)',
  );
  assert.match(migrations[0]?.file ?? '', /^001_[A-Za-z0-9_-]+\.sql$/);
});

test('migrate: fresh database applies 001..005 and reports user_version = 5', () => {
  withEmptyDb((_file, _close, db) => {
    assert.equal(currentUserVersion(db), 0, 'a fresh database starts at user_version 0');
    const result = runMigrations(db);
    assert.deepEqual(result.applied, [1, 2, 3, 4, 5]);
    assert.equal(result.userVersion, 5);
    assert.equal(currentUserVersion(db), 5);
    assert.equal(tableNames(db).length, 35);
  });
});

test('migrate: second run is a no-op (idempotent, zero changes)', () => {
  withEmptyDb((_file, _close, db) => {
    runMigrations(db);
    const before = tableNames(db);

    const second = runMigrations(db);
    assert.deepEqual(second.applied, [], 'an up-to-date database must apply no migrations');
    assert.equal(second.userVersion, 5, 'user_version must not move on a no-op run');
    assert.deepEqual(tableNames(db), before);
    assert.equal(currentUserVersion(db), 5);
  });
});

test('migrate: 004 relaxes stage_run gate columns but keeps the table', () => {
  withEmptyDb((_file, _close, db) => {
    runMigrations(db);
    const info = db.prepare('PRAGMA table_info(stage_run)').all() as Array<{ name: string; notnull: number }>;
    const byName = new Map(info.map((column) => [column.name, column.notnull]));
    assert.equal(byName.get('gate_id'), 0, 'stage.entered may leave gate_id null until gate.judged');
    assert.equal(byName.get('baseline_hash'), 0, 'stage.entered may leave baseline_hash null');
    assert.equal(tableNames(db).length, 35);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'view'").get() !== undefined, true);
  });
});

test('migrate: replaying 001 by hand is rejected by the database (negative)', () => {
  withEmptyDb((_file, _close, db) => {
    runMigrations(db);
    const sql = listMigrations()[0]?.sql ?? '';
    assert.throws(() => db.exec(sql), /table decision already exists/);
  });
});

test('migrate: 004 preserves existing stage_run rows during the rebuild (upgrade path)', () => {
  withEmptyDb((_file, _close, db) => {
    const migrations = listMigrations();
    for (const migration of migrations.filter((m) => m.version <= 3)) db.exec(migration.sql);
    db.pragma('user_version = 3');
    db.prepare(
      `INSERT INTO stage_run (id, stage, gate_id, baseline_hash, entered_at, exited_at, verdict, criteria, at)
       VALUES ('SR-old', 'build', 'G_build', 'bh-old', '2026-01-01', '2026-01-02', 'pass', '[]', '2026-01-02')`,
    ).run();

    const result = runMigrations(db);
    assert.deepEqual(result.applied, [4, 5]);
    assert.equal(result.userVersion, 5);
    const row = db.prepare("SELECT * FROM stage_run WHERE id = 'SR-old'").get() as Record<string, unknown>;
    assert.equal(row['stage'], 'build');
    assert.equal(row['gate_id'], 'G_build');
    assert.equal(row['baseline_hash'], 'bh-old');
    assert.equal(row['verdict'], 'pass');
    assert.equal((db.prepare('SELECT count(*) AS n FROM sqlite_master WHERE type = \'view\'').get() as { n: number }).n, 13);
  });
});

test('migrate: view bodies equal view_catalog.sql after 002/004 rebuilds', () => {
  withEmptyDb((_file, _close, db) => {
    runMigrations(db);
    const catalog = db.prepare('SELECT name, sql FROM view_catalog ORDER BY name').all() as Array<{ name: string; sql: string }>;
    assert.equal(catalog.length, 13);
    const bodies = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view'").all() as Array<{ name: string; sql: string }>).map(
      (row) => ({ name: row.name, body: row.sql.replace(/^CREATE\s+VIEW\s+[^\s]+\s+AS\s*/i, '') }),
    );
    assert.equal(bodies.length, 13);
    for (const view of catalog) {
      assert.ok(
        bodies.some((actual) => actual.body === view.sql),
        `view ${view.name} body must match view_catalog.sql (actual names: ${bodies.map((b) => b.name).join(', ')})`,
      );
    }
  });
});
