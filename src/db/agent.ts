/**
 * M4-7：agent.* 事件写入封装与两条告警的现算。
 *
 * 口径：
 * - C1：落 `agent.spawned` 前按当时的池快照复算 `new_reason`，矛盾 ⇒ `spawn_reason_mismatch`。
 * - C2：`agent.pick_declined` 按一次派发窗口计数；第 2 条起由 `gaps` 视图现算可见。
 * - C3：同一 actor 尾部连续第 3 次新起 ⇒ 同批落 `agent.spawn_streak`（ACK）。
 *
 * 计数/告警只读事件流；仓库没有 agent 表，也不在此新建（卡 M4-7 A2）。
 */
import type { Event } from '../core/fold/types.js';
import type { SdoDatabase } from './driver.js';
import { chainHead, appendAsTool } from './write.js';
import { buildEvent } from './freeze-store.js';
import { readEvents } from '../core/verify-events.js';
import { validateSpawnReason } from '../core/agentpool/spawn-reason.js';
import { AGENT_TOOL_KINDS, agentPayloadHash, createAgentEventAuthority } from './agent-authority.js';
import { reusableCandidates } from '../core/agentpool/snapshot.js';
import { spawnStreakTrigger } from '../core/agentpool/streak.js';
import { dispatchWindow, pickDeclinedInWindow, type WindowEvent } from '../core/agentpool/window.js';
import type { PoolSnapshot, SpawnReason } from '../core/agentpool/types.js';

const AGENT_AUTHORITY = createAgentEventAuthority();

/** 网关用：消费 `src/db/agent.ts` 私有实例铸造的一次性能力（绑事件 id + payload hash）。 */
export function consumeAgentEventAuthority(eventId: string, payloadHash: string): boolean {
  return AGENT_AUTHORITY.consume(eventId, payloadHash);
}

export type AgentActorKind = 'human' | 'agent' | 'service';

export interface AgentSession {
  readonly actor: string;
  readonly actor_kind: AgentActorKind;
}

export type AgentResult =
  | {
      readonly ok: true;
      readonly event_id: string;
      readonly streak?: { readonly count: number; readonly first_at: string; readonly last_at: string };
      readonly streak_event_id?: string;
    }
  | {
      readonly ok: false;
      readonly reason_code: 'invalid_field' | 'spawn_reason_mismatch' | 'append_failed';
      readonly message: string;
      readonly details?: readonly string[];
    };

export interface SpawnInput {
  readonly card: string;
  /** 被派发的 agent actor（payload.actor）；事件 writer 是 session.actor。 */
  readonly actor: string;
  /** lease.issued 的事件 id：一次派发的边界（A1）。 */
  readonly dispatch_id: string;
  readonly new_reason: SpawnReason;
  readonly required_skills?: readonly string[];
  readonly snapshot: PoolSnapshot;
  readonly at: string;
}

export interface ReuseInput {
  readonly card: string;
  readonly actor: string;
  readonly agent_id: string;
  readonly dispatch_id: string;
  readonly at: string;
}

export interface PickDeclinedInput {
  readonly card: string;
  readonly dispatch_id: string;
  readonly reason: string;
  readonly at: string;
}

function payloadOf(event: Event): Record<string, unknown> {
  return typeof event.payload === 'object' && event.payload !== null ? (event.payload as Record<string, unknown>) : {};
}

function toWindowEvents(events: readonly Event[]): WindowEvent[] {
  return events.map((event) => ({
    id: event.id,
    at: event.at,
    actor: event.actor,
    kind: event.kind,
    subject: event.subject,
    payload: payloadOf(event),
  }));
}

function cardScopeFiles(db: SdoDatabase, card: string): readonly string[] | undefined {
  const row = db.prepare('SELECT scope_paths FROM task WHERE id = ?').get(card) as
    | { scope_paths?: unknown }
    | undefined;
  if (row === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(String(row.scope_paths ?? '[]'));
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) return undefined;
    return parsed as string[];
  } catch {
    return undefined;
  }
}

function hasCompactionAttempted(events: readonly Event[], actor: string): boolean {
  return events.some((event) => event.kind === 'agent.compaction_attempted' && event.actor === actor);
}

type InitiatedEvent = Omit<Event, 'prev' | 'hash'>;

function appendEvents(
  db: SdoDatabase,
  session: AgentSession,
  initiated: readonly InitiatedEvent[],
): { ok: true; events: Event[] } | { ok: false; result: AgentResult } {
  const built: Event[] = [];
  const minted: Event[] = [];
  let prev = chainHead(db);
  for (const item of initiated) {
    const event = buildEvent(item, prev);
    built.push(event);
    prev = event.hash;
    if ((AGENT_TOOL_KINDS as readonly string[]).includes(item.kind)) {
      AGENT_AUTHORITY.mint(event.id, agentPayloadHash(event.payload));
      minted.push(event);
    }
  }
  const appended = appendAsTool(db, built, session.actor, session.actor_kind);
  if (!appended.ok) {
    // 能力是一次性的：失败批次必须把已铸造的能力扔掉，别在内存里留孤儿。
    for (const event of minted) AGENT_AUTHORITY.consume(event.id, agentPayloadHash(event.payload));
    return {
      ok: false,
      result: {
        ok: false,
        reason_code: 'append_failed',
        message: appended.message ?? 'append failed',
        ...(appended.reason_code === undefined ? {} : { details: [`reason_code=${appended.reason_code}`] }),
      },
    };
  }
  return { ok: true, events: built };
}

function appendOne(
  db: SdoDatabase,
  session: AgentSession,
  initiated: InitiatedEvent,
): { ok: true; event: Event } | { ok: false; result: AgentResult } {
  const appended = appendEvents(db, session, [initiated]);
  return appended.ok ? { ok: true, event: appended.events[0] as Event } : appended;
}

export function recordAgentSpawn(db: SdoDatabase, session: AgentSession, input: SpawnInput): AgentResult {
  const scopeFiles = cardScopeFiles(db, input.card);
  if (scopeFiles === undefined) {
    return { ok: false, reason_code: 'invalid_field', message: `task ${input.card} not found or scope_paths invalid` };
  }
  const eventsBefore = readEvents(db, []);
  const check = validateSpawnReason({
    new_reason: input.new_reason,
    snapshot: input.snapshot,
    required_skills: input.required_skills ?? [],
    card_scope_files: scopeFiles,
    actor_has_compaction: hasCompactionAttempted(eventsBefore, session.actor),
  });
  if (!check.ok) {
    return {
      ok: false,
      reason_code: check.reason_code,
      message: check.message,
      ...(check.details === undefined ? {} : { details: check.details }),
    };
  }
  const candidates = reusableCandidates(input.snapshot, input.required_skills ?? []).map((candidate) => candidate.agent_id);
  const spawned: InitiatedEvent = {
    id: `agent-spawned-${input.dispatch_id}-${input.at}`,
    at: input.at,
    actor: session.actor,
    kind: 'agent.spawned',
    subject: input.card,
    payload: {
      dispatch_id: input.dispatch_id,
      card: input.card,
      actor: input.actor,
      new_reason: check.reason,
      required_skills: input.required_skills ?? [],
      snapshot: input.snapshot,
      evaluated: { reusable_candidates: candidates, card_scope_files: scopeFiles },
    },
    caused_by: [],
    request_id: `spawn:${input.dispatch_id}:${input.at}`,
  };
  // C3 的告警必须与 spawned 同一批（同一事务、同一条链）：要么都落，要么都不落。
  // 先用“现有事件 + 本次 spawned”预判，避免先 append 再回读。
  const projected: WindowEvent[] = [
    ...toWindowEvents(eventsBefore),
    { id: spawned.id, at: spawned.at, actor: session.actor, kind: 'agent.spawned', subject: input.card, payload: {} },
  ];
  const trigger = spawnStreakTrigger(projected, session.actor);
  const batch: InitiatedEvent[] = [spawned];
  if (trigger !== undefined) {
    batch.push({
      id: `agent-spawn-streak-${session.actor}-${input.dispatch_id}-${input.at}`,
      at: input.at,
      actor: session.actor,
      kind: 'agent.spawn_streak',
      subject: session.actor,
      payload: {
        actor: session.actor,
        count: trigger.count,
        first_at: trigger.first_at,
        last_at: trigger.last_at,
        dispatch_id: input.dispatch_id,
        spawned_event_id: spawned.id,
      },
      caused_by: [spawned.id],
      request_id: `spawn-streak:${session.actor}:${input.at}`,
    });
  }
  const appended = appendEvents(db, session, batch);
  if (!appended.ok) return appended.result;
  const spawnedEvent = appended.events[0] as Event;
  if (trigger === undefined) return { ok: true, event_id: spawnedEvent.id };
  const streakEvent = appended.events[1] as Event;
  return { ok: true, event_id: spawnedEvent.id, streak_event_id: streakEvent.id, streak: trigger };
}

export function recordAgentReused(db: SdoDatabase, session: AgentSession, input: ReuseInput): AgentResult {
  const appended = appendOne(db, session, {
    id: `agent-reused-${input.dispatch_id}-${input.at}`,
    at: input.at,
    actor: session.actor,
    kind: 'agent.reused',
    subject: input.card,
    payload: { dispatch_id: input.dispatch_id, card: input.card, actor: input.actor, agent_id: input.agent_id },
    caused_by: [],
    request_id: `reuse:${input.dispatch_id}:${input.at}`,
  });
  return appended.ok ? { ok: true, event_id: appended.event.id } : appended.result;
}

export function recordAgentPickDeclined(
  db: SdoDatabase,
  session: AgentSession,
  input: PickDeclinedInput,
): AgentResult & { readonly picked_in_window?: number } {
  const appended = appendOne(db, session, {
    id: `agent-pick-declined-${input.dispatch_id}-${input.at}-${Math.random().toString(36).slice(2, 8)}`,
    at: input.at,
    actor: session.actor,
    kind: 'agent.pick_declined',
    subject: input.card,
    payload: { dispatch_id: input.dispatch_id, card: input.card, reason: input.reason },
    caused_by: [],
    request_id: `pick-declined:${input.dispatch_id}:${input.at}`,
  });
  if (!appended.ok) return appended.result;
  const events = readEvents(db, []);
  const window = dispatchWindow(toWindowEvents(events), input.dispatch_id);
  if (!window.ok) return { ok: true, event_id: appended.event.id };
  return {
    ok: true,
    event_id: appended.event.id,
    picked_in_window: pickDeclinedInWindow(toWindowEvents(events), window.window),
  };
}

/** 读数脚本用：把事件表映射成 M4-7 的只读窗口事件（不暴露内部 helper）。 */
export function agentWindowEvents(db: SdoDatabase): WindowEvent[] {
  return toWindowEvents(readEvents(db, []));
}
