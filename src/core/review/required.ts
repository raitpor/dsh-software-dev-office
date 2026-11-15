/**
 * M2-4 C3/C7 · `review.required` 判据的求值（纯函数）。
 *
 * `docs/04` §4：满足任一条件的卡必须有 `review_round`——
 * `risk_flags` 非空 / 实现 `spec(kind∈{design,contract})` / 与 release 相关 / 被抽样命中；
 * 且该 round `verdict='pass'`、`reviewer ≠ subject_producer`、绑**评审时点**的
 * `baseline_hash`/`frontier`（收口时**不**与当前 baseline 重比，否则每次换尺子都重审）。
 *
 * 本模块不写判定行：判定行由 M2-2 门禁在 `review.required` 求值时写 `gate.judged`。
 */
import type { FoldState, Row } from '../fold/types.js';
import { referencedSpecIds, referencesRelease } from './refs.js';
import { isSampled, type ReviewPolicy } from './sample.js';

export type ReviewTrigger = 'risk_flags' | 'design_or_contract' | 'release_related' | 'sampled';

export interface ReviewRequirement {
  readonly required: boolean;
  readonly triggers: readonly ReviewTrigger[];
}

export type ReviewRequiredVerdict = 'pass' | 'fail' | 'na';

export interface ReviewRequiredResult {
  readonly verdict: ReviewRequiredVerdict;
  readonly required: boolean;
  readonly triggers: readonly ReviewTrigger[];
  readonly reasons: readonly string[];
  readonly round_id?: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function hasRiskFlags(row: Row): boolean {
  const flags = row['risk_flags'];
  return Array.isArray(flags) && flags.length > 0;
}

/** C3 的前置：这张卡是否属于“必须评审”的任意一类（C7：评审卡自身不算）。 */
export function reviewRequirement(state: FoldState, taskId: string, review: ReviewPolicy): ReviewRequirement {
  const task = state.tables.task[taskId];
  if (task === undefined || task['kind'] === 'review') return { required: false, triggers: [] };
  const triggers: ReviewTrigger[] = [];
  const specs = referencedSpecIds(state, taskId).map((id) => state.tables.spec[id]).filter((row): row is Row => row !== undefined);
  if (specs.some(hasRiskFlags)) triggers.push('risk_flags');
  if (specs.some((row) => row['kind'] === 'design' || row['kind'] === 'contract')) triggers.push('design_or_contract');
  if (referencesRelease(state, taskId)) triggers.push('release_related');
  const seq = task['seq'];
  if (typeof seq === 'number' && isSampled(seq, text(task['kind']), review)) triggers.push('sampled');
  return { required: triggers.length > 0, triggers };
}

/** ISO 字符串按真实时刻比较（带 `+05:00`/`-05:00` 偏移时字符串序会错）；不可解析排最前。 */
function timeMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function roundsOf(state: FoldState, taskId: string): Row[] {
  return Object.values(state.tables.review_round)
    .filter((row) => row['task_id'] === taskId)
    .sort(
      (left, right) =>
        timeMs(text(left['at'])) - timeMs(text(right['at'])) || text(left['id']).localeCompare(text(right['id'])),
    );
}

function isBound(round: Row): boolean {
  return (
    text(round['signer']).length > 0 &&
    text(round['baseline_hash']).length > 0 &&
    text(round['frontier']).length > 0
  );
}

/**
 * C3：`review.required` 三态。
 *
 * - 评审卡 ⇒ `na`（C7，避免递归）；未触发任一条件 ⇒ `na`（低风险卡不需要评审）。
 * - 有 pass round、`signer ≠ subject_producer`、round 绑了评审时点版本 ⇒ `pass`。
 * - round 的 `baseline_hash` **不**与 `state.tables.baseline` 的当前 head 比较：
 *   这里根本不读 baseline 表——这是 C3 的“收口不重比”的结构性保证。
 */
export function evaluateReviewRequired(
  state: FoldState,
  taskId: string,
  review: ReviewPolicy,
): ReviewRequiredResult {
  const task = state.tables.task[taskId];
  if (task === undefined) {
    return { verdict: 'fail', required: false, triggers: [], reasons: ['task_not_found'] };
  }
  if (task['kind'] === 'review') {
    return { verdict: 'na', required: false, triggers: [], reasons: ['review_card_excluded'] };
  }
  const requirement = reviewRequirement(state, taskId, review);
  if (!requirement.required) {
    return { verdict: 'na', required: false, triggers: [], reasons: ['not_required'] };
  }
  const subjectProducer = text(task['producer']) || text(task['created_by']);
  const rounds = roundsOf(state, taskId);
  const passing = rounds.filter((round) => round['verdict'] === 'pass');
  const acceptable = passing.filter(
    (round) => isBound(round) && text(round['signer']) !== subjectProducer,
  );
  const accepted = acceptable[acceptable.length - 1];
  if (accepted !== undefined) {
    return {
      verdict: 'pass',
      required: true,
      triggers: requirement.triggers,
      reasons: ['review_round_pass'],
      round_id: text(accepted['id']),
    };
  }
  let reason = 'no_review_round';
  if (rounds.length > 0 && passing.length === 0) reason = 'no_pass_round';
  else if (passing.length > 0) {
    reason = passing.some((round) => text(round['signer']) !== subjectProducer)
      ? 'round_not_bound'
      : 'reviewer_is_subject_producer';
  }
  return { verdict: 'fail', required: true, triggers: requirement.triggers, reasons: [reason] };
}
