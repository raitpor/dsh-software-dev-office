/**
 * 对齐模块（M1-2）公开入口：复述 / 例子 / 回指三件套。
 *
 * 写动作只经 `src/db/write.ts` 的 `append()`；门判定只读事件链折出的状态。
 * 不提供 UI、不写事件以外的任何东西。
 */

export type {
  ActorKind,
  AlignReason,
  AlignmentGateOptions,
  AlignmentGateResult,
  AlignmentInputEdge,
  AlignWriteResult,
  DiffDisposition,
  DiffKind,
  EventDraft,
  RestatementDiffView,
  RestatementView,
} from './gate.js';
export {
  ACTOR_KINDS,
  DIFF_DISPOSITIONS,
  DIFF_KINDS,
  PROVISIONAL_REASONS,
  alignmentGate,
  buildEvent,
  earliestSpecForIntent,
  gateFailure,
  isNonEmptyString,
  isoTimestampMs,
  listDiffs,
  listRestatements,
  newEventId,
  nowIso,
  readAlignmentState,
  textCompare,
  toRestatementView,
  writeFailure,
} from './gate.js';
export type { InvalidateRestatementInput, ProposeRestatementInput } from './restatement.js';
export { invalidateRestatement, proposeRestatement } from './restatement.js';
export type { DisposeDiffInput } from './diff.js';
export { disposeDiff } from './diff.js';
