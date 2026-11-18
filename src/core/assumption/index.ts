import { CODE } from '../errors/codes.js';
/**
 * M2-3 假设处置链的纯函数层（docs/03:66-77、docs/04 §5.2、docs/06:189）。
 *
 * 三条硬口径（卡 C1/C2/C9）：
 * 1. 处置授权只认**签名载荷**的 `dispositions[]`；事件 payload 自带覆盖名单一律不可信
 *    （M1-0 第 52 轮评审洞），fold 对自带名单直接拒。
 * 2. 非 `open` 状态必须能由一条有效、已签名的 `decision(kind='assumption_set')` 复算：
 *    该 decision 的 `spec_ids` 覆盖假设、`dispositions[]` 的处置与行状态一致（条件②）。
 * 3. 一条假设都没有时也要签空集（docs/04 §5.2），判据侧由 `signed` 数量兜住。
 *
 * 本模块只做结构与状态校验，不碰 fs/db；`src/db/assumption.ts` 负责渲染与批量写。
 */

import type { FoldState, Row } from '../fold/types.js';

export const DISPOSITIONS = ['confirmed', 'rejected', 'converted'] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

export interface DispositionEntry {
  readonly spec_id: string;
  readonly disposition: Disposition;
  readonly successor_ref?: string;
}

export type DispositionParse =
  | { readonly ok: true; readonly entries: readonly DispositionEntry[] }
  | { readonly ok: false; readonly message: string };

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function isDisposition(value: unknown): value is Disposition {
  return typeof value === 'string' && (DISPOSITIONS as readonly string[]).includes(value);
}

/** 严格解析单条 disposed 名单：`spec_id` + 合法 `disposition`，可选 `successor_ref`。 */
export function parseDispositionEntry(raw: unknown): DispositionEntry | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const specId = record['spec_id'];
  const disposition = record['disposition'];
  if (typeof specId !== 'string' || specId.length === 0) return undefined;
  if (!isDisposition(disposition)) return undefined;
  const successor = record['successor_ref'];
  if (successor !== undefined && successor !== null && typeof successor !== 'string') return undefined;
  return typeof successor === 'string'
    ? { spec_id: specId, disposition, successor_ref: successor }
    : { spec_id: specId, disposition };
}

/**
 * 解析签名载荷里的 `dispositions[]`。缺失 ⇒ 空数组（只可能是空集签字）；
 * 存在但不是数组、或任一条不合法 ⇒ 结构化失败（调用方必须拒，不许静默跳过）。
 */
export function parseDispositionsStrict(value: unknown): DispositionParse {
  if (value === undefined || value === null) return { ok: true, entries: [] };
  if (!Array.isArray(value)) return { ok: false, message: 'payload.dispositions must be an array' };
  const entries: DispositionEntry[] = [];
  for (const [index, raw] of value.entries()) {
    const entry = parseDispositionEntry(raw);
    if (entry === undefined) {
      return { ok: false, message: `payload.dispositions[${index}] must be { spec_id, disposition, successor_ref? }` };
    }
    entries.push(entry);
  }
  return { ok: true, entries };
}

/** 宽松读取（判据/verify 已 fold 过一遍，不合法条目视为未覆盖）。 */
export function dispositionEntries(payload: Record<string, unknown> | undefined): readonly DispositionEntry[] {
  if (payload === undefined) return [];
  const parsed = parseDispositionsStrict(payload['dispositions']);
  return parsed.ok ? parsed.entries : [];
}

/** 签名载荷对某条假设的处置（只认 dispositions[]；没有就是没覆盖）。 */
export function dispositionFor(payload: Record<string, unknown> | undefined, specId: string): Disposition | undefined {
  return dispositionEntries(payload).find((entry) => entry.spec_id === specId)?.disposition;
}

export function specIdsOfDecision(row: Row): readonly string[] {
  const payload = row['payload'];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const ids = (payload as Record<string, unknown>)['spec_ids'];
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

export function assumptionRows(state: FoldState): readonly Row[] {
  return Object.values(state.tables.spec).filter((row) => row['kind'] === 'assumption');
}

/** 有效、已签名的 decision(kind)；`frontier` 绑定由调用方另行核对。 */
export function signedDecisionsOfKind(state: FoldState, kind: string): readonly Row[] {
  return Object.values(state.tables.decision).filter(
    (row) =>
      row['decision_kind'] === kind &&
      row['status'] === 'valid' &&
      text(row['signature']).length > 0 &&
      text(row['key_id']).length > 0 &&
      text(row['signer']).length > 0,
  );
}

/** 覆盖名单的唯一实现（P3-③ 第 2 轮）：从已签 decision 的 `spec_ids[]` 取并集。
 *  gate 与 check 都调这里，M2-4 接入前不再各写一份。 */
export function coveredSpecIdsFromDecisions(decisions: readonly Row[]): readonly string[] {
  const ids = new Set<string>();
  for (const decision of decisions) for (const id of specIdsOfDecision(decision)) ids.add(id);
  return [...ids].sort();
}

/** 按 kind 取“已签 decision 的覆盖名单”（gate/check 共用入口）。 */
export function coveredSpecIdsOfSigned(state: FoldState, kind: string): readonly string[] {
  return coveredSpecIdsFromDecisions(signedDecisionsOfKind(state, kind));
}

/** 未签覆盖的假设 id（按 spec_ids 口径；C9 的覆盖检查）。 */
export function assumptionCoverageMissing(state: FoldState, covered: ReadonlySet<string>): readonly string[] {
  return assumptionRows(state)
    .map((row) => text(row['id']))
    .filter((id) => id.length > 0 && !covered.has(id))
    .sort();
}



export interface AssumptionStatusProblem {
  readonly code: AssumptionStatusProblemCode;
  readonly spec_id: string;
  readonly detail: string;
}

/**
 * docs/04 §5.2 条件①②：没有 open 假设；每条非 open 状态都由**有效已签** decision 投影，
 * 且该 decision 的 `dispositions[]` 与行状态一致（不是只看 `decision_id` 非空）。
 */
export function validateAssumptionStatuses(state: FoldState): readonly AssumptionStatusProblem[] {
  const problems: AssumptionStatusProblem[] = [];
  const rows = [...assumptionRows(state)].sort((a, b) => text(a['id']).localeCompare(text(b['id'])));
  for (const row of rows) {
    const id = text(row['id']);
    const status = text(row['status']);
    if (status === 'open' || status === 'invalidated') {
      problems.push({ code: 'open_assumption', spec_id: id, detail: `assumption ${id} is ${status || 'unset'}` });
      continue;
    }
    if (!isDisposition(status)) {
      problems.push({ code: 'assumption_status_not_backed', spec_id: id, detail: `unknown status ${status}` });
      continue;
    }
    const decisionId = text(row['decision_id']);
    if (decisionId.length === 0) {
      problems.push({ code: 'assumption_status_not_backed', spec_id: id, detail: `assumption ${id} has no decision_id` });
      continue;
    }
    const decision = state.tables.decision[decisionId];
    if (decision === undefined) {
      problems.push({ code: 'assumption_status_not_backed', spec_id: id, detail: `decision ${decisionId} missing` });
      continue;
    }
    const payload = decision['payload'];
    const record = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
    const backed =
      decision['decision_kind'] === 'assumption_set' &&
      decision['status'] === 'valid' &&
      text(decision['signature']).length > 0 &&
      specIdsOfDecision(decision).includes(id) &&
      dispositionFor(record, id) === status;
    if (!backed) {
      problems.push({
        code: 'assumption_status_not_backed',
        spec_id: id,
        detail: `assumption ${id} status ${status} is not backed by signed decision ${decisionId}`,
      });
    }
  }
  return problems;
}


export const AssumptionStatusProblemCode_CODES = [
  CODE.assumption_status_not_backed,
  CODE.open_assumption,
] as const;
export type AssumptionStatusProblemCode = (typeof AssumptionStatusProblemCode_CODES)[number];
