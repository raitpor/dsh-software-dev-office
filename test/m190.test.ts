/**
 * **增量 190：第九批 §0 / 第十批 §0 的机械要求（《豁免面清单》）—— 逐份报告的结构守卫。**
 *
 * §0 写的是："**没有这张表 ⇒ 该项不算交付**"，落点是"表格本身进报告，并由**一格结构守卫**钉住
 * （表在、条目数 ≥ 你声明的数、每条都有变异读数）"。本文件就是那一格（**两份报告都判**）：
 *   · 每项都要有《豁免面清单》表（表头含"故意不抓"与"对应的变异"）；
 *   · 行数 ≥ 本文件声明的数；
 *   · **每行末列含"红"**（变异读数）且**引用一个真实存在的用例 id**（第十批 `DEF-094`：
 *     现算 `test/*.test.ts` 的 id 面 ⇒ "水表"与 `M999-99` 当场红）；
 *   · 表里不许留空缺口；
 *   · `DEF-090` 的**判据表**每行理由点名真键"字面前缀段数"；
 *   · 每份报告的 §3 现算缺陷号数 = §0 声明的那个数（`7 = 7 + 0` / `12 = 7 + 5`）。
 *
 * 判据只读报告文本 + 结构（表格形态、标识符存在性），不读措辞 ⇒ 与语言无关。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const plan = (name: string): string => join(ROOT, 'docs', 'plan', name)

interface DocSpec {
  label: string
  path: string
  /** **我声明的**最小行数（§0 的"条目数 ≥ 你声明的数"）：每加一条豁免面就必须同时改这里。 */
  min: Record<string, number>
  /** §3 现算应当恰好等于的缺陷号（`7 = 7 + 0` / `12 = 7 + 5`）。 */
  sectionIds: string[]
  summaryMin: number
  /** 是否要判 `DEF-090` 的判据表（只有第九批有）。 */
  judgeTable?: boolean
}

const DOCS: DocSpec[] = [
  {
    label: '第九批',
    path: plan('2026-10-16-交接-给创造模式会话-第九批.md'),
    min: { 'DEF-089': 2, 'DEF-085': 2, 'DEF-090': 4, 'DEF-091': 3, 'DEF-092': 3, 'DEF-093': 5, 'DEF-087': 3, R20: 3, M190: 3 },
    sectionIds: ['DEF-085', 'DEF-087', 'DEF-089', 'DEF-090', 'DEF-091', 'DEF-092', 'DEF-093'],
    summaryMin: 8,
    judgeTable: true,
  },
  {
    label: '第十批',
    path: plan('2026-10-16-交接-给创造模式会话-第十批.md'),
    min: { 'DEF-096': 3, 'DEF-095': 2, 'DEF-098': 4, 'DEF-094': 3, 'DEF-093': 3, 'DEF-087': 2, 'DEF-097': 3, R21: 3, M190: 3 },
    sectionIds: ['DEF-085', 'DEF-087', 'DEF-089', 'DEF-090', 'DEF-091', 'DEF-092', 'DEF-093', 'DEF-094', 'DEF-095', 'DEF-096', 'DEF-097', 'DEF-098'],
    summaryMin: 8,
  },
]

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

/** 目录下全部 `.ts`。 */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkTs(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out.sort()
}

/**
 * **仓内真实存在的用例 id**（从 `test/*.test.ts` 的用例名里现算）。
 * `DEF-094`（第十批 §3.4）：《豁免面清单》每行末列**必须引用一个真实存在的用例 id** ——
 * 这不是"措辞判据"而是**标识符存在性**判据（与语言无关）："水表"（末列只写 `红`/`x`）当场必红。
 */
function existingTestIds(): Set<string> {
  const ids = new Set<string>()
  for (const file of walkTs(join(ROOT, 'test'))) {
    if (!file.endsWith('.test.ts')) continue
    for (const match of readFileSync(file, 'utf8').matchAll(/test\('(M\d{2,}-\d{2})\b/gu)) ids.add(match[1] as string)
  }
  return ids
}

/** 报告里引用的用例 id（`M123-45` 形态）。 */
const citedIds = (cell: string): string[] => [...new Set([...cell.matchAll(/\bM\d{2,}-\d{2}\b/gu)].map((match) => match[0]))]

/** 该报告的 §8 交付节里、`item` 对应的那一节。 */
const sectionOf = (all: readonly Section[], item: string): Section | undefined =>
  all.find((entry) => /^8\./u.test(entry.title) && entry.title.includes(item))

test('M190-01 §0 机械要求：《豁免面清单》逐项在、行数 ≥ 声明数、每行都有变异读数**且引用真实用例 id**', () => {
  const ids = existingTestIds()
  assert.ok(ids.size >= 100, `用例 id 面必须够宽（现算 ${ids.size} 个）`)
  for (const spec of DOCS) {
    const all = sections(readFileSync(spec.path, 'utf8'))
    for (const [item, min] of Object.entries(spec.min)) {
      const section = sectionOf(all, item)
      assert.ok(section !== undefined, `${spec.label} 缺 ${item} 的 §8 交付节（§0：没有这张表 ⇒ 该项不算交付）`)
      const table = tables((section as Section).body).find((entry) =>
        entry.header.join(' ').includes('故意不抓') && entry.header.join(' ').includes('变异'))
      assert.ok(table !== undefined, `${spec.label} 的 ${item} 缺《豁免面清单》表（表头必须含"故意不抓"与"对应的变异"）`)
      const rows = (table as Table).rows
      assert.ok(
        rows.length >= min,
        `${spec.label} 的 ${item}《豁免面清单》只有 ${rows.length} 行，少于声明的 ${min} 行（加/删行必须同时改本文件）`,
      )
      for (const row of rows) {
        const last = row[row.length - 1] ?? ''
        assert.ok(last.includes('红'), `${spec.label}/${item} 有一行**没有变异读数**（末列必须含"红"）：${row.join(' | ').slice(0, 140)}`)
        assert.equal(
          /未做|待补|TODO|本轮未做/u.test(row.join(' ')),
          false,
          `${spec.label}/${item} 的表里还留着空缺口 ⇒ 按 §0 该项不算交付：${row.join(' | ').slice(0, 140)}`,
        )
        // **`DEF-094`**：末列必须引用**真实存在**的用例 id（"水表"写 `x`/只写"红" ⇒ 必红）
        const cited = citedIds(last)
        assert.ok(cited.length >= 1, `${spec.label}/${item} 有一行末列**没有引用用例 id**（水表）：${last.slice(0, 140)}`)
        for (const id of cited) {
          assert.ok(ids.has(id), `${spec.label}/${item} 的末列引用了**不存在的用例 id** \`${id}\`：${last.slice(0, 140)}`)
        }
      }
    }
  }
})

test('M190-02 §3.3（DEF-090）DoD ①：判据表每一行的理由都点名**真实分档键**「字面前缀段数」', () => {
  for (const spec of DOCS.filter((entry) => entry.judgeTable === true)) {
    const section = sectionOf(sections(readFileSync(spec.path, 'utf8')), 'DEF-090')
    assert.ok(section !== undefined, `${spec.label} 缺 DEF-090 那一节`)
    const judge = tables((section as Section).body).find((entry) =>
      entry.header.includes('字面前缀段数') && entry.header.includes('期望档'))
    assert.ok(judge !== undefined, `${spec.label} 的 DEF-090 缺判据表（表头必须含"字面前缀段数"与"期望档"）`)
    const rows = (judge as Table).rows
    assert.ok(rows.length >= 15, `${spec.label} 判据表必须逐档覆盖（≥15 行），实际 ${rows.length} 行`)
    for (const row of rows) {
      assert.ok(row.join(' ').includes('字面前缀段数'), `判据表每一行的理由都必须点名真键：${row.join(' | ').slice(0, 140)}`)
    }
  }
})

test('M190-03 §0 的可机械核对项：汇总表够行 + §3 点名的缺陷号现算 = 声明的那个数', () => {
  for (const spec of DOCS) {
    const text = readFileSync(spec.path, 'utf8')
    const summary = sections(text).find((entry) => entry.title.includes('汇总'))
    assert.ok(summary !== undefined, `${spec.label} 缺 §8.1 汇总表`)
    const summaryTable = tables((summary as Section).body).find((entry) => entry.header.join(' ').includes('钉红读数'))
    assert.ok(summaryTable !== undefined, `${spec.label} 汇总表必须含"钉红读数"列`)
    assert.ok(
      (summaryTable as Table).rows.length >= spec.summaryMin,
      `${spec.label} 汇总表必须 ≥ ${spec.summaryMin} 行，实际 ${(summaryTable as Table).rows.length} 行`,
    )
    for (const item of Object.keys(spec.min)) {
      assert.ok(text.includes(item), `${spec.label} 报告里必须点名 ${item}`)
    }
    // `§3` 正文里出现的 `DEF-###` 现算：必须恰好是声明的那几个（`7 = 7 + 0` / `12 = 7 + 5`）
    const from = text.indexOf('## 3. 要修什么')
    const to = text.indexOf('## 4. 红线')
    assert.ok(from > 0 && to > from, `${spec.label} 缺 §3/§4 两个标题（现算缺陷号要用它们切段）`)
    const ids = [...new Set([...text.slice(from, to).matchAll(/\bDEF-\d{3,}/gu)].map((match) => match[0]))].sort()
    assert.deepEqual(ids, [...spec.sectionIds].sort(), `${spec.label} §3 现算的缺陷号必须恰好是声明的那些：${ids.join(', ')}`)
  }
})
