import { fail, FoldError } from './guards.js';
import { REDUCERS } from './registry.js';
import { ACK_KINDS } from './ack.js';
import { cloneState, emptyState, freezeState } from './state.js';
import { propagateInvalidations } from './propagate.js';
import type { Event, FoldState } from './types.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** docs/02 §10：信封字段先于规则校验；坏信封带 id/kind fail-closed。 */
function checkEnvelope(event: Event): void {
  if (!isNonEmptyString(event.id)) {
    throw new FoldError(`fold failed (kind ${String(event.kind)}): event.id must be a non-empty string`);
  }
  for (const field of ['at', 'actor', 'kind', 'subject', 'request_id', 'prev', 'hash'] as const) {
    if (!isNonEmptyString(event[field])) {
      return fail(event, `${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(event.caused_by) || event.caused_by.some((item) => typeof item !== 'string')) {
    return fail(event, 'caused_by must be an array of event ids');
  }
}

/**
 * 把事件序列折成物化状态（docs/02 §12）。
 * 纯函数：不读时钟、不碰 fs/环境；同一输入序列 ⇒ 同一输出；重复 event.id 直接跳过。
 */
export function fold(prev: FoldState | undefined, events: readonly Event[]): FoldState {
  const working = cloneState(prev ?? emptyState());
  for (const event of events) {
    if (working.seen[event.id] === true) {
      continue;
    }
    checkEnvelope(event);
    const reducer = REDUCERS[event.kind];
    if (reducer === undefined) {
      if (ACK_KINDS[event.kind] !== undefined) {
        propagateInvalidations(working, event);
        working.seen[event.id] = true;
        working.eventIds.push(event.id);
        continue;
      }
      return fail(event, 'unknown event kind');
    }
    reducer(working, event);
    propagateInvalidations(working, event);
    working.seen[event.id] = true;
    working.eventIds.push(event.id);
  }
  return freezeState(working);
}

/** 单个事件折叠（增量入口；M0 的 fold 全量重放也走这里）。 */
export function foldEvent(prev: FoldState | undefined, event: Event): FoldState {
  return fold(prev, [event]);
}

export type { Event, FoldState } from './types.js';
export { FoldError } from './guards.js';
export { emptyState } from './state.js';
