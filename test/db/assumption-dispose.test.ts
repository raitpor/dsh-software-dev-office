/**
 * M2-3 C1/C2/C7/C8/C9 的 db 级证据：
 * - write 动作（`previewAssumptionSet` / `disposeAssumptionSet`）只经一次 append；
 * - verify 双向核对（decision → disposed 事件；投影 → 有效 decision）；
 * - `sdo_check` 的 assumption_set.signed 条件②与空集签字。
 *
 * 注意：`spec` 表的 `decision_id`/`successor_ref`/`disposed_at`/`invalidated_*` 是
 * fold-only 列（不落 DB），db 层只断言 `status` 与事件链；绑定细节由 test/core 覆盖。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { append, chainHead } from '../../src/db/write.js';
import { computeEventHash } from '../../src/core/verify-events.js';
import { verify } from '../../src/core/verify.js';
import { runCheck, type CheckReport } from '../../src/check/index.js';
import { disposeAssumptionSet, previewAssumptionSet } from '../../src/db/assumption.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { chain, payloadHashOf, seed, withWriteDb, PASSPHRASE, type EventSeed } from './append-helpers.js';

function count(db: SdoDatabase, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

function reportOf(result: ReturnType<typeof runCheck>): CheckReport {
  assert.equal(result.ok, true);
  return result as CheckReport;
}

/** intent 链 + 两条 open 假设（db 层需要真实 FK：spec.intent_id → intent）。 */
function baseSeedList(): EventSeed[] {
  const intentPayload = { kind: 'intent', intent_id: 'INT-1' };
  const intentHash = payloadHashOf(intentPayload);
  return [
    seed(90, 'decision.valid', 'd-int', {
      decision_kind: 'intent',
      payload: intentPayload,
      payload_hash: intentHash,
      frontier: 'f-1',
    }),
    seed(91, 'decision.signed', 'd-int', { payload_hash: intentHash, frontier: 'f-1', nonce: 'n-d-int' }),
    seed(92, 'intent.signed', 'INT-1', {
      decision_id: 'd-int',
      statement: 'intent',
      owner: 'alice',
      strength: 'explicit',
      content_hash: 'ch:INT-1',
      baseline_hash: 'bh-1',
    }),
    seed(1, 'assumption.recorded', 'A-1', { intent_id: 'INT-1', clause: 'a1', blast_radius: 'core', content_hash: 'ch:a1' }),
    seed(2, 'assumption.recorded', 'A-2', { intent_id: 'INT-1', clause: 'a2', blast_radius: 'core', content_hash: 'ch:a2' }),
  ];
}

function setPayload(specIds: readonly string[], dispositions: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { spec_ids: specIds, dispositions, readings_hash: 'sha256:readings' };
}

interface DecisionOptions {
  readonly n?: number;
  readonly decisionKind?: string;
  readonly signed?: boolean;
}

function decisionSeedList(
  decisionId: string,
  payload: Record<string, unknown>,
  options: DecisionOptions = {},
): EventSeed[] {
  const n = options.n ?? 3;
  const hash = payloadHashOf(payload);
  const seeds: EventSeed[] = [
    seed(n, 'decision.valid', decisionId, {
      decision_kind: options.decisionKind ?? 'assumption_set',
      payload,
      payload_hash: hash,
      frontier: 'f-1',
    }),
  ];
  if (options.signed !== false) {
    seeds.push(seed(n + 1, 'decision.signed', decisionId, { payload_hash: hash, frontier: 'f-1', nonce: `n-${decisionId}` }));
  }
  return seeds;
}

function assumptionSeeds(): ReturnType<typeof chain> {
  return chain([
    ...baseSeedList(),
    ...decisionSeedList('d-as', setPayload(['A-1', 'A-2'], [
      { spec_id: 'A-1', disposition: 'confirmed' },
      { spec_id: 'A-2', disposition: 'rejected', successor_ref: 'A-9' },
    ])),
  ]);
}

test('C7/C8：一次 append 处置两条 ⇒ 状态落库、verify 双向绿、preview 只剩（后续）open', () => {
  withWriteDb((db) => {
    assert.equal(append(db, assumptionSeeds()).ok, true);
    const before = chainHead(db);

    const preview = previewAssumptionSet(db);
    assert.equal(preview.ok, true);
    if (!preview.ok) return;
    assert.deepEqual(preview.preview.payload.spec_ids, ['A-1', 'A-2']);
    assert.equal(preview.preview.items.length, 2);

    const result = disposeAssumptionSet(db, { decision_id: 'd-as', actor: 'alice', at: '2026-11-15T00:00:00Z' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.disposed, ['A-1', 'A-2']);
    assert.equal(result.event_ids.length, 2);

    const rows = db.prepare("SELECT id, status FROM spec WHERE kind = 'assumption' ORDER BY id").all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      { id: 'A-1', status: 'confirmed' },
      { id: 'A-2', status: 'rejected' },
    ]);
    assert.equal(count(db, 'SELECT count(*) AS n FROM event WHERE id IN (?, ?)', result.event_ids[0], result.event_ids[1]), 2);
    assert.notEqual(chainHead(db), before);

    const verified = verify(db);
    assert.deepEqual(verified.problems, []);
    assert.equal(verified.ok, true);

    const after = previewAssumptionSet(db);
    assert.equal(after.ok, true);
    if (after.ok) assert.deepEqual(after.preview.items, []);
  });
});

test('C7 原子性：任一处置不满足 open ⇒ 整批拒、0 行、链头不变、返回结构化原因码', () => {
  withWriteDb((db) => {
    assert.equal(append(db, assumptionSeeds()).ok, true);
    // 先合法处置 A-1/A-2，再把已 confirmed 的 A-1 拿出来重放一次：整批必须拒。
    assert.equal(disposeAssumptionSet(db, { decision_id: 'd-as', actor: 'alice', at: '2026-11-15T00:00:00Z' }).ok, true);
    const head = chainHead(db);
    const eventCount = count(db, 'SELECT count(*) AS n FROM event');
    const result = disposeAssumptionSet(db, { decision_id: 'd-as', actor: 'alice' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_code, 'cascade_conflict');
    assert.equal(count(db, 'SELECT count(*) AS n FROM event'), eventCount);
    assert.equal(chainHead(db), head);
  });
});

test('C1 负例（db 层）：decision 缺 / 未签 / kind 错 / 已撤 ⇒ 拒且 0 行；不带任何覆盖名单参数', () => {
  const payload = setPayload(['A-1'], [{ spec_id: 'A-1', disposition: 'confirmed' }]);

  withWriteDb((db) => {
    assert.equal(append(db, chain([...baseSeedList(), ...decisionSeedList('d-un', payload, { signed: false })])).ok, true);
    const missing = disposeAssumptionSet(db, { decision_id: 'd-none', actor: 'alice' });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason_code, 'decision_not_signed');
    const notSigned = disposeAssumptionSet(db, { decision_id: 'd-un', actor: 'alice' });
    assert.equal(notSigned.ok, false);
    if (!notSigned.ok) assert.equal(notSigned.reason_code, 'decision_not_signed');
    assert.equal(count(db, 'SELECT count(*) AS n FROM event'), baseSeedList().length + 1);
  });

  withWriteDb((db) => {
    const seeds = chain([
      ...baseSeedList(),
      ...decisionSeedList('d-pl', payload, { decisionKind: 'plan' }),
    ]);
    assert.equal(append(db, seeds).ok, true);
    const result = disposeAssumptionSet(db, { decision_id: 'd-pl', actor: 'alice' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_code, 'not_covered_by_decision');
  });

  withWriteDb((db) => {
    const seeds = chain([...baseSeedList(), ...decisionSeedList('d-rv', payload)]);
    assert.equal(append(db, seeds).ok, true);
    const revoked = chain([seed(9, 'decision.revoked', 'd-rv', { reason: 'withdrawn' })], chainHead(db));
    assert.equal(append(db, revoked).ok, true);
    const result = disposeAssumptionSet(db, { decision_id: 'd-rv', actor: 'alice' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_code, 'cascade_conflict');
  });
});

test('C8 方向一：有效已签 assumption_set 有 dispositions 却缺 disposed 事件 ⇒ verify 红', () => {
  withWriteDb((db) => {
    assert.equal(append(db, assumptionSeeds()).ok, true);
    const result = verify(db);
    assert.equal(result.ok, false);
    assert.ok(
      result.problems.some((problem) => problem.code === 'assumption_disposition_missing' && problem.objectId === 'd-as'),
      `expected assumption_disposition_missing, got ${JSON.stringify(result.problems)}`,
    );
  });
});

test('C8 双向：手改投影行造 confirmed（事件链里没有 disposed）⇒ verify 红', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m2-3-verify-'));
  const db: SdoDatabase = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    assert.equal(append(db, assumptionSeeds()).ok, true);
    db.prepare("UPDATE spec SET status = 'confirmed' WHERE id = 'A-1'").run();
    const result = verify(db);
    assert.equal(result.ok, false);
    assert.ok(result.problems.length > 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C9：条件②不误伤——confirmed 行有有效 decision 支撑 ⇒ assumption_set.signed pass', () => {
  withWriteDb((db) => {
    assert.equal(append(db, assumptionSeeds()).ok, true);
    assert.equal(disposeAssumptionSet(db, { decision_id: 'd-as', actor: 'alice', at: '2026-11-15T00:00:00Z' }).ok, true);
    const pass = reportOf(runCheck(db, { criterion: 'assumption_set.signed', at: '2026-11-15T00:00:00Z' }));
    assert.equal(pass.criterion?.result, 'pass', JSON.stringify(pass.criterion?.reasons));
  });
});

test('C9：有 open 假设 ⇒ fail open_assumption；空集未签 ⇒ fail（不许 na/pass）', () => {
  withWriteDb((db) => {
    assert.equal(append(db, assumptionSeeds()).ok, true);
    const open = reportOf(runCheck(db, { criterion: 'assumption_set.signed' }));
    assert.equal(open.criterion?.result, 'fail');
    assert.ok(open.criterion?.reasons.some((reason) => reason.code === 'open_assumption'));
  });

  withWriteDb((db) => {
    const empty = reportOf(runCheck(db, { criterion: 'assumption_set.signed' }));
    assert.equal(empty.criterion?.result, 'fail');
    assert.ok(empty.criterion?.reasons.some((reason) => reason.code === 'assumption_set_not_signed'));
  });
});

test('C6 撤销级联（db 层）：撤 d-as ⇒ 两行回 open + verify 绿（事件链可复算）', () => {
  withWriteDb((db) => {
    assert.equal(append(db, assumptionSeeds()).ok, true);
    assert.equal(disposeAssumptionSet(db, { decision_id: 'd-as', actor: 'alice', at: '2026-11-15T00:00:00Z' }).ok, true);
    const revoked = chain([seed(9, 'decision.revoked', 'd-as', { reason: 'withdrawn' })], chainHead(db));
    assert.equal(append(db, revoked).ok, true);
    const rows = db.prepare("SELECT id, status FROM spec WHERE kind = 'assumption' ORDER BY id").all() as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      { id: 'A-1', status: 'open' },
      { id: 'A-2', status: 'open' },
    ]);
    const result = verify(db);
    assert.deepEqual(result.problems, []);
  });
});

test('P1 第 1 轮：confirmed 后 append assumption.invalidated ⇒ 网关拒、0 行、status 仍 confirmed（D-078）', () => {
  withWriteDb((db) => {
    assert.equal(append(db, assumptionSeeds()).ok, true);
    assert.equal(disposeAssumptionSet(db, { decision_id: 'd-as', actor: 'alice', at: '2026-11-15T00:00:00Z' }).ok, true);
    const before = chainHead(db);
    const eventsBefore = count(db, 'SELECT count(*) AS n FROM event');
    const forged = chain([seed(95, 'assumption.invalidated', 'A-1', { reason: 'forged rollback' })], before);
    const result = append(db, forged);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'assumption_invalidated_is_derived');
    assert.equal(count(db, 'SELECT count(*) AS n FROM event'), eventsBefore, '拒绝必须 0 行');
    assert.equal(chainHead(db), before);
    const row = db.prepare("SELECT status FROM spec WHERE id = 'A-1'").get() as { status: string };
    assert.equal(row.status, 'confirmed', '已签处置不得被无签名事件撤销');
  });
});

test('P3-② 第 1 轮：同批第二条 insert 撞 event.id ⇒ 整批回滚 0 行（BEGIN IMMEDIATE 事务）', () => {
  withWriteDb((db) => {
    const [first] = chain([
      seed(96, 'decision.valid', 'd-tx', {
        decision_kind: 'intent',
        payload: { kind: 'intent' },
        payload_hash: payloadHashOf({ kind: 'intent' }),
        frontier: 'f-1',
      }),
    ]);
    assert.ok(first !== undefined);
    const second = {
      ...first,
      prev: first.hash,
      hash: computeEventHash({ ...first, prev: first.hash, hash: '' }),
    };
    const eventsBefore = count(db, 'SELECT count(*) AS n FROM event');
    const result = append(db, [first, second]);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'append_conflict');
    assert.equal(count(db, 'SELECT count(*) AS n FROM event'), eventsBefore, '事务内失败必须整批回滚（0 行）');
  });
});

test('P2 第 2 轮（D-081）：旧库残留 assumption.invalidated ⇒ verify 出专门 problem，不是笼统 fold_failed', () => {
  withWriteDb((db) => {
    assert.equal(append(db, assumptionSeeds()).ok, true);
    const before = chainHead(db);
    const legacy = {
      id: 'e-legacy-inv',
      at: '2026-11-14T00:00:00Z',
      actor: 'alice',
      kind: 'assumption.invalidated',
      subject: 'A-1',
      payload: { reason: 'pre-M2 write' },
      caused_by: [] as string[],
      request_id: 'r-legacy-inv',
      prev: before,
      hash: '',
    };
    legacy.hash = computeEventHash(legacy);
    db.prepare(
      'INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(
      legacy.id,
      legacy.at,
      legacy.actor,
      legacy.kind,
      legacy.subject,
      JSON.stringify(legacy.payload),
      JSON.stringify(legacy.caused_by),
      legacy.request_id,
      legacy.prev,
      legacy.hash,
    );
    const report = verify(db);
    assert.equal(report.ok, false);
    const problem = report.problems.find((item) => item.code === 'legacy_assumption_invalidated');
    assert.ok(problem !== undefined, JSON.stringify(report.problems));
    assert.equal(problem.objectId, 'e-legacy-inv');
    assert.match(problem.detail, /derived reading/);
    assert.equal(report.problems.some((item) => item.code === 'fold_failed'), false, '不许笼统 fold 崩');
  });
});

test('P3-① 第 2 轮：已签决策 rejected 在写路径就有可断言码 decision_already_signed、0 行', () => {
  withWriteDb((db) => {
    assert.equal(append(db, assumptionSeeds()).ok, true);
    const before = chainHead(db);
    const rejected = chain([seed(96, 'decision.rejected', 'd-as', { reason: 'try' })], before);
    const result = append(db, rejected);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'decision_already_signed');
    assert.equal(chainHead(db), before);
    const row = db.prepare("SELECT status FROM decision WHERE id = 'd-as'").get() as { status: string };
    assert.equal(row.status, 'valid');
  });
});
