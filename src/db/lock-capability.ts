/**
 * M4-1/P1-1+P2-5：主树锁工具路径的一次性能力工厂（第 2 轮 P3-2 收紧导出面）。
 *
 * 本模块只导出工厂与类型（参考 M3-2 的 `createConflictAuthority()`）：
 * 实例由 `src/db/lock.ts` 私有创建，`mint` 是实例上的闭包，不在任何导出面上。
 * `write.ts` 通过 `src/db/lock.ts` 的 `consumeLockToolAuthority()` 消费。
 */
import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';
import { LOCK_TOOL_INITIATOR } from '../core/lock/ttl.js';

export const LOCK_TOOL_MARKER = LOCK_TOOL_INITIATOR;
export const LOCK_TOOL_KINDS = ['lock.acquired', 'lock.released'] as const;

export function lockToolPayloadHash(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

export interface LockToolAuthority {
  mint(eventId: string, payloadHash: string): void;
  consume(eventId: string, payloadHash: string): boolean;
}

/**
 * 第 3 轮 P3：本工厂只提供**类型与构造**，不是后门。能力只能由 `src/db/lock.ts` 的私有
 * 实例铸造（`mint` 是该实例的闭包，不在任何导出面上）；外部调用本工厂造出的实例，
 * `src/db/write.ts` 不会消费（网关只认 `lock.ts` 导出的 `consumeLockToolAuthority`）。
 * 这样测试/工具想“自己 mint 一个”也无法放行事件，用例见 `test/db/lock.test.js` P3-2。
 */
export function createLockToolAuthority(): LockToolAuthority {
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
