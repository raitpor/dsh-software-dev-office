/**
 * 结构化 `miss` 与 `MissSink`（M0-4，判据 C3/C7）。
 *
 * 设计依据：docs/05 §5「缺工具由使用记录决定」、§6「权限裁剪」、§16 不变式 5。
 *
 * **本卡不写 `query_miss` 事件**（假设 A1）：写事件需要 hash 链/prev/frontier，属 M1 写网关；
 * 这里只产出结构化 miss 并交给 `MissSink`，M1 把默认实现换成真事件写入。
 */

/** 缺什么、为什么缺；新增 reason 必须同时写进 `src/query/README.md`。 */
export type MissReason =
  | 'view_not_found'
  | 'column_not_found'
  | 'invalid_args'
  | 'filtered_by_permission'
  | 'stale_as_of'
  | 'unsafe_view_sql'
  | 'result_too_large';

/** 一条结构化 miss（docs/05 §5 的 payload 形状；task/actor 由 M1 写网关补）。 */
export interface QueryMiss {
  readonly reason: MissReason;
  readonly view: string;
  readonly hint?: string;
  readonly detail?: string;
}

/** miss 的去处；M0 默认 no-op，M1 接真实 `query_miss` 事件写入。 */
export interface MissSink {
  record(miss: QueryMiss): void;
}

/** 默认 sink：不写任何东西（假设 A1 / P6 默认）。 */
export const NOOP_MISS_SINK: MissSink = {
  record(): void {
    // 故意为空：M0 不落事件，只返回结构化 miss。
  },
};

export function createMiss(
  reason: MissReason,
  view: string,
  hint?: string,
  detail?: string,
): QueryMiss {
  const miss: QueryMiss = { reason, view };
  return {
    ...miss,
    ...(hint === undefined ? {} : { hint }),
    ...(detail === undefined ? {} : { detail }),
  };
}
