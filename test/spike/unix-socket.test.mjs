// M2-0s spike 测试：unix domain socket（零依赖，node --test；Windows 上 skip）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { importRepoModule } from './_root.mjs';

const perms = await importRepoModule('scripts/spike/fs-perms.mjs');
const sockets = await importRepoModule('scripts/spike/unix-socket.mjs');
const { createOwnerOnlyDir, formatMode } = perms;
const { SOCKET_ERROR, assertSecureSocketPath, request, spawnClient, spawnSignerd, startSignerd, waitExit } = sockets;

const linuxOrMac = process.platform === 'linux' || process.platform === 'darwin';
const skipWindows = !linuxOrMac && 'Windows has no unix domain sockets';

function scratch(t) {
  const base = mkdtempSync(join(tmpdir(), 'sdo-socket-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return base;
}

function has(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function listenDemo(socketPath, umask) {
  return new Promise((resolvePromise, rejectPromise) => {
    const previous = process.umask(umask);
    const server = createServer();
    server.once('error', (error) => {
      process.umask(previous);
      rejectPromise(error);
    });
    server.listen(socketPath, () => {
      process.umask(previous);
      resolvePromise(server);
    });
  });
}

test('socket server：目录 0700、socket 0600、同进程往返', { skip: skipWindows }, async (t) => {
  const base = scratch(t);
  const dir = join(base, 'sdo');
  const signerd = await startSignerd({ dir });
  t.after(() => signerd.close());

  assert.equal(formatMode(lstatSync(dir)), '0700');
  assert.equal(formatMode(lstatSync(signerd.socketPath)), '0600');
  const ping = await request(signerd.socketPath, { op: 'ping' });
  assert.equal(ping.ok, true);
  assert.equal(ping.pid, process.pid);

  const unlocked = await request(signerd.socketPath, {
    op: 'unlock',
    actor: 'human:spike',
    passphrase: 'correct horse battery staple',
  });
  assert.equal(unlocked.ok, true);
  const rejected = await request(signerd.socketPath, { op: 'unlock', actor: 'human:spike', passphrase: 'wrong' });
  assert.equal(rejected.error, 'bad_passphrase');
});

test('跨进程：spawn 出的 node 子进程能连上并得到同一个 signerd 的回复', { skip: skipWindows }, async (t) => {
  const base = scratch(t);
  const signerd = await startSignerd({ dir: join(base, 'sdo') });
  t.after(() => signerd.close());
  const child = await spawnClient(signerd.socketPath, { op: 'ping' });
  assert.equal(child.exitCode, 0);
  assert.equal(child.response.ok, true);
  assert.equal(child.response.pid, process.pid);
  assert.notEqual(child.pid, process.pid);
});

test('目录非 0700 ⇒ 拒绝启动，稳定码 socket_dir_insecure', { skip: skipWindows }, async (t) => {
  const base = scratch(t);
  const dir = join(base, 'wide');
  createOwnerOnlyDir(dir);
  chmodSync(dir, 0o755);
  await assert.rejects(
    () => startSignerd({ dir }),
    (error) => error.code === SOCKET_ERROR.dir_insecure,
  );
});

test('已有 socket 文件权限非 0600 ⇒ 拒绝启动，不盲目 unlink', { skip: skipWindows }, async (t) => {
  const base = scratch(t);
  const dir = join(base, 'stale');
  createOwnerOnlyDir(dir);
  const socketPath = join(dir, 'signerd.sock');
  const server = await listenDemo(socketPath, 0o022); // 默认 0755
  t.after(() => server.close());
  assert.equal(formatMode(lstatSync(socketPath)), '0755');
  await assert.rejects(
    () => startSignerd({ dir, socketPath }),
    (error) => error.code === SOCKET_ERROR.path_insecure,
  );
});

test('路径被普通文件占位 ⇒ 拒绝启动，稳定码 socket_path_not_socket', { skip: skipWindows }, async (t) => {
  const base = scratch(t);
  const dir = join(base, 'planted');
  createOwnerOnlyDir(dir);
  const socketPath = join(dir, 'signerd.sock');
  writeFileSync(socketPath, 'not a socket');
  await assert.rejects(
    () => startSignerd({ dir, socketPath }),
    (error) => error.code === SOCKET_ERROR.path_not_socket,
  );
});

test('客户端连宽权限 socket 也 fail-closed（0600 不是服务端单方面的事）', { skip: skipWindows }, async (t) => {
  const base = scratch(t);
  const dir = join(base, 'client');
  createOwnerOnlyDir(dir);
  const socketPath = join(dir, 'wide.sock');
  const server = await listenDemo(socketPath, 0o022);
  t.after(() => server.close());
  await assert.rejects(
    async () => request(socketPath, { op: 'ping' }),
    (error) => error.code === SOCKET_ERROR.path_insecure,
  );
  chmodSync(socketPath, 0o600);
  assert.equal(assertSecureSocketPath(socketPath).mode, '0600');
});

test('路径超过 sun_path 上限 ⇒ 稳定码 socket_path_too_long', { skip: skipWindows }, async (t) => {
  const base = scratch(t);
  const tooLong = join(base, 'x'.repeat(120), 'signerd.sock');
  assert.ok(Buffer.byteLength(tooLong) > 107);
  await assert.rejects(
    () => startSignerd({ dir: join(base, 'irrelevant'), socketPath: tooLong }),
    (error) => error.code === SOCKET_ERROR.path_too_long,
  );
});

test('Windows 边界：错误码与语义已文档化（M2 不支持 Windows，命名管道留 M4）', () => {
  assert.equal(SOCKET_ERROR.platform_unsupported, 'platform_unix_socket_unsupported');
  if (process.platform === 'win32') {
    assert.throws(() => startSignerd({ dir: 'C:\\tmp\\sdo' }), /unix domain socket/i);
  }
});

test('单实例（同进程）：第二次 start 必须 already_running，且不删活 socket', { skip: skipWindows }, async (t) => {
  const base = scratch(t);
  const dir = join(base, 'sdo');
  const first = await startSignerd({ dir });
  t.after(() => first.close());

  await assert.rejects(
    () => startSignerd({ dir }),
    (error) => error.code === SOCKET_ERROR.already_running,
  );
  assert.equal(formatMode(lstatSync(first.socketPath)), '0600');
  const ping = await request(first.socketPath, { op: 'ping' });
  assert.equal(ping.pid, process.pid);
});

test('单实例（跨进程）：两个子进程抢同一路径，第二个 already_running 且第一个仍服务；close 只删自己的 socket/锁', { skip: skipWindows }, async (t) => {
  const base = scratch(t);
  const dir = join(base, 'multi');
  const socketPath = join(dir, 'signerd.sock');
  const first = await spawnSignerd(dir, socketPath);
  t.after(async () => {
    try {
      await first.stop();
    } catch {
      /* 已退出 */
    }
  });

  const second = await spawnSignerd(dir, socketPath);
  assert.equal(second.message.ready, false);
  assert.equal(second.message.code, SOCKET_ERROR.already_running);
  assert.notEqual(await waitExit(second.child), 0);

  const ping = await request(socketPath, { op: 'ping' });
  assert.equal(ping.pid, first.message.pid);

  await first.stop();
  assert.equal(has(socketPath), false, 'close 应删掉自己的 socket');
  assert.equal(has(join(dir, 'signerd.lock')), false, 'close 应删掉自己的锁');

  const again = await startSignerd({ dir });
  assert.equal((await request(again.socketPath, { op: 'ping' })).pid, process.pid);
  await again.close();
});

test('死 pid 的陈旧锁视为崩溃残留，可接管并清掉旧锁', { skip: skipWindows }, async (t) => {
  const base = scratch(t);
  const dir = join(base, 'stale-lock');
  createOwnerOnlyDir(dir);
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await waitExit(dead);
  writeFileSync(join(dir, 'signerd.lock'), `${JSON.stringify({ pid: dead.pid, at: new Date().toISOString() })}\n`, {
    mode: 0o600,
  });
  chmodSync(join(dir, 'signerd.lock'), 0o600);

  const signerd = await startSignerd({ dir });
  assert.equal((await request(signerd.socketPath, { op: 'ping' })).pid, process.pid);
  await signerd.close();
  assert.equal(has(join(dir, 'signerd.lock')), false);
});

test('锁文件带 setuid/sticky 位（04600/01600）也拒 ⇒ 不能只看低 9 位', { skip: skipWindows }, async (t) => {
  for (const mode of [0o4600, 0o1600]) {
    const base = scratch(t);
    const dir = join(base, `bad-lock-${mode.toString(8)}`);
    createOwnerOnlyDir(dir);
    const lockPath = join(dir, 'signerd.lock');
    writeFileSync(lockPath, `${JSON.stringify({ pid: 1 })}\n`);
    chmodSync(lockPath, mode);
    await assert.rejects(
      () => startSignerd({ dir }),
      (error) => error.code === SOCKET_ERROR.lock_insecure,
    );
  }
});

test('锁文件权限非 0600 ⇒ fail-closed（signerd_lock_insecure）', { skip: skipWindows }, async (t) => {
  const base = scratch(t);
  const dir = join(base, 'bad-lock');
  createOwnerOnlyDir(dir);
  const lockPath = join(dir, 'signerd.lock');
  writeFileSync(lockPath, `${JSON.stringify({ pid: 1 })}\n`);
  chmodSync(lockPath, 0o644);
  await assert.rejects(
    () => startSignerd({ dir }),
    (error) => error.code === SOCKET_ERROR.lock_insecure,
  );
});
