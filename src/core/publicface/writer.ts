/**
 * M4-3/C4：`publicface.writer_changed` 是真 reducer（不是 ACK）。
 *
 * 目的表 `public_face_writer` 全库只有一行（单写者）。初始指派用 `from: null`
 * 的 bootstrap 事件建立；之后每次切换必须给出当前持有者 `from`，且时间不倒流。
 * 网关侧由 `public_face_writer` 一次性能力把守（见 src/db/write.ts），本 reducer
 * 负责“事件流自身可复算”的那一半：只有合法切换才能投影出唯一持有者行。
 */
import type { Event, FoldWorking } from '../fold/types.js';
import { fail, optString, payloadOf, reqString } from '../fold/guards.js';

const TABLE = 'public_face_writer';

export function publicFaceWriterChanged(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const to = reqString(event, payload, 'to');
  const at = reqString(event, payload, 'at');
  const rawFrom = payload['from'];
  if (rawFrom !== null && rawFrom !== undefined && typeof rawFrom !== 'string') {
    return fail(event, 'publicface.writer_changed payload.from must be a string or null');
  }
  const from = typeof rawFrom === 'string' ? rawFrom : undefined;
  const note = optString(event, payload, 'note') ?? null;
  const current = currentWriter(state);
  if (current === undefined) {
    if (from !== undefined) {
      return fail(event, `publicface.writer_changed from=${from} but no writer has been assigned yet (initial assignment must use from=null)`);
    }
  } else {
    if (from === undefined || from !== current) {
      return fail(event, `publicface.writer_changed from=${from ?? 'null'} does not match current writer ${current}`);
    }
    if (to === current) return fail(event, `publicface.writer_changed to=${to} is already the current writer`);
    const heldSince = String(state.tables[TABLE]['1']?.['held_since'] ?? '');
    if (Number.isNaN(Date.parse(at)) || Number.isNaN(Date.parse(heldSince)) || Date.parse(at) < Date.parse(heldSince)) {
      return fail(event, `publicface.writer_changed at=${at} must not precede held_since=${heldSince}`);
    }
  }
  // 固定主键 id=1：单行是物理约束；交棒是同一行的 UPDATE，不触发单行 INSERT 闸。
  state.tables[TABLE]['1'] = { id: 1, actor: to, held_since: at, note };
}

export function currentWriter(state: FoldWorking): string | undefined {
  const row = state.tables[TABLE]['1'];
  const actor = row?.['actor'];
  return typeof actor === 'string' ? actor : undefined;
}
