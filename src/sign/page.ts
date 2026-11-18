import { CODE } from '../core/errors/codes.js';
/**
 * M2-6 签字页的服务端状态机（C1–C6、C8；docs/05 签字交互、docs/06 §5/§6/§7）。
 *
 * 页面只做两件事：把 renderer 渲染的待签项呈给人看；把人点的那一下变成一次签发。
 * 所有安全判断在这里（服务端），HTML 只是视图：
 *   · 命题 = claim 渲染器结果（C1）；提交的命题与复算不一致 ⇒ `no_blind_sign`；
 *   · 两段式：先 createRequest 得 `payload_hash`/`proposition`，confirm 必须回传二者（C2）；
 *     服务端重算 hash，任何字段变化 ⇒ `payload_changed`，要求重新预览；
 *   · 交互次数按服务端可观测的 POST 计（Lead 定死 A2）：TTL=0 每条 = 解锁 + 确认 = 2；
 *     TTL>0 窗口内连签第 2 条起只有确认 = 1；
 *   · 时长取 signerd 回执（Lead 定死 A3）：`sign_ms`/`signerd_unlock_wait_ms` 原样透出；
 *     页面侧 `page_unlock_wait_ms` 在复用窗口时为 0（本次没有等解锁），`page_total_ms` 只展示；
 *   · 免密窗口语义按 D-060（TTL=0 单次 / TTL>0 连签）；frontier 一变即进入 `awaiting_unlock`（C5）；
 *   · 批量签捷径不存在：一次 confirm 只接受一个 request_id，出现 `all`/`request_ids` ⇒ 拒（C8）。
 */
import { randomUUID } from 'node:crypto';

import type { SdoDatabase } from '../db/driver.js';
import type { SignerdClient } from './client.js';
import type { ActorKind } from './protocol.js';
import type { SignChannel } from './receipt.js';
import type { SignFailure } from './errors.js';
import { fail } from './errors.js';
import {
  DECISION_KINDS,
  discardStagedSignatures,
  prepareDecision,
  stageDecision,
  submitStagedBatch,
  unlockSigner,
  type DecisionKind,
  type SignOutcome,
  type StagedSignature,
  type UnlockOutcome,
} from './decision.js';
import { chainHead } from '../db/write.js';
import { resolveClaimDecision } from './proposition.js';

export interface SigningDraft {
  readonly decision_kind: DecisionKind;
  /** claim 渲染器的输入集合；调用方只能选集合（C1）。 */
  readonly claim_ids: readonly string[];
  readonly difference: string;
  readonly consequence: string;
  readonly actor: string;
  readonly producer: string;
  readonly channel?: SignChannel;
  /** baseline 等变更的展示用影响面（也进 payload，签字覆盖它）。 */
  readonly will_change?: readonly string[];
  /** baseline 冻结的保证变化（1/2/3 ⇒ kept/degraded），机械来源，手填忽略。 */
  readonly guarantee_delta?: Readonly<Record<string, string>>;
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface PendingSigningItem {
  readonly id: string;
  readonly created_at: string;
  readonly draft: SigningDraft;
  readonly subject: string;
  readonly value: string;
  readonly evidence: readonly string[];
  readonly difference: string;
  readonly consequence: string;
  readonly proposition: string;
  readonly proposition_hash: string;
  readonly payload_hash: string;
  readonly will_change: readonly string[];
  readonly guarantee_delta: Readonly<Record<string, string>> | null;
  readonly frontier: string;
}

export interface PublicPendingItem {
  readonly id: string;
  readonly created_at: string;
  readonly decision_kind: DecisionKind;
  readonly subject: string;
  readonly value: string;
  readonly proposition: string;
  readonly proposition_hash: string;
  readonly payload_hash: string;
  readonly evidence: readonly string[];
  readonly difference: string;
  readonly consequence: string;
  readonly will_change: readonly string[];
  readonly guarantee_delta: Readonly<Record<string, string>> | null;
  readonly frontier: string;
  readonly stale: boolean;
}

export interface SigningCostEntry {
  readonly decision_id: string;
  /** 待签项 id（本会话内存态），用于把成本行与实际签名顺序对上。 */
  readonly request_id: string;
  /** 实际签名序号（进程内单调递增；归因与排序按它，不按 created_at）。 */
  readonly sign_seq: number;
  readonly signer: string;
  readonly channel: SignChannel;
  readonly at: string;
  readonly receipt_id: string;
  /** signerd 回执：本次签发实际等人解锁的时长（同一窗口第 2 条起为 0）。 */
  readonly signerd_unlock_wait_ms: number;
  /** signerd 回执：距上次解锁的时长（窗口复用 >0；与上一字段不是同一量）。 */
  readonly signerd_since_last_unlock_ms: number;
  /** signerd 回执：签发开始→签名完成。 */
  readonly sign_ms: number;
  /** 页面口径：这一次签发等待解锁的时间；窗口复用（TTL>0 连签）时为 0。 */
  readonly page_unlock_wait_ms: number;
  /** 页面口径：创建待签项→decision 落库（含人思考时间，仅展示，不参与 M2-G 读数）。 */
  readonly page_total_ms: number;
  /** 这一次签发需要的人工 POST 数（C3；服务端可观测）。 */
  readonly interactions: number;
  /** 是否复用了未过期的免密窗口（TTL>0）。 */
  readonly window_reused: boolean;
}

export interface ConfirmationResult {
  readonly ok: true;
  /** true = 本批还有人没确认，签名已暂存（未落库）；false = 本批已整批提交。 */
  readonly staged: boolean;
  readonly decision?: SignOutcome;
  readonly cost?: SigningCostEntry;
  readonly interactions: number;
  readonly pending_count: number;
}

export interface SigningPageStatus {
  readonly frontier: string;
  readonly locked: boolean;
  readonly window_until: string | null;
  readonly ttl_minutes: number;
  readonly awaiting_unlock: boolean;
  readonly pending_count: number;
  readonly stale_count: number;
  /** P2-1：TTL=0 下请求了多条，需开免密窗口（TTL>0）才能继续。 */
  readonly needs_window: boolean;
}

/** C6：每个失败码都必须给出“下一步”，不能只丢一句“出错了”。 */
export interface FailureGuidance {
  readonly title: string;
  readonly next: string;
}

export const SIGN_FAILURE_GUIDANCE: Readonly<Record<string, FailureGuidance>> = {
  awaiting_unlock: { title: '签名器已锁定', next: '输入签章口令解锁，然后确认待签项' },
  not_a_signer: {
    title: '当前身份不能签字',
    next: '确认使用人类账户签字；agent 不能代签（no_proxy_sign）',
  },
  no_blind_sign: {
    title: '命题与服务端渲染不一致，拒绝签发',
    next: '刷新待签列表，重新核对该项后再确认；不要直接改页面上的命题',
  },
  payload_changed: {
    title: '签字内容已变化，hash 失效',
    next: '重新预览并生成新的待签项，旧项作废',
  },
  ttl_requires_window: {
    title: '这次解锁只能签一条',
    next: '要多条一起签请开免密窗口（TTL>0）后重新解锁；本页不会替你自动开窗',
  },
  frontier_stale: {
    title: '尺子变了（frontier 已推进）',
    next: '重新解锁后重试；窗口内 frontier 变了不允许连签',
  },
  bad_passphrase: { title: '签章口令错误', next: '重试输入口令；连续失败会触发限速' },
  rate_limited: { title: '口令失败次数过多', next: '等待限速窗口结束后再解锁' },
  locked: { title: '签名器已锁定', next: '先解锁' },
  invalid_request: { title: '请求不完整或被拒绝', next: '刷新页面后重试' },
  unknown_request: { title: '请求无法识别', next: '刷新页面后重试' },
  runtime_inconsistent: {
    title: '已落盘但提交后链头变化，需要人工核对',
    next: '不要重复签发；把页面上的 decision id 交给人工核对',
  },
};

export function failureGuidance(reasonCode: string): FailureGuidance {
  const known = SIGN_FAILURE_GUIDANCE[reasonCode];
  if (known !== undefined) return known;
  return { title: '签发失败', next: '刷新页面后重试；若持续失败请报告缺失状态' };
}

/** 会话态待签列表：刷新即重算、不落库、不造“半签行”（docs/05）。 */
export class SigningSession {
  private readonly items = new Map<string, PendingSigningItem>();

  add(item: PendingSigningItem): void {
    this.items.set(item.id, item);
  }

  get(id: string): PendingSigningItem | undefined {
    return this.items.get(id);
  }

  remove(id: string): void {
    this.items.delete(id);
  }

  clear(): void {
    this.items.clear();
  }

  all(): readonly PendingSigningItem[] {
    return [...this.items.values()].sort((left, right) => {
      const at = left.created_at < right.created_at ? -1 : left.created_at > right.created_at ? 1 : 0;
      if (at !== 0) return at;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  }
}

export interface SigningPageOptions {
  readonly db: SdoDatabase;
  readonly client: SignerdClient;
  readonly session?: SigningSession;
  readonly now?: () => Date;
  /** 页面按通道记 'ui'；CLI/测试可覆盖。 */
  readonly channel?: SignChannel;
}

const GUARANTEE_KEYS = ['1', '2', '3'] as const;

function isGuaranteeDeltaShape(value: unknown): value is Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return GUARANTEE_KEYS.every((key) => {
    const status = record[key];
    return status === 'kept' || status === 'degraded';
  });
}

/**
 * 签字页服务。一个进程内一个实例（本地单用户）；待签项只在会话内存里。
 */
export class SigningPageService {
  private readonly db: SdoDatabase;
  private readonly client: SignerdClient;
  private readonly session: SigningSession;
  private readonly now: () => Date;
  private readonly channel: SignChannel;
  private readonly costsList: SigningCostEntry[] = [];
  /** D-060 会话式批量：已签名但未落库的暂存（确认期间链头必须是 sessionFrontier）。 */
  private readonly staged = new Map<string, { readonly signature: StagedSignature; readonly sign_seq: number }>();
  /** 实际签名序号（进程内单调；成本归因按它，不按 created_at / 会话顺序）。 */
  private nextSignSeq = 0;
  /** 本会话预览时的 frontier f0；确认期间不 append，提交时整批一次落库。 */
  private sessionFrontier: string | undefined;
  /** 自上次成功签发以来，人提交过几次解锁（用于 C3 交互计数）。 */
  private unlocksSinceLastConfirm = 0;
  /** 最近一次成功解锁的人（确认时作为签字人；页面不让人填签字人）。 */
  private lastHumanActor: string | undefined;
  /** 最近一次解锁的 TTL；TTL=0 时本会话最多一条（P2-1）。 */
  private windowTtlMinutes = 0;
  /** P2-1：TTL=0 下出现多条请求后进入 needs_window，直到重新解锁/放弃。 */
  private needsWindow = false;

  constructor(options: SigningPageOptions) {
    this.db = options.db;
    this.client = options.client;
    this.session = options.session ?? new SigningSession();
    this.now = options.now ?? (() => new Date());
    this.channel = options.channel ?? 'ui';
  }

  publicPending(): readonly PublicPendingItem[] {
    const frontier = chainHead(this.db);
    return this.session.all().map((item) => this.toPublic(item, frontier));
  }

  private toPublic(item: PendingSigningItem, frontier: string): PublicPendingItem {
    return {
      id: item.id,
      created_at: item.created_at,
      decision_kind: item.draft.decision_kind,
      subject: item.subject,
      value: item.value,
      proposition: item.proposition,
      proposition_hash: item.proposition_hash,
      payload_hash: item.payload_hash,
      evidence: item.evidence,
      difference: item.difference,
      consequence: item.consequence,
      will_change: item.will_change,
      guarantee_delta: item.guarantee_delta,
      frontier: item.frontier,
      stale: item.frontier !== frontier,
    };
  }

  /**
   * 第一段：登记一条待签项，返回人需要看到的四元组与 `payload_hash`。
   * 这里就做一次完整渲染 + hash：页面后面提交的必须与它一致（C2）。
   */
  async createRequest(draft: SigningDraft): Promise<{ ok: true; item: PublicPendingItem } | SignFailure> {
    if (typeof draft.claim_ids !== 'object' || !Array.isArray(draft.claim_ids) || draft.claim_ids.length === 0) {
      return fail(CODE.invalid_request, '待签项必须带非空 claim_ids');
    }
    const decisionKind = draft.decision_kind;
    if (!(DECISION_KINDS as readonly string[]).includes(decisionKind)) {
      return fail(CODE.invalid_request, `未知 decision_kind：${String(decisionKind)}`);
    }
    // P2-1：TTL=0 已解锁的会话里不允许再增加待签项（多条目需要 TTL>0 的免密窗口）。
    if (this.unlocksSinceLastConfirm > 0 && this.windowTtlMinutes === 0 && this.session.all().length >= 1) {
      this.needsWindow = true;
      return fail(CODE.ttl_requires_window,
        `TTL=0 时一次解锁只授权一条；本次会话已有 ${this.session.all().length} 条，请开免密窗口（TTL>0）后重新解锁`,
        { staged: this.staged.size, requested: this.session.all().length + 1 },
      );
    }
    const resolved = resolveClaimDecision(this.db, {
      claim_ids: draft.claim_ids,
      difference: draft.difference,
      consequence: draft.consequence,
    });
    if (!resolved.ok) {
      return fail(CODE.no_blind_sign, `命题渲染失败（${resolved.reason_code}）：${resolved.message}`);
    }
    const willChange = [...(draft.will_change ?? [])];
    const guaranteeDelta = draft.guarantee_delta ?? null;
    if (decisionKind === 'baseline') {
      // docs/06 §5：没有 guarantee_delta 的 baseline 签名不可签发；影响面也必须展示。
      if (!isGuaranteeDeltaShape(guaranteeDelta)) {
        return fail(CODE.no_blind_sign, 'baseline 冻结缺少 guarantee_delta（1/2/3 的 kept/degraded）');
      }
      if (willChange.length === 0) {
        return fail(CODE.no_blind_sign, 'baseline 冻结缺少 will_change（这一签会改什么）');
      }
    }
    const frontier = chainHead(this.db);
    if (this.sessionFrontier !== undefined && this.sessionFrontier !== frontier) {
      return fail(CODE.invalid_request, '链头已推进：请先提交或放弃当前会话，再重新预览');
    }
    const at = this.now().toISOString();
    const extra: Record<string, unknown> = { ...(draft.extra ?? {}) };
    if (decisionKind === 'baseline') {
      extra['will_change'] = willChange;
      extra['guarantee_delta'] = { ...guaranteeDelta };
    }
    const prepared = prepareDecision(
      {
        decision_kind: decisionKind,
        subject: resolved.resolved.subject,
        value: resolved.resolved.value,
        evidence: resolved.resolved.evidence,
        difference: resolved.resolved.difference,
        consequence: resolved.resolved.consequence,
        proposition: resolved.resolved.proposition,
        claim_ids: resolved.resolved.claim_ids,
        actor: draft.actor,
        actor_kind: 'human',
        producer: draft.producer,
        channel: draft.channel ?? this.channel,
        frontier,
        extra,
      },
      { proposition: resolved.resolved.proposition, claimIds: resolved.resolved.claim_ids },
    );
    if ('reason_code' in prepared) return prepared;
    const item: PendingSigningItem = {
      id: `sign-${randomUUID()}`,
      created_at: at,
      draft: { ...draft, channel: draft.channel ?? this.channel },
      subject: resolved.resolved.subject,
      value: resolved.resolved.value,
      evidence: resolved.resolved.evidence,
      difference: resolved.resolved.difference,
      consequence: resolved.resolved.consequence,
      proposition: resolved.resolved.proposition,
      proposition_hash: prepared.proposition_hash,
      payload_hash: prepared.payload_hash,
      will_change: willChange,
      guarantee_delta: guaranteeDelta,
      frontier,
    };
    this.session.add(item);
    if (this.sessionFrontier === undefined) this.sessionFrontier = frontier;
    return { ok: true, item: this.toPublic(item, frontier) };
  }

  /** 第二段（可先解锁）：解锁 signerd；agent 解锁同样被拒并留痕（委托 decision.ts）。 */
  async unlock(input: {
    actor: string;
    passphrase: string;
    actor_kind?: ActorKind;
  }): Promise<UnlockOutcome | SignFailure> {
    const frontier = chainHead(this.db);
    const outcome = await unlockSigner(this.db, this.client, {
      actor: input.actor,
      actor_kind: input.actor_kind ?? 'human',
      passphrase: input.passphrase,
      frontier,
      now: this.now(),
    });
    if (outcome.ok) {
      this.unlocksSinceLastConfirm += 1;
      this.lastHumanActor = input.actor;
      this.windowTtlMinutes = outcome.ttl_minutes;
      if (outcome.ttl_minutes > 0) this.needsWindow = false;
    }
    return outcome;
  }

  /**
   * 第二段确认：只接受一个 request_id（C8）。服务端复算命题与 payload_hash 后，
   * 只调用 signerd 签名并把签名暂存在会话里（不 append）；整批确认完后再用
   * submitStagedBatch 一次落库（D-060 会话式批量：确认期间链头必须保持解锁时的 f0）。
   */
  async confirm(input: {
    requestId: string;
    actor: string;
    proposition: string;
    payloadHash: string;
    actorKind?: ActorKind;
  }): Promise<ConfirmationResult | SignFailure> {
    const item = this.session.get(input.requestId);
    if (item === undefined) {
      return fail(CODE.invalid_request, '待签项不存在（刷新后需重新预览）');
    }
    const actor = input.actor.trim().length > 0 ? input.actor : (this.lastHumanActor ?? '');
    if (actor.length === 0) {
      return fail(CODE.awaiting_unlock, '还没有签字人：先解锁签名器');
    }
    // P2-1：TTL=0 的一次性授权只能签一条。守卫放在 createRequest 与 confirm 两处：
    // 预览可以先把多条登记出来（此时还没解锁、TTL 未知），但确认时必须拒。
    if (this.unlocksSinceLastConfirm > 0 && this.windowTtlMinutes === 0) {
      if (this.session.all().length > 1) {
        this.needsWindow = true;
        return fail(CODE.ttl_requires_window,
          `TTL=0 时一次解锁只授权一条；本批 ${this.session.all().length} 条需要开免密窗口（TTL>0）后重新解锁`,
          { staged: this.staged.size, requested: this.session.all().length },
        );
      }
      if (this.staged.size >= 1) {
        this.needsWindow = true;
        return fail(CODE.ttl_requires_window,
          'TTL=0 时一次解锁只授权一条：本会话已经签过一条，再进行第二条需要重开免密窗口（TTL>0）',
          { staged: this.staged.size, requested: this.session.all().length },
        );
      }
    }
    const currentHead = chainHead(this.db);
    if (item.frontier !== currentHead) {
      // C5：要求重新解锁——不只拒绝本次签发，还把 signerd 回 locked（TTL>0 也一样）。
      // 已暂存的签名回执全部 consumed:false 清理；本批不 append 任何事件。
      const lockActor = input.actor.trim().length > 0 ? input.actor : (this.lastHumanActor ?? item.draft.actor);
      await this.client.lock(lockActor).catch(() => undefined);
      this.discardStaged();
      return fail(CODE.frontier_stale, 'frontier 已推进：待签项过期，请重新解锁并重新预览');
    }
    const resolved = resolveClaimDecision(this.db, {
      claim_ids: item.draft.claim_ids,
      difference: item.draft.difference,
      consequence: item.draft.consequence,
    });
    if (!resolved.ok) {
      return fail(CODE.no_blind_sign, `命题渲染失败（${resolved.reason_code}）：${resolved.message}`);
    }
    if (input.proposition !== resolved.resolved.proposition) {
      return fail(CODE.no_blind_sign, '提交的命题与 claim 渲染器结果不一致');
    }
    const extra: Record<string, unknown> = { ...(item.draft.extra ?? {}) };
    if (item.guarantee_delta !== null) {
      extra['will_change'] = [...item.will_change];
      extra['guarantee_delta'] = { ...item.guarantee_delta };
    }
    const recomputed = prepareDecision(
      {
        decision_kind: item.draft.decision_kind,
        subject: resolved.resolved.subject,
        value: resolved.resolved.value,
        evidence: resolved.resolved.evidence,
        difference: resolved.resolved.difference,
        consequence: resolved.resolved.consequence,
        proposition: resolved.resolved.proposition,
        claim_ids: resolved.resolved.claim_ids,
        actor,
        actor_kind: input.actorKind ?? 'human',
        producer: item.draft.producer,
        channel: item.draft.channel ?? this.channel,
        frontier: item.frontier,
        extra,
      },
      { proposition: resolved.resolved.proposition, claimIds: resolved.resolved.claim_ids },
    );
    if ('reason_code' in recomputed) return recomputed;
    if (recomputed.payload_hash !== item.payload_hash) {
      return fail(CODE.payload_changed, '签字内容与预览时不一致（payload_hash 变了），请重新预览');
    }
    if (input.payloadHash !== item.payload_hash) {
      return fail(CODE.payload_changed, '提交的 payload_hash 与待签项不一致，请重新预览');
    }

    const stagedResult = await stageDecision(this.db, this.client, {
      decision_kind: item.draft.decision_kind,
      subject: item.subject,
      value: item.value,
      evidence: item.evidence,
      difference: item.difference,
      consequence: item.consequence,
      proposition: item.proposition,
      claim_ids: item.draft.claim_ids,
      extra,
      actor,
      actor_kind: input.actorKind ?? 'human',
      producer: item.draft.producer,
      channel: item.draft.channel ?? this.channel,
      frontier: item.frontier,
      now: this.now(),
    });
    if (!stagedResult.ok) {
      if (stagedResult.reason_code === CODE.frontier_stale) {
        this.discardStaged();
      }
      return stagedResult;
    }
    const signSeq = this.nextSignSeq++;
    this.staged.set(item.id, { signature: stagedResult.staged, sign_seq: signSeq });
    const stagedInteractions = this.stagedInteractions(signSeq);
    const pending = this.session.all().filter((entry) => !this.staged.has(entry.id));
    if (pending.length > 0) {
      return { ok: true, staged: true, interactions: stagedInteractions, pending_count: pending.length };
    }
    if (this.session.all().length > 1) {
      // 批量：最后一条确认完也等人点“提交这批”（D-060）；提交本身不再算一次签字交互。
      return { ok: true, staged: true, interactions: stagedInteractions, pending_count: 0 };
    }
    const submitted = this.submitStagedBatchOrFail();
    if (!submitted.ok) return submitted;
    const cost = submitted.costs.get(item.id);
    const decision = submitted.decisions.get(item.id);
    return {
      ok: true,
      staged: false,
      decision,
      cost,
      interactions: cost?.interactions ?? 1,
      pending_count: 0,
    };
  }

  /** 人点“提交这批”：整批已确认才允许；落库一次完成（N=1 时 confirm 已自动提交）。 */
  async submit(): Promise<ConfirmationResult | SignFailure> {
    const items = this.session.all();
    if (items.length === 0) return fail(CODE.invalid_request, '没有待签项可提交');
    if (this.staged.size !== items.length) {
      return fail(CODE.invalid_request, '还有待签项没有确认；批量签名必须逐条确认后再提交');
    }
    const submitted = this.submitStagedBatchOrFail();
    if (!submitted.ok) return submitted;
    // 成本表按 sign_seq 升序；首条=本次解锁后真正签下的那条（可能不是创建最早的那条）。
    const first = [...submitted.costs.values()].sort((a, b) => a.sign_seq - b.sign_seq)[0];
    return {
      ok: true,
      staged: false,
      decision: first === undefined ? undefined : submitted.decisions.get(first.request_id),
      cost: first,
      interactions: first?.interactions ?? 1,
      pending_count: 0,
    };
  }

  /**
   * 成本/返回值共用口径：本次解锁后第一条真正签下的条目贵在“解锁 POST + 本次确认 POST”，
   * 即 interactions = 本次解锁次数 + 1；后续条目只算 1 次确认。按 sign_seq 判定，不按创建顺序。
   */
  private stagedInteractions(signSeq: number): number {
    const firstSignSeq = Math.min(...[...this.staged.values()].map((entry) => entry.sign_seq));
    return signSeq === firstSignSeq ? this.unlocksSinceLastConfirm + 1 : 1;
  }

  /** D-060：整批确认完后一次落库；失败 ⇒ 回执全部 consumed:false、0 条 decision。 */
  private submitStagedBatchOrFail():
    | {
        ok: true;
        decisions: ReadonlyMap<string, SignOutcome>;
        costs: ReadonlyMap<string, SigningCostEntry>;
      }
    | SignFailure {
    const items = this.session.all();
    // P2（第 2 轮）：按**实际签名顺序**（sign_seq）提交与归因；created_at 只影响展示排序，
    // 同毫秒创建时它无法区分谁先签。submitStagedBatch 的 decision_ids 与 staged 一一对应。
    const ordered = items
      .map((item) => {
        const entry = this.staged.get(item.id);
        return entry === undefined ? undefined : { item, entry };
      })
      .filter((value): value is { item: (typeof items)[number]; entry: { signature: StagedSignature; sign_seq: number } } =>
        value !== undefined,
      )
      .sort((left, right) => left.entry.sign_seq - right.entry.sign_seq);
    if (ordered.length !== items.length) return fail(CODE.invalid_request, '还有待签项没有确认');
    const staged = ordered.map((value) => value.entry.signature);
    const frontier = items[0]?.frontier ?? chainHead(this.db);
    const submitted = submitStagedBatch(this.db, staged, frontier);
    if (!submitted.ok) {
      this.discardStagedAndClear();
      return submitted;
    }
    const nowMs = this.now().getTime();
    const decisions = new Map<string, SignOutcome>();
    const costs = new Map<string, SigningCostEntry>();
    const firstSignSeq = ordered[0]!.entry.sign_seq;
    ordered.forEach((value, index) => {
      const { item, entry } = value;
      const signature = entry.signature;
      const decisionId = submitted.decision_ids[index]!;
      // 归因只给“解锁后真正签下的第一条”；回执里的 unlock/since/sign 三个数逐条取真值。
      const first = entry.sign_seq === firstSignSeq;
      const cost: SigningCostEntry = {
        decision_id: decisionId,
        request_id: item.id,
        sign_seq: entry.sign_seq,
        signer: signature.signer,
        channel: signature.channel,
        at: this.now().toISOString(),
        receipt_id: signature.receipt_id,
        signerd_unlock_wait_ms: signature.unlock_wait_ms,
        signerd_since_last_unlock_ms: signature.since_last_unlock_ms ?? 0,
        sign_ms: signature.sign_ms,
        page_unlock_wait_ms: first ? signature.unlock_wait_ms : 0,
        page_total_ms: Number.isFinite(Date.parse(item.created_at))
          ? Math.max(0, nowMs - Date.parse(item.created_at))
          : 0,
        interactions: first ? this.unlocksSinceLastConfirm + 1 : 1,
        window_reused: !first,
      };
      costs.set(item.id, cost);
      decisions.set(item.id, {
        ok: true,
        decision_id: decisionId,
        signature: signature.signature,
        key_id: signature.key_id,
        channel: signature.channel,
        signer: signature.signer,
        frontier,
        receipt_id: signature.receipt_id,
        unlock_wait_ms: signature.unlock_wait_ms,
        since_last_unlock_ms: signature.since_last_unlock_ms,
        sign_ms: signature.sign_ms,
      });
    });
    this.costsList.push(...costs.values());
    for (const item of items) this.session.remove(item.id);
    this.staged.clear();
    this.sessionFrontier = undefined;
    this.unlocksSinceLastConfirm = 0;
    this.windowTtlMinutes = 0;
    this.needsWindow = false;
    return { ok: true, decisions, costs };
  }

  /** 放弃本批：已签回执全部 consumed:false，不 append；页面回到空会话。 */
  async abandon(): Promise<void> {
    await discardStagedSignatures(this.client, [...this.staged.values()].map((entry) => entry.signature));
    this.staged.clear();
    this.session.clear();
    this.sessionFrontier = undefined;
    this.unlocksSinceLastConfirm = 0;
    this.windowTtlMinutes = 0;
    this.needsWindow = false;
    this.nextSignSeq = 0;
  }

  private discardStaged(): void {
    void discardStagedSignatures(this.client, [...this.staged.values()].map((entry) => entry.signature));
    this.staged.clear();
  }

  private discardStagedAndClear(): void {
    void this.abandon();
  }

  async status(): Promise<SigningPageStatus> {
    const frontier = chainHead(this.db);
    const remote = await this.client.status();
    const locked = remote.ok ? remote.locked : true;
    const windowUntil = remote.ok ? remote.window_until : null;
    const ttlMinutes = remote.ok ? remote.ttl_minutes : 0;
    const items = this.session.all();
    const staleCount = items.filter((item) => item.frontier !== frontier).length;
    return {
      frontier,
      locked,
      window_until: windowUntil,
      ttl_minutes: ttlMinutes,
      awaiting_unlock: items.length > 0 && (locked || staleCount > 0),
      pending_count: items.length,
      stale_count: staleCount,
      needs_window: this.needsWindow,
    };
  }

  costs(): readonly SigningCostEntry[] {
    return [...this.costsList];
  }

  /** 供页面显示：当前会话的待签项 + 失败文案映射。 */
  sessionView(): {
    readonly pending: readonly PublicPendingItem[];
    readonly guidance: Readonly<Record<string, FailureGuidance>>;
  } {
    return { pending: this.publicPending(), guidance: SIGN_FAILURE_GUIDANCE };
  }
}
