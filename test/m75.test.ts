/**
 * **增量 75：角色掩码的两层口径（2026-10-08 用户发现的真机缺陷）。**
 *
 * 症状（用户转述子代理原话）：**「无法使用 `technique_apply`」**。
 * 机械核对（该子会话的 `request/header` 公告面）：`bash edit glob grep read read_image sdo_task
 * sdo_test sdo_trace skill write` —— **只有角色声明的十几个名字**，宿主/harness 的整个通用面
 * （`technique_apply` / `memory_*` / `web_search` / `todo_write` / `subagent` …）**一个都没有**。
 *
 * 根因：`toolFilter` 一直是按 **allow 白名单**下发的（`{allow: 角色的十几个名字, deny}`），
 * 而宿主的 `tools.restrict({allow})` 语义是"**只保留**这些" ⇒ 通用面被一起清空。
 * 掩码**本意**只是"SDO 流程面按角色分权"（developer 不许 `sdo_gate`、reviewer 不许 `sdo_test`），
 * 那是一个**我们完全掌握**的封闭集合；通用面该用**黑名单**（`roles.yml` 的 `deny`）×继承宿主默认。
 *
 * 本用例把**两层**都钉住：
 *   · SDO 流程面 = 白名单（补集进 deny）；
 *   · 通用面 = 黑名单（缺省继承；只有 `deny` 明写的才挡）；
 *   · 真实 `tools/pre-execute` 钩子对 `technique_apply` 放行、对 `sdo_gate` 照旧拒绝；
 *   · 下发给宿主的 payload **只含 deny**（`allow` 一填就把通用面挡掉 —— 这就是本缺陷本身）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { Config } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { claim } from '../src/domain/collab.js'
import { ROLES } from '../src/domain/plan.js'
import { EXECUTOR_DENIED_TOOLS, EXECUTOR_FORBIDDEN_TOOLS, READ_ONLY_INSPECTION_TOOLS, listRoleCards, maskAllows, maskConflicts, roleMaskDecision, sdoAllowList, toolDenyList } from '../src/domain/roles.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { buildDispatch } from '../src/integration/orchestrator.js'
import { startDispatch } from '../src/integration/dispatch.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm75')

/** 本插件真实注册的 `sdo_*` 工具（与 `src/interface/tools.ts` 的注册表一致；新增工具要同步这里）。 */
const SDO_TOOLS = [
  'sdo_init', 'sdo_status', 'sdo_feasibility', 'sdo_project', 'sdo_gate', 'sdo_plan', 'sdo_task',
  'sdo_risk', 'sdo_cost', 'sdo_render', 'sdo_trace', 'sdo_deliver', 'sdo_redteam', 'sdo_requirement',
  'sdo_design', 'sdo_adr', 'sdo_quality', 'sdo_review', 'sdo_test', 'sdo_lang',
]

/** 通用面里"谁都该有"的代表（真机缺的就是这一类）。 */
const GENERAL_TOOLS = ['technique_apply', 'memory_search', 'memory_save', 'web_search', 'todo_write', 'present']

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

function card(id: string, role: string): TaskCard {
  return {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['artifact'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: role as TaskCard['role'], size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
}

function writeCard(task: TaskCard, status: TaskCard['status'] = 'ready'): void {
  store.writeYaml(['tasks', `${task.id}.yml`], { task: { ...task, status } })
}

function hookHarness(): { drive: (name: string, sessionId: string) => Promise<{ kind: string; reason?: string }> } {
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
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const listener = listeners.get('tools/pre-execute')
  assert.ok(listener !== undefined, '真实装配必须注册 tools/pre-execute 监听器')
  return {
    async drive(name: string, sessionId: string): Promise<{ kind: string; reason?: string }> {
      const exec = { name, arguments: {}, agent: { session: { header: { id: sessionId, cwd: BASE, delegationDepth: 1 } } } }
      return (await listener(exec, async () => ({ kind: 'allow' }))) as { kind: string; reason?: string }
    },
  }
}

test('M75-01 通用面缺省继承：每个角色都能留下技能/记忆（真机原话「无法使用 technique_apply」）', () => {
  for (const role of ROLES) {
    for (const tool of GENERAL_TOOLS) {
      assert.equal(maskAllows(role, tool), true, `${role} 不该被掩码挡掉通用工具 ${tool}（这正是真机缺陷）`)
    }
    // **执行者禁令是"上下文相关"的**：同一个角色，作为**被派发的执行者**不许起新的 agent 运行；
    // 而驾驶舱（非执行者）仍要能派发 —— 否则流程官被自己的角色归属锁死。
    for (const tool of EXECUTOR_FORBIDDEN_TOOLS) {
      assert.equal(maskAllows(role, tool, { executor: true }), false, `${role} 作为执行者不得调用 ${tool}`)
    }
    // 反向：通用面的**硬禁止**仍然咬人（谁能写、谁能跑 bash 逐角色写清）
    if (['reviewer', 'red-team'].includes(role)) {
      assert.equal(maskAllows(role, 'write'), false, `${role} 不许写`)
      assert.equal(maskAllows(role, 'bash'), false, `${role} 不许跑 bash`)
    }
  }
})

test('M75-02 SDO 流程面仍是白名单：补集全部进 deny 面（职责分离一条都不能少）', () => {
  for (const role of ROLES) {
    const allow = sdoAllowList(role, SDO_TOOLS)
    const deny = toolDenyList(role, SDO_TOOLS)
    for (const tool of SDO_TOOLS) {
      const allowed = allow.includes(tool)
      assert.equal(maskAllows(role, tool), allowed, `${role} 对 ${tool} 的判定必须与 sdoAllowList 一致`)
      // 补集必须**都在** deny 里：漏一个 = 那个流程工具对所有角色开放（静默越权）
      if (!allowed) assert.ok(deny.includes(tool), `${role} 的 deny 面必须含不可用的 ${tool}`)
      // 例外：**执行者禁令**里的工具即使在该角色的 allow 里，也必须进 deny 面（子会话不许再派发）
      const executorForbidden = (EXECUTOR_FORBIDDEN_TOOLS as readonly string[]).includes(tool)
      if (allowed && !executorForbidden) assert.equal(deny.includes(tool), false, `${role} 的 deny 面不许挡它自己的 ${tool}`)
      if (executorForbidden) assert.ok(deny.includes(tool), `执行者禁令：${tool} 必须进 deny 面（${role}）`)
    }
  }
  // 非执行者（驾驶舱）不受"执行者禁令"约束：`office` 声明的 `sdo_plan` 仍然可用
  assert.equal(maskAllows('office', 'sdo_plan'), true, '非执行者仍可派发（驾驶舱的职权）')
  assert.equal(maskAllows('office', 'sdo_plan', { executor: true }), false, '执行者不行')
  // 抽查真机关心的那几条职责分离
  assert.equal(maskAllows('developer', 'sdo_gate'), false, 'developer 不许改门禁')
  assert.equal(maskAllows('developer', 'sdo_review'), false, 'developer 不许自评')
  assert.equal(maskAllows('tester', 'sdo_review'), false, 'tester 不许评审')
  assert.equal(maskAllows('reviewer', 'sdo_test'), false, 'reviewer 不许跑测试（那是 tester 的活）')
  assert.equal(maskAllows('delivery', 'sdo_design'), false)
  // `sdo_lang` 不在任何角色的 allow 里 ⇒ 所有角色都拿不到（它属驾驶舱配置面）
  for (const role of ROLES) assert.equal(maskAllows(role, 'sdo_lang'), false)
})

test('M75-03 角色认不出 ⇒ SDO 流程面**整体**挡住（fail-closed，不是"全放行"）', () => {
  const deny = toolDenyList('wizard' as never, SDO_TOOLS)
  for (const tool of SDO_TOOLS) assert.ok(deny.includes(tool), `认不出角色时 ${tool} 必须被挡`)
  assert.equal(maskAllows('wizard' as never, 'sdo_gate'), false)
  // `maskAllows` 对认不出的角色是**整体拒绝**（防御性）；真正决定"能不能干活"的是钩子那条路，
  // 它对认不出的会话 **fail-open**（见 `test/m31.test.ts` 的 M31-03），两者不冲突。
  assert.equal(maskAllows('wizard' as never, 'technique_apply'), false, 'maskAllows 自身保持 fail-closed')
  // 但**下发面**不能因此变成"全放行"：deny 面必须把整个 SDO 流程面列出来
  assert.equal(deny.includes('technique_apply'), false, '通用工具不该进 deny 面')
})

test('M75-04 buildDispatch：deny 面 = 角色 deny ∪ SDO 补集；SDO 白名单只含本角色的', () => {
  const task = card('TASK-001', 'developer')
  const request = buildDispatch({ task, backend: 'subagent', owner: 'o', projectName: 'P', sdoNames: SDO_TOOLS })
  assert.ok(request.toolDeny.includes('sdo_gate'), 'developer 的 deny 面必须含 sdo_gate')
  assert.ok(request.toolDeny.includes('technique_apply') === false, '通用工具不许进 deny 面（否则又回到白名单的老毛病）')
  for (const tool of GENERAL_TOOLS) {
    assert.equal(request.toolDeny.includes(tool), false, `${tool} 不该被 deny`)
  }
  // `ask_user_question` 是**用户裁定只给 analyst** 的通用工具 ⇒ 其他角色必须在 deny 面里
  assert.ok(request.toolDeny.includes('ask_user_question'), 'developer 不该能直接问用户（仅 analyst 有）')
  // **执行者禁令**：子代理不得再起一个 agent 运行（它起的子代理不带掩码 ⇒ 绕开整张掩码表）
  for (const tool of EXECUTOR_FORBIDDEN_TOOLS) {
    assert.ok(request.toolDeny.includes(tool), `执行者禁令：${tool} 必须在 deny 面里`)
  }
  // SDO 白名单：只有本角色声明的 sdo_*
  assert.deepEqual([...request.sdoAllow].sort(), ['sdo_task', 'sdo_test', 'sdo_trace'])
  // 逐个角色：SDO 白名单 ⊆ allow，且**补集必须都在 deny 面**（漏一个 = 那个流程工具对该角色开放）
  for (const role of ROLES) {
    const per = buildDispatch({ task: { ...task, role: role as TaskCard['role'] }, backend: 'subagent', owner: 'o', projectName: 'P', sdoNames: SDO_TOOLS })
    assert.deepEqual([...per.sdoAllow].sort(), sdoAllowList(role, SDO_TOOLS).sort(), `${role} 的 SDO 白名单要与掩码表一致`)
    assert.ok(per.toolDeny.length > 0, `${role} 的 deny 面不该为空（否则掩码没生效）`)
    for (const tool of SDO_TOOLS) {
      if (per.sdoAllow.includes(tool)) continue
      assert.ok(per.toolDeny.includes(tool), `${role} 的 deny 面必须含不可用的 ${tool}（P5：不接真实注册名就会漏）`)
    }
  }
  // 反向：`sdoNames` 为空时只能挡 `roles.yml` 的 deny —— 那**不够**（`sdo_status` 之类没人挡）
  const noNames = buildDispatch({ task, backend: 'subagent', owner: 'o', projectName: 'P', sdoNames: [] })
  assert.equal(noNames.toolDeny.includes('sdo_status'), false, '前置：不传注册名时补集算不出来')
})

test('M75-05 下发宿主的 payload：**只发 deny**，不发 allow（真机缺陷就是 allow 把通用面清了）', async () => {
  const task = card('TASK-001', 'developer')
  const request = buildDispatch({ task, backend: 'subagent', owner: 'o', projectName: 'P', sdoNames: SDO_TOOLS })
  const calls: { name: string; request: Record<string, unknown> }[] = []
  const runtime = {
    list: () => ['spawn'],
    getProvider: () => ({ name: 'spawn', capabilities: { toolFilter: true } }),
    start: async (name: string, payload: unknown) => {
      calls.push({ name, request: payload as Record<string, unknown> })
      return { id: 'child-1' }
    },
  }
  const outcome = await startDispatch({ runtime, provider: 'spawn', agent: { id: 'parent' }, request, deny: request.toolDeny, maxDepth: 1 })
  assert.equal(outcome.started, true)
  const sent = calls[0]?.request.toolFilter as { allow?: unknown; deny: string[] }
  assert.equal(sent.allow, undefined, '**不许**下发 allow（那会把宿主/harness 的通用面一起隐藏）')
  assert.ok(sent.deny.includes('sdo_gate'), 'deny 面要真的下发')
  assert.equal(sent.deny.includes('technique_apply'), false, '通用工具不许进 deny')

  // **另一条分支**也要钉：`startContinuable`（可续聊）——只钉一条分支等于给另一条留后门
  const contCalls: Record<string, unknown>[] = []
  const contRuntime = {
    list: () => ['spawn'],
    getProvider: () => ({ name: 'spawn', capabilities: { toolFilter: true } }),
    // 宿主服务探测要求 `start` 存在（真实宿主两者都有）；真正被走到的分支是 `startContinuable`
    start: async () => { throw new Error('不该走到 one-shot 分支') },
    startContinuable: async (payload: unknown) => {
      contCalls.push(payload as Record<string, unknown>)
      return { childId: 'child-cont' }
    },
  }
  const cont = await startDispatch({ runtime: contRuntime, provider: 'spawn', agent: { id: 'parent' }, request, deny: request.toolDeny, maxDepth: 1 })
  assert.equal(cont.started, true)
  const contSent = (contCalls[0]?.request as { toolFilter: { allow?: unknown; deny: string[] } }).toolFilter
  assert.equal(contSent.allow, undefined, 'startContinuable 分支同样只发 deny')
  assert.ok(contSent.deny.includes('sdo_gate'))
  // 回执必须说清两层（否则读的人以为通用面也被清了）
  const { describeDispatchStarted, maskPlaneLine } = await import('../src/interface/describe.js')
  const text = describeDispatchStarted(request, 'spawn', 'child-1', sent.deny, true)
  assert.match(text, /SDO 流程面/u)
  assert.match(text, /继承宿主默认/u, '通用面要说清是继承宿主默认')
  // 单独钉"工具面那两行"本身（P6 变异：把它换回别的键时，别的行会替它把话说圆）
  const plane = maskPlaneLine(request)
  assert.match(plane, /SDO 流程面/u, `工具面那行必须点名 SDO 流程面：${plane}`)
  assert.match(plane, /deny/u, '并说明通用面走 deny 黑名单（否则读的人以为通用面也被清了）')
  assert.match(plane, /sdo_task/u, '要把本角色可用的 sdo_* 列出来')
})

test('M75-06 真实钩子：已认领 developer 调 `technique_apply` 放行、调 `sdo_gate` 照旧拒绝', async () => {
  // 两张卡、两条认领**先做完**（钩子只认"已经落在台账里的认领"）
  writeCard(card('TASK-001', 'developer'))
  writeCard(card('TASK-002', 'reviewer'))
  const devClaim = claim(store, journal, { taskId: 'TASK-001', owner: 'dev-a', sessionId: 's-dev', expectedRevision: 1 })
  const revClaim = claim(store, journal, { taskId: 'TASK-002', owner: 'rev-a', sessionId: 's-rev', expectedRevision: 1 })
  assert.equal(devClaim.ok, true, '前置：developer 认领必须成功')
  assert.equal(revClaim.ok, true, `前置：reviewer 认领必须成功（否则这条用例根本没测到掩码）：${JSON.stringify(revClaim)}`)
  const { drive } = hookHarness()

  for (const tool of ['technique_apply', 'memory_search', 'web_search', 'todo_write']) {
    assert.equal((await drive(tool, 's-dev')).kind, 'allow', `子代理必须能用 ${tool}（真机缺陷：它报"无法使用 technique_apply"）`)
  }
  // **执行者禁令**：子代理不得起新的 agent 运行（那样派出的子代理不带掩码 ⇒ 绕开整张掩码表）
  for (const tool of EXECUTOR_FORBIDDEN_TOOLS) {
    const deniedForbidden = await drive(tool, 's-dev')
    assert.equal(deniedForbidden.kind, 'deny', `子代理不得调用 ${tool}（2026-10-08 用户裁定）`)
    assert.match(deniedForbidden.reason ?? '', /执行者|掩码/u, `拒绝要讲清原因：${deniedForbidden.reason}`)
  }
  // **驾驶舱例外**：根会话（depth 0）即使认领了卡仍是流程官 —— 派发是它的本职，不能被自己的角色归属锁死
  for (const tool of ['subagent', 'sdo_plan', 'sdo_gate']) {
    assert.equal((await drive(tool, 'cockpit-root')).kind, 'allow', `驾驶舱必须能 ${tool}（否则流程推不动）`)
  }
  const denied = await drive('sdo_gate', 's-dev')
  assert.equal(denied.kind, 'deny', '流程面的职责分离仍然咬人')
  assert.match(denied.reason ?? '', /developer/u)
  // reviewer 的写禁令也仍然咬人（通用面黑名单不是"整体放行"）
  assert.equal((await drive('technique_apply', 's-rev')).kind, 'allow', 'reviewer 也要能留技能（通用面继承）')
  assert.equal((await drive('write', 's-rev')).kind, 'deny', 'reviewer 不许写')
  assert.equal((await drive('sdo_test', 's-rev')).kind, 'deny', 'reviewer 不许跑测试')
})

test('M75-07 断言"角色卡里承诺的工具"确实可用（提示面 ↔ 掩码面同源）', () => {
  // 角色卡模板里承诺过"我有 skill 取角色卡"；`sdo-role-cards` 是 skill → 通用面 ⇒ 必须可用
  for (const role of ROLES) {
    assert.equal(maskAllows(role, 'skill'), true, `${role} 要能加载角色卡（提示里承诺了）`)
  }
  // 派发提示里的协议通道 `sdo_task` 必须每个角色都有（否则"认领即锁死"）
  // ——与 `test/m31.test.ts` 的机械推导互补：这里按"提示里真的写了"再钉一次
  // 派发提示在 orchestrator 里拼（不是 index.ts）
  const orchestration = readFileSync(join(ROOT, 'src', 'integration', 'orchestrator.ts'), 'utf8')
  assert.match(orchestration, /sdo_task action=claim/u, '派发提示要走 sdo_task 认领')
  for (const role of ROLES) {
    assert.equal(maskAllows(role, 'sdo_task'), true, `${role} 的掩码必须含协议通道 sdo_task`)
  }
  // **SDO 工具清单不许与真实注册表漂移**：注册名发生增减时，这条会红
  const toolsSource = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  for (const name of SDO_TOOLS) {
    assert.match(toolsSource, new RegExp(`name: '${name}'`, 'u'), `清单里的 ${name} 必须真的注册（否则 deny 面会让宿主 restrict() 抛错）`)
  }
})

test('M75-08 `ask_user_question` 只给 analyst（用户裁定），其余角色一律没有', () => {
  for (const role of ROLES) {
    const allowed = maskAllows(role, 'ask_user_question')
    assert.equal(allowed, role === 'analyst', `${role} 对 ask_user_question 的可见性不符合"仅 analyst"`)
    assert.equal(roleMaskDecision(role, 'ask_user_question').kind, allowed ? 'allow' : 'deny')
  }
  // 驾驶舱（root）仍能问用户：它不是角色子代理，`roleMaskDecision` 对它 fail-open
  assert.deepEqual(roleMaskDecision('cockpit', 'ask_user_question'), { kind: 'allow' })
  // 真源侧：只有 analyst 的 allow 有它，其余角色的 deny 都必须写它（改 roles.yml 才是改真源）
  const cards = listRoleCards()
  const analyst = cards.find((card) => card.code === 'analyst')
  assert.ok(analyst?.allow.includes('ask_user_question'), 'analyst 的 allow 必须有 ask_user_question')
  assert.equal(analyst?.deny.includes('ask_user_question'), false, 'analyst 的 deny 不许同时挡它（自相矛盾）')
  for (const card of cards.filter((item) => item.code !== 'analyst')) {
    assert.ok(card.deny.includes('ask_user_question'), `${card.code} 的 deny 必须显式写 ask_user_question`)
  }
  // 无自相矛盾（deny ∩ allow = ∅）
  assert.deepEqual(maskConflicts(), [])
})

// ————————————————— 全面审计：宿主工具面必须**逐个分类**（防"又一个 ask_user_question"） —————————————————

/**
 * **宿主/harness 的工具面快照**（对 `cordis_inspect_query(host, Tool, listTools)` 的实测结果 +
 * `presets/sdo-office.patch.yml` 挂载行 + `roles.yml` 引用名三者取并集）。
 *
 * 为什么要这张表：通用面改成**黑名单**语义之后，**凡是没人声明过的宿主工具都会自动落到每个执行者手里**。
 * `ask_user_question` 就是这么"漏"的（它只在 analyst 的 allow 里，没人写 deny）。要防的不是某一个工具，
 * 而是**这一类**：宿主每加一个工具，都必须有人**显式决定**它属于下面哪一桶。
 * —— 所以下面 `classify()` 要求**每个名字恰好落进一个桶**，落不进任何桶 ⇒ 用例红，逼你回来看一眼。
 */
const HOST_TOOL_FACE = [
  // 平台 / 会话 / 目标 / 插件管理
  'plugin_manager', 'cordis_inspect_list', 'cordis_inspect_query',
  'get_goal', 'create_goal', 'update_goal', 'exit_plan_mode', 'present',
  // agent 面
  'subagent', 'subagent_fork', 'workflow', 'send_message', 'interrupt_agent', 'list_agents',
  // 文件 / 执行 / 技能
  'read', 'write', 'edit', 'glob', 'grep', 'read_image', 'bash', 'skill',
  // 记忆 / 技能库 / 失败库
  'memory_search', 'memory_save', 'memory_forget', 'memory_stats',
  'technique_search', 'technique_get', 'technique_save', 'technique_apply', 'technique_export',
  'technique_learn', 'technique_forget', 'failure_list', 'failure_resolve', 'failure_forgive',
  // 网络 / 交互 / 待办
  'web_search', 'web_fetch', 'ask_user_question', 'todo_write',
]

/**
 * **有意对所有角色开放**的宿主工具（每个都写理由）。
 *
 * 注意：`write`/`edit`/`bash`/`ask_user_question` **不在这里** —— 它们是**按角色分权**的
 * （有人 allow、其余人 deny），由下面那条"泄露检测"直接核对分权是否完整。
 */
const INTENTIONALLY_OPEN_TO_ALL: Record<string, string> = {
  'cordis_inspect_list': '只读检视宿主/provider 目录',
  'cordis_inspect_query': '只读检视（不能改运行时）',
  'get_goal': '只读当前会话目标',
  'present': '把交付物挂给用户看（delivery 角色正需要）',
  'send_message': '起不了新运行；目标被宿主限死在直接子代理/父会话',
  'interrupt_agent': '同上；执行者没有自己的子代理 ⇒ 实为空操作',
  'list_agents': '同上；列出的是「你自己起的子代理」',
  'memory_search': '只读记忆',
  'memory_save': '沉淀长期事实（用户点名要保留的能力）',
  'memory_stats': '只读统计',
  'technique_search': '只读技能库',
  'technique_get': '只读技能库',
  'technique_save': '沉淀可复用技术（用户点名要保留）',
  'technique_apply': '上报采用证据（真机缺陷就是它被挡掉了）',
  'technique_export': '把已验证技术导出为 SKILL.md（产出技能，不破坏）',
  'technique_learn': '从代码库学技术（扫描，不删除）',
  'failure_list': '只读失败库',
  'failure_resolve': '把已根治的失败标记为已解决（建设性记录）',
  'web_search': '查资料',
  'web_fetch': '读资料',
  'todo_write': '本地待办（进程内展示）',
  'read': '只读基础面（也是 READ_ONLY_INSPECTION_TOOLS）',
  'grep': '只读基础面',
  'glob': '只读基础面',
  'read_image': '只读基础面',
  'skill': '加载角色卡（派发协议第 0 步就要用）',
}

test('M75-09 审计守卫：宿主工具面逐个归类，且**按角色分权的那些必须分权完整**（防"又一个 ask_user_question"）', () => {
  const cards = listRoleCards()
  const readOnly = new Set<string>(READ_ONLY_INSPECTION_TOOLS)
  const denied = new Set<string>(EXECUTOR_DENIED_TOOLS)
  const reviewedOpen = new Set(Object.keys(INTENTIONALLY_OPEN_TO_ALL))
  const problems: string[] = []

  for (const tool of HOST_TOOL_FACE) {
    const declaredAnywhere = cards.some((card) => card.allow.includes(tool))
    const covered = readOnly.has(tool) || denied.has(tool) || reviewedOpen.has(tool) || declaredAnywhere
    if (!covered) {
      problems.push(`${tool}：**没有任何归类** —— 新出现的宿主工具必须显式决定它属于哪一桶（只读 / 执行者禁用 / 有意全开 / 按角色分权）`)
      continue
    }
    // 只读 / 执行者禁用 / 有意全开 ⇒ 本来就是"人人可用"，不参与分权核对
    if (readOnly.has(tool) || denied.has(tool) || reviewedOpen.has(tool)) continue
    // **泄露检测**（`ask_user_question` 就是这么漏的）：声明在部分角色的 allow 里，
    // 却没有在**其余角色**的 deny 里写它 ⇒ 黑名单语义下人人都有。
    const leaking = cards.filter((card) => !card.allow.includes(tool) && !card.deny.includes(tool)).map((card) => card.code)
    if (leaking.length > 0) {
      problems.push(`${tool}：只被部分角色声明，却没在 [${leaking.join(',')}] 的 deny 里写它 ⇒ 这些角色会**静默拿到**它（改 roles.yml 才是改真源）`)
    }
  }
  assert.deepEqual(problems, [], `宿主工具面分类/分权有问题：\n${problems.join('\n')}`)

  // 分类要**与实现一致**：被归为 executor-denied 的，必须真的对所有角色执行者拒绝，且进 deny 面
  for (const tool of EXECUTOR_DENIED_TOOLS) {
    for (const role of ROLES) {
      assert.equal(maskAllows(role, tool, { executor: true }), false, `${role} 作为执行者不得调用 ${tool}`)
      assert.ok(toolDenyList(role, SDO_TOOLS).includes(tool), `${tool} 必须进 ${role} 的 deny 面`)
    }
  }
  // 被归为"有意全开"的，必须**真的**对执行者可用（否则那张表在骗人）
  for (const tool of reviewedOpen) {
    assert.equal(maskAllows('developer', tool, { executor: true }), true, `developer 作为执行者应当能用 ${tool}`)
  }
  // 反向：执行者禁用面里不许混进只读基础面（那会让人干不了活）
  for (const tool of EXECUTOR_DENIED_TOOLS) {
    assert.equal(readOnly.has(tool), false, `${tool} 是只读基础面，不该进执行者禁用面`)
  }
})
