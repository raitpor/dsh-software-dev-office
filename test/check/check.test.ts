import assert from 'node:assert/strict';
import { test } from 'node:test';

import { runCheck, type CheckReport } from '../../src/check/index.js';
import { evaluateDeadField } from '../../src/check/deadfield.js';
import { appendSeeds, engineSeedForSpecSet, seamSeeds, seed, withCheckDb } from './helpers.js';

function report(result: CheckReport | { ok: false }): CheckReport {
  assert.equal(result.ok, true);
  return result as CheckReport;
}

test('C1/C3：空库也能跑，criterion 模式带 preview/judged/baseline 三件套', () => {
  withCheckDb((db) => {
    const result = report(runCheck(db, { criterion: 'provenance.present', at: '2026-11-13T00:00:00Z' }));
    assert.equal(result.mode, 'criterion');
    assert.equal(result.preview, true);
    assert.equal(result.judged, false);
    assert.equal(result.baseline, null);
    assert.ok(result.criterion !== undefined);
    assert.equal(result.criterion.preview, true);
    assert.equal(result.criterion.judged, false);
    assert.equal(result.criterion.result, 'pass');
    assert.ok(result.criterion.reasons.some((reason) => reason.code === 'actor_registry_unavailable'));
  });
});

test('P1：空库 core 三条都给 pass/fail，spec_set.signed 无 requirement ⇒ fail（不许 na）', () => {
  withCheckDb((db) => {
    const specSet = report(runCheck(db, { criterion: 'spec_set.signed' })).criterion;
    assert.equal(specSet?.result, 'fail');
    assert.ok(specSet?.reasons.some((reason) => reason.code === 'no_requirement_yet'));
    assert.notEqual(specSet?.result, 'na');

    const provenance = report(runCheck(db, { criterion: 'provenance.present' })).criterion;
    assert.equal(provenance?.result, 'pass');
    const assumption = report(runCheck(db, { criterion: 'assumption_set.signed' })).criterion;
    assert.equal(assumption?.result, 'fail');
  });
});

test('C2：spec_set.signed 无签字时 fail 且带 reasons 与 basis（不给裸布尔）', () => {
  withCheckDb((db) => {
    appendSeeds(db, seamSeeds());
    const result = report(runCheck(db, { criterion: 'spec_set.signed' }));
    const check = result.criterion;
    assert.ok(check !== undefined);
    assert.equal(check.result, 'fail');
    assert.ok(check.reasons.some((reason) => reason.code === 'spec_set_not_signed'));
    assert.deepEqual(check.basis.spec_ids, ['SPEC-1']);
  });
});

test('C2：spec_set 有效签字覆盖全部 requirement 后 pass，并绑 frontier', () => {
  withCheckDb((db) => {
    appendSeeds(db, [...seamSeeds(), ...engineSeedForSpecSet()]);
    const result = report(runCheck(db, { criterion: 'spec_set.signed' }));
    assert.equal(result.criterion?.result, 'pass');
    assert.deepEqual(result.criterion?.basis.spec_ids, ['SPEC-1']);
  });
});

test('A2/C2：core 之外没有数据载体的判据给 unknown，不冒充 pass', () => {
  withCheckDb((db) => {
    const result = report(runCheck(db, { criterion: 'review.required' }));
    assert.equal(result.criterion?.result, 'unknown');
    assert.ok(result.criterion?.reasons.some((reason) => reason.code === 'insufficient_data'));
  });
});

test('C6：effective 来自 binding，dead_field 不在目录 ⇒ not_registered', () => {
  withCheckDb((db) => {
    const core = report(runCheck(db, { criterion: 'provenance.present' })).criterion;
    assert.equal(core?.effective, true);
    assert.deepEqual(core?.binding_reasons, []);
    const builtin = report(runCheck(db, { criterion: 'dead_field' })).criterion;
    assert.equal(builtin?.effective, false);
    assert.ok(builtin?.binding_reasons.includes('not_registered'));
  });
});

test('C7：未知判据给 unknown_criterion（不抛裸异常）', () => {
  withCheckDb((db) => {
    const result = runCheck(db, { criterion: 'no.such.criterion' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false ? result.reason_code : undefined, 'unknown_criterion');
  });
});

test('C8：同输入两次输出逐字节一致（固定 at）', () => {
  withCheckDb((db) => {
    appendSeeds(db, seamSeeds());
    const options = { gate: 'req', preset: 'waterfall', at: '2026-11-13T00:00:00Z' } as const;
    const first = report(runCheck(db, options));
    const second = report(runCheck(db, options));
    assert.deepEqual(first, second);
  });
});

test('C9：dead_field 绿例（消费者齐）与红例（有写入方无消费者）', () => {
  withCheckDb((db) => {
    // 绿：给六表所有列铺 field_consumer，写入方列全部有消费者
    const tables = ['intent', 'spec', 'scenario', 'criterion', 'evidence', 'claim'];
    const insert = db.prepare(
      "INSERT INTO field_consumer (field, consumer_kind, consumer_id) VALUES (?, 'criterion', 'green')",
    );
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      for (const column of columns) insert.run(`${table}.${column.name}`);
    }
    assert.equal(evaluateDeadField(db).result, 'pass');

    // 红：临时副本加一列并注入写入方，消费者没有 ⇒ fail
    db.exec('ALTER TABLE spec ADD COLUMN watch_me TEXT');
    const red = evaluateDeadField(db, { writers: { spec: ['watch_me'] } });
    assert.equal(red.result, 'fail');
    assert.ok(red.reasons.some((reason) => reason.detail === 'spec.watch_me' && reason.level === 'fail'));
  });
});

test('C9：无写入方的列只给 info，不判 fail（scenario/claim 口径）', () => {
  withCheckDb((db) => {
    const report = evaluateDeadField(db);
    assert.ok(report.reasons.some((reason) => reason.detail.startsWith('scenario.') && reason.why === 'no_writer'));
    assert.ok(report.reasons.some((reason) => reason.detail.startsWith('claim.') && reason.why === 'no_writer'));
  });
});

test('core：assumption_set.signed 无假设也要签空集；有 open 假设直接 fail', () => {
  withCheckDb((db) => {
    const none = report(runCheck(db, { criterion: 'assumption_set.signed' }));
    assert.equal(none.criterion?.result, 'fail');
    assert.ok(none.criterion?.reasons.some((reason) => reason.code === 'assumption_set_not_signed'));

    appendSeeds(db, [
      ...seamSeeds(),
      seed(9, 'spec.defined', 'SPEC-A', {
        kind: 'assumption',
        clause: '假设 A',
        intent_id: 'INT-1',
        blast_radius: '仅影响本轮',
        content_hash: 'sha256:spec-a',
      }),
    ]);
    const open = report(runCheck(db, { criterion: 'assumption_set.signed' }));
    assert.equal(open.criterion?.result, 'fail');
    assert.ok(open.criterion?.reasons.some((reason) => reason.code === 'open_assumption' && reason.detail === 'SPEC-A'));
  });
});

test('provenance.present 的未校验标注在单条结果里（reasons[].detail），不是只在顶层', () => {
  withCheckDb((db) => {
    const check = report(runCheck(db, { criterion: 'provenance.present' })).criterion;
    const note = check?.reasons.find((reason) => reason.code === 'actor_registry_unavailable');
    assert.ok(note !== undefined);
    assert.ok((note?.detail ?? '').length > 0);
  });
});
