/**
 * 控制台三页的数据装载（M0-5，C2）。
 *
 * 纪律：页面上的每个数字都是一条 `Figure`，带 `{view, args}` 来源；渲染层只负责把
 * 值放进模板，不做计算、不读表、不写死数字。测试用同一个 `query(view,args)` 复算
 * 每个 Figure（空库 + 有数据两次）。
 *
 * 本文件只调用 `src/query` 的公开 API 与 `src/db` 的类型；不 import 宿主包（C4）。
 */

import type { SdoDatabase } from '../db/driver.js';
import { query } from '../query/index.js';
import type { QueryResult, Right } from '../query/index.js';

/** 一个数字/文本值的来源：只允许 13 个目录视图之一（A3）。 */
export interface FigureSource {
  readonly view: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * 如何从 `query(source.view, source.args)` 的结果复算这个值：
 * - `field`：取第 `row`（默认 0）行的字段；
 * - `row_count`：结果的行数（"本页行数"，截断时也精确，因为定义就是返回行数）。
 */
export type FigureDerive =
  | { readonly kind: 'field'; readonly field: string; readonly row?: number }
  | { readonly kind: 'row_count' };

export interface Figure {
  readonly id: string;
  readonly label: string;
  readonly unit?: string;
  readonly value: string | number;
  readonly source: FigureSource;
  readonly derive: FigureDerive;
}

export interface TableColumn {
  readonly name: string;
  readonly label: string;
  readonly unit?: string;
}

export interface TableModel {
  readonly source: FigureSource;
  /** 人话标题；缺省用视图名（标题里不许出现业务数字/结论）。 */
  readonly title?: string;
  readonly columns: readonly TableColumn[];
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly truncated: boolean;
}

export interface PageMiss {
  readonly view: string;
  readonly reason: string;
  readonly hint?: string;
}

export type PageId = 'overview' | 'board' | 'plan';

export interface PageModel {
  readonly id: PageId;
  readonly title: string;
  readonly heading: string;
  readonly figures: readonly Figure[];
  readonly tables: readonly TableModel[];
  readonly misses: readonly PageMiss[];
  /** 页面所有读数共同的 frontier；空库为 `[]`。 */
  readonly as_of: readonly string[];
}

const NO_ARGS: Readonly<Record<string, unknown>> = {};

function queryView(db: SdoDatabase, view: string, right: unknown): QueryResult {
  return query(db, { view }, { right: right as Right });
}

function missOf(view: string, result: QueryResult): PageMiss | undefined {
  if (result.miss === undefined) return undefined;
  const miss: PageMiss = {
    view,
    reason: result.miss.reason,
    ...(result.miss.hint === undefined ? {} : { hint: result.miss.hint }),
  };
  return miss;
}

function fieldFigure(
  id: string,
  label: string,
  result: QueryResult,
  field: string,
  options: { unit?: string; row?: number; view?: string } = {},
): Figure {
  const rowIndex = options.row ?? 0;
  const row = result.rows[rowIndex];
  const raw = row === undefined ? undefined : row[field];
  const value = typeof raw === 'number' ? raw : String(raw ?? '—');
  const derive: FigureDerive = rowIndex === 0
    ? { kind: 'field', field }
    : { kind: 'field', field, row: rowIndex };
  return {
    id,
    label,
    ...(options.unit === undefined ? {} : { unit: options.unit }),
    value,
    source: { view: options.view ?? 'overview', args: NO_ARGS },
    derive,
  };
}

function rowCountFigure(id: string, label: string, result: QueryResult, view: string): Figure {
  return {
    id,
    label,
    value: result.rows.length,
    source: { view, args: NO_ARGS },
    derive: { kind: 'row_count' },
  };
}

function tableOf(
  view: string,
  result: QueryResult,
  columns: readonly TableColumn[],
  title?: string,
): TableModel {
  return {
    source: { view, args: NO_ARGS },
    ...(title === undefined ? {} : { title }),
    columns,
    rows: result.rows,
    truncated: result.truncated,
  };
}

const BOARD_COLUMNS: readonly TableColumn[] = [
  { name: 'task_id', label: '卡号' },
  { name: 'title', label: '标题' },
  { name: 'status', label: '状态' },
  { name: 'owner', label: '负责人' },
  { name: 'last_action', label: '最近动作' },
  { name: 'last_report', label: '最近报告' },
  { name: 'block_code', label: '阻塞码' },
];

const PLAN_COLUMNS: readonly TableColumn[] = [
  { name: 'task_id', label: '卡号' },
  { name: 'status', label: '状态' },
  { name: 'blocked_by', label: '依赖（未满足）' },
  { name: 'scope', label: '写域' },
];

const QUEUE_COLUMNS: readonly TableColumn[] = [
  { name: 'rank', label: '优先级' },
  { name: 'title', label: '事项' },
  { name: 'action', label: '建议动作' },
  { name: 'reason_code', label: '原因' },
  { name: 'since', label: '自' },
];

/**
 * 总览页（`/`）：回答"现在什么状态"。
 *
 * 数字来源（口径见 docs/05 §9 与 §10.1，测试用同一条口径表钉死）：
 * - `stage`/`health`/`in_flight`/`open_defects`/`blocked` 来自 `overview`；
 *   `blocked` 是**被卡卡数**（卡住了多少张卡），不是"要人答多少条"；
 * - `to_decide` 来自 `review_queue` 的行数（需要 decider 权限；权限不够则不出这个数字，
 *   并留一条 `filtered_by_permission` miss）——这是「要我决定」的入口，不是 `pm_queue`。
 * - 下表是 `pm_queue`（PM 的下一步，≤7 行，**只读**）；它不是待审队列。
 */
export function loadOverviewPage(db: SdoDatabase, right: unknown = 'decider'): PageModel {
  const overview = queryView(db, 'overview', right);
  const queue = queryView(db, 'pm_queue', right);
  const review = queryView(db, 'review_queue', right);
  const misses: PageMiss[] = [];
  for (const [view, result] of [
    ['overview', overview],
    ['pm_queue', queue],
  ] as const) {
    const miss = missOf(view, result);
    if (miss !== undefined) misses.push(miss);
  }
  const reviewMiss = missOf('review_queue', review);

  const figures: Figure[] = [
    fieldFigure('stage', '阶段', overview, 'stage', { view: 'overview' }),
    fieldFigure('health', '健康度', overview, 'health', { view: 'overview' }),
    fieldFigure('in_flight', '卡数（进行中）', overview, 'in_flight', { unit: '张', view: 'overview' }),
    fieldFigure('open_defects', '红过（未修缺陷）', overview, 'open_defects', { unit: '条', view: 'overview' }),
    fieldFigure('blocked', '被卡卡数', overview, 'blocked', { unit: '张', view: 'overview' }),
  ];
  if (review.miss === undefined) {
    figures.push(rowCountFigure('to_decide', '要我决定（待审项）', review, 'review_queue'));
  } else if (reviewMiss !== undefined) {
    misses.push(reviewMiss);
  }

  return {
    id: 'overview',
    title: '总览',
    heading: 'SDO 控制台 · 总览',
    figures,
    tables: [tableOf('pm_queue', queue, QUEUE_COLUMNS, 'PM 队列（只读）')],
    misses,
    as_of: overview.as_of,
  };
}

/** board 页（`/board`）：看每张卡做到哪了；行数本身也是一条带来源的读数。 */
export function loadBoardPage(db: SdoDatabase, right: unknown = 'decider'): PageModel {
  const board = queryView(db, 'board', right);
  const misses: PageMiss[] = [];
  const miss = missOf('board', board);
  if (miss !== undefined) misses.push(miss);
  return {
    id: 'board',
    title: 'Board',
    heading: 'SDO 控制台 · Board',
    figures: [rowCountFigure('board_rows', '本页行数', board, 'board')],
    tables: [tableOf('board', board, BOARD_COLUMNS)],
    misses,
    as_of: board.as_of,
  };
}

/** plan 页（`/plan`）：看计划行与依赖。 */
export function loadPlanPage(db: SdoDatabase, right: unknown = 'decider'): PageModel {
  const plan = queryView(db, 'plan', right);
  const misses: PageMiss[] = [];
  const miss = missOf('plan', plan);
  if (miss !== undefined) misses.push(miss);
  return {
    id: 'plan',
    title: 'Plan',
    heading: 'SDO 控制台 · Plan',
    figures: [rowCountFigure('plan_rows', '本页行数', plan, 'plan')],
    tables: [tableOf('plan', plan, PLAN_COLUMNS)],
    misses,
    as_of: plan.as_of,
  };
}
