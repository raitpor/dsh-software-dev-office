import { seedViewerRights } from '../db/append-auth.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Session } from '../../src/core/auth/session.js';
import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { query } from '../../src/query/index.js';
import { PASSPHRASE } from '../db/helpers.js';

const AT = '2026-11-15T00:00:00.000Z';

type Db = ReturnType<typeof openSdoDatabase>;

function withMigratedDb(run: (db: Db) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m3-6-trim-'));
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

/** team 视图的行来自事件/投影表：一张卡 + 一条已签 decision。 */
function seed(db: Db): void {
  db.prepare(
    `INSERT INTO task (id, seq, title, kind, created_by, owner, status, scope_paths, at)
     VALUES ('T1', 1, '实现登录', 'implement', 'human-pm', 'agent-dev', 'in_progress', '["release:R-1"]', ?)`,
  ).run(AT);
  db.prepare(
    `INSERT INTO decision (id, decision_kind, status, payload, payload_hash, signature, key_id, signer, frontier, at)
     VALUES ('DEC-1', 'baseline', 'valid', '{}', 'sha256:dec1', 'sig', 'key-1', 'human-pm', '[]', ?)`,
  ).run(AT);
}

function session(actor: string, kind: Session['actor_kind']): Session {
  return { actor, actor_kind: kind, session_id: `sess-${actor}`, credential: 'test' };
}

interface GrantRow {
  readonly actor: string;
  readonly kind: Session['actor_kind'];
  readonly right: string;
}

/** 权限来自 scope 表（M3-1 的 viewRightFor）：read ⇒ reader 级。 */
function seedGrants(db: Db, rows: readonly GrantRow[]): void {
  seedViewerRights(db, rows.map((row) => ({ actor: row.actor, scope: 'domain:core', right: row.right })));
}

test('M3-6 C2: agent 结果不含 human_only 列，human/service 照旧', () => {
  withMigratedDb((db) => {
    seedGrants(db, [
      { actor: 'bot', kind: 'agent', right: 'read' },
      { actor: 'alice', kind: 'human', right: 'read' },
      { actor: 'svc', kind: 'service', right: 'read' },
    ]);

    const agent = query(db, { view: 'team' }, { session: session('bot', 'agent') });
    assert.equal(agent.miss, undefined);
    assert.ok(agent.rows.length > 0, 'team 视图应有行');
    for (const row of agent.rows) {
      assert.equal(Object.hasOwn(row, 'rights'), false, 'agent 结果里 rights 列必须不出现（不是 null）');
    }
    assert.deepEqual(agent.redacted_columns, ['rights'], '被裁的列要显式报出来');

    const human = query(db, { view: 'team' }, { session: session('alice', 'human') });
    assert.equal(human.miss, undefined);
    assert.ok(human.rows.length > 0);
    for (const row of human.rows) assert.equal(Object.hasOwn(row, 'rights'), true);
    assert.equal(human.redacted_columns, undefined, 'human 不裁剪');

    const service = query(db, { view: 'team' }, { session: session('svc', 'service') });
    assert.equal(service.miss, undefined);
    for (const row of service.rows) assert.equal(Object.hasOwn(row, 'rights'), true);
    assert.equal(service.redacted_columns, undefined, 'service 不裁剪');
  });
});

test('M3-6 C2: 目录元数据与实际可查列一致（agent 的 list 不列被裁列）', () => {
  withMigratedDb((db) => {
    seedGrants(db, [
      { actor: 'bot', kind: 'agent', right: 'read' },
      { actor: 'alice', kind: 'human', right: 'read' },
    ]);

    const collectTeam = (sessionLike: Session): Record<string, unknown> | undefined => {
      // 目录 14 行 + columns 元数据超 8KB ⇒ 服务端按预算分页；翻页找到 team 行。
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = query(db, { view: 'list', ...(cursor === undefined ? {} : { cursor }) }, { session: sessionLike });
        assert.equal(result.miss, undefined);
        const found = result.rows.find((row) => row['name'] === 'team');
        if (found !== undefined) return found;
        if (!result.truncated || result.next_cursor === undefined) return undefined;
        cursor = result.next_cursor;
      }
      return undefined;
    };
    const agentTeam = collectTeam(session('bot', 'agent'));
    assert.ok(agentTeam !== undefined);
    const agentColumns = (agentTeam['columns'] as Array<Record<string, unknown>>).map((column) => column['name']);
    assert.equal(agentColumns.includes('rights'), false, 'agent 的 columns 元数据不能列 rights（否则与实际返回不一致）');
    assert.deepEqual(agentTeam['redacted_columns'], ['rights'], 'redacted_columns 是 LIST_COLUMNS 的声明列');

    const humanTeam = collectTeam(session('alice', 'human'));
    assert.ok(humanTeam !== undefined);
    const humanColumns = (humanTeam['columns'] as Array<Record<string, unknown>>).map((column) => column['name']);
    assert.equal(humanColumns.includes('rights'), true);
    assert.equal(humanTeam['redacted_columns'], undefined);
  });
});

test('M3-6 C4: 显式 select 被裁列 ⇒ 结构化 column_redacted（非静默少列）', () => {
  withMigratedDb((db) => {
    seedGrants(db, [
      { actor: 'bot', kind: 'agent', right: 'read' },
      { actor: 'alice', kind: 'human', right: 'read' },
    ]);

    const denied = query(db, { view: 'team', select: ['actor_id', 'rights'] }, { session: session('bot', 'agent') });
    assert.equal(denied.rows.length, 0);
    assert.equal(denied.miss?.reason, 'column_redacted');
    assert.match(denied.miss?.hint ?? '', /rights/);

    const allowed = query(db, { view: 'team', select: ['actor_id', 'kind'] }, { session: session('bot', 'agent') });
    assert.equal(allowed.miss, undefined);
    assert.ok(allowed.rows.length > 0);
    assert.deepEqual(allowed.redacted_columns, ['rights'], '即使只查可见列，也要报出被裁的列');

    const human = query(db, { view: 'team', select: ['rights'] }, { session: session('alice', 'human') });
    assert.equal(human.miss, undefined);
    assert.ok(human.rows.length > 0);
  });
});

test('M3-6 C3: 行级 filtered_by_permission 与列级裁剪分开记账', () => {
  withMigratedDb((db) => {
    seedGrants(db, [{ actor: 'bot', kind: 'agent', right: 'read' }]);
    const bot = session('bot', 'agent');

    // 行级：review_queue 需要 decider，agent 只有 read ⇒ 不给行（与列无关）。
    const rowDenied = query(db, { view: 'review_queue' }, { session: bot });
    assert.equal(rowDenied.rows.length, 0);
    assert.equal(rowDenied.miss?.reason, 'filtered_by_permission');
    assert.notEqual(rowDenied.miss?.reason, 'column_redacted');

    // 列级：team 行可见，但 rights 列被裁；两者不互相绕过。
    const columnDenied = query(db, { view: 'team' }, { session: bot });
    assert.equal(columnDenied.miss, undefined);
    assert.ok(columnDenied.rows.length > 0);
    assert.deepEqual(columnDenied.redacted_columns, ['rights']);
  });
});

test('M3-6 C2/C4: 没有 human_only 列的视图不产生裁剪字段；带裁剪的查询仍守预算', () => {
  withMigratedDb((db) => {
    seedGrants(db, [{ actor: 'bot', kind: 'agent', right: 'read' }]);
    const bot = session('bot', 'agent');

    const board = query(db, { view: 'board' }, { session: bot });
    assert.equal(board.miss, undefined);
    assert.equal(board.redacted_columns, undefined, '没有 human_only 列 ⇒ 不出现裁字段');

    const page = query(db, { view: 'team', limit: 2 }, { session: bot });
    assert.equal(page.miss, undefined);
    assert.deepEqual(page.redacted_columns, ['rights']);
    assert.equal(typeof page.bytes, 'number');
    assert.ok(page.bytes > 0);
  });
});
