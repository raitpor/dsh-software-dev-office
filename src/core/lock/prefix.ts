import { CODE } from '../../core/errors/codes.js';
/**
 * M4-1/C2+C6：锁前缀的规范化与按路径段的相交判定。
 *
 * 口径（Lead m12335）：比较按**路径段**，`src/core` 与 `src/co`、`src/core2` 都不算相交；
 * 先规范化：反斜杠、尾斜杠、重复斜杠、`.`、`..`、绝对路径、大小写。
 *
 * 为什么大小写折叠：同一仓库可能被 Windows/macOS 的大小写不敏感文件系统检出，
 * 两个名字在那些系统上是同一文件；锁按保守侧判相交（宁可多挡一次 409，不可漏挡）。
 * 存储的前缀也用折叠后的形式，事件载荷里的原始值保留在事件里。
 *
 * 根前缀：`.`（或 `./`）规范化为 `''`，表示整棵树，与任何前缀相交（C7 主树全局锁用）。
 */

export interface PrefixFailure {
  readonly ok: false;
  readonly reason_code: typeof CODE.invalid_field;
  readonly message: string;
}

export interface PrefixOk {
  readonly ok: true;
  readonly prefix: string;
}

export type PrefixResult = PrefixOk | PrefixFailure;

const MAX_PREFIX_LENGTH = 1024;

function failure(message: string): PrefixFailure {
  return { ok: false, reason_code: CODE.invalid_field, message };
}

/**
 * 规范化锁前缀；非法输入 fail-closed（返回结构，不抛异常，便于写到 409/400 响应里）。
 * - 拒绝：非字符串、空串、NUL、绝对路径、`..` 逃出根、超长；
 * - 归一：`\`→`/`、去 `.`/重复斜杠/尾斜杠、小写、`.`⇒根。
 */
export function normalizePrefix(value: unknown): PrefixResult {
  if (typeof value !== 'string') {
    return failure('path prefix must be a string');
  }
  let raw = value.trim();
  if (raw.length === 0) {
    return failure('path prefix must not be empty (use "." for the whole tree)');
  }
  if (raw.length > MAX_PREFIX_LENGTH) {
    return failure(`path prefix must be at most ${MAX_PREFIX_LENGTH} characters`);
  }
  if (raw.includes('\u0000')) {
    return failure('path prefix must not contain NUL');
  }
  raw = raw.replace(/\\/g, '/');
  if (raw.startsWith('/')) {
    return failure('absolute path prefixes are not allowed; prefixes are repository-relative');
  }
  if (/^[A-Za-z]:/.test(raw)) {
    return failure('drive-letter prefixes are not allowed; prefixes are repository-relative');
  }
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return failure('path prefix escapes the repository root');
      }
      segments.pop();
      continue;
    }
    segments.push(segment.toLowerCase());
  }
  return { ok: true, prefix: segments.join('/') };
}

/** 按路径段判断相交：相等、互为祖先（`a` 是 `b` 的段前缀），或任一方是根。 */
export function prefixesOverlap(a: string, b: string): boolean {
  // 函数自己的契约是“先规范化再按段比较”；这里再归一一次，调用方传原始输入也不会
  // 把 `SRC/Core/` 与 `src/core/ui` 判成不相交。非法前缀不挡任何路径之外的东西：判不相交，
  // 由写入路径先报 invalid_field。
  if (a === ROOT_PREFIX || b === ROOT_PREFIX) {
    return true;
  }
  const left = normalizePrefix(a);
  const right = normalizePrefix(b);
  if (!left.ok || !right.ok) {
    return false;
  }
  if (left.prefix === '' || right.prefix === '') {
    return true;
  }
  if (left.prefix === right.prefix) {
    return true;
  }
  return left.prefix.startsWith(`${right.prefix}/`) || right.prefix.startsWith(`${left.prefix}/`);
}

/** 整棵树的根前缀（C7 主树全局锁）。 */
export const ROOT_PREFIX = '';
