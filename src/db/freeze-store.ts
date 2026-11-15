import type { FreezeDbResult } from './freeze-types.js';
/** M2-1 冻结事务的库内助手（行读取、链头、rejected 事件）。 */
import type { SdoDatabase } from './driver.js';
import { appendAsTool, chainHead } from './write.js';
import { computeEventHash } from '../core/verify-events.js';
import type { Event } from '../core/fold/types.js';
import type { BaselineRowLike } from '../core/baseline/freeze.js';
import type { FreezeSession } from './freeze-types.js';

export type { FreezeSession } from './freeze-types.js';

export function rows(db: SdoDatabase, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return (db.prepare(sql).all(...params) as unknown) as Array<Record<string, unknown>>;
}

export function buildEvent(partial: Omit<Event, 'hash' | 'prev'>, prev: string): Event {
  const draft = { ...partial, prev, hash: '' } as Event;
  return { ...draft, hash: computeEventHash(draft) };
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function toRow(raw: Record<string, unknown>): BaselineRowLike {
  return {
    id: String(raw['id']),
    frozen_by: String(raw['frozen_by']),
    engine_version: String(raw['engine_version']),
    criteria_manifest_hash: String(raw['criteria_manifest_hash']),
    policy: parseJson(raw['policy']),
    criteria: parseJson(raw['criteria']),
    gates: parseJson(raw['gates']),
    thresholds: parseJson(raw['thresholds']),
    assurance: parseJson(raw['assurance']),
    prev: raw['prev'] === null ? null : String(raw['prev']),
    direction: raw['direction'] === null ? null : (raw['direction'] as 'tighten' | 'loosen'),
    hash: String(raw['hash']),
    at: String(raw['at']),
  };
}

/** 链头 = 没有被任何行 `prev` 指向的那一行（`docs/04` §5.2）。 */
export function currentBaseline(db: SdoDatabase): BaselineRowLike | null {
  const all = rows(db, 'SELECT * FROM baseline').map(toRow);
  if (all.length === 0) return null;
  const referenced = new Set(all.map((row) => row.prev).filter((id): id is string => id !== null));
  const heads = all.filter((row) => !referenced.has(row.id));
  if (heads.length > 1) throw new Error(`baseline chain has multiple heads: ${heads.map((row) => row.id).join(', ')}`);
  return heads[0] ?? null;
}

export function baselineById(db: SdoDatabase, id: string): BaselineRowLike | null {
  const found = rows(db, 'SELECT * FROM baseline WHERE id = ?', id);
  return found.length === 0 ? null : toRow(found[0]!);
}

export function readBaselineId(input: unknown): string | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = (input as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/** 落 `baseline.rejected`（ACK 事件，不投影）；id 加纳秒级随机后缀防同毫秒撞。 */
export function rejectEvent(
  db: SdoDatabase,
  session: FreezeSession,
  input: unknown,
  failure: { reason_code: string; message: string; reason_codes?: readonly string[] },
  at: string,
): string {
  const id = readBaselineId(input) ?? 'unknown';
  const eventId = `ev-base-rej-${id}-${at}-${Math.random().toString(16).slice(2, 10)}`;
  appendAsTool(db, [
    buildEvent(
      {
        id: eventId,
        at,
        actor: session.actor,
        kind: 'baseline.rejected',
        subject: id,
        payload: { reason_codes: failure.reason_codes ?? [failure.reason_code], message: failure.message, baseline_id: id },
        caused_by: [],
        request_id: `baseline:${id}:${at}`,
      },
      chainHead(db),
    ),
  ], session.actor, session.actor_kind);
  return eventId;
}

export function failure(reason: string, message: string, extra?: Partial<FreezeDbResult>): FreezeDbResult {
  return { ok: false, reason_code: reason, message, ...extra };
}
