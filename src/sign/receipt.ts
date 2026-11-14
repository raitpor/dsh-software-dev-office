/**
 * 回执与 Ed25519 签名规范化（C8/C9；docs/06 §5）。
 *
 * 签名对象是**规范化结构化载荷**，不是一段可自由拼接的文字：
 *   "sdo-decision-v1\n" + decision_id + payload_hash + frontier + proposition_hash + nonce
 * 每个字段单独一行，字段内不允许换行（由 `assertField` 保证）。
 */
import { createHash, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';

import { canonicalJson } from '../core/fold/canonical.js';

export const DECISION_MESSAGE_VERSION = 'sdo-decision-v1';
export const RECEIPT_VERSION = 'sdo-signerd-receipt-v1';

export interface DecisionSigningFields {
  readonly decision_id: string;
  readonly payload_hash: string;
  readonly proposition_hash: string;
  readonly frontier: string;
  readonly nonce: string;
}

function assertField(name: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`签名载荷字段 ${name} 必须是非空字符串`);
  }
  if (/[\n\r]/u.test(value)) {
    throw new Error(`签名载荷字段 ${name} 不许含换行`);
  }
}

export function canonicalDecisionMessage(fields: DecisionSigningFields): Buffer {
  assertField('decision_id', fields.decision_id);
  assertField('payload_hash', fields.payload_hash);
  assertField('proposition_hash', fields.proposition_hash);
  assertField('frontier', fields.frontier);
  assertField('nonce', fields.nonce);
  return Buffer.from(
    [
      DECISION_MESSAGE_VERSION,
      fields.decision_id,
      fields.payload_hash,
      fields.frontier,
      fields.proposition_hash,
      fields.nonce,
    ].join('\n'),
    'utf8',
  );
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function propositionHash(proposition: string): string {
  return `sha256:${sha256Hex(proposition)}`;
}

export function signCanonical(privateKey: KeyObject, message: Buffer): string {
  return cryptoSign(null, message, privateKey).toString('base64');
}

export function verifyCanonical(publicKey: KeyObject, message: Buffer, signatureB64: string): boolean {
  try {
    return cryptoVerify(null, message, publicKey, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export type SignChannel = 'ui' | 'cli';

/** 回执 id：确定性摘要，重复签发同一 (decision,payload,signature,at,nonce) 不会产生两条不同 id。 */
export function computeReceiptId(input: {
  readonly decision_id: string;
  readonly payload_hash: string;
  readonly signature: string;
  readonly at: string;
  readonly nonce: string;
}): string {
  return `rcpt:${sha256Hex(
    [RECEIPT_VERSION, input.decision_id, input.payload_hash, input.signature, input.at, input.nonce].join('\n'),
  )}`;
}

/** signerd 落进 `receipts.jsonl` 的一行（append-only，0600）。 */
export interface SignerdReceipt {
  readonly version: typeof RECEIPT_VERSION;
  readonly receipt_id: string;
  readonly decision_id: string;
  readonly payload_hash: string;
  readonly proposition_hash: string;
  readonly frontier: string;
  readonly nonce: string;
  readonly signature: string;
  readonly key_id: string;
  readonly signer: string;
  readonly channel: SignChannel;
  readonly at: string;
  /** C11：真实测量的两段耗时（毫秒），0 不通过。 */
  readonly unlock_wait_ms: number;
  /** M2-6 第 1 轮 P2-2：距上次解锁的真实时长（窗口复用时 unlock_wait_ms=0，它仍 >0）。 */
  readonly since_last_unlock_ms?: number;
  readonly sign_ms: number;
  /** D-054：回执哈希链的前驱哈希（首条为 null）。 */
  readonly prev_receipt_hash: string | null;
  /** 第 4 轮 P2-2：false 表示该回执未被 decision 行消费（frontier_stale 后被丢弃/标记）。 */
  readonly consumed?: boolean;
}

/** 回执行哈希：`sha256:` + canonicalJson(整条回执) 的十六进制。链上下一行的 prev 就是它。 */
export function receiptHash(receipt: SignerdReceipt): string {
  return `sha256:${sha256Hex(canonicalJson(receipt))}`;
}

export interface ReceiptChainCheck {
  readonly ok: boolean;
  /** 链断位置的下标；ok=true 时为 -1。 */
  readonly brokenAt: number;
  readonly expected: string | null;
  readonly actual: string | null;
}

/** 逐条校验回执哈希链：首条 prev=null，其余 prev=上一条的 receiptHash。 */
export function verifyReceiptChain(receipts: readonly SignerdReceipt[]): ReceiptChainCheck {
  let expected: string | null = null;
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index];
    if (receipt === undefined) continue;
    if (receipt.prev_receipt_hash !== expected) {
      return { ok: false, brokenAt: index, expected, actual: receipt.prev_receipt_hash };
    }
    expected = receiptHash(receipt);
  }
  return { ok: true, brokenAt: -1, expected, actual: null };
}

export function isSignChannel(value: unknown): value is SignChannel {
  return value === 'ui' || value === 'cli';
}

export function parseReceipt(line: string): SignerdReceipt | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record['version'] !== RECEIPT_VERSION) return undefined;
  for (const field of [
    'receipt_id',
    'decision_id',
    'payload_hash',
    'proposition_hash',
    'frontier',
    'nonce',
    'signature',
    'key_id',
    'signer',
    'at',
  ]) {
    if (typeof record[field] !== 'string' || (record[field] as string).length === 0) return undefined;
  }
  if (!isSignChannel(record['channel'])) return undefined;
  if (typeof record['unlock_wait_ms'] !== 'number' || typeof record['sign_ms'] !== 'number') return undefined;
  if ('since_last_unlock_ms' in record) {
    if (typeof record['since_last_unlock_ms'] !== 'number' || record['since_last_unlock_ms'] < 0) return undefined;
  }
  if (!('prev_receipt_hash' in record)) return undefined;
  if ('consumed' in record && typeof record['consumed'] !== 'boolean') return undefined;
  if (record['prev_receipt_hash'] !== null && (typeof record['prev_receipt_hash'] !== 'string' || (record['prev_receipt_hash'] as string).length === 0)) {
    return undefined;
  }
  return record as unknown as SignerdReceipt;
}

/** 回执字段必须与 decision.signed 载荷逐字段一致，否则视为“不是这次签名”。 */
export function receiptMatchesPayload(
  receipt: SignerdReceipt,
  payload: {
    readonly payload_hash: string;
    readonly proposition_hash: string;
    readonly frontier: string;
    readonly nonce: string;
    readonly signature: string;
    readonly key_id: string;
    readonly signer: string;
    readonly channel: SignChannel;
  },
): boolean {
  return (
    receipt.payload_hash === payload.payload_hash &&
    receipt.proposition_hash === payload.proposition_hash &&
    receipt.frontier === payload.frontier &&
    receipt.nonce === payload.nonce &&
    receipt.signature === payload.signature &&
    receipt.key_id === payload.key_id &&
    receipt.signer === payload.signer &&
    receipt.channel === payload.channel
  );
}
