/** M4-2/C1–C6：派发租约 → 认领 → 收回/过期 的最小闭环（走真网关与真库）。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withWriteDb, chain, seed, AT } from './append-helpers.js';
import { appendAs, grantAll, seedRights } from './append-auth.js';
import { append } from '../../src/db/write.js';
import { chainHead } from '../../src/db/write.js';
import { buildEvent } from '../../src/db/freeze-store.js';
import {
  dispatchLease,
  expireLease,
  revokeLease,
  type LeaseSession,
} from '../../src/db/lease.js';
import { verify } from '../../src/core/verify.js';
import { acquireLock } from '../../src/db/lock.js';
import { fold } from '../../src/core/fold/index.js';
import { ACK_KINDS } from '../../src/core/fold/ack.js';
import { KIND_ACTIONS } from '../../src/core/auth/kind-actions.js';

const alice: LeaseSession = { actor: 'alice', actor_kind: 'human' };
const bob: LeaseSession = { actor: 'bob', actor_kind: 'human' };
function createCard(db: Parameters<typeof appendAs>[0], id: string): void {
  const n = 900 + Number(id.slice(-1));
  const events = chain([seed(n, 'task.created', id, {
    seq: n,
    title: id,
    kind: 'implement',
    scope_paths: ['a.txt'],
  })], chainHead(db));
  const result = appendAs(db, events);
  assert.equal(result.ok, true, result.ok ? '' : `${result.reason_code}: ${result.message}`);
}

function appendClaim(db: Parameters<typeof append>[0], card: string, actor: string, at: string = AT) {
  const event = buildEvent(
    {
      id: `claim-${card}-${actor}-${randomUUID()}`,
      at,
      actor,
      kind: 'task.claimed',
      subject: card,
      payload: { owner: actor },
      caused_by: [],
      request_id: `claim:${card}:${actor}:${randomUUID()}`,
    },
    chainHead(db),
  );
  return appendAs(db, [event], { session: { actor, actor_kind: 'human' } });
}

test('C1: dispatchLease issues a lease; raw lease.issued is rejected (unauthorized_lease_issue)', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    createCard(db, 'CARD-L1');
    const dispatched = dispatchLease(db, alice, { card: 'CARD-L1', actor: 'alice', scope: 'domain:core', at: AT });
    assert.equal(dispatched.ok, true);
    const lease = db.prepare('SELECT id, status, actor FROM lease').get() as { id: string; status: string; actor: string };
    assert.equal(lease.status, 'active');
    assert.equal(lease.actor, 'alice');
    // 裸 append：绕过 dispatchLease（无能力）⇒ 网关拒绝
    const forged = buildEvent(
      {
        id: 'lease-forged',
        at: AT,
        actor: 'alice',
        kind: 'lease.issued',
        subject: 'CARD-L1',
        payload: { card: 'CARD-L1', actor: 'alice', scope: 'domain:core', frontier: 'f', ttl_s: 60, expires_at: '2026-11-13T00:01:00Z' },
        caused_by: [],
        request_id: 'forged',
      },
      chainHead(db),
    );
    const rejected = appendAs(db, [forged], { session: alice });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.reason_code, 'unauthorized_lease_issue');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n, 2);
  });
});

test('C2/C6: claim without a lease ⇒ no_lease; with lease the holder claims', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    createCard(db, 'CARD-L1');
    createCard(db, 'CARD-L2');
    // 闸恒开；这里先派发租约只为拿到可用的租约
    assert.equal(dispatchLease(db, alice, { card: 'CARD-L1', actor: 'alice', scope: 'domain:core', at: AT }).ok, true);
    const missing = appendClaim(db, 'CARD-L2', 'alice');
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason_code, 'no_lease');
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'task.claimed'").get() as { n: number }).n, 0);
    assert.equal(appendClaim(db, 'CARD-L1', 'alice').ok, true);
    assert.equal((db.prepare("SELECT status FROM task WHERE id = 'CARD-L1'").get() as { status: string }).status, 'in_progress');
  });
});

test('C2: a lease held by alice does not authorize bob (no_lease)', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    grantAll(db, 'bob');
    createCard(db, 'CARD-L1');
    assert.equal(dispatchLease(db, alice, { card: 'CARD-L1', actor: 'alice', scope: 'domain:core', at: AT }).ok, true);
    const byBob = appendClaim(db, 'CARD-L1', 'bob');
    assert.equal(byBob.ok, false);
    if (!byBob.ok) assert.equal(byBob.reason_code, 'no_lease');
  });
});

test('C3: reservation within its window rejects another actor (not_reserved_actor); reserved actor can claim', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    grantAll(db, 'bob');
    createCard(db, 'CARD-L1');
    const reserve = chain([seed(950, 'task.assigned', 'CARD-L1', { assignee: 'alice', reserved_until: '2026-11-13T02:00:00Z' })], chainHead(db));
    assert.equal(appendAs(db, reserve, { session: { actor: 'alice', actor_kind: 'human' } }).ok, true);
    assert.equal(dispatchLease(db, alice, { card: 'CARD-L1', actor: 'alice', scope: 'domain:core', at: AT }).ok, true);
    const byBob = appendClaim(db, 'CARD-L1', 'bob');
    assert.equal(byBob.ok, false);
    if (!byBob.ok) assert.equal(byBob.reason_code, 'not_reserved_actor');
    assert.equal(appendClaim(db, 'CARD-L1', 'alice').ok, true);
  });
});

test('C4: revokeLease ⇒ blocked(lease_revoked) → ready; verify clean; forged revoked_by rejected', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    grantAll(db, 'bob');
    createCard(db, 'CARD-L1');
    const dispatched = dispatchLease(db, alice, { card: 'CARD-L1', actor: 'alice', scope: 'domain:core', at: AT });
    assert.equal(dispatched.ok, true);
    assert.equal(appendClaim(db, 'CARD-L1', 'alice').ok, true);
    const workdir = join(dirname((db as unknown as { name: string }).name), '.work', 'CARD-L1');
    mkdirSync(workdir, { recursive: true });
    writeFileSync(join(workdir, 'sentinel.txt'), 'keep me');
    const revoked = revokeLease(db, bob, 'lease-CARD-L1-2026-11-13T00:00:00Z-alice', AT);
    // bob 无 assign? grantAll 有；revoke 需要 assign@scope，bob 有
    assert.equal(revoked.ok, true);
    const card = db.prepare("SELECT status, block_code FROM task WHERE id = 'CARD-L1'").get() as { status: string; block_code: string | null };
    assert.equal(card.status, 'ready');
    assert.equal(card.block_code, null);
    const lease = db.prepare('SELECT status, revoked_by FROM lease').get() as { status: string; revoked_by: string };
    assert.equal(lease.status, 'revoked');
    assert.equal(lease.revoked_by, 'bob');
    assert.equal(verify(db).ok, true);
    // C4 FS：收回后工作副本目录与内容仍在（只是 lease 状态变化）。
    assert.equal(readFileSync(join(workdir, 'sentinel.txt'), 'utf8'), 'keep me');
    // 伪造 actor：另起一张卡的活租约，revoked_by 与事件 actor 不一致 ⇒ fold 拒（D-150）。
    createCard(db, 'CARD-L2');
    const second = dispatchLease(db, alice, { card: 'CARD-L2', actor: 'alice', scope: 'domain:core', at: AT });
    assert.equal(second.ok, true);
    const forged = buildEvent(
      {
        id: 'lease-revoked-forged',
        at: AT,
        actor: 'alice',
        kind: 'lease.revoked',
        subject: 'CARD-L2',
        payload: { lease_id: second.lease_id, card_id: 'CARD-L2', scope: 'domain:core', revoked_by: 'bob' },
        caused_by: [],
        request_id: 'forged',
      },
      chainHead(db),
    );
    const rejected = appendAs(db, [forged], { session: alice });
    assert.equal(rejected.ok, false);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n, 8);
  });
});

test('C5: expireLease ⇒ card ready; expired lease no longer authorizes claim (lease_expired)', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    createCard(db, 'CARD-L1');
    const dispatched = dispatchLease(db, alice, { card: 'CARD-L1', actor: 'alice', scope: 'domain:core', at: AT });
    assert.equal(dispatched.ok, true);
    assert.equal(appendClaim(db, 'CARD-L1', 'alice').ok, true);
    const expired = expireLease(db, alice, 'lease-CARD-L1-2026-11-13T00:00:00Z-alice', '2026-11-13T04:00:01Z');
    assert.equal(expired.ok, true);
    const lease = db.prepare('SELECT status FROM lease').get() as { status: string };
    assert.equal(lease.status, 'expired');
    const card = db.prepare("SELECT status FROM task WHERE id = 'CARD-L1'").get() as { status: string };
    assert.equal(card.status, 'ready');
    const again = appendClaim(db, 'CARD-L1', 'alice');
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.reason_code, 'lease_expired');
    assert.equal(verify(db).ok, true);
  });
});

test('C7/C1/C9: unique active index, verify lease_missing/lease_actor_mismatch, ACK→reducer migration', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    createCard(db, 'CARD-L1');
    const dispatched = dispatchLease(db, alice, { card: 'CARD-L1', actor: 'alice', scope: 'domain:core', at: AT });
    assert.equal(dispatched.ok, true);
    assert.equal(appendClaim(db, 'CARD-L1', 'alice').ok, true);
    const leaseId = (db.prepare('SELECT id FROM lease').get() as { id: string }).id;
    // C1 第二道闸：同卡第二条 active lease 被部分唯一索引拒（DB 层，不靠应用先查后插）。
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO lease (id, card_id, actor, scope, frontier, ttl_s, issued_at, expires_at, status) VALUES ('lease-dup', 'CARD-L1', 'bob', 'domain:core', 'f', 60, ?, ?, 'active')",
          )
          .run(AT, '2026-11-13T00:01:00Z'),
      /UNIQUE constraint failed: lease\.card_id/,
    );
    // C7 lease_missing：把唯一的活租约改成 expired（模拟绕过网关的脏数据），busy 卡无活租约。
    db.prepare("UPDATE lease SET status = 'expired' WHERE id = ?").run(leaseId);
    const missing = verify(db).problems.filter((problem) => problem.code === 'lease_missing');
    assert.equal(missing.length, 1);
    assert.equal(missing[0]?.objectId, 'CARD-L1');
    // C7 lease_actor_mismatch：恢复 active 但把 actor 改成 bob（claim 的 actor 是 alice）。
    db.prepare("UPDATE lease SET status = 'active', actor = 'bob' WHERE id = ?").run(leaseId);
    const mismatched = verify(db).problems.filter((problem) => problem.code === 'lease_actor_mismatch');
    assert.equal(mismatched.length, 1);
    // C9：两个 kind 不在 ACK 名单，且在 KIND_ACTIONS 映射里。
    assert.equal(Object.hasOwn(ACK_KINDS, 'lease.issued'), false);
    assert.equal(Object.hasOwn(ACK_KINDS, 'lease.expired'), false);
    assert.equal(KIND_ACTIONS['lease.issued']?.action, 'dispatch');
    assert.equal(KIND_ACTIONS['lease.expired']?.action, 'dispatch');
  });
});

test('P1: expireLease cannot run early and requires assign on the lease scope', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    createCard(db, 'CARD-L1');
    const dispatched = dispatchLease(db, alice, { card: 'CARD-L1', actor: 'alice', scope: 'domain:core', at: AT });
    assert.equal(dispatched.ok, true);
    const leaseId = (db.prepare('SELECT id FROM lease').get() as { id: string }).id;
    const before = (db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n;
    const early = expireLease(db, alice, leaseId, '2026-11-13T01:00:00Z');
    assert.equal(early.ok, false);
    if (!early.ok) assert.equal(early.reason_code, 'lease_not_expired');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n, before);
    const denied = expireLease(db, { actor: 'mallory', actor_kind: 'human' }, leaseId, '2026-11-13T04:00:01Z');
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reason_code, 'no_permission');
    const expired = expireLease(db, alice, leaseId, '2026-11-13T04:00:01Z');
    assert.equal(expired.ok, true, JSON.stringify(expired));
  });
});

test('P2/D-150: revoke authorization is identical through direct append and API (assign@lease.scope)', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    seedRights(db, [{ actor: 'alice', scope: 'domain:other', right: 'assign' }]);
    createCard(db, 'CARD-L1');
    const dispatched = dispatchLease(db, alice, { card: 'CARD-L1', actor: 'alice', scope: 'domain:other', at: AT });
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
    const leaseId = (db.prepare('SELECT id FROM lease').get() as { id: string }).id;
    // mallory 只有 domain:core 的 assign，租约行 scope=domain:other：两侧都必须拒。
    seedRights(db, [
      { actor: 'mallory', scope: 'domain:core', right: 'assign' },
      { actor: 'mallory', scope: 'domain:core', right: 'read' },
    ]);
    const api = revokeLease(db, { actor: 'mallory', actor_kind: 'human' }, leaseId, AT);
    assert.equal(api.ok, false);
    if (!api.ok) assert.equal(api.reason_code, 'no_permission');
    const forged = buildEvent(
      {
        id: 'e-forged-revoke-scope',
        at: AT,
        actor: 'mallory',
        kind: 'lease.revoked',
        subject: 'CARD-L1',
        // 负例故意省略 scope：正确实现按租约行 domain:other 判权 ⇒ no_permission；
        // 若 scope 回退 payload/domain:core，则网关会放行、由 reducer 报错（read 码不同）。
        payload: { lease_id: leaseId, card_id: 'CARD-L1', revoked_by: 'mallory' },
        caused_by: [],
        request_id: 'forged-scope',
      },
      chainHead(db),
    );
    const direct = append(db, [forged], { session: { actor: 'mallory', actor_kind: 'human' } });
    assert.equal(direct.ok, false);
    if (!direct.ok) assert.equal(direct.reason_code, 'no_permission');
    // 给 mallory domain:other 的 assign 后，两条路径都成功（同一口径）。
    seedRights(db, [{ actor: 'mallory', scope: 'domain:other', right: 'assign' }]);
    const directOk = append(db, [buildEvent(
      {
        id: 'e-direct-revoke-scope-ok',
        at: AT,
        actor: 'mallory',
        kind: 'lease.revoked',
        subject: 'CARD-L1',
        payload: { lease_id: leaseId, card_id: 'CARD-L1', scope: 'domain:other', revoked_by: 'mallory' },
        caused_by: [],
        request_id: 'direct-ok',
      },
      chainHead(db),
    )], { session: { actor: 'mallory', actor_kind: 'human' } });
    assert.equal(directOk.ok, true, JSON.stringify(directOk));
    createCard(db, 'CARD-L2');
    const second = dispatchLease(db, alice, { card: 'CARD-L2', actor: 'alice', scope: 'domain:other', at: AT });
    assert.equal(second.ok, true);
    const apiOk = revokeLease(db, { actor: 'mallory', actor_kind: 'human' }, second.lease_id, AT);
    assert.equal(apiOk.ok, true, JSON.stringify(apiOk));
    // 已 revoked 的租约再撤 ⇒ lease_not_active（API 与直 append 同一断言面）。
    const again = revokeLease(db, { actor: 'mallory', actor_kind: 'human' }, second.lease_id, AT);
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.reason_code, 'lease_not_active');
  });
});

test('P2: lease window compares absolute instants across timezone offsets', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    createCard(db, 'CARD-L1');
    const dispatched = dispatchLease(db, alice, {
      card: 'CARD-L1', actor: 'alice', scope: 'domain:core', ttl_s: 3600, at: '2026-11-17T00:00:00-05:00',
    });
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
    assert.equal(appendClaim(db, 'CARD-L1', 'alice', '2026-11-17T05:30:00Z').ok, true);
    createCard(db, 'CARD-L2');
    const second = dispatchLease(db, alice, {
      card: 'CARD-L2', actor: 'alice', scope: 'domain:core', ttl_s: 3600, at: '2026-11-17T00:00:00-05:00',
    });
    assert.equal(second.ok, true);
    const late = appendClaim(db, 'CARD-L2', 'alice', '2026-11-17T06:30:00Z');
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.reason_code, 'lease_expired');

    // 绝对时刻早于发放：issued_at = 2026-11-16T23:00-05:00 = 2026-11-17T04:00Z。
    createCard(db, 'CARD-L3');
    const future = dispatchLease(db, alice, {
      card: 'CARD-L3', actor: 'alice', scope: 'domain:core', ttl_s: 3600, at: '2026-11-16T23:00:00-05:00',
    });
    assert.equal(future.ok, true, JSON.stringify(future));
    const tooEarly = appendClaim(db, 'CARD-L3', 'alice', '2026-11-17T03:30:00Z');
    assert.equal(tooEarly.ok, false);
    if (!tooEarly.ok) assert.equal(tooEarly.reason_code, 'no_lease');
  });
});

test('P3-5: revoking a lease keeps the card lock active with released_by=lease_revoked (no deadlock)', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    createCard(db, 'CARD-L1');
    const acquired = acquireLock(db, { prefix: 'src/core', card_id: 'CARD-L1', session: alice, at: AT });
    assert.equal(acquired.ok, true, JSON.stringify(acquired));
    const dispatched = dispatchLease(db, alice, { card: 'CARD-L1', actor: 'alice', scope: 'domain:core', at: AT });
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
    const leaseId = (db.prepare('SELECT id FROM lease').get() as { id: string }).id;
    const revoked = revokeLease(db, alice, leaseId, AT);
    assert.equal(revoked.ok, true, JSON.stringify(revoked));
    const lock = db.prepare("SELECT status, released_by FROM lock WHERE path_prefix = 'src/core'").get() as { status: string; released_by: string };
    assert.equal(lock.status, 'active');
    assert.equal(lock.released_by, 'lease_revoked');
    // 同 actor 同卡重领同前缀：不冲突（租约撤销语义保留锁的可重入）。
    const reclaim = acquireLock(db, { prefix: 'src/core', card_id: 'CARD-L1', session: alice, at: AT });
    assert.equal(reclaim.ok, true, JSON.stringify(reclaim));
    // 别的卡仍冲突。
    createCard(db, 'CARD-L2');
    const other = acquireLock(db, { prefix: 'src/core', card_id: 'CARD-L2', session: alice, at: AT });
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.reason_code, 'lock_conflict');
  });
});

test('P3-3: lease.issued compares absolute instants, not raw strings', () => {
  const issued = {
    id: 'e-lease-tz-offset',
    at: '2026-11-17T05:00:00Z',
    actor: 'alice',
    kind: 'lease.issued',
    subject: 'CARD-TZ',
    payload: {
      card: 'CARD-TZ', actor: 'alice', scope: 'domain:core', frontier: 'sha256:f',
      ttl_s: 3600, expires_at: '2026-11-17T01:00:00-05:00',
    },
    caused_by: [],
    request_id: 'tz-offset',
    prev: 'sha256:' + '0'.repeat(64),
    hash: 'sha256:' + '1'.repeat(64),
  };
  const state = fold(undefined, [issued]);
  assert.notEqual(state.tables.lease['e-lease-tz-offset'], undefined);
});
