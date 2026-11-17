import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
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
      const run = spawnSync(process.execPath, [SCRIPT, '--out', prefix], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env },
        timeout: 240_000,
      });
      assert.equal(run.status, 0, `m4 readings failed: ${run.stderr}`);

      const report = JSON.parse(readFileSync(`${prefix}.json`, 'utf8')) as Report;
      assert.equal(report.overall, 'pass');
      const rpick = report.readings['R-pick'];
      assert.equal(rpick?.verdict, 'pass');
      assert.equal(rpick?.raw['max_pick_declined_per_dispatch'], 1);
      assert.equal(rpick?.raw['max_consecutive_spawns'], 3);
      assert.equal(rpick?.raw['rejections'], 1);

      const markdown = readFileSync(`${prefix}.md`, 'utf8');
      assert.equal(markdown.includes('undefined'), false, 'report must not contain literal "undefined"');
      assert.match(markdown, /R-pick/);
      assert.deepEqual(milestoneSnapshot(), before, 'readings must not write plan/milestone/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
