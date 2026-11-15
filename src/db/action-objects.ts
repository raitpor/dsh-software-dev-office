/**
 * M3-1/C8：动作级对象条件（不往矩阵加条件列，在动作实现里强制）。
 *
 * - `defect.close`：只凭一次 **pass** 的 `verify_run` 关闭，且 `closed_by` = 该次复验的 actor；
 * - `verify_finding`：只认对象（review 行）的 `subject_producer`。
 *
 * 两个动作在 `docs/07` §2 里都**没有额外权**（矩阵 required 为空），拒因只可能是对象条件，
 * 故返回 `object_condition_failed`，不伪装成 `no_permission`。
 */

import { randomUUID } from 'node:crypto';

import type { Event, FoldState } from '../core/fold/types.js';
import { computeEventHash } from '../core/verify-events.js';
import type { SdoDatabase } from './driver.js';
import { appendAsTool, chainHead } from './write.js';
import type { AppendResult } from './write-types.js';

export interface ActionSession {
  readonly actor: string;
  readonly actor_kind: 'human' | 'agent' | 'service';
}

export interface ObjectConditionFailure {
  readonly ok: false;
  readonly reason_code: 'object_condition_failed';
  readonly message: string;
}

function fail(message: string): ObjectConditionFailure {
  return { ok: false, reason_code: 'object_condition_failed', message };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function payloadOf(event: Event): Record<string, unknown> {
  const raw: unknown = event.payload;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export type ObjectCondition = (
  state: FoldState,
  event: Event,
  session: ActionSession,
) => ObjectConditionFailure | undefined;

/**
 * M3-1/P1-1：对象条件下的**唯一**实现。网关对每条事件在落库前调用；
 * `closeDefect`/`verifyFinding` 包装函数不再自己判，避免直 append 绕过。
 */
export const ACTION_OBJECT_CONDITIONS: Readonly<Record<string, ObjectCondition>> = {
  'defect.closed': (state, event, session) => {
    const defect = state.tables.defect[event.subject];
    if (defect === undefined) return fail(`defect ${event.subject} does not exist`);
    if (defect['status'] !== 'open') {
      return fail(`defect ${event.subject} is ${String(defect['status'])}; only open can be closed`);
    }
    const payload = payloadOf(event);
    const runId = text(payload['verify_run_id']);
    if (runId === undefined) return fail('defect.closed requires payload.verify_run_id');
    const run = state.tables.verify_run[runId];
    if (run === undefined) return fail(`verify_run ${runId} does not exist`);
    if (run['result'] !== 'pass') {
      return fail(`defect close requires verify_run.result = pass (got ${String(run['result'])})`);
    }
    if (run['actor'] !== session.actor) {
      return fail(
        `closed_by must equal verify_run.actor (verify_run.actor=${String(run['actor'])}, actor=${session.actor})`,
      );
    }
    if (text(payload['closed_by']) !== session.actor) {
      return fail(`payload.closed_by must equal the session actor (${session.actor})`);
    }
    return undefined;
  },
  'review.finding_verified': (state, event, session) => {
    const review = state.tables.review[event.subject];
    if (review === undefined) return fail(`review ${event.subject} does not exist`);
    if (review['subject_producer'] !== session.actor) {
      return fail(
        `only the producer of the reviewed object can verify its finding (producer=${String(review['subject_producer'])}, actor=${session.actor})`,
      );
    }
    return undefined;
  },
};

function build(partial: Omit<Event, 'hash'>): Event {
  return { ...partial, hash: computeEventHash({ ...partial, hash: '' } as Event) };
}

export interface CloseDefectInput {
  readonly defect_id: string;
  readonly verify_run_id: string;
  readonly at: string;
  readonly event_id?: string;
}

/** C8 负例：失败的 verify_run、或 closed_by 不是复验 actor ⇒ 拒，0 行。 */
export function closeDefect(
  db: SdoDatabase,
  session: ActionSession,
  input: CloseDefectInput,
): AppendResult | ObjectConditionFailure {
  const event = build({
    id: input.event_id ?? `defect-closed-${randomUUID()}`,
    at: input.at,
    actor: session.actor,
    kind: 'defect.closed',
    subject: input.defect_id,
    payload: { verify_run_id: input.verify_run_id, closed_by: session.actor },
    caused_by: [],
    request_id: `req-defect-close-${input.defect_id}`,
    prev: chainHead(db),
  });
  return appendAsTool(db, [event], session.actor, session.actor_kind);
}

export interface VerifyFindingInput {
  readonly review_id: string;
  readonly at: string;
  readonly event_id?: string;
}

/** C8 负例：非对象 producer 核实 ⇒ 拒，0 行。 */
export function verifyFinding(
  db: SdoDatabase,
  session: ActionSession,
  input: VerifyFindingInput,
): AppendResult | ObjectConditionFailure {
  const event = build({
    id: input.event_id ?? `review-verified-${randomUUID()}`,
    at: input.at,
    actor: session.actor,
    kind: 'review.finding_verified',
    subject: input.review_id,
    payload: { verified_by: session.actor },
    caused_by: [],
    request_id: `req-review-verified-${input.review_id}`,
    prev: chainHead(db),
  });
  return appendAsTool(db, [event], session.actor, session.actor_kind);
}
