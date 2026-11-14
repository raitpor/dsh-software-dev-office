#!/usr/bin/env node
// M2-0s spike：signerd 的 unix domain socket（零依赖）。
//
// 实测结论（原始输出见 artifacts/spike/unix-socket*.json）：
// - Node 可以起 unix socket server，跨进程（spawn 子进程）往返正常。
// - Node `listen(path)` 创建的 socket 文件权限是 `0777 & ~umask`（本机 umask 022 ⇒ 0755），
//   **不是 0600**。必须 listen 后显式 chmod 0600 并重新 lstat 校验；更稳的做法是
//   listen 期间把 umask 收紧到 077，让文件一出生就是 0700，再 chmod 0600。
// - Linux 的 `sun_path` 上限 108 字节（含结尾 NUL ⇒ 实际 107 字节），仓库深路径会
//   ENAMETOOLONG。运行时目录选 $XDG_RUNTIME_DIR/sdo（没有就 /tmp/sdo-<uid>），
//   不要放 ~/.local/state（路径太长）。
// - 单实例：<dir>/signerd.lock（0600、JSON {pid}）用 O_EXCL 原子抢锁；锁被活 pid 持有 ⇒
//   already_running，**绝不 unlink 别人的活 socket**。只有抢到锁后发现 0600 socket 才视为
//   崩溃遗留清理；本实例 close() 只删自己创建的 socket/锁。死 pid 的锁视为残留并接管。
// - 权限不符必须 fail-closed：目录非 0700、已有 socket 文件非 0600、路径是普通文件/符号
//   链接 ⇒ 拒绝启动，稳定错误码见 SOCKET_ERROR。
// - Windows 没有 unix domain socket：`process.platform === 'win32'` 时直接抛
//   platform_unix_socket_unsupported；M2 不支持 Windows，命名管道留 M4（见卡 C5）。
//
// 用法（仓库根）：
//   node scripts/spike/unix-socket.mjs                     # 跑完整场景，写 artifacts/spike/unix-socket.json
//   node scripts/spike/unix-socket.mjs --json <path>
// 内部：`node scripts/spike/unix-socket.mjs --client <socketPath> <json>`（spawn 的子进程角色）
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PermissionError,
  PERM_ERROR,
  assertOwnerOnlyDir,
  createOwnerOnlyDir,
  formatMode,
} from './fs-perms.mjs';

export const SOCKET_ERROR = Object.freeze({
  platform_unsupported: 'platform_unix_socket_unsupported',
  path_too_long: 'socket_path_too_long',
  path_missing: 'socket_path_missing',
  path_not_socket: 'socket_path_not_socket',
  path_insecure: 'socket_perm_insecure',
  dir_insecure: 'socket_dir_insecure',
  already_running: 'socket_already_in_use',
  lock_insecure: 'signerd_lock_insecure',
  connect_failed: 'socket_connect_failed',
  connect_timeout: 'socket_connect_timeout',
  protocol_error: 'socket_protocol_error',
});

export class SocketSecurityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SocketSecurityError';
    this.code = code;
    this.details = details;
  }
}

/** Linux `sun_path` 为 108 字节、需留结尾 NUL；macOS 为 104 字节。 */
export const SUN_PATH_MAX = Object.freeze({ linux: 107, darwin: 103, default: 103 });
const MAX_LINE_BYTES = 64 * 1024;
const LOCK_NAME = 'signerd.lock';

export function assertSocketPlatform() {
  if (process.platform === 'win32') {
    throw new SocketSecurityError(
      SOCKET_ERROR.platform_unsupported,
      'Windows has no unix domain sockets; signerd is Linux/macOS only in M2 (named pipes deferred to M4)',
    );
  }
}

export function checkSocketPathLength(socketPath) {
  assertSocketPlatform();
  const max = SUN_PATH_MAX[process.platform] ?? SUN_PATH_MAX.default;
  const bytes = Buffer.byteLength(socketPath);
  if (bytes > max) {
    throw new SocketSecurityError(
      SOCKET_ERROR.path_too_long,
      `socket path is ${bytes} bytes > ${max} (sun_path limit): ${socketPath}`,
      { path: socketPath, bytes, max },
    );
  }
  return { path: socketPath, bytes, max };
}

/**
 * 运行时目录：优先 $XDG_RUNTIME_DIR（/run/user/1000，短路径、tmpfs、0700 父目录），
 * 否则 /tmp/sdo-<uid>。不要用 ~/.local/state（sun_path 装不下）。
 */
export function runtimeDir({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return null;
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg && xdg.length > 0) return join(xdg, 'sdo');
  return join(os.tmpdir(), `sdo-${process.getuid?.() ?? 'user'}`);
}

function ownerProblem(stat, path) {
  const uid = process.getuid?.();
  if (typeof uid !== 'number') return null;
  if (uid === 0) return null;
  if (stat.uid !== uid) {
    return new PermissionError(PERM_ERROR.owner_mismatch, `socket owner uid=${stat.uid} != process uid=${uid}`, {
      path,
      ownerUid: stat.uid,
      processUid: uid,
    });
  }
  return null;
}

/** 目录必须存在且恰为 0700；否则 fail-closed。 */
export function prepareRuntimeDir(dir, { create = true } = {}) {
  assertSocketPlatform();
  if (!exists(dir)) {
    if (!create) throw new SocketSecurityError(SOCKET_ERROR.dir_insecure, `runtime dir missing: ${dir}`, { path: dir });
    return createOwnerOnlyDir(dir);
  }
  try {
    return assertOwnerOnlyDir(dir, { code: SOCKET_ERROR.dir_insecure });
  } catch (error) {
    if (error instanceof PermissionError) {
      throw new SocketSecurityError(error.code, error.message, error.details);
    }
    throw error;
  }
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // 存在但无权限发信号 ⇒ 仍算活
  }
}

/** 读锁文件并校验：普通文件、恰 0600、JSON {pid}。空文件视为过期残留返回 null。 */
export function readLockInfo(lockPath) {
  let stat;
  try {
    stat = lstatSync(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) {
    throw new SocketSecurityError(SOCKET_ERROR.lock_insecure, `lock path is not a regular file: ${lockPath}`, { path: lockPath });
  }
  // 用 07777：带 setuid/setgid/sticky 的锁文件（如 04600）不该被当成 0600 放行。
  const rawMode = stat.mode & 0o7777;
  const mode = `0${rawMode.toString(8).padStart(4, '0')}`;
  if (rawMode !== 0o600) {
    throw new SocketSecurityError(SOCKET_ERROR.lock_insecure, `lock file mode ${mode} is not 0600: ${lockPath}`, {
      path: lockPath,
      mode,
      expected: '0600',
    });
  }
  const raw = readFileSync(lockPath, 'utf8').trim();
  if (raw.length === 0) return null;
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    throw new SocketSecurityError(SOCKET_ERROR.lock_insecure, `lock file is corrupt: ${lockPath}`, { path: lockPath });
  }
  if (!Number.isInteger(info?.pid) || info.pid <= 0) {
    throw new SocketSecurityError(SOCKET_ERROR.lock_insecure, `lock file has invalid pid: ${lockPath}`, { path: lockPath });
  }
  return info;
}

/**
 * 抢单实例锁（O_EXCL 原子创建）：锁被活 pid 持有 ⇒ already_running；死 pid / 空文件 ⇒
 * 视为崩溃残留，删掉重抢（最多 3 次，处理两个进程同时清理残留的竞态）。
 */
export function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd = null;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = readLockInfo(lockPath);
      if (info && processAlive(info.pid)) {
        throw new SocketSecurityError(
          SOCKET_ERROR.already_running,
          `signerd already running (pid ${info.pid}): ${lockPath}`,
          { path: lockPath, pid: info.pid },
        );
      }
      rmSync(lockPath, { force: true });
      continue;
    }
    try {
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
      chmodSync(lockPath, 0o600);
    } finally {
      closeSync(fd);
    }
    return {
      path: lockPath,
      pid: process.pid,
      release() {
        try {
          const info = readLockInfo(lockPath);
          if (info && info.pid === process.pid) rmSync(lockPath, { force: true });
        } catch {
          /* 锁已损坏/已删：退出路径不能因此卡住 */
        }
      },
    };
  }
  throw new SocketSecurityError(SOCKET_ERROR.already_running, `could not acquire signerd lock: ${lockPath}`, { path: lockPath });
}

/**
 * 校验一个已存在的 socket 文件：必须是 socket（不是符号链接/普通文件）、属主是我、
 * 权限恰为 0600。客户端在 connect 前也走这一步（fail-closed）。
 */
export function assertSecureSocketPath(socketPath) {
  checkSocketPathLength(socketPath);
  let stat;
  try {
    stat = lstatSync(socketPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new SocketSecurityError(SOCKET_ERROR.path_missing, `socket not found: ${socketPath}`, { path: socketPath });
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new SocketSecurityError(SOCKET_ERROR.path_not_socket, `socket path is a symlink: ${socketPath}`, {
      path: socketPath,
    });
  }
  if (!stat.isSocket()) {
    throw new SocketSecurityError(SOCKET_ERROR.path_not_socket, `socket path is not a socket: ${socketPath}`, {
      path: socketPath,
      mode: formatMode(stat),
    });
  }
  const ownerIssue = ownerProblem(stat, socketPath);
  if (ownerIssue) throw new SocketSecurityError(ownerIssue.code, ownerIssue.message, ownerIssue.details);
  const mode = formatMode(stat);
  if (mode !== '0600') {
    throw new SocketSecurityError(
      SOCKET_ERROR.path_insecure,
      `socket mode ${mode} is not 0600: ${socketPath}`,
      { path: socketPath, mode, expected: '0600' },
    );
  }
  return { path: socketPath, mode, uid: stat.uid };
}

/** listen 期间把 umask 收紧，避免 socket 文件以 0755 出生（进程级 umask，注意并发副作用）。 */
async function withUmask(mask, fn) {
  const previous = process.umask(mask);
  try {
    return await fn();
  } finally {
    process.umask(previous);
  }
}

function handleConnection(socket, { onRequest, log }) {
  let buffer = '';
  let closed = false;
  const fail = (code, message) => {
    if (closed) return;
    closed = true;
    socket.end(`${JSON.stringify({ error: code, message })}\n`);
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      fail(SOCKET_ERROR.protocol_error, 'request line too long');
      socket.destroy();
      return;
    }
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.length === 0) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        fail(SOCKET_ERROR.protocol_error, 'malformed JSON');
        socket.destroy();
        return;
      }
      const response = onRequest(request, { log });
      socket.write(`${JSON.stringify(response)}\n`);
    }
  });
  socket.on('error', () => {
    /* 客户端断开不是错误 */
  });
}

/**
 * 起 signerd 的 socket 监听（spike 版协议：ping / unlock / sign / lock，JSON per line）。
 * 返回 `{ server, socketPath, dir, mode, log, close() }`。
 */
export async function startSignerd({ dir = runtimeDir(), socketPath = dir ? join(dir, 'signerd.sock') : null, onRequest } = {}) {
  assertSocketPlatform();
  checkSocketPathLength(socketPath);
  const dirInfo = prepareRuntimeDir(dir);

  // 单实例：先原子抢锁，再碰 socket 文件。活实例一定持锁 ⇒ 持锁时发现的 0600 socket
  // 只能是崩溃遗留；锁被活进程持有 ⇒ already_running，不碰对方的 socket。
  const lock = acquireLock(join(dir, LOCK_NAME));
  let createdSocket = false;
  const log = [];
  const server = net.createServer();
  const protocol = { onRequest: onRequest ?? defaultHandler };
  server.on('connection', (socket) => handleConnection(socket, { onRequest: protocol.onRequest, log }));

  try {
    if (exists(socketPath)) {
      const stat = lstatSync(socketPath);
      if (!stat.isSocket()) {
        throw new SocketSecurityError(
          SOCKET_ERROR.path_not_socket,
          `refusing to start: path exists and is not a socket: ${socketPath}`,
          { path: socketPath, mode: formatMode(stat) },
        );
      }
      const ownerIssue = ownerProblem(stat, socketPath);
      if (ownerIssue) throw new SocketSecurityError(ownerIssue.code, ownerIssue.message, ownerIssue.details);
      const staleMode = formatMode(stat);
      if (staleMode !== '0600') {
        throw new SocketSecurityError(
          SOCKET_ERROR.path_insecure,
          `refusing to start: existing socket mode ${staleMode} is not 0600: ${socketPath}`,
          { path: socketPath, mode: staleMode, expected: '0600' },
        );
      }
      // 锁在我手里 + socket 是 0600 ⇒ 没有活实例在用，属崩溃遗留，安全 unlink。
      rmSync(socketPath, { force: true });
    }

    await withUmask(0o077, () => new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(socketPath, () => {
        server.removeListener('error', rejectPromise);
        resolvePromise();
      });
    }));
    createdSocket = true;
    chmodSync(socketPath, 0o600); // umask 077 让 socket 出生即 0700（无 0755 窗口），最终显式 0600
    const checked = assertSecureSocketPath(socketPath);
    return {
      server,
      socketPath,
      dir,
      dirMode: dirInfo.mode,
      mode: checked.mode,
      log,
      lockPath: lock.path,
      pid: process.pid,
      async close() {
        await closeServer(server);
        if (createdSocket && exists(socketPath)) {
          const stat = lstatSync(socketPath);
          if (stat.isSocket()) rmSync(socketPath, { force: true });
        }
        lock.release();
      },
    };
  } catch (error) {
    await closeServer(server);
    if (createdSocket && exists(socketPath)) {
      try {
        if (lstatSync(socketPath).isSocket()) rmSync(socketPath, { force: true });
      } catch {
        /* 清理尽力而为 */
      }
    }
    lock.release();
    if (error.code === 'EADDRINUSE') {
      throw new SocketSecurityError(SOCKET_ERROR.already_running, `another signerd is listening: ${socketPath}`, {
        path: socketPath,
      });
    }
    throw error;
  }
}

/** spike 版协议处理：不落任何口令/长度；签名只做加盐哈希占位（真 Ed25519 在 M2 实现）。 */
export function defaultHandler(request, { log } = {}) {
  const op = request?.op;
  log?.push({ op: typeof op === 'string' ? op : 'invalid', at: new Date().toISOString() });
  if (op === 'ping') return { ok: true, pid: process.pid, uid: process.getuid?.() ?? null };
  if (op === 'unlock') {
    if (typeof request.actor !== 'string' || request.actor.length === 0) return { error: 'bad_request' };
    if (typeof request.passphrase !== 'string' || request.passphrase.length === 0) return { error: 'bad_passphrase' };
    if (request.passphrase !== 'correct horse battery staple') return { error: 'bad_passphrase' };
    return { ok: true, window_until: null };
  }
  if (op === 'sign') {
    if (typeof request.payload_hash !== 'string' || typeof request.frontier_hash !== 'string') {
      return { error: 'bad_request' };
    }
    const digest = createHash('sha256')
      .update(`${request.payload_hash}\u0000${request.frontier_hash}\u0000${request.nonce ?? ''}`)
      .digest('hex');
    return { ok: true, signature: `spike-not-ed25519:${digest}`, method: 'ed25519', key_id: 'k-spike' };
  }
  if (op === 'lock') return { ok: true };
  return { error: 'bad_request' };
}

/** 客户端：先 fail-closed 校验 socket 权限，再发一行 JSON，等一行回复。 */
export function request(socketPath, message, { timeoutMs = 3000 } = {}) {
  assertSecureSocketPath(socketPath);
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => {
      done(new SocketSecurityError(SOCKET_ERROR.connect_timeout, `timed out after ${timeoutMs}ms: ${socketPath}`));
    }, timeoutMs);
    timer.unref?.();
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      try {
        done(null, JSON.parse(buffer.slice(0, newline)));
      } catch {
        done(new SocketSecurityError(SOCKET_ERROR.protocol_error, 'malformed response'));
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      done(
        new SocketSecurityError(SOCKET_ERROR.connect_failed, `connect failed: ${error.message}`, {
          path: socketPath,
          cause: error.code,
        }),
      );
    });
  });
}

/** 另起一个 node 进程当客户端，证明「跨进程」而不是同进程假通。 */
export function spawnClient(socketPath, message, { timeoutMs = 10_000 } = {}) {
  const script = fileURLToPath(import.meta.url);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, '--client', socketPath, JSON.stringify(message)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new SocketSecurityError(SOCKET_ERROR.connect_timeout, `client process timed out: ${socketPath}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lastLine = stdout.trim().split('\n').pop() ?? '';
      let parsed = null;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        /* 下面统一报错 */
      }
      resolvePromise({ exitCode: code, response: parsed, stdout: stdout.trim(), stderr: stderr.trim(), pid: child.pid });
    });
  });
}

/** 起一个独立 node 进程跑真 signerd（`--serve <dir> <socketPath>`），就绪后回传 pid。 */
export function spawnSignerd(dir, socketPath) {
  const script = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [script, '--serve', dir, socketPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new SocketSecurityError(SOCKET_ERROR.connect_timeout, `signerd child timed out: ${socketPath}`));
    }, 15_000);
    const onData = () => {
      const line = stdout.split('\n').find((entry) => entry.trim().length > 0);
      if (!line) return;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise({
        child,
        message,
        pid: child.pid,
        output: () => `${stdout}${stderr}`,
        async stop() {
          child.kill('SIGTERM');
          await waitExit(child);
        },
      });
    };
    child.stdout.on('data', onData);
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
}

export function waitExit(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null) {
      resolvePromise(child.exitCode);
      return;
    }
    child.once('exit', (code, signal) => resolvePromise(code ?? signal));
  });
}

// ---------------------------------------------------------------------------
// 完整场景 + CLI
// ---------------------------------------------------------------------------

export async function runSpike({ root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..') } = {}) {
  const base = mkdtempSync(join(os.tmpdir(), 'sdo-spike-'));
  const secureDir = join(base, 'sdo');
  const evidence = {
    spike: 'M2-0s/unix-socket',
    at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    uid: process.getuid?.() ?? null,
    umask: formatUmask(process.umask()),
    sun_path_max: SUN_PATH_MAX[process.platform] ?? SUN_PATH_MAX.default,
    windows_behavior:
      process.platform === 'win32'
        ? 'unsupported: throws platform_unix_socket_unsupported'
        : 'not exercised on this host; M2 supports Linux/macOS only',
    checks: [],
  };
  const record = (name, ok, detail) => {
    evidence.checks.push({ check: name, ok, ...detail });
    return ok;
  };

  let signerd = null;
  try {
    prepareRuntimeDir(secureDir);
    signerd = await startSignerd({ dir: secureDir });
    const dirStat = lstatSync(secureDir);
    const sockStat = lstatSync(signerd.socketPath);

    record('runtime_dir_0700', formatMode(dirStat) === '0700', { mode: formatMode(dirStat), path: secureDir });
    record('socket_0600', formatMode(sockStat) === '0600', {
      mode: formatMode(sockStat),
      path: signerd.socketPath,
      pathBytes: Buffer.byteLength(signerd.socketPath),
    });

    const ping = await request(signerd.socketPath, { op: 'ping' });
    record('in_process_ping', ping.ok === true && ping.pid === process.pid, { response: ping });

    const child = await spawnClient(signerd.socketPath, { op: 'ping' });
    record('cross_process_ping', child.exitCode === 0 && child.response?.pid === process.pid && child.pid !== process.pid, {
      child_pid: child.pid,
      server_pid: process.pid,
      response: child.response,
      exit_code: child.exitCode,
    });

    // 单实例（同进程）：第二次 start 必须 already_running，且不能删掉第一次的活 socket。
    let secondStart;
    try {
      const duplicate = await startSignerd({ dir: secureDir });
      await duplicate.close();
      secondStart = { refused: false };
    } catch (error) {
      secondStart = { refused: true, code: error.code, message: error.message };
    }
    const pingAfterSecond = await request(signerd.socketPath, { op: 'ping' });
    record(
      'single_instance_same_process_refused',
      secondStart.refused === true && secondStart.code === SOCKET_ERROR.already_running && pingAfterSecond.pid === process.pid,
      { second_start: secondStart, first_still_serves: pingAfterSecond.pid === process.pid },
    );

    // socket 出生权限：listen 期间 umask 077 ⇒ 出生即 0700（证明没有 0755 窗口），随后 chmod 0600。
    const birthDir = join(base, 'birth');
    createOwnerOnlyDir(birthDir);
    const birthPath = join(birthDir, 'birth.sock');
    const birthServer = net.createServer();
    const birthMode = await withUmask(0o077, () => new Promise((resolvePromise, rejectPromise) => {
      birthServer.once('error', rejectPromise);
      birthServer.listen(birthPath, () => {
        birthServer.removeListener('error', rejectPromise);
        resolvePromise(formatMode(lstatSync(birthPath)));
      });
    }));
    record('socket_birth_mode_with_umask_077', birthMode === '0700', {
      mode: birthMode,
      note: 'listen 期间 umask 077 ⇒ 出生 0700，无 0755 窗口；随后显式 chmod 0600',
    });
    await new Promise((resolvePromise) => birthServer.close(resolvePromise));
    rmSync(birthPath, { force: true });

    const passphrase = 'correct horse battery staple';
    const goodUnlock = await request(signerd.socketPath, { op: 'unlock', actor: 'human:raiptor', passphrase });
    const badUnlock = await request(signerd.socketPath, { op: 'unlock', actor: 'human:raiptor', passphrase: `${passphrase}!` });
    record('unlock_ok', goodUnlock.ok === true, { response: goodUnlock });
    record('wrong_passphrase_bad_passphrase', badUnlock.error === 'bad_passphrase', { response: badUnlock });
    const sign = await request(signerd.socketPath, {
      op: 'sign',
      actor: 'human:raiptor',
      payload_hash: 'a'.repeat(64),
      frontier_hash: 'b'.repeat(64),
      nonce: 'n-1',
    });
    record('sign_returns_key_id_and_method', sign.ok === true && sign.key_id === 'k-spike' && sign.method === 'ed25519', {
      response: sign,
    });
    const protocolLog = JSON.stringify(signerd.log);
    record('protocol_log_has_no_passphrase', !protocolLog.includes(passphrase), {
      logged_ops: signerd.log.map((entry) => entry.op),
      log_bytes: Buffer.byteLength(protocolLog),
    });

    // 默认权限演示：不 chmod 的 socket 出生权限 = 0777 & ~umask。
    const demoDir = join(base, 'demo');
    createOwnerOnlyDir(demoDir);
    const demoPath = join(demoDir, 'default.sock');
    const demoSocket = net.createServer();
    const demoMode = await withUmask(0o022, () => new Promise((resolvePromise, rejectPromise) => {
      demoSocket.once('error', rejectPromise);
      demoSocket.listen(demoPath, () => {
        demoSocket.removeListener('error', rejectPromise);
        resolvePromise(formatMode(lstatSync(demoPath)));
      });
    }));
    record('default_socket_mode_demo', true, { mode: demoMode, note: '0777 & ~umask(022) = 0755，必须 chmod 0600' });
    await new Promise((resolvePromise) => demoSocket.close(resolvePromise));
    // 客户端遇宽权限 socket 必须拒绝（即便 server 还活着）。
    const demo2 = net.createServer();
    const demo2Mode = await withUmask(0o077, () => new Promise((resolvePromise, rejectPromise) => {
      demo2.once('error', rejectPromise);
      demo2.listen(demoPath, () => {
        demo2.removeListener('error', rejectPromise);
        resolvePromise(formatMode(lstatSync(demoPath)));
      });
    }));
    let insecureSocketRefused = null;
    try {
      assertSecureSocketPath(demoPath);
      insecureSocketRefused = { refused: false, mode: demo2Mode };
    } catch (error) {
      insecureSocketRefused = { refused: true, mode: demo2Mode, code: error.code };
    }
    record('client_refuses_insecure_socket', insecureSocketRefused.refused === true, insecureSocketRefused);
    await new Promise((resolvePromise) => demo2.close(resolvePromise));

    // 目录 0755 ⇒ 拒绝启动。
    const badDir = join(base, 'bad-dir');
    createOwnerOnlyDir(badDir);
    chmodSync(badDir, 0o755);
    let badDirResult;
    try {
      await startSignerd({ dir: badDir });
      badDirResult = { refused: false };
    } catch (error) {
      badDirResult = { refused: true, code: error.code, message: error.message };
    }
    record('refuse_start_when_dir_insecure', badDirResult.refused === true && badDirResult.code === SOCKET_ERROR.dir_insecure, badDirResult);

    // 已有 socket 文件 0755（模拟崩溃遗留/被替换）⇒ 拒绝启动，不盲目 unlink。
    const staleDir = join(base, 'stale');
    createOwnerOnlyDir(staleDir);
    const stalePath = join(staleDir, 'signerd.sock');
    const staleServer = net.createServer();
    await withUmask(0o022, () => new Promise((resolvePromise, rejectPromise) => {
      staleServer.once('error', rejectPromise);
      staleServer.listen(stalePath, () => {
        staleServer.removeListener('error', rejectPromise);
        resolvePromise();
      });
    }));
    let staleResult;
    try {
      await startSignerd({ dir: staleDir, socketPath: stalePath });
      staleResult = { refused: false };
    } catch (error) {
      staleResult = { refused: true, code: error.code, mode: formatMode(lstatSync(stalePath)) };
    }
    record('refuse_start_when_socket_insecure', staleResult.refused === true && staleResult.code === SOCKET_ERROR.path_insecure, staleResult);
    await new Promise((resolvePromise) => staleServer.close(resolvePromise));

    // 路径过长 ⇒ 稳定错误码（先于任何 FS 操作）。
    const longPath = join(base, 'x'.repeat(120), 'signerd.sock');
    let longResult;
    try {
      checkSocketPathLength(longPath);
      longResult = { refused: false };
    } catch (error) {
      longResult = { refused: true, code: error.code, bytes: Buffer.byteLength(longPath) };
    }
    record('refuse_start_when_path_too_long', longResult.refused === true && longResult.code === SOCKET_ERROR.path_too_long, longResult);

    // 普通文件占位 ⇒ 拒绝启动。
    const plantedDir = join(base, 'planted');
    createOwnerOnlyDir(plantedDir);
    const plantedPath = join(plantedDir, 'signerd.sock');
    rmSync(plantedPath, { force: true });
    writeFileSync(plantedPath, 'not a socket');
    let plantedResult;
    try {
      await startSignerd({ dir: plantedDir, socketPath: plantedPath });
      plantedResult = { refused: false };
    } catch (error) {
      plantedResult = { refused: true, code: error.code };
    }
    record('refuse_start_when_path_is_regular_file', plantedResult.refused === true && plantedResult.code === SOCKET_ERROR.path_not_socket, plantedResult);

    // 单实例（跨进程）：两个子进程抢同一路径，第二个必须 already_running 且第一个仍可服务。
    const multiDir = join(base, 'multi');
    createOwnerOnlyDir(multiDir);
    const multiSock = join(multiDir, 'signerd.sock');
    const firstProc = await spawnSignerd(multiDir, multiSock);
    const secondProc = await spawnSignerd(multiDir, multiSock);
    const secondExit = await waitExit(secondProc.child);
    const firstPing = await request(multiSock, { op: 'ping' });
    record(
      'single_instance_cross_process_refused',
      secondProc.message.ready === false &&
        secondProc.message.code === SOCKET_ERROR.already_running &&
        secondExit !== 0 &&
        firstPing.pid === firstProc.message.pid,
      {
        first_pid: firstProc.message.pid,
        second_code: secondProc.message.code,
        second_exit: secondExit,
        first_still_serves: firstPing.pid === firstProc.message.pid,
      },
    );
    await firstProc.stop();
    record(
      'close_removes_own_socket_and_lock',
      !exists(multiSock) && !exists(join(multiDir, LOCK_NAME)),
      { socket_still_exists: exists(multiSock), lock_still_exists: exists(join(multiDir, LOCK_NAME)) },
    );
    const restarted = await startSignerd({ dir: multiDir, socketPath: multiSock });
    const restartedPing = await request(multiSock, { op: 'ping' });
    await restarted.close();
    record('restart_after_previous_close', restartedPing.pid === process.pid, { pid: restartedPing.pid });

    // 死 pid 的陈旧锁 ⇒ 视为崩溃残留，可接管（并清掉旧锁）。
    const staleLockDir = join(base, 'stale-lock');
    createOwnerOnlyDir(staleLockDir);
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    await waitExit(dead);
    writeFileSync(join(staleLockDir, LOCK_NAME), `${JSON.stringify({ pid: dead.pid, at: new Date().toISOString() })}\n`, {
      mode: 0o600,
    });
    chmodSync(join(staleLockDir, LOCK_NAME), 0o600);
    const revived = await startSignerd({ dir: staleLockDir });
    await revived.close();
    record('stale_lock_dead_pid_recovered', true, { dead_pid: dead.pid });

    evidence.ok = evidence.checks.every((check) => check.ok);
    return evidence;
  } finally {
    if (signerd) await signerd.close();
    rmSync(base, { recursive: true, force: true });
  }
}

function formatUmask(value) {
  return `0${(value & 0o777).toString(8).padStart(3, '0')}`;
}

function parseArgs(argv) {
  const options = { client: null, json: join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'artifacts', 'spike', 'unix-socket.json') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--client') {
      options.client = { socketPath: argv[i + 1], message: argv[i + 2] };
      i += 2;
    } else if (argv[i] === '--serve') {
      options.serve = { dir: argv[i + 1], socketPath: argv[i + 2] };
      i += 2;
    } else if (argv[i] === '--json') {
      options.json = resolve(argv[++i]);
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      options.help = true;
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node scripts/spike/unix-socket.mjs [--json <path>]');
    return 0;
  }
  if (options.client) {
    try {
      const response = await request(options.client.socketPath, JSON.parse(options.client.message));
      process.stdout.write(`${JSON.stringify(response)}\n`);
      return 0;
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ error: error.code ?? error.name, message: error.message })}\n`);
      return 2;
    }
  }
  if (options.serve) {
    let signerd;
    try {
      signerd = await startSignerd({ dir: options.serve.dir, socketPath: options.serve.socketPath });
      process.stdout.write(
        `${JSON.stringify({ ready: true, pid: process.pid, socketPath: signerd.socketPath, mode: signerd.mode })}\n`,
      );
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ready: false, code: error.code ?? error.name, message: error.message })}\n`);
      return 2;
    }
    const shutdown = () => {
      signerd.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    await new Promise(() => {});
  }
  const evidence = await runSpike();
  writeFileSync(options.json, `${JSON.stringify(evidence, null, 2)}\n`);
  for (const check of evidence.checks) {
    console.log(`${check.ok ? '[pass]' : '[FAIL]'} ${check.check} ${JSON.stringify({ ...check, check: undefined, ok: undefined })}`);
  }
  console.log(`--- ok=${evidence.ok} json: ${options.json}`);
  return evidence.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
