/** M4-1 C1/C2/C3/C6：锁的 DB 层互斥（两独立进程）、路径段相交、结构化 409、非法前缀。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { acquireLock, acquireMainTreeLock, consumeLockToolAuthority, releaseLock } from '../../src/db/lock.js';
import { lockToolPayloadHash } from '../../src/db/lock-capability.js';
import { append, chainHead } from '../../src/db/write.js';
import { buildEvent } from '../../src/db/freeze-store.js';
import { grantAll } from './append-auth.js';
import { AT } from './append-helpers.js';

const PASS = 'm4-1 lock two-process passphrase';
const SESSION = (actor: string) => ({ actor, actor_kind: 'human' as const });

const CHILD = String.raw`
import { pathToFileURL } from 'node:url';
const url = (p) => pathToFileURL(process.cwd() + '/' + p).href;
const { openSdoDatabase } = await import(url('lib/src/db/open.js'));
const { acquireLock } = await import(url('lib/src/db/lock.js'));
const db = openSdoDatabase(process.env['SDO_LOCK_DB'], process.env['SDO_LOCK_PASS']);
const start = Number(process.env['SDO_LOCK_START']);
while (Date.now() < start) { /* spin to align the race */ }
const result = acquireLock(db, {
  prefix: 'src/core',
  card_id: process.env['SDO_LOCK_CARD'],
  session: { actor: process.env['SDO_LOCK_ACTOR'], actor_kind: 'human' },
  at: '2026-11-16T00:00:00.000Z',
});
console.log(JSON.stringify(result));
db.close();
`;

function runChild(dbPath: string, actor: string, card: string, startAt: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SDO_LOCK_DB: dbPath,
        SDO_LOCK_PASS: PASS,
        SDO_LOCK_ACTOR: actor,
        SDO_LOCK_CARD: card,
        SDO_LOCK_START: String(startAt),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`child exited ${code}: ${stderr}`));
        return;
      }
      const line = stdout.trim().split('\n').at(-1) ?? '';
      resolve(JSON.parse(line) as Record<string, unknown>);
    });
  });
}

test('C1: two independent processes race for the same prefix — one wins, one gets a structured lock_conflict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-2p-'));
  const dbPath = join(dir, 'state', 'sdo.db');
  try {
    const db = openSdoDatabase(dbPath, PASS);
    try {
      runMigrations(db);
      grantAll(db, 'alice');
      grantAll(db, 'bob');
    } finally {
      db.close();
    }
    const startAt = Date.now() + 300;
    const [first, second] = await Promise.all([
      runChild(dbPath, 'alice', 'CARD-A', startAt),
      runChild(dbPath, 'bob', 'CARD-B', startAt),
    ]);
    const results = [first, second];
    const successes = results.filter((result) => result['ok'] === true);
    const conflicts = results.filter((result) => result['reason_code'] === 'lock_conflict');
    assert.equal(successes.length, 1, JSON.stringify(results));
    assert.equal(conflicts.length, 1, JSON.stringify(results));
    const conflict = conflicts[0]?.['conflict'] as Record<string, unknown>;
    assert.equal(conflict['prefix'], 'src/core');
    assert.ok(typeof conflict['holder'] === 'string' && conflict['holder'] !== '');
    assert.ok(typeof conflict['holder_card'] === 'string' && conflict['holder_card'] !== '');
    assert.ok(typeof conflict['since'] === 'string' && conflict['since'] !== '');

    const check = openSdoDatabase(dbPath, PASS);
    try {
      const active = check.prepare("SELECT COUNT(*) AS n FROM lock WHERE status = 'active'").get() as { n: number };
      assert.equal(active.n, 1, 'exactly one active lock row');
      const acquired = check.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'lock.acquired'").get() as { n: number };
      assert.equal(acquired.n, 1, 'exactly one lock.acquired event');
    } finally {
      check.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C1/C3: same card re-acquire is idempotent; release then acquire by another actor succeeds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-seq-'));
  try {
    const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    try {
      runMigrations(db);
      grantAll(db, 'alice');
      grantAll(db, 'bob');
      const first = acquireLock(db, { prefix: 'src/core', card_id: 'CARD-A', session: SESSION('alice'), at: AT });
      assert.equal(first.ok, true);
      const again = acquireLock(db, { prefix: './SRC/Core/', card_id: 'CARD-A', session: SESSION('alice'), at: AT });
      assert.equal(again.ok, true);
      const bob = acquireLock(db, { prefix: 'src/core', card_id: 'CARD-B', session: SESSION('bob'), at: AT });
      assert.equal(bob.ok, false);
      if (!bob.ok) assert.equal(bob.reason_code, 'lock_conflict');
      assert.equal(releaseLock(db, { prefix: 'src/core', session: SESSION('alice'), at: AT }).ok, true);
      const bobAfter = acquireLock(db, { prefix: 'src/core', card_id: 'CARD-B', session: SESSION('bob'), at: AT });
      assert.equal(bobAfter.ok, true);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C2: non-overlapping prefixes can be held concurrently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-nonoverlap-'));
  try {
    const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    try {
      runMigrations(db);
      grantAll(db, 'alice');
      grantAll(db, 'bob');
      assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'CARD-A', session: SESSION('alice'), at: AT }).ok, true);
      assert.equal(acquireLock(db, { prefix: 'src/ui', card_id: 'CARD-B', session: SESSION('bob'), at: AT }).ok, true);
      assert.equal(acquireLock(db, { prefix: 'src/core2', card_id: 'CARD-C', session: SESSION('bob'), at: AT }).ok, true);
      const lookalike = acquireLock(db, { prefix: 'src/co', card_id: 'CARD-D', session: SESSION('bob'), at: AT });
      assert.equal(lookalike.ok, true, 'src/co does not overlap src/core');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C6: illegal prefixes return invalid_field and leave no lock row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-invalid-'));
  try {
    const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    try {
      runMigrations(db);
      grantAll(db, 'alice');
      for (const prefix of ['/etc', '../src', 'C:/tmp', '']) {
        const result = acquireLock(db, { prefix, card_id: 'CARD-X', session: SESSION('alice'), at: AT });
        assert.equal(result.ok, false, prefix);
        if (!result.ok) assert.equal(result.reason_code, 'invalid_field', prefix);
      }
      const rows = db.prepare('SELECT COUNT(*) AS n FROM lock').get() as { n: number };
      assert.equal(rows.n, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-1: overlapping acquire fails in fold — no row, no event, no orphan lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-overlap-'));
  try {
    const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    try {
      runMigrations(db);
      grantAll(db, 'alice');
      grantAll(db, 'bob');
      assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'CARD-A', session: SESSION('alice'), at: AT }).ok, true);
      const eventsBefore = (db.prepare('SELECT COUNT(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n;
      const child = acquireLock(db, { prefix: 'src/core/auth', card_id: 'CARD-B', session: SESSION('bob'), at: AT });
      assert.equal(child.ok, false);
      if (!child.ok) assert.equal(child.reason_code, 'lock_conflict');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n, eventsBefore, 'failed acquire must not append an event');
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM lock WHERE status = 'active'").get() as { n: number }).n, 1, 'only the holder row remains');
      const orphan = db.prepare("SELECT COUNT(*) AS n FROM lock WHERE actor = 'bob'").get() as { n: number };
      assert.equal(orphan.n, 0, 'no orphan row for the rejected acquirer');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-2: only the holder can release; a non-holder gets no_permission and the lock survives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-holder-'));
  try {
    const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    try {
      runMigrations(db);
      grantAll(db, 'alice');
      grantAll(db, 'bob');
      assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'CARD-A', session: SESSION('alice'), at: AT }).ok, true);
      const stolen = releaseLock(db, { prefix: 'src/core', session: SESSION('bob'), at: AT });
      assert.equal(stolen.ok, false);
      if (!stolen.ok) assert.equal(stolen.reason_code, 'no_permission');
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM lock WHERE status = 'active'").get() as { n: number }).n, 1);
      assert.equal(releaseLock(db, { prefix: 'src/core', session: SESSION('alice'), at: AT }).ok, true);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P2-5: business actors cannot take the root/main-tree lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-root-'));
  try {
    const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    try {
      runMigrations(db);
      grantAll(db, 'alice');
      const got = acquireLock(db, { prefix: '.', card_id: 'CARD-A', session: SESSION('alice'), at: AT });
      assert.equal(got.ok, false);
      if (!got.ok) assert.equal(got.reason_code, 'no_permission');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM lock').get() as { n: number }).n, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-1: fold itself rejects overlapping lock.acquired (append rolls back; no row/event survives)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-fold-'));
  try {
    const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    try {
      runMigrations(db);
      grantAll(db, 'alice');
      grantAll(db, 'bob');
      assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'CARD-A', session: SESSION('alice'), at: AT }).ok, true);
      const eventsBefore = (db.prepare('SELECT COUNT(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n;
      const rowsBefore = (db.prepare('SELECT COUNT(*) AS n FROM lock').get() as { n: number }).n;
      const event = buildEvent({
        id: 'lock.acquired:src/core/auth:fold-test',
        at: AT,
        actor: 'bob',
        kind: 'lock.acquired',
        subject: 'src/core/auth',
        payload: { card_id: 'CARD-B', acquired_at: AT, expires_at: '2026-11-17T00:00:00.000Z', scope: 'module:src' },
        caused_by: [],
        request_id: 'lock:fold-test',
      }, chainHead(db));
      const result = append(db, [event], { session: SESSION('bob') });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.written, 0, 'no event may be committed when the fold rejects');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n, eventsBefore);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM lock').get() as { n: number }).n, rowsBefore);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM lock WHERE actor = 'bob'").get() as { n: number }).n, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1-2: fold guards lock.released by actor — a non-holder release event is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-release-fold-'));
  try {
    const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    try {
      runMigrations(db);
      grantAll(db, 'alice');
      grantAll(db, 'bob');
      assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'CARD-A', session: SESSION('alice'), at: AT }).ok, true);
      const eventsBefore = (db.prepare('SELECT COUNT(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n;
      const event = buildEvent({
        id: 'lock.released:src/core:fold-test',
        at: AT,
        actor: 'bob',
        kind: 'lock.released',
        subject: 'src/core',
        payload: { released_at: AT, released_by: 'released', scope: 'module:src' },
        caused_by: [],
        request_id: 'lock:release-fold-test',
      }, chainHead(db));
      const result = append(db, [event], { session: SESSION('bob') });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n, eventsBefore);
      assert.equal((db.prepare("SELECT status FROM lock WHERE path_prefix = 'src/core'").get() as { status: string }).status, 'active');
      assert.equal(releaseLock(db, { prefix: 'src/core', session: SESSION('alice'), at: AT }).ok, true);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('P1(2nd): a business append cannot forge the root lock — capability, not only the initiator marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-root-forge-'));
  try {
    const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    try {
      runMigrations(db);
      grantAll(db, 'bob');
      const eventsBefore = (db.prepare('SELECT COUNT(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n;
      for (const initiator of [undefined, 'sdo-workcopy']) {
        const payload: Record<string, unknown> = {
          card_id: 'CARD-ROOT-FAKE', acquired_at: AT, expires_at: '2026-11-17T00:00:00.000Z', scope: 'domain:core',
        };
        if (initiator !== undefined) payload['initiator'] = initiator;
        const event = buildEvent({
          id: `lock.acquired:root:forge:${initiator ?? 'plain'}`,
          at: AT,
          actor: 'bob',
          kind: 'lock.acquired',
          subject: '.',
          payload,
          caused_by: [],
          request_id: `lock:root-forge:${initiator ?? 'plain'}`,
        }, chainHead(db));
        const result = append(db, [event], { session: SESSION('bob') });
        assert.equal(result.ok, false, JSON.stringify(result));
        assert.equal(result.reason_code, 'unauthorized_root_lock');
        assert.equal(result.written, 0);
      }
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n, eventsBefore);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM lock').get() as { n: number }).n, 0);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1(2nd): acquireMainTreeLock mints a one-shot capability; the consumed payload cannot be replayed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-root-ok-'));
  try {
    const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    try {
      runMigrations(db);
      const service = { actor: 'fixture-root', actor_kind: 'service' as const };
      const got = acquireMainTreeLock(db, { card_id: 'CARD-ROOT', session: service, at: AT });
      assert.equal(got.ok, true, JSON.stringify(got));
      const row = db.prepare("SELECT status, actor FROM lock WHERE path_prefix = ''").get() as { status: string; actor: string };
      assert.equal(row.status, 'active');
      assert.equal(row.actor, 'fixture-root');
      const event = db.prepare("SELECT id, payload FROM event WHERE kind = 'lock.acquired'").get() as { id: string; payload: string };
      const consumed = consumeLockToolAuthority(event.id, lockToolPayloadHash(JSON.parse(event.payload)));
      assert.equal(consumed, false, 'the capability is consumed by the real append and cannot be reused');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P2(2nd): same actor with a different card is a conflict, not an idempotent overwrite (API + event stream)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-diff-card-'));
  try {
    const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
    try {
      runMigrations(db);
      grantAll(db, 'alice');
      assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'CARD-A', session: SESSION('alice'), at: AT }).ok, true);
      const eventsBefore = (db.prepare('SELECT COUNT(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n;

      const api = acquireLock(db, { prefix: 'src/core', card_id: 'CARD-B', session: SESSION('alice'), at: AT });
      assert.equal(api.ok, false, JSON.stringify(api));
      if (!api.ok) assert.equal(api.reason_code, 'lock_conflict');

      const event = buildEvent({
        id: 'lock.acquired:src/core:same-actor-card-b',
        at: AT,
        actor: 'alice',
        kind: 'lock.acquired',
        subject: 'src/core',
        payload: { card_id: 'CARD-B', acquired_at: AT, expires_at: '2026-11-17T00:00:00.000Z', scope: 'module:src' },
        caused_by: [],
        request_id: 'lock:same-actor-card-b',
      }, chainHead(db));
      const appended = append(db, [event], { session: SESSION('alice') });
      assert.equal(appended.ok, false, JSON.stringify(appended));
      assert.equal(appended.written, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n, eventsBefore);
      const row = db.prepare("SELECT card_id, status FROM lock WHERE path_prefix = 'src/core'").get() as { card_id: string; status: string };
      assert.equal(row.card_id, 'CARD-A');
      assert.equal(row.status, 'active');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P3-2(2nd): capability module has no exported mint; only lock.ts owns the authority instance', () => {
  const capability = readFileSync('src/db/lock-capability.ts', 'utf8');
  assert.equal(/export\s+function\s+mint/.test(capability), false, 'capability module must not export a mint function');
  assert.equal(capability.includes('mintLockToolAuthority'), false);
  const lock = readFileSync('src/db/lock.ts', 'utf8');
  assert.equal(lock.includes('LOCK_TOOL_AUTHORITY.mint('), true, 'lock.ts owns the private instance and mints through it');
});
