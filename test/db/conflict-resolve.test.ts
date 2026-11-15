/**
 * M3-2 C4 正例：冲突裁决必须由人签 decision 驱动；agent 不能选边。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { append, chainHead } from '../../src/db/write.js';
import { verify } from '../../src/core/verify.js';
import { fold } from '../../src/core/fold/index.js';
import { readEvents } from '../../src/core/verify-events.js';
import { valueHash } from '../../src/core/conflict/hash.js';
import { conflictResolutionPayloadHash, readConflict, resolveConflict } from '../../src/db/conflict.js';
import { unlockSigner } from '../../src/sign/decision.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import type { Session } from '../../src/core/auth/session.js';
import { chain, seed } from './append-helpers.js';
import { bootSignerd, TEST_ACTOR, TEST_PASSPHRASE } from '../sign/helpers.js';
import { withMigratedDbAsync } from '../sign/page-helpers.js';

const SESSION: Session = {
  actor: TEST_ACTOR,
  actor_kind: 'human',
  session_id: 'sess-m3-2',
  credential: 'cred-test',
};

function setupConflict(db: SdoDatabase): string {
  const [created] = chain(
    [seed(10, 'task.created', 'TASK-1', { seq: 1, title: 't', kind: 'implement' })],
    chainHead(db),
  );
  if (created === undefined) throw new Error('event build failed');
  const createdResult = append(db, [created]);
  assert.equal(createdResult.ok, true, JSON.stringify(createdResult));
  const state = fold(undefined, readEvents(db, []));
  const task = state.tables.task['TASK-1'];
  if (task === undefined) throw new Error('TASK-1 missing');
  const base = valueHash(task['block_code'] ?? null);
  const [first] = chain(
    [seed(20, 'task.blocked', 'TASK-1', { block_code: 'upstream_changed', reason: 'a', field: 'block_code', base_hash: base, value: 'waiting' }, { actor: 'alice' })],
    chainHead(db),
  );
  if (first === undefined) throw new Error('event build failed');
  const firstResult = append(db, [first]);
  assert.equal(firstResult.ok, true, JSON.stringify(firstResult));
  const [stale] = chain(
    [seed(21, 'task.blocked', 'TASK-1', { block_code: 'upstream_changed', reason: 'b', field: 'block_code', base_hash: base, value: 'waiting' }, { actor: 'bob' })],
    chainHead(db),
  );
  if (stale === undefined) throw new Error('event build failed');
  const conflicted = append(db, [stale]);
  assert.equal(conflicted.reason_code, 'conflict', conflicted.message ?? 'expected conflict');
  return String(conflicted.conflict_id);
}

test('C4 positive: human-signed conflict_resolution closes the conflict and leaves a signed decision', async () => {
  await withMigratedDbAsync(async (db) => {
    const rig = await bootSignerd({ ttl: '5' });
    try {
      const conflictId = setupConflict(db);
      const before = readConflict(db, conflictId);
      assert.ok(before);
      const unlocked = await unlockSigner(db, rig.client, {
        actor: TEST_ACTOR,
        actor_kind: 'human',
        passphrase: TEST_PASSPHRASE,
        frontier: chainHead(db),
      });
      assert.equal(unlocked.ok, true, JSON.stringify(unlocked));

      {
        const evs = readEvents(db, []);
        console.log('DEBUG events', evs.map((e) => `${e.kind}:${e.subject}`).join(', '));
        const st = fold(undefined, evs);
        console.log('DEBUG conflict keys', Object.keys(st.tables.conflict), 'conflictId', conflictId);
      }
      const resolved = await resolveConflict(
        db,
        rig.client,
        {
          conflict_id: conflictId,
          payload_hash: conflictResolutionPayloadHash(conflictId, 'loser'),
          side: 'loser',
          note: 'bob based on the newer revision',
        },
        SESSION,
      );
      assert.equal(resolved.ok, true, JSON.stringify(resolved));
      const row = readConflict(db, conflictId);
      assert.equal(row?.status, 'resolved');
      assert.ok(row?.resolution_decision_id);
      assert.equal(row?.resolved_by, TEST_ACTOR);
      const decision = db.prepare('SELECT signature, payload FROM decision WHERE id = ?').get(row?.resolution_decision_id) as {
        signature: string | null;
        payload: string;
      };
      assert.ok(decision.signature);
      const signedPayload = JSON.parse(decision.payload) as {
        conflict_resolution?: { conflict_id?: string; adopted_actor?: string; note?: string };
      };
      assert.deepEqual(signedPayload.conflict_resolution, {
        conflict_id: conflictId,
        adopted_actor: before.loser_actor,
        note: 'bob based on the newer revision',
      });
      const problems = verify(db).problems;
      assert.equal(problems.some((problem) => problem.table === 'conflict'), false, JSON.stringify(problems));
    } finally {
      await rig.close();
    }
  });
});

test('C4 negative: agent session cannot resolve (no proxy signing)', async () => {
  await withMigratedDbAsync(async (db) => {
    const rig = await bootSignerd({ ttl: '5' });
    try {
      const conflictId = setupConflict(db);
      {
        const evs = readEvents(db, []);
        console.log('DEBUG events', evs.map((e) => `${e.kind}:${e.subject}`).join(', '));
        const st = fold(undefined, evs);
        console.log('DEBUG conflict keys', Object.keys(st.tables.conflict), 'conflictId', conflictId);
      }
      const resolved = await resolveConflict(
        db,
        rig.client,
        { conflict_id: conflictId, payload_hash: conflictResolutionPayloadHash(conflictId, 'winner'), side: 'winner' },
        { ...SESSION, actor_kind: 'agent' },
      );
      assert.equal(resolved.ok, false);
      if (!resolved.ok) assert.equal(resolved.reason_code, 'resolution_not_signed');
      assert.equal(readConflict(db, conflictId)?.status, 'open');
    } finally {
      await rig.close();
    }
  });
});

test('C4 negative: wrong payload hash is rejected before signing', async () => {
  await withMigratedDbAsync(async (db) => {
    const rig = await bootSignerd({ ttl: '5' });
    try {
      const conflictId = setupConflict(db);
      {
        const evs = readEvents(db, []);
        console.log('DEBUG events', evs.map((e) => `${e.kind}:${e.subject}`).join(', '));
        const st = fold(undefined, evs);
        console.log('DEBUG conflict keys', Object.keys(st.tables.conflict), 'conflictId', conflictId);
      }
      const resolved = await resolveConflict(
        db,
        rig.client,
        { conflict_id: conflictId, payload_hash: 'sha256:deadbeef', side: 'winner' },
        SESSION,
      );
      assert.equal(resolved.ok, false);
      if (!resolved.ok) assert.equal(resolved.reason_code, 'conflict_invalid');
      assert.equal(readConflict(db, conflictId)?.status, 'open');
    } finally {
      await rig.close();
    }
  });
});
