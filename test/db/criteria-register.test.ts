import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { append } from '../../src/db/write.js';
import { MATERIALIZED_TABLES } from '../../src/db/write-materialize.js';
import { verify } from '../../src/core/verify.js';
import { registerCriterion, type Fixture, type FixtureRunner } from '../../src/core/criteria/register.js';
import { chain, seed, withWriteDb, type EventSeed } from './append-helpers.js';

const FIXTURES: readonly Fixture[] = [
  { polarity: 'positive', input: 'pos-1', expected_status: 'pass' },
  { polarity: 'positive', input: 'pos-2', expected_status: 'pass' },
  { polarity: 'negative', input: 'neg-1', expected_status: 'fail' },
];

const RUNNER: FixtureRunner = (fixture) => (fixture.input.startsWith('pos') ? 'pass' : 'fail');

function seedsWithFixtures(): EventSeed[] {
  return [
    seed(1, 'decision.valid', 'd-int', {
      decision_kind: 'intent',
      payload_hash: 'ph-d-int',
      frontier: 'f-1',
      payload: { kind: 'intent', intent_id: 'INT-1' },
    }),
    seed(2, 'decision.signed', 'd-int', {
      payload_hash: 'ph-d-int',
      signature: 'sig',
      key_id: 'key-1',
      signer: 'alice',
    }),
    seed(3, 'intent.signed', 'INT-1', {
      decision_id: 'd-int',
      statement: 'intent 1',
      owner: 'alice',
      strength: 'explicit',
      content_hash: 'ch:int-1',
      baseline_hash: 'bh-1',
    }),
    seed(4, 'spec.defined', 'SPEC-1', {
      kind: 'requirement',
      clause: 'clause 1',
      intent_id: 'INT-1',
      content_hash: 'sha256:spec-1',
    }),
    seed(5, 'criterion.registered', 'spec_set.signed', {
      spec_id: 'SPEC-1',
      kind: 'functional',
      status_enum: 'pass',
      remedy: 'fix the thing',
      fixtures: FIXTURES,
    }),
  ];
}

function fixtureCount(db: Parameters<typeof append>[0]): number {
  return (db.prepare('SELECT count(*) AS n FROM criterion_fixture').get() as { n: number }).n;
}

test('C10/C11: register with 2 positive + 1 negative persists criterion and fixtures in one transaction', () => {
  const registration = registerCriterion(
    { criterion_id: 'spec_set.signed', guarantee: '1', remedy: 'fix the thing', fixtures: FIXTURES },
    RUNNER,
  );
  assert.equal(registration.ok, true);

  withWriteDb((db) => {
    const batch = chain(seedsWithFixtures());
    const result = append(db, batch);
    assert.equal(result.ok, true, `${result.reason_code ?? ''} ${result.message ?? ''}`);
    assert.equal(fixtureCount(db), 3);
    const criterion = db.prepare('SELECT remedy FROM criterion WHERE id = ?').get('spec_set.signed') as { remedy: string };
    assert.equal(criterion.remedy, 'fix the thing');
    assert.deepEqual(verify(db).problems, []);
    assert.ok(MATERIALIZED_TABLES.includes('criterion_fixture'));
  });
});

test('C10: only positive fixtures ⇒ registration rejected before any write', () => {
  const registration = registerCriterion(
    { criterion_id: 'spec_set.signed', guarantee: '1', remedy: 'fix', fixtures: [FIXTURES[0] as Fixture] },
    RUNNER,
  );
  assert.equal(registration.ok, false);
  assert.equal(registration.reason_code, 'no_negative_fixture');
});

test('C10: replay is idempotent; re-registering with new fixtures is an explicit conflict (no half fixtures)', () => {
  withWriteDb((db) => {
    const batch = chain(seedsWithFixtures());
    assert.equal(append(db, batch).ok, true);
    const replay = append(db, batch);
    assert.equal(replay.ok, true);
    assert.equal(replay.skipped, batch.length);
    assert.equal(fixtureCount(db), 3);

    const conflicting = chain([
      seed(6, 'criterion.registered', 'spec_set.signed', {
        spec_id: 'SPEC-1',
        remedy: 'changed',
        fixtures: [FIXTURES[0] as Fixture],
      }),
    ], batch[batch.length - 1]?.hash);
    const conflict = append(db, conflicting);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason_code, 'materialize_failed');
    assert.match(conflict.message ?? '', /already exists with different content/u);
    assert.equal(fixtureCount(db), 3);
  });
});

test('P1-3: legacy registration is counted by verify, not silently hidden', () => {
  withWriteDb((db) => {
    const batch = chain([
      ...seedsWithFixtures().slice(0, 4),
      seed(5, 'criterion.registered', 'criterion.legacy', {
        spec_id: 'SPEC-1',
        kind: 'functional',
        remedy: 'imported from v1',
        legacy: true,
      }),
    ]);
    const result = append(db, batch);
    assert.equal(result.ok, true, `${result.reason_code ?? ''} ${result.message ?? ''}`);
    const report = verify(db);
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(report.legacy_criterion_registrations, 1);
  });
});

test('C8: no second write path — no INSERT INTO criterion / criterion_fixture in src/', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith('.ts')) {
        const source = readFileSync(path, 'utf8');
        if (/INSERT\s+(OR\s+\w+\s+)?INTO\s+["']?criterion/iu.test(source)) offenders.push(path);
      }
    }
  };
  walk('src');
  assert.deepEqual(offenders, []);
});
