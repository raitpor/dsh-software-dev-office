import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateBaseline } from '../../../src/core/baseline/index.js';
import { mutatedFixture, sortedCodes, validateFixture } from '../../core/baseline/helpers.js';

test('C2 合法 baseline 的 policy.review 不产生 review_params_invalid', () => {
  const result = validateFixture('waterfall');
  assert.equal(result.reason_codes.includes('review_params_invalid'), false, sortedCodes(result).join(','));
});

test('C2 越界参数由 P15 报 review_params_invalid（本卡只消费，不重写）', () => {
  const cases: Array<[string, (review: Record<string, unknown>) => void]> = [
    ['sample_every=0', (review) => { review['sample_every'] = 0; }],
    ['sample_every=1', (review) => { review['sample_every'] = 1; }],
    ['sample_every=11', (review) => { review['sample_every'] = 11; }],
    ['sample_every=2.5', (review) => { review['sample_every'] = 2.5; }],
    ['sample_seed=2.5', (review) => { review['sample_seed'] = 2.5; }],
  ];
  for (const [label, mutate] of cases) {
    const doc = mutatedFixture('waterfall', (root) => {
      const policy = root['policy'];
      if (policy === null || typeof policy !== 'object') assert.fail('fixture has no policy');
      const review = (policy as Record<string, unknown>)['review'];
      if (review === null || typeof review !== 'object') assert.fail('fixture has no policy.review');
      mutate(review as Record<string, unknown>);
    });
    const result = validateBaseline(doc);
    assert.equal(result.ok, false, `${label}: fixture must be rejected`);
    assert.equal(
      result.reason_codes.includes('review_params_invalid'),
      true,
      `${label}: expected review_params_invalid, got ${sortedCodes(result).join(',')}`,
    );
  }
});
