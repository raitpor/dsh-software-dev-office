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
import { verifyIndependenceChain } from './independence/verify.js';
import { verifyVcsObjects } from './verify-vcs.js';
import { verifyLocks } from './verify-lock.js';
import { verifyPublicFace } from './verify-publicface.js';
import { verifyLeases } from './verify-lease.js';
import { verifyRightProjections } from './verify-rights.js';
import type { VerifyDatabase, VerifyProblem, VerifyReport } from './verify-types.js';

/**
 * 逐列对账的投影清单。
 *
 * `task`/`spec`/`release` 是 M0-3 视图与 M0-4 查询的主要读数面；`decision` 在 M1-0 起由写网关
 * 物化（只落 signed 行，口径与 `write-materialize.ts` 一致，见 `verify-projection.ts`）。
 * 其余投影表在 M2 接 `verify_run` 时按 `view_catalog` 通用对账补齐。
 */
export const VERIFIED_TABLES: readonly TableName[] = [
  'task',
  'spec',
  'release',
  'decision',
  'stage_run',
  'conflict',
  // M3-1 P2-3：绕过网关直写的高风险投影面（对象条件/评审/缺陷/假设区）也要纳入越权行扫描。
  'review',
  'defect',
  'attention',
  'baseline',
];

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

/**
 * M3-1/C5：投影表里的行若在事件日志里没有来源，只可能是绕过写网关直写进去的
 * （扫描面 = VERIFIED_TABLES；未纳入的物化表在卡里明写为“后续扩展”，见 C5 边界）
 * （网关只按 fold 结果物化）。这里单独报 `unauthorized_row`，与 `projection_unexpected`
 * 并存：前者是“越权/绕过”的读数，后者是“投影不对账”的读数。
 *
 * 边界（卡 M3-1 C5）：链自洽的**直接 INSERT event** 无法与网关写入区分（事件信封没有
 * 独立签名，actor 是自称），本卡不承诺检测；M4 的签名信封才是该层的解。
 */
function reportUnauthorizedRows(
  db: VerifyDatabase,
  state: ReturnType<typeof fold>,
  problems: VerifyProblem[],
): void {
  for (const table of VERIFIED_TABLES) {
    const projected = table === 'decision'
      ? Object.fromEntries(Object.entries(state.tables[table]).filter(([, row]) => row['signature'] !== null))
      : state.tables[table];
    const rows = db.prepare(`SELECT id FROM ${table}`).all() as Array<{ id?: unknown }>;
    for (const row of rows) {
      if (typeof row.id !== 'string') continue;
      if (projected[row.id] === undefined) {
        problems.push({
          code: 'unauthorized_row',
          table,
          objectId: row.id,
          detail: `row ${row.id} exists in ${table} but no event produces it (written outside the gateway)`,
        });
      }
    }
  }
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
  // M4-4/C5：right.* 事件流 vs scope 表（四码）；放在 fold 之前：损坏的 right 事件
  // 不能让整份报告只剩一个笼统 fold_failed。
  problems.push(...verifyRightProjections(db, events));

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
    reportUnauthorizedRows(db, state, problems);
  } catch (error) {
    problems.push({ code: 'projection_check_failed', detail: errorMessage(error) });
  }

  // M2-3 C8：假设处置双向核对（签名载荷 ↔ disposed 事件 ↔ 投影行）。
  try {
    problems.push(...verifyAssumptionChain(events, state));
  } catch (error) {
    problems.push({ code: 'projection_check_failed', detail: `assumption chain check failed: ${errorMessage(error)}` });
  }

  // M4-0/C9：内嵌 VCS 共享对象库交叉校验（snapshot.git_oid 必须在库里且内容哈希对得上）。
  try {
    problems.push(...verifyVcsObjects(db));
  } catch (error) {
    problems.push({ code: 'projection_check_failed', detail: `vcs object check failed: ${errorMessage(error)}` });
  }

  // M4-1/C5：锁完整性（busy 卡无活锁 / 无卡关联的过期活锁）。
  try {
    problems.push(...verifyLocks(db));
    try {
      problems.push(...verifyPublicFace(db, state));
    } catch (error) {
      problems.push({ code: 'projection_check_failed', detail: `public face check failed: ${errorMessage(error)}` });
    }
  } catch (error) {
    problems.push({ code: 'projection_check_failed', detail: `lock check failed: ${errorMessage(error)}` });
  }

  // M4-2/C7：租约完整性（busy 卡无活租约 / actor 不匹配 / 同卡多条 / 预占期被他人认领）。
  try {
    problems.push(...verifyLeases(db));
  } catch (error) {
    problems.push({ code: 'projection_check_failed', detail: `lease check failed: ${errorMessage(error)}` });
  }

  // M3-3 C5：独立性复算——同一套 judge 从事件 + baseline 重算，
  // 删一条 decision.signed / 改 signer 都会在这里红（不是 judge 时刻的注入开关）。
  try {
    problems.push(...verifyIndependenceChain({ events, state, db }));
  } catch (error) {
    problems.push({ code: 'projection_check_failed', detail: `independence check failed: ${errorMessage(error)}` });
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
