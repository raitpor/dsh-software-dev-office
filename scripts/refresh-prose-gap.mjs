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
 * **`DEF-179`（`--write` 的两条产物契约，`test/m224.test.ts` 守）**：
 *   ① **产物必须可编译**：表尾闭合括号只由原文沿用（修前 `formatTable` 自带 `  }`，调用方又接
 *      `source.slice(end + 1)`（以 `  }` 开头）⇒ 产物 `  }  }` 多一个括号，`tsc` 直接 `TS1005`）；
 *   ② **表内历史注释逐字保留**：重排整表只动数据行，作者写在表里的登记说明（如 `TASK-163` 那条）
 *      必须原样搬回 —— 修前只输出它认识的行，注释被静默丢弃。
 *   写盘前 `assertWritable` 会当场自证这两条（花括号净数 / 回读登记 / 注释逐字），坏产物写不出去。
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

/** 表尾闭合括号（**带**前导换行；表之外的同形 `  }` 不在 `indexOf` 的搜索起点之前出现，见 `readRegistered`）。 */
const CLOSE = '\n  }'

/**
 * 表体内的**历史注释**行（`//` 开头）—— 作者在表内写的登记说明（如 `TASK-163` 那条）不是数据，
 * 但它们**必须逐字活着**：重排整表只许动数据行，不许把说明静默吃掉（`DEF-179` ②）。
 */
export function tableComments(body) {
  return body.split('\n').filter((line) => line.trimStart().startsWith('//'))
}

/** 从 `m189.test.ts` 里读**现有**登记表（只认本文件的字面量，不执行它）。 */
export function readRegistered(source = readFileSync(M189, 'utf8')) {
  const start = source.indexOf(HEAD)
  if (start === -1) throw new Error('test/m189.test.ts 里找不到 KNOWN_PROSE_GAP 表头')
  // 表以**缩进 2 的** `  }` 收尾（写成 `\n}` 会匹配到后面别的对象，把断言一起吞掉）
  const end = source.indexOf(CLOSE, start)
  if (end === -1) throw new Error('KNOWN_PROSE_GAP 表没有结束括号')
  const body = source.slice(start + HEAD.length, end)
  const registered = {}
  for (const match of body.matchAll(/'([^']+)':\s*(\d+)/gu)) registered[match[1]] = Number(match[2])
  return { registered, start, end, body, source }
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

/**
 * 渲染**表头 + 历史注释 + 数据行** —— **不含**表尾闭合括号。
 *
 * `DEF-179` ① 的病根就在这一行：修前它返回 `` `${HEAD}\n${rows}\n  }` ``（自带 `  }`），而调用方又接上
 * `source.slice(end + 1)`（`end` 指向闭合行的换行符 ⇒ 切片**以 `  }` 开头**）⇒ 产物里出现 `  }  }`，
 * 多写的一个闭合括号让整份 `test/m189.test.ts` 直接 `TS1005`。现在表尾只由 `rewriteSource` 沿用原文。
 */
export function formatTable(gap, comments = []) {
  const keys = Object.keys(gap).sort()
  const lines = []
  for (let index = 0; index < keys.length; index += 4) {
    lines.push('  ' + keys.slice(index, index + 4).map((key) => `'${key}': ${gap[key]}`).join(', ') + ',')
  }
  return [HEAD, ...comments, ...lines].join('\n')
}

/** 把现算出的 `gap` 写回 `source`：**只替换表体**，表尾闭合括号与表外代码原样沿用（`DEF-179` ① 的修法）。 */
export function rewriteSource(source, gap) {
  const { start, end, body } = readRegistered(source)
  return `${source.slice(0, start)}${formatTable(gap, tableComments(body))}${source.slice(end)}`
}

/**
 * **写盘前的产物自证**（`DEF-179`）：坏产物宁可写前就炸，也不要等人撞到编译错、或等注释丢了才发现。
 *   ① 花括号净数必须与原文一致 —— 多写/漏写一个 `}` 就是 `TS1005`，这一条当场抓；
 *   ② 产物回读出来的登记必须**恰好等于**现算结果；
 *   ③ 表内历史注释必须**逐字**相等（顺序与文字都不许变）。
 */
function assertWritable(source, next, body, gap) {
  const balance = (text) => {
    let net = 0
    for (const ch of text) {
      if (ch === '{') net += 1
      else if (ch === '}') net -= 1
    }
    return net
  }
  if (balance(next) !== balance(source)) {
    throw new Error(`产物花括号净数 ${balance(next)} ≠ 原文 ${balance(source)}：表体/表尾拼装多写或漏写了一个括号（DEF-179 ①）`)
  }
  const sorted = (record) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)))
  const reparsed = readRegistered(next)
  if (JSON.stringify(sorted(reparsed.registered)) !== JSON.stringify(sorted(gap))) {
    throw new Error('产物回读的登记与现算不等：表体结构被改坏（DEF-179 ①）')
  }
  if (JSON.stringify(tableComments(reparsed.body)) !== JSON.stringify(tableComments(body))) {
    throw new Error('产物丢了表内历史注释：重排整表必须**逐字**保留它们（DEF-179 ②）')
  }
}

function main() {
  const write = process.argv.includes('--write')
  const { gap, files, sites } = computeGap()
  const { registered, body, source } = readRegistered()
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
  const next = rewriteSource(source, gap)
  assertWritable(source, next, body, gap)
  writeFileSync(M189, next, 'utf8')
  console.log('✓ 已重写 `test/m189.test.ts` 的 KNOWN_PROSE_GAP（明细见上）')
  return 0
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main()
}
