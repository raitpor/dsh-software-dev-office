/**
 * M3-4 · claim 侧的目录只读面（`src/claim/catalog.ts`）+ C5 静态守卫。
 *
 * 产品写入口只有 `src/db/renderer.ts`；本套用例证明 claim 网关/对账读的是
 * **目录表**（事件投影），不是代码常量，也没有第二套登记表。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { append } from '../../src/db/write.js';
import { canonicalJson } from '../../src/core/fold/canonical.js';
import type { ClaimRow } from '../../src/claim/types.js';
import { writeClaimRows } from '../../src/claim/gateway.js';
import {
  claimViewsCoverage,
  isRegisteredRenderer,
  registeredRenderer,
  registeredRenderers,
} from '../../src/claim/catalog.js';
import { readRendererCatalog } from '../../src/db/renderer.js';
import type { SdoDatabase } from '../../src/db/driver.js';
import { chain, seed, withWriteDb } from '../db/append-helpers.js';
import { seedRenderer } from './helpers.js';

function row(frontier: readonly string[], overrides: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: 'claim:TEST-1',
    subject: 'TASK-1',
    predicate: 'done',
    value: canonicalJson({ code: 'done', value: true }),
    as_of_frontier: canonicalJson([...frontier]),
    derived_by: 'renderer:gate-result',
    actor: 'alice',
    at: '2026-11-14T00:00:00Z',
    ...overrides,
  };
}

function seedTask(db: SdoDatabase): string {
  const [event] = chain([seed(1, 'task.created', 'TASK-1', { seq: 1, title: 't', kind: 'implement' })]);
  assert.equal(append(db, [event!]).ok, true);
  return event!.id;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

test('C2 the claim gateway reads the catalog table: registered accepts, unknown renderer rejects with 0 rows', () => {
  withWriteDb((db) => {
    const eventId = seedTask(db);
    const forged = writeClaimRows(db, [row([eventId], { derived_by: 'renderer:not-registered' })]);
    assert.equal(forged.reason_code, 'renderer_unregistered');
    assert.equal((db.prepare('SELECT count(*) AS n FROM claim').get() as { n: number }).n, 0);

    // 内置渲染器（迁移 010 播种）无需事件即可用。
    const result = writeClaimRows(db, [row([eventId])]);
    assert.deepEqual([result.ok, result.written], [true, 1]);
  });
});

test('C1 catalog read side delegates to renderer_catalog (built-in + event-projected rows)', () => {
  withWriteDb((db) => {
    seedTask(db);
    assert.equal(isRegisteredRenderer(db, 'renderer:gate-result'), true, 'built-in from migration 010');
    assert.equal(isRegisteredRenderer(db, 'renderer:test-v1'), false);
    seedRenderer(db, { id: 'renderer:test-v1', module_path: 'src/claim/render.ts', views: ['board'] });
    assert.deepEqual(registeredRenderer(db, 'renderer:test-v1'), {
      id: 'renderer:test-v1',
      module_path: 'src/claim/render.ts',
      views: ['board'],
      at: readRendererCatalog(db).find((renderer) => renderer.id === 'renderer:test-v1')?.at,
    });
    assert.deepEqual(registeredRenderers(db).map((renderer) => renderer.id).sort(), [
      'renderer:gate-result',
      'renderer:test-v1',
    ]);
  });
});

test('C4 claimViewsCoverage: views[] must cover every source table of the frontier events', () => {
  withWriteDb((db) => {
    const eventId = seedTask(db);
    seedRenderer(db, { id: 'renderer:gate-result', module_path: 'src/claim/render.ts', views: ['release'] });
    const uncovered = claimViewsCoverage(db, 'renderer:gate-result', [eventId]);
    assert.deepEqual(uncovered, { ok: false, missing_tables: ['task'] });

    seedRenderer(db, { id: 'renderer:gas-result', module_path: 'src/claim/render.ts', views: ['board'] }, 901);
    const covered = claimViewsCoverage(db, 'renderer:gas-result', [eventId]);
    assert.deepEqual(covered, { ok: true, missing_tables: [] });
  });
});

test('C5 static guard: the M1 constant proxy is gone and no second registry table exists', () => {
  assert.equal(existsSync('src/claim/renderers.ts'), false, 'src/claim/renderers.ts must be deleted');
  const offenders: string[] = [];
  for (const file of walk('src')) {
    if (file.endsWith('.ts') === false) continue;
    const text = readFileSync(file, 'utf8');
    if (file.replaceAll('\\', '/').endsWith('src/db/renderer.ts')) continue;
    if (/\b(?:from|into|update|delete\s+from)\s+renderer_catalog\b/i.test(text)) offenders.push(file);
    if (/\bconst\s+RENDERERS\b/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'only src/db/renderer.ts may touch renderer_catalog');
});
