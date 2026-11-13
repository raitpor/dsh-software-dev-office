import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { append } from '../../src/db/write.js';
import { isLockMessage } from '../../src/db/write-envelope.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { chain, seed, PASSPHRASE } from './append-helpers.js';

function eventCount(db: Parameters<typeof append>[0]): number {
  return (db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n;
}

test('P2-7: BEGIN IMMEDIATE hitting a writer lock returns database_busy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m1-busy-'));
  const file = join(dir, 'state', 'sdo.db');
  const db = openSdoDatabase(file, PASSPHRASE);
  try {
    runMigrations(db);
    db.pragma('busy_timeout = 50');
    const other = openSdoDatabase(file, PASSPHRASE);
    try {
      other.exec('BEGIN IMMEDIATE');
      const result = append(
        db,
        chain([seed(1, 'decision.valid', 'd-1', { decision_kind: 'intent', payload_hash: 'ph', frontier: 'f', payload: {} })]),
      );
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'database_busy');
      assert.equal(eventCount(db), 0);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P2-1: SQLITE_LOCKED / table-locked messages classify as database_busy', () => {
  assert.equal(isLockMessage('database is locked'), true);
  assert.equal(isLockMessage('database is busy'), true);
  assert.equal(isLockMessage('database table is locked: event'), true);
  assert.equal(isLockMessage('database schema is locked: main'), true);
  assert.equal(isLockMessage('SQLITE_BUSY'), true);
  assert.equal(isLockMessage('SQLITE_LOCKED'), true);
  assert.equal(isLockMessage('no such table: event'), false);
});
