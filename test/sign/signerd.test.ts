/**
 * M2-0 C1/C2/C4/C6/C7/C11：signerd 独立进程、密钥落盘、坏权限拒启、窗口与成本。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SignerdClient } from '../../src/sign/client.js';
import { decryptPrivateKey, requireEnvelopeShape } from '../../src/sign/keys.js';
import { assertPlatform } from '../../src/sign/paths.js';
import { permissionBits } from '../../src/sign/permissions.js';
import { startSignerd } from '../../src/sign/signerd.js';
import { bootSignerd, TEST_ACTOR, TEST_PASSPHRASE } from './helpers.js';

const CHILD_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error('等待条件超时');
}

function signRequest(overrides: Record<string, string> = {}): Parameters<SignerdClient['sign']>[0] {
  return {
    actor: TEST_ACTOR,
    actor_kind: 'human',
    producer: 'model-1',
    decision_id: 'd-1',
    payload_hash: 'sha256:aa',
    proposition_hash: 'sha256:bb',
    frontier: 'f-1',
    nonce: 'n-1',
    channel: 'ui',
    ...overrides,
  };
}

test('C2: 私钥盘上是密文信封（0600、单行），错口令解不开、正确口令能解开', async () => {
  const rig = await bootSignerd();
  try {
    assert.equal(permissionBits(lstatSync(rig.paths.home).mode), 0o700);
    assert.equal(permissionBits(lstatSync(rig.paths.keyFile).mode), 0o600);
    const raw = readFileSync(rig.paths.keyFile, 'utf8');
    assert.match(raw, /sdo-signerd-key-v1/u);
    assert.equal(raw.includes('BEGIN PRIVATE KEY'), false, '盘上不得出现 PEM 私钥');
    assert.equal(raw.trim().split('\n').length, 1, '信封必须是单行 JSON');
    const envelope = requireEnvelopeShape(JSON.parse(raw));
    await assert.rejects(
      () => decryptPrivateKey(envelope, 'wrong passphrase'),
      (error: unknown) => (error as { reason_code?: string }).reason_code === 'bad_passphrase',
    );
    const material = await decryptPrivateKey(envelope, TEST_PASSPHRASE);
    assert.equal(material.key_id, envelope.key_id);
  } finally {
    await rig.close();
  }
});

test('C2: socket 出生即 0600，runtime 目录 0700', async () => {
  const rig = await bootSignerd();
  try {
    const stat = lstatSync(rig.paths.socket);
    assert.ok(stat.isSocket(), '必须是 unix socket 文件');
    assert.equal(permissionBits(stat.mode), 0o600);
    assert.equal(permissionBits(lstatSync(rig.paths.runtimeDir).mode), 0o700);
  } finally {
    await rig.close();
  }
});

test('C2: home 权限过宽 ⇒ 拒绝启动 dir_perm_insecure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sdo-m2-badhome-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o755);
  try {
    await assert.rejects(
      () => startSignerd({ homeDir: home, runtimeDir: join(root, 'run') }),
      (error: unknown) => (error as { reason_code?: string }).reason_code === 'dir_perm_insecure',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('C2/C5: Windows 明确 platform_unsupported（常量断言；M2 只支持 Linux/macOS）', () => {
  assert.throws(
    () => assertPlatform('win32'),
    (error: unknown) => (error as { reason_code?: string }).reason_code === 'platform_unsupported',
  );
  assert.doesNotThrow(() => assertPlatform('linux'));
  assert.doesNotThrow(() => assertPlatform('darwin'));
});

test('C1: signerd 是可独立运行的进程，且单实例锁拒绝第二个 serve', async () => {
  const rig = await bootSignerd();
  const cli = join(process.cwd(), 'scripts', 'signerd.mjs');
  assert.equal(existsSync(cli), true, '需要 scripts/signerd.mjs');
  const childArgs = [cli, 'serve', '--home', rig.paths.home, '--socket', rig.paths.socket];
  try {
    const blocked = spawn(process.execPath, childArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    const exitCode = await new Promise<number | null>((resolve) => blocked.once('exit', (code) => resolve(code)));
    assert.notEqual(exitCode, 0, '已有实例持锁时第二个 serve 必须非零退出');

    await rig.running.close();
    const serving = spawn(process.execPath, childArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      await waitFor(() => existsSync(rig.paths.socket));
      const client = new SignerdClient({ paths: rig.paths });
      const status = await client.status();
      assert.equal(status.ok, true);
      if (status.ok) assert.equal(status.locked, true);
    } finally {
      if (serving.exitCode === null) serving.kill('SIGTERM');
      await new Promise<void>((resolve) => serving.once('exit', () => resolve()));
    }
  } finally {
    await rig.close();
  }
});

test('C6/C7: 一次解锁只能签一次，签完回 locked', async () => {
  const rig = await bootSignerd();
  try {
    assert.equal((await rig.client.unlock({ actor: TEST_ACTOR, actor_kind: 'human', passphrase: TEST_PASSPHRASE, frontier: 'f-1' })).ok, true);
    const first = await rig.client.sign(signRequest());
    assert.equal(first.ok, true);
    const second = await rig.client.sign(signRequest({ decision_id: 'd-2', nonce: 'n-2' }));
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.reason_code, 'awaiting_unlock');
    const status = await rig.client.status();
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.locked, true);
  } finally {
    await rig.close();
  }
});

test('C6: 解锁后 frontier 变 ⇒ frontier_stale 且窗口作废', async () => {
  const rig = await bootSignerd();
  try {
    assert.equal((await rig.client.unlock({ actor: TEST_ACTOR, actor_kind: 'human', passphrase: TEST_PASSPHRASE, frontier: 'f-old' })).ok, true);
    const stale = await rig.client.sign(signRequest({ frontier: 'f-new' }));
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.reason_code, 'frontier_stale');
    const retry = await rig.client.sign(signRequest({ nonce: 'n-2' }));
    assert.equal(retry.ok, false, 'frontier_stale 后旧 frontier 也不能再用');
  } finally {
    await rig.close();
  }
});

test('C7: TTL 到期失效（注入时钟）；缺省 ttl=0 表示不带定时窗口', async () => {
  let nowMs = Date.parse('2026-11-14T00:00:00.000Z');
  const rig = await bootSignerd({ ttl: '5', now: () => new Date(nowMs) });
  try {
    const unlocked = await rig.client.unlock({
      actor: TEST_ACTOR,
      actor_kind: 'human',
      passphrase: TEST_PASSPHRASE,
      frontier: 'f-1',
    });
    assert.equal(unlocked.ok, true);
    if (unlocked.ok) {
      assert.equal(unlocked.ttl_minutes, 5);
      assert.notEqual(unlocked.window_until, null);
    }
    nowMs += 6 * 60_000;
    const expired = await rig.client.sign(signRequest());
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.reason_code, 'frontier_stale');
  } finally {
    await rig.close();
  }

  const ttl0 = await bootSignerd();
  try {
    const status = await ttl0.client.status();
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.ttl_minutes, 0);
  } finally {
    await ttl0.close();
  }
});

test('C11: sign_ms 是真实测量（注入 60ms 延迟会反映在回执里）', async () => {
  const rig = await bootSignerd({ signDelayMs: 60 });
  try {
    assert.equal((await rig.client.unlock({ actor: TEST_ACTOR, actor_kind: 'human', passphrase: TEST_PASSPHRASE, frontier: 'f-1' })).ok, true);
    const signed = await rig.client.sign(signRequest());
    assert.equal(signed.ok, true);
    if (signed.ok) {
      assert.ok(signed.sign_ms >= 55, `sign_ms=${String(signed.sign_ms)} 应包含注入的 60ms 延迟`);
      assert.ok(signed.unlock_wait_ms >= 0);
      assert.notEqual(signed.sign_ms, 0);
    }
  } finally {
    await rig.close();
  }
});

test('C4: socket 层拒绝 agent 触发 sign（not_a_signer）', async () => {
  const rig = await bootSignerd();
  try {
    assert.equal((await rig.client.unlock({ actor: TEST_ACTOR, actor_kind: 'human', passphrase: TEST_PASSPHRASE, frontier: 'f-1' })).ok, true);
    const response = await rig.client.sign(signRequest({ actor: 'agent-1', actor_kind: 'agent' }));
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.reason_code, 'not_a_signer');
  } finally {
    await rig.close();
  }
});
