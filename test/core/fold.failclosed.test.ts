import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fold, FoldError } from '../../src/core/fold/index.js';
import { eventFactory, signedDecision } from './helpers.js';

test('C5 未知 kind：抛 FoldError，消息带事件 id 与 kind', () => {
  const { ev } = eventFactory('fc');
  const event = ev('nonsense.exploded', 'X-1', {});
  assert.throws(
    () => fold(undefined, [event]),
    (error: unknown) =>
      error instanceof FoldError &&
      error.message.includes(event.id) &&
      error.message.includes('nonsense.exploded') &&
      /unknown event kind/.test(error.message),
  );
});

test('C5 缺字段：抛 FoldError，消息带事件 id、kind 与字段名', () => {
  const { ev } = eventFactory('fc2');
  const decisionEvents = signedDecision(ev, 'd-1', 'intent');
  const event = ev('intent.signed', 'INT-1', { decision_id: 'd-1', owner: 'alice', strength: 'explicit', content_hash: 'ch-1' });
  assert.throws(
    () => fold(undefined, [...decisionEvents, event]),
    (error: unknown) =>
      error instanceof FoldError &&
      error.message.includes(event.id) &&
      error.message.includes('intent.signed') &&
      /payload\.statement/.test(error.message),
  );
});

test('C5 坏 payload（非对象）：不静默、不部分应用', () => {
  const { ev } = eventFactory('fc3');
  const event = ev('task.created', 'TASK-1', 'not-an-object');
  assert.throws(() => fold(undefined, [event]), /payload must be a JSON object/);
});

test('C5 坏信封：缺 id/kind 等字段时抛错，且不返回半成品状态', () => {
  const { ev } = eventFactory('fc4');
  const event = ev('intent.proposed', 'INT-1', {});
  const broken = { ...event, hash: '' };
  assert.throws(() => fold(undefined, [broken]), /hash must be a non-empty string/);
});

test('C5 前置事件缺失：直接失败（不当作 upsert 静默补行）', () => {
  const { ev } = eventFactory('fc5');
  const event = ev('task.done', 'TASK-404', {});
  assert.throws(
    () => fold(undefined, [event]),
    (error: unknown) => error instanceof FoldError && /does not exist/.test(error.message),
  );
});
