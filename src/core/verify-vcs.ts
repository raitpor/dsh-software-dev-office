/**
 * M4-0/C9：共享对象库交叉校验（只读、不修）。
 *
 * `snapshot.git_oid` 是内嵌 VCS 的权威读数；本检查定位 `<工作区根>/.sdo/vcs-objects/objects`
 * （工作区根 = 从 DB 路径向上找含 `.sdo/vcs-objects/objects` 的目录），读松散对象、解 zlib、
 * 按 git 对象格式重算 sha1，并沿 commit→tree→子树→blob 递归校验：
 * - 对象文件不存在 ⇒ `vcs_object_missing`
 * - 内容/类型/长度与 oid 不符 ⇒ `vcs_object_hash_mismatch`
 * - 有 snapshot 行却定位不到对象库 ⇒ `vcs_objects_dir_unresolved`（明确不 ok，不静默通过）
 * - 对象图超过 20000 个对象 / 深度 64 ⇒ `vcs_object_graph_too_large`（不静默通过）
 *
 * 边界：只核对 `snapshot` 引用到的对象图，不遍历孤立对象（GC 是 M4-1+ 职责）。
 * 没有 snapshot 行的库（如纯内存/早期迁移）不产生本类问题——没有 VCS 读数就没有可校的对象。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';

import type { VerifyDatabase, VerifyProblem } from './verify-types.js';

const MAX_OBJECTS = 20_000;
const MAX_DEPTH = 64;

interface PathBoundDb {
  readonly sdoPath?: unknown;
}

function snapshots(db: VerifyDatabase): string[] {
  const rows = db.prepare('SELECT git_oid FROM snapshot ORDER BY id').all() as Array<{ git_oid?: unknown }>;
  const oids: string[] = [];
  for (const row of rows) {
    if (typeof row.git_oid === 'string' && /^[0-9a-f]{40}$/.test(row.git_oid) && !oids.includes(row.git_oid)) oids.push(row.git_oid);
  }
  return oids;
}

/** 从 DB 所在目录向上找 `<root>/.sdo/vcs-objects/objects`；找不到返回 undefined。 */
function locateObjectsDir(db: VerifyDatabase): string | undefined {
  const sdoPath = (db as PathBoundDb).sdoPath;
  if (typeof sdoPath !== 'string' || sdoPath === '') return undefined;
  let dir = dirname(sdoPath);
  for (;;) {
    const candidate = join(dir, '.sdo', 'vcs-objects', 'objects');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function objectPath(objectsDir: string, oid: string): string {
  return join(objectsDir, oid.slice(0, 2), oid.slice(2));
}

interface ParsedObject {
  readonly type: 'blob' | 'tree' | 'commit' | 'tag';
  readonly content: Buffer;
}

function readObject(objectsDir: string, oid: string, problems: VerifyProblem[]): ParsedObject | undefined {
  let raw: Buffer;
  try {
    raw = inflateSync(readFileSync(objectPath(objectsDir, oid)));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    problems.push({
      code: missing ? 'vcs_object_missing' : 'vcs_object_hash_mismatch',
      detail: missing ? `object ${oid} is missing from the shared object store` : `cannot read object ${oid}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }
  const headerEnd = raw.indexOf(0);
  if (headerEnd < 0) {
    problems.push({ code: 'vcs_object_hash_mismatch', detail: `object ${oid} has no git header` });
    return undefined;
  }
  const header = raw.subarray(0, headerEnd).toString('latin1');
  const match = /^(blob|tree|commit|tag) (\d+)$/.exec(header);
  if (match === null) {
    problems.push({ code: 'vcs_object_hash_mismatch', detail: `object ${oid} has invalid header ${header}` });
    return undefined;
  }
  const body = raw.subarray(headerEnd + 1);
  if (Number(match[2]) !== body.length) {
    problems.push({ code: 'vcs_object_hash_mismatch', detail: `object ${oid} header says ${match[2]} bytes, body has ${body.length}` });
    return undefined;
  }
  const actual = createHash('sha1').update(raw).digest('hex');
  if (actual !== oid) {
    problems.push({ code: 'vcs_object_hash_mismatch', detail: `object ${oid} content hashes to ${actual}` });
    return undefined;
  }
  return { type: match[1] as ParsedObject['type'], content: body };
}

function childOids(object: ParsedObject): string[] {
  if (object.type === 'commit') {
    const match = /^tree ([0-9a-f]{40})$/m.exec(object.content.toString('utf8'));
    return match === null ? [] : [match[1] as string];
  }
  if (object.type !== 'tree') return [];
  const out: string[] = [];
  let at = 0;
  while (at < object.content.length) {
    const space = object.content.indexOf(0x20, at);
    const nul = object.content.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > object.content.length) break;
    out.push(object.content.subarray(nul + 1, nul + 21).toString('hex'));
    at = nul + 21;
  }
  return out;
}

/** 对每个 snapshot oid 做对象图递归校验；返回 problems（不修改任何东西）。 */
export function verifyVcsObjects(db: VerifyDatabase): VerifyProblem[] {
  const roots = snapshots(db);
  if (roots.length === 0) return [];
  const objectsDir = locateObjectsDir(db);
  if (objectsDir === undefined) {
    return [{ code: 'vcs_objects_dir_unresolved', detail: `cannot locate <workspace root>/.sdo/vcs-objects/objects from ${String((db as PathBoundDb).sdoPath)}` }];
  }
  const problems: VerifyProblem[] = [];
  const visited = new Set<string>();
  let seen = 0;
  const stack = roots.map((oid) => ({ oid, depth: 0 }));
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (visited.has(current.oid)) continue;
    visited.add(current.oid);
    seen += 1;
    if (seen > MAX_OBJECTS) {
      problems.push({ code: 'vcs_object_graph_too_large', detail: `object graph exceeds ${MAX_OBJECTS} objects` });
      break;
    }
    if (current.depth > MAX_DEPTH) {
      problems.push({ code: 'vcs_object_graph_too_large', detail: `object graph depth exceeds ${MAX_DEPTH}` });
      break;
    }
    const object = readObject(objectsDir, current.oid, problems);
    if (object === undefined) continue;
    for (const child of childOids(object)) stack.push({ oid: child, depth: current.depth + 1 });
  }
  return problems;
}
