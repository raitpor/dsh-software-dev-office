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
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import { assessCoverageFromStore } from '../src/domain/coverage.js'
import { assessExitCriteria, renderExitCriteria } from '../src/domain/gates.js'
import { countCjkLiterals } from '../src/domain/langScan.js'
import { readTestingClass } from '../src/domain/testingStore.js'
import { t } from '../src/domain/i18n.js'
import { loadPackagedYaml } from '../src/infra/data.js'
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
  // **R-6**：`rolePools` 也判掩码指纹（与准入同一判据）⇒ 夹具必须给指纹，否则一律算"不可复用"
  const pools = rolePools({
    children: [
      { childSessionId: 'c1', role: 'developer', task: 'T1', mode: 'continuable', parentSessionId: '', state: 'busy', rounds: 1, startedAt: '', finishedAt: '', maskHash: 'H' },
      { childSessionId: 'c2', role: 'developer', task: 'T2', mode: 'continuable', parentSessionId: '', state: 'idle', rounds: 1, startedAt: '', finishedAt: '', maskHash: 'H' },
      { childSessionId: 'c3', parentSessionId: '', role: 'developer', task: 'T3', mode: 'one-shot', state: 'idle', rounds: 1, startedAt: '', finishedAt: '', maskHash: 'H' },
      { childSessionId: 'c4', parentSessionId: '', role: 'tester', task: 'T4', mode: 'one-shot', state: 'busy', rounds: 1, startedAt: '', finishedAt: '', maskHash: 'H' },
    ],
    roles: ['developer', 'tester', 'architect'],
    caps: { developer: 3 },
    defaultCap: 4,
    maskHashOf: () => 'H',
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
  const pools = rolePools({ children, roles: ['developer'], caps: { developer: 2 }, defaultCap: 4, maskHashOf: () => MASK })
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
  // **R-5A**：`在飞` 只报**折叠事实**（回执渲染在真正 start 之前 ⇒ 此刻确实 0 个在飞）；
  // 旧实现往池里塞占位孩子，于是"本次准入 4 张"被印成"在飞 4/4"（真机 0 真在飞 + 4 准入 = 4/4）。
  // 这一轮派了谁，由上面的"已派发 TASK-001"那行负责说清。
  assert.match(first, /developer：在飞 0\/1/u, `池行要如实（在飞=折叠事实）：${first.slice(-500)}`)
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

test('M36-08 R-5C：被 `limit` 截掉的卡**必须露面**（既没派发、也没排队 —— 旧回执让它们凭空消失）', async () => {
  const h = harness()
  await h.callTool('sdo_init', { name: '截断演练', process: 'waterfall', scale: 'normal', stakeholders: '运维' })
  journal.append('phase/entered', { phase: 'construction' })
  // 用 `tester`（harness 只把 developer 的池上限压到 1）⇒ 两张卡都能**通过容量准入**
  for (const id of ['TASK-101', 'TASK-102']) store.writeYaml(['tasks', `${id}.yml`], { task: card(id, 'tester') })

  // 两张卡都通过容量准入，但 `limit=1` 只派 1 张
  const receipt = await h.callTool('sdo_plan', { action: 'next', backend: 'subagent', limit: 1 })
  assert.match(receipt, /TASK-101/u, `第一张要派出去：${receipt.slice(0, 300)}`)
  assert.match(receipt, /另有 1 张已通过容量准入、但被本次 `limit=1` 挡下/u, `被 limit 挡下的卡要点名：${receipt.slice(-600)}`)
  assert.match(receipt, /TASK-102/u, '要说出是哪张卡（旧实现里它既不"已派发"也不"排队"，凭空消失）')
  assert.equal(journal.read().events.filter((event) => event.type === 'dispatch/started').length, 1, '只派 1 张')
})

// ————————————————————————————————————————————————————————————————————————————
// TASK-017：G6 `exit.criteria`（准出准则逐条现算 / 禁止加权）+ 语言包棘轮与两包同步
//
// 这组用例盯的是**三条可观察的口径**：
//   ① 逐条现算：每条准则**各自**拿实测与阈值比，任一条不达标 ⇒ 整体判红并**点名**那一条；
//   ② 声明里写了权重/得分 ⇒ **原样报出**（进了 `ignored`）但**不进判定**；
//      可观察形式：同一声明 ± 权重，两版**逐条 verdict 逐字相同**、`detail` 也逐字相同；
//   ③ 找不到实测 ⇒ 判红（fail-closed），且**不重复实现** coverage.ts 的读数判定（直接调它）。
// ————————————————————————————————————————————————————————————————————————————

const EXIT_BASE = join(ROOT, 'node_modules', '.sdo-test', 'm36-exit')

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * 建一个「真源 + 读数所引用的报告/产物都在盘上」的临时工作区，返回 store 与 workspace。
 *
 * 为什么报告与产物要**真写文件**：覆盖读数的时效判定靠**现算内容哈希**（`pathFingerprint`），
 * 盘上没有那份文件时读数一律算「找不到」—— 那样测的就不是本卡的判定，而是"夹具没写好"。
 */
function exitWorkspace(): { store: SdoStore; workspace: string } {
  rmSync(EXIT_BASE, { recursive: true, force: true })
  mkdirSync(join(EXIT_BASE, '.sdo', 'testing'), { recursive: true })
  const workspace = join(EXIT_BASE, 'evidence')
  mkdirSync(workspace, { recursive: true })
  return { store: new SdoStore(join(EXIT_BASE, '.sdo')), workspace }
}

/** 写一份准出准则声明（`.sdo/testing/plan.yml`）。`extra` 用来注入权重/得分这类"不进判定"的键。 */
function writePlanCriteria(
  target: SdoStore,
  criteria: (Record<string, unknown> & { id: string; criterion: string; threshold: string })[],
): void {
  target.writeYaml(['testing', 'plan.yml'], { plan: { levels: [], exitCriteria: criteria } })
}

/** 写一份覆盖真源；`report`/`artifact` 是**相对工作区**的路径，哈希按盘上内容现算。 */
function writeCoverage(target: SdoStore, workspace: string, readings: Record<string, unknown>[]): void {
  const filled = readings.map((reading, index) => {
    const report = `${reading.id ?? index}-report.txt`
    const artifact = `${reading.id ?? index}-artifact.txt`
    writeFileSync(join(workspace, report), `${String(reading.id ?? index)} report body\n`)
    writeFileSync(join(workspace, artifact), `${String(reading.id ?? index)} artifact body\n`)
    return { report, reportHash: sha256(readFileSync(join(workspace, report), 'utf8')), artifact, artifactHash: sha256(readFileSync(join(workspace, artifact), 'utf8')), ...reading }
  })
  target.writeYaml(['testing', 'coverage.yml'], { coverage: { readings: filled, uncovered: [] } })
}

/** 走**真实接线**（readTestingClass + coverage.ts 判定）读一次判定输入。 */
function exitInput(store: SdoStore, workspace: string): Parameters<typeof assessExitCriteria>[0] {
  const plan = readTestingClass(store, 'plan')[0]
  const report = readTestingClass(store, 'report')[0]
  const coverage = assessCoverageFromStore(store, workspace)
  const criteria = plan?.value.exitCriteria
  const reportCriteria = report?.value.exitCriteria
  return {
    ...(Array.isArray(criteria) ? { criteria } : {}),
    ...(Array.isArray(reportCriteria) ? { reportCriteria } : {}),
    coverage,
  }
}

test('M36-09 G6 准出准则：逐条现算、任一条不达标即判红并点名，且**不重复实现** coverage 判定', () => {
  const { store: target, workspace } = exitWorkspace()
  // 两条准则：MET-001 达标（91% ≥ 80%）、MET-002 不达标（70% < 90%）
  writePlanCriteria(target, [
    { id: 'C-1', criterion: 'statement', metric: 'statement', threshold: '80%', scope: 'src' },
    { id: 'C-2', criterion: 'decision', metric: 'decision', threshold: '90%', scope: 'src' },
  ])
  writeCoverage(target, workspace, [
    { id: 'COV-001', criterion: 'statement', measured: '91%', threshold: '80%', command: 'node --test' },
    { id: 'COV-002', criterion: 'decision', measured: '70%', threshold: '90%', command: 'node --test' },
  ])

  const assessment = assessExitCriteria(exitInput(target, workspace))
  assert.equal(assessment.criteria.length, 2, '声明了几条就判几条（不许合并成一条总分）')
  assert.equal(assessment.passed, false, '任一条不达标 ⇒ 整体不成立')
  assert.deepEqual(assessment.offenders, ['C-2'], '必须**点名**不达标的那一条（不是只说"覆盖不达标"）')

  const first = assessment.criteria.find((item) => item.id === 'C-1')
  const second = assessment.criteria.find((item) => item.id === 'C-2')
  assert.equal(first?.verdict, 'pass', 'MET-001 实测达阈 ⇒ 该条通过')
  assert.equal(first?.measured, '91%', '实测值要现算出来（读数里的值原样带出）')
  assert.equal(second?.verdict, 'fail', 'MET-002 实测未达阈值 ⇒ 该条不通过')
  assert.equal(second?.source, 'COV-002', '要指出实测来自哪条读数（可核对）')

  // 不重复实现：读数侧"过期 / 不成立 / 判不动"一律由 `coverage.ts` 判，本卡只按它的结论 fail-closed
  assert.equal(assessment.coverageOutcome, 'invalid', 'coverage.ts 的结论要原样带出来')

  // 判据面：整条判红，`remedy` 指向"逐条补实测"，且 detail 里要有那条不达标的编号
  const rendered = renderExitCriteria(assessment)
  assert.equal(rendered.ok, false)
  assert.match(rendered.detail, /C-2/u, `点名到具体准则：${rendered.detail}`)
  assert.ok((rendered.remedy ?? '').length > 0, '判红必须给可执行的补救（不能只说"不通过"）')

  // 反向：把不达标的那条改达标（其余一字不动）⇒ 整体转绿，说明判红的原因确实是"那一条"
  writeCoverage(target, workspace, [
    { id: 'COV-001', criterion: 'statement', measured: '91%', threshold: '80%', command: 'node --test' },
    { id: 'COV-002', criterion: 'decision', measured: '95%', threshold: '90%', command: 'node --test' },
  ])
  const green = assessExitCriteria(exitInput(target, workspace))
  assert.equal(green.passed, true, '两条都达阈 ⇒ 整体成立')
  assert.deepEqual(green.offenders, [])
  assert.equal(renderExitCriteria(green).ok, true)
})

test('M36-10 G6 准出准则 fail-closed：声明了准则却找不到实测 ⇒ 判红（判不动不许判绿）', () => {
  const { store: target, workspace } = exitWorkspace()
  writePlanCriteria(target, [{ id: 'C-9', criterion: 'path', metric: 'path', threshold: '100%' }])
  // 覆盖真源在盘上但**没有** path 的读数；也没有测试报告 ⇒ 这条准则没有实测来源
  writeCoverage(target, workspace, [
    { id: 'COV-001', criterion: 'statement', measured: '91%', threshold: '80%', command: 'node --test' },
  ])

  const assessment = assessExitCriteria(exitInput(target, workspace))
  assert.equal(assessment.criteria.length, 1)
  assert.equal(assessment.criteria[0]?.verdict, 'unmeasured', '找不到实测 ⇒ 这一条是"判不动"，不是"通过"')
  assert.equal(assessment.passed, false, 'fail-closed：判不动一律不许判绿')
  assert.deepEqual(assessment.offenders, ['C-9'], '判不动的那条同样要点名')
  const rendered = renderExitCriteria(assessment)
  assert.equal(rendered.ok, false)
  assert.match(rendered.detail, /C-9/u)

  // 声明都没有（真源缺 / 空）⇒ 也判红，不能"没声明就当通过"
  writePlanCriteria(target, [])
  const empty = assessExitCriteria(exitInput(target, workspace))
  assert.equal(empty.passed, false, '一条准则都没声明 ⇒ 判红')
  assert.equal(renderExitCriteria(empty).ok, false)
})

test('M36-11 G6 准出准则：读数过期时**不采信**该读数（哪怕数字看上去达阈）', () => {
  const { store: target, workspace } = exitWorkspace()
  writePlanCriteria(target, [{ id: 'C-1', criterion: 'statement', metric: 'statement', threshold: '80%' }])
  writeCoverage(target, workspace, [
    { id: 'COV-001', criterion: 'statement', measured: '91%', threshold: '80%', command: 'node --test' },
  ])
  // 产物改动 ⇒ 该读数过期（判定由 coverage.ts 做，本卡只按结论处理）
  writeFileSync(join(workspace, 'COV-001-artifact.txt'), 'tampered after the reading\n')

  const assessment = assessExitCriteria(exitInput(target, workspace))
  assert.equal(assessment.coverageOutcome, 'stale', '产物改了 ⇒ coverage.ts 判过期')
  assert.equal(assessment.criteria[0]?.verdict, 'fail', '过期读数不许再充当实测（91% 也不认）')
  assert.equal(assessment.passed, false)
})

test('M36-12 G6 准出准则：实测优先取覆盖读数，缺失时由**测试报告结论**兜底（两来源矛盾按判红处理）', () => {
  const { store: target, workspace } = exitWorkspace()
  writePlanCriteria(target, [
    { id: 'C-1', criterion: 'mc-dc', metric: 'mc-dc', threshold: '100%' },
    { id: 'C-2', criterion: 'def-use', metric: 'def-use', threshold: '100%' },
  ])
  writeCoverage(target, workspace, [
    { id: 'COV-001', criterion: 'statement', measured: '91%', threshold: '80%', command: 'node --test' },
  ])
  // 报告里给了这两条的实测与结论：C-1 结论 pass 且实测达阈、C-2 结论 fail
  target.writeYaml(['testing', 'report.yml'], {
    report: {
      exitCriteria: [
        { id: 'C-1', criterion: 'mc-dc', threshold: '100%', measured: '100%', verdict: 'pass' },
        { id: 'C-2', criterion: 'def-use', threshold: '100%', measured: '82%', verdict: 'fail' },
      ],
    },
  })

  const assessment = assessExitCriteria(exitInput(target, workspace))
  assert.equal(assessment.criteria.find((item) => item.id === 'C-1')?.verdict, 'pass', '报告结论 pass 兜底')
  assert.equal(assessment.criteria.find((item) => item.id === 'C-1')?.source, 'report')
  assert.equal(assessment.criteria.find((item) => item.id === 'C-2')?.verdict, 'fail', '报告结论 fail 兜底')
  assert.equal(assessment.passed, false)
  assert.deepEqual(assessment.offenders, ['C-2'])

  // 两来源（声明阈值 vs 报告结论）矛盾 ⇒ 一样判红：不许"挑一个好看的来源"
  target.writeYaml(['testing', 'report.yml'], {
    report: { exitCriteria: [{ id: 'C-2', criterion: 'def-use', threshold: '100%', measured: '82%', verdict: 'pass' }] },
  })
  const conflict = assessExitCriteria(exitInput(target, workspace))
  assert.equal(conflict.criteria.find((item) => item.id === 'C-2')?.verdict, 'fail', '结论 pass 但实测 82% < 100% ⇒ 矛盾即判红')
})

test('M36-13 守卫：同一声明 ± 权重 ⇒ 逐条 verdict **逐字相同**，权重只被"原样报出"不进判定', () => {
  const { store: target, workspace } = exitWorkspace()
  const declared = [
    { id: 'C-1', criterion: 'statement', metric: 'statement', threshold: '80%' },
    { id: 'C-2', criterion: 'decision', metric: 'decision', threshold: '90%' },
  ]
  writeCoverage(target, workspace, [
    { id: 'COV-001', criterion: 'statement', measured: '91%', threshold: '80%', command: 'node --test' },
    { id: 'COV-002', criterion: 'decision', measured: '70%', threshold: '90%', command: 'node --test' },
  ])

  // ① 不带权重的那一版
  writePlanCriteria(target, declared)
  const plain = assessExitCriteria(exitInput(target, workspace))
  const plainRendered = renderExitCriteria(plain)

  // ② 同一份声明 + 权重 / 得分（含中文键名与英文键名两种写法）
  writePlanCriteria(target, [
    { ...declared[0]!, weight: 0.9, score: 90 },
    { ...declared[1]!, 权重: '10%', 得分: 10 },
  ])
  const weighted = assessExitCriteria(exitInput(target, workspace))
  const weightedRendered = renderExitCriteria(weighted)

  // 逐条 verdict **逐字相同**（这条断言就是 DoD 第三条的可观察形式）
  assert.deepEqual(
    weighted.criteria.map((item) => item.verdict),
    plain.criteria.map((item) => item.verdict),
    '权重不进判定：± 权重两版的逐条 verdict 必须逐字相同',
  )
  assert.deepEqual(weighted.criteria, plain.criteria, '逐条结论（含实测/来源/阈值）也必须逐字相同 —— 权重不许碰任何一条')
  assert.equal(weighted.passed, plain.passed, '整体结论同样不受权重影响')
  assert.equal(weightedRendered.ok, plainRendered.ok)
  assert.equal(weightedRendered.detail, plainRendered.detail, '判据 detail 逐字相同（权重只走**独立**的报出行）')

  // 权重**原样报出**：键名与取值都不许被改写（写的是 0.9 / 10% 就报 0.9 / 10%）
  assert.equal(weighted.ignored.length, 4, '4 处权重声明都要报出来（两条准则 × 两个键）')
  assert.ok(
    weighted.ignored.some((item) => item.key === 'weight' && item.value === '0.9')
    && weighted.ignored.some((item) => item.key === 'score' && item.value === '90')
    && weighted.ignored.some((item) => item.key === '权重' && item.value === '10%')
    && weighted.ignored.some((item) => item.key === '得分' && item.value === '10'),
    `权重键名与取值必须原样带出：${JSON.stringify(weighted.ignored)}`,
  )
  assert.deepEqual(plain.ignored, [], '没写权重的版本没有任何"被忽略"的东西')

  // 回执要明说「你写的权重未被采用」，而且要出现在**最终门禁文案**里（不是只躺在结构体里）
  const notice = t('uiGates.kExitWeightIgnored')
  assert.notEqual(notice, 'kExitWeightIgnored', '两包都必须有这条文案（棘轮：文案一律走语言包）')
  const withNotice = renderExitCriteria(weighted, weighted.ignored)
  // 文案是 `…未被采用…：{p1}`（占位符在末尾）⇒ 填上 p1 后，回执里必须真的出现这句完整的话
  const filled = notice.replace('{p1}', weighted.ignored.map((item) => `${item.source}:${item.key}（${item.value}）`).join('、'))
  assert.ok(withNotice.detail.includes(filled), `回执要明说权重未被采用：${withNotice.detail}`)
  assert.ok(withNotice.detail.includes('0.9') && withNotice.detail.includes('10%'), '原文照登：权重与得分逐字带出')
})

test('M36-14 i18n 棘轮与两包同步：uiGates 键一律两层、两包都有且非空，gates.ts 硬编码中文仍为 0', () => {
  const zh = loadLangPack('zh-CN')
  const en = loadLangPack('en')

  // ① 代码引用到的每个 `uiGates.*` 键，两包都要有且非空（t() 只解析两层：section.key）
  const referenced = new Set<string>()
  for (const file of readdirSync(join(ROOT, 'src'), { recursive: true }).map((entry) => String(entry)).filter((entry) => entry.endsWith('.ts'))) {
    const text = readFileSync(join(ROOT, 'src', file), 'utf8')
    for (const match of text.matchAll(/\b(?:t|fmt)\('(uiGates\.[A-Za-z0-9_.-]+)'/gu)) referenced.add(match[1] as string)
  }
  assert.ok(referenced.size > 0, '至少要引用到一个 uiGates 键（否则这条守卫是空转的）')
  for (const key of referenced) {
    const id = key.split('.').slice(1).join('.')
    assert.ok(!id.includes('.'), `三层键取不到文案（t() 只解析两层）：${key}`)
    for (const [name, pack] of [['zh-CN', zh], ['en', en]] as const) {
      const value = pack.uiGates?.[id]
      assert.ok(typeof value === 'string' && value.trim() !== '', `${name} 语言包缺 uiGates.${id} 或为空`)
    }
  }

  // ② 本卡新增的准出准则文案：两包**同步补齐**（键集一致，不是"中文有英文没有"）
  const keys = Object.keys(zh.uiGates ?? {}).filter((key) => key.startsWith('kExit'))
  assert.ok(keys.length >= 8, `准出准则相关键要成套补齐，现在只有：${keys.join(' ')}`)
  for (const key of keys) {
    assert.ok(typeof en.uiGates?.[key] === 'string' && (en.uiGates[key] ?? '').trim() !== '', `en 语言包缺 uiGates.${key}`)
    assert.equal(en.uiGates[key], en.uiGates[key]?.trim(), `en uiGates.${key} 首尾不许有空白（跨语言取文要能做逐字比较）`)
  }
  // 反向：`zh` 与 `en` 的 `kExit*` 键集必须**完全一致**（多一个 / 少一个都算没同步）
  const enKeys = Object.keys(en.uiGates ?? {}).filter((key) => key.startsWith('kExit'))
  assert.deepEqual(enKeys.sort(), keys.sort(), '两种语言包的准出准则键集必须逐一对应')

  // ③ 棘轮基线：`src/domain/gates.ts` 的硬编码中文必须保持 0（本轮不许放宽，也不许把它从基线里摘掉）
  const gatesText = readFileSync(join(ROOT, 'src/domain/gates.ts'), 'utf8')
  assert.equal(countCjkLiterals(gatesText), 0, 'gates.ts 出现了硬编码中文：用户可见文案一律走语言包')
  // …而"什么算权重"仍然认得**数据里写的中文键名**（键名表是 `\uXXXX` 转义 ⇒ 计数为 0 但语义在）
  const cjkWeighted = assessExitCriteria({
    criteria: [
      { id: 'C-1', criterion: 'statement', threshold: '80%', '\u6743\u91cd': '0.9', '\u5f97\u5206': 90 },
    ],
    coverage: undefined,
  })
  assert.deepEqual(
    cjkWeighted.ignored.map((item) => `${item.key}=${item.value}`),
    ['\u6743\u91cd=0.9', '\u5f97\u5206=90'],
    '数据里的中文权重键名同样要被识别并原样报出',
  )
  const baseline = readFileSync(join(ROOT, 'test/m7.test.ts'), 'utf8')
  assert.match(baseline, /'src\/domain\/gates\.ts': 0/u, '棘轮基线里 gates.ts 必须仍在、且为 0（不许摘掉、不许放宽）')

  // ④ 判据**真的接在门禁上**：G6 的判据集里必须有 C-53，且 check 指向 exit.criteria。
  //    为什么非有这条断言：只测判定函数的话，"判据根本没人调用"也能全绿 —— 判据落点（流程数据）
  //    与实现是两处文件，脱节必须当场判红，而不是等真机上门禁少判一条。
  const waterfall = readFileSync(join(ROOT, 'src/data/processes/waterfall.yml'), 'utf8')
  const g6 = waterfall.slice(waterfall.indexOf('- id: G6'), waterfall.indexOf('- id: G7'))
  assert.match(g6, /id: C-53,\s*check: "exit\.criteria"/u, 'G6 的判据集里必须有 C-53 且 check 指向 exit.criteria（判据要真的接在门禁上）')
  assert.match(g6, /逐条现算/u, 'C-53 的 desc 要写明"逐条现算"')
  assert.match(g6, /禁止加权/u, 'C-53 的 desc 要写明"禁止加权"')
  assert.match(g6, /任一不达标即整体不成立并逐条点名/u, 'C-53 的 desc 要写明不达标时的处置')
})

/** 读一个随包语言包（与 `t()` 同一套解析器：`loadPackagedYaml`）。 */
function loadLangPack(locale: string): { uiGates?: Record<string, string> } {
  return loadPackagedYaml<{ uiGates?: Record<string, string> }>(`src/data/lang/${locale}.yml`)
}
