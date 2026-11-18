import { CODE } from '../errors/codes.js';
/**
 * M2-3 C8：`assumption.disposed` 投影与事件链的双向核对。
 *
 * 方向一（decision → 事件）：每条有效、已签的 `decision(kind='assumption_set')`，其载荷
 * `dispositions[]` 每一条都必须有对应的 `assumption.disposed` 事件（同 decision_id、同处置）。
 * 缺 ⇒ `assumption_disposition_missing`（fold 重放不影响结论，缺就是缺）。
 *
 * 方向二（投影 → decision）：每条非 open 的假设行必须由**有效已签** decision 支撑，且存在
 * 对应 disposed 事件；否则 `assumption_decision_invalid`（防手改投影行凭空造状态）。
 *
 * 撤销过的 decision 不要求它的 disposed 事件继续有效（C6 已把行级联回 open，事件保留审计）。
 */

import type { Event, FoldState, Row } from '../fold/types.js';
import { dispositionEntries, dispositionFor, isDisposition, specIdsOfDecision } from './index.js';

export const ASSUMPTION_VERIFY_PROBLEM_CODES = [
  CODE.assumption_decision_invalid,
  CODE.assumption_disposition_missing,
] as const;
export type AssumptionVerifyProblemCode = (typeof ASSUMPTION_VERIFY_PROBLEM_CODES)[number];

export interface AssumptionVerifyProblem {
  readonly code: AssumptionVerifyProblemCode;
  readonly table: 'spec' | 'decision';
  readonly objectId: string;
  readonly detail: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function eventPayload(event: Event): Record<string, unknown> {
  const payload = event.payload;
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

interface DisposedKey {
  readonly decision_id: string;
  readonly spec_id: string;
  readonly disposition: string;
}

function disposedEvents(events: readonly Event[]): readonly DisposedKey[] {
  const result: DisposedKey[] = [];
  for (const event of events) {
    if (event.kind !== 'assumption.disposed') continue;
    const payload = eventPayload(event);
    const decisionId = text(payload['decision_id']);
    const disposition = text(payload['disposition']);
    if (decisionId.length === 0 || disposition.length === 0) continue;
    result.push({ decision_id: decisionId, spec_id: event.subject, disposition });
  }
  return result;
}

export function verifyAssumptionChain(
  events: readonly Event[],
  state: FoldState,
): readonly AssumptionVerifyProblem[] {
  const problems: AssumptionVerifyProblem[] = [];
  const disposed = disposedEvents(events);
  const disposedKeys = new Set(disposed.map((item) => `${item.decision_id}|${item.spec_id}|${item.disposition}`));

  // 方向一：有效已签 assumption_set 的 dispositions[] 必须有对应事件。
  for (const [decisionId, decision] of Object.entries(state.tables.decision)) {
    if (decision['decision_kind'] !== 'assumption_set') continue;
    if (decision['status'] !== 'valid') continue;
    if (text(decision['signature']).length === 0) continue;
    for (const entry of dispositionEntries(
      decision['payload'] !== null && typeof decision['payload'] === 'object' && !Array.isArray(decision['payload'])
        ? (decision['payload'] as Record<string, unknown>)
        : {},
    )) {
      const key = `${decisionId}|${entry.spec_id}|${entry.disposition}`;
      if (!disposedKeys.has(key)) {
        problems.push({
          code: 'assumption_disposition_missing',
          table: 'decision',
          objectId: decisionId,
          detail: `decision ${decisionId} 覆盖 ${entry.spec_id}=${entry.disposition}，但没有对应的 assumption.disposed 事件`,
        });
      }
    }
  }

  // 方向二：非 open 行必须有有效已签 decision + 事件支撑。
  for (const [specId, row] of Object.entries(state.tables.spec)) {
    if (row['kind'] !== 'assumption') continue;
    const status = text(row['status']);
    if (!isDisposition(status)) continue;
    const decisionId = text(row['decision_id']);
    const decision = state.tables.decision[decisionId];
    const disposition = dispositionFor(
      decision?.['payload'] !== null && typeof decision?.['payload'] === 'object' && !Array.isArray(decision?.['payload'])
        ? (decision['payload'] as Record<string, unknown>)
        : {},
      specId,
    );
    const backed =
      decision !== undefined &&
      decision['decision_kind'] === 'assumption_set' &&
      decision['status'] === 'valid' &&
      text(decision['signature']).length > 0 &&
      specIdsOfDecision(decision as Row).includes(specId) &&
      disposition === status &&
      disposedKeys.has(`${decisionId}|${specId}|${status}`);
    if (!backed) {
      problems.push({
        code: 'assumption_decision_invalid',
        table: 'spec',
        objectId: specId,
        detail: `assumption ${specId} 状态 ${status} 不能由有效已签 decision(${decisionId || '(空)'}) 与 disposed 事件复算`,
      });
    }
  }

  return problems;
}
