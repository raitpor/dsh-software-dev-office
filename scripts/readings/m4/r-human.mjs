/**
 * M4-6 / R-human · 人类签字样本读数（承接 M2 R5 / M3 R4）
 *
 * 口径：只从 `plan/milestone/M4-人类样本.json` 现算——样本数、中位、pass/partial
 * 全部来自样本文件 + 回执对账，不读 M2/M3 报告里的写死值、不造样本。
 * 样本 0 条 ⇒ human_samples:0 且 verdict partial（卡 C4/R4 反例）。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  computeHumanReading,
  DEFAULT_SAMPLES_FILE,
  loadSampleFile,
  readDecisionContext,
  readReceipts,
  renderSamplesMarkdown,
  sampleFileText,
} from './human-samples.mjs';

export const DEFAULT_RECEIPTS_FILE = join(homedir(), '.local', 'state', 'sdo', 'signerd', 'receipts.jsonl');

/** 供测试/单跑的纯函数入口：路径与 decision 上下文都可显式注入。 */
export function measureHumanSamples(options = {}) {
  const sampleFile = options.sampleFile ?? process.env['M4_HUMAN_SAMPLES'] ?? DEFAULT_SAMPLES_FILE;
  const receiptsFile = options.receiptsFile ?? process.env['M4_RECEIPTS_FILE'] ?? DEFAULT_RECEIPTS_FILE;
  const payload = options.samples === undefined ? loadSampleFile(sampleFile) : { samples: options.samples };
  const samples = payload.samples;
  const { receipts } = readReceipts(receiptsFile);
  const receiptMap = new Map(receipts.map((receipt) => [receipt.receipt_id, receipt]));
  const decisionIds = samples.map((sample) => sample.decision_id).filter((id) => typeof id === 'string');
  const context = {
    receipts: receiptMap,
    decisions:
      options.decisions === undefined
        ? readDecisionContext(options.dbPath ?? process.env['SDO_DB_PATH'], options.dbPassphrase ?? process.env['SDO_DB_PASSPHRASE'], decisionIds)
        : options.decisions,
    actors: options.actors ?? null,
  };
  const privacyText = `${sampleFileText(payload)}\n${renderSamplesMarkdown(payload)}`;
  const reading = computeHumanReading(samples, context, {
    privacyText,
    sampleFile,
    receiptsFile,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  });
  const raw = { ...reading.raw, reasons: reading.reasons };
  const dbNote =
    raw.decision_db_available === true
      ? ''
      : ' 库不可读（SDO_DB_PATH / SDO_DB_PASSPHRASE 未设置或打不开）：decision 未核验，按 C1/C2 一律不得 pass，读数显式 partial。';
  const caveat =
    (samples.length === 0
      ? '人类样本 0 条：签署者尚未用 /sign 真流程签字；本读数按 C4 诚实 partial，不用工具侧代理冒充，也不由脚本造样本（M4-6 反例）。'
      : reading.verdict === 'pass'
        ? `人类样本 ${String(raw.humans)} 条 / 不同决策 ${String(raw.distinct_decisions)} 个，中位 total ${String(
            raw.median_total_ms,
          )}ms（样本小，不做显著性结论）。数据来源：真 signerd 回执逐条对账。`
        : `人类样本 ${String(raw.humans)} 条 / 不同决策 ${String(raw.distinct_decisions)} 个（门槛 ${String(
            raw.threshold.humans,
          )}/${String(raw.threshold.distinct_decisions)}）；按 C4 保持 partial，不凑数。`) + dbNote;
  return {
    id: 'R-human',
    question: '人类真流程签字 ≥5 条且不同决策 ≥5 个、中位总时长 ≤10s（M2 R5 / M3 R4 的承接）',
    command: 'node scripts/m4-readings.mjs --only R-human',
    measured: raw,
    verdict: reading.verdict,
    caveat,
  };
}
