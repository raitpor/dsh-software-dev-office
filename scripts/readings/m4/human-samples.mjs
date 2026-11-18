/**
 * M4-6 · 人类签字样本：读取 / 校验 / 对账 / 现算（卡 plan/cards/M4-6.md）
 *
 * 纪律（卡 C1–C6）：
 * - 样本只来自**真流程**（signerd 回执 + 真 decision），脚本不造样本、不接受注入时长；
 * - `sign_ms`/`unlock_wait_ms` 必须与回执逐字段一致，否则该条 invalid（不是“手改后仍算”）；
 * - `injected_delay_ms` 存在 ⇒ contaminated:true，不进中位、不计 human_samples；
 * - 文件里出现口令/key/token/socket 路径 ⇒ privacy_hits，读数 fail。
 *
 * 样本文件是**测量数据**，不进 baseline、不进事件链（S30 第 6 条）。
 */
import Database from 'better-sqlite3-multiple-ciphers';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../../..');

export const SAMPLES_VERSION = 'sdo-human-samples-v1';
export const HUMANS_THRESHOLD = 5;
export const DISTINCT_DECISIONS_THRESHOLD = 5;
export const DEFAULT_SAMPLES_FILE = join(ROOT, 'plan', 'milestone', 'M4-人类样本.json');
export const SAMPLE_FIELDS = [
  'sample_id',
  'at',
  'decision_id',
  'receipt_id',
  'unlock_wait_ms',
  'sign_ms',
  'interactions',
  'signer_kind',
  'note',
];

/** 隐私正则：口令、密钥材料、token、socket 路径、本机 home 路径。 */
const PRIVACY_PATTERNS = [
  { code: 'passphrase', pattern: /passphrase/i },
  { code: 'private_key', pattern: /BEGIN [A-Z ]*PRIVATE KEY/ },
  { code: 'key_material', pattern: /\b(private[_-]?key|api[_-]?token|access[_-]?token|token)\b/i },
  { code: 'socket_path', pattern: /\.sock\b/ },
  { code: 'home_path', pattern: /(?:\/home\/|\/Users\/)/ },
];

export function median(numbers) {
  const sorted = numbers.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function emptySampleFile(at = new Date().toISOString()) {
  return { version: SAMPLES_VERSION, samples: [], updated_at: at, note: '人类样本尚未采集（M4-6）；由签署者本人用 /sign 真流程签字后由采集器认领。' };
}

export function loadSampleFile(file = DEFAULT_SAMPLES_FILE) {
  if (!existsSync(file)) return emptySampleFile();
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.samples)) {
    throw new Error(`样本文件结构无效（需要 {samples:[...]}）：${file}`);
  }
  return { version: parsed.version ?? SAMPLES_VERSION, samples: parsed.samples, ...(parsed.note === undefined ? {} : { note: parsed.note }) };
}

export function sampleFileText(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function renderSamplesMarkdown(payload) {
  const samples = Array.isArray(payload.samples) ? payload.samples : [];
  const lines = [
    '# M4 人类签字样本（M4-6）',
    '',
    '- 样本只来自真 signerd 回执 + 真 decision；脚本不造样本、不接受注入时长。',
    '- 本文件是测量数据，不进 baseline、不进事件链（S30 第 6 条）。',
    `- updated_at: ${payload.updated_at ?? '—'}`,
    `- samples: ${String(samples.length)}`,
    '',
    '| sample_id | at | decision_id | receipt_id | unlock_wait_ms | sign_ms | interactions | note |',
    '|---|---|---|---|---:|---:|---:|---|',
  ];
  for (const sample of samples) {
    lines.push(
      `| ${String(sample.sample_id ?? '')} | ${String(sample.at ?? '')} | ${String(sample.decision_id ?? '')} | ${String(
        sample.receipt_id ?? '',
      )} | ${String(sample.unlock_wait_ms ?? '')} | ${String(sample.sign_ms ?? '')} | ${String(
        sample.interactions ?? '',
      )} | ${String(sample.note ?? '')} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function writeSampleFile(file, samples, at = new Date().toISOString()) {
  const payload = { version: SAMPLES_VERSION, samples, updated_at: at };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, sampleFileText(payload), 'utf8');
  writeFileSync(file.replace(/\.json$/u, '.md'), renderSamplesMarkdown(payload), 'utf8');
  return payload;
}

export function readReceipts(file) {
  if (!existsSync(file)) return { receipts: [], problems: [`回执文件不存在：${file}`] };
  const receipts = [];
  const problems = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    const text = line.trim();
    if (text.length === 0) return;
    try {
      const receipt = JSON.parse(text);
      if (receipt !== null && typeof receipt === 'object' && typeof receipt.receipt_id === 'string') receipts.push(receipt);
      else problems.push(`回执第 ${String(index + 1)} 行缺少 receipt_id`);
    } catch (error) {
      problems.push(`回执第 ${String(index + 1)} 行不是 JSON：${String(error)}`);
    }
  });
  return { receipts, problems };
}

export function scanPrivacy(text) {
  return PRIVACY_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ code }) => code);
}

function isMillis(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function validateShape(sample, index) {
  const problems = [];
  const prefix = `samples[${String(index)}]`;
  if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) {
    return [{ code: 'shape_invalid', message: `${prefix} 必须是对象` }];
  }
  for (const field of SAMPLE_FIELDS) {
    if (!(field in sample)) problems.push({ code: 'field_missing', message: `${prefix}.${field} 缺失` });
  }
  if (typeof sample.sample_id !== 'string' || sample.sample_id.length === 0) {
    problems.push({ code: 'sample_id_invalid', message: `${prefix}.sample_id 必须是非空字符串` });
  }
  if (typeof sample.at !== 'string' || !Number.isFinite(Date.parse(sample.at))) {
    problems.push({ code: 'at_invalid', message: `${prefix}.at 必须是可解析时间` });
  }
  if (typeof sample.decision_id !== 'string' || sample.decision_id.length === 0) {
    problems.push({ code: 'decision_id_invalid', message: `${prefix}.decision_id 必须是非空字符串` });
  }
  if (typeof sample.receipt_id !== 'string' || sample.receipt_id.length === 0) {
    problems.push({ code: 'receipt_id_invalid', message: `${prefix}.receipt_id 必须是非空字符串` });
  }
  if (!isMillis(sample.unlock_wait_ms)) problems.push({ code: 'unlock_wait_ms_invalid', message: `${prefix}.unlock_wait_ms 必须是 ≥0 毫秒` });
  if (!isMillis(sample.sign_ms)) problems.push({ code: 'sign_ms_invalid', message: `${prefix}.sign_ms 必须是 ≥0 毫秒` });
  if (typeof sample.interactions !== 'number' || !Number.isInteger(sample.interactions) || sample.interactions < 1) {
    problems.push({ code: 'interactions_invalid', message: `${prefix}.interactions 必须是 ≥1 的整数` });
  }
  if (sample.signer_kind !== 'human') problems.push({ code: 'signer_kind_invalid', message: `${prefix}.signer_kind 必须是 'human'` });
  if (typeof sample.note !== 'string') problems.push({ code: 'note_invalid', message: `${prefix}.note 必须是字符串` });
  return problems;
}

/**
 * 对账上下文：
 *   decisions: Map<id, {signature, signer}> 或 null（读不到库时只做回执对账）
 *   receipts:  Map<receipt_id, receipt>
 *   actors:    Map<actor_id, kind> 或 null
 */
export function reconcileSample(sample, context) {
  const problems = [];
  if (typeof sample.decision_id !== 'string' || typeof sample.receipt_id !== 'string') {
    return [{ code: 'shape_invalid', message: '缺少 decision_id/receipt_id，无法对账' }];
  }
  if (context.decisions !== null) {
    const decision = context.decisions.get(sample.decision_id);
    if (decision === undefined) problems.push({ code: 'decision_missing', message: `decision ${sample.decision_id} 不在库中` });
    else if (typeof decision.signature !== 'string' || decision.signature.length === 0) {
      problems.push({ code: 'decision_unsigned', message: `decision ${sample.decision_id} 的 signature 为空` });
    } else {
      const receipt = context.receipts.get(sample.receipt_id);
      if (receipt !== undefined && typeof receipt['signature'] === 'string' && receipt['signature'] !== decision.signature) {
        problems.push({ code: 'signature_mismatch', message: `样本 ${sample.sample_id} 的回执签名与 decision.signature 不一致` });
      }
      if (context.actors !== null) {
        const kind = context.actors.get(decision.signer);
        if (kind !== undefined && kind !== 'human') {
          problems.push({ code: 'signer_not_human', message: `decision ${sample.decision_id} 的 signer ${decision.signer} 是 ${kind}，不是 human` });
        }
      }
    }
  }
  const receipt = context.receipts.get(sample.receipt_id);
  if (receipt === undefined) {
    problems.push({ code: 'receipt_missing', message: `样本 ${sample.sample_id} 的 receipt ${sample.receipt_id} 不在回执文件里` });
  } else {
    if (receipt['decision_id'] !== sample.decision_id) {
      problems.push({ code: 'receipt_decision_mismatch', message: `回执 ${sample.receipt_id} 的 decision 是 ${String(receipt['decision_id'])}` });
    }
    if (receipt['sign_ms'] !== sample.sign_ms) {
      problems.push({ code: 'sign_ms_mismatch', message: `样本 sign_ms=${String(sample.sign_ms)} ≠ 回执 ${String(receipt['sign_ms'])}` });
    }
    if (receipt['unlock_wait_ms'] !== sample.unlock_wait_ms) {
      problems.push({ code: 'unlock_wait_ms_mismatch', message: `样本 unlock_wait_ms=${String(sample.unlock_wait_ms)} ≠ 回执 ${String(receipt['unlock_wait_ms'])}` });
    }
  }
  return problems;
}

export function isContaminated(sample) {
  const injected = sample['injected_delay_ms'];
  return (typeof injected === 'number' && injected > 0) || sample['contaminated'] === true;
}

/**
 * 全量校验 → { valid, contaminated, invalid, privacy_hits }。
 * valid = 形状+对账都过，且未被注入污染。
 */
export function validateSamples(samples, context, { privacyText = undefined } = {}) {
  const valid = [];
  const contaminated = [];
  const invalid = [];
  const privacy_hits = privacyText === undefined ? [] : scanPrivacy(privacyText);
  samples.forEach((sample, index) => {
    const shape = validateShape(sample, index);
    if (shape.length > 0) {
      invalid.push({ sample_id: sample?.sample_id ?? `samples[${String(index)}]`, problems: shape });
      return;
    }
    if (isContaminated(sample)) {
      contaminated.push(sample);
      return;
    }
    const problems = reconcileSample(sample, context);
    if (problems.length > 0) invalid.push({ sample_id: sample.sample_id, problems });
    else valid.push(sample);
  });
  return { valid, contaminated, invalid, privacy_hits };
}

function projection(valid, sufficient) {
  const totals = valid.map((sample) => sample.unlock_wait_ms + sample.sign_ms);
  const medianTotal = median(totals);
  return {
    human_samples: valid.length,
    distinct_decisions: new Set(valid.map((sample) => sample.decision_id)).size,
    median_total_ms: medianTotal,
    median_le_10s: medianTotal !== null && medianTotal <= 10_000,
    sufficient,
  };
}

/** 由样本文件现算读数（C4/C5）：不读 M2/M3 报告的写死值，只读样本 + 回执/库对账。 */
export function computeHumanReading(samples, context, options = {}) {
  const { privacyText = undefined, generatedAt = new Date().toISOString() } = options;
  const result = validateSamples(samples, context, { privacyText });
  // P1：库不可用 ⇒ decision 无法核验，C1/C2 不得视为满足——一律不得 pass，humans 归 0。
  const decisionDbAvailable = context.decisions !== null;
  const verified = decisionDbAvailable ? result.valid : [];
  const humans = verified.length;
  const humansUnverified = decisionDbAvailable ? 0 : result.valid.length;
  const distinct = new Set(verified.map((sample) => sample.decision_id)).size;
  const sufficient = decisionDbAvailable && humans >= HUMANS_THRESHOLD && distinct >= DISTINCT_DECISIONS_THRESHOLD;
  const base = projection(verified, sufficient);
  const medianSign = median(verified.map((sample) => sample.sign_ms));
  const reasons = [];
  if (result.privacy_hits.length > 0) reasons.push(`privacy:${result.privacy_hits.join(',')}`);
  if (result.invalid.length > 0) reasons.push(`invalid:${String(result.invalid.length)}`);
  if (result.contaminated.length > 0) reasons.push(`contaminated:${String(result.contaminated.length)}`);
  if (!decisionDbAvailable) reasons.push('decision_db_unavailable');
  if (!sufficient) reasons.push('insufficient_human_samples');
  let verdict;
  if (result.privacy_hits.length > 0 || result.invalid.length > 0) verdict = 'fail';
  else if (!decisionDbAvailable || result.contaminated.length > 0 || !sufficient) verdict = 'partial';
  else verdict = 'pass';
  const raw = {
    sample_file: options.sampleFile ?? DEFAULT_SAMPLES_FILE,
    receipts_file: options.receiptsFile ?? null,
    generatedAt,
    samples_total: samples.length,
    humans,
    humans_unverified: humansUnverified,
    distinct_decisions: distinct,
    threshold: { humans: HUMANS_THRESHOLD, distinct_decisions: DISTINCT_DECISIONS_THRESHOLD },
    sufficient,
    contaminated: result.contaminated.map((sample) => sample.sample_id),
    invalid: result.invalid,
    privacy_hits: result.privacy_hits,
    median_sign_ms: medianSign,
    median_total_ms: base.median_total_ms,
    median_le_10s: base.median_le_10s,
    m2_r5: {
      human_samples: humans,
      median_total_ms: base.median_total_ms,
      median_le_10s: base.median_le_10s,
      verdict: sufficient ? 'pass' : 'partial',
    },
    m3_r4: {
      human_samples: humans,
      sufficient,
      verdict: sufficient ? 'pass' : 'partial',
    },
    decision_db_available: decisionDbAvailable,
  };
  return { raw, verdict, reasons, valid: result.valid };
}

/**
 * 只读打开加密库，取 decision 与 actor kind（采集器/读数共用）。
 * 失败返回 null（由调用方决定是否 fail），不写库、不改 `src/`。
 */
export function readDecisionContext(dbPath, passphrase, decisionIds) {
  if (typeof dbPath !== 'string' || dbPath.length === 0) return null;
  if (typeof passphrase !== 'string' || passphrase.length === 0) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma("cipher='sqlcipher'");
    db.pragma('legacy=4');
    db.key(Buffer.from(passphrase, 'utf8'));
    const decisions = new Map();
    const actors = new Map();
    const getDecision = db.prepare('SELECT id, signature, signer FROM decision WHERE id = ?');
    const getActor = db.prepare('SELECT id, kind FROM actor WHERE id = ?');
    for (const id of new Set(decisionIds)) {
      const row = getDecision.get(id);
      if (row !== undefined) decisions.set(String(row.id), { signature: String(row.signature), signer: String(row.signer) });
      const actor = getActor.get(row === undefined ? '' : String(row.signer));
      if (actor !== undefined) actors.set(String(actor.id), String(actor.kind));
    }
    return { decisions, actors };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // close 失败不掩盖读取结果
    }
  }
}

/** 从回执 + decision 生成一条样本（时长全部取自回执，不接受调用方给时长）。 */
export function sampleFromReceipt({ receipt, decision, interactions = 1, note }) {
  if (receipt === undefined) throw new Error('sampleFromReceipt: receipt 缺失');
  if (decision === undefined) throw new Error('sampleFromReceipt: decision 缺失');
  if (typeof receipt.signature === 'string' && receipt.signature !== decision.signature) {
    throw new Error('sampleFromReceipt: 回执签名与 decision.signature 不一致');
  }
  return {
    sample_id: `human-${String(receipt.receipt_id).replace(/^rcpt:/u, '').slice(0, 16)}`,
    at: receipt.at,
    decision_id: decision.id,
    receipt_id: receipt.receipt_id,
    unlock_wait_ms: receipt.unlock_wait_ms,
    sign_ms: receipt.sign_ms,
    interactions,
    signer_kind: 'human',
    note: note ?? '',
  };
}
