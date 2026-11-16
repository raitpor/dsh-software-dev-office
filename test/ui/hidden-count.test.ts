/**
 * M3-7 C1–C3：撤权后的 hint 不得泄露隐藏计数（S25：连“有 N 条被隐藏”都不出）。
 *
 * 三种守卫：
 * - 有 hidden / 无 hidden 两种“被过滤”情形，hint 都不含 `\d+ 条`，且仍给申请入口；
 * - 有权限 + 空队列：照实出 `to_decide = 0`，无 hint、无申请区；
 * - 有权限 + 有队列：正常出数字（防止“为了不泄露而把数字也删了”）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadOverviewPage, REVIEW_QUEUE_HINTS } from '../../src/ui/pages.js';
import { renderPage } from '../../src/ui/render.js';
import type { AccessRight, RightsPort } from '../../src/core/pm/index.js';
import { denyAllRightsPort, raiseAttention } from '../../src/core/pm/index.js';
import { appendSeeds, ev, pmSession, seedBase, withPmDb } from '../core/pm/helpers.js';

/**
 * S25 口径：两种“被过滤”情形各只有一条合法文案（从产品模块导入，单一源）。
 * 兜底只抓“数量 + 量词”，不会误伤 `release:R-1`、`8KB` 这类非计数内容。
 */
const HIDDEN_HINT = REVIEW_QUEUE_HINTS.hidden;
const NO_READ_HINT = REVIEW_QUEUE_HINTS.noRead;
const QUANTITY_LEAK = /(?:[0-9０-９]+|[一二两三四五六七八九十]+)\s*(?:条|项|个)/;

function rights(actor: string, grants: Readonly<Record<string, readonly AccessRight[]>>): RightsPort {
  return {
    actor,
    has(right: AccessRight, scope: string): boolean {
      return (grants[scope] ?? []).includes(right) || (grants['*'] ?? []).includes(right);
    },
  };
}

test('M3-7 C1 兜底只抓数量+量词：`release:R-1`/`8KB` 不误红（防误伤合法内容）', () => {
  for (const sample of [
    '部分待审项不在你的域内：见下方申请入口（scope release:R-1 见申请入口）',
    '当前身份没有待审队列的读取权：见下方申请入口（上限 8KB）',
  ]) {
    assert.doesNotMatch(sample, QUANTITY_LEAK);
  }
  // 负向锚：真正的数量词要被抓住（两种写法都由上一版评审构造）。
  assert.match('部分待审项不在你的域内（共 1 项）', QUANTITY_LEAK);
  assert.match('部分待审项不在你的域内（共一条）', QUANTITY_LEAK);
});

test('M3-7 C1/C2：撤权且有 hidden ⇒ hint 无计数、仍给申请入口、不出 to_decide', () => {
  withPmDb((db) => {
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

    const noDecide = rights('impl-core', { 'domain:pm': ['read'], 'release:R-2': ['read', 'decide'] });
    const page = loadOverviewPage(db, 'decider', {
      actor: 'impl-core',
      rights: noDecide,
      session: pmSession('impl-core'),
    });
    const hint = page.misses.find(
      (miss) => miss.view === 'review_queue' && miss.reason === 'filtered_by_permission',
    )?.hint;
    assert.ok(hint !== undefined);
    // 最强形式：hint 只能是两常量之一；宽松兜底防未来加分支时夹带数字/数量词。
    assert.equal(hint, HIDDEN_HINT);
    assert.doesNotMatch(hint, QUANTITY_LEAK, `hint 不得含数量词：${hint}`);
    assert.equal(page.figures.some((figure) => figure.id === 'to_decide'), false);
    assert.deepEqual(page.apply_entries.map((entry) => entry.scope), ['release:R-1']);

    // P3：以 page.misses 的精确文本为准；HTML 只作辅助（标签会把数字隔开）。
    const reviewMisses = page.misses.filter(
      (miss) => miss.view === 'review_queue' && miss.reason === 'filtered_by_permission',
    );
    assert.deepEqual(reviewMisses.map((miss) => miss.hint), [HIDDEN_HINT]);
    for (const miss of page.misses) {
      assert.doesNotMatch(miss.hint ?? '', QUANTITY_LEAK, `任何 miss hint 都不得带数量：${miss.hint}`);
    }
    const html = renderPage(page);
    assert.match(html, /<section class="apply">/);
    assert.doesNotMatch(html, /data-figure="to_decide"/);
  });
});

test('M3-7 C1/C2：deny-all + 空队列（无 hidden）⇒ 通用 hint 无计数、仍给申请入口', () => {
  withPmDb((db) => {
    seedBase(db);
    const page = loadOverviewPage(db, 'decider', {
      actor: 'ghost',
      rights: denyAllRightsPort('ghost'),
      session: pmSession('ghost'),
    });
    const reviewMisses = page.misses.filter(
      (miss) => miss.view === 'review_queue' && miss.reason === 'filtered_by_permission',
    );
    assert.deepEqual(reviewMisses.map((miss) => miss.hint), [NO_READ_HINT]);
    assert.doesNotMatch(NO_READ_HINT, QUANTITY_LEAK);
    for (const miss of page.misses) {
      assert.doesNotMatch(miss.hint ?? '', QUANTITY_LEAK, `任何 miss hint 都不得带数量：${miss.hint}`);
    }
    assert.equal(page.figures.some((figure) => figure.id === 'to_decide'), false);
    assert.deepEqual(page.apply_entries.map((entry) => entry.scope), ['domain:pm']);
    const html = renderPage(page);
    assert.match(html, /data-apply-entry="domain:pm"/);
  });
});

test('M3-7 C3：有权限 + 空队列 ⇒ to_decide=0、无 hint、无申请区', () => {
  withPmDb((db) => {
    seedBase(db);
    const decider = rights('impl-core', { 'domain:pm': ['read', 'decide'] });
    const page = loadOverviewPage(db, 'decider', {
      actor: 'impl-core',
      rights: decider,
      session: pmSession('impl-core'),
    });
    const toDecide = page.figures.find((figure) => figure.id === 'to_decide');
    assert.ok(toDecide !== undefined);
    assert.equal(toDecide.value, 0);
    assert.equal(page.misses.some((miss) => miss.reason === 'filtered_by_permission'), false);
    assert.deepEqual(page.apply_entries, []);
    const html = renderPage(page);
    assert.doesNotMatch(html, /<section class="apply">/);
    for (const miss of page.misses) {
      assert.doesNotMatch(miss.hint ?? '', QUANTITY_LEAK, `无权限过滤时不应有 hint：${miss.hint}`);
    }
  });
});

test('M3-7 C3：有权限 + 有队列 ⇒ 照实出数字（不因防泄露而删数字）', () => {
  withPmDb((db) => {
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

    const decider = rights('impl-core', { 'domain:pm': ['read', 'decide'], 'release:R-1': ['read', 'decide'] });
    const page = loadOverviewPage(db, 'decider', {
      actor: 'impl-core',
      rights: decider,
      session: pmSession('impl-core'),
    });
    const toDecide = page.figures.find((figure) => figure.id === 'to_decide');
    assert.ok(toDecide !== undefined);
    assert.equal(toDecide.value, 1);
    assert.equal(page.misses.some((miss) => miss.reason === 'filtered_by_permission'), false);
    assert.deepEqual(page.apply_entries, []);
  });
});
