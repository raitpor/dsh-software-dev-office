#!/usr/bin/env node
// 把 test/spike/*.mjs 复制到 lib/spike-test/，让 `node --test lib/spike-test/` 能跑
// （tsconfig 只编译 .ts，spike 测试是零依赖 .mjs，不经过 tsc）。
//
// 刻意不放进 lib/test/：产品 `npm test` 跑的是 lib/test/，spike 是独立泳道，不能混进去
// 改变产品测试条数。顺带清掉早期版本留下的 lib/test/spike/ 副本。
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const from = join(root, 'test', 'spike');
const to = join(root, 'lib', 'spike-test');
rmSync(join(root, 'lib', 'test', 'spike'), { recursive: true, force: true }); // 旧路径残留清理

rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });
const files = readdirSync(from).filter((entry) => entry.endsWith('.test.mjs') || entry === '_root.mjs');
for (const file of files) cpSync(join(from, file), join(to, file));
console.log(`spike tests: copied ${files.length} file(s) -> ${relative(root, to)}`);
