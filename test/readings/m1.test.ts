import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * M1-G · 七条判死读数（卡 plan/cards/M1-G.md）
 *
 * 测的是“读数脚本本身”：字段齐全、verdict 合法、关键读数现算（不是常量）、
 * 两遍除 generatedAt 外逐字节一致、不碰 HOME 状态目录、不污染仓库。
 */

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/m1-readings.mjs');
const READING_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'] as const;
const VERDICTS = new Set(['pass', 'partial', 'fail']);

interface ReadingEntry {
  id: string;
  question: string;
  command: string;
  raw: unknown;
  verdict: string;
  caveat: string;
}

interface Report {
  card: string;
  generatedAt: string;
  command: string;
  node: string;
  overall: string;
  readings: Record<string, ReadingEntry>;
}

function reading(report: Report, id: string): ReadingEntry {
  const entry = report.readings[id];
  assert.ok(entry, `missing reading ${id}`);
  return entry;
}

function runReadings(outPrefix: string, home: string): Report {
  const stdout = execFileSync(process.execPath, [SCRIPT, '--out', outPrefix], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 300_000,
    env: { ...process.env, HOME: home },
  });
  const summary = JSON.parse(stdout) as { out: { json: string; md: string } };
  assert.ok(existsSync(summary.out.json), 'readings JSON was not generated');
  assert.ok(existsSync(summary.out.md), 'readings markdown was not generated');
  return JSON.parse(readFileSync(summary.out.json, 'utf8')) as Report;
}

function withoutGeneratedAt(report: Report): Report {
  return { ...report, generatedAt: 'IGNORED' };
}

function walk(dir: string, skip: Set<string>, out: string[], prefix = ''): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(join(dir, entry.name), skip, out, rel);
    else out.push(rel);
  }
}

function repoArtifacts(): string[] {
  const found: string[] = [];
  walk(ROOT, new Set(['node_modules', '.git', 'lib', 'artifacts']), found);
  return found.filter((rel) => rel.endsWith('.db') || rel.endsWith('access.log')).sort();
}

function migrationCreatesTable(table: string): boolean {
  const dir = join(ROOT, 'migrations');
  const pattern = new RegExp(
    `create\\s+table(?:\\s+if\\s+not\\s+exists)?\\s+["']?${table.replace(/\./g, '\\\\.')}["']?\\s*\\(`,
    'i',
  );
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .some((name) => pattern.test(readFileSync(join(dir, name), 'utf8')));
}

test('M1-G 读数：七条齐全、字段与 verdict 合法', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm1g-test-'));
  const home = mkdtempSync(join(tmpdir(), 'm1g-home-'));
  try {
    const report = runReadings(join(dir, 'M1-读数'), home);
    assert.equal(report.card, 'M1-G');
    assert.equal(report.command, 'npm run readings:m1');
    assert.deepEqual(Object.keys(report.readings).sort(), [...READING_IDS]);
    for (const id of READING_IDS) {
      const entry = reading(report, id);
      assert.equal(entry.id, id);
      assert.equal(typeof entry.question, 'string');
      assert.ok(entry.question.length > 0);
      assert.ok(entry.command.includes('m1-readings.mjs'), `bad command for ${id}`);
      assert.ok(VERDICTS.has(entry.verdict), `bad verdict for ${id}: ${entry.verdict}`);
      assert.equal(typeof entry.caveat, 'string');
      assert.ok(entry.caveat.length > 0, `missing caveat for ${id}`);
      assert.notEqual(entry.raw, null);
      assert.equal(typeof entry.raw, 'object');
    }
    assert.ok(VERDICTS.has(report.overall));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('M1-G 读数：关键读数与卡面一致且是现算的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'm1g-test-'));
  const home = mkdtempSync(join(tmpdir(), 'm1g-home-'));
  try {
    const report = runReadings(join(dir, 'M1-读数'), home);

    const r1 = reading(report, 'R1').raw as {
      claimRows: number;
      rows: { equal: boolean; frontier_ok: boolean; frontier_ids: string[] }[];
      allFrontierOk: boolean;
    };
    assert.equal(r1.claimRows, 20);
    assert.equal(r1.rows.length, 20);
    assert.ok(r1.rows.every((row) => row.equal));
    assert.ok(r1.rows.every((row) => row.frontier_ok));
    assert.equal(r1.allFrontierOk, true);

    const r2 = reading(report, 'R2').raw as {
      before: { events: number };
      append_result: { ok: boolean; reason_code: string; message: string };
      register_api_result: { ok: boolean; reason_code: string };
      noWrites: boolean;
      rejectedByWritePath: boolean;
    };
    assert.ok(r2.before.events >= 1, 'R2 must run on a non-empty DB');
    assert.equal(r2.append_result.ok, false);
    assert.equal(r2.append_result.reason_code, 'materialize_failed');
    assert.ok(r2.append_result.message.includes('requires fixtures[]'));
    assert.equal(r2.register_api_result.reason_code, 'no_negative_fixture');
    assert.equal(r2.noWrites, true);
    assert.equal(r2.rejectedByWritePath, true);

    const r3 = reading(report, 'R3').raw as {
      red: { result: string; fields: string[]; info: number; total: number };
      green: { result: string };
      consumersWritten: number;
    };
    assert.equal(r3.red.result, 'fail');
    assert.ok(r3.red.fields.length > 0);
    assert.equal(r3.red.total, r3.red.fields.length + r3.red.info);
    assert.equal(r3.consumersWritten, r3.red.fields.length);
    assert.equal(r3.green.result, 'pass');

    const r4 = reading(report, 'R4');
    assert.equal(r4.verdict, 'partial', 'A3: 无真实外部意图样本，读数 4 只能 partial');
    const r4raw = r4.raw as {
      sample: { code_written_at: string | null; diff_dispositions: { target_ref: string; disposition: string }[] };
      divergence: { total: number; before_code: number; rate: number };
    };
    assert.equal(r4raw.sample.code_written_at, null);
    assert.deepEqual(
      r4raw.sample.diff_dispositions.map((row) => `${row.target_ref}:${row.disposition}`),
      ['d1:accept', 'd2:accept', 'd3:reject'],
    );
    assert.equal(r4raw.divergence.total, 3);
    assert.equal(r4raw.divergence.before_code, 3);
    assert.equal(r4raw.divergence.rate, 1);

    // P1-2 红证：把代码事件挪到处置之前 ⇒ rate 必须跟着变（不是常量）。
    const measure = (await import(new URL('../../../scripts/readings/m1/measure.mjs', import.meta.url).href)) as {
      measureR4: (options?: { codeEventAt?: string }) => {
        measured: {
          sample: { code_written_at: string | null };
          divergence: { total: number; before_code: number; rate: number };
        };
      };
    };
    const variant = measure.measureR4({ codeEventAt: '2026-11-13T09:03:00.000Z' }).measured;
    assert.equal(variant.sample.code_written_at, '2026-11-13T09:03:00.000Z');
    assert.equal(variant.divergence.before_code, 0);
    assert.equal(variant.divergence.rate, 0);
    assert.notEqual(variant.divergence.rate, r4raw.divergence.rate);

    const r5 = reading(report, 'R5').raw as {
      scenarios: {
        scenario: string;
        samples: { run: number; preview: number; actual: number; equal: boolean; before_units: number }[];
        allEqual: boolean;
      }[];
      allEqual: boolean;
    };
    assert.equal(r5.scenarios.length, 2);
    assert.equal(r5.allEqual, true);
    const [scenarioA, scenarioB] = r5.scenarios;
    assert.ok(scenarioA && scenarioB);
    assert.equal(scenarioA.samples.length, 3);
    assert.equal(scenarioB.samples.length, 3);
    for (const sample of scenarioA.samples) {
      assert.equal(sample.equal, true);
      assert.equal(sample.before_units, 3);
      assert.equal(sample.actual, 3);
    }
    for (const sample of scenarioB.samples) {
      assert.equal(sample.equal, true);
      assert.equal(sample.before_units, 3);
      assert.equal(sample.actual, 2);
    }
    // 两个场景作废数不同 ⇒ 不是“恒 3 全等”的常量通过。
    assert.notEqual(scenarioA.samples[0]?.actual, scenarioB.samples[0]?.actual);

    const r6 = reading(report, 'R6').raw as {
      results: { hit: boolean; reason_codes: string[]; allowed: string[]; unexpected_codes: string[] }[];
      allHit: boolean;
    };
    assert.equal(r6.results.length, 3);
    assert.equal(r6.allHit, true);
    for (const result of r6.results) {
      assert.ok(result.reason_codes.every((code) => result.allowed.includes(code)));
      assert.deepEqual(result.unexpected_codes, []);
    }

    const r7 = reading(report, 'R7').raw as {
      counts: { table: string; exists: boolean; rows: number }[];
      zero: boolean;
      missing_gate_table: boolean;
    };
    assert.equal(r7.zero, true);
    assert.ok(r7.counts.every((item) => item.rows === 0));
    assert.equal(r7.missing_gate_table, true);
    const gate = r7.counts.find((item) => item.table === 'gate');
    const judged = r7.counts.find((item) => item.table === 'gate.judged');
    assert.ok(gate && judged);
    assert.equal(gate.exists, false);
    assert.equal(judged.exists, false);
    // 与迁移清单一致：M2 若加了 gate/gate.judged 表，这条会红，逼复跑读数。
    assert.equal(migrationCreatesTable('gate'), false);
    assert.equal(migrationCreatesTable('gate.judged'), false);
    assert.equal(reading(report, 'R7').verdict, 'partial', 'gate 表不存在 ⇒ 不能空过 pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('M1-G 读数：两遍除 generatedAt 外逐字节相同，markdown 无 undefined', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm1g-test-'));
  const home = mkdtempSync(join(tmpdir(), 'm1g-home-'));
  try {
    const first = runReadings(join(dir, 'first'), home);
    const second = runReadings(join(dir, 'second'), home);
    assert.deepEqual(withoutGeneratedAt(first), withoutGeneratedAt(second));

    const md = readFileSync(join(dir, 'second.md'), 'utf8');
    assert.ok(!md.includes('undefined'), 'markdown contains "undefined"');
    assert.ok(!md.includes('NaN'), 'markdown contains "NaN"');
    for (const id of READING_IDS) assert.ok(md.includes(`## ${id}`), `markdown missing section ${id}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('M1-G 读数：--only 单跑输出 {id, raw}，且不写生成物', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm1g-test-'));
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, '--only', 'R6'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    const result = JSON.parse(stdout) as { id: string; raw: { allHit: boolean } };
    assert.equal(result.id, 'R6');
    assert.equal(result.raw.allHit, true);
    assert.equal(existsSync(join(dir, 'M1-读数.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1-G 读数：HOME 状态目录与仓库不被写（C10）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm1g-test-'));
  const home = mkdtempSync(join(tmpdir(), 'm1g-home-'));
  try {
    const stateDir = join(home, '.local', 'state', 'sdo');
    assert.equal(existsSync(stateDir), false, 'fresh HOME should not have state dir');
    const before = repoArtifacts();
    runReadings(join(dir, 'M1-读数'), home);
    assert.equal(existsSync(stateDir), false, `readings created ${stateDir}`);
    assert.deepEqual(repoArtifacts(), before, 'readings created *.db/access.log in repo');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
