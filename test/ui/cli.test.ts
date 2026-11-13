import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openEncryptedDatabase } from '../../src/db/driver.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PASSPHRASE } from '../db/helpers.js';

const SERVE_ENTRY = fileURLToPath(new URL('../../src/ui/serve.js', import.meta.url));
const PORT_LINE = /listening on http:\/\/127\.0\.0\.1:(\d+)/;

interface MigratedDb {
  readonly dir: string;
  readonly path: string;
}

function makeMigratedDb(): MigratedDb {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-ui-cli-'));
  const path = join(dir, 'sdo.db');
  const db = openEncryptedDatabase(path, PASSPHRASE);
  try {
    runMigrations(db);
  } finally {
    db.close();
  }
  return { dir, path };
}

function childEnv(dbPath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SDO_DB_PATH: dbPath,
    SDO_DB_PASSPHRASE: PASSPHRASE,
    SDO_CONSOLE_PORT: '0',
    SDO_CONSOLE_RIGHT: 'decider',
    ...extra,
  };
}

test('C4：纯 node 启动 serve.js，日志给出 127.0.0.1 端口，三页可 GET', async () => {
  const { dir, path } = makeMigratedDb();
  const child = spawn(process.execPath, [SERVE_ENTRY], {
    env: childEnv(path),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`启动超时；stdout=${stdout} stderr=${stderr}`)), 10_000);
      const inspect = (): void => {
        const match = PORT_LINE.exec(stdout);
        if (match === null) return;
        clearTimeout(timer);
        resolve(Number(match[1]));
      };
      child.stdout.on('data', inspect);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`serve.js 提前退出 code=${code}；stderr=${stderr}`));
      });
    });

    for (const [route, pageId] of [
      ['/', 'overview'],
      ['/board', 'board'],
      ['/plan', 'plan'],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      assert.equal(response.status, 200, `${route} 应 200`);
      assert.match(await response.text(), new RegExp(`data-page="${pageId}"`));
    }
    assert.match(stdout, /right=decider/, '日志应标注读取权限');
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000);
    });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C4 负例：缺口令直接拒绝（fail-closed，不降级明文）', async () => {
  const env = childEnv('./does-not-matter.db');
  delete env['SDO_DB_PASSPHRASE'];
  const child = spawn(process.execPath, [SERVE_ENTRY], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.once('exit', (value) => resolve(value)));
  assert.equal(code, 1);
  assert.match(stderr, /SDO_DB_PASSPHRASE/);
});


test('P3：SDO_CONSOLE_RIGHT 非法值启动即失败（fail-closed，不静默降级）', async () => {
  const { dir, path } = makeMigratedDb();
  const child = spawn(process.execPath, [SERVE_ENTRY], {
    env: childEnv(path, { SDO_CONSOLE_RIGHT: 'root' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  try {
    const code = await new Promise<number | null>((resolve) => child.once('exit', (value) => resolve(value)));
    assert.equal(code, 1);
    assert.match(stderr, /SDO_CONSOLE_RIGHT/);
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
