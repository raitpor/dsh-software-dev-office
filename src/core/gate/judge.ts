/**
 * M2-2 判定入口：纯逻辑的 compile（把 GateEvaluation 变成 gate.judged 事件载荷）。
 * 落库由 `src/db/gate.ts` 负责；core 不反向 import src/db。
 */
import type { GateEvaluation } from './types.js';

export interface GateJudgedPayload {
  readonly stage_run_id: string;
  readonly gate_id: string;
  readonly baseline_hash: string;
  readonly verdict: GateEvaluation['verdict'];
  readonly criteria: GateEvaluation['readings'];
  readonly reasons: readonly string[];
}

export function compileGateJudged(evaluation: GateEvaluation, stageRunId: string): GateJudgedPayload {
  if (evaluation.gate_ids.length > 1) {
    throw new Error(`compileGateJudged: M2 supports a single gate per stage (got ${evaluation.gate_ids.join(', ')})`);
  }
  return {
    stage_run_id: stageRunId,
    gate_id: evaluation.gate_ids[0] ?? '',
    baseline_hash: evaluation.baseline_hash,
    verdict: evaluation.verdict,
    criteria: evaluation.readings,
    reasons: evaluation.reasons,
  };
}
