/**
 * `verify` 的共享类型（M0-6 C4）。core 不 import `src/db/`，只用最小 `prepare().all()`。
 */

import type { TableName } from './fold/types.js';

export interface VerifyStatement {
  all(...params: unknown[]): unknown[];
}

export interface VerifyDatabase {
  prepare(sql: string): VerifyStatement;
}

export type VerifyProblemCode =
  | 'event_parse_failed'
  | 'event_hash_mismatch'
  | 'event_chain_broken'
  | 'fold_failed'
  | 'projection_missing'
  | 'projection_unexpected'
  | 'runtime_inconsistent'
  | 'projection_check_failed'
  /** M2-3/D-081：旧库残留的 `assumption.invalidated` 事件（该 kind 已降为派生读数）。 */
  | 'legacy_assumption_invalidated'
  | 'baseline_hash_mismatch'
  | 'baseline_missing'
  | 'baseline_unfrozen'
  | 'assumption_disposition_missing'
  | 'assumption_decision_invalid';

export interface VerifyProblem {
  readonly code: VerifyProblemCode;
  readonly table?: TableName;
  readonly objectId?: string;
  readonly detail: string;
}

export interface VerifyReport {
  readonly ok: boolean;
  readonly eventCount: number;
  readonly problems: readonly VerifyProblem[];
  /** 迁移例外计数（P1-3）：`criterion.registered` 且 payload.legacy=true 的条数。 */
  readonly legacy_criterion_registrations: number;
}
