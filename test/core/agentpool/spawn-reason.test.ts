import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateSpawnReason } from '../../../src/core/agentpool/spawn-reason.js';
import type { PoolSnapshot } from '../../../src/core/agentpool/types.js';

const empty: PoolSnapshot = { idle: [], watermark_limit: 0.7 };
const idle: PoolSnapshot = {
  watermark_limit: 0.7,
  idle: [
    { agent_id: 'agent-a', actor_id: 'a', skills: ['implement'], last_task_files: ['src/other/x.ts'], watermark: 0.2 },
  ],
};

test('C1: no_idle_capable passes only when the candidate set is empty', () => {
  assert.deepEqual(
    validateSpawnReason({ new_reason: 'no_idle_capable', snapshot: empty, card_scope_files: ['src/agent/'], actor_has_compaction: false }),
    { ok: true, reason: 'no_idle_capable' },
  );
  const rejected = validateSpawnReason({
    new_reason: 'no_idle_capable',
    snapshot: idle,
    required_skills: ['implement'],
    card_scope_files: ['src/agent/'],
    actor_has_compaction: false,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.reason_code, 'spawn_reason_mismatch');
    assert.deepEqual(rejected.details, ['agent-a']);
  }
});

test('C1: context_irrelevant requires candidates and empty last_task ∩ card scope', () => {
  assert.equal(
    validateSpawnReason({
      new_reason: 'context_irrelevant',
      snapshot: idle,
      required_skills: ['implement'],
      card_scope_files: ['src/agent/'],
      actor_has_compaction: false,
    }).ok,
    true,
  );
  const intersecting = validateSpawnReason({
    new_reason: 'context_irrelevant',
    snapshot: idle,
    required_skills: ['implement'],
    card_scope_files: ['src/other/x.ts'],
    actor_has_compaction: false,
  });
  assert.equal(intersecting.ok, false);
  if (!intersecting.ok) assert.equal(intersecting.reason_code, 'spawn_reason_mismatch');
});

test('C1: context_irrelevant with candidates lacking last_task treats it as no intersection (D-192 boundary)', () => {
  const noLastTask: PoolSnapshot = {
    watermark_limit: 0.7,
    idle: [{ agent_id: 'agent-x', actor_id: 'x', skills: ['implement'], last_task_files: [], watermark: 0.2 }],
  };
  assert.equal(
    validateSpawnReason({
      new_reason: 'context_irrelevant',
      snapshot: noLastTask,
      required_skills: ['implement'],
      card_scope_files: ['src/agent/'],
      actor_has_compaction: false,
    }).ok,
    true,
  );
});

test('C1: watermark_exhausted requires every candidate at/above limit and a compaction attempt', () => {
  const full: PoolSnapshot = {
    watermark_limit: 0.7,
    idle: [{ agent_id: 'agent-a', actor_id: 'a', skills: ['implement'], last_task_files: [], watermark: 0.9 }],
  };
  assert.equal(
    validateSpawnReason({
      new_reason: 'watermark_exhausted',
      snapshot: full,
      required_skills: ['implement'],
      card_scope_files: [],
      actor_has_compaction: true,
    }).ok,
    true,
  );
  assert.equal(
    validateSpawnReason({
      new_reason: 'watermark_exhausted',
      snapshot: full,
      required_skills: ['implement'],
      card_scope_files: [],
      actor_has_compaction: false,
    }).ok,
    false,
  );
  assert.equal(
    validateSpawnReason({
      new_reason: 'watermark_exhausted',
      snapshot: idle,
      required_skills: ['implement'],
      card_scope_files: [],
      actor_has_compaction: true,
    }).ok,
    false,
  );
});

test('C1: unknown reason and incomplete snapshot fail as invalid_field', () => {
  const unknown = validateSpawnReason({ new_reason: 'pool_empty', snapshot: empty, card_scope_files: [], actor_has_compaction: false });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.reason_code, 'invalid_field');
  const incomplete = validateSpawnReason({ new_reason: 'no_idle_capable', snapshot: {}, card_scope_files: [], actor_has_compaction: false });
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.equal(incomplete.reason_code, 'invalid_field');
});

test('P2-1: malformed idle entry is invalid_field with the failing field path', () => {
  const malformed = { watermark_limit: 0.7, idle: [null] } as unknown as PoolSnapshot;
  const result = validateSpawnReason({
    new_reason: 'no_idle_capable',
    snapshot: malformed,
    card_scope_files: [],
    actor_has_compaction: false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason_code, 'invalid_field');
    assert.match(result.message, /snapshot\.idle\[0\]/);
  }
});

test('P2-3: context intersection is by path-segment prefix, not substring', () => {
  const candidate = (files: string[]): PoolSnapshot => ({
    watermark_limit: 0.7,
    idle: [{ agent_id: 'agent-a', actor_id: 'a', skills: ['implement'], last_task_files: files, watermark: 0.1 }],
  });
  const intersecting = validateSpawnReason({
    new_reason: 'context_irrelevant',
    snapshot: candidate(['src/agent/x.ts']),
    required_skills: ['implement'],
    card_scope_files: ['src/agent/'],
    actor_has_compaction: false,
  });
  assert.equal(intersecting.ok, false);
  if (!intersecting.ok) assert.equal(intersecting.reason_code, 'spawn_reason_mismatch');

  const lookalike = validateSpawnReason({
    new_reason: 'context_irrelevant',
    snapshot: candidate(['a/bc/x.ts']),
    required_skills: ['implement'],
    card_scope_files: ['a/b/'],
    actor_has_compaction: false,
  });
  assert.equal(lookalike.ok, true);
});
