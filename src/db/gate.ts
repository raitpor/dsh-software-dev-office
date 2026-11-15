/**
 * M2-2 门禁判定落库（C1/C2/C9）：先算后写。
 *
 * 判定对象是 `stage_run` 行；写 `gate.judged` 事件是改 `gate_id`/`baseline_hash`/
 * `verdict`/`criteria` 的唯一路径——写网关只接受本模块登记过的一次性授权。
 * baseline 必须已冻结（存在 frozen/amended/loosened 事件 + 已签 decision），
 * 判定引用的 release 必须绑同一版 baseline（C9）。
 */
import type { SdoDatabase } from './driver.js';
import { appendAsTool, chainHead } from './write.js';
import { buildEvent, parseJson, toRow } from './freeze-store.js';
import { readEvents } from '../core/verify-events.js';
import { fold } from '../core/fold/index.js';
import type { Event, FoldState } from '../core/fold/types.js';
import type { VerifyProblem } from '../core/verify-types.js';
import { evaluateStageGate, type BaselineRowLike } from '../core/gate/evaluate.js';
import { compileGateJudged } from '../core/gate/judge.js';
import { judgeIndependence, signaturesForDecision } from '../core/independence/judge.js';
import { baselineAssuranceBound } from '../core/independence/verify.js';
import { gateJudgedPayloadHash, validateGateJudgedPayload } from '../core/gate/schema.js';
import type { GateEvaluation } from '../core/gate/types.js';

export interface GateJudgeRequest {
  readonly stage_run_id: string;
  /** 缺省 = `stage.entered` 记下的那版；显式传入必须与它相等。 */
  readonly baseline_hash?: string;
  /** 判定引用的交付 release（有则必须绑同一版 baseline）。 */
  readonly release_id?: string;
  /** 会话固定的 actor（D-056：不从请求载荷取 actor_kind）。 */
  readonly actor: string;
  readonly at?: string;
  /** 注入的当前时刻（默认 `new Date().toISOString()`），用于上界校验与测试。 */
  readonly now?: string;
}

export type GateJudgeReason =
  | 'stage_run_missing'
  | 'baseline_not_frozen'
  | 'baseline_mismatch'
  | 'invalid_field'
  | 'unauthorized_gate_judgement'
  | 'multiple_gates_unsupported'
  | 'append_failed';

export interface GateJudgeResult {
  readonly ok: boolean;
  readonly reason_code?: GateJudgeReason;
  readonly message?: string;
  readonly event_id?: string;
  readonly evaluation?: GateEvaluation;
}

function fail(reason: GateJudgeReason, message: string): GateJudgeResult {
  return { ok: false, reason_code: reason, message };
}

/**
 * 一次性判定授权：`(eventId, payloadHash, stageRunId)` 三元组。
 *
 * 只有本模块的 `judgeStage()` 能登记（mint 不导出）；写网关在 append 时消费。
 * 消费后同 eventId 再用 ⇒ 拒（能力不常驻）。
 */
interface GateAuthority {
  readonly payload_hash: string;
  readonly stage_run_id: string;
}
const GATE_AUTHORITIES = new Map<string, GateAuthority>();

function mintGateJudgedAuthority(eventId: string, payloadHash: string, stageRunId: string): void {
  GATE_AUTHORITIES.set(eventId, { payload_hash: payloadHash, stage_run_id: stageRunId });
}

/**
 * 写网关调用：校验并消费一次性授权。绑定载荷摘要与 stage_run id，能力不常驻。
 * @internal 仅供 `src/db/write.ts` 使用。
 */
export function consumeGateJudgedAuthority(
  eventId: string,
  payloadHash: string,
  stageRunId: string,
): boolean {
  const grant = GATE_AUTHORITIES.get(eventId);
  if (grant === undefined) return false;
  // 先删后比：错配也烧掉能力（fail-closed，避免用同一 eventId 试错）。
  GATE_AUTHORITIES.delete(eventId);
  return grant.payload_hash === payloadHash && grant.stage_run_id === stageRunId;
}

// 没有测试缝：`gate.judged` 只能由 `judgeStage()` 现算并登记能力。
// 需要判定行的测试走真路径（`judgeStage`），不得再造第二个 mint（否则“唯一写入口”
// 只是注释）。世界链夹具里的 `gate.judged` 由真实 `judgeStage` 在执行期补。

/** 测试清理（授权只存在于进程内）。 */
function readState(db: SdoDatabase): { state: FoldState; events: readonly Event[] } {
  const problems: VerifyProblem[] = [];
  const events = readEvents(db, problems);
  return { state: fold(undefined, events), events };
}

function baselineRow(state: FoldState, hash: string): Record<string, unknown> | undefined {
  return Object.values(state.tables.baseline).find((row) => row['hash'] === hash);
}

function frozenEventExists(state: FoldState, events: readonly Event[], hash: string): boolean {
  const kinds = new Set(['baseline.frozen', 'baseline.amended', 'baseline.loosened']);
  return events.some((event) => {
    if (!kinds.has(event.kind)) return false;
    const payload = parseJson(event.payload);
    if (payload === null || typeof payload !== 'object') return false;
    const body = payload as Record<string, unknown>;
    if (body['hash'] !== hash) return false;
    const decisionId = body['decision_id'];
    if (typeof decisionId !== 'string') return false;
    const decision = state.tables.decision[decisionId];
    return decision !== undefined && decision['status'] === 'valid' && String(decision['signature'] ?? '').length > 0;
  });
}

/**
 * M3-3：baseline 对应的冻结 decision 是否满足独立性（same judge as verify）。
 * 找不到冻结事件的决定 id 时判不满足（fail-closed）——已冻结的 baseline 不可能没有签字。
 */
function judgeBaselineIndependence(
  db: SdoDatabase,
  state: FoldState,
  events: readonly Event[],
  baselineHash: string,
): ReturnType<typeof judgeIndependence> {
  const kinds = new Set(['baseline.frozen', 'baseline.amended', 'baseline.loosened']);
  let decisionId: string | null = null;
  for (const event of events) {
    if (!kinds.has(event.kind)) continue;
    const payload = parseJson(event.payload);
    if (payload === null || typeof payload !== 'object') continue;
    const body = payload as Record<string, unknown>;
    if (body['hash'] !== baselineHash) continue;
    if (typeof body['decision_id'] === 'string') {
      decisionId = body['decision_id'];
      break;
    }
  }
  const matrix = (db.prepare('SELECT action, dual_human FROM right').all() as Record<string, unknown>[]).map(
    (row) => ({ action: String(row['action']), dual_human: String(row['dual_human']) }),
  );
  const actorRows = db.prepare("SELECT COUNT(*) AS n FROM actor WHERE kind = 'human'").all() as Record<string, unknown>[];
  const humanCountRaw = actorRows[0]?.['n'];
  const humanActorCount = typeof humanCountRaw === 'number' ? humanCountRaw : 0;
  if (decisionId === null) {
    return {
      ok: false,
      required: true,
      mode: null,
      action: 'freeze',
      reason_code: 'independence_unsatisfied',
      message: `baseline ${baselineHash} 的冻结事件没有 decision_id，无法证明独立性`,
      signature_count: 0,
      distinct_signers: 0,
    };
  }
  const row = state.tables.decision[decisionId];
  const kind = String(row?.['decision_kind'] ?? 'freeze');
  // P1-1：按 stage_run 记录的 baseline_hash 取那一版的 assurance，而不是链头。
  const binding = baselineAssuranceBound(state, baselineHash);
  if (binding.fallback) {
    return {
      ok: false,
      required: true,
      mode: null,
      action: 'freeze',
      reason_code: 'independence_unsatisfied',
      message: `baseline ${baselineHash} 行不存在，无法按版本证明独立性（fail-closed）`,
      signature_count: 0,
      distinct_signers: 0,
    };
  }
  return judgeIndependence({
    decision_kind: kind,
    signatures: signaturesForDecision(events, decisionId),
    matrix,
    assurance: binding.assurance,
    human_actor_count: humanActorCount,
  });
}

/** 判定一个 stage 出口并落 `gate.judged`。 */
export function judgeStage(db: SdoDatabase, request: GateJudgeRequest): GateJudgeResult {
  const at = request.at ?? new Date().toISOString();
  const now = request.now ?? new Date().toISOString();
  const { state, events } = readState(db);

  const stageRun = state.tables.stage_run[request.stage_run_id];
  if (stageRun === undefined) return fail('stage_run_missing', `stage_run ${request.stage_run_id} does not exist`);
  const stage = String(stageRun['stage']);
  const enteredAt = String(stageRun['entered_at'] ?? '');
  if (enteredAt.length > 0 && at < enteredAt) {
    return fail('invalid_field', `judgement at ${at} is before stage_run.entered_at ${enteredAt}`);
  }
  if (at > now) {
    return fail('invalid_field', `judgement at ${at} is in the future (now ${now})`);
  }

  // 判定版本 = stage.entered 记下的那版（P2-1）；显式传入必须与它相等。
  const recordedHash = stageRun['baseline_hash'];
  const recorded = typeof recordedHash === 'string' && recordedHash.length > 0 ? recordedHash : null;
  const requested = request.baseline_hash ?? recorded ?? undefined;
  if (requested === undefined) {
    return fail(
      'baseline_not_frozen',
      `stage_run ${request.stage_run_id} has no baseline_hash and none was given; pass baseline_hash explicitly`,
    );
  }
  if (recorded !== null && requested !== recorded) {
    return fail(
      'baseline_mismatch',
      `stage_run ${request.stage_run_id} entered under baseline ${recorded}, not ${requested}`,
    );
  }
  const row = baselineRow(state, requested);
  const baseline: BaselineRowLike | null = row === undefined ? null : toRow(row as Record<string, unknown>);
  if (baseline === null) return fail('baseline_not_frozen', `baseline ${requested} does not exist or is not frozen`);
  if (!frozenEventExists(state, events, baseline.hash)) {
    return fail('baseline_not_frozen', `baseline ${baseline.id} has no frozen/amended/loosened event with a signed decision`);
  }

  if (request.release_id !== undefined) {
    const release = state.tables.release[request.release_id];
    if (release === undefined) return fail('baseline_mismatch', `release ${request.release_id} does not exist`);
    if (String(release['baseline_hash'] ?? '') !== baseline.hash) {
      return fail(
        'baseline_mismatch',
        `release ${request.release_id} references baseline ${String(release['baseline_hash'] ?? '')}, not ${baseline.hash}`,
      );
    }
  }

  let evaluation = evaluateStageGate(state, baseline, stage);
  // M3-3 C3：独立性不满足 ⇒ 强制 changes_requested + 原因码。
  // 判定与 verify 用同一个 judge，结论能从事件 + baseline 重算（不是 judge 时刻的不可复算开关）。
  const independence = judgeBaselineIndependence(db, state, events, baseline.hash);
  if (!independence.ok) {
    // 缺失/非法的 assurance 也是 fail-closed（`independence_missing` / `assurance_invalid`），
    // 不默认成 15m 放行；这些码都能从 baseline + 事件直接复算。
    const codes = ['independence_unsatisfied', 'cooldown_active', 'independence_missing', 'assurance_invalid'];
    const reason = codes.includes(independence.reason_code ?? '') ? independence.reason_code : 'independence_unsatisfied';
    evaluation = {
      ...evaluation,
      verdict: 'changes_requested',
      reasons: [...new Set([...evaluation.reasons, reason ?? 'independence_unsatisfied'])],
    };
  }
  // M2 只支持每 stage 单 gate；与 evaluate 的 `multiple_gates_unsupported` 口径一致，
  // 在这里结构化拒（compile 里的 throw 只是防御性不可达）。
  if (evaluation.reasons.includes('multiple_gates_unsupported')) {
    return { ...fail('multiple_gates_unsupported', evaluation.reasons.join('; ')), evaluation };
  }
  const payload = compileGateJudged(evaluation, request.stage_run_id);
  const validation = validateGateJudgedPayload(payload);
  if (!validation.ok) return { ...fail('invalid_field', validation.message), evaluation };
  const payloadHash = gateJudgedPayloadHash(validation.value);
  const eventId = `ev-gate-${request.stage_run_id}-${at}-${Math.random().toString(16).slice(2, 8)}`;
  mintGateJudgedAuthority(eventId, payloadHash, request.stage_run_id);
  const event = buildEvent(
    {
      id: eventId,
      at,
      actor: request.actor,
      kind: 'gate.judged',
      subject: request.stage_run_id,
      payload: { ...payload },
      caused_by: [],
      request_id: `gate:${request.stage_run_id}:${at}`,
    },
    chainHead(db),
  );
  const appended = appendAsTool(db, [event], request.actor);
  if (!appended.ok) {
    return { ...fail('append_failed', appended.message ?? appended.reason_code ?? 'append failed'), evaluation };
  }
  return { ok: true, event_id: eventId, evaluation };
}
