/**
 * 增量 6：诊断报告《2026-10-01-插件测试报告-0.1.2设计阶段》§6.3 六条新缺陷的回归。
 *
 *   F-11  时序需求字段两套（`requirement` / `requires`），追溯只认一套 → 假红（实测 9 个假孤儿）
 *   F-13  C-29 要求「每条 must 需求都要有对应时序」，对 constraint / quality 不成立（逼人造假）
 *   F-14  C-29 要求「每个类型都要有协作方」，与分层方向规则对叶子层互斥（恒红）
 *   F-15  线框图把 `layout.regions` 画成并排，与 `grid` 自由文本声明相反
 *   F-12  C-25 成功文案说 9 章，判据实际校验 11 章
 *   F-10  `artifactData` 形状未文档化，未知字段被**静默忽略**（与 F-8 同族）
 *
 * 纪律（与 m11…m15 一致）：
 *   · 每条都**双向**：放宽的那一侧要有正的用例，收紧的那一侧要有反例（不许把断言改成恒真）；
 *   · 断言只读**真源**（`.sdo/` 下的 yml / 门禁判据 / 语言包文件），不采信任何自述；
 *   · 文案断言取自语言包（`t()` / `fmt()`），不写死中文，保证语言包缺键会被抓住。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { DESIGN_DOC_SECTIONS, parseUiViewInput } from '../src/domain/design.js'
import { fmt, t } from '../src/domain/i18n.js'
import { designInteraction } from '../src/interface/designReceipt.js'
import type { DesignArgs } from '../src/interface/tools.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { GateCriterionResult, GateEvaluation, ProcessDef, SequenceSpec, UiView } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m16/', import.meta.url))
const ALL2 = { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 }

let workspace: string
let office: SoftwareDevOffice
const call = (): { sessionId: string } => ({ sessionId: 's1' })

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// —————————————————————— 夹具 ——————————————————————

/** 一个独立工作区 + 门面（每条用例可能要在多个工作区之间做 A/B 对比）。 */
function makeProject(suffix: string): { office: SoftwareDevOffice; ws: string } {
  const ws = join(BASE, suffix)
  mkdirSync(ws, { recursive: true })
  const instance = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  instance.noteSession('s1', ws)
  return { office: instance, ws }
}

/** 造一条已基线 functional must 需求（G2 通过）。 */
function baselineRequirement(target: SoftwareDevOffice = office, name = 'M16 测试'): string {
  target.init(call(), { name, scale: 'normal', stakeholders: ['业务方'] })
  target.updateProject(call(), {
    scopeIn: ['对账'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['识别率 ≥ 99%'],
    glossary: { 差异: '不一致记录' },
  })
  target.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  target.logRisk(call(), { title: '格式变更', level: 'low', probability: 'low', impact: '小', mitigation: '校验', owner: '业务方' })
  const captured = target.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    kind: 'functional',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  target.update(call(), {
    id: captured.requirement.id,
    addAcceptance: [{ id: 'AC-001', given: '已导入两日文件', when: '执行对账', then: '输出差异清单' }],
    modelDimensions: ALL2,
  })
  target.askDesignQuestions(call(), { recommendation: { method: '结构化', rationale: '需求稳定' } })
  target.redTeamAttack(call(), [captured.requirement.id], 7)
  let guard = 0
  while (guard++ < 40) {
    const open = target.questions(call()).filter((question) => question.status === 'open')
    const pending = open.filter((question) => !question.targets.includes('design:method'))
    if (pending.length === 0) break
    target.answer(call(), { id: pending[0]!.id, answer: '已确认', modelDimensions: ALL2 })
  }
  // D1 + D4：未决 P1 补风险处置，再签 G2 字（放行依据是签字台账）
  prepareG2(target, call())
  const outcome = target.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `前置：基线应通过：${outcome.dor.failed.join(',')}`)
  return captured.requirement.id
}

/** 追加两条 must 需求：一条 functional（流程类）、一条 constraint（约束类，没有流程可画）。 */
function extraMusts(target: SoftwareDevOffice = office): { functional: string; constraint: string } {
  target.grillDesign(call(), { recommendation: { method: '结构化', rationale: '需求稳定' } })
  const functional = target.capture(call(), {
    title: '并发抢名额',
    statement: '系统须在并发抢名额时保证不超卖',
    kind: 'functional',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  }).requirement.id
  const constraint = target.capture(call(), {
    title: '单机与合规约束',
    statement: '系统须以单机可运行方式交付，且不采集个人身份信息',
    kind: 'constraint',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  }).requirement.id
  return { functional, constraint }
}

/** 回答方法论选择题（`oo` = 面向对象包）。 */
function selectOo(target: SoftwareDevOffice = office): void {
  target.grillDesign(call(), { recommendation: { method: '结构化', rationale: '需求稳定' } })
  const issues = target.designIssues(call())
  const question = [...issues.open, ...issues.closed].find((item) => item.targets.includes('design:method'))
  assert.ok(question !== undefined, '前置：必须有方法论选择题')
  target.answerDesign(call(), question.id, 'oo', '测试选择')
  const selection = target.methodSelection(call())
  assert.deepEqual(selection.methods, ['oo'], `前置：应选中 oo，实际 ${selection.methods.join('+')}（${selection.reason}）`)
}

/** 取某个门禁里绑定了指定检查器的判据 id（从**流程数据**读，不写死编号）。 */
function checkId(process: ProcessDef, gate: string, check: string): string {
  const definition = process.gates.find((item) => item.id === gate)
  const criterion = definition?.criteria.find((item) => item.check === check)
  assert.ok(criterion !== undefined, `${gate} 缺检查器 ${check}`)
  return criterion.id
}

function hit(evaluation: GateEvaluation, id: string): GateCriterionResult {
  const criterion = evaluation.criteria.find((item) => item.id === id)
  assert.ok(criterion !== undefined, `门禁 ${evaluation.gate} 缺判据 ${id}`)
  return criterion
}

/** oo 的三份最小必产项（类/时序/分层），可注入叶子层与"非叶子缺协作方"的反例。 */
function writeOoTypes(target: SoftwareDevOffice, requirementId: string, options: { ghostType?: boolean; leafCover?: boolean } = {}): void {
  const types = [
    { name: '对账服务', kind: 'class' as const, layer: 'domain', responsibility: '检测对账差异', collaborators: ['差异仓储'], requires: [requirementId] },
    { name: '差异仓储', kind: 'interface' as const, layer: 'infrastructure', responsibility: '存取差异记录', collaborators: ['差异记录表'], requires: [requirementId] },
    { name: '差异记录表', kind: 'class' as const, layer: 'infrastructure', responsibility: '承载差异记录', collaborators: ['差异仓储'], requires: [requirementId] },
    // 叶子层：只放常量与错误码 → 没有真实协作方（报告 F-14 的 domain 层）
    ...(options.leafCover === true
      ? [{ name: '领域常量', kind: 'class' as const, layer: 'domain', responsibility: '集中领域常量与错误码', collaborators: [] as string[], leaf: true, requires: [requirementId] }]
      : []),
    // 反例：非叶子却没有协作方
    ...(options.ghostType === true
      ? [{ name: '孤立组件', kind: 'class' as const, layer: 'domain', responsibility: '没有任何协作方', collaborators: [] as string[], requires: [requirementId] }]
      : []),
  ]
  target.writeMethodArtifact(call(), 'classes', { summary: '对账领域类型', types })
  target.writeMethodArtifact(call(), 'layers', {
    summary: '分层依赖规则',
    rules: {
      layers: ['domain', 'infrastructure'],
      assignments: { 对账服务: 'domain', 差异仓储: 'infrastructure', 差异记录表: 'infrastructure', 领域常量: 'domain', 孤立组件: 'domain' },
      allowed: [{ from: 'domain', to: 'infrastructure' }],
    },
  })
  // 时序也是 oo 的最小必产项：覆盖这条 functional must（叶子/协作方是 F-14 的面，别被缺产物搅进来）
  target.writeMethodArtifact(call(), 'sequences', { summary: '关键用例时序', sequences: [sequenceFor(requirementId, 'requirement')] })
}

/** 一条覆盖 `requirement` 的时序（可选地把来源写在哪个字段上）。 */
function sequenceFor(requirement: string | undefined, field: 'requirement' | 'requires' | 'none'): SequenceSpec {
  return {
    name: '每日检测差异',
    ...(field === 'requirement' && requirement !== undefined ? { requirement } : {}),
    ...(field === 'requires' && requirement !== undefined ? { requires: [requirement] } : {}),
    participants: ['对账服务'],
    messages: [{ name: '检测', from: '对账服务', to: '对账服务', trigger: '批处理开始' }],
  }
}

// —————————————————————— F-11 ——————————————————————

test('F-11 时序需求字段归一：只写 requirement / 只写 requires → 追溯结果完全相同（不再是假孤儿）', () => {
  // A：只写单数 `requirement`
  const a = makeProject('f11-a')
  const reqA = baselineRequirement(a.office, 'F11-A')
  a.office.writeMethodArtifact(call(), 'sequences', { summary: '关键用例时序', sequences: [sequenceFor(reqA, 'requirement')] })

  // B：只写复数 `requires`（内容一字不改）
  const b = makeProject('f11-b')
  const reqB = baselineRequirement(b.office, 'F11-B')
  b.office.writeMethodArtifact(call(), 'sequences', { summary: '关键用例时序', sequences: [sequenceFor(reqB, 'requires')] })

  // ① 落盘形态必须**归一**：两套字段都存在且互相一致（不能只改注释）
  const storedA = a.office.storeFor(a.ws).readYaml<{ artifact: { sequences: { requirement?: string; requires?: string[] }[] } }>('design', 'method-sequences.yml')
  const storedB = b.office.storeFor(b.ws).readYaml<{ artifact: { sequences: { requirement?: string; requires?: string[] }[] } }>('design', 'method-sequences.yml')
  for (const [label, stored, req] of [['A', storedA, reqA], ['B', storedB, reqB]] as const) {
    const sequence = stored?.artifact.sequences[0]
    assert.ok(sequence !== undefined, `${label}：时序必须真的落盘`)
    assert.equal(sequence.requirement, req, `${label}：requirement 必须由写入时归一补上`)
    assert.deepEqual(sequence.requires, [req], `${label}：requires 必须由写入时归一补上`)
  }

  // ② 追溯结果必须相同：都没有 SEQ-* 孤儿（修复前 A 侧会全量判孤儿）
  const reportA = a.office.traceReport(call())
  const reportB = b.office.traceReport(call())
  assert.deepEqual(reportA.orphans.design, [], `A（只写 requirement）不得有孤儿：${reportA.orphans.design.join(' ')}`)
  assert.deepEqual(reportB.orphans.design, [], `B（只写 requires）不得有孤儿：${reportB.orphans.design.join(' ')}`)
  assert.deepEqual(reportA.orphans, reportB.orphans, '两套字段各写一次的追溯结果必须逐字相同')
  assert.equal(reportA.coverage, reportB.coverage, '覆盖率也必须相同')

  // ③ 反向（不许把断言改成恒真）：两套字段都不写 → 仍然是孤儿
  const c = makeProject('f11-c')
  baselineRequirement(c.office, 'F11-C')
  c.office.writeMethodArtifact(call(), 'sequences', { summary: '关键用例时序', sequences: [sequenceFor(undefined, 'none')] })
  const orphanC = c.office.traceReport(call()).orphans.design
  assert.equal(orphanC.length, 1, `没有任何需求来源的时序仍必须是孤儿：${orphanC.join(' ')}`)
  assert.ok(orphanC[0]?.startsWith('SEQ-'), `孤儿必须是那条时序，实际 ${orphanC[0]}`)
})

// —————————————————————— F-13 ——————————————————————

test('F-13 C-29 按需求 kind 豁免：constraint 缺时序为绿且回执点名豁免理由 / functional 缺时序仍红', () => {
  const reqId = baselineRequirement()
  const extra = extraMusts()
  selectOo()
  writeOoTypes(office, reqId)
  // 两条 functional must 都写时序；constraint 需求（`extra.constraint`）**故意不写** ——
  // 它本来就没有流程可画，强制各配一条时序就是逼人造假（报告的 REQ-009）。
  office.writeMethodArtifact(call(), 'sequences', {
    summary: '关键用例时序',
    sequences: [sequenceFor(reqId, 'requirement'), sequenceFor(extra.functional, 'requires')],
  })

  const process = office.process(call())
  const productsId = checkId(process, 'G3', 'design.method-products')

  // ① 正向：constraint 需求缺时序**不再判红**，且豁免在回执里**显式说明**
  const passed = office.evaluate(call(), 'G3')
  assert.equal(hit(passed, productsId).ok, true, `constraint 缺时序不得再判红：${hit(passed, productsId).detail}`)
  const oo = office.methodProducts(call()).packages.find((item) => item.id === 'oo')
  assert.ok(oo !== undefined)
  assert.ok(
    oo.exemptions.some((line) => line.includes(extra.constraint) && line.includes('constraint')),
    `豁免必须点名需求 id 与 kind：${oo.exemptions.join(' | ')}`,
  )
  assert.ok(hit(passed, productsId).detail.includes(extra.constraint), '门禁回执必须写明哪条需求被豁免')
  assert.ok(hit(passed, productsId).detail.includes(fmt('uiMethod.pkgExempt', { p1: '' }).trim()), '回执必须带"豁免"字样')
  // 只读回执（action=method）同样要能看到豁免
  const methodReceipt = designInteraction(office, call(), 'method', { action: 'method' } as DesignArgs)
  assert.ok(methodReceipt.includes(extra.constraint), `action=method 回执必须列出豁免的需求：\n${methodReceipt}`)

  // ② 反向：functional 缺时序**仍然判红**（放宽只针对 constraint / quality）
  const second = makeProject('f13-反向')
  const req2 = baselineRequirement(second.office, 'F13-反向')
  const extra2 = extraMusts(second.office)
  selectOo(second.office)
  writeOoTypes(second.office, req2)
  // 只覆盖第一条 functional；第二条 functional（`extra2.functional`）故意不覆盖
  second.office.writeMethodArtifact(call(), 'sequences', { summary: '只覆盖第一条', sequences: [sequenceFor(req2, 'requirement')] })
  const productsId2 = checkId(second.office.process(call()), 'G3', 'design.method-products')
  const failed = second.office.evaluate(call(), 'G3')
  assert.equal(hit(failed, productsId2).ok, false, 'functional 需求缺时序必须仍然判红')
  assert.ok(hit(failed, productsId2).detail.includes(extra2.functional), `理由必须点名那条 functional 需求：${hit(failed, productsId2).detail}`)
  // 同一条判据里，constraint 需求仍然只以"豁免"出现（不是缺项）
  assert.equal(
    hit(failed, productsId2).detail.includes(fmt('uiMethod.sequenceMissingMust', { p1: extra2.constraint })),
    false,
    'constraint 不得被当成缺时序',
  )

  // ③ 豁免文案本身必须可读（两个占位：需求 id + kind）
  assert.equal([...t('uiMethod.sequenceKindExempt').matchAll(/\{p\d\}/gu)].length, 2, '豁免文案必须带需求 id 与 kind 两个占位')
  assert.ok(fmt('uiMethod.sequenceKindExempt', { p1: 'REQ-999', p2: 'quality' }).includes('REQ-999'))
})

// —————————————————————— F-14 ——————————————————————

test('F-14 叶子必须显式声明：非叶子缺协作方红 / 显式 leaf 缺协作方绿且回执说明被当作叶子的类型', () => {
  const reqId = baselineRequirement()
  selectOo()
  writeOoTypes(office, reqId, { leafCover: true, ghostType: true })

  const process = office.process(call())
  const productsId = checkId(process, 'G3', 'design.method-products')

  // ① 反向：非叶子（没有 leaf: true）缺协作方 → 仍然判红，且点名那个类型
  const red = office.evaluate(call(), 'G3')
  assert.equal(hit(red, productsId).ok, false, '非叶子缺协作方必须判红')
  assert.match(hit(red, productsId).detail, /孤立组件/u, '理由必须点名那个非叶子类型')
  const ooRed = office.methodProducts(call()).packages.find((item) => item.id === 'oo')
  assert.ok(ooRed !== undefined)
  assert.equal(ooRed.missing.some((line) => line.includes('领域常量')), false, '显式叶子不得出现在缺项里')
  assert.ok(ooRed.exemptions.some((line) => line.includes('领域常量')), '回执必须说明领域常量被当作叶子')

  // ② 正向：把那个类型也**显式**声明为叶子 → C-29 转绿，且被当作叶子的类型都列在回执里
  office.writeMethodArtifact(call(), 'classes', {
    summary: '对账领域类型',
    types: [
      { name: '对账服务', kind: 'class', layer: 'domain', responsibility: '检测对账差异', collaborators: ['差异仓储'], requires: [reqId] },
      { name: '差异仓储', kind: 'interface', layer: 'infrastructure', responsibility: '存取差异记录', collaborators: ['差异记录表'], requires: [reqId] },
      { name: '差异记录表', kind: 'class', layer: 'infrastructure', responsibility: '承载差异记录', collaborators: ['差异仓储'], requires: [reqId] },
      { name: '领域常量', kind: 'class', layer: 'domain', responsibility: '集中领域常量与错误码', collaborators: [], leaf: true, requires: [reqId] },
      { name: '孤立组件', kind: 'class', layer: 'domain', responsibility: '没有任何协作方', collaborators: [], leaf: true, requires: [reqId] },
    ],
  })
  const consistencyId = checkId(process, 'G3', 'design.method-consistency')
  const green = office.evaluate(call(), 'G3')
  assert.equal(hit(green, productsId).ok, true, `显式叶子缺协作方必须放行：${hit(green, productsId).detail}`)
  assert.ok(
    hit(green, productsId).detail.includes('领域常量') && hit(green, productsId).detail.includes('孤立组件'),
    `回执必须列出被当作叶子的类型：${hit(green, productsId).detail}`,
  )
  assert.equal(hit(green, consistencyId).ok, true, `叶子不声明协作方时方向检查必须通过：${hit(green, consistencyId).detail}`)

  // ③ 放宽的是 C-29，不是分层方向：叶子若声明了违规方向的协作方，C-2A 仍必须判红
  office.writeMethodArtifact(call(), 'classes', {
    summary: '对账领域类型',
    types: [
      { name: '对账服务', kind: 'class', layer: 'domain', responsibility: '检测对账差异', collaborators: ['差异仓储'], requires: [reqId] },
      { name: '差异仓储', kind: 'interface', layer: 'infrastructure', responsibility: '存取差异记录', collaborators: ['差异记录表'], requires: [reqId] },
      { name: '差异记录表', kind: 'class', layer: 'infrastructure', responsibility: '承载差异记录', collaborators: ['差异仓储'], requires: [reqId] },
      // infrastructure → domain 不在 allowed 里（只声明了 domain → infrastructure）
      { name: '领域常量', kind: 'class', layer: 'infrastructure', responsibility: '集中领域常量与错误码', collaborators: ['对账服务'], leaf: true, requires: [reqId] },
    ],
  })
  // 分层表也要跟着改（方向检查以 `rules.assignments` 为准，不是类型自带的 layer）
  office.writeMethodArtifact(call(), 'layers', {
    summary: '分层依赖规则',
    rules: {
      layers: ['domain', 'infrastructure'],
      assignments: { 对账服务: 'domain', 差异仓储: 'infrastructure', 差异记录表: 'infrastructure', 领域常量: 'infrastructure' },
      allowed: [{ from: 'domain', to: 'infrastructure' }],
    },
  })
  const violation = office.evaluate(call(), 'G3')
  assert.equal(hit(violation, consistencyId).ok, false, 'leaf 不豁免分层方向：违规方向必须仍判红')
  assert.match(hit(violation, consistencyId).detail, /方向违规/u, `理由必须是方向违规：${hit(violation, consistencyId).detail}`)
})

// —————————————————————— F-15 ——————————————————————

test('F-15 线框堆叠方向：显式 vertical / horizontal 形状不同，缺省按 vertical 且注明来源', () => {
  const screenBase = {
    id: 'SCR-001',
    name: '差异清单',
    columns: [{ name: '编号', kind: 'text' }, { name: '状态', kind: 'badge' }],
    layout: { grid: '单列纵向堆叠', regions: ['页头', '清单'] },
    interactions: [] as string[],
    states: {} as Record<string, string>,
    requires: [] as string[],
  }
  const parse = (layout: Record<string, unknown>): ReturnType<typeof parseUiViewInput> =>
    parseUiViewInput(JSON.stringify({ style: { source: 'minimal' }, screens: [{ ...screenBase, layout }] }))

  // ① 解析：缺省保持缺省；显式逐字保留；非法取值当面报错（不静默丢弃、也不去猜 grid 自由文本）
  const dflt = parse(screenBase.layout)
  assert.ok('view' in dflt, `合法输入必须解析成功：${'error' in dflt ? dflt.error : ''}`)
  if (!('view' in dflt)) return
  assert.equal(dflt.view.screens[0]?.layout.stack, undefined, '未声明时 stack 必须保持缺省（不凭空补值）')
  assert.equal(dflt.view.screens[0]?.layout.grid, '单列纵向堆叠', '自由文本 grid 原样保留')

  const explicit = parse({ ...screenBase.layout, stack: 'horizontal' })
  assert.ok('view' in explicit)
  if (!('view' in explicit)) return
  assert.equal(explicit.view.screens[0]?.layout.stack, 'horizontal', '显式方向必须逐字落盘')

  const illegal = parse({ ...screenBase.layout, stack: 'diagonal' })
  assert.ok('error' in illegal, '非法 stack 必须报错（不许静默忽略）')
  if ('error' in illegal) {
    assert.ok(illegal.error.includes('vertical') && illegal.error.includes('horizontal'), `必须列出合法取值：${illegal.error}`)
    assert.ok(illegal.error.includes('diagonal'), `必须点名非法取值：${illegal.error}`)
  }

  // ② 渲染（真实入口：writeUiView + renderDesign）：两方向形状不同、来源注记不同
  const { office: o2, ws } = makeProject('f15')
  o2.init(call(), { name: 'F15', scale: 'normal', stakeholders: ['业务方'], surfaces: ['web'] })
  const renderWith = (stack: 'vertical' | 'horizontal' | undefined): string => {
    const view: UiView = {
      id: 'UI-001',
      style: { source: 'minimal', tokens: {}, rationale: '' },
      screens: [{ ...screenBase, layout: { ...screenBase.layout, ...(stack === undefined ? {} : { stack }) } }],
      breakpoints: [],
      accessibility: { contrast: '', keyboard: false, screenReader: '' },
      updatedAt: '',
    }
    o2.writeUiView(call(), view)
    o2.renderDesign(call())
    const doc = readFileSync(join(ws, 'docs', 'DESIGN.md'), 'utf8')
    return doc.slice(doc.indexOf(t('uiDesign.docWireframe')), doc.indexOf('## 8. '))
  }
  const verticalText = renderWith('vertical')
  const horizontalText = renderWith('horizontal')
  const defaultText = renderWith(undefined)

  const boxesOf = (text: string): string[] =>
    text.split('\n').filter((line) => line.includes('┌') || line.includes('│') || line.includes('└'))
  assert.notDeepEqual(boxesOf(verticalText), boxesOf(horizontalText), 'vertical 与 horizontal 的线框形状必须不同')
  // 纵向：区域自上而下堆叠 → 存在"一行只有一个框角"的行
  assert.ok(boxesOf(verticalText).some((line) => (line.match(/┌/gu) ?? []).length === 1), `纵向渲染必须存在单框行：\n${verticalText}`)
  // 横向：区域并排 → 存在"一行里有多个框角"的行
  assert.ok(boxesOf(horizontalText).some((line) => (line.match(/┌/gu) ?? []).length >= 2), `横向渲染必须存在并排多框行：\n${horizontalText}`)

  // ③ 方向来源必须写明：声明 / 缺省
  assert.ok(verticalText.includes(fmt('uiDesign.docWireframeStackDeclared', { p1: 'vertical' })), '显式 vertical 必须注明"声明"')
  assert.ok(horizontalText.includes(fmt('uiDesign.docWireframeStackDeclared', { p1: 'horizontal' })), '显式 horizontal 必须注明"声明"')
  assert.ok(defaultText.includes(t('uiDesign.docWireframeStackDefault')), '缺省必须注明"缺省（按纵向）"')
  assert.equal(defaultText.includes(fmt('uiDesign.docWireframeStackDeclared', { p1: 'vertical' })), false, '缺省不得冒充"显式声明"')
  // 缺省 = 纵向（报告实测的 grid 文本就是单列纵向堆叠）→ 形状必须与显式 vertical 一致
  assert.deepEqual(boxesOf(defaultText), boxesOf(verticalText), '缺省方向的形状必须与显式 vertical 一致')
  assert.notDeepEqual(boxesOf(defaultText), boxesOf(horizontalText), '缺省方向不得画成并排（那就是 F-15 的缺陷）')
})

// —————————————————————— F-12 ——————————————————————

test('F-12 C-25 文案与判据同口径：zh / en 都写 11 章，且判据真的按 11 章校验', () => {
  assert.equal(DESIGN_DOC_SECTIONS.length, 11, '固定章节必须就是 11 章（判据与文案的共同真源）')
  const zh = readFileSync(join(ROOT, 'src/data/lang/zh-CN.yml'), 'utf8')
  const en = readFileSync(join(ROOT, 'src/data/lang/en.yml'), 'utf8')
  for (const [label, text] of [['zh-CN', zh], ['en', en]] as const) {
    assert.equal(/9\s*个固定章节|nine fixed sections|9 fixed sections/u.test(text), false, `${label} 里不得再有"9 章"的过时说法`)
  }
  assert.ok(t('uiGates.kDesignDoc').includes('11'), `成功文案必须说 11 章：${t('uiGates.kDesignDoc')}`)
  assert.ok(readFileSync(join(ROOT, 'src/domain/gates.ts'), 'utf8').includes('11 个固定章节'), 'gates.ts 的判据注释必须与实现同口径')

  // 判据行为自证：11 章齐 → 绿；删掉任一章 → 红并点名
  const { office: o, ws } = makeProject('f12')
  baselineRequirement(o, 'F12')
  o.renderDesign(call())
  const docId = checkId(o.process(call()), 'G3', 'design.doc')
  assert.equal(hit(o.evaluate(call(), 'G3'), docId).ok, true, `11 章齐全必须判绿：${hit(o.evaluate(call(), 'G3'), docId).detail}`)
  const path = join(ws, 'docs', 'DESIGN.md')
  const text = readFileSync(path, 'utf8')
  const section = t(DESIGN_DOC_SECTIONS[2]!)
  assert.ok(text.includes(`## 3. ${section}`), `前置：渲染产物里必须有第 3 章「${section}」`)
  writeFileSync(path, text.replace(`## 3. ${section}`, '## 3. 被删掉的章节名'), 'utf8')
  const red = o.evaluate(call(), 'G3')
  assert.equal(hit(red, docId).ok, false, '缺一章必须判红')
  assert.ok(hit(red, docId).detail.includes(section), `理由必须点名缺的那一章：${hit(red, docId).detail}`)
})

// —————————————————————— F-10 ——————————————————————

test('F-10 artifactData 形状：正确形状计入条数；错误形状点名被忽略的字段且不落半成品', () => {
  baselineRequirement()
  const layersFile = join(workspace, '.sdo/design/method-layers.yml')
  const rules = {
    layers: ['domain', 'infrastructure'],
    assignments: { 对账服务: 'domain', 差异仓储: 'infrastructure' },
    allowed: [{ from: 'domain', to: 'infrastructure' }],
  }

  // ① 正确形状（正文嵌在 `rules` 下）→ 真的写入，并报出条数
  const ok = designInteraction(office, call(), 'artifact', {
    action: 'artifact',
    artifactKind: 'layers',
    artifactData: JSON.stringify({ summary: '分层规则', rules }),
  } as DesignArgs)
  assert.ok(ok.includes(fmt('uiMethod.artifactOk', { p1: t('uiMethod.prodLayers'), p2: '1' })), `正确形状必须报"1 条"：${ok}`)
  assert.ok(existsSync(layersFile), '正确形状必须落盘')
  assert.deepEqual(office.methodArtifacts(call()).find((item) => item.kind === 'layers')?.rules?.allowed, rules.allowed)

  // ② 正确形状 + 未知字段（顶层 `mystery` 与 `rules` 里嵌错的 `baz`）→ 仍然写入，
  //    但**必须点名**被忽略的字段（绝不静默）
  const partial = designInteraction(office, call(), 'artifact', {
    action: 'artifact',
    artifactKind: 'layers',
    artifactData: JSON.stringify({ summary: '分层规则', rules: { ...rules, baz: 1 }, mystery: 1 }),
  } as DesignArgs)
  assert.ok(partial.includes(fmt('uiMethod.artifactOk', { p1: t('uiMethod.prodLayers'), p2: '1' })), `有正文时仍应写入：${partial}`)
  assert.ok(partial.includes('mystery'), `顶层被忽略的字段必须点名：${partial}`)
  assert.ok(partial.includes('rules.baz'), `对象型正文里嵌错的下级字段也必须点名：${partial}`)
  assert.ok(partial.includes('rules'), `必须给出本 kind 期望的字段：${partial}`)

  // ③ 错误形状（把 layers/assignments/allowed 写在顶层 —— 报告 F-10 的复现形态）→
  //    点名被忽略的字段，且**不落半成品**
  const fresh = makeProject('f10-错误形状')
  baselineRequirement(fresh.office, 'F10-错误形状')
  const freshFile = join(fresh.ws, '.sdo/design/method-layers.yml')
  const wrong = designInteraction(fresh.office, call(), 'artifact', {
    action: 'artifact',
    artifactKind: 'layers',
    artifactData: JSON.stringify({ summary: '分层规则', layers: rules.layers, assignments: rules.assignments, allowed: rules.allowed }),
  } as DesignArgs)
  for (const field of ['layers', 'assignments', 'allowed']) {
    assert.ok(wrong.includes(field), `被忽略的字段 ${field} 必须点名：${wrong}`)
  }
  assert.ok(wrong.includes('rules'), `必须给出本 kind 期望的字段 rules：${wrong}`)
  assert.equal(existsSync(freshFile), false, '错误形状不得落半成品（method-layers.yml 不许出现）')
  assert.equal(fresh.office.methodArtifacts(call()).some((item) => item.kind === 'layers'), false, '真源里不得留下空壳产物')

  // ④ 形状必须**文档化**（模型不必读源码）：工具参数描述里逐 kind 列出正文字段
  const doc = t('param.designArtifactData')
  for (const piece of ['dictionary', 'levels', 'types', 'rules', 'debts', 'decisions', 'increments', 'leaf:true']) {
    assert.ok(doc.includes(piece), `artifactData 的形状说明必须覆盖 ${piece}：${doc}`)
  }
  assert.ok(t('param.designUi').includes('stack'), 'ui 参数描述必须文档化 layout.stack')
})
