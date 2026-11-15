/**
 * M2-3 C1–C6：假设处置链的 fold 级证据（先签后处置、只认签名载荷、唯一迁移生产者、
 * 失效 fold、撤销级联）。全部走 `TestFolder`（fold 纯函数，不过写网关）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rowHash } from '../../src/core/fold/canonical.js';
import { TestFolder, expectFoldFail, validDecision } from './folder.js';

function statusOf(folder: TestFolder, id = 'A-1'): unknown {
  return folder.fold().tables.spec[id]?.['status'];
}

function recordAssumption(folder: TestFolder, id = 'A-1', extra: Record<string, unknown> = {}): void {
  folder.push('assumption.recorded', id, { clause: `clause-${id}`, blast_radius: 'core', ...extra });
}

test('C1 签名唯一授权：缺 decision / 未签 / kind 错 / 未覆盖 / 处置不一致 全拒且状态不变', () => {
  const missing = new TestFolder();
  recordAssumption(missing);
  assert.equal(statusOf(missing), 'open');
  missing.push('assumption.disposed', 'A-1', { decision_id: 'd-missing', disposition: 'confirmed' });
  expectFoldFail(() => missing.fold(), /decision d-missing does not exist/);

  // 只留 decision.valid（不签）⇒ 不能被当作授权。
  const unsignedOnly = new TestFolder();
  unsignedOnly.push('decision.valid', 'd-unsigned', { decision_kind: 'assumption_set', payload_hash: 'ph-d-unsigned' });
  recordAssumption(unsignedOnly);
  assert.equal(statusOf(unsignedOnly), 'open');
  unsignedOnly.push('assumption.disposed', 'A-1', { decision_id: 'd-unsigned', disposition: 'confirmed' });
  expectFoldFail(() => unsignedOnly.fold(), /not signed/);

  const wrongKind = new TestFolder();
  validDecision(wrongKind, 'd-plan', 'plan', { spec_ids: ['A-1'], dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }] });
  recordAssumption(wrongKind);
  assert.equal(statusOf(wrongKind), 'open');
  wrongKind.push('assumption.disposed', 'A-1', { decision_id: 'd-plan', disposition: 'confirmed' });
  expectFoldFail(() => wrongKind.fold(), /must be kind assumption_set/);

  const uncovered = new TestFolder();
  validDecision(uncovered, 'd-other', 'assumption_set', {
    spec_ids: ['OTHER'],
    dispositions: [{ spec_id: 'OTHER', disposition: 'confirmed' }],
  });
  recordAssumption(uncovered);
  assert.equal(statusOf(uncovered), 'open');
  uncovered.push('assumption.disposed', 'A-1', { decision_id: 'd-other', disposition: 'confirmed' });
  expectFoldFail(() => uncovered.fold(), /does not cover assumption A-1/);

  const mismatch = new TestFolder();
  validDecision(mismatch, 'd-mm', 'assumption_set', {
    spec_ids: ['A-1'],
    dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }],
  });
  recordAssumption(mismatch);
  assert.equal(statusOf(mismatch), 'open');
  mismatch.push('assumption.disposed', 'A-1', { decision_id: 'd-mm', disposition: 'rejected' });
  expectFoldFail(() => mismatch.fold(), /does not cover assumption A-1 with rejected/);
});

test('C2 覆盖名单只认签名载荷：事件自带 covered_spec_ids 直接拒，且不回退到 decision.covered_spec_ids', () => {
  const eventCarries = new TestFolder();
  validDecision(eventCarries, 'd-a', 'assumption_set', {
    spec_ids: ['A-1'],
    dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }],
  });
  recordAssumption(eventCarries, 'A-1');
  recordAssumption(eventCarries, 'A-2');
  eventCarries.push('assumption.disposed', 'A-2', {
    decision_id: 'd-a',
    disposition: 'confirmed',
    covered_spec_ids: ['A-1', 'A-2'],
  });
  expectFoldFail(() => eventCarries.fold(), /must not carry coverage lists/);

  const decisionCarriesOnly = new TestFolder();
  validDecision(decisionCarriesOnly, 'd-b', 'assumption_set', {
    covered_spec_ids: ['A-1', 'A-2'],
    dispositions: [
      { spec_id: 'A-1', disposition: 'confirmed' },
      { spec_id: 'A-2', disposition: 'confirmed' },
    ],
  });
  recordAssumption(decisionCarriesOnly, 'A-2');
  assert.equal(statusOf(decisionCarriesOnly, 'A-2'), 'open');
  decisionCarriesOnly.push('assumption.disposed', 'A-2', { decision_id: 'd-b', disposition: 'confirmed' });
  expectFoldFail(() => decisionCarriesOnly.fold(), /does not cover assumption A-2/);
});

test('C3 recorded 只建 open：带 status 一律拒', () => {
  const folder = new TestFolder();
  folder.push('assumption.recorded', 'A-1', { clause: 'c', blast_radius: 'core', status: 'confirmed' });
  expectFoldFail(() => folder.fold(), /must not carry payload.status/);
});

test('C4 处置是唯一迁移生产者：已处置的行不能再处置，别的 reducer 不改 assumption 状态', () => {
  const folder = new TestFolder();
  validDecision(folder, 'd-a', 'assumption_set', {
    spec_ids: ['A-1'],
    dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }],
  });
  recordAssumption(folder);
  folder.push('spec.defined', 'SPEC-1', { kind: 'requirement', clause: 'unrelated' });
  folder.push('assumption.disposed', 'A-1', { decision_id: 'd-a', disposition: 'confirmed' });
  folder.push('spec.revised', 'SPEC-1', { clause: 'v2', reason: 'unrelated' });
  assert.equal(statusOf(folder), 'confirmed', '无关 spec 事件不得改假设状态');
  folder.push('assumption.disposed', 'A-1', { decision_id: 'd-a', disposition: 'confirmed' });
  expectFoldFail(() => folder.fold(), /already confirmed; only open can be disposed/);
});

test('C5 失效 fold：输入 hash 变 ⇒ 回 open；输入行消失也算；同一键只落一次；恢复旧 hash 不自动复活', () => {
  const folder = new TestFolder();
  folder.push('spec.defined', 'SPEC-1', { kind: 'requirement', clause: 'v1' });
  const h1 = rowHash(folder.fold().tables.spec['SPEC-1']!);
  validDecision(folder, 'd-a', 'assumption_set', {
    spec_ids: ['A-1'],
    dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }],
  });
  recordAssumption(folder, 'A-1', { inputs: [{ kind: 'spec', id: 'SPEC-1', hash: h1 }] });
  folder.push('assumption.disposed', 'A-1', { decision_id: 'd-a', disposition: 'confirmed' });
  assert.equal(statusOf(folder), 'confirmed');

  folder.push('spec.revised', 'SPEC-1', { clause: 'v2', reason: 'upstream' });
  const invalidated = folder.fold();
  assert.equal(statusOf(folder), 'open');
  assert.equal(invalidated.tables.spec['A-1']?.['invalidated_reason'], 'inputs hash changed');
  assert.equal(invalidated.invalidatedKeys.length, 1);
  assert.equal(invalidated.invalidatedKeys[0]?.split('|')[1], 'A-1');

  const replay = folder.fold();
  assert.deepEqual(replay.invalidatedKeys, invalidated.invalidatedKeys, '同串事件重放不得长新键');

  // 恢复旧内容：hash 再变一次是新键，但状态只回 open、不会自动复活成 confirmed。
  folder.push('spec.revised', 'SPEC-1', { clause: 'v1', reason: 'restore' });
  const restored = folder.fold();
  assert.equal(statusOf(folder), 'open');
  assert.equal(restored.invalidatedKeys.length, 2, '恢复旧 hash 不复活，但新 hash 是一次新失效');

  const missingInput = new TestFolder();
  recordAssumption(missingInput, 'A-2', { inputs: [{ kind: 'spec', id: 'SPEC-GONE', hash: 'sha256:deadbeef' }] });
  const missingState = missingInput.fold();
  assert.equal(missingState.tables.spec['A-2']?.['status'], 'open');
  assert.equal(missingState.invalidatedKeys.length, 1, '输入行消失也要落一次失效');
});

test('C6 撤销级联：撤 assumption_set ⇒ 覆盖假设回 open 且清 decision 绑定；撤不存在的 decision ⇒ 拒', () => {
  const folder = new TestFolder();
  validDecision(folder, 'd-a', 'assumption_set', {
    spec_ids: ['A-1', 'A-2'],
    dispositions: [
      { spec_id: 'A-1', disposition: 'confirmed' },
      { spec_id: 'A-2', disposition: 'rejected', successor_ref: 'A-9' },
    ],
  });
  recordAssumption(folder, 'A-1');
  recordAssumption(folder, 'A-2');
  folder.push('assumption.disposed', 'A-1', { decision_id: 'd-a', disposition: 'confirmed' });
  folder.push('assumption.disposed', 'A-2', { decision_id: 'd-a', disposition: 'rejected', successor_ref: 'A-9' });
  assert.equal(statusOf(folder, 'A-1'), 'confirmed');

  folder.push('decision.revoked', 'd-a', { reason: 'batch withdrawn' });
  const revoked = folder.fold();
  for (const id of ['A-1', 'A-2']) {
    assert.equal(revoked.tables.spec[id]?.['status'], 'open', `${id} 必须回 open`);
    assert.equal(revoked.tables.spec[id]?.['decision_id'], null, `${id} 的 decision 绑定必须清空`);
    assert.equal(revoked.tables.spec[id]?.['invalidated_reason'], 'decision revoked');
  }

  const missing = new TestFolder();
  missing.push('decision.revoked', 'd-missing', { reason: 'r' });
  expectFoldFail(() => missing.fold(), /does not exist/);
});

test('P1 第 1 轮：assumption.invalidated 不可写——它是派生读数，写入口与 reducer 双拒（D-078）', () => {
  const folder = new TestFolder();
  validDecision(folder, 'd-a', 'assumption_set', {
    spec_ids: ['A-1'],
    dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }],
  });
  recordAssumption(folder, 'A-1');
  folder.push('assumption.disposed', 'A-1', { decision_id: 'd-a', disposition: 'confirmed' });
  assert.equal(statusOf(folder), 'confirmed');

  folder.push('assumption.invalidated', 'A-1', { reason: 'forged rollback' });
  expectFoldFail(() => folder.fold(), /assumption_invalidated_is_derived|派生读数/);
});

test('P2-1 第 1 轮：已签决策不能再 rejected（decision_already_signed），否则处置被卡死', () => {
  const folder = new TestFolder();
  validDecision(folder, 'd-a', 'assumption_set', { spec_ids: [], dispositions: [] });
  folder.push('decision.rejected', 'd-a', { reason: 'try to kill signed decision' });
  expectFoldFail(() => folder.fold(), /decision_already_signed/);

  // 未签决策仍可 rejected（M1 语义不变）。
  const unsigned = new TestFolder();
  unsigned.push('decision.valid', 'd-u', { decision_kind: 'assumption_set', payload_hash: 'ph-d-u' });
  unsigned.push('decision.rejected', 'd-u', { reason: 'withdrawn before signing' });
  assert.equal(unsigned.fold().tables.decision['d-u']?.['status'], 'invalid');
});

test('P3-④ 第 1 轮：converted 也要被撤销级联回 open（不只 confirmed/rejected）', () => {
  const folder = new TestFolder();
  validDecision(folder, 'd-c', 'assumption_set', {
    spec_ids: ['A-1'],
    dispositions: [{ spec_id: 'A-1', disposition: 'converted' }],
  });
  recordAssumption(folder, 'A-1');
  folder.push('assumption.disposed', 'A-1', { decision_id: 'd-c', disposition: 'converted' });
  assert.equal(statusOf(folder), 'converted');
  folder.push('decision.revoked', 'd-c', { reason: 'converted batch revoked' });
  const state = folder.fold();
  assert.equal(state.tables.spec['A-1']?.['status'], 'open');
  assert.equal(state.tables.spec['A-1']?.['decision_id'], null);
});
