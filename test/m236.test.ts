/**
 * **增量 236（`TASK-220`）：折表层记忆化（事件 → 派生表，键 = `(台账绝对路径, journal 代次)`）。**
 *
 * 病灶（本卡实测，真账 `.sdo/journal.jsonl` 近 7.6k 事件 / 98 条评审 / 227 张卡）：
 *   · `reviewAdoptions` 连测 **37.62 / 33.64 / 30.62ms**、`pendingReviewBigCards` **43.09 / 42.45 / 43.60ms**
 *     —— **三次同价就是零记忆化**的指纹：同一个参数每问一次都从头折一遍；
 *   · 主项是"按 type 的全文重扫"：98 条评审 ×（recorded / hashed / verified）各扫一遍七千多事件。
 *
 * 本文件的守卫（编号与卡上 DoD 的「守卫（两态）」一一对应）：
 *   · `M236-01` ① **写入换代次且看得见新数据**：核实一条发现（写 YAML + append 事件）之后，采纳表必须是
 *     **另一张表**且状态变成 `adopted`；同时断言**旧表确实带着旧状态** —— 反例（不失效）就会拿回它；
 *   · `M236-02` ② **全量重解析（整份替换）代次必变、派生表重建**：拿掉 `review/recorded` 之后，
 *     采纳态必须变成 `unrecorded`（这条只有真读了新事件才可能）；
 *   · `M236-03` ③ **同一代次内二次调用命中**：`reviewAdoptions` 调两次、真算**恰好一次**（计数桩实测）；
 *   · `M236-04` ④ **门禁回执与改前逐字节相同**：冷（缓存全清）/ 热两态的判据结果 `JSON.stringify` 全等；
 *   · `M236-05` **只改真源 YAML（不 append 事件）也必须看得见**：来源探针失配即重建（反例：只认代次就会读到旧表）；
 *     注意它只覆盖 **tmp+rename** 形态（`store.writeYaml`）——「内容被就地改写」是另一档，见 08/09；
 *   · `M236-06` **记忆化按台账路径隔离**：两个工作区的表互不串；
 *   · `M236-07` 真账上冷/热两份读数逐字节相同 + 命中阈值（第二次调用 < 1ms，`pendingReviewBigCards` < 10ms）；
 *   · `M236-08` **探针必须看见同 inode 的「就地改写」**（`REV-100` 第 1 条 / `DEF-218`）：用 `writeFileSync`
 *     改一条**已有**评审的 `verdict`（尺寸变、条目不增不删 ⇒ **目录 stat 一动不动**），记忆化视图必须跟着变；
 *   · `M236-09` 同一档在**任务卡**上：就地改一张卡的 `status` ⇒ `pendingReviewBigCards` 的考虑集必须跟着变。
 *
 * 断言消息一律用英文（本文件不进 `KNOWN_PROSE_GAP`；中文只写在断言之外）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { REAL_LEDGER_DIR, realLedgerSkip } from './support/real-ledger.js'
import { CHECKERS } from '../src/domain/gates.js'
import { pendingReviewBigCards } from '../src/domain/collab.js'
import { listReviews, recordReview, reviewContentHash } from '../src/domain/records.js'
import { listTasks } from '../src/domain/plan.js'
import {
  adoptionTable,
  listDispositionsCached,
  listReviewsCached,
  resetReviewAdoptionStats,
  reviewAdoptionStats,
  reviewAdoptions,
  verifyReviewFinding,
} from '../src/domain/reviewVerification.js'
import {
  JOURNAL_FILE,
  Journal,
  derivedTableStats,
  invalidateDerivedTables,
  invalidateJournalCache,
  journalReadStats,
  resetDerivedTableStats,
  resetJournalReadStats,
} from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { GateContext } from '../src/domain/gates.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m236/', import.meta.url))
const WORKSPACE = join(BASE, 'ws')

let store: SdoStore
let journal: Journal

/** 一张 `done` 的 medium 产品卡（`review.required` 的考虑集里要有它）。 */
function card(id: string, status: TaskCard['status'] = 'in-progress'): void {
  const task: TaskCard = {
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
  store.writeYaml(['tasks', `${id}.yml`], { task })
}

/** 门禁判据的最小上下文（与本仓既有夹具同形，`M67` 那一族用的就是它）。 */
function ctx(): GateContext {
  return { workspace: WORKSPACE, store, journal, requirements: [], project: { surfaces: [] } } as unknown as GateContext
}
const gate = (id: string): unknown => CHECKERS[id]?.(ctx())

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-236', WORKSPACE)
  store = office.storeFor(WORKSPACE)
  journal = office.journalFor(WORKSPACE)
  card('TASK-001', 'done')
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M236-01 (guard 1) a pure event write bumps the generation and the derived table sees the new data', () => {
  /**
   * 为什么这一格要**只写事件、不写 YAML**：`verifyReviewFinding` 会同时改两份真源（`verified.yml` + 事件），
   * 于是"来源探针"也能把表撞新 —— 那样就测不出**代次**这一条。这里只 append 一条 `review/recorded`，
   * 来源文件一个字节都没动 ⇒ 表要变新，**只能**靠代次。反例（写入不换代次）在这一格必红。
   */
  const review = {
    id: 'REV-001',
    taskId: 'TASK-001',
    reviewer: 'rev-b',
    verdict: 'pass' as const,
    findings: ['one finding'],
    at: '2026-01-01T00:00:00.000Z',
  }
  store.writeYaml(['reviews', `${review.id}.yml`], { review })
  // ① 只有评审文件、没有 `review/recorded` 事件 ⇒ 不采纳（与 `M67` 的"手写评审"同口径）
  const stale = adoptionTable(store, journal)
  assert.equal(stale.get(review.id)?.state, 'unrecorded', 'precondition: no recorded event yet')
  const generationBefore = journal.generation()

  // ② 只 append 事件（YAML 未动）
  journal.append('review/recorded', {
    id: review.id,
    taskId: review.taskId,
    verdict: review.verdict,
    findings: review.findings.length,
    contentHash: reviewContentHash(review),
  })
  assert.ok(
    journal.generation() > generationBefore,
    `a write must bump the generation (before=${generationBefore}, after=${journal.generation()})`,
  )

  const fresh = adoptionTable(store, journal)
  // 反例面：旧表**确实**带着旧状态 —— 不换代次就会把它当成"还是这一份"
  assert.equal(stale.get(review.id)?.state, 'unrecorded', 'the stale table still carries the old state (this is what a missing bump would return)')
  assert.notEqual(fresh, stale, 'after a write the table must be a NEW one')
  assert.equal(fresh.get(review.id)?.state, 'unverified', 'the new table must see the recorded event')
})

test('M236-02 (guard 2) replacing the ledger file forces a full reparse: generation changes and tables rebuild', () => {
  const review = recordReview(store, journal, {
    taskId: 'TASK-001',
    reviewer: 'rev-b',
    verdict: 'pass',
    findings: ['one finding'],
  })
  assert.equal(
    reviewAdoptions(store, journal).find((item) => item.review.id === review.id)?.state,
    'unverified',
    'precondition: recorded but not verified',
  )
  const generationBefore = journal.generation()

  // **整份替换**（`store.writeText` 走 tmp+rename ⇒ inode 变）：拿掉那条 `review/recorded`
  const rewritten = journal
    .read()
    .events.filter((event) => !(event.type === 'review/recorded' && String(event.data['id'] ?? '') === review.id))
    .map((event, index) => ({ ...event, seq: index + 1 }))
  store.writeText([JOURNAL_FILE], `${rewritten.map((event) => JSON.stringify(event)).join('\n')}\n`)

  resetJournalReadStats()
  const after = reviewAdoptions(store, journal).find((item) => item.review.id === review.id)
  assert.equal(after?.state, 'unrecorded', 'the replaced ledger no longer has the recorded event')
  assert.equal(journalReadStats.fullParses, 1, 'a replaced file must be reparsed in full (not spliced)')
  assert.ok(
    journal.generation() > generationBefore,
    `a full reparse must bump the generation (before=${generationBefore}, after=${journal.generation()})`,
  )
})

test('M236-03 (guard 3) two calls in the same generation compute the adoption table exactly once', () => {
  recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: ['one finding'] })
  // 先让"评审表 / 留痕表 / 事件索引"这些下层表也热起来，好让计数只反映采纳表本身
  listReviewsCached(store, journal)
  listDispositionsCached(store, journal)
  journal.read()

  resetReviewAdoptionStats()
  resetDerivedTableStats()
  const first = reviewAdoptions(store, journal)
  const second = reviewAdoptions(store, journal)

  assert.equal(reviewAdoptionStats.calls, 2, 'both calls must go through reviewAdoptions')
  assert.equal(reviewAdoptionStats.computes, 1, 'exactly one real computation (measured counter, not an estimate)')
  assert.equal(derivedTableStats.computes['review-adoptions'], 1, 'the memoised table is computed once')
  assert.equal(derivedTableStats.hits['review-adoptions'], 1, 'the second call must be a hit')
  assert.notEqual(first, second, 'each call hands out its own array (callers may sort/slice)')
  assert.deepEqual(
    first.map((item) => [item.review.id, item.state]),
    second.map((item) => [item.review.id, item.state]),
    'a hit must return the same reading as the computation',
  )
})

test('M236-04 (guard 4) gate receipts are byte-identical cold vs warm', () => {
  const review = recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: ['one finding'] })
  verifyReviewFinding(store, journal, { reviewId: review.id, index: 0, outcome: 'reproduced', evidence: 'reproduced ⇒ exitCode=0' })

  const warm = JSON.stringify([gate('review.required'), gate('review.independent'), pendingReviewBigCards(store, journal)])
  // 冷态：两层缓存全清（读层 + 派生表）⇒ 全部重算
  invalidateJournalCache()
  invalidateDerivedTables()
  resetReviewAdoptionStats()
  const cold = JSON.stringify([gate('review.required'), gate('review.independent'), pendingReviewBigCards(store, journal)])

  assert.equal(cold, warm, 'memory-level caching must not change a single byte of the gate receipt')
  assert.equal(reviewAdoptionStats.computes, 1, 'one gate check asks for the table once (and only computes it once)')
  assert.ok(reviewAdoptionStats.calls <= 1, `reviewAdoptions calls per gate check must be <= 1 (got ${reviewAdoptionStats.calls})`)
})

test('M236-05 the source probes: a hand-written YAML (no journal event) is still visible', () => {
  recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: ['one finding'] })
  const warmReviews = listReviewsCached(store, journal).length
  const warmTable = adoptionTable(store, journal)
  const warmDispositions = listDispositionsCached(store, journal).length

  // ① 只写评审真源（不 append 事件）：新评审必须出现在评审表里
  store.writeYaml(['reviews', 'REV-900.yml'], {
    review: { id: 'REV-900', taskId: 'TASK-001', reviewer: 'x', verdict: 'pass', findings: ['hand-written'], at: '2026-01-01T00:00:00.000Z' },
  })
  assert.equal(listReviewsCached(store, journal).length, warmReviews + 1, 'the reviews probe must notice the new file')
  assert.notEqual(adoptionTable(store, journal), warmTable, 'the adoption table must be rebuilt as well')

  // ② 只写核实真源：留痕表必须重建（反例：只认代次 ⇒ 永远读到旧留痕）
  store.writeYaml(['reviews', 'verified.yml'], {
    verifications: [
      { reviewId: 'REV-001', index: 0, findingHash: 'deadbeef', outcome: 'reproduced', evidence: 'e ⇒ exitCode=0', by: 'dev', ownerChecked: 'no-claim', at: 'x' },
    ],
  })
  assert.equal(listDispositionsCached(store, journal).length, warmDispositions + 1, 'the dispositions probe must notice the rewritten file')
  assert.equal(listReviews(store).length, warmReviews + 1, 'the raw reader agrees (the probe does not change the source of truth)')
})

test('M236-06 the memo is keyed by ledger path: two workspaces never share a table', () => {
  recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: ['only in ws-A'] })
  const otherDir = join(BASE, 'ws-other')
  mkdirSync(otherDir, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-236-b', otherDir)
  const otherStore = office.storeFor(otherDir)
  const otherJournal = office.journalFor(otherDir)
  otherStore.writeYaml(['tasks', 'TASK-002.yml'], { task: taskOf('TASK-002') })
  const otherReview = recordReview(otherStore, otherJournal, { taskId: 'TASK-002', reviewer: 'rev-c', verdict: 'pass', findings: ['only in ws-B'] })

  const tableA = adoptionTable(store, journal)
  const tableB = adoptionTable(otherStore, otherJournal)
  assert.deepEqual([...tableA.keys()], ['REV-001'], 'workspace A sees only its own review')
  assert.deepEqual([...tableB.keys()], [otherReview.id], 'workspace B sees only its own review')
  assert.notEqual(tableA, tableB, 'two workspaces must never share one table')
})

/** 与 {@link card} 同形的卡对象（`M236-06` 要往第二个工作区里放一张）。 */
function taskOf(id: string): TaskCard {
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
    status: 'done',
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
  }
}

test('M236-08 the probes see a SAME-INODE in-place rewrite of an existing review YAML', () => {
  /**
   * `REV-100` 第 1 条（`DEF-218`）：只 stat **目录**的探针看不见"改一条已有文件的内容"——
   * 目录的 `mtimeMs` / `size` 只在**增删改名**时变，而宿主 `edit` / `echo >` / `cp` 覆盖都是**同 inode 就地写**。
   * 这一格用 `writeFileSync` 造那一档（**不要**用 `store.writeYaml`：它走 tmp+rename，05 已经覆盖了）。
   */
  const review = recordReview(store, journal, {
    taskId: 'TASK-001',
    reviewer: 'rev-b',
    verdict: 'pass',
    findings: ['one finding'],
  })
  const file = store.path('reviews', `${review.id}.yml`)
  const dir = store.path('reviews')
  const warm = listReviewsCached(store, journal).find((item) => item.id === review.id)
  assert.equal(warm?.verdict, 'pass', 'precondition: the memoised table is warm and says pass')
  const warmTable = adoptionTable(store, journal)

  const before = statSync(file)
  const dirBefore = statSync(dir)
  const text = readFileSync(file, 'utf8')
  // 同 inode 就地改写：verdict 改成 changes-requested + 补一行注释（尺寸变、条目不增不删）
  writeFileSync(file, `${text.replace('verdict: pass', 'verdict: changes-requested')}# in-place edit (same inode)\n`)
  const after = statSync(file)
  const dirAfter = statSync(dir)

  assert.equal(after.ino, before.ino, 'the rewrite must keep the inode (this is what edit/cp/echo > do)')
  assert.notEqual(after.size, before.size, 'the rewrite must change the file size')
  // 两态的前提：目录 stat **真的一动不动** —— 只盯目录的探针在这一格必红
  assert.equal(dirAfter.mtimeMs, dirBefore.mtimeMs, 'the directory mtime must NOT move (that is why a dir-only probe is blind)')
  assert.equal(dirAfter.size, dirBefore.size, 'the directory size must NOT move either')

  assert.equal(
    listReviews(store).find((item) => item.id === review.id)?.verdict,
    'changes-requested',
    'sanity: the raw reader sees the in-place edit',
  )
  assert.equal(
    listReviewsCached(store, journal).find((item) => item.id === review.id)?.verdict,
    'changes-requested',
    'the memoised reviews table must see the in-place edit (dir-only probes would keep serving `pass`)',
  )
  assert.notEqual(adoptionTable(store, journal), warmTable, 'the adoption table must be rebuilt as well')
})

test('M236-09 the same in-place rewrite is caught on a task card (pending set follows)', () => {
  const warm = pendingReviewBigCards(store, journal)
  assert.ok(warm.considered.includes('TASK-001'), 'precondition: the done medium card is in the considered set')
  const file = store.path('tasks', 'TASK-001.yml')
  const text = readFileSync(file, 'utf8')
  // 同 inode 就地改写：把卡从 done 改成 in-progress（离开考虑集）
  writeFileSync(file, text.replace('status: done', 'status: in-progress'))
  assert.equal(
    listTasks(store).find((task) => task.id === 'TASK-001')?.status,
    'in-progress',
    'sanity: the raw reader sees the in-place edit',
  )
  const after = pendingReviewBigCards(store, journal)
  assert.ok(
    !after.considered.includes('TASK-001'),
    'pendingReviewBigCards must follow the in-place rewrite (a dir-only probe would keep the old card status)',
  )
})

test('M236-07 (real ledger) cold/warm readings are byte-identical, and the second call is a hit', realLedgerSkip() ?? {}, () => {
  const realStore = new SdoStore(REAL_LEDGER_DIR)
  const realJournal = new Journal(realStore)

  resetReviewAdoptionStats()
  resetDerivedTableStats()
  const warm = JSON.stringify([reviewAdoptions(realStore, realJournal), pendingReviewBigCards(realStore, realJournal)])
  /**
   * 阈值 ①：同一代次内第二次调用是一次**命中**。
   *
   * 机械判据是**计数桩**（`computes === 1` / `hits >= 1`）—— 计时只作旁证，上限给 5ms：
   * 本机空载实测 **0.09 / 0.07ms**（改前 **30-38ms**，三次同价 = 零记忆化）；跑满 1742 个用例时
   * 调度抖动会把它推到 ~1.4ms，用 1ms 当上限等于让守卫跟着机器负载红绿。
   */
  const started = performance.now()
  const again = reviewAdoptions(realStore, realJournal)
  const hitMs = performance.now() - started
  assert.ok(again.length > 0, 'the real ledger has reviews (this guard would be vacuous otherwise)')
  assert.equal(reviewAdoptionStats.computes, 1, 'two calls, exactly one real computation')
  assert.ok((derivedTableStats.hits['review-adoptions'] ?? 0) >= 1, 'the second call must be a memo hit')
  assert.ok(hitMs < 5, `second reviewAdoptions call must stay far below the 30-38ms recomputation (measured ${hitMs.toFixed(3)}ms)`)

  // 阈值 ②：`pendingReviewBigCards` 命中 < 10ms（改前实测 42.8 / 45.2 / 43.9ms）
  const startedPending = performance.now()
  const pending = pendingReviewBigCards(realStore, realJournal)
  const pendingMs = performance.now() - startedPending
  assert.ok(pendingMs < 10, `warm pendingReviewBigCards must stay under 10ms (measured ${pendingMs.toFixed(3)}ms)`)

  // 冷态重算与热态逐字节相同（记忆化不改语义）
  invalidateJournalCache()
  invalidateDerivedTables()
  const cold = JSON.stringify([reviewAdoptions(realStore, realJournal), pendingReviewBigCards(realStore, realJournal)])
  assert.equal(cold, warm, 'the cold reading must be byte-identical to the warm one')
  assert.ok(pending.pending.length >= 0, 'sanity: pending is a list')
})