import assert from 'node:assert/strict';
import { test } from 'node:test';

import { append } from '../../src/db/write.js';
import { MATERIALIZED_TABLES } from '../../src/db/write-materialize.js';
import { canonicalJson } from '../../src/core/fold/canonical.js';
import { fold } from '../../src/core/fold/index.js';
import type { Row, TableName } from '../../src/core/fold/types.js';
import { readEvents } from '../../src/core/verify-events.js';
import { verify } from '../../src/core/verify.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { chain, fourDomainSeeds, withWriteDb } from './append-helpers.js';

function sqlValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

function canonicalRow(row: Row, columns: readonly string[]): string {
  const record: Record<string, unknown> = {};
  for (const column of columns) record[column] = sqlValue(row[column]);
  return canonicalJson(record);
}

function compareTable(db: SdoDatabase, table: TableName, folded: Readonly<Record<string, Row>>): void {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
  const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  const dbById = new Map(rows.map((row) => [String(row['id']), canonicalRow(row as Row, columns)]));
  assert.equal(dbById.size, Object.keys(folded).length, `${table} row count must match fold`);
  for (const [id, row] of Object.entries(folded)) {
    assert.equal(dbById.get(id), canonicalRow(row, columns), `${table} row ${id} must match fold`);
  }
}

test('C5 four projection tables are materialized field-for-field from fold', () => {
  withWriteDb((db) => {
    const result = append(db, chain(fourDomainSeeds()));
    assert.equal(result.ok, true, `append failed: ${result.message ?? 'no message'}`);
    assert.equal(result.written, 6);

    const problems: never[] = [];
    const events = readEvents(db, problems);
    assert.deepEqual(problems, []);
    const state = fold(undefined, events);

    for (const table of MATERIALIZED_TABLES) {
      compareTable(db, table, state.tables[table]);
    }
    assert.deepEqual(
      Object.keys(state.tables['intent']),
      ['INT-1'],
      'four-domain stream must materialize the intent row',
    );
    assert.deepEqual(Object.keys(state.tables['criterion']), ['CRIT-1']);
    assert.deepEqual(Object.keys(state.tables['evidence']), ['EVID-1']);
  });
});

test('C6 verify is green before and after every accepted append', () => {
  withWriteDb((db) => {
    assert.equal(verify(db).ok, true);
    const result = append(db, chain(fourDomainSeeds()));
    assert.equal(result.ok, true);
    const report = verify(db);
    assert.equal(report.ok, true, JSON.stringify(report.problems));
    assert.equal(report.eventCount, 6);
  });
});

