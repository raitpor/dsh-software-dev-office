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

/** `scope_owns` 的一行：child 沿 parent 链归属（M3-1 C9，迁移 013）。 */
export interface ScopeOwn {
  readonly child_scope: string;
  readonly parent_scope: string;
}

export interface RightContext {
  readonly matrix: readonly MatrixEntry[];
  readonly grants: readonly GrantView[];
  /** 归属边；缺省视为空表（所有跨前缀判定 fail-closed 为 `no_ownership`）。 */
  readonly ownership?: readonly ScopeOwn[];
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
  readonly reason?:
    | 'cross_prefix_denied'
    | 'no_ownership'
    | 'unknown_action'
    | 'unknown_prefix'
    | 'boot_only'
    | 'missing_grant';
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

/** 单个 right 在目标 scope 上的 grant 覆盖判定（与 `hasRight` 内部同一套规则，供读权等级复用）。 */
export function hasGrantedRight(
  actor: ActorRef,
  right: RightName,
  scope: string,
  ctx: Pick<RightContext, 'grants' | 'ownership'>,
): boolean {
  const parsed = parseScope(scope);
  if (!parsed.ok) return false;
  return ctx.grants.some((grant) => {
    if (grant.actor !== actor.id) return false;
    if (grant.revoked_at !== null) return false;
    if (grant.right !== right) return false;
    return scopeCovers(grant.scope, scope);
  });
}

/**
 * 沿 `scope_owns` 把 child scope 的祖先全部找出（BFS，去自环/重复）。
 * 只做数据解释，不做判定——判定在 `hasRight` 里（卡 C9：归属表是数据，不猜前缀）。
 */
export function ownershipAncestors(scope: string, ownership: readonly ScopeOwn[]): readonly string[] {
  const seen = new Set<string>([scope]);
  const queue = [scope];
  const ancestors: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const edge of ownership) {
      if (edge.child_scope !== current) continue;
      if (seen.has(edge.parent_scope)) continue;
      seen.add(edge.parent_scope);
      ancestors.push(edge.parent_scope);
      queue.push(edge.parent_scope);
    }
  }
  return ancestors;
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
    const crossPrefix = required.scope !== 'scope' && required.scope !== parsed.value.prefix;
    // 跨前缀时，先沿归属链把目标 scope 的祖先找出来；只有祖先里出现 required.scope 的前缀才可判。
    // （D-086：不猜 module→domain 映射；M3-1 C9 用显式 scope_owns 链放开。）
    const ancestors = crossPrefix ? ownershipAncestors(scope, ctx.ownership ?? []) : [];
    const candidateScopes = crossPrefix
      ? ancestors.filter((candidate) => {
          const ancestor = parseScope(candidate);
          return ancestor.ok && ancestor.value.prefix === required.scope;
        })
      : [scope];
    const ownedCandidates = required.scope === 'scope'
      ? candidateScopes
      : candidateScopes.filter((candidate) => {
          const c = parseScope(candidate);
          return c.ok && c.value.prefix === required.scope;
        });
    const granted = ctx.grants.some((grant) => {
      if (grant.actor !== actor.id) return false;
      if (grant.revoked_at !== null) return false;
      if (grant.right !== required.right) return false;
      if (ownedCandidates.length === 0) return false;
      return ownedCandidates.some((candidate) => scopeCovers(grant.scope, candidate));
    });
    if (!granted) {
      const noOwnership = crossPrefix && ownedCandidates.length === 0;
      return {
        ...deny(
          'no_permission',
          actor,
          action,
          scope,
          noOwnership
            ? `无归属：${action} 需要 ${required.right}@${required.scope}，但 ${scope} 没有通向 ${required.scope}:… 的 scope_owns 链（fail-closed）`
            : `缺少权 ${required.right}@${required.scope}（scope ${scope}）`,
          required.right,
        ),
        reason: noOwnership ? 'no_ownership' : 'missing_grant',
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
