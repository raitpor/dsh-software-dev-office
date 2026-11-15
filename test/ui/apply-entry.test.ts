/**
 * M3-5 C2（UI 半）：撤权后页面露出申请入口、待审项数字消失；数字仍可 query 复算。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadOverviewPage } from '../../src/ui/pages.js';
import { renderPage } from '../../src/ui/render.js';
import { query } from '../../src/query/index.js';
import type { AccessRight, RightsPort } from '../../src/core/pm/index.js';
import { denyAllRightsPort, raiseAttention } from '../../src/core/pm/index.js';
import { appendSeeds, ev, pmSession, seedBase, withPmDb } from '../core/pm/helpers.js';
import { rightsPortFrom } from '../db/append-auth.js';

function rights(actor: string, grants: Readonly<Record<string, readonly AccessRight[]>>): RightsPort {
  return {
    actor,
    has(right: AccessRight, scope: string): boolean {
      return (grants[scope] ?? []).includes(right) || (grants['*'] ?? []).includes(right);
    },
  };
}

function seed(db: Parameters<typeof seedBase>[0]): void {
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
  ]);
  const raised = raiseAttention(db, { actor: 'impl-core', actorKind: 'human' }, {
    taskId: 'T1',
    question: 'R-1 要人拍板',
    askedOf: 'lead',
    expiresAt: '2026-12-01T00:00:00Z',
    at: '2026-11-15T00:00:00Z',
  });
  assert.equal(raised.ok, true);
}

test('C2 撤权后页面：显示申请入口、不出“要我决定”数字', () => {
  withPmDb((db) => {
    seed(db);
    const noDecide = rights('impl-core', { 'domain:pm': ['read'], 'release:R-2': ['read', 'decide'] });
    const page = loadOverviewPage(db, 'decider', { actor: 'impl-core', rights: noDecide, session: pmSession('impl-core') });

    const figureIds = page.figures.map((figure) => figure.id);
    assert.equal(figureIds.includes('to_decide'), false);
    assert.deepEqual(page.apply_entries.map((entry) => entry.scope), ['release:R-1']);
    assert.ok(page.misses.some((miss) => miss.reason === 'filtered_by_permission'));

    const html = renderPage(page);
    assert.match(html, /data-apply-entry="release:R-1"/);
    assert.match(html, /<code>escalate<\/code>/);
    assert.doesNotMatch(html, /data-figure="to_decide"/);
  });
});

test('C2 有决定权的域：待审项数字与 review_queue 行数一致（可复算），无申请入口', () => {
  withPmDb((db) => {
    seed(db);
    const decider = rights('impl-core', { 'domain:pm': ['read'], 'release:R-1': ['read', 'decide'] });
    const page = loadOverviewPage(db, 'decider', { actor: 'impl-core', rights: decider, session: pmSession('impl-core') });
    const figure = page.figures.find((item) => item.id === 'to_decide');
    assert.ok(figure !== undefined);
    const recomputed = query(db, { view: figure.source.view }, { session: pmSession('lead') });
    assert.equal(recomputed.miss, undefined);
    assert.equal(figure.value, recomputed.rows.length);
    assert.equal(page.apply_entries.length, 0);
  });
});

test('C2 reader（无 review_queue 权限）：不出数字，页面仍可渲染，不出假入口', () => {
  withPmDb((db) => {
    seed(db);
    const reader = {
      actor: 'ui-reader',
      rights: rightsPortFrom('ui-reader', []),
      session: pmSession('ui-reader'),
    };
    const page = loadOverviewPage(db, 'reader', reader);
    assert.equal(page.figures.some((figure) => figure.id === 'to_decide'), false);
    assert.ok(page.misses.some((miss) => miss.view === 'review_queue'));
    const html = renderPage(page);
    assert.doesNotMatch(html, /data-figure="to_decide"/);
  });
});

test('C2 空队列 + deny-all：不出 to_decide=0，仍给申请入口与 miss（P2-1）', () => {
  withPmDb((db) => {
    // 不 seed attention：review_queue 为空；deny-all 身份没有任何 read/decide。
    db.prepare("INSERT INTO task (id, seq, title, kind, status, created_by, at) VALUES ('T0', 0, '空', 'implement', 'in_progress', 'impl-core', '2026-11-15T00:00:00Z')").run();
    const page = loadOverviewPage(db, 'decider', { actor: 'ghost', rights: denyAllRightsPort('ghost'), session: pmSession('ghost') });

    assert.equal(page.figures.some((figure) => figure.id === 'to_decide'), false);
    assert.ok(page.misses.some((miss) => miss.view === 'review_queue' && miss.reason === 'filtered_by_permission'));
    assert.deepEqual(page.apply_entries.map((entry) => entry.scope), ['domain:pm']);

    const html = renderPage(page);
    assert.doesNotMatch(html, /data-figure="to_decide"/);
    assert.match(html, /data-apply-entry="domain:pm"/);
  });
});

test('C2 有权限 + 空队列：仍出 to_decide=0（锁住“有来源才出数字”的正向边界）', () => {
  withPmDb((db) => {
    // review_queue 为空（不 seed attention），身份有 read+decide。
    db.prepare("INSERT INTO task (id, seq, title, kind, status, created_by, at) VALUES ('T0', 0, '空', 'implement', 'in_progress', 'impl-core', '2026-11-15T00:00:00Z')").run();
    const decider = rights('impl-core', { 'domain:pm': ['read', 'decide'] });
    const page = loadOverviewPage(db, 'decider', { actor: 'impl-core', rights: decider, session: pmSession('impl-core') });

    const toDecide = page.figures.find((figure) => figure.id === 'to_decide');
    assert.ok(toDecide !== undefined, '有权限时空队列仍应有可复算的 0');
    assert.equal(toDecide.value, 0);
    assert.deepEqual(page.apply_entries, []);
  });
});
