/**
 * M4-G / R1 · 同文件并发写的独立进程端（两个 node 进程各跑一次）。
 *
 * 协议：子进程建工作副本 → 写主树同一路径的不同内容 → commit → READY → 等 START →
 * 同时 `admitWorkcopy`。父进程负责起跑、在锁被持有时读活锁行、读回主树字节并判
 * “字节 = 赢家内容”。正常模式下赢家在 `beforeRewrite`（已持根锁）写 HELD 文件并等
 * 父进程放行，确保输家必然撞上活锁；变异模式（`M4_G_MUTATION=R1`）在 hook 里主动
 * 释放根锁，用于证明“没有锁闸时不会恰 1 成 1 败”。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { admitWorkcopy, commitWorkcopy, createWorkcopy } from '../../../lib/src/db/workcopy.js';
import { releaseMainTreeLock } from '../../../lib/src/db/lock.js';
import { openSdoDatabase } from '../../../lib/src/db/open.js';
import { PASSPHRASE } from '../../../lib/test/db/append-helpers.js';

const AT = '2026-11-17T10:00:00.000Z';
const ADMIT_AT = '2026-11-17T10:00:10.000Z';
const SESSION = { actor: 'fixture-root', actor_kind: 'service' };

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(file, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${file}`);
    sleep(5);
  }
}

function write(out, result) {
  writeFileSync(out, `${JSON.stringify(result)}\n`, 'utf8');
}

async function main() {
  const root = process.env['M4_R1_ROOT'];
  const dbPath = process.env['M4_R1_DB'];
  const card = process.env['M4_R1_CARD'];
  const path = process.env['M4_R1_PATH'];
  const value = process.env['M4_R1_VALUE'];
  const ready = process.env['M4_R1_READY'];
  const start = process.env['M4_R1_START'];
  const held = process.env['M4_R1_HELD'];
  const release = process.env['M4_R1_RELEASE'];
  const out = process.env['M4_R1_OUT'];
  const base = process.env['M4_R1_BASE'] ?? 'SNAP-BASE';
  if ([root, dbPath, card, path, value, ready, start, out].some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error('R1 worker missing env');
  }

  const db = openSdoDatabase(dbPath, PASSPHRASE);
  try {
    const created = await createWorkcopy(db, { root, card, base_snapshot_id: base, session: SESSION, at: AT });
    if (!created.ok) return write(out, { card, value, ok: false, phase: 'create', reason_code: created.reason_code });
    writeFileSync(join(root, '.work', card, path), value, 'utf8');
    const committed = await commitWorkcopy(db, { root, card, base_snapshot_id: base, message: `r1 ${card}` });
    if (!committed.ok) return write(out, { card, value, ok: false, phase: 'commit', reason_code: committed.reason_code });

    writeFileSync(ready, 'ready\n', 'utf8');
    waitFor(start);

    const mutation = process.env['M4_G_MUTATION'] === 'R1';
    const hold = process.env['M4_R1_HOLD'] === '1';
    const beforeRewrite = mutation
      ? () => { releaseMainTreeLock(db, { session: SESSION, at: ADMIT_AT }); }
      : hold
        ? () => { writeFileSync(held, `${card}\n`, 'utf8'); waitFor(release); }
        : undefined;
    const admitted = await admitWorkcopy(db, {
      root, card, base_snapshot_id: base, message: `admit ${card}`, session: SESSION, at: ADMIT_AT,
      snapshot_id: `SNAP-${card}`,
      ...(beforeRewrite === undefined ? {} : { beforeRewrite }),
    });
    write(out, { card, value, ok: admitted.ok, reason_code: admitted.ok ? null : admitted.reason_code, message: admitted.message ?? null });
  } finally {
    db.close();
  }
}

try {
  await main();
} catch (error) {
  const out = process.env['M4_R1_OUT'];
  const message = error && error.stack ? error.stack : String(error);
  if (typeof out === 'string' && out.length > 0) writeFileSync(out, `${JSON.stringify({ ok: false, crash: message })}\n`, 'utf8');
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
