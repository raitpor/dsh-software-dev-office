import { CODE } from '../errors/codes.js';
/**
 * M3-2 · 冲突可见的类型与常量。
 *
 * 真源：docs/02 §3（写不进去 ⇒ 409 conflict，不做自动合并）、docs/07 §6.1
 * （并发靠数据库、分歧靠人；并发写**不是** disputed）。
 * 本文件只有纯类型与不变量，不碰 DB。
 */

export const CONFLICT_DETECTED = 'conflict.detected' as const;
export const CONFLICT_RESOLVED = 'conflict.resolved' as const;

/** 冲突表的 `status`（docs/05 conflicts 视图口径）。 */
export const CONFLICT_STATUSES = ['open', 'resolved'] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

/** 裁决只能从两方里选一；工具不选边。 */
export const CONFLICT_SIDES = ['winner', 'loser'] as const;
export type ConflictSide = (typeof CONFLICT_SIDES)[number];



/** `conflict` 表的一行（DB 投影口径）。 */
export interface ConflictRow {
  readonly id: string;
  /** `<table>/<object id>`，如 `spec/SPEC-1`。 */
  readonly subject: string;
  readonly field: string;
  readonly base_hash: string;
  readonly current_hash: string;
  readonly winner_actor: string;
  readonly loser_actor: string;
  /** JSON 文本（写入方看到的值/当前值摘要）。 */
  readonly winner_value: string;
  readonly loser_value: string;
  readonly status: ConflictStatus;
  readonly resolution_decision_id: string | null;
  readonly resolved_by: string | null;
  readonly resolved_at: string | null;
  readonly at: string;
}

/** 写网关检测到冲突后要落进 `conflict` 行/事件的内容。 */
export interface ConflictDetection {
  readonly subject: string;
  readonly field: string;
  readonly base_hash: string;
  readonly current_hash: string;
  readonly winner_actor: string;
  readonly loser_actor: string;
  readonly winner_value: string;
  readonly loser_value: string;
}

/** 失败返回（写网关 409 语义；HTTP 映射在 M3-4/控制台）。 */
export interface ConflictFailure {
  readonly ok: false;
  readonly reason_code: ConflictReason;
  readonly message: string;
  readonly conflict_id?: string;
  readonly base_hash?: string;
  readonly current_hash?: string;
}

export interface ConflictResolution {
  readonly ok: true;
  readonly conflict_id: string;
  readonly decision_id: string;
  readonly side: ConflictSide;
}

/**
 * `decision.valid.payload` 里携带的裁决内容（D-089：decision_kind 仍用 `sign`）。
 *
 * M3 用通用 `sign`（冻结枚举无 conflict_resolution）；v2.1 若要独立
 * decision_kind 再改 `docs/06` 枚举。载荷点名被采纳的人（adopted_actor），
 * 而不是内部的 winner/loser 位置词——展示层与审计读到的都是人。
 */
export interface ConflictResolutionPayload {
  readonly conflict_id: string;
  readonly adopted_actor: string;
  readonly note: string;
}

export function isConflictStatus(value: unknown): value is ConflictStatus {
  return typeof value === 'string' && (CONFLICT_STATUSES as readonly string[]).includes(value);
}

export function isConflictSide(value: unknown): value is ConflictSide {
  return typeof value === 'string' && (CONFLICT_SIDES as readonly string[]).includes(value);
}


export const ConflictReason_CODES = [
  CODE.conflict,
  CODE.conflict_already_resolved,
  CODE.conflict_invalid,
  CODE.conflict_not_found,
  CODE.resolution_not_signed,
  CODE.resolution_payload_mismatch,
] as const;
export type ConflictReason = (typeof ConflictReason_CODES)[number];
