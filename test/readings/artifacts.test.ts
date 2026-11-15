import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

/**
 * M0-G 生成物守卫。
 *
 * 历史缺陷（M3 发现）：本测试曾直接跑 `scripts/m0-readings.mjs` 写仓库里的
 * `plan/milestone/M0-读数.*` —— 已签读数被测试当草稿纸，`npm test` 后工作树必脏
 * （这也是此前“已还原”报告一跑测试就失效的原因）。现在全部写临时目录，
 * 并显式断言仓库里的已签生成物内容与 mtime 均未被触碰。
 */

const ROOT = process.cwd();
const MILESTONE = resolve(ROOT, 'plan/milestone');
const SIGNED = ['M0-读数.json', 'M0-读数.md'] as const;

function snapshot(dir: string): Map<string, { bytes: number; mtimeMs: number; text: string }> {
  const map = new Map<string, { bytes: number; mtimeMs: number; text: string }>();
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (!stat.isFile()) continue;
    map.set(name, { bytes: stat.size, mtimeMs: stat.mtimeMs, text: readFileSync(path, 'utf8') });
  }
  return map;
}

test('generated milestone report contains no literal "undefined"（写临时目录，不碰已签生成物）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m0g-artifacts-'));
  const before = snapshot(MILESTONE);
  try {
    const prefix = join(dir, 'M0-读数');
    const run = spawnSync(process.execPath, ['scripts/m0-readings.mjs', '--out', prefix], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(run.status, 0, `readings failed: ${run.stderr.slice(-800)}`);

    for (const file of [`${prefix}.json`, `${prefix}.md`]) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!text.includes('undefined'), `${file} must not contain the string "undefined"`);
    }
    const report = JSON.parse(readFileSync(`${prefix}.json`, 'utf8')) as {
      readings: Record<string, { verdict: string }>;
    };
    assert.deepEqual(Object.keys(report.readings).sort(), ['R1', 'R2', 'R3', 'R4']);
    for (const [id, reading] of Object.entries(report.readings)) {
      assert.ok(['pass', 'partial', 'fail'].includes(reading.verdict), `${id} has invalid verdict`);
    }

    const after = snapshot(MILESTONE);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'plan/milestone 文件集合不能被测试改动');
    for (const name of SIGNED) {
      const expected = before.get(name);
      const actual = after.get(name);
      assert.ok(expected !== undefined, `${name} 应存在于 plan/milestone`);
      assert.ok(actual !== undefined, `${name} 不得被测试删除`);
      assert.equal(actual.text, expected.text, `已签生成物 ${name} 内容被测试改写`);
      assert.equal(actual.mtimeMs, expected.mtimeMs, `已签生成物 ${name} 被测试触碰（mtime 变化）`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
