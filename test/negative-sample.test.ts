import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

// 这个文件就是卡里说的「红改绿」的落点：
// 1) 先有一个真的会红的 fixture（test/fixtures/always-red.test.mjs，故意保持红）；
// 2) 再把「红会红」本身变成可重复的元测试（下面两条）。
const FIXTURE = resolve(process.cwd(), 'test/fixtures/always-red.test.mjs');

test('negative sample: node --test really fails a red test (red is red)', () => {
  assert.ok(existsSync(FIXTURE), `fixture missing: ${FIXTURE}`);

  // 父进程自己就在 `node --test` 里跑，NODE_TEST_CONTEXT 会被子进程继承，导致
  // 子 `node --test` 进入「递归调用 test runner」保护模式、跳过文件并以 0 退出。
  // 验证红会红必须让子进程以独立 runner 身份跑，所以剥掉该变量。
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];

  const run = spawnSync(process.execPath, ['--test', FIXTURE], { encoding: 'utf8', env });
  assert.equal(run.error, undefined, `spawning the fixture runner must not fail: ${String(run.error)}`);
  assert.notEqual(run.status, 0, 'a deliberately failing fixture must make node --test exit non-zero');

  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  assert.match(output, /NEGATIVE FIXTURE/, 'failing assertion message must appear in the runner output');
});

test('negative sample: a wrong assertion surfaces as a rejection', async () => {
  await assert.rejects(
    async () => {
      assert.strictEqual(2 + 2, 5, 'NEGATIVE SAMPLE: 2 + 2 !== 5 (this assertion is expected to fire)');
    },
    /NEGATIVE SAMPLE/,
  );
});
