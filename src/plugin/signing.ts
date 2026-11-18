/**
 * M5-0 C14：页签两道人证。
 *
 * 提案（agent）→ 人确认页重建摘要 → 解锁（TTL=0，页面口令）→ 签发（账号会话 + signerd）。
 * 签名载荷由 `prepareDecision` 生成，提案时存“去掉 as_of_frontier”的 decision_payload；
 * 签发时重新用当前 frontier 生成并比对，保证人确认的内容就是实际签的内容。
 *
 * 插件不保存/不回显/不落日志签字解锁串；`db.key` 与 `signing_key.json` 都只在状态目录。
 */

import { CODE } from '../core/errors/codes.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { canonicalJson, sha256Hex } from '../core/fold/canonical.js';
import type { SdoDatabase } from '../db/driver.js';
import type { Event } from '../core/fold/types.js';
import { readEvents } from '../core/verify-events.js';
import { append, chainHead } from '../db/write.js';
import { buildEvent } from '../db/freeze-store.js';
import {
  prepareDecision,
  signDecision,
  type DecisionRequest,
  type SignOutcome,
} from '../sign/decision.js';
import { SignerdClient } from '../sign/client.js';
import { initializeSignerd } from '../sign/signerd.js';
import { SignerdStore } from '../sign/store.js';
import { signerdPaths } from '../sign/paths.js';
import { startSignerdProcess, type SignerdProcessHandle } from './signerd.js';

export interface ProposalInput {
  readonly decision_kind: DecisionRequest['decision_kind'];
  readonly subject: string;
  readonly value: string;
  readonly evidence: readonly string[];
  readonly difference: string;
  readonly consequence: string;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly claim_ids?: readonly string[];
  readonly narrative?: string;
  readonly task_id?: string;
}

export interface ProposalSummary {
  readonly id: string;
  readonly decision_kind: string;
  readonly subject: string;
  readonly value: string;
  readonly proposition: string;
  readonly payload_hash_prefix: string;
  readonly claims: readonly { id: string; title: string; status: string }[];
  readonly narrative: string;
  readonly narrative_mismatch: boolean;
}

export interface ProposalResult {
  readonly ok: boolean;
  readonly reason_code?: string;
  readonly message?: string;
  readonly proposal_id?: string;
  readonly summary?: ProposalSummary;
}

interface ProposalPayload {
  readonly decision_kind: string;
  readonly subject: string;
  readonly value: string;
  readonly proposition: string;
  readonly evidence: readonly string[];
  readonly difference: string;
  readonly consequence: string;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly claim_ids?: readonly string[];
  readonly decision_payload: Readonly<Record<string, unknown>>;
  readonly decision_payload_hash: string;
  readonly narrative: string;
  readonly task_id?: string;
  readonly proposer: string;
  readonly proposed_at: string;
}

export interface SigningOptions {
  readonly signerdHome: string;
  readonly now?: () => Date;
}

const FIXED_PAYLOAD_KEYS = new Set([
  'decision_kind',
  'subject',
  'value',
  'proposition',
  'evidence',
  'difference',
  'consequence',
  'claim_ids',
  'as_of_frontier',
]);

function decisionContent(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!FIXED_PAYLOAD_KEYS.has(key)) content[key] = value;
  }
  return content;
}

function computeDecisionHash(content: Readonly<Record<string, unknown>>): string {
  return `sha256:${sha256Hex(canonicalJson(content))}`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : {};
}

export class SigningService {
  readonly signerdHome: string;
  private readonly now: () => Date;
  private readonly store: SignerdStore;
  private readonly paths: ReturnType<typeof signerdPaths>;
  private client: SignerdClient;
  private process: SignerdProcessHandle | undefined;

  constructor(options: SigningOptions) {
    this.signerdHome = options.signerdHome;
    this.now = options.now ?? (() => new Date());
    this.paths = signerdPaths({
      homeDir: options.signerdHome,
      socketPath: join(options.signerdHome, 'runtime', 'signerd.sock'),
    });
    this.store = new SignerdStore(this.paths, { windowTtlMinutes: 0, now: this.now });
    this.client = new SignerdClient({ paths: this.paths });
  }

  isInitialized(): boolean {
    return this.store.isInitialized();
  }

  keyId(): string | undefined {
    if (!this.store.isInitialized()) return undefined;
    try {
      return this.store.keyId;
    } catch {
      return undefined;
    }
  }

  async initialize(passphrase: string): Promise<{ ok: boolean; reason_code?: string; key_id?: string }> {
    if (this.store.isInitialized()) return { ok: false, reason_code: CODE.invalid_field, key_id: this.keyId() };
    if (passphrase.length < 12) return { ok: false, reason_code: CODE.invalid_field };
    try {
      const created = await initializeSignerd({ passphrase, homeDir: this.signerdHome, now: this.now });
      return { ok: true, key_id: created.key_id };
    } catch (error) {
      return { ok: false, reason_code: CODE.runtime_inconsistent, ...( { message: String(error) } as object) };
    }
  }

  /** agent 写 request_sign ACK（只记录，不签名）。 */
  propose(db: SdoDatabase, agent: { readonly actor: string; readonly actor_kind: 'agent' }, input: ProposalInput): ProposalResult {
    const frontier = chainHead(db);
    const request: DecisionRequest = {
      decision_kind: input.decision_kind,
      subject: input.subject,
      value: input.value,
      evidence: input.evidence,
      difference: input.difference,
      consequence: input.consequence,
      ...(input.extra === undefined ? {} : { extra: input.extra }),
      ...(input.claim_ids === undefined ? {} : { claim_ids: input.claim_ids }),
      actor: agent.actor,
      actor_kind: 'agent',
      producer: 'sdo-plugin',
      channel: 'ui',
      frontier,
    };
    const prepared = prepareDecision(request);
    if (!('payload' in prepared)) {
      return { ok: false, reason_code: prepared.reason_code, message: prepared.message };
    }
    const content = decisionContent(prepared.payload);
    const payload: ProposalPayload = {
      decision_kind: input.decision_kind,
      subject: input.subject,
      value: input.value,
      proposition: prepared.proposition,
      evidence: [...input.evidence],
      difference: input.difference,
      consequence: input.consequence,
      ...(input.extra === undefined ? {} : { extra: input.extra }),
      ...(input.claim_ids === undefined ? {} : { claim_ids: [...input.claim_ids] }),
      decision_payload: content,
      decision_payload_hash: computeDecisionHash(content),
      narrative: input.narrative ?? '',
      ...(input.task_id === undefined ? {} : { task_id: input.task_id }),
      proposer: agent.actor,
      proposed_at: this.now().toISOString(),
    };
    const event: Event = buildEvent(
      {
        id: `proposal-${randomUUID()}`,
        at: payload.proposed_at,
        actor: agent.actor,
        kind: 'request_sign',
        subject: input.subject,
        payload: payload as unknown as Record<string, unknown>,
        caused_by: [],
        request_id: `proposal:${input.subject}:${String(this.now().getTime())}`,
      },
      frontier,
    );
    const result = append(db, [event], {
      session: { actor: agent.actor, actor_kind: 'agent' },
    });
    if (!result.ok) return { ok: false, reason_code: result.reason_code, message: result.message };
    return { ok: true, proposal_id: event.id, summary: this.summarize(db, event.id) };
  }

  listProposals(db: SdoDatabase): ProposalSummary[] {
    return readEvents(db, [])
      .filter((event) => event.kind === 'request_sign')
      .map((event) => this.summarize(db, event.id))
      .filter((summary): summary is ProposalSummary => summary !== undefined);
  }

  summarize(db: SdoDatabase, proposalId: string): ProposalSummary | undefined {
    const event = readEvents(db, []).find((candidate) => candidate.id === proposalId && candidate.kind === 'request_sign');
    if (event === undefined) return undefined;
    let payload: ProposalPayload;
    try {
      payload = event.payload as unknown as ProposalPayload;
    } catch {
      return undefined;
    }
    const contentHash = computeDecisionHash(payload.decision_payload);
    if (contentHash !== payload.decision_payload_hash) {
      return {
        id: event.id,
        decision_kind: String(payload.decision_kind ?? 'unknown'),
        subject: String(payload.subject ?? ''),
        value: String(payload.value ?? ''),
        proposition: '【payload hash 不匹配，拒绝签名】',
        payload_hash_prefix: 'MISMATCH',
        claims: [],
        narrative: String(payload.narrative ?? ''),
        narrative_mismatch: true,
      };
    }
    const claims = (payload.claim_ids ?? []).map((id) => {
      const row = db.prepare('SELECT predicate, value FROM claim WHERE id = ?').get(id) as
        | { predicate: string; value: string }
        | undefined;
      return row === undefined
        ? { id, title: '（claim 不存在）', status: 'missing' }
        : { id, title: `${row.predicate}=${row.value}`, status: 'active' };
    });
    const narrative = payload.narrative;
    const narrativeMismatch = narrative.length > 0
      && narrative.includes(payload.subject)
      && (narrative.includes('定为') && !narrative.includes(payload.value));
    return {
      id: event.id,
      decision_kind: payload.decision_kind,
      subject: payload.subject,
      value: payload.value,
      proposition: payload.proposition,
      payload_hash_prefix: payload.decision_payload_hash.slice(7, 15),
      claims,
      narrative,
      narrative_mismatch: narrativeMismatch,
    };
  }

  /** 页面确认后调用：账号口令已换取会话，再要求 signerd 解锁串（第二道人证）。 */
  async sign(
    db: SdoDatabase,
    proposalId: string,
    account: { readonly actor_id: string; readonly key_id?: string },
    unlockPassphrase: string,
  ): Promise<{ ok: boolean; reason_code?: string; message?: string; outcome?: SignOutcome }> {
    const summary = this.summarize(db, proposalId);
    if (summary === undefined) return { ok: false, reason_code: CODE.invalid_field, message: '提案不存在' };
    if (summary.narrative_mismatch || summary.payload_hash_prefix === 'MISMATCH') {
      return { ok: false, reason_code: CODE.payload_mismatch, message: '提案叙述/载荷不一致，拒绝签名' };
    }
    const event = readEvents(db, []).find((candidate) => candidate.id === proposalId && candidate.kind === 'request_sign');
    if (event === undefined) return { ok: false, reason_code: CODE.invalid_field };
    const payload = event.payload as unknown as ProposalPayload;
    const currentHead = chainHead(db);
    if (currentHead !== event.hash) {
      return { ok: false, reason_code: CODE.frontier_stale, message: '提案后有新事件，请重新确认' };
    }
    const keyId = this.keyId();
    if (keyId === undefined) return { ok: false, reason_code: CODE.store_not_initialized, message: '尚未初始化签名密钥' };
    if (account.key_id !== keyId) {
      return { ok: false, reason_code: CODE.no_permission, message: '账号指纹与 signerd 密钥不匹配' };
    }
    let started: SignerdProcessHandle | undefined;
    try {
      started = await startSignerdProcess({
        home: this.signerdHome,
        passphrase: unlockPassphrase,
        socketPath: this.paths.socket,
        timeoutMs: 5000,
        windowTtlMinutes: 0,
      });
      this.process = started;
      const unlocked = await this.client.unlock({
        actor: account.actor_id,
        actor_kind: 'human',
        passphrase: unlockPassphrase,
        frontier: currentHead,
      });
      if (unlocked.ok !== true) {
        return { ok: false, reason_code: unlocked.reason_code ?? 'unlock_failed', message: unlocked.message };
      }
      if (chainHead(db) !== currentHead) {
        return { ok: false, reason_code: CODE.frontier_stale, message: '解锁期间有新事件，请重新确认' };
      }
      const request: DecisionRequest = {
        decision_kind: payload.decision_kind as DecisionRequest['decision_kind'],
        subject: payload.subject,
        value: payload.value,
        evidence: payload.evidence,
        difference: payload.difference,
        consequence: payload.consequence,
        ...(payload.extra === undefined ? {} : { extra: payload.extra }),
        ...(payload.claim_ids === undefined ? {} : { claim_ids: payload.claim_ids }),
        proposition: payload.proposition,
        actor: account.actor_id,
        actor_kind: 'human',
        producer: 'sdo-plugin',
        channel: 'ui',
        frontier: currentHead,
      };
      const result = await signDecision(db, this.client, { ...request, now: this.now() });
      if (result.ok !== true) return { ok: false, reason_code: result.reason_code, message: result.message };
      if (result.signer !== account.actor_id) {
        return { ok: false, reason_code: CODE.runtime_inconsistent, message: `signer ${result.signer} != 页面账号 ${account.actor_id}` };
      }
      const valid = readEvents(db, []).find((candidate) => candidate.kind === 'decision.valid' && candidate.subject === result.decision_id);
      const signedContent = valid === undefined ? undefined : asRecord(asRecord(valid.payload)['payload']);
      if (signedContent === undefined || computeDecisionHash(decisionContent(signedContent)) !== payload.decision_payload_hash) {
        return { ok: false, reason_code: CODE.runtime_inconsistent, message: '签发内容与确认内容不一致' };
      }
      return { ok: true, outcome: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'signerd_already_running') {
        return { ok: false, reason_code: CODE.signerd_already_running, message };
      }
      return { ok: false, reason_code: CODE.runtime_inconsistent, message };
    } finally {
      if (started !== undefined) {
        await started.stop().catch(() => false);
        this.process = undefined;
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.process !== undefined) {
      await this.process.stop().catch(() => false);
      this.process = undefined;
    }
  }
}
