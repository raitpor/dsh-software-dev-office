/**
 * **增量 173：DEF-075（major，第三批 §3.8）—— 已修缺陷必须有测试结论**。
 *
 * 修前现盘：`fixed` 的缺陷可以**永久不被测试**而门禁不判红任何一格 —— C-51 只管**阻塞级**；
 * C-63 只遍历**卡上声明 `fixes`** 的行，而外部会话（创造模式）直接修的缺陷**没有卡** ⇒ `checked = 0`
 * ⇒ 判据自己判 N/A（盲区正好覆盖本项目的修复主力通道）；追溯图也**没有**"缺陷↔结果"这类边。
 *
 * 修法（绑定方式 **(a)**：TR 带 `defects` 字段 —— 依据与结论同生共死，不必新增追溯边种类）：
 *   · 新增判据 **`defects.fixed-tested`**（挂 **G6**：测试结论是验证阶段的产物，与 `tests.passed` /
 *     `trace.coverage` / `review.independent` 同族；不塞 G7 —— 那会让历史缺陷一次性变成交付阻塞）；
 *   · 唯一出口 `fixedDefectsWithoutTestResult(store)`：只看 `status === 'fixed'`，**依据 = 一条 `pass` 的 TR**
 *     把缺陷 id 绑进 `defects`；`fail` 绑着它 ⇒ 仍判红并**点名那条 fail 结果**；
 *   · **四流程各声明一条、措辞逐字一致**（C-59 / C-64 都栽在"只改一处"上）；
 *   · 记录时**未知缺陷 id 可读拒绝**（打错一个字就"绑上了"是最坏的形态）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { fixedDefectsWithoutTestResult } from '../src/domain/records.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m173/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's-def075', cwd: WORKSPACE } as unknown as OfficeCall

/** G6 里这条判据的读数。 */
function c65(): { ok: boolean; detail: string; remedy?: string } {
  const criterion = office.evaluate(call, 'G6').criteria.find((item) => item.id === 'C-65')
  assert.ok(criterion !== undefined, '前置：G6 必须声明 C-65（defects.fixed-tested）')
  return criterion as { ok: boolean; detail: string; remedy?: string }
}

/** 记一条缺陷（`status` 由夹具给）。 */
function defect(id: string, status: 'fixed' | 'wontfix'): void {
  office.addDefect(call, {
    id: undefined as never,
    title: `${id} 的现场`, severity: 'major', status, at: '',
    ...(status === 'wontfix' ? { waiveReason: '已知取舍：影响面为零', waiveApprovedBy: '用户 2026-10-15' } : {}),
  } as never)
}

/** 记一条用例 + 一条结果（可带 `defects` 绑定）。 */
function result(caseId: string, status: 'pass' | 'fail', defects?: string[]): void {
  office.storeFor(WORKSPACE).writeYaml(['tests', `${caseId}.yml`], {
    testCase: { id: caseId, title: caseId, kind: 'unit', requirement: '', steps: [], expected: 'x', at: '' },
  })
  const outcome = office.addTestResult(call, {
    caseId, status, evidence: 'npm test 输出',
    ...(defects === undefined ? {} : { defects }),
  } as never)
  assert.equal(outcome.ok, true, `夹具前提：${caseId} 必须记成功：${JSON.stringify(outcome)}`)
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-def075', WORKSPACE)
  office.init(call, { name: 'M173 已修必有结论', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M173-01 行为两态：`fixed` 无绑定结论 ⇒ 判红并点名；补上一条 pass 结论 ⇒ 转绿（反例）', () => {
  defect('DEF-001', 'fixed')
  // ① 无依据 ⇒ 判红 + 点名 + 给可执行修法
  const red = c65()
  assert.equal(red.ok, false, '已修但无测试结论必须判红')
  assert.match(red.detail, /DEF-001/u, `判红必须点名缺陷 id：${red.detail}`)
  assert.match(red.detail, /已修但无测试结论/u, `判红必须说清缺的是什么：${red.detail}`)
  assert.match(red.remedy ?? '', /sdo_test action=record/u, '修法必须可执行（去跑那条测试、记下结论）')
  assert.match(red.remedy ?? '', /defects=/u, '修法必须给出绑定写法')

  // ② 补上绑定它的 pass 结论 ⇒ 转绿
  result('TC-001', 'pass', ['DEF-001'])
  const green = c65()
  assert.equal(green.ok, true, `补上依据后必须转绿（反例）：${green.detail}`)
  // 唯一出口也同口径
  assert.deepEqual(fixedDefectsWithoutTestResult(office.storeFor(WORKSPACE)), [], '唯一出口：已无"缺依据"的 fixed 缺陷')
})

test('M173-02 边界与反例：`wontfix` 不参与；`fail` 绑着它仍判红且点名那条结果；别的缺陷不误伤', () => {
  defect('DEF-001', 'fixed')
  defect('DEF-002', 'wontfix')   // 免责两字段齐备 ⇒ 不需要 TR
  result('TC-001', 'fail', ['DEF-001'])
  const red = c65()
  assert.equal(red.ok, false, 'fail 结论不构成"已修"的依据 ⇒ 仍判红')
  assert.match(red.detail, /DEF-001/u, '必须点名那条 fixed 缺陷')
  assert.match(red.detail, /TR-001/u, `必须点名绑着它的那条 fail 结果（它现在还是坏的）：${red.detail}`)
  assert.equal(red.detail.includes('DEF-002'), false, '`wontfix` + 免责两字段齐备者不算缺依据（口径同 C-51/C-63）')
  // 反例：`skip` 也不算依据
  result('TC-002', 'pass', ['DEF-002'])
  assert.equal(c65().ok, false, 'wontfix 的缺陷本来就不要求 TR；这里判红的原因是 DEF-001 仍缺依据')
})

test('M173-03 记录时**未知缺陷 id 可读拒绝**（打错一个字不算"绑上了"），且零写盘', () => {
  defect('DEF-001', 'fixed')
  const before = office.storeFor(WORKSPACE).listNames('tests/results').length
  office.storeFor(WORKSPACE).writeYaml(['tests', 'TC-009.yml'], {
    testCase: { id: 'TC-009', title: 't', kind: 'unit', requirement: '', steps: [], expected: 'x', at: '' },
  })
  const outcome = office.addTestResult(call, {
    caseId: 'TC-009', status: 'pass', evidence: 'x', defects: ['DEF-999'],
  } as never)
  assert.equal(outcome.ok, false, '未知缺陷 id 必须被拒（否则绑定是假的）')
  if (!outcome.ok) {
    assert.equal(outcome.code, 'unknown-defect', `拒因码要自成一类：${JSON.stringify(outcome)}`)
    assert.match(outcome.detail, /DEF-999/u, '拒因必须点名那个 id')
    assert.match(outcome.detail, /没有写入/u, '拒因必须说清零写盘')
  }
  assert.equal(office.storeFor(WORKSPACE).listNames('tests/results').length, before, '被拒时零写盘')
})

test('M173-04 结构：**四流程**各声明一条且措辞逐字一致（C-59 / C-64 都栽在"只改一处"上）', () => {
  const descs = new Map<string, string>()
  for (const name of ['waterfall', 'agile', 'prototype', 'spiral']) {
    const text = readFileSync(join(ROOT, 'src', 'data', 'processes', `${name}.yml`), 'utf8')
    const match = /- \{ id: C-65, check: "defects\.fixed-tested", desc: "([^"]*)" \}/u.exec(text)
    assert.ok(match !== null, `${name}.yml 的 G6 必须声明 C-65 / defects.fixed-tested`)
    descs.set(name, match[1] ?? '')
  }
  const unique = new Set(descs.values())
  assert.equal(unique.size, 1, `四流程的 desc 必须逐字一致（实际 ${unique.size} 种）`)
  const [desc] = [...unique]
  // ⑤ 语言/格式/项目无关：措辞里不得出现具体项目名或语言名
  for (const forbidden of ['node', 'typescript', 'npm', 'python', 'PRJ-001', 'dsh']) {
    assert.equal((desc ?? '').toLowerCase().includes(forbidden.toLowerCase()), false, `desc 不得含项目/语言特有词：${forbidden}`)
  }
  assert.match(desc ?? '', /defects/u, 'desc 必须点名绑定字段')
  assert.match(desc ?? '', /fixed/u, 'desc 必须说清管的是 `fixed`')
})
