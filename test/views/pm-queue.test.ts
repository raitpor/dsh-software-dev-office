import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withMigratedDb } from '../db/helpers.js';
import type { SdoDatabase } from '../../src/db/driver.js';

/**
 * C5 夹具：七种 reason_code 各一行，覆盖 docs/05 §10.1 的固定顺序。
 *
 * 行按 rank 反序插入（unclaimed → … → waiting_human），并且 `since` 值按 rank 递减布置，
 * 这样任何“按插入顺序”或“按 since 排序”的实现都会红——只有按 rank 排序才是 [1..7]。
 */

const SINCE = {
  unclaimed: '2026-01-01T00:00:01Z',
  rework: '2026-01-01T00:00:02Z',
  sampled: '2026-01-01T00:00:03Z',
  assumption: '2026-01-01T00:00:04Z',
  gateRed: '2026-01-01T00:00:05Z',
  blocked: '2026-01-01T00:00:06Z',
  waiting: '2026-01-01T00:00:07Z',
} as const;

const POLICY = JSON.stringify({
  preset: 'm0',
  stages: [{ id: 'S1', kinds: ['implement'], after: [] }],
  gates: [],
  switches: {},
  review: { sample_every: 2, sample_seed: 0 },
  artifact_kinds: {},
});

function seedPmQueueFixture(db: SdoDatabase): void {
  db.prepare(
    `INSERT INTO decision (id, decision_kind, status, payload, payload_hash, signature, key_id, signer, frontier, at)
     VALUES ('D1', 'sign', 'valid', '{}', 'h-d1', 'sig-d1', 'k1', 'human-pm', 'F0', '2026-01-01T00:00:00Z')`,
  ).run();
  db.prepare(
    `INSERT INTO intent (id, statement, source_text, owner, decision_id, strength, baseline_hash, content_hash, at)
     VALUES ('I1', '意图摘要', '用户原话', 'human-pm', 'D1', 'explicit', 'b0', 'h-i1', '2026-01-01T00:00:00Z')`,
  ).run();

  // 7. unclaimed：ready 卡、无依赖、无 lease 事件。
  db.prepare(
    `INSERT INTO task (id, seq, title, kind, created_by, owner, status, scope_paths, inputs, at)
     VALUES ('T4', 3, '待派发卡', 'implement', 'human-pm', NULL, 'ready', '["src/x/"]', '[]', ?)`,
  ).run(SINCE.unclaimed);

  // 6. rework_pending：change.applied 且 rework_units>0，尚无对应 implement 卡。
  db.prepare(
    `INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES ('change.applied', '2026-01-01T00:00:00Z', '变更已应用')`,
  ).run();
  db.prepare(
    `INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash)
     VALUES ('E1', ?, 'agent-dev', 'change.applied', 'CHG-1', '{"change_id":"CHG-1","rework_units":2}', '[]', NULL, '', 'h-e1')`,
  ).run(SINCE.rework);

  // 5. sampled_review：最新 baseline 抽样命中，done 的 implement 卡缺 review_round。
  db.prepare(
    `INSERT INTO baseline (id, frozen_by, engine_version, criteria_manifest_hash, policy, criteria, gates, thresholds, assurance, hash, at)
     VALUES ('B1', 'human-pm', '0.0.1', 'h-crit', ?, '[]', '[]', '{}',
             '{"independence":"solo","db_confidentiality":"encrypted","na_stages":[],"level":"M0"}', 'h-b1', '2026-01-01T00:00:00Z')`,
  ).run(POLICY);
  db.prepare(
    `INSERT INTO task (id, seq, title, kind, created_by, owner, status, at)
     VALUES ('T3', 4, '已完成的实现卡', 'implement', 'human-pm', 'agent-dev', 'done', ?)`,
  ).run(SINCE.sampled);

  // 4. assumption_open：open 假设挡派发。
  db.prepare(
    `INSERT INTO spec (id, intent_id, clause, kind, status, blast_radius, created_by, producer, content_hash, at)
     VALUES ('S1', 'I1', '假设：失败后是否重试？', 'assumption', 'open', 'REQ-1 的推进', 'human-pm', 'agent-dev', 'h-s1', ?)`,
  ).run(SINCE.assumption);

  // 3. gate_red：阶段判红。
  db.prepare(
    `INSERT INTO stage_run (id, stage, gate_id, baseline_hash, entered_at, exited_at, verdict, criteria, at)
     VALUES ('SR1', 'S1', 'G1', 'b0', ?, NULL, 'changes_requested', '[]', ?)`,
  ).run(SINCE.gateRed, SINCE.gateRed);

  // 2. blocked：blocked 且无 open attention；block_code 可被 PM 解 → unblock。
  db.prepare(
    `INSERT INTO task (id, seq, title, kind, created_by, owner, status, block_code, at)
     VALUES ('T2', 2, '租约过期的卡', 'implement', 'human-pm', 'agent-dev', 'blocked', 'lease_expired', ?)`,
  ).run(SINCE.blocked);

  // 1. waiting_human：open attention。
  db.prepare(
    `INSERT INTO task (id, seq, title, kind, created_by, owner, status, at)
     VALUES ('T1', 1, '等待人答的卡', 'implement', 'human-pm', 'agent-dev', 'in_progress', ?)`,
  ).run(SINCE.waiting);
  db.prepare(
    `INSERT INTO attention (id, task_id, raised_by, question, options, state, expires_at, at)
     VALUES ('A1', 'T1', 'agent-dev', '是否继续？', '["继续","改计划"]', 'open', '2026-02-01T00:00:00Z', ?)`,
  ).run(SINCE.waiting);
}

const SELECT_COLUMNS =
  'SELECT rank, kind, subject_id, title, action, reason_code, since, owner, block_code, blocked_by FROM pm_queue';

test('C5：pm_queue 恰好 7 行，rank 1..7 与 reason_code/action 顺序固定（插入顺序与 since 顺序都相反）', () => {
  withMigratedDb((db) => {
    seedPmQueueFixture(db);

    const first = db.prepare(SELECT_COLUMNS).all() as Array<Record<string, unknown>>;
    assert.equal(first.length, 7, 'C5 夹具必须恰好 7 行（row_budget=7）');

    assert.deepEqual(
      first.map((row) => row['rank']),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.deepEqual(
      first.map((row) => row['reason_code']),
      [
        'waiting_human',
        'blocked',
        'gate_red',
        'assumption_open',
        'sampled_review',
        'rework_pending',
        'unclaimed',
      ],
    );
    assert.deepEqual(
      first.map((row) => row['action']),
      ['wait', 'unblock', 'rework', 'escalate', 'dispatch', 'rework', 'dispatch'],
    );
    assert.deepEqual(
      first.map((row) => row['kind']),
      ['attention', 'task', 'stage_run', 'assumption', 'task', 'task', 'task'],
    );
    assert.deepEqual(
      first.map((row) => row['subject_id']),
      ['A1', 'T2', 'SR1', 'S1', 'T3', 'CHG-1', 'T4'],
    );

    // since 与 rank 反向：若实现按 since 排序，这个断言必红。
    assert.deepEqual(
      first.map((row) => row['since']),
      [
        SINCE.waiting,
        SINCE.blocked,
        SINCE.gateRed,
        SINCE.assumption,
        SINCE.sampled,
        SINCE.rework,
        SINCE.unclaimed,
      ],
    );

    // blocked 行必须带 block_code 与 blocked_by（docs/05 §10.1）。
    const blocked = first[1] ?? {};
    assert.equal(blocked['block_code'], 'lease_expired');
    assert.equal(blocked['blocked_by'], '[]');

    // 同一 as_of 下两次查询逐行相同（确定性；M0 视图不取 now()）。
    const second = db.prepare(SELECT_COLUMNS).all() as Array<Record<string, unknown>>;
    assert.deepEqual(second, first);
  });
});

test('C5：同一 rank 内按 kind,subject_id 稳定排序（不用 since），两次全表查询逐行相同', () => {
  withMigratedDb((db) => {
    db.prepare(
      `INSERT INTO task (id, seq, title, kind, created_by, status, at)
       VALUES ('T1', 1, '卡一', 'implement', 'human-pm', 'in_progress', '2026-01-01T00:00:01Z'),
              ('T2', 2, '卡二', 'implement', 'human-pm', 'in_progress', '2026-01-01T00:00:02Z')`,
    ).run();
    db.prepare(
      `INSERT INTO attention (id, task_id, raised_by, question, state, expires_at, at)
       VALUES ('A-late', 'T1', 'agent-dev', '后问', 'open', '2026-02-01T00:00:00Z', '2026-01-01T00:00:08Z'),
              ('A-early', 'T2', 'agent-dev', '先问', 'open', '2026-02-01T00:00:00Z', '2026-01-01T00:00:09Z')`,
    ).run();

    const rows = db.prepare('SELECT * FROM pm_queue').all() as Array<Record<string, unknown>>;
    // subject_id 升序（A-early 在前）；这两个 attention 的 since 恰好相反（A-early 更晚），
    // 所以若实现按 since 排，这个断言必红——rank 内兜底键不是 since。
    assert.deepEqual(
      rows.map((row) => row['subject_id']),
      ['A-early', 'A-late'],
    );
    assert.deepEqual(
      rows.map((row) => row['since']),
      ['2026-01-01T00:00:09Z', '2026-01-01T00:00:08Z'],
    );
    assert.deepEqual(db.prepare('SELECT * FROM pm_queue').all(), rows);
  });
});

test('pm_queue：blocked_by 未满足的 ready 卡进 blocked/wait（不是 unclaimed）', () => {
  withMigratedDb((db) => {
    db.prepare(
      `INSERT INTO task (id, seq, title, kind, created_by, status, at)
       VALUES ('T1', 1, '依赖卡', 'implement', 'human-pm', 'in_progress', '2026-01-01T00:00:01Z')`,
    ).run();
    db.prepare(
      `INSERT INTO task (id, seq, title, kind, created_by, status, blocked_by, at)
       VALUES ('T2', 2, '等 T1 的卡', 'implement', 'human-pm', 'ready', '["T1"]', '2026-01-01T00:00:02Z')`,
    ).run();

    const rows = db.prepare(SELECT_COLUMNS).all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['reason_code'], 'blocked');
    assert.equal(rows[0]?.['rank'], 2);
    assert.equal(rows[0]?.['action'], 'wait');
    assert.equal(rows[0]?.['subject_id'], 'T2');
    assert.equal(rows[0]?.['blocked_by'], '["T1"]');
  });
});
