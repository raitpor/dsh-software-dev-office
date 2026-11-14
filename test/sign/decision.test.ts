/**
 * M2-0 C3/C4/C5/C8/C9：decision 真路径——不盲签、不可代签、网关验签、verify 认账。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { computeEventHash } from '../../src/core/verify-events.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { append, chainHead } from '../../src/db/write.js';
import { SignerdClient } from '../../src/sign/client.js';
import { canonicalJson, sha256Hex } from '../../src/core/fold/canonical.js';
import { signerdPaths } from '../../src/sign/paths.js';
import { initializeSignerd } from '../../src/sign/signerd.js';
import {
  prepareDecision,
  recordSecurityAlert,
  renderProposition,
  signDecision,
  unlockSigner,
  type DecisionRequest,
  type SignDivergedFailure,
} from '../../src/sign/decision.js';
import { parseReceipt, receiptHash, verifyReceiptChain, type SignerdReceipt } from '../../src/sign/receipt.js';
import { verifyDecisionSignatures } from '../../src/sign/verify.js';
import { bootSignerd, TEST_ACTOR, TEST_PASSPHRASE, TEST_PRODUCER, type SignerdRig } from './helpers.js';

const AT = '2026-11-14T00:00:00.000Z';

function rows(db: SdoDatabase, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return (db.prepare(sql).all(...params) as unknown) as Array<Record<string, unknown>>;
}

async function withRigAndDb(run: (db: SdoDatabase, rig: SignerdRig) => Promise<void>): Promise<void> {
  const rig = await bootSignerd();
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m2-db-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), TEST_PASSPHRASE);
  try {
    runMigrations(db);
    await run(db, rig);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    await rig.close();
  }
}

function baseRequest(frontier: string): DecisionRequest & { now: Date } {
  return {
    decision_kind: 'intent',
    subject: 'sdo.m2',
    value: 'ship',
    evidence: ['ev-1'],
    difference: '从 M1 到 M2',
    consequence: '授权链变真',
    actor: TEST_ACTOR,
    actor_kind: 'human',
    producer: TEST_PRODUCER,
    channel: 'ui',
    frontier,
    now: new Date(AT),
  };
}

async function unlock(db: SdoDatabase, client: SignerdClient): Promise<void> {
  const outcome = await unlockSigner(db, client, {
    actor: TEST_ACTOR,
    actor_kind: 'human',
    passphrase: TEST_PASSPHRASE,
    frontier: chainHead(db),
    now: new Date(AT),
  });
  assert.equal(outcome.ok, true);
}

test('D-062：extra 铺到 payload 顶层（baseline 等是顶层字段，不是 payload.extra）', () => {
  const prepared = prepareDecision({
    ...baseRequest('sha256:genesis'),
    extra: {
      baseline: { baseline_id: 'b-1' },
      guarantee_delta: { no_blind_sign: 'kept' },
      spec_ids: ['SPEC-1'],
    },
  });
  assert.ok(!('reason_code' in prepared));
  if ('reason_code' in prepared) return;
  assert.equal('extra' in prepared.payload, false, 'payload 不允许再有 extra 嵌套层');
  assert.deepEqual(prepared.payload['baseline'], { baseline_id: 'b-1' });
  assert.deepEqual(prepared.payload['spec_ids'], ['SPEC-1']);
  assert.equal(prepared.payload_hash, `sha256:${sha256Hex(canonicalJson(prepared.payload))}`);
});

test('D-062：extra 键与固定字段重名 ⇒ invalid_field、0 行、链上无事件', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    const outcome = await signDecision(db, rig.client, {
      ...baseRequest(chainHead(db)),
      extra: { value: 'sneaky', baseline: { baseline_id: 'b-1' } },
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason_code, 'invalid_field');
    assert.equal(rows(db, 'SELECT id FROM decision').length, 0);
    assert.equal(rows(db, 'SELECT id FROM event').length, 0, '碰撞必须在 prepare 阶段拒，链上零事件');
  });
});

test('C5: 四元组不全 ⇒ no_blind_sign，0 行', () => {
  const request = baseRequest('f-1');
  const prepared = prepareDecision({ ...request, difference: ' ' });
  assert.equal('reason_code' in prepared, true);
  if ('reason_code' in prepared) assert.equal(prepared.reason_code, 'no_blind_sign');
});

test('C5: 调用方命题与 renderer 不一致 ⇒ no_blind_sign；一致才通过', () => {
  const request = baseRequest('f-1');
  const mismatch = prepareDecision({ ...request, proposition: '模型自己写的命题' });
  assert.equal('reason_code' in mismatch, true);
  if ('reason_code' in mismatch) assert.equal(mismatch.reason_code, 'no_blind_sign');
  const consistent = prepareDecision({
    ...request,
    proposition: renderProposition({ subject: 'sdo.m2', value: 'ship', consequence: '授权链变真' }),
  });
  assert.equal('reason_code' in consistent, false);
});

test('C3: 未解锁 ⇒ awaiting_unlock，decision 0 行且事件 0 条', async () => {
  await withRigAndDb(async (db, rig) => {
    const outcome = await signDecision(db, rig.client, baseRequest(chainHead(db)));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason_code, 'awaiting_unlock');
    assert.equal(rows(db, 'SELECT id FROM decision').length, 0);
    assert.equal(rows(db, 'SELECT id FROM event').length, 0);
  });
});

test('C4: agent 触发签发 ⇒ not_a_signer + 一条 security.alert（ack，不落业务表）', async () => {
  await withRigAndDb(async (db, rig) => {
    const outcome = await signDecision(db, rig.client, {
      ...baseRequest(chainHead(db)),
      actor: 'agent-1',
      actor_kind: 'agent',
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason_code, 'not_a_signer');
    const events = rows(db, "SELECT kind, payload FROM event WHERE kind = 'security.alert'");
    assert.equal(events.length, 1);
    const payload = JSON.parse(String(events[0]?.['payload'])) as Record<string, unknown>;
    assert.equal(payload['alert'], 'proxy_sign_attempt');
    assert.equal(rows(db, 'SELECT id FROM decision').length, 0);
  });
});

test('成功签发：decision 行 key_id/channel 与 receipt 一致，verify 认账', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    const frontier = chainHead(db);
    const outcome = await signDecision(db, rig.client, baseRequest(frontier));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const decision = rows(db, 'SELECT signature, key_id, channel, signer, frontier FROM decision WHERE id = ?', outcome.decision_id)[0];
    assert.ok(decision);
    assert.equal(decision['signature'], outcome.signature);
    assert.equal(decision['key_id'], outcome.key_id);
    assert.equal(decision['channel'], 'ui');
    assert.equal(decision['frontier'], frontier);
    const receiptLines = (await import('node:fs')).readFileSync(rig.paths.receiptsFile, 'utf8').trim().split('\n');
    const receipt = JSON.parse(receiptLines[receiptLines.length - 1] ?? '{}') as Record<string, unknown>;
    assert.equal(receipt['signature'], decision['signature']);
    assert.equal(receipt['key_id'], decision['key_id']);
    assert.equal(receipt['channel'], decision['channel']);
    const report = verifyDecisionSignatures(db, { home: rig.paths.home });
    assert.deepEqual(report, { ok: true, checked: 1, problems: [] });
  });
});

test('C8: 裸 append decision.signed（假签名）⇒ signature_not_from_signerd，0 行', async () => {
  await withRigAndDb(async (db) => {
    const event = {
      id: randomUUID(),
      at: AT,
      actor: TEST_ACTOR,
      kind: 'decision.signed',
      subject: 'd-bare',
      payload: {
        payload_hash: 'sha256:aa',
        proposition_hash: 'sha256:bb',
        frontier: 'f-1',
        nonce: 'n-1',
        signature: Buffer.alloc(64, 7).toString('base64'),
        key_id: 'ed25519:not-trusted',
        signer: TEST_ACTOR,
        channel: 'ui',
        signerd: { receipt_id: 'rcpt:fake', at: AT, unlock_wait_ms: 0, sign_ms: 0 },
      },
      request_id: `req-${randomUUID()}`,
      caused_by: [] as string[],
      prev: chainHead(db),
      hash: '',
    };
    const withHash = { ...event, hash: computeEventHash(event) };
    const result = append(db, [withHash]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_code, 'signature_not_from_signerd');
    assert.equal(rows(db, 'SELECT id FROM event').length, 0);
    assert.equal(rows(db, 'SELECT id FROM decision').length, 0);
  });
});

test('C9: 改签名 ⇒ verify 红 runtime_inconsistent；缺受信 key ⇒ signature_unverifiable', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    const outcome = await signDecision(db, rig.client, baseRequest(chainHead(db)));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    db.prepare("UPDATE decision SET signature = 'tampered' WHERE id = ?").run(outcome.decision_id);
    const tampered = verifyDecisionSignatures(db, { home: rig.paths.home });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.problems[0]?.code, 'runtime_inconsistent');

    db.prepare('UPDATE decision SET signature = ? WHERE id = ?').run(outcome.signature, outcome.decision_id);
    // 空但 0700 的 home（无受信 key）⇒ 无法证明来源：
    const emptyHome = join(rig.root, 'empty-home');
    (await import('node:fs')).mkdirSync(emptyHome, { mode: 0o700 });
    const noKey = verifyDecisionSignatures(db, { home: emptyHome });
    assert.equal(noKey.ok, false);
    assert.equal(noKey.problems[0]?.code, 'signature_unverifiable');
    // home 不存在/权限过宽 ⇒ 信任根不安全（D-054）：
    const badHome = verifyDecisionSignatures(db, { home: join(rig.root, 'no-such-home') });
    assert.equal(badHome.problems[0]?.code, 'signerd_home_insecure');
    assert.equal(verifyDecisionSignatures(db, { home: rig.paths.home }).ok, true);
  });
});


test('C8 静态扫描：decision.signed 只在 src/sign/ 里构造（其余产品代码零处构造签名载荷）', () => {
  const offenders = readdirSync('src', { recursive: true })
    .map((entry) => join('src', String(entry)))
    .filter((path) => path.endsWith('.ts'))
    .filter((path) => !path.startsWith(join('src', 'sign')))
    .filter((path) => /kind:\s*'decision\.signed'/u.test(readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, []);
});

function withPlainDb(run: (db: SdoDatabase) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m2-plain-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), TEST_PASSPHRASE);
  try {
    runMigrations(db);
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('P1-1 回归：解锁后链头前进（无关 ACK），旧 frontier 签发 ⇒ frontier_stale、0 行、窗口失效', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    const staleFrontier = chainHead(db);
    recordSecurityAlert(db, {
      actor: 'agent-1',
      actor_kind: 'agent',
      at: AT,
      detail: 'unrelated ack moves the chain head',
    });
    assert.notEqual(chainHead(db), staleFrontier, 'ACK 事件必须让链头前进');
    const outcome = await signDecision(db, rig.client, baseRequest(staleFrontier));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason_code, 'frontier_stale');
    assert.equal(rows(db, 'SELECT id FROM decision').length, 0, '不得留下半条 decision 行');
    const status = await rig.client.status();
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.locked, true, 'frontier_stale 后窗口必须失效');
    const retry = await signDecision(db, rig.client, baseRequest(chainHead(db)));
    assert.equal(retry.ok, false);
    if (!retry.ok) assert.equal(retry.reason_code, 'awaiting_unlock');
  });
});

test('D-055: decision.valid 的 payload_hash 与 payload 不符 ⇒ append 拒 invalid_field、0 行', () => {
  withPlainDb((db) => {
    const event = {
      id: randomUUID(),
      at: AT,
      actor: TEST_ACTOR,
      kind: 'decision.valid',
      subject: 'd-mismatch',
      payload: {
        decision_kind: 'intent',
        payload_hash: 'sha256:aa',
        frontier: 'f-1',
        payload: { kind: 'intent', intent_id: 'INT-1' },
      },
      request_id: `req-${randomUUID()}`,
      caused_by: [] as string[],
      prev: chainHead(db),
      hash: '',
    };
    const result = append(db, [{ ...event, hash: computeEventHash(event) }]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason_code, 'invalid_field');
    assert.equal(rows(db, 'SELECT id FROM event').length, 0);
  });
});

test('D-055: 手工改库里的 decision.payload ⇒ verify 重算 payload_hash 后红 runtime_inconsistent', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    const outcome = await signDecision(db, rig.client, baseRequest(chainHead(db)));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    db.prepare('UPDATE decision SET payload = ? WHERE id = ?').run(
      JSON.stringify({ kind: 'intent', intent_id: 'INT-1', tampered: true }),
      outcome.decision_id,
    );
    const report = verifyDecisionSignatures(db, { home: rig.paths.home });
    assert.equal(report.ok, false);
    assert.equal(report.problems[0]?.code, 'runtime_inconsistent');
    assert.match(String(report.problems[0]?.detail), /payload_hash/u);
  });
});

test('P1-2/D-054: 回执哈希链被改 ⇒ verify 红 receipt_chain_broken', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    assert.equal((await signDecision(db, rig.client, baseRequest(chainHead(db)))).ok, true);
    const lines = readFileSync(rig.paths.receiptsFile, 'utf8').trim().split('\n');
    const first = parseReceipt(lines[0] ?? '');
    assert.ok(first);
    if (first === undefined) return;
    // 篡改第一条回执的前驱哈希（等价于插入/删除前言后的断链）。
    const forged = { ...first, prev_receipt_hash: `sha256:${'ab'.repeat(32)}` };
    writeFileSync(rig.paths.receiptsFile, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
    chmodSync(rig.paths.receiptsFile, 0o600);
    assert.notEqual(receiptHash(forged), receiptHash(first));
    const report = verifyDecisionSignatures(db, { home: rig.paths.home });
    assert.equal(report.ok, false);
    assert.equal(report.problems.some((problem) => problem.code === 'receipt_chain_broken'), true);
  });
});

test('P1-2/D-054: signerd home 权限过宽 ⇒ verify 红 signerd_home_insecure', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    assert.equal((await signDecision(db, rig.client, baseRequest(chainHead(db)))).ok, true);
    chmodSync(rig.paths.home, 0o755);
    try {
      const report = verifyDecisionSignatures(db, { home: rig.paths.home });
      assert.equal(report.ok, false);
      assert.equal(report.problems[0]?.code, 'signerd_home_insecure');
    } finally {
      chmodSync(rig.paths.home, 0o700);
    }
    assert.equal(verifyDecisionSignatures(db, { home: rig.paths.home }).ok, true);
  });
});

// ---- 第 3 轮（Lead m01152）：TOCTOU 复核、P2-1 返回体、P2-2 签名绑定、回执链插入/删除 ----

test('P1-1 第 3 轮：client.sign 内部并发 append ⇒ 签后复核 frontier_stale、0 行、回执丢弃、窗口失效', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    const frontier = chainHead(db);
    const receiptsBefore = readFileSync(rig.paths.receiptsFile, 'utf8').trim();
    const proxy = {
      sign: async (input: Parameters<SignerdClient['sign']>[0]) => {
        // 模拟并发写：signerd 正在签名时，另一个进程推进了链头。
        recordSecurityAlert(db, {
          actor: 'agent-1',
          actor_kind: 'agent',
          at: AT,
          detail: 'concurrent append while signing',
        });
        return rig.client.sign(input);
      },
      lock: (actor: string) => rig.client.lock(actor),
      discardReceiptOnFailure: (receiptId: string) => rig.client.discardReceiptOnFailure(receiptId),
    } as unknown as SignerdClient;
    const outcome = await signDecision(db, proxy, baseRequest(frontier));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason_code, 'frontier_stale');
    assert.equal(rows(db, 'SELECT id FROM decision').length, 0, '签后复核失败不得留下 decision 行');
    assert.equal(rows(db, 'SELECT id FROM event').length, 1, '只允许那条并发 alert（不得写 valid/signed）');
    assert.equal(readFileSync(rig.paths.receiptsFile, 'utf8').trim(), receiptsBefore, 'orphan 回执必须被丢弃');
    const status = await rig.client.status();
    assert.equal(status.ok, true);
    if (status.ok) assert.equal(status.locked, true, '签后复核失败必须让窗口失效');
  });
});

test('P1-1 第 3 轮：真实两进程时序（signerd 子进程 + 并发 append）⇒ frontier_stale、0 行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sdo-m2-proc-'));
  const dbDir = mkdtempSync(join(tmpdir(), 'sdo-m2-proc-db-'));
  let child: ReturnType<typeof spawn> | undefined;
  let errLines: ReturnType<typeof createInterface> | undefined;
  try {
    const paths = signerdPaths({ homeDir: join(root, 'home'), runtimeDir: join(root, 'run') });
    await initializeSignerd({ passphrase: TEST_PASSPHRASE, paths });
    child = spawn(
      process.execPath,
      ['scripts/signerd.mjs', 'serve', '--home', paths.home, '--socket', paths.socket, '--sign-delay-ms', '400'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const rl = createInterface({ input: child.stdout! });
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      rl.on('line', (line) => {
        buffer += line;
        if (buffer.includes('"serving":true')) resolve();
      });
      child!.once('exit', (code) => reject(new Error(`signerd 子进程提前退出：${String(code)}`)));
    });
    rl.close();
    // 不用固定 sleep：等 signerd 自己打出“已进入签名”的信号再并发 append（慢 CI 也稳）。
    errLines = createInterface({ input: child.stderr! });
    let signalSigning: () => void = () => undefined;
    const signingStarted = new Promise<void>((resolve) => {
      signalSigning = resolve;
    });
    errLines!.on('line', (line) => {
      if (line.includes('"phase":"signing_started"')) signalSigning();
    });
    const client = new SignerdClient({ paths, timeoutMs: 10_000 });
    const db = openSdoDatabase(join(dbDir, 'state', 'sdo.db'), TEST_PASSPHRASE);
    try {
      runMigrations(db);
      const unlocked = await unlockSigner(db, client, {
        actor: TEST_ACTOR,
        actor_kind: 'human',
        passphrase: TEST_PASSPHRASE,
        frontier: chainHead(db),
        now: new Date(AT),
      });
      assert.equal(unlocked.ok, true);
      const frontier = chainHead(db);
      let outcome;
      const pending = signDecision(db, client, baseRequest(frontier));
      await signingStarted;
      recordSecurityAlert(db, { actor: 'agent-1', actor_kind: 'agent', at: AT, detail: 'two-process drift' });
      outcome = await pending;
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.reason_code, 'frontier_stale');
      assert.equal(rows(db, 'SELECT id FROM decision').length, 0);
      assert.equal(rows(db, 'SELECT id FROM event').length, 1);
    } finally {
      db.close();
    }
  } finally {
    if (child !== undefined && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    errLines?.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  }
});

/** P2-1 故障注入：COMMIT 成功后令 chainHead 读到“漂移后”的哈希。 */
function driftingDb(db: SdoDatabase): SdoDatabase {
  let drifted = false;
  const fakeHash = `sha256:${'f'.repeat(64)}`;
  const fakeStatement = {
    get: () => ({ hash: fakeHash }),
    all: () => [{ hash: fakeHash }],
    run: () => ({ changes: 0 }),
  };
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'exec') {
        return (sql: string) => {
          const result = target.exec(sql);
          if (/^COMMIT$/iu.test(sql.trim())) drifted = true;
          return result;
        };
      }
      if (prop === 'prepare') {
        return (sql: string) => {
          if (drifted && sql.includes('ORDER BY rowid DESC LIMIT 1')) return fakeStatement;
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as SdoDatabase;
}

test('P2-1 第 3 轮：append 已提交但提交后链头漂移 ⇒ runtime_inconsistent + written_decision_id/events_written', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    const outcome = await signDecision(driftingDb(db), rig.client, baseRequest(chainHead(db)));
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.reason_code, 'runtime_inconsistent');
    const diverged = outcome as SignDivergedFailure;
    assert.equal(diverged.events_written, 2);
    assert.match(diverged.message ?? '', /人工核对/u);
    assert.equal(rows(db, 'SELECT id FROM decision WHERE id = ?', diverged.written_decision_id).length, 1);
    assert.equal(rows(db, 'SELECT id FROM event').length, 2);
  });
});

test('P2-2 第 3 轮：成对改 decision.payload 与 payload_hash（事件/回执不动）⇒ verify 红', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    const outcome = await signDecision(db, rig.client, baseRequest(chainHead(db)));
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    const forgedPayload = { kind: 'intent', intent_id: 'INT-forged' };
    const forgedHash = `sha256:${sha256Hex(canonicalJson(forgedPayload))}`;
    db.prepare('UPDATE decision SET payload = ?, payload_hash = ? WHERE id = ?').run(
      JSON.stringify(forgedPayload),
      forgedHash,
      outcome.decision_id,
    );
    const report = verifyDecisionSignatures(db, { home: rig.paths.home });
    assert.equal(report.ok, false);
    assert.equal(report.problems[0]?.code, 'runtime_inconsistent');
    assert.match(String(report.problems[0]?.detail), /签名载荷/u);
  });
});

test('P1-2/D-054: 回执链删除一条 ⇒ verify 红 receipt_chain_broken', async () => {
  await withRigAndDb(async (db, rig) => {
    for (let index = 0; index < 3; index += 1) {
      await unlock(db, rig.client);
      const outcome = await signDecision(db, rig.client, baseRequest(chainHead(db)));
      assert.equal(outcome.ok, true);
    }
    const text = readFileSync(rig.paths.receiptsFile, 'utf8');
    const lines = text.trim().split('\n');
    assert.equal(lines.length, 3);
    const deleted = [lines[0], ...lines.slice(2)].join('\n');
    writeFileSync(rig.paths.receiptsFile, `${deleted}\n`, { mode: 0o600 });
    chmodSync(rig.paths.receiptsFile, 0o600);
    const report = verifyDecisionSignatures(db, { home: rig.paths.home });
    assert.equal(report.ok, false);
    assert.equal(report.problems.some((problem) => problem.code === 'receipt_chain_broken'), true);
  });
});

test('P1-2/D-054: 回执链中间插入一条 ⇒ verify 红 receipt_chain_broken', async () => {
  await withRigAndDb(async (db, rig) => {
    for (let index = 0; index < 3; index += 1) {
      await unlock(db, rig.client);
      assert.equal((await signDecision(db, rig.client, baseRequest(chainHead(db)))).ok, true);
    }
    const lines = readFileSync(rig.paths.receiptsFile, 'utf8').trim().split('\n');
    const original = parseReceipt(lines[0] ?? '');
    assert.ok(original);
    if (original === undefined) return;
    const forged = { ...original, receipt_id: 'rcpt:forged-insert', nonce: 'nonce-forged-insert' };
    const inserted = [lines[0], JSON.stringify(forged), ...lines.slice(1)].join('\n');
    writeFileSync(rig.paths.receiptsFile, `${inserted}\n`, { mode: 0o600 });
    chmodSync(rig.paths.receiptsFile, 0o600);
    const report = verifyDecisionSignatures(db, { home: rig.paths.home });
    assert.equal(report.ok, false);
    assert.equal(report.problems.some((problem) => problem.code === 'receipt_chain_broken'), true);
  });
});

/** 第 4 轮 P1：在“签后复核通过 → append”之间注入一次并发写（append 的 BEGIN 前）。 */
function injectAlert(target: SdoDatabase, prev: string): void {
  const alert = {
    id: `ev-${randomUUID()}`,
    at: AT,
    actor: 'agent-1',
    kind: 'security.alert',
    subject: 'race-1',
    payload: { alert: 'proxy_sign_attempt', actor_kind: 'agent', at: AT, detail: 'race between recheck and append' },
    request_id: `req-${randomUUID()}`,
    caused_by: [] as string[],
    prev,
    hash: '',
  };
  const written = append(target, [{ ...alert, hash: computeEventHash(alert) }]);
  assert.equal(written.ok, true, '注入的并发事件必须写入成功');
}

/**
 * 第 5 轮 P2-1：纯测试注入，不碰产品代码。
 *
 * 在“签后复核”那次读链头（第 2 次）返回**旧值之后**同步 append 一条 alert：
 * · 新实现（`prev = afterSign`）⇒ append 的 prev 守卫失败 ⇒ `event_chain_broken`；
 * · 旧实现（建事件前再读一次 `chainHead`）⇒ 第三次读拿到新 head ⇒ 签成功。
 * 这样用例才真正区分两种实现（只注入在 BEGIN 前区分不了）。
 */
function racingDb(db: SdoDatabase): SdoDatabase {
  let headReads = 0;
  let injected = false;
  const headQuery = /SELECT hash FROM event ORDER BY rowid DESC LIMIT 1/u;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
      return (sql: string, ...rest: unknown[]) => {
        const statement = target.prepare(sql, ...(rest as []));
        if (!headQuery.test(sql)) return statement;
        return new Proxy(statement, {
          get(stmt, key) {
            const value = Reflect.get(stmt, key);
            if (key !== 'get') {
              return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(stmt) : value;
            }
            return (...args: unknown[]) => {
              const result = (value as (...args: unknown[]) => unknown).apply(stmt, args) as
                | Record<string, unknown>
                | undefined;
              headReads += 1;
              if (headReads === 2 && !injected) {
                injected = true;
                const previous = typeof result?.['hash'] === 'string' ? result['hash'] : chainHead(target);
                injectAlert(target, previous);
              }
              return result;
            };
          },
        }) as unknown as ReturnType<SdoDatabase['prepare']>;
      };
    },
  }) as SdoDatabase;
}

test('P1 第 4 轮：复核后、建事件前链头被推进 ⇒ event_chain_broken、0 行（prev 用 afterSign）', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    const outcome = await signDecision(racingDb(db), rig.client, baseRequest(chainHead(db)));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason_code, 'event_chain_broken');
    assert.equal(rows(db, 'SELECT id FROM decision').length, 0, 'prev 失配必须 0 行');
    assert.equal(rows(db, 'SELECT id FROM event').length, 1, '链上只允许注入的那条 alert');
  });
});

function fakeReceipt(overrides: Partial<SignerdReceipt> = {}): Omit<SignerdReceipt, 'prev_receipt_hash'> {
  return {
    version: 'sdo-signerd-receipt-v1',
    receipt_id: 'rcpt:other',
    decision_id: 'dec-other',
    payload_hash: `sha256:${'aa'.repeat(32)}`,
    proposition_hash: `sha256:${'bb'.repeat(32)}`,
    frontier: 'f-other',
    nonce: 'nonce-other',
    signature: Buffer.alloc(64, 3).toString('base64'),
    key_id: 'ed25519:other',
    signer: 'alice',
    channel: 'cli',
    at: AT,
    unlock_wait_ms: 0,
    sign_ms: 1,
    ...overrides,
  };
}

test('P2-2 第 4 轮：回执不在链尾 ⇒ 返回形状不变、本次回执标 consumed:false、链仍自洽', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    const frontier = chainHead(db);
    let ourReceiptId = '';
    const proxy = {
      sign: async (input: Parameters<SignerdClient['sign']>[0]) => {
        const signed = await rig.client.sign(input);
        if (signed.ok) {
          ourReceiptId = signed.receipt_id;
          // 追加一条“别人的”回执：我们的回执不再在链尾。
          rig.running.store.appendReceipt(fakeReceipt());
          // 推进链头，令签后复核失败并触发 discard。
          recordSecurityAlert(db, { actor: 'agent-1', actor_kind: 'agent', at: AT, detail: 'drift after sign' });
        }
        return signed;
      },
      lock: (actor: string) => rig.client.lock(actor),
      discardReceiptOnFailure: (receiptId: string) => rig.client.discardReceiptOnFailure(receiptId),
    } as unknown as SignerdClient;
    const outcome = await signDecision(db, proxy, baseRequest(frontier));
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason_code, 'frontier_stale');
    assert.equal(rows(db, 'SELECT id FROM decision').length, 0);
    const receipts = readFileSync(rig.paths.receiptsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => parseReceipt(line));
    assert.equal(receipts.length, 2);
    const ours = receipts.find((receipt) => receipt?.receipt_id === ourReceiptId);
    assert.ok(ours);
    assert.equal(ours?.consumed, false, '非链尾回执必须降级标记 consumed:false');
    assert.equal(receipts.some((receipt) => receipt?.receipt_id === 'rcpt:other'), true);
    assert.equal(verifyReceiptChain(receipts as SignerdReceipt[]).ok, true, '标记后仍须保持链自洽');
  });
});

test('P2-2 第 5 轮：回执被标 consumed:false ⇒ verify 对该 decision 报 signature_unverifiable（fail-closed）', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    const outcome = await signDecision(db, rig.client, baseRequest(chainHead(db)));
    assert.equal(outcome.ok, true);
    const text = readFileSync(rig.paths.receiptsFile, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    const first = parseReceipt(lines[0] ?? '');
    assert.ok(first !== undefined);
    // 把回执标成客户端失败清理标记：后缀链无需重算（它是第一条）。
    writeFileSync(rig.paths.receiptsFile, `${JSON.stringify({ ...first!, consumed: false })}\n`, {
      mode: 0o600,
    });
    chmodSync(rig.paths.receiptsFile, 0o600);
    const report = verifyDecisionSignatures(db, { home: rig.paths.home });
    assert.equal(report.ok, false);
    assert.equal(report.problems.length, 1);
    assert.equal(report.problems[0]?.code, 'signature_unverifiable');
  });
});

test('P2-2 第 4 轮：回执文件不可读 ⇒ discard 不抛异常，返回形状仍 frontier_stale', async () => {
  await withRigAndDb(async (db, rig) => {
    await unlock(db, rig.client);
    const frontier = chainHead(db);
    const proxy = {
      sign: async (input: Parameters<SignerdClient['sign']>[0]) => {
        const signed = await rig.client.sign(input);
        if (signed.ok) {
          chmodSync(rig.paths.receiptsFile, 0o000);
          recordSecurityAlert(db, { actor: 'agent-1', actor_kind: 'agent', at: AT, detail: 'drift with unreadable receipts' });
        }
        return signed;
      },
      lock: (actor: string) => rig.client.lock(actor),
      discardReceiptOnFailure: (receiptId: string) => rig.client.discardReceiptOnFailure(receiptId),
    } as unknown as SignerdClient;
    try {
      const outcome = await signDecision(db, proxy, baseRequest(frontier));
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.equal(outcome.reason_code, 'frontier_stale');
      assert.equal(rows(db, 'SELECT id FROM decision').length, 0);
    } finally {
      chmodSync(rig.paths.receiptsFile, 0o600);
    }
  });
});
