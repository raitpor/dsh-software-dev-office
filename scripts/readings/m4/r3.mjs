/**
 * M4-G / C3 · R3 连续 3 次新起 ⇒ gaps 有 spawn_streak（count≥3）；2 次 ⇒ 无。
 *
 * 两个场景各自新库；产品路径 task.created → dispatchLease → recordAgentSpawn。
 * 变异：`M4_G_MUTATION=R3` 把判定阈值改成 4 ⇒ 3 次场景变红（两向都验）。
 */
import { rmSync } from 'node:fs';

import { dispatchLease } from '../../../lib/src/db/lease.js';
import { recordAgentSpawn } from '../../../lib/src/db/agent.js';
import { appendSeeds, FIXTURE_SESSION, openFixtureDb, taskSeed, T0, tmpDbPath } from './helpers.mjs';

const CARD = 'CARD-M4G-R3';
const EMPTY_SNAPSHOT = { idle: [], watermark_limit: 0.7 };
const at = (seconds) => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const mutation = process.env['M4_G_MUTATION'] === 'R3';
const threshold = mutation ? 4 : 3;

function runScenario(spawns) {
  const { dir, path } = tmpDbPath(`r3-${spawns}`);
  let db;
  try {
    db = openFixtureDb(path);
    appendSeeds(db, [taskSeed(CARD, ['src/agent/'])]);
    const lease = dispatchLease(db, FIXTURE_SESSION, { card: CARD, actor: 'worker-r3', scope: 'module:core', at: at(1) });
    if (!lease.ok) throw new Error(`dispatchLease failed: ${lease.reason_code} ${lease.message ?? ''}`);
    for (let index = 0; index < spawns; index += 1) {
      const spawned = recordAgentSpawn(db, FIXTURE_SESSION, {
        card: CARD,
        actor: `worker-spawn-${index}`,
        dispatch_id: lease.lease_id,
        new_reason: 'no_idle_capable',
        required_skills: ['implement'],
        snapshot: EMPTY_SNAPSHOT,
        at: at(2 + index),
      });
      if (!spawned.ok) throw new Error(`recordAgentSpawn failed: ${spawned.reason_code} ${spawned.message ?? ''}`);
    }
    const rows = db
      .prepare("SELECT kind, subject, count FROM gaps WHERE kind = 'spawn_streak' ORDER BY subject")
      .all();
    const maxCount = rows.reduce((max, row) => Math.max(max, Number(row.count)), 0);
    return {
      spawns,
      gaps_rows: rows,
      max_spawn_streak_count: maxCount,
      spawned_events: db.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'agent.spawned'").get().n,
    };
  } finally {
    if (db !== undefined) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function r3() {
  const three = runScenario(3);
  const two = runScenario(2);
  const pass = three.max_spawn_streak_count >= threshold && two.gaps_rows.length === 0;

  return {
    id: 'R3',
    question: '同一 actor 连续 3 次新起是否进 gaps.spawn_streak（count≥3），2 次是否不告警？',
    command: 'node scripts/m4-readings.mjs --only R3',
    measured: {
      threshold,
      three_spawns: three,
      two_spawns: two,
      mutation: mutation ? 'threshold-4' : null,
    },
    verdict: pass ? 'pass' : 'fail',
    caveat: pass
      ? '两个场景各自临时库；gaps 行由 agent.spawn_streak 事件投影现算，两向（3 次有、2 次无）都验。'
      : mutation
        ? '变异把阈值改成 4：3 次新起场景不再满足 count≥阈值 ⇒ 判据红，证明不是写死 pass。'
        : '不达标：3 次场景无 count≥3 的 gaps 行，或 2 次场景错误告警。',
  };
}
