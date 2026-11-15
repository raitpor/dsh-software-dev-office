/**
 * M3-5 C1–C5：撤权后待审项消失、申请入口、历史不受影响、escalate 域限、无孤儿行。
 *
 * 权限一律用**假 rights 端口**驱动（M3-1 权限过滤未交付；卡 A1/A2 的顺序）。
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { canonicalJson, sha256Hex } from '../../../src/core/fold/canonical.js';
import { verify } from '../../../src/core/verify.js';
import {
  escalate,
  filterPmQueueRows,
  historySnapshot,
  raiseAttention,
  readReviewQueueAccess,
  withdrawAttention,
} from '../../../src/core/pm/index.js';
import type {
  AccessRight,
  PmContext,
  PmQueueRow,
  RightsPort,
} from '../../../src/core/pm/index.js';
import { query } from '../../../src/query/index.js';
import { appendSeeds, ev, eventCount, pmSession, seedBase, withPmDb } from './helpers.js';

function rights(actor: string, grants: Readonly<Record<string, readonly AccessRight[]>>): RightsPort {
  return {
    actor,
    has(right: AccessRight, scope: string): boolean {
      return (grants[scope] ?? []).includes(right) || (grants['*'] ?? []).includes(right);
    },
  };
}

const IMPL: PmContext = { actor: 'impl-core', actorKind: 'human' };
const REVIEWER: PmContext = { actor: 'reviewer', actorKind: 'human' };

function seedTasks(db: Parameters<typeof seedBase>[0]): void {
  seedBase(db);
  appendSeeds(db, [
    ev('task.created', 'T1', {
      seq: 1,
      title: '实现 X（release R-1）',
      kind: 'implement',
      status: 'in_progress',
      created_by: 'impl-core',
      scope_paths: ['src/x/**'],
      inputs: ['release:R-1'],
    }),
    ev('task.created', 'T2', {
      seq: 2,
      title: '实现 Y（release R-2）',
      kind: 'implement',
      status: 'in_progress',
      created_by: 'impl-core',
      scope_paths: ['src/y/**'],
      inputs: ['release:R-2'],
    }),
  ]);
}

function raiseFor(db: Parameters<typeof seedBase>[0], taskId: string, askedBy: PmContext): string {
  const result = raiseAttention(db, askedBy, {
    taskId,
    question: `请确认 ${taskId}`,
    askedOf: 'lead',
    expiresAt: '2026-12-01T00:00:00Z',
    at: '2026-11-15T00:00:00Z',
  });
  assert.equal(result.ok, true);
  return result.ok ? result.attention_id : '';
}

function pmRow(owner: string | null, subject: string): PmQueueRow {
  return {
    rank: 1,
    kind: 'task',
    subject_id: subject,
    title: subject,
    action: 'claim',
    reason_code: 'unclaimed',
    since: '2026-11-15T00:00:00Z',
    owner,
    block_code: null,
    blocked_by: [],
  };
}

test('C1 撤权后：review_queue 中不属于我可决定的域的行不再出现（行还在，只是不可见）', () => {
  withPmDb((db) => {
    seedTasks(db);
    raiseFor(db, 'T1', IMPL);
    raiseFor(db, 'T2', IMPL);

    const before = query(db, { view: 'review_queue' }, { session: pmSession('lead') });
    assert.equal(before.miss, undefined);
    assert.equal(before.rows.length, 2);
    const beforeEvents = eventCount(db);

    // impl-core 有 decide@release:R-2，没有 decide@release:R-1。
    const access = readReviewQueueAccess(db, rights('impl-core', {
      'release:R-2': ['read', 'decide'],
    }), pmSession('impl-core'));
    assert.equal(access.rows.length, 1);
    assert.equal(access.hidden.length, 1);
    assert.equal(access.hidden[0]?.scopes.includes('release:R-1'), true);

    // 不删行：原始视图仍两行，事件数不变。
    const after = query(db, { view: 'review_queue' }, { session: pmSession('lead') });
    assert.equal(after.rows.length, 2);
    assert.equal(eventCount(db), beforeEvents);
  });
});

test('C1b 只有 decide、没有 read 的端口看不到 proposition（P2-2 显式双查）', () => {
  withPmDb((db) => {
    seedTasks(db);
    raiseFor(db, 'T1', IMPL);
    const decideOnly = rights('impl-core', { 'release:R-1': ['decide'] });
    const access = readReviewQueueAccess(db, decideOnly, pmSession('impl-core'));
    assert.equal(access.rows.length, 0);
    assert.equal(access.hidden.length, 1);
    assert.equal(access.filtered, true);
    assert.deepEqual(access.apply_entries.map((entry) => entry.scope), ['release:R-1']);
  });
});

test('C1 pm_queue：own 行在失去 read@domain:pm 后不再出现，全局行仍在', () => {
  const rows = [pmRow('impl-core', 'T1'), pmRow(null, 'T2')];
  const noread = rights('impl-core', { 'release:R-2': ['decide'] });
  const access = filterPmQueueRows(rows, noread);
  assert.deepEqual(access.rows.map((row) => row.subject_id), ['T2']);
  assert.deepEqual(access.hidden.map((row) => row.subject_id), ['T1']);
  assert.deepEqual(access.apply_entries.map((entry) => entry.scope), ['domain:pm']);

  const withRead = rights('impl-core', { 'domain:pm': ['read'] });
  assert.equal(filterPmQueueRows(rows, withRead).hidden.length, 0);
});

test('C2 撤权后露出申请入口（escalate@目标域），入口本身不判权', () => {
  withPmDb((db) => {
    seedTasks(db);
    raiseFor(db, 'T1', IMPL);
    const access = readReviewQueueAccess(db, rights('impl-core', {
      'release:R-2': ['read', 'decide'],
    }), pmSession('impl-core'));
    assert.deepEqual(access.apply_entries.map((entry) => entry.action), ['escalate']);
    assert.deepEqual(access.apply_entries.map((entry) => entry.scope), ['release:R-1']);
    assert.equal(access.apply_entries[0]?.reason_code, 'no_permission');
  });
});

test('C3 历史不受影响：撤权前后历史快照逐字段相等，已签 decision 仍有效', () => {
  withPmDb((db) => {
    seedTasks(db);
    const guaranteeDelta = { 1: 'kept', 2: 'kept', 3: 'kept' };
    const decisionId = 'd-baseline-revoke-1';
    const decisionPayload = {
      decision_kind: 'baseline',
      subject: 'B-1',
      value: 'frozen',
      proposition: '把尺子冻结为 M1 基线',
      evidence: ['test/fixtures/baseline/waterfall.json'],
      difference: '新增基线',
      consequence: '后续判定按此基线',
      baseline: {
        hash: 'b-hash-revoke-1',
        prev: null,
        direction: null,
        will_change_hash: null,
        guarantee_delta: guaranteeDelta,
      },
    };
    const payloadHash = `sha256:${sha256Hex(canonicalJson(decisionPayload))}`;
    appendSeeds(db, [
      ev('decision.valid', decisionId, {
        decision_kind: 'baseline',
        payload_hash: payloadHash,
        frontier: 'f-1',
        payload: decisionPayload,
      }),
      ev('decision.signed', decisionId, {
        payload_hash: payloadHash,
        signature: 'sig-fixture',
        key_id: 'key-fixture',
        signer: 'lead',
      }),
    ]);
    const before = historySnapshot(db);
    const beforeEvents = eventCount(db);
    const beforeVerify = verify(db).ok;

    // “撤权”在这里是权限事实：假 rights 从全权变为无权；不写任何事件。
    const revoked = rights('impl-core', {});
    assert.equal(revoked.has('read', 'release:R-1'), false);
    const after = historySnapshot(db);

    assert.deepEqual(after, before);
    assert.equal(eventCount(db), beforeEvents);
    assert.equal(verify(db).ok, beforeVerify);
    assert.equal(query(db, { view: 'review_queue' }, { session: pmSession('lead') }).rows.length, 0);
    const decisionRow = db.prepare('SELECT id, status FROM decision WHERE id = ?').get(decisionId) as
      | { id: string; status: string }
      | undefined;
    assert.equal(decisionRow?.id, decisionId);
    assert.equal(decisionRow?.status, 'valid');
  });
});

test('C4 escalate：越域/无 read/任务不在域 ⇒ 拒绝；同域有 read+escalate ⇒ 成功', () => {
  withPmDb((db) => {
    seedTasks(db);

    const okRights = rights('impl-core', {
      'release:R-1': ['read', 'escalate'],
    });
    const ok = escalate(db, { ...IMPL, rights: okRights }, {
      taskId: 'T1',
      scope: 'release:R-1',
      question: '这个域要人拍板',
      askedOf: 'lead',
      expiresAt: '2026-12-01T00:00:00Z',
      at: '2026-11-15T00:10:00Z',
    });
    assert.equal(ok.ok, true);

    const crossDomain = escalate(db, {
      ...IMPL,
      rights: rights('impl-core', { 'release:R-1': ['escalate'], 'domain:pm': ['read'] }),
    }, {
      taskId: 'T1',
      scope: 'release:R-1',
      question: '越域升级',
      askedOf: 'lead',
      expiresAt: '2026-12-01T00:00:00Z',
    });
    assert.equal(crossDomain.ok, false);
    assert.equal(crossDomain.ok ? undefined : crossDomain.reason_code, 'no_permission');

    const noRead = escalate(db, {
      ...IMPL,
      rights: rights('impl-core', { 'release:R-1': ['escalate'] }),
    }, {
      taskId: 'T1',
      scope: 'release:R-1',
      question: '没有 read 就升级',
      askedOf: 'lead',
      expiresAt: '2026-12-01T00:00:00Z',
    });
    assert.equal(noRead.ok ? undefined : noRead.reason_code, 'no_permission');

    const wrongScope = escalate(db, {
      ...IMPL,
      rights: rights('impl-core', { 'release:R-1': ['read', 'escalate'], 'release:R-2': ['read'] }),
    }, {
      taskId: 'T2',
      scope: 'release:R-1',
      question: 'T2 不在 R-1',
      askedOf: 'lead',
      expiresAt: '2026-12-01T00:00:00Z',
    });
    assert.equal(wrongScope.ok ? undefined : wrongScope.reason_code, 'scope_mismatch');
  });
});

test('C4 withdrawAttention：只能撤自己提的，且要有 escalate@域', () => {
  withPmDb((db) => {
    seedTasks(db);
    const attentionId = raiseFor(db, 'T1', IMPL);

    const other = withdrawAttention(db, {
      ...REVIEWER,
      rights: rights('reviewer', { 'release:R-1': ['read', 'escalate'] }),
    }, { attentionId, scope: 'release:R-1' });
    assert.equal(other.ok ? undefined : other.reason_code, 'no_permission');

    const noEscalate = withdrawAttention(db, {
      ...IMPL,
      rights: rights('impl-core', { 'release:R-1': ['read'] }),
    }, { attentionId, scope: 'release:R-1' });
    assert.equal(noEscalate.ok ? undefined : noEscalate.reason_code, 'no_permission');

    // P2-3：不能用 R-2 的 escalate 权撤掉属于 R-1 的提问。
    const wrongDomain = withdrawAttention(db, {
      ...IMPL,
      rights: rights('impl-core', { 'release:R-2': ['read', 'escalate'] }),
    }, { attentionId, scope: 'release:R-2' });
    assert.equal(wrongDomain.ok ? undefined : wrongDomain.reason_code, 'scope_mismatch');

    const own = withdrawAttention(db, {
      ...IMPL,
      rights: rights('impl-core', { 'release:R-1': ['read', 'escalate'] }),
    }, { attentionId, scope: 'release:R-1', at: '2026-11-15T00:20:00Z' });
    assert.equal(own.ok, true);
  });
});

test('C5 无孤儿行：可见+隐藏=原始 review_queue 行数，hidden 的 item_id 都在 attention 表', () => {
  withPmDb((db) => {
    seedTasks(db);
    raiseFor(db, 'T1', IMPL);
    raiseFor(db, 'T2', IMPL);
    const raw = query(db, { view: 'review_queue' }, { session: pmSession('lead') });
    const access = readReviewQueueAccess(db, rights('impl-core', { 'release:R-2': ['read', 'decide'] }), pmSession('impl-core'));
    assert.equal(access.rows.length + access.hidden.length, raw.rows.length);
    for (const hidden of access.hidden) {
      const row = db.prepare('SELECT id FROM attention WHERE id = ?').get(hidden.item_id) as
        | { id: string }
        | undefined;
      assert.equal(row?.id, hidden.item_id);
    }
  });
});

test('M3-5 收口：`src/` 里不存在静态席位放行回退（seatRightsPort）', () => {
  const root = fileURLToPath(new URL('../../../../src', import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (readFileSync(path, 'utf8').includes('seatRightsPort')) offenders.push(path);
    }
  };
  walk(root);
  assert.deepEqual(offenders, [], '权限回退只能由测试注入；生产代码必须 deny-all 或真库 grant');
});

test('M3-5 收口：act.ts 缺省 rights 是 deny-all（缺权限不放行）', () => {
  withPmDb((db) => {
    seedTasks(db);
    const denied = escalate(db, { actor: 'impl-core', actorKind: 'human' }, {
      taskId: 'T1',
      scope: 'release:R-1',
      question: 'R-1 要人拍板',
      askedOf: 'lead',
      expiresAt: '2026-12-01T00:00:00Z',
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reason_code, 'no_permission');
  });
});
