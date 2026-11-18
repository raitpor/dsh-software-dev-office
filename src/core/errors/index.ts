/**
 * M4-5 码表公共入口：常量、类型、fail 构造器与内部兜底。
 *
 * 产品代码优先直接 `import { CODE } from '../core/errors/codes.js'`；
 * 需要构造失败对象时用 `fail(code, message)`，不要手拼 `{ ok:false, reason_code }`。
 */
export {
  CODE,
  REASON_CODES,
  fail,
  failInternalMissing,
  isReasonCode,
} from './codes.js';
export type {
  ReasonCode,
  ReasonCodeEntry,
  ReasonGroup,
  ReasonFailure,
} from './codes.js';
import { CODE, failInternalMissing, isReasonCode, type ReasonCode } from './codes.js';

/**
 * 边界兜底：把来源不可信的字符串收成已登记码；未登记一律 `internal_missing_reason_code`。
 * 这是 C4 的“无码路径”唯一入口——产品模块不应再各自实现 fallback。
 */
export const INTERNAL_MISSING_REASON_CODE = CODE.internal_missing_reason_code;

export function requireReasonCode(value: string | undefined): ReasonCode {
  return isReasonCode(value) ? value : failInternalMissing(`unregistered reason_code: ${String(value)}`).reason_code;
}
