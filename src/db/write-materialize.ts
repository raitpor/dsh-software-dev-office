/**
 * M1-7 物化：全量重放后把 fold 内存状态 diff 落到投影表（A2 口径）。
 *
 * 物化面 = fold 能产出的全部表（`TABLE_NAMES` − `NON_MATERIALIZED`）。第 62 轮把“物化全表”
 * 收窄成 7 张是权宜；本卡按 D-031 的四个前置条件逐个钉死后开闸。
 *
 * 三条硬规矩：
 * 1. **键 = DDL 主键**（`PRAGMA table_info` 的 pk 列），不假设有 `id` 列、不加代理 id；
 * 2. fold 行比 DDL 多出的列必须进 `FOLD_ONLY_COLUMNS`，否则抛错（C2 双向断言白名单）；
 * 3. fold 没有的行删掉——全量重放是权威。
 *
 * `decision` 特例（D-019）：只物化 `signature` 非空的行；`verify` 用同一口径。
 */

import type { SdoDatabase } from './driver.js';
import { canonicalJson } from '../core/fold/canonical.js';
import { fold } from '../core/fold/index.js';
import { REDUCERS } from '../core/fold/registry.js';
import { TABLE_NAMES, type FoldState, type Row, type TableName } from '../core/fold/types.js';
import { readEvents } from '../core/verify-events.js';
import type { VerifyProblem } from '../core/verify-types.js';

/** 不由 `append`/`fold` 拥有的表：事件存储、renderer 表（M1-6）、目录数据、设计缺口、视图注册表。 */
export const NON_MATERIALIZED: readonly TableName[] = [
  'event',
  'event_kind',
  'claim',
  'receipt',
  'field_consumer',
  'scenario',
  'view_catalog' as TableName, // 002 迁移新增的视图注册表；TableName 由 fold 的 34 张表定义，这里只做过滤用
];

/** 物化面：fold 能产出的全部表。放不开的表必须先回 D-031 的四个前置条件，不许靠删集合绕过。 */
export const MATERIALIZED_TABLES: readonly TableName[] = TABLE_NAMES.filter(
  (table) => !NON_MATERIALIZED.includes(table),
);

/** 事件 kind → 它写哪张表（`write-envelope` 的 `unsupported_scope` 消息与覆盖测试共用）。 */
const PREFIX_TABLE: Readonly<Record<string, TableName>> = {
  decision: 'decision',
  intent: 'intent',
  spec: 'spec',
  assumption: 'spec',
  contract: 'spec',
  criterion: 'criterion',
  evidence: 'evidence',
  task: 'task',
  goal: 'goal_node',
  release: 'release',
  baseline: 'baseline',
  report: 'report',
  attention: 'attention',
  defect: 'defect',
  stage: 'stage_run',
  gate: 'stage_run',
  review: 'review',
  redteam: 'redteam',
  verify: 'verify_run',
  config: 'config',
  snapshot: 'snapshot',
  scope: 'scope_decl',
  design: 'design_lock',
  restatement: 'restatement',
};

const KIND_TABLE_OVERRIDES: Readonly<Record<string, TableName>> = {
  'goal.integrated': 'integration',
  'review.round_closed': 'review_round',
  'restatement.diff_dispositioned': 'restatement_diff',
};

export function requiredTable(kind: string): TableName | undefined {
  const override = KIND_TABLE_OVERRIDES[kind];
  if (override !== undefined) return override;
  return PREFIX_TABLE[kind.split('.')[0] ?? ''];
}

/**
 * 写网关接受的全部 kind：所有在 `REDUCERS` 里、且投影落在物化面内的 kind。
 * ACK kind 不物化，保持 `unsupported_scope`（它们没有 fold 产出）。
 */
export const SUPPORTED_KINDS: Readonly<Record<string, TableName>> = Object.fromEntries(
  Object.keys(REDUCERS).flatMap((kind) => {
    const table = requiredTable(kind);
    return table !== undefined && MATERIALIZED_TABLES.includes(table) ? [[kind, table]] : [];
  }),
);

/**
 * fold 行比 001 DDL 多出的列（逐表）。每一项都是 fold 的投影口径，必须显式登记；
 * 测试会断言“实际忽略列 == 白名单”，漏登记/多登记都红。
 */
export const FOLD_ONLY_COLUMNS: Readonly<Partial<Record<TableName, readonly string[]>>> = {
  design_lock: ['id'],
  redteam: ['disposed_at'],
  attention: ['answer', 'answered_at', 'withdrawn_at'],
  criterion: ['at', 'revised_at'],
  decision: ['rejected_at', 'rejected_reason'],
  defect: ['closed_at'],
  goal_node: ['reparented_at'],
  intent: ['status'],
  review: ['verified_at'],
  spec: ['revised_at', 'decision_id', 'successor_ref', 'disposed_at', 'invalidated_reason', 'invalidated_at'],
  stage_run: ['judged_at'],
  task: [
    'claimed_at',
    'reserved_by',
    'reserved_until',
    'blocked_reason',
    'blocked_at',
    'unblocked_at',
    'done_at',
    'evidence_id',
    'reopened_reason',
    'reopened_at',
    'drop_kind',
    'drop_reason',
    'drop_credential',
    'dropped_at',
  ],
};

function toSqlValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

interface ColumnInfo {
  readonly name: string;
  readonly pk: number;
}

function tableInfo(db: SdoDatabase, table: TableName): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

/** 主键列按 DDL 的 pk 序号排序；没有主键的表在 001 里不存在，若出现直接报错。 */
export function primaryKeyColumns(db: SdoDatabase, table: TableName): string[] {
  const columns = tableInfo(db, table)
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);
  if (columns.length === 0) {
    throw new Error(`table ${table} has no primary key; cannot materialize`);
  }
  return columns;
}

function rowKey(db: SdoDatabase, table: TableName, row: Row): string {
  const pk = primaryKeyColumns(db, table);
  return canonicalJson(pk.map((column) => toSqlValue(row[column])));
}

function existingRows(db: SdoDatabase, table: TableName): Map<string, Row> {
  const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  const map = new Map<string, Row>();
  for (const row of rows) {
    map.set(rowKey(db, table, row), row);
  }
  return map;
}

function rowsDiffer(existing: Row, next: Row, columns: readonly string[]): boolean {
  return columns.some((column) => {
    const current = typeof existing[column] === 'object' ? existing[column] : toSqlValue(existing[column]);
    return canonicalJson(current) !== canonicalJson(toSqlValue(next[column]));
  });
}

export function ensureNoUnknownFoldOnlyColumns(table: TableName, id: string, row: Row, columns: readonly string[]): void {
  const allowed = new Set(FOLD_ONLY_COLUMNS[table] ?? []);
  const ignored = Object.keys(row).filter((column) => !columns.includes(column));
  const unexpected = ignored.filter((column) => !allowed.has(column));
  if (unexpected.length > 0) {
    throw new Error(
      `fold row ${table}/${id} has column(s) not in DDL and not in FOLD_ONLY_COLUMNS: ${unexpected.join(', ')}`,
    );
  }
}

function projectedRows(state: FoldState, table: TableName): Readonly<Record<string, Row>> {
  const rows = state.tables[table] as Readonly<Record<string, Row>>;
  if (table !== 'decision') return rows;
  const signed: Record<string, Row> = {};
  for (const [id, row] of Object.entries(rows)) {
    if (row['signature'] !== null) {
      signed[id] = row;
    }
  }
  return signed;
}

export interface MaterializeOptions {
  /** 测试用：临时收窄物化面以验证安全网；生产路径不传。 */
  readonly tables?: readonly TableName[];
}

function materializeTable(db: SdoDatabase, table: TableName, state: FoldState): void {
  const nextRows = projectedRows(state, table);
  const columns = tableInfo(db, table).map((column) => column.name);
  const pk = primaryKeyColumns(db, table);
  const existing = existingRows(db, table);

  for (const [id, next] of Object.entries(nextRows)) {
    ensureNoUnknownFoldOnlyColumns(table, id, next, columns);
    const key = rowKey(db, table, next);
    const current = existing.get(key);
    if (current !== undefined && !rowsDiffer(current, next, columns)) {
      existing.delete(key);
      continue;
    }
    if (current === undefined) {
      const values = columns.map((column) => toSqlValue(next[column]));
      // release 的插入触发器只接受 draft/frozen：物化最终态时先按 frozen 落行，再走状态迁移。
      let initialStatus: string | undefined;
      if (table === 'release') {
        const statusIndex = columns.indexOf('status');
        const finalStatus = String(next['status']);
        initialStatus = finalStatus === 'draft' ? 'draft' : 'frozen';
        values[statusIndex] = initialStatus;
      }
      const placeholders = columns.map(() => '?').join(', ');
      db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
      if (table === 'release' && initialStatus !== String(next['status'])) {
        const where = pk.map((column) => `${column} = ?`).join(' AND ');
        db.prepare(`UPDATE release SET status = ?, package_version = ? WHERE ${where}`).run(
          toSqlValue(next['status']),
          toSqlValue(next['package_version']),
          ...pk.map((column) => toSqlValue(next[column])),
        );
      }
    } else {
      const updates = columns.filter((column) => !pk.includes(column)).map((column) => `${column} = ?`).join(', ');
      const values = columns.filter((column) => !pk.includes(column)).map((column) => toSqlValue(next[column]));
      const where = pk.map((column) => `${column} = ?`).join(' AND ');
      const whereValues = pk.map((column) => toSqlValue(next[column]));
      db.prepare(`UPDATE ${table} SET ${updates} WHERE ${where}`).run(...values, ...whereValues);
    }
    existing.delete(key);
  }

  // 全量重放是权威：fold 里没有的行必须删掉（只可能是被篡改后重放回正）。
  for (const [key, row] of existing) {
    const where = pk.map((column) => `${column} = ?`).join(' AND ');
    db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...pk.map((column) => toSqlValue(row[column])));
    void key;
  }
}

export function materialize(db: SdoDatabase, options: MaterializeOptions = {}): void {
  const tables = options.tables ?? MATERIALIZED_TABLES;
  const problems: VerifyProblem[] = [];
  const events = readEvents(db, problems);
  if (problems.length > 0) {
    throw new Error(`event chain unreadable during materialization: ${problems[0]?.detail ?? 'unknown'}`);
  }
  const state = fold(undefined, events);
  // fail-closed 安全网：reducer 写了物化面外的表 ⇒ 直接失败，不静默丢投影。
  for (const table of TABLE_NAMES) {
    if (tables.includes(table)) continue;
    const rows = state.tables[table];
    const firstId = Object.keys(rows)[0];
    if (firstId !== undefined) {
      throw new Error(`fold produced rows in ${table} (e.g. ${firstId}), which is outside the materialized set`);
    }
  }
  for (const table of tables) {
    materializeTable(db, table, state);
  }
}
