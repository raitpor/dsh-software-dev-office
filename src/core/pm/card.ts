/**
 * M2-5 · 建卡（C1）与 rework 建卡（C5/C6 的最小集）。
 *
 * C1：`task.created` 必须带意图边与判据（缺 ⇒ `card_incomplete`，结构化拒绝，不是 warn）。
 * 判据来源是 fold 事件态：`intent:<id>` 行存在、每个 `criterion:<id>` 行存在；
 * 卡的 `inputs` 里写这两类标记，便于下游与重放核对。
 */

import type { SdoDatabase } from '../../db/driver.js';
import { appendAsTool } from '../../db/write.js';
import { hasPmRight } from './rights.js';
import { buildPmEvent, readPmState, rowOf } from './state.js';
import type { PmContext, PmFailure } from './types.js';
import { pmFailure } from './types.js';

export const TASK_KINDS = ['implement', 'design', 'review', 'docs'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface CreateCardInput {
  readonly taskId?: string;
  readonly seq: number;
  readonly title: string;
  readonly kind: TaskKind;
  readonly intentId: string;
  readonly criterionIds: readonly string[];
  readonly scopePaths: readonly string[];
  readonly blockedBy?: readonly string[];
  readonly inputs?: readonly string[];
  readonly subjectKind?: 'task' | 'spec';
  readonly subjectId?: string;
  readonly at?: string;
}

export interface CardCreated {
  readonly ok: true;
  readonly task_id: string;
  readonly event_id: string;
}

export type CardResult = CardCreated | PmFailure;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function createCard(db: SdoDatabase, ctx: PmContext, input: CreateCardInput): CardResult {
  const kind = input.kind;
  if (!(TASK_KINDS as readonly string[]).includes(kind)) {
    return pmFailure('invalid_args', `kind must be one of ${TASK_KINDS.join('|')}`);
  }
  if (!Number.isInteger(input.seq) || input.seq <= 0) {
    return pmFailure('invalid_args', 'seq must be a positive integer');
  }
  const title = isNonEmptyString(input.title) ? input.title.trim() : '';
  const intentId = isNonEmptyString(input.intentId) ? input.intentId : '';
  const criterionIds = input.criterionIds.filter(isNonEmptyString);
  const scopePaths = input.scopePaths.filter(isNonEmptyString);
  if (title.length === 0) return pmFailure('invalid_args', 'title is required');
  if (intentId.length === 0) {
    return pmFailure('card_incomplete', 'task.created requires an intent edge (intentId)');
  }
  if (criterionIds.length === 0 || criterionIds.length !== input.criterionIds.length) {
    return pmFailure('card_incomplete', 'task.created requires at least one criterion');
  }
  if (scopePaths.length === 0 || scopePaths.length !== input.scopePaths.length) {
    return pmFailure('card_incomplete', 'task.created requires scopePaths (写域即边界)');
  }
  if (!hasPmRight(ctx.actor, 'plan', scopePaths)) {
    return pmFailure('no_permission', `actor ${ctx.actor} lacks plan@domain over ${scopePaths.join(', ')}`);
  }

  const { state } = readPmState(db);
  if (rowOf(state, 'intent', intentId) === undefined) {
    return pmFailure('invalid_args', `intent ${intentId} does not exist in the event chain`);
  }
  for (const criterionId of criterionIds) {
    if (rowOf(state, 'criterion', criterionId) === undefined) {
      return pmFailure('invalid_args', `criterion ${criterionId} does not exist in the event chain`);
    }
  }

  const taskId = input.taskId !== undefined && isNonEmptyString(input.taskId)
    ? input.taskId
    : `TASK-${input.seq}`;
  const inputs = [
    ...(input.inputs ?? []),
    `intent:${intentId}`,
    ...criterionIds.map((criterionId) => `criterion:${criterionId}`),
  ];
  const event = buildPmEvent(db, {
    kind: 'task.created',
    subject: taskId,
    actor: ctx.actor,
    ...(input.at === undefined ? {} : { at: input.at }),
    payload: {
      seq: input.seq,
      title,
      kind,
      status: 'planned',
      created_by: ctx.actor,
      ...(ctx.producer === undefined ? {} : { producer: ctx.producer }),
      scope_paths: scopePaths,
      inputs: [...new Set(inputs)],
      blocked_by: [...new Set(input.blockedBy ?? [])],
      subject_kind: input.subjectKind ?? null,
      subject_id: input.subjectId ?? null,
    },
  });
  const result = appendAsTool(db, [event], ctx.actor, ctx.actorKind);
  if (!result.ok) {
    return pmFailure('write_failed', `${result.reason_code ?? 'append failed'}: ${result.message ?? ''}`);
  }
  return { ok: true, task_id: taskId, event_id: event.id };
}

export interface ReworkInput {
  readonly changeId: string;
  readonly subject: string;
  readonly intentId: string;
  readonly criterionIds: readonly string[];
  readonly scopePaths: readonly string[];
  readonly seq: number;
  readonly title?: string;
  readonly at?: string;
}

export interface ReworkCreated {
  readonly ok: true;
  readonly task_id: string;
  readonly event_id: string;
  readonly idempotent: boolean;
}

/** `rework`：幂等键 (change_id, subject)（docs/15 动作表）。 */
export function requestRework(db: SdoDatabase, ctx: PmContext, input: ReworkInput): ReworkCreated | PmFailure {
  if (!isNonEmptyString(input.changeId) || !isNonEmptyString(input.subject)) {
    return pmFailure('invalid_args', 'rework requires changeId and subject');
  }
  const { state } = readPmState(db);
  const tasks = state.tables['task'] ?? {};
  for (const [taskId, row] of Object.entries(tasks)) {
    const inputs = Array.isArray(row['inputs']) ? row['inputs'] : [];
    const status = String(row['status']);
    const already = inputs.includes(`change:${input.changeId}`) &&
      inputs.includes(`rework-subject:${input.subject}`) &&
      String(row['kind']) === 'implement' &&
      status !== 'done' && status !== 'dropped';
    if (already) {
      return { ok: true, task_id: taskId, event_id: '', idempotent: true };
    }
  }
  const created = createCard(db, ctx, {
    seq: input.seq,
    title: input.title ?? `rework ${input.changeId} / ${input.subject}`,
    kind: 'implement',
    intentId: input.intentId,
    criterionIds: input.criterionIds,
    scopePaths: input.scopePaths,
    inputs: [`change:${input.changeId}`, `rework-subject:${input.subject}`],
    ...(input.at === undefined ? {} : { at: input.at }),
  });
  if (!created.ok) return created;
  return { ok: true, task_id: created.task_id, event_id: created.event_id, idempotent: false };
}
