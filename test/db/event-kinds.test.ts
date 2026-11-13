import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACK_KINDS } from '../../src/core/fold/ack.js';
import { REDUCERS } from '../../src/core/fold/registry.js';
import { withMigratedDb } from './helpers.js';

/**
 * G5：event_kind 是登记数据，新增 kind = 插一行（走迁移）。
 * 漂移检查：迁移种子必须与代码注册表逐 kind 相等——多一个/少一个都红，
 * 以后加 reducer/ack 忘了写迁移会立刻发现。
 */
test('migration seeds exactly REDUCERS ∪ ACK_KINDS (drift guard)', () => {
  withMigratedDb((db) => {
    const rows = db.prepare('SELECT kind FROM event_kind ORDER BY kind').all() as Array<{ kind: string }>;
    const seeded = rows.map((row) => row.kind);
    const code = [...new Set([...Object.keys(REDUCERS), ...Object.keys(ACK_KINDS)])].sort();
    assert.deepEqual(seeded, code, 'event_kind seed drifted from code registry');
    assert.equal(seeded.length, 92);
    for (const kind of seeded) {
      assert.ok(
        Object.hasOwn(REDUCERS, kind) || Object.hasOwn(ACK_KINDS, kind),
        `seeded kind ${kind} is in neither REDUCERS nor ACK_KINDS`,
      );
    }
  });
});

test('migration seed is re-runnable (INSERT OR IGNORE keeps it idempotent)', () => {
  withMigratedDb((db) => {
    const before = db.prepare('SELECT count(*) AS n FROM event_kind').get() as { n: number };
    const sql = "INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES ('intent.signed', '2026-11-13', 'rerun')";
    db.exec(sql);
    const after = db.prepare('SELECT count(*) AS n FROM event_kind').get() as { n: number };
    assert.equal(after.n, before.n);
  });
});
