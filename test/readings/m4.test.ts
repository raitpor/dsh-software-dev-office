import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(ROOT, 'scripts', 'm4-readings.mjs');
const MILESTONE = join(ROOT, 'plan', 'milestone');

interface Report {
  readonly overall: string;
  readonly readings: Record<string, { readonly verdict: string; readonly raw: Record<string, unknown> }>;
}

function milestoneSnapshot(): string[] {
  return readdirSync(MILESTONE)
    .filter((name) => name.startsWith('M4-读数'))
    .sort()
    .map((name) => {
      const stats = statSync(join(MILESTONE, name));
      return `${name}|${stats.size}|${Math.trunc(stats.mtimeMs)}`;
    });
}

describe('M4-7 readings', () => {
  it('runs R-pick to a temp --out prefix, passes, and leaves the signed milestone dir untouched', () => {
    const before = milestoneSnapshot();
    const dir = mkdtempSync(join(tmpdir(), 'sdo-m4-readings-'));
    const prefix = join(dir, 'M4-读数');
    try {
      // M4-6：R-human 的样本文件显式指到临时空文件（0 条 ⇒ partial），不依赖本机真实样本。
      const humanSamples = join(dir, 'human-samples.json');
      writeFileSync(humanSamples, JSON.stringify({ version: 'sdo-human-samples-v1', samples: [] }), 'utf8');
      const run = spawnSync(process.execPath, [SCRIPT, '--out', prefix], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, M4_HUMAN_SAMPLES: humanSamples, M4_RECEIPTS_FILE: join(dir, 'no-receipts.jsonl') },
        timeout: 240_000,
      });
      assert.equal(run.status, 0, `m4 readings failed: ${run.stderr}`);

      const report = JSON.parse(readFileSync(`${prefix}.json`, 'utf8')) as Report;
      // M4-6：没有人类样本时整体必须是 partial（不许用工具侧代理冒充）。
      assert.equal(report.overall, 'partial');
      const rpick = report.readings['R-pick'];
      assert.equal(rpick?.verdict, 'pass');
      assert.equal(rpick?.raw['max_pick_declined_per_dispatch'], 1);
      assert.equal(rpick?.raw['max_consecutive_spawns'], 3);
      assert.equal(rpick?.raw['rejections'], 1);
      const rhuman = report.readings['R-human'];
      assert.equal(rhuman?.verdict, 'partial');
      assert.equal(rhuman?.raw['humans'], 0);

      const markdown = readFileSync(`${prefix}.md`, 'utf8');
      assert.equal(markdown.includes('undefined'), false, 'report must not contain literal "undefined"');
      assert.match(markdown, /R-pick/);
      assert.match(markdown, /R-human/);
      assert.deepEqual(milestoneSnapshot(), before, 'readings must not write plan/milestone/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
