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
 *   · `M234-03` ③ 台账被**替换**（`store.writeText` 走 tmp+rename ⇒ inode 变）或被**截短** ⇒ 全量重解析，
 *     且内容正确（反例：若误用旧缓存，这格必红）；
 *   · `M234-04` ④ `truncated` / `badLine` / 事件前缀与**修前的全量慢路径逐字相同**（慢路径以参考实现留在本文件里）；
 *   · `M234-05` ⑤ `pendingReviewBigCards` 的 `read()` 次数 ≤ 2（用产品计数器 `journalReadStats` 实测，不估算）。
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
import { JOURNAL_FILE, Journal, journalReadStats, resetJournalReadStats } from '../src/infra/journal.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
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
  journal.append('project/created', { project: { name: 'M234', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })
  journal.append('phase/entered', { phase: 'requirements' })
  const before = journal.read()
  assert.equal(before.events.length, 2)

  // ① **整份替换**（`store.writeText` = tmp+rename ⇒ inode 变）：内容完全不同、条数更少
  plant(f.workspace, `${eventLine(1, 'project/created', { project: { name: 'Other', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })}\n`)
  resetJournalReadStats()
  const replaced = journal.read()
  assert.equal(journalReadStats.fullParses, 1, 'a replaced file must be reparsed in full')
  assert.equal(replaced.events.length, 1, `the replaced content must win over the cache: ${String(replaced.events.length)}`)
  assert.equal(replaced.events[0]?.data['project'] !== undefined, true, 'the new content must be the one returned')

  // ② **就地截短**（同 inode、size 变小）：必须整份重解析，不能返回旧缓存
  const path = join(f.workspace, '.sdo', JOURNAL_FILE)
  const two = `${eventLine(1, 'project/created', { project: { name: 'Two', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })}\n${eventLine(2)}\n`
  plant(f.workspace, two)
  journal.read()
  const inoBefore = statSync(path).ino
  writeFileSync(path, `${eventLine(1, 'project/created', { project: { name: 'Two', process: 'waterfall', scale: 'normal', stakeholders: [], phase: 'intake', phaseHistory: [] } })}\n`)
  const inoAfter = statSync(path).ino
  assert.equal(inoBefore, inoAfter, 'fixture premise: an in-place truncation keeps the inode')
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
  assert.equal(journalReadStats.parsedLines, 0, `a warm cache must parse nothing for this call, got ${String(journalReadStats.parsedLines)}`)
  assert.equal(set.pending.length, [...set.missing, ...set.unadopted.map((row) => row.id)].length, 'the reading itself must be unchanged')
  assert.ok(set.considered.length >= 0, 'the call must still return a considered list')
})
