import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCheck, type CheckReport } from '../../src/check/index.js';
import { readCheckState, stageGap } from '../../src/check/evaluate.js';
import { aggregateChecks, evaluateGate } from '../../src/check/gate.js';
import { catalogCodes } from '../../src/core/criteria/catalog.js';
import { appendSeeds, seamSeeds, withCheckDb } from './helpers.js';

function report(result: ReturnType<typeof runCheck>): CheckReport {
  assert.equal(result.ok, true);
  return result as CheckReport;
}

test('C1/C6：--gate req 用 waterfall preset，结构来自 preset 常量', () => {
  withCheckDb((db) => {
    const result = report(runCheck(db, { gate: 'req', preset: 'waterfall' }));
    assert.equal(result.mode, 'gate');
    assert.ok(result.gate !== undefined);
    assert.equal(result.gate.preset, 'waterfall');
    assert.equal(result.gate.stage, 'req');
    assert.deepEqual(result.gate.kinds, ['requirement']);
    assert.ok(result.gate.gates.length > 0);
    for (const gate of result.gate.gates) {
      assert.equal(gate.policy_mode, 'all_of');
      assert.equal(gate.waivable, false);
    }
    const codes = result.gate.criteria.map((check) => check.criterion_id);
    for (const core of ['spec_set.signed', 'assumption_set.signed', 'provenance.present']) {
      assert.ok(codes.includes(core), `gate criteria 应含 core：${core}`);
    }
    for (const check of result.gate.criteria) {
      assert.equal(check.preview, true);
      assert.equal(check.judged, false);
    }
  });
});

test('C6：默认 preset 是 waterfall；gate 不在该 preset 的 stage 报 unknown_stage（不做全局搜索）', () => {
  withCheckDb((db) => {
    const defaults = report(runCheck(db, { gate: 'req' }));
    assert.equal(defaults.gate?.preset, 'waterfall');

    // explore 是 prototype 的 stage，不在 waterfall：不许跨 preset 找到
    const wrongPreset = runCheck(db, { gate: 'explore' });
    assert.equal(wrongPreset.ok, false);
    assert.equal(wrongPreset.ok === false ? wrongPreset.reason_code : undefined, 'unknown_stage');

    const missing = runCheck(db, { gate: 'nope' });
    assert.equal(missing.ok, false);
    assert.equal(missing.ok === false ? missing.reason_code : undefined, 'unknown_stage');
  });
});

test('C1：未知 preset / 参数形状错误都返回结构化失败（退出码层面由 CLI 映射 2）', () => {
  withCheckDb((db) => {
    const badPreset = runCheck(db, { gate: 'req', preset: 'lite' });
    assert.equal(badPreset.ok, false);
    assert.equal(badPreset.ok === false ? badPreset.reason_code : undefined, 'unknown_preset');

    const neither = runCheck(db, {});
    assert.equal(neither.ok, false);
    assert.equal(neither.ok === false ? neither.reason_code : undefined, 'invalid_args');

    const both = runCheck(db, { criterion: 'provenance.present', gate: 'req' });
    assert.equal(both.ok, false);
    assert.equal(both.ok === false ? both.reason_code : undefined, 'invalid_args');
  });
});

test('C7：stage_gap 可见——无判据 applies_to 覆盖该 stage 的 kinds 时给出 gap', () => {
  const gap = stageGap('empty-stage', ['requirement'], new Set<string>());
  assert.ok(gap !== undefined);
  assert.equal(gap?.code, 'stage_gap');

  // 当前目录覆盖全部五种 kind ⇒ 真实 preset 没有 gap
  const registered = new Set<string>(catalogCodes());
  for (const kinds of [['requirement'], ['design'], ['implement'], ['review'], ['deliver']] as const) {
    assert.equal(stageGap('stage', kinds, registered), undefined);
  }
});

test('C2：gate 预览每条结果都带依据（pass 给 basis / fail 给 reasons）', () => {
  withCheckDb((db) => {
    appendSeeds(db, seamSeeds());
    const result = report(runCheck(db, { gate: 'req' }));
    for (const check of result.gate?.criteria ?? []) {
      if (check.result === 'pass') {
        assert.ok(
          (check.basis.spec_ids?.length ?? 0) > 0 ||
            (check.basis.task_ids?.length ?? 0) > 0 ||
            (check.basis.evidence_ids?.length ?? 0) > 0,
          `${check.criterion_id} pass 但没有 basis`,
        );
      }
      if (check.result === 'fail') assert.ok(check.reasons.length > 0, `${check.criterion_id} fail 但没有 reasons`);
    }
  });
});

test('P3：只挂 core 三条的 gate 在空库 ⇒ 三条判据出 pass/fail（无 na），聚合 fail', () => {
  withCheckDb((db) => {
    const preset = {
      id: 'waterfall' as const,
      stages: [{ id: 'core', kinds: ['requirement'] as const, after: [] }],
      gates: {
        core: ['G_core'],
        req: [], design: [], build: [], verify: [], deliver: [],
      },
      gateDefs: [{
        id: 'G_core',
        stage: 'core',
        criteria: ['spec_set.signed', 'assumption_set.signed', 'provenance.present'],
        policy_mode: 'all_of' as const,
        waivable: false,
      }],
    };
    const state = readCheckState(db).state;
    const gate = evaluateGate(db, state, preset, 'core');
    assert.ok(gate !== undefined);
    const results = (gate?.criteria ?? []).map((check) => (check as { result: string }).result);
    assert.deepEqual(results, ['fail', 'fail', 'pass']);
    assert.ok(!results.includes('na'), 'core 三条不得产出 na');
    assert.equal(gate?.result, 'fail', 'core-only gate 在空库必须 fail，不能被 na 洗成 pass');
  });
});

test('P1：aggregateChecks 把 na 显式归 fail（纵深防御，防止未来判据的 na 洗成 pass）', () => {
  const row = (result: 'pass' | 'fail' | 'na' | 'unknown') => ({
    criterion_id: `c-${result}`,
    result,
    preview: true as const,
    judged: false as const,
    effective: true,
    binding_reasons: [],
    reasons: [],
    basis: {},
  });
  assert.equal(aggregateChecks([row('pass'), row('na')]), 'fail');
  assert.equal(aggregateChecks([row('pass'), row('unknown')]), 'unknown');
  assert.equal(aggregateChecks([row('pass'), row('pass')]), 'pass');
  assert.equal(aggregateChecks([]), 'fail');
});
