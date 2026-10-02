import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SdoStore } from '../src/infra/store.js'
import { writeMethodDoc } from './support/method-doc-fixture.js'
import { adrCompleteness } from '../src/domain/adr.js'
import { viewsCompleteness } from '../src/domain/architecture.js'
import { contractCoverage } from '../src/domain/contracts.js'
import { isMeasurable, unmeasurableScenarios } from '../src/domain/quality.js'
import { link, report } from '../src/domain/trace.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { SdoConfig } from '../src/config.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m2/', import.meta.url))
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
  office.init(call(), { name: 'M2 测试', scale: 'normal', stakeholders: ['业务方'] })
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

/** 造一条已基线需求（G2 通过），供"设计前置"的正例使用。 */
function baselineReadyRequirement(): void {
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
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call(), {
    id: captured.requirement.id,
    addAcceptance: [{ id: 'AC-001', given: '已导入两日文件', when: '执行对账', then: '输出差异清单' }],
    modelDimensions: ALL2,
  })
  office.redTeamAttack(call(), [captured.requirement.id], 7)
  let guard = 0
  while (guard++ < 40) {
    const open = office.questions(call()).filter((question) => question.status === 'open')
    if (open.length === 0) break
    office.answer(call(), { id: open[0]!.id, answer: '已确认', modelDimensions: ALL2 })
  }
  // D1 + D4：未决 P1 补风险处置，再签 G2 字（放行依据是签字台账）
  prepareG2(office, call())
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `基线应通过：${outcome.dor.failed.join(',')}`)
}

/**
 * 补齐**结构化方法包的最小必产项**（增量 2：选了 structured 就必须有数据字典 + 分层 DFD + ERD）。
 *
 * 顺带满足两条机械检查：
 *   · 数据字典覆盖 DFD 上出现的每一个流名；
 *   · 条目都带 `requires`（无来源条目会被既有 `trace.orphans` 抓成孤儿）。
 */
function structuredMethodProducts(requirementId: string): void {
  office.writeMethodArtifact(call(), 'dictionary', {
    summary: '对账差异数据字典',
    dictionary: [
      { name: '对账文件', type: 'file', source: '上游系统', sink: '对账系统', validation: '非空且格式合法', requires: [requirementId] },
      { name: '差异清单', type: 'record[]', source: '对账系统', sink: '业务方', validation: '每条含差异 id', requires: [requirementId] },
    ],
  })
  office.writeMethodArtifact(call(), 'dfd', {
    summary: '对账分层数据流图',
    levels: [
      {
        level: 0,
        name: '上下文层',
        flows: [
          { name: '对账文件', from: '上游系统', to: '对账系统' },
          { name: '差异清单', from: '对账系统', to: '业务方' },
        ],
        processes: [{ name: '对账系统', inputs: ['对账文件'], outputs: ['差异清单'], requires: [requirementId] }],
      },
      {
        level: 1,
        name: '分解层',
        flows: [
          { name: '对账文件', from: '上游系统', to: '差异检测服务' },
          { name: '差异清单', from: '差异检测服务', to: '业务方' },
        ],
        processes: [{ name: '差异检测服务', inputs: ['对账文件'], outputs: ['差异清单'], requires: [requirementId] }],
      },
    ],
  })
  office.writeMethodArtifact(call(), 'erd', {
    summary: '对账差异 ERD',
    entities: [
      { name: '对账批次', identifier: '批次ID', requires: [requirementId] },
      { name: '对账差异', identifier: '差异ID', requires: [requirementId] },
    ],
    relations: [{ name: '批次含差异', from: '对账批次', to: '对账差异', cardinality: '1:N' }],
  })
  // 新口径：选中 structured 就必须有与人审文档（且指纹与台账一致）
  writeMethodDoc(workspace, new SdoStore(join(workspace, '.sdo')), 'structured')

}

/**
 * 走完**增量 1 的设计交互闭环**（增量 1 起 G3 会拦"没和用户交流过的设计"）：
 * 提出问题 → 回答问题 → 生成设计文档 → 逐条确认关键条目。
 * 因此"G3 全绿"的正例必须把这几步真的做掉，而不是只写五视图。
 *
 * **增量 2**：方法题答"结构化"后，还要补齐结构化包的最小必产项（否则 `design.method-products` 是红的）。
 */
function completeDesignInteraction(requirementId: string): void {
  const grilled = office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '需求明确' } })
  // 每个缺口都给一个答复（选项下标 + 说明）
  for (const id of grilled.stillOpen) office.answerDesign(call(), id, '0', '按推荐')
  structuredMethodProducts(requirementId)
  office.renderDesign(call())
  for (const target of office.designConfirmGaps(call()).required) {
    office.confirmDesign(call(), target, '用户在会话中确认', '张三')
  }
  // **§7.1 / §7.2**：声明适用性 + 用户签字绑定 + G3 门禁级签字（必须在所有真源写入**之后**签，
  // 否则签字会被"签字后真源变更"规则判失效）
  declareApplicability()
}


/**
 * **§7.1 / §7.2 前置**：声明设计适用性 + 用户签字绑定 + G3 门禁级签字。
 *
 * 2026-09-30 起 G3 多两道硬门：① 必须有适用性声明（存量项目缺声明即红）；
 * ② 必须有**带引用文本**的用户签字。因此"G3 全绿"的正例必须真的走完这两步。
 *
 * 固定声明"五视图全做、无额外工件"（本文件的正例都是五视图齐备的形态）。
 */
function declareApplicability(sign = true): void {
  office.draftApplicability(call(), {
    focus: '对账系统新建：五视图全做，无额外非视图工件',
    viewsPresent: ['context', 'component', 'runtime', 'data', 'deployment'],
    viewsAbsent: [],
    artifacts: [],
    by: '模型起草',
  })
  office.confirmApplicability(call(), '同意就按这份声明走', '张三')
  if (sign) office.signGate(call(), { gate: 'G3', by: '张三', basis: '我签字确认这次设计可以放行', channel: 'command' })
  // X-1：C-25 要求文档不早于最后一次真源变更；声明（含其确认）也是文档真源 → 重渲染。
  office.renderDesign(call())
}

test('五视图：齐备性检查与 G3 的 design.views 准则', () => {
  setup5: {
    assert.equal(viewsCompleteness(office.storeFor(workspace)).ok, false)
  }
  for (const [kind, name] of [
    ['context', '对账系统'],
    ['component', '差异检测服务'],
    ['runtime', '夜间批处理'],
    ['data', '对账差异表'],
    ['deployment', '单机部署'],
  ] as const) {
    office.upsertElement(call(), { kind, name, responsibility: `${name} 的职责` })
  }
  const completeness = viewsCompleteness(office.storeFor(workspace))
  assert.equal(completeness.ok, true, `五视图应齐备：${JSON.stringify(completeness)}`)
  assert.equal(office.views(call()).length, 5)

  // **§7.1**：声明适用性（五视图全做）——`design.views` 现在按声明逐视图判真
  declareApplicability()
  const g3 = office.evaluate(call(), 'G3')
  assert.equal(g3.criteria.find((criterion) => criterion.id === 'C-20')?.ok, true)
  assert.equal(g3.criteria.find((criterion) => criterion.id === 'C-2D')?.ok, true, '签字后门禁级签字判据必须为绿')
})

test('设计元素：DependsOn 边驱动契约完整性（G4 的 design.contracts）', () => {
  office.upsertElement(call(), { kind: 'component', name: 'API 网关' })
  office.upsertElement(call(), { kind: 'component', name: '差异检测服务', dependsOn: ['对账文件存储'] })
  office.upsertElement(call(), { kind: 'data', name: '对账文件存储' })

  const before = contractCoverage(office.storeFor(workspace))
  assert.equal(before.totalEdges, 1)
  assert.equal(before.missing.length, 1, '缺契约应被指出')
  assert.equal(office.evaluate(call(), 'G4').criteria.find((c) => c.id === 'C-30')?.ok, false)

  office.recordContract(call(), {
    name: '差异检测服务 → 对账文件存储',
    kind: 'schema',
    producer: '对账文件存储',
    consumer: '差异检测服务',
    schema: 'records: [{id, amount, status}]',
    failureSemantics: { timeout: '3s 超时后重试一次', retry: '指数退避 3 次', idempotency: '按 (日期, 记录 ID) 幂等' },
  })
  const after = contractCoverage(office.storeFor(workspace))
  assert.equal(after.ok, true, `契约应齐备：${JSON.stringify(after)}`)
  assert.equal(office.evaluate(call(), 'G4').criteria.find((c) => c.id === 'C-30')?.ok, true)

  // 失败语义不全 → 仍不通过
  office.recordContract(call(), {
    name: '缺语义',
    producer: 'a',
    consumer: 'b',
    schema: 'x',
  })
  assert.ok(contractCoverage(office.storeFor(workspace)).incompleteSemantics.length >= 1)
})

test('ADR：没有备选或后果的决策不算 ADR（G3 的 design.adr）', () => {
  assert.equal(adrCompleteness(office.storeFor(workspace)).ok, false, '一条 ADR 都没有时不算通过')

  office.recordAdr(call(), {
    title: '批处理 vs 流式',
    context: '对账窗口未知，两种方案成本差异大',
    decision: '选 T+1 批处理',
    alternatives: [
      { option: '流式', pros: '时效高', cons: '需消息中间件，运维成本高' },
      { option: '准实时微批', pros: '折中', cons: '需要调度与状态管理' },
    ],
    consequences: ['时效为 T+1（业务可接受）', '差异工单需人工跟进'],
  })
  const completeness = adrCompleteness(office.storeFor(workspace))
  assert.equal(completeness.ok, true)
  assert.equal(office.adrs(call()).length, 1)

  // 取代：旧记录只加 supersededBy，不改内容
  const superseding = office.recordAdr(call(), {
    title: '改选准实时微批',
    context: '上游数据量翻倍，T+1 已不满足',
    decision: '改为准实时微批（5 分钟）',
    alternatives: [{ option: '仍用 T+1', pros: '不变', cons: '不满足时效' }],
    consequences: ['引入调度组件（新的运维面）'],
    supersedes: 'ADR-001',
  })
  assert.equal(superseding.id, 'ADR-002')
  const old = office.adrs(call()).find((adr) => adr.id === 'ADR-001')
  assert.equal(old?.status, 'superseded')
  assert.equal(old?.supersededBy, 'ADR-002')
  assert.equal(old?.decision, '选 T+1 批处理', '历史不得被改写')
})

test('质量场景：度量不可测就不算场景；ATAM 输出三张清单', () => {
  const scenario = office.recordScenario(call(), {
    attribute: 'performance',
    stimulus: '每日 100 万条对账文件到达',
    response: '在窗口内完成差异检测',
    measure: '单日 100 万条下 P99 < 500 毫秒',
    priority: 'high',
    targets: ['DES-001'],
  })
  assert.equal(isMeasurable(scenario), true)
  assert.equal(unmeasurableScenarios(office.storeFor(workspace)).length, 0)

  office.recordScenario(call(), { attribute: 'usability', stimulus: '用户操作', response: '感觉顺畅', measure: '尽可能快' })
  assert.deepEqual(unmeasurableScenarios(office.storeFor(workspace)), ['QS-002'])

  const assessment = office.assessQuality(call(), {
    risks: ['差异检测服务的单点故障会让整晚对账停摆'],
    sensitivities: ['批处理窗口长度由上游文件到达时间决定'],
    tradeoffs: ['为满足 P99 目标引入并行分片，牺牲了实现简单性'],
    by: '架构师',
  })
  assert.equal(assessment.risks.length, 1)
  assert.equal(office.qualityAssessment(call())?.tradeoffs.length, 1)
  assert.equal(office.scenarios(call()).length, 2)
})

test('追溯：孤儿检测、覆盖率与 must 需求的测试缺口', () => {
  const captured = office.capture(call(), { title: '差异检测', statement: '系统须识别差异；P99 < 500 毫秒', priority: 'must', sourceStakeholder: 'STK-01' })
  office.upsertElement(call(), { kind: 'component', name: '差异检测服务' })
  office.upsertElement(call(), { kind: 'data', name: '对账差异表' })

  const before = office.traceReport(call())
  assert.deepEqual(before.orphans.design.sort(), ['DES-001', 'DES-002'], '未挂需求的元素都是孤儿')
  assert.deepEqual(before.uncoveredMust, [captured.requirement.id])

  const store = office.storeFor(workspace)
  const journal = office.journalFor(workspace)
  link(store, journal, { from: captured.requirement.id, to: 'DES-001', kind: 'req-des' })
  link(store, journal, { from: captured.requirement.id, to: 'TC-001', kind: 'req-tc' })

  const after = report(store, office.requirements(call()))
  assert.deepEqual(after.orphans.design, ['DES-002'])
  assert.deepEqual(after.uncoveredMust, [])
  assert.equal(after.coverage, 1)
  // 非法边类型必须报错（图里不允许无意义边）
  assert.throws(() => link(store, journal, { from: 'REQ-001', to: 'X', kind: 'whatever' }), /非法追溯边类型/u)

  const path = office.renderTrace(call())
  assert.equal(path, 'docs/TRACE.md')
  assert.match(readFileSync(join(workspace, 'docs', 'TRACE.md'), 'utf8'), /DO NOT EDIT/u)
})

test('G3 全绿：五视图 + 无孤儿 + ADR 含备选与后果', () => {
  const captured = office.capture(call(), { title: '差异检测', statement: '系统须识别差异；P99 < 500 毫秒', priority: 'must', sourceStakeholder: 'STK-01' })
  for (const [kind, name] of [
    ['context', '对账系统'],
    ['component', '差异检测服务'],
    ['runtime', '夜间批处理'],
    ['data', '对账差异表'],
    ['deployment', '单机部署'],
  ] as const) {
    office.upsertElement(call(), { kind, name })
  }
  office.recordAdr(call(), {
    title: '批处理',
    context: '窗口未知',
    decision: 'T+1',
    alternatives: [{ option: '流式', pros: '快', cons: '贵' }],
    consequences: ['T+1 时效'],
  })
  // 把五个元素都挂到需求上（消除孤儿）
  const store = office.storeFor(workspace)
  const journal = office.journalFor(workspace)
  for (const element of ['DES-001', 'DES-002', 'DES-003', 'DES-004', 'DES-005']) {
    link(store, journal, { from: captured.requirement.id, to: element, kind: 'req-des' })
  }
  // **增量 1**：G3 现在还要求"设计交互闭环"走完（问题清零 + 方法选定 + 文档 11 章 + 关键条目确认）
  // **增量 2**：方法选定后还要按所选包补齐最小必产项（C-29 / C-2A）
  completeDesignInteraction(captured.requirement.id)

  const g3 = office.evaluate(call(), 'G3')
  assert.equal(g3.status, 'passed', `G3 应通过：${g3.criteria.filter((c) => !c.ok && c.na !== true).map((c) => `${c.id}:${c.detail}`).join(' | ')}`)
  assert.equal(office.checkGate(call(), 'G3').status, 'passed')
})

test('M2-06 设计前置：两道门（G2 基线 → 计划评审），无评审通道时按 Q-20 阻塞', () => {
  // ① 还没有基线需求 → gate-blocked
  const blockedByGate = office.designPrecondition(call(), { available: true, active: false })
  assert.equal(blockedByGate.kind, 'gate-blocked')

  baselineReadyRequirement()

  // ② 没有交互评审通道 → 阻塞 + 留痕，且不进入 plan mode
  const noReviewer = office.designPrecondition(call(), { available: false, active: false })
  assert.equal(noReviewer.kind, 'blocked-no-reviewer')
  const state = office.planState(call())
  assert.equal(state.entered, false, '不得进入 plan mode')
  assert.equal(state.blockedReason, 'plan review requires an interactive reviewer')
  const events = office.journalFor(workspace).read().events
  assert.equal(events.filter((event) => event.type === 'plan/review-blocked').length, 1, '阻塞只留痕一次')

  // ③ 有通道但未进 plan mode → 需要进入（SDO 主动驱动）
  const needsPlan = office.designPrecondition(call(), { available: true, active: false })
  assert.equal(needsPlan.kind, 'needs-plan-mode')
  office.markPlanEntered(call())

  // ④ 仍在 plan mode → 计划评审未完成
  assert.equal(office.designPrecondition(call(), { available: true, active: true }).kind, 'plan-review-pending')

  // ⑤ 离开 plan mode → 评审完成，放行
  office.markPlanReviewed(call())
  const ready = office.designPrecondition(call(), { available: true, active: false })
  assert.equal(ready.kind, 'ready', JSON.stringify(ready))
  assert.equal(office.planState(call()).reviewed, true)
})

test('架构阶段的证据：TRACE.md 与 gates/G3.json 都落在盘上', () => {
  baselineReadyRequirement()
  office.upsertElement(call(), { kind: 'component', name: '差异检测服务' })
  office.linkTrace(call(), [{ from: 'REQ-001', to: 'DES-001', kind: 'req-des' }])
  office.renderTrace(call())
  office.checkGate(call(), 'G3')
  assert.ok(existsSync(join(workspace, 'docs', 'TRACE.md')))
  assert.ok(existsSync(join(workspace, '.sdo', 'gates', 'G3.json')))
})
