import test from 'node:test';
import assert from 'node:assert/strict';

import { verify } from '../../src/core/verify.js';
import { landingEvents } from '../../src/importer/rebuild.js';
import { readExportFile } from '../../src/importer/parse.js';
import { importClaims } from '../../src/claim/gateway.js';
import { CLAIM_COLUMNS, type ClaimRow } from '../../src/claim/types.js';
import { canonicalJson } from '../../src/core/fold/canonical.js';
import { withWriteDb } from '../db/append-helpers.js';

const parsed = readExportFile('test/fixtures/v1-export.json');

interface Diff {
  path: string;
  parsed: unknown;
  stored: unknown;
}

function compare(expected: ClaimRow, stored: ClaimRow): Diff[] {
  const diffs: Diff[] = [];
  for (const column of CLAIM_COLUMNS) {
    if (expected[column] !== stored[column]) {
      diffs.push({ path: column, parsed: expected[column], stored: stored[column] });
    }
  }
  return diffs;
}

test('C1 the 20 v1 claims rebuild to 20/20 identical rows', () => {
  withWriteDb((db) => {
    const result = importClaims(db, parsed.claims);
    assert.equal(result.ok, true, result.message ?? "");
    assert.deepEqual(
      [result.written, result.skipped, result.events_written],
      [20, 0, parsed.claims.length * 2],
    );
    const stored = db.prepare('SELECT * FROM claim ORDER BY id').all() as ClaimRow[];
    assert.equal(stored.length, 20);
    for (const claim of parsed.claims) {
      const events = landingEvents(claim);
      // 期望值直接从夹具字段算（C1 要证明“解析出的 == 落库的”，不能两侧共用同一个 helper）。
      const expected: ClaimRow = {
        id: `claim:${claim.claim_no}`,
        subject: claim.task_id,
        predicate: claim.predicate,
        value: canonicalJson({ code: claim.predicate, value: claim.value }),
        as_of_frontier: canonicalJson(events.map((event) => event.id)),
        derived_by: claim.renderer,
        actor: claim.actor,
        at: claim.at,
      };
      const row = stored.find((candidate) => candidate.id === expected.id);
      assert.ok(row !== undefined, `missing claim ${expected.id}`);
      assert.deepEqual(compare(expected, row), [], `${expected.id} must match the fixture`);
    }
  });
});

test('C2 rebuild events go through append(): real chain, no imp: in prev, verify green', () => {
  withWriteDb((db) => {
    const result = importClaims(db, parsed.claims);
    assert.equal(result.ok, true, result.message ?? "");
    const events = db
      .prepare('SELECT id, kind, prev FROM event ORDER BY rowid')
      .all() as Array<{ id: string; kind: string; prev: string }>;
    assert.equal(events.length, parsed.claims.length * 2);
    assert.equal(events.every((event) => !event.prev.startsWith('imp:')), true);
    assert.equal(events.every((event) => event.kind === 'task.created' || event.kind === 'task.claimed'), true);
    assert.equal(events[0]?.prev.startsWith('sha256:'), true);
    const report = verify(db);
    assert.equal(report.ok, true, JSON.stringify(report.problems.slice(0, 3)));
    assert.equal(report.problems.length, 0);
    assert.equal(report.legacy_criterion_registrations, 0, 'M1 does not land v1 criterion.registered (D-045)');
  });
});

test('C6 rerun is a no-op; same id with different content is claim_conflict', () => {
  withWriteDb((db) => {
    const first = importClaims(db, parsed.claims);
    assert.equal(first.ok, true, first.message ?? "");
    const second = importClaims(db, parsed.claims);
    assert.deepEqual(
      [second.ok, second.written, second.skipped, second.events_written],
      [true, 0, 20, 0],
    );
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 20);

    const conflicting = parsed.claims.map((claim, index) =>
      index === 0 ? { ...claim, at: '2026-11-14T09:09:09Z' } : claim,
    );
    const third = importClaims(db, conflicting);
    assert.equal(third.ok, false);
    assert.equal(third.reason_code, 'claim_conflict');
    assert.equal(third.written, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 20);
  });
});

test('C1b the comparator itself catches a one-field drift (mutation guard)', () => {
  const claim = parsed.claims[0]!;
  const expected: ClaimRow = {
    id: `claim:${claim.claim_no}`,
    subject: claim.task_id,
    predicate: claim.predicate,
    value: canonicalJson({ code: claim.predicate, value: claim.value }),
    as_of_frontier: canonicalJson(['a']),
    derived_by: claim.renderer,
    actor: claim.actor,
    at: claim.at,
  };
  const drifted = { ...expected, predicate: 'not-done' };
  assert.deepEqual(compare(expected, drifted), [
    { path: 'predicate', parsed: 'done', stored: 'not-done' },
  ]);
});
