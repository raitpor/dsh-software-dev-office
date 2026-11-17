/**
 * M4-7/P1-1：`agent.spawned`/`agent.spawn_streak` 的写入口能力。
 *
 * 背景：`agent.*` 事件没有投影表，网关对 ACK 只做会话绑定；若不加能力，
 * 任何有写权的人都能裸 append `agent.spawned` 并自填 `payload.snapshot`，
 * 绕过 `validateSpawnReason` 的复算（C1）。这里照 M4-1/M4-2/M4-3 的先例：
 * 能力一次性、绑 `payload_hash`、读后即删；mint 只在 `src/db/agent.ts`
 * 的实例私有，`src/db/write.ts` 只拿 consume 包装。
 */
import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';

export const AGENT_TOOL_MARKER = 'sdo-agent';
export const AGENT_TOOL_KINDS = ['agent.spawned', 'agent.spawn_streak'] as const;

export interface AgentEventAuthority {
  /** 事件写入前铸造；事件 id + payload hash 一经消费即失效。 */
  mint(eventId: string, payloadHash: string): void;
  consume(eventId: string, payloadHash: string): boolean;
}

export function agentPayloadHash(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(payload))}`;
}

/** 工厂只导出类型/哈希；实例由调用方私有持有，导出面不提供 mint。 */
export function createAgentEventAuthority(): AgentEventAuthority {
  const minted = new Map<string, string>();
  return {
    mint(eventId, payloadHash) {
      minted.set(eventId, payloadHash);
    },
    consume(eventId, payloadHash) {
      const expected = minted.get(eventId);
      minted.delete(eventId);
      return expected !== undefined && expected === payloadHash;
    },
  };
}
