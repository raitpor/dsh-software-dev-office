/**
 * M4-4：`right.granted`/`right.revoked` 事件入口的行为证据（P1-2）。
 * 覆盖 C1（唯一生产者）、C2（撤销权/最后 admin/幂等）、C5（四码对账）、A3（背填）。
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { append, chainHead } from '../../src/db/write.js';
import { grantRight, revokeRight } from '../../src/db/auth.js';
import { backfillGrants, bootstrapEnrollActor, bootstrapGrantRight } from '../../src/db/auth-bootstrap.js';
import { buildEvent } from '../../src/db/freeze-store.js';
import { verify } from '../../src/core/verify.js';
import { query } from '../../src/query/execute.js';
import { verifyRightProjections } from '../../src/core/verify-rights.js';
import { readEvents } from '../../src/core/verify-events.js';
import { fold } from '../../src/core/fold/index.js';
import { withWriteDb } from './append-helpers.js';

const PASS = 'm4-4-right-events-passphrase';
const ROOT = { by: { id: 'root', kind: 'human' as const } };
const AT = '2026-11-17T21:50:00.000Z';

const count = (db: ReturnType<typeof openSdoDatabase>, kind?: string): number => {
  const row = kind === undefined
    ? db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }
    : db.prepare('SELECT count(*) AS n FROM event WHERE kind = ?').get(kind) as { n: number };
  return row.n;
};

function freshWithRoot(): { db: ReturnType<typeof openSdoDatabase>; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'm44-right-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASS);
  runMigrations(db);
  bootstrapEnrollActor(db, { actor: 'root', kind: 'human' });
  bootstrapEnrollActor(db, { actor: 'alice', kind: 'human' });
  bootstrapEnrollActor(db, { actor: 'bob', kind: 'human' });
  bootstrapGrantRight(db, { actor: 'root', right: 'admin', scope: 'domain:core', granted_by: 'root' });
  return { db, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const scopeRow = (db: ReturnType<typeof openSdoDatabase>, actor: string, right: string) =>
  db.prepare('SELECT granted_by, revoked_at, revoked_by FROM scope WHERE actor = ? AND right = ?').get(actor, right) as
    | { granted_by: string; revoked_at: string | null; revoked_by: string | null }
    | undefined;

test('C1: 裸 append right.granted ⇒ unauthorized_right_change、0 事件 0 行', () => {
  const f = freshWithRoot();
  try {
    const before = count(f.db);
    const payload = { grantee: 'alice', right: 'decide', scope: 'domain:core', granted_by: 'root' };
    const event = buildEvent(
      { id: randomUUID(), at: AT, actor: 'root', kind: 'right.granted', subject: 'alice', payload, caused_by: [], request_id: 'rq-bare' },
      chainHead(f.db),
    );
    const result = append(f.db, [event], { session: { actor: 'root', actor_kind: 'human' } });
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'unauthorized_right_change');
    assert.equal(count(f.db), before);
    assert.equal(scopeRow(f.db, 'alice', 'decide'), undefined);
    assert.equal(verify(f.db).ok, true);
  } finally { f.close(); }
});

test('C2: grantRight 正常路径 + 重复授予（事件仍是一条来源链、投影一行）', () => {
  const f = freshWithRoot();
  try {
    const before = count(f.db, 'right.granted');
    assert.equal(grantRight(f.db, { actor: 'alice', right: 'decide', scope: 'domain:core', at: AT }, ROOT).ok, true);
    assert.equal(grantRight(f.db, { actor: 'alice', right: 'decide', scope: 'domain:core', at: AT }, ROOT).ok, true);
    assert.deepEqual(scopeRow(f.db, 'alice', 'decide'), { granted_by: 'root', revoked_at: null, revoked_by: null });
    assert.equal(count(f.db, 'right.granted') - before, 2, '重复授予是两条可审计事件，投影仍一行');
    assert.equal(verify(f.db).ok, true);
  } finally { f.close(); }
});

test('C2: revokeRight 正常路径 + 幂等（二次撤销不补事件）', () => {
  const f = freshWithRoot();
  try {
    grantRight(f.db, { actor: 'alice', right: 'decide', scope: 'domain:core', at: AT }, ROOT);
    const first = revokeRight(f.db, { actor: 'alice', right: 'decide', scope: 'domain:core', reason: 'probe', at: AT }, ROOT);
    assert.equal(first.ok, true);
    const afterFirst = count(f.db, 'right.revoked');
    const second = revokeRight(f.db, { actor: 'alice', right: 'decide', scope: 'domain:core', at: AT }, ROOT);
    assert.equal(second.ok, true);
    assert.equal(count(f.db, 'right.revoked'), afterFirst, '幂等：第二次不补事件');
    const row = scopeRow(f.db, 'alice', 'decide');
    assert.equal(row?.revoked_by, 'root');
    assert.equal(verify(f.db).ok, true);
  } finally { f.close(); }
});

test('C2: 撤最后一个 admin@domain 权 ⇒ last_admin_right、0 事件', () => {
  const f = freshWithRoot();
  try {
    const before = count(f.db);
    const result = revokeRight(f.db, { actor: 'root', right: 'admin', scope: 'domain:core', at: AT }, ROOT);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_code, 'last_admin_right');
    assert.equal(count(f.db), before);
    assert.equal(scopeRow(f.db, 'root', 'admin')?.revoked_at, null, '拒绝时投影也不动');
  } finally { f.close(); }
});

test('C2: 无 admin 的调用者撤别人的权 ⇒ no_permission', () => {
  const f = freshWithRoot();
  try {
    grantRight(f.db, { actor: 'alice', right: 'write', scope: 'module:core', at: AT }, ROOT);
    const result = revokeRight(f.db, { actor: 'bob', right: 'write', scope: 'module:core', at: AT }, { by: { id: 'alice', kind: 'human' } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_code, 'no_permission');
  } finally { f.close(); }
});

test('C2: admin 只能撤自己域内的权（admin@domain:core 撤 domain:other ⇒ no_permission、0 事件）', () => {
  const f = freshWithRoot();
  try {
    bootstrapEnrollActor(f.db, { actor: 'mallory', kind: 'human' });
    bootstrapEnrollActor(f.db, { actor: 'dave', kind: 'human' });
    // dave 是 other 域 admin；alice 的 read@domain:other 由 dave 授予
    bootstrapGrantRight(f.db, { actor: 'dave', right: 'admin', scope: 'domain:other', granted_by: 'root' });
    const granted = grantRight(
      f.db,
      { actor: 'alice', right: 'read', scope: 'domain:other', at: AT },
      { by: { id: 'dave', kind: 'human' } },
    );
    assert.equal(granted.ok, true, '前置：dave 能在自己域内授权');
    const before = count(f.db);
    const denied = revokeRight(
      f.db,
      { actor: 'alice', right: 'read', scope: 'domain:other', at: AT },
      { by: { id: 'mallory', kind: 'human' } },
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reason_code, 'no_permission');
    assert.equal(count(f.db), before, '拒绝时 0 事件');
    assert.equal(scopeRow(f.db, 'alice', 'read')?.revoked_at, null);
    const allowed = revokeRight(
      f.db,
      { actor: 'alice', right: 'read', scope: 'domain:other', at: AT },
      { by: { id: 'dave', kind: 'human' } },
    );
    assert.equal(allowed.ok, true, '同域 admin（dave admin@domain:other）可以撤');
    assert.notEqual(scopeRow(f.db, 'alice', 'read')?.revoked_at, null);
  } finally { f.close(); }
});

test('P1-1: granted_by/revoked_by 入参不允许栽赃（必须等于会话 actor）', () => {
  const f = freshWithRoot();
  try {
    const grant = grantRight(f.db, { actor: 'alice', right: 'decide', scope: 'domain:core', granted_by: 'mallory', at: AT }, ROOT);
    assert.equal(grant.ok, false);
    if (!grant.ok) assert.equal(grant.reason_code, 'invalid_field');
    grantRight(f.db, { actor: 'alice', right: 'decide', scope: 'domain:core', at: AT }, ROOT);
    const revoke = revokeRight(
      f.db,
      { actor: 'alice', right: 'decide', scope: 'domain:core', revoked_by: 'mallory', at: AT },
      ROOT,
    );
    assert.equal(revoke.ok, false);
    if (!revoke.ok) assert.equal(revoke.reason_code, 'invalid_field');
    assert.equal(scopeRow(f.db, 'alice', 'decide')?.granted_by, 'root');
  } finally { f.close(); }
});

test('C5: verify 四码各一条脏数据（missing/extra/mismatch/untracked）', () => {
  const codesOf = (mutate: (db: ReturnType<typeof openSdoDatabase>) => void): string[] => {
    const f = freshWithRoot();
    try {
      grantRight(f.db, { actor: 'alice', right: 'decide', scope: 'domain:core', at: AT }, ROOT);
      mutate(f.db);
      return verify(f.db).problems.map((problem) => problem.code);
    } finally { f.close(); }
  };
  assert.ok(codesOf((db) => db.prepare("DELETE FROM scope WHERE actor = 'alice'").run()).includes('right_projection_missing'));
  assert.ok(codesOf((db) => db.prepare("INSERT INTO scope (actor,scope,right,granted_by,at) VALUES ('alice','module:core','read','root','t')").run()).includes('right_projection_extra'));
  assert.ok(codesOf((db) => db.prepare("UPDATE scope SET granted_by = 'mallory' WHERE actor = 'alice'").run()).includes('right_projection_mismatch'));
  assert.ok(codesOf((db) => db.prepare("INSERT INTO scope (actor,scope,right,granted_by,at) VALUES ('bob','domain:core','read','root','t')").run()).includes('right_grant_untracked'));
});

test('C5/P1-1: 事件 actor 与载荷操作者不一致 ⇒ right_actor_mismatch', () => {
  const f = freshWithRoot();
  try {
    grantRight(f.db, { actor: 'alice', right: 'decide', scope: 'domain:core', at: AT }, ROOT);
    const events = readEvents(f.db, []);
    const tampered = events.map((event) => {
      if (event.kind !== 'right.granted') return event;
      const payload = { ...(event.payload as Record<string, unknown>), granted_by: 'mallory' };
      return { ...event, payload };
    });
    const state = fold(undefined, tampered);
    void state;
    const problems = verifyRightProjections(f.db, tampered as typeof events);
        assert.ok(problems.some((problem) => problem.code === 'right_actor_mismatch'));
  } finally { f.close(); }
});

test('A3: backfillGrants 幂等、二次 skipped、背填后 verify 转绿、legacy 事件 actor 取旧行 granted_by', () => {
  const f = freshWithRoot();
  try {
    const at = '2026-11-01T00:00:00.000Z';
    f.db.prepare("INSERT INTO scope (actor,scope,right,granted_by,at) VALUES ('alice','domain:core','read','root',?)").run(at);
    assert.ok(verify(f.db).problems.some((problem) => problem.code === 'right_grant_untracked'));
    const first = backfillGrants(f.db);
    assert.equal(first.ok, true);
    assert.equal(first.appended, 1);
    assert.equal(first.skipped, 1);
    assert.equal(verify(f.db).ok, true);
    const legacy = f.db.prepare("SELECT actor, payload FROM event WHERE kind = 'right.granted'").get() as { actor: string; payload: string };
    assert.equal(legacy.actor, 'root');
    assert.equal((JSON.parse(legacy.payload) as { granted_by: string }).granted_by, 'root');
    const second = backfillGrants(f.db);
    assert.equal(second.ok, true);
    assert.equal(second.appended, 0);
    assert.equal(second.skipped, 2);
  } finally { f.close(); }
});

test('C3: 撤 read 后同进程查询立即 filtered_by_permission（走 revokeRight，不重启）', () => {
  withWriteDb((db) => {
    // 用不在预置 roster 的 actor，避免基线授权掩盖“撤掉唯一 read 权”的效果。
    bootstrapEnrollActor(db, { actor: 'rights-probe', kind: 'human' });
    const session = { actor: 'rights-probe', actor_kind: 'human' as const, session_id: 'sess-probe', credential: 'cred-probe' };
    grantRight(db, { actor: 'rights-probe', right: 'read', scope: 'domain:core', at: AT }, ROOT);
    const before = query(db, { view: 'pm_queue' }, { session });
    assert.notEqual(before.miss?.reason, 'filtered_by_permission');
    assert.equal(revokeRight(db, { actor: 'rights-probe', right: 'read', scope: 'domain:core', at: AT }, ROOT).ok, true);
    const after = query(db, { view: 'pm_queue' }, { session });
    assert.equal(after.rows.length, 0);
    assert.equal(after.miss?.reason, 'filtered_by_permission');
    assert.equal(count(db, 'right.revoked'), 1, '撤权落一条 right.revoked 事件');
  });
});
