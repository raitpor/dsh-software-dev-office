// M2-0s spike：文件/目录权限的 Node 侧校验（零依赖，正式实现可直接抄）。
//
// 实测结论（见 plan/cards/M2-0s.md「证据」）：
// - 权限位必须取 `mode & 0o777`；`st.mode` 还带文件类型位（如 0o100644），
//   直接与 0o600 比较永远不等——这是最常见的坑。
// - `fs.stat` **跟随**符号链接，`fs.lstat` 不跟随；校验密钥文件必须 lstat，
//   并在 open 时带 `O_NOFOLLOW`，否则 "先 stat 后 open" 之间有换链 TOCTOU 窗口。
// - 打开后对 fd 做 `fstatSync` 再校验，才是没有 TOCTOU 的读法。
// - 权限位不是全部保证：POSIX ACL（setfacl）可以给出 mode 位之外的授权；root 可无视
//   权限位读写。所以本模块的语义是「拒绝明显不安全的位」，不是「证明安全」。
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';

export const PERM_ERROR = Object.freeze({
  missing: 'path_missing',
  not_regular_file: 'path_not_regular_file',
  not_directory: 'path_not_directory',
  symlink: 'path_is_symlink',
  owner_mismatch: 'path_owner_mismatch',
  dir_insecure: 'dir_perm_insecure',
  file_insecure: 'file_perm_insecure',
});

export class PermissionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PermissionError';
    this.code = code;
    this.details = details;
  }
}

/** st.mode 的低 12 位（含 setuid/setgid/sticky）；展示用先与 0o777 取。 */
export function permissionBits(stat) {
  return stat.mode & 0o777;
}

/** 形如 `0600`、`0700`，用于报错与卡面证据。 */
export function formatMode(stat) {
  return (stat.mode & 0o777).toString(8).padStart(4, '0');
}

/** 严格模式：普通文件必须恰 0600，目录必须恰 0700（0400/0700 文件、0750 目录都拒）。 */
export function isOwnerOnlyMode(mode, { dir = false } = {}) {
  return (mode & 0o7777) === (dir ? 0o700 : 0o600);
}

function ownerProblem(stat) {
  const uid = process.getuid?.();
  if (typeof uid !== 'number') return null; // Windows：无 POSIX uid
  if (uid === 0) return null; // root 能无视权限位，不做“属主必须是我”的断言
  if (stat.uid !== uid) {
    return new PermissionError(
      PERM_ERROR.owner_mismatch,
      `path owner uid=${stat.uid} != process uid=${uid}`,
      { ownerUid: stat.uid, processUid: uid },
    );
  }
  return null;
}

/** 校验目录：存在、非符号链接、是目录、属主、mode 恰为 0700（不接受更宽）。 */
export function assertOwnerOnlyDir(dir, { code = PERM_ERROR.dir_insecure } = {}) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    throw new PermissionError(PERM_ERROR.missing, `directory not found: ${dir}`, { cause: error.code });
  }
  if (stat.isSymbolicLink()) {
    throw new PermissionError(PERM_ERROR.symlink, `directory is a symlink: ${dir}`, { mode: formatMode(stat) });
  }
  if (!stat.isDirectory()) {
    throw new PermissionError(PERM_ERROR.not_directory, `path is not a directory: ${dir}`, { mode: formatMode(stat) });
  }
  const ownerIssue = ownerProblem(stat);
  if (ownerIssue) throw ownerIssue;
  if (!isOwnerOnlyMode(stat.mode, { dir: true })) {
    throw new PermissionError(code, `directory mode ${formatMode(stat)} is not 0700: ${dir}`, {
      path: dir,
      mode: formatMode(stat),
      expected: '0700',
    });
  }
  return { path: dir, mode: formatMode(stat), uid: stat.uid };
}

/** 创建并收紧到 0700（mkdir 的 mode 会被 umask 削，所以显式 chmod 再校验）。 */
export function createOwnerOnlyDir(dir) {
  mkdirSync(dir, { mode: 0o700, recursive: true });
  chmodSync(dir, 0o700);
  return assertOwnerOnlyDir(dir, { code: PERM_ERROR.dir_insecure });
}

/**
 * 打开密钥类文件：O_NOFOLLOW + fstat(fd) 校验，避免 lstat→open 的 TOCTOU。
 * 返回 `{ fd, stat, mode, close() }`；调用方负责 close。
 */
export function openOwnerOnlyFile(file, { code = PERM_ERROR.file_insecure } = {}) {
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw new PermissionError(PERM_ERROR.symlink, `file is a symlink (O_NOFOLLOW): ${file}`, { path: file });
    }
    if (error.code === 'ENOENT') {
      throw new PermissionError(PERM_ERROR.missing, `file not found: ${file}`, { path: file });
    }
    // Windows / 无 O_NOFOLLOW 平台没有 ELOOP，退回 lstat 预检
    let stat;
    try {
      stat = lstatSync(file);
    } catch (inner) {
      throw new PermissionError(PERM_ERROR.missing, `file not found: ${file}`, { cause: inner.code });
    }
    if (stat.isSymbolicLink()) {
      throw new PermissionError(PERM_ERROR.symlink, `file is a symlink: ${file}`, { path: file });
    }
    throw error;
  }
  let stat;
  try {
    stat = fstatSync(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  try {
    if (stat.isSymbolicLink()) {
      // fstat 对已打开的 fd 不可能是符号链接，这里只防御平台怪癖
      throw new PermissionError(PERM_ERROR.symlink, `file is a symlink: ${file}`, { path: file });
    }
    if (!stat.isFile()) {
      throw new PermissionError(PERM_ERROR.not_regular_file, `path is not a regular file: ${file}`, {
        path: file,
        mode: formatMode(stat),
      });
    }
    const ownerIssue = ownerProblem(stat);
    if (ownerIssue) throw ownerIssue;
    if (!isOwnerOnlyMode(stat.mode)) {
      throw new PermissionError(code, `file mode ${formatMode(stat)} is not owner-only (0600): ${file}`, {
        path: file,
        mode: formatMode(stat),
        expected: '0600',
      });
    }
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return {
    fd,
    stat,
    mode: formatMode(stat),
    close() {
      closeSync(fd);
    },
  };
}

/** 校验文件权限（不读内容）；返回 `{path, mode, uid, size}`。 */
export function assertOwnerOnlyFile(file, options) {
  const handle = openOwnerOnlyFile(file, options);
  try {
    return { path: file, mode: handle.mode, uid: handle.stat.uid, size: handle.stat.size };
  } finally {
    handle.close();
  }
}

/** 读密钥文件：先验权限（fail-closed），再读同一 fd。 */
export function readOwnerOnlyFile(file, options) {
  const handle = openOwnerOnlyFile(file, options);
  try {
    return readFileSync(handle.fd);
  } finally {
    handle.close();
  }
}

/** 显式改权限位（mkdir/write 的 mode 会被 umask 削，必须补一次 chmod 再校验）。 */
export function chmodSyncSafe(path, mode) {
  chmodSync(path, mode);
  return mode;
}

/**
 * 写密钥文件：`mode:0o600` 只是创建时的请求，umask 可能削位；写完显式 chmod 并校验。
 * 用 `wx` 不覆盖已有文件（防止静默替换密钥）。
 */
export function writeOwnerOnlyFile(file, data) {
  writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
  chmodSync(file, 0o600);
  return assertOwnerOnlyFile(file);
}
