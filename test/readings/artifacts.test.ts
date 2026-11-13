import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const ROOT = process.cwd();
const JSON_PATH = resolve(ROOT, 'plan/milestone/M0-读数.json');
const MD_PATH = resolve(ROOT, 'plan/milestone/M0-读数.md');

test('generated milestone report contains no literal "undefined"', () => {
  const run = spawnSync(process.execPath, ['scripts/m0-readings.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert.equal(run.status, 0, `readings failed: ${run.stderr.slice(-800)}`);

  for (const file of [JSON_PATH, MD_PATH]) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('undefined'), `${file} must not contain the string "undefined"`);
  }
});
