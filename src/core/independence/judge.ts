/**
 * M3-3 独立性判定（纯函数，无 IO/时钟/随机；`now` 由调用方注入）。
 *
 * 三条口径（docs/07 §7）：
 *   1. 独立性是签字**动作**的属性：只有矩阵 `dual_human !== 'no'` 的动作才判；
 *   2. 按 actor（signer）去重计数——同一 actor 连签两次不算两个人；
 *   3. 冷却只锁同一 decision：从首次签名起算，窗口内二次确认 ⇒ `cooldown_active`。
 *
 * fail-closed：矩阵未登记动作、baseline 策略缺失/非法（⇒ `solo`）一律不满足，
 * 由调用方转成 `independence_unsatisfied`，绝不默认放行。
 */

import {
  cooldownMsOf,
  decisionActionForKind,
  effectiveMode,
  parseIndependencePolicy,
  requiresIndependence,
  type IndependenceMode,
  type IndependencePolicyError,
  type MatrixDualRow,
} from './policy.js';

export interface IndependenceSignature {
  readonly signer: string;
  /** signerd 回执时间；缺失时 null（fail-closed，见 receipt_time_missing）。 */
  readonly at: string | null;
  readonly receipt_time_missing: boolean;
  readonly signature: string;
  readonly payload_hash: string;
  readonly frontier: string | null;
}

export type IndependenceReasonCode =
  | IndependencePolicyError
  | 'independence_unsatisfied'
  | 'cooldown_active'
  | 'cooldown_not_applicable'
  | 'independence_unverifiable';

export interface IndependenceJudgement {
  readonly ok: boolean;
  readonly required: boolean;
  /** 判定时实际使用的模式；不需要独立性时为 null。 */
  readonly mode: IndependenceMode | null;
  readonly action: string | null;
  /** 不满足时给出的码；`cooldown_not_applicable` 仅出现在冷却查询路径。 */
  readonly reason_code?: IndependenceReasonCode;
  readonly message: string;
  readonly signature_count: number;
  readonly distinct_signers: number;
  /** `cooldown_active` 时剩余毫秒数。 */
  readonly remaining_ms?: number;
}

export interface JudgeIndependenceInput {
  readonly decision_kind: string;
  readonly signatures: readonly IndependenceSignature[];
  readonly matrix: readonly MatrixDualRow[];
  readonly assurance: unknown;
  readonly policy?: unknown;
  /** T0 判定：`actor` 表里 human 的数量（A2）。 */
  readonly human_actor_count: number;
}

export function judgeIndependence(input: JudgeIndependenceInput): IndependenceJudgement {
  const { signatures } = input;
  const distinct = new Set(signatures.map((item) => item.signer));
  const action = decisionActionForKind(input.decision_kind);
  if (action === null) {
    return {
      ok: true,
      required: false,
      mode: null,
      action: null,
      message: '该 decision_kind 不要求独立性',
      signature_count: signatures.length,
      distinct_signers: distinct.size,
    };
  }
  const required = requiresIndependence(input.matrix, action);
  if (required === null) {
    return {
      ok: false,
      required: true,
      mode: null,
      action,
      reason_code: 'independence_unsatisfied',
      message: `矩阵未登记动作 ${action}，无法判定独立性（fail-closed）`,
      signature_count: signatures.length,
      distinct_signers: distinct.size,
    };
  }
  if (!required) {
    return {
      ok: true,
      required: false,
      mode: null,
      action,
      message: `动作 ${action} 在矩阵里不需要独立性`,
      signature_count: signatures.length,
      distinct_signers: distinct.size,
    };
  }

  const parsed = parseIndependencePolicy(input.assurance);
  if (!parsed.ok) {
    return {
      ok: false,
      required: true,
      mode: null,
      action,
      reason_code: parsed.reason_code,
      message: parsed.message,
      signature_count: signatures.length,
      distinct_signers: distinct.size,
    };
  }
  const policy = parsed.policy;
  const mode = effectiveMode(policy);
  if (mode === 'solo') {
    return {
      ok: false,
      required: true,
      mode,
      action,
      reason_code: 'independence_unsatisfied',
      message: `baseline 的 assurance.independence 为 solo，动作 ${action} 不允许单人完成`,
      signature_count: signatures.length,
      distinct_signers: distinct.size,
    };
  }

  // 第 3 轮 P3：写网关已强制 payload.signerd.at；直插旧日志缺该字段 ⇒ fail-closed。
  if (signatures.some((item) => item.receipt_time_missing)) {
    return {
      ok: false,
      required: true,
      mode,
      action,
      reason_code: 'independence_unverifiable',
      message: '签名载荷缺少 signerd 回执时间（payload.signerd.at），无法判定独立性（fail-closed）',
      signature_count: signatures.length,
      distinct_signers: distinct.size,
    };
  }

  // 数据完整性：同一 decision 的所有签名必须覆盖同一 payload_hash。
  // frontier 不要求相等：第二签发生在首签之后，链头按定义已经前进；
  // 每条签名各自的 frontier 已由签字时的窗口绑定校验。
  const first = signatures[0];
  if (first !== undefined) {
    const mismatched = signatures.find((item) => item.payload_hash !== first.payload_hash);
    if (mismatched !== undefined) {
      return {
        ok: false,
        required: true,
        mode,
        action,
        reason_code: 'independence_unsatisfied',
        message: '同一 decision 的签名覆盖了不同的 payload_hash（证据不自洽）',
        signature_count: signatures.length,
        distinct_signers: distinct.size,
      };
    }
  }

  if (mode === 'dual_human') {
    if (distinct.size >= 2) {
      return {
        ok: true,
        required: true,
        mode,
        action,
        message: `已有 ${distinct.size} 个不同 human 签名`,
        signature_count: signatures.length,
        distinct_signers: distinct.size,
      };
    }
    return {
      ok: false,
      required: true,
      mode,
      action,
      reason_code: 'independence_unsatisfied',
      message: `动作 ${action} 需要 2 个不同 human，目前只有 ${distinct.size} 个`,
      signature_count: signatures.length,
      distinct_signers: distinct.size,
    };
  }

  // solo_cooldown：同 actor 两次，第二次距第一次 ≥ 冷却。
  if (distinct.size >= 2) {
    return {
      ok: true,
      required: true,
      mode,
      action,
      message: '已出现第二个不同 human，冷却不再适用',
      signature_count: signatures.length,
      distinct_signers: distinct.size,
    };
  }
  if (signatures.length < 2) {
    return {
      ok: false,
      required: true,
      mode,
      action,
      reason_code: 'independence_unsatisfied',
      message: `solo_cooldown：首次签名已记录，等待冷却结束后的二次确认（${String(input.human_actor_count)} 个 human）`,
      signature_count: signatures.length,
      distinct_signers: distinct.size,
    };
  }
  const sorted = [...signatures].sort((left, right) => Date.parse(left.at ?? '') - Date.parse(right.at ?? ''));
  const firstAt = Date.parse(sorted[0]?.at ?? '');
  const secondAt = Date.parse(sorted[1]?.at ?? '');
  const cooldown = cooldownMsOf(policy);
  if (cooldown === null) {
    return {
      ok: false,
      required: true,
      mode,
      action,
      reason_code: 'assurance_invalid',
      message: 'solo_cooldown 模式缺少冷却毫秒数（内部状态异常，fail-closed）',
      signature_count: signatures.length,
      distinct_signers: distinct.size,
    };
  }
  const elapsed = secondAt - firstAt;
  if (Number.isNaN(elapsed) || elapsed < cooldown) {
    const remaining = Number.isNaN(elapsed) ? cooldown : cooldown - elapsed;
    return {
      ok: false,
      required: true,
      mode,
      action,
      reason_code: 'cooldown_active',
      message: `冷却未结束：还需 ${String(Math.ceil(remaining / 60_000))} 分钟才能二次确认`,
      signature_count: signatures.length,
      distinct_signers: distinct.size,
      remaining_ms: remaining,
    };
  }
  return {
    ok: true,
    required: true,
    mode,
    action,
    message: `solo_cooldown 已满足：两次签名间隔 ${String(Math.floor(elapsed / 60_000))} 分钟`,
    signature_count: signatures.length,
    distinct_signers: distinct.size,
  };
}

/** 从事件集合里收出某 decision 的签名（按事件顺序）。 */
export interface SignedEventLike {
  readonly subject: string;
  readonly at: string;
  readonly payload: unknown;
}

export function signaturesForDecision(
  events: readonly SignedEventLike[],
  decisionId: string,
): IndependenceSignature[] {
  const result: IndependenceSignature[] = [];
  for (const event of events) {
    if (event.subject !== decisionId) continue;
    if (typeof event.payload !== 'object' || event.payload === null) continue;
    const payload = event.payload as Record<string, unknown>;
    const signer = payload['signer'];
    const signature = payload['signature'];
    const payloadHash = payload['payload_hash'];
    if (typeof signer !== 'string' || typeof signature !== 'string' || typeof payloadHash !== 'string') {
      continue;
    }
    const frontier = payload['frontier'];
    // 第 3 轮 P3：冷却按“签名证据里的回执时间”算；缺回执时间 fail-closed（不再回退 event.at）。
    const signerd = payload['signerd'];
    const receiptAt =
      typeof signerd === 'object' && signerd !== null ? (signerd as Record<string, unknown>)['at'] : undefined;
    result.push({
      signer,
      at: typeof receiptAt === 'string' && receiptAt.length > 0 ? receiptAt : null,
      receipt_time_missing: !(typeof receiptAt === 'string' && receiptAt.length > 0),
      signature,
      payload_hash: payloadHash,
      frontier: typeof frontier === 'string' ? frontier : null,
    });
  }
  return result;
}
