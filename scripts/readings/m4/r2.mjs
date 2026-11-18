/**
 * M4-G / C2 · R2 一次派发内 `agent.pick_declined` ≤ 1。
 *
 * 走产品路径：task.created → dispatchLease → recordAgentPickDeclined → 事件流现算窗口。
 * 变异：`M4_G_MUTATION=R2` 造 2 条 ⇒ verdict 必须 fail。
 */
import { rmSync } from 'node:fs';

import { dispatchLease } from '../../../lib/src/db/lease.js';
import { agentWindowEvents, recordAgentPickDeclined } from '../../../lib/src/db/agent.js';
import { dispatchWindow, pickDeclinedInWindow } from '../../../lib/src/core/agentpool/window.js';
import { FIXTURE_SESSION, openFixtureDb, taskSeed, T0, tmpDbPath, appendSeeds } from './helpers.mjs';

const CARD = 'CARD-M4G-R2';
const mutation = process.env['M4_G_MUTATION'] === 'R2';
const declines = mutation ? 2 : 1;
const at = (seconds) => new Date(Date.parse(T0) + seconds * 1000).toISOString();

export async function r2() {
  const { dir, path } = tmpDbPath('r2');
  let db;
  try {
    db = openFixtureDb(path);
    appendSeeds(db, [taskSeed(CARD, ['src/agent/'])]);
    const lease = dispatchLease(db, FIXTURE_SESSION, { card: CARD, actor: 'worker-r2', scope: 'module:core', at: at(1) });
    if (!lease.ok) throw new Error(`dispatchLease failed: ${lease.reason_code} ${lease.message ?? ''}`);
    for (let index = 0; index < declines; index += 1) {
      const recorded = recordAgentPickDeclined(db, FIXTURE_SESSION, {
        card: CARD,
        dispatch_id: lease.lease_id,
        reason: 'busy',
        at: at(2 + index),
      });
      if (!recorded.ok) throw new Error(`recordAgentPickDeclined failed: ${recorded.reason_code}`);
    }
    const events = agentWindowEvents(db);
    const window = dispatchWindow(events, lease.lease_id);
    if (!window.ok) throw new Error(`dispatchWindow failed: ${window.message}`);
    const count = pickDeclinedInWindow(events, window.window);
    const pass = count <= 1;

    return {
      id: 'R2',
      question: '一次派发内 agent.pick_declined 是否 ≤ 1 条（dispatch 区间 + 计数）？',
      command: 'node scripts/m4-readings.mjs --only R2',
      measured: {
        dispatch_id: lease.lease_id,
        dispatch_window: { from: window.window.from, until: window.window.until ?? null, closed_by: window.window.closed_by ?? null },
        pick_declined_in_dispatch: count,
        max_allowed: 1,
        mutation: mutation ? 'two-declines' : null,
      },
      verdict: pass ? 'pass' : 'fail',
      caveat: pass
        ? '窗口 = lease.issued → lease 终态/卡收尾；计数由事件流现算，不读脚本自己累加的变量。'
        : '变异造 2 条 pick_declined 后计数为 2：证明判据会红，不是把常量当读数。',
    };
  } finally {
    if (db !== undefined) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
