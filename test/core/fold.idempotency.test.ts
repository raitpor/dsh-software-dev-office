import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fold, FoldError } from '../../src/core/fold/index.js';
import { eventFactory, signedDecision, stableStringify } from './helpers.js';

test('C3 同一事件投递两次：结果与只投一次相同', () => {
  const { ev } = eventFactory('idem');
  const d = signedDecision(ev, 'd-1', 'intent');
  const e1 = ev('intent.signed', 'INT-1', {
    decision_id: 'd-1', statement: 's', owner: 'o', strength: 'explicit', content_hash: 'ch-1',
  });
  const once = fold(undefined, [...d, e1]);
  const twice = fold(undefined, [...d, e1, e1]);
  assert.equal(stableStringify(twice), stableStringify(once));
  assert.equal(twice.eventIds.length, 3);
});

test('C3 同 id 不同 payload：第一条生效，后一条按已见跳过', () => {
  const { ev } = eventFactory('idem2');
  const d = signedDecision(ev, 'd-1', 'intent');
  const first = ev('intent.signed', 'INT-1', {
    decision_id: 'd-1', statement: 'first', owner: 'o', strength: 'explicit', content_hash: 'ch-1',
  });
  const second = {
    ...first,
    payload: { decision_id: 'd-1', statement: 'second', owner: 'o', strength: 'explicit', content_hash: 'ch-2' },
  };
  const state = fold(undefined, [...d, first, second]);
  assert.equal(state.tables.intent['INT-1']?.['statement'], 'first');
  assert.equal(state.eventIds.length, 3);
});

test('C3 已见事件不参与增量重放：fold(prev, same batch) 不变', () => {
  const { ev } = eventFactory('idem3');
  const events = [
    ...signedDecision(ev, 'd-1', 'intent'),
    ev('intent.signed', 'INT-1', {
      decision_id: 'd-1', statement: 's', owner: 'o', strength: 'explicit', content_hash: 'ch-1',
    }),
  ];
  const first = fold(undefined, events);
  const second = fold(first, events);
  assert.equal(stableStringify(second), stableStringify(first));
  assert.equal(second.eventIds.length, events.length);
});

test('C3 坏事件重复投递不会二次爆炸（已见即跳过，先于信封校验）', () => {
  const { ev } = eventFactory('idem4');
  const good = ev('spec.defined', 'SPEC-1', { intent_id: 'INT-1', clause: 'c', kind: 'requirement' });
  const bad = { ...good, id: good.id, payload: 'not-an-object' };
  const state = fold(undefined, [good, bad]);
  assert.equal(state.tables.spec['SPEC-1']?.['clause'], 'c');
  assert.throws(
    () => fold(undefined, [{ ...bad, id: 'e-fresh-1' }]),
    (error: unknown) => error instanceof FoldError && /payload must be a JSON object/.test(error.message),
  );
});
