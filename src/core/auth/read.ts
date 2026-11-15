/**
 * 视图级读权映射（M3-1 C1）。
 *
 * 文档未定义「读权 scope」：`view_catalog` 只有 `min_right`，没有 scope 列。
 * 本文件把「看视图需要哪种权」写成一张**表**（Lead 2026-11-15 裁定），
 * 判定只读 membership（`scope` 表未撤销的 grant），不猜 scope 前缀：
 *
 *   min_right=reader   ⇐ 任一未撤销的 `read` grant   ⇒ 视图可读
 *   min_right=reviewer ⇐ 任一未撤销的 `review` grant ⇒ 可读 review 级视图
 *   min_right=decider  ⇐ 任一未撤销的 `decide` grant ⇒ 可读决策级视图
 *   min_right=signer   ⇐ 任一未撤销的 `sign` grant   ⇒ 可读签字级视图
 *
 * 为什么按「权存在」而不是按 scope 覆盖：视图 SQL 跨多张表（task/spec/release…），
 * 没有单一的视图 scope 可覆盖；按视图级取 actor 的最高权，行级再用 owner 例外。
 * 单域假设（D-101）：M4 多域要按 `domain`/`module` 的 `scope_owns` 链分别判定。
 */

import { hasGrantedRight, type GrantView, type ScopeOwn } from './rights.js';
import type { RightName } from './matrix.js';
import type { Right } from '../../views/catalog.js';

/** min_right（视图目录列）→ 需要的 right（docs/02 §4 membership 的 right 名）。 */
export const MIN_RIGHT_TO_RIGHT: Readonly<Record<Right, string>> = {
  reader: 'read',
  reviewer: 'review',
  decider: 'decide',
  signer: 'sign',
};

/** 层级从低到高；用于取 actor 的「最高可读级别」。 */
const RIGHT_ORDER: readonly Right[] = ['reader', 'reviewer', 'decider', 'signer'];

/**
 * actor 的视图级可读级别：取他已持权里最高的那一级；一条权都没有 ⇒ undefined（fail-closed）。
 * 只认未撤销的 grant；同一 right 在哪个 scope 都算（单域假设，见文件头 D-101）。
 */
/** 读权判定的 scope（D-101 单域假设；M4 多域再走 scope_owns 链细分）。 */
export const READ_SCOPE = 'domain:core';

/**
 * actor 的视图级可读级别。判定复用 `hasGrantedRight`——与写路径 `hasRight` 同一套
 * grant 覆盖规则（撤销、scope 覆盖、前缀），不再自建第二套 membership 循环。
 */
export function viewRightFor(
  actor: string,
  ctx: { readonly grants: readonly GrantView[]; readonly ownership?: readonly ScopeOwn[] },
): Right | undefined {
  const ref = { id: actor, kind: 'human' as const };
  for (let index = RIGHT_ORDER.length - 1; index >= 0; index -= 1) {
    const level = RIGHT_ORDER[index] as Right;
    const right = MIN_RIGHT_TO_RIGHT[level] as RightName;
    if (hasGrantedRight(ref, right, READ_SCOPE, { grants: ctx.grants, ownership: ctx.ownership ?? [] })) return level;
  }
  return undefined;
}

/** 该级别是否够读某视图的最小权限（与 `src/query/rights.ts` 的 canRead 同义，避免循环依赖）。 */
export function levelCovers(level: Right, minRight: Right): boolean {
  return RIGHT_ORDER.indexOf(level) >= RIGHT_ORDER.indexOf(minRight);
}
