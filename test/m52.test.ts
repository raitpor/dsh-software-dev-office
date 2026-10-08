/**
 * 整仓评审 D8 / D4（我复核成立，且在"用户不会主动改 `.sdo/` 内文件"的前提下更该收紧）：
 *   · **D8**：签字台账（`gates/signatures.yml`）与真源事件（journal 的 `gate/signed`）要能**交叉核对** ——
 *     删掉 YAML 不再与"从来没签过"长得一样；手写一条也不再无人知晓。
 *   · **D4**：`tests/results/*.yml` 里有、journal 里没有 `test/recorded` 的结果要能被点名 ——
 *     "证据是跑出来的"与"证据是写出来的"必须分得开。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { recordSignature, signatureState } from '../src/domain/signature.js'
import { recordTestResult, verificationStats } from '../src/domain/records.js'
import type { TestResult } from '../src/domain/records.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm52')
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

test('D8：签字台账与真源事件交叉核对（删文件 / 手写都要被看见）', () => {
  recordSignature(store, journal, { gate: 'G3', by: 'user', basis: '见 REQ-001 与设计 §2', channel: 'question' })
  const normal = signatureState(store, journal, 'G3')
  assert.equal(normal.status, 'valid', `工具签的字应有效：${normal.status}`)
  assert.equal(normal.inconsistent, undefined, '一致时不得乱标')

  // ① 删掉台账文件 ⇒ 状态仍是 missing，但**必须**被标成"不一致"（真源有事件）
  rmSync(join(BASE, '.sdo', 'gates', 'signatures.yml'), { force: true })
  const deleted = signatureState(store, journal, 'G3')
  assert.equal(deleted.status, 'missing')
  assert.equal(deleted.inconsistent, true, 'D8：文件被删 + 真源有事件 ⇒ 不一致（不是"从来没签过"）')
  assert.match(deleted.reason, /gate\/signed/u, '理由里要说清真源有事件')

  // ② 手写一条台账（真源无对应事件）⇒ 同样标不一致
  store.writeYaml(['gates', 'signatures.yml'], {
    signatures: [{ gate: 'G3', by: 'user', basis: '我签的', channel: 'question', at: '2026-01-01T00:00:00.000Z', atSeq: 1 }],
  })
  const forged = signatureState(store, journal, 'G3')
  assert.equal(forged.inconsistent, true, 'D8：手写的签字必须被标"无事件佐证"')
  assert.match(forged.reason, /找不到/u)
})

test('D4：没有 `test/recorded` 事件的结果要被点名（手写文件不能当证据）', () => {
  recordTestResult(store, journal, { caseId: 'TC-001', status: 'pass', evidence: 'node --test 全绿' })
  assert.deepEqual(verificationStats(store, journal).unjournaled, [], '工具记的结果必须有事件佐证')

  // 手写一条（真源零事件）⇒ 被点名
  const forged: TestResult = { id: 'TR-002', caseId: 'TC-002', status: 'pass', evidence: '', at: '2026-01-01T00:00:00.000Z' }
  store.writeYaml(['tests', 'results', 'TR-002.yml'], { result: forged })
  const stats = verificationStats(store, journal)
  assert.deepEqual(stats.unjournaled, ['TR-002'], 'D4：手写结果必须被点名')
  assert.equal(stats.passed, 2, '统计口径不变（旧实现也是 2）—— 变的是"能不能看出来"')
  // 没给 journal ⇒ 无法核验 ⇒ 如实返回空（不假装核过）
  assert.deepEqual(verificationStats(store).unjournaled, [])
})
