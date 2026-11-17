/**
 * M4-3 第 1 轮 P1-2 的测试垫片：产品 API 已删掉 `scope_paths` 参数，写域只认 task 行。
 * 旧用例仍以 `scope_paths` 声明“这张卡该有的写域”——垫片把它如实写进 task 行（仅当行不存在），
 * 再调原 API；不改变任何断言。缺 task/空写域的路径由 publicface.test.ts 直接调原 API 覆盖。
 */
import type { SdoDatabase } from '../../src/db/driver.js';
import {
  admitWorkcopy as rawAdmit,
  commitWorkcopy as rawCommit,
  createWorkcopy as rawCreate,
} from '../../src/db/workcopy.js';
import type {
  AdmitRequest,
  AdmitResult,
  CommitRequest,
  CommitResult,
  CreateRequest,
  CreateResult,
  FailureResult,
} from '../../src/core/workcopy/types.js';
import { chain, seed } from './append-helpers.js';
import { appendAs } from './append-auth.js';
import { chainHead } from '../../src/db/write.js';

export { bootstrapBaseline, removeWorkcopy } from '../../src/db/workcopy.js';
export type { WorkcopySession } from '../../src/core/workcopy/types.js';

let seq = 700;

/** @internal test-only：把用例声明的写域落成 task.created（权威来源）。 */
export function seedTaskRow(db: SdoDatabase, card: string, scopePaths: readonly string[]): void {
  const existing = db.prepare('SELECT 1 AS x FROM task WHERE id = ?').get(card);
  if (existing !== undefined) return;
  const n = seq++;
  const result = appendAs(db, chain([seed(n, 'task.created', card, {
    seq: n, title: card, kind: 'implement', scope_paths: [...scopePaths],
  })], chainHead(db)));
  if (!result.ok) throw new Error(`seedTaskRow ${card}: ${result.reason_code ?? 'append_failed'} ${result.message ?? ''}`);
}

type Legacy<T> = Omit<T, 'scope_paths'> & { readonly scope_paths?: readonly string[] };

function withoutScope<T extends { scope_paths?: readonly string[] }>(req: T): Omit<T, 'scope_paths'> {
  const { scope_paths: _ignored, ...rest } = req;
  return rest;
}

export async function createWorkcopy(db: SdoDatabase, req: Legacy<CreateRequest>): Promise<CreateResult | FailureResult> {
  seedTaskRow(db, req.card, req.scope_paths ?? ['a.txt']);
  return rawCreate(db, withoutScope(req));
}

export async function commitWorkcopy(db: SdoDatabase, req: Legacy<CommitRequest>): Promise<CommitResult | FailureResult> {
  seedTaskRow(db, req.card, req.scope_paths ?? ['a.txt']);
  return rawCommit(db, withoutScope(req));
}

export async function admitWorkcopy(db: SdoDatabase, req: Legacy<AdmitRequest>): Promise<AdmitResult | FailureResult> {
  seedTaskRow(db, req.card, req.scope_paths ?? ['a.txt']);
  return rawAdmit(db, withoutScope(req));
}
