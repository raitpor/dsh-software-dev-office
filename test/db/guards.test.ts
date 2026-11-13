import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SdoDatabase } from '../../src/db/driver.js';
import { withMigratedDb } from './helpers.js';

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

function seedEvent(db: SdoDatabase, id = 'e1', hash = 'h1', payload = '{"a":1}'): void {
  db.prepare("INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES ('intent.signed', ?, 'test')").run(AT);
  db.prepare(
    `INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash)
     VALUES (?, ?, 'alice', 'intent.signed', 'intent/i1', ?, '[]', 'r1', 'f0', ?)`,
  ).run(id, AT, payload, hash);
}

function seedBaseline(db: SdoDatabase, id = 'b1', hash = 'bh1'): void {
  db.prepare(
    `INSERT INTO baseline (id, frozen_by, engine_version, criteria_manifest_hash, policy, criteria, gates, thresholds, assurance, prev, direction, hash, at)
     VALUES (?, 'alice', '0.3.0', 'cm-1', '{}', '[]', '[]', '{}', '{}', NULL, NULL, ?, ?)`,
  ).run(id, hash, AT);
}

function seedRelease(db: SdoDatabase, id = 'r1'): void {
  db.prepare(
    `INSERT INTO release (id, package_version, status, frozen_at, frozen_by, frontier, baseline_hash, scope_spec_set, note)
     VALUES (?, NULL, 'draft', NULL, NULL, 'f0', 'bh-1', '[]', NULL)`,
  ).run(id);
}

function freeze(db: SdoDatabase, id = 'r1'): void {
  db.prepare("UPDATE release SET status = 'frozen', frozen_at = ?, frozen_by = '{\"human\":\"alice\"}' WHERE id = ?").run(AT, id);
}

test('guard: INSERT OR REPLACE cannot bypass event append-only (recursive_triggers=ON)', () => {
  withMigratedDb((db) => {
    seedEvent(db, 'e1', 'h1');
    const replace = (hash: string): void => {
      db.prepare(
        `INSERT OR REPLACE INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash)
         VALUES ('e1', ?, 'alice', 'intent.signed', 'intent/i1', '{"a":2}', '[]', 'r2', 'f0', ?)`,
      ).run(AT, hash);
    };

    const error = capture(() => replace('h2'));
    assert.match(error.message, /event is append-only: DELETE rejected/);
    assert.equal((db.prepare("SELECT hash FROM event WHERE id = 'e1'").get() as { hash: string } | undefined)?.hash, 'h1');

    // 负例对照：默认 recursive_triggers=OFF 时 REPLACE 确实会换掉内容（这就是护栏必须开它的原因）。
    db.pragma('recursive_triggers = OFF');
    replace('h2');
    assert.equal((db.prepare("SELECT hash FROM event WHERE id = 'e1'").get() as { hash: string } | undefined)?.hash, 'h2');
  });
});

test('guard: INSERT OR REPLACE cannot bypass baseline append-only', () => {
  withMigratedDb((db) => {
    seedBaseline(db, 'b1', 'bh1');
    const error = capture(() =>
      db.prepare(
        `INSERT OR REPLACE INTO baseline (id, frozen_by, engine_version, criteria_manifest_hash, policy, criteria, gates, thresholds, assurance, prev, direction, hash, at)
         VALUES ('b1', 'mallory', '9.9.9', 'cm-2', '{}', '[]', '[]', '{}', '{}', NULL, NULL, 'bh2', ?)`,
      ).run(AT),
    );
    assert.match(error.message, /baseline is append-only: DELETE rejected/);
  });
});

test('guard: INSERT OR REPLACE cannot bypass release no-delete', () => {
  withMigratedDb((db) => {
    seedRelease(db);
    const error = capture(() =>
      db.prepare(
        `INSERT OR REPLACE INTO release (id, package_version, status, frozen_at, frozen_by, frontier, baseline_hash, scope_spec_set, note)
         VALUES ('r1', '9.9.9', 'frozen', ?, '{"human":"mallory"}', 'f9', 'bh-9', '[]', NULL)`,
      ).run(AT),
    );
    assert.match(error.message, /release rows are never deleted/);
  });
});

test('guard: frozen release cannot go back to draft nor change fields (two steps both rejected)', () => {
  withMigratedDb((db) => {
    seedRelease(db);
    freeze(db);

    const back = capture(() => db.prepare("UPDATE release SET status = 'draft' WHERE id = 'r1'").run());
    assert.match(back.message, /invalid release status transition/);
    const edit = capture(() => db.prepare("UPDATE release SET baseline_hash = 'bh-2' WHERE id = 'r1'").run());
    assert.match(edit.message, /release is frozen: only status transitions/);
    const sameStatus = capture(() => db.prepare("UPDATE release SET note = 'x' WHERE id = 'r1'").run());
    assert.match(sameStatus.message, /release is frozen: only status transitions/);

    db.prepare("UPDATE release SET status = 'delivered' WHERE id = 'r1'").run();
    assert.equal((db.prepare("SELECT status FROM release WHERE id = 'r1'").get() as { status: string } | undefined)?.status, 'delivered');
  });
});

test('guard: release INSERT status=frozen needs frozen_at/frozen_by; release_item enums enforced', () => {
  withMigratedDb((db) => {
    const naked = capture(() =>
      db.prepare(
        "INSERT INTO release (id, status, frontier, baseline_hash, scope_spec_set) VALUES ('rx', 'frozen', 'f0', 'bh', '[]')",
      ).run(),
    );
    assert.match(naked.message, /CHECK constraint failed/);

    seedRelease(db);
    const badKind = capture(() =>
      db.prepare("INSERT INTO release_item (release_id, kind, target, disposition) VALUES ('r1', 'mystery', 'x', 'in')").run(),
    );
    assert.match(badKind.message, /CHECK constraint failed/);
    const badDisposition = capture(() =>
      db.prepare("INSERT INTO release_item (release_id, kind, target, disposition) VALUES ('r1', 'spec', 'x', 'sideways')").run(),
    );
    assert.match(badDisposition.message, /CHECK constraint failed/);
    const outWithoutReason = capture(() =>
      db.prepare("INSERT INTO release_item (release_id, kind, target, disposition) VALUES ('r1', 'spec', 'x', 'out')").run(),
    );
    assert.match(outWithoutReason.message, /CHECK constraint failed/);
  });
});

test('guard: defect closes only on a passing verify_run', () => {
  withMigratedDb((db) => {
    db.prepare(
      "INSERT INTO verify_run (id, at, actor_kind, actor, groups, result, signed_by, note) VALUES ('v-fail', ?, 'service', 'ci', '[]', 'fail', NULL, NULL)",
    ).run(AT);
    db.prepare(
      "INSERT INTO defect (id, criterion_id, spec_id, task_id, kind, severity, family, status, evidence, verify_run_id, closed_by, at) VALUES ('x1', 'c-1', NULL, NULL, 'criterion', 'low', NULL, 'open', NULL, NULL, NULL, ?)",
    ).run(AT);

    const error = capture(() =>
      db.prepare("UPDATE defect SET status = 'closed', verify_run_id = 'v-fail', closed_by = 'ci' WHERE id = 'x1'").run(),
    );
    assert.match(error.message, /defect close requires verify_run\.result = pass/);
  });
});

test('guard: attention.withdrawn_by must equal raised_by (CHECK, database layer)', () => {
  withMigratedDb((db) => {
    db.prepare(
      "INSERT INTO task (id, seq, title, kind, created_by, status, blocked_by, scope_paths, inputs, at) VALUES ('t1', 1, 'card', 'implement', 'pm', 'ready', '[]', '[]', '[]', ?)",
    ).run(AT);
    const insert = (withdrawnBy: string | null): void => {
      db.prepare(
        "INSERT INTO attention (id, task_id, raised_by, asked_of, question, options, state, expires_at, answered_by, withdrawn_by, supersedes, at) VALUES (?, 't1', 'alice', 'bob', 'q', '[]', 'open', ?, NULL, ?, NULL, ?)",
      ).run(`a-${String(withdrawnBy)}`, AT, withdrawnBy, AT);
    };

    const error = capture(() => insert('bob'));
    assert.match(error.message, /CHECK constraint failed/);
    insert('alice');
  });
});

test('guard: goal_node.acceptance_criterion_id points at criterion(id) (FK)', () => {
  withMigratedDb((db) => {
    db.prepare(
      "INSERT INTO decision (id, decision_kind, status, payload, payload_hash, signature, key_id, signer, frontier, at) VALUES ('d1','intent','valid','{}','ph','sig','key','alice','f0',?)",
    ).run(AT);
    const error = capture(() =>
      db.prepare(
        "INSERT INTO goal_node (id, decision_id, goal, kind, acceptance_criterion_id, scope_paths, at) VALUES ('g1', 'd1', 'g', 'part', 'missing-criterion', '[]', ?)",
      ).run(AT),
    );
    assert.match(error.message, /FOREIGN KEY constraint failed/);
  });
});
