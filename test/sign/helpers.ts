/**
 * M2-0 测试装配：临时 signerd home/runtime + 真 signerd 进程内启动 + 真 client。
 *
 * D-054：产品不读 `SDO_SIGNERD_HOME` 之类的信任根覆盖 env；测试用标准 `HOME`
 * 指向临时目录（`HOME` 只决定 `<state>` 位置，不是信任根覆盖），并把同一路径
 * 显式传给 signerd/client。写网关按默认 `<state>/sdo/signerd` 找到同一 home。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SignerdClient } from '../../src/sign/client.js';
import { signerdPaths, type SignerdPaths } from '../../src/sign/paths.js';
import { initializeSignerd, startSignerd, type RunningSignerd } from '../../src/sign/signerd.js';
import type { WindowTtlMinutes } from '../../src/sign/window.js';

export const TEST_PASSPHRASE = 'm2-0 fixture passphrase';
export const TEST_ACTOR = 'alice';
export const TEST_PRODUCER = 'model-1';

export interface SignerdRig {
  readonly root: string;
  readonly paths: SignerdPaths;
  readonly client: SignerdClient;
  readonly running: RunningSignerd;
  close(): Promise<void>;
}

export interface RigOptions {
  readonly ttl?: '0' | '5' | '15' | '60';
  readonly signDelayMs?: number;
  readonly now?: () => Date;
}

function ttlMinutes(ttl: RigOptions['ttl']): WindowTtlMinutes {
  switch (ttl) {
    case '5':
      return 5;
    case '15':
      return 15;
    case '60':
      return 60;
    default:
      return 0;
  }
}

/** 初始化一个已 init 且已 start 的 signerd（进程内），client 指向它。 */
export async function bootSignerd(options: RigOptions = {}): Promise<SignerdRig> {
  const root = mkdtempSync(join(tmpdir(), 'sdo-m2-'));
  const savedHome = process.env['HOME'];
  process.env['HOME'] = root;
  const paths = signerdPaths({ runtimeDir: join(root, 'run') });
  const ttl = ttlMinutes(options.ttl);
  const nowOptions = options.now === undefined ? {} : { now: options.now };
  await initializeSignerd({ passphrase: TEST_PASSPHRASE, paths, ...nowOptions });
  const running = await startSignerd({
    paths,
    windowTtlMinutes: ttl,
    ...nowOptions,
    ...(options.signDelayMs === undefined ? {} : { signDelayMs: options.signDelayMs }),
  });
  return {
    root,
    paths,
    client: new SignerdClient({ paths }),
    running,
    close: async () => {
      await running.close();
      rmSync(root, { recursive: true, force: true });
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
    },
  };
}
