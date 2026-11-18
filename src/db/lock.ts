import { CODE } from '../core/errors/codes.js';
/**
 * M4-1：锁的 DB 服务（事件是唯一真源）。
 *
 * 认领不再直接 INSERT 物化表（D-030：行只能由 append 产生）。相交判定下沉到 fold
 * 的 `lock.acquired` reducer：append 事务里 fold 失败 ⇒ 事件与行一起回滚，崩溃也不会
 * 留下“无事件支撑的活锁”（P1-1/D-138）。`ux_lock_active_prefix` 保留为第二道闸。
 *
 * 调用方拿到 409 语义：相交 ⇒ `lock_conflict`（读一遍 active 行给出 holder/前缀/时间）。
 * 根前缀（`.`）只允许经本模块的 `acquireMainTreeLock`/`releaseMainTreeLock`（工具能力，
 * payload.initiator 标记 + 一次性 mint），业务 `acquireLock` 直接 `no_permission`（P2-5）。
 */
import { randomUUID } from 'node:crypto';
import type { SdoDatabase } from './driver.js';
import { buildEvent } from './freeze-store.js';
import { append, appendAsTool, chainHead } from './write.js';
import type { Event } from '../core/fold/types.js';
import { normalizePrefix, prefixesOverlap, ROOT_PREFIX, type PrefixResult } from '../core/lock/prefix.js';
import { LOCK_TTL_MS } from '../core/lock/ttl.js';
import {
  LOCK_TOOL_MARKER,
  createLockToolAuthority,
  lockToolPayloadHash,
} from './lock-capability.js';

export { LOCK_GRACE_MS, LOCK_TTL_MS } from '../core/lock/ttl.js';

/** 工作副本工具的身份：工具做的事用工具身份做（第 3 轮 P2）。 */
export const WORKCOPY_TOOL_ACTOR = 'sdo-workcopy';

/** 私有实例：mint 只在本文件内可见（第 2 轮 P3-2）。 */
const LOCK_TOOL_AUTHORITY = createLockToolAuthority();

/** 网关侧消费入口（一次性；错配也烧）。 */
export function consumeLockToolAuthority(eventId: string, payloadHash: string): boolean {
  return LOCK_TOOL_AUTHORITY.consume(eventId, payloadHash);
}

export interface LockSession {
  readonly actor: string;
  readonly actor_kind: 'human' | 'agent' | 'service';
}

export interface LockConflict {
  readonly prefix: string;
  readonly holder: string;
  readonly holder_card: string;
  readonly since: string;
}

export interface LockFailure {
  readonly ok: false;
  readonly reason_code: typeof CODE.invalid_field | typeof CODE.no_permission | typeof CODE.lock_conflict | typeof CODE.lock_missing | typeof CODE.append_failed;
  readonly message: string;
  readonly conflict?: LockConflict;
}

export interface LockRow {
  readonly prefix: string;
  readonly card_id: string;
  readonly actor: string;
  readonly acquired_at: string;
  readonly expires_at: string;
  readonly released_by: string | null;
}

export interface LockOk {
  readonly ok: true;
  readonly prefix: string;
  readonly row: LockRow;
}

interface ActiveRow {
  path_prefix: string;
  card_id: string;
  actor: string;
  acquired_at: string;
  expires_at: string;
  released_by: string | null;
}

function readActive(db: SdoDatabase): ActiveRow[] {
  return db
    .prepare(
      "SELECT path_prefix, card_id, actor, acquired_at, expires_at, released_by FROM lock WHERE status = 'active'",
    )
    .all() as ActiveRow[];
}

function asRow(row: ActiveRow): LockRow {
  return {
    prefix: row.path_prefix,
    card_id: row.card_id,
    actor: row.actor,
    acquired_at: row.acquired_at,
    expires_at: row.expires_at,
    released_by: row.released_by ?? null,
  };
}

function display(prefix: string): string {
  return prefix === '' ? '.' : prefix;
}

/** scope 按前缀首段推导（P2-5）；根前缀保留给工具路径。 */
export function scopeForPrefix(prefix: string): string {
  if (prefix === '') return 'domain:core';
  const first = prefix.split('/')[0] ?? '';
  return /^[a-z0-9][a-z0-9._-]*$/.test(first) ? `module:${first}` : 'module:core';
}

function conflictOf(row: ActiveRow): LockConflict {
  return {
    prefix: row.path_prefix,
    holder: row.actor,
    holder_card: row.card_id,
    since: row.acquired_at,
  };
}

/** 只读预扫：给调用方友好 409；判定权威仍在 fold。 */
function preScan(
  db: SdoDatabase,
  prefix: string,
  session: LockSession,
  cardId: string,
): { kind: 'same'; row: ActiveRow } | { kind: 'conflict'; row: ActiveRow } | { kind: 'free' } {
  for (const row of readActive(db)) {
    if (row.path_prefix === prefix && row.actor === session.actor) {
      return row.card_id === cardId ? { kind: 'same', row } : { kind: 'conflict', row };
    }
    if (!prefixesOverlap(prefix, row.path_prefix)) continue;
    return { kind: 'conflict', row };
  }
  return { kind: 'free' };
}

function buildLockEvent(
  db: SdoDatabase,
  kind: 'lock.acquired' | 'lock.released',
  prefix: string,
  payload: Record<string, unknown>,
  session: LockSession,
  at: string,
): Event {
  const subject = prefix === '' ? '.' : prefix;
  return buildEvent(
    {
      id: `${kind}:${subject}:${randomUUID()}`,
      at,
      actor: session.actor,
      kind,
      subject,
      payload,
      caused_by: [],
      request_id: `lock:${subject}:${at}`,
    },
    chainHead(db),
  );
}

function appendBusiness(
  db: SdoDatabase,
  kind: 'lock.acquired' | 'lock.released',
  prefix: string,
  payload: Record<string, unknown>,
  session: LockSession,
  at: string,
): { ok: true } | { ok: false; reason_code: string; message: string } {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = append(db, [buildLockEvent(db, kind, prefix, payload, session, at)], { session });
    if (result.ok) return { ok: true };
    if (result.reason_code !== CODE.event_chain_broken && result.reason_code !== CODE.append_conflict) {
      return { ok: false, reason_code: result.reason_code ?? 'append_failed', message: result.message ?? '' };
    }
  }
  return { ok: false, reason_code: CODE.append_failed, message: 'append retry exhausted' };
}

function appendToolLock(
  db: SdoDatabase,
  kind: 'lock.acquired' | 'lock.released',
  prefix: string,
  payload: Record<string, unknown>,
  actor: string,
  at: string,
): { ok: true } | { ok: false; reason_code: string; message: string } {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const session: LockSession = { actor, actor_kind: 'service' };
    const event = buildLockEvent(db, kind, prefix, { ...payload, initiator: LOCK_TOOL_MARKER }, session, at);
    LOCK_TOOL_AUTHORITY.mint(event.id, lockToolPayloadHash(event.payload));
    const result = appendAsTool(db, [event], actor, 'service');
    if (result.ok) return { ok: true };
    if (result.reason_code !== CODE.event_chain_broken && result.reason_code !== CODE.append_conflict) {
      return { ok: false, reason_code: result.reason_code ?? 'append_failed', message: result.message ?? '' };
    }
  }
  return { ok: false, reason_code: CODE.append_failed, message: 'append retry exhausted' };
}

function failureFromAppend(
  db: SdoDatabase,
  prefix: string,
  fallback: { reason_code: string; message: string },
): LockFailure {
  const row = readActive(db).find((candidate) => prefixesOverlap(prefix, candidate.path_prefix));
  if (row !== undefined) {
    return {
      ok: false,
      reason_code: CODE.lock_conflict,
      message: `path prefix ${display(row.path_prefix)} is held`,
      conflict: conflictOf(row),
    };
  }
  return { ok: false, reason_code: CODE.append_failed, message: `${fallback.reason_code}: ${fallback.message}` };
}

function normalizeOrFail(value: unknown): PrefixResult {
  return normalizePrefix(value);
}

/** 业务路径：申请非根前缀的锁。 */
export function acquireLock(
  db: SdoDatabase,
  input: { prefix: unknown; card_id: string; session: LockSession; at: string; ttl_ms?: number },
): LockOk | LockFailure {
  const normalized = normalizeOrFail(input.prefix);
  if (!normalized.ok) return { ok: false, reason_code: CODE.invalid_field, message: normalized.message };
  const prefix = normalized.prefix;
  if (prefix === ROOT_PREFIX) {
    return {
      ok: false,
      reason_code: CODE.no_permission,
      message: 'root lock is reserved for the workcopy tool path (acquireMainTreeLock)',
    };
  }
  const expiresAt = new Date(Date.parse(input.at) + (input.ttl_ms ?? LOCK_TTL_MS)).toISOString();
  const pre = preScan(db, prefix, input.session, input.card_id);
  if (pre.kind === 'conflict') {
    return {
      ok: false,
      reason_code: CODE.lock_conflict,
      message: `path prefix ${display(pre.row.path_prefix)} is held`,
      conflict: conflictOf(pre.row),
    };
  }
  if (pre.kind === 'same') return { ok: true, prefix, row: asRow(pre.row) };
  const appended = appendBusiness(
    db,
    'lock.acquired',
    prefix,
    { card_id: input.card_id, acquired_at: input.at, expires_at: expiresAt, scope: scopeForPrefix(prefix) },
    input.session,
    input.at,
  );
  if (!appended.ok) return failureFromAppend(db, prefix, appended);
  return {
    ok: true,
    prefix,
    row: {
      prefix, card_id: input.card_id, actor: input.session.actor,
      acquired_at: input.at, expires_at: expiresAt, released_by: null,
    },
  };
}

/**
 * 主树锁第一道闸（纯函数，便于单测）：只服务根锁，`rows` 必须是 active 全量（函数不按
 * `path_prefix` 再过滤，返回首个相交冲突行）。
 * 返回 `undefined` 表示可继续；返回冲突行表示立即 `lock_conflict`。
 * 规则（D-156）：同 actor + 同 card 放行（本卡 scope 锁不挡自己）；
 * 同 actor 换卡、别的 actor 都必须挡——不是“同 actor 即放行”。
 */
export function rootLockPrecheck<T extends { actor: string; card_id: string }>(
  rows: readonly T[],
  actor: string,
  cardId: string,
): T | undefined {
  for (const row of rows) {
    if (row.actor === actor && row.card_id === cardId) continue;
    return row;
  }
  return undefined;
}

/**
 * 工具路径：申请主树全局锁（根前缀）。只由 `src/db/workcopy.ts` 在 admit 时调用；
 * 事件走一次性能力，不需要业务动作/矩阵权限（P2-5/D-122 同模式）。
 */
export function acquireMainTreeLock(
  db: SdoDatabase,
  input: { card_id: string; session: LockSession; at: string; ttl_ms?: number },
): LockOk | LockFailure {
  const prefix = ROOT_PREFIX;
  const expiresAt = new Date(Date.parse(input.at) + (input.ttl_ms ?? LOCK_TTL_MS)).toISOString();
  const rows = readActive(db);
  const own = rows.find(
    (row) => row.path_prefix === prefix && row.actor === input.session.actor && row.card_id === input.card_id,
  );
  if (own !== undefined) return { ok: true, prefix, row: asRow(own) };
  const blocking = rootLockPrecheck(rows, input.session.actor, input.card_id);
  if (blocking !== undefined) {
    return {
      ok: false,
      reason_code: CODE.lock_conflict,
      message: `path prefix ${display(blocking.path_prefix)} is held`,
      conflict: conflictOf(blocking),
    };
  }
  const appended = appendToolLock(
    db,
    'lock.acquired',
    prefix,
    { card_id: input.card_id, acquired_at: input.at, expires_at: expiresAt, scope: 'domain:core' },
    input.session.actor,
    input.at,
  );
  if (!appended.ok) return failureFromAppend(db, prefix, appended);
  return {
    ok: true,
    prefix,
    row: {
      prefix: '', card_id: input.card_id, actor: input.session.actor,
      acquired_at: input.at, expires_at: expiresAt, released_by: null,
    },
  };
}

/** 释放一个前缀（写 lock.released；行保留为 released）。只允许持有者本人（P1-2）。 */
export function releaseLock(
  db: SdoDatabase,
  input: { prefix: unknown; session: LockSession; at: string; released_by?: string },
): LockOk | LockFailure {
  const normalized = normalizeOrFail(input.prefix);
  if (!normalized.ok) return { ok: false, reason_code: CODE.invalid_field, message: normalized.message };
  const prefix = normalized.prefix;
  if (prefix === ROOT_PREFIX) {
    return { ok: false, reason_code: CODE.no_permission, message: 'root lock is released through releaseMainTreeLock' };
  }
  const row = readActive(db).find((candidate) => candidate.path_prefix === prefix);
  if (row === undefined) {
    return { ok: false, reason_code: CODE.lock_missing, message: `no active lock at ${display(prefix)}` };
  }
  if (row.actor !== input.session.actor) {
    return {
      ok: false,
      reason_code: CODE.no_permission,
      message: `lock ${display(prefix)} is held by ${row.actor}; actor ${input.session.actor} cannot release it`,
    };
  }
  const appended = appendBusiness(
    db,
    'lock.released',
    prefix,
    { released_at: input.at, released_by: input.released_by ?? 'released', scope: scopeForPrefix(prefix) },
    input.session,
    input.at,
  );
  if (!appended.ok) return { ok: false, reason_code: CODE.append_failed, message: appended.message };
  return { ok: true, prefix, row: { ...asRow(row), released_by: input.released_by ?? 'released' } };
}

/** 工具路径：释放主树锁（admit 失败/成功后清理）。无锁则视为已释放（幂等）。 */
export function releaseMainTreeLock(
  db: SdoDatabase,
  input: { session: LockSession; at: string },
): { ok: true } | LockFailure {
  const row = readActive(db).find((candidate) => candidate.path_prefix === ROOT_PREFIX);
  if (row === undefined) return { ok: true };
  if (row.actor !== input.session.actor) {
    return {
      ok: false,
      reason_code: CODE.no_permission,
      message: `root lock is held by ${row.actor}; actor ${input.session.actor} cannot release it`,
    };
  }
  const appended = appendToolLock(
    db,
    'lock.released',
    ROOT_PREFIX,
    { released_at: input.at, released_by: 'released' },
    input.session.actor,
    input.at,
  );
  if (!appended.ok) return { ok: false, reason_code: CODE.append_failed, message: appended.message };
  return { ok: true };
}

/** 工具身份释放一个前缀（事件 actor 是工具本身；reducer/网关按 initiator 标记放行）。 */
function appendToolRelease(
  db: SdoDatabase,
  prefix: string,
  at: string,
): { ok: true } | { ok: false; reason_code: string; message: string } {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const session: LockSession = { actor: WORKCOPY_TOOL_ACTOR, actor_kind: 'service' };
    const event = buildLockEvent(db, 'lock.released', prefix, { released_at: at, released_by: 'released', initiator: LOCK_TOOL_MARKER }, session, at);
    LOCK_TOOL_AUTHORITY.mint(event.id, lockToolPayloadHash(event.payload));
    const result = appendAsTool(db, [event], WORKCOPY_TOOL_ACTOR, 'service');
    if (result.ok) return { ok: true };
    if (result.reason_code !== CODE.event_chain_broken && result.reason_code !== CODE.append_conflict) {
      return { ok: false, reason_code: result.reason_code ?? 'append_failed', message: result.message ?? '' };
    }
  }
  return { ok: false, reason_code: CODE.append_failed, message: 'append retry exhausted' };
}

export interface CardLockReleaseFailures {
  readonly prefix: string;
  readonly reason_code: string;
  readonly message: string;
}

export interface CardLockRelease {
  readonly ok: boolean;
  readonly released: number;
  readonly failures: readonly CardLockReleaseFailures[];
}

/**
 * 工具路径：卡收尾/准入后释放该卡持有的全部锁（第 3 轮 P2：内部构造工具身份，
 * 调用方不再传 session，也不给业务层伪造 service 的入口）。逐条失败不吞：返回
 * `{released, failures}`，由调用方上报结构化失败（第 3 轮 P3 / 第 4 轮 P2）。
 *
 * 仅 `src/db/workcopy.ts` 的收尾/准入路径调用；M4-2 接 `claim` 时把它收进能力边界
 * （D-153），不要再从业务层直接调用。
 */
export function releaseCardLocksAsTool(
  db: SdoDatabase,
  input: { card_id: string; at: string },
): CardLockRelease {
  let released = 0;
  const failures: CardLockReleaseFailures[] = [];
  for (const row of readActive(db)) {
    if (row.card_id !== input.card_id) continue;
    const appended = appendToolRelease(db, row.path_prefix, input.at);
    if (appended.ok) released += 1;
    else failures.push({ prefix: row.path_prefix, reason_code: appended.reason_code, message: appended.message });
  }
  return { ok: failures.length === 0, released, failures };
}

/** 当前是否有该前缀的活锁（调用方清理/断言用，只读）。 */
export function hasActiveLock(db: SdoDatabase, prefix: string): boolean {
  return readActive(db).some((row) => row.path_prefix === prefix);
}

/** 主树全局锁的 scope：`.` 规范化成根前缀（C7）。 */
export const MAIN_TREE_LOCK_PREFIX: unknown = '.';
export { ROOT_PREFIX };
