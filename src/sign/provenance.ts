/**
 * 写网关的验签侧（C8/C9；Lead 裁决：本文件只做验签，不加业务规则、不读业务表）。
 *
 * 判定口径：一条 `decision.signed` 只有在
 *   ① 载荷形状完整（payload_hash/proposition_hash/frontier/nonce/signature/key_id/signer/channel/receipt）
 *   ② key_id 在 signerd 的 `public_keys.json` 里（受信公钥）
 *   ③ Ed25519 签名能验过规范化摘要
 *   ④ receipt_id 在 `receipts.jsonl` 里且逐字段一致
 * 时才放行；任何一步缺失/不符都 fail-closed 为 `signature_not_from_signerd`。
 *
 * 注意：读 keyring/receipts 用只读 0600 校验；解析失败一律当“没有受信记录”。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { errorMessage, fail, type SignFailure } from './errors.js';
import { publicKeyFromBase64, requireEnvelopeShape } from './keys.js';
import { defaultSignerdHome } from './paths.js';
import { assertOwnerOnlyDir, readOwnerOnlyFile } from './permissions.js';
import {
  canonicalDecisionMessage,
  isSignChannel,
  parseReceipt,
  receiptMatchesPayload,
  verifyCanonical,
  verifyReceiptChain,
  type SignChannel,
  type SignerdReceipt,
} from './receipt.js';

export interface SignedDecisionPayload {
  readonly payload_hash: string;
  readonly proposition_hash: string;
  readonly frontier: string;
  readonly nonce: string;
  readonly signature: string;
  readonly key_id: string;
  readonly signer: string;
  readonly channel: SignChannel;
  readonly signerd: {
    readonly receipt_id: string;
    readonly at: string;
    readonly unlock_wait_ms: number;
    readonly sign_ms: number;
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 结构化读取 decision.signed 的签名载荷；任何缺口返回 undefined（不抛）。 */
export function readSignedDecisionPayload(value: unknown): SignedDecisionPayload | undefined {
  const outer = record(value);
  if (outer === undefined) return undefined;
  for (const field of ['payload_hash', 'proposition_hash', 'frontier', 'nonce', 'signature', 'key_id', 'signer']) {
    if (typeof outer[field] !== 'string' || (outer[field] as string).length === 0) return undefined;
  }
  if (!isSignChannel(outer['channel'])) return undefined;
  const signerd = record(outer['signerd']);
  if (signerd === undefined) return undefined;
  if (typeof signerd['receipt_id'] !== 'string' || signerd['receipt_id'].length === 0) return undefined;
  if (typeof signerd['at'] !== 'string' || signerd['at'].length === 0) return undefined;
  for (const field of ['unlock_wait_ms', 'sign_ms']) {
    const value = signerd[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  }
  return outer as unknown as SignedDecisionPayload;
}

function readKeyringB64(home: string, keyId: string): string | undefined {
  const path = join(home, 'public_keys.json');
  if (!existsSync(path)) return undefined;
  try {
    const parsed = record(JSON.parse(readOwnerOnlyFile(path)) as unknown);
    const keys = record(parsed?.['keys']);
    const value = keys?.[keyId];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

interface ReceiptLookup {
  readonly found: boolean;
  readonly matches: boolean;
  readonly reason?: 'home_insecure' | 'receipt_chain_broken';
  readonly message?: string;
}

/** 读 home 与回执文件（0600/0700 + 哈希链一次校验，D-054）；异常一律 fail-closed。 */
function loadReceipts(home: string): { ok: true; receipts: SignerdReceipt[] } | { ok: false; reason: 'home_insecure' | 'receipt_chain_broken'; message: string } {
  try {
    assertOwnerOnlyDir(home);
  } catch (error) {
    return { ok: false, reason: 'home_insecure', message: `signerd home 权限不安全：${errorMessage(error)}` };
  }
  const path = join(home, 'receipts.jsonl');
  if (!existsSync(path)) return { ok: true, receipts: [] };
  let text: string;
  try {
    text = readOwnerOnlyFile(path);
  } catch (error) {
    return { ok: false, reason: 'home_insecure', message: `回执文件不可信：${errorMessage(error)}` };
  }
  const receipts: SignerdReceipt[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const receipt = parseReceipt(line);
    if (receipt === undefined) {
      return { ok: false, reason: 'receipt_chain_broken', message: '回执文件含无法解析的行（可能被篡改）' };
    }
    receipts.push(receipt);
  }
  const chain = verifyReceiptChain(receipts);
  if (!chain.ok) {
    return {
      ok: false,
      reason: 'receipt_chain_broken',
      message: `回执哈希链在第 ${String(chain.brokenAt)} 条断裂（expected=${String(chain.expected)} actual=${String(chain.actual)}）`,
    };
  }
  return { ok: true, receipts };
}

function lookupReceipt(
  home: string,
  payload: SignedDecisionPayload,
  decisionId: string,
): ReceiptLookup {
  const loaded = loadReceipts(home);
  if (!loaded.ok) return { found: false, matches: false, reason: loaded.reason, message: loaded.message };
  const receipt = loaded.receipts.find(
    (entry) => entry.receipt_id === payload.signerd.receipt_id && entry.consumed !== false,
  );
  if (receipt === undefined) return { found: false, matches: false };
  return {
    found: true,
    matches: receipt.decision_id === decisionId && receiptMatchesPayload(receipt, payload),
  };
}

export interface ProvenanceCheck {
  readonly ok: boolean;
  readonly reason?:
    | 'shape'
    | 'untrusted_key'
    | 'bad_signature'
    | 'receipt_missing'
    | 'receipt_mismatch'
    | 'home_insecure'
    | 'receipt_chain_broken';
  readonly message?: string;
}

/** 只验“这条签名是不是 signerd 产的”；不判断业务语义。 */
export function checkDecisionSignedProvenance(input: {
  readonly decision_id: string;
  readonly payload: unknown;
  readonly home?: string;
}): ProvenanceCheck {
  const payload = readSignedDecisionPayload(input.payload);
  if (payload === undefined) {
    return { ok: false, reason: 'shape', message: 'decision.signed 载荷缺字段或类型不对' };
  }
  const home = input.home ?? defaultSignerdHome();
  const keyB64 = readKeyringB64(home, payload.key_id);
  if (keyB64 === undefined) {
    return { ok: false, reason: 'untrusted_key', message: `key_id ${payload.key_id} 不在受信 keyring 里` };
  }
  const publicKey = publicKeyFromBase64(keyB64);
  const message = canonicalDecisionMessage({
    decision_id: input.decision_id,
    payload_hash: payload.payload_hash,
    proposition_hash: payload.proposition_hash,
    frontier: payload.frontier,
    nonce: payload.nonce,
  });
  if (!verifyCanonical(publicKey, message, payload.signature)) {
    return { ok: false, reason: 'bad_signature', message: 'Ed25519 验签失败' };
  }
  const receipt = lookupReceipt(home, payload, input.decision_id);
  if (receipt.reason !== undefined) {
    return { ok: false, reason: receipt.reason, message: receipt.message };
  }
  if (!receipt.found) {
    return { ok: false, reason: 'receipt_missing', message: '找不到对应的 signerd 回执' };
  }
  if (!receipt.matches) {
    return { ok: false, reason: 'receipt_mismatch', message: '回执与签名载荷不一致' };
  }
  return { ok: true };
}

/** 写网关使用的失败形状（统一码，细节写进 message 供日志）。 */
export function provenanceFailure(check: ProvenanceCheck): SignFailure {
  return fail('signature_not_from_signerd', `拒绝决策签名：${check.message ?? '未通过验签'}`);
}

export { requireEnvelopeShape };
