/**
 * M3-3 C1/C2/C3/C5：独立性的真路径（真 signerd、真事件链、注入时钟）。
 *
 * - C1 dual_human：alice 单签 ⇒ verify 红；bob 复签 ⇒ 绿；alice 重放 ⇒ 幂等（0 新事件）。
 * - C2 solo_cooldown：14:59 ⇒ cooldown_active、15:00 ⇒ 过（读 baseline 的分钟数）。
 * - C3 门禁：单签 baseline 的 stage 判定 ⇒ changes_requested + independence_unsatisfied。
 * - C5 verify：删一条 decision.signed / 把 signer 改回同一人 ⇒ 红。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { randomUUID } from 'node:crypto';

import { computeEventHash } from '../../src/core/verify-events.js';
import type { Event } from '../../src/core/fold/types.js';
import { verify } from '../../src/core/verify.js';
import { append, chainHead } from '../../src/db/write.js';
import { previewFreeze, confirmFreeze } from '../../src/db/freeze.js';
import { buildEvent } from '../../src/db/freeze-store.js';
import { judgeStage } from '../../src/db/gate.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { verifyDecisionSignatures } from '../../src/sign/verify.js';
import { counterSignDecision, unlockSigner } from '../../src/sign/decision.js';
import type { SignerdClient } from '../../src/sign/client.js';
import { bootSignerd, TEST_ACTOR, TEST_PASSPHRASE, TEST_PRODUCER, type SignerdRig } from './helpers.js';
import { AT, SESSION, clone, readBaselineFixture, rows } from '../db/baseline-freeze-helpers.js';

const BOB = 'bob';

interface ClockRig {
  readonly db: SdoDatabase;
  readonly client: SignerdRig['client'];
  readonly rig: SignerdRig;
  /** 可推进的 signerd 时钟：回执 at 由它决定（P2-1）。 */
  readonly clock: { t: Date };
}

/**
 * 本地 rig：signerd 时钟可注入（回执 at 可控），并预置 alice/bob 两个 human actor。
 * `withFreezeRig` 用的是真实时钟，无法测冷却边界与“回填 now 无效”。
 */
async function withClockRig(run: (rig: ClockRig) => Promise<void>): Promise<void> {
  const clock = { t: new Date(AT) };
  const rig = await bootSignerd({ now: () => clock.t });
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m3-3-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), TEST_PASSPHRASE);
  try {
    runMigrations(db);
    for (const actor of [TEST_ACTOR, BOB]) {
      db.prepare("INSERT INTO actor (id, kind, display, at) VALUES (?, 'human', ?, ?)").run(
        actor,
        actor,
        AT.toISOString(),
      );
    }
    await unlockSigner(db, rig.client, {
      actor: TEST_ACTOR,
      actor_kind: 'human',
      passphrase: TEST_PASSPHRASE,
      frontier: chainHead(db),
      now: AT,
    });
    await run({ db, client: rig.client, rig, clock });
  } finally {
    db.close();
    await rig.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Frozen {
  readonly hash: string;
  readonly decision_id: string;
}

async function freezeWithAssurance(
  db: SdoDatabase,
  client: SignerdClient,
  assurance: Readonly<Record<string, unknown>>,
  clock: { t: Date } = { t: new Date(AT) },
  revision?: string,
): Promise<Frozen> {
  const input = clone(readBaselineFixture('waterfall.json'));
  if (revision !== undefined) input['id'] = `${String(input['id'])}-${revision}`;
  const baseAssurance = input['assurance'];
  const merged: Record<string, unknown> = {
    ...(baseAssurance !== null && typeof baseAssurance === 'object' ? (baseAssurance as Record<string, unknown>) : {}),
    ...assurance,
  };
  // 值为 undefined 表示“把这个键删掉”（用于构造 assurance.independence 缺失）。
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  input['assurance'] = merged;
  clock.t = new Date(AT);
  const preview = previewFreeze(db, input, SESSION, { now: AT });
  assert.equal(preview.ok, true, preview.ok ? '' : JSON.stringify(preview));
  assert.ok('preview_id' in preview);
  const done = await confirmFreeze(
    db,
    client,
    { preview_id: preview.preview_id, payload_hash: preview.payload_hash },
    SESSION,
    { now: AT },
  );
  assert.equal(done.ok, true, done.ok ? '' : JSON.stringify(done));
  const frozen = rows(db, "SELECT payload FROM event WHERE kind = 'baseline.frozen'")[0];
  const payload = JSON.parse(String(frozen?.['payload'])) as Record<string, unknown>;
  return { hash: preview.hash, decision_id: String(payload['decision_id']) };
}

async function unlockAs(
  db: SdoDatabase,
  client: SignerdClient,
  actor: string,
  at: Date,
  clock?: { t: Date },
): Promise<void> {
  if (clock !== undefined) clock.t = new Date(at);
  const outcome = await unlockSigner(db, client, {
    actor,
    actor_kind: 'human',
    passphrase: TEST_PASSPHRASE,
    frontier: chainHead(db),
    now: at,
  });
  assert.equal(outcome.ok, true, outcome.ok ? '' : JSON.stringify(outcome));
}

async function counterSign(
  db: SdoDatabase,
  client: SignerdClient,
  decisionId: string,
  actor: string,
  at: Date,
  clock?: { t: Date },
) {
  if (clock !== undefined) clock.t = new Date(at);
  const outcome = await counterSignDecision(db, client, {
    decision_id: decisionId,
    actor,
    actor_kind: 'human',
    producer: TEST_PRODUCER,
    frontier: chainHead(db),
    channel: 'ui',
    now: at,
  });
  return outcome;
}

function signedEventIds(db: SdoDatabase, decisionId: string): string[] {
  return rows(db, "SELECT id FROM event WHERE kind = 'decision.signed' AND subject = ? ORDER BY rowid", decisionId).map(
    (row) => String(row['id']),
  );
}

test('C1: dual_human 单签 verify 红；第二个 human 复签后绿；同 actor 重放幂等', async () => {
  await withClockRig(async ({ db, client, rig, clock }) => {
    const frozen = await freezeWithAssurance(db, client, { independence: 'dual_human' }, clock);
    const before = verify(db);
    assert.equal(before.ok, false, '单签的 dual_human 不可能独立');
    assert.ok(
      before.problems.some(
        (problem) => problem.code === 'independence_unsatisfied' && problem.objectId === frozen.decision_id,
      ),
      JSON.stringify(before.problems),
    );

    // 同 actor 重放：幂等返回已有签名，不新增事件。
    await unlockAs(db, client, TEST_ACTOR, new Date(AT.getTime() + 1000), clock);
    const eventsBefore = signedEventIds(db, frozen.decision_id).length;
    const replay = await counterSign(db, client, frozen.decision_id, TEST_ACTOR, new Date(AT.getTime() + 2000), clock);
    assert.equal(replay.ok, true, replay.ok ? '' : JSON.stringify(replay));
    assert.equal(replay.ok === true ? replay.existing : false, true);
    assert.equal(signedEventIds(db, frozen.decision_id).length, eventsBefore, '重放不得新增事件');

    // 第二个不同 human ⇒ 满足。
    await unlockAs(db, client, BOB, new Date(AT.getTime() + 3000), clock);
    const second = await counterSign(db, client, frozen.decision_id, BOB, new Date(AT.getTime() + 4000), clock);
    assert.equal(second.ok, true, second.ok ? '' : JSON.stringify(second));
    const after = verify(db);
    assert.equal(after.ok, true, JSON.stringify(after.problems));
    // P3（第 1 轮）：多签是 D-092 的合法形态，M2 sign 层 verify 不得再判 runtime_inconsistent。
    const legacy = verifyDecisionSignatures(db, { home: rig.paths.home });
    assert.equal(legacy.ok, true, JSON.stringify(legacy.problems));
    // 投影行保持首签（不覆盖）。
    const decisionRow = rows(db, 'SELECT signature FROM decision WHERE id = ?', frozen.decision_id)[0];
    assert.ok(String(decisionRow?.['signature'] ?? '').length > 0);
  });
});

test('C2: solo_cooldown 读 baseline 的 15m，14:59 拒 / 15:00 过', async () => {
  await withClockRig(async ({ db, client, clock }) => {
    const frozen = await freezeWithAssurance(db, client, { independence: 'solo_cooldown(15m)' }, clock);
    const before = signedEventIds(db, frozen.decision_id).length;
    const early = new Date(AT.getTime() + 14 * 60_000 + 59_000);
    await unlockAs(db, client, TEST_ACTOR, new Date(AT.getTime() + 1000), clock);
    const rejected = await counterSign(db, client, frozen.decision_id, TEST_ACTOR, early, clock);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok === false ? rejected.reason_code : '', 'cooldown_active');
    assert.equal(signedEventIds(db, frozen.decision_id).length, before, '冷却未到不得落事件');

    await unlockAs(db, client, TEST_ACTOR, new Date(AT.getTime() + 15 * 60_000 + 1000), clock);
    const passed = await counterSign(db, client, frozen.decision_id, TEST_ACTOR, new Date(AT.getTime() + 15 * 60_000 + 2000), clock);
    assert.equal(passed.ok, true, passed.ok ? '' : JSON.stringify(passed));
    const after = verify(db);
    assert.equal(after.ok, true, JSON.stringify(after.problems));
  });
});

test('C3: 单签 baseline 的 stage 判定 ⇒ changes_requested + independence_unsatisfied', async () => {
  await withClockRig(async ({ db, client, clock }) => {
    const frozen = await freezeWithAssurance(db, client, { independence: 'dual_human' }, clock);
    const entered = buildEvent(
      {
        id: 'ev-entered-SR-M3',
        at: AT.toISOString(),
        actor: TEST_ACTOR,
        kind: 'stage.entered',
        subject: 'SR-M3',
        payload: { stage: 'req', baseline_hash: frozen.hash },
        caused_by: [],
        request_id: 'stage:SR-M3',
      },
      chainHead(db),
    );
    const appended = append(db, [entered]);
    assert.equal(appended.ok, true, appended.message ?? '');
    const judged = judgeStage(db, {
      stage_run_id: 'SR-M3',
      actor: TEST_ACTOR,
      at: new Date(AT.getTime() + 2000).toISOString(),
    });
    assert.equal(judged.ok, true, judged.message ?? judged.reason_code ?? '');
    assert.equal(judged.evaluation?.verdict, 'changes_requested');
    assert.ok(judged.evaluation?.reasons.includes('independence_unsatisfied'), JSON.stringify(judged.evaluation?.reasons));
    const row = rows(db, "SELECT verdict FROM stage_run WHERE id = 'SR-M3'")[0];
    assert.equal(row?.['verdict'], 'changes_requested');
  });
});

test('C3 fail-closed: assurance.independence 缺失/非法 ⇒ 门禁红（不静默放行）', async () => {
  for (const [label, assurance, reason] of [
    ['缺失', { independence: undefined }, 'independence_missing'],
    ['非法', { independence: 'checked' }, 'assurance_invalid'],
  ] as const) {
    await withClockRig(async ({ db, client, clock }) => {
      const frozen = await freezeWithAssurance(db, client, assurance, clock);
      const entered = buildEvent(
        {
          id: `ev-entered-SR-M3-${label}`,
          at: AT.toISOString(),
          actor: TEST_ACTOR,
          kind: 'stage.entered',
          subject: 'SR-M3',
          payload: { stage: 'req', baseline_hash: frozen.hash },
          caused_by: [],
          request_id: `stage:SR-M3-${label}`,
        },
        chainHead(db),
      );
      const appended = append(db, [entered]);
      assert.equal(appended.ok, true, appended.message ?? '');
      const judged = judgeStage(db, {
        stage_run_id: 'SR-M3',
        actor: TEST_ACTOR,
        at: new Date(AT.getTime() + 2000).toISOString(),
      });
      assert.equal(judged.ok, true, judged.message ?? judged.reason_code ?? '');
      assert.equal(judged.evaluation?.verdict, 'changes_requested', `${label} 的 assurance 不得静默放行`);
      assert.ok(judged.evaluation?.reasons.includes(reason), JSON.stringify(judged.evaluation?.reasons));
    });
  }
});

test('C5: 删一条 decision.signed ⇒ verify 红；把 signer 改回同一人 ⇒ verify 红', async () => {
  await withClockRig(async ({ db, client, clock }) => {
    const frozen = await freezeWithAssurance(db, client, { independence: 'dual_human' }, clock);
    await unlockAs(db, client, BOB, new Date(AT.getTime() + 1000), clock);
    const second = await counterSign(db, client, frozen.decision_id, BOB, new Date(AT.getTime() + 2000), clock);
    assert.equal(second.ok, true, second.ok ? '' : JSON.stringify(second));
    assert.equal(verify(db).ok, true);

    const ids = signedEventIds(db, frozen.decision_id);
    assert.equal(ids.length, 2);
    const lastId = ids[1];
    assert.ok(lastId);

    // 模拟“库外篡改”：正常路径被 `event is append-only` 触发器拦住，
    // 这里临时拆掉触发器，证明 verify 仍能从事件重算发现独立性证据被动过。
    db.exec('DROP TRIGGER trg_event_append_only_update; DROP TRIGGER trg_event_append_only_delete;');

    // 改 signer（并重算 hash，保证不是被 hash 校验先抓）：只剩一个不同 signer。
    const eventRow = rows(db, 'SELECT * FROM event WHERE id = ?', lastId)[0];
    assert.ok(eventRow);
    const payload = JSON.parse(String(eventRow['payload'])) as Record<string, unknown>;
    payload['signer'] = TEST_ACTOR;
    const rebuild = {
      id: String(eventRow['id']),
      at: String(eventRow['at']),
      actor: String(eventRow['actor']),
      kind: String(eventRow['kind']),
      subject: String(eventRow['subject']),
      payload,
      caused_by: JSON.parse(String(eventRow['caused_by'])) as string[],
      request_id: String(eventRow['request_id']),
      prev: String(eventRow['prev']),
      hash: '',
    };
    const newHash = computeEventHash(rebuild);
    db.prepare('UPDATE event SET payload = ?, hash = ? WHERE id = ?').run(JSON.stringify(payload), newHash, lastId);
    const tampered = verify(db);
    assert.equal(tampered.ok, false);
    assert.ok(
      tampered.problems.some((problem) => problem.objectId === frozen.decision_id),
      JSON.stringify(tampered.problems),
    );

    // 删一条（删最后一条事件，链仍自洽）⇒ 独立性只剩 1 个 signer。
    db.prepare('DELETE FROM event WHERE id = ?').run(lastId);
    const afterDelete = verify(db);
    assert.equal(afterDelete.ok, false);
    assert.ok(
      afterDelete.problems.some(
        (problem) => problem.code === 'independence_unsatisfied' && problem.objectId === frozen.decision_id,
      ),
      JSON.stringify(afterDelete.problems),
    );
  });
});


test('P1-1: amend 出新版本后，旧 decision 与旧 stage_run 的独立性结论不翻转', async () => {
  await withClockRig(async ({ db, client, clock }) => {
    // B1 = dual_human，两个 human 签名 ⇒ 独立性成立。
    const b1 = await freezeWithAssurance(db, client, { independence: 'dual_human' }, clock);
    await unlockAs(db, client, TEST_ACTOR, new Date(AT.getTime() + 1000), clock);
    const firstSign = await counterSign(db, client, b1.decision_id, TEST_ACTOR, new Date(AT.getTime() + 2000), clock);
    assert.equal(firstSign.ok, true, firstSign.ok ? '' : JSON.stringify(firstSign));
    await unlockAs(db, client, BOB, new Date(AT.getTime() + 3000), clock);
    const secondSign = await counterSign(db, client, b1.decision_id, BOB, new Date(AT.getTime() + 4000), clock);
    assert.equal(secondSign.ok, true, secondSign.ok ? '' : JSON.stringify(secondSign));
    assert.equal(verify(db).ok, true, 'B1 下 dual_human 已满足');

    // 在 B1 上进入 stage 并判定：应通过。
    const entered = buildEvent(
      {
        id: 'ev-entered-SR-M3-P11',
        at: AT.toISOString(),
        actor: TEST_ACTOR,
        kind: 'stage.entered',
        subject: 'SR-M3-P11',
        payload: { stage: 'req', baseline_hash: b1.hash },
        caused_by: [],
        request_id: 'stage:SR-M3-P11',
      },
      chainHead(db),
    );
    assert.equal(append(db, [entered]).ok, true);
    const judgedB1 = judgeStage(db, {
      stage_run_id: 'SR-M3-P11',
      actor: TEST_ACTOR,
      at: new Date(AT.getTime() + 5000).toISOString(),
    });
    assert.equal(judgedB1.ok, true, judgedB1.message ?? judgedB1.reason_code ?? '');
    // 该 stage 的其它判据（readings 等）本来就不满足，这里只关心独立性结论。
    assert.equal(
      judgedB1.evaluation?.reasons.includes('independence_unsatisfied'),
      false,
      JSON.stringify(judgedB1.evaluation?.reasons),
    );
    const reasonsB1 = [...(judgedB1.evaluation?.reasons ?? [])];

    // B2 = solo（更弱）：新版本不应把 B1 的旧结论翻红。
    await unlockAs(db, client, TEST_ACTOR, new Date(AT.getTime() + 60_000), clock);
    const b2 = await freezeWithAssurance(db, client, { independence: 'solo' }, clock, 'b2');
    assert.notEqual(b2.hash, b1.hash);

    const afterAmend = verify(db);
    assert.equal(
      afterAmend.problems.some((problem) => problem.objectId === b1.decision_id),
      false,
      `B1 的独立性结论被 B2 翻转：${JSON.stringify(afterAmend.problems)}`,
    );
    const rejudged = judgeStage(db, {
      stage_run_id: 'SR-M3-P11',
      actor: TEST_ACTOR,
      at: new Date(AT.getTime() + 120_000).toISOString(),
    });
    assert.equal(rejudged.ok, true, rejudged.message ?? rejudged.reason_code ?? '');
    // L1-1：旧 stage_run 的结论必须与 B1 时逐字一致（不随 B2 翻转）。
    assert.deepEqual([...(rejudged.evaluation?.reasons ?? [])], reasonsB1);
    assert.equal(
      rejudged.evaluation?.reasons.includes('independence_unsatisfied'),
      false,
      'B2 的 solo 不应把 SR-M3-P11 的独立性结论变红',
    );
  });
});

test('P2-1: 调用方回填 now 不能绕过冷却（权威时钟 = signerd 回执 signed.at）', async () => {
  await withClockRig(async ({ db, client, clock }) => {
    const frozen = await freezeWithAssurance(db, client, { independence: 'solo_cooldown(15m)' }, clock);
    const before = signedEventIds(db, frozen.decision_id).length;
    const unlockAt = new Date(AT.getTime() + 20 * 60_000);
    await unlockAs(db, client, TEST_ACTOR, unlockAt, clock);
    // signerd 真时钟只走了 60s；调用方谎称 now = 首签 + 20m。
    clock.t = new Date(AT.getTime() + 60_000);
    const bypass = await counterSignDecision(db, client, {
      decision_id: frozen.decision_id,
      actor: TEST_ACTOR,
      actor_kind: 'human',
      producer: TEST_PRODUCER,
      frontier: chainHead(db),
      channel: 'ui',
      now: unlockAt,
    });
    assert.equal(bypass.ok, false);
    assert.equal(bypass.ok === false ? bypass.reason_code : '', 'cooldown_active');
    assert.equal(signedEventIds(db, frozen.decision_id).length, before, '回填 now 不得落第二条签名');
  });
});

test('P2-2: 签名者不在 actor(human) 表里 ⇒ verify 判 independence_unverifiable', async () => {
  await withClockRig(async ({ db, client, clock }) => {
    const frozen = await freezeWithAssurance(db, client, { independence: 'dual_human' }, clock);
    await unlockAs(db, client, TEST_ACTOR, new Date(AT.getTime() + 1000), clock);
    await counterSign(db, client, frozen.decision_id, TEST_ACTOR, new Date(AT.getTime() + 2000), clock);
    await unlockAs(db, client, BOB, new Date(AT.getTime() + 3000), clock);
    await counterSign(db, client, frozen.decision_id, BOB, new Date(AT.getTime() + 4000), clock);
    assert.equal(verify(db).ok, true);

    db.exec('DROP TRIGGER trg_event_append_only_update; DROP TRIGGER trg_event_append_only_delete;');
    const ids = signedEventIds(db, frozen.decision_id);
    const lastId = ids[1];
    assert.ok(lastId);
    const row = rows(db, 'SELECT * FROM event WHERE id = ?', lastId)[0];
    assert.ok(row);
    const payload = JSON.parse(String(row['payload'])) as Record<string, unknown>;
    payload['signer'] = 'mallory'; // 未登记的 actor：不能算独立性证据
    const rebuild = {
      id: String(row['id']),
      at: String(row['at']),
      actor: String(row['actor']),
      kind: String(row['kind']),
      subject: String(row['subject']),
      payload,
      caused_by: JSON.parse(String(row['caused_by'])) as string[],
      request_id: String(row['request_id']),
      prev: String(row['prev']),
      hash: '',
    };
    db.prepare('UPDATE event SET payload = ?, hash = ? WHERE id = ?').run(
      JSON.stringify(payload),
      computeEventHash(rebuild),
      lastId,
    );
    const report = verify(db);
    assert.equal(report.ok, false);
    assert.ok(
      report.problems.some(
        (problem) =>
          problem.code === 'independence_unverifiable' && String(problem.detail).includes('mallory'),
      ),
      JSON.stringify(report.problems),
    );
  });
});


test('第 2 轮 P1：复制已签名事件改 at / 重放同一回执 ⇒ 都被写网关拒', async () => {
  await withClockRig(async ({ db, client, clock }) => {
    const frozen = await freezeWithAssurance(db, client, { independence: 'solo_cooldown(15m)' }, clock);
    assert.equal(verify(db).ok, false, '单签 solo_cooldown 本来就该红');
    const ids = signedEventIds(db, frozen.decision_id);
    assert.equal(ids.length, 1);
    const row = rows(db, 'SELECT * FROM event WHERE id = ?', ids[0])[0];
    assert.ok(row);
    const payload = JSON.parse(String(row['payload'])) as Record<string, unknown>;
    const countEvents = (): number =>
      Number((rows(db, 'SELECT count(*) AS n FROM event')[0] as Record<string, unknown>)['n'] ?? -1);
    const before = countEvents();

    const cloneWith = (at: string): Record<string, unknown> => {
      const event = {
        id: randomUUID(),
        at,
        actor: String(row['actor']),
        kind: String(row['kind']),
        subject: String(row['subject']),
        payload: JSON.parse(JSON.stringify(payload)) as unknown,
        caused_by: [] as string[],
        request_id: `replay-${randomUUID()}`,
        prev: chainHead(db),
        hash: '',
      };
      return { ...event, hash: computeEventHash(event) };
    };

    // ① 复制事件、只把 at 推后 16m（伪造“冷却已过”）：载荷里的 signerd.at 没变 ⇒ 三方一致校验拒。
    const forged = append(db, [cloneWith(new Date(AT.getTime() + 16 * 60_000).toISOString())] as never);
    assert.equal(forged.ok, false);
    if (!forged.ok) assert.equal(forged.reason_code, 'signature_time_mismatch');
    assert.equal(countEvents(), before);

    // ② 同一回执、同一 at、换 event id 重放 ⇒ 回执一次性（signerd_receipt_use 唯一约束）拒。
    const replay = append(db, [cloneWith(String(row['at']))] as never);
    assert.equal(replay.ok, false);
    if (!replay.ok) assert.equal(replay.reason_code, 'signerd_receipt_replayed');
    assert.equal(countEvents(), before);
  });
});

test('第 2 轮 P1-2：append 失败回滚后，同一回执仍可用（占位行在事务内）', async () => {
  await withClockRig(async ({ db, client, clock }) => {
    const frozen = await freezeWithAssurance(db, client, { independence: 'solo_cooldown(15m)' }, clock);
    const signedRow = rows(
      db,
      "SELECT * FROM event WHERE kind = 'decision.signed' AND subject = ? ORDER BY rowid",
      frozen.decision_id,
    )[0];
    assert.ok(signedRow);
    const signedPayload = JSON.parse(String(signedRow['payload'])) as Record<string, unknown>;

    // 重新解锁，为同一 decision 产出一条“尚未使用”的新回执。
    await unlockAs(db, client, TEST_ACTOR, new Date(AT.getTime() + 60_000), clock);
    const signFrontier = chainHead(db);
    const signNonce = `rollback-${randomUUID()}`;
    const fresh = await client.sign({
      actor: TEST_ACTOR,
      actor_kind: 'human',
      producer: TEST_PRODUCER,
      decision_id: frozen.decision_id,
      payload_hash: String(signedPayload['payload_hash']),
      proposition_hash: String(signedPayload['proposition_hash']),
      frontier: signFrontier,
      nonce: signNonce,
      channel: 'cli',
    });
    assert.equal(fresh.ok, true, fresh.ok ? '' : JSON.stringify(fresh));
    if (!fresh.ok) return;
    const freshPayload = {
      payload_hash: String(signedPayload['payload_hash']),
      proposition_hash: String(signedPayload['proposition_hash']),
      frontier: signFrontier,
      nonce: signNonce,
      signature: fresh.signature,
      key_id: fresh.key_id,
      signer: fresh.signer,
      channel: fresh.channel,
      signerd: {
        receipt_id: fresh.receipt_id,
        at: fresh.at,
        unlock_wait_ms: fresh.unlock_wait_ms,
        sign_ms: fresh.sign_ms,
      },
    };
    const build = (id: string): Event => {
      const base: Event = {
        id,
        at: fresh.at,
        actor: 'alice',
        kind: 'decision.signed',
        subject: frozen.decision_id,
        payload: freshPayload,
        caused_by: [],
        request_id: `rollback-${id}`,
        prev: chainHead(db),
        hash: '',
      };
      return { ...base, hash: computeEventHash(base) };
    };

    const countEvents = (): number =>
      Number(rows(db, 'SELECT count(*) AS n FROM event')[0]?.['n'] ?? -1);
    const before = countEvents();
    // 同一批第二条事件 id 与第一条相同 ⇒ INSERT 冲突，事务回滚（claimReceipt 已在事务内插入）。
    const first = build(randomUUID());
    const poisoned = append(db, [first, { ...first }]);
    assert.equal(poisoned.ok, false, '重复 id 的批次必须整批失败');
    assert.equal(countEvents(), before, '失败批次不得留下任何事件');
    const placeholders = rows(
      db,
      'SELECT receipt_id FROM signerd_receipt_use WHERE receipt_id = ?',
      String(fresh.receipt_id),
    );
    assert.equal(placeholders.length, 0, 'claimReceipt 的占位行必须随事务回滚');

    // 同一回执再走一次（不带毒事件）⇒ 必须成功，证明回执没有被失败批次“烧掉”。
    const retried = build(randomUUID());
    const ok = append(db, [retried]);
    assert.equal(ok.ok, true, ok.ok ? '' : JSON.stringify(ok));
    assert.equal(countEvents(), before + 1);
  });
});

test('第 3 轮 P3：直插缺 payload.signerd.at 的 decision.signed ⇒ verify 报 independence_unverifiable', async () => {
  await withClockRig(async ({ db, client, clock }) => {
    const frozen = await freezeWithAssurance(db, client, { independence: 'solo_cooldown(15m)' }, clock);
    const signedRow = rows(
      db,
      "SELECT * FROM event WHERE kind = 'decision.signed' AND subject = ? ORDER BY rowid",
      frozen.decision_id,
    )[0];
    assert.ok(signedRow);
    const payload = JSON.parse(String(signedRow['payload'])) as Record<string, unknown>;
    // 模拟“旧日志/直插”：去掉回执时间（写网关会拒，所以先关触发器直插）。
    const signerd = payload['signerd'];
    assert.ok(typeof signerd === 'object' && signerd !== null);
    const { at: _dropped, ...signerdWithoutAt } = signerd as Record<string, unknown>;
    const stripped = { ...payload, signerd: signerdWithoutAt };
    db.exec('DROP TRIGGER trg_event_append_only_update; DROP TRIGGER trg_event_append_only_delete;');
    const base: Event = {
      id: randomUUID(),
      at: new Date(AT.getTime() + 30 * 60_000).toISOString(),
      actor: 'alice',
      kind: 'decision.signed',
      subject: frozen.decision_id,
      payload: stripped,
      caused_by: [],
      request_id: `direct-${randomUUID()}`,
      prev: chainHead(db),
      hash: '',
    };
    const event: Event = { ...base, hash: computeEventHash(base) };
    db.prepare(
      'INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(
      event.id,
      event.at,
      event.actor,
      event.kind,
      event.subject,
      JSON.stringify(event.payload),
      JSON.stringify(event.caused_by),
      event.request_id,
      event.prev,
      event.hash,
    );
    const report = verify(db);
    assert.equal(report.ok, false);
    assert.ok(
      report.problems.some(
        (problem) => problem.code === 'independence_unverifiable' && problem.objectId === frozen.decision_id,
      ),
      JSON.stringify(report.problems),
    );
  });
});
