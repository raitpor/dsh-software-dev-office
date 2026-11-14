/**
 * signerd 的路径规则（C2/C5）。
 *
 * - keyring / receipts / window 等持久态：固定 `~/.local/state/sdo/signerd`，
 *   目录 0700、文件 0600；**不与 SDO 库混放**。D-054：产品代码不读任何“home
 *   覆盖”环境变量（信任根必须有固定锚点）；测试/嵌入方只能通过显式参数注入。
 * - socket：`$XDG_RUNTIME_DIR/sdo/signerd.sock`，否则 `/tmp/sdo-<uid>/signerd.sock`；
 *   绝不默认放 `~/.local/state`——Linux `sun_path` 只有 107 字节（见 M2-0s E7）。
 * - Windows 无 unix socket 语义：起手 `platform_unsupported`（D-050），M2 不实现。
 */
import { homedir, tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';

import { SignError } from './errors.js';

/** Linux `sun_path` 是 108 字节含结尾 NUL，因此路径 UTF-8 字节数上限 107。 */
export const SUN_PATH_MAX_BYTES = 107;

export interface SignerdPaths {
  /** 持久目录（keyring/receipts/window），0700。 */
  readonly home: string;
  /** socket 所在目录，0700。 */
  readonly runtimeDir: string;
  readonly socket: string;
  readonly keyFile: string;
  readonly keyringFile: string;
  readonly receiptsFile: string;
  readonly windowFile: string;
  readonly capabilityFile: string;
  readonly lockFile: string;
}

/** 显式注入（测试/嵌入方）；产品 CLI 不读环境变量来改信任根（D-054）。 */
export interface SignerdPathOptions {
  readonly homeDir?: string | undefined;
  readonly runtimeDir?: string | undefined;
  readonly socketPath?: string | undefined;
}

/** 固定信任根：`<state>/sdo/signerd`（state 缺省 `~/.local/state`）。 */
export function defaultSignerdHome(): string {
  return join(homedir(), '.local', 'state', 'sdo', 'signerd');
}

export function runtimeDir(): string {
  const xdg = process.env['XDG_RUNTIME_DIR'];
  if (xdg !== undefined && xdg.length > 0) return join(xdg, 'sdo');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return join(tmpdir(), `sdo-${String(uid)}`);
}

export function assertPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    throw new SignError(
      'platform_unsupported',
      'signerd 依赖 unix domain socket；Windows 不支持（D-050，M2 只支持 Linux/macOS）',
    );
  }
}

export function assertSocketPathLength(path: string): void {
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes > SUN_PATH_MAX_BYTES) {
    throw new SignError(
      'socket_path_too_long',
      `socket 路径 ${path} 长 ${String(bytes)} 字节，超过 sun_path 上限 ${String(SUN_PATH_MAX_BYTES)}`,
    );
  }
}

export function signerdPaths(options: SignerdPathOptions = {}): SignerdPaths {
  assertPlatform();
  const home = options.homeDir ?? defaultSignerdHome();
  // 显式给 socket 路径时，runtime 目录跟随 socket 所在目录（避免依赖 XDG_RUNTIME_DIR）。
  const dir = options.runtimeDir ?? (options.socketPath === undefined ? runtimeDir() : dirname(options.socketPath));
  const socket = options.socketPath ?? join(dir, 'signerd.sock');
  assertSocketPathLength(socket);
  return {
    home,
    runtimeDir: dir,
    socket,
    keyFile: join(home, 'signing_key.json'),
    keyringFile: join(home, 'public_keys.json'),
    receiptsFile: join(home, 'receipts.jsonl'),
    windowFile: join(home, 'window.json'),
    capabilityFile: join(home, 'client.capability'),
    lockFile: join(home, 'signerd.lock'),
  };
}
