/**
 * M4-7/C3：连续新起按事件序列折叠，不查任何“最后一行/最后一列”。
 * 从事件尾部向前扫：遇到同 actor 的 `agent.spawned` 累加，遇到同 actor 的
 * `agent.reused` 立即停止（计数归零）；其它事件忽略。
 *
 * actor 粒度取事件的 `actor`（派发者/写者）；被派发的 worker 记在 payload.actor，
 * 不参与连续新起判定（卡「待确认」项，见 M4-7）。
 */
import type { SpawnStreak } from './types.js';
import type { WindowEvent } from './window.js';

export const SPAWN_STREAK_THRESHOLD = 3;

function ordered(events: readonly WindowEvent[]): readonly WindowEvent[] {
  return events
    .slice()
    .sort((left, right) => {
      const byTime = Date.parse(left.at) - Date.parse(right.at);
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });
}

export function consecutiveSpawns(events: readonly WindowEvent[], actor: string): SpawnStreak | undefined {
  const sorted = ordered(events);
  let count = 0;
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const event = sorted[index]!;
    if (event.actor !== actor) continue;
    if (event.kind === 'agent.reused') break;
    if (event.kind === 'agent.spawned') {
      count += 1;
      lastAt ??= event.at;
      firstAt = event.at;
    }
  }
  if (count === 0 || firstAt === undefined || lastAt === undefined) return undefined;
  return { count, first_at: firstAt, last_at: lastAt };
}

/** 尾部连续新起恰好达到阈值（3）时返回 streak；第 4 次以后不重复触发。 */
export function spawnStreakTrigger(events: readonly WindowEvent[], actor: string): SpawnStreak | undefined {
  const streak = consecutiveSpawns(events, actor);
  return streak !== undefined && streak.count === SPAWN_STREAK_THRESHOLD ? streak : undefined;
}
