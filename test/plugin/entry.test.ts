/** M5-0 C1/C2/C9/C10：入口注册、工具读写分离、身份与迁移幂等。 */
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { activatePlugin, TOOL_NAMES, type PluginContext } from '../../src/plugin/index.js';
import { PluginRuntime } from '../../src/plugin/state.js';
import { resolvePluginSettings } from '../../src/plugin/config.js';
import { makeDb, envFor, PASSPHRASE } from './helpers.js';
import { currentUserVersion } from '../../src/db/migrate.js';

interface Registered {
  readonly name: string;
  execute(args: unknown, exec: { callId?: string }): Promise<unknown>;
}

function fakeContext(): {
  ctx: PluginContext;
  tools: Registered[];
  effects: number;
  toolDisposers: number;
  cleanupEffects(): void;
} {
  const tools: Registered[] = [];
  const counter = { effects: 0, toolDisposers: 0 };
  const effectDisposers: Array<() => void> = [];
  const ctx: PluginContext = {
    tools: {
      register(definition) {
        tools.push(definition as unknown as Registered);
        return () => {
          counter.toolDisposers += 1;
        };
      },
    },
    effect(callback) {
      counter.effects += 1;
      const disposer = callback();
      if (typeof disposer === 'function') effectDisposers.push(disposer);
      return () => undefined;
    },
  };
  return {
    ctx,
    tools,
    get effects() { return counter.effects; },
    get toolDisposers() { return counter.toolDisposers; },
    cleanupEffects: () => {
      for (const disposer of effectDisposers) disposer();
      effectDisposers.length = 0;
    },
  };
}

test('entry: 注册四个工具，dispose 幂等且不抛', async () => {
  const fixture = makeDb();
  try {
    const harness = fakeContext();
    const plugin = await activatePlugin(harness.ctx, { db_path: fixture.dbPath, project_dir: fixture.dir, console: false }, envFor());
    assert.deepEqual(harness.tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
    assert.equal(harness.tools.length, 4);
    assert.equal(harness.effects, 1, '生命周期 disposer 只注册一次');
    assert.ok(plugin.runtime !== undefined && plugin.runtime.getVersion().length > 0);
    await plugin.dispose();
    await plugin.dispose();
    assert.equal(harness.toolDisposers, 4, '每个工具 disposer 只注销一次');
  } finally {
    fixture.close();
  }
});

test('read tools: 默认 agent 通道可读且不写库', async () => {
  const fixture = makeDb();
  try {
    const harness = fakeContext();
    const plugin = await activatePlugin(harness.ctx, { db_path: fixture.dbPath, project_dir: fixture.dir, console: false }, {
      SDO_DB_PASSPHRASE: PASSPHRASE,
    });
    const before = fixture.db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number };
    const query = harness.tools.find((tool) => tool.name === 'sdo_query');
    assert.ok(query);
    const queried = await query.execute({ view: 'goal' }, { callId: 'c1' });
    assert.equal((queried as { ok: boolean }).ok, true);
    const after = fixture.db.prepare('SELECT COUNT(*) AS n FROM event').get() as { n: number };
    assert.equal(after.n, before.n);
    await plugin.dispose();
  } finally {
    fixture.close();
  }
});

test('sdo_append 经网关写入并 verify 绿', async () => {
  const fixture = makeDb();
  try {
    const harness = fakeContext();
    const plugin = await activatePlugin(harness.ctx, { db_path: fixture.dbPath, project_dir: fixture.dir, console: false }, envFor());
    const append = harness.tools.find((tool) => tool.name === 'sdo_append');
    assert.ok(append);
    const result = await append.execute({
      events: [{
        kind: 'config.changed',
        subject: 'limits.max_members',
        payload: { actor: 'alice', after: 5 },
      }],
    }, { callId: 'c-append' }) as { ok: boolean; written: number };
    assert.equal(result.ok, true);
    assert.equal(result.written, 1);
    const verify = harness.tools.find((tool) => tool.name === 'sdo_verify');
    assert.ok(verify);
    const checked = await verify.execute({}, { callId: 'c-verify' }) as {
      ok: boolean;
      verify: { ok: boolean; problems: unknown[] };
    };
    assert.equal(checked.ok, true);
    assert.equal(checked.verify.ok, true);
    assert.deepEqual(checked.verify.problems, []);
    await plugin.dispose();
  } finally {
    fixture.close();
  }
});

test('agent 不能代签：decision.signed 被网关拒', async () => {
  const fixture = makeDb('agent-a');
  try {
    const harness = fakeContext();
    const plugin = await activatePlugin(harness.ctx, { db_path: fixture.dbPath, project_dir: fixture.dir, console: false }, envFor({
      SDO_PLUGIN_ACTOR: 'agent-a',
      SDO_PLUGIN_ACTOR_KIND: 'agent',
    }));
    const append = harness.tools.find((tool) => tool.name === 'sdo_append');
    assert.ok(append);
    const result = await append.execute({
      events: [{ kind: 'decision.signed', subject: 'd-1', payload: { decision: 'x' } }],
    }, { callId: 'c-sign' }) as { ok: boolean; reason_code?: string };
    assert.equal(result.ok, false);
    assert.ok(typeof result.reason_code === 'string' && result.reason_code.length > 0);
    await plugin.dispose();
  } finally {
    fixture.close();
  }
});

test('库路径权限 0700/0600，迁移可重入', () => {
  const fixture = makeDb();
  try {
    const runtime = new PluginRuntime(resolvePluginSettings({ db_path: fixture.dbPath, project_dir: fixture.dir }, envFor()));
    const db = runtime.open();
    const fileMode = statSync(fixture.dbPath).mode & 0o777;
    const dirMode = statSync(fixture.dir).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.equal(dirMode, 0o700);
    const version = currentUserVersion(db);
    assert.ok(version > 0);
    runtime.dispose();
    const again = new PluginRuntime(resolvePluginSettings({ db_path: fixture.dbPath, project_dir: fixture.dir }, envFor()));
    assert.equal(again.userVersion(), version);
    again.dispose();
  } finally {
    fixture.close();
  }
});

test('重开数据保留且 verify 绿（E6 的插件侧部分）', async () => {
  const fixture = makeDb();
  try {
    const first = fakeContext();
    const plugin = await activatePlugin(first.ctx, { db_path: fixture.dbPath, project_dir: fixture.dir, console: false }, envFor());
    const append = first.tools.find((tool) => tool.name === 'sdo_append');
    assert.ok(append);
    const written = await append.execute({
      events: [{ kind: 'config.changed', subject: 'limits.cleanup_timeout_s', payload: { actor: 'alice', after: 30 } }],
    }, { callId: 'c-write' }) as { ok: boolean; written: number; skipped: number; reason_code?: string };
    assert.equal(written.written, 1, JSON.stringify(written));
    await plugin.dispose();

    const second = fakeContext();
    const reopened = await activatePlugin(second.ctx, { db_path: fixture.dbPath, project_dir: fixture.dir, console: false }, envFor());
    const verify = second.tools.find((tool) => tool.name === 'sdo_verify');
    assert.ok(verify);
    const checked = await verify.execute({}, { callId: 'c-reopen' }) as {
      verify: { ok: boolean; eventCount: number };
    };
    assert.equal(checked.verify.ok, true);
    assert.ok(checked.verify.eventCount > 0);
    await reopened.dispose();
  } finally {
    fixture.close();
  }
});


test('P2-1 配置非法：不注册工具、不上抛、dispose 安全', async () => {
  const fixture = makeDb();
  try {
    const harness = fakeContext();
    const plugin = await activatePlugin(
      harness.ctx,
      { db_path: '/etc/sdo-not-allowed.db', project_dir: fixture.dir, console: false },
      envFor(),
    );
    assert.equal(plugin.runtime, undefined);
    assert.equal(harness.tools.length, 0);
    assert.equal(harness.effects, 0);
    await plugin.dispose();
    await plugin.dispose();
  } finally {
    fixture.close();
  }
});

test('P2-2 身份缺省 agent；无口令时读工具结构化 no_permission', async () => {
  assert.equal(resolvePluginSettings({}, {}).actorKind, 'agent');
  const fixture = makeDb();
  try {
    const harness = fakeContext();
    const plugin = await activatePlugin(
      harness.ctx,
      { db_path: fixture.dbPath, project_dir: fixture.dir, console: false },
      { SDO_PLUGIN_ACTOR: 'alice' },
    );
    for (const name of ['sdo_query', 'sdo_verify', 'sdo_status']) {
      const tool = harness.tools.find((item) => item.name === name);
      assert.ok(tool);
      const result = await tool.execute(name === 'sdo_query' ? { view: 'goal' } : {}, { callId: `c-${name}` });
      assert.equal((result as { ok: boolean }).ok, false, name);
      assert.equal((result as { reason_code: string }).reason_code, 'no_permission', name);
    }
    const append = harness.tools.find((tool) => tool.name === 'sdo_append');
    assert.ok(append);
    const write = await append.execute({
      events: [{ kind: 'config.changed', subject: 'limits.max_members', payload: { actor: 'alice', after: 3 } }],
    }, { callId: 'c-nopass' });
    assert.equal((write as { reason_code: string }).reason_code, 'no_permission');
    await plugin.dispose();
  } finally {
    fixture.close();
  }
});


test('P2-4 宿主入口 apply 返回 undefined（Cordis 把返回值当 effect）', async () => {
  const fixture = makeDb();
  const saved = {
    passphrase: process.env['SDO_DB_PASSPHRASE'],
    actor: process.env['SDO_PLUGIN_ACTOR'],
  };
  process.env['SDO_DB_PASSPHRASE'] = PASSPHRASE;
  process.env['SDO_PLUGIN_ACTOR'] = 'alice';
  try {
    const harness = fakeContext();
    const entry = (await import(new URL('../../../index.js', import.meta.url).href)) as {
      apply(ctx: PluginContext, config: Record<string, unknown>): Promise<unknown>;
    };
    const result = await entry.apply(harness.ctx, {
      db_path: fixture.dbPath,
      project_dir: fixture.dir,
      console: false,
    });
    // Cordis `safeCollect` 只接受函数/null；返回对象会 TypeError: Invalid effect。
    assert.equal(result, undefined);
    assert.equal(harness.tools.length, 4);
    harness.cleanupEffects();
  } finally {
    if (saved.passphrase === undefined) delete process.env['SDO_DB_PASSPHRASE'];
    else process.env['SDO_DB_PASSPHRASE'] = saved.passphrase;
    if (saved.actor === undefined) delete process.env['SDO_PLUGIN_ACTOR'];
    else process.env['SDO_PLUGIN_ACTOR'] = saved.actor;
    fixture.close();
  }
});

test('P2-4 工具注册中途失败：回滚已注册的工具', async () => {
  const fixture = makeDb();
  let calls = 0;
  let rolledBack = 0;
  const ctx: PluginContext = {
    tools: {
      register() {
        calls += 1;
        if (calls === 2) throw new Error('register_boom');
        return () => {
          rolledBack += 1;
        };
      },
    },
    effect: (callback) => {
      callback();
      return () => undefined;
    },
  };
  try {
    await assert.rejects(
      () => activatePlugin(ctx, { db_path: fixture.dbPath, project_dir: fixture.dir, console: false }, envFor()),
      /register_boom/,
    );
    assert.equal(rolledBack, 1);
  } finally {
    fixture.close();
  }
});


test('E1b CJS 入口：require(根) 得到对象且 apply 不返回值', async () => {
  const fixture = makeDb();
  const saved = {
    passphrase: process.env['SDO_DB_PASSPHRASE'],
    actor: process.env['SDO_PLUGIN_ACTOR'],
  };
  process.env['SDO_DB_PASSPHRASE'] = PASSPHRASE;
  process.env['SDO_PLUGIN_ACTOR'] = 'alice';
  try {
    const requireRoot = createRequire(import.meta.url);
    const mod = requireRoot('../../../') as Record<string, unknown>;
    assert.equal(typeof mod, 'object');
    assert.notEqual(typeof mod, 'function', '宿主把 main 当函数调用时不能是函数');
    assert.equal(typeof mod['apply'], 'function');
    assert.deepEqual(mod['inject'], ['tools', 'approval']);

    const harness = fakeContext();
    const result = await (mod['apply'] as (ctx: PluginContext, config: Record<string, unknown>) => Promise<unknown>)(
      harness.ctx,
      { db_path: fixture.dbPath, project_dir: fixture.dir, console: false },
    );
    assert.equal(result, undefined);
    assert.equal(harness.tools.length, 4);
    harness.cleanupEffects();
  } finally {
    if (saved.passphrase === undefined) delete process.env['SDO_DB_PASSPHRASE'];
    else process.env['SDO_DB_PASSPHRASE'] = saved.passphrase;
    if (saved.actor === undefined) delete process.env['SDO_PLUGIN_ACTOR'];
    else process.env['SDO_PLUGIN_ACTOR'] = saved.actor;
    fixture.close();
  }
});

test('E1b 清单：main 在 files 内且与 exports["."].require 一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    main?: string;
    files?: string[];
    exports?: Record<string, { require?: string } | string>;
  };
  assert.equal(pkg.main, 'index.cjs');
  const dot = pkg.exports?.['.'];
  assert.ok(typeof dot === 'object' && dot !== null);
  assert.equal(dot.require?.replace(/^\.\//, ''), pkg.main);
  assert.ok((pkg.files ?? []).includes(pkg.main));
});
