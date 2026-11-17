/** M4-2：lease.issued / lease.expired 真 reducer（docs/07 §13；D-159 起台账）。 */
import type { Event, FoldWorking } from '../fold/types.js';
import { fail, optString, patchRow, payloadOf, reqInteger, reqString } from '../fold/guards.js';

const ACTIVE = 'active';

function activeLeaseForCard(state: FoldWorking, cardId: string, exceptId?: string): string | undefined {
  for (const [id, row] of Object.entries(state.tables.lease)) {
    if (id === exceptId) continue;
    if (row['card_id'] === cardId && row['status'] === ACTIVE) return id;
  }
  return undefined;
}

export function leaseIssued(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const card = reqString(event, payload, 'card');
  const actor = reqString(event, payload, 'actor');
  const scope = reqString(event, payload, 'scope');
  const frontier = reqString(event, payload, 'frontier');
  const ttlS = reqInteger(event, payload, 'ttl_s');
  const expiresAt = reqString(event, payload, 'expires_at');
  if (ttlS <= 0) return fail(event, 'lease.issued payload.ttl_s must be > 0');
  if (Date.parse(expiresAt) <= Date.parse(event.at)) return fail(event, `lease.issued expires_at ${expiresAt} must be after issued_at ${event.at}`);
  if (state.tables.lease[event.id] !== undefined) return fail(event, `lease ${event.id} already exists`);
  const holder = activeLeaseForCard(state, card);
  if (holder !== undefined) return fail(event, `card ${card} already has an active lease (${holder})`);
  state.tables.lease[event.id] = {
    id: event.id,
    card_id: card,
    actor,
    scope,
    frontier,
    ttl_s: ttlS,
    issued_at: event.at,
    expires_at: expiresAt,
    status: ACTIVE,
    revoked_at: null,
    revoked_by: null,
  };
}

export function leaseExpired(state: FoldWorking, event: Event): void {
  const row = state.tables.lease[event.subject];
  if (row === undefined) return fail(event, `lease ${event.subject} does not exist`);
  if (row['status'] !== ACTIVE) return fail(event, `lease ${event.subject} is ${String(row['status'])}; only active can expire`);
  // M4-2/P1：过期写者自证（网关已绑会话；这里防事件流伪造 expired_by）。
  const expiredBy = payloadOf(event)['expired_by'];
  if (expiredBy !== event.actor) return fail(event, `lease.expired payload.expired_by must equal event.actor ${event.actor}`);
  state.tables.lease[event.subject] = { ...row, status: 'expired', expired_at: event.at };
}


/**
 * M4-2/D-150 分区：`lease.revoked` 的租约行守卫归 lease reducer；lock reducer 不再处理该 kind。
 * event.subject 是卡 id；`payload.revoked_by` 必须等于事件 actor，租约行必须 active。
 */
function leaseRevoked(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const revokedBy = optString(event, payload, 'revoked_by');
  if (revokedBy === undefined || revokedBy !== event.actor) {
    return fail(event, `lease.revoked payload.revoked_by must equal event.actor ${event.actor} (D-150)`);
  }
  const cardId = optString(event, payload, 'card_id') ?? event.subject;
  if (cardId.length === 0) return fail(event, 'lease.revoked requires payload.card_id or a non-empty subject');
  const leaseId = optString(event, payload, 'lease_id');
  if (leaseId === undefined) return fail(event, 'lease.revoked requires payload.lease_id');
  const lease = state.tables.lease[leaseId];
  if (lease === undefined) return fail(event, `lease.revoked payload.lease_id ${leaseId} does not exist`);
  if (lease['status'] !== 'active') return fail(event, `lease ${leaseId} is ${String(lease['status'])}; only active can be revoked`);
  // 撤租约的 scope 与租约行同源；payload 若带 scope 必须一致，不允许 payload 覆写权威 scope。
  const rowScope = String(lease['scope'] ?? '');
  if (payload['scope'] !== rowScope) {
    return fail(event, `lease.revoked payload.scope ${String(payload['scope'])} does not match lease ${leaseId} scope ${rowScope}`);
  }
  patchRow(state, 'lease', leaseId, event, { status: 'revoked', revoked_at: event.at, revoked_by: revokedBy });
  for (const [prefix, row] of Object.entries(state.tables.lock)) {
    if (row['card_id'] !== cardId || row['status'] !== 'active') continue;
    patchRow(state, 'lock', prefix, event, { released_by: 'lease_revoked' });
  }
}

export const LEASE_REDUCERS: Readonly<Record<string, (state: FoldWorking, event: Event) => void>> = {
  'lease.issued': leaseIssued,
  'lease.expired': leaseExpired,
  'lease.revoked': leaseRevoked,
};
