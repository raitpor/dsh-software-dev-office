import { appendAs as append } from '../../db/append-auth.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalJson, sha256Hex } from '../../../src/core/fold/canonical.js';
import { readEvents } from '../../../src/core/verify-events.js';
import { verify } from '../../../src/core/verify.js';

import {
  PM_REASON_CODES,
  SEATS,
  actionFor,
  assignCard,
  createCard,
  grant,
  hasPmRight,
  isPmUnblockable,
  raiseAttention,
  readPmQueue,
  requestRework,
  requestSignature,
  sign,
  unblockCard,
  writableAction,
} from '../../../src/core/pm/index.js';
import type { PmContext } from '../../../src/core/pm/index.js';
import { viewsForRight } from '../../../src/views/catalog.js';
import {
  appendSeeds,
  ev,
  eventCount,
  openTempDb,
  pmSession,
  seedBase,
  tableCount,
  withPmDb,
} from './helpers.js';

const PM: PmContext = { actor: 'lead', actorKind: 'human' };
const BLOCK_CODES = [
  'lease_expired',
  'lease_revoked',
  'upstream_changed',
  'clause_unjudged',
  'awaiting_signature',
  'verify_failed',
  'dirty_main_tree',
  'merge_conflict',
  'dirty_workcopy',
  'redteam_deferred',
] as const;
const PM_UNBLOCKABLE = new Set(['lease_expired', 'lease_revoked']);

function card(overrides: Partial<Parameters<typeof createCard>[2]> = {}): Parameters<typeof createCard>[2] {
  return {
    seq: 1,
    title: 'TASK-1 PM 卡',
    kind: 'implement',
    intentId: 'INT-1',
    criterionIds: ['CRIT-1'],
    scopePaths: ['src/core/pm/**'],
    ...overrides,
  };
}

function failureCode(result: ReturnType<typeof createCard>): string | undefined {
  return result.ok ? undefined : result.reason_code;
}

function taskRow(db: ReturnType<typeof openTempDb>['db'], taskId: string): Record<string, unknown> {
  return db.prepare('SELECT status, block_code, owner, scope_paths FROM task WHERE id = ?').get(taskId) as Record<string, unknown>;
}

// C1 建卡必带意图与判据
test('C1 缺意图/判据/写域 ⇒ card_incomplete；完整 ⇒ task 行落库', () => {
  withPmDb((db) => {
    seedBase(db);
    assert.equal(failureCode(createCard(db, PM, card({ intentId: '' }))), 'card_incomplete');
    assert.equal(failureCode(createCard(db, PM, card({ criterionIds: [] }))), 'card_incomplete');
    assert.equal(failureCode(createCard(db, PM, card({ scopePaths: [] }))), 'card_incomplete');
    const ok = createCard(db, PM, card({ seq: 11, title: '完整卡' }));
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    const row = taskRow(db, ok.task_id);
    assert.equal(row['status'], 'planned');
    assert.equal(row['owner'], null);
    const inputs = db.prepare('SELECT inputs FROM task WHERE id = ?').get(ok.task_id) as { inputs: string };
    assert.match(inputs.inputs, /intent:INT-1/);
    assert.match(inputs.inputs, /criterion:CRIT-1/);
  });
});

// C2 预占/派发前查权限
test('C2 越权派发 ⇒ no_permission（卡状态不变）；同泳道 ⇒ 通过', () => {
  withPmDb((db) => {
    seedBase(db);
    const created = createCard(db, PM, card({ seq: 2, scopePaths: ['src/core/**'] }));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const denied = assignCard(db, PM, { taskId: created.task_id, assignee: 'impl-surface' });
    assert.equal(denied.ok, false);
    if (denied.ok) return;
    assert.equal(denied.reason_code, 'no_permission');
    assert.equal(taskRow(db, created.task_id)['status'], 'planned');
    assert.equal(taskRow(db, created.task_id)['owner'], null);

    const ok = assignCard(db, PM, { taskId: created.task_id, assignee: 'impl-core' });
    assert.equal(ok.ok, true);
    assert.equal(taskRow(db, created.task_id)['status'], 'in_progress');
    assert.equal(taskRow(db, created.task_id)['owner'], 'impl-core');
  });
});

test('C2 跨泳道已预占冲突 ⇒ 事先 scope_mismatch', () => {
  withPmDb((db) => {
    seedBase(db);
    const a = createCard(db, PM, card({ seq: 3, scopePaths: ['src/core/**'] }));
    assert.equal(a.ok, true);
    if (!a.ok) return;
    assert.equal(assignCard(db, PM, { taskId: a.task_id, assignee: 'impl-core' }).ok, true);
    const b = createCard(db, PM, card({ seq: 4, title: '冲突卡', scopePaths: ['src/core/**'] }));
    assert.equal(b.ok, true);
    if (!b.ok) return;
    const blocked = assignCard(db, PM, { taskId: b.task_id, assignee: 'lead' });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.reason_code, 'scope_mismatch');
    assert.equal(taskRow(db, b.task_id)['status'], 'planned');
  });
});

test('C2 只读评审卡可派给 reviewer（写域豁免），且未经授权席位不存在', () => {
  withPmDb((db) => {
    seedBase(db);
    const review = createCard(db, PM, card({ seq: 5, title: '评审卡', kind: 'review', scopePaths: ['src/core/**'] }));
    assert.equal(review.ok, true);
    if (!review.ok) return;
    assert.equal(assignCard(db, PM, { taskId: review.task_id, assignee: 'reviewer' }).ok, true);
    const unknown = assignCard(db, PM, { taskId: review.task_id, assignee: 'nobody' });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.reason_code, 'no_such_seat');
  });
});

// C3 不代签 + 幂等
const PLAN_PAYLOAD = { plan: 'M2-5 minimal loop', note: 'demo' };
const PLAN_PROPOSITION = '把 M2-5 的计划定为最小环路；代价：返工';
function requestHash(input: {
  decisionKind: string;
  payload: unknown;
  proposition?: string | undefined;
  taskId?: string | undefined;
}): string {
  return `sha256:${sha256Hex(canonicalJson({
    decision_kind: input.decisionKind,
    payload: input.payload,
    proposition: input.proposition ?? null,
    task_id: input.taskId ?? null,
  }))}`;
}
const PLAN_HASH = requestHash({ decisionKind: 'plan', payload: PLAN_PAYLOAD, proposition: PLAN_PROPOSITION });

test('C3 request_sign 只落请求（不产生 decision 行）；同 (计算 hash, signer) 幂等', () => {
  const temp = openTempDb();
  try {
    seedBase(temp.db);
    const before = eventCount(temp.db);
    const decisionsBefore = tableCount(temp.db, 'decision');
    const first = requestSignature(temp.db, PM, {
      decisionKind: 'plan',
      payload: PLAN_PAYLOAD,
      payloadHash: PLAN_HASH,
      signer: 'lead',
      proposition: PLAN_PROPOSITION,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.idempotent, false);
    const second = requestSignature(temp.db, PM, {
      decisionKind: 'plan',
      payload: PLAN_PAYLOAD,
      signer: 'lead',
      proposition: PLAN_PROPOSITION,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.idempotent, true);
    assert.equal(second.request_id, first.request_id);
    assert.equal(eventCount(temp.db), before + 1);
    assert.equal(tableCount(temp.db, 'decision'), decisionsBefore);

    const asAgent = requestSignature(temp.db, PM, {
      decisionKind: 'plan',
      payload: { plan: 'agent-injected' },
      signer: 'lead',
      // 注入伪造的 actor_kind：必须被忽略（D-056：身份来自进程配置）
      ...({ actor_kind: 'agent' } as Record<string, unknown>),
    } as Parameters<typeof requestSignature>[2]);
    assert.equal(asAgent.ok, true);
    const events = readEvents(temp.db, []);
    const request = events.filter((event) => event.kind === 'request_sign').at(-1);
    assert.equal((request?.payload as Record<string, unknown>)['actor_kind'], 'human');

    assert.equal(sign().reason_code, 'not_a_signer');
    assert.equal(grant().reason_code, 'not_implemented');
  } finally {
    temp.close();
  }
});

test('P2-1 幂等键由服务端按内容计算：换 hash / 同内容重复 ⇒ 不会多落一条', () => {
  withPmDb((db) => {
    seedBase(db);
    const before = eventCount(db);
    const first = requestSignature(db, PM, { decisionKind: 'plan', payload: PLAN_PAYLOAD, signer: 'lead' });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(eventCount(db), before + 1);

    // 旧攻击：同内容换一个“看起来合法”的 hash —— 现在会与内容不符被拒（invalid_field）
    const forged = requestSignature(db, PM, {
      decisionKind: 'plan',
      payload: PLAN_PAYLOAD,
      payloadHash: 'sha256:forged-hash',
      signer: 'lead',
    });
    assert.equal(forged.ok, false);
    if (forged.ok) return;
    assert.equal(forged.reason_code, 'invalid_field');
    assert.equal(eventCount(db), before + 1);

    // 同内容不传 hash ⇒ 服务端算出同一 hash ⇒ 幂等
    const again = requestSignature(db, PM, { decisionKind: 'plan', payload: PLAN_PAYLOAD, signer: 'lead' });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.idempotent, true);
    assert.equal(eventCount(db), before + 1);

    // 不同内容 ⇒ 不同 hash ⇒ 新请求
    const other = requestSignature(db, PM, {
      decisionKind: 'plan',
      payload: { ...PLAN_PAYLOAD, note: 'changed' },
      signer: 'lead',
    });
    assert.equal(other.ok, true);
    if (!other.ok) return;
    assert.equal(other.idempotent, false);
    assert.equal(eventCount(db), before + 2);

    // P3-2：hash 覆盖 decisionKind（同 payload 换 kind 不得幂等复用旧请求）
    const otherKind = requestSignature(db, PM, {
      decisionKind: 'sign',
      payload: PLAN_PAYLOAD,
      signer: 'lead',
    });
    assert.equal(otherKind.ok, true);
    if (!otherKind.ok) return;
    assert.equal(otherKind.idempotent, false);
    assert.equal(eventCount(db), before + 3);
  });
});

// C4 解阻塞白名单
test('C4 只有 lease_expired/lease_revoked 可解；其余 ⇒ not_unblockable_by_pm 且卡仍在 blocked', () => {
  withPmDb((db) => {
    seedBase(db);
    let seq = 20;
    for (const blockCode of BLOCK_CODES) {
      seq += 1;
      const created = createCard(db, PM, card({ seq, title: `blocked ${blockCode}` }));
      assert.equal(created.ok, true);
      if (!created.ok) return;
      appendSeeds(db, [
        ev('task.blocked', created.task_id, { block_code: blockCode }, { actor: 'lead', at: '2026-11-14T00:00:00Z' }),
      ]);
      const result = unblockCard(db, PM, { taskId: created.task_id });
      if (PM_UNBLOCKABLE.has(blockCode)) {
        assert.equal(result.ok, true, `block_code ${blockCode} should be PM-unblockable`);
        assert.equal(taskRow(db, created.task_id)['status'], 'ready');
        assert.equal(taskRow(db, created.task_id)['block_code'], null);
      } else {
        assert.equal(result.ok, false, `block_code ${blockCode} must be refused`);
        if (result.ok) return;
        assert.equal(result.reason_code, 'not_unblockable_by_pm');
        assert.equal(taskRow(db, created.task_id)['status'], 'blocked');
      }
    }
  });
});

// C5 reason_code → 动作表
test('C5 七个 reason_code 都有合法动作；wait 不写事件、unclaimed 可派走', () => {
  const expected: Record<string, string> = {
    waiting_human: 'wait',
    blocked: 'attention',
    gate_red: 'rework',
    assumption_open: 'attention',
    sampled_review: 'assign',
    rework_pending: 'rework',
    unclaimed: 'assign',
  };
  for (const reason of PM_REASON_CODES) {
    assert.equal(actionFor(reason, null), expected[reason], `reason ${reason}`);
    assert.ok(writableAction(reason, null) !== null || reason === 'waiting_human');
  }
  assert.equal(actionFor('blocked', 'lease_expired'), 'unblock');
  assert.equal(actionFor('blocked', 'lease_revoked'), 'unblock');
  assert.equal(actionFor('blocked', 'upstream_changed'), 'rework');
  assert.equal(writableAction('waiting_human', null), null);

  withPmDb((db) => {
    seedBase(db);
    appendSeeds(db, [
      ev(
        'task.created',
        'TASK-Q',
        {
          seq: 90,
          title: '未认领卡',
          kind: 'implement',
          status: 'ready',
          scope_paths: ['src/core/**'],
          inputs: ['intent:INT-1', 'criterion:CRIT-1'],
        },
        { actor: 'lead' },
      ),
    ]);
    const before = readPmQueue(db, 'lead', pmSession('lead'));
    assert.equal(before.ok, true);
    if (!before.ok) return;
    const row = before.rows.find((item) => item.subject_id === 'TASK-Q');
    assert.notEqual(row, undefined);
    assert.equal(row?.reason_code, 'unclaimed');
    const assigned = assignCard(db, PM, { taskId: 'TASK-Q', assignee: 'impl-core' });
    assert.equal(assigned.ok, true);
    const after = readPmQueue(db, 'lead', pmSession('lead'));
    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.equal(after.rows.find((item) => item.subject_id === 'TASK-Q'), undefined);
  });
});

test('C5 rework 幂等键 (change_id, subject) 生效', () => {
  withPmDb((db) => {
    seedBase(db);
    const first = requestRework(db, PM, {
      changeId: 'CHG-1',
      subject: 'src/spec.md',
      intentId: 'INT-1',
      criterionIds: ['CRIT-1'],
      scopePaths: ['src/core/**'],
      seq: 40,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = requestRework(db, PM, {
      changeId: 'CHG-1',
      subject: 'src/spec.md',
      intentId: 'INT-1',
      criterionIds: ['CRIT-1'],
      scopePaths: ['src/core/**'],
      seq: 41,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.idempotent, true);
    assert.equal(second.task_id, first.task_id);
  });
});

// C6 未实现动作零写
test('C6 grant/sign 明确拒绝且不产生事件（escalate 自 M3-5 起是真动作）', () => {
  withPmDb((db) => {
    seedBase(db);
    const before = eventCount(db);
    assert.equal(grant().reason_code, 'not_implemented');
    assert.equal(sign().reason_code, 'not_a_signer');
    assert.equal(eventCount(db), before);
  });
});

// C7 留痕 + verify 重放
test('C7 动作留痕 actor=PM；verify 绿；重放后 pm_queue 逐行相等', () => {
  const first = openTempDb();
  try {
    seedBase(first.db);
    const created = createCard(first.db, PM, card({ seq: 60, title: '重放卡' }));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(assignCard(first.db, PM, { taskId: created.task_id, assignee: 'impl-core' }).ok, true);
    appendSeeds(first.db, [
      ev('task.blocked', created.task_id, { block_code: 'lease_expired' }, { actor: 'lead', at: '2026-11-14T01:00:00Z' }),
    ]);
    assert.equal(unblockCard(first.db, PM, { taskId: created.task_id }).ok, true);
    assert.equal(
      requestSignature(first.db, PM, { decisionKind: 'plan', payload: { plan: 'replay' }, signer: 'lead' }).ok,
      true,
    );
    const report = verify(first.db);
    assert.equal(report.ok, true, JSON.stringify(report.problems));

    const events = readEvents(first.db, []);
    const created2 = events.find((event) => event.kind === 'task.created' && event.subject === created.task_id);
    assert.equal(created2?.actor, 'lead');
    assert.equal(events.filter((event) => event.kind === 'request_sign').length, 1);

    const second = openTempDb();
    try {
      const replay = append(second.db, events);
      assert.equal(replay.ok, true, JSON.stringify(replay));
      const queueA = readPmQueue(first.db, 'lead', pmSession('lead'));
      const queueB = readPmQueue(second.db, 'lead', pmSession('lead'));
      assert.equal(queueA.ok, true);
      assert.equal(queueB.ok, true);
      if (!queueA.ok || !queueB.ok) return;
      assert.deepEqual(queueB.rows, queueA.rows);
    } finally {
      second.close();
    }
  } finally {
    first.close();
  }
});

// 静态表与权限辅助的防御性断言（C2 依据）
test('静态权限表自洽：lead 有 assign/plan；impl-core 不覆盖 surface 写域', () => {
  assert.equal(hasPmRight('lead', 'assign', ['src/core/**']), true);
  assert.equal(hasPmRight('impl-core', 'assign', ['src/core/**']), false);
  assert.equal(hasPmRight('impl-surface', 'plan', ['src/ui/**']), false);
});

test('raiseAttention 幂等且写 attention 行', () => {
  withPmDb((db) => {
    seedBase(db);
    const created = createCard(db, PM, card({ seq: 70, title: '等签卡' }));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const fixedCtx: PmContext = { ...PM, now: () => 1_700_000_000_000 };
    const first = raiseAttention(db, fixedCtx, {
      taskId: created.task_id,
      question: '这条计划要人签，确认吗？',
      askedOf: 'lead',
      expiresAt: '2026-12-01T00:00:00Z',
      at: '2026-11-15T00:00:00Z',
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = raiseAttention(db, fixedCtx, {
      taskId: created.task_id,
      question: '这条计划要人签，确认吗？',
      askedOf: 'lead',
      expiresAt: '2026-12-01T00:00:00Z',
      at: '2026-11-15T00:00:01Z',
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.attention_id, first.attention_id);
    assert.equal(first.attention_id, `ATT-${created.task_id}-${(1_700_000_000_000).toString(36)}`);
    assert.equal(tableCount(db, 'attention'), 1);
  });
});

// P2-2 未知 actor fail-closed
test('P2-2 readPmQueue 对未知/空 actor fail-closed ⇒ no_permission', () => {
  withPmDb((db) => {
    seedBase(db);
    for (const actor of ['nobody', '']) {
      const result = readPmQueue(db, actor);
      assert.equal(result.ok, false, `actor ${JSON.stringify(actor)}`);
      if (result.ok) return;
      assert.equal(result.reason_code, 'no_permission');
    }
    const lead = readPmQueue(db, 'lead', pmSession('lead'));
    assert.equal(lead.ok, true);
  });
});

// P3-1 白名单守卫
test('P3-1 isPmUnblockable：空/未知/非白名单码一律 false', () => {
  assert.equal(isPmUnblockable(''), false);
  assert.equal(isPmUnblockable('weird_code'), false);
  assert.equal(isPmUnblockable('upstream_changed'), false);
  assert.equal(isPmUnblockable('lease_expired'), true);
  assert.equal(isPmUnblockable('lease_revoked'), true);
});

// P2-3 静态读权限表与视图目录一致性守卫
// 参照物是**人工从 docs/05 §3（13 视图 + min_right）与 docs/07 §2（席位职责）抄下的期望表**，
// 不与 SEATS / listViewCatalog 同源；改视图目录或静态矩阵必须同时改这里。
// `conflicts` 不在 docs/05 §3 的冻结 13 条里：它是 M3-2 新增、由 M3-4 的 011 登记进 view_catalog
// （min_right=reader；docs/07 §5.1 只要求"可见"，无敏感字段）。仍按人工口径钉在这里，不由目录现算。
const READER_VIEWS = [
  'alignment', 'agents', 'baseline', 'board', 'conflicts', 'defects', 'evidence',
  'overview', 'plan', 'pm_gaps', 'pm_queue', 'team',
];
const REVIEWER_VIEWS = [...READER_VIEWS, 'gaps'].sort();
const ALL_VIEWS = [...REVIEWER_VIEWS, 'review_queue'].sort();
const EXPECTED_SEAT_VIEWS: Record<string, { right: string; views: string[] }> = {
  lead: { right: 'signer', views: ALL_VIEWS },
  'impl-core': { right: 'reader', views: READER_VIEWS },
  'impl-surface': { right: 'reader', views: READER_VIEWS },
  'impl-import': { right: 'reader', views: READER_VIEWS },
  'impl-security': { right: 'reader', views: READER_VIEWS },
  reviewer: { right: 'reviewer', views: REVIEWER_VIEWS },
};

test('P2-3 seat viewRight 与独立期望表一致（防静态表与视图目录漂移）', () => {
  withPmDb((db) => {
    for (const seat of Object.values(SEATS)) {
      const expected = EXPECTED_SEAT_VIEWS[seat.name];
      assert.ok(expected, `missing independent expectation for seat ${seat.name}`);
      assert.equal(seat.viewRight, expected?.right, `seat ${seat.name} viewRight`);
      const visible = viewsForRight(db, seat.viewRight).map((row) => row.name).sort();
      assert.deepEqual(visible, expected?.views.slice().sort(), `seat ${seat.name} views`);
    }
  });
});


// C5(b) 副作用 e2e：其它实体派生的行，动作可执行 + 副作用可验证（行不要求离开队列）
function fullTaskRow(db: Parameters<typeof eventCount>[0], taskId: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM task WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
}

test('C5(b) gate_red：requestRework 真落返工卡 + 事件 + 幂等', () => {
  withPmDb((db) => {
    seedBase(db);
    db.prepare(`INSERT INTO stage_run (id, stage, gate_id, baseline_hash, entered_at, exited_at, verdict, criteria, at)
      VALUES ('SR-1', 'build', 'G_build', 'b1', '2026-11-15T00:00:00Z', '2026-11-15T01:00:00Z', 'changes_requested', '[]', '2026-11-15T01:00:00Z')`).run();
    const queue = readPmQueue(db, PM.actor, pmSession(PM.actor));
    assert.equal(queue.ok, true);
    if (!queue.ok) return;
    assert.ok(queue.rows.some((row) => row.reason_code === 'gate_red' && row.action === 'rework'));

    const before = eventCount(db);
    const rework = {
      changeId: 'CHG-1',
      subject: 'SPEC-1',
      intentId: 'INT-1',
      criterionIds: ['CRIT-1'],
      scopePaths: ['src/core/pm/**'],
      seq: 10,
      title: '返工 CHG-1',
    };
    const first = requestRework(db, PM, rework);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.idempotent, false);
    assert.equal(eventCount(db), before + 1);
    const row = fullTaskRow(db, first.task_id);
    assert.equal(row?.['kind'], 'implement');
    assert.ok(String(row?.['inputs']).includes('change:CHG-1'));

    const again = requestRework(db, PM, rework);
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.idempotent, true);
    assert.equal(eventCount(db), before + 1);
  });
});

test('C5(b) sampled_review：建评审卡并派给 reviewer（产物 + 事件 + 不声称行消失）', () => {
  withPmDb((db) => {
    seedBase(db);
    const guaranteeDelta = { 1: 'kept', 2: 'kept', 3: 'kept' };
    const decisionId = 'd-baseline-1';
    const decisionPayload = {
      decision_kind: 'baseline',
      subject: 'B-1',
      value: 'frozen',
      proposition: '把尺子冻结为 M2 最小版',
      evidence: ['test/fixtures/baseline/waterfall.json'],
      difference: '新增基线',
      consequence: '后续判定按此基线',
      baseline: {
        hash: 'b-hash-1',
        prev: null,
        direction: null,
        will_change_hash: null,
        guarantee_delta: guaranteeDelta,
      },
    };
    const payloadHash = `sha256:${sha256Hex(canonicalJson(decisionPayload))}`;
    appendSeeds(db, [
      ev('decision.valid', decisionId, {
        decision_kind: 'baseline',
        payload_hash: payloadHash,
        frontier: 'f-1',
        payload: decisionPayload,
      }),
      ev('decision.signed', decisionId, {
        payload_hash: payloadHash,
        signature: 'sig-fixture',
        key_id: 'key-fixture',
        signer: 'lead',
      }),
      ev('baseline.frozen', 'B-1', {
        engine: { version: 'e1', criteria_manifest_hash: 'cmh-1' },
        policy: { review: { sample_every: 2, sample_seed: 0 } },
        criteria: [],
        gates: {},
        thresholds: {},
        assurance: {},
        frozen_by: 'lead',
        hash: 'b-hash-1',
        decision_id: decisionId,
        will_change_hash: null,
        guarantee_delta: guaranteeDelta,
      }),
      ev('task.created', 'TASK-2', {
        seq: 2,
        title: '已完成的抽样命中卡',
        kind: 'implement',
        status: 'done',
        created_by: 'lead',
        scope_paths: ['src/core/pm/**'],
      }),
    ]);
    const queue = readPmQueue(db, PM.actor, pmSession(PM.actor));
    assert.equal(queue.ok, true);
    if (!queue.ok) return;
    assert.ok(queue.rows.some((row) => row.reason_code === 'sampled_review' && row.action === 'dispatch'));

    const review = createCard(db, PM, card({ seq: 20, kind: 'review', title: '评审 TASK-2' }));
    assert.equal(review.ok, true);
    if (!review.ok) return;
    const assigned = assignCard(db, PM, { taskId: review.task_id, assignee: 'reviewer' });
    assert.equal(assigned.ok, true);
    const row = fullTaskRow(db, review.task_id);
    assert.equal(row?.['kind'], 'review');
    assert.equal(row?.['owner'], 'reviewer');
    assert.equal(row?.['status'], 'in_progress');
  });
});

test('C5(b) assumption_open：raiseAttention 真落 attention（幂等，不重复写）', () => {
  withPmDb((db) => {
    seedBase(db);
    appendSeeds(db, [
      ev('spec.defined', 'SPEC-ASM', {
        kind: 'assumption',
        clause: '假设上游目录稳定',
        intent_id: 'INT-1',
        content_hash: 'ch:SPEC-ASM',
        blast_radius: '上游目录变化会让消费方全部失效',
      }),
    ]);
    const task = createCard(db, PM, card({ seq: 30, title: '假设处置卡' }));
    assert.equal(task.ok, true);
    if (!task.ok) return;
    const queue = readPmQueue(db, PM.actor, pmSession(PM.actor));
    assert.equal(queue.ok, true);
    if (!queue.ok) return;
    assert.ok(queue.rows.some((row) => row.reason_code === 'assumption_open'));

    const before = eventCount(db);
    const first = raiseAttention(db, PM, {
      taskId: task.task_id,
      question: '上游目录稳定的假设怎么处置？',
      askedOf: 'lead',
      expiresAt: '2026-11-20T00:00:00Z',
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.notEqual(first.event_id, '');
    assert.equal(tableCount(db, 'attention'), 1);
    assert.equal(eventCount(db), before + 1);

    const again = raiseAttention(db, PM, {
      taskId: task.task_id,
      question: '上游目录稳定的假设怎么处置？',
      askedOf: 'lead',
      expiresAt: '2026-11-20T00:00:00Z',
    });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.event_id, '');
    assert.equal(tableCount(db, 'attention'), 1);
    assert.equal(eventCount(db), before + 1);
  });
});

test('C5(b) waiting_human：baseline.rejected 派生行 + raiseAttention 真落 attention', () => {
  withPmDb((db) => {
    seedBase(db);
    appendSeeds(db, [
      ev('baseline.rejected', 'DEC-REJ-1', { reason_code: 'loosen_not_allowed' }),
    ]);
    const task = createCard(db, PM, card({ seq: 40, title: '冻结被拒的处置卡' }));
    assert.equal(task.ok, true);
    if (!task.ok) return;
    const queue = readPmQueue(db, PM.actor, pmSession(PM.actor));
    assert.equal(queue.ok, true);
    if (!queue.ok) return;
    assert.ok(queue.rows.some((row) => row.reason_code === 'waiting_human'));

    const before = eventCount(db);
    const first = raiseAttention(db, PM, {
      taskId: task.task_id,
      question: '冻结被拒后由谁重定尺子？',
      askedOf: 'lead',
      expiresAt: '2026-11-20T00:00:00Z',
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.notEqual(first.event_id, '');
    assert.equal(tableCount(db, 'attention'), 1);
    assert.equal(eventCount(db), before + 1);

    const again = raiseAttention(db, PM, {
      taskId: task.task_id,
      question: '冻结被拒后由谁重定尺子？',
      askedOf: 'lead',
      expiresAt: '2026-11-20T00:00:00Z',
    });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    assert.equal(again.event_id, '');
    assert.equal(tableCount(db, 'attention'), 1);
    assert.equal(eventCount(db), before + 1);
  });
});


// C5(a) 队列级断言：白名单 blocked 解阻塞后，pm_queue 里的 blocked 行消失
test('C5(a) blocked+lease_expired：unblock 后 readPmQueue 的 blocked 行消失（队列级）', () => {
  withPmDb((db) => {
    seedBase(db);
    const created = createCard(db, PM, card({ seq: 21, title: 'lease 过期的卡' }));
    assert.equal(created.ok, true);
    if (!created.ok) return;
    appendSeeds(db, [
      ev('task.blocked', created.task_id, { block_code: 'lease_expired' }, { actor: 'lead', at: '2026-11-14T00:00:00Z' }),
    ]);
    const before = readPmQueue(db, PM.actor, pmSession(PM.actor));
    assert.equal(before.ok, true);
    if (!before.ok) return;
    assert.ok(before.rows.some((row) => row.reason_code === 'blocked' && row.subject_id === created.task_id));

    const unblocked = unblockCard(db, PM, { taskId: created.task_id });
    assert.equal(unblocked.ok, true);
    const after = readPmQueue(db, PM.actor, pmSession(PM.actor));
    assert.equal(after.ok, true);
    if (!after.ok) return;
    assert.equal(
      after.rows.some((row) => row.reason_code === 'blocked' && row.subject_id === created.task_id),
      false,
      'blocked row must leave pm_queue after unblock',
    );
  });
});
