/**
 * M4-0：主工作树 = “当前基线的检出”（docs/07 §12）。
 *
 * 主树是用户仓库，SDO 不接管用户 .git 的 index。所以重检出是“按目标树重写文件”：
 * 先判脏（逐文件 blob oid + 文件集合），脏则一个字节都不写；干净才原子写临时文件 + rename，
 * 并删掉目标树里没有的文件/目录。`.git/`、`.sdo/`、`.work/` 永不碰。
 *
 * 脏的判定（Lead m12135 P1-1）：
 * - 基线 tree 里的文件缺失或内容不符 ⇒ 脏；
 * - 磁盘上有基线之外的文件/符号链接：**未被 .gitignore 忽略的**才算脏；
 *   忽略判定由调用方注入（`git.isIgnored`），判不了（false/抛错）按未忽略处理（fail-closed）。
 */
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { gitBlobOid, treeMap, type TreeEntry } from './tree.js';

const PROTECTED = new Set(['.git', '.sdo', '.work']);
const TMP_INFIX = '.sdo-tmp-';

export type IgnoreProbe = (filepath: string) => Promise<boolean>;

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

export interface MainTreeScan {
  readonly files: ReadonlyMap<string, string>;
  /** 符号链接的路径（磁盘本质是链接，不是文件；对判脏/删除有意义）。 */
  readonly links: readonly string[];
}

/** 扫描主树（跳过受保护顶层目录）。 */
export function scanMainTree(root: string): MainTreeScan {
  const files = new Map<string, string>();
  const links: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (dir === root && PROTECTED.has(name)) continue;
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        links.push(toPosix(relative(root, abs)));
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) files.set(toPosix(relative(root, abs)), gitBlobOid(readFileSync(abs)));
    }
  };
  walk(root);
  return { files, links };
}

export interface MainTreeDiff {
  readonly clean: boolean;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
  readonly changed: readonly string[];
}

/**
 * 目标树是权威：主树少了/内容不同，或存在“未被忽略的多余文件/链接”都算脏。
 * 多余项的 .gitignore 判定是异步的，所以本函数 async；`isIgnored` 缺省 = 全部未忽略（fail-closed）。
 */
export async function diffMainTree(
  root: string,
  target: readonly TreeEntry[],
  isIgnored: IgnoreProbe = async () => false,
): Promise<MainTreeDiff> {
  const want = treeMap(target);
  const have = scanMainTree(root);
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [path, entry] of want) {
    const oid = have.files.get(path);
    if (oid === undefined) missing.push(path);
    else if (oid !== gitBlobOid(entry.content)) changed.push(path);
  }
  const extra: string[] = [];
  for (const path of have.files.keys()) {
    if (want.has(path)) continue;
    if (await isIgnored(path)) continue;
    extra.push(path);
  }
  for (const path of have.links) {
    // 基线里该路径需要的是普通文件 ⇒ 链接本身也算“内容不符”；否则按多余项处理。
    if (want.has(path)) changed.push(path);
    else if (!(await isIgnored(path))) extra.push(path);
  }
  return {
    clean: missing.length + changed.length + extra.length === 0,
    missing: missing.sort(),
    changed: changed.sort(),
    extra: extra.sort(),
  };
}

/** 目标树里与永久保护目录重名的路径：拒绝重写（调用方应视为基线非法）。 */
export function protectedPaths(target: readonly TreeEntry[]): string[] {
  return target.filter((entry) => PROTECTED.has(entry.path.split('/')[0] ?? '')).map((entry) => entry.path);
}

function writeAtomic(abs: string, content: Buffer, mode: string): void {
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
  // 目标位置可能是旧符号链接/文件：先移除链接本身，避免写穿到链接目标。
  try {
    if (lstatSync(abs).isSymbolicLink()) rmSync(abs, { force: true });
  } catch {
    /* 不存在则无需处理 */
  }
  const tmp = `${abs}${TMP_INFIX}${process.pid}-${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 8)}`;
  writeFileSync(tmp, content, { mode: mode === '100755' ? 0o755 : 0o644 });
  chmodSync(tmp, mode === '100755' ? 0o755 : 0o644);
  renameSync(tmp, abs);
}

/** 重写结果：成功计数；或“扫描发现未被忽略的多余项”⇒ 不写、报脏（调用方转 block）。 */
export type RewriteResult =
  | { ok: true; written: number; deleted: number }
  | { ok: false; diff: MainTreeDiff };

/**
 * 主树必须已判干净；写目标树并删除多余文件/链接。
 * 判“未忽略的多余项”与写在同一函数内（P2-1）：扫描之后若发现 extra，直接返回失败，一个字节都不写。
 * `options.onScan` 是 **test-only** 注入点（模拟“判脏后、写之前”的窗口），产品路径不得传。
 */
export async function rewriteMainTree(
  root: string,
  target: readonly TreeEntry[],
  options: { isIgnored?: IgnoreProbe; onScan?: () => void; baseline?: readonly TreeEntry[] } = {},
): Promise<RewriteResult> {
  const dirty = protectedPaths(target);
  if (dirty.length > 0) throw new Error(`baseline tree contains protected paths: ${dirty.join(', ')}`);
  const isIgnored = options.isIgnored ?? (async () => false);
  options.onScan?.();
  const want = treeMap(target);
  const have = scanMainTree(root);
  // 多余项以**基线**判：基线里有、目标树里没有的文件是卡片的合法删除；基线里没有的才是用户脏文件。
  const diff = await diffMainTree(root, options.baseline ?? target, isIgnored);
  if (diff.extra.length > 0) return { ok: false, diff };
  let written = 0;
  for (const [path, entry] of want) {
    const abs = join(root, path);
    if (have.files.get(path) === gitBlobOid(entry.content)) continue;
    writeAtomic(abs, entry.content, entry.mode);
    written += 1;
  }
  let deleted = 0;
  for (const path of [...have.files.keys(), ...have.links].sort((a, b) => b.length - a.length)) {
    if (want.has(path)) continue;
    // 被 .gitignore 忽略的多余文件（node_modules/、构建缓存）不归 SDO 管，必须保留。
    if (await isIgnored(path)) continue;
    rmSync(join(root, path), { force: true });
    deleted += 1;
  }
  pruneEmptyDirs(root);
  return { ok: true, written, deleted };
}

function pruneEmptyDirs(root: string): void {
  const walk = (dir: string): boolean => {
    let empty = true;
    for (const name of readdirSync(dir)) {
      if (dir === root && PROTECTED.has(name)) {
        empty = false;
        continue;
      }
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        empty = false;
        continue;
      }
      if (st.isDirectory()) {
        if (!walk(abs)) empty = false;
      } else empty = false;
    }
    if (dir !== root && empty) rmSync(dir, { recursive: true, force: true });
    return empty;
  };
  walk(root);
}
