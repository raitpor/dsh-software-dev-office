/** M5-0 C4：适配器侧 signerd 起停/重复启动/kill -9 恢复/清理。 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { initializeSignerd } from '../../src/sign/signerd.js';
import { signerdPaths } from '../../src/sign/paths.js';
import { cleanupSignerd, startSignerdProcess } from '../../src/plugin/signerd.js';

const PASSPHRASE = 'signerd-plugin-test-passphrase';

function tempPaths(): { home: string; socketPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'sdo-signerd-plugin-'));
  return { home: join(root, 'home'), socketPath: join(root, 'signerd.sock') };
}

test('signerd: 两次启动 already_running，kill -9 后恢复，清理 socket', async () => {
  const { home, socketPath } = tempPaths();
  const paths = signerdPaths({ homeDir: home, socketPath });
  await initializeSignerd({ passphrase: PASSPHRASE, paths });
  const first = await startSignerdProcess({ home, passphrase: PASSPHRASE, socketPath });
  try {
    await assert.rejects(
      () => startSignerdProcess({ home, passphrase: PASSPHRASE, socketPath }),
      /already_running/,
    );
    first.kill9();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await startSignerdProcess({ home, passphrase: PASSPHRASE, socketPath, timeoutMs: 6000 });
    await second.stop();
    await cleanupSignerd(home, socketPath);
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(paths.socket), false);
  } finally {
    await first.stop().catch(() => undefined);
    await cleanupSignerd(home, socketPath);
  }
});
