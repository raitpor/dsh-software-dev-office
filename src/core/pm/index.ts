/**
 * M2-5 · PM 最小环路（读 pm_queue → 建卡 → 预占/派发 → 请求签字）。
 *
 * 入口只暴露「读队列 / 建卡 / 派发 / 解阻塞 / 请求签字 / 升级给人 / rework」，
 * 以及明确拒绝的 `escalate`/`grant`/`sign`。所有写动作只经 `src/db/write.ts` 的 `append()`。
 */

export type { PmActorKind, PmContext, PmFailure, PmFailureCode } from './types.js';
export { pmFailure } from './types.js';

export {
  PM_REASON_CODES,
  PM_ACTIONS,
  UNBLOCKABLE_BLOCK_CODES,
  actionFor,
  readPmQueue,
  writableAction,
  isPmReasonCode,
  isPmUnblockable,
} from './queue.js';
export type { PmAction, PmQueueRead, PmQueueRow, PmReasonCode } from './queue.js';

export { SEATS, hasPmRight, isSeatName, scopeCovered, scopesCovered, scopesOverlap, seatOf, seatViewRight } from './rights.js';
export type { PmGrant, PmRightKind, Seat, SeatName } from './rights.js';

export { TASK_KINDS, createCard, requestRework } from './card.js';
export type { CardCreated, CardResult, CreateCardInput, ReworkCreated, ReworkInput, TaskKind } from './card.js';

export {
  assignCard,
  escalate,
  grant,
  pmActionOf,
  raiseAttention,
  requestSignature,
  seatScopes,
  sign,
  unblockCard,
} from './act.js';
export type {
  AssignInput,
  AttentionInput,
  AttentionOk,
  PmWriteOk,
  RequestSignInput,
  RequestSignOk,
  StubOk,
  UnblockInput,
} from './act.js';

export { buildPmEvent, newEventId, nowIso, readPmState, rowOf, rowsOf, stringArrayField, stringField } from './state.js';
export type { PmEventDraft, PmState } from './state.js';
