/**
 * M3-1 C2/C3/C4/C5/C8 + 第 1 轮评审 P0/P1/P2：写网关鉴权、原子性、对象条件、越权读数。
 *
 * 边界（C5）：链自洽的「直接 INSERT event」无法与网关写入区分（事件信封没有独立签名），
 * 本卡只承诺 `unauthorized_row`——投影表里出现事件日志产不出来的行（必是绕过网关直写）。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import { ACK_KINDS } from '../../src/core/fold/ack.js';
import { REDUCERS } from '../../src/core/fold/registry.js';
import { ACK_ACTION_KINDS, KIND_ACTIONS } from '../../src/core/auth/kind-actions.js';
import { APPEND_CALL_SITES } from '../../src/db/append-actions.js';
import { SUPPORTED_KINDS } from '../../src/db/write-materialize.js';
import { closeDefect, verifyFinding } from '../../src/db/action-objects.js';
import { append, chainHead } from '../../src/db/write.js';
import { computeEventHash } from '../../src/core/verify-events.js';
import { canonicalJson, sha256Hex } from '../../src/core/fold/canonical.js';
import { verify } from '../../src/core/verify.js';
import type { Event } from '../../src/core/fold/types.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { AT, chain, currentState, seed, withCleanWriteDb, withWriteDb } from './append-helpers.js';
import { appendAs, grantFixtureRoster, seedRights } from './append-auth.js';

function events(db: SdoDatabase, seeds: Parameters<typeof chain>[0]): Event[] {
  return chain(seeds, chainHead(db), currentState(db));
}

function eventCount(db: SdoDatabase): number {
  return (db.prepare('SELECT count(*) AS n FROM event WHERE kind NOT IN (\'right.granted\',\'right.revoked\')').get() as { n: number }).n;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

function appendCallFiles(): string[] {
  return sourceFiles(join(process.cwd(), 'src'))
    .map((path) => relative(process.cwd(), path).replaceAll('\\', '/'))
    .filter((file) => file !== 'src/db/write.ts')
    .filter((file) => /\b(?:append|appendAsTool)\s*\(\s*db\b/.test(readFileSync(join(process.cwd(), file), 'utf8')));
}

test('C2/P2-1：append 调用点与 APPEND_CALL_SITES（文件 → kind 集合）一一对应', () => {
  const registered = new Set(APPEND_CALL_SITES.map((site) => site.file));
  assert.deepEqual(appendCallFiles().sort(), [...registered].sort(), '每个 append 调用点都要在 APPEND_CALL_SITES 登记');
  const known = new Set([...Object.keys(REDUCERS), ...Object.keys(ACK_KINDS)]);
  for (const site of APPEND_CALL_SITES) {
    assert.ok(site.kinds.length > 0, `${site.file} 的 kind 集合不能为空`);
    assert.ok(site.reason.length > 0, `${site.file} 需要理由`);
    for (const kind of site.kinds) assert.ok(known.has(kind), `${site.file} 登记了未注册 kind ${kind}`);
    // P3-2（第 2 轮）：实际写出的 kind 必须 ⊆ 登记集合（只认事件 kind 字面量，
    // payload 里的业务字段如 task.kind 不在 known 里，自动忽略）。
    const text = readFileSync(join(process.cwd(), site.file), 'utf8');
    const written = new Set<string>();
    for (const match of text.matchAll(/\bkind:\s*'([a-z_]+(?:\.[a-z_]+)+)'/g)) {
      const kind = match[1] ?? '';
      if (known.has(kind)) written.add(kind);
    }
    for (const kind of written) assert.ok(site.kinds.includes(kind), `${site.file} 实际写出未登记的 kind ${kind}`);
  }
});

test('P0：KIND_ACTIONS 覆盖全部 supported kind（漏一个即 fail-closed）', () => {
  const supported = new Set(Object.keys(SUPPORTED_KINDS));
  const mapped = new Set(Object.keys(KIND_ACTIONS));
  assert.deepEqual([...supported].filter((kind) => !mapped.has(kind)), [], 'supported kind 必须都有动作映射');
  const extras = [...mapped].filter((kind) => !supported.has(kind)).sort();
  assert.deepEqual(extras, [...ACK_ACTION_KINDS].sort(), '映射表只允许多出有业务含义的 ACK kind');
});

test('C3：缺 authz ⇒ no_permission，0 行落库、链头不变', () => {
  withWriteDb((db) => {
    const before = { count: eventCount(db), head: chainHead(db) };
    const result = (append as unknown as (d: unknown, e: unknown) => { ok: boolean; reason_code?: string })(
      db,
      events(db, [seed(1, 'task.created', 'T-1', { seq: 1, title: 'x', kind: 'implement' })]),
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'no_permission');
    assert.equal(eventCount(db), before.count);
    assert.equal(chainHead(db), before.head);
  });
});

test('P0：无权 actor 写 task.created ⇒ 按 kind 映射到 create，no_permission（不能自带动作）', () => {
  withWriteDb((db) => {
    const before = eventCount(db);
    const result = append(db, events(db, [seed(1, 'task.created', 'T-1', { seq: 1, title: 'x', kind: 'implement' }, { actor: 'ghost' })]), {
      session: { actor: 'ghost', actor_kind: 'human' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'no_permission');
    assert.match(result.message ?? '', /event_kind=task\.created action=create/);
    assert.equal(eventCount(db), before);
  });
});

test('P0：空 required 动作（defect.close）也不能写任意 kind——task.created 仍走 create', () => {
  withWriteDb((db) => {
    const task = events(db, [seed(1, 'task.created', 'T-1', { seq: 1, title: 'x', kind: 'implement' }, { actor: 'closer' })]);
    const denied = append(db, task, { session: { actor: 'closer', actor_kind: 'human' } });
    assert.equal(denied.reason_code, 'no_permission');
    // 同一 actor 写 defect.closed 会过矩阵（required 为空）但被对象条件拦住。
    const closed = append(db, events(db, [seed(2, 'defect.closed', 'DEF-X', { verify_run_id: 'VR-X', closed_by: 'closer' }, { actor: 'closer' })]), {
      session: { actor: 'closer', actor_kind: 'human' },
    });
    assert.equal(closed.ok, false);
    assert.equal(closed.reason_code, 'object_condition_failed');
  });
});

test('P1-2：事件 actor 必须等于会话 actor（伪造 ⇒ actor_not_from_session、0 行）', () => {
  withWriteDb((db) => {
    const before = eventCount(db);
    const event = chain([seed(1, 'task.created', 'T-1', { seq: 1, title: 'x', kind: 'implement' }, { actor: 'alice' })]);
    const forged = append(db, event, { session: { actor: 'bob', actor_kind: 'human' } });
    assert.equal(forged.ok, false);
    assert.equal(forged.reason_code, 'actor_not_from_session');
    assert.equal(eventCount(db), before);
  });
});

test('P2-1（第 2 轮）：decision.valid 的自述 actor 不能绕过会话绑定（白名单只留 conflict.detected）', () => {
  withWriteDb((db) => {
    const before = eventCount(db);
    const base = {
      id: 'e-valid-forged',
      at: AT,
      actor: 'model-1',
      kind: 'decision.valid',
      subject: 'd-forged',
      payload: {
        decision_kind: 'intent',
        payload_hash: `sha256:${sha256Hex(canonicalJson({}))}`,
        frontier: 'f-1',
        payload: {},
      },
      request_id: 'req-valid-forged',
      caused_by: [] as string[],
      prev: chainHead(db),
    };
    const forged: Event = { ...base, hash: computeEventHash({ ...base, hash: '' }) };
    const result = append(db, [forged], { session: { actor: 'fixture-root', actor_kind: 'service' } });
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'actor_not_from_session');
    assert.equal(eventCount(db), before);
  });
});

test('P3-3（第 3 轮）：decision.valid.payload.producer 乱填（登记为 human）⇒ invalid_field', () => {
  withWriteDb((db) => {
    const before = eventCount(db);
    const base = {
      id: 'e-valid-bad-producer',
      at: AT,
      actor: 'fixture-root',
      kind: 'decision.valid',
      subject: 'd-bad-producer',
      payload: {
        decision_kind: 'intent',
        payload_hash: `sha256:${sha256Hex(canonicalJson({}))}`,
        frontier: 'f-1',
        payload: {},
        producer: 'human-1',
      },
      request_id: 'req-valid-bad-producer',
      caused_by: [] as string[],
      prev: chainHead(db),
    };
    const forged: Event = { ...base, hash: computeEventHash({ ...base, hash: '' }) };
    const result = append(db, [forged], { session: { actor: 'fixture-root', actor_kind: 'service' } });
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'invalid_field');
    assert.match(result.message ?? '', /producer=human-1 is actor kind human/);
    assert.equal(eventCount(db), before);
  });
});

test('C4：整批原子——同批一条没权 ⇒ 全批回滚、0 行', () => {
  withCleanWriteDb((db) => {
    const before = eventCount(db);
    seedRights(db, [{ actor: 'carol', scope: 'domain:core', right: 'plan' }]);
    // carol 只有 plan@domain（create 够），没有 write@module（claim 不够）。
    const batch = events(db, [
      seed(1, 'task.created', 'T-1', { seq: 1, title: 'x', kind: 'implement' }, { actor: 'carol' }),
      seed(2, 'task.claimed', 'T-1', { owner: 'carol' }, { actor: 'carol' }),
    ]);
    const result = append(db, batch, { session: { actor: 'carol', actor_kind: 'human' } });
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'no_permission');
    assert.equal(result.rolled_back, true);
    assert.equal(eventCount(db), before, '一条没权必须整批回滚');
  });
});

test('P0 sign 收口：decision.valid 必须持该决策作用域的 sign 权', () => {
  withWriteDb((db) => {
    seedRights(db, [{ actor: 'sinner', scope: 'release:current', right: 'sign' }]);
    const intentDecision = events(db, [
      seed(1, 'decision.valid', 'd-intent', { decision_kind: 'intent', payload_hash: 'ph', payload: {}, frontier: 'f' }, { actor: 'sinner' }),
    ]);
    const wrongScope = append(db, intentDecision, { session: { actor: 'sinner', actor_kind: 'human' } });
    assert.equal(wrongScope.ok, false);
    assert.equal(wrongScope.reason_code, 'no_permission');
    assert.match(wrongScope.message ?? '', /action=sign scope=domain:core/);

    seedRights(db, [{ actor: 'sinner', scope: 'domain:core', right: 'sign' }]);
    // A2：seedRights 会 append 授权事件、推进链头，所以重签前要按新链头重建批次。
    const intentAgain = events(db, [
      seed(1, 'decision.valid', 'd-intent', { decision_kind: 'intent', payload_hash: 'ph', payload: {}, frontier: 'f' }, { actor: 'sinner' }),
    ]);
    const ok = append(db, intentAgain, { session: { actor: 'sinner', actor_kind: 'human' } });
    assert.equal(ok.ok, true, JSON.stringify(ok));

    const freezeDecision = events(db, [
      seed(2, 'decision.valid', 'd-freeze', { decision_kind: 'freeze', payload_hash: 'ph2', payload: {}, frontier: 'f2' }, { actor: 'sinner' }),
    ]);
    const freezeOk = append(db, freezeDecision, { session: { actor: 'sinner', actor_kind: 'human' } });
    assert.equal(freezeOk.ok, true, JSON.stringify(freezeOk));
  });
});

test('C8：defect.close 只认本人复验的 pass verify_run（失败 run / 非本人 / 直 append 都拒）', () => {
  withWriteDb((db) => {
    appendAs(db, events(db, [
      seed(1, 'verify.passed', 'VR-PASS', { actor_kind: 'service', actor: 'ci' }),
      seed(2, 'verify.failed', 'VR-FAIL', { actor_kind: 'service', actor: 'ci' }),
      seed(3, 'defect.recorded', 'DEF-1', { criterion_id: 'C-1', kind: 'criterion', severity: 'low' }),
      seed(4, 'defect.recorded', 'DEF-2', { criterion_id: 'C-2', kind: 'criterion', severity: 'low' }),
      seed(5, 'defect.recorded', 'DEF-3', { criterion_id: 'C-3', kind: 'criterion', severity: 'low' }),
      seed(6, 'defect.recorded', 'DEF-4', { criterion_id: 'C-4', kind: 'criterion', severity: 'low' }),
    ]));
    const failedRun = closeDefect(db, { actor: 'ci', actor_kind: 'service' }, { defect_id: 'DEF-2', verify_run_id: 'VR-FAIL', at: AT });
    assert.equal(failedRun.ok, false);
    assert.equal((failedRun as { reason_code: string }).reason_code, 'object_condition_failed');
    const wrongActor = closeDefect(db, { actor: 'alice', actor_kind: 'human' }, { defect_id: 'DEF-3', verify_run_id: 'VR-PASS', at: AT });
    assert.equal(wrongActor.ok, false);
    assert.equal((wrongActor as { reason_code: string }).reason_code, 'object_condition_failed');

    // 直 append 同一动作也必须走网关对象条件（不是 wrapper 的私有检查）。
    const direct = append(db, events(db, [
      seed(7, 'defect.closed', 'DEF-4', { verify_run_id: 'VR-FAIL', closed_by: 'ci' }, { actor: 'ci' }),
    ]), { session: { actor: 'ci', actor_kind: 'service' } });
    assert.equal(direct.ok, false);
    assert.equal(direct.reason_code, 'object_condition_failed');

    const ok = closeDefect(db, { actor: 'ci', actor_kind: 'service' }, { defect_id: 'DEF-1', verify_run_id: 'VR-PASS', at: AT });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const row = db.prepare('SELECT status, closed_by FROM defect WHERE id = ?').get('DEF-1') as { status: string; closed_by: string };
    assert.deepEqual({ ...row }, { status: 'closed', closed_by: 'ci' });
  });
});

test('C8：verify_finding 只认对象 producer（直 append 也拒）', () => {
  withWriteDb((db) => {
    appendAs(db, events(db, [
      seed(1, 'task.created', 'T-1', { seq: 1, title: 'x', kind: 'implement' }),
      seed(2, 'review.recorded', 'REV-1', { task_id: 'T-1', reviewer: 'dave', subject_hash: 'h', subject_producer: 'producer-1', finding: 'f', verdict: 'reproduced' }),
    ]));
    const stranger = verifyFinding(db, { actor: 'alice', actor_kind: 'human' }, { review_id: 'REV-1', at: AT });
    assert.equal(stranger.ok, false);
    assert.equal((stranger as { reason_code: string }).reason_code, 'object_condition_failed');
    const direct = append(db, events(db, [
      seed(3, 'review.finding_verified', 'REV-1', { verified_by: 'alice' }, { actor: 'alice' }),
    ]), { session: { actor: 'alice', actor_kind: 'human' } });
    assert.equal(direct.ok, false);
    assert.equal(direct.reason_code, 'object_condition_failed');
    const producer = verifyFinding(db, { actor: 'producer-1', actor_kind: 'human' }, { review_id: 'REV-1', at: AT });
    assert.equal(producer.ok, true, JSON.stringify(producer));
    const row = db.prepare('SELECT verified_by FROM review WHERE id = ?').get('REV-1') as { verified_by: string };
    assert.equal(row.verified_by, 'producer-1');
  });
});

test('C5：绕过网关直写投影行 ⇒ verify 报 unauthorized_row', () => {
  withWriteDb((db) => {
    appendAs(db, events(db, [seed(1, 'task.created', 'T-1', { seq: 1, title: 'x', kind: 'implement' })]));
    grantFixtureRoster(db);
    db.prepare("INSERT INTO task (id, seq, title, kind, created_by, at) VALUES ('TASK-UP', 999, 'ghost', 'implement', 'ghost', ?)").run(AT);
    const report = verify(db);
    assert.equal(report.ok, false);
    const problem = report.problems.find((p) => p.code === 'unauthorized_row' && p.objectId === 'TASK-UP');
    assert.ok(problem, JSON.stringify(report.problems.filter((p) => p.objectId === 'TASK-UP')));
    assert.equal(problem?.table, 'task');
  });
});

test('P2-2：scope_owns 是部署数据，src/ 不得写它（只允许迁移播种）', () => {
  const offenders = sourceFiles(join(process.cwd(), 'src'))
    .map((path) => relative(process.cwd(), path).replaceAll('\\', '/'))
    .filter((file) => /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+scope_owns/i.test(readFileSync(join(process.cwd(), file), 'utf8')));
  assert.deepEqual(offenders, [], 'scope_owns 是部署数据，只能在迁移/测试夹具里播种；产品代码不得写');
});

test('P2-3/C5：review/defect/attention/baseline 直写也报 unauthorized_row', () => {
  withWriteDb((db) => {
    appendAs(db, events(db, [seed(1, 'task.created', 'T-1', { seq: 1, title: 'x', kind: 'implement' })]));
    grantFixtureRoster(db);
    const write = (sql: string, params: unknown[]): void => {
      db.prepare(sql).run(...(params as never[]));
    };
    write("INSERT INTO review (id, task_id, reviewer, subject_hash, subject_producer, finding, verdict, verified_by, at) VALUES ('REV-UP','T-1','ghost','h','ghost','f','reproduced','ghost',?)", [AT]);
    write("INSERT INTO defect (id, criterion_id, spec_id, task_id, kind, severity, status, at) VALUES ('DEF-UP',NULL,NULL,'T-1','criterion','low','open',?)", [AT]);
    write("INSERT INTO attention (id, task_id, raised_by, question, state, expires_at, at) VALUES ('ATT-UP','T-1','ghost','q?','open',?,?)", [AT, AT]);
    write("INSERT INTO baseline (id, frozen_by, engine_version, criteria_manifest_hash, policy, criteria, gates, thresholds, assurance, prev, direction, hash, at) VALUES ('BL-UP','ghost','sdo-v2','sha256:x','{}','[]','[]','{}','{}',NULL,NULL,'sha256:y',?)", [AT]);
    const report = verify(db);
    for (const [table, id] of [['review', 'REV-UP'], ['defect', 'DEF-UP'], ['attention', 'ATT-UP'], ['baseline', 'BL-UP']] as const) {
      assert.ok(
        report.problems.some((p) => p.code === 'unauthorized_row' && p.table === table && p.objectId === id),
        `missing unauthorized_row for ${table}: ${JSON.stringify(report.problems.filter((p) => p.table === table))}`,
      );
    }
  });
});
