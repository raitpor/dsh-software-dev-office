/**
 * M4-0：树与路径的纯函数比较（不碰 git，由 db/vcs 提供已展开的条目）。
 */
import { createHash } from 'node:crypto';

export interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  /** 内容字节（materialize 用），测试/小仓库可接受。 */
  readonly content: Buffer;
}

export type ChangeType = 'added' | 'modified' | 'deleted';

export interface TreeChange {
  readonly path: string;
  readonly type: ChangeType;
}

/** git blob oid：sha1("blob <len>\0" + content)。主树脏判定与对象库核对共用。 */
export function gitBlobOid(content: Buffer): string {
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(content).digest('hex');
}

export function treeMap(entries: readonly TreeEntry[]): Map<string, TreeEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

/** 两棵树的相对差集（按路径排序，便于稳定报告）。 */
export function diffTrees(base: readonly TreeEntry[], next: readonly TreeEntry[]): TreeChange[] {
  const before = treeMap(base);
  const after = treeMap(next);
  const changes: TreeChange[] = [];
  for (const [path, entry] of after) {
    const old = before.get(path);
    if (old === undefined) changes.push({ path, type: 'added' });
    else if (gitBlobOid(old.content) !== gitBlobOid(entry.content)) changes.push({ path, type: 'modified' });
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push({ path, type: 'deleted' });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export function isSubset(paths: readonly string[], scopePaths: readonly string[]): boolean {
  const scope = scopePaths.map((item) => item.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''));
  return paths.every((path) => {
    const norm = path.replace(/\\/g, '/').replace(/^\.\//, '');
    return scope.some((item) => item !== '' && (norm === item || norm.startsWith(`${item}/`)));
  });
}
