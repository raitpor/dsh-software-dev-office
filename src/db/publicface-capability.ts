/**
 * M4-3/C4：公共面单写者工具路径的一次性能力（照 M4-1 lock-capability / M4-2 lease-capability）。
 * 只有 `src/db/publicface.ts` 的私有实例能 mint；网关消费后即焚，绑 payload_hash。
 */
import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';

export const PUBLICFACE_TOOL_MARKER = 'sdo-publicface';
export const PUBLICFACE_TOOL_KINDS = ['publicface.executed', 'publicface.writer_changed'] as const;

export function publicFacePayloadHash(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

export interface PublicFaceAuthority {
  mint(eventId: string, payloadHash: string): void;
  consume(eventId: string, payloadHash: string): boolean;
}

export function createPublicFaceAuthority(): PublicFaceAuthority {
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
