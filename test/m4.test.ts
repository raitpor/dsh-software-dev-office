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

test('红线回归：redTeamAttack 的 limit 是**总问题数上限**（AsterChat 实测曾一次生成 60 问）', () => {
  seedDesign()
  const ids: string[] = []
  for (let i = 0; i < 10; i++) {
    const captured = office.capture(call(), {
      title: `需求 ${i + 1}`,
      statement: `系统须在第 ${i + 1} 项场景下识别差异；单日 100 万，P99 < 500 毫秒`,
      priority: 'must',
      sourceStakeholder: 'STK-01',
    })
    ids.push(captured.requirement.id)
  }
  const attack = office.redTeamAttack(call(), ids, 6)
  assert.equal(attack.questions.length, 6, `limit=6 应只产生 6 个问题，实际 ${attack.questions.length}`)
  // 轮转分配：被攻击的前几条需求都应拿到至少 1 个问题（议题才可能闭环）
  const targets = new Set(attack.questions.flatMap((question) => question.targets))
  assert.ok(targets.size >= 3, `轮转应覆盖多个目标，实际 ${[...targets].join(' ')}`)
  // 不能把问题账本灌爆
  assert.ok(office.questions(call()).length <= 10, '问题总数不应失控')
})

test('D3-1/D3-3/D4-3（依据 sdo-test 诊断修复）：批内去重、卡可回收、契约可更新', () => {
  seedDesign()
  office.planDecompose(call())
  const before = office.tasks(call()).length

  // D3-1：同一次调用里两条完全相同的建议 → 只建一张卡（旧实现只比对调用前的卡集）
  office.planDecompose(call(), {
    suggestions: [
      { title: '重复建议', dod: ['x'], role: 'developer', writeScopes: ['src/dup/'], size: 'small' },
      { title: '重复建议', dod: ['x'], role: 'developer', writeScopes: ['src/dup/'], size: 'small' },
    ],
  })
  assert.equal(office.tasks(call()).length, before + 1, '批内重复必须只建一张卡')

  // D3-3：回收路径 —— 卡可置为 dropped，且不再算作计划问题
  const first = office.tasks(call())[0] as TaskCard
  const dropped = office.dropTask(call(), first.id, '误拆，作废')
  assert.equal(dropped?.status, 'dropped')
  assert.equal((office.tasks(call()).find((task) => task.id === first.id))?.status, 'dropped', '留痕：卡仍在，但状态 dropped')
  assert.ok(
    !office.planIssues(call()).some((issue) => issue.taskId === first.id),
    'dropped 的卡不得再参与校验',
  )

  // D4-3：契约可原地更新（旧实现传 id 会另建新记录）
  const base = { producer: 'DES-001', consumer: 'DES-002', schema: 's', failureSemantics: { timeout: '3s', retry: '2', idempotency: 'yes' } }
  const created = office.recordContract(call(), { ...base, name: 'A → B' })
  const updated = office.recordContract(call(), { ...base, id: created.id, name: 'A → B（修订）' })
  assert.equal(updated.id, created.id, '给了 id 必须原地更新，而不是新建')
  assert.ok(office.contracts(call()).filter((item) => item.id === created.id).length === 1)
  assert.equal(office.contracts(call()).find((item) => item.id === created.id)?.name, 'A → B（修订）')
})

test('D5-1/D5-2（依据 sdo-test 复测修复）：dropped 卡不参与成对写范围校验；写范围不残留右括号', async () => {
  seedDesign()
  // 两张**写范围完全相同**的建议卡 → 正常应报冲突；把其中一张 drop 掉后不应再报
  office.planDecompose(call(), {
    suggestions: [
      { title: '冲突甲', dod: ['x'], role: 'developer', writeScopes: ['src/same/'], size: 'small' },
      { title: '冲突乙', dod: ['x'], role: 'developer', writeScopes: ['src/same/'], size: 'small' },
    ],
  })
  const conflict = office.planIssues(call()).filter((issue) => issue.code === 'write-scope-disjoint')
  assert.ok(conflict.length > 0, '两张同写范围的卡应被判为冲突（用例有判别力）')
  const victim = office.tasks(call()).find((task) => task.title === '冲突乙') as TaskCard
  office.dropTask(call(), victim.id, '作废后不应再参与成对校验')
  const after = office.planIssues(call()).filter((issue) => issue.code === 'write-scope-disjoint')
  assert.deepEqual(after, [], `dropped 的卡不得再造成写范围冲突：${JSON.stringify(after)}`)

  // D5-2：括号清洗不得残留右括号
  const { parseWriteScopes } = await import('../src/domain/plan.js')
  assert.deepEqual(parseWriteScopes('写范围：`**/query/OrderQuery*`（独占）'), ['**/query/OrderQuery*'])
  assert.deepEqual(parseWriteScopes('写范围：**/api/**）、src/main/resources/static/**）'), ['**/api/**', 'src/main/resources/static/**'])
})

test('D7（依据 sdo-test 门禁判据诊断修复）：dropped 卡不得计入完成率分母', async () => {
  const { planStats } = await import('../src/domain/plan.js')
  // 夹具只关心状态语义，类型用断言收敛（避免为了跑通类型而堆无关字段）
  const base = {
    id: 'TASK-001', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'],
    role: 'developer', size: 'small', dependencies: [], blockedBy: [],
    writeScopes: [], requirements: [], evidenceRequired: ['artifact'], evidence: [],
    iteration: 1, revision: 1, owner: 'a', createdAt: '', updatedAt: '',
  } as unknown as TaskCard
  const done = { ...base, status: 'done', evidence: [{ kind: 'artifact', detail: 'x' }] } as unknown as TaskCard
  const dropped = { ...base, id: 'TASK-002', status: 'dropped' } as unknown as TaskCard
  const stats = planStats([done, dropped])
  assert.equal(stats.total, 2, 'total 仍是全部卡（台账口径）')
  assert.equal(stats.active, 1, 'active 是未放弃的卡')
  assert.equal(stats.allDone, true, 'dropped 不得让 allDone 恒为 false（旧实现是死结）')

  // 判别力：没有 dropped 但仍有未完成的卡时，allDone 必须为 false
  const planned = { ...base, id: 'TASK-003', status: 'planned' } as unknown as TaskCard
  assert.equal(planStats([done, planned]).allDone, false, '未完成的卡仍应让 allDone 为 false')
  assert.equal(planStats([dropped]).allDone, false, '只剩放弃卡时不得算"全部完成"')
})

test('D6-1（依据 sdo-test 构造阶段实测修复）：写范围租约——完成的卡必须释放范围', async () => {
  const { validatePlan } = await import('../src/domain/plan.js')
  const base = {
    id: 'TASK-100', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'],
    role: 'developer', size: 'small', dependencies: [], blockedBy: [],
    writeScopes: ['pom.xml'], requirements: [], evidenceRequired: ['artifact'], evidence: [],
    iteration: 1, revision: 1, createdAt: '', updatedAt: '',
  } as unknown as TaskCard
  const conflicts = (tasks: TaskCard[]) => validatePlan(tasks).filter((issue) => issue.code === 'write-scope-disjoint').length

  // 判别力基准：两张都在办（planned）且范围相同 → 必须判冲突
  const plannedA = { ...base, id: 'TASK-101', status: 'planned' } as unknown as TaskCard
  const plannedB = { ...base, id: 'TASK-102', status: 'planned' } as unknown as TaskCard
  assert.ok(conflicts([plannedA, plannedB]) > 0, '在办卡之间同范围必须判冲突（用例有判别力）')

  // D6-1：已完成的卡不再占用范围 → 新卡可以复用 pom.xml
  const done = { ...base, id: 'TASK-103', status: 'done' } as unknown as TaskCard
  const verified = { ...base, id: 'TASK-104', status: 'verified' } as unknown as TaskCard
  assert.equal(conflicts([done, plannedA]), 0, 'done 卡必须释放写范围（否则 pom.xml 被永久锁死）')
  assert.equal(conflicts([verified, plannedA]), 0, 'verified 卡同样释放')

  // blocked 仍占用（它只是等外部条件，随时会继续写同一范围）
  const blocked = { ...base, id: 'TASK-105', status: 'blocked' } as unknown as TaskCard
  assert.ok(conflicts([blocked, plannedA]) > 0, 'blocked 视为在办，仍占用范围')
})

test('D1/D2/D3（依据 sdo-test 15:28 诊断修复）：门禁名归一 / 最近判定按时间 / 原型判据不适用', async () => {
  const { normalizeGateId, processOfProject } = await import('../src/office.js')
  const workflow = processOfProject({ process: 'waterfall' } as never)

  // D1：判据描述里的中文全名（带编号）必须被识别
  assert.equal(normalizeGateId('交付门禁（G7）', workflow), 'G7', '带编号的中文全名必须归一为 id')
  assert.equal(normalizeGateId('交付门禁(G7)', workflow), 'G7', '半角括号也要认')
  assert.equal(normalizeGateId('G7', workflow), 'G7')
  assert.equal(normalizeGateId('交付', workflow), 'G7', '短别名仍可用')

  // D2：先判 G7 再判 G2 → "最近判定"必须是 G2（按时间），而不是文件字典序里的 G7
  seedDesign()
  office.checkGate(call(), 'G7')
  office.checkGate(call(), 'G2')
  const last = office.status(call()).lastGate
  assert.equal(last?.gate, 'G2', '最近判定必须按时间取，而不是按文件名排序取最后一条')

  // D3：waterfall 且没有原型目录时，原型类判据判"不适用"而不是红
  const g7 = office.checkGate(call(), 'G7')
  // 注意：判据的 `id` 是**流程里的准则编号**（C-61/C-62），检查器名（prototype.*）在流程数据里，
  // 不在 GateCriterionResult 上 —— 我第一版断言用错字段，当场被测试拦下。
  const proto = g7.criteria.filter((c) => c.id === 'C-61' || c.id === 'C-62')
  assert.ok(proto.length > 0, 'G7 应含原型类判据')
  assert.ok(proto.every((c) => c.ok), `不涉及原型时原型判据不得为红：${JSON.stringify(proto.map((c) => [c.id, c.ok, c.detail]))}`)
})

test('G-01~G-05（依据 sdo-test 汇总报告修复）：落盘名/建议透传/不复活废卡/风险口径', async () => {
  seedDesign()
  // G-01：用中文全名判定 → 落盘必须是规范 id
  const g3 = office.checkGate(call(), '架构门禁（G3）')
  assert.equal(g3.gate, 'G3')
  const gateStore = office.storeFor(office.requireWorkspace(call()))
  assert.ok(gateStore.listNames('gates').includes('G3.json'), `落盘应为 G3.json，实际：${gateStore.listNames('gates').join(',')}`)
  assert.ok(!gateStore.listNames('gates').some((name) => name.includes('（G3）')), '不得再用原始入参当文件名')

  // G-03：建议通道必须透传 requirements（旧实现静默丢弃 → 追溯静默漏卡）
  office.planDecompose(call(), {
    suggestions: [
      { title: '带上需求链接的建议卡', dod: ['x'], role: 'developer', writeScopes: ['src/sug/'], size: 'small', requirements: ['REQ-001'] } as never,
    ],
  })
  const sug = office.tasks(call()).find((task) => task.title === '带上需求链接的建议卡') as TaskCard
  assert.deepEqual(sug.requirements, ['REQ-001'], '建议通道的 requirements 不得被丢弃')

  // G-04：drop 掉结构卡后，再 decompose 不得复活它
  const structural = office.tasks(call()).find((task) => task.title.includes('DES-001')) as TaskCard
  office.dropTask(call(), structural.id, 'G-04 用例')
  const before = office.tasks(call()).length
  office.planDecompose(call())
  const revived = office.tasks(call()).filter((task) => task.title.includes('DES-001') && task.status !== 'dropped')
  assert.deepEqual(revived, [], '已显式放弃的元素不得被重建')
  assert.ok(office.tasks(call()).length >= before, '其余卡不受影响')

  // G-05：高/阻塞只统计未关闭
  const closed = { id: 'RISK-9', title: 't', level: 'blocker', status: 'closed', mitigation: 'm', owner: 'o', at: '' } as never
  const openRisk = { id: 'RISK-8', title: 't2', level: 'high', status: 'open', mitigation: 'm', owner: 'o', at: '' } as never
  const { riskStats } = await import('../src/domain/risks.js')
  const stats = riskStats([closed, openRisk])
  assert.equal(stats.blockers, 0, '已关闭的阻塞不得计入')
  assert.equal(stats.high, 1, '未关闭的高风险计入')
})

test('契约回收路径：drop 后不再参与覆盖判定（sdo_design action=drop-contract）', () => {
  seedDesign()
  const base = {
    producer: 'DES-001', consumer: 'DES-002', schema: 's',
    failureSemantics: { timeout: '3s', retry: '2', idempotency: 'yes' },
  }
  const first = office.recordContract(call(), { ...base, name: 'A → B' })
  const second = office.recordContract(call(), { ...base, name: 'A → B（正确版）' })
  const dropped = office.dropContract(call(), first.id, '口径踩坑留下的无效记录')
  assert.equal(dropped?.dropped, true, '作废必须置 dropped 标记（留痕）')
  assert.ok(office.contracts(call()).some((item) => item.id === first.id), '记录必须保留在真源里')
  assert.equal(second.dropped, undefined, '其它契约不受影响')
})
