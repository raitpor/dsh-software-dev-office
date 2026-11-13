import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  accessLogPath,
  readAccessLog,
  resetAccessLogWarningForTests,
} from '../../src/db/access-log.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { query } from '../../src/query/index.js';
import { PASSPHRASE } from '../db/helpers.js';

function withMigratedDb(run: (dbPath: string, dir: string, db: ReturnType<typeof openSdoDatabase>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m0-6-query-access-'));
  const dbPath = join(dir, 'state', 'sdo.db');
  const db = openSdoDatabase(dbPath, PASSPHRASE);
  try {
    runMigrations(db);
    run(dbPath, dir, db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('C3: 经 sdo_query 的每次读都在库同目录追一行', () => {
  withMigratedDb((dbPath, _dir, db) => {
    query(db, { view: 'list' });
    query(db, { view: 'list', limit: 3 });
    query(db, { view: 'list', select: ['name'] });

    const records = readAccessLog(dbPath);
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((record) => record.view), ['list', 'list', 'list']);
    assert.equal(accessLogPath(dbPath), join(dbPath.slice(0, dbPath.lastIndexOf('/')), 'access.log'));
    for (const record of records) {
      assert.match(record.args_hash, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(record.right, 'reader');
    }
  });
});

test('C3 负例: 日志目录不可写 ⇒ 读仍成功，仅一条 stderr warning', () => {
  withMigratedDb((dbPath, dir, db) => {
    resetAccessLogWarningForTests();
    const stateDir = join(dir, 'state');
    const messages: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      messages.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      chmodSync(stateDir, 0o500);
      const first = query(db, { view: 'list' });
      const second = query(db, { view: 'list' });

      assert.ok(first.rows.length > 0);
      assert.ok(second.rows.length > 0);
      assert.equal(messages.filter((message) => message.includes('access log unavailable')).length, 1);
    } finally {
      process.stderr.write = originalWrite;
      chmodSync(stateDir, 0o700);
      resetAccessLogWarningForTests();
    }
    assert.equal(readAccessLog(dbPath).length, 0);
  });
});

test('P2-2: 相对路径打开 → chdir → query ⇒ access.log 仍在库目录', () => {
  const base = mkdtempSync(join(tmpdir(), 'sdo-m0-6-rel-open-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'sdo-m0-6-chdir-'));
  const originalCwd = process.cwd();
  const migrationsDir = join(originalCwd, 'migrations');
  try {
    process.chdir(base);
    const db = openSdoDatabase(join('state', 'sdo.db'), PASSPHRASE);
    try {
      runMigrations(db, migrationsDir);
      process.chdir(elsewhere);
      query(db, { view: 'list' });

      const records = readAccessLog(join(base, 'state', 'sdo.db'));
      assert.equal(records.length, 1);
    } finally {
      db.close();
    }
  } finally {
    process.chdir(originalCwd);
    rmSync(base, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});
