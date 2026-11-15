/**
 * M3-2 C1 两进程：两个独立 node 进程、两个 SQLite 连接写同一库文件，
 * 同一 base_hash 并发写 ⇒ 一成一败，冲突行落库且可对账。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { append } from '../../src/db/write.js';
import { verify } from '../../src/core/verify.js';
import { fold } from '../../src/core/fold/index.js';
import { readEvents } from '../../src/core/verify-events.js';
import { valueHash } from '../../src/core/conflict/hash.js';
import { chain, fourDomainSeeds } from './append-helpers.js';

const PASS = 'm3-2 two-process passphrase';

const CHILD = String.raw`
import { pathToFileURL } from 'node:url';
const url = (p) => pathToFileURL(process.cwd() + '/' + p).href;
const { openSdoDatabase } = await import(url('lib/src/db/open.js'));
const { append, chainHead } = await import(url('lib/src/db/write.js'));
const { chain, seed } = await import(url('lib/test/db/append-helpers.js'));
const db = openSdoDatabase(process.env['SDO_CONFLICT_DB'], process.env['SDO_CONFLICT_PASS']);
const [event] = chain([seed(Number(process.env['SDO_CONFLICT_N']), 'spec.revised', 'SPEC-1', {
  reason: 'concurrent write',
  clause: process.env['SDO_CONFLICT_CLAUSE'],
  field: 'clause',
  base_hash: process.env['SDO_CONFLICT_BASE'],
  value: process.env['SDO_CONFLICT_CLAUSE'],
}, { actor: process.env['SDO_CONFLICT_ACTOR'] })], chainHead(db));
const result = append(db, [event]);
console.log(JSON.stringify({ ok: result.ok, reason_code: result.reason_code, conflict_id: result.conflict_id }));
db.close();
`;

function runChild(dir: string, base: string, actor: string, clause: string, n: number) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      SDO_CONFLICT_DB: join(dir, 'state', 'sdo.db'),
      SDO_CONFLICT_PASS: PASS,
      SDO_CONFLICT_BASE: base,
      SDO_CONFLICT_ACTOR: actor,
      SDO_CONFLICT_CLAUSE: clause,
      SDO_CONFLICT_N: String(n),
    },
  });
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as { ok: boolean; reason_code?: string; conflict_id?: string };
}

test('C1 two processes: one write wins, the stale one becomes a visible conflict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-conflict-2p-'));
  try {
    const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    let base = '';
    try {
      runMigrations(db);
      assert.equal(append(db, chain(fourDomainSeeds())).ok, true);
      const state = fold(undefined, readEvents(db, []));
      const row = state.tables.spec['SPEC-1'];
      if (row === undefined) throw new Error('SPEC-1 missing');
      base = valueHash(row['clause'] ?? null);
    } finally {
      db.close();
    }

    const first = runChild(dir, base, 'alice', 'clause A', 20);
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = runChild(dir, base, 'bob', 'clause B', 21);
    assert.equal(second.ok, false, JSON.stringify(second));
    assert.equal(second.reason_code, 'conflict');

    const reopened = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    try {
      const conflict = reopened.prepare('SELECT * FROM conflicts WHERE id = ?').get(second.conflict_id) as Record<string, unknown>;
      assert.ok(conflict);
      assert.equal(conflict['winner_actor'], 'alice');
      assert.equal(conflict['loser_actor'], 'bob');
      assert.equal(conflict['status'], 'open');
      assert.equal(verify(reopened).ok, true);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
