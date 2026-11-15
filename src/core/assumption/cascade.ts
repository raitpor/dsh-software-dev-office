/**
 * M2-3 C6：撤销级联（docs/06:189、docs/09:316）。
 *
 * 撤销一条 `decision(kind='assumption_set')` ⇒ 由它投影出来的处置失效：
 * 覆盖的假设回到 `open`（可再签），`decision_id`/`successor_ref`/`disposed_at` 清空，
 * 同时留 `invalidated_reason='decision revoked'` + `invalidated_at` 供审计。
 *
 * 不新增 fold state 字段：级联是撤销事件在 fold 里的**纯派生结果**，重放同一串事件必得同一
 * 投影（幂等），`verify` 用同一条链复算即可发现篡改（卡 A1/文档 docs/03:56 的派生口径）。
 * spec_set / baseline 撤销的“受保护判定回待重验”由判据求值（signed+valid 过滤）与
 * `verifyBaselineReferences` 覆盖，不在这里复制一套状态。
 */

import { upsert } from '../fold/guards.js';
import type { Event, FoldWorking } from '../fold/types.js';

export interface AssumptionCascadeResult {
  /** 被级联回 open 的假设 id（排序后返回，测试/审计可读）。 */
  readonly reopened: readonly string[];
}

export function applyAssumptionSetRevocation(
  state: FoldWorking,
  event: Event,
  decisionId: string,
): AssumptionCascadeResult {
  const reopened: string[] = [];
  for (const [id, row] of Object.entries(state.tables.spec)) {
    if (row['kind'] !== 'assumption') continue;
    if (row['decision_id'] !== decisionId) continue;
    const status = row['status'];
    if (status === 'open' || status === 'invalidated') continue;
    upsert(state, 'spec', id, {
      ...row,
      status: 'open',
      decision_id: null,
      successor_ref: null,
      disposed_at: null,
      invalidated_reason: 'decision revoked',
      invalidated_at: event.at,
    });
    reopened.push(id);
  }
  reopened.sort();
  return { reopened };
}
