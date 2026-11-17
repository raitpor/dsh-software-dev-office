import { appendAs as append } from './append-auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';


import { MATERIALIZED_TABLES, SUPPORTED_KINDS, primaryKeyColumns, requiredTable } from '../../src/db/write-materialize.js';
import { canonicalJson } from '../../src/core/fold/canonical.js';
import { fold } from '../../src/core/fold/index.js';
import type { FoldState } from '../../src/core/fold/types.js';
import { verify } from '../../src/core/verify.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { chain, withWriteDb } from './append-helpers.js';
import { worldSeeds } from './world-seeds.js';

const seeds = worldSeeds();
const kinds = Object.keys(SUPPORTED_KINDS).sort();
const events = chain(seeds);

interface Snapshot {
  readonly table: string;
  readonly id: string;
  readonly row: Record<string, unknown>;
}
const snapshots = JSON.parse(
  readFileSync('test/fixtures/per-kind-fold.json', 'utf8'),
) as Record<string, Snapshot>;

// M2-3/D-078：`assumption.invalidated` 仍登记在 REDUCERS（003 种子兼容、fold 里显式拒），
// 但语义是派生读数、写网关前置拒绝，因此没有“合法写入”的 world seed 与 pinned 快照。
const DERIVED_ONLY_KINDS = new Set(['assumption.invalidated']);
// `gate.judged` 只能由 `judgeStage()` 真路径产生（P1 评审：没有测试缝可铸授权），
// 因此不进 world 链与 pinned 快照；真实判定行的物化覆盖在 test/db/gate-judged.test.ts。
const GATE_ONLY_KINDS = new Set(['gate.judged']);
// M3-2/P1-3：conflict.* 只能由真 CAS 路径产生（一次性能力），world 链不含；
// 冲突行/解决覆盖在 test/db/conflict-*.test.ts。
const CONFLICT_ONLY_KINDS = new Set(['conflict.detected', 'conflict.resolved']);
const TOOL_ONLY_KINDS = new Set(['snapshot.taken', 'lease.issued', 'lease.expired', 'lease.revoked']);
// M4-2 裁定 A：world 链不再伪造认领；task.claimed 由真派发链覆盖（test/db/lease.test.ts 的 C2/C3/C6）。
const CLAIM_COVERED_KINDS = new Set(['task.claimed']);

test('P3-4: every CLAIM_COVERED_KINDS kind is actually exercised in the claim/lease suites', () => {
  // 覆盖豁免不能只是“把 kind 加进集合”：集合里的每个 kind 必须在 claim/lease 真链用例里
  // 至少出现一次字面量（从用例删掉但仍留在集合 ⇒ 这里红）。
  const sources = [
    readFileSync('test/db/lease.test.ts', 'utf8'),
    readFileSync('test/db/append-helpers.ts', 'utf8'),
  ].join('\n');
  for (const kind of CLAIM_COVERED_KINDS) {
    assert.ok(sources.includes(`'${kind}'`), `CLAIM_COVERED_KINDS entry ${kind} is not actually exercised in test/db/lease.test.ts`);
  }
});

test('C5/C6 world chain covers every supported kind exactly once (first occurrence)', () => {
  assert.equal(kinds.length, 63, 'SUPPORTED_KINDS = REDUCERS 58 + lock 2 + lease.revoked 1 + lease.issued/expired 2');
  for (const kind of kinds) {
    if (DERIVED_ONLY_KINDS.has(kind) || GATE_ONLY_KINDS.has(kind) || CONFLICT_ONLY_KINDS.has(kind) || TOOL_ONLY_KINDS.has(kind)) continue;
    if (CLAIM_COVERED_KINDS.has(kind)) continue;
    assert.ok(seeds.some((event) => event.kind === kind), `world chain must contain at least one ${kind} event`);
  }
});

test('D-078: assumption.invalidated is registered but every write is rejected at the gateway', () => {
  assert.ok(kinds.includes('assumption.invalidated'), 'kind 仍登记（003 兼容）');
  const first = seeds[0]!;
  const event = chain([
    {
      ...first,
      id: 'e-derived-only',
      kind: 'assumption.invalidated',
      subject: 'A-2',
      payload: { reason: 'inputs changed' },
    } as (typeof seeds)[number],
  ])[0]!;
  return withWriteDb((db) => {
    const result = append(db, [event]);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'assumption_invalidated_is_derived');
    const row = db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number };
    assert.equal(row.n, 0, '拒绝必须 0 行');
  });
});

// C6（P1-2 评审）：每个 kind 不只看“整表变了”，要与**固定快照**逐字段相等——
// 快照覆盖该 kind 首次出现的 fold 目标行全部列（含 fold-only 列）与具体值；
// 写错值（如 task.dependencies_changed 写 blocked_by:['bogus']）或漏列都会红。
// 单事件入 DB 会遇到“中途态 DDL 非法”（如 redteam.disposition NOT NULL），
// 所以 per-kind 效果在 fold 层取证；DB 物化由下面的 world 全链逐表对账覆盖。
for (const kind of kinds) {
  if (DERIVED_ONLY_KINDS.has(kind) || GATE_ONLY_KINDS.has(kind) || CONFLICT_ONLY_KINDS.has(kind) || TOOL_ONLY_KINDS.has(kind) || CLAIM_COVERED_KINDS.has(kind)) continue;
  const index = seeds.findIndex((event) => event.kind === kind);
  test(`C6 ${kind} writes the pinned fold row with exact values`, () => {
    const table = requiredTable(kind);
    assert.ok(table !== undefined, `${kind} must map to a folded table`);
    const before = fold(undefined, events.slice(0, index));
    const after = fold(undefined, events.slice(0, index + 1));
    assert.notEqual(
      canonicalJson(before.tables[table]),
      canonicalJson(after.tables[table]),
      `${kind} must change ${table}; a no-op reducer would fail here`,
    );
    const expected = snapshots[kind];
    assert.ok(expected !== undefined, `${kind} has a pinned snapshot`);
    assert.equal(expected.table, table);
    const rows = (after.tables as unknown as Record<string, Record<string, Record<string, unknown>>>)[table]!;
    assert.deepEqual(rows[expected.id], expected.row, `${kind} diverged from the pinned fold snapshot (${table}/${expected.id})`);
  });
}

// C6 的另一半：整条 world 链一次 append 后，DB 的物化行必须与 fold 最终态逐表相等
// （decision 只对账已签名行，D-019；fold-only 列不在 DDL 中，天然不参与比较）。
function columnsOf(db: SdoDatabase, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);
}

function toSqlValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function fromDbValue(value: unknown): unknown {
  if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value === undefined ? null : value;
}

function projection(columns: readonly string[], row: Record<string, unknown>, dbSide: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    out[column] = dbSide ? fromDbValue(row[column]) : toSqlValue(row[column]);
  }
  return out;
}

function keyOf(pk: readonly string[], row: Record<string, unknown>): string {
  return canonicalJson(pk.map((c) => toSqlValue(row[c])));
}

function visibleFoldRows(state: FoldState, table: string): Record<string, Record<string, unknown>> {
  const rows = (state.tables as unknown as Record<string, Record<string, Record<string, unknown>>>)[table] ?? {};
  if (table !== 'decision') return rows;
  const signed: Record<string, Record<string, unknown>> = {};
  for (const [id, row] of Object.entries(rows)) if (row['signature'] !== null && row['signature'] !== undefined) signed[id] = row;
  return signed;
}

test('C6 world append: materialized rows equal the fold final state for every table', () => {
  withWriteDb((db) => {
    assert.equal(append(db, events).ok, true);
    assert.equal(verify(db).ok, true);
    const state = fold(undefined, events);
    for (const table of MATERIALIZED_TABLES) {
      const pk = primaryKeyColumns(db, table);
      const columns = columnsOf(db, table);
      const foldRows = visibleFoldRows(state, table);
      const dbRows = new Map<string, Record<string, unknown>>();
      for (const row of db.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>) {
        dbRows.set(keyOf(pk, row), row);
      }
      const foldKeys = new Set<string>();
      for (const row of Object.values(foldRows)) {
        const key = keyOf(pk, row);
        foldKeys.add(key);
        const stored = dbRows.get(key);
        assert.ok(stored !== undefined, `${table} ${key} is missing in the database`);
        assert.equal(canonicalJson(projection(columns, stored, true)), canonicalJson(projection(columns, row, false)), `${table} ${key} differs from fold`);
      }
      for (const key of dbRows.keys()) assert.ok(foldKeys.has(key), `${table} ${key} is unexpected (not in fold state)`);
    }
  });
});
