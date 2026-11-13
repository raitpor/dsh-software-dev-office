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
    [1, 2],
    'M0-3 adds migration 002 (13 views + view_catalog)',
  );
  assert.match(migrations[0]?.file ?? '', /^001_[A-Za-z0-9_-]+\.sql$/);
});

test('migrate: fresh database applies 001..002 and reports user_version = 2', () => {
  withEmptyDb((_file, _close, db) => {
    assert.equal(currentUserVersion(db), 0, 'a fresh database starts at user_version 0');
    const result = runMigrations(db);
    assert.deepEqual(result.applied, [1, 2]);
    assert.equal(result.userVersion, 2);
    assert.equal(currentUserVersion(db), 2);
    assert.equal(tableNames(db).length, 35);
  });
});

test('migrate: second run is a no-op (idempotent, zero changes)', () => {
  withEmptyDb((_file, _close, db) => {
    runMigrations(db);
    const before = tableNames(db);

    const second = runMigrations(db);
    assert.deepEqual(second.applied, [], 'an up-to-date database must apply no migrations');
    assert.equal(second.userVersion, 2, 'user_version must not move on a no-op run');
    assert.deepEqual(tableNames(db), before);
    assert.equal(currentUserVersion(db), 2);
  });
});

test('migrate: replaying 001 by hand is rejected by the database (negative)', () => {
  withEmptyDb((_file, _close, db) => {
    runMigrations(db);
    const sql = listMigrations()[0]?.sql ?? '';
    assert.throws(() => db.exec(sql), /table decision already exists/);
  });
});
