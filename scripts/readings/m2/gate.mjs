/**
 * M2-G · R7：M1 遗留读数复跑——判定已落 stage_run，非平凡。
 */
import { previewFreeze, confirmFreeze } from '../../../lib/src/db/freeze.js';
import { judgeStage } from '../../../lib/src/db/gate.js';
import { append, chainHead } from '../../../lib/src/db/write.js';
import { computeEventHash } from '../../../lib/src/core/verify-events.js';
import { verify } from '../../../lib/src/core/verify.js';
import {
  AT, SESSION, readBaselineFixture, withFreezeRig,
} from '../../../lib/test/db/baseline-freeze-helpers.js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { count, reason } from './helpers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** 真读 M1 读数记录（不是字面常量）：R7 的 M1 对照必须可追溯到生成物。 */
function m1R7Record() {
  const path = join(ROOT, 'plan', 'milestone', 'M1-读数.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const entry = parsed.readings?.R7;
  if (entry === undefined) throw new Error('M1 读数缺少 R7 条目');
  return { verdict: entry.verdict, caveat: entry.caveat, raw: entry.raw };
}

const m1 = m1R7Record();

export async function measureR7() {
  let captured;
  await withFreezeRig(async ({ db, client }) => {
    const input = readBaselineFixture('waterfall.json');
    const preview = await previewFreeze(db, input, SESSION, { now: AT });
    if (preview.ok === false) throw new Error(`R7 preview failed: ${preview.reason_code}`);
    const frozen = await confirmFreeze(
      db,
      client,
      { preview_id: preview.preview_id, payload_hash: preview.payload_hash },
      SESSION,
      { now: AT },
    );
    if (frozen.ok === false) throw new Error(`R7 freeze failed: ${frozen.reason_code}`);
    const prev = chainHead(db);
    const unsigned = {
      id: 'ev-m2g-stage-entered', at: new Date(AT.getTime() + 60_000).toISOString(),
      actor: 'm2g-fixture', kind: 'stage.entered', subject: 'SR-1',
      payload: { stage: 'req', baseline_hash: preview.hash, criteria: [] },
      caused_by: [], request_id: 'rq-m2g-stage', prev, hash: '',
    };
    const entered = append(db, [{ ...unsigned, hash: computeEventHash(unsigned) }]);
    if (!entered.ok) throw new Error(`R7 stage.entered failed: ${entered.message ?? entered.reason_code}`);
    const judged = judgeStage(db, {
      stage_run_id: 'SR-1',
      actor: 'alice',
      at: new Date(AT.getTime() + 120_000).toISOString(),
      now: new Date(AT.getTime() + 180_000),
    });
    const report = verify(db);
    const gateJudgedEvents = count(db, "SELECT count(*) AS n FROM event WHERE kind = 'gate.judged'");
    const judgedRows = count(db, 'SELECT count(*) AS n FROM stage_run WHERE verdict IS NOT NULL');
    captured = {
      id: 'R7',
      question: 'M1 遗留 R7 复跑：gate.judged 行与 stage_run 已判行一致，verify 能对账（M1 时表不存在 ⇒ partial）',
      command: "node scripts/m2-readings.mjs --only R7",
      measured: {
        m1_verdict: m1.verdict,
        m1_reason: m1.caveat,
        m1_measured: m1.raw,
        m2_result: reason(judged),
        gate_judged_events: gateJudgedEvents,
        judged_stage_run_rows: judgedRows,
        verify_ok: report.ok,
        verify_problems: report.problems.length,
      },
      verdict:
        reason(judged) === 'ok' && gateJudgedEvents === 1 && judgedRows === 1 && report.ok ? 'pass' : 'fail',
      caveat:
        '数据来源：真冻结核事务 → stage.entered → M2-2 门禁真路径 judgeStage（非测试直插）；gate.judged 事件数与 stage_run 判定行数分别查库。M1 读数 ⑦ partial 的原因保留在此对照。',
    };
  });
  return captured;
}
