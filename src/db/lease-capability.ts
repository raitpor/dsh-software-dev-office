/**
 * M4-2/C1：租约工具路径一次性能力（照 M4-1 的 lock-capability 模式）。
 * 只有 `src/db/lease.ts` 私有实例能 mint；网关通过 `lease.ts` 导出的 consume 消费。
 */
import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';

export const LEASE_TOOL_MARKER = 'sdo-lease';
export const LEASE_TOOL_KINDS = ['lease.issued', 'lease.expired'] as const;

export function leasePayloadHash(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

export interface LeaseToolAuthority {
  mint(eventId: string, payloadHash: string): void;
  consume(eventId: string, payloadHash: string): boolean;
}

export function createLeaseToolAuthority(): LeaseToolAuthority {
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
