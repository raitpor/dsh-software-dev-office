/**
 * **增量 78：sdo-test-new 复测批次（R-8 / R-12 / R-13 / R-16）** —— 回归 + 变异自证。
 *
 *   · **R-8（major，我上一轮 R-3 修复引入的回归）**：新判据被"**历史第一条** fail/pass 对"钉死 ——
 *     ① 后续卡只要覆盖同一需求就继承**别人当年**的不一致（TASK-022 被 `tdd-env-changed` 拒，而它本卡
 *     新记的结果是同断言面、逐字同 env），而历史结果不可变、卡在自己写范围内修不了；
 *     ② 规则③（红绿之间产物必须变）对**验证/复算类卡**结构性不可满足（它们的 DoD 恰恰要求产物不变）。
 *     修：取**最近一对** `fail → pass`；三条判据各自可 `exempt`（沿用 `(卡, check)` 豁免机制）。
 *     附：`exempt` 绑卡 id ⇒ `drop`+重建后成**死条目**且无提示（本项目白花一轮）。
 *   · **R-12（major）**：C-42/C-45 的覆盖集只排 `role === 'reviewer'`，排不掉**实质在做复核**的卡 ⇒
 *     代核卡一 done 就要求"它自己也要有一条被采纳的评审"（自我递归）。修：按**是否产出产品工件**筛
 *     （`writeScopes` 全落在 `.sdo/`+`docs/` 之下 ⇒ 不是产品卡），不靠 role。
 *   · **R-13（major）**：`freshChild=true`（强制新起）× 池容量 ⇒ "想新建会超 cap、想复用被自己禁止" ⇒ 自锁
 *     （真机 `在飞 0/4` 却 `池满`）。修：本轮不许用的会话不参与容量计算。
 *   · **R-16（major，流程口径，用户 2026-10-08 指令）**：核实评审**默认归实现者**（产品卡 = developer ——
 *     他是按评审修代码的人，也最需要判断「真坏了」还是「有意取舍」）；实现会话退役后可**代核**，
 *     但代核要如实标注**谁核的、什么角色、局限**（只复现/反证，不替作者处置），且成立的发现要**回流修复**。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { deadExemptions, redGreenGaps } from '../src/domain/construction.js'
import { producesProductArtifacts } from '../src/domain/plan.js'
import { admitDispatch, rolePools } from '../src/domain/pool.js'
import type { PoolChild } from '../src/domain/pool.js'
import { recordTestCase, recordTestResult } from '../src/domain/records.js'
import type { Review } from '../src/domain/records.js'
import { verifyReviewFinding } from '../src/domain/reviewVerification.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm78')

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tests', 'results'), { recursive: true })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function fresh(name: string): { store: SdoStore; journal: Journal } {
  const dir = join(BASE, name)
  mkdirSync(join(dir, '.sdo', 'tests', 'results'), { recursive: true })
  const store = new SdoStore(join(dir, '.sdo'))
  return { store, journal: new Journal(store) }
}

const card = (id: string): never => ({
  id, role: 'developer', size: 'small', status: 'in-progress', blockedBy: [], writeScopes: ['lib/'],
  evidenceRequired: ['command'], revision: 1, evidence: [],
} as never)

function child(id: string, state: 'busy' | 'idle', maskHash = 'H'): PoolChild {
  return { childSessionId: id, role: 'developer', task: 'T0', mode: 'continuable', state, rounds: 1, startedAt: '', finishedAt: '', maskHash }
}

// ————————————————————————— R-8 —————————————————————————

test('M78-01 R-8：判据取**最近一对** fail→pass（历史的旧实验不再永久生效）', () => {
  const { store, journal } = fresh('r8-latest')
  const task = { id: 'TASK-022', requirements: ['REQ-001'] } as unknown as TaskCard
  const tc = recordTestCase(store, journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  // ① 历史那一对：**指纹形状**的 env 不同（`k=v; k=v`、无中文）
  recordTestResult(store, journal, { caseId: tc.id, status: 'fail', evidence: '红（历史）', env: 'python3=3.14.7; baseline=frozen' })
  recordTestResult(store, journal, { caseId: tc.id, status: 'pass', evidence: '绿（历史）', env: 'python3=3.14.7; baseline=live' })
  assert.deepEqual(redGreenGaps(store, journal, task).map((gap) => gap.check), ['tdd-env-changed'], '前置：旧口径下这里必须红')
  // ② 本卡新记的一对：同断言面、逐字同 env ⇒ **必须顶掉**历史那一对（旧实现按 id 取第一条，顶不掉）
  recordTestResult(store, journal, { caseId: tc.id, status: 'fail', evidence: '红（本卡）', env: 'node=26', harness: 'surface-A', artifact: 'lib/x.js', artifactSha256: 'h1' })
  recordTestResult(store, journal, { caseId: tc.id, status: 'pass', evidence: '绿（本卡）', env: 'node=26', harness: 'surface-A', artifact: 'lib/x.js', artifactSha256: 'h2' })
  assert.deepEqual(redGreenGaps(store, journal, task), [], '最近一对一致 ⇒ 不该再被历史那一对判红')
  // ③ 反向（不许拦错的反面）：把**最近**那一对改成不一致 ⇒ 照红
  recordTestResult(store, journal, { caseId: tc.id, status: 'fail', evidence: '红（最近）', env: 'node=20' })
  recordTestResult(store, journal, { caseId: tc.id, status: 'pass', evidence: '绿（最近）', env: 'node=26' })
  assert.deepEqual(redGreenGaps(store, journal, task).map((gap) => gap.check), ['tdd-env-changed'])
})

test('M78-02 R-8：验证类卡片可**逐条豁免**（产物必须不变 = 结构性豁免，不是放水）', () => {
  const { store, journal } = fresh('r8-exempt')
  const task = { id: 'TASK-022', requirements: ['REQ-001'] } as unknown as TaskCard
  const tc = recordTestCase(store, journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  // 产物 sha256 一样（冻结基线：INV-005）⇒ 默认命中 `tdd-artifact-unchanged`
  recordTestResult(store, journal, { caseId: tc.id, status: 'fail', evidence: '红', env: 'node=26', harness: 'A', artifact: 'legacy/x.py', artifactSha256: 'frozen' })
  recordTestResult(store, journal, { caseId: tc.id, status: 'pass', evidence: '绿', env: 'node=26', harness: 'A', artifact: 'legacy/x.py', artifactSha256: 'frozen' })
  assert.deepEqual(redGreenGaps(store, journal, task).map((gap) => gap.check), ['tdd-artifact-unchanged'])
  // 只豁免这一条：另外两条同实验判据**仍然生效**（豁免不许变成"全放行"）
  const exempted = redGreenGaps(store, journal, task, { exempt: (check) => check === 'tdd-artifact-unchanged' })
  assert.deepEqual(exempted, [])
  const other = redGreenGaps(store, journal, task, { exempt: (check) => check === 'tdd-env-changed' })
  assert.deepEqual(other.map((gap) => gap.check), ['tdd-artifact-unchanged'], '豁免只对点名的 check 生效')
  // 接线：`constructionDoneGaps` 必须把逐条豁免传下去
  const source = readFileSync(join(ROOT, 'src', 'domain', 'construction.ts'), 'utf8')
  assert.match(source, /redGreenGaps\(store, journal, card, \{ exempt \}\)/u, '豁免要传进红绿判据')
})

test('M78-03 R-8 附录：死豁免（卡不存在 / 已 dropped）必须能被诊断出来', () => {
  const { store } = fresh('r8-dead')
  store.writeYaml(['construction', 'profile.yml'], {
    profile: {
      scope: 'all',   // `SCOPE_ALL` 的字面量（不是 `*`）
      packages: ['tdd'],
      derivedFrom: ['REQ-001'],   // 选了包就必须留依据（`uiConstruction.c04`），否则 profile 判 invalid
      exempt: [
        { task: 'TASK-030', check: 'tdd-red-green-missing', why: '被 drop 并重建为 TASK-043' },
        { task: 'TASK-999', check: 'tdd-mutation-missing', why: '卡号写错了' },
        { task: 'TASK-001', check: 'tdd-mutation-missing', why: '仍然有效的卡' },
      ],
    },
  })
  store.writeYaml(['tasks', 'TASK-001.yml'], { task: card('TASK-001') })
  store.writeYaml(['tasks', 'TASK-030.yml'], { task: { ...(card('TASK-030') as Record<string, unknown>), status: 'dropped' } })
  const dead = deadExemptions(store)
  assert.equal(dead.length, 2, `只该报两条死豁免：${JSON.stringify(dead)}`)
  assert.deepEqual(dead.map((item) => `${item.task}:${item.reason}`).sort(), ['TASK-030:dropped', 'TASK-999:missing'])
  // 接线：状态块要主动说（否则"靠人肉比对"这条教训会复发）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /office\.deadExemptions\(call\)/u)
  assert.match(index, /uiIndex\.kDeadExemption/u)
})

// ————————————————————————— R-12 —————————————————————————

test('M78-04 R-12：判据按"是否产出产品工件"筛，而不是只排 role=reviewer', () => {
  // 不产出产品工件：复核/代核/文书/收尾卡（全部写在 `.sdo/`、`docs/` 之下）
  assert.equal(producesProductArtifacts({ writeScopes: ['.sdo/', 'docs/evidence/'] }), false)
  assert.equal(producesProductArtifacts({ writeScopes: ['docs/REVIEW.md'] }), false)
  assert.equal(producesProductArtifacts({ writeScopes: [] }), false, '没有写范围 ⇒ 认不出产品工件（保守：不进"必须被评审"的集合）')
  // 产出产品工件：任何非 `.sdo/`+`docs/` 的写范围
  for (const scope of ['lib/', 'src/x.ts', 'bin/', 'test/', 'tools/', 'fixtures/', 'public/', 'server.mjs']) {
    assert.equal(producesProductArtifacts({ writeScopes: [scope] }), true, `${scope} 是产品路径`)
  }
  // 混合 ⇒ 是产品卡
  assert.equal(producesProductArtifacts({ writeScopes: ['docs/', 'lib/core.js'] }), true)
  // 接线：两条评审判据都要用它（C-42 与 C-45 同源）
  const gates = readFileSync(join(ROOT, 'src', 'domain', 'gates.ts'), 'utf8')
  const uses = gates.match(/producesProductArtifacts\(task\)/gu) ?? []
  assert.ok(uses.length >= 2, `review.independent 与 review.required 都要用它（实际 ${uses.length} 处）`)
})

// ————————————————————————— R-13 —————————————————————————

test('M78-05 R-13：`freshChild`（强制新起）时"可复用空闲"不占容量（真机自锁的那个形状）', () => {
  // 真机形状：cap=4，4 个"空闲可复用"（掩码一致 + 有观测）⇒ 想新起就超 cap，想复用被 freshChild 禁止
  const idle = [child('i1', 'idle'), child('i2', 'idle'), child('i3', 'idle'), child('i4', 'idle')]
  const pools = rolePools({ children: idle, roles: ['developer'], caps: {}, defaultCap: 4, maskHashOf: () => 'H' })
  assert.equal(pools[0]?.idle.length, 4, '前置：4 个都算可复用空闲')
  assert.equal(pools[0]?.freeSlots, 0, '前置：容量被它们占满（这正是自锁的形状）')

  // ② 默认（可复用）⇒ 复用其中一个
  const reuse = admitDispatch({ ready: [card('TASK-041')], pools, globalRoom: 4, reuseIdle: true, maskHashOf: () => 'H' })
  assert.equal(reuse.dispatch[0]?.reuseChildId, 'i1', '默认走复用')
  // ① 强制新起 ⇒ **必须派得出去**（新起），不能被"我不许用的会话"挡住
  const forced = admitDispatch({ ready: [card('TASK-041')], pools, globalRoom: 4, reuseIdle: true, maskHashOf: () => 'H', forceNew: true })
  assert.equal(forced.dispatch.length, 1, `freshChild 时必须能新起：${JSON.stringify(forced.blocked)}`)
  assert.equal(forced.dispatch[0]?.reuseChildId, undefined, '强制新起 ⇒ 不复用')
  assert.equal(forced.queued.length, 0)
  // ③ 容量仍然有上限：cap=1 且已有 1 个在飞 ⇒ 强制新起也得排队，且**理由要说清是 freshChild**
  const busyPools = rolePools({ children: [child('b1', 'busy'), ...idle], roles: ['developer'], caps: { developer: 1 }, defaultCap: 1, maskHashOf: () => 'H' })
  const blocked = admitDispatch({ ready: [card('TASK-042')], pools: busyPools, globalRoom: 4, reuseIdle: true, maskHashOf: () => 'H', forceNew: true })
  assert.equal(blocked.dispatch.length, 0, '在飞 1/1 ⇒ 新起也没有位子')
  assert.match(blocked.blocked[0]?.detail ?? '', /freshChild=true/u, `理由要点名"强制新起"：${blocked.blocked[0]?.detail}`)
  assert.match(blocked.blocked[0]?.detail ?? '', /不参与容量计算/u)
  // 接线：`poolPlan` 必须把 freshChild 透传成 forceNew
  const office = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  assert.match(office, /options\.freshChild === true \? \{ forceNew: true \}/u)
  // 接线：`sdo_plan action=next` 要把 `freshChild`（以及 R-9 的 `orphanTtlMinutes`）传进 `poolPlan`
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /reuseIdle: reuse\.supported && !freshChild,/u)
  assert.match(index, /^\s*freshChild,$/mu)
  assert.match(index, /orphanTtlMinutes: args\.orphanTtlMinutes/u)
})

// ————————————————————————— R-16 —————————————————————————

test('M78-06 R-16：核实者身份与角色关系要如实记账（代核 = 谁核的、同不同角色）', () => {
  const { store, journal } = fresh('r16')
  // 一张**已收工**的 developer 卡（实现会话退役 ⇒ 允许代核），及其评审
  store.writeYaml(['tasks', 'TASK-050.yml'], { task: { ...(card('TASK-050') as Record<string, unknown>), status: 'done' } })
  // **记录评审时就标下原卡角色**（2026-10-08 用户口径）：卡会被 drop/重建/改角色，
  // "该由哪个角色来核"必须留在评审自己身上，否则规则会退化成"谁都能核"
  const review: Review = {
    id: 'REV-001', taskId: 'TASK-050', taskRole: 'developer', reviewer: 'human', verdict: 'pass',
    findings: ['这条发现是假的（附证）'], at: new Date().toISOString(),
  }
  store.writeYaml(['reviews', 'REV-001.yml'], { review })
  journal.append('task/claimed', { id: 'TASK-050', owner: 'dev-1', sessionId: 'dev-session', revision: 1 })
  // 代核者是个 tester 会话（真机：reviewer 没有 bash ⇒ 只能挂 tester）
  journal.append('dispatch/started', { task: 'TASK-050', provider: 'spawn', childSessionId: 'test-session', role: 'tester', tools: 9 })

  // ① **跨角色代核被拒**（真机就是这么把 developer 卡的 29 条发现交给 tester 的）——
  //    实现会话退役 ⇒ 代核必须**同角色**，回执给出两条出路
  const cross = verifyReviewFinding(store, journal, {
    reviewId: 'REV-001', index: 0, outcome: 'refuted', evidence: '我复跑过，不成立', by: 'sub-tester',
    sessionId: 'test-session',
  })
  assert.equal(cross.ok, false, `跨角色代核必须被拒：${JSON.stringify(cross)}`)
  assert.equal(cross.ok ? '' : cross.code, 'cross-role-verifier')
  assert.match(cross.ok ? '' : cross.detail, /developer/u, '要点名该由哪个角色来核')
  assert.match(cross.ok ? '' : cross.detail, /同角色/u)
  // ② **同角色代核放行**（另一个 developer 会话）
  journal.append('dispatch/started', { task: 'TASK-050', provider: 'spawn', childSessionId: 'dev-2', role: 'developer', tools: 9 })
  const same = verifyReviewFinding(store, journal, {
    reviewId: 'REV-001', index: 0, outcome: 'reproduced', evidence: '复现了', by: 'sub-dev', sessionId: 'dev-2',
  })
  assert.equal(same.ok, true, JSON.stringify(same))
  assert.equal(same.ok ? same.disposition.ownerChecked : '', 'owner-tenure-over', '代核要如实标注"不是实现者本人"')
  assert.equal(same.ok ? same.disposition.verifierRole : '', 'developer')
  assert.equal(same.ok ? same.disposition.roleMatch : '', 'same-role')
  // **R-19 A**：同一 `(评审, 发现)` 再次核实**默认被拒**（真机：先代核、后实现者核，视图静默留后写的那条）
  const again = verifyReviewFinding(store, journal, {
    reviewId: 'REV-001', index: 0, outcome: 'reproduced', evidence: '再核一次', by: 'sub-dev', sessionId: 'dev-2',
  })
  assert.equal(again.ok, false, '默认不许覆盖已有核实')
  assert.equal(again.ok ? '' : again.code, 'already-verified')
  assert.match(again.ok ? '' : again.detail, /已经核实过/u, '回执要说清已由谁、判成什么')
  // 显式 `revise: true` 才覆盖，且覆盖要留痕（`revisedFrom`）+ 读得回来
  const revised = verifyReviewFinding(store, journal, {
    reviewId: 'REV-001', index: 0, outcome: 'refuted', evidence: '复核后改判', by: 'sub-dev2', sessionId: 'dev-2', revise: true,
  })
  assert.equal(revised.ok, true, JSON.stringify(revised))
  assert.equal(revised.ok ? revised.disposition.roleMatch : '', 'same-role')
  assert.equal(revised.ok ? revised.disposition.revisedFrom?.outcome : '', 'reproduced', '被覆盖的那条要留痕')
  const readBack = verifyReviewFinding(store, journal, {
    reviewId: 'REV-001', index: 0, outcome: 'refuted', evidence: '想再核（会被拒，用来确认读回的是覆盖后的那条）', by: 'x', sessionId: 'dev-2',
  })
  assert.equal(readBack.ok, false)
  assert.match(readBack.ok ? '' : readBack.detail, /refuted/u, '回执里的"已核实"要反映覆盖后的判定')
  // ③ **人工核实**（不传会话）仍然可以：拿不到角色关系 ⇒ 不判角色，如实标 unknown。
  // 注意 R-19 A 之后连人工也要显式 `revise: true` 才能覆盖已有核实（这正是"默认拒绝再次核实"的强度）
  const human = verifyReviewFinding(store, journal, {
    reviewId: 'REV-001', index: 0, outcome: 'reproduced', evidence: '我自己复跑了', by: 'human', revise: true,
  })
  assert.equal(human.ok, true, JSON.stringify(human))
  assert.equal(human.ok ? human.disposition.roleMatch : '', 'unknown')
  // ④ 老评审（没有 `taskRole`）也不许凭空判死：卡还在时按卡的角色判
  // YAML 子集写不了 `undefined` ⇒ 用解构真的把键去掉（模拟老评审）
  const { taskRole: _omitted, ...legacyReview } = review
  store.writeYaml(['reviews', 'REV-002.yml'], {
    review: { ...legacyReview, id: 'REV-002', findings: ['老评审的一条发现'] },
  })
  const legacy = verifyReviewFinding(store, journal, {
    reviewId: 'REV-002', index: 0, outcome: 'reproduced', evidence: '复现', by: 'sub-tester', sessionId: 'test-session',
  })
  assert.equal(legacy.ok, false, '没有 taskRole 时退回卡上的角色（这张卡是 developer）⇒ 跨角色一样被拒')
  assert.equal(legacy.ok ? '' : legacy.code, 'cross-role-verifier')
  // ⑤ **卡已经不在了**（drop/重建）时，判据只能靠评审自己记的 `taskRole` —— 否则规则退化成"谁都能核"
  store.writeYaml(['reviews', 'REV-003.yml'], {
    review: { ...review, id: 'REV-003', taskId: 'TASK-GONE', taskRole: 'developer', findings: ['卡已被 drop'] },
  })
  const gone = verifyReviewFinding(store, journal, {
    reviewId: 'REV-003', index: 0, outcome: 'reproduced', evidence: '复现', by: 'sub-tester', sessionId: 'test-session',
  })
  assert.equal(gone.ok, false, '卡不在也要按评审记下的角色判同角色')
  assert.equal(gone.ok ? '' : gone.code, 'cross-role-verifier')
  // 回执与角色卡都要把"代核"讲清楚（R-16 的三条建议：标注 + 同角色优先 + 回流修复）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /uiIndex\.kReviewProxyVerified/u, '代核要有专门的回执行')
  assert.match(index, /result\.disposition\.ownerChecked === 'session'/u, '只有实现者本人核的才不标"代核"')
  const developer = readFileSync(join(ROOT, 'skills', 'role-developer.md'), 'utf8')
  assert.match(developer, /核实评审归我/u, 'developer 卡要写明"核实评审归我"')
  assert.match(developer, /核实不是终点/u, '成立的发现要回流修复')
  const tester = readFileSync(join(ROOT, 'skills', 'role-tester.md'), 'utf8')
  assert.match(tester, /核实评审不是我的本职/u, 'tester 卡要写明"代核"的边界')
  assert.match(tester, /不替作者做处置决定/u)
  // 记录评审时要把原卡角色标上（用户口径），否则"同角色代核"判不出来
  const office = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  assert.match(office, /const taskRole = /u, '记录评审时要算 taskRole')
  assert.match(office, /card\?\.role \?\? ''/u, 'taskRole 取不到就退回卡上的角色')
  assert.match(office, /recordReview\(store, journal, \{ \.\.\.input,/u, 'taskRole 要写进评审')
})
