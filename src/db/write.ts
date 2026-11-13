/**
 * M1-0 唯一写入口：`append(db, events)`。真源：docs/02 §10–§12。
 * 三件事一次收束：①不认识的 kind 进不来（`unknown_event_kind`）；②链不许断
 * （`prev`=链头、`hash`=computeEventHash，不符整体回滚）；③重放不重复（同 id 同 hash 跳过、不同 hash 拒）。
 * 物化（卡 A2）：全量重放后 diff 落库，范围见 `write-materialize.ts`。
 * 分层：`src/db/` 可 import `src/core/`；反向禁止。
 */

import type { SdoDatabase } from './driver.js';
import type { Event } from '../core/fold/types.js';
import { GENESIS_PREV, computeEventHash } from '../core/verify-events.js';
import { materialize } from './write-materialize.js';
import { checkEnvelope, errorMessage, isLockMessage } from './write-envelope.js';
import { failure, type AppendFailure, type AppendResult } from './write-types.js';

export type { AppendReason, AppendResult } from './write-types.js';

class AppendAbort extends Error {
  constructor(
    readonly failure: AppendFailure,
    readonly attempted: number,
  ) {
    super(failure.message);
    this.name = 'AppendAbort';
  }
}

function rollbackQuietly(db: SdoDatabase): boolean {
  if (!db.inTransaction) return false;
  try {
    db.exec('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}

interface ChainRow {
  readonly id: string;
  readonly hash: string;
}

function readChain(db: SdoDatabase): ChainRow[] {
  return db.prepare('SELECT id, hash FROM event ORDER BY rowid').all() as ChainRow[];
}

/**
 * 唯一写入口。整批在一个 `BEGIN IMMEDIATE` 事务里：校验 → 插事件 → 全量 fold → 投影 diff。
 * 任一步失败 ⇒ ROLLBACK，返回 `{ok:false, reason_code}`；不抛裸错让调用方猜。
 *
 * 已知边界：
 * - 网关为校验链必须读 `event` 表（`readChain`/`chainHead`），这是 `docs/02` §12
 *   “只有 fold 能读 event”的显式白名单；台账 D-027。
 * - 本卡只按 `event.id` 幂等；`request_id` 幂等属写 API 层（D-028）。
 */
export function append(db: SdoDatabase, events: readonly Event[]): AppendResult {
  if (events.length === 0) {
    return { ok: true, written: 0, skipped: 0, attempted: 0, rolled_back: false, eventCount: countEvents(db) };
  }

  if (db.inTransaction) {
    return failed(
      failure('transaction_in_progress', 'append must own the transaction; caller already has one open'),
      0,
      db,
    );
  }

  let result: AppendResult;
  try {
    let existing: ReturnType<typeof readChain>;
    try {
      db.exec('BEGIN IMMEDIATE');
      existing = readChain(db);
    } catch (error) {
      const message = errorMessage(error);
      // BEGIN 之后 readChain 也可能抛错：这里先兜一次回滚，finally 仍保底（P2-1）。
      return failed(
        failure(isLockMessage(message) ? 'database_busy' : 'materialize_failed', message),
        0,
        db,
        rollbackQuietly(db),
      );
    }
    const byId = new Map(existing.map((row) => [row.id, row.hash] as const));
    let expectedPrev = existing.length === 0 ? GENESIS_PREV : (existing[existing.length - 1]?.hash ?? GENESIS_PREV);
    let written = 0;
    let skipped = 0;
    let validated = 0;
    let sawNew = false;
    const fresh: Event[] = [];

    for (const event of events) {
      const envelope = checkEnvelope(event);
      if (envelope !== undefined) {
        throw new AppendAbort(envelope, validated);
      }
      const stored = byId.get(event.id);
      if (stored !== undefined) {
        if (sawNew) {
          throw new AppendAbort(failure('event_chain_broken', `event ${event.id} of a replay batch must precede new events`), validated);
        }
        if (stored !== event.hash) {
          throw new AppendAbort(failure('event_hash_mismatch', `event ${event.id} already exists with a different hash`), validated);
        }
        skipped += 1;
        validated += 1;
        continue;
      }
      if (event.prev !== expectedPrev) {
        throw new AppendAbort(failure('event_chain_broken', `event ${event.id}: prev ${event.prev} does not match chain head ${expectedPrev}`), validated);
      }
      const computed = computeEventHash(event);
      if (computed !== event.hash) {
        throw new AppendAbort(failure('event_hash_mismatch', `event ${event.id}: hash does not match computeEventHash`), validated);
      }
      expectedPrev = event.hash;
      sawNew = true;
      fresh.push(event);
      written += 1;
      validated += 1;
    }

    try {
      const insert = db.prepare(
        `INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const event of fresh) {
        insert.run(
          event.id,
          event.at,
          event.actor,
          event.kind,
          event.subject,
          JSON.stringify(event.payload ?? null),
          JSON.stringify(event.caused_by),
          event.request_id,
          event.prev,
          event.hash,
        );
      }
    } catch (error) {
      throw new AppendAbort(failure('append_conflict', errorMessage(error)), validated);
    }

    try {
      materialize(db);
    } catch (error) {
      throw new AppendAbort(failure('materialize_failed', errorMessage(error)), validated);
    }
    db.exec('COMMIT');
    result = { ok: true, written, skipped, attempted: validated, rolled_back: false, eventCount: countEvents(db) };
  } catch (error) {
    const rolled = rollbackQuietly(db);
    result =
      error instanceof AppendAbort
        ? failed(error.failure, error.attempted, db, rolled)
        : failed(failure('materialize_failed', errorMessage(error)), 0, db, rolled);
  } finally {
    // 兜底：无论从哪条路径离开，都不把连接留在事务里（P1-1）。
    rollbackQuietly(db);
  }
  return result;
}

function countEvents(db: SdoDatabase): number {
  try {
    const row = db.prepare('SELECT count(*) AS n FROM event').get() as { n: number };
    return row.n;
  } catch {
    // 表本身不可用时（例如 P1-1 的故障注入）报告 0，不让报告路径再抛错。
    return 0;
  }
}

function failed(failure: AppendFailure, attempted: number, db: SdoDatabase, rolledBack = false): AppendResult {
  return {
    ok: false,
    reason_code: failure.reason,
    message: failure.message,
    written: 0,
    skipped: 0,
    attempted,
    rolled_back: rolledBack,
    eventCount: countEvents(db),
  };
}

/** 当前链头 hash；空链返回 `GENESIS_PREV`。 */
export function chainHead(db: SdoDatabase): string {
  const row = db.prepare('SELECT hash FROM event ORDER BY rowid DESC LIMIT 1').get() as
    | { hash: string }
    | undefined;
  return row?.hash ?? GENESIS_PREV;
}
