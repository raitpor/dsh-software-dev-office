import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

import { openEncryptedDatabase } from '../../src/db/driver.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createConsoleServer } from '../../src/ui/server.js';
import type { ConsoleServerOptions } from '../../src/ui/server.js';
import { PASSPHRASE } from '../db/helpers.js';

interface ConsoleHandle {
  readonly base: string;
  close(): Promise<void>;
}

/** `withMigratedDb` 是同步的；HTTP 测试要 async，这里用同样的 tmp 库 + 迁移模式。 */
async function withMigratedDbAsync(run: (db: SdoDatabase) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-ui-server-'));
  const db = openEncryptedDatabase(join(dir, 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    await run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function startConsole(db: SdoDatabase, options: Omit<ConsoleServerOptions, 'db'> = {}): Promise<ConsoleHandle> {
  const server = createConsoleServer({ db, ...options });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function seedEvent(db: SdoDatabase): void {
  db.prepare("INSERT INTO event_kind (kind, since) VALUES ('query_miss', '2026-11-13')").run();
  db.prepare(
    'INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('E1', '2026-11-13T00:00:00Z', 'a-dev', 'query_miss', 'overview', '{"view":"overview"}', '[]', '', 'h1');
}

function countRows(db: SdoDatabase, table: 'event' | 'task'): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

test('C1：GET /、/board、/plan 都返回 200，含标题与至少一个带来源的读数', async () => {
  await withMigratedDbAsync(async (db) => {
    const console = await startConsole(db);
    try {
      for (const [path, pageId] of [
        ['/', 'overview'],
        ['/board', 'board'],
        ['/plan', 'plan'],
      ] as const) {
        const response = await fetch(`${console.base}${path}`);
        assert.equal(response.status, 200, `${path} 状态`);
        assert.match(response.headers.get('content-type') ?? '', /text\/html/);
        assert.match(response.headers.get('content-type') ?? '', /charset=utf-8/);
        const html = await response.text();
        assert.match(html, /<title>/, `${path} 有页面标题`);
        assert.match(html, new RegExp(`data-page="${pageId}"`), `${path} 标注页面 id`);
        assert.match(html, /data-figure="[a-z_]+"/, `${path} 至少一个读数`);
        assert.match(html, /data-source="[a-z_]+"/, `${path} 读数带来源`);
      }
    } finally {
      await console.close();
    }
  });
});

test('C1 负例：未知路径 404，非 GET 405（Allow: GET）', async () => {
  await withMigratedDbAsync(async (db) => {
    const console = await startConsole(db);
    try {
      const notFound = await fetch(`${console.base}/definitely-not-a-page`);
      assert.equal(notFound.status, 404);
      assert.match(await notFound.text(), /没有这个页面/);

      const post = await fetch(`${console.base}/`, { method: 'POST' });
      assert.equal(post.status, 405);
      assert.match(post.headers.get('allow') ?? '', /GET/);
    } finally {
      await console.close();
    }
  });
});

test('C3：页面请求不改库——请求前后 event / task 行数不变', async () => {
  await withMigratedDbAsync(async (db) => {
    seedEvent(db);
    db.prepare(
      "INSERT INTO task (id, seq, title, kind, created_by, status, at) VALUES ('T1', 1, '卡一', 'implement', 'pm', 'ready', '2026-11-13T00:00:00Z')",
    ).run();
    const before = { event: countRows(db, 'event'), task: countRows(db, 'task') };
    const console = await startConsole(db);
    try {
      for (const path of ['/', '/board', '/plan']) {
        const response = await fetch(`${console.base}${path}`);
        assert.equal(response.status, 200);
        await response.text();
      }
    } finally {
      await console.close();
    }
    assert.deepEqual({ event: countRows(db, 'event'), task: countRows(db, 'task') }, before);
  });
});

test('C1：三页数据来自 query——有数据时 HTML 里出现 overview 的读数', async () => {
  await withMigratedDbAsync(async (db) => {
    db.prepare(
      "INSERT INTO task (id, seq, title, kind, created_by, status, at) VALUES ('T1', 1, '进行中的卡', 'implement', 'pm', 'in_progress', '2026-11-13T00:00:00Z')",
    ).run();
    const console = await startConsole(db);
    try {
      const html = await (await fetch(`${console.base}/`)).text();
      assert.match(html, /data-figure="in_flight"/);
      assert.match(html, /data-figure="in_flight"[^>]*>/);
      assert.match(html, /figure-value">1/);
    } finally {
      await console.close();
    }
  });
});
