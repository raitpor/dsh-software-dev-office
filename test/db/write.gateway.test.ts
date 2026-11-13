import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { append, chainHead } from '../../src/db/write.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { verify } from '../../src/core/verify.js';
import { chain, seed, fourDomainSeeds, withWriteDb } from './append-helpers.js';

function eventCount(db: SdoDatabase): number {
  return (db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map((entry) => join(dir, String(entry)))
    .filter((path) => path.endsWith('.ts'));
}

test('C1 event rows are written only by the gateway', () => {
  const offenders = sourceFiles('src')
    .filter((path) => !path.endsWith('src/db/write.ts'))
    .filter((path) => /INSERT\s+INTO\s+event\b/i.test(readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('C2 unknown kind is rejected and writes nothing', () => {
  withWriteDb((db) => {
    const batch = chain([seed(1, 'mystery.event', 'X-1', {})]);
    const result = append(db, batch);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'unknown_event_kind');
    assert.equal(result.rolled_back, true);
    assert.equal(result.written, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.attempted, 0);
    assert.equal(eventCount(db), 0);
    assert.equal(verify(db).ok, true);
  });
});

test('C3 forged prev is rejected and writes nothing', () => {
  withWriteDb((db) => {
    const batch = chain([seed(1, 'decision.valid', 'd-1', { decision_kind: 'intent', payload_hash: 'ph', frontier: 'f', payload: {} })]);
    const forged = batch.map((event) => ({ ...event, prev: 'sha256:forged' }));
    const result = append(db, forged);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'event_chain_broken');
    assert.equal(result.rolled_back, true);
    assert.equal(result.written, 0);
    assert.equal(eventCount(db), 0);
    assert.equal(verify(db).ok, true);
  });
});

test('C3 wrong hash is rejected and writes nothing', () => {
  withWriteDb((db) => {
    const batch = chain([seed(1, 'decision.valid', 'd-1', { decision_kind: 'intent', payload_hash: 'ph', frontier: 'f', payload: {} })]);
    const tampered = batch.map((event) => ({ ...event, hash: 'sha256:0000' }));
    const result = append(db, tampered);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'event_hash_mismatch');
    assert.equal(eventCount(db), 0);
  });
});

test('C4 same batch replayed is idempotent', () => {
  withWriteDb((db) => {
    const batch = chain(fourDomainSeeds());
    const first = append(db, batch);
    assert.equal(first.ok, true);
    assert.equal(first.written, 6);
    assert.equal(first.attempted, 6);
    assert.equal(first.rolled_back, false);
    assert.equal(eventCount(db), 6);

    const second = append(db, batch);
    assert.equal(second.ok, true);
    assert.equal(second.written, 0);
    assert.equal(second.skipped, 6);
    assert.equal(second.attempted, 6);
    assert.equal(second.rolled_back, false);
    assert.equal(eventCount(db), 6);
    assert.equal(chainHead(db), batch[batch.length - 1]?.hash);
    assert.deepEqual(verify(db).problems, []);
  });
});

test('unknown kind is rejected in validation (never reaches INSERT)', () => {
  withWriteDb((db) => {
    const good = chain([
      seed(1, 'decision.valid', 'd-1', { decision_kind: 'intent', payload_hash: 'ph1', frontier: 'f', payload: {} }),
      seed(2, 'decision.valid', 'd-2', { decision_kind: 'intent', payload_hash: 'ph2', frontier: 'f', payload: {} }),
    ]);
    const bad = seed(3, 'mystery.event', 'INT-3', {});
    const result = append(db, [...good, ...chain([bad], good[1]?.hash)]);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'unknown_event_kind');
    assert.equal(result.rolled_back, true);
    assert.equal(result.written, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.attempted, 2);
    assert.equal(eventCount(db), 0);
    assert.equal(verify(db).ok, true);
  });
});

const EVENT_INSERT = /INSERT\s+(?:OR\s+[A-Za-z]+\s+)?INTO\s+(?:main\.)?["'`]?event\b/i;

test('C1 guard catches INSERT OR REPLACE / quoted / qualified event writes', () => {
  for (const sample of [
    'INSERT INTO event (id) VALUES (1)',
    'INSERT OR REPLACE INTO event (id) VALUES (1)',
    'INSERT INTO "event" (id) VALUES (1)',
    'INSERT INTO main.event (id) VALUES (1)',
  ]) {
    assert.match(sample, EVENT_INSERT, `guard missed: ${sample}`);
  }
  const offenders = sourceFiles('src')
    .filter((path) => !path.endsWith('src/db/write.ts'))
    .filter((path) => EVENT_INSERT.test(readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, []);
});

test('P2-1 prototype-chain kinds are rejected as unknown_event_kind', () => {
  withWriteDb((db) => {
    for (const kind of ['toString', '__proto__']) {
      const result = append(db, chain([seed(1, kind, 'X-1', {})]));
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'unknown_event_kind');
    }
    assert.equal(eventCount(db), 0);
  });
});

test('P2-4 duplicate id inside a batch fails at INSERT and rolls back (append_conflict)', () => {
  withWriteDb((db) => {
    const first = seed(1, 'decision.valid', 'd-1', { decision_kind: 'intent', payload_hash: 'ph1', frontier: 'f', payload: {} });
    const duplicate = seed(2, 'decision.valid', 'd-2', { decision_kind: 'intent', payload_hash: 'ph2', frontier: 'f', payload: {} });
    const second = { ...duplicate, id: first.id, payload: { statement: 'b' } };
    const events = chain([first, second]);
    const result = append(db, events);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'append_conflict');
    assert.equal(result.rolled_back, true);
    assert.equal(result.attempted, 2);
    assert.equal(eventCount(db), 0);
    assert.equal(verify(db).ok, true);
  });
});

test('P2-4 materialize-stage fold failure rolls back the inserted events', () => {
  withWriteDb((db) => {
    const batch = chain([seed(1, 'spec.defined', 'SPEC-1', { intent_id: 'INT-1', clause: 'c', kind: 'bogus' })]);
    const result = append(db, batch);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'materialize_failed');
    assert.equal(result.rolled_back, true);
    assert.equal(result.attempted, 1);
    assert.equal(eventCount(db), 0);
  });
});

test('P2-6 append refuses to nest inside an open transaction', () => {
  withWriteDb((db) => {
    db.exec('BEGIN');
    try {
      const result = append(
        db,
        chain([seed(1, 'decision.valid', 'd-1', { decision_kind: 'intent', payload_hash: 'ph', frontier: 'f', payload: {} })]),
      );
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'transaction_in_progress');
      assert.equal(result.written, 0);
      assert.equal(eventCount(db), 0);
    } finally {
      db.exec('ROLLBACK');
    }
  });
});

test('P1: unsupported kind is rejected with unsupported_scope and writes nothing', () => {
  withWriteDb((db) => {
    const result = append(db, chain([seed(1, 'task.created', 'TASK-1', { seq: 1, title: 'x', kind: 'implement' })]));
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'unsupported_scope');
    assert.match(result.message ?? '', /task\.created/u);
    assert.match(result.message ?? '', /task/u);
    assert.equal(result.attempted, 0);
    assert.equal(eventCount(db), 0);
    assert.equal(verify(db).ok, true);
  });
});

test('P1/C1: dynamic string concatenation is caught by the static guard', () => {
  const dynamic = 'INSERT INTO ' + 'event (id) VALUES (1)';
  assert.match(dynamic, EVENT_INSERT);
});
