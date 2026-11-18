#!/usr/bin/env node
/**
 * M4-6 · 人类签字样本采集器（只读回执 + 只读库；不造样本）
 *
 * 用法（不注册 npm alias：package.json 在 M4-7 写域，卡里记 D-211）：
 *   node scripts/readings/m4/sample-cli.mjs --add --decision <decision_id>
 *   node scripts/readings/m4/sample-cli.mjs --verify
 *   node scripts/readings/m4/sample-cli.mjs --list
 *
 * 环境：SDO_DB_PATH / SDO_DB_PASSPHRASE 用于确认 decision 存在且 signature 非空；
 *       --receipts / --samples / --db 可显式覆盖（测试用）。
 *
 * 纪律（卡 C3）：不接受任何时长参数（sign_ms/unlock_wait_ms 一律从回执现算），
 * 发现 `--inject-delay` 之类的注入参数直接拒绝。
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  computeHumanReading,
  DEFAULT_SAMPLES_FILE,
  loadSampleFile,
  readDecisionContext,
  readReceipts,
  renderSamplesMarkdown,
  reconcileSample,
  sampleFromReceipt,
  sampleFileText,
  validateShape,
  writeSampleFile,
} from './human-samples.mjs';

const DEFAULT_RECEIPTS_FILE = join(homedir(), '.local', 'state', 'sdo', 'signerd', 'receipts.jsonl');
const FORBIDDEN_FLAGS = new Set(['--inject-delay', '--sign-ms', '--unlock-wait-ms', '--inject']);

function parseArgs(argv) {
  const options = { mode: undefined, decision: undefined, receipts: DEFAULT_RECEIPTS_FILE, samples: DEFAULT_SAMPLES_FILE, db: process.env['SDO_DB_PATH'], interactions: 1, note: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (FORBIDDEN_FLAGS.has(arg)) {
      throw new Error(`不接受注入参数：${arg}（样本时长只能从 signerd 回执现算，卡 C3）`);
    }
    if (arg === '--add' || arg === '--verify' || arg === '--list') {
      options.mode = arg.slice(2);
      continue;
    }
    const value = () => {
      index += 1;
      const next = argv[index];
      if (next === undefined) throw new Error(`${arg} 需要一个值`);
      return next;
    };
    if (arg === '--decision') options.decision = value();
    else if (arg === '--receipts') options.receipts = value();
    else if (arg === '--samples') options.samples = value();
    else if (arg === '--db') options.db = value();
    else if (arg === '--interactions') options.interactions = Number(value());
    else if (arg === '--note') options.note = value();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.mode === undefined) throw new Error('需要 --add / --verify / --list 之一');
  if (options.mode === 'add' && (typeof options.decision !== 'string' || options.decision.length === 0)) {
    throw new Error('--add 需要 --decision <decision_id>（由人签完后录入，不接受脚本自造）');
  }
  return options;
}

function context(options, decisionIds) {
  const decisionContext = readDecisionContext(options.db, process.env['SDO_DB_PASSPHRASE'], decisionIds);
  return {
    receipts: new Map(readReceipts(options.receipts).receipts.map((receipt) => [receipt.receipt_id, receipt])),
    decisions: decisionContext?.decisions ?? null,
    actors: decisionContext?.actors ?? null,
  };
}

function latestReceiptFor(receipts, decisionId) {
  return receipts
    .filter((receipt) => receipt.decision_id === decisionId && receipt.consumed !== false)
    .sort((left, right) => String(left.at).localeCompare(String(right.at)))
    .at(-1);
}

function add(options) {
  const sampleFile = loadSampleFile(options.samples);
  if (sampleFile.samples.some((sample) => sample.decision_id === options.decision)) {
    process.stdout.write(`${JSON.stringify({ ok: true, created: false, reason: 'already_sampled', samples: sampleFile.samples.length })}\n`);
    return;
  }
  if (!existsSync(options.receipts)) throw new Error(`回执文件不存在：${options.receipts}`);
  const receipts = readReceipts(options.receipts);
  const receipt = latestReceiptFor(receipts.receipts, options.decision);
  if (receipt === undefined) throw new Error(`decision ${options.decision} 没有可认领的 signerd 回执（先用人真流程签，再采集；脚本不造）`);
  const decisionContext = readDecisionContext(options.db, process.env['SDO_DB_PASSPHRASE'], [options.decision]);
  if (decisionContext === null) throw new Error('需要可读的 SDO 库（SDO_DB_PATH / SDO_DB_PASSPHRASE）来确认 decision 存在且已签');
  const decision = decisionContext.decisions.get(options.decision);
  if (decision === undefined) throw new Error(`decision ${options.decision} 不在库中`);
  const sample = sampleFromReceipt({
    receipt,
    decision: { id: options.decision, signature: decision.signature, signer: decision.signer },
    interactions: Number.isInteger(options.interactions) && options.interactions > 0 ? options.interactions : 1,
    note: options.note,
  });
  const shape = validateShape(sample, 0);
  if (shape.length > 0) throw new Error(`样本形状不合法：${shape.map((problem) => problem.message).join('; ')}`);
  const reconciliation = reconcileSample(sample, { receipts: new Map([[receipt.receipt_id, receipt]]), decisions: decisionContext.decisions, actors: decisionContext.actors });
  if (reconciliation.length > 0) throw new Error(`回执对账失败：${reconciliation.map((problem) => problem.message).join('; ')}`);
  const samples = [...sampleFile.samples, sample];
  writeSampleFile(options.samples, samples);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      created: true,
      sample_id: sample.sample_id,
      decision_id: sample.decision_id,
      receipt_id: sample.receipt_id,
      sign_ms: sample.sign_ms,
      unlock_wait_ms: sample.unlock_wait_ms,
      samples: samples.length,
      file: options.samples,
    })}\n`,
  );
}

function verify(options) {
  const payload = loadSampleFile(options.samples);
  const samples = payload.samples;
  const ctx = context(options, samples.map((sample) => sample.decision_id));
  const reading = computeHumanReading(samples, ctx, {
    privacyText: `${sampleFileText(payload)}\n${renderSamplesMarkdown(payload)}`,
    sampleFile: options.samples,
    receiptsFile: options.receipts,
  });
  const problems = [
    ...(samples.length > 0 && reading.raw.decision_db_available !== true
      ? ['decision_db_unavailable：不可读库时 decision 未核验，C1/C2 不成立（设置 SDO_DB_PATH / SDO_DB_PASSPHRASE）']
      : []),
    ...reading.raw.privacy_hits.map((hit) => `privacy:${hit}`),
    ...reading.raw.invalid.flatMap((entry) => entry.problems.map((problem) => `${entry.sample_id}: ${problem.message}`)),
  ];
  process.stdout.write(
    `${JSON.stringify({ ok: problems.length === 0, samples: samples.length, problems, reading: reading.raw }, null, 2)}\n`,
  );
  process.exitCode = problems.length === 0 ? 0 : 1;
}

function list(options) {
  const payload = loadSampleFile(options.samples);
  process.stdout.write(
    `${JSON.stringify({ samples: payload.samples.length, file: options.samples, ids: payload.samples.map((sample) => sample.sample_id) })}\n`,
  );
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === 'add') add(options);
  else if (options.mode === 'verify') verify(options);
  else list(options);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
