/** M5-0 C8：宿主安装树内容哈希稳定、排除项生效。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const SCRIPT = resolve('scripts/plugin/host-digest.mjs');

function run(args: string[]): { install: string; files: number; sha256: string } {
  const output = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return JSON.parse(output) as { install: string; files: number; sha256: string };
}

test('digest: 同内容同哈希，文件改动变哈希，exclude 生效', () => {
  const root = mkdtempSync(join(tmpdir(), 'sdo-host-'));
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'a', 'x.txt'), 'hello');
  writeFileSync(join(root, 'b.txt'), 'world');
  const first = run(['--install', root]);
  const second = run(['--install', root]);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.files, 2);
  writeFileSync(join(root, 'b.txt'), 'world2');
  assert.notEqual(run(['--install', root]).sha256, first.sha256);
  writeFileSync(join(root, 'b.txt'), 'world');
  writeFileSync(join(root, 'skip.txt'), 'skip');
  const excluded = run(['--install', root, '--exclude', join(root, 'skip.txt')]);
  assert.equal(excluded.sha256, first.sha256);
  assert.equal(excluded.files, 2);
});
