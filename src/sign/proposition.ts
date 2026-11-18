import { CODE } from '../core/errors/codes.js';
/**
 * M2-6：签字页的**命题渲染器**（C1；docs/06 §5）。
 *
 * 设计口径：命题由 renderer 从 `claim` 渲染，模型不能自由撰写。签字页只收
 * `claim_ids` + 四项契约里工具侧给出的 `difference`/`consequence`；页面上显示的
 * `proposition` 与提交时服务端复算的结果逐字比对，不一致 ⇒ `no_blind_sign`。
 *
 * claim 行是 M1-6 渲染器网关的投影（`src/claim/gateway.ts`），本模块只读、不写。
 */

import type { SdoDatabase } from '../db/driver.js';

export interface ClaimRecord {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly as_of_frontier: string;
  readonly derived_by: string;
  readonly actor: string;
  readonly at: string;
}

export type ClaimResolveFailure = {
  readonly ok: false;
  readonly reason_code: typeof CODE.claim_not_found | typeof CODE.claim_invalid | typeof CODE.renderer_unregistered;
  readonly message: string;
};

export type ClaimResolveResult = { readonly ok: true; readonly claims: readonly ClaimRecord[] } | ClaimResolveFailure;

const CLAIM_SELECT =
  'SELECT id, subject, predicate, value, as_of_frontier, derived_by, actor, at FROM claim WHERE id = ?';

/** 逐 id 读 claim 行（顺序稳定：按 id 排序）；缺任意一条 ⇒ fail-closed。 */
export function loadClaimRecords(db: SdoDatabase, claimIds: readonly string[]): ClaimResolveResult {
  if (claimIds.length === 0) {
    return { ok: false, reason_code: CODE.claim_invalid, message: '至少需要一个 claim 作为命题依据' };
  }
  const unique = [...new Set(claimIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (unique.length !== claimIds.length) {
    return { ok: false, reason_code: CODE.claim_invalid, message: 'claim_ids 不得重复' };
  }
  const claims: ClaimRecord[] = [];
  for (const id of unique) {
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { ok: false, reason_code: CODE.claim_invalid, message: 'claim_ids 必须是非空字符串' };
    }
    const row = db.prepare(CLAIM_SELECT).get(id) as ClaimRecord | undefined;
    if (row === undefined) {
      return { ok: false, reason_code: CODE.claim_not_found, message: `claim ${id} 不存在` };
    }
    if (row.derived_by.trim().length === 0) {
      return { ok: false, reason_code: CODE.renderer_unregistered, message: `claim ${id} 没有渲染器` };
    }
    claims.push(row);
  }
  return { ok: true, claims };
}

/**
 * claim.value 的展示文本：期望是 `{"code":..., "value":...}` 的规范化 JSON；
 * 解析失败时原样展示（加引号），不让渲染器因坏值抛异常。
 */
export function claimValueText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return raw;
    const record = parsed as Record<string, unknown>;
    const code = typeof record['code'] === 'string' ? record['code'] : undefined;
    const value = record['value'];
    if (code === undefined) return raw;
    return `${code}=${String(value)}`;
  } catch {
    return raw;
  }
}

/** 单条 claim 的渲染行：固定句式，不含任何调用方自由文本。 */
export function renderClaimLine(claim: ClaimRecord): string {
  return `${claim.subject} 的 ${claim.predicate} 判定为 ${claimValueText(claim.value)}（渲染器 ${claim.derived_by}，${claim.at}）`;
}

/** 命题 = 全部 claim 渲染行按 id 排序后用「；」连接；不是模型写的摘要。 */
export function renderClaimsProposition(claims: readonly ClaimRecord[]): string {
  if (claims.length === 0) throw new Error('renderClaimsProposition 至少需要一条 claim');
  return claims.map(renderClaimLine).join('；');
}

export interface ClaimDecisionDraft {
  readonly claim_ids: readonly string[];
  readonly difference: string;
  readonly consequence: string;
}

export interface ResolvedClaimDecision {
  readonly claims: readonly ClaimRecord[];
  readonly claim_ids: readonly string[];
  readonly subject: string;
  readonly value: string;
  readonly evidence: readonly string[];
  readonly difference: string;
  readonly consequence: string;
  readonly proposition: string;
}

export type ResolvedClaimDecisionResult =
  | { readonly ok: true; readonly resolved: ResolvedClaimDecision }
  | ClaimResolveFailure
  | { readonly ok: false; readonly reason_code: typeof CODE.no_blind_sign; readonly message: string };

/**
 * 把「claim 集合 + 差异 + 后果」解析成可签的结构化字段。
 *
 * `subject`/`evidence` 全部由 claim 行派生：调用方只能选集合，不能改命题。
 * `value` 是固定词「已确认」（不是从模型输入抄来的）。
 */
export function resolveClaimDecision(db: SdoDatabase, draft: ClaimDecisionDraft): ResolvedClaimDecisionResult {
  if (draft.difference.trim().length === 0) {
    return { ok: false, reason_code: CODE.no_blind_sign, message: '四元组缺差异（difference）' };
  }
  if (draft.consequence.trim().length === 0) {
    return { ok: false, reason_code: CODE.no_blind_sign, message: '四元组缺后果（consequence）' };
  }
  const loaded = loadClaimRecords(db, draft.claim_ids);
  if (!loaded.ok) return loaded;
  const claims = loaded.claims;
  const subjects = [...new Set(claims.map((claim) => claim.subject))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return {
    ok: true,
    resolved: {
      claims,
      claim_ids: claims.map((claim) => claim.id),
      subject: subjects.join('、'),
      value: '已确认',
      evidence: claims.map((claim) => claim.id),
      difference: draft.difference,
      consequence: draft.consequence,
      proposition: renderClaimsProposition(claims),
    },
  };
}
