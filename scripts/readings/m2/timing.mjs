/**
 * M2-G · R5：单次签字工具侧耗时（真墙钟 + 注入可见的签名延迟）。
 *
 * 口径（第 1 轮评审裁定）：不冻结时钟；样本 5 条，TTL=0 ⇒ 每条都重新解锁，
 * `unlock_wait` 取真实墙钟差值；用 `signDelayMs` 注入 20ms 让 `sign_ms` 不塌缩成 0。
 * 本读数只覆盖工具侧（unlock 等待 + 签名），**没有人类样本**，因此 verdict 固定 partial：
 * G4“人签中位 ≤10s”在 M2 内不可测，等 M3 影子期的真实使用样本。
 */
import { TEST_ACTOR, TEST_PASSPHRASE, decisionCount, seedClaim, withSignPage } from './helpers.mjs';

const SIGN_DELAY_MS = 20;
const SAMPLE_COUNT = 5;

export async function measureR5() {
  const result = await withSignPage(
    { ttl: '0', signDelayMs: SIGN_DELAY_MS, realClock: true },
    async ({ db, service }) => {
      for (let index = 1; index <= SAMPLE_COUNT; index += 1) {
        seedClaim(db, `TASK-${index}`, `M2G-5-${index}`);
      }
      const samples = [];
      for (let index = 1; index <= SAMPLE_COUNT; index += 1) {
        const item = await service.createRequest({
          decision_kind: 'sign',
          claim_ids: [`claim:M2G-5-${index}`],
          difference: 'v1 写 3 秒，v2 写 2 秒',
          consequence: '将以 v2 为准',
          actor: TEST_ACTOR,
          producer: 'model-1',
          channel: 'ui',
        });
        if (!item.ok) throw new Error(`R5 createRequest failed: ${item.reason_code ?? 'unknown'}`);
        const unlocked = await service.unlock({ actor: TEST_ACTOR, passphrase: TEST_PASSPHRASE });
        if (!unlocked.ok) throw new Error(`R5 unlock failed: ${unlocked.reason_code ?? 'unknown'}`);
        const confirmed = await service.confirm({
          requestId: item.item.id,
          actor: TEST_ACTOR,
          proposition: item.item.proposition,
          payloadHash: item.item.payload_hash,
        });
        if (!confirmed.ok) throw new Error(`R5 confirm failed: ${confirmed.reason_code ?? 'unknown'}`);
        const cost = service.costs().at(-1);
        if (cost === undefined) throw new Error('R5 missing signerd cost receipt');
        samples.push({
          unlock_wait_ms: cost.signerd_unlock_wait_ms,
          sign_ms: cost.sign_ms,
          total_ms: cost.signerd_unlock_wait_ms + cost.sign_ms,
        });
      }
      const totals = samples.map((sample) => sample.total_ms).sort((a, b) => a - b);
      const median = totals[Math.floor(totals.length / 2)] ?? null;
      return {
        design: 'TTL=0；5 条样本，每条 unlock → confirm；真墙钟；signDelayMs 注入',
        injected_delay_ms: SIGN_DELAY_MS,
        samples: samples.length,
        decisions: decisionCount(db),
        per_sample: samples,
        median_total_ms: median,
        median_le_10s: typeof median === 'number' && median <= 10_000,
        unlock_wait_positive_samples: samples.filter((sample) => sample.unlock_wait_ms > 0).length,
        unlock_wait_zero_samples: samples.filter((sample) => sample.unlock_wait_ms === 0).length,
        sign_ms_positive_samples: samples.filter((sample) => sample.sign_ms > 0).length,
        human_samples: 0,
      };
    },
  );

  const measurable =
    result.samples >= 5 &&
    result.decisions === 5 &&
    result.unlock_wait_positive_samples >= 2 &&
    result.unlock_wait_zero_samples < 5 &&
    result.sign_ms_positive_samples >= 5 &&
    result.median_le_10s;
  return {
    id: 'R5',
    question: '单次签字工具侧耗时（unlock_wait + sign）中位 ≤10s；人类样本缺失时诚实 partial',
    command: "node scripts/m2-readings.mjs --only R5",
    measured: result,
    verdict: measurable ? 'partial' : 'fail',
    caveat:
      '数据来源：签字页 confirm → signerd 回执的 signerd_unlock_wait_ms + sign_ms（真墙钟，未冻结时钟；signDelayMs=20 注入使 sign_ms 可观测）。**没有人类样本**：不含人读命题/思考时间，G4“人签中位 ≤10s”在 M2 内不可测量，本行只证明工具侧代理 ≤10s，等 M3 影子期真实使用样本；**22ms 中位含 20ms 注入延迟（injected_delay_ms=20），不是产品耗时**；因此 verdict=partial、overall≤partial。样本设计：TTL=0，5 条各自重新解锁（unlock_wait>0 样本数见 raw）。',
  };
}
