/**
 * signerd 生命周期（M5-0 C4，仅适配器侧）。
 *
 * 不改 signerd 入口：用 `node scripts/signerd.mjs serve` 起既有进程；这里只负责
 * spawn、等 socket、停进程与清理。0600/0700、单实例锁、kill -9 恢复都沿用 signerd 自身实现。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SignerdClient } from '../sign/client.js';
import { signerdPaths } from '../sign/paths.js';

export interface SignerdProcessHandle {
  readonly owned: true;
  readonly pid: number | undefined;
  readonly socketPath: string;
  readonly home: string;
  stop(): Promise<boolean>;
  kill9(): void;
}

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

export function signerdScript(): string {
  return join(packageRoot(), 'scripts', 'signerd.mjs');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function isSignerdRunning(home: string, socketPath?: string): Promise<boolean> {
  try {
    const paths = signerdPaths(socketPath === undefined ? { homeDir: home } : { homeDir: home, socketPath });
    const status = await new SignerdClient({ paths }).status();
    return (status as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/** 起一个 signerd 子进程；已有实例在跑 ⇒ `signerd_already_running`。 */
export async function startSignerdProcess(options: {
  readonly home: string;
  readonly passphrase: string;
  readonly socketPath?: string;
  readonly timeoutMs?: number;
  /** 测试用故障注入：替换 signerd 入口脚本（默认用包内 scripts/signerd.mjs）。 */
  readonly scriptPath?: string;
  /** 测试用故障注入：stop 等待时长；0 表示 SIGTERM 后立即 SIGKILL 并如实返回未确认。 */
  readonly stopTimeoutMs?: number;
  /** C14：签字页固定单次解锁（TTL=0）。 */
  readonly windowTtlMinutes?: 0 | 5 | 15 | 60;
}): Promise<SignerdProcessHandle> {
  const paths = signerdPaths(options.socketPath === undefined ? { homeDir: options.home } : { homeDir: options.home, socketPath: options.socketPath });
  if (await isSignerdRunning(options.home, options.socketPath)) {
    throw new Error('signerd_already_running');
  }
  if (!existsSync(paths.keyFile)) {
    throw new Error('store_not_initialized');
  }
  const script = options.scriptPath ?? signerdScript();
  const args = [script, 'serve', '--home', options.home];
  if (options.socketPath !== undefined) args.push('--socket', options.socketPath);
  const child: ChildProcess = spawn(process.execPath, args, {
    env: {
      ...process.env,
      SDO_SIGNERD_PASSPHRASE: options.passphrase,
      ...(options.windowTtlMinutes === undefined ? {} : { SDO_SIGNERD_WINDOW_TTL_MINUTES: String(options.windowTtlMinutes) }),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // spawn 自身失败会发 'error'；不监听会变成宿主未捕获异常。
  let spawnError: Error | undefined;
  child.on('error', (error: Error) => {
    spawnError = error;
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const deadline = Date.now() + (options.timeoutMs ?? 8000);
  for (;;) {
    if (spawnError !== undefined) {
      await cleanupSignerd(options.home, paths.socket);
      throw new Error(`signerd_spawn_failed:${spawnError.message}`);
    }
    if (child.exitCode !== null) {
      throw new Error(`signerd_exited:${String(child.exitCode)}${stderr.length > 0 ? `:${stderr.trim()}` : ''}`);
    }
    if (await isSignerdRunning(options.home, options.socketPath)) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (isExited(child)) return resolve();
        child.once('exit', () => resolve());
        setTimeout(resolve, 1000);
      });
      // P3-2：超时分支清掉本次启动可能留下的 socket/lock，否则 dispose 拿不到 handle 就清不到。
      await cleanupSignerd(options.home, paths.socket);
      throw new Error('signerd_start_timeout');
    }
    await sleep(40);
  }
  return {
    owned: true,
    pid: child.pid,
    socketPath: paths.socket,
    home: options.home,
    async stop(): Promise<boolean> {
      if (isExited(child)) return true;
      const waitMs = options.stopTimeoutMs ?? 3000;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(waitMs)]);
      if (!isExited(child)) {
        child.kill('SIGKILL');
        await Promise.race([exited, sleep(waitMs)]);
      }
      return isExited(child);
    },
    kill9() {
      if (!isExited(child)) child.kill('SIGKILL');
    },
  };
}

/** 卸载清理：删 socket/lock 残留；数据（keyring）不动。`keepSocket` 用于 stop 未确认成功时。 */
export async function cleanupSignerd(
  home: string,
  socketPath?: string,
  options: { readonly keepSocket?: boolean } = {},
): Promise<void> {
  const paths = signerdPaths(socketPath === undefined ? { homeDir: home } : { homeDir: home, socketPath });
  const { unlinkSync } = await import('node:fs');
  const targets = options.keepSocket === true ? [paths.lockFile] : [paths.socket, paths.lockFile];
  for (const path of targets) {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // 清理 best-effort；不掩盖主流程错误
    }
  }
}

/**
 * P3-3：stop 的收尾。只有确认进程已退出才删 socket；否则保留 socket、仅清 lock，并让调用方记
 * `signerd_stop_incomplete`——避免“进程还活着但端点被删”的外部不可达。
 */
export async function afterSignerdStop(
  handle: SignerdProcessHandle,
  stopped: boolean,
  onIncomplete: (detail: { readonly pid: number | undefined; readonly socket: string }) => void,
): Promise<void> {
  if (stopped) {
    await cleanupSignerd(handle.home, handle.socketPath);
    return;
  }
  await cleanupSignerd(handle.home, handle.socketPath, { keepSocket: true });
  onIncomplete({ pid: handle.pid, socket: handle.socketPath });
}
