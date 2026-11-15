import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalJson } from '../../src/core/fold/canonical.js';
import { valueHash } from '../../src/core/conflict/hash.js';
import { trackedField } from '../../src/core/conflict/scope.js';
import { computeEventHash } from '../../src/core/verify.js';
import type { Event } from '../../src/core/fold/types.js';
import { append, chainHead } from '../../src/db/write.js';
import { requiredTable } from '../../src/db/write-materialize.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { chain, currentState, withWriteDb } from './append-helpers.js';
import { worldSeeds } from './world-seeds.js';

const seeds = worldSeeds();

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
  const field = trackedField(base.kind);
  let withClaim = payload;
  if (field !== undefined) {
    const state = currentState(db);
    const table = requiredTable(base.kind);
    const row = table === undefined ? undefined : state.tables[table][base.subject];
    withClaim = { ...(typeof payload === 'object' && payload !== null ? payload : {}), field, base_hash: valueHash(row?.[field] ?? null) };
  }
  const next: Event = {
    ...base,
    id: `${base.id}-${suffix}`,
    payload: withClaim,
    prev: chainHead(db),
    hash: '',
  };
  return { ...next, hash: computeEventHash(next) };
}

for (const [kind, mutation] of Object.entries(CASES)) {
  const index = seeds.findIndex((seed) => seed.kind === kind);
  const table = requiredTable(kind)!;

  test(`P1-1 ${kind}: same event id is skipped by the append gateway before fold (row unchanged)`, () => {
    withWriteDb((db) => {
      const events = chain(seeds);
      const prefix = events.slice(0, index + 1);
      const base = events[index]!;
      assert.equal(append(db, prefix).ok, true);
      const rows = tableRows(db, table);
      assert.equal(append(db, [base]).ok, true, 'same event id replay must be skipped, not rejected');
      assert.equal(tableRows(db, table), rows);
    });
  });

  test(`P1-1 ${kind}: same id with different content fails materialize and preserves the row`, () => {
    withWriteDb((db) => {
      const events = chain(seeds);
      const prefix = events.slice(0, index + 1);
      const base = events[index]!;
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


test('P1-1 stage.entered 走 createOnce 后，stage.exited 仍能 patch 同一行', () => {
  // `gate.judged` 走 judgeStage 真路径（无测试缝），其 patch 语义在 test/db/gate-judged.test.ts 覆盖。
  withWriteDb((db) => {
    const events = chain(worldSeeds());
    assert.equal(append(db, events).ok, true);
    const row = db.prepare('SELECT * FROM stage_run WHERE id = ?').get('SR-1') as Record<string, unknown>;
    assert.equal(row['verdict'], 'pass');
    assert.notEqual(row['exited_at'], null);
    assert.equal(row['gate_id'], null, 'world 链不含 gate.judged；判定行由 judgeStage 真路径产生');
  });
});
