/**
 * M3-3 C1/C2：dual_human 按 actor 去重计数；solo_cooldown 冷却边界。
 * 全是纯函数用例（注入时钟），能红：同 actor 连签不计数、冷却写死 0 都会让它们红。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  judgeIndependence,
  signaturesForDecision,
  type IndependenceSignature,
} from '../../../src/core/independence/judge.js';
import type { MatrixDualRow } from '../../../src/core/independence/policy.js';

const matrix: MatrixDualRow[] = [
  { action: 'freeze', dual_human: 'independence' },
  { action: 'rollback', dual_human: 'independence' },
  { action: 'claim', dual_human: 'no' },
];

function sig(signer: string, at: string, payloadHash = 'sha256:ph', frontier = 'sha256:f0'): IndependenceSignature {
  return { signer, at, receipt_time_missing: false, signature: `sig-${signer}-${at}`, payload_hash: payloadHash, frontier };
}

function judge(
  signatures: IndependenceSignature[],
  assurance: unknown,
  humanActorCount = 2,
  decisionKind = 'freeze',
) {
  return judgeIndependence({
    decision_kind: decisionKind,
    signatures,
    matrix,
    assurance,
    human_actor_count: humanActorCount,
  });
}

test('C1: dual_human 需要 2 个不同 human；A+A 不成立、A+B 成立', () => {
  const one = judge([sig('alice', '2026-11-15T10:00:00Z')], { independence: 'dual_human' });
  assert.equal(one.ok, false);
  assert.equal(one.reason_code, 'independence_unsatisfied');
  assert.equal(one.distinct_signers, 1);

  const sameActorTwice = judge(
    [sig('alice', '2026-11-15T10:00:00Z'), sig('alice', '2026-11-15T11:00:00Z')],
    { independence: 'dual_human' },
  );
  assert.equal(sameActorTwice.ok, false, '同 actor 连签不能凑双人');
  assert.equal(sameActorTwice.distinct_signers, 1);

  const two = judge(
    [sig('alice', '2026-11-15T10:00:00Z'), sig('bob', '2026-11-15T10:00:03Z')],
    { independence: 'dual_human' },
  );
  assert.equal(two.ok, true);
  assert.equal(two.distinct_signers, 2);
});

test('C1: 签名覆盖不同 payload_hash ⇒ 证据不自洽，拒', () => {
  const mixed = judge(
    [sig('alice', '2026-11-15T10:00:00Z'), sig('bob', '2026-11-15T10:00:03Z', 'sha256:other')],
    { independence: 'dual_human' },
  );
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason_code, 'independence_unsatisfied');
});

test('C4: 不需要独立性的动作直接通过；未登记动作 fail-closed', () => {
  assert.equal(judge([], { independence: 'solo' }, 2, 'claim').ok, true);
  assert.equal(judge([], { independence: 'dual_human' }, 2, 'plan').ok, true, 'plan 不要求独立性');
  const unknown = judge([sig('alice', '2026-11-15T10:00:00Z')], { independence: 'dual_human' }, 2, 'freeze');
  assert.equal(unknown.ok, false);
});

test('C2: solo_cooldown 14:59 拒（cooldown_active）、15:00 过', () => {
  const first = sig('alice', '2026-11-15T10:00:00Z');
  const at14 = sig('alice', '2026-11-15T10:14:59Z');
  const at15 = sig('alice', '2026-11-15T10:15:00Z');

  const before = judge([first, at14], { independence: 'solo_cooldown(15m)' }, 1);
  assert.equal(before.ok, false);
  assert.equal(before.reason_code, 'cooldown_active');
  assert.equal(before.remaining_ms, 1000);

  const after = judge([first, at15], { independence: 'solo_cooldown(15m)' }, 1);
  assert.equal(after.ok, true);

  const pending = judge([first], { independence: 'solo_cooldown(15m)' }, 1);
  assert.equal(pending.ok, false);
  assert.equal(pending.reason_code, 'independence_unsatisfied');
});

test('C2: solo_cooldown 读 baseline 的分钟数（不是常量 15）', () => {
  const first = sig('alice', '2026-11-15T10:00:00Z');
  const at5 = sig('alice', '2026-11-15T10:05:00Z');
  const at4 = sig('alice', '2026-11-15T10:04:59Z');
  assert.equal(judge([first, at5], { independence: 'solo_cooldown(5m)' }, 1).ok, true);
  const tooEarly = judge([first, at4], { independence: 'solo_cooldown(5m)' }, 1);
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.reason_code, 'cooldown_active');
});

test('C5: 矩阵里未登记的动作 ⇒ fail-closed（independence_unsatisfied，不放行）', () => {
  const unregistered = judgeIndependence({
    decision_kind: 'freeze',
    signatures: [sig('alice', '2026-11-15T10:00:00Z')],
    matrix: [],
    assurance: { independence: 'dual_human' },
    human_actor_count: 2,
  });
  assert.equal(unregistered.ok, false);
  assert.equal(unregistered.required, true);
  assert.equal(unregistered.reason_code, 'independence_unsatisfied');
  assert.match(unregistered.message, /未登记动作 freeze/);
});

test('C4: assurance 缺失/非法 ⇒ 判定拒（不默认 15m）', () => {
  const missing = judge([sig('alice', '2026-11-15T10:00:00Z')], {});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason_code, 'independence_missing');
  const invalid = judge([sig('alice', '2026-11-15T10:00:00Z')], { independence: 'solo_cooldown(99m)' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason_code, 'assurance_invalid');
});

test('signaturesForDecision 只收该 decision 且字段完整的签名', () => {
  const events = [
    { subject: 'd-1', at: '2026-11-15T10:00:00Z', payload: { signer: 'alice', signature: 's1', payload_hash: 'p', frontier: 'f' } },
    { subject: 'd-2', at: '2026-11-15T10:00:01Z', payload: { signer: 'bob', signature: 's2', payload_hash: 'p', frontier: 'f' } },
    { subject: 'd-1', at: '2026-11-15T10:00:02Z', payload: { signer: 'bob' } },
  ];
  const out = signaturesForDecision(events, 'd-1');
  assert.equal(out.length, 1);
  assert.equal(out[0]?.signer, 'alice');
});
