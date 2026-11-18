import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { REASON_CODES } from '../../../src/core/errors/codes.js';

interface Snapshot {
  readonly baseline_head: string;
  readonly table_size: number;
  readonly corrected_at: string;
  readonly provenance_note: string;
  readonly table: readonly string[];
  readonly emit_literals: readonly string[];
  readonly append_reason: readonly string[];
  readonly verify_problem: readonly string[];
  readonly sign_reason: readonly string[];
  readonly workcopy_failure: readonly string[];
  readonly right_deny: readonly string[];
  readonly union_sources: readonly string[];
  readonly refs: readonly string[];
}

const snapshot = JSON.parse(
  readFileSync(new URL('../../../../test/core/errors/code-snapshot.json', import.meta.url), 'utf8'),
) as Snapshot;

const table = new Set(REASON_CODES.map((entry) => entry.code));

test('C3: every pre-M4-5 code source is registered (M3 emit literals + M4-7 additions)', () => {
  const groups: readonly (readonly [string, readonly string[]])[] = [
    ['emit_literals', snapshot.emit_literals],
    ['append_reason', snapshot.append_reason],
    ['verify_problem', snapshot.verify_problem],
    ['sign_reason', snapshot.sign_reason],
    ['workcopy_failure', snapshot.workcopy_failure],
    ['right_deny', snapshot.right_deny],
    ['union_sources', snapshot.union_sources],
  ];
  for (const [name, codes] of groups) {
    assert.equal(codes.length, new Set(codes).size, `${name} has duplicates in snapshot`);
    for (const code of codes) assert.ok(table.has(code), `${name}: unregistered ${code}`);
  }
});

test('C3: table equals the frozen pre-change set (no silent additions/removals)', () => {
  assert.deepEqual([...table].sort(), [...snapshot.table].sort());
  assert.ok(table.size >= 155);
  assert.equal(snapshot.table_size, snapshot.table.length, 'table_size must match frozen table length');
  assert.equal(snapshot.table_size, table.size, 'table_size must match live table');
  assert.match(snapshot.provenance_note, /冻结自 HEAD/);
  assert.match(snapshot.provenance_note, /不重算 HEAD/);
  assert.equal(snapshot.baseline_head, '3309048', 'baseline_head stays at the frozen baseline commit');
  assert.equal(snapshot.corrected_at, '2026-11-18');
});

test('C3: table = union(provenance sources) code-for-code', () => {
  const sources = new Set([
    ...snapshot.emit_literals,
    ...snapshot.append_reason,
    ...snapshot.verify_problem,
    ...snapshot.sign_reason,
    ...snapshot.workcopy_failure,
    ...snapshot.right_deny,
    ...snapshot.union_sources,
    ...snapshot.refs,
  ]);
  assert.deepEqual([...sources].sort(), [...table].sort());
});
