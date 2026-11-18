/**
 * M4-6 · 人类签字样本采集（卡 plan/cards/M4-6.md）
 *
 * 测的是采集/校验/读数机制本身：结构、回执对账、注入排除、门槛、中位现算、隐私扫描、
 * 采集器只读回执且拒绝注入参数。样本 0 条时读数必须诚实 partial + human_samples:0。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { openEncryptedDatabase } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LIB = join(ROOT, 'scripts', 'readings', 'm4', 'human-samples.mjs');
const CLI = join(ROOT, 'scripts', 'readings', 'm4', 'sample-cli.mjs');
const SCRIPT = join(ROOT, 'scripts', 'm4-readings.mjs');
const PASS = 'm4-human-test-passphrase';
const AT = '2026-11-16T10:00:00.000Z';

interface Sample {
  sample_id: string;
  at: string;
  decision_id: string;
  receipt_id: string;
  unlock_wait_ms: number;
  sign_ms: number;
  interactions: number;
  signer_kind: 'human';
  note: string;
  injected_delay_ms?: number;
}

interface Receipt {
  receipt_id: string;
  decision_id: string;
  signature: string;
  at: string;
  unlock_wait_ms: number;
  sign_ms: number;
  prev_receipt_hash: string | null;
}

interface HumanModule {
  HUMANS_THRESHOLD: number;
  DISTINCT_DECISIONS_THRESHOLD: number;
  median(values: number[]): number | null;
  scanPrivacy(text: string): string[];
  validateSamples(
    samples: unknown[],
    context: { decisions: Map<string, { signature: string; signer: string }> | null; receipts: Map<string, Receipt>; actors: Map<string, string> | null },
    options?: { privacyText?: string },
  ): { valid: Sample[]; contaminated: Sample[]; invalid: { sample_id: string; problems: { code: string; message: string }[] }[]; privacy_hits: string[] };
  computeHumanReading(
    samples: Sample[],
    context: { decisions: Map<string, { signature: string; signer: string }> | null; receipts: Map<string, Receipt>; actors: Map<string, string> | null },
    options?: { privacyText?: string; sampleFile?: string; receiptsFile?: string; generatedAt?: string },
  ): { raw: Record<string, any>; verdict: string; reasons: string[] };
  writeSampleFile(file: string, samples: Sample[]): { samples: Sample[] };
  renderSamplesMarkdown(payload: { samples: Sample[]; updated_at?: string }): string;
  emptySampleFile(at?: string): { samples: Sample[] };
  readDecisionContext(path: string, passphrase: string, ids: string[]): { decisions: Map<string, { signature: string; signer: string }>; actors: Map<string, string> } | null;
}

const modulePromise = import(LIB) as Promise<HumanModule>;

function sample(index: number, overrides: Partial<Sample> = {}): Sample {
  return {
    sample_id: `human-${String(index)}`,
    at: AT,
    decision_id: `DEC-${String(index)}`,
    receipt_id: `rcpt:${String(index)}`,
    unlock_wait_ms: 100,
    sign_ms: 1000 * index,
    interactions: 1,
    signer_kind: 'human',
    note: '项目所有者用 /sign 真流程签字',
    ...overrides,
  };
}

function receiptsFor(samples: Sample[], overrides: Partial<Receipt> = {}): Map<string, Receipt> {
  return new Map(
    samples.map((entry, index) => [
      entry.receipt_id,
      {
        receipt_id: entry.receipt_id,
        decision_id: entry.decision_id,
        signature: `sig-${String(index)}`,
        at: entry.at,
        unlock_wait_ms: entry.unlock_wait_ms,
        sign_ms: entry.sign_ms,
        prev_receipt_hash: null,
        ...overrides,
      },
    ]),
  );
}

function contextFor(samples: Sample[], options: { actors?: Map<string, string> } = {}) {
  const decisions = new Map(
    samples.map((entry, index) => [entry.decision_id, { signature: `sig-${String(index)}`, signer: 'human-pm' }]),
  );
  return {
    decisions,
    receipts: receiptsFor(samples),
    actors: options.actors ?? new Map([['human-pm', 'human']]),
  };
}

function makeDb(dir: string): { db: ReturnType<typeof openEncryptedDatabase>; path: string } {
  const path = join(dir, 'sdo.db');
  const db = openEncryptedDatabase(path, PASS);
  runMigrations(db);
  db.prepare('INSERT INTO actor (id, kind, display, at) VALUES (?, ?, ?, ?)').run('human-pm', 'human', '项目所有者', AT);
  for (let index = 1; index <= 8; index += 1) {
    db.prepare(
      `INSERT INTO decision (id, decision_kind, status, payload, payload_hash, signature, key_id, signer, frontier, at)
       VALUES (?, 'sign', 'valid', '{}', ?, ?, 'key-1', 'human-pm', 'f-1', ?)`,
    ).run(`DEC-${String(index)}`, `sha256:payload-${String(index)}`, `sig-${String(index)}`, AT);
  }
  return { db, path };
}

describe('M4-6 human samples', () => {
  it('C1 shape + decision exists/signature non-empty：缺 decision / 空签名都判 invalid', async () => {
    const human = await modulePromise;
    const good = sample(1);
    const badDecision = sample(2, { decision_id: 'DEC-missing' });
    const result = human.validateSamples([good, badDecision], {
      decisions: contextFor([good]).decisions,
      receipts: receiptsFor([good, badDecision]),
      actors: new Map([['human-pm', 'human']]),
    });
    assert.deepEqual(result.valid.map((entry) => entry.sample_id), ['human-1']);
    assert.equal(result.invalid.length, 1);
    assert.ok(result.invalid[0]?.problems.some((problem) => problem.code === 'decision_missing'));

    const decisions = new Map([['DEC-1', { signature: '', signer: 'human-pm' }]]);
    const unsigned = human.validateSamples([good], { decisions, receipts: receiptsFor([good]), actors: new Map([['human-pm', 'human']]) });
    assert.ok(unsigned.invalid[0]?.problems.some((problem) => problem.code === 'decision_unsigned'));

    // P1：库不可用 ⇒ decision 无法核验，C1/C2 不得成立（不许“回执看起来合法就 pass”）。
    const receiptsOnly = human.validateSamples([good], { decisions: null, receipts: receiptsFor([good]), actors: null });
    assert.equal(receiptsOnly.valid.length, 1, '回执层面仍合法');
    const unavailable = human.computeHumanReading([good], { decisions: null, receipts: receiptsFor([good]), actors: null });
    assert.equal(unavailable.verdict, 'partial');
    assert.equal(unavailable.raw.humans, 0);
    assert.equal(unavailable.raw.humans_unverified, 1);
    assert.ok(unavailable.reasons.includes('decision_db_unavailable'));
    assert.equal(unavailable.raw.median_total_ms, null, '未核验样本不许计入中位');

    // 真库路径也验证一次（readDecisionContext 只读）。
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4-human-db-'));
    try {
      const { db, path } = makeDb(dir);
      const ctx = human.readDecisionContext(path, PASS, ['DEC-1', 'DEC-2']);
      assert.equal(ctx?.decisions.get('DEC-1')?.signature, 'sig-1');
      assert.equal(ctx?.actors.get('human-pm'), 'human');
      db.close();
    } finally {
      rm(dir);
    }
  });

  it('C2 回执对账：缺回执 / sign_ms 被手改 / unlock_wait 不一致都 invalid', async () => {
    const human = await modulePromise;
    const good = sample(1);
    const missing = human.validateSamples([good], { decisions: contextFor([good]).decisions, receipts: new Map(), actors: new Map([['human-pm', 'human']]) });
    assert.ok(missing.invalid[0]?.problems.some((problem) => problem.code === 'receipt_missing'));

    const tampered = { ...good, sign_ms: good.sign_ms + 1 };
    const mismatch = human.validateSamples([tampered], contextFor([good]));
    assert.ok(mismatch.invalid[0]?.problems.some((problem) => problem.code === 'sign_ms_mismatch'));

    const unlockMismatch = { ...good, unlock_wait_ms: good.unlock_wait_ms + 1 };
    const unlockResult = human.validateSamples([unlockMismatch], contextFor([good]));
    assert.ok(unlockResult.invalid[0]?.problems.some((problem) => problem.code === 'unlock_wait_ms_mismatch'));

    // 回执签名与 decision.signature 不一致
    const forged = sample(1);
    const receipts = receiptsFor([forged], { signature: 'sig-forged' });
    const forgedResult = human.validateSamples([forged], { decisions: new Map([['DEC-1', { signature: 'sig-1', signer: 'human-pm' }]]), receipts, actors: new Map([['human-pm', 'human']]) });
    assert.ok(forgedResult.invalid[0]?.problems.some((problem) => problem.code === 'signature_mismatch'));
  });

  it('C3 注入样本：injected_delay_ms ⇒ contaminated、不计 human_samples/中位；CLI 拒绝 --inject-delay', async () => {
    const human = await modulePromise;
    const clean = [1, 2, 3, 4, 5].map((index) => sample(index));
    const injected = sample(6, { injected_delay_ms: 20 });
    const samples = [...clean.slice(0, 4), injected];
    const result = human.validateSamples(samples, contextFor(samples));
    assert.equal(result.valid.length, 4, '注入样本不得计入有效样本');
    assert.deepEqual(result.contaminated.map((entry) => entry.sample_id), ['human-6']);
    const reading = human.computeHumanReading([...clean, injected], contextFor([...clean, injected]));
    assert.equal(reading.raw.humans, 5);
    assert.equal(reading.raw.contaminated.length, 1);
    assert.equal(reading.verdict, 'partial', '有污染样本时不能 pass');
    assert.equal(reading.raw.median_total_ms, human.median(clean.map((entry) => entry.unlock_wait_ms + entry.sign_ms)));

    const run = spawnSync(process.execPath, [CLI, '--add', '--decision', 'DEC-1', '--inject-delay'], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /不接受注入参数/);
  });

  it('C4 门槛：4 条/4 个决策 ⇒ partial；5 条但重复决策 ⇒ partial；5 条 5 决策 ⇒ pass', async () => {
    const human = await modulePromise;
    const four = [1, 2, 3, 4].map((index) => sample(index));
    const fourReading = human.computeHumanReading(four, contextFor(four));
    assert.equal(fourReading.verdict, 'partial');
    assert.equal(fourReading.raw.humans, 4);
    assert.equal(fourReading.raw.sufficient, false);

    const duplicate = [1, 2, 3, 4, 4].map((index) => sample(index));
    const duplicateReading = human.computeHumanReading(duplicate, contextFor(duplicate));
    assert.equal(duplicateReading.raw.distinct_decisions, 4);
    assert.equal(duplicateReading.verdict, 'partial');

    const five = [1, 2, 3, 4, 5].map((index) => sample(index));
    const fiveReading = human.computeHumanReading(five, contextFor(five));
    assert.equal(fiveReading.verdict, 'pass');
    assert.equal(fiveReading.raw.humans, 5);
    assert.equal(fiveReading.raw.distinct_decisions, 5);
    assert.ok(typeof fiveReading.raw.median_total_ms === 'number' && fiveReading.raw.median_total_ms <= 10_000);
  });

  it('C5 中位由样本现算：改一条 sign_ms ⇒ 中位跟着变（不是常量）', async () => {
    const human = await modulePromise;
    const base = [1000, 2000, 3000, 4000, 9000].map((signMs, index) => sample(index + 1, { sign_ms: signMs, unlock_wait_ms: 0 }));
    const before = human.computeHumanReading(base, contextFor(base));
    assert.equal(before.raw.median_total_ms, 3000);
    const mutated = base.map((entry) => (entry.sample_id === 'human-3' ? { ...entry, sign_ms: 8000 } : entry));
    const after = human.computeHumanReading(mutated, contextFor(mutated));
    assert.equal(after.raw.median_total_ms, 4000, '改一条样本后中位必须变');
    assert.equal(before.raw.m2_r5.human_samples, 5);
  });

  it('C6 隐私：样本/说明里出现 passphrase、socket 路径、home 路径 ⇒ privacy_hits，读数 fail', async () => {
    const human = await modulePromise;
    const five = [1, 2, 3, 4, 5].map((index) => sample(index));
    for (const text of ['passphrase: hunter2', 'socket /tmp/sdo-1000/signerd.sock', 'BEGIN RSA PRIVATE KEY', '/home/owner/.local/state']) {
      const reading = human.computeHumanReading(five, contextFor(five), { privacyText: text });
      assert.ok(reading.raw.privacy_hits.length > 0, `应命中隐私模式：${text}`);
      assert.equal(reading.verdict, 'fail');
    }
    assert.deepEqual(human.scanPrivacy('项目所有者用 /sign 真流程签字'), []);
    assert.ok(human.scanPrivacy('token: abc').length > 0, '普通 token 也要命中（保守一侧）');
  });

  it('采集器 --add：从回执现算时长、写样本文件、幂等；--verify 对账', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4-cli-'));
    try {
      const { db, path } = makeDb(dir);
      db.close();
      const receiptsPath = join(dir, 'receipts.jsonl');
      const receipt: Receipt = {
        receipt_id: 'rcpt:cli-1',
        decision_id: 'DEC-1',
        signature: 'sig-1',
        at: AT,
        unlock_wait_ms: 321,
        sign_ms: 1234,
        prev_receipt_hash: null,
      };
      writeFileSync(receiptsPath, `${JSON.stringify(receipt)}\n`, 'utf8');
      const samplesPath = join(dir, 'samples.json');
      const env = { ...process.env, SDO_DB_PATH: path, SDO_DB_PASSPHRASE: PASS };
      const first = spawnSync(
        process.execPath,
        [CLI, '--add', '--decision', 'DEC-1', '--receipts', receiptsPath, '--samples', samplesPath, '--note', '真流程签字'],
        { cwd: ROOT, encoding: 'utf8', env },
      );
      assert.equal(first.status, 0, first.stderr);
      const created = JSON.parse(first.stdout) as Record<string, unknown>;
      assert.equal(created['created'], true);
      assert.equal(created['sign_ms'], 1234);
      assert.equal(created['unlock_wait_ms'], 321);
      const stored = JSON.parse(readFileSync(samplesPath, 'utf8')) as { samples: Sample[] };
      assert.equal(stored.samples.length, 1);
      assert.equal(stored.samples[0]?.sign_ms, 1234);
      assert.ok(existsSync(samplesPath.replace(/\.json$/u, '.md')), '同时写可读版 .md');

      const second = spawnSync(
        process.execPath,
        [CLI, '--add', '--decision', 'DEC-1', '--receipts', receiptsPath, '--samples', samplesPath],
        { cwd: ROOT, encoding: 'utf8', env },
      );
      assert.equal(second.status, 0);
      assert.equal((JSON.parse(second.stdout) as Record<string, unknown>)['created'], false);
      assert.equal((JSON.parse(readFileSync(samplesPath, 'utf8')) as { samples: Sample[] }).samples.length, 1);

      const verify = spawnSync(process.execPath, [CLI, '--verify', '--receipts', receiptsPath, '--samples', samplesPath], {
        cwd: ROOT,
        encoding: 'utf8',
        env,
      });
      assert.equal(verify.status, 0, verify.stderr);
      assert.equal((JSON.parse(verify.stdout) as Record<string, unknown>)['ok'], true);
    } finally {
      rm(dir);
    }
  });

  it('R-human：0 条 ⇒ partial + human_samples:0；5 条真样本 ⇒ pass；4 条 ⇒ partial', async () => {
    const { measureHumanSamples } = (await import(join(ROOT, 'scripts', 'readings', 'm4', 'r-human.mjs'))) as {
      measureHumanSamples(options?: Record<string, unknown>): { verdict: string; measured: Record<string, any>; caveat: string };
    };
    const empty = measureHumanSamples({ samples: [], receiptsFile: join(tmpdir(), 'no-such-receipts.jsonl') });
    assert.equal(empty.verdict, 'partial');
    assert.equal(empty.measured['humans'], 0);
    assert.equal(empty.measured['m2_r5'].human_samples, 0);

    const five = [1, 2, 3, 4, 5].map((index) => sample(index));
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4-rhuman-'));
    try {
      const receiptsPath = join(dir, 'receipts.jsonl');
      writeFileSync(receiptsPath, `${five.map((entry, index) => JSON.stringify({ receipt_id: entry.receipt_id, decision_id: entry.decision_id, signature: `sig-${String(index)}`, at: entry.at, unlock_wait_ms: entry.unlock_wait_ms, sign_ms: entry.sign_ms })).join('\n')}\n`, 'utf8');
    // P1：只有回执、没有 decision 上下文 ⇒ 5 条也不许 pass。
    const noDb = measureHumanSamples({
      samples: five,
      receiptsFile: receiptsPath,
      decisions: null,
      actors: null,
    });
    assert.equal(noDb.verdict, 'partial');
    assert.equal(noDb.measured['humans'], 0);
    assert.equal(noDb.measured['humans_unverified'], 5);
    assert.ok(noDb.caveat?.includes('库不可读'));
      const passReading = measureHumanSamples({
        samples: five,
        receiptsFile: receiptsPath,
        decisions: new Map(five.map((entry, index) => [entry.decision_id, { signature: `sig-${String(index)}`, signer: 'human-pm' }])),
        actors: new Map([['human-pm', 'human']]),
      });
      assert.equal(passReading.verdict, 'pass');
      assert.equal(passReading.measured['humans'], 5);
      assert.equal(passReading.measured['distinct_decisions'], 5);

      const four = five.slice(0, 4);
      const partial = measureHumanSamples({
        samples: four,
        receiptsFile: receiptsPath,
        decisions: new Map(four.map((entry, index) => [entry.decision_id, { signature: `sig-${String(index)}`, signer: 'human-pm' }])),
        actors: new Map([['human-pm', 'human']]),
      });
      assert.equal(partial.verdict, 'partial');
      assert.equal(partial.measured['humans'], 4);
    } finally {
      rm(dir);
    }
  });

  it('P1 采集侧：无库时 --verify 显式拒绝（不静默跳过 decision 校验）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4-verify-'));
    try {
      const receiptsPath = join(dir, 'receipts.jsonl');
      const receipt = { receipt_id: 'rcpt:v1', decision_id: 'DEC-1', signature: 'sig-1', at: AT, unlock_wait_ms: 100, sign_ms: 1000 };
      writeFileSync(receiptsPath, `${JSON.stringify(receipt)}\n`, 'utf8');
      const samplesPath = join(dir, 'samples.json');
      writeFileSync(samplesPath, JSON.stringify({ version: 'sdo-human-samples-v1', samples: [sample(1)] }), 'utf8');
      const env = { ...process.env };
      delete env['SDO_DB_PATH'];
      delete env['SDO_DB_PASSPHRASE'];
      const run = spawnSync(process.execPath, [CLI, '--verify', '--receipts', receiptsPath, '--samples', samplesPath], {
        cwd: ROOT,
        encoding: 'utf8',
        env,
      });
      assert.notEqual(run.status, 0);
      assert.match(run.stdout, /decision_db_unavailable/);
    } finally {
      rm(dir);
    }
  });

  it('整脚本 R-human：样本 0 条时整体读数 partial 且不带假中位', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4-script-'));
    try {
      const samplesPath = join(dir, 'samples.json');
      const human = await modulePromise;
      writeFileSync(samplesPath, JSON.stringify(human.emptySampleFile()), 'utf8');
      const receiptsPath = join(dir, 'receipts.jsonl');
      const prefix = join(dir, 'M4-读数');
      const run = spawnSync(process.execPath, [SCRIPT, '--only', 'R-human'], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, M4_HUMAN_SAMPLES: samplesPath, M4_RECEIPTS_FILE: receiptsPath },
      });
      assert.equal(run.status, 0, run.stderr);
      const parsed = JSON.parse(run.stdout) as { id: string; raw: Record<string, unknown>; verdict: string; caveat: string };
      assert.equal(parsed.id, 'R-human');
      assert.equal(parsed.verdict, 'partial');
      assert.match(parsed.caveat, /partial/);
      assert.equal(parsed.raw['humans'], 0);
      assert.equal(parsed.raw['median_total_ms'], null);
      void prefix;
    } finally {
      rm(dir);
    }
  });
});

function rm(path: string): void {
  spawnSync(process.execPath, ['-e', `require('node:fs').rmSync(${JSON.stringify(path)}, { recursive: true, force: true })`]);
}
