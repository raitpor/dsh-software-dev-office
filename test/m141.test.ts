/**
 * **增量 141：测试结果必须对得上一条真实存在的用例（DEF-037，§3E 漏卡缺陷批 族 7）**。
 *
 * 缺陷原文（C 组 re-verify，2026-10-14）：`recordTestResult` 收下 `caseId='TC-999'`（台账里不存在）
 * 与 `caseId=''`，零校验 ⇒ 台账**不可区分**"指向不存在的用例"与"指向真实用例"，
 * 下游还会报出 `cases=0 results=1 passed=1 passedAdopted=1` 这种**无人认领的绿**。
 *
 * **先钉红**（修复前的现盘读数，用 lib/ 构建跑的探针）：
 *   ```
 *   ① 幽灵 caseId(TC-999) 被接受 = true
 *   ② 空 caseId 被接受 = true
 *   ③ 结果总数 = 2 ｜台账用例 = TC-001
 *   ```
 *
 * **修法**：结果是**用例的**结果 ⇒ 写入前对账 `caseId` 必须非空且存在于用例台账；两条**可读拒绝**
 * （`case-id-required` / `case-not-found`，各带可执行修法），并且**拒绝时一个字节都不落盘**。
 * 反例同测：用例真实存在 ⇒ 正常写入并转绿（防止修成"全判红"）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { listTestCases, listTestResults, recordTestCase, recordTestResult } from '../src/domain/records.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m141/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
let store: SdoStore
let journal: Journal
let tools: { name: string; parameters: unknown; execute: (a: Record<string, unknown>, c: { agent?: unknown }) => unknown }[]
const call = { sessionId: 's-dev', cwd: WORKSPACE } as unknown as OfficeCall

const newCase = (title: string): void => {
  recordTestCase(store, journal, { kind: 'unit', title, steps: [], expected: 'ok' } as never)
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, '.sdo'), { recursive: true })
  store = new SdoStore(join(WORKSPACE, '.sdo'))
  journal = new Journal(store)
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-dev', WORKSPACE)
  office.init(call, { name: 'M141 用例对账', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['z'], glossary: { a: 'b' } })
  // **夹具前提**：工具面的 `record` 有一道**更早**的闸（REQ-054 判定基准）⇒ 需要一条真实需求供 oracle 引用
  office.capture(call, {
    title: '结果必须指向真实用例',
    statement: '记录测试结果时必须能对上一条例真实存在的用例',
    rationale: '否则会出现无人认领的绿',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  tools = []
  const services: Record<string, unknown> = { tools: { register: (t: never) => { tools.push(t); return () => {} }, get: (n: string) => ({ n }) } }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => {
      if (names.every((name) => name in services)) cb(makeCtx())
    },
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M141-01 幽灵 caseId：可读拒绝 + **一个字节都不落盘**（红侧：旧实现接受并写盘）', () => {
  newCase('真实用例')
  const before = listTestResults(store).length
  const outcome = recordTestResult(store, journal, { caseId: 'TC-999', status: 'pass', evidence: 'x' })
  assert.equal(outcome.ok, false, '指向不存在用例的结果必须被拒（旧实现接受）')
  if (outcome.ok) assert.fail('幽灵用例必须拒绝')
  assert.equal(outcome.code, 'case-not-found')
  assert.match(outcome.detail, /TC-999/u, '要点名是哪个 caseId 对不上')
  assert.match(outcome.detail, /TC-001/u, '要给出台账里真实存在的用例（可执行修法）')
  assert.equal(listTestResults(store).length, before, '拒绝时不许写盘（否则又出现无人认领的绿）')

  // 台账不变量：每一条结果都能对上一个真实用例
  const caseIds = new Set(listTestCases(store).map((item) => item.id))
  assert.equal(listTestResults(store).every((item) => caseIds.has(item.caseId)), true, '结果 ⊆ 用例 这条不变量必须成立')
})

test('M141-02 空 caseId：可读拒绝且点名"先建用例"', () => {
  const outcome = recordTestResult(store, journal, { caseId: '', status: 'pass', evidence: 'x' })
  assert.equal(outcome.ok, false)
  if (outcome.ok) assert.fail('空 caseId 必须拒绝')
  assert.equal(outcome.code, 'case-id-required')
  assert.match(outcome.detail, /sdo_test action=plan/u, '要给可执行修法（怎么建用例）')
  assert.equal(listTestResults(store).length, 0, '拒绝时零写入')
})

test('M141-03 反例：用例真实存在 ⇒ 正常写入（不许修成"全判红"）', () => {
  newCase('真实用例')
  const outcome = recordTestResult(store, journal, { caseId: 'TC-001', status: 'pass', evidence: 'node --test 全绿' })
  assert.equal(outcome.ok, true, `对得上用例的结果必须能写：${outcome.ok ? '' : outcome.detail}`)
  if (!outcome.ok) assert.fail('应写入')
  assert.equal(outcome.result.caseId, 'TC-001')
  const written = listTestResults(store)
  assert.equal(written.length, 1)
  assert.equal(written[0]?.id, outcome.result.id)
})

test('M141-04 工具级：`sdo_test action=record` 的回执点名问题（走真实注册的工具）', async () => {
  newCase('真实用例')
  const tool = tools.find((item) => item.name === 'sdo_test')
  assert.ok(tool !== undefined, '工具面缺 sdo_test')
  const agentStub = { id: 's-dev', session: { header: { id: 's-dev', cwd: WORKSPACE, delegationDepth: 0 } } }
  const oracle = '{"kind":"expert","ref":"REQ-001","expert":"张三"}'
  const ghost = String(await tool.execute(
    { action: 'record', caseId: 'TC-404', status: 'pass', evidence: 'x', oracle },
    { agent: agentStub },
  ))
  assert.match(ghost, /case-not-found/u, `回执必须给出拒绝码：${ghost.slice(0, 200)}`)
  assert.match(ghost, /TC-404/u, '回执要点名幽灵 caseId')

  const real = String(await tool.execute(
    { action: 'record', caseId: 'TC-001', status: 'pass', evidence: 'node --test 全绿', oracle },
    { agent: agentStub },
  ))
  assert.equal(/case-not-found|case-id-required/u.test(real), false, `真实用例必须能记录：${real.slice(0, 200)}`)
  assert.equal(listTestResults(store).length, 1, '只写进真实那一条')
})

test('M141-05 既有下游口径不被破坏：`verificationStats` 不再能报出"无人认领的绿"', () => {
  // 红侧探针的收尾读数：旧实现是 cases=0 results=1 passed=1
  newCase('真实用例')
  recordTestResult(store, journal, { caseId: 'TC-001', status: 'pass', evidence: 'x' })
  const stats = office.verification(call)
  assert.equal(stats.cases >= 1, true, `用例数必须 ≥1：${JSON.stringify(stats)}`)
  assert.equal(stats.results, 1, '结果数与用例数同量纲（不再是 0 用例 + 1 幽灵结果）')
})
