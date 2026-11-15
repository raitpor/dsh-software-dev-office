import { appendAs as append } from './append-auth.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fold } from '../../src/core/fold/index.js';
import { GENESIS_PREV, readEvents } from '../../src/core/verify-events.js';
import type { VerifyProblem } from '../../src/core/verify-types.js';
import { verify } from '../../src/core/verify.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import {
  FOLD_ONLY_COLUMNS,
  MATERIALIZED_TABLES,
  SUPPORTED_KINDS,
} from '../../src/db/write-materialize.js';

import { chain, currentState, seed, withWriteDb } from './append-helpers.js';
import { worldSeeds } from './world-seeds.js';

function count(db: SdoDatabase, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function head(db: SdoDatabase): string {
  const row = db.prepare('SELECT hash FROM event ORDER BY rowid DESC LIMIT 1').get() as { hash: string } | undefined;
  return row?.hash ?? GENESIS_PREV;
}

function columns(db: SdoDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

// M2-3/D-078：`assumption.invalidated` 仍是 SUPPORTED_KINDS（003 兼容），但语义是派生读数、写入一律拒，
// 因此 world 链不含它；其余 55 个 kind 仍逐一覆盖。
const DERIVED_ONLY_KINDS = new Set(['assumption.invalidated']);
// `gate.judged` 只能由 `judgeStage()` 真路径产生（没有测试缝可铸授权）；
// 真实判定行/版本绑定的覆盖在 test/db/gate-judged.test.ts，本文件只验证 world 可写子集。
const GATE_ONLY_KINDS = new Set(['gate.judged']);
// M3-2/P1-3：conflict.* 只能由真 CAS 路径产生（一次性能力），world 链不含；
// 冲突行/解决覆盖在 test/db/conflict-*.test.ts。
const CONFLICT_ONLY_KINDS = new Set(['conflict.detected', 'conflict.resolved']);

test('C5/C6: world chain appends all supported kinds; each target table gets real rows', () => {
  withWriteDb((db) => {
    const events = chain(worldSeeds());
    const result = append(db, events);
    assert.equal(result.ok, true, result.message ?? '');
    assert.equal(result.written, events.length);
    assert.equal(count(db, 'event'), events.length);
    const report = verify(db);
    assert.equal(report.ok, true, JSON.stringify(report.problems.slice(0, 3)));
    assert.equal(report.eventCount, events.length);

    const kinds = new Set(events.map((event) => event.kind));
    assert.equal(Object.keys(SUPPORTED_KINDS).length, 58);
    assert.equal(kinds.size, 58 - DERIVED_ONLY_KINDS.size - GATE_ONLY_KINDS.size - CONFLICT_ONLY_KINDS.size);
    for (const kind of Object.keys(SUPPORTED_KINDS)) {
      if (DERIVED_ONLY_KINDS.has(kind) || GATE_ONLY_KINDS.has(kind) || CONFLICT_ONLY_KINDS.has(kind)) continue;
      assert.equal(kinds.has(kind), true, `world chain is missing kind ${kind}`);
    }
    // decision.valid 按 D-019 只在 signed 后出现，行由 decision.signed 代表。
    // conflict 行由 CAS 分支产生，world 链不含 conflict.*；见 test/db/conflict-*.test.ts。
    const tables = new Set(MATERIALIZED_TABLES.filter((table) => table !== 'decision' && table !== 'conflict'));
    for (const table of tables) {
      assert.ok(count(db, table) > 0, `materialized table ${table} has no rows`);
    }
    assert.ok(count(db, 'decision') > 0);
  });
});

test('C4: same batch replay is idempotent (zero writes, zero new events)', () => {
  withWriteDb((db) => {
    const events = chain(worldSeeds());
    assert.equal(append(db, events).ok, true);
    const replay = append(db, events);
    assert.equal(replay.ok, true);
    assert.equal(replay.written, 0);
    assert.equal(replay.skipped, events.length);
    assert.equal(count(db, 'event'), events.length);
  });
});

test('C1: id-less tables use DDL primary keys (config/snapshot_parent/release_item)', () => {
  withWriteDb((db) => {
    const events = chain(worldSeeds());
    assert.equal(append(db, events).ok, true);
    assert.equal(count(db, 'snapshot_parent'), 1);
    assert.equal(count(db, 'release_item'), 2);
    assert.deepEqual(columns(db, 'config').includes('id'), false);
    // 同一 config 键第二次 change 是更新，不是 UNIQUE 冲突。
    const next = chain([
      seed(200, 'config.changed', 'limits.max_payload_bytes', { after: 8192, actor: 'bob' }),
    ], head(db), currentState(db));
    assert.equal(append(db, next).ok, true);
    assert.equal(count(db, 'config'), 1);
    const row = db.prepare('SELECT value, updated_by FROM config WHERE key = ?').get('limits.max_payload_bytes');
    assert.deepEqual({ ...(row as object) }, { value: 8192, updated_by: 'bob' });
  });
});

test('C2: actual fold-only columns equal FOLD_ONLY_COLUMNS for every materialized table', () => {
  withWriteDb((db) => {
    const events = chain(worldSeeds());
    assert.equal(append(db, events).ok, true);
    const problems: VerifyProblem[] = [];
    const state = fold(undefined, readEvents(db, problems));
    for (const table of MATERIALIZED_TABLES) {
      const rows = Object.values(state.tables[table]);
      if (rows.length === 0) continue;
      const ddl = new Set(columns(db, table));
      const actual = new Set<string>();
      for (const row of rows) {
        for (const key of Object.keys(row)) if (!ddl.has(key)) actual.add(key);
      }
      assert.deepEqual([...actual].sort(), [...(FOLD_ONLY_COLUMNS[table] ?? [])].sort(), `fold-only columns drifted for ${table}`);
    }
  });
});

test('C7: append-only projection rejects same id with different content and rolls back', () => {
  withWriteDb((db) => {
    const events = chain(worldSeeds());
    assert.equal(append(db, events).ok, true);
    const before = count(db, 'event');
    const conflict = chain([
      seed(300, 'restatement.diff_dispositioned', 'RD-1', {
        restatement_id: 'R-1', kind: 'agree', target_ref: 'd1', disposition: 'reject',
      }),
    ], head(db));
    const result = append(db, conflict);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'materialize_failed');
    assert.match(result.message ?? '', /already exists with different content/u);
    assert.equal(result.rolled_back, true);
    assert.equal(count(db, 'event'), before);
    assert.equal(verify(db).ok, true);
  });
});

test('C3: release.frozen rejects a single human signer (fold shape, not DDL)', () => {
  withWriteDb((db) => {
    const events = chain([
      seed(400, 'release.frozen', 'REL-X', {
        frozen_by: ['alice'], frontier: 'f', baseline_hash: 'bh', scope_spec_set: 's', items: [],
      }),
    ]);
    const result = append(db, events);
    assert.equal(result.ok, false);
    assert.match(result.message ?? '', /at least two humans/u);
    assert.equal(count(db, 'event'), 0);
  });
});

test('C4: stage_run gate fields are null after entered (real judged row covered by gate-judged.test)', () => {
  withWriteDb((db) => {
    const seeds = worldSeeds();
    const entered = seeds.findIndex((event) => event.kind === 'stage.entered');
    assert.ok(entered >= 0);
    assert.equal(append(db, chain(seeds.slice(0, entered + 1))).ok, true);
    const initial = db.prepare('SELECT gate_id, baseline_hash FROM stage_run WHERE id = ?').get('SR-1');
    assert.deepEqual({ ...(initial as object) }, { gate_id: null, baseline_hash: null });
    // `gate.judged` 只能由 judgeStage() 真路径产生（P1 评审判定：无测试缝）；
    // 判定后 gate_id/baseline_hash 非空的断言在 test/db/gate-judged.test.ts C1。
    assert.equal(append(db, chain(seeds.slice(0, entered + 1))).skipped, entered + 1);
  });
});
