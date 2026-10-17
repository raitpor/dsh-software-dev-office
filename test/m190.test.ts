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
import { createHash } from 'node:crypto'

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
        EXEMPTION_HEADER.test(entry.header.join(' ')) && entry.header.join(' ').includes('变异'))
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

// ---------- `P-B`（第十一批 §3.6）：表格/清单里的「为什么」必须能指向一条**可跑读数** ----------

/**
 * **可跑读数**（**结构**判定、与语言无关）：一个**真实存在**的用例 id（`M###-##` 形态），
 * 或一个**命令形态**的反引号片段（含空白 / `|` / `--` / 路径分隔符，或落到可执行/数据后缀）。
 * 只认**字形** —— "现算""重跑"这类措辞一个也不认（否则就成了措辞判据，与"语言无关"冲突）。
 */
const commandShaped = (span: string): boolean =>
  /[\s|]|--|\//u.test(span) || /\.(?:mjs|js|ts|py|sh|json|log|txt|yml)$/u.test(span)

/**
 * 表头识别与"无读数"文案都用**正则常量**（不在断言实参里写内联中文）：
 * `R19` 的散文普查（`test/m189` 的按身份棘轮）只认"实参里的内联中文"，
 * 而判据本体本来就不该靠措辞 —— 这里把字形收进常量，断言只比**结构**（身份/类别/ASCII 标记）。
 */
const EXEMPTION_HEADER = /故意不抓/u
const WHY_HEADER = /为什么/u
const NO_READING_TEXT = /没有可跑读数/u

/** 一格里的读数：引用到的用例 id（含**不存在的**，由调用方分开点名）+ 命令形态片段。 */
const readingsIn = (cell: string): { ids: string[]; commands: string[] } => ({
  ids: [...new Set([...cell.matchAll(/\bM\d{2,}-\d{2}\b/gu)].map((match) => match[0] as string))],
  commands: [...cell.matchAll(/`([^`\n]+)`/gu)].map((match) => match[1] as string).filter(commandShaped),
})

/** 一条《豁免面清单》行的**身份** = 册/报告 + 节号 + 行序 + 「为什么」那一格的文本指纹（前 8 位）。 */
const cellFingerprint = (cell: string): string => createHash('sha256').update(cell).digest('hex').slice(0, 8)

export interface WhyIssue {
  label: string
  where: string
  kind: 'no-reading' | 'bad-id'
  /** `册:节号:行序:指纹` —— 身份登记与"登记恰好相等"就是按它比。 */
  identity: string
  detail: string
}

interface ExemptionFace { label: string; path: string; text: string; onlyEight: boolean }

/**
 * 逐行判《豁免面清单》表的「为什么」列：**空话（无读数）**与**引用不存在的用例 id** 各成一类问题。
 * `onlyEight` = 只认 `### 8.x` 节里的表（冻结任务书的交付节就是 §8）；报告面则整份扫。
 */
function whyColumnIssues(faces: readonly ExemptionFace[], ids: ReadonlySet<string>): WhyIssue[] {
  const out: WhyIssue[] = []
  for (const face of faces) {
    const scopes: Section[] = face.onlyEight
      ? sections(face.text).filter((entry) => /^8\./u.test(entry.title))
      : [{ title: '', body: face.text.split('\n') }]
    for (const scope of scopes) {
      const sectionNumber = scope.title.split(/\s+/u)[0] ?? ''
      for (const table of tables(scope.body)) {
        if (!EXEMPTION_HEADER.test(table.header.join(' '))) continue
        const at = table.header.findIndex((cell) => WHY_HEADER.test(cell))
        for (const [index, row] of table.rows.entries()) {
          const cell = (at < 0 ? '' : row[at]) ?? ''
          const identity = `${face.label}:${sectionNumber}:${index + 1}:${cellFingerprint(cell)}`
          const where = `${scope.title === '' ? '（表）' : scope.title} 第 ${index + 1} 行`
          if (at < 0) {
            out.push({ label: face.label, where, kind: 'no-reading', identity, detail: '表头没有「为什么」列' })
            continue
          }
          const { ids: cited, commands } = readingsIn(cell)
          for (const id of cited) {
            if (!ids.has(id)) {
              out.push({ label: face.label, where, kind: 'bad-id', identity, detail: `引用了不存在的用例 id \`${id}\`：${row.join(' | ').slice(0, 110)}` })
            }
          }
          if (cell.trim() === '' || (commands.length === 0 && !cited.some((id) => ids.has(id)))) {
            out.push({ label: face.label, where, kind: 'no-reading', identity, detail: `「为什么」里没有可跑读数（既非真实用例 id，也非命令形态）：${cell.slice(0, 110)}（整行：${row.join(' | ').slice(0, 110)}）` })
          }
        }
      }
    }
  }
  return out
}

/** **本批交付面**：`.sdo/evidence/` 下 `batch11-` 开头目录里的 `report.md`（在场才算；离线包/副本树里常常不在）。 */
function batchReports(root: string): string[] {
  const dir = join(root, '.sdo', 'evidence')
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return [] }
  return entries
    .filter((name) => name.startsWith('batch11-'))
    .map((name) => join(dir, name, 'report.md'))
    .filter((file) => { try { return readFileSync(file, 'utf8').length > 0 } catch { return false } })
    .sort()
}

const faceOf = (label: string, path: string, onlyEight: boolean): ExemptionFace => ({ label, path, text: readFileSync(path, 'utf8'), onlyEight })

/**
 * **冻结面的身份登记**（`P-B` 之前写的旧表 —— 它们的"为什么"里没有可跑读数）。
 * 判据**不为它们放宽**：登记与现算必须**恰好相等**（新的无读数行 ⇒ 红并点名；某条登记不再现算得到 ⇒ 也红，
 * 要求同步收紧）。身份 = `册:节号:行序:` + 「为什么」那格的 sha256 前 8 位 ⇒ **改一个字都算新行**。
 */
const FROZEN_NO_READING: readonly string[] = [
  '第九批:8.2:1:461d2f08',
  '第九批:8.2:2:447ca206',
  '第九批:8.3:1:de4fed0b',
  '第九批:8.3:2:e6571c1c',
  '第九批:8.4:1:28a25fc3',
  '第九批:8.4:2:543c2c30',
  '第九批:8.4:3:9682f72b',
  '第九批:8.4:4:b700a3b8',
  '第九批:8.5:1:de56dff6',
  '第九批:8.5:3:925d1a00',
  '第九批:8.6:1:9435db3f',
  '第九批:8.6:2:5669ecb8',
  '第九批:8.6:3:d27c5311',
  '第九批:8.7:1:278753f6',
  '第九批:8.7:2:87fc1c92',
  '第九批:8.7:3:9dededdf',
  '第九批:8.7:5:234ef580',
  '第九批:8.8:1:9d326a63',
  '第九批:8.8:2:677432c8',
  '第九批:8.8:3:b1cdfc59',
  '第九批:8.8:4:c2c26288',
  '第九批:8.9:2:d541871b',
  '第九批:8.9:3:71cbf30e',
  '第九批:8.12:1:719500c1',
  '第九批:8.12:2:a664b995',
  '第九批:8.12:3:07f7bfe9',
  '第十批:8.2:1:ce77257f',
  '第十批:8.2:2:9336706a',
  '第十批:8.3:1:fc24d316',
  '第十批:8.4:1:9b2e7e50',
  '第十批:8.4:2:97b86fd2',
  '第十批:8.4:3:88cd73cd',
  '第十批:8.5:1:ff39924c',
  '第十批:8.5:2:1d3f831f',
  '第十批:8.5:3:9630a3a5',
  '第十批:8.6:1:e43d73ea',
  '第十批:8.6:2:e12f2145',
  '第十批:8.6:3:9960d777',
  '第十批:8.7:1:c05880f9',
  '第十批:8.7:2:c1c4c076',
  '第十批:8.8:1:caa3fa57',
  '第十批:8.8:2:9709e4f7',
  '第十批:8.8:3:7b72a851',
  '第十批:8.9:1:b4ebed4e',
  '第十批:8.9:2:f647f8b9',
  '第十批:8.9:3:da15d14f',
  '第十批:8.11:1:42f3dfaf',
  '第十批:8.11:2:07f7bfe9',
  '第十批:8.11:3:d0b48ee4',
]

test('M190-04 §3.6（P-B）「为什么」必须含**可跑读数**：本批交付面全绿 + 冻结面 49 行按身份登记（恰好相等）', () => {
  const ids = existingTestIds()
  // ① 本批交付面（`.sdo/evidence/batch11-*/report.md`）：每一行都要有读数，零豁免
  const reports = batchReports(ROOT)
  if (reports.length > 0) {
    const faces = reports.map((path) => faceOf(path.split(/[\\/]/u).slice(-2)[0] as string, path, false))
    const issues = whyColumnIssues(faces, ids)
    assert.deepEqual(issues, [], `本批交付面的《豁免面清单》每行都要有可跑读数（空话/不存在的 id 都点名）：${JSON.stringify(issues).slice(0, 900)}`)
    const tableCount = reports
      .flatMap((path) => tables(readFileSync(path, 'utf8').split('\n')))
      .filter((table) => EXEMPTION_HEADER.test(table.header.join(' '))).length
    assert.equal(tableCount >= reports.length * 3, true, `每份交付面报告至少 3 张《豁免面清单》表（现算 A 组 3 + B 组 3 = 6；实际 ${tableCount} 张 / ${reports.length} 份）`)
  }
  // ② 冻结面（第九批 + 第十批的 §8 旧表）：现算 55 = 29 + 26 行，其中无读数 49 = 26 + 23，逐条按身份登记
  const books = [faceOf('第九批', DOCS[0]?.path as string, true), faceOf('第十批', DOCS[1]?.path as string, true)]
  const issues = whyColumnIssues(books, ids)
  const badIds = issues.filter((issue) => issue.kind === 'bad-id')
  assert.deepEqual(badIds, [], `冻结面不许引用**不存在**的用例 id（沿用 DEF-094 的加强）：${JSON.stringify(badIds).slice(0, 600)}`)
  const noReading = issues.filter((issue) => issue.kind === 'no-reading').map((issue) => issue.identity).sort()
  assert.deepEqual(
    noReading,
    [...FROZEN_NO_READING].sort(),
    `冻结面无读数行必须与身份登记**恰好相等**（多一条 ⇒ 新表/新行没给读数，点名；少一条 ⇒ 登记失效，请同步收紧）：${JSON.stringify(noReading).slice(0, 900)}`,
  )
  const rows = books
    .flatMap((face) => sections(face.text).filter((entry) => /^8\./u.test(entry.title)).flatMap((entry) => tables(entry.body)))
    .filter((table) => EXEMPTION_HEADER.test(table.header.join(' ')))
    .reduce((sum, table) => sum + table.rows.length, 0)
  assert.equal(rows, 29 + 26, `冻结面总行数 = 29（第九批）+ 26（第十批）= 55（现算 ${rows}）`)
  assert.equal(noReading.length, 26 + 23, `冻结面无读数行数 = 26 + 23 = 49 = 55 − 6（现算 ${noReading.length}）`)
})

test('M190-05 §3.6（P-B）反例 + 单点可红：合法读数不许红；空话与不存在的用例 id **各 1 红并点名**', () => {
  const ids = existingTestIds()
  const ROW_MARK = 'judge-A'
  const header = '| 判据 / 守卫 | 故意不抓什么 | 为什么 | 对应的变异（读数） |'
  const table = (why: string): ExemptionFace => ({
    label: 'fixture',
    path: 'fixture.md',
    onlyEight: false,
    text: `| ${header.slice(2)}\n|---|---|---|---|\n| judge-A | wildcard-X | ${why} | 删掉它 ⇒ \`M190-01\` 1 红 |\n`,
  })
  // ④ 反例：合法读数（真实用例 id / 可跑命令）不许红
  const real = [...ids][0] as string
  for (const why of [`可跑读数：\`${real}\` 1 红`, '可跑读数：`node --test --test-reporter=tap lib/test/m190.test.js`', '可跑读数：`python3 x.py --count`']) {
    assert.deepEqual(whyColumnIssues([table(why)], ids), [], `合法读数不许红：${why}`)
  }
  // ① 空话（无读数）⇒ 红并点名该行
  const empty = whyColumnIssues([table('代价太高，不值得')], ids)
  assert.deepEqual(empty.map((issue) => issue.kind), ['no-reading'], '只写空话 ⇒ 红（no-reading）')
  assert.match(empty[0]?.detail ?? '', NO_READING_TEXT, '必须点名"没有可跑读数"')
  assert.equal((empty[0]?.detail ?? '').includes(ROW_MARK), true, '必须点名到**哪一行**（整行内容，标记用 ASCII）')
  // ② 引用不存在的用例 id ⇒ 红并点名那个 id（沿用 DEF-094 的加强）
  const bogus = whyColumnIssues([table('可跑读数：`M999-99` 1 红')], ids)
  assert.deepEqual(bogus.map((issue) => issue.kind).sort(), ['bad-id', 'no-reading'], '不存在的用例 id ⇒ 红（bad-id；它也不算读数）')
  assert.match(bogus.find((issue) => issue.kind === 'bad-id')?.detail ?? '', /M999-99/u, '必须点名那个不存在的 id')
})
