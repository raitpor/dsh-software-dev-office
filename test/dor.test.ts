import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { evaluateDor } from '../src/domain/dor.js'
import { listRequirements, readRequirement } from '../src/domain/requirements.js'
import { renderSrs } from '../src/infra/render.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { Requirement, SdoProject } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/dor/', import.meta.url))

let workspace: string
let office: SoftwareDevOffice
const call = (): { sessionId: string } => ({ sessionId: 's1' })

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), {
    name: '门禁测试',
    scopeOut: ['自动调账', '财务凭证'],
    stakeholders: ['业务方'],
    metricsSuccess: ['差异识别率 ≥ 99%'],
    glossary: { 差异: '同一笔业务在两侧系统的不一致记录', 对账周期: 'T 日与 T-1 日' },
  })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function project(): SdoProject {
  const status = office.status(call())
  assert.ok(status.project !== undefined)
  return status.project
}

/** 造一条完全就绪的需求（用于正例）。 */
function readyRequirement(): string {
  const captured = office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别金额或状态不一致的记录；单日数据量 100 万，P99 < 500 毫秒',
    rationale: '人工核对成本高且漏检',
    priority: 'must',
    sourceStakeholder: 'STK-01',
    sourceRaw: '对账太慢，经常漏',
  })
  office.update(call(), {
    id: captured.requirement.id,
    addAcceptance: [
      { id: 'AC-001', given: '已导入 T 日与 T-1 日对账文件', when: '执行对账', then: '输出差异清单，含记录 ID 与差异类型' },
      { id: 'AC-002', given: '两日文件完全一致', when: '执行对账', then: '输出空差异清单且不报错' },
    ],
    modelDimensions: { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 },
  })
  return captured.requirement.id
}

test('DoR 负例：要一条条指出未满足项并给 remedy', () => {
  office.capture(call(), {
    title: '含糊需求',
    statement: '系统要尽快支持对账',
    priority: undefined,
    // 负例保留"含糊 + 无优先级"即可挂 C1；但**来源必填**是硬纪律，故这里给出来源
    sourceRaw: '系统要尽快支持对账（用户原话）',
  })
  const requirement = listRequirements(office.storeFor(workspace))[0] as Requirement
  const redTeamRequired = (project().tailoring?.scale ?? 'normal') !== 'trivial'

  const result = evaluateDor({
    project: project(),
    requirements: [requirement],
    questions: [],
    redTeamExecuted: false,
    redTeamDisabled: false,
  })
  assert.equal(result.ok, false)
  assert.ok(result.failed.includes('C1-dor-per-requirement'), '含糊需求应挂在 C1')
  assert.ok(result.failed.includes('C7-signoff'), '未签字应挂 C7')
  if (redTeamRequired) assert.ok(result.failed.includes('C6-red-team'), '未跑红队应挂 C6')
  const c1 = result.criteria.find((criterion) => criterion.id === 'C1-dor-per-requirement')
  assert.match(c1?.detail ?? '', /评分/u)
  assert.ok((c1?.remedy ?? '').length > 0, '失败准则必须给 remedy')
})

test('DoR 负例：P0 未决问题拦住基线', () => {
  const id = readyRequirement()
  office.grill(call(), { requirementIds: [id] })
  const result = office.dor(call(), '张三')
  assert.equal(result.ok, false)
  assert.ok(result.failed.includes('C2-open-questions'))
  assert.match(result.criteria.find((c) => c.id === 'C2-open-questions')?.detail ?? '', /P0 未决/u)
})

test('DoR 负例：must 需求缺 AC 挂 C3；无非目标挂 C5', () => {
  const captured = office.capture(call(), {
    sourceRaw: '用户原话（负例夹具）',
    title: '缺 AC',
    statement: '系统须输出差异清单；单日 100 万条，P99 < 500 毫秒',
    priority: 'must',
  })
  office.update(call(), {
    id: captured.requirement.id,
    modelDimensions: { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 0, boundary: 2 },
  })
  const result = evaluateDor({
    project: { ...project(), scope: { in: [], out: [] }, glossary: {} },
    requirements: listRequirements(office.storeFor(workspace)),
    questions: [],
    redTeamExecuted: true,
    redTeamDisabled: false,
    approvedBy: '张三',
  })
  assert.ok(result.failed.includes('C3-must-has-ac'))
  assert.ok(result.failed.includes('C4-glossary'))
  assert.ok(result.failed.includes('C5-non-goals'))
})

test('基线：DoR 未过即拒（E2E-01 的负例），不留 G2 记录、不推进阶段', () => {
  const id = readyRequirement()
  office.grill(call(), { requirementIds: [id] })
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, false)
  assert.equal(existsSync(join(workspace, '.sdo', 'gates', 'G2.json')), false, '被拒时不得写门禁记录')
  assert.equal(office.status(call()).project?.phase, 'intake', '阶段不得推进')
  assert.equal(readRequirement(office.storeFor(workspace), id)?.status, 'draft')
})

test('基线：答完 P0 + 跑红队 + 签字 → G2 通过并推进到 architecture', () => {
  const id = readyRequirement()
  office.grill(call(), { requirementIds: [id] })

  // 回答全部 P0（用 assume 走默认建议），并给足语义分
  let guard = 0
  while (guard++ < 60) {
    const open = office.questions(call()).filter((question) => question.status === 'open')
    if (open.length === 0) break
    const question = open[0]
    assert.ok(question !== undefined)
    office.answer(call(), {
      id: question.id,
      answer: '',
      assume: true, authorizedByUser: true,
      modelDimensions: { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 },
    })
  }
  assert.equal(office.questions(call()).filter((q) => q.status === 'open').length, 0)

  office.redTeamAttack(call(), [id], 7)
  let redGuard = 0
  while (redGuard++ < 60) {
    const open = office.questions(call()).filter((question) => question.status === 'open')
    if (open.length === 0) break
    const question = open[0]
    assert.ok(question !== undefined)
    office.answer(call(), {
      id: question.id,
      answer: '已确认',
      modelDimensions: { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 },
    })
  }

  const beforeDor = office.dor(call(), '张三')
  assert.equal(beforeDor.ok, true, `DoR 应通过，实际未过：${beforeDor.failed.join(',')}`)

  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.baselined.length, 1)
  assert.equal(outcome.baselined[0]?.status, 'baselined')
  assert.equal(outcome.baselined[0]?.version, 0.2)
  assert.equal(outcome.baselined[0]?.baseline?.by, '张三')

  const gate = JSON.parse(readFileSync(join(workspace, '.sdo', 'gates', 'G2.json'), 'utf8')) as { gate: string; status: string }
  assert.equal(gate.gate, 'G2')
  assert.equal(gate.status, 'passed')
  assert.equal(office.status(call()).project?.phase, 'architecture', 'G2 通过后进入架构阶段')
})

test('设计门禁负例：没有任何需求时必须被拒', () => {
  const check = office.designCheck(call())
  assert.equal(check.allowed, false)
  assert.match(check.reason, /没有任何需求/u)
  assert.ok((check.remedy ?? '').includes('sdo_requirement'))
})

test('设计门禁负例：需求未基线时必须被拒', () => {
  office.capture(call(), { sourceRaw: '用户原话（负例夹具）', title: 'x', statement: '系统要尽快支持对账' })
  const check = office.designCheck(call())
  assert.equal(check.allowed, false)
  assert.match(check.reason, /尚未基线/u)
})

test('设计门禁正例：基线通过后放行（M2 才实现真正的设计工具）', () => {
  const id = readyRequirement()
  office.redTeamAttack(call(), [id], 7)
  let guard = 0
  while (guard++ < 60) {
    const open = office.questions(call()).filter((question) => question.status === 'open')
    if (open.length === 0) break
    office.answer(call(), {
      id: open[0]!.id,
      answer: '',
      assume: true, authorizedByUser: true,
      modelDimensions: { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 },
    })
  }
  const outcome = office.baseline(call(), { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `基线应通过，实际未过：${outcome.dor.failed.join(',')}`)
  const check = office.designCheck(call())
  assert.equal(check.allowed, true, `基线后应放行，实际：${check.reason}`)
})

test('SRS 渲染：头部声明真源与 seq、内容含 AC 与开环问题、且幂等', () => {
  const id = readyRequirement()
  office.grill(call(), { requirementIds: [id] })
  const seq = office.journalFor(workspace).read().events.length
  const input = {
    project: project(),
    requirements: listRequirements(office.storeFor(workspace)),
    questions: office.questions(call()),
    seq,
  }
  const first = renderSrs(input)
  const second = renderSrs(input)
  assert.equal(first, second, '同一状态 + 同一 seq 必须逐字节相同')
  assert.match(first, /^<!-- generated by dsh-software-dev-office v[\d.]+ from \.sdo\/ ; DO NOT EDIT -->/u)
  assert.match(first, new RegExp(`<!-- source: \\.sdo/requirements/\\*\\.yml @ journal seq ${seq} -->`, 'u'))
  assert.match(first, /## 5\. 需求/u)
  assert.match(first, /Given：已导入 T 日与 T-1 日对账文件；When：执行对账；Then：输出差异清单/u)
  assert.match(first, /## 6\. 开环问题/u)
  assert.match(first, /非目标（out）|## 1\. 范围/u)
})

test('渲染落盘：sdo_render 写 docs/SRS.md 并留证据事件', () => {
  readyRequirement()
  const path = office.render(call(), 'srs')
  assert.equal(path, 'docs/SRS.md')
  const text = readFileSync(join(workspace, 'docs', 'SRS.md'), 'utf8')
  assert.match(text, /DO NOT EDIT/u)
  const events = office.journalFor(workspace).read().events.filter((event) => event.type === 'evidence/recorded')
  assert.equal(events.length, 1)
  assert.equal(events[0]?.data['doc'], 'SRS.md')
})
