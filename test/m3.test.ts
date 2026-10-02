import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { CHECKERS, evaluateGate } from '../src/domain/gates.js'
import { Journal } from '../src/infra/journal.js'
import { listIssues } from '../src/domain/issues.js'
import { isEffectivelyOpen } from '../src/domain/dor.js'
import { exitGates, loadAllProcesses, loadProcess, nextPhase, phaseLabel } from '../src/domain/process.js'
import { SoftwareDevOffice, processOfProject } from '../src/office.js'
import { prepareG2 } from './support/g2-fixture.js'
import type { SdoConfig } from '../src/config.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m3/', import.meta.url))

let workspace: string
let office: SoftwareDevOffice
const call = (): { sessionId: string } => ({ sessionId: 's1' })

function setup(process = 'waterfall'): void {
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), { name: 'M3 测试', process, scale: 'normal', stakeholders: ['业务方'] })
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 让 G0 需要的台账字段齐备。 */
function completeLedger(): void {
  office.updateProject(call(), {
    scopeIn: ['对账差异检测'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['差异识别率 ≥ 99%'],
    glossary: { 差异: '同一笔业务在两侧系统的不一致记录' },
  })
}

test('流程即数据：四个流程都能加载，阶段与门禁由数据决定', () => {
  const processes = loadAllProcesses()
  assert.deepEqual(processes.map((process) => process.id).sort(), ['agile', 'prototype', 'spiral', 'waterfall'])

  const waterfall = loadProcess('waterfall')
  assert.ok(waterfall !== undefined)
  assert.deepEqual(waterfall.phases.map((phase) => phase.id), [
    'intake',
    'feasibility',
    'requirements',
    'architecture',
    'design-plan',
    'construction',
    'verification',
    'delivery',
  ])
  assert.equal(phaseLabel(waterfall, 'design-plan'), '详细设计')
  assert.deepEqual(exitGates(waterfall, 'requirements'), ['G2'])
  assert.equal(nextPhase(waterfall, 'delivery'), undefined)

  // 专属门禁：原型的原型验收门、敏捷的迭代门、螺旋的风险象限门
  assert.ok(loadProcess('prototype')?.gates.some((gate) => gate.id === 'GP'))
  assert.ok(loadProcess('agile')?.gates.some((gate) => gate.id === 'GI'))
  assert.ok(loadProcess('spiral')?.gates.some((gate) => gate.id === 'GR'))
  // 原型的阶段顺序把原型放在需求之前（先探测再回填）
  const prototype = loadProcess('prototype')
  assert.ok(prototype !== undefined)
  assert.ok(
    prototype.phases.findIndex((phase) => phase.id === 'prototype')
      < prototype.phases.findIndex((phase) => phase.id === 'requirements'),
  )
})

test('E2E-08 切流程：阶段序列与门禁随流程数据变化，并同步写回 .sdo/config.yml', () => {
  setup()
  const waterfall = office.process(call())
  assert.equal(waterfall.id, 'waterfall')
  assert.equal(waterfall.phases.some((phase) => phase.id === 'design-plan'), true)

  const result = office.updateProject(call(), { process: 'agile' })
  assert.deepEqual(result.changed, ['process'])

  const agile = office.process(call())
  assert.equal(agile.id, 'agile')
  assert.deepEqual(agile.phases.map((phase) => phase.id), [
    'intake',
    'feasibility',
    'requirements',
    'architecture',
    'iteration',
    'release',
    'delivery',
  ])
  assert.equal(agile.phases.some((phase) => phase.id === 'design-plan'), false, '敏捷没有单独的设计阶段')
  assert.ok(agile.gates.some((gate) => gate.id === 'GI'), '敏捷有迭代 DoD 门')
  // 阶段结构变化后，待判定门禁仍指向当前阶段（intake）的出口门禁
  assert.equal(office.status(call()).pendingGate, 'G0')
  // 项目级配置跟随（否则 config.yml 与台账会长期不一致）
  const config = readFileSync(join(workspace, '.sdo', 'config.yml'), 'utf8')
  assert.match(config, /process: agile/u)
})

test('E2E-08 边界：中途切到"不含当前阶段"的流程必须明确拒绝，而不是把项目卡死', () => {
  setup()
  // 沿瀑布推进到 design-plan（逐个豁免门禁，模拟真实的 waiver 路径）
  for (const gate of ['G0', 'G1', 'G2', 'G3']) {
    office.waiveGate(call(), gate, '测试用豁免', '测试')
    office.advance(call())
  }
  assert.equal(office.status(call()).project?.phase, 'design-plan')

  // agile 没有 design-plan → 拒绝，并给出新流程的阶段序列
  assert.throws(() => office.updateProject(call(), { process: 'agile' }), /不在它的阶段序列里/u)
  // 未知流程拼错要报错，而不是静默退回 waterfall
  assert.throws(() => office.updateProject(call(), { process: 'watterfall' }), /未知流程/u)
  // 守卫是"按阶段存在性"判定的，不是一刀切：prototype 与 spiral 都有 design-plan → 放行
  const spiral = office.updateProject(call(), { process: 'spiral' })
  assert.deepEqual(spiral.changed, ['process'])
  assert.equal(office.process(call()).id, 'spiral')
  assert.equal(office.status(call()).project?.phase, 'design-plan')
  const prototype = office.updateProject(call(), { process: 'prototype' })
  assert.deepEqual(prototype.changed, ['process'])
  assert.equal(office.process(call()).id, 'prototype')
})

test('切到原型流程：同时建立原型目录、README 与 throwaway 标记', () => {
  setup()
  office.updateProject(call(), { process: 'prototype' })
  assert.ok(existsSync(join(workspace, 'prototype', 'README.md')))
  const config = readFileSync(join(workspace, '.sdo', 'config.yml'), 'utf8')
  assert.match(config, /process: prototype/u)
  assert.match(config, /throwaway: true/u)
  // GP 会立刻按新流程生效
  const gp = office.evaluate(call(), 'GP')
  assert.equal(gp.criteria.find((criterion) => criterion.id === 'C-70')?.ok, false)
})

test('G0：台账不全时逐条给出缺口与 remedy；补齐后通过', () => {
  setup()
  const before = office.checkGate(call(), 'G0')
  assert.equal(before.status, 'failed')
  assert.equal(before.criteria.length, 4)
  // init 已给干系人 → C-03 通过；范围/非目标/度量仍缺
  assert.deepEqual(
    before.criteria.map((criterion) => [criterion.id, criterion.ok]),
    [['C-01', false], ['C-02', false], ['C-03', true], ['C-04', false]],
  )
  for (const criterion of before.criteria.filter((item) => !item.ok)) {
    assert.ok((criterion.remedy ?? '').length > 0, `${criterion.id} 必须给 remedy`)
  }
  assert.match(before.criteria.find((c) => c.id === 'C-02')?.detail ?? '', /非目标/u)

  completeLedger()
  const after = office.checkGate(call(), 'G0')
  assert.equal(after.status, 'passed')
  assert.ok(after.criteria.every((criterion) => criterion.ok))
  // 落盘 + 留痕
  const recorded = JSON.parse(readFileSync(join(workspace, '.sdo', 'gates', 'G0.json'), 'utf8')) as {
    gate: string
    status: string
    criteria: unknown[]
  }
  assert.equal(recorded.gate, 'G0')
  assert.equal(recorded.status, 'passed')
  assert.equal(recorded.criteria.length, 4)
  const events = office.journalFor(workspace).read().events.filter((event) => event.type === 'gate/result')
  assert.equal(events.length, 2, '每次判定都要留痕')
})

test('度量必须可测：没有数值的成功度量不算通过', () => {
  setup()
  office.updateProject(call(), { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['尽量快'] })
  const evaluation = office.evaluate(call(), 'G0')
  const metric = evaluation.criteria.find((criterion) => criterion.id === 'C-04')
  assert.equal(metric?.ok, false)
  assert.match(metric?.detail ?? '', /不可测/u)
})

test('advance：门禁未过即拒绝并给出缺口；通过后推进阶段并写 phaseHistory', () => {
  setup()
  const blocked = office.advance(call())
  assert.equal(blocked.advanced, false)
  assert.equal(blocked.blockedBy, 'G0')
  assert.ok((blocked.remedy ?? []).length > 0)

  completeLedger()
  office.checkGate(call(), 'G0')
  const advanced = office.advance(call())
  assert.equal(advanced.advanced, true)
  assert.equal(advanced.to, 'feasibility')

  const project = office.status(call()).project
  assert.equal(project?.phase, 'feasibility')
  assert.equal(project?.phaseHistory.length, 2)
  assert.equal(project?.phaseHistory[0]?.exited !== undefined, true)
  assert.equal(office.status(call()).pendingGate, 'G1')
})

test('不变量：每个流程的每条门禁准则都有已实现的检查器（不允许"查不到就算过"）', () => {
  setup()
  completeLedger()
  const missing: string[] = []
  for (const process of loadAllProcesses()) {
    for (const gate of process.gates) {
      for (const criterion of gate.criteria) {
        // DoR 的四条准则由 evaluateDor 复用，其余必须在 CHECKERS 注册表里
        const viaDor = ['C1-dor-per-requirement', 'C2-open-questions', 'C3-must-has-ac', 'C4-glossary', 'C5-non-goals', 'C6-red-team', 'C7-signoff', 'C8-red-team-closed']
        if (viaDor.includes(criterion.id)) continue
        if (CHECKERS[criterion.check] === undefined) missing.push(`${process.id}/${gate.id}/${criterion.id}(${criterion.check})`)
      }
    }
  }
  assert.deepEqual(missing, [], `缺检查器：${missing.join(' ')}`)

  // 反向：判定时绝不允许再出现"尚未实现"
  for (const process of loadAllProcesses()) {
    for (const gate of process.gates) {
      const evaluation = evaluateGate(process, gate.id, {
        workspace,
        store: office.storeFor(workspace),
        journal: new Journal(office.storeFor(workspace)),
        process,
        project: office.status(call()).project,
        requirements: [],
        questions: [],
        risks: [],
        issues: [],
        feasibility: undefined,
        redTeamExecuted: false,
        redTeamDisabled: false,
        waivedGates: [],
        prototypeDir: 'prototype',
        prototypeThrowaway: false,
        riskConclusion: undefined,
      })
      for (const criterion of evaluation.criteria) {
        assert.equal(
          /尚未实现/u.test(criterion.detail),
          false,
          `${process.id}/${gate.id}/${criterion.id} 仍报未实现：${criterion.detail}`,
        )
      }
    }
  }
})

test('waive：显式豁免留痕（tailoring.waivedGates + 门禁记录 waived），随后可推进', () => {
  setup()
  completeLedger()
  const recorded = office.waiveGate(call(), 'G0', '本次为内部试验，非目标暂缺', '项目经理')
  assert.equal(recorded.status, 'waived')

  const project = office.status(call()).project
  assert.deepEqual(project?.tailoring?.waivedGates, ['G0'])
  const events = office.journalFor(workspace).read().events
  assert.ok(events.some((event) => event.type === 'tailoring/updated'))
  assert.ok(events.some((event) => event.type === 'gate/result' && event.data['status'] === 'waived'))

  const advanced = office.advance(call())
  assert.equal(advanced.advanced, true, '豁免后应可推进')
})

test('G1：需要 Go 结论 + 已登记风险（高/阻塞级必须有应对与责任人）+ PoC 建议', () => {
  setup()
  const before = office.checkGate(call(), 'G1')
  assert.equal(before.status, 'failed')
  assert.match(before.criteria.find((c) => c.id === 'C-05')?.detail ?? '', /尚未做可行性评估/u)

  office.assessFeasibility(
    call(),
    {
      verdict: 'go',
      rationale: '技术可行，风险可控',
      telos: { technical: { verdict: '可行', rationale: '依赖都是现成的' } },
      poc: ['用 1 天验证上游文件格式的稳定性'],
    },
    '架构师',
  )
  const noRisk = office.checkGate(call(), 'G1')
  assert.match(noRisk.criteria.find((c) => c.id === 'C-06')?.detail ?? '', /风险登记为空/u)

  // 高风险但缺 mitigation/owner → 仍然拒绝
  const risk = office.logRisk(call(), {
    title: '上游文件格式可能变更',
    level: 'high',
    probability: 'medium',
    impact: '对账中断',
    mitigation: '',
    owner: '',
  })
  const missing = office.checkGate(call(), 'G1')
  assert.equal(missing.status, 'failed')
  assert.match(missing.criteria.find((c) => c.id === 'C-06')?.detail ?? '', /缺应对或责任人/u)

  office.updateRisk(call(), risk.id, { mitigation: '加格式校验 + 失败告警', owner: '业务方' })
  const passed = office.checkGate(call(), 'G1')
  assert.equal(passed.status, 'passed', `G1 应通过：${passed.remedy.join(' / ')}`)
  assert.equal(office.risks(call()).length, 1)
})

test('原型：目录隔离 + throwaway 标记 + 回填需求（GP 与 G7 的 C-61/C-62）', () => {
  setup('prototype')
  // init 阶段：目录与 README 已就位，配置标记 throwaway
  assert.ok(existsSync(join(workspace, 'prototype', 'README.md')))
  const config = readFileSync(join(workspace, '.sdo', 'config.yml'), 'utf8')
  assert.match(config, /throwaway: true/u)

  // 没有实质内容 → GP 不过
  const empty = office.checkGate(call(), 'GP')
  assert.match(empty.criteria.find((c) => c.id === 'C-70')?.detail ?? '', /没有实质内容/u)

  // 放入原型代码 + 回填需求
  writeFileSync(join(workspace, 'prototype', 'mock.ts'), 'export const mock = 1\n')
  office.capture(call(), {
    title: '对账差异检测（原型探针结论）',
    statement: '系统须在每日对账后识别金额或状态不一致的记录；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: undefined,
    prototypeSource: true,
    sourceRaw: '原型探针结论（整目录可丢弃）',
  })
  const gp = office.checkGate(call(), 'GP')
  assert.equal(gp.status, 'passed', `GP 应通过：${gp.remedy.join(' / ')}`)
  assert.equal(office.requirements(call())[0]?.source.prototype, true, '回填来源应被标记')

  // 交付门禁拒绝原型内容
  const g7 = office.checkGate(call(), 'G7')
  assert.equal(g7.criteria.find((c) => c.id === 'C-61')?.ok, false)
  assert.match(g7.criteria.find((c) => c.id === 'C-61')?.detail ?? '', /不得进入交付产物/u)

  // 删掉原型目录后，C-61 通过（C-60 交付清单仍未实现 → 整体仍失败，这是刻意的）
  rmSync(join(workspace, 'prototype'), { recursive: true, force: true })
  const after = office.evaluate(call(), 'G7')
  assert.equal(after.criteria.find((c) => c.id === 'C-61')?.ok, true)
})

test('红队议题闭环：答完质询问题，或登记一条指向议题的风险', () => {
  setup()
  office.capture(call(), { title: '对账差异检测', statement: '系统要尽快识别对账差异', priority: 'must', sourceStakeholder: 'STK-01' })
  const attack = office.redTeamAttack(call(), ['REQ-001'], 7)
  assert.ok(attack.questions.length > 0)
  const issues = office.issues(call())
  assert.equal(issues.length, 1)
  assert.equal(issues[0]?.target, 'REQ-001')
  assert.ok((issues[0]?.angles.length ?? 0) > 0)

  const openBefore = office.openIssues(call())
  assert.equal(openBefore.length, 1)

  // 路径 A：答完该议题下的全部质询问题
  let guard = 0
  while (guard++ < 30) {
    const open = office.questions(call()).filter(
      (question) => question.status === 'open' && issues[0]?.questionIds.includes(question.id),
    )
    if (open.length === 0) break
    office.answer(call(), { id: open[0]!.id, answer: '', assume: true, authorizedByUser: true })
  }
  assert.equal(office.openIssues(call()).length, 0, '质询答完 → 议题闭环')

  // 路径 B：另一条需求，直接登记指向议题的风险
  office.capture(call(), { title: '导出差异清单', statement: '系统须支持导出对账差异清单，格式为 CSV', priority: 'must', sourceStakeholder: 'STK-01' })
  office.redTeamAttack(call(), ['REQ-002'], 7)
  const issue2 = office.issues(call()).find((issue) => issue.target === 'REQ-002')
  assert.ok(issue2 !== undefined)
  assert.equal(office.openIssues(call()).length, 1)
  office.logRisk(call(), {
    title: '导出的差异清单可能包含未授权字段',
    level: 'medium',
    probability: 'low',
    impact: '合规风险',
    mitigation: '导出前列白字段',
    owner: '业务方',
    origin: issue2.id,
  })
  assert.equal(office.openIssues(call()).length, 0, '转为风险 → 议题闭环')
  assert.ok(listIssues(office.storeFor(workspace)).length >= 2)
})

test('变更控制：基线后的修改走 CR；rejected 不应用，approved 才应用', () => {
  setup()
  completeLedger()
  office.assessFeasibility(call(), { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  office.logRisk(call(), {
    title: '格式变更',
    level: 'low',
    probability: 'low',
    impact: '小',
    mitigation: '校验',
    owner: '业务方',
  })
  // 造一条完全就绪的需求并基线
  const captured = office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别金额或状态不一致的记录；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call(), {
    id: captured.requirement.id,
    addAcceptance: [{ id: 'AC-001', given: '已导入两日对账文件', when: '执行对账', then: '输出差异清单' }],
    modelDimensions: { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 },
  })
  office.redTeamAttack(call(), [captured.requirement.id], 7)
  let guard = 0
  while (guard++ < 40) {
    const open = office.questions(call()).filter((question) => question.status === 'open')
    if (open.length === 0) break
    office.answer(call(), {
      id: open[0]!.id,
      answer: '已确认',
      modelDimensions: { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 },
    })
  }
  // D1 + D4：未决 P1 补风险处置，再签 G2 字（放行依据是签字台账）
  prepareG2(office, call())
  const baseline = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(baseline.ok, true, `基线应通过：${baseline.dor.failed.join(',')}`)

  // rejected：只留档，不改需求
  const rejected = office.change(call(), {
    requirement: captured.requirement.id,
    reason: '想放宽时延要求',
    changes: ['P99 放宽到 2 秒'],
    decision: 'rejected',
    decidedBy: '张三',
    patch: { statement: '系统须在每日对账后识别差异；P99 < 2000 毫秒' },
  })
  assert.equal(rejected.applied, false)
  assert.equal(office.requirements(call())[0]?.statement.includes('2000'), false)

  // approved：应用并升版本
  const approved = office.change(call(), {
    requirement: captured.requirement.id,
    reason: '上游数据量翻倍',
    changes: ['P99 调整为 800 毫秒'],
    decision: 'approved',
    decidedBy: '张三',
    patch: { statement: '系统须在每日对账后识别差异；单日 200 万，P99 < 800 毫秒' },
  })
  assert.equal(approved.applied, true)
  const updated = office.requirements(call())[0]
  assert.match(updated?.statement ?? '', /800 毫秒/u)
  assert.equal(updated?.status, 'changed')
  assert.equal(updated?.version, 0.3)
  assert.equal(office.changes(call()).length, 2)
  assert.ok(existsSync(join(workspace, '.sdo', 'changes', 'CR-001.yml')))
  const events = office.journalFor(workspace).read().events
  assert.equal(events.filter((event) => event.type === 'change/requested').length, 2)
  assert.equal(events.filter((event) => event.type === 'change/decided').length, 2)
})

test('螺旋：风险象限门需要本圈结论；结论未写即失败', () => {
  setup('spiral')
  office.logRisk(call(), {
    title: '圈次风险',
    level: 'medium',
    probability: 'medium',
    impact: '中',
    mitigation: '缓解',
    owner: '架构师',
  })
  const before = office.evaluate(call(), 'GR')
  assert.equal(before.criteria.find((c) => c.id === 'C-92')?.ok, false)
  assert.match(before.criteria.find((c) => c.id === 'C-92')?.detail ?? '', /还没有风险结论/u)

  office.concludeRisk(call(), 'continue', '风险可控，进入下一圈', '架构师')
  const after = office.evaluate(call(), 'GR')
  assert.equal(after.criteria.find((c) => c.id === 'C-92')?.ok, true)
  assert.equal(after.criteria.find((c) => c.id === 'C-90')?.ok, true)
  assert.equal(after.status, 'passed')
})

test('状态快照带上风险/议题/可行性/变更计数（状态块与看板的输入）', () => {
  setup()
  office.assessFeasibility(call(), { verdict: 'conditional', rationale: '待验证', poc: ['验证 X'] })
  office.logRisk(call(), {
    title: 'R',
    level: 'blocker',
    probability: 'high',
    impact: '停摆',
    mitigation: '备份',
    owner: '张三',
  })
  const status = office.status(call())
  assert.equal(status.feasibilityVerdict, 'conditional')
  assert.deepEqual(status.risks, { total: 1, open: 1, blockers: 1, high: 0 })
  assert.equal(status.openIssues, 0)
  assert.equal(status.changes, 0)
  assert.equal(processOfProject(status.project).id, 'waterfall')
})

test('evaluateGate 对未知门禁给出可用门禁清单（不静默通过）', () => {
  setup()
  const process = loadProcess('waterfall')
  assert.ok(process !== undefined)
  const evaluation = evaluateGate(process, 'G99', {
    workspace,
    store: office.storeFor(workspace),
    journal: new Journal(office.storeFor(workspace)),
    process,
    project: office.status(call()).project,
    requirements: [],
    questions: [],
    risks: [],
    issues: [],
    feasibility: undefined,
    redTeamExecuted: false,
    redTeamDisabled: false,
    waivedGates: [],
    prototypeDir: 'prototype',
    prototypeThrowaway: false,
    riskConclusion: undefined,
  })
  assert.equal(evaluation.status, 'failed')
  assert.match(evaluation.criteria[0]?.remedy ?? '', /可用门禁/u)
})

test('DEF-06：需求必须有来源——无 sourceRaw/sourceStakeholder 时拒绝落账', () => {
  setup()
  assert.throws(
    () => office.capture(call(), { title: '猜的需求', statement: '系统须支持 X；P99 < 1 秒', priority: 'must' }),
    /没有来源/u,
    'agent 不得替用户发明需求',
  )
  const ok = office.capture(call(), {
    title: '用户说的',
    statement: '系统须支持 X；P99 < 1 秒',
    priority: 'must',
    sourceRaw: '我要能查可用房间',
  })
  assert.equal(ok.requirement.source.raw, '我要能查可用房间')
})

test('DEF-07：assume 必须由用户授权；未授权假设在 DoR 里仍算未决', () => {
  setup()
  const c = office.capture(call(), {
    title: 'r',
    statement: '系统须支持 X；P99 < 1 秒',
    priority: 'must',
    sourceRaw: '用户原话',
  })
  office.redTeamAttack(call(), [c.requirement.id], 2)
  const q = office.questions(call())[0]
  assert.ok(q !== undefined)
  assert.throws(() => office.answer(call(), { id: q.id, answer: '', assume: true }), /自问自答/u)
  office.answer(call(), { id: q.id, answer: '', assume: true, authorizedByUser: true })
  assert.equal(office.questions(call())[0]?.authorizedByUser, true)
  assert.equal(isEffectivelyOpen({ status: 'assumed' } as never), true, '未授权假设 = 实质未决')
  assert.equal(isEffectivelyOpen({ status: 'assumed', authorizedByUser: true } as never), false)
  assert.equal(isEffectivelyOpen({ status: 'answered' } as never), false)
})

test('DEF-10：红队问题必须由需求内容派生（不许同一句模板复制 N 份）', () => {
  setup()
  const a = office.capture(call(), {
    title: '提交房间预定',
    statement: '系统须允许客人提交预定；单日 1 万次，P99 < 500 毫秒',
    priority: 'must',
    sourceRaw: '用户原话 A',
  })
  const b = office.capture(call(), {
    title: '按编号查询预定',
    statement: '系统须允许凭预定编号查询状态；日活 2 万',
    priority: 'must',
    sourceRaw: '用户原话 B',
  })
  const attack = office.redTeamAttack(call(), [a.requirement.id, b.requirement.id], 4)
  const texts = attack.questions.map((question) => question.text)
  assert.ok(texts.length >= 2, '至少两条需求各拿到问题')
  // 每条问题必须带**自己需求的标题**
  const forA = texts.filter((text) => text.includes('提交房间预定'))
  const forB = texts.filter((text) => text.includes('按编号查询预定'))
  assert.ok(forA.length > 0 && forB.length > 0, '问题须指向具体需求')
  // 不同需求的问题文字必须不同（不是复制）
  assert.notDeepEqual(forA, forB, '不同需求不得是同一句复制')
  // 派生自需求的分析：问题里应出现"该需求在…上尚未澄清"这类来自评分的措辞（若有 0 分维度）
  assert.ok(texts.some((text) => text.includes('尚未澄清')) || texts.every((text) => text.includes('针对「')), '问题应体现需求自身状况')
})

test('方案B：红队质询由模型生成、插件校验（必须引用需求原文用词）', () => {
  setup()
  const c = office.capture(call(), {
    title: '提交房间预定',
    statement: '系统须允许客人提交房间预定；单日 1 万次，P99 < 500 毫秒',
    priority: 'must',
    sourceRaw: '用户原话',
  })
  const spec = office.proposeRedTeam(call(), [c.requirement.id], 2)
  assert.match(spec, /提交房间预定/u, '提案必须带上需求标题')
  assert.match(spec, /单日 1 万次/u, '提案必须带上需求原文（供模型引用）')
  const res = office.fileRedTeam(call(), c.requirement.id, [
    { text: '客人重复提交同一房间预定会怎样？', dimension: 'data' },
    { text: '这个功能会不会出问题？' },
    { text: '系统须允许客人提交房间预定' },
    { text: '客人重复提交同一房间预定会怎样？' },
  ])
  assert.equal(res.accepted.length, 1, '只有引用原文且是问句的那条通过')
  assert.equal(res.rejected.length, 3)
  assert.ok(res.rejected.some((item) => item.reason.includes('原文')), '不引用原文要被拒并说明')
  assert.ok(res.rejected.some((item) => item.reason.includes('问号')), '不是问句要被拒')
  assert.ok(res.rejected.some((item) => item.reason.includes('重复')), '重复要被拒')
  assert.equal(res.accepted[0]?.origin, 'red-team')
  assert.ok(office.issues(call()).some((issue) => issue.target === c.requirement.id), '红队议题要开出来（必须闭环）')
})

test('D1：无 plan mode 的宿主必须有出口——用户评审或显式豁免后可继续', () => {
  setup()
  // 先有需求，才能走到"计划评审"这道前置（否则会先被 designCheck 拦在"没有任何需求"）
  office.capture(call(), {
    title: 'r',
    statement: '系统须支持 X；P99 < 1 秒',
    priority: 'must',
    sourceRaw: '用户原话',
  })
  const unavailable = { available: false, active: false }
  const before = office.designPrecondition(call(), unavailable)
  assert.equal(before.kind, 'blocked-no-reviewer', '没有出口时必须阻塞（Q-20）')
  // 出口一：用户在本会话内评审
  office.markPlanApproved(call(), '我本人', '计划已看过')
  assert.notEqual(office.designPrecondition(call(), unavailable).kind, 'blocked-no-reviewer', '评审后不得再因"无通道"阻塞')
  // 出口二：显式豁免（另一个项目，验证独立）
  const other = office.designPrecondition(call(), unavailable)
  assert.ok(other.kind !== 'no-project', '项目存在')
  office.waivePlanReview(call(), '本原型不做计划评审', '我本人')
  const after = office.designPrecondition(call(), unavailable)
  assert.notEqual(after.kind, 'blocked-no-reviewer', '豁免后不得再阻塞')
})

test('D2：capture 必须写入 acceptance（旧实现静默丢弃）', () => {
  setup()
  const captured = office.capture(call(), {
    title: '带验收标准的需求',
    statement: '系统须在每日对账后输出差异清单；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceRaw: '用户原话',
    acceptance: [
      { id: 'AC-001', given: '已导入两日文件', when: '执行对账', then: '输出差异清单' },
      { id: 'AC-002', given: '两日一致', when: '执行对账', then: '输出空清单' },
    ],
  })
  assert.equal(captured.requirement.acceptance.length, 2, '验收标准必须落盘')
  assert.ok(!captured.flags.some((flag) => flag.includes('no-ac')), '不得再报"缺验收标准"')
})
