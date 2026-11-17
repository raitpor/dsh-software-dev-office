import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasRight, readScopeOwns } from '../../src/db/auth.js';
import { withMigratedDb } from './helpers.js';

type Db = Parameters<Parameters<typeof withMigratedDb>[0]>[0];

const AT = '2026-11-15T00:00:00.000Z';

function seed(db: Db): void {
  db.prepare("INSERT INTO actor (id, kind, display, at) VALUES ('alice', 'human', NULL, ?)").run(AT);
  db.prepare(
    "INSERT INTO scope (actor, scope, right, granted_by, at, revoked_at) VALUES ('alice', 'domain:office', 'plan', 'migration', ?, NULL)",
  ).run(AT);
  db.prepare(
    "INSERT INTO scope (actor, scope, right, granted_by, at, revoked_at) VALUES ('alice', 'module:src/db', 'write', 'migration', ?, NULL)",
  ).run(AT);
}

function own(db: Db, child: string, parent: string): void {
  db.prepare('INSERT INTO scope_owns (child_scope, parent_scope, created_at) VALUES (?, ?, ?)').run(child, parent, AT);
}

test('C9：迁移 013 建 scope_owns，链可读且两跳归属放行 plan@domain', () => {
  withMigratedDb((db) => {
    assert.equal(db.pragma('user_version', { simple: true }), 18);
    seed(db);
    // 空表：跨前缀 fail-closed，reason=no_ownership（不猜 module→domain）
    const before = hasRight(db, { id: 'alice', kind: 'human' }, 'create', 'module:src/db');
    assert.equal(before.ok, false);
    if (!before.ok) assert.equal(before.reason, 'no_ownership');

    own(db, 'module:src/db', 'domain:core');
    own(db, 'domain:core', 'domain:office');
    assert.deepEqual(readScopeOwns(db), [
      { child_scope: 'domain:core', parent_scope: 'domain:office' },
      { child_scope: 'module:src/db', parent_scope: 'domain:core' },
    ]);

    // 两跳：module:src/db → domain:core → domain:office；grant 在 office 覆盖祖先
    const after = hasRight(db, { id: 'alice', kind: 'human' }, 'create', 'module:src/db');
    assert.equal(after.ok, true, JSON.stringify(after));
  });
});

test('C9：归属表只追加（update/delete 被触发器拒），主键防重边', () => {
  withMigratedDb((db) => {
    seed(db);
    own(db, 'module:src/db', 'domain:core');
    assert.throws(
      () => db.prepare("UPDATE scope_owns SET parent_scope = 'domain:evil' WHERE child_scope = 'module:src/db'").run(),
      /append-only/,
    );
    assert.throws(() => db.prepare("DELETE FROM scope_owns WHERE child_scope = 'module:src/db'").run(), /append-only/);
    assert.throws(() => own(db, 'module:src/db', 'domain:core'), /UNIQUE|constraint/i);
  });
});

test('C9：无归属行 ⇒ no_ownership；有链但无覆盖祖先的 grant ⇒ missing_grant', () => {
  withMigratedDb((db) => {
    seed(db);
    // 有链但 alice 的 plan 只在 domain:office，而链只到 domain:core ⇒ 缺 grant
    own(db, 'module:src/db', 'domain:core');
    const missing = hasRight(db, { id: 'alice', kind: 'human' }, 'create', 'module:src/db');
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.reason, 'missing_grant');
      assert.equal(missing.missing_right, 'plan');
    }

    // 完全无归属链的 scope ⇒ no_ownership
    const orphan = hasRight(db, { id: 'alice', kind: 'human' }, 'create', 'module:src/query');
    assert.equal(orphan.ok, false);
    if (!orphan.ok) assert.equal(orphan.reason, 'no_ownership');
  });
});
