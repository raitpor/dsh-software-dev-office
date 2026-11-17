/**
 * M4-4/C5 · `right.*` 事件与 `scope` 表的对账（verify 子检查）。
 *
 * 事件流是真源：`right.granted`/`right.revoked` 投影出的行必须与 `scope` 表逐字段一致。
 * 四个码（卡 C5 / Lead m04509 A3）：
 * - `right_projection_missing`：事件里有、表里没有（投影丢失/被删行）。
 * - `right_projection_extra`：表里多出一行，且该 actor 已有其它 right.* 事件（伪造授予）。
 * - `right_projection_mismatch`：键都在，但 `granted_by/at/revoked_at/revoked_by` 不一致（直改列）。
 * - `right_grant_untracked`：表里有行但该 actor 完全没有 right.* 事件（旧库未背填；诊断码，
 *   `sdo-admin backfill-grants` 之后必须消失）。
 *
 * 这是 verify 的一部分（不是 runtime_inconsistent）：旧库在背填前会红，这是刻意的可发现性。
 */

import type { Event } from './fold/types.js';
import type { RightProjectionRow } from './auth/rights-events.js';
import { projectRightEvents } from './auth/rights-events.js';
import type { VerifyDatabase, VerifyProblem } from './verify-types.js';

interface ScopeTableRow {
  actor: string;
  scope: string;
  right: string;
  granted_by: string;
  at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

function rightKey(actor: string, scope: string, right: string): string {
  return `${actor}|${scope}|${right}`;
}

/** 事件流投影 vs `scope` 表；所有差异都进 problems（不早退，一次报全）。 */
export function verifyRightProjections(db: VerifyDatabase, events: readonly Event[]): VerifyProblem[] {
  const problems: VerifyProblem[] = [];
  const relevant = events.filter((event) => event.kind === 'right.granted' || event.kind === 'right.revoked');
  const projection = projectRightEvents(
    relevant.map((event) => ({ kind: event.kind, at: event.at, payload: event.payload })),
  );
  for (const message of projection.problems) {
    problems.push({
      code: 'right_projection_mismatch',
      objectId: message,
      detail: `事件流里的 right.* 事件无法投影：${message}`,
    });
  }
  const tableRows = db
    .prepare('SELECT actor, scope, right, granted_by, at, revoked_at, revoked_by FROM scope ORDER BY actor, scope, right')
    .all() as unknown as ScopeTableRow[];
  const table = new Map<string, ScopeTableRow>();
  for (const row of tableRows) table.set(rightKey(row.actor, row.scope, row.right), row);
  const actorsWithEvents = new Set(
    relevant
      .map((event) => {
        const payload = typeof event.payload === 'string' ? safeParse(event.payload) : event.payload;
        return typeof (payload as { grantee?: unknown }).grantee === 'string'
          ? String((payload as { grantee: string }).grantee)
          : undefined;
      })
      .filter((value): value is string => value !== undefined),
  );

  // 方向一之前：操作者字段必须等于事件 actor（P1-1 防栽赃）。
  for (const event of relevant) {
    const payload = typeof event.payload === 'string' ? safeParse(event.payload) : event.payload;
    const field = event.kind === 'right.granted'
      ? (payload as { granted_by?: unknown }).granted_by
      : (payload as { revoked_by?: unknown }).revoked_by;
    if (field !== event.actor) {
      problems.push({
        code: 'right_actor_mismatch',
        objectId: event.id,
        detail: `事件 actor=${event.actor} 与载荷里的操作者字段=${String(field)} 不一致`,
      });
    }
  }

  // 方向一：事件 → 表（missing / mismatch）。
  for (const [key, row] of projection.rows) {
    const actual = table.get(key);
    if (actual === undefined) {
      problems.push({
        code: 'right_projection_missing',
          objectId: key,
        detail: `事件流有 ${key} 的授权，但 scope 表没有该行`,
      });
      continue;
    }
    const diffs = compareRow(row, actual);
    if (diffs.length > 0) {
      problems.push({
        code: 'right_projection_mismatch',
          objectId: key,
        detail: `scope 行与事件流投影不一致：${diffs.join('; ')}`,
      });
    }
  }

  // 方向二：表 → 事件（extra / untracked）。
  for (const [key, row] of table) {
    if (projection.rows.has(key)) continue;
    if (!actorsWithEvents.has(row.actor)) {
      problems.push({
        code: 'right_grant_untracked',
          objectId: key,
        detail: `scope 行 ${row.actor} ${row.right}@${row.scope} 没有任何 right.* 事件（旧库未背填；运行 sdo-admin backfill-grants）`,
      });
      continue;
    }
    problems.push({
      code: 'right_projection_extra',
      objectId: key,
      detail: `scope 行 ${row.actor} ${row.right}@${row.scope} 在事件流里没有对应投影（疑似直插）`,
    });
  }

  return problems;
}

function compareRow(expected: RightProjectionRow, actual: ScopeTableRow): string[] {
  const diffs: string[] = [];
  if (expected.granted_by !== actual.granted_by) {
    diffs.push(`granted_by expected=${expected.granted_by} actual=${actual.granted_by}`);
  }
  if (expected.at !== actual.at) diffs.push(`at expected=${expected.at} actual=${actual.at}`);
  if ((expected.revoked_at ?? null) !== (actual.revoked_at ?? null)) {
    diffs.push(`revoked_at expected=${String(expected.revoked_at)} actual=${String(actual.revoked_at)}`);
  }
  if ((expected.revoked_by ?? null) !== (actual.revoked_by ?? null)) {
    diffs.push(`revoked_by expected=${String(expected.revoked_by)} actual=${String(actual.revoked_by)}`);
  }
  return diffs;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
