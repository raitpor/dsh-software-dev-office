/**
 * **增量 250：数字必须带口径（`TASK-263`）—— 把「口径写全」做成可机械检查的那一半。**
 *
 * 立卡背景（同一天三次误判，根因同一个）：同一句话里的数字**没写口径**，于是两个都对而看起来互相矛盾
 * （评审记 `任何×没有` **12** 行 / 实现 `grep` 得 **1** 行 = 不设上限档 vs `gap≤4` 档；
 *  `grep -c dispatch/aborted` = **12 行** / 按 `event.type` 精确计数 = **0**）。
 * 一句话：**数字离了口径就不是读数，只是字符。**
 *
 * 本文件守的是 `scripts/check-number-provenance.mjs`：
 *   M250-01 口径标记的**五面定义表**写死在脚本里（正则 / 路径 / 窗口 / 计数 / 类型轴），且 `helpText`
 *           与 `FACETS` **同源**（文档不另写一份定义）；
 *   M250-02 **双态**：同一段核实文本，带 `口径:` ⇒ 绿；把 `口径:` 抹掉 ⇒ 红并点名那个数字
 *           与它所在的片段（"有口径 ⇒ 绿；抹掉 ⇒ 红"这句验收就是这一格）；
 *   M250-03 **空标记不算读数**：`口径:` 后面跟一句没有可认的面的话 ⇒ 仍然红（`empty-marker`）；
 *   M250-04 **排除面**：标识符 / 哈希 / ISO 日期 / 版本号 / 路径行号**不是读数**（不做全文 linter 的
 *           那一半），并用一条正控证明"排除"不是"扫描器坏了"；
 *   M250-05 四种**读数形态**（量词 / 英文计数词 / 加粗 / 结果位）各命中一次，裸数字不命中；
 *   M250-06 **退出码**：载体带口径 ⇒ exit 0；抹掉 ⇒ exit 1 且输出点名记录身份（真跑进程，不看函数返回值）；
 *   M250-07 **载体缺失** ⇒ exit 0 并明说 `absent`（项目数据不在交付物里，这条检查不该因为"没有台账"而红）；
 *   M250-08 **现盘载体**（存在时）：截止时刻之内的存量**没有一条漏登记**、登记与现算**恰好相等**；
 *           截止之后的新记录只打印读数（**不判红** —— 否则别人的正常核实会把全量顶红，`TASK-263` 明写
 *           "噪音会把守卫自己弄死"）；
 *   M250-09 **登记表本身可被审计**：条数、合计处数（与表头写的数字逐字相等）、id 唯一、每条 `why` 非空、
 *           `n` 是正整数；
 *   M250-10 登记表**不动点**：`readRegistry` 读回再 `renderRegistry` 渲染必须逐字节等于文件里那段
 *           （生成器确定性 + 现盘是新鲜的）；
 *   M250-11 **落点三**：`docs/verification/` 那份说明必须有那一句纪律 + 正反例各一 + 五面表 + 命令；
 *   M250-12 重生成**打印差集**（新增 / 减少 / 变化三类都认得出）—— 静默重生成就是"把守卫关掉"。
 *
 * **两条写作纪律（改本文件前先读）**：
 *   ① **断言消息一律英文、中文只写在断言之外**：本文件不进 `KNOWN_PROSE_GAP`
 *      （`test/m189.test.ts` 不在本卡写范围，改不了那张表），一写内联中文判据就会把读散文棘轮顶红；
 *      同理，中文夹具放在 `const` 里**只在不含 `assert.` 的行上**使用。
 *   ② 判据取值用 `indexOf` / 布尔比较**在断言之外**先算好 —— 非 `assert` 行只认 `includes`/`match` 等
 *      四类读文本调用（`m189` 已登记的豁免面），所以"判据本体"不写在 `assert` 的实参里。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { realLedgerSkip } from './support/real-ledger.js'

/** 编译后本文件落在 `lib/test/`，仓库根是上两级。 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'check-number-provenance.mjs')
const DOC = join(ROOT, 'docs', 'verification', '2026-10-25-数字必须带口径.md')
const CARRIER = join(ROOT, '.sdo', 'reviews', 'verified.yml')
/** 夹具根（本仓惯例：`node_modules/.sdo-test/<mNNN>`，整轮跑完不留在树上）。 */
const FIXTURE = join(ROOT, 'node_modules', '.sdo-test', 'm250')

interface RegistryEntry { id: string; n: number; why: string }
interface ReadingRow {
  id: string
  at: string
  token: string
  shapes: string[]
  covered: boolean
  reason: string
  segment: string
  facets?: string[]
}
interface ScanRow { id: string; at: string; evidence: string }
interface ScanResult {
  records: number
  readings: ReadingRow[]
  unmarked: ReadingRow[]
  perRecord: Map<string, number>
  newest: string
}
interface Report {
  carrier?: string
  scope: 'project' | 'probe'
  records: ScanRow[]
  scan: ScanResult
  audit: {
    unregistered: ReadingRow[]
    withinCutoff: ReadingRow[]
    afterCutoff: ReadingRow[]
    stale: { id: string; n: number; actual: number }[]
    registrySize: number
    registryReadings: number
    asOf: string
  }
}
interface NumProv {
  FACETS: { key: string; asks: string; test: RegExp }[]
  MARKER: RegExp
  READING_SHAPES: string[]
  KNOWN_UNMARKED: RegistryEntry[]
  REGISTRY_AS_OF: string
  REGISTRY_BEGIN: string
  REGISTRY_END: string
  readRegistry(source: string): { asOf: string; entries: RegistryEntry[] }
  renderRegistry(entries: RegistryEntry[], asOf: string): string
  registryFrom(perRecord: Map<string, number>, records: ScanRow[], asOf: string): { asOf: string; entries: RegistryEntry[] }
  registryDelta(before: RegistryEntry[], after: RegistryEntry[]): { added: string[]; removed: string[]; changed: string[] }
  parseVerifications(text: string): (ScanRow & { index: number })[]
  readingsOf(evidence: string): { token: string; index: number; shapes: string[] }[]
  judgeReading(evidence: string, reading: { token: string; index: number; shapes: string[] }): { covered: boolean; reason: string; facets?: string[]; segment: string }
  scanRecords(records: ScanRow[]): ScanResult
  audit(scan: ScanResult, registry: RegistryEntry[], asOf: string): Report['audit']
  check(options?: { carrier?: string }): Report
  formatReport(result: Report): string
  toJson(result: Report): Record<string, unknown>
  helpText(): string
}

const api = (await import(new URL('../../scripts/check-number-provenance.mjs', import.meta.url).href)) as unknown as NumProv

/** 一份核实记录夹具（`evidence` 单行，与现盘载体同形）。 */
function record(reviewId: string, index: number, at: string, evidence: string): string {
  return [
    `  - reviewId: ${reviewId}`,
    `    index: ${index}`,
    `    findingHash: ${'0'.repeat(64)}`,
    `    outcome: reproduced`,
    `    evidence: ${evidence}`,
    `    at: ${at}`,
  ].join('\n')
}

/** 载体夹具（`verifications:` + 若干条记录）。 */
function carrierYaml(records: readonly string[]): string {
  return `verifications:\n${records.join('\n')}\n`
}

/** 把 `--carrier=` 指向夹具真跑一次（只看退出码与输出，不看函数返回值）。 */
function runScript(carrier: string): { status: number | null; output: string } {
  const run = spawnSync(process.execPath, [SCRIPT, `--carrier=${carrier}`], { cwd: ROOT, encoding: 'utf8' })
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

/** 夹具载体落盘（`node_modules/.sdo-test/m250/<name>.yml` 之外不写任何东西）。 */
function writeCarrier(name: string, text: string): string {
  mkdirSync(FIXTURE, { recursive: true })
  const path = join(FIXTURE, `${name}.yml`)
  writeFileSync(path, text, 'utf8')
  return path
}

/** 一段**带有效口径**的核实文本（判据里那句"按 `event.type` 还是按正文"的现场形态）。 */
const EVIDENCE_MARKED = '复现：口径: 正则 `dispatch/aborted`、文件 `.sdo/reviews/verified.yml`、全行匹配、数行（`wc -l`）⇒ `grep -c` 得 12 行'

/** 同一段文本，把标记抹掉（验收那句"把 `口径:` 抹掉 ⇒ 红"用的就是它）。 */
const EVIDENCE_STRIPPED = EVIDENCE_MARKED.split('口径:').join('')

/** 标记在、但**一面都认不出**（空话） —— 仍然不算读数。 */
const EVIDENCE_EMPTY_MARKER = '复现：口径: 很准，实测得 12 行'

/** 只含**不是读数**的形态：标识符 / 哈希 / ISO 日期 / 版本号 / 路径行号。 */
const EVIDENCE_NOT_READINGS = '见 REV-001#2 的落点 src/index.ts:254 与哈希 4e5490dfe6a1（2026-10-13 登记，v0.1.6）'

/** 上一条的正控：同一段文本 + 一处真读数（证明"排除"不是"扫描器坏了"）。 */
const EVIDENCE_WITH_ONE_READING = `${EVIDENCE_NOT_READINGS}，实跑 3 条`

/** 四种形态各一处 + 一处裸数字（裸数字不算读数）。 */
const EVIDENCE_SHAPES = '量词 5 条 / 英文 15 tests / 加粗 **0** / 结果位 = 7 / 裸数字 42 不成读数'

/** 现盘登记表体的逐字节快照（`--write-registry` 只会重写哨兵之间，测试据此判"新鲜 + 不动点"）。 */
const SCRIPT_TEXT = readFileSync(SCRIPT, 'utf8')

test('M250-01 口径标记的五面定义表写死在脚本里，且 `helpText` 与 `FACETS` 同源', () => {
  const keys = api.FACETS.map((facet) => facet.key)
  const KEYS = ['正则', '路径', '窗口', '计数', '类型轴']
  const sameTable = keys.join('|') === KEYS.join('|')
  assert.equal(sameTable, true, `the five facets must be exactly the documented set, got ${keys.join('/')}`)
  assert.equal(api.FACETS.length, 5, 'the facet table must have five rows')
  const emptyAsks = api.FACETS.filter((facet) => facet.asks.trim().length < 4)
  assert.equal(emptyAsks.length, 0, 'every facet must say what it asks for (asks must not be a stub)')
  const help = api.helpText()
  const missing = api.FACETS.filter((facet) => help.indexOf(facet.key) < 0)
  assert.equal(missing.length, 0, `helpText must print every facet (missing: ${missing.map((facet) => facet.key).join(',')})`)
  const shapesInHelp = api.READING_SHAPES.filter((shape) => help.indexOf(shape) < 0)
  assert.equal(shapesInHelp.length, 0, 'helpText must print every reading shape (one definition, not two)')
  const markerHit = api.MARKER.test('复现：口径: 正则 x')
  assert.equal(markerHit, true, 'the marker must be recognised next to punctuation')
  const proseLookalike = api.MARKER.test('按旧口径：当时的说法')
  assert.equal(proseLookalike, false, 'a prose look-alike such as 旧口径： must not count as a marker')
})

test('M250-02 双态：带 `口径:` ⇒ 绿；抹掉 `口径:` ⇒ 红并点名那个数字', () => {
  const withMarker = api.judgeReading(EVIDENCE_MARKED, api.readingsOf(EVIDENCE_MARKED)[0] as { token: string; index: number; shapes: string[] })
  const stripped = api.readingsOf(EVIDENCE_STRIPPED)
  const afterStrip = api.judgeReading(EVIDENCE_STRIPPED, stripped[0] as { token: string; index: number; shapes: string[] })
  assert.equal(withMarker.covered, true, 'the same sentence with a marker must be green')
  assert.equal((withMarker.facets ?? []).length >= 4, true, `a full marker must be credited all four facets, got ${(withMarker.facets ?? []).join('/')}`)
  assert.equal(stripped.length, 1, 'the fixture must carry exactly one reading')
  assert.equal(afterStrip.covered, false, 'removing the marker must turn the very same reading red')
  assert.equal(afterStrip.reason, 'missing-marker', 'the reason must say the marker is missing')
  assert.equal(stripped[0]?.token, '12', 'the flagged number must be the reading itself')
  const segmentMentions = afterStrip.segment.indexOf('12 行') >= 0
  assert.equal(segmentMentions, true, 'the report must print the segment, not only the number')
})

test('M250-03 空标记不算读数：`口径:` 后面一面都没有 ⇒ 仍红（`empty-marker`），一处也不算读数', () => {
  const readings = api.readingsOf(EVIDENCE_EMPTY_MARKER)
  const verdict = api.judgeReading(EVIDENCE_EMPTY_MARKER, readings[0] as { token: string; index: number; shapes: string[] })
  assert.equal(readings.length, 1, 'the fixture must carry exactly one reading')
  assert.equal(verdict.covered, false, 'a marker with no recognisable facet must not count as provenance')
  assert.equal(verdict.reason, 'empty-marker', 'the reason must differ from a missing marker')
  // 反例（不许把"有标记"当"有口径"）：只补一面就够 —— 缺项可容忍
  const oneFacetText = '复现：口径: 数行，实测得 12 行'
  const oneFacetReadings = api.readingsOf(oneFacetText)
  const onlyOneFacet = api.judgeReading(oneFacetText, oneFacetReadings[0] as { token: string; index: number; shapes: string[] })
  assert.equal(onlyOneFacet.covered, true, 'one recognisable facet is enough (missing facets are tolerated)')
})

test('M250-04 排除面：标识符 / 哈希 / 日期 / 版本号 / 路径行号不是读数；正控证明不是扫描器坏了', () => {
  const none = api.readingsOf(EVIDENCE_NOT_READINGS)
  const control = api.readingsOf(EVIDENCE_WITH_ONE_READING)
  assert.equal(none.length, 0, `no reading may be claimed here, got ${none.map((row) => row.token).join(',')}`)
  assert.equal(control.length, 1, `the positive control must yield exactly one reading, got ${control.map((row) => row.token).join(',')}`)
  assert.equal(control[0]?.token, '3', 'the positive control reading is the count of items')
  const shapes = control[0]?.shapes ?? []
  const counted = shapes.indexOf('量词') >= 0
  assert.equal(counted, true, `the control must be recognised by its unit, got ${shapes.join('/')}`)
})

test('M250-05 四种读数形态各命中一次；裸数字不命中', () => {
  const readings = api.readingsOf(EVIDENCE_SHAPES)
  const tokens = readings.map((row) => row.token)
  assert.deepEqual(tokens, ['5', '15', '0', '7'], `candidate readings must be exactly the four shapes, got ${tokens.join(',')}`)
  const hits = new Set<string>()
  for (const row of readings) for (const shape of row.shapes) hits.add(shape)
  const shapesSeen = api.READING_SHAPES.filter((shape) => !hits.has(shape))
  assert.equal(shapesSeen.length, 0, `every shape must be exercised (missing: ${shapesSeen.join(',')})`)
  const bare = tokens.indexOf('42')
  assert.equal(bare, -1, 'a bare number with no unit / bold / result position is not a reading')
})

test('M250-06 退出码双态：带口径 ⇒ exit 0；抹掉 ⇒ exit 1 且点名记录身份', () => {
  const okPath = writeCarrier('marked', carrierYaml([record('REV-900', 0, '2026-10-25T00:00:00.000Z', EVIDENCE_MARKED)]))
  const badPath = writeCarrier('stripped', carrierYaml([record('REV-901', 0, '2026-10-25T00:00:00.000Z', EVIDENCE_STRIPPED)]))
  try {
    const ok = runScript(okPath)
    const bad = runScript(badPath)
    assert.equal(ok.status, 0, `a marked reading must exit 0:\n${ok.output}`)
    assert.equal(bad.status, 1, `a stripped marker must exit 1:\n${bad.output}`)
    const named = bad.output.indexOf('REV-901#0') >= 0
    assert.equal(named, true, 'the red report must name the verification record it came from')
    const counted = bad.output.indexOf('12') >= 0
    assert.equal(counted, true, 'the red report must print the offending number')
    // 机读面（字段名全 ASCII）：同一份读数不许两种口径
    const json = spawnSync(process.execPath, [SCRIPT, `--carrier=${badPath}`, '--json'], { cwd: ROOT, encoding: 'utf8' })
    const parsed = JSON.parse(json.stdout) as Record<string, unknown>
    assert.equal(parsed['unmarked'], 1, 'the machine readable report must count the unmarked reading')
    assert.equal(Array.isArray(parsed['afterCutoff']), true, 'the machine readable report must split the two halves')
  } finally {
    rmSync(FIXTURE, { recursive: true, force: true })
  }
})

test('M250-07 载体缺失 ⇒ exit 0 并明说 absent（项目数据不在交付物里）', () => {
  const missing = join(FIXTURE, 'no-such-carrier.yml')
  const run = runScript(missing)
  try {
    assert.equal(run.status, 0, `a missing carrier must not judge anything red:\n${run.output}`)
    const said = run.output.indexOf('absent') >= 0
    assert.equal(said, true, 'the report must say the carrier is absent instead of staying silent')
    const result = api.check({ carrier: missing })
    assert.equal(result.carrier, undefined, 'a missing carrier must be reported as undefined, not as an empty corpus')
    assert.equal(result.scan.records, 0, 'a missing carrier has no records at all')
  } finally {
    rmSync(FIXTURE, { recursive: true, force: true })
  }
})

test('M250-08 现盘载体：存量无漏登记、登记与现算恰好相等；截止之后只打印不判红', realLedgerSkip() ?? {}, () => {
  const result = api.check()
  const readsRepoLedger = result.carrier === CARRIER
  assert.equal(readsRepoLedger, true, `the guard must read the repository ledger, got ${String(result.carrier)}`)
  const isProject = result.scope === 'project'
  assert.equal(isProject, true, 'the repository ledger must be judged with the legacy registry in force')
  const leak = result.audit.withinCutoff.map((row) => `${row.id}(${row.token})`).join(',')
  assert.equal(result.audit.withinCutoff.length, 0, `no unregistered reading may exist inside the cut-off (registrations: ${result.audit.registrySize}): ${leak}`)
  const drift = result.audit.stale.map((row) => `${row.id}:${row.n}->${row.actual}`).join(',')
  assert.equal(result.audit.stale.length, 0, `the registry must match the computed counts exactly (tighten it with --write-registry): ${drift}`)
  // 截止之后的新记录**只打印**（不判红）：台账是并发在写的，判红会让别人的正常核实把全量顶红
  const report = api.formatReport(result)
  const printed = report.indexOf('asOf') >= 0
  assert.equal(printed, true, 'the report must print the cut-off so a reader can tell the two halves apart')
  const halves = result.audit.withinCutoff.length + result.audit.afterCutoff.length
  assert.equal(halves, result.audit.unregistered.length, `the two halves must partition the unregistered readings (after the cut-off, printed not judged: ${result.audit.afterCutoff.length})`)
})

test('M250-09 登记表可被审计：条数、合计处数、id 唯一、每条 why 非空、n 是正整数', () => {
  const entries = api.KNOWN_UNMARKED
  const ids = new Set(entries.map((entry) => entry.id))
  assert.equal(ids.size, entries.length, 'registered ids must be unique (a duplicate would hide a record behind another)')
  assert.equal(entries.length >= 400, true, `the legacy registry must stay explicit per record (now ${entries.length})`)
  const blank = entries.filter((entry) => entry.why.trim().length < 8 || entry.id.trim() === '')
  assert.equal(blank.length, 0, `every entry must carry a non-empty why and id (got ${blank.length} blanks)`)
  const badN = entries.filter((entry) => !Number.isInteger(entry.n) || entry.n <= 0)
  assert.equal(badN.length, 0, `every n must be a positive integer (got ${badN.length} bad)`)
  const sum = entries.reduce((total, entry) => total + entry.n, 0)
  // 表头那行**写的数字**必须与现算相等（否则登记表自己在说谎）
  const header = /存量登记 (\d+) 条 \/ 合计 (\d+) 处/u.exec(SCRIPT_TEXT)
  assert.notEqual(header, null, 'the registry block must carry a header stating how many entries and readings it holds')
  assert.equal(Number((header as RegExpExecArray)[1]), entries.length, 'the header entry count must equal the registry length')
  assert.equal(Number((header as RegExpExecArray)[2]), sum, 'the header reading total must equal the sum of n')
  assert.equal(api.REGISTRY_AS_OF.length >= 20, true, `the legacy cut-off must be an ISO instant, got ${api.REGISTRY_AS_OF}`)
})

test('M250-10 登记表不动点：读回再渲染必须逐字节等于文件里那段（生成器确定性 + 现盘新鲜）', () => {
  const begin = SCRIPT_TEXT.indexOf(api.REGISTRY_BEGIN)
  const end = SCRIPT_TEXT.indexOf(api.REGISTRY_END)
  assert.equal(begin > 0 && end > begin, true, 'the registry block must live between its two sentinels')
  const block = SCRIPT_TEXT.slice(begin + api.REGISTRY_BEGIN.length, end).trim()
  const parsed = api.readRegistry(SCRIPT_TEXT)
  const rendered = api.renderRegistry(parsed.entries, parsed.asOf)
  assert.equal(rendered, block, 'renderRegistry(readRegistry(x)) must be a fixed point of the on-disk block')
  assert.deepEqual(parsed.entries, api.KNOWN_UNMARKED, 'the exported registry must be the one living in the file')
  assert.equal(parsed.asOf, api.REGISTRY_AS_OF, 'the exported cut-off must be the one living in the file')
})

test('M250-11 落点三：`docs/verification/` 那份说明有那一句纪律 + 正反例各一 + 五面表 + 命令', () => {
  const exists = existsSync(DOC)
  assert.equal(exists, true, `the discipline must be written down in docs (missing ${DOC})`)
  const doc = readFileSync(DOC, 'utf8')
  const discipline = doc.indexOf('数字离了口径就不是读数') >= 0
  assert.equal(discipline, true, 'the one-sentence discipline must be verbatim in the doc')
  const positive = doc.indexOf('grep -rn "不存在" src --include=*.ts | wc -l') >= 0
  assert.equal(positive, true, 'the positive example (pattern + path + window + counted as lines) must be in the doc')
  const negative = doc.indexOf('不存在 196 行') >= 0
  assert.equal(negative, true, 'the negative example (no pattern, no path, no window) must be in the doc')
  const missingFacets = api.FACETS.filter((facet) => doc.indexOf(facet.key) < 0)
  assert.equal(missingFacets.length, 0, `the doc must print the facet table (missing: ${missingFacets.map((facet) => facet.key).join(',')})`)
  const command = doc.indexOf('node scripts/check-number-provenance.mjs') >= 0
  assert.equal(command, true, 'the doc must say how to run the guard')
  const registry = doc.indexOf('--write-registry') >= 0
  assert.equal(registry, true, 'the doc must say how the legacy registry is maintained')
})

test('M250-12 重生成打印差集：新增 / 减少 / 变化三类都认得出（静默重生成就是关掉守卫）', () => {
  const before: RegistryEntry[] = [
    { id: 'REV-001#0', n: 2, why: 'x' },
    { id: 'REV-001#1', n: 3, why: 'x' },
  ]
  const after: RegistryEntry[] = [
    { id: 'REV-001#1', n: 5, why: 'x' },
    { id: 'REV-002#0', n: 1, why: 'x' },
  ]
  const delta = api.registryDelta(before, after)
  assert.deepEqual(delta.added, ['REV-002#0'], 'a new record must show up as added')
  assert.deepEqual(delta.removed, ['REV-001#0'], 'a record that gained provenance must show up as removed (tightening)')
  assert.deepEqual(delta.changed, ['REV-001#1: 3 → 5'], 'a changed count must show both sides')
  // 现算登记表 = 回读登记表（对现盘载体成立时不产生假差集）
  const stable = api.registryDelta(api.KNOWN_UNMARKED, api.KNOWN_UNMARKED)
  assert.equal(stable.added.length + stable.removed.length + stable.changed.length, 0, 'regenerating from the same input must produce an empty delta')
})
