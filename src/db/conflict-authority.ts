/**
 * M3-2/P1-3 · `conflict.detected` 的一次性能力（与 M2-2 gate.judged 同模式）。
 *
 * 只有真 CAS 路径（`src/db/conflict.ts` 的 `buildConflictDetectedEvent`）持有 registry 的
 * `mint`；本模块只导出工厂与消费侧，`mint` 不是自由导出函数（同 M2-2 私有化口径，P3-1）。
 */
import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';

export function conflictDetectedPayloadHash(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

/** 进程内一次性能力。只有 `createConflictAuthority()` 的持有者能 mint。 */
export interface ConflictAuthority {
  mint(eventId: string, payloadHash: string): void;
  consume(eventId: string, payloadHash: string): boolean;
}

export function createConflictAuthority(): ConflictAuthority {
  const authorities = new Map<string, string>();
  return {
    mint(eventId, payloadHash) {
      authorities.set(eventId, payloadHash);
    },
    consume(eventId, payloadHash) {
      const expected = authorities.get(eventId);
      authorities.delete(eventId);
      return expected !== undefined && expected === payloadHash;
    },
  };
}
