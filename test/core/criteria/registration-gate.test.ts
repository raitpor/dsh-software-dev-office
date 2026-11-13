import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TestFolder, expectFoldFail } from '../folder.js';

/**
 * P1-3：`criterion.registered` 是唯一写路径上的机械门——新建判据必须带
 * >=1 正例 + >=1 负例夹具；`legacy: true` 是迁移例外（verify 计数暴露）。
 */

const POS = { polarity: 'positive', input: 'p', expected_status: 'pass' };
const NEG = { polarity: 'negative', input: 'n', expected_status: 'fail' };

test('P1-3: criterion.registered without fixtures fails on the write path', () => {
  const folder = new TestFolder();
  folder.push('criterion.registered', 'CRIT-1', { spec_id: 'SPEC-1', remedy: 'r' }, undefined, { raw: true });
  expectFoldFail(() => folder.fold(), /requires fixtures\[\] with >=1 positive and >=1 negative/);
});

test('P1-3: only a positive fixture is not enough', () => {
  const folder = new TestFolder();
  folder.push('criterion.registered', 'CRIT-1', { spec_id: 'SPEC-1', remedy: 'r', fixtures: [POS] }, undefined, {
    raw: true,
  });
  expectFoldFail(() => folder.fold(), /requires fixtures\[\] with >=1 positive and >=1 negative/);
});

test('P1-3: legacy:true allows the migration exception without fixtures', () => {
  const folder = new TestFolder();
  folder.push('criterion.registered', 'CRIT-1', { spec_id: 'SPEC-1', remedy: 'r', legacy: true }, undefined, {
    raw: true,
  });
  assert.equal(folder.fold().tables.criterion['CRIT-1']?.['remedy'], 'r');
});

test('P1-3/P3: duplicate polarity+input fixture is rejected by the reducer too', () => {
  const folder = new TestFolder();
  folder.push(
    'criterion.registered',
    'CRIT-1',
    { spec_id: 'SPEC-1', remedy: 'r', fixtures: [POS, POS, NEG] },
    undefined,
    { raw: true },
  );
  expectFoldFail(() => folder.fold(), /duplicate fixture/);
});

test('C3: release.frozen requires a JSON array of at least two humans', () => {
  const one = new TestFolder();
  one.push('release.frozen', 'REL-1', {
    frozen_by: ['alice'],
    frontier: 'f',
    baseline_hash: 'h',
    scope_spec_set: 's',
    items: [],
  }, undefined, { raw: true });
  expectFoldFail(() => one.fold(), /at least two humans/);

  const two = new TestFolder();
  two.push('release.frozen', 'REL-1', {
    frozen_by: ['alice', 'bob'],
    frontier: 'f',
    baseline_hash: 'h',
    scope_spec_set: 's',
    items: [],
  }, undefined, { raw: true });
  assert.deepEqual(two.fold().tables.release['REL-1']?.['frozen_by'], ['alice', 'bob']);
});

test('C4: gate.judged without gate_id/baseline_hash fails; with them fills the row', () => {
  const missing = new TestFolder();
  missing.push('stage.entered', 'STAGE-1', { stage: 'design' });
  missing.push('gate.judged', 'STAGE-1', { verdict: 'pass' });
  expectFoldFail(() => missing.fold(), /gate\.judged requires gate_id/);

  const complete = new TestFolder();
  complete.push('stage.entered', 'STAGE-1', { stage: 'design' });
  complete.push('gate.judged', 'STAGE-1', {
    verdict: 'pass',
    gate_id: 'gate-design',
    baseline_hash: 'h-baseline',
  });
  const row = complete.fold().tables.stage_run['STAGE-1'];
  assert.equal(row?.['gate_id'], 'gate-design');
  assert.equal(row?.['baseline_hash'], 'h-baseline');
  assert.equal(row?.['verdict'], 'pass');
});
