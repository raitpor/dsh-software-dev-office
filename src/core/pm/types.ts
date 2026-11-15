/**
 * M2-5 · PM 最小环路的公共类型。
 *
 * 边界（卡 M2-5 的对齐）：PM 只做「读队列 → 建卡 → 预占/派发 → 请求签字」；
 * 不代签（`sign` 永远拒绝）、不实现 grant/escalate 真机制（M3），不存队列状态
 * （`pm_queue` 是视图，A3）。
 */

/** 身份类别由进程配置/会话固定，**不从请求载荷取**（D-056）。 */
export type PmActorKind = 'human' | 'agent';

export type PmFailureCode =
  | 'invalid_args'
  | 'invalid_field'
  | 'card_incomplete'
  | 'no_permission'
  | 'scope_mismatch'
  | 'not_a_signer'
  | 'not_unblockable_by_pm'
  | 'not_implemented'
  | 'task_not_found'
  | 'invalid_state'
  | 'no_such_seat'
  | 'write_failed';

export interface PmContext {
  readonly actor: string;
  readonly actorKind: PmActorKind;
  readonly producer?: string;
  /** 可注入时钟（毫秒）；用于生成确定性 subject id（P3-2）。 */
  readonly now?: () => number;
}

export interface PmFailure {
  readonly ok: false;
  readonly reason_code: PmFailureCode;
  readonly message: string;
}

export function pmFailure(reason_code: PmFailureCode, message: string): PmFailure {
  return { ok: false, reason_code, message };
}
