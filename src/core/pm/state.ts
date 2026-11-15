/**
 * M2-5 · 读事件链 + 造事件（只读工具，不写库）。
 *
 * 写动作统一走 `src/db/write.ts` 的 `append()`（卡 C7 / 团队写域规则）：
 * 本文件只负责把「要 append 的事件」按信封与链头哈希拼好。
 */

import { randomUUID } from 'node:crypto';

import { fold } from '../fold/index.js';
import type { Event, FoldState, Row } from '../fold/types.js';
import { computeEventHash } from '../verify-events.js';
import { readEvents } from '../verify-events.js';
import type { VerifyProblem } from '../verify-types.js';
import type { SdoDatabase } from '../../db/driver.js';
import { chainHead } from '../../db/write.js';

export interface PmState {
  readonly state: FoldState;
  readonly events: readonly Event[];
}

export function readPmState(db: SdoDatabase): PmState {
  const problems: VerifyProblem[] = [];
  const events = readEvents(db, problems);
  if (problems.length > 0) {
    const first = problems[0];
    throw new Error(`pm state unavailable: ${first?.code ?? 'event chain problem'}`);
  }
  return { state: fold(undefined, events), events };
}

export interface PmEventDraft {
  readonly kind: string;
  readonly subject: string;
  readonly payload: unknown;
  readonly actor: string;
  readonly at?: string;
  readonly requestId?: string;
  readonly causedBy?: readonly string[];
}

export function newEventId(prefix = 'pm'): string {
  return `${prefix}-${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function buildPmEvent(db: SdoDatabase, draft: PmEventDraft): Event {
  const id = newEventId();
  const at = draft.at ?? nowIso();
  const base = {
    id,
    at,
    actor: draft.actor,
    kind: draft.kind,
    subject: draft.subject,
    payload: draft.payload,
    caused_by: draft.causedBy ?? [],
    request_id: draft.requestId ?? id,
    prev: chainHead(db),
  };
  const hash = computeEventHash({ ...base, hash: '' });
  return { ...base, hash };
}

export function rowsOf(state: FoldState, table: string): Readonly<Record<string, Row>> {
  const tables = state.tables as unknown as Readonly<Record<string, Readonly<Record<string, Row>>>>;
  return tables[table] ?? {};
}

export function rowOf(state: FoldState, table: string, id: string): Row | undefined {
  return rowsOf(state, table)[id];
}

export function stringField(row: Row | undefined, field: string): string | undefined {
  if (row === undefined) return undefined;
  const value = row[field];
  return typeof value === 'string' ? value : undefined;
}

export function stringArrayField(row: Row | undefined, field: string): readonly string[] {
  if (row === undefined) return [];
  const value = row[field];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
