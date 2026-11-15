/**
 * M3-3 C5：独立性复算（纯函数 + 只读 DB 查询）。
 *
 * 判定必须能**从事件 + baseline 重算**，否则门禁红就只是 judge 时刻的不可复算开关。
 * 这里复用 `judge.ts` 的同一套判定给 verify 用；`compareProjections` 不受影响，
 * `VERIFIED_TABLES` 也不动（M2-2 边界）。
 */

import type { FoldState } from '../fold/types.js';
import type { VerifyDatabase, VerifyProblem } from '../verify-types.js';
import { judgeIndependence, signaturesForDecision, type SignedEventLike } from './judge.js';
import type { MatrixDualRow } from './policy.js';

interface EventLike extends SignedEventLike {
  readonly id: string;
  readonly kind: string;
}

export interface IndependenceCheckInput {
  readonly events: readonly EventLike[];
  readonly state: FoldState;
  readonly db: Pick<VerifyDatabase, 'prepare'>;
}

function rowsOf(result: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  return [];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 取 baseline 的 assurance：优先当前 head（无被引用者的最新一版），退化为最新 at。
 *
 * P1-1（第 1 轮评审）：这只用于**没有版本绑定**的旧口径/无绑定对象；
 * 判定具体对象时必须用 `baselineAssuranceBound()` 按版本取行。
 */
export function currentBaselineAssurance(state: FoldState): unknown {
  const rows = Object.values(state.tables.baseline);
  if (rows.length === 0) return undefined;
  const referenced = new Set<string>();
  for (const row of rows) {
    const prev = row['prev'];
    if (typeof prev === 'string') referenced.add(prev);
  }
  const heads = rows.filter((row) => !referenced.has(String(row['id'])));
  const candidates = heads.length > 0 ? heads : rows;
  const sorted = [...candidates].sort((left, right) => String(left['at'] ?? '').localeCompare(String(right['at'] ?? '')));
  return sorted[sorted.length - 1]?.['assurance'];
}

/**
 * 该 decision 绑定的 baseline 版本：冻结决策的签名载荷里有 `payload.baseline.hash`
 * （`decision_baseline` 经 D-062 铺到顶层）。非冻结类决策没有绑定，返回 null。
 */
export function decisionBaselineHash(state: FoldState, decisionId: string): string | null {
  const row = state.tables.decision[decisionId];
  if (row === undefined) return null;
  const payload = recordOf(row['payload']);
  const baseline = payload === undefined ? undefined : recordOf(payload['baseline']);
  const hash = baseline === undefined ? undefined : baseline['hash'];
  return typeof hash === 'string' && hash.length > 0 ? hash : null;
}

export interface BaselineAssuranceBinding {
  /** 实际采用的 assurance。 */
  readonly assurance: unknown;
  /** 命中的 baseline 版本 hash；回退时为 null。 */
  readonly bound_hash: string | null;
  /** true 表示没找到绑定版本、回退到 head（调用方必须显式标记，不允许静默）。 */
  readonly fallback: boolean;
}

/**
 * 按版本取 baseline 的 assurance（P1-1）。
 *
 * - 有绑定 hash 且行存在 ⇒ 用该行的 assurance（历史 decision / 旧 stage_run 的结论不随新版本翻转）；
 * - 有绑定 hash 但行不存在（旧库缺行）⇒ 回退 head 并置 `fallback=true`；
 * - 无绑定（非冻结类决策）⇒ 回退 head，`fallback=true` 但 `bound_hash=null`。
 */
export function baselineAssuranceBound(state: FoldState, baselineHash: string | null): BaselineAssuranceBinding {
  if (baselineHash !== null) {
    for (const row of Object.values(state.tables.baseline)) {
      if (String(row['hash'] ?? '') === baselineHash) {
        return { assurance: row['assurance'], bound_hash: baselineHash, fallback: false };
      }
    }
    return { assurance: currentBaselineAssurance(state), bound_hash: null, fallback: true };
  }
  return { assurance: currentBaselineAssurance(state), bound_hash: null, fallback: true };
}

export function verifyIndependenceChain(input: IndependenceCheckInput): VerifyProblem[] {
  const problems: VerifyProblem[] = [];
  const matrix = rowsOf(
    input.db.prepare('SELECT action, dual_human FROM right').all(),
  ).map((row) => ({ action: String(row['action']), dual_human: String(row['dual_human']) }) as MatrixDualRow);
  const actorRows = rowsOf(input.db.prepare("SELECT COUNT(*) AS n FROM actor WHERE kind = 'human'").all());
  const humanCountRaw = actorRows[0]?.['n'];
  const humanActorCount = typeof humanCountRaw === 'number' ? humanCountRaw : 0;

  // 同一条 decision 的签名事件按 subject 分组；只查 M3-3 关心的三类 kind。
  const decisionIds = new Set(
    input.events.filter((event) => event.kind === 'decision.signed').map((event) => event.subject),
  );
  for (const decisionId of decisionIds) {
    const row = input.state.tables.decision[decisionId];
    if (row === undefined) continue;
    const signatures = signaturesForDecision(input.events, decisionId);
    const mismatch = signatures.find((item) => item.payload_hash !== String(row['payload_hash'] ?? ''));
    if (mismatch !== undefined) {
      problems.push({
        code: 'independence_unverifiable',
        objectId: decisionId,
        detail: `decision ${decisionId} 的签名载荷 payload_hash 与 decision 行不一致（${mismatch.payload_hash} vs ${String(row['payload_hash'] ?? '')}）`,
      });
      continue;
    }
    const boundHash = decisionBaselineHash(input.state, decisionId);
    const binding = baselineAssuranceBound(input.state, boundHash);
    const check = judgeIndependence({
      decision_kind: String(row['decision_kind'] ?? ''),
      signatures,
      matrix,
      assurance: binding.assurance,
      human_actor_count: humanActorCount,
    });
    // 只有“本来有版本绑定、但库里缺那行”（旧库）才显式报 unbound；
    // 非冻结类决策（sign/rollback 等）没有版本绑定，按当前 head 判定并在 README 写明边界。
    if (boundHash !== null && binding.fallback && check.required) {
      problems.push({
        code: 'independence_baseline_unbound',
        objectId: decisionId,
        detail: `decision ${decisionId} 没有可解析的 baseline 版本（旧库缺行），独立性按当前 head 判定——结论不可复算到具体版本`,
      });
    }
    // P2-2：签名者必须能解析到 `actor` 表里的 human；未知 actor / 非 human 的签名不能算独立性证据。
    if (check.required && (check.ok || check.reason_code === 'independence_unsatisfied' || check.reason_code === 'cooldown_active')) {
      for (const signature of signatures) {
        const actorRow = rowsOf(
          input.db.prepare('SELECT kind FROM actor WHERE id = ?').all(signature.signer),
        )[0];
        if (actorRow === undefined || actorRow['kind'] !== 'human') {
          problems.push({
            code: 'independence_unverifiable',
            objectId: decisionId,
            detail: `decision ${decisionId} 的签名者 ${signature.signer} 不是已登记的 human actor`,
          });
        }
      }
    }
    // 策略缺失/非法（`independence_missing`/`assurance_invalid`）归门禁的 fail-closed 判定，
    // verify 只复算“签名证据是否支撑独立性”，避免把 M3-3 前的旧 baseline（无 assurance）
    // 全部判红。
    if (!check.ok && check.reason_code === 'independence_unverifiable') {
      problems.push({
        code: 'independence_unverifiable',
        objectId: decisionId,
        detail: `${String(row['decision_kind'] ?? '')}：${check.message}`,
      });
    }
    if (!check.ok && (check.reason_code === 'independence_unsatisfied' || check.reason_code === 'cooldown_active')) {
      problems.push({
        code: 'independence_unsatisfied',
        objectId: decisionId,
        detail: `${String(row['decision_kind'] ?? '')}：${check.message}（signers=${String(check.distinct_signers)}${check.reason_code === undefined ? '' : `，${check.reason_code}`}）`,
      });
    }
  }
  return problems;
}
