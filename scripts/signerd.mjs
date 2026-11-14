#!/usr/bin/env node
/**
 * `sdo signerd` 的进程外壳（M2-0 C1/C2；docs/06 §3）。
 *
 * 用法：
 *   node scripts/signerd.mjs init                 # 建密钥（口令从 stdin 读，不进 argv）
 *   node scripts/signerd.mjs serve [--sign-delay-ms N]  # 前台跑 socket server（N 仅测试时序用）
 *   node scripts/signerd.mjs status
 *   node scripts/signerd.mjs unlock --actor alice --frontier <hash>
 *   node scripts/signerd.mjs sign --decision-id ... --payload-hash ... --frontier ... --nonce ...
 *                                 [--proposition-hash ...] [--channel ui|cli] [--actor alice] [--producer alice]
 *   node scripts/signerd.mjs lock --actor alice
 *
 * 口令只从 stdin（TTY 提示）或 `SDO_SIGNERD_PASSPHRASE` 环境变量读；argv 不留口令。
 * 信任根固定 `<state>/sdo/signerd`（D-054：不读 env 覆盖）；测试/嵌入方可用
 * `--home <dir>` 显式改（这是显式参数，产品默认不需要）。
 * 需要先 `npm run build`（脚本直接 import `lib/src/sign/*.js`）。
 */
import { createInterface } from 'node:readline';

const [, , command = 'status', ...rest] = process.argv;

function arg(name, fallback) {
  const index = rest.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = rest[index + 1];
  if (value === undefined) throw new Error(`--${name} 缺少取值`);
  return value;
}

function requireArg(name) {
  const value = arg(name);
  if (value === undefined) throw new Error(`缺少 --${name}`);
  return value;
}

async function readPassphrase() {
  const fromEnv = process.env['SDO_SIGNERD_PASSPHRASE'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/u, '');
    if (text.length === 0) throw new Error('stdin 没有口令');
    return text;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise((resolve) => {
      rl.question('signerd 口令: ', (answer) => resolve(answer));
    });
  } finally {
    rl.close();
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
}

async function main() {
  const paths = await import('../lib/src/sign/paths.js');
  paths.assertPlatform();
  const homeDir = arg('home');
  const socketPath = arg('socket');
  const pathOptions = {
    ...(homeDir === undefined ? {} : { homeDir }),
    ...(socketPath === undefined ? {} : { socketPath }),
  };
  const resolved = () => paths.signerdPaths(pathOptions);

  if (command === 'init') {
    const { initializeSignerd } = await import('../lib/src/sign/signerd.js');
    const passphrase = await readPassphrase();
    const result = await initializeSignerd({ passphrase, paths: resolved() });
    print({ ok: true, key_id: result.key_id, home: result.home });
    return;
  }

  if (command === 'serve') {
    const { startSignerd } = await import('../lib/src/sign/signerd.js');
    const delayArg = arg('sign-delay-ms');
    const signDelayMs = delayArg === undefined ? 0 : Number(delayArg);
    if (!Number.isFinite(signDelayMs) || signDelayMs < 0) throw new Error('--sign-delay-ms 必须是非负数');
    const running = await startSignerd({ paths: resolved(), ...(signDelayMs > 0 ? { signDelayMs } : {}) });
    print({ ok: true, serving: true, socket: running.socketPath, pid: process.pid });
    const stop = () => {
      void running.close().then(() => process.exit(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }

  const { SignerdClient } = await import('../lib/src/sign/client.js');
  const client = new SignerdClient({ paths: resolved() });

  if (command === 'status') {
    print(await client.status());
    return;
  }
  if (command === 'lock') {
    print(await client.lock(requireArg('actor')));
    return;
  }
  if (command === 'unlock') {
    const passphrase = await readPassphrase();
    print(
      await client.unlock({
        actor: requireArg('actor'),
        actor_kind: arg('actor-kind', 'human'),
        passphrase,
        frontier: requireArg('frontier'),
      }),
    );
    return;
  }
  if (command === 'sign') {
    const response = await client.sign({
      actor: arg('actor', 'alice'),
      actor_kind: arg('actor-kind', 'human'),
      producer: arg('producer', arg('actor', 'alice')),
      decision_id: requireArg('decision-id'),
      payload_hash: requireArg('payload-hash'),
      proposition_hash: requireArg('proposition-hash'),
      frontier: requireArg('frontier'),
      nonce: requireArg('nonce'),
      channel: arg('channel', 'cli'),
    });
    print(response);
    return;
  }
  fail(`未知命令 ${command}`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
