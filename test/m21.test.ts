/**
 * 增量 21：**缺陷复审报告（0.1.2 修复验证）的回归**。
 *
 * 报告来源：`sdo-test/docs/2026-10-01-插件缺陷复审报告（0.1.2修复验证）.md` 的 N-1…N-14，
 * 以及同批 [`回归猎手报告`] 的 R-7。
 *
 * 覆盖（每条都**先复现那次绕过/缺陷，再断言现在被拦/被如实说出**）：
 *   N-1  `redteam.closed`（G2 的 C8）与 C2 必须同一把"未决"尺子
 *   N-2  AC 编号**显式给号**也不得跨需求重号
 *   N-3  `trace/links.jsonl` 坏行不得静默缩短覆盖率/孤儿判据的输入
 *   N-4  `/sdo-gate` 命令面必须有 `--sign`（否则基线签字这条入口无法完成流程）
 *   N-5  状态块必须标注"最近判定"是**留痕**而非当前判定
 *   N-9  `baseline` 失败回执必须印出**真正判红的那条判据**（不只有 DoR 的 7 条）
 *   N-10 看板与状态对同一门禁必须给同一个答案（看板也现算）
 *   N-12 C-20 的 desc 必须与"按声明执法（五视图 + 界面视图）"的实现同源
 *   N-13 渲染头写的序号是"渲染**前**的最后一条事件"，口径必须写清
 *   N-14 重新基线不得无条件作废 G3 签字（内容未改就不再写 `requirement/baselined`）
 *   R-7  原话核对拿不到会话历史时必须**留痕**（`basisChecked: unavailable`），不得静默放行
 *   Z-4  `phase.rollback-recorded` 必须标注"合法性来源 = 事件自证"
 *
 * 纪律：断言只读**真源**（`.sdo/` 下的 yml / jsonl / 门禁判据 / 派生文档），不采信任何自述。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { issueClosure } from '../src/domain/issues.js'
import { boardGates, renderBoard } from '../src/board/render.js'
import { parseRenderSeq } from '../src/domain/design.js'
import { loadProcess } from '../src/domain/process.js'
import { apply } from '../src/index.js'
import { createOfficeCommands } from '../src/interface/commands.js'
import type { OfficeCommandDeps } from '../src/interface/commands.js'
import { describeBaseline, describeStatus } from '../src/interface/describe.js'
import type { BaselineOutcome } from '../src/office.js'
import { SoftwareDevOffice } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { GateCriterionResult, GateEvaluation, GrillQuestion, RedTeamIssue } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m21/', import.meta.url))
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
  office.init(call(), { name: 'M21 测试', scale: 'normal', stakeholders: ['业务方'] })
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

/** G2 数据条件全齐（DoR 全绿），但**尚未签字**。 */
function dataReadyForG2(): string {
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
    const pending = office.questions(call()).filter((q) => q.status === 'open' && !q.targets.includes('design:method'))
    if (pending.length === 0) break
    office.answer(call(), { id: pending[0]!.id, answer: '已确认', modelDimensions: ALL2 })
  }
  return captured.requirement.id
}

/** 已基线（G2 通过，阶段在 architecture）。 */
function baselined(): string {
  const id = dataReadyForG2()
  prepareG2(office, call())
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `前置：基线应通过：${outcome.dor.failed.join(',')}`)
  return id
}

function criterion(criteria: GateCriterionResult[], id: string): GateCriterionResult {
  const found = criteria.find((item) => item.id === id)
  assert.ok(found !== undefined, `门禁里必须有判据 ${id}`)
  return found
}

const journalEvents = (): { type: string; seq: number; data: Record<string, unknown> }[] =>
  office.journalFor(workspace).read().events

/** 写一条陈旧的 `passed` 门禁记录（复现"历史通行证"）。 */
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

// —————————————————————— N-1：未决口径必须同一把尺子 ——————————————————————

test('N-1：质询问题被降级为"未获授权的假设"时，议题闭环判定必须与 C2 同口径（仍算未决）', () => {
  const issue: RedTeamIssue = {
    id: 'ISS-001',
    target: 'REQ-001',
    angles: ['边界'],
    questionIds: ['Q-001'],
    disposition: 'none',
    status: 'open',
    note: '',
    at: new Date().toISOString(),
  } as unknown as RedTeamIssue
  const assumed: GrillQuestion = {
    id: 'Q-001',
    text: '边界在哪',
    severity: 'P1',
    dimension: 'boundary',
    targets: ['REQ-001'],
    why: '边界不清',
    consequenceIfUnasked: '实现会猜',
    options: [],
    defaultRecommendation: '先问用户',
    status: 'assumed',
    at: new Date().toISOString(),
  } as unknown as GrillQuestion

  // 旧实现只看 `status === 'open'` → 这里会判"已全部回答"（闭环），与 C2 判红相反。
  const unauthorized = issueClosure(issue, [assumed])
  assert.equal(unauthorized.closed, false, '未获用户授权的假设按未决处理（与 C2 同一口径）')
  assert.deepEqual(unauthorized.openQuestionIds, ['Q-001'])

  // 双向：**获得用户授权**的假设才算解决
  const authorized = issueClosure(issue, [{ ...assumed, authorizedByUser: true }])
  assert.equal(authorized.closed, true, '用户已授权的假设可以闭环')
  assert.deepEqual(authorized.openQuestionIds, [])
})

// —————————————————————— N-2：AC 编号全局唯一（含显式给号） ——————————————————————

test('N-2：显式给号的 AC 也不得跨需求重号（M8 只堵了自动发号那条路）', () => {
  office.capture(call(), {
    title: '第一条',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
    acceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
  })

  // 第二次显式给同一个号：旧实现照样落盘（C3 不查唯一性），交付验收矩阵随之错配。
  assert.throws(
    () =>
      office.capture(call(), {
        title: '第二条',
        statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 700 毫秒',
        priority: 'must',
        sourceStakeholder: 'STK-01',
        acceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
      }),
    /验收标准编号重复/u,
    '重号必须在落盘前被拒（可读失败）',
  )
  assert.equal(office.requirements(call()).length, 1, '被拒的捕获不得落盘')

  // 双向：不复用别人的号 → 正常；同一批里自己重号 → 也拒
  const ok = office.capture(call(), {
    title: '第二条（换号）',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 700 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
    acceptance: [{ id: 'AC-002', given: 'g', when: 'w', then: 't' }],
  })
  assert.equal(ok.requirement.acceptance[0]?.id, 'AC-002')
  assert.throws(
    () =>
      office.capture(call(), {
        title: '第三条',
        statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 900 毫秒',
        priority: 'must',
        sourceStakeholder: 'STK-01',
        acceptance: [
          { id: 'AC-009', given: 'g', when: 'w', then: 't' },
          { id: 'AC-009', given: 'g', when: 'w', then: 't' },
        ],
      }),
    /验收标准编号重复/u,
    '同一批里自己重号同样要拒',
  )
})

// —————————————————————— N-3：追溯坏行不得静默 ——————————————————————

test('N-3：trace/links.jsonl 有坏行时，孤儿/覆盖率判据必须判红并点名（旧实现静默吞掉）', () => {
  const id = baselined()
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '订单服务', responsibility: '处理订单', requires: [id] })
  const link = office.linkTrace(call(), [{ from: id, to: 'DES-001', kind: 'req-des' }])
  assert.equal(link.created, 1, '前置：一条合法追溯边')
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-21').ok, true, '前置：无孤儿时判绿')

  // 复现：往真源里塞一行坏 JSON（旧实现 catch 掉，覆盖率照算、判据照绿）
  office.storeFor(workspace).appendLine(['trace', 'links.jsonl'], '{ 这不是 JSON')
  const broken = criterion(office.evaluate(call(), 'G3').criteria, 'C-21')
  assert.equal(broken.ok, false, '坏行存在时不得在"不完整的图"上判绿')
  assert.match(broken.detail, /坏|读不出来/u, `理由必须点名坏行：${broken.detail}`)
  assert.match(broken.detail, /1/u, '必须给出坏行条数')

  // 双向：把坏行清掉 → 转绿
  const store = office.storeFor(workspace)
  const path = join(workspace, '.sdo', 'trace', 'links.jsonl')
  const goodLines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '' && line.trim().startsWith('{') && line.includes('"kind"'))
  store.writeText(['trace', 'links.jsonl'], `${goodLines.join('\n')}\n`)
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-21').ok, true, '坏行清掉后必须转绿')
})

// —————————————————————— N-9：拦得住还要说得清 ——————————————————————

test('N-9：baseline 失败回执必须印出真正判红的门禁判据（DoR 之外的那些）', () => {
  // ① 回执层（合成一份"DoR 全绿、C8 判红"的结果）：旧实现只印 DoR 的 7 条，用户找不到原因
  const dorOk: BaselineOutcome['dor'] = {
    ok: true,
    criteria: [
      { id: 'C1-dor-per-requirement', label: '每条需求满足就绪定义', ok: true, detail: '通过' },
      { id: 'C7-signoff', label: '人类基线签字', ok: true, detail: '已签字' },
    ],
    failed: [],
    score: 16,
  } as unknown as BaselineOutcome['dor']
  const evaluation = {
    gate: 'G2',
    phase: 'requirements',
    status: 'failed',
    at: new Date().toISOString(),
    criteria: [
      { id: 'C1-dor-per-requirement', ok: true, detail: '通过' },
      { id: 'C7-signoff', ok: true, detail: '已签字' },
      { id: 'C8-red-team-closed', ok: false, detail: '仍有 1 个质询问题未回答', remedy: '先答完质询问题' },
    ],
    remedy: [],
  } as unknown as GateEvaluation
  const receipt = describeBaseline({ ok: false, dor: dorOk, baselined: [], evaluation })
  assert.match(receipt, /C8-red-team-closed/u, `失败回执必须点名真正判红的判据：\n${receipt}`)
  assert.match(receipt, /先答完质询问题/u, `必须带上该判据的 remedy：\n${receipt}`)

  // ② 装配层：失败分支必须真的把现算结果带出来
  dataReadyForG2()
  const blocked = office.baseline(call())
  assert.equal(blocked.ok, false, '前置：没签字时必须被拦')
  assert.ok(blocked.evaluation !== undefined, '失败结果里必须带门禁现算结果')
  assert.equal(blocked.evaluation?.gate, 'G2')
})

// —————————————————————— N-5 / N-10：展示层不得自相矛盾 ——————————————————————

test('N-5：状态块必须把"最近判定"标注为留痕（现算与留痕是两个口径）', () => {
  baselined()
  const text = describeStatus(office.status(call()), '.sdo')
  assert.match(text, /留痕/u, `状态块必须说清那是留痕：\n${text}`)
})

test('N-10：看板必须与状态对同一门禁给同一个答案（当前阶段出口门禁走现算）', async () => {
  baselined()
  assert.equal(office.status(call()).project?.phase, 'architecture', '前置：当前阶段出口门禁是 G3')
  // 复现：盘上留一条陈旧的 G3 passed（旧看板会把它印成"已通过 G3"，而 status 说"待判定 G3"）
  stalePass('G3', 'architecture')
  assert.equal(office.status(call()).pendingGate, 'G3', '前置：现算说 G3 当前不通过')

  const text = boardTextFor()
  assert.ok(text.includes('G3'), `看板必须提到 G3：\n${text}`)
  // "已通过" 到下一个分隔符之间不得出现 G3（留痕说它 passed，现算说它当前不通过）
  const passedSegment = /已通过([^｜\n]*)/u.exec(text)?.[1] ?? ''
  assert.equal(/G3/u.test(passedSegment), false, `看板不得把陈旧的 passed 印成"已通过 G3"：\n${text}`)
  assert.match(text, /未通过[^\n]*G3/u, `看板必须与现算一致地报"未通过 G3"：\n${text}`)
})

// —————————————————————— N-12 / N-13：文案与序号口径 ——————————————————————

test('N-12：C-20 的 desc 必须与"按声明执法（五视图 + 界面视图）"的实现同源', () => {
  for (const processId of ['waterfall', 'agile', 'prototype', 'spiral']) {
    const process = loadProcess(processId)
    assert.ok(process !== undefined)
    const c20 = process.gates.find((gate) => gate.id === 'G3')?.criteria.find((item) => item.id === 'C-20')
    assert.ok(c20 !== undefined, `${processId} 必须有 C-20`)
    const c20desc = String(c20.desc ?? '')
    assert.match(c20desc, /声明/u, `${processId}：desc 必须说清是"按声明"执法：${c20desc}`)
    assert.match(c20desc, /界面/u, `${processId}：desc 必须提到界面视图（同一判据会因它判红）：${c20desc}`)
  }
})

test('N-13：渲染头写的序号是"渲染前"的最后一条事件（渲染动作本身是下一条）', () => {
  baselined()
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '订单服务', responsibility: '处理订单' })
  const before = journalEvents().length
  office.renderDesign(call())
  const after = journalEvents()
  const headerSeq = parseRenderSeq(readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8'))
  assert.equal(headerSeq, before, '头里必须写"渲染前的最后一条事件序号"')
  const rendered = after.filter((event) => event.type === 'design/rendered' && event.data['kind'] === 'DESIGN.md')
  assert.equal(rendered.length, 1, 'DESIGN.md 的渲染必须留痕')
  assert.equal(rendered[0]?.seq, before + 1, '渲染事件本身是紧接着的下一条（口径写清即可）')
})

// —————————————————————— N-14：重新基线不得顺手作废 G3 签字 ——————————————————————

test('N-14：内容未改的重新基线不再写 requirement/baselined，G3 签字不得被作废', () => {
  baselined()
  office.renderDesign(call())
  office.signGate(call(), { gate: 'G3', by: '张三', basis: '我确认这次设计可以放行', channel: 'command' })
  assert.equal(office.signatureState(call(), 'G3').status, 'valid', '前置：G3 签字有效')
  const before = journalEvents().filter((event) => event.type === 'requirement/baselined').length

  // 复现：再一次 `baseline`（内容一字未改）—— 旧实现对**全部**需求无条件写 baselined，
  // 而该事件在 G3 的失效集合里 → 签字被一次"与我无关的重新基线"顺手作废。
  const again = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(again.ok, true, `前置：重新基线应通过：${again.dor.failed.join(',')}`)
  assert.deepEqual(again.baselined, [], '内容未改 → 本次没有需求需要重新冻结')
  const after = journalEvents().filter((event) => event.type === 'requirement/baselined').length
  assert.equal(after, before, '不得再写 requirement/baselined')
  const state = office.signatureState(call(), 'G3')
  assert.equal(state.status, 'valid', `G3 签字不得被重新基线作废：${state.reason}`)

  // 双向：**真的新增**一条需求后重新基线 → 必须写真源事件（签字随之失效，属预期）
  office.capture(call(), {
    title: '新增需求',
    statement: '系统须在每日对账后生成差异报表；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call(), { id: 'REQ-002', addAcceptance: [{ id: 'AC-002', given: 'g', when: 'w', then: 't' }], modelDimensions: ALL2 })
  prepareG2(office, call())
  assert.equal(office.baseline(call(), { approvedBy: '张三' }).ok, true, '新增需求后应能重新冻结')
  assert.ok(
    journalEvents().filter((event) => event.type === 'requirement/baselined').length > before,
    '真的冻了新需求时必须写真源事件',
  )
})

// —————————————————————— R-7：原话核对口径必须留痕 ——————————————————————

test('R-7：拿不到会话历史时不得静默放行 —— 签字必须记录 basisChecked=unavailable 并如实告警', async () => {
  dataReadyForG2()
  // 宿主不提供 `deriveMessages`（=headless/精简装配）→ 旧实现 `return true` 静默通过
  const text = await gateViaTool({ action: 'sign', gate: 'G2', channel: 'statement', quote: '我确认需求基线可以冻结', approvedBy: '张三' })
  assert.match(text, /已记录门禁签字|已由用户签字/u, `签字应成功（不是把路焊死）：\n${text}`)
  assert.match(text, /未经过会话历史核对/u, `回执必须当场告警（不能只在状态行里带过）：\n${text}`)
  const state = office.signatureState(call(), 'G2')
  assert.equal(state.status, 'valid')
  assert.equal(state.signature?.basisChecked, 'unavailable', '必须如实记录"没核过"')
  assert.match(state.reason, /未经过会话历史核对/u, `理由必须显式告警：${state.reason}`)
  // 事件里也要能看到（审计读 journal 时同样不该被静默）
  const signed = journalEvents().filter((event) => event.type === 'gate/signed')
  assert.equal(signed.at(-1)?.data['basisChecked'], 'unavailable')
})

// —————————————————————— Z-4：判据强度必须写出来 ——————————————————————

test('Z-4：phase.rollback-recorded 的 detail 必须标注"合法性来源 = 事件自证"', () => {
  const id = baselined()
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '订单服务', responsibility: '处理订单', requires: [id] })
  office.rollbackPhase(call(), { to: 'requirements', reason: '发现需求缺口' })
  const c2e = criterion(office.evaluate(call(), 'G3').criteria, 'C-2E')
  assert.match(c2e.detail, /自证/u, `必须写明合法性来源：${c2e.detail}`)
  assert.match(c2e.detail, /legalAtThatTime/u, `必须点名那个字段：${c2e.detail}`)
})

// —————————————————————— N-4：命令面必须有 --sign ——————————————————————

test('N-4：/sdo-gate 命令面能把 --sign/--quote/--channel 交给 gate 处理器（旧实现只有 --waive）', async () => {
  const seen: Record<string, unknown>[] = []
  const commands = createOfficeCommands({
    gate: async (_call: unknown, args: Record<string, unknown>) => {
      seen.push(args as unknown as Record<string, unknown>)
      return 'stub'
    },
  } as unknown as OfficeCommandDeps, false)
  const gate = commands.find((item) => item.name === 'sdo-gate')
  assert.ok(gate !== undefined)
  const invocation = {
    commandId: 'cmd-test',
    agent: { id: 's1', session: { header: { cwd: workspace } } },
    rawInput: '--sign --gate=G2 --quote="我确认需求基线可以冻结" --approved-by=张三',
    attachments: [],
    signal: new AbortController().signal,
  }
  const result = await gate.handler(invocation as never)
  assert.equal(result.kind, 'success', `命令应成功：${result.text}`)
  assert.equal(seen.length, 1, '必须调用到 gate 处理器')
  assert.equal(seen[0]?.['action'], 'sign', `--sign 必须映射成 action=sign：${JSON.stringify(seen[0])}`)
  assert.equal(seen[0]?.['gate'], 'G2')
  assert.equal(seen[0]?.['quote'], '我确认需求基线可以冻结', '引用必须真的传下去')
  assert.equal(seen[0]?.['channel'], 'statement', '--channel 缺省按 statement')

  // 双向：不给 --sign 仍是 check（不改变既有行为）
  await gate.handler({ ...invocation, rawInput: '--gate=G2' } as never)
  assert.equal(seen[1]?.['action'], 'check')
})

// —————————————————————— 与插件入口同构的测试脚手架 ——————————————————————

/** 真机 Agent 形状：工作目录只在 `session.header.cwd`。 */
function agentOf(): unknown {
  return { id: 's1', session: { header: { cwd: workspace } } }
}

/** 真实装配 + 按 schema 过滤入参（复现宿主的入参过滤）。 */
function toolHarness(): { callTool(name: string, args: Record<string, unknown>): Promise<string> } {
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
  const exec = { agent: agentOf() } as unknown as ToolRunContext
  return {
    callTool: async (name, args) => {
      const tool = registered.find((item) => item.name === name)
      if (tool === undefined) throw new Error(`没有注册工具 ${name}`)
      return String(await tool.execute(args, exec))
    },
  }
}

const gateViaTool = (args: Record<string, unknown>): Promise<string> => toolHarness().callTool('sdo_gate', args)

/** 与 `src/index.ts` 的看板装配同构（门禁走 `boardGates`：当前阶段出口门禁现算）。 */
function boardTextFor(): string {
  const status = office.status(call())
  return renderBoard({
    project: status.project,
    config: status.config,
    counts: status.counts,
    gates: boardGates(office.gatesFor(call()), office.currentExitGates(call())),
    requirements: office.boardRequirements(call()),
    process: office.process(call()),
    pendingGate: status.pendingGate,
    dataDirName: '.sdo',
    truncated: status.truncated,
  })
}
