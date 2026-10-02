/**
 * 增量 6（本轮需求）：需求/设计流程口径修正的回归。
 *
 *   D1  需求基线签字**以签字台账为准**（G2 有自己的失效事件集合；`approvedBy` 只是附加信息）
 *   D2  `advance` 按**当前事实**现算出口门禁（`gates/*.json` 退化为判定留痕；`waiveGate` 仍是合法出口）
 *   D3  评分口径**不变**（答案正文不参与评分）—— 做一次"实现与文案同源"的确认
 *   D4  未决 P1 必须**有风险处置**，否则 C2 判红并点名（`RiskItem.origin` 的 token 口径）
 *   D5  `applicability.artifactsAbsent`（逐条 why 必填）→ C-2C 判红；与 absent 视图同口径
 *   §6.7 `change` 重算评分**保留模型通道语义分**、规则维度按新内容重算
 *
 * 纪律：断言只读**真源**（`.sdo/` 下的 yml / json / journal 与门禁判据），不采信任何自述；
 * 工具通道用例按 **schema 过滤入参**后调用真实工具（复现宿主的入参过滤）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { applicabilityState, readApplicabilityChecked } from '../src/domain/applicability.js'
import { hasRiskDisposition } from '../src/domain/dor.js'
import { fmt, t } from '../src/domain/i18n.js'
import { loadScoring, ruleChannel } from '../src/domain/scoring.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import { G2_SIGNATURE_INVALIDATING_EVENTS, isSignatureInvalidatingEvent } from '../src/types.js'
import type { GateCriterionResult, RiskItem, ViewKind } from '../src/types.js'
import { disposeOpenP1, prepareG2, signG2 } from './support/g2-fixture.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m20/', import.meta.url))
const ALL_VIEWS: ViewKind[] = ['context', 'component', 'runtime', 'data', 'deployment']
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
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function criterion(criteria: GateCriterionResult[], id: string): GateCriterionResult {
  const found = criteria.find((item) => item.id === id)
  assert.ok(found !== undefined, `门禁里必须有判据 ${id}`)
  return found
}

const gateRecord = (gate: string): { status: string } =>
  JSON.parse(readFileSync(join(workspace, '.sdo', 'gates', `${gate}.json`), 'utf8')) as { status: string }

/** 写一条**陈旧的** `passed` 门禁记录（旧实现的"永久通行证"；D2 之后不得再放行）。 */
function stalePass(gate: string, phase: string): void {
  office.storeFor(workspace).writeJson(['gates', `${gate}.json`], {
    gate,
    phase,
    status: 'passed',
    at: new Date().toISOString(),
    criteria: [],
    remedy: [],
  })
}

/** 立项台账齐备（G0 需要的四格）+ 可行性结论齐备（G1 需要的三格）。 */
function setupThroughG0(): void {
  office.init(call(), { name: 'M20 测试', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call(), {
    scopeIn: ['对账差异检测'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['差异识别率 ≥ 99%'],
    glossary: { 差异: '同一笔业务在两侧系统的不一致记录' },
  })
}

/** 让 G1 真源转绿（Go 结论 + 已登记风险 + PoC 建议）。 */
function greenG1(): void {
  office.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  office.logRisk(call(), { title: '格式变更', level: 'low', probability: 'low', impact: '小', mitigation: '校验', owner: '业务方' })
}

// —————————————————————— D2：advance 现算出口门禁 ——————————————————————

test('D2 反例：陈旧的 passed 记录不得放行；判定留痕照写（gates/*.json 退化为留痕）', () => {
  setupThroughG0()
  assert.equal(office.checkGate(call(), 'G0').status, 'passed', '前置：G0 应通过')
  assert.equal(office.advance(call()).to, 'feasibility', '前置：应推进到可行性阶段')

  // 旧实现的"永久通行证"：盘上写一条 passed G1 记录
  stalePass('G1', 'feasibility')
  assert.equal(gateRecord('G1').status, 'passed', '前置：陈旧记录确实写进去了')

  const blocked = office.advance(call())
  assert.equal(blocked.advanced, false, 'G1 真源未绿时，陈旧的 passed 记录不得放行')
  assert.equal(blocked.blockedBy, 'G1', '必须拦住')
  assert.ok((blocked.remedy ?? []).length > 0, '被拦时必须给出 remake/remedy')
  assert.equal(gateRecord('G1').status, 'failed', '现算结果必须照写到判定留痕里（覆盖陈旧记录）')
})

test('D2 正例：真源转绿后 advance 通过，且留痕被现算结果刷新', () => {
  setupThroughG0()
  office.checkGate(call(), 'G0')
  assert.equal(office.advance(call()).to, 'feasibility')
  greenG1()
  const step = office.advance(call())
  assert.equal(step.advanced, true, 'G1 真源转绿后必须放行')
  assert.equal(step.to, 'requirements')
  assert.equal(gateRecord('G1').status, 'passed', '现算通过也要写留痕')
})

test('D2：G2 也现算 —— 只写 passed 记录、真源没签字时需求阶段出口被拦', () => {
  setupThroughG0()
  office.checkGate(call(), 'G0')
  office.advance(call())
  greenG1()
  office.advance(call())
  assert.equal(office.status(call()).project?.phase, 'requirements', '前置：已在需求阶段')
  office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call(), {
    id: office.requirements(call())[0]!.id,
    addAcceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
    modelDimensions: ALL2,
  })
  const requirementId = office.requirements(call())[0]!.id
  office.redTeamAttack(call(), [requirementId], 7)
  let guard = 0
  while (guard++ < 40) {
    const open = office.questions(call()).filter((question) => question.status === 'open')
    if (open.length === 0) break
    office.answer(call(), { id: open[0]!.id, answer: '已确认', modelDimensions: ALL2 })
  }
  // 陈旧通行证
  stalePass('G2', 'requirements')
  const blocked = office.advance(call())
  assert.equal(blocked.advanced, false, '没有台账签字时，陈旧的 passed G2 记录不得放行')
  assert.equal(blocked.blockedBy, 'G2')
  assert.equal(
    criterion(office.evaluate(call(), 'G2', '张三').criteria, 'C7-signoff').ok,
    false,
    '拦住的根因必须是 C7（签字台账）而不是其它',
  )

  // 真签 + 补 P1 风险处置 → 现算通过 → 放行
  prepareG2(office, call())
  const step = office.advance(call())
  assert.equal(step.advanced, true, `签字后必须放行：${(step.remedy ?? []).join(' | ')}`)
  assert.equal(step.to, 'architecture')
})

test('D2：waiveGate 仍是合法豁免出口（现算返回 waived 并放行）', () => {
  setupThroughG0()
  office.checkGate(call(), 'G0')
  office.advance(call())
  // G1 真源**故意不绿**：豁免就是"不判定但放行"
  const recorded = office.waiveGate(call(), 'G1', '本次为内部试验，先跳过可行性门', '项目经理')
  assert.equal(recorded.status, 'waived')
  const step = office.advance(call())
  assert.equal(step.advanced, true, '豁免后必须能推进（waiveGate 仍是合法出口）')
  assert.equal(step.to, 'requirements')
  assert.equal(gateRecord('G1').status, 'waived', '留痕记录豁免状态')
})

/**
 * **§3.5-2：`status().pendingGate` 必须与 `advance` 同源（现算），不读 `gates/*.json` 留痕。**
 *
 * 这是注入块/看板给模型的主要指引。旧实现按"盘上有没有一条通过记录"算，
 * 于是真源变坏之后注入块仍说"门禁都过了"，而 `advance` 当场拦人 —— 模型收到自相矛盾的指引。
 */
test('§3.5-2：status().pendingGate 现算 —— 陈旧的 passed 留痕不得让注入块漏报当前不通过的门禁', () => {
  readyForG2()
  prepareG2(office, call())
  assert.equal(office.baseline(call(), { approvedBy: '张三' }).ok, true, '前置：基线应通过')
  // `baseline` 自己会推进到架构阶段；要看"需求阶段的出口门禁 G2"，用流程数据声明的回退边退回去。
  const back = office.rollbackPhase(call(), { to: 'requirements', reason: '本用例要在需求阶段观察出口门禁' })
  assert.equal(back.ok, true, `前置：架构阶段应能退回需求：${back.error ?? ''}`)
  assert.equal(office.status(call()).project?.phase, 'requirements', '前置：已回到需求阶段')

  // 回退作废了 G2 的判定留痕；这里手工写一条"永久通行证"，复刻旧实现眼里的乐观状态。
  assert.equal(existsSync(join(workspace, '.sdo', 'gates', 'G2.json')), false, '前置：回退已作废 G2 的留痕')
  stalePass('G2', 'requirements')
  assert.equal(gateRecord('G2').status, 'passed', '前置：陈旧的 passed 留痕确实在盘上')

  // 让真源真的变坏：新增一条 must 需求 → `requirement/captured` 在 G2 的失效事件集合里
  // → 台账签字失效 → G2 的 C7 判红。**这一步不碰留痕**（不改写、不删除 G2.json）。
  office.capture(call(), {
    title: '新增需求（会让基线签字失效）',
    statement: '系统须在每日对账后识别差异并生成报表；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  assert.equal(gateRecord('G2').status, 'passed', '前置：留痕仍是陈旧的 passed（本用例的反例输入）')

  // 同源断言①：注入块/看板的待判定门禁必须点名"当前不通过"的 G2
  assert.equal(
    office.status(call()).pendingGate,
    'G2',
    '真源变坏后，status().pendingGate 必须现算出 G2（读留痕会让它漏报）',
  )
  // 同源断言②：`advance` 与 `status()` 必须一致 —— 它被 G2 拦住
  const blocked = office.advance(call())
  assert.equal(blocked.advanced, false, '签字失效后 advance 必须被拦住')
  assert.equal(blocked.blockedBy, 'G2', '拦住它的必须是 G2')

  // **正例**：把真源补齐（新需求给验收标准与语义分）+ 重签 → 两者同时放行，且不再有"待判定门禁"。
  const added = office.requirements(call()).map((item) => item.id).sort().at(-1)
  assert.ok(added !== undefined)
  office.update(call(), {
    id: added,
    addAcceptance: [{ id: 'AC-002', given: '已导入两日文件', when: '执行对账', then: '输出差异清单' }],
    modelDimensions: ALL2,
  })
  prepareG2(office, call())
  assert.equal(
    office.status(call()).pendingGate,
    undefined,
    '现算通过后不得再报待判定门禁（与 advance 放行一致）',
  )
  const step = office.advance(call())
  assert.equal(step.advanced, true, `补齐真源并重签后必须放行：${(step.remedy ?? []).join(' | ')}`)
  assert.equal(step.to, 'architecture')
})

// —————————————————————— D1：G2 的失效事件集合 ——————————————————————

test('D1 / N-7：G2 用白名单、G3 用黑名单（白名单漏一个真源就留一个洞）', () => {
  const g2 = new Set<string>(G2_SIGNATURE_INVALIDATING_EVENTS)
  // G2 必须覆盖需求侧真源
  for (const event of ['requirement/captured', 'requirement/updated', 'project/updated', 'risk/logged']) {
    assert.equal(g2.has(event), true, `G2 必须把 ${event} 当作失效事件`)
  }
  // G2 不得包含设计侧独有真源（否则改设计会作废需求签字 —— 与"背书各自那份真源"矛盾）
  assert.equal(g2.has('design/updated'), false, '改了设计不该作废需求基线签字')
  assert.equal(g2.has('contract/recorded'), false, '改契约不该作废需求基线签字')
  // 反向：G3 用**黑名单**（N-7）—— 这些真源写入都必须让架构签字失效，
  // 其中后两条正是独立复核实证漏掉的那批（白名单口径下"签字后塞进一条门禁明明会拒绝的 ADR"仍判绿）。
  for (const event of ['design/updated', 'contract/recorded', 'adr/recorded', 'trace/linked']) {
    assert.equal(isSignatureInvalidatingEvent('G3', event), true, `G3 必须把 ${event} 当作失效事件`)
  }
  // 黑名单必须排除"不改设计真源"的事件（否则签字会被自己的记账动作作废）
  for (const event of ['design/rendered', 'gate/result', 'gate/signed', 'phase/entered', 'phase/exited', 'phase/rolled-back', 'task/done', 'cost/updated']) {
    assert.equal(isSignatureInvalidatingEvent('G3', event), false, `${event} 不是真源变更，不得作废 G3 签字`)
  }
  // **P-16**：红队/议题/质量场景这三类"写入但不改 `DESIGN.md` 渲染结果"的动作也算中性 ——
  // 实测（固定同一 seq 重渲染）：跑一轮红队、记一条质量场景，正文逐字节不变；
  // 而 `design/grill`/`question/*` 会变，所以它们**不**在中性表里。
  for (const event of ['redteam/attack', 'redteam/file', 'issue/opened', 'issue/closed', 'quality/recorded']) {
    assert.equal(isSignatureInvalidatingEvent('G3', event), false, `${event} 不改设计正文，不得作废 G3 签字`)
  }
  for (const event of ['design/grill', 'question/asked', 'question/answered']) {
    assert.equal(isSignatureInvalidatingEvent('G3', event), true, `${event} 会改变设计文档（未决数/答案），必须作废 G3 签字`)
  }
  // **默认方向**：未见过的（未来新增的）事件类型一律失效 —— 黑名单的全部意义就在这里
  assert.equal(isSignatureInvalidatingEvent('G3', 'future/brand-new-truth-write'), true, '黑名单口径下新增事件默认失效')
  // **基线动作本身**不得让 G2 签字自失效（否则"内容未改重新冻结"永远过不去）；
  // G3 的黑名单**有意**不排除 `requirement/baselined`（需求重新冻结 → 设计背书必须重来），保持既有口径。
  assert.equal(g2.has('requirement/baselined'), false, 'G2：baseline 自身不属于失效事件')
  assert.equal(isSignatureInvalidatingEvent('G3', 'requirement/baselined'), true, 'G3：需求重新冻结仍须重签')
})

test('N-7 反例：签字后新增一条"只写结论"的 ADR → G3 签字必须失效（adr/recorded 曾是白名单漏洞）', () => {
  baselinedRequirement()
  office.renderDesign(call())
  office.signGate(call(), { gate: 'G3', by: '张三', basis: '我确认这次设计可以放行', channel: 'command' })
  assert.equal(office.signatureState(call(), 'G3').status, 'valid', '前置：G3 签字有效')

  // 攻击（独立复核的原始形态）：签字之后新增一条**缺备选/后果**的 ADR —— 门禁 C-22 明确会拒绝它。
  office.recordAdr(call(), {
    title: '签字后的偷渡决策',
    context: '想绕过签字复核',
    decision: '就这么办',
    alternatives: [],
    consequences: [],
  })
  const state = office.signatureState(call(), 'G3')
  assert.equal(state.status, 'stale', `签字必须失效：${state.reason}`)
  assert.match(state.reason, /adr\/recorded/u, `失效理由必须点名那次真源写入：${state.reason}`)
  // 双向：C-2D 因此判红（不再"签字有效"地放行）
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-2D').ok, false, '签字失效后 C-2D 必须判红')
})

test('D1 工具通道：sdo_gate action=sign gate=G2 的回执必须写出失效事件集合', async () => {
  setupThroughG0()
  const harness = toolHarness(workspace)
  const receipt = await harness.callTool('sdo_gate', {
    action: 'sign',
    gate: 'G2',
    channel: 'statement',
    quote: '我确认需求基线可以冻结',
    approvedBy: '张三',
  })
  assert.match(receipt, /requirement\/updated/u, `签字回执必须列出 G2 的失效事件集合：\n${receipt}`)
  assert.match(receipt, /project\/updated/u, `必须包含项目真源事件：\n${receipt}`)
  assert.match(receipt, /risk\/logged/u, `必须包含风险真源事件（D4 的关联口径依赖它）：\n${receipt}`)
  assert.equal(office.signatureState(call(), 'G2').status, 'valid', '签字必须真的落进台账')
})

// —————————————————————— D3：评分口径不变（答案正文不参与评分）——————————————————————

test('D3：答案正文不参与评分（即便正文里全是可测关键词），文案与实现同源', () => {
  setupThroughG0()
  office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  const id = office.requirements(call())[0]!.id
  office.grill(call(), { requirementIds: [id] })
  const question = office.questions(call()).find((item) => item.status === 'open')
  assert.ok(question !== undefined, '前置：必须有未决问题')

  const before = office.requirements(call())[0]!
  // 正文里塞满 measurable / constraint / scenario 关键词（若正文参与评分，这些维度必然变化）
  office.answer(call(), {
    id: question.id,
    answer: '单日 100 万条，P99 < 200 毫秒，QPS 峰值 5000，异常时降级并重试，状态机三态迁移',
  })
  const after = office.requirements(call())[0]!
  assert.equal(after.ambiguity.score, before.ambiguity.score, '答案正文不得改变评分')
  assert.deepEqual(after.ambiguity.dimensions, before.ambiguity.dimensions, '答案正文不得改变任何维度')

  // 实现同源：规则通道的评分文本取 statement / rationale / acceptance，**不含 answer**
  const model = loadScoring()
  const rule = ruleChannel({ requirement: after, model, context: { nonGoalsDeclared: true, hasSuccessMetrics: true } })
  assert.equal(typeof rule.base.constraint, 'number', '规则通道只看需求文本')
  // 文案必须如实说明"答案不改分"并给出可移动评分的入口
  assert.match(t('uiDor.c1Remedy'), /答案正文本身不改分/u)
  assert.match(t('uiDor.c1Remedy'), /dimensions/u)
})

// —————————————————————— D4：P1 → 风险的关联口径 ——————————————————————

const riskWithOrigin = (origin: string | undefined): RiskItem => ({
  id: 'RISK-001',
  title: '未决 P1',
  level: 'medium',
  probability: 'medium',
  impact: '小',
  mitigation: '在设计阶段回答',
  owner: '业务方',
  status: 'open',
  ...(origin === undefined ? {} : { origin }),
  at: new Date().toISOString(),
})

test('D4：关联口径是 origin 的空白分隔 token（全等才算，子串不算）', () => {
  assert.equal(hasRiskDisposition('Q-0035', [riskWithOrigin('Q-0035')]), true, '全等必须算')
  assert.equal(hasRiskDisposition('Q-0035', [riskWithOrigin('Q-0035 redteam')]), true, '多来源 token 写法必须算')
  assert.equal(hasRiskDisposition('Q-0035', [riskWithOrigin('redteam Q-0035')]), true, 'token 顺序无关')
  assert.equal(hasRiskDisposition('Q-0035', [riskWithOrigin('Q-003')]), false, '子串不得算（Q-003 ≠ Q-0035）')
  assert.equal(hasRiskDisposition('Q-0035', [riskWithOrigin('XQ-0035')]), false, '粘连前缀不得算')
  assert.equal(hasRiskDisposition('Q-0035', [riskWithOrigin(undefined)]), false, '没有 origin 的风险不算处置')
  assert.equal(hasRiskDisposition('Q-0035', []), false, '没有风险登记就不算处置')
})

test('D4 反例：未决 P1 的风险 origin 指错问题 → C2 仍判红并点名', () => {
  setupThroughG0()
  office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  const id = office.requirements(call())[0]!.id
  office.update(call(), { id, addAcceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }], modelDimensions: ALL2 })
  office.grill(call(), { requirementIds: [id] })
  // 把全部问题答掉，再手工造一条未决 P1（避免依赖题库的严重度分布）
  let guard = 0
  while (guard++ < 60) {
    const open = office.questions(call()).filter((question) => question.status === 'open')
    if (open.length === 0) break
    office.answer(call(), { id: open[0]!.id, answer: '已确认', modelDimensions: ALL2 })
  }
  // 一条未决 P1：用红线问题账本的 open 状态
  office.grill(call(), { requirementIds: [id] })
  const p1 = office.questions(call()).find((question) => question.status === 'open' && question.severity === 'P1')
  if (p1 !== undefined) {
    office.logRisk(call(), {
      title: '指错问题的风险',
      level: 'medium',
      probability: 'medium',
      impact: '小',
      mitigation: '无',
      owner: '业务方',
      origin: 'Q-9999',
    })
    const c2 = criterion(office.evaluate(call(), 'G2', '张三').criteria, 'C2-open-questions')
    assert.equal(c2.ok, false, '风险 origin 指错问题时 C2 必须判红')
    assert.ok(c2.detail.includes(p1.id), `必须点名缺处置的问题 ${p1.id}：${c2.detail}`)
  }
})

// —————————————————————— D5：artifactsAbsent ——————————————————————

test('D5：artifactsAbsent 缺 why → C-2C 判红并点名；补齐理由后转绿', () => {
  office.init(call(), { name: 'D5 测试', scale: 'normal', stakeholders: ['业务方'] })
  office.draftApplicability(call(), {
    focus: '只改数据与组件，不涉及界面',
    viewsPresent: [],
    viewsAbsent: ALL_VIEWS.map((kind) => ({ kind, why: '本次改造不涉及该视图' })),
    artifacts: [],
    artifactsAbsent: [{ kind: 'mapping', why: '   ' }],
  })

  // ① 结构判读：与 absent 视图同口径，逐条 why 必填
  const state = applicabilityState(office.storeFor(workspace))
  assert.equal(state.status, 'incomplete', '声明结构必须被判为不完整')
  assert.ok(
    state.problems.some((problem) => problem.includes(t('applicabilityArtifact.mapping'))),
    `结构问题必须点名缺理由的工件：${state.problems.join('；')}`,
  )

  // ② C-2C 必须判红并点名（这是本条的硬要求）
  const red = criterion(office.evaluate(call(), 'G3').criteria, 'C-2C')
  assert.equal(red.ok, false, '声明为不做却没写理由时 C-2C 必须判红')
  assert.ok(red.detail.includes(t('applicabilityArtifact.mapping')), `C-2C 必须点名：${red.detail}`)
  assert.equal(red.na === true, false, '这不是 N/A —— 是失败')

  // ③ 补齐理由 → C-2C 转绿，且理由出现在判据详情里（不得静默）
  office.draftApplicability(call(), {
    focus: '只改数据与组件，不涉及界面',
    viewsPresent: [],
    viewsAbsent: ALL_VIEWS.map((kind) => ({ kind, why: '本次改造不涉及该视图' })),
    artifacts: [],
    artifactsAbsent: [{ kind: 'mapping', why: '旧库不迁移，映射表没有对应物' }],
  })
  const green = criterion(office.evaluate(call(), 'G3').criteria, 'C-2C')
  assert.equal(green.ok, true, `补齐理由后 C-2C 应转绿：${green.detail}`)
  assert.ok(green.detail.includes('旧库不迁移'), `不做理由必须原样展示：${green.detail}`)
})

test('D5：手写 YAML —— 标量写法按单条目处理（why 为空 → 判红，可读失败而非崩溃）', () => {
  office.init(call(), { name: 'D5 手写测试', scale: 'normal', stakeholders: ['业务方'] })
  office.storeFor(workspace).writeYaml(['design', 'applicability.yml'], {
    applicability: {
      focus: '手写声明',
      viewsPresent: [],
      viewsAbsent: ALL_VIEWS.map((kind) => ({ kind, why: '不涉及' })),
      artifacts: [],
      // 标量写在列表位置（少写了 `-`）：按单条目处理 + 结构提示
      artifactsAbsent: 'mapping',
      draftedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })
  const read = readApplicabilityChecked(office.storeFor(workspace))
  assert.equal(read.applicability?.artifactsAbsent.length, 1, '标量必须变成单条目（不静默丢弃）')
  assert.equal(read.applicability?.artifactsAbsent[0]?.kind, 'mapping')
  assert.equal(read.applicability?.artifactsAbsent[0]?.why, '', 'why 缺失按空处理')
  assert.ok(read.notes.length > 0, '必须留下形状提示（F-20/F-21 的输入校验，不是兼容）')
  const c2c = criterion(office.evaluate(call(), 'G3').criteria, 'C-2C')
  assert.equal(c2c.ok, false, 'why 为空 → C-2C 判红（可读的失败，不是崩溃）')
})

test('D5：既说做又说不做 → C-2C 判红（不自相矛盾）；不认识的工件名不得静默丢弃', () => {
  office.init(call(), { name: 'D5 冲突测试', scale: 'normal', stakeholders: ['业务方'] })
  office.storeFor(workspace).writeYaml(['design', 'applicability.yml'], {
    applicability: {
      focus: '手写声明',
      viewsPresent: [],
      viewsAbsent: ALL_VIEWS.map((kind) => ({ kind, why: '不涉及' })),
      artifacts: ['mapping'],
      artifactsAbsent: [{ kind: 'mapping', why: '又说做又说不做' }],
      draftedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })
  // `normalizeApplicability` 会去掉这种写法，但**手写真源**能绕过去 → 门禁必须判红
  assert.equal(applicabilityState(office.storeFor(workspace)).status, 'incomplete', '矛盾声明必须被判为结构问题')
  const conflict = criterion(office.evaluate(call(), 'G3').criteria, 'C-2C')
  assert.equal(conflict.ok, false, '既做又不做必须判红')
  assert.match(conflict.detail, /自相矛盾/u, `理由要说明自相矛盾：${conflict.detail}`)

  // 不认识的工件名：原样报出（不得静默消失）
  office.draftApplicability(call(), {
    focus: '手写声明',
    viewsPresent: [],
    viewsAbsent: ALL_VIEWS.map((kind) => ({ kind, why: '不涉及' })),
    artifacts: [],
    artifactsAbsent: [{ kind: 'sbom', why: '本次不做' }],
  })
  const ignored = applicabilityState(office.storeFor(workspace))
  assert.ok(ignored.declaration?.ignoredArtifacts?.includes('sbom'), '不认识的工件名必须被记下来')
  assert.ok(
    ignored.problems.some((problem) => problem.includes('sbom')),
    `结构问题必须点名它：${ignored.problems.join('；')}`,
  )
})

test('D5：无声明工件时仍是 N/A（三态不变）；声明了要做但缺 → 判红（既有口径不放松）', () => {
  office.init(call(), { name: 'D5 三态测试', scale: 'normal', stakeholders: ['业务方'] })
  office.draftApplicability(call(), {
    focus: '只改数据',
    viewsPresent: [],
    viewsAbsent: ALL_VIEWS.map((kind) => ({ kind, why: '不涉及' })),
    artifacts: [],
    artifactsAbsent: [],
  })
  const na = criterion(office.evaluate(call(), 'G3').criteria, 'C-2C')
  assert.equal(na.na, true, '两处都没列 → N/A')
  assert.equal(na.ok, false, 'N/A 不是"通过"')

  office.draftApplicability(call(), {
    focus: '只改数据',
    viewsPresent: [],
    viewsAbsent: ALL_VIEWS.map((kind) => ({ kind, why: '不涉及' })),
    artifacts: ['invariants'],
    artifactsAbsent: [],
  })
  const red = criterion(office.evaluate(call(), 'G3').criteria, 'C-2C')
  assert.equal(red.ok, false, '声明了要做却缺产物 → 判红')
  assert.match(red.detail, /不变量/u, `必须点名缺哪个工件：${red.detail}`)
})

// —————————————————————— §6.7：change 重算评分 ——————————————————————

/** 把一条需求做到"G2 数据齐备、但**还没有签字**"（D1 的复现前提；模型通道只给 data / interface）。 */
function readyForG2(): string {
  office.init(call(), { name: 'D6.7 测试', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call(), {
    scopeIn: ['对账'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['识别率 ≥ 99%'],
    glossary: { 差异: '不一致记录' },
  })
  office.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  office.logRisk(call(), { title: '格式变更', level: 'low', probability: 'low', impact: '小', mitigation: '校验', owner: '业务方' })
  office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒，异常时降级',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  const id = office.requirements(call())[0]!.id
  office.update(call(), {
    id,
    addAcceptance: [{ id: 'AC-001', given: '已导入两日文件', when: '执行对账', then: '输出差异清单' }],
    // 只给两个"规则通道给不出"的维度：data / interface 的语义分
    modelDimensions: { data: 2, interface: 2 },
  })
  office.askDesignQuestions(call(), { recommendation: { method: '结构化', rationale: '需求稳定' } })
  office.redTeamAttack(call(), [id], 7)
  let guard = 0
  while (guard++ < 40) {
    const open = office.questions(call()).filter((question) => question.status === 'open' && !question.targets.includes('design:method'))
    if (open.length === 0) break
    office.answer(call(), { id: open[0]!.id, answer: '已确认', modelDimensions: { data: 2, interface: 2 } })
  }
  return id
}

/** 造一条已基线需求。 */
function baselinedRequirement(): string {
  const id = readyForG2()
  prepareG2(office, call())
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `前置：基线应通过：${outcome.dor.failed.join(',')}`)
  return id
}

test('D1：baseline 不再要求 approvedBy 字符串；台账签字才是门槛，冻结事实记台账签字人', () => {
  readyForG2()
  // 没有台账签字时，即便不传 approvedBy 也拦得住（失败根因必须是 C7，而不是"请传 approvedBy"）
  const blocked = office.baseline(call())
  assert.equal(blocked.ok, false, '没有台账签字时 baseline 必须被拦')
  assert.ok(blocked.dor.failed.includes('C7-signoff'), `必须挂在 C7 上：${blocked.dor.failed.join(',')}`)

  // 真签字后（先按 D4 给未决 P1 补风险处置）：**不传 approvedBy** 也能冻结，冻结事实里的 by 取**台账签字人**
  disposeOpenP1(office, call())
  signG2(office, call(), '我确认需求基线可以冻结')
  const outcome = office.baseline(call())
  assert.equal(outcome.ok, true, `签字后不传 approvedBy 也应通过：${outcome.dor.failed.join(',')}`)
  assert.equal(outcome.baselined[0]?.baseline?.by, '张三', '冻结事实必须记台账签字人（不是默认 human）')
  assert.equal(outcome.baselined[0]?.status, 'baselined')
})

test('§6.7 反例：变更后不得抹掉模型通道语义分（规则维度按新内容重算）', () => {
  const id = baselinedRequirement()
  const before = office.requirements(call()).find((item) => item.id === id)
  assert.ok(before !== undefined)
  assert.equal(before.ambiguity.dimensions.data, 2, '前置：data 靠模型通道拿分')
  assert.equal(before.ambiguity.dimensions.interface, 2, '前置：interface 靠模型通道拿分')
  assert.deepEqual(before.ambiguity.modelDimensions, { data: 2, interface: 2 }, '模型通道的原始输入必须落盘')

  const change = office.change(call(), {
    requirement: id,
    reason: '上游阈值调整',
    changes: ['P99 放宽'],
    decision: 'approved',
    decidedBy: '张三',
    patch: { statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 900 毫秒，异常时降级' },
  })
  assert.equal(change.applied, true)
  assert.equal(change.dimensionsFrom, 'carried', '沿用已落盘的模型通道语义分')

  const after = office.requirements(call()).find((item) => item.id === id)
  assert.ok(after !== undefined)
  assert.equal(after.ambiguity.dimensions.data, 2, 'data 不得被规则基线抹掉')
  assert.equal(after.ambiguity.dimensions.interface, 2, 'interface 不得被规则基线抹掉')
  assert.deepEqual(after.ambiguity.modelDimensions, { data: 2, interface: 2 }, '原始语义分继续保留')
  // 规则维度确实按**新内容**重算：新 statement 仍含"毫秒"与"降级"，constraint / boundary 仍由规则通道判 2
  assert.equal(after.ambiguity.dimensions.constraint, 2, '规则维度按新内容重算（毫秒仍在 → 2）')
  assert.equal(after.ambiguity.dimensions.boundary, 2, '规则维度按新内容重算（降级仍在 → 2）')
  assert.ok(after.ambiguity.score >= 14, `§6.7：变更后仍应达阈值，否则重新基线被误拦：${after.ambiguity.score}`)
})

test('§6.7：规则维度按新内容重算 —— 变更去掉可测时限 → 维度归零、C1 判红（该红就红）', () => {
  const id = baselinedRequirement()
  const change = office.change(call(), {
    requirement: id,
    reason: '把可测时限删掉（错误示范）',
    changes: ['删掉 P99'],
    decision: 'approved',
    decidedBy: '张三',
    patch: { statement: '系统须在每日对账后识别差异；单日 100 万，异常时降级' },
  })
  assert.equal(change.applied, true)
  const after = office.requirements(call()).find((item) => item.id === id)
  assert.ok(after !== undefined)
  assert.equal(after.ambiguity.dimensions.constraint, 0, '规则通道必须按新内容重算并归零 constraint')
  assert.equal(after.ambiguity.dimensions.data, 2, '同期模型维度仍然沿用')
  const c1 = criterion(office.evaluate(call(), 'G2', '张三').criteria, 'C1-dor-per-requirement')
  assert.equal(c1.ok, false, '出现 0 分维度必须判红（不放松）')
  assert.match(c1.detail, /constraint/u, `必须点名 0 分维度：${c1.detail}`)
})

test('§6.7：显式重给语义分优先于沿用；从来没给过的需求走纯规则通道', () => {
  const id = baselinedRequirement()
  const given = office.change(call(), {
    requirement: id,
    reason: '重新评审语义分',
    changes: ['P99 放宽'],
    decision: 'approved',
    decidedBy: '张三',
    patch: { statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 900 毫秒，异常时降级' },
    dimensions: { data: 1, interface: 2, scenario: 2 },
  })
  assert.equal(given.dimensionsFrom, 'explicit', '显式重给时必须如实标记')
  const after = office.requirements(call()).find((item) => item.id === id)
  assert.ok(after !== undefined)
  assert.equal(after.ambiguity.dimensions.data, 1, '显式值必须覆盖沿用值（2 → 1）')
  assert.deepEqual(
    after.ambiguity.modelDimensions,
    { data: 1, interface: 2, scenario: 2 },
    '落盘的原始输入必须更新为本次显式给的值',
  )
  assert.ok(after.ambiguity.score >= 14, `显式重给后仍应达标，才能继续冻结：${after.ambiguity.score}`)

  // 另一条从没给过语义分的需求：变更后 dimensionsFrom = 'none'（纯规则通道）
  office.capture(call(), {
    title: '第二条',
    statement: '系统须在每日对账后识别差异并记录字段；单日 100 万条数据，P99 < 500 毫秒；通过接口调用上游协议，异常时降级',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  const second = office.requirements(call()).map((item) => item.id).sort().at(-1)
  assert.ok(second !== undefined && second !== id)
  office.update(call(), { id: second, addAcceptance: [{ id: 'AC-002', given: 'g', when: 'w', then: 't' }] })
  const plain = office.requirements(call()).find((item) => item.id === second)
  assert.equal(plain?.ambiguity.modelDimensions, undefined, '前置：该需求从来没用过模型通道（纯规则通道达标）')
  assert.ok((plain?.ambiguity.score ?? 0) >= 14, `前置：纯规则通道也要达标，实际 ${plain?.ambiguity.score ?? 0}`)
  // 新增需求会作废 G2 签字（`requirement/captured` 在 G2 的失效事件集合里）→ 重签后再次冻结
  signG2(office, call(), '新增一条需求后重新确认基线')
  assert.equal(office.baseline(call(), { approvedBy: '张三' }).ok, true, '前置：两条需求都应能冻结')
  const na = office.change(call(), {
    requirement: second,
    reason: '内容调整',
    changes: ['无'],
    decision: 'approved',
    decidedBy: '张三',
    patch: { statement: '系统须在每日对账后识别差异并记录字段；单日 100 万条数据，P99 < 700 毫秒；通过接口调用上游协议，异常时降级' },
  })
  assert.equal(na.dimensionsFrom, 'none', '没有语义分可沿用时必须如实标记 none')
})

// —————————————————————— 工具通道（真实装配 + schema 过滤） ——————————————————————

interface ToolHarness {
  tools: ToolDefinition[]
  callTool(name: string, args: Record<string, unknown>): Promise<string>
}

/** 真实装配 + 按 schema 过滤入参（复现宿主的入参过滤；不放进 schema 的参数会被宿主丢掉）。 */
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

test('D5 工具通道：artifactsAbsent 进 schema 且真的判红（缺 why）与转绿（补齐）', async () => {
  const harness = toolHarness(workspace)
  const absent = JSON.stringify(ALL_VIEWS.map((kind) => ({ kind, why: '本次不涉及该视图' })))
  const redReceipt = await harness.callTool('sdo_requirement', {
    action: 'applicability',
    focus: '只改数据与组件',
    viewsPresent: JSON.stringify([]),
    viewsAbsent: absent,
    artifacts: JSON.stringify([]),
    artifactsAbsent: JSON.stringify([{ kind: 'mapping' }]),
  })
  assert.match(redReceipt, /旧→新映射表/u, `回执必须点名缺理由的工件：\n${redReceipt}`)
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-2C').ok, false, '缺 why 时 C-2C 必须判红')

  const greenReceipt = await harness.callTool('sdo_requirement', {
    action: 'applicability',
    focus: '只改数据与组件',
    viewsPresent: JSON.stringify([]),
    viewsAbsent: absent,
    artifacts: JSON.stringify([]),
    artifactsAbsent: JSON.stringify([{ kind: 'mapping', why: '旧库不迁移，映射表没有对应物' }]),
  })
  assert.match(greenReceipt, /旧库不迁移/u, `回执必须展示不做理由：\n${greenReceipt}`)
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-2C').ok, true, '补齐后 C-2C 必须转绿')
})

test('D5 注入块 / DESIGN.md 的渲染入口：不做的工件与理由同样必须出现（不得静默）', () => {
  office.init(call(), { name: 'D5 渲染测试', scale: 'normal', stakeholders: ['业务方'] })
  office.draftApplicability(call(), {
    focus: '只改数据与组件',
    viewsPresent: [],
    viewsAbsent: ALL_VIEWS.map((kind) => ({ kind, why: '本次不涉及该视图' })),
    artifacts: [],
    artifactsAbsent: [{ kind: 'diffVerify', why: '没有可对照的旧实现' }],
  })
  const lines = office.applicabilityLines(call())
  assert.ok(lines.some((line) => line.includes('差分验证策略')), `渲染入口必须列出不做的工件：${lines.join(' | ')}`)
  assert.ok(lines.some((line) => line.includes('没有可对照的旧实现')), `渲染入口必须带上理由：${lines.join(' | ')}`)
})

test('fmt 占位符自检：新增文案的占位符与调用一致（防止 {p1} 漏填）', () => {
  // 这条守卫的价值：语言包是两层扁平表，键写错时 `t()` 会静默返回键名。
  assert.equal(fmt('uiApplicability.artifactAbsentLine', { p1: 'A', p2: 'B' }), t('uiApplicability.artifactAbsentLine').replace('{p1}', 'A').replace('{p2}', 'B'))
  assert.match(t('uiSignature.invalidatingEvents'), /\{p1\}/u)
  assert.match(t('uiGates.kArtifactsAbsentNoWhy'), /\{p1\}/u)
  assert.match(t('uiDor.c2P1NoRisk'), /\{p1\}/u)
})
