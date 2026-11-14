import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalJson } from '../../src/core/fold/canonical.js';
import { computeEventHash } from '../../src/core/verify.js';
import type { Event } from '../../src/core/fold/types.js';
import { append, chainHead } from '../../src/db/write.js';
import { requiredTable } from '../../src/db/write-materialize.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { chain, withWriteDb } from './append-helpers.js';
import { worldSeeds } from './world-seeds.js';

const seeds = worldSeeds();
const events = chain(seeds);

interface Mutation {
  readonly field: string;
  readonly value: unknown;
}

const CASES: Readonly<Record<string, Mutation>> = {
  'attention.raised': { field: 'question', value: 'mutated?' },
  'defect.recorded': { field: 'severity', value: 'high' },
  'goal.declared': { field: 'scope_paths', value: ['src/evil'] },
  'goal.integrated': { field: 'note', value: 'mutated' },
  'review.recorded': { field: 'reason', value: 'mutated' },
  'review.round_closed': { field: 'signer', value: 'mallory' },
  'snapshot.taken': { field: 'git_oid', value: 'mutated' },
  // P2：DB 层再抽四个 append 主路径 kind（其余只有 fold 层证据，卡里写明）。
  'task.created': { field: 'title', value: 'mutated' },
  'criterion.registered': { field: 'remedy', value: 'mutated remedy' },
  'evidence.attached': { field: 'command', value: 'echo mutated' },
  'release.frozen': { field: 'frontier', value: 'f-mut' },
  // 第 3 轮 P1：verify_run / stage_run / intent 三个“首写即定”主路径也补 DB 层。
  'verify.passed': { field: 'note', value: 'mutated' },
  'verify.failed': { field: 'note', value: 'mutated' },
  'stage.entered': { field: 'stage', value: 'MutatedStage' },
  'intent.signed': { field: 'content_hash', value: 'ch-mut' },
};

function tableRows(db: SdoDatabase, table: string): string {
  return canonicalJson(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all());
}

function eventCount(db: SdoDatabase): number {
  return (db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n;
}

function continuation(db: SdoDatabase, base: Event, payload: unknown, suffix: string): Event {
  const next: Event = {
    ...base,
    id: `${base.id}-${suffix}`,
    payload,
    prev: chainHead(db),
    hash: '',
  };
  return { ...next, hash: computeEventHash(next) };
}

for (const [kind, mutation] of Object.entries(CASES)) {
  const index = seeds.findIndex((seed) => seed.kind === kind);
  const prefix = events.slice(0, index + 1);
  const base = events[index]!;
  const table = requiredTable(kind)!;

  test(`P1-1 ${kind}: same event id is skipped by the append gateway before fold (row unchanged)`, () => {
    withWriteDb((db) => {
      assert.equal(append(db, prefix).ok, true);
      const rows = tableRows(db, table);
      assert.equal(append(db, [base]).ok, true, 'same event id replay must be skipped, not rejected');
      assert.equal(tableRows(db, table), rows);
    });
  });

  test(`P1-1 ${kind}: same id with different content fails materialize and preserves the row`, () => {
    withWriteDb((db) => {
      assert.equal(append(db, prefix).ok, true);
      const rows = tableRows(db, table);
      const replay = continuation(db, base, base.payload, 'same-content');
      assert.equal(append(db, [replay]).ok, true);
      const afterReplayRows = tableRows(db, table);
      assert.equal(afterReplayRows, rows, 'identical content must not change the projection');
      const beforeCount = eventCount(db);

      const mutatedPayload = { ...(base.payload as Record<string, unknown>), [mutation.field]: mutation.value };
      const mutated = continuation(db, base, mutatedPayload, 'mutated');
      const result = append(db, [mutated]);
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'materialize_failed');
      assert.match(result.message ?? '', /already exists with different content; this projection is append-only/u);
      assert.equal(tableRows(db, table), rows, 'original row must be preserved');
      assert.equal(eventCount(db), beforeCount, 'failed append must not add events');
    });
  });
}


test('P1-1 stage.entered 走 createOnce 后，stage.exited / gate.judged 仍能正常 patch 同一行', () => {
  const enteredIndex = seeds.findIndex((seed) => seed.kind === 'stage.entered');
  const judgedIndex = seeds.findIndex((seed) => seed.kind === 'gate.judged');
  const exitedIndex = seeds.findIndex((seed) => seed.kind === 'stage.exited');
  assert.ok(enteredIndex >= 0 && judgedIndex > enteredIndex && exitedIndex > judgedIndex);
  const stageId = seeds[enteredIndex]!.subject;

  withWriteDb((db) => {
    assert.equal(append(db, events.slice(0, judgedIndex + 1)).ok, true);
    const judged = db.prepare('SELECT * FROM stage_run WHERE id = ?').get(stageId) as Record<string, unknown>;
    assert.equal(judged['gate_id'], 'G_req_exit');
    assert.equal(judged['exited_at'], null, 'gate.judged 之前的 stage.entered 行还没有 exited_at');

    assert.equal(append(db, events.slice(0, exitedIndex + 1)).ok, true);
    const exited = db.prepare('SELECT * FROM stage_run WHERE id = ?').get(stageId) as Record<string, unknown>;
    assert.equal(exited['verdict'], 'pass');
    assert.notEqual(exited['exited_at'], null);
  });
});
