import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TASK_KINDS } from '../../../src/core/fold/reducers/task.js';
import {
  SAMPLED_KINDS,
  isSampled,
  mathMod,
  reviewPolicyOf,
  sampledSeqs,
} from '../../../src/core/review/index.js';

const REVIEW = { sample_every: 5, sample_seed: 7 } as const;

test('C1 golden：sample_every=5、sample_seed=7 时 7/12/17 命中，可独立重算', () => {
  assert.deepEqual(sampledSeqs(REVIEW, 7, 17), [7, 12, 17]);
  assert.deepEqual(sampledSeqs(REVIEW, 1, 25), [2, 7, 12, 17, 22]);
  for (const seq of [7, 12, 17]) {
    assert.equal(isSampled(seq, 'implement', REVIEW), true, `seq ${seq} should be sampled`);
  }
  for (const seq of [8, 9, 10, 11]) {
    assert.equal(isSampled(seq, 'implement', REVIEW), false, `seq ${seq} should not be sampled`);
  }
});

test('C1 数学取模：负数归到 [0, modulus)，不是 JS 的 %', () => {
  assert.equal(mathMod(-1, 5), 4);
  assert.equal(mathMod(-5, 5), 0);
  assert.equal(mathMod(-6, 5), 4);
  if (-1 % 5 === 1) assert.fail('unexpected JS modulo');
  // 负序号区间只有数学取模为 0 的那个被抽中
  assert.deepEqual(sampledSeqs({ sample_every: 5, sample_seed: 0 }, -3, 3), [0]);
});

test('C7 评审卡恒不参与抽样', () => {
  for (const seq of [7, 12, 17, 22, 100]) {
    assert.equal(isSampled(seq, 'review', REVIEW), false);
  }
  const many = Array.from({ length: 20 }, (_, index) => 7 + index);
  assert.deepEqual(many.filter((seq) => isSampled(seq, 'review', REVIEW)), []);
});

test('C2 reviewPolicyOf 只做形状/边界消费，非法返回 undefined（不重写 P15）', () => {
  assert.deepEqual(reviewPolicyOf({ review: { sample_every: 5, sample_seed: 7 } }), REVIEW);
  for (const sample_every of [0, 1, 11, 2.5, '5', null]) {
    assert.equal(
      reviewPolicyOf({ review: { sample_every, sample_seed: 7 } }),
      undefined,
      `sample_every=${String(sample_every)} must be rejected`,
    );
  }
  assert.equal(reviewPolicyOf({ review: { sample_every: 5, sample_seed: 2.5 } }), undefined);
  assert.equal(reviewPolicyOf({}), undefined);
  assert.equal(isSampled(7, 'implement', { sample_every: 1, sample_seed: 7 }), false);
});

test('C1 入样白名单：implement/design/docs 入样；review/未知 kind/大小写变体不入样', () => {
  for (const kind of ['implement', 'design', 'docs']) {
    assert.equal(isSampled(7, kind, REVIEW), true, `kind ${JSON.stringify(kind)} 应入样`);
  }
  for (const kind of ['review', 'Review', 'REVIEW', 'bogus', '']) {
    assert.equal(isSampled(7, kind, REVIEW), false, `kind ${JSON.stringify(kind)}`);
    assert.deepEqual(sampledSeqs(REVIEW, 7, 17, kind), [], `sampledSeqs kind ${JSON.stringify(kind)}`);
  }
});

test('守卫：抽样白名单必须恒等于 TASK_KINDS \ {review}（任一边漂移即红）', () => {
  const expected = TASK_KINDS.filter((kind) => kind !== 'review');
  assert.deepEqual([...SAMPLED_KINDS].sort(), [...expected].sort(), '白名单与 TASK_KINDS 派生不一致');
  assert.equal(SAMPLED_KINDS.has('review'), false);
  for (const kind of TASK_KINDS) {
    assert.equal(SAMPLED_KINDS.has(kind), kind !== 'review', `kind ${kind}`);
  }
});
