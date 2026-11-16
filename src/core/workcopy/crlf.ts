/**
 * M4-0：CRLF 归一（docs/07 §12）。
 *
 * 内嵌 git 存原始字节；如果同一文件在 Windows 检出的 CRLF 与 Linux 的 LF 都直接入库，
 * blob（进而 git_oid）会漂。约定等价 `core.autocrlf=false`：文本文件写入前归一为 LF。
 *
 * 二进制判定：**整个文件**含 NUL ⇒ 二进制，原样保留（P2-2：只看前 8KB 会让 NUL 在后段的文本被改写）。
 */
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function isBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

/** CRLF/孤立 CR ⇒ LF；仅文本文件生效。 */
export function normalizeText(buffer: Buffer): Buffer {
  if (isBinary(buffer)) return buffer;
  const text = buffer.toString('utf8');
  return Buffer.from(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
}

/** 读-归一-写回；返回是否发生了字节变化。二进制文件不动。 */
export function normalizeFileInPlace(path: string): boolean {
  const before = readFileSync(path);
  const after = normalizeText(before);
  if (before.equals(after)) return false;
  writeFileSync(path, after);
  return true;
}

/**
 * 对工作目录里**所有待纳入文件**（新增 + 修改）做 CRLF 归一，而不只是基线已有文件。
 * 这是 Lead m12135 P1-4 的口径：新文件也必须以 LF 入库，否则 Windows 新增文件会产生跨平台 blob 漂移。
 * 跳过 `.git`（理论上工作目录里不会有）与其他目录符号链接；含 NUL 的二进制文件由 `normalizeFileInPlace` 原样保留。
 */
export function normalizeWorkdirFiles(workdir: string, skipDir: (name: string) => boolean = () => false): number {
  let changed = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (skipDir(name)) continue;
      const abs = join(dir, name);
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (st.isFile()) changed += normalizeFileInPlace(abs) ? 1 : 0;
    }
  };
  walk(workdir);
  return changed;
}
