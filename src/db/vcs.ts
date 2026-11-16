/**
 * M4-0：内嵌 VCS 的 isomorphic-git 薄封装。
 *
 * 只碰 SDO 自己的 gitdir / 共享对象库；不改用户仓库的 .git。
 * 注意 v1.44 的 node API 每个调用都要显式传 `fs`。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';

import git from 'isomorphic-git';

import type { TreeEntry } from '../core/workcopy/tree.js';

const FS = fs;

export interface Author {
  readonly name: string;
  readonly email: string;
}

export interface VcsPaths {
  readonly gitdir: string;
  readonly workdir: string;
}

/** 平台无法创建共享对象链接（Windows junction / POSIX symlink 都失败）时的结构化失败。 */
export class VcsLinkUnsupportedError extends Error {
  readonly reason_code = 'vcs_link_unsupported' as const;
  constructor(message: string) {
    super(message);
    this.name = 'VcsLinkUnsupportedError';
  }
}

export interface RawObject {
  readonly type: string;
  readonly content: Buffer;
}

export async function ensureSharedRepo(objectsDir: string): Promise<void> {
  fs.mkdirSync(objectsDir, { recursive: true, mode: 0o700 });
  await git.init({ dir: objectsDir, gitdir: objectsDir, bare: true, defaultBranch: 'main', fs: FS });
}

export interface CardLinkOptions {
  /** 测试可注入；默认当前平台。 */
  readonly platform?: NodeJS.Platform;
  /** 测试可注入；默认 fs.symlinkSync。 */
  readonly symlinkFn?: (target: string, path: string, type: 'dir' | 'junction') => void;
}

export async function initCardRepo(paths: VcsPaths, objectsDir: string, link: CardLinkOptions = {}): Promise<void> {
  fs.mkdirSync(paths.workdir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(paths.gitdir, { recursive: true, mode: 0o700 });
  await git.init({ dir: paths.workdir, gitdir: paths.gitdir, defaultBranch: 'main', fs: FS });
  // isomorphic-git 1.44 不读 objects/info/alternates（D-125）。为了让读写都落在共享库，
  // 卡 gitdir 的 objects 用 symlink 指到共享 objects；alternates 文件仍按设计写入
  //（它现在是共享库内指向自身的声明记录，见 README/D-125）。
  const cardObjects = join(paths.gitdir, 'objects');
  fs.rmSync(cardObjects, { recursive: true, force: true });
  const platform = link.platform ?? process.platform;
  const linkType: 'dir' | 'junction' = platform === 'win32' ? 'junction' : 'dir';
  const symlink = link.symlinkFn ?? ((target: string, path: string, type: 'dir' | 'junction') => {
    fs.symlinkSync(target, path, type);
  });
  try {
    symlink(join(objectsDir, 'objects'), cardObjects, linkType);
  } catch (error) {
    throw new VcsLinkUnsupportedError(
      `cannot link card objects to the shared store (platform=${platform}, type=${linkType}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const alternates = join(objectsDir, 'objects', 'info', 'alternates');
  fs.mkdirSync(join(objectsDir, 'objects', 'info'), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(alternates)) fs.writeFileSync(alternates, `${join(objectsDir, 'objects').replace(/\\/g, '/')}\n`, { mode: 0o600 });
  await git.setConfig({ dir: paths.workdir, gitdir: paths.gitdir, path: 'core.autocrlf', value: 'false', fs: FS });
}

/** 把工作目录内容提交到卡 gitdir（parent 显式给基线），返回 commit oid。 */
export async function commitWorkdir(paths: VcsPaths, message: string, author: Author, parent?: string): Promise<string> {
  for (const file of listWorkdirFiles(paths.workdir)) await git.add({ dir: paths.workdir, gitdir: paths.gitdir, filepath: file, fs: FS });
  return git.commit({ dir: paths.workdir, gitdir: paths.gitdir, message, author, ...(parent === undefined ? {} : { parent: [parent] }), fs: FS });
}

export function listWorkdirFiles(workdir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const abs = join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) out.push(abs.slice(workdir.length + 1).split('\\').join('/'));
    }
  };
  walk(workdir);
  return out.sort();
}

/** 读任意 commit 的完整树（文件内容一并读出，调用方自行控制体量）。 */
export async function readTree(gitdir: string, oid: string): Promise<TreeEntry[]> {
  const commit = await git.readCommit({ dir: gitdir, gitdir, oid, fs: FS });
  const entries: TreeEntry[] = [];
  await git.walk({
    dir: gitdir,
    gitdir,
    trees: [git.TREE({ ref: commit.commit.tree })],
    map: async (filepath, [entry]) => {
      if (entry === null || filepath === '.') return undefined;
      const blobEntry = entry;
      if (blobEntry === undefined) return undefined;
      const type = await blobEntry.type();
      if (type !== 'blob') return undefined;
      const mode = (await blobEntry.mode()).toString(8);
      const blob = await git.readBlob({ dir: gitdir, gitdir, oid: await blobEntry.oid(), fs: FS });
      entries.push({ path: filepath, mode: mode === '100755' ? '100755' : '100644', content: Buffer.from(blob.blob) });
      return undefined;
    },
    fs: FS,
  });
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function writeTree(workdir: string, entries: readonly TreeEntry[]): void {
  fs.mkdirSync(workdir, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const abs = join(workdir, entry.path);
    fs.mkdirSync(join(abs, '..'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(abs, entry.content, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
  }
}

export interface MergeResult {
  readonly ok: boolean;
  readonly oid?: string;
  readonly conflicts?: readonly string[];
}

/**
 * 在临时副本里做三路合并（不弄脏卡的工作目录/index）。
 * ours=卡提交，theirs=当前基线提交；冲突返回文件列表，不自动合。
 */
export async function mergeCommits(
  paths: VcsPaths,
  objectsDir: string,
  ours: string,
  theirs: string,
  message: string,
  author: Author,
): Promise<MergeResult> {
  const scratch = fs.mkdtempSync(join(fs.realpathSync(paths.gitdir), '..', 'merge-'));
  const scratchGit = join(scratch, 'git');
  const scratchWork = join(scratch, 'work');
  try {
    fs.cpSync(paths.gitdir, scratchGit, { recursive: true });
    fs.mkdirSync(scratchWork, { recursive: true, mode: 0o700 });
    await git.checkout({ dir: scratchWork, gitdir: scratchGit, ref: ours, force: true, fs: FS });
    try {
      const result = await git.merge({ dir: scratchWork, gitdir: scratchGit, ours, theirs, message, author, fs: FS });
      spillObjects(scratchGit, objectsDir);
      return { ok: true, oid: result.oid as string };
    } catch (error) {
      const data = (error as { data?: { filepaths?: string[] } }).data;
      if (data?.filepaths !== undefined) return { ok: false, conflicts: [...data.filepaths].sort() };
      throw error;
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** 卡 gitdir 的松散对象搬进共享库（去重、删空目录），保证 C1 无复制。 */
export function spillObjects(gitdir: string, objectsDir: string): void {
  const from = join(gitdir, 'objects');
  const to = join(objectsDir, 'objects');
  if (!fs.existsSync(from)) return;
  // 卡 objects 是共享库 symlink 时写入已直达共享库，无需搬运，也不能删目录。
  if (fs.lstatSync(from).isSymbolicLink()) return;
  for (const name of fs.readdirSync(from)) {
    if (!/^[0-9a-f]{2}$/.test(name)) continue;
    const dir = join(from, name);
    for (const file of fs.readdirSync(dir)) {
      const target = join(to, name, file);
      fs.mkdirSync(join(to, name), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(target)) fs.renameSync(join(dir, file), target);
      else fs.rmSync(join(dir, file), { force: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function objectsHas(objectsDir: string, oid: string): boolean {
  return fs.existsSync(join(objectsDir, 'objects', oid.slice(0, 2), oid.slice(2)));
}

/** 读共享对象库里的原始对象；缺对象返回 undefined。 */
export async function readRawObject(objectsDir: string, oid: string): Promise<RawObject | undefined> {
  if (!objectsHas(objectsDir, oid)) return undefined;
  const raw = await git.readObject({ dir: objectsDir, gitdir: objectsDir, oid, format: 'content', fs: FS });
  return { type: raw.type, content: Buffer.from(raw.object as Buffer) };
}

/** 按 git 对象头重算 oid，用于 verify 的对象库交叉校验。 */
export function objectOid(type: string, content: Buffer): string {
  return createHash('sha1').update(Buffer.from(`${type} ${content.length}\0`, 'utf8')).update(content).digest('hex');
}

export interface WorkdirStatus {
  readonly clean: boolean;
  readonly dirty: readonly string[];
  readonly hasStash: boolean;
}

export async function workdirStatus(paths: VcsPaths): Promise<WorkdirStatus> {
  const rows = await git.statusMatrix({ dir: paths.workdir, gitdir: paths.gitdir, fs: FS });
  const dirty = rows.filter(([, head, workdir, stage]) => head !== 1 || workdir !== 1 || stage !== 1).map(([file]) => file);
  return { clean: dirty.length === 0 && !fs.existsSync(join(paths.gitdir, 'refs', 'stash')), dirty: dirty.sort(), hasStash: fs.existsSync(join(paths.gitdir, 'refs', 'stash')) };
}

/** 共享库中的松散对象总数（C1 证据/诊断用）。 */
export function countObjects(objectsDir: string): number {
  const base = join(objectsDir, 'objects');
  if (!fs.existsSync(base)) return 0;
  let count = 0;
  for (const dir of fs.readdirSync(base)) {
    if (!/^[0-9a-f]{2}$/.test(dir)) continue;
    for (const file of fs.readdirSync(join(base, dir))) if (/^[0-9a-f]{38}$/.test(file)) count += 1;
  }
  return count;
}

export function rmRepoDir(paths: VcsPaths): void {
  fs.rmSync(paths.workdir, { recursive: true, force: true });
  fs.rmSync(paths.gitdir, { recursive: true, force: true });
}
