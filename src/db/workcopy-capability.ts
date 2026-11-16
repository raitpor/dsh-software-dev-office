/**
 * M4-0 · 工作副本工具事件的一次性能力（能力注册表下沉，P3-10）。
 *
 * `write.ts`（校验）与 `workcopy-tool.ts`（mint）都只 import 本模块，避免两者循环依赖。
 * 照 S22 conflict.detected / M2-2 gate.judged 模式：实例私有 mint，消费即删（错配也烧）。
 */
import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';

export const WORKCOPY_TOOL_KINDS = ['workcopy.created', 'workcopy.removed', 'snapshot.taken'] as const;

export function workcopyPayloadHash(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

export interface WorkcopyAuthority {
  mint(eventId: string, payloadHash: string): void;
  consume(eventId: string, payloadHash: string): boolean;
}

export function createWorkcopyAuthority(): WorkcopyAuthority {
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

const WORKCOPY_AUTHORITY = createWorkcopyAuthority();

export function mintWorkcopyAuthority(eventId: string, payloadHash: string): void {
  WORKCOPY_AUTHORITY.mint(eventId, payloadHash);
}

/** 网关侧消费：一次性；错配同样烧掉（fail-closed）。 */
export function consumeWorkcopyAuthority(eventId: string, payloadHash: string): boolean {
  return WORKCOPY_AUTHORITY.consume(eventId, payloadHash);
}
