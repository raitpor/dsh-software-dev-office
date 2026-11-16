/**
 * M3-G R1 · 两人并发改同一字段 ⇒ 一个成功、一个 409；conflicts 可见双方主张。
 *
 * 真两进程（A2）：各开同一个 SQLite 文件，同一 base_hash 的 CAS 写。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { valueHash } from '../../../lib/src/core/conflict/hash.js';
import { chainHead } from '../../../lib/src/db/write.js';
import { buildEvent } from '../../../lib/src/db/freeze-store.js';
import { appendAs } from '../../../lib/test/db/append-auth.js';
import { appendEvents, AT, count, readRow, readRows, seedIntent, withSignRig } from './helpers.mjs';

const WORKER = fileURLToPath(new URL('./r1-worker.mjs', import.meta.url));
const SUBJECT = 'SPEC-M3G-R1';

function runWorker(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').at(-1) ?? '';
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = { outcome: 'fail', parse_error: line, stderr: stderr.slice(0, 400), code };
      }
      resolve(parsed);
    });
  });
}

export async function measureR1() {
  return await withSignRig(async ({ db, client, dir }) => {
    const intentId = await seedIntent(db, client);
    const seed = buildEvent(
      {
        id: 'ev-m3g-r1-seed',
        at: AT,
        actor: 'alice',
        kind: 'spec.defined',
        subject: SUBJECT,
        payload: { kind: 'requirement', intent_id: intentId, clause: 'v0', content_hash: 'h0' },
        caused_by: [],
        request_id: 'm3g-r1-seed',
      },
      chainHead(db),
    );
    appendEvents(db, [seed]);
    const baseHash = valueHash('v0');
    const dbPath = `${dir}/state/sdo.db`;
    const startAt = Date.now() + 1200;
    const results = await Promise.all([
      runWorker([dbPath, 'm3-g-readings-passphrase', 'alice', SUBJECT, 'ev-m3g-r1-alice', baseHash, 'alice-edit', String(startAt)]),
      runWorker([dbPath, 'm3-g-readings-passphrase', 'bob', SUBJECT, 'ev-m3g-r1-bob', baseHash, 'bob-edit', String(startAt)]),
    ]);
    const ok = results.filter((item) => item.outcome === 'ok');
    const conflicts = results.filter((item) => item.outcome === 'conflict');
    const revised = readRows(db, "SELECT id, actor FROM event WHERE kind = 'spec.revised' ORDER BY at");
    const detected = readRows(db, "SELECT id, actor, payload FROM event WHERE kind = 'conflict.detected'");
    const conflictRows = readRows(db, 'SELECT * FROM conflict ORDER BY id');
    const viewRows = readRows(db, 'SELECT * FROM conflicts ORDER BY id');
    const row = conflictRows[0] ?? {};
    const loserFromDetected = detected[0]?.actor;
    const winnerEvent = revised[0] ?? {};
    const clauses = readRows(db, 'SELECT clause FROM spec WHERE id = ?', SUBJECT);
    const measured = {
      seed_event_id: seed.id,
      base_hash: baseHash,
      worker_results: results,
      wall_clock_barrier_ms: 1200,
      ok_count: ok.length,
      conflict_count: conflicts.length,
      spec_revised_events: revised.map((item) => item.id),
      winner_event_id: ok[0]?.event_id ?? null,
      conflict_detected_event_id: detected[0]?.id ?? null,
      conflict_row_id: conflictRows[0]?.id ?? null,
      conflicts_view_rows: viewRows.length,
      subject: row['subject'] ?? null,
      field: row['field'] ?? null,
      winner_actor: row['winner_actor'] ?? null,
      loser_actor: row['loser_actor'] ?? null,
      winner_value: row['winner_value'] ?? null,
      loser_value: row['loser_value'] ?? null,
      detected_actor_is_loser: loserFromDetected === row['loser_actor'],
      // 失败方不落 spec.revised 事件：loser 没有 event id（这是预期，不是缺数据）。
      loser_event_actor_expected: null,
      loser_event_actor: null,
      stored_clause: clauses[0]?.['clause'] ?? null,
      event_table_rows: {
        spec_revised: count(db, "SELECT COUNT(*) FROM event WHERE kind = 'spec.revised'"),
        conflict_detected: count(db, "SELECT COUNT(*) FROM event WHERE kind = 'conflict.detected'"),
      },
    };
    // F1：最终落库的值必须等于赢家主张的值（winner_value 是 JSON 字符串，解一层比较）。
    const storedMatchesWinner =
      measured.winner_value !== null &&
      measured.stored_clause !== null &&
      JSON.parse(String(measured.winner_value)) === measured.stored_clause;
    const bothVisible =
      measured.winner_actor !== null &&
      measured.loser_actor !== null &&
      measured.winner_actor !== measured.loser_actor &&
      measured.winner_value !== measured.loser_value &&
      measured.winner_value !== null &&
      measured.loser_value !== null;
    const pass =
      measured.ok_count === 1 &&
      measured.conflict_count === 1 &&
      measured.conflicts_view_rows === 1 &&
      measured.event_table_rows.conflict_detected === 1 &&
      measured.event_table_rows.spec_revised === 1 &&
      measured.detected_actor_is_loser &&
      storedMatchesWinner &&
      bothVisible;
    return {
      id: 'R1',
      question: '两人并发改同一字段是否一个成功一个 409，且 conflicts 可见双方主张（不是 disputed）',
      command: 'node scripts/m3-readings.mjs --only R1',
      measured,
      verdict: pass ? 'pass' : 'fail',
      caveat: '两个独立 node 进程各开同一 SQLite 库（墙钟屏障 startAt=Date.now()+1200 不是冻结时钟，是否真重叠依赖机器速度；worker 的 started_at 已写进 raw 供核对）；写失败方按 2ms 退避重试链头变化，冲突判定来自真 append 返回的 reason_code=conflict（不是本地复算）。SQLite 无 busy_timeout，锁竞争由 append_conflict 重试覆盖。',
    };
  });
}
