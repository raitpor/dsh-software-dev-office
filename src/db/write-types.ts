import type { WorkcopyFailureReason } from '../core/workcopy/types.js';
/**
 * M1-0 写网关的返回契约（纯类型，无 SQL）。
 *
 * 拒绝码与设计/verify 同名，不新造；口径见 `plan/cards/M1-0.md`「范围裁定」与台账 D-025。
 */
export type AppendReason =
  | 'unknown_event_kind'
  | 'invalid_field'
  | 'event_chain_broken'
  | 'event_hash_mismatch'
  /** INSERT event 时撞库（同批重复 id 等）——不是信封/链错误，是并发或重复批。 */
  | 'append_conflict'
  /** 调用方已开事务（`db.inTransaction`），网关不嵌套事务。 */
  | 'transaction_in_progress'
  | 'unauthorized_gate_judgement'
  /** M3-4/P1-2：`renderer.registered` 必须由 `registerRenderer()` 的一一次性能力产生。 */
  | 'unauthorized_renderer_registration'
  /** M4-2/C1：`lease.issued` 必须由 dispatch 工具路径的一次性能力产生。 */
  | 'unauthorized_lease_issue'
  /** M4-2/C2/C6：`task.claimed` 必须持未过期且 actor/card 匹配的活租约。 */
  | 'no_lease'
  /** M4-2/C5：租约已过期，原 actor 不能再写。 */
  | 'lease_expired'
  /** M4-2 第 2 轮 P1：撤租约时租约不存在或非 active。 */
  | 'lease_not_active'
  /** M4-2/C3：预占期内认领者必须等于 reserved_by。 */
  | 'not_reserved_actor'
  /** M4-3/C4：公共面写入只能由当前单写者能力路径执行。 */
  | 'not_public_face_writer'
  /** M4-3/C2：卡写域命中公共面登记前缀。 */
  | 'public_face_readonly'
  /** M4-4/C1：`right.granted`/`right.revoked` 必须由授权 API 的一次性能力产生。 */
  | 'unauthorized_right_change'
  /** M4-4/C2：不能撤掉该 domain 上最后一个 admin 权（0 事件）。 */
  | 'last_admin_right'
  /** `BEGIN IMMEDIATE` 撞上别的写者/锁（SQLITE_BUSY），不是投影错误。 */
  | 'database_busy'
  /** kind 已登记，但其投影表不在 M1-0 的物化范围内（写网关收窄，D-031）。 */
  | 'unsupported_scope'
  /** 事件已落库，但 fold/投影落库失败；整批 ROLLBACK。 */
  | 'materialize_failed'
  /** M2-0/C8：decision.signed 没有 signerd 的可验证回执（验签失败）。 */
  | 'signature_not_from_signerd'
  /** M2-3/C4：assumption.invalidated 是 fold 派生读数，不是可写事件（D-078）。 */
  | 'assumption_invalidated_is_derived'
  /** M2-3/P2-1：已签决策不能再 rejected（撤销走 decision.revoked）。 */
  | 'decision_already_signed'
  /** M3-3/C1：同一 decision 的复签名必须覆盖同一 payload_hash（首次签名被换内容即拒）。 */
  | 'payload_mismatch'
  /** M3-3/C1：独立性不满足（dual_human 凑不齐两人 / baseline 策略缺失或为 solo）。 */
  | 'independence_unsatisfied'
  /** M3-3/C2：solo_cooldown 冷却未结束，二次确认被拒。 */
  | 'cooldown_active'
  /** M3-3/C2：当前模式不是 solo_cooldown，冷却检查不适用（T0→T1 迁移后的正常拒绝路径）。 */
  | 'cooldown_not_applicable'
  | 'signature_time_mismatch'
  | 'signerd_receipt_replayed'
  /** M3-2：乐观并发写冲突（409 语义）；原事件不落，conflict.detected 落链。 */
  | 'conflict'
  /** M3-2：受管 kind 未声明 field/base_hash（P1-2）。 */
  | 'conflict_scope_undeclared'
  /** M3-2：conflict.detected 不是 CAS 路径 mint 的能力（P1-3）。 */
  | 'unauthorized_conflict_detected'
  /** M4-0：workcopy.created/removed 与 snapshot.taken 必须来自工具路径（一次性能力）。 */
  | 'unauthorized_workcopy_event'
  /** M4-1 第 2 轮 P1：根锁（`lock.acquired` subject `.`）只能由 `acquireMainTreeLock` 产出。 */
  | 'unauthorized_root_lock'
  /** M3-1/C3：会话没有该批事件所需的权（reason 里带 action/scope/actor_kind）。 */
  | 'no_permission'
  /** M3-1/P0：事件 kind 在 `KIND_ACTIONS` 里没有映射（fail-closed，不许调用方自带动作）。 */
  | 'unmapped_event_kind'
  /** M3-1/P1-2：事件 actor 与授权会话不一致（白名单 kind 除外）。 */
  | 'actor_not_from_session'
  /** M3-1/C8：动作级对象条件不满足（defect.close 需本人复验；verify_finding 只认 producer）。 */
  | 'object_condition_failed';
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
