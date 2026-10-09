/**
 * **增量 85：把「插件侧建议评估」里判定为"建议做"的条目一次做完**（2026-10-09 用户裁定：
 * 只做建议做的，可选与决策未定的先不做）。
 *
 *   ① **N-1 / P-7（真缺陷）**：`evidenceFreshness` 平铺全部历史结果 ⇒ "同用例已有更新 pass"的旧记录
 *      **永久**被算作过期证据（真机 9 条告警里 7 条属这种，每份交付都带一串无动作可做的告警）。
 *      现在与 `verificationStats` 共用**同一份** latest-wins 实现（`latestResultPerCase`）。
 *   ② **N-2 / P-9（真缺陷）**：无用量来源时报「已消耗 0 tokens」，读起来像"确实零消耗"；
 *      状态块更是在**有**快照时也恒报 0。现在没有数据就说"无用量来源"，且不再把 0 写进台账。
 *   ③ **N-5**：批准的变更回执要写**为什么设计门一并作废**（追溯图里的设计引用数，或如实说"图里没有"）。
 *   ④ **N-7**：`update` 直接改已冻结需求的验收标准（受控字段）要出声，点明规范路径是 `change`。
 *   ⑤ **N-8**：评审回执要点明防篡改比的是**语义哈希**（不是文件字节哈希）。
 *   ⑥ **N-18**：签完立刻现算本门还缺哪些判据（防"签了才发现门禁不过"的一次白签字）。
 *   ⑦ **N-16**：未知豁免码的回执说明**内层码不可用、请用外层码**。
 *   ⑧ **N-10**：`unwaive` 入口 —— `waivedGates` 只增不减，一次误探永久留痕且无出路。
 *   ⑨ **N-11**：已核实**成立**（reproduced）的发现要每轮在状态块里可见（只陈述，不代做范围决定）。
 *   ⑩ **N-20**：文案点名"纯评审卡按实填 `[\".sdo/\"]`"。
 *   ⑪ **B-1（机械普查的产物）**：`runs.yml` 是唯一"列表读取没有 Checked 变体"的地方 ——
 *      形状写坏会静默读空，而 `recordRun` 会以读空结果为基底**整份重写** ⇒ 静默丢历史运行记录。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { describeBudgetLineNoUsage } from '../src/integration/cost.js'
import { evidenceFreshness, hashArtifact, latestResultPerCase, listRuns, readRunsChecked, recordRun, recordTestResult, verificationStats } from '../src/domain/records.js'
import { link } from '../src/domain/trace.js'
import { apply } from '../src/index.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { loadPackagedYaml } from '../src/infra/data.js'
import type { Context } from '@deepseek-ai/cordis'
import type { SdoConfig } from '../src/config.js'
import type { Requirement } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm85')
const WORKSPACE = join(BASE, 'ws')
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
const call = { sessionId: 's1', cwd: WORKSPACE }

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M85', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['对账'],
    scopeOut: ['自动调账'],
    metricsSuccess: ['识别率 ≥ 99%'],
    glossary: { 差异: '不一致记录' },
  })
  store = office.storeFor(WORKSPACE)
  journal = office.journalFor(WORKSPACE)
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
    await tool.execute(filtered, { agent: { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } } }),
  )
}

/** 造一条已基线需求（G2 签字 + 基线判定）。 */
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
    addAcceptance: [{ id: acIdOf(acRound++), given: '已导入两日文件', when: '执行对账', then: '输出差异清单' }],
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
  office.signGate(call, { gate: 'G2', by: '张三', basis: `我确认需求基线可以冻结（M85 第 ${basisRound++} 次表态）`, channel: 'command' })
  const outcome = office.baseline(call, { approvedBy: '张三' })
  assert.equal(outcome.ok, true, `基线应通过：${outcome.dor.failed.join(',')}`)
  return captured.requirement.id
}
let basisRound = 1
let acRound = 1
const acIdOf = (n: number): string => `AC-${String(n).padStart(3, '0')}`

const requirement = (id: string): Requirement => {
  const found = office.requirements(call).find((item) => item.id === id)
  assert.ok(found !== undefined, `找不到需求 ${id}`)
  return found
}

// ————————————————————————— ① N-1 / P-7：过期证据 latest-wins —————————————————————————

test('M85-01 N-1：过期证据只看每条用例的**最新**结果（旧记录不再被永久标过期）', () => {
  const artifact = 'src/probe.mjs'
  mkdirSync(join(WORKSPACE, 'src'), { recursive: true })
  writeFileSync(join(WORKSPACE, artifact), 'probe v2')
  // 同一用例的两条 pass：旧的绑另一个哈希（= 已被更新取代），新的绑当前哈希
  const old = recordTestResult(store, journal, { caseId: 'TC-001', status: 'pass', evidence: 'old', env: 'node=26', artifact, artifactSha256: 'deadbeef' })
  const fresh = recordTestResult(store, journal, { caseId: 'TC-001', status: 'pass', evidence: 'new', env: 'node=26', artifact, artifactSha256: hashArtifact(WORKSPACE, artifact) })
  // 第二条用例：**最新**那条就是过期的（必须照旧判红）
  writeFileSync(join(WORKSPACE, 'src/other.mjs'), 'other v1')
  writeFileSync(join(WORKSPACE, 'src/other.mjs'), 'other v2')
  const staleLatest = recordTestResult(store, journal, { caseId: 'TC-002', status: 'pass', evidence: 'stale', env: 'node=26', artifact: 'src/other.mjs', artifactSha256: 'cafebabe' })
  const result = evidenceFreshness(store, WORKSPACE, undefined)
  assert.deepEqual(
    result.stale.map((item) => item.resultId),
    [staleLatest.id],
    `只该报"最新记录就过期"的那一条：${JSON.stringify(result.stale)}`,
  )
  assert.ok(!result.stale.some((item) => item.resultId === old.id), '被更新取代的旧记录不许再报')
  assert.ok(!result.stale.some((item) => item.resultId === fresh.id), '最新且哈希一致的不许报')
  // 与 verificationStats 同源：两者都按 caseId 取最新（`results` 计数 = 用例数）
  const stats = verificationStats(store, journal)
  assert.equal(stats.results, 2, 'latest-wins 口径下，结果数 = 用例数')
  assert.equal(stats.passed, 2)
  // 口径的边界：`at` 拿不到（老台账）时按 id 数字序兜底
  const picked = latestResultPerCase([
    { id: 'TR-010', caseId: 'TC-009', at: undefined },
    { id: 'TR-002', caseId: 'TC-009', at: undefined },
  ])
  assert.deepEqual(picked.map((item) => item.id), ['TR-010'], 'id 更大的算更新')
})

// ————————————————————————— ② N-2 / P-9：无用量不报 0 —————————————————————————

test('M85-02 N-2：拿不到计量时不许报「已消耗 0 tokens」，也不许把 0 写进台账', async () => {
  const receipt = await callTool('sdo_cost', { action: 'report' })
  assert.doesNotMatch(receipt, /已消耗 0 tokens/u, `无数据不许报 0：${receipt}`)
  assert.match(receipt, /无用量来源/u, `要说清没有数据：${receipt}`)
  assert.match(receipt, /用量不可得/u, '原有的"用量不可得"说明照旧')
  assert.equal(store.readYaml('cost.yml'), undefined, '没有数据就不该写下 cost.yml（别把 0 固化成事实')
  assert.equal(journal.read().events.filter((event) => event.type === 'cost/updated').length, 0, '不许写 cost/updated 假事实')
  // 纯函数层：无用量行 + 预算已设时的措辞
  const line = describeBudgetLineNoUsage({ currency: 'CNY', total: 100, tiers: [], askedTiers: [], decisions: [] })
  assert.match(line, /无用量来源/u)
  assert.match(line, /不给剩余\/百分比/u)
})

test('M85-03 N-2：状态块里显示的是快照里**真实的**消耗数（旧实现恒报 0）', () => {
  store.writeYaml(['cost.yml'], { cost: { at: '2026-10-09T00:00:00.000Z', totalTokens: 1234, currency: 'CNY', unpricedTokens: 0 } })
  store.writeYaml(['budget.yml'], { budget: { currency: 'CNY', total: 100, tiers: [], askedTiers: [], decisions: [] } })
  const status = office.status(call)
  assert.match(String(status.costLine), /1234 tokens/u, `状态块要报快照里的数：${status.costLine}`)
  rmSync(join(WORKSPACE, '.sdo', 'cost.yml'), { force: true })
  const bare = office.status(call)
  assert.match(String(bare.costLine), /无用量来源/u, `没有快照时说没有：${bare.costLine}`)
  assert.doesNotMatch(String(bare.costLine), /已消耗 0 tokens/u)
})

// ————————————————————————— ③ N-5：设计门为什么一并作废 —————————————————————————

test('M85-04 N-5：变更回执要写出"设计门为什么一并作废"的依据（有引用报数、无引用如实说）', async () => {
  const req = baselinedRequirement()
  // 无追溯引用时：如实说"图里没有"
  const noTrace = await callTool('sdo_requirement', {
    action: 'change',
    id: req,
    reason: '并发口径要写进陈述',
    decision: 'approved',
    statement: `${requirement(req).statement}（并发去重）`,
  })
  assert.match(noTrace, /为什么设计门也一并作废/u, `要有这条依据行：${noTrace}`)
  assert.match(noTrace, /没有\*\*这条需求的设计引用|追溯图里目前/u, `无引用要如实说：${noTrace}`)
  // 有引用时：报条数与元素（真建一个设计元素，再挂 req-des 边）
  const req2 = baselinedRequirement()
  const element = office.upsertElement(call, { kind: 'component', name: '差异检测服务' })
  link(store, journal, { from: req2, to: element.element.id, kind: 'req-des' })
  const withTrace = await callTool('sdo_requirement', {
    action: 'change',
    id: req2,
    reason: '并发口径再改一次',
    decision: 'approved',
    statement: `${requirement(req2).statement}（再次并发去重）`,
  })
  assert.match(withTrace, /有 1 项设计引用（DES-/u, `要点名依据：${withTrace}`)
})

// ————————————————————————— ④ N-7：受控字段提示 —————————————————————————

test('M85-05 N-7：`update` 直接改已冻结需求的验收标准要出声（点明规范路径是 change）', async () => {
  const req = baselinedRequirement()
  const receipt = await callTool('sdo_requirement', {
    action: 'update',
    id: req,
    acceptanceMode: 'replace',
    acceptance: JSON.stringify([{ given: 'g', when: 'w', then: 't' }]),
  })
  assert.match(receipt, /受控字段/u, `要点明受控字段：${receipt}`)
  assert.match(receipt, /action=change/u, '要给出规范路径')
  // 对照：草稿需求上补 AC 不该有这条提示（否则成了噪声）
  const draft = office.capture(call, { title: '草稿需求', statement: '草稿陈述', priority: 'should', sourceStakeholder: 'STK-01' })
  const draftReceipt = await callTool('sdo_requirement', {
    action: 'update',
    id: draft.requirement.id,
    acceptance: JSON.stringify([{ given: 'g', when: 'w', then: 't' }]),
  })
  assert.doesNotMatch(draftReceipt, /受控字段/u, `草稿不算受控：${draftReceipt}`)
})

// ————————————————————————— ⑤ N-8：防篡改口径 —————————————————————————

test('M85-06 N-8：评审回执要点名防篡改比的是语义哈希（不是文件字节）', async () => {
  office.addReview(call, { taskId: 'TASK-001', reviewer: 'reviewer:1', verdict: 'pass', findings: ['无发现'] })
  const list = await callTool('sdo_review', { action: 'list' })
  assert.match(list, /防篡改口径/u, `列表回执要给口径：${list}`)
  assert.match(list, /语义哈希/u)
  assert.match(list, /字节级/u, '要说明字节级不在范围内')
  const rehash = await callTool('sdo_review', { action: 'rehash', id: 'REV-001' })
  assert.match(rehash, /语义哈希/u, `rehash 回执也要给口径：${rehash}`)
})

// ————————————————————————— ⑥ N-18：签完现算还缺什么 —————————————————————————

test('M85-07 N-18：签字回执立刻列出本门还缺的判据（不必再签、也别以为签了就过）', async () => {
  // 设计没做就签 G3 ⇒ 判据必然不全
  const receipt = await callTool('sdo_gate', {
    action: 'sign',
    gate: 'G3',
    quote: '我确认架构计划可以进入实现（M85 白签样本）',
    approvedBy: '李四',
  })
  assert.match(receipt, /签字已记录/u, `回执要说明签字已记：${receipt}`)
  assert.match(receipt, /还缺 \d+ 条判据/u, `要点出还缺多少：${receipt}`)
  assert.match(receipt, /不必再签一次/u, '要说清补齐后不必重签')
  assert.match(receipt, /sdo_gate action=check/u, '要给出下一步命令')
})

// ————————————————————————— ⑦ N-16：内层豁免码不可用 —————————————————————————

test('M85-08 N-16：用内层码做豁免要被拒，且回执说明"请用外层码"', async () => {
  const receipt = await callTool('sdo_plan', {
    action: 'profile',
    packages: JSON.stringify(['tdd']),
    derivedFrom: JSON.stringify(['reqKind=functional(REQ-001)']),
    reason: 'M85 内层码样本',
    exempt: JSON.stringify([{ task: 'TASK-001', check: 'tdd-env-changed', why: '只豁免产物不变这条' }]),
  })
  assert.match(receipt, /未知的检查码/u, `要拒绝：${receipt}`)
  assert.match(receipt, /tdd-red-green-missing/u, `要点名可用的外层码：${receipt}`)
  assert.match(receipt, /不可用作豁免键/u)
})

// ————————————————————————— ⑧ N-10：unwaive 入口 —————————————————————————

test('M85-09 N-10：`unwaive` 能撤销豁免（含历史残留），没豁免过的门禁则拒绝', async () => {
  const process = office.process(call)
  const real = process.gates[0]!.id
  const waived = await callTool('sdo_gate', { action: 'waive', gate: real, reason: 'M85 先豁免', approver: '张三' })
  assert.match(waived, /已豁免/u, `前置：豁免要成功：${waived}`)
  assert.ok(office.status(call).project?.tailoring?.waivedGates.includes(real))
  const removed = await callTool('sdo_gate', { action: 'unwaive', gate: real, reason: 'M85 误探，撤销' })
  assert.match(removed, /已撤销/u, `撤销要成功：${removed}`)
  assert.match(removed, /现有豁免：（无）/u, `要报出现有豁免：${removed}`)
  assert.match(removed, /tailoring\/updated|裁剪变更/u, '要如实说这是裁剪变更（签字口径随之失效）')
  assert.ok(!(office.status(call).project?.tailoring?.waivedGates ?? []).includes(real), '真源里必须真的移除')
  // 没豁免过的门禁：拒绝并列出真正豁免了的门禁
  const notWaived = await callTool('sdo_gate', { action: 'unwaive', gate: real, reason: '再来一次' })
  assert.match(notWaived, /not-waived/u, `没豁免过要拒绝：${notWaived}`)
  // 历史残留（当前流程不存在的门禁）：能清掉，且说明现行判据不受影响
  // 历史残留（修前那版留下的）：投影里带着一个**当前流程不存在**的门禁豁免
  const project = office.status(call).project
  assert.ok(project !== undefined)
  store.writeJson(['project.json'], {
    ...project,
    tailoring: { scale: 'normal', waivedGates: [real, '原型验收门禁（GP）'], reason: 'x', approver: 'human', at: '' },
  })
  assert.ok((office.status(call).project?.tailoring?.waivedGates ?? []).includes('原型验收门禁（GP）'), '前置：残留要能被读到')
  const residue = await callTool('sdo_gate', { action: 'unwaive', gate: '原型验收门禁（GP）', reason: '清理修前残留' })
  assert.match(residue, /已撤销/u, `残留也要能清：${residue}`)
  assert.match(residue, /不属于当前流程/u, '要说明现行判据不受影响')
  assert.match(residue, /现行判据不受影响/u)
  // 缺 reason ⇒ 拒绝（裁剪变更要看得出为什么撤）
  assert.match(await callTool('sdo_gate', { action: 'unwaive', gate: real }), /必须给出 `reason`/u)
})

// ————————————————————————— ⑨ N-11：已核实成立的发现要可见 —————————————————————————

test('M85-10 N-11：状态块披露"已核实成立"的评审发现（核实不是终点）', () => {
  const before = office.status(call)
  assert.equal(before.reproducedFindings?.count ?? 0, 0, '没有核实记录时不该有这条')
  const review = office.addReview(call, { taskId: 'TASK-001', reviewer: 'reviewer:1', verdict: 'changes-requested', findings: ['发现一'] })
  // 核实（照实现方身份；这里直接落域层留痕）
  office.verifyReviewFinding(call, { reviewId: review.id, index: 0, outcome: 'reproduced', evidence: '照着发现能复现', by: 'subagent:developer' })
  const after = office.status(call)
  assert.equal(after.reproducedFindings?.count, 1, `要数出 1 条已核实成立：${JSON.stringify(after.reproducedFindings)}`)
  assert.deepEqual(after.reproducedFindings?.items, [`${review.id}#1`], '要能看出是哪条评审的第几条发现')
})

// ————————————————————————— ⑩ N-20：写范围文案 —————————————————————————

test('M85-11 N-20：`write-scope-empty` 的补救文案点名纯评审卡按实填 [".sdo/"]', () => {
  const zh = loadPackagedYaml('src/data/lang/zh-CN.yml') as Record<string, Record<string, string>>
  const en = loadPackagedYaml('src/data/lang/en.yml') as Record<string, Record<string, string>>
  for (const [name, pack] of [['zh', zh], ['en', en]] as const) {
    const text = String(pack['uiPlan']?.['kWriteScopeEmptyRemedy'])
    assert.match(text, /\.sdo\//u, `${name} 要点名 .sdo/：${text}`)
  }
})

// ————————————————————————— ⑪ B-1：runs.yml 的形状不许静默丢失 —————————————————————————

test('M85-12 B-1：`runs.yml` 形状写坏时 —— 读得出来"坏"、且写入端拒绝整份覆盖', () => {
  mkdirSync(join(WORKSPACE, '.sdo', 'delivery'), { recursive: true })
  writeFileSync(join(WORKSPACE, '.sdo', 'delivery', 'runs.yml'), 'runs:\n  id: RUN-999\n  target: server\n')
  // ① 读：形状提示交得出来（不再静默读空）
  const checked = readRunsChecked(store)
  assert.deepEqual(checked.runs, [], '映射写在列表位置 ⇒ 读不出记录（口径：不猜）')
  assert.equal(checked.notes.length, 1, `必须交回形状提示：${JSON.stringify(checked.notes)}`)
  assert.equal(checked.notes[0]?.field, 'runs')
  // ② 写：拒绝覆盖（否则历史运行记录被整份抹掉）
  const before = readFileSync(join(WORKSPACE, '.sdo', 'delivery', 'runs.yml'), 'utf8')
  const refused = recordRun(store, journal, {
    target: 'server', command: 'node server.mjs', outcome: 'pass', evidence: '日志', by: 'human', workspace: WORKSPACE,
  })
  assert.equal(refused.ok, false, '形状坏时必须拒绝写入')
  assert.match(refused.ok ? '' : refused.detail, /没有写入/u, `要说清没写：${JSON.stringify(refused)}`)
  assert.equal(readFileSync(join(WORKSPACE, '.sdo', 'delivery', 'runs.yml'), 'utf8'), before, '文件必须一字未动')
  // ③ 修好之后照常能写，且历史记录不丢
  writeFileSync(join(WORKSPACE, '.sdo', 'delivery', 'runs.yml'), 'runs:\n  - id: RUN-001\n    target: server\n    command: node server.mjs\n    outcome: pass\n    evidence: 旧日志\n    by: human\n')
  const ok = recordRun(store, journal, {
    target: 'server', command: 'node server.mjs', outcome: 'pass', evidence: '日志', by: 'human', workspace: WORKSPACE,
  })
  assert.equal(ok.ok, true, `修好后要能写：${JSON.stringify(ok)}`)
  assert.deepEqual(listRuns(store).map((run) => run.id), ['RUN-001', 'RUN-002'], '历史记录必须保留')
})
