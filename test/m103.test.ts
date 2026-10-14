/**
 * **verify-review 的 index 基准与证词挂靠**（修复 DEF-043）。
 *
 * 背景（用户 2026-10-13 裁定「优先修影响台账的缺陷」）：核实台账是**审计链的核心**
 * （C-42 / C-52 只认被采纳的 pass）。旧实现里：
 *   - 参数对外是 **1 起**（`src/index.ts` 转换 `args.index - 1` 后交给领域层）；
 *   - 越界回执印的是 `input.index + 1`（= **参数值**），成功回执印 `args.index`（= **参数值**）
 *     ⇒ 两类回执**都印参数基准**，而**台账 index 从不出现在任何回执里**；
 *   - 事件只记 0 起的 `index`，**不记该条发现是什么** ⇒ 证词挂到哪条发现，事后看不出来 ✗。
 *
 * 本文件钉四态（全部断言到**具体条目**，不只断言布尔）：
 *   ① 参数 1 ⇒ 落台账第 0 条，回执**双写**（参数第 N 条 + 台账 index N-1）且能读出该条发现标题；
 *   ② 参数 0（越界）⇒ 拒绝，且拒绝文案与成功回执**同一基准**（都点名参数值与台账 index）；
 *   ③ 参数 N+1（越界）⇒ 拒绝并点名**合法范围**；
 *   ④ 评审没有 findings ⇒ **可读拒绝**（不是崩、也不是静默当通过）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { recordReview } from '../src/domain/records.js'
import { verifyReviewFinding } from '../src/domain/reviewVerification.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm103')
let store: SdoStore
let journal: Journal

/** 两条发现：第一条是"正面核对"，第二条是"能力边界"——与真机评审的常见构成一致。 */
const FINDING_A = '【可单条复算·核过什么】落点与契约真源：contract-first.yml 第 7 行起有本卡条目。'
const FINDING_B = '【未核实·能力边界】本卡三条 artifact 的 sha256 我无法复算（reviewer 掩码无 bash）。'

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function seedReview(): string {
  return recordReview(store, journal, {
    taskId: 'TASK-001',
    reviewer: 'rev-a',
    verdict: 'pass',
    findings: [FINDING_A, FINDING_B],
  }).id
}

// ————————————————————— ① 参数 1 ⇒ 台账第 0 条 + 双写 + 读出发现标题 —————————————————————

test('M103-01 参数 index=1 ⇒ 落到台账第 0 条，回执双写参数与台账两个基准，并写出该条发现首句', () => {
  const reviewId = seedReview()
  // 领域层契约：index 是 0 起（`src/index.ts` 负责把参数的 1 起减成 0 起）
  const result = verifyReviewFinding(store, journal, {
    reviewId, index: 0, outcome: 'reproduced', evidence: '我现读 contract-first.yml 第 7 行命中',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.disposition.index, 0, '参数 1 ⇒ 台账第 0 条（不得落到第 1 条）')
  assert.equal(result.findingIndex, 1, '回执要报**参数基准**的序号（1 起）——与使用者输入同口径')
  assert.match(result.findingExcerpt, /contract-first\.yml/, '回执/事件要写明挂到了**哪条发现**（首句）')
  assert.ok(
    result.findingExcerpt.includes('落点与契约真源'),
    `首句应当取自第 0 条发现而不是别条：${result.findingExcerpt}`,
  )
})

test('M103-01b 挂靠必须区分相邻两条发现（防止"看起来挂了、其实挂错"）', () => {
  const reviewId = seedReview()
  const result = verifyReviewFinding(store, journal, {
    reviewId, index: 1, outcome: 'refuted', evidence: '掩码无 bash，给出反证：本会话无该工具',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.disposition.index, 1, '参数 2 ⇒ 台账第 1 条')
  assert.equal(result.findingIndex, 2)
  assert.match(result.findingExcerpt, /能力边界/, '第二条的首句必须来自第二条（不是第一条）')
  assert.equal(result.findingExcerpt.includes('contract-first.yml'), false, '不得把第一条的首句当成第二条')
})

// ————————————————————— ② 参数 0（越界）⇒ 拒绝且与成功同一基准 —————————————————————

test('M103-02 参数 index=0（越界）⇒ 拒绝，且拒绝文案与成功回执使用同一双写基准', () => {
  const reviewId = seedReview()
  // 参数 0 ⇒ 转换后领域收到 -1
  const result = verifyReviewFinding(store, journal, {
    reviewId, index: -1, outcome: 'reproduced', evidence: 'x',
  })
  assert.equal(result.ok, false, '参数 0 必须被拒（旧实现文案说"找不到第 0 条"，与成功回执不同基准）')
  if (result.ok) return
  assert.equal(result.code, 'bad-index')
  assert.match(result.detail, /台账 index/, '拒绝文案必须点名**台账 index** 这一基准（与成功回执同款双写）')
  assert.match(result.detail, /第 1 条|第 0 条/, '拒绝文案必须点名**参数基准**的序号')
  assert.match(result.detail, /合法范围|1[-–]2/, '必须点名合法范围')
})

// ————————————————————— ③ 参数 N+1（越界）⇒ 点名合法范围 —————————————————————

test('M103-03 参数 index=3（N+1 越界）⇒ 拒绝并点名合法范围 1-2', () => {
  const reviewId = seedReview()
  const result = verifyReviewFinding(store, journal, {
    reviewId, index: 2, outcome: 'reproduced', evidence: 'x',
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'bad-index')
  assert.match(result.detail, /1[-–]2/, `越界回执要点名合法范围 1-2：${result.detail}`)
  assert.match(result.detail, /台账 index/, '并给出台账基准，避免使用者只能试错')
})

// ————————————————————— ④ 空 findings ⇒ 可读拒绝 —————————————————————

test('M103-04 评审没有任何 findings ⇒ 可读拒绝（不崩、也不静默通过）', () => {
  const review = recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'rev-a', verdict: 'pass', findings: [] })
  const result = verifyReviewFinding(store, journal, {
    reviewId: review.id, index: 0, outcome: 'reproduced', evidence: 'x',
  })
  assert.equal(result.ok, false, '没有发现可核 ⇒ 必须拒绝')
  if (result.ok) return
  assert.equal(result.code, 'bad-index')
  assert.match(result.detail, new RegExp(review.id), '拒绝文案必须点名**是哪条评审**')
  assert.match(result.detail, /0 条发现|没有发现/, `要点明该评审没有发现可核：${result.detail}`)
})

// ————————————————————— 落点二：事件也要写明挂到哪条发现 —————————————————————

test('M103-05 journal 事件必须写明"挂到哪条发现"（不只写 0 起 index）', () => {
  const reviewId = seedReview()
  verifyReviewFinding(store, journal, {
    reviewId, index: 0, outcome: 'reproduced', evidence: '现读现算',
  })
  const event = journal.read().events.filter((item) => item.type === 'review/verified').pop()
  assert.ok(event !== undefined, '核实必须落一条 review/verified 事件')
  if (event === undefined) return
  assert.equal(event.data['index'], 0, '台账基准的 index 仍要如实记（0 起）')
  const excerpt = String(event.data['findingExcerpt'] ?? '')
  assert.match(excerpt, /落点与契约真源/, '事件里要带上该条发现的首句 —— 否则事后看不出证词挂到哪条')
  assert.equal(Number(event.data['findingIndex']), 1, '事件里也要有参数基准的序号，两个基准当场可见')
})
