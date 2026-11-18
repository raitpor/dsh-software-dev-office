import { CODE } from '../core/errors/codes.js';
import type { WorkcopyFailureReason } from '../core/workcopy/types.js';
/**
 * M1-0 写网关的返回契约（纯类型，无 SQL）。
 *
 * 拒绝码与设计/verify 同名，不新造；口径见 `plan/cards/M1-0.md`「范围裁定」与台账 D-025。
 */
export const APPEND_REASON_CODES = [
  CODE.actor_not_from_session,
  CODE.append_conflict,
  CODE.assumption_invalidated_is_derived,
  CODE.conflict,
  CODE.conflict_scope_undeclared,
  CODE.cooldown_active,
  CODE.cooldown_not_applicable,
  CODE.database_busy,
  CODE.decision_already_signed,
  CODE.event_chain_broken,
  CODE.event_hash_mismatch,
  CODE.independence_unsatisfied,
  CODE.invalid_field,
  CODE.last_admin_right,
  CODE.lease_expired,
  CODE.lease_not_active,
  CODE.materialize_failed,
  CODE.no_lease,
  CODE.no_permission,
  CODE.not_public_face_writer,
  CODE.not_reserved_actor,
  CODE.object_condition_failed,
  CODE.payload_mismatch,
  CODE.public_face_readonly,
  CODE.signature_not_from_signerd,
  CODE.signature_time_mismatch,
  CODE.signerd_receipt_replayed,
  CODE.transaction_in_progress,
  CODE.unauthorized_agent_event,
  CODE.unauthorized_conflict_detected,
  CODE.unauthorized_gate_judgement,
  CODE.unauthorized_lease_issue,
  CODE.unauthorized_renderer_registration,
  CODE.unauthorized_right_change,
  CODE.unauthorized_root_lock,
  CODE.unauthorized_workcopy_event,
  CODE.unknown_event_kind,
  CODE.unmapped_event_kind,
  CODE.unsupported_scope,
] as const;

export type AppendReason = (typeof APPEND_REASON_CODES)[number];

// 台账 D-025 需同步登记 append_conflict / transaction_in_progress（Lead 代记）。

/** 工作副本结构化失败码（闭集定义在 `src/core/workcopy/types.ts`，D-156/D-157）。 */
export type { WorkcopyFailureReason };

/**
 * `append` 的返回契约。
 *
 * 成功：`written` 本次真正插入的事件数；`skipped` 已存在且 hash 相同、跳过的条数；
 *       `attempted = written + skipped`；`rolled_back=false`；`eventCount` 写入后行数。
 * 失败：条数为 0（库内无变化，`eventCount` = 调用前行数），`attempted` = 失败前校验通过的条数，
 *       `rolled_back` = 本次调用**真的发起并成功 ROLLBACK** 时为 true；`BEGIN` 本身就失败、
 *       或调用方已有事务（`transaction_in_progress`）这类“没有我们的事务可回滚”的路径为 false。
 *       调用方不得把失败时的 `attempted` 当“已写”。
 */
export interface AppendResult {
  readonly ok: boolean;
  readonly reason_code?: AppendReason;
  readonly message?: string;
  readonly written: number;
  readonly skipped: number;
  /** 本批通过校验的条数（含已存在被跳过的）；失败时表示“走到哪一条才失败”。 */
  readonly attempted: number;
  readonly rolled_back: boolean;
  readonly eventCount: number;
  /** M3-2：`reason_code='conflict'` 时的结构化 409 字段。 */
  readonly conflict_id?: string;
  readonly base_hash?: string;
  readonly current_hash?: string;
}

export interface AppendFailure {
  readonly reason: AppendReason;
  readonly message: string;
}

export function failure(reason: AppendReason, message: string): AppendFailure {
  return { reason, message };
}
