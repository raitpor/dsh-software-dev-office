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
  /** M3-1/C5：投影行在事件日志里没有来源（只可能绕过写网关直写），归因不了人。 */
  | 'unauthorized_row'
  | 'projection_check_failed'
  /** M2-3/D-081：旧库残留的 `assumption.invalidated` 事件（该 kind 已降为派生读数）。 */
  | 'legacy_assumption_invalidated'
  | 'baseline_hash_mismatch'
  | 'baseline_missing'
  | 'baseline_unfrozen'
  | 'assumption_disposition_missing'
  | 'assumption_decision_invalid'
  /** M3-3：独立性复算（dual_human / solo_cooldown）不满足，或签名证据不自洽。 */
  | 'independence_unsatisfied'
  | 'independence_baseline_unbound'
  | 'independence_unverifiable'
  /** M4-0/C9：内嵌 VCS 共享对象库与 snapshot.git_oid 交叉校验。 */
  | 'vcs_object_missing'
  | 'vcs_object_hash_mismatch'
  | 'vcs_objects_dir_unresolved'
  | 'vcs_object_graph_too_large'
  /** M4-1/C5：卡在飞却没有活锁 / 活锁归属的卡已不在飞且超过 TTL+宽限。 */
  | 'public_face_scope_overlap'
  | 'public_face_writer_missing'
  | 'public_face_writer_extra'
  | 'public_face_writer_mismatch'
  /** M4-3/C6：公共面申请长期未执行（超过阈值）。 */
  | 'public_face_request_stale'
  | 'lock_missing'
  | 'lock_leaked'
  /** M4-2/C7：租约完整性（busy 卡无活租约 / actor 不匹配 / 同卡多条活租约 / 预占期被他人认领）。 */
  /** M4-4/C5：right.* 事件流 vs scope 表（missing/extra/mismatch/untracked）。 */
  | 'right_projection_missing'
  | 'right_projection_extra'
  | 'right_projection_mismatch'
  | 'right_grant_untracked'
  | 'right_actor_mismatch'
  | 'lease_missing'
  | 'lease_actor_mismatch'
  | 'lease_multiple_active';

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
