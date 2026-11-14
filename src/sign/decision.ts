/**
 * 插件侧的决策签发流程（C3/C4/C5/C6；docs/06 §6）。
 *
 * 顺序固定：
 *   1. 结构闸门（四元组 + renderer 命题）——缺一项就是 `no_blind_sign`，**0 行**；
 *   2. agent 代签 → `not_a_signer`，落一条 `security.alert`（append 成功即 event，不投影）；
 *   3. signerd 未解锁 → `awaiting_unlock`，**不写 decision.valid**（不许半条行）；
 *   4. 签发成功 → 同一批 append `decision.valid` + `decision.signed`（网关验签）。
 *
 * 命题由 renderer 从结构化字段渲染；调用方自带的 proposition 必须与渲染结果逐字一致，
 * 否则拒（模型不能自由撰写命题——这是“不盲签”的落地口径）。
 */
import { randomUUID } from 'node:crypto';

import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';
import type { Event } from '../core/fold/types.js';
import { GENESIS_PREV, computeEventHash } from '../core/verify-events.js';
import type { SdoDatabase } from '../db/driver.js';
import { append, chainHead } from '../db/write.js';
import type { SignerdClient } from './client.js';
import { fail, isSignReasonCode, type SignFailure, type SignReasonCode } from './errors.js';
import type { ActorKind } from './protocol.js';
import { propositionHash, type SignChannel } from './receipt.js';

export const DECISION_KINDS = [
  'sign',
  'intent',
  'plan',
  'spec_set',
  'assumption_set',
  'freeze',
  'baseline',
  'waiver',
  'rollback',
] as const;

export type DecisionKind = (typeof DECISION_KINDS)[number];

export interface DecisionRequest {
  readonly decision_kind: DecisionKind;
  /** 结构化对象与取值（renderer 的输入，也是签名载荷的一部分）。 */
  readonly subject: string;
  readonly value: string;
  /** 四元组：命题（渲染）/ 证据 / 差异 / 后果。 */
  readonly evidence: readonly string[];
  readonly difference: string;
  readonly consequence: string;
  /** 可选：调用方（签字页）渲染后回传的命题；必须与 renderer 一致。 */
  readonly proposition?: string;
  /** 子载荷（如 baseline 的 guarantee_delta），进 payload_hash。 */
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly actor: string;
  readonly actor_kind: ActorKind;
  readonly producer: string;
  readonly channel: SignChannel;
  readonly frontier: string;
  readonly nonce?: string;
}

export interface PreparedDecision {
  readonly decision_id: string;
  readonly nonce: string;
  readonly proposition: string;
  readonly proposition_hash: string;
  readonly payload_hash: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function renderProposition(input: {
  readonly subject: string;
  readonly value: string;
  readonly consequence: string;
}): string {
  return `${input.subject} 定为 ${input.value}；代价：${input.consequence}`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** C5：四元组与命题一致性闸门；失败 = `no_blind_sign`，调用方不得写任何行。 */
export function prepareDecision(input: DecisionRequest): PreparedDecision | SignFailure {
  if (!nonEmpty(input.subject) || !nonEmpty(input.value)) {
    return fail('no_blind_sign', '命题缺少 subject/value');
  }
  const evidence = input.evidence.filter(nonEmpty);
  if (evidence.length === 0 || evidence.length !== input.evidence.length) {
    return fail('no_blind_sign', '四元组缺证据（evidence 必须非空且不含空项）');
  }
  if (!nonEmpty(input.difference)) return fail('no_blind_sign', '四元组缺差异（difference）');
  if (!nonEmpty(input.consequence)) return fail('no_blind_sign', '四元组缺后果（consequence）');
  const rendered = renderProposition({
    subject: input.subject,
    value: input.value,
    consequence: input.consequence,
  });
  if (input.proposition !== undefined && input.proposition !== rendered) {
    return fail('no_blind_sign', '调用方给的 proposition 与 renderer 渲染结果不一致');
  }
  const payload = {
    decision_kind: input.decision_kind,
    subject: input.subject,
    value: input.value,
    proposition: rendered,
    evidence: [...evidence],
    difference: input.difference,
    consequence: input.consequence,
    ...(input.extra === undefined ? {} : { extra: input.extra }),
    as_of_frontier: input.frontier,
  };
  const payload_hash = `sha256:${sha256Hex(canonicalJson(payload))}`;
  return {
    decision_id: `dec-${randomUUID()}`,
    nonce: input.nonce ?? randomUUID(),
    proposition: rendered,
    proposition_hash: propositionHash(rendered),
    payload_hash,
    payload,
  };
}

interface EventSeed {
  readonly kind: string;
  readonly subject: string;
  readonly actor: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly request_id: string;
  readonly at: string;
  readonly caused_by?: readonly string[];
}

function buildEvent(seed: EventSeed, prev: string): Event {
  const event = {
    id: `ev-${randomUUID()}`,
    at: seed.at,
    actor: seed.actor,
    kind: seed.kind,
    subject: seed.subject,
    payload: seed.payload,
    caused_by: [...(seed.caused_by ?? [])],
    request_id: seed.request_id,
    prev,
  };
  const hash = computeEventHash({ ...event, hash: '' });
  return { ...event, hash };
}

function appendOne(db: SdoDatabase, seed: EventSeed): { ok: true } | SignFailure {
  const event = buildEvent(seed, chainHead(db));
  const result = append(db, [event]);
  if (!result.ok) {
    return fail(result.reason_code as SignReasonCode, result.message ?? 'append rejected');
  }
  return { ok: true };
}

/** C4：代签尝试必须留痕；告警只是 ack kind，不落业务表。 */
export function recordSecurityAlert(
  db: SdoDatabase,
  input: { actor: string; actor_kind: ActorKind; at: string; detail: string },
): void {
  appendOne(db, {
    kind: 'security.alert',
    subject: input.actor,
    actor: input.actor,
    payload: {
      alert: 'proxy_sign_attempt',
      actor_kind: input.actor_kind,
      at: input.at,
      detail: input.detail,
    },
    request_id: `req-${randomUUID()}`,
    at: input.at,
  });
}

/** docs/06 §3.1：解锁失败落 auth.failed（不含口令、不含长度）。 */
export function recordAuthFailure(
  db: SdoDatabase,
  input: { actor: string; at: string; reason: string },
): void {
  appendOne(db, {
    kind: 'auth.failed',
    subject: input.actor,
    actor: input.actor,
    payload: { reason: input.reason, at: input.at },
    request_id: `req-${randomUUID()}`,
    at: input.at,
  });
}

export interface UnlockOutcome {
  readonly ok: true;
  readonly key_id: string;
  readonly window_until: string | null;
  readonly ttl_minutes: number;
  readonly unlock_ms: number;
}

export async function unlockSigner(
  db: SdoDatabase,
  client: SignerdClient,
  input: { actor: string; actor_kind: ActorKind; passphrase: string; frontier: string; now?: Date },
): Promise<UnlockOutcome | SignFailure> {
  const now = input.now ?? new Date();
  if (input.actor_kind === 'agent') {
    recordSecurityAlert(db, {
      actor: input.actor,
      actor_kind: input.actor_kind,
      at: now.toISOString(),
      detail: 'agent 尝试解锁 signerd',
    });
    return fail('not_a_signer', 'agent 不能解锁签名密钥（no_proxy_sign）');
  }
  const response = await client.unlock({
    actor: input.actor,
    actor_kind: input.actor_kind,
    passphrase: input.passphrase,
    frontier: input.frontier,
  });
  if (!response.ok) {
    if (response.reason_code === 'bad_passphrase' || response.reason_code === 'rate_limited') {
      recordAuthFailure(db, { actor: input.actor, at: now.toISOString(), reason: response.reason_code });
    }
    return response;
  }
  return {
    ok: true,
    key_id: response.key_id,
    window_until: response.window_until,
    ttl_minutes: response.ttl_minutes,
    unlock_ms: response.unlock_ms,
  };
}

export interface SignOutcome {
  readonly ok: true;
  readonly decision_id: string;
  readonly signature: string;
  readonly key_id: string;
  readonly channel: SignChannel;
  readonly signer: string;
  readonly frontier: string;
  readonly receipt_id: string;
}

export interface SignResult {
  readonly ok: boolean;
  readonly reason_code?: string;
  readonly message?: string;
  readonly decision_id?: string;
}

/** P2-1：append 已提交但之后链头漂移的返回体（必须让调用方知道“已写入”）。 */
export interface SignDivergedFailure extends SignFailure {
  readonly written_decision_id: string;
  readonly events_written: number;
}

/** 一次完整签发：结构闸门 → signerd 签名 → 同批写 valid+signed。 */
export async function signDecision(
  db: SdoDatabase,
  client: SignerdClient,
  input: DecisionRequest & { readonly now?: Date },
): Promise<SignOutcome | SignFailure | SignDivergedFailure> {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  if (input.actor_kind === 'agent') {
    recordSecurityAlert(db, {
      actor: input.actor,
      actor_kind: input.actor_kind,
      at,
      detail: `agent 尝试签发 decision_kind=${input.decision_kind}`,
    });
    return fail('not_a_signer', 'agent 不能触发签名（no_proxy_sign）');
  }
  const prepared = prepareDecision(input);
  if ('reason_code' in prepared) return prepared;
  const decision = prepared;

  // P1-1/frontier 绑定：签名前必须确认请求的 frontier 就是当前链头。
  // 只把字符串送进 signerd 等于让调用方自证——解锁后若链前进过，旧 frontier 仍会被签。
  const head = chainHead(db);
  if (head !== input.frontier) {
    // 窗口也要失效：尽力让 signerd 回 locked，避免“链已变、窗口还开着”。
    await client.lock(input.actor).catch(() => undefined);
    return fail(
      'frontier_stale',
      `frontier 已过期：库链头 ${head}，请求 ${input.frontier}；请重新解锁`,
    );
  }

  const signed = await client.sign({
    actor: input.actor,
    actor_kind: input.actor_kind,
    producer: input.producer,
    decision_id: decision.decision_id,
    payload_hash: decision.payload_hash,
    proposition_hash: decision.proposition_hash,
    frontier: input.frontier,
    nonce: decision.nonce,
    channel: input.channel,
  });
  if (!signed.ok) return signed;

  // P1-1（第 3 轮）：签后复核。signerd 签名期间可能已有并发 append；请求的 frontier
  // 必须仍是链头，否则这次签名对应的是过期快照 ⇒ 丢弃刚写入的回执、lock、0 行。
  // 不复核就只能信“签前那一刻”，TOCTOU 窗口真实存在（Lead 实测要求）。
  const afterSign = chainHead(db);
  if (afterSign !== input.frontier) {
    await client.lock(input.actor).catch(() => undefined);
    // 回执清理是尽力而为：读/写失败不能把失败路径变成异常（第 4/5 轮 P2-2；
    // 该方法内部已吞掉 IO/解析错误并写 stderr 警告）。
    client.discardReceiptOnFailure(signed.receipt_id);
    return fail(
      'frontier_stale',
      `frontier 在签发期间变化：签名前 ${input.frontier}，签名后 ${afterSign}；请重新解锁`,
    );
  }

  const requestId = `req-${randomUUID()}`;
  const validEvent = buildEvent(
    {
      kind: 'decision.valid',
      subject: decision.decision_id,
      actor: input.producer,
      payload: {
        decision_kind: input.decision_kind,
        payload_hash: decision.payload_hash,
        frontier: input.frontier,
        payload: decision.payload,
      },
      request_id: requestId,
      at,
    },
    // 第 4 轮 P1：prev 直接取“签后复核读到的链头”，不再读第三次——
    // 否则复核与建事件之间仍有窄窗；用 afterSign 后任何更晚的并发 append 都会让
    // append 的 prev 校验失败（event_chain_broken，0 行）。
    afterSign,
  );
  const signedEvent = buildEvent(
    {
      kind: 'decision.signed',
      subject: decision.decision_id,
      actor: input.actor,
      payload: {
        payload_hash: decision.payload_hash,
        proposition_hash: decision.proposition_hash,
        frontier: input.frontier,
        nonce: decision.nonce,
        signature: signed.signature,
        key_id: signed.key_id,
        signer: signed.signer,
        channel: signed.channel,
        signerd: {
          receipt_id: signed.receipt_id,
          at: signed.at,
          unlock_wait_ms: signed.unlock_wait_ms,
          sign_ms: signed.sign_ms,
        },
      },
      request_id: requestId,
      at,
      caused_by: [validEvent.id],
    },
    validEvent.hash,
  );
  const result = append(db, [validEvent, signedEvent]);
  if (!result.ok) {
    const reason = String(result.reason_code);
    // P3：保留写网关的真实原因（之前一律折成 unknown_request 会掩盖链路/验签问题）。
    return fail(
      isSignReasonCode(reason) ? reason : 'unknown_request',
      result.message ?? 'append rejected',
    );
  }
  // P2-1（第 3 轮）：append 已提交但提交后链头漂移（并发写入）——这是“已落盘、
  // 需要人工核对”的状态，不能伪装成“签名未落盘”。返回体显式带写入的 decision id 与事件数。
  const after = chainHead(db);
  if (after !== signedEvent.hash) {
    return {
      ok: false,
      reason_code: 'runtime_inconsistent',
      message: `已落盘但提交后链头变化，需人工核对：decision ${decision.decision_id}（events_written=2，期望链头 ${signedEvent.hash}，实际 ${after}）`,
      written_decision_id: decision.decision_id,
      events_written: 2,
    };
  }
  return {
    ok: true,
    decision_id: decision.decision_id,
    signature: signed.signature,
    key_id: signed.key_id,
    channel: signed.channel,
    signer: signed.signer,
    frontier: input.frontier,
    receipt_id: signed.receipt_id,
  };
}

export { GENESIS_PREV };
