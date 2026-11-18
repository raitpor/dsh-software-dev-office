import { CODE } from '../../core/errors/codes.js';
/**
 * M3-2 · 裁决（纯函数）：只认人签 decision；工具不自动选边。
 *
 * D-089：`decision` 表的 `decision_kind` CHECK 是冻结文档枚举（docs/06 §5），
 * 不含 `conflict_resolution`；因此裁决 decision 用 `decision_kind='sign'`，
 * 在签名载荷顶层带 `conflict_resolution: {conflict_id, adopted_actor, note}`
 * （M3 通用 sign；v2.1 若要独立 kind 再改枚举）。
 */

import type { Row } from '../fold/types.js';
import { type ConflictSide } from './types.js';

export interface SignedResolution {
  readonly conflict_id: string;
  readonly side: ConflictSide;
  readonly adopted_actor: string;
  readonly note: string;
  readonly signer: string;
}

/** 冲突行里每一侧的 actor；纯函数，fold 与 DB 共用。 */
export interface ConflictActors {
  readonly winner: string;
  readonly loser: string;
}

export function actorForSide(actors: ConflictActors, side: ConflictSide): string {
  return side === 'winner' ? actors.winner : actors.loser;
}

export type ResolutionCheck =
  | { readonly ok: true; readonly value: SignedResolution }
  | { readonly ok: false; readonly reason_code: typeof CODE.resolution_not_signed | typeof CODE.resolution_payload_mismatch; readonly message: string };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** 校验 decision 行：valid、已签名、载荷 `conflict_resolution` 与事件一致。 */
export function verifyResolutionDecision(
  decision: Row | undefined,
  conflictId: string,
  side: ConflictSide,
  actors: ConflictActors,
): ResolutionCheck {
  if (decision === undefined) {
    return { ok: false, reason_code: CODE.resolution_not_signed, message: `decision for conflict ${conflictId} does not exist` };
  }
  if (decision['status'] !== 'valid') {
    return { ok: false, reason_code: CODE.resolution_not_signed, message: `decision ${String(decision['id'])} is not valid` };
  }
  for (const field of ['signature', 'key_id', 'signer'] as const) {
    if (!nonEmpty(decision[field])) {
      return {
        ok: false,
        reason_code: CODE.resolution_not_signed,
        message: `decision ${String(decision['id'])} is not signed; conflict stays open`,
      };
    }
  }
  const payload = decision['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason_code: CODE.resolution_payload_mismatch, message: 'decision payload is not an object' };
  }
  const nested = (payload as Record<string, unknown>)['conflict_resolution'];
  if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) {
    return {
      ok: false,
      reason_code: CODE.resolution_payload_mismatch,
      message: `decision ${String(decision['id'])} payload has no conflict_resolution`,
    };
  }
  const resignation = nested as Record<string, unknown>;
  const adoptedActor = resignation['adopted_actor'];
  if (!nonEmpty(adoptedActor)) {
    return {
      ok: false,
      reason_code: CODE.resolution_payload_mismatch,
      message: `decision ${String(decision['id'])} payload has no adopted_actor`,
    };
  }
  if (resignation['note'] !== undefined && typeof resignation['note'] !== 'string') {
    return {
      ok: false,
      reason_code: CODE.resolution_payload_mismatch,
      message: `decision ${String(decision['id'])} payload.note must be a string`,
    };
  }
  const expectedActor = actorForSide(actors, side);
  if (adoptedActor !== expectedActor) {
    return {
      ok: false,
      reason_code: CODE.resolution_payload_mismatch,
      message: `decision ${String(decision['id'])} adopts ${String(adoptedActor)}, not the ${side} actor ${expectedActor}`,
    };
  }
  if (resignation['conflict_id'] !== conflictId) {
    return {
      ok: false,
      reason_code: CODE.resolution_payload_mismatch,
      message: `decision ${String(decision['id'])} targets another conflict`,
    };
  }
  return {
    ok: true,
    value: { conflict_id: conflictId, side, adopted_actor: adoptedActor, note: typeof resignation['note'] === 'string' ? resignation['note'] : '', signer: decision['signer'] as string },
  };
}

/** resolved 行 patch（fold 与 DB 共用口径）。 */
export function resolvedPatch(
  resolution: SignedResolution,
  decisionId: string,
  at: string,
): Row {
  return {
    status: 'resolved',
    resolution_decision_id: decisionId,
    resolved_by: resolution.signer,
    resolved_at: at,
  };
}
