/**
 * M1-6 P1-2：claim 的独立对账（不改 `src/core/verify.ts` 的分层）。
 *
 * `sdo verify` 管事件链 + `task/spec/release/decision` 四张 fold 投影表；`claim`
 * 是渲染器派生投影，由本函数兜底：
 *   · 结构：`derived_by` 必须已注册、`as_of_frontier` 非空且事件 id 全部存在；
 *   · 内容：从事件重算期望行，与 `claim` 逐列比对（missing / unexpected / mismatch）。
 * 直插 claim 行不会被 `sdo verify` 发现，但会被 `verifyClaims` 抓到。
 */
import type { SdoDatabase } from '../db/driver.js';
import { isRegisteredRenderer } from './renderers.js';
import { frontierIdsOf, renderClaimRows } from './render.js';
import { CLAIM_COLUMNS, type ClaimColumn, type ClaimRow } from './types.js';

export type ClaimProblemReason =
  | 'missing'
  | 'unexpected'
  | 'mismatch'
  | 'unregistered_renderer'
  | 'frontier_empty'
  | 'frontier_unknown';

export interface ClaimProblem {
  readonly reason: ClaimProblemReason;
  readonly claim_id: string;
  readonly fields?: readonly ClaimColumn[];
}

export interface ClaimVerifyReport {
  readonly ok: boolean;
  readonly problems: readonly ClaimProblem[];
}

export function verifyClaims(db: SdoDatabase): ClaimVerifyReport {
  const problems: ClaimProblem[] = [];
  const stored = db.prepare('SELECT * FROM claim ORDER BY id').all() as ClaimRow[];
  const storedById = new Map(stored.map((row) => [row.id, row]));

  for (const row of stored) {
    if (!isRegisteredRenderer(db, row.derived_by)) {
      problems.push({ reason: 'unregistered_renderer', claim_id: row.id });
    }
    const ids = frontierIdsOf(row.as_of_frontier);
    if (ids === undefined) {
      problems.push({ reason: 'frontier_empty', claim_id: row.id });
      continue;
    }
    const missing = ids.filter((id) => db.prepare('SELECT id FROM event WHERE id = ?').get(id) === undefined);
    if (missing.length > 0) problems.push({ reason: 'frontier_unknown', claim_id: row.id });
  }

  const expectedById = new Map(renderClaimRows(db).map((row) => [row.id, row]));
  for (const [id, expected] of expectedById) {
    const actual = storedById.get(id);
    if (actual === undefined) {
      problems.push({ reason: 'missing', claim_id: id });
      continue;
    }
    const fields = CLAIM_COLUMNS.filter((column) => expected[column] !== actual[column]);
    if (fields.length > 0) problems.push({ reason: 'mismatch', claim_id: id, fields });
  }
  for (const id of storedById.keys()) {
    if (!expectedById.has(id)) problems.push({ reason: 'unexpected', claim_id: id });
  }
  return { ok: problems.length === 0, problems };
}
