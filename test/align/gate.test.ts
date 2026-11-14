import assert from 'node:assert/strict';
import { test } from 'node:test';

import { disposeDiff } from '../../src/align/diff.js';
import { alignmentGate, listRestatements, readAlignmentState } from '../../src/align/gate.js';
import type { DiffDisposition } from '../../src/align/gate.js';
import { invalidateRestatement, proposeRestatement } from '../../src/align/restatement.js';
import { verify } from '../../src/core/verify.js';
import {
  ALIGN_AT,
  SPEC_AT,
  appendCriterion,
  appendIntent,
  appendRequirement,
  appendSeeds,
  draft,
  ev,
  intentEdge,
  withAlignDb,
} from './helpers.js';
import type { FixtureSeed } from './helpers.js';
import type { SdoDatabase } from '../../src/db/driver.js';

interface AlignedOptions {
  readonly dispositions?: Record<string, DiffDisposition>;
  readonly positive?: number;
  readonly negative?: number;
  readonly withCriterion?: boolean;
}

/** 阳性夹具：复述 + 3 条差异处置 + 条款/判据 + 2 正 1 反，时间顺序满足“先复述后条款”。 */
function buildAligned(db: SdoDatabase, options: AlignedOptions = {}): string {
  appendIntent(db);
  const proposed = proposeRestatement(db, {
    intentId: 'INT-1',
    draftSpecs: [draft('d1'), draft('d2'), draft('d3')],
    inputs: [intentEdge('INT-1', 'ch:intent-1')],
    actor: 'agent-alpha',
    at: ALIGN_AT,
  });
  assert.equal(proposed.ok, true);
  const restatement = listRestatements(readAlignmentState(db))[0];
  assert.ok(restatement !== undefined);

  const dispositions = options.dispositions ?? { d1: 'accept', d2: 'reject', d3: 'accept' };
  for (const [targetRef, disposition] of Object.entries(dispositions)) {
    const result = disposeDiff(db, {
      restatementId: restatement.id,
      targetRef,
      kind: 'agree',
      disposition,
      actor: 'alice',
      actorKind: 'human',
      at: ALIGN_AT,
    });
    assert.equal(result.ok, true);
  }

  appendRequirement(db);
  if (options.withCriterion !== false) {
    appendCriterion(
      db,
      'CRIT-1',
      'SPEC-1',
      SPEC_AT,
      fixturesFor(options.positive ?? 2, options.negative ?? 1),
    );
  }
  return restatement.id;
}

/** 按数量造 `fixtures[]`：经 `criterion.registered` 事件写入，测试不直插夹具表。 */
function fixturesFor(positive: number, negative: number): FixtureSeed[] {
  const fixtures: FixtureSeed[] = [];
  for (let index = 1; index <= positive; index += 1) {
    fixtures.push({ polarity: 'positive', input: `positive-${index}` });
  }
  for (let index = 1; index <= negative; index += 1) {
    fixtures.push({ polarity: 'negative', input: `negative-${index}` });
  }
  return fixtures;
}

test('C5：差异全部处置 + 每条 requirement 2 正 1 反 ⇒ 门 ok，且 verify() 绿', () => {
  withAlignDb((db) => {
    buildAligned(db);
    const gate = alignmentGate(db);
    assert.deepEqual(gate, { ok: true, pending: [], specIds: [] });
    assert.equal(verify(db).ok, true);

    const again = alignmentGate(db);
    assert.deepEqual(again, gate);
  });
});

test('C3 反例：第 3 条差异没处置 ⇒ diff_unprocessed，pending 只含 d3', () => {
  withAlignDb((db) => {
    buildAligned(db, { dispositions: { d1: 'accept', d2: 'reject' } });
    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'diff_unprocessed');
    assert.deepEqual(gate.pending, ['d3']);
  });
});

test('C3：defer 视为未处置 ⇒ diff_deferred 挡住门（不是 ok）', () => {
  withAlignDb((db) => {
    buildAligned(db, { dispositions: { d1: 'accept', d2: 'reject', d3: 'defer' } });
    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'diff_deferred');
    assert.deepEqual(gate.pending, ['d3']);
  });
});

test('C5：例子不足 ⇒ examples_missing（specIds 指向缺例子的 requirement）', () => {
  withAlignDb((db) => {
    buildAligned(db, { positive: 1 });
    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'examples_missing');
    assert.deepEqual(gate.specIds, ['SPEC-1']);

    // 注册事件带 1 正 1 反（M1-1 硬门允许），但门要 2 正 ⇒ 仍红。
    assert.deepEqual(gate.specIds, ['SPEC-1']);
  });
});

test('C5：完全没有判据/夹具也算 examples_missing', () => {
  withAlignDb((db) => {
    buildAligned(db, { withCriterion: false });
    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'examples_missing');
    assert.deepEqual(gate.specIds, ['SPEC-1']);
  });
});

test('C2：raw 复述晚于条款 ⇒ restatement_too_late（写动作之外也能被门抓住）', () => {
  withAlignDb((db) => {
    appendIntent(db, { at: '2026-11-13T00:00:00Z' });
    appendRequirement(db, { at: '2026-11-13T02:00:00Z' });
    appendSeeds(db, [
      ev('restatement.recorded', 'RST-late', {
        intent_id: 'INT-1',
        draft_specs: [draft('d1')],
        inputs: [intentEdge('INT-1', 'ch:intent-1')],
      }, { at: '2026-11-13T03:00:00Z' }),
      ev('restatement.diff_dispositioned', 'RST-late:d1', {
        restatement_id: 'RST-late',
        kind: 'agree',
        target_ref: 'd1',
        disposition: 'accept',
        reason: 'late but disposed',
      }, { at: '2026-11-13T03:10:00Z' }),
    ]);
    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'restatement_too_late');
  });
});

test('C1/C6：raw 复述绑旧 hash ⇒ restatement_invalidated，staleReason 带旧/新 hash', () => {
  withAlignDb((db) => {
    appendIntent(db);
    appendSeeds(db, [
      ev('restatement.recorded', 'RST-stale', {
        intent_id: 'INT-1',
        draft_specs: [draft('d1')],
        inputs: [intentEdge('INT-1', 'ch:old-intent')],
      }),
    ]);
    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'restatement_invalidated');
    assert.ok(gate.staleReason?.includes('ch:old-intent'));
    assert.ok(gate.staleReason?.includes('ch:intent-1'));
  });
});

test('C6：invalidateRestatement 之后门返回 restatement_invalidated', () => {
  withAlignDb((db) => {
    buildAligned(db);
    const restatementId = listRestatements(readAlignmentState(db))[0]?.id;
    assert.ok(restatementId !== undefined);
    const result = invalidateRestatement(db, {
      restatementId,
      reason: 'intent 变更后重跑对齐',
      actor: 'agent-alpha',
      at: SPEC_AT,
    });
    assert.equal(result.ok, true);
    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'restatement_invalidated');
  });
});

test('C1：inputs 不是单条 intent 边 ⇒ restatement_invalidated（raw 事件）', () => {
  withAlignDb((db) => {
    appendIntent(db);
    appendSeeds(db, [
      ev('restatement.recorded', 'RST-bad-inputs', {
        intent_id: 'INT-1',
        draft_specs: [draft('d1')],
        inputs: [
          intentEdge('INT-1', 'ch:intent-1'),
          { kind: 'spec', id: 'SPEC-9', hash: 'ch:spec-9' },
        ],
      }),
    ]);
    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'restatement_invalidated');
  });
});

test('C1：draft_specs 形状坏 ⇒ invalid_args（门 fail-closed）', () => {
  withAlignDb((db) => {
    appendIntent(db);
    appendSeeds(db, [
      ev('restatement.recorded', 'RST-bad-draft', {
        intent_id: 'INT-1',
        draft_specs: [{ clause: '没有 id' }],
        inputs: [intentEdge('INT-1', 'ch:intent-1')],
      }),
    ]);
    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'invalid_args');
  });
});

test('空库：没有复述 ⇒ restatement_missing（M1-G 可读的结构化失败）', () => {
  withAlignDb((db) => {
    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'restatement_missing');
    assert.deepEqual(gate.pending, []);
    assert.deepEqual(gate.specIds, []);
  });
});

test('门默认看最新复述；指定旧复述能看到它的 pending', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const older = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [draft('d1'), draft('d2'), draft('d3')],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
      actor: 'agent-alpha',
      at: ALIGN_AT,
    });
    assert.equal(older.ok, true);
    const olderId = listRestatements(readAlignmentState(db))[0]?.id;
    assert.ok(olderId !== undefined);

    const newer = proposeRestatement(db, {
      intentId: 'INT-1',
      draftSpecs: [draft('n1')],
      inputs: [intentEdge('INT-1', 'ch:intent-1')],
      actor: 'agent-alpha',
      at: '2026-11-12T02:00:00Z',
    });
    assert.equal(newer.ok, true);
    const newerId = listRestatements(readAlignmentState(db))[1]?.id;
    assert.ok(newerId !== undefined);

    const disposed = disposeDiff(db, {
      restatementId: newerId, targetRef: 'n1', kind: 'missing', disposition: 'accept',
      actor: 'alice', actorKind: 'human', at: ALIGN_AT,
    });
    assert.equal(disposed.ok, true);

    appendRequirement(db);
    appendCriterion(db, 'CRIT-1', 'SPEC-1');

    assert.deepEqual(alignmentGate(db), { ok: true, pending: [], specIds: [] });

    const olderGate = alignmentGate(db, { restatementId: olderId });
    assert.equal(olderGate.ok, false);
    assert.equal(olderGate.reason_code, 'diff_unprocessed');
    assert.deepEqual(olderGate.pending, ['d1', 'd2', 'd3']);
  });
});

test('P1-2：同一 targetRef 有两条处置（raw 事件）⇒ 门 diff_conflict，不静默取最早一条', () => {
  withAlignDb((db) => {
    const restatementId = buildAligned(db);
    // 绕过写动作追加第二条处置：模拟重放/越权写造成的冲突事实。
    appendSeeds(db, [
      ev('restatement.diff_dispositioned', `raw-d1-duplicate`, {
        restatement_id: restatementId,
        kind: 'agree',
        target_ref: 'd1',
        disposition: 'defer',
        reason: null,
      }, { at: ALIGN_AT }),
    ]);

    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'diff_conflict');
    assert.deepEqual(gate.pending, ['d1']);
    assert.match(gate.staleReason ?? '', /2 条/);
  });
});

test('门：显式传入不存在的 restatementId ⇒ restatement_not_found（与写动作同码）', () => {
  withAlignDb((db) => {
    appendIntent(db);
    const gate = alignmentGate(db, { restatementId: 'RST-nope' });
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'restatement_not_found');
  });
});

test('门：事件链坏（坏 hash 直插）⇒ stale_reason 结构化失败，不抛异常', () => {
  withAlignDb((db) => {
    db.prepare(
      `INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'e-bad-hash',
      '2026-01-01T00:00:00Z',
      'tamper',
      'restatement.recorded',
      'RST-bad',
      '{}',
      '[]',
      'req-bad',
      'sha256:genesis',
      'sha256:not-the-real-hash',
    );

    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'stale_reason');
    assert.ok((gate.staleReason ?? '').length > 0);
  });
});

test('P2：时区偏移按真实时刻比较（-05:00 晚于 Z）⇒ restatement_too_late', () => {
  withAlignDb((db) => {
    appendIntent(db, { at: '2026-01-01T00:00:00Z' });
    appendRequirement(db, { at: '2026-01-01T02:00:00Z' });
    // 2025-12-31T23:00:00-05:00 实际是 2026-01-01T04:00:00Z，晚于条款。
    appendSeeds(db, [
      ev('restatement.recorded', 'RST-tz', {
        intent_id: 'INT-1',
        draft_specs: [],
        inputs: [intentEdge('INT-1', 'ch:intent-1')],
      }, { at: '2025-12-31T23:00:00-05:00' }),
    ]);

    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'restatement_too_late');
  });
});

test('P2：无时区/不可解析的 at ⇒ invalid_args（门 fail-closed）', () => {
  withAlignDb((db) => {
    appendIntent(db);
    appendSeeds(db, [
      ev('restatement.recorded', 'RST-no-tz', {
        intent_id: 'INT-1',
        draft_specs: [],
        inputs: [intentEdge('INT-1', 'ch:intent-1')],
      }, { at: '2026-01-01T00:00:00' }),
    ]);

    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'invalid_args');
  });

  withAlignDb((db) => {
    appendIntent(db);
    appendRequirement(db, { at: '2026-01-01 00:00:00' });
    appendSeeds(db, [
      ev('restatement.recorded', 'RST-bad-spec-at', {
        intent_id: 'INT-1',
        draft_specs: [],
        inputs: [intentEdge('INT-1', 'ch:intent-1')],
      }, { at: ALIGN_AT }),
    ]);

    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'invalid_args');
  });
});

test('P1-2 残余：同一 subject 的重复处置事件——fold 侧已 append-only 拒绝，门不会被静默翻掉', () => {
  withAlignDb((db) => {
    const restatementId = buildAligned(db);
    assert.equal(alignmentGate(db).ok, true);

    // 与 disposeDiff 写的 subject 相同、事件 id 不同。M1-6 之后 fold 对同一投影行
    // 的「同 id 不同内容」直接拒绝（restatement_diff ... append-only），因此这条旁路
    // 在写入口就关掉了；门侧的事件流扫描（D-039）保留为纵深防御。
    assert.throws(
      () =>
        appendSeeds(db, [
          ev('restatement.diff_dispositioned', `${restatementId}:d1`, {
            restatement_id: restatementId,
            kind: 'agree',
            target_ref: 'd1',
            disposition: 'defer',
            reason: '二轮复审又点了一次',
          }),
        ]),
      /append-only/,
    );

    const gate = alignmentGate(db);
    assert.equal(gate.ok, true, '冲突事件落不了库，门状态不应被翻转');
  });
});

test('P2-1：latest 与列表按真实时刻排序（+05:00 vs Z），不是字符串序', () => {
  withAlignDb((db) => {
    appendIntent(db);
    // R1 = 2026-11-10T19:00:00Z（字符串看起来“更晚”）；R2 = 2026-11-10T20:00:00Z 才是真 latest。
    appendSeeds(db, [
      ev('restatement.recorded', 'RST-offset', {
        intent_id: 'INT-1',
        draft_specs: [],
        inputs: [intentEdge('INT-1', 'ch:intent-1')],
      }, { at: '2026-11-11T00:00:00+05:00' }),
      ev('restatement.recorded', 'RST-z', {
        intent_id: 'INT-1',
        draft_specs: [],
        inputs: [intentEdge('INT-1', 'ch:stale')],
      }, { at: '2026-11-10T20:00:00Z' }),
    ]);

    assert.deepEqual(
      listRestatements(readAlignmentState(db)).map((row) => row.id),
      ['RST-offset', 'RST-z'],
    );

    // R2 的 input hash 过期：门若按字符串取 latest 会选中 R1 并判 ok，从而暴露排序 bug。
    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'restatement_invalidated');
    assert.match(gate.staleReason ?? '', /ch:stale/);
  });
});

test('P3-1：不存在的日历日 2026-02-30 不被 Date.parse 归一化接受 ⇒ invalid_args', () => {
  withAlignDb((db) => {
    appendIntent(db);
    appendSeeds(db, [
      ev('restatement.recorded', 'RST-feb30', {
        intent_id: 'INT-1',
        draft_specs: [],
        inputs: [intentEdge('INT-1', 'ch:intent-1')],
      }, { at: '2026-02-30T00:00:00Z' }),
    ]);

    const gate = alignmentGate(db);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason_code, 'invalid_args');
  });
});
