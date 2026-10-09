/**
 * **增量 84：D-22 / D-23 两条 major（都在上一份报告里，逐条独立复跑之后才修）**
 *
 *   · **D-23（假"被改过"，真根因是 YAML 写读不对称）**：报告的根因写的是"写端存语义哈希、读端算
 *     文件字节哈希"，**复跑不成立** —— 两端都是 `reviewContentHash`（语义），9 条评审里 8 条
 *     `adopted`。但 REV-006 的假红是**真的**，根因不同：写端 `NEEDS_QUOTE` 只在"`#` 后面还有空白"
 *     时加引号，于是 `真机 #1132 复现` 被裸写；读端**只要 `#` 前面是空白就当行内注释剥掉**
 *     ⇒ 读回被**静默截断**（`journal#248（task/blocked）与`），写读哈希自然不等。
 *     影响面比评审大得多：**任何**台账文本（需求陈述/验收标准/证据）在下次写回时会把截断固化。
 *   · **D-22（空变更全额惩罚）**：批准一条**什么都没改**的 CR 会涨版本、置 `changed`、把阶段
 *     从 iteration 打回 requirements、作废 5 道门禁，并让 `change-not-digested` 锁死全部 `claim`
 *     —— 代价是两次人工签字。变更控制本该"改多少、控多少"。
 *
 * 覆盖：YAML 往返（含**手写裸值**的存量文件）/ 评审不再假红 / 真改动仍然判红 /
 * 回执不再假绿（`tampered`、`unrecorded` 不许打印「核实 N/N」）/ 空批准零副作用 + 不锁 claim /
 * 同值重提也算空 / 真变更照旧生效 / `change/noop` 不作废签字。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { undigestedChanges } from '../src/domain/change.js'
import { parseYaml } from '../src/infra/yaml.js'
import { apply } from '../src/index.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { Context } from '@deepseek-ai/cordis'
import type { SdoConfig } from '../src/config.js'
import type { Review } from '../src/domain/records.js'
import type { Requirement } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm84')
const ALL2 = { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 }

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: Record<string, unknown>, exec: unknown) => unknown
}

let office: SoftwareDevOffice
let store: SdoStore
let journal: Journal
let tools: ToolDefinition[]
const call = { sessionId: 's1', cwd: BASE }

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(BASE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', BASE)
  office.init(call, { name: 'M84', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['对账'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['识别率 ≥ 99%'],
    glossary: { 差异: '不一致记录' },
  })
  store = office.storeFor(BASE)
  journal = office.journalFor(BASE)
  tools = []
  const services: Record<string, unknown> = { tools: { register: (tool: ToolDefinition): (() => void) => { tools.push(tool); return () => {} } } }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  return String(
    await tool.execute(filtered, { agent: { id: 's1', session: { header: { id: 's1', cwd: BASE, delegationDepth: 0 } } } }),
  )
}

/** 读一个真源文件（读不到就红）——`readYaml` 的返回类型是可空的，测试里不该到处 `!`。 */
function readYamlFile<T>(section: string, file: string): T {
  const value = store.readYaml<T>(section, file)
  assert.ok(value !== undefined, `读不到 ${section}/${file}`)
  return value
}

/** 造一条已基线需求（`change` 只在这两种状态下接变更单）。 */
function baselinedRequirement(): string {
  office.assessFeasibility(call, { verdict: 'go', rationale: '可行', poc: ['验证格式'] })
  office.logRisk(call, { title: '格式变更', level: 'low', probability: 'low', impact: '小', mitigation: '校验', owner: '业务方' })
  const captured = office.capture(call, {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.update(call, {
    id: captured.requirement.id,
    addAcceptance: [{ id: 'AC-001', given: '已导入两日文件', when: '执行对账', then: '输出差异清单' }],
    modelDimensions: ALL2,
  })
  office.redTeamAttack(call, [captured.requirement.id], 7)
  let guard = 0
  while (guard++ < 40) {
    const open = office.questions(call).filter((question) => question.status === 'open')
    if (open.length === 0) break
    office.answer(call, { id: open[0]!.id, answer: '已确认', modelDimensions: ALL2 })
  }
  for (const question of office.questions(call).filter((item) => item.status === 'open' && item.severity === 'P1')) {
    office.logRisk(call, {
      title: `未决 P1 的风险处置：${question.id}`,
      level: 'medium', probability: 'medium', impact: 'x', mitigation: '按计划回答', owner: '业务方', origin: question.id,
    })
  }
  office.signGate(call, { gate: 'G2', by: '张三', basis: `我确认需求基线可以冻结（M84 第 ${basisRound++} 次表态）`, channel: 'command' })
  const outcome = office.baseline(call, { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `基线应通过：${outcome.dor.failed.join(',')}`)
  return captured.requirement.id
}
let basisRound = 1

const requirement = (id: string): Requirement => {
  const found = office.requirements(call).find((item) => item.id === id)
  assert.ok(found !== undefined, `找不到需求 ${id}`)
  return found
}
const eventTypes = (): string[] => journal.read().events.map((event) => event.type)

// ————————————————————————— D-23：YAML 写读往返（真根因） —————————————————————————

test('M84-01 D-23：空格+井号的值写读往返不许被截断（写入端加引号 + 读取端只在 ` # ` 处认注释）', () => {
  const cases = [
    '缺 kind 的行会被算作正常边（真机 #1132 复现）',
    'journal#248（task/blocked）与 #282 之后的第三轮收口',
    '结尾一个井号 #',
    '制表符后井号\t#TODO',
  ]
  for (const text of cases) {
    store.writeYaml(['reviews', 'REV-900.yml'], { review: { id: 'REV-900', findings: [text], note: text } })
    const back = readYamlFile<{ review: { findings: string[]; note: string } }>('reviews', 'REV-900.yml').review
    assert.deepEqual(back.findings, [text], `列表项必须原样读回：${JSON.stringify(back.findings)}`)
    assert.equal(back.note, text, '映射值同样必须原样读回')
  }
  // **存量/手写文件**（值没有引号）也必须读全 —— 只修写入端只能保住新写入的数据
  const legacy = 'findings:\n  - 真机 #1132 复现（这一段以前会被吃掉）\n'
  const parsed = parseYaml(legacy) as { findings: string[] }
  assert.deepEqual(parsed.findings, ['真机 #1132 复现（这一段以前会被吃掉）'], '手写的裸值不许截断')
  // 反向守卫：约定写法 ` # 注释` 仍然是注释（` # ` 前后都有空白）
  const commented = parseYaml('phase: requirements   # 当前阶段\n') as { phase: string }
  assert.equal(commented.phase, 'requirements', '` # 注释` 仍要按注释剥掉')
  // 自证：真的写过这些字节（不是空断言）
  assert.match(readFileSync(join(BASE, '.sdo', 'reviews', 'REV-900.yml'), 'utf8'), /REV-900/u)
})

test('M84-02 D-23：含"空格+井号"的评审记录后**不许**被判"被改过"（写读哈希同源）', async () => {
  const review = office.addReview(call, {
    taskId: 'TASK-001',
    reviewer: 'reviewer:1',
    verdict: 'changes-requested',
    findings: ['真机 #1132 复现：把变更单改成 approved 之后 claim 照常放行'],
  })
  const adoptions = office.reviewAdoptions(call)
  const mine = adoptions.find((item) => item.review.id === review.id)
  assert.equal(mine?.state, 'unverified', `刚记录的评审只能是"未核实"，不许是 tampered：${JSON.stringify(mine)}`)
  assert.equal(mine?.tamperGuard, 'content-hash', '它是有指纹保护的那种')
  // 回执照旧打印「核实 0/1」（这一条**确实**逐条看过发现，所以计数是诚实的）
  const receipt = await callTool('sdo_review', { action: 'list' })
  assert.match(receipt, /核实 0\/1/u, `未核实的发现要如实显示 0/1：${receipt}`)
})

test('M84-03 D-23：真改动仍然判红，且回执**不许**把没看过的发现报成「核实 N/N」', async () => {
  const review = office.addReview(call, {
    taskId: 'TASK-001',
    reviewer: 'reviewer:1',
    verdict: 'changes-requested',
    findings: ['发现一', '发现二'],
  })
  // 手改 verdict（真篡改：把"要求返工"升级成通过）
  const file = readYamlFile<{ review: Review }>('reviews', `${review.id}.yml`).review
  store.writeYaml(['reviews', `${review.id}.yml`], { review: { ...file, verdict: 'pass' } })
  const mine = office.reviewAdoptions(call).find((item) => item.review.id === review.id)
  assert.equal(mine?.state, 'tampered', '手改 verdict 必须判红')
  assert.equal(mine?.examined, false, 'tampered 在"看发现"之前就返回了，必须如实标注')
  // 另一条：手写的评审文件（没有任何 review/recorded 事件）
  store.writeYaml(['reviews', 'REV-902.yml'], {
    review: { id: 'REV-902', taskId: 'TASK-001', reviewer: 'reviewer:1', verdict: 'pass', findings: ['a', 'b'], at: '2026-01-01T00:00:00.000Z' },
  })
  const receipt = await callTool('sdo_review', { action: 'list' })
  assert.match(receipt, /被改过/u, `要点名被改过：${receipt}`)
  assert.match(receipt, /无真源事件/u, `手写评审要点名无真源事件：${receipt}`)
  assert.doesNotMatch(receipt, /核实 \d+\/\d+/u, `没看过发现就**不许**报「核实 N/N」（假绿）：${receipt}`)
  assert.match(receipt, /逐条核实未进行/u, `要明说没核实过：${receipt}`)
})

// ————————————————————————— D-22：空变更不许有副作用 —————————————————————————

test('M84-04 D-22：批准一条**什么都没改**的 CR ⇒ 版本/状态/阶段/门禁/认领全不受影响', async () => {
  const req = baselinedRequirement()
  const before = requirement(req)
  const seqBefore = journal.read().events.length
  const receipt = await callTool('sdo_requirement', {
    action: 'change',
    id: req,
    reason: '批准先前提交的那条 CR（本次未改任何字段）',
    decision: 'approved',
  })
  assert.match(receipt, /未应用/u, `回执要说清没应用：${receipt}`)
  assert.match(receipt, /未改动任何字段/u, `要点名原因：${receipt}`)
  const after = requirement(req)
  assert.equal(after.status, 'baselined', '空变更不许把需求打成 changed')
  assert.equal(after.version, before.version, '空变更不许涨版本')
  assert.deepEqual(after.acceptance.map((ac) => ac.id), ['AC-001'])
  const added = journal.read().events.slice(seqBefore).map((event) => event.type)
  assert.deepEqual(added, ['change/requested', 'change/decided', 'change/noop'], `只许留档，不许动真源：${added.join(' ')}`)
  assert.ok(!eventTypes().includes('phase/rolled-back'), '空变更不许回退阶段')
  assert.deepEqual(undigestedChanges(store, journal, undefined), [], '空变更不许锁死 claim')
  // 审计仍在：变更单落了盘、决策如实记录
  assert.equal(readYamlFile<{ change: { decision: string } }>('changes', 'CR-001.yml').change.decision, 'approved')
})

test('M84-05 D-22：把**同一个值**再提交一遍也算"没有可变更的内容"', async () => {
  const req = baselinedRequirement()
  const before = requirement(req)
  const receipt = await callTool('sdo_requirement', {
    action: 'change',
    id: req,
    reason: '原样重申一遍陈述（值为同一份）',
    decision: 'approved',
    statement: before.statement,
  })
  assert.match(receipt, /未改动任何字段/u, `同值重提不算变更：${receipt}`)
  assert.equal(requirement(req).version, before.version, '同值重提不许涨版本')
  assert.deepEqual(undigestedChanges(store, journal, undefined), [])
})

test('M84-06 D-22：真改了内容仍然照旧生效（不许因为修空变更而把真变更也拦下）', async () => {
  const req = baselinedRequirement()
  const before = requirement(req)
  const receipt = await callTool('sdo_requirement', {
    action: 'change',
    id: req,
    reason: '并发口径要写进陈述',
    decision: 'approved',
    statement: `${before.statement}；并发写入不许产生重复差异`,
  })
  assert.match(receipt, /变更已应用/u, `真变更要应用：${receipt}`)
  assert.match(receipt, /回退阶段/u, `真变更照旧回退阶段：${receipt}`)
  const after = requirement(req)
  assert.equal(after.status, 'changed')
  assert.equal(after.version, Math.round((before.version + 0.1) * 10) / 10, '真变更照旧涨版本')
  assert.ok(eventTypes().includes('phase/rolled-back'), '真变更照旧回退阶段')
  assert.equal(undigestedChanges(store, journal, undefined).length, 1, '真变更照旧要求重新基线 + 重过设计门')
})

test('M84-07 D-22：`change/noop` 是中性事件 —— 空变更不许作废已签的字', () => {
  const req = baselinedRequirement()
  office.signGate(call, { gate: 'G3', by: '李四', basis: '我确认架构计划可以进入实现（M84 表态）', channel: 'command' })
  assert.equal(office.signatureState(call, 'G3').status, 'valid')
  const result = office.change(call, {
    requirement: req,
    reason: '空变更（只登记决策）',
    changes: ['（仅记录变更请求，未给出具体字段）'],
    decision: 'approved',
    decidedBy: 'human',
  })
  assert.equal(result.applied, false, '空变更不许应用')
  assert.equal(office.signatureState(call, 'G3').status, 'valid', '空变更必须留在中性事件表里（否则纯噪声作废签字）')
  assert.ok(eventTypes().includes('change/noop'), '要留下 change/noop 这条机器可读事实')
})
