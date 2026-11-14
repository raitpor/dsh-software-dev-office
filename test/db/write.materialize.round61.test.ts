import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SdoDatabase } from '../../src/db/driver.js';
import { append } from '../../src/db/write.js';
import {
  FOLD_ONLY_COLUMNS,
  MATERIALIZED_TABLES,
  SUPPORTED_KINDS,
} from '../../src/db/write-materialize.js';
import { ACK_KINDS } from '../../src/core/fold/ack.js';
import { fold } from '../../src/core/fold/index.js';
import { REDUCERS } from '../../src/core/fold/registry.js';
import { readEvents } from '../../src/core/verify-events.js';
import { verify } from '../../src/core/verify.js';
import type { VerifyProblem } from '../../src/core/verify-types.js';
import { chain, fourDomainSeeds, seed, withWriteDb } from './append-helpers.js';
import { worldSeeds } from './world-seeds.js';

test('P1: unsupported (registered but out-of-scope) kind is rejected, verify stays green', () => {
  withWriteDb((db) => {
    const result = append(db, chain([seed(1, 'query_miss', 'Q-1', {})]));
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'unsupported_scope');
    assert.match(result.message ?? '', /query_miss/u);
    assert.match(result.message ?? '', /no fold projection/u);
    assert.equal(count(db, 'event'), 0);
    assert.deepEqual(verify(db).problems, []);
  });
});

test('P1/D-019: decision.valid alone writes no decision row; signed batch materializes it', () => {
  withWriteDb((db) => {
    const onlyValid = chain([seedDecisionValid()]);
    assert.equal(append(db, onlyValid).ok, true);
    assert.equal(count(db, 'decision'), 0);
    assert.deepEqual(verify(db).problems, []);

    const signed = chain([seedDecisionSigned()], onlyValid[0]?.hash);
    const result = append(db, signed);
    assert.equal(result.ok, true, `append failed: ${result.message ?? ''}`);
    const row = db.prepare('SELECT signature FROM decision WHERE id = ?').get('d-int') as { signature: string };
    assert.equal(row.signature, 'sig-d-int');
    assert.deepEqual(verify(db).problems, []);
  });
});

test('P2-10: ignored fold columns equal FOLD_ONLY_COLUMNS (explicit whitelist, all tables)', () => {
  withWriteDb((db) => {
    assert.equal(append(db, chain(worldSeeds())).ok, true);
    const problems: VerifyProblem[] = [];
    const state = fold(undefined, readEvents(db, problems));
    for (const table of MATERIALIZED_TABLES) {
      const rows = Object.values(state.tables[table]);
      if (rows.length === 0) continue;
      const ddl = new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      const actual = new Set<string>();
      for (const row of rows) {
        for (const key of Object.keys(row)) if (!ddl.has(key)) actual.add(key);
      }
      assert.deepEqual(
        [...actual].sort(),
        [...(FOLD_ONLY_COLUMNS[table] ?? [])].sort(),
        `fold-only columns drifted for ${table}`,
      );
    }
  });
});

test('group regression: write -> same-batch replay -> append unrelated event -> verify green', () => {
  withWriteDb((db) => {
    const first = chain(fourDomainSeeds());
    const written = append(db, first);
    assert.equal(written.ok, true);
    const replay = append(db, first);
    assert.equal(replay.ok, true);
    assert.equal(replay.skipped, 6);
    const next = chain([seed(20, 'spec.revised', 'SPEC-1', { reason: 'r' })], first[first.length - 1]?.hash);
    assert.equal(append(db, next).ok, true);
    const groups = chain(
      [
        seed(21, 'assumption.recorded', 'A-1', {
          intent_id: 'INT-1',
          clause: 'assume',
          blast_radius: 'low',
          content_hash: 'ch:a-1',
        }),
        seed(22, 'contract.defined', 'CT-1', {
          intent_id: 'INT-1',
          clause: 'contract',
          content_hash: 'ch:ct-1',
        }),
      ],
      next[next.length - 1]?.hash,
    );
    assert.equal(append(db, groups).ok, true);
    assert.equal(count(db, 'event'), 9);
    assert.deepEqual(verify(db).problems, []);
  });
});

test('P2-2: stale projection rows are deleted by the next append (spec table)', () => {
  withWriteDb((db) => {
    const first = chain(fourDomainSeeds());
    assert.equal(append(db, first).ok, true);
    db.prepare("INSERT INTO criterion (id, spec_id, kind, status_enum, remedy) VALUES ('CRIT-9', 'SPEC-1', 'functional', 'pass', 'ghost')").run();
    const second = chain([seed(30, 'spec.revised', 'SPEC-1', { reason: 'r' })], first[first.length - 1]?.hash);
    assert.equal(append(db, second).ok, true);
    assert.equal(count(db, 'criterion'), 1);
    assert.deepEqual(verify(db).problems, []);
  });
});

test('P1/C1: every registered kind is supported / unsupported_scope / ack-only (three-way)', () => {
  withWriteDb((db) => {
    const kinds = [...Object.keys(REDUCERS), ...Object.keys(ACK_KINDS)].sort();
    assert.equal(kinds.length, 92, 'registered kind count drift');
    const counts = { supported: 0, unsupported: 0, ackOnly: 0 };
    for (const kind of kinds) {
      if (Object.hasOwn(SUPPORTED_KINDS, kind)) {
        counts.supported += 1;
        assert.ok(Object.hasOwn(REDUCERS, kind), `supported kind ${kind} must have a reducer`);
        assert.ok(
          MATERIALIZED_TABLES.includes(SUPPORTED_KINDS[kind] as (typeof MATERIALIZED_TABLES)[number]),
          `${kind} maps to a non-materialized table`,
        );
        continue;
      }
      const result = append(db, chain([seed(1, kind, 'X-1', {})]));
      assert.equal(result.reason_code, 'unsupported_scope', `kind ${kind} should be rejected by scope`);
      if (Object.hasOwn(ACK_KINDS, kind)) {
        counts.ackOnly += 1;
        assert.equal(Object.hasOwn(REDUCERS, kind), false, `ack-only kind ${kind} must not have a reducer`);
      } else {
        counts.unsupported += 1;
      }
    }
    assert.equal(counts.supported + counts.unsupported + counts.ackOnly, 92);
    assert.equal(count(db, 'event'), 0);
  });
});

function seedDecisionValid(): ReturnType<typeof seed> {
  return seed(90, 'decision.valid', 'd-int', {
    decision_kind: 'intent',
    payload_hash: 'ph-d-int',
    frontier: 'f-1',
    payload: { kind: 'intent' },
  });
}

function seedDecisionSigned(): ReturnType<typeof seed> {
  return seed(91, 'decision.signed', 'd-int', {
    payload_hash: 'ph-d-int',
    signature: 'sig-d-int',
    key_id: 'key-1',
    signer: 'alice',
  });
}

function count(db: SdoDatabase, table: 'decision' | 'criterion' | 'event'): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
