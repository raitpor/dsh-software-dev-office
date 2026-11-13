import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  accessLogFailureCount,
  accessLogPath,
  readAccessLog,
  recordAccess,
  recordAccessSafe,
  resetAccessLogWarningForTests,
} from '../../src/db/access-log.js';

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m0-6-access-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const AT = '2026-11-13T06:00:00.000Z';

test('C3: 三次读留三行，落在库同目录，字段是 at/view/args_hash/right', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'sdo.db');
    recordAccess(dbPath, { at: AT, view: 'pm_queue', args: { view: 'pm_queue' }, right: 'reader' });
    recordAccess(dbPath, { at: AT, view: 'board', args: { view: 'board', limit: 5 }, right: 'reader' });
    recordAccess(dbPath, { at: AT, view: 'defects', args: { view: 'defects' }, right: 'decider' });

    assert.equal(accessLogPath(dbPath), join(dir, 'access.log'));
    const records = readAccessLog(dbPath);
    assert.equal(records.length, 3);
    assert.deepEqual(records.map((record) => record.view), ['pm_queue', 'board', 'defects']);
    assert.deepEqual(records.map((record) => record.right), ['reader', 'reader', 'decider']);
    for (const record of records) {
      assert.match(record.args_hash, /^sha256:[0-9a-f]{64}$/u);
      assert.equal(record.at, AT);
    }
  });
});

test('C3: args_hash 对键序稳定、对参数变化敏感', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'sdo.db');
    recordAccess(dbPath, { at: AT, view: 'board', args: { limit: 5, view: 'board' }, right: 'reader' });
    recordAccess(dbPath, { at: AT, view: 'board', args: { view: 'board', limit: 5 }, right: 'reader' });
    recordAccess(dbPath, { at: AT, view: 'board', args: { view: 'board', limit: 6 }, right: 'reader' });

    const [first, second, third] = readAccessLog(dbPath);
    assert.equal(first?.args_hash, second?.args_hash);
    assert.notEqual(first?.args_hash, third?.args_hash);
  });
});

test('C3: access.log 权限 0600', () => {
  withTempDir((dir) => {
    const dbPath = join(dir, 'sdo.db');
    recordAccess(dbPath, { at: AT, view: 'list', args: { view: 'list' }, right: 'reader' });

    assert.equal(statSync(accessLogPath(dbPath)).mode & 0o777, 0o600);
  });
});

test('C3 负例: 日志不可写 ⇒ 不抛、不回退；每进程只 warning 一次', () => {
  withTempDir((dir) => {
    resetAccessLogWarningForTests();
    const missingDir = join(dir, 'missing');
    const messages: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      messages.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const first = recordAccessSafe(join(missingDir, 'sdo.db'), {
        at: AT,
        view: 'board',
        args: { view: 'board' },
        right: 'reader',
      });
      const second = recordAccessSafe(join(missingDir, 'sdo.db'), {
        at: AT,
        view: 'defects',
        args: { view: 'defects' },
        right: 'reader',
      });

      assert.equal(first, false);
      assert.equal(second, false);
      assert.equal(accessLogFailureCount(), 2);
      assert.equal(messages.filter((message) => message.includes('access log unavailable')).length, 1);
    } finally {
      process.stderr.write = originalWrite;
      resetAccessLogWarningForTests();
    }
  });
});
