/**
 * M4-2/C7：租约的 verify 子检查（只读，不修）。用事件日志里最大 `at` 作“现在”。
 *
 * 四码：
 * - `lease_missing`：卡在飞（in_progress）且历史派发过租约，但没有未过期活租约；
 * - `lease_actor_mismatch`：卡在飞，活租约的 actor ≠ 最近一次 `task.claimed` 的 actor；
 * - `lease_multiple_active`：同卡出现多条活租约（DB 部分唯一索引之外的第二道）；
 *
 * 激活边界：库内出现过 lease 事件才检查（M4-2 之前的旧库不追溯）。
 */
import type { VerifyDatabase, VerifyProblem } from './verify-types.js';

interface LeaseRow {
  readonly id: string;
  readonly card_id: string;
  readonly actor: string;
  readonly status: string;
  readonly expires_at: string;
}

interface EventRow {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly kind: string;
  readonly subject: string;
  readonly payload?: unknown;
}

function payloadOf(row: EventRow): Record<string, unknown> {
  const raw = row.payload;
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function maxEventAt(db: VerifyDatabase): string {
  const row = db.prepare('SELECT MAX(at) AS at FROM event').all()[0] as { at?: unknown } | undefined;
  return typeof row?.at === 'string' ? row.at : '';
}

function leaseEvents(db: VerifyDatabase): EventRow[] {
  return db
    .prepare(
      "SELECT id, at, actor, kind, subject, payload FROM event WHERE kind IN ('lease.issued','lease.expired','lease.revoked') ORDER BY rowid",
    )
    .all() as EventRow[];
}

function allEvents(db: VerifyDatabase): EventRow[] {
  return db
    .prepare("SELECT id, at, actor, kind, subject, payload FROM event WHERE kind IN ('task.claimed') ORDER BY rowid")
    .all() as EventRow[];
}

function activeLeases(db: VerifyDatabase): LeaseRow[] {
  return db
    .prepare("SELECT id, card_id, actor, status, expires_at FROM lease WHERE status = 'active'")
    .all() as LeaseRow[];
}

export function verifyLeases(db: VerifyDatabase): VerifyProblem[] {
  const history = leaseEvents(db);
  if (history.length === 0) return [];
  const problems: VerifyProblem[] = [];
  const now = maxEventAt(db);
  const active = activeLeases(db);
  const byCard = new Map<string, LeaseRow[]>();
  for (const row of active) {
    const list = byCard.get(row.card_id) ?? [];
    list.push(row);
    byCard.set(row.card_id, list);
  }
  const dispatched = new Set<string>();
  for (const event of history) {
    if (event.kind !== 'lease.issued') continue;
    const payload = payloadOf(event);
    const card = typeof payload['card'] === 'string' ? payload['card'] : event.subject;
    if (card.length > 0) dispatched.add(card);
  }
  const busy = db.prepare("SELECT id FROM task WHERE status = 'in_progress'").all() as Array<{ id: string }>;
  for (const task of busy) {
    const leases = byCard.get(task.id) ?? [];
    if (leases.length === 0) {
      if (dispatched.has(task.id)) {
        problems.push({ code: 'lease_missing', objectId: task.id, detail: `task ${task.id} is in_progress but has no unexpired active lease` });
      }
      continue;
    }
    if (leases.length > 1) {
      problems.push({ code: 'lease_multiple_active', objectId: task.id, detail: `task ${task.id} has ${leases.length} active leases` });
    }
    const claim = [...allEvents(db)].reverse().find((event) => event.kind === 'task.claimed' && event.subject === task.id);
    if (claim !== undefined) {
      const lease = leases.find((row) => row.actor === claim.actor && Date.parse(row.expires_at) > Date.parse(now));
      if (lease === undefined) {
        problems.push({
          code: 'lease_actor_mismatch',
          objectId: task.id,
          detail: `task ${task.id} was claimed by ${claim.actor} but active lease actors are [${leases.map((row) => row.actor).join(', ')}]`,
        });
      }
    }
  }
  return problems;
}
