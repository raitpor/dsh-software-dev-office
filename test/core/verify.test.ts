import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openEncryptedDatabase, type SdoDatabase } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';
import { fold } from '../../src/core/fold/index.js';
import { GENESIS_PREV, computeEventHash, verify } from '../../src/core/verify.js';
import type { Event, TableName } from '../../src/core/fold/types.js';
import { PASSPHRASE } from '../db/helpers.js';

const AT = '2026-11-13T06:00:00.000Z';

interface EventPart {
  readonly kind: string;
  readonly subject: string;
  readonly payload: unknown;
}

function makeChain(parts: readonly EventPart[]): Event[] {
  let prev = GENESIS_PREV;
  return parts.map((part, index) => {
    const unsigned: Event = {
      id: `e-verify-${index + 1}`,
      at: AT,
      actor: 'tester',
      kind: part.kind,
      subject: part.subject,
      payload: part.payload,
      caused_by: [],
      request_id: `r-${index + 1}`,
      prev,
      hash: '',
    };
    const hash = computeEventHash(unsigned);
    prev = hash;
    return { ...unsigned, hash };
  });
}

test('P2-3: 手算 golden vector（期望 hex 写死，不复用 computeEventHash）', () => {
  const event: Event = {
    id: 'e-golden-1',
    at: '2026-11-13T00:00:00Z',
    actor: 'ag-1',
    kind: 'intent.proposed',
    subject: 'INT-9',
    payload: { statement: 'x' },
    caused_by: ['e-0'],
    request_id: 'req-1',
    prev: 'sha256:genesis',
    hash: '',
  };

  // 口径：sha256(canonicalJson(去 hash 的 event，含 prev) + prev)，前缀 sha256:。
  // 期望值 = sha256('{"actor":"ag-1",...,"prev":"sha256:genesis",...}' + 'sha256:genesis')
  assert.equal(
    computeEventHash(event),
    'sha256:2a6359fd2f31b388cc1a301cf6baefba777d2c6904085e856c09478327cc78e1',
  );
});

function events(): Event[] {
  return makeChain([
    { kind: 'decision.valid', subject: 'd-int', payload: { decision_kind: 'intent', payload_hash: 'ph-intent', payload: {}, frontier: 'f-1' } },
    { kind: 'decision.signed', subject: 'd-int', payload: { payload_hash: 'ph-intent', signature: 'sig', key_id: 'k-1', signer: 'alice' } },
    { kind: 'intent.signed', subject: 'INT-1', payload: { decision_id: 'd-int', statement: 'ship it', owner: 'alice', strength: 'explicit', baseline_hash: 'h-1', content_hash: 'ch-1' } },
    { kind: 'spec.defined', subject: 'SPEC-1', payload: { intent_id: 'INT-1', clause: 'clause', kind: 'requirement', content_hash: 'ch-spec' } },
    { kind: 'task.created', subject: 'TASK-1', payload: { seq: 1, title: 'do it', kind: 'implement' } },
    { kind: 'release.frozen', subject: 'REL-1', payload: { package_version: '0.2.0', frozen_by: '{"by":"tester"}', frontier: 'f-1', baseline_hash: 'h-1', scope_spec_set: 's-1', items: [] } },
  ]);
}

function insertEventRows(db: SdoDatabase, chain: readonly Event[]): void {
  const kinds = new Set(chain.map((event) => event.kind));
  for (const kind of kinds) {
    db.prepare('INSERT INTO event_kind (kind, since, note) VALUES (?, ?, ?)').run(kind, AT, 'verify test');
  }
  const insert = db.prepare(
    'INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const event of chain) {
    insert.run(
      event.id,
      event.at,
      event.actor,
      event.kind,
      event.subject,
      JSON.stringify(event.payload),
      JSON.stringify(event.caused_by),
      event.request_id,
      event.prev,
      event.hash,
    );
  }
}

function insertFoldRow(db: SdoDatabase, table: TableName, row: Readonly<Record<string, unknown>>): void {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>).map(
    (column) => String(column['name']),
  );
  const keys = Object.keys(row).filter((key) => columns.includes(key));
  const values = keys.map((key) => {
    const value = row[key];
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
  });
  db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(
    ...values,
  );
}

/** 建库：事件链 + 与 fold 一致的四张投影（decision/intent/spec/task/release）。 */
function withConsistentDb(run: (db: SdoDatabase) => void, chain: readonly Event[] = events()): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m0-6-verify-'));
  const db = openEncryptedDatabase(join(dir, 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    insertEventRows(db, chain);
    const state = fold(undefined, chain).tables;
    for (const table of ['decision', 'intent', 'spec', 'task', 'release'] as const) {
      for (const row of Object.values(state[table])) {
        insertFoldRow(db, table, row);
      }
    }
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}


test('C4 正例：事件链与投影一致 ⇒ ok，事件数正确', () => {
  withConsistentDb((db) => {
    const report = verify(db);

    assert.equal(report.ok, true);
    assert.equal(report.eventCount, 6);
    assert.deepEqual(report.problems, []);
  });
});

test('C4 负例：直改 task 投影行 ⇒ runtime_inconsistent 且指出对象 id', () => {
  withConsistentDb((db) => {
    db.prepare("UPDATE task SET title = 'tampered' WHERE id = 'TASK-1'").run();

    const report = verify(db);
    assert.equal(report.ok, false);
    const problem = report.problems.find((candidate) => candidate.code === 'runtime_inconsistent');
    assert.equal(problem?.table, 'task');
    assert.equal(problem?.objectId, 'TASK-1');
    assert.match(problem?.detail ?? '', /column title differs/u);
  });
});

test('C4 负例：事件 hash 被换 / prev 断裂 ⇒ 分别报 event_hash_mismatch / event_chain_broken', () => {
  // 事件表有 append-only 触发器，模拟“绕过库层改盘”的链：直接构造坏链再写库。
  const chain = events().map((event) => {
    if (event.id === 'e-verify-2') return { ...event, hash: 'sha256:deadbeef' };
    if (event.id === 'e-verify-3') return { ...event, prev: 'sha256:nope' };
    return event;
  });
  withConsistentDb((db) => {
    const report = verify(db);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.code === 'event_hash_mismatch' && problem.objectId === 'e-verify-2'));
    assert.ok(report.problems.some((problem) => problem.code === 'event_chain_broken' && problem.objectId === 'e-verify-3'));
  }, chain);
});

test('C4 负例：投影行缺失 ⇒ projection_missing；多出 ⇒ projection_unexpected', () => {
  withConsistentDb((db) => {
    db.prepare("DELETE FROM task WHERE id = 'TASK-1'").run();
    db.prepare(
      "INSERT INTO task (id, seq, title, kind, created_by, status, at) VALUES ('TASK-9', 9, 'ghost', 'implement', 'tester', 'planned', ?)",
    ).run(AT);

    const report = verify(db);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.code === 'projection_missing' && problem.objectId === 'TASK-1'));
    assert.ok(report.problems.some((problem) => problem.code === 'projection_unexpected' && problem.objectId === 'TASK-9'));
  });
});

test('P3: 缺表时 verify 返回 projection_check_failed 而不是裸 SQLite 异常', () => {
  withConsistentDb((db) => {
    db.exec('DROP TABLE task');

    const report = verify(db);

    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => problem.code === 'projection_check_failed'));
  });
});
