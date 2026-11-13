import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { runMigrations } from '../../src/db/migrate.js';
import { openSdoDatabase } from '../../src/db/open.js';

interface EventAccessCounts {
  tableOpens: number;
  indexOpens: number;
}

interface CountApi {
  eventAccessCounts(db: unknown, sql: string): EventAccessCounts;
  eventRootPage(db: unknown): number;
  eventIndexRoots(db: unknown): number[];
}

async function loadCounter(): Promise<CountApi> {
  const url = pathToFileURL(resolve(process.cwd(), 'scripts/readings/count.mjs')).href;
  return (await import(url)) as CountApi;
}

test('countEventOpens counts event-table cursor opens, not plan text', async () => {
  const counter = await loadCounter();
  const dir = mkdtempSync(join(tmpdir(), 'sdo-readings-count-'));
  const db = openSdoDatabase(join(dir, 'count.db'), 'sdo-readings-test-passphrase');
  try {
    runMigrations(db, resolve(process.cwd(), 'migrations'));
    assert.ok(counter.eventRootPage(db) > 0);
    assert.ok(counter.eventIndexRoots(db).length >= 2);

    const counts = (sql: string): EventAccessCounts => counter.eventAccessCounts(db, sql);

    // 结构倍数：1 次表打开 vs UNION ALL 两次；两者都不碰索引。
    assert.deepEqual(counts('SELECT * FROM event'), { tableOpens: 1, indexOpens: 0 });
    assert.deepEqual(
      counts('SELECT * FROM event UNION ALL SELECT * FROM event'),
      { tableOpens: 2, indexOpens: 0 },
    );

    // 只走覆盖索引：表开 0、索引开 1。
    assert.deepEqual(counts('SELECT max(at) FROM event'), { tableOpens: 0, indexOpens: 1 });

    const views = db.prepare('SELECT name, sql FROM view_catalog').all() as {
      name: string;
      sql: string;
    }[];
    const viewCounts = (name: string): EventAccessCounts => {
      const view = views.find((row) => row.name === name);
      assert.ok(view, `missing view ${name}`);
      return counts(`SELECT * FROM (${view.sql})`);
    };

    assert.deepEqual(viewCounts('agents'), { tableOpens: 1, indexOpens: 0 });
    assert.deepEqual(viewCounts('board'), { tableOpens: 1, indexOpens: 1 });
    // pm_queue 有 4 个事件访问点：baseline e（kind 索引+表）、内层 MAX(x.at)（唯一的覆盖索引、
    // 无表游标）、change.applied e（kind 索引+表）、lease le（subject 索引+表）；两数不相加。
    assert.deepEqual(viewCounts('pm_queue'), { tableOpens: 3, indexOpens: 4 });

    // 相关子查询：结构上只打开 1 次 event 表游标 + 1 次 subject 索引游标
    // （运行期每行访问数不在本口径内）。
    const correlated =
      'SELECT max((SELECT max(length(e.payload)) FROM event e WHERE e.subject = t.id)) FROM task t';
    assert.deepEqual(counts(correlated), { tableOpens: 1, indexOpens: 1 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
