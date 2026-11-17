/**
 * M4-3/C6：公共面 verify 子检查（只读，不修）。
 *
 * 两码：
 * - `public_face_scope_overlap`：任何 task 的 scope_paths 命中 public_face 登记前缀。
 *   （C2 已在准入拒；这里抓历史库/绕过准入直接写 task 行的脏数据。）
 * - `public_face_request_stale`：`publicface.requested` 超过阈值仍没有
 *   `publicface.executed`（subject = request id）。阈值是 M4-3 的实现常量 7 天，
 *   以事件日志最大 at 作“现在”（不依赖墙钟，可重放）。
 *
 * 激活边界：迁移 018 之前写出的库没有 public_face 表，直接跳过（旧链不追溯）。
 */
import type { VerifyDatabase, VerifyProblem } from './verify-types.js';
import { publicFaceHits, readPublicFace } from './publicface/catalog.js';
import type { FoldState } from './fold/types.js';

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

function tableExists(db: VerifyDatabase, name: string): boolean {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .all(name) as { name?: string }[];
  return rows.length === 1;
}

function maxEventAt(db: VerifyDatabase): string | undefined {
  const row = db.prepare('SELECT MAX(at) AS at FROM event').all()[0] as { at?: unknown } | undefined;
  return typeof row?.at === 'string' ? row.at : undefined;
}

export function verifyPublicFace(db: VerifyDatabase, state?: FoldState): VerifyProblem[] {
  if (!tableExists(db, 'public_face')) return [];
  const problems: VerifyProblem[] = [];
  const entries = readPublicFace(db);
  if (entries.length === 0) return problems;
  const tasks = db.prepare('SELECT id, scope_paths FROM task').all() as { id: string; scope_paths: string }[];
  for (const task of tasks) {
    let paths: unknown;
    try {
      paths = JSON.parse(task.scope_paths);
    } catch {
      continue;
    }
    if (!Array.isArray(paths)) continue;
    const hits = publicFaceHits(paths.filter((p): p is string => typeof p === 'string'), entries);
    if (hits.length > 0) {
      problems.push({
        code: 'public_face_scope_overlap',
        detail: `task ${task.id} scope_paths hit public face: ${hits.join(', ')}`,
      });
    }
  }
  // P2-3：单写者行必须与 fold 期望一致（手工直插/直改都能抓到）。
  if (state !== undefined && tableExists(db, 'public_face_writer')) {
    const expected = state.tables['public_face_writer'] ?? {};
    const actual = db.prepare('SELECT id, actor, held_since, note FROM public_face_writer').all() as {
      id: number; actor: string; held_since: string; note: string | null;
    }[];
    const expectedIds = Object.keys(expected).sort();
    const actualIds = actual.map((row) => String(row.id)).sort();
    if (actualIds.length < expectedIds.length) {
      problems.push({ code: 'public_face_writer_missing', detail: `public_face_writer rows ${actualIds.length} < fold ${expectedIds.length}` });
    } else if (actualIds.length > expectedIds.length) {
      problems.push({ code: 'public_face_writer_extra', detail: `public_face_writer rows ${actualIds.length} > fold ${expectedIds.length}` });
    } else if (expectedIds.some((id, index) => id !== actualIds[index])) {
      problems.push({ code: 'public_face_writer_mismatch', detail: `public_face_writer ids ${actualIds.join(',')} != fold ${expectedIds.join(',')}` });
    } else {
      for (const row of actual) {
        const expectedRow = expected[String(row.id)];
        if (expectedRow === undefined) continue;
        if (expectedRow['actor'] !== row.actor
          || String(expectedRow['held_since'] ?? '') !== row.held_since
          || (expectedRow['note'] ?? null) !== row.note) {
          problems.push({ code: 'public_face_writer_mismatch', detail: `public_face_writer row ${row.id} differs from fold` });
        }
      }
    }
  }
  const now = maxEventAt(db);
  if (now !== undefined) {
    const requested = db
      .prepare("SELECT id, payload FROM event WHERE kind = 'publicface.requested'")
      .all() as { id: string; payload: string }[];
    const executed = new Set(
      (db.prepare("SELECT subject FROM event WHERE kind = 'publicface.executed'").all() as { subject: string }[]).map(
        (row) => row.subject,
      ),
    );
    for (const event of requested) {
      if (executed.has(event.id)) continue;
      let at: string | undefined;
      try {
        const payload = JSON.parse(event.payload) as Record<string, unknown>;
        at = typeof payload['requested_at'] === 'string' ? payload['requested_at'] : undefined;
      } catch {
        at = undefined;
      }
      if (at === undefined) {
        problems.push({ code: 'public_face_request_stale', detail: `publicface.requested ${event.id} has no requested_at` });
        continue;
      }
      if (Date.parse(now) - Date.parse(at) > STALE_MS) {
        problems.push({ code: 'public_face_request_stale', detail: `publicface.requested ${event.id} pending since ${at} (now ${now})` });
      }
    }
  }
  return problems;
}
