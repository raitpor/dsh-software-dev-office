/**
 * 投影对账（M0-6 C4）：fold 重算结果 vs 库内 `task`/`spec`/`release` 行。
 * 只报差异，不修、不归因。
 */

import { canonicalJson } from './fold/canonical.js';
import type { FoldState, TableName } from './fold/types.js';
import type { VerifyDatabase, VerifyProblem } from './verify-types.js';

function normalizeForCompare(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return value;
      }
    }
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return value;
}

export function sameValue(left: unknown, right: unknown): boolean {
  const a = normalizeForCompare(left);
  const b = normalizeForCompare(right);
  if ((typeof a === 'object' && a !== null) || (typeof b === 'object' && b !== null)) {
    return canonicalJson(a) === canonicalJson(b);
  }
  return a === b;
}

/**
 * decision 的物化口径（M1-0）：只有 `signature` 非空的行才落库（valid+signed 之后）。
 * 对账必须用同一口径，否则 `decision.valid` 单批会被误报 projection_missing。
 */
function signedDecisionOnly(state: FoldState): Record<string, Record<string, unknown>> {
  const projected = state.tables['decision'];
  const result: Record<string, Record<string, unknown>> = {};
  for (const [id, row] of Object.entries(projected)) {
    if (row['signature'] !== null) {
      result[id] = row;
    }
  }
  return result;
}

export function compareTable(
  db: VerifyDatabase,
  table: TableName,
  state: FoldState,
  problems: VerifyProblem[],
): void {
  const signedOnly = table === 'decision';
  const sql = signedOnly
    ? 'SELECT * FROM decision WHERE signature IS NOT NULL ORDER BY id'
    : `SELECT * FROM ${table} ORDER BY id`;
  const dbRows = db.prepare(sql).all() as Array<Record<string, unknown>>;
  const projected = signedOnly ? signedDecisionOnly(state) : state.tables[table];
  const seen = new Set<string>();

  for (const dbRow of dbRows) {
    const objectId = typeof dbRow['id'] === 'string' ? dbRow['id'] : undefined;
    if (objectId === undefined) {
      problems.push({ code: 'projection_unexpected', table, detail: 'database row has no string id' });
      continue;
    }
    seen.add(objectId);
    const foldRow = projected[objectId];
    if (foldRow === undefined) {
      problems.push({
        code: 'projection_unexpected',
        table,
        objectId,
        detail: `database has row ${objectId} but the event log does not produce it`,
      });
      continue;
    }
    for (const column of Object.keys(dbRow).sort()) {
      const foldValue = foldRow[column];
      if (foldValue === undefined) {
        continue;
      }
      if (!sameValue(dbRow[column], foldValue)) {
        problems.push({
          code: 'runtime_inconsistent',
          table,
          objectId,
          detail: `column ${column} differs: database=${JSON.stringify(dbRow[column])} fold=${JSON.stringify(foldValue)}`,
        });
        break;
      }
    }
  }

  for (const objectId of Object.keys(projected).sort()) {
    if (!seen.has(objectId)) {
      problems.push({
        code: 'projection_missing',
        table,
        objectId,
        detail: `event log produces ${objectId} but the database has no such row`,
      });
    }
  }
}

export function compareProjections(
  db: VerifyDatabase,
  state: FoldState,
  tables: readonly TableName[],
  problems: VerifyProblem[],
): void {
  for (const table of tables) {
    compareTable(db, table, state, problems);
  }
}
