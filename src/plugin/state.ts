/**
 * 插件运行态：库的打开/迁移/权限与日志（M5-0 C5/C10/C11）。
 *
 * 纪律：库只在状态目录（`~/.local/state/sdo/...`）；目录 0700、文件 0600；
 * 迁移绝对路径取自插件包根，不依赖宿主进程 cwd；口令不落日志。
 */

import { chmodSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureDbDirectory } from '../core/paths.js';
import { ensureDbKey } from './config.js';
import type { SdoDatabase } from '../db/driver.js';
import { openSdoDatabase } from '../db/open.js';
import { currentUserVersion, runMigrations } from '../db/migrate.js';
import type { PluginSettings } from './config.js';

export interface PluginLogLine {
  readonly event: string;
  readonly request_id: string;
  readonly elapsed_ms: number;
  readonly version: string;
  readonly [key: string]: unknown;
}

function findPackageRoot(start: string): string {
  let dir = start;
  for (;;) {
    try {
      if (statSync(join(dir, 'migrations')).isDirectory() && statSync(join(dir, 'package.json')).isFile()) {
        return dir;
      }
    } catch {
      // 继续向上
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('plugin package root not found (missing migrations/)');
    dir = parent;
  }
}

function packageRoot(): string {
  return findPackageRoot(dirname(fileURLToPath(import.meta.url)));
}

function pluginVersion(root: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function logPlugin(settings: PluginSettings, line: Omit<PluginLogLine, 'version'>): void {
  let version = '0.0.0';
  try {
    version = pluginVersion(packageRoot());
  } catch {
    // 包根找不到时仍打印，不能因为日志构造把插件打死
  }
  process.stderr.write(`[sdo-plugin] ${JSON.stringify({ ...line, version, db: settings.dbPath })}\n`);
}

/** 插件运行态；库惰性打开，`dispose()` 幂等。 */
export class PluginRuntime {
  readonly settings: PluginSettings;
  private db: SdoDatabase | undefined;
  private readonly version: string;
  private readonly root: string;

  constructor(settings: PluginSettings) {
    this.settings = settings;
    this.root = packageRoot();
    this.version = pluginVersion(this.root);
  }

  getVersion(): string {
    return this.version;
  }

  getDbPath(): string {
    return this.settings.dbPath;
  }

  open(): SdoDatabase {
    if (this.db !== undefined) return this.db;
    const started = Date.now();
    const requestId = `plugin-open-${String(started)}`;
    const passphrase = this.settings.passphrase.length > 0
      ? this.settings.passphrase
      : ensureDbKey(this.settings.stateDir);
    const dir = ensureDbDirectory(this.settings.dbPath);
    chmodSync(dir, 0o700);
    let db: SdoDatabase;
    try {
      db = openSdoDatabase(this.settings.dbPath, passphrase);
    } catch (error) {
      this.log({
        event: 'open_failed',
        request_id: requestId,
        elapsed_ms: Date.now() - started,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    try {
      chmodSync(this.settings.dbPath, 0o600);
      const result = runMigrations(db, join(this.root, 'migrations'));
      this.db = db;
      this.log({
        event: 'migrate',
        request_id: requestId,
        elapsed_ms: Date.now() - started,
        applied: result.applied,
        user_version: result.userVersion,
      });
      return db;
    } catch (error) {
      db.close();
      this.log({
        event: 'migrate_failed',
        request_id: requestId,
        elapsed_ms: Date.now() - started,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  userVersion(): number {
    return currentUserVersion(this.open());
  }

  log(line: Omit<PluginLogLine, 'version'>): void {
    logPlugin(this.settings, line);
  }

  dispose(): void {
    if (this.db !== undefined) {
      this.db.close();
      this.db = undefined;
    }
  }
}
