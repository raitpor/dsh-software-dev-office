/**
 * 权限与路径校验（C2，spike `scripts/spike/fs-perms.mjs` 的产品化）。
 *
 * 手法（M2-0s 证据 E5）：用 `lstat` 先拒符号链接，再看 `mode & 0o7777` 精确比较
 * （不是 `mode & 0o077 === 0`：group/other 全无 + owner 位可执行同样不安全），
 * 最后核 owner uid === process.getuid()（同 uid 才有意义；`fs.stat` 的坑：
 * `mode` 含文件类型位，必须 `& 0o7777` 去掉）。
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';

import { SignError } from './errors.js';

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

export interface PermissionExpectation {
  readonly path: string;
  /** 目录要 0700，文件要 0600。 */
  readonly kind: 'dir' | 'file';
}

export function permissionBits(mode: number): number {
  return mode & 0o7777;
}

export function formatMode(mode: number): string {
  return `0o${(mode & 0o7777).toString(8).padStart(4, '0')}`;
}

function lstatOrNull(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

function assertOwner(stat: { uid: number }, path: string): void {
  const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
  if (stat.uid !== uid) {
    throw new SignError(
      'path_owner_mismatch',
      `${path} 的 owner uid=${String(stat.uid)} 不是当前用户 uid=${String(uid)}`,
    );
  }
}

/** 目录必须存在、是目录、非符号链接、恰 0700、属主为当前用户。 */
export function assertOwnerOnlyDir(path: string): void {
  const stat = lstatOrNull(path);
  if (stat === undefined) throw new SignError('path_missing', `${path} 不存在`);
  if (stat.isSymbolicLink()) throw new SignError('path_is_symlink', `${path} 是符号链接，拒绝跟随`);
  if ((stat.mode & S_IFMT) !== S_IFDIR) throw new SignError('path_not_directory', `${path} 不是目录`);
  assertOwner(stat, path);
  if (permissionBits(stat.mode) !== 0o700) {
    throw new SignError(
      'dir_perm_insecure',
      `${path} 权限是 ${formatMode(stat.mode)}，必须是 0o0700`,
    );
  }
}

/** 文件必须存在、是普通文件、非符号链接、恰 0600、属主为当前用户。 */
export function assertOwnerOnlyFile(path: string): void {
  const stat = lstatOrNull(path);
  if (stat === undefined) throw new SignError('path_missing', `${path} 不存在`);
  if (stat.isSymbolicLink()) throw new SignError('path_is_symlink', `${path} 是符号链接，拒绝跟随`);
  if ((stat.mode & S_IFMT) !== S_IFREG) throw new SignError('path_not_regular_file', `${path} 不是普通文件`);
  assertOwner(stat, path);
  if (permissionBits(stat.mode) !== 0o600) {
    throw new SignError(
      'file_perm_insecure',
      `${path} 权限是 ${formatMode(stat.mode)}，必须是 0o0600`,
    );
  }
}

/** 建目录并收紧到 0700；父目录不递归（调用方先建好 signerd home 的父级）。 */
export function createOwnerOnlyDir(path: string): void {
  mkdirSync(path, { recursive: false, mode: 0o700 });
  chmodSync(path, 0o700);
  assertOwnerOnlyDir(path);
}

/** 确保目录存在且 0700；已存在但权限不对就报错（不静默 chmod 掉别人的配置）。 */
export function ensureOwnerOnlyDir(path: string): void {
  try {
    assertOwnerOnlyDir(path);
  } catch (error) {
    if (error instanceof SignError && error.reason_code === 'path_missing') {
      mkdirSync(dirname(path), { recursive: true });
      createOwnerOnlyDir(path);
      return;
    }
    throw error;
  }
}

/** 写一个 0600 文件：新建用 'wx'（已存在即失败），写完 chmod 再复验。 */
export function writeOwnerOnlyFile(path: string, data: string): void {
  writeFileSync(path, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  assertOwnerOnlyFile(path);
}

/** 覆盖写一个已经存在的 0600 文件（临时态用原子 rename 由调用方负责）。 */
export function overwriteOwnerOnlyFile(path: string, data: string): void {
  writeFileSync(path, data, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
  assertOwnerOnlyFile(path);
}

export function readOwnerOnlyFile(path: string): string {
  // P3：父目录也必须是 0700，避免“文件 0600 但父目录 0755”被替换/枚举。
  assertOwnerOnlyDir(dirname(path));
  assertOwnerOnlyFile(path);
  return readFileSync(path, 'utf8');
}

export function fileExists(path: string): boolean {
  return lstatOrNull(path) !== undefined;
}
