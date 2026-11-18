import { CODE } from '../core/errors/codes.js';
/**
 * M2-0 sign 层的稳定拒绝码与失败形状（C10）。
 *
 * 所有对外拒绝统一 `{ok:false, reason_code, message}`；码表同时写进 `src/sign/README.md`。
 * 码只增不改：UI/CLI 与 `sdo_check` 靠它分派，改字符串等于改协议。
 */

export const SIGN_REASON_CODES = [
  // 签字链（docs/06 §6 §3）
  
  CODE.awaiting_unlock,
  CODE.not_a_signer,
  CODE.no_blind_sign,
  // M2-6 C2：confirm 绑定的 hash 与当前内容不一致（两段式不可绕）。
  CODE.payload_changed,
  // M2-6 第 1 轮 P2-1：TTL=0 时一次解锁只授权一条；多条需开免密窗口（TTL>0）。
  CODE.ttl_requires_window,
  CODE.frontier_stale,
  CODE.signature_not_from_signerd,
  CODE.signature_unverifiable,
  CODE.runtime_inconsistent,
  // 写网关真实原因透传（第 4 轮 P2-1）：签后复核通过但 append 时 prev 已被并发推进。
  CODE.event_chain_broken,
  // signerd 自身
  CODE.bad_passphrase,
  CODE.rate_limited,
  CODE.locked,
  CODE.invalid_request,
  CODE.invalid_field,
  CODE.unknown_request,
  CODE.store_not_initialized,
  CODE.key_missing,
  CODE.key_file_insecure,
  CODE.key_dir_insecure,
  CODE.dir_perm_insecure,
  CODE.file_perm_insecure,
  CODE.key_envelope_invalid,
  CODE.receipt_not_found,
  CODE.signerd_already_running,
  CODE.signerd_lock_insecure,
  // D-054：信任根被改动 / 回执链断裂
  CODE.signerd_home_insecure,
  CODE.receipt_chain_broken,
  // 平台与路径（C2/C5）
  CODE.platform_unsupported,
  CODE.socket_dir_insecure,
  CODE.socket_perm_insecure,
  CODE.socket_path_too_long,
  CODE.socket_not_ready,
  CODE.runtime_dir_insecure,
  // M3-3：独立性（dual_human / solo_cooldown）
  CODE.independence_unsatisfied,
  CODE.cooldown_active,
  CODE.cooldown_not_applicable,
  CODE.signature_time_mismatch,
  CODE.signerd_receipt_replayed,
  CODE.payload_mismatch,
  // 路径与权限（spike fs-perms 同名码）
  CODE.path_missing,
  CODE.path_is_symlink,
  CODE.path_not_directory,
  CODE.path_not_regular_file,
  CODE.path_owner_mismatch,

] as const;

export type SignReasonCode = (typeof SIGN_REASON_CODES)[number];

/** 失败形状：C10 规定所有入口同形，不许有的抛异常有的返回 false。 */
export interface SignFailure {
  readonly ok: false;
  readonly reason_code: SignReasonCode;
  readonly message: string;
  /** 写网关的原始拒绝码（不折成 unknown_request 时也保留）。 */
  readonly append_reason_code?: string;
  /** M2-6 P2-1：被拒时已暂存的签名数与本批请求数。 */
  readonly staged?: number;
  readonly requested?: number;
}

export function fail(
  reason_code: SignReasonCode,
  message: string,
  extra: { append_reason_code?: string; staged?: number; requested?: number } = {},
): SignFailure {
  return { ok: false, reason_code, message, ...extra };
}

export function isSignReasonCode(value: unknown): value is SignReasonCode {
  return typeof value === 'string' && (SIGN_REASON_CODES as readonly string[]).includes(value);
}

export function isSignFailure(value: unknown): value is SignFailure {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return record['ok'] === false && typeof record['reason_code'] === 'string';
}

/** 内部用异常携带稳定码，边界处转成 `SignFailure`。 */
export class SignError extends Error {
  readonly reason_code: SignReasonCode;

  constructor(reason_code: SignReasonCode, message: string) {
    super(message);
    this.name = 'SignError';
    this.reason_code = reason_code;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把内部异常折成失败形状；非 SignError 归到 `unknown_request`，消息保留。 */
export function asFailure(error: unknown): SignFailure {
  if (error instanceof SignError) return fail(error.reason_code, error.message);
  return fail('unknown_request', errorMessage(error));
}
