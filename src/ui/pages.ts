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
import type { QueryResult } from '../query/index.js';
import { filterPmQueueRows, readReviewQueueAccess } from '../core/pm/access.js';
import type { ApplyEntry, PmQueueAccess, RightsPort } from '../core/pm/access.js';
export type { ApplyEntry, RightsPort } from '../core/pm/access.js';
import type { PmQueueRow } from '../core/pm/queue.js';
import type { Session } from '../core/auth/session.js';

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
  /**
   * M3-6：query 因会话身份裁掉的列名（原样传递，渲染层只提示数量，不回填值）。
   * 缺省 = 没有列被裁。
   */
  readonly redacted_columns?: readonly string[];
}

/**
 * 撤权页面的两条 hint 文案（M3-7 单一源）：**不写任何数字/隐藏计数**，也不写具体 scope
 * （scope 由 apply entry 的 `<code>` 展示）。测试直接引用常量锁死“不许插值”。
 */
export const REVIEW_QUEUE_HINTS = {
  hidden: '部分待审项不在你的域内：见下方申请入口',
  noRead: '当前身份没有待审队列的读取权：见下方申请入口',
} as const;

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
  /**
   * M3-5：撤权后可见的“申请入口”（当前指向 `escalate`，M4 换真 `grant`）。
   * 入口本身不判权；提交动作才判权（卡 C2/A2）。
   */
  readonly apply_entries: readonly ApplyEntry[];
  /** 页面所有读数共同的 frontier；空库为 `[]`。 */
  readonly as_of: readonly string[];
}

/**
 * 控制台身份（M3-5/M3-6）：**session 必填**，没有会话就不许装载页面（fail-closed）。
 * 视图级判权与列级裁剪都以 `session.actor_kind` 为唯一身份来源（D-056）。
 */
export interface ConsoleAccess {
  readonly actor: string;
  readonly rights: RightsPort;
  readonly session: Session;
}

function requireAccess(access: ConsoleAccess | undefined): ConsoleAccess {
  if (
    access === undefined ||
    typeof access.actor !== 'string' ||
    access.actor.length === 0 ||
    access.session === undefined ||
    access.session.actor !== access.actor
  ) {
    throw new Error(
      '控制台需要会话身份（session）：未配置 SDO_CONSOLE_ACTOR/SDO_CONSOLE_ACTOR_KIND 或会话与 actor 不一致时拒绝装载页面（fail-closed）',
    );
  }
  return access;
}

const NO_ARGS: Readonly<Record<string, unknown>> = {};

function queryView(db: SdoDatabase, view: string, session: Session): QueryResult {
  return query(db, { view }, { session });
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
    columns: columns.filter(
      (column) => !(result.redacted_columns ?? []).includes(column.name),
    ),
    rows: result.rows,
    truncated: result.truncated,
    ...(result.redacted_columns === undefined || result.redacted_columns.length === 0
      ? {}
      : { redacted_columns: [...result.redacted_columns] }),
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

const TEAM_COLUMNS: readonly TableColumn[] = [
  { name: 'actor_id', label: '身份' },
  { name: 'kind', label: '类型' },
  { name: 'scopes', label: '域' },
  { name: 'rights', label: '已签决策类型' },
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
export function loadOverviewPage(
  db: SdoDatabase,
  _right: unknown = 'decider',
  access?: ConsoleAccess,
): PageModel {
  const effectiveAccess = requireAccess(access);
  const session = effectiveAccess.session;
  const overview = queryView(db, 'overview', session);
  const queue = queryView(db, 'pm_queue', session);
  const review = queryView(db, 'review_queue', session);
  const team = queryView(db, 'team', session);

  const misses: PageMiss[] = [];
  for (const [view, result] of [
    ['overview', overview],
    ['pm_queue', queue],
    ['team', team],
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

  const reviewAccess = readReviewQueueAccess(db, effectiveAccess.rights, session);
  const pmAccess: PmQueueAccess = filterPmQueueRows(
    queue.rows as unknown as PmQueueRow[],
    effectiveAccess.rights,
  );
  const queueRows = pmAccess.rows as unknown as readonly Readonly<Record<string, unknown>>[];
  const applyEntries = dedupeEntries([...reviewAccess.apply_entries, ...pmAccess.apply_entries]);

  if (reviewAccess.filtered) {
    // 撤权后“待审项消失”：不出数字（M0-5 口径：有来源才出数字），只给申请入口。
    // M3-7：连“有 N 条被隐藏”也不出——N 是隐藏计数，对已无权限的人是泄露（S25）。
    // P2-1：判断依据是“访问被过滤”而不是“hidden 非空”——空队列 + deny-all 原本会出假 `to_decide=0`。
    const hint =
      reviewAccess.hidden.length > 0 ? REVIEW_QUEUE_HINTS.hidden : REVIEW_QUEUE_HINTS.noRead;
    misses.push({ view: 'review_queue', reason: 'filtered_by_permission', hint });
  } else if (reviewMiss !== undefined) {
    misses.push(reviewMiss);
  } else {
    figures.push(rowCountFigure('to_decide', '要我决定（待审项）', review, 'review_queue'));
  }

  const teamTable = tableOf('team', team, TEAM_COLUMNS, '团队（签章状态）');

  return {
    id: 'overview',
    title: '总览',
    heading: 'SDO 控制台 · 总览',
    figures,
    tables: [tableOf('pm_queue', { ...queue, rows: queueRows }, QUEUE_COLUMNS, 'PM 队列（只读）'), teamTable],
    misses,
    apply_entries: applyEntries,
    as_of: overview.as_of,
  };
}

function dedupeEntries(entries: readonly ApplyEntry[]): readonly ApplyEntry[] {
  const seen = new Map<string, ApplyEntry>();
  for (const entry of entries) seen.set(entry.scope, entry);
  return [...seen.values()].sort((a, b) => a.scope.localeCompare(b.scope));
}

/** board 页（`/board`）：看每张卡做到哪了；行数本身也是一条带来源的读数。 */
export function loadBoardPage(db: SdoDatabase, _right: unknown = 'decider', access?: ConsoleAccess): PageModel {
  const board = queryView(db, 'board', requireAccess(access).session);
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
    apply_entries: [],
    as_of: board.as_of,
  };
}

/** plan 页（`/plan`）：看计划行与依赖。 */
export function loadPlanPage(db: SdoDatabase, _right: unknown = 'decider', access?: ConsoleAccess): PageModel {
  const plan = queryView(db, 'plan', requireAccess(access).session);
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
    apply_entries: [],
    as_of: plan.as_of,
  };
}
