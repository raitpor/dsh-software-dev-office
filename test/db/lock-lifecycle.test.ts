/** M4-1 C4/C7/C5：撤租约后的重认领、workcopy 释放锁、主树全局锁、verify 两码。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import git from 'isomorphic-git';

import type { SdoDatabase } from '../../src/db/driver.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { verify } from '../../src/core/verify.js';
import { cardWorkdir } from '../../src/core/workcopy/paths.js';
import { acquireLock, acquireMainTreeLock, releaseLock, releaseMainTreeLock, rootLockPrecheck, WORKCOPY_TOOL_ACTOR } from '../../src/db/lock.js';
import { dispatchLease, revokeLease } from '../../src/db/lease.js';
import { appendTool, toolEvent } from '../../src/db/workcopy-tool.js';
import { bootstrapBaseline, createWorkcopy, commitWorkcopy, admitWorkcopy, removeWorkcopy } from '../../src/db/workcopy.js';
import { AT, PASSPHRASE, chain, claimWithLease, seed } from './append-helpers.js';
import { appendAs, grantAll, grantFixtureRoster } from './append-auth.js';
import { chainHead } from '../../src/db/write.js';


const HOLD = String.raw`
import { pathToFileURL } from 'node:url';
const url = (p) => pathToFileURL(process.cwd() + '/' + p).href;
const { openSdoDatabase } = await import(url('lib/src/db/open.js'));
const { acquireMainTreeLock, releaseMainTreeLock } = await import(url('lib/src/db/lock.js'));
const { writeFileSync } = await import('node:fs');
const db = openSdoDatabase(process.env['SDO_LOCK_DB'], process.env['SDO_LOCK_PASS']);
const session = { actor: 'fixture-root', actor_kind: 'service' };
const got = acquireMainTreeLock(db, { card_id: 'CARD-OTHER', session, at: '2026-11-16T00:00:00.000Z' });
if (!got.ok) { console.log(JSON.stringify(got)); process.exit(1); }
writeFileSync(process.env['SDO_LOCK_MARKER'], 'held');
await new Promise((resolve) => setTimeout(resolve, 1500));
releaseMainTreeLock(db, { session, at: '2026-11-16T00:00:00.000Z' });
console.log(JSON.stringify({ ok: true, released: true }));
db.close();
`;

const ADMIT = String.raw`
import { pathToFileURL } from 'node:url';
const url = (p) => pathToFileURL(process.cwd() + '/' + p).href;
const { openSdoDatabase } = await import(url('lib/src/db/open.js'));
const { admitWorkcopy } = await import(url('lib/src/db/workcopy.js'));
const db = openSdoDatabase(process.env['SDO_LOCK_DB'], process.env['SDO_LOCK_PASS']);
const result = await admitWorkcopy(db, {
  root: process.env['SDO_LOCK_ROOT'],
  card: process.env['SDO_LOCK_CARD'],
  base_snapshot_id: 'SNAP-BASE',
  scope_paths: ['a.txt'],
  message: 'cross-process admit',
  session: { actor: 'fixture-root', actor_kind: 'service' },
  at: '2026-11-16T00:00:00.000Z',
});
console.log(JSON.stringify(result));
db.close();
`;

function runSync(script: string, env: Record<string, string>) {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ...env },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse((child.stdout.trim().split('\n').at(-1) ?? '{}')) as Record<string, unknown>;
}

const SESSION = { actor: 'fixture-root', actor_kind: 'service' as const };
const HUMAN = (actor: string) => ({ actor, actor_kind: 'human' as const });

function withDb(run: (db: SdoDatabase) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-lock-life-'));
  const db = openSdoDatabase(join(dir, 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    grantFixtureRoster(db);
    grantAll(db, 'fixture-root');
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withRepo(run: (ctx: { root: string; db: SdoDatabase }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'sdo-m4-lock-'));
  const db = openSdoDatabase(join(root, '.sdo', 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    grantFixtureRoster(db);
    grantAll(db, 'fixture-root');
    await git.init({ dir: root, fs });
    await bootstrapBaseline(db, {
      root, snapshot_id: 'SNAP-BASE', session: SESSION, at: AT,
      files: { 'a.txt': 'v0\n', 'src/app.ts': 'export const x = 1;\n', 'docs/x.md': 'x\n', '.gitignore': '.sdo/\n.work/\nnode_modules/\n' },
    });
    await run({ root, db });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('C4: lease.revoked keeps the lock active; same actor re-claims, another actor still conflicts', () => {
  withDb((db) => {
    assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'CARD-A', session: HUMAN('alice'), at: AT }).ok, true);
    const dispatched = dispatchLease(db, SESSION, { card: 'CARD-A', actor: 'alice', scope: 'domain:core', at: AT });
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
    assert.equal(revokeLease(db, SESSION, dispatched.lease_id, AT).ok, true);
    const row = db.prepare("SELECT status, released_by FROM lock WHERE path_prefix = 'src/core'").get() as { status: string; released_by: string };
    assert.equal(row.status, 'active');
    assert.equal(row.released_by, 'lease_revoked');
    assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'CARD-A', session: HUMAN('alice'), at: AT }).ok, true);
    const bob = acquireLock(db, { prefix: 'src/core', card_id: 'CARD-B', session: HUMAN('bob'), at: AT });
    assert.equal(bob.ok, false);
    if (!bob.ok) assert.equal(bob.reason_code, 'lock_conflict');
  });
});

test('C4: workcopy.removed releases the card locks', async () => {
  await withRepo(async ({ root, db }) => {
    const created = await createWorkcopy(db, { root, card: 'CARD-L1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    assert.equal(created.ok, true);
    assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'CARD-L1', session: SESSION, at: AT }).ok, true);
    const committed = await commitWorkcopy(db, { root, card: 'CARD-L1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'clean for removal' });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    const removed = await removeWorkcopy(db, { root, card: 'CARD-L1', session: SESSION, at: AT });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    const active = db.prepare("SELECT COUNT(*) AS n FROM lock WHERE status = 'active'").get() as { n: number };
    assert.equal(active.n, 0, 'workcopy.removed must release card locks');
    assert.equal(releaseLock(db, { prefix: 'src/core', session: SESSION, at: AT }).ok, false);
  });
});

test('P2(5th): same actor but another card holding the root lock still blocks admit', async () => {
  await withRepo(async ({ root, db }) => {
    grantAll(db, 'alice');
    const alice = { actor: 'alice', actor_kind: 'human' as const };
    const created = await createWorkcopy(db, { root, card: 'CARD-L5', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: alice, at: AT });
    assert.equal(created.ok, true, JSON.stringify(created));
    writeFileSync(join(cardWorkdir(root, 'CARD-L5'), 'a.txt'), 'v1\n');
    const committed = await commitWorkcopy(db, { root, card: 'CARD-L5', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'clean' });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    const other = acquireMainTreeLock(db, { card_id: 'CARD-OTHER', session: alice, at: AT });
    assert.equal(other.ok, true, JSON.stringify(other));

    const admitted = await admitWorkcopy(db, { root, card: 'CARD-L5', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'blocked', session: alice, at: AT });
    assert.equal(admitted.ok, false, JSON.stringify(admitted));
    if (!admitted.ok) assert.equal(admitted.reason_code, 'lock_conflict');
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'v0\n', 'main tree must stay untouched');
  });
});

test('P2(5th) unit: rootLockPrecheck is the first gate and honours card_id', () => {
  const sameCard = [{ actor: 'alice', card_id: 'CARD-A', path_prefix: '' }];
  assert.equal(rootLockPrecheck(sameCard, 'alice', 'CARD-A'), undefined, 'same actor + same card passes');
  assert.equal(rootLockPrecheck(sameCard, 'alice', 'CARD-OTHER')?.card_id, 'CARD-A', 'same actor + other card blocks');
  const otherActor = [{ actor: 'bob', card_id: 'CARD-B', path_prefix: 'src/core' }];
  assert.equal(rootLockPrecheck(otherActor, 'alice', 'CARD-A')?.card_id, 'CARD-B', 'other actor blocks');
});

test('P3(5th) counter: another card complete admission on the same base is not reused', async () => {
  await withRepo(async ({ root, db }) => {
    const created = await createWorkcopy(db, { root, card: 'CARD-NEW', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    assert.equal(created.ok, true, JSON.stringify(created));
    // 造“另一张卡在本 base 上的完整准入”，且对象真实存在（不制造悬空 git_oid）。
    const foreignCreated = await createWorkcopy(db, { root, card: 'CARD-FOREIGN', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    assert.equal(foreignCreated.ok, true, JSON.stringify(foreignCreated));
    const foreignCommitted = await commitWorkcopy(db, { root, card: 'CARD-FOREIGN', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'no changes' });
    assert.equal(foreignCommitted.ok, true, JSON.stringify(foreignCommitted));
    const foreignTaken = appendTool(db, toolEvent('snapshot.taken', 'SNAP-FOREIGN', {
      git_oid: foreignCommitted.card_oid, parent_ids: ['SNAP-BASE'], external_ref: 'foreign', card: 'CARD-FOREIGN',
    }, SESSION, AT), SESSION);
    assert.equal(foreignTaken.ok, true, JSON.stringify(foreignTaken));
    const foreignRemoved = appendTool(db, toolEvent('workcopy.removed', 'CARD-FOREIGN', { card: 'CARD-FOREIGN', reason: 'admitted', snapshot_id: 'SNAP-FOREIGN' }, SESSION, AT), SESSION);
    assert.equal(foreignRemoved.ok, true, JSON.stringify(foreignRemoved));
    const before = (db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n;

    const admitted = await admitWorkcopy(db, { root, card: 'CARD-NEW', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'fresh', session: SESSION, at: AT });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    const after = (db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n;
    assert.equal(after, before + 1, 'this card must create its own snapshot');
    const own = db.prepare("SELECT id, git_oid FROM snapshot WHERE id NOT IN ('SNAP-BASE','SNAP-FOREIGN')").all() as { id: string; git_oid: string }[];
    assert.equal(own.length, 1);
    assert.notEqual(own[0]!.git_oid, foreignCommitted.card_oid, 'must not reuse the foreign card snapshot');
  });
});

test('P3(5th): two completed admissions for the same card+base fail closed as admission_ambiguous', async () => {
  await withRepo(async ({ root, db }) => {
    const created = await createWorkcopy(db, { root, card: 'CARD-AMB', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    assert.equal(created.ok, true, JSON.stringify(created));
    for (const n of [1, 2]) {
      const sid = `SNAP-AMB-${n}`;
      const taken = appendTool(db, toolEvent('snapshot.taken', sid, {
        git_oid: `deadbeef${n}`, parent_ids: ['SNAP-BASE'], external_ref: 'test', card: 'CARD-AMB',
      }, SESSION, AT), SESSION);
      assert.equal(taken.ok, true, JSON.stringify(taken));
      const removed = appendTool(db, toolEvent('workcopy.removed', 'CARD-AMB', { card: 'CARD-AMB', reason: 'admitted', snapshot_id: sid }, SESSION, AT), SESSION);
      assert.equal(removed.ok, true, JSON.stringify(removed));
    }
    const before = (db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n;
    const admitted = await admitWorkcopy(db, { root, card: 'CARD-AMB', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'ambiguous', session: SESSION, at: AT });
    assert.equal(admitted.ok, false, JSON.stringify(admitted));
    if (!admitted.ok) assert.equal(admitted.reason_code, 'admission_ambiguous');
    const after = (db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n;
    assert.equal(after, before, 'ambiguous admission must not append any event');
    assert.equal(fs.existsSync(cardWorkdir(root, 'CARD-AMB')), true, 'workcopy must be kept for human resolution');
  });
});

test('P3(5th): admit release failure is surfaced; retry is idempotent (no duplicate snapshot/removed)', async () => {
  await withRepo(async ({ root, db }) => {
    const created = await createWorkcopy(db, { root, card: 'CARD-AD1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'CARD-AD1', session: SESSION, at: AT }).ok, true);
    writeFileSync(join(cardWorkdir(root, 'CARD-AD1'), 'a.txt'), 'v1\n');
    const committed = await commitWorkcopy(db, { root, card: 'CARD-AD1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'clean for admit failure' });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    const req = { root, card: 'CARD-AD1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'admit', session: SESSION, at: AT, snapshot_id: 'SNAP-ADMIT-FIXED' };

    db.exec("CREATE TRIGGER test_fail_lock_release BEFORE UPDATE ON lock BEGIN SELECT RAISE(ABORT, 'injected release failure'); END");
    try {
      const failed = await admitWorkcopy(db, req);
      assert.equal(failed.ok, false, JSON.stringify(failed));
      if (!failed.ok) { assert.equal(failed.reason_code, 'lock_release_failed'); assert.ok((failed.details ?? []).length > 0, 'per-prefix failures must be visible'); }
      assert.equal(fs.existsSync(cardWorkdir(root, 'CARD-AD1')), true, 'failed release must keep the workcopy');
      const snapshot = db.prepare('SELECT COUNT(*) AS n FROM snapshot WHERE id = ?').get('SNAP-ADMIT-FIXED') as { n: number };
      assert.equal(snapshot.n, 1, 'snapshot.taken already landed before the failed release');
      const active = db.prepare("SELECT COUNT(*) AS n FROM lock WHERE status = 'active'").get() as { n: number };
      assert.equal(active.n, 2, 'card lock + main-tree lock are still active after the failed release (finally also cannot fold UPDATE)');
    } finally {
      db.exec('DROP TRIGGER test_fail_lock_release');
    }

    const retried = await admitWorkcopy(db, req);
    assert.equal(retried.ok, true, JSON.stringify(retried));
    const snapshots = db.prepare("SELECT id FROM snapshot WHERE id = 'SNAP-ADMIT-FIXED'").all();
    assert.equal(snapshots.length, 1, 'retry must not append a second snapshot with the same id');
    const removed = db.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'workcopy.removed' AND subject = 'CARD-AD1'").get() as { n: number };
    assert.equal(removed.n, 1, 'retry must not append a second workcopy.removed');
    const activeAfter = db.prepare("SELECT COUNT(*) AS n FROM lock WHERE status = 'active'").get() as { n: number };
    assert.equal(activeAfter.n, 0);
    assert.equal(fs.existsSync(cardWorkdir(root, 'CARD-AD1')), false);
  });
});

test('P2(4th): a failed lock release is surfaced; repo and lock are kept for retry', async () => {
  await withRepo(async ({ root, db }) => {
    const created = await createWorkcopy(db, { root, card: 'CARD-F1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'CARD-F1', session: SESSION, at: AT }).ok, true);
    const committed = await commitWorkcopy(db, { root, card: 'CARD-F1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'clean for failure injection' });
    assert.equal(committed.ok, true, JSON.stringify(committed));

    // 构造真实失败：锁行的物化 UPDATE 被触发器拒绝 ⇒ append 回滚 ⇒ releaseCardLocksAsTool 返回 failures。
    db.exec("CREATE TRIGGER test_fail_lock_release BEFORE UPDATE ON lock BEGIN SELECT RAISE(ABORT, 'injected release failure'); END");
    try {
      const removed = await removeWorkcopy(db, { root, card: 'CARD-F1', session: SESSION, at: AT });
      assert.equal(removed.ok, false, JSON.stringify(removed));
      if (!removed.ok) { assert.equal(removed.reason_code, 'lock_release_failed'); assert.ok((removed.details ?? []).length > 0, 'per-prefix failures must be visible'); }
      assert.equal(fs.existsSync(cardWorkdir(root, 'CARD-F1')), true, 'failed release must keep the workcopy');
      const active = db.prepare("SELECT COUNT(*) AS n FROM lock WHERE status = 'active'").get() as { n: number };
      assert.equal(active.n, 1, 'failed release must keep the lock');
    } finally {
      db.exec('DROP TRIGGER test_fail_lock_release');
    }
    const retried = await removeWorkcopy(db, { root, card: 'CARD-F1', session: SESSION, at: AT });
    assert.equal(retried.ok, true, JSON.stringify(retried));
    const activeAfter = db.prepare("SELECT COUNT(*) AS n FROM lock WHERE status = 'active'").get() as { n: number };
    assert.equal(activeAfter.n, 0);
    assert.equal(fs.existsSync(cardWorkdir(root, 'CARD-F1')), false);
  });
});

test('P2(3rd): a human actor can remove a workcopy; the tool identity releases the card locks', async () => {
  await withRepo(async ({ root, db }) => {
    grantAll(db, 'alice');
    const human = { actor: 'alice', actor_kind: 'human' as const };
    const created = await createWorkcopy(db, { root, card: 'CARD-H1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: human, at: AT });
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'CARD-H1', session: human, at: AT }).ok, true);
    const committed = await commitWorkcopy(db, { root, card: 'CARD-H1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'clean for human removal' });
    assert.equal(committed.ok, true, JSON.stringify(committed));

    const removed = await removeWorkcopy(db, { root, card: 'CARD-H1', session: human, at: AT });
    assert.equal(removed.ok, true, JSON.stringify(removed));
    const active = db.prepare("SELECT COUNT(*) AS n FROM lock WHERE status = 'active'").get() as { n: number };
    assert.equal(active.n, 0, 'human-session removal must release the card locks (tool identity)');
    const released = db.prepare("SELECT actor, released_by FROM lock WHERE path_prefix = 'src/core'").get() as { actor: string; released_by: string };
    assert.equal(released.released_by, 'released');
    const event = db.prepare("SELECT actor FROM event WHERE kind = 'lock.released'").get() as { actor: string };
    assert.equal(event.actor, WORKCOPY_TOOL_ACTOR, 'lock.released is written under the tool identity');
  });
});

test('C7: admit fails structurally while another card holds the main-tree lock; main tree untouched', async () => {
  await withRepo(async ({ root, db }) => {
    const created = await createWorkcopy(db, { root, card: 'CARD-L2', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    assert.equal(created.ok, true);
    writeFileSync(join(cardWorkdir(root, 'CARD-L2'), 'a.txt'), 'v1\n');
    const committed = await commitWorkcopy(db, { root, card: 'CARD-L2', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'v1' });
    assert.equal(committed.ok, true);
    const beforeMain = readFileSync(join(root, 'a.txt'), 'utf8');
    const snapshotsBefore = (db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n;
    assert.equal(acquireMainTreeLock(db, { card_id: 'CARD-OTHER', session: HUMAN('alice'), at: AT }).ok, true);
    const admitted = await admitWorkcopy(db, { root, card: 'CARD-L2', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'v1', session: SESSION, at: AT });
    assert.equal(admitted.ok, false, JSON.stringify(admitted));
    if (!admitted.ok) assert.equal(admitted.reason_code, 'lock_conflict');
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), beforeMain, 'main tree must not change on lock conflict');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n, snapshotsBefore);
    assert.equal(releaseMainTreeLock(db, { session: HUMAN('alice'), at: AT }).ok, true);
    const after = await admitWorkcopy(db, { root, card: 'CARD-L2', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'v1', session: SESSION, at: AT });
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'v1\n');
  });
});

test('C5 verify: lock_missing for a busy card that used locking but holds none', () => {
  withDb((db) => {
    assert.equal(appendAs(db, chain([
      seed(1, 'task.created', 'TASK-L1', { seq: 900, title: 'lock', kind: 'implement', scope_paths: ['a.txt'] }),
    ], chainHead(db))).ok, true);
    assert.equal(claimWithLease(db, { card: 'TASK-L1', actor: 'actor-1', at: AT }).claim.ok, true);
    assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'TASK-L1', session: SESSION, at: AT }).ok, true);
    assert.equal(releaseLock(db, { prefix: 'src/core', session: SESSION, at: AT }).ok, true);
    const result = verify(db);
    const missing = result.problems.filter((problem) => problem.code === 'lock_missing');
    assert.equal(missing.length, 1, JSON.stringify(result.problems));
    assert.equal(missing[0]?.objectId, 'TASK-L1');
  });
});

test('C5 verify: lock_leaked for an orphaned active lock beyond TTL+grace', () => {
  withDb((db) => {
    assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'GHOST', session: SESSION, at: AT }).ok, true);
    assert.equal(appendAs(db, chain([
      seed(9, 'security.alert', 'SVC', { code: 'x', message: 'advance clock' }, { at: '2026-11-15T04:00:00.000Z' }),
    ], chainHead(db))).ok, true);
    const result = verify(db);
    const leaked = result.problems.filter((problem) => problem.code === 'lock_leaked');
    assert.equal(leaked.length, 1, JSON.stringify(result.problems));
    assert.equal(leaked[0]?.objectId, 'src/core');
  });
});

test('C5/P2-6: lock_leaked reports an expired active lock even while its card is still in progress', () => {
  withDb((db) => {
    assert.equal(appendAs(db, chain([
      seed(1, 'task.created', 'TASK-L2', { seq: 901, title: 'lock', kind: 'implement', scope_paths: ['a.txt'] }),
    ], chainHead(db))).ok, true);
    assert.equal(claimWithLease(db, { card: 'TASK-L2', actor: 'actor-1', at: AT }).claim.ok, true);
    assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'TASK-L2', session: SESSION, at: AT }).ok, true);
    assert.equal(appendAs(db, chain([
      seed(9, 'security.alert', 'SVC', { code: 'x', message: 'advance clock' }, { at: '2026-11-15T04:00:00.000Z' }),
    ], chainHead(db))).ok, true);
    const result = verify(db);
    const leaked = result.problems.filter((problem) => problem.code === 'lock_leaked');
    assert.equal(leaked.length, 1, JSON.stringify(result.problems));
    assert.equal(leaked[0]?.objectId, 'src/core');
    assert.equal(result.problems.filter((problem) => problem.code === 'lock_missing').length, 0);
  });
});

test('C5/P2-7: lock_missing only fires for cards that historically acquired a lock', () => {
  withDb((db) => {
    // 一张从未申请过锁的 in_progress 卡（M4-1 之前的历史形态）不进入检查。
    assert.equal(appendAs(db, chain([
      seed(1, 'task.created', 'TASK-L3', { seq: 902, title: 'lock', kind: 'implement', scope_paths: ['a.txt'] }),
    ], chainHead(db))).ok, true);
    assert.equal(claimWithLease(db, { card: 'TASK-L3', actor: 'actor-1', at: AT }).claim.ok, true);
    // 另一个卡的历史锁事件激活锁检查（acquire+release 后无活锁）。
    assert.equal(acquireLock(db, { prefix: 'src/core', card_id: 'OTHER-CARD', session: SESSION, at: AT }).ok, true);
    assert.equal(releaseLock(db, { prefix: 'src/core', session: SESSION, at: AT }).ok, true);
    const result = verify(db);
    assert.equal(result.problems.filter((problem) => problem.code === 'lock_missing').length, 0, JSON.stringify(result.problems));
  });
});

test('C5 verify: a DB without lock events stays clean (no retroactive lock checks)', () => {
  withDb((db) => {
    const result = verify(db);
    assert.deepEqual(result.problems.filter((problem) => problem.code.startsWith('lock_')), []);
  });
});

test('C7: a second process cannot admit while another process holds the main-tree lock', async () => {
  await withRepo(async ({ root, db }) => {
    const dbPath = join(root, '.sdo', 'sdo.db');
    for (const card of ['CARD-P1', 'CARD-P2']) {
      const created = await createWorkcopy(db, { root, card, base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
      assert.equal(created.ok, true, JSON.stringify(created));
      writeFileSync(join(cardWorkdir(root, card), 'a.txt'), `${card}\n`);
      const committed = await commitWorkcopy(db, { root, card, base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: card });
      assert.equal(committed.ok, true, JSON.stringify(committed));
    }
    const beforeMain = readFileSync(join(root, 'a.txt'), 'utf8');
    const snapshotsBefore = (db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n;
    const marker = join(root, '.sdo', 'lock-held.marker');
    const holder = spawn(process.execPath, ['--input-type=module', '-e', HOLD], {
      cwd: process.cwd(),
      env: { ...process.env, SDO_LOCK_DB: dbPath, SDO_LOCK_PASS: PASSPHRASE, SDO_LOCK_MARKER: marker },
    });
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          if (readFileSync(marker, 'utf8') === 'held') break;
        } catch { /* not yet */ }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(readFileSync(marker, 'utf8'), 'held', 'holder process did not acquire the main-tree lock');
      const admitted = runSync(ADMIT, {
        SDO_LOCK_DB: dbPath, SDO_LOCK_PASS: PASSPHRASE, SDO_LOCK_ROOT: root, SDO_LOCK_CARD: 'CARD-P2',
      });
      assert.equal(admitted['ok'], false, JSON.stringify(admitted));
      assert.equal(admitted['reason_code'], 'lock_conflict', JSON.stringify(admitted));
      assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), beforeMain);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n, snapshotsBefore);
    } finally {
      holder.kill();
    }
  });
});
