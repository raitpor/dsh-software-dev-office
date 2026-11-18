import { CODE } from '../errors/codes.js';
/**
 * M2-5 · PM 最小环路的公共类型。
 *
 * 边界（卡 M2-5 的对齐）：PM 只做「读队列 → 建卡 → 预占/派发 → 请求签字」；
 * 不代签（`sign` 永远拒绝）、不实现 grant/escalate 真机制（M3），不存队列状态
 * （`pm_queue` 是视图，A3）。
 */

/** 身份类别由进程配置/会话固定，**不从请求载荷取**（D-056）。 */
export type PmActorKind = 'human' | 'agent';



export interface PmContext {
  readonly actor: string;
  readonly actorKind: PmActorKind;
  readonly producer?: string;
  /** 可注入时钟（毫秒）；用于生成确定性 subject id（P3-2）。 */
  readonly now?: () => number;
  /**
   * M3-5：权限端口（`docs/07` §2 的动作权）。缺省时回退到静态席位表
   * （M3-1 交付前）；M3-1 落地后由调用方注入 `src/core/auth` 的适配器。
   */
  readonly rights?: import('./access.js').RightsPort;
}

export interface PmFailure {
  readonly ok: false;
  readonly reason_code: PmFailureCode;
  readonly message: string;
}

export function pmFailure(reason_code: PmFailureCode, message: string): PmFailure {
  return { ok: false, reason_code, message };
}


export const PmFailureCode_CODES = [
  CODE.card_incomplete,
  CODE.invalid_args,
  CODE.invalid_field,
  CODE.invalid_state,
  CODE.no_permission,
  CODE.no_such_seat,
  CODE.not_a_signer,
  CODE.not_implemented,
  CODE.not_unblockable_by_pm,
  CODE.scope_mismatch,
  CODE.task_not_found,
  CODE.write_failed,
] as const;
export type PmFailureCode = (typeof PmFailureCode_CODES)[number];
