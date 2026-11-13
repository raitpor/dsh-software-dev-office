/**
 * CLI 单测（C2/C3/C4/C5）：默认 stdout JSON、--out、fail-closed、seq 回填表。
 * 子进程跑 `node lib/src/importer/index.js`（需先 `npm run build`）。
 */

import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { FIXTURE_PATH, parseCliError, parseReport, runImportCli } from './helpers.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m07-cli-'));
  tempDirs.push(dir);
  return dir;
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null, `${key} parent must be an object`);
  const child = (value as Record<string, unknown>)[key];
  assert.ok(typeof child === 'object' && child !== null, `${key} must be an object`);
  return child as Record<string, unknown>;
}

function arrayAt(value: unknown, key: string): unknown[] {
  assert.ok(typeof value === 'object' && value !== null, `${key} parent must be an object`);
  const child = (value as Record<string, unknown>)[key];
  assert.ok(Array.isArray(child), `${key} must be an array`);
  return child;
}

/** 拷贝夹具到临时目录，返回路径（供篡改后跑负例）。 */
function fixtureCopy(dir: string): string {
  const target = join(dir, 'v1-export.json');
  copyFileSync(FIXTURE_PATH, target);
  return target;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('importer/cli: 正例（C2/C3）', () => {
  it('--sample 20：20/20 重建、0 差异、报告是 stdout JSON', () => {
    const run = runImportCli(['--input', FIXTURE_PATH, '--sample', '20']);
    assert.equal(run.status, 0);
    assert.equal(run.stderr, '');
    const report = parseReport(run.stdout);
    assert.equal(report['format'], 'sdo-v2-importer-report');
    assert.equal(report['format_version'], 1);
    assert.equal(report['mode'], 'rebuild');
    assert.equal(report['input'], FIXTURE_PATH);
    assert.deepEqual(objectAt(report, 'sample'), {
      requested: 20,
      available: 20,
      rebuilt: 20,
      declared: true,
    });
    assert.deepEqual(objectAt(report, 'summary'), {
      claims: 20,
      work_units: 20,
      fields_compared: 140,
      diffs: 0,
    });
    assert.deepEqual(objectAt(report, 'asserted_by_parser'), {
      fields: ['claim.predicate', 'claim.value'],
      claims: 20,
    });
    assert.equal(arrayAt(report, 'claims').length, 20);
    assert.deepEqual(arrayAt(report, 'diffs'), []);
    assert.equal(report['seq'], undefined);
  });

  it('每条 claim 报告 work_unit 行 + claim 投影（subject=task.id，D-008）', () => {
    const run = runImportCli(['--input', FIXTURE_PATH, '--sample', '20']);
    const report = parseReport(run.stdout);
    const claims = arrayAt(report, 'claims');
    const first = claims[0];
    assert.ok(typeof first === 'object' && first !== null);
    assert.equal((first as Record<string, unknown>)['claim_no'], 'RC-2026-0001');
    assert.deepEqual(objectAt(first, 'work_unit'), {
      id: 'wu:TASK-001',
      task_id: 'TASK-001',
      criterion_id: 'CRIT-101',
      spec_id: 'SPEC-001',
      evidence_id: 'EV-001',
      at: '2026-09-30T08:01:00Z',
    });
    assert.deepEqual(objectAt(first, 'claim'), {
      subject: 'TASK-001',
      predicate: 'done',
      value: 'true',
    });
  });

  it('--backfill-seq：8 张卡 → 1..8 唯一单调映射表，不写库', () => {
    const run = runImportCli(['--input', FIXTURE_PATH, '--sample', '20', '--backfill-seq']);
    assert.equal(run.status, 0);
    const report = parseReport(run.stdout);
    assert.equal(report['mode'], 'rebuild+backfill-seq');
    const seq = objectAt(report, 'seq');
    const rows = arrayAt(seq, 'rows');
    assert.equal(rows.length, 8);
    const mapped = rows.map((row) => (row as Record<string, unknown>)['seq']);
    assert.deepEqual(mapped, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(new Set(mapped).size, 8);
    const sources = rows.map((row) => (row as Record<string, unknown>)['source']);
    assert.equal(sources.filter((source) => source === 'existing').length, 1);
    assert.equal(sources.filter((source) => source === 'backfilled').length, 7);
    assert.deepEqual(objectAt(seq, 'summary'), {
      cards: 8,
      distinct: 8,
      nulls: 0,
      min: 1,
      max: 8,
      monotonic: true,
    });
  });

  it('--sample 19 允许（显式抽样不设下限，报告记 declared=true）', () => {
    const run = runImportCli(['--input', FIXTURE_PATH, '--sample', '19']);
    assert.equal(run.status, 0);
    const report = parseReport(run.stdout);
    assert.deepEqual(objectAt(report, 'sample'), {
      requested: 19,
      available: 20,
      rebuilt: 19,
      declared: true,
    });
    assert.equal(objectAt(report, 'summary')['claims'], 19);
  });

  it('缺省 --sample：取全部 20 条，declared=false', () => {
    const run = runImportCli(['--input', FIXTURE_PATH]);
    assert.equal(run.status, 0);
    const report = parseReport(run.stdout);
    assert.deepEqual(objectAt(report, 'sample'), {
      requested: 20,
      available: 20,
      rebuilt: 20,
      declared: false,
    });
  });

  it('19 条导出 + 缺省 --sample → sample_too_small（C2 下限 fail-closed）', () => {
    const dir = makeTempDir();
    const path = fixtureCopy(dir);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { records: Record<string, unknown>[] };
    let lastClaim = -1;
    for (let index = doc.records.length - 1; index >= 0; index -= 1) {
      if (doc.records[index]?.['kind'] === 'claim') {
        lastClaim = index;
        break;
      }
    }
    assert.ok(lastClaim >= 0);
    doc.records.splice(lastClaim, 1);
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const run = runImportCli(['--input', path]);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    const error = parseCliError(run.stderr);
    assert.equal(error['code'], 'sample_too_small');
    assert.equal(error['available'], 19);
    assert.equal(error['required'], 20);
  });

  it('19 条导出 + 显式 --sample 19 → 绿，declared=true', () => {
    const dir = makeTempDir();
    const path = fixtureCopy(dir);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { records: Record<string, unknown>[] };
    let lastClaim = -1;
    for (let index = doc.records.length - 1; index >= 0; index -= 1) {
      if (doc.records[index]?.['kind'] === 'claim') {
        lastClaim = index;
        break;
      }
    }
    assert.ok(lastClaim >= 0);
    doc.records.splice(lastClaim, 1);
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const run = runImportCli(['--input', path, '--sample', '19']);
    assert.equal(run.status, 0);
    const report = parseReport(run.stdout);
    assert.deepEqual(objectAt(report, 'sample'), {
      requested: 19,
      available: 19,
      rebuilt: 19,
      declared: true,
    });
  });

  it('--out：报告同时落文件，内容与 stdout 完全一致', () => {
    const dir = makeTempDir();
    const out = join(dir, 'report.json');
    const run = runImportCli(['--input', FIXTURE_PATH, '--sample', '20', '--out', out]);
    assert.equal(run.status, 0);
    assert.equal(readFileSync(out, 'utf8'), run.stdout);
    assert.equal(parseReport(readFileSync(out, 'utf8'))['format'], 'sdo-v2-importer-report');
  });

  it('--help：退出 0，打印用法', () => {
    const run = runImportCli(['--help']);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /用法:/);
    assert.match(run.stdout, /--backfill-seq/);
  });
});

describe('importer/cli: 负例（C2/C3/C4）', () => {
  it('--sample 21（超过 20）→ sample 错误，exit 1', () => {
    const run = runImportCli(['--input', FIXTURE_PATH, '--sample', '21']);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.equal(parseCliError(run.stderr)['code'], 'sample');
  });

  it('未知 kind=mystery → unknown_kind，错误里带 offset（C4）', () => {
    const dir = makeTempDir();
    const path = fixtureCopy(dir);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { records: Record<string, unknown>[] };
    doc.records.push({ kind: 'mystery' });
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const run = runImportCli(['--input', path, '--sample', '20']);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    const error = parseCliError(run.stderr);
    assert.equal(error['code'], 'unknown_kind');
    assert.equal(error['offset'], 28);
    assert.match(String(error['message']), /records\[28\]\.kind/);
  });

  it('seq 冲突 → seq_conflict，cardIds 点名两张卡', () => {
    const dir = makeTempDir();
    const path = fixtureCopy(dir);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { records: Record<string, unknown>[] };
    const duplicate = doc.records[1];
    assert.ok(duplicate);
    duplicate['seq'] = 1; // v1-M0-0 已经是 1
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const run = runImportCli(['--input', path, '--sample', '20', '--backfill-seq']);
    assert.equal(run.status, 1);
    const error = parseCliError(run.stderr);
    assert.equal(error['code'], 'seq_conflict');
    assert.deepEqual(error['cardIds'], ['v1-M0-0', 'v1-M0-1']);
  });

  it('缺 --input / 未知参数 / --sample 0 → usage 错误', () => {
    const cases: readonly string[][] = [
      [],
      ['--input'],
      ['--input', FIXTURE_PATH, '--sample', '0'],
      ['--input', FIXTURE_PATH, '--nope'],
      ['--input', FIXTURE_PATH, '--backfill-seq=true'],
    ];
    for (const args of cases) {
      const run = runImportCli(args);
      assert.equal(run.status, 1, `args=${args.join(' ')}`);
      assert.equal(parseCliError(run.stderr)['code'], 'usage', `args=${args.join(' ')}`);
    }
  });

  it('抽样之外的重复 task_id 也要在整份导出上抓出来（structure）', () => {
    const dir = makeTempDir();
    const path = fixtureCopy(dir);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { records: Record<string, unknown>[] };
    const firstClaim = doc.records.find((record) => record['kind'] === 'claim');
    assert.ok(firstClaim);
    doc.records.push({ ...firstClaim, claim_no: 'RC-2026-0021' });
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const run = runImportCli(['--input', path, '--sample', '20']);
    assert.equal(run.status, 1);
    const error = parseCliError(run.stderr);
    assert.equal(error['code'], 'structure');
    assert.match(String(error['message']), /RC-2026-0001 and RC-2026-0021/);
    assert.equal(error['offset'], 28);
  });

  it('seq 冲突在抽样前暴露（不带 --backfill-seq 也校验）', () => {
    const dir = makeTempDir();
    const path = fixtureCopy(dir);
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { records: Record<string, unknown>[] };
    const card = doc.records[1];
    assert.ok(card);
    card['seq'] = 1; // v1-M0-0 已经是 1
    writeFileSync(path, JSON.stringify(doc, null, 2));
    const run = runImportCli(['--input', path, '--sample', '20']);
    assert.equal(run.status, 1);
    const error = parseCliError(run.stderr);
    assert.equal(error['code'], 'seq_conflict');
    assert.deepEqual(error['cardIds'], ['v1-M0-0', 'v1-M0-1']);
  });

  it('--out 指向 --input → invalid_field，且输入文件不被改写', () => {
    const dir = makeTempDir();
    const path = fixtureCopy(dir);
    const before = readFileSync(path);
    const run = runImportCli(['--input', path, '--sample', '20', '--out', path]);
    assert.equal(run.status, 1);
    const error = parseCliError(run.stderr);
    assert.equal(error['code'], 'invalid_field');
    assert.equal(error['path'], path);
    assert.deepEqual(readFileSync(path), before);
  });

  it('输入文件不存在 → io 错误', () => {
    const run = runImportCli(['--input', join(makeTempDir(), 'missing.json')]);
    assert.equal(run.status, 1);
    assert.equal(parseCliError(run.stderr)['code'], 'io');
  });
});
