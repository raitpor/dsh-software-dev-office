/**
 * `verify` 的共享类型（M0-6 C4）。core 不 import `src/db/`，只用最小 `prepare().all()`。
 */

import { CODE } from './errors/codes.js';
import type { TableName } from './fold/types.js';

export interface VerifyStatement {
  all(...params: unknown[]): unknown[];
}

export interface VerifyDatabase {
  prepare(sql: string): VerifyStatement;
}

export const VERIFY_PROBLEM_CODES = [
  CODE.assumption_decision_invalid,
  CODE.assumption_disposition_missing,
  CODE.baseline_hash_mismatch,
  CODE.baseline_missing,
  CODE.baseline_unfrozen,
  CODE.event_chain_broken,
  CODE.event_hash_mismatch,
  CODE.event_parse_failed,
  CODE.fold_failed,
  CODE.independence_baseline_unbound,
  CODE.independence_unsatisfied,
  CODE.independence_unverifiable,
  CODE.lease_actor_mismatch,
  CODE.lease_missing,
  CODE.lease_multiple_active,
  CODE.legacy_assumption_invalidated,
  CODE.lock_leaked,
  CODE.lock_missing,
  CODE.projection_check_failed,
  CODE.projection_missing,
  CODE.projection_unexpected,
  CODE.public_face_request_stale,
  CODE.public_face_scope_overlap,
  CODE.public_face_writer_extra,
  CODE.public_face_writer_mismatch,
  CODE.public_face_writer_missing,
  CODE.right_actor_mismatch,
  CODE.right_grant_untracked,
  CODE.right_projection_extra,
  CODE.right_projection_mismatch,
  CODE.right_projection_missing,
  CODE.runtime_inconsistent,
  CODE.unauthorized_row,
  CODE.vcs_object_graph_too_large,
  CODE.vcs_object_hash_mismatch,
  CODE.vcs_object_missing,
  CODE.vcs_objects_dir_unresolved,
] as const;

export type VerifyProblemCode = (typeof VERIFY_PROBLEM_CODES)[number];

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
