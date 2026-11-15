/** M2-1 测试装配：真 signerd + 加密库 + 已解锁钥匙（复用 M2-0 的 helpers）。 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chainHead } from '../../src/db/write.js';
import { grantFixtureRoster } from './append-auth.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { unlockSigner } from '../../src/sign/decision.js';
import type { SignerdClient } from '../../src/sign/client.js';
import type { FreezeSession } from '../../src/db/freeze.js';
import { bootSignerd, TEST_ACTOR, TEST_PASSPHRASE, TEST_PRODUCER, type SignerdRig } from '../sign/helpers.js';

export const AT = new Date('2026-11-14T00:00:00.000Z');
export const SESSION: FreezeSession = { actor: TEST_ACTOR, actor_kind: 'human', producer: TEST_PRODUCER, channel: 'ui' };

export interface FreezeRig {
  readonly db: SdoDatabase;
  readonly rig: SignerdRig;
  readonly client: SignerdClient;
}

export function readBaselineFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/baseline', name), 'utf8')) as Record<string, unknown>;
}

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function rowCount(db: SdoDatabase, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

export function rows(db: SdoDatabase, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return (db.prepare(sql).all(...params) as unknown) as Array<Record<string, unknown>>;
}

export async function unlock(rig: FreezeRig): Promise<void> {
  const outcome = await unlockSigner(rig.db, rig.client, {
    actor: TEST_ACTOR,
    actor_kind: 'human',
    passphrase: TEST_PASSPHRASE,
    frontier: chainHead(rig.db),
    now: AT,
  });
  if (!outcome.ok) throw new Error(`unlock failed: ${outcome.reason_code ?? 'unknown'}`);
}

export async function withFreezeRig(run: (rig: FreezeRig) => Promise<void>): Promise<void> {
  const rig = await bootSignerd();
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m2-1-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), TEST_PASSPHRASE);
  try {
    runMigrations(db);
    grantFixtureRoster(db);
    const unlocked = await unlockSigner(db, rig.client, {
      actor: TEST_ACTOR,
      actor_kind: 'human',
      passphrase: TEST_PASSPHRASE,
      frontier: chainHead(db),
      now: AT,
    });
    if (!unlocked.ok) throw new Error(`unlock failed: ${unlocked.reason_code ?? 'unknown'} ${unlocked.message ?? ''}`);
    await run({ db, rig, client: rig.client });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    await rig.close();
  }
}
