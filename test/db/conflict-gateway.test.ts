import { appendAs as append } from './append-auth.js';
/**
 * M3-2 同进程：并发写一成一败、conflicts 视图、与 disputed 分离、verify 抓直改。
 * 两进程用例见 conflict-two-process.test.ts。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chainHead } from '../../src/db/write.js';
import { verify } from '../../src/core/verify.js';
import { fold } from '../../src/core/fold/index.js';
import { readEvents } from '../../src/core/verify-events.js';
import { valueHash } from '../../src/core/conflict/hash.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import type { Event } from '../../src/core/fold/types.js';
import { chain, fourDomainSeeds, seed, withWriteDb } from './append-helpers.js';

function eventCount(db: SdoDatabase): number {
  return (db.prepare('SELECT count(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n;
}

function specRowHash(db: SdoDatabase): string {
  const state = fold(undefined, readEvents(db, []));
  const row = state.tables.spec['SPEC-1'];
  if (row === undefined) throw new Error('SPEC-1 missing');
  return valueHash(row['clause'] ?? null);
}

function setup(db: SdoDatabase): string {
  const seeded = append(db, chain(fourDomainSeeds()));
  assert.equal(seeded.ok, true, seeded.message ?? 'seed append rejected');
  return specRowHash(db);
}

function revise(
  db: SdoDatabase,
  actor: string,
  baseHash: string,
  clause: string,
  n = 20,
): Event {
  const [event] = chain(
    [seed(n, 'spec.revised', 'SPEC-1', {
      reason: 'concurrent edit',
      clause,
      field: 'clause',
      base_hash: baseHash,
      value: clause,
    }, { actor })],
    chainHead(db),
  );
  if (event === undefined) throw new Error('event build failed');
  return event;
}

test('C1: concurrent writes on the same field — one ok, one conflict with structured 409', () => {
  withWriteDb((db) => {
    const base = setup(db);
    const before = eventCount(db);
    const first = append(db, [revise(db, 'alice', base, 'clause A')]);
    assert.equal(first.ok, true, first.message ?? 'first append rejected');

    const second = append(db, [revise(db, 'bob', base, 'clause B', 21)]);
    assert.equal(second.ok, false);
    assert.equal(second.reason_code, 'conflict');
    assert.ok(second.conflict_id);
    assert.equal(second.base_hash, base);
    assert.ok(second.current_hash);
    assert.equal(second.rolled_back, false, '冲突路径已提交（写方按 409 处理）');
    assert.equal((db.prepare('SELECT count(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n, before + 2);

    const conflict = db.prepare('SELECT * FROM conflicts WHERE id = ?').get(second.conflict_id) as Record<string, unknown>;
    assert.ok(conflict, 'conflict row must be projected from conflict.detected');
    assert.equal(conflict['subject'], 'spec/SPEC-1');
    assert.equal(conflict['field'], 'clause');
    assert.equal(conflict['winner_actor'], 'alice');
    assert.equal(conflict['loser_actor'], 'bob');
    assert.equal(conflict['status'], 'open');
    assert.equal(JSON.parse(String(conflict['loser_value'])), 'clause B');
    assert.equal(verify(db).ok, true);
  });
});

test('C2: one row per conflict, both sides visible; C3: no dispute.* pollution', () => {
  withWriteDb((db) => {
    const base = setup(db);
    append(db, [revise(db, 'alice', base, 'clause A')]);
    const conflicted = append(db, [revise(db, 'bob', base, 'clause B', 21)]);
    assert.equal(conflicted.reason_code, 'conflict');
    const rows = db.prepare('SELECT * FROM conflicts').all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['status'], 'open');
    assert.ok(rows[0]?.['base_hash']);
    assert.ok(rows[0]?.['current_hash']);
    const disputed = db.prepare("SELECT count(*) AS n FROM event WHERE kind LIKE 'dispute.%'").get() as { n: number };
    assert.equal(disputed.n, 0);
    const detected = db.prepare("SELECT count(*) AS n FROM event WHERE kind = 'conflict.detected'").get() as { n: number };
    assert.equal(detected.n, 1);
  });
});

test('C5: verify recomputes conflict rows and catches a direct edit', () => {
  withWriteDb((db) => {
    const base = setup(db);
    append(db, [revise(db, 'alice', base, 'clause A')]);
    const conflicted = append(db, [revise(db, 'bob', base, 'clause B', 21)]);
    const conflictId = String(conflicted.conflict_id);

    db.exec('DROP TRIGGER IF EXISTS trg_conflict_append_only_update');
    db.prepare("UPDATE conflict SET status = 'resolved' WHERE id = ?").run(conflictId);
    const report = verify(db);
    assert.equal(report.ok, false);
    assert.ok(
      report.problems.some((problem) => problem.code === 'runtime_inconsistent' && problem.table === 'conflict'),
      JSON.stringify(report.problems),
    );
  });
});

test('C4: a conflict.resolved backed by an unsigned decision is rejected, conflict stays open', () => {
  withWriteDb((db) => {
    const base = setup(db);
    append(db, [revise(db, 'alice', base, 'clause A')]);
    const conflicted = append(db, [revise(db, 'bob', base, 'clause B', 21)]);
    const conflictId = String(conflicted.conflict_id);

    const events = chain(
      [
        seed(30, 'decision.valid', 'd-unsigned', {
          decision_kind: 'sign',
          payload: { conflict_resolution: { conflict_id: conflictId, side: 'winner' } },
        }),
        seed(31, 'conflict.resolved', `conflict:${conflictId}`, {
          conflict_id: conflictId,
          decision_id: 'd-unsigned',
          side: 'winner',
        }),
      ],
      chainHead(db),
    );
    const result = append(db, events);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'materialize_failed');
    const row = db.prepare('SELECT status, resolution_decision_id FROM conflict WHERE id = ?').get(conflictId) as Record<string, unknown>;
    assert.equal(row['status'], 'open');
    assert.equal(row['resolution_decision_id'], null);
  });
});

test('C5: the conflicts view is not writable (no state of its own); verify stays green', () => {
  withWriteDb((db) => {
    const base = setup(db);
    append(db, [revise(db, 'alice', base, 'clause A')]);
    const conflicted = append(db, [revise(db, 'bob', base, 'clause B', 21)]);
    assert.equal(conflicted.reason_code, 'conflict');
    assert.equal(verify(db).ok, true);
    assert.throws(
      () => db.prepare("UPDATE conflicts SET status = 'resolved'").run(),
      /view|cannot modify/i,
      'conflicts 是视图，不允许直接写',
    );
    assert.throws(
      () => db.prepare('DELETE FROM conflicts').run(),
      /view|cannot modify/i,
      'conflicts 是视图，不允许直接写',
    );
    assert.equal(verify(db).ok, true);
  });
});

test('P1-1: impersonating the winner actor with a stale base is still a conflict', () => {
  withWriteDb((db) => {
    const base = setup(db);
    append(db, [revise(db, 'alice', base, 'clause A')]);
    // bob 把 actor 写成 alice，但没读到 alice 的新值 ⇒ 仍是 stale write，不享受自豁免。
    const faked = revise(db, 'alice', base, 'clause B', 21);
    const conflicted = append(db, [faked]);
    assert.equal(conflicted.ok, false);
    assert.equal(conflicted.reason_code, 'conflict');
    const row = db.prepare('SELECT winner_actor, loser_actor FROM conflict WHERE id = ?').get(String(conflicted.conflict_id)) as Record<string, unknown>;
    assert.equal(row['winner_actor'], 'alice');
    assert.equal(row['loser_actor'], 'alice');
  });
});

test('P1-2/P2-3: a tracked patch without field/base_hash is rejected (0 rows)', () => {
  withWriteDb((db) => {
    setup(db);
    const before = eventCount(db);
    const [event] = chain(
      [seed(40, 'spec.revised', 'SPEC-1', { reason: 'no declaration', clause: 'x' })],
      chainHead(db),
    );
    if (event === undefined) throw new Error('event build failed');
    const result = append(db, [event]);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'conflict_scope_undeclared');
    assert.equal(result.rolled_back, true);
    assert.equal(eventCount(db), before);
  });
});

test('P1-3: a hand-written conflict.detected is rejected (one-shot CAS authority)', () => {
  withWriteDb((db) => {
    setup(db);
    const before = eventCount(db);
    const [event] = chain(
      [seed(41, 'conflict.detected', 'CF-hand', {
        conflict_id: 'CF-hand',
        subject: 'spec/SPEC-1',
        field: 'clause',
        base_hash: 'sha256:aa',
        current_hash: 'sha256:bb',
        winner_actor: 'alice',
        loser_actor: 'bob',
        winner_value: '"a"',
        loser_value: '"b"',
      })],
      chainHead(db),
    );
    if (event === undefined) throw new Error('event build failed');
    const result = append(db, [event]);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'unauthorized_conflict_detected');
    assert.equal(result.rolled_back, true);
    assert.equal(eventCount(db), before);
    assert.equal((db.prepare('SELECT count(*) AS n FROM conflict').get() as { n: number }).n, 0);
  });
});

test('P2-2: the second stale write inside one batch conflicts (in-batch CAS)', () => {
  withWriteDb((db) => {
    const base = setup(db);
    const before = eventCount(db);
    const events = chain(
      [
        seed(50, 'spec.revised', 'SPEC-1', { reason: 'first', clause: 'clause A', field: 'clause', base_hash: base, value: 'clause A' }, { actor: 'alice' }),
        seed(51, 'spec.revised', 'SPEC-1', { reason: 'second', clause: 'clause B', field: 'clause', base_hash: base, value: 'clause B' }, { actor: 'bob' }),
      ],
      chainHead(db),
    );
    const result = append(db, events);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'conflict');
    assert.equal(result.rolled_back, false);
    assert.equal(eventCount(db), before + 2, 'first write + conflict.detected');
    assert.equal(verify(db).ok, true);
  });
});
