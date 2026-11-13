import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const UI_DIR = new URL('../../../src/ui/', import.meta.url);

interface UiSource {
  readonly name: string;
  readonly source: string;
}

async function uiSources(): Promise<UiSource[]> {
  const dir = fileURLToPath(UI_DIR);
  const names = (await readdir(dir)).filter((name) => name.endsWith('.ts'));
  assert.ok(names.length >= 3, `src/ui 应有多个模块，实际 ${names.length}`);
  return Promise.all(
    names.map(async (name) => ({
      name,
      source: await readFile(new URL(name, UI_DIR), 'utf8'),
    })),
  );
}

const WRITE_SQL = /\b(?:INSERT|UPDATE|DELETE|REPLACE|ATTACH|DETACH|PRAGMA|CREATE|DROP|ALTER)\b/i;
const WRITE_API = /\.prepare\s*\(|\.exec\s*\(|\.pragma\s*\(|\.transaction\s*\(/;
const MIGRATE_API = /runMigrations\s*\(|applyMigrations?\s*\(/;
const HOST_IMPORT = /from\s+'(?!node:|\.)/;

test('C3：src/ui 静态扫描——无写 SQL、无写/迁移 API（控制台只读）', async () => {
  for (const { name, source } of await uiSources()) {
    assert.doesNotMatch(source, WRITE_SQL, `${name} 含写库 SQL 关键词`);
    assert.doesNotMatch(source, WRITE_API, `${name} 含写/执行 SQL 的驱动调用`);
    assert.doesNotMatch(source, MIGRATE_API, `${name} 不应触发迁移（只读面）`);
  }
});

test('C3：src/ui 不自己 prepare SQL——数据必须经 src/query 的 query(view,args)', async () => {
  const sources = await uiSources();
  const pages = sources.find((entry) => entry.name === 'pages.js' || entry.name === 'pages.ts');
  assert.ok(pages, '应存在 pages.ts');
  assert.match(pages.source, /from '\.\.\/query\/index\.js'/, 'pages 必须经 query 模块取数');
  assert.match(pages.source, /\bquery\s*\(/, 'pages 必须调用 query()');
});

test('C4：src/ui 只 import node: 内置模块与仓库内相对路径（不依赖宿主）', async () => {
  for (const { name, source } of await uiSources()) {
    assert.doesNotMatch(source, HOST_IMPORT, `${name} 不应 import 宿主/第三方包`);
  }
});
