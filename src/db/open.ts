/**
 * 带路径守卫的打开入口（M0-6，判据 C5）。
 *
 * 与 `driver.openEncryptedDatabase` 的分工：这里先做“目录存在且可写 / mustExist”的
 * 失败关闭检查，再交给驱动加解密。任何失败都抛 `SdoPathError`，不回退工作区。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { SdoPathError, ensureDbDirectory } from '../core/paths.js';
import { openEncryptedDatabase, type SdoDatabase } from './driver.js';

export interface OpenSdoDatabaseOptions {
  /** `true` 时库文件必须已存在（读/verify 场景）；默认 `false`（首次建库）。 */
  readonly mustExist?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function openSdoDatabase(
  dbPath: string,
  passphrase: string,
  options: OpenSdoDatabaseOptions = {},
): SdoDatabase {
  const path = resolve(dbPath);

  // 先判存在再建目录：mustExist 失败不能留下空目录。
  if (options.mustExist === true && !existsSync(path)) {
    throw new SdoPathError(
      `database does not exist: ${path} (fail-closed: no workspace fallback)`,
    );
  }
  ensureDbDirectory(path);

  try {
    const db = openEncryptedDatabase(path, passphrase);
    // 把绝对路径绑到连接上：access.log 不能靠 db.name 反推（相对路径 + chdir 会漂移）。
    Object.defineProperty(db, 'sdoPath', { value: path, enumerable: false });
    return db;
  } catch (error) {
    throw new SdoPathError(
      `cannot open database ${path}: ${errorMessage(error)} (fail-closed: no workspace fallback)`,
    );
  }
}
