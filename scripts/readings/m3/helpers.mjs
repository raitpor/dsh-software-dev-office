/**
 * M3-G · 读数公共装配（临时库、会话、计数、树快照）。
 *
 * 纪律：不碰 ~/.local/state/sdo/ 与仓库内 *.db/access.log；每条读数在 mkdtemp 新库上
 * 走产品路径（写网关 / signerd / judgeStage / dbRightsPort / 页面渲染），不测试直插。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { openSdoDatabase } from '../../../lib/src/db/open.js';
import { runMigrations } from '../../../lib/src/db/migrate.js';
import { chainHead } from '../../../lib/src/db/write.js';
import { buildEvent } from '../../../lib/src/db/freeze-store.js';
import { canonicalJson, sha256Hex } from '../../../lib/src/core/fold/canonical.js';
import { grantAll, grantFixtureRoster, appendAs } from '../../../lib/test/db/append-auth.js';
import { bootSignerd, TEST_ACTOR, TEST_PASSPHRASE, TEST_PRODUCER } from '../../../lib/test/sign/helpers.js';
import { unlockSigner, signDecision } from '../../../lib/src/sign/decision.js';
import { mkdtempSync as mkdtempSyncFs } from 'node:fs';

export const AT = '2026-11-16T09:00:00.000Z';
export const DEFAULT_INTENT = 'INT-M3G';
export const PASSPHRASE = 'm3-g-readings-passphrase';
export const SESSION_SCOPE = 'domain:core';

export function m3Session(actor, actor_kind = 'human') {
  return { actor, actor_kind, session_id: `m3g-${actor}`, credential: 'm3g-fixture' };
}

export function payloadHash(value) {
  return `sha256:${sha256Hex(canonicalJson(value ?? null))}`;
}

/** 造事件（链头由调用方给）。 */
export function makeEvent(fields, prev = chainHead(fields.db)) {
  const { db, ...rest } = fields;
  return buildEvent(rest, prev);
}

export function appendEvents(db, events) {
  const result = appendAs(db, events);
  if (!result.ok) throw new Error(`append failed: ${result.reason_code}: ${result.message ?? ''}`);
  return result;
}

export function count(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  const value = Object.values(row ?? {})[0];
  return Number(value ?? 0);
}

export function readRows(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function readRow(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

/** 一条读数运行：临时目录新库 + migrations + 常用 actor 全权。 */
export async function withM3Db(run) {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m3g-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    grantFixtureRoster(db);
    grantAll(db, 'reviewee');
    return await run({ db, dir });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'artifacts', '__pycache__']);

export function snapshotTree(root) {
  if (!existsSync(root)) return { exists: false, entries: [] };
  const entries = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(current, name);
      const stats = statSync(path);
      if (stats.isDirectory()) walk(path);
      else if (stats.isFile()) entries.push(`${relative(root, path)}|${stats.size}|${Math.trunc(stats.mtimeMs)}`);
    }
  };
  walk(root);
  return { exists: true, entries: entries.sort() };
}

export function snapshotState() {
  return snapshotTree(join(homedir(), '.local', 'state', 'sdo'));
}

export function createHashHex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 真实落地一条 intent（decision(kind='intent') 先签 + intent.signed），供 spec.intent_id 外键。 */
export async function seedIntent(db, client, { id = 'INT-M3G', actor = TEST_ACTOR, intentId = 'INT-M3G' } = {}) {
  return seedIntentAsync(db, client, { id, actor, intentId });
}

async function seedIntentAsync(db, client, { id, actor, intentId }) {
  const decisionId = await signRealDecision(db, client, {
    kind: 'intent',
    subject: intentId,
    value: 'M3-G 读数用意图',
    extra: { intent_id: intentId },
    actor,
  });
  appendEvents(db, [
    buildEvent(
      {
        id: `ev-m3g-${id}`,
        at: AT,
        actor,
        kind: 'intent.signed',
        subject: intentId,
        payload: {
          decision_id: decisionId,
          statement: 'M3-G 读数用意图',
          source_text: 'M3-G 读数用意图原文',
          owner: 'lead',
          strength: 'explicit',
          baseline_hash: 'sha256:m3g-baseline',
          content_hash: payloadHash({ statement: 'M3-G 读数用意图' }),
        },
        caused_by: [decisionId],
        request_id: `m3g-${id}`,
      },
      chainHead(db),
    ),
  ]);
  return intentId;
}

export async function withSignRig(run) {
  const rig = await bootSignerd({ now: () => new Date(AT) });
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m3g-sign-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    grantFixtureRoster(db);
    db.prepare("INSERT OR IGNORE INTO actor (id, kind, display, at) VALUES ('bob', 'human', 'bob', ?)").run(AT);
    const unlocked = await unlockSigner(db, rig.client, {
      actor: TEST_ACTOR,
      actor_kind: 'human',
      passphrase: TEST_PASSPHRASE,
      frontier: chainHead(db),
      now: new Date(AT),
    });
    if (!unlocked.ok) throw new Error(`m3g unlock failed: ${unlocked.reason_code}: ${unlocked.message}`);
    return await run({ db, client: rig.client, dir });
  } finally {
    db.close();
    await rig.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 走真 signDecision（网关验签路径），返回 decision_id。 */
export async function signRealDecision(db, client, { kind, subject, value, extra = {}, actor = TEST_ACTOR }) {
  const opened = await unlockSigner(db, client, {
    actor,
    actor_kind: 'human',
    passphrase: TEST_PASSPHRASE,
    frontier: chainHead(db),
    now: new Date(AT),
  });
  if (!opened.ok) throw new Error(`m3g unlock(${actor}) failed: ${opened.reason_code}: ${opened.message}`);
  const result = await signDecision(db, client, {
    decision_kind: kind,
    subject,
    value,
    evidence: ['M3-G 读数夹具证据'],
    difference: '无差异',
    consequence: '仅用于 M3-G 读数落地',
    extra,
    actor,
    actor_kind: 'human',
    producer: TEST_PRODUCER,
    channel: 'ui',
    frontier: chainHead(db),
    now: new Date(AT),
  });
  if (!result.ok) throw new Error(`m3g signDecision failed: ${result.reason_code}: ${result.message}`);
  return result.decision_id;
}
