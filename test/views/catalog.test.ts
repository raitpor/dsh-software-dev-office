import assert from 'node:assert/strict';
import { test } from 'node:test';

import { columnNames, withMigratedDb } from '../db/helpers.js';
import {
  RIGHT_LEVELS,
  assertSelectOnly,
  listViewCatalog,
  nativeViewName,
  viewsForRight,
  type Right,
} from '../../src/views/catalog.js';

/** docs/05 §3 的 13 个视图名（按 name 排序）。 */
const EXPECTED_NAMES = [
  'agents',
  'alignment',
  'baseline',
  'board',
  'defects',
  'evidence',
  'gaps',
  'overview',
  'plan',
  'pm_gaps',
  'pm_queue',
  'review_queue',
  'team',
];

/** docs/05 §3 声明的 min_right：只有 review_queue（decider）与 gaps（reviewer）不是 reader。 */
const EXPECTED_MIN_RIGHT: Readonly<Record<string, Right>> = {
  agents: 'reader',
  alignment: 'reader',
  baseline: 'reader',
  board: 'reader',
  defects: 'reader',
  evidence: 'reader',
  gaps: 'reviewer',
  overview: 'reader',
  plan: 'reader',
  pm_gaps: 'reader',
  pm_queue: 'reader',
  review_queue: 'decider',
  team: 'reader',
};

function catalogRowCount(db: Parameters<typeof listViewCatalog>[0]): number {
  const row = db.prepare('SELECT count(*) AS n FROM view_catalog').get() as Record<string, unknown>;
  return Number(row['n']);
}

test('C1：002 迁移建 view_catalog（6 列）且有 13 行，字段齐全可解析', () => {
  withMigratedDb((db) => {
    assert.equal(catalogRowCount(db), 13);
    assert.deepEqual(columnNames(db, 'view_catalog'), [
      'name',
      'sql',
      'columns',
      'doc',
      'min_right',
      'row_budget',
    ]);

    const catalog = listViewCatalog(db);
    assert.equal(catalog.length, 13);
    assert.deepEqual(
      catalog.map((view) => view.name),
      EXPECTED_NAMES,
    );

    for (const view of catalog) {
      assert.equal(view.min_right, EXPECTED_MIN_RIGHT[view.name], `min_right of ${view.name}`);
      assert.ok(RIGHT_LEVELS[view.min_right] >= 1, `min_right level of ${view.name}`);
      assert.equal(typeof view.doc, 'string');
      assert.ok(view.doc.length > 0, `doc of ${view.name}`);
      assert.ok(Number.isInteger(view.row_budget) && view.row_budget >= 1, `row_budget of ${view.name}`);
      assert.ok(view.columns.length > 0, `columns of ${view.name}`);
      for (const column of view.columns) {
        assert.ok(column.name.length > 0);
        assert.ok(column.label.length > 0, `label of ${view.name}.${column.name} must be human-readable`);
        assert.ok(
          ['text', 'integer', 'number', 'timestamp', 'array', 'object', 'boolean'].includes(column.type),
          `type of ${view.name}.${column.name}`,
        );
      }
      // 目录里的视图 SQL 必须是只读 SELECT；listViewCatalog 已 fail-closed 校验，这里再显式确认一次。
      assert.doesNotThrow(() => assertSelectOnly(view.sql), `sql of ${view.name} must be select-only`);
    }
  });
});

test('C1 正例：只往目录加一条 INSERT，listViewCatalog/viewsForRight 零代码可见', () => {
  withMigratedDb((db) => {
    const readerBefore = viewsForRight(db, 'reader').map((view) => view.name);

    db.prepare(
      `INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget)
       VALUES ('ad_hoc_notes', 'SELECT 1 AS note_id', ?, '临时视图（C1 正例）', 'reader', 10)`,
    ).run(JSON.stringify([{ name: 'note_id', label: '临时编号', type: 'integer' }]));

    const catalog = listViewCatalog(db);
    assert.equal(catalog.length, 14);

    const readerAfter = viewsForRight(db, 'reader').map((view) => view.name);
    assert.deepEqual(readerAfter, [...readerBefore, 'ad_hoc_notes'].sort());
  });
});

test('C4：13 条视图 SQL 全部通过 assertSelectOnly', () => {
  withMigratedDb((db) => {
    const catalog = listViewCatalog(db);
    assert.equal(catalog.length, 13);
    for (const view of catalog) {
      assertSelectOnly(view.sql);
    }
  });
});

test('C4：拒写入/改结构关键字；字符串与注释里的词不误伤', () => {
  const allowed = [
    'SELECT 1 AS x',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    "SELECT 'DELETE FROM task' AS s, 'a''b' AS q",
    'SELECT 1 -- DELETE FROM task',
    'SELECT /* DROP TABLE task; */ 1',
    'SELECT "DELETE" AS quoted_identifier',
    'SELECT [DROP] AS bracketed_identifier, `INSERT` AS backticked_identifier',
  ];
  for (const sql of allowed) {
    assert.doesNotThrow(() => assertSelectOnly(sql), `should allow: ${sql}`);
  }

  const rejected: Array<[string, RegExp]> = [
    ['DELETE FROM task', /read-only/],
    ['INSERT INTO task (id) VALUES (1)', /read-only/],
    ['UPDATE task SET status = 1', /read-only/],
    ['REPLACE INTO task (id) VALUES (1)', /read-only/],
    ['ATTACH DATABASE :memory: AS other', /read-only/],
    ['DETACH DATABASE other', /read-only/],
    ['PRAGMA user_version', /read-only/],
    ['CREATE VIEW x AS SELECT 1', /read-only/],
    ['DROP VIEW overview', /read-only/],
    ['ALTER TABLE task ADD COLUMN x TEXT', /read-only/],
    ['WITH x AS (SELECT 1) DELETE FROM task', /read-only/],
    ['SELECT 1; DROP TABLE task', /single statement/],
    ['SELECT 1;', /single statement/],
    ["SELECT 'unterminated", /unterminated/],
    ['/* unterminated', /unterminated/],
    ['EXPLAIN SELECT 1', /start with SELECT or WITH/],
    ['', /start with SELECT or WITH/],
  ];
  for (const [sql, pattern] of rejected) {
    assert.throws(() => assertSelectOnly(sql), pattern, `should reject: ${sql}`);
  }
});

test('listViewCatalog fail-closed：坏 columns JSON 与写入 SQL 都不出库', () => {
  withMigratedDb((db) => {
    db.prepare(
      `INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget)
       VALUES ('bad_columns', 'SELECT 1', 'not-json', '坏目录行', 'reader', 5)`,
    ).run();
    assert.throws(() => listViewCatalog(db), /not valid JSON/);
  });

  withMigratedDb((db) => {
    db.prepare(
      `INSERT INTO view_catalog (name, sql, columns, doc, min_right, row_budget)
       VALUES ('bad_sql', 'DELETE FROM task', ?, '坏目录行', 'reader', 5)`,
    ).run(JSON.stringify([{ name: 'x', label: '测试列', type: 'text' }]));
    assert.throws(() => listViewCatalog(db), /read-only/);
  });
});

test('C6：viewsForRight 按 min_right 层级给集合（review_queue 仅 decider、gaps 仅 reviewer+）', () => {
  withMigratedDb((db) => {
    const names = (right: Right): string[] => viewsForRight(db, right).map((view) => view.name);

    const reader = names('reader');
    assert.equal(reader.length, 11);
    assert.ok(!reader.includes('review_queue'), 'reader 不应看到 review_queue');
    assert.ok(!reader.includes('gaps'), 'reader 不应看到 gaps');
    assert.deepEqual(
      reader,
      EXPECTED_NAMES.filter((name) => EXPECTED_MIN_RIGHT[name] === 'reader'),
    );

    const reviewer = names('reviewer');
    assert.equal(reviewer.length, 12);
    assert.ok(reviewer.includes('gaps'));
    assert.ok(!reviewer.includes('review_queue'), 'reviewer 不应看到 review_queue（decider 才可见）');
    assert.deepEqual(
      reviewer,
      EXPECTED_NAMES.filter((name) => RIGHT_LEVELS[EXPECTED_MIN_RIGHT[name] ?? 'signer'] <= RIGHT_LEVELS.reader + 1),
    );

    const decider = names('decider');
    assert.equal(decider.length, 13);
    assert.ok(decider.includes('review_queue'));
    assert.ok(decider.includes('gaps'));
    assert.deepEqual(decider, EXPECTED_NAMES);

    assert.deepEqual(names('signer'), EXPECTED_NAMES);

    // 层级单调：权限越高，可见集合越大。
    assert.ok(reader.length < reviewer.length);
    assert.ok(reviewer.length < decider.length);
    assert.equal(decider.length, names('signer').length);

    assert.throws(
      () => viewsForRight(db, 'admin' as unknown as Right),
      /unknown right/,
    );
  });
});

test('nativeViewName：baseline/evidence 与 001 表同名，原生视图落 *_view；其余同名', () => {
  assert.equal(nativeViewName('baseline'), 'baseline_view');
  assert.equal(nativeViewName('evidence'), 'evidence_view');
  assert.equal(nativeViewName('overview'), 'overview');
  assert.equal(nativeViewName('pm_queue'), 'pm_queue');
});
