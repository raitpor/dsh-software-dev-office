/** M4-3/C3：公共面申请的载荷形状与幂等键（不信任调用方传入的 hash）。 */
import { canonicalJson, sha256Hex } from '../fold/canonical.js';

export interface PublicFaceIntent {
  /** 机器可读的改动意图（如 registered criterion id / view name）。 */
  readonly kind: string;
  readonly [key: string]: unknown;
}

export function intentHash(intent: PublicFaceIntent): string {
  return `sha256:${sha256Hex(canonicalJson(intent))}`;
}

export interface PublicFaceRequestPayload {
  readonly card: string;
  readonly intent: PublicFaceIntent;
  readonly intent_hash: string;
  readonly diff: string;
  /** 判权作用域：由 requestPublicFace 从卡写域推导，不从调用方拿。 */
  readonly scope: string;
  readonly requested_at: string;
}
