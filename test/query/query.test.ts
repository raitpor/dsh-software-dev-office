import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { withViewerDb } from '../db/helpers.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { assertSelectOnly, listViewCatalog } from '../../src/views/catalog.js';
import { MAX_RESULT_BYTES, query, type MissSink, type QueryMiss } from '../../src/query/index.js';
import { asViewer } from './viewer.js';

function collector(): { sink: MissSink; misses: QueryMiss[] } {
  const misses: QueryMiss[] = [];
  return { sink: { record: (miss) => misses.push(miss) }, misses };
}

const BASELINE_HASH = 'hash-b1';
const BASELINE_POLICY = JSON.stringify({
  preset: 'm0',
  stages: [],
  gates: [],
  switches: {},
  review: { sample_every: 2, sample_seed: 0 },
  artifact_kinds: {},
});

function seedBaseline(db: SdoDatabase): void {
  db.prepare(
    `INSERT INTO baseline
       (id, frozen_by, engine_version, criteria_manifest_hash, policy, criteria, gates,
        thresholds, assurance, hash, at)
     VALUES ('B1', 'human-pm', 'eng-1', 'cmh-1', ?, '[]', '[]', '{}', ?, ?, ?)`,
  ).run(
    BASELINE_POLICY,
    JSON.stringify({ independence: 'independent', db_confidentiality: true, na_stages: [], level: 'basic' }),
    BASELINE_HASH,
    '2026-01-01T00:00:00Z',
  );
}

function seedDefects(db: SdoDatabase, count: number): void {
  const insert = db.prepare(
    `INSERT INTO defect (id, kind, severity, family, status, at)
     VALUES (?, 'criterion', 'low', 'fixture', 'open', '2026-01-01T00:00:00Z')`,
  );
  for (let index = 1; index <= count; index += 1) {
    insert.run(`D${String(index).padStart(2, '0')}`);
  }
}

function seedAttention(db: SdoDatabase): void {
  db.prepare(
    `INSERT INTO task (id, seq, title, kind, created_by, status, at)
     VALUES ('T1', 1, '实现登录', 'implement', 'human-pm', 'in_progress', '2026-01-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO attention
       (id, task_id, raised_by, asked_of, question, options, state, expires_at, at)
     VALUES ('A1', 'T1', 'agent-dev', 'human-pm', '要不要把登录拆成两步？',
             '["是","否"]', 'open', '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();
}

function seedEventChain(db: SdoDatabase): void {
  db.prepare(
    "INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES ('task.assigned', '2026-01-01T00:00:00Z', '已派发')",
  ).run();
  db.prepare(
    `INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash)
     VALUES ('E1', '2026-01-01T00:00:00Z', 'human-pm', 'task.assigned', 'T1', '{}', '[]', NULL, '', 'h-e1')`,
  ).run();
  db.prepare(
    `INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash)
     VALUES ('E2', '2026-01-01T00:00:01Z', 'human-pm', 'task.assigned', 'T1', '{}', '[]', NULL, 'E1', 'h-e2')`,
  ).run();
}

const BASELINE_COLUMNS = [
  'policy_id',
  'preset',
  'stages',
  'gates',
  'review',
  'thresholds',
  'switches',
  'assurance',
  'engine',
  'artifact_kinds',
  'na_criteria',
  'frozen_by',
  'frozen_at',
  'hash',
];

test('C1 只执行目录 SQL：baseline 与 001 表同名，仍读到视图语义', () => {
  withViewerDb((db) => {
    seedBaseline(db);
    const result = query(db, { view: 'baseline' }, { session: asViewer(db) });
    assert.equal(result.miss, undefined);
    assert.equal(result.rows.length, 1);
    const row = result.rows[0] as Record<string, unknown>;
    // 若误 `FROM baseline`（001 的表），列会是 id/frozen_by/...；视图语义是 policy_id/frozen_at/...
    assert.deepEqual(Object.keys(row), BASELINE_COLUMNS);
    assert.equal(row['policy_id'], 'B1');
    assert.equal(row['preset'], 'm0');
    assert.equal(row['frozen_at'], '2026-01-01T00:00:00Z');
    // SQLite 里 JSON 列是 TEXT；查询层不解析 JSON（保持与 M0-3 视图一致的原始行）。
    assert.deepEqual(JSON.parse(String(row['engine'])), {
      version: 'eng-1',
      criteria_manifest_hash: 'cmh-1',
    });
  });
});

test('C1 源码里没有 FROM <视图名> 插值，也不解析原生视图名', () => {
  const dir = join(process.cwd(), 'src/query');
  const files = readdirSync(dir).filter((name) => name.endsWith('.ts'));
  assert.ok(files.includes('execute.ts'));
  for (const file of files) {
    const source = readFileSync(join(dir, file), 'utf8');
    assert.ok(!/FROM\s+\$\{/.test(source), `${file}: 禁止把视图名插值进 FROM`);
    assert.ok(!source.includes('nativeViewName'), `${file}: 禁止解析 catalog 名 → 原生视图名`);
  }
  const execute = readFileSync(join(dir, 'execute.ts'), 'utf8');
  assert.ok(execute.includes('FROM ('), 'execute.ts: 视图必须在子查询里执行');
});

test('C2 目录里塞 DELETE：被拒且不执行', () => {
  withViewerDb((db) => {
    seedDefects(db, 1);
    const { sink, misses } = collector();
    db.prepare(
      `INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget)
       VALUES ('bad_view', 'DELETE FROM defect', '[]', '反例：写入 SQL', 'reader', 5)`,
    ).run();

    const result = query(db, { view: 'bad_view' }, { sink, session: asViewer(db) });
    assert.equal(result.miss?.reason, 'unsafe_view_sql');
    assert.equal(result.rows.length, 0);
    assert.equal(misses.length, 1);
    // 没有被执行：缺陷还在。
    const count = db.prepare('SELECT count(*) AS n FROM defect').get() as { n: number };
    assert.equal(count.n, 1);
    // 直接校验也拒绝（复用 M0-3 的实现）。
    assert.throws(() => assertSelectOnly('DELETE FROM defect'));
  });
});

test('C3 权限裁剪：reader 查 review_queue 被拒并留痕；decider 正常返回', () => {
  withViewerDb((db) => {
    seedAttention(db);

    const reader = collector();
    const denied = query(db, { view: 'review_queue' }, { sink: reader.sink, session: asViewer(db, 'reader-view', 'read') });
    assert.equal(denied.miss?.reason, 'filtered_by_permission');
    assert.equal(denied.rows.length, 0);
    assert.equal(reader.misses.length, 1);
    assert.equal(reader.misses[0]?.view, 'review_queue');

    const decider = collector();
    const allowed = query(db, { view: 'review_queue' }, { sink: decider.sink, session: asViewer(db, 'decider-view', 'decide') });
    assert.equal(allowed.miss, undefined);
    assert.equal(allowed.rows.length, 1);
    assert.equal((allowed.rows[0] as Record<string, unknown>)['item_id'], 'A1');
    assert.equal(decider.misses.length, 0);
  });
});

test('C3 目录可见性：list 对 reader=12、decider=14（超 8KB 走游标），且按 name 升序', () => {
  withViewerDb((db) => {
    // reader 的 12 行目录已超 8KB（011 加 conflicts 后），按预算截断并给游标。
    const readerNames: string[] = [];
    let readerPage = query(db, { view: 'list' }, { session: asViewer(db, 'reader-view', 'read') });
    let readerCursor: string | undefined = readerPage.next_cursor;
    for (let guard = 0; guard < 10; guard += 1) {
      assert.equal(readerPage.miss, undefined);
      assert.equal(readerPage.bytes, Buffer.byteLength(JSON.stringify(readerPage), 'utf8'));
      assert.ok(readerPage.bytes <= MAX_RESULT_BYTES);
      readerNames.push(...readerPage.rows.map((row) => String((row as Record<string, unknown>)['name'])));
      if (readerCursor === undefined) break;
      const nextCursor: string = readerCursor;
      readerPage = query(db, { view: 'list', cursor: nextCursor }, { session: asViewer(db, 'reader-view', 'read') });
      readerCursor = readerPage.next_cursor;
    }
    assert.equal(readerNames.length, 12);
    assert.equal(new Set(readerNames).size, 12, 'reader 目录分页不得重复');
    assert.ok(!readerNames.includes('review_queue'));
    assert.ok(!readerNames.includes('gaps'));

    // decider 看到 14 行目录；恢复 columns[].type 后 14 行 JSON 超 8KB，首屏按预算截断。
    const firstPage = query(db, { view: 'list' }, { session: asViewer(db, 'decider-view', 'decide') });
    assert.equal(firstPage.miss, undefined);
    assert.equal(firstPage.truncated, true);
    assert.ok(firstPage.next_cursor !== undefined);
    assert.equal(firstPage.bytes, Buffer.byteLength(JSON.stringify(firstPage), 'utf8'));
    assert.ok(firstPage.bytes <= MAX_RESULT_BYTES);

    const names: string[] = [];
    let page = firstPage;
    let cursor: string | undefined = firstPage.next_cursor;
    for (let guard = 0; guard < 10; guard += 1) {
      names.push(...page.rows.map((row) => String((row as Record<string, unknown>)['name'])));
      if (cursor === undefined) break;
      const next: string = cursor;
      page = query(db, { view: 'list', cursor: next }, { session: asViewer(db, 'decider-view', 'decide') });
      assert.equal(page.miss, undefined);
      assert.equal(page.bytes, Buffer.byteLength(JSON.stringify(page), 'utf8'));
      assert.ok(page.bytes <= MAX_RESULT_BYTES);
      cursor = page.next_cursor;
    }
    assert.equal(names.length, 14);
    assert.equal(new Set(names).size, 14, '目录分页不得重复');
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));

    const sample = firstPage.rows[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(sample), ['name', 'doc', 'columns', 'min_right', 'row_budget']);
    const columns = sample['columns'] as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(columns));
    assert.ok(columns.some((column) => typeof column['type'] === 'string'), 'columns 必须保留 type');
    assert.equal(typeof sample['doc'], 'string');
    // 目录自描述不含 sql 执行细节
    assert.ok(!('sql' in sample));

    // `sdo_query({view:'list'})` 与列表接口的 14 个视图同名集合一致
    const catalog = listViewCatalog(db);
    assert.deepEqual(names, catalog.map((view) => view.name));
  });
});

test('C6 as_of：必带、同一 as_of 两次逐字节相同、旧 as_of 是结构化 miss', () => {
  withViewerDb((db) => {
    seedDefects(db, 2);
    seedEventChain(db);
    // 事件链 E1(prev='') ← E2，frontier 只有头 E2。
    const first = query(db, { view: 'defects' }, { session: asViewer(db) });
    const second = query(db, { view: 'defects' }, { session: asViewer(db) });
    // 建库预置的基线授权也进事件链（A2），as_of 断言只看业务事件。
    const grantIds = new Set(
      (db.prepare("SELECT id FROM event WHERE kind IN ('right.granted','right.revoked')").all() as Array<{ id: string }>).map((row) => row.id),
    );
    assert.deepEqual(first.as_of.filter((id) => !grantIds.has(id)), ['E2']);
    assert.deepEqual(first, second);

    const byAsOf = query(db, { view: 'defects', as_of: first.as_of }, { session: asViewer(db) });
    assert.deepEqual(byAsOf.rows, first.rows);
    assert.equal(byAsOf.miss, undefined);

    const stale = query(db, { view: 'defects', as_of: ['E1'] }, { session: asViewer(db) });
    assert.equal(stale.miss?.reason, 'stale_as_of');
    assert.equal(stale.rows.length, 0);
  });
});

test('C7 缺视图/缺列/坏参数：三种结构化 miss，不抛裸异常', () => {
  withViewerDb((db) => {
    seedDefects(db, 3);
    const { sink, misses } = collector();

    const missingView = query(db, { view: 'release_gaps_by_owner' }, { sink, session: asViewer(db) });
    assert.equal(missingView.miss?.reason, 'view_not_found');

    const missingColumn = query(db, { view: 'defects', select: ['no_such_column'] }, { sink, session: asViewer(db) });
    assert.equal(missingColumn.miss?.reason, 'column_not_found');
    assert.match(missingColumn.miss?.hint ?? '', /defect_id/);

    const invalidCases: Array<[string, () => ReturnType<typeof query>]> = [
      ['limit=0', () => query(db, { view: 'defects', limit: 0 }, { sink, session: asViewer(db) })],
      ['limit>row_budget', () => query(db, { view: 'defects', limit: 201 }, { sink, session: asViewer(db) })],
      ['select=[]', () => query(db, { view: 'defects', select: [] }, { sink, session: asViewer(db) })],
      ['where', () => query(db, { view: 'defects', where: { status: 'open' } }, { sink, session: asViewer(db) })],
      ['order', () => query(db, { view: 'defects', order: ['at desc'] }, { sink, session: asViewer(db) })],
      ['cursor=garbage', () => query(db, { view: 'defects', cursor: 'not-a-cursor' }, { sink, session: asViewer(db) })],
      ['as_of shape', () => query(db, { view: 'defects', as_of: [1] as never }, { sink, session: asViewer(db) })],
    ];
    for (const [label, run] of invalidCases) {
      const result = run();
      assert.equal(result.miss?.reason, 'invalid_args', label);
      assert.equal(result.rows.length, 0, label);
    }
    assert.equal(misses.length, 1 + 1 + invalidCases.length);
  });
});

test('C2/目录：14 条视图 SQL 全部通过 assertSelectOnly', () => {
  withViewerDb((db) => {
    const catalog = listViewCatalog(db);
    assert.equal(catalog.length, 14);
    for (const view of catalog) {
      assert.doesNotThrow(() => assertSelectOnly(view.sql), view.name);
    }
  });
});
