/**
 * M2-2 C1/C2/C9/C10：判定只经门禁流程写 stage_run；裸 append 拒；baseline 必须已冻结；
 * 判定引用 release 必须同版。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { append, chainHead } from '../../src/db/write.js';
import { buildEvent } from '../../src/db/freeze-store.js';
import { previewFreeze, confirmFreeze, type FreezeDbResult } from '../../src/db/freeze.js';
import type { FreezePreviewView } from '../../src/db/freeze-preview.js';
import { judgeStage } from '../../src/db/gate.js';
import { verify } from '../../src/core/verify.js';
import { fold } from '../../src/core/fold/index.js';
import { readEvents } from '../../src/core/verify-events.js';
import type { Event } from '../../src/core/fold/types.js';
import { AT, SESSION, readBaselineFixture, rows, unlock, withFreezeRig } from './baseline-freeze-helpers.js';
import { chain, seed } from './append-helpers.js';

function asPreview(result: FreezePreviewView | FreezeDbResult): FreezePreviewView {
  assert.equal(result.ok, true);
  return result as FreezePreviewView;
}

async function freezeWaterfall(rig: Parameters<Parameters<typeof withFreezeRig>[0]>[0]): Promise<FreezePreviewView> {
  const preview = asPreview(previewFreeze(rig.db, readBaselineFixture('waterfall.json'), SESSION, { now: AT }));
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

function enterStage(db: Parameters<typeof rows>[0], id: string, stage: string, at: Date, baselineHash?: string): Event {
  const event = buildEvent(
    {
      id: `ev-entered-${id}`,
      at: at.toISOString(),
      actor: 'alice',
      kind: 'stage.entered',
      subject: id,
      payload: { stage, ...(baselineHash === undefined ? {} : { baseline_hash: baselineHash }) },
      caused_by: [],
      request_id: `stage:${id}`,
    },
    chainHead(db),
  );
  const result = append(db, [event]);
  assert.equal(result.ok, true, result.message ?? result.reason_code ?? "");
  return event;
}

function gateEvent(db: Parameters<typeof rows>[0], id: string, at: Date): Event {
  return buildEvent(
    {
      id,
      at: at.toISOString(),
      actor: 'alice',
      kind: 'gate.judged',
      subject: 'SR-1',
      payload: {
        stage_run_id: 'SR-1',
        gate_id: 'G_req_exit',
        baseline_hash: 'sha256:deadbeef',
        verdict: 'pass',
        criteria: [
          {
            criterion_id: 'provenance.present',
            verdict: 'pass',
            reason_code: 'checked',
            effective: true,
            binding_reasons: [],
            reasons: ['checked'],
          },
        ],
        reasons: ['forged'],
      },
      caused_by: [],
      request_id: `gate:${id}`,
    },
    chainHead(db),
  );
}

test('C1: 门禁流程写 stage_run 判定字段，verify 绿', async () => {
  await withFreezeRig(async (rig) => {
    const preview = await freezeWaterfall(rig);
    enterStage(rig.db, 'SR-1', 'req', AT, preview.hash);
    const result = judgeStage(rig.db, {
      stage_run_id: 'SR-1',
      actor: 'alice',
      at: new Date(AT.getTime() + 1000).toISOString(),
    });
    assert.equal(result.ok, true, result.message ?? result.reason_code ?? "");
    assert.equal(result.evaluation?.stage, 'req');
    assert.equal(result.evaluation?.verdict, 'changes_requested');
    const row = rows(rig.db, "SELECT * FROM stage_run WHERE id = 'SR-1'")[0]!;
    assert.equal(row['gate_id'], 'G_req_exit');
    assert.equal(row['baseline_hash'], preview.hash);
    assert.equal(row['verdict'], 'changes_requested');
    // judged_at 是 fold-only 列（DDL 无此列），值只能从 fold 投影断言，不在 DB 行上。
    const state = fold(undefined, readEvents(rig.db, []));
    assert.equal(
      state.tables.stage_run['SR-1']?.['judged_at'],
      new Date(AT.getTime() + 1000).toISOString(),
      'judged_at 必须等于判定事件的 at',
    );
    const criteria = JSON.parse(String(row['criteria'])) as unknown[];
    assert.ok(criteria.length > 0);
    const judged = rows(rig.db, "SELECT id FROM event WHERE kind = 'gate.judged'");
    assert.equal(judged.length, 1);
    const report = verify(rig.db);
    assert.equal(report.ok, true, JSON.stringify(report.problems));
  });
});

test('C2/C10: 裸 append gate.judged ⇒ unauthorized_gate_judgement，不落行', async () => {
  await withFreezeRig(async (rig) => {
    const preview = await freezeWaterfall(rig);
    enterStage(rig.db, 'SR-1', 'req', AT, preview.hash);
    const before = rows(rig.db, "SELECT count(*) AS n FROM event")[0]!['n'];
    const result = append(rig.db, [gateEvent(rig.db, 'ev-naked-gate', AT)]);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'unauthorized_gate_judgement');
    assert.equal(rows(rig.db, "SELECT count(*) AS n FROM event")[0]!['n'], before);
    assert.equal(rows(rig.db, "SELECT count(*) AS n FROM event WHERE kind = 'gate.judged'")[0]!['n'], 0);
  });
});

test('C2: 未冻结 baseline ⇒ baseline_not_frozen，不落行', async () => {
  await withFreezeRig(async (rig) => {
    enterStage(rig.db, 'SR-1', 'req', AT);
    const result = judgeStage(rig.db, { stage_run_id: 'SR-1', actor: 'alice', at: AT.toISOString() });
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'baseline_not_frozen');
    assert.equal(rows(rig.db, "SELECT count(*) AS n FROM event WHERE kind = 'gate.judged'")[0]!['n'], 0);
  });
});

test('C2: stage_run 不存在 ⇒ stage_run_missing', async () => {
  await withFreezeRig(async (rig) => {
    await freezeWaterfall(rig);
    const result = judgeStage(rig.db, { stage_run_id: 'SR-nope', actor: 'alice', at: AT.toISOString() });
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'stage_run_missing');
  });
});

test('C9: 判定引用的 release 绑了另一版 baseline ⇒ baseline_mismatch', async () => {
  await withFreezeRig(async (rig) => {
    const preview = await freezeWaterfall(rig);
    enterStage(rig.db, 'SR-1', 'req', AT, preview.hash);
    const releaseEvent = buildEvent(
      {
        id: 'ev-release-mismatch',
        at: AT.toISOString(),
        actor: 'alice',
        kind: 'release.frozen',
        subject: 'REL-1',
        payload: {
          frozen_by: ['alice', 'bob'],
          frontier: 'f-1',
          baseline_hash: 'sha256:deadbeef',
          scope_spec_set: 'spec-set-1',
          items: [],
        },
        caused_by: [],
        request_id: 'release:REL-1',
      },
      chainHead(rig.db),
    );
    assert.equal(append(rig.db, [releaseEvent]).ok, true);
    const result = judgeStage(rig.db, { stage_run_id: 'SR-1', release_id: 'REL-1', actor: 'alice', at: AT.toISOString() });
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'baseline_mismatch');
  });
});

test('C5: 重判写新事件、不覆盖旧事件；行更新且 verify 绿', async () => {
  await withFreezeRig(async (rig) => {
    const preview = await freezeWaterfall(rig);
    enterStage(rig.db, 'SR-1', 'req', AT, preview.hash);
    const first = judgeStage(rig.db, { stage_run_id: 'SR-1', actor: 'alice', at: new Date(AT.getTime() + 1000).toISOString() });
    assert.equal(first.ok, true);
    const second = judgeStage(rig.db, { stage_run_id: 'SR-1', actor: 'alice', at: new Date(AT.getTime() + 2000).toISOString() });
    assert.equal(second.ok, true);
    assert.notEqual(first.event_id, second.event_id);
    assert.equal(rows(rig.db, "SELECT count(*) AS n FROM event WHERE kind = 'gate.judged'")[0]!['n'], 2);
    const report = verify(rig.db);
    assert.equal(report.ok, true, JSON.stringify(report.problems));
  });
});

test('C5: 同一判定 id 改字段再 append ⇒ 结构化拒，stage_run 行不变', async () => {
  await withFreezeRig(async (rig) => {
    const preview = await freezeWaterfall(rig);
    enterStage(rig.db, 'SR-1', 'req', AT, preview.hash);
    const judged = judgeStage(rig.db, {
      stage_run_id: 'SR-1',
      actor: 'alice',
      at: new Date(AT.getTime() + 1000).toISOString(),
    });
    assert.equal(judged.ok, true);
    const rowBefore = JSON.stringify(rows(rig.db, "SELECT * FROM stage_run WHERE id = 'SR-1'")[0]);
    const eventRow = rows(rig.db, 'SELECT * FROM event WHERE id = ?', judged.event_id!)[0]!;
    const tampered = buildEvent(
      {
        id: String(eventRow['id']),
        at: String(eventRow['at']),
        actor: String(eventRow['actor']),
        kind: 'gate.judged',
        subject: String(eventRow['subject']),
        payload: {
        stage_run_id: 'SR-1',
        gate_id: 'G_req_exit',
        baseline_hash: 'sha256:deadbeef',
        verdict: 'pass',
        criteria: [
          {
            criterion_id: 'provenance.present',
            verdict: 'pass',
            reason_code: 'checked',
            effective: true,
            binding_reasons: [],
            reasons: ['checked'],
          },
        ],
        reasons: ['forged'],
      },
        caused_by: [],
        request_id: `gate:${String(eventRow['subject'])}`,
      },
      chainHead(rig.db),
    );
    const result = append(rig.db, [tampered]);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'event_hash_mismatch');
    const rowAfter = JSON.stringify(rows(rig.db, "SELECT * FROM stage_run WHERE id = 'SR-1'")[0]);
    assert.equal(rowAfter, rowBefore);
  });
});

function tightenInput(): Record<string, unknown> {
  // M2 只支持每 stage 单 gate；收紧用“给既有 gate 增判据”（不是加新 gate），
  // 这样同一 stage 在新版本下的 readings 会多出 task.complete、verdict 按新基线算。
  const input = JSON.parse(JSON.stringify(readBaselineFixture('waterfall.json'))) as Record<string, unknown>;
  input['id'] = 'BL-amended';
  const gates = input['gates'] as Array<Record<string, unknown>>;
  for (const gate of gates) {
    if (gate['id'] !== 'G_req_exit') continue;
    const criteria = gate['criteria'] as string[];
    if (!criteria.includes('task.complete')) criteria.push('task.complete');
  }
  return input;
}

async function amendTighten(rig: Parameters<Parameters<typeof withFreezeRig>[0]>[0]): Promise<FreezePreviewView> {
  const preview = asPreview(previewFreeze(rig.db, tightenInput(), SESSION, { now: new Date(AT.getTime() + 30_000) }));
  await unlock(rig);
  const done = await confirmFreeze(
    rig.db,
    rig.client,
    { preview_id: preview.preview_id, payload_hash: preview.payload_hash, declared_direction: 'tighten' },
    SESSION,
    { now: new Date(AT.getTime() + 30_000) },
  );
  assert.equal(done.ok, true, done.message ?? done.reason_code ?? '');
  assert.equal(done.baseline?.direction, 'tighten');
  return preview;
}

test('P2-1: 缺省用 stage.entered 记下的版本，不取链头；显式传入版本不同 ⇒ baseline_mismatch', async () => {
  await withFreezeRig(async (rig) => {
    const first = await freezeWaterfall(rig);
    enterStage(rig.db, 'SR-1', 'req', AT, first.hash);
    const amended = await amendTighten(rig);
    const judged = judgeStage(rig.db, {
      stage_run_id: 'SR-1',
      actor: 'alice',
      at: new Date(AT.getTime() + 60_000).toISOString(),
    });
    assert.equal(judged.ok, true, judged.message ?? judged.reason_code ?? '');
    const row = rows(rig.db, "SELECT * FROM stage_run WHERE id = 'SR-1'")[0]!;
    assert.equal(row['baseline_hash'], first.hash);
    const event = rows(rig.db, "SELECT payload FROM event WHERE id = ?", judged.event_id!)[0]!;
    assert.equal((JSON.parse(String(event['payload'])) as Record<string, unknown>)['baseline_hash'], first.hash);
    const mismatch = judgeStage(rig.db, {
      stage_run_id: 'SR-1',
      baseline_hash: amended.hash,
      actor: 'alice',
      at: new Date(AT.getTime() + 61_000).toISOString(),
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason_code, 'baseline_mismatch');
  });
});

test('P2-3: 基线收紧后新 stage 用新版本判定，旧 stage 拒；verify 可发现手改 stage_run', async () => {
  await withFreezeRig(async (rig) => {
    const first = await freezeWaterfall(rig);
    enterStage(rig.db, 'SR-1', 'req', AT, first.hash);
    const amended = await amendTighten(rig);
    enterStage(rig.db, 'SR-2', 'req', new Date(AT.getTime() + 40_000), amended.hash);
    const judged = judgeStage(rig.db, {
      stage_run_id: 'SR-2',
      actor: 'alice',
      at: new Date(AT.getTime() + 60_000).toISOString(),
    });
    assert.equal(judged.ok, true, judged.message ?? judged.reason_code ?? '');
    assert.equal(judged.evaluation?.baseline_hash, amended.hash);
    const row = rows(rig.db, "SELECT * FROM stage_run WHERE id = 'SR-2'")[0]!;
    assert.equal(row['baseline_hash'], amended.hash);
    const oldStage = judgeStage(rig.db, {
      stage_run_id: 'SR-1',
      baseline_hash: amended.hash,
      actor: 'alice',
      at: new Date(AT.getTime() + 62_000).toISOString(),
    });
    assert.equal(oldStage.ok, false);
    assert.equal(oldStage.reason_code, 'baseline_mismatch');
    rig.db.exec("UPDATE stage_run SET baseline_hash = 'sha256:deadbeef' WHERE id = 'SR-2'");
    const report = verify(rig.db);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((p) => p.code === 'runtime_inconsistent' && p.table === 'stage_run'));
  });
});

test('P1/P2-2: 伪造 payload（缺字段/坏 na/多余字段）被写路径拒；合法伪造无能力 ⇒ unauthorized', async () => {
  await withFreezeRig(async (rig) => {
    const preview = await freezeWaterfall(rig);
    enterStage(rig.db, 'SR-1', 'req', AT, preview.hash);
    const badPayloads: Array<Record<string, unknown>> = [
      { stage_run_id: 'SR-1', gate_id: 'G', baseline_hash: preview.hash, verdict: 'pass', criteria: [], reasons: [] },
      {
        stage_run_id: 'SR-1',
        gate_id: 'G',
        baseline_hash: preview.hash,
        verdict: 'pass',
        criteria: [{ criterion_id: 'x', verdict: 'na', effective: true, binding_reasons: [], reasons: [] }],
        reasons: [],
      },
      {
        stage_run_id: 'SR-1',
        gate_id: 'G',
        baseline_hash: preview.hash,
        verdict: 'pass',
        criteria: [],
        reasons: [],
        extra: true,
      },
    ];
    for (const [index, payload] of badPayloads.entries()) {
      const event = buildEvent(
        {
          id: `ev-forged-${index}`,
          at: new Date(AT.getTime() + 70_000 + index).toISOString(),
          actor: 'alice',
          kind: 'gate.judged',
          subject: 'SR-1',
          payload,
          caused_by: [],
          request_id: `forged:${index}`,
        },
        chainHead(rig.db),
      );
      const result = append(rig.db, [event]);
      assert.equal(result.ok, false);
      assert.equal(result.reason_code, 'invalid_field', result.message ?? '');
    }
    const validForged = buildEvent(
      {
        id: 'ev-forged-valid',
        at: new Date(AT.getTime() + 80_000).toISOString(),
        actor: 'alice',
        kind: 'gate.judged',
        subject: 'SR-1',
        payload: {
          stage_run_id: 'SR-1',
          gate_id: 'G_forged',
          baseline_hash: preview.hash,
          verdict: 'pass',
          criteria: [
            {
              criterion_id: 'provenance.present',
              verdict: 'pass',
              reason_code: 'checked',
              effective: true,
              binding_reasons: [],
              reasons: ['checked'],
            },
          ],
          reasons: [],
        },
        caused_by: [],
        request_id: 'forged:valid',
      },
      chainHead(rig.db),
    );
    const forged = append(rig.db, [validForged]);
    assert.equal(forged.ok, false);
    assert.equal(forged.reason_code, 'unauthorized_gate_judgement');
    assert.equal(rows(rig.db, "SELECT count(*) AS n FROM event WHERE kind = 'gate.judged'")[0]!['n'], 0);
  });
});

test('P3: 判定 at 早于 stage_run.entered_at ⇒ invalid_field', async () => {
  await withFreezeRig(async (rig) => {
    const preview = await freezeWaterfall(rig);
    enterStage(rig.db, 'SR-1', 'req', new Date(AT.getTime() + 60_000), preview.hash);
    const result = judgeStage(rig.db, {
      stage_run_id: 'SR-1',
      actor: 'alice',
      at: AT.toISOString(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'invalid_field');
  });
});

test('P2: fold rejects gate.judged whose baseline_hash differs from stage_run entry version', () => {
  const events = chain([
    seed(900, 'stage.entered', 'SR-X', { stage: 'req', baseline_hash: 'sha256:entry-d1' }),
    seed(901, 'gate.judged', 'SR-X', {
      stage_run_id: 'SR-X',
      gate_id: 'G',
      baseline_hash: 'sha256:other-d2',
      verdict: 'pass',
      criteria: [
        {
          criterion_id: 'provenance.present',
          verdict: 'pass',
          reason_code: 'checked',
          effective: true,
          binding_reasons: [],
          reasons: ['checked'],
        },
      ],
      reasons: [],
    }),
  ]);
  const before = fold(undefined, events.slice(0, 1));
  assert.throws(
    () => fold(before, [events[1]!]),
    /gate\.judged baseline_hash sha256:other-d2 does not match stage_run SR-X entry version sha256:entry-d1/u,
  );
});

test('P3: judgement at later than the injected clock is rejected (upper bound)', async () => {
  await withFreezeRig(async (rig) => {
    const preview = await freezeWaterfall(rig);
    enterStage(rig.db, 'SR-1', 'req', new Date(AT.getTime() + 60_000), preview.hash);
    const now = new Date(AT.getTime() + 120_000).toISOString();
    const at = new Date(AT.getTime() + 180_000).toISOString();
    const result = judgeStage(rig.db, { stage_run_id: 'SR-1', actor: 'alice', at, now });
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'invalid_field');
    assert.match(result.message ?? '', /in the future/u);
  });
});


test('P3: 每 stage 多 gate ⇒ judgeStage 返回 multiple_gates_unsupported，不写事件', async () => {
  await withFreezeRig(async (rig) => {
    const input = JSON.parse(JSON.stringify(readBaselineFixture('waterfall.json'))) as Record<string, unknown>;
    input['id'] = 'BL-multi-gate';
    const gates = input['gates'] as Array<Record<string, unknown>>;
    gates.push({
      id: 'G_extra',
      stage: 'req',
      criteria: ['spec_set.signed', 'assumption_set.signed', 'provenance.present', 'task.complete'],
      policy_mode: 'all_of',
      waivable: false,
    });
    const policy = input['policy'] as Record<string, unknown>;
    const byStage = policy['gates'] as Record<string, string[]>;
    byStage['req'] = [...(byStage['req'] ?? []), 'G_extra'];
    const preview = asPreview(previewFreeze(rig.db, input, SESSION, { now: AT }));
    await unlock(rig);
    const done = await confirmFreeze(
      rig.db,
      rig.client,
      { preview_id: preview.preview_id, payload_hash: preview.payload_hash },
      SESSION,
      { now: AT },
    );
    assert.equal(done.ok, true, done.message ?? done.reason_code ?? '');
    enterStage(rig.db, 'SR-1', 'req', new Date(AT.getTime() + 60_000), preview.hash);
    const result = judgeStage(rig.db, {
      stage_run_id: 'SR-1',
      actor: 'alice',
      at: new Date(AT.getTime() + 120_000).toISOString(),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'multiple_gates_unsupported');
    assert.equal(rows(rig.db, "SELECT count(*) AS n FROM event WHERE kind = 'gate.judged'")[0]!['n'], 0);
  });
});
