/**
 * 身份层 **迁移/CLI 初始化专用** 入口（M3-0 第 2 轮评审 P2-1）。
 *
 * 为什么单独一个文件：`enrollActor`/`grantRight` 是工具层 API，调用者必须持 `admin@domain`；
 * “第一个 admin 从哪来”不能靠调用方可传的 `bootstrap:true` 开关（那等于自证）。
 * 这里两个函数只能由迁移/CLI 初始化代码 import，**不导进工具层**；
 * 迁移 008 自身用 SQL 播种矩阵、不依赖本文件。
 *
 * 纪律：不得从 `src/query`、`src/core/pm`、`src/sign` 或任何事件写路径 import 本文件。
 */

import type { SdoDatabase } from './driver.js';
import { RIGHT_NAMES } from '../core/auth/matrix.js';
import { parseScope } from '../core/auth/rights.js';
import { isActorKind } from '../core/auth/session.js';
import type { AuthFailureResult, AuthResult, EnrollActorInput, GrantRightInput } from './auth.js';

function fail(reason_code: 'invalid_field' | 'no_permission', message: string): AuthFailureResult {
  return { ok: false, reason_code, message };
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 仅迁移/CLI 初始化：登记第一个 actor（不检查调用者 admin）。 */
export function bootstrapEnrollActor(db: SdoDatabase, input: EnrollActorInput): AuthResult {
  if (!isNonEmptyText(input.actor) || input.actor.includes('*')) {
    return fail('invalid_field', 'actor 不能为空且不接受通配');
  }
  if (!isActorKind(input.kind)) return fail('invalid_field', `actor_kind 非法：${String(input.kind)}`);
  const existing = db.prepare('SELECT kind FROM actor WHERE id = ?').get(input.actor) as { kind?: string } | undefined;
  if (existing !== undefined) {
    if (existing.kind !== input.kind) return fail('invalid_field', `actor 已登记且 kind 不同：${input.actor}`);
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

/** 仅迁移/CLI 初始化：授予第一个 `admin@domain`（不检查调用者 admin）。 */
export function bootstrapGrantRight(db: SdoDatabase, input: GrantRightInput): AuthResult {
  if (!isNonEmptyText(input.actor) || !isNonEmptyText(input.granted_by)) {
    return fail('invalid_field', 'actor/granted_by 不能为空');
  }
  if (!isNonEmptyText(input.right) || !(RIGHT_NAMES as readonly string[]).includes(input.right)) {
    return fail('invalid_field', `未知/非法 right：${String(input.right)}`);
  }
  const scope = parseScope(input.scope);
  if (!scope.ok) return fail('invalid_field', scope.message);
  const actor = db.prepare('SELECT 1 AS one FROM actor WHERE id = ?').get(input.actor);
  if (actor === undefined) return fail('invalid_field', `actor 未登记：${input.actor}`);
  db.prepare(
    `INSERT INTO scope (actor, scope, right, granted_by, at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)
     ON CONFLICT(actor, scope, right) DO UPDATE SET granted_by = excluded.granted_by, at = excluded.at, revoked_at = NULL`,
  ).run(input.actor, input.scope, input.right, input.granted_by, input.at ?? new Date().toISOString());
  return { ok: true };
}
