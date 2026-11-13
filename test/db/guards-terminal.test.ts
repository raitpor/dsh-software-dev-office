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

function seedDeliveredRelease(db: SdoDatabase, id = 'r1'): void {
  db.prepare(
    `INSERT INTO release (id, package_version, status, frozen_at, frozen_by, frontier, baseline_hash, scope_spec_set, note)
     VALUES (?, NULL, 'draft', NULL, NULL, 'f0', 'bh-1', '[]', NULL)`,
  ).run(id);
  db.prepare(
    "UPDATE release SET status = 'frozen', frozen_at = ?, frozen_by = '{\"human\":\"alice\"}' WHERE id = ?",
  ).run(AT, id);
  db.prepare("UPDATE release SET status = 'delivered' WHERE id = ?").run(id);
}

function seedPassingVerify(db: SdoDatabase, id: string, actor: string): void {
  db.prepare(
    "INSERT INTO verify_run (id, at, actor_kind, actor, groups, result, signed_by, note) VALUES (?, ?, 'service', ?, '[]', 'pass', NULL, NULL)",
  ).run(id, AT, actor);
}

function seedOpenDefect(db: SdoDatabase, id = 'x1'): void {
  db.prepare(
    "INSERT INTO defect (id, criterion_id, spec_id, task_id, kind, severity, family, status, evidence, verify_run_id, closed_by, at) VALUES (?, 'c-1', NULL, NULL, 'criterion', 'low', NULL, 'open', NULL, NULL, NULL, ?)",
  ).run(id, AT);
}

function closeDefect(db: SdoDatabase, id: string, verifyId: string, closedBy: string): void {
  db.prepare("UPDATE defect SET status = 'closed', verify_run_id = ?, closed_by = ? WHERE id = ?").run(
    verifyId,
    closedBy,
    id,
  );
}

test('regression: delivered release is immutable and cannot move back', () => {
  withMigratedDb((db) => {
    seedDeliveredRelease(db);

    const note = capture(() => db.prepare("UPDATE release SET note = 'x' WHERE id = 'r1'").run());
    assert.match(note.message, /release is frozen: only status transitions/);
    const version = capture(() => db.prepare("UPDATE release SET package_version = '9.9.9' WHERE id = 'r1'").run());
    assert.match(version.message, /release is frozen: only status transitions/);
    const toDraft = capture(() => db.prepare("UPDATE release SET status = 'draft' WHERE id = 'r1'").run());
    assert.match(toDraft.message, /invalid release status transition/);
    const toFrozen = capture(() => db.prepare("UPDATE release SET status = 'frozen' WHERE id = 'r1'").run());
    assert.match(toFrozen.message, /invalid release status transition/);
  });
});

test('regression: closed defect closed_by must equal the verify_run actor', () => {
  withMigratedDb((db) => {
    seedPassingVerify(db, 'v-pass', 'ci');
    seedOpenDefect(db);

    const mismatch = capture(() => closeDefect(db, 'x1', 'v-pass', 'bob'));
    assert.match(mismatch.message, /closed_by must equal verify_run\.actor/);

    closeDefect(db, 'x1', 'v-pass', 'ci');
    assert.equal((db.prepare("SELECT status FROM defect WHERE id = 'x1'").get() as { status: string } | undefined)?.status, 'closed');
  });
});

test('regression: closed is terminal (reopen and evidence swap rejected)', () => {
  withMigratedDb((db) => {
    seedPassingVerify(db, 'v-pass', 'ci');
    seedPassingVerify(db, 'v-other', 'alice');
    seedOpenDefect(db);
    closeDefect(db, 'x1', 'v-pass', 'ci');

    const reopen = capture(() => db.prepare("UPDATE defect SET status = 'open', verify_run_id = NULL WHERE id = 'x1'").run());
    assert.match(reopen.message, /closed defect is terminal/);
    const swap = capture(() => closeDefect(db, 'x1', 'v-other', 'alice'));
    assert.match(swap.message, /closed defect is terminal/);
  });
});
