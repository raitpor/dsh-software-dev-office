import assert from 'node:assert/strict';
import { grantFixtureRoster } from '../db/append-auth.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { currentUserVersion, runMigrations } from '../../src/db/migrate.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { HUMAN_ONLY_COLUMNS, listViewCatalog } from '../../src/views/catalog.js';
import { PASSPHRASE } from '../db/helpers.js';

function withMigratedDb(run: (db: ReturnType<typeof openSdoDatabase>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m3-6-columns-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    grantFixtureRoster(db);
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('M3-6 C1: 迁移 014 后每列都带 boolean human_only，且目录与代码白名单一致', () => {
  withMigratedDb((db) => {
    assert.equal(currentUserVersion(db), 18, '当前链头（018 public_face）');
    const catalog = listViewCatalog(db);
    assert.ok(catalog.length > 0);

    const flagged = new Map<string, string[]>();
    for (const view of catalog) {
      for (const column of view.columns) {
        assert.equal(
          typeof column.human_only,
          'boolean',
          `${view.name}.${column.name} 缺 human_only（014 后必须每列都有 boolean）`,
        );
        if (column.human_only) {
          const list = flagged.get(view.name) ?? [];
          list.push(column.name);
          flagged.set(view.name, list);
        }
      }
    }

    const expected = new Map(
      Object.entries(HUMAN_ONLY_COLUMNS).map(([view, columns]) => [view, [...columns].sort()]),
    );
    const actual = new Map([...flagged.entries()].map(([view, columns]) => [view, columns.sort()]));
    assert.deepEqual([...actual.entries()].sort(), [...expected.entries()].sort(),
      '目录里的 human_only 标记必须与 HUMAN_ONLY_COLUMNS 完全一致（任一边漂移即红）');

    // A1 的口径：签章状态列标 human_only；同源的 team.kind 保留可见（D-103）。
    assert.deepEqual(HUMAN_ONLY_COLUMNS['team'], ['rights']);
    const team = catalog.find((view) => view.name === 'team');
    assert.ok(team !== undefined);
    const rights = team.columns.find((column) => column.name === 'rights');
    const kind = team.columns.find((column) => column.name === 'kind');
    assert.equal(rights?.human_only, true, 'team.rights 是"别人的签章状态"，必须 human_only');
    assert.equal(kind?.human_only, false, 'team.kind 同一泄露面但保留可见，见 D-103');
  });
});

test('M3-6 C1: 目录声明与实际视图列一致（两处机器一致，防只写目录）', () => {
  withMigratedDb((db) => {
    for (const view of listViewCatalog(db)) {
      const statement = db.prepare(`SELECT * FROM (${view.sql}) LIMIT 0`);
      const actual = statement.columns().map((column) => column.name);
      assert.deepEqual(
        actual,
        view.columns.map((column) => column.name),
        `视图 ${view.name} 的实际列与 view_catalog.columns 不一致`,
      );
    }
  });
});

test('M3-6 C1: 014 幂等（二次迁移 no-op，标记不漂移）', () => {
  withMigratedDb((db) => {
    const before = listViewCatalog(db).map((view) => ({
      name: view.name,
      flags: view.columns.map((column) => [column.name, column.human_only]),
    }));
    const second = runMigrations(db);
    assert.deepEqual(second.applied, []);
    assert.equal(currentUserVersion(db), 18);
    const after = listViewCatalog(db).map((view) => ({
      name: view.name,
      flags: view.columns.map((column) => [column.name, column.human_only]),
    }));
    assert.deepEqual(after, before);
  });
});
