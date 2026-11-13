/**
 * 差异处置（回指）写动作（M1-2）。
 *
 * 人对复述差异逐条给 accept/reject（`defer` 不算处置，会挡住门，卡 C3）。
 * 只经 `append()` 写 `restatement.diff_dispositioned`；不做 reducer、不做 UI。
 *
 * 人身份：M1 只有 `actor_kind='human'` 这一层调用方标注，**没有签章链**，
 * 它防的是“agent 在编排里替人点了接受”，不是防伪（卡 A2 / Lead m01107）。
 */

import { append } from '../db/write.js';
import type { SdoDatabase } from '../db/driver.js';
import type { ActorKind, AlignWriteResult, DiffDisposition, DiffKind } from './gate.js';
import {
  ACTOR_KINDS,
  DIFF_DISPOSITIONS,
  DIFF_KINDS,
  buildEvent,
  isNonEmptyString,
  isoTimestampMs,
  listDiffs,
  newEventId,
  nowIso,
  readAlignmentState,
  writeFailure,
} from './gate.js';

export interface DisposeDiffInput {
  readonly restatementId: string;
  /** 差异指向的草案条目 id（M1 门以草案条目为目标）。 */
  readonly targetRef: string;
  readonly kind: DiffKind;
  readonly disposition: DiffDisposition;
  readonly reason?: string;
  readonly actor: string;
  /** 调用方标注；除 'human' 外一律拒绝（C4）。 */
  readonly actorKind: ActorKind;
  readonly at?: string;
  /** 可选的事件 id；差异行 id 一律由 `restatementId + targetRef` 派生（见 P1-2）。 */
  readonly eventId?: string;
  readonly requestId?: string;
}

function includes<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/**
 * 处置一条复述差异。
 *
 * 前置：复述存在且未作废；同一 `targetRef` 不重复处置（fold upsert 会覆盖旧行，所以这里 fail-closed）。
 */
export function disposeDiff(db: SdoDatabase, input: DisposeDiffInput): AlignWriteResult {
  if (!isNonEmptyString(input.restatementId)) {
    return writeFailure('invalid_args', 'restatementId 必须是非空字符串');
  }
  if (!isNonEmptyString(input.targetRef)) {
    return writeFailure('invalid_args', 'targetRef 必须是非空字符串');
  }
  if (!isNonEmptyString(input.actor)) {
    return writeFailure('invalid_args', 'actor 必须是非空字符串');
  }
  if (!includes(DIFF_KINDS, input.kind)) {
    return writeFailure('invalid_args', `kind 只接受 ${DIFF_KINDS.join('/')}（收到 ${String(input.kind)}）`);
  }
  if (!includes(DIFF_DISPOSITIONS, input.disposition)) {
    return writeFailure(
      'invalid_args',
      `disposition 只接受 ${DIFF_DISPOSITIONS.join('/')}（收到 ${String(input.disposition)}）`,
    );
  }
  if (!includes(ACTOR_KINDS, input.actorKind)) {
    return writeFailure(
      'invalid_args',
      `actorKind 只接受 ${ACTOR_KINDS.join('/')}（收到 ${String(input.actorKind)}）`,
    );
  }
  if (input.reason !== undefined && !isNonEmptyString(input.reason)) {
    return writeFailure('invalid_args', 'reason 传了就必须是非空字符串');
  }
  if (input.at !== undefined && isoTimestampMs(input.at) === undefined) {
    return writeFailure(
      'invalid_args',
      `at 必须是带时区的 ISO-8601（如 2026-11-12T00:00:00Z）：${String(input.at)}`,
    );
  }

  if (input.actorKind !== 'human') {
    return writeFailure(
      'not_human',
      `回指处置必须由人给（actor_kind=human）；收到 ${input.actorKind}。` +
        'M1 的 actor_kind 是调用方标注、不是签章防伪（M3 才接签名链）',
    );
  }

  const state = readAlignmentState(db);
  const restatement = state.tables['restatement'][input.restatementId];
  if (restatement === undefined) {
    return writeFailure('restatement_not_found', `没有复述 ${input.restatementId}`);
  }
  const invalidReason =
    typeof restatement['invalid_reason'] === 'string' ? restatement['invalid_reason'] : null;
  if (invalidReason !== null) {
    return writeFailure(
      'restatement_invalidated',
      `复述 ${input.restatementId} 已作废（${invalidReason}），差异处置无效`,
      invalidReason,
    );
  }

  const draftSpecs = restatement['draft_specs'];
  const draftIds = new Set<string>();
  if (Array.isArray(draftSpecs)) {
    for (const entry of draftSpecs) {
      if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
        const id = (entry as Record<string, unknown>)['id'];
        if (typeof id === 'string') {
          draftIds.add(id);
        }
      }
    }
  }
  if (!draftIds.has(input.targetRef)) {
    return writeFailure(
      'invalid_args',
      `targetRef ${input.targetRef} 不属于复述 ${input.restatementId} 的 draft_specs`,
    );
  }

  // 差异行 id 一律派生，不接受调用方自定义：否则可以绕过“同一 targetRef 只处置一次”。
  const diffId = `${input.restatementId}:${input.targetRef}`;
  const alreadyDisposed =
    state.tables['restatement_diff'][diffId] !== undefined ||
    listDiffs(state, input.restatementId).some((row) => row.target_ref === input.targetRef);
  if (alreadyDisposed) {
    return writeFailure(
      'diff_already_disposed',
      `差异 ${diffId} 已经处置过；差异处置是 append-only，不原位改（重新复述才是新事实）`,
    );
  }

  const at = input.at ?? nowIso();
  const eventId = input.eventId ?? newEventId('ev');
  const requestId = input.requestId ?? eventId;
  const event = buildEvent(db, {
    id: eventId,
    at,
    actor: input.actor,
    kind: 'restatement.diff_dispositioned',
    subject: diffId,
    payload: {
      restatement_id: input.restatementId,
      kind: input.kind,
      target_ref: input.targetRef,
      disposition: input.disposition,
      reason: input.reason ?? null,
      actor_kind: input.actorKind,
    },
    requestId,
  });

  const result = append(db, [event]);
  if (!result.ok) {
    return writeFailure(
      'write_failed',
      `append 拒绝（${result.reason_code ?? 'unknown'}）：${result.message ?? 'no message'}`,
    );
  }
  return { ok: true, event_id: eventId, event_count: result.eventCount };
}
