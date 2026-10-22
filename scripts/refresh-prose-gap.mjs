#!/usr/bin/env node
/**
 * **`§4.3`（第十三批）读散文棘轮零摩擦化：`--update-snapshot` 式重生成 `KNOWN_PROSE_GAP`。**
 *
 * 病根（`DEF-093` 同族）：`test/m189.test.ts` 用**逐文件精确条数**登记"断言里的中文串"⇒ 谁加一条带中文
 * 报文的断言，就要回来手工改数字（本批 `TASK-154` 就因此把 `m38: 49 → 61`，改错一次就红一次）。
 *
 * 这个脚本做一件事：**从现算生成登记表，并打印新增/删除明细**（明细可见，才不是"静默漂移"）。
 *
 *   ① `node scripts/refresh-prose-gap.mjs`        ⇒ 只检查（不写盘）：不同步则 exit 1 并打印 `+`/`-`
 *   ② `node scripts/refresh-prose-gap.mjs --write` ⇒ 重写 `test/m189.test.ts` 里的表
 *
 * **口径不变**：表仍然要求"登记与现算**恰好相等**"（`M189-13` 的 `deepEqual` 不动）；本脚本只是把
 * "手工数数"换成"现算 + 打印差集"，不放松任何判定。
 *
 * 依赖已编译的 `lib/test/proseInventory.js`（与测试同一份抽取逻辑 —— 不许另写一套）。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifySite, extractProseSites, loadLangPack } from '../lib/test/proseInventory.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url)).replace(/[\\/]+$/u, '')  // DEF-155：win32 上 ROOT 以 `\\` 结尾
const M189 = join(ROOT, 'test', 'm189.test.ts')
const HEAD = 'const KNOWN_PROSE_GAP: Record<string, number> = {'

/** `test/**\/*.test.ts` 的现盘清单（与 `M189-13` 同一面）。 */
function testFiles(dir = join(ROOT, 'test')) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return testFiles(path)
      return entry.name.endsWith('.test.ts') ? [path] : []
    })
    .sort()
}

export function computeGap() {
  const pack = loadLangPack(ROOT)
  const docs = testFiles().map((path) => ({ path, text: readFileSync(path, 'utf8') }))
  const sites = extractProseSites(docs)
  const gap = {}
  for (const site of sites) {
    // **DEF-155**：两边都折成正斜杠再剥仓库根 —— win32 上 ROOT 与文件路径都是 `\\`，
    // 旧的 `` `${ROOT}/` `` 前缀永远不匹配，键就退化成绝对路径（棘轮比对必然不等）。
    const posix = (value) => value.replace(/\\/gu, '/')
    const relative = posix(site.path).replace(`${posix(ROOT)}/`, '')
    const verdict = classifySite(site, pack)
    if (verdict.cls !== 'prose') continue
    gap[relative] = (gap[relative] ?? 0) + 1
  }
  return { gap, files: docs.length, sites: sites.length }
}

/** 从 `m189.test.ts` 里读**现有**登记表（只认本文件的字面量，不执行它）。 */
export function readRegistered(source = readFileSync(M189, 'utf8')) {
  const start = source.indexOf(HEAD)
  if (start === -1) throw new Error('test/m189.test.ts 里找不到 KNOWN_PROSE_GAP 表头')
  // 表以**缩进 2 的** `  }` 收尾（写成 `\n}` 会匹配到后面别的对象，把断言一起吞掉）
  const end = source.indexOf('\n  }', start)
  if (end === -1) throw new Error('KNOWN_PROSE_GAP 表没有结束括号')
  const body = source.slice(start + HEAD.length, end)
  const registered = {}
  for (const match of body.matchAll(/'([^']+)':\s*(\d+)/gu)) registered[match[1]] = Number(match[2])
  return { registered, start, end, source }
}

function delta(registered, actual) {
  const added = []
  const removed = []
  const changed = []
  for (const [file, count] of Object.entries(actual)) {
    if (!(file in registered)) added.push(`${file}: ${count}`)
    else if (registered[file] !== count) changed.push(`${file}: ${registered[file]} → ${count}`)
  }
  for (const file of Object.keys(registered)) if (!(file in actual)) removed.push(file)
  return { added, removed, changed }
}

function formatTable(gap) {
  const keys = Object.keys(gap).sort()
  const lines = []
  for (let index = 0; index < keys.length; index += 4) {
    lines.push('  ' + keys.slice(index, index + 4).map((key) => `'${key}': ${gap[key]}`).join(', ') + ',')
  }
  return `${HEAD}\n${lines.join('\n')}\n  }`
}

function main() {
  const write = process.argv.includes('--write')
  const { gap, files, sites } = computeGap()
  const { registered, start, end, source } = readRegistered()
  const { added, removed, changed } = delta(registered, gap)
  const total = Object.values(gap).reduce((sum, count) => sum + count, 0)
  const registeredTotal = Object.values(registered).reduce((sum, count) => sum + count, 0)
  console.log(`现算：${sites} 站点 / ${files} 文件；读散文 ${total}（登记 ${registeredTotal}，${Object.keys(gap).length} 个文件）`)
  if (added.length > 0) console.log(`  + 新增：\n    ${added.join('\n    ')}`)
  if (changed.length > 0) console.log(`  ~ 变化：\n    ${changed.join('\n    ')}`)
  if (removed.length > 0) console.log(`  - 删除：\n    ${removed.join('\n    ')}`)
  const inSync = added.length === 0 && removed.length === 0 && changed.length === 0
  if (inSync) {
    console.log('✓ 登记与现算恰好相等（无需写盘）')
    return 0
  }
  if (!write) {
    console.log('✗ 不同步：跑 `node scripts/refresh-prose-gap.mjs --write` 重生成（明细见上）')
    return 1
  }
  const next = `${source.slice(0, start)}${formatTable(gap)}${source.slice(end + 1)}`
  writeFileSync(M189, next, 'utf8')
  console.log('✓ 已重写 `test/m189.test.ts` 的 KNOWN_PROSE_GAP（明细见上）')
  return 0
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main()
}
