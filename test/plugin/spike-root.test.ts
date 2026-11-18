/** P1-2 守卫：spike 根发现按目录特征，不再依赖包名。 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('spike root discovery 不依赖包名', async () => {
  const module = (await import(
    pathToFileURL(join(process.cwd(), 'test', 'spike', '_root.mjs')).href
  )) as { REPO_ROOT?: string };
  assert.equal(module.REPO_ROOT, process.cwd());
});
