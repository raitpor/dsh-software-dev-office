/**
 * **G-2（major，sdo-test 2026-10-08 报告）**：老格式评审（`review/recorded` 里**没有** `contentHash`）
 * ⇒「评审自身也要对得上」这条防篡改判据**整体失效**，而且**静默**。
 *
 * 我的复现（自建探针，与报告一致；报告的台账上是 20/20 无指纹）：
 * ```text
 * 构造老格式：REV-001 文件 + review/recorded 事件（不带 contentHash）
 *   基线      ⇒ state = unverified
 *   把 changes-requested 手改成 pass ⇒ state 仍是 unverified（**不是 tampered**）⇒ 改 verdict 查不出来
 * ```
 *
 * 修法（按报告建议，方向是**收紧 + 可见**，不是把老台账判死）：
 *   ① 采纳状态带上 `tamperGuard`：`content-hash` / `none-legacy`；门禁成功文案与 `sdo_review list`
 *      都**显式标注**"该条不具备防篡改保护"（不许静默）；
 *   ② 给出**补记通道** `sdo_review action=rehash id=REV-…`：补一条 `review/hashed` 指纹事件，
 *      之后改 verdict / 改正文即判 `tampered`；补记**之前**的改动仍不可校验（如实写在回执与文案里）；
 *   ③ **不许洗白**：已有指纹且与当前内容不一致 ⇒ 补记被拒（那正是"改过"的证据）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { CHECKERS } from '../src/domain/gates.js'
import { listReviews } from '../src/domain/records.js'
import { rehashReview, reviewAdoption, verifyReviewFinding } from '../src/domain/reviewVerification.js'
import type { GateContext } from '../src/domain/gates.js'
import type { TaskCard } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm71')
let store: SdoStore
let journal: Journal

function card(id: string, status: TaskCard['status'], size: TaskCard['size'] = 'medium'): void {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size, revision: 1, status, owner: 'dev',
    requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', `${id}.yml`], { task })
}

/** 老格式评审：文件 + `review/recorded` 事件，**不带** `contentHash`。 */
function legacyReview(id: string, verdict: 'pass' | 'changes-requested', findings: string[] = ['只改一条']): void {
  store.writeYaml(['reviews', `${id}.yml`], {
    review: { id, taskId: 'TASK-001', reviewer: 'rev-b', verdict, findings, at: '2026-01-01T00:00:00.000Z' },
  })
  journal.append('review/recorded', { id, taskId: 'TASK-001', verdict, findings: findings.length })
}

const first = (): ReturnType<typeof listReviews>[number] => listReviews(store)[0] as ReturnType<typeof listReviews>[number]

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M71-01 G-2：老格式评审必须显式标注「无防篡改保护」；补记指纹后才检出改 verdict', () => {
  legacyReview('REV-001', 'changes-requested')
  // ① 没有指纹 ⇒ 标注 none-legacy（不是静默当正常条目）
  assert.equal(reviewAdoption(store, journal, first()).tamperGuard, 'none-legacy')

  // ② 未补记时改 verdict 确实查不出来 —— 把这个**已知限制**钉住（它是本缺陷的一半）
  store.writeYaml(['reviews', 'REV-001.yml'], { review: { ...first(), verdict: 'pass' } })
  assert.equal(reviewAdoption(store, journal, first()).state === 'tampered', false, '老格式本来查不出改 verdict（修法只能让它可见 + 可补记）')

  // ③ 补记指纹 ⇒ tamperGuard 变 content-hash
  const sealed = rehashReview(store, journal, { reviewId: 'REV-001', by: 'cockpit' })
  assert.equal(sealed.ok, true)
  assert.equal(sealed.ok ? sealed.alreadySealed : true, false, '这次是真补记')
  assert.ok(journal.read().events.some((event) => event.type === 'review/hashed'), '补记要落真源事件')
  assert.equal(reviewAdoption(store, journal, first()).tamperGuard, 'content-hash')

  // ④ 内容没变时再补记一次 ⇒ 幂等（当作 no-op，不新增事件）
  const again = rehashReview(store, journal, { reviewId: 'REV-001', by: 'cockpit' })
  assert.equal(again.ok, true)
  assert.equal(again.ok ? again.alreadySealed : false, true, '一致 ⇒ 幂等')

  // ⑤ 补记之后再改 verdict ⇒ 判 tampered（这就是补记的收益）
  store.writeYaml(['reviews', 'REV-001.yml'], { review: { ...first(), verdict: 'changes-requested' } })
  assert.equal(reviewAdoption(store, journal, first()).state, 'tampered', '补记之后改 verdict 必须被检出')
})

test('M71-02 G-2：**不许洗白** —— 已记录指纹与当前内容不一致时，补记被拒且状态是 tampered', () => {
  legacyReview('REV-001', 'pass')
  rehashReview(store, journal, { reviewId: 'REV-001', by: 'cockpit' })
  // 篡改（改发现正文）⇒ tampered
  store.writeYaml(['reviews', 'REV-001.yml'], { review: { ...first(), findings: ['被改过的正文'] } })
  assert.equal(reviewAdoption(store, journal, first()).state, 'tampered')
  const before = journal.read().events.filter((event) => event.type === 'review/hashed').length

  const launder = rehashReview(store, journal, { reviewId: 'REV-001', by: 'cockpit' })
  assert.equal(launder.ok, false, '补记不得把篡改证据抹掉')
  assert.equal(launder.ok ? '' : launder.code, 'already-tampered')
  assert.equal(journal.read().events.filter((event) => event.type === 'review/hashed').length, before, '被拒的补记不许落事件')
  assert.equal(reviewAdoption(store, journal, first()).state, 'tampered', '状态必须仍是 tampered')
})

test('M71-03 G-2 可见性：被采纳的老格式 pass 评审必须在门禁成功文案里点名（不许读成"已防篡改"）', () => {
  card('TASK-001', 'done')
  legacyReview('REV-001', 'pass', ['f1'])
  const verified = verifyReviewFinding(store, journal, { reviewId: 'REV-001', index: 0, outcome: 'reproduced', evidence: '复现', sessionId: 'child-dev' })
  assert.equal(verified.ok, true)
  assert.equal(reviewAdoption(store, journal, first()).state, 'adopted', '前置：老格式评审照旧可以被采纳（不把老台账判死）')

  for (const check of ['review.independent', 'review.required']) {
    const found = CHECKERS[check]?.({ workspace: BASE, store, journal, requirements: [] } as unknown as GateContext)
    assert.equal(found?.ok, true, `采纳后判据应通过：${found?.detail}`)
    assert.match(String(found?.detail), /REV-001/u, `成功文案必须点名"无防篡改保护"的老条目：${found?.detail}`)
    assert.match(String(found?.detail), /老格式|防篡改/u, `要说清是哪一种问题：${found?.detail}`)
  }
})
