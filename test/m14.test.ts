/**
 * 增量 4（诊断报告《2026-10-01-插件诊断-阶段回退缺陷（0.1.2）》§4 回归清单）：
 * **阶段回退三条缺陷的回归**，每条都尽量双向（反例必须真的能推翻断言）。
 *
 *   R-1（blocker）交付阶段没有任何合法回退边 → 四套流程补上终止阶段出边（agile 用自身阶段名）；
 *   R-2（major）  失效范围只覆盖目标阶段 → 改为「目标阶段及其之后」，且回执列出被作废的门禁；
 *   R-3（minor）  留痕判据只看最后一条、且用当前流程数据追溯历史 → 逐条校验 + 事件自证（老事件兼容）。
 *
 * 纪律：断言只读**真源**（`.sdo/gates/` 目录、`journal.jsonl`、流程数据），不采信任何模型自述。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SdoStore } from '../src/infra/store.js'
import { writeMethodDoc } from './support/method-doc-fixture.js'
import { fmt, phaseText } from '../src/domain/i18n.js'
import {
  canRollback,
  exitGates,
  legalRollbackTargets,
  loadAllProcesses,
  loadProcess,
} from '../src/domain/process.js'
import { link } from '../src/domain/trace.js'
import { describeRollback, describeRollbackTargets } from '../src/interface/describe.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { SdoConfig } from '../src/config.js'
import type { GateCriterionResult, GateEvaluation, ViewKind } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m14/', import.meta.url))
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
  office.init(call(), { name: 'M14 测试', scale: 'normal', stakeholders: ['业务方'] })
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

// —————————————————————— 夹具 ——————————————————————

/** G2 通过并让阶段落在 architecture（`baseline` 自己会推进）。 */
function captureAndBaseline(): string {
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

/** 五视图元素（都挂到需求上，消除孤儿）。 */
function fiveViews(requirementId: string): void {
  for (const [kind, name] of [
    ['context', '对账系统'],
    ['component', '差异检测服务'],
    ['runtime', '夜间批处理'],
    ['data', '对账差异表'],
    ['deployment', '单机部署'],
  ] as const) {
    office.upsertElement(call(), { kind, name, requires: [requirementId] })
  }
  const store = office.storeFor(workspace)
  const journal = office.journalFor(workspace)
  for (const element of office.views(call()).flatMap((view) => view.elements)) {
    link(store, journal, { from: requirementId, to: element.id, kind: 'req-des' })
  }
}

/** 一条含备选与后果的 ADR（G3 的 C-22）。 */
function addAdr(): void {
  office.recordAdr(call(), {
    title: '对账批处理窗口',
    context: '上游文件到达时间不稳定',
    decision: 'T+1 批处理，窗口 02:00–04:00',
    alternatives: [
      { option: '流式处理', pros: '时效高', cons: '运维与一致性成本高' },
      { option: 'T+1 批处理', pros: '实现简单、可重跑', cons: '时效 T+1' },
    ],
    consequences: ['差异结果 T+1 可见', '需要重跑入口'],
  })
}

/** 结构化包最小必产项（数据字典覆盖 DFD 流名）。 */
function structuredProducts(requirementId: string): void {
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
  // 新口径（方法包人审文档）：选中 structured 就必须有一份与人审文档，且与台账指纹一致
  writeMethodDoc(workspace, new SdoStore(join(workspace, '.sdo')), 'structured')

}

/** 走完设计交互闭环（问题清零 + 方法选定 + 文档 + 逐条确认）。 */
function completeDesignInteraction(requirementId: string): void {
  const grilled = office.grillDesign(call(), { recommendation: { method: '结构化', rationale: '需求明确' } })
  const method = grilled.created.find((question) => question.targets.includes('design:method'))
  if (method !== undefined) office.answerDesign(call(), method.id, '0', '按推荐')
  for (const id of grilled.stillOpen.filter((qid) => qid !== method?.id)) office.answerDesign(call(), id, '0', '按推荐')
  structuredProducts(requirementId)
  office.renderDesign(call())
  for (const target of office.designConfirmGaps(call()).required) {
    office.confirmDesign(call(), target, '用户在会话中确认', '张三')
  }
}

/** 起草并让用户签字绑定声明。 */
function declareApplicability(input: { viewsPresent: ViewKind[] }): void {
  office.draftApplicability(call(), {
    focus: '旧系统重构：只优化流程与效率，业务逻辑不变',
    viewsPresent: input.viewsPresent,
    viewsAbsent: [],
    artifacts: [],
    by: '模型起草',
  })
  office.confirmApplicability(call(), '同意就按这份声明走', '张三')
  // X-1：C-25 要求 `docs/DESIGN.md` 不早于最后一次真源变更；声明（含其确认）也是文档真源。
  office.renderDesign(call())
}

/** G3 门禁级签字（带引用文本才算有效）。 */
function signG3(): void {
  office.signGate(call(), { gate: 'G3', by: '张三', basis: '我签字确认这次设计可以放行', channel: 'command' })
  // X-1：签字后重渲染一次，使判定时刻的文档与真源一致。
  office.renderDesign(call())
}

function criterion(criteria: GateCriterionResult[], id: string): GateCriterionResult {
  const found = criteria.find((item) => item.id === id)
  assert.ok(found !== undefined, `G3 必须有判据 ${id}`)
  return found
}

/** 直接写一条「陈旧 passed」门禁记录（模拟曾经交付过的项目留下的派生记录）。 */
function stalePass(gate: string, phase: string): void {
  const record: GateEvaluation = {
    gate,
    phase,
    status: 'passed',
    at: new Date().toISOString(),
    criteria: [],
    remedy: [],
  }
  office.storeFor(workspace).writeJson(['gates', `${gate}.json`], record)
}

/** `.sdo/gates/` 下的门禁判定记录（只看 `*.json`；同目录的 `signatures.yml` 是签字台账，不在本判据范围）。 */
function gateRecords(): string[] {
  return office.storeFor(workspace).listNames('gates').filter((name) => name.endsWith('.json')).sort()
}

/**
 * 造一个「已交付」的项目：G0–G3 真判定通过、阶段推进到 delivery。
 *
 * **D2 之后不再使用"手工写一条陈旧 passed 记录"**：`advance` 改为对每个出口门禁
 * `evaluateGate` **现算**，`gates/*.json` 退化为判定留痕、不再参与放行 ——
 * 陈旧记录既不能放行、也不再是"已通过"的证据。G4–G7 因此改用**合法豁免**推进
 * （`waiveGate` 仍是合法出口，`evaluateGate` 会返回 `waived`），
 * 这样夹具不再依赖一条只存在于盘上的假记录。
 */
function atDelivery(): void {
  assert.equal(office.checkGate(call(), 'G0').status, 'passed', '前置：G0 应通过')
  office.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  office.logRisk(call(), {
    title: '格式变更',
    level: 'low',
    probability: 'low',
    impact: '小',
    mitigation: '校验',
    owner: '业务方',
  })
  assert.equal(office.checkGate(call(), 'G1').status, 'passed', '前置：G1 应通过')

  const requirementId = captureAndBaseline()
  fiveViews(requirementId)
  addAdr()
  completeDesignInteraction(requirementId)
  declareApplicability({ viewsPresent: ALL_VIEWS })
  signG3()

  assert.equal(office.checkGate(call(), 'G3').status, 'passed', '前置：G3 应通过')
  assert.equal(office.advance(call()).advanced, true, '前置：应推进到 design-plan')

  for (const gate of ['G4', 'G5', 'G6', 'G7'] as const) {
    office.waiveGate(call(), gate, 'M14 夹具：这些门禁不在本用例的关注范围内', '测试')
  }
  for (const expected of ['construction', 'verification', 'delivery']) {
    const step = office.advance(call())
    assert.equal(step.advanced, true, `前置：应推进到 ${expected}`)
    assert.equal(step.to, expected)
  }
  assert.equal(office.status(call()).project?.phase, 'delivery', '前置：项目应处于交付阶段')
}

// —————————————————————— R-1：终止阶段必须有出边 ——————————————————————

test('M14-01 R-1：四套流程的交付阶段都有合法回退边（agile 用自身阶段名），且都含 requirements（语义 A）', () => {
  // 交付阶段出边 =「重新验证」+「重新设计」+「按需求变更回到需求」（第三条是 2026-10-04 语义 A 加的：
  // 批准的需求变更必须能退回需求阶段重走，否则"需求变了"对开发阶段没有任何约束）。
  const expected: Record<string, string[]> = {
    waterfall: ['verification', 'architecture', 'requirements'],
    prototype: ['verification', 'architecture', 'requirements'],
    spiral: ['verification', 'architecture', 'requirements'],
    // agile 没有 verification / design-plan 这些阶段名，按自身命名推导：
    // 「重新验证」= release（出口门禁就是发布前门 G6）；「重新设计」= architecture。
    agile: ['release', 'architecture', 'requirements'],
  }
  for (const [id, targets] of Object.entries(expected)) {
    const process = loadProcess(id)
    assert.ok(process !== undefined, `流程 ${id} 必须能加载`)
    assert.deepEqual(legalRollbackTargets(process, 'delivery'), targets, `${id} 的交付阶段出边必须与推荐方案一致`)
    for (const target of targets) {
      assert.ok(process.phases.some((item) => item.id === target), `${id} 的回退目标 ${target} 必须是真实阶段`)
    }
    assert.equal(
      legalRollbackTargets(process, 'delivery').includes('requirements'),
      true,
      `${id} 必须把 requirements 列为回退边：批准的需求变更要能退回需求阶段（语义 A；旧口径"改需求不靠回退"正是真机缺陷的根因）`,
    )
  }

  // agile 的等价语义必须是自证的，而不是照抄 waterfall 的阶段名
  const agile = loadProcess('agile')
  assert.ok(agile !== undefined)
  assert.equal(agile.phases.some((item) => item.id === 'verification'), false, 'agile 没有 verification 阶段')
  assert.deepEqual(exitGates(agile, 'release'), ['G6'], 'agile 的「重新验证」级 = release（出口门禁 G6）')
  assert.deepEqual(exitGates(agile, 'architecture'), ['G3'], 'agile 的「重新设计」级 = architecture（出口门禁 G3）')

  // R-1 的判据：每个流程的终止阶段都至少有一条出边（旧实现这里是 0 条）
  for (const process of loadAllProcesses()) {
    assert.equal(canRollback(process, 'delivery'), true, `${process.id} 的交付阶段必须有合法回退边`)
    assert.ok(legalRollbackTargets(process, 'delivery').length >= 2, `${process.id} 应能「重新验证」与「重新设计」`)
  }

  // 双向：非终止阶段不受影响（架构阶段仍然没有到交付的边）
  const waterfall = loadProcess('waterfall')
  assert.ok(waterfall !== undefined)
  assert.equal(legalRollbackTargets(waterfall, 'architecture').includes('delivery'), false, '架构阶段不得直接退到交付')
})

// —————————————————————— R-1 + R-2：交付 → 架构 ——————————————————————

test('M14-02 交付可回退到架构：回执列出作废门禁；G3–G7 的记录全部消失（§4-1/§4-2/§4-5）', () => {
  atDelivery()
  assert.ok(office.rollbackTargets(call()).includes('architecture'), '交付阶段的合法边必须含 architecture')

  const result = office.rollbackPhase(call(), { to: 'architecture', reason: '交付后发现站票变更，需重新设计' })
  assert.equal(result.ok, true, `合法回退应当成功：${result.error ?? ''}`)
  assert.deepEqual(
    result.invalidatedGates,
    ['G3', 'G4', 'G5', 'G6', 'G7'],
    'R-2：失效范围必须是「目标阶段及其之后」，不是只删 G3',
  )
  assert.equal(office.status(call()).project?.phase, 'architecture', '阶段必须退回到架构')

  // §2.5 附注：回退作废了什么，必须一眼可见（不必去翻 gates/ 目录）
  const receipt = describeRollback(result)
  for (const gate of result.invalidatedGates) {
    assert.ok(receipt.includes(gate), `回退作废的门禁必须在回执里列出：缺 ${gate}\n${receipt}`)
  }
  assert.match(receipt, /已回退阶段/u, `回执要有"已回退阶段"结论行：\n${receipt}`)

  // §3.5-3：回退**不撤销**用户的豁免决定 —— atDelivery() 里 G4–G7 是豁免通过的，
  // 回退后它们仍会被 `evaluateGate` 判 `waived`（不会重新判红）。
  // 回执必须把这一点说出来，否则"必须重新通过：G4 G5 G6 G7"会让用户以为豁免也作废了。
  assert.deepEqual(
    result.stillWaivedGates,
    ['G4', 'G5', 'G6', 'G7'],
    '被作废的门禁里仍处于豁免状态的必须如实回报',
  )
  assert.ok(
    receipt.includes(fmt('uiDescribe.kRollbackStillWaived', { p1: result.stillWaivedGates.join(' ') })),
    `回执必须用语言包文案说明"其中这些仍处于豁免状态"：\n${receipt}`,
  )

  // §4-2：真源里只剩 G0–G2（G3–G7 全都不在）
  assert.deepEqual(
    gateRecords(),
    ['G0.json', 'G1.json', 'G2.json'],
    '.sdo/gates/ 里必须只剩 G0–G2',
  )

  // §4-5：journal 里恰好一条，字段齐全
  const events = office.journalFor(workspace).read().events.filter((event) => event.type === 'phase/rolled-back')
  assert.equal(events.length, 1, '必须恰好留一条回退事件')
  const event = events[0]
  assert.ok(event !== undefined, '必须能读到那条回退事件')
  const data = event.data
  assert.equal(data['from'], 'delivery')
  assert.equal(data['to'], 'architecture')
  assert.equal(data['reason'], '交付后发现站票变更，需重新设计')
  assert.equal(data['by'], 'human')
  assert.deepEqual(data['invalidatedGates'], result.invalidatedGates, '事件必须记录失效门禁清单')
  assert.deepEqual(data['legalAtThatTime'], ['verification', 'architecture', 'requirements'], 'R-3：事件必须自证当时的合法边集合')
})

test('M14-03 回退到架构：只按目标阶段切片（delivery → verification 只作废 G6/G7）', () => {
  atDelivery()
  const result = office.rollbackPhase(call(), { to: 'verification', reason: '装上新版插件后要在真实项目上回归' })
  assert.equal(result.ok, true, `合法回退应当成功：${result.error ?? ''}`)
  assert.deepEqual(result.invalidatedGates, ['G6', 'G7'], '退到验证阶段只应作废 G6 与之后（G7）')
  assert.deepEqual(
    gateRecords(),
    ['G0.json', 'G1.json', 'G2.json', 'G3.json', 'G4.json', 'G5.json'],
    'G3–G5 在目标阶段之前，必须保留',
  )
})

// —————————————————————— R-2 / D2：回退后不得凭陈旧记录放行 ——————————————————————

test('M14-04（D2）advance 现算出口门禁：陈旧的 passed 记录不得放行，真源说了算', () => {
  atDelivery()
  const rolled = office.rollbackPhase(call(), { to: 'architecture', reason: '交付后重开设计' })
  assert.equal(rolled.ok, true, `合法回退应当成功：${rolled.error ?? ''}`)

  // §4-3：回退仍然作废目标阶段起的**判定留痕**（审计卫生；放行不再依赖它）
  assert.equal(existsSync(join(workspace, '.sdo', 'gates', 'G3.json')), false, 'G3 的判定记录必须已被作废')

  // **D2 反例**：手工写一条陈旧的 `passed` G3 记录（= 旧实现眼里的"永久通行证"），
  // 同时把设计真源改坏（声明清空 → C-2B / C-20 判红）。
  // 旧实现按"记录存在"放行；现算必须拦住 —— 这一条比旧用例更强：它不再依赖"记录被删"。
  stalePass('G3', 'architecture')
  office.draftApplicability(call(), { focus: '', viewsPresent: [], viewsAbsent: [], artifacts: [] })
  const blocked = office.advance(call())
  assert.equal(blocked.advanced, false, '真源变坏时，陈旧的 passed 记录不得放行')
  assert.equal(blocked.blockedBy, 'G3', '拦住它的必须是当前阶段的出口门禁 G3')
  assert.ok((blocked.remedy ?? []).length > 0, '被拦时必须给出缺口与 remedy')

  // §4-6：把真源改回来 → 重判 G3 通过；C-2E 不得因合规回退而红
  declareApplicability({ viewsPresent: ALL_VIEWS })
  signG3()
  const g3 = office.checkGate(call(), 'G3')
  assert.equal(
    g3.status,
    'passed',
    `重判 G3 应通过：${g3.criteria.filter((item) => !item.ok && item.na !== true).map((item) => `${item.id}:${item.detail}`).join(' | ')}`,
  )
  const c2e = criterion(g3.criteria, 'C-2E')
  assert.equal(c2e.ok, true, `合规回退（有 reason + 合法边）不得让 C-2E 判红：${c2e.detail}`)

  // **D2 正例**：把盘上的记录删掉，advance 照样现算并放行 —— 记录不再是通行证，也不再是必需品。
  office.storeFor(workspace).remove('gates', 'G3.json')
  const toDesign = office.advance(call())
  assert.equal(toDesign.advanced, true, '现算通过后应能推进（不看盘上有没有记录）')
  assert.equal(toDesign.to, 'design-plan')

  // 前进一步后，下一个出口门禁（G4，已豁免）同样由现算决定放行 —— 豁免仍是合法出口。
  const toConstruction = office.advance(call())
  assert.equal(toConstruction.advanced, true, 'waiveGate 仍是合法豁免出口（evaluateGate 返回 waived）')
  assert.equal(toConstruction.to, 'construction')
})

// —————————————————————— §4-7：空 reason 无副作用 ——————————————————————

test('M14-05 空 reason → 报"必须给出理由"，且不落盘、不删门禁、不改阶段', () => {
  atDelivery()
  const eventsBefore = office.journalFor(workspace).read().events.length
  const gatesBefore = office.storeFor(workspace).listNames('gates').sort()

  for (const reason of ['', '   ', '\n\t ']) {
    const rejected = office.rollbackPhase(call(), { to: 'architecture', reason })
    assert.equal(rejected.ok, false, '空 reason 的回退必须被拒')
    assert.match(rejected.error ?? '', /必须给出/u, `拒绝理由必须说明"必须给出"：${rejected.error ?? ''}`)
    assert.match(rejected.error ?? '', /理由|reason/u, `拒绝理由必须点明是要给"理由"：${rejected.error ?? ''}`)
    assert.deepEqual(rejected.invalidatedGates, [], '被拒的回退不得声称作废了任何门禁')
  }

  assert.equal(office.status(call()).project?.phase, 'delivery', '被拒的回退不得改阶段')
  assert.equal(office.journalFor(workspace).read().events.length, eventsBefore, '被拒的回退不得落盘')
  assert.deepEqual(office.storeFor(workspace).listNames('gates').sort(), gatesBefore, '被拒的回退不得删门禁')
})

// —————————————————————— §4-8：非法目标列出合法边 ——————————————————————

test('M14-06 to=intake（非法目标）→ rollbackIllegal 并列出合法边；无副作用', () => {
  atDelivery()
  const eventsBefore = office.journalFor(workspace).read().events.length
  const gatesBefore = office.storeFor(workspace).listNames('gates').sort()

  const rejected = office.rollbackPhase(call(), { to: 'intake', reason: '试图一步退到立项' })
  assert.equal(rejected.ok, false, '非法目标必须被拒')
  assert.match(rejected.error ?? '', /不允许/u, `必须报非法回退边：${rejected.error ?? ''}`)
  assert.match(rejected.error ?? '', /verification/u, '必须列出合法边 verification')
  assert.match(rejected.error ?? '', /architecture/u, '必须列出合法边 architecture')

  assert.equal(office.status(call()).project?.phase, 'delivery', '被拒的回退不得改阶段')
  assert.equal(office.journalFor(workspace).read().events.length, eventsBefore, '被拒的回退不得落盘')
  assert.deepEqual(office.storeFor(workspace).listNames('gates').sort(), gatesBefore, '被拒的回退不得删门禁')

  // 工具面：非法目标时回执也会附上"合法回退目标"清单（阶段名走语言包）
  const targets = describeRollbackTargets(office.rollbackTargets(call()))
  assert.ok(targets.includes(phaseText('verification')), `合法目标清单要含"验证"：\n${targets}`)
  assert.ok(targets.includes(phaseText('architecture')), `合法目标清单要含"架构"：\n${targets}`)
})

// —————————————————————— R-3：逐条校验 + 事件自证 ——————————————————————

test('M14-07 R-3：合法性必须逐条校验 —— 较早一条非法，晚一条合法，仍须判红（§4-9）', () => {
  atDelivery()
  const journal = office.journalFor(workspace)
  // 较早：非法（architecture 从未声明过到 delivery 的边）
  journal.append('phase/rolled-back', {
    from: 'architecture',
    to: 'delivery',
    reason: '较早的非法回退',
    invalidatedGates: [],
    legalAtThatTime: ['requirements', 'feasibility'],
  })
  // 较晚：合法 —— 只看最后一条（旧实现）会放行
  journal.append('phase/rolled-back', {
    from: 'architecture',
    to: 'requirements',
    reason: '较晚的合法回退',
    invalidatedGates: ['G2'],
    legalAtThatTime: ['requirements', 'feasibility'],
  })

  const value = criterion(office.evaluate(call(), 'G3').criteria, 'C-2E')
  assert.equal(value.ok, false, '较早的非法回退必须被判红（逐条校验生效）')
  assert.match(value.detail, /delivery/u, `理由必须点出那条非法边：${value.detail}`)
  assert.match(value.detail, /合法目标|合法/u, `理由必须给出当时的合法目标：${value.detail}`)
})

test('M14-08 R-3 向后兼容：老事件缺 legalAtThatTime 时按当前流程数据复核，不因缺字段判红（§4-9）', () => {
  atDelivery()
  const journal = office.journalFor(workspace)
  // 两条**本字段引入之前**形态的老事件：没有 legalAtThatTime，但按当前流程数据都合法
  journal.append('phase/rolled-back', {
    from: 'delivery',
    to: 'verification',
    reason: '老事件一',
    invalidatedGates: ['G6', 'G7'],
  })
  journal.append('phase/rolled-back', {
    from: 'verification',
    to: 'construction',
    reason: '老事件二',
    invalidatedGates: ['G5', 'G6', 'G7'],
  })

  const value = criterion(office.evaluate(call(), 'G3').criteria, 'C-2E')
  assert.equal(value.ok, true, `缺 legalAtThatTime 的老事件不得被判红：${value.detail}`)
  assert.match(value.detail, /delivery/u, '合规回执应逐条列出全部回退事件')
  assert.match(value.detail, /verification/u, '合规回执应逐条列出全部回退事件')

  // 双向：同样缺字段、但按当前数据非法的老事件仍须判红（兼容不等于放松）
  // 反例用 `delivery → intake`：任何一套随包流程的终止阶段都没有到立项的回退边
  // （2026-10-04 之后 `delivery → requirements` **是**合法边了，不能再拿它当反例）。
  journal.append('phase/rolled-back', {
    from: 'delivery',
    to: 'intake',
    reason: '老事件三（当前数据里非法）',
    invalidatedGates: [],
  })
  const illegal = criterion(office.evaluate(call(), 'G3').criteria, 'C-2E')
  assert.equal(illegal.ok, false, '缺字段的老事件仍要按当前流程数据判非法')
})

test('M14-09 R-3 事件自证：当时合法、如今已从流程数据删掉的边不得被追溯判红（§4-9 第 2 点）', () => {
  atDelivery()
  // 模拟"当时 delivery 还能一步退到 construction（跳过验证）"的历史事件。
  // 当前数据里这条边**不存在**（终止阶段出边只有 verification / architecture / requirements），
  // 若判定仍用当前数据追溯历史，这条当时合法的回退会被误判红。
  office.journalFor(workspace).append('phase/rolled-back', {
    from: 'delivery',
    to: 'construction',
    reason: '当时合法（旧流程数据含该边）',
    invalidatedGates: ['G5', 'G6', 'G7'],
    legalAtThatTime: ['verification', 'architecture', 'construction'],
  })

  const process = office.process(call())
  assert.equal(
    legalRollbackTargets(process, 'delivery').includes('construction'),
    false,
    '当前流程数据里确实没有这条边（本用例的前提）',
  )
  const value = criterion(office.evaluate(call(), 'G3').criteria, 'C-2E')
  assert.equal(value.ok, true, `判定必须采信事件自证，不得用当前数据追溯判红：${value.detail}`)
  assert.match(value.detail, /delivery/u, '合规回执应列出该历史事件')
})

// ———————— §3.5-1：回退后**未被豁免**的门禁必须被重判（交付→架构→详细设计→G4） ————————

/**
 * 造一个"停在详细设计"的项目：回退到架构后重走 G3，再推进到 design-plan（**不豁免 G4**）。
 *
 * 为什么单独一条：`atDelivery()` 夹具把 G4–G7 **豁免**掉才能走到交付，
 * 于是"回退后必须重判 G4"这条语义在那些用例里根本无法表达（G4 永远是 `waived`）。
 * 本夹具用 normal 档、不豁免任何门禁，专测这一条。
 */
function atDesignPlanWithoutWaiver(): string {
  assert.equal(office.checkGate(call(), 'G0').status, 'passed', '前置：G0 应通过')
  office.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  office.logRisk(call(), {
    title: '格式变更',
    level: 'low',
    probability: 'low',
    impact: '小',
    mitigation: '校验',
    owner: '业务方',
  })
  assert.equal(office.checkGate(call(), 'G1').status, 'passed', '前置：G1 应通过')

  const requirementId = captureAndBaseline()

  // 五视图 + 一条**跨组件依赖边**（C-30 要求每条交互都有契约，没有边也是判红原因）
  for (const [kind, name] of [
    ['context', '对账系统'],
    ['component', '差异检测服务'],
    ['runtime', '夜间批处理'],
    ['data', '对账差异表'],
    ['deployment', '单机部署'],
  ] as const) {
    office.upsertElement(call(), { kind, name, requires: [requirementId] })
  }
  office.upsertElement(call(), {
    kind: 'component',
    name: '差异清单导出',
    dependsOn: ['差异检测服务'],
    requires: [requirementId],
  })
  const store = office.storeFor(workspace)
  const journal = office.journalFor(workspace)
  for (const element of office.views(call()).flatMap((view) => view.elements)) {
    link(store, journal, { from: requirementId, to: element.id, kind: 'req-des' })
  }
  office.recordContract(call(), {
    name: '差异清单接口',
    kind: 'schema',
    producer: '差异检测服务',
    consumer: '差异清单导出',
    schema: '{ items: Diff[] }',
    failureSemantics: { timeout: '5s 后重试', retry: '退避两次', idempotency: '按批次 ID 幂等' },
  })

  addAdr()
  completeDesignInteraction(requirementId)
  declareApplicability({ viewsPresent: ALL_VIEWS })
  signG3()
  assert.equal(
    office.checkGate(call(), 'G3').status,
    'passed',
    `前置：G3 应通过：${office.evaluate(call(), 'G3').criteria.filter((item) => !item.ok && item.na !== true).map((item) => `${item.id}:${item.detail}`).join(' | ')}`,
  )
  office.advance(call())
  assert.equal(office.status(call()).project?.phase, 'design-plan', '前置：应处在详细设计阶段')

  // **G4 真源先全绿**（这样"回退后重判 G4"才有意义：绿 → 被作废 → 又变红 → 再补齐 → 又绿）
  office.planDecompose(call())
  office.addTestCase(call(), {
    title: '差异检测端到端',
    kind: 'e2e',
    requirement: requirementId,
    steps: ['导入两日文件', '执行对账'],
    expected: '输出差异清单',
  })
  const green = office.checkGate(call(), 'G4')
  assert.equal(
    green.status,
    'passed',
    `前置：G4 的真源应能变绿：${green.criteria.filter((item) => !item.ok && item.na !== true).map((item) => `${item.id}:${item.detail}`).join(' | ')}`,
  )
  assert.equal(office.advance(call()).to, 'construction', '前置：G4 通过后应能推进到开发阶段')
  // 回到详细设计做本用例（回退边由流程数据声明：construction → design-plan）
  const back = office.rollbackPhase(call(), { to: 'design-plan', reason: '开发拆分后发现设计需要补契约' })
  assert.equal(back.ok, true, `前置：开发阶段应能退回详细设计：${back.error ?? ''}`)
  assert.deepEqual(back.invalidatedGates, ['G4', 'G5', 'G6', 'G7'], '前置：作废范围应为设计之后')
  assert.deepEqual(back.stillWaivedGates, [], '前置：normal 档没有豁免任何门禁')
  return requirementId
}

test('M14-10 §3.5-1 回退后未豁免的门禁必须被重判：陈旧的 G4 passed 不得放行，补齐后重判才放行', () => {
  // 本用例不测实现阶段方法包：写一份**显式不选包**的中立 profile（对照 test/m33.test.ts）
  office.storeFor(workspace).writeYaml(['construction', 'profile.yml'], {
    profile: { version: 1, decidedAt: '', decidedBy: 'office', packages: [], scope: 'all', derivedFrom: [], reason: '本夹具不启用实现阶段方法包', exempt: [], history: [] },
  })
  const requirementId = atDesignPlanWithoutWaiver()

  // 回退把 G4 的判定留痕作废了（"作废"= 不再有记录，而不是"记录仍说 passed"）
  assert.equal(existsSync(join(workspace, '.sdo', 'gates', 'G4.json')), false, '回退必须作废 G4 的判定留痕')

  // **这是回退后必须重判 G4 的直接反例**：设计真源坏掉（跨组件契约作废）**且**盘上放一条
  // 陈旧的 `passed` G4 记录 —— 旧实现只看这条记录就会放行。
  office.dropContract(call(), 'CT-001', '重开设计：契约要重写')
  stalePass('G4', 'design-plan')
  const blocked = office.advance(call())
  assert.equal(blocked.advanced, false, '回退后设计真源变坏时，advance 必须被拦住')
  assert.equal(blocked.blockedBy, 'G4', '拦住它的必须是当前阶段的出口门禁 G4（而不是"没有记录"）')
  assert.ok((blocked.remedy ?? []).length > 0, '被拦时必须给出缺口与 remedy')
  // 现算结果**照写留痕**：陈旧记录被覆盖，盘上的事实与拦住它的判据一致
  assert.equal(
    JSON.parse(readFileSync(join(workspace, '.sdo', 'gates', 'G4.json'), 'utf8')).status,
    'failed',
    '现算结果必须照写留痕（覆盖陈旧的 passed）',
  )

  // **正例**：把真源补回来 → G4 重判通过 → 能推进（证明拦住它的是真源，不是"回退过"这件事）
  office.recordContract(call(), {
    name: '差异清单接口',
    id: 'CT-001',
    kind: 'schema',
    producer: '差异检测服务',
    consumer: '差异清单导出',
    schema: '{ items: Diff[] }',
    failureSemantics: { timeout: '5s 后重试', retry: '退避两次', idempotency: '按批次 ID 幂等' },
  })
  const regreen = office.checkGate(call(), 'G4')
  assert.equal(
    regreen.status,
    'passed',
    `补齐真源后 G4 应重判通过：${regreen.criteria.filter((item) => !item.ok && item.na !== true).map((item) => `${item.id}:${item.detail}`).join(' | ')}`,
  )
  const step = office.advance(call())
  assert.equal(step.advanced, true, '重判通过后应能推进')
  assert.equal(step.to, 'construction')
  assert.ok(requirementId.length > 0, '夹具必须返回需求 id（供追溯断言使用）')
})

