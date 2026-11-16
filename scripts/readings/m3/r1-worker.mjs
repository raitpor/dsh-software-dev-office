#!/usr/bin/env node
/**
 * M3-G R1 · 并发写子进程：等父进程发令后循环 append 同字段 CAS 写。
 *
 * 自己重试链头变化/锁竞争；最终输出一行 JSON（ok / conflict / fail），父进程解析。
 * 不是模拟并发：两个进程各自打开同一个 SQLite 文件（A2）。
 */
import { openSdoDatabase } from '../../../lib/src/db/open.js';
import { chainHead } from '../../../lib/src/db/write.js';
import { buildEvent } from '../../../lib/src/db/freeze-store.js';
import { appendAs } from '../../../lib/test/db/append-auth.js';

const [dbPath, passphrase, actor, subject, idPrefix, baseHash, value, startAtRaw] = process.argv.slice(2);
const startAt = Number(startAtRaw);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const db = openSdoDatabase(dbPath, passphrase);
try {
  while (Date.now() < startAt) await sleep(1);
  const startedAt = new Date().toISOString();
  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= 600; attempt += 1) {
    const id = `${idPrefix}-a${attempt}`;
    const event = buildEvent(
      {
        id,
        at: new Date(Date.now()).toISOString(),
        actor,
        kind: 'spec.revised',
        subject,
        payload: { clause: value, reason: 'M3-G R1 并发编辑', field: 'clause', base_hash: baseHash, value },
        caused_by: [],
        request_id: `m3g-r1:${id}`,
      },
      chainHead(db),
    );
    const result = appendAs(db, [event]);
    if (result.ok) {
      emit({ actor, outcome: 'ok', event_id: id, written: result.written, started_at: startedAt });
      process.exitCode = 0;
      break;
    }
    lastReason = result.reason_code;
    if (result.reason_code === 'conflict') {
      emit({ actor, outcome: 'conflict', message: result.message ?? null, started_at: startedAt });
      process.exitCode = 0;
      break;
    }
    if (!['event_chain_broken', 'append_conflict', 'database_busy'].includes(result.reason_code)) {
      emit({ actor, outcome: 'fail', reason_code: result.reason_code, message: result.message ?? null, started_at: startedAt });
      process.exitCode = 1;
      break;
    }
    await sleep(2);
    if (attempt === 600) {
      emit({ actor, outcome: 'fail', reason_code: lastReason, message: 'retries exhausted' });
      process.exitCode = 1;
    }
  }
} finally {
  db.close();
}
