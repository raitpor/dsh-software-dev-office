/** M4-0 边界：C8 合并冲突、C10 时长、workcopy_busy、工具事件负例、C9 verify、CRLF、并发独立。 */
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import git from 'isomorphic-git';

import type { SdoDatabase } from '../../src/db/driver.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { AT, chain, PASSPHRASE, seed } from './append-helpers.js';
import { appendAs, grantAll, grantFixtureRoster } from './append-auth.js';
import { chainHead } from '../../src/db/write.js';
import { bootstrapBaseline, createWorkcopy, commitWorkcopy, admitWorkcopy } from '../../src/db/workcopy.js';
import { cardGitdir, cardWorkdir, objectsDir } from '../../src/core/workcopy/paths.js';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readRawObject } from '../../src/db/vcs.js';
import { verify } from '../../src/core/verify.js';

const SESSION = { actor: 'fixture-root', actor_kind: 'service' as const };

async function withRepo(run: (ctx: { root: string; db: SdoDatabase; base: string }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'sdo-m4-edge-'));
  const db = openSdoDatabase(join(root, '.sdo', 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    grantFixtureRoster(db);
    grantAll(db, 'fixture-root');
    await git.init({ dir: root, fs });
    const base = await bootstrapBaseline(db, {
      root, snapshot_id: 'SNAP-BASE', session: SESSION, at: AT,
      files: { 'a.txt': 'v0\n', 'src/app.ts': 'export const x = 1;\n', 'docs/x.md': 'x\n', '.gitignore': '.sdo/\n.work/\nnode_modules/\n' },
    });
    await run({ root, db, base: base.git_oid });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function seedTask(db: SdoDatabase, id: string): void {
  assert.equal(
    appendAs(db, chain([
      { id: `task.created:${id}`, at: AT, actor: 'fixture-root', kind: 'task.created', subject: id,
        payload: { seq: 991, title: 'M4-0', kind: 'implement', scope_paths: ['a.txt'] }, caused_by: [], request_id: `task:${id}` },
    ], chainHead(db))).ok,
    true,
  );
}

test('C10: create/commit/admit timings stay under the 2s budget', async () => {
  await withRepo(async ({ root, db }) => {
    const created = await createWorkcopy(db, { root, card: 'C-M4-E1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    writeFileSync(join(cardWorkdir(root, 'C-M4-E1'), 'a.txt'), 'v1\n');
    const committed = await commitWorkcopy(db, { root, card: 'C-M4-E1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'c' });
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    const admitted = await admitWorkcopy(db, { root, card: 'C-M4-E1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'c', session: SESSION, at: AT });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    if (!admitted.ok) return;
    assert.ok((created.timings.total_ms ?? Infinity) <= 2000, `create ${created.timings.total_ms}ms`);
    assert.ok((committed.timings.total_ms ?? Infinity) <= 2000, `commit ${committed.timings.total_ms}ms`);
    assert.ok((admitted.timings.total_ms ?? Infinity) <= 2000, `admit ${admitted.timings.total_ms}ms`);
  });
});

test('A4: a held lock returns structured workcopy_busy (no event, no block)', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-E2', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    writeFileSync(join(cardGitdir(root, 'C-M4-E2'), 'sdo-busy.lock'), '1', { flag: 'wx', mode: 0o600 });
    const busy = await createWorkcopy(db, { root, card: 'C-M4-E2', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    assert.equal(busy.ok, false);
    if (busy.ok) return;
    assert.equal(busy.reason_code, 'workcopy_busy');
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM event WHERE kind = 'task.blocked'").get() as { n: number }).n, 0);
    rmSync(join(cardGitdir(root, 'C-M4-E2'), 'sdo-busy.lock'));
    const after = await commitWorkcopy(db, { root, card: 'C-M4-E2', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'c' });
    assert.equal(after.ok, true);
  });
});

test('C3: bare appends of the three tool kinds are rejected and leave zero events', async () => {
  await withRepo(async ({ root, db }) => {
    for (const kind of ['workcopy.created', 'workcopy.removed', 'snapshot.taken']) {
      const events = chain([seed(900, kind, 'X-1', kind === 'snapshot.taken' ? { git_oid: 'x' } : { card: 'C-M4-E3' })], chainHead(db));
      const result = appendAs(db, events);
      assert.equal(result.ok, false, kind);
      if (result.ok) continue;
      assert.equal(result.reason_code, 'unauthorized_workcopy_event');
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number }).n, 1, 'only bootstrap snapshot event');
    }
    assert.equal(verify(db).ok, true);
    assert.equal(existsSync(join(root, '.sdo', 'sdo.db')), true);
  });
});

test('C9: verify reports missing and corrupted shared objects', async () => {
  await withRepo(async ({ root, db, base }) => {
    assert.equal(verify(db).ok, true);
    const path = join(objectsDir(root), 'objects', base.slice(0, 2), base.slice(2));
    const original = readFileSync(path);
    writeFileSync(path, deflateSync(Buffer.from('blob 3\0bad')));
    const corrupted = verify(db).problems.filter((problem) => problem.code === 'vcs_object_hash_mismatch');
    assert.equal(corrupted.length, 1);
    rmSync(path);
    const missing = verify(db).problems.filter((problem) => problem.code === 'vcs_object_missing');
    assert.equal(missing.length, 1);
    writeFileSync(path, original);
    assert.equal(verify(db).ok, true);
  });
});

test('C8: two cards editing the same line conflict on admit (merge_conflict + block)', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-E4', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    await createWorkcopy(db, { root, card: 'C-M4-E5', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    writeFileSync(join(cardWorkdir(root, 'C-M4-E4'), 'a.txt'), 'left\n');
    const first = await admitWorkcopy(db, { root, card: 'C-M4-E4', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'left', session: SESSION, at: AT });
    assert.equal(first.ok, true, JSON.stringify(first));
    seedTask(db, 'T-M4-E5');
    writeFileSync(join(cardWorkdir(root, 'C-M4-E5'), 'a.txt'), 'right\n');
    const second = await admitWorkcopy(db, { root, card: 'C-M4-E5', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'right', session: SESSION, at: AT, task_id: 'T-M4-E5' });
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.reason_code, 'merge_conflict');
    const blocked = db.prepare("SELECT payload FROM event WHERE kind = 'task.blocked'").get() as { payload: string };
    assert.equal((JSON.parse(blocked.payload) as { block_code: string }).block_code, 'merge_conflict');
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'left\n', 'main tree keeps the adopted baseline');
  });
});

test('CRLF: commit normalizes text to LF; binary stays byte-identical', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-E6', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt', 'src/app.ts'], session: SESSION, at: AT });
    writeFileSync(join(cardWorkdir(root, 'C-M4-E6'), 'a.txt'), 'v1\r\nsecond\r\n');
    writeFileSync(join(cardWorkdir(root, 'C-M4-E6'), 'src/app.ts'), Buffer.from([0, 1, 2]));
    const committed = await commitWorkcopy(db, { root, card: 'C-M4-E6', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt', 'src/app.ts'], message: 'c' });
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    writeFileSync(join(cardWorkdir(root, 'C-M4-E6'), 'a.txt'), 'v1\r\nsecond\r\n');
    const admitted = await admitWorkcopy(db, { root, card: 'C-M4-E6', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt', 'src/app.ts'], message: 'c', session: SESSION, at: AT });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'v1\nsecond\n');
  });
});

test('C1: two cards keep independent gitdirs and indexes', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-E7', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    await createWorkcopy(db, { root, card: 'C-M4-E8', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    writeFileSync(join(cardWorkdir(root, 'C-M4-E7'), 'a.txt'), 'v7\n');
    writeFileSync(join(cardWorkdir(root, 'C-M4-E8'), 'a.txt'), 'v8\n');
    const seven = await commitWorkcopy(db, { root, card: 'C-M4-E7', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'c7' });
    assert.equal(seven.ok, true);
    const eight = await commitWorkcopy(db, { root, card: 'C-M4-E8', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'c8' });
    assert.equal(eight.ok, true);
    assert.equal(lstatSync(join(cardGitdir(root, 'C-M4-E7'), 'index')).isFile(), true);
    assert.equal(lstatSync(join(cardGitdir(root, 'C-M4-E8'), 'index')).isFile(), true);
    assert.notEqual(join(cardGitdir(root, 'C-M4-E7'), 'index'), join(cardGitdir(root, 'C-M4-E8'), 'index'));
    if (seven.ok && eight.ok) assert.notEqual(seven.card_oid, eight.card_oid);
  });
});

test('P1-2: merge 后重判脏（TOCTOU）⇒ block，主树一个字节不动、不落 snapshot', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-TOC', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    writeFileSync(join(cardWorkdir(root, 'C-M4-TOC'), 'a.txt'), 'v1\n');
    const snapshotsBefore = (db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n;
    const mainBefore = readFileSync(join(root, 'a.txt'));
    const blocked = await admitWorkcopy(db, {
      root, card: 'C-M4-TOC', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'toctou', session: SESSION, at: AT,
      beforeRewrite: () => writeFileSync(join(root, 'rogue.txt'), 'written mid-flight\n'),
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.reason_code, 'dirty_main_tree');
      assert.deepEqual((blocked['diff'] as { extra: string[] }).extra, ['rogue.txt']);
    }
    assert.equal(readFileSync(join(root, 'rogue.txt'), 'utf8'), 'written mid-flight\n', 'mid-flight file must remain');
    assert.deepEqual(readFileSync(join(root, 'a.txt')), mainBefore, 'main tree must not be touched');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n, snapshotsBefore, 'no snapshot on blocked admit');
  });
});

test('P2-9: C10 P95 ≤ 2000ms（≥20 次 create+commit+admit，含冷启动场景）', async () => {
  await withRepo(async ({ root, db }) => {
    const totals: number[] = [];
    const headSnapshot = (): string => (db.prepare(
      'SELECT id FROM snapshot s WHERE NOT EXISTS (SELECT 1 FROM snapshot_parent p WHERE p.parent_id = s.id) ORDER BY s.at DESC, s.id DESC LIMIT 1',
    ).get() as { id: string }).id;
    for (let i = 0; i < 20; i += 1) {
      const card = `C-M4-P95-${i}`;
      const baseId = headSnapshot();
      const created = await createWorkcopy(db, { root, card, base_snapshot_id: baseId, scope_paths: ['a.txt'], session: SESSION, at: AT });
      assert.equal(created.ok, true, JSON.stringify(created));
      if (!created.ok) return;
      if (i === 0) assert.ok((created.timings.total_ms ?? 0) <= 2000, `cold create ${created.timings.total_ms ?? 0}ms`);
      totals.push(created.timings.total_ms ?? 0);
      writeFileSync(join(cardWorkdir(root, card), 'a.txt'), `v${i}\n`);
      const committed = await commitWorkcopy(db, { root, card, base_snapshot_id: baseId, scope_paths: ['a.txt'], message: `p95 ${i}` });
      assert.equal(committed.ok, true);
      if (!committed.ok) return;
      totals.push(committed.timings.total_ms ?? 0);
      const admitted = await admitWorkcopy(db, { root, card, base_snapshot_id: baseId, scope_paths: ['a.txt'], message: `p95 ${i}`, session: SESSION, at: AT });
      assert.equal(admitted.ok, true, JSON.stringify(admitted));
      if (!admitted.ok) return;
      totals.push(admitted.timings.total_ms ?? 0);
    }
    const sorted = [...totals].sort((a, b) => a - b);
    const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] as number;
    assert.ok(p95 <= 2000, `P95 ${p95}ms over ${sorted.length} samples`);
  });
});

test('P2-6: verify 递归校验 tree 对象（删一个 tree ⇒ vcs_object_missing）', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-TREE', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    writeFileSync(join(cardWorkdir(root, 'C-M4-TREE'), 'a.txt'), 'tree\n');
    const committed = await commitWorkcopy(db, { root, card: 'C-M4-TREE', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'tree' });
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    const admitted = await admitWorkcopy(db, { root, card: 'C-M4-TREE', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'tree', session: SESSION, at: AT });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(verify(db).ok, true);
    const raw = await readRawObject(objectsDir(root), committed.card_oid);
    assert.notEqual(raw, undefined);
    const treeOid = /^tree ([0-9a-f]{40})$/m.exec(raw?.content.toString('utf8') ?? '')?.[1];
    assert.notEqual(treeOid, undefined);
    const treePath = join(objectsDir(root), 'objects', (treeOid as string).slice(0, 2), (treeOid as string).slice(2));
    const original = readFileSync(treePath);
    rmSync(treePath);
    const problems = verify(db).problems.filter((problem) => problem.code === 'vcs_object_missing');
    assert.equal(problems.length, 1);
    writeFileSync(treePath, original);
    assert.equal(verify(db).ok, true);
  });
});

test('P1-5/P2-6: DB 在 <root>/sdo.db 时仍能定位对象库（默认 serve 形态）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sdo-m4-rootdb-'));
  const db = openSdoDatabase(join(root, 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    grantFixtureRoster(db);
    grantAll(db, 'fixture-root');
    await git.init({ dir: root, fs });
    const base = await bootstrapBaseline(db, {
      root, snapshot_id: 'SNAP-BASE', session: SESSION, at: AT,
      files: { 'a.txt': 'v0\n', '.gitignore': '.sdo/\n.work/\nnode_modules/\nsdo.db\n' },
    });
    assert.notEqual(base.git_oid, '');
    await createWorkcopy(db, { root, card: 'C-M4-ROOTDB', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    writeFileSync(join(cardWorkdir(root, 'C-M4-ROOTDB'), 'a.txt'), 'root-db\n');
    const admitted = await admitWorkcopy(db, { root, card: 'C-M4-ROOTDB', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'rootdb', session: SESSION, at: AT });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.deepEqual(verify(db).problems.filter((problem) => problem.code.startsWith('vcs_')), []);
    // 证明是从工作区根定位到对象库：删一个 tree 对象，verify 必须报 missing（旧 dirname 推导会静默漏检）。
    const snapshotOid = (db.prepare('SELECT git_oid FROM snapshot ORDER BY at DESC, id DESC LIMIT 1').get() as { git_oid: string }).git_oid;
    const commit = await readRawObject(objectsDir(root), snapshotOid);
    const treeOid = /^tree ([0-9a-f]{40})$/m.exec(commit?.content.toString('utf8') ?? '')?.[1];
    assert.notEqual(treeOid, undefined);
    const treePath = join(objectsDir(root), 'objects', (treeOid as string).slice(0, 2), (treeOid as string).slice(2));
    const treeBytes = readFileSync(treePath);
    rmSync(treePath);
    assert.equal(verify(db).problems.filter((problem) => problem.code === 'vcs_object_missing').length, 1);
    writeFileSync(treePath, treeBytes);
    assert.equal(verify(db).ok, true);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('P2-1: rewrite 自己的扫描发现未忽略多余项 ⇒ block（检查与写同函数，窗口消失）', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-REWRITE', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    writeFileSync(join(cardWorkdir(root, 'C-M4-REWRITE'), 'a.txt'), 'rewrite\n');
    const snapshotsBefore = (db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n;
    const blocked = await admitWorkcopy(db, {
      root, card: 'C-M4-REWRITE', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'rewrite-window', session: SESSION, at: AT,
      rewriteScanHook: () => writeFileSync(join(root, 'rogue-at-rewrite.txt'), 'appeared after dirty check\n'),
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.reason_code, 'dirty_main_tree');
      assert.deepEqual((blocked['diff'] as { extra: string[] }).extra, ['rogue-at-rewrite.txt']);
    }
    assert.equal(readFileSync(join(root, 'rogue-at-rewrite.txt'), 'utf8'), 'appeared after dirty check\n');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM snapshot').get() as { n: number }).n, snapshotsBefore);
  });
});

test('P3-3: 产品路径不传 test-only 注入口（link/beforeRewrite/rewriteScanHook）', async () => {
  const root = fileURLToPath(new URL('../../src', import.meta.url));
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.name.endsWith('.ts')) {
        if (abs.endsWith('core/workcopy/types.ts') || abs.endsWith('db/vcs.ts')) continue;
        const text = readFileSync(abs, 'utf8');
        for (const line of text.split('\n')) {
          if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
          if (/\b(beforeRewrite|rewriteScanHook|link)\s*:/.test(line)) offenders.push(`${abs}: ${line.trim()}`);
        }
      }
    }
  };
  await walk(root);
  assert.deepEqual(offenders, []);
});
