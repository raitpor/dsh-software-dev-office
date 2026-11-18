/** M5-0 P1-1：dispose 只清理本插件自己 spawn 的 signerd；P3-2 权限直断言。 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { initializeSignerd } from '../../src/sign/signerd.js';
import { signerdPaths } from '../../src/sign/paths.js';
import { SignerdClient } from '../../src/sign/client.js';
import { activatePlugin, type PluginContext } from '../../src/plugin/index.js';
import { afterSignerdStop, cleanupSignerd, startSignerdProcess } from '../../src/plugin/signerd.js';
import { makeDb, envFor } from './helpers.js';

const SIGNERD_PASS = 'signerd-ownership-passphrase';

function fakeContext(): PluginContext {
  return {
    tools: { register: () => () => undefined },
    effect: (callback) => {
      callback();
      return () => undefined;
    },
  };
}

function tempRuntime(label: string): { root: string; home: string; restore: () => void } {
  const root = mkdtempSync(join(tmpdir(), `sdo-signerd-${label}-`));
  const runtimeDir = join(root, 'sdo');
  mkdirSync(runtimeDir, { recursive: true });
  chmodSync(runtimeDir, 0o700);
  const previous = process.env['XDG_RUNTIME_DIR'];
  process.env['XDG_RUNTIME_DIR'] = root;
  return {
    root,
    home: join(root, 'home'),
    restore: () => {
      if (previous === undefined) delete process.env['XDG_RUNTIME_DIR'];
      else process.env['XDG_RUNTIME_DIR'] = previous;
    },
  };
}

test('autostart=false 且有外部 socket：dispose 不删它', async () => {
  const fixture = makeDb();
  const runtimeEnv = tempRuntime('own');
  const home = runtimeEnv.home;
  try {
    const paths = signerdPaths({ homeDir: home });
    writeFileSync(paths.socket, 'external');
    const plugin = await activatePlugin(
      fakeContext(),
      { db_path: fixture.dbPath, project_dir: fixture.dir, console: false, signerd_home: home, signerd_autostart: false },
      envFor(),
    );
    await plugin.dispose();
    assert.equal(existsSync(paths.socket), true);
  } finally {
    runtimeEnv.restore();
    fixture.close();
  }
});

test('already_running：复用外部实例，dispose 不删其 socket', async () => {
  const fixture = makeDb();
  const runtimeEnv = tempRuntime('reuse');
  const home = runtimeEnv.home;
  const paths = signerdPaths({ homeDir: home });
  await initializeSignerd({ passphrase: SIGNERD_PASS, paths });
  const external = await startSignerdProcess({ home, passphrase: SIGNERD_PASS });
  try {
    const plugin = await activatePlugin(
      fakeContext(),
      { db_path: fixture.dbPath, project_dir: fixture.dir, console: false, signerd_home: home, signerd_autostart: true },
      { ...envFor(), SDO_SIGNERD_PASSPHRASE: SIGNERD_PASS },
    );
    await plugin.dispose();
    assert.equal(existsSync(paths.socket), true);
    const status = await new SignerdClient({ paths }).status();
    assert.equal((status as { ok?: boolean }).ok, true);
  } finally {
    await external.stop().catch(() => undefined);
    await cleanupSignerd(home, paths.socket);
    runtimeEnv.restore();
    fixture.close();
  }
});

test('C4：signerd 的 key/socket 0600、home 0700', async () => {
  const runtimeEnv = tempRuntime('perm');
  const home = runtimeEnv.home;
  const paths = signerdPaths({ homeDir: home });
  try {
    await initializeSignerd({ passphrase: SIGNERD_PASS, paths });
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(paths.keyFile).mode & 0o777, 0o600);
    const handle = await startSignerdProcess({ home, passphrase: SIGNERD_PASS });
    try {
      assert.equal(statSync(paths.socket).mode & 0o777, 0o600);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  } finally {
    await cleanupSignerd(home, paths.socket);
    runtimeEnv.restore();
  }
});

test('P3-2 启动超时：本次 socket/lock 被清掉', async () => {
  const runtimeEnv = tempRuntime('timeout');
  const home = runtimeEnv.home;
  const paths = signerdPaths({ homeDir: home });
  const script = join(runtimeEnv.root, 'never-ready.mjs');
  writeFileSync(script, 'setTimeout(() => {}, 5000);\n');
  try {
    await initializeSignerd({ passphrase: SIGNERD_PASS, paths });
    writeFileSync(paths.socket, 'stale');
    writeFileSync(paths.lockFile, 'stale');
    await assert.rejects(
      () => startSignerdProcess({ home, passphrase: SIGNERD_PASS, timeoutMs: 100, scriptPath: script }),
      /signerd_start_timeout/,
    );
    assert.equal(existsSync(paths.socket), false);
    assert.equal(existsSync(paths.lockFile), false);
  } finally {
    runtimeEnv.restore();
  }
});

test('P3-3 stop 未确认：保留 socket、只清 lock 并报 incomplete', async () => {
  const runtimeEnv = tempRuntime('stop-incomplete');
  const home = runtimeEnv.home;
  const paths = signerdPaths({ homeDir: home });
  mkdirSync(home, { recursive: true });
  writeFileSync(paths.socket, 'dummy');
  writeFileSync(paths.lockFile, 'dummy');
  const handle = {
    owned: true as const,
    pid: 123,
    home,
    socketPath: paths.socket,
    stop: async () => false,
    kill9: () => undefined,
  };
  const incomplete: Array<{ pid: number | undefined; socket: string }> = [];
  try {
    await afterSignerdStop(handle, false, (detail) => incomplete.push(detail));
    assert.equal(existsSync(paths.socket), true);
    assert.equal(existsSync(paths.lockFile), false);
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0]?.socket, paths.socket);
  } finally {
    await cleanupSignerd(home, paths.socket);
    runtimeEnv.restore();
  }
});


test('P2-3 spawn 失败：结构化失败，不炸宿主进程', async () => {
  const runtimeEnv = tempRuntime('spawn-fail');
  const home = runtimeEnv.home;
  const paths = signerdPaths({ homeDir: home });
  try {
    await initializeSignerd({ passphrase: SIGNERD_PASS, paths });
    const missing = join(runtimeEnv.root, 'does-not-exist.mjs');
    await assert.rejects(
      () => startSignerdProcess({ home, passphrase: SIGNERD_PASS, scriptPath: missing, timeoutMs: 500 }),
      /signerd_(exited|spawn_failed)/,
    );
    assert.equal(existsSync(paths.socket), false);
  } finally {
    await cleanupSignerd(home, paths.socket);
    runtimeEnv.restore();
  }
});
