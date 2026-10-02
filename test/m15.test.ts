/**
 * 增量 5：诊断报告《2026-10-01-插件测试报告-0.1.2设计阶段》§2 六条缺陷的回归 +
 * **F-7 的机械守卫**（schema ↔ handler 不得脱节）。
 *
 *   F-4  草案来源判定只读元素自带 `requires` → 存量项目全量误报"无来源/低置信度"
 *   F-5  grill 不看既有 ADR，把已定案的题当开放题重问
 *   F-6  方法论题的"建议理由"是标签复述，且模型没给理由时看不出来
 *   F-7  `sdo_design` JSON schema 漏了 `artifactKind`/`artifactData` → `action=artifact` 不可用
 *   F-8  `ui` 写进 `viewsPresent` 被**静默丢弃**
 *   F-9  界面视图没有任何写入入口 → 含界面项目的 C-27 永久红
 *
 * 纪律（与 m13/m14 一致）：
 *   · 断言只读**真源**（`.sdo/` 下的 yml / journal / 门禁判据），不采信任何自述；
 *   · 工具通道用例**按 schema 过滤入参**后调用真实工具（复现宿主的入参过滤）——
 *     这正是 F-7 的复现条件：不过滤的测试会假绿。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { Config, resolveSettings } from '../src/config.js'
import { writeMethodDoc } from './support/method-doc-fixture.js'
import { SdoStore } from '../src/infra/store.js'
import type { SdoConfig } from '../src/config.js'
import { parseUiViewInput, decidedByAdr } from '../src/domain/design.js'
import { fmt, t } from '../src/domain/i18n.js'
import { apply } from '../src/index.js'
import { describeDesignQuestions } from '../src/interface/describe.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { GateCriterionResult, GateEvaluation, ViewKind } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m15/', import.meta.url))
const ALL2 = { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 }
const ALL_VIEWS: ViewKind[] = ['context', 'component', 'runtime', 'data', 'deployment']
const call = (): { sessionId: string } => ({ sessionId: 's1' })

let workspace: string
let office: SoftwareDevOffice

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

/**
 * 一条已基线需求（G2 通过），项目**含界面**（`surfaces=['web']`）—— F-8/F-9 的复现前提。
 *
 * 需求阶段的工作仍用领域门面做（它不是本次缺陷的面）；**设计阶段的动作全部走工具通道**。
 */
function baselineRequirement(): string {
  office.init(call(), { name: 'M15 测试', scale: 'normal', stakeholders: ['业务方'], surfaces: ['web'] })
  office.updateProject(call(), {
    scopeIn: ['对账'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['识别率 ≥ 99%'],
    glossary: { 差异: '不一致记录' },
  })
  office.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  office.logRisk(call(), { title: '格式变更', level: 'low', probability: 'low', impact: '小', mitigation: '校验', owner: '业务方' })
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
  assert.equal(outcome.ok, true, `前置：基线应通过：${outcome.dor.failed.join(',')}`)
  return captured.requirement.id
}

const UI_VIEW_JSON = JSON.stringify({
  id: 'UI-001',
  style: { source: 'minimal', tokens: { '--fg': '#111' }, rationale: '极简，减少视觉噪声' },
  screens: [
    {
      id: 'SCR-001',
      name: '差异清单',
      columns: [{ name: '编号', kind: 'text' }, { name: '标题', kind: 'text' }, { name: '状态', kind: 'status' }],
      layout: { grid: '12 栏', regions: ['页头', '清单', '详情'] },
      requires: [],
    },
  ],
  breakpoints: [{ name: 'desktop', width: '≥1024', changes: ['三栏'] }],
  accessibility: { contrast: '>=4.5:1', keyboard: true, screenReader: '读屏可用' },
})

/**
 * 结构化包的三份最小必产项（产物条目都挂需求来源：无来源条目会被既有孤儿检查抓成孤儿）。
 * 形状照 `test/m13.test.ts` 的夹具，但这里经**工具通道**的 `artifactData` JSON 传入。
 */
function structuredArtifacts(requirementId: string): { kind: string; data: string }[] {
  const dictionary = JSON.stringify({
    summary: '对账差异数据字典',
    dictionary: [
      { name: '对账文件', type: 'file', source: '上游系统', sink: '对账系统', validation: '非空且格式合法', requires: [requirementId] },
      { name: '差异清单', type: 'record[]', source: '对账系统', sink: '业务方', validation: '每条含差异 id', requires: [requirementId] },
    ],
  })
  const dfd = JSON.stringify({
    summary: '对账分层数据流图',
    levels: [
      {
        level: 0,
        name: '上下文层',
        flows: [{ name: '对账文件', from: '上游系统', to: '对账系统' }, { name: '差异清单', from: '对账系统', to: '业务方' }],
        processes: [{ name: '对账系统', inputs: ['对账文件'], outputs: ['差异清单'], requires: [requirementId] }],
      },
      {
        level: 1,
        name: '分解层',
        flows: [{ name: '对账文件', from: '上游系统', to: '差异检测服务' }, { name: '差异清单', from: '差异检测服务', to: '业务方' }],
        processes: [{ name: '差异检测服务', inputs: ['对账文件'], outputs: ['差异清单'], requires: [requirementId] }],
      },
    ],
  })
  const erd = JSON.stringify({
    summary: '对账差异 ERD',
    entities: [
      { name: '对账批次', identifier: '批次ID', requires: [requirementId] },
      { name: '对账差异', identifier: '差异ID', requires: [requirementId] },
    ],
    relations: [{ name: '批次含差异', from: '对账批次', to: '对账差异', cardinality: '1:N' }],
  })
  return [
    { kind: 'dictionary', data: dictionary },
    { kind: 'dfd', data: dfd },
    { kind: 'erd', data: erd },
  ]
}

function criterion(criteria: GateCriterionResult[], id: string): GateCriterionResult {
  const found = criteria.find((item) => item.id === id)
  assert.ok(found !== undefined, `G3 必须有判据 ${id}`)
  return found
}
function g3(): GateEvaluation {
  return office.evaluate(call(), 'G3')
}

// —————————————————————— 工具通道（真实装配 + schema 过滤） ——————————————————————

interface ToolHarness {
  tools: ToolDefinition[]
  callTool(name: string, args: Record<string, unknown>): Promise<string>
}

/**
 * 用**真实装配**（`apply`）拿到注册进宿主的工具，并按 **schema 的 `properties` 过滤入参**后调用。
 *
 * 为什么必须过滤：F-7 的根因就是"宿主按 schema 过滤 → handler 收到空种类"。
 * 不过滤的测试会绕过宿主行为、把 blocker 测成绿的 ✗。
 *
 * 装配上下文是结构式的假 ctx：只提供 `tools` 服务（工具注册是本用例唯一需要的装配面），
 * 因此 `planMode`/`subagents`/`tokenMeter` 的 `inject` 回调不会被调用 —— 正好复现
 * "宿主没有 plan mode 服务"这条真实路径（靠 `action=review` 出口继续）。
 */
function toolHarness(ws: string): ToolHarness {
  const registered: ToolDefinition[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition): (() => void) => { registered.push(tool); return () => {} } },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => {
      if (names.every((name) => name in services)) cb(makeCtx())
    },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  assert.ok(registered.length >= 20, `真实装配应注册全部工具，实际 ${registered.length}`)

  // 假 agent：`callOf` 从 `agent.session.header.cwd` 取工作目录（dsh 0.2.0-rc.1 的真实字段）。
  const exec = { agent: { id: 's1', session: { header: { cwd: ws } } } } as unknown as ToolRunContext

  return {
    tools: registered,
    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `工具面缺少 ${name}`)
      const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      const dropped = Object.keys(args).filter((key) => !(key in properties))
      assert.deepEqual(dropped, [], `${name} 的这些入参不在 schema 里，会被宿主静默丢掉：${dropped.join(',')}`)
      const filtered: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
      return String(await tool.execute(filtered, exec))
    },
  }
}

/**
 * 走完设计阶段（**设计期动作全部经工具通道**）。
 * 返回两条关键回执，供用例断言"回执里说了什么"。
 */
async function designStageViaTools(harness: ToolHarness, requirementId: string): Promise<{ uiWrite: string; artifact: string }> {
  // 出口之一：本会话内评审完计划（宿主没有 plan mode 服务时 designPrecondition 需要它）
  await harness.callTool('sdo_design', { action: 'review', approvedBy: '张三' })
  // 五视图（每个视图一个元素）
  for (const [kind, name] of [
    ['context', '对账系统'],
    ['component', '差异检测服务'],
    ['runtime', '夜间批处理'],
    ['data', '对账差异表'],
    ['deployment', '单机部署'],
  ] as const) {
    await harness.callTool('sdo_design', { action: 'create', kind, name, responsibility: `${name}的职责` })
  }
  // 追溯边（C-21）：元素自身没有 requires 字段 → 来源只能走追溯图（也正是 F-4 的口径）
  for (const element of office.views(call()).flatMap((view) => view.elements)) {
    await harness.callTool('sdo_trace', { action: 'link', from: requirementId, to: element.id, kind: 'req-des' })
  }
  // 界面视图（F-9）：`action=create kind=ui ui=<JSON>`
  const uiWrite = await harness.callTool('sdo_design', { action: 'create', kind: 'ui', ui: UI_VIEW_JSON })
  // 方法产物（F-7）：`action=artifact` 必须真的能写入
  const artifacts = structuredArtifacts(requirementId)
  const first = artifacts[0]
  assert.ok(first !== undefined)
  const artifact = await harness.callTool('sdo_design', { action: 'artifact', artifactKind: first.kind, artifactData: first.data })
  for (const item of artifacts.slice(1)) {
    await harness.callTool('sdo_design', { action: 'artifact', artifactKind: item.kind, artifactData: item.data })
  }
  // 新口径（方法包人审文档）：选中包后必须有一份与台账指纹一致的人审文档
  writeMethodDoc(workspace, new SdoStore(join(workspace, '.sdo')), 'structured')
  return { uiWrite, artifact }
}

// —————————————————————— F-4 ——————————————————————

test('F-4 草案来源改走追溯图：元素没有 requires 字段但有 req-des 边时，不得误报"无来源"', () => {
  const requirementId = baselineRequirement()
  // 元素**不带** requires（复现存档项目的真实形态：来源只在追溯图上）
  office.upsertElement(call(), { kind: 'component', name: '差异检测服务', responsibility: '检测差异' })
  const element = office.views(call()).find((view) => view.kind === 'component')?.elements[0]
  assert.ok(element !== undefined)
  assert.deepEqual(element.requires ?? [], [], '前置：元素自带的 requires 必须是空的')

  // 反向：没有追溯边时，草案必须仍报"无来源"（不许用"一律置信"放过）
  const before = office.designDraft(call()).views.flatMap((view) => view.elements).find((row) => row.id === element.id)
  assert.ok(before !== undefined)
  assert.deepEqual(before.requires, [], '没有追溯边时必须仍判无来源')
  assert.equal(before.confidence, 'low', '没有来源时必须仍是 low')

  // 正向：建了 req-des 边之后，草案的"来源需求"与置信度必须跟上（与 C-21 同源）
  office.linkTrace(call(), [{ from: requirementId, to: element.id, kind: 'req-des' }])
  const after = office.designDraft(call()).views.flatMap((view) => view.elements).find((row) => row.id === element.id)
  assert.ok(after !== undefined)
  assert.deepEqual(after.requires, [requirementId], '有追溯边时必须给出真实来源需求')
  assert.equal(after.confidence, 'high', '有来源时必须转为 high')

  // 与同一插件的 C-21 读数一致：无孤儿
  assert.deepEqual(office.traceReport(call()).orphans.design, [], 'C-21 必须报无孤儿')
  // DESIGN.md 也走同一份草案（§2 各视图不得再写"（无来源：agent 推测）"）
  office.renderDesign(call())
  const doc = readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8')
  const section = doc.slice(doc.indexOf('## 2.'), doc.indexOf('## 3.'))
  assert.ok(section.includes(requirementId), 'DESIGN.md 的视图章必须写出真实来源需求')
  assert.equal(section.includes(t('uiDesign.docNoSource')), false, '不得再把有追溯来源的元素写成"无来源"')
})

// —————————————————————— F-5 ——————————————————————

test('F-5 grill 与既有 ADR 比对：已定案的题降级为确认项（题面标注 ADR），未定案的仍是开放题', () => {
  const requirementId = baselineRequirement()
  office.upsertElement(call(), { kind: 'component', name: '差异检测服务', requires: [requirementId] })
  // 一条把「存储」定案的 ADR（复现报告里的 ADR-003 SQLite 场景）
  const adr = office.recordAdr(call(), {
    title: '本项目的存储选型',
    context: '单机可运行、无运维预算',
    decision: '使用 SQLite 作为唯一存储',
    alternatives: [
      { option: 'PostgreSQL', pros: '并发强', cons: '要运维' },
      { option: 'SQLite', pros: '零运维', cons: '并发弱' },
    ],
    consequences: ['单文件数据库', '备份即拷贝文件'],
  })
  const result = office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '稳定' } })
  const store = result.created.find((question) => question.text.includes(t('uiDesign.qStoreText')))
  assert.ok(store !== undefined, '前置：必须问出存储题')
  assert.equal(store.decidedBy, adr.id, '存储题必须标出已有决策的那条 ADR')
  // 没定案的题不得被误标
  const performance = result.created.find((question) => question.text.includes(t('uiDesign.qPerfText')))
  assert.ok(performance !== undefined, '前置：必须问出性能题')
  assert.equal(performance.decidedBy, undefined, '没有对应 ADR 的题不得被误标为已定案')

  // 回执里必须看得见"已有决策"（不得只在数据里）
  const visible = fmt('uiDesign.qAlreadyDecided', { p1: adr.id })
  assert.ok(visible.includes(adr.id), '语言包里的 qAlreadyDecided 必须能带上 ADR 号')
  assert.notEqual(t('uiDesign.qAlreadyDecided'), 'qAlreadyDecided', 'qAlreadyDecided 必须在语言包里')
  const issued = office.designIssues(call()).open
  assert.ok(issued.some((question) => question.decidedBy === adr.id), 'issues 账本里必须带着这条 ADR 绑定')

  // 反向：ADR 被**取代**后不得再算"已定案"（取代它的新决策不提存储，只有被取代的那条命中关键词）
  office.recordAdr(call(), {
    title: '数据落地方式调整',
    context: '原方案的维护成本高',
    decision: '改由外部系统负责持久化',
    alternatives: [{ option: '继续自建', pros: '可控', cons: '成本高' }, { option: '外部系统负责', pros: '成本低', cons: '依赖对方' }],
    consequences: ['无本地持久化代码'],
    supersedes: adr.id,
  })
  const adrs = office.adrs(call())
  assert.equal(adrs.find((item) => item.id === adr.id)?.status, 'superseded')
  assert.equal(decidedByAdr(adrs, 'store'), undefined, '被取代的 ADR 不算已定案')
})

// —————————————————————— F-6 ——————————————————————

test('F-6 建议理由：模型给了 rationale 就照实显示；没给就显式标注"模型未提供理由"（双向）', () => {
  office.init(call(), { name: 'M15 F-6', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call(), { scopeOut: ['运维'], glossary: { 差异: '不一致' } })
  // `askDesignQuestions` 要求已有需求（否则不立项、不提问）
  office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    kind: 'functional',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })

  // ① 模型给了 answer + rationale
  const first = office.askDesignQuestions(call(), { recommendation: { method: '结构化', rationale: '需求稳定、变更少' } })
  assert.ok(first !== undefined)
  assert.equal(first.question.recommendationFromModel, true, '模型给了理由时必须记为来自模型')
  const withModel = describeDesignQuestions(first.question, true)
  assert.ok(withModel.includes('需求稳定、变更少'), '回执必须显示模型给的理由')
  assert.equal(
    withModel.includes(fmt('uiDescribe.kApplicabilityRecommendWhyFallback', { p1: '' })),
    false,
    '模型给了理由时不得再标兜底',
  )

  // ② 模型没给 rationale（新项目）：必须显式标注，且**不得**把建议本身当理由复述
  const ws2 = join(BASE, 'proj-f6')
  rmSync(ws2, { recursive: true, force: true })
  mkdirSync(ws2, { recursive: true })
  const office2 = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office2.noteSession('s2', ws2)
  office2.init({ sessionId: 's2' }, { name: 'M15 F-6 无理由', scale: 'normal', stakeholders: ['业务方'] })
  office2.updateProject({ sessionId: 's2' }, { scopeOut: ['运维'] })
  office2.capture({ sessionId: 's2' }, {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异',
    kind: 'functional',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  const second = office2.askDesignQuestions({ sessionId: 's2' }, { recommendation: { method: '结构化' } })
  assert.ok(second !== undefined)
  assert.equal(second.question.recommendationFromModel, false, '模型没给理由时必须记为兜底')
  const fallback = describeDesignQuestions(second.question, true)
  assert.ok(
    fallback.includes(fmt('uiDescribe.kApplicabilityRecommendWhyFallback', { p1: t('uiDesign.methodRecommendWhy') })),
    '必须显式标注"模型未提供理由"',
  )
  assert.ok(fallback.includes(t('uiDesign.methodRecommendWhy')), '兜底理由要如实展示，但带着警示')
  // 旧实现是把 defaultRecommendation 当理由再打印一遍 —— 这条必须消失
  const duplicated = fmt('uiDescribe.kApplicabilityRecommendWhy', { p1: second.question.defaultRecommendation })
  assert.equal(fallback.includes(duplicated), false, '不得再把"建议"当"建议理由"复述一遍')
})

// —————————————————————— F-8 ——————————————————————

test('F-8 `ui` 是合法的第 6 个视图：写进 viewsPresent 必须被保留并显示（不再静默丢弃）', async () => {
  office.init(call(), { name: 'M15 F-8', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call(), { scopeOut: ['运维'], glossary: { 差异: '不一致' } })
  const declaration = office.draftApplicability(call(), {
    focus: '网页应用：界面与后端一起设计',
    viewsPresent: ['context', 'component', 'runtime', 'data', 'deployment', 'ui'],
    viewsAbsent: [],
    artifacts: [],
    by: '模型起草',
  })
  assert.deepEqual(declaration.viewsPresent, ['context', 'component', 'runtime', 'data', 'deployment', 'ui'], 'ui 必须被保留')
  // 盘上真源必须也是 6 项（F-8 的复现点就是盘上只剩 5 项）
  const stored = office.storeFor(workspace).readYaml<{ applicability: { viewsPresent: string[] } }>('design', 'applicability.yml')
  assert.deepEqual(stored?.applicability.viewsPresent, ['context', 'component', 'runtime', 'data', 'deployment', 'ui'])
  // 三处共用渲染入口必须显示"界面视图"
  const lines = office.applicabilityLines(call()).join('\n')
  assert.ok(lines.includes(t('view.ui')), '声明渲染里必须出现界面视图')
  assert.equal(office.applicabilityCheck(call()).problems.length, 0, '多声明一个 ui 不得引入结构问题')

  // 反向：非法视图名**不得静默丢弃** —— 必须成为可读问题
  const bad = office.draftApplicability(call(), {
    focus: '网页应用',
    viewsPresent: ['context', 'component', 'runtime', 'data', 'deployment', 'frontend'],
    viewsAbsent: [],
    artifacts: [],
    by: '模型起草',
  })
  assert.deepEqual(bad.ignoredViews, ['frontend'], '不认识的视图名必须被记下来')
  const problems = office.applicabilityCheck(call()).problems.join('\n')
  assert.ok(problems.includes('frontend'), `非法视图名必须报出来：${problems}`)

  // 工具通道（报告的复现路径：`sdo_requirement action=applicability` 提交 6 项）必须同样保留 ui
  const harness = toolHarness(workspace)
  const receipt = await harness.callTool('sdo_requirement', {
    action: 'applicability',
    focus: '网页应用：界面与后端一起设计',
    viewsPresent: JSON.stringify([...ALL_VIEWS, 'ui']),
    viewsAbsent: JSON.stringify([]),
    artifacts: JSON.stringify([]),
    by: '模型起草',
  })
  const viaTool = office.storeFor(workspace).readYaml<{ applicability: { viewsPresent: string[] } }>('design', 'applicability.yml')
  assert.deepEqual(viaTool?.applicability.viewsPresent, [...ALL_VIEWS, 'ui'], '工具通道的 6 项声明不得丢掉 ui')
  assert.ok(receipt.includes(t('view.ui')), '工具回执里必须出现界面视图')
})

// —————————————————————— F-9 + F-7 + 工具通道端到端 ——————————————————————

test('F-7/F-9 工具通道端到端：create ui 视图 → 写方法产物 → C-27/C-29/C-2A 转绿', async () => {
  const requirementId = baselineRequirement()
  const harness = toolHarness(workspace)

  // ① 先复现两条 blocker 的"红"：还没有界面视图、还没有方法产物
  const redBefore = g3()
  assert.equal(criterion(redBefore.criteria, 'C-27').ok, false, '还没有界面视图时 C-27 必须是红的')
  assert.equal(criterion(redBefore.criteria, 'C-27').na, undefined, '含界面的项目里 C-27 不得是 N/A')
  assert.equal(criterion(redBefore.criteria, 'C-29').ok, false, '还没有方法产物时 C-29 必须是红的')

  // ② 走链：全部经工具通道（含 schema 过滤）
  const { uiWrite, artifact } = await designStageViaTools(harness, requirementId)

  // ③ 真源核对：ui 视图真的落盘（不是回执里说说）
  const uiFile = join(workspace, '.sdo/design/ui.yml')
  assert.ok(existsSync(uiFile), '界面视图必须真的写进 .sdo/design/ui.yml')
  const uiText = readFileSync(uiFile, 'utf8')
  for (const piece of ['UI-001', 'SCR-001', '差异清单', '编号', '12 栏']) {
    assert.ok(uiText.includes(piece), `ui.yml 缺 ${piece}`)
  }
  assert.ok(uiWrite.includes('UI-001'), '写入回执必须报告视图 id')
  assert.ok(uiWrite.includes('SCR-001'), '写入回执必须顺带给出待确认的界面 target')
  // 方法产物也真的落盘
  assert.ok(existsSync(join(workspace, '.sdo/design/method-dictionary.yml')), 'dictionary 产物必须落盘')
  assert.ok(artifact.includes(t('uiMethod.artifactOk').slice(0, 4)), `artifact 回执必须是"已写入"：${artifact}`)
  assert.equal(artifact.includes(t('uiMethod.artifactKindEmpty')), false, `artifact 不得报"未给种类"：${artifact}`)

  // ④ 只读通道 `action=view kind=ui` 仍可用（写入入口没有把它变成写操作）
  const readOnly = await harness.callTool('sdo_design', { action: 'view', kind: 'ui' })
  assert.ok(readOnly.includes('UI-001'), '只读查看必须能看到刚写入的界面视图')

  // ⑤ 方法选定 + 文档 + 声明 + 签字（仍走工具通道），再看三条判据转绿
  const methodQuestion = office.designIssues(call()).open.find((question) => question.targets.includes('design:method'))
  assert.ok(methodQuestion !== undefined, '前置：方法论选择题必须存在')
  await harness.callTool('sdo_design', { action: 'answer', questionId: methodQuestion.id, choice: 'structured' })
  for (const question of office.designIssues(call()).open) {
    await harness.callTool('sdo_design', { action: 'answer', questionId: question.id, choice: '0' })
  }
  await harness.callTool('sdo_adr', {
    action: 'record',
    title: '对账批处理窗口',
    context: '上游文件到达时间不稳定',
    decision: 'T+1 批处理，窗口 02:00–04:00',
    alternatives: JSON.stringify([{ option: '流式处理', pros: '时效高', cons: '运维成本高' }, { option: 'T+1 批处理', pros: '简单', cons: 'T+1' }]),
    consequences: JSON.stringify(['差异结果 T+1 可见']),
  })
  await harness.callTool('sdo_requirement', {
    action: 'applicability',
    focus: '网页应用：界面与后端一起设计',
    viewsPresent: JSON.stringify(ALL_VIEWS),
    viewsAbsent: JSON.stringify([]),
    artifacts: JSON.stringify([]),
    by: '模型起草',
  })
  await harness.callTool('sdo_requirement', { action: 'applicability-confirm', basis: '同意按这份声明走', by: '张三' })
  // 界面条目的确认戳必须能通过工具补上（F-9 的另一半：有写入入口还要能确认）
  for (const target of office.designConfirmGaps(call()).missing) {
    await harness.callTool('sdo_design', { action: 'confirm', target, note: '用户在会话中确认' })
  }
  // X-1：所有真源写完（声明 + 确认戳）之后**再**渲染文档 —— C-25 要求文档不早于最后一次真源变更
  await harness.callTool('sdo_design', { action: 'render' })

  // ⑥ 三条判据转绿（读的是门禁判据，来自真源现算）
  const after = g3()
  assert.equal(criterion(after.criteria, 'C-27').ok, true, `C-27 必须转绿：${criterion(after.criteria, 'C-27').detail}`)
  assert.equal(criterion(after.criteria, 'C-29').ok, true, `C-29 必须转绿：${criterion(after.criteria, 'C-29').detail}`)
  assert.equal(criterion(after.criteria, 'C-2A').ok, true, `C-2A 必须转绿：${criterion(after.criteria, 'C-2A').detail}`)

  // ⑦ G3 在工具通道上**整体可达**：签字后整门通过（不残留别的红项）
  await harness.callTool('sdo_gate', { action: 'sign', gate: 'G3', channel: 'statement', quote: '我签字确认这次设计可以放行', approvedBy: '张三' })
  const final = g3()
  const failures = final.criteria.filter((item) => !item.ok && item.na !== true).map((item) => `${item.id}:${item.detail}`)
  assert.deepEqual(failures, [], `G3 必须整体通过，实际红项：${failures.join(' | ')}`)
  assert.equal(final.status, 'passed', 'G3 必须判 passed')
})

// —————————————————————— F-9 边界（不许静默冲突） ——————————————————————

test('F-9 边界：五视图 kind 与 ui 同给 → 明确报冲突；kind=ui 缺 ui → 给出可执行的下一步', async () => {
  baselineRequirement()
  const harness = toolHarness(workspace)
  await harness.callTool('sdo_design', { action: 'review' })

  const conflict = await harness.callTool('sdo_design', { action: 'create', kind: 'component', name: 'X', ui: UI_VIEW_JSON })
  assert.equal(conflict, t('uiIndex.kUiConflict'), '同给两个视图必须明确报冲突（不许静默丢一个）')
  const missing = await harness.callTool('sdo_design', { action: 'create', kind: 'ui' })
  assert.equal(missing, t('uiIndex.kUiMissing'), 'kind=ui 缺 ui 时必须给出真实可用的调用方式')
  const bad = await harness.callTool('sdo_design', { action: 'create', kind: 'ui', ui: '{"style":{"source":"nope"}}' })
  assert.ok(bad.includes('follow-host'), `非法 style.source 必须列出合法取值：${bad}`)
  assert.equal(existsSync(join(workspace, '.sdo/design/ui.yml')), false, '三种失败都不得落盘')
})

// —————————————————————— F-7：schema ↔ handler 机械守卫 ——————————————————————

interface ToolSchemaView {
  name: string
  properties: string[]
}
interface ModuleView {
  file: string
  source: string
}

/**
 * 共享 handler 模块 → 承接它 `args` 的工具（**显式且带注释**，不做通配放过）。
 *
 * `lib/src/interface/designReceipt.js` 里的 `designInteraction` / `writeUiViewReceipt`
 * 处理的就是 `sdo_design` 的入参 —— F-7 的 `artifactKind`/`artifactData` 正是在这里被读的。
 * 新出现"读 args 但没登记"的模块会被守卫判红，必须在这里显式补一行。
 */
const SHARED_HANDLER_MODULES: Record<string, string[]> = {
  'designReceipt.js': ['sdo_design'],
}

/**
 * 不需要对模型暴露的**内部参数** allowlist（按 `工具名: 参数名`）。
 *
 * 空表示"当前没有内部参数"；一旦有人加了内部参数又想放过守卫，必须在这里留下名字与理由。
 * 守卫会同时检查**陈旧条目**（allowlist 里列了、实际并不缺 → 判红），防止用它蒙混。
 */
const INTERNAL_ARG_ALLOWLIST: readonly string[] = []

interface SchemaGapReport {
  /** handler 读了、schema 里没有的参数 */
  missing: string[]
  /** 读了 args 但没登记归属的模块（新脱节点会在这里露头） */
  unmappedModules: string[]
  /** 登记了却指向不存在的工具/模块（陈旧的归属表） */
  unknownTools: string[]
  /** allowlist 里列了、实际并不缺的条目（陈旧的豁免） */
  staleAllowlist: string[]
  /** 从编译产物里抽到归属的工具名（用于确认覆盖面对得上） */
  coveredTools: string[]
}

/** 从一段编译产物里抽出它对 `args.<name>` 的读取。 */
function argsReadsIn(code: string): string[] {
  return [...new Set([...code.matchAll(/\bargs\.([A-Za-z_$][\w$]*)/gu)].map((match) => match[1] as string))].sort()
}

/**
 * 从**编译产物**里静态提取每个工具 handler 对 `args.<name>` 的读取，与它的 schema `properties` 比对。
 *
 * 为什么读编译产物：`lib/src/interface/*.js` 是 handler **真正执行**的代码 ——
 * 读 TS 源码会被类型标注里的字段名迷惑（F-7 正是"类型声明有、handler 读、schema 漏"）。
 */
function findSchemaGaps(
  modules: ModuleView[],
  tools: ToolSchemaView[],
  shared: Record<string, string[]>,
  allowlist: readonly string[] = [],
): SchemaGapReport {
  const byTool = new Map<string, Set<string>>()
  const add = (tool: string, name: string): void => {
    const set = byTool.get(tool) ?? new Set<string>()
    set.add(name)
    byTool.set(tool, set)
  }
  const unmappedModules: string[] = []
  const unknownTools: string[] = []
  for (const module of modules) {
    const reads = argsReadsIn(module.source)
    if (reads.length === 0) continue
    if (module.file === 'tools.js') {
      // 编译产物里每条工具是 `defineTool({ name: 'sdo_x', … })`；按 name 切片归属。
      const marks = [...module.source.matchAll(/name: '(sdo_[a-z_]+)',\s*\n\s*description:/gu)]
        .map((match) => ({ name: match[1] as string, at: match.index ?? 0 }))
      for (const [index, mark] of marks.entries()) {
        const end = index + 1 < marks.length ? (marks[index + 1]?.at ?? module.source.length) : module.source.length
        for (const name of argsReadsIn(module.source.slice(mark.at, end))) add(mark.name, name)
      }
      continue
    }
    const owners = shared[module.file]
    if (owners === undefined) {
      unmappedModules.push(`${module.file}: ${reads.join(',')}`)
      continue
    }
    for (const owner of owners) for (const name of reads) add(owner, name)
  }
  for (const [file, owners] of Object.entries(shared)) {
    if (!modules.some((module) => module.file === file)) unknownTools.push(`${file}（登记了但编译产物里没有这个模块）`)
    for (const owner of owners) {
      if (!tools.some((tool) => tool.name === owner)) unknownTools.push(`${file} → ${owner}（没有这个工具）`)
    }
  }

  const missingAll: string[] = []
  for (const [tool, reads] of byTool) {
    const schema = tools.find((item) => item.name === tool)
    if (schema === undefined) {
      unknownTools.push(`编译产物里有工具 ${tool}，但运行时工具集里没有它`)
      continue
    }
    for (const name of reads) {
      if (schema.properties.includes(name)) continue
      missingAll.push(`${tool}:${name}`)
    }
  }
  // allowlist 是"按 工具:参数 精确放过"，且**只能放过真的缺失的**：schema 里已有的参数
  // 若被列进 allowlist 就是陈旧豁免（守卫据此判红，防止用通配掩盖新的脱节）。
  const missing = missingAll.filter((entry) => !allowlist.includes(entry))
  const staleAllowlist = allowlist.filter((entry) => !missingAll.includes(entry))
  return { missing, unmappedModules, unknownTools, staleAllowlist, coveredTools: [...byTool.keys()].sort() }
}

function compiledInterfaceModules(): ModuleView[] {
  const dir = join(ROOT, 'lib/src/interface')
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.map.js'))
    .sort()
    .map((name) => ({ file: name, source: readFileSync(join(dir, name), 'utf8') }))
}

test('F-7 守卫：编译产物里 handler 读的每个 args.X 都必须在工具 JSON schema 的 properties 里', () => {
  const harness = toolHarness(workspace)
  const schemas: ToolSchemaView[] = harness.tools.map((tool) => ({
    name: tool.name,
    properties: Object.keys((tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}),
  }))
  const modules = compiledInterfaceModules()
  assert.ok(modules.length >= 8, `必须真的扫到编译产物里的 interface 模块，实际 ${modules.length}`)

  const report = findSchemaGaps(modules, schemas, SHARED_HANDLER_MODULES, INTERNAL_ARG_ALLOWLIST)
  assert.deepEqual(report.missing, [], `这些 handler 参数没进 schema（宿主会按 schema 丢掉它们）：${report.missing.join(', ')}`)
  assert.deepEqual(report.unmappedModules, [], `这些编译模块读了 args 但没登记归属（新增脱节点会从结构化整地漏过）：${report.unmappedModules.join('; ')}`)
  assert.deepEqual(report.unknownTools, [], `归属表/工具集不一致：${report.unknownTools.join('; ')}`)
  assert.deepEqual(report.staleAllowlist, [], `allowlist 里有已经不需要的条目（陈旧的豁免）：${report.staleAllowlist.join(', ')}`)
  // 覆盖面：所有**带参数的**工具都必须被静态扫到（不是只盯 sdo_design），
  // 否则守卫会有盲区。无参工具（properties 为空）天然不会被扫到，故不作为期望。
  const withParams = schemas.filter((schema) => schema.properties.length > 0)
  assert.ok(withParams.length >= 20, `带参数的工具应有 20 条，实际 ${withParams.length}`)
  assert.deepEqual(
    report.coveredTools,
    withParams.map((schema) => schema.name).sort(),
    '静态提取必须覆盖全部带参数的工具，否则守卫会有盲区',
  )
  // F-7 的两个参数必须在场（这条是"守卫真的管用"的自证）
  const design = schemas.find((schema) => schema.name === 'sdo_design')
  assert.ok(design !== undefined)
  for (const param of ['artifactKind', 'artifactData', 'ui']) {
    assert.ok(design.properties.includes(param), `sdo_design 的 schema 必须暴露 ${param}`)
  }
})

test('F-7 守卫自证：把 handler 读的参数从 schema 里去掉，守卫必须报出来（不是空断言）', () => {
  // 合成一份"编译产物 + schema"，复刻 F-7 的形态：handler 读 args.artifactKind，schema 没有它
  const modules: ModuleView[] = [
    {
      file: 'designReceipt.js',
      source: 'export function writeMethodArtifactReceipt(office, call, args) { const kind = (args.artifactKind ?? "").trim(); return args.artifactData; }',
    },
    {
      file: 'tools.js',
      source: "defineTool({\n name: 'sdo_design',\n description: 'd',\n parameters: {},\n async execute(args) { return args.ui }\n})",
    },
  ]
  const tools: ToolSchemaView[] = [{ name: 'sdo_design', properties: ['ui'] }]
  const report = findSchemaGaps(modules, tools, { 'designReceipt.js': ['sdo_design'] })
  assert.deepEqual(report.missing.sort(), ['sdo_design:artifactData', 'sdo_design:artifactKind'])
  assert.deepEqual(report.coveredTools, ['sdo_design'])
  // 没登记的模块必须露头
  const unmapped = findSchemaGaps([...modules, { file: 'brandNew.js', source: 'x => x.args.mystery' }], tools, { 'designReceipt.js': ['sdo_design'] })
  assert.deepEqual(unmapped.unmappedModules, ['brandNew.js: mystery'])
  // allowlist 只能按"工具:参数"精确放过，且放过之后不得留下"陈旧豁免"
  const allowed = findSchemaGaps(modules, tools, { 'designReceipt.js': ['sdo_design'] }, ['sdo_design:artifactKind', 'sdo_design:artifactData'])
  assert.deepEqual(allowed.missing, [])
  assert.deepEqual(allowed.staleAllowlist, [])
  const stale = findSchemaGaps(modules, tools, { 'designReceipt.js': ['sdo_design'] }, ['sdo_design:artifactKind', 'sdo_design:artifactData', 'sdo_design:ui'])
  assert.deepEqual(stale.staleAllowlist, ['sdo_design:ui'], 'schema 里已有的参数不得被 allowlist 豁免')
})

// —————————————————————— F-9 的边界解析（domain 层） ——————————————————————

test('F-9 解析器：缺字段补空、缺 id 顺序分配，类型错误显式报错（不静默吞）', () => {
  const parsed = parseUiViewInput(JSON.stringify({
    style: { source: 'enterprise' },
    screens: [{ name: '首页', columns: [{ name: '编号' }], layout: { grid: '12 栏' } }],
  }))
  assert.ok('view' in parsed, `合法输入必须解析成功：${'error' in parsed ? parsed.error : ''}`)
  if (!('view' in parsed)) return
  assert.equal(parsed.view.id, 'UI-001', '缺 id 时给稳定默认 id')
  assert.equal(parsed.view.screens[0]?.id, 'SCR-001', '缺页面 id 时按顺序分配')
  assert.deepEqual(parsed.view.screens[0]?.layout.regions, [], '缺 regions 补空数组')
  assert.equal(parsed.view.accessibility.keyboard, false, '缺 accessibility 时补默认值')

  const cases: [string, string][] = [
    ['not json', '无法解析'],
    ['[]', t('uiDesign.uiInputNotObject')],
    ['{"screens":[]}', t('uiDesign.uiInputBadStyle')],
    ['{"style":{"source":"nope"}}', 'follow-host'],
    ['{"style":{"source":"minimal"},"screens":{}}', t('uiDesign.uiInputBadScreens')],
    ['{"style":{"source":"minimal"},"screens":[{"columns":{}}]}', fmt('uiDesign.uiInputBadColumns', { p1: 'SCR-001' })],
    ['{"style":{"source":"minimal"},"breakpoints":{}}', t('uiDesign.uiInputBadBreakpoints')],
  ]
  for (const [raw, marker] of cases) {
    const bad = parseUiViewInput(raw)
    assert.ok('error' in bad, `非法输入必须报错：${raw}`)
    if (!('error' in bad)) continue
    assert.ok(bad.error.includes(marker), `错误信息应指向「${marker}」：${bad.error}`)
  }
})
