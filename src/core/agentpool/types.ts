/**
 * M4-7：代理池复用读数的纯类型。事件口径见 docs/12 §3 —— `new_reason` 只有三个
 * 冻结值（`no_idle_capable` / `context_irrelevant` / `watermark_exhausted`），
 * 代码不引入卡初稿的四个名字（D-192）。
 */

export const SPAWN_REASONS = [
  'no_idle_capable',
  'context_irrelevant',
  'watermark_exhausted',
] as const;

export type SpawnReason = (typeof SPAWN_REASONS)[number];

/** 池快照里一个空闲候选：复算 reason 所需的全部事实。 */
export interface IdleCandidate {
  readonly agent_id: string;
  readonly actor_id: string;
  readonly skills: readonly string[];
  /** 最近一次任务涉及的文件；缺记录视为空集（D-192 边界）。 */
  readonly last_task_files: readonly string[];
  /** 0..1 的上下文水位；watermark_exhausted 的比较对象。 */
  readonly watermark: number;
}

export interface PoolSnapshot {
  readonly idle: readonly IdleCandidate[];
  /** docs/12 §3 的 watermark 限值（0..1）。 */
  readonly watermark_limit: number;
}

export interface SpawnStreak {
  readonly count: number;
  readonly first_at: string;
  readonly last_at: string;
}
