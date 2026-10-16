/**
 * **增量 190：第九批 §0 的机械要求（《豁免面清单》）与 §3.3 的判据表 —— 结构守卫。**
 *
 * §0 写的是："**没有这张表 ⇒ 该项不算交付**"，并给了落点："表格本身进报告，并由**一格结构守卫**钉住
 * （表在、条目数 ≥ 你声明的数、每条都有变异读数）"。本文件就是那一格：
 *   · 8 项**每一项**都必须有《豁免面清单》表（表头含"故意不抓"与"对应的变异"）；
 *   · 行数 ≥ 本文件声明的最小值；
 *   · **每行末列必须含"红"**（变异读数），且表里不许留"未做 / 待补 / TODO"；
 *   · `DEF-090` 的**判据表**每一行的理由都必须点名真实分档键"字面前缀段数"（§3.3 DoD ①）。
 * 判据只读报告文本 + 结构（表格形态），不看措辞 ⇒ 与语言无关。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const DOC = join(ROOT, 'docs', 'plan', '2026-10-16-交接-给创造模式会话-第九批.md')

/** **我声明的**最小行数（§0 的"条目数 ≥ 你声明的数"）：每加一条豁免面就必须同时改这里。 */
const EXEMPTION_MIN: Record<string, number> = {
  'DEF-089': 2, 'DEF-085': 2, 'DEF-090': 4, 'DEF-091': 3, 'DEF-092': 3, 'DEF-093': 5, 'DEF-087': 3, R20: 3, M190: 3,
}

interface Section { title: string; body: string[] }
interface Table { header: string[]; rows: string[][] }

const cells = (line: string): string[] =>
  line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim())

const isTableLine = (line: string): boolean => line.trim().startsWith('|') && line.trim().endsWith('|')
const isSeparator = (line: string): boolean => /^\|[\s:|-]+\|$/u.test(line.trim())

/** 按 `### ` 切节（节标题 + 节内行）。 */
function sections(text: string): Section[] {
  const out: Section[] = []
  let current: Section | undefined
  for (const line of text.split('\n')) {
    if (line.startsWith('### ')) {
      current = { title: line.slice(4).trim(), body: [] }
      out.push(current)
      continue
    }
    if (current !== undefined) current.body.push(line)
  }
  return out
}

/** 节内所有 markdown 表（连续的 `|` 行；跳过分隔行）。 */
function tables(lines: readonly string[]): Table[] {
  const out: Table[] = []
  let block: string[][] = []
  const flush = (): void => {
    if (block.length >= 2) out.push({ header: block[0] as string[], rows: block.slice(1) })
    block = []
  }
  for (const line of lines) {
    if (isTableLine(line)) {
      if (!isSeparator(line)) block.push(cells(line))
      continue
    }
    flush()
  }
  flush()
  return out
}

const doc = (): string => readFileSync(DOC, 'utf8')

test('M190-01 §0 机械要求：《豁免面清单》8 项全在、行数 ≥ 声明数、**每行都有变异读数**', () => {
  const all = sections(doc())
  for (const [item, min] of Object.entries(EXEMPTION_MIN)) {
    // ⚠️ 只认 **§8 的交付节**（`### 8.x`）：§3 的任务书小节里也有同一批编号（那份是"要修什么"，没有表）
    const section = all.find((entry) => /^8\./u.test(entry.title) && entry.title.includes(item))
    assert.ok(section !== undefined, `报告缺 ${item} 的 §8 交付节（§0：没有这张表 ⇒ 该项不算交付）`)
    const table = tables((section as Section).body).find((entry) =>
      entry.header.join(' ').includes('故意不抓') && entry.header.join(' ').includes('变异'))
    assert.ok(table !== undefined, `${item} 缺《豁免面清单》表（表头必须含"故意不抓"与"对应的变异"）`)
    const rows = (table as Table).rows
    assert.ok(
      rows.length >= min,
      `${item} 的《豁免面清单》只有 ${rows.length} 行，少于声明的 ${min} 行（加/删行必须同时改本文件的最小值）`,
    )
    for (const row of rows) {
      const last = row[row.length - 1] ?? ''
      assert.ok(last.includes('红'), `${item} 有一行**没有变异读数**（末列必须含"红"）：${row.join(' | ').slice(0, 140)}`)
      assert.equal(
        /未做|待补|TODO|本轮未做/u.test(row.join(' ')),
        false,
        `${item} 的表里还留着"未做/待补"的行 ⇒ 按 §0 该项不算交付：${row.join(' | ').slice(0, 140)}`,
      )
    }
  }
})

test('M190-02 §3.3（DEF-090）DoD ①：判据表每一行的理由都点名**真实分档键**「字面前缀段数」', () => {
  const section = sections(doc()).find((entry) => /^8\./u.test(entry.title) && entry.title.includes('DEF-090'))
  assert.ok(section !== undefined, '报告缺 DEF-090 那一节')
  const judge = tables((section as Section).body).find((entry) =>
    entry.header.includes('字面前缀段数') && entry.header.includes('期望档'))
  assert.ok(judge !== undefined, 'DEF-090 缺判据表（表头必须含"字面前缀段数"与"期望档"）')
  const rows = (judge as Table).rows
  assert.ok(rows.length >= 15, `判据表必须逐档覆盖（≥15 行），实际 ${rows.length} 行`)
  for (const row of rows) {
    assert.ok(row.join(' ').includes('字面前缀段数'), `判据表每一行的理由都必须点名真键：${row.join(' | ').slice(0, 140)}`)
  }
})

test('M190-03 §0 的可机械核对项：汇总表 8 行 + §3 点名的缺陷号现算 = 7（`7 = 7 + 0`）', () => {
  const text = doc()
  const summary = sections(text).find((entry) => entry.title.includes('汇总'))
  assert.ok(summary !== undefined, '报告缺 §8.1 汇总表')
  const summaryTable = tables((summary as Section).body).find((entry) => entry.header.join(' ').includes('钉红读数'))
  assert.ok(summaryTable !== undefined, '汇总表必须含"钉红读数"列')
  assert.ok((summaryTable as Table).rows.length >= 8, `汇总表必须 ≥ 8 行（8 项），实际 ${(summaryTable as Table).rows.length} 行`)
  for (const item of Object.keys(EXEMPTION_MIN)) {
    assert.ok(text.includes(item), `汇总表/报告里必须点名 ${item}`)
  }
  // `§3` 正文里出现的 `DEF-###` 现算：必须恰好是这 7 条（§0 的 `7 = 7 + 0`）—— 多一个就是误写，少一个是漏项
  const head = text.slice(text.indexOf('## 3. 要修什么'), text.indexOf('## 4. 红线'))
  const ids = [...new Set([...head.matchAll(/\bDEF-\d{3,}/gu)].map((match) => match[0]))].sort()
  const expected = ['DEF-085', 'DEF-087', 'DEF-089', 'DEF-090', 'DEF-091', 'DEF-092', 'DEF-093']
  assert.deepEqual(ids, expected, `§3 现算的缺陷号必须恰好是这 7 条（7 = 7 + 0）：${ids.join(', ')}`)
})
