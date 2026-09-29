import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { claim, reassign, release, report, staleClaims } from '../src/domain/collab.js'
import { planStats, readIteration, readyTasks, validatePlan } from '../src/domain/plan.js'
import { auditWriteScopes, buildDispatch, capacityPlan, independenceViolations, pickBackend } from '../src/integration/orchestrator.js'
import { link } from '../src/domain/trace.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m4/', import.meta.url))
const call = (): { sessionId: string } => ({ sessionId: 's1' })
const EVIDENCE = [{ kind: 'artifact' as const, detail: 'src/x/index.ts sha256:abc', at: '2026-09-29T00:00:00Z' }]

let workspace: string
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), { name: 'M4 测试', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call(), { scopeIn: ['对账'], scopeOut: ['自动调账'], metricsSuccess: ['识别率 ≥ 99%'], glossary: { 差异: '不一致记录' } })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 造"需求→设计元素"的追溯边，让结构通道有东西可拆。 */
function seedDesign(): void {
  const captured = office.capture(call(), {
    title: '差异检测',
    statement: '系统须在每日对账后识别差异；单日 100 万，P99 < 500 毫秒',
    priority: 'must',
    sourceStakeholder: 'STK-01',
  })
  office.upsertElement(call(), { kind: 'component', name: '差异检测服务' })
  office.upsertElement(call(), { kind: 'data', name: '对账差异表' })
  const store = office.storeFor(workspace)
  const journal = office.journalFor(workspace)
  link(store, journal, { from: captured.requirement.id, to: 'DES-001', kind: 'req-des' })
  link(store, journal, { from: captured.requirement.id, to: 'DES-002', kind: 'req-des' })
}

test('结构通道拆分：按"需求→设计元素"出卡，并过六条机械校验', () => {
  seedDesign()
  const result = office.planDecompose(call())
  assert.equal(result.tasks.length, 2, '两个设计元素 → 两张卡')
  assert.deepEqual(result.issues, [], `不应有校验问题：${JSON.stringify(result.issues)}`)

  const first = result.tasks[0] as TaskCard
  assert.equal(first.role, 'developer')
  assert.deepEqual(first.requirements, ['REQ-001'])
  assert.ok(first.writeScopes.includes('src/des-001/'), `写范围应可并行安全：${first.writeScopes.join(',')}`)
  assert.equal(first.status, 'planned')
  assert.equal(first.revision, 1)
  assert.equal(office.planIssues(call()).length, 0)
})

test('六条机械校验：单角色 / DoD / 无环 / 规模 / 写范围互斥 / 证据要求', () => {
  seedDesign()
  office.planDecompose(call())

  const tasks = office.tasks(call())
  // 造出四类问题：错误角色、空 DoD、large 未拆、无证据要求
  const bad: TaskCard[] = [
    { ...(tasks[0] as TaskCard), id: 'TASK-900', role: 'wizard', dod: [], size: 'large', evidenceRequired: [] },
    // 写范围重叠且互相没有依赖 → 可能并行 → 必须报
    { ...(tasks[0] as TaskCard), id: 'TASK-901', writeScopes: ['src/des-001/'] },
    { ...(tasks[1] as TaskCard), id: 'TASK-902', writeScopes: ['src/des-001/sub/'] },
  ]
  const issues = validatePlan([...tasks, ...bad]).map((issue) => issue.code)
  for (const code of ['single-role', 'dod-nonempty', 'size-cap', 'evidence-required', 'write-scope-disjoint']) {
    assert.ok(issues.includes(code as (typeof issues)[number]), `应报出 ${code}：${issues.join(',')}`)
  }

  // 依赖成环
  const a = { ...(tasks[0] as TaskCard), id: 'TASK-910', blockedBy: ['TASK-911'], writeScopes: ['src/a/'] }
  const b = { ...(tasks[1] as TaskCard), id: 'TASK-911', blockedBy: ['TASK-910'], writeScopes: ['src/b/'] }
  assert.ok(validatePlan([a, b]).some((issue) => issue.code === 'acyclic'), '依赖环必须被报出来')

  // 同一张卡串成依赖后写范围重叠就不算冲突（顺序执行是安全的）
  const c = { ...(tasks[0] as TaskCard), id: 'TASK-920', blockedBy: ['TASK-921'], writeScopes: ['src/x/'] }
  const d = { ...(tasks[1] as TaskCard), id: 'TASK-921', writeScopes: ['src/x/'] }
  assert.equal(validatePlan([c, d]).some((issue) => issue.code === 'write-scope-disjoint'), false)
})

test('协同协议：CAS 认领、只有 owner 能回报、done 必须带证据、失联不自动释放', () => {
  seedDesign()
  office.planDecompose(call())
  const store = office.storeFor(workspace)
  const journal = office.journalFor(workspace)

  // ① CAS：版本对不上即冲突
  const stale = claim(store, journal, { taskId: 'TASK-001', owner: 'dev-a', expectedRevision: 99 })
  assert.equal(stale.ok, false)
  assert.equal(stale.ok === false ? stale.code : '', 'revision-mismatch')

  // ② 正常认领
  const claimed = claim(store, journal, { taskId: 'TASK-001', owner: 'dev-a', expectedRevision: 1 })
  assert.equal(claimed.ok, true)
  assert.equal(claimed.ok === true ? claimed.task.status : '', 'in-progress')
  assert.equal(claimed.ok === true ? claimed.task.revision : 0, 2)

  // ③ 已被占用 → 不可重复认领
  const second = claim(store, journal, { taskId: 'TASK-001', owner: 'dev-b', expectedRevision: 2 })
  assert.equal(second.ok, false)
  assert.equal(second.ok === false ? second.code : '', 'not-claimable')

  // ④ 只有 owner 能回报
  const wrong = report(store, journal, { taskId: 'TASK-001', owner: 'dev-b', status: 'done', evidence: EVIDENCE })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.ok === false ? wrong.code : '', 'not-owner')

  // ⑤ done 必须带证据
  const noEvidence = report(store, journal, { taskId: 'TASK-001', owner: 'dev-a', status: 'done' })
  assert.equal(noEvidence.ok, false)
  assert.equal(noEvidence.ok === false ? noEvidence.code : '', 'no-evidence')

  // ⑥ 带证据完成 → 自动挂上 req-task 追溯边
  const done = office.reportTask(call(), { taskId: 'TASK-001', owner: 'dev-a', status: 'done', evidence: EVIDENCE })
  assert.equal(done.ok, true)
  const trace = office.traceReport(call())
  assert.ok(trace.perRequirement.some((item) => item.tasks.includes('TASK-001')), '完成的任务卡应自动挂到需求上')

  // ⑦ 认领第二张卡：此时它才处于 in-progress，可以被判为"疑似失联"
  claim(store, journal, { taskId: 'TASK-002', owner: 'dev-c', expectedRevision: 1 })
  const staleTasks = staleClaims(office.tasks(call()), -1) // ttl<0：把刚刚更新过的也算进来，验证判定本身有效
  assert.deepEqual(staleTasks.map((task) => task.id), ['TASK-002'])
  assert.equal(office.tasks(call()).find((task) => task.id === 'TASK-002')?.owner, 'dev-c', '失联不自动清 owner')

  // ⑧ 阻塞 → 记录原因（blocked 不再算 in-progress，因此也不再算失联）
  const blocked = report(store, journal, { taskId: 'TASK-002', owner: 'dev-c', status: 'blocked', note: '等上游文件样例' })
  assert.equal(blocked.ok === true ? blocked.task.status : '', 'blocked')
  assert.equal(blocked.ok === true ? blocked.task.blockedReason : '', '等上游文件样例')
  assert.equal(staleClaims(office.tasks(call()), -1).length, 0)

  // ⑨ 显式释放 / 改派
  const released = release(store, journal, { taskId: 'TASK-002', actor: 'cockpit', reason: '负责人失联' })
  assert.equal(released?.status, 'ready')
  assert.equal(released?.owner, undefined)
  claim(store, journal, { taskId: 'TASK-002', owner: 'dev-d', expectedRevision: released?.revision ?? 0 })
  const reassigned = reassign(store, journal, { taskId: 'TASK-002', actor: 'cockpit', owner: 'dev-e', reason: '换人' })
  assert.equal(reassigned?.owner, 'dev-e')
  const events = office.journalFor(workspace).read().events.filter((event) => event.type === 'task/released')
  assert.equal(events.length, 2, '释放与改派都要留痕')
})

test('派发：后端选择、降级说明、二选一约束与容量预算', () => {
  // 首选不可用 → 降级 inline 并说明
  const degraded = pickBackend('subagent', { subagent: false, nativeTeam: false, inline: true })
  assert.equal(degraded.backend, 'inline')
  assert.match(degraded.degradedReason ?? '', /不可用/u)

  // auto：有 subagent 就用它
  assert.equal(pickBackend('auto', { subagent: true, nativeTeam: true, inline: true }).backend, 'subagent')
  // auto：都没有 → inline 且说明原因
  const none = pickBackend('auto', { subagent: false, nativeTeam: false, inline: true })
  assert.equal(none.backend, 'inline')
  assert.match(none.degradedReason ?? '', /降级/u)

  // 二选一约束：同迭代内不换后端
  const keep = pickBackend('native-team', { subagent: true, nativeTeam: true, inline: true }, { backend: 'subagent', iteration: 1 }, 1)
  assert.equal(keep.backend, 'subagent')
  assert.match(keep.degradedReason ?? '', /二选一/u)
  // 换迭代则可以切换
  assert.equal(pickBackend('native-team', { subagent: true, nativeTeam: true, inline: true }, { backend: 'subagent', iteration: 1 }, 2).backend, 'native-team')

  // 容量预算
  const tasks = ['a', 'b', 'c', 'd', 'e'].map((_id, index) => ({ id: `TASK-00${index + 1}`, status: 'planned', blockedBy: [] }) as unknown as TaskCard)
  const plan = capacityPlan(tasks, 3, 4)
  assert.deepEqual(plan.dispatch.map((task) => task.id), ['TASK-001'])
  assert.equal(plan.queued.length, 4)
  assert.equal(capacityPlan(tasks, 4, 4).dispatch.length, 0)
})

test('派发请求与越界写复核', () => {
  seedDesign()
  office.planDecompose(call())
  const task = office.tasks(call())[0] as TaskCard
  const request = buildDispatch({ task, backend: 'inline', owner: 'cockpit', projectName: 'M4 测试' })
  assert.match(request.prompt, /expectedRevision=/u, '提示词必须带 CAS 版本号')
  assert.match(request.prompt, /证据要求/u)
  assert.equal(request.persona, 'sdo-developer')
  assert.ok(request.toolFilter.includes('edit'))

  assert.deepEqual(auditWriteScopes(['src/des-001/index.ts'], ['src/des-001/']).violations, [])
  const violations = auditWriteScopes(['src/des-001/index.ts', 'src/other/x.ts'], ['src/des-001/'])
  assert.deepEqual(violations.violations, ['src/other/x.ts'])
  assert.equal(auditWriteScopes(['anything'], []).ok, true, '未限定写范围时不判违规（但要靠拆分器补上）')
})

test('容量与就绪：依赖未满足的卡不能派发', () => {
  seedDesign()
  office.planDecompose(call())
  const store = office.storeFor(workspace)
  const journal = office.journalFor(workspace)
  const [a, b] = office.tasks(call()) as [TaskCard, TaskCard]
  // 让第二张卡依赖第一张
  office.taskById(call(), b.id)
  writeDependency(store, b.id, a.id)
  const ready = readyTasks(office.tasks(call()), 10)
  assert.deepEqual(ready.map((task) => task.id), [a.id], '被依赖的卡未完成时，下游卡不可派发')
  journal.append('task/updated', { id: b.id, note: '依赖关系由模型补充' })
  // 完成后即可派发
  claim(store, journal, { taskId: a.id, owner: 'dev-a', expectedRevision: office.taskById(call(), a.id)?.revision ?? 1 })
  report(store, journal, { taskId: a.id, owner: 'dev-a', status: 'done', evidence: EVIDENCE })
  assert.ok(readyTasks(office.tasks(call()), 10).some((task) => task.id === b.id))
})

/** 直接改盘上的依赖（模拟"模型补充了依赖关系"）。 */
function writeDependency(store: ReturnType<SoftwareDevOffice['storeFor']>, taskId: string, dependency: string): void {
  const path = join(store.root, 'tasks', `${taskId}.yml`)
  const text = readFileSync(path, 'utf8')
  writeFileSync(path, text.replace(/blockedBy: \[\]/u, `blockedBy: [${dependency}]`))
}

test('验证与评审：用例覆盖 must、失败即拦、阻塞缺陷拦门禁、评审必须独立', () => {
  seedDesign()
  const requirement = office.requirements(call())[0]
  assert.ok(requirement !== undefined)
  const testCase = office.addTestCase(call(), {
    title: '差异检测在 100 万条下的时延',
    kind: 'integration',
    requirement: requirement.id,
    steps: ['导入两日文件', '执行对账'],
    expected: 'P99 < 500 毫秒且输出差异清单',
  })
  assert.equal(office.evaluate(call(), 'G4').criteria.find((criterion) => criterion.id === 'C-32')?.ok, true, 'must 需求有用例后 C-32 应通过')

  office.addTestResult(call(), { caseId: testCase.id, status: 'fail', evidence: 'p99=812ms' })
  // C-50（must REQ 测试通过）属于 G6 验证门禁
  assert.equal(office.evaluate(call(), 'G6').criteria.find((criterion) => criterion.id === 'C-50')?.ok, false,
    `失败用例必须拦住验证门禁：${JSON.stringify(office.evaluate(call(), 'G6').criteria)}`)
  office.addDefect(call(), { title: '时延超标', severity: 'blocker', caseId: testCase.id, status: 'open' })
  assert.equal(office.evaluate(call(), 'G6').criteria.find((criterion) => criterion.id === 'C-51')?.ok, false)
  office.setDefectStatus(call(), 'DEF-001', 'closed')
  assert.equal(office.evaluate(call(), 'G6').criteria.find((criterion) => criterion.id === 'C-51')?.ok, true)

  // 评审独立性
  office.planDecompose(call())
  const task = office.tasks(call())[0] as TaskCard
  office.claimTask(call(), { taskId: task.id, owner: 'dev-a', expectedRevision: task.revision })
  office.reportTask(call(), { taskId: task.id, owner: 'dev-a', status: 'done', evidence: EVIDENCE })
  office.addReview(call(), { taskId: task.id, reviewer: 'dev-a', verdict: 'pass', findings: [] })
  const violations = independenceViolations(office.reviews(call()), office.tasks(call()))
  assert.equal(violations.length, 1, '作者自评必须被识别')
  assert.equal(office.evaluate(call(), 'G6').criteria.find((criterion) => criterion.id === 'C-52')?.ok, false)
  // 换人评审后通过
  office.addReview(call(), { taskId: task.id, reviewer: 'reviewer-b', verdict: 'pass', findings: ['无阻塞问题'] })
  const reviews = office.reviews(call()).filter((review) => review.reviewer !== 'dev-a')
  assert.equal(independenceViolations(reviews, office.tasks(call())).length, 0)
})

test('迭代：开/关迭代，增量与 DoD 由任务卡与证据决定（GI 门禁属于敏捷流程）', () => {
  office.updateProject(call(), { process: 'agile' }) // GI（迭代 DoD）只在敏捷流程里定义
  assert.equal(office.iteration(call()), undefined)
  office.startIteration(call(), '完成差异检测的最小闭环')
  const iteration = readIteration(office.storeFor(workspace))
  assert.equal(iteration?.number, 1)
  assert.equal(iteration?.status, 'active')

  seedDesign()
  office.planDecompose(call())
  const before = office.evaluate(call(), 'GI')
  assert.equal(before.criteria.find((criterion) => criterion.id === 'C-80')?.ok, false, '迭代内还有卡没完成 → 还不算产出增量')
  assert.equal(before.criteria.find((criterion) => criterion.id === 'C-81')?.ok, false, '卡没完成 → DoD 不过')
  assert.match(before.criteria.find((criterion) => criterion.id === 'C-80')?.detail ?? '', /未完成/u)

  for (const task of office.tasks(call())) {
    office.claimTask(call(), { taskId: task.id, owner: `dev-${task.id}`, expectedRevision: task.revision })
    office.reportTask(call(), { taskId: task.id, owner: `dev-${task.id}`, status: 'done', evidence: EVIDENCE })
  }
  const testCase = office.addTestCase(call(), { title: '冒烟', kind: 'e2e', steps: ['跑起来'], expected: '不报错' })
  office.addTestResult(call(), { caseId: testCase.id, status: 'pass', evidence: 'exit=0' })
  // GI 还要求"完成的卡都有通过评审且评审者 != 作者"
  for (const task of office.tasks(call())) {
    office.addReview(call(), { taskId: task.id, reviewer: 'reviewer-b', verdict: 'pass', findings: ['无阻塞问题'] })
  }
  const gi = office.evaluate(call(), 'GI')
  assert.equal(gi.status, 'passed', `迭代门应通过：${gi.criteria.filter((c) => !c.ok).map((c) => `${c.id}:${c.detail}`).join(' | ')}`)
  assert.equal(office.closeIteration(call())?.status, 'closed')
})

test('交付包：sha256 清单 + 验收矩阵 + 回滚点 + 原型排除（G7 的 C-60/C-61）', () => {
  seedDesign()
  writeFileSync(join(workspace, 'deliverable.txt'), 'hello\n')
  const requirement = office.requirements(call())[0]
  assert.ok(requirement !== undefined)

  // 清单不全（缺回滚点）→ C-60 不过
  const incomplete = office.evaluate(call(), 'G7').criteria.find((criterion) => criterion.id === 'C-60')
  assert.equal(incomplete?.ok, false)

  const result = office.packageDelivery(call(), {
    by: '验收人',
    artifacts: [{ path: 'deliverable.txt', kind: 'docs' }],
    acceptance: [{ requirement: requirement.id, criterion: 'AC-001', evidence: '手工验证通过', verdict: 'pass' }],
    rollbackPoint: 'git commit a4d97e8',
  })
  assert.deepEqual(result.missingArtifacts, [])
  assert.equal(result.manifest.artifacts[0]?.sha256.length, 64, 'sha256 应为 64 位十六进制')
  assert.equal(result.manifest.prototypeExcluded, true)

  const g7 = office.evaluate(call(), 'G7')
  assert.equal(g7.criteria.find((criterion) => criterion.id === 'C-60')?.ok, true, `C-60 应通过：${g7.criteria.find((c) => c.id === 'C-60')?.detail}`)
  assert.equal(g7.criteria.find((criterion) => criterion.id === 'C-61')?.ok, true)

  // 渲染交付与测试计划文档
  const docs = office.renderVerificationDocs(call())
  assert.deepEqual(docs, ['docs/TESTPLAN.md', 'docs/DELIVERY.md'])
  assert.match(readFileSync(join(workspace, 'docs', 'DELIVERY.md'), 'utf8'), /验收矩阵/u)

  // 缺产物 → 打回
  const missing = office.packageDelivery(call(), {
    by: '验收人',
    artifacts: [{ path: 'nope.txt', kind: 'docs' }],
    acceptance: [],
    rollbackPoint: 'x',
  })
  assert.deepEqual(missing.missingArtifacts, ['nope.txt'])
  assert.equal(office.evaluate(call(), 'G7').criteria.find((criterion) => criterion.id === 'C-60')?.ok, false)
})

test('看板数据：任务统计、可派发与疑似失联', () => {
  seedDesign()
  office.planDecompose(call())
  const stats = planStats(office.tasks(call()))
  assert.equal(stats.total, 2)
  assert.equal(stats.allDone, false)
  assert.equal(stats.byStatus['planned'], 2)
  writeFileSync(join(workspace, 'x.txt'), 'x')
  assert.equal(office.staleTasks(call(), 60 * 60_000).length, 0)
  // 时间倒推：把 updatedAt 改到很久以前
  const task = office.tasks(call())[0] as TaskCard
  office.claimTask(call(), { taskId: task.id, owner: 'dev-a', expectedRevision: task.revision })
  const path = join(workspace, '.sdo', 'tasks', `${task.id}.yml`)
  writeFileSync(path, readFileSync(path, 'utf8').replace(/updatedAt: .*/u, 'updatedAt: 2020-01-01T00:00:00.000Z'))
  assert.deepEqual(office.staleTasks(call(), 60_000).map((item) => item.id), [task.id])
})
