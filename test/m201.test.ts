/**
 * **增量 201：第十四批 `DEF-126`（C-50 的「没跑」只数有没有结果）—— 落点二的守卫。**
 *
 * 病根（真机 `TC-030`）：`tests.passed` 的 `failed` 只数 `fail`、`unrun` 只数「**完全没有结果**」的用例
 * ⇒ 一条 must 用例**一次都没真跑**（只记了 `skip`）既不进 failed 也不进 unrun，判据照绿 = 假绿口子。
 *
 * 修法口径（DoD 逐字，三面边界都不许越界）：
 *   · `skip` **不许**被判成 `fail`（平台相关用例要能表达「这条在我这儿跑不了」）；
 *   · fail 面**不许**放宽（`fail` / `unrun` 那几条判红的语义一字不动）；
 *   · `skip` 必须走 **REQ-057 既有处置词汇**（`.sdo/testing/coverage.yml` 的未覆盖项处置：
 *     `补用例` / `不可达` / `等价`，后两档**必须给理由**）才允许不算红，否则 C-50 逐条点名。
 *
 * 四条读数（DoD ③④）：红侧是**现盘行为**（改前既不进 failed 也不进 unrun）、有处置则绿（反向对照）、
 * 半截处置仍红（不一刀切）、以及"判定在 `gates.ts` / 读数在 `records.ts`"的结构面。
 *
 * ⚠️ 读散文棘轮（`M189-08`）：本文件的断言**期望值一律 ASCII**，中文只进三实参断言的**消息位**。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { countCjkLiterals } from '../src/domain/langScan.js'
import { listTestCases, listTestResults, recordTestCase, recordTestResult, verificationStats } from '../src/domain/records.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { SdoStore } from '../src/infra/store.js'
import type { Journal } from '../src/infra/journal.js'
import type { GateCriterionResult } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm201')
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's-cockpit', cwd: WORKSPACE } as unknown as OfficeCall

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

/** 一条 must 需求 + 一条用例 + `req-tc` 边（真实形态：must 需求只有一条用例，而它只能 skip）。 */
function seed(requirement = 'REQ-001'): string {
  store().writeYaml(['requirements', `${requirement}.yml`], {
    requirement: {
      id: requirement, title: requirement, statement: 's', priority: 'must', status: 'baselined',
      acceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
    },
  })
  const testCase = recordTestCase(store(), journal(), { title: 'clamp 的边界', kind: 'unit', requirement, steps: ['跑'], expected: '通过' })
  office.linkTrace(call, [{ from: requirement, to: testCase.id, kind: 'req-tc' }])
  return testCase.id
}

/** 记一条**只用 skip** 的结果（真源事件照落：证明它不是"没结果"）。 */
function recordSkip(caseId: string): void {
  recordTestResult(store(), journal(), { caseId, status: 'skip', evidence: '本机没有该平台，跑不了' })
}

/** 覆盖真源：`.sdo/testing/coverage.yml` 的一份处置表（`uncovered`）。 */
function writeDispositions(uncovered: Record<string, unknown>[]): void {
  store().writeYaml(['testing', 'coverage.yml'], { coverage: { readings: [], uncovered } })
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-cockpit', WORKSPACE)
  office.init(call, { name: 'M201 skip 不算已覆盖', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M201-01 红侧（现盘行为）：只有 skip 的 must 用例 ⇒ C-50 判红并点名', () => {
  const caseId = seed()
  recordSkip(caseId)
  const stats = verificationStats(store(), journal())
  // ① **改前形态的机械证据**：这条用例既不进 failed，也不进 unrun（= 假绿口子的成因）
  assert.equal(stats.failed, 0, 'skip 不是 fail（不许把平台相关用例判成失败）')
  assert.equal(stats.failedCaseIds.length, 0, 'failed 名单里没有它')
  const unrun = listTestCases(store()).filter((item) => !listTestResults(store()).some((row) => row.caseId === item.id))
  assert.deepEqual(unrun.map((item) => item.id), [], '它有条结果 ⇒ 旧口径的 unrun 也接不住它')
  // ② 但读数面必须点得出"是哪几条只有 skip"
  assert.deepEqual(stats.skippedCaseIds, [caseId], '读数面必须点名"最新结果只是 skip"的用例')
  assert.equal(stats.skipped, 1, '计数口径不变（skipped 仍是 1）')
  // ③ 判据：没有处置 ⇒ 判红并点名
  const red = c50()
  assert.equal(red.ok, false, '只有 skip 的 must 用例必须让 C-50 判红（旧口径在这里判绿 = 假绿）')
  assert.equal(red.detail.includes(caseId), true, `判红必须点名是哪条用例：${red.detail}`)
  assert.equal(/fail/u.test(red.detail), false, '判红文案不许把 skip 说成 fail（它是「没真跑」，不是「跑失败」）')
  assert.equal((red.remedy ?? '').includes('coverage.yml'), true, '修法必须指向处置真源（coverage.yml）')
})

test('M201-02 反向对照（防一刀切）：有 `不可达` 处置 + 理由 ⇒ C-50 判绿', () => {
  const caseId = seed()
  recordSkip(caseId)
  assert.equal(c50().ok, false, '前置：先红')
  writeDispositions([
    { id: 'UN-001', item: 'clamp 的上界分支在本平台不可达', useCase: caseId, disposition: '不可达', reason: '宿主未暴露该工具，代码路径在测试进程里不可达' },
  ])
  const green = c50()
  assert.equal(green.ok, true, `处置成立时必须转绿（REQ-057 的既有词汇）：${green.detail}`)
  // 反例：处置条目在、但**指不到这条用例** ⇒ 又红（防"写一条通用处置就全放行"）
  writeDispositions([
    { id: 'UN-001', item: '另一条分支', useCase: 'TC-999', disposition: '不可达', reason: '随便写的理由文本' },
  ])
  assert.equal(c50().ok, false, '处置指不到这条用例 ⇒ 不算处置（不许用一条通用条目掩盖个别项）')
})

test('M201-03 半截处置仍红：缺理由 / 词表外 / 声明"补用例"却没给用例 ⇒ 逐条点名', () => {
  const caseId = seed()
  recordSkip(caseId)
  // ① `不可达` 但**没给理由**（REQ-057 降级口径：声明不可达必须给依据）
  writeDispositions([{ id: 'UN-001', item: 'x', useCase: caseId, disposition: '不可达' }])
  const noReason = c50()
  assert.equal(noReason.ok, false, '缺理由的"不可达"不算处置')
  assert.equal(noReason.detail.includes('uncovered[0]'), true, `点名必须到字段路径（点不出位置就改不动）：${noReason.detail}`)
  // ② 词表外的取值（自由文本不算处置）
  writeDispositions([{ id: 'UN-001', item: 'x', useCase: caseId, disposition: 'platform-difference', reason: '随便写的理由文本' }])
  const unknown = c50()
  assert.equal(unknown.ok, false, '词表外的处置取值必须判红')
  assert.equal(unknown.detail.includes('platform-difference'), true, '必须点名那个非法取值（只说"不合法"是不可执行的结论）')
  // ③ 声明"补用例"却给了一条**查不到**的用例
  writeDispositions([{ id: 'UN-001', item: 'x', useCase: 'TC-999', disposition: '补用例' }])
  assert.equal(c50().ok, false, '"补用例"指向不存在的用例 ⇒ 不算处置')
})

test('M201-04 边界：skip 不进 fail 面；fail 面也不因本卡放宽（一条 fail 仍然判红）', () => {
  const skipped = seed()
  recordSkip(skipped)
  const failing = seed('REQ-002')
  recordTestResult(store(), journal(), { caseId: failing, status: 'fail', evidence: 'exit=1' })
  const stats = verificationStats(store(), journal())
  assert.deepEqual(stats.failedCaseIds, [failing], 'failed 名单只收那条真跑的 fail（skip 不许混进来）')
  assert.deepEqual(stats.skippedCaseIds, [skipped], 'skip 只从读数面点名')
  const red = c50()
  assert.equal(red.ok, false, '有 fail 结果的用例仍然让 C-50 判红（fail 面不放宽）')
  assert.equal(red.detail.includes(failing), true, `判红要点名那条失败的用例：${red.detail}`)
})

test('M201-05 结构：读数在 records.ts、判定在 gates.ts、处置词表仍只有一份（gates.ts 硬编码中文 0）', () => {
  // ① 读数面：`verificationStats` 提供 skippedCaseIds（计数之外还要点名）
  const records = readFileSync(join(ROOT, 'src', 'domain', 'records.ts'), 'utf8')
  assert.equal(records.includes('skippedCaseIds'), true, '读数（哪几条只有 skip）必须在 records.ts')
  // ② 判定面：C-50 里接线，且**不自己造词表**（处置校验走 mutation.ts 的 assessCoverageItem）
  const gates = readFileSync(join(ROOT, 'src', 'domain', 'gates.ts'), 'utf8')
  assert.equal(gates.includes('skippedCaseGaps(ctx.store, stats.skippedCaseIds)'), true, 'C-50 必须真的用这份读数')
  assert.equal(gates.includes('assessCoverageItem'), true, '处置校验必须复用既有校验器（不在这里另写一套词表）')
  // 词表只有一份：gates.ts 不许自带处置词表（`types.ts` 的 `TESTING_DISPOSITIONS` 是唯一来源；
  // 断言③的「硬编码中文 0」再机械地保证它连中文字面量都没有 —— 词表不可能藏在这里）
  assert.equal(/DISPOSITIONS\s*=/u.test(gates), false, 'gates.ts 不许自带处置词表（词表只有 types.ts 一份）')
  // ③ 棘轮：gates.ts 的硬编码中文必须保持 0（文案走 uiGates.*，两包同步补齐）
  assert.equal(countCjkLiterals(gates), 0, 'gates.ts 出现了硬编码中文：用户可见文案一律走语言包')
})
