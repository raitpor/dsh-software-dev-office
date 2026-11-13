/**
 * C7 自动化守卫：`src/align/` 只编排，不自行写库；所有写入必须走 `src/db/write.ts` 的 `append()`。
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ALIGN_DIR = join(process.cwd(), 'src', 'align');

function alignSources(): string[] {
  return readdirSync(ALIGN_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(ALIGN_DIR, name));
}

test('C7：src/align/**/*.ts 不出现写 SQL 关键词（INSERT/UPDATE/DELETE）', () => {
  const offenders: string[] = [];
  for (const file of alignSources()) {
    const source = readFileSync(file, 'utf8');
    if (/\b(?:INSERT|UPDATE|DELETE)\b/i.test(source)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

test('C7：src/align/ 的写入只经 write.ts 的 append()', () => {
  const callers = alignSources().filter((file) => /\bappend\s*\(\s*db\b/.test(readFileSync(file, 'utf8')));
  assert.ok(callers.length > 0, '至少 restatement.ts/diff.ts 会调用 append()');
  for (const file of callers) {
    assert.match(
      readFileSync(file, 'utf8'),
      /from '\.\.\/db\/write\.js'/,
      `${file} 调了 append() 就必须从 ../db/write.js 引入`,
    );
  }
});
