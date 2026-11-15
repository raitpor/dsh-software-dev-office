/**
 * M3-6 端到端（Lead m06490 P2-2 复审）：控制台以 agent 身份装载页面，页面里必须真的
 * 渲染一个含 `human_only` 列的视图——`team`（总览页新增的“团队（签章状态）”表）。
 * 断言该列在页面模型/HTML 里不出现（列不是置 null，是不出现），human 对照可见；
 * 并用 query 元数据核对 `redacted_columns` 原样传到渲染输入。
 *
 * 用产品路径 `dbRightsPort(db, actor)`（真库 grant）构造 ConsoleAccess，不是假端口。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Session } from '../../src/core/auth/session.js';
import { dbRightsPort } from '../../src/core/pm/access.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { loadOverviewPage } from '../../src/ui/pages.js';
import { renderPage } from '../../src/ui/render.js';
import { PASSPHRASE } from '../db/helpers.js';

const AT = '2026-11-15T00:00:00.000Z';

type Db = ReturnType<typeof openSdoDatabase>;

function withMigratedDb(run: (db: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m3-6-ui-agent-'));
  const db = openSdoDatabase(join(dir, 'state', 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    seed(db);
    run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function seed(db: Db): void {
  db.prepare(
    `INSERT INTO task (id, seq, title, kind, created_by, owner, status, scope_paths, at)
     VALUES ('T1', 1, '实现登录', 'implement', 'human-pm', 'agent-dev', 'in_progress', '["release:R-1"]', ?)`,
  ).run(AT);
  db.prepare(
    `INSERT INTO decision (id, decision_kind, status, payload, payload_hash, signature, key_id, signer, frontier, at)
     VALUES ('DEC-1', 'baseline', 'valid', '{}', 'sha256:dec1', 'sig', 'key-1', 'human-pm', '[]', ?)`,
  ).run(AT);
  for (const [actor, kind] of [
    ['bot', 'agent'],
    ['alice', 'human'],
  ] as const) {
    db.prepare('INSERT INTO actor (id, kind, display, at) VALUES (?, ?, NULL, ?)').run(actor, kind, AT);
    db.prepare(
      "INSERT INTO scope (actor, scope, right, granted_by, at, revoked_at) VALUES (?, 'domain:core', 'read', 'migration', ?, NULL)",
    ).run(actor, AT);
  }
}

function session(actor: string, kind: Session['actor_kind']): Session {
  return { actor, actor_kind: kind, session_id: `sess-${actor}`, credential: 'test' };
}

test('M3-6 端到端：agent 经总览页取 team（含 human_only 列）⇒ 列不出现、human 对照可见', () => {
  withMigratedDb((db) => {
    const agent = session('bot', 'agent');
    const access = { actor: 'bot', rights: dbRightsPort(db, 'bot'), session: agent };
    const page = loadOverviewPage(db, 'decider', access);

    const teamTable = page.tables.find((table) => table.source.view === 'team');
    assert.ok(teamTable !== undefined, '总览页应渲染 team 表（真链路）');
    assert.deepEqual(teamTable.redacted_columns, ['rights'], 'query 的 redacted_columns 原样进页面模型');
    assert.equal(teamTable.columns.some((column) => column.name === 'rights'), false);
    for (const row of teamTable.rows) assert.equal(Object.hasOwn(row, 'rights'), false);

    const html = renderPage(page);
    assert.doesNotMatch(html, /<th scope="col">已签决策类型<\/th>/);
    assert.match(html, /data-redacted-count="1"/);
    assert.doesNotMatch(html, /data-page="overview"[\s\S]*team[\s\S]*<td>[^<]*(sign|baseline)/);

    // 同一个页面加载路径，human 对照：列存在、值也在。
    const human = loadOverviewPage(db, 'decider', {
      actor: 'alice',
      rights: dbRightsPort(db, 'alice'),
      session: session('alice', 'human'),
    });
    const humanTeam = human.tables.find((table) => table.source.view === 'team');
    assert.ok(humanTeam !== undefined);
    assert.equal(humanTeam.redacted_columns, undefined);
    assert.ok(humanTeam.columns.some((column) => column.name === 'rights'));
    assert.ok(humanTeam.rows.every((row) => Object.hasOwn(row, 'rights')));
  });
});
