/**
 * M1-6：渲染器网关——`claim` 行的唯一写入口（docs/03 §3）。
 *
 * 两条写路径各自有唯一入口：
 *   · 事件 → `src/db/write.ts` 的 `append()`（本文件只负责把 M0-7 的合成事件
 *     按真实链头重链；`imp:<claim_no>:root` 只用于离线比对，绝不入库）；
 *   · `claim` → 本文件（`writeClaimRows`）：渲染器已注册 + `as_of_frontier` 非空且
 *     每个事件 id 都存在 + 同 id 同内容幂等、不同内容 `claim_conflict`。
 *
 * 原子性口径（P1-1，评审实测修正）：
 *   先把“能想到的失败”全部前移到 append 之前（渲染器注册、字段完整）；
 *   append 之后仍可能失败，但**不回滚已提交事件**——事件是真源，claim 是投影，
 *   用 `renderClaimsFromEvents()` 从已有事件重算 claim 即可恢复（重跑渲染，
 *   不是重跑导入：后者会重算 hash 撞 event_rejected）。
 *
 * 库层还有 005 的 only-append 触发器兜底 UPDATE/DELETE；INSERT 的“只能经网关”
 * 靠静态扫描 + README 的 best-effort 说明（SQLite 不区分调用方）。
 */
import { canonicalJson } from '../core/fold/canonical.js';
import type { Event } from '../core/fold/types.js';
import { computeEventHash } from '../core/verify-events.js';
import type { SdoDatabase } from '../db/driver.js';
import { append, chainHead } from '../db/write.js';
import { landingEvents } from '../importer/rebuild.js';
import type { ExportClaim } from '../importer/parse.js';
import { isRegisteredRenderer, rendererById } from './renderers.js';
import { renderClaimRows } from './render.js';
import type { ClaimDiff, ClaimImportResult, ClaimReason, ClaimRow, ClaimSource } from './types.js';

const CLAIM_INSERT = `INSERT INTO claim (id, subject, predicate, value, as_of_frontier, derived_by, actor, at)
VALUES (@id, @subject, @predicate, @value, @as_of_frontier, @derived_by, @actor, @at)`;

function result(partial: Partial<ClaimImportResult> & Pick<ClaimImportResult, 'ok'>): ClaimImportResult {
  return {
    ok: partial.ok,
    reason_code: partial.reason_code,
    message: partial.message,
    written: partial.written ?? 0,
    skipped: partial.skipped ?? 0,
    events_written: partial.events_written ?? 0,
    claims_written: partial.claims_written ?? partial.written ?? 0,
    resumable: partial.resumable ?? false,
    next_step: partial.next_step,
  };
}

function failure(
  code: ClaimReason,
  message: string,
  extra: Partial<Pick<ClaimImportResult, 'skipped' | 'events_written' | 'resumable' | 'next_step'>> = {},
): ClaimImportResult {
  return result({ ok: false, reason_code: code, message, ...extra });
}

/** 期望行（C1 的唯一口径）：v1 回执里的 `f:...` 前沿只离线用，入库的是真实事件 id。 */
export function expectedClaimRow(claim: ClaimSource, eventIds: readonly string[]): ClaimRow {
  return {
    id: `claim:${claim.claim_no}`,
    subject: claim.task_id,
    predicate: claim.predicate,
    value: canonicalJson({ code: claim.predicate, value: claim.value }),
    as_of_frontier: canonicalJson(eventIds),
    derived_by: claim.renderer,
    actor: claim.actor,
    at: claim.at,
  };
}

function rowDiff(expected: ClaimRow, stored: ClaimRow): ClaimDiff[] {
  const diffs: ClaimDiff[] = [];
  for (const column of Object.keys(expected) as Array<keyof ClaimRow>) {
    if (expected[column] !== stored[column]) {
      diffs.push({ path: `claim.${column}`, parsed: expected[column], stored: stored[column] });
    }
  }
  return diffs;
}

function storedRow(db: SdoDatabase, id: string): ClaimRow | undefined {
  return db.prepare('SELECT * FROM claim WHERE id = ?').get(id) as ClaimRow | undefined;
}

function frontierIds(row: ClaimRow): string[] | undefined {
  if (row.as_of_frontier.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.as_of_frontier);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  if (!parsed.every((id) => typeof id === 'string' && id.length > 0)) return undefined;
  return parsed as string[];
}

/** C4/C5：渲染器注册 + 前沿非空且每个事件 id 存在。 */
function validateRow(db: SdoDatabase, row: ClaimRow): { reason: ClaimReason; message: string } | undefined {
  if (!isRegisteredRenderer(db, row.derived_by)) {
    return { reason: 'renderer_unregistered', message: `derived_by ${row.derived_by} is not a registered renderer` };
  }
  const ids = frontierIds(row);
  if (ids === undefined) {
    return { reason: 'frontier_empty', message: `claim ${row.id} as_of_frontier must be a non-empty JSON array of event ids` };
  }
  const missing = ids.filter((id) => db.prepare('SELECT id FROM event WHERE id = ?').get(id) === undefined);
  if (missing.length > 0) {
    return { reason: 'frontier_unknown', message: `claim ${row.id} frontier references unknown event id(s): ${missing.join(', ')}` };
  }
  return undefined;
}

/** 在 append 之前能挡的失败都挡掉（P1-1）：伪造渲染器时事件必须保持 0 行。 */
function prevalidateClaim(claim: ExportClaim): ClaimReason | undefined {
  if (!isRegisteredRendererForClaim(claim.renderer)) return 'renderer_unregistered';
  if (
    claim.claim_no.length === 0 ||
    claim.task_id.length === 0 ||
    claim.actor.length === 0 ||
    claim.at.length === 0 ||
    claim.predicate !== 'done' ||
    claim.value !== true
  ) {
    return 'claim_invalid';
  }
  return undefined;
}

/** 注册面需要 DB（view_catalog）校验；本函数只查常量表，由调用方再用 DB 复核。 */
function isRegisteredRendererForClaim(id: string): boolean {
  return rendererById(id) !== undefined;
}

/**
 * C3 的 claim 写路径：只接受已构造好的行（测试与 importClaims 共用）。
 * 任何一行失败整批回滚；同 id 同内容跳过，不同内容 `claim_conflict`。
 */
export function writeClaimRows(db: SdoDatabase, rows: readonly ClaimRow[]): ClaimImportResult {
  let written = 0;
  let skipped = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const invalid = validateRow(db, row);
      if (invalid !== undefined) {
        db.exec('ROLLBACK');
        return failure(invalid.reason, invalid.message);
      }
      const existing = storedRow(db, row.id);
      if (existing !== undefined) {
        if (rowDiff(row, existing).length === 0) {
          skipped += 1;
          continue;
        }
        db.exec('ROLLBACK');
        return failure('claim_conflict', `claim ${row.id} already exists with different content`);
      }
      db.prepare(CLAIM_INSERT).run(row);
      written += 1;
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    return failure('claim_invalid', `claim write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result({ ok: true, written, skipped, claims_written: written });
}

/** M0-7 的合成事件按真实链头重链（C2）：prev 不出现 `imp:`，hash 用 §10 公式重算。 */
export function rebaseEvents(db: SdoDatabase, events: readonly Event[]): Event[] {
  let prev = chainHead(db);
  return events.map((event) => {
    const body: Event = { ...event, prev, hash: '' };
    const hash = computeEventHash(body);
    prev = hash;
    return { ...body, hash };
  });
}

/**
 * 恢复入口（P1-1）：读已有事件、只重算 claim 行，不产生新事件。
 * 幂等：已存在且逐字段相同的行跳过；同 id 异内容 `claim_conflict`。
 */
export function renderClaimsFromEvents(db: SdoDatabase): ClaimImportResult {
  const rows = renderClaimRows(db);
  if (rows.length === 0) return result({ ok: true });
  const written = writeClaimRows(db, rows);
  if (!written.ok) {
    // 恢复失败：没有新事件可写；claim_conflict 是终局（存储行与事件重算结果不一致，重跑渲染也解不开），
    // 其余失败（如注入的 INSERT 失败）事件仍在，可以再跑一次 render-only。
    const retryable = written.reason_code !== 'claim_conflict';
    return {
      ...written,
      events_written: 0,
      claims_written: 0,
      resumable: retryable,
      next_step: retryable ? 'render_only' : undefined,
    };
  }
  return result({
    ok: true,
    written: written.written,
    skipped: written.skipped,
    claims_written: written.written,
    events_written: 0,
  });
}

/**
 * 端到端：解析结果 → 事件（append）→ claim 行（渲染器网关）。
 * 幂等：已存在且逐字段相同的 claim 整条跳过（连事件也不再重放）。
 * 失败口径：预校验失败 ⇒ 0 事件；append 之后失败 ⇒ 事件照实报、`resumable:true` + `next_step:'render_only'`。
 */
export function importClaims(db: SdoDatabase, claims: readonly ExportClaim[]): ClaimImportResult {
  const existing = new Map<string, ClaimRow>();
  for (const claim of claims) {
    const id = `claim:${claim.claim_no}`;
    const row = storedRow(db, id);
    if (row !== undefined) existing.set(id, row);
  }

  const fresh: Array<{ claim: ExportClaim; row: ClaimRow }> = [];
  let skipped = 0;
  for (const claim of claims) {
    const events = landingEvents(claim);
    const row = expectedClaimRow(claim, events.map((event) => event.id));
    const stored = existing.get(row.id);
    if (stored !== undefined) {
      const diffs = rowDiff(row, stored);
      if (diffs.length > 0) {
        const first = diffs[0] as ClaimDiff;
        return failure('claim_conflict', `claim ${row.id} already exists with different content: ${first.path}`);
      }
      skipped += 1;
      continue;
    }
    const invalid = prevalidateClaim(claim);
    if (invalid !== undefined) {
      return failure(invalid, `claim ${claim.claim_no} rejected before append: ${invalid}`);
    }
    if (!isRegisteredRenderer(db, claim.renderer)) {
      return failure('renderer_unregistered', `claim ${claim.claim_no}: renderer ${claim.renderer} is not registered`);
    }
    fresh.push({ claim, row });
  }
  if (fresh.length === 0) return result({ ok: true, skipped });

  const events = rebaseEvents(db, fresh.flatMap((item) => landingEvents(item.claim)));
  const appended = append(db, events);
  if (!appended.ok) {
    return failure('event_rejected', appended.message ?? `append rejected: ${String(appended.reason_code)}`, {
      skipped,
      events_written: appended.written,
      resumable: appended.written > 0,
      next_step: appended.written > 0 ? 'render_only' : undefined,
    });
  }
  const written = writeClaimRows(db, fresh.map((item) => item.row));
  if (!written.ok) {
    return { ...written, skipped, events_written: appended.written, resumable: true, next_step: 'render_only' };
  }
  return result({
    ok: true,
    written: written.written,
    skipped,
    events_written: appended.written,
    claims_written: written.written,
  });
}
