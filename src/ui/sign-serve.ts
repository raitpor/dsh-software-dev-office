/**
 * M2-6 签字页进程入口（C7：只跑 node，不依赖宿主；只绑 127.0.0.1）。
 *
 * 用法：`SDO_DB_PATH=… SDO_DB_PASSPHRASE=… node lib/src/ui/sign-serve.js`
 * 环境：
 *   · SDO_DB_PATH        加密库路径（默认 ./sdo.db）
 *   · SDO_DB_PASSPHRASE  必填；空值 fail-closed
 *   · SDO_SIGN_PAGE_PORT 端口（默认 4174；0 = 让内核分配）
 *   · SDO_SIGN_ACTOR     可选：页面显示的签字人（只用于表单提示）
 *
 * 本进程不迁移、不建表、不写事件；签名全部经 signerd（unix socket）。
 */
import { openSdoDatabase } from '../db/open.js';
import { currentUserVersion } from '../db/migrate.js';
import { SignerdClient } from '../sign/client.js';
import { SigningPageService } from '../sign/page.js';
import { createSigningServer } from './sign-server.js';

const DEFAULT_PORT = 4174;

function fail(message: string): never {
  process.stderr.write(`[sdo-sign] ${message}\n`);
  process.exit(1);
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) return DEFAULT_PORT;
  if (!/^\d+$/.test(raw)) fail(`SDO_SIGN_PAGE_PORT 非法：${raw}（应为 0–65535 的整数）`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`SDO_SIGN_PAGE_PORT 越界：${raw}`);
  return port;
}

async function main(): Promise<void> {
  const passphrase = process.env['SDO_DB_PASSPHRASE'];
  if (passphrase === undefined || passphrase.length === 0) {
    fail('SDO_DB_PASSPHRASE 未设置（签章口令/库口令不要写进命令历史，用环境变量）');
  }
  const dbPath = process.env['SDO_DB_PATH'] ?? './sdo.db';
  const port = parsePort(process.env['SDO_SIGN_PAGE_PORT']);
  const db = openSdoDatabase(dbPath, passphrase, { mustExist: true });
  if (currentUserVersion(db) === 0) fail('库未迁移（user_version=0）');
  const client = new SignerdClient();
  const service = new SigningPageService({ db, client });
  const server = createSigningServer({ service });
  server.on('error', (error) => {
    process.stderr.write(`[sdo-sign] server error: ${error.message}\n`);
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    process.stdout.write(
      `[sdo-sign] 签字页 listening on http://127.0.0.1:${String(actualPort)} (db=${dbPath})\n`,
    );
  });
  const shutdown = (): void => {
    process.stdout.write('[sdo-sign] 关闭\n');
    server.close(() => {
      try {
        db.close();
      } finally {
        process.exit(0);
      }
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
