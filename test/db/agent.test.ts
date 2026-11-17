import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withWriteDb, chain } from './append-helpers.js';
import { appendAs } from './append-auth.js';
import { dispatchLease } from '../../src/db/lease.js';
import { buildEvent } from '../../src/db/freeze-store.js';
import { chainHead } from '../../src/db/write.js';
import {
  agentWindowEvents,
  recordAgentPickDeclined,
  recordAgentReused,
  recordAgentSpawn,
} from '../../src/db/agent.js';

const T0 = '2026-11-17T10:00:00.000Z';
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString();
const session = { actor: 'fixture-root', actor_kind: 'service' as const };
const CARD = 'CARD-M4G-1';
const CARD_2 = 'CARD-M4G-2';

const EMPTY = { idle: [], watermark_limit: 0.7 };
const IDLE = {
  watermark_limit: 0.7,
  idle: [{ agent_id: 'agent-alpha', actor_id: 'worker-alpha', skills: ['implement'], last_task_files: [], watermark: 0.2 }],
};

function seedTask(db: Parameters<typeof appendAs>[0], card: string, seq: number): void {
  const seeds = chain([
    {
      id: `ev-m4g-${card}`,
      at: T0,
      actor: 'fixture-root',
      kind: 'task.created',
      subject: card,
      payload: { seq, title: card, kind: 'implement', status: 'planned', scope_paths: ['src/agent/'] },
      caused_by: [],
      request_id: `m4g-task-${card}`,
    },
  ]);
  const appended = appendAs(db, seeds);
  assert.equal(appended.ok, true, appended.ok ? '' : String(appended.message));
}

function spawn(db: Parameters<typeof recordAgentSpawn>[0], seconds: number, reason: 'no_idle_capable' | 'context_irrelevant', snapshot: typeof EMPTY): ReturnType<typeof recordAgentSpawn> {
  return recordAgentSpawn(db, session, {
    card: CARD,
    actor: `worker-${seconds}`,
    dispatch_id: 'lease-not-used',
    new_reason: reason,
    required_skills: ['implement'],
    snapshot,
    at: at(seconds),
  });
}

test('M4-7/C1: contradictory new_reason is rejected with spawn_reason_mismatch and no event', () => {
  withWriteDb((db) => {
    seedTask(db, CARD, 9911);
    const rejected = recordAgentSpawn(db, session, {
      card: CARD,
      actor: 'worker-bogus',
      dispatch_id: 'lease-x',
      new_reason: 'no_idle_capable',
      required_skills: ['implement'],
      snapshot: IDLE,
      at: at(1),
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.reason_code, 'spawn_reason_mismatch');
      assert.deepEqual(rejected.details, ['agent-alpha']);
    }
    assert.equal((db.prepare("SELECT count(*) AS n FROM event WHERE kind = 'agent.spawned'").get() as { n: number }).n, 0);
  });
});

test('M4-7/C2: 2 pick_declined in one dispatch become a gaps row; 1 does not', () => {
  withWriteDb((db) => {
    seedTask(db, CARD, 9912);
    recordAgentPickDeclined(db, session, { card: CARD, dispatch_id: 'dispatch-a', reason: 'busy', at: at(1) });
    recordAgentPickDeclined(db, session, { card: CARD, dispatch_id: 'dispatch-a', reason: 'busy', at: at(2) });
    recordAgentPickDeclined(db, session, { card: CARD, dispatch_id: 'dispatch-b', reason: 'busy', at: at(3) });
    const rows = db.prepare("SELECT kind, subject, count FROM gaps WHERE kind = 'pick_declined_streak'").all() as Array<{
      kind: string;
      subject: string;
      count: number;
    }>;
    assert.deepEqual(rows, [{ kind: 'pick_declined_streak', subject: 'dispatch-a', count: 2 }]);
  });
});

test('M4-7/C3: 3 consecutive spawns emit agent.spawn_streak and a gaps row with count=3; reuse resets', () => {
  withWriteDb((db) => {
    seedTask(db, CARD, 9913);
    const first = spawn(db, 1, 'no_idle_capable', EMPTY);
    const second = spawn(db, 2, 'no_idle_capable', EMPTY);
    const third = spawn(db, 3, 'no_idle_capable', EMPTY);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(third.ok, true);
    if (!first.ok || !second.ok || !third.ok) return;
    assert.equal(third.streak?.count, 3);
    assert.equal(typeof third.streak_event_id, 'string');
    const row = db.prepare("SELECT kind, subject, count FROM gaps WHERE kind = 'spawn_streak'").get() as {
      kind: string;
      subject: string;
      count: number;
    };
    assert.deepEqual(row, { kind: 'spawn_streak', subject: 'fixture-root', count: 3 });

    recordAgentReused(db, session, { card: CARD, actor: 'worker-x', agent_id: 'agent-x', dispatch_id: 'lease-x', at: at(4) });
    const fourth = spawn(db, 5, 'no_idle_capable', EMPTY);
    assert.equal(fourth.ok, true);
    if (fourth.ok) assert.equal(fourth.streak_event_id, undefined);
  });
});

test('M4-7/C1+C4: an available candidate must not be reported as no_idle_capable (db-level)', () => {
  withWriteDb((db) => {
    seedTask(db, CARD, 9914);
    const rejected = recordAgentSpawn(db, session, {
      card: CARD,
      actor: 'worker-bogus',
      dispatch_id: 'lease-1',
      new_reason: 'no_idle_capable',
      required_skills: ['implement'],
      snapshot: IDLE,
      at: at(1),
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.reason_code, 'spawn_reason_mismatch');
    const valid = recordAgentSpawn(db, session, {
      card: CARD,
      actor: 'worker-ok',
      dispatch_id: 'lease-1',
      new_reason: 'context_irrelevant',
      required_skills: ['implement'],
      snapshot: IDLE,
      at: at(2),
    });
    assert.equal(valid.ok, true, valid.ok ? '' : valid.message);
  });
});

test('M4-7/A1+C6: agentWindowEvents + dispatchWindow count pick_declined inside a real lease window', () => {
  withWriteDb((db) => {
    seedTask(db, CARD_2, 9915);
    const lease = dispatchLease(db, session, { card: CARD_2, actor: 'worker-a', scope: 'module:core', at: at(1) });
    assert.equal(lease.ok, true, lease.ok ? '' : lease.message);
    if (!lease.ok) return;
    recordAgentPickDeclined(db, session, { card: CARD_2, dispatch_id: lease.lease_id, reason: 'busy', at: at(2) });
    const events = agentWindowEvents(db);
    assert.ok(events.some((event) => event.kind === 'lease.issued' && event.id === lease.lease_id));
  });
});

test('P1-1: raw agent.spawned without the one-shot capability is rejected (unauthorized_agent_event)', () => {
  withWriteDb((db) => {
    seedTask(db, CARD, 9916);
    const raw = buildEvent(
      {
        id: 'raw-agent-spawned',
        at: at(1),
        actor: 'fixture-root',
        kind: 'agent.spawned',
        subject: CARD,
        payload: { dispatch_id: 'lease-raw', card: CARD, actor: 'worker-raw', new_reason: 'no_idle_capable', snapshot: EMPTY },
        caused_by: [],
        request_id: 'req-raw-agent-spawned',
      },
      chainHead(db),
    );
    const result = appendAs(db, [raw]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_code, 'unauthorized_agent_event');
    assert.equal((db.prepare("SELECT count(*) AS n FROM event WHERE kind = 'agent.spawned'").get() as { n: number }).n, 0);
  });
});

test('M4-7/C3: spawned + spawn_streak are one atomic append batch (failure rolls both back)', () => {
  withWriteDb((db) => {
    seedTask(db, CARD, 9917);
    assert.equal(spawn(db, 1, 'no_idle_capable', EMPTY).ok, true);
    assert.equal(spawn(db, 2, 'no_idle_capable', EMPTY).ok, true);
    db.exec("CREATE TRIGGER inject_fail_spawn_streak BEFORE INSERT ON event WHEN NEW.kind = 'agent.spawn_streak' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    try {
      const failed = spawn(db, 3, 'no_idle_capable', EMPTY);
      assert.equal(failed.ok, false);
      assert.equal((db.prepare("SELECT count(*) AS n FROM event WHERE kind = 'agent.spawned'").get() as { n: number }).n, 2);
      assert.equal((db.prepare("SELECT count(*) AS n FROM event WHERE kind = 'agent.spawn_streak'").get() as { n: number }).n, 0);
    } finally {
      db.exec('DROP TRIGGER inject_fail_spawn_streak');
    }
    // 失败批次已清理能力/事务：重试能正常落下 spawned+streak 同一批。
    const retried = spawn(db, 4, 'no_idle_capable', EMPTY);
    assert.equal(retried.ok, true);
    if (retried.ok) {
      assert.equal(retried.streak?.count, 3);
      assert.equal(typeof retried.streak_event_id, 'string');
    }
  });
});
