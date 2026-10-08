/**
 * **评审核实**（2026-10-08 用户口径）：
 *
 * > 评审的（任务）完成不需要被评审，但**评审结果需要被核实才能采纳**；
 * > 评审结果发给开发者角色改动时，**开发者应自行核实**（就像"评审员报的每条发现，
 * > 实现者要先自己复现，复现不了要给出反证"）。
 *
 * 这一组钉住四条机械后果：
 *   ① **采纳**：`pass` 评审要满足 C-42 / C-52 的覆盖要求，必须每条发现都被**实现会话**核实过
 *      （`reproduced` 复现 / `refuted` 反驳给反证）；没核实的评审在门禁里要**区分**于"没有评审"；
 *   ② **闭合**：卡的最新评审是 `changes-requested` / `reject` 且发现没核实完 ⇒ **不许 `done`**；
 *   ③ **两个方向都要防**：`role=reviewer` 的卡**不再被要求**"再被评审"（评审卡自我递归没有意义），
 *      但评审**结果**（findings）必须被核实；
 *   ④ **三条防腐**（评审台账手可编辑）：核实绑发现正文指纹、核实必须有 journal 佐证、
 *      评审自身要与 `review/recorded.contentHash` 对得上（改 verdict 再补核实 = `tampered`）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { CHECKERS } from '../src/domain/gates.js'
import { recordReview } from '../src/domain/records.js'
import { report } from '../src/domain/collab.js'
import { blockingReview, listDispositions, reviewAdoption, verifyReviewFinding } from '../src/domain/reviewVerification.js'
import type { GateContext } from '../src/domain/gates.js'
import type { TaskCard } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm67')
let store: SdoStore
let journal: Journal

function card(id: string, status: TaskCard['status'], options: { role?: string; size?: TaskCard['size']; owner?: string } = {}): void {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: (options.role ?? 'developer') as TaskCard['role'],
    size: options.size ?? 'small', revision: 1, status, ...(options.owner === undefined ? {} : { owner: options.owner }),
    requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', `${id}.yml`], { task })
}

function ctx(): GateContext {
  return { workspace: BASE, store, journal, requirements: [], project: { surfaces: [] } } as unknown as GateContext
}

const c42 = (): { ok: boolean; detail: string } => {
  const found = CHECKERS['review.required']?.(ctx())
  return { ok: found?.ok === true, detail: found?.detail ?? '' }
}
const c52 = (): { ok: boolean; detail: string } => {
  const found = CHECKERS['review.independent']?.(ctx())
  return { ok: found?.ok === true, detail: found?.detail ?? '' }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M67-01 采纳状态机：未核实 → 部分 → 已采纳；发现正文被改 / 手写评审 / 无真源佐证 都不采纳', () => {
  const review = recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: ['a 处溢出', 'b 处超时'] })
  assert.equal(reviewAdoption(store, journal, review).state, 'unverified', '一条都没核实 ⇒ 未核实')

  const first = verifyReviewFinding(store, journal, { reviewId: review.id, index: 0, outcome: 'reproduced', evidence: '按发现复现：溢出确实发生' })
  assert.equal(first.ok, true)
  const partial = reviewAdoption(store, journal, review)
  assert.equal(partial.state, 'partial')
  assert.deepEqual(partial.pending, [1], '第二条还没核实')

  const second = verifyReviewFinding(store, journal, { reviewId: review.id, index: 1, outcome: 'refuted', evidence: '压力下未复现，附反证日志' })
  assert.equal(second.ok, true)
  assert.equal(second.ok ? second.adopted : false, true, '全部核实完 ⇒ 可采纳')
  assert.equal(reviewAdoption(store, journal, review).state, 'adopted')

  // ① 手写的评审文件（没有 `review/recorded` 事件）⇒ 不采纳
  store.writeYaml(['reviews', 'REV-900.yml'], {
    review: { id: 'REV-900', taskId: 'TASK-001', reviewer: 'x', verdict: 'pass', findings: ['手写'], at: '2026-01-01T00:00:00.000Z' },
  })
  const hand = store.readYaml<{ review: import('../src/domain/records.js').Review }>('reviews', 'REV-900.yml')?.review
  assert.equal(reviewAdoption(store, journal, hand ?? review).state, 'unrecorded')

  // ② 台账里有核实、journal 里没有对应事件（伪造）⇒ 不采纳
  const forgedReview = recordReview(store, journal, { taskId: 'TASK-002', reviewer: 'rev-b', verdict: 'pass', findings: ['c 处丢数据'] })
  // 先正常核实拿到"正确的指纹"，再把 journal 事件的佐证删掉（模拟只手写台账）
  const good = verifyReviewFinding(store, journal, { reviewId: forgedReview.id, index: 0, outcome: 'reproduced', evidence: 'e' })
  assert.equal(good.ok, true)
  const kept = listDispositions(store)
  const events = journal.read().events
  const rewritten = events
    .filter((event) => !(event.type === 'review/verified' && String(event.data['id'] ?? '') === forgedReview.id))
    .map((event, index) => ({ ...event, seq: index + 1 }))
  store.writeText(['journal.jsonl'], `${rewritten.map((event) => JSON.stringify(event)).join('\n')}\n`)
  const after = new Journal(store)
  assert.equal(reviewAdoption(store, after, forgedReview).state, 'forged', '只有台账、没有真源佐证 ⇒ 伪造')
  assert.ok(kept.some((item) => item.reviewId === forgedReview.id), '前置：台账里确实留着那条核实记录')
  assert.ok(listDispositions(store).some((item) => item.reviewId === forgedReview.id), '台账文件也没被这段操作改掉')

  // ③ 手改评审文件（verdict 从 changes-requested 改成 pass）⇒ tampered，永远不采纳
  const edited = recordReview(store, journal, { taskId: 'TASK-003', reviewer: 'rev-b', verdict: 'changes-requested', findings: ['d 处没做'] })
  store.writeYaml(['reviews', `${edited.id}.yml`], { review: { ...edited, verdict: 'pass' } })
  const reread = store.readYaml<{ review: import('../src/domain/records.js').Review }>('reviews', `${edited.id}.yml`)?.review
  assert.equal(reviewAdoption(store, journal, reread ?? edited).state, 'tampered')

  // ④ 老台账（`review/recorded` 没有 contentHash）下发现被改 ⇒ stale（不是 tampered）
  store.writeYaml(['reviews', 'REV-901.yml'], {
    review: { id: 'REV-901', taskId: 'TASK-004', reviewer: 'rev-b', verdict: 'pass', findings: ['改过的正文'], at: '2026-01-01T00:00:00.000Z' },
  })
  journal.append('review/recorded', { id: 'REV-901', taskId: 'TASK-004', verdict: 'pass', findings: 1 })
  store.writeYaml(['reviews', 'verified.yml'], {
    verifications: [{ reviewId: 'REV-901', index: 0, findingHash: 'deadbeef', outcome: 'reproduced', evidence: 'e', by: 'dev', ownerChecked: 'no-claim', at: 'x' }],
  })
  const legacy = store.readYaml<{ review: import('../src/domain/records.js').Review }>('reviews', 'REV-901.yml')?.review
  assert.equal(reviewAdoption(store, journal, legacy ?? edited).state, 'stale', '老台账：核实过的发现正文被改 ⇒ stale')
})

test('M67-02 谁能核实：不能自己核实自己、只能由该卡的实现会话核实、必须给依据', () => {
  card('TASK-001', 'in-progress', { owner: 'dev-a' })
  journal.append('task/claimed', { id: 'TASK-001', owner: 'dev-a', sessionId: 'child-dev', expectedRevision: 1 })
  const review = recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'changes-requested', findings: ['f1', 'f2'], sessionId: 'child-rev' })

  // ① 记录评审的会话自己核实 ⇒ 拒
  const self = verifyReviewFinding(store, journal, { reviewId: review.id, index: 0, outcome: 'reproduced', evidence: 'e', sessionId: 'child-rev' })
  assert.equal(self.ok, false)
  assert.equal(self.ok ? '' : self.code, 'self-verify')

  // ② 不是该卡的实现会话 ⇒ 拒
  const other = verifyReviewFinding(store, journal, { reviewId: review.id, index: 0, outcome: 'reproduced', evidence: 'e', sessionId: 'child-other' })
  assert.equal(other.ok, false)
  assert.equal(other.ok ? '' : other.code, 'not-implementer')

  // ③ 实现会话 + 依据 ⇒ 过
  const ok = verifyReviewFinding(store, journal, { reviewId: review.id, index: 1, outcome: 'reproduced', evidence: '按发现复现成功', sessionId: 'child-dev' })
  assert.equal(ok.ok, true)
  assert.equal(ok.ok ? ok.disposition.ownerChecked : '', 'session')

  // ④ 空依据 / 越界下标 / 非法结论 ⇒ 拒（且都不写台账）
  assert.equal(verifyReviewFinding(store, journal, { reviewId: review.id, index: 0, outcome: 'refuted', evidence: '   ', sessionId: 'child-dev' }).ok, false)
  assert.equal(verifyReviewFinding(store, journal, { reviewId: review.id, index: 9, outcome: 'reproduced', evidence: 'e', sessionId: 'child-dev' }).ok, false)
  assert.equal(
    verifyReviewFinding(store, journal, { reviewId: review.id, index: 0, outcome: 'maybe' as never, evidence: 'e', sessionId: 'child-dev' }).ok,
    false,
    '非法结论必须拒',
  )
  assert.equal(listDispositions(store).length, 1, '被拒的核实不许落台账')

  // ⑤ 老台账（卡上没有任何认领）⇒ 放行但如实标注 no-claim
  const legacyReview = recordReview(store, journal, { taskId: 'TASK-900', reviewer: 'rev-b', verdict: 'pass', findings: ['g'] })
  const legacy = verifyReviewFinding(store, journal, { reviewId: legacyReview.id, index: 0, outcome: 'reproduced', evidence: 'e', sessionId: 'child-dev' })
  assert.equal(legacy.ok, true)
  assert.equal(legacy.ok ? legacy.disposition.ownerChecked : '', 'no-claim')
})

test('M67-03 门禁：没核实的通过评审**不被采纳**（且区别于"没有评审"）；reviewer 卡不再被要求评审', () => {
  card('TASK-001', 'done', { size: 'medium' })
  const review = recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: ['有一条小问题'] })

  // ① 有 pass 评审但没核实 ⇒ 两条判据都红，理由必须说"没核实"（不是"没有通过评审"）
  const c42a = c42()
  const c52a = c52()
  assert.equal(c42a.ok, false)
  assert.equal(c52a.ok, false)
  assert.match(c42a.detail, /未核实/u, `C-42 要说清是未核实：${c42a.detail}`)
  assert.match(c52a.detail, /未核实/u, `C-52 要说清是未核实：${c52a.detail}`)
  assert.match(c42a.detail, new RegExp(review.id, 'u'), '要点名是哪条评审')

  // ② 实现方核实后 ⇒ 两条都绿
  verifyReviewFinding(store, journal, { reviewId: review.id, index: 0, outcome: 'reproduced', evidence: '复现成功，已修' })
  assert.equal(c42().ok, true, `核实后 C-42 应绿：${c42().detail}`)
  assert.equal(c52().ok, true, `核实后 C-52 应绿：${c52().detail}`)

  // ③ 反向（新口径）：`role=reviewer` 的 done 卡**不再被要求**评审；但它的发现若被改动，仍不采纳
  card('TASK-002', 'done', { role: 'reviewer', size: 'medium' })
  assert.equal(c42().ok, true, 'C-42 本就不含评审卡')
  assert.equal(c52().ok, true, `C-52 现在也不再要求"评审卡被评审"：${c52().detail}`)
})

test('M67-04 `done` 关：最新评审还在要求改动且发现没核实完 ⇒ 不许完成；核实完才放行', () => {
  card('TASK-001', 'in-progress', { owner: 'dev-a' })
  const review = recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'changes-requested', findings: ['f1 没做', 'f2 缺证据'] })
  const evidence = [{ kind: 'command' as const, detail: 'node --test 全绿', exitCode: 0, at: '2026-01-01T00:00:00.000Z' }]

  assert.equal(blockingReview(store, journal, 'TASK-001')?.review.id, review.id, '前置：最新评审是这条要改动的')
  const blocked = report(store, journal, { taskId: 'TASK-001', owner: 'dev-a', status: 'done', evidence })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.ok ? '' : blocked.code, 'review-open-findings')
  assert.match(blocked.ok ? '' : blocked.detail, /REV-001/u, '要点名是哪条评审')
  assert.match(blocked.ok ? '' : blocked.detail, /1、2/u, '要点名还差哪几条发现')

  // 逐条核实（一条复现、一条反驳）⇒ 不再拦
  verifyReviewFinding(store, journal, { reviewId: review.id, index: 0, outcome: 'reproduced', evidence: '复现成功' })
  verifyReviewFinding(store, journal, { reviewId: review.id, index: 1, outcome: 'refuted', evidence: '反证：证据已在 REV 里给出' })
  assert.equal(blockingReview(store, journal, 'TASK-001'), undefined, '核实完 ⇒ 不再拦')
  const done = report(store, journal, { taskId: 'TASK-001', owner: 'dev-a', status: 'done', evidence })
  assert.equal(done.ok, true, `核实完必须能完成：${done.ok ? '' : done.detail}`)
})
