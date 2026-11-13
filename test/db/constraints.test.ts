import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import Database from 'better-sqlite3-multiple-ciphers';

import type { SdoDatabase } from '../../src/db/driver.js';
import { pragmaRows, withMigratedDb } from './helpers.js';

const AT = '2026-11-13T00:00:00.000Z';

function capture(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the statement to be rejected by the database');
}

function seedDecision(db: SdoDatabase, id = 'd1'): void {
  db.prepare(
    `INSERT INTO decision (id, decision_kind, status, payload, payload_hash, signature, key_id, signer, frontier, at)
     VALUES (?, 'intent', 'valid', '{}', 'ph-1', 'sig-1', 'key-1', 'alice', 'f0', ?)`,
  ).run(id, AT);
}

function seedIntent(db: SdoDatabase, id = 'i1', decisionId = 'd1'): void {
  db.prepare(
    `INSERT INTO intent (id, statement, source_text, owner, decision_id, strength, baseline_hash, content_hash, at)
     VALUES (?, 'statement', 'source', 'alice', ?, 'explicit', 'bh-0', 'ch-1', ?)`,
  ).run(id, decisionId, AT);
}

function insertGoal(
  db: SdoDatabase,
  id: string,
  intentId: string | null,
  kind = 'intent',
): void {
  db.prepare(
    `INSERT INTO goal_node (id, parent_id, intent_id, decision_id, goal, kind, acceptance_criterion_id, scope_paths, at)
     VALUES (?, NULL, ?, 'd1', 'goal', ?, NULL, '[]', ?)`,
  ).run(id, intentId, kind, AT);
}

test('constraint: ux_goal_root rejects a second root per intent (partial unique index)', () => {
  withMigratedDb((db) => {
    seedDecision(db);
    seedIntent(db);
    insertGoal(db, 'g1', 'i1');
    const error = capture(() => insertGoal(db, 'g2', 'i1'));
    assert.match(error.message, /UNIQUE constraint failed: goal_node\.intent_id/);
    insertGoal(db, 'g3', null, 'part'); // 非根不受 ux_goal_root 限制
    assert.equal(pragmaRows(db, 'index_list(goal_node)').some((row) => row['name'] === 'ux_goal_root'), true);
  });
});

test('constraint: event is append-only at the database layer (UPDATE/DELETE rejected)', () => {
  withMigratedDb((db) => {
    db.prepare("INSERT INTO event_kind (kind, since, note) VALUES ('intent.signed', ?, 'test')").run(AT);
    db.prepare(
      `INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash)
       VALUES ('e1', ?, 'alice', 'intent.signed', 'intent/i1', '{"a":1}', '[]', 'r1', 'f0', 'h1')`,
    ).run(AT);

    const update = capture(() => db.prepare("UPDATE event SET payload = '{\"a\":2}' WHERE id = 'e1'").run());
    assert.match(update.message, /event is append-only: UPDATE rejected/);
    const remove = capture(() => db.prepare("DELETE FROM event WHERE id = 'e1'").run());
    assert.match(remove.message, /event is append-only: DELETE rejected/);
  });
});

test('constraint: baseline is append-only (UPDATE/DELETE rejected)', () => {
  withMigratedDb((db) => {
    db.prepare(
      `INSERT INTO baseline (id, frozen_by, engine_version, criteria_manifest_hash, policy, criteria, gates, thresholds, assurance, prev, direction, hash, at)
       VALUES ('b1', 'alice', '0.3.0', 'cm-1', '{}', '[]', '[]', '{}', '{}', NULL, NULL, 'bh-1', ?)`,
    ).run(AT);

    const update = capture(() => db.prepare("UPDATE baseline SET hash = 'bh-2' WHERE id = 'b1'").run());
    assert.match(update.message, /baseline is append-only: UPDATE rejected/);
    const remove = capture(() => db.prepare("DELETE FROM baseline WHERE id = 'b1'").run());
    assert.match(remove.message, /baseline is append-only: DELETE rejected/);
  });
});

test('constraint: defect cannot close without verify_run_id + closed_by', () => {
  withMigratedDb((db) => {
    db.prepare(
      "INSERT INTO defect (id, criterion_id, spec_id, task_id, kind, severity, family, status, evidence, verify_run_id, closed_by, at) VALUES ('x1', 'c-1', NULL, NULL, 'criterion', 'low', NULL, 'open', NULL, NULL, NULL, ?)",
    ).run(AT);

    const rejected = capture(() => db.prepare("UPDATE defect SET status = 'closed' WHERE id = 'x1'").run());
    assert.match(rejected.message, /CHECK constraint failed/);

    db.prepare(
      "INSERT INTO verify_run (id, at, actor_kind, actor, groups, result, signed_by, note) VALUES ('v1', ?, 'service', 'ci', '[]', 'pass', NULL, NULL)",
    ).run(AT);
    db.prepare("UPDATE defect SET status = 'closed', verify_run_id = 'v1', closed_by = 'ci' WHERE id = 'x1'").run();
    assert.equal(pragmaRows(db, "table_info(defect)").length > 0, true);
  });
});

test('constraint: a frozen release is immutable and never deleted', () => {
  withMigratedDb((db) => {
    db.prepare(
      `INSERT INTO release (id, package_version, status, frozen_at, frozen_by, frontier, baseline_hash, scope_spec_set, note)
       VALUES ('r1', NULL, 'draft', NULL, NULL, 'f0', 'bh-1', '[]', NULL)`,
    ).run();
    db.prepare(
      "UPDATE release SET status = 'frozen', frozen_at = ?, frozen_by = '{\"human\":\"alice\"}' WHERE id = 'r1'",
    ).run(AT);

    const edit = capture(() => db.prepare("UPDATE release SET baseline_hash = 'bh-2' WHERE id = 'r1'").run());
    assert.match(edit.message, /release is frozen: only status transitions/);
    const remove = capture(() => db.prepare("DELETE FROM release WHERE id = 'r1'").run());
    assert.match(remove.message, /release rows are never deleted/);

    db.prepare("UPDATE release SET status = 'delivered', package_version = '2.0.0' WHERE id = 'r1'").run();
  });
});

test('constraint: foreign keys are ON for every driver connection, orphan insert rejected', () => {
  withMigratedDb((db) => {
    const fk = pragmaRows(db, 'foreign_keys')[0]?.['foreign_keys'];
    assert.equal(fk, 1, 'openEncryptedDatabase must enable PRAGMA foreign_keys');

    const error = capture(() =>
      db.prepare(
        "INSERT INTO evidence (id, criterion_id, artifact_uri, artifact_sha256, command, output_digest, snapshot_id, at) VALUES ('ev1', 'missing-criterion', 'file:///x', 'sha', 'cmd', NULL, NULL, ?)",
      ).run(AT),
    );
    assert.match(error.message, /FOREIGN KEY constraint failed/);
  });
});

test('constraint: FK enforcement follows the per-connection switch (negative control)', () => {
  // 本驱动编译了 DEFAULT_FOREIGN_KEYS，裸连接默认就是 ON；所以负例只能显式关掉来演示开关真的起作用。
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m0-1-fk-'));
  try {
    const plain = new Database(join(dir, 'plain.db'));
    try {
      plain.exec('CREATE TABLE parent (id TEXT PRIMARY KEY); CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parent(id));');
      assert.equal(pragmaRows(plain, 'foreign_keys')[0]?.['foreign_keys'], 1, 'driver default is FK=ON (DEFAULT_FOREIGN_KEYS)');

      plain.pragma('foreign_keys = OFF');
      assert.equal(pragmaRows(plain, 'foreign_keys')[0]?.['foreign_keys'], 0);
      plain.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('c1', 'missing');
      assert.equal(pragmaRows(plain, 'table_info(child)').length > 0, true);

      plain.pragma('foreign_keys = ON');
      assert.throws(
        () => plain.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('c2', 'missing'),
        /FOREIGN KEY constraint failed/,
      );
    } finally {
      plain.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
