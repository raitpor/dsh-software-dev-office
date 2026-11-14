/**
 * M2-1 P1-1：confirm 只认服务端 registry 的 preview_id；P15 在 confirm 时服务端重跑。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { previewBaseline } from '../../src/core/baseline/freeze.js';
import {
  confirmFreeze,
  previewFreeze,
  type FreezeDbResult,
} from '../../src/db/freeze.js';
import { __seedPreviewForTest, type FreezePreviewView } from '../../src/db/freeze-preview.js';
import { chainHead } from '../../src/db/write.js';
import { rows } from './baseline-freeze-helpers.js';
import {
  AT,
  SESSION,
  readBaselineFixture,
  rowCount,
  withFreezeRig,
} from './baseline-freeze-helpers.js';

function asPreview(result: FreezePreviewView | FreezeDbResult): FreezePreviewView {
  assert.equal(result.ok, true);
  return result as FreezePreviewView;
}

test('P1-1: 伪造 preview 对象/未知 preview_id ⇒ preview_expired，0 行', async () => {
  await withFreezeRig(async ({ db, client }) => {
    const forged = await confirmFreeze(
      db,
      client,
      { preview_id: 'pv-forged', payload_hash: 'sha256:forged' },
      SESSION,
      { now: AT },
    );
    assert.equal(forged.ok, false);
    assert.equal(forged.reason_code, 'preview_expired');
    assert.equal(rowCount(db, 'baseline'), 0);
  });
});

test('P1-1: confirm 时重跑 P15——registry 里的 raw 若变坏 ⇒ rejected + 0 行', async () => {
  await withFreezeRig(async ({ db, client }) => {
    const good = readBaselineFixture('waterfall.json');
    const bad = readBaselineFixture('criteria-empty.json');
    const goodPreview = previewBaseline(good, { current: null, id: 'bl-raw', frozen_by: SESSION.actor, frontier: chainHead(db) });
    assert.equal(goodPreview.ok, true);
    const previewId = __seedPreviewForTest(
      {
        raw: bad,
        id: 'bl-raw',
        frozen_by: SESSION.actor,
        frontier: chainHead(db),
        preview: goodPreview as never,
      },
      AT.getTime(),
    );
    const result = await confirmFreeze(
      db,
      client,
      { preview_id: previewId, payload_hash: (goodPreview as { payload_hash: string }).payload_hash },
      SESSION,
      { now: AT },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'gate_empty');
    assert.ok((result.reason_codes ?? []).includes('core_not_effective'));
    assert.equal(rowCount(db, 'baseline'), 0);
    assert.equal(rows(db, "SELECT 1 AS n FROM event WHERE kind = 'baseline.rejected'").length, 1);
  });
});

test('P1-1: preview 过期 ⇒ preview_expired；用后重放 ⇒ preview_consumed', async () => {
  await withFreezeRig(async ({ db, client }) => {
    const preview = asPreview(previewFreeze(db, readBaselineFixture('waterfall.json'), SESSION, { now: AT }));
    const expired = await confirmFreeze(
      db,
      client,
      { preview_id: preview.preview_id, payload_hash: preview.payload_hash },
      SESSION,
      { now: new Date(AT.getTime() + 11 * 60 * 1000) },
    );
    assert.equal(expired.ok, false);
    assert.equal(expired.reason_code, 'preview_expired');
  });
});

test('P2-1: registry 里的 preview 被篡改 ⇒ preview_mismatch + 1 条 security.alert、0 行', async () => {
  await withFreezeRig(async ({ db, client }) => {
    const raw = readBaselineFixture('waterfall.json');
    const real = previewBaseline(raw, { current: null, id: 'bl-tamper', frozen_by: SESSION.actor, frontier: chainHead(db) });
    assert.equal(real.ok, true);
    const tampered = { ...(real as unknown as FreezePreviewView), hash: 'sha256:forged' };
    const previewId = __seedPreviewForTest(
      { raw, id: 'bl-tamper', frozen_by: SESSION.actor, frontier: chainHead(db), preview: tampered as never },
      AT.getTime(),
    );
    const result = await confirmFreeze(
      db,
      client,
      { preview_id: previewId, payload_hash: tampered.payload_hash },
      SESSION,
      { now: AT },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'preview_mismatch');
    assert.equal(rowCount(db, 'baseline'), 0);
    assert.equal(rows(db, "SELECT 1 AS n FROM event WHERE kind = 'security.alert'").length, 1);
  });
});

test('P2-1: 已消费的 preview 再次 confirm ⇒ preview_consumed + 1 条 security.alert（preview_replay）', async () => {
  await withFreezeRig(async ({ db, client }) => {
    const raw = readBaselineFixture('waterfall.json');
    const real = previewBaseline(raw, { current: null, id: 'bl-replay', frozen_by: SESSION.actor, frontier: chainHead(db) });
    assert.equal(real.ok, true);
    const tampered = { ...(real as unknown as FreezePreviewView), hash: 'sha256:forged' };
    const preview = {
      preview_id: __seedPreviewForTest(
        { raw, id: 'bl-replay', frozen_by: SESSION.actor, frontier: chainHead(db), preview: tampered as never },
        AT.getTime(),
      ),
      payload_hash: tampered.payload_hash,
    };
    const first = await confirmFreeze(
      db,
      client,
      { preview_id: preview.preview_id, payload_hash: preview.payload_hash },
      SESSION,
      { now: AT },
    );
    assert.equal(first.ok, false);
    assert.equal(first.reason_code, 'preview_mismatch');
    const rejected = rows(db, "SELECT 1 AS n FROM event WHERE kind = 'baseline.rejected'").length;
    const replay = await confirmFreeze(
      db,
      client,
      { preview_id: preview.preview_id, payload_hash: preview.payload_hash },
      SESSION,
      { now: AT },
    );
    assert.equal(replay.ok, false);
    assert.equal(replay.reason_code, 'preview_consumed');
    assert.equal(rows(db, "SELECT 1 AS n FROM event WHERE kind = 'security.alert'").length, 2);
    assert.equal(rows(db, "SELECT 1 AS n FROM event WHERE kind = 'baseline.rejected'").length, rejected);
  });
});

test('P2-1: preview 过期 ⇒ preview_expired 且不落 security.alert', async () => {
  await withFreezeRig(async ({ db, client }) => {
    const preview = asPreview(previewFreeze(db, readBaselineFixture('waterfall.json'), SESSION, { now: AT }));
    const expired = await confirmFreeze(
      db,
      client,
      { preview_id: preview.preview_id, payload_hash: preview.payload_hash },
      SESSION,
      { now: new Date(AT.getTime() + 11 * 60 * 1000) },
    );
    assert.equal(expired.reason_code, 'preview_expired');
    assert.equal(rows(db, "SELECT 1 AS n FROM event WHERE kind = 'security.alert'").length, 0);
  });
});
