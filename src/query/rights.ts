/**
 * 读权限：`min_right` 裁剪（M0-4，判据 C3）。
 *
 * 设计依据：docs/05 §6「权限裁剪（读也要最小权限）」与 §13「无权限显示需要 X 权限」。
 * 层级本身在 `src/views/catalog.ts` 的 `RIGHT_LEVELS` 单点定义，这里只做解析与比较。
 */

import { RIGHT_LEVELS, type Right } from '../views/catalog.js';

export type { Right };

/** 默认按最低权限读（fail-closed：调用方不给 right 时绝不能放宽）。 */
export const DEFAULT_RIGHT: Right = 'reader';

/** 运行时校验调用方声明的权限；未知值直接抛错（调用方 bug，不是用户输入）。 */
export function resolveRight(value: unknown): Right {
  if (value === undefined) return DEFAULT_RIGHT;
  if (typeof value === 'string' && Object.hasOwn(RIGHT_LEVELS, value)) {
    return value as Right;
  }
  throw new Error(`sdo_query: unknown right "${String(value)}"`);
}

/** 当前权限是否够读某视图的 `min_right`。 */
export function canRead(minRight: Right, right: Right): boolean {
  return RIGHT_LEVELS[minRight] <= RIGHT_LEVELS[right];
}
