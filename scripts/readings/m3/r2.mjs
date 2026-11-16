/**
 * M3-G R2 · 版本冻结的独立性不成立 ⇒ 门禁红；补第二个签名后同一 stage 复判转绿。
 *
 * 真路径：真 signerd（bootSignerd）+ previewFreeze/confirmFreeze + judgeStage。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootSignerd, TEST_ACTOR, TEST_PASSPHRASE, TEST_PRODUCER } from '../../../lib/test/sign/helpers.js';
import { SESSION, clone, readBaselineFixture } from '../../../lib/test/db/baseline-freeze-helpers.js';
import { openSdoDatabase } from '../../../lib/src/db/open.js';
import { runMigrations } from '../../../lib/src/db/migrate.js';
import { chainHead } from '../../../lib/src/db/write.js';
import { buildEvent } from '../../../lib/src/db/freeze-store.js';
import { previewFreeze, confirmFreeze } from '../../../lib/src/db/freeze.js';
import { counterSignDecision, unlockSigner } from '../../../lib/src/sign/decision.js';
import { judgeStage } from '../../../lib/src/db/gate.js';
import { grantAll, grantFixtureRoster, appendAs } from '../../../lib/test/db/append-auth.js';
import { AT, count, readRow, seedIntent, signRealDecision } from './helpers.mjs';

const BOB = 'bob';
const STAGE_RUN = 'SR-M3G-R2';

function appendEvents(db, events) {
  const result = appendAs(db, events);
  if (!result.ok) throw new Error(`r2 append failed: ${result.reason_code}: ${result.message ?? ''}`);
}

async function seedSignedDecision(db, client, id, kind, payload, signer) {
  await signRealDecision(db, client, { kind, subject: id, value: `${kind} M3-G`, extra: payload, actor: signer });
}

async function withRig(run) {
  const clock = { t: new Date(AT) };
  const rig = await bootSignerd({ ttl: '15', now: () => clock.t });
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m3g-r2-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), 'm3-g-readings-passphrase');
  try {
    runMigrations(db);
    grantFixtureRoster(db);
    db.prepare("INSERT OR IGNORE INTO actor (id, kind, display, at) VALUES (?, 'human', ?, ?)").run(BOB, BOB, AT);
    const unlocked = await unlockSigner(db, rig.client, {
      actor: TEST_ACTOR,
      actor_kind: 'human',
      passphrase: TEST_PASSPHRASE,
      frontier: chainHead(db),
      now: clock.t,
    });
    if (!unlocked.ok) throw new Error(`unlock failed: ${unlocked.reason_code}: ${unlocked.message}`);
    return await run({ db, client: rig.client, clock });
  } finally {
    db.close();
    await rig.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function measureR2() {
  return await withRig(async ({ db, client, clock }) => {
    const baselineInput = clone(readBaselineFixture('waterfall.json'));
    const basis = baselineInput['assurance'] ?? {};
    baselineInput['assurance'] = { ...basis, independence: 'dual_human' };
    const preview = previewFreeze(db, baselineInput, SESSION, { now: new Date(AT) });
    if (!preview.ok) throw new Error(`preview_Freeze failed: ${JSON.stringify(preview)}`);
    const confirmed = await confirmFreeze(
      db,
      client,
      { preview_id: preview.preview_id, payload_hash: preview.payload_hash },
      SESSION,
      { now: clock.t },
    );
    if (!confirmed.ok) throw new Error(`confirmFreeze failed: ${JSON.stringify(confirmed)}`);
    const frozenPayload = JSON.parse(String(readRow(db, "SELECT payload FROM event WHERE kind = 'baseline.frozen'")?.['payload']));
    const freezeDecisionId = String(frozenPayload['decision_id']);

    const intentId = await seedIntent(db, client);
    appendEvents(db, [
      buildEvent(
        {
          id: 'ev-m3g-r2-spec',
          at: AT,
          actor: 'alice',
          kind: 'spec.defined',
          subject: 'SPEC-M3G-R2',
          payload: { kind: 'requirement', intent_id: intentId, clause: 'the system must do X', content_hash: 'h' },
          caused_by: [],
          request_id: 'm3g-r2-spec',
        },
        chainHead(db),
      ),
    ]);
    await seedSignedDecision(db, client, 'D-M3G-R2-SPEC', 'spec_set', { spec_ids: ['SPEC-M3G-R2'] }, 'alice');
    await seedSignedDecision(db, client, 'D-M3G-R2-ASSUME', 'assumption_set', { spec_ids: [] }, 'alice');

    appendEvents(db, [
      buildEvent(
        {
          id: 'ev-m3g-r2-stage',
          at: AT,
          actor: 'alice',
          kind: 'stage.entered',
          subject: STAGE_RUN,
          payload: { stage: 'req', baseline_hash: preview.hash },
          caused_by: [],
          request_id: 'm3g-r2-stage',
        },
        chainHead(db),
      ),
    ]);

    // F3：再冻结一版 solo baseline（B2）成为链头，stage_run 仍绑 B1(dual_human)，
    // 用来区分“按 stage 绑定版本判定”和“偷懒取链头 assurance”。
    const baselineSolo = clone(readBaselineFixture('waterfall.json'));
    const soloBasis = baselineSolo['assurance'] ?? {};
    baselineSolo['id'] = 'bl-waterfall-m3g-b2';
    baselineSolo['assurance'] = { ...soloBasis, independence: 'solo' };
    const previewB2 = previewFreeze(db, baselineSolo, SESSION, { now: new Date(AT) });
    if (!previewB2.ok) throw new Error(`preview B2 failed: ${JSON.stringify(previewB2)}`);
    const unlockedForB2 = await unlockSigner(db, client, {
      actor: TEST_ACTOR,
      actor_kind: 'human',
      passphrase: TEST_PASSPHRASE,
      frontier: chainHead(db),
      now: clock.t,
    });
    if (!unlockedForB2.ok) throw new Error(`unlock B2 failed: ${unlockedForB2.reason_code}: ${unlockedForB2.message}`);
    const confirmedB2 = await confirmFreeze(
      db,
      client,
      { preview_id: previewB2.preview_id, payload_hash: previewB2.payload_hash },
      SESSION,
      { now: clock.t },
    );
    if (!confirmedB2.ok) throw new Error(`confirm B2 failed: ${JSON.stringify(confirmedB2)}`);
    const headBaseline = readRow(db, "SELECT hash FROM baseline ORDER BY at DESC, id DESC LIMIT 1");
    const baselineRowHash = readRow(db, 'SELECT hash FROM baseline WHERE hash = ?', preview.hash);
    const headEqualsB2 = headBaseline?.['hash'] === previewB2.hash;

    const judgedBefore = count(db, "SELECT COUNT(*) FROM event WHERE kind = 'gate.judged'");
    clock.t = new Date(Date.parse(AT) + 60_000);
    const single = judgeStage(db, { stage_run_id: STAGE_RUN, actor: 'alice', at: clock.t.toISOString(), now: clock.t.toISOString() });
    const judgedAfterSingle = count(db, "SELECT COUNT(*) FROM event WHERE kind = 'gate.judged'");
    const singleReasons = single.evaluation?.reasons ?? [];
    const singleSignatureCount = single.ok
      ? readRow(db, "SELECT payload FROM event WHERE kind = 'decision.valid' AND subject = 'D-M3G-R2-SPEC'")?.['payload']
      : null;
    void singleSignatureCount;

    const unlockedBob = await unlockSigner(db, client, {
      actor: BOB,
      actor_kind: 'human',
      passphrase: TEST_PASSPHRASE,
      frontier: chainHead(db),
      now: clock.t,
    });
    const countersigned = await counterSignDecision(db, client, {
      decision_id: freezeDecisionId,
      actor: BOB,
      actor_kind: 'human',
      producer: TEST_PRODUCER,
      frontier: chainHead(db),
      channel: 'ui',
      now: clock.t,
    });
    clock.t = new Date(Date.parse(AT) + 120_000);
    const both = judgeStage(db, { stage_run_id: STAGE_RUN, actor: 'alice', at: clock.t.toISOString(), now: clock.t.toISOString() });
    const judgedAfterBoth = count(db, "SELECT COUNT(*) FROM event WHERE kind = 'gate.judged'");
    const signedEvents = db
      .prepare("SELECT payload FROM event WHERE kind = 'decision.signed' AND subject = ?")
      .all(freezeDecisionId)
      .map((row) => JSON.parse(String(row['payload'])));
    const signers = new Set(signedEvents.map((item) => item['signer']).filter((value) => typeof value === 'string')).size;

    const singleEventRow = single.event_id ? readRow(db, 'SELECT id, kind FROM event WHERE id = ?', single.event_id) : undefined;
    const doubleEventRow = both.event_id ? readRow(db, 'SELECT id, kind FROM event WHERE id = ?', both.event_id) : undefined;
    const freezeDecisionRow = readRow(db, 'SELECT id FROM decision WHERE id = ?', freezeDecisionId);
    const singleRed =
      single.ok === true &&
      single.evaluation?.verdict === 'changes_requested' &&
      singleReasons.includes('independence_unsatisfied');
    const bothGreen = both.ok === true && both.evaluation?.verdict === 'pass';
    const measured = {
      baseline_hash: preview.hash,
      baseline_row_hash: baselineRowHash?.['hash'] ?? null,
      baseline_row_hash_matches_preview: baselineRowHash?.['hash'] === preview.hash,
      second_baseline_hash: previewB2.hash,
      chain_head_baseline_hash: headBaseline?.['hash'] ?? null,
      chain_head_equals_b2: headEqualsB2,
      freeze_decision_id: freezeDecisionId,
      stage_run: STAGE_RUN,
      single_signer_verdict: single.evaluation?.verdict ?? null,
      single_signer_reasons: singleReasons,
      gate_judged_before: judgedBefore,
      gate_judged_after_single: judgedAfterSingle,
      single_gate_judged_event_id: single.event_id ?? null,
      single_gate_judged_event_checked: singleEventRow?.['kind'] === 'gate.judged',
      freeze_decision_row_checked: freezeDecisionRow !== undefined,
      unlock_bob: unlockedBob.ok === true,
      counter_sign_ok: countersigned.ok === true,
      freeze_signers: signers,
      dual_signer_verdict: both.evaluation?.verdict ?? null,
      dual_signer_reasons: both.evaluation?.reasons ?? [],
      gate_judged_after_both: judgedAfterBoth,
      double_gate_judged_event_id: both.event_id ?? null,
      double_gate_judged_event_checked: doubleEventRow?.['kind'] === 'gate.judged',
    };
    const pass =
      singleRed &&
      bothGreen &&
      measured.freeze_signers >= 2 &&
      measured.baseline_row_hash_matches_preview &&
      measured.chain_head_equals_b2 &&
      measured.single_gate_judged_event_checked &&
      measured.freeze_decision_row_checked;
    return {
      id: 'R2',
      question: '版本冻结的独立性不成立（dual_human 缺一个签字）是否门禁红；补齐后同一 stage 复判是否转绿',
      command: 'node scripts/m3-readings.mjs --only R2',
      measured,
      verdict: pass ? 'pass' : 'fail',
      caveat: 'README 里写了独立性判定按 baseline.frozen 事件的 decision_id 取 freeze 决策；单签红判为 changes_requested + independence_unsatisfied。注意：gate.ts 在独立性红时仍会 compile+append 一条 gate.judged（changes_requested），这是实现现状；实测 gate_judged_after_single 如实记录，不按“0 条”预期改写。先用 B1(dual_human) 冻结并绑 stage_run，再冻结 B2(solo) 成为链头后判 B1：若实现偷懒取链头 assurance，单签会误判 pass，本读数即红（已用改 lib 的变异实测）。',
    };
  });
}
