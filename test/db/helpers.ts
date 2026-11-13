import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openEncryptedDatabase, type SdoDatabase } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';

export const PASSPHRASE = 'correct horse battery staple';

/** 新建加密库、跑完迁移、执行断言，最后关库并删临时目录。 */
export function withMigratedDb(run: (db: SdoDatabase) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m0-1-'));
  const db = openEncryptedDatabase(join(dir, 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function pragmaRows(db: SdoDatabase, pragma: string): Array<Record<string, unknown>> {
  const rows = db.pragma(pragma);
  if (!Array.isArray(rows)) {
    throw new Error(`PRAGMA ${pragma} did not return rows`);
  }
  return rows.map((row) => {
    if (typeof row !== 'object' || row === null) {
      throw new Error(`PRAGMA ${pragma} returned a non-object row`);
    }
    return row as Record<string, unknown>;
  });
}

export function tableNames(db: SdoDatabase): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return rows.map((row) => String((row as Record<string, unknown>)['name']));
}

export function columnNames(db: SdoDatabase, table: string): string[] {
  return pragmaRows(db, `table_info(${table})`).map((row) => String(row['name']));
}
