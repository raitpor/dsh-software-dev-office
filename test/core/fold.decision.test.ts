import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectFoldFail, TestFolder, validDecision } from './folder.js';

test('P1-2 decision 只增不改：重复 valid 拒、无 valid 直接 signed 拒；多条 signed 合法（M3-3 起，dual_human 载体）', () => {
  const duplicate = new TestFolder();
  validDecision(duplicate);
  duplicate.push('decision.valid', 'd-1', { decision_kind: 'intent', payload_hash: 'ph-1' });
  expectFoldFail(() => duplicate.fold(), /already exists with different content/);

  const unsigned = new TestFolder();
  unsigned.push('decision.signed', 'd-9', {
    payload_hash: 'ph-9', signature: 's', key_id: 'k', signer: 'alice',
  });
  expectFoldFail(() => unsigned.fold(), /does not exist; decision\.valid must come first/);

  const twice = new TestFolder();
  validDecision(twice);
  // M3-3 起：第二个不同 actor 复签（payload_hash 一致）是合法事件——`dual_human` 的载体；
  // 投影行保持**首签**（签名列不覆盖），签名条数与 signer 集合由事件重算。
  twice.push('decision.signed', 'd-1', {
    payload_hash: 'ph-d-1', signature: 'sig-other', key_id: 'k', signer: 'mallory',
  });
  const afterTwice = twice.fold();
  const twiceRow = afterTwice.tables['decision']['d-1'] as Record<string, unknown>;
  assert.equal(twiceRow['signer'], 'alice');
  assert.equal(twiceRow['signature'], 'sig-d-1');

  // 同 actor 同 payload 重放：幂等 no-op（不报错、不改投影）
  twice.push('decision.signed', 'd-1', {
    payload_hash: 'ph-d-1', signature: 'sig-d-1', key_id: 'k', signer: 'alice',
  });
  const afterReplay = twice.fold();
  assert.equal((afterReplay.tables['decision']['d-1'] as Record<string, unknown>)['signature'], 'sig-d-1');

  // 但 payload_hash 不一致仍然拒（第二条也逃不掉）
  const mismatched = new TestFolder();
  validDecision(mismatched);
  mismatched.push('decision.signed', 'd-1', {
    payload_hash: 'ph-other', signature: 'sig-x', key_id: 'k', signer: 'mallory',
  });
  expectFoldFail(() => mismatched.fold(), /payload_hash mismatch/);
});

test('P1-2 decision.signed 的 payload_hash 必须与 valid 一致', () => {
  const folder = new TestFolder();
  folder.push('decision.valid', 'd-1', { decision_kind: 'intent', payload_hash: 'ph-1' });
  folder.push('decision.signed', 'd-1', { payload_hash: 'ph-2', signature: 's', key_id: 'k', signer: 'a' });
  expectFoldFail(() => folder.fold(), /payload_hash mismatch with decision\.valid/);
});
