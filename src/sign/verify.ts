/**
 * sign 层 verify（C9）：认得出“这条 decision.signed 是不是 signerd 产的”。
 *
 * 与 `src/core/verify.ts` 分工：core 只验事件链与投影一致性（不读文件系统）；
 * 这里额外读 signerd 的 keyring/receipts，把签名真伪与回执一致性报成：
 *   · `runtime_inconsistent` —— 签名对不上受信公钥 / 投影行与回执不一致；
 *   · `signature_unverifiable` —— 缺受信 key 或缺回执（无法证明来源）。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';
import { errorMessage } from './errors.js';
import { defaultSignerdHome } from './paths.js';
import { assertOwnerOnlyDir, readOwnerOnlyFile } from './permissions.js';
import {
  parseReceipt,
  receiptMatchesPayload,
  verifyReceiptChain,
  type SignerdReceipt,
} from './receipt.js';
import { checkDecisionSignedProvenance, readSignedDecisionPayload } from './provenance.js';

export type SignatureProblemCode =
  | 'runtime_inconsistent'
  | 'signature_unverifiable'
  | 'signerd_home_insecure'
  | 'receipt_chain_broken';

export interface SignatureProblem {
  readonly code: SignatureProblemCode;
  readonly decision_id: string;
  readonly detail: string;
}

export interface SignatureVerifyReport {
  readonly ok: boolean;
  readonly checked: number;
  readonly problems: readonly SignatureProblem[];
}

interface Statement {
  all(...params: unknown[]): unknown[];
}

export interface SignatureVerifyDatabase {
  prepare(sql: string): Statement;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function verifyDecisionSignatures(
  db: SignatureVerifyDatabase,
  options: { home?: string } = {},
): SignatureVerifyReport {
  const home = options.home ?? defaultSignerdHome();
  const problems: SignatureProblem[] = [];
  try {
    assertOwnerOnlyDir(home);
  } catch (error) {
    return {
      ok: false,
      checked: 0,
      problems: [{ code: 'signerd_home_insecure', decision_id: '', detail: errorMessage(error) }],
    };
  }
  const receipts = loadReceipts(home);
  if (receipts.chainBroken !== undefined) {
    problems.push({ code: 'receipt_chain_broken', decision_id: receipts.chainBroken, detail: '回执哈希链断裂（D-054）' });
  }
  const events = db
    .prepare("SELECT subject, at, payload FROM event WHERE kind = 'decision.signed' ORDER BY rowid")
    .all() as Array<{ subject: string; at: string; payload: unknown }>;

  // D-092：同一 decision 的多条 decision.signed 是 dual_human 的合法形态（首签投影、
  // 后续签名只追加）。这里对**每一条**签名做完整验签，投影行只可能与首签一致。
  const byDecision = new Map<string, Array<{ subject: string; at: string; payload: unknown }>>();
  for (const event of events) {
    const list = byDecision.get(event.subject);
    if (list === undefined) byDecision.set(event.subject, [event]);
    else list.push(event);
  }

  for (const list of byDecision.values()) {
    for (const [index, event] of list.entries()) {
    const payload = readSignedDecisionPayload(
      typeof event.payload === 'string' ? (JSON.parse(event.payload) as unknown) : event.payload,
    );
    if (payload === undefined) {
      problems.push({ code: 'runtime_inconsistent', decision_id: event.subject, detail: '签名载荷形状非法' });
      continue;
    }
    const check = checkDecisionSignedProvenance({ decision_id: event.subject, payload, home });
    if (!check.ok) {
      const code: SignatureProblemCode =
        check.reason === 'untrusted_key' || check.reason === 'receipt_missing'
          ? 'signature_unverifiable'
          : 'runtime_inconsistent';
      problems.push({ code, decision_id: event.subject, detail: check.message ?? '未通过验签' });
      continue;
    }
    const row = record(
      db
        .prepare('SELECT id, signature, key_id, channel, signer, frontier, payload, payload_hash FROM decision WHERE id = ?')
        .all(event.subject)[0],
    );
    if (row === undefined) {
      problems.push({ code: 'runtime_inconsistent', decision_id: event.subject, detail: 'decision 行不存在' });
      continue;
    }
    // 多签：投影行保持**首签**（按事件顺序第一条）；后续签名只要求 payload_hash
    // 与行一致（D-092）。不能用“row.signature === payload.signature”判断——那会让
    // 投影行被篡改（signature 改掉）的单签逃过验签。
    const isFirst = index === 0;
    if (!isFirst && payload.payload_hash !== row['payload_hash']) {
      problems.push({
        code: 'runtime_inconsistent',
        decision_id: event.subject,
        detail: '追加签名的 payload_hash 与 decision 行不一致（D-092）',
      });
      continue;
    }
    const receipt = receipts.byId.get(payload.signerd.receipt_id);
    if (receipt === undefined) {
      problems.push({ code: 'signature_unverifiable', decision_id: event.subject, detail: '回执缺失' });
      continue;
    }
    // 第 2 轮 P1-1：事件 at / 回执 at / 载荷 signerd.at 三方一致（复制事件改 at 必红）。
    if (event.at !== payload.signerd.at || receipt.at !== payload.signerd.at) {
      problems.push({
        code: 'runtime_inconsistent',
        decision_id: event.subject,
        detail: `事件 at=${event.at} / 回执 at=${receipt.at} / 载荷 at=${payload.signerd.at} 不一致`,
      });
      continue;
    }
    if (
      (isFirst &&
        (row['signature'] !== payload.signature ||
          row['key_id'] !== payload.key_id ||
          row['channel'] !== payload.channel ||
          row['signer'] !== payload.signer ||
          row['frontier'] !== payload.frontier)) ||
      !receiptMatchesPayload(receipt, payload)
    ) {
      problems.push({
        code: 'runtime_inconsistent',
        decision_id: event.subject,
        detail: 'decision 投影行与签名载荷/回执不一致',
      });
      continue;
    }
    // D-055：recompute payload_hash from the materialized payload and compare.
    const storedPayload = typeof row['payload'] === 'string' ? (JSON.parse(row['payload']) as unknown) : row['payload'];
    const recomputed = `sha256:${sha256Hex(canonicalJson(storedPayload))}`;
    if (row['payload_hash'] !== recomputed) {
      problems.push({
        code: 'runtime_inconsistent',
        decision_id: event.subject,
        detail: `decision.payload_hash 与 payload 内容不符（stored=${String(row['payload_hash'])} recomputed=${recomputed}）`,
      });
    }
    // P2-2（第 3 轮）：投影行的 payload_hash 还必须等于已签名载荷里的 payload_hash——
    // 否则“成对改 payload + payload_hash”可以骗过上面的重算，但骗不过签名绑定。
    if (row['payload_hash'] !== payload.payload_hash) {
      problems.push({
        code: 'runtime_inconsistent',
        decision_id: event.subject,
        detail: `decision.payload_hash 与签名载荷不一致（row=${String(row['payload_hash'])} signed=${payload.payload_hash}）`,
      });
    }
    }
  }

  return { ok: problems.length === 0, checked: events.length, problems };
}

interface LoadedReceipts {
  readonly byId: ReadonlyMap<string, SignerdReceipt>;
  readonly chainBroken?: string;
}

function loadReceipts(home: string): LoadedReceipts {
  const path = join(home, 'receipts.jsonl');
  if (!existsSync(path)) return { byId: new Map() };
  let text: string;
  try {
    text = readOwnerOnlyFile(path);
  } catch {
    return { byId: new Map(), chainBroken: '' };
  }
  const receipts: SignerdReceipt[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    const receipt = parseReceipt(line);
    if (receipt === undefined) {
      return { byId: new Map(), chainBroken: '' };
    }
    receipts.push(receipt);
  }
  const byId = new Map(
    receipts
      .filter((receipt) => receipt.consumed !== false)
      .map((receipt) => [receipt.receipt_id, receipt]),
  );
  const chain = verifyReceiptChain(receipts);
  if (!chain.ok) {
    const broken = receipts[chain.brokenAt];
    return { byId, chainBroken: broken?.decision_id ?? '' };
  }
  return { byId };
}
