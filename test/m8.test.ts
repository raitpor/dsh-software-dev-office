/**
 * 增量 1：设计阶段交互增强（A 交互闭环 + C 界面视图 + D 设计文档）。
 *
 * 这一组测试专门覆盖实施规格 §6 的验收项，并且**每个判据都双向测**：
 *   · grill：问题都带「选项 + 代价 + 建议」；未回答时 G3 不过、回答后通过；
 *   · 「含 UI」判定：需求声明界面面 → 未确认失败 / 确认后通过；未声明 → N/A（不是失败也不是通过）；
 *   · render：`docs/DESIGN.md` 含 11 章（增量 2 新增「设计方法」与「各方法产物」两章）+ 追溯矩阵行 + 待确认清单，且**不反向写台账**；
 *   · 方法论选择题：未回答 → G3 不过；回答后通过（且返回值里含模型推荐）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SdoStore } from '../src/infra/store.js'
import { writeMethodDoc } from './support/method-doc-fixture.js'
import { DESIGN_DOC_SECTIONS, uiDecision } from '../src/domain/design.js'
import { evaluateGate } from '../src/domain/gates.js'
import type { GateContext } from '../src/domain/gates.js'
import { link } from '../src/domain/trace.js'
import { Journal } from '../src/infra/journal.js'
import { t } from '../src/domain/i18n.js'
import { describeGate } from '../src/interface/describe.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { SdoConfig } from '../src/config.js'
import type { GateCriterionResult } from '../src/types.js'
import type { UiView } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m8/', import.meta.url))
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
  office.init(call(), { name: 'M8 测试', scale: 'normal', stakeholders: ['业务方'] })
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

/** 造一条已基线需求（G2 通过）。`kind` 传 `ui` 即声明界面面（§2.1 的需求侧真源）。 */
function baselineRequirement(kind: 'functional' | 'ui' = 'functional'): string {
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
    kind,
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
  return captured.requirement.id
}

/** 补一张能通过 `design.views` 的五视图（元素并挂到需求上消除孤儿）。 */
function fiveViews(requirementId: string): void {
  for (const [kind, name] of [
    ['context', '对账系统'],
    ['component', '差异检测服务'],
    ['runtime', '夜间批处理'],
    ['data', '对账差异表'],
    ['deployment', '单机部署'],
  ] as const) {
    office.upsertElement(call(), { kind, name })
  }
  const store = office.storeFor(workspace)
  const journal = office.journalFor(workspace)
  for (const id of office.views(call()).flatMap((view) => view.elements.map((element) => element.id))) {
    link(store, journal, { from: requirementId, to: id, kind: 'req-des' })
  }
}

/** 补一条合格的 ADR（G3 自带的 C-22 也要求"含备选与后果"）。 */
function addAdr(): void {
  office.recordAdr(call(), {
    title: '批处理窗口',
    context: '上游文件到达时间不稳定',
    decision: 'T+1 批处理，窗口 2 小时',
    alternatives: [{ option: '流式处理', pros: '时效高', cons: '复杂度高' }],
    consequences: ['时效为 T+1', '需要窗口监控'],
  })
}

function acceptQuestion(id: string): void {
  office.answerDesign(call(), id, '0', '按推荐')
}

/** 把设计问题的**每一题都回答掉**（含方法论选择题）。 */
function answerAll(ids: string[]): void {
  for (const id of ids) acceptQuestion(id)
}

let confirmRound = 0
function confirmAll(): void {
  // **R-27 连带**：确认戳的"依据"不许在**内容已变**之后照旧沿用（同一 target + 同一句话 + 内容指纹不同 ⇒ 拒绝）
  // ⇒ 夹具每次给一句**新的**用户授权原话（真实用法本来就是这样：改动之后要重新表态）。
  confirmRound += 1
  for (const target of office.designConfirmGaps(call()).required) {
    office.confirmDesign(call(), target, `用户在会话中确认（第 ${confirmRound} 次表态）`, '张三')
  }
}

function criterion(criteria: GateCriterionResult[], id: string): GateCriterionResult {
  const hit = criteria.find((item) => item.id === id)
  assert.ok(hit !== undefined, `门禁里必须有判据 ${id}`)
  return hit
}

/** 一个最小但"齐备"的界面视图（风格 + 一页栏目 + 一页布局）。 */
function uiFixture(): UiView {
  return {
    id: 'UI-001',
    style: { source: 'minimal', tokens: { '--fg': '#111' }, rationale: '用户要极简' },
    screens: [
      {
        id: 'SCR-001',
        name: '需求列表',
        columns: [
          { name: '编号', kind: 'text' },
          { name: '标题', kind: 'text' },
          { name: '状态', kind: 'badge' },
        ],
        layout: { grid: '1fr 2fr 80px', regions: ['header', 'filter-bar', 'table', 'pager'] },
        interactions: ['筛选', '排序', '分页'],
        states: { empty: '暂无数据', error: '加载失败', loading: '加载中' },
        requires: [],
      },
    ],
    breakpoints: [{ name: 'sm', width: '<=640px', changes: ['表格改卡片'] }],
    accessibility: { contrast: '>=4.5:1', keyboard: true, screenReader: '读屏可用' },
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 补齐**结构化方法包的最小必产项**（增量 2：选了 structured 就必须有数据字典 + 分层 DFD + ERD）。
 *
 * 数据字典覆盖 DFD 的每个流名，条目都带 `requires`（无来源条目会被既有 `trace.orphans` 抓）。
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
 * **§7.1 / §7.2 前置**：起草适用性声明（五视图全做、无额外工件）并让用户签字绑定。
 *
 * ⚠️ 与签字**分开**：声明之后还会有真源写入（工件 / ui 视图 / render），
 * 那些写入会让"签字后真源变更"规则判 G3 签字失效 —— 因此门禁签字要留到最后
 * （见 `signG3()`），顺序错了就会看到"明明签过却是红的"。
 */
function declareApplicability(): void {
  office.draftApplicability(call(), {
    focus: '对账系统：五视图全做，无额外非视图工件',
    viewsPresent: ['context', 'component', 'runtime', 'data', 'deployment'],
    viewsAbsent: [],
    artifacts: [],
    by: '模型起草',
  })
  office.confirmApplicability(call(), '同意就按这份声明走', '张三')
  // X-1：C-25 要求 `docs/DESIGN.md` **不早于最后一次真源变更** ——
  // 声明（含其确认）也是文档渲染的真源，因此夹具在写完真源后重渲染（渲染放最后）。
  office.renderDesign(call())
}

/** G3 门禁级签字（**必须带引用文本**；无引用的签字视为无效，门禁照样红）。 */
let signG3Round = 0
function signG3(): void {
  // **R-27**：同一句用户原话只代表**一次**表态（失效之后复用会被拒）⇒ 夹具每次给一句新的表态
  signG3Round += 1
  office.signGate(call(), { gate: 'G3', by: '张三', basis: `我签字确认这次设计可以放行（第 ${signG3Round} 次表态）`, channel: 'command' })
  // X-1：签字后重渲染，保证判定时刻的文档与真源一致（`gate/signed` 本身不改文档内容）
  office.renderDesign(call())
}

// —————————————————————— §6-1：grill 的问题形状 + 未答/已答双向 ——————————————————————

test('M8-01 grill：每个问题都带「选项 + 代价 + 建议（含推荐理由）」', () => {
  baselineRequirement()
  const grilled = office.grillDesign(call(), { recommendation: { method: '结构化（数据流 + 数据字典）', rationale: '需求已基线且稳定' } })
  assert.ok(grilled.created.length > 0, '缺口检测器必须问出问题来（一条都没有 = 没做交互）')
  for (const question of grilled.created) {
    assert.ok(question.options.length >= 2, `${question.id} 必须给出至少两个选项`)
    for (const option of question.options) {
      assert.ok(option.label.trim() !== '', `${question.id} 的选项必须有 label`)
      assert.ok(option.cost.trim() !== '', `${question.id} 的选项必须写清代价（不能只说好处）`)
    }
    assert.ok(question.defaultRecommendation.trim() !== '', `${question.id} 必须给出我的建议`)
    assert.ok(question.why.includes('#'), `${question.id} 的 why 里要有模板 key（供判重）`)
    assert.ok(question.status === 'open' && question.answer === null, `${question.id} 生成时必须未决`)
  }
  // 方法论选择题必须真的被问出来，且**带模型推荐与理由**
  const method = grilled.created.find((question) => question.targets.includes('design:method'))
  assert.ok(method !== undefined, '必须提出「本项目用哪种设计方法」选择题')
  assert.equal(method.defaultRecommendation, '结构化（数据流 + 数据字典）', '推荐必须来自调用方给出的模型推荐')
  assert.ok(method.why.includes('结构') === false, '推荐理由不混进 why')
})

test('M8-02 G3 的 design.no-open-questions：未回答不通过、回答后通过（双向）', () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  office.renderDesign(call())
  confirmAll()

  const grilled = office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '需求稳定' } })
  assert.ok(grilled.stillOpen.length > 0)

  const before = office.evaluate(call(), 'G3')
  assert.equal(criterion(before.criteria, 'C-23').ok, false, '还有未决设计问题时判据必须为红')
  assert.equal(before.status, 'failed', 'G3 不能放行')

  answerAll(grilled.stillOpen)
  const after = office.evaluate(call(), 'G3')
  assert.equal(criterion(after.criteria, 'C-23').ok, true, '问题清零后判据必须为绿')
})

test('M8-03 从未问过设计问题 = 失败（不允许把"没做交互"当成通过）', () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  office.renderDesign(call())
  confirmAll()
  const g3 = office.evaluate(call(), 'G3')
  const noQuestions = criterion(g3.criteria, 'C-23')
  assert.equal(noQuestions.ok, false, '一条设计问题都没有时判据必须为红')
  assert.equal(g3.status, 'failed')
})

// —————————————————————— §6-5：方法论选择题双向（C-26 已并入 C-28） ——————————————————————

test('M8-04 设计方法判据（C-28，唯一一条）：未回答不通过、回答后通过', () => {
  const requirementId = baselineRequirement()
  fiveViews(requirementId)
  office.renderDesign(call())
  confirmAll()
  const grilled = office.grillDesign(call(), { recommendation: { method: '面向对象（类图 + 时序）', rationale: '领域模型复杂' } })
  const method = grilled.created.find((question) => question.targets.includes('design:method'))
  assert.ok(method !== undefined)

  const before = office.evaluate(call(), 'G3')
  // C-26（"选择题已回答"）已并入 C-28：回执里**只能有一条**方法选择判据，不许两条并存
  assert.equal(before.criteria.some((item) => item.id === 'C-26'), false, 'C-26 已删除，不得再挂在 G3 上')
  const methodCriterion = criterion(before.criteria, 'C-28')
  assert.equal(methodCriterion.ok, false, '方法论题未回答时判据必须为红')
  assert.equal(methodCriterion.na, undefined, '未回答是**失败**，不是 N/A（不允许"不选就没要求"）')

  // 剩下的问题先答掉，只留方法论题，验证它是唯一的红项
  answerAll(grilled.stillOpen.filter((id) => id !== method.id))
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-28').ok, false)

  // 用户选了第 2 个选项（面向对象）——不是默认建议，验证"用户的选择被如实记录"
  office.answerDesign(call(), method.id, '1', '领域模型复杂，选面向对象')
  const after = office.evaluate(call(), 'G3')
  const passed = criterion(after.criteria, 'C-28')
  assert.equal(passed.ok, true, '回答后必须为绿')
  assert.match(passed.detail, /面向对象/u, '判据详情里要出现用户选定的方法')
  assert.equal(method.defaultRecommendation, '面向对象（类图 + 时序）', '返回的问题里必须带模型推荐')
})

// —————————————————————— §6-3：含 UI 判定双向 + 三态 N/A ——————————————————————

test('M8-05 含 UI 判定：需求未声明界面面 → ui.* 为 N/A（不是失败也不是通过）', () => {
  const requirementId = baselineRequirement('functional')
  fiveViews(requirementId)
  addAdr()
  const grilled = office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '稳定' } })
  // 方法论选择题（§7.2 起在需求阶段提出）也要答掉，否则 C-28 会红
  const method = grilled.created.find((question) => question.targets.includes('design:method'))
  if (method !== undefined) office.answerDesign(call(), method.id, '0', '按推荐')
  answerAll(grilled.stillOpen.filter((id) => id !== method?.id))
  structuredMethodProducts(requirementId)
  office.renderDesign(call())
  confirmAll()
  // **§7.1 / §7.2**：声明适用性 + 门禁签字（顺序：先声明，所有真源写完再签）
  declareApplicability()
  signG3()

  const decision = uiDecision(office.status(call()).project, office.requirements(call()))
  assert.equal(decision.hasUi, false, '没有任何需求声明界面面时必须判为假')

  const g3 = office.evaluate(call(), 'G3')
  const ui = criterion(g3.criteria, 'C-27')
  assert.equal(ui.na, true, '判假时必须是 N/A 态')
  assert.equal(ui.ok, false, 'N/A **绝不能**被算成通过')
  assert.ok(ui.naReason !== undefined && ui.naReason !== '', 'N/A 必须带理由')
  // N/A 不得让门禁失败
  assert.equal(g3.status, 'passed', `N/A 不该阻止放行：${g3.criteria.filter((c) => !c.ok && c.na !== true).map((c) => c.id).join(',')}`)
  assert.ok(!g3.remedy.some((item) => item.includes('C-27')), 'N/A 不得进 remedy 列表')

  // 一个界面问题都不许问（判假时不问风格/栏目/布局）
  const texts = grilled.created.map((question) => question.text).join('\n')
  assert.equal(/风格|栏目|布局|断点|无障碍/u.test(texts), false, '判假时一个问题都不许问界面维度')

  // 判假时也许写 ui 视图：写了的 requires 由既有追溯孤儿检查抓（不为此新造判据）
  office.writeUiView(call(), uiFixture())
  const after = office.evaluate(call(), 'G3')
  assert.equal(criterion(after.criteria, 'C-27').na, true, '判假时即使写了 ui 视图，判据仍是 N/A')
})

test('M8-06 含 UI 判定：需求声明界面面 → 未确认失败、三者缺一仍失败、确认后通过', () => {
  const requirementId = baselineRequirement('ui')
  fiveViews(requirementId)
  const grilled = office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '稳定' } })
  const uiQuestions = grilled.created.filter((question) => (question.targets[0] ?? '').startsWith('design:ui-'))
  assert.equal(uiQuestions.length, 5, '判真时必须问出界面维度的 5 个问题（风格/栏目/布局/断点/无障碍）')
  answerAll(grilled.stillOpen)
  office.renderDesign(call())
  confirmAll()

  // 还没有界面视图 → 失败
  assert.equal(office.evaluate(call(), 'G3').criteria.find((c) => c.id === 'C-27')?.ok, false, '判真但 ui 视图为空必须失败')

  office.writeUiView(call(), uiFixture())
  const noConfirm = office.evaluate(call(), 'G3')
  const ui = criterion(noConfirm.criteria, 'C-27')
  assert.equal(ui.ok, false, '有界面视图但没确认 → 必须失败')
  assert.equal(ui.na, undefined, '判真时不允许退化成 N/A')

  // 只确认风格 → 仍失败（栏目/布局未确认）
  office.confirmDesign(call(), 'ui:UI-001:style', '用户确认风格', '张三')
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-27').ok, false, '只确认风格时仍必须失败')

  // 确认栏目 → 仍失败（布局未确认）
  office.confirmDesign(call(), 'SCR-001:columns', '用户确认栏目', '张三')
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-27').ok, false, '缺布局时仍必须失败')

  // 缺项也照样失败：把布局的 regions 去掉即视为"缺布局"
  const broken = uiFixture()
  broken.screens[0]!.layout = { grid: '', regions: [] }
  office.writeUiView(call(), broken)
  office.confirmDesign(call(), 'SCR-001:layout', '用户确认布局', '张三')
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-27').ok, false, '布局为空时即使有确认戳也必须失败')

  // 三者齐全 + 全部确认 → 通过
  office.writeUiView(call(), uiFixture())
  // 布局被换回完整形状（内容变过）⇒ 依据必须是**新的**表态
  office.confirmDesign(call(), 'SCR-001:layout', '用户确认布局（调整后重新表态）', '张三')
  const passed = criterion(office.evaluate(call(), 'G3').criteria, 'C-27')
  assert.equal(passed.ok, true, '风格 + 每页栏目 + 每页布局齐备且确认后必须通过')
})

test('M8-07 含 UI 判定从需求真源现算：后期新增 UI 需求立刻翻真（无需人工开关）', () => {
  const requirementId = baselineRequirement('functional')
  fiveViews(requirementId)
  office.renderDesign(call())
  const before = uiDecision(office.status(call()).project, office.requirements(call()))
  assert.equal(before.hasUi, false)

  // 项目级 surfaces 一声明含界面，判定立即为真
  office.updateProject(call(), { surfaces: ['web'] })
  const after = uiDecision(office.status(call()).project, office.requirements(call()))
  assert.equal(after.hasUi, true, '项目级 surfaces 声明 web 后必须立刻判真')
  assert.deepEqual(after.surfaces, ['web'])
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-27').na, undefined, '翻真后不再是 N/A')
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-27').ok, false, '翻真且未确认时必须失败')
})

// —————————————————————— §6-4：render 的产物 ——————————————————————

test('M8-08 render：docs/DESIGN.md 含 11 章 + 追溯矩阵行 + 待确认清单，且不反向写台账', () => {
  const requirementId = baselineRequirement('ui')
  fiveViews(requirementId)
  // 一条契约（追溯矩阵的契约列要有东西）
  const component = office.views(call()).find((view) => view.kind === 'component')?.elements[0]
  assert.ok(component !== undefined)
  office.recordContract(call(), {
    name: '对账系统 → 差异检测服务',
    producer: '对账系统',
    consumer: component.name,
    schema: '{"差异id":"string"}',
    kind: 'schema',
    failureSemantics: { timeout: '3s', retry: '3 次退避', idempotency: '按差异 id 幂等' },
  })
  const grilled = office.grillDesign(call(), { recommendation: { method: '敏捷-演进式', rationale: '需求仍在演化' } })
  office.writeUiView(call(), uiFixture())
  office.renderDesign(call())

  const text = readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8')
  for (const key of DESIGN_DOC_SECTIONS) {
    assert.ok(text.includes(t(key)), `DESIGN.md 缺章节：${t(key)}`)
  }
  // 至少一行追溯矩阵行（需求 id 出现在矩阵里）
  assert.ok(text.includes(`| ${requirementId} |`), '追溯矩阵必须至少有一行真实需求')
  assert.ok(text.includes('| 设计元素') || text.includes('| Design elements'), '追溯矩阵必须有表头')
  // 待确认清单（含建议与代价）
  assert.ok(text.includes(grilled.stillOpen[0] ?? 'Q-'), '待确认清单必须列出未决问题')
  assert.ok(text.includes(t('uiDesign.docQuestionSuggest')), '清单要带"我的建议"')
  assert.ok(text.includes(t('uiDesign.docQuestionCost')), '清单要带"不问的代价"')
  assert.ok(text.includes('SCR-001'), '界面方案要含页面栏目/布局')

  // 派生视图：渲染**不**改台账（问题账本与确认戳数量不变）
  const before = office.designIssues(call()).open.length
  office.renderDesign(call())
  assert.equal(office.designIssues(call()).open.length, before, 'render 不得反向写台账')
})

test('M8-09 含 UI 判假时 DESIGN.md 的界面方案章节（现 §7）不省略也不留空，写明不适用 + 依据', () => {
  const requirementId = baselineRequirement('functional')
  fiveViews(requirementId)
  const grilled = office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '稳定' } })
  answerAll(grilled.stillOpen)
  office.renderDesign(call())
  const text = readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8')
  assert.ok(text.includes(t('uiDesign.docS5')), '界面方案章节（现 §7）必须存在')
  assert.ok(text.includes(t('uiDesign.docUiNa')), '界面方案章节必须写「不适用」')
  assert.ok(text.includes(t('uiDesign.docUiNaRule')), '界面方案章节必须写出判定依据（含 UI 的规则）')
  assert.ok(text.includes('uiDesign.uiReasonNo') === false, '不得把键名当文案输出')
})

// —————————————————————— §5：三态回执 + 判据 id 清单 ——————————————————————

test('M8-10 门禁回执三态：➖ N/A 与理由显式可见，✅/❌ 不变', () => {
  const requirementId = baselineRequirement('functional')
  fiveViews(requirementId)
  addAdr()
  const grilled = office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '稳定' } })
  const method = grilled.created.find((question) => question.targets.includes('design:method'))
  if (method !== undefined) office.answerDesign(call(), method.id, '0', '按推荐')
  answerAll(grilled.stillOpen.filter((id) => id !== method?.id))
  structuredMethodProducts(requirementId)
  office.renderDesign(call())
  confirmAll()
  // 声明适用性 + 签字：本用例的语义是"唯一非通过项是 N/A"，因此签字必须先于判定
  declareApplicability()
  signG3()
  const evaluation = office.evaluate(call(), 'G3')
  const text = describeGate(evaluation)
  assert.ok(text.includes(t('uiDescribe.gateNa')), `回执里必须有 N/A 标记：\n${text}`)
  assert.ok(text.includes(t('uiDesign.uiNoReqs')) || text.includes(t('uiDesign.uiReasonNo')), '回执里必须有 N/A 的理由')
  assert.ok(text.includes('✅'), '通过项仍用 ✅')
  assert.equal(text.includes('❌'), false, '本用例里全部通过（唯一非通过项是 N/A）')
})

test('M8-11 G3 的 4 条新判据都挂在流程数据上，且方法选择判据**恰好一条**（C-26 已并入 C-28）', () => {
  const process = office.process(call())
  const g3 = process.gates.find((gate) => gate.id === 'G3')
  assert.ok(g3 !== undefined)
  const checks = g3.criteria.map((criterion) => criterion.check)
  for (const required of [
    'design.no-open-questions',
    'design.confirmed',
    'design.doc',
    'ui.confirmed',
  ]) {
    assert.ok(checks.includes(required), `G3 缺检查器 ${required}`)
  }
  // 方法选择：**恰好一条**判据 —— 合并前 `design.method-chosen`（C-26）与
  // `design.method-selected`（C-28）并存，同一问题上回执出现两条相关判据（且一条更松）。
  const methodChecks = g3.criteria.filter((item) => /method-(chosen|selected)/u.test(item.check))
  assert.equal(methodChecks.length, 1, `G3 的方法选择判据必须恰好一条，实际：${methodChecks.map((item) => `${item.id}/${item.check}`).join(' ')}`)
  assert.equal(methodChecks[0]?.check, 'design.method-selected', '留下的必须是语义更严格的 design.method-selected')
  assert.equal(methodChecks[0]?.id, 'C-28')
  assert.equal(g3.criteria.some((item) => item.id === 'C-26'), false, 'C-26 不得再挂在流程数据上')
  assert.equal(checks.includes('design.method-chosen'), false, 'design.method-chosen 检查器已被合并删除')

  // 全仓库静态证据：C-26 / design.method-chosen 不得再出现在**活代码**里
  //（流程数据、检查器注册表、语言包）。注释里的历史说明不算残留 —— 因此先剥掉注释再看。
  const strip = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const files = [
    ...readdirSync(join(root, 'src', 'data', 'processes')).map((name) => join('src', 'data', 'processes', name)),
    'src/domain/gates.ts',
    'src/data/lang/zh-CN.yml',
    'src/data/lang/en.yml',
  ]
  for (const file of files) {
    const text = strip(readFileSync(join(root, file), 'utf8'))
    assert.equal(text.includes('design.method-chosen'), false, `${file} 里仍有 design.method-chosen 残留`)
    assert.equal(/C-26/u.test(text), false, `${file} 里仍有 C-26 残留`)
  }
})

test('M8-12 未实现的检查器必须判失败（不允许"查不到就算过"）', () => {
  const synthetic = {
    id: 'x',
    name: 'x',
    description: '',
    phases: [{ id: 'architecture', role: 'architect', entry: [], exit: ['G3'], artifacts: [] }],
    gates: [
      {
        id: 'G3',
        name: '架构门禁',
        criteria: [
          { id: 'C-99', check: 'design.not-implemented-yet', desc: '还没实现的判据' },
          { id: 'C-27', check: 'ui.confirmed', desc: '界面确认' },
        ],
      },
    ],
  }
  const context: GateContext = {
    workspace,
    store: office.storeFor(workspace),
    journal: new Journal(office.storeFor(workspace)),
    process: synthetic,
    project: office.status(call()).project,
    requirements: office.requirements(call()),
    questions: office.questions(call()),
    risks: [],
    issues: [],
    feasibility: undefined,
    redTeamExecuted: false,
    redTeamDisabled: false,
    waivedGates: [],
    prototypeDir: 'prototype',
    prototypeThrowaway: false,
    riskConclusion: undefined,
  }
  const result = evaluateGate(synthetic, 'G3', context)
  const missing = result.criteria.find((item) => item.id === 'C-99')
  assert.equal(missing?.ok, false, '未实现的检查器必须判红')
  assert.equal(result.status, 'failed', '有未实现检查器时门禁不得放行')
})
