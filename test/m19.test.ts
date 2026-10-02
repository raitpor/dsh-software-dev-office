/**
 * 增量 9：缺陷报告《2026-10-01-插件缺陷报告-需求与设计阶段流程》的**回归**。
 *
 * 纪律（与 m7/m13/m14/m15/m18 一致）：
 *   · 断言只读**真源**（`.sdo/` 下的 yml / 门禁判据 / journal / 派生文档），不采信自述；
 *   · 每条洞的用例都**真的去模拟那次绕过**（红队议题未闭环就想基线、陈旧文档想判绿、
 *     契约改完不重签就想放行、把问题手改成 assumed 想跳过 G2 ……），并断言**现在被拦**；
 *   · 双向：堵住的那条路必须红，正常路径必须绿（否则就是"把门焊死"而不是"修门"）。
 *
 * 覆盖：
 *   B1  基线判定必须走 evaluateGate（C8 红队闭环生效，配置不再被硬编码劫持）
 *   X-1 派生视图 `docs/DESIGN.md` 必须由当前真源渲染（含 Z-2：只有 11 行标题的假文档）
 *   Y-1 `confirm target=ui` 的裸放行删除 + 不可解析目标拒绝写入
 *   Y-2 契约变更必须让门禁签字失效
 *   Y-3 契约覆盖不得用"名字子串"制造假绿
 *   Y-4 声明里的第 6 个视图 `ui` 必须真的被检查
 *   Y-5 全部字段都被忽略的方法产物提交不得写入（不再"成功"地什么都不改）
 *   Y-6 分层产物缺 `rules` / `allowed` 为空不得静默跳过方向检查
 *   Y-7 退出关键条目集合的旧确认戳必须被看见
 *   M3  重新基线不得给"内容未改"的需求无脑 +0.1
 *   M4  `gate/result` 的 `failed` 不得把 N/A 算成失败
 *   M5  G2 的 P1 判据文案与实现同源（不再承诺"且转风险"）
 *   M6  手改 `status: assumed`（无 authorizedByUser）不得绕过 G2
 *   M7  声明里同一视图既 present 又 absent 必须判红
 *   M8  capture 的 AC 编号必须全局唯一
 *   m1/m3/m4/m5 文案与形状/越界/坏行的机械修复
 *   Z-3 create/contract 上不被消费的入参必须点名
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { orphanConfirmationLines, parseRenderSeq, isConfirmed } from '../src/domain/design.js'
import { isEffectivelyOpen } from '../src/domain/dor.js'
import { t, fmt, setLocale } from '../src/domain/i18n.js'
import { link } from '../src/domain/trace.js'
import { renderOrphanConfirmations, writeMethodArtifactReceipt } from '../src/interface/designReceipt.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import { disposeOpenP1, prepareG2, signG2 } from './support/g2-fixture.js'
import type { GateCriterionResult, GateEvaluation, ViewKind } from '../src/types.js'
import type { DesignArgs } from '../src/interface/tools.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m19/', import.meta.url))
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
  office.init(call(), { name: 'M19 测试', scale: 'normal', stakeholders: ['业务方'] })
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

/**
 * 把一条需求做到"G2 的数据条件全齐、但**还没有签字**"（D1 的复现前提）。
 *
 * 与 `baselineRequirement` 的唯一区别：**不签 G2、不冻结**。
 */
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

/** 一条已基线需求（G2 通过）。 */
function baselineRequirement(): string {
  const id = dataReadyForG2()
  // D1 + D4：未决 P1 补风险处置，再签 G2 字（放行依据是签字台账）
  prepareG2(office, call())
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `基线应通过：${outcome.dor.failed.join(',')}`)
  return id
}

/** 元件 + 追溯边（G3 的 C-21 读追溯图）。 */
function element(name: string, requirementId: string): string {
  const created = office.upsertElement(call(), { kind: 'component', elementKind: 'service', name, responsibility: `${name} 的职责`, requires: [requirementId] })
  link(office.storeFor(workspace), office.journalFor(workspace), { from: requirementId, to: created.element.id, kind: 'req-des' })
  return created.element.id
}

function criterion(criteria: GateCriterionResult[], id: string): GateCriterionResult {
  const found = criteria.find((item) => item.id === id)
  assert.ok(found !== undefined, `门禁里必须有判据 ${id}`)
  return found
}

const journalEvents = (): { type: string; seq: number; data: Record<string, unknown> }[] =>
  office.journalFor(workspace).read().events

/**
 * 一个**紧凑但完整**的 G3 全绿夹具：五视图全声明 absent（C-20 → N/A）、无关键条目（C-24 → N/A）、
 * 不含界面（C-27 → N/A）、方法显式 `none`（C-29 / C-2A → N/A）、无声明工件（C-2C → N/A）。
 * 这样 G3 能 `passed` 且**同时带多个 N/A 判据** —— 正是 M4 的复现条件。
 */
function greenG3(requirementId: string): void {
  // 一条设计问题 + 一个 ADR（C-23 / C-22）
  const grilled = office.grillDesign(call(), { recommendation: { method: 'none', rationale: '本项目不做方法产物' } })
  for (const id of grilled.stillOpen) office.answerDesign(call(), id, '0', '按推荐')
  // 方法论选择题可能已由 `baselineRequirement` 提出过（需求阶段提出、设计阶段消费）
  const method = office.designIssues(call()).open.find((q) => q.targets.includes('design:method'))
    ?? office.designIssues(call()).closed.find((q) => q.targets.includes('design:method'))
  assert.ok(method !== undefined, '前置：方法论选择题必须存在')
  office.answerDesign(call(), method.id, 'none', '明确不做方法产物')
  office.recordAdr(call(), {
    title: '批处理窗口',
    context: '上游到达时间不稳定',
    decision: 'T+1',
    alternatives: [{ option: '流式', pros: '快', cons: '贵' }],
    consequences: ['差异结果 T+1 可见'],
  })
  office.draftApplicability(call(), {
    focus: '对账脚本改造：只改数据与组件，不涉及界面',
    viewsPresent: [],
    viewsAbsent: ALL_VIEWS.map((kind) => ({ kind, why: '本次改造不涉及该视图' })),
    artifacts: [],
    by: '模型起草',
  })
  // X-1：文档必须**最后**渲染（真源写完再渲染）
  office.renderDesign(call())
  office.signGate(call(), { gate: 'G3', by: '张三', basis: '我签字确认这次设计可以放行', channel: 'command' })
  void requirementId
}

/** G2 的判定（只为读判据）。 */
function g2(): GateEvaluation {
  return office.evaluate(call(), 'G2', '张三')
}

/** 非通过（且非 N/A）的判据 id。 */
function failedIds(evaluation: GateEvaluation): string[] {
  return evaluation.criteria.filter((item) => !item.ok && item.na !== true).map((item) => item.id)
}

// —————————————————————— B1：基线必须走 evaluateGate ——————————————————————

test('B1 反例：红队议题未闭环时 baseline 必须被拦（旧实现自建 status:passed，C8 从不判定）', () => {
  const captured = office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call(), {
    id: captured.requirement.id,
    addAcceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
    modelDimensions: ALL2,
  })
  // 红队开一轮议题，但**不闭环**（问题不回答、也不转风险）
  office.redTeamAttack(call(), [captured.requirement.id], 7)
  const openIssue = office.issues(call()).filter((issue) => issue.status === 'open')
  assert.ok(openIssue.length > 0, '前置：必须留下未闭环的红队议题')

  // 反例：C8 必须判红，baseline 必须被拦（旧实现这里会 ok=true 并写 passed）
  const evaluated = office.evaluate(call(), 'G2', '张三')
  assert.equal(criterion(evaluated.criteria, 'C8-red-team-closed').ok, false, '未闭环的红队议题必须让 C8 判红')
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, false, 'C8 红时基线不得通过（旧实现自建 passed，从不判定 C8）')
  assert.equal(existsSync(join(workspace, '.sdo', 'gates', 'G2.json')), false, '被拦时不得写 G2.json')
  assert.equal(office.status(call()).project?.phase, 'intake', '被拦时不得推进阶段')
})

test('B1 正例：闭环红队议题后 baseline 通过，且 G2.json 的判据集合 = 流程数据声明的全集（含 C8）', () => {
  const requirementId = baselineRequirement()
  const g2Record = JSON.parse(readFileSync(join(workspace, '.sdo', 'gates', 'G2.json'), 'utf8')) as GateEvaluation
  const declared = office.process(call()).gates.find((gate) => gate.id === 'G2')!.criteria.map((item) => item.id)
  assert.deepEqual(g2Record.criteria.map((item) => item.id), declared, 'G2 记录必须逐条对应流程数据声明的判据（含 C8）')
  assert.equal(g2Record.status, 'passed')
  assert.equal(criterion(g2Record.criteria, 'C8-red-team-closed').ok, true, '闭环后 C8 必须判绿')
  assert.equal(office.requirements(call()).find((r) => r.id === requirementId)?.status, 'baselined')
})

test('D1 反例：只传 approvedBy 字符串不得放行 C7（模型自授签字被堵死）', () => {
  const requirementId = dataReadyForG2()
  // 其余判据全绿，只差签字 —— 旧实现到这里已经 `ok: true`（只校验字符串非空）
  const unsigned = criterion(office.evaluate(call(), 'G2', '张三').criteria, 'C7-signoff')
  assert.equal(unsigned.ok, false, '台账里没有 G2 签字时 C7 必须判红（approvedBy 不再是放行依据）')
  assert.ok(unsigned.detail.includes('张三'), `approvedBy 作为附加信息必须照实写出，不许静默忽略：${unsigned.detail}`)
  assert.ok(
    (unsigned.remedy ?? '').includes('sdo_gate action=sign') && (unsigned.remedy ?? '').includes('G2'),
    `remedy 必须给出可执行命令：${unsigned.remedy ?? ''}`,
  )
  assert.ok(
    unsigned.detail.includes('project/updated') && unsigned.detail.includes('requirement/updated'),
    `回执必须写出该门禁的失效事件集合（与判定同源）：${unsigned.detail}`,
  )

  // 反例：连基线也必须被拦（不是只有 check 拦）
  const blocked = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(blocked.ok, false, '没有台账签字时 baseline 必须被拦')
  assert.equal(existsSync(join(workspace, '.sdo', 'gates', 'G2.json')), false, '被拦时不得写 G2.json')

  // 正例：真签字（带用户原话引用）→ C7 绿，基线放行。先按 D4 给未决 P1 补风险处置。
  disposeOpenP1(office, call())
  signG2(office, call())
  const signed = criterion(office.evaluate(call(), 'G2', '张三').criteria, 'C7-signoff')
  assert.equal(signed.ok, true, `真签字后 C7 必须判绿：${signed.detail}`)
  assert.ok(signed.detail.includes('我确认需求基线可以冻结'), `detail 必须带上用户原话引用：${signed.detail}`)
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `签字后基线应通过：${outcome.dor.failed.join(',')}`)
  const g2Record = JSON.parse(readFileSync(join(workspace, '.sdo', 'gates', 'G2.json'), 'utf8')) as GateEvaluation
  assert.equal(criterion(g2Record.criteria, 'C7-signoff').ok, true, '落盘的 G2 记录里 C7 必须是绿的')
  void requirementId
})

test('D1 双向：签字随需求变更失效；重新签字后恢复（按 journal 序号，G2 用自己那份事件集合）', () => {
  baselineRequirement()
  assert.equal(office.signatureState(call(), 'G2').status, 'valid', '前置：签字有效')

  // 变更需求（requirement/updated）→ G2 签字必须失效
  office.update(call(), { id: office.requirements(call())[0]!.id, patch: { title: '差异检测（改名）' } })
  const stale = office.signatureState(call(), 'G2')
  assert.equal(stale.status, 'stale', `需求变更后 G2 签字必须失效：${stale.reason}`)
  assert.equal(criterion(office.evaluate(call(), 'G2', '张三').criteria, 'C7-signoff').ok, false, '失效后 C7 必须红')

  // 重签 → 恢复
  signG2(office, call(), '确认改名后的需求基线')
  assert.equal(office.signatureState(call(), 'G2').status, 'valid', '重签后必须恢复有效')
  assert.equal(criterion(office.evaluate(call(), 'G2', '张三').criteria, 'C7-signoff').ok, true)

  // 反向不变量：**基线动作本身**（requirement/baselined）不得让刚签的字立刻失效，
  // 否则 M3 的"内容未改重新冻结"永远无法通过。
  assert.equal(office.baseline(call(), { approvedBy: '张三' }).ok, true)
  assert.equal(office.signatureState(call(), 'G2').status, 'valid', 'baseline 自身不属于 G2 的失效事件')
})

test('B1 判据不再按 id 硬编码劫持：G2 的每一条都由它自己的 check 键决定', () => {
  // 反例：把 G2 的 C1 判据的 check 改成一个**必然失败**的键 → 该判据必须失败。
  // 旧实现会按 id 命中 evaluateDor，把改过的 check 顶掉（配置假装数据驱动）。
  const requirementId = baselineRequirement()
  const process = office.process(call())
  const patched = {
    ...process,
    gates: process.gates.map((gate) =>
      gate.id === 'G2'
        ? { ...gate, criteria: gate.criteria.map((item) => (item.id === 'C1-dor-per-requirement' ? { ...item, check: 'project.scope.in', desc: '被改过的 check' } : item)) }
        : gate,
    ),
  }
  const context = {
    workspace,
    store: office.storeFor(workspace),
    journal: office.journalFor(workspace),
    process: patched,
    project: office.status(call()).project,
    requirements: office.requirements(call()),
    questions: office.questions(call()),
    risks: office.risks(call()),
    issues: office.issues(call()),
    feasibility: office.feasibility(call()),
    redTeamExecuted: office.redTeamExecuted(call()),
    redTeamDisabled: office.redTeamDisabled(call()),
    approvedBy: '张三',
    waivedGates: [],
    prototypeDir: 'prototype',
    prototypeThrowaway: true,
    riskConclusion: office.riskConclusion(call()),
  }
  // 直接用改过的流程定义判定：C1 现在指向 `project.scope.in`，其 detail 必须来自该检查器
  const evaluated = evaluateWith(patched, context)
  const c1 = criterion(evaluated.criteria, 'C1-dor-per-requirement')
  assert.match(c1.detail, /范围/u, `改过的 check 必须真的被执行（detail 来自 project.scope.in）：${c1.detail}`)
  void requirementId
})

/** 走 `evaluateGate`（避免在这里重复 import 一堆类型）。 */
function evaluateWith(process: ReturnType<SoftwareDevOffice['process']>, context: Parameters<typeof import('../src/domain/gates.js').evaluateGate>[2]): GateEvaluation {
  return evaluateGateRef(process, 'G2', context)
}

// 动态 import 只做一次，避免顶层 import 循环
const { evaluateGate: evaluateGateRef } = await import('../src/domain/gates.js')

// —————————————————————— X-1 / Z-2：派生视图必须由当前真源渲染 ——————————————————————

test('X-1 反例：渲染后真源再变更 → C-25 判红（旧实现只查 11 个标题，陈旧仍绿）', () => {
  const requirementId = baselineRequirement()
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '订单服务', responsibility: '处理订单', requires: [requirementId] })
  office.renderDesign(call())
  const doc = readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8')
  const seq = parseRenderSeq(doc)
  assert.ok(seq !== undefined, '渲染头必须带机器可读的 journal seq')
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-25').ok, true, '刚渲染时 C-25 必须绿')

  // 绕过尝试：真源变了但**不重渲染** → 旧文档照样"存在且含 11 章"
  office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '支付服务', responsibility: '处理支付', requires: [requirementId] })
  assert.equal(readFileSync(join(workspace, 'docs', 'DESIGN.md'), 'utf8'), doc, '未重渲染时文件内容不得变化（复现"陈旧"）')
  const stale = criterion(office.evaluate(call(), 'G3').criteria, 'C-25')
  assert.equal(stale.ok, false, '陈旧文档必须判红')
  assert.match(stale.detail, /已陈旧/u, '理由必须点明"陈旧"并给出序号')

  // 正例：重渲染 → 转绿
  office.renderDesign(call())
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-25').ok, true, '重渲染后必须转绿')
})

test('X-1 / Z-2 反例：只有 11 行标题、没有渲染标记的假文档不得判绿', () => {
  const requirementId = baselineRequirement()
  element('订单服务', requirementId)
  const { DESIGN_DOC_SECTIONS } = designModule
  const fake = ['<!-- 手写的假文档 -->', ...DESIGN_DOC_SECTIONS.map((key) => `## ${t(key)}`)].join('\n')
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  writeFileSync(join(workspace, 'docs', 'DESIGN.md'), fake, 'utf8')
  const c25 = criterion(office.evaluate(call(), 'G3').criteria, 'C-25')
  assert.equal(c25.ok, false, '没有渲染标记的文档无法证明由真源渲染 → 必须判红')
  assert.match(c25.detail, /机器可读标记|真源渲染/u, '理由必须说清缺的是"渲染证明"')
})

// —————————————— N-8：渲染头必须"绑内容"，不能自证 ——————————————

test('N-8 反例①：伪造未来序号不得让陈旧文档永久判绿（序号必须有上界）', () => {
  const requirementId = baselineRequirement()
  element('订单服务', requirementId)
  office.renderDesign(call())
  const path = join(workspace, 'docs', 'DESIGN.md')
  const doc = readFileSync(path, 'utf8')
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-25').ok, true, '前置：刚渲染时绿')

  // 独立复核给出的原始攻击：只把渲染头换成**未来序号**，正文一字未改。
  const forged = doc.replace(/journal seq \d+/u, 'journal seq 99999999')
  assert.notEqual(forged, doc, '前置：确实换掉了序号')
  writeFileSync(path, forged, 'utf8')
  const c25 = criterion(office.evaluate(call(), 'G3').criteria, 'C-25')
  assert.equal(c25.ok, false, '未来序号必须判红（旧实现单侧比较会放行）')
  assert.match(c25.detail, /序号|不可信/u, `理由必须点明渲染头不可信：${c25.detail}`)

  // 双向：把序号改回真值 → 正文仍与真源一致 → 转绿
  writeFileSync(path, doc, 'utf8')
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-25').ok, true, '还原后必须转绿')
})

test('N-8 反例② / Z-2：331 字节级的空壳文档（伪头 + 11 行标题）不得判绿', () => {
  const requirementId = baselineRequirement()
  element('订单服务', requirementId)
  office.renderDesign(call())
  const path = join(workspace, 'docs', 'DESIGN.md')
  const real = readFileSync(path, 'utf8')
  const { DESIGN_DOC_SECTIONS } = designModule
  // 复刻独立复核的伪造件：**保留真渲染头**（序号合法）+ 11 行标题，正文其余全删。
  const headerLines = real.split('\n').filter((line) => line.startsWith('<!--'))
  const shell = [...headerLines, '', ...DESIGN_DOC_SECTIONS.map((key) => `## ${t(key)}`)].join('\n')
  writeFileSync(path, shell, 'utf8')
  assert.ok(shell.length < 700, `前置：确实是一份空壳（${shell.length} 字节）`)

  const c25 = criterion(office.evaluate(call(), 'G3').criteria, 'C-25')
  assert.equal(c25.ok, false, '章节标题齐全但正文与真源渲染不一致 → 必须判红（旧实现只查标题，会放行）')
  assert.match(c25.detail, /重渲染|脱钩/u, `理由必须点明"与真源重渲染不一致"：${c25.detail}`)

  // 双向：重新渲染 → 正文与真源一致 → 转绿
  office.renderDesign(call())
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-25').ok, true, '重新渲染后必须转绿')
})

test('N-8 反例③：手改正文（保留合法渲染头）不得判绿', () => {
  const requirementId = baselineRequirement()
  element('订单服务', requirementId)
  office.renderDesign(call())
  const path = join(workspace, 'docs', 'DESIGN.md')
  const doc = readFileSync(path, 'utf8')
  // 只改一行**正文**：在文档里塞一条真源里不存在的"设计元素"。
  const edited = doc.replace('## 1. ', '## 1. （手改标记）')
  assert.notEqual(edited, doc, '前置：正文确实被改了')
  writeFileSync(path, edited, 'utf8')
  const c25 = criterion(office.evaluate(call(), 'G3').criteria, 'C-25')
  assert.equal(c25.ok, false, '手改正文必须判红')
})

test('N-11：切语言不得让 C-25 假红（按渲染头记录的语言重渲染比对）', () => {
  const requirementId = baselineRequirement()
  element('订单服务', requirementId)
  office.renderDesign(call())

  // 中文渲染 → 切到 en → 旧实现按当前语言找 11 个英文标题 → 全部"找不到" → 假红。
  setLocale('en')
  try {
    const c25 = criterion(office.evaluate(call(), 'G3').criteria, 'C-25')
    assert.equal(c25.ok, true, `中文渲染的文档在 en 会话里必须仍然判绿（假红是缺陷）：${c25.detail}`)
  } finally {
    setLocale('zh-CN')
  }

  // 双向：在 en 下重渲染 → 写成英文文档；切回 zh-CN 也必须绿。
  setLocale('en')
  try {
    office.renderDesign(call())
    assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-25').ok, true, 'en 渲染后 en 会话必须绿')
  } finally {
    setLocale('zh-CN')
  }
  const after = criterion(office.evaluate(call(), 'G3').criteria, 'C-25')
  assert.equal(after.ok, true, `英文渲染的文档在 zh-CN 会话里必须仍然判绿（按头里的语言重渲染）：${after.detail}`)
})

// —————————————————————— Y-1：确认戳不得"无声退出" ——————————————————————

test('Y-1 反例：`confirm target=ui` 不再被裸放行；不可解析的目标拒绝写入', () => {
  const requirementId = baselineRequirement()
  const id = element('订单服务', requirementId)
  assert.deepEqual(office.designConfirmGaps(call()).required, [id], '前置：只有该元素是关键条目')

  // 旧的裸放行：`target !== 'ui'` 特批 → 写一条 contentHash:'' 的戳，永远不被承认
  const refused = office.confirmDesign(call(), 'ui', '用户原话：确认界面', 'user')
  assert.equal(refused, undefined, 'target=ui 不是关键条目，必须拒绝写入')
  assert.equal(existsSync(join(workspace, '.sdo', 'design', 'confirmed.yml')), false, '被拒绝时不得写台账')
  // 合法的 UI target 形态是 `ui:<视图 id>:<部分>`（与 `UI_TARGET`=`design:ui` 无关）
  assert.equal(office.confirmDesign(call(), 'ui:UI-404:style', '用户原话：确认风格', 'user'), undefined, '目标解析不出内容时同样拒绝')
  assert.equal(existsSync(join(workspace, '.sdo', 'design', 'confirmed.yml')), false, '仍然不得写台账')

  // 正例：真实元素 → 写入并带上指纹，`isConfirmed` 认得它
  const confirmed = office.confirmDesign(call(), id, '用户原话：元素对', 'user')
  assert.ok(confirmed !== undefined && (confirmed.contentHash ?? '') !== '', '有效目标必须写入并绑定内容指纹')
  assert.equal(isConfirmed(office.storeFor(workspace), id), true)
})

test('Y-1 工具回执：未知 target 报"不是有效关键条目"，不再谎报"已确认"', async () => {
  const requirementId = baselineRequirement()
  element('订单服务', requirementId)
  const harness = toolHarness(workspace)
  const receipt = await harness.callTool('sdo_design', { action: 'confirm', target: 'ui', note: '确认' })
  assert.ok(receipt.includes(t('uiDesign.uiConfirmUnknown').slice(0, 6)), `必须报"不是有效关键条目"：${receipt}`)
  assert.equal(receipt.includes(t('uiDesign.uiConfirmOk').slice(0, 4)), false, '不得出现"已确认"')
})

// —————————————————————— Y-2：契约变更必须让签字失效 ——————————————————————

test('Y-2 反例：签字之后改契约 schema → G3 签字必须失效；重新签字 → 有效（双向）', () => {
  const requirementId = baselineRequirement()
  element('订单服务', requirementId)
  const contract = office.recordContract(call(), { name: '订单服务导出接口', producer: '订单服务', consumer: '外部对账', schema: 'v1' })
  office.signGate(call(), { gate: 'G3', by: '张三', basis: '我签字确认这次设计可以放行', channel: 'command' })
  assert.equal(office.signatureState(call(), 'G3').status, 'valid', '前置：签字有效')

  // 绕过尝试：原地改契约（contract/updated），不重新签字
  office.recordContract(call(), { id: contract.id, name: '订单服务导出接口', producer: '订单服务', consumer: '外部对账', schema: 'v2' })
  const state = office.signatureState(call(), 'G3')
  assert.equal(state.status, 'stale', `契约变更必须让签字失效：${state.reason}`)
  assert.equal(criterion(office.evaluate(call(), 'G3').criteria, 'C-2D').ok, false, 'C-2D 必须因此判红')

  // 作废一条契约同样必须失效
  office.signGate(call(), { gate: 'G3', by: '张三', basis: '重新签字确认', channel: 'command' })
  assert.equal(office.signatureState(call(), 'G3').status, 'valid')
  office.dropContract(call(), contract.id, '被新契约取代')
  assert.equal(office.signatureState(call(), 'G3').status, 'stale', 'contract/dropped 同样必须让签字失效')

  // 反向：渲染 / 记账类事件**不得**让签字失效（否则"签字后没法再看文档"）
  office.signGate(call(), { gate: 'G3', by: '张三', basis: '再签一次', channel: 'command' })
  office.renderDesign(call())
  office.checkGate(call(), 'G1')
  assert.equal(office.signatureState(call(), 'G3').status, 'valid', '纯读/渲染事件不得让签字失效')
})

// —————————————————————— Y-3：契约覆盖不得用名字子串 ——————————————————————

test('Y-3 反例：契约名字含 producer 名、但 producer 字段是别的东西 → 不得判"已覆盖"', () => {
  const requirementId = baselineRequirement()
  element('订单服务', requirementId)
  const b = office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '结算服务', responsibility: '结算', requires: [requirementId], dependsOn: ['订单服务'] })
  link(office.storeFor(workspace), office.journalFor(workspace), { from: requirementId, to: b.element.id, kind: 'req-des' })
  // 假绿配方：名字里含"订单服务"，但 producer 字段完全对不上
  office.recordContract(call(), { name: 'XX订单服务X的旁路接口', producer: '另一个东西', consumer: '结算服务', schema: 'x', failureSemantics: { timeout: '1s', retry: '1', idempotency: 'k' } })
  const c30 = criterion(office.evaluate(call(), 'G4').criteria, 'C-30')
  assert.equal(c30.ok, false, `名字子串不得算覆盖：${c30.detail}`)
  assert.match(c30.detail, /结算服务→订单服务/u, '必须点名缺的是哪条边')

  // 正例：真契约 → 覆盖
  office.recordContract(call(), { name: '订单服务 → 结算服务', producer: '订单服务', consumer: '结算服务', schema: 'y', failureSemantics: { timeout: '1s', retry: '1', idempotency: 'k' } })
  const after = criterion(office.evaluate(call(), 'G4').criteria, 'C-30')
  assert.equal(after.ok, true, `真契约必须算覆盖：${after.detail}`)
})

test('Y-3 改名不再静默失真：依赖边写元素 id 也能与名字写法配对', () => {
  const requirementId = baselineRequirement()
  const a = element('订单服务', requirementId)
  const b = office.upsertElement(call(), { kind: 'component', elementKind: 'service', name: '结算服务', responsibility: '结算', requires: [requirementId], dependsOn: [a] })
  link(office.storeFor(workspace), office.journalFor(workspace), { from: requirementId, to: b.element.id, kind: 'req-des' })
  // 依赖边写的是 id（`dependsOn: [DES-001]`），契约写的是名字 → 归一后必须配对
  office.recordContract(call(), { name: '订单服务 → 结算服务', producer: '订单服务', consumer: '结算服务', schema: 'z', failureSemantics: { timeout: '1s', retry: '1', idempotency: 'k' } })
  assert.equal(criterion(office.evaluate(call(), 'G4').criteria, 'C-30').ok, true, 'id 与名字混用必须能配对（归一成稳定标识）')
})

// —————————————————————— Y-4：声明里的 ui 必须真的被检查 ——————————————————————

test('Y-4 反例：声明说"要做界面视图"但真源无界面证据 → C-20 必须判红', () => {
  const requirementId = baselineRequirement()
  element('订单服务', requirementId)
  office.draftApplicability(call(), {
    focus: '网页应用：界面与后端一起设计',
    viewsPresent: ['ui'],
    viewsAbsent: ALL_VIEWS.map((kind) => ({ kind, why: '本次不涉及' })),
    artifacts: [],
    by: '模型起草',
  })
  const c20 = criterion(office.evaluate(call(), 'G3').criteria, 'C-20')
  assert.equal(c20.ok, false, '声明了 ui 就必须真有界面证据')
  assert.match(c20.detail, /界面/u, '理由必须点名界面视图')

  // 正例：声明项目级 surfaces=web → 声明与真源一致，C-20 不再是"红"
  office.updateProject(call(), { surfaces: ['web'] })
  const after = criterion(office.evaluate(call(), 'G3').criteria, 'C-20')
  assert.notEqual(after.detail.includes('没有任何界面证据'), true, `补上界面真源后不得再报"无界面证据"：${after.detail}`)
})

// —————————————————————— Y-5：全字段被忽略的产物提交不得写入 ——————————————————————

test('Y-5 反例：已有产物 + 字段全部写错位 → 拒绝写入，盘上原值与 journal 都不变', () => {
  const requirementId = baselineRequirement()
  element('订单服务', requirementId)
  const first = writeMethodArtifactReceipt(office, call(), argsOf({ action: 'artifact', artifactKind: 'layers', artifactData: JSON.stringify({ rules: { layers: ['ui', 'domain'], allowed: [{ from: 'ui', to: 'domain' }] }, summary: '初版' }) }))
  assert.match(first, /已写入|已更新/u)
  const before = readFileSync(join(workspace, '.sdo', 'design', 'method-layers.yml'), 'utf8')
  const eventsBefore = journalEvents().filter((event) => event.type === 'design/artifact-updated').length

  // 绕过尝试：`layers/assignments/allowed` 写在顶层（正确形状在 `rules:` 内）
  const receipt = writeMethodArtifactReceipt(office, call(), argsOf({ action: 'artifact', artifactKind: 'layers', artifactData: JSON.stringify({ layers: ['ui', 'domain'], assignments: { A: 'ui' }, allowed: [{ from: 'ui', to: 'domain' }] }) }))
  assert.equal(readFileSync(join(workspace, '.sdo', 'design', 'method-layers.yml'), 'utf8'), before, '被忽略字段的提交不得改动盘上真源')
  assert.equal(journalEvents().filter((event) => event.type === 'design/artifact-updated').length, eventsBefore, '不得 append design/artifact-updated（它还会顺带作废签字）')
  assert.match(receipt, /没有给出任何正文字段/u, '回执必须说清"未写入"')
  assert.match(receipt, /layers assignments allowed/u, '回执必须点名被忽略的字段')

  // 正例：只改 summary（公共字段）仍允许合并更新
  const okReceipt = writeMethodArtifactReceipt(office, call(), argsOf({ action: 'artifact', artifactKind: 'layers', artifactData: JSON.stringify({ summary: '第二版' }) }))
  assert.match(okReceipt, /已写入|已更新/u, `summary-only 更新必须允许：${okReceipt}`)
  assert.match(readFileSync(join(workspace, '.sdo', 'design', 'method-layers.yml'), 'utf8'), /第二版/u)
})

// —————————————————————— Y-6：分层方向检查不得静默跳过 ——————————————————————

test('Y-6 反例：layers 产物缺 rules / allowed 为空 → 一致性判据必须判红', () => {
  const requirementId = baselineRequirement()
  element('订单服务', requirementId)
  office.askDesignQuestions(call(), { recommendation: { method: 'oo', rationale: '对象协作多' } })
  const methodQuestion = office.designIssues(call()).open.find((q) => q.targets.includes('design:method'))
  assert.ok(methodQuestion !== undefined)
  office.answerDesign(call(), methodQuestion.id, 'oo', '按推荐')

  // 空壳产物（只有 summary）：旧实现整段方向检查静默跳过
  office.writeMethodArtifact(call(), 'layers', { summary: '空壳' })
  const noRules = office.methodConsistency(call())
  assert.equal(noRules.ok, false, '缺 rules 不得判"一致"')

  // `allowed` 为空 + 多分层 = 零约束
  office.writeMethodArtifact(call(), 'layers', { rules: { layers: ['ui', 'domain'], allowed: [], assignments: {} } })
  const noAllowed = office.methodConsistency(call())
  assert.equal(noAllowed.ok, false, '零约束不得判"一致"')

  // 正例：规则齐备（依赖方向合规）→ ok
  office.writeMethodArtifact(call(), 'layers', {
    rules: { layers: ['ui', 'domain'], allowed: [{ from: 'ui', to: 'domain' }], assignments: {} },
  })
  const fine = office.methodConsistency(call())
  assert.equal(fine.ok, true, `规则齐备时必须判一致：${fine.problems.join('；')}`)
})

// —————————————————————— Y-7：退出关键条目集合的确认戳必须被看见 ——————————————————————

test('Y-7 反例：清空 requires 让元素退出关键条目 → 旧确认戳不得静默消失', () => {
  const requirementId = baselineRequirement()
  const id = element('订单服务', requirementId)
  office.confirmDesign(call(), id, '用户原话：元素对', 'user')
  assert.deepEqual(office.designConfirmGaps(call()).missing, [], '前置：已确认')

  // 绕过尝试：把 requires 清空 → 该元素不再进"关键条目"，旧确认戳留在台账
  office.upsertElement(call(), { id, kind: 'component', elementKind: 'service', name: '订单服务', responsibility: '处理订单', requires: [] })
  const gaps = office.designConfirmGaps(call())
  assert.deepEqual(gaps.required, [], '前提：已退出关键条目集合')
  assert.deepEqual(gaps.missing, [], '它不是"待确认"（目标已不在集合里）')
  assert.deepEqual(gaps.orphan.map((item) => item.target), [id], '必须作为"已退出集合的旧戳"被列出来')

  // 三处可见：清单行 / 门禁详情 / 回执
  assert.ok(orphanConfirmationLines(gaps).join('\n').includes(id), '清单行必须列出它')
  const c24 = criterion(office.evaluate(call(), 'G3').criteria, 'C-24')
  assert.match(c24.detail, new RegExp(id, 'u'), `门禁详情必须提到它：${c24.detail}`)
  assert.match(renderOrphanConfirmations(office, call()), new RegExp(id, 'u'), '回执必须列出它')
})

test('Y-7 反向：删掉元素同样进入 orphan；仍在集合里的条目不得被误报为 orphan', () => {
  const requirementId = baselineRequirement()
  const keep = element('订单服务', requirementId)
  const gone = element('支付服务', requirementId)
  office.confirmDesign(call(), keep, '原话 keep', 'user')
  office.confirmDesign(call(), gone, '原话 gone', 'user')
  // 直接删掉真源文件（模拟 id 改名/删除）
  office.storeFor(workspace).remove('design', 'component.yml')
  const gaps = office.designConfirmGaps(call())
  assert.deepEqual(gaps.orphan.map((item) => item.target).sort(), [keep, gone].sort(), '两个元素都不在真源里 → 都是 orphan')
  assert.deepEqual(orphanConfirmationLines(gaps).length > 0, true)
})

// —————————————————————— M3：重新基线不得无脑加版本 ——————————————————————

test('M3 反例：内容未改的需求重新基线不得涨版本；改过的需求也不得二次 +0.1', () => {
  const requirementId = baselineRequirement()
  const firstVersion = office.requirements(call()).find((r) => r.id === requirementId)?.version
  assert.equal(firstVersion, 0.2, '首次基线：0.1 → 0.2')

  // 重新基线（内容一字未改）
  const again = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(again.ok, true, `重新基线应通过：${again.dor.failed.join(',')}`)
  assert.equal(office.requirements(call()).find((r) => r.id === requirementId)?.version, 0.2, '内容未改 → 版本必须保持 0.2（旧实现会变 0.3）')

  // 走变更控制改内容：change 路径自己 +0.1 → 0.3；**且不得抹掉模型通道的语义分**（§6.7）
  const before = office.requirements(call()).find((r) => r.id === requirementId)
  assert.ok(before !== undefined)
  const change = office.change(call(), {
    requirement: requirementId,
    reason: '上游阈值调整',
    changes: ['P99 放宽'],
    decision: 'approved',
    decidedBy: '张三',
    patch: { statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 900 毫秒' },
  })
  assert.equal(change.applied, true)
  assert.equal(change.dimensionsFrom, 'carried', '§6.7：变更重算评分必须**沿用**模型通道语义分')
  const after = office.requirements(call()).find((r) => r.id === requirementId)
  assert.ok(after !== undefined)
  assert.equal(after.version, 0.3, '内容变更：0.2 → 0.3')
  // §6.7 的核心：靠语义分撑起来的维度不得被规则基线抹掉（旧实现 15 → 9，data/interface 归零）
  for (const dimension of ['data', 'interface'] as const) {
    assert.equal(
      after.ambiguity.dimensions[dimension],
      before.ambiguity.dimensions[dimension],
      `§6.7：${dimension} 维度必须被保留，不得被规则通道抹掉`,
    )
    assert.ok((after.ambiguity.dimensions[dimension] ?? 0) > 0, `§6.7：${dimension} 不得归零`)
  }
  assert.equal(after.ambiguity.dimensions.constraint, 2, '规则维度必须按新内容重算（900 毫秒仍命中 constraint）')
  assert.ok(after.ambiguity.score >= 14, `§6.7：变更后仍须达阈值，否则重新基线会被 C1 误拦：${after.ambiguity.score}`)

  // D1：变更写的是 `requirement/updated` → G2 签字失效 → 必须重签才能重新基线
  assert.equal(office.signatureState(call(), 'G2').status, 'stale', '需求变更后 G2 签字必须失效')
  signG2(office, call(), '变更后重新确认基线')

  // 再基线一次：不得变成 0.4
  const rebase = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(rebase.ok, true, `变更后重新基线应通过：${rebase.dor.failed.join(',')}`)
  assert.equal(office.requirements(call()).find((r) => r.id === requirementId)?.version, 0.3, '重新基线不得再 +0.1（旧实现会变 0.4）')
  const baselined = rebase.baselined.find((r) => r.id === requirementId)
  assert.equal(baselined?.baseline?.by, '张三', '冻结事实（谁签的）必须刷新')
})

// —————————————————————— M4：journal 不得把 N/A 记成 failed ——————————————————————

test('M4 反例：G3 通过且含 N/A 判据时，journal 的 failed 必须为空、N/A 另列', () => {
  const requirementId = baselineRequirement()
  greenG3(requirementId)
  const evaluation = office.checkGate(call(), 'G3')
  assert.equal(evaluation.status, 'passed', `前置：G3 应通过：${evaluation.criteria.filter((c) => !c.ok && c.na !== true).map((c) => c.id).join(',')}`)
  const na = evaluation.criteria.filter((c) => c.na === true).map((c) => c.id)
  assert.ok(na.length >= 2, `前置：必须有多条 N/A（复现条件），实际 ${na.join(',')}`)

  const g3Result = journalEvents().filter((event) => event.type === 'gate/result' && event.data['gate'] === 'G3').at(-1)
  assert.ok(g3Result !== undefined)
  assert.deepEqual(g3Result.data['failed'], [], `通过的门禁不得写 failed（旧实现会把 N/A 写进来）：${JSON.stringify(g3Result.data['failed'])}`)
  assert.deepEqual(g3Result.data['notApplicable'], na, 'N/A 必须另列 notApplicable')
  assert.equal(g3Result.data['passed'], evaluation.criteria.filter((c) => c.ok).length, '必须带上通过判据数')

  // 不变量：failed 与 notApplicable 不相交；passed 的门禁 failed 恒为空
  assert.equal((g3Result.data['failed'] as string[]).some((id) => (g3Result.data['notApplicable'] as string[]).includes(id)), false, 'failed 与 N/A 不得相交')
})

// —————————————————————— M5 / m1：判据文案与实现同源 ——————————————————————

test('D4：G2 的 P1 判据文案与实现同源 —— 未决 P1 必须转风险，否则判红并点名', () => {
  const process = office.process(call())
  const c2 = process.gates.find((gate) => gate.id === 'G2')!.criteria.find((item) => item.id === 'C2-open-questions')!
  assert.match(c2.desc ?? '', /P1/u, '文案必须把 P1 上限写清楚（实现是 P1 ≤ 上限）')
  assert.match(c2.desc ?? '', /转风险/u, 'D4 之后文案必须写明"且转风险"（实现真的逐条判了）')

  // 反例：数据齐备，但未决 P1（design:method）没有任何风险处置 → C2 判红并**点名**该问题
  dataReadyForG2()
  const openP1 = office.questions(call()).filter((question) => isEffectivelyOpen(question) && question.severity === 'P1')
  assert.ok(openP1.length > 0, '前置：夹具必须留下未决 P1（方法论选择题是 P1）')
  const before = criterion(office.evaluate(call(), 'G2', '张三').criteria, 'C2-open-questions')
  assert.equal(before.ok, false, '未决 P1 没有风险处置时 C2 必须判红')
  for (const question of openP1) {
    assert.ok(before.detail.includes(question.id), `detail 必须点名缺风险处置的问题 ${question.id}：${before.detail}`)
  }
  assert.equal(office.baseline(call(), { approvedBy: '张三' }).ok, false, 'C2 红时基线必须被拦')

  // 正例：逐条补上 `origin` 指向该问题 id 的风险 → C2 转绿
  const disposed = disposeOpenP1(office, call())
  assert.deepEqual(
    disposed.slice().sort(),
    openP1.map((question) => question.id).sort(),
    '必须逐条处置，一条都不能漏',
  )
  const after = criterion(office.evaluate(call(), 'G2', '张三').criteria, 'C2-open-questions')
  assert.equal(after.ok, true, `补风险处置后 C2 应转绿：${after.detail}`)
})

test('m1：G1 的 C-06 文案与实现同源（口径 = high / blocker 未关闭且有应对与责任人）', () => {
  const c6 = office.process(call()).gates.find((gate) => gate.id === 'G1')!.criteria.find((item) => item.id === 'C-06')!
  // 旧文案只承诺"阻塞级风险必须有应对"；实现是"high / blocker 级未关闭风险必须有应对与责任人"。
  // 复核结论：实现并非"任何级别"，因此文案按**实际口径**同步（不是把判据变严）。
  assert.match(c6.desc ?? '', /high|blocker/u, '文案必须写清覆盖的风险等级')
  assert.match(c6.desc ?? '', /应对|mitigation/u, '文案必须写清"必须有应对"')
  office.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['压测'] })
  office.logRisk(call(), { title: '低风险但有应对', level: 'low', probability: 'low', impact: '小', mitigation: '监控', owner: 'STK-01' })
  assert.equal(criterion(office.evaluate(call(), 'G1').criteria, 'C-06').ok, true, '都有应对时通过')
  office.logRisk(call(), { title: '高风险无应对', level: 'high', probability: 'high', impact: '大', mitigation: '', owner: 'STK-01' })
  assert.equal(criterion(office.evaluate(call(), 'G1').criteria, 'C-06').ok, false, 'high 级未缓解必须判红')
  // 事实口径：medium 且无应对**不**判红（文案不得承诺更多）
  office.logRisk(call(), { title: '中风险无应对', level: 'medium', probability: 'medium', impact: '中', mitigation: '', owner: 'STK-01' })
  office.updateRisk(call(), office.risks(call()).find((r) => r.title === '高风险无应对')!.id, { mitigation: '降级预案' })
  assert.equal(criterion(office.evaluate(call(), 'G1').criteria, 'C-06').ok, true, 'medium 无应对不判红（与文案同源）')
})

// —————————————————————— M6：手改 assumed 不得绕过 G2 ——————————————————————

test('M6 反例：手改 YAML 把问题标成 assumed（无 authorizedByUser）不得绕过 G2', () => {
  const captured = office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call(), { id: captured.requirement.id, addAcceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }], modelDimensions: ALL2 })
  office.grill(call(), { requirementIds: [captured.requirement.id] })
  const open = office.questions(call()).filter((q) => q.status === 'open')
  assert.ok(open.length > 0, '前置：必须有未决问题')
  const target = open[0]!
  // 其余问题全部答掉，只留 target 手改成 assumed
  for (const question of open.slice(1)) office.answer(call(), { id: question.id, answer: '已确认', modelDimensions: ALL2 })
  const path = join(workspace, '.sdo', 'questions', `${target.id}.yml`)
  writeFileSync(path, readFileSync(path, 'utf8').replace(/status: .*/u, 'status: assumed'), 'utf8')
  const stored = office.questions(call()).find((q) => q.id === target.id)
  assert.equal(stored?.status, 'assumed')
  assert.equal(stored?.authorizedByUser, undefined, '前提：没有 authorizedByUser（= agent 自己填的假设）')

  // 绕过尝试：旧实现按 `status === 'open'` 过滤 → 这条不算未决 → G2 放行
  assert.equal(failedIds(g2()).includes('C2-open-questions'), true, '未授权假设必须仍算未决 → C2 判红')
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, false, '带着未授权假设不得基线')

  // 正例：用户真的授权过（authorizedByUser: true）→ 算已决
  const withAuth = readFileSync(path, 'utf8').replace(/^(\s*)status: assumed$/mu, '$1status: assumed\n$1authorizedByUser: true')
  writeFileSync(path, withAuth, 'utf8')
  assert.equal(office.questions(call()).find((q) => q.id === target.id)?.authorizedByUser, true)
  assert.equal(failedIds(g2()).includes('C2-open-questions'), false, '授权假设应算已决')
  void outcome
})

// —————————————————————— M7：自相矛盾的声明必须判红 ——————————————————————

test('M7 反例：同一视图既 present 又 absent → C-2B 与 C-20 都判红（不再静默取 present）', () => {
  const requirementId = baselineRequirement()
  element('订单服务', requirementId)
  // 直接写盘：`draftApplicability` 会去重（落盘的是"未说明"），只有在**手写真源**里才可能出现矛盾
  office.storeFor(workspace).writeYaml(['design', 'applicability.yml'], {
    applicability: {
      focus: '手写的矛盾声明',
      viewsPresent: ['component', 'ui'],
      viewsAbsent: [
        { kind: 'component', why: '又说做又不做' },
        ...ALL_VIEWS.filter((kind) => kind !== 'component').map((kind) => ({ kind, why: '不做' })),
      ],
      artifacts: [],
      draftedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  })
  const state = office.applicabilityCheck(call())
  assert.equal(state.status, 'incomplete', '矛盾声明必须被报成结构问题')
  assert.ok(state.problems.join('；').includes(t('view.component')), `问题里必须点名组件视图：${state.problems.join('；')}`)
  const g3 = office.evaluate(call(), 'G3')
  assert.equal(criterion(g3.criteria, 'C-2B').ok, false, 'C-2B 必须判红')
  assert.equal(criterion(g3.criteria, 'C-20').ok, false, 'C-20 不得静默取 present 后判绿')
})

// —————————————————————— M8：AC 编号必须全局唯一 ——————————————————————

test('M8 反例：工具通道连续 capture 两条需求，缺 id 的 AC 不得重号', async () => {
  const harness = toolHarness(workspace)
  const first = await harness.callTool('sdo_requirement', {
    action: 'capture',
    title: 'A',
    statement: '系统须支持 A；P99 < 500 毫秒',
    priority: 'must',
    sourceRaw: '用户原话',
    acceptance: JSON.stringify([{ given: 'g', when: 'w', then: 't' }]),
  })
  const second = await harness.callTool('sdo_requirement', {
    action: 'capture',
    title: 'B',
    statement: '系统须支持 B；P99 < 500 毫秒',
    priority: 'must',
    sourceRaw: '用户原话',
    acceptance: JSON.stringify([{ given: 'g', when: 'w', then: 't' }]),
  })
  assert.ok(first.includes('REQ-001') && second.includes('REQ-002'), '前置：两条需求都要落账')
  const requirements = office.requirements(call())
  const ids = requirements.flatMap((requirement) => requirement.acceptance.map((ac) => ac.id))
  assert.equal(new Set(ids).size, ids.length, `AC id 必须全局唯一，实际：${ids.join(',')}`)
  assert.deepEqual(ids, ['AC-001', 'AC-002'], '第二条需求应续号而不是重新从 AC-001 开始')
})

// —————————————————————— m3 / m4 / m5 / Z-3 ——————————————————————

test('m3 反例：越界 pickedOption 必须拒绝记账（旧实现静默退化成自由文本）', () => {
  const captured = office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call(), { id: captured.requirement.id, addAcceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }], modelDimensions: ALL2 })
  office.grill(call(), { requirementIds: [captured.requirement.id] })
  const question = office.questions(call()).find((q) => q.options.length > 0)
  assert.ok(question !== undefined, '前置：需要一道带选项的题')
  assert.throws(
    () => office.answer(call(), { id: question.id, answer: '自由文本', pickedOption: 99 }),
    /越界/u,
    '越界必须报错',
  )
  assert.equal(office.questions(call()).find((q) => q.id === question.id)?.status, 'open', '拒绝后问题状态不得变化')
  // 正例：合法下标 → 把选项文本一起记进答案
  office.answer(call(), { id: question.id, answer: '按推荐', pickedOption: 0 })
  const answered = office.questions(call()).find((q) => q.id === question.id)
  assert.equal(answered?.status, 'answered')
  assert.match(answered?.answer ?? '', /选择/u, '合法下标必须把选项文本记入答案')
})

test('m4 反例：`viewsAbsent` 写成字符串数组不得变成 kind: \'\' 的幽灵条目', async () => {
  const harness = toolHarness(workspace)
  const receipt = await harness.callTool('sdo_requirement', {
    action: 'applicability',
    focus: '网页应用',
    viewsPresent: JSON.stringify(['context', 'component', 'runtime', 'deployment']),
    viewsAbsent: JSON.stringify(['data']),
    artifacts: JSON.stringify([]),
    by: '模型起草',
  })
  const state = office.applicabilityCheck(call())
  assert.equal(state.status, 'incomplete', '字符串项 = 视图名 + 缺理由，必须判结构问题')
  assert.ok(state.problems.join('；').includes(t('view.data')), `必须点名数据视图缺理由：${state.problems.join('；')}`)
  assert.equal(state.problems.join('；').includes(t('uiApplicability.viewIgnored').replace('{p1}', '')), false, '不得退化成空名的幽灵条目')
  assert.match(receipt, /理由/u)
})

test('m5 反例：追溯图里的坏行必须被计数（影响分析不得静默变小）', () => {
  const requirementId = baselineRequirement()
  office.storeFor(workspace).writeText(['trace', 'links.jsonl'], '{"from":"REQ-001","to":"DES-001","kind":"req-des"}\n{"from":"REQ-001","to":\n')
  const change = office.change(call(), { requirement: requirementId, reason: '上游变更', changes: ['x'], decision: 'approved', decidedBy: '张三' })
  assert.match(change.change.impact.note, /无法解析/u, `note 必须报出坏行：${change.change.impact.note}`)
  assert.match(change.change.impact.note, /1 行/u, '必须给出坏行数')
})

test('m5 反向：追溯图为空时 note 明确说"空集 + 请人工确认"，不得谎称"自动算出"', () => {
  const requirementId = baselineRequirement()
  office.storeFor(workspace).writeText(['trace', 'links.jsonl'], '')
  const change = office.change(call(), { requirement: requirementId, reason: '上游变更', changes: ['x'], decision: 'approved', decidedBy: '张三' })
  assert.match(change.change.impact.note, /追溯图为空/u)
  assert.equal(change.change.impact.note.includes('自动算出'), false, '空集不得出现"自动算出"')
})

test('Z-3：create / contract 上不被消费的 by / note 必须在回执里点名（不得静默吞掉）', async () => {
  baselineRequirement()
  const harness = toolHarness(workspace)
  // 设计前置：本宿主没有交互式计划评审通道 → 走显式评审出口
  await harness.callTool('sdo_design', { action: 'review', approvedBy: '张三' })
  const created = await harness.callTool('sdo_design', { action: 'create', kind: 'component', name: '订单服务', by: '张三', note: '我批注' })
  assert.match(created, /没有被使用/u, `create 回执必须点名未使用的入参：${created}`)
  assert.match(created, /by/u)
  const contract = await harness.callTool('sdo_design', { action: 'contract', producer: '订单服务', consumer: '外部对账', schema: 'x', by: '张三', note: '批注' })
  assert.match(contract, /没有被使用/u, `contract 回执必须点名未使用的入参：${contract}`)
  // 反向：不给这两个入参时不得出现噪声
  const clean = await harness.callTool('sdo_design', { action: 'create', kind: 'component', name: '支付服务' })
  assert.equal(clean.includes('没有被使用'), false, '没传就不该有噪声')
})

// —————————————————————— M1：回答不改分必须说清；命令面补 --dimensions ——————————————————————

test('M1：不带 dimensions 的回答必须如实说明"答案正文不改分"，并给出可移动评分的入口', () => {
  const captured = office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call(), { id: captured.requirement.id, addAcceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }] })
  office.grill(call(), { requirementIds: [captured.requirement.id] })
  const question = office.questions(call()).find((q) => q.status === 'open')
  assert.ok(question !== undefined)
  const before = office.requirements(call()).find((r) => r.id === captured.requirement.id)?.ambiguity.score
  const result = office.answer(call(), { id: question.id, answer: 'P99 < 200 毫秒，按订单号幂等，异常时降级' })
  assert.ok(result !== undefined)
  const receipt = describeAnswerRef(result, [], { dimensionsGiven: false })
  assert.ok(receipt.includes(t('uiDescribe.answerNoDimensions')), `回执必须如实说明答案不改分：${receipt}`)
  const after = office.requirements(call()).find((r) => r.id === captured.requirement.id)?.ambiguity.score
  assert.equal(after, before, '不带给 dimensions 时评分确实不变（正是要如实说明的事实）')

  // 命令面必须能移动评分：`/sdo-answer` 的帮助文案要提到 --dimensions
  assert.match(t('command.sdo-answer'), /--dimensions/u)
  // 工具面网关：带 dimensions 时评分真的动，且回执不再提示
  const moved = office.answer(call(), { id: question.id, answer: '再次确认', modelDimensions: ALL2 })
  assert.ok(moved !== undefined)
  assert.equal(describeAnswerRef(moved, [], { dimensionsGiven: true }).includes(t('uiDescribe.answerNoDimensions')), false)
})

// —————————————————————— 工具通道装配（与 m15/m18 同一份） ——————————————————————

const { describeAnswer: describeAnswerRef } = await import('../src/interface/describe.js')
const designModule = await import('../src/domain/design.js')

function argsOf(value: Record<string, unknown>): DesignArgs {
  return value as unknown as DesignArgs
}

interface ToolHarness {
  tools: ToolDefinition[]
  callTool(name: string, args: Record<string, unknown>): Promise<string>
}

/** 真实装配 + 按 schema 过滤入参（复现宿主的入参过滤）。 */
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

void fmt
