import { test } from 'node:test';
import { expectFoldFail, TestFolder, validDecision } from './folder.js';

test('P1-2 decision 只增不改：重复 valid、无 valid 直接 signed、二次 signed 都拒', () => {
  const duplicate = new TestFolder();
  validDecision(duplicate);
  duplicate.push('decision.valid', 'd-1', { decision_kind: 'intent', payload_hash: 'ph-1' });
  expectFoldFail(() => duplicate.fold(), /already exists; decisions are append-only/);

  const unsigned = new TestFolder();
  unsigned.push('decision.signed', 'd-9', {
    payload_hash: 'ph-9', signature: 's', key_id: 'k', signer: 'alice',
  });
  expectFoldFail(() => unsigned.fold(), /does not exist; decision\.valid must come first/);

  const twice = new TestFolder();
  validDecision(twice);
  twice.push('decision.signed', 'd-1', {
    payload_hash: 'ph-d-1', signature: 'sig-other', key_id: 'k', signer: 'mallory',
  });
  expectFoldFail(() => twice.fold(), /already signed; decisions are append-only/);
});

test('P1-2 decision.signed 的 payload_hash 必须与 valid 一致', () => {
  const folder = new TestFolder();
  folder.push('decision.valid', 'd-1', { decision_kind: 'intent', payload_hash: 'ph-1' });
  folder.push('decision.signed', 'd-1', { payload_hash: 'ph-2', signature: 's', key_id: 'k', signer: 'a' });
  expectFoldFail(() => folder.fold(), /payload_hash mismatch with decision\.valid/);
});
