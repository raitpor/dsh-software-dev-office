import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fold } from '../../src/core/fold/index.js';
import { eventFactory, signedDecision, stableStringify } from './helpers.js';

function scenarioEvents() {
  const { ev } = eventFactory('det');
  return [
    ...signedDecision(ev, 'd-1', 'plan', {
      node_ids: ['GOAL-1'],
      tree: [{ id: 'GOAL-1', parent_id: null, kind: 'intent', goal: 'root' }],
    }),
    ...signedDecision(ev, 'd-i', 'intent'),
    ev('intent.signed', 'INT-1', {
      decision_id: 'd-i', statement: 'statement', owner: 'alice', strength: 'explicit', content_hash: 'ch-1',
    }),
    ev('spec.defined', 'SPEC-1', { intent_id: 'INT-1', clause: 'clause', kind: 'requirement' }),
    ev('goal.declared', 'GOAL-1', { kind: 'intent', intent_id: 'INT-1', decision_id: 'd-1', goal: 'root' }),
    ev('task.created', 'TASK-1', {
      seq: 1,
      title: 'card',
      kind: 'implement',
      blocked_by: [],
      scope_paths: ['src/'],
      inputs: [],
    }),
    ev('task.claimed', 'TASK-1', {}),
    ev('task.blocked', 'TASK-1', { block_code: 'awaiting_signature', reason: 'wait' }),
    ev('task.unblocked', 'TASK-1', {}),
    ev('task.claimed', 'TASK-1', {}),
    ev('task.done', 'TASK-1', {}),
  ];
}

test('C2 同一事件序列重放两次，stable stringify 逐字节相同', () => {
  const events = scenarioEvents();
  const a = fold(undefined, events);
  const b = fold(undefined, scenarioEvents());
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(a.eventIds.length, events.length);
});

test('C2 增量重放（prev + 余下事件）与全量重放结果一致', () => {
  const events = scenarioEvents();
  const full = fold(undefined, events);
  const half = fold(undefined, events.slice(0, 5));
  const rest = fold(half, events.slice(5));
  assert.equal(stableStringify(rest), stableStringify(full));
});

test('C2 payload 键序不同不影响结果（不靠对象键序碰巧）', () => {
  const { ev } = eventFactory('order');
  const first = fold(undefined, [
    ev('spec.defined', 'SPEC-1', { kind: 'requirement', clause: 'c', intent_id: 'INT-1' }),
  ]);
  const second = fold(undefined, [
    ev('spec.defined', 'SPEC-1', { intent_id: 'INT-1', clause: 'c', kind: 'requirement' }),
  ]);
  assert.equal(stableStringify(first.tables), stableStringify(second.tables));
});
