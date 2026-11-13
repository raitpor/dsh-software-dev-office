/**
 * M0-G 读数夹具：临时库 + 合法事件链 + fold 行物化（沿 verify.test 的做法）。
 *
 * 纪律（卡 M0-G A3）：只在 `mkdtemp` 出的临时目录建库，不碰 `~/.local/state/sdo/`；
 * 夹具事件直接 INSERT（M0 没有写网关，A2），但不写任何业务数据进仓库。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fold } from '../../lib/src/core/fold/index.js';
import { GENESIS_PREV, computeEventHash } from '../../lib/src/core/verify.js';
import { runMigrations } from '../../lib/src/db/migrate.js';
import { openSdoDatabase } from '../../lib/src/db/open.js';

export const PASSPHRASE = 'm0-g-readings-passphrase';
export const AT = '2026-11-13T15:00:00.000Z';

export function makeChain() {
  const parts = [
    { kind: 'decision.valid', subject: 'd-int', payload: { decision_kind: 'intent', payload_hash: 'ph-intent', payload: {}, frontier: 'f-1' } },
    { kind: 'decision.signed', subject: 'd-int', payload: { payload_hash: 'ph-intent', signature: 'sig', key_id: 'k-1', signer: 'alice' } },
    { kind: 'intent.signed', subject: 'INT-1', payload: { decision_id: 'd-int', statement: 'ship it', owner: 'alice', strength: 'explicit', baseline_hash: 'h-1', content_hash: 'ch-1' } },
    { kind: 'spec.defined', subject: 'SPEC-1', payload: { intent_id: 'INT-1', clause: 'clause', kind: 'requirement', content_hash: 'ch-spec' } },
    { kind: 'task.created', subject: 'TASK-1', payload: { seq: 1, title: 'do it', kind: 'implement' } },
    { kind: 'release.frozen', subject: 'REL-1', payload: { package_version: '0.2.0', frozen_by: '{"by":"tester"}', frontier: 'f-1', baseline_hash: 'h-1', scope_spec_set: 's-1', items: [] } },
  ];
  let prev = GENESIS_PREV;
  return parts.map((part, index) => {
    const unsigned = {
      id: `e-m0g-${index + 1}`,
      at: AT,
      actor: 'tester',
      kind: part.kind,
      subject: part.subject,
      payload: part.payload,
      caused_by: [],
      request_id: `rq-${index + 1}`,
      prev,
      hash: '',
    };
    const hash = computeEventHash(unsigned);
    prev = hash;
    return { ...unsigned, hash };
  });
}

/** 合法 hash 链的 `query_miss` 事件（R4 夹具）。 */
export function appendQueryMisses(events, views) {
  let prev = events.length === 0 ? GENESIS_PREV : events[events.length - 1].hash;
  const extra = views.map((view, index) => {
    const unsigned = {
      id: `e-m0g-miss-${index + 1}`,
      at: AT,
      actor: 'tester',
      kind: 'query_miss',
      subject: view,
      payload: { view, reason: 'view_not_found' },
      caused_by: [],
      request_id: `rq-miss-${index + 1}`,
      prev,
      hash: '',
    };
    const hash = computeEventHash(unsigned);
    prev = hash;
    return { ...unsigned, hash };
  });
  return [...events, ...extra];
}

function insertEvents(db, events) {
  for (const kind of new Set(events.map((event) => event.kind))) {
    db.prepare('INSERT OR IGNORE INTO event_kind (kind, since, note) VALUES (?, ?, ?)').run(kind, AT, 'M0-G readings');
  }
  const insert = db.prepare(
    'INSERT INTO event (id, at, actor, kind, subject, payload, caused_by, request_id, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const event of events) {
    insert.run(
      event.id,
      event.at,
      event.actor,
      event.kind,
      event.subject,
      JSON.stringify(event.payload),
      JSON.stringify(event.caused_by),
      event.request_id,
      event.prev,
      event.hash,
    );
  }
}

function toSqlValue(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** 把 fold 投影写进库（只用于让 verify 有可对账的基线）。 */
export function insertFoldRows(db, events) {
  const state = fold(undefined, events);
  for (const table of ['decision', 'intent', 'spec', 'task', 'release']) {
    const columns = db.pragma(`table_info(${table})`).map((column) => column.name);
    for (const row of Object.values(state.tables[table])) {
      const values = Object.fromEntries(
        Object.entries(row).filter(([column]) => columns.includes(column)),
      );
      const names = Object.keys(values);
      if (names.length === 0) continue;
      const placeholders = names.map(() => '?').join(', ');
      db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`).run(
        ...names.map((name) => toSqlValue(values[name])),
      );
    }
  }
}

/** 在临时目录建一个已迁移的加密库；`run` 返回后自动关库、删目录。 */
export function withTempDb(run) {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m0-g-'));
  const dbPath = join(dir, 'state', 'sdo.db');
  let db;
  try {
    // open 也可能抛（错口令/目录不可写）：放在 try 里，保证临时目录一定被清掉。
    db = openSdoDatabase(dbPath, PASSPHRASE);
    runMigrations(db);
    return run({ db, dbPath, dir });
  } finally {
    if (db !== undefined) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export { insertEvents };
