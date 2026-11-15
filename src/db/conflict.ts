/**
 * M3-2 · 冲突的库层装配：读冲突行、生成 detected 事件、人签裁决。
 *
 * 唯一写入口仍是 `append()`；本文件不直接写 `conflict` 表——冲突行由 fold
 * 从 `conflict.detected` / `conflict.resolved` 事件投影（docs/02 §3）。
 * 分层：db → core；不 import `src/sign/`（裁决经 signDecision 由上层注入）。
 */

import { randomUUID } from 'node:crypto';

import type { SdoDatabase } from './driver.js';
import { appendAsTool, chainHead } from './write.js';
import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';
import type { Event } from '../core/fold/types.js';
import { computeEventHash } from '../core/verify-events.js';
import type {
  ConflictFailure,
  ConflictResolution,
  ConflictRow,
  ConflictSide,
} from '../core/conflict/types.js';
import type { Session } from '../core/auth/session.js';
import type { SignerdClient } from '../sign/client.js';
import { signDecision, type DecisionRequest } from '../sign/decision.js';
import { conflictDetectedPayloadHash, createConflictAuthority } from './conflict-authority.js';

/** 本模块私有：mint 只在此持有；对外只暴露 consume（写网关用）。 */
const CONFLICT_AUTHORITY = createConflictAuthority();

export function consumeConflictDetectedAuthority(eventId: string, payloadHash: string): boolean {
  return CONFLICT_AUTHORITY.consume(eventId, payloadHash);
}

export interface ConflictResolveRequest {
  readonly conflict_id: string;
  /** 人确认的裁决差异 hash（防 UI 侧被换内容）。 */
  readonly payload_hash: string;
  readonly side: ConflictSide;
  /** 人写的裁决备注（可空；进签名载荷 `conflict_resolution.note`）。 */
  readonly note?: string;
}

export function conflictResolutionPayloadHash(conflictId: string, side: ConflictSide): string {
  return `sha256:${sha256Hex(canonicalJson({ conflict_id: conflictId, side }))}`;
}

export function readConflict(db: SdoDatabase, conflictId: string): ConflictRow | null {
  const row = db.prepare('SELECT * FROM conflict WHERE id = ?').get(conflictId) as
    | Record<string, unknown>
    | undefined;
  return row === undefined ? null : (row as unknown as ConflictRow);
}

export function readConflicts(db: SdoDatabase): ConflictRow[] {
  return db.prepare('SELECT * FROM conflict ORDER BY rowid').all() as unknown as ConflictRow[];
}

export function conflictsForView(db: SdoDatabase): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM conflicts ORDER BY at, id').all() as Array<Record<string, unknown>>;
}

function fail(reason_code: ConflictFailure['reason_code'], message: string): ConflictFailure {
  return { ok: false, reason_code, message };
}

function resolutionEventId(): string {
  return `cfr-${randomUUID()}`;
}

/** 事件 actor = 失败写入方（lead 裁定：便于追责，检测器不额外要权）。 */
export function buildConflictResolvedEvent(input: {
  readonly conflictId: string;
  readonly decisionId: string;
  readonly side: ConflictSide;
  readonly actor: string;
  readonly at: string;
  readonly prev: string;
}): Event {
  const base = {
    id: resolutionEventId(),
    at: input.at,
    actor: input.actor,
    kind: 'conflict.resolved',
    subject: `conflict:${input.conflictId}`,
    payload: {
      conflict_id: input.conflictId,
      decision_id: input.decisionId,
      side: input.side,
    },
    caused_by: [] as readonly string[],
    request_id: `req-conflict-resolve-${input.conflictId}`,
    prev: input.prev,
  };
  return { ...base, hash: computeEventHash({ ...base, hash: '' } as Event) };
}

/**
 * 人签裁决：无有效签名 ⇒ 冲突保持 open、0 行变化。
 * D-089：decision_kind='sign'，签名载荷顶层带 `conflict_resolution`。
 */
export async function resolveConflict(
  db: SdoDatabase,
  client: SignerdClient,
  request: ConflictResolveRequest,
  session: Session,
  options: { readonly now?: Date } = {},
): Promise<ConflictResolution | ConflictFailure> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const conflict = readConflict(db, request.conflict_id);
  if (conflict === null) return fail('conflict_not_found', `conflict ${request.conflict_id} does not exist`);
  if (conflict.status !== 'open') {
    return fail('conflict_already_resolved', `conflict ${request.conflict_id} is ${conflict.status}`);
  }
  const expected = conflictResolutionPayloadHash(request.conflict_id, request.side);
  if (session.actor_kind !== 'human') {
    return fail('resolution_not_signed', 'conflict resolution requires a human session; agents cannot select a side');
  }
  if (request.payload_hash !== expected) {
    return fail('conflict_invalid', `payload_hash does not match conflict ${request.conflict_id} / side ${request.side}`);
  }

  const signed = await signDecision(db, client, {
    decision_kind: 'sign',
    subject: `conflict:${request.conflict_id}`,
    value: request.side,
    evidence: [`base_hash:${conflict.base_hash}`, `current_hash:${conflict.current_hash}`],
    difference: `conflict ${conflict.id}: ${conflict.winner_actor} wrote ${conflict.field} first; ${conflict.loser_actor} attempted a stale write`,
    consequence: `conflict ${conflict.id} stays open (blocked write) unless a human signs this resolution`,
    extra: {
      conflict_resolution: {
        conflict_id: request.conflict_id,
        adopted_actor: request.side === 'winner' ? conflict.winner_actor : conflict.loser_actor,
        note: request.note ?? '',
      },
    },
    actor: session.actor,
    actor_kind: session.actor_kind as 'human',
    producer: session.actor_kind === 'human' ? 'ui' : 'model-1',
    channel: 'ui',
    frontier: chainHead(db),
    now,
  });
  if (!signed.ok) {
    return fail('resolution_not_signed', `signing failed: ${signed.reason_code}: ${signed.message}`);
  }

  const event = buildConflictResolvedEvent({
    conflictId: request.conflict_id,
    decisionId: signed.decision_id,
    side: request.side,
    actor: session.actor,
    at,
    prev: chainHead(db),
  });
  const result = appendAsTool(db, [event], session.actor, session.actor_kind);
  if (!result.ok) {
    return fail('resolution_not_signed', `conflict.resolved append rejected: ${String(result.reason_code)}: ${result.message ?? ''}`);
  }
  return { ok: true, conflict_id: request.conflict_id, decision_id: signed.decision_id, side: request.side };
}

export type { DecisionRequest };

/** 该 subject 链上最后一位写者（从事件行取，供赢家标注）。 */
export function latestActorForSubject(db: SdoDatabase, subject: string): string | undefined {
  const row = db
    .prepare("SELECT actor FROM event WHERE subject = ? AND kind NOT LIKE 'conflict.%' ORDER BY rowid DESC LIMIT 1")
    .get(subject) as { actor?: string } | undefined;
  return row?.actor;
}

export function newConflictId(): string {
  return `cf-${randomUUID()}`;
}

/** 写网关检测到冲突时替换原事件的 `conflict.detected` 事件。 */
export function buildConflictDetectedEvent(input: {
  readonly conflictId: string;
  readonly table: string;
  readonly objectId: string;
  readonly detection: import('../core/conflict/detect.js').DetectedConflict;
  readonly actor: string;
  readonly at: string;
  readonly prev: string;
}): Event {
  const base = {
    id: `cfd-${randomUUID()}`,
    at: input.at,
    actor: input.actor,
    kind: 'conflict.detected',
    subject: `${input.table}/${input.objectId}`,
    payload: {
      conflict_id: input.conflictId,
      subject: `${input.table}/${input.objectId}`,
      ...input.detection,
      at: input.at,
    },
    caused_by: [] as readonly string[],
    request_id: `req-conflict-${input.conflictId}`,
    prev: input.prev,
  };
  CONFLICT_AUTHORITY.mint(base.id, conflictDetectedPayloadHash(base.payload));
  return { ...base, hash: computeEventHash({ ...base, hash: '' } as Event) };
}
