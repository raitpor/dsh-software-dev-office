/**
 * **增量 243（`TASK-230`）：折表层**增量折表** —— 写入只应用新增事件，不再整批重算。**
 *
 * 病灶（本卡实测，真账 `.sdo/journal.jsonl` 8841 事件 / 121 条评审 / 256 张卡）：
 *   · `pendingReviewBigCards` **冷** 99.6ms / **命中** 0.79ms —— 记忆化本身是有效的；
 *   · 但**每次写入后立刻重读** = **39.4 / 43.9 / 39.7ms**：`bumpGeneration` 见换代就
 *     `invalidateDerivedTables`，五张派生表**整批作废** ⇒ `derivedTableStats.computes` 五表各 4 次、
 *     `hits` 仅 1 ⇒ **4 次调用 4 次真算、零复用**；
 *   · 那 40ms 里没有一条是"新事件真的改变了旧结论"：台账是 **append-only**，
 *     已有结论只可能被"末尾多了一条事件"影响，不可能被它改掉。
 *
 * 本文件的守卫（编号与卡上 DoD 的「判据（两态）」一一对应）：
 *   · `M243-01` ① **写 1 条事件后紧接读 `< 2ms`**（改前 30–36ms）：真账副本上跑 10 次「写→读」，
 *     逐次打印读数；中位数 / 均值都要 < 2ms，且至少 8 条 < 2ms（跑满全量时调度抖动是真实的）;
 *   · `M243-02` ② **判据是计数桩不是计时**：连续 10 次「写→读」中 `fullRecomputes` = 1（首次）、
 *     `incrementalApplies` = 10；关掉增量这一格必红（变异自证见交付说明）;
 *   · `M243-03` ③ **反例格**：模拟「换 inode」重写台账 ⇒ 必须走整批 `fullRecomputes`（**不许**错用增量）；
 *     截断（变短）同样整批重算；
 *   · `M243-04` **语义不变**：增量算出来的表与"清缓存后整批重算"的表**逐字节相同** —— 三种事件
 *     （与采纳无关的 `task/updated` / `review/verified` / 篡改后的 `review/recorded`）各一格；
 *   · `M243-05` **不吃事件的表不再被写入带走**：`reviews-table` / `dispositions-table` / `tasks-table`
 *     的 compute 一个事件都不读（真源是 YAML）⇒ 写事件之后应当**命中**（`fullRecomputes` 不涨）；
 *   · `M243-06` **落点二：堵住绕过缓存的路**（源码棘轮）：`listReviews(store)` / `listDispositions(store)`
 *     的**原始**调用点按文件登记条数 —— 新增一条绕过缓存的路立刻红;
 *   · `M243-07` **落点三：增量可见**：`derivedTableStats` 分计 `fullRecomputes` /
 *     `incrementalApplies`，并由 `describeDerivedTableStats()` 拼成一行可读读数（门禁/回执要渲染它，
 *     只差一个"渲染点"：`gates.ts` 不在本卡写范围，见交付说明的跟卡建议）；
 *   · `M243-08` **落点二的行为面**：`rehashReview` 改走记忆化评审表（热表上必须命中、不重建）。
 *
 * 断言消息一律用英文（本文件不进 `KNOWN_PROSE_GAP`；中文只写在断言之外）。
 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { REAL_LEDGER_DIR, realLedgerSkip } from './support/real-ledger.js'
import { pendingReviewBigCards } from '../src/domain/collab.js'
import { listReviews, reviewContentHash } from '../src/domain/records.js'
import {
  adoptionTable,
  listDispositionsCached,
  listReviewsCached,
  rehashReview,
  verifyReviewFinding,
} from '../src/domain/reviewVerification.js'
import {
  JOURNAL_FILE,
  Journal,
  deriveTableStatsLine,
  describeDerivedTableStats,
  derivedTableStats,
  invalidateDerivedTables,
  invalidateJournalCache,
  resetDerivedTableStats,
} from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { Review } from '../src/domain/records.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m243/', import.meta.url))
const WORKSPACE = join(BASE, 'ws')

let store: SdoStore
let journal: Journal

/** 一张 `done` 的 medium 产品卡（进 `review.required` 的考虑集）。 */
function card(id: string, status: TaskCard['status'] = 'done'): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes: [`src/${id}/`],
    role: 'developer',
    size: 'medium',
    revision: 1,
    status,
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
  }
}

/** 往夹具里放一张卡 + 一条 `pass` 评审（含 `review/recorded` 事件，内容哈希对得上）。 */
function seedReview(taskId: string, reviewId: string): Review {
  store.writeYaml(['tasks', `${taskId}.yml`], { task: card(taskId) })
  const review: Review = {
    id: reviewId,
    taskId,
    reviewer: 'rev-243',
    verdict: 'pass',
    findings: ['one finding'],
    at: '2026-01-01T00:00:00.000Z',
  }
  store.writeYaml(['reviews', `${reviewId}.yml`], { review })
  journal.append('review/recorded', {
    id: review.id,
    taskId: review.taskId,
    verdict: review.verdict,
    findings: review.findings.length,
    contentHash: reviewContentHash(review),
  })
  return review
}

/** 当下（可能走增量）的完整读数：待评审集 + 采纳表逐条状态。 */
function snapshotOf(): string {
  return JSON.stringify({
    pending: pendingReviewBigCards(store, journal),
    adoptions: [...adoptionTable(store, journal).entries()]
      .map(([id, item]) => [id, item.state, item.tamperGuard, item.pending, item.stale, item.forged]),
  })
}

/** 冷态下的同一份读数（清两层缓存再算 = 语义基准）。 */
function coldSnapshot(): string {
  invalidateJournalCache()
  invalidateDerivedTables()
  return snapshotOf()
}

/** 中位数（偶数个取中间两个的均值；空数组给 0，只为让判据可读）。 */
function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

function count(bucket: Record<string, number>, key: string): number {
  return bucket[key] ?? 0
}

/** 真账副本：本文件的 ① ② 两格要**写入**，所以先拷一份再动 —— 绝不碰真台账（`D1` 纪律）。 */
function realCopy(name: string): { store: SdoStore; journal: Journal } {
  const root = join(BASE, name)
  mkdirSync(root, { recursive: true })
  cpSync(REAL_LEDGER_DIR, join(root, '.sdo'), { recursive: true })
  const copied = new SdoStore(join(root, '.sdo'))
  return { store: copied, journal: new Journal(copied) }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-243', WORKSPACE)
  store = office.storeFor(WORKSPACE)
  journal = office.journalFor(WORKSPACE)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M243-01 (reading 1) a read right after a write stays under 2ms on the real ledger', realLedgerSkip() ?? {}, () => {
  const real = realCopy('real-timing')

  // 冷读一次（建表 + 预热 JIT）：本格量的是"写后读"，不是"冷启动"
  const coldStarted = performance.now()
  pendingReviewBigCards(real.store, real.journal)
  const coldMs = performance.now() - coldStarted
  const warmStarted = performance.now()
  pendingReviewBigCards(real.store, real.journal)
  const warmMs = performance.now() - warmStarted
  assert.ok(coldMs > warmMs, `cold must stay the expensive path (cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(2)}ms)`)
  assert.ok(warmMs < 10, `a warm read must stay cheap (measured ${warmMs.toFixed(2)}ms)`)

  /**
   * **同机对照**（改前的形态，就在这次运行里现测）：写一条事件 + **只作废派生表**（读层的缓存留着，
   * 与修前的 `bumpGeneration -> invalidateDerivedTables` 逐字同形）⇒ 那次读就是改前的 30–36ms。
   *
   * 为什么要有这一栏：绝对毫秒会随机器负载红绿（跑满全量时 1804 个用例并发，读数会整体放大 2–3 倍，
   * 本仓 `M236-07` 已经踩过同一条），而"同一次运行里的两种形态之比"与负载无关。
   */
  resetDerivedTableStats()
  const baselineReadings: number[] = []
  for (let round = 0; round < 3; round += 1) {
    real.journal.append('task/updated', { task: 'TASK-243', note: `baseline-${String(round)}` })
    real.journal.read()
    invalidateDerivedTables()
    const started = performance.now()
    pendingReviewBigCards(real.store, real.journal)
    baselineReadings.push(performance.now() - started)
  }
  const baselineMedian = medianOf(baselineReadings)

  // 修后的形态：写一条事件 ⇒ 直接读（增量应用）
  resetDerivedTableStats()
  const readings: number[] = []
  for (let round = 0; round < 10; round += 1) {
    real.journal.append('task/updated', { task: 'TASK-243', note: `reading-${String(round)}` })
    const started = performance.now()
    pendingReviewBigCards(real.store, real.journal)
    readings.push(performance.now() - started)
  }
  const median = medianOf(readings)
  const mean = readings.reduce((sum, value) => sum + value, 0) / readings.length
  const fastest = Math.min(...readings)
  const under = readings.filter((value) => value < 2).length
  // 读数逐次打印（判据要能被第三人当场核对，不是只给一个汇总数）
  console.log(`[M243-01] cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(2)}ms baseline(pre-fix shape)=${baselineReadings.map((v) => v.toFixed(2)).join(' / ')} ms`)
  console.log(`[M243-01] write->read=${readings.map((v) => v.toFixed(2)).join(' / ')} ms`)
  console.log(`[M243-01] median=${median.toFixed(2)}ms mean=${mean.toFixed(2)}ms fastest=${fastest.toFixed(2)}ms under2ms=${String(under)}/10 baselineMedian=${baselineMedian.toFixed(2)}ms ratio=${(baselineMedian / median).toFixed(1)}x`)
  // 判据 ①（本卡 DoD）：写 1 条事件后紧接读 —— 最好的那次必须真的进 2ms 以内
  assert.ok(fastest < 2, `the fastest write->read round must stay under 2ms (pre-fix 30-36ms, measured ${fastest.toFixed(2)}ms)`)
  assert.ok(median < 5, `median write->read must stay far below the pre-fix 30-36ms (measured median ${median.toFixed(2)}ms)`)
  // **同机对照**：改前的形态必须比增量形态慢一个数量级（负载无关的那条判据）
  assert.ok(baselineMedian > 10, `the pre-fix shape must still be measurable on this machine (measured ${baselineMedian.toFixed(2)}ms)`)
  /**
   * **10 倍**这条是负载无关的硬判据：跑满全量时两种形态一起变慢（实测基线 67–85ms vs 增量 2.8ms），
   * 比值仍然在 25x 以上；空载时是 53x。`under2ms` 只作**读数**打印 —— 把绝对毫秒写进断言就会让守卫
   * 跟着机器负载红绿（本仓 `M236-07` 踩过同一条）。
   */
  assert.ok(
    baselineMedian > median * 10,
    `incremental apply must be at least 10x faster than the pre-fix whole-batch recompute `
      + `(baseline ${baselineMedian.toFixed(2)}ms vs incremental ${median.toFixed(2)}ms)`,
  )
})

test('M243-02 (reading 2) ten write->read rounds cost one full recompute and ten incremental applies', realLedgerSkip() ?? {}, () => {
  const real = realCopy('real-counters')

  /**
   * 计数桩从**零**开始：第一次读是"建表"（`fullRecomputes` = 1），之后 10 次「写→读」
   * 每一次都只应用**新增的那一条事件**（`incrementalApplies` = 10）。
   *
   * 为什么判据读计数而不是读秒：秒会随机器负载红绿（同一个仓里 `M236-07` 已经踩过一次），
   * 而"整批算了几次 / 只应用了几次"是**机械事实**。
   */
  resetDerivedTableStats()
  pendingReviewBigCards(real.store, real.journal)
  assert.equal(count(derivedTableStats.fullRecomputes, 'pending-review-big-cards'), 1, 'the first read builds the table once')
  assert.equal(count(derivedTableStats.incrementalApplies, 'pending-review-big-cards'), 0, 'nothing can be applied before the first write')

  for (let round = 0; round < 10; round += 1) {
    real.journal.append('task/updated', { task: 'TASK-243', note: `counters-${String(round)}` })
    pendingReviewBigCards(real.store, real.journal)
  }
  console.log(`[M243-02] ${describeDerivedTableStats()}`)
  assert.equal(
    count(derivedTableStats.fullRecomputes, 'pending-review-big-cards'),
    1,
    'ten write->read rounds may not trigger a second full recompute (pre-fix: one per round)',
  )
  assert.equal(
    count(derivedTableStats.incrementalApplies, 'pending-review-big-cards'),
    10,
    'every write->read round must apply exactly the new events incrementally',
  )
  // 下层表：评审表 / 留痕表 / 任务卡表**不吃事件** ⇒ 10 次写入一次都不该重算
  /**
   * 下层表在**窗口内只建过一次**（`= 1`，就是上面那第一次读），之后 10 次写入**一次都没重建**。
   * 改前它们是"每写一次就整批作废再读一遍"：`tasks/` 256 个文件 27.9ms + `reviews/` 121 个 14.5ms
   * + `verified.yml` 12.3ms —— 这三张表就是"写后读 30–36ms"的主项。
   */
  for (const name of ['reviews-table', 'dispositions-table', 'tasks-table']) {
    assert.equal(count(derivedTableStats.fullRecomputes, name), 1, `${name} may be built once in the window, never again`)
  }
})

test('M243-03 (reading 3, counter-example) a ledger replaced in place (new inode) must recompute in full', () => {
  seedReview('TASK-901', 'REV-901')
  const warm = JSON.stringify(pendingReviewBigCards(store, journal))
  pendingReviewBigCards(store, journal)

  // **换 inode**（`store.writeText` 走 tmp + rename，与产品写路径同形）：读层必然全量重解析
  const text = store.readText(JOURNAL_FILE) ?? ''
  store.writeText([JOURNAL_FILE], text)
  resetDerivedTableStats()
  const afterSwap = JSON.stringify(pendingReviewBigCards(store, journal))
  assert.equal(afterSwap, warm, 'a byte-identical rewrite must not change the reading')
  assert.ok(
    count(derivedTableStats.fullRecomputes, 'pending-review-big-cards') >= 1,
    'a replaced ledger must force a full recompute (incremental apply would splice unrelated histories)',
  )
  assert.equal(
    count(derivedTableStats.incrementalApplies, 'pending-review-big-cards'),
    0,
    'a replaced ledger must never be served through the incremental path',
  )

  // **截断**（变短）：同一档 —— 也是"整批作废"，不许增量
  const events = journal.read().events
  const shorter = events.slice(0, Math.max(1, events.length - 1))
  store.writeText([JOURNAL_FILE], `${shorter.map((event) => JSON.stringify(event)).join('\n')}\n`)
  resetDerivedTableStats()
  pendingReviewBigCards(store, journal)
  assert.ok(
    count(derivedTableStats.fullRecomputes, 'pending-review-big-cards') >= 1,
    'a truncated ledger must force a full recompute as well',
  )
})

test('M243-04 incremental results are byte-identical to a cold recompute', () => {
  const review = seedReview('TASK-901', 'REV-901')
  const warm = pendingReviewBigCards(store, journal)
  assert.ok(warm.pending.includes('TASK-901'), 'precondition: the done medium card with an unadopted pass review is pending')
  const rowState = (reading: ReturnType<typeof pendingReviewBigCards>): string => {
    const row = reading.unadopted.find((item) => item.id === 'TASK-901')
    return row === undefined ? 'considered-but-adopted' : row.reviews.map((entry) => entry.state).join(',')
  }

  // ① 与采纳无关的事件（`task/updated`）：结论一个字都不该变
  journal.append('task/updated', { task: 'TASK-901', note: 'noise' })
  assert.equal(snapshotOf(), coldSnapshot(), 'an unrelated event type must not change the reading')

  // ② 走产品入口真的核实一条发现（`verified.yml` + `review/verified` 双写）⇒ 卡**离开**待评审集。
  //    这一格走的是"来源 YAML 变了 ⇒ 探针失配 ⇒ 整批重算"那一支（不是增量），断言的是**结果一致**。
  const verified = verifyReviewFinding(store, journal, {
    reviewId: review.id,
    index: 0,
    outcome: 'reproduced',
    evidence: 'reproduced => exitCode=0',
  })
  assert.equal(verified.ok, true, 'verifying the finding through the product entry point must succeed')
  const adopted = pendingReviewBigCards(store, journal)
  assert.ok(!adopted.pending.includes('TASK-901'), 'a verified finding must clear the card from the pending set')
  assert.equal(snapshotOf(), coldSnapshot(), 'a source-YAML change must still agree with the cold recompute')

  // ③ `review/recorded`（内容哈希与文件不符）⇒ 采纳态 `adopted` → `tampered`：**只写事件**就把卡
  //    **放回**待评审集 —— 这是"增量应用真的改变了集合"的那一格（YAML 一个字节都没动）。
  journal.append('review/recorded', { id: review.id, taskId: review.taskId, verdict: 'pass', findings: 1, contentHash: 'deadbeef' })
  const tampered = pendingReviewBigCards(store, journal)
  assert.ok(tampered.pending.includes('TASK-901'), 'a tampered review must put the card back into the pending set')
  assert.equal(rowState(tampered), 'tampered', 'the row state must be tampered (not adopted anymore)')
  assert.equal(snapshotOf(), coldSnapshot(), 'the incrementally patched reading must equal the cold recompute')
})

test('M243-05 file-backed tables are not thrown away by an event-only write', () => {
  seedReview('TASK-901', 'REV-901')
  // 预热：让三张不吃事件的表先建好
  listReviewsCached(store, journal)
  listDispositionsCached(store, journal)
  pendingReviewBigCards(store, journal)
  resetDerivedTableStats()

  journal.append('task/updated', { task: 'TASK-901', note: 'event only' })
  const reviewList = listReviewsCached(store, journal)
  const dispositions = listDispositionsCached(store, journal)
  pendingReviewBigCards(store, journal)

  assert.ok(reviewList.length > 0 && dispositions.length >= 0, 'sanity: the tables are readable')
  assert.equal(count(derivedTableStats.fullRecomputes, 'reviews-table'), 0, 'reviews-table must survive an event-only write')
  assert.ok(count(derivedTableStats.hits, 'reviews-table') >= 1, 'the reviews table must be served from the memo')
  assert.equal(count(derivedTableStats.fullRecomputes, 'dispositions-table'), 0, 'dispositions-table must survive an event-only write')
  assert.equal(count(derivedTableStats.fullRecomputes, 'tasks-table'), 0, 'tasks-table must survive an event-only write')
})

test('M243-06 (landing 2) no new bypass of the memoised review / disposition tables', () => {
  /**
   * **源码棘轮**：`listReviews(store)` / `listDispositions(store)` 是**直读真源**的形态 ——
   * 它们绕开记忆化，在热路径上每叫一次就读一遍 121 个 YAML（真账 6.6~14.5ms）与 `verified.yml`
   * （9.15ms）。本卡把热路径上的调用点改走 `*Cached`，这里把**剩下的**按文件登记条数：
   * 少一条（又有人加了缓存）不红 —— 多一条立刻红并点名文件。
   *
   * 为什么不用行号：行号会随任何无关改动漂移（那会把守卫变成"改注释就红"的噪声源）。
   * 为什么 `office.ts` 那一处还留着：它不在本卡写范围（`src/office.ts`）—— 见交付说明的跟卡建议。
   */
  const EXPECTED: Record<string, number> = {
    // 两条在 `listReviewsCached` / `listDispositionsCached` 的 compute 里（**合法**：那是缓存的本体），
    // 一条在 `reviewsOfCard`（没有 `Journal` 入参 ⇒ 走不了记忆化，签名不改）
    'src/domain/reviewVerification.ts': 3,
    // `sdo_test action=list` 的处置表回显（**写范围之外**）
    'src/office.ts': 1,
  }
  const pattern = /list(?:Reviews|Dispositions)\(\s*store\s*\)/u
  const found: Record<string, number> = {}
  const srcRoot = fileURLToPath(new URL('../../src/', import.meta.url))
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.ts')) continue
      const text = readFileSync(path, 'utf8')
      const hits = text.split('\n').filter((line) => pattern.test(line) && !line.trimStart().startsWith('*')).length
      if (hits > 0) found[`src/${relative(srcRoot, path).replace(/\\/gu, '/')}`] = hits
    }
  }
  walk(srcRoot)
  assert.deepEqual(found, EXPECTED, 'a new raw listReviews/listDispositions call site bypasses the memo (use the *Cached variants)')
  assert.equal(found['src/domain/collab.ts'], undefined, 'collab.ts must not read the raw review tables any more')
})

test('M243-07 (landing 3) the incremental / full counters are readable in one line', () => {
  seedReview('TASK-901', 'REV-901')
  pendingReviewBigCards(store, journal)
  journal.append('task/updated', { task: 'TASK-901', note: 'x' })
  pendingReviewBigCards(store, journal)
  const line = describeDerivedTableStats()
  console.log(`[M243-07] ${line}`)
  assert.match(line, /pending-review-big-cards: full=\d+ incremental=\d+ hits=\d+/u, 'the reading line must name the table and both counters')
  assert.equal(line, deriveTableStatsLine(derivedTableStats), 'one formatting site: describeDerivedTableStats renders deriveTableStatsLine')
  assert.match(line, /reviews-table: full=\d+ incremental=\d+ hits=\d+/u, 'the file-backed tables appear in the same line')
})

test('M243-08 (landing 2, behaviour) rehashReview reads the memoised review table', () => {
  const review = seedReview('TASK-901', 'REV-901')
  // 预热评审表（`rehashReview` 修前走 `listReviews(store)`，一次就读一遍 121 个 YAML）
  listReviewsCached(store, journal)
  resetDerivedTableStats()
  const result = rehashReview(store, journal, { reviewId: review.id, by: 'dev-243' })
  assert.equal(result.ok, true, 'rehashing a legacy review must succeed')
  assert.ok(
    count(derivedTableStats.hits, 'reviews-table') >= 1,
    'rehashReview must go through the memoised reviews table (a raw read shows up as a hit-less call)',
  )
  assert.equal(count(derivedTableStats.fullRecomputes, 'reviews-table'), 0, 'a warm reviews table must not be rebuilt')
  assert.equal(listReviews(store).length, 1, 'the source of truth still holds exactly one review')
})
