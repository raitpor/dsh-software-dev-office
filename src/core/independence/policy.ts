import { CODE } from '../../core/errors/codes.js';
/**
 * M3-3 独立性策略（纯数据解析，无 IO）。
 *
 * docs/07 §7：独立性是**签字动作的属性**，等级来自 baseline 的
 * `assurance.independence`（在 baseline hash 内，是尺子不是部署旋钮）：
 *   - `dual_human`：T1/T2，同一 frontier 上两个不同 human 各签一次；
 *   - `solo_cooldown(Nm)`：T0 单人，首次签名后冷却 N 分钟（5–60，缺省 15）再二次确认；
 *   - `solo`：无独立性，不能作为发布证据。
 *
 * 哪些动作需要独立性来自 M3-0 的矩阵目录（`right.dual_human` 列），不在本文件写死：
 * 本文件只把 decision_kind 映射到矩阵动作，再由调用方把目录行传进来。
 */

export type IndependenceMode = 'dual_human' | 'solo_cooldown' | 'solo';

export interface IndependencePolicy {
  readonly mode: IndependenceMode;
  /** `solo_cooldown` 的冷却毫秒数；其余模式为 null。 */
  readonly cooldown_ms: number | null;
}

export type IndependencePolicyError = 'independence_missing' | 'assurance_invalid';

export type ParsedIndependencePolicy =
  | { readonly ok: true; readonly policy: IndependencePolicy }
  | { readonly ok: false; readonly reason_code: IndependencePolicyError; readonly message: string };

export const MIN_COOLDOWN_MINUTES = 5;
export const MAX_COOLDOWN_MINUTES = 60;
export const DEFAULT_COOLDOWN_MINUTES = 15;

/** decision_kind → M3-0 矩阵动作（只列需要独立性的三类；其余返回 null）。 */
export function decisionActionForKind(kind: string): string | null {
  switch (kind) {
    case 'baseline':
      // 冻结/豁免在文档矩阵里是同一个动作组；M2-1 的冻结决策用 decision_kind='baseline'。
      return 'freeze';
    case 'freeze':
      return 'freeze';
    case 'waiver':
      return 'waive';
    case 'rollback':
      return 'rollback';
    case 'sign':
      return 'revoke_decision';
    default:
      return null;
  }
}

const SOLO_COOLDOWN_PATTERN = /^solo_cooldown\(\s*(\d+)\s*m\s*\)$/;

/**
 * 解析 baseline 的 `assurance.independence`（docs/04 §5.1：唯一来源）。
 *
 * 形状：`dual_human` ｜ `solo_cooldown(<N>m)`（N 为 5–60 的整数分钟）｜ `solo`。
 * **fail-closed**：缺失 ⇒ `independence_missing`；形状/范围不对 ⇒ `assurance_invalid`。
 * 绝不默认成 15 分钟静默放行——缺省 15m 只是文档示例。
 */
export function parseIndependencePolicy(assurance: unknown): ParsedIndependencePolicy {
  const picked = pickIndependence(assurance);
  if (!picked.present) {
    return {
      ok: false,
      reason_code: CODE.independence_missing,
      message: 'baseline 的 assurance.independence 缺失，无法判定独立性',
    };
  }
  if (typeof picked.raw !== 'string' || picked.raw.trim().length === 0) {
    return {
      ok: false,
      reason_code: CODE.assurance_invalid,
      message: `assurance.independence 形状非法：${JSON.stringify(picked.raw)}（允许 dual_human / solo_cooldown(Nm) / solo）`,
    };
  }
  const raw = picked.raw.trim();
  if (raw === 'dual_human') return { ok: true, policy: { mode: 'dual_human', cooldown_ms: null } };
  if (raw === 'solo') return { ok: true, policy: { mode: 'solo', cooldown_ms: null } };
  const match = SOLO_COOLDOWN_PATTERN.exec(raw);
  if (match === null) {
    return {
      ok: false,
      reason_code: CODE.assurance_invalid,
      message: `assurance.independence 形状非法：${raw}（允许 dual_human / solo_cooldown(Nm) / solo）`,
    };
  }
  const minutes = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isInteger(minutes) || minutes < MIN_COOLDOWN_MINUTES || minutes > MAX_COOLDOWN_MINUTES) {
    return {
      ok: false,
      reason_code: CODE.assurance_invalid,
      message: `assurance.independence 冷却分钟数越界：${String(minutes)}（允许 ${String(MIN_COOLDOWN_MINUTES)}–${String(MAX_COOLDOWN_MINUTES)}）`,
    };
  }
  return { ok: true, policy: { mode: 'solo_cooldown', cooldown_ms: minutes * 60_000 } };
}

/**
 * baseline 行里的 `assurance` 可能是对象，也可能是 fold 投影后的 JSON 字符串
 * （行来自 materialize，TEXT 列）。两种都接受，但“有键无值”与“无键”要区分：
 * 前者是形状错（`assurance_invalid`），后者才是缺失（`independence_missing`）。
 */
function assuranceRecord(value: unknown): Record<string, unknown> | null {
  let current = value;
  if (typeof current === 'string') {
    try {
      current = JSON.parse(current) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) return null;
  return current as Record<string, unknown>;
}

function pickIndependence(value: unknown): { readonly present: boolean; readonly raw: unknown } {
  const record = assuranceRecord(value);
  if (record === null || !Object.hasOwn(record, 'independence')) return { present: false, raw: null };
  return { present: true, raw: record['independence'] };
}

/** 矩阵目录行（只依赖 M3-0 的 `right` 表字段，避免 core 依赖 db 模块）。 */
export interface MatrixDualRow {
  readonly action: string;
  readonly dual_human: string;
}

/** 该动作是否要求独立性；`dual_human === 'no'` 表示不需要。 */
export function requiresIndependence(matrix: readonly MatrixDualRow[], action: string): boolean | null {
  const row = matrix.find((entry) => entry.action === action);
  if (row === undefined) return null; // 未登记动作 ⇒ 调用方按 fail-closed 处理
  return row.dual_human !== 'no';
}

/**
 * 生效模式：矩阵说不需独立性 ⇒ `not_required`；需要时**完全以 baseline 策略为准**。
 * `dual_human` 在人不足时**不**静默降级为 solo_cooldown（那等于替用户改写尺子），
 * 而是由判定层判 `independence_unsatisfied` 并在 message 里提示“还需要 1 个不同 human”。
 */
export function effectiveMode(policy: IndependencePolicy): IndependenceMode {
  return policy.mode;
}

/** solo_cooldown 的冷却毫秒数；非该模式返回 null。 */
export function cooldownMsOf(policy: IndependencePolicy): number | null {
  return policy.mode === 'solo_cooldown' ? policy.cooldown_ms : null;
}
