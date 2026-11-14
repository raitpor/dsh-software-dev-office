/**
 * M2-1 C4/C5/C8：新行/方向/旧行可复算；verify 按引用版本对账，不与当前 head 比。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { baselineHash } from '../../src/core/baseline/freeze.js';
import { verifyBaselineReferences } from '../../src/core/baseline/verify-references.js';
import { verify } from '../../src/core/verify.js';
import { confirmFreeze, previewFreeze, type FreezeDbResult } from '../../src/db/freeze.js';
import type { FreezePreviewView } from '../../src/db/freeze-preview.js';
import {
  AT,
  SESSION,
  clone,
  readBaselineFixture,
  rows,
  unlock,
  withFreezeRig,
  type FreezeRig,
} from './baseline-freeze-helpers.js';

function asPreview(result: FreezePreviewView | FreezeDbResult): FreezePreviewView {
  assert.equal(result.ok, true);
  return result as FreezePreviewView;
}

async function freeze(rig: FreezeRig, input: Record<string, unknown>): Promise<FreezePreviewView> {
  await unlock(rig);
  const preview = asPreview(previewFreeze(rig.db, input, SESSION, { now: AT }));
  const done = await confirmFreeze(
    rig.db,
    rig.client,
    { preview_id: preview.preview_id, payload_hash: preview.payload_hash },
    SESSION,
    { now: AT },
  );
  assert.equal(done.ok, true);
  return preview;
}

function withCriterion(base: Record<string, unknown>): Record<string, unknown> {
  const next = clone(base);
  next['id'] = 'bl-waterfall-2';
  (next['criteria'] as Array<Record<string, unknown>>).push({
    id: 'task.complete',
    version: '1',
    params: {},
    guarantee: '3',
  });
  return next;
}

test('C4: 收紧建新行（prev=旧 head、direction=tighten、旧行 hash 不变）', async () => {
  await withFreezeRig(async (rig) => {
    const v1 = readBaselineFixture('waterfall.json');
    const p1 = await freeze(rig, v1);
    const before = rows(rig.db, 'SELECT * FROM baseline WHERE id = ?', p1.id)[0]!;
    const p2 = await freeze(rig, withCriterion(v1));
    assert.equal(p2.direction, 'tighten');
    const after = rows(rig.db, 'SELECT * FROM baseline WHERE id = ?', p1.id)[0]!;
    assert.deepEqual(after, before);
    const v2 = rows(rig.db, 'SELECT * FROM baseline WHERE id = ?', p2.id)[0]!;
    assert.equal(v2['prev'], p1.id);
    assert.equal(v2['direction'], 'tighten');
    assert.equal(rows(rig.db, "SELECT 1 AS n FROM event WHERE kind = 'baseline.amended'").length, 1);
    const report = verifyBaselineReferences(rig.db);
    assert.equal(report.ok, true);
  });
});

test('C4/C7: 放宽建新行（需人签 decision kind=baseline）且事件为 baseline.loosened', async () => {
  await withFreezeRig(async (rig) => {
    const v1 = readBaselineFixture('waterfall.json');
    await freeze(rig, v1);
    const v2 = withCriterion(v1);
    await freeze(rig, v2);
    const v3 = clone(v1);
    v3['id'] = 'bl-waterfall-3';
    const p3 = await freeze(rig, v3);
    assert.equal(p3.direction, 'loosen');
    const row = rows(rig.db, 'SELECT * FROM baseline WHERE id = ?', p3.id)[0]!;
    assert.equal(row['direction'], 'loosen');
    assert.equal(rows(rig.db, "SELECT 1 AS n FROM event WHERE kind = 'baseline.loosened'").length, 1);
    const report = verifyBaselineReferences(rig.db);
    assert.equal(report.ok, true, JSON.stringify(report.problems));
  });
});

test('C5: 声明方向与工具判定不符 ⇒ direction_mismatch，0 行', async () => {
  await withFreezeRig(async (rig) => {
    const v1 = readBaselineFixture('waterfall.json');
    await freeze(rig, v1);
    await unlock(rig);
    const preview = asPreview(previewFreeze(rig.db, withCriterion(v1), SESSION, { now: AT }));
    const rejected = await confirmFreeze(
      rig.db,
      rig.client,
      { preview_id: preview.preview_id, payload_hash: preview.payload_hash, declared_direction: 'loosen' },
      SESSION,
      { now: AT },
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason_code, 'direction_mismatch');
    assert.equal(rows(rig.db, 'SELECT 1 AS n FROM baseline').length, 1);
  });
});

test('C8: verify 按引用的那一版比（v1 被引用时 head 已是 v2 仍绿）；篡改旧行才红', async () => {
  await withFreezeRig(async (rig) => {
    const v1 = readBaselineFixture('waterfall.json');
    const p1 = await freeze(rig, v1);
    const p2 = await freeze(rig, withCriterion(v1));
    rig.db
      .prepare(
        'INSERT INTO stage_run (id, stage, gate_id, baseline_hash, entered_at, exited_at, verdict, criteria, at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run('SR-REF', 'req', 'G_req_exit', p1.hash, AT.toISOString(), null, 'pass', '[]', AT.toISOString());
    rig.db
      .prepare(
        'INSERT INTO release (id, package_version, status, frozen_at, frozen_by, frontier, baseline_hash, scope_spec_set, note) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run('REL-REF', '0.1.0', 'frozen', AT.toISOString(), '["alice","bob"]', 'f', p2.hash, 'ss', null);
    const ok = verifyBaselineReferences(rig.db);
    assert.equal(ok.ok, true, JSON.stringify(ok.problems));

    rig.db.exec('DROP TRIGGER trg_baseline_append_only_update');
    rig.db.prepare('UPDATE baseline SET hash = ? WHERE id = ?').run('sha256:tampered', p1.id);
    const bad = verifyBaselineReferences(rig.db);
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.some((problem) => problem.code === 'baseline_hash_mismatch' && problem.objectId === p1.id));
    // P1-2：产品 verify() 也要能抓到手改 baseline（不再只靠单独导出的辅助函数）。
    const product = verify(rig.db);
    assert.equal(product.ok, false);
    assert.ok(product.problems.some((problem) => problem.code === 'baseline_hash_mismatch' && problem.objectId === p1.id));
  });
});

test('C8: 引用未知 baseline_hash ⇒ baseline_missing；手插 baseline 行无事件 ⇒ baseline_unfrozen', async () => {
  await withFreezeRig(async (rig) => {
    const p1 = await freeze(rig, readBaselineFixture('waterfall.json'));
    rig.db
      .prepare(
        'INSERT INTO stage_run (id, stage, gate_id, baseline_hash, entered_at, exited_at, verdict, criteria, at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run('SR-MISS', 'req', null, 'sha256:missing', AT.toISOString(), null, 'pass', '[]', AT.toISOString());
    const report = verifyBaselineReferences(rig.db);
    assert.ok(report.problems.some((problem) => problem.code === 'baseline_missing'));

    const row = rows(rig.db, 'SELECT * FROM baseline WHERE id = ?', p1.id)[0]!;
    const hash = baselineHash({
      prev: null,
      rowDirection: null,
      input: {
        engine: { version: 'manual-engine', criteria_manifest_hash: String(row['criteria_manifest_hash']) },
        policy: JSON.parse(String(row['policy'])) as unknown,
        criteria: JSON.parse(String(row['criteria'])) as unknown,
        gates: JSON.parse(String(row['gates'])) as unknown,
        thresholds: JSON.parse(String(row['thresholds'])) as unknown,
        assurance: JSON.parse(String(row['assurance'])) as unknown,
      },
    });
    rig.db
      .prepare(
        'INSERT INTO baseline (id, frozen_by, engine_version, criteria_manifest_hash, policy, criteria, gates, thresholds, assurance, prev, direction, hash, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run('B-MANUAL', 'alice', 'manual-engine', row['criteria_manifest_hash'], row['policy'], row['criteria'], row['gates'], row['thresholds'], row['assurance'], null, null, hash, AT.toISOString());
    const manual = verifyBaselineReferences(rig.db);
    assert.ok(manual.problems.some((problem) => problem.code === 'baseline_unfrozen' && problem.objectId === 'B-MANUAL'));
  });
});
