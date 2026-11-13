/**
 * 写发现：重算事件链 + fold，再与库内投影对账（M0-6，判据 C4）。
 *
 * 只保证“发现”，不承诺归因（docs/09 §16.1）：直改 projection 行、改事件 hash、
 * 断 prev 都应在 `problems` 里出现；谁改的不知道，也不上报人。
 *
 * 分层：core 不 import `src/db/`，只收一个最小 DB 接口（`prepare().all()`），
 * 这样 `verify` 可以跑在驱动之外（M2 接全量 verify_run 也走同一入口）。
 */

import { fold } from './fold/index.js';
import type { TableName } from './fold/types.js';
import { GENESIS_PREV, computeEventHash, readEvents } from './verify-events.js';
import { compareProjections } from './verify-projection.js';
import type { VerifyDatabase, VerifyProblem, VerifyReport } from './verify-types.js';

/**
 * 逐列对账的投影清单。
 *
 * `task`/`spec`/`release` 是 M0-3 视图与 M0-4 查询的主要读数面；`decision` 在 M1-0 起由写网关
 * 物化（只落 signed 行，口径与 `write-materialize.ts` 一致，见 `verify-projection.ts`）。
 * 其余投影表在 M2 接 `verify_run` 时按 `view_catalog` 通用对账补齐。
 */
export const VERIFIED_TABLES: readonly TableName[] = ['task', 'spec', 'release', 'decision'];

export { GENESIS_PREV, computeEventHash };
export type { VerifyDatabase, VerifyProblem, VerifyReport, VerifyStatement } from './verify-types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function verify(db: VerifyDatabase): VerifyReport {
  const problems: VerifyProblem[] = [];

  let events;
  try {
    events = readEvents(db, problems);
  } catch (error) {
    return {
      ok: false,
      eventCount: 0,
      problems: [{ code: 'fold_failed', detail: `cannot read event table: ${errorMessage(error)}` }],
    };
  }

  let state;
  try {
    state = fold(undefined, events);
  } catch (error) {
    problems.push({ code: 'fold_failed', detail: errorMessage(error) });
    return { ok: false, eventCount: events.length, problems };
  }

  try {
    compareProjections(db, state, VERIFIED_TABLES, problems);
  } catch (error) {
    problems.push({ code: 'projection_check_failed', detail: errorMessage(error) });
  }

  return { ok: problems.length === 0, eventCount: events.length, problems };
}
