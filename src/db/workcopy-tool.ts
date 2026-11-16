/**
 * M4-0 内部模块：工作副本工具事件的构造/能力 mint/目录锁。
 * 拆出来只是为了让 workcopy.ts 保持 <200 行（同一 M4-0 写域，无对外语义）。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';

import type { SdoDatabase } from './driver.js';
import type { Event } from '../core/fold/types.js';
import { computeEventHash } from '../core/verify-events.js';
import { cardGitdir, cardWorkdir, objectsDir, resolveInside } from '../core/workcopy/paths.js';
import type { WorkcopySession } from '../core/workcopy/types.js';
import { mintWorkcopyAuthority, workcopyPayloadHash, WORKCOPY_TOOL_KINDS } from './workcopy-capability.js';
import { appendAsTool, chainHead } from './write.js';
import { commitWorkdir, ensureSharedRepo, initCardRepo, readTree, rmRepoDir, spillObjects, writeTree } from './vcs.js';



export const SLOW_MS = 2000;
export function elapsedMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}
export function warnSlow(op: string, card: string, timings: Record<string, number>): void {
  for (const [name, value] of Object.entries(timings)) {
    if (value > SLOW_MS) console.warn(`[sdo-workcopy] ${op} ${card} ${name}=${Math.round(value)}ms exceeds ${SLOW_MS}ms budget; falling back to serial ops`);
  }
}

export interface WorkcopyPaths {
  readonly gitdir: string;
  readonly workdir: string;
}
export function pathsFor(root: string, card: string): WorkcopyPaths {
  return { gitdir: cardGitdir(root, card), workdir: cardWorkdir(root, card) };
}
export function isBusy(paths: WorkcopyPaths): boolean {
  return fs.existsSync(join(paths.gitdir, 'sdo-busy.lock'));
}
export function lock(paths: WorkcopyPaths): void {
  fs.mkdirSync(paths.gitdir, { recursive: true });
  fs.writeFileSync(join(paths.gitdir, 'sdo-busy.lock'), String(process.pid), { flag: 'wx', mode: 0o600 });
}
export function unlock(paths: WorkcopyPaths): void {
  fs.rmSync(join(paths.gitdir, 'sdo-busy.lock'), { force: true });
}

export function toolEvent(kind: string, subject: string, payload: unknown, session: WorkcopySession, at: string): Event {
  return {
    id: `${kind}:${subject}:${randomUUID()}`,
    at,
    actor: session.actor,
    kind,
    subject,
    payload,
    caused_by: [],
    request_id: `workcopy:${subject}:${at}`,
    prev: '',
    hash: '',
  } as Event;
}

/** 工具路径统一入口：建事件 → mint 一次性能力 → append。 */
export function appendTool(db: SdoDatabase, event: Event, session: WorkcopySession): ReturnType<typeof appendAsTool> {
  if (!(WORKCOPY_TOOL_KINDS as readonly string[]).includes(event.kind)) throw new Error(`not a tool kind: ${event.kind}`);
  const minted: Event = { ...event, prev: chainHead(db) } as Event;
  const withHash = { ...minted, hash: computeEventHash(minted) } as Event;
  mintWorkcopyAuthority(withHash.id, workcopyPayloadHash(withHash.payload));
  return appendAsTool(db, [withHash], session.actor, session.actor_kind);
}

/** 测试/引导用：把一组文件写成共享对象库里的根提交，并落一条 tool 触发的 snapshot.taken。 */
export async function bootstrapBaseline(db: SdoDatabase, request: {
  root: string; files: Readonly<Record<string, string | Buffer>>; snapshot_id: string; session: WorkcopySession; at: string;
}): Promise<{ ok: true; git_oid: string; snapshot_id: string }> {
  await ensureSharedRepo(objectsDir(request.root));
  const temp = fs.mkdtempSync(join(resolveInside(request.root, '.sdo'), 'bootstrap-'));
  const paths = { gitdir: join(temp, 'git'), workdir: join(temp, 'work') };
  try {
    await initCardRepo(paths, objectsDir(request.root));
    for (const [path, content] of Object.entries(request.files)) {
      const abs = join(paths.workdir, path);
      fs.mkdirSync(join(abs, '..'), { recursive: true });
      fs.writeFileSync(abs, typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
    }
    const oid = await commitWorkdir(paths, `bootstrap ${request.snapshot_id}`, { name: 'sdo-workcopy', email: 'sdo@localhost' });
    // 基线即当前检出：把基线树同步到主树（保护 .git/.sdo/.work）。
    writeTree(request.root, await readTree(paths.gitdir, oid));
    spillObjects(paths.gitdir, objectsDir(request.root));
    const taken = appendTool(db, toolEvent('snapshot.taken', request.snapshot_id, { git_oid: oid, parent_ids: [], external_ref: paths.gitdir }, request.session, request.at), request.session);
    if (!taken.ok) throw new Error(`bootstrap snapshot failed: ${taken.reason_code ?? 'unknown'} ${taken.message ?? ''}`);
    return { ok: true, git_oid: oid, snapshot_id: request.snapshot_id };
  } finally {
    rmRepoDir(paths);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
