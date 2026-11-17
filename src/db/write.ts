/**
 * M1-0 唯一写入口：`append(db, events)`。真源：docs/02 §10–§12。
 * 三件事一次收束：①不认识的 kind 进不来（`unknown_event_kind`）；②链不许断
 * （`prev`=链头、`hash`=computeEventHash，不符整体回滚）；③重放不重复（同 id 同 hash 跳过、不同 hash 拒）。
 * 物化（卡 A2）：全量重放后 diff 落库，范围见 `write-materialize.ts`。
 * 分层：`src/db/` 可 import `src/core/`；反向禁止。
 */

import type { SdoDatabase } from './driver.js';
import type { Event } from '../core/fold/types.js';
import { GENESIS_PREV, computeEventHash } from '../core/verify-events.js';
import { materialize, requiredTable } from './write-materialize.js';
import { checkEnvelope, errorMessage, isLockMessage } from './write-envelope.js';
import { consumeGateJudgedAuthority } from './gate.js';
import { consumeRendererRegistrationAuthority, rendererRegistrationPayloadHash } from './renderer-authority.js';
import { applyRendererRegistrations } from './renderer.js';
import { fold } from '../core/fold/index.js';
import { readEvents } from '../core/verify-events.js';
import { detectConflict, extractConflictClaim } from '../core/conflict/detect.js';
import { trackedField } from '../core/conflict/scope.js';
import type { FoldState } from '../core/fold/types.js';
import {
  buildConflictDetectedEvent,
  consumeConflictDetectedAuthority,
  latestActorForSubject,
  newConflictId,
} from './conflict.js';
import { conflictDetectedPayloadHash } from './conflict-authority.js';
import { gateJudgedPayloadHash, validateGateJudgedPayload } from '../core/gate/schema.js';
import { failure, type AppendFailure, type AppendResult } from './write-types.js';
import { applyRightEvents, hasRight, readGrants } from './auth.js';
import { scopeCovers } from '../core/auth/rights.js';
import { ACK_KINDS } from '../core/fold/ack.js';
import {
  consumeRightChangeAuthority,
  parseRightChangeEvent,
  RIGHT_GRANTED,
  RIGHT_REVOKED,
  rightChangePayloadHash,
} from '../core/auth/rights-events.js';
import { KIND_ACTIONS } from '../core/auth/kind-actions.js';
import { ACTION_OBJECT_CONDITIONS } from './action-objects.js';
import { consumeWorkcopyAuthority, workcopyPayloadHash, WORKCOPY_TOOL_KINDS } from './workcopy-capability.js';
import { consumePublicFaceAuthority } from './publicface.js';
import {
  publicFacePayloadHash,
  PUBLICFACE_TOOL_KINDS,
  PUBLICFACE_TOOL_MARKER,
} from './publicface-capability.js';
import { lockToolPayloadHash, LOCK_TOOL_KINDS, LOCK_TOOL_MARKER } from './lock-capability.js';
import { consumeLockToolAuthority } from './lock.js';
import {
  LEASE_TOOL_KINDS,
  LEASE_TOOL_MARKER,
  leasePayloadHash,
} from './lease-capability.js';
import { consumeLeaseAuthority } from './lease.js';
import { claimGuard } from '../core/lease/claim-guard.js';

/** M3-1/C2：写网关的授权会话（只要身份二元组；工具路径的 session 形态各异）。 */
export interface AppendSession {
  readonly actor: string;
  readonly actor_kind: 'human' | 'agent' | 'service';
}

/**
 * M3-1/P0：append 只收会话，**不收动作/作用域**。
 * 动作由 `event.kind` 经 `KIND_ACTIONS` 映射（同批逐条判定），作用域从载荷推导；
 * 调用方声明动作会让“空 required 动作”变成万能钥匙（评审 P0）。
 */
export interface AppendAuthz {
  readonly session: AppendSession;
}

/** 唯一的 actor 例外白名单：conflict.detected 的 actor 按 M3-2 设计是失败写入方。 */
const ACTOR_EXEMPT_KINDS: ReadonlySet<string> = new Set([
  // S22：冲突时 actor 记“失败写入方”，来源由检测路径 mint 的一次性能力保证（非伪造入口）。
  'conflict.detected',
]);

function parseEventPayload(event: Event): Record<string, unknown> {
  const raw: unknown = event.payload;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function sessionFailure(authz: AppendAuthz | undefined): AppendFailure | undefined {
  if (authz === undefined) {
    return failure('no_permission', 'authz_missing: append requires {session} (fail-closed)');
  }
  const session = authz.session;
  if (
    typeof session?.actor !== 'string' || session.actor.length === 0 ||
    (session.actor_kind !== 'human' && session.actor_kind !== 'agent' && session.actor_kind !== 'service')
  ) {
    return failure('no_permission', 'authz_missing: session.actor / actor_kind are required (fail-closed)');
  }
  return undefined;
}

/** 单条事件的授权 + 对象条件（P0/P1-1/P1-2），在事务内落库前判定。 */
function hasSignRight(db: SdoDatabase, actor: string, scope: string): boolean {
  return readGrants(db, actor).some(
    (grant) => grant.revoked_at === null && grant.right === 'sign' && scopeCovers(grant.scope, scope),
  );
}

function authorizeEvent(
  db: SdoDatabase,
  event: Event,
  session: AppendSession,
  state: FoldState,
): AppendFailure | undefined {
  const lockToolPayload = parseEventPayload(event);
  const isLockToolEvent =
    (LOCK_TOOL_KINDS as readonly string[]).includes(event.kind) &&
    lockToolPayload['initiator'] === LOCK_TOOL_MARKER;
  // M4-1 第 3 轮 P2：工具释放事件以工具身份落库（actor='sdo-workcopy'），不能要求它等于
  // 调用方会话 actor；能力一次性、绑 payload_hash，仍由下方工具分支消费（D-148）。
  if (!isLockToolEvent && event.actor !== session.actor && !ACTOR_EXEMPT_KINDS.has(event.kind)) {
    return failure(
      'actor_not_from_session',
      `event ${event.id} actor=${event.actor} does not match session actor=${session.actor}`,
    );
  }
  // M4-1 第 2 轮 P1：根前缀的 lock.acquired 是工具专用事件。事件流敞开时，
  // 任何有 claim 权的 actor 都能直接 append 事件伪造根锁（2026-11-16 评审复现），
  // 所以必须在网关按一次性能力拦，而不是只看 payload.initiator 标记。
  const isRootLockAcquired =
    event.kind === 'lock.acquired' && (event.subject === '' || event.subject === '.');
  if (isRootLockAcquired) {
    const rootPayload = parseEventPayload(event);
    const authorized =
      rootPayload['initiator'] === LOCK_TOOL_MARKER &&
      consumeLockToolAuthority(event.id, lockToolPayloadHash(rootPayload));
    if (!authorized) {
      return failure(
        'unauthorized_root_lock',
        `event ${event.id} root lock.acquired must be produced by acquireMainTreeLock (one-shot, payload-bound)`,
      );
    }
    return undefined;
  }
  // M4-1/P2-5：内嵌工具路径的锁事件（releaseCardLocksAsTool 等）走一次性能力，
  // 业务路径的 lock.* 不在此列（仍走下方矩阵动作）。
  if (isLockToolEvent) {
    if (!consumeLockToolAuthority(event.id, lockToolPayloadHash(lockToolPayload))) {
      return failure(
        'unauthorized_workcopy_event',
        `event ${event.id} kind=${event.kind} initiator=${LOCK_TOOL_MARKER} must be produced by the workcopy tool path`,
      );
    }
    return undefined;
  }
  // M4-2/C1+C5：租约工具事件（lease.issued/expired）+ 收回/过期的伴随 task.blocked/unblocked
  // 只认 `src/db/lease.ts` 私有实例铸造的一次性能力（绑 payload_hash），通过后跳过矩阵动作。
  const leasePayload = parseEventPayload(event);
  // lease.issued/expired 没有业务写入口：任何一条都必须带工具标记且能消费能力，
  // 否则即使有 assign 权也不许直接 append（C1：dispatch 是唯一入口）。
  const isLeaseToolEvent =
    (LEASE_TOOL_KINDS as readonly string[]).includes(event.kind) &&
    leasePayload['initiator'] === LEASE_TOOL_MARKER;
  const isLeaseKind = (LEASE_TOOL_KINDS as readonly string[]).includes(event.kind);
  const isLeaseCompanion =
    (event.kind === 'task.blocked' || event.kind === 'task.unblocked') &&
    leasePayload['lease_tool'] === LEASE_TOOL_MARKER;
  if (isLeaseKind || isLeaseCompanion) {
    if (!isLeaseToolEvent && !isLeaseCompanion) {
      return failure(
        'unauthorized_lease_issue',
        `event ${event.id} kind=${event.kind} must be produced by the lease tool path (one-shot, payload-bound)`,
      );
    }
    if (!consumeLeaseAuthority(event.id, leasePayloadHash(leasePayload))) {
      return failure(
        'unauthorized_lease_issue',
        `event ${event.id} kind=${event.kind} must be produced by the lease tool path (one-shot, payload-bound)`,
      );
    }
    return undefined;
  }
  // M4-3/C4：公共面执行/单写者切换只认单写者能力路径的一次性能力（绑 payload_hash）。
  // 直 append 即使有 config/write 权也必须拒 not_public_face_writer（防止第二条写路）。
  if ((PUBLICFACE_TOOL_KINDS as readonly string[]).includes(event.kind)) {
    const publicPayload = parseEventPayload(event);
    const authorized =
      publicPayload['initiator'] === PUBLICFACE_TOOL_MARKER &&
      consumePublicFaceAuthority(event.id, publicFacePayloadHash(publicPayload));
    if (!authorized) {
      return failure(
        'not_public_face_writer',
        `event ${event.id} kind=${event.kind} must be produced by the public face writer path (one-shot, payload-bound)`,
      );
    }
    return undefined;
  }
  // M4-4/C1：right.granted/revoked 只认 `src/db/auth.ts` 的授权 API 铸造的一次性能力
  // （绑 event id + payload hash）；裸 append 即使有 admin@domain 权也拒 unauthorized_right_change。
  if (event.kind === RIGHT_GRANTED || event.kind === RIGHT_REVOKED) {
    const rightPayload = parseEventPayload(event);
    const parsed = parseRightChangeEvent(event.kind, rightPayload);
    if (!parsed.ok) return failure('invalid_field', parsed.message);
    if (!consumeRightChangeAuthority(event.id, rightChangePayloadHash(rightPayload))) {
      return failure(
        'unauthorized_right_change',
        `event ${event.id} kind=${event.kind} must be produced by grantRight/revokeRight/backfillGrants (one-shot, payload-bound)`,
      );
    }
    return undefined;
  }
  // M4-0：workcopy.created/removed 与 snapshot.taken 是工具专用事件（docs/02 §301）。
  // 先校验一次性能力（绑 payload hash），通过后跳过矩阵动作——工具会话不需要 plan@domain。
  if ((WORKCOPY_TOOL_KINDS as readonly string[]).includes(event.kind)) {
    if (!consumeWorkcopyAuthority(event.id, workcopyPayloadHash(parseEventPayload(event)))) {
      return failure(
        'unauthorized_workcopy_event',
        `event ${event.id} kind=${event.kind} must be produced by the workcopy tool path (one-shot, content-bound)`,
      );
    }
    return undefined;
  }
  // P3-3（第 3 轮）：decision.valid 的 producer 是审计归属，不参与授权；
  // 但乱填会让归因失真。硬要求非空；若 producer 已在 actor 表登记，必须是 agent
  // （human/service 冒充模型产出 ⇒ invalid_field）。未登记时放行（软校验，测试夹具
  // 可能只播 session actor；M4 签名信封落地后改为硬校验，见 D-112）。
  if (event.kind === 'decision.valid') {
    const producer = parseEventPayload(event)['producer'];
    if (typeof producer !== 'string' || producer.length === 0) {
      return failure('invalid_field', `event ${event.id} decision.valid.payload.producer must be a non-empty string`);
    }
    const row = db.prepare('SELECT kind FROM actor WHERE id = ?').get(producer) as { kind?: string } | undefined;
    if (row !== undefined && row.kind !== 'agent') {
      return failure(
        'invalid_field',
        `event ${event.id} decision.valid.payload.producer=${producer} is actor kind ${String(row.kind)}; producer must be an agent`,
      );
    }
  }
  const mapped = KIND_ACTIONS[event.kind];
  if (mapped === undefined) {
    // 其余 ACK 是审计/派生通知：只做会话绑定，不投影任何物化行（边界见卡 A5 / D-108）。
    if (Object.hasOwn(ACK_KINDS, event.kind)) return undefined;
    return failure('unmapped_event_kind', `event kind ${event.kind} has no KIND_ACTIONS mapping (fail-closed)`);
  }
  let scope = mapped.scopeOf(parseEventPayload(event), { state, subject: event.subject });
  if (event.kind === 'lease.revoked') {
    // M4-2 第 2 轮 P1：撤租约的 scope 唯一来源是租约行（不是 payload），动作统一 assign。
    const leasePayload = parseEventPayload(event);
    const leaseId = typeof leasePayload['lease_id'] === 'string' ? leasePayload['lease_id'] : undefined;
    const leaseRow = leaseId === undefined ? undefined : state.tables.lease[leaseId];
    if (leaseRow === undefined) {
      return failure('lease_not_active', `lease.revoked payload.lease_id ${leaseId ?? '(missing)'} does not exist`);
    }
    if (leaseRow['status'] !== 'active') {
      return failure('lease_not_active', `lease ${leaseId} is ${String(leaseRow['status'])}; only active can be revoked`);
    }
    const rowScope = String(leaseRow['scope'] ?? '');
    if (leasePayload['scope'] !== undefined && leasePayload['scope'] !== rowScope) {
      return failure('invalid_field', `lease.revoked payload.scope ${String(leasePayload['scope'])} does not match lease ${leaseId} scope ${rowScope}`);
    }
    scope = rowScope;
  }
  // sign 不是矩阵动作（docs/07 §2 没有行）：只认“在该 scope 上持未撤销 sign 权”，不做前缀推断。
  if (mapped.action === 'sign') {
    if (!hasSignRight(db, session.actor, scope)) {
      return failure(
        'no_permission',
        `append denied: actor=${session.actor} kind=${session.actor_kind} event_kind=${event.kind} action=sign scope=${scope} reason=missing_grant (requires a non-revoked sign right on ${scope})`,
      );
    }
    const condition = ACTION_OBJECT_CONDITIONS[event.kind];
    if (condition !== undefined) {
      const failedCondition = condition(state, event, session);
      if (failedCondition !== undefined) return failure('object_condition_failed', failedCondition.message);
    }
    return undefined;
  }
  const decision = hasRight(db, { id: session.actor, kind: session.actor_kind }, mapped.action, scope);
  if (!decision.ok) {
    return failure(
      'no_permission',
      `append denied: actor=${session.actor} kind=${session.actor_kind} event_kind=${event.kind} action=${mapped.action} scope=${scope} reason=${decision.reason ?? 'missing_grant'} (${decision.message})`,
    );
  }
  // M4-2/C2+C3+C6：认领必须有活租约；预占期内只允许 reserved_by 认领（预占≠授权）。
  // D-159（Lead 裁定）：闸恒开，不做激活边界——冷启动库同样必须先 lease.issued；
  // 历史夹具走测试助手 claimWithLease / appendWithLeases，不在产品里开后门。
  if (event.kind === 'task.claimed') {
    const guard = claimGuard(state, event.subject, event.actor, event.at);
    if (guard !== undefined) return failure(guard.reason_code, guard.message);
  }
  const condition = ACTION_OBJECT_CONDITIONS[event.kind];
  if (condition !== undefined) {
    const failedCondition = condition(state, event, session);
    if (failedCondition !== undefined) {
      return failure('object_condition_failed', failedCondition.message);
    }
  }
  return undefined;
}

export type { AppendReason, AppendResult } from './write-types.js';

/**
 * 工具路径的显式入口（M3-1/C2）：内部 public API 只声明“以谁的身份写”，
 * 动作/作用域由 kind 查表（P0）。
 */
export function appendAsTool(
  db: SdoDatabase,
  events: readonly Event[],
  actor: string,
  actor_kind: 'human' | 'agent' | 'service' = 'human',
): AppendResult {
  return append(db, events, { session: { actor, actor_kind } });
}

class AppendAbort extends Error {
  constructor(
    readonly failure: AppendFailure,
    readonly attempted: number,
  ) {
    super(failure.message);
    this.name = 'AppendAbort';
  }
}

function rollbackQuietly(db: SdoDatabase): boolean {
  if (!db.inTransaction) return false;
  try {
    db.exec('ROLLBACK');
    return true;
  } catch {
    return false;
  }
}

interface ChainRow {
  readonly id: string;
  readonly hash: string;
}

function readChain(db: SdoDatabase): ChainRow[] {
  return db.prepare('SELECT id, hash FROM event ORDER BY rowid').all() as ChainRow[];
}

/**
 * 唯一写入口。整批在一个 `BEGIN IMMEDIATE` 事务里：校验 → 插事件 → 全量 fold → 投影 diff。
 * 任一步失败 ⇒ ROLLBACK，返回 `{ok:false, reason_code}`；不抛裸错让调用方猜。
 *
 * 已知边界：
 * - 网关为校验链必须读 `event` 表（`readChain`/`chainHead`），这是 `docs/02` §12
 *   “只有 fold 能读 event”的显式白名单；台账 D-027。
 * - 本卡只按 `event.id` 幂等；`request_id` 幂等属写 API 层（D-028）。
 */
/** 取 decision.signed 的 signerd 回执 id；形状不对返回 undefined（由网关给出更早的拒绝）。 */
function receiptIdOf(event: Event): string | undefined {
  const payload = envelopePayload(event);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const signerd = (payload as Record<string, unknown>)['signerd'];
  if (typeof signerd !== 'object' || signerd === null) return undefined;
  const receiptId = (signerd as Record<string, unknown>)['receipt_id'];
  return typeof receiptId === 'string' && receiptId.length > 0 ? receiptId : undefined;
}

/**
 * M3-3 第 2 轮 P1-2：同一 signerd 回执只能落一条 decision.signed。
 * 在 append 事务内做 INSERT（PRIMARY KEY 冲突即拒），失败随事务回滚。
 */
function claimReceipt(db: SdoDatabase, receiptId: string, event: Event): AppendFailure | undefined {
  try {
    db.prepare(
      'INSERT INTO signerd_receipt_use (receipt_id, event_id, decision_id, at) VALUES (?, ?, ?, ?)',
    ).run(receiptId, event.id, event.subject, event.at);
    return undefined;
  } catch (error) {
    const message = errorMessage(error);
    if (/UNIQUE constraint failed: signerd_receipt_use\.receipt_id|PRIMARY KEY/i.test(message)) {
      return failure(
        'signerd_receipt_replayed',
        `signerd 回执 ${receiptId} 已被另一条事件使用（禁止复制签名事件重放）`,
      );
    }
    return failure('materialize_failed', message);
  }
}

function envelopePayload(event: Event): unknown {
  const payload: unknown = event.payload;
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return payload;
  }
}

function winnerForSubject(
  db: SdoDatabase,
  subject: string,
  actors: Map<string, string>,
): string | undefined {
  const known = actors.get(subject);
  if (known !== undefined) return known;
  const stored = latestActorForSubject(db, subject);
  if (stored !== undefined) actors.set(subject, stored);
  return stored;
}

export function append(db: SdoDatabase, events: readonly Event[], authz: AppendAuthz): AppendResult {
  if (events.length === 0) {
    return { ok: true, written: 0, skipped: 0, attempted: 0, rolled_back: false, eventCount: countEvents(db) };
  }

  const missingSession = sessionFailure(authz);
  if (missingSession !== undefined) {
    return failed(missingSession, 0, db);
  }
  const session = authz.session;

  if (db.inTransaction) {
    return failed(
      failure('transaction_in_progress', 'append must own the transaction; caller already has one open'),
      0,
      db,
    );
  }

  let result: AppendResult;
  try {
    let existing: ReturnType<typeof readChain>;
    try {
      db.exec('BEGIN IMMEDIATE');
      existing = readChain(db);
    } catch (error) {
      const message = errorMessage(error);
      // BEGIN 之后 readChain 也可能抛错：这里先兜一次回滚，finally 仍保底（P2-1）。
      return failed(
        failure(isLockMessage(message) ? 'database_busy' : 'materialize_failed', message),
        0,
        db,
        rollbackQuietly(db),
      );
    }
    const byId = new Map(existing.map((row) => [row.id, row.hash] as const));
    let expectedPrev = existing.length === 0 ? GENESIS_PREV : (existing[existing.length - 1]?.hash ?? GENESIS_PREV);
    let written = 0;
    let skipped = 0;
    let validated = 0;
    let sawNew = false;
    const fresh: Event[] = [];
    let foldState: FoldState | undefined;
    // M3-2/P2-2：批内逐条推进折叠态（P2-1 的字段级 CAS 与 P2-2 的批内冲突都依赖它）。
    const advance = (event: Event): void => {
      // CAS 用的预览折叠：若这条事件本身会让 fold 拒（例如非法载荷），不要在
      // 校验阶段抛——留给后面的 materialize 阶段按既有语义报 materialize_failed。
      try {
        if (foldState === undefined) foldState = fold(undefined, readEvents(db, []));
        foldState = fold(foldState, [event]);
      } catch {
        foldState = undefined;
      }
    };
    // P0/P1-1/P1-2 的判定态：事件前的折叠态（同批前置事件已推进）；读不出来按 materialize_failed。
    const stateForAuth = (): FoldState => {
      if (foldState !== undefined) return foldState;
      return fold(undefined, readEvents(db, []));
    };
    // 批内逐条推进时，本批已写事件的 actor 也要算“最后一位写者”。
    const winnerActors = new Map<string, string>();
    let detected: { conflict_id: string; base_hash: string; current_hash: string; field: string; subject: string } | undefined;

    for (const event of events) {
      const envelope = checkEnvelope(event);
      if (envelope !== undefined) {
        throw new AppendAbort(envelope, validated);
      }
      // 重放路径先于授权：已存在且 hash 一致的事件是幂等重放，不重新判权/对象条件
      //（对象条件按“当前态”评估，重放时态已变会被误拒）；hash 不一致仍拒。
      const stored = byId.get(event.id);
      if (stored !== undefined) {
        if (sawNew) {
          throw new AppendAbort(failure('event_chain_broken', `event ${event.id} of a replay batch must precede new events`), validated);
        }
        if (stored !== event.hash) {
          throw new AppendAbort(failure('event_hash_mismatch', `event ${event.id} already exists with a different hash`), validated);
        }
        skipped += 1;
        validated += 1;
        continue;
      }
      let authState: FoldState;
      try {
        authState = stateForAuth();
      } catch (error) {
        throw new AppendAbort(failure('materialize_failed', `authorization fold failed: ${errorMessage(error)}`), validated);
      }
      const denied = authorizeEvent(db, event, session, authState);
      if (denied !== undefined) {
        throw new AppendAbort(denied, validated);
      }
      const authority = checkBaselineAuthority(db, event, events);
      if (authority !== undefined) {
        throw new AppendAbort(authority, validated);
      }
      const rejected = checkDecisionRejectedAuthority(db, event);
      if (rejected !== undefined) {
        throw new AppendAbort(rejected, validated);
      }
      // M3-3 第 2 轮 P1-2：回执一次性（先占位，后续任何校验失败都会回滚）。
      if (event.kind === 'decision.signed') {
        const receiptId = receiptIdOf(event);
        if (receiptId !== undefined) {
          const claimed = claimReceipt(db, receiptId, event);
          if (claimed !== undefined) throw new AppendAbort(claimed, validated);
        }
      }
      if (event.kind === 'gate.judged') {
        let payload: unknown = event.payload;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch {
            throw new AppendAbort(failure('invalid_field', `gate.judged ${event.id} payload is not valid JSON`), validated);
          }
        }
        const validation = validateGateJudgedPayload(payload);
        if (!validation.ok) {
          throw new AppendAbort(failure('invalid_field', `gate.judged ${event.id}: ${validation.message}`), validated);
        }
        const authorized = consumeGateJudgedAuthority(
          event.id,
          gateJudgedPayloadHash(validation.value),
          validation.value.stage_run_id,
        );
        if (!authorized) {
          throw new AppendAbort(
            failure(
              'unauthorized_gate_judgement',
              `gate.judged ${event.id} must be produced by the gate judgement flow (one-shot, content-bound)`,
            ),
            validated,
          );
        }
      }
      if (event.kind === 'renderer.registered') {
        let payload: unknown = event.payload;
        if (typeof payload === 'string') {
          try {
            payload = JSON.parse(payload);
          } catch {
            throw new AppendAbort(
              failure('invalid_field', `renderer.registered ${event.id} payload is not valid JSON`),
              validated,
            );
          }
        }
        const payloadHash = rendererRegistrationPayloadHash(payload);
        if (payloadHash === undefined || !consumeRendererRegistrationAuthority(payloadHash)) {
          throw new AppendAbort(
            failure(
              'unauthorized_renderer_registration',
              `renderer.registered ${event.id} must be produced by registerRenderer() (one-shot, content-bound)`,
            ),
            validated,
          );
        }
      }
      // M3-2/P1-3：conflict.detected 只能由真 CAS 路径产生（一次性能力，绑 payload hash）。
      if (event.kind === 'conflict.detected') {
        const payload = envelopePayload(event);
        if (!consumeConflictDetectedAuthority(event.id, conflictDetectedPayloadHash(payload))) {
          throw new AppendAbort(
            failure(
              'unauthorized_conflict_detected',
              `conflict.detected ${event.id} must be produced by the CAS path (one-shot, content-bound)`,
            ),
            validated,
          );
        }
      }
      // M3-2：乐观并发（docs/02 §3）。受管 kind 必须声明 field+base_hash；
      // 冲突时原事件不落，改落一条 conflict.detected（actor=失败写入方）。
      if (event.kind !== 'conflict.detected' && event.kind !== 'conflict.resolved') {
        const table = requiredTable(event.kind);
        if (table !== undefined) {
          if (foldState === undefined) foldState = fold(undefined, readEvents(db, []));
          const tracked = trackedField(event.kind);
          const claim = extractConflictClaim(event);
          if (tracked !== undefined && claim === undefined) {
            throw new AppendAbort(
              failure(
                'conflict_scope_undeclared',
                `${event.kind} patches an existing row; payload must declare field and base_hash`,
              ),
              validated,
            );
          }
          if (tracked !== undefined && claim !== undefined && claim.field !== tracked) {
            throw new AppendAbort(
              failure(
                'invalid_field',
                `${event.kind} must declare field=${tracked} (got ${claim.field})`,
              ),
              validated,
            );
          }
          const currentRow = foldState.tables[table][event.subject];
          const conflict = detectConflict({
            currentRow,
            winnerActor: winnerForSubject(db, event.subject, winnerActors),
            event,
          });
          if (conflict !== undefined) {
            const conflictId = newConflictId();
            const conflictEvent = buildConflictDetectedEvent({
              conflictId,
              table,
              objectId: event.subject,
              detection: conflict,
              actor: event.actor,
              at: event.at,
              prev: expectedPrev,
            });
            detected = {
              conflict_id: conflictId,
              base_hash: conflict.base_hash,
              current_hash: conflict.current_hash,
              field: conflict.field,
              subject: `${table}/${event.subject}`,
            };
            expectedPrev = conflictEvent.hash;
            sawNew = true;
            fresh.push(conflictEvent);
            advance(conflictEvent);
            written += 1;
            validated += 1;
            continue;
          }
        }
      }
      if (event.prev !== expectedPrev) {
        throw new AppendAbort(failure('event_chain_broken', `event ${event.id}: prev ${event.prev} does not match chain head ${expectedPrev}`), validated);
      }
      const computed = computeEventHash(event);
      if (computed !== event.hash) {
        throw new AppendAbort(failure('event_hash_mismatch', `event ${event.id}: hash does not match computeEventHash`), validated);
      }
      expectedPrev = event.hash;
      sawNew = true;
      fresh.push(event);
      winnerActors.set(event.subject, event.actor);
      advance(event);
      written += 1;
      validated += 1;
    }

    try {
      const insert = db.prepare(
        `INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const event of fresh) {
        insert.run(
          event.id,
          event.at,
          event.actor,
          event.kind,
          event.subject,
          JSON.stringify(event.payload ?? null),
          JSON.stringify(event.caused_by),
          event.request_id,
          event.prev,
          event.hash,
        );
      }
    } catch (error) {
      throw new AppendAbort(failure('append_conflict', errorMessage(error)), validated);
    }

    try {
      materialize(db);
      // M3-4/P1-3：renderer.registered 是 ACK，fold 物化不会碰 renderer_catalog；
      // 在 append 事务内、提交前显式投影，直写目录表由迁移 011 的哨兵触发器挡。
      applyRendererRegistrations(db, fresh);
      // M4-4：right.granted/revoked 是 ACK，scope 行的唯一生产者是本投影（D-113）；
      // 直改 scope 表不会被抹掉，但会被 verify 对账抓出来（C5）。
      applyRightEvents(db, fresh);
    } catch (error) {
      throw new AppendAbort(failure('materialize_failed', errorMessage(error)), validated);
    }
    db.exec('COMMIT');
    const eventCount = countEvents(db);
    result =
      detected === undefined
        ? { ok: true, written, skipped, attempted: validated, rolled_back: false, eventCount }
        : {
            ok: false,
            reason_code: 'conflict',
            message: `conflict ${detected.conflict_id} on ${detected.subject}.${detected.field}: stale base_hash (409 semantics)`,
            conflict_id: detected.conflict_id,
            base_hash: detected.base_hash,
            current_hash: detected.current_hash,
            written,
            skipped,
            attempted: validated,
            rolled_back: false,
            eventCount,
          };
  } catch (error) {
    const rolled = rollbackQuietly(db);
    result =
      error instanceof AppendAbort
        ? failed(error.failure, error.attempted, db, rolled)
        : failed(failure('materialize_failed', errorMessage(error)), 0, db, rolled);
  } finally {
    // 兜底：无论从哪条路径离开，都不把连接留在事务里（P1-1）。
    rollbackQuietly(db);
  }
  return result;
}

const BASELINE_FREEZE_KINDS = new Set(['baseline.frozen', 'baseline.amended', 'baseline.loosened']);

/**
 * `docs/04` §5.2：baseline 的每一版都必须先有人签的 `decision(kind='baseline')`；
 * 事件层不是唯一入口，绕过 preview/confirm 直接 append 未签事件必须被拒（M2-1 C1）。
 */
/**
 * M2-3/P2-1：已签决策不能再 `decision.rejected`（否则其投影的处置被卡死）。
 * 与 fold 里的同名守卫成对：这里让拒绝在写路径就有**可断言的码**，fold 里的守卫兜住绕过网关的旧事件。
 */
function checkDecisionRejectedAuthority(db: SdoDatabase, event: Event): AppendFailure | undefined {
  if (event.kind !== 'decision.rejected') return undefined;
  const row = db
    .prepare('SELECT status, signature FROM decision WHERE id = ?')
    .get(event.subject) as { status?: string; signature?: string | null } | undefined;
  if (row === undefined) return undefined;
  if (row.status === 'valid' && String(row.signature ?? '').length > 0) {
    return failure(
      'decision_already_signed',
      `decision ${event.subject} is already signed; revoke it with decision.revoked instead of decision.rejected`,
    );
  }
  return undefined;
}

function checkBaselineAuthority(
  db: SdoDatabase,
  event: Event,
  batch: readonly Event[],
): AppendFailure | undefined {
  if (!BASELINE_FREEZE_KINDS.has(event.kind)) return undefined;
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const fields = payload as Record<string, unknown>;
  const decisionId = fields['decision_id'];
  const hash = fields['hash'];
  if (typeof decisionId !== 'string' || decisionId.length === 0) {
    return failure('invalid_field', `${event.kind} requires payload.decision_id (signed baseline decision)`);
  }
  let decisionPayload: unknown;
  let decisionKind: unknown;
  let hasSignature = false;
  const stored = db.prepare('SELECT payload, signature FROM decision WHERE id = ?').get(decisionId) as
    | { payload: unknown; signature: unknown }
    | undefined;
  if (stored !== undefined) {
    try {
      decisionPayload = JSON.parse(String(stored.payload)) as unknown;
    } catch {
      decisionPayload = stored.payload;
    }
    hasSignature = typeof stored.signature === 'string' && stored.signature.length > 0;
    decisionKind =
      decisionPayload !== null && typeof decisionPayload === 'object'
        ? (decisionPayload as Record<string, unknown>)['decision_kind']
        : undefined;
  } else {
    const valid = batch.find((candidate) => candidate.kind === 'decision.valid' && candidate.subject === decisionId);
    const signed = batch.find((candidate) => candidate.kind === 'decision.signed' && candidate.subject === decisionId);
    if (valid === undefined || signed === undefined) {
      return failure('invalid_field', `${event.kind} decision ${decisionId} is not signed`);
    }
    const validPayload = valid.payload;
    const outer = validPayload !== null && typeof validPayload === 'object' ? (validPayload as Record<string, unknown>) : {};
    decisionKind = outer['decision_kind'];
    decisionPayload = outer['payload'];
    hasSignature = true;
  }
  const record =
    decisionPayload !== null && typeof decisionPayload === 'object' ? (decisionPayload as Record<string, unknown>) : {};
  const extra = record['extra'] !== null && typeof record['extra'] === 'object' ? (record['extra'] as Record<string, unknown>) : {};
  const baseline =
    record['baseline'] !== null && typeof record['baseline'] === 'object'
      ? (record['baseline'] as Record<string, unknown>)
      : extra['baseline'] !== null && typeof extra['baseline'] === 'object'
        ? (extra['baseline'] as Record<string, unknown>)
        : {};
  if (!hasSignature) {
    return failure('invalid_field', `${event.kind} decision ${decisionId} is not signed`);
  }
  if (decisionKind !== 'baseline') {
    return failure('invalid_field', `decision ${decisionId} must be kind baseline`);
  }
  const eventPrev = fields['prev'] ?? null;
  const eventDirection = fields['direction'] ?? null;
  if (typeof hash !== 'string' || baseline['hash'] !== hash) {
    return failure('invalid_field', `${event.kind} hash does not match the signed baseline decision payload`);
  }
  if ((baseline['prev'] ?? null) !== eventPrev) {
    return failure('invalid_field', `${event.kind} prev does not match the signed baseline decision payload`);
  }
  if ((baseline['direction'] ?? null) !== eventDirection) {
    return failure('invalid_field', `${event.kind} direction does not match the signed baseline decision payload`);
  }
  if (baseline['will_change_hash'] !== fields['will_change_hash']) {
    return failure('invalid_field', `${event.kind} will_change_hash does not match the signed baseline decision payload`);
  }
  if (JSON.stringify(baseline['guarantee_delta']) !== JSON.stringify(fields['guarantee_delta'])) {
    return failure('invalid_field', `${event.kind} guarantee_delta does not match the signed baseline decision payload`);
  }
  return undefined;
}

function countEvents(db: SdoDatabase): number {
  try {
    const row = db.prepare('SELECT count(*) AS n FROM event').get() as { n: number };
    return row.n;
  } catch {
    // 表本身不可用时（例如 P1-1 的故障注入）报告 0，不让报告路径再抛错。
    return 0;
  }
}

function failed(failure: AppendFailure, attempted: number, db: SdoDatabase, rolledBack = false): AppendResult {
  return {
    ok: false,
    reason_code: failure.reason,
    message: failure.message,
    written: 0,
    skipped: 0,
    attempted,
    rolled_back: rolledBack,
    eventCount: countEvents(db),
  };
}

/** 当前链头 hash；空链返回 `GENESIS_PREV`。 */
export function chainHead(db: SdoDatabase): string {
  const row = db.prepare('SELECT hash FROM event ORDER BY rowid DESC LIMIT 1').get() as
    | { hash: string }
    | undefined;
  return row?.hash ?? GENESIS_PREV;
}
