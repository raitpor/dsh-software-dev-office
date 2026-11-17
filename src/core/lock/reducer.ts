/**
 * M4-1/C1+C4：`lock.*` 与 `lease.revoked` 的 fold reducer（不再留在 ACK）。
 *
 * 真源：docs/07 §13 的 lock 表（`path_prefix, card_id, actor, acquired_at, expires_at`）。
 * 本实现追加三列 `status/released_at/released_by`，用于“释放保留证据”与 C4 的撤租约标记：
 * - `lock.acquired` 建行（status=active）；
 * - `lock.released` 标 status=released（行保留，历史可追）；
 * - `lease.revoked` 不删锁，只标 released_by='lease_revoked'、保持 active：
 *   同 actor 可重新认领（acquirer 允许覆盖自己带该标记的行），别的 actor 仍被挡（C4）。
 *
 * 前缀规范化在 db/lock.ts 入口完成；reducer 只接受已规范化的 `event.subject`
 * （空串=根，表示整棵树），非法形态仍 fail-closed。
 */
import type { Event, FoldWorking } from '../fold/types.js';
import { fail, optString, patchRow, payloadOf, reqString, rowOf, upsert } from '../fold/guards.js';
import { normalizePrefix, prefixesOverlap } from './prefix.js';
import { LOCK_TOOL_INITIATOR } from './ttl.js';

function lockRow(event: Event, state: FoldWorking, prefix: string) {
  const row = rowOf(state, 'lock', prefix);
  if (row === undefined) {
    return fail(event, `lock ${prefix === '' ? '.' : prefix} does not exist`);
  }
  return row;
}

/**
 * 相交判定（C1/P1-1）：权威在 fold，不在 DB 的“先查后插”。
 * 同一前缀：released 行可覆盖；active+lease_revoked 仅原 actor 可重领；
 * 同 actor 同卡的 active 行视为幂等重放（不报错、不产生第二行）。
 * 不同前缀但路径段相交：任何 active 行（含 lease_revoked）都挡。
 */
function heldConflict(
  state: FoldWorking,
  event: Event,
  prefix: string,
  card_id: string,
): { prefix: string; actor: string; card_id: string; acquired_at: string } | undefined {
  const row = rowOf(state, 'lock', prefix);
  if (row !== undefined) {
    const status = row['status'];
    if (status === 'released') return undefined;
    // 幂等只认“同 actor + 同 card + 同前缀”；同 actor 换卡是覆盖，事件流必须拒（第 2 轮 P2）。
    if (row['actor'] === event.actor && row['card_id'] === card_id) return undefined;
    return {
      prefix,
      actor: String(row['actor'] ?? ''),
      card_id: String(row['card_id'] ?? ''),
      acquired_at: String(row['acquired_at'] ?? ''),
    };
  }
  for (const [otherPrefix, other] of Object.entries(state.tables.lock)) {
    if (other['status'] !== 'active') continue;
    if (!prefixesOverlap(prefix, otherPrefix)) continue;
    // 根锁（主树重写的全局排序锁）与“本卡自己的 scope 锁”不冲突：claim 收尾前
    // 卡仍持锁，准入若不许就会因自身锁永远锁死在 lock_conflict（第 5 轮 P3 实测发现）。
    // 别的卡/别的 actor 的锁仍照常挡。
    if (prefix === '' && other['actor'] === event.actor && other['card_id'] === card_id) continue;
    return {
      prefix: otherPrefix,
      actor: String(other['actor'] ?? ''),
      card_id: String(other['card_id'] ?? ''),
      acquired_at: String(other['acquired_at'] ?? ''),
    };
  }
  return undefined;
}

/** `lock.acquired`：任何相交活锁 ⇒ fold 失败（append 整体回滚，行与事件同生同死）。 */
function lockAcquired(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const normalized = normalizePrefix(event.subject);
  if (!normalized.ok) {
    return fail(event, `lock subject must be a normalized relative prefix: ${normalized.message}`);
  }
  const prefix = normalized.prefix;
  const cardId = reqString(event, payload, 'card_id');
  // 第 2 轮 P1：根锁只能由工作副本工具产生；事件流自证，不靠网关单点。
  if (prefix === '' && payload['initiator'] !== LOCK_TOOL_INITIATOR) {
    return fail(event, `root lock requires initiator=${LOCK_TOOL_INITIATOR}; event stream cannot forge it`);
  }
  const conflict = heldConflict(state, event, prefix, cardId);
  if (conflict !== undefined) {
    const shown = conflict.prefix === '' ? '.' : conflict.prefix;
    return fail(
      event,
      `lock ${shown} is held by ${conflict.actor} (card ${conflict.card_id}) since ${conflict.acquired_at}`,
    );
  }
  upsert(state, 'lock', prefix, {
    path_prefix: prefix,
    card_id: cardId,
    actor: event.actor,
    status: 'active',
    acquired_at: optString(event, payload, 'acquired_at') ?? event.at,
    expires_at: reqString(event, payload, 'expires_at'),
    released_at: null,
    released_by: null,
  });
}

/** `lock.released`：只释放活锁；重复释放 fail-closed（不让事件流静默丢一次释放）。 */
function lockReleased(state: FoldWorking, event: Event): void {
  const payload = payloadOf(event);
  const normalized = normalizePrefix(event.subject);
  if (!normalized.ok) {
    return fail(event, `lock subject must be a normalized relative prefix: ${normalized.message}`);
  }
  const prefix = normalized.prefix;
  const row = lockRow(event, state, prefix);
  if (row['status'] !== 'active') {
    return fail(event, `lock ${prefix === '' ? '.' : prefix} is not active`);
  }
  // P1-2：业务释放的第二道守卫——只有持有者本人能释放。工具释放（第 3 轮 P2）以工具身份
  // 落事件，凭 payload 的 initiator 标记放行；能力已在网关校验（D-148）。
  const toolRelease = payload['initiator'] === LOCK_TOOL_INITIATOR;
  if (!toolRelease && row['actor'] !== event.actor) {
    return fail(
      event,
      `lock ${prefix === '' ? '.' : prefix} is held by ${String(row['actor'] ?? '')}; actor ${event.actor} cannot release it`,
    );
  }
  patchRow(state, 'lock', prefix, event, {
    status: 'released',
    released_at: optString(event, payload, 'released_at') ?? event.at,
    released_by: optString(event, payload, 'released_by') ?? 'released',
  });
}

/**
 * `lease.revoked`（docs/12）：撤租约后在飞卡回 ready、副本保留；锁也保留证据。
 * 本 reducer 把该 card 的活锁标 `released_by='lease_revoked'`，**不**改成 released
 * ——语义是“这个持有者失格，但同一份证据/前缀仍被占着直到重新认领或显式释放”。
 */


export const LOCK_REDUCERS = {
  'lock.acquired': lockAcquired,
  'lock.released': lockReleased,
} as const;
