import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  coreEffectiveCount,
  evaluateBinding,
  evaluateCoreBinding,
  type Gate,
  type Policy,
} from '../../../src/core/criteria/binding.js';

function gate(overrides: Partial<Gate> = {}): Gate {
  return { id: 'g1', stage: 's1', criteria: ['scope.present'], policy_mode: 'all_of', waivable: false, ...overrides };
}

function policy(overrides: Partial<Policy> = {}): Policy {
  return { stages: [{ id: 's1', kinds: ['requirement'] }], gates: [gate()], ...overrides };
}

test('C5 positive: all five conditions satisfied ⇒ effective', () => {
  const result = evaluateBinding('scope.present', { registered: ['scope.present'], policy: policy() });
  assert.equal(result.effective, true);
  assert.deepEqual(result.reasons, []);
});

test('C5: not registered ⇒ not_registered', () => {
  const result = evaluateBinding('scope.present', { registered: [], policy: policy() });
  assert.equal(result.effective, false);
  assert.deepEqual(result.reasons, ['not_registered']);
});

test('C5: registered but no gate lists it ⇒ not_in_gate', () => {
  const result = evaluateBinding('scope.present', {
    registered: ['scope.present'],
    policy: policy({ gates: [gate({ criteria: ['task.complete'] })] }),
  });
  assert.equal(result.effective, false);
  assert.deepEqual(result.reasons, ['not_in_gate']);
});

test('C5: stage kinds do not intersect applies_to ⇒ stage_not_applicable', () => {
  const result = evaluateBinding('scope.present', {
    registered: ['scope.present'],
    policy: policy({ stages: [{ id: 's1', kinds: ['design'] }] }),
  });
  assert.equal(result.effective, false);
  assert.deepEqual(result.reasons, ['stage_not_applicable']);
});

test('C5: any_of gate does not count ⇒ policy_mode_any_of', () => {
  const result = evaluateBinding('scope.present', {
    registered: ['scope.present'],
    policy: policy({ gates: [gate({ policy_mode: 'any_of' })] }),
  });
  assert.equal(result.effective, false);
  assert.deepEqual(result.reasons, ['policy_mode_any_of']);
});

test('C5: waivable gate does not count ⇒ waivable_gate', () => {
  const result = evaluateBinding('scope.present', {
    registered: ['scope.present'],
    policy: policy({ gates: [gate({ waivable: true })] }),
  });
  assert.equal(result.effective, false);
  assert.deepEqual(result.reasons, ['waivable_gate']);
});

test('C6: checkpoint discontinuity ⇒ stage_gap, not "bound somewhere is enough"', () => {
  const policyAll: Policy = {
    stages: [
      { id: 's1', kinds: ['implement'] },
      { id: 's2', kinds: ['deliver'] },
    ],
    gates: [gate({ id: 'g1', stage: 's1', criteria: ['mandate.revalidated'] })],
  };
  const result = evaluateBinding('mandate.revalidated', { registered: ['mandate.revalidated'], policy: policyAll });
  assert.equal(result.effective, false);
  assert.deepEqual(result.reasons, ['stage_gap']);
});

test('C4: only the three core criteria are enforced; all satisfied ⇒ 3', () => {
  const allKinds = ['requirement', 'design', 'implement', 'review', 'deliver'] as const;
  const policyAll: Policy = {
    stages: [{ id: 's1', kinds: [...allKinds] }],
    gates: [
      gate({
        criteria: ['spec_set.signed', 'assumption_set.signed', 'provenance.present', 'task.complete'],
      }),
    ],
  };
  const registered = new Set(['spec_set.signed', 'assumption_set.signed', 'provenance.present']);
  assert.equal(coreEffectiveCount({ registered, policy: policyAll }), 3);
  const core = evaluateCoreBinding({ registered, policy: policyAll });
  assert.deepEqual(core.map((result) => result.criterion_id), ['spec_set.signed', 'assumption_set.signed', 'provenance.present']);
});

test('C4: dropping one binding gives 2, not a pass', () => {
  const allKinds = ['requirement', 'design', 'implement', 'review', 'deliver'] as const;
  const policyAll: Policy = {
    stages: [{ id: 's1', kinds: [...allKinds] }],
    gates: [gate({ criteria: ['spec_set.signed', 'assumption_set.signed'] })],
  };
  assert.equal(coreEffectiveCount({ registered: ['spec_set.signed', 'assumption_set.signed', 'provenance.present'], policy: policyAll }), 2);
  const provenance = evaluateBinding('provenance.present', { registered: ['provenance.present'], policy: policyAll });
  assert.equal(provenance.effective, false);
  assert.deepEqual(provenance.reasons, ['not_in_gate']);
});

test('C7: core has no backdoor — missing gates ⇒ core_not_effective, guarantee_delta is ignored', () => {
  const lite: Policy = { stages: [{ id: 'build', kinds: ['implement'] }], gates: [] };
  const withDelta = {
    registered: ['spec_set.signed', 'assumption_set.signed', 'provenance.present'],
    policy: lite,
    // 运行时多塞的降级声明：结构判定不读取它（API 里也没有这个入参）。
    assurance: { guarantee_delta: { 1: 'downgraded', 3: 'downgraded' } },
  };
  assert.equal(coreEffectiveCount(withDelta as never), 0);
  const source = readFileSync(resolve(process.cwd(), 'src/core/criteria/binding.ts'), 'utf8');
  // 注释里说明“不读 guarantee_delta”是允许的；实现代码里不得读取任何 assurance 字段。
  assert.equal(/\.assurance\b|\bassurance\s*[:=]/u.test(source), false);
});

test('C4/P2-2: table-bound work_unit.evidence_consistent is always effective (DDL enforces it)', () => {
  const result = evaluateBinding('work_unit.evidence_consistent', {
    registered: ['work_unit.evidence_consistent'],
    policy: policy(),
  });
  assert.equal(result.effective, true);
  assert.deepEqual(result.reasons, []);
});

test('P1-1: lite policy without a requirement stage ⇒ core all missing_required_kind, count 0', () => {
  const lite: Policy = {
    stages: [
      { id: 'build', kinds: ['implement'] },
      { id: 'deliver', kinds: ['deliver'] },
    ],
    gates: [
      gate({ id: 'g-build', stage: 'build', criteria: ['spec_set.signed', 'assumption_set.signed', 'provenance.present'] }),
      gate({ id: 'g-deliver', stage: 'deliver', criteria: ['spec_set.signed', 'assumption_set.signed', 'provenance.present'] }),
    ],
  };
  const registered = ['spec_set.signed', 'assumption_set.signed', 'provenance.present'];
  assert.equal(coreEffectiveCount({ registered, policy: lite }), 0);
  for (const result of evaluateCoreBinding({ registered, policy: lite })) {
    assert.equal(result.effective, false);
    assert.deepEqual(result.reasons, ['missing_required_kind']);
  }
});

test('P1-1: waterfall with requirement in harden is unaffected ⇒ core count 3', () => {
  const waterfall: Policy = {
    stages: [
      { id: 'harden', kinds: ['requirement', 'design'] },
      { id: 'build', kinds: ['implement'] },
      { id: 'deliver', kinds: ['deliver'] },
    ],
    gates: [
      gate({ id: 'g-harden', stage: 'harden', criteria: ['spec_set.signed', 'assumption_set.signed', 'provenance.present'] }),
      gate({ id: 'g-build', stage: 'build', criteria: ['spec_set.signed', 'assumption_set.signed', 'provenance.present'] }),
      gate({ id: 'g-deliver', stage: 'deliver', criteria: ['spec_set.signed', 'assumption_set.signed', 'provenance.present'] }),
    ],
  };
  const registered = ['spec_set.signed', 'assumption_set.signed', 'provenance.present'];
  assert.equal(coreEffectiveCount({ registered, policy: waterfall }), 3);
});

test('P3: malformed policy returns effective:false with invalid_policy instead of throwing', () => {
  const broken = { stages: null, gates: [] } as unknown as Policy;
  const result = evaluateBinding('scope.present', { registered: ['scope.present'], policy: broken });
  assert.equal(result.effective, false);
  assert.deepEqual(result.reasons, ['invalid_policy']);
});
