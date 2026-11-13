import assert from 'node:assert/strict';
import { test } from 'node:test';

import { invalidateRestatement, proposeRestatement } from '../../src/align/restatement.js';
import { listRestatements, readAlignmentState } from '../../src/align/gate.js';
import {
  ALIGN_AT,
  appendIntent,
  appendRequirement,
  draft,
  eventCount,
  intentEdge,
  withAlignDb,
} from './helpers.js';

test('C1：复述绑定当前 intent hash 才能写，且只写一条 restatement.recorded', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const before = eventCount(db);
    const result = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [draft('d1'), draft('d2')],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
      actor: 'agent-alpha',
      at: ALIGN_AT,
      by: 'agent-alpha',
    });
    assert.equal(result.ok, true);
    assert.equal(eventCount(db), before + 1);

    const state = readAlignmentState(db);
    const rows = listRestatements(state);
    const row = rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.intent_id, 'INT-1');
    assert.deepEqual(row.draft_specs, [draft('d1'), draft('d2')]);
    assert.deepEqual(row.inputs, [intentEdge('INT-1', 'ch:intent-1')]);
    assert.equal(row.by, 'agent-alpha');
    assert.equal(row.at, ALIGN_AT);
    assert.equal(row.invalid_reason, null);
    assert.deepEqual(row.accepted_spec_ids, []);
  });
});

test('C1：intent hash 过期 ⇒ stale_restatement，不写事件，回执带旧/新 hash', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const before = eventCount(db);
    const result = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [draft('d1')],
      inputs: [intentEdge('INT-1', 'ch:old-intent')],
      actor: 'agent-alpha',
      at: ALIGN_AT,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason_code, 'stale_restatement');
    assert.ok(result.staleReason?.includes('ch:old-intent'));
    assert.ok(result.staleReason?.includes('ch:intent-1'));
    assert.equal(eventCount(db), before);
  });
});

test('C1：inputs 形状非法/草案非法 ⇒ invalid_args，不写事件', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const before = eventCount(db);
    const base = { intentId: 'INT-1', actor: 'agent-alpha', at: ALIGN_AT } as const;

    const twoEdges = proposeRestatement(db, {
      ...base,
      draftSpecs: [draft('d1')],
      inputs: [intentEdge('INT-1', 'ch:intent-1'), { kind: 'intent', id: 'INT-2', hash: 'x' }],
    });
    assert.equal(twoEdges.ok, false);
    if (!twoEdges.ok) assert.equal(twoEdges.reason_code, 'invalid_args');

    const wrongKind = proposeRestatement(db, {
      ...base,
      draftSpecs: [draft('d1')],
      inputs: [{ kind: 'spec', id: 'INT-1', hash: 'ch:intent-1' }],
    });
    assert.equal(wrongKind.ok, false);
    if (!wrongKind.ok) assert.equal(wrongKind.reason_code, 'invalid_args');

    const wrongId = proposeRestatement(db, {
      ...base,
      draftSpecs: [draft('d1')],
      inputs: [intentEdge('INT-2', 'ch:intent-1')],
    });
    assert.equal(wrongId.ok, false);
    if (!wrongId.ok) assert.equal(wrongId.reason_code, 'invalid_args');

    const emptyDrafts = proposeRestatement(db, {
      ...base,
      draftSpecs: [],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
    });
    assert.equal(emptyDrafts.ok, false);
    if (!emptyDrafts.ok) assert.equal(emptyDrafts.reason_code, 'invalid_args');

    const duplicateDrafts = proposeRestatement(db, {
      ...base,
      draftSpecs: [draft('d1'), draft('d1')],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
    });
    assert.equal(duplicateDrafts.ok, false);
    if (!duplicateDrafts.ok) assert.equal(duplicateDrafts.reason_code, 'invalid_args');

    const noDraftId = proposeRestatement(db, {
      ...base,
      draftSpecs: [{ clause: '没有 id' }],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
    });
    assert.equal(noDraftId.ok, false);
    if (!noDraftId.ok) assert.equal(noDraftId.reason_code, 'invalid_args');

    assert.equal(eventCount(db), before);
  });
});

test('C2：复述必须早于该 intent 下最早条款，否则 restatement_too_late', () => {
  withAlignDb((db) => {
    appendIntent(db, { at: '2026-11-13T01:00:00Z' });
    appendRequirement(db, { at: '2026-11-13T02:00:00Z' });

    const late = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [draft('d1')],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
      actor: 'agent-alpha',
      at: '2026-11-13T03:00:00Z',
    });
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.reason_code, 'restatement_too_late');

    const early = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [draft('d1')],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
      actor: 'agent-alpha',
      at: '2026-11-13T01:30:00Z',
    });
    assert.equal(early.ok, true);
  });
});

test('C1：intent 不存在 ⇒ intent_not_found', () => {
  withAlignDb((db) => {
    const result = proposeRestatement(db, {
      intentId: 'INT-missing',
      draftSpecs: [draft('d1')],
      inputs: [intentEdge('INT-missing', 'ch:intent-1')],
      actor: 'agent-alpha',
      at: ALIGN_AT,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_code, 'intent_not_found');
  });
});

test('C6：invalidateRestatement 只写一次作废，重复作废/不存在给结构化失败', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const proposed = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [draft('d1')],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
      actor: 'agent-alpha',
      at: ALIGN_AT,
    });
    assert.equal(proposed.ok, true);

    const restatement = listRestatements(readAlignmentState(db))[0];
    assert.ok(restatement !== undefined);

    const invalidated = invalidateRestatement(db, {
      restatementId: restatement.id,
      reason: 'intent 被重新签字，content_hash 变化',
      actor: 'agent-alpha',
      at: ALIGN_AT,
    });
    assert.equal(invalidated.ok, true);

    const afterFirst = readAlignmentState(db);
    const row = listRestatements(afterFirst)[0];
    assert.ok(row !== undefined);
    assert.equal(row.invalid_reason, 'intent 被重新签字，content_hash 变化');

    const beforeSecond = eventCount(db);
    const second = invalidateRestatement(db, {
      restatementId: restatement.id,
      reason: '再作废一次',
      actor: 'agent-alpha',
      at: ALIGN_AT,
    });
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason_code, 'restatement_invalidated');
    assert.equal(eventCount(db), beforeSecond);

    const missing = invalidateRestatement(db, {
      restatementId: 'RST-missing',
      reason: 'x',
      actor: 'agent-alpha',
      at: ALIGN_AT,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason_code, 'restatement_not_found');
  });
});

test('P2：时间按真实时刻比较，带时区偏移的复述晚于条款 ⇒ restatement_too_late', () => {
  withAlignDb((db) => {
    appendIntent(db, { at: '2026-01-01T00:00:00Z' });
    appendRequirement(db, { at: '2026-01-01T02:00:00Z' });
    const result = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [draft('d1')],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
      actor: 'agent-alpha',
      at: '2025-12-31T23:00:00-05:00',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_code, 'restatement_too_late');
  });
});

test('P2：at 无时区/不可解析 ⇒ invalid_args，不写事件', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const before = eventCount(db);
    const result = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [draft('d1')],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
      actor: 'agent-alpha',
      at: '2026-01-01T00:00:00',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_code, 'invalid_args');
    assert.equal(eventCount(db), before);
  });
});

test('P3：acceptedSpecIds 必须是 draftSpecs 或已存在 spec 的 id', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const unknown = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [draft('d1')],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
      actor: 'agent-alpha',
      at: ALIGN_AT,
      acceptedSpecIds: ['SPEC-unknown'],
    });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.reason_code, 'invalid_args');

    const ok = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [draft('d1'), draft('d2')],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
      actor: 'agent-alpha',
      at: ALIGN_AT,
      acceptedSpecIds: ['d1'],
    });
    assert.equal(ok.ok, true);
  });
});
