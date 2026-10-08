/**
 * **R1（复审 major）**：D4 硬化只查"有没有事件"，没查"事件说的什么" ——
 * journal 记 `fail`、把结果文件改成 `pass` ⇒ C-50 照绿。这里判据是**文件状态 vs 事件状态**。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { CHECKERS } from '../src/domain/gates.js'
import { recordTestCase, recordTestResult, verificationStats } from '../src/domain/records.js'
import { recordSignature } from '../src/domain/signature.js'
import type { GateContext } from '../src/domain/gates.js'
import type { TestResult } from '../src/domain/records.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm56')
let store: SdoStore
let journal: Journal

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

test('R1：把 `fail` 的结果文件改成 `pass` ⇒ 判据判红并点名（事件里仍是 fail）', () => {
  recordTestCase(store, journal, { kind: 'unit', title: 'a', steps: [], expected: 'ok' } as never)
  recordTestResult(store, journal, { caseId: 'TC-001', status: 'fail', evidence: 'node --test 红' })

  // 一致时：不因"被改写"判红
  const before = CHECKERS['tests.passed']?.(context())
  assert.equal(before?.detail.includes('不一致'), false, `一致时不得报不一致：${before?.detail}`)
  assert.deepEqual(verificationStats(store, journal).tampered, [])

  // 手改文件：fail -> pass（真源事件仍是 fail）
  const rewritten: TestResult = { id: 'TR-001', caseId: 'TC-001', status: 'pass', evidence: 'node --test 红', at: '2026-01-01T00:00:00.000Z' }
  store.writeYaml(['tests', 'results', 'TR-001.yml'], { result: rewritten })
  const stats = verificationStats(store, journal)
  assert.deepEqual(stats.tampered, [{ id: 'TR-001', file: 'pass', journal: 'fail' }], 'R1：文件与真源状态不一致必须被列出来')
  assert.equal(stats.passed, 1, '统计口径不变（旧实现也数 pass）—— 变的是"能看出来"')

  const after = CHECKERS['tests.passed']?.(context())
  assert.equal(after?.ok, false, 'R1：改判必须判红')
  assert.match(after?.detail ?? '', /不一致/u)
  assert.match(after?.detail ?? '', /TR-001/u, '要点名')
  assert.match(after?.remedy ?? '', /action=record/u, '补救话术要给可执行动作')
})

test('R3：与真源事件对不上的签字**不算有效**（判据级，不只是理由里多一句警告）', () => {
  // ① 工具签的字 ⇒ 判据 ok
  recordSignature(store, journal, { gate: 'G3', by: 'user', basis: '见设计 §2', channel: 'question' })
  const good = CHECKERS['design.signed']?.(context())
  assert.equal(good?.ok, true, `工具签的字应通过：${good?.detail}`)

  // ② 手写一条（真源无对应事件）⇒ 判据**必须红**（此前只是 status=valid + ⚠️ 警告）
  store.writeYaml(['gates', 'signatures.yml'], {
    signatures: [{ gate: 'G3', by: 'user', basis: '我签的', channel: 'question', at: '2026-01-01T00:00:00.000Z', atSeq: 1 }],
  })
  const forged = CHECKERS['design.signed']?.(context())
  assert.equal(forged?.ok, false, 'R3：手写签字不得算有效')
  assert.match(forged?.detail ?? '', /找不到|不一致/u, '理由要说清是哪一种不一致')
})
