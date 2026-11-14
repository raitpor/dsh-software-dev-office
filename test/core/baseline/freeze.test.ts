/**
 * M2-1 纯逻辑：preview 的方向/哈希/will_change、confirm 的绑定与拒绝码。
 * 不碰 DB/时钟（`docs/09` §16.2）；DB 事务在 `test/db/baseline-freeze.test.ts`。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  baselineHash,
  confirmBaseline,
  previewBaseline,
  type BaselinePreview,
  type BaselineRowLike,
} from '../../../src/core/baseline/index.js';

const ROOT = process.cwd();
const waterfall = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(ROOT, 'test/fixtures/baseline/waterfall.json'), 'utf8')) as Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const FRONTIER = 'f-test';

function preview(input: Record<string, unknown>, current: BaselineRowLike | null = null): BaselinePreview {
  const result = previewBaseline(input, { current, id: String(input['id']), frozen_by: 'alice', frontier: FRONTIER });
  assert.equal(result.ok, true);
  return result as BaselinePreview;
}

function rowFrom(previewValue: BaselinePreview, input: Record<string, unknown>): BaselineRowLike {
  const policy = input['policy'] as Record<string, unknown>;
  return {
    id: previewValue.id,
    frozen_by: 'alice',
    engine_version: String((input['engine'] as Record<string, unknown>)['version']),
    criteria_manifest_hash: String((input['engine'] as Record<string, unknown>)['criteria_manifest_hash']),
    policy: input['policy'],
    criteria: input['criteria'],
    gates: input['gates'],
    thresholds: input['thresholds'],
    assurance: input['assurance'],
    prev: previewValue.prev,
    direction: previewValue.row_direction,
    hash: previewValue.hash,
    at: '2026-11-14T00:00:00.000Z',
    artifact_kinds: policy['artifact_kinds'],
  } as BaselineRowLike;
}

test('C4/C9: 首版 direction=initial、行方向 NULL、prev NULL', () => {
  const input = waterfall();
  const p = preview(input);
  assert.equal(p.direction, 'initial');
  assert.equal(p.row_direction, null);
  assert.equal(p.prev, null);
  assert.ok(p.hash.startsWith('sha256:'));
});

test('C6: hash 覆盖 prev/direction/engine/artifact_kinds（任一项变则 hash 变）', () => {
  const base = waterfall();
  const h0 = preview(base).hash;
  const engineChanged = clone(base);
  engineChanged['id'] = 'bl-engine';
  (engineChanged['engine'] as Record<string, unknown>)['version'] = '9.9.9';
  assert.notEqual(preview(engineChanged).hash, h0);
  const artifacts = clone(base);
  artifacts['id'] = 'bl-artifacts';
  const kinds = (artifacts['policy'] as Record<string, unknown>)['artifact_kinds'] as Record<string, unknown>;
  kinds['extra'] = 'ok';
  assert.notEqual(preview(artifacts).hash, h0);
  const withPrev = baselineHash({ prev: 'B-1', rowDirection: null, input: base });
  const withoutPrev = baselineHash({ prev: null, rowDirection: null, input: base });
  assert.notEqual(withPrev, withoutPrev);
});

test('C4: 收紧判 tighten、放宽判 loosen；不可判定按放宽', () => {
  const v1 = waterfall();
  const p1 = preview(v1);
  const current = rowFrom(p1, v1);
  const tightened = clone(v1);
  tightened['id'] = 'bl-waterfall-2';
  (tightened['criteria'] as Array<Record<string, unknown>>).push({ id: 'task.complete', version: '1', params: {}, guarantee: '3' });
  const t = preview(tightened, current);
  assert.equal(t.direction, 'tighten');
  assert.equal(t.row_direction, 'tighten');
  const withCriterion = clone(tightened);
  withCriterion['id'] = 'bl-waterfall-3';
  const currentWithCriterion = rowFrom(preview(withCriterion, current), withCriterion);
  const loosened = clone(withCriterion);
  loosened['id'] = 'bl-waterfall-4';
  loosened['criteria'] = clone(v1['criteria']);
  const l = preview(loosened, currentWithCriterion);
  assert.equal(l.direction, 'loosen');
  const undetermined = clone(v1);
  undetermined['id'] = 'bl-waterfall-5';
  (undetermined['engine'] as Record<string, unknown>)['version'] = '1.0.0';
  assert.equal(preview(undetermined, current).direction, 'loosen');
});

test('C2: confirm 的 payload_hash 不符 ⇒ payload_changed；声明方向不符 ⇒ direction_mismatch', () => {
  const input = waterfall();
  const p = preview(input);
  const wrongHash = confirmBaseline(p, 'sha256:deadbeef');
  assert.equal(wrongHash.ok, false);
  if (!wrongHash.ok) assert.equal(wrongHash.reason_code, 'payload_changed');
  const p2 = preview(input);
  const wrongDirection = confirmBaseline(p2, p2.payload_hash, 'loosen');
  assert.equal(wrongDirection.ok, false);
  if (!wrongDirection.ok) assert.equal(wrongDirection.reason_code, 'direction_mismatch');
  const ok = confirmBaseline(preview(input), p.payload_hash);
  assert.equal(ok.ok, true);
});

test('C3: 签名载荷缺 will_change_hash/guarantee_delta ⇒ no_blind_sign', () => {
  const input = waterfall();
  const p = preview(input);
  const stripped = { ...p, decision_baseline: { id: p.id, hash: p.hash } } as unknown as BaselinePreview;
  const result = confirmBaseline(stripped, stripped.payload_hash);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason_code, 'no_blind_sign');
});

test('C9: 与当前版本完全相同 ⇒ baseline_unchanged', () => {
  const input = waterfall();
  const p = preview(input);
  const result = previewBaseline(input, { current: rowFrom(p, input), id: p.id, frozen_by: 'alice', frontier: FRONTIER });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason_code, 'baseline_unchanged');
});

test('C4: baselineHash 能从行内字段复算（旧行永久可复算）', () => {
  const input = waterfall();
  const p = preview(input);
  const row = rowFrom(p, input);
  const recomputed = baselineHash({
    prev: row.prev,
    rowDirection: row.direction,
    input: {
      engine: { version: row.engine_version, criteria_manifest_hash: row.criteria_manifest_hash },
      policy: row.policy,
      criteria: row.criteria,
      gates: row.gates,
      thresholds: row.thresholds,
      assurance: row.assurance,
    },
  });
  assert.equal(recomputed, row.hash);
});
