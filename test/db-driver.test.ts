import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3-multiple-ciphers';

import { openEncryptedDatabase } from '../src/db/driver.js';

const PASSPHRASE = 'correct horse battery staple';
const PLAINTEXT_SQLITE_MAGIC = 'SQLite format 3\0';
const NOT_A_DATABASE = /file is not a database|SQLITE_NOTADB/;

interface EventRow {
  seq: number;
  kind: string;
  payload: string;
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m0-0-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('driver: encrypted round-trip survives close/reopen', () => {
  withTempDir((dir) => {
    const file = join(dir, 'events.db');

    const db = openEncryptedDatabase(file, PASSPHRASE);
    db.exec('CREATE TABLE event (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL)');
    db.prepare('INSERT INTO event (seq, kind, payload) VALUES (?, ?, ?)').run(
      1,
      'intent.signed',
      '{"intent_id":"i-1"}',
    );
    db.close();

    const header = readFileSync(file).subarray(0, PLAINTEXT_SQLITE_MAGIC.length);
    assert.notEqual(header.toString('latin1'), PLAINTEXT_SQLITE_MAGIC, 'on-disk bytes must not be plaintext SQLite');

    const reopened = openEncryptedDatabase(file, PASSPHRASE);
    const row = reopened.prepare<[number], EventRow>('SELECT seq, kind, payload FROM event WHERE seq = ?').get(1);
    reopened.close();

    assert.ok(row !== undefined, 'the inserted event must be readable after reopen');
    assert.equal(row.seq, 1);
    assert.equal(row.kind, 'intent.signed');
    assert.equal(row.payload, '{"intent_id":"i-1"}');
  });
});

test('driver: wrong passphrase fails at open time', () => {
  withTempDir((dir) => {
    const file = join(dir, 'events.db');
    const db = openEncryptedDatabase(file, PASSPHRASE);
    db.exec('CREATE TABLE event (seq INTEGER PRIMARY KEY)');
    db.close();

    // driver 在 open 内会读一次 sqlite_master，所以这里必须当场抛，而不是等到第一条语句。
    assert.throws(() => openEncryptedDatabase(file, 'not-the-passphrase'), NOT_A_DATABASE);
  });
});

test('driver: a plaintext SQLite file is rejected, never silently adopted', () => {
  withTempDir((dir) => {
    const file = join(dir, 'plaintext.db');
    const plain = new Database(file);
    plain.exec('CREATE TABLE event (seq INTEGER PRIMARY KEY)');
    plain.close();

    // 先证明 fixture 真的是明文 SQLite；否则“文件前后不变”可能只是因为喂了别的垃圾。
    const header = readFileSync(file).subarray(0, PLAINTEXT_SQLITE_MAGIC.length).toString('latin1');
    assert.equal(header, PLAINTEXT_SQLITE_MAGIC, 'fixture must really be a plaintext SQLite file');
    const before = readFileSync(file);
    assert.throws(() => openEncryptedDatabase(file, PASSPHRASE), NOT_A_DATABASE);
    assert.deepEqual(readFileSync(file), before, 'a failed open must not rewrite the plaintext file');
  });
});

test('driver: empty passphrase is rejected (fail-closed, no plaintext fallback)', () => {
  withTempDir((dir) => {
    assert.throws(() => openEncryptedDatabase(join(dir, 'events.db'), ''), /passphrase/i);
  });
});
