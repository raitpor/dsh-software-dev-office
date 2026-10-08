/**
 * **D4 硬化（整仓评审 major）**：`tests.passed` 只读 `tests/results/*.yml` ⇒
 * 手写一条 `status=pass` 的 YAML（journal 零事件）就能把这条判据判绿；`recordTestResult(fail)` 之后
 * 把文件改成 `pass` 也查不出来。硬化后：**结果必须有 `test/recorded` 事件佐证**，
 * 否则判红并点名；journal 被坏行截断时按"无法判定"判红（截断 ≠ 通过）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { CHECKERS } from '../src/domain/gates.js'
import { recordTestCase, recordTestResult } from '../src/domain/records.js'
import type { GateContext } from '../src/domain/gates.js'
import type { TestResult } from '../src/domain/records.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm55')
let store: SdoStore
let journal: Journal

/** 只给这条判据要用的字段（其余留空）—— 判据函数是纯函数，不需要真跑整条门禁。 */
function context(): GateContext {
  return { workspace: BASE, store, journal, requirements: [] } as unknown as GateContext
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('D4 硬化：手写的结果文件必须让 `tests.passed` 判红并点名', () => {
  recordTestCase(store, journal, { kind: 'unit', title: 'a', steps: [], expected: 'ok' } as never)

  // ① 工具记账 ⇒ 不因"无佐证"判红（这条判据不负责覆盖追溯，uncoveredMust 由 trace 判）
  recordTestResult(store, journal, { caseId: 'TC-001', status: 'pass', evidence: 'node --test 全绿' })
  const okRun = CHECKERS['tests.passed']?.(context())
  assert.equal(okRun?.detail.includes('没有真源事件佐证'), false, `工具记的结果不该被判"无佐证"：${okRun?.detail}`)

  // ② 手写第二条（真源零事件）⇒ 判红 + 点名 TR-002
  const forged: TestResult = { id: 'TR-002', caseId: 'TC-001', status: 'pass', evidence: '', at: '2026-01-01T00:00:00.000Z' }
  store.writeYaml(['tests', 'results', 'TR-002.yml'], { result: forged })
  const bad = CHECKERS['tests.passed']?.(context())
  assert.equal(bad?.ok, false, 'D4 硬化：手写结果必须判红')
  assert.match(bad?.detail ?? '', /没有真源事件佐证/u)
  assert.match(bad?.detail ?? '', /TR-002/u, '要点名是哪几条')
  assert.match(bad?.remedy ?? '', /sdo_test action=record/u, '补救话术要给出可执行动作')

  // ③ journal 被坏行截断（且仍有查不到事件的结果）⇒ "无法判定"也必须判红（截断 ≠ 通过），话术不同：
  //    这是"无法证明"与"证明是伪造的"两种红，理由/补救文案必须分开
  const journalPath = join(BASE, '.sdo', 'journal.jsonl')
  writeFileSync(journalPath, `${store.readText('journal.jsonl') ?? ''}{"seq":99,"at":"x","type":"test/rec`, 'utf8')
  const truncated = CHECKERS['tests.passed']?.(context())
  assert.equal(truncated?.ok, false, 'D4 硬化：截断期不得判绿')
  assert.match(truncated?.remedy ?? '', /journal/u, '要指向坏行本身')
})
