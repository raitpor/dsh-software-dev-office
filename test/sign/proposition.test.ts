import test from 'node:test';
import assert from 'node:assert/strict';

import {
  claimValueText,
  loadClaimRecords,
  renderClaimLine,
  renderClaimsProposition,
  resolveClaimDecision,
} from '../../src/sign/proposition.js';
import { withMigratedDb } from '../db/helpers.js';
import { seedClaim } from './page-helpers.js';

test('C1 命题完全由 claim 渲染：同一 claim 集合两次渲染逐字相同', () => {
  withMigratedDb((db) => {
    const { claimId } = seedClaim(db);
    const loaded = loadClaimRecords(db, [claimId]);
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    const first = renderClaimsProposition(loaded.claims);
    const second = renderClaimsProposition(loaded.claims);
    assert.equal(first, second);
    assert.match(first, /TASK-1/);
    assert.match(first, /done=true/);
    assert.match(first, /renderer:gate-result/);
    assert.equal(renderClaimLine(loaded.claims[0]!), first);
  });
});

test('C1 缺 claim / 重复 claim / 空 claim_ids 都 fail-closed', () => {
  withMigratedDb((db) => {
    const missing = loadClaimRecords(db, ['claim:NOPE']);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason_code, 'claim_not_found');

    const { claimId } = seedClaim(db);
    const duplicate = loadClaimRecords(db, [claimId, claimId]);
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.reason_code, 'claim_invalid');

    const empty = loadClaimRecords(db, []);
    assert.equal(empty.ok, false);
  });
});

test('C1 value 渲染：规范 JSON ⇒ code=value；坏 JSON 原样展示不抛错', () => {
  assert.equal(claimValueText(JSON.stringify({ code: 'done', value: true })), 'done=true');
  assert.equal(claimValueText('not json'), 'not json');
  assert.equal(claimValueText('42'), '42');
});

test('C1 解析结果：subject 由 claim 派生，value 固定，evidence 等于 claim id', () => {
  withMigratedDb((db) => {
    const { claimId } = seedClaim(db);
    const resolved = resolveClaimDecision(db, {
      claim_ids: [claimId],
      difference: 'v1 缺失，v2 有',
      consequence: '允许进入下一阶段',
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.resolved.subject, 'TASK-1');
    assert.equal(resolved.resolved.value, '已确认');
    assert.deepEqual(resolved.resolved.claim_ids, [claimId]);
    assert.deepEqual(resolved.resolved.evidence, [claimId]);
    assert.match(resolved.resolved.proposition, /TASK-1/);
    // 四元组缺差异/后果 = 不盲签闸门
    const noDifference = resolveClaimDecision(db, {
      claim_ids: [claimId],
      difference: ' ',
      consequence: 'x',
    });
    assert.equal(noDifference.ok, false);
  });
});
