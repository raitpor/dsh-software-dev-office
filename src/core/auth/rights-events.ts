/**
 * M4-4 · `right.granted` / `right.revoked` 事件入口（收口 D-113）。
 *
 * 纪律（Lead m04509 A1/A2）：
 * - 两个 kind 是 **ACK**（不动 fold 物化表 TABLE_NAMES），`scope` 行的唯一生产者是
 *   本模块的投影：`src/db/write.ts` 在 append 事务内、COMMIT 前调用 `applyRightEvents`。
 *   直改 `scope` 表不会被物化抹掉，但会被 `src/core/verify-rights.ts` 对账抓出来。
 * - 事件形状固定：`right.granted{grantee,right,scope,granted_by}`、
 *   `right.revoked{grantee,right,scope,revoked_by,reason?}`；**subject = grantee**。
 * - 撤销不删行：只写 `revoked_at`/`revoked_by`；重新授予清空两列。
 * - 裸 append（不经过 `grantRight`/`revokeRight`/`backfillGrants`）由写网关的一次性
 *   能力拦成 `unauthorized_right_change`（能力绑 event id + payload hash）。
 *
 * 本文件是纯函数 + 进程内一次性能力表；不 import `node:fs`/数据库。
 */

import { canonicalJson } from '../fold/canonical.js';
import { RIGHT_NAMES } from './matrix.js';
import { parseScope } from './rights.js';

export const RIGHT_GRANTED = 'right.granted';
export const RIGHT_REVOKED = 'right.revoked';
export const RIGHT_CHANGE_KINDS: readonly string[] = Object.freeze([RIGHT_GRANTED, RIGHT_REVOKED]);

export interface RightGrantedPayload {
  readonly grantee: string;
  readonly right: string;
  readonly scope: string;
  readonly granted_by: string;
  /** 背填标记：事件来自旧库 `scope` 行的对齐，不是新授权动作。 */
  readonly legacy?: boolean;
}

export interface RightRevokedPayload {
  readonly grantee: string;
  readonly right: string;
  readonly scope: string;
  readonly revoked_by: string;
  readonly reason?: string;
  readonly legacy?: boolean;
}

export type RightChangePayload = RightGrantedPayload | RightRevokedPayload;

export interface ParsedRightChange {
  readonly kind: typeof RIGHT_GRANTED | typeof RIGHT_REVOKED;
  readonly payload: RightChangePayload;
  readonly key: string;
}

export interface RightChangeParseFailure {
  readonly ok: false;
  readonly message: string;
}

export type RightChangeParseResult = { readonly ok: true; readonly value: ParsedRightChange } | RightChangeParseFailure;

export function rightRowKey(actor: string, scope: string, right: string): string {
  return `${actor}|${scope}|${right}`;
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRightName(value: string): boolean {
  return (RIGHT_NAMES as readonly string[]).includes(value);
}

/** 把事件 payload（对象或 JSON 字符串）解析成严格形状；非法 ⇒ `{ok:false}`（写网关拒）。 */
export function parseRightChangeEvent(kind: string, raw: unknown): RightChangeParseResult {
  let payload: unknown = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      return { ok: false, message: `${kind} payload is not valid JSON` };
    }
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, message: `${kind} payload must be an object` };
  }
  const record = payload as Record<string, unknown>;
  if (kind !== RIGHT_GRANTED && kind !== RIGHT_REVOKED) {
    return { ok: false, message: `not a right change kind: ${kind}` };
  }
  const grantee = record['grantee'];
  const right = record['right'];
  const scope = record['scope'];
  if (!isNonEmptyText(grantee)) return { ok: false, message: `${kind} payload.grantee must be a non-empty string` };
  if (grantee.includes('*')) return { ok: false, message: `${kind} payload.grantee must not contain '*'` };
  if (!isNonEmptyText(right) || !isRightName(right)) {
    return { ok: false, message: `${kind} payload.right must be one of the design rights` };
  }
  if (!isNonEmptyText(scope) || scope.includes('*')) {
    return { ok: false, message: `${kind} payload.scope must be a concrete scope (no '*')` };
  }
  const parsedScope = parseScope(scope);
  if (!parsedScope.ok) return { ok: false, message: `${kind} payload.scope: ${parsedScope.message}` };
  const byField = kind === RIGHT_GRANTED ? 'granted_by' : 'revoked_by';
  const by = record[byField];
  if (!isNonEmptyText(by)) return { ok: false, message: `${kind} payload.${byField} must be a non-empty string` };
  const legacy = record['legacy'];
  if (legacy !== undefined && typeof legacy !== 'boolean') {
    return { ok: false, message: `${kind} payload.legacy must be a boolean when present` };
  }
  const reason = record['reason'];
  if (reason !== undefined && typeof reason !== 'string') {
    return { ok: false, message: `${kind} payload.reason must be a string when present` };
  }
  if (kind === RIGHT_REVOKED && record['granted_by'] !== undefined) {
    return { ok: false, message: 'right.revoked payload must not carry granted_by (revoked_by only)' };
  }
  const value: ParsedRightChange =
    kind === RIGHT_GRANTED
      ? {
          kind,
          payload: {
            grantee,
            right,
            scope,
            granted_by: by,
            ...(legacy === true ? { legacy: true } : {}),
          },
          key: rightRowKey(grantee, scope, right),
        }
      : {
          kind,
          payload: {
            grantee,
            right,
            scope,
            revoked_by: by,
            ...(typeof reason === 'string' ? { reason } : {}),
            ...(legacy === true ? { legacy: true } : {}),
          },
          key: rightRowKey(grantee, scope, right),
        };
  return { ok: true, value };
}

/** 能力绑定的内容摘要（写网关消费能力时重算；与事件 payload 的 canonical JSON 一一对应）。 */
export function rightChangePayloadHash(payload: unknown): string {
  return canonicalJson(payload ?? null);
}

/**
 * A2：撤销/授予的**授权 scope** 推导——`domain:X` ⇒ 自身；
 * `module:*` / `release:*` ⇒ `domain:core`（复用矩阵既有 `config` 动作，不加 docs/07 行）。
 */
export function rightChangeAuthorizationScope(scope: string): string {
  const parsed = parseScope(scope);
  if (!parsed.ok) return '';
  return parsed.value.prefix === 'domain' ? scope : 'domain:core';
}

// ── 一次性能力（进程内；进程重启后残留能力自然失效） ────────────────────────────

const granted = new Map<string, string>();

/** 由 `src/db/auth.ts` 在授权通过后铸造：绑 (event id, payload hash)，只能消费一次。 */
export function mintRightChangeAuthority(eventId: string, payloadHash: string): void {
  granted.set(eventId, payloadHash);
}

/** 写网关消费：id 与 hash 都对上才放行；无论成败都删除（一次性）。 */
export function consumeRightChangeAuthority(eventId: string, payloadHash: string): boolean {
  const expected = granted.get(eventId);
  granted.delete(eventId);
  return expected !== undefined && expected === payloadHash;
}

/** 测试/维护面：清空未消费能力（不用于产品路径）。 */
export function clearRightChangeAuthorities(): void {
  granted.clear();
}

// ── 投影（纯函数；verify 与 append 事务内共用同一实现） ───────────────────────

export interface RightProjectionRow {
  readonly actor: string;
  readonly scope: string;
  readonly right: string;
  readonly granted_by: string;
  readonly at: string;
  readonly revoked_at: string | null;
  readonly revoked_by: string | null;
}

export interface RightProjection {
  readonly rows: Map<string, RightProjectionRow>;
  readonly problems: readonly string[];
}

/** 事件流 → scope 行投影。`right.revoked` 必须先有 `right.granted`（否则记 problem）。 */
export function projectRightEvents(events: readonly { kind: string; at: string; payload: unknown }[]): RightProjection {
  const rows = new Map<string, RightProjectionRow>();
  const problems: string[] = [];
  for (const event of events) {
    if (!RIGHT_CHANGE_KINDS.includes(event.kind)) continue;
    const parsed = parseRightChangeEvent(event.kind, event.payload);
    if (!parsed.ok) {
      problems.push(`${event.kind}@${event.at}: ${parsed.message}`);
      continue;
    }
    const { value } = parsed;
    if (value.kind === RIGHT_GRANTED) {
      const payload = value.payload as RightGrantedPayload;
      rows.set(value.key, {
        actor: payload.grantee,
        scope: payload.scope,
        right: payload.right,
        granted_by: payload.granted_by,
        at: event.at,
        revoked_at: null,
        revoked_by: null,
      });
    } else {
      const payload = value.payload as RightRevokedPayload;
      const existing = rows.get(value.key);
      if (existing === undefined) {
        problems.push(`${event.kind}@${event.at}: ${value.key} has no prior right.granted`);
        continue;
      }
      if (existing.revoked_at === null) {
        rows.set(value.key, { ...existing, revoked_at: event.at, revoked_by: payload.revoked_by });
      }
    }
  }
  return { rows, problems };
}
