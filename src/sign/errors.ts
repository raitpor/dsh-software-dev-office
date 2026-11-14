/**
 * M2-0 sign 层的稳定拒绝码与失败形状（C10）。
 *
 * 所有对外拒绝统一 `{ok:false, reason_code, message}`；码表同时写进 `src/sign/README.md`。
 * 码只增不改：UI/CLI 与 `sdo_check` 靠它分派，改字符串等于改协议。
 */

export const SIGN_REASON_CODES = [
  // 签字链（docs/06 §6 §3）
  'awaiting_unlock',
  'not_a_signer',
  'no_blind_sign',
  'frontier_stale',
  'signature_not_from_signerd',
  'signature_unverifiable',
  'runtime_inconsistent',
  // 写网关真实原因透传（第 4 轮 P2-1）：签后复核通过但 append 时 prev 已被并发推进。
  'event_chain_broken',
  // signerd 自身
  'bad_passphrase',
  'rate_limited',
  'locked',
  'invalid_request',
  'unknown_request',
  'store_not_initialized',
  'key_missing',
  'key_file_insecure',
  'key_dir_insecure',
  'dir_perm_insecure',
  'file_perm_insecure',
  'key_envelope_invalid',
  'receipt_not_found',
  'signerd_already_running',
  'signerd_lock_insecure',
  // D-054：信任根被改动 / 回执链断裂
  'signerd_home_insecure',
  'receipt_chain_broken',
  // 平台与路径（C2/C5）
  'platform_unsupported',
  'socket_dir_insecure',
  'socket_perm_insecure',
  'socket_path_too_long',
  'socket_not_ready',
  'runtime_dir_insecure',
  // 路径与权限（spike fs-perms 同名码）
  'path_missing',
  'path_is_symlink',
  'path_not_directory',
  'path_not_regular_file',
  'path_owner_mismatch',
] as const;

export type SignReasonCode = (typeof SIGN_REASON_CODES)[number];

/** 失败形状：C10 规定所有入口同形，不许有的抛异常有的返回 false。 */
export interface SignFailure {
  readonly ok: false;
  readonly reason_code: SignReasonCode;
  readonly message: string;
}

export function fail(reason_code: SignReasonCode, message: string): SignFailure {
  return { ok: false, reason_code, message };
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
