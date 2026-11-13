import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withMigratedDb } from '../db/helpers.js';
import { query } from '../../src/query/index.js';
import type { QueryResult } from '../../src/query/index.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { listViewCatalog } from '../../src/views/catalog.js';
import {
  loadBoardPage,
  loadOverviewPage,
  loadPlanPage,
} from '../../src/ui/pages.js';
import type { Figure, PageModel } from '../../src/ui/pages.js';
import { renderPage } from '../../src/ui/render.js';

const RIGHT = 'decider';

/**
 * 口径表（评审 P2-2）：每个读数 id 的来源视图与取数方式在这里**显式钉死**，
 * 不靠 "实现算一遍、测试再算一遍" 的弱自证。新加/改数字必须改这张表。
 */
const OVERVIEW_CONTRACT: Readonly<
  Record<string, { view: string; derive: 'field' | 'row_count'; field?: string }>
> = {
  stage: { view: 'overview', derive: 'field', field: 'stage' },
  health: { view: 'overview', derive: 'field', field: 'health' },
  in_flight: { view: 'overview', derive: 'field', field: 'in_flight' },
  open_defects: { view: 'overview', derive: 'field', field: 'open_defects' },
  blocked: { view: 'overview', derive: 'field', field: 'blocked' },
  to_decide: { view: 'review_queue', derive: 'row_count' },
};

function replay(db: SdoDatabase, figure: Figure): QueryResult {
  return query(db, { view: figure.source.view, ...figure.source.args }, { right: RIGHT });
}

/** C2 的通用复算：每个 Figure 都能由 `query(view,args)` 按 `derive` 重新算出同一个值。 */
function assertFiguresRecomputable(db: SdoDatabase, page: PageModel): void {
  assert.ok(page.figures.length > 0, `${page.id} 页必须至少有一个读数`);
  for (const figure of page.figures) {
    assert.equal(figure.source.args && typeof figure.source.args, 'object', `${figure.id} 来源 args`);
    const result = replay(db, figure);
    assert.equal(result.miss, undefined, `${figure.id} 的来源 ${figure.source.view} 不应 miss`);
    if (figure.derive.kind === 'field') {
      const row = result.rows[figure.derive.row ?? 0];
      assert.ok(row, `${figure.id} 的字段行存在`);
      assert.equal(figure.value, row[figure.derive.field], `${figure.id} 应等于 ${figure.source.view}.${figure.derive.field}`);
    } else {
      assert.equal(figure.value, result.rows.length, `${figure.id} 应等于 ${figure.source.view} 的行数`);
    }
  }
}

function figureValue(page: PageModel, id: string): string | number {
  const figure = page.figures.find((candidate) => candidate.id === id);
  assert.ok(figure, `缺少读数 ${id}`);
  return figure.value;
}

function seed(db: SdoDatabase): void {
  db.prepare(
    "INSERT INTO task (id, seq, title, kind, created_by, owner, status, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run('T1', 1, '视图目录', 'implement', 'pm', 'dev-a', 'in_progress', '2026-11-13T00:00:00Z');
  db.prepare(
    "INSERT INTO task (id, seq, title, kind, created_by, status, block_code, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run('T2', 2, '控制台三页', 'implement', 'pm', 'blocked', 'awaiting_signature', '2026-11-13T00:01:00Z');
  db.prepare(
    "INSERT INTO defect (id, kind, severity, family, status, at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run('D1', 'criterion', 'high', 'spec', 'open', '2026-11-13T00:02:00Z');
  db.prepare(
    "INSERT INTO stage_run (id, stage, gate_id, baseline_hash, entered_at, verdict, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run('S1', 'build', 'G1', 'BASE-1', '2026-11-13T00:03:00Z', 'pass', '2026-11-13T00:03:00Z');
  db.prepare("INSERT OR IGNORE INTO event_kind (kind, since) VALUES ('report.recorded', '2026-11-13')").run();
  db.prepare(
    "INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run('E1', '2026-11-13T00:04:00Z', 'dev-a', 'report.recorded', 'T1', '{}', '[]', '', 'h1');
  db.prepare(
    'INSERT INTO report (id, task_id, state, at) VALUES (?, ?, ?, ?)',
  ).run('R1', 'T1', 'progress', '2026-11-13T00:04:30Z');
}

test('C2：空库三页的每个读数都能用 query(view,args) 复算，且为显式空态', () => {
  withMigratedDb((db) => {
    const overview = loadOverviewPage(db, RIGHT);
    assertFiguresRecomputable(db, overview);
    assert.equal(figureValue(overview, 'stage'), 'unset');
    assert.equal(figureValue(overview, 'health'), 'green');
    assert.equal(figureValue(overview, 'in_flight'), 0);
    assert.equal(figureValue(overview, 'open_defects'), 0);
    assert.equal(figureValue(overview, 'blocked'), 0);
    assert.equal(overview.tables[0]?.rows.length, 0, '空库 pm_queue 0 行');
    assert.equal(overview.tables[0]?.title, 'PM 队列（只读）', 'pm_queue 表标题不能叫“待审”');
    assert.equal(figureValue(overview, 'to_decide'), 0, '空库待审项 0');
    assert.deepEqual(overview.as_of, []);

    const board = loadBoardPage(db, RIGHT);
    assertFiguresRecomputable(db, board);
    assert.equal(figureValue(board, 'board_rows'), 0);
    assert.deepEqual(board.misses, []);

    const plan = loadPlanPage(db, RIGHT);
    assertFiguresRecomputable(db, plan);
    assert.equal(figureValue(plan, 'plan_rows'), 0);
    assert.deepEqual(plan.misses, []);
  });
});

test('C2：有数据时三个必答数字与 overview 逐字段相等（卡数/红过/待确认），board/plan 跟上', () => {
  withMigratedDb((db) => {
    seed(db);
    const overview = loadOverviewPage(db, RIGHT);
    assertFiguresRecomputable(db, overview);
    const source = replay(db, overview.figures[0] as Figure);
    const row = source.rows[0];
    assert.ok(row);
    assert.equal(figureValue(overview, 'in_flight'), row['in_flight']);
    assert.equal(figureValue(overview, 'open_defects'), row['open_defects']);
    assert.equal(figureValue(overview, 'blocked'), row['blocked']);
    assert.equal(figureValue(overview, 'in_flight'), 1);
    assert.equal(figureValue(overview, 'open_defects'), 1);
    assert.equal(figureValue(overview, 'blocked'), 1);
    assert.equal(figureValue(overview, 'stage'), 'build');
    assert.equal(overview.as_of.length, 1, 'as_of 跟着事件头走');

    const board = loadBoardPage(db, RIGHT);
    assertFiguresRecomputable(db, board);
    assert.equal(figureValue(board, 'board_rows'), 2);
    const boardRow = board.tables[0]?.rows.find((candidate) => candidate['task_id'] === 'T1');
    assert.ok(boardRow, 'board 应有 T1');
    assert.equal(boardRow['last_action'], 'report.recorded');
    assert.equal(boardRow['last_report'], 'progress');
    const blockedRow = board.tables[0]?.rows.find((candidate) => candidate['task_id'] === 'T2');
    assert.equal(blockedRow?.['status'], 'blocked');
    assert.equal(blockedRow?.['block_code'], 'awaiting_signature');

    const plan = loadPlanPage(db, RIGHT);
    assertFiguresRecomputable(db, plan);
    assert.equal(figureValue(plan, 'plan_rows'), 2);
  });
});

test('C2：模板不写死数字——改模型里的值，渲染结果跟着变', () => {
  withMigratedDb((db) => {
    seed(db);
    const model = loadOverviewPage(db, RIGHT);
    const rendered = renderPage(model);
    const mutated: PageModel = {
      ...model,
      figures: model.figures.map((figure) => ({ ...figure, value: -987654 })),
    };
    const mutatedHtml = renderPage(mutated);
    assert.notEqual(mutatedHtml, rendered);
    for (const figure of model.figures) {
      assert.match(mutatedHtml, new RegExp(`-987654`), `${figure.id} 的模板占位应使用模型值`);
    }
    assert.match(rendered, /data-figure="in_flight"/);
    assert.match(rendered, /来源 query\(overview\)/);
  });
});

test('C2：同一模型两次渲染逐字节相同（同 as_of 确定性）', () => {
  withMigratedDb((db) => {
    seed(db);
    const model = loadPlanPage(db, RIGHT);
    assert.equal(renderPage(model), renderPage(model));
  });
});

test('C2：读数来源只允许目录里的视图名（A3）', () => {
  withMigratedDb((db) => {
    seed(db);
    const catalogNames = new Set(listViewCatalog(db).map((view) => view.name));
    for (const page of [loadOverviewPage(db, RIGHT), loadBoardPage(db, RIGHT), loadPlanPage(db, RIGHT)]) {
      for (const figure of page.figures) {
        assert.ok(catalogNames.has(figure.source.view), `${figure.id} 来源 ${figure.source.view} 不在 view_catalog`);
      }
      for (const table of page.tables) {
        assert.ok(catalogNames.has(table.source.view), `表格来源 ${table.source.view} 不在 view_catalog`);
      }
    }
  });
});

test('空库与有数据的渲染结果不同（负例：写死数字的模板不可能通过）', () => {
  withMigratedDb((db) => {
    const emptyHtml = renderPage(loadOverviewPage(db, RIGHT));
    seed(db);
    const seededHtml = renderPage(loadOverviewPage(db, RIGHT));
    assert.notEqual(emptyHtml, seededHtml);
    assert.match(emptyHtml, /data-page="overview"/);
    assert.match(seededHtml, /data-page="overview"/);
  });
});


test('C2 口径表：每个数字的 id→{view,field} 显式钉死；label 含“待确认”的不得来自 blocked', () => {
  withMigratedDb((db) => {
    const page = loadOverviewPage(db, RIGHT);
    assert.deepEqual(
      page.figures.map((figure) => figure.id).sort(),
      Object.keys(OVERVIEW_CONTRACT).sort(),
      '总览读数集合必须与口径表一致（新增数字先改口径表）',
    );
    for (const figure of page.figures) {
      const expected = OVERVIEW_CONTRACT[figure.id];
      assert.ok(expected, `口径表缺 ${figure.id}`);
      assert.equal(figure.source.view, expected.view, `${figure.id} 来源视图`);
      assert.equal(figure.derive.kind, expected.derive, `${figure.id} 取数方式`);
      if (expected.derive === 'field') {
        assert.equal(figure.derive.kind === 'field' ? figure.derive.field : undefined, expected.field);
      }
    }

    const blocked = page.figures.find((figure) => figure.id === 'blocked');
    assert.ok(blocked);
    assert.equal(blocked.label, '被卡卡数', 'blocked 是“卡住了多少张卡”，不是“待确认条数”');
    assert.doesNotMatch(blocked.label, /待确认/);
    // 回归守卫：任何 label 含「待确认」的数字都不许来自 overview.blocked。
    for (const figure of page.figures) {
      if (!figure.label.includes('待确认')) continue;
      const source = figure.source.view === 'overview' && figure.derive.kind === 'field'
        ? figure.derive.field
        : undefined;
      assert.notEqual(source, 'blocked', `${figure.id} 把“被卡卡数”标成了待确认`);
    }

    const queue = page.tables.find((table) => table.source.view === 'pm_queue');
    assert.ok(queue);
    assert.equal(queue.title, 'PM 队列（只读）');
    assert.doesNotMatch(queue.title ?? '', /待审/);
  });
});

test('C2：decider 有「要我决定」数字（review_queue 行数）；reader 拿不到时显式权限 miss', () => {
  withMigratedDb((db) => {
    const decider = loadOverviewPage(db, 'decider');
    const toDecide = decider.figures.find((figure) => figure.id === 'to_decide');
    assert.ok(toDecide, 'decider 应看到“要我决定”');
    assert.equal(toDecide.source.view, 'review_queue');
    assert.equal(toDecide.derive.kind, 'row_count');
    const replayed = query(db, { view: 'review_queue' }, { right: 'decider' });
    assert.equal(toDecide.value, replayed.rows.length);

    const reader = loadOverviewPage(db, 'reader');
    assert.equal(reader.figures.some((figure) => figure.id === 'to_decide'), false, 'reader 不应看到 decider 的数字');
    const miss = reader.misses.find((candidate) => candidate.view === 'review_queue');
    assert.ok(miss, 'reader 应有 review_queue 的 miss');
    assert.equal(miss.reason, 'filtered_by_permission');
    const html = renderPage(reader);
    assert.match(html, /权限不足/);
  });
});

test('P2-3：页脚不写死视图数量（目录会变，页脚不能撒谎）', () => {
  withMigratedDb((db) => {
    const html = renderPage(loadOverviewPage(db, RIGHT));
    assert.doesNotMatch(html, /13 个视图/);
    assert.match(html, /数据来自 view_catalog 中的视图/);
  });
});
