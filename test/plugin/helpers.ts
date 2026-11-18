/** M5-0 插件测试夹具：临时加密库 + 全权 actor。 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { grantAll } from '../db/append-auth.js';

export const PASSPHRASE = 'plugin-test-passphrase';

export interface FixtureDb {
  readonly dir: string;
  readonly dbPath: string;
  readonly db: SdoDatabase;
  close(): void;
}

export function makeDb(actor = 'alice'): FixtureDb {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-plugin-'));
  const stateDir = join(dir, '.sdo');
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(stateDir, 'sdo.db');
  const db = openSdoDatabase(dbPath, PASSPHRASE);
  runMigrations(db, resolve('migrations'));
  grantAll(db, actor);
  return { dir, dbPath, db, close: () => db.close() };
}

export function envFor(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { SDO_DB_PASSPHRASE: PASSPHRASE, SDO_PLUGIN_ACTOR: 'alice', ...overrides };
}
