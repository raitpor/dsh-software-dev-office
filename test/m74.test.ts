/**
 * **增量 74：`sdo-test-new` 2026-10-08 修复复测报告（`docs/2026-10-08-修复复测报告.md`）的回归。**
 *
 * 这一轮报告自己做了真机复测（11 ✅ / 2 🟡 / 1 ⚪ / 1 ❌），我核实的**新发现与残留**三条：
 *
 *   R-1（major，新）**复用路径会把卡投给"零工具的旧子会话"**：修复前构建创建的 `f4ae86fa`
 *      （descriptor `toolFilter.allow: []`）在修复后又被复用两次，两次都是"无工具 → 把工具调用写成正文
 *      → 1 轮结束"（journal `seq 406 dispatch/started tools:11 reused:true` 紧接 `seq 407 dispatch/observe-failed`）。
 *      复用判定只比 `maskHash`（角色掩码指纹），而"这个会话**创建时**拿到几个工具"是创建期的事实。
 *   D-4（minor，两轮报告都点名）同一维度的题库问题**逐字相同**（Q-0014…Q-0017 是同一句，只有 `targets` 不同）。
 *   D-2 残留：那 4 问问的是本项目 `scope.out` 里**明确不做**的「鉴权」。
 *
 * 纪律同其它 m*：只读真源断言、双向（该拦的红、正常路径绿）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { focusHead, nonGoalConflictOf, nonGoalTerms } from '../src/domain/grill.js'
import { admitDispatch, rolePools } from '../src/domain/pool.js'
import { maskFingerprint } from '../src/domain/roles.js'
import { describePoolBlock } from '../src/interface/describe.js'
import type { PoolChild } from '../src/domain/pool.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { Requirement, TaskCard } from '../src/types.js'

const BASE = join(fileURLToPath(new URL('../../', import.meta.url)), 'node_modules', '.sdo-test', 'm74')
const call = (): { sessionId: string } => ({ sessionId: 's1' })

let workspace: string
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// ————————————————————— R-1：复用要"有工具"的正面证据 —————————————————————

function idleChild(id: string, maskHash = 'same'): PoolChild {
  return {
    childSessionId: id,
    role: 'developer',
    task: 'TASK-001',
    mode: 'continuable',
    state: 'idle',
    rounds: 1,
    startedAt: '2026-10-08T00:00:00.000Z',
    finishedAt: '2026-10-08T00:01:00.000Z',
    maskHash,
  }
}

function readyCard(id: string): TaskCard {
  return {
    id, title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/${id.toLowerCase()}/`], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  } as unknown as TaskCard
}

test('M74-01 R-1：不能复用的空闲子代理进 `unusable` 且**不占池位**（cap=1 不得永久排队）', () => {
  const blocked = (child: PoolChild): string | undefined =>
    child.childSessionId === 'child-zero' ? '该会话创建时拿到 0 个工具（历史零工具派发）→ 强制新起' : undefined

  // ① **只有**那个零工具的空闲会话：cap=1 时它若继续占位，卡会永久排队 —— 必须仍能新起
  const onlyBlocked = rolePools({
    children: [idleChild('child-zero')],
    roles: ['developer'],
    caps: { developer: 1 },
    defaultCap: 1,
    reuseBlockedOf: blocked,
  })
  const devBlocked = onlyBlocked.find((pool) => pool.role === 'developer')
  assert.equal(devBlocked?.idle.length, 0, '零工具的空闲会话不算"空闲可复用"')
  assert.equal(devBlocked?.unusable.length, 1, '要单独列出（不静默）')
  assert.match(devBlocked?.unusable[0]?.reason ?? '', /0 个工具/u)
  assert.equal(devBlocked?.freeSlots, 1, '不可复用的空闲子代理**不占池位**（否则 cap=1 永久排队）')
  const admission = admitDispatch({
    ready: [readyCard('TASK-002')],
    pools: onlyBlocked,
    globalRoom: 4,
    reuseIdle: true,
    maskHashOf: () => 'same',
    reuseBlockedOf: blocked,
  })
  assert.equal(admission.dispatch.length, 1, '卡必须派得出去（旧实现会在这里永久排队）')
  assert.equal(admission.dispatch[0]?.reuseChildId, undefined, '零工具会话不许被复用 ⇒ 新起一个')
  // 这一层（工具面证据）由 `rolePools` 的 `unusable` 记账（回执里的池视图），不重复算进 `reuseSkipped`
  assert.equal(admission.reuseSkipped.filter((item) => item.childSessionId === 'child-zero').length, 0)
  // **R-6**：掩码指纹那一层也收敛进 `unusable`（`rolePools` 与准入共用 `reuseBlockedReason`）——
  // 旧实现只在准入里判，于是池视图把它算成"空闲可复用"、`freeSlots` 被占掉，真机并发 4→2。
  const stalePools = rolePools({ children: [idleChild('child-stale', 'OLD')], roles: ['developer'], caps: { developer: 2 }, defaultCap: 2, maskHashOf: () => 'NEW' })
  assert.equal(stalePools[0]?.idle.length, 0, '掩码过期的空闲会话不得算"空闲可复用"')
  assert.match(stalePools[0]?.unusable[0]?.reason ?? '', /掩码已变更/u, '原因要能读出来')
  const maskMismatch = admitDispatch({
    ready: [readyCard('TASK-004')],
    pools: stalePools,
    globalRoom: 4,
    reuseIdle: true,
    maskHashOf: () => 'NEW',
  })
  assert.equal(maskMismatch.dispatch[0]?.reuseChildId, undefined, '掩码指纹不一致同样不许复用')
  assert.equal(maskMismatch.dispatch[0]?.reuseChildId, undefined, '掩码过期不得复用')
  // 不再走 `reuseSkipped`：它已经在池视图的 `unusable` 里如实露面（判据只有一处，回执不会自相矛盾）
  assert.equal(maskMismatch.reuseSkipped.length, 0)

  // ② 有"证据可用"的空闲会话时：cap=1 的位子归它（复用它，不再新建）
  const withUsable = rolePools({
    children: [idleChild('child-zero'), idleChild('child-ok')],
    roles: ['developer'],
    caps: { developer: 1 },
    // **R-6**：池视图也判掩码指纹 ⇒ 夹具要给出与当前一致的指纹（`idleChild` 默认 `'same'`）
    maskHashOf: () => 'same',
    defaultCap: 1,
    reuseBlockedOf: blocked,
  })
  const devOk = withUsable.find((pool) => pool.role === 'developer')
  assert.equal(devOk?.idle.length, 1, '只有"有证据能用"的那个算空闲可复用')
  assert.equal(devOk?.idle[0]?.childSessionId, 'child-ok')
  assert.equal(devOk?.freeSlots, 0, '可复用的那个占着这一格（复用不占新位子）')
  const reuse = admitDispatch({
    ready: [readyCard('TASK-003')],
    pools: withUsable,
    globalRoom: 4,
    reuseIdle: true,
    maskHashOf: () => 'same',
    reuseBlockedOf: blocked,
  })
  assert.equal(reuse.dispatch[0]?.reuseChildId, 'child-ok', '有证据的空闲会话要真的被复用')
  assert.equal(reuse.reuseSkipped.filter((item) => item.childSessionId === 'child-ok').length, 0)

  // ③ 防御面：池子只过了**掩码那一层**（没有工具面观测判据，例如调用方自己拼的池）时，
  // 准入这一层也必须守同一判据（`reuseSkipped` 是这条防御线的出口）
  const rawPools = rolePools({
    children: [idleChild('child-zero', 'H')],
    roles: ['developer'],
    caps: { developer: 2 },
    defaultCap: 2,
    maskHashOf: () => 'H',
  })
  assert.equal(rawPools[0]?.idle.length, 1, '前置：掩码一致、没喂观测判据 ⇒ 它此刻仍在 idle 里')
  const guarded = admitDispatch({
    ready: [readyCard('TASK-005')],
    pools: rawPools,
    globalRoom: 4,
    reuseIdle: true,
    maskHashOf: () => 'same',
    reuseBlockedOf: blocked,
  })
  assert.equal(guarded.dispatch[0]?.reuseChildId, undefined, '准入层同样不许把它当可复用')
  assert.equal(guarded.reuseSkipped.length, 1, '准入层要如实报出放弃复用的原因')
  assert.match(guarded.reuseSkipped[0]?.reason ?? '', /0 个工具/u)
})

test('M74-02 R-1：office 层把"工具面观测"接进复用判定（没观测到就不复用）', () => {
  const store = office.storeFor(workspace) as unknown as SdoStore
  office.init(call(), { name: 'M74', scale: 'normal', stakeholders: ['业务方'] })
  const journal: Journal = office.journalFor(workspace)
  // 一条"已结算的可续聊子代理"（掩码指纹取**真值**——R-6 之后指纹判据在 office 内部现算，
  // 写死 'FIXED' 的夹具会变成"掩码已变更"而误判成不可复用）
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'child-old', tools: 11, role: 'developer', mode: 'continuable', maskHash: maskFingerprint('developer') })
  journal.append('dispatch/finished', { childSessionId: 'child-old', task: 'TASK-001', role: 'developer', turn: 1, reason: 'completed' })
  void store

  const poolCall = { sessionId: 's1', cwd: workspace }
  // ① 没有任何工具面观测 ⇒ 不许复用，而且不占池位
  const cold = office.poolPlan(poolCall, { reuseIdle: true })
  const coldPool = cold.pools.find((pool) => pool.role === 'developer')
  if (coldPool !== undefined) {
    assert.equal(coldPool.idle.length, 0, '没观测到工具面 ⇒ 不算可复用')
    assert.equal(coldPool.unusable.length, 1)
  }
  // ② 观测到"它手里确实有工具" ⇒ 才允许复用
  office.noteChildFace(poolCall, { childSessionId: 'child-old', tools: ['read', 'bash', 'sdo_task'], violations: [] })
  const warm = office.poolPlan(poolCall, { reuseIdle: true })
  const warmPool = warm.pools.find((pool) => pool.role === 'developer')
  assert.equal(warmPool?.idle.length, 1, '有观测 + 掩码指纹一致 ⇒ 可复用')
  assert.equal(warmPool?.unusable.length, 0)
})

// ————————————————————— D-4：问题必须由需求自身派生 —————————————————————

test('M74-03 D-4：同一模板落到多条需求时，题面各不相同（并各自指向自己的需求）', () => {
  office.init(call(), { name: 'M74', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call(), {
    scopeIn: ['对账'],
    // **D-2 残留**：把「鉴权」写成明确的非目标 —— 真机上题库仍会就它发问
    scopeOut: ['鉴权与多用户'],
  })
  const a = office.capture(call(), { title: '差异检测', statement: '系统须识别两日文件之间的差异记录', kind: 'functional', priority: 'must', sourceStakeholder: 'STK-01' })
  const b = office.capture(call(), { title: '报告输出', statement: '系统须输出差异清单报告', kind: 'functional', priority: 'must', sourceStakeholder: 'STK-01' })
  // 让 `user` 维度保持 0 分（最弱），保证题库的 user 模板会被选中
  const zeros = { goal: 2, user: 0, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 }
  office.update(call(), { id: a.requirement.id, modelDimensions: zeros })
  office.update(call(), { id: b.requirement.id, modelDimensions: zeros })

  const first = office.grill(call(), { requirementIds: [a.requirement.id, b.requirement.id], limit: 4 })
  assert.ok(first.questions.length >= 2, `要生成问题：${JSON.stringify(first.skipped)}`)
  const texts = first.questions.map((question) => question.text)
  assert.equal(new Set(texts).size, texts.length, `题面必须两两不同（旧实现逐字相同）：${texts.join(' ｜ ')}`)
  for (const question of first.questions) {
    assert.match(question.text, /^针对「/u, `每问都要点明针对哪条需求：${question.text}`)
  }
  const titles = new Set(first.questions.map((question) => question.text.match(/^针对「([^」]+)」/u)?.[1]))
  assert.ok(titles.has('差异检测') || titles.has(a.requirement.id), `要指向自己的需求标题：${[...titles].join(',')}`)

  // **D-2 残留**：撞上声明的非目标时必须**记进真源**（不静默跳过，也不装作没看见）
  const conflicted = first.questions.filter((question) => question.nonGoalConflict !== undefined)
  assert.ok(conflicted.length > 0, `问了 scope.out 里的事就要留痕：${JSON.stringify(first.questions.map((q) => [q.id, q.nonGoalConflict]))}`)
  assert.match(conflicted[0]?.nonGoalConflict ?? '', /鉴权/u)
  const stored = office.storeFor(workspace).readYaml<{ question: { nonGoalConflict?: string } }>('questions', `${conflicted[0]!.id}.yml`)
  assert.equal(stored?.question.nonGoalConflict, conflicted[0]?.nonGoalConflict, '冲突标记必须落盘（可被审计）')

  // 幂等：同一模板 + 同一需求**不重复问**（抬头的归一化不能破坏去重）。
  // 注意：第二次调用可以继续问**别的**模板（题库 4 个最弱维度里上一批没排上的），所以判据是
  // "归一化后的题面不再重复"，不是"必须一条都不生成"。
  const strip = (text: string): string => text.replace(/^针对[^：]*：/u, '')
  const seen = new Set(first.questions.map((question) => `${question.targets.join(',')}|${strip(question.text)}`))
  const second = office.grill(call(), { requirementIds: [a.requirement.id, b.requirement.id], limit: 4 })
  for (const question of second.questions) {
    const key = `${question.targets.join(',')}|${strip(question.text)}`
    assert.equal(seen.has(key), false, `同一需求上重复问了同一题：${question.text}`)
    seen.add(key)
  }
})

test('M74-04 D-2 残留：非目标只取"可机械匹配的中文词"（ASCII 词不做匹配）', () => {
  const terms = nonGoalTerms(['鉴权与多用户', '发布与运维', 'SDO 插件的 Web 面板', '不做'])
  const words = terms.map((item) => item.term)
  assert.ok(words.includes('鉴权'), `要切出子词：${words.join(',')}`)
  assert.ok(words.includes('多用户'))
  assert.ok(words.includes('运维'))
  assert.equal(words.includes('SDO'), false, 'ASCII 词满篇都是，不许参与匹配')
  assert.equal(words.includes('Web'), false)
  assert.equal(words.includes('不做'), false, '通用词要挡掉')

  // 正反两侧
  assert.equal(nonGoalConflictOf('谁不能看到这些数据？越权访问的后果是什么？', '#user-visibility 权限边界决定数据模型与接口鉴权', ['鉴权与多用户']), '鉴权')
  assert.equal(nonGoalConflictOf('单日 100 万条时 P99 是多少？', '#constraint-latency 时延', ['鉴权与多用户']), undefined)
})

test('M74-05 D-4 抬头口径：`focusHead` 只加信息、不改变维度语义', () => {
  const requirement = {
    id: 'REQ-001', title: '差异检测', statement: 's', rationale: '', kind: 'functional', priority: 'must',
    status: 'draft', sourceStakeholder: '', acceptance: [], version: 0.1, revision: 1,
    ambiguity: { score: 0, dimensions: { user: 0, data: 1 } }, openQuestions: [], createdAt: '', updatedAt: '',
  } as unknown as Requirement
  const head = focusHead(requirement, 'user', 'REQ-001')
  assert.match(head, /^针对「差异检测」/u)
  assert.match(head, /尚未澄清/u, '要点出该需求哪些维度还没澄清')
  assert.match(head, /【本问聚焦：/u, '命中薄弱维度时要更聚焦')
  // 需求读不到时退回 target（不许写 `undefined`）
  assert.match(focusHead(undefined, 'user', 'REQ-009'), /REQ-009/u)
})

test('M74-06 R-1：池视图必须把"不可复用"那批印出来（否则"池里有人却新起"无法解释）', () => {
  const pools = rolePools({
    children: [idleChild('child-zero-aaaa')],
    roles: ['developer'],
    caps: { developer: 1 },
    defaultCap: 1,
    reuseBlockedOf: () => '该会话创建时拿到 0 个工具（历史零工具派发）→ 强制新起',
  })
  const rendered = describePoolBlock(pools, [], true, 30)
  assert.match(rendered, /不占池位/u, `回执要点明这类会话不占池位：${rendered}`)
  assert.match(rendered, /child-ze/u, '要点名是哪个子会话（前 8 位）')
  assert.match(rendered, /0 个工具/u, '要给出原因')
  // 反向：没有不可复用的会话时不得出现这行噪声
  const clean = describePoolBlock(rolePools({ children: [idleChild('child-ok', 'H')], roles: ['developer'], caps: { developer: 1 }, defaultCap: 1, maskHashOf: () => 'H' }), [], true, 30)
  assert.doesNotMatch(clean, /不占池位/u)
})

test('M74-07 R-6：**office 层**自己把掩码指纹喂给池视图 —— 掩码过期的空闲会话不占池位（两套口径的收敛点）', () => {
  office.init(call(), { name: 'M74', scale: 'normal', stakeholders: ['业务方'] })
  const journal: Journal = office.journalFor(workspace)
  const NOW = maskFingerprint('developer')
  // ① 一个"掩码过期"的空闲会话（`roles.yml` 改过之后创建的）+ 一个"当前掩码"的在飞会话
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'child-stale', tools: 11, role: 'developer', mode: 'continuable', maskHash: 'deadbeefdead' })
  journal.append('dispatch/finished', { childSessionId: 'child-stale', task: 'TASK-001', role: 'developer', turn: 1, reason: 'completed' })
  journal.append('dispatch/started', { task: 'TASK-002', provider: 'spawn', childSessionId: 'child-flying', tools: 11, role: 'developer', mode: 'continuable', maskHash: NOW })
  const poolCall = { sessionId: 's1', cwd: workspace }
  const view = office.poolView(poolCall).find((pool) => pool.role === 'developer')
  assert.equal(view?.busy.length, 1, '在飞 1')
  assert.equal(view?.idle.length, 0, '**掩码过期的空闲会话不算可复用**（判据在 office 内部现算，不靠调用方传）')
  assert.equal(view?.unusable.length, 1, '要单独列出来（不静默）')
  assert.match(view?.unusable[0]?.reason ?? '', /掩码已变更|观测/u, '原因要能读出来（两条判据都成立时，观测那条更可执行）')
  // 把"工具面观测"这一层补上（它排在前）⇒ 理由必须变成**掩码**那条 —— 这一步证明 office 真的在判掩码指纹
  office.noteChildFace(poolCall, { childSessionId: 'child-stale', tools: ['read', 'write', 'sdo_task'], violations: [] })
  const afterObserve = office.poolView(poolCall).find((pool) => pool.role === 'developer')
  assert.equal(afterObserve?.idle.length, 0, '观测过它也不给复用（指纹不符）')
  assert.match(afterObserve?.unusable[0]?.reason ?? '', /掩码已变更/u, '两条判据都满足时理由要指向掩码')
  assert.ok((view?.freeSlots ?? 0) > 0, `不占池位：freeSlots = cap − 在飞 − 可复用空闲（实际 ${view?.freeSlots}）`)
  // ② 同一个图形经**派发路径**（poolPlan）也必须是同一结论（旧实现这里拒绝复用、池视图却说空闲可复用）
  const plan = office.poolPlan(poolCall, { reuseIdle: true })
  const planPool = plan.pools.find((pool) => pool.role === 'developer')
  assert.deepEqual(
    planPool?.unusable.map((item) => item.childSessionId),
    afterObserve?.unusable.map((item) => item.childSessionId),
    '状态路径与派发路径的"不可复用"清单必须一致（同一个人、同一个理由口径）',
  )
  assert.match(planPool?.unusable[0]?.reason ?? '', /掩码已变更/u, '派发路径同样指向掩码')
  assert.equal(planPool?.idle.length, 0)
})
