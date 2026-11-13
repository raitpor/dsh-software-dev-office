import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SdoPathError } from '../../src/core/paths.js';
import { runMigrations } from '../../src/db/migrate.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { PASSPHRASE } from './helpers.js';

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m0-6-open-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('C5: 首次打开自动建父目录与库文件；mustExist 之后可正常打开', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'nested', 'state', 'sdo.db');
    const db = openSdoDatabase(dbPath, PASSPHRASE);
    try {
      assert.equal(existsSync(dbPath), true);
    } finally {
      db.close();
    }

    const reopened = openSdoDatabase(dbPath, PASSPHRASE, { mustExist: true });
    try {
      assert.equal(reopened.open, true);
    } finally {
      reopened.close();
    }
  });
});

test('C5: mustExist 但库不存在 ⇒ SdoPathError（不回退工作区）', () => {
  withTempDir((dir) => {
    assert.throws(
      () => openSdoDatabase(join(dir, 'missing', 'sdo.db'), PASSPHRASE, { mustExist: true }),
      (error: unknown) =>
        error instanceof SdoPathError &&
        /database does not exist: .*fail-closed: no workspace fallback/u.test(error.message),
    );
  });
});

test('C5: 错口令 ⇒ SdoPathError 且消息明确 fail-closed', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'sdo.db');
    const db = openSdoDatabase(dbPath, PASSPHRASE);
    runMigrations(db);
    db.close();

    assert.throws(
      () => openSdoDatabase(dbPath, 'wrong passphrase', { mustExist: true }),
      (error: unknown) =>
        error instanceof SdoPathError && /cannot open database .*fail-closed: no workspace fallback/u.test(error.message),
    );
  });
});

test('P3: mustExist 失败不留空目录', () => {
  withTempDir((dir) => {
    assert.throws(() => openSdoDatabase(join(dir, 'missing', 'sdo.db'), PASSPHRASE, { mustExist: true }));
    assert.equal(existsSync(join(dir, 'missing')), false);
  });
});

test('P2-2: 打开时把绝对路径绑到连接上（sdoPath）', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'nested', 'sdo.db');
    const db = openSdoDatabase(dbPath, PASSPHRASE);
    try {
      assert.equal((db as unknown as { sdoPath?: string }).sdoPath, dbPath);
    } finally {
      db.close();
    }
  });
});
