/**
 * B5/B6：把角色掩码从"声明"变成"运行时"。
 *
 * B5：`tools/pre-execute` 钩子里的角色不再写死 `cockpit`（那样阶段纪律与掩码都被首行放行），
 *     而是用宿主的 `ToolExecution.agent` → 会话 → **认领过的卡**推出真实角色。
 * B6：认得出的派发角色，其掩码之外的调用被**硬拦**（白名单语义）。
 *
 * 两个方向都要断言（收紧类改动天生只会让"拦住"变好看）：
 *   · 该拦的拦住了（掩码外 / deny 里的工具）；
 *   · **不该拦的没被拦**（掩码内、以及每个角色**协议必需**的工具）—— 否则角色连自己的活都干不了。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { apply } from '../src/index.js'
import { SdoStore } from '../src/infra/store.js'
import { claim, reassign, release, report } from '../src/domain/collab.js'
import { buildDispatch } from '../src/integration/orchestrator.js'
import { ROLES } from '../src/domain/plan.js'
import type { SdoConfig } from '../src/config.js'
import type { Context } from '@deepseek-ai/cordis'
import type { EvidenceItem, TaskStatus } from '../src/types.js'
import { attributeRole, claimsBySession, listRoleCards, maskAllows, roleMaskDecision, toolAllowList } from '../src/domain/roles.js'
import { callOf } from '../src/interface/tools.js'
import { readChildFaces } from '../src/domain/dispatchFace.js'
import {
  inspectTestingSourceOnDisk,
  knownFromStore,
  validateTestingClass,
  validateTestingSet,
  validateTestingSource,
  writeValidatedTestingSet,
  writeValidatedTestingSource,
} from '../src/domain/testingShapes.js'
import type { TestingShapeIssueCode, TestingShapeKnown, TestingShapeReport, TestingSourceFileKind } from '../src/domain/testingShapes.js'
import type { TestingSourceEntry } from '../src/domain/testingShapes.js'
import { sourceFingerprintOf } from '../src/domain/testingStore.js'
// **TASK-035 落点二/六**：形状层与**判定层**用同一份夹具 —— 判定侧的出口就是这两个模块，
// 这里只 import 出口函数，不 import 判定逻辑（口径仍只有一处）。
import { assessCoverageFromStore, describeCoverage } from '../src/domain/coverage.js'
import { assessRegression, describeRegression } from '../src/domain/regression.js'
import type { ChangeSet, RegressionRunInput } from '../src/domain/regression.js'
import type { TraceEdge } from '../src/domain/trace.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm31')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

const baseTask = {
  id: 'TASK-001', title: 't', goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['artifact'] as EvidenceItem['kind'][],
  blockedBy: [], writeScopes: ['src/'], role: 'developer', size: 'small' as const, status: 'ready' as TaskStatus, requirements: [], revision: 1, evidence: [],
  createdAt: '', updatedAt: '',
}

function writeCard(id: string, role: string, status = 'ready'): void {
  store.writeYaml(['tasks', `${id}.yml`], {
    task: {
      id, title: `${id} 的标题`, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['artifact'],
      blockedBy: [], writeScopes: [`src/${id}/`], role, size: 'small', status, requirements: [],
      ...(status === 'in-progress' ? { owner: 'dev-a' } : {}), revision: 1, evidence: [],
    },
  })
}

test('M31-01 B5 角色推导四态：认领过的卡 → 卡上的角色；根会话 → 驾驶舱；未认领子会话 → 非驾驶舱；无会话 → fail-open', () => {
  const claims = [{ sessionId: 's-dev', cardId: 'TASK-001', role: 'developer' }]
  // **R-1（2026-10-05 真机）**：身份由血缘决定 —— 只有**子会话**才按认领卡的角色走掩码；
  // 根会话（父会话 + 流程官）即使认领过 developer 卡也仍是驾驶舱（真机症状：掩码开始拦它自己的工具）。
  assert.deepEqual(attributeRole({ sessionId: 's-dev', delegationDepth: 1, claims }), { kind: 'dispatched', role: 'developer', cardId: 'TASK-001' })
  assert.deepEqual(attributeRole({ sessionId: 's-dev', claims }), { kind: 'cockpit', role: 'cockpit' }, '没有血缘信息 ⇒ 按根会话（驾驶舱）')
  assert.deepEqual(attributeRole({ sessionId: 's-root', delegationDepth: 0, claims }) /*ROOT*/, { kind: 'cockpit', role: 'cockpit' })
  assert.deepEqual(attributeRole({ sessionId: 's-child', delegationDepth: 1, claims }), { kind: 'unclaimed-child', role: 'dispatched' })
  assert.deepEqual(attributeRole({ sessionId: undefined, claims }), { kind: 'unknown', role: 'cockpit' })
  assert.deepEqual(attributeRole({ sessionId: '', claims }), { kind: 'unknown', role: 'cockpit' })
  // 卡上的 role 不是八个角色之一（真源被手改坏）→ 不施加掩码，但**不**当成驾驶舱
  assert.deepEqual(attributeRole({ sessionId: 's-bad', delegationDepth: 1, claims: [{ sessionId: 's-bad', cardId: 'TASK-009', role: 'wizard' }] }),
    { kind: 'unclaimed-child', role: 'dispatched' })
  // 同一会话多次认领 → 取最后一次
  assert.deepEqual(
    attributeRole({ sessionId: 's-dev', delegationDepth: 1, claims: [...claims, { sessionId: 's-dev', cardId: 'TASK-002', role: 'tester' }] }),
    { kind: 'dispatched', role: 'tester', cardId: 'TASK-002' },
  )
})

test('M31-02 B5 claimsBySession 从真源推：认领事件 + 卡上的角色（换会话/换卡都对）', () => {
  writeCard('TASK-001', 'developer')
  writeCard('TASK-002', 'tester')
  claim(store, journal, { taskId: 'TASK-001', owner: 'dev-a', sessionId: 's-dev', expectedRevision: 1 })
  claim(store, journal, { taskId: 'TASK-002', owner: 'dev-b', sessionId: 's-tester', expectedRevision: 1 })
  const claims = claimsBySession(store, journal).sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  assert.deepEqual(claims, [
    { sessionId: 's-dev', cardId: 'TASK-001', role: 'developer' },
    { sessionId: 's-tester', cardId: 'TASK-002', role: 'tester' },
  ])
  // 反向：没有认领事件的会话不出现在表里（也就不会被误判成某个角色）
  assert.equal(claims.some((item) => item.sessionId === 's-nobody'), false)
})

test('M31-03 B6 掩码判定：allow 里放行、deny 与"没列出的"一律拒绝；驾驶舱/未知角色不拦', () => {
  for (const card of listRoleCards()) {
    for (const tool of card.allow) {
      assert.deepEqual(roleMaskDecision(card.code, tool), { kind: 'allow' }, `${card.code} 的 allow 成员 ${tool} 必须放行`)
    }
    for (const tool of card.deny) {
      assert.equal(roleMaskDecision(card.code, tool).kind, 'deny', `${card.code} 的 deny 成员 ${tool} 必须拦`)
    }
    // **两层语义**：SDO 流程面白名单（没列出的 sdo_* 也拒），通用面黑名单（没列出的宿主工具继承默认）
    assert.equal(roleMaskDecision(card.code, 'sdo_不存在的工具').kind, 'deny', 'SDO 流程面：没列出的 sdo_* 也拒绝')
    assert.deepEqual(roleMaskDecision(card.code, 'some-host-tool'), { kind: 'allow' }, '通用面：没列出的宿主工具继承默认')
  }
  for (const role of ['cockpit', '', 'wizard', 'dispatched']) {
    assert.deepEqual(roleMaskDecision(role, '任意工具'), { kind: 'allow' }, `${role} 不应被掩码拦（fail-open）`)
  }
  // deny 的结果要能点名（供回执组织文案）
  const denied = roleMaskDecision('developer', 'sdo_gate')
  assert.deepEqual(denied, { kind: 'deny', role: 'developer', tool: 'sdo_gate' })
})

test('M31-04 B6 两个方向：每个角色**协议必需**的工具必须在掩码内；越界工具必须在外', () => {
  // 协议必需（角色卡「我实际要走的动作」里要用的）：漏一个角色就干不了活
  const needed: Record<string, string[]> = {
    analyst: ['skill', 'sdo_requirement', 'sdo_project', 'sdo_trace', 'ask_user_question', 'sdo_task'],
    'red-team': ['skill', 'sdo_redteam', 'sdo_requirement', 'sdo_task'],
    architect: ['skill', 'sdo_design', 'sdo_adr', 'sdo_quality', 'sdo_trace', 'sdo_task'],
    office: ['skill', 'sdo_feasibility', 'sdo_gate', 'sdo_plan', 'sdo_task', 'sdo_risk', 'sdo_redteam', 'sdo_render', 'sdo_deliver'],
    developer: ['skill', 'read', 'write', 'edit', 'bash', 'sdo_task', 'sdo_trace', 'sdo_test'],
    tester: ['skill', 'sdo_test', 'sdo_task', 'sdo_trace'],
    reviewer: ['skill', 'sdo_review', 'sdo_task', 'sdo_trace'],
    delivery: ['skill', 'sdo_deliver', 'sdo_render', 'sdo_trace', 'sdo_task'],
  }
  for (const role of ROLES) {
    for (const tool of needed[role] ?? []) {
      assert.ok(maskAllows(role, tool), `${role} 必须能用 ${tool}（否则按卡也干不了活）`)
      assert.equal(roleMaskDecision(role, tool).kind, 'allow')
    }
  }
  // **F1 的根治性守卫**：`sdo_task` 是协议通道（claim/done/block 全在它上面），
  // 而"派发提示让执行者做什么"与"掩码允许什么"必须一致 —— 直接从提示里**机械推导**，
  // 以后提示里加了新调用、而掩码没跟上，这条就会红（不再靠人工维护 needed 表）。
  for (const role of ROLES) {
    const task = { ...baseTask, role }
    const prompt = buildDispatch({ task, backend: 'inline', owner: 'cockpit', projectName: 'M31' }).prompt
    const mentioned = [...new Set([...prompt.matchAll(/(sdo_[a-z_]+) action=/gu)].map((match) => match[1] as string))]
    assert.ok(mentioned.length > 0, '派发提示里应当出现协议调用')
    for (const tool of mentioned) {
      assert.ok(maskAllows(role, tool), `${role} 的派发协议要用 ${tool}，掩码却不允许（认领即锁死）`)
    }
  }
  assert.ok(ROLES.every((role) => maskAllows(role, 'sdo_task')), 'sdo_task 必须对 8 个角色都可用')
  // 反向：职责分离类工具必须**不可见**（否则掩码就白设了）。
  // 注意 `edit` **不在**这里：2026-10-08 起 `write` 与 `edit` 同权（独立性由路径级写范围纪律保证，
  // 见 test/m76）——只给 write 不给 edit 并不更安全，只会把改一处逼成整篇重写（SDO-23 真机事故）。
  for (const [role, forbidden] of [
    ['developer', 'sdo_review'], ['developer', 'sdo_gate'], ['tester', 'sdo_review'],
    ['reviewer', 'sdo_design'], ['reviewer', 'write'], ['reviewer', 'edit'], ['reviewer', 'bash'],
    ['analyst', 'sdo_redteam'], ['analyst', 'bash'], ['red-team', 'edit'], ['red-team', 'write'],
    ['architect', 'sdo_gate'], ['delivery', 'sdo_gate'], ['office', 'bash'], ['tester', 'ask_user_question'],
  ] as const) {
    assert.equal(roleMaskDecision(role, forbidden).kind, 'deny', `${role} 不应能调 ${forbidden}`)
  }
  // **同权守卫（防复发）**：`write` 与 `edit` 必须在 **deny 面同进同出**。
  // 注意断言为什么落在 `deny` 上：通用面是**黑名单**语义（2026-10-08 起），`allow` 不再决定
  // 通用工具的可见性 —— 只在 `allow` 里删掉 `edit` 是**没有效果**的（`maskAllows` 仍为 true）。
  for (const card of listRoleCards()) {
    assert.equal(
      card.deny.includes('edit'),
      card.deny.includes('write'),
      `${card.code}：write 与 edit 必须同权（只禁 write 不禁 edit / 反之 = 把改一处逼成整篇重写，SDO-23）`,
    )
    assert.equal(maskAllows(card.code, 'edit'), maskAllows(card.code, 'write'), `${card.code}：结果层也要同权`)
  }
})

test('M31-05 B5/B6 接线：钩子用推导出的角色（不得回退成写死的 cockpit），且掩码开关可关', () => {
  // 这是**接线**断言：纯函数再对，钩子不调用也等于没有（本项目反复出现的"检查存在但够不着"）。
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(source, /attributeRole\(/u, '钩子必须调用 attributeRole')
  assert.match(source, /role: attributed\.role/u, '阶段纪律必须用推导出的角色')
  // **第五批 §3.1（DEF-078）**：判定对象不再写死 `attributed.role` —— 变成"面码"`maskSubject`
  //（认得出的派发角色 / 角色未知那一个），**掩码判定仍是同一条出口**（`roleMaskDecision`）。
  assert.match(source, /roleMaskDecision\(maskSubject, tool, \{ executor: isChildSession \}\)/u, '掩码判定必须用推导出的面码与当次工具（并把"是不是执行者"带上）')
  assert.match(source, /maskSubject[\s\S]{0,240}UNCLAIMED_CHILD_FACE/u, '角色未知（unclaimed-child）必须落**声明给出的最小面**（DEF-078），不得回退成"不施加掩码"')
  assert.match(source, /attributed\.kind === 'unclaimed-child'/u, '钩子必须能认出"未认领的子会话"这一态')
  assert.match(source, /settings\.enforceRoleMask && maskSubject !== undefined/u, '掩码硬拦对"认得出的面码"生效（角色 + 角色未知那一个）')
  assert.doesNotMatch(source, /role: 'cockpit',\n\s+tool: String\(exec\.name/u, '不得再写死 cockpit 传给阶段纪律')
  // 开关真的在配置里（关了就不拦，但声明照旧）
  const config = readFileSync(join(ROOT, 'src', 'config.ts'), 'utf8')
  assert.match(config, /enforceRoleMask: z\.boolean\(\)\.default\(true\)/u, 'enforceRoleMask 默认开')
})

test('M31-06 B5 角色缓存：只在认领/回报后失效（热路径不重读 journal 的保证）', () => {
  const officeSource = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  assert.match(officeSource, /roleCacheVersion = 0/u, '必须有版本号字段')
  const bumps = officeSource.match(/roleCacheVersion \+= 1/gu) ?? []
  assert.ok(bumps.length >= 1, '认领/回报后必须让缓存失效')
  const indexSource = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(indexSource, /roleCacheKey !== cacheKey/u, '钩子必须按版本号判断是否重算')
  const cards = toolAllowList('developer')
  assert.ok(cards.includes('skill'), '工具面里的 skill 是角色卡加载的前提')
})

test('M31-07 F2 回归：归属只在「卡正被该会话做着」期间生效（done/blocked/release/换人 都解除）', () => {
  writeCard('TASK-001', 'developer')
  claim(store, journal, { taskId: 'TASK-001', owner: 'dev-a', sessionId: 's1', expectedRevision: 1 })
  const active = (): unknown => attributeRole({ sessionId: 's1', delegationDepth: 1, claims: claimsBySession(store, journal) })
  assert.deepEqual(active(), { kind: 'dispatched', role: 'developer', cardId: 'TASK-001' }, '进行中 → 认得出角色')

  // ① blocked（做不下去挂起）→ 归属解除，驾驶舱拿回流程工具
  report(store, journal, { taskId: 'TASK-001', owner: 'dev-a', status: 'blocked', note: '缺输入' })
  // **R-1 的契约**：身份由血缘决定 —— 子会话解除归属后是 `unclaimed-child`（**掩码收窄到最小面**，
  // 见 DEF-078：不是"不再拦它"），不会"变成驾驶舱"；驾驶舱也不会因为认领过卡而"变成 developer"。
  assert.deepEqual(active(), { kind: 'unclaimed-child', role: 'dispatched' }, 'blocked 之后归属解除（掩码换成最小面）')
  assert.equal(roleMaskDecision('developer', 'sdo_gate').kind, 'deny')
  assert.deepEqual(roleMaskDecision('cockpit', 'sdo_gate'), { kind: 'allow' }, '驾驶舱必须能推门禁')

  // ② done → 同样解除
  writeCard('TASK-002', 'analyst')
  claim(store, journal, { taskId: 'TASK-002', owner: 'ana-a', sessionId: 's2', expectedRevision: 1 })
  assert.equal(attributeRole({ sessionId: 's2', delegationDepth: 1, claims: claimsBySession(store, journal) }).kind, 'dispatched')
  mkdirSync(join(BASE, 'src', 'TASK-002'), { recursive: true })
  writeFileSync(join(BASE, 'src', 'TASK-002', 'ok.ts'), 'export const ok = 1\n', 'utf8')
  report(store, journal, { taskId: 'TASK-002', owner: 'ana-a', status: 'done', evidence: [
    { kind: 'artifact', detail: 'src/TASK-002/ok.ts', at: 'x' },
  ] })
  assert.deepEqual(attributeRole({ sessionId: 's2', delegationDepth: 1, claims: claimsBySession(store, journal) }),
    { kind: 'unclaimed-child', role: 'dispatched' }, 'done 之后归属解除（掩码换成最小面）')

  // ③ release（显式释放回 ready）→ 解除
  writeCard('TASK-003', 'tester')
  claim(store, journal, { taskId: 'TASK-003', owner: 'dev-b', sessionId: 's3', expectedRevision: 1 })
  release(store, journal, { taskId: 'TASK-003', actor: 'dev-b', reason: '换手' })
  assert.deepEqual(attributeRole({ sessionId: 's3', delegationDepth: 1, claims: claimsBySession(store, journal) }),
    { kind: 'unclaimed-child', role: 'dispatched' }, 'release 之后归属解除（掩码换成最小面）')

  // ④ 被换人（reassign）→ 原会话的归属解除（新 owner 由它自己重新认领）
  writeCard('TASK-004', 'architect')
  claim(store, journal, { taskId: 'TASK-004', owner: 'dev-c', sessionId: 's4', expectedRevision: 1 })
  reassign(store, journal, { taskId: 'TASK-004', actor: 'dev-c', owner: 'dev-d', reason: '换人' })
  assert.deepEqual(attributeRole({ sessionId: 's4', delegationDepth: 1, claims: claimsBySession(store, journal) }),
    { kind: 'unclaimed-child', role: 'dispatched' }, '换人之后原会话不再算作该角色')
})

// —————————————————————— T-4：驱动**真实钩子**，把 B6 的拒绝路径纳入回归 ——————————————————————

/** 真装配（`apply`）并捕获 `tools/pre-execute` 监听器；顺带提供一个"空会话表"的 sessions 服务。 */
function hookHarness(config: Record<string, unknown> = {}): { drive: (name: string, sessionId: string) => Promise<{ kind: string; reason?: string }> } {
  const listeners = new Map<string, (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  const services: Record<string, unknown> = { tools: { register: () => () => {} }, sessions: {} }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: (event: string, listener: never) => { listeners.set(event, listener); return () => {} },
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({ ...config } as unknown as SdoConfig))
  const listener = listeners.get('tools/pre-execute')
  assert.ok(listener !== undefined, '真实装配必须注册 tools/pre-execute 监听器')
  return {
    async drive(name: string, sessionId: string): Promise<{ kind: string; reason?: string }> {
      const exec = { name, arguments: {}, agent: { session: { header: { id: sessionId, cwd: BASE, delegationDepth: sessionId === 's-root' ? 0 : 1 } } } /*HOOK*/ }
      return (await listener(exec, async () => ({ kind: 'allow' }))) as { kind: string; reason?: string }
    },
  }
}

test('M31-08 T-4 真实钩子：认领后的角色调掩码外工具被拒（点名角色/工具/可用面/卡片路径），协议通道与驾驶舱放行', async () => {
  writeCard('TASK-001', 'developer')
  claim(store, journal, { taskId: 'TASK-001', owner: 'dev-a', sessionId: 's1', expectedRevision: 1 })
  const { drive } = hookHarness()

  // ① 掩码外 → 拒绝，且文案要点名四件事
  const denied = await drive('sdo_gate', 's1')
  assert.equal(denied.kind, 'deny', 'developer 调 sdo_gate 必须被拒')
  assert.match(denied.reason ?? '', /developer/u, '要点名角色')
  assert.match(denied.reason ?? '', /sdo_gate/u, '要点名工具')
  assert.match(denied.reason ?? '', /sdo_task/u, '要给出该角色可用工具面')
  assert.match(denied.reason ?? '', /role-developer\.md/u, '要给出角色卡路径')

  // ② 掩码内（协议通道）→ 放行（不能把执行者自己的活也拦掉）
  assert.equal((await drive('sdo_task', 's1')).kind, 'allow', 'sdo_task 是协议通道，必须放行')
  assert.equal((await drive('edit', 's1')).kind, 'allow', 'developer 的写工具必须放行')

  // ③ 驾驶舱（根会话、没认领）→ 不受角色掩码约束
  assert.equal((await drive('sdo_gate', 's-root')).kind, 'allow', '驾驶舱必须能推门禁')

  // ④ 开关关掉 → 只声明不拦
  const off = hookHarness({ enforceRoleMask: false })
  assert.equal((await off.drive('sdo_gate', 's1')).kind, 'allow', 'enforceRoleMask=false 时不拦')
})

test('M31-09 会话 id 的取法：与采集读同一字段，取不到就省略（绝不写 "undefined"）', () => {
  // 评审 2026-10-03 新 minor：`String(agent.id)` 在拿不到 id 时把字面量 "undefined" 写进台账，
  // 污染角色归属（claimsBySession）与 A2 的对账基线（claimBaseline）。
  const shapes: [string, Record<string, unknown>, string | undefined][] = [
    ['agent.id', { id: 's1', session: { header: { cwd: '/w' } } }, 's1'],
    ['只有 session.header.id（真实形态的兜底）', { session: { header: { cwd: '/w', id: 's2' } } }, 's2'],
    ['都没有', { session: { header: { cwd: '/w' } } }, undefined],
    ['空串/空白', { id: '', session: { header: { id: '   ', cwd: '/w' } } }, undefined],
    ['完全空对象', {}, undefined],
  ]
  for (const [label, agent, expected] of shapes) {
    const call = callOf({ agent } as never)
    if (expected === undefined) {
      // 取不到就**不要这个字段**（注意：`String(undefined)` 本身就是字符串 "undefined"，所以只能查字段在不在）
      assert.equal('sessionId' in call, false, `${label} 不该有 sessionId 字段，实际 ${JSON.stringify(call.sessionId)}`)
    } else {
      assert.equal(call.sessionId, expected, `${label} → sessionId 应为 ${expected}，实际 ${String(call.sessionId)}`)
    }
  }

  // 台账层：会话 id 取不到时，`task/claimed` 里**不该有** sessionId 字段（而不是写个假的）
  writeCard('TASK-009', 'developer')
  claim(store, journal, { taskId: 'TASK-009', owner: 'dev-a', expectedRevision: 1 })
  const claimed = journal.read().events.filter((event) => event.type === 'task/claimed' && event.data.id === 'TASK-009').pop()
  assert.ok(claimed !== undefined)
  assert.equal('sessionId' in (claimed.data as Record<string, unknown>), false, '没有会话 id 就不要写这个字段')
  assert.equal(claimsBySession(store, journal).some((item) => item.sessionId === 'undefined'), false, '归属表里不得出现假 id')
  // 假 id 认不出任何卡 ⇒ 不按角色掩码（钩子只对 `kind === 'dispatched'` 施加掩码，所以"不会误拦"照旧成立）。
  // 注意它仍是**子会话**（depth 1）⇒ `unclaimed-child`，而不是"变成驾驶舱"（R-1 的契约：身份看血缘）。
  assert.deepEqual(attributeRole({ sessionId: 'undefined', delegationDepth: 1, claims: claimsBySession(store, journal) }),
    { kind: 'unclaimed-child', role: 'dispatched' }, '拿 "undefined" 当 id 也认不出角色（不会误拦）')

  // 接线：工具层与命令层必须共用同一个取法
  const tools = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  const commands = readFileSync(join(ROOT, 'src', 'interface', 'commands.ts'), 'utf8')
  for (const [name, source] of [['tools.ts', tools], ['commands.ts', commands]] as const) {
    assert.match(source, /sessionIdOf\(agent\)/u, `${name} 必须用共享的 sessionIdOf`)
    assert.doesNotMatch(source, /sessionId: String\(agent\.id\)/u, `${name} 不得再无保护地字符串化 agent.id`)
  }
})

test('M31-10 观测端到端：派发出去的子会话开新请求时，它的真实工具面被记下并按掩码算越界', () => {
  // 真装配 + 捕获 `session/event`；台账里先有一条"派发出去"的记录（role=developer）
  const listeners = new Map<string, (session: unknown, event: unknown) => void>()
  const services: Record<string, unknown> = { tools: { register: () => () => {} }, sessions: {} }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: (event: string, listener: never) => { listeners.set(event, listener); return () => {} },
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const onEvent = listeners.get('session/event')
  assert.ok(onEvent !== undefined, '真实装配必须注册 session/event 监听器')

  writeCard('TASK-010', 'developer')
  journal.append('dispatch/started', { task: 'TASK-010', provider: 'spawn', childSessionId: 'child-9', tools: 3, role: 'developer' })
  const child = { header: { id: 'child-9', cwd: BASE, delegationDepth: 1 } }
  const header = { tools: [{ name: 'read' }, { name: 'edit' }, { name: 'sdo_gate' }] }

  onEvent(child, { type: 'request/header', seq: 5, data: { header } })
  const faces = readChildFaces(store).faces
  assert.equal(faces.length, 1, '要记下这条观测')
  assert.deepEqual(faces[0]?.tools, ['edit', 'read', 'sdo_gate'], '工具面按事实记')
  assert.deepEqual(faces[0]?.violations, ['sdo_gate'], '掩码外工具要点名（developer 没有 sdo_gate）')

  // **执行面**：公告面干净也不能判"没问题" —— 越界调用（模型对未公告工具发起的）要单独记
  onEvent(child, { type: 'tool/call', seq: 9, data: { name: 'sdo_gate' } })
  onEvent(child, { type: 'tool/call', seq: 10, data: { name: 'sdo_gate' } })
  onEvent(child, { type: 'tool/call', seq: 11, data: { name: 'edit' } })
  let after = readChildFaces(store).faces.find((face) => face.childSessionId === 'child-9')
  assert.deepEqual(after?.calls, ['sdo_gate'], '掩码外调用要去重记下；掩码内调用不记')
  assert.equal(after?.callCount, 2, '**次数**要单独记（去重后只有 1 个名字，但发生了 2 次）')
  assert.deepEqual(after?.tools, ['edit', 'read', 'sdo_gate'], '公告面不受执行面影响（两者分开）')

  // 反向：不是我们派发出去的会话 —— 不记；工具面全在掩码内 —— 记但零越界
  onEvent({ header: { id: 'someone-else', cwd: BASE } }, { type: 'request/header', seq: 6, data: { header } })
  assert.equal(readChildFaces(store).faces.length, 1, '与自己无关的会话不记')
  journal.append('dispatch/started', { task: 'TASK-010', provider: 'spawn', childSessionId: 'child-10', tools: 2, role: 'developer' })
  onEvent({ header: { id: 'child-10', cwd: BASE, delegationDepth: 1 } }, { type: 'request/header', seq: 7, data: { header: { tools: [{ name: 'read' }, { name: 'edit' }] } } })
  const all = readChildFaces(store).faces
  assert.equal(all.length, 2)
  assert.deepEqual(all.find((face) => face.childSessionId === 'child-10')?.violations, [], '全在掩码内 → 零越界')
})

// ════════════════════════════════════════════════════════════════════════════════════════
// TASK-012：测试域真源（`.sdo/testing/**` 七类）的**形状校验**与"不落半成品"
//
// DoD 原文：
//   ① 七类真源形状校验落地（profile / plan / design / design-whitebox /
//      acceptance / coverage / regression / report）；
//   ② 非法形状**整次拒绝并点名字段**（不落半成品，不写盘）；
//   ③ 守卫用例覆盖**合法与非法两态**。
//
// 这一组的取向：**每个"拒"都要断言到点名的那条字段与问题码** —— 只断言 `ok === false`
// 的守卫会随着实现一起腐化（判据变严/变松都看不出来）。
// ════════════════════════════════════════════════════════════════════════════════════════

const SHAPES_BASE = join(ROOT, 'node_modules', '.sdo-test', 'm31-shapes')
const SHAPES_SDO = join(SHAPES_BASE, '.sdo')
let shapesStore: SdoStore
let shapesJournal: Journal

function freshShapes(): void {
  rmSync(SHAPES_BASE, { recursive: true, force: true })
  mkdirSync(SHAPES_SDO, { recursive: true })
  shapesStore = new SdoStore(SHAPES_SDO)
  shapesJournal = new Journal(shapesStore)
}

/** 交叉引用登记表：四条需求（含 AC）+ 三条用例。 */
function knownFixtures(): TestingShapeKnown {
  return {
    requirements: new Map<string, string[]>([
      ['REQ-045', ['AC-185', 'AC-186', 'AC-187', 'AC-224', 'AC-225']],
      ['REQ-047', ['AC-191', 'AC-192', 'AC-193']],
      ['REQ-048', ['AC-194', 'AC-195', 'AC-196']],
      ['REQ-057', ['AC-221', 'AC-222', 'AC-223']],
    ]),
    testCaseIds: ['TC-052', 'TC-053', 'TC-101'],
  }
}

function planFixture(): Record<string, unknown> {
  return {
    levels: [
      { id: 'TL-001', level: '单元', entry: '构建通过', exit: '用例全绿且独立评审采纳', traceability: 'req-tc' },
      { id: 'TL-002', level: '集成', entry: '单元出口达成', exit: '契约测试全绿', traceability: 'des-ct' },
    ],
    environment: 'node 20 / 无网络',
    data: '真实台账副本 + 手工夹具',
    regressionScope: ['REQ-045', 'REQ-052'],
    exitCriteria: [
      { id: 'XC-001', criterion: '语句覆盖', metric: 'statement', threshold: '80%', scope: 'src/domain/testing*' },
      { id: 'XC-002', criterion: '变异 kill 率', metric: 'mutation-kill', threshold: '100%', scope: 'critical 卡' },
    ],
    review: { status: 'approved', by: 'user', at: '2026-10-13T00:00:00.000Z' },
  }
}

function profileFixture(): Record<string, unknown> {
  return {
    packages: [
      { id: 'v-model', selected: true, reason: '顺序流程：层级与多级追溯是主线', basis: 'process=waterfall' },
      { id: 'mutation-driven', selected: true, reason: 'critical 档位要求变异自证', basis: 'scale=critical' },
      { id: 'exploratory', selected: false, reason: '本会话未选：只登记、不作通过证据' },
    ],
    scope: 'all',
  }
}

function designFixture(): Record<string, unknown> {
  return {
    artifacts: [
      {
        id: 'BB-001',
        technique: 'equivalence',
        artifact: '有效类 / 无效类各一',
        requirementRef: ['REQ-045'],
        domainSource: 'src/domain/testingShapes.ts:TESTING_METHOD_PACKAGES',
        useCases: ['TC-052'],
      },
      { id: 'BB-002', technique: 'boundary', artifact: '边界点表', na: '本需求无可排序的数值域' },
    ],
  }
}

function whiteboxFixture(): Record<string, unknown> {
  return {
    artifacts: [
      {
        id: 'WB-001',
        technique: 'basis-paths',
        // **TASK-035 落点七**：口径位两层同源后，形状层也核 `criterion`（复用内容层的
        // `canonicalCriterion`）⇒ 合法夹具必须把它写全，否则形状层与内容层会各说各话。
        criterion: 'path',
        artifact: '独立路径集',
        function: 'validateTestingSource',
        branch: 'outcome===ok/invalid/unknown',
        useCases: ['TC-052', 'TC-053'],
      },
      { id: 'WB-002', technique: 'def-use', criterion: 'def-use', artifact: '定义-使用对清单', function: 'knownFromStore', variable: 'requirements', useCases: ['TC-101'] },
    ],
  }
}

function acceptanceFixture(): Record<string, unknown> {
  return {
    outline: [
      { id: 'TA-001', requirement: 'REQ-045', ac: 'AC-185', item: '方法包选择落盘且依据可核对', baseline: 'profile.yml 逐包可核对' },
      { id: 'TA-002', requirement: 'REQ-048', ac: 'AC-194', item: '等价类与边界值齐备', baseline: '逐域核对有效类与无效类' },
    ],
  }
}

/** 一条覆盖读数 / 一条回归跑记录的产物哈希（`sha256:<hex>`，与形状层 `hashOf` 认的写法一致）。 */
function sha256Of(relativePath: string): string {
  return `sha256:${createHash('sha256').update(readFileSync(join(BASE, relativePath))).digest('hex')}`
}

/**
 * **覆盖读数夹具的唯一一份真源**（TASK-035 落点二）：形状层与判定层**共用它** ——
 * 两侧的期望都从这一份推出来，不许各写一份（各写一份正是"口径分叉"的温床）。
 *
 * · `path`   —— **新口径**：`artifact` 写**产物路径**、`artifactHash` 写**产物哈希**；
 * · `legacy` —— **旧口径**（历史写法）：`artifact` 里直接写哈希、`artifactHash` 缺省。
 */
function coverageReadingsFixture(form: 'path' | 'legacy'): Record<string, unknown>[] {
  const artifact = sha256Of('artifacts/m31-widget.txt')
  return [
    {
      id: 'COV-001',
      criterion: 'statement',
      threshold: '80%',
      measured: '91%',
      command: 'node --test lib/test/m31.test.js',
      report: 'reports/m31-coverage.txt',
      reportHash: sha256Of('reports/m31-coverage.txt'),
      ...(form === 'path'
        ? { artifact: 'artifacts/m31-widget.txt', artifactHash: artifact }
        : { artifact, artifactHash: '' }),
    },
  ]
}

/** 覆盖读数夹具要配的未覆盖项（两个形态共用：这一项与"两个位"无关）。 */
function coverageUncoveredFixture(): Record<string, unknown>[] {
  return [{ id: 'UN-001', item: 'sourceFingerprintOf 的排序分支', disposition: '补用例', useCase: 'TC-052' }]
}

function coverageFixture(): Record<string, unknown> {
  return {
    readings: [
      {
        id: 'COV-001',
        criterion: 'statement',
        measured: '91%',
        threshold: '80%',
        command: 'node --test',
        report: 'node_modules/.sdo-test/cov.json',
        reportHash: `sha256:${'d'.repeat(64)}`,
        // **TASK-035 落点一**：新口径 = `artifact` 写**路径**、`artifactHash` 写**哈希**。
        artifact: 'node_modules/.sdo-test/cov.json',
        artifactHash: `sha256:${'a'.repeat(64)}`,
      },
    ],
    uncovered: [
      { id: 'UN-001', item: 'renderStale 的 missing 分支', disposition: '补用例', useCase: 'TC-101' },
      { id: 'UN-002', item: 'sourceFingerprintOf 的排序分支', disposition: '不可达', reason: '排序键是路径字面量，取值域只有一种顺序' },
    ],
  }
}

/**
 * 一条回归跑记录的**唯一一份真源**（TASK-035 落点六）：形状层与判定层共用。
 *
 * 新口径与 `regression.ts` / TASK-019 的 `RegressionRunInput` 对齐：`artifact` 写**产物哈希**、
 * 新补的 `artifactPath` 写**产物路径**（与落点一的 coverage 口径同一原则：路径归路径位、哈希归哈希位）。
 */
function regressionCasesFixture(form: 'both' | 'no-path' | 'no-hash'): Record<string, unknown>[] {
  const artifact = sha256Of('artifacts/m31-reg.txt')
  return [
    {
      case: 'TC-052',
      result: 'pass',
      command: 'node --test lib/test/m31.test.js',
      ...(form === 'no-hash' ? {} : { artifact }),
      ...(form === 'no-path' ? {} : { artifactPath: 'artifacts/m31-reg.txt' }),
    },
  ]
}

/** 回归判定侧的输入：一条 `REQ-049 → TC-052` 的边 + 以这条需求为种子的变更集（影响集可推导）。 */
const REGRESSION_EDGES: TraceEdge[] = [{ from: 'REQ-049', to: 'TC-052', kind: 'req-tc' }]
const REGRESSION_CHANGE_SET: ChangeSet = {
  items: [{ id: 'REQ-049', file: '', from: 'session-TASK-035' }],
  sources: { changes: 0, defects: 0, workspaceFiles: 0 },
  rawFileCount: 0,
}

function regressionFixture(): Record<string, unknown> {
  return {
    impact: ['DES-031', 'TC-052'],
    cases: [{ case: 'TC-052', result: 'pass', artifact: `sha256:${'b'.repeat(64)}`, artifactPath: 'lib/test/m31.test.js', command: 'node --test lib/test/m31.test.js' }],
  }
}

function reportFixture(): Record<string, unknown> {
  return {
    exitCriteria: [
      { id: 'XC-001', criterion: '语句覆盖', threshold: '80%', measured: '91%', verdict: 'pass' },
      { id: 'XC-002', criterion: '变异 kill 率', threshold: '100%', measured: '80%', verdict: 'fail' },
    ],
    coverage: [
      { id: 'COV-001', criterion: 'statement', measured: '91%', threshold: '80%', command: 'node --test', report: 'cov.json', reportHash: `sha256:${'d'.repeat(64)}`, artifact: 'cov.json', artifactHash: `sha256:${'a'.repeat(64)}` },
    ],
    uncovered: [{ id: 'UN-001', item: '缺 lack 分支', disposition: '补用例', useCase: 'TC-101' }],
    mutation: {
      killRate: '80%',
      threshold: '100%',
      record: '.sdo/construction/tdd.yml',
      survived: [
        { id: 'MU-003', disposition: '补用例', useCase: 'TC-101' },
        { id: 'MU-004', disposition: '等价', reason: '与已覆盖的边界分支语义等价' },
      ],
    },
    residualRisks: ['未覆盖分支 UN-001 尚未重算'],
    escapes: [{ id: 'DEF-007', title: '逃逸：真源改了但旧渲染仍被当证据' }],
    signature: { status: 'pending', by: '', at: '', waiver: '' },
  }
}

/** 七类 / 八文件的一份**合法**真源（逐个真源类都能单独拿出来校验）。 */
function validSet(): TestingSourceEntry[] {
  return [
    { class: 'profile', file: 'profile', value: profileFixture() },
    { class: 'plan', file: 'plan', value: planFixture() },
    { class: 'design', file: 'design', value: designFixture() },
    { class: 'design', file: 'design-whitebox', value: whiteboxFixture() },
    { class: 'acceptance', file: 'acceptance', value: acceptanceFixture() },
    { class: 'coverage', file: 'coverage', value: coverageFixture() },
    { class: 'regression', file: 'regression', value: regressionFixture() },
    { class: 'report', file: 'report', value: reportFixture() },
  ]
}

/** 断言"拒了，而且点名了这条字段 + 这个问题码"。 */
function expectIssue(report: TestingShapeReport, field: string, code: TestingShapeIssueCode): void {
  const hit = report.issues.find((issue) => issue.field === field && issue.code === code)
  assert.ok(
    hit !== undefined,
    `要点名「${field}」的「${code}」；实际问题：${report.issues.map((issue) => `${issue.field}[${issue.code}]`).join(' ') || '（无）'}`,
  )
  assert.ok(hit.path.startsWith('.sdo/testing/'), `问题要指出是哪份真源：${hit.path}`)
  assert.ok(hit.message.length > 8, `问题说明要可执行：${hit.message}`)
}

test('M31-11 TASK-012 合法态：七类 / 八个文件全部通过形状校验，且校验面覆盖到每个文件', () => {
  const report = validateTestingSet(validSet(), knownFixtures())
  assert.equal(report.outcome, 'ok', `合法真源不该被拒：${report.issues.map((issue) => `${issue.field}[${issue.code}]`).join(' ')}`)
  assert.deepEqual(report.issues, [])
  assert.equal(report.scope, 'set')

  // 七个类各自也要能过（design 一类的"类校验"要把两个文件都算进来）
  assert.equal(validateTestingClass('design', { design: designFixture(), 'design-whitebox': whiteboxFixture() }, knownFixtures()).outcome, 'ok')
  for (const entry of validSet()) {
    assert.equal(validateTestingSource(entry.file, entry.value, knownFixtures()).outcome, 'ok', `${entry.file} 应判合法`)
  }
  assert.deepEqual(
    report.checked,
    ['.sdo/testing/profile.yml', '.sdo/testing/plan.yml', '.sdo/testing/design.yml', '.sdo/testing/design-whitebox.yml', '.sdo/testing/acceptance.yml', '.sdo/testing/coverage.yml', '.sdo/testing/regression.yml', '.sdo/testing/report.yml'],
    '校验面必须覆盖到八个文件（少一个就是"没校验却当过了"）',
  )
})

test('M31-12 TASK-012 非法态（计划）：顶点字段逐个点名 —— 条目缺项 / 编号重复 / 阈值缺失 / 枚举超界 / 时间格式', () => {
  const bad = {
    levels: [
      { id: 'TL-001', level: '单元', traceability: 'req-xx' },
      { id: 'TL-001', level: '集成', entry: 'e', exit: 'x', traceability: 'no-such-edge' },
    ],
    exitCriteria: [
      { id: 'XC-001', criterion: '语句覆盖', metric: 'statement' },
      { id: 'not-an-id', criterion: '', threshold: '' },
    ],
    review: { status: '批准了', by: 'user', at: '昨天' },
  }
  const report = validateTestingSet([{ class: 'plan', file: 'plan', value: bad }], knownFixtures())
  assert.equal(report.outcome, 'invalid')

  expectIssue(report, 'levels[0].entry', 'missing')
  expectIssue(report, 'levels[0].exit', 'missing')
  expectIssue(report, 'levels[0].traceability', 'enum')
  expectIssue(report, 'levels[1].id', 'dup')
  expectIssue(report, 'levels[1].traceability', 'enum')
  expectIssue(report, 'exitCriteria[0].threshold', 'missing')
  expectIssue(report, 'exitCriteria[1].id', 'format')
  // 空串与"键没写"是两个码：`empty`（写了但是空）/ `missing`（根本没这个键）——
  // 回执要能区分"没写"与"写了空"，否则用户不知道该补键还是补值
  expectIssue(report, 'exitCriteria[1].criterion', 'empty')
  expectIssue(report, 'exitCriteria[1].threshold', 'empty')
  expectIssue(report, 'review.status', 'enum')
  expectIssue(report, 'review.at', 'format')
  // 一次报全：不是"修一个再跑一次"
  assert.ok(report.issues.length >= 10, `问题要一次报全：实际 ${report.issues.length} 条`)
})

test('M31-13 TASK-012 非法态（方法包）：selected 不猜 yes/no，未选中的包也必须有理由', () => {
  const report = validateTestingSet(
    [
      {
        class: 'profile',
        file: 'profile',
        value: {
          packages: [
            { id: 'v-model', selected: 'yes', reason: '想选' },
            { id: 'risk-based', selected: false },
            { id: 'not-a-package', selected: true, reason: 'r', basis: 'b' },
          ],
        },
      },
    ],
    knownFixtures(),
  )
  assert.equal(report.outcome, 'invalid')
  expectIssue(report, 'packages[0].selected', 'type')
  expectIssue(report, 'packages[1].reason', 'missing')
  expectIssue(report, 'packages[2].id', 'enum')

  // 反例方向：全不选 = 没有测试方法论（不许"空表≈通过"）
  const noneSelected = validateTestingSet([
    { class: 'profile', file: 'profile', value: { packages: [{ id: 'v-model', selected: false, reason: '不选' }] } },
  ])
  assert.equal(noneSelected.outcome, 'invalid')
  expectIssue(noneSelected, 'packages', 'empty')

  // 合法态：未选中但有理由 + 至少一个选中 → 通过
  assert.equal(
    validateTestingSet([
      {
        class: 'profile',
        file: 'profile',
        value: { packages: [{ id: 'v-model', selected: true, reason: 'r', basis: 'b' }, { id: 'exploratory', selected: false, reason: '只登记' }] },
      },
    ]).outcome,
    'ok',
  )
})

test('M31-14 TASK-012 非法态（黑盒 / 白盒）：必产项缺件、用例反向引用为空、结构元素出处缺失', () => {
  const blackbox = validateTestingSet(
    [
      {
        class: 'design',
        file: 'design',
        value: {
          artifacts: [
            { id: 'BB-001', technique: 'equivalence', artifact: '有效类/无效类', useCases: [] },
            { id: 'BB-002', technique: 'not-a-technique', artifact: 'x', useCases: ['TC-052'] },
          ],
        },
      },
    ],
    knownFixtures(),
  )
  assert.equal(blackbox.outcome, 'invalid')
  expectIssue(blackbox, 'artifacts[0].useCases', 'empty')
  expectIssue(blackbox, 'artifacts[1].technique', 'enum')

  const whitebox = validateTestingSet(
    [
      {
        class: 'design',
        file: 'design-whitebox',
        value: {
          artifacts: [
            { id: 'WB-001', technique: 'basis-paths', artifact: '独立路径集', useCases: ['TC-052'] },
            { id: 'WB-002', technique: 'def-use', artifact: '定义-使用对', function: 'f', variable: 'v' },
          ],
        },
      },
    ],
    knownFixtures(),
  )
  assert.equal(whitebox.outcome, 'invalid')
  // 结构元素出处缺失 → 点名 function（不许计入覆盖）
  expectIssue(whitebox, 'artifacts[0].function', 'missing')
  expectIssue(whitebox, 'artifacts[1].useCases', 'empty')
})

test('M31-15 TASK-012 非法态（验收大纲 / 覆盖 / 回归 / 报告）：一条 AC 只许一个验收项、读数要有数、结果要绑产物哈希', () => {
  // 验收大纲：AC 重复 + AC 不属于该需求（交叉核对）
  const acceptance = validateTestingSet(
    [
      {
        class: 'acceptance',
        file: 'acceptance',
        value: {
          outline: [
            { id: 'TA-001', requirement: 'REQ-045', ac: 'AC-185', item: 'i', baseline: 'b' },
            { id: 'TA-002', requirement: 'REQ-047', ac: 'AC-185', item: 'i', baseline: 'b' },
            { id: 'TA-003', requirement: 'REQ-047', ac: 'AC-999', item: 'i', baseline: 'b' },
          ],
        },
      },
    ],
    knownFixtures(),
  )
  assert.equal(acceptance.outcome, 'invalid')
  expectIssue(acceptance, 'outline[1].ac', 'dup')
  expectIssue(acceptance, 'outline[2].ac', 'ref')

  // 覆盖：只有数字没有报告不算证据；处置必须三选一且不可达要给理由
  const coverage = validateTestingSet(
    [
      {
        class: 'coverage',
        file: 'coverage',
        value: {
          readings: [{ id: 'COV-001', criterion: 'nonsense', measured: '还不错' }],
          uncovered: [
            { id: 'UN-001', item: 'x', disposition: '懒得管' },
            { id: 'UN-002', item: 'y', disposition: '不可达' },
          ],
        },
      },
    ],
    knownFixtures(),
  )
  assert.equal(coverage.outcome, 'invalid')
  expectIssue(coverage, 'readings[0].criterion', 'enum')
  expectIssue(coverage, 'readings[0].measured', 'format')
  expectIssue(coverage, 'uncovered[0].disposition', 'enum')
  expectIssue(coverage, 'uncovered[1].reason', 'missing')

  // 回归：结果枚举 + 必须绑产物哈希；影响面为空又不声明"不可推导"要判红
  const regression = validateTestingSet(
    [
      {
        class: 'regression',
        file: 'regression',
        value: { cases: [{ case: 'TC-052', result: '大概过了' }] },
      },
      {
        class: 'regression',
        file: 'regression',
        value: { impact: [], cases: [] },
      },
    ],
    knownFixtures(),
  )
  assert.equal(regression.outcome, 'invalid')
  expectIssue(regression, 'cases[0].result', 'enum')
  // **TASK-035 落点六**：两个位**缺任一个**都要判红并点名 —— `artifact`（哈希）与 `artifactPath`（路径）。
  expectIssue(regression, 'cases[0].artifact', 'missing')
  expectIssue(regression, 'cases[0].artifactPath', 'missing')
  expectIssue(regression, 'impact', 'missing')

  // 报告：准则要"实测 + 结论"成对；存活变异体必须逐条处置
  const report = validateTestingSet(
    [
      {
        class: 'report',
        file: 'report',
        value: {
          exitCriteria: [{ id: 'XC-001', criterion: '语句覆盖', measured: '91%', verdict: '差不多达标' }],
          mutation: { killRate: '八成', survived: [{ id: 'MU-001' }, { id: 'MU-002', disposition: '等价' }] },
          residualRisks: [''],
        },
      },
    ],
    knownFixtures(),
  )
  assert.equal(report.outcome, 'invalid')
  expectIssue(report, 'exitCriteria[0].verdict', 'enum')
  expectIssue(report, 'mutation.killRate', 'format')
  expectIssue(report, 'mutation.survived[0].disposition', 'missing')
  expectIssue(report, 'mutation.survived[1].reason', 'missing')
  expectIssue(report, 'residualRisks[0]', 'empty')
})

test('M31-16 TASK-012 非法态（形状本身）：少写一对 []、根是标量、空对象 —— 都不许静默通过', () => {
  const scalarList = validateTestingSet([{ class: 'plan', file: 'plan', value: { levels: '单元', exitCriteria: [] } }])
  assert.equal(scalarList.outcome, 'invalid')
  expectIssue(scalarList, 'levels', 'type')
  expectIssue(scalarList, 'exitCriteria', 'empty')

  const scalarRoot = validateTestingSet([{ class: 'plan', file: 'plan', value: 'plan: 单元' }])
  assert.equal(scalarRoot.outcome, 'invalid')
  expectIssue(scalarRoot, '', 'type')

  // 键缺失 ⇒ missing；键在但为空数组 ⇒ empty（两态都要能观察到）
  const emptyRoot = validateTestingSet([{ class: 'design', file: 'design', value: {} }])
  assert.equal(emptyRoot.outcome, 'invalid')
  expectIssue(emptyRoot, 'artifacts', 'missing')
  const emptyArtifacts = validateTestingSet([{ class: 'design', file: 'design', value: { artifacts: [] } }])
  assert.equal(emptyArtifacts.outcome, 'invalid')
  expectIssue(emptyArtifacts, 'artifacts', 'empty')

  // 该文件没有实现校验器时 **fail-closed**（`unknown` 也不是 ok）
  const unknown = validateTestingSource('not-a-file' as TestingSourceFileKind, {})
  assert.equal(unknown.outcome, 'unknown')
  expectIssue(unknown, '', 'unknown')
})

test('M31-17 TASK-012 "不落半成品"：整组里任一文件非法 ⇒ 一个字节都不写、也不留事件', () => {
  freshShapes()
  // 先写一份**合法**的真源作为底：随后被拒的整组不许碰到它
  const before = writeValidatedTestingSet(shapesStore, [{ class: 'plan', file: 'plan', value: planFixture() }], {
    journal: shapesJournal,
    known: knownFixtures(),
  })
  assert.equal(before.ok, true)
  const planPath = join(SHAPES_SDO, 'testing', 'plan.yml')
  const bytesBefore = readFileSync(planPath, 'utf8')
  const eventsBefore = shapesJournal.read().events.length

  // 整组里 profile 合法、plan 非法（缺 exit）⇒ 整次拒绝
  const broken = planFixture() as Record<string, unknown>
  broken.levels = [{ id: 'TL-001', level: '单元' }]
  const bad = writeValidatedTestingSet(
    shapesStore,
    [
      { class: 'profile', file: 'profile', value: profileFixture() },
      { class: 'plan', file: 'plan', value: broken },
    ],
    { journal: shapesJournal, known: knownFixtures() },
  )
  assert.equal(bad.ok, false)
  assert.equal(bad.written, undefined)
  assert.equal(bad.report.outcome, 'invalid')
  // ① 合法的那份 profile **不许**被写下去（半成品）
  assert.equal(existsSync(join(SHAPES_SDO, 'testing', 'profile.yml')), false, '整组被拒时不许落任何文件')
  // ② 盘上原有的 plan.yml 一个字节都没动
  assert.equal(readFileSync(planPath, 'utf8'), bytesBefore, '被拒的写入不许改到盘上已有的真源')
  // ③ 也不许留"写过了"的事件
  assert.equal(shapesJournal.read().events.length, eventsBefore, '被拒的写入不许留事件')

  // 反例方向：同一组把 plan 修好 ⇒ 两份都写下去（证明上面拒的是形状，不是"永远拒"）
  const fixed = writeValidatedTestingSet(
    shapesStore,
    [
      { class: 'profile', file: 'profile', value: profileFixture() },
      { class: 'plan', file: 'plan', value: planFixture() },
    ],
    { journal: shapesJournal, known: knownFixtures() },
  )
  assert.equal(fixed.ok, true)
  assert.equal(existsSync(join(SHAPES_SDO, 'testing', 'profile.yml')), true)
  assert.deepEqual(fixed.written?.paths, ['testing/profile.yml', 'testing/plan.yml'])
  assert.equal(shapesJournal.read().events.length, eventsBefore + 1, '一组建一条事件（不是每文件一条）')
  const event = shapesJournal.read().events.at(-1)
  assert.equal(event?.type, 'truth/file-written')
  assert.deepEqual(event?.data.files, ['profile', 'plan'])
})

test('M31-18 TASK-012 单文件闸门 + 交叉引用登记表：结构与盘上真源对得上（含 knownFromStore）', () => {
  freshShapes()
  // 单文件闸门：合法就写；非法就不写
  const okWrite = writeValidatedTestingSource(shapesStore, { class: 'coverage', file: 'coverage', value: coverageFixture() }, {
    journal: shapesJournal,
    known: knownFixtures(),
  })
  assert.equal(okWrite.ok, true)
  assert.equal(okWrite.written?.paths.length, 1)
  assert.deepEqual(okWrite.written?.fingerprints?.coverage, sourceFingerprintOf(shapesStore, 'coverage'))

  // 非法：结论写成人话（枚举超界）⇒ 拒且不写盘。
  // 注意"形状层面可选"不等于"乱写也行"：threshold/coverage/uncovered 可以缺，但给了就必须是声明的形状。
  const refused = writeValidatedTestingSource(
    shapesStore,
    { class: 'report', file: 'report', value: { exitCriteria: [{ id: 'XC-001', criterion: '语句覆盖', measured: '91%', verdict: '差不多达标' }] } },
    { journal: shapesJournal, known: knownFixtures() },
  )
  assert.equal(refused.ok, false)
  expectIssue(refused.report, 'exitCriteria[0].verdict', 'enum')
  assert.equal(existsSync(join(SHAPES_SDO, 'testing', 'report.yml')), false, '被拒的单文件也不许落盘')

  // 盘上体检：与写入的值一致 ⇒ ok；再落一份坏值直接进盘（模拟手改）⇒ 体检判红
  assert.equal(inspectTestingSourceOnDisk(shapesStore, 'coverage', knownFixtures()).outcome, 'ok')
  const coveragePath = join(SHAPES_SDO, 'testing', 'coverage.yml')
  const text = readFileSync(coveragePath, 'utf8')
  writeFileSync(coveragePath, text.replace('measured: 91%', 'measured: 说不清'))
  const inspected = inspectTestingSourceOnDisk(shapesStore, 'coverage', knownFixtures())
  assert.equal(inspected.outcome, 'invalid')
  expectIssue(inspected, 'readings[0].measured', 'format')
  // 体检**不写盘**（只读）：坏值还在盘上，等流程官决定怎么处置
  assert.match(readFileSync(coveragePath, 'utf8'), /说不清/u)

  // 交叉引用登记表：从真源需求文件建表，AC 挂错需求要点名
  shapesStore.writeYaml(['requirements', 'REQ-045.yml'], {
    requirement: { id: 'REQ-045', acceptance: [{ id: 'AC-185' }, { id: 'AC-186' }] },
  })
  shapesStore.writeYaml(['tests', 'TC-052.yml'], { testCase: { id: 'TC-052', title: 't', kind: 'unit', requirement: 'REQ-045', steps: [], expected: 'e', at: '' } })
  const known = knownFromStore(shapesStore)
  assert.deepEqual(known.requirements?.get('REQ-045'), ['AC-185', 'AC-186'])
  assert.deepEqual(known.testCaseIds, ['TC-052'])
  const dangling = validateTestingSet(
    [{ class: 'acceptance', file: 'acceptance', value: { outline: [{ id: 'TA-009', requirement: 'REQ-045', ac: 'AC-186', item: 'i', baseline: 'b' }] } }],
    known,
  )
  assert.equal(dangling.outcome, 'ok', 'AC-186 确实挂在 REQ-045 上 ⇒ 不许判红')
  const wrongAc = validateTestingSet(
    [{ class: 'acceptance', file: 'acceptance', value: { outline: [{ id: 'TA-009', requirement: 'REQ-045', ac: 'AC-999', item: 'i', baseline: 'b' }] } }],
    known,
  )
  assert.equal(wrongAc.outcome, 'invalid')
  expectIssue(wrongAc, 'outline[0].ac', 'ref')
})

/**
 * **TASK-035 落点一 / 落点二**：读数的两个位（`artifact` 写路径、`artifactHash` 写哈希）。
 *
 * 两件事各自要能证伪，而且**不许各写一份期望**（卡上原文：同一组夹具既过形状层又过判定层）：
 *   · 新口径 —— 形状闸门收下，判定侧（`coverage.ts`）判**可用**；
 *   · 旧口径 —— 形状闸门收下"写法"（不许因为写法把人拦死），但判定侧**不许算可用**并点名到
 *     `readings[0].artifactHash`（TASK-016 的口径就是这样：哈希在手但不知道产物在哪 ⇒ 判不动，
 *     既不假装过期、也不判绿；M35-17 ④ 已把这条口径钉住）。
 *
 * 夹具只有一份（`coverageReadingsFixture` / `coverageUncoveredFixture`），两侧都从它推结论。
 */
test('M31-19 覆盖读数两态：新口径（artifact=路径 + artifactHash=哈希）两侧都收；旧口径判不动并点名字段', () => {
  mkdirSync(join(BASE, 'reports'), { recursive: true })
  mkdirSync(join(BASE, 'artifacts'), { recursive: true })
  writeFileSync(join(BASE, 'reports', 'm31-coverage.txt'), 'statement coverage: 91% (91/100)\n', 'utf8')
  writeFileSync(join(BASE, 'artifacts', 'm31-widget.txt'), 'widget v1\n', 'utf8')

  // ① 新口径：**同一份夹具**既过形状层、又过判定层
  const fresh = { readings: coverageReadingsFixture('path'), uncovered: coverageUncoveredFixture() }
  const shapeOk = validateTestingSource('coverage', fresh, knownFixtures())
  assert.equal(shapeOk.outcome, 'ok', `新口径必须过形状闸门：${shapeOk.issues.map((issue) => `${issue.field}[${issue.code}]`).join(' ')}`)
  store.writeYaml(['testing', 'coverage.yml'], { coverage: fresh })
  const judged = assessCoverageFromStore(store, BASE, ['TC-052'])
  assert.equal(judged.readings.length, 1, '空集合不许算通过（判据的前提是"有读数"）')
  assert.equal(judged.outcome, 'ok', `过了形状闸门的同一份夹具必须可用：${describeCoverage(judged)}`)

  // ② 旧口径（`artifact` 写哈希、没有 `artifactHash`）：形状层收下写法，判定层**判不动**并点名
  const legacy = { readings: coverageReadingsFixture('legacy'), uncovered: coverageUncoveredFixture() }
  assert.equal(
    validateTestingSource('coverage', legacy, knownFixtures()).outcome,
    'ok',
    '历史写法是**合法写法**：形状层只核"哪个位写什么"，不替判定层拒绝一条意思正确的读数',
  )
  store.writeYaml(['testing', 'coverage.yml'], { coverage: legacy })
  const legacyJudged = assessCoverageFromStore(store, BASE, ['TC-052'])
  assert.notEqual(legacyJudged.outcome, 'ok', `旧口径不许算可用：${describeCoverage(legacyJudged)}`)
  assert.equal(legacyJudged.readings[0]?.outcome, 'unknown', '旧口径是"判不动"（哈希在手、产物路径不明），不是"过期"')
  assert.deepEqual(
    (legacyJudged.readings[0]?.issues ?? []).map((issue) => `${issue.field}[${issue.code}]`),
    ['readings[0].artifactHash[artifact-hash-missing]'],
    '判不动必须**点名到那一个字段**（否则人不知道该补什么）',
  )

  // ③ 两个**新形状位**真的被核：写法非法 ⇒ 形状层判红并点到那一位（不是"不报"也不是"报在别的字段"）
  const badArtifactHash = { readings: [{ ...coverageReadingsFixture('path')[0], artifactHash: 'not-a-hash' }], uncovered: [] }
  expectIssue(validateTestingSource('coverage', badArtifactHash, knownFixtures()), 'readings[0].artifactHash', 'format')
  const badReportHash = { readings: [{ ...coverageReadingsFixture('path')[0], reportHash: 'not-a-hash' }], uncovered: [] }
  expectIssue(validateTestingSource('coverage', badReportHash, knownFixtures()), 'readings[0].reportHash', 'format')
})

/**
 * **TASK-035 落点六**：回归跑记录的两个位（`artifact` 写哈希、`artifactPath` 写路径）。
 *
 * 与落点一同一条原则（路径归路径位、哈希归哈希位），落地到**各自判定侧已有的口径**：
 * `regression.ts` / TASK-019 的 `RegressionRunInput` 把路径位叫 `artifactPath`。
 * 两态：两位齐备 ⇒ 形状层可用 + 判定层可用；**缺任一位** ⇒ 两侧都判红、且点在**同一个字段名**上。
 */
test('M31-20 回归集两态：artifact=哈希 + artifactPath=路径 才可用；缺任一位两侧都点名同一位', () => {
  mkdirSync(join(BASE, 'artifacts'), { recursive: true })
  writeFileSync(join(BASE, 'artifacts', 'm31-reg.txt'), 'reg v1\n', 'utf8')

  const shapeOf = (cases: Record<string, unknown>[]): TestingShapeReport =>
    validateTestingSource('regression', { impact: ['REQ-049', 'TC-052'], cases }, knownFixtures())
  const judgedOf = (cases: Record<string, unknown>[]) =>
    assessRegression({
      workspace: BASE,
      changeSet: REGRESSION_CHANGE_SET,
      // 夹具是**形状层那一份**（`Record<string, unknown>`）：判定侧的入参只多一个类型标注，
      // 不另写一份期望（`RegressionRunInput` 的字段就是 `case / result / artifact / artifactPath / command`）。
      source: { impact: ['REQ-049', 'TC-052'], cases: cases as unknown as RegressionRunInput[] },
      edges: REGRESSION_EDGES,
      knownCaseIds: ['TC-052'],
    })

  // ① 两位齐备 ⇒ 形状层可用、判定层可用（同一份 cases）
  const both = regressionCasesFixture('both')
  assert.equal(shapeOf(both).outcome, 'ok', `两位齐备必须过形状闸门：${shapeOf(both).issues.map((issue) => `${issue.field}[${issue.code}]`).join(' ')}`)
  const judgedBoth = judgedOf(both)
  assert.equal(judgedBoth.outcome, 'ok', `两位齐备必须可用（哈希对得上盘上那版产物）：${describeRegression(judgedBoth)}`)
  assert.equal(judgedBoth.cases[0]?.artifactPath, 'artifacts/m31-reg.txt', '判定结论里要带上产物路径（点名过期产物靠它）')

  // ② 缺 `artifactPath`（只记了哈希）⇒ 两侧都判红，且**都点到 `cases[0].artifactPath`**
  const noPath = regressionCasesFixture('no-path')
  expectIssue(shapeOf(noPath), 'cases[0].artifactPath', 'missing')
  const judgedNoPath = judgedOf(noPath)
  assert.equal(judgedNoPath.outcome, 'incomplete', `只记哈希不记路径 ⇒ 判不动，不许声称完成：${describeRegression(judgedNoPath)}`)
  assert.equal(judgedNoPath.cases[0]?.outcome, 'unbound')
  assert.deepEqual(judgedNoPath.cases[0]?.issues.map((issue) => issue.field), ['cases[0].artifactPath'], '判定侧点名的字段要与形状层同一位')

  // ③ 缺 `artifact`（只记了路径）⇒ 两侧都判红，且**都点到 `cases[0].artifact`**
  const noHash = regressionCasesFixture('no-hash')
  expectIssue(shapeOf(noHash), 'cases[0].artifact', 'missing')
  const judgedNoHash = judgedOf(noHash)
  assert.equal(judgedNoHash.outcome, 'incomplete', `没绑产物哈希 ⇒ 判不动：${describeRegression(judgedNoHash)}`)
  assert.equal(judgedNoHash.cases[0]?.outcome, 'unbound')
  assert.deepEqual(judgedNoHash.cases[0]?.issues.map((issue) => issue.field), ['cases[0].artifact'], '判定侧点名的字段要与形状层同一位')
})
