import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MIN_RIGHT_TO_RIGHT } from '../../src/core/auth/read.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { listViewCatalog } from '../../src/views/catalog.js';
import { query } from '../../src/query/index.js';
import type { QueryContext } from '../../src/query/execute.js';
import { PASSPHRASE } from '../db/helpers.js';

const AT = '2026-11-15T00:00:00.000Z';

function withMigratedDb(run: (db: ReturnType<typeof openSdoDatabase>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m3-1-query-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function session(actor: string): { actor: string; actor_kind: 'human'; session_id: string; credential: string } {
  return { actor, actor_kind: 'human', session_id: 'sess-1', credential: 'cred-1' };
}

function grant(db: ReturnType<typeof openSdoDatabase>, actor: string, right: string): void {
  db.prepare("INSERT INTO actor (id, kind, display, at) VALUES (?, 'human', NULL, ?)").run(actor, AT);
  db.prepare(
    "INSERT INTO scope (actor, scope, right, granted_by, at, revoked_at) VALUES (?, 'domain:core', ?, 'migration', ?, NULL)",
  ).run(actor, right, AT);
}

test('M3-1 C1: view_catalog 里每个 min_right 都在映射表里（防漂移）', () => {
  withMigratedDb((db) => {
    const catalog = listViewCatalog(db);
    assert.ok(catalog.length > 0);
    for (const view of catalog) {
      assert.ok(
        Object.hasOwn(MIN_RIGHT_TO_RIGHT, view.min_right),
        `view ${view.name} 的 min_right=${view.min_right} 不在 MIN_RIGHT_TO_RIGHT 映射表里`,
      );
    }
  });
});

test('M3-1 C1: 未知 actor（无任何 grant）⇒ filtered_by_permission、不出行', () => {
  withMigratedDb((db) => {
    const result = query(db, { view: 'pm_queue' }, { session: session('ghost') });
    assert.equal(result.rows.length, 0);
    assert.equal(result.miss?.reason, 'filtered_by_permission');
  });
});

test('M3-1 C1: 持 read 权可读 reader 视图；拿不到 reviewer 视图', () => {
  withMigratedDb((db) => {
    grant(db, 'alice', 'read');
    const reader = query(db, { view: 'list' }, { session: session('alice') });
    assert.equal(reader.miss, undefined);
    assert.ok(reader.rows.length > 0);

    const reviewerViews = listViewCatalog(db).filter((view) => view.min_right !== 'reader');
    assert.ok(reviewerViews.length > 0);
    const denied = query(db, { view: reviewerViews[0]!.name }, { session: session('alice') });
    assert.equal(denied.rows.length, 0);
    assert.equal(denied.miss?.reason, 'filtered_by_permission');
  });
});

test('M3-1 C1: 会话缺 actor_kind ⇒ fail-closed（不按 payload 自称）', () => {
  withMigratedDb((db) => {
    grant(db, 'alice', 'read');
    const broken = { actor: 'alice', session_id: 'sess-1', credential: 'cred-1' } as unknown as QueryContext['session'];
    const result = query(db, { view: 'list' }, { session: broken });
    assert.equal(result.rows.length, 0);
    assert.equal(result.miss?.reason, 'filtered_by_permission');
  });
});
