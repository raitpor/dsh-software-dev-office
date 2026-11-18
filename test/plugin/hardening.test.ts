/** M5-0 第 1 轮评审：P2-1 db_path 白名单、P2-2 status 日志、P3 静态无 raw SQL。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { PluginConfigError, resolvePluginSettings } from '../../src/plugin/config.js';
import { buildTools } from '../../src/plugin/tools.js';
import { PluginRuntime } from '../../src/plugin/state.js';
import type { PluginLogLine } from '../../src/plugin/state.js';
import { makeDb, envFor } from './helpers.js';

test('config: db_path 只许状态目录/项目 .sdo，越界启动即 invalid_config', () => {
  assert.throws(
    () => resolvePluginSettings({ db_path: join(process.cwd(), 'sdo.db') }, {}),
    (error: unknown) => error instanceof PluginConfigError && error.reason_code === 'invalid_config',
  );
  assert.throws(
    () => resolvePluginSettings({ db_path: join(process.cwd(), 'src', 'x.db') }, {}),
    /invalid_config/,
  );
  assert.throws(
    () => resolvePluginSettings({ db_path: join(process.cwd(), '.git', 'x.db') }, {}),
    /invalid_config/,
  );
  const projectDir = join(process.cwd(), 'tmp', 'proj');
  const allowed = resolvePluginSettings({ db_path: join(projectDir, '.sdo', 'sdo.db'), project_dir: projectDir }, {});
  assert.equal(allowed.dbPath, join(projectDir, '.sdo', 'sdo.db'));
});

test('sdo_status 补 tool_call 日志（P2-2）', async () => {
  const fixture = makeDb();
  try {
    const runtime = new PluginRuntime(resolvePluginSettings({ db_path: fixture.dbPath, project_dir: fixture.dir }, envFor()));
    const lines: PluginLogLine[] = [];
    (runtime as unknown as { log: (line: PluginLogLine) => void }).log = (line) => lines.push(line);
    const status = buildTools(runtime).find((tool) => tool.name === 'sdo_status');
    assert.ok(status);
    const result = await status.execute({}, { callId: 'status-1' });
    assert.equal((result as { ok: boolean }).ok, true);
    const call = lines.find((line) => line.event === 'tool_call');
    assert.ok(call);
    assert.equal(call['tool'], 'sdo_status');
    assert.equal(call.request_id, 'status-1');
    assert.equal(typeof call.elapsed_ms, 'number');
    runtime.dispose();
  } finally {
    fixture.close();
  }
});

test('静态：tools.ts 不含 db.exec/db.prepare 等 raw SQL 旁路（P3-1）', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'plugin', 'tools.ts'), 'utf8');
  assert.equal(/\bdb\.(?:exec|prepare|pragma|run)\s*\(/.test(source), false);
  assert.equal(/\b(?:exec|prepare)\s*\(/.test(source), false);
  assert.match(source, /append\(/);
  assert.match(source, /query\(/);
});
