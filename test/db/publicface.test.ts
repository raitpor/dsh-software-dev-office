/** M4-3：公共面登记、申请幂等、单写者能力与 verify（走真库/真网关）。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { withWriteDb, chain, seed, AT } from './append-helpers.js';
import { appendAs, grantAll } from './append-auth.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { append, chainHead } from '../../src/db/write.js';
import { buildEvent } from '../../src/db/freeze-store.js';
import { readPublicFace, publicFaceHits } from '../../src/core/publicface/catalog.js';
import {
  bootstrapPublicFaceWriter,
  executePublicFaceChange,
  requestPublicFace,
  transferPublicFaceWriter,
  type PublicFaceSession,
} from '../../src/db/publicface.js';
import { verify } from '../../src/core/verify.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PASSPHRASE } from './append-helpers.js';
import { TABLE_NAMES } from '../../src/core/fold/types.js';

const alice: PublicFaceSession = { actor: 'alice', actor_kind: 'human' };
const bob: PublicFaceSession = { actor: 'bob', actor_kind: 'human' };
const operator: PublicFaceSession = { actor: 'fixture-root', actor_kind: 'service' };

function createCard(db: SdoDatabase, id: string, scopePaths: readonly string[] = ['src/core']): void {
  const n = 800 + Number(id.slice(-1));
  const result = appendAs(db, chain([seed(n, 'task.created', id, {
    seq: n, title: id, kind: 'implement', scope_paths: [...scopePaths],
  })], chainHead(db)));
  assert.equal(result.ok, true, result.ok ? '' : `${result.reason_code}: ${result.message}`);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    // P3（M4-3 第 2 轮评审）：守卫要连 .sql 迁移一起扫，否则 018 的白名单形同虚设。
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.sql')) out.push(path);
  }
  return out;
}

test('C1: public face is migration-owned data; append cannot materialize it', () => {
  withWriteDb((db) => {
    const entries = readPublicFace(db);
    assert.ok(entries.length >= 6);
    assert.ok(entries.some((entry) => entry.prefix === 'migrations/003_event_kinds.sql'));
    assert.ok(entries.some((entry) => entry.prefix === 'migrations/002_views.sql'));
    // 选择 ①：public_face 根本不是 fold 表，因此没有第二条 append 物化路径。
    assert.equal((TABLE_NAMES as readonly string[]).includes('public_face'), false);
    // 静态证据：src/ 与 migrations/ 里除 018 白名单外没有写 public_face 的 SQL（P3-5）。
    const pattern = /INSERT\s+(OR\s+\w+\s+)?INTO\s+["']?(main\.)?public_face\b/i;
    const allowed = join('migrations', '018_public_face.sql');
    const offenders = [...sourceFiles('src'), ...sourceFiles('migrations')]
      .filter((file) => !file.endsWith(allowed))
      .filter((file) => pattern.test(readFileSync(file, 'utf8')));
    assert.deepEqual(offenders, []);
    assert.equal(publicFaceHits(['migrations/003_event_kinds.sql'], entries).length, 1);
    assert.equal(publicFaceHits(['src/views/catalog.ts'], entries).length, 0, '未把 src/views/** 划成公共面');
    assert.equal(publicFaceHits(['src/core/criteria/register.ts'], entries).length, 1);
  });
});

test('C3: requestPublicFace is idempotent on (card, intent_hash) and ignores caller-supplied hashes', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    createCard(db, 'T-M43-C3');
    const intent = { kind: 'register_criterion', criterion: 'CRIT-M43' };
    const first = requestPublicFace(db, alice, { card: 'T-M43-C3', intent, diff: '+ criterion', at: AT });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.scope, 'module:src');
    const second = requestPublicFace(db, alice, { card: 'T-M43-C3', intent: { criterion: 'CRIT-M43', kind: 'register_criterion' }, diff: '+ criterion', at: AT });
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.event_id, first.event_id);
    const third = requestPublicFace(db, alice, { card: 'T-M43-C3', intent: { kind: 'add_view', view: 'v2' }, diff: '+ view', at: AT });
    assert.equal(third.ok, true);
    assert.notEqual(third.event_id, first.event_id);
    const rows = db.prepare("SELECT count(*) AS n FROM event WHERE kind = 'publicface.requested'").get() as { n: number };
    assert.equal(rows.n, 2);
  });
});

test('C4: only the capability holder executes; direct append is rejected; transfer keeps single writer', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    grantAll(db, 'bob');
    createCard(db, 'T-M43-C4');
    const request = requestPublicFace(db, alice, { card: 'T-M43-C4', intent: { kind: 'register_criterion' }, diff: '+', at: AT });
    assert.equal(request.ok, true);
    const requestId = request.event_id!;
    // 无 writer 时执行 ⇒ 拒
    assert.equal(executePublicFaceChange(db, alice, { request_id: requestId, at: AT }).reason_code, 'not_public_face_writer');
    // 初始单写者：operator 用能力路径交给 alice
    assert.equal(bootstrapPublicFaceWriter(db, operator, { to: 'alice', at: AT }).ok, true);
    // 直 append 伪造 writer_changed / executed ⇒ 能力拒
    const forged = buildEvent({
      id: 'pf-forged', at: AT, actor: 'alice', kind: 'publicface.executed', subject: requestId,
      payload: { card: 'T-M43-C4', request_id: requestId }, caused_by: [], request_id: 'forged',
    }, chainHead(db));
    const rejected = append(db, [forged], { session: { actor: 'alice', actor_kind: 'human' } });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason_code, 'not_public_face_writer');
    // bob 不是 holder ⇒ 不能执行、不能交棒
    assert.equal(executePublicFaceChange(db, bob, { request_id: requestId, at: AT }).reason_code, 'not_public_face_writer');
    assert.equal(transferPublicFaceWriter(db, bob, { to: 'bob', at: AT }).reason_code, 'not_public_face_writer');
    // holder 执行成功，且行确实只有一个
    const executed = executePublicFaceChange(db, alice, { request_id: requestId, at: AT });
    assert.equal(executed.ok, true, JSON.stringify(executed));
    const writer = db.prepare('SELECT actor FROM public_face_writer').all() as { actor: string }[];
    assert.deepEqual(writer, [{ actor: 'alice' }]);
    // P2-2：同一 request 再执行 ⇒ 幂等，不落第二条 executed。
    const again = executePublicFaceChange(db, alice, { request_id: requestId, at: AT });
    assert.equal(again.ok, true);
    assert.equal(again.idempotent, true, JSON.stringify(again));
    const executedCount = db.prepare("SELECT count(*) AS n FROM event WHERE kind = 'publicface.executed'").get() as { n: number };
    assert.equal(executedCount.n, 1);
    // 交棒后旧 holder 无权、新 holder 有权
    assert.equal(transferPublicFaceWriter(db, alice, { to: 'bob', at: AT }).ok, true);
    assert.deepEqual(db.prepare('SELECT actor FROM public_face_writer').all(), [{ actor: 'bob' }]);
    assert.equal(executePublicFaceChange(db, alice, { request_id: requestId, at: AT }).reason_code, 'not_public_face_writer');
  });
});

test('C5: a request never writes card-owned rows (no snapshot/workcopy side effects)', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    createCard(db, 'T-M43-C5');
    const before = {
      snapshots: (db.prepare('SELECT count(*) AS n FROM snapshot').get() as { n: number }).n,
      events: (db.prepare('SELECT count(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n,
    };
    const request = requestPublicFace(db, alice, { card: 'T-M43-C5', intent: { kind: 'register_criterion' }, diff: '+', at: AT });
    assert.equal(request.ok, true);
    const after = {
      snapshots: (db.prepare('SELECT count(*) AS n FROM snapshot').get() as { n: number }).n,
      events: (db.prepare('SELECT count(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n,
    };
    assert.equal(after.snapshots, before.snapshots, '公共面申请不得产生 snapshot');
    assert.equal(after.events, before.events + 1, '只允许一条申请事件');
  });
});

test('C6: verify reports scope overlap and stale unexecuted requests', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    // 绕过准入直接写一条命中公共面的 task（模拟历史/脏数据）
    const bad = appendAs(db, chain([seed(810, 'task.created', 'T-M43-C6-BAD', {
      seq: 810, title: 'bad', kind: 'implement', scope_paths: ['migrations/003_event_kinds.sql'],
    })], chainHead(db)));
    assert.equal(bad.ok, true);
    createCard(db, 'T-M43-C6');
    const request = requestPublicFace(db, alice, { card: 'T-M43-C6', intent: { kind: 'pending' }, diff: '+', at: AT });
    assert.equal(request.ok, true);
    // 让事件日志的“现在”推进 8 天（verify 以 max(event.at) 为 now）
    const later = '2026-11-24T00:00:00.000Z';
    const alert = buildEvent({
      id: 'alert-m43', at: later, actor: 'alice', kind: 'security.alert', subject: 'x',
      payload: { reason: 'clock' }, caused_by: [], request_id: 'alert',
    }, chainHead(db));
    assert.equal(appendAs(db, [alert]).ok, true);
    const report = verify(db);
    const codes = report.problems.map((problem) => problem.code);
    assert.ok(codes.includes('public_face_scope_overlap'), JSON.stringify(codes));
    assert.ok(codes.includes('public_face_request_stale'), JSON.stringify(codes));
  });
});

test('C4: two independent processes race for the single writer ⇒ exactly one succeeds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m43-proc-'));
  const dbPath = join(dir, 'sdo.db');
  const ready = join(dir, 'ready');
  const barrier = join(dir, 'barrier');
  const db = openSdoDatabase(dbPath, PASSPHRASE);
  try {
    runMigrations(db);
    grantAll(db, 'alice');
    grantAll(db, 'carol');
    assert.equal(bootstrapPublicFaceWriter(db, operator, { to: 'alice', at: AT }).ok, true);
    const script = [
      "import { writeFileSync, existsSync } from 'node:fs';",
      "import { transferPublicFaceWriter } from './lib/src/db/publicface.js';",
      "const { openSdoDatabase } = await import('./lib/src/db/open.js');",
      "const db = openSdoDatabase(process.env.PF_DB, process.env.PF_PASS);",
      "writeFileSync(process.env.PF_READY, '1');",
      "const deadline = Date.now() + 5000;",
      "while (!existsSync(process.env.PF_BARRIER)) { if (Date.now() > deadline) break; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }",
      "const r = transferPublicFaceWriter(db, { actor: 'alice', actor_kind: 'human' }, { to: 'carol', at: '2026-11-15T09:00:00.000Z' });",
      "db.close();",
      "process.stdout.write(JSON.stringify(r));",
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(),
      env: { ...process.env, PF_DB: dbPath, PF_PASS: PASSPHRASE, PF_READY: ready, PF_BARRIER: barrier },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    const waitDeadline = Date.now() + 5000;
    while (!existsSync(ready)) {
      if (Date.now() > waitDeadline) throw new Error('child did not become ready');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    writeFileSync(barrier, '1');
    const parent = transferPublicFaceWriter(db, alice, { to: 'bob', at: AT });
    const code = await exited;
    assert.equal(code, 0, stderr);
    const childResult = JSON.parse(stdout) as { ok: boolean; reason_code?: string };
    const successes = [parent.ok, childResult.ok].filter((value) => value === true).length;
    assert.equal(successes, 1, JSON.stringify({ parent, child: childResult }));
    const writers = db.prepare('SELECT actor FROM public_face_writer').all() as { actor: string }[];
    assert.equal(writers.length, 1);
    assert.ok(['bob', 'carol'].includes(writers[0]!.actor));
    const changes = db.prepare("SELECT count(*) AS n FROM event WHERE kind = 'publicface.writer_changed'").get() as { n: number };
    assert.equal(changes.n, 2, 'bootstrap + exactly one winning transfer');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P3-7/P2-3: public_face is read-only outside migration; writer is single-row; verify catches drift', () => {
  withWriteDb((db) => {
    assert.throws(
      () => db.prepare("INSERT INTO public_face (prefix, note, since) VALUES ('x', 'n', '2026-11-17')").run(),
      /read-only/i,
    );
    assert.throws(
      () => db.prepare("UPDATE public_face SET note = 'changed'").run(),
      /read-only/i,
    );
    grantAll(db, 'alice');
    assert.equal(bootstrapPublicFaceWriter(db, operator, { to: 'alice', at: AT }).ok, true);
    // 直插第二行被 CHECK(id=1)/触发器拒绝
    assert.throws(
      () => db.prepare("INSERT INTO public_face_writer (id, actor, held_since, note) VALUES (2, 'bob', ?, NULL)").run(AT),
      /single-row|CHECK/i,
    );
    // 直改 writer 行（绕过事件）⇒ verify 投影对账红
    db.prepare("UPDATE public_face_writer SET actor = 'mallory' WHERE id = 1").run();
    const report = verify(db);
    assert.ok(report.problems.some((problem) => problem.code === 'public_face_writer_mismatch'), JSON.stringify(report.problems.map((p) => p.code)));
  });
});

// P3（M4-3 第 2 轮评审）：writer 投影对账的 missing/extra 两码此前只有手工探针，没有正式用例。
test('C4/P3: verify reports public_face_writer_extra when the row exists without an event', () => {
  withWriteDb((db) => {
    // 没有任何 publicface.writer_changed 事件，直接塞一行 ⇒ fold 期望为空、库内多一行。
    db.prepare("INSERT INTO public_face_writer (id, actor, held_since, note) VALUES (1, 'mallory', ?, NULL)").run(AT);
    const report = verify(db);
    assert.ok(
      report.problems.some((problem) => problem.code === 'public_face_writer_extra'),
      JSON.stringify(report.problems.map((p) => p.code)),
    );
  });
});

test('C4/P3: verify reports public_face_writer_missing when the event exists but the row was deleted', () => {
  withWriteDb((db) => {
    grantAll(db, 'alice');
    assert.equal(bootstrapPublicFaceWriter(db, operator, { to: 'alice', at: AT }).ok, true);
    db.prepare('DELETE FROM public_face_writer').run();
    const report = verify(db);
    assert.ok(
      report.problems.some((problem) => problem.code === 'public_face_writer_missing'),
      JSON.stringify(report.problems.map((p) => p.code)),
    );
  });
});

