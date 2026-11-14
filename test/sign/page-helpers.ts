/**
 * M2-6 签字页测试装配：真实 signerd（test/sign/helpers.ts）+ 已迁移库 + claim 行。
 *
 * claim 只能经唯一写入口 `writeClaimRows` 写；本文件把“先 task.created 再 claim 行”
 * 的夹具收在一处，避免每个用例各拼一遍。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openEncryptedDatabase } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';
import { canonicalJson } from '../../src/core/fold/canonical.js';
import type { ClaimRow } from '../../src/claim/types.js';
import { writeClaimRows } from '../../src/claim/gateway.js';
import { append, chainHead } from '../../src/db/write.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { chain, seed } from '../db/append-helpers.js';
import { bootSignerd, type SignerdRig } from './helpers.js';

export const CLAIM_AT = '2026-11-14T10:00:00Z';

export interface ClaimSeedResult {
  readonly eventId: string;
  readonly claimId: string;
}

/** 为一条 task 写一个 claim 行（`renderer:gate-result` 已在注册表里）。 */
export function seedClaim(db: SdoDatabase, taskId = 'TASK-1', claimNo = 'TEST-1'): ClaimSeedResult {
  const [event] = chain([seed(1, 'task.created', taskId, { seq: 1, title: 't', kind: 'implement' })], chainHead(db));
  if (event === undefined) throw new Error('seedClaim: 事件生成失败');
  const appended = append(db, [event]);
  if (!appended.ok) throw new Error(`seedClaim append failed: ${appended.message ?? appended.reason_code}`);
  const claimId = `claim:${claimNo}`;
  const row: ClaimRow = {
    id: claimId,
    subject: taskId,
    predicate: 'done',
    value: canonicalJson({ code: 'done', value: true }),
    as_of_frontier: canonicalJson([event.id]),
    derived_by: 'renderer:gate-result',
    actor: 'alice',
    at: CLAIM_AT,
  };
  const written = writeClaimRows(db, [row]);
  if (!written.ok) throw new Error(`seedClaim claim write failed: ${written.message ?? written.reason_code}`);
  return { eventId: event.id, claimId };
}

/** 追加一条无关事件，用来推 frontier。 */
export function bumpFrontier(db: SdoDatabase, taskId = 'TASK-2'): string {
  const [event] = chain(
    [seed(2, 'task.created', taskId, { seq: 2, title: 't2', kind: 'implement' })],
    chainHead(db),
  );
  if (event === undefined) throw new Error('bumpFrontier: 事件生成失败');
  const appended = append(db, [event]);
  if (!appended.ok) throw new Error(`bumpFrontier append failed: ${appended.message ?? appended.reason_code}`);
  return event.id;
}

/** 异步版 withMigratedDb（签字用例要 await signerd）。 */
export async function withMigratedDbAsync<T>(run: (db: SdoDatabase) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m2-6-'));
  const db = openEncryptedDatabase(join(dir, 'sdo.db'), 'm2-6 sign page passphrase');
  try {
    runMigrations(db);
    return await run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function withSignRig<T>(
  options: Parameters<typeof bootSignerd>[0],
  run: (rig: SignerdRig) => Promise<T>,
): Promise<T> {
  const rig = await bootSignerd(options);
  try {
    return await run(rig);
  } finally {
    await rig.close();
  }
}
