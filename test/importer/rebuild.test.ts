/**
 * rebuild 层单测：合成事件流、期望 work_unit 映射、差异清单结构（C5）、
 * 20 条抽样重建（C2）与 fail-closed 负例。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WORK_UNIT_FIELDS,
  buildClaimEvents,
  diffClaim,
  expectedWorkUnit,
  materializedWorkUnit,
  rebuildState,
  sampleRebuild,
  type WorkUnitRow,
} from '../../src/importer/rebuild.js';
import { ImportError, type ExportClaim } from '../../src/importer/parse.js';
import { computeEventHash } from '../../src/core/verify-events.js';
import { loadFixture } from './helpers.js';

const fixture = loadFixture();

function claimAt(index: number): ExportClaim {
  const claim = fixture.claims[index];
  assert.ok(claim, `fixture claim ${index} missing`);
  return claim;
}

function catchImportError(run: () => unknown): ImportError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ImportError, `expected ImportError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected ImportError to be thrown');
}

describe('importer/rebuild: 合成事件流', () => {
  it('一条 claim → 4 条事件，kind 顺序固定', () => {
    const claim = claimAt(0);
    const events = buildClaimEvents(claim);
    assert.deepEqual(
      events.map((event) => event.kind),
      ['task.created', 'task.claimed', 'criterion.registered', 'evidence.attached'],
    );
    assert.deepEqual(
      events.map((event) => event.id),
      [
        'imp:RC-2026-0001:task.created',
        'imp:RC-2026-0001:task.claimed',
        'imp:RC-2026-0001:criterion.registered',
        'imp:RC-2026-0001:evidence.attached',
      ],
    );
    for (const event of events) {
      assert.match(event.hash, /^sha256:[0-9a-f]{64}$/);
      assert.equal(event.request_id, 'imp:RC-2026-0001');
      assert.equal(event.actor, claim.actor);
      assert.equal(event.at, claim.at);
      assert.deepEqual(event.caused_by, []);
    }
    assert.equal(events[0]?.prev, 'imp:RC-2026-0001:root');
    assert.equal(events[1]?.prev, events[0]?.hash);
    assert.equal(events[2]?.prev, events[1]?.hash);
    assert.equal(events[3]?.prev, events[2]?.hash);
  });

  it('同一 claim 重建结果完全确定（无时钟/无随机）', () => {
    const claim = claimAt(4);
    assert.deepEqual(buildClaimEvents(claim), buildClaimEvents(claim));
  });

  it('hash 公式与 core verify 一致（直接复用 computeEventHash）', () => {
    const events = buildClaimEvents(claimAt(0));
    for (const event of events) {
      assert.equal(event.hash, computeEventHash(event));
    }
  });

  it('payload 变化会改变 hash 链（完整性可判）', () => {
    const claim = claimAt(2);
    const original = buildClaimEvents(claim);
    const mutated = buildClaimEvents({ ...claim, task_title: '改了标题' });
    assert.notEqual(mutated[0]?.hash, original[0]?.hash);
    assert.notEqual(mutated[3]?.hash, original[3]?.hash);
  });

  it('task.created 带上 fold 需要的 seq/kind；evidence.attached 带 task_id', () => {
    const claim = claimAt(0);
    const events = buildClaimEvents(claim);
    assert.deepEqual(events[0]?.payload, {
      seq: claim.task_seq,
      title: claim.task_title,
      kind: claim.task_kind,
      created_by: claim.actor,
    });
    assert.deepEqual(events[2]?.payload, {
      spec_id: claim.spec_id,
      kind: 'v1_conclusion',
      status_enum: 'draft',
      remedy: `rebuilt-from-v1-export:${claim.claim_no}`,
      legacy: true,
    });
    assert.deepEqual(events[3]?.payload, {
      criterion_id: claim.criterion_id,
      artifact_uri: claim.artifact_uri,
      artifact_sha256: claim.artifact_sha256,
      command: 'unknown: v1 export has no command field',
      task_id: claim.task_id,
    });
  });
});

describe('importer/rebuild: 期望 work_unit', () => {
  it('按 D-008 口径把 claim 映射成 work_unit 行', () => {
    const claim = claimAt(0);
    assert.deepEqual(expectedWorkUnit(claim), {
      id: 'wu:TASK-001',
      task_id: 'TASK-001',
      criterion_id: 'CRIT-101',
      spec_id: 'SPEC-001',
      evidence_id: 'EV-001',
      at: '2026-09-30T08:01:00Z',
    });
  });

  it('fold 真的物化了 work_unit（不是测试自己拼的）', () => {
    const state = rebuildState([claimAt(0)]);
    const row = materializedWorkUnit(state, 'TASK-001');
    assert.deepEqual(row, expectedWorkUnit(claimAt(0)));
    assert.equal(state.tables.work_unit['wu:TASK-001']?.['at'], '2026-09-30T08:01:00Z');
  });
});

describe('importer/rebuild: 差异清单结构（C5）', () => {
  it('一致 → 空清单', () => {
    const claim = claimAt(0);
    assert.deepEqual(diffClaim(0, claim, expectedWorkUnit(claim)), []);
  });

  it('字段漂移 → {path, v1, rebuilt, verdict, reason}，逐字段可定位', () => {
    const claim = claimAt(3);
    const expected = expectedWorkUnit(claim);
    for (const field of WORK_UNIT_FIELDS) {
      const drifted: WorkUnitRow = { ...expected, [field]: 'drifted' };
      const diffs = diffClaim(3, claim, drifted);
      // task_id 同时是 claim.subject 的来源，会多报一条 claim.subject 差异。
      const extra = field === 'task_id' ? 1 : 0;
      assert.equal(diffs.length, 1 + extra, `field ${field} diff count`);
      const diff = diffs[0];
      assert.ok(diff);
      assert.equal(diff.path, `claims[3].work_unit.${field}`);
      assert.equal(diff.v1, expected[field]);
      assert.equal(diff.rebuilt, 'drifted');
      assert.equal(diff.verdict, 'mismatch');
      assert.match(diff.reason, /rebuilt work_unit\./);
      if (field === 'task_id') {
        const subjectDiff = diffs[1];
        assert.ok(subjectDiff);
        assert.equal(subjectDiff.path, 'claims[3].claim.subject');
        assert.equal(subjectDiff.verdict, 'mismatch');
      }
    }
  });

  it('work_unit 缺失 → verdict=missing，rebuilt=null', () => {
    const claim = claimAt(2);
    const diffs = diffClaim(2, claim, null);
    assert.equal(diffs.length, 1);
    const diff = diffs[0];
    assert.ok(diff);
    assert.equal(diff.path, 'claims[2].work_unit');
    assert.equal(diff.verdict, 'missing');
    assert.equal(diff.rebuilt, null);
    assert.deepEqual(diff.v1, expectedWorkUnit(claim));
  });
});

describe('importer/rebuild: 抽样重建（C2）', () => {
  it('20 条 claim 全部重建，逐字段 0 差异', () => {
    const result = sampleRebuild(fixture.claims, 20);
    assert.equal(result.sample, 20);
    assert.equal(result.claims.length, 20);
    assert.deepEqual(result.diffs, []);
    assert.equal(result.fields_compared, 20 * 7);
    result.claims.forEach((rebuilt, index) => {
      const claim = claimAt(index);
      assert.equal(rebuilt.claim_no, claim.claim_no);
      assert.deepEqual(rebuilt.work_unit, expectedWorkUnit(claim));
      assert.deepEqual(rebuilt.claim, {
        subject: claim.task_id,
        predicate: 'done',
        value: 'true',
      });
    });
  });

  it('19 条抽样也允许（卡口径是“≥20 才能交”，抽样数本身下限由 CLI 给）', () => {
    const result = sampleRebuild(fixture.claims, 19);
    assert.equal(result.claims.length, 19);
    assert.deepEqual(result.diffs, []);
    assert.equal(result.fields_compared, 19 * 7);
  });

  it('sample 超过 claim 数 → sample 错误（不静默少建）', () => {
    const error = catchImportError(() => sampleRebuild(fixture.claims, 21));
    assert.equal(error.code, 'sample');
    assert.match(error.message, /only 20 claim record/);
  });

  it('两条 claim 抢同一个 task → rebuild 错误并点出两个 claim_no', () => {
    const first = claimAt(0);
    const second = claimAt(1);
    const error = catchImportError(() =>
      sampleRebuild([first, { ...second, task_id: first.task_id }], 2),
    );
    assert.equal(error.code, 'rebuild');
    assert.match(error.message, new RegExp(`${first.claim_no} and ${second.claim_no}`));
  });

  it('20 条 claim 一次 fold 后 state 里有 80 个事件、20 个 work_unit', () => {
    const state = rebuildState(fixture.claims);
    assert.equal(state.eventIds.length, 80);
    assert.equal(Object.keys(state.tables.work_unit).length, 20);
  });
});
