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
import { claim } from '../src/domain/collab.js'

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
    reviewId, index: 0, outcome: 'reproduced', evidence: '我现读 contract-first.yml 第 7 行命中 ⇒ exitCode=0',
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
    reviewId, index: -1, outcome: 'reproduced', evidence: 'x ⇒ exitCode=0',
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
    reviewId, index: 2, outcome: 'reproduced', evidence: 'x ⇒ exitCode=0',
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
    reviewId: review.id, index: 0, outcome: 'reproduced', evidence: 'x ⇒ exitCode=0',
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
    reviewId, index: 0, outcome: 'reproduced', evidence: '现读现算 ⇒ exitCode=0',
  })
  const event = journal.read().events.filter((item) => item.type === 'review/verified').pop()
  assert.ok(event !== undefined, '核实必须落一条 review/verified 事件')
  if (event === undefined) return
  assert.equal(event.data['index'], 0, '台账基准的 index 仍要如实记（0 起）')
  const excerpt = String(event.data['findingExcerpt'] ?? '')
  assert.match(excerpt, /落点与契约真源/, '事件里要带上该条发现的首句 —— 否则事后看不出证词挂到哪条')
  assert.equal(Number(event.data['findingIndex']), 1, '事件里也要有参数基准的序号，两个基准当场可见')
})

test('M103-07 §3.5（`DEF-100`）`reproduced` 的证词必须含**可读读数**：占位文本 ⇒ 拒且零写盘；有读数 / 反证散文 ⇒ 放行', () => {
  const reviewId = seedReview()
  const before = journal.read().events.length
  // ① 占位文本（`x` / `复现成功`）⇒ 拒，且**零写盘**（不落核实台账、不落事件）
  for (const placeholder of ['x', '复现成功', '照着发现能复现']) {
    const rejected = verifyReviewFinding(store, journal, { reviewId, index: 0, outcome: 'reproduced', evidence: placeholder })
    assert.equal(rejected.ok, false, `占位证词必须被拒：${placeholder}`)
    if (!rejected.ok) assert.equal(rejected.code, 'placeholder-evidence', `拒绝码必须是 placeholder-evidence：${placeholder}`)
  }
  assert.equal(journal.read().events.length, before, '被拒时**不许**落事件（零写盘）')
  assert.deepEqual(store.readYaml<{ verifications?: unknown }>('reviews', 'verified.yml')?.verifications ?? [], [], '被拒时**不许**落核实台账')
  // ② 三种合法读数各一格（`⇒` / `exitCode` / 64 位十六进制）
  const readings = ['node --test ⇒ 12 pass', 'exitCode=1，且 stderr 首行是 ENOENT', `sha256=${'a'.repeat(64)}`]
  for (const [offset, evidence] of readings.entries()) {
    const ok = verifyReviewFinding(store, journal, { reviewId, index: offset === 2 ? 1 : offset, outcome: 'reproduced', evidence, ...(offset > 0 ? { revise: true } : {}) })
    assert.equal(ok.ok, true, `读数形态必须放行：${evidence}`)
  }
  // ③ 反例：`refuted` 给**反证散文**（没有读数形态）⇒ 放行（反证不是复现）
  const refuted = verifyReviewFinding(store, journal, { reviewId, index: 1, outcome: 'refuted', evidence: '掩码无 bash，本会话给不出该命令的输出', revise: true })
  assert.equal(refuted.ok, true, '`refuted` 的反证可以是散文（约束只针对 `reproduced`）')
})

test('M103-08 §3.5（`DEF-100`）`revise` 留痕：事件带 `supersedes`（被覆盖那条的 outcome/by/at），台账每个 `(评审,发现)` 只有一行', () => {
  const reviewId = seedReview()
  const first = verifyReviewFinding(store, journal, { reviewId, index: 0, outcome: 'refuted', evidence: '反证：原文与契约不一致', by: 'dev-a' })
  assert.equal(first.ok, true)
  const second = verifyReviewFinding(store, journal, { reviewId, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 12 pass', by: 'dev-b', revise: true })
  assert.equal(second.ok, true, '显式 revise 必须放行')
  const events = journal.read().events.filter((event) => event.type === 'review/verified')
  assert.equal(events.length, 2, '两次核实各落一条事件（留痕，不删历史）')
  const supersedes = events[1]?.data['supersedes'] as { outcome?: string; by?: string; at?: string } | undefined
  assert.ok(supersedes !== undefined, '**覆盖事件必须带 `supersedes`**（否则审计看不出"改过判"）')
  assert.equal(supersedes?.outcome, 'refuted', '`supersedes` 要写明被覆盖那条的判定')
  assert.equal(supersedes?.by, 'dev-a', '`supersedes` 要写明被覆盖那条的核实者')
  // 派生只计最新：同一 `(评审, 发现)` 在台账里只有一行，且是**后写**的那条
  const rows = (store.readYaml<{ verifications?: { reviewId: string; index: number; outcome: string; by: string }[] }>('reviews', 'verified.yml')?.verifications ?? [])
    .filter((row) => row.reviewId === reviewId && row.index === 0)
  assert.equal(rows.length, 1, '同一 `(评审, 发现)` 只许一行（派生只计最新）')
  assert.equal(rows[0]?.outcome, 'reproduced', '留下的必须是后写的那条')
  assert.equal(rows[0]?.by, 'dev-b', '留下的必须是后写的那条的核实者')
})

test('M103-09 §3.7（`DEF-099`）四种调用形状：owner / 非实现方（含评审作者）/ 无认领 / 任期结束后同角色代核（异角色有确定出路）', () => {
  const seedCard = (status: 'in-progress' | 'done', owner: string): void => {
    store.writeYaml(['tasks', 'TASK-001.yml'], {
      task: {
        id: 'TASK-001', title: 'TASK-001', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
        blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size: 'medium', revision: 1, status, owner,
        requirements: [], evidence: [], createdAt: '', updatedAt: '',
      },
    })
  }
  const dispatch = (childSessionId: string, role: string, settled: boolean): void => {
    journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId, tools: 9, role })
    if (settled) journal.append('dispatch/finished', { childSessionId, task: 'TASK-001', role, turn: 1, reason: 'completed', startedAt: '', finishedAt: '', durationMs: 1, report: 'x' })
  }
  const reviewOf = (): string => recordReview(store, journal, {
    taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: [FINDING_A], sessionId: 'child-rev', taskRole: 'developer',
  }).id
  // ① **owner 自己核**（卡在进行中 + 认领者就是核实者）⇒ 放行，标 `session`
  //    认领只能发生在 `ready` 卡上（`claim` 的前置）⇒ 先 ready 再认领，然后把卡置成 in-progress
  seedCard('ready' as never, '')
  assert.equal(claim(store, journal, { taskId: 'TASK-001', owner: 'dev-a', expectedRevision: 1, sessionId: 'child-a' }).ok, true)
  seedCard('in-progress', 'dev-a')
  dispatch('child-a', 'developer', false)
  const reviewId = reviewOf()
  const owner = verifyReviewFinding(store, journal, { reviewId, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-a' })
  assert.equal(owner.ok, true, '实现方自己核实必须放行')
  if (owner.ok) assert.equal(owner.disposition.ownerChecked, 'session', '必须标 session（不是 no-claim/tenure-over）')
  // ② **非实现方**：a) **评审作者本人** ⇒ 连"自己核自己"都过不了（更强：`self-verify`）；
  //    b) 一个无关会话 ⇒ `not-implementer` 并点名真正的实现方。**两种都不把评审作者当实现者**
  const reviewerAsImplementer = verifyReviewFinding(store, journal, { reviewId, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-rev' })
  assert.equal(reviewerAsImplementer.ok, false, '评审作者不能冒充实现方')
  if (!reviewerAsImplementer.ok) {
    assert.equal(reviewerAsImplementer.code, 'self-verify', '评审作者自己核自己 ⇒ self-verify（比 not-implementer 更早的闸）')
  }
  const stranger = verifyReviewFinding(store, journal, { reviewId, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-x' })
  assert.equal(stranger.ok, false, '无关会话不能代核（实现方仍在飞）')
  if (!stranger.ok) {
    assert.equal(stranger.code, 'not-implementer', '拒绝码必须是 not-implementer')
    assert.match(stranger.detail, /child-a/u, '必须点名真正的实现方会话')
  }
  // ③ **没有认领**（老数据 / 认领事件丢了）⇒ 放行并**如实标** `no-claim`（不退回"评审作者 = 实现者"）
  rmSync(join(BASE, '.sdo', 'journal.jsonl'), { force: true })
  const freshReview = reviewOf()
  const noClaim = verifyReviewFinding(store, journal, { reviewId: freshReview, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-a' })
  assert.equal(noClaim.ok, true, '拿不到认领必须放行（否则老数据永久不可采纳）')
  if (noClaim.ok) assert.equal(noClaim.disposition.ownerChecked, 'no-claim', '必须如实标 no-claim')
  // ④ **任期结束**（卡已 done + 实现方派发已结算）⇒ **同角色**代核放行；**异角色**拒（确定出路 = 同角色代核或先改卡角色）
  const tenureCard = (): void => {
    store.writeYaml(['tasks', 'TASK-001.yml'], {
      task: {
        id: 'TASK-001', title: 'TASK-001', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
        blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size: 'medium', revision: 1, status: 'done', owner: 'dev-a',
        requirements: [], evidence: [], createdAt: '', updatedAt: '',
      },
    })
  }
  tenureCard()
  journal.append('task/claimed', { id: 'TASK-001', owner: 'dev-a', sessionId: 'child-a', at: '' })
  dispatch('child-a', 'developer', true)
  const tenureReview = reviewOf()
  const sameRole = verifyReviewFinding(store, journal, { reviewId: tenureReview, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-a2' })
  // child-a2 没有派发记录 ⇒ 角色不明 ⇒ 不判跨角色；显式给一个 **developer** 派发再核
  dispatch('child-a2', 'developer', false)
  const sameRole2 = verifyReviewFinding(store, journal, { reviewId: tenureReview, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-a2', revise: true })
  assert.equal(sameRole2.ok, true, '任期结束后**同角色**代核必须放行（确定出路）')
  if (sameRole2.ok) assert.equal(sameRole2.disposition.ownerChecked, 'owner-tenure-over', '必须如实标 owner-tenure-over')
  void sameRole
  dispatch('child-t', 'tester', false)
  const crossRole = verifyReviewFinding(store, journal, { reviewId: tenureReview, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-t', revise: true })
  assert.equal(crossRole.ok, false, '异角色代核必须拒（2026-10-08 用户口径）')
  if (!crossRole.ok) {
    assert.equal(crossRole.code, 'cross-role-verifier', '拒绝码必须是 cross-role-verifier')
    assert.match(crossRole.detail, /developer/u, '回执要点名该卡的角色（改法的起点）')
  }
})

test('M103-10 §3.7（`DEF-099` 真机第三副面孔）认领后**释放**即结束任期：当前没有 owner ⇒ 代录放行并标 `claim-released`（不许粘在旧会话上）', () => {
  const seedCard = (status: 'in-progress'): void => {
    store.writeYaml(['tasks', 'TASK-001.yml'], {
      task: {
        id: 'TASK-001', title: 'TASK-001', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
        blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size: 'medium', revision: 1, status, owner: 'dev-a',
        requirements: [], evidence: [], createdAt: '', updatedAt: '',
      },
    })
  }
  seedCard('in-progress')
  // 真机形状（TASK-145）：认领（子会话） → 驾驶舱释放 → 评审会话代录
  journal.append('task/claimed', { id: 'TASK-001', owner: 'dev-a', sessionId: 'child-a', revision: 1 })
  journal.append('task/released', { id: 'TASK-001', actor: 'cockpit', reason: '让位给评审会话代录', previousOwner: 'dev-a' })
  const reviewId = recordReview(store, journal, {
    taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: [FINDING_A], sessionId: 'child-rev', taskRole: 'developer',
  }).id
  // ① 释放之后：**任何**会话（这里用评审会话的兄弟会话）都能代录 —— 旧实现报 "由 child-a 认领"
  const afterRelease = verifyReviewFinding(store, journal, { reviewId, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-x' })
  assert.equal(afterRelease.ok, true, '认领被释放后必须放行（否则真机只能 drop 卡 + errata）')
  if (afterRelease.ok) {
    assert.equal(afterRelease.disposition.ownerChecked, 'claim-released', '必须如实标 `claim-released`（不是 session / no-claim）')
  }
  // ② 反例：**没有释放**时照旧必须由实现方自己核（释放不是永久的开口）
  journal.append('task/claimed', { id: 'TASK-001', owner: 'dev-a', sessionId: 'child-b', revision: 2 })
  const review2 = recordReview(store, journal, {
    taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: [FINDING_A], sessionId: 'child-rev2', taskRole: 'developer',
  }).id
  const stillOwned = verifyReviewFinding(store, journal, { reviewId: review2, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-x' })
  assert.equal(stillOwned.ok, false, '从未释放的认领仍然要求实现方自己核')
  if (!stillOwned.ok) assert.equal(stillOwned.code, 'not-implementer', '拒绝码仍是 not-implementer')
  // ③ 释放 → **再认领**：owner 变成新认领者（历史不粘）
  journal.append('task/released', { id: 'TASK-001', actor: 'cockpit', reason: '换人', previousOwner: 'dev-a' })
  journal.append('task/claimed', { id: 'TASK-001', owner: 'dev-c', sessionId: 'child-c', revision: 3 })
  const review3 = recordReview(store, journal, {
    taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: [FINDING_A], sessionId: 'child-rev3', taskRole: 'developer',
  }).id
  assert.equal(
    verifyReviewFinding(store, journal, { reviewId: review3, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-x' }).ok,
    false,
    '再认领之后，owner 是新认领者（旧认领不许继续当 owner）',
  )
})

test('M103-11 §1.3（`DEF-117`）核实者 ≠ 评审作者：作者本人 ⇒ `self-verify`；换会话 ⇒ 通过且事件带 `independence: independent`；作者会话未知 ⇒ `unknown`', () => {
  writeTaskCard('TASK-001', 'in-progress', 'dev-a')
  journal.append('task/claimed', { id: 'TASK-001', owner: 'dev-a', sessionId: 'child-impl', revision: 1 })
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'child-impl', tools: 9, role: 'developer' })
  // ① 评审由 `child-rev` 记下 ⇒ 它自己再核 ⇒ `self-verify`（作者不得自证：DEF-117 的要害）
  const reviewId = recordReview(store, journal, {
    taskId: 'TASK-001', reviewer: 'rev-a', verdict: 'pass', findings: [FINDING_A], sessionId: 'child-rev', taskRole: 'developer',
  }).id
  const byAuthor = verifyReviewFinding(store, journal, { reviewId, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-rev' })
  assert.equal(byAuthor.ok, false, '评审作者不得核实自己写的评审')
  if (!byAuthor.ok) assert.equal(byAuthor.code, 'self-verify')
  // ② 换一个**同角色**会话 ⇒ 通过，且事件带 `independence: independent`
  //    （实现方任期先结束：`task/released`，否则 `not-implementer` 会挡住任何非 owner —— 见 M103-09/10）
  journal.append('task/released', { id: 'TASK-001', actor: 'cockpit', reason: '让位给同角色复核', previousOwner: 'dev-a' })
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'child-impl2', tools: 9, role: 'developer' })
  const independent = verifyReviewFinding(store, journal, { reviewId, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-impl2' })
  assert.equal(independent.ok, true, '换会话核实必须放行（同角色）')
  if (independent.ok) assert.equal(independent.disposition.independence, 'independent', '台账要能区分 independent')
  const event = journal.read().events.filter((item) => item.type === 'review/verified').at(-1)
  assert.equal(event?.data['independence'], 'independent', '事件必须带 independence（旧台账读不出这个区分）')
  // ③ 老评审（`review/recorded` 里没有 sessionId）⇒ 标 `unknown`（不假装独立）
  const legacyReview = recordReview(store, journal, {
    taskId: 'TASK-001', reviewer: 'rev-a', verdict: 'pass', findings: [FINDING_A], taskRole: 'developer',
  }).id
  const legacy = verifyReviewFinding(store, journal, { reviewId: legacyReview, index: 0, outcome: 'reproduced', evidence: '重跑 ⇒ 1 pass', sessionId: 'child-impl2' })
  assert.equal(legacy.ok, true, '作者会话未知时不得拒绝（老数据不可采纳就永久死锁）')
  if (legacy.ok) assert.equal(legacy.disposition.independence, 'unknown', '作者会话未知 ⇒ unknown，不假装 independent')
})

/** 写一张真卡（本文件的其它用例只读台账；这一格要卡存在，`recordReview` 才拿得到 taskRole）。 */
function writeTaskCard(id: string, status: 'in-progress', owner: string): void {
  store.writeYaml(['tasks', `${id}.yml`], {
    task: {
      id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
      blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size: 'medium', revision: 1, status, owner,
      requirements: [], evidence: [], createdAt: '', updatedAt: '',
    },
  })
}
