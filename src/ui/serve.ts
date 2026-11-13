/**
 * `npm run console` 的入口：纯 Node 启动只读控制台（M0-5，C4）。
 *
 * 环境变量（只读，不写库）：
 * - `SDO_DB_PATH`       已迁移的加密库路径（默认 `./sdo.db`）
 * - `SDO_DB_PASSPHRASE` 库口令（必填；缺失/空串直接拒绝，fail-closed）
 * - `SDO_CONSOLE_PORT`  端口（默认 4173；`0` 表示由内核分配，测试用）
 * - `SDO_CONSOLE_RIGHT` 读取权限（默认 `decider`；M0 没有登录身份，见卡「已知边界」）
 *
 * 只绑 `127.0.0.1`（A4）：本机只读页，不对外。库必须已迁移；本进程不建表、不迁移、
 * 不写事件——控制台是只读面（C3）。
 */

import { openEncryptedDatabase } from '../db/driver.js';
import { currentUserVersion } from '../db/migrate.js';
import { resolveRight } from '../query/index.js';
import { listViewCatalog } from '../views/catalog.js';
import { createConsoleServer } from './server.js';

const DEFAULT_PORT = 4173;
const HOST = '127.0.0.1';

function fail(message: string): never {
  process.stderr.write(`[sdo-console] ${message}\n`);
  process.exit(1);
}

function readPort(): number {
  const raw = process.env['SDO_CONSOLE_PORT'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`SDO_CONSOLE_PORT 不是合法端口：${raw}`);
  }
  return port;
}

function readRight(): string {
  const raw = process.env['SDO_CONSOLE_RIGHT'];
  if (raw === undefined || raw.trim() === '') return 'decider';
  const value = raw.trim();
  try {
    resolveRight(value);
  } catch {
    fail(`SDO_CONSOLE_RIGHT 非法：${value}（只接受 reader/reviewer/decider/signer）`);
  }
  return value;
}

function main(): void {
  const dbPath = process.env['SDO_DB_PATH'] ?? './sdo.db';
  const passphrase = process.env['SDO_DB_PASSPHRASE'] ?? '';
  if (passphrase.length === 0) {
    fail('SDO_DB_PASSPHRASE 未设置：控制台不提供明文降级（fail-closed）。');
  }

  const db = openEncryptedDatabase(dbPath, passphrase);
  try {
    if (currentUserVersion(db) === 0) {
      fail(`库未迁移（user_version=0）：${dbPath}。M0 暂无 migrate CLI，请先用 runMigrations 建库再启动控制台。`);
    }
    // 只读自检：目录读得出来才说明视图层已就位（本进程不建表、不迁移）。
    if (listViewCatalog(db).length === 0) {
      throw new Error('view_catalog 为空：库不完整，请先跑迁移');
    }
  } catch (error) {
    db.close();
    const message = error instanceof Error ? error.message : String(error);
    fail(`库不可用（${dbPath}）：${message}`);
  }

  const port = readPort();
  const right = readRight();
  const server = createConsoleServer({ db, right });

  server.on('error', (error) => {
    db.close();
    const message = error instanceof Error ? error.message : String(error);
    fail(`监听失败：${message}`);
  });

  server.listen(port, HOST, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    process.stdout.write(
      `[sdo-console] SDO 控制台 listening on http://${HOST}:${actualPort} (right=${right}, db=${dbPath})\n`,
    );
  });

  const shutdown = (signal: string): void => {
    process.stdout.write(`[sdo-console] ${signal}：关闭\n`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
