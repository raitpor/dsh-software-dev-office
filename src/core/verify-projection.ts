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

export function compareTable(
  db: VerifyDatabase,
  table: TableName,
  state: FoldState,
  problems: VerifyProblem[],
): void {
  const dbRows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Array<Record<string, unknown>>;
  const projected = state.tables[table];
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
