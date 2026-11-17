/**
 * M4-3/C1：公共面登记是**数据**（migrations/018 的 public_face 表），不是代码常量。
 * 本模块只读；写入唯一入口是迁移（表刻意不在 TABLE_NAMES 里，append 无法物化）。
 */
export interface PublicFaceEntry {
  readonly prefix: string;
  readonly note: string;
  readonly since: string;
}

export interface PublicFaceDb {
  prepare(sql: string): {
    all(...params: readonly unknown[]): unknown[];
  };
}

export function readPublicFace(db: PublicFaceDb): PublicFaceEntry[] {
  const rows = db
    .prepare('SELECT prefix, note, since FROM public_face ORDER BY prefix')
    .all() as { prefix: string; note: string; since: string }[];
  return rows.map((row) => ({ prefix: row.prefix, note: row.note, since: row.since }));
}

function segments(value: string): string[] {
  const out: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (part.length === 0 || part === '.') continue;
    // P3（M4-3 第 2 轮评审）：`..` 必须归一，否则 `src/core/../migrations/x` 能绕过相交判定。
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

function isSegmentPrefix(prefix: readonly string[], value: readonly string[]): boolean {
  if (prefix.length > value.length) return false;
  return prefix.every((part, index) => value[index] === part);
}

/**
 * C2 的相交定义按**路径段、双向包含**（M4-3 第 1 轮 P1-1）：
 * `a/b` 与 `a/bc` 不算；`src/core` 与 `src/core/criteria/` 相交（写域比公共面宽），
 * `src/core/criteria/x` 与 `src/core/criteria/` 也相交（写域比公共面窄）。
 */
export function pathHitsPublicFace(path: string, prefix: string): boolean {
  const p = segments(path);
  const f = segments(prefix);
  if (p.length === 0 || f.length === 0) return p.length === 0 && f.length === 0;
  return isSegmentPrefix(p, f) || isSegmentPrefix(f, p);
}

export function publicFaceHits(
  paths: readonly string[],
  entries: readonly PublicFaceEntry[],
): string[] {
  const hits = new Set<string>();
  for (const path of paths) {
    for (const entry of entries) {
      if (pathHitsPublicFace(path, entry.prefix)) hits.add(entry.prefix);
    }
  }
  return [...hits].sort();
}
