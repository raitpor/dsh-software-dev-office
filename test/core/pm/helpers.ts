/** M2-5 测试夹具：一切写入都经 append（唯一写入口）；数据库构建复用 M1-2 的事件种子。 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSdoDatabase } from '../../../src/db/open.js';
import type { SdoDatabase } from '../../../src/db/driver.js';
import { runMigrations } from '../../../src/db/migrate.js';
import {
  appendCriterion,
  appendIntent,
  appendRequirement,
  appendSeeds,
  ev,
} from '../../align/helpers.js';

export { appendCriterion, appendIntent, appendRequirement, appendSeeds, ev };

export const PM_PASSPHRASE = 'm2-5-pm-passphrase';

export function eventCount(db: SdoDatabase): number {
  const row = db.prepare('SELECT count(*) AS n FROM event').get() as { n: number };
  return row.n;
}

export function tableCount(db: SdoDatabase, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

export interface TempDb {
  readonly db: SdoDatabase;
  readonly dir: string;
  readonly close: () => void;
}

export function openTempDb(passphrase = PM_PASSPHRASE): TempDb {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m2-5-pm-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), passphrase);
  runMigrations(db);
  return {
    db,
    dir,
    close: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function withPmDb(run: (db: SdoDatabase) => void): void {
  const temp = openTempDb();
  try {
    run(temp.db);
  } finally {
    temp.close();
  }
}

/** 铺最小对齐前置：intent INT-1 → requirement SPEC-1 → criterion CRIT-1（2 正 1 反）。 */
export function seedBase(db: SdoDatabase): void {
  appendIntent(db);
  appendRequirement(db);
  appendCriterion(db, 'CRIT-1', 'SPEC-1');
}
