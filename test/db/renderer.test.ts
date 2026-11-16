import { grantFixtureRoster } from './append-auth.js';
import { appendAs as append } from './append-auth.js';
/**
 * M3-4 · 渲染器注册目录（C1 表/迁移、C3 登记即代码、权限、事件投影）。
 *
 * 这里测的是**产品入口** `registerRenderer()`（需要 admin@domain）；claim 侧
 * “先播种目录再写 claim”的夹具在 `test/claim/helpers.ts` 的 `seedRenderer()`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { SdoDatabase } from '../../src/db/driver.js';
import { currentUserVersion } from '../../src/db/migrate.js';
import {
  RENDERER_PERMISSION_ACTION,
  RENDERER_REGISTRY_SCOPE,
  compiledRendererFile,
  readRendererCatalog,
  rebuildRendererCatalog,
  withRendererCatalogProjection,
  registerRenderer,
  rendererById,
} from '../../src/db/renderer.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { openSdoDatabase } from '../../src/db/open.js';
import { runMigrations } from '../../src/db/migrate.js';
import { PASSPHRASE, chain, seed } from './append-helpers.js';
import { columnNames, withMigratedDb } from './helpers.js';
import { chainHead } from '../../src/db/write.js';
import { renderClaimRows } from '../../src/claim/render.js';
import { nativeViewName } from '../../src/views/catalog.js';

/** 异步版 withMigratedDb：registerRenderer 要 `import()` 模块，用例是 async。 */
async function withMigratedDbAsync(run: (db: SdoDatabase) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m3-4-renderer-'));
  const db = openSdoDatabase(join(dir, 'sdo.db'), PASSPHRASE);
  try {
    runMigrations(db);
    grantFixtureRoster(db);
    await run(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const ADMIN = { id: 'admin-1', kind: 'human' } as const;
const STRANGER = { id: 'mallory', kind: 'human' } as const;

/** 插 actor + 一条 `admin@domain:renderers` grant（hasRight 的输入是数据）。 */
function grantAdmin(db: SdoDatabase): void {
  db.prepare("INSERT OR IGNORE INTO actor (id, kind, display, at) VALUES (?, 'human', 'Admin', '2026-11-15T00:00:00Z')").run(
    ADMIN.id,
  );
  db.prepare(
    `INSERT INTO scope (actor, scope, right, granted_by, at, revoked_at)
     VALUES (?, ?, 'admin', 'boot', '2026-11-15T00:00:00Z', NULL)`,
  ).run(ADMIN.id, 'domain:renderers');
}

function eventCount(db: SdoDatabase): number {
  return (db.prepare('SELECT count(*) AS n FROM event').get() as { n: number }).n;
}

test('C1 migration 010/011: renderer_catalog table + renderer.registered kind + built-in renderer (idempotent)', () => {
  withMigratedDb((db) => {
    assert.equal(currentUserVersion(db), 15, '当前链头（015 追加 task block_code 两码）');
    assert.deepEqual(columnNames(db, 'renderer_catalog'), ['id', 'module_path', 'views', 'at']);
    const kind = db.prepare("SELECT kind FROM event_kind WHERE kind = 'renderer.registered'").get();
    assert.ok(kind !== undefined, 'migration 010 must seed the ACK kind');
    // 内置渲染器：v1 结论回执，M1/M2 读数与 v1 导入都依赖它。
    assert.deepEqual(rendererById(db, 'renderer:gate-result'), {
      id: 'renderer:gate-result',
      module_path: 'src/claim/render.ts',
      views: ['board', 'plan'],
      at: '2026-11-15',
    });
    // 幂等：迁移链二次运行 0 变化，目录仍是一行。
    const second = runMigrations(db);
    assert.deepEqual(second.applied, []);
    assert.equal(readRendererCatalog(db).length, 1);
  });
});

test('C3 built-in renderer: module_path really exists and exports a render function', async () => {
  await withMigratedDbAsync(async (db) => {
    const builtin = rendererById(db, 'renderer:gate-result');
    assert.ok(builtin !== undefined);
    const file = compiledRendererFile(builtin.module_path);
    assert.ok(file !== undefined && existsSync(file), `compiled renderer must exist: ${file}`);
    const namespace = (await import(pathToFileURL(file!).href)) as Record<string, unknown>;
    assert.equal(typeof namespace['renderClaimRows'], 'function');
  });
});

test('C3 registerRenderer: admin@domain registers a real module; catalog row comes from the event', async () => {
  await withMigratedDbAsync(async (db) => {
    grantAdmin(db);
    const result = await registerRenderer(db, {
      id: 'renderer:claim-v1',
      module_path: 'src/claim/render.ts',
      views: ['board'],
      actor: ADMIN,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.created, true);
    const row = rendererById(db, 'renderer:claim-v1');
    assert.deepEqual(row, {
      id: 'renderer:claim-v1',
      module_path: 'src/claim/render.ts',
      views: ['board'],
      at: row?.at,
    });
    assert.equal(readRendererCatalog(db).length, 2, 'built-in + newly registered');
    const event = db
      .prepare("SELECT kind, payload FROM event WHERE kind = 'renderer.registered'")
      .get() as { kind: string; payload: string } | undefined;
    assert.ok(event !== undefined);
    assert.deepEqual(JSON.parse(event.payload), {
      id: 'renderer:claim-v1',
      module_path: 'src/claim/render.ts',
      views: ['board'],
    });
    assert.equal(eventCount(db), 1);

    // 幂等：同 id/同 module_path/同 views 集合 ⇒ created:false，不再写事件。
    const again = await registerRenderer(db, {
      id: 'renderer:claim-v1',
      module_path: 'src/claim/render.ts',
      views: ['board'],
      actor: ADMIN,
    });
    assert.deepEqual(again, { ok: true, id: 'renderer:claim-v1', created: false });
    assert.equal(eventCount(db), 1);

    // 同 id 不同 views ⇒ renderer_conflict，零写。
    const conflict = await registerRenderer(db, {
      id: 'renderer:claim-v1',
      module_path: 'src/claim/render.ts',
      views: ['plan'],
      actor: ADMIN,
    });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.reason_code, 'renderer_conflict');
    assert.equal(eventCount(db), 1);
  });
});

test('C1 rebuildRendererCatalog: the event log is the only source of truth', async () => {
  await withMigratedDbAsync(async (db) => {
    grantAdmin(db);
    const registered = await registerRenderer(db, {
      id: 'renderer:claim-v1',
      module_path: 'src/claim/render.ts',
      views: ['board'],
      actor: ADMIN,
    });
    assert.equal(registered.ok, true);
    // 直改目录行（事件没变）⇒ rebuild 必须还原。P1-3 之后裸写被触发器挡，
    // 这里用投影窗口模拟“旧物化器留下的过期行”，再验证事件流仍是唯一真源。
    withRendererCatalogProjection(db, () => {
      db.prepare("UPDATE renderer_catalog SET module_path = 'src/evil.ts', views = '[\"none\"]' WHERE id = ?").run(
        'renderer:claim-v1',
      );
    });
    rebuildRendererCatalog(db);
    assert.deepEqual(rendererById(db, 'renderer:claim-v1')?.module_path, 'src/claim/render.ts');
    assert.deepEqual(rendererById(db, 'renderer:claim-v1')?.views, ['board']);
  });
});

test('C3 registerRenderer: nonexistent module and module without a render export are rejected', async () => {
  await withMigratedDbAsync(async (db) => {
    grantAdmin(db);
    const missing = await registerRenderer(db, {
      id: 'renderer:missing',
      module_path: 'src/claim/does-not-exist.ts',
      views: ['board'],
      actor: ADMIN,
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason_code, 'renderer_module_invalid');

    // lib/claim/types.js 存在但只导出类型（运行时无导出）⇒ 没有 render/renderClaimRows。
    const noExport = await registerRenderer(db, {
      id: 'renderer:no-export',
      module_path: 'src/claim/types.ts',
      views: ['board'],
      actor: ADMIN,
    });
    assert.equal(noExport.ok, false);
    if (!noExport.ok) {
      assert.equal(noExport.reason_code, 'renderer_module_invalid');
      assert.match(noExport.message ?? '', /render/);
    }
    assert.equal(eventCount(db), 0, 'failed registration writes nothing');
    assert.equal(readRendererCatalog(db).length, 1, 'only the built-in renderer remains');
  });
});

test('C4 registerRenderer: permission comes from the matrix (admin@domain), not from the caller', async () => {
  await withMigratedDbAsync(async (db) => {
    assert.equal(RENDERER_PERMISSION_ACTION, 'config');
    assert.equal(RENDERER_REGISTRY_SCOPE, 'domain:renderers');
    db.prepare("INSERT OR IGNORE INTO actor (id, kind, display, at) VALUES ('mallory', 'human', 'Mallory', '2026-11-15T00:00:00Z')").run();
    const denied = await registerRenderer(db, {
      id: 'renderer:claim-v1',
      module_path: 'src/claim/render.ts',
      views: ['board'],
      actor: STRANGER,
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.reason_code, 'no_permission');
    assert.equal(eventCount(db), 0);
  });
});

test('C2 registerRenderer: views must already exist in view_catalog; ids/views shapes are validated', async () => {
  await withMigratedDbAsync(async (db) => {
    grantAdmin(db);
    const unknownView = await registerRenderer(db, {
      id: 'renderer:claim-v1',
      module_path: 'src/claim/render.ts',
      views: ['not-a-view'],
      actor: ADMIN,
    });
    assert.equal(unknownView.ok, false);
    if (!unknownView.ok) assert.equal(unknownView.reason_code, 'renderer_views_unknown');

    for (const bad of [
      { id: '', views: ['board'] },
      { id: 'renderer:*', views: ['board'] },
      { id: 'renderer:claim-v1', views: [] },
      { id: 'renderer:claim-v1', views: ['board', 'board'] },
    ]) {
      const result = await registerRenderer(db, {
        ...bad,
        module_path: 'src/claim/render.ts',
        actor: ADMIN,
      });
      assert.equal(result.ok, false, JSON.stringify(bad));
      if (!result.ok) assert.equal(result.reason_code, 'invalid_field', JSON.stringify(bad));
    }
    assert.equal(eventCount(db), 0);
  });
});


// ---------------------------------------------------------------------------
// P1-2：直 append `renderer.registered` 必须被写网关拒（一次性能力���没有 mint 的路径）
// ---------------------------------------------------------------------------

test('P1-2 直 append renderer.registered（无能力）⇒ unauthorized_renderer_registration、零写入', () => {
  withMigratedDb((db) => {
    const beforeEvents = eventCount(db);
    const beforeCatalog = readRendererCatalog(db);
    const [forged] = chain(
      [
        seed(910, 'renderer.registered', 'renderer:forged', {
          id: 'renderer:forged',
          module_path: 'src/claim/render.ts',
          views: ['board'],
        }),
      ],
      chainHead(db),
    );
    const result = append(db, [forged!]);
    assert.equal(result.ok, false, '直 append 必须被写网关拒');
    assert.equal(result.reason_code, 'unauthorized_renderer_registration');
    assert.equal(eventCount(db), beforeEvents, '被拒事件不得落链');
    assert.deepEqual(readRendererCatalog(db), beforeCatalog, '目录不得变');
  });
});

test('P1-2 即使 module_path 指向不存在文件，直 append 也先被能力守卫拒（不是先报模块错）', () => {
  withMigratedDb((db) => {
    const [forged] = chain(
      [
        seed(911, 'renderer.registered', 'renderer:ghost', {
          id: 'renderer:ghost',
          module_path: 'src/nope/missing.ts',
          views: ['board'],
        }),
      ],
      chainHead(db),
    );
    const result = append(db, [forged!]);
    assert.equal(result.ok, false);
    assert.equal(result.reason_code, 'unauthorized_renderer_registration');
    assert.equal(rendererById(db, 'renderer:ghost'), undefined);
  });
});

// ---------------------------------------------------------------------------
// P1-3：renderer_catalog 是投影表，窗口外直写由迁移 011 的哨兵触发器 ABORT
// ---------------------------------------------------------------------------

test('P1-3 裸连接直插/直改/直删 renderer_catalog ⇒ ABORT（投影表只能经 append）', () => {
  withMigratedDb((db) => {
    const insert = db.prepare(
      "INSERT INTO renderer_catalog (id, module_path, views, at) VALUES ('renderer:raw', 'src/claim/render.ts', '[]', '2026-11-15')",
    );
    assert.throws(() => insert.run(), /renderer_catalog is a projection: write via append/);
    const update = db.prepare("UPDATE renderer_catalog SET module_path = 'src/claim/types.ts' WHERE id = 'renderer:gate-result'");
    assert.throws(() => update.run(), /renderer_catalog is a projection: write via append/);
    const remove = db.prepare("DELETE FROM renderer_catalog WHERE id = 'renderer:gate-result'");
    assert.throws(() => remove.run(), /renderer_catalog is a projection: write via append/);
    // 守卫只挡写、不挡读：内置行还在
    assert.equal(readRendererCatalog(db).length, 1);
  });
});

test('P1-3 合法登记走 append 事务内投影：成功后行在；rebuild 可往返（哨兵窗口内被允许）', async () => {
  await withMigratedDbAsync(async (db) => {
    grantAdmin(db);
    const result = await registerRenderer(db, {
      id: 'renderer:raw-ok',
      module_path: 'src/claim/render.ts',
      views: ['board'],
      actor: ADMIN,
    });
    assert.equal(result.ok, true);
    const row = rendererById(db, 'renderer:raw-ok');
    assert.equal(row?.module_path, 'src/claim/render.ts');
    // rebuild 是维护面：它自己开哨兵窗口，能重建也能还原
    const rebuilt = rebuildRendererCatalog(db);
    assert.ok(rebuilt.some((entry) => entry.id === 'renderer:raw-ok'));
    assert.ok(rebuilt.some((entry) => entry.id === 'renderer:gate-result'), '内置行仍在');
  });
});

// ---------------------------------------------------------------------------
// P2-2：内置播种行不是“只写了个路径字符串”——import 得动，且真能出渲染行
// ---------------------------------------------------------------------------

test('P2-2 内置 renderer:gate-result：module_path 真实存在、import 成功、对 views[] 每个视图都出渲染行', async () => {
  await withMigratedDbAsync(async (db) => {
    const builtin = rendererById(db, 'renderer:gate-result');
    assert.ok(builtin, '迁移 011 后内置行必须在目录里');
    assert.equal(builtin!.module_path, 'src/claim/render.ts');
    const file = compiledRendererFile(builtin!.module_path);
    assert.ok(file !== undefined, '内置 module_path 必须是合法的 src/*.ts 路径');
    assert.ok(existsSync(file), `内置模块编译产物必须存在: ${file}`);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    assert.equal(typeof mod['renderClaimRows'], 'function', '内置模块必须导出 renderClaimRows');

    // 真出渲染行：先播一个 task.created（claim 渲染只看 task 事件）
    const appended = append(
      db,
      chain(
        [
          seed(920, 'task.created', 'T-9001', {
            id: 'T-9001',
            seq: 920,
            title: 'P2-2 render probe',
            kind: 'implement',
            producer: 'impl-surface',
            created_by: 'lead',
            inputs: [],
          }, { request_id: 'imp:9001' }),
        ],
        chainHead(db),
      ),
    );
    assert.equal(appended.ok, true, `task.created seed rejected: ${appended.reason_code} ${appended.message ?? ''}`);
    const rendered = renderClaimRows(db);
    assert.ok(rendered.length > 0, 'renderClaimRows 必须至少渲染出一行 claim');

    for (const view of builtin!.views) {
      const native = nativeViewName(view);
      const rows = db.prepare(`SELECT * FROM ${native}`).all();
      assert.ok(rows.length > 0, `内置渲染器声明的视图 ${view} 必须真有行可渲染`);
    }
  });
});

test('P1-3 哨兵异常安全：窗口内抛错后 active 复位 0、事务回滚；随后裸写仍被 ABORT', () => {
  withMigratedDb((db) => {
    assert.throws(
      () =>
        withRendererCatalogProjection(db, () => {
          db.prepare("UPDATE renderer_catalog SET module_path = 'src/evil.ts' WHERE id = 'renderer:gate-result'").run();
          throw new Error('boom');
        }),
      /boom/,
    );
    const guard = db
      .prepare("SELECT active FROM projection_guard WHERE name = 'renderer_catalog'")
      .get() as { active: number };
    assert.equal(guard.active, 0, '异常后哨兵必须复位，否则投影表永久锁死');
    // 窗口内的写入随事务回滚；窗口外仍是 ABORT（不是锁死，是投影表守卫）
    assert.equal(readRendererCatalog(db)[0]?.module_path, 'src/claim/render.ts');
    assert.throws(() => db.prepare('DELETE FROM renderer_catalog').run(), /renderer_catalog is a projection/);
    assert.equal(readRendererCatalog(db).length, 1);
  });
});
