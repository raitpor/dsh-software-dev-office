/**
 * 插件配置解析（M5-0 C1/C5/C9）。
 *
 * 宿主传入的 `config` 只接受**非秘密**字段；库口令与 signerd 口令只从进程环境读，
 * 库路径白名单：默认状态目录，显式只许状态目录或项目 `.sdo/**`，其余 `invalid_config`。
 * 不写进 profile 配置，也不落日志。所有取值都有显式缺省，缺省时工具 fail-closed。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { isActorKind, type ActorKind } from '../core/auth/session.js';

export class PluginConfigError extends Error {
  readonly reason_code = 'invalid_config' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PluginConfigError';
  }
}

function under(root: string, candidate: string): boolean {
  const prefix = resolve(root).endsWith(sep) ? resolve(root) : `${resolve(root)}${sep}`;
  return candidate.startsWith(prefix);
}

/** P2-1：库只许落状态目录（~/.local/state/sdo/** 或项目 .sdo/**），拒绝仓库根/源码/文档等。 */
export function validateDbPath(dbPath: string, projectDir: string): string {
  const candidate = resolve(dbPath);
  const stateRoot = join(homedir(), '.local', 'state', 'sdo');
  const projectState = join(projectDir, '.sdo');
  if (under(stateRoot, candidate) || under(projectState, candidate)) return candidate;
  throw new PluginConfigError(
    `invalid_config: db_path 必须位于 ${stateRoot} 或 ${projectState} 之下（拒绝仓库根/.git/docs/src 等越界路径）`,
  );
}

export interface PluginSettings {
  readonly dbPath: string;
  readonly stateDir: string;
  readonly passphrase: string;
  readonly actor: string | undefined;
  readonly actorKind: ActorKind;
  readonly consoleEnabled: boolean;
  readonly consolePort: number;
  readonly signerdHome: string;
  readonly signerdAutostart: boolean;
  readonly signerdPassphrase: string | undefined;
  readonly projectDir: string;
  readonly accountsPath: string;
  readonly signingKeyFile: string;
}

export interface PluginConfigInput {
  readonly db_path?: unknown;
  readonly state_dir?: unknown;
  readonly actor?: unknown;
  readonly actor_kind?: unknown;
  readonly console?: unknown;
  readonly console_port?: unknown;
  readonly signerd_home?: unknown;
  readonly signerd_autostart?: unknown;
  readonly project_dir?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function port(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return 4173;
  return parsed;
}

/** 环境变量是秘密/部署信息的唯一来源；config 只放可进 profile 的开关。 */
export function ensureDbKey(stateDir: string): string {
  const path = join(stateDir, 'db.key');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const value = readFileSync(path, 'utf8').trim();
    if (value.length < 32) throw new PluginConfigError(`invalid_config: ${path} 内容过短`);
    return value;
  }
  const value = randomBytes(32).toString('hex');
  writeFileSync(path, `${value}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return value;
}

export function resolvePluginSettings(
  config: PluginConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
): PluginSettings {
  const projectDir = text(config.project_dir) ?? process.cwd();
  const configuredState = text(config.state_dir) ?? text(env['SDO_STATE_DIR']);
  const configuredPath = text(config.db_path) ?? text(env['SDO_DB']);
  const defaultState = configuredState ?? join(homedir(), '.local', 'state', 'sdo');
  const dbPath = validateDbPath(
    configuredPath ?? join(defaultState, `${basename(projectDir)}.db`),
    projectDir,
  );
  const stateDir = configuredState ?? (configuredPath === undefined ? defaultState : dirname(dbPath));
  const passphrase = text(env['SDO_DB_PASSPHRASE']) ?? '';
  const actor = text(config.actor) ?? text(env['SDO_PLUGIN_ACTOR']) ?? 'sdo:plugin-agent';
  // 缺省 agent：human 会让模型以人类身份落库/代签；只有显式配置才升权。
  const configuredKind = text(config.actor_kind) ?? text(env['SDO_PLUGIN_ACTOR_KIND']) ?? 'agent';
  const actorKind = isActorKind(configuredKind) ? configuredKind : 'agent';
  const consolePort = port(config.console_port ?? env['SDO_PLUGIN_CONSOLE_PORT']);

  return {
    dbPath,
    stateDir,
    passphrase,
    actor,
    actorKind,
    consoleEnabled: bool(config.console, true),
    consolePort,
    signerdHome: text(config.signerd_home) ?? join(stateDir, 'signerd'),
    signerdAutostart: bool(config.signerd_autostart, env['SDO_SIGNERD_AUTOSTART'] === '1'),
    signerdPassphrase: env['SDO_SIGNERD_PASSPHRASE'],
    projectDir,
    accountsPath: join(stateDir, 'accounts.json'),
    signingKeyFile: join(stateDir, 'signing_key.json'),
  };
}
