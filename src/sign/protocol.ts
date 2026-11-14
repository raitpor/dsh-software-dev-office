/**
 * signerd 与插件之间的 JSON-per-line 协议（docs/06 §3.1；C1）。
 *
 * 只有四个 op：status / unlock / lock / sign。`sign` 只带 hash/frontier/nonce/渠道，
 * 不带业务载荷——signerd 不解释“这条 decision 是什么意思”，只对规范化摘要盖章。
 * 每个请求都必须带 capability（0600 文件里的进程间凭据；D-048）。
 */
import type { SignFailure } from './errors.js';
import type { SignChannel } from './receipt.js';

export type ActorKind = 'human' | 'agent';

export interface StatusRequest {
  readonly op: 'status';
  readonly capability: string;
}

export interface UnlockRequest {
  readonly op: 'unlock';
  readonly capability: string;
  readonly actor: string;
  readonly actor_kind: ActorKind;
  readonly passphrase: string;
  readonly frontier: string;
}

export interface LockRequest {
  readonly op: 'lock';
  readonly capability: string;
  readonly actor: string;
}

export interface SignRequest {
  readonly op: 'sign';
  readonly capability: string;
  readonly actor: string;
  readonly actor_kind: ActorKind;
  /** 生产者；等于签名者即“自己批自己”，拒绝（no_proxy_sign）。 */
  readonly producer: string;
  readonly decision_id: string;
  readonly payload_hash: string;
  readonly proposition_hash: string;
  readonly frontier: string;
  readonly nonce: string;
  readonly channel: SignChannel;
}

export type SignerdRequest = StatusRequest | UnlockRequest | LockRequest | SignRequest;

export interface StatusSuccess {
  readonly ok: true;
  readonly op: 'status';
  readonly locked: boolean;
  readonly key_id: string | null;
  readonly window_until: string | null;
  readonly ttl_minutes: number;
}

export interface UnlockSuccess {
  readonly ok: true;
  readonly op: 'unlock';
  readonly key_id: string;
  readonly window_until: string | null;
  readonly ttl_minutes: number;
  readonly unlock_ms: number;
}

export interface LockSuccess {
  readonly ok: true;
  readonly op: 'lock';
}

export interface SignSuccess {
  readonly ok: true;
  readonly op: 'sign';
  readonly receipt_id: string;
  readonly signature: string;
  readonly key_id: string;
  readonly signer: string;
  readonly channel: SignChannel;
  readonly at: string;
  /** C11：解锁后到本次签发之间的真实等待（毫秒）。 */
  readonly unlock_wait_ms: number;
  /** C11：Ed25519 签名本身的耗时（毫秒）。 */
  readonly sign_ms: number;
}

export type SignerdSuccess = StatusSuccess | UnlockSuccess | LockSuccess | SignSuccess;
export type SignerdResponse = SignerdSuccess | SignFailure;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function isActorKind(value: unknown): value is ActorKind {
  return value === 'human' || value === 'agent';
}

export function isSignChannelValue(value: unknown): value is SignChannel {
  return value === 'ui' || value === 'cli';
}

export interface ParseResult {
  readonly request?: SignerdRequest;
  readonly failure?: SignFailure;
}

/** 反序列化一行请求；字段缺口给稳定码，不抛异常。 */
export function parseRequest(line: string): ParseResult {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return { failure: { ok: false, reason_code: 'invalid_request', message: '请求不是合法 JSON' } };
  }
  if (!isRecord(value)) {
    return { failure: { ok: false, reason_code: 'invalid_request', message: '请求必须是 JSON 对象' } };
  }
  const op = value['op'];
  const capability = stringField(value, 'capability');
  if (capability === undefined) {
    return { failure: { ok: false, reason_code: 'invalid_request', message: '缺少 capability' } };
  }
  if (op === 'status') return { request: { op, capability } };
  if (op === 'lock') {
    const actor = stringField(value, 'actor');
    if (actor === undefined) return { failure: { ok: false, reason_code: 'invalid_request', message: 'lock 缺少 actor' } };
    return { request: { op, capability, actor } };
  }
  if (op === 'unlock') {
    const actor = stringField(value, 'actor');
    const passphrase = typeof value['passphrase'] === 'string' ? value['passphrase'] : undefined;
    const frontier = stringField(value, 'frontier');
    const actor_kind = value['actor_kind'];
    if (actor === undefined || passphrase === undefined || frontier === undefined || !isActorKind(actor_kind)) {
      return { failure: { ok: false, reason_code: 'invalid_request', message: 'unlock 字段不全' } };
    }
    return { request: { op, capability, actor, actor_kind, passphrase, frontier } };
  }
  if (op === 'sign') {
    const actor = stringField(value, 'actor');
    const producer = stringField(value, 'producer');
    const decision_id = stringField(value, 'decision_id');
    const payload_hash = stringField(value, 'payload_hash');
    const proposition_hash = stringField(value, 'proposition_hash');
    const frontier = stringField(value, 'frontier');
    const nonce = stringField(value, 'nonce');
    const actor_kind = value['actor_kind'];
    const channel = value['channel'];
    if (
      actor === undefined ||
      producer === undefined ||
      decision_id === undefined ||
      payload_hash === undefined ||
      proposition_hash === undefined ||
      frontier === undefined ||
      nonce === undefined ||
      !isActorKind(actor_kind) ||
      !isSignChannelValue(channel)
    ) {
      return { failure: { ok: false, reason_code: 'invalid_request', message: 'sign 字段不全' } };
    }
    return {
      request: {
        op,
        capability,
        actor,
        actor_kind,
        producer,
        decision_id,
        payload_hash,
        proposition_hash,
        frontier,
        nonce,
        channel,
      },
    };
  }
  return { failure: { ok: false, reason_code: 'unknown_request', message: `未知 op ${String(op)}` } };
}
