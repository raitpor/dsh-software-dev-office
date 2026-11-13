import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { withMigratedDb } from '../db/helpers.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { decodeCursor, MAX_RESULT_BYTES, query, type QueryContext, type QueryResult, type Row } from '../../src/query/index.js';
import { listViewCatalog } from '../../src/views/catalog.js';

const ROWS_SQL = 'SELECT id AS row_id, family AS fam FROM defect ORDER BY id ASC';

/** C4 口径：`bytes` 与“整包 JSON 的 UTF-8 字节数”一致，且整包 ≤ 8KB（不只量 rows）。 */
function assertWithinBudget(result: QueryResult): void {
  const packageBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  assert.equal(result.bytes, packageBytes, 'bytes 必须是整包 UTF-8 字节数');
  assert.ok(packageBytes <= MAX_RESULT_BYTES, `整包 ${packageBytes}B 超过 ${MAX_RESULT_BYTES}B`);
}

function addAdHocView(db: SdoDatabase, name: string, sql: string, rowBudget: number): void {
  db.prepare(
    `INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget)
     VALUES (?, ?, '[{"name":"row_id","label":"编号","type":"text"},{"name":"fam","label":"族","type":"text"}]',
             'M0-4 游标/预算夹具（只加一条目录行，零代码改动）', 'reader', ?)`,
  ).run(name, sql, rowBudget);
}

function seedDefects(db: SdoDatabase, ids: readonly string[]): void {
  const insert = db.prepare(
    `INSERT INTO defect (id, kind, severity, family, status, at)
     VALUES (?, 'criterion', 'low', 'fixture', 'open', '2026-01-01T00:00:00Z')`,
  );
  for (const id of ids) insert.run(id);
}

function manyDefectIds(count: number): string[] {
  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) ids.push(`D${String(index).padStart(2, '0')}`);
  return ids;
}

/** 从第一页翻到最后一页；返回拼接结果与每页的读数。 */
function drainPages(
  db: SdoDatabase,
  view: string,
  context: QueryContext = {},
): { rows: Row[]; pages: QueryResult[] } {
  const rows: Row[] = [];
  const pages: QueryResult[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = query(db, cursor === undefined ? { view } : { view, cursor }, context);
    pages.push(page);
    assert.equal(page.miss, undefined, `续查不应有 miss（第 ${pages.length} 页）`);
    rows.push(...page.rows);
    cursor = page.next_cursor;
    if (cursor === undefined) return { rows, pages };
  }
  throw new Error('drainPages: 游标没有终止（可能死循环）');
}

test('C4 默认 limit=row_budget：20 行按 7 行一页截断，游标可续查', () => {
  withMigratedDb((db) => {
    seedDefects(db, manyDefectIds(20));
    addAdHocView(db, 'v_rows', ROWS_SQL, 7);

    const first = query(db, { view: 'v_rows' });
    assert.equal(first.miss, undefined);
    assert.equal(first.rows.length, 7);
    assert.equal(first.truncated, true);
    assert.equal(typeof first.next_cursor, 'string');
    assertWithinBudget(first);
    assert.deepEqual(first.as_of, []);
    assert.deepEqual(
      first.rows.map((row) => (row as Record<string, unknown>)['row_id']),
      ['D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07'],
    );

    // 游标里确实带了排序键快照（不是只有 offset）
    assert.ok(first.next_cursor !== undefined);
    const decoded = decodeCursor(first.next_cursor);
    assert.equal(decoded.offset, 7);
    assert.equal(decoded.as_of.length, 0);
    assert.match(decoded.last_row_hash, /^[0-9a-f]{32}$/, '游标只带定长行摘要，不带整行');
    assert.deepEqual(decoded.args, { view: 'v_rows', limit: 7 });

    const { rows, pages } = drainPages(db, 'v_rows');
    assert.deepEqual(rows, db.prepare(ROWS_SQL).all(), '续查拼接 == 一次性全量（逐行相等）');
    assert.equal(rows.length, 20);
    assert.equal(pages.length, 3);
    assert.deepEqual(pages.map((page) => page.truncated), [true, true, false]);
    const ids = rows.map((row) => (row as Record<string, unknown>)['row_id']);
    assert.equal(new Set(ids).size, ids.length, '分页不得重复');
  });
});

test('C4 显式 limit：小于 row_budget 时也截断且游标继续成立', () => {
  withMigratedDb((db) => {
    seedDefects(db, manyDefectIds(20));
    addAdHocView(db, 'v_rows', ROWS_SQL, 7);

    const first = query(db, { view: 'v_rows', limit: 3 });
    assert.equal(first.rows.length, 3);
    assert.equal(first.truncated, true);
    assert.ok(first.next_cursor !== undefined);
    assert.equal(decodeCursor(first.next_cursor).args.limit, 3);

    // 续查沿用游标里的 limit（调用方不必重复传）
    const second = query(db, { view: 'v_rows', cursor: first.next_cursor });
    assert.equal(second.rows.length, 3);
    assert.equal(second.truncated, true);

    // 显式 limit 超过 row_budget 是结构化 invalid_args（A4：不得大于 row_budget）
    const tooLarge = query(db, { view: 'v_rows', limit: 8 });
    assert.equal(tooLarge.miss?.reason, 'invalid_args');
    assert.match(tooLarge.miss?.hint ?? '', /7/);
  });
});

test('C5 游标只对同一 snapshot 有效：中间插入行（不落事件）⇒ stale_as_of，不重不漏', () => {
  withMigratedDb((db) => {
    seedDefects(db, manyDefectIds(20));
    addAdHocView(db, 'v_rows', ROWS_SQL, 7);

    const first = query(db, { view: 'v_rows' });
    assert.ok(first.next_cursor !== undefined);

    // 中间插入一行（排序在页首之前），边界行从 D07 变成 D06。
    seedDefects(db, ['D00']);
    const resumed = query(db, { view: 'v_rows', cursor: first.next_cursor });
    assert.equal(resumed.miss?.reason, 'stale_as_of');
    assert.equal(resumed.rows.length, 0);

    // 重新从第一页开始：21 行都能完整翻出，无重无漏。
    const { rows } = drainPages(db, 'v_rows');
    assert.equal(rows.length, 21);
    const ids = rows.map((row) => (row as Record<string, unknown>)['row_id']);
    assert.equal(new Set(ids).size, ids.length);
  });
});

test('C5 新事件推进 frontier ⇒ 旧游标 stale_as_of；新查询带新 as_of', () => {
  withMigratedDb((db) => {
    seedDefects(db, manyDefectIds(20));
    addAdHocView(db, 'v_rows', ROWS_SQL, 7);
    const first = query(db, { view: 'v_rows' });
    assert.deepEqual(first.as_of, []);
    assert.ok(first.next_cursor !== undefined);

    db.prepare(
      "INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES ('task.assigned', '2026-01-01T00:00:00Z', '已派发')",
    ).run();
    db.prepare(
      `INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash)
       VALUES ('E1', '2026-01-01T00:00:00Z', 'human-pm', 'task.assigned', 'T1', '{}', '[]', NULL, '', 'h-e1')`,
    ).run();

    const resumed = query(db, { view: 'v_rows', cursor: first.next_cursor });
    assert.equal(resumed.miss?.reason, 'stale_as_of');

    const fresh = query(db, { view: 'v_rows' });
    assert.deepEqual(fresh.as_of, ['E1']);
    assert.equal(fresh.rows.length, 7);
  });
});

test('C4 4000 字符行、20 行视图：游标翻完 == 全量，无重无漏，每页整包 ≤ 8KB', () => {
  withMigratedDb((db) => {
    const insert = db.prepare(
      `INSERT INTO defect (id, kind, severity, family, status, at)
       VALUES (?, 'criterion', 'low', ?, 'open', '2026-01-01T00:00:00Z')`,
    );
    for (let index = 1; index <= 20; index += 1) {
      // 第 54 轮 P1 反例：4000 字符行 + 整行游标 ⇒ 首屏 result_too_large；摘要游标后必须能翻。
      insert.run(String(index).padStart(2, '0'), 'z'.repeat(4000));
    }
    db.prepare(
      `INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget)
       VALUES ('v_big', 'SELECT id AS row_id, family AS body FROM defect ORDER BY id ASC',
               '[{"name":"row_id","label":"编号","type":"text"},{"name":"body","label":"正文","type":"text"}]',
               'C4 4000 字符行分页夹具', 'reader', 10)`,
    ).run();

    const first = query(db, { view: 'v_big' });
    assert.equal(first.miss, undefined);
    assert.equal(first.truncated, true);
    assertWithinBudget(first);
    assert.ok(first.rows.length >= 1, '超预算也要前进，不能返回 0 行');
    assert.ok(first.next_cursor !== undefined);

    const { rows, pages } = drainPages(db, 'v_big');
    for (const page of pages) {
      assertWithinBudget(page);
      assert.ok(page.rows.length >= 1);
    }
    assert.ok(pages.length > 1, '4000 字符行必须分多页，不能整页塞进 8KB');
    assert.deepEqual(
      rows,
      db.prepare('SELECT id AS row_id, family AS body FROM defect ORDER BY id ASC').all(),
      '按游标翻完 == 一次性全量（逐行相等）',
    );
    assert.equal(rows.length, 20);
    const ids = rows.map((row) => (row as Record<string, unknown>)['row_id']);
    assert.equal(new Set(ids).size, ids.length, '分页不得重复');
    assert.deepEqual(pages.map((page) => page.truncated), [
      ...pages.slice(0, -1).map(() => true),
      false,
    ]);
  });
});

test('C4 8000 字符行：单行视图仍可读（reviewer 探针 2）', () => {
  withMigratedDb((db) => {
    db.prepare(
      `INSERT INTO defect (id, kind, severity, family, status, at)
       VALUES ('ONE', 'criterion', 'low', ?, 'open', '2026-01-01T00:00:00Z')`,
    ).run('x'.repeat(8000));
    db.prepare(
      `INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget)
       VALUES ('v_one', 'SELECT id AS row_id, family AS fam FROM defect ORDER BY id ASC',
               '[{"name":"row_id","label":"编号","type":"text"},{"name":"fam","label":"族","type":"text"}]',
               'C4 8000 字符行夹具（单行）', 'reader', 5)`,
    ).run();

    const result = query(db, { view: 'v_one' });
    assert.equal(result.miss, undefined, '8000 字符行单行视图必须可读');
    assert.equal(result.rows.length, 1);
    assert.equal(result.truncated, false);
    assertWithinBudget(result);
  });
});

test('已知边界：8000 字符行 + 下一页 ⇒ 行 + 定长游标整包超 8KB，给结构化 result_too_large', () => {
  withMigratedDb((db) => {
    const insert = db.prepare(
      `INSERT INTO defect (id, kind, severity, family, status, at)
       VALUES (?, 'criterion', 'low', ?, 'open', '2026-01-01T00:00:00Z')`,
    );
    insert.run('A', 'x'.repeat(8000));
    insert.run('B', 'y'.repeat(8000));
    db.prepare(
      `INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget)
       VALUES ('v_many', 'SELECT id AS row_id, family AS fam FROM defect ORDER BY id ASC',
               '[{"name":"row_id","label":"编号","type":"text"},{"name":"fam","label":"族","type":"text"}]',
               'C4 8000 字符行夹具（多行）', 'reader', 5)`,
    ).run();

    // 单行 8027B + envelope 66B = 8093B 可读；再加游标 ~170B ⇒ 8260B > 8192，无法同时满足
    // “truncated=true 必带游标”与“整包 ≤8KB”。这是整包预算的代数硬限，不是丢数据。
    const result = query(db, { view: 'v_many' });
    assert.equal(result.miss?.reason, 'result_too_large');
    assert.deepEqual(result.rows, []);
    assert.equal(result.next_cursor, undefined);
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result), 'utf8'));
  });
});

test('C4 list 目录超预算：13 行按 8KB 截断，游标拼回全量（不削数据形状）', () => {
  withMigratedDb((db) => {
    const first = query(db, { view: 'list' }, { right: 'decider' });
    assert.equal(first.miss, undefined);
    assert.equal(first.truncated, true, '13 行目录（含 columns[].type）超 8KB，必须截断');
    assert.ok(first.next_cursor !== undefined, 'truncated=true 必带游标');
    assertWithinBudget(first);
    assert.ok(first.rows.length >= 1);

    // 截断的是行数，不是数据形状：columns 原样带 name/label/unit?/type。
    const sample = first.rows[0] as Row;
    const columns = sample['columns'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(columns));
    assert.ok(columns.length > 0);
    assert.ok(columns.every((column) => typeof column['name'] === 'string'));
    assert.ok(columns.some((column) => typeof column['type'] === 'string'));

    const { rows, pages } = drainPages(db, 'list', { right: 'decider' });
    assert.ok(pages.length >= 2, '目录应分 ≥2 页');
    for (const page of pages) assertWithinBudget(page);
    assert.equal(rows.length, 13);
    const names = rows.map((row) => String((row as Record<string, unknown>)['name']));
    assert.equal(new Set(names).size, 13, '目录分页不得重复');
    assert.deepEqual(names, listViewCatalog(db).map((view) => view.name));
  });
});

test('C4 单行整包仍超预算 ⇒ 结构化 result_too_large（不返回半行、不给假游标）', () => {
  withMigratedDb((db) => {
    db.prepare(
      `INSERT INTO defect (id, kind, severity, family, status, at)
       VALUES ('HUGE', 'criterion', 'low', ?, 'open', '2026-01-01T00:00:00Z')`,
    ).run('y'.repeat(9000));

    const result = query(db, { view: 'defects' });
    assert.equal(result.miss?.reason, 'result_too_large');
    assert.deepEqual(result.rows, []);
    assert.equal(result.truncated, false);
    assert.equal(result.next_cursor, undefined);
    // 失败包也必须报真实整包字节，而不是写死 2。
    assert.equal(result.bytes, Buffer.byteLength(JSON.stringify(result), 'utf8'));
    assert.ok(result.as_of !== undefined);
  });
});

test('C8 预算常量单点定义在 src/query/budget.ts', () => {
  const dir = join(process.cwd(), 'src/query');
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
  assert.ok(files.includes('budget.ts'));
  for (const file of files) {
    if (file === 'budget.ts') continue;
    const source = readFileSync(join(dir, file), 'utf8');
    assert.ok(!/\b8192\b/.test(source), `${file}: 8KB 字面量只允许在 budget.ts`);
    assert.ok(!/\b8\s*\*\s*1024\b/.test(source), `${file}: 8KB 表达式只允许在 budget.ts`);
    assert.ok(!/\bMAX_RESULT_BYTES\s*=/.test(source), `${file}: 不得重复定义 MAX_RESULT_BYTES`);
  }
  // 预算值是契约：8192 bytes / 500 行（以常量表达，不在别处散落）。
  assert.equal(MAX_RESULT_BYTES, 8 * 1024);
});
