/**
 * `sdo_query` 公共入口（M0-4）。实现细节：
 *
 * - `execute.ts`：唯一执行路径（目录 SQL 子查询）+ 权限/预算/游标；
 * - `budget.ts`：8KB / 500 行 / 1500 字符 / P95 常量的**唯一定义处**（C8）；
 * - `cursor.ts`：不透明 base64url 游标（C5）；
 * - `rights.ts`：`min_right` 裁剪（C3）；
 * - `miss.ts`：结构化 miss 与 `MissSink`（C3/C7；事件写入属 M1）。
 */

export { query } from './execute.js';
export type { Frontier, QueryArgs, QueryContext, QueryResult, Row } from './execute.js';

export {
  MAX_INJECTION_CHARS_PER_ROUND,
  MAX_RESULT_BYTES,
  MAX_ROWS_PER_QUERY,
  SDO_QUERY_P95_MS,
} from './budget.js';

export { createMiss, NOOP_MISS_SINK } from './miss.js';
export type { MissReason, MissSink, QueryMiss } from './miss.js';

export { canRead, DEFAULT_RIGHT, resolveRight } from './rights.js';
export type { Right } from './rights.js';

export type { CursorArgs, CursorPayload } from './cursor.js';
export { decodeCursor, encodeCursor, sameCursorArgs } from './cursor.js';
