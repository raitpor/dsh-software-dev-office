import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fold } from '../../../src/core/fold/index.js';
import type { FoldState } from '../../../src/core/fold/types.js';
import { evaluateReviewRequired, reviewRequirement } from '../../../src/core/review/index.js';
import { readEvents } from '../../../src/core/verify-events.js';
import type { VerifyProblem } from '../../../src/core/verify-types.js';
import type { SdoDatabase } from '../../../src/db/driver.js';
import { appendSeeds, ev, seedBase, withPmDb } from '../../core/pm/helpers.js';
import { makeState, specRow, taskRow } from '../../review/state-helpers.js';

const REVIEW = { sample_every: 5, sample_seed: 7 } as const;

function stateOf(db: SdoDatabase): FoldState {
  const problems: VerifyProblem[] = [];
  const events = readEvents(db, problems);
  assert.deepEqual(problems, [], 'fixture event chain must be valid');
  return fold(undefined, events);
}

function created(db: SdoDatabase, taskId: string, seq: number, extra: Record<string, unknown> = {}): void {
  appendSeeds(db, [
    ev('task.created', taskId, {
      seq,
      title: taskId,
      kind: 'implement',
      created_by: 'alice',
      producer: 'model-1',
      ...extra,
    }),
  ]);
}

function passRound(db: SdoDatabase, roundId: string, taskId: string, signer: string): void {
  appendSeeds(db, [
    ev('review.round_closed', roundId, {
      task_id: taskId,
      verdict: 'pass',
      baseline_hash: 'b-old',
      frontier: 'f-old',
      signer,
    }),
  ]);
}

test('C3 抽样命中（seq=7, 5/7）但没有 review_round ⇒ fail no_review_round', () => {
  withPmDb((db) => {
    seedBase(db);
    created(db, 'T-SAMPLED', 7, { inputs: ['criterion:CRIT-1'] });
    const result = evaluateReviewRequired(stateOf(db), 'T-SAMPLED', REVIEW);
    assert.equal(result.verdict, 'fail');
    assert.deepEqual(result.triggers, ['sampled']);
    assert.deepEqual(result.reasons, ['no_review_round']);
  });
});

test('C3 有 pass round 且绑评审时点版本 ⇒ pass（库里没有 baseline 行，证明不与当前 baseline 重比）', () => {
  withPmDb((db) => {
    seedBase(db);
    created(db, 'T-OK', 7, { inputs: ['criterion:CRIT-1'] });
    passRound(db, 'RR-OK', 'T-OK', 'reviewer-1');
    const state = stateOf(db);
    assert.deepEqual(Object.keys(state.tables.baseline), [], 'fixture must have no baseline row');
    const result = evaluateReviewRequired(state, 'T-OK', REVIEW);
    assert.equal(result.verdict, 'pass');
    assert.equal(result.round_id, 'RR-OK');
    assert.deepEqual(result.reasons, ['review_round_pass']);
  });
});

test('C3 reviewer 不能是 subject_producer', () => {
  withPmDb((db) => {
    seedBase(db);
    created(db, 'T-SELF', 7, { inputs: ['criterion:CRIT-1'], producer: 'self-reviewer' });
    passRound(db, 'RR-SELF', 'T-SELF', 'self-reviewer');
    const result = evaluateReviewRequired(stateOf(db), 'T-SELF', REVIEW);
    assert.equal(result.verdict, 'fail');
    assert.deepEqual(result.reasons, ['reviewer_is_subject_producer']);
  });
});

test('C3 四个触发条件：risk_flags / design|contract / release 相关', () => {
  withPmDb((db) => {
    seedBase(db);
    appendSeeds(db, [ev('spec.revised', 'SPEC-1', { reason: 'risk flagged', risk_flags: ['security'] })]);
    created(db, 'T-RISK', 3, { inputs: ['criterion:CRIT-1'] });
    assert.deepEqual(reviewRequirement(stateOf(db), 'T-RISK', REVIEW).triggers, ['risk_flags']);
    assert.equal(evaluateReviewRequired(stateOf(db), 'T-RISK', REVIEW).verdict, 'fail');

    appendSeeds(db, [
      ev('spec.defined', 'D-1', {
        kind: 'design',
        clause: 'D-1 的设计',
        intent_id: 'INT-1',
        content_hash: 'ch:D-1',
      }),
    ]);
    created(db, 'T-DESIGN', 8, { inputs: ['design:D-1'] });
    assert.deepEqual(reviewRequirement(stateOf(db), 'T-DESIGN', REVIEW).triggers, ['design_or_contract']);

    created(db, 'T-RELEASE', 9, { inputs: ['release:REL-1'] });
    assert.deepEqual(reviewRequirement(stateOf(db), 'T-RELEASE', REVIEW).triggers, ['release_related']);
  });
});

test('C7 评审卡自身不适用 review.required（na，避免递归）', () => {
  withPmDb((db) => {
    seedBase(db);
    created(db, 'T-REVIEW', 7, { kind: 'review', inputs: ['criterion:CRIT-1'] });
    const result = evaluateReviewRequired(stateOf(db), 'T-REVIEW', REVIEW);
    assert.equal(result.verdict, 'na');
    assert.deepEqual(result.reasons, ['review_card_excluded']);
    assert.equal(reviewRequirement(stateOf(db), 'T-REVIEW', REVIEW).required, false);
  });
});

test('C3 未触发任何条件 ⇒ na not_required（低风险卡不强制评审）', () => {
  withPmDb((db) => {
    seedBase(db);
    created(db, 'T-LOW', 8, { inputs: ['spec:SPEC-1'] });
    const result = evaluateReviewRequired(stateOf(db), 'T-LOW', REVIEW);
    assert.equal(result.verdict, 'na');
    assert.deepEqual(result.reasons, ['not_required']);
  });
});

test('P3-4 防御：round.signer 为空不算 pass（手写 fold 状态）', () => {
  const state = makeState({
    task: { T1: taskRow('T1', 8, ['spec:SPEC-1'], { producer: 'model-1' }) },
    spec: { 'SPEC-1': { ...specRow('SPEC-1', 'requirement', '2026-11-13T00:00:00Z'), risk_flags: ['security'] } },
    review_round: {
      'RR-EMPTY': {
        id: 'RR-EMPTY',
        task_id: 'T1',
        baseline_hash: 'b-old',
        frontier: 'f-old',
        verdict: 'pass',
        signer: '',
        at: '2026-11-14T10:00:00Z',
      },
    },
  });
  const result = evaluateReviewRequired(state, 'T1', REVIEW);
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.reasons, ['round_not_bound']);
});

test('P3-2 round 按真实时刻取最新（带 -05:00 偏移，字符串序会选错）', () => {
  withPmDb((db) => {
    seedBase(db);
    appendSeeds(db, [ev('spec.revised', 'SPEC-1', { reason: 'risk flagged', risk_flags: ['security'] })]);
    created(db, 'T-TZ', 3, { inputs: ['criterion:CRIT-1'] });
    appendSeeds(db, [
      ev('review.round_closed', 'RR-Z', {
        task_id: 'T-TZ',
        verdict: 'pass',
        baseline_hash: 'b-1',
        frontier: 'f-1',
        signer: 'reviewer-z',
      }, { at: '2026-11-14T14:00:00Z' }),
      ev('review.round_closed', 'RR-OFFSET', {
        task_id: 'T-TZ',
        verdict: 'pass',
        baseline_hash: 'b-2',
        frontier: 'f-2',
        signer: 'reviewer-offset',
      }, { at: '2026-11-14T09:30:00-05:00' }),
    ]);
    const result = evaluateReviewRequired(stateOf(db), 'T-TZ', REVIEW);
    assert.equal(result.verdict, 'pass');
    assert.equal(result.round_id, 'RR-OFFSET');
  });
});

test('P2-1 调用层传真实 kind：review/未知 kind 的任务不按工作 kind 公式入样', () => {
  const reviewState = makeState({
    task: { 'T-REVIEW-KIND': taskRow('T-REVIEW-KIND', 7, ['criterion:CRIT-1'], { kind: 'review' }) },
    criterion: { 'CRIT-1': { id: 'CRIT-1', spec_id: 'SPEC-1', kind: 'functional', status_enum: 'pass', remedy: 'fix it', at: '2026-11-13T00:00:00Z' } },
  });
  assert.deepEqual(reviewRequirement(reviewState, 'T-REVIEW-KIND', REVIEW).triggers, []);
  const unknownState = makeState({
    task: { 'T-UNKNOWN-KIND': taskRow('T-UNKNOWN-KIND', 7, ['criterion:CRIT-1'], { kind: 'audit' }) },
    criterion: { 'CRIT-1': { id: 'CRIT-1', spec_id: 'SPEC-1', kind: 'functional', status_enum: 'pass', remedy: 'fix it', at: '2026-11-13T00:00:00Z' } },
  });
  assert.deepEqual(reviewRequirement(unknownState, 'T-UNKNOWN-KIND', REVIEW).triggers, [], '未知 kind 不能落到工作 kind 的抽样公式');
  // 真实工作 kind 仍入样（C3 的 seq=7 用例走 DB 的 implement）
  const implementState = makeState({
    task: { 'T-IMPL': taskRow('T-IMPL', 7, ['criterion:CRIT-1'], { kind: 'implement' }) },
    criterion: { 'CRIT-1': { id: 'CRIT-1', spec_id: 'SPEC-1', kind: 'functional', status_enum: 'pass', remedy: 'fix it', at: '2026-11-13T00:00:00Z' } },
  });
  assert.deepEqual(reviewRequirement(implementState, 'T-IMPL', REVIEW).triggers, ['sampled']);
});
