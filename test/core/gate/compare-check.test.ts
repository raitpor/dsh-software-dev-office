/**
 * M2-2 C6：判定 readings 与 sdo_check 的逐判据三态对账（同一 fold 状态）。
 * 两边实现独立（core 不依赖 src/check），这里只比对输出；core 三条必须一致。
 */
import { grantFixtureRoster } from '../../db/append-auth.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { evaluateStageGate, policyFromBaseline, registeredCriteria } from '../../../src/core/gate/evaluate.js';
import { emptyState } from '../../../src/core/fold/state.js';
import { evaluateCriterionCode } from '../../../src/check/evaluate.js';
import type { FoldState } from '../../../src/core/fold/types.js';
import { openSdoDatabase } from '../../../src/db/open.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/baseline', name), 'utf8')) as Record<string, unknown>;

test('C6: core 三条判定与 sdo_check 三态一致（空状态）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m2-2-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), 'm2-2 compare passphrase');
  try {
    runMigrations(db);
    grantFixtureRoster(db);
    const file = fixture('waterfall.json');
    const baseline = { id: String(file['id']), hash: String(file['hash']), policy: file['policy'], gates: file['gates'] };
    const state: FoldState = emptyState();
    const policy = policyFromBaseline(file['policy'], file['gates']);
    const registered = registeredCriteria(state);
    const gate = evaluateStageGate(state, baseline, 'req');
    for (const code of ['spec_set.signed', 'assumption_set.signed', 'provenance.present']) {
      const check = evaluateCriterionCode(db, state, code, policy, new Set(registered));
      const reading = gate.readings.find((candidate) => candidate.criterion_id === code);
      assert.ok(reading !== undefined, `${code} missing from gate readings`);
      assert.equal(reading.verdict, check.result, `${code}: gate ${reading.verdict} vs check ${check.result}`);
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C6: 判定读数覆盖的同门判据集合与 sdo_check 的 gate criteria 一致', () => {
  const file = fixture('waterfall.json');
  const baseline = { id: String(file['id']), hash: String(file['hash']), policy: file['policy'], gates: file['gates'] };
  const state = emptyState();
  const gate = evaluateStageGate(state, baseline, 'req');
  const expected = new Set(
    (file['gates'] as Array<Record<string, unknown>>)
      .filter((candidate) => candidate['stage'] === 'req')
      .flatMap((candidate) => candidate['criteria'] as string[]),
  );
  assert.deepEqual(new Set(gate.readings.map((reading) => reading.criterion_id)), expected);
});
