/**
 * M3-2 · 冲突检测（纯函数）：同一 `(subject, field)` 上的乐观并发。
 *
 * 口径（P2-1）：`payload.base_hash` 是写入者看到的**该字段当前值**的 hash
 * （`valueHash(currentRow[field])`，粒度 = 对象 id + 字段名）。与 actor 无关：
 * 同 actor 用 stale base 也冲突（诚实；想覆盖就带当前 base）。
 */

import { valueHash } from './hash.js';
import type { Event, Row } from '../fold/types.js';

export interface ConflictClaim {
  readonly field: string;
  readonly base_hash: string;
  /** 事件载荷里写入方给出的新值（仅作 loser_value 摘要，缺失记 null）。 */
  readonly value: unknown;
}

export interface ConflictInputs {
  /** 当前投影行；行不存在 ⇒ 首写，不判冲突。 */
  readonly currentRow: Row | undefined;
  /** 当前 subject 链上最后一位写者（从事件行取，不读 payload 自称）。 */
  readonly winnerActor: string | undefined;
  readonly event: Event;
}

export interface DetectedConflict {
  readonly field: string;
  readonly base_hash: string;
  readonly current_hash: string;
  readonly winner_actor: string;
  readonly loser_actor: string;
  readonly winner_value: string;
  readonly loser_value: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** 从事件载荷取 `field` / `base_hash`；不带就是“不参与 CAS”的写。 */
export function extractConflictClaim(event: Event): ConflictClaim | undefined {
  if (event.kind.startsWith('conflict.')) return undefined;
  const payload = asRecord(event.payload);
  if (payload === undefined) return undefined;
  const field = payload['field'];
  const baseHash = payload['base_hash'];
  if (typeof field !== 'string' || field.length === 0) return undefined;
  if (typeof baseHash !== 'string' || baseHash.length === 0) return undefined;
  return { field, base_hash: baseHash, value: payload['value'] ?? payload['field_value'] ?? null };
}

/**
 * 返回冲突事实；`undefined` = 不冲突（首写/版本相符/事件没声明 base_hash）。
 * 无 actor 自豁免：同 actor 用 stale base 写也算冲突（用事件行取 winner/loser）。
 * `currentRow` 用 fold 投影行（与 M1-5 同口径），不是 DB 原始行。
 */
export function detectConflict(inputs: ConflictInputs): DetectedConflict | undefined {
  const claim = extractConflictClaim(inputs.event);
  if (claim === undefined) return undefined;
  const { currentRow, winnerActor, event } = inputs;
  if (currentRow === undefined) return undefined;
  const winnerValue = currentRow[claim.field];
  const currentHash = valueHash(winnerValue);
  if (currentHash === claim.base_hash) return undefined;
  return {
    field: claim.field,
    base_hash: claim.base_hash,
    current_hash: currentHash,
    winner_actor: winnerActor ?? 'unknown',
    loser_actor: event.actor,
    winner_value: JSON.stringify(winnerValue ?? null),
    loser_value: JSON.stringify(claim.value ?? null),
  };
}

/** `conflict.detected` 事件载荷（fold reducer 按它投影 conflict 行）。 */
export interface ConflictDetectedPayload {
  readonly conflict_id: string;
  readonly subject: string;
  readonly field: string;
  readonly base_hash: string;
  readonly current_hash: string;
  readonly winner_actor: string;
  readonly loser_actor: string;
  readonly winner_value: string;
  readonly loser_value: string;
  readonly at: string;
}

export function conflictDetectedPayload(
  conflictId: string,
  subject: string,
  detection: DetectedConflict,
  at: string,
): ConflictDetectedPayload {
  return { conflict_id: conflictId, subject, ...detection, at };
}
