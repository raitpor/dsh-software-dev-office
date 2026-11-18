import { CODE } from '../../core/errors/codes.js';
/**
 * M2-5 · PM 动作：预占/派发、解阻塞、请求签字、升级给人（attention）、rework。
 *
 * 所有动作都只经 `src/db/write.ts` 的 `append()` 写事件（C7）；
 * 队列状态不落库（A3），动作执行后由 `pm_queue` 视图现算。
 *
 * 硬口径：
 * - 预占/派发前查权限（C2）：owner 的静态写域必须覆盖卡的 scope_paths；
 *   跨泳道已预占冲突同样在派发前拒（Lead m03712 ⑥，`scope_mismatch`）。
 * - 不代签（C3）：`request_sign` 只落待签请求；`sign` 动作恒 `not_a_signer`。
 * - 解阻塞白名单（C4）：只允许 `lease_expired`/`lease_revoked`。
 */

import type { SdoDatabase } from '../../db/driver.js';
import { appendAsTool } from '../../db/write.js';
import { PM_ACTIONS } from './queue.js';
import type { PmAction } from './queue.js';
import {
  hasPmRight,
  isSeatName,
  seatOf,
  scopeCovered,
  scopesCovered,
  scopesOverlap,
  SEATS,
} from './rights.js';
import { canonicalJson, sha256Hex } from '../../core/fold/canonical.js';
import { buildPmEvent, readPmState, rowOf, stringArrayField, stringField } from './state.js';
import type { PmContext, PmFailure } from './types.js';
import { pmFailure } from './types.js';
import { isPmUnblockable } from './queue.js';
import { canEscalateTo, denyAllRightsPort, taskScopes } from './access.js';

export interface PmWriteOk {
  readonly ok: true;
  readonly task_id: string;
  readonly event_id: string;
}

function writeFailed(result: { reason_code?: string; message?: string }): PmFailure {
  return pmFailure('write_failed', `${result.reason_code ?? 'append failed'}: ${result.message ?? ''}`);
}

function taskScopePaths(db: SdoDatabase, taskId: string): {
  state: ReturnType<typeof readPmState>['state'];
  row: ReturnType<typeof rowOf>;
} {
  const { state } = readPmState(db);
  const row = rowOf(state, 'task', taskId);
  return { state, row };
}

export interface AssignInput {
  readonly taskId: string;
  readonly assignee: string;
  readonly at?: string;
}

/** 预占/派发 = `task.claimed`（planned/ready → in_progress，owner=assignee）。 */
export function assignCard(db: SdoDatabase, ctx: PmContext, input: AssignInput): PmWriteOk | PmFailure {
  if (!isSeatName(input.assignee)) {
    return pmFailure('no_such_seat', `unknown seat ${input.assignee}`);
  }
  const { state, row } = taskScopePaths(db, input.taskId);
  if (row === undefined) return pmFailure('task_not_found', `task ${input.taskId} does not exist`);
  const status = stringField(row, 'status') ?? '';
  if (status !== 'planned' && status !== 'ready') {
    return pmFailure('invalid_state', `task ${input.taskId} is ${status}; only planned/ready can be dispatched`);
  }
  const scopePaths = stringArrayField(row, 'scope_paths');
  if (!hasPmRight(ctx.actor, 'assign', scopePaths)) {
    return pmFailure('no_permission', `actor ${ctx.actor} lacks assign@scope over ${scopePaths.join(', ')}`);
  }
  const kind = stringField(row, 'kind') ?? 'implement';
  const readOnlyCard = kind === 'review' || kind === 'docs';
  if (!readOnlyCard && !scopesCovered(SEATS[input.assignee].scopes, scopePaths)) {
    return pmFailure(
      'no_permission',
      `seat ${input.assignee} write scope does not cover ${scopePaths.join(', ')}`,
    );
  }
  // 跨泳道已预占冲突：其他 in_progress/blocked 卡的写域与本卡重叠 ⇒ 事先拒。
  const tasks = state.tables['task'] ?? {};
  for (const [otherId, other] of Object.entries(tasks)) {
    if (otherId === input.taskId) continue;
    const otherStatus = stringField(other, 'status');
    if (otherStatus !== 'in_progress' && otherStatus !== 'blocked') continue;
    const otherOwner = stringField(other, 'owner');
    if (otherOwner === input.assignee) continue;
    if (scopesOverlap(stringArrayField(other, 'scope_paths'), scopePaths)) {
      return pmFailure(
        'scope_mismatch',
        `task ${input.taskId} scope overlaps ${otherId} (${otherOwner ?? 'unowned'}, ${otherStatus})`,
      );
    }
  }
  const event = buildPmEvent(db, {
    kind: 'task.claimed',
    subject: input.taskId,
    actor: ctx.actor,
    ...(input.at === undefined ? {} : { at: input.at }),
    payload: { owner: input.assignee },
  });
  const result = appendAsTool(db, [event], ctx.actor, ctx.actorKind);
  if (!result.ok) return writeFailed(result);
  return { ok: true, task_id: input.taskId, event_id: event.id };
}

export interface UnblockInput {
  readonly taskId: string;
  readonly at?: string;
}

/** 解阻塞：白名单只 `lease_expired`/`lease_revoked`（C4）。 */
export function unblockCard(db: SdoDatabase, ctx: PmContext, input: UnblockInput): PmWriteOk | PmFailure {
  const { row } = taskScopePaths(db, input.taskId);
  if (row === undefined) return pmFailure('task_not_found', `task ${input.taskId} does not exist`);
  if (stringField(row, 'status') !== 'blocked') {
    return pmFailure('invalid_state', `task ${input.taskId} is not blocked`);
  }
  const blockCode = stringField(row, 'block_code') ?? '';
  if (!isPmUnblockable(blockCode)) {
    return pmFailure('not_unblockable_by_pm', `block_code ${blockCode || '<none>'} is not PM-unblockable`);
  }
  const scopePaths = stringArrayField(row, 'scope_paths');
  if (!hasPmRight(ctx.actor, 'assign', scopePaths)) {
    return pmFailure('no_permission', `actor ${ctx.actor} lacks assign@scope over ${scopePaths.join(', ')}`);
  }
  const event = buildPmEvent(db, {
    kind: 'task.unblocked',
    subject: input.taskId,
    actor: ctx.actor,
    ...(input.at === undefined ? {} : { at: input.at }),
    payload: {},
  });
  const result = appendAsTool(db, [event], ctx.actor, ctx.actorKind);
  if (!result.ok) return writeFailed(result);
  return { ok: true, task_id: input.taskId, event_id: event.id };
}

export interface RequestSignInput {
  readonly decisionKind: string;
  /** 待签的 decision 载荷（服务端按此算 `payload_hash`；与 D-055 同一 canonical 口径）。 */
  readonly payload: unknown;
  /** 调用方给的 hash 只做一致性校验；不符 ⇒ `invalid_field`（P2-1）。 */
  readonly payloadHash?: string;
  readonly signer: string;
  readonly proposition?: string;
  readonly taskId?: string;
  readonly at?: string;
}

export interface RequestSignOk {
  readonly ok: true;
  readonly request_id: string;
  readonly event_id: string;
  readonly idempotent: boolean;
}

function payloadRecord(event: { payload?: unknown }): Readonly<Record<string, unknown>> {
  const payload = event.payload;
  if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Readonly<Record<string, unknown>>;
  }
  return {};
}

/**
 * 请求签字（C3）：只落 `request_sign` 事件（ACK，不投影、不产生 decision 行）。
 *
 * P2-1：`payload_hash` **由服务端按载荷内容算**（`sha256(canonicalJson(payload))`，与 D-055 同口径）；
 * 调用方传入的 `payloadHash` 只做一致性校验，不符 ⇒ `invalid_field`。幂等键 = 计算出的
 * `(payload_hash, signer)`，因此“同内容换个 hash 再请求”不会多落一条。
 * 并发边界：先读事件再 append 没有 DB 唯一约束兜底，跨进程并发重放仍可能重复；
 * 单写者假设下成立，M3 授权/请求表落地后加唯一索引（README/卡已写）。
 * `actor_kind` 只从 `PmContext` 取（D-056），请求载荷里若出现则忽略。
 */
export function requestSignature(
  db: SdoDatabase,
  ctx: PmContext,
  input: RequestSignInput,
): RequestSignOk | PmFailure {
  if (!isSeatName(input.signer)) {
    return pmFailure('no_such_seat', `unknown signer ${input.signer}`);
  }
  if (input.decisionKind.trim().length === 0) {
    return pmFailure('invalid_args', 'decisionKind is required');
  }
  if (input.payload === undefined) return pmFailure('invalid_args', 'payload is required');
  const payloadHash = `sha256:${sha256Hex(canonicalJson({
    decision_kind: input.decisionKind,
    payload: input.payload,
    proposition: input.proposition ?? null,
    task_id: input.taskId ?? null,
  }))}`;
  if (input.payloadHash !== undefined && input.payloadHash !== payloadHash) {
    return pmFailure('invalid_field', `payloadHash does not match payload content (computed ${payloadHash})`);
  }
  const { events } = readPmState(db);
  for (const event of events) {
    if (event.kind !== 'request_sign') continue;
    const payload = payloadRecord(event);
    if (payload['payload_hash'] === payloadHash && payload['signer'] === input.signer) {
      return { ok: true, request_id: event.id, event_id: event.id, idempotent: true };
    }
  }
  const event = buildPmEvent(db, {
    kind: 'request_sign',
    subject: payloadHash,
    actor: ctx.actor,
    ...(input.at === undefined ? {} : { at: input.at }),
    payload: {
      decision_kind: input.decisionKind,
      payload_hash: payloadHash,
      signer: input.signer,
      proposition: input.proposition ?? null,
      task_id: input.taskId ?? null,
      requested_by: ctx.actor,
      actor_kind: ctx.actorKind,
      decision_payload: input.payload,
    },
  });
  const result = appendAsTool(db, [event], ctx.actor, ctx.actorKind);
  if (!result.ok) return writeFailed(result);
  return { ok: true, request_id: event.id, event_id: event.id, idempotent: false };
}

export interface AttentionInput {
  readonly taskId: string;
  readonly question: string;
  readonly askedOf: string;
  readonly options?: readonly string[];
  readonly expiresAt: string;
  readonly at?: string;
  readonly subjectId?: string;
}

export interface AttentionOk {
  readonly ok: true;
  readonly attention_id: string;
  readonly event_id: string;
}

/** 升级给人：`attention.raised`（幂等键 (subject, question)，docs/15）。 */
export function raiseAttention(
  db: SdoDatabase,
  ctx: PmContext,
  input: AttentionInput,
): AttentionOk | PmFailure {
  if (input.question.trim().length === 0) return pmFailure('invalid_args', 'question is required');
  if (!isSeatName(input.askedOf)) return pmFailure('no_such_seat', `unknown seat ${input.askedOf}`);
  const { state } = readPmState(db);
  if (rowOf(state, 'task', input.taskId) === undefined) {
    return pmFailure('task_not_found', `task ${input.taskId} does not exist`);
  }
  const existing = Object.entries(state.tables['attention'] ?? {}).find(([, row]) => {
    const status = stringField(row, 'state');
    return stringField(row, 'task_id') === input.taskId &&
      stringField(row, 'question') === input.question &&
      status === 'open';
  });
  if (existing !== undefined) {
    return { ok: true, attention_id: existing[0], event_id: '' };
  }
  const clock = ctx.now ?? Date.now;
  const attentionId = input.subjectId ?? `ATT-${input.taskId}-${clock().toString(36)}`;
  const event = buildPmEvent(db, {
    kind: 'attention.raised',
    subject: attentionId,
    actor: ctx.actor,
    ...(input.at === undefined ? {} : { at: input.at }),
    payload: {
      task_id: input.taskId,
      asked_of: input.askedOf,
      question: input.question,
      options: [...(input.options ?? [])],
      expires_at: input.expiresAt,
    },
  });
  const result = appendAsTool(db, [event], ctx.actor, ctx.actorKind);
  if (!result.ok) return writeFailed(result);
  return { ok: true, attention_id: attentionId, event_id: event.id };
}

export interface StubOk {
  readonly ok: false;
  readonly reason_code: typeof CODE.not_implemented | typeof CODE.not_a_signer;
  readonly message: string;
}

export interface EscalateInput {
  readonly taskId: string;
  /** 目标域 scope（`release:<id>` / `domain:<name>`）。 */
  readonly scope: string;
  readonly question: string;
  readonly askedOf: string;
  readonly options?: readonly string[];
  readonly expiresAt: string;
  readonly at?: string;
  readonly subjectId?: string;
}

/**
 * 升级给人（M3-5 C4）：`escalate@scope` 只能在**自己同时有 `read`** 的域发起；
 * 跨域（不吃该 scope）⇒ `no_permission`；任务不关联该域 ⇒ `scope_mismatch`。
 * 权限来自 `ctx.rights`（可注入）；缺省回退静态席位表（M3-1 前）。
 */
export function escalate(
  db: SdoDatabase,
  ctx: PmContext,
  input: EscalateInput,
): AttentionOk | PmFailure {
  const rights = ctx.rights ?? denyAllRightsPort(ctx.actor);
  if (rights === undefined) {
    return pmFailure('no_permission', `unknown actor ${JSON.stringify(ctx.actor)}: no rights port`);
  }
  if (!canEscalateTo(rights, input.scope)) {
    return pmFailure(
      'no_permission',
      `escalate ${input.scope}: requires both read@${input.scope} and escalate@${input.scope}`,
    );
  }
  const scopes = taskScopes(db, input.taskId).scopes;
  if (!scopes.some((scope) => scopeCovered(input.scope, scope) || scopeCovered(scope, input.scope))) {
    return pmFailure(
      'scope_mismatch',
      `task ${input.taskId} does not belong to ${input.scope} (scopes: ${scopes.join(', ')})`,
    );
  }
  return raiseAttention(db, ctx, {
    taskId: input.taskId,
    question: input.question,
    askedOf: input.askedOf,
    expiresAt: input.expiresAt,
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.at === undefined ? {} : { at: input.at }),
    ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
  });
}

export interface WithdrawAttentionInput {
  readonly attentionId: string;
  /** 撤回也要在同一个域上有 `escalate`（“只能撤自己提的”之外的第二道闸）。 */
  readonly scope: string;
  readonly at?: string;
}

/** 撤回自己的提问（`attention.withdrawn`）：只能撤自己提的（reducer 兜底）+ 域权。 */
export function withdrawAttention(
  db: SdoDatabase,
  ctx: PmContext,
  input: WithdrawAttentionInput,
): PmWriteOk | PmFailure {
  const { state } = readPmState(db);
  const attention = rowOf(state, 'attention', input.attentionId);
  if (attention === undefined) {
    return pmFailure('invalid_args', `attention ${input.attentionId} does not exist`);
  }
  const raisedBy = stringField(attention, 'raised_by');
  if (raisedBy !== ctx.actor) {
    return pmFailure('no_permission', 'only the person who raised an attention can withdraw it');
  }
  const rights = ctx.rights ?? denyAllRightsPort(ctx.actor);
  if (rights === undefined || !rights.has('escalate', input.scope)) {
    return pmFailure('no_permission', `withdraw requires escalate@${input.scope}`);
  }
  const taskId = stringField(attention, 'task_id') ?? '';
  if (taskId.length > 0) {
    // P2-3：撤回也要落在该 attention 所属任务的域上（否则能拿 R-2 的权撤 R-1 的提问）。
    const scopes = taskScopes(db, taskId).scopes;
    if (!scopes.some((scope) => scopeCovered(input.scope, scope) || scopeCovered(scope, input.scope))) {
      return pmFailure(
        'scope_mismatch',
        `attention ${input.attentionId} belongs to ${taskId} (scopes: ${scopes.join(', ')}), not ${input.scope}`,
      );
    }
  }
  const event = buildPmEvent(db, {
    kind: 'attention.withdrawn',
    subject: input.attentionId,
    actor: ctx.actor,
    ...(input.at === undefined ? {} : { at: input.at }),
    payload: { withdrawn_by: ctx.actor, ...(taskId.length === 0 ? {} : { task_id: taskId }) },
  });
  const result = appendAsTool(db, [event], ctx.actor, ctx.actorKind);
  if (!result.ok) return writeFailed(result);
  return { ok: true, task_id: taskId, event_id: event.id };
}

export function grant(): StubOk {
  return {
    ok: false,
    reason_code: CODE.not_implemented,
    message: 'grant 在 M4 前恒空；M2 的权限只来自静态 right 表',
  };
}

/** PM 永远不能代签（C3）。人类签字走 M2-0 的 signDecision/signerd 路径，不在这里。 */
export function sign(): StubOk {
  return {
    ok: false,
    reason_code: CODE.not_a_signer,
    message: 'PM 不能代签；签字由人经 signerd 完成',
  };
}

export function pmActionOf(action: string): PmAction {
  return (PM_ACTIONS as readonly string[]).includes(action) ? (action as PmAction) : 'attention';
}

export function seatScopes(seat: string): readonly string[] {
  return seatOf(seat)?.scopes ?? [];
}
