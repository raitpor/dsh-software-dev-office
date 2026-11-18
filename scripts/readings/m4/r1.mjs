/**
 * M4-G / C1 · R1 同文件并发写（真路径：工作副本 → 主树文件）。
 *
 * 两个独立 node 子进程共享同一个 git 仓/库：各自 `createWorkcopy` → 在 `.work/<card>/`
 * 写同一路径的不同内容 → `commitWorkcopy` → READY/START 屏障后同时 `admitWorkcopy`。
 *
 * S1 同一路径：恰 1 成 1 败（败者 `lock_conflict`）、争用期活锁 1 行、主树文件字节 =
 * 赢家写入内容（从文件系统读回，不读事件自报字段）。
 * S2 不相交路径：两卡各写 `src/app.ts` / `docs/x.md`，期望都成功；若实际仍由主树根锁
 * 串行化而冲突，则照实记 partial（C1 证据来自根锁，路径前缀粒度未被该读数覆盖）。
 *
 * 变异 `M4_G_MUTATION=R1`：子进程在 `beforeRewrite`（已持根锁）主动释放根锁，两进程
 * 都可能成功 → 判据必须变 fail。注意正常失败码必须是 `lock_conflict`；若子进程因
 * merge/dirty 等其他路径失败，pass 不成立，raw 会原样给出 reason_code。
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openSdoDatabase } from '../../../lib/src/db/open.js';
import { PASSPHRASE } from '../../../lib/test/db/append-helpers.js';
import { activeLockRows, countEvents, prepareWorkcopyRepo } from './helpers.mjs';

const WORKER = fileURLToPath(new URL('./r1-worker.mjs', import.meta.url));
const mutation = process.env['M4_G_MUTATION'] === 'R1';

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function awaitFile(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${file}`);
    sleep(5);
  }
}

function awaitFileUntil(file, other, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && !existsSync(other)) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${file}`);
    sleep(5);
  }
}

function runChild(env, errFile) {
  return new Promise((resolve) => {
    const fd = openSync(errFile, 'w');
    const child = spawn(process.execPath, [WORKER], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', fd] });
    child.on('exit', (code) => { closeSync(fd); resolve(code); });
  });
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, crash: 'no result file' };
  }
}

async function runScenario({ label, cards, hold, disableLock }) {
  const fixture = await prepareWorkcopyRepo(label, cards.map((card) => ({ card: card.card, scope: card.scope })));
  const control = mkdtempSync(join(tmpdir(), `sdo-m4g-${label}-ctl-`));
  const start = join(control, 'start');
  const held = join(control, 'held');
  const release = join(control, 'release');
  const paths = Object.fromEntries(cards.map((card) => [card.card, {
    ready: join(control, `ready-${card.card}`),
    out: join(control, `out-${card.card}.json`),
  }]));
  const lockRowsDuring = [];
  let db;
  const eventKinds = ['lock.acquired', 'lock.released', 'snapshot.taken', 'workcopy.removed', 'workcopy.created'];
  let baselineCounts = {};
  try {
    db = openSdoDatabase(fixture.dbPath, PASSPHRASE);
    baselineCounts = countEvents(db, eventKinds);
    db.close();
    db = undefined;
    const common = {
      M4_R1_ROOT: fixture.root,
      M4_R1_DB: fixture.dbPath,
      M4_R1_BASE: fixture.baseSnapshot,
      M4_R1_START: start,
      ...(hold ? { M4_R1_HOLD: '1' } : {}),
      M4_R1_HELD: held,
      M4_R1_RELEASE: release,
      ...(disableLock ? { M4_G_MUTATION: 'R1' } : {}),
    };
    // 建副本/commit 会 append 事件，串行准备避免两进程写库撞 SQLITE_BUSY；
    // 两边都 READY 后再同时放行 admit，并发点仍是真并发。
    const children = [];
    for (const card of cards) {
      children.push(runChild({
        ...common,
        M4_R1_CARD: card.card,
        M4_R1_PATH: card.path,
        M4_R1_VALUE: card.value,
        M4_R1_READY: paths[card.card].ready,
        M4_R1_OUT: paths[card.card].out,
      }, join(control, `err-${card.card}.log`)));
      const ready = paths[card.card].ready;
      const out = paths[card.card].out;
      awaitFileUntil(ready, out);
      if (!existsSync(ready)) {
        const err = readFileSync(join(control, `err-${card.card}.log`), 'utf8');
        const result = readFileSync(out, 'utf8');
        throw new Error(`child ${card.card} ended before READY: ${result}\nchild stderr:\n${err}`);
      }
    }
    writeFileSync(start, 'go\n', 'utf8');

    if (hold && !disableLock) {
      awaitFile(held);
      db = openSdoDatabase(fixture.dbPath, PASSPHRASE);
      lockRowsDuring.push(...activeLockRows(db));
      db.close();
      db = undefined;
      // 让输家有时间走到锁检查（否则赢家过快释放会让 S2 偶发两成）；这是同步工具，不改变产品语义。
      sleep(900);
      writeFileSync(release, 'go\n', 'utf8');
    }
    const exits = await Promise.all(children);
    const results = cards.map((card) => {
      const parsed = readJson(paths[card.card].out);
      return { expected_value: card.value, expected_path: card.path, ...parsed };
    });
    if (db === undefined) db = openSdoDatabase(fixture.dbPath, PASSPHRASE);
    const counts = countEvents(db, eventKinds);
    const deltas = Object.fromEntries(eventKinds.map((kind) => [kind, (counts[kind] ?? 0) - (baselineCounts[kind] ?? 0)]));
    const locksAfter = activeLockRows(db);
    const mainBytes = Object.fromEntries(cards.map((card) => [card.path, readFileSync(join(fixture.root, card.path), 'utf8')]));
    const winners = results.filter((item) => item.ok === true);
    const losers = results.filter((item) => item.ok === false);
    const samePath = new Set(cards.map((card) => card.path)).size === 1;

    let pass;
    if (samePath) {
      pass = winners.length === 1
        && losers.length === 1
        && losers[0].reason_code === 'lock_conflict'
        && lockRowsDuring.length === 1
        && lockRowsDuring[0].path_prefix === ''
        && deltas['snapshot.taken'] === 1
        && deltas['workcopy.removed'] === 1
        && mainBytes[cards[0].path] === winners[0].value;
    } else {
      pass = winners.length === 2
        && deltas['snapshot.taken'] === 2
        && cards.every((card) => mainBytes[card.path] === card.value);
    }

    return {
      processes: cards.length,
      results,
      exits,
      main_tree_bytes: mainBytes,
      winner_value: samePath ? (winners[0]?.value ?? null) : null,
      lock_rows_during: lockRowsDuring,
      lock_rows_after: locksAfter,
      event_counts: counts,
      event_deltas: deltas,
      lock_scope_observed: 'main-tree-root',
      pass,
    };
  } finally {
    if (db !== undefined && db.open === true) db.close();
    fixture.cleanup();
    rmSync(control, { recursive: true, force: true });
  }
}

export async function r1() {
  const s1 = await runScenario({
    label: 'r1-s1',
    hold: true,
    disableLock: mutation,
    cards: [
      { card: 'CARD-R1-A', path: 'src/app.ts', value: 'winner-a', scope: ['src/app.ts'] },
      { card: 'CARD-R1-B', path: 'src/app.ts', value: 'winner-b', scope: ['src/app.ts'] },
    ],
  });
  const s2 = mutation
    ? { skipped: '变异只跑 S1' }
    : await runScenario({
      label: 'r1-s2',
      hold: true,
      disableLock: false,
      cards: [
        { card: 'CARD-R1-A', path: 'src/app.ts', value: 'disjoint-a', scope: ['src/app.ts'] },
        { card: 'CARD-R1-B', path: 'docs/x.md', value: 'disjoint-b', scope: ['docs/x.md'] },
      ],
    });

  const s1Pass = mutation ? s1.pass === false : s1.pass;
  const s2Pass = mutation ? true : s2.pass === true;
  const verdict = mutation
    ? (s1Pass && s2Pass ? 'fail' : 'fail')
    : (s1Pass && s2Pass ? 'pass' : s1Pass ? 'partial' : 'fail');
  const mutationRedReasons = mutation
    ? s1.results.filter((item) => item.ok !== true).map((item) => item.reason_code ?? 'unknown')
    : [];
  const caveat = mutation
    ? `变异在 beforeRewrite 立即释放根锁：S1 不再同时满足“恰 1 成 1 败 + 争用期活锁 1 行”，判据变红——证明读数观测的是锁闸。变异红因可能不是 lock_conflict（本次 ${JSON.stringify(mutationRedReasons)}；例如 dirty_main_tree 或锁窗口不稳定），两者都记录在 raw，不把红因冒充成锁冲突。`
    : verdict === 'pass'
      ? '两个独立 node 子进程经 READY/START 同时 admit；最终字节从主树文件读回。S1 失败码=lock_conflict，S2 不相交路径两成。'
      : verdict === 'partial'
        ? 'S1 成立；S2 不相交路径仍被主树根锁冲突 ⇒ 照实记 partial：C1 证据来自根锁，路径前缀粒度未被该读数覆盖（与 M4-1 D-135 一致）。见 s2.results。'
        : 'S1 未成立：胜负/失败码/活锁/最终字节至少一项不符，见 measured.s1。';

  return {
    id: 'R1',
    question: '两个独立进程在同库、同路径写不同内容后同时 admit：是否恰 1 成 1 败（lock_conflict）、活锁 1 行、主树文件字节=赢家内容？',
    command: 'node scripts/m4-readings.mjs --only R1',
    measured: { mutation: mutation ? 'release-root-lock-in-hook' : null, mutation_red_reasons: mutation ? mutationRedReasons : null, s1, s2 },
    verdict,
    caveat,
  };
}
