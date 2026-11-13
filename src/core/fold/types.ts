/**
 * fold 的输入/输出类型（M0-2）。
 * 真源：docs/02 §10 事件信封、§11 事件类型、§12 折叠；表形状见 docs/03 + 支撑表。
 * 纯类型：无 I/O，无时钟。
 */

/** docs/02 §10 的事件信封。`payload` 保持在未知态，由各 kind 的 reducer 收窄。 */
export interface Event {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly kind: string;
  readonly subject: string;
  readonly payload: unknown;
  readonly caused_by: readonly string[];
  readonly request_id: string;
  readonly prev: string;
  readonly hash: string;
}

/** 34 张物化表 = docs/03 的 25 + 支撑 9（与 migrations/001_init.sql 一致）。 */
export const TABLE_NAMES = [
  'decision',
  'baseline',
  'task',
  'intent',
  'snapshot',
  'snapshot_parent',
  'scenario',
  'spec',
  'criterion',
  'criterion_fixture',
  'evidence',
  'design_lock',
  'redteam',
  'restatement',
  'restatement_diff',
  'claim',
  'receipt',
  'field_consumer',
  'scope_decl',
  'goal_node',
  'integration',
  'work_unit',
  'stage_run',
  'attention',
  'report',
  'review_round',
  'review',
  'verify_run',
  'config',
  'event_kind',
  'event',
  'defect',
  'release',
  'release_item',
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

/** 一行物化数据。写侧只增不改 / 改由 reducer 产出新对象。 */
export type Row = Readonly<Record<string, unknown>>;

/** docs/03:77：`(kind,id,hash)` 的派生边；hash 用 fold 行规范化序列化算。 */
export interface InputEdge {
  readonly kind: string;
  readonly id: string;
  readonly hash: string;
}

/**
 * fold 的输出：不可变快照。
 * 同串事件同一顺序 ⇒ 同一 FoldState（`JSON.stringify` / `stableStringify` 逐字节相同）。
 */
export interface FoldState {
  /** 已应用事件 id，按应用顺序（幂等与增量折叠的游标）。 */
  readonly eventIds: readonly string[];
  /** 已应用事件 id 的集合（重复投递直接跳过）。 */
  readonly seen: Readonly<Record<string, true>>;
  readonly tables: Readonly<Record<TableName, Readonly<Record<string, Row>>>>;
  /** assumption/restatement 的 inputs 边：owner id → 边列表（判定失效传播用）。 */
  readonly inputs: Readonly<Record<string, readonly InputEdge[]>>;
  /** 已落过的失效键 `owner|inputId|oldHash`（同一对只落一次）。 */
  readonly invalidatedKeys: readonly string[];
}

/** fold 内部可变工作副本；只在单次 fold 调用内存在，不暴露。 */
export interface FoldWorking {
  eventIds: string[];
  seen: Record<string, true>;
  tables: Record<TableName, Record<string, Row>>;
  inputs: Record<string, InputEdge[]>;
  invalidatedKeys: string[];
  invalidatedSeen: Record<string, true>;
}
