import { CODE } from '../core/errors/codes.js';
/**
 * M4-3：公共面申请的 API 与单写者能力路径。
 *
 * - `requestPublicFace`：普通写（write@module），只落 `publicface.requested`；
 *   幂等键 (card, intent_hash)，hash 由本模块算，不接受调用方传入。
 * - `bootstrapPublicFaceWriter` / `transferPublicFaceWriter`：`publicface.writer_changed`
 *   （initial from=null）由单写者能力路径产生，投影 public_face_writer（reducer）。
 * - `executePublicFaceChange`：只有当前单写者能执行，落 `publicface.executed`；
 *   他人调用/直 append 由网关拒 `not_public_face_writer`。
 *
 * 时间一律 Date.parse 比较；事件 actor 与会话一致（writer_changed 的 from/to 在 payload）。
 */
import { randomUUID } from 'node:crypto';

import type { SdoDatabase } from './driver.js';
import type { Event } from '../core/fold/types.js';
import { intentHash, type PublicFaceIntent } from '../core/publicface/request.js';
import { buildEvent } from './freeze-store.js';
import { appendAsTool, chainHead } from './write.js';
import {
  createPublicFaceAuthority,
  publicFacePayloadHash,
  PUBLICFACE_TOOL_MARKER,
} from './publicface-capability.js';

const AUTHORITY = createPublicFaceAuthority();

export function consumePublicFaceAuthority(eventId: string, payloadHash: string): boolean {
  return AUTHORITY.consume(eventId, payloadHash);
}

export interface PublicFaceSession {
  readonly actor: string;
  readonly actor_kind: 'human' | 'agent' | 'service';
}

export interface PublicFaceResult {
  readonly ok: boolean;
  readonly reason_code?: string;
  readonly message?: string;
  readonly event_id?: string;
  readonly writer?: string;
  readonly idempotent?: boolean;
  readonly intent_hash?: string;
  readonly scope?: string;
}

interface TaskScopeRow {
  readonly scope_paths: string;
}

function currentWriter(db: SdoDatabase): string | undefined {
  const row = db.prepare('SELECT actor FROM public_face_writer LIMIT 1').get() as { actor?: string } | undefined;
  return typeof row?.actor === 'string' ? row.actor : undefined;
}

function moduleScopeOf(task: TaskScopeRow): string {
  let paths: unknown = [];
  try {
    paths = JSON.parse(task.scope_paths);
  } catch {
    paths = [];
  }
  const first = Array.isArray(paths) ? paths.find((p) => typeof p === 'string' && p.length > 0) : undefined;
  if (typeof first !== 'string') return 'module:core';
  if (first.startsWith('module:')) return first;
  const segment = first.replace(/\\/g, '/').split('/')[0] ?? '';
  return /^[a-z0-9][a-z0-9._-]*$/.test(segment) ? `module:${segment}` : 'module:core';
}

function appendToolEvent(db: SdoDatabase, session: PublicFaceSession, event: Event): PublicFaceResult {
  AUTHORITY.mint(event.id, publicFacePayloadHash(event.payload));
  const appended = appendAsTool(db, [event], session.actor, session.actor_kind);
  if (!appended.ok) {
    return { ok: false, reason_code: appended.reason_code ?? 'append_failed', message: appended.message };
  }
  return { ok: true, event_id: event.id };
}

function writerEvent(
  db: SdoDatabase,
  session: PublicFaceSession,
  input: { readonly from: string | null; readonly to: string; readonly at: string; readonly note?: string },
): Event {
  return buildEvent(
    {
      id: `pfw-${randomUUID()}`,
      at: input.at,
      actor: session.actor,
      kind: 'publicface.writer_changed',
      subject: input.to,
      payload: {
        from: input.from,
        to: input.to,
        at: input.at,
        note: input.note ?? null,
        initiator: PUBLICFACE_TOOL_MARKER,
      },
      caused_by: [],
      request_id: `req-pfw-${input.to}`,
    },
    chainHead(db),
  );
}

/** 初始单写者：只允许在没有任何 writer 时建立（from=null）。 */
export function bootstrapPublicFaceWriter(
  db: SdoDatabase,
  session: PublicFaceSession,
  input: { readonly to: string; readonly at: string; readonly note?: string },
): PublicFaceResult {
  if (currentWriter(db) !== undefined) {
    return { ok: false, reason_code: CODE.writer_exists, message: 'public face writer is already assigned' };
  }
  if (input.to === session.actor) {
    return { ok: false, reason_code: CODE.invalid_field, message: 'bootstrap must hand the writer role to a different actor' };
  }
  const result = appendToolEvent(db, session, writerEvent(db, session, { from: null, to: input.to, at: input.at, note: input.note }));
  return result.ok ? { ...result, writer: input.to } : result;
}

/** 切换单写者：只有当前持有者能交棒。 */
export function transferPublicFaceWriter(
  db: SdoDatabase,
  session: PublicFaceSession,
  input: { readonly to: string; readonly at: string; readonly note?: string },
): PublicFaceResult {
  const writer = currentWriter(db);
  if (writer === undefined) {
    return { ok: false, reason_code: CODE.not_public_face_writer, message: 'no public face writer has been assigned' };
  }
  if (writer !== session.actor) {
    return { ok: false, reason_code: CODE.not_public_face_writer, message: `session ${session.actor} is not the public face writer (${writer})` };
  }
  if (input.to === writer) {
    return { ok: false, reason_code: CODE.invalid_field, message: 'to must differ from the current writer' };
  }
  const result = appendToolEvent(db, session, writerEvent(db, session, { from: writer, to: input.to, at: input.at, note: input.note }));
  return result.ok ? { ...result, writer: input.to } : result;
}

/** C3：申请（普通写，权限由网关按 kind 映射 write@module 判）。 */
export function requestPublicFace(
  db: SdoDatabase,
  session: PublicFaceSession,
  input: { readonly card: string; readonly intent: PublicFaceIntent; readonly diff: string; readonly at: string },
): PublicFaceResult {
  const row = db.prepare('SELECT scope_paths FROM task WHERE id = ?').get(input.card) as TaskScopeRow | undefined;
  if (row === undefined) {
    return { ok: false, reason_code: CODE.invalid_field, message: `task ${input.card} does not exist` };
  }
  const scope = moduleScopeOf(row);
  const hash = intentHash(input.intent);
  const existing = db
    .prepare("SELECT id, payload FROM event WHERE kind = 'publicface.requested'")
    .all() as { id: string; payload: string }[];
  for (const event of existing) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (payload['card'] === input.card && payload['intent_hash'] === hash) {
      return { ok: true, idempotent: true, event_id: event.id, intent_hash: hash, scope };
    }
  }
  const event = buildEvent(
    {
      id: `pfr-${randomUUID()}`,
      at: input.at,
      actor: session.actor,
      kind: 'publicface.requested',
      subject: input.card,
      payload: {
        card: input.card,
        intent: input.intent,
        intent_hash: hash,
        diff: input.diff,
        scope,
        requested_at: input.at,
      },
      caused_by: [],
      request_id: `req-pfr-${input.card}`,
    },
    chainHead(db),
  );
  const appended = appendAsTool(db, [event], session.actor, session.actor_kind);
  if (!appended.ok) {
    return { ok: false, reason_code: appended.reason_code ?? 'append_failed', message: appended.message };
  }
  return { ok: true, event_id: event.id, intent_hash: hash, scope };
}

/** C4：执行公共面改动；唯一入口是当前单写者（能力一次性、绑 payload_hash）。 */
export function executePublicFaceChange(
  db: SdoDatabase,
  session: PublicFaceSession,
  input: { readonly request_id: string; readonly at: string },
): PublicFaceResult {
  const writer = currentWriter(db);
  if (writer === undefined || writer !== session.actor) {
    return { ok: false, reason_code: CODE.not_public_face_writer, message: `session ${session.actor} is not the public face writer` };
  }
  const request = db
    .prepare("SELECT id, payload FROM event WHERE id = ? AND kind = 'publicface.requested'")
    .get(input.request_id) as { id: string; payload: string } | undefined;
  if (request === undefined) {
    return { ok: false, reason_code: CODE.invalid_field, message: `public face request ${input.request_id} does not exist` };
  }
  // P2-2：同一 request 只执行一次；重复执行幂等返回原事件（不再落第二条）。
  const already = db
    .prepare("SELECT id FROM event WHERE kind = 'publicface.executed' AND subject = ?")
    .all(input.request_id) as { id: string }[];
  if (already.length > 0) {
    return { ok: true, idempotent: true, event_id: already[0]!.id, writer };
  }
  let card = '';
  try {
    const payload = JSON.parse(request.payload) as Record<string, unknown>;
    card = typeof payload['card'] === 'string' ? payload['card'] : '';
  } catch {
    return { ok: false, reason_code: CODE.invalid_field, message: 'request payload is not JSON' };
  }
  const event = buildEvent(
    {
      id: `pfe-${input.request_id}`,
      at: input.at,
      actor: session.actor,
      kind: 'publicface.executed',
      subject: input.request_id,
      payload: { card, request_id: input.request_id, executed_at: input.at, initiator: PUBLICFACE_TOOL_MARKER },
      caused_by: [input.request_id],
      request_id: `req-pfe-${input.request_id}`,
    },
    chainHead(db),
  );
  return appendToolEvent(db, session, event);
}
