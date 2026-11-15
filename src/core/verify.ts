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
import { verifyBaselineReferences } from './baseline/verify-references.js';
import { verifyAssumptionChain } from './assumption/verify.js';
import type { VerifyDatabase, VerifyProblem, VerifyReport } from './verify-types.js';

/**
 * 逐列对账的投影清单。
 *
 * `task`/`spec`/`release` 是 M0-3 视图与 M0-4 查询的主要读数面；`decision` 在 M1-0 起由写网关
 * 物化（只落 signed 行，口径与 `write-materialize.ts` 一致，见 `verify-projection.ts`）。
 * 其余投影表在 M2 接 `verify_run` 时按 `view_catalog` 通用对账补齐。
 */
export const VERIFIED_TABLES: readonly TableName[] = ['task', 'spec', 'release', 'decision', 'stage_run'];

export { GENESIS_PREV, computeEventHash };
export type { VerifyDatabase, VerifyProblem, VerifyReport, VerifyStatement } from './verify-types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** P1-3：迁移例外计数，只认 new `criterion.registered` 的 payload.legacy=true。 */
function countLegacyRegistrations(events: readonly { kind: string; payload: unknown }[]): number {
  return events.filter((event) => {
    if (event.kind !== 'criterion.registered') return false;
    const payload = event.payload;
    return typeof payload === 'object' && payload !== null && (payload as Record<string, unknown>)['legacy'] === true;
  }).length;
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
      legacy_criterion_registrations: 0,
    };
  }

  // M2-3/D-081：`assumption.invalidated` 在 M2 起降为派生读数（写入被拒、fold 显式拒）。
  // 旧库若在升级前写过该 kind，这里先给**可读可行动**的专门 problem，而不是让 fold 笼统崩掉。
  const legacyInvalidated = events.filter((event) => event.kind === 'assumption.invalidated');
  if (legacyInvalidated.length > 0) {
    for (const event of legacyInvalidated) {
      problems.push({
        code: 'legacy_assumption_invalidated',
        objectId: event.id,
        detail:
          `event ${event.id} uses assumption.invalidated, which is now a derived reading (D-081); ` +
          'this database predates M2 — rebuild it, or wait for the v2.1 cleanup migration',
      });
    }
    return {
      ok: false,
      eventCount: events.length,
      problems,
      legacy_criterion_registrations: countLegacyRegistrations(events),
    };
  }

  let state;
  try {
    state = fold(undefined, events);
  } catch (error) {
    problems.push({ code: 'fold_failed', detail: errorMessage(error) });
    return { ok: false, eventCount: events.length, problems, legacy_criterion_registrations: 0 };
  }

  try {
    compareProjections(db, state, VERIFIED_TABLES, problems);
  } catch (error) {
    problems.push({ code: 'projection_check_failed', detail: errorMessage(error) });
  }

  // M2-3 C8：假设处置双向核对（签名载荷 ↔ disposed 事件 ↔ 投影行）。
  try {
    problems.push(...verifyAssumptionChain(events, state));
  } catch (error) {
    problems.push({ code: 'projection_check_failed', detail: `assumption chain check failed: ${errorMessage(error)}` });
  }

  // M2-1 C8：baseline 按“被引用的那一版”复算 hash，并核对冻结事件/引用存在性。
  try {
    problems.push(...verifyBaselineReferences(db).problems);
  } catch (error) {
    problems.push({ code: 'projection_check_failed', detail: `baseline reference check failed: ${errorMessage(error)}` });
  }

  return {
    ok: problems.length === 0,
    eventCount: events.length,
    problems,
    legacy_criterion_registrations: countLegacyRegistrations(events),
  };
}
