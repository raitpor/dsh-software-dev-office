import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  registerCriterion,
  type Fixture,
  type FixtureRunner,
  type FixtureStatus,
} from '../../../src/core/criteria/register.js';

const PASS_FIXTURE: Fixture = { polarity: 'positive', input: 'good', expected_status: 'pass' };
const FAIL_FIXTURE: Fixture = { polarity: 'negative', input: 'bad', expected_status: 'fail' };

function runnerFrom(map: Readonly<Record<string, FixtureStatus>>): FixtureRunner {
  return (fixture) => map[fixture.input] ?? 'na';
}

const GOOD_RUNNER = runnerFrom({ good: 'pass', bad: 'fail' });

function request(overrides: Partial<Parameters<typeof registerCriterion>[0]> = {}) {
  return {
    criterion_id: 'spec_set.signed',
    guarantee: '1' as const,
    remedy: 'fix it',
    fixtures: [PASS_FIXTURE, FAIL_FIXTURE],
    ...overrides,
  };
}

/** 假时钟：每次 now() 前进 stepMs，让预算可精确复算，避免真等 200ms。 */
function fakeClock(stepMs: number): () => number {
  let current = 0;
  return () => {
    current += stepMs;
    return current;
  };
}

test('C2: registration accepts a well-formed criterion', () => {
  const result = registerCriterion(request(), GOOD_RUNNER, { now: fakeClock(1) });
  assert.equal(result.ok, true);
  assert.ok(result.elapsed_ms < 200);
  assert.equal(result.samples.length, 2); // P1-2：每条夹具一个中位数
});

test('C2: empty remedy is rejected with criterion_invalid', () => {
  const result = registerCriterion(request({ remedy: '   ' }), GOOD_RUNNER, { now: fakeClock(1) });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'criterion_invalid');
});

test('C2: no positive fixture is rejected', () => {
  const result = registerCriterion(request({ fixtures: [FAIL_FIXTURE] }), GOOD_RUNNER, { now: fakeClock(1) });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'no_positive_fixture');
});

test('C2: no negative fixture is rejected', () => {
  const result = registerCriterion(request({ fixtures: [PASS_FIXTURE] }), GOOD_RUNNER, { now: fakeClock(1) });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'no_negative_fixture');
});

test('P1-2: mixed fast/slow fixtures — slowest fixture median must be under budget', () => {
  const slow: Fixture = { polarity: 'negative', input: 'slow-bad', expected_status: 'fail' };
  // 前 6 次 now()（快夹具 3 次采样）每次 +1ms；后 6 次（慢夹具）每次 +250ms。
  // 旧实现把 6 个样本混池取中位数（会被 1ms 样本稀释）；新实现按夹具取中位数后取 max。
  let calls = 0;
  let value = 0;
  const now = () => {
    value += calls < 6 ? 1 : 250;
    calls += 1;
    return value;
  };
  const run: FixtureRunner = (fixture) => (fixture.input === 'slow-bad' ? 'fail' : 'pass');
  const result = registerCriterion(
    { criterion_id: 'spec_set.signed', guarantee: '1', remedy: 'fix', fixtures: [PASS_FIXTURE, slow] },
    run,
    { now, samples: 3 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'budget_exceeded');
  assert.ok(result.elapsed_ms >= 200, `max fixture median ${result.elapsed_ms}`);
});

test('P2-1: unknown criterion is rejected', () => {
  const result = registerCriterion(request({ criterion_id: 'not.in.catalog' }), GOOD_RUNNER, { now: fakeClock(1) });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'unknown_criterion');
});

test('P2-1: guarantee mismatching the catalog is rejected', () => {
  const result = registerCriterion(request({ guarantee: '2' }), GOOD_RUNNER, { now: fakeClock(1) });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'guarantee_mismatch');
});

test('P1-3/P2-1: fixtures missing (undefined) is fixtures_missing', () => {
  const result = registerCriterion(request({ fixtures: undefined as never }), GOOD_RUNNER, { now: fakeClock(1) });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'fixtures_missing');
});

test('C2: median single-run >= 200ms is rejected with budget_exceeded', () => {
  const result = registerCriterion(request(), GOOD_RUNNER, { now: fakeClock(250), samples: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'budget_exceeded');
  assert.ok(result.elapsed_ms >= 200, `max fixture median ${result.elapsed_ms}`);
});

test('C2: bad guarantee is rejected with guarantee_invalid', () => {
  const result = registerCriterion(request({ guarantee: '4' }), GOOD_RUNNER, { now: fakeClock(1) });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'guarantee_invalid');
});

test('C3: positive fixture that runs fail is fixture_mismatch', () => {
  const result = registerCriterion(request(), runnerFrom({ good: 'fail', bad: 'fail' }), { now: fakeClock(1) });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'fixture_mismatch');
});

test('C3: negative fixture that runs pass is fixture_mismatch', () => {
  const result = registerCriterion(request(), runnerFrom({ good: 'pass', bad: 'pass' }), { now: fakeClock(1) });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'fixture_mismatch');
});

test('C3: expected_status drift is fixture_mismatch even if polarity semantics hold', () => {
  const drifted: Fixture = { polarity: 'negative', input: 'bad', expected_status: 'pass' };
  const result = registerCriterion(request({ fixtures: [PASS_FIXTURE, drifted] }), GOOD_RUNNER, { now: fakeClock(1) });
  assert.equal(result.ok, false);
  assert.equal(result.reason_code, 'fixture_mismatch');
});

test('C2/C8: registration gate writes nothing itself (no DB dependency in source)', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/core/criteria/register.ts'), 'utf8');
  assert.equal(/INSERT\s+INTO|db\.prepare|new Database/iu.test(source), false);
});
