/** M4-0：工作副本最小闭环（C1/C2/C3/C4/C5/C6/C7/C9）。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import git from 'isomorphic-git';

import type { SdoDatabase } from '../../src/db/driver.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { AT, chain, PASSPHRASE } from './append-helpers.js';
import { appendAs, grantAll, grantFixtureRoster } from './append-auth.js';
import { chainHead } from '../../src/db/write.js';
import { bootstrapBaseline, createWorkcopy, commitWorkcopy, admitWorkcopy, removeWorkcopy, seedTaskRow } from './workcopy-calls.js';
import { admitWorkcopy as rawAdmitWorkcopy, createWorkcopy as rawCreateWorkcopy } from '../../src/db/workcopy.js';
import { cardGitdir, cardWorkdir, objectsDir } from '../../src/core/workcopy/paths.js';
import { countObjects, initCardRepo, readRawObject, readTree } from '../../src/db/vcs.js';
import { isBinary, normalizeText } from '../../src/core/workcopy/crlf.js';
import { pathsFor } from '../../src/db/workcopy-tool.js';

const SESSION = { actor: 'fixture-root', actor_kind: 'service' as const };

interface Ctx {
  readonly root: string;
  readonly db: SdoDatabase;
  readonly base: string;
}
async function withRepo(run: (ctx: Ctx) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'sdo-m4-workcopy-'));
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

function events(db: SdoDatabase, kind: string): { id: string; payload: string }[] {
  return db.prepare('SELECT id, payload FROM event WHERE kind = ? ORDER BY rowid').all(kind) as { id: string; payload: string }[];
}

function seedTask(db: SdoDatabase, id = 'T-M4'): void {
  const head = chainHead(db);
  const events = chain([
    { id: `task.created:${id}`, at: AT, actor: 'fixture-root', kind: 'task.created', subject: id,
      payload: { seq: 990, title: 'M4-0', kind: 'implement', scope_paths: ['a.txt'] }, caused_by: [], request_id: `task:${id}` },
  ], head);
  const result = appendAs(db, events);
  assert.equal(result.ok, true, result.message ?? '');
}

test('C1/C2/C3: create gives independent gitdir + alternates, materializes baseline, logs tool event', async () => {
  await withRepo(async ({ root, db, base }) => {
    const created = await createWorkcopy(db, {
      root, card: 'C-M4-1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT,
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) return;
    assert.equal(readFileSync(join(cardWorkdir(root, 'C-M4-1'), 'a.txt'), 'utf8'), 'v0\n');
    assert.equal(readFileSync(join(cardWorkdir(root, 'C-M4-1'), 'docs/x.md'), 'utf8'), 'x\n');
    // P2-7：不拿 alternates 文件自证；证据 = 卡提交的 commit 能从共享对象库读到、且共享库确有对象。
    const createdEvents = events(db, 'workcopy.created');
    assert.equal(createdEvents.length, 1);
    assert.equal(JSON.parse(createdEvents[0]!.payload).base_oid, base);
    const second = await createWorkcopy(db, { root, card: 'C-M4-1b', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    writeFileSync(join(cardWorkdir(root, 'C-M4-1'), 'a.txt'), 'card-one\n');
    writeFileSync(join(cardWorkdir(root, 'C-M4-1b'), 'a.txt'), 'card-two\n');
    const one = await commitWorkcopy(db, { root, card: 'C-M4-1', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'one' });
    const two = await commitWorkcopy(db, { root, card: 'C-M4-1b', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'two' });
    assert.equal(one.ok, true);
    assert.equal(two.ok, true);
    if (!one.ok || !two.ok) return;
    assert.notEqual(await readRawObject(objectsDir(root), one.card_oid), undefined);
    assert.notEqual(await readRawObject(objectsDir(root), two.card_oid), undefined);
    assert.ok(countObjects(objectsDir(root)) >= 2);
    const cardObjects = join(cardGitdir(root, 'C-M4-1'), 'objects');
    if (lstatSync(cardObjects).isSymbolicLink()) {
      assert.equal(realpathSync(cardObjects), realpathSync(join(objectsDir(root), 'objects')));
    } else {
      for (const name of readdirSync(cardObjects)) assert.ok(name === 'info' || name === 'pack', `loose object dir ${name}`);
    }
    assert.equal(created.base_oid, base);
  });
});

test('C4: completion diff ⊆ scope; out-of-scope write ⇒ scope_violation, no snapshot', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-2', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    writeFileSync(join(cardWorkdir(root, 'C-M4-2'), 'a.txt'), 'v1\n');
    const committed = await commitWorkcopy(db, {
      root, card: 'C-M4-2', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'card C-M4-2',
    });
    assert.equal(committed.ok, true);
    assert.equal(existsSync(join(cardGitdir(root, 'C-M4-2'), 'index')), true);
    if (committed.ok) assert.deepEqual(committed.changes.map((c) => [c.path, c.type]), [['a.txt', 'modified']]);

    writeFileSync(join(cardWorkdir(root, 'C-M4-2'), 'docs/x.md'), 'out of scope\n');
    const bad = await admitWorkcopy(db, {
      root, card: 'C-M4-2', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'card C-M4-2', session: SESSION, at: AT,
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.equal(bad.reason_code, 'scope_violation');
      assert.deepEqual((bad['changes'] as { path: string }[]).map((c) => c.path), ['a.txt', 'docs/x.md']);
    }
    assert.equal(events(db, 'snapshot.taken').length, 1, 'only bootstrap snapshot exists');
  });
});

test('C7: admission rewrites main tree, takes snapshot, removes workcopy in one batch', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-3', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt', 'docs/x.md'], session: SESSION, at: AT });
    writeFileSync(join(cardWorkdir(root, 'C-M4-3'), 'a.txt'), 'v2\n');
    rmSync(join(cardWorkdir(root, 'C-M4-3'), 'docs/x.md'));
    const admitted = await admitWorkcopy(db, {
      root, card: 'C-M4-3', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt', 'docs/x.md'], message: 'card C-M4-3', session: SESSION, at: AT,
    });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    if (!admitted.ok) return;
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'v2\n');
    assert.equal(existsSync(join(root, 'docs/x.md')), false, 'target tree is authoritative');
    assert.equal(existsSync(cardWorkdir(root, 'C-M4-3')), false);
    assert.equal(existsSync(cardGitdir(root, 'C-M4-3')), false);
    const snaps = events(db, 'snapshot.taken');
    assert.equal(snaps.length, 2);
    const taken = JSON.parse(snaps[1]!.payload) as { git_oid: string; parent_ids: string[] };
    assert.deepEqual(taken.parent_ids, ['SNAP-BASE']);
    assert.equal(db.prepare('SELECT git_oid FROM snapshot WHERE id = ?').get(admitted.snapshot_id) !== undefined, true);
    assert.equal(events(db, 'workcopy.removed').length, 1);
    assert.equal(events(db, 'workcopy.created').length, 1);
  });
});

test('C7: dirty main tree ⇒ dirty_main_tree block, main tree not touched, evidence kept', async () => {
  await withRepo(async ({ root, db }) => {
    seedTask(db);
    await createWorkcopy(db, { root, card: 'C-M4-4', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    writeFileSync(join(cardWorkdir(root, 'C-M4-4'), 'a.txt'), 'card\n');
    const dirtyMain = 'user-local-edit\n';
    writeFileSync(join(root, 'a.txt'), dirtyMain);
    const admitted = await admitWorkcopy(db, {
      root, card: 'C-M4-4', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'card', session: SESSION, at: AT, task_id: 'T-M4',
    });
    assert.equal(admitted.ok, false);
    if (!admitted.ok) {
      assert.equal(admitted.reason_code, 'dirty_main_tree');
      assert.equal(typeof admitted['block_event_id'], 'string');
    }
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), dirtyMain, 'must not overwrite dirty main tree');
    assert.equal(existsSync(cardWorkdir(root, 'C-M4-4')), true);
    assert.equal(events(db, 'snapshot.taken').length, 1);
    const blocked = db.prepare("SELECT payload FROM event WHERE kind = 'task.blocked'").get() as { payload: string };
    assert.equal((JSON.parse(blocked.payload) as { block_code: string }).block_code, 'dirty_main_tree');
  });
});

test('C5: removal refuses dirty workcopy, keeps evidence; clean removal succeeds', async () => {
  await withRepo(async ({ root, db }) => {
    seedTask(db, 'T-M4-5');
    await createWorkcopy(db, { root, card: 'C-M4-5', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    await commitWorkcopy(db, { root, card: 'C-M4-5', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'clean baseline' });
    writeFileSync(join(cardWorkdir(root, 'C-M4-5'), 'untracked.txt'), 'leftover\n');
    const dirty = await removeWorkcopy(db, { root, card: 'C-M4-5', task_id: 'T-M4-5', session: SESSION, at: AT });
    assert.equal(dirty.ok, false);
    if (!dirty.ok) {
      assert.equal(dirty.reason_code, 'dirty_workcopy');
      assert.deepEqual(dirty['dirty'], ['untracked.txt']);
    }
    assert.equal(existsSync(cardWorkdir(root, 'C-M4-5')), true);
    assert.equal(existsSync(cardGitdir(root, 'C-M4-5')), true);
    rmSync(join(cardWorkdir(root, 'C-M4-5'), 'untracked.txt'));
    const clean = await removeWorkcopy(db, { root, card: 'C-M4-5', task_id: 'T-M4-5', session: SESSION, at: AT });
    assert.equal(clean.ok, true);
    assert.equal(existsSync(cardWorkdir(root, 'C-M4-5')), false);
    const blocked = db.prepare("SELECT payload FROM event WHERE kind = 'task.blocked'").get() as { payload: string };
    assert.equal((JSON.parse(blocked.payload) as { block_code: string }).block_code, 'dirty_workcopy');
  });
});

test('C1/C9: card gitdir keeps no loose object copies after commit; objects live in shared store', async () => {
  await withRepo(async ({ root, db, base }) => {
    await createWorkcopy(db, { root, card: 'C-M4-6', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    writeFileSync(join(cardWorkdir(root, 'C-M4-6'), 'a.txt'), 'v3\n');
    const committed = await commitWorkcopy(db, { root, card: 'C-M4-6', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'c' });
    assert.equal(committed.ok, true);
    assert.equal(lstatSync(join(cardGitdir(root, 'C-M4-6'), 'objects')).isSymbolicLink(), true, 'card objects is shared-store link (D-125)');
    const loose = readdirSync(join(cardGitdir(root, 'C-M4-6'), 'objects')).filter((name) => /^[0-9a-f]{2}$/.test(name));
    assert.notDeepEqual(loose, [], 'objects live in the shared store, not a per-card copy');
    if (committed.ok) {
      const oid = committed.card_oid;
      assert.equal(existsSync(join(objectsDir(root), 'objects', oid.slice(0, 2), oid.slice(2))), true);
    }
    assert.equal(existsSync(join(objectsDir(root), 'objects', base.slice(0, 2), base.slice(2))), true);
  });
});

test('C6: main-tree scan ignores .sdo/.work (they do not make the tree dirty)', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-7', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    const admitted = await admitWorkcopy(db, {
      root, card: 'C-M4-7', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'c', session: SESSION, at: AT,
    });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8').includes('.sdo/'), true);
  });
});

test('P1-1: .gitignore 忽略的多余文件不判脏（且重写时保留）；未忽略的多余文件判脏', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-P11', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    fs.mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'x.js'), 'module.exports = 1;\n');
    const admitted = await admitWorkcopy(db, {
      root, card: 'C-M4-P11', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'P1-1', session: SESSION, at: AT,
    });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(existsSync(join(root, 'node_modules', 'pkg', 'x.js')), true, 'ignored extras must survive the rewrite');

    await createWorkcopy(db, { root, card: 'C-M4-P11b', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    writeFileSync(join(root, 'notes.txt'), 'untracked\n');
    const blocked = await admitWorkcopy(db, {
      root, card: 'C-M4-P11b', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'P1-1b', session: SESSION, at: AT,
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.reason_code, 'dirty_main_tree');
      assert.deepEqual((blocked['diff'] as { extra: string[] }).extra, ['notes.txt']);
    }
    assert.equal(existsSync(join(root, 'notes.txt')), true);
  });
});

test('P3-11: 主树里的符号链接算未忽略多余项 ⇒ 脏；目标树重写会删除它', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-P311', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], session: SESSION, at: AT });
    fs.symlinkSync(join(root, 'a.txt'), join(root, 'link-to-a'));
    const blocked = await admitWorkcopy(db, {
      root, card: 'C-M4-P311', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'link', session: SESSION, at: AT,
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.deepEqual((blocked['diff'] as { extra: string[] }).extra, ['link-to-a']);
    rmSync(join(root, 'link-to-a'));
    const admitted = await admitWorkcopy(db, {
      root, card: 'C-M4-P311', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt'], message: 'link', session: SESSION, at: AT,
    });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(existsSync(join(root, 'link-to-a')), false);
  });
});

test('P1-3: win32 用 junction；链接失败 ⇒ vcs_link_unsupported（不静默降级）', async () => {
  await withRepo(async ({ root }) => {
    const paths = pathsFor(root, 'C-M4-LINK');
    const calls: Array<'dir' | 'junction'> = [];
    await initCardRepo(paths, objectsDir(root), { platform: 'win32', symlinkFn: (_t, _p, type) => { calls.push(type); } });
    assert.deepEqual(calls, ['junction']);
    const failing = pathsFor(root, 'C-M4-LINK-FAIL');
    const error = await initCardRepo(failing, objectsDir(root), {
      platform: 'linux',
      symlinkFn: () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); },
    }).then(() => undefined, (caught: unknown) => caught);
    assert.ok(error instanceof Error);
    assert.equal((error as { reason_code?: string }).reason_code, 'vcs_link_unsupported');
  });
});

test('P1-4: 新文件（非基线已有）也做 CRLF 归一，树内是 LF blob', async () => {
  await withRepo(async ({ root, db }) => {
    await createWorkcopy(db, { root, card: 'C-M4-CRLF', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt', 'new.txt'], session: SESSION, at: AT });
    writeFileSync(join(cardWorkdir(root, 'C-M4-CRLF'), 'new.txt'), 'n1\r\nn2\r\n');
    const committed = await commitWorkcopy(db, {
      root, card: 'C-M4-CRLF', base_snapshot_id: 'SNAP-BASE', scope_paths: ['a.txt', 'new.txt'], message: 'crlf',
    });
    assert.equal(committed.ok, true);
    if (!committed.ok) return;
    const tree = await readTree(cardGitdir(root, 'C-M4-CRLF'), committed.card_oid);
    const blob = tree.find((entry) => entry.path === 'new.txt');
    assert.notEqual(blob, undefined);
    assert.equal(blob?.content.toString('utf8'), 'n1\nn2\n');
  });
});

test('C2(M4-3): 写域命中公共面 ⇒ 准入拒 public_face_readonly，主树不动', async () => {
  await withRepo(async ({ root, db }) => {
    // P1-1 的真实形态：卡写域比公共面**宽**（src/core ⊃ src/core/criteria/）。
    const publicPath = 'src/core/criteria/register.ts';
    await createWorkcopy(db, { root, card: 'C-M43-PF', base_snapshot_id: 'SNAP-BASE', scope_paths: ['src/core'], session: SESSION, at: AT });
    mkdirSync(join(cardWorkdir(root, 'C-M43-PF'), 'src', 'core', 'criteria'), { recursive: true });
    writeFileSync(join(cardWorkdir(root, 'C-M43-PF'), publicPath), '// edit\n');
    const before = readFileSync(join(root, 'a.txt'), 'utf8');
    const snapshotsBefore = (db.prepare('SELECT count(*) AS n FROM snapshot').get() as { n: number }).n;
    const admitted = await admitWorkcopy(db, {
      root, card: 'C-M43-PF', base_snapshot_id: 'SNAP-BASE', scope_paths: ['src/core'], message: 'public face', session: SESSION, at: AT,
    });
    assert.equal(admitted.ok, false);
    if (!admitted.ok) {
      assert.equal(admitted.reason_code, 'public_face_readonly');
      assert.deepEqual((admitted['hits'] as string[]), ['src/core/criteria/', 'src/core/fold/reducers/verify.ts']);
    }
    assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), before, 'main tree must not be written');
    assert.equal(existsSync(join(root, publicPath)), false, 'public face file must not be checked out/written');
    const snapshotsAfter = (db.prepare('SELECT count(*) AS n FROM snapshot').get() as { n: number }).n;
    assert.equal(snapshotsAfter, snapshotsBefore, 'rejected admission must not take a snapshot');
  });
});

test('M4-3 P1-2: write scope comes from the task row; missing/empty ⇒ structured failures', async () => {
  await withRepo(async ({ root, db }) => {
    const noTask = await rawCreateWorkcopy(db, { root, card: 'C-NO-TASK', base_snapshot_id: 'SNAP-BASE', session: SESSION, at: AT });
    assert.equal(noTask.ok, false);
    if (!noTask.ok) assert.equal(noTask.reason_code, 'task_not_found');
    seedTaskRow(db, 'C-EMPTY', []);
    const empty = await rawCreateWorkcopy(db, { root, card: 'C-EMPTY', base_snapshot_id: 'SNAP-BASE', session: SESSION, at: AT });
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.reason_code, 'scope_undeclared');
    // 行内 scope 是唯一权威：调用方没有 scope 参数可绕。
    seedTaskRow(db, 'C-AUTH', ['a.txt']);
    assert.equal((await rawCreateWorkcopy(db, { root, card: 'C-AUTH', base_snapshot_id: 'SNAP-BASE', session: SESSION, at: AT })).ok, true);
    rmSync(join(cardWorkdir(root, 'C-AUTH'), 'docs', 'x.md'));
    const admitted = await rawAdmitWorkcopy(db, { root, card: 'C-AUTH', base_snapshot_id: 'SNAP-BASE', message: 'delete docs', session: SESSION, at: AT });
    assert.equal(admitted.ok, false);
    if (!admitted.ok) assert.equal(admitted.reason_code, 'scope_violation');
  });
});

test('P2-2: 二进制判定扫整个文件（NUL 在后段也算二进制，不被 CRLF 改写）', () => {
  const payload = Buffer.concat([Buffer.from('a'.repeat(9000)), Buffer.from('\r\n'), Buffer.from([0]), Buffer.from('b\r\n')]);
  assert.equal(isBinary(payload), true);
  assert.deepEqual(normalizeText(payload), payload);
  const lateCrlf = Buffer.concat([Buffer.from([0]), Buffer.from('x\r\n')]);
  assert.deepEqual(normalizeText(lateCrlf), lateCrlf);
});
