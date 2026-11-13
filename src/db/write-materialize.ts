/**
 * M1-0 物化：全量重放后把 fold 内存状态 diff 落到投影表（A2 口径）。
 *
 * 范围（M1-0）：7 张可安全物化的表（`MATERIALIZED_TABLES`）。fold 产出落在集外的表一律失败
 * （安全网），全表对齐归 D-031 / M1-7。
 * 列以 001 DDL 为准（`PRAGMA table_info`）；fold 行上 DDL 没有的列必须进 `FOLD_ONLY_COLUMNS`
 * 白名单，否则抛错（防止静默丢字段）。fold 没有的行删掉——全量重放是权威。
 *
 * `decision` 特例（D-019）：只物化 `signature` 非空的行。`decision.valid` 单批不落库，
 * 等 `decision.signed` 才出现；`verify` 用同一口径（`verify-projection.ts`）。
 */

import type { SdoDatabase } from './driver.js';
import { canonicalJson } from '../core/fold/canonical.js';
import { fold } from '../core/fold/index.js';
import { TABLE_NAMES, type FoldState, type Row, type TableName } from '../core/fold/types.js';
import { readEvents } from '../core/verify-events.js';
import type { VerifyProblem } from '../core/verify-types.js';

/**
 * 不由 `append`/`fold` 拥有的表：`event`/`event_kind` 是事件存储本身；`claim`/`receipt` 是
 * renderer 写入（M1-6）；`field_consumer` 是目录数据；`scenario` 是 D-024 设计缺口。
 * 这些表不能进物化集合——fold 里没有它们，全量 DELETE 会把数据清掉。
 */
export const NON_MATERIALIZED: readonly TableName[] = [
  'event',
  'event_kind',
  'claim',
  'receipt',
  'field_consumer',
  'scenario',
];

/**
 * M1-0 的物化面（第 62 轮收窄回 (a)，+ 第 62 轮复认 B）：
 * 四域（intent/spec/criterion/evidence）+ `decision`（四表的外键父）+ `restatement`/`restatement_diff`
 * （三个 restatement.* reducer 的投影；两表都有 `id` PK、无 fold-only 列、无 JSON 口径问题）。
 * “物化全表”是独立设计对齐工作，拆到后续卡（台账 D-031），不混在写网关里。
 */
export const MATERIALIZED_TABLES: readonly TableName[] = [
  'decision',
  'intent',
  'spec',
  'criterion',
  'evidence',
  'restatement',
  'restatement_diff',
  'criterion_fixture',
];

/**
 * 写网关接受的 kind 白名单：投影必须落在这 7 张表里。
 * `assumption.*`/`contract.*` 写的是 `spec` 表的行（kind='assumption'/'contract'），所以也在内。
 * 其余已登记 kind 一律 `unsupported_scope`——宁可写不进去，也不接受自己物化不了的事件。
 */
export const SUPPORTED_KINDS: Readonly<Record<string, string>> = {
  'decision.valid': 'decision',
  'decision.signed': 'decision',
  'decision.revoked': 'decision',
  'decision.rejected': 'decision',
  'intent.signed': 'intent',
  'spec.defined': 'spec',
  'spec.revised': 'spec',
  'assumption.recorded': 'spec',
  'assumption.disposed': 'spec',
  'assumption.invalidated': 'spec',
  'contract.defined': 'spec',
  'criterion.registered': 'criterion',
  'criterion.revised': 'criterion',
  'evidence.attached': 'evidence',
  'restatement.recorded': 'restatement',
  'restatement.diff_dispositioned': 'restatement_diff',
  'restatement.invalidated': 'restatement',
};

/**
 * fold 行比 001 DDL 多出的列。每一项都是已知偏差（台账 D-021）；新增项必须显式登记，
 * 否则 `materializeTable` 抛错，C5 测试也会红。
 */
export const FOLD_ONLY_COLUMNS: Readonly<Partial<Record<TableName, readonly string[]>>> = {
  decision: ['rejected_at', 'rejected_reason'],
  intent: ['status'],
  spec: ['revised_at', 'decision_id', 'successor_ref', 'disposed_at', 'invalidated_reason', 'invalidated_at'],
  criterion: ['at', 'revised_at'],
};

function toSqlValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

interface TableColumn {
  readonly name: string;
}

function tableColumns(db: SdoDatabase, table: TableName): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as TableColumn[];
  return rows.map((row) => row.name);
}

function existingRows(db: SdoDatabase, table: TableName): Map<string, Row> {
  const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  const map = new Map<string, Row>();
  for (const row of rows) {
    map.set(String(row['id']), row);
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
  // D-019：只落 signed 行；`decision.valid` 单批不物化。
  const signed: Record<string, Row> = {};
  for (const [id, row] of Object.entries(rows)) {
    if (row['signature'] !== null) {
      signed[id] = row;
    }
  }
  return signed;
}

function materializeTable(db: SdoDatabase, table: TableName, state: FoldState): void {
  const nextRows = projectedRows(state, table);
  const columns = tableColumns(db, table);
  const existing = existingRows(db, table);

  for (const [id, next] of Object.entries(nextRows)) {
    ensureNoUnknownFoldOnlyColumns(table, id, next, columns);
    const current = existing.get(id);
    if (current !== undefined && !rowsDiffer(current, next, columns)) {
      existing.delete(id);
      continue;
    }
    if (current === undefined) {
      const values = columns.map((column) => toSqlValue(next[column]));
      const placeholders = columns.map(() => '?').join(', ');
      db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`).run(...values);
    } else {
      const updates = columns.filter((column) => column !== 'id').map((column) => `${column} = ?`).join(', ');
      const values = columns.filter((column) => column !== 'id').map((column) => toSqlValue(next[column]));
      db.prepare(`UPDATE ${table} SET ${updates} WHERE id = ?`).run(...values, id);
    }
    existing.delete(id);
  }

  // 全量重放是权威：fold 里没有的行必须删掉（只可能是被篡改后重放回正）。
  for (const staleId of existing.keys()) {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(staleId);
  }
}

export function materialize(db: SdoDatabase): void {
  const problems: VerifyProblem[] = [];
  const events = readEvents(db, problems);
  if (problems.length > 0) {
    throw new Error(`event chain unreadable during materialization: ${problems[0]?.detail ?? 'unknown'}`);
  }
  const state = fold(undefined, events);
  // fail-closed 安全网：白名单漏了某 kind，或 reducer 写了范围外的表 ⇒ 直接失败，不静默丢投影。
  for (const table of TABLE_NAMES) {
    if (MATERIALIZED_TABLES.includes(table)) continue;
    const rows = state.tables[table];
    const firstId = Object.keys(rows)[0];
    if (firstId !== undefined) {
      throw new Error(
        `fold produced rows in ${table} (e.g. ${firstId}), which is outside the M1-0 materialized set`,
      );
    }
  }
  for (const table of MATERIALIZED_TABLES) {
    materializeTable(db, table, state);
  }
}
