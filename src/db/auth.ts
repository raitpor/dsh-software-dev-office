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

import { randomUUID } from 'node:crypto';

import type { SdoDatabase } from './driver.js';
import type { Event } from '../core/fold/types.js';
import { buildEvent } from './freeze-store.js';
import { append, chainHead } from './write.js';
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
import {
  mintRightChangeAuthority,
  parseRightChangeEvent,
  projectRightEvents,
  RIGHT_GRANTED,
  RIGHT_REVOKED,
  rightChangeAuthorizationScope,
  rightChangePayloadHash,
  rightRowKey,
  type RightGrantedPayload,
  type RightRevokedPayload,
} from '../core/auth/rights-events.js';

export type AuthReason = 'invalid_field' | 'no_permission' | 'last_admin_right' | 'write_failed';

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
  /** 仅作断言：必须等于会话 actor；真正的 `granted_by` 从会话派生（P1-1，防栽赃）。 */
  readonly granted_by?: string;
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

export interface RevokeRightInput {
  readonly actor: string;
  readonly right: string;
  readonly scope: string;
  /** 仅作断言：必须等于会话 actor；真正的 `revoked_by` 从会话派生（P1-1，防栽赃）。 */
  readonly revoked_by?: string;
  readonly reason?: string;
  readonly at?: string;
}

function rightChangeAuthScope(scope: string): string | undefined {
  return rightChangeAuthorizationScope(scope);
}

/** A2：授予/撤销都复用矩阵既有 `config` 动作（admin@domain），scope 按被操作 scope 推导。 */
function requireRightChangeAuthority(
  db: SdoDatabase,
  auth: AuthActorContext,
  scope: string,
  what: string,
): AuthFailureResult | undefined {
  const by = auth.by;
  if (by === undefined || !isNonEmptyText(by.id)) {
    return fail('no_permission', `${what}需要调用者身份（config@domain）`);
  }
  const authScope = rightChangeAuthScope(scope);
  if (authScope === undefined) return fail('invalid_field', `${what}的 scope 非法：${scope}`);
  const decision = hasRight(db, { id: by.id, kind: by.kind }, 'config', authScope);
  if (!decision.ok) {
    return fail('no_permission', `${what}需要 ${by.id} 持 config@domain（被操作 scope=${scope} ⇒ 授权 scope=${authScope}）`);
  }
  return undefined;
}

/** 事件 payload 里的执行人 = 会话 actor（写网关要求 event.actor === session.actor）。 */
function appendRightChange(
  db: SdoDatabase,
  session: AuthActorContext,
  kind: typeof RIGHT_GRANTED | typeof RIGHT_REVOKED,
  subject: string,
  payload: RightGrantedPayload | RightRevokedPayload,
  at: string,
): AuthResult {
  const by = session.by;
  if (by === undefined) return fail('no_permission', '写路径需要调用者身份');
  const event: Event = buildEvent(
    {
      id: randomUUID(),
      at,
      actor: by.id,
      kind,
      subject,
      payload,
      caused_by: [],
      request_id: `right:${subject}:${payload.scope}:${payload.right}`,
    },
    chainHead(db),
  );
  mintRightChangeAuthority(event.id, rightChangePayloadHash(payload));
  const result = append(db, [event], { session: { actor: by.id, actor_kind: by.kind } });
  if (!result.ok) {
    return fail(
      result.reason_code === 'invalid_field' || result.reason_code === 'no_permission'
        ? result.reason_code
        : 'write_failed',
      result.message ?? String(result.reason_code),
    );
  }
  return { ok: true };
}

/**
 * 授权：`actor` 在 `scope` 持 `right`（M4-4：唯一写入口是 `right.granted` 事件）。
 * 通配一律拒（卡 C6）；重复授予按事件重放（投影幂等复位 `revoked_at`）。
 */
export function grantRight(db: SdoDatabase, input: GrantRightInput, auth: AuthActorContext): AuthResult {
  if (!isNonEmptyText(input.actor)) return fail('invalid_field', 'actor 不能为空');
  const operator = auth.by?.id;
  if (operator === undefined || operator.length === 0) return fail('no_permission', '授权需要调用者身份');
  if (input.granted_by !== undefined && input.granted_by !== operator) {
    return fail('invalid_field', `granted_by 必须等于当前会话 actor（${operator}）`);
  }
  if (!isNonEmptyText(input.right) || !(RIGHT_NAMES as readonly string[]).includes(input.right)) {
    return fail('invalid_field', `未知/非法 right：${String(input.right)}`);
  }
  const scope = parseScope(input.scope);
  if (!scope.ok) return fail('invalid_field', scope.message);
  const authorized = requireRightChangeAuthority(db, auth, input.scope, '授权');
  if (authorized !== undefined) return authorized;
  if (!actorExists(db, input.actor)) return fail('invalid_field', `actor 未登记：${input.actor}`);
  return appendRightChange(
    db,
    auth,
    RIGHT_GRANTED,
    input.actor,
    {
      grantee: input.actor,
      right: input.right,
      scope: input.scope,
      granted_by: operator,
    },
    input.at ?? new Date().toISOString(),
  );
}

/**
 * 撤权：不删行，只写 `revoked_at`/`revoked_by`（事件是唯一生产者）。
 * 不能撤掉该 domain 最后一个 admin 权（`last_admin_right`，0 事件）；
 * 重复撤销已撤销的权 ⇒ 幂等 no-op（不再补事件）。
 */
export function revokeRight(db: SdoDatabase, input: RevokeRightInput, auth: AuthActorContext): AuthResult {
  if (!isNonEmptyText(input.actor)) return fail('invalid_field', 'actor 不能为空');
  const operator = auth.by?.id;
  if (operator === undefined || operator.length === 0) return fail('no_permission', '撤权需要调用者身份');
  if (input.revoked_by !== undefined && input.revoked_by !== operator) {
    return fail('invalid_field', `revoked_by 必须等于当前会话 actor（${operator}）`);
  }
  if (!isNonEmptyText(input.right) || !(RIGHT_NAMES as readonly string[]).includes(input.right)) {
    return fail('invalid_field', `未知/非法 right：${String(input.right)}`);
  }
  const scope = parseScope(input.scope);
  if (!scope.ok) return fail('invalid_field', scope.message);
  const authorized = requireRightChangeAuthority(db, auth, input.scope, '撤权');
  if (authorized !== undefined) return authorized;
  if (!actorExists(db, input.actor)) return fail('invalid_field', `actor 未登记：${input.actor}`);
  const row = db
    .prepare('SELECT granted_by, at, revoked_at FROM scope WHERE actor = ? AND scope = ? AND right = ?')
    .get(input.actor, input.scope, input.right) as { granted_by?: string; at?: string; revoked_at?: string | null } | undefined;
  if (row === undefined) return fail('invalid_field', `没有可撤销的授权：${input.actor} ${input.right}@${input.scope}`);
  if (row.revoked_at !== null) return { ok: true };
  if (input.right === 'admin' && scope.value.prefix === 'domain') {
    const others = db
      .prepare(
        "SELECT 1 AS one FROM scope WHERE right = 'admin' AND revoked_at IS NULL AND actor <> ? AND scope = ? LIMIT 1",
      )
      .get(input.actor, input.scope);
    if (others === undefined) {
      return fail('last_admin_right', `拒绝撤销 ${input.scope} 上最后一个 admin 权（${input.actor}）`);
    }
  }
  return appendRightChange(
    db,
    auth,
    RIGHT_REVOKED,
    input.actor,
    {
      grantee: input.actor,
      right: input.right,
      scope: input.scope,
      revoked_by: operator,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
    input.at ?? new Date().toISOString(),
  );
}

// ── M4-4：`scope` 行的投影（append 事务内调用；verify 从同一事件流复算） ─────────

/**
 * 把本批 `right.*` 事件投影进 `scope` 表（不删行：撤销只更新 `revoked_at/revoked_by`）。
 * 放在物化之后、COMMIT 之前；抛错 ⇒ `append` 整批 ROLLBACK。
 */
export function applyRightEvents(db: SdoDatabase, events: readonly Event[]): void {
  const relevant = events.filter((event) => event.kind === RIGHT_GRANTED || event.kind === RIGHT_REVOKED);
  if (relevant.length === 0) return;
  const upsertGrant = db.prepare(
    `INSERT INTO scope (actor, scope, right, granted_by, at, revoked_at, revoked_by)
     VALUES (?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(actor, scope, right) DO UPDATE SET
       granted_by = excluded.granted_by, at = excluded.at, revoked_at = NULL, revoked_by = NULL`,
  );
  const markRevoked = db.prepare(
    'UPDATE scope SET revoked_at = ?, revoked_by = ? WHERE actor = ? AND scope = ? AND right = ?',
  );
  const readRow = db.prepare('SELECT revoked_at FROM scope WHERE actor = ? AND scope = ? AND right = ?');
  for (const event of relevant) {
    const parsed = parseRightChangeEvent(event.kind, event.payload);
    if (!parsed.ok) throw new Error(parsed.message);
    const { value } = parsed;
    if (value.kind === RIGHT_GRANTED) {
      const payload = value.payload as RightGrantedPayload;
      upsertGrant.run(payload.grantee, payload.scope, payload.right, payload.granted_by, event.at);
      continue;
    }
    const payload = value.payload as RightRevokedPayload;
    const existing = readRow.get(payload.grantee, payload.scope, payload.right) as { revoked_at?: string | null } | undefined;
    if (existing === undefined) {
      throw new Error(`${RIGHT_REVOKED} ${oldKey(value.payload as RightRevokedPayload)} has no prior ${RIGHT_GRANTED}`);
    }
    if (existing.revoked_at !== null) continue;
    markRevoked.run(event.at, payload.revoked_by, payload.grantee, payload.scope, payload.right);
  }
}

function oldKey(payload: RightRevokedPayload): string {
  return rightRowKey(payload.grantee, payload.scope, payload.right);
}

/** 从事件流复算 `scope` 行（verify 与 `backfillGrants` 共用）。 */
export function projectedRightRows(events: readonly Event[]): ReturnType<typeof projectRightEvents> {
  return projectRightEvents(
    events.map((event) => ({ kind: event.kind, at: event.at, payload: event.payload })),
  );
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
