import { appendAs as append } from './append-auth.js';
/**
 * M2-1 C1/C2/C3/C9/C10：preview→confirm→人签→新行；不过则落 rejected。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, sha256Hex } from '../../src/core/fold/canonical.js';
import { chainHead } from '../../src/db/write.js';
import {
  confirmFreeze,
  previewFreeze,
  type FreezeDbResult,
} from '../../src/db/freeze.js';
import type { FreezePreviewView } from '../../src/db/freeze-preview.js';
import {
  AT,
  SESSION,
  readBaselineFixture,
  rowCount,
  rows,
  withFreezeRig,
} from './baseline-freeze-helpers.js';

function asPreview(result: FreezePreviewView | FreezeDbResult): FreezePreviewView {
  assert.equal(result.ok, true);
  return result as FreezePreviewView;
}

function asFailure(result: FreezePreviewView | FreezeDbResult): FreezeDbResult {
  assert.equal(result.ok, false);
  return result as FreezeDbResult;
}

function asDone(result: FreezeDbResult): FreezeDbResult {
  assert.equal(result.ok, true);
  return result;
}

function decisionPayload(
  db: Parameters<typeof rows>[0],
  id: string,
): { payload: Record<string, unknown>; payload_hash: string } {
  const row = rows(db, 'SELECT payload, payload_hash FROM decision WHERE id = ?', id)[0];
  assert.ok(row !== undefined);
  return {
    payload: JSON.parse(String(row['payload'])) as Record<string, unknown>,
    payload_hash: String(row['payload_hash']),
  };
}

test('C1: P15 不过 ⇒ 落 baseline.rejected、baseline 0 行', async () => {
  await withFreezeRig(async ({ db }) => {
    const bad = asFailure(previewFreeze(db, readBaselineFixture('criteria-empty.json'), SESSION, { now: AT }));
    assert.equal(bad.ok, false);
    assert.ok((bad.reason_codes ?? []).length > 0);
    const rejected = rows(db, "SELECT payload FROM event WHERE kind = 'baseline.rejected'");
    assert.equal(rejected.length, 1);
    const payload = JSON.parse(String(rejected[0]!['payload'])) as Record<string, unknown>;
    assert.equal(payload['baseline_id'], 'bl-waterfall');
    assert.equal(rowCount(db, 'baseline'), 0);
  });
});

test('C1: 绕过 preview/confirm 直接 append 未签 baseline.frozen ⇒ 拒', async () => {
  await withFreezeRig(async ({ db }) => {
    const input = readBaselineFixture('waterfall.json');
    const preview = asPreview(previewFreeze(db, input, SESSION, { now: AT }));
    const event = {
      id: 'ev-unsigned',
      at: AT.toISOString(),
      actor: SESSION.actor,
      kind: 'baseline.frozen',
      subject: preview.id,
      payload: {
        frozen_by: SESSION.actor,
        engine: input['engine'],
        policy: input['policy'],
        criteria: input['criteria'],
        gates: input['gates'],
        thresholds: input['thresholds'],
        assurance: input['assurance'],
        hash: preview.hash,
      },
      caused_by: [] as string[],
      request_id: 'unsigned',
      prev: chainHead(db),
      hash: '',
    };
    const { computeEventHash } = await import('../../src/core/verify-events.js');
    const built = { ...event, hash: computeEventHash(event as never) };
    const result = append(db, [built]);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'invalid_field');
    assert.match(String(result.message), /decision_id/);
    assert.equal(rowCount(db, 'baseline'), 0);
  });
});

test('C2/C9: 两段式绑 hash；错误 payload_hash/payload 改动 ⇒ payload_changed；重放幂等', async () => {
  await withFreezeRig(async ({ db, client }) => {
    const input = readBaselineFixture('waterfall.json');
    const preview = asPreview(previewFreeze(db, input, SESSION, { now: AT }));
    const wrong = await confirmFreeze(
      db,
      client,
      { preview_id: preview.preview_id, payload_hash: 'sha256:deadbeef' },
      SESSION,
      { now: AT },
    );
    assert.equal(wrong.ok, false);
    assert.equal(wrong.reason_code, 'payload_changed');
    assert.equal(rowCount(db, 'baseline'), 0);

    const forged = await confirmFreeze(
      db,
      client,
      { preview_id: 'pv-forged', payload_hash: preview.payload_hash },
      SESSION,
      { now: AT },
    );
    assert.equal(forged.ok, false);
    assert.equal(forged.reason_code, 'preview_expired');

    const ok = asDone(
      await confirmFreeze(
        db,
        client,
        { preview_id: preview.preview_id, payload_hash: preview.payload_hash },
        SESSION,
        { now: AT },
      ),
    );
    assert.equal(ok.ok, true);
    const first = rows(db, 'SELECT * FROM baseline')[0]!;
    assert.equal(first['id'], preview.id);
    assert.equal(first['direction'], null);
    assert.equal(first['prev'], null);

    const again = await confirmFreeze(
      db,
      client,
      { preview_id: preview.preview_id, payload_hash: preview.payload_hash },
      SESSION,
      { now: AT },
    );
    assert.equal(again.ok, true);
    assert.equal(rowCount(db, 'baseline'), 1);
    assert.equal(rows(db, "SELECT 1 AS n FROM event WHERE kind = 'baseline.frozen'").length, 1);

    const rejectedBefore = rows(db, "SELECT 1 AS n FROM event WHERE kind = 'baseline.rejected'").length;
    const repeated = asFailure(previewFreeze(db, input, SESSION, { now: AT }));
    assert.equal(repeated.reason_code, 'baseline_unchanged');
    assert.equal(
      rows(db, "SELECT 1 AS n FROM event WHERE kind = 'baseline.rejected'").length,
      rejectedBefore,
      'baseline_unchanged must not append baseline.rejected (P2-1)',
    );
  });
});

test('C3: decision 顶层 baseline 对象、payload_hash 与签名载荷一致、delta/will_change_hash 来自工具', async () => {
  await withFreezeRig(async ({ db, client }) => {
    const preview = asPreview(previewFreeze(db, readBaselineFixture('waterfall.json'), SESSION, { now: AT }));
    const done = asDone(
      await confirmFreeze(
        db,
        client,
        { preview_id: preview.preview_id, payload_hash: preview.payload_hash },
        SESSION,
        { now: AT },
      ),
    );
    const decisionId = done.decision_id!;
    const stored = decisionPayload(db, decisionId);
    const payload = stored.payload;
    const baseline = payload['baseline'] as Record<string, unknown> | undefined;
    assert.ok(baseline !== undefined, 'signed decision payload must carry top-level baseline (docs/06 §5)');
    assert.equal(baseline['id'], preview.id);
    assert.equal(baseline['hash'], preview.hash);
    assert.equal(baseline['will_change_hash'], preview.will_change_hash);
    assert.deepEqual(baseline['guarantee_delta'], preview.guarantee_delta);
    assert.equal(stored.payload_hash, `sha256:${sha256Hex(canonicalJson(payload))}`);
  });
});

test('C4: 产品代码没有原地 UPDATE baseline 的路径', () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(join(process.cwd(), 'src'));
  const hits = files.filter((file) => /UPDATE\s+(?:main\.|"|')?baseline/i.test(readFileSync(file, 'utf8')));
  assert.deepEqual(hits, [], `unexpected UPDATE baseline in: ${hits.join(', ')}`);
});

test('C10: 拒绝码稳定且落 rejected 事件 payload', async () => {
  await withFreezeRig(async ({ db }) => {
    const bad = asFailure(previewFreeze(db, readBaselineFixture('core-any-of.json'), SESSION, { now: AT }));
    assert.equal(bad.reason_code, 'core_not_effective');
    const rejected = rows(db, "SELECT payload FROM event WHERE kind = 'baseline.rejected'")[0]!;
    const payload = JSON.parse(String(rejected['payload'])) as { reason_codes: string[] };
    assert.ok(payload.reason_codes.includes('core_not_effective'));
  });
});
