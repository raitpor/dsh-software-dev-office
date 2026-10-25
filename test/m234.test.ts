/**
 * **增量 234（`TASK-213`）：`Journal.read()` 的增量缓存 + 消除 N+1 读台账。**
 *
 * 病灶（本卡实测，真盘 `.sdo/journal.jsonl` 2.66MB / 5954 事件）：
 *   · 单次 `Journal.read()` **13.06ms**（全量 `JSON.parse` 5954 行）；
 *   · `pendingReviewBigCards(store, journal)` 一次调用 **279 次 `read()` / 4058ms / 解析 1,661,166 行**
 *     —— 一次工具调用把它读上百遍，每遍都从头解析同一份 append-only 真源。
 *
 * 本文件的守卫（编号与卡上 DoD 一一对应）：
 *   · `M234-01` ① **缓存不陈旧**：`append` 一条之后立刻 `read()` 必须看得到它，且那次**只解析 1 行**
 *     （反例：若缓存不失效/不回补新尾巴，这格必红）；
 *   · `M234-02` ② 未改动时连续两次 `read()`：第二次**解析 0 行**（`cacheHits` +1），内容逐 event 相同；
 *   · `M234-03` ③ 台账被**真替换**（`store.writeText` 走 tmp+rename ⇒ **inode 变**）或被**就地截短**
 *     （同 inode、变小）⇒ 全量重解析，且内容正确。
 *     **`REV-095` 必核六（`TASK-279` 修）**：① 原来写的是"整份替换"，但代码走 `plant()`（`writeFileSync`，
 *     **同 inode**）且新内容**更短** ⇒ 实际命中的是「变短」那一支，`dev+ino` 身份变这一支 7 格零覆盖。
 *     现在 ① 用 tmp+rename 造**真替换**，并断言 `ino` 真变了、`size` **变长**（封死「变短」这一支的解释），
 *     同时断言**首行与末行原文一个字节都没动**（封死两个锚点的解释）⇒ 只剩"身份变"能把这次读拉去全量；
 *   · `M234-04` ④ `truncated` / `badLine` / 事件前缀与**修前的全量慢路径逐字相同**（慢路径以参考实现留在本文件里）；
 *   · `M234-05` ⑤ `pendingReviewBigCards` 的 `read()` 次数 ≤ 2（用产品计数器 `journalReadStats` 实测，不估算）；
 *   · `M234-08` ⑥ **中段锚点**：等长改写**中间**行 + 首末行原样 + 再追加 ⇒ 必须全量重解析
 *     （`REV-095` 必核二①：只钉首末两行时这一形态会被拼成一段从未存在过的事件序列）；
 *   · `M234-09` ⑦ 台账被换成**目录** ⇒ `read()` 抛 `EISDIR`（与修前 `store.readText` 同口径，
 *     `REV-095` 必核三：不能把真实错误吞成"空台账"）；
 *   · `M234-10` ⑧ 一次 `verifyReviewFinding` 只读**一次**台账（`REV-095` 必核四③：修前 3 次）；
 *   · `M234-11` ⑨ 一次 `review.required` 判据只读**一次**台账（同上：修前 2 次）。
 *
 * 断言消息一律用英文（本文件不进 `KNOWN_PROSE_GAP`；中文只写在断言之外）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { realLedgerSkip } from './support/real-ledger.js'
import { pendingReviewBigCards } from '../src/domain/collab.js'
import { CHECKERS } from '../src/domain/gates.js'
import { recordReview } from '../src/domain/records.js'
import { verifyReviewFinding } from '../src/domain/reviewVerification.js'
import { JOURNAL_FILE, Journal, journalReadStats, resetJournalReadStats } from '../src/infra/journal.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { GateContext } from '../src/domain/gates.js'
import type { JournalEvent, JournalReadResult } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m234/', import.meta.url))

let office: SoftwareDevOffice

function fresh(name: string): { journal: Journal; workspace: string } {
  const dir = join(BASE, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  office.noteSession(`s-${name}`, dir)
  return { journal: office.journalFor(dir), workspace: dir }
}

/**
 * 直接写一段台账文本（绕开 `append`，用来造坏行/半写行/整份替换）。
 *
 * **必须用 `writeFileSync` 而不是 `store.writeText`**：后者会给缺换行的文本**补一个 `\n`**
 * （它的契约就是"写一份完整的 yml/json"）⇒ 造不出"正在写、还没换行"的尾行，
 * 而那一支正是本卡最容易读错的地方（缓存一个未终结的行 = 缓存一个未来的错误）。
 */
function plant(dir: string, text: string): void {
  const path = join(dir, '.sdo', JOURNAL_FILE)
  mkdirSync(join(dir, '.sdo'), { recursive: true })
  writeFileSync(path, text)
}

function eventLine(seq: number, type = 'phase/entered', data: Record<string, unknown> = { phase: 'intake' }): string {
  return JSON.stringify({ seq, at: `2026-10-24T00:00:${String(seq % 60).padStart(2, '0')}.000Z`, actor: 'sdo', type, data })
}

/**
 * **修前的全量慢路径**（逐字照抄 `TASK-213` 之前的 `read()`）。
 *
 * 为什么把它留在测试里：缓存版与慢版必须**同判**（截断位置、坏行行号、事件前缀），而"同判"这件事
 * 只有拿一份独立实现来比才叫证据 —— 拿缓存版和它自己比是恒真的。
 */
function slowRead(text: string | undefined): JournalReadResult {
  if (text === undefined) return { events: [], truncated: false }
  const events: JournalEvent[] = []
  const lines = text.split('\n')
  let expected = 1
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    if (raw.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { events, truncated: true, badLine: i + 1 }
    }
    const event = parsed as Partial<JournalEvent>
    if (
      typeof event.seq !== 'number'
      || event.seq !== expected
      || typeof event.at !== 'string'
      || typeof event.type !== 'string'
      || typeof event.data !== 'object'
      || event.data === null
    ) {
      return { events, truncated: true, badLine: i + 1 }
    }
    events.push(event as JournalEvent)
    expected++
  }
  return { events, truncated: false }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M234-01 (guard 1) a fresh append is visible on the very next read, and only the new line is parsed', () => {
  const f = fresh('append')
  const journal = f.journal
  const project = { name: 'M234', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] }
  journal.append('project/created', { project })
  const before = journal.read()
  const seen = before.events.length
  // **两态的核心**（第一条）：走 `append`（写者自己失效缓存）⇒ 紧接的 `read()` 必须看得到新事件，
  // 且**整个 append+read 只解析新增那一行**（修前：每读一次都全量解析）。
  resetJournalReadStats()
  journal.append('phase/entered', { phase: 'requirements' })
  const after = journal.read()
  assert.equal(after.events.length, seen + 1, `the appended event must be visible immediately: ${String(after.events.length)} vs ${String(seen)}`)
  assert.equal(after.events.at(-1)?.type, 'phase/entered', 'the appended event must be the last one')
  assert.equal(journalReadStats.parsedLines, 1, `append+read may parse only the appended line, got ${String(journalReadStats.parsedLines)}`)
  assert.equal(journalReadStats.fullParses, 0, 'an append must never trigger a full reparse')
  assert.equal(after.truncated, false)

  // **两态的核心**（第二条，更严）：**绕开 `Journal.append` 直写盘**（同 inode 的追加，没有任何显式失效）
  // ⇒ 下一次 `read()` 也必须看得到 —— 新鲜度不能只靠"写者记得调 invalidate"。
  const bypass = JSON.stringify({ seq: after.events.length + 1, at: '2026-10-24T00:10:00.000Z', actor: 'sdo', type: 'phase/entered', data: { phase: 'architecture' } })
  office.storeFor(f.workspace).appendLine([JOURNAL_FILE], bypass)
  resetJournalReadStats()
  const tail = journal.read()
  assert.equal(tail.events.length, seen + 2, `an out-of-band append must be visible on the next read: ${String(tail.events.length)}`)
  assert.equal(tail.events.at(-1)?.data['phase'], 'architecture', 'the out-of-band event must be the last one')
  assert.equal(journalReadStats.parsedLines, 1, `only the out-of-band line may be parsed, got ${String(journalReadStats.parsedLines)}`)
  assert.equal(journalReadStats.fullParses, 0, 'an in-place append must not force a full reparse')
})

test('M234-02 (guard 2) two reads of an untouched file: the second parses zero lines and returns the same events', () => {
  const f = fresh('stable')
  const journal = f.journal
  journal.append('project/created', { project: { name: 'M234', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })
  journal.append('phase/entered', { phase: 'requirements' })
  const first = journal.read()
  resetJournalReadStats()
  const second = journal.read()
  assert.equal(journalReadStats.parsedLines, 0, `the second read must parse nothing, got ${String(journalReadStats.parsedLines)}`)
  assert.equal(journalReadStats.cacheHits, 1, 'the second read must be a cache hit')
  assert.deepEqual(second.events, first.events, 'the cached events must equal the freshly parsed ones, event by event')
  assert.equal(second.truncated, false)
})

test('M234-03 (guard 3) replacing or truncating the ledger forces a full reparse with correct content', () => {
  const f = fresh('replaced')
  const journal = f.journal
  const project = { name: 'M234', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] }
  journal.append('project/created', { project })
  // 再追加 5 条**等长**事件（同一 type/同长度 payload）⇒ 行长度只由 seq/at 决定，1~6 行等长
  for (let n = 0; n < 5; n++) journal.append('phase/entered', { phase: 'phase-aaa' })
  const before = journal.read()
  assert.equal(before.events.length, 6, 'fixture premise: six events were read')

  const path = join(f.workspace, '.sdo', JOURNAL_FILE)
  const original = readFileSync(path, 'utf8')
  const lines = original.split('\n')
  assert.equal(lines.length, 7, 'fixture premise: six lines plus the trailing empty element')
  const inoBefore = statSync(path).ino
  const sizeBefore = statSync(path).size

  // ① **真替换**（tmp+rename ⇒ inode 变）：只改**第 2 行**（等长），首行与末行一个字节都不动，末尾再加一行
  const interior = lines[1] ?? ''
  const mutated = interior.replace('"phase-aaa"', '"phase-bbb"')
  assert.equal(mutated.length, interior.length, 'fixture premise: the interior rewrite keeps the byte length')
  assert.notEqual(mutated, interior, 'fixture premise: the interior line really changed')
  const extra = eventLine(7, 'phase/entered', { phase: 'phase-zzz' })
  const replacement = [lines[0], mutated, ...lines.slice(2, 6), extra, ''].join('\n')
  const kept = replacement.split('\n')
  assert.equal(kept[0], lines[0], 'fixture premise: the HEAD line is byte-identical')
  assert.equal(kept[5], lines[5], 'fixture premise: the former TAIL line (line 6) is byte-identical')
  office.storeFor(f.workspace).writeText([JOURNAL_FILE], replacement)
  assert.notEqual(statSync(path).ino, inoBefore, 'fixture premise: tmp+rename really swapped the inode (dev+ino identity changed)')
  assert.ok(statSync(path).size > sizeBefore, 'fixture premise: the replacement GREW, so the "shorter file" branch cannot explain a full reparse')

  resetJournalReadStats()
  const replaced = journal.read()
  assert.equal(journalReadStats.cacheHits, 0, 'a replaced file must not be served from the cache')
  assert.equal(journalReadStats.fullParses, 1, 'a replaced file (dev+ino changed) must be reparsed in full')
  assert.equal(replaced.events.length, 7, `the replaced content must win over the cache: ${String(replaced.events.length)}`)
  assert.equal(
    String(replaced.events[1]?.data['phase']),
    'phase-bbb',
    'the rewritten INTERIOR line must be the one returned — an append-only splice would keep the cached "phase-aaa"',
  )
  assert.equal(replaced.events.at(-1)?.data['phase'], 'phase-zzz', 'the appended tail must be the new one')

  // ② **就地截短**（同 inode、size 变小）：必须整份重解析，不能返回旧缓存
  const two = `${eventLine(1, 'project/created', { project: { name: 'Two', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })}\n${eventLine(2)}\n`
  plant(f.workspace, two)
  journal.read()
  const inoBeforeShort = statSync(path).ino
  writeFileSync(path, `${eventLine(1, 'project/created', { project: { name: 'Two', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })}\n`)
  const inoAfterShort = statSync(path).ino
  assert.equal(inoBeforeShort, inoAfterShort, 'fixture premise: an in-place truncation keeps the inode')
  resetJournalReadStats()
  const shrunk = journal.read()
  assert.equal(journalReadStats.fullParses, 1, 'a shorter file must be reparsed in full')
  assert.equal(shrunk.events.length, 1, `a shrunk ledger must not serve the old cache: ${String(shrunk.events.length)}`)
})

test('M234-04 (guard 4) truncated/badLine/prefix are byte-identical to the pre-cache slow path', () => {
  const cases: { name: string; text: string }[] = [
    { name: 'clean', text: `${eventLine(1, 'project/created', { project: { name: 'x', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })}\n${eventLine(2)}\n` },
    { name: 'bad-tail', text: `${eventLine(1, 'project/created', { project: { name: 'x', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })}\n{"seq":2,"at":` },
    { name: 'seq-gap', text: `${eventLine(1, 'project/created', { project: { name: 'x', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })}\n${eventLine(5)}\n` },
    { name: 'blank-lines', text: `\n${eventLine(1, 'project/created', { project: { name: 'x', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })}\n\n${eventLine(2)}\n\n` },
    { name: 'half-written', text: `${eventLine(1, 'project/created', { project: { name: 'x', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })}\n{"seq":2` },
    { name: 'unterminated-but-valid', text: `${eventLine(1, 'project/created', { project: { name: 'x', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })}\n${eventLine(2)}` },
    { name: 'truncated-then-appended', text: `${eventLine(1, 'project/created', { project: { name: 'x', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })}\n{"seq":2` },
  ]
  for (const item of cases) {
    const f = fresh(`slow-${item.name}`)
      plant(f.workspace, item.text)
    const fast = f.journal.read()
    const slow = slowRead(readFileSync(join(f.workspace, '.sdo', JOURNAL_FILE), 'utf8'))
    assert.deepEqual(fast, slow, `cache and slow path must agree on case "${item.name}": ${JSON.stringify(fast)} vs ${JSON.stringify(slow)}`)
    // 同一份文件**再读一次**（走缓存/续读）也必须同判
    const again = f.journal.read()
    assert.deepEqual(again, slow, `the second read must agree too on case "${item.name}"`)
  }
})

test('M234-06 (guard 3b) an in-place rewrite that also grows the file is not spliced onto the cached prefix', () => {
  // 这一格挡的是 `size` 看不出来的形态：**同 inode、就地整份重写、且比原来更长**。
  // 只按「变长 ⇒ 续读尾部」判就会把**旧的**前缀和**新的**尾巴拼在一起（读出一段从未存在过的事件序列）。
  // 修法的判据是**锚点复算**（续读前回读缓存里那一行原文比对）。
  const f = fresh('regrown')
  const journal = f.journal
  journal.append('project/created', { project: { name: 'M234', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })
  journal.append('phase/entered', { phase: 'requirements' })
  const warm = journal.read()
  assert.equal(warm.events.length, 2, 'fixture premise: two events were read')

  // 就地重写：第一行换成**另一条**事件（同 seq），再追加两条 —— 文件变长，但前缀已被改写
  const path = join(f.workspace, '.sdo', JOURNAL_FILE)
  const inoBefore = statSync(path).ino
  const rewritten = [
    eventLine(1, 'project/created', { project: { name: 'Rewritten', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } }),
    eventLine(2, 'phase/entered', { phase: 'architecture' }),
    eventLine(3, 'phase/entered', { phase: 'construction' }),
    '',
  ].join('\n')
  writeFileSync(path, rewritten)
  assert.equal(statSync(path).ino, inoBefore, 'fixture premise: the in-place rewrite keeps the inode')
  assert.ok(statSync(path).size > warm.events.length, 'fixture premise: the file grew')

  resetJournalReadStats()
  const after = journal.read()
  assert.equal(journalReadStats.fullParses, 1, 'a rewritten prefix must force a full reparse (the anchor no longer matches)')
  assert.equal(after.events.length, 3, `the rewritten ledger has three events, got ${String(after.events.length)}`)
  assert.equal(after.events[0]?.data['project'] !== undefined && String((after.events[0]?.data['project'] as { name?: string }).name), 'Rewritten', 'the returned prefix must be the rewritten one, not the cached one')
  assert.equal(after.events.at(-1)?.data['phase'], 'construction', 'the returned tail must be the new one')
})

// **真账守卫的缺账口径**（`DEF-153` / `M211-01`）：本格断言的是**仓库自己那份台账**上的读数，
// 干净检出里没有 `.sdo/` ⇒ 明确 skip 并打印理由（不换成夹具断言 —— 那会把"真账读数"降级成同义反复）。
test('M234-07 (guard 3c) an in-place rewrite of the SAME length is still detected (size alone cannot see it)', () => {
  // 这一格挡的是「size 完全没变」的就地改写：`store.writeText` 走 tmp+rename（inode 会变）天然挡得住，
  // 但**直接写盘**的路径（手改、别的工具）会留下「同 inode + 同长度 + 内容不同」的形态。
  // 判据只能靠 `mtime`（缓存里记的那一份与盘上的不同 ⇒ 保守判"被动过" ⇒ 全量重解析）。
  const f = fresh('same-length')
  const journal = f.journal
  journal.append('project/created', { project: { name: 'M234', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })
  const warm = journal.read()
  const path = join(f.workspace, '.sdo', JOURNAL_FILE)
  const original = readFileSync(path, 'utf8')
  assert.equal(warm.events.length, 1, 'fixture premise: one event was read')
  const inoBefore = statSync(path).ino
  const sizeBefore = statSync(path).size
  // **同长度**改写：把 project 名字换掉（等长替换），文件大小一个字节都不变
  const rewritten = original.replace('"M234"', '"M235"')
  assert.equal(rewritten.length, original.length, 'fixture premise: the rewrite keeps the byte length')
  writeFileSync(path, rewritten)
  assert.equal(statSync(path).ino, inoBefore, 'fixture premise: the in-place rewrite keeps the inode')
  assert.equal(statSync(path).size, sizeBefore, 'fixture premise: the in-place rewrite keeps the size')
  resetJournalReadStats()
  const after = journal.read()
  assert.equal(journalReadStats.cacheHits, 0, 'a touched file must not be served from cache')
  assert.equal((after.events[0]?.data['project'] as { name?: string }).name, 'M235', 'the rewritten content must be visible')
})

/**
 * **`M234-08`（`REV-095` 必核二① / `TASK-279`）：中段锚点。**
 *
 * 形态（评审点名的、只钉首末两行时**漏掉**的那一格）：**同 inode、等长改写中间某行 + 首末行原样 + 再追加一行**。
 *   · 文件**变长** ⇒ 只看 `size` 会判"续读尾部"；
 *   · 首行锚点 / 末行锚点都落在**未被改写**的行上 ⇒ 两次探测都对得上；
 *   · 于是旧的中间事件被静默保留，读出一段**从未存在过的事件序列**（`events[1]` 是旧值）。
 * 加了中段抽样之后，三段里必有一段落在被改写的行上 ⇒ 判"改写" ⇒ 全量重解析。
 *
 * 夹具为什么这样造：4 条**等长**行 ⇒ 中段抽样（结束位置 ≤ 文件长度一半的最后一个非空行）确定落在第 2 行；
 * 于是「改第 2、3 行」必然覆盖到抽样点，而首行 / 第 4 行一个字节都不动。中间**不读**（读一次就会被缓存记住）。
 */
test('M234-08 (guard 6) an equal-length rewrite of a MIDDLE line is caught by the mid anchor', () => {
  const f = fresh('mid-anchor')
  const journal = f.journal
  const path = join(f.workspace, '.sdo', JOURNAL_FILE)
  const lines = [1, 2, 3, 4].map((seq) => eventLine(seq, 'phase/entered', { phase: 'phase-aaa' }))
  plant(f.workspace, `${lines.join('\n')}\n`)
  const warm = journal.read()
  assert.equal(warm.events.length, 4, 'fixture premise: four events were read')
  const inoBefore = statSync(path).ino
  const sizeBefore = statSync(path).size

  // 等长改写**中间两行**（2、3），首行（1）与末行（4）一个字节都不动，中间不读
  const rewritten = lines.map((line, index) => (index === 1 || index === 2 ? line.replace('"phase-aaa"', '"phase-bbb"') : line))
  assert.equal(rewritten[1]?.length, lines[1]?.length, 'fixture premise: the interior rewrite keeps the byte length')
  assert.equal(rewritten[0], lines[0], 'fixture premise: the HEAD line is byte-identical')
  assert.equal(rewritten[3], lines[3], 'fixture premise: the TAIL line is byte-identical')
  writeFileSync(path, `${rewritten.join('\n')}\n`)
  assert.equal(statSync(path).ino, inoBefore, 'fixture premise: the in-place rewrite keeps the inode')
  // 再追加一行（同 inode、只变长）⇒ 这正是"变长 ⇒ 续读尾部"会误判的入口
  office.storeFor(f.workspace).appendLine([JOURNAL_FILE], eventLine(5, 'phase/entered', { phase: 'phase-zzz' }))
  assert.ok(statSync(path).size > sizeBefore, 'fixture premise: the file grew after the rewrite')

  resetJournalReadStats()
  const after = journal.read()
  assert.equal(journalReadStats.fullParses, 1, 'a rewritten MIDDLE line must force a full reparse (the mid anchor no longer matches)')
  assert.equal(journalReadStats.tailParses, 0, 'it must not be spliced as an append-only tail read')
  assert.equal(after.events.length, 5, `the rewritten ledger has five events, got ${String(after.events.length)}`)
  assert.equal(String(after.events[1]?.data['phase']), 'phase-bbb', 'the rewritten middle event must be the one returned, not the cached "phase-aaa"')
  assert.equal(String(after.events[2]?.data['phase']), 'phase-bbb', 'both rewritten interior lines must be visible')
  assert.equal(String(after.events[0]?.data['phase']), 'phase-aaa', 'the untouched head line must be unchanged')
  assert.equal(String(after.events.at(-1)?.data['phase']), 'phase-zzz', 'the appended tail must be the new one')
})

/**
 * **`M234-09`（`REV-095` 必核三 / `TASK-279`）：台账不是普通文件时必须抛错，不能吞成"空台账"。**
 *
 * 改前 `read()` 走 `store.readText`（`existsSync` + `readFileSync`）⇒ 路径是**目录**时抛 `EISDIR`；
 * 缓存版最初把这一支吞成"空台账"—— 那等于把一次**真实错误静默**掉，且与改前不同。
 * 这一格同时钉住**两侧**（`store.readText` 与 `read()`），所以它不是同义反复：比的是"改前那一支"与"现在那一支"。
 */
test('M234-09 (guard 7) a ledger that is a directory throws EISDIR, exactly like the pre-cache reader', () => {
  const f = fresh('not-a-file')
  const journal = f.journal
  const path = join(f.workspace, '.sdo', JOURNAL_FILE)
  mkdirSync(path, { recursive: true })
  const store = office.storeFor(f.workspace)
  // 改前那一支（`store.readText` = existsSync + readFileSync）：抛 EISDIR
  const before = (() => { try { store.readText(JOURNAL_FILE); return undefined } catch (error) { return error as NodeJS.ErrnoException } })()
  assert.equal(before?.code, 'EISDIR', 'fixture premise: the pre-cache reader throws EISDIR on a directory')
  // 现在这一支：必须同判（不吞成空台账）
  const now = (() => { try { journal.read(); return undefined } catch (error) { return error as NodeJS.ErrnoException } })()
  assert.notEqual(now, undefined, 'read() must not swallow a real error into an empty ledger')
  assert.equal(now?.code, 'EISDIR', `read() must throw the same EISDIR the pre-cache reader threw, got ${String(now?.code)}`)
  assert.match(String(now?.message), /EISDIR/u, 'the message must name the errno so the failure is recognisable')
})

test('M234-05 (guard 5) pendingReviewBigCards reads the ledger at most twice (measured, not estimated)', realLedgerSkip() ?? {}, () => {
  // 用真盘台账（本仓自己的 `.sdo`）：这是本卡基线里 279 次读的同一份数据
  const repo = fileURLToPath(new URL('../../', import.meta.url))
  const store = office.storeFor(repo)
  const journal = office.journalFor(repo)
  journal.read() // 预热缓存：把"首读的全量解析"排除在计数之外（否则计数与解析量混在一起）
  resetJournalReadStats()
  const set = pendingReviewBigCards(store, journal)
  // 卡上的上界是 ≤ 2（一次读 + 必要时一次重读）；**今天实测就是 1** —— 把实测值也钉住，
  // 于是"把共享快照改回各读一次"（N+1 复辟）这种退化会被这格当场抓住。
  assert.ok(journalReadStats.readCalls <= 2, `the ledger may be read at most twice per call, got ${String(journalReadStats.readCalls)}`)
  assert.equal(journalReadStats.readCalls, 1, `measured: exactly one read per call, got ${String(journalReadStats.readCalls)}`)
  /**
   * **`REV-095` 必核七②（`TASK-279`）**：解析行数**放宽到 ≤ 1**，不再钉 `=== 0`。
   *
   * 为什么（评审点名的假红方向）：本仓是**并发多会话**，这一格读的是**真盘**台账 —— 任何并发会话在这格
   * 预热与本调用之间 append 一行，`read()` 就会合法地续读那一行（`readCalls` 仍是 1，但 `parsedLines` = 1）
   * ⇒ 旧断言 `=== 0` 会红，而产品其实完全正确（`DEF-251` 记的就是这一类对同机并发敏感的读数）。
   * "暖缓存解析 0 行"这条**严格**判据留给临时工作区那几格（`M234-02` 的 `parsedLines === 0` 就是它），
   * 真账这一格的职责只有一条：**一次调用只读一次**。
   */
  assert.ok(
    journalReadStats.parsedLines <= 1,
    `a warm cache must parse at most the one line a concurrent session may have appended, got ${String(journalReadStats.parsedLines)}`,
  )
  assert.equal(set.pending.length, [...set.missing, ...set.unadopted.map((row) => row.id)].length, 'the reading itself must be unchanged')
  assert.ok(set.considered.length >= 0, 'the call must still return a considered list')
})

/**
 * **`M234-10`（`REV-095` 必核四③ / `TASK-279`）：一次核实只读一次台账。**
 *
 * 修前的形状：`verifyReviewFinding` 自己读一次（索引），`dispatchRoleOf` 又自己 `journal.read()`
 * 一次（为了查"这个会话被派发成什么角色"），收尾的 `reviewAdoption` 再 `journal.eventsIndex()` 读一次
 * ⇒ **3 次**（评审原话"读一次、四处共用"名不副实）。现在第一次读就是唯一一次。
 *
 * 读数口径（**实测值，不是估算**）：这一次调用的 `readCalls` = **1**（写前判定读：recorded / 认领 /
 * 派发角色 / 派发是否结算 四处共用） + **2**（`append()` 内部读：它要按盘面算 seq；用一格临时工作区
 * 实测 `journal.append()` 单独一次 = 2） + **1**（写后判采纳态：那一步要判**刚写下去**的留痕与事件，
 * 传写前的快照会让"最后一条发现核实完 ⇒ 可采纳"永远不成立，见 `verifyReviewFinding` 里的说明） = **4**。
 * 反例（把 `index` 传回去）当场变 6 ⇒ 这格必红（`MUT-C` 实测）。
 */
test('M234-10 (guard 8) one verify-review costs exactly one ledger read for the judgement itself', () => {
  const f = fresh('verify-once')
  const store = office.storeFor(f.workspace)
  const journal = f.journal
  const review = recordReview(store, journal, {
    taskId: 'TASK-900',
    reviewer: 'reviewer-x',
    verdict: 'changes-requested',
    findings: ['first finding ⇒ needs a fix', 'second finding ⇒ needs a fix'],
    repro: 'node --test lib/test/m234.test.js',
  })
  journal.read() // 预热：下面只量"这一次核实"自己读了几次
  resetJournalReadStats()
  const result = verifyReviewFinding(store, journal, {
    reviewId: review.id,
    index: 0,
    outcome: 'reproduced',
    evidence: '现跑 ⇒ journalReadStats.readCalls 见本格断言',
    by: 'tester',
    sessionId: 'verifier-session',
  })
  assert.equal(result.ok, true, `the verify must go through the whole path: ${JSON.stringify(result).slice(0, 300)}`)
  assert.equal(
    journalReadStats.readCalls,
    4,
    `pre-write judgement (1) + append() internal reads (2) + post-write adoption (1) = 4; the old shape read 6. got ${String(journalReadStats.readCalls)}`,
  )
})

/**
 * **`M234-11`（`REV-095` 必核四③ / `TASK-279`）：一条门禁判据只读一次台账。**
 *
 * 修前的形状（评审点名 `:3035-3039`）：判据先让 `pendingReviewBigCards` 自己读一次台账，
 * 再让 `gateAdoptions`（采纳表）自己读一次 ⇒ 同一份台账在**同一条判据**里读两遍。
 * 现在只读一次，这一份事件既喂「待评审中大卡」也喂采纳表。
 */
test('M234-11 (guard 9) one review.required evaluation reads the ledger exactly once', () => {
  const f = fresh('gate-once')
  const store = office.storeFor(f.workspace)
  const journal = f.journal
  // 一张 done 的中大产品卡（进 `pendingReviewBigCards` 的考虑集），且**一条评审都没有** ⇒ 走完整条路径
  store.writeYaml(['tasks', 'TASK-901.yml'], {
    task: den198Card('TASK-901', ['src/only-901/'], { status: 'done', size: 'medium' }),
  })
  const context = { workspace: f.workspace, store, journal, requirements: [], project: { surfaces: [] } } as unknown as GateContext
  journal.read() // 预热读层缓存：计数只反映"这条判据读了几次"
  resetJournalReadStats()
  const result = CHECKERS['review.required']?.(context)
  assert.notEqual(result, undefined, 'the criterion must still be registered')
  assert.equal(result?.ok, false, 'fixture premise: a done medium card with no review must fail this criterion')
  assert.equal(journalReadStats.readCalls, 1, `one criterion evaluation must read the ledger once, got ${String(journalReadStats.readCalls)}`)
})

/* ————————————————————————————————————————————————————————————————————————————————
 * **`DEN-198`（`TASK-214`）：公共面在「写入闸门」与「done 的 A2 对账」两处口径必须一致**
 *
 * 病灶（本卡实测）：写入闸门把 `disciplineAllowPaths`（`.sdo/` `docs/` `test/`）当公共面 —— 不受卡范围
 * 约束；而 `done` 的 A2 对账不认它 ⇒ **同一份改动，闸门放行、结算判越界**。另一半：两卡真要共用
 * 同一份台账/棘轮文件时，`addWriteScopes` 把它当产品面 ⇒ `add-scope-conflict` ⇒ **没有合法通道**。
 *
 * 四条守卫（两态，编号与卡上 DoD 一一对应）：
 *   · `M234-D1` 公共面改动 ⇒ done **不再**判越界，但回执有「public-face changes」一行；
 *   · `M234-D2` 产品面同场景 ⇒ **仍判越界**（防「公共面放行」被泛化成"哪儿都能写"）；
 *   · `M234-D3` 卡 A 在飞时给卡 B `addWriteScopes(公共面)` ⇒ **放行且点名共享**，并落结构化事件；
 *   · `M234-D4` 同场景换成产品面 ⇒ **仍拒**（`DEN-197` 的重叠锁不许被这次改动拆掉）。
 *
 * 断言消息一律用英文（本文件不进 `KNOWN_PROSE_GAP`；中文只写在断言之外）。
 * ———————————————————————————————————————————————————————————————————————————————— */

/** 一张最小的可认领卡（`writeScopes` 由调用方指定）。 */
function den198Card(id: string, writeScopes: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes,
    role: 'developer',
    size: 'small',
    revision: 1,
    status: 'ready',
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...over,
  }
}

/** 一台干净办公室（真 store + 真 journal），返回会话调用面。 */
function den198Office(name: string): { office: SoftwareDevOffice; call: (sid: string) => never; workspace: string } {
  const dir = join(BASE, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-a', dir)
  office.noteSession('s-b', dir)
  const call = (sid: string): never => ({ sessionId: sid, cwd: dir }) as unknown as never
  office.init(call('s-a'), { name: `M234 ${name}`, scale: 'normal', stakeholders: ['x'] })
  return { office, call, workspace: dir }
}

/** 一条能过 A1 证据对账的 `command` 证据。 */
function den198Evidence(): { kind: 'command'; detail: string; at: string; exitCode: number }[] {
  return [{ kind: 'command', detail: 'node --test lib/test/m234.test.js（guard fixture）', at: '2026-10-25T00:00:00.000Z', exitCode: 0 }]
}

test('M234-D1 (DEN-198 guard 1) a public-face change no longer fails done, but is printed on its own line', () => {
  const { office, call, workspace } = den198Office('den198-d1')
  office.storeFor(workspace).writeYaml(['tasks', 'TASK-21401.yml'], { task: den198Card('TASK-21401', ['src/only-TASK-21401/']) })
  const claimed = office.claimTask(call('s-a'), { taskId: 'TASK-21401', owner: 'dev-a', expectedRevision: 1 })
  assert.equal(claimed.ok, true, 'fixture premise: the claim must succeed')
  // 卡写范围**不含** test/ ⇒ 改的是公共面（登记/棘轮同步）
  const done = office.reportTask(call('s-a'), {
    taskId: 'TASK-21401',
    owner: 'dev-a',
    status: 'done',
    evidence: den198Evidence(),
    reportedFiles: ['test/m189.test.ts', 'docs/README.md'],
  })
  assert.equal(done.ok, true, `a public-face change must not block done: ${JSON.stringify(done).slice(0, 300)}`)
  const notes = (done.ok ? (done.naNotes ?? []) : []).join('\n')
  assert.match(notes, /public-face changes/u, `the receipt must carry its own public-face line: ${notes}`)
  assert.match(notes, /test\/m189\.test\.ts × 1/u, `the line must name the path and its count: ${notes}`)
  assert.match(notes, /registry\/ratchet sync/u, `the line must say what kind of writes these are: ${notes}`)
  // **可审计**：`task/done` 事件带结构化字段（不是只靠执行者自报）
  const event = office.journalFor(workspace).read().events.filter((row) => row.type === 'task/done').at(-1)
  assert.ok(event !== undefined, 'fixture premise: a task/done event must exist')
  assert.deepEqual(event.data['publicFace'], ['test/m189.test.ts', 'docs/README.md'], `the ledger must record which public files were touched: ${JSON.stringify(event.data)}`)
  assert.equal(event.data['publicFaceSource'], 'self-reported', 'the source must be labelled honestly (self-report, not observation)')
})

test('M234-D2 (DEN-198 guard 2) the same shape on a PRODUCT file still fails done (no generalisation)', () => {
  const { office, call, workspace } = den198Office('den198-d2')
  office.storeFor(workspace).writeYaml(['tasks', 'TASK-21402.yml'], { task: den198Card('TASK-21402', ['src/only-TASK-21402/']) })
  assert.equal(office.claimTask(call('s-a'), { taskId: 'TASK-21402', owner: 'dev-a', expectedRevision: 1 }).ok, true, 'fixture premise: claim')
  const done = office.reportTask(call('s-a'), {
    taskId: 'TASK-21402',
    owner: 'dev-a',
    status: 'done',
    evidence: den198Evidence(),
    reportedFiles: ['src/elsewhere/x.ts'],
  })
  assert.equal(done.ok, false, 'a product-file change outside the card scope must still be rejected')
  if (done.ok) assert.fail('must be rejected')
  assert.equal(done.code, 'write-scope-violation', 'the rejection code must stay the same')
  assert.match(done.detail, /src\/elsewhere\/x\.ts/u, `the rejection must name the file: ${done.detail}`)
})

test('M234-D3 (DEN-198 guard 3) addWriteScopes on a public-face path is allowed while another card holds it, and says so', () => {
  const { office, call, workspace } = den198Office('den198-d3')
  // 卡 A 在飞且**持有** test/m189.test.ts
  office.storeFor(workspace).writeYaml(['tasks', 'TASK-21403.yml'], {
    task: den198Card('TASK-21403', ['src/only-TASK-21403/', 'test/m189.test.ts'], { owner: 'dev-a', status: 'in-progress' }),
  })
  office.storeFor(workspace).writeYaml(['tasks', 'TASK-21404.yml'], { task: den198Card('TASK-21404', ['src/only-TASK-21404/']) })
  assert.equal(office.claimTask(call('s-b'), { taskId: 'TASK-21404', owner: 'dev-b', expectedRevision: 1 }).ok, true, 'fixture premise: claim B')
  const added = office.updateTask(call('s-b'), {
    taskId: 'TASK-21404',
    by: 'dev-b',
    addWriteScopes: ['test/m189.test.ts'],
    reason: 'ratchet registry sync',
  })
  assert.equal(added.ok, true, `a shared public-face declaration must be allowed: ${JSON.stringify(added).slice(0, 300)}`)
  if (!added.ok) assert.fail('must be allowed')
  // **不静默**：回执的 changed 里点名「与哪张卡共享哪条路径」
  assert.ok(added.changed.includes('shared:test/m189.test.ts@TASK-21403'), `the receipt must name the sharing pair: ${added.changed.join(' / ')}`)
  assert.deepEqual(added.shared, [{ taskId: 'TASK-21403', path: 'test/m189.test.ts', otherScope: 'test/m189.test.ts' }], 'the structured reading must name both sides')
  // **可审计**：台账事件里也带同一份读数
  const event = office.journalFor(workspace).read().events
    .filter((row) => row.type === 'task/updated' && row.data['shared'] !== undefined)
    .at(-1)
  assert.ok(event !== undefined, 'the sharing must be recorded in the ledger, not only in the receipt')
  assert.deepEqual(event.data['shared'], [{ with: 'TASK-21403', path: 'test/m189.test.ts', otherScope: 'test/m189.test.ts' }], `ledger reading: ${JSON.stringify(event.data)}`)
})

test('M234-D4 (DEN-198 guard 4) the same addWriteScopes on a PRODUCT path is still rejected (DEN-197 lock kept)', () => {
  const { office, call, workspace } = den198Office('den198-d4')
  office.storeFor(workspace).writeYaml(['tasks', 'TASK-21405.yml'], {
    task: den198Card('TASK-21405', ['src/only-TASK-21405/'], { owner: 'dev-a', status: 'in-progress' }),
  })
  office.storeFor(workspace).writeYaml(['tasks', 'TASK-21406.yml'], { task: den198Card('TASK-21406', ['src/only-TASK-21406/']) })
  assert.equal(office.claimTask(call('s-b'), { taskId: 'TASK-21406', owner: 'dev-b', expectedRevision: 1 }).ok, true, 'fixture premise: claim B')
  const added = office.updateTask(call('s-b'), {
    taskId: 'TASK-21406',
    by: 'dev-b',
    addWriteScopes: ['src/only-TASK-21405/x.ts'],
    reason: 'product path',
  })
  assert.equal(added.ok, false, 'a product-face overlap must still be rejected')
  if (added.ok) assert.fail('must be rejected')
  assert.equal(added.code, 'add-scope-conflict', 'the rejection code must stay the same')
  assert.match(added.detail, /TASK-21405/u, `the rejection must name the in-flight card: ${added.detail}`)
})
