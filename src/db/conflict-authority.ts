/**
 * M3-2/P1-3 · `conflict.detected` 的一次性能力（与 M2-2 gate.judged 同模式）。
 *
 * 只有 `buildConflictDetectedEvent`（真 CAS 路径）调用 `mint`；`append` 校验并
 * 烧毁。本文件不进入 db 包的公开面（`src/db/index.ts` 不导出 mint），测试只能
 * 通过真 CAS 写两次 stale 来造冲突行。
 */
import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';

const AUTHORITIES = new Map<string, string>();

export function conflictDetectedPayloadHash(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

/** 仅供 db/conflict.ts 的 build 调用；不要从其他模块 import。 */
export function mintConflictDetectedAuthority(eventId: string, payloadHash: string): void {
  AUTHORITIES.set(eventId, payloadHash);
}

export function consumeConflictDetectedAuthority(eventId: string, payloadHash: string): boolean {
  const expected = AUTHORITIES.get(eventId);
  AUTHORITIES.delete(eventId);
  return expected !== undefined && expected === payloadHash;
}
