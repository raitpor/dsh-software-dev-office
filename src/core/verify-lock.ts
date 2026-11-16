/**
 * M4-1/C5：锁的 verify 子检查（只读，不修）。
 *
 * 两码（P2-6/P2-7 口径）：
 * - `lock_missing`：该卡**历史上申请过锁**、现在 `in_progress` 却没有活锁
 *   （“在飞期间丢锁”）。从未申请过锁的卡不进这个检查——申请/释放的接线在 M4-2 的
 *   `claim`/收尾，M4-1 只交付库函数与投影语义（D-140）。
 * - `lock_leaked`：任何活锁超过 `expires_at` + 宽限即报（不要求卡已不在飞；不自动回收，
 *   过期锁由人/控制台显式释放，控制台入口留到 M4-5/M5）。
 * 用事件日志里最大 `at` 作“现在”，保证 verify 不依赖墙钟、可重放。
 *
 * 激活边界：只有库内出现过 `lock.acquired`/`lock.released` 事件时才检查。M4-1 之前写出的
 * 数据库没有锁事件、也没有锁行，历史链不应被追溯判红；M4-1 之后只要用了锁，检查就全量生效
 * （卡 C5 只承诺“用了锁的库”的完整性，不承诺给旧库补造锁证据）。
 */
import type { VerifyDatabase, VerifyProblem } from './verify-types.js';
import { LOCK_GRACE_MS } from './lock/ttl.js';

interface LockRow {
  readonly path_prefix: string;
  readonly card_id: string;
  readonly actor: string;
  readonly acquired_at: string;
  readonly expires_at: string;
}

interface TaskRow {
  readonly id: string;
  readonly status: string;
}

function maxEventAt(db: VerifyDatabase): string | undefined {
  const row = db.prepare('SELECT MAX(at) AS at FROM event').all()[0] as { at?: unknown } | undefined;
  return typeof row?.at === 'string' ? row.at : undefined;
}

function lockRows(db: VerifyDatabase): LockRow[] {
  return db
    .prepare("SELECT path_prefix, card_id, actor, acquired_at, expires_at FROM lock WHERE status = 'active'")
    .all() as LockRow[];
}

function taskById(db: VerifyDatabase, id: string): TaskRow | undefined {
  const rows = db.prepare('SELECT id, status FROM task WHERE id = ?').all(id) as TaskRow[];
  return rows[0];
}

function lockUsed(db: VerifyDatabase): boolean {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM event WHERE kind IN ('lock.acquired', 'lock.released')")
    .all()[0] as { n?: unknown } | undefined;
  return typeof row?.n === 'number' && row.n > 0;
}

export function verifyLocks(db: VerifyDatabase): VerifyProblem[] {
  if (!lockUsed(db)) {
    return [];
  }
  const problems: VerifyProblem[] = [];
  const locks = lockRows(db);
  const lockedCards = new Set(locks.map((row) => row.card_id));
  // “在飞期间丢锁”的激活面：该卡在事件链里申请过锁（无论现在是否还活着）。
  // 从没申请过锁的 in_progress 卡不进这个检查（M4-2 的 claim 才负责申请，D-140）。
  const lockCards = new Set<string>();
  const acquired = db.prepare("SELECT payload FROM event WHERE kind = 'lock.acquired'").all() as Array<{ payload?: unknown }>;
  for (const row of acquired) {
    try {
      const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>;
      const card = payload['card_id'];
      if (typeof card === 'string') lockCards.add(card);
    } catch {
      // 载荷坏了由事件解析/投影检查报，这里不重复归因。
    }
  }
  const busy = (db.prepare("SELECT id, status FROM task WHERE status = 'in_progress'").all() as TaskRow[]).filter(
    (task) => lockCards.has(task.id),
  );
  for (const task of busy) {
    if (!lockedCards.has(task.id)) {
      problems.push({
        code: 'lock_missing',
        table: 'task',
        objectId: task.id,
        detail: `task ${task.id} is in_progress but holds no active lock`,
      });
    }
  }

  const now = maxEventAt(db);
  if (now === undefined) {
    return problems;
  }
  const graceMs = LOCK_GRACE_MS;
  for (const lock of locks) {
    const expiresWithGrace = Date.parse(lock.expires_at) + graceMs;
    if (!Number.isFinite(expiresWithGrace) || expiresWithGrace >= Date.parse(now)) continue;
    const task = taskById(db, lock.card_id);
    problems.push({
      code: 'lock_leaked',
      table: 'lock',
      objectId: lock.path_prefix === '' ? '.' : lock.path_prefix,
      detail:
        `active lock ${lock.path_prefix === '' ? '.' : lock.path_prefix} held by ${lock.actor} ` +
        `(card ${lock.card_id}, task ${task?.status ?? 'missing'}) expired at ${lock.expires_at} (+grace)`,
    });
  }
  return problems;
}
