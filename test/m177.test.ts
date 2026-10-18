/**
 * **增量 177：DEF-076（major，第四批 §3.3）—— 缺陷没有可结构化的评审通路 ⇒「先评审后测试」落不了地**。
 *
 * 现象：`sdo_review` 的入参只有 `taskId`、**没有点名缺陷的地方**；`sdo_test action=defect` 也没有"评审"字段
 * ⇒ 缺陷的"**已评审**"状态**没有结构化真源**（只能靠 `.sdo/evidence/` 报告与 `defect/updated` 的证词）——
 * 一条 `fixed` 缺陷可以**跳过评审直接**拿到 `pass` 测试结论并 `closed`，而判据无从察觉（`C-65` 只看
 * "有没有 pass 的 TR 绑定"）。
 *
 * 用户裁决（`ADR-013`）：顺序是**先评审、后测试**；`closed` = **已核实且已测试通过**。
 * 落法：`sdo_review` 加 `defectId`（可点名一个或多个缺陷，走 `DEF-077` 的 `listDecl` 声明），
 * 门禁 G6 新增 **`defects.fixed-reviewed`（C-66）**：`fixed` 缺陷**有 pass TR 却无已采纳评审点名它** ⇒ 判红并点名。
 *
 * 与 C-65 **分工不重复**：C-65 管"有没有 pass 的 TR"（一条结论都没有 ⇒ C-65 点名），本条管"有没有核实过的评审"
 * （只对**已有 pass TR** 的那些判红）—— 同一概念两处判据必然分叉（`DEF-044` 的教训）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { Review } from '../src/domain/records.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m177/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
/** 实现方会话（记评审、核实、绑 TR 都用它；评审则由**另一个**会话记，避免自证）。 */
const call = { sessionId: 's-impl', cwd: WORKSPACE } as unknown as OfficeCall

interface ToolDefinition { name: string; parameters: { properties?: Record<string, unknown> }; execute: (args: Record<string, unknown>, exec: unknown) => unknown }

function c66(): { ok: boolean; detail: string; remedy?: string } {
  const criterion = office.evaluate(call, 'G6').criteria.find((item) => item.id === 'C-66')
  assert.ok(criterion !== undefined, '前置：G6 必须声明 C-66（defects.fixed-reviewed）')
  return criterion as { ok: boolean; detail: string; remedy?: string }
}

function c65(): { ok: boolean; detail: string } {
  const criterion = office.evaluate(call, 'G6').criteria.find((item) => item.id === 'C-65')
  assert.ok(criterion !== undefined, '前置：G6 必须声明 C-65（defects.fixed-tested）')
  return criterion as { ok: boolean; detail: string }
}

/** 记一条 `fixed` 缺陷（**直给 id**：夹具要能确定地点名它，别依赖自增序）。 */
function defect(id: string): void {
  office.storeFor(WORKSPACE).writeYaml(['defects', `${id}.yml`], {
    defect: { id, title: `${id} 的现场`, severity: 'major', status: 'fixed', at: '' },
  })
}

/** 记一条用例 + 一条 `pass` 结果（绑定 `defects`）。 */
function passingResult(caseId: string, defects: string[]): void {
  office.storeFor(WORKSPACE).writeYaml(['tests', `${caseId}.yml`], {
    testCase: { id: caseId, title: caseId, kind: 'unit', requirement: '', steps: [], expected: 'x', at: '' },
  })
  const outcome = office.addTestResult(call, { caseId, status: 'pass', evidence: 'npm test 输出', defects } as never)
  assert.equal(outcome.ok, true, `夹具前提：${caseId} 必须记成功：${JSON.stringify(outcome)}`)
}

/** 记一条 `pass` 评审（由**别的**会话记：同会话不许自己核实自己）。返回评审。 */
function review(defects: string[]): Review {
  const reviewCall = { sessionId: 's-reviewer', cwd: WORKSPACE } as unknown as OfficeCall
  return office.addReview(reviewCall, {
    taskId: 'TASK-001',
    reviewer: 'subagent:reviewer:9',
    verdict: 'pass',
    findings: [`核实 ${defects.join(' ')} 的修复`],
    defects,
    sessionId: 's-reviewer',
  })
}

function toolHarness(): (name: string, args: Record<string, unknown>) => Promise<string> {
  const tools: ToolDefinition[] = []
  const services: Record<string, unknown> = { tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } } }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  return async (name, args) => {
    const tool = tools.find((item) => item.name === name)
    assert.ok(tool !== undefined, `工具面缺少 ${name}`)
    const exec = { agent: { id: 's-impl', session: { header: { id: 's-impl', cwd: WORKSPACE, delegationDepth: 0 } } } }
    return String(await tool.execute(args, exec))
  }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-impl', WORKSPACE)
  office.noteSession('s-reviewer', WORKSPACE)
  office.init(call, { name: 'M177 先评审后测试', scale: 'normal', stakeholders: ['业务方'] })
  const task = {
    id: 'TASK-001', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['src/'], role: 'developer', size: 'small' as const, revision: 1,
    status: 'in-progress' as const, requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-001.yml'], { task })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M177-01 行为三态：有采纳评审 ⇒ 绿；只有 pass TR ⇒ 判红并点名；记了但**没核实** ⇒ 仍红', () => {
  defect('DEF-001')
  passingResult('TC-001', ['DEF-001'])

  // ① 有 pass 结论、却没有评审点名 ⇒ 判红 + 点名 + 可执行修法
  const red = c66()
  assert.equal(red.ok, false, '有测试结论却没有评审 ⇒ 必须判红（修前这条线在门禁上不存在）')
  assert.match(red.detail, /DEF-001/u, `判红必须点名缺陷 id：${red.detail}`)
  assert.match(red.detail, /无已采纳评审/u, `判红必须说清缺的是什么：${red.detail}`)
  assert.match(red.remedy ?? '', /sdo_review action=record/u, '修法必须可执行（去记一条点名它的评审）')
  assert.match(red.remedy ?? '', /verify-review/u, '修法必须说清"要核实采纳才算依据"')

  // ② 记了一条评审、但**一条发现都没核实** ⇒ 仍未采纳 ⇒ 仍判红（先评审 ≠ 记一条就算）
  const recorded = review(['DEF-001'])
  const unverified = c66()
  assert.equal(unverified.ok, false, '没核实（`adopted`）的评算不上依据')

  // ③ 逐条核实 ⇒ 采纳 ⇒ 转绿（反例：证明判据不是"永远红"）
  const verified = office.verifyReviewFinding(call, {
    reviewId: recorded.id, index: 0, outcome: 'reproduced', evidence: '照着发现能复现 ⇒ exitCode=0', by: 'subagent:developer',
  })
  assert.equal(verified.ok, true, `夹具前提：核实必须成功：${JSON.stringify(verified)}`)
  const green = c66()
  assert.equal(green.ok, true, `采纳之后必须转绿（反例）：${green.detail}`)
})

test('M177-02 分工：没有测试结论的缺陷**留给 C-65 点名**，本条不抢（两个方向都钉住）', () => {
  defect('DEF-002')
  const recorded = review(['DEF-002'])
  office.verifyReviewFinding(call, { reviewId: recorded.id, index: 0, outcome: 'reproduced', evidence: 'x ⇒ exitCode=0', by: 'subagent:developer' })
  // ① 有评审、**没有 pass 结论** ⇒ 本条不参与（trigger 未成立）
  const reading = c66()
  assert.equal(reading.ok, true, `没有 pass TR 的缺陷不归本条管：${reading.detail}`)
  assert.equal(reading.detail.includes('DEF-002'), false, '不得点名"等测试"的那一条')
  // ② `fixed` 且**既无 TR、也无评审** ⇒ 本条同样不点名（这是最关键的一格：丢掉 trigger 就会与 C-65 抢活）
  defect('DEF-003')
  const mixed = c66()
  assert.equal(mixed.ok, true, `没有任何 pass TR 时本条必须保持绿（红的是 C-65）：${mixed.detail}`)
  assert.equal(mixed.detail.includes('DEF-003'), false, '本条只对**已有 pass 结论**的缺陷判红（否则两处判据重叠）')
  // 而 C-65 会把这两条都点名 —— 两条件分工不重叠
  const tested = c65()
  assert.equal(tested.ok, false, '缺测试结论由 C-65 判红')
  assert.match(tested.detail, /DEF-002/u, 'C-65 必须点名它（同一件事只在一个地方点名）')
  assert.match(tested.detail, /DEF-003/u, 'C-65 必须点名既无 TR 也无评审的那条')
})

test('M177-03 反例（假声明）：未知缺陷 id ⇒ 可读拒绝、零写盘（域层与工具面同一出口）', async () => {
  defect('DEF-001')
  const before = office.storeFor(WORKSPACE).listNames('reviews').filter((name) => /^REV-\d+\.yml$/u.test(name)).length
  assert.throws(
    () => review(['DEF-001', 'DEF-999']),
    /DEF-999/u,
    '域层必须拦（`recordReview` 是最低层）',
  )
  assert.equal(
    office.storeFor(WORKSPACE).listNames('reviews').filter((name) => /^REV-\d+\.yml$/u.test(name)).length,
    before,
    '被拒时零写盘',
  )
  // 工具面：同一份判据，回执可读（点名那个 id + 说清没写）
  const callTool = toolHarness()
  const receipt = await callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'subagent:reviewer:9', verdict: 'pass',
    findings: '["核实"]', defectId: 'DEF-999',
  })
  assert.match(receipt, /DEF-999/u, `回执必须点名那个不存在的 id：${receipt.slice(0, 300)}`)
  assert.match(receipt, /没有写入/u, '回执必须说清零写盘')
  assert.equal(
    office.storeFor(WORKSPACE).listNames('reviews').filter((name) => /^REV-\d+\.yml$/u.test(name)).length,
    before,
    '工具面被拒时同样零写盘',
  )
})

test('M177-04 行为（真注册面 + 真数组）：`defectId` 两形态都收，落进 `reviews/REV-*.yml` 并读得回来', async () => {
  defect('DEF-001')
  defect('DEF-002')
  const callTool = toolHarness()
  // 真数组形态（`DEF-077` 的 `listDecl` 声明：宿主 schema 阶段不许拒）
  const viaArray = await callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'subagent:reviewer:9', verdict: 'pass',
    findings: '["核实两条"]', defectId: ['DEF-001', 'DEF-002'],
  })
  assert.match(viaArray, /REV-001/u, `真数组形态必须落盘：${viaArray.slice(0, 300)}`)
  assert.match(viaArray, /DEF-001/u, '回执必须回显点名的缺陷')
  const stored = office.storeFor(WORKSPACE).readYaml<{ review: Review }>('reviews', 'REV-001.yml')?.review
  assert.deepEqual(stored?.defects, ['DEF-001', 'DEF-002'], '点名的缺陷必须进真源（否则判据没有结构化依据）')
  // 文本形态（后向兼容）
  const viaText = await callTool('sdo_review', {
    action: 'record', taskId: 'TASK-001', reviewer: 'subagent:reviewer:9', verdict: 'pass',
    findings: '["核实一条"]', defectId: '["DEF-001"]',
  })
  assert.match(viaText, /REV-002/u, `文本形态照旧可用：${viaText.slice(0, 300)}`)
  const stored2 = office.storeFor(WORKSPACE).readYaml<{ review: Review }>('reviews', 'REV-002.yml')?.review
  assert.deepEqual(stored2?.defects, ['DEF-001'], '两种形态的落盘读数必须等价')
})

test('M177-05 防伪：事后往评审里补一个缺陷号 ⇒ 内容指纹判 `tampered`，判据不认它', () => {
  defect('DEF-001')
  defect('DEF-002')
  passingResult('TC-001', ['DEF-001', 'DEF-002'])
  const recorded = review(['DEF-001'])
  office.verifyReviewFinding(call, { reviewId: recorded.id, index: 0, outcome: 'reproduced', evidence: 'x ⇒ exitCode=0', by: 'subagent:developer' })
  assert.equal(c66().ok, false, '前置：DEF-002 还没被任何评审点名 ⇒ 红')
  assert.match(c66().detail, /DEF-002/u, '前置：点名的是 DEF-002')
  // 手工把 DEF-002 塞进评审文件（`.sdo/reviews/` 是手可编辑真源）⇒ 与记录的指纹不一致
  const store = office.storeFor(WORKSPACE)
  const file = store.readYaml<{ review: Review }>('reviews', `${recorded.id}.yml`)
  assert.ok(file !== undefined, '前置：评审文件必须存在')
  store.writeYaml(['reviews', `${recorded.id}.yml`], { review: { ...file.review, defects: ['DEF-001', 'DEF-002'] } })
  const after = c66()
  assert.equal(after.ok, false, '被改过的评审不许把判据洗白')
  assert.match(after.detail, /DEF-002/u, '它仍必须点名 DEF-002')
})

test('M177-06 结构：判据在注册表里、挂在 **G6**、四个流程文件的 `check`/`desc` 逐字一致', () => {
  assert.match(readFileSync(join(ROOT, 'src', 'domain', 'gates.ts'), 'utf8'), /'defects\.fixed-reviewed':/u, '判据必须注册')
  const lines: string[] = []
  for (const name of ['waterfall', 'prototype', 'agile', 'spiral']) {
    const text = readFileSync(join(ROOT, 'src', 'data', 'processes', `${name}.yml`), 'utf8')
    const line = text.split('\n').find((item) => item.includes('id: C-66'))
    assert.ok(line !== undefined, `${name}.yml 必须声明 C-66`)
    lines.push(line.trim())
    // 归属门禁：C-66 必须落在 G6 的 criteria 段里（G6 与 G7 之间的那一段）
    const g6 = text.indexOf('- id: G6')
    const g7 = text.indexOf('- id: G7')
    assert.ok(g6 > 0 && g7 > g6, `${name}.yml 必须有 G6 与 G7`)
    const at = text.indexOf('id: C-66')
    assert.ok(at > g6 && at < g7, `C-66 必须挂在 G6（不是 G7 —— 与 DEF-075 同族，测试结论/评审都是验证阶段产物）`)
  }
  assert.equal(new Set(lines).size, 1, `四个流程文件的 C-66 必须逐字一致：\n${lines.join('\n')}`)
  assert.match(lines[0] as string, /defects\.fixed-reviewed/u, 'C-66 必须用同一条 `check` 键')
})
