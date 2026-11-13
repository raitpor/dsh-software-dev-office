import type { Event } from '../../src/core/fold/index.js';

/** 测试用事件工厂：字段合法即可，hash 链由 M-2 的 verify 校验，不归 fold。 */
export function eventFactory(prefix = 't'): {
  ev: (kind: string, subject: string, payload: unknown, overrides?: Partial<Event>) => Event;
} {
  let seq = 0;
  return {
    ev(kind, subject, payload, overrides = {}) {
      seq += 1;
      return {
        id: `e-${prefix}-${seq}`,
        at: '2026-01-01T00:00:00Z',
        actor: 'actor-1',
        kind,
        subject,
        payload,
        caused_by: [],
        request_id: `req-${prefix}-${seq}`,
        prev: `h-${prefix}-${seq - 1}`,
        hash: `h-${prefix}-${seq}`,
        ...overrides,
      };
    },
  };
}

/**
 * 一条授权必须两个事件：decision.valid 建行、decision.signed 补签名（docs/06 只增不改）。
 * 返回值可直接 spread 进事件数组。
 */
export function signedDecision(
  ev: (kind: string, subject: string, payload: unknown, overrides?: Partial<Event>) => Event,
  id: string,
  kind: string,
  payload?: unknown,
): Event[] {
  const payloadHash = `ph-${id}`;
  return [
    ev('decision.valid', id, {
      decision_kind: kind,
      payload_hash: payloadHash,
      ...(payload === undefined ? {} : { payload }),
    }),
    ev('decision.signed', id, {
      payload_hash: payloadHash,
      signature: `sig-${id}`,
      key_id: 'key-1',
      signer: 'alice',
    }),
  ];
}

/** 键序无关的序列化：确定性断言不能靠对象插入顺序碰巧。 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
