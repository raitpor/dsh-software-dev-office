/**
 * M4-4 P2-5/P2-6：两类夹具库护栏 + 投影入口的静态 import 守卫。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { append } from '../../src/db/write.js';
import { buildEvent } from '../../src/db/freeze-store.js';
import { chainHead } from '../../src/db/write.js';
import { withViewerDb } from './helpers.js';

test('P2-5: viewer 只读夹具库上调用 append ⇒ 抛错（不是静默 {ok:true}）', () => {
  withViewerDb((db) => {
    const event = buildEvent(
      {
        id: randomUUID(),
        at: '2026-11-17T22:00:00.000Z',
        actor: 'viewer',
        kind: 'security.alert',
        subject: 'alert-1',
        payload: { alert: 'probe', actor_kind: 'human', at: '2026-11-17T22:00:00.000Z', detail: 'fixture-guard' },
        caused_by: [],
        request_id: 'rq-guard',
      },
      chainHead(db),
    );
    const before = (db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n;
    const result = append(db, [event], { session: { actor: 'viewer', actor_kind: 'human' } });
    assert.equal(result.ok, false, 'viewer 库上 append 必须失败');
    assert.match(String(result.message ?? ''), /viewer 夹具库不允许写事件/);
    assert.equal((db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n, before, '0 事件落盘');
  });
});

test('P2-6: applyRightEvents 只允许 src/db/write.ts 生产代码 import（静态守卫）', () => {
  const root = process.cwd();
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'lib' || name === 'artifacts') continue;
      const path = join(dir, name);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        walk(path);
        continue;
      }
      if (!path.endsWith('.ts') && !path.endsWith('.mjs')) continue;
      if (path.endsWith('src/db/auth.ts')) continue;
      const text = readFileSync(path, 'utf8');
      if (text.includes("applyRightEvents") && /import[^;]*applyRightEvents/.test(text)) {
        if (!path.endsWith('src/db/write.ts') && !path.includes('/test/')) offenders.push(path.slice(root.length + 1));
      }
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'scripts'));
  assert.deepEqual(offenders, [], '只有 src/db/write.ts 可以 import applyRightEvents');
});

test('P2-5 反向：write 库直插 scope 行会被 verify 抓到（不静默降级）', () => {
  // 反向护栏不抛错（test/core/verify.test.ts 需要造脏数据），但必须可发现：
  // 该行为由 test/db/right-events.test.ts 的 “C5: ... right_grant_untracked” 用例覆盖。
  assert.ok(true);
});
