/**
 * `npm run console` 的入口：纯 Node 启动只读控制台（M0-5，C4）。
 *
 * 环境变量（只读，不写库）：
 * - `SDO_DB_PATH`       已迁移的加密库路径（默认 `./sdo.db`）
 * - `SDO_DB_PASSPHRASE` 库口令（必填；缺失/空串直接拒绝，fail-closed）
 * - `SDO_CONSOLE_PORT`  端口（默认 4173；`0` 表示由内核分配，测试用）
 * - `SDO_CONSOLE_ACTOR` 控制台身份（**必填**；M3-1 起 query 只认 session。未设置 ⇒
 *   拒绝启动并打印原因（fail-closed），绝不静默给空页；未知身份按“无任何权限”处理）
 * - `SDO_CONSOLE_ACTOR_KIND` 会话类型（`human`/`agent`/`service`，默认 `human`；
 *   `agent` 会触发 M3-6 的 `human_only` 列裁剪）
 * - `SDO_CONSOLE_RIGHT` 读取权限（M0 兼容参数；M3 起页面按 session 判权，此参数不再决定可见性）
 *
 * 只绑 `127.0.0.1`（A4）：本机只读页，不对外。库必须已迁移；本进程不建表、不迁移、
 * 不写事件——控制台是只读面（C3）。
 */

import { openEncryptedDatabase } from '../db/driver.js';
import { currentUserVersion } from '../db/migrate.js';
import { resolveRight } from '../query/index.js';
import { dbRightsPort } from '../core/pm/access.js';
import { isActorKind } from '../core/auth/session.js';
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

function readActor(): string {
  const raw = process.env['SDO_CONSOLE_ACTOR'];
  if (raw === undefined || raw.trim() === '') {
    fail(
      '控制台需要会话身份：SDO_CONSOLE_ACTOR 未设置。请设置 SDO_CONSOLE_ACTOR（及可选的 SDO_CONSOLE_ACTOR_KIND）后重启（fail-closed）。',
    );
  }
  return raw.trim();
}

function main(): void {
  // P1（Lead m06490）：先校验身份再碰库——没有 session 的控制台等于空页面，必须启动即拒。
  const actor = readActor();
  const rawKind = (process.env['SDO_CONSOLE_ACTOR_KIND'] ?? 'human').trim();
  if (!isActorKind(rawKind)) {
    fail(`SDO_CONSOLE_ACTOR_KIND 非法：${rawKind}（允许 human/agent/service）`);
  }
  const actorKind = rawKind;

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
  const server = createConsoleServer({ db, right, actor, actorKind });

  server.on('error', (error) => {
    db.close();
    const message = error instanceof Error ? error.message : String(error);
    fail(`监听失败：${message}`);
  });

  server.listen(port, HOST, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    const actorNote = dbRightsPort(db, actor).denied === true
      ? `, actor=${actor}（无有效 grant ⇒ deny-all）`
      : `, actor=${actor}`;
    process.stdout.write(
      `[sdo-console] SDO 控制台 listening on http://${HOST}:${actualPort} (right=${right}, db=${dbPath}${actorNote})\n`,
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
