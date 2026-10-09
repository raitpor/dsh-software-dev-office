/**
 * **增量 83：D-21（变更控制接不住验收标准）+ 它的同族附带缺陷**
 *
 *   · **D-21（major）**：`sdo_requirement action=change` 只认标量字段（title/statement/rationale/
 *     priority/kind）⇒「基线后 AC 要改」这件事**既进不了变更单、也不会被应用**：
 *     schema 里 `acceptance` 一直声明着，但 `change` 分支从不读它；回执把人读摘要写成
 *     「（仅记录变更请求，未给出具体字段）」，而批准后 AC 一条没动 —— 需求却已标 `changed`、
 *     版本 +0.1、阶段回退，**看起来"变更已应用"**（独立核实：改前 AC before == after）。
 *     AC 是评审与交付验收的依据（C-60/P-3），是最该受变更控制的内容，却走了旁路。
 *   · **同族附带（replaces 静默改内容）**：`update acceptanceMode=replace` 换掉的是**内容**，
 *     但 `contentTouched` 只认 `addAcceptance` ⇒ 已基线需求"只换 AC"后仍停在 `baselined`
 *     （冻结时间/签字人停在旧版本上，且这一改动没有任何 CR）。
 *
 * 覆盖：AC-only CR（批准/延期）· replace 变更 + 改号提示 · statement+AC 同时列出 ·
 * 校验先于落盘（冲突时零写入）· k87 兜底仍然只在"真没改什么"时出现。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { GRILL_GAP_SCOPE, designGaps } from '../src/domain/design.js'
import { apply } from '../src/index.js'
import { designInteraction } from '../src/interface/designReceipt.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { Context } from '@deepseek-ai/cordis'
import type { DesignArgs } from '../src/interface/tools.js'
import type { ChangeRequest, Requirement } from '../src/types.js'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm83')
const ALL2 = { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 }

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: Record<string, unknown>, exec: unknown) => unknown
}

let office: SoftwareDevOffice
let store: SdoStore
let journal: Journal
let tools: ToolDefinition[]
const call = { sessionId: 's1', cwd: BASE }

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', BASE)
  office.init(call, { name: 'M83', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['对账'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['识别率 ≥ 99%'],
    glossary: { 差异: '不一致记录' },
  })
  store = office.storeFor(BASE)
  journal = office.journalFor(BASE)
  tools = []
  const services: Record<string, unknown> = { tools: { register: (tool: ToolDefinition): (() => void) => { tools.push(tool); return () => {} } } }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 走真实工具面（schema 过滤 + 会话身份），与模型调用同一条路。 */
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  return String(
    await tool.execute(filtered, {
      agent: { id: 's1', session: { header: { id: 's1', cwd: BASE, delegationDepth: 0 } } },
    }),
  )
}

/**
 * 造一条**已基线**需求（G2 签字 + 基线判定）—— `change` 只在这两种状态下才接变更单，
 * 所以 D-21 的用例必须真的走一遍基线，不能拿 draft 冒充。
 */
function baselinedRequirement(acceptanceId = 'AC-001'): string {
  office.assessFeasibility(call, { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  office.logRisk(call, { title: '格式变更', level: 'low', probability: 'low', impact: '小', mitigation: '校验', owner: '业务方' })
  const captured = office.capture(call, {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call, {
    id: captured.requirement.id,
    addAcceptance: [{ id: acceptanceId, given: '已导入两日文件', when: '执行对账', then: '输出差异清单' }],
    modelDimensions: ALL2,
  })
  office.redTeamAttack(call, [captured.requirement.id], 7)
  let guard = 0
  while (guard++ < 40) {
    const open = office.questions(call).filter((question) => question.status === 'open')
    if (open.length === 0) break
    office.answer(call, { id: open[0]!.id, answer: '已确认', modelDimensions: ALL2 })
  }
  for (const question of office.questions(call).filter((item) => item.status === 'open' && item.severity === 'P1')) {
    office.logRisk(call, {
      title: `未决 P1 的风险处置：${question.id}`,
      level: 'medium',
      probability: 'medium',
      impact: 'x',
      mitigation: '按计划回答',
      owner: '业务方',
      origin: question.id,
    })
  }
  office.signGate(call, { gate: 'G2', by: '张三', basis: `我确认需求基线可以冻结（M83 第 ${basisRound++} 次表态）`, channel: 'command' })
  const outcome = office.baseline(call, { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `基线应通过：${outcome.dor.failed.join(',')}`)
  return captured.requirement.id
}
let basisRound = 1

const requirement = (id: string): Requirement => {
  const found = office.requirements(call).find((item) => item.id === id)
  assert.ok(found !== undefined, `找不到需求 ${id}`)
  return found
}

const acIds = (id: string): string[] => requirement(id).acceptance.map((ac) => ac.id)

const changeRequest = (id: string): ChangeRequest => {
  const raw = store.readYaml<{ change: ChangeRequest }>('changes', `${id}.yml`)?.change
  assert.ok(raw !== undefined, `找不到变更单 ${id}`)
  return raw
}

// ————————————————————————— D-21 主干 —————————————————————————

test('M83-01 D-21：只改 AC 的 CR 必须把 AC 写进变更内容，并在批准后**真的应用到需求上**', async () => {
  const req = baselinedRequirement()
  assert.deepEqual(acIds(req), ['AC-001'])
  const receipt = await callTool('sdo_requirement', {
    action: 'change',
    id: req,
    reason: '验收标准要补一条并发口径',
    decision: 'approved',
    acceptance: JSON.stringify([{ given: '两路对账并发', when: '同时写入', then: '差异清单不重复' }]),
  })
  // ① 人读摘要必须点名这条 AC（旧实现写的是「仅记录变更请求，未给出具体字段」）
  assert.doesNotMatch(receipt, /仅记录变更请求/u, `AC 变更必须进 CR 摘要：${receipt}`)
  assert.match(receipt, /新增验收标准 AC-002：Given 两路对账并发/u, `回执要点名 AC 与 Given：${receipt}`)
  assert.match(receipt, /When 同时写入/u)
  assert.match(receipt, /Then 差异清单不重复/u)
  // ② 变更单文件里的 `changes[]` 与回执同源（审计读的是文件，不是回执）
  const filed = changeRequest('CR-001')
  assert.equal(filed.changes.length, 1, `变更单只该有一条内容摘要：${JSON.stringify(filed.changes)}`)
  assert.match(filed.changes[0] ?? '', /AC-002/u)
  // ③ 批准 ⇒ AC 真落盘（旧实现：AC before == after，却报"变更已应用"）
  assert.deepEqual(acIds(req), ['AC-001', 'AC-002'])
  const added = requirement(req).acceptance[1]
  assert.deepEqual(
    { given: added?.given, when: added?.when, then: added?.then },
    { given: '两路对账并发', when: '同时写入', then: '差异清单不重复' },
  )
  assert.equal(requirement(req).status, 'changed')
  // ④ journal 里能机器查到"这次 CR 带了 AC"（人读摘要之外的第二份留痕）
  const requested = journal.read().events.filter((event) => event.type === 'change/requested')
  assert.equal(requested.length, 1)
  assert.equal(requested[0]?.data['acceptance'], 1)
  assert.equal(requested[0]?.data['acceptanceMode'], 'append')
})

test('M83-02 D-21：延期（deferred）的 AC 变更**留档但不应用** —— 变更单里有、需求上没有', async () => {
  const req = baselinedRequirement()
  const receipt = await callTool('sdo_requirement', {
    action: 'change',
    id: req,
    reason: '这条并发口径还要和业务方确认',
    decision: 'deferred',
    acceptance: JSON.stringify([{ given: '两路对账并发', when: '同时写入', then: '差异清单不重复' }]),
  })
  assert.match(receipt, /新增验收标准 AC-002/u, `延期也要把"打算改什么"写全：${receipt}`)
  assert.match(receipt, /未应用/u)
  assert.deepEqual(acIds(req), ['AC-001'], '延期不许改需求')
  assert.equal(changeRequest('CR-001').decision, 'deferred')
  assert.equal(requirement(req).status, 'baselined', '需求也不该因为一条延期的 CR 退出冻结')
})

test('M83-03 D-21：`acceptanceMode=replace` 走变更单 ⇒ 整份替换 + **改号当场报出来**（R-25 同族）', async () => {
  const req = baselinedRequirement()
  const receipt = await callTool('sdo_requirement', {
    action: 'change',
    id: req,
    reason: '验收标准要重写（原条目无法测）',
    decision: 'approved',
    acceptanceMode: 'replace',
    acceptance: JSON.stringify([
      { given: '已导入两日文件', when: '执行对账', then: '输出差异清单（含并发去重）' },
      { given: '差异已处置', when: '再次对账', then: '该差异不再出现' },
    ]),
  })
  assert.match(receipt, /替换整份验收标准（2 条）：新编号 AC-002 AC-003/u, `替换要报条数与新编号：${receipt}`)
  // AC 编号是交付验收矩阵的追溯键：改号必须点名（旧 change 路径连这条提示都没有）
  assert.match(receipt, /验收标准编号已变 1 条/u, `改号必须当场报出来：${receipt}`)
  assert.match(receipt, /AC-001→AC-002/u)
  assert.deepEqual(acIds(req), ['AC-002', 'AC-003'], 'replace 是整份替换，旧条目不许残留')
  const requested = journal.read().events.find((event) => event.type === 'change/requested')
  assert.equal(requested?.data['acceptanceMode'], 'replace')
  assert.equal(requested?.data['acceptance'], 2)
})

test('M83-04 D-21：陈述 + AC 同时改 ⇒ 摘要两条都在（AC 分支不许把标量分支挤掉）', async () => {
  const req = baselinedRequirement()
  const receipt = await callTool('sdo_requirement', {
    action: 'change',
    id: req,
    reason: '对账口径与验收标准一起改',
    decision: 'approved',
    statement: '系统须在每日对账后识别差异并去重；单日 100 万，P99 < 500 毫秒',
    acceptance: JSON.stringify([{ given: '两路对账并发', when: '同时写入', then: '差异清单不重复' }]),
  })
  assert.match(receipt, /陈述改为：系统须在每日对账后识别差异并去重/u)
  assert.match(receipt, /新增验收标准 AC-002/u)
  const filed = changeRequest('CR-001')
  assert.equal(filed.changes.length, 2, `陈述与 AC 各一条：${JSON.stringify(filed.changes)}`)
  assert.match(requirement(req).statement, /并去重/u)
  assert.deepEqual(acIds(req), ['AC-001', 'AC-002'])
})

// ————————————————————————— 顺序与兜底 —————————————————————————

test('M83-05 D-21：AC 编号冲突时**先报错、零写入**（不许留下"变更单在册、内容没动"的半写）', async () => {
  const req = baselinedRequirement()
  // 另一条需求占住 AC-009（全局唯一是 N-2 的口径）
  const other = office.capture(call, { title: '另一条', statement: '另一条需求的陈述，用于占号', priority: 'should', sourceStakeholder: 'STK-01' })
  office.update(call, { id: other.requirement.id, addAcceptance: [{ id: 'AC-009', given: 'g', when: 'w', then: 't' }], modelDimensions: ALL2 })
  const crBefore = store.listNames('changes').length
  const eventsBefore = journal.read().events.length
  await assert.rejects(
    async () =>
      office.change(call, {
        requirement: req,
        reason: '故意用一个已被占用的 AC 编号',
        changes: ['新增验收标准 AC-009：…'],
        decision: 'approved',
        decidedBy: 'human',
        addAcceptance: [{ id: 'AC-009', given: 'g2', when: 'w2', then: 't2' }],
      }),
    /验收标准编号重复/u,
  )
  assert.equal(store.listNames('changes').length, crBefore, '校验失败时不许写变更单')
  assert.equal(journal.read().events.length, eventsBefore, '校验失败时不许写 journal（连 change/requested 都不许）')
  assert.deepEqual(acIds(req), ['AC-001'])
})

test('M83-06 D-21 兜底仍然只认"真没改什么"：无字段无 AC 的 CR 照样写 k87，且不改需求', async () => {
  const req = baselinedRequirement()
  const receipt = await callTool('sdo_requirement', {
    action: 'change',
    id: req,
    reason: '只是登记一次决策',
    decision: 'approved',
  })
  assert.match(receipt, /仅记录变更请求，未给出具体字段/u, `没给字段时才用兜底文案：${receipt}`)
  assert.equal(changeRequest('CR-001').changes.length, 1)
  assert.deepEqual(acIds(req), ['AC-001'])
})

// ————————————————————————— 同族附带缺陷 —————————————————————————

test('M83-07 D-21 附带：已基线需求「只换 AC」的 update 必须退出冻结（内容变了就不许再标已冻结）', async () => {
  const req = baselinedRequirement()
  assert.equal(requirement(req).status, 'baselined')
  assert.equal(requirement(req).version, 0.2)
  const before = store.readYaml<{ requirement: Requirement }>('requirements', `${req}.yml`)?.requirement
  const receipt = await callTool('sdo_requirement', {
    action: 'update',
    id: req,
    acceptanceMode: 'replace',
    acceptance: JSON.stringify([{ given: '已导入两日文件', when: '执行对账', then: '输出差异清单（含并发去重）' }]),
  })
  const after = requirement(req)
  assert.equal(after.status, 'changed', `AC 是内容：换了内容就不许留在已冻结（回执：${receipt}）`)
  assert.equal(after.version, 0.3, '内容变过，版本号必须表达它（R-9 同口径）')
  assert.deepEqual(after.acceptance.map((ac) => ac.id), ['AC-002'])
  // 冻结事实与内容不一致才是这条缺陷的要害：旧实现把 baseline 留在旧版本上
  assert.notEqual(before?.updatedAt, after.updatedAt)
  assert.match(receipt, /状态：已变更/u)
})

// ————————————————————————— D-19 ①（用户裁定"按 1 做"） —————————————————————————

/**
 * 另起一个工作区造 D-19 的夹具（`init` 对已存在的项目**只读**，所以规模必须在立项时给定；
 * 而适用性声明是需求阶段产的 `design/applicability.yml`，`draftApplicability` 起草即写入）。
 */
function d19Fixture(scale: 'trivial' | 'normal', viewsPresent?: string[]): { office: SoftwareDevOffice; call: { sessionId: string; cwd: string } } {
  const dir = join(BASE, 'd19', `${scale}-${viewsPresent === undefined ? 'nodecl' : 'decl'}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const scoped = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const scopedCall = { sessionId: 's2', cwd: dir }
  scoped.noteSession('s2', dir)
  scoped.init(scopedCall, { name: 'D19 夹具', scale, stakeholders: ['业务方'] })
  if (viewsPresent !== undefined) scoped.draftApplicability(scopedCall, { focus: '夹具计数工具（读两个夹具、打一份计数）', viewsPresent })
  return { office: scoped, call: scopedCall }
}

/** 直接问域层要"这一轮会问哪些、跳过了哪些"（`designGaps` 是只读的，不会动台账）。 */
function gapsOf(office: SoftwareDevOffice, call: { sessionId: string; cwd: string }): {
  keys: string[]
  skipped: { key: string; reason: 'view-not-declared' | 'trivial-core-only' }[]
} {
  const store = office.storeFor(call.cwd)
  const project = new Journal(store).loadProject().project
  const skipped: { key: string; reason: 'view-not-declared' | 'trivial-core-only' }[] = []
  const gaps = designGaps(store, project, office.requirements(call), undefined, skipped)
  return { keys: gaps.map((gapItem) => gapItem.key), skipped }
}

test('M83-08 D-19 ①：trivial 档只问核心几问，被跳过的**逐条点名并给出理由**', () => {
  const { office: scoped, call: scopedCall } = d19Fixture('trivial', ['context', 'component'])
  const { keys, skipped } = gapsOf(scoped, scopedCall)
  assert.deepEqual(keys, ['form', 'external', 'errors', 'techdebt'], `trivial 档只该问核心几问：${keys.join(' ')}`)
  assert.deepEqual(
    [...new Set(skipped.map((item) => item.reason))],
    ['trivial-core-only'],
    'trivial 档的跳过理由只有一种（裁剪档），不该混进"没声明视图"',
  )
  assert.equal(skipped.length, 9, `13 问里该剩 4 问 ⇒ 跳过 9：${JSON.stringify(skipped)}`)
  for (const key of ['store', 'concurrency', 'deployment', 'evolution']) {
    assert.ok(skipped.some((item) => item.key === key), `${key} 应被记录为跳过：${JSON.stringify(skipped)}`)
  }
  // 回执必须**点名**"没问"与"没答"的区别（旧实现回执里只有问题清单，看不出少问了什么）
  const receipt = designInteraction(scoped, scopedCall, 'grill', { action: 'grill' } as DesignArgs)
  assert.match(receipt, /另有 9 问\*\*按适用性声明\/裁剪档跳过\*\*（没问，不是没人答）/u, `回执要点名跳过数：${receipt}`)
  assert.match(receipt, /store（trivial 档只问核心几问/u)
  assert.match(receipt, /concurrency（trivial 档只问核心几问/u)
})

test('M83-09 D-19 ①：按声明视图裁剪（normal 档）—— 且**缺声明时问卷不许缩水**', () => {
  const declared = d19Fixture('normal', ['context', 'component'])
  const withDecl = gapsOf(declared.office, declared.call)
  assert.deepEqual(
    withDecl.keys,
    ['form', 'external', 'errors', 'evolution', 'techdebt'],
    `只该问"总是要问的" + 声明过的视图（component 声明了 ⇒ evolution 留下）：${withDecl.keys.join(' ')}`,
  )
  assert.equal(withDecl.skipped.length, 8)
  assert.deepEqual([...new Set(withDecl.skipped.map((item) => item.reason))], ['view-not-declared'])
  for (const key of ['store', 'consistency', 'retention', 'concurrency', 'performance', 'failure', 'observability', 'deployment']) {
    assert.ok(withDecl.skipped.some((item) => item.key === key), `${key} 归属的视图没声明，应跳过`)
  }
  // **反向守卫（不许过度裁剪）**：没有适用性声明 ≠ 问卷消失（声明缺失是"还没声明"，不是"都不做"）
  const bare = d19Fixture('normal')
  const withoutDecl = gapsOf(bare.office, bare.call)
  assert.deepEqual(withoutDecl.skipped, [], '没有声明时不许跳过任何一问')
  assert.equal(withoutDecl.keys.length, 13, `全套 13 问必须原样保留：${withoutDecl.keys.join(' ')}`)
})

test('M83-10 D-19 ①：裁剪表与产出的题**双向对齐**（死条目 / 漏登记都判红）', () => {
  // 这条守卫来自本轮自己踩的坑：首次实现把技术债登记成 `tech-debt`，而产出用的 key 是 `techdebt`
  // ⇒ 表里那一行是**死条目**（行为碰巧一样，表却在说谎；日后给它挂视图会静默失效）。
  // 单方向扫描不够（D-16 的教训）：两个方向都要机械核对。
  const produced = new Set<string>()
  for (const kind of [undefined, 'ui'] as const) {
    const { office: scoped, call: scopedCall } = d19Fixture('normal', ['context'])
    if (kind !== undefined) {
      scoped.capture(scopedCall, { title: '界面', statement: '需要一个对账界面；单页 100 行', kind, priority: 'must', sourceStakeholder: 'STK-01' })
    }
    const { keys, skipped } = gapsOf(scoped, scopedCall)
    for (const key of keys) produced.add(key)
    // 被跳过的题**也**是裁剪表必须覆盖的：它们是"先生成、后被过滤"的，
    // 只统计这一轮留下的会把"表里挂了视图的题"误判成死条目。
    for (const item of skipped) produced.add(item.key)
    if (kind === 'ui') {
      // 界面五问由 `uiDecision().hasUi` 决定，与适用性声明无关 ⇒ 声明里没有它们也必须问
      for (const key of ['ui-style', 'ui-columns', 'ui-layout', 'ui-breakpoint', 'ui-a11y']) {
        assert.ok(keys.includes(key), `判定为"含界面"时 ${key} 必须问：${keys.join(' ')}`)
      }
    }
  }
  const table = Object.keys(GRILL_GAP_SCOPE)
  assert.deepEqual(
    [...produced].filter((key) => !table.includes(key)),
    [],
    '产出的题必须都在裁剪表里登记（否则它落进"表里没有 ⇒ 照旧要问"的兜底，裁剪对它静默失效）',
  )
  assert.deepEqual(
    table.filter((key) => !produced.has(key)),
    [],
    '裁剪表里不许有**死条目**（登记的 key 从不产出 ⇒ 那一行是假的）',
  )
  assert.ok(table.includes('techdebt'), '技术债的真实 key 是 `techdebt`（无连字符）')
  assert.ok(!table.includes('tech-debt'), '`tech-debt` 是死条目，不许再出现')
})
