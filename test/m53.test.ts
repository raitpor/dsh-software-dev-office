/**
 * **D3（整仓评审 blocker）**：id 从"可手改的文件列表"分配 ⇒ 删掉文件后号会回落，journal 里出现**同 id 两条事实**。
 * 追加式真源才是"这个号用过没有"的权威 —— 分配必须取「文件 ∪ 真源事件」的并集。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { recordDefect, recordReview, recordRun, recordTestCase, recordTestResult } from '../src/domain/records.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm53')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('D3：删掉第二条记录文件后，新记录**不得**复用它的号（TR / TC / DEF / REV / RUN 同判据）', () => {
  // TR：记两条 → 删第二条文件 → 再记 ⇒ 必须是 TR-003（旧实现给 TR-002）
  recordTestResult(store, journal, { caseId: 'TC-001', status: 'pass', evidence: 'x' })
  recordTestResult(store, journal, { caseId: 'TC-001', status: 'pass', evidence: 'y' })
  rmSync(join(BASE, '.sdo', 'tests', 'results', 'TR-002.yml'), { force: true })
  const third = recordTestResult(store, journal, { caseId: 'TC-001', status: 'pass', evidence: 'z' })
  assert.equal(third.id, 'TR-003', 'D3：删文件不得让号回落')

  // TC / DEF / REV：同型
  recordTestCase(store, journal, { kind: 'unit', title: 'a', steps: [], expected: 'ok' } as never)
  recordTestCase(store, journal, { kind: 'unit', title: 'b', steps: [], expected: 'ok' } as never)
  rmSync(join(BASE, '.sdo', 'tests', 'TC-002.yml'), { force: true })
  const tc3 = (recordTestCase(store, journal, { kind: 'unit', title: 'c', steps: [], expected: 'ok' } as never)).id
  // 判据是"**不复用**且**单调**"（号跳号无害，回落才是缺陷）
  assert.notEqual(tc3, 'TC-002', 'D3：不得复用被删掉的号')
  assert.ok(tc3 > 'TC-002', `D3：号必须单调递增，实际 ${tc3}`)

  recordDefect(store, journal, { title: 'd1', severity: 'minor', status: 'open' })
  recordDefect(store, journal, { title: 'd2', severity: 'minor', status: 'open' })
  rmSync(join(BASE, '.sdo', 'defects', 'DEF-002.yml'), { force: true })
  assert.notEqual(recordDefect(store, journal, { title: 'd3', severity: 'minor', status: 'open' }).id, 'DEF-002')

  recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'r1', verdict: 'pass', findings: ['无发现'] })
  recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'r2', verdict: 'pass', findings: ['无发现'] })
  rmSync(join(BASE, '.sdo', 'reviews', 'REV-002.yml'), { force: true })
  assert.notEqual(recordReview(store, journal, { taskId: 'TASK-001', reviewer: 'r3', verdict: 'pass', findings: ['无发现'] }).id, 'REV-002')

  // RUN：旧实现按 `existing.length + 1` 数条数 ⇒ 删一条就撞号
  const runInput = { target: 'server', command: './run', outcome: 'pass' as const, evidence: 'log', workspace: BASE, by: 'tester' }
  const run1 = recordRun(store, journal, runInput)
  const run2 = recordRun(store, journal, runInput)
  assert.equal(run1.ok && run1.run.id, 'RUN-001')
  assert.equal(run2.ok && run2.run.id, 'RUN-002')
  rmSync(join(BASE, '.sdo', 'delivery', 'runs.yml'), { force: true })
  const run3 = recordRun(store, journal, runInput)
  assert.equal(run3.ok && run3.run.id, 'RUN-003', 'D3：RUN- 不得按条数分配')

  // 真源里**不得**出现同前缀的重复 id（这才是这条缺陷的真正判据）
  // 只看事件的**身份证字段** `data.id`（`caseId` 会合法地重复出现，不能算作 id 重复）
  const ids = journal.read().events
    .map((event) => String(event.data.id ?? ''))
    .filter((id) => /^(TR|TC|DEF|REV|RUN)-\d+$/u.test(id))
  assert.equal(new Set(ids).size, ids.length, `真源里出现重复 id：${ids.join(' ')}`)
})
