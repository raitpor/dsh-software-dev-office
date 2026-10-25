/**
 * **`TASK-224` / `DEF-210`：`dispatch/reuse-skipped` 从"一行一个候选"改成"一行一个原因"**。
 *
 * 病根（真账两时点并列，读者能看到它在长）：卡面量的时候 608 条事件里 495 条是它（81%、1 种原因、
 * 平均 82 条/派发）；本轮再量已是 **7795 条 / 1938 条（24.9%）/ 944KB / 5 种原因**——而且开始**衍生变体**
 *（同一种原因因 deny 面尾部差一个词分成 985 + 923 两条）。
 *
 * 守卫（两态，编号与卡上 DoD 对应；断言消息一律英文，本文件不进 `KNOWN_PROSE_GAP`）：
 *   · `M238-01` 86 个同原因候选 ⇒ **1 条**聚合事件、`count=86`、`sampleChildIds.length<=3`；
 *   · `M238-02` 两种原因混在一起 ⇒ 仍 **1 条**（`reasons.length=2`），且不超 3；
 *   · `M238-03` 连续两次原因集与 count 全等 ⇒ 第二次走 `sameAsSeq`，**读侧能把原因原话还回来**；
 *   · `M238-04` 反例：原因集多一种 / 某一种的 count 变了 ⇒ **必须回到完整形态**，不得错用 `sameAsSeq`；
 *   · `M238-05` 老形状（一行一个候选）与聚合形状**共存可读**，且"最近一次派发写了多少条"可读。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  lastReuseSkippedWriteCount,
  lastReuseSkippedReference,
  planReuseSkippedEvents,
  reuseSkippedRowsFromEvents,
} from '../src/domain/pool.js'
import { describeLedgerWriteVolume } from '../src/interface/describe.js'

const REASON_A = 'mask changed (old fingerprint has no version, deny face lacks subagent_fork)'
const REASON_B = 'this child still holds an in-flight card TASK-186'

function candidates(count: number, reason: string, prefix = 'child'): { childSessionId: string; role: string; reason: string }[] {
  return Array.from({ length: count }, (_item, index) => ({
    childSessionId: `${prefix}-${String(index).padStart(4, '0')}-1111-4222-8333-444444444444`,
    role: 'developer',
    reason,
  }))
}

test('M238-01 (guard 1) 86 candidates with one reason: exactly one event, count=86, at most 3 sample ids', () => {
  const plan = planReuseSkippedEvents(candidates(86, REASON_A), { task: 'TASK-24001', decidedAt: '2026-10-25T00:00:00.000Z' })
  assert.equal(plan.events.length, 1, `one event per reason set, got ${String(plan.events.length)}`)
  assert.equal(plan.candidates, 86, 'the candidate total must be carried')
  const data = plan.events[0] as { reasons?: { reason?: string; count?: number; sampleChildIds?: string[] }[] }
  const reasons = data.reasons ?? []
  assert.equal(reasons.length, 1, `one reason entry expected, got ${String(reasons.length)}`)
  assert.equal(reasons[0]?.count, 86, 'the count must be the real candidate count')
  assert.equal(reasons[0]?.reason, REASON_A, 'the reason text must be kept verbatim (aggregate the count, not the reason)')
  const samples = reasons[0]?.sampleChildIds ?? []
  assert.ok(samples.length <= 3, `sample ids must be bounded, got ${String(samples.length)}`)
  assert.equal(samples.length, 3, 'but they must exist (so the reader can name who was skipped)')
  // 体积：86 个候选不该产生 86 行的字节量
  const bytes = Buffer.byteLength(JSON.stringify(plan.events[0]))
  assert.ok(bytes < 600, `one event must stay small, got ${String(bytes)} bytes`)
})

test('M238-02 (guard 2) two different reasons in one dispatch: still one event, and never more than 3', () => {
  const plan = planReuseSkippedEvents([...candidates(5, REASON_A), ...candidates(3, REASON_B, 'other')], { task: 'TASK-24002' })
  assert.ok(plan.events.length <= 3, `events must stay under the soft threshold, got ${String(plan.events.length)}`)
  const data = plan.events[0] as { reasons?: { reason?: string; count?: number }[] }
  assert.equal((data.reasons ?? []).length, 2, 'both reasons must survive aggregation')
  const counts = (data.reasons ?? []).map((row) => row.count).sort((left, right) => (left ?? 0) - (right ?? 0))
  assert.deepEqual(counts, [3, 5], `per-reason counts must add up to the candidates: ${JSON.stringify(counts)}`)
  assert.equal(plan.candidates, 8, 'the total must equal the sum of the parts')
})

test('M238-03 (guard 3) a second identical dispatch becomes sameAsSeq, and the reader still recovers the reason text', () => {
  const rows = candidates(4, REASON_A)
  const first = planReuseSkippedEvents(rows, { task: 'TASK-24003' })
  const events: { seq: number; type: string; data: Record<string, unknown> }[] = [
    { seq: 100, type: 'dispatch/reuse-skipped', data: first.events[0] as Record<string, unknown> },
  ]
  const previous = lastReuseSkippedReference(events)
  assert.ok(previous !== undefined, 'fixture premise: the previous reading must be resolvable')
  const second = planReuseSkippedEvents(rows, { task: 'TASK-24003', previous })
  assert.equal(second.sameAsSeq, 100, `the second dispatch must reference the first: ${JSON.stringify(second.events[0])}`)
  assert.equal(second.events.length, 1, 'a reference is still exactly one event')
  events.push({ seq: 101, type: 'dispatch/reuse-skipped', data: second.events[0] as Record<string, unknown> })
  // **读侧**：引用形态必须能把原因原话还回来（不许只剩一个 seq）
  const read = reuseSkippedRowsFromEvents(events)
  assert.equal(read.unresolvedSameAs.length, 0, `every sameAsSeq must resolve: ${JSON.stringify(read.unresolvedSameAs)}`)
  assert.equal(read.rows.length, 8, `both dispatches must expand to their candidates, got ${String(read.rows.length)}`)
  assert.equal(read.rows.every((row) => row.reason === REASON_A), true, 'the reason text must survive the round trip')
})

test('M238-04 (guard 4) counterexample: one more reason, or a changed count, must go back to the full shape', () => {
  const base = candidates(4, REASON_A)
  const first = planReuseSkippedEvents(base, { task: 'TASK-24004' })
  const events = [{ seq: 200, type: 'dispatch/reuse-skipped', data: first.events[0] as Record<string, unknown> }]
  const previous = lastReuseSkippedReference(events)
  assert.ok(previous !== undefined)
  // ① 多一种原因 ⇒ 必须完整形态
  const extra = planReuseSkippedEvents([...base, ...candidates(1, REASON_B, 'other')], { task: 'TASK-24004', previous })
  assert.equal(extra.sameAsSeq, undefined, 'a new reason must NOT be hidden behind sameAsSeq')
  assert.ok(Array.isArray((extra.events[0] as { reasons?: unknown }).reasons), 'the full shape must be written')
  // ② 数量变了（4 → 2）⇒ 也必须完整形态（现场变了，引用旧读数会把"这次跳过了几个"读错）
  const fewer = planReuseSkippedEvents(candidates(2, REASON_A), { task: 'TASK-24004', previous })
  assert.equal(fewer.sameAsSeq, undefined, 'a changed count must NOT reuse the old reference')
  assert.equal((fewer.events[0] as { reasons?: { count?: number }[] }).reasons?.[0]?.count, 2, 'the new count must be written')
})

test('M238-05 (guard 5) old one-per-candidate events stay readable next to the new shape, and the write count is visible', () => {
  const legacy = { seq: 300, type: 'dispatch/reuse-skipped', data: { childSessionId: 'legacy-0001', role: 'developer', reason: REASON_A, task: 'TASK-24005' } }
  const aggregate = planReuseSkippedEvents(candidates(3, REASON_B, 'agg'), { task: 'TASK-24005' })
  const events = [
    legacy,
    { seq: 301, type: 'dispatch/reuse-skipped', data: aggregate.events[0] as Record<string, unknown> },
  ]
  const read = reuseSkippedRowsFromEvents(events)
  assert.equal(read.rows.length, 4, `legacy + aggregate must both be read: ${String(read.rows.length)}`)
  assert.equal(read.rows.filter((row) => row.reason === REASON_A).length, 1, 'the legacy row must survive verbatim')
  assert.equal(read.rows.filter((row) => row.reason === REASON_B).length, 3, 'the aggregated rows must expand')
  // 「最近一次派发写了多少条」必须是可看的读数（修前 82 条/派发，回执上从无这个数字）
  const readout = lastReuseSkippedWriteCount(events)
  assert.ok(readout !== undefined, 'the write-count readout must exist')
  assert.equal(readout?.task, 'TASK-24005')
  assert.equal(readout?.events, 2, `the last dispatch wrote 2 events here, got ${String(readout?.events)}`)
  const line = describeLedgerWriteVolume(readout)
  assert.match(line, /events=2/u, `the status line must print the count: ${line}`)
  assert.match(line, /candidates=/u, 'the line must also carry the candidate total')
  assert.equal(line.includes('over the soft threshold'), false, 'two events are inside the soft threshold')
  // 越界时**明说**（软阈值：不硬砍，但要让读者看见）
  const noisy = describeLedgerWriteVolume({ task: 'TASK-24006', events: 82, bytes: 14760, candidates: 82, sameAsSeq: undefined })
  assert.match(noisy, /over the soft threshold/u, `a regression to 82 events must be visible: ${noisy}`)
})
