/**
 * M3-0 · 身份层存储（迁移 008 的三张表）。
 *
 * 表口径（卡 C1；docs/02 §4「权限：scope right membership」）：
 * - `actor`      ：谁（kind ∈ human/agent/service，由会话凭据决定）
 * - `scope`      ：membership + grant（`actor` 在某个 scope 持哪些 `right`；撤销留痕 `revoked_at`）
 * - `right`      ：docs/07 §2 的**决策权矩阵目录**（动作 → 所需权/可自签/可双人），数据行由迁移 008 播种
 *
 * 判定不在这里写 if：本模块只加载数据并调用 `src/core/auth/rights.ts` 的 `hasRight`。
 * 不抛裸错给调用方：写操作返回结构化 `{ok:false, reason_code}`。
 */

import type { SdoDatabase } from './driver.js';
import {
  RIGHT_NAMES,
  type DualHuman,
  type MatrixEntry,
  type RequiredRight,
} from '../core/auth/matrix.js';
import {
  hasRight as decideRight,
  parseScope,
  type ActorRef,
  type GrantView,
  type RightDecision,
  type RightDeny,
  type ScopeOwn,
} from '../core/auth/rights.js';
import { isActorKind, writeIdentity, type ActorKind, type AuthFailure, type Session } from '../core/auth/session.js';

export type AuthReason = 'invalid_field' | 'no_permission';

export interface AuthFailureResult {
  readonly ok: false;
  readonly reason_code: AuthReason;
  readonly message: string;
}

export type AuthResult = { readonly ok: true } | AuthFailureResult;

/** 调用者上下文：身份层自己的写路径也必须有授权（不能“谁都能给自己发权”）。 */
export interface AuthActorContext {
  readonly by?: ActorRef;
}

export interface EnrollActorInput {
  readonly actor: string;
  readonly kind: ActorKind;
  readonly display?: string;
  readonly at?: string;
}

export interface GrantRightInput {
  readonly actor: string;
  readonly right: string;
  readonly scope: string;
  readonly granted_by: string;
  readonly at?: string;
}

function fail(reason_code: AuthReason, message: string): AuthFailureResult {
  return { ok: false, reason_code, message };
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function actorExists(db: SdoDatabase, actor: string): boolean {
  return db.prepare('SELECT 1 AS one FROM actor WHERE id = ?').get(actor) !== undefined;
}

/** 身份层自己的写路径：调用者必须持未撤销的 `admin@domain:*`（没有任何豁免；bootstrap 走独立内部文件）。 */
function requireDomainAdmin(db: SdoDatabase, auth: AuthActorContext, what: string): AuthFailureResult | undefined {
  const by = auth.by;
  if (by === undefined || typeof by.id !== 'string' || by.id.length === 0) {
    return fail('no_permission', `${what}需要调用者身份（admin@domain）`);
  }
  const row = db
    .prepare(
      "SELECT 1 AS one FROM scope WHERE actor = ? AND right = 'admin' AND revoked_at IS NULL AND scope LIKE 'domain:%' LIMIT 1",
    )
    .get(by.id);
  if (row === undefined) return fail('no_permission', `${what}需要调用者持 admin@domain（${by.id}）`);
  return undefined;
}

/** 登记 actor；同 id 重复登记按幂等 no-op 处理（kind 变化 ⇒ invalid_field）。 */
export function enrollActor(db: SdoDatabase, input: EnrollActorInput, auth: AuthActorContext): AuthResult {
  const authorized = requireDomainAdmin(db, auth, '登记 actor');
  if (authorized !== undefined) return authorized;
  if (!isNonEmptyText(input.actor)) return fail('invalid_field', 'actor 不能为空');
  if (input.actor.includes('*')) return fail('invalid_field', 'actor 不接受通配');
  if (!isActorKind(input.kind)) return fail('invalid_field', `actor_kind 非法：${String(input.kind)}`);
  const existing = db.prepare('SELECT kind FROM actor WHERE id = ?').get(input.actor) as { kind?: string } | undefined;
  if (existing !== undefined) {
    if (existing.kind !== input.kind) {
      return fail('invalid_field', `actor 已登记且 kind 不同：${input.actor}（${String(existing.kind)} ≠ ${input.kind}）`);
    }
    return { ok: true };
  }
  db.prepare('INSERT INTO actor (id, kind, display, at) VALUES (?, ?, ?, ?)').run(
    input.actor,
    input.kind,
    input.display ?? null,
    input.at ?? new Date().toISOString(),
  );
  return { ok: true };
}

/** 授权：`actor` 在 `scope` 持 `right`。通配一律拒（卡 C6），撤销行重新授权则复位 `revoked_at`。 */
export function grantRight(db: SdoDatabase, input: GrantRightInput, auth: AuthActorContext): AuthResult {
  const authorized = requireDomainAdmin(db, auth, '授权');
  if (authorized !== undefined) return authorized;
  if (!isNonEmptyText(input.actor)) return fail('invalid_field', 'actor 不能为空');
  if (!isNonEmptyText(input.granted_by)) return fail('invalid_field', 'granted_by 不能为空');
  if (!isNonEmptyText(input.right) || !(RIGHT_NAMES as readonly string[]).includes(input.right)) {
    return fail('invalid_field', `未知/非法 right：${String(input.right)}`);
  }
  const scope = parseScope(input.scope);
  if (!scope.ok) return fail(scope.reason_code === 'no_permission' ? 'invalid_field' : 'invalid_field', scope.message);
  if (!actorExists(db, input.actor)) return fail('invalid_field', `actor 未登记：${input.actor}`);
  db.prepare(
    `INSERT INTO scope (actor, scope, right, granted_by, at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(actor, scope, right) DO UPDATE SET granted_by = excluded.granted_by, at = excluded.at, revoked_at = NULL`,
  ).run(input.actor, input.scope, input.right, input.granted_by, input.at ?? new Date().toISOString());
  return { ok: true };
}

function parseRequired(raw: unknown): readonly RequiredRight[] {
  if (!Array.isArray(raw)) throw new Error('right.required 不是数组（迁移 008 数据损坏）');
  return raw.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const right = record['right'];
    const scope = record['scope'];
    if (typeof right !== 'string' || !(RIGHT_NAMES as readonly string[]).includes(right)) {
      throw new Error(`right.required 含非法权名：${String(right)}`);
    }
    if (scope !== 'module' && scope !== 'domain' && scope !== 'release' && scope !== 'scope') {
      throw new Error(`right.required 含非法 scope 占位：${String(scope)}`);
    }
    if (right.includes('*')) throw new Error('right.required 含通配');
    return { right: right as RequiredRight['right'], scope };
  });
}

/** 读矩阵目录（数据行来自迁移 008；docs 漂移由 `test/db/auth.test.ts` 机器比对）。 */
export function readMatrix(db: SdoDatabase): MatrixEntry[] {
  const rows = db
    .prepare(
      'SELECT action, required, self_sign, dual_human, boot_only, doc_row, doc_label FROM right ORDER BY doc_row, action',
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    action: String(row['action']),
    required: parseRequired(JSON.parse(String(row['required']))),
    self_sign: row['self_sign'] === null ? null : Number(row['self_sign']) === 1,
    dual_human: String(row['dual_human']) as DualHuman,
    boot_only: Number(row['boot_only']) === 1,
    doc_row: Number(row['doc_row']),
    doc_label: String(row['doc_label']),
  }));
}

export function readGrants(db: SdoDatabase, actor: string): GrantView[] {
  const rows = db
    .prepare('SELECT actor, right, scope, revoked_at FROM scope WHERE actor = ? ORDER BY scope, right')
    .all(actor) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    actor: String(row['actor']),
    right: String(row['right']),
    scope: String(row['scope']),
    revoked_at: row['revoked_at'] === null ? null : String(row['revoked_at']),
  }));
}

/** 读 `scope_owns` 归属边（迁移 013）：M3-1 C9 的跨前缀判定数据。 */
export function readScopeOwns(db: SdoDatabase): ScopeOwn[] {
  const rows = db
    .prepare('SELECT child_scope, parent_scope FROM scope_owns ORDER BY child_scope, parent_scope')
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    child_scope: String(row['child_scope']),
    parent_scope: String(row['parent_scope']),
  }));
}

/** 产品代码唯一权限判定入口（卡 C4）：加载目录 + 该 actor 的 grant + 归属边，委托纯函数 `hasRight`。 */
export function hasRight(db: SdoDatabase, actor: ActorRef, action: string, scope: string): RightDecision {
  return decideRight(actor, action, scope, {
    matrix: readMatrix(db),
    grants: readGrants(db, actor.id),
    ownership: readScopeOwns(db),
  });
}

export type WriteAuthorization = { readonly ok: true; readonly actor: ActorRef } | AuthFailure | RightDeny;

/**
 * 写路径组合入口：先拒 payload 自称 actor（C3），再判权（C4/C5）。
 * 调用方（M3 各动作）必须走这里，不得自己拼身份或自己比较 right 字符串。
 */
export function authorizeWrite(
  db: SdoDatabase,
  session: Session,
  payload: unknown,
  action: string,
  scope: string,
): WriteAuthorization {
  const identity = writeIdentity(session, payload);
  if (!identity.ok) return identity;
  const decision = hasRight(db, { id: identity.actor, kind: identity.actor_kind }, action, scope);
  return decision.ok ? { ok: true, actor: { id: identity.actor, kind: identity.actor_kind } } : decision;
}
