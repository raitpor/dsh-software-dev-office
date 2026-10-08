/**
 * **子代理复用：角色池 + 卡队列**（2026-10-04）。
 *
 * 运维口径（用户原话）：每个角色一个池（各自并行上限）；卡当消息队列 —— 池里有空位就派，
 * **全忙则排队阻塞**，等有子代理结算后把下一张发给空闲者。本轮的投递仍由**驾驶舱触发**
 * （`sdo_plan action=next`），插件不自主起代理。
 *
 * 为什么每个方向都要有反向断言：池是**限制**，限制最容易犯的错是"拦错了"（该派的没派出去）
 * 与"派重了"（同一子代理同时接两张卡）。所以这里逐条钉住：池满只排队不丢卡、busy 的子代理
 * 绝不被复用、one-shot 结算后不算"空闲可复用"、宿主没有可续聊入口时如实说降级。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import { admitDispatch, capOf, foldPoolChildren, isStaleDispatch, rolePools, unresolvedBlock } from '../src/domain/pool.js'

/** SDO-52：夹具统一用的掩码指纹（与 `admitDispatch` 的 `maskHashOf` 对应） */
const MASK = 'mask-x'
import { JOURNAL_FILE } from '../src/infra/journal.js'
import { describePoolBlock } from '../src/interface/describe.js'
import { startDispatch } from '../src/integration/dispatch.js'
import type { PoolEvent } from '../src/domain/pool.js'
import type { Context } from '@deepseek-ai/cordis'
import type { SdoConfig } from '../src/config.js'
import type { DispatchRequest } from '../src/integration/orchestrator.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm36')
let store: SdoStore
let journal: Journal

function freshWorkspace(): void {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
}

beforeEach(freshWorkspace)
afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function card(id: string, role: string): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes: [`src/${id}/`],
    role: role as TaskCard['role'],
    size: 'small',
    revision: 1,
    status: 'ready',
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
  }
}

function started(child: string, task: string, role: string, mode?: string): PoolEvent {
  // **SDO-52**：派发事件要带掩码指纹 —— 没有它（老事件）池会**拒绝复用**并强制新起
  return { type: 'dispatch/started', data: { childSessionId: child, task, role, maskHash: MASK, ...(mode === undefined ? {} : { mode }) }, at: `2026-10-04T10:00:0${child.slice(-1)}Z` }
}

function finished(child: string): PoolEvent {
  return { type: 'dispatch/finished', data: { childSessionId: child, task: '', role: '' }, at: '2026-10-04T10:10:00Z' }
}

test('M36-01 折叠池状态：started=在飞、finished=空闲、复用则轮数累加；老事件没有 mode ⇒ 按 one-shot 读', () => {
  const children = foldPoolChildren([
    started('c1', 'TASK-001', 'developer', 'continuable'),
    started('c2', 'TASK-002', 'developer'), // 老事件：没有 mode 字段
    finished('c1'),
    // 复用同一个子代理接第二张卡
    started('c1', 'TASK-003', 'developer', 'continuable'),
  ])
  assert.equal(children.get('c1')?.state, 'busy', '再次 started 必须回到在飞（不能因为之前结算过就当成空闲）')
  assert.equal(children.get('c1')?.rounds, 2, '轮数要累加（回执要说"这是第几轮"）')
  assert.equal(children.get('c1')?.task, 'TASK-003', '当前承接的卡要更新成最新一张')
  assert.equal(children.get('c1')?.mode, 'continuable')
  assert.equal(children.get('c2')?.mode, 'one-shot', '没有 mode 的老事件按 one-shot（保守：不可复用）')
  assert.equal(children.get('c2')?.state, 'busy')

  // 结算找不到对应 started 的（手写/丢事件）不凭空造孩子
  assert.equal(foldPoolChildren([finished('ghost')]).size, 0, '没有 started 的 finished 不许造出一个幽灵子代理')
  // 幂等：已空闲的孩子再收一条 finished 不重复计数
  const twice = foldPoolChildren([started('c3', 'T', 'developer', 'continuable'), finished('c3'), finished('c3')])
  assert.equal(twice.get('c3')?.rounds, 1)
  assert.equal(twice.get('c3')?.state, 'idle')
})

test('M36-02 池视图：上限取配置（没配的角色用全局上限）、one-shot 结算进 retired 而不是"空闲可复用"、空池也要列出来', () => {
  const pools = rolePools({
    children: [
      { childSessionId: 'c1', role: 'developer', task: 'T1', mode: 'continuable', state: 'busy', rounds: 1, startedAt: '', finishedAt: '' },
      { childSessionId: 'c2', role: 'developer', task: 'T2', mode: 'continuable', state: 'idle', rounds: 1, startedAt: '', finishedAt: '' },
      { childSessionId: 'c3', role: 'developer', task: 'T3', mode: 'one-shot', state: 'idle', rounds: 1, startedAt: '', finishedAt: '' },
      { childSessionId: 'c4', role: 'tester', task: 'T4', mode: 'one-shot', state: 'busy', rounds: 1, startedAt: '', finishedAt: '' },
    ],
    roles: ['developer', 'tester', 'architect'],
    caps: { developer: 3 },
    defaultCap: 4,
  })
  const roles = pools.map((pool) => pool.role)
  assert.deepEqual(roles, ['architect', 'developer', 'tester'], '待派角色即使没有孩子也要列出（"没池"与"池空"必须能分辨）')
  const dev = pools.find((pool) => pool.role === 'developer')
  assert.equal(dev?.cap, 3, '配置里写了的角色用配置上限')
  assert.equal(dev?.busy.length, 1)
  assert.deepEqual(dev?.idle.map((child) => child.childSessionId), ['c2'], '只有 continuable 且已结算的才算空闲可复用')
  assert.equal(dev?.retired, 1, 'one-shot 结算后不可复用 ⇒ 记 retired，不能算进空闲')
  assert.equal(dev?.freeSlots, 1, '可新建位子 = 上限 − 在飞 − 空闲（空闲者本身就是一个位子，不能再新建）')
  const tester = pools.find((pool) => pool.role === 'tester')
  assert.equal(tester?.cap, 4, '没配的角色用全局上限（默认行为不变）')
  assert.equal(tester?.freeSlots, 3, 'tester：1 在飞、无空闲 ⇒ 还剩 3 个新建位子')
  assert.equal(pools.find((pool) => pool.role === 'architect')?.cap, 4)
  assert.equal(capOf({ developer: 2 }, 'developer', 4), 2)
  assert.equal(capOf({ developer: 0 }, 'developer', 4), 4, '非法值（0/<1）退回全局上限，而不是把角色锁死')
})

test('M36-03 准入：池满只排队、不丢卡；空闲可复用就用它（同一子代理被占住，下一次不会再拿到）；busy 的绝不复用', () => {
  const children = [
    { childSessionId: 'c1', role: 'developer', task: 'T0', mode: 'continuable' as const, maskHash: MASK, state: 'busy' as const, rounds: 1, startedAt: '', finishedAt: '' },
    { childSessionId: 'c2', role: 'developer', task: 'T0b', mode: 'continuable' as const, maskHash: MASK, state: 'idle' as const, rounds: 1, startedAt: '', finishedAt: '' },
  ]
  const pools = rolePools({ children, roles: ['developer'], caps: { developer: 2 }, defaultCap: 4 })
  assert.equal(pools[0]?.freeSlots, 0, '上限 2 = 1 在飞 + 1 空闲 ⇒ 没有新建位子（但空闲那个能接卡）')

  // ① 池上限 2 = 1 在飞 + 1 空闲 ⇒ 这一轮只能再派 **1** 张（投给空闲的 c2），其余排队
  const first = admitDispatch({ ready: [card('TASK-001', 'developer'), card('TASK-002', 'developer'), card('TASK-003', 'developer')], pools, globalRoom: 4, reuseIdle: true, maskHashOf: () => MASK })
  assert.equal(first.dispatch.length, 1, '池里只有 1 个可用的位子（空闲的 c2）')
  assert.equal(first.dispatch[0]?.reuseChildId, 'c2', '空闲可复用优先：这一张投给已有子代理（不新建）')
  assert.equal(first.queued.length, 2, '其余**排队**（不丢卡）')
  assert.equal(first.blocked[0]?.reason, 'pool-full')
  assert.match(first.blocked[0]?.detail ?? '', /2\/2/u, '要能读出在飞/上限')

  // ② 同一批池再算一次：c2 已经被占住 ⇒ 这一轮**没有位子**（上限 2、在飞 2），只能排队
  const second = admitDispatch({
    ready: [card('TASK-004', 'developer')],
    pools: first.pools,
    globalRoom: 4,
    reuseIdle: true,
    maskHashOf: () => MASK,
  })
  assert.equal(second.dispatch.length, 0, 'busy（含刚被占住的）绝不出现在复用清单里；位子也已用尽')
  assert.equal(second.queued.length, 1, '没有位子 ⇒ 排队（不丢卡）')
  assert.equal(second.blocked[0]?.reason, 'pool-full')
  assert.match(second.blocked[0]?.detail ?? '', /2\/2/u, '要说清在飞几个/上限几个')

  // ③ 宿主没有可续聊入口 ⇒ 即使有"空闲 continuable"也不投递（reuseIdle=false），池退化为并发上限
  const noReuse = admitDispatch({ ready: [card('TASK-005', 'developer')], pools, globalRoom: 4, reuseIdle: false, maskHashOf: () => MASK })
  assert.equal(noReuse.dispatch.length, 0, '宿主不支持复用时那个空闲子代理**投不进去**（它在 one-shot 语义下已经不在了）')
  assert.equal(noReuse.dispatch[0]?.reuseChildId, undefined, '宿主不支持时不假装复用')
  assert.equal(noReuse.queued.length, 1, '⇒ 只能排队等位子，而不是把池撑爆')
})

test('M36-04 准入：全局预算先挡住（reason=global-budget），且角色池满与预算满要能分辨', () => {
  const pools = rolePools({ children: [], roles: ['developer'], caps: {}, defaultCap: 4 })
  const none = admitDispatch({ ready: [card('TASK-001', 'developer')], pools, globalRoom: 0, reuseIdle: true, maskHashOf: () => MASK })
  assert.equal(none.dispatch.length, 0)
  assert.equal(none.blocked[0]?.reason, 'global-budget', '预算满与池满是两种原因（回执要分得清）')
  const room = admitDispatch({ ready: [card('TASK-001', 'developer'), card('TASK-002', 'developer')], pools, globalRoom: 1, reuseIdle: true, maskHashOf: () => MASK })
  assert.equal(room.dispatch.length, 1, '预算 1 ⇒ 只派一张')
  assert.equal(room.blocked[0]?.reason, 'global-budget')
})

// —————————————————————— 投递层：真复用 / 诚实降级 ——————————————————————

interface FakeCall { kind: string; args: unknown[] }

function fakeRuntime(overrides: Record<string, unknown> = {}): { runtime: Record<string, unknown>; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const base: Record<string, unknown> = {
    list: () => ['spawn'],
    start: async () => ({ id: 'child-new' }),
    startContinuable: async () => ({ childId: 'child-cont', messageId: 'msg-1' }),
    sendMessage: async () => 'msg-2',
    ...overrides,
  }
  // **每一次调用都记账**：覆盖实现只换行为，不绕过记录（否则"没被调用"与"调用被覆盖"分不出来 —— 我先踩过）
  const runtime: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(base)) {
    runtime[key] = typeof value === 'function'
      ? async (...args: unknown[]) => {
          calls.push({ kind: key, args })
          return (value as (...inner: unknown[]) => unknown)(...args)
        }
      : value
  }
  return { runtime, calls }
}

function request(): DispatchRequest {
  return {
    task: card('TASK-001', 'developer'),
    backend: 'subagent',
    owner: 'subagent:developer:1',
    persona: 'sdo-developer',
    toolDeny: ['sdo_gate'],
    sdoAllow: ['sdo_task'],
    prompt: '协议与提示词',
    expectedRevision: 1,
    writeScopes: ['src/TASK-001/'],
  }
}

test('M36-05 真复用：给了空闲子代理就 sendMessage 给它（不再新起），并如实回报 reused/mode', async () => {
  const { runtime, calls } = fakeRuntime()
  const outcome = await startDispatch({
    runtime: runtime as never,
    provider: 'spawn',
    agent: { id: 'cockpit' },
    request: request(),
    deny: [],
    maxDepth: 1,
    reuseChildId: 'child-idle',
  })
  assert.equal(outcome.started, true)
  assert.equal(outcome.started ? outcome.reused : false, true, '复用了已有子代理')
  assert.equal(outcome.started ? outcome.mode : '', 'continuable')
  assert.equal(outcome.started ? outcome.childSessionId : '', 'child-idle', '会话 id 必须还是那个已有子代理（不是新起的）')
  const kinds = calls.map((call) => call.kind).filter((kind) => kind !== 'list')
  assert.deepEqual(kinds, ['sendMessage'], '有可复用目标时**不该**再 start/startContinuable')
  const args = calls.find((call) => call.kind === 'sendMessage')?.args ?? []
  assert.equal((args[0] as { id?: string } | undefined)?.id, 'cockpit', '第一个参数必须是发起 agent（宿主校验"同一个活着的 sender"）')
  assert.equal(args[1], 'child-idle')
  assert.equal((args[3] as { signal?: unknown } | undefined)?.signal !== undefined, true, '必须带上取消信号（宿主 API 要求）')

  // 没有可复用目标 ⇒ 建一个 continuable（这样它结算后才能被复用）
  const fresh = fakeRuntime()
  const created = await startDispatch({ runtime: fresh.runtime as never, provider: 'spawn', agent: { id: 'cockpit' }, request: request(), deny: [], maxDepth: 1 })
  assert.equal(created.started ? created.reused : true, false)
  assert.equal(created.started ? created.mode : '', 'continuable')
  assert.deepEqual(fresh.calls.map((call) => call.kind).filter((kind) => kind !== 'list'), ['startContinuable'])
})

test('M36-06 诚实降级：宿主只有 one-shot / 复用被拒 / 可续聊入口不可用 —— 三条路都照实说，且卡照常派出', async () => {
  // ① 只有 start（老宿主）
  const oneShot = fakeRuntime({ startContinuable: undefined, sendMessage: undefined })
  const outcome = await startDispatch({ runtime: oneShot.runtime as never, provider: 'spawn', agent: { id: 'cockpit' }, request: request(), deny: [], maxDepth: 1 })
  assert.equal(outcome.started ? outcome.mode : '', 'one-shot')
  assert.equal(outcome.started ? outcome.reuseSupported : true, false, '探不到入口时不许宣称可复用')

  // ② 可续聊入口存在但调用失败（真机可能是 CONTINUATION_UNAVAILABLE）⇒ 退回 one-shot 并**记下原因**
  const failing = fakeRuntime({ startContinuable: async () => { throw new Error('continuable subagents require the agents service') } })
  const fell = await startDispatch({ runtime: failing.runtime as never, provider: 'spawn', agent: { id: 'cockpit' }, request: request(), deny: [], maxDepth: 1 })
  assert.equal(fell.started, true, '可续聊入口失败不该让这张卡派不出去')
  assert.equal(fell.started ? fell.mode : '', 'one-shot')
  assert.match(fell.started ? (fell.continuableFailed ?? '') : '', /agents service/u, '失败原因要带回去（回执会写出来）')

  // ③ 复用投递被拒 ⇒ 新起一个，但 reuseFailed 非空（不许静默）
  const refused = fakeRuntime({ sendMessage: async () => { throw new Error('UNAUTHORIZED: message delivery requires the exact live sender agent') } })
  const fallback = await startDispatch({ runtime: refused.runtime as never, provider: 'spawn', agent: { id: 'cockpit' }, request: request(), deny: [], maxDepth: 1, reuseChildId: 'child-idle' })
  assert.equal(fallback.started ? fallback.reused : true, false)
  assert.match(fallback.started ? (fallback.reuseFailed ?? '') : '', /UNAUTHORIZED/u)
  assert.equal(fallback.started ? fallback.mode : '', 'continuable', '退回的是"新起一个可续聊子代理"，不是 one-shot')
  assert.deepEqual(refused.calls.map((call) => call.kind).filter((kind) => kind !== 'list'), ['sendMessage', 'startContinuable'])
})

// —————————————————————— 工具层：池准入真的接线了 ——————————————————————

interface Harness {
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
  calls: FakeCall[]
}

function harness(subagents?: Record<string, unknown>): Harness {
  const registered: { name: string; execute: (args: unknown, exec: unknown) => unknown }[] = []
  const fake = subagents ?? fakeRuntime().runtime
  const services: Record<string, unknown> = {
    tools: { register: (tool: never) => { registered.push(tool as never); return () => {} } },
    sessions: {},
    subagents: fake,
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  const runtimeCalls: FakeCall[] = []
  for (const key of ['start', 'startContinuable', 'sendMessage']) {
    const original = (fake as Record<string, unknown>)[key]
    if (typeof original === 'function') {
      ;(fake as Record<string, unknown>)[key] = async (...args: unknown[]) => {
        runtimeCalls.push({ kind: key, args })
        return (original as (...inner: unknown[]) => unknown)(...args)
      }
    }
  }
  apply(makeCtx() as unknown as Context, Config({ poolCaps: { developer: 1 } } as unknown as SdoConfig))
  const exec = { agent: { id: 'cockpit', session: { header: { cwd: BASE } } } }
  return {
    calls: runtimeCalls,
    callTool: async (name, args) => {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `${name} 必须注册进工具表`)
      return String(await tool.execute(args, exec))
    },
  }
}

test('M36-07 工具层：池上限生效（只派 1 张、另一张排队并说明原因），回执给出池视图，结算后同一子代理可被复用', async () => {
  const h = harness()
  await h.callTool('sdo_init', { name: '池与队列演练', process: 'waterfall', scale: 'normal', stakeholders: '运维' })
  journal.append('phase/entered', { phase: 'construction' })
  for (const id of ['TASK-001', 'TASK-002']) {
    store.writeYaml(['tasks', `${id}.yml`], { task: card(id, 'developer') })
  }

  // ① 池上限 developer=1 ⇒ 只派 1 张，另一张**排队**且说明原因（不丢卡）
  const first = await h.callTool('sdo_plan', { action: 'next', backend: 'subagent', limit: 4 })
  assert.match(first, /TASK-001/u, `要派出第一张：${first.slice(0, 400)}`)
  assert.doesNotMatch(first, /TASK-002.*已派发|TASK-002.*started/u)
  assert.match(first, /角色池（子代理复用/u, '回执要有池视图')
  assert.match(first, /developer：在飞 1\/1/u, `池行要如实：${first.slice(-500)}`)
  assert.match(first, /排队 1 张：TASK-002/u, '被上限挡住的卡要明说排队（否则用户以为流程卡死）')
  assert.equal(h.calls.filter((call) => call.kind === 'startContinuable').length, 1, '第一个窗口新起一个可续聊子代理')

  // ② 再调一次：池上限 1 已满（TASK-001 在飞）⇒ TASK-002 **排队**，且 TASK-001 不重派
  const again = await h.callTool('sdo_plan', { action: 'next', backend: 'subagent', limit: 4 })
  assert.match(again, /TASK-002（developer）排队/u, `池满要明说排队：${again.slice(-600)}`)
  assert.equal(h.calls.filter((call) => call.kind === 'startContinuable').length, 1, '池满期间不许再新建子代理')
  assert.equal(journal.read().events.filter((event) => event.type === 'dispatch/started' && String(event.data.task) === 'TASK-001').length, 1, '在飞的卡不重派（一张卡不许同时在两个子代理里）')

  // ③ 子代理结算 ⇒ 池里出现"空闲可复用"，且 state 由 journal 现算；卡也照真实流程收工
  journal.append('dispatch/finished', { childSessionId: 'child-cont', task: 'TASK-001', role: 'developer', turn: 1, reason: 'completed', report: '' })
  const doneCard = store.readYaml<{ task: TaskCard }>('tasks', 'TASK-001.yml')?.task
  store.writeYaml(['tasks', 'TASK-001.yml'], { task: { ...(doneCard as TaskCard), status: 'done', revision: 3 } })
  const poolOffice = new SoftwareDevOffice(resolveSettings(Config({ poolCaps: { developer: 1 } } as unknown as SdoConfig)))
  const poolCall = { sessionId: 'cockpit', cwd: BASE }
  // **R-1（sdo-test-new 2026-10-08 复测）**：结算 ≠ 可复用 —— 复用要**正面证据**（观测到这个会话手里有工具）。
  // 没观测到时**不许**把它算成"空闲可复用"，而且它**不占池位**（否则 cap=1 的角色永久排队）。
  const beforeObserve = poolOffice.poolView(poolCall).find((pool) => pool.role === 'developer')
  assert.equal(beforeObserve?.idle.length, 0, '没有工具面观测 ⇒ 不得算作可复用')
  assert.equal(beforeObserve?.unusable.length, 1, '不可复用的空闲子代理要单独列出（并说明原因）')
  assert.match(beforeObserve?.unusable[0]?.reason ?? '', /观测/u)
  assert.equal(beforeObserve?.freeSlots, 1, '它**不占池位**：cap=1 也不能因此永久排队')

  // 观测到"它确实有工具"之后，才允许复用
  poolOffice.noteChildFace(poolCall, { childSessionId: 'child-cont', tools: ['read', 'bash', 'sdo_task'], violations: [] })
  const pools = poolOffice.poolView(poolCall)
  const dev = pools.find((pool) => pool.role === 'developer')
  assert.equal(dev?.idle.length, 1, '有工具面观测（且掩码指纹一致）后，结算的子代理才可复用')
  assert.equal(dev?.unusable.length, 0)
  assert.equal(dev?.busy.length, 0)

  // ④ 驾驶舱再触发一次派发：这一张投给**已有**子代理（真复用），不是新起
  const second = await h.callTool('sdo_plan', { action: 'next', backend: 'subagent', limit: 4 })
  assert.equal(h.calls.filter((call) => call.kind === 'sendMessage').length, 1, '复用投递走 sendMessage')
  assert.equal(h.calls.filter((call) => call.kind === 'startContinuable').length, 1, '结算后复用已有子代理 ⇒ 全程只新建过 1 个')
  assert.equal(journal.read().events.filter((event) => event.type === 'dispatch/started' && event.data.reused === true).length, 1)
  assert.equal(journal.read().events.filter((event) => event.type === 'dispatch/started' && String(event.data.task) === 'TASK-002').length, 1, '第二张卡落在了同一个子代理上')
  assert.match(second, /♻️ 复用/u, `回执要如实写复用：${second.slice(-600)}`)
  assert.match(second, /第 2 轮/u, '要说明这是该子代理的第几轮')
  const events = journal.read().events.filter((event) => event.type === 'dispatch/started')
  assert.equal(events.length, 2)
  assert.equal(events[1]?.data.reused, true, '复用要落进台账')
  assert.equal(events[1]?.data.mode, 'continuable')
  assert.equal(String(events[1]?.data.childSessionId), 'child-cont', '第二张卡仍落在同一个子代理上')
})

// —————————————————————— 真机缺陷：僵尸派发把池占满 ——————————————————————

/**
 * 直接往真源（journal.jsonl）追加一条**指定时间**的事件（`journal.append` 只会盖当前时间）。
 *
 * 注意：`journal.read()` 要求 `seq` **严格从 1 连续**，跳号的一行会被当成坏行并**截断整条流**
 * （我第一次写死 seq=900，结果那笔事件对判定完全不可见 —— 用例也就测了个空）。
 */
function rawEvent(at: string, type: string, data: Record<string, unknown>): void {
  const seq = journal.read().events.length + 1
  store.appendLine([JOURNAL_FILE], JSON.stringify({ seq, at, actor: 'sdo', type, data }))
}

test('M36-08 孤儿 TTL：未结算派发超过 TTL 就不再占池位（真机 developer 池被 5 笔跨两天的僵尸占满）', () => {
  const cap = { developer: 2 }
  const old = new Date(Date.now() - 20 * 60 * 60_000).toISOString() // 20 小时前
  const fresh = new Date(Date.now() - 5 * 60_000).toISOString() // 5 分钟前
  const children = [
    { childSessionId: 'zombie', role: 'developer', task: 'T1', mode: 'continuable' as const, maskHash: MASK, state: 'busy' as const, rounds: 1, startedAt: old, finishedAt: '' },
    { childSessionId: 'live', role: 'developer', task: 'T2', mode: 'continuable' as const, maskHash: MASK, state: 'busy' as const, rounds: 1, startedAt: fresh, finishedAt: '' },
    { childSessionId: 'gone', role: 'developer', task: 'T3', mode: 'one-shot' as const, maskHash: MASK, state: 'busy' as const, rounds: 1, startedAt: '', finishedAt: '' },
  ]
  const ttl = 60 * 60_000
  const now = Date.now()
  assert.equal(isStaleDispatch(children[0] as never, now, ttl), true, '超过 TTL 的未结算 = 孤儿')
  assert.equal(isStaleDispatch(children[1] as never, now, ttl), false, 'TTL 之内的未结算照旧算在飞（不误伤长任务）')
  assert.equal(isStaleDispatch(children[2] as never, now, ttl), false, 'startedAt 读不出时间 ⇒ 保守算在飞（宁可占位也不重复派）')
  assert.equal(isStaleDispatch(children[0] as never, now, 0), false, 'TTL 缺省 ⇒ 不做孤儿判定（行为与加特性之前一致）')

  const pools = rolePools({ children, roles: ['developer'], caps: cap, defaultCap: 4, orphanTtlMs: ttl, nowMs: now })
  const dev = pools[0]
  assert.deepEqual(dev?.busy.map((child) => child.childSessionId), ['live', 'gone'], '活着的 + 时间读不出的（保守）都占位')
  assert.deepEqual(dev?.stale.map((child) => child.childSessionId), ['zombie'], '超时的单列 stale')
  assert.deepEqual(dev?.idle, [], '孤儿绝不进"空闲可复用"（不确定它还在不在）')

  // 只放"僵尸 + 活着的"两笔（把时间读不出的那笔拿掉）：修复前僵尸也占位 ⇒ 位子恒为 0
  const twoOnly = rolePools({ children: children.slice(0, 2), roles: ['developer'], caps: cap, defaultCap: 4, orphanTtlMs: ttl, nowMs: now })
  assert.equal(twoOnly[0]?.freeSlots, 1, '上限 2：僵尸不占位 ⇒ 空出 1 个位子（修复前这里恒为 0 ⇒ 永不派发）')
  const admitted = admitDispatch({ ready: [card('TASK-010', 'developer'), card('TASK-011', 'developer')], pools: twoOnly, globalRoom: 4, reuseIdle: true, maskHashOf: () => MASK })
  assert.deepEqual(admitted.dispatch.map((item) => item.task.id), ['TASK-010'], '有 1 个位子 ⇒ 放行 1 张')
  assert.deepEqual(admitted.queued.map((task) => task.id), ['TASK-011'])

  // 回执要如实标注"其中 N 笔未结算超时"，别让它看起来像正常超限
  const block = describePoolBlock(pools, ['TASK-011'], true, 60)
  assert.match(block, /未结算超时 1/u, block)
  assert.match(block, /孤儿 TTL（60 分钟）/u, block)
  assert.match(block, /不占池位/u, block)
})

test('M36-08b 工具层：真机那笔僵尸不再堵死池 —— 超时的 started 之后，池仍能放行并如实标注', async () => {
  const h = harness()
  await h.callTool('sdo_init', { name: '孤儿池演练', process: 'waterfall', scale: 'normal', stakeholders: '运维' })
  journal.append('phase/entered', { phase: 'construction' })
  store.writeYaml(['tasks', 'TASK-020.yml'], { task: card('TASK-020', 'developer') })
  // 真机形态：一笔**20 小时前**开始、从未结算的派发（跨了重启）
  rawEvent(new Date(Date.now() - 20 * 60 * 60_000).toISOString(), 'dispatch/started', {
    task: 'TASK-019', provider: 'spawn', childSessionId: 'zombie-1', tools: 9, role: 'developer', mode: 'one-shot',
  })

  const receipt = await h.callTool('sdo_plan', { action: 'next', backend: 'subagent', limit: 4 })
  assert.match(receipt, /TASK-020/u, `僵尸不该堵死池：${receipt.slice(-500)}`)
  assert.match(receipt, /未结算超时 1/u, '要标注那笔超时未结算')
  assert.match(receipt, /孤儿 TTL/u, '要说清判定用的 TTL（可配）')
})

test('M36-09 挂起后原样重派的提醒：`task/blocked` 之后卡内容没改过就又被派 ⇒ 提醒带上挂起理由', () => {
  const blocked: PoolEvent[] = [
    { type: 'task/created', data: { id: 'TASK-030' } },
    { type: 'task/blocked', data: { id: 'TASK-030', owner: 'dev-a', reason: 'orders 表没有车厢落点，DoD 第 1 条做不到' } },
    { type: 'task/released', data: { id: 'TASK-030', actor: 'cockpit', reason: '（未说明）' } },
  ]
  const found = unresolvedBlock(blocked, 'TASK-030')
  assert.match(found?.reason ?? '', /车厢落点/u, '要带回挂起理由（回执里原样引用）')

  // 反向：卡内容改过（`task/updated`）⇒ 不再提醒（缺口可能已被处理）
  assert.equal(unresolvedBlock([...blocked, { type: 'task/updated', data: { id: 'TASK-030' } }], 'TASK-030'), undefined)
  // 反向：做完过（`task/done`）⇒ 不再提醒
  assert.equal(unresolvedBlock([...blocked, { type: 'task/done', data: { id: 'TASK-030' } }], 'TASK-030'), undefined)
  // 反向：别的卡的事件不算数
  assert.equal(unresolvedBlock([{ type: 'task/blocked', data: { id: 'TASK-031', reason: 'x' } }], 'TASK-030'), undefined)

  // 接线：派发回执里真的会带上这条提醒（文案键由语言包守卫保证两包都有）
  const index = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  assert.match(index, /office\.unresolvedBlock\(call, task\.id\)/u, '派发分支要查"挂起后原样重派"')
  assert.match(index, /kDispatchRepeatBlocked/u, '查到就在回执里提醒')
})
