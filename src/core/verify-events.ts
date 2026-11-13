/**
 * 事件链重算（M0-6 C4）：读 event 表、逐条重算 hash、检查 prev 连续。
 * 真源：docs/02 §10（`hash = sha256(规范化(事件去 hash) + prev)`）。
 */

import { canonicalJson, sha256Hex } from './fold/canonical.js';
import type { Event } from './fold/types.js';
import type { VerifyDatabase, VerifyProblem } from './verify-types.js';

export const GENESIS_PREV = 'sha256:genesis';

export const EVENT_SQL =
  'SELECT id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash FROM event ORDER BY rowid';

export function computeEventHash(event: Event): string {
  const body = canonicalJson({
    id: event.id,
    at: event.at,
    actor: event.actor,
    kind: event.kind,
    subject: event.subject,
    payload: event.payload,
    caused_by: event.caused_by,
    request_id: event.request_id,
    prev: event.prev,
  });
  return `sha256:${sha256Hex(body + event.prev)}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toEvent(
  raw: Record<string, unknown>,
  rowIndex: number,
  problems: VerifyProblem[],
): Event | undefined {
  const objectId = asString(raw['id']) ?? `row#${rowIndex}`;
  const id = asString(raw['id']);
  const at = asString(raw['at']);
  const actor = asString(raw['actor']);
  const kind = asString(raw['kind']);
  const prev = asString(raw['prev']);
  const hash = asString(raw['hash']);
  if (
    id === undefined || at === undefined || actor === undefined ||
    kind === undefined || prev === undefined || hash === undefined
  ) {
    problems.push({ code: 'event_parse_failed', objectId, detail: 'event row is missing a required text column' });
    return undefined;
  }

  let payload: unknown;
  let causedBy: unknown;
  try {
    if (typeof raw['payload'] !== 'string' || typeof raw['caused_by'] !== 'string') {
      throw new Error('payload/caused_by must be JSON strings');
    }
    payload = JSON.parse(raw['payload']);
    causedBy = JSON.parse(raw['caused_by']);
  } catch (error) {
    problems.push({ code: 'event_parse_failed', objectId, detail: errorMessage(error) });
    return undefined;
  }
  if (!Array.isArray(causedBy) || causedBy.some((value) => typeof value !== 'string')) {
    problems.push({ code: 'event_parse_failed', objectId, detail: 'caused_by must be a JSON string array' });
    return undefined;
  }

  return {
    id,
    at,
    actor,
    kind,
    subject: asString(raw['subject']) ?? '',
    payload,
    caused_by: causedBy as string[],
    request_id: asString(raw['request_id']) ?? '',
    prev,
    hash,
  };
}

/** 读事件表并验链；返回可交给 `fold` 的事件序列。 */
export function readEvents(db: VerifyDatabase, problems: VerifyProblem[]): Event[] {
  const rawRows = db.prepare(EVENT_SQL).all() as Array<Record<string, unknown>>;
  const events: Event[] = [];
  let previousHash = GENESIS_PREV;

  for (let index = 0; index < rawRows.length; index += 1) {
    const event = toEvent(rawRows[index] ?? {}, index, problems);
    if (event === undefined) {
      continue;
    }
    if (event.hash !== computeEventHash(event)) {
      problems.push({
        code: 'event_hash_mismatch',
        objectId: event.id,
        detail: 'stored hash does not match the recomputed hash',
      });
    }
    if (event.prev !== previousHash) {
      problems.push({
        code: 'event_chain_broken',
        objectId: event.id,
        detail: `prev ${event.prev} does not match previous hash ${previousHash}`,
      });
    }
    previousHash = event.hash;
    events.push(event);
  }

  return events;
}
