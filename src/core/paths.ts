/**
 * 库文件路径与目录守卫（M0-6，判据 C1/C2/C5）。
 *
 * 真源：docs/09 §16.1 / §D4（库放工作区外；同机同用户不可防读，策略层兜底）。
 * 纪律：
 *   - 默认路径在工作区外（`~/.local/state/sdo/<project>.db`），父目录 0700；
 *   - `SDO_DB` 是唯一显式覆盖；覆盖到工作区内只 warning、不阻止（C2 要留口子）；
 *   - 任何“建不出目录 / 目录不可写”都抛 `SdoPathError`，且消息带 fail-closed，
 *     绝不回退到工作区（C5）。
 */

import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/** 路径解析或目录守卫失败；调用方不应把它当普通 IO 错误吞掉。 */
export class SdoPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SdoPathError';
  }
}

/** `resolveDbPath` 的结果：路径本身 + 来源 + 是否在工作区内（用于告警）。 */
export interface DbPathResolution {
  readonly path: string;
  readonly source: 'env' | 'default';
  readonly inWorkspace: boolean;
  /** 非空表示“沙箱保护已被绕过”，调用方应打到 stderr 或安装日志。 */
  readonly warning: string | null;
}

export interface ResolveDbPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly home?: string;
}

const DB_DIR = ['.local', 'state', 'sdo'] as const;
const DEFAULT_PROJECT = 'default';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `cwd` 的最后一段做文件名；统一小写、非法字符换 `-`，避免空格/中文目录炸路径。 */
function projectName(cwd: string): string {
  const name = basename(cwd).toLowerCase();
  const slug = name.replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return slug.length === 0 ? DEFAULT_PROJECT : slug;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 工作区 = 仓库根：从 `cwd` 向上**优先**找 `.git`（目录或 worktree 的 `.git` 文件）；
 * 没有 `.git` 再退回最近的 `package.json`；都没有退回 `cwd`。
 * 不能先撞到子包自己的 `package.json` 就停——monorepo 里 cwd 是子包、HOME 在仓库根时，
 * 库落进仓库根却会漏告警（最该警告的场景）。
 */
function findWorkspaceRoot(cwd: string): string {
  const start = resolve(cwd);

  for (let dir = start; ; ) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  for (let dir = start; ; ) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return start;
    }
    dir = parent;
  }
}

/**
 * 只解析路径，不创建目录（C1/C2 的纯查询面）。
 *
 * 默认：`<home>/.local/state/sdo/<projectname>.db`。
 * 覆盖：`SDO_DB`；相对路径按 `cwd` 解析；落进工作区时 `warning` 非空但照旧返回。
 */
export function resolveDbPath(options: ResolveDbPathOptions = {}): DbPathResolution {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = options.home ?? homedir();
  const workspaceRoot = findWorkspaceRoot(cwd);
  const override = typeof env['SDO_DB'] === 'string' && env['SDO_DB'].length > 0 ? env['SDO_DB'] : null;

  if (override !== null) {
    const path = isAbsolute(override) ? resolve(override) : resolve(cwd, override);
    const inWorkspace = isInside(workspaceRoot, path);
    return {
      path,
      source: 'env',
      inWorkspace,
      warning: inWorkspace
        ? `SDO_DB points inside the workspace (${path}); sandbox protection is disabled by explicit override`
        : null,
    };
  }

  const path = join(home, ...DB_DIR, `${projectName(cwd)}.db`);
  const inWorkspace = isInside(workspaceRoot, path);
  return {
    path,
    source: 'default',
    inWorkspace,
    warning: inWorkspace
      ? `default database path is inside the workspace (${workspaceRoot}): ${path}; sandbox protection is disabled`
      : null,
  };
}

/**
 * 把解析结果里的 warning 打到 stderr（C2 的“打印”面）。
 * M0 没有 CLI，启动入口拿到 resolution 后调用一次即可；返回是否真的打了。
 */
export function warnIfInsideWorkspace(
  resolution: DbPathResolution,
  sink: (line: string) => void = (line) => process.stderr.write(line),
): boolean {
  if (resolution.warning === null) {
    return false;
  }
  sink(`${resolution.warning}\n`);
  return true;
}

/**
 * 确保库的父目录存在且可写（C1/C5）。
 *
 * 失败一律 `SdoPathError`，消息含 `fail-closed: no workspace fallback`；
 * 不再尝试任何“换个目录”的降级。
 *
 * @returns 库文件所在的目录（已 resolve）。
 */
export function ensureDbDirectory(dbPath: string): string {
  const path = resolve(dbPath);
  const dir = dirname(path);

  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new SdoPathError(
      `cannot create database directory ${dir}: ${errorMessage(error)} (fail-closed: no workspace fallback)`,
    );
  }

  let isDirectory = false;
  try {
    isDirectory = statSync(dir).isDirectory();
  } catch (error) {
    throw new SdoPathError(
      `cannot stat database directory ${dir}: ${errorMessage(error)} (fail-closed: no workspace fallback)`,
    );
  }
  if (!isDirectory) {
    throw new SdoPathError(`database parent is not a directory: ${dir} (fail-closed: no workspace fallback)`);
  }

  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new SdoPathError(
      `database directory ${dir} is not writable (fail-closed: no workspace fallback)`,
    );
  }

  return dir;
}
