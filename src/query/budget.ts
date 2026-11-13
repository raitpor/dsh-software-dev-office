/**
 * `sdo_query` 的预算常量 **唯一定义处**（M0-4，判据 C8）。
 *
 * 设计依据：docs/05 §7「预算常量（唯一定义处，别处只许引用）」。其它文件只允许
 * `import { MAX_RESULT_BYTES } from './budget.js'`，不得再写字面量；测试里同样引用
 * 这些常量而不是复制数字。
 */

/** 单次工具返回的最大 UTF-8 字节数（docs/05 §7：≤8KB；按整个 `QueryResult` 序列化后的字节计，含游标与 envelope）。 */
export const MAX_RESULT_BYTES = 8 * 1024;

/** 单次查询行数硬上限（docs/05 §7：≤500，可调）。视图自己的 `row_budget` 不得超过它。 */
export const MAX_ROWS_PER_QUERY = 500;

/** 每轮注入上下文的字符预算（docs/05 §7：≤1500 字符；M0 只登记，渲染层在 M2 接）。 */
export const MAX_INJECTION_CHARS_PER_ROUND = 1500;

/** `sdo_query` 的 P95 读预算（docs/02 §16：100 万事件库 <50ms）。 */
export const SDO_QUERY_P95_MS = 50;
