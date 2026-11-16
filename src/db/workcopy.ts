/**
 * M4-0：工作副本生命周期（docs/07 §12）。
 *
 * 认领：建卡 gitdir（alternates→共享库）→ 基线快照检出到 `.work/<card>/`；
 * 完成：在卡 gitdir 提交（parent=[base]），diff 必须 ⊆ scope_paths；
 * 准入：三路合并 → 主树脏则拒 → 按树重写主树 → `snapshot.taken` + `workcopy.removed`；
 * 收尾：副本必须干净才删，否则拒绝并保留证据。
 *
 * 事件只经 append()；工具事件的能力 mint 在 workcopy-tool.ts（一次性、绑 payload hash）。
 */
import fs from 'node:fs';

import type { SdoDatabase } from './driver.js';
import type {
  AdmitRequest, AdmitResult, CommitRequest, CommitResult, CreateRequest, CreateResult, FailureResult, WorkcopySession,
} from '../core/workcopy/types.js';
import { diffMainTree, rewriteMainTree, type MainTreeDiff } from '../core/workcopy/main-tree.js';
import { diffTrees, isSubset, type TreeEntry } from '../core/workcopy/tree.js';
import { normalizeWorkdirFiles } from '../core/workcopy/crlf.js';
import { objectsDir, resolveInside } from '../core/workcopy/paths.js';
import {
  commitWorkdir, ensureSharedRepo, initCardRepo, mergeCommits, objectsHas, readTree, rmRepoDir, spillObjects, VcsLinkUnsupportedError,
  workdirStatus, writeTree,
} from './vcs.js';
import git from 'isomorphic-git';
import { appendTool, elapsedMs, isBusy, lock, pathsFor, toolEvent, unlock, warnSlow, type WorkcopyPaths } from './workcopy-tool.js';
import { appendAsTool } from './write.js';
import { chainHead } from './write.js';
import { computeEventHash } from '../core/verify-events.js';
import type { Event } from '../core/fold/types.js';

export { bootstrapBaseline } from './workcopy-tool.js';

export const WORKCOPY_AUTHOR: { name: string; email: string } = { name: 'sdo-workcopy', email: 'sdo@localhost' };

function snapshotOid(db: SdoDatabase, snapshotId: string): string | undefined {
  const row = db.prepare('SELECT git_oid FROM snapshot WHERE id = ?').get(snapshotId) as { git_oid?: string } | undefined;
  return row?.git_oid;
}

/** 当前基线：没有子快照的 snapshot 行（parent 链头）。 */
function currentBaseline(db: SdoDatabase): { id: string; git_oid: string } | undefined {
  return db.prepare(
    `SELECT s.id AS id, s.git_oid AS git_oid FROM snapshot s
      WHERE NOT EXISTS (SELECT 1 FROM snapshot_parent p WHERE p.parent_id = s.id)
      ORDER BY s.at DESC, s.id DESC LIMIT 1`,
  ).get() as { id: string; git_oid: string } | undefined;
}


/** D-124：block_code 两码已获授权（docs/03 §4 枚举漏项，v2.1 人签补）。 */
function blockTask(db: SdoDatabase, taskId: string, code: string, reason: string, session: WorkcopySession, at: string): string | undefined {
  const draft = {
    id: `task.blocked:${taskId}:${at}`, at, actor: session.actor, kind: 'task.blocked', subject: taskId,
    payload: { block_code: code, reason }, caused_by: [], request_id: `workcopy:${taskId}:${at}`, prev: chainHead(db), hash: '',
  } as Event;
  const event: Event = { ...draft, hash: computeEventHash(draft) };
  const result = appendAsTool(db, [event], session.actor, session.actor_kind);
  return result.ok ? event.id : undefined;
}

async function withLock<T>(paths: WorkcopyPaths, body: () => Promise<T>): Promise<T> {
  lock(paths);
  try {
    return await body();
  } finally {
    unlock(paths);
  }
}

/** 认领：建卡 gitdir + 共享对象库 + 检出基线 + `workcopy.created`。 */
export async function createWorkcopy(db: SdoDatabase, req: CreateRequest): Promise<CreateResult | FailureResult> {
  const t0 = process.hrtime.bigint();
  const paths = pathsFor(req.root, req.card);
  if (isBusy(paths)) return { ok: false, reason_code: 'workcopy_busy' };
  const baseOid = snapshotOid(db, req.base_snapshot_id);
  if (baseOid === undefined) return { ok: false, reason_code: 'snapshot_missing', message: req.base_snapshot_id };
  await ensureSharedRepo(objectsDir(req.root));
  return withLock(paths, async () => {
    try {
      await initCardRepo(paths, objectsDir(req.root), req.link ?? {});
    } catch (error) {
      if (error instanceof VcsLinkUnsupportedError) return { ok: false, reason_code: error.reason_code, message: error.message };
      throw error;
    }
    const tRead = process.hrtime.bigint();
    const entries = await readTree(paths.gitdir, baseOid);
    writeTree(paths.workdir, entries);
    const tWrite = process.hrtime.bigint();
    const appended = appendTool(db, toolEvent('workcopy.created', req.card, {
      card: req.card, gitdir: paths.gitdir, workdir: paths.workdir,
      base_snapshot_id: req.base_snapshot_id, base_oid: baseOid, scope_paths: req.scope_paths,
    }, req.session, req.at), req.session);
    const timings = { read_tree_ms: elapsedMs(tRead), materialize_plus_event_ms: elapsedMs(tWrite), total_ms: elapsedMs(t0) };
    warnSlow('create', req.card, timings);
    if (!appended.ok) return { ok: false, reason_code: appended.reason_code ?? 'append_failed', message: appended.message };
    return { ok: true, gitdir: paths.gitdir, workdir: paths.workdir, base_oid: baseOid, file_count: entries.length, timings };
  });
}

/**
 * CRLF 归一：对工作目录里所有待纳入文件（新增 + 修改）都做，不只基线已有文件（P1-4）。
 * 含 NUL 的二进制由 normalizeFileInPlace 原样保留。
 */
async function normalizeWorkdir(root: string, paths: ReturnType<typeof pathsFor>): Promise<void> {
  normalizeWorkdirFiles(resolveInside(root, paths.workdir));
}

/** 主树脏判定用的 .gitignore 探针；判不了（无 .git / 抛错）按未忽略处理（fail-closed）。 */
async function gitIgnored(root: string, filepath: string): Promise<boolean> {
  try {
    return await git.isIgnored({ fs, dir: root, filepath });
  } catch {
    return false;
  }
}

/** 完成：CRLF 归一 + 在卡 gitdir 提交（parent=[base]），返回与基线的 diff。 */
export async function commitWorkcopy(db: SdoDatabase, req: CommitRequest): Promise<CommitResult | FailureResult> {
  const t0 = process.hrtime.bigint();
  const paths = pathsFor(req.root, req.card);
  if (isBusy(paths)) return { ok: false, reason_code: 'workcopy_busy' };
  const baseOid = snapshotOid(db, req.base_snapshot_id);
  if (baseOid === undefined) return { ok: false, reason_code: 'snapshot_missing' };
  return withLock(paths, async () => {
    const tNorm = process.hrtime.bigint();
    await normalizeWorkdir(req.root, paths);
    const tCommit = process.hrtime.bigint();
    const cardOid = await commitWorkdir(paths, req.message, req.author ?? WORKCOPY_AUTHOR, baseOid);
    spillObjects(paths.gitdir, objectsDir(req.root));
    const changes = diffTrees(await readTree(paths.gitdir, baseOid), await readTree(paths.gitdir, cardOid));
    const timings = { normalize_ms: elapsedMs(tNorm), commit_ms: elapsedMs(tCommit), total_ms: elapsedMs(t0) };
    warnSlow('commit', req.card, timings);
    return { ok: true, card_oid: cardOid, base_oid: baseOid, changes, timings };
  });
}

/** 准入：合并 → 脏主树拒 → 重写主树 → 落 snapshot.taken + workcopy.removed → 删副本。 */
export async function admitWorkcopy(db: SdoDatabase, req: AdmitRequest): Promise<AdmitResult | FailureResult> {
  const t0 = process.hrtime.bigint();
  const paths = pathsFor(req.root, req.card);
  if (isBusy(paths)) return { ok: false, reason_code: 'workcopy_busy' };
  const baseOid = snapshotOid(db, req.base_snapshot_id);
  if (baseOid === undefined) return { ok: false, reason_code: 'snapshot_missing' };
  return withLock(paths, async () => {
    await normalizeWorkdir(req.root, paths);
    const cardOid = await commitWorkdir(paths, req.message, req.author ?? WORKCOPY_AUTHOR, baseOid);
    spillObjects(paths.gitdir, objectsDir(req.root));
    const changes = diffTrees(await readTree(paths.gitdir, baseOid), await readTree(paths.gitdir, cardOid));
    if (!isSubset(changes.map((change) => change.path), req.scope_paths)) return { ok: false, reason_code: 'scope_violation', changes };
    const current = currentBaseline(db);
    if (current === undefined) return { ok: false, reason_code: 'snapshot_missing' };
    const currentEntries: TreeEntry[] = await readTree(paths.gitdir, current.git_oid);
    const dirtyCheck = async (): Promise<MainTreeDiff> => diffMainTree(req.root, currentEntries, (path) => gitIgnored(req.root, path));
    const dirtyBlock = (diff: MainTreeDiff): FailureResult => ({
      ok: false, reason_code: 'dirty_main_tree', diff,
      block_event_id: req.task_id === undefined ? undefined : blockTask(db, req.task_id, 'dirty_main_tree', 'main tree is dirty', req.session, req.at),
    });
    const dirtyBefore = await dirtyCheck();
    if (!dirtyBefore.clean) return dirtyBlock(dirtyBefore);
    const merged = await mergeCommits(paths, objectsDir(req.root), cardOid, current.git_oid, `admit ${req.card}`, req.author ?? WORKCOPY_AUTHOR);
    if (!merged.ok) return { ok: false, reason_code: 'merge_conflict', conflicts: merged.conflicts ?? [], block_event_id: req.task_id === undefined ? undefined : blockTask(db, req.task_id, 'merge_conflict', 'three-way merge conflict', req.session, req.at) };
    const finalOid = merged.oid as string;
    if (!objectsHas(objectsDir(req.root), finalOid)) return { ok: false, reason_code: 'vcs_object_missing' };
    const finalEntries: TreeEntry[] = await readTree(paths.gitdir, finalOid);
    // merge 之后重扫重判（P1-2）：不能复用 merge 前的 dirty 快照。
    const dirtyCheckedAt = new Date().toISOString();
    const dirtyAfterMerge = await dirtyCheck();
    if (!dirtyAfterMerge.clean) return dirtyBlock(dirtyAfterMerge);
    req.beforeRewrite?.();
    const dirtyBeforeRewrite = await dirtyCheck();
    if (!dirtyBeforeRewrite.clean) return dirtyBlock(dirtyBeforeRewrite);
    const rewrittenAt = new Date().toISOString();
    const rewritten = await rewriteMainTree(req.root, finalEntries, {
      isIgnored: (path) => gitIgnored(req.root, path),
      onScan: req.rewriteScanHook,
      baseline: currentEntries,
    });
    if (!rewritten.ok) return dirtyBlock(rewritten.diff);
    const snapshotId = req.snapshot_id ?? `SNAP-${req.card}-${elapsedMs(t0).toFixed(0)}`;
    const taken = appendTool(db, toolEvent('snapshot.taken', snapshotId, {
      git_oid: finalOid, parent_ids: [current.id], external_ref: paths.gitdir, card: req.card,
    }, req.session, req.at), req.session);
    if (!taken.ok) return { ok: false, reason_code: taken.reason_code ?? 'append_failed', message: taken.message };
    const removed = appendTool(db, toolEvent('workcopy.removed', req.card, { card: req.card, reason: 'admitted', snapshot_id: snapshotId }, req.session, req.at), req.session);
    if (!removed.ok) return { ok: false, reason_code: removed.reason_code ?? 'append_failed', message: removed.message };
    rmRepoDir(paths);
    const timings = { total_ms: elapsedMs(t0) };
    warnSlow('admit', req.card, timings);
    return {
      ok: true, snapshot_id: snapshotId, git_oid: finalOid, changes, written: rewritten.written, deleted: rewritten.deleted, timings,
      dirty_checked_at: dirtyCheckedAt, rewritten_at: rewrittenAt,
    };
  });
}

/** 收尾：不干净就拒（保留证据），干净才落 workcopy.removed 并删目录。 */
export async function removeWorkcopy(db: SdoDatabase, req: { root: string; card: string; task_id?: string; session: WorkcopySession; at: string }): Promise<{ ok: true } | FailureResult> {
  const paths = pathsFor(req.root, req.card);
  if (isBusy(paths)) return { ok: false, reason_code: 'workcopy_busy' };
  const status = await workdirStatus(paths);
  if (!status.clean) return {
    ok: false, reason_code: 'dirty_workcopy', dirty: status.dirty, has_stash: status.hasStash,
    block_event_id: req.task_id === undefined ? undefined : blockTask(db, req.task_id, 'dirty_workcopy', 'workcopy has uncommitted changes', req.session, req.at),
  };
  return withLock(paths, async () => {
    const removed = appendTool(db, toolEvent('workcopy.removed', req.card, { card: req.card, reason: 'removed' }, req.session, req.at), req.session);
    if (!removed.ok) return { ok: false, reason_code: removed.reason_code ?? 'append_failed', message: removed.message };
    rmRepoDir(paths);
    return { ok: true };
  });
}
