import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { append } from '../../src/db/write.js';
import { canonicalJson } from '../../src/core/fold/canonical.js';
import type { ClaimRow } from '../../src/claim/types.js';
import { expectedClaimRow, importClaims, writeClaimRows } from '../../src/claim/gateway.js';
import { isRegisteredRenderer } from '../../src/claim/renderers.js';
import { readExportFile } from '../../src/importer/parse.js';
import { chain, seed, withWriteDb } from '../db/append-helpers.js';

/** 一条合法 claim 行；frontier 由调用方给（必须是库里真实存在的事件 id）。 */
function row(frontier: readonly string[], overrides: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: 'claim:TEST-1',
    subject: 'TASK-1',
    predicate: 'done',
    value: canonicalJson({ code: 'done', value: true }),
    as_of_frontier: canonicalJson([...frontier]),
    derived_by: 'renderer:gate-result',
    actor: 'alice',
    at: '2026-11-14T00:00:00Z',
    ...overrides,
  };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('C7 claim is append-only at the DB layer (UPDATE/DELETE rejected)', () => {
  withWriteDb((db) => {
    const [event] = chain([seed(1, 'task.created', 'TASK-1', { seq: 1, title: 't', kind: 'implement' })]);
    assert.equal(append(db, [event!]).ok, true);
    const result = writeClaimRows(db, [row([event!.id])]);
    assert.deepEqual([result.ok, result.written], [true, 1]);
    assert.throws(
      () => db.prepare("UPDATE claim SET actor = 'mallory' WHERE id = 'claim:TEST-1'").run(),
      /claim is append-only: UPDATE rejected/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM claim WHERE id = 'claim:TEST-1'").run(),
      /claim is append-only: DELETE rejected/,
    );
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 1);
  });
});

test('C4 unregistered renderer is rejected before any row is written', () => {
  withWriteDb((db) => {
    const [event] = chain([seed(1, 'task.created', 'TASK-1', { seq: 1, title: 't', kind: 'implement' })]);
    append(db, [event!]);
    const result = writeClaimRows(db, [row([event!.id], { derived_by: 'renderer:forged' })]);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'renderer_unregistered');
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 0);
  });
});

test('C5 empty or unknown frontier is rejected', () => {
  withWriteDb((db) => {
    const [event] = chain([seed(1, 'task.created', 'TASK-1', { seq: 1, title: 't', kind: 'implement' })]);
    append(db, [event!]);
    const empty = writeClaimRows(db, [row([])]);
    assert.equal(empty.reason_code, 'frontier_empty');
    const unknown = writeClaimRows(db, [row(['e-does-not-exist'])]);
    assert.equal(unknown.reason_code, 'frontier_unknown');
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 0);
  });
});

test('C3 claim INSERT exists only in the claim gateway (static scan)', () => {
  const offenders = walk('src').filter((path) => {
    if (path === join('src', 'claim', 'gateway.ts')) return false;
    const text = readFileSync(path, 'utf8');
    return /INSERT\s+(?:OR\s+(?:REPLACE|IGNORE)\s+)?INTO\s+["'`]?(?:main\.)?claim\b/iu.test(text);
  });
  assert.deepEqual(offenders, [], 'claim rows must only be written by src/claim/gateway.ts');
});

test('C3b direct INSERT outside the gateway is possible (documented best-effort boundary)', () => {
  withWriteDb((db) => {
    db.prepare(
      `INSERT INTO claim (id, subject, predicate, value, as_of_frontier, derived_by, actor, at)
       VALUES ('claim:DIRECT', 'TASK-1', 'done', '{}', '["e-missing"]', 'x', 'x', '2026-01-01')`,
    ).run();
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 1);
  });
});

test('C8 claim value carries code/params only, no long prose', () => {
  const claims = readExportFile('test/fixtures/v1-export.json').claims;
  for (const claim of claims) {
    const expected = expectedClaimRow(claim, ['imp:1', 'imp:2', 'imp:3', 'imp:4']);
    const value = JSON.parse(expected.value) as Record<string, unknown>;
    assert.deepEqual(Object.keys(value).sort(), ['code', 'value']);
    assert.equal(value['code'], 'done');
    for (const text of Object.values(value)) {
      assert.ok(String(text).length < 64, 'claim value must not carry long prose');
    }
  }
});

test('C4 renderer registry needs both the code constant and the view', () => {
  withWriteDb((db) => {
    assert.equal(isRegisteredRenderer(db, 'renderer:gate-result'), true);
    assert.equal(isRegisteredRenderer(db, 'renderer:unknown'), false);
  });
});

test('importClaims is exposed as the single claim entry point', () => {
  assert.equal(typeof importClaims, 'function');
});
