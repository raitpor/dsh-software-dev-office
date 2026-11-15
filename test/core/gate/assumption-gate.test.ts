/**
 * M2-3 C9：core 判据 `assumption_set.signed` 的判定读数（gate 侧）连上条件②。
 * 与 `sdo_check` 共享 `validateAssumptionStatuses`，两边不各写一套。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { evaluateStageGate } from '../../../src/core/gate/evaluate.js';
import type { FoldState } from '../../../src/core/fold/types.js';
import { TestFolder } from '../folder.js';

function baseline(): { id: string; hash: string; policy: unknown; gates: unknown } {
  const file = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/baseline', 'waterfall.json'), 'utf8')) as Record<string, unknown>;
  return { id: String(file['id']), hash: String(file['hash']), policy: file['policy'], gates: file['gates'] };
}

function verdictOf(state: FoldState, code: string): string | undefined {
  const gate = evaluateStageGate(state, baseline(), 'req');
  return gate.readings.find((reading) => reading.criterion_id === code)?.verdict;
}

test('C9/gate：处置完备且 decision 有效 ⇒ assumption_set.signed pass', () => {
  const folder = new TestFolder();
  folder.push('assumption.recorded', 'A-1', { clause: 'c1', blast_radius: 'core', content_hash: 'ch:a1' });
  folder.push('decision.valid', 'd-as', {
    decision_kind: 'assumption_set',
    payload_hash: 'ph-d-as',
    frontier: 'f-1',
    payload: {
      spec_ids: ['A-1'],
      dispositions: [{ spec_id: 'A-1', disposition: 'confirmed' }],
      frontier: 'f-1',
    },
  });
  folder.push('decision.signed', 'd-as', {
    payload_hash: 'ph-d-as',
    frontier: 'f-1',
    signature: 'sig-d-as',
    key_id: 'key-1',
    signer: 'alice',
  });
  folder.push('assumption.disposed', 'A-1', { decision_id: 'd-as', disposition: 'confirmed' });
  assert.equal(verdictOf(folder.fold(), 'assumption_set.signed'), 'pass');
});

test('C9/gate：confirmed 行没有有效 decision 支撑 ⇒ assumption_set.signed fail（条件②，不只 check）', () => {
  const folder = new TestFolder();
  folder.push('assumption.recorded', 'A-1', { clause: 'c1', blast_radius: 'core', content_hash: 'ch:a1' });
  const base = folder.fold();
  const row = base.tables.spec['A-1'];
  assert.ok(row !== undefined);
  const state: FoldState = {
    ...base,
    tables: { ...base.tables, spec: { ...base.tables.spec, 'A-1': { ...row, status: 'confirmed' } } },
  };
  assert.equal(verdictOf(state, 'assumption_set.signed'), 'fail');
});

test('C9/gate：有 open 假设 ⇒ assumption_set.signed fail（不是 na/pass）', () => {
  const folder = new TestFolder();
  folder.push('assumption.recorded', 'A-1', { clause: 'c1', blast_radius: 'core', content_hash: 'ch:a1' });
  assert.equal(verdictOf(folder.fold(), 'assumption_set.signed'), 'fail');
});
