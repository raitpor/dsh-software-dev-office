/**
 * M3-0 · 唯一权限判定入口 `hasRight`（卡 C4/C5/C6）。
 *
 * 判定顺序（全部 fail-closed，无默认 allow）：
 *   1. 形状与通配检查（空值 / `*` ⇒ `invalid_field`）
 *   2. scope 形状（`<prefix>:<path>`）与已知前缀（未知前缀 ⇒ `no_permission`）
 *   3. 动作必须在矩阵目录里（未登记 ⇒ `no_permission`）
 *   4. 逐条所需权：必须有覆盖目标 scope 且未撤销的 grant（缺 ⇒ `no_permission`）
 *
 * 本模块是纯函数：grants / matrix 由调用方（`src/db/auth.ts`）加载后传入。
 */

import type { ActorKind } from './session.js';
import type { DualHuman, MatrixEntry, RequiredRight, RightName, ScopePrefix } from './matrix.js';
import { RIGHT_NAMES, SCOPE_PREFIXES } from './matrix.js';

export interface ActorRef {
  readonly id: string;
  readonly kind: ActorKind;
}

/** `scope` 表的行视图（membership + grant：某 actor 在某 scope 持某权）。 */
export interface GrantView {
  readonly actor: string;
  readonly right: string;
  readonly scope: string;
  readonly revoked_at: string | null;
}

export interface RightContext {
  readonly matrix: readonly MatrixEntry[];
  readonly grants: readonly GrantView[];
}

export interface RightAllow {
  readonly ok: true;
  readonly action: string;
  readonly scope: string;
  readonly required: readonly RequiredRight[];
  readonly self_sign: boolean | null;
  readonly dual_human: DualHuman;
}

export type RightDenyCode = 'no_permission' | 'invalid_field';

export interface RightDeny {
  readonly ok: false;
  readonly reason_code: RightDenyCode;
  readonly action: string;
  readonly scope: string;
  readonly actor_kind: ActorKind;
  readonly message: string;
  readonly missing_right?: RightName;
  /** 失败原因细分（如跨前缀拒绝）；保留 reason_code 供调用方粗判。 */
  readonly reason?: 'cross_prefix_denied' | 'unknown_action' | 'unknown_prefix' | 'boot_only' | 'missing_grant';
}

export type RightDecision = RightAllow | RightDeny;

export interface ParsedScope {
  readonly prefix: ScopePrefix;
  readonly path: string;
}

const RIGHT_SET = new Set<string>(RIGHT_NAMES);
const PREFIX_SET = new Set<string>(SCOPE_PREFIXES);

export function isRightName(value: string): value is RightName {
  return RIGHT_SET.has(value);
}

export interface ScopeParseFailure {
  readonly ok: false;
  readonly reason_code: RightDenyCode;
  readonly message: string;
}

/** 解析 `<prefix>:<path>`；通配/空/含空白 ⇒ invalid_field，未知前缀 ⇒ no_permission。 */
export function parseScope(scope: string): { readonly ok: true; readonly value: ParsedScope } | ScopeParseFailure {
  if (typeof scope !== 'string' || scope.length === 0) {
    return { ok: false, reason_code: 'invalid_field', message: 'scope 不能为空' };
  }
  if (scope.includes('*')) {
    return { ok: false, reason_code: 'invalid_field', message: `scope 不接受通配：${scope}` };
  }
  if (/\s/.test(scope)) {
    return { ok: false, reason_code: 'invalid_field', message: `scope 不得含空白：${scope}` };
  }
  const match = /^([a-z]+):(.+)$/.exec(scope);
  if (match === null) {
    return { ok: false, reason_code: 'invalid_field', message: `scope 形状必须是 <prefix>:<path>：${scope}` };
  }
  const prefix = match[1] ?? '';
  const path = match[2] ?? '';
  if (!PREFIX_SET.has(prefix)) {
    return { ok: false, reason_code: 'no_permission', message: `未知 scope 前缀：${prefix}` };
  }
  if (path.startsWith('/') || path.endsWith('/')) {
    return { ok: false, reason_code: 'invalid_field', message: `scope 路径不得以 / 开头或结尾：${scope}` };
  }
  return { ok: true, value: { prefix: prefix as ScopePrefix, path } };
}

/** grant 的 scope 是否覆盖目标 scope：同前缀且路径按 `/` 边界前缀匹配（卡 A1）。 */
export function scopeCovers(grantScope: string, targetScope: string): boolean {
  if (grantScope === targetScope) return true;
  const grant = parseScope(grantScope);
  const target = parseScope(targetScope);
  if (!grant.ok || !target.ok) return false;
  if (grant.value.prefix !== target.value.prefix) return false;
  return target.value.path.startsWith(`${grant.value.path}/`);
}

function deny(
  code: RightDenyCode,
  actor: ActorRef,
  action: string,
  scope: string,
  message: string,
  missingRight?: RightName,
): RightDeny {
  const base = { ok: false as const, reason_code: code, action, scope, actor_kind: actor.kind, message };
  return missingRight === undefined ? base : { ...base, missing_right: missingRight };
}

/**
 * 产品代码唯一的权限判定入口（卡 C4）。
 * 返回结构化的 `{ok:false, reason_code, action, scope, actor_kind}`，不抛裸错。
 */
export function hasRight(actor: ActorRef, action: string, scope: string, ctx: RightContext): RightDecision {
  if (typeof action !== 'string' || action.length === 0) {
    return deny('invalid_field', actor, action, scope, 'action 不能为空');
  }
  if (action.includes('*')) {
    return deny('invalid_field', actor, action, scope, `动作不接受通配：${action}`);
  }
  if (typeof actor.id !== 'string' || actor.id.length === 0) {
    return deny('invalid_field', actor, action, scope, 'actor 不能为空');
  }
  if (actor.id.includes('*')) {
    return deny('invalid_field', actor, action, scope, `actor 不接受通配：${actor.id}`);
  }
  const parsed = parseScope(scope);
  if (!parsed.ok) return { ...deny(parsed.reason_code, actor, action, scope, parsed.message), reason: 'unknown_prefix' };

  const entry = ctx.matrix.find((row) => row.action === action);
  if (entry === undefined) {
    return { ...deny('no_permission', actor, action, scope, `未登记动作：${action}（矩阵即数据，未登记一律拒）`), reason: 'unknown_action' };
  }
  if (entry.boot_only && actor.id !== 'migration') {
    return deny('no_permission', actor, action, scope, `${action} 是迁移 boot 动作，只允许 boot 系统 actor`);
  }
  for (const required of entry.required) {
    const granted = ctx.grants.some((grant) => {
      if (grant.actor !== actor.id) return false;
      if (grant.revoked_at !== null) return false;
      if (grant.right !== required.right) return false;
      const grantScope = parseScope(grant.scope);
      if (!grantScope.ok) return false;
      // 同前缀（module/release/目标自身）：grant 必须覆盖目标 scope。
      // 跨前缀（如 dependencies 需要 plan@domain 而目标是 module:…）：没有归属解析就**一律拒**
      // （D-086：不猜 module→domain 映射；M3-1 引入 membership 解析后再放开）。
      if (required.scope !== 'scope' && required.scope !== parsed.value.prefix) {
        return false;
      }
      if (required.scope === 'scope' && grantScope.value.prefix !== parsed.value.prefix) {
        return false;
      }
      return scopeCovers(grant.scope, scope);
    });
    if (!granted) {
      const crossPrefix = required.scope !== 'scope' && required.scope !== parsed.value.prefix;
      return {
        ...deny(
          'no_permission',
          actor,
          action,
          scope,
          crossPrefix
            ? `跨前缀拒绝：${action} 需要 ${required.right}@${required.scope}，但目标 scope 是 ${parsed.value.prefix}:…（D-086，不猜归属）`
            : `缺少权 ${required.right}@${required.scope}（scope ${scope}）`,
          required.right,
        ),
        reason: crossPrefix ? 'cross_prefix_denied' : 'missing_grant',
      };
    }
  }
  return {
    ok: true,
    action,
    scope,
    required: entry.required,
    self_sign: entry.self_sign,
    dual_human: entry.dual_human,
  };
}
