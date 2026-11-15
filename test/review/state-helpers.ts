/**
 * M2-4 纯函数测试的 fold 状态夹具。
 *
 * 生产里 `stage_run.criteria` 的判定读数由 M2-2 `judgeStage()` 真路径产生（写网关对裸
 * `gate.judged` fail-closed，没有测试缝）。本卡的模块是纯只读函数，测试直接给 fold 记忆态，
 * 语义与真链一致；端到端写路径是 M2-2 的用例责任，不在这里重复造第二套。
 */
import type { FoldState, Row } from '../../src/core/fold/types.js';

export function makeState(tables: Record<string, Record<string, Row>>): FoldState {
  const full: Record<string, Record<string, Row>> = {};
  for (const name of ['decision', 'baseline', 'task', 'spec', 'criterion', 'criterion_fixture', 'evidence', 'stage_run', 'review_round', 'review', 'redteam']) {
    full[name] = tables[name] ?? {};
  }
  return {
    eventIds: [],
    seen: new Set<string>(),
    tables: full as unknown as FoldState['tables'],
    inputs: {},
    invalidatedKeys: new Set<string>(),
  } as unknown as FoldState;
}

export function specRow(id: string, kind: string, at: string, revisedAt: string | null = null): Row {
  return {
    id,
    kind,
    intent_id: 'INT-1',
    clause: `${id} 的条款`,
    mech_checkable: false,
    scenario_id: null,
    is_core: false,
    status: kind === 'assumption' ? 'open' : null,
    blast_radius: null,
    created_by: 'alice',
    producer: 'model-1',
    content_hash: `ch:${id}`,
    risk_flags: [],
    alternatives: [],
    no_alternative_reason: null,
    at,
    revised_at: revisedAt,
  };
}

export function taskRow(id: string, seq: number, inputs: readonly string[], extra: Row = {}): Row {
  return {
    id,
    seq,
    title: id,
    kind: 'implement',
    created_by: 'alice',
    producer: 'model-1',
    owner: null,
    status: 'planned',
    blocked_by: [],
    scope_paths: [],
    inputs: [...inputs],
    subject_kind: null,
    subject_id: null,
    block_code: null,
    at: '2026-11-14T09:00:00Z',
    ...extra,
  };
}

export interface ReadingSeed {
  readonly criterion: string;
  readonly verdict: 'pass' | 'fail' | 'na';
}

export function stageRow(id: string, judgedAt: string, readings: readonly ReadingSeed[]): Row {
  return {
    id,
    stage: 'req',
    gate_id: 'G_req_exit',
    baseline_hash: 'sha256:bl-waterfall',
    entered_at: '2026-11-14T09:30:00Z',
    exited_at: judgedAt,
    verdict: 'changes_requested',
    criteria: readings.map((reading) => ({
      criterion_id: reading.criterion,
      verdict: reading.verdict,
      reason_code: reading.verdict === 'na' ? 'not_enforced_in_m2' : 'judged',
      effective: true,
      binding_reasons: [],
      reasons: [],
    })),
    judged_at: judgedAt,
    at: '2026-11-14T09:30:00Z',
  };
}

export function criterionRow(id: string, specId: string): Row {
  return { id, spec_id: specId, kind: 'functional', status_enum: 'pass', remedy: 'fix it', at: '2026-11-13T00:00:00Z' };
}
