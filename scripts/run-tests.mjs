#!/usr/bin/env node
/**
 * 测试入口（跨平台 + 跨 Node 版本的唯一可靠形式）。
 *
 * 为什么不直接写 `node --test lib/test/` 或 `node --test "lib/test/*.test.js"`：
 *   · **目录参数**在 Node 20/22 上行为不一致 —— CI 上实测报
 *     `Cannot find module '…/lib/test'`（它把目录当成入口脚本 ✗）；
 *   · **glob 参数**是 Node **21** 才支持的 ✗，而本仓库 `engines` 声明 `>=20`，
 *     矩阵里就有 node 20 → 引用 glob 会让 20 那一格红 ✗；
 *   · **不加参数**让测试运行器自动发现也不行 ✗：它会把 `test/*.test.ts`（TypeScript 源文件）
 *     也当测试跑 → 实测多出 26 个"测试"、13 个失败 ✗。
 * 因此这里自己列出**编译产物**里的测试文件，显式交给 `node --test`（v18+ 都支持多文件参数 ✓）。
 */
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(root, 'lib', 'test')
const pattern = /\.test\.js$/u

let entries = []
try {
  entries = readdirSync(testDir).filter((name) => pattern.test(name)).sort()
} catch {
  console.error(`[run-tests] ✗ 找不到 ${testDir}：先跑 npm run build`)
  process.exit(1)
}
if (entries.length === 0) {
  console.error(`[run-tests] ✗ ${testDir} 里没有 *.test.js：先跑 npm run build`)
  process.exit(1)
}

const files = entries.map((name) => join('lib', 'test', name))
console.log(`[run-tests] node --test ${files.length} 个文件（${entries[0]} … ${entries[entries.length - 1]}）`)
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
