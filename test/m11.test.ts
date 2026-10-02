/**
 * 增量 2：设计方法论**方法包**（结构化 / 面向对象 / 敏捷-演进式）。
 *
 * 覆盖实施规格 §7 的五项验收，且**每一项都双向**：
 *   ① 选 structured 但缺数据字典 → `design.method-products` 失败；补齐 → 通过；
 *      未选的 oo / evolutionary 判据为 **N/A 且 ok === false**；
 *   ② 选择题未回答 / 答案非法 → `design.method-selected` 失败；显式 none → 通过且 products N/A + 理由；
 *   ③ 组合 structured + oo → 两套最小必产项都必需（缺任一即失败）；evolutionary 为 N/A；
 *   ④ `design.method-consistency`：类清单引用不存在的数据项 → 失败；补上数据字典 → 通过；
 *   ⑤ DFD 父子平衡：子层多出一个流 → 失败；删除后 → 通过。
 *
 * 另外守住「堵漏洞」的立场：**不选方法不能蒙过去**（未回答/空/无法解析一律判失败），
 * 以及检查器是机械的（只读真源，不采信模型自述）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { DESIGN_DOC_SECTIONS } from '../src/domain/design.js'
import { t } from '../src/domain/i18n.js'
import { designInteraction } from '../src/interface/designReceipt.js'
import { describeGate } from '../src/interface/describe.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { SdoConfig } from '../src/config.js'
import type { GateCriterionResult, GateEvaluation, ProcessDef } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m11/', import.meta.url))
const ALL2 = { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 }
const call = (): { sessionId: string } => ({ sessionId: 's1' })

let workspace: string
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), { name: 'M11 测试', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call(), {
    scopeIn: ['对账'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['识别率 ≥ 99%'],
    glossary: { 差异: '不一致记录' },
  })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 造一条已基线需求（与 m8 同一套前置，保证 must 需求存在）。 */
function baselineRequirement(): string {
  office.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  office.logRisk(call(), {
    title: '格式变更',
    level: 'low',
    probability: 'low',
    impact: '小',
    mitigation: '校验',
    owner: '业务方',
  })
  const captured = office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    kind: 'functional',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call(), {
    id: captured.requirement.id,
    addAcceptance: [{ id: 'AC-001', given: '已导入两日文件', when: '执行对账', then: '输出差异清单' }],
    modelDimensions: ALL2,
  })
  // **§7.2 时机迁移**：规划级设计问题（方法论选择题）在**需求阶段**提出，
  // 且**故意不在这里回答** —— 由每个用例自己驱动"未回答 → 红 / 回答 → 绿"。
  // 因此它必须是 P1（G2 允许 ≤2 条 P1 未决），否则这条基线前置会先被它卡住。
  office.askDesignQuestions(call(), { recommendation: { method: '结构化', rationale: '需求稳定' } })
  office.redTeamAttack(call(), [captured.requirement.id], 7)
  let guard = 0
  while (guard++ < 40) {
    const open = office.questions(call()).filter((question) => question.status === 'open')
    const pending = open.filter((question) => !question.targets.includes('design:method'))
    if (pending.length === 0) break
    office.answer(call(), { id: pending[0]!.id, answer: '已确认', modelDimensions: ALL2 })
  }
  // D1 + D4：未决 P1 补风险处置，再签 G2 字（放行依据是签字台账）
  prepareG2(office, call())
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `基线应通过：${outcome.dor.failed.join(',')}`)
  return captured.requirement.id
}

/** 提出设计问题（含方法论选择题）。 */
function grill(): void {
  office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '需求稳定' } })
}

/** 方法论选择题的 id（需求阶段已提出；可能在 open，也可能已被答过）。 */
function methodId(): string {
  const issues = office.designIssues(call())
  const question = [...issues.open, ...issues.closed].find((item) => item.targets.includes('design:method'))
  assert.ok(question !== undefined, '必须有方法论选择题')
  return question.id
}

/** 回答方法论选择题（`choice` 可以是下标、选项原文或自定义组合）。 */
function answerMethod(choice: string): void {
  const id = methodId()
  office.answerDesign(call(), id, choice, '测试选择')
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

/** 结构化最小必产项：数据字典（`extra` 可加一条数据项）。 */
function writeDictionary(requirementId: string, extra?: string): void {
  office.writeMethodArtifact(call(), 'dictionary', {
    summary: '对账差异数据字典',
    dictionary: [
      { name: '对账文件', type: 'file', source: '上游系统', sink: '对账系统', validation: '非空且格式合法', requires: [requirementId] },
      { name: '差异清单', type: 'record[]', source: '对账系统', sink: '业务方', validation: '每条含差异 id', requires: [requirementId] },
      ...(extra === undefined
        ? []
        : [{ name: extra, type: 'text', source: '上游系统', sink: '对账系统', validation: '非空', requires: [requirementId] }]),
    ],
  })
}

/** 分层 DFD（`extraChildFlow` 为真时故意让子层多出一个流 → 父子不平衡）。 */
function writeDfd(requirementId: string, extraChildFlow = false): void {
  const parentFlows = [
    { name: '对账文件', from: '上游系统', to: '对账系统' },
    { name: '差异清单', from: '对账系统', to: '业务方' },
  ]
  office.writeMethodArtifact(call(), 'dfd', {
    summary: '对账分层数据流图',
    levels: [
      {
        level: 0,
        name: '上下文层',
        flows: parentFlows,
        processes: [{ name: '对账系统', inputs: ['对账文件'], outputs: ['差异清单'], requires: [requirementId] }],
      },
      {
        level: 1,
        name: '分解层',
        flows: [
          { name: '对账文件', from: '上游系统', to: '差异检测服务' },
          { name: '差异清单', from: '差异检测服务', to: '业务方' },
          ...(extraChildFlow ? [{ name: '凭空多出的流', from: '差异检测服务', to: '外部系统' }] : []),
        ],
        processes: [{ name: '差异检测服务', inputs: ['对账文件'], outputs: ['差异清单'], requires: [requirementId] }],
      },
    ],
  })
}

function writeErd(requirementId: string): void {
  office.writeMethodArtifact(call(), 'erd', {
    summary: '对账差异 ERD',
    entities: [
      { name: '对账批次', identifier: '批次ID', requires: [requirementId] },
      { name: '对账差异', identifier: '差异ID', requires: [requirementId] },
    ],
    relations: [{ name: '批次含差异', from: '对账批次', to: '对账差异', cardinality: '1:N' }],
  })
}

/** 结构化包的齐备产物（字典 + 平衡的 DFD + ERD）。 */
function structuredProducts(requirementId: string): void {
  writeDictionary(requirementId)
  writeDfd(requirementId)
  writeErd(requirementId)
}

/** 面向对象包的齐备产物（类与职责 + 时序 + 依赖规则），`ghostData` 用来造一个悬空数据项。 */
function ooProducts(requirementId: string, ghostData?: string): void {
  office.writeMethodArtifact(call(), 'classes', {
    summary: '对账领域类型',
    types: [
      {
        name: '对账服务',
        kind: 'class',
        layer: 'domain',
        responsibility: '检测对账差异',
        collaborators: ['差异仓储'],
        ...(ghostData === undefined ? {} : { data: [ghostData] }),
        requires: [requirementId],
      },
      { name: '差异仓储', kind: 'interface', layer: 'infrastructure', responsibility: '存取差异记录', collaborators: ['差异记录表'], requires: [requirementId] },
      { name: '差异记录表', kind: 'class', layer: 'infrastructure', responsibility: '承载差异记录', collaborators: ['差异仓储'], requires: [requirementId] },
    ],
  })
  office.writeMethodArtifact(call(), 'sequences', {
    summary: '关键用例时序',
    sequences: [
      {
        name: '每日检测差异',
        requirement: requirementId,
        participants: ['对账服务', '差异仓储'],
        messages: [{ name: '查询差异', from: '对账服务', to: '差异仓储', trigger: '每日批处理开始' }],
        requires: [requirementId],
      },
    ],
  })
  office.writeMethodArtifact(call(), 'layers', {
    summary: '分层依赖规则',
    rules: {
      layers: ['domain', 'infrastructure'],
      assignments: { 对账服务: 'domain', 差异仓储: 'infrastructure', 差异记录表: 'infrastructure' },
      allowed: [{ from: 'domain', to: 'infrastructure' }],
      requires: [requirementId],
    },
  })
}

function packageOf(id: 'structured' | 'oo' | 'evolutionary'): ReturnType<SoftwareDevOffice['methodProducts']>['packages'][number] {
  const found = office.methodProducts(call()).packages.find((item) => item.id === id)
  assert.ok(found !== undefined, `packages 必须有 ${id}`)
  return found
}

// —————————————————————— ① 选 structured：缺数据字典失败 → 补齐通过；未选包 N/A ——————————————————————

test('M11-01 选 structured 缺数据字典 → 失败；补齐 → 通过；未选的 oo/evolutionary 为 N/A 且 ok===false', () => {
  const requirementId = baselineRequirement()
  grill()
  answerMethod('0') // 第 0 个选项 = structured

  const process = office.process(call())
  const productsId = checkId(process, 'G3', 'design.method-products')

  // ① 还没有任何产物 → 失败
  const before = office.evaluate(call(), 'G3')
  assert.equal(hit(before, productsId).ok, false, '没有任何方法产物时 method-products 必须为红')
  assert.equal(hit(before, productsId).na, undefined, '已选 structured 时不允许退化成 N/A')

  // ② 只补 ERD + DFD、故意不写数据字典 → 仍然失败，且理由指向数据字典
  writeDfd(requirementId)
  writeErd(requirementId)
  const noDict = office.evaluate(call(), 'G3')
  assert.equal(hit(noDict, productsId).ok, false, '缺数据字典时仍必须为红')
  assert.match(hit(noDict, productsId).detail, /数据字典/u, '理由必须点名缺数据字典')

  // ③ 补上数据字典 → 通过
  writeDictionary(requirementId)
  const after = office.evaluate(call(), 'G3')
  assert.equal(hit(after, productsId).ok, true, `补齐后必须为绿：${hit(after, productsId).detail}`)
  assert.equal(hit(after, productsId).na, undefined)

  // ④ 未选的包：N/A 且 ok===false（既不失败也不算通过），理由写明未选
  const oo = packageOf('oo')
  const evolutionary = packageOf('evolutionary')
  for (const [name, check] of [['oo', oo], ['evolutionary', evolutionary]] as const) {
    assert.equal(check.selected, false, `${name} 不应被选中`)
    assert.equal(check.na, true, `${name} 必须是 N/A`)
    assert.equal(check.ok, false, `${name} 的 N/A 绝不能被算成通过`)
    assert.ok((check.naReason ?? '').trim() !== '', `${name} 的 N/A 必须带理由`)
    assert.match(check.naReason ?? '', /结构化/u, `${name} 的 N/A 理由要写明本项目选择了什么`)
  }
  // 选中包的判定结果确实来自机械检查（有 ok 且有 selected）
  assert.equal(packageOf('structured').selected, true)
  assert.equal(packageOf('structured').ok, true)
})

// —————————————————————— ② 未回答/非法 → method-selected 失败；none → 通过 + products N/A ——————————————————————

test('M11-02 方法题未回答/答案非法 → design.method-selected 失败；显式 none → 通过且 products 为 N/A + 理由', () => {
  baselineRequirement()
  grill()
  const id = methodId()

  const process = office.process(call())
  const selectedId = checkId(process, 'G3', 'design.method-selected')
  const productsId = checkId(process, 'G3', 'design.method-products')

  // ① 未回答 → 失败（堵漏洞：不选不能蒙过去）
  const unanswered = office.evaluate(call(), 'G3')
  assert.equal(hit(unanswered, selectedId).ok, false, '未回答时 method-selected 必须为红')
  assert.equal(hit(unanswered, selectedId).na, undefined, '未回答不允许是 N/A')
  assert.equal(hit(unanswered, productsId).ok, false, '方法未定时 products 也必须为红（查不到不算过）')

  // ② 空答复 → 仍失败（answerDesign 缺 choice 时由回执层拦住；这里直接写空答案验证判定）
  office.answerDesign(call(), id, '   ', '空答复')
  assert.equal(hit(office.evaluate(call(), 'G3'), selectedId).ok, false, '空答案必须判红')

  // ③ 无法解析的答复 → 失败
  office.answerDesign(call(), id, '随便挑一个吧', '非法答复')
  const invalid = office.evaluate(call(), 'G3')
  assert.equal(hit(invalid, selectedId).ok, false, '无法解析的答案必须判红')
  assert.equal(office.methodSelection(call()).status, 'invalid')

  // ④ 显式 none → method-selected 通过；products 为 N/A + 理由
  office.answerDesign(call(), id, 'none', '本项目不做方法产物')
  const none = office.evaluate(call(), 'G3')
  assert.equal(hit(none, selectedId).ok, true, '显式 none 必须通过')
  const products = hit(none, productsId)
  assert.equal(products.na, true, '显式 none 时 products 必须是 N/A')
  assert.equal(products.ok, false, 'N/A 绝不能被算成通过')
  assert.ok((products.naReason ?? '').trim() !== '', 'N/A 必须带理由')
  // 逐包也都是 N/A（含理由）
  for (const check of office.methodProducts(call()).packages) {
    assert.equal(check.na, true, `${check.id} 在 none 下必须是 N/A`)
    assert.equal(check.ok, false)
    assert.ok((check.naReason ?? '').trim() !== '')
  }
})

test('M11-02b 组合答案与显式 none 冲突 → 非法（判失败），不允许"既不做又做了"', () => {
  baselineRequirement()
  grill()
  answerMethod('none+structured')
  const process = office.process(call())
  const selectedId = checkId(process, 'G3', 'design.method-selected')
  assert.equal(office.methodSelection(call()).status, 'invalid', 'none 与其他包同时出现必须判非法')
  assert.equal(hit(office.evaluate(call(), 'G3'), selectedId).ok, false)
})

// —————————————————————— ③ 组合 structured + oo：两套都必需；evolutionary N/A ——————————————————————

test('M11-03 组合 structured + oo：两套最小必产项都必需（缺任一即失败），evolutionary 为 N/A', () => {
  const requirementId = baselineRequirement()
  grill()
  answerMethod('structured+oo')
  const selection = office.methodSelection(call())
  assert.equal(selection.status, 'chosen')
  assert.deepEqual([...selection.methods].sort(), ['oo', 'structured'])

  const process = office.process(call())
  const productsId = checkId(process, 'G3', 'design.method-products')

  // 只补结构化 → 仍失败（缺面向对象那套）
  structuredProducts(requirementId)
  const onlyStructured = office.evaluate(call(), 'G3')
  assert.equal(hit(onlyStructured, productsId).ok, false, '缺 oo 那套时必须为红')
  assert.match(hit(onlyStructured, productsId).detail, /面向对象/u, '理由要点名缺的是哪一套')

  // 再补面向对象 → 通过
  ooProducts(requirementId)
  const both = office.evaluate(call(), 'G3')
  assert.equal(hit(both, productsId).ok, true, `两套齐备后必须为绿：${hit(both, productsId).detail}`)

  // evolutionary 未选 → N/A
  const evolutionary = packageOf('evolutionary')
  assert.equal(evolutionary.na, true)
  assert.equal(evolutionary.ok, false)
  assert.ok((evolutionary.naReason ?? '').includes('结构化') || (evolutionary.naReason ?? '').includes('面向对象'))
})

// —————————————————————— ④ 一致性：类清单引用不存在的数据项 ——————————————————————

test('M11-04 design.method-consistency：类清单引用不存在的数据项 → 失败；补上数据字典 → 通过', () => {
  const requirementId = baselineRequirement()
  grill()
  answerMethod('oo')
  const process = office.process(call())
  const consistencyId = checkId(process, 'G3', 'design.method-consistency')

  // 类型引用了数据字典里不存在的数据项
  ooProducts(requirementId, '幽灵数据项')
  const broken = office.evaluate(call(), 'G3')
  assert.equal(hit(broken, consistencyId).ok, false, '引用不存在的数据项必须判红')
  assert.match(hit(broken, consistencyId).detail, /幽灵数据项/u, '理由要点名那个悬空引用')

  // 修好：把该数据项补进数据字典 → 通过
  writeDictionary(requirementId, '幽灵数据项')
  const fixed = office.evaluate(call(), 'G3')
  assert.equal(hit(fixed, consistencyId).ok, true, `补上数据项后必须为绿：${hit(fixed, consistencyId).detail}`)
})

test('M11-04b 类清单的协作方必须解析到已登记类型（幽灵协作方 → 失败）', () => {
  const requirementId = baselineRequirement()
  grill()
  answerMethod('oo')
  ooProducts(requirementId)
  office.writeMethodArtifact(call(), 'classes', {
    types: [
      { name: '对账服务', kind: 'class', layer: 'domain', responsibility: '检测差异', collaborators: ['不存在的类型'], requires: [requirementId] },
    ],
  })
  const result = office.methodConsistency(call())
  assert.equal(result.ok, false, '协作方解析不到已登记类型时必须失败')
  assert.ok(result.problems.some((problem) => problem.includes('不存在的类型')))
})

// —————————————————————— ⑤ DFD 父子平衡 ——————————————————————

test('M11-05 DFD 父子平衡：子层多出一个流 → 失败；删除后 → 通过', () => {
  const requirementId = baselineRequirement()
  grill()
  answerMethod('structured')
  const process = office.process(call())
  const productsId = checkId(process, 'G3', 'design.method-products')

  writeDictionary(requirementId)
  writeErd(requirementId)
  // 子层凭空多出一个流（父层没有）→ 父子不平衡
  writeDfd(requirementId, true)
  const unbalanced = office.evaluate(call(), 'G3')
  assert.equal(hit(unbalanced, productsId).ok, false, '子层多出流时必须判红')
  assert.match(hit(unbalanced, productsId).detail, /凭空多出/u, '理由要写清是不平衡')

  // 删除那个流 → 平衡 → 通过
  writeDfd(requirementId, false)
  const balanced = office.evaluate(call(), 'G3')
  assert.equal(hit(balanced, productsId).ok, true, `平衡后必须为绿：${hit(balanced, productsId).detail}`)
})

// —————————————————————— 追加：追溯与工具路径 ——————————————————————

test('M11-06 无需求来源的方法产物条目由既有 trace.orphans 抓（不新造判据）', () => {
  const requirementId = baselineRequirement()
  office.writeMethodArtifact(call(), 'dictionary', {
    dictionary: [{ name: '无来源数据项', type: 'text', source: 'x', sink: 'y', validation: '非空' }],
  })
  assert.ok(office.traceReport(call()).orphans.design.length >= 1, '无来源的数据项必须被既有孤儿检查抓到')
  // 挂上来源后不再是孤儿
  office.writeMethodArtifact(call(), 'dictionary', {
    dictionary: [
      { name: '无来源数据项', type: 'text', source: 'x', sink: 'y', validation: '非空', requires: [requirementId] },
    ],
  })
  assert.equal(office.traceReport(call()).orphans.design.length, 0, '写了 requires 后不应再是孤儿')
})

test('M11-07 工具/命令同一条处理路径：action=method 只读回执、action=artifact 写入与可读报错', () => {
  baselineRequirement()
  grill()
  answerMethod('structured')

  // 只读回执：逐包显示
  const view = designInteraction(office, call(), 'method', { action: 'method' })
  assert.match(view, /结构化/u, '方法回执必须列出身包')
  assert.match(view, /未选择/u, '方法回执必须逐包显示未选择的包')

  // 写入：JSON 合法 → 成功回执
  const written = designInteraction(office, call(), 'artifact', {
    action: 'artifact',
    artifactKind: 'dictionary',
    artifactData: JSON.stringify({ dictionary: [{ name: '对账文件', type: 'file', source: '上游', sink: '对账', validation: '非空' }] }),
  })
  assert.match(written, /数据字典/u, '写入回执要点名产物种类')
  assert.equal(office.methodArtifacts(call()).some((artifact) => artifact.kind === 'dictionary'), true)

  // 未知种类 / 非法 JSON → 可读错误（不是抛异常）
  const unknown = designInteraction(office, call(), 'artifact', { action: 'artifact', artifactKind: 'nope', artifactData: '{}' })
  assert.match(unknown, /未知的方法产物种类/u)
  const badJson = designInteraction(office, call(), 'artifact', { action: 'artifact', artifactKind: 'dictionary', artifactData: '{不是 JSON' })
  assert.match(badJson, /必须.*JSON/u)
})

test('M11-08 docs/DESIGN.md 与方法回执：采用理由 + 各方法产物 + 未选包「不适用」；门禁回执逐包显示', () => {
  const requirementId = baselineRequirement()
  grill()
  answerMethod('structured')
  structuredProducts(requirementId)
  office.renderDesign(call())

  const doc = readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8')
  for (const key of DESIGN_DOC_SECTIONS) assert.ok(doc.includes(t(key)), `DESIGN.md 缺章节 ${key}`)
  assert.ok(doc.includes(t('uiDesign.docSMethod')), '必须有「设计方法与采用理由」章节')
  assert.ok(doc.includes(t('uiDesign.docSProducts')), '必须有「各方法产物」章节')
  assert.ok(doc.includes(t('uiMethod.pkgStructured')), '必须写出已选中的包')
  assert.ok(doc.includes(t('uiDesign.docProductNa')), '未选中的包必须写「不适用」，不得留空')
  assert.ok(doc.includes('对账文件'), '数据字典 / DFD 的条目要进文档')
  assert.ok(doc.includes('对账批次'), 'ERD 的实体要进文档')

  // 门禁回执逐包显示：已选包列缺项、未选包写 N/A + 理由
  const receipt = describeGate(office.evaluate(call(), 'G3'))
  assert.ok(receipt.includes(t('uiMethod.pkgStructured')), '回执必须显示结构化包')
  assert.ok(receipt.includes(t('uiMethod.pkgOo')), '回执必须逐包显示（面向对象）')
  assert.ok(receipt.includes(t('uiMethod.pkgEvolutionary')), '回执必须逐包显示（敏捷-演进式）')
  assert.ok(receipt.includes('未选择（本项目选择了'), '未选中的包必须显示 N/A + 理由（逐包）')
})

/** 敏捷-演进式包的齐备产物（技术债 + 可逆性 + 迭代增量）。 */
function evolutionaryProducts(requirementId: string, options: { irreversibleNoWhy?: boolean; ghostElement?: boolean } = {}): void {
  office.writeMethodArtifact(call(), 'debt', {
    summary: '技术债台账',
    debts: [
      { title: '批处理窗口硬编码', type: 'code', impact: '上游文件晚到会漏处理', trigger: '文件到达时间 SLA 稳定后', plan: '改为事件驱动', requires: [requirementId] },
    ],
  })
  office.writeMethodArtifact(call(), 'reversibility', {
    summary: '架构决策可逆性分级',
    decisions: [
      options.irreversibleNoWhy === true
        ? { decision: 'T+1 批处理', grade: 'irreversible', requires: [requirementId] }
        : { decision: 'T+1 批处理', grade: 'irreversible', whyNow: '上游只提供日终快照，无法流式', requires: [requirementId] },
      { decision: '单机部署', grade: 'reversible', requires: [requirementId] },
    ],
  })
  office.writeMethodArtifact(call(), 'increments', {
    summary: '本迭代设计增量',
    increments: [
      {
        iteration: '迭代 1',
        elements: [options.ghostElement === true ? '不存在元素' : '差异检测服务'],
        note: '新增差异检测服务',
        requires: [requirementId],
      },
    ],
  })
}

test('M11-09 敏捷-演进式包：技术债字段/不可逆理由/设计增量引用都是机械检查（双向）', () => {
  const requirementId = baselineRequirement()
  office.upsertElement(call(), { kind: 'component', name: '差异检测服务' })
  grill()
  answerMethod('evolutionary')
  assert.deepEqual(office.methodSelection(call()).methods, ['evolutionary'])

  const process = office.process(call())
  const productsId = checkId(process, 'G3', 'design.method-products')
  const consistencyId = checkId(process, 'G3', 'design.method-consistency')

  // ① 不可逆决策没写"为何现在必须定" → 失败
  evolutionaryProducts(requirementId, { irreversibleNoWhy: true })
  const noWhy = office.evaluate(call(), 'G3')
  assert.equal(hit(noWhy, productsId).ok, false, '不可逆决策缺理由必须判红')
  assert.match(hit(noWhy, productsId).detail, /为何现在必须定/u)

  // ② 补上理由 → 通过
  evolutionaryProducts(requirementId)
  const fixed = office.evaluate(call(), 'G3')
  assert.equal(hit(fixed, productsId).ok, true, `补齐后必须为绿：${hit(fixed, productsId).detail}`)
  assert.equal(hit(fixed, consistencyId).ok, true, `引用真实元素时必须一致：${hit(fixed, consistencyId).detail}`)

  // ③ 设计增量引用不存在的元素 → 一致性失败；改回真实元素 → 通过
  evolutionaryProducts(requirementId, { ghostElement: true })
  const ghost = office.evaluate(call(), 'G3')
  assert.equal(hit(ghost, consistencyId).ok, false, '设计增量引用不存在元素必须判红')
  assert.match(hit(ghost, consistencyId).detail, /不存在元素/u)
  evolutionaryProducts(requirementId)
  assert.equal(hit(office.evaluate(call(), 'G3'), consistencyId).ok, true)
})
