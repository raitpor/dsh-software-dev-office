import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openEncryptedDatabase, type SdoDatabase } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedViewerGrants } from './append-auth.js';

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

/** A2：query/ui 只读夹具专用——建库时先按事件预置视图 actor 的授权，
 * 之后测试体直插数据（否则测试体内的 append 会 materialize 清掉直插行）。 */
export function withViewerDb(run: (db: SdoDatabase) => void): void {
  withMigratedDb((db) => {
    seedViewerGrants(db);
    // P2-5：viewer 库是只读夹具库——`append()` 一进来就 `BEGIN IMMEDIATE`，直接在这里拦掉；
    // 直插夹具数据走 `prepare/run`，不受影响。
    const originalExec = db.exec.bind(db);
    db.exec = ((sql: string) => {
      if (/^\s*BEGIN\s+IMMEDIATE/i.test(sql)) {
        throw new Error('viewer 夹具库不允许写事件（append 被拒）；需要写请用 withWriteDb');
      }
      return originalExec(sql);
    }) as typeof db.exec;
    run(db);
    // 读路径夹具库的其余直插（`event` 行）仍允许；这里只盯“经写网关”的补充证据：
    // 任何 append 已在 `BEGIN IMMEDIATE` 处被拦；`right.*` 又必须为 0（否则事件链与投影混）。
    const granted = db.prepare("SELECT count(*) AS n FROM event WHERE kind IN ('right.granted','right.revoked')").get() as { n: number };
    if (granted.n !== 0) throw new Error('viewer 夹具库不允许写 right.* 事件；需要写请用 withWriteDb');
  });
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
