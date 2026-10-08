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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  assert.match(source, /roleMaskDecision\(attributed\.role, tool, \{ executor: isChildSession \}\)/u, '掩码判定必须用推导出的角色与当次工具（并把"是不是执行者"带上）')
  assert.match(source, /settings\.enforceRoleMask && attributed\.kind === 'dispatched'/u, '掩码硬拦只对"认得出的派发角色"生效')
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
  // **R-1 的契约**：身份由血缘决定 —— 子会话解除归属后是 `unclaimed-child`（掩码不再拦它），
  // 不会"变成驾驶舱"；驾驶舱也不会因为认领过卡而"变成 developer"。
  assert.deepEqual(active(), { kind: 'unclaimed-child', role: 'dispatched' }, 'blocked 之后归属解除（掩码解除）')
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
    { kind: 'unclaimed-child', role: 'dispatched' }, 'done 之后归属解除（掩码解除）')

  // ③ release（显式释放回 ready）→ 解除
  writeCard('TASK-003', 'tester')
  claim(store, journal, { taskId: 'TASK-003', owner: 'dev-b', sessionId: 's3', expectedRevision: 1 })
  release(store, journal, { taskId: 'TASK-003', actor: 'dev-b', reason: '换手' })
  assert.deepEqual(attributeRole({ sessionId: 's3', delegationDepth: 1, claims: claimsBySession(store, journal) }),
    { kind: 'unclaimed-child', role: 'dispatched' }, 'release 之后归属解除（掩码解除）')

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
