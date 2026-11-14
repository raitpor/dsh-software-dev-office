import test from 'node:test';
import assert from 'node:assert/strict';

import { append } from '../../src/db/write.js';
import { canonicalJson } from '../../src/core/fold/canonical.js';
import { readExportFile } from '../../src/importer/parse.js';
import { landingEvents } from '../../src/importer/rebuild.js';
import { importClaims, rebaseEvents, renderClaimsFromEvents } from '../../src/claim/gateway.js';
import { verifyClaims } from '../../src/claim/verify.js';
import { withWriteDb } from '../db/append-helpers.js';

const parsed = readExportFile('test/fixtures/v1-export.json');

function insertClaim(
  db: import('../../src/db/driver.js').SdoDatabase,
  id: string,
  frontier: string,
  derivedBy = 'renderer:gate-result',
): void {
  db.prepare(
    `INSERT INTO claim (id, subject, predicate, value, as_of_frontier, derived_by, actor, at)
     VALUES (?, 'TASK-X', 'done', ?, ?, ?, 'mallory', '2026-11-14T00:00:00Z')`,
  ).run(id, canonicalJson({ code: 'done', value: true }), frontier, derivedBy);
}

test('verifyClaims: normal import is green', () => {
  withWriteDb((db) => {
    assert.equal(importClaims(db, parsed.claims).ok, true);
    const report = verifyClaims(db);
    assert.deepEqual(report.problems, []);
    assert.equal(report.ok, true);
  });
});

test('P1-2: a directly inserted claim with a missing frontier event is caught', () => {
  withWriteDb((db) => {
    assert.equal(importClaims(db, parsed.claims).ok, true);
    insertClaim(db, 'claim:forged-frontier', '["e-missing"]');
    const report = verifyClaims(db);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.claim_id === 'claim:forged-frontier' && problem.reason === 'frontier_unknown'));
    assert.ok(report.problems.some((problem) => problem.claim_id === 'claim:forged-frontier' && problem.reason === 'unexpected'));
    // sdo verify 仍绿：claim 不在 core verify 的对账集（分层不变）。
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 21);
  });
});

test('P1-2: an unregistered derived_by is caught', () => {
  withWriteDb((db) => {
    assert.equal(importClaims(db, parsed.claims).ok, true);
    insertClaim(db, 'claim:forged-renderer', '["anything"]', 'renderer:forged');
    const report = verifyClaims(db);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.claim_id === 'claim:forged-renderer' && problem.reason === 'unregistered_renderer'));
  });
});

test('P1-1 recover: events landed, claims missing -> render-only fills 20 and does not add events', () => {
  withWriteDb((db) => {
    const events = rebaseEvents(db, parsed.claims.flatMap((claim) => landingEvents(claim)));
    assert.equal(append(db, events).ok, true);
    const eventCount = (db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n;
    assert.equal(eventCount, 40);
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 0);

    const render = renderClaimsFromEvents(db);
    assert.equal(render.ok, true, render.message ?? '');
    assert.deepEqual([render.written, render.skipped, render.events_written], [20, 0, 0]);
    assert.equal((db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n, eventCount);
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 20);
    assert.equal(verifyClaims(db).ok, true);

    const again = renderClaimsFromEvents(db);
    assert.deepEqual([again.ok, again.written, again.skipped], [true, 0, 20]);
  });
});

test('P1-1 truthful reporting: post-append claim failure reports 40 events and stays recoverable', () => {
  withWriteDb((db) => {
    const firstId = `claim:${parsed.claims[0]!.claim_no}`;
    db.exec(
      `CREATE TRIGGER reject_one BEFORE INSERT ON claim WHEN NEW.id = '${firstId}'
       BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END;`,
    );
    const failed = importClaims(db, parsed.claims);
    assert.equal(failed.ok, false);
    assert.equal(failed.events_written, 40, 'events really landed');
    assert.equal(failed.claims_written, 0);
    assert.equal(failed.resumable, true);
    assert.equal(failed.next_step, 'render_only');
    assert.equal((db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n, 40);
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 0);

    db.exec('DROP TRIGGER reject_one');
    const recovered = renderClaimsFromEvents(db);
    assert.deepEqual([recovered.ok, recovered.written, recovered.events_written], [true, 20, 0]);
    assert.equal(verifyClaims(db).ok, true);
    assert.equal((db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n, 40);
  });
});

test('P1-1 prevalidation: forged renderer rejects before append, zero events', () => {
  withWriteDb((db) => {
    const forged = parsed.claims.map((claim, index) =>
      index === 0 ? { ...claim, renderer: 'renderer:forged' } : claim,
    );
    const result = importClaims(db, forged);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'renderer_unregistered');
    assert.equal(result.events_written, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 0);
  });
});

function dropClaimGuards(db: import('../../src/db/driver.js').SdoDatabase): void {
  db.exec('DROP TRIGGER trg_claim_append_only_update; DROP TRIGGER trg_claim_append_only_delete;');
}

test('P2: a deleted claim row is reported as missing (and core verify stays green)', () => {
  withWriteDb((db) => {
    assert.equal(importClaims(db, parsed.claims).ok, true);
    const removed = `claim:${parsed.claims[3]!.claim_no}`;
    dropClaimGuards(db);
    db.prepare('DELETE FROM claim WHERE id = ?').run(removed);
    const report = verifyClaims(db);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.claim_id === removed && problem.reason === 'missing'));
    // claim 不在 core verify 的对账集：删 claim 行不会让 sdo verify 变红。
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 19);
  });
});

test('P2: a mutated claim column is reported as mismatch with the field list', () => {
  withWriteDb((db) => {
    assert.equal(importClaims(db, parsed.claims).ok, true);
    const target = `claim:${parsed.claims[0]!.claim_no}`;
    dropClaimGuards(db);
    db.prepare('UPDATE claim SET actor = ? WHERE id = ?').run('mallory', target);
    const report = verifyClaims(db);
    assert.equal(report.ok, false);
    const mismatch = report.problems.find((problem) => problem.claim_id === target && problem.reason === 'mismatch');
    assert.ok(mismatch !== undefined);
    assert.deepEqual(mismatch.fields, ['actor']);
  });
});

test('P2: an unregistered derived_by is reported as both unregistered_renderer and mismatch', () => {
  withWriteDb((db) => {
    assert.equal(importClaims(db, parsed.claims).ok, true);
    const target = `claim:${parsed.claims[1]!.claim_no}`;
    dropClaimGuards(db);
    db.prepare('UPDATE claim SET derived_by = ? WHERE id = ?').run('renderer:forged', target);
    const report = verifyClaims(db);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.claim_id === target && problem.reason === 'unregistered_renderer'));
    const mismatch = report.problems.find((problem) => problem.claim_id === target && problem.reason === 'mismatch');
    assert.ok(mismatch !== undefined);
    assert.ok((mismatch.fields ?? []).includes('derived_by'));
  });
});
