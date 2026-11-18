/**
 * M4-G · 读数共用夹具（临时目录新库 + 产品 API，不碰仓库内 *.db）。
 *
 * 口径：真库、真写入、真进程；读数脚本不直插事件表（R1 的子进程也走 append）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import git from 'isomorphic-git';
import fs from 'node:fs';

import { openSdoDatabase } from '../../../lib/src/db/open.js';
import { runMigrations } from '../../../lib/src/db/migrate.js';
import { chain, currentState, PASSPHRASE, seed } from '../../../lib/test/db/append-helpers.js';
import { appendAs, grantAll, grantFixtureRoster } from '../../../lib/test/db/append-auth.js';
import { bootstrapBaseline } from '../../../lib/src/db/workcopy.js';

export const T0 = '2026-11-17T10:00:00.000Z';
export const FIXTURE_SESSION = { actor: 'fixture-root', actor_kind: 'service' };

export function tmpDbPath(label) {
  const dir = mkdtempSync(join(tmpdir(), `sdo-m4g-${label}-`));
  return { dir, path: join(dir, '.sdo', 'sdo.db') };
}

/** 打开一个已迁移、已授权的临时库；调用方负责 close。 */
export function openFixtureDb(path) {
  const db = openSdoDatabase(path, PASSPHRASE);
  runMigrations(db);
  grantFixtureRoster(db);
  grantAll(db, FIXTURE_SESSION.actor);
  return db;
}

/** 在已打开库上追加种子事件（走网关）。 */
export function appendSeeds(db, seeds) {
  const result = appendAs(db, chain(seeds, undefined, currentState(db)));
  if (!result.ok) throw new Error(`seed append failed: ${result.reason_code} ${result.message ?? ''}`);
  return result;
}

export function taskSeed(card, scopePaths, at = T0, seq = 9901) {
  return seed(1, 'task.created', card, {
    seq,
    title: `M4-G fixture ${card}`,
    kind: 'implement',
    status: 'planned',
    scope_paths: scopePaths,
  }, { id: `e-m4g-task-${card}`, at, actor: 'fixture-root', request_id: `m4g-task-${card}` });
}

export function assignedSeed(card, assignee, reservedUntil, at = T0) {
  return seed(2, 'task.assigned', card, { assignee, reserved_until: reservedUntil }, {
    id: `e-m4g-assign-${card}`, at, actor: 'fixture-root', request_id: `m4g-assign-${card}`,
  });
}

/** 把数据库事件/投影读成稳定的 JSON 形状（不含随机 id）。 */
export function countEvents(db, kinds) {
  const marks = kinds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT kind, COUNT(*) AS n FROM event WHERE kind IN (${marks}) GROUP BY kind ORDER BY kind`).all(...kinds);
  return Object.fromEntries(rows.map((row) => [row.kind, row.n]));
}

export function activeLockRows(db) {
  return db
    .prepare("SELECT path_prefix, card_id, actor, status FROM lock WHERE status = 'active' ORDER BY path_prefix, card_id")
    .all();
}


/**
 * R1 真路径夹具：临时 git 仓 + 基线快照 + 任务行（scope_paths 决定各卡可写路径）。
 * 返回的 root/dbPath 交给两个独立子进程共享；父进程负责清理。
 */
export async function prepareWorkcopyRepo(label, tasks) {
  const { dir, path } = tmpDbPath(label);
  const db = openFixtureDb(path);
  try {
    await git.init({ dir, fs });
    await bootstrapBaseline(db, {
      root: dir, snapshot_id: 'SNAP-BASE', session: FIXTURE_SESSION, at: T0,
      files: {
        'src/app.ts': 'export const x = 1;\n',
        'docs/x.md': 'x\n',
        '.gitignore': '.sdo/\n.work/\nnode_modules/\n',
      },
    });
    for (const [index, task] of tasks.entries()) {
      appendSeeds(db, [taskSeed(task.card, task.scope, T0, 9910 + index)]);
    }
  } finally {
    db.close();
  }
  return { root: dir, dbPath: path, baseSnapshot: 'SNAP-BASE', cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
