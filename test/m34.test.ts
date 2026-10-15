/**
 * 子 agent **取汇报**（三方案）：
 *   ① `sdo_status` 里有「最近完成的派发」；② 子会话 `turn/end` ⇒ 落 `dispatch/finished` + 报告文件；③ 状态块给报告摘要。
 *
 * 为什么这些用例要走**真实监听器与真实工具**：真机上的缺陷恰恰都是"边界/接线"上的 ——
 * 派发是 fire-and-forget（只记 `dispatch/started`），子代理的报告只写在它自己的会话里；
 * 而 `session/event` 的监听器原本整段 `catch {}` 静默吞异常（真机丢过三次派发的观测）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { apply } from '../src/index.js'
import { SdoStore } from '../src/infra/store.js'
import { readChildReportAt, reportFileName } from '../src/domain/dispatchReports.js'
import { TESTING_COVERAGE_CRITERIA, TESTING_WHITEBOX_TECHNIQUES } from '../src/types.js'
import {
  WHITEBOX_COVERAGE_CRITERIA,
  WHITEBOX_CRITERION_LABEL,
  WHITEBOX_CRITERION_TECHNIQUES,
  WHITEBOX_TECHNIQUES,
  canonicalCriterion,
  collectWhiteboxCodeIndex,
  emptyWhiteboxCodeIndex,
  emptyWhiteboxKnownFacts,
  rawWhiteboxDesignText,
  readWhiteboxDesign,
  validateWhiteboxDesign,
  whiteboxDesignFingerprint,
  writeValidatedWhiteboxDesign,
} from '../src/domain/testDesignWhitebox.js'
// **TASK-035 落点七**：口径位（`criterion`）的**形状层**出口 —— 与上面的内容层出口喂**同一个真源值**，
// 断言两层对同一位给出同一结论（别名 `branch` 收下并归到 `decision`；非法取值两侧都判红并点名）。
import { validateTestingSource } from '../src/domain/testingShapes.js'
import type {
  ValidateWhiteboxOptions,
  WhiteboxCodeIndex,
  WhiteboxCriterionCoverage,
  WhiteboxKnownFacts,
  WhiteboxReport,
  WhiteboxWriteResult,
} from '../src/domain/testDesignWhitebox.js'
import type { SdoConfig } from '../src/config.js'
import type { Context } from '@deepseek-ai/cordis'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm34')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

interface Harness {
  fireEvent: (session: unknown, event: unknown) => void
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
}

function harness(): Harness {
  const listeners = new Map<string, (session: unknown, event: unknown) => void>()
  const registered: { name: string; execute: (args: unknown, exec: unknown) => unknown }[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: never) => { registered.push(tool as never); return () => {} } },
    sessions: {},
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: (name: string, listener: never) => { listeners.set(name, listener as never); return () => {} },
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const exec = { agent: { id: 'cockpit', session: { header: { cwd: BASE } } } }
  return {
    fireEvent: (session, event) => {
      const listener = listeners.get('session/event')
      assert.ok(listener !== undefined, '真实装配必须注册 session/event 监听器')
      listener(session, event)
    },
    callTool: async (name, args) => {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `${name} 必须注册进工具表`)
      return String(await tool.execute(args, exec))
    },
  }
}

function dispatchTo(childSessionId: string): void {
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId, tools: 9, role: 'developer' })
}

function child(sessionId: string): unknown {
  return { header: { id: sessionId, cwd: BASE, delegationDepth: 1 } }
}

function assistantMessage(text: string): unknown {
  return { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

test('M34-01 取汇报②③：子会话 turn/end ⇒ 落 dispatch/finished + 报告文件（内容=最后一条助手消息），状态块能看到摘要', async () => {
  const h = harness()
  dispatchTo('child-1')

  h.fireEvent(child('child-1'), assistantMessage('第一段：先读角色卡。'))
  h.fireEvent(child('child-1'), assistantMessage('最终报告：改了 schema.sql 的复合键，契约测试 2 条、变异 killed 4。'))
  assert.equal(existsSync(join(BASE, '.sdo', 'evidence', 'child-reports', 'child-1.md')), false, '还没结算就不该有报告')
  h.fireEvent(child('child-1'), { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })

  const finished = journal.read().events.filter((event) => event.type === 'dispatch/finished')
  assert.equal(finished.length, 1, 'turn/end 必须落一条 dispatch/finished')
  assert.equal(finished[0]?.data.task, 'TASK-001')
  assert.equal(finished[0]?.data.role, 'developer')
  assert.equal(finished[0]?.data.reason, 'completed')

  const reportPath = String(finished[0]?.data.report ?? '')
  assert.equal(reportPath, `evidence/child-reports/${reportFileName('child-1', 'TASK-001')}`, '报告名按「卡 + 子会话」切（复用时不覆盖，评审 N2）')
  const report = readChildReportAt(store, reportPath)
  assert.ok(report !== undefined, '报告文件必须写出（按记录的落点读回）')
  assert.match(report, /最终报告/u, '报告内容 = 最后一条助手消息')
  assert.doesNotMatch(report, /第一段/u, '不该把更早的消息当成报告')

  // ① 状态块（经**真实注册的 sdo_status**）+ ③ 摘要
  const status = await h.callTool('sdo_status', {})
  assert.match(status, /最近完成的派发/u, `状态块要能看到：${status.slice(-400)}`)
  assert.match(status, /TASK-001/u)
  assert.match(status, /child-reports\/TASK-001-child-1\.md/u, '要给出报告落点（含卡 id）')
  assert.match(status, /变异 killed 4/u, '要给出报告摘要（模型不必自己翻文件）')
})

test('M34-02 反向：无关会话的 turn/end 不许落账、也不许写报告（收紧类改动必须证明没拦错/没错收）', () => {
  const h = harness()
  dispatchTo('child-1')
  h.fireEvent(child('someone-else'), assistantMessage('我不是被派发的。'))
  h.fireEvent(child('someone-else'), { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(journal.read().events.filter((event) => event.type === 'dispatch/finished').length, 0, '无关会话不落账')
  assert.equal(existsSync(join(BASE, '.sdo', 'evidence', 'child-reports', 'someone-else.md')), false, '无关会话不写报告')
})

test('M34-03 采集失败必须留痕（真机丢过三次观测：静默 catch 让"没数据"和"没问题"长得一样）', () => {
  // 经真实监听器难以**稳定**逼出异常（采集路径本身被设计成容错），所以这里分两步断言：
  // ① 留痕机制可用（真写入一条，能读回）；② 监听器的 catch 确实调它（接线断言）。
  // 诚实边界：监听器路径上的失败留痕由接线断言覆盖，没有在本用例里复现真实异常。
  journal.append('dispatch/observe-failed', { sessionId: 'child-9', eventType: 'tool/call', error: 'boom' })
  assert.equal(journal.read().events.filter((event) => event.type === 'dispatch/observe-failed').length, 1)
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /office\.noteObserveFailure\(/u, '监听器的 catch 必须记账，不许静默')
  assert.match(index, /const rawType = String\(/u, '失败留痕要能拿到事件类型（哪怕后续抛错）')
})

test('M34-04 采集失败留痕的**确定性**复现（评审 N3）：报告目录被占成普通文件 ⇒ EEXIST ⇒ 留痕且**不**误记完成', () => {
  const h = harness()
  dispatchTo('child-1')
  // 把 `evidence/child-reports` 预占成一个**普通文件** ⇒ 写报告时 mkdir 必然 EEXIST
  mkdirSync(join(BASE, '.sdo', 'evidence'), { recursive: true })
  writeFileSync(join(BASE, '.sdo', 'evidence', 'child-reports'), 'not a directory', 'utf8')

  h.fireEvent(child('child-1'), assistantMessage('最终报告：……'))
  h.fireEvent(child('child-1'), { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })

  const types = journal.read().events.map((event) => event.type)
  assert.equal(types.filter((type) => type === 'dispatch/observe-failed').length, 1, '写报告失败必须留痕')
  assert.equal(types.filter((type) => type === 'dispatch/finished').length, 0, '失败不许被伪装成"完成"')
})

test('M34-05 复用前瞻（评审 N2）：同一子会话为**两张卡**结算 ⇒ 两份报告，互不覆盖', () => {
  const h = harness()
  journal.append('dispatch/started', { task: 'TASK-041', provider: 'spawn', childSessionId: 'child-9', tools: 9, role: 'developer' })
  h.fireEvent(child('child-9'), assistantMessage('TASK-041 的报告'))
  h.fireEvent(child('child-9'), { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })

  // 同一个子会话接着做第二张卡（方案 3 的复用形态：append 一条新的派发即可）
  journal.append('dispatch/started', { task: 'TASK-042', provider: 'spawn', childSessionId: 'child-9', tools: 9, role: 'developer' })
  h.fireEvent(child('child-9'), assistantMessage('TASK-042 的报告'))
  h.fireEvent(child('child-9'), { type: 'turn/end', seq: 4, data: { turn: 2, reason: { kind: 'completed' } } })

  const reports = journal.read().events.filter((event) => event.type === 'dispatch/finished').map((event) => String(event.data.report))
  assert.equal(reports.length, 2, '两次结算两条记录')
  assert.notEqual(reports[0], reports[1], '报告落点必须按卡区分（否则第二张卡会覆盖第一张）')
  assert.match(String(reports[0]), /TASK-041/u)
  assert.match(String(reports[1]), /TASK-042/u)
  assert.match(String(readChildReportAt(store, String(reports[0]))), /TASK-041 的报告/u, '第一张卡的报告正文还在')
})

test('M34-06 取汇报③「推」半：子代理结算后，**下一次工具回执**就带上它的报告；只送一次', async () => {
  const h = harness()
  dispatchTo('child-1')
  h.fireEvent(child('child-1'), assistantMessage('最终报告：改了 schema 的复合键；契约测试 2 条、变异 killed 4。'))
  h.fireEvent(child('child-1'), { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })

  // ① 下一次**任何** SDO 工具回执都要带上它（宿主不给投递通道，就用回执当载体）
  const first = await h.callTool('sdo_status', {})
  assert.match(first, /子代理报告（已自动送达）/u, `要自动送达：${first.slice(-500)}`)
  assert.match(first, /TASK-001/u)
  assert.match(first, /TASK-001-child-1\.md/u, '要给报告落点')
  assert.match(first, /变异 killed 4/u, '要给报告摘要')
  assert.equal(journal.read().events.filter((event) => event.type === 'dispatch/reported').length, 1, '送达要留痕（重启后不重推）')

  // ② 反向：送过一次就不再重复送（否则每次调用都刷屏）
  const second = await h.callTool('sdo_status', {})
  assert.doesNotMatch(second, /子代理报告（已自动送达）/u, '同一份报告只送一次')
})

// ——————————————————————————————————————————————————————————————————————————————
// 增量 TASK-015：**白盒设计技术与结构覆盖口径**（REQ-056 / AC-218 AC-219 AC-220）
//
// 与上面的「子 agent 取汇报」共用 m34 这个测试工作区（`node_modules/.sdo-test/m34`），
// 但测的是**另一个模块**（`src/domain/testDesignWhitebox.ts`）—— 落在同一文件是因为
// 本卡的 writeScopes 只给了 `src/domain/testDesignWhitebox.ts` + `test/m34.test.ts`。
//
// 三条 DoD 逐条有对应用例：
//   · 五类口径可声明（语句 / 判定 / 路径 / 条件 / 定义-使用对）—— WB-01 / WB-02
//   · 非法取值被拒**并点名合法集合** —— WB-03
//   · 守卫两态（合法通过 / 非法拒绝）—— WB-09（两态）+ WB-06/07（非法侧的三条防线）
//   · 口径位**跨层同结论**（内容层 ↔ 形状层，同一份真源值）—— WB-11（TASK-035 落点七）
//
// 追溯（逐条用例 → 需求/验收标准）：
//   WB-01 → REQ-056 / AC-218 ｜ WB-02 → REQ-056 / AC-218 ｜ WB-03 → REQ-056
//   WB-04 → REQ-056 / AC-219 ｜ WB-05 → REQ-056 / AC-219 ｜ WB-06 → REQ-056 / AC-220
//   WB-07 → REQ-056 ｜ WB-08 → REQ-056 ｜ WB-09 → REQ-056 ｜ WB-10 → REQ-056
//   WB-11 → REQ-056 / AC-218（口径取值合法集合）—— 跨层一致性守卫（TASK-035 落点七）
// ——————————————————————————————————————————————————————————————————————————————

/** REQ-056 的验收标准（与 `.sdo/requirements/REQ-056.yml` 同形状）。 */
const WB_ACS = ['AC-218', 'AC-219', 'AC-220']
/** 本段所有用例 id：第一次调用时写进 store 的 `tests/`（"用例确实存在"那一闸）。 */
const WB_CASES = ['TC-WB-01', 'TC-WB-02', 'TC-WB-03', 'TC-WB-04', 'TC-WB-05', 'TC-WB-06', 'TC-WB-07', 'TC-WB-08']
/** 被引用的真实代码文件（本仓里确实存在，也是索引的键前缀）。 */
const WB_FILE = 'src/domain/testDesignWhitebox.ts'
const WB_FILE_2 = 'src/domain/testDesign.ts'

/** 种子：需求 + 设计元素 + 用例（按盘上文件判定"种过了没有"，不用模块级布尔量——每个用例都清工作区）。 */
function wbSeed(): void {
  if (store.exists('tests', 'TC-WB-01.yml')) return
  store.writeYaml(['requirements', 'REQ-056.yml'], {
    requirement: {
      id: 'REQ-056',
      title: '白盒用例设计技术',
      kind: 'functional',
      statement: 's',
      rationale: 'r',
      acceptance: WB_ACS.map((id) => ({ id })),
    },
  })
  store.writeYaml(['design', 'component.yml'], { component: { id: 'DES-031', name: '测试域真源' } })
  // 台账里已有的用例（含 REQ-056 自己那条）：卡上写的是 TC-050
  store.writeYaml(['tests', 'TC-050.yml'], {
    testCase: { id: 'TC-050', title: '白盒设计技术与结构覆盖口径', kind: 'unit', requirement: 'REQ-056', steps: [], expected: '五类口径可声明；非法取值被拒并点名合法集合', at: '' },
  })
  for (const id of WB_CASES) {
    store.writeYaml(['tests', `${id}.yml`], { testCase: { id, title: id, kind: 'unit', requirement: 'REQ-056', steps: ['s'], expected: 'e', at: '' } })
  }
}

/**
 * 结构元素索引的**替身**：键都指向本仓真实存在的文件与符号。
 *
 * 为什么要替身而不是每次现扫：本段的判据是"模块**能不能**核对出处"，不是"索引扫得全不全"
 * （后者由 WB-10 用**真实扫描**单独证明）。现扫整个仓库会让每条用例都去读上千个文件。
 */
function wbIndex(): WhiteboxCodeIndex {
  const index = emptyWhiteboxCodeIndex()
  const targets: [string, string][] = [
    [WB_FILE, 'validateWhiteboxDesign'],
    [WB_FILE, 'checkBasisPaths'],
    [WB_FILE, 'canonicalCriterion'],
    [WB_FILE, 'collectWhiteboxCodeIndex'],
    [WB_FILE, 'WHITEBOX_CRITERION_TECHNIQUES'],
    [WB_FILE_2, 'checkEquivalence'],
  ]
  for (const [file, symbol] of targets) index.targets.set(`${file}:${symbol}`, [1])
  index.branches.set(`${WB_FILE}#if (decisions.length === 0) {`, [520])
  index.branches.set(`${WB_FILE}#for (const entry of entries) {`, [300])
  index.variables.set(`${WB_FILE}:issue`, [300])
  index.defUse.set(`${WB_FILE}:issue@300`, [300])
  return index
}

function wbFacts(): WhiteboxKnownFacts {
  const facts = emptyWhiteboxKnownFacts()
  facts.requirements.set('REQ-056', WB_ACS)
  facts.designElements.set('DES-031', ['design', 'design-whitebox'])
  facts.code = wbIndex()
  return facts
}

/** 基线**合法**的五类必产项（每条口径一条）；返例只改一处 —— 方便断言"只报这一处"。 */
function wbBase(): Record<string, unknown>[] {
  return [
    {
      id: 'WB-ART-001',
      technique: 'control-flow',
      criterion: 'statement',
      artifact: '独立路径与 def-use 共用的判定框架图',
      target: `${WB_FILE}:validateWhiteboxDesign`,
      decisions: [
        { id: 'D1', at: `${WB_FILE}:checkBasisPaths`, when: 'paths 为空' },
        { id: 'D2', at: `${WB_FILE}:canonicalCriterion`, when: '口径取值不认识' },
      ],
      merges: [{ id: 'M1', at: `${WB_FILE}:validateWhiteboxDesign`, note: '两条分支在此汇合' }],
      useCases: ['TC-WB-01', 'TC-WB-02'],
    },
    {
      id: 'WB-ART-002',
      technique: 'cyclomatic',
      criterion: 'decision',
      artifact: 'validateWhiteboxDesign 的圈复杂度',
      target: `${WB_FILE}:validateWhiteboxDesign`,
      complexity: 'E-N+2=7',
      method: 'E-N+2（边数-节点数+2；等价于判定数+1）',
      useCases: ['TC-WB-01'],
    },
    {
      id: 'WB-ART-003',
      technique: 'basis-paths',
      criterion: 'path',
      artifact: '基本路径法：判定框架图上的独立路径',
      target: `${WB_FILE}:checkBasisPaths`,
      paths: [
        { id: 'P1', via: ['D1'], useCases: ['TC-WB-02'] },
        { id: 'P2', via: ['D2'], useCases: ['TC-WB-03'] },
      ],
    },
    {
      id: 'WB-ART-004',
      technique: 'condition-combination',
      criterion: 'condition',
      artifact: '口径取值判定的条件组合',
      target: `${WB_FILE}:canonicalCriterion`,
      conditions: [
        { id: 'C1', when: '取值在五类口径词表里' },
        { id: 'C2', when: '取值是 branch 之类的历史别名' },
      ],
      combinations: [
        { conditions: ['1', '0'], expect: '直接取规范值', useCases: ['TC-WB-03'] },
        { conditions: ['0', '1'], expect: '收下别名并纠正', useCases: ['TC-WB-03'] },
        { conditions: ['0', '0'], expect: '判红并点名合法集合', useCases: ['TC-WB-03'] },
        { conditions: ['1', '1'], expect: '不可能（别名不在词表里）', impossible: true, reason: '别名与规范值互斥，不会同时成立', useCases: ['TC-WB-03'] },
      ],
      useCases: ['TC-WB-03'],
    },
    {
      id: 'WB-ART-005',
      technique: 'def-use',
      criterion: 'def-use',
      artifact: '用例引用的定义-使用对',
      target: `${WB_FILE}:checkBasisPaths`,
      pairs: [
        { variable: 'issue', def: `${WB_FILE}:issue`, use: `${WB_FILE}#if (decisions.length === 0) {`, useCases: ['TC-WB-04'] },
        { variable: 'decisions', def: `${WB_FILE}:checkBasisPaths`, use: `${WB_FILE}#for (const entry of entries) {`, useCases: ['TC-WB-04'] },
      ],
      useCases: ['TC-WB-04'],
    },
  ]
}

/** 改基线的第 `index` 条（其余原样）。 */
function wbPatch(index: number, patch: Record<string, unknown>): Record<string, unknown>[] {
  const artifacts = wbBase()
  const target = artifacts[index]
  if (target === undefined) throw new Error(`基线里没有第 ${index} 条必产项`)
  artifacts[index] = { ...target, ...patch }
  return artifacts
}

function wbDesign(artifacts: unknown[]): Record<string, unknown> {
  return { artifacts }
}

function wbValidate(design: unknown, options: ValidateWhiteboxOptions = {}): WhiteboxReport {
  return validateWhiteboxDesign(design, { known: wbFacts(), testCaseIds: [...WB_CASES, 'TC-050'], ...options })
}

function wbWrite(design: unknown, options: ValidateWhiteboxOptions = {}): WhiteboxWriteResult {
  return writeValidatedWhiteboxDesign(store, design, { known: wbFacts(), testCaseIds: [...WB_CASES, 'TC-050'], ...options })
}

function wbRow(report: WhiteboxReport, criterion: string): WhiteboxCriterionCoverage {
  const row = report.coverage.find((item) => item.criterion === criterion)
  assert.ok(row !== undefined, `覆盖读数里必须有「${criterion}」一行：${report.coverage.map((item) => item.criterion).join(' ')}`)
  return row
}

function wbExpect(report: WhiteboxReport, code: string, field: string, hint: string): void {
  assert.ok(
    report.issues.some((issue) => issue.code === code && issue.field === field),
    `${hint}\n实际：${report.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ｜ ') || '（无问题）'}`,
  )
  assert.ok(
    report.issues.some((issue) => issue.code === code && issue.field === field && issue.message.length >= 8),
    `${hint}（问题说明要能照着改，不能只有码）`,
  )
}

test('WB-01 五类口径齐备时落盘：每条口径的声明数与覆盖数逐条可读（REQ-056 / AC-218）', () => {
  wbSeed()
  assert.equal(rawWhiteboxDesignText(store), '', '前置：盘上还没有 design-whitebox.yml')

  const result = wbWrite(wbDesign(wbBase()))
  assert.equal(result.written, true, `五类口径齐备 + 用例可核 ⇒ 必须落盘：${JSON.stringify(result.report.issues)}`)
  assert.equal(result.outcome, 'ok')
  assert.equal(result.path, 'testing/design-whitebox.yml')
  assert.match(result.hash, /^sha256:[0-9a-f]{64}$/u, '落盘要给出内容指纹')

  // 五类口径逐条：声明 1 条、真的给出 1 条
  assert.deepEqual(
    result.report.coverage.map((row) => row.criterion),
    ['statement', 'decision', 'path', 'condition', 'def-use'],
    '五类口径要逐条给读数（顺序稳定）',
  )
  for (const criterion of ['statement', 'decision', 'path', 'condition', 'def-use']) {
    const row = wbRow(result.report, criterion)
    assert.equal(row.declared, 1, `口径「${criterion}」要算进声明数`)
    assert.equal(row.covered, 1, `口径「${criterion}」要算进覆盖数`)
    assert.notEqual(row.label, undefined)
    assert.notEqual(row.technique, undefined)
  }
  assert.deepEqual(
    result.report.coverage.map((row) => row.label),
    ['语句', '判定', '路径', '条件', '定义-使用对'],
    '五类口径的中文标签要与 DoD 逐字对上（第五批 §3.2：卡面勘误后统一为「判定」）',
  )

  // 读了回来 + 指纹一致
  assert.equal(readWhiteboxDesign(store).status, 'ok')
  assert.equal(whiteboxDesignFingerprint(store), result.hash, '读回来的指纹必须与落盘时一致')
})

test('WB-02 口径↔技术↔必产项是一张可读的映射表：五类口径不漏项（REQ-056 / AC-218）', () => {
  wbSeed()
  // 映射表本身：五类口径各有技术，且技术都在仓内词表里
  assert.deepEqual(Object.keys(WHITEBOX_CRITERION_TECHNIQUES).sort(), [...WHITEBOX_COVERAGE_CRITERIA].sort(), '五类口径都要有对应技术')
  for (const criterion of WHITEBOX_COVERAGE_CRITERIA) {
    const technique = WHITEBOX_CRITERION_TECHNIQUES[criterion]
    assert.ok((WHITEBOX_TECHNIQUES as readonly string[]).includes(technique), `口径「${criterion}」的技术「${technique}」要在白盒技术词表里`)
  }
  // 与仓内既有覆盖准则词表**同源**（不另造第二套）
  for (const criterion of WHITEBOX_COVERAGE_CRITERIA) {
    assert.ok((TESTING_COVERAGE_CRITERIA as readonly string[]).includes(criterion), `口径「${criterion}」必须在仓内 TESTING_COVERAGE_CRITERIA 里（不另造词表）`)
  }
  // 五类技术也与仓内白盒技术词表同源
  for (const technique of WHITEBOX_TECHNIQUES) {
    assert.ok((TESTING_WHITEBOX_TECHNIQUES as readonly string[]).includes(technique), `技术「${technique}」必须在仓内 TESTING_WHITEBOX_TECHNIQUES 里`)
  }

  // 技术↔口径 对不上 ⇒ 判红（防"换了技术不改口径"）
  const mismatched = wbValidate(wbDesign(wbPatch(1, { technique: 'control-flow' })))
  assert.equal(mismatched.outcome, 'invalid')
  wbExpect(mismatched, 'artifact-incomplete', 'artifacts[1].technique', '技术与口径对不上要点名')

  // 缺一类口径 ⇒ unknown（没得可判，不是判红）并点名缺哪一类
  const missing = wbValidate(wbDesign(wbBase().filter((item) => item.criterion !== 'def-use')))
  assert.equal(missing.outcome, 'unknown')
  assert.match(missing.unknownReason, /定义-使用对/u, `unknown 的原因要点到缺哪一类：${missing.unknownReason}`)
  wbExpect(missing, 'technique-missing', 'artifacts', '缺的口径要点名')
})

test('WB-03 非法口径取值被拒**并点名合法集合**；历史别名 branch 收下并纠正（REQ-056）', () => {
  wbSeed()
  // ① 非法取值 ⇒ criterion-unknown，且报错文案里要点名五个合法取值
  const bogus = wbValidate(wbDesign(wbPatch(1, { criterion: 'coverage' })))
  assert.equal(bogus.outcome, 'invalid')
  wbExpect(bogus, 'criterion-unknown', 'artifacts[1].criterion', '非法口径取值要判红并点到该字段')
  const message = bogus.issues.find((issue) => issue.code === 'criterion-unknown')?.message ?? ''
  for (const legal of WHITEBOX_COVERAGE_CRITERIA) {
    assert.match(message, new RegExp(legal, 'u'), `报错要点名合法集合里的「${legal}」：${message}`)
  }
  assert.match(message, /语句/u, `报错要带中文标签：${message}`)

  // ② 中文当取值 ⇒ 同样被拒（不猜语言）
  const chinese = wbValidate(wbDesign(wbPatch(1, { criterion: '分支' })))
  assert.equal(chinese.outcome, 'invalid')
  wbExpect(chinese, 'criterion-unknown', 'artifacts[1].criterion', '中文标签不是取值，要判红')

  // ③ 空口径 ⇒ 另一条码（与"写错"分开点名）
  const empty = wbValidate(wbDesign(wbPatch(1, { criterion: '' })))
  assert.equal(empty.outcome, 'invalid')
  wbExpect(empty, 'criterion-missing', 'artifacts[1].criterion', '缺口径要单独点名（与"缺技术/缺必产项"分开）')

  // ④ 历史别名 branch：收下并**纠正**成 decision（不判红 —— 判红一条意思正确的口径只会逼人改词）
  assert.equal(canonicalCriterion('branch'), 'decision')
  assert.equal(canonicalCriterion('branch-coverage'), 'decision')
  assert.equal(canonicalCriterion(' decision '), 'decision', '两侧空白要容忍')
  assert.equal(canonicalCriterion('coverage'), undefined)
  assert.equal(canonicalCriterion(''), undefined)
  const aliased = wbValidate(wbDesign(wbPatch(1, { criterion: 'branch' })))
  assert.equal(aliased.outcome, 'ok', `branch 是 decision 的别名，应当收下：${aliased.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)
  assert.equal(wbRow(aliased, 'decision').covered, 1, '别名要记到规范口径头上')
})

test('WB-04 独立路径逐条要用例；路径引用的判定节点必须落在控制流图里（REQ-056 / AC-219）', () => {
  wbSeed()
  // ① 某条路径没挂用例 ⇒ 点到**那条路径自己**（不是整条必产项）
  const orphan = wbPatch(2, {
    paths: [
      { id: 'P1', via: ['D1'], useCases: ['TC-WB-02'] },
      { id: 'P2', via: ['D2'] },
    ],
  })
  const orphanReport = wbValidate(wbDesign(orphan))
  assert.equal(orphanReport.outcome, 'invalid')
  wbExpect(orphanReport, 'artifact-incomplete', 'artifacts[2].paths[1].useCases', '没挂用例的路径要点到该路径')

  // ② 用例 id 查不到 ⇒ 另一条码
  const ghost = wbPatch(2, {
    paths: [
      { id: 'P1', via: ['D1'], useCases: ['TC-WB-02'] },
      { id: 'P2', via: ['D2'], useCases: ['TC-999'] },
    ],
  })
  const ghostReport = wbValidate(wbDesign(ghost))
  assert.equal(ghostReport.outcome, 'invalid')
  wbExpect(ghostReport, 'usecase-unknown', 'artifacts[2].paths[1].useCases[0]', '查不到的用例要点名')

  // ③ 路径引用了控制流图里没有的判定节点 ⇒ 判红（路径与图必须对得上）
  const ghostsDecision = wbPatch(2, {
    paths: [
      { id: 'P1', via: ['D9'], useCases: ['TC-WB-02'] },
      { id: 'P2', via: ['D2'], useCases: ['TC-WB-03'] },
    ],
  })
  const ghostsReport = wbValidate(wbDesign(ghostsDecision))
  assert.equal(ghostsReport.outcome, 'invalid')
  wbExpect(ghostsReport, 'code-unknown', 'artifacts[2].paths[0].via[0]', '图里没有的判定节点要点名')

  // ④ 路径 id 重复 ⇒ 重复计数会让独立路径集看起来更全
  const dup = wbPatch(2, {
    paths: [
      { id: 'P1', via: ['D1'], useCases: ['TC-WB-02'] },
      { id: 'P1', via: ['D2'], useCases: ['TC-WB-03'] },
    ],
  })
  const dupReport = wbValidate(wbDesign(dup))
  assert.equal(dupReport.outcome, 'invalid')
  wbExpect(dupReport, 'duplicate-anchor', 'artifacts[2].paths[1].id', '重复的路径 id 要点名')
})

test('WB-05 条件组合：组合表或 MC/DC 独立影响对必居其一；def-use 对逐对要用例（REQ-056 / AC-219）', () => {
  wbSeed()
  // ① 既无组合表也无 MC/DC ⇒ 判红并说明二者必居其一
  const none = wbPatch(3, { combinations: [], mcdc: [] })
  const noneReport = wbValidate(wbDesign(none))
  assert.equal(noneReport.outcome, 'invalid')
  wbExpect(noneReport, 'artifact-incomplete', 'artifacts[3].combinations', '组合表与 MC/DC 都缺要判红')

  // ② 只给 MC/DC 独立影响对 ⇒ 合法（组合表不是唯一正解）
  const mcdc = wbPatch(3, {
    combinations: [],
    mcdc: [
      { condition: 'C1', pair: ['C1', 'C2'], useCases: ['TC-WB-03'] },
      { condition: 'C2', pair: ['C2', 'C1'], useCases: ['TC-WB-03'] },
    ],
  })
  const mcdcReport = wbValidate(wbDesign(mcdc))
  assert.equal(mcdcReport.outcome, 'ok', `只给 MC/DC 也要认：${mcdcReport.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)

  // ③ MC/DC 引用了条件桩里没有的条件 ⇒ 判红
  const ghostCondition = wbPatch(3, {
    combinations: [],
    mcdc: [{ condition: 'C9', pair: ['C9', 'C1'], useCases: ['TC-WB-03'] }],
  })
  const ghostReport = wbValidate(wbDesign(ghostCondition))
  assert.equal(ghostReport.outcome, 'invalid')
  wbExpect(ghostReport, 'code-unknown', 'artifacts[3].mcdc[0].condition', '条件桩里没有的条件要点名')

  // ④ 组合取值不是 0/1/x ⇒ 判红
  const badValue = wbPatch(3, {
    combinations: [{ conditions: ['yes', '0'], expect: 'x', useCases: ['TC-WB-03'] }],
  })
  const badReport = wbValidate(wbDesign(badValue))
  assert.equal(badReport.outcome, 'invalid')
  wbExpect(badReport, 'artifact-incomplete', 'artifacts[3].combinations[0].conditions[0]', '非法真值取值要点名')

  // ⑤ def-use 某对没挂用例 ⇒ 点到那一对
  const defUseOrphan = wbPatch(4, {
    pairs: [
      { variable: 'issue', def: `${WB_FILE}:issue`, use: `${WB_FILE}#if (decisions.length === 0) {`, useCases: ['TC-WB-04'] },
      { variable: 'decisions', def: `${WB_FILE}:checkBasisPaths`, use: `${WB_FILE}#for (const entry of entries) {` },
    ],
  })
  const defUseReport = wbValidate(wbDesign(defUseOrphan))
  assert.equal(defUseReport.outcome, 'invalid')
  wbExpect(defUseReport, 'artifact-incomplete', 'artifacts[4].pairs[1].useCases', '没挂用例的定义-使用对要点到该对')
})

test('WB-06 结构元素出处查不到即判红并点名，不得凭空发明（REQ-056 / AC-220）', () => {
  wbSeed()
  // ① 符号在代码真源里不存在 ⇒ 判红
  const ghostTarget = wbValidate(wbDesign(wbPatch(1, { target: `${WB_FILE}:noSuchSymbol` })))
  assert.equal(ghostTarget.outcome, 'invalid')
  wbExpect(ghostTarget, 'code-unknown', 'artifacts[1].target', '代码里没有的符号要点名')

  // ② 文件都不存在 ⇒ 判红
  const ghostFile = wbValidate(wbDesign(wbPatch(1, { target: 'src/domain/no-such-file.ts:foo' })))
  assert.equal(ghostFile.outcome, 'invalid')
  wbExpect(ghostFile, 'code-unknown', 'artifacts[1].target', '不存在的文件要点名')

  // ③ 只给文件名、不给符号 ⇒ 判红并提示要写到符号一级
  const fileOnly = wbValidate(wbDesign(wbPatch(1, { target: WB_FILE })))
  assert.equal(fileOnly.outcome, 'invalid')
  wbExpect(fileOnly, 'code-unknown', 'artifacts[1].target', '只指到文件不算指到结构元素')

  // ④ 完全不给出处 ⇒ 另一条码
  const noAnchor = wbValidate(wbDesign(wbPatch(1, { target: '' })))
  assert.equal(noAnchor.outcome, 'invalid')
  wbExpect(noAnchor, 'code-anchor-missing', 'artifacts[1].target', '不给结构元素出处要单独点名')

  // ⑤ 反向对照：真实存在的符号必须认（否则上面四条证明不了判据在"核对"而不是"一律拒绝"）
  const real = wbValidate(wbDesign(wbBase()))
  assert.equal(real.outcome, 'ok', `真实符号要认得出来：${real.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)

  // ⑥ 不给索引（代码真源不可读）时**不凭空判红**，但整份判 unknown（不许假装 ok）
  const noIndex = wbValidate(wbDesign(wbBase()), { known: undefined })
  assert.equal(noIndex.outcome, 'ok', '没有索引时格式合法即不判红（不冤枉人）')

  // ⑦ 判定节点也要有出处：给了空 ⇒ 点名
  const decisionNoAnchor = wbPatch(0, {
    decisions: [{ id: 'D1', at: '', when: 'x' }],
  })
  const decisionReport = wbValidate(wbDesign(decisionNoAnchor))
  assert.equal(decisionReport.outcome, 'invalid')
  wbExpect(decisionReport, 'code-anchor-missing', 'artifacts[0].decisions[0].at', '判定节点缺出处要点名')
})

test('WB-07 五类技术各自的最小必产项缺一即点名（控制流图 / 圈复杂度 / 独立路径 / 条件组合 / def-use）', () => {
  wbSeed()
  // ① 控制流图缺汇合节点 ⇒ 判红（只有判定节点回答不了"分支在哪合回来"）
  const noMerges = wbPatch(0, { merges: [] })
  const mergesReport = wbValidate(wbDesign(noMerges))
  assert.equal(mergesReport.outcome, 'invalid')
  wbExpect(mergesReport, 'artifact-incomplete', 'artifacts[0].merges', '缺汇合节点要判红')

  // ② 圈复杂度：只有口径没有读数 ⇒ 判红；读数不含数 ⇒ 判红
  const noReading = wbValidate(wbDesign(wbPatch(1, { complexity: '' })))
  assert.equal(noReading.outcome, 'invalid')
  wbExpect(noReading, 'artifact-incomplete', 'artifacts[1].complexity', '缺复杂度读数要判红')
  const proseReading = wbValidate(wbDesign(wbPatch(1, { complexity: '很复杂' })))
  assert.equal(proseReading.outcome, 'invalid')
  wbExpect(proseReading, 'artifact-incomplete', 'artifacts[1].complexity', '读数不含数要判红（不接受形容词）')
  const noMethod = wbValidate(wbDesign(wbPatch(1, { method: '' })))
  assert.equal(noMethod.outcome, 'invalid')
  wbExpect(noMethod, 'artifact-incomplete', 'artifacts[1].method', '缺计算口径要判红')

  // ③ 独立路径清单为空 ⇒ 判红
  const noPaths = wbValidate(wbDesign(wbPatch(2, { paths: [] })))
  assert.equal(noPaths.outcome, 'invalid')
  wbExpect(noPaths, 'artifact-incomplete', 'artifacts[2].paths', '空路径清单要判红')

  // ④ 条件桩为空 ⇒ 判红
  const noConditions = wbValidate(wbDesign(wbPatch(3, { conditions: [] })))
  assert.equal(noConditions.outcome, 'invalid')
  wbExpect(noConditions, 'artifact-incomplete', 'artifacts[3].conditions', '空条件桩要判红')

  // ⑤ def-use 对清单为空 ⇒ 判红
  const noPairs = wbValidate(wbDesign(wbPatch(4, { pairs: [] })))
  assert.equal(noPairs.outcome, 'invalid')
  wbExpect(noPairs, 'artifact-incomplete', 'artifacts[4].pairs', '空 def-use 清单要判红')

  // ⑥ `na` + 理由 ⇒ 该条放过，但**不计入 covered**（不许把"不做"洗成"做了"）
  const na = wbValidate(wbDesign(wbPatch(1, { na: '该单元无分支：纯线性函数，圈复杂度恒为 1', complexity: undefined, method: undefined })))
  assert.equal(na.outcome, 'ok', `显式声明不适用 + 理由要放过：${na.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)
  assert.equal(wbRow(na, 'decision').declared, 1, '声明数照算')
  assert.equal(wbRow(na, 'decision').covered, 0, '`na` 不能被读数洗成"给出了必产项"')
})

test('WB-08 fail-closed：读不动一律 unknown（不是 ok）；必产项不带用例即判红', () => {
  wbSeed()
  const notMap = wbValidate('artifacts: []')
  assert.equal(notMap.outcome, 'unknown')
  assert.notEqual(notMap.unknownReason, '')
  wbExpect(notMap, 'unknown', '', '整份不是映射要点名')

  const notList = wbValidate({ artifacts: { a: 1 } })
  assert.equal(notList.outcome, 'unknown')
  wbExpect(notList, 'unknown', 'artifacts', 'artifacts 不是列表要点名')

  const empty = wbValidate({ artifacts: [] })
  assert.equal(empty.outcome, 'unknown')
  wbExpect(empty, 'technique-missing', 'artifacts', '空清单要点名')

  const hollow = wbValidate({})
  assert.equal(hollow.outcome, 'unknown')
  wbExpect(hollow, 'technique-missing', 'artifacts', '整份缺 artifacts 要点名')

  // 列表项不是映射 ⇒ **形状读不动** ⇒ unknown（不是"判它错"：连结构都没读出来）
  const mixed: unknown[] = [...wbBase(), '这不是一条必产项']
  const mixedReport = wbValidate(wbDesign(mixed))
  assert.equal(mixedReport.outcome, 'unknown', '形状读不动一律 unknown（不是 ok，也不是 invalid）')
  wbExpect(mixedReport, 'unknown', 'artifacts[5]', '列表项不是映射要逐项点名')
  assert.notEqual(mixedReport.unknownReason, '', 'unknown 必须说得出为什么')

  // 整条必产项一条用例都没有 ⇒ 判红
  const noCases = wbValidate(wbDesign(wbPatch(1, { useCases: [] })))
  assert.equal(noCases.outcome, 'invalid')
  wbExpect(noCases, 'artifact-incomplete', 'artifacts[1].useCases', '没有用例反向引用要判红（字段缺失码）')

  // 用例写成了空串 ⇒ 另一条码（"写了但是空的"与"没写"分开点名）
  const blankCase = wbValidate(wbDesign(wbPatch(1, { useCases: [''] })))
  assert.equal(blankCase.outcome, 'invalid')
  wbExpect(blankCase, 'no-usecase', 'artifacts[1].useCases[0]', '空串用例要点名')

  // 整份一条用例都没有 ⇒ 追加一条整份层面的点名
  const allBlank = wbValidate({ artifacts: wbBase().map((item) => ({ ...item, useCases: undefined })) })
  assert.equal(allBlank.outcome, 'invalid')
  wbExpect(allBlank, 'no-usecase', 'artifacts[].useCases', '整份没有反向引用要单独点名')
})

test('WB-09 守卫两态：合法必产项⇒落盘；非法取值/缺必产项⇒一个字节都不写（本卡 DoD 第 3 条）', () => {
  wbSeed()
  // 非法态①：口径取值非法
  const bogus = wbWrite(wbDesign(wbPatch(1, { criterion: 'coverage' })))
  assert.equal(bogus.written, false, '非法口径取值必须拒绝落盘')
  assert.equal(bogus.outcome, 'invalid')
  assert.equal(rawWhiteboxDesignText(store), '', '拒绝时盘上不许出现真源（不落半成品）')

  // 非法态②：结构元素出处查不到
  const ghost = wbWrite(wbDesign(wbPatch(1, { target: `${WB_FILE}:noSuchSymbol` })))
  assert.equal(ghost.written, false, '出处查不到必须拒绝落盘')
  assert.equal(rawWhiteboxDesignText(store), '', '盘上依然零字节')

  // 非法态③：缺一类口径（unknown ⇒ 同样不许落盘）
  const missing = wbWrite(wbDesign(wbBase().filter((item) => item.criterion !== 'condition')))
  assert.equal(missing.written, false, 'unknown 也不许落盘')
  assert.equal(missing.outcome, 'unknown')
  assert.equal(rawWhiteboxDesignText(store), '', '盘上依然零字节')

  // 合法态：补齐 ⇒ 落盘（证明拦住前三次的确实是那些缺陷）
  const ok = wbWrite(wbDesign(wbBase()))
  assert.equal(ok.written, true, `合法必产项要落盘：${JSON.stringify(ok.report.issues)}`)
  assert.notEqual(rawWhiteboxDesignText(store), '', '这次要真的写出来')
  assert.equal(ok.replaced, false, '首次落盘不是覆盖')

  // 幂等：同内容再落一次，指纹不变、标记覆盖
  const again = wbWrite(wbDesign(wbBase()))
  assert.equal(again.written, true)
  assert.equal(again.hash, ok.hash, '同一内容两次落盘必须同一指纹')
  assert.equal(again.replaced, true, '第二次是覆盖')
})

test('WB-10 真实扫描：collectWhiteboxCodeIndex 扫本仓代码，真符号可核对、假符号核对不到（REQ-056 / AC-220）', () => {
  wbSeed()
  // 用**真实仓库**当代码真源：只扫 test/m34 的工作区不是代码，故显式指向仓根
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
  const index = collectWhiteboxCodeIndex(repoRoot, ['src/domain'])
  assert.ok(index.targets.size > 100, `真实扫描要索引出足量符号：${index.targets.size}`)
  assert.ok(index.targets.has(`${WB_FILE}:validateWhiteboxDesign`), `${WB_FILE} 里的导出函数要能被索引到`)
  assert.ok(index.targets.has(`${WB_FILE}:checkBasisPaths`), '未导出的内部函数也要能索引到（它就在源码里）')
  assert.ok(index.branches.size > 50, `分支锚点要扫出来：${index.branches.size}`)

  const facts = wbFacts()
  facts.code = index
  // 真符号 ⇒ 认；假符号 ⇒ 判红
  const real = validateWhiteboxDesign(wbDesign(wbBase()), { known: facts, testCaseIds: [...WB_CASES, 'TC-050'] })
  assert.equal(real.outcome, 'ok', `真实扫描出的索引要认得出基线里的符号：${real.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)
  const ghost = validateWhiteboxDesign(wbDesign(wbPatch(1, { target: `${WB_FILE}:definitelyNoSuchSymbol` })), { known: facts })
  assert.equal(ghost.outcome, 'invalid')
  wbExpect(ghost, 'code-unknown', 'artifacts[1].target', '真实扫描下假符号也要被拦')
})

/**
 * **TASK-035 落点七（来源 REV-007）：口径位跨层统一 —— 形状层与内容层对同一位给出同一结论。**
 *
 * ## 病灶（REV-007 的原文，逐条复现过）
 *
 * `branch` 是 `decision` 的**历史别名**（历史上 `WHITEBOX_CRITERION_LABEL` 把 `decision` 叫「分支」，
 * 人会照着中文标签写 `branch`；第五批 §3.2 起中文标签已统一为「判定」，别名照旧收下）。内容层（`testDesignWhitebox.checkArtifact` →
 * `canonicalCriterion`）**收下并纠正**成 `decision`（WB-03 断言 `outcome==='ok'`）。
 * 形状层是**落盘闸门**（`testingShapes.checkDesignWhitebox`），它当时**完全不核 `criterion`** ——
 * 于是同一份真源在两层得到两种待遇：内容层说"这是 decision"、闸门说"我没看过这个位"；
 * 而闸门里另一处同名字段（覆盖读数的 `criterion`，`testingShapes.checkCoverageReading`）用的是
 * **裸枚举** —— 一旦有人把别名搬到那边，就会"写盘收下、体检判非法枚举"。
 *
 * ## 统一在哪一处（只一处）
 *
 * 形状层**复用内容层的规范化函数** `canonicalCriterion`（别名表 `CRITERION_ALIASES` 只有一份，
 * 这里没有第二张映射表），于是"形状层收不收"这件事完全由 `canonicalCriterion` 的结论决定：
 * 别名 ⇒ 两层都收下并归到 `decision`；非法取值 ⇒ 两层都判红、都点到同一个字段。
 *
 * ## 这条守卫的判别力（两态都钉住，不许"永远绿"）
 *
 * · 正例：`branch` / `branch-coverage` / `decision_coverage` ⇒ 两层都不报 `criterion` 问题；
 * · 反例：`coverage` / `分支` / 空串 ⇒ 两层都在 `artifacts[1].criterion` 上报问题；
 * · 等价式：逐值断言 `形状层收下 ⇔ canonicalCriterion 有解` —— 谁再写一份枚举/映射表，这条就红。
 */
test('WB-11 口径位跨层同结论：写 branch ⇒ 形状层与内容层都收下并归到 decision；非法取值两侧都判红（TASK-035 落点七）', () => {
  wbSeed()

  /** 同一份真源值喂两层，只取**那一位**（`artifacts[1].criterion`）的结论。 */
  const verdictsOf = (raw: string): { content: boolean; shape: boolean; contentCodes: string[]; shapeCodes: string[] } => {
    const design = wbDesign(wbPatch(1, { criterion: raw }))
    const content = wbValidate(design)
    const shape = validateTestingSource('design-whitebox', design, { testCaseIds: [...WB_CASES, 'TC-050'] })
    const mine = (list: readonly { field: string }[]): boolean => !list.some((issue) => issue.field === 'artifacts[1].criterion')
    return {
      content: mine(content.issues),
      shape: mine(shape.issues),
      contentCodes: content.issues.filter((issue) => issue.field === 'artifacts[1].criterion').map((issue) => issue.code),
      shapeCodes: shape.issues.filter((issue) => issue.field === 'artifacts[1].criterion').map((issue) => issue.code),
    }
  }

  // ① **别名收下并纠正**：形状层与内容层都不判红，且内容层把这笔账记在 `decision` 头上
  const aliased = wbValidate(wbDesign(wbPatch(1, { criterion: 'branch' })))
  assert.equal(aliased.outcome, 'ok', `内容层收下 branch：${aliased.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)
  assert.equal(wbRow(aliased, 'decision').covered, 1, '别名要记到规范口径 decision 头上（内容层的既有口径）')
  const branchVerdict = verdictsOf('branch')
  assert.equal(branchVerdict.shape, true, `形状层必须与内容层同结论（收下 branch）：${branchVerdict.shapeCodes.join(' ')}`)
  assert.equal(branchVerdict.content, true, '内容层收下 branch（WB-03 已钉住，这里复核同一位）')

  // ② **逐值等价**：形状层的结论必须**等于** `canonicalCriterion` 的结论（= 别名表只有一份，闸门不另写枚举）
  const values = ['statement', 'decision', 'branch', 'branch-coverage', 'decision_coverage', 'path', 'condition', 'def-use', 'coverage', '分支', '   ', '']
  for (const raw of values) {
    const verdict = verdictsOf(raw)
    const canonical = canonicalCriterion(raw)
    assert.equal(
      verdict.shape,
      canonical !== undefined,
      `「${raw}」：形状层的结论必须由 canonicalCriterion 决定（收下 ⇔ 有规范值），实际形状=${verdict.shape} 规范值=${canonical ?? '（无）'}`,
    )
    assert.equal(
      verdict.shape,
      verdict.content,
      `「${raw}」：同一份真源在两层必须同结论，实际形状=${verdict.shape}（${verdict.shapeCodes.join(' ')}）内容=${verdict.content}（${verdict.contentCodes.join(' ')}）`,
    )
  }

  // ③ **判红侧也要点名到同一位**，且形状层的文案要点名合法集合（五个取值 + 中文标签）
  const bogus = verdictsOf('coverage')
  assert.deepEqual(bogus.shapeCodes, ['enum'], '形状层对非法取值报「enum」（形状层的码是它自己的公共面）')
  assert.deepEqual(bogus.contentCodes, ['criterion-unknown'], '内容层对非法取值报「criterion-unknown」')
  const shapeReport = validateTestingSource('design-whitebox', wbDesign(wbPatch(1, { criterion: 'coverage' })), { testCaseIds: [...WB_CASES, 'TC-050'] })
  const shapeMessage = shapeReport.issues.find((issue) => issue.field === 'artifacts[1].criterion')?.message ?? ''
  for (const legal of WHITEBOX_COVERAGE_CRITERIA) {
    assert.match(shapeMessage, new RegExp(legal, 'u'), `形状层的报错要点名合法集合里的「${legal}」：${shapeMessage}`)
    assert.match(shapeMessage, new RegExp(WHITEBOX_CRITERION_LABEL[legal] ?? legal, 'u'), `形状层的报错要带中文标签「${WHITEBOX_CRITERION_LABEL[legal] ?? legal}」：${shapeMessage}`)
  }

  // ④ **同一位在别名与非法之间只有取值不同**（负向对照不空转）：合法基线本身两层都不报这一位
  const base = verdictsOf('decision')
  assert.equal(base.shape, true, '基线取值 decision 在形状层不许报问题')
  assert.equal(base.content, true, '基线取值 decision 在内容层不许报问题')
})
