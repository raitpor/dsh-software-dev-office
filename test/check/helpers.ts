import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSdoDatabase } from '../../src/db/open.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';
import { append, chainHead } from '../../src/db/write.js';
import { PASSPHRASE, AT, chain, fourDomainSeeds, seed, type EventSeed } from '../db/append-helpers.js';

export { PASSPHRASE, AT, chain, fourDomainSeeds, seed };
export type { EventSeed };

/** 追加一串种子（自动接到当前链头）；失败直接抛，避免测试静默。 */
export function appendSeeds(db: SdoDatabase, seeds: readonly EventSeed[]): void {
  const result = append(db, chain(seeds, chainHead(db)));
  if (!result.ok) {
    throw new Error(`append failed: ${String(result.reason_code)} ${String(result.message ?? '')}`);
  }
}

function makeDb(): { db: SdoDatabase; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m1-check-'));
  const path = join(dir, 'state', 'sdo.db');
  const db = openSdoDatabase(path, PASSPHRASE);
  runMigrations(db);
  return { db, path, dir };
}

export function withCheckDb(run: (db: SdoDatabase) => void): void {
  const { db, dir } = makeDb();
  try {
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function withCheckDbPath(run: (db: SdoDatabase, path: string) => void): void {
  const { db, path, dir } = makeDb();
  try {
    run(db, path);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function countRows(db: SdoDatabase, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

/** 给六张主表的全部引擎写入方列铺 `field_consumer` 行（dead_field 绿例夹具）。 */
export function seedAllFieldConsumers(db: SdoDatabase): void {
  const tables = ['intent', 'spec', 'scenario', 'criterion', 'evidence', 'claim'];
  const insert = db.prepare(
    "INSERT INTO field_consumer (field, consumer_kind, consumer_id) VALUES (?, 'criterion', 'm1-4-test')",
  );
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    for (const column of columns) insert.run(`${table}.${column.name}`);
  }
}

/** 四表链（M1-0 共享夹具）：intent/spec/criterion/evidence。 */
export function seamSeeds(): EventSeed[] {
  return fourDomainSeeds();
}

/** 有效 decision(kind='spec_set') 覆盖 SPEC-1。 */
export function engineSeedForSpecSet(): EventSeed[] {
  return [
    seed(7, 'decision.valid', 'd-spec-set', {
      decision_kind: 'spec_set',
      payload_hash: 'ph-spec-set',
      frontier: 'f-1',
      payload: { spec_ids: ['SPEC-1'] },
    }),
    seed(8, 'decision.signed', 'd-spec-set', {
      payload_hash: 'ph-spec-set',
      signature: 'sig-spec-set',
      key_id: 'key-1',
      signer: 'alice',
    }),
  ];
}
