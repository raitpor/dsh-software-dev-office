import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SdoDatabase } from './driver.js';

/** 迁移文件名形如 001_init.sql；版本号取文件名前缀。 */
const MIGRATION_FILE_PATTERN = /^(\d{3})_[A-Za-z0-9_-]+\.sql$/;

export interface MigrationFile {
  readonly version: number;
  readonly file: string;
  readonly sql: string;
}

export interface MigrationResult {
  /** 本次真正执行的迁移版本；已是最新时为空数组。 */
  readonly applied: readonly number[];
  readonly userVersion: number;
}

/** 仓库根 migrations/；进程 cwd 必须是仓库根（npm scripts 与测试都如此）。 */
export function defaultMigrationsDir(): string {
  return resolve(process.cwd(), 'migrations');
}

export function listMigrations(dir: string = defaultMigrationsDir()): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((file) => MIGRATION_FILE_PATTERN.test(file))
    .sort();

  return files.map((file) => {
    const match = MIGRATION_FILE_PATTERN.exec(file);
    if (match === null) {
      throw new Error(`migration file name is not parseable: ${file}`);
    }
    const version = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isInteger(version) || version <= 0) {
      throw new Error(`migration version must be a positive integer: ${file}`);
    }
    return { version, file, sql: readFileSync(join(dir, file), 'utf8') };
  });
}

export function currentUserVersion(db: SdoDatabase): number {
  const rows = db.pragma('user_version');
  if (!Array.isArray(rows)) {
    throw new Error('PRAGMA user_version returned an unexpected shape');
  }
  const first: unknown = rows[0];
  if (typeof first !== 'object' || first === null) {
    throw new Error('PRAGMA user_version returned an empty result');
  }
  const value = (first as Record<string, unknown>)['user_version'];
  if (typeof value !== 'number') {
    throw new Error('PRAGMA user_version did not return a number');
  }
  return value;
}

/**
 * 按 PRAGMA user_version 逐文件应用迁移，每个文件一个事务并把 user_version 推到该文件版本。
 * 已应用的迁移不会重跑（幂等：第二次调用 applied 为空）。不打开连接，调用方负责用
 * openEncryptedDatabase 建好库（fail-closed 在 driver 层）。
 */
export function runMigrations(
  db: SdoDatabase,
  dir: string = defaultMigrationsDir(),
): MigrationResult {
  const migrations = listMigrations(dir);
  const current = currentUserVersion(db);
  const pending = migrations.filter((migration) => migration.version > current);

  if (pending.length === 0) {
    return { applied: [], userVersion: current };
  }

  const applied: number[] = [];
  let expected = current + 1;
  for (const migration of pending) {
    if (migration.version !== expected) {
      throw new Error(
        `migration chain is not contiguous: expected ${expected}, got ${migration.version} (${migration.file})`,
      );
    }
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
    })();
    applied.push(migration.version);
    expected += 1;
  }

  return { applied, userVersion: expected - 1 };
}
