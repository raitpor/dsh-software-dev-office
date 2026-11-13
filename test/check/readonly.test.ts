import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCheck } from '../../src/check/index.js';
import { countRows, withCheckDb } from './helpers.js';

const CHECK_DIR = join(process.cwd(), 'src', 'check');

function checkSources(): { file: string; text: string }[] {
  return readdirSync(CHECK_DIR)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => ({ file: entry, text: readFileSync(join(CHECK_DIR, entry), 'utf8') }));
}

test('C4：src/check 无写 SQL 关键字，SQL 只允许 SELECT / PRAGMA table_info', () => {
  const forbidden = /\b(INSERT|UPDATE|DELETE|REPLACE|ATTACH|DETACH|CREATE|DROP|ALTER|VACUUM|REINDEX|ANALYZE|TRIGGER)\b/;
  for (const source of checkSources()) {
    assert.equal(forbidden.test(source.text), false, `${source.file} 出现写 SQL 关键字`);
    const sqlCalls = source.text.match(/(?:prepare|exec)\(\s*['"`]([^'"`]*)/g) ?? [];
    for (const call of sqlCalls) {
      assert.ok(
        /SELECT|PRAGMA table_info|sqlite_master/.test(call),
        `${source.file} 出现非只读 SQL：${call}`,
      );
    }
  }
});

test('C4/C5：跑完所有入口，event/baseline/task/spec 行数不变，gate.judged 不存在', () => {
  withCheckDb((db) => {
    const tables = ['event', 'baseline', 'task', 'spec'] as const;
    const before = tables.map((table) => countRows(db, table));
    runCheck(db, { criterion: 'provenance.present' });
    runCheck(db, { gate: 'req' });
    runCheck(db, { criterion: 'dead_field' });
    const after = tables.map((table) => countRows(db, table));
    assert.deepEqual(after, before, `只读被破坏：${JSON.stringify({ before, after })}`);

    // 判死读数⑦：M1 跑完不得产生判定行。M2 会建这张表，所以口径是“表存在则 count=0、
    // 不存在也绿”，否则 M2 建表那天这条会变成假红。
    const judged = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'gate.judged'")
      .get() as { n: number };
    if (judged.n > 0) {
      const rows = db.prepare('SELECT count(*) AS n FROM "gate.judged"').get() as { n: number };
      assert.equal(rows.n, 0, 'M1 不得写 gate.judged 行');
    }
  });
});

test('C5：gate 预览后 gate.judged 仍零产出（判死读数⑦的取证基础）', () => {
  withCheckDb((db) => {
    for (const preset of ['waterfall', 'prototype', 'incremental'] as const) {
      for (const stage of ['req', 'design', 'build', 'verify', 'deliver', 'explore', 'harden', 'req_design', 'integrate']) {
        runCheck(db, { gate: stage, preset });
      }
    }
    const judged = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'gate.judged'")
      .get() as { n: number };
    if (judged.n > 0) {
      const rows = db.prepare('SELECT count(*) AS n FROM "gate.judged"').get() as { n: number };
      assert.equal(rows.n, 0, 'M1 不得写 gate.judged 行');
    }
  });
});
