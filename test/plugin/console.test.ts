/** M5-0 C3：独立页只绑回环；未登录只给登录页，不发业务数据。 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { activatePlugin, type PluginContext } from '../../src/plugin/index.js';
import { makeDb, envFor } from './helpers.js';

test('page: 只绑 127.0.0.1；未登录 302 登录页，登录页 200', async () => {
  const fixture = makeDb();
  try {
    const ctx: PluginContext = {
      tools: { register: () => () => undefined },
      effect: () => () => undefined,
    };
    const plugin = await activatePlugin(ctx, {
      db_path: fixture.dbPath,
      project_dir: fixture.dir,
      state_dir: `${fixture.dir}/state`,
      console: true,
      console_port: 0,
    }, envFor());
    try {
      assert.ok(plugin.consolePort !== undefined);
      const base = `http://127.0.0.1:${String(plugin.consolePort)}`;
      const unauthenticated = await fetch(`${base}/`, { redirect: 'manual' });
      assert.equal(unauthenticated.status, 302);
      assert.equal(unauthenticated.headers.get('location'), '/login');
      const login = await fetch(`${base}/login`);
      assert.equal(login.status, 200);
      assert.ok((await login.text()).length > 0);
    } finally {
      await plugin.dispose();
    }
  } finally {
    fixture.close();
  }
});
