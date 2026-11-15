/**
 * M3-3 C4：独立性等级来自 baseline 的 assurance.independence（不是常量、不是 policy）。
 * 缺失/形状非法一律 fail-closed；冷却分钟数只认 baseline 给的数。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decisionActionForKind,
  effectiveMode,
  parseIndependencePolicy,
  requiresIndependence,
  cooldownMsOf,
  type MatrixDualRow,
} from '../../../src/core/independence/policy.js';

const matrix: MatrixDualRow[] = [
  { action: 'freeze', dual_human: 'independence' },
  { action: 'waive', dual_human: 'independence' },
  { action: 'rollback', dual_human: 'independence' },
  { action: 'revoke_decision', dual_human: 'independence' },
  { action: 'claim', dual_human: 'no' },
];

test('C4: dual_human / solo_cooldown(Nm) / solo 都能解析', () => {
  assert.deepEqual(parseIndependencePolicy({ independence: 'dual_human' }), {
    ok: true,
    policy: { mode: 'dual_human', cooldown_ms: null },
  });
  assert.deepEqual(parseIndependencePolicy({ independence: 'solo_cooldown(15m)' }), {
    ok: true,
    policy: { mode: 'solo_cooldown', cooldown_ms: 15 * 60_000 },
  });
  assert.deepEqual(parseIndependencePolicy({ independence: 'solo_cooldown(5m)' }), {
    ok: true,
    policy: { mode: 'solo_cooldown', cooldown_ms: 5 * 60_000 },
  });
  assert.deepEqual(parseIndependencePolicy({ independence: 'solo' }), {
    ok: true,
    policy: { mode: 'solo', cooldown_ms: null },
  });
});

test('C4: assurance 缺失 ⇒ independence_missing（不默认 15m）', () => {
  const parsed = parseIndependencePolicy({});
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok === false ? parsed.reason_code : '', 'independence_missing');
  assert.equal(parseIndependencePolicy(undefined).ok, false);
});

test('C4: 形状/范围非法 ⇒ assurance_invalid（fail-closed）', () => {
  for (const bad of ['solo_cooldown', 'solo_cooldown(15)', 'solo_cooldown(4m)', 'solo_cooldown(61m)', 'dual-human', 15]) {
    const parsed = parseIndependencePolicy({ independence: bad });
    assert.equal(parsed.ok, false, `应拒 ${String(bad)}`);
    assert.equal(parsed.ok === false ? parsed.reason_code : '', 'assurance_invalid');
  }
});

test('C4: 生效模式完全跟随 baseline，人不够也不静默降级', () => {
  assert.equal(effectiveMode({ mode: 'dual_human', cooldown_ms: null }), 'dual_human');
  assert.equal(effectiveMode({ mode: 'solo_cooldown', cooldown_ms: 900_000 }), 'solo_cooldown');
  assert.equal(effectiveMode({ mode: 'solo', cooldown_ms: null }), 'solo');
  assert.equal(cooldownMsOf({ mode: 'solo_cooldown', cooldown_ms: 900_000 }), 900_000);
  assert.equal(cooldownMsOf({ mode: 'dual_human', cooldown_ms: null }), null);
});

test('C4: 哪些动作需要独立性来自矩阵目录（不写死）', () => {
  assert.equal(requiresIndependence(matrix, 'freeze'), true);
  assert.equal(requiresIndependence(matrix, 'claim'), false);
  assert.equal(requiresIndependence(matrix, 'unregistered'), null, '未登记动作返回 null 由判定层 fail-closed');
  assert.equal(decisionActionForKind('freeze'), 'freeze');
  assert.equal(decisionActionForKind('baseline'), 'freeze');
  assert.equal(decisionActionForKind('waiver'), 'waive');
  assert.equal(decisionActionForKind('rollback'), 'rollback');
  assert.equal(decisionActionForKind('sign'), 'revoke_decision');
  assert.equal(decisionActionForKind('plan'), null);
});
