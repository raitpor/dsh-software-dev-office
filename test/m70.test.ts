/**
 * **G-1（blocker，sdo-test 2026-10-08 报告）**：实现会话一旦退役，它留下的评审**永久**不可采纳
 * ⇒ C-42 / C-52 机械上不可能转绿；而且"有 pass 评审但采纳不了"的那几张卡被 `unreviewed` 的提前
 * return **藏在身后**（真机：22 张无评审的卡把 2 张死锁卡藏了）。
 *
 * 我的复现（自建探针，与报告一致）：
 * ```text
 * 卡 TASK-001：子会话 child-gone 认领 → done → 子会话结算退役
 * 评审 REV-001 = pass
 *   驾驶舱核实 ⇒ not-implementer（点名 child-gone）｜ 重新认领 done 卡 ⇒ 进不去
 *   采纳状态 ⇒ unverified（永远）      ｜ 门禁详情只报"没有通过评审"的那张卡
 * ```
 *
 * 修法：**不可达退化**（与既有 `no-claim` 同性质：宁可少一层身份校验，也不把老数据变成没法干活），
 * 但**每一种原因都如实记**：`owner-tenure-over`（卡已离开 in-progress ⇒ 任期结束）／
 * `owner-settled`（派发已结算 ⇒ 看不到活的执行者）。**卡仍在进行中 + 子会话在飞**时照旧必须实现方自己核实。
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
import { claim } from '../src/domain/collab.js'
import { listDispositions, reviewAdoption, verifyReviewFinding } from '../src/domain/reviewVerification.js'
import type { GateContext } from '../src/domain/gates.js'
import type { TaskCard } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm70')
let store: SdoStore
let journal: Journal

function card(id: string, status: TaskCard['status'], owner = 'dev', size: TaskCard['size'] = 'medium'): void {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size, revision: 1, status, owner,
    requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', `${id}.yml`], { task })
}

function dispatched(childSessionId: string, taskId: string, settled: boolean): void {
  journal.append('dispatch/started', { task: taskId, provider: 'spawn', childSessionId, tools: 9, role: 'developer' })
  if (settled) journal.append('dispatch/finished', { childSessionId, task: taskId, role: 'developer', turn: 1, reason: 'completed', startedAt: '', finishedAt: '', durationMs: 1, report: 'x' })
}

const criteria = (check: string): { ok: boolean; detail: string } => {
  const found = CHECKERS[check]?.({ workspace: BASE, store, journal, requirements: [] } as unknown as GateContext)
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

test('M70-01 G-1：实现会话退役后，评审必须能被采纳（否则 C-42/C-52 不可达）；原因如实标注', () => {
  card('TASK-001', 'ready', '')
  assert.equal(claim(store, journal, { taskId: 'TASK-001', owner: 'dev-a', expectedRevision: 1, sessionId: 'child-gone' }).ok, true)
  dispatched('child-gone', 'TASK-001', true)
  card('TASK-001', 'done', 'dev-a')
  const review = recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: ['f1'], sessionId: 'child-rev' })

  // ① 卡已离开 in-progress ⇒ 实现方任期结束 ⇒ 放行并标注 owner-tenure-over
  const byCockpit = verifyReviewFinding(store, journal, { reviewId: review.id, index: 0, outcome: 'reproduced', evidence: '逐条复现', sessionId: 'session-cockpit' })
  assert.equal(byCockpit.ok, true, `实现会话退役时必须放行（否则评审永久不可采纳）：${JSON.stringify(byCockpit)}`)
  assert.equal(byCockpit.ok ? byCockpit.disposition.ownerChecked : '', 'owner-tenure-over')
  assert.equal(listDispositions(store)[0]?.ownerChecked, 'owner-tenure-over', '台账里也要如实记原因')
  const events = journal.read().events.filter((event) => event.type === 'review/verified')
  assert.equal(events[0]?.data['ownerChecked'], 'owner-tenure-over', 'journal 佐证里同样要记')
  assert.equal(reviewAdoption(store, journal, review).state, 'adopted', '放行之后必须真的能采纳')

  // ② 门禁不再被这张卡挡住
  assert.equal(criteria('review.independent').detail.includes('TASK-001'), false, `采纳后不许再报 TASK-001：${criteria('review.independent').detail}`)
})

test('M70-02 G-1 反向：卡仍在进行中 + 子会话在飞 ⇒ 仍必须由实现方自己核实（不放松）；派发已结算则标注放行', () => {
  card('TASK-001', 'ready', '')
  assert.equal(claim(store, journal, { taskId: 'TASK-001', owner: 'dev-a', expectedRevision: 1, sessionId: 'child-live' }).ok, true)
  dispatched('child-live', 'TASK-001', false)
  const review = recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: ['x'], sessionId: 'child-rev' })
  const other = verifyReviewFinding(store, journal, { reviewId: review.id, index: 0, outcome: 'reproduced', evidence: 'y', sessionId: 'session-cockpit' })
  assert.equal(other.ok, false, '实现方还在飞时，别人不得代核')
  assert.equal(other.ok ? '' : other.code, 'not-implementer')

  // 派发结算（一次性子代理跑完）⇒ 标注 owner-settled 放行
  dispatched('child-live', 'TASK-001', true)
  const after = verifyReviewFinding(store, journal, { reviewId: review.id, index: 0, outcome: 'reproduced', evidence: 'y', sessionId: 'session-cockpit' })
  assert.equal(after.ok, true)
  assert.equal(after.ok ? after.disposition.ownerChecked : '', 'owner-settled')
})

test('M70-03 G-1 第二个洞：两个桶必须**一起报**（不许让"没有评审"的卡把"采纳不了"的卡藏起来）', () => {
  // 卡 A：有 pass 评审但一条都没核实（未采纳）｜ 卡 B：完全没有评审
  card('TASK-001', 'done')
  card('TASK-002', 'done')
  const review = recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'rev-b', verdict: 'pass', findings: ['f1', 'f2'] })

  for (const check of ['review.independent', 'review.required']) {
    const { ok, detail } = criteria(check)
    assert.equal(ok, false)
    assert.match(detail, /TASK-002/u, `要先报"没有评审"的卡：${detail}`)
    assert.match(detail, new RegExp(review.id, 'u'), `也必须报"有评审但没采纳"的那张（旧实现在这里提前 return 了）：${detail}`)
    const remedy = CHECKERS[check]?.({ workspace: BASE, store, journal, requirements: [] } as unknown as GateContext)?.remedy ?? ''
    assert.match(remedy, /verify-review/u, `补救话术要带上核实动作：${remedy}`)
  }
})
