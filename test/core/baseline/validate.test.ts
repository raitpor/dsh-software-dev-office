import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateBaseline } from '../../../src/core/baseline/index.js';
import type { Guarantee } from '../../../src/core/baseline/types.js';
import {
  loadFixture, mutatedFixture, sortedCodes, STRUCTURAL_DELTA, validateFixture,
} from './helpers.js';

type Doc = Record<string, unknown>;
const policyOf = (doc: Doc): Doc => doc['policy'] as Doc;
const stagesOf = (doc: Doc): Doc[] => policyOf(doc)['stages'] as Doc[];
const gateDefsOf = (doc: Doc): Doc[] => doc['gates'] as Doc[];
const policyGatesOf = (doc: Doc): Doc => policyOf(doc)['gates'] as Doc;
const assuranceOf = (doc: Doc): Doc => doc['assurance'] as Doc;

const missingFor = (result: { missing?: readonly { guarantee: Guarantee; criteria: readonly string[] }[] },
  guarantee: Guarantee): string[] =>
  [...(result.missing?.find((group) => group.guarantee === guarantee)?.criteria ?? [])].sort();

test('legal waterfall passes with no degradation', () => {
  const result = validateFixture('waterfall');
  assert.equal(result.ok, true);
  assert.deepEqual(sortedCodes(result), []);
  assert.deepEqual(result.guarantee_delta, { 1: 'kept', 2: 'kept', 3: 'kept' });
  assert.equal(result.missing, undefined);
});

test('legal lite passes but all three guarantees are degraded (P2-1)', () => {
  const result = validateFixture('lite.policy');
  assert.equal(result.ok, true);
  assert.deepEqual(sortedCodes(result), []);
  // 三条逐个断言：保证 2 也 degraded，因为 design.alternatives_declared 没有 design kind 阶段可绑。
  assert.deepEqual(result.guarantee_delta[1], 'degraded');
  assert.deepEqual(result.guarantee_delta[2], 'degraded');
  assert.deepEqual(result.guarantee_delta[3], 'degraded');
  assert.deepEqual(result.guarantee_delta, { 1: 'degraded', 2: 'degraded', 3: 'degraded' });
  assert.deepEqual(missingFor(result, 1),
    ['design.covers_spec', 'design.no_spec_creep', 'node.acceptance_bound', 'stage.design_traceable']);
  assert.deepEqual(missingFor(result, 2), ['design.alternatives_declared']);
  assert.deepEqual(missingFor(result, 3), ['review.required', 'review.round_bound']);
  const allMissing = (result.missing ?? []).flatMap((group) => group.criteria);
  assert.equal(allMissing.some((id) => id.startsWith('core:')), false, allMissing.join(','));
});

test('hand-written guarantee_delta is ignored', () => {
  const withHandwritten = validateFixture('hand-delta');
  const plain = validateFixture('waterfall');
  assert.deepEqual(withHandwritten.guarantee_delta, plain.guarantee_delta);
});

test('P2-4: structural failures produce exactly one code, fail-closed delta, no missing/cascade', () => {
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ['gate-policy-mode-bad', loadFixture('gate-policy-mode-bad'), 'invalid_baseline'],
    ['gate-waivable-string', loadFixture('gate-waivable-string'), 'invalid_baseline'],
    ['stage-after-string', loadFixture('stage-after-string'), 'invalid_baseline'],
    ['gate-criteria-nonstring', loadFixture('gate-criteria-nonstring'), 'invalid_baseline'],
    ['stages: []', mutatedFixture('waterfall', (doc) => { policyOf(doc)['stages'] = []; }), 'invalid_baseline'],
    ['stages not array', mutatedFixture('waterfall', (doc) => { policyOf(doc)['stages'] = 'req'; }), 'invalid_baseline'],
    ['stage not object', mutatedFixture('waterfall', (doc) => {
      policyOf(doc)['stages'] = [3];
    }), 'invalid_baseline'],
    ['stage id empty', mutatedFixture('waterfall', (doc) => { stagesOf(doc)[0]!['id'] = ''; }), 'stage_bad_kind'],
    ['stage kinds not array', mutatedFixture('waterfall', (doc) => {
      stagesOf(doc)[0]!['kinds'] = 'requirement';
    }), 'stage_bad_kind'],
    ['gates not array', mutatedFixture('waterfall', (doc) => { doc['gates'] = {}; }), 'invalid_baseline'],
    ['gate not object', mutatedFixture('waterfall', (doc) => {
      doc['gates'] = ['G_req_exit', ...gateDefsOf(doc).slice(1)];
    }), 'invalid_baseline'],
    ['gate id empty', mutatedFixture('waterfall', (doc) => { gateDefsOf(doc)[0]!['id'] = ''; }), 'invalid_baseline'],
    ['gate stage not string', mutatedFixture('waterfall', (doc) => {
      gateDefsOf(doc)[0]!['stage'] = 1;
    }), 'invalid_baseline'],
    ['gate missing policy_mode', mutatedFixture('waterfall', (doc) => {
      delete gateDefsOf(doc)[0]!['policy_mode'];
    }), 'invalid_baseline'],
    ['gate missing waivable', mutatedFixture('waterfall', (doc) => {
      delete gateDefsOf(doc)[0]!['waivable'];
    }), 'invalid_baseline'],
    ['policy.gates not a map', mutatedFixture('waterfall', (doc) => { policyOf(doc)['gates'] = 'x'; }), 'invalid_baseline'],
    ['policy.gates value not string[]', mutatedFixture('waterfall', (doc) => {
      policyGatesOf(doc)['req'] = [1];
    }), 'invalid_baseline'],
    ['duplicate gate id (P3-2)', loadFixture('duplicate-gate-id'), 'duplicate_gate_id'],
  ];
  for (const [name, input, expected] of cases) {
    const result = validateBaseline(input);
    assert.equal(result.ok, false, name);
    assert.deepEqual(sortedCodes(result), [expected], name);
    assert.deepEqual(result.guarantee_delta, STRUCTURAL_DELTA, name);
    assert.equal(result.missing, undefined, name);
  }
});

test('non-object input fails closed with structural delta and a single code', () => {
  for (const input of [undefined, null, 1, 'x', [], true]) {
    const result = validateBaseline(input);
    assert.equal(result.ok, false);
    assert.deepEqual(sortedCodes(result), ['invalid_baseline']);
    assert.deepEqual(result.guarantee_delta, STRUCTURAL_DELTA);
    assert.equal(result.missing, undefined);
  }
});

test('P1-1: kinds are validated on the raw value, never silently filtered', () => {
  // ["requirement","bogus"] 里有一个合法 kind：过滤实现会把它当合法 stage 放行。
  for (const name of ['stage-bad-kind', 'stage-empty-kinds', 'stage-mixed-kinds']) {
    const result = validateFixture(name);
    assert.equal(result.ok, false, name);
    assert.deepEqual(sortedCodes(result), ['stage_bad_kind'], name);
    assert.deepEqual(result.guarantee_delta, STRUCTURAL_DELTA, name);
    assert.equal(result.missing, undefined, name);
  }
});

test('P3-1: a shape-bad stage takes priority over its own after check', () => {
  // 该 stage 的 kinds 非法 ⇒ 直接 stage_bad_kind，不再校验它的 after（注释已按实现口径写死）。
  const input = mutatedFixture('waterfall', (doc) => {
    stagesOf(doc)[0]!['kinds'] = ['requirement', 'bogus'];
    stagesOf(doc)[0]!['after'] = 'req';
  });
  const result = validateBaseline(input);
  assert.equal(result.ok, false);
  assert.deepEqual(sortedCodes(result), ['stage_bad_kind']);
  assert.deepEqual(result.guarantee_delta, STRUCTURAL_DELTA);
  assert.equal(result.missing, undefined);
});

test('P1-2: policy_mode / waivable / after / criteria are type- and enum-checked before delta', () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ['policy_mode weird', loadFixture('gate-policy-mode-bad')],
    ['policy_mode ANY_OF', mutatedFixture('waterfall', (doc) => {
      gateDefsOf(doc)[0]!['policy_mode'] = 'ANY_OF';
    })],
    ['waivable string', loadFixture('gate-waivable-string')],
    ['after string', loadFixture('stage-after-string')],
    ['after [1]', mutatedFixture('waterfall', (doc) => { stagesOf(doc)[1]!['after'] = [1]; })],
    ['criteria non-string', loadFixture('gate-criteria-nonstring')],
    ['criteria [""]', mutatedFixture('waterfall', (doc) => { gateDefsOf(doc)[0]!['criteria'] = ['']; })],
    // assurance.na_stages 与 kinds 同一套判定：不再“过滤非字符串后当空集比较”。
    ['na_stages [123]', mutatedFixture('waterfall', (doc) => { assuranceOf(doc)['na_stages'] = [123]; })],
    ['na_stages string', mutatedFixture('waterfall', (doc) => { assuranceOf(doc)['na_stages'] = 'x'; })],
    ['na_stages ["design","bogus"]', mutatedFixture('waterfall', (doc) => {
      assuranceOf(doc)['na_stages'] = ['design', 'bogus'];
    })],
  ];
  for (const [name, input] of cases) {
    const result = validateBaseline(input);
    assert.equal(result.ok, false, name);
    assert.deepEqual(sortedCodes(result), ['invalid_baseline'], name);
    assert.deepEqual(result.guarantee_delta, STRUCTURAL_DELTA, name);
  }
});

test('P2-3: duplicate stage ids stay on the business path (delta computed), unlike shape errors', () => {
  const result = validateFixture('stage-duplicate-id');
  assert.equal(result.ok, false);
  assert.deepEqual(sortedCodes(result), ['stage_bad_kind']);
  // 结构短路的 delta 恒为三项 degraded；这里是业务码，delta 仍按目录算出 kept。
  assert.deepEqual(result.guarantee_delta, { 1: 'kept', 2: 'kept', 3: 'kept' });
});

test('P2-4: business negative fixtures assert exact code sets (cascades are explicit)', () => {
  const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['criteria-empty', ['core_not_effective', 'gate_empty']],
    ['stage-no-gate', ['core_not_effective', 'stage_no_gate']],
    ['core-unbound-stage', ['core_not_effective', 'stage_no_gate']],
    ['island', ['core_not_effective', 'stage_bad_after']],
    ['core-any-of', ['core_not_effective']],
    ['core-waivable', ['core_not_effective']],
    ['lite-no-requirement', ['core_not_effective']],
    ['cycle', ['stage_bad_after']],
    ['stage-dangling-edge', ['stage_bad_after']],
    ['stage-unknown-gate', ['stage_unknown']],
    ['unregistered-criterion', ['criterion_unregistered']],
    ['missing-engine', ['engine_missing']],
    ['engine-hash-missing', ['engine_missing']],
    ['review-params-0', ['review_params_invalid']],
    ['review-params-big', ['review_params_invalid']],
    ['review-params-seed', ['review_params_invalid']],
    ['na-stages-mismatch', ['na_stages_mismatch']],
    ['artifact-kinds-incomplete', ['artifact_kinds_incomplete']],
  ];
  for (const [name, expected] of cases) {
    const result = validateFixture(name);
    assert.equal(result.ok, false, name);
    assert.deepEqual(sortedCodes(result), [...expected].sort(), name);
  }
});

test('unregistered criterion is reported with its id', () => {
  const result = validateFixture('unregistered-criterion');
  assert.deepEqual(result.unregistered_criteria, ['bogus.criterion']);
});

test('P2-2: a non-core criterion on a na stage is a constructible leak and degrades the delta', () => {
  // design.covers_spec (applies_to: design) 被从 design gate 挪进 build gate：
  // 没有 design kind 阶段合格绑定它 ⇒ 保证 1 degraded，但没有任何 reason code（ok）。
  const result = validateFixture('noncore-na-design');
  assert.equal(result.ok, true);
  assert.deepEqual(sortedCodes(result), []);
  assert.deepEqual(result.guarantee_delta, { 1: 'degraded', 2: 'kept', 3: 'kept' });
  assert.deepEqual(missingFor(result, 1), ['design.covers_spec']);
  assert.equal(result.missing?.length, 1);
});

test('C6 constructible leaks: any_of gate / waivable gate / missing checkpoint all fail', () => {
  // 三种可构造漏法各一条；结构性前置（无 requirement 阶段）走 C7 的 missing_required_kind 口径。
  const anyOf = validateFixture('core-any-of');
  const waivable = validateFixture('core-waivable');
  const missingCheckpoint = validateFixture('core-unbound-stage');
  for (const [name, result] of [['any_of', anyOf], ['waivable', waivable], ['checkpoint', missingCheckpoint]] as const) {
    assert.deepEqual(sortedCodes(result), ['core_not_effective', ...name === 'checkpoint' ? ['stage_no_gate'] : []].sort(), name);
  }
});

test('validator is deterministic and pure', () => {
  const input = loadFixture('waterfall');
  const first = validateBaseline(input);
  const second = validateBaseline(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(input, loadFixture('waterfall'));
});

test('lite hand-written delta does not change the computed one', () => {
  const computed = validateFixture('lite.policy');
  const handwritten = validateFixture('lite-handwritten-delta');
  assert.deepEqual(handwritten.guarantee_delta, computed.guarantee_delta);
});
