/**
 * **增量 205：`DEF-143` —— C-50 不许把「无主结果」当成失败用例。**
 *
 * 病根（真机）：`verificationStats` 按 caseId 取最新一条结果，`C-50` 把"最新是 fail"的一律记进
 * 「失败用例」；而台账里有 5 条结果是**变异自证的红侧观测**（`M95-03` / `TASK-063-RED` /
 * `TC-076-RED` / `TC-076-RED-SUB` / `TC-103-RED`），它们**从来不是用例**（`.sdo/tests/` 里没有文件），
 * 结果又不能删、也不能覆盖（`recordTestResult` 要求 caseId 在册）⇒ 判据永久红且**无收口路径**。
 *
 * 口径（任务书 §2.2）：
 *   · 无主结果既不是「通过」也不是「失败用例」，它是**另一种东西**；
 *   · 判红只看**已登记**用例里最新为 fail 的那些（新字段 `failedRegisteredCaseIds`）；
 *   · 无主结果**必须点名报出**（新字段 `orphanResultCaseIds`），绝不许静默丢弃。
 *
 * 四态（DoD ③）：A 无主 + 全绿 ⇒ 绿且点名；B 已登记有 fail ⇒ 红且只点它；
 * C 同一条无主结果多条 ⇒ 只点一次；D 无主 + 全绿 + `unrun` ⇒ 仍按 `unrun` 红（各面互不遮蔽）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { listTestCases, recordTestCase, recordTestResult, verificationStats } from '../src/domain/records.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { GateCriterionResult } from '../src/types.js'
import type { Journal } from '../src/infra/journal.js'
import type { SdoStore } from '../src/infra/store.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm205')
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's-m205', cwd: WORKSPACE } as unknown as OfficeCall

function store(): SdoStore {
  return office.storeFor(WORKSPACE)
}

function journal(): Journal {
  return office.journalFor(WORKSPACE)
}

/** C-50 的当前判定（`tests.passed`，挂在 G6 上）。 */
function c50(): GateCriterionResult {
  const criterion = office.evaluate(call, 'G6').criteria.find((item) => item.id === 'C-50')
  assert.equal(criterion !== undefined, true, '前置：G6 必须声明 C-50（tests.passed）')
  return criterion as GateCriterionResult
}

/** 一条 must 需求（带一条 AC，供 oracle 指过去）。 */
function seedRequirement(requirement = 'REQ-001'): void {
  store().writeYaml(['requirements', `${requirement}.yml`], {
    requirement: {
      id: requirement, title: requirement, statement: 's', priority: 'must', status: 'baselined',
      acceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
    },
  })
}

/** 登记一条用例并把它链到 REQ-001（`req-tc`），返回 caseId。 */
function seedCase(title = '用例'): string {
  const testCase = recordTestCase(store(), journal(), { title, kind: 'unit', requirement: 'REQ-001', steps: ['跑'], expected: '通过' })
  office.linkTrace(call, [{ from: 'REQ-001', to: testCase.id, kind: 'req-tc' }])
  return testCase.id
}

/** 记一条**已被独立采纳**的 pass（否则会先撞 `unadopted` 那一面，测不到本卡）。 */
function recordAdoptedPass(caseId: string): void {
  recordTestResult(store(), journal(), {
    caseId, status: 'pass', evidence: '真跑通过',
    executedBy: 'runner', adoptedBy: 'reviewer', adoptedAt: '2026-10-20T00:00:00.000Z',
    oracle: { kind: 'acceptance', ref: 'REQ-001', criterion: 'AC-001' },
  })
}

let orphanSeq = 0

/**
 * 记一条**无主**结果（caseId 不在用例登记表：模拟变异自证的红侧观测）。
 *
 * 必须**直接写盘 + 补 `test/recorded` 事件**：写入面自 `DEF-037` 起拒收未登记的 caseId，
 * 而这五条恰恰是"历史遗留、已经落在盘上"的形态 —— 用工具面造不出来，只能按真源形状构造。
 */
function recordOrphan(caseId: string, status: 'fail' | 'skip' | 'pass' = 'fail', extra: Record<string, unknown> = {}): void {
  orphanSeq += 1
  const id = `TR-90${orphanSeq}`
  store().writeYaml(['tests', 'results', `${id}.yml`], {
    result: { id, caseId, status, evidence: '变异体在盘时的红侧观测', at: '2026-10-20T00:00:00.000Z', ...extra },
  })
  journal().append('test/recorded', { id, caseId, status })
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-m205', WORKSPACE)
  office.init(call, { name: 'M205 无主结果不是失败用例', scale: 'normal', stakeholders: ['业务方'] })
  seedRequirement()
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M205-01 态 A：无主结果 + 已登记用例全绿 ⇒ 判绿，且 ok 话术点名那几条无主结果', () => {
  const caseId = seedCase()
  recordAdoptedPass(caseId)
  recordOrphan('M95-03')
  recordOrphan('TC-076-RED')
  const stats = verificationStats(store(), journal())
  assert.deepEqual(stats.orphanResultCaseIds, ['M95-03', 'TC-076-RED'], '无主结果必须单列（去重、排序稳定）')
  assert.deepEqual(stats.failedRegisteredCaseIds, [], '已登记用例没有 fail')
  const result = c50()
  assert.equal(result.ok, true, `无主结果不该让 C-50 判红：${result.detail}`)
  assert.match(result.detail, /M95-03/u, 'ok 话术必须点名无主结果（不许静默丢弃）')
  assert.match(result.detail, /TC-076-RED/u, 'ok 话术必须点名无主结果（不许静默丢弃）')
})

test('M205-02 态 B：已登记用例有一条 fail ⇒ 判红且**只点它**（不许因为有无主结果就放宽）', () => {
  const caseId = seedCase()
  recordTestResult(store(), journal(), { caseId, status: 'fail', evidence: '真跑失败' })
  recordOrphan('TC-103-RED')
  const stats = verificationStats(store(), journal())
  // **既有读数语义不变**（这是本仓的纪律）：`failed` 仍数"所有最新 fail"（含无主结果），
  // 新语义只体现在新字段上 —— 判据读 `failedRegisteredCaseIds`，读数面继续报 `failed`/`failedCaseIds`。
  assert.equal(stats.failed, 2, '既有 failed 读数语义不变（含无主结果，仍是 2 条）')
  assert.equal(stats.failedCaseIds.length, 2, '既有 failedCaseIds 仍全量点名')
  assert.deepEqual(stats.failedRegisteredCaseIds, [caseId], '新字段只装已登记的')
  const result = c50()
  assert.equal(result.ok, false, '已登记用例有 fail ⇒ 必须红')
  assert.match(result.detail, new RegExp(caseId, 'u'), '必须点名那条已登记的失败用例')
  assert.equal(result.detail.includes('TC-103-RED'), false, '无主结果不许被算成"失败用例"')
})

test('M205-03 态 C：同一条无主结果出现多条 ⇒ 只点名一次（去重）', () => {
  const caseId = seedCase()
  recordAdoptedPass(caseId)
  recordOrphan('TC-076-RED')
  recordOrphan('TC-076-RED')
  const stats = verificationStats(store(), journal())
  assert.deepEqual(stats.orphanResultCaseIds, ['TC-076-RED'], '同一 caseId 多条结果只算一条无主')
  const result = c50()
  assert.equal(result.ok, true, `无主结果不判红：${result.detail}`)
  assert.equal((result.detail.match(/TC-076-RED/gu) ?? []).length, 1, '点名一次就够（重复点名会让人以为有两条用例）')
})

test('M205-04 态 D：无主结果 + 已登记全绿 + 有已登记用例没结果 ⇒ 仍按 `unrun` 判红（各面互不遮蔽）', () => {
  const caseId = seedCase()
  recordAdoptedPass(caseId)
  seedCase('第二条用例（没有结果）')
  recordOrphan('M95-03')
  const result = c50()
  assert.equal(result.ok, false, '`unrun` 面必须仍然判红（无主结果不许遮蔽它）')
  const orphanCase = listTestCases(store()).find((item) => item.id !== caseId)
  assert.ok(orphanCase !== undefined)
  assert.match(result.detail, new RegExp(orphanCase.id, 'u'), '要点名那条没跑的用例')
})

test('M205-05 态 E：**无主结果的 skip** + 已登记用例全绿 ⇒ 判绿并点名（无主 skip 不是"没处置的用例"）', () => {
  const caseId = seedCase()
  recordAdoptedPass(caseId)
  recordOrphan('M106-01', 'skip')
  const stats = verificationStats(store(), journal())
  assert.deepEqual(stats.skippedCaseIds, ['M106-01'], '既有 skippedCaseIds 语义不变（仍全量）')
  assert.deepEqual(stats.skippedRegisteredCaseIds, [], '新字段只装已登记的')
  const result = c50()
  assert.equal(result.ok, true, `无主 skip 不该让 C-50 判红：${result.detail}`)
  assert.match(result.detail, /M106-01/u, 'ok 话术必须点名该无主 id')
})

test('M205-06 态 F：**无主结果进了 unadopted**（没有执行者/采纳者）+ 已登记全绿 ⇒ 判绿并点名', () => {
  const caseId = seedCase()
  recordAdoptedPass(caseId)
  // 无主 pass：没有 executedBy/adoptedBy ⇒ 落在 unadopted（既有口径），但它没有登记用例
  recordOrphan('TC-017-RED', 'pass')
  const stats = verificationStats(store(), journal())
  assert.equal(stats.unadopted.length >= 1, true, '既有 unadopted 语义不变（仍全量）')
  assert.deepEqual(stats.unadoptedRegistered, [], '新字段只装已登记的')
  const result = c50()
  assert.equal(result.ok, true, `无主 unadopted 不该让 C-50 判红：${result.detail}`)
  assert.match(result.detail, /TC-017-RED/u, 'ok 话术必须点名该无主 id')
})

test('M205-07 反例①（不许放宽）：**已登记**用例的 skip 未处置 ⇒ 仍判红', () => {
  const healthy = seedCase()
  recordAdoptedPass(healthy)
  const skipping = seedCase('只记了 skip 的用例')
  recordTestResult(store(), journal(), { caseId: skipping, status: 'skip', evidence: '本机没有该平台' })
  const result = c50()
  assert.equal(result.ok, false, '已登记用例的 skip 未处置必须仍判红（这两面不许被关掉）')
  assert.match(result.detail, new RegExp(skipping, 'u'), '必须点名那条未处置的 skip 用例')
})

test('M205-08 反例②（不许放宽）：**已登记**用例的 pass 未采纳 ⇒ 仍判红', () => {
  const adopted = seedCase()
  recordAdoptedPass(adopted)
  const unadopted = seedCase('自己给自己盖章的用例')
  recordTestResult(store(), journal(), {
    caseId: unadopted, status: 'pass', evidence: '自己跑的',
    executedBy: 'runner', adoptedBy: 'runner', adoptedAt: '2026-10-20T00:00:00.000Z',
    oracle: { kind: 'acceptance', ref: 'REQ-001', criterion: 'AC-001' },
  })
  const result = c50()
  assert.equal(result.ok, false, '已登记用例的 pass 未独立采纳必须仍判红')
  assert.match(result.detail, /TR-|未采纳|采纳/u, `必须点名未采纳：${result.detail}`)
})
