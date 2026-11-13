import assert from 'node:assert/strict';
import { test } from 'node:test';

import { columnNames, withMigratedDb } from '../db/helpers.js';
import { listViewCatalog, nativeViewName } from '../../src/views/catalog.js';

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().replace(/;$/, '').trim();
}

function viewBody(masterSql: string): string {
  const match = /^CREATE\s+VIEW\s+\S+\s+AS\s+([\s\S]*)$/i.exec(masterSql.trim());
  assert.ok(match, `unexpected sqlite_master view SQL: ${masterSql.slice(0, 80)}`);
  return match[1] ?? '';
}

function masterViewSql(db: Parameters<typeof listViewCatalog>[0]): Map<string, string> {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name")
    .all() as Array<Record<string, unknown>>;
  return new Map(
    rows.map((row) => [String(row['name']), String(row['sql'] ?? '')]),
  );
}

test('C2：13 个视图都存在；空库对每个视图 SELECT * LIMIT 0 都不炸', () => {
  withMigratedDb((db) => {
    const catalog = listViewCatalog(db);
    assert.equal(catalog.length, 13);

    const nativeNames = new Set(catalog.map((view) => nativeViewName(view.name)));
    const masters = masterViewSql(db);
    assert.equal(masters.size, 13);
    assert.deepEqual([...masters.keys()].sort(), [...nativeNames].sort());

    for (const view of catalog) {
      const native = nativeViewName(view.name);
      assert.doesNotThrow(
        () => db.prepare(`SELECT * FROM ${native} LIMIT 0`).all(),
        `SELECT * FROM ${native} LIMIT 0 不炸`,
      );
    }
  });
});

test('C2：空库下 overview 恰好一行（stage=unset/health=green），pm_queue/pm_gaps 0 行', () => {
  withMigratedDb((db) => {
    const overview = db.prepare('SELECT * FROM overview').all() as Array<Record<string, unknown>>;
    assert.deepEqual(overview, [
      { stage: 'unset', in_flight: 0, blocked: 0, open_defects: 0, health: 'green' },
    ]);

    assert.deepEqual(db.prepare('SELECT * FROM pm_queue').all(), []);
    assert.deepEqual(db.prepare('SELECT * FROM pm_gaps').all(), []);
    assert.deepEqual(db.prepare('SELECT * FROM review_queue').all(), []);
  });
});

test('C3：每个视图的实际列名（顺序）与 columns JSON 的列名集合/顺序一致', () => {
  withMigratedDb((db) => {
    for (const view of listViewCatalog(db)) {
      const native = nativeViewName(view.name);
      const actual = columnNames(db, native);
      const declared = view.columns.map((column) => column.name);
      assert.deepEqual(actual, declared, `columns of ${view.name} (${native})`);
      assert.equal(new Set(actual).size, actual.length, `duplicate columns in ${view.name}`);
    }
  });
});

test('C3：sqlite_master 里的视图 body 与 view_catalog.sql 归一空白后逐字一致', () => {
  withMigratedDb((db) => {
    const masters = masterViewSql(db);
    for (const view of listViewCatalog(db)) {
      const native = nativeViewName(view.name);
      const master = masters.get(native);
      assert.ok(master !== undefined, `sqlite_master 缺少视图 ${native}`);
      const fromMaster = normalizeSql(viewBody(master));
      const fromCatalog = normalizeSql(view.sql);
      assert.ok(fromMaster.length > 0);
      assert.equal(fromCatalog, fromMaster, `catalog.sql 与 CREATE VIEW body 不一致：${view.name}`);
    }
  });
});

test('确定性：review_queue.evidence_refs 对同一任务 ≥2 条 evidence 顺序固定（按 evidence_id 升序）', () => {
  withMigratedDb((db) => {
    // 最小链条：decision → intent → spec → criterion → evidence×2，再 task → attention → report×2。
    db.prepare(
      `INSERT INTO decision (id, decision_kind, status, payload, payload_hash, signature, key_id, signer, frontier, at)
       VALUES ('D1', 'sign', 'valid', '{}', 'h-d1', 'sig-d1', 'k1', 'human-pm', 'F0', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO intent (id, statement, source_text, owner, decision_id, strength, baseline_hash, content_hash, at)
       VALUES ('I1', '意图摘要', '用户原话', 'human-pm', 'D1', 'explicit', 'b0', 'h-i1', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO spec (id, intent_id, clause, kind, created_by, producer, content_hash, at)
       VALUES ('S1', 'I1', '系统必须记录证据', 'requirement', 'human-pm', 'agent-dev', 'h-s1', '2026-01-01T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO criterion (id, spec_id, kind, status_enum, remedy)
       VALUES ('C1', 'S1', 'behavior', 'active', '补一条测试')`,
    ).run();
    db.prepare(
      `INSERT INTO evidence (id, criterion_id, artifact_uri, artifact_sha256, command, at)
       VALUES ('E1', 'C1', 'artifact://e1', 'sha-e1', 'cmd e1', '2026-01-01T00:00:01Z'),
              ('E2', 'C1', 'artifact://e2', 'sha-e2', 'cmd e2', '2026-01-01T00:00:02Z')`,
    ).run();
    db.prepare(
      `INSERT INTO task (id, seq, title, kind, created_by, status, at)
       VALUES ('T1', 1, '需人答的卡', 'implement', 'human-pm', 'in_progress', '2026-01-01T00:00:03Z')`,
    ).run();
    db.prepare(
      `INSERT INTO attention (id, task_id, raised_by, question, options, state, expires_at, at)
       VALUES ('A1', 'T1', 'agent-dev', '是否继续？', '[]', 'open', '2026-02-01T00:00:00Z', '2026-01-01T00:00:04Z')`,
    ).run();
    // 反序插入（E2 在前）+ 一条无证据的 report（应被 IS NOT NULL 过滤）。
    db.prepare(
      `INSERT INTO report (id, task_id, state, evidence_id, note, at)
       VALUES ('R1', 'T1', 'ready', 'E2', '后加的证据', '2026-01-01T00:00:06Z'),
              ('R2', 'T1', 'ready', 'E1', '先加的证据', '2026-01-01T00:00:05Z'),
              ('R0', 'T1', 'progress', NULL, '无证据进度', '2026-01-01T00:00:04Z')`,
    ).run();

    const first = db.prepare('SELECT * FROM review_queue').all() as Array<Record<string, unknown>>;
    assert.equal(first.length, 1);
    assert.equal(first[0]?.['evidence_refs'], '["E1","E2"]');
    assert.deepEqual(db.prepare('SELECT * FROM review_queue').all(), first);
  });
});
