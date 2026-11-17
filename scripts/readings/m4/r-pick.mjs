/**
 * M4-7 / C6 · 复用读数：从事件流现算
 *   - 一次派发内 `agent.pick_declined` 的条数（≤1 达标）
 *   - 同一 actor 连续新起次数（≥3 且 gaps 有 spawn_streak 行 ⇒ 告警可见）
 *   - C1 复算拒绝次数（池里有可用候选却报 no_idle_capable ⇒ 必须被拒）
 *
 * 变异点：把 `PICK_DECLINES_IN_DISPATCH` 改成 2 ⇒ verdict 必须变 fail。
 */
import { withWriteDb, chain } from '../../../lib/test/db/append-helpers.js';
import { appendAs } from '../../../lib/test/db/append-auth.js';
import { dispatchLease } from '../../../lib/src/db/lease.js';
import {
  agentWindowEvents,
  recordAgentPickDeclined,
  recordAgentReused,
  recordAgentSpawn,
} from '../../../lib/src/db/agent.js';
import { dispatchWindow, pickDeclinedInWindow } from '../../../lib/src/core/agentpool/window.js';
import { consecutiveSpawns } from '../../../lib/src/core/agentpool/streak.js';
import { reusableCandidates } from '../../../lib/src/core/agentpool/snapshot.js';

export const PICK_DECLINES_IN_DISPATCH = 1;
const CARD = 'CARD-M4G-RPICK';
const T0 = '2026-11-17T10:00:00.000Z';
const tmp = (seconds) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const session = { actor: 'fixture-root', actor_kind: 'service' };

const EMPTY_SNAPSHOT = { idle: [], watermark_limit: 0.7 };
const IDLE_SNAPSHOT = {
  idle: [
    {
      agent_id: 'agent-alpha',
      actor_id: 'worker-alpha',
      skills: ['implement'],
      last_task_files: ['src/other/'],
      watermark: 0.2,
    },
  ],
  watermark_limit: 0.7,
};

export async function rPick() {
  const measured = { scenario: 'one dispatch with 1 decline; reuse for idle; 3 spawns; 1 rejected reason', max_pick_declined_per_dispatch: 0, rejections: 0 };
  withWriteDb((db) => {
    const seeds = chain([
      {
        id: `ev-rpick-task-${T0}`,
        at: T0,
        actor: 'fixture-root',
        kind: 'task.created',
        subject: CARD,
        payload: { seq: 9901, title: 'r-pick fixture', kind: 'implement', status: 'planned', scope_paths: ['src/agent/'] },
        caused_by: [],
        request_id: 'r-pick-task',
      },
    ]);
    appendAs(db, seeds);

    const lease = dispatchLease(db, session, { card: CARD, actor: 'worker-a', scope: 'module:core', at: tmp(1) });
    if (!lease.ok) throw new Error(`dispatchLease failed: ${lease.reason_code} ${lease.message}`);
    const dispatchId = lease.lease_id;
    for (let index = 0; index < PICK_DECLINES_IN_DISPATCH; index += 1) {
      recordAgentPickDeclined(db, session, { card: CARD, dispatch_id: dispatchId, reason: 'busy', at: tmp(2 + index) });
    }
    recordAgentReused(db, session, { card: CARD, actor: 'worker-alpha', agent_id: 'agent-alpha', dispatch_id: dispatchId, at: tmp(4) });
    const spawnAt = [5, 6, 7];
    for (const second of spawnAt) {
      recordAgentSpawn(db, session, {
        card: CARD,
        actor: `worker-${second}`,
        dispatch_id: dispatchId,
        new_reason: 'no_idle_capable',
        required_skills: ['implement'],
        snapshot: EMPTY_SNAPSHOT,
        at: tmp(second),
      });
    }
    // C1 复算：池里明明有可用候选，却报 no_idle_capable ⇒ 必须拒。
    const rejected = recordAgentSpawn(db, session, {
      card: CARD,
      actor: 'worker-bogus',
      dispatch_id: dispatchId,
      new_reason: 'no_idle_capable',
      required_skills: ['implement'],
      snapshot: IDLE_SNAPSHOT,
      at: tmp(8),
    });
    measured.rejections = rejected.ok ? 0 : 1;
    measured.rejected_reason = rejected.ok ? null : rejected.reason_code;

    const events = agentWindowEvents(db);
    for (const event of events.filter((item) => item.kind === 'lease.issued')) {
      const window = dispatchWindow(events, event.id);
      if (!window.ok) continue;
      measured.max_pick_declined_per_dispatch = Math.max(
        measured.max_pick_declined_per_dispatch,
        pickDeclinedInWindow(events, window.window),
      );
    }
    measured.max_consecutive_spawns = consecutiveSpawns(events, session.actor)?.count ?? 0;
    measured.gaps_rows = db
      .prepare("SELECT kind, subject, count FROM gaps WHERE kind IN ('pick_declined_streak','spawn_streak') ORDER BY kind, subject")
      .all();
    measured.idle_candidates = reusableCandidates(IDLE_SNAPSHOT, ['implement']).map((candidate) => candidate.agent_id);
  });

  const streakWarningVisible = measured.gaps_rows.some((row) => row.kind === 'spawn_streak' && row.count >= 3);
  const pass =
    measured.max_pick_declined_per_dispatch <= 1 && streakWarningVisible && measured.rejections >= 1;
  return {
    id: 'R-pick',
    question: '一次派发 pick_declined ≤1、连续 3 次新起进 gaps、C1 矛盾理由被拒？',
    command: 'node scripts/m4-readings.mjs --only R-pick',
    measured,
    verdict: pass ? 'pass' : 'fail',
    caveat: pass
      ? '样本来自真写入的临时库；pick_declined 条数由事件流现算（window=lease.issued→lease 终态）。'
      : '读数不达标：见 measured（declines>1 / 无 spawn_streak 告警 / C1 未拒）。',
  };
}
