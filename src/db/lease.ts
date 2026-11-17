/**
 * M4-2：派发租约。`lease.issued` 是唯一入口（C1）；claim 前置在网关（C2/C3/C6）。
 * 收回/过期会带同批 `task.blocked(lease_*)` + `task.unblocked`，工作副本不动（C4/C5）。
 */
import type { SdoDatabase } from './driver.js';
import type { Event } from '../core/fold/types.js';
import { DEFAULT_LEASE_TTL_S } from '../core/lease/types.js';
import { chainHead, appendAsTool } from './write.js';
import { buildEvent } from './freeze-store.js';
import { hasRight } from './auth.js';
import type { AppendResult } from './write-types.js';
import {
  LEASE_TOOL_MARKER,
  createLeaseToolAuthority,
  leasePayloadHash,
} from './lease-capability.js';

export type LeaseSession = { readonly actor: string; readonly actor_kind: 'human' | 'agent' | 'service' };

interface LeaseDbRow {
  readonly id: string;
  readonly card_id: string;
  readonly actor: string;
  readonly scope: string;
  readonly status: string;
  readonly expires_at: string;
}

const AUTHORITY = createLeaseToolAuthority();

export function consumeLeaseAuthority(eventId: string, payloadHash: string): boolean {
  return AUTHORITY.consume(eventId, payloadHash);
}

export type LeaseResult =
  | { readonly ok: true; readonly lease_id: string; readonly expires_at: string }
  | { readonly ok: false; readonly reason_code: string; readonly message: string };

export interface DispatchInput {
  readonly card: string;
  readonly actor: string;
  readonly scope: string;
  readonly ttl_s?: number;
  readonly at: string;
}

function appendAll(db: SdoDatabase, session: LeaseSession, events: readonly Event[]): AppendResult | undefined {
  const result = appendAsTool(db, events, session.actor, session.actor_kind);
  return result.ok ? undefined : result;
}

function readLease(db: SdoDatabase, leaseId: string): LeaseDbRow | undefined {
  return db
    .prepare('SELECT id, card_id, actor, scope, status, expires_at FROM lease WHERE id = ?')
    .get(leaseId) as LeaseDbRow | undefined;
}

function buildCompanions(
  db: SdoDatabase,
  session: LeaseSession,
  lease: LeaseDbRow,
  at: string,
  blockCode: 'lease_expired' | 'lease_revoked',
  prevStart: string,
): Event[] {
  const task = db.prepare('SELECT status FROM task WHERE id = ?').get(lease.card_id) as
    | { status?: string }
    | undefined;
  if (task?.status !== 'in_progress') return [];
  const events: Event[] = [];
  let prev = prevStart;
  const blockedInitiated = {
    id: `lease-block-${lease.id}`,
    at,
    actor: session.actor,
    kind: 'task.blocked',
    subject: lease.card_id,
    payload: { block_code: blockCode, reason: `${blockCode} (lease ${lease.id})`, lease_id: lease.id, lease_tool: LEASE_TOOL_MARKER },
    caused_by: [lease.id],
    request_id: `lease-block:${lease.id}`,
  } as const;
  const blocked = buildEvent(blockedInitiated, prev);
  AUTHORITY.mint(blocked.id, leasePayloadHash(blockedInitiated.payload));
  events.push(blocked);
  prev = blocked.hash;
  const unblockedInitiated = {
    id: `lease-unblock-${lease.id}`,
    at,
    actor: session.actor,
    kind: 'task.unblocked',
    subject: lease.card_id,
    payload: { lease_id: lease.id, lease_tool: LEASE_TOOL_MARKER },
    caused_by: [blocked.id],
    request_id: `lease-unblock:${lease.id}`,
  } as const;
  const unblocked = buildEvent(unblockedInitiated, prev);
  AUTHORITY.mint(unblocked.id, leasePayloadHash(unblockedInitiated.payload));
  events.push(unblocked);
  return events;
}

export function dispatchLease(
  db: SdoDatabase,
  session: LeaseSession,
  input: DispatchInput,
): LeaseResult {
  const grant = hasRight(db, { id: session.actor, kind: session.actor_kind }, 'assign', input.scope);
  if (!grant.ok) {
    return { ok: false, reason_code: 'no_permission', message: `dispatch denied: action=assign scope=${input.scope} (${grant.message})` };
  }
  const ttlS = input.ttl_s ?? DEFAULT_LEASE_TTL_S;
  const expiresAt = new Date(Date.parse(input.at) + ttlS * 1000).toISOString();
  const payload = {
    card: input.card,
    actor: input.actor,
    scope: input.scope,
    frontier: chainHead(db),
    ttl_s: ttlS,
    expires_at: expiresAt,
    initiator: LEASE_TOOL_MARKER,
  };
  const initiated = {
    id: `lease-${input.card}-${input.at}-${input.actor}`,
    at: input.at,
    actor: session.actor,
    kind: 'lease.issued',
    subject: input.card,
    payload,
    caused_by: [] as string[],
    request_id: `dispatch:${input.card}:${input.at}`,
  };
  const event = buildEvent(initiated, chainHead(db));
  AUTHORITY.mint(event.id, leasePayloadHash(payload));
  const failed = appendAll(db, session, [event]);
  if (failed !== undefined) return { ok: false, reason_code: failed.reason_code ?? 'append_failed', message: failed.message ?? 'append failed' };
  return { ok: true, lease_id: event.id, expires_at: expiresAt };
}

function terminalLease(
  db: SdoDatabase,
  session: LeaseSession,
  leaseId: string,
  at: string,
  kind: 'lease.expired' | 'lease.revoked',
): LeaseResult {
  const lease = readLease(db, leaseId);
  if (lease === undefined) return { ok: false, reason_code: 'lease_missing', message: `lease ${leaseId} does not exist` };
  if (lease.status !== 'active') return { ok: false, reason_code: 'lease_not_active', message: `lease ${leaseId} is ${lease.status}` };
  if (kind === 'lease.revoked') {
    const grant = hasRight(db, { id: session.actor, kind: session.actor_kind }, 'assign', lease.scope);
    if (!grant.ok) return { ok: false, reason_code: 'no_permission', message: `revoke denied: action=assign scope=${lease.scope} (${grant.message})` };
  }
  if (kind === 'lease.expired') {
    // M4-2/P1：过期只能由“已到期”触发，且写者必须有该 scope 的 assign 权（与 revoke 同口径）。
    if (Date.parse(at) < Date.parse(lease.expires_at)) {
      return { ok: false, reason_code: 'lease_not_expired', message: `lease ${leaseId} expires_at ${lease.expires_at}; at ${at} is too early` };
    }
    const grant = hasRight(db, { id: session.actor, kind: session.actor_kind }, 'assign', lease.scope);
    if (!grant.ok) return { ok: false, reason_code: 'no_permission', message: `expire denied: action=assign scope=${lease.scope} (${grant.message})` };
  }
  const payload =
    kind === 'lease.expired'
      ? { lease_id: leaseId, initiator: LEASE_TOOL_MARKER, expired_by: session.actor }
      : { lease_id: leaseId, card_id: lease.card_id, scope: lease.scope, revoked_by: session.actor };
  const initiated = {
    id: `lease-${kind === 'lease.expired' ? 'expired' : 'revoked'}-${leaseId}`,
    at,
    actor: session.actor,
    kind,
    subject: kind === 'lease.expired' ? leaseId : lease.card_id,
    payload,
    caused_by: [] as string[],
    request_id: `${kind}:${leaseId}`,
  };
  const event = buildEvent(initiated, chainHead(db));
  if (kind === 'lease.expired') AUTHORITY.mint(event.id, leasePayloadHash(payload));
  const companions = buildCompanions(
    db,
    session,
    lease,
    at,
    kind === 'lease.expired' ? 'lease_expired' : 'lease_revoked',
    event.hash,
  );
  const failed = appendAll(db, session, [event, ...companions]);
  if (failed !== undefined) return { ok: false, reason_code: failed.reason_code ?? 'append_failed', message: failed.message ?? 'append failed' };
  return { ok: true, lease_id: leaseId, expires_at: lease.expires_at };
}

export function expireLease(db: SdoDatabase, session: LeaseSession, leaseId: string, at: string): LeaseResult {
  return terminalLease(db, session, leaseId, at, 'lease.expired');
}

export function revokeLease(db: SdoDatabase, session: LeaseSession, leaseId: string, at: string): LeaseResult {
  return terminalLease(db, session, leaseId, at, 'lease.revoked');
}
