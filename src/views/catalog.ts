import type { SdoDatabase } from '../db/driver.js';

/**
 * 视图目录（`view_catalog`）的读取与校验层（M0-3）。
 *
 * 设计依据：docs/05 §2/§3「视图是数据」——目录里的 name/sql/columns/doc/min_right/row_budget
 * 是数据而不是注释；新增视图 = 迁移里一条 INSERT，读取侧零代码改动。
 *
 * 本文件只做三件事，不写查询工具（预算/游标/query_miss 在 M0-4）：
 *   1. 把目录读成带类型、经过校验的对象；
 *   2. 按 `min_right` 层级给出某权限可见的视图集合（读库，不读代码常量）；
 *   3. 静态校验视图 SQL 只读（`assertSelectOnly`），并给出 catalog 名 → 原生视图名的映射。
 */

/** 权限层级：reader < reviewer < decider < signer（docs/05 §2 注释）。 */
export type Right = 'reader' | 'reviewer' | 'decider' | 'signer';

export const RIGHT_LEVELS: Readonly<Record<Right, number>> = {
  reader: 1,
  reviewer: 2,
  decider: 3,
  signer: 4,
};

/** `columns` JSON 的列类型；M0-4 只按它做展示，不在视图层解释业务。 */
export type ColumnType = 'text' | 'integer' | 'number' | 'timestamp' | 'array' | 'object' | 'boolean';

const COLUMN_TYPES: ReadonlySet<string> = new Set<ColumnType>([
  'text',
  'integer',
  'number',
  'timestamp',
  'array',
  'object',
  'boolean',
]);

/** `columns` JSON 的一列（docs/05 §4 硬规则 3：列名是人话 + 单位）。 */
export interface ViewColumn {
  readonly name: string;
  readonly label: string;
  readonly unit?: string;
  readonly type: ColumnType;
}

/** `view_catalog` 的一行，读完并校验后的形状。 */
export interface ViewCatalogRow {
  readonly name: string;
  /** 只读 SELECT，与原生视图 body 逐字相同（测试比对 sqlite_master）。 */
  readonly sql: string;
  readonly columns: readonly ViewColumn[];
  readonly doc: string;
  readonly min_right: Right;
  readonly row_budget: number;
}

/**
 * catalog 名 → 原生 SQLite 视图名。
 *
 * `baseline` / `evidence` 与 001 的两个投影表同名，而 SQLite 同一 schema 不允许
 * table 与 view 同名（migrations/001_init.sql 不能动、视图名也不能改设计），
 * 所以原生视图分别落名 `baseline_view` / `evidence_view`。对外的查询入口名仍是
 * catalog.name，本映射是唯一一处偏差，见 plan/03-偏差台账.md D-011。
 */
const NATIVE_VIEW_NAMES: Readonly<Record<string, string>> = {
  baseline: 'baseline_view',
  evidence: 'evidence_view',
};

export function nativeViewName(catalogName: string): string {
  return NATIVE_VIEW_NAMES[catalogName] ?? catalogName;
}

/** 出现在视图 SQL 里即视为写入/改结构的词；`SELECT/WITH` 之外的一律拒绝。 */
const FORBIDDEN_KEYWORDS: ReadonlySet<string> = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'CREATE',
  'DROP',
  'ALTER',
  'VACUUM',
  'REINDEX',
  'ANALYZE',
  'TRIGGER',
]);

/**
 * 静态校验：视图 SQL 必须是单条只读 SELECT（可带 WITH 前缀）。
 *
 * 按 docs/05 §2「只允许 SELECT；服务端静态校验」实现。手写词法扫描而不是正则：
 * 字符串字面量（`'...'`，`''` 转义）、`--` 行注释、`/*` 块注释、
 * 引号标识符（`"..."`、`[..]`、`` `..` ``）里的词不参与判断；未闭合的字符串/注释、
 * 出现的 `;`（多语句）、首个有效 token 不是 SELECT/WITH、命中禁词，都抛错。
 */
export function assertSelectOnly(sql: string): void {
  let firstWord: string | undefined;
  let i = 0;
  const length = sql.length;

  while (i < length) {
    const ch = sql[i] ?? '';
    const next = sql[i + 1] ?? '';

    if (ch === '-' && next === '-') {
      i += 2;
      while (i < length && sql[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('assertSelectOnly: unterminated block comment');
      i = end + 2;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      // 单引号是字符串（'' 转义）；双引号/反引号/方括号是引号标识符。
      const closer = ch === '[' ? ']' : ch;
      i += 1;
      while (i < length) {
        if (sql[i] === closer) {
          if (ch === "'" && sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      if (i >= length) throw new Error(`assertSelectOnly: unterminated quoted token starting with ${ch}`);
      i += 1;
      continue;
    }

    if (ch === ';') {
      throw new Error('assertSelectOnly: view SQL must be a single statement (found ";")');
    }

    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < length && /[A-Za-z0-9_$]/.test(sql[end] ?? '')) end += 1;
      const word = sql.slice(i, end).toUpperCase();
      firstWord ??= word;
      if (FORBIDDEN_KEYWORDS.has(word)) {
        throw new Error(`assertSelectOnly: view SQL must be read-only, found "${word}"`);
      }
      i = end;
      continue;
    }

    i += 1;
  }

  if (firstWord !== 'SELECT' && firstWord !== 'WITH') {
    throw new Error(`assertSelectOnly: view SQL must start with SELECT or WITH, found "${firstWord ?? '<empty>'}"`);
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`view_catalog.${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseColumns(raw: unknown, viewName: string): ViewColumn[] {
  if (typeof raw !== 'string') {
    throw new Error(`view_catalog[${viewName}].columns must be a JSON string`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`view_catalog[${viewName}].columns is not valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`view_catalog[${viewName}].columns must be a non-empty JSON array`);
  }

  const names = new Set<string>();
  return parsed.map((entry, index) => {
    const record = asRecord(entry, `${viewName}.columns[${index}]`);
    const name = record['name'];
    const label = record['label'];
    const unit = record['unit'];
    const type = record['type'];

    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`view_catalog[${viewName}].columns[${index}].name must be a non-empty string`);
    }
    if (typeof label !== 'string' || label.length === 0) {
      throw new Error(`view_catalog[${viewName}].columns[${index}].label must be a human-readable non-empty string`);
    }
    if (unit !== undefined && typeof unit !== 'string') {
      throw new Error(`view_catalog[${viewName}].columns[${index}].unit must be a string when present`);
    }
    if (typeof type !== 'string' || !COLUMN_TYPES.has(type)) {
      throw new Error(`view_catalog[${viewName}].columns[${index}].type must be one of ${[...COLUMN_TYPES].join('|')}`);
    }
    if (names.has(name)) {
      throw new Error(`view_catalog[${viewName}].columns contains duplicate column "${name}"`);
    }
    names.add(name);

    return { name, label, type: type as ColumnType, ...(unit === undefined ? {} : { unit }) };
  });
}

function parseRight(raw: unknown, viewName: string): Right {
  if (raw === 'reader' || raw === 'reviewer' || raw === 'decider' || raw === 'signer') {
    return raw;
  }
  throw new Error(`view_catalog[${viewName}].min_right must be reader|reviewer|decider|signer`);
}

/** 读整个目录（按 name 排序），并逐行校验形状与 SQL 只读性——fail-closed，坏数据不出库。 */
export function listViewCatalog(db: SdoDatabase): ViewCatalogRow[] {
  const rows = db
    .prepare('SELECT name, sql, columns, doc, min_right, row_budget FROM view_catalog ORDER BY name ASC')
    .all() as Array<Record<string, unknown>>;

  return rows.map((record) => {
    const name = record['name'];
    const sql = record['sql'];
    const doc = record['doc'];
    const rowBudget = record['row_budget'];

    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('view_catalog.name must be a non-empty string');
    }
    if (typeof sql !== 'string' || sql.length === 0) {
      throw new Error(`view_catalog[${name}].sql must be a non-empty string`);
    }
    if (typeof doc !== 'string' || doc.length === 0) {
      throw new Error(`view_catalog[${name}].doc must be a non-empty string`);
    }
    if (typeof rowBudget !== 'number' || !Number.isInteger(rowBudget) || rowBudget < 1) {
      throw new Error(`view_catalog[${name}].row_budget must be a positive integer`);
    }

    assertSelectOnly(sql);

    return {
      name,
      sql,
      columns: parseColumns(record['columns'], name),
      doc,
      min_right: parseRight(record['min_right'], name),
      row_budget: rowBudget,
    };
  });
}

/**
 * 某权限可见的视图集合（`min_right` 层级 ≤ 所给权限），读库计算——新增视图只加 INSERT 即可见。
 *
 * 只做可见性声明（docs/05 §6 的 `min_right`）；列级裁剪与
 * `query_miss(reason='filtered_by_permission')` 属 M0-4 的查询层。
 */
export function viewsForRight(db: SdoDatabase, right: Right): ViewCatalogRow[] {
  const level = RIGHT_LEVELS[right];
  if (typeof level !== 'number') {
    throw new Error(`viewsForRight: unknown right "${String(right)}"`);
  }
  return listViewCatalog(db).filter((view) => RIGHT_LEVELS[view.min_right] <= level);
}
