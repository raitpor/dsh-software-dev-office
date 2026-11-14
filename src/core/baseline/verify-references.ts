/**
 * C8（M2-1）：verify 按“判定引用的那一版”对账，不与当前 head 比。
 *
 * 只读最小 DB 接口（`core` 不 import `src/db/`）。三项检查：
 *   1. 每个 baseline 行的 hash 能从行内字段复算（旧行也必须永远可复算）；
 *   2. 每个 baseline 行都有对应的 `baseline.frozen|amended|loosened` 事件（不是手插行）；
 *   3. `stage_run` / `release` 引用的 `baseline_hash` 必须指向已冻结的行。
 */
import { baselineHash } from './freeze.js';
import type { VerifyDatabase, VerifyProblem } from '../verify-types.js';

interface RawBaselineRow {
  readonly id: string;
  readonly hash: string;
  readonly prev: string | null;
  readonly direction: string | null;
  readonly engine_version: string;
  readonly criteria_manifest_hash: string;
  readonly policy: unknown;
  readonly criteria: unknown;
  readonly gates: unknown;
  readonly thresholds: unknown;
  readonly assurance: unknown;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface BaselineReferenceReport {
  readonly ok: boolean;
  readonly baselines: number;
  readonly problems: readonly VerifyProblem[];
}

export function verifyBaselineReferences(db: VerifyDatabase): BaselineReferenceReport {
  const problems: VerifyProblem[] = [];
  const rows = db
    .prepare(
      `SELECT id, hash, prev, direction, engine_version, criteria_manifest_hash,
              policy, criteria, gates, thresholds, assurance
         FROM baseline
        ORDER BY id`,
    )
    .all() as RawBaselineRow[];
  // 已知边界：库内尚无任何 baseline 行时（M0/M1 旧库），不做引用对账；
  // 一旦出现第一版 baseline，release/stage_run 的引用就必须指向已冻结行。
  if (rows.length === 0) return { ok: true, baselines: 0, problems };
  const frozenHashes = new Set<string>();

  for (const row of rows) {
    const input = {
      engine: { version: row.engine_version, criteria_manifest_hash: row.criteria_manifest_hash },
      policy: parseJson(row.policy) ?? {},
      criteria: parseJson(row.criteria) ?? [],
      gates: parseJson(row.gates) ?? [],
      thresholds: parseJson(row.thresholds) ?? {},
      assurance: parseJson(row.assurance) ?? {},
    };
    const direction = row.direction === 'tighten' || row.direction === 'loosen' ? row.direction : null;
    const recomputed = baselineHash({ prev: row.prev, rowDirection: direction, input });
    if (recomputed !== row.hash) {
      problems.push({
        code: 'baseline_hash_mismatch',
        table: 'baseline',
        objectId: row.id,
        detail: `stored hash ${row.hash} but rows recompute to ${recomputed}`,
      });
    }
    const frozen = db
      .prepare(
        `SELECT 1 AS n FROM event
          WHERE subject = ? AND kind IN ('baseline.frozen','baseline.amended','baseline.loosened')
          LIMIT 1`,
      )
      .all(row.id);
    if (frozen.length === 0) {
      problems.push({
        code: 'baseline_unfrozen',
        table: 'baseline',
        objectId: row.id,
        detail: `baseline ${row.id} has no baseline.frozen/amended/loosened event`,
      });
    }
    frozenHashes.add(row.hash);
  }

  for (const table of ['stage_run', 'release'] as const) {
    const refs = db.prepare(`SELECT DISTINCT baseline_hash FROM ${table} WHERE baseline_hash IS NOT NULL`).all() as Array<
      Record<string, unknown>
    >;
    for (const ref of refs) {
      const hash = String(ref['baseline_hash']);
      if (!frozenHashes.has(hash)) {
        problems.push({
          code: 'baseline_missing',
          table,
          detail: `${table} references baseline_hash ${hash}, which is not a frozen baseline row`,
        });
      }
    }
  }

  return { ok: problems.length === 0, baselines: rows.length, problems };
}

export { isRecord };
