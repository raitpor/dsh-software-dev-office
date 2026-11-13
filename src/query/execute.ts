/**
 * `sdo_query` 的唯一执行路径（M0-4）。
 *
 * 设计依据：docs/05 §4（`QueryResult` 契约）、§5（`query_miss`）、§6（`min_right`）、
 * §7（预算）、§16（不变式）；docs/02 §13（`as_of` = `Frontier = readonly EventId[]`）。
 *
 * 硬规则（判据 C1/C2）：
 *   - 查视图**只**执行 `view_catalog.sql` 子查询（`SELECT ... FROM (<catalog.sql>)`），
 *     绝不 `FROM <catalog.name>`——`baseline`/`evidence` 与 001 的表同名（D-011 影子风险）；
 *   - 执行前必须过 `assertSelectOnly`（复用 M0-3 的实现，不复制）。
 *
 * 输出（判据 C4/C5/C6）：
 *   - 每次返回都带 `as_of`（输入一致性令牌；M0 不支持历史快照读）；
 *   - 行数超 `row_budget`/500 或**整包**字节超 8KB ⇒ 截断 + `next_cursor` + `truncated=true`；
 *   - `bytes` 是 `JSON.stringify(QueryResult)` 的整包 UTF-8 字节数（含游标/as_of/view 等）；
 *   - 游标冻结 `(view, args, as_of, offset, 最后一行摘要)`，续查前核对 frontier 与边界行，
 *     漂移就返回结构化 `stale_as_of`，不用 offset 硬翻；
 *   - 单行（含必须附带的游标）仍超预算 ⇒ 结构化 `result_too_large`，不返回半行/假游标。
 */

import { createHash } from 'node:crypto';

import { recordAccessSafe } from '../db/access-log.js';
import type { SdoDatabase } from '../db/driver.js';
import {
  assertSelectOnly,
  listViewCatalog,
  viewsForRight,
  type ViewCatalogRow,
} from '../views/catalog.js';
import { MAX_RESULT_BYTES, MAX_ROWS_PER_QUERY } from './budget.js';
import {
  decodeCursor,
  encodeCursor,
  sameCursorArgs,
  type CursorArgs,
  type CursorPayload,
} from './cursor.js';
import { createMiss, NOOP_MISS_SINK, type MissSink, type QueryMiss } from './miss.js';
import { canRead, resolveRight, type Right } from './rights.js';

/** 一组事件 id 的因果闭包（docs/02 §13）；M0 取当前所有事件头（输入一致性令牌，非历史快照读）。 */
export type Frontier = readonly string[];

/** 查询结果的一行；键是视图列名（人话标签/单位在 `view_catalog.columns`）。 */
export type Row = Readonly<Record<string, unknown>>;

/** `sdo_query` 的调用参数（docs/05 §1）；M0 支持 view/select/limit/cursor/as_of。 */
export interface QueryArgs {
  readonly view: string;
  readonly select?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
  readonly as_of?: Frontier;
  /** M0 不支持：出现即结构化 `invalid_args`，不接受调用方 SQL 片段。 */
  readonly where?: unknown;
  /** M0 不支持：出现即结构化 `invalid_args`。 */
  readonly order?: unknown;
}

/** 调用上下文：谁在读、miss 去哪（M1 把 sink 换成真事件写入）。 */
export interface QueryContext {
  readonly right?: unknown;
  readonly sink?: MissSink;
}

/** docs/05 §4 的输出契约。 */
export interface QueryResult {
  readonly rows: readonly Row[];
  readonly bytes: number;
  readonly truncated: boolean;
  readonly next_cursor?: string;
  readonly as_of: Frontier;
  readonly view: string;
  readonly miss?: QueryMiss;
}

/** `view:'list'` 的列（目录自描述，不含 `sql`——执行细节不给调用方）。 */
const LIST_VIEW = 'list';
const LIST_COLUMNS = ['name', 'doc', 'columns', 'min_right', 'row_budget'] as const;

const SINGLE_RESULT_TOO_LARGE_HINT =
  '单行（含必须附带的游标/as_of）整包已超 8KB 预算；请用 select 减少列或改用更窄的视图';

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function isFrontier(value: unknown): value is Frontier {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function sameFrontier(left: Frontier, right: Frontier): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * 当前 frontier：事件表的头集（没有被任何事件 `prev` 引用的事件），按 id 升序规范化。
 *
 * 只扫一次事件表（docs/02 §15 不变式 8：读路径单次事件表扫描 ≤1）；M1 起改读缓存。
 */
function currentFrontier(db: SdoDatabase): Frontier {
  const records = db.prepare('SELECT id, prev FROM event').all() as Array<Record<string, unknown>>;
  const referenced = new Set<string>();
  const ids: string[] = [];
  for (const record of records) {
    const id = record['id'];
    if (typeof id === 'string') ids.push(id);
    const prev = record['prev'];
    if (typeof prev === 'string' && prev.length > 0) referenced.add(prev);
  }
  return ids.filter((id) => !referenced.has(id)).sort();
}

/**
 * 行摘要：`sha256(JSON.stringify(row))` 取前 32 个十六进制字符（128 bit）。
 *
 * 游标只存摘要不存整行（第 54 轮 P1）：整行 base64 约占行宽 4/3，会随行宽挤占 8KB 预算；
 * 摘要定长 32 字符。规范化 = `JSON.stringify`（SQLite 列序稳定，同一 `select` 下续查重算一致）。
 */
function rowDigest(row: Row): string {
  return createHash('sha256').update(JSON.stringify(row), 'utf8').digest('hex').slice(0, 32);
}

/** 结果体：除 `bytes` 外的完整返回包。 */
type ResultBody = Omit<QueryResult, 'bytes'>;

/**
 * 把 `bytes` 填成整包 UTF-8 字节数。
 *
 * `bytes` 自身也在 JSON 里，位数会影响总长 ⇒ 定点迭代（先按 0 估，测出实际长度，
 * 直到“写进去的数 = 量出来的总长”）。数字位数最多几步就稳定。
 */
function finalizeResult(body: ResultBody): QueryResult {
  let bytes = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate: QueryResult = { ...body, bytes };
    const measured = utf8Bytes(JSON.stringify(candidate));
    if (measured === bytes) return candidate;
    bytes = measured;
  }
  // 定点应在一两步内收敛；不收敛说明字节数计算或 JSON 形状有 bug，fail-closed。
  throw new Error('query result bytes did not converge');
}

type PageOutcome = { readonly ok: QueryResult } | { readonly tooLarge: true };

/**
 * 组一页并做整包预算（C4）。
 *
 * 自指点：`truncated=true` 必须带游标（定长摘要，不随行宽增长）；行留得越少整包越小。
 * 做法：从整页往下试，对每个 `keep` 估出真实整包长度，取第一个 ≤ 8KB 的；`keep=1` 仍超
 * ⇒ `result_too_large`（由调用方转成结构化 miss，不返回半行、不给假游标）。
 */
function finalizePage(
  pageRows: readonly Row[],
  hasMore: boolean,
  offset: number,
  cursorArgs: CursorArgs,
  asOf: Frontier,
  viewName: string,
): PageOutcome {
  const total = pageRows.length;
  if (total === 0) {
    return { ok: finalizeResult({ rows: [], truncated: false, as_of: asOf, view: viewName }) };
  }
  for (let keep = total; keep >= 1; keep -= 1) {
    const truncated = hasMore || keep < total;
    const rows = pageRows.slice(0, keep) as Row[];
    if (!truncated) {
      const result = finalizeResult({ rows, truncated: false, as_of: asOf, view: viewName });
      if (result.bytes <= MAX_RESULT_BYTES) return { ok: result };
      continue;
    }
    const last = rows[keep - 1] as Row;
    const next_cursor = encodeCursor({
      v: 1,
      args: cursorArgs,
      as_of: asOf,
      offset: offset + keep,
      last_row_hash: rowDigest(last),
    });
    const result = finalizeResult({ rows, truncated: true, next_cursor, as_of: asOf, view: viewName });
    if (result.bytes <= MAX_RESULT_BYTES) return { ok: result };
  }
  return { tooLarge: true };
}

/** 取某权限能看到的一行目录（`view:'list'` 用；按 name 升序，确定性）。 */
function buildListRows(db: SdoDatabase, right: Right, select?: readonly string[]): Row[] {
  const selected = select ?? LIST_COLUMNS;
  const rows: Row[] = [];
  for (const view of viewsForRight(db, right)) {
    const full: Record<string, unknown> = {
      name: view.name,
      doc: view.doc,
      // 目录原样返回（含 type）：形状不为预算让路；超 8KB 与其他视图一样截断 + 游标。
      columns: view.columns.map((column) => ({
        name: column.name,
        label: column.label,
        ...(column.unit === undefined ? {} : { unit: column.unit }),
        type: column.type,
      })),
      min_right: view.min_right,
      row_budget: view.row_budget,
    };
    const row: Record<string, unknown> = {};
    for (const column of selected) row[column] = full[column];
    rows.push(row);
  }
  return rows;
}

/**
 * 读留痕（M0-6 C3）：best-effort、不改 `QueryResult`、每进程最多一条 stderr warning。
 * 包在唯一执行路径外层，避免调用方绕过 `query()` 直接执行。
 */
function logAccess(db: SdoDatabase, args: QueryArgs, context: QueryContext): void {
  const bound: unknown = (db as { sdoPath?: unknown }).sdoPath;
  const dbPath: unknown = typeof bound === 'string' && bound.length > 0 ? bound : (db as { name?: unknown }).name;
  if (typeof dbPath !== 'string' || dbPath.length === 0 || dbPath === ':memory:') {
    return;
  }
  recordAccessSafe(dbPath, {
    at: new Date().toISOString(),
    view: typeof args?.view === 'string' ? args.view : '',
    args,
    right: resolveRight(context.right),
  });
}

/**
 * 读一个视图。
 *
 * @example
 * query(db, { view: 'pm_queue' });                       // reader 可见
 * query(db, { view: 'review_queue' }, { right: 'decider' }); // decider 才可见
 * query(db, { view: 'defects', limit: 5, cursor: page2 });   // 续查
 */
export function query(
  db: SdoDatabase,
  args: QueryArgs,
  context: QueryContext = {},
): QueryResult {
  const result = runQuery(db, args, context);
  logAccess(db, args, context);
  return result;
}

function runQuery(
  db: SdoDatabase,
  args: QueryArgs,
  context: QueryContext = {},
): QueryResult {
  const sink = context.sink ?? NOOP_MISS_SINK;
  const right = resolveRight(context.right);
  const frontier = currentFrontier(db);
  const view = typeof args?.view === 'string' ? args.view : '';

  const failed = (miss: QueryMiss): QueryResult => {
    sink.record(miss);
    return finalizeResult({ rows: [], truncated: false, as_of: frontier, view, miss });
  };

  // ---- 参数校验（C7：坏参数是结构化 miss，不是裸异常） ----
  if (typeof args?.view !== 'string' || args.view.length === 0) {
    return failed(createMiss('invalid_args', view, 'view 必填且为非空字符串'));
  }
  if (args.where !== undefined || args.order !== undefined) {
    return failed(
      createMiss(
        'invalid_args',
        view,
        'M0 只支持 view/select/limit/cursor/as_of；where/order 暂不支持（只执行目录里的视图 SQL）',
      ),
    );
  }
  if (args.select !== undefined) {
    const select = args.select;
    if (
      !Array.isArray(select) ||
      select.length === 0 ||
      select.some((column) => typeof column !== 'string' || column.length === 0)
    ) {
      return failed(createMiss('invalid_args', view, 'select 必须是非空列名数组'));
    }
    if (new Set(select).size !== select.length) {
      return failed(createMiss('invalid_args', view, 'select 里有重复列名'));
    }
  }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
    return failed(createMiss('invalid_args', view, 'limit 必须是 ≥1 的整数'));
  }
  if (args.as_of !== undefined && !isFrontier(args.as_of)) {
    return failed(createMiss('invalid_args', view, 'as_of 必须是事件 id 字符串数组'));
  }
  if (args.as_of !== undefined && !sameFrontier(args.as_of, frontier)) {
    return failed(
      createMiss(
        'stale_as_of',
        view,
        `请求的 as_of 不是当前 frontier（当前 ${frontier.length} 个事件头）；请不带 as_of 重新查询`,
      ),
    );
  }

  // ---- 游标解码（不透明 base64url；形状不对 = invalid_args） ----
  let cursor: CursorPayload | undefined;
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string' || args.cursor.length === 0) {
      return failed(createMiss('invalid_args', view, 'cursor 必须是字符串'));
    }
    try {
      cursor = decodeCursor(args.cursor);
    } catch (error) {
      return failed(createMiss('invalid_args', view, '游标无效', errorMessage(error)));
    }
    if (cursor.args.view !== view) {
      return failed(createMiss('invalid_args', view, `游标属于视图 "${cursor.args.view}"，不是 "${view}"`));
    }
    if (!sameFrontier(cursor.as_of, frontier)) {
      return failed(
        createMiss(
          'stale_as_of',
          view,
          '游标对应的快照已移动（有新事件），请从第一页重新查询',
        ),
      );
    }
  }

  // ---- `view:'list'`：返回目录本身（docs/05 §2；目录是数据，不执行 SQL） ----
  if (view === LIST_VIEW) {
    let listRows: Row[];
    try {
      let selected = args.select ?? cursor?.args.select;
      if (selected !== undefined) {
        for (const column of selected) {
          if (!(LIST_COLUMNS as readonly string[]).includes(column)) {
            return failed(
              createMiss(
                'column_not_found',
                view,
                `list 没有列 "${column}"；可用列：${LIST_COLUMNS.join(', ')}`,
              ),
            );
          }
        }
      } else {
        selected = undefined;
      }
      const effectiveLimit = args.limit ?? cursor?.args.limit ?? MAX_ROWS_PER_QUERY;
      if (effectiveLimit > MAX_ROWS_PER_QUERY) {
        return failed(createMiss('invalid_args', view, `limit 不得大于 ${MAX_ROWS_PER_QUERY}`));
      }
      const cursorArgs: CursorArgs = {
        view,
        limit: effectiveLimit,
        ...(selected === undefined ? {} : { select: [...selected] }),
      };
      if (cursor !== undefined && !sameCursorArgs(cursor.args, cursorArgs)) {
        return failed(createMiss('invalid_args', view, '游标与当前参数不一致（view/select/limit）'));
      }
      const offset = cursor?.offset ?? 0;
      listRows = buildListRows(db, right, selected);
      if (cursor !== undefined && offset > 0) {
        const boundary = listRows[offset - 1];
        if (boundary === undefined || rowDigest(boundary) !== cursor.last_row_hash) {
          return failed(createMiss('stale_as_of', view, '游标边界行已变化（快照被改写），请重新查询'));
        }
      }
      const page = listRows.slice(offset, offset + effectiveLimit);
      const hasMore = listRows.length > offset + page.length;
      const outcome = finalizePage(page, hasMore, offset, cursorArgs, frontier, view);
      if ('tooLarge' in outcome) {
        return failed(
          createMiss(
            'result_too_large',
            view,
            SINGLE_RESULT_TOO_LARGE_HINT,
          ),
        );
      }
      return outcome.ok;
    } catch (error) {
      return failed(createMiss('unsafe_view_sql', view, '目录读取失败', errorMessage(error)));
    }
  }

  // ---- 目录里找视图（只读一次；fail-closed 校验所有目录行的只读性） ----
  let views: ViewCatalogRow[];
  try {
    views = listViewCatalog(db);
  } catch (error) {
    return failed(createMiss('unsafe_view_sql', view, '视图目录未通过只读校验', errorMessage(error)));
  }
  const viewRow = views.find((candidate) => candidate.name === view);
  if (viewRow === undefined) {
    return failed(
      createMiss('view_not_found', view, '目录里没有这个视图；用 query({view:"list"}) 看可用视图'),
    );
  }

  // ---- 执行前再做一次只读校验（C2：复用 M0-3 的 assertSelectOnly，不复制实现） ----
  try {
    assertSelectOnly(viewRow.sql);
  } catch (error) {
    return failed(createMiss('unsafe_view_sql', view, '视图 SQL 未通过只读校验', errorMessage(error)));
  }

  // ---- 权限裁剪（C3）：行不返回，但必须留痕 ----
  if (!canRead(viewRow.min_right, right)) {
    return failed(
      createMiss('filtered_by_permission', view, `需要 ${viewRow.min_right} 权限（当前 ${right}）`),
    );
  }

  // ---- select：缺列是结构化 miss（C7） ----
  const requestedSelect = args.select ?? cursor?.args.select;
  const projection = requestedSelect ?? viewRow.columns.map((column) => column.name);
  if (requestedSelect !== undefined) {
    for (const column of requestedSelect) {
      if (!viewRow.columns.some((candidate) => candidate.name === column)) {
        return failed(
          createMiss(
            'column_not_found',
            view,
            `视图 "${view}" 没有列 "${column}"；可用列：${viewRow.columns.map((c) => c.name).join(', ')}`,
          ),
        );
      }
    }
  }

  // ---- 限额（C4 / A4）：默认 row_budget，显式 limit 不得超 ----
  const cap = Math.min(viewRow.row_budget, MAX_ROWS_PER_QUERY);
  const effectiveLimit = args.limit ?? cursor?.args.limit ?? cap;
  if (effectiveLimit > cap) {
    return failed(
      createMiss('invalid_args', view, `limit 不得大于 ${cap}（row_budget 与 ${MAX_ROWS_PER_QUERY} 取小）`),
    );
  }
  const cursorArgs: CursorArgs = {
    view,
    limit: effectiveLimit,
    ...(requestedSelect === undefined ? {} : { select: [...requestedSelect] }),
  };
  if (cursor !== undefined && !sameCursorArgs(cursor.args, cursorArgs)) {
    return failed(createMiss('invalid_args', view, '游标与当前参数不一致（view/select/limit）'));
  }

  const offset = cursor?.offset ?? 0;
  const projectionSql = projection.map(quoteIdent).join(', ');
  const pageSql = `SELECT ${projectionSql} FROM (${viewRow.sql}) LIMIT ? OFFSET ?`;

  let pageRows: Row[];
  try {
    // 边界行核对：直接写表（未落事件）时的漂移也能发现，避免 offset 重/漏。
    if (cursor !== undefined && offset > 0) {
      const boundarySql = `SELECT ${projectionSql} FROM (${viewRow.sql}) LIMIT 1 OFFSET ?`;
      const boundary = db.prepare(boundarySql).get(offset - 1) as Record<string, unknown> | undefined;
      if (boundary === undefined || rowDigest(boundary) !== cursor.last_row_hash) {
        return failed(createMiss('stale_as_of', view, '游标边界行已变化（快照被改写），请重新查询'));
      }
    }
    const rawRows = db.prepare(pageSql).all(effectiveLimit + 1, offset) as Array<Record<string, unknown>>;
    const hasMore = rawRows.length > effectiveLimit;
    pageRows = rawRows.slice(0, effectiveLimit);
    const outcome = finalizePage(pageRows, hasMore, offset, cursorArgs, frontier, view);
    if ('tooLarge' in outcome) {
      return failed(createMiss('result_too_large', view, SINGLE_RESULT_TOO_LARGE_HINT));
    }
    return outcome.ok;
  } catch (error) {
    return failed(createMiss('unsafe_view_sql', view, '视图 SQL 执行失败', errorMessage(error)));
  }
}
