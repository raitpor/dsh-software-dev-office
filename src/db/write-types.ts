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
  /** `BEGIN IMMEDIATE` 撞上别的写者/锁（SQLITE_BUSY），不是投影错误。 */
  | 'database_busy'
  /** kind 已登记，但其投影表不在 M1-0 的物化范围内（写网关收窄，D-031）。 */
  | 'unsupported_scope'
  /** 事件已落库，但 fold/投影落库失败；整批 ROLLBACK。 */
  | 'materialize_failed';
// 台账 D-025 需同步登记 append_conflict / transaction_in_progress（Lead 代记）。

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
}

export interface AppendFailure {
  readonly reason: AppendReason;
  readonly message: string;
}

export function failure(reason: AppendReason, message: string): AppendFailure {
  return { reason, message };
}
