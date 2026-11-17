import assert from 'node:assert/strict';
import { test } from 'node:test';

import { consecutiveSpawns, spawnStreakTrigger } from '../../../src/core/agentpool/streak.js';
import type { WindowEvent } from '../../../src/core/agentpool/window.js';

const spawn = (id: string, at: string, actor = 'lead'): WindowEvent => ({
  id,
  at,
  actor,
  kind: 'agent.spawned',
  subject: 'CARD-1',
  payload: {},
});
const reuse = (id: string, at: string, actor = 'lead'): WindowEvent => ({
  id,
  at,
  actor,
  kind: 'agent.reused',
  subject: 'CARD-1',
  payload: {},
});

test('C3: 2 consecutive spawns do not trigger; the 3rd does', () => {
  assert.equal(consecutiveSpawns([spawn('s1', '2026-11-17T10:00:01Z'), spawn('s2', '2026-11-17T10:00:02Z')], 'lead')?.count, 2);
  assert.equal(
    spawnStreakTrigger([spawn('s1', '2026-11-17T10:00:01Z'), spawn('s2', '2026-11-17T10:00:02Z')], 'lead'),
    undefined,
  );
  const events = [spawn('s1', '2026-11-17T10:00:01Z'), spawn('s2', '2026-11-17T10:00:02Z'), spawn('s3', '2026-11-17T10:00:03Z')];
  assert.deepEqual(spawnStreakTrigger(events, 'lead'), {
    count: 3,
    first_at: '2026-11-17T10:00:01Z',
    last_at: '2026-11-17T10:00:03Z',
  });
});

test('C3: a reused event resets the streak; other actors do not count', () => {
  const events = [
    spawn('s1', '2026-11-17T10:00:01Z'),
    spawn('s2', '2026-11-17T10:00:02Z'),
    reuse('r1', '2026-11-17T10:00:03Z'),
    spawn('s3', '2026-11-17T10:00:04Z'),
  ];
  assert.equal(consecutiveSpawns(events, 'lead')?.count, 1);
  assert.equal(spawnStreakTrigger(events, 'lead'), undefined);
  const otherActor = [spawn('s1', '2026-11-17T10:00:01Z', 'bot'), spawn('s2', '2026-11-17T10:00:02Z', 'bot')];
  assert.equal(consecutiveSpawns(otherActor, 'lead'), undefined);
});

test('C3: 4th spawn does not re-trigger (warn once per streak)', () => {
  const events = ['s1', 's2', 's3', 's4'].map((id, index) => spawn(id, `2026-11-17T10:00:0${index + 1}Z`));
  assert.equal(consecutiveSpawns(events, 'lead')?.count, 4);
  assert.equal(spawnStreakTrigger(events, 'lead'), undefined);
});

test('P3: same-timestamp events are ordered by event id', () => {
  const sameAt = '2026-11-17T10:00:01Z';
  // id order puts the spawn before the reuse; a string-only (non-tie-broken) order could reverse it.
  // Input order is deliberately reversed: only id tie-breaking puts the spawn before the reuse.
  const events = [reuse('ev-b', sameAt), spawn('ev-a', sameAt)];
  assert.equal(consecutiveSpawns(events, 'lead'), undefined);
});
