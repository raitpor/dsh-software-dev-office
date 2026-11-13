/**
 * 复述（restatement）写动作（M1-2）。
 *
 * - `proposeRestatement`：agent 的独立复述，落 `restatement.recorded`；
 * - `invalidateRestatement`：intent 变更后把旧复述置为作废，落 `restatement.invalidated`。
 *
 * 两个动作都只经 `append()` 写事件；不做物化、不碰 reducer（reducer 在 src/core/fold）。
 */

import { append } from '../db/write.js';
import type { SdoDatabase } from '../db/driver.js';
import type { AlignmentInputEdge, AlignWriteResult } from './gate.js';
import {
  buildEvent,
  earliestSpecForIntent,
  isNonEmptyString,
  isoTimestampMs,
  newEventId,
  nowIso,
  readAlignmentState,
  writeFailure,
} from './gate.js';

export interface ProposeRestatementInput {
  readonly intentId: string;
  /** 草案条目：每条至少带非空字符串 id（作者合并后才变成真 spec）。 */
  readonly draftSpecs: readonly Record<string, unknown>[];
  /** 必须恰好一条 `{kind:'intent', id:intentId, hash:<当前 intent.content_hash>}`。 */
  readonly inputs: readonly AlignmentInputEdge[];
  readonly actor: string;
  readonly at?: string;
  readonly by?: string;
  readonly acceptedSpecIds?: readonly string[];
  readonly restatementId?: string;
  readonly eventId?: string;
  readonly requestId?: string;
}

function validateDraftSpecs(draftSpecs: readonly Record<string, unknown>[]): string | undefined {
  if (!Array.isArray(draftSpecs) || draftSpecs.length === 0) {
    return 'draftSpecs 必须是非空数组';
  }
  const seen = new Set<string>();
  for (const entry of draftSpecs) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return 'draftSpecs 每条必须是非 null 对象';
    }
    const id = (entry as Record<string, unknown>)['id'];
    if (!isNonEmptyString(id)) {
      return 'draftSpecs 每条都要有非空字符串 id';
    }
    if (seen.has(id)) {
      return `draftSpecs 的 id 重复：${id}`;
    }
    seen.add(id);
  }
  return undefined;
}

function validateAcceptedSpecIds(acceptedSpecIds: readonly string[] | undefined): string | undefined {
  if (acceptedSpecIds === undefined) {
    return undefined;
  }
  if (!Array.isArray(acceptedSpecIds)) {
    return 'acceptedSpecIds 传了就必须是字符串数组';
  }
  const seen = new Set<string>();
  for (const specId of acceptedSpecIds) {
    if (!isNonEmptyString(specId)) {
      return 'acceptedSpecIds 每项都必须是非空字符串';
    }
    if (seen.has(specId)) {
      return `acceptedSpecIds 重复：${specId}`;
    }
    seen.add(specId);
  }
  return undefined;
}

function validateInputs(inputs: readonly AlignmentInputEdge[], intentId: string): string | undefined {
  if (!Array.isArray(inputs) || inputs.length !== 1) {
    return 'inputs 必须恰好一条 intent 边（docs/03:44）';
  }
  const edge = inputs[0];
  if (edge === undefined || typeof edge !== 'object') {
    return 'inputs[0] 必须是一个对象';
  }
  if (!isNonEmptyString(edge.kind) || !isNonEmptyString(edge.id) || !isNonEmptyString(edge.hash)) {
    return 'inputs[0] 的 kind/id/hash 都必须是非空字符串';
  }
  if (edge.kind !== 'intent') {
    return 'inputs[0].kind 必须是 intent（复述只绑 intent）';
  }
  if (edge.id !== intentId) {
    return `inputs[0].id（${edge.id}）必须等于 intentId（${intentId}）`;
  }
  return undefined;
}

/**
 * 记录 agent 的独立复述。
 *
 * 卡的 C1/C2 在写之前拦住：intent hash 过期 ⇒ `stale_restatement`（不写事件，回执带旧/新 hash）；
 * 复述不早于该 intent 下最早条款 ⇒ `restatement_too_late`。
 */
export function proposeRestatement(
  db: SdoDatabase,
  input: ProposeRestatementInput,
): AlignWriteResult {
  if (!isNonEmptyString(input.intentId)) {
    return writeFailure('invalid_args', 'intentId 必须是非空字符串');
  }
  if (!isNonEmptyString(input.actor)) {
    return writeFailure('invalid_args', 'actor 必须是非空字符串');
  }
  const draftError = validateDraftSpecs(input.draftSpecs);
  if (draftError !== undefined) {
    return writeFailure('invalid_args', draftError);
  }
  const inputError = validateInputs(input.inputs, input.intentId);
  if (inputError !== undefined) {
    return writeFailure('invalid_args', inputError);
  }
  if (input.by !== undefined && !isNonEmptyString(input.by)) {
    return writeFailure('invalid_args', 'by 传了就必须是非空字符串');
  }
  const acceptedError = validateAcceptedSpecIds(input.acceptedSpecIds);
  if (acceptedError !== undefined) {
    return writeFailure('invalid_args', acceptedError);
  }
  if (input.at !== undefined && isoTimestampMs(input.at) === undefined) {
    return writeFailure(
      'invalid_args',
      `at 必须是带时区的 ISO-8601（如 2026-11-12T00:00:00Z）：${String(input.at)}`,
    );
  }

  const edge = input.inputs[0];
  if (edge === undefined) {
    return writeFailure('invalid_args', 'inputs 必须恰好一条 intent 边');
  }

  const state = readAlignmentState(db);
  const intent = state.tables['intent'][input.intentId];
  if (intent === undefined) {
    return writeFailure(
      'intent_not_found',
      `intent ${input.intentId} 还不存在；先由人签字（intent.signed）`,
    );
  }
  const currentHash = typeof intent['content_hash'] === 'string' ? intent['content_hash'] : undefined;
  if (currentHash === undefined) {
    return writeFailure('intent_not_found', `intent ${input.intentId} 没有 content_hash，无法绑定复述版本`);
  }
  if (edge.hash !== currentHash) {
    return writeFailure(
      'stale_restatement',
      `复述绑定的 intent hash ${edge.hash} 已过期；当前 intent.content_hash 是 ${currentHash}。请基于最新 intent 重新复述`,
      `旧 hash ${edge.hash} / 新 hash ${currentHash}`,
    );
  }

  const at = input.at ?? nowIso();
  const atMs = isoTimestampMs(at);
  if (atMs === undefined) {
    return writeFailure('invalid_args', `at 必须是带时区的 ISO-8601：${at}`);
  }

  if (input.acceptedSpecIds !== undefined) {
    const draftIds = new Set(input.draftSpecs.map((entry) => entry['id']));
    const knownSpecIds = new Set(Object.keys(state.tables['spec']));
    const unknown = input.acceptedSpecIds.filter((specId) => !draftIds.has(specId) && !knownSpecIds.has(specId));
    if (unknown.length > 0) {
      return writeFailure(
        'invalid_args',
        `acceptedSpecIds 里有既不属于 draftSpecs、也不是已存在 spec 的条目：${unknown.join(', ')}`,
      );
    }
  }

  const specTimes = earliestSpecForIntent(state, input.intentId);
  if (!specTimes.ok) {
    return writeFailure('invalid_args', `条款 at 不是带时区的 ISO-8601：${specTimes.badAt}`);
  }
  const earliest = specTimes.earliest;
  if (earliest !== undefined && atMs >= earliest.ms) {
    return writeFailure(
      'restatement_too_late',
      `复述时间 ${at} 不早于该 intent 下最早条款 ${earliest.at}；复述必须早于条款（docs/03:44）`,
      `restatement.at ${at} >= 最早 spec.at ${earliest.at}`,
    );
  }

  const restatementId = input.restatementId ?? newEventId('restatement');
  const eventId = input.eventId ?? newEventId('ev');
  const requestId = input.requestId ?? eventId;
  const payload: Record<string, unknown> = {
    intent_id: input.intentId,
    draft_specs: input.draftSpecs,
    inputs: input.inputs,
  };
  if (input.by !== undefined) {
    payload['by'] = input.by;
  }
  if (input.acceptedSpecIds !== undefined) {
    payload['accepted_spec_ids'] = input.acceptedSpecIds;
  }

  const event = buildEvent(db, {
    id: eventId,
    at,
    actor: input.actor,
    kind: 'restatement.recorded',
    subject: restatementId,
    payload,
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

export interface InvalidateRestatementInput {
  readonly restatementId: string;
  readonly reason: string;
  readonly actor: string;
  readonly at?: string;
  readonly eventId?: string;
  readonly requestId?: string;
}

/**
 * 把一条复述置为作废（C6）。intent 变更后必须重跑对齐；作废本身走 append-only 事件。
 * 重复作废返回结构化失败（`restatement_invalidated`），不再写事件。
 */
export function invalidateRestatement(
  db: SdoDatabase,
  input: InvalidateRestatementInput,
): AlignWriteResult {
  if (!isNonEmptyString(input.restatementId)) {
    return writeFailure('invalid_args', 'restatementId 必须是非空字符串');
  }
  if (!isNonEmptyString(input.reason)) {
    return writeFailure('invalid_args', 'reason 必须是非空字符串');
  }
  if (!isNonEmptyString(input.actor)) {
    return writeFailure('invalid_args', 'actor 必须是非空字符串');
  }
  if (input.at !== undefined && isoTimestampMs(input.at) === undefined) {
    return writeFailure(
      'invalid_args',
      `at 必须是带时区的 ISO-8601（如 2026-11-12T00:00:00Z）：${String(input.at)}`,
    );
  }

  const state = readAlignmentState(db);
  const row = state.tables['restatement'][input.restatementId];
  if (row === undefined) {
    return writeFailure('restatement_not_found', `没有复述 ${input.restatementId}`);
  }
  const invalidReason = typeof row['invalid_reason'] === 'string' ? row['invalid_reason'] : null;
  if (invalidReason !== null) {
    return writeFailure(
      'restatement_invalidated',
      `复述 ${input.restatementId} 已经作废：${invalidReason}`,
      invalidReason,
    );
  }

  const at = input.at ?? nowIso();
  const eventId = input.eventId ?? newEventId('ev');
  const requestId = input.requestId ?? eventId;
  const event = buildEvent(db, {
    id: eventId,
    at,
    actor: input.actor,
    kind: 'restatement.invalidated',
    subject: input.restatementId,
    payload: { reason: input.reason },
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
