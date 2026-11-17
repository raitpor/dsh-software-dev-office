import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { withWriteDb } from './append-helpers.js';

/**
 * D-193 的唯一合法性来源：020 把 `gaps` 的 event 派生分支改成一个 MATERIALIZED CTE
 * （单次扫描）后，必须与 002 的旧视图在**同一批数据**上逐行等价。
 * 这里直接取 002 的 `CREATE VIEW gaps AS <body>` 原文，与当前 `gaps` 并排跑。
 */
const ROOT = process.cwd();
const AT = '2026-11-17T10:00:00.000Z';

function oldGapsBody(): string {
  const sql = readFileSync(join(ROOT, 'migrations', '002_views.sql'), 'utf8');
  const start = sql.indexOf('CREATE VIEW gaps AS');
  assert.notEqual(start, -1, '002 must define gaps');
  const bodyStart = sql.indexOf('\n', start) + 1;
  const end = sql.indexOf(';', bodyStart);
  assert.notEqual(end, -1, '002 gaps must terminate');
  return sql.slice(bodyStart, end);
}

function seedOldSources(db: Parameters<typeof withWriteDb>[0] extends (db: infer T) => unknown ? T : never): void {
  db.prepare("INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    'e-q1', AT, 'a', 'query_miss', null, JSON.stringify({ view: 'overview' }), '[]', 'r-q1', 'GENESIS', 'h-q1',
  );
  db.prepare("INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    'e-q2', AT, 'a', 'query_miss', null, JSON.stringify({ view: 'overview' }), '[]', 'r-q2', 'h-q1', 'h-q2',
  );
  db.prepare("INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    'e-q3', AT, 'a', 'query_miss', null, JSON.stringify({ view: 'board' }), '[]', 'r-q3', 'h-q2', 'h-q3',
  );
  db.prepare("INSERT INTO redteam (id, subject_kind, subject_id, use_case, disposition, at) VALUES (?, ?, ?, ?, ?, ?)").run(
    'RT-1', 'task', 'T-1', 'use-case', 'deferred', AT,
  );
  db.prepare("INSERT INTO decision (id, decision_kind, status, payload, payload_hash, signature, key_id, signer, frontier, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    'D-1', 'waiver', 'valid', JSON.stringify({ criterion_id: 'CRIT-1' }), 'ph-1', 'sig', 'key', 'a', 'f', AT,
  );
}

test('D-193: 020 gaps is row-for-row equivalent to the 002 gaps on the same old-source data', () => {
  withWriteDb((db) => {
    seedOldSources(db);
    const body = oldGapsBody();
    const oldRows = db.prepare(`SELECT * FROM (${body}) ORDER BY kind, subject`).all();
    const newRows = db.prepare('SELECT * FROM gaps ORDER BY kind, subject').all();
    assert.deepEqual(newRows, oldRows);
    assert.deepEqual(
      newRows.map((row) => (row as { kind: string }).kind),
      ['query_miss', 'query_miss', 'redteam_deferred', 'waiver'],
    );
    const queryMiss = newRows.filter((row) => (row as { kind: string }).kind === 'query_miss') as Array<{ subject: string; count: number }>;
    assert.deepEqual(queryMiss.map((row) => [row.subject, row.count]), [['board', 1], ['overview', 2]]);
  });
});
