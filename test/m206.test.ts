/**
 * **增量 206：`DEF-142` —— `docs/TESTPLAN.md` 只许有一个渲染来源。**
 *
 * 病根：同一份路径有两个渲染器、两套真源 ——
 *   · `office.renderVerificationDocs()` → `records.renderTestPlan()`（真源 `.sdo/tests/`），由
 *     `sdo_deliver action=package` 调用，**后写者生效**；
 *   · `testingRender.writeTestingDoc(store, 'plan', …)`（真源 `.sdo/testing/plan.yml`，REQ-047 的计划真源），
 *     **零调用点**。
 * ⇒「有真源的计划文档」和「打包时写的计划文档」内容不同，且没有任何冲突提示。
 *
 * 修法口径（任务书 §3.2）：
 *   · package 出口改走计划真源（`writeTestingDoc`）；
 *   · `.sdo/testing/plan.yml` **缺失 ⇒ 不写** `docs/TESTPLAN.md`，回执点名缺哪份真源（**不许**退回旧渲染器）；
 *   · 旧渲染器 `records.renderTestPlan` 无其它调用点 ⇒ 删除（同源重复合并）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { maskFingerprint } from '../src/domain/roles.js'
import {
  admitDispatch,
  foldPoolChildren,
  poolReading,
  poolReadingsFingerprint,
  reuseSkippedLines,
  rolePools,
} from '../src/domain/pool.js'
import {
  REUSE_SKIPPED_EVENT,
  dispatchReadingFields,
  readDispatchReadings,
  reuseSkippedEventData,
  reuseSkippedFields,
  reuseSkippedOf,
} from '../src/domain/dispatchFace.js'
import type { PoolChild } from '../src/domain/pool.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm206')
const WORKSPACE = join(BASE, 'proj')
const TESTPLAN = join(WORKSPACE, 'docs', 'TESTPLAN.md')

let office: SoftwareDevOffice
const call = { sessionId: 's-m206', cwd: WORKSPACE } as unknown as OfficeCall

/** 一份**计划真源**（`.sdo/testing/plan.yml`）——准出准则 EC-001 是渲染正文里必须出现的证据。 */
function writePlanSource(): void {
  mkdirSync(join(WORKSPACE, '.sdo', 'testing'), { recursive: true })
  writeFileSync(join(WORKSPACE, '.sdo', 'testing', 'plan.yml'), [
    'plan:',
    '  levels:',
    '    - { id: LV-001, level: 单元测试, entry: 实现完成, exit: 单测全绿, traceability: req-tc }',
    '  exitCriteria:',
    '    - { id: EC-001, criterion: 全量用例通过率, threshold: "100%", comparator: gte, source: 全量套件 }',
    '',
  ].join('\n'), 'utf8')
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-m206', WORKSPACE)
  office.init(call, { name: 'M206 测试计划单一来源', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M206-01 计划真源存在 ⇒ 渲染 `docs/TESTPLAN.md` 走真源：正文有 EC-001 与 `source: .sdo/testing/plan.yml`', () => {
  writePlanSource()
  const written = office.renderVerificationDocs(call)
  assert.equal(existsSync(TESTPLAN), true, `必须渲染计划文档（实际写了：${written.join(' / ')}）`)
  const text = readFileSync(TESTPLAN, 'utf8')
  assert.match(text, /EC-001/u, '正文必须含计划真源里的准出准则（旧渲染器读的是 .sdo/tests，不会有它）')
  assert.match(text, /source: \.sdo\/testing\/plan\.yml/u, '渲染头必须自报真源路径（读者要知道这份是从哪来的）')
  assert.ok(written.some((item) => item.includes('TESTPLAN.md')), '回执必须报出写了哪份文档')
})

test('M206-02 计划真源缺失 ⇒ **不写** `docs/TESTPLAN.md`，回执点名缺哪份真源（不许退回旧渲染器）', () => {
  // 先放一份"上一次渲染的"文件：真源缺失时**不许**被改写（也不许被旧渲染器覆盖成另一套口径）
  mkdirSync(join(WORKSPACE, 'docs'), { recursive: true })
  writeFileSync(TESTPLAN, 'OLD-PLAN-BYTES\n', 'utf8')
  const before = readFileSync(TESTPLAN, 'utf8')
  const written = office.renderVerificationDocs(call)
  assert.equal(readFileSync(TESTPLAN, 'utf8'), before, '没有计划真源 ⇒ 盘上那份必须一字不动')
  assert.equal(written.some((item) => item.includes('TESTPLAN.md')), false, '没写就不许报"写了"')
  assert.ok(
    written.some((item) => item.includes('.sdo/testing/plan.yml')),
    `回执必须点名缺哪份真源（实际：${written.join(' / ')}）`,
  )
})

test('M206-03 反例（不许误伤）：`docs/DELIVERY.md` 的渲染行为与修前逐字节一致', () => {
  // 交付清单真源存在 ⇒ DELIVERY.md 照旧渲染；改动只碰 TESTPLAN 那一段
  office.storeFor(WORKSPACE).writeYaml(['delivery', 'manifest.yml'], {
    manifest: {
      id: 'DLV-001', at: '2026-10-20T00:00:00.000Z', version: '0.1.6',
      artifacts: [{ path: 'lib/src/index.js', sha256: 'a'.repeat(64) }],
      acceptance: [{ requirement: 'REQ-001', criterion: 'AC-001', evidence: 'e', verdict: 'pass' }],
      rollbackPoint: 'HEAD', runsRequired: [],
    },
  })
  const written = office.renderVerificationDocs(call)
  const delivery = join(WORKSPACE, 'docs', 'DELIVERY.md')
  assert.equal(existsSync(delivery), true, `DELIVERY.md 必须照旧渲染（实际写了：${written.join(' / ')}）`)
  const text = readFileSync(delivery, 'utf8')
  assert.match(text, /source: \.sdo\/delivery\/manifest\.yml/u, 'DELIVERY.md 的真源头不许变')
  assert.match(text, /DLV-001|交付清单/u, 'DELIVERY.md 正文仍由交付清单渲染')
  // 没有计划真源 ⇒ TESTPLAN 不写；这不影响 DELIVERY（两段互不牵连）
  assert.equal(existsSync(TESTPLAN), false, '没有计划真源时不许顺手写一份 TESTPLAN')
})

/* ————————————————————————————————————————————————————————————————————————————————
 * **增量 206 续：`DEF-139` —— 派发现场可读（`TASK-163`）**
 *
 * 四条用户口径（任务卡 DoD ①②③④）：
 *   ① 五条复用判据**全过** ⇒ 必须复用（真派发路径上断言，不只在纯函数里）；
 *   ② 每个桶各一条 ⇒ 桶计数**逐项**正确（含 `freeSlots` 的算式）；
 *   ③ 被闸门拒的孩子 ⇒ 其 `reason` **逐条**（`childSessionId` / `role` / `reason` 三字段）落进读数与事件；
 *   ④ 同一台账两次调用必须给出**逐字节相同**的计数（`REQ-035` / `REQ-037` 的可复现性口径）。
 *
 * 这张卡要挡住的退化方向：
 *   · 读数只报一个总数（"空闲 N 个"）⇒ 又一次"靠掩码哈希反推、并反推错过"；
 *   · `reuseSkipped` 退回**结构性恒空**（`rolePools` 与准入共用判据后，在 `pool.idle` 上再判一遍必然为空）；
 *   · 事件字段悄悄改名 ⇒ 接线方（`src/office.ts`）与读侧（回执）各读一套；
 *   · 读数里带 `Date.now()`/随机量 ⇒ 同一台账两次读数不同字节，"复现"变空话。
 * ———————————————————————————————————————————————————————————————————————————————— */

/** 往**夹具台账**里写一张卡（真源形状，与 `sdo_task` 写出来的一致）。 */
function writeYamlTask(task: TaskCard): void {
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${task.id}.yml`], { task })
}

const TASK163 = {
  /** 一个**已结算**的空闲子代理（`mode: continuable` ⇒ 结算后仍可复用） */
  child(childSessionId: string, maskHash: string, overrides: Partial<PoolChild> = {}): PoolChild {
    return {
      childSessionId,
      role: 'developer',
      task: 'TASK-16300',
      mode: 'continuable',
      state: 'idle',
      rounds: 1,
      cards: 1,
      startedAt: '2026-10-09T00:00:00.000Z',
      finishedAt: '2026-10-09T00:10:00.000Z',
      parentSessionId: 's-m206',
      maskHash,
      ...overrides,
    }
  },
  card(id: string, writeScopes: string[] = ['src/m206/pool.ts']): TaskCard {
    return {
      id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
      blockedBy: [], writeScopes, role: 'developer', size: 'small', revision: 1, status: 'ready',
      requirements: [], evidence: [], createdAt: '', updatedAt: '',
    } as unknown as TaskCard
  },
  /** 在**夹具台账**里造一个"派过、结算了"的孩子（真源形状与真机一致）。 */
  seedChild(childSessionId: string, taskId: string, maskHash: string): void {
    office.recordDispatchStarted(call, {
      taskId,
      provider: 'spawn',
      childSessionId,
      parentSessionId: 's-m206',
      tools: 3,
      role: 'developer',
      mode: 'continuable',
      maskHash,
    })
    office.journalFor(WORKSPACE).append('dispatch/finished', { task: taskId, childSessionId })
  },
  /** 观测证据（R-1）：`dispatch/observed` 事件 + `evidence/child-tools.jsonl` 两处都落。 */
  observe(childSessionId: string): void {
    office.noteChildFace(call, {
      childSessionId, tools: ['bash', 'edit', 'read'], violations: [], calls: [], callCount: 0,
    })
  },
  /** 宿主桩：`start` 新起、`startContinuable` 建可续聊、`sendMessage` 是**复用**的投递原语。 */
  mount(): { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[] {
    const tools: { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[] = []
    const services: Record<string, unknown> = {}
    const makeCtx = (): Record<string, unknown> => ({
      logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
      plugin: () => {},
      on: () => () => {},
      get: (name: string) => services[name],
      inject: (names: string[], cb: (sub: unknown) => void) => {
        if (names.every((name) => name in services)) cb(makeCtx())
      },
      effect: (fn: () => unknown) => {
        fn()
        return () => {}
      },
    })
    services['tools'] = { register: (tool: unknown) => { tools.push(tool as (typeof tools)[number]); return () => {} } }
    services['subagents'] = {
      list: () => ['spawn'],
      start: async () => ({ id: 'child-oneshot-m206' }),
      startContinuable: async () => ({ childId: 'child-fresh-m206' }),
      sendMessage: async () => ({ messageId: 'msg-m206' }),
      getProvider: () => ({ capabilities: { toolFilter: true } }),
      listDescendants: async () => [],
    }
    apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
    return tools
  },
  async callTool(
    tools: { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[],
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const tool = tools.find((item) => item.name === name)
    assert.ok(tool !== undefined, `工具面缺少 ${name}`)
    const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    const filtered: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
    const agentStub = { id: 's-m206', session: { header: { id: 's-m206', cwd: WORKSPACE, delegationDepth: 0 } } }
    return String(await tool.execute(filtered, { agent: agentStub }))
  },
}

test('M206-04 ① 五条复用判据全过 ⇒ **必须复用**（真派发路径），且派发时的读数答得出「从哪来 / 各桶几条」', async () => {
  const childSessionId = 'aaaa1630-1111-4bbb-8ccc-dddddddddd01'
  // 五条判据（任务卡「已查明的边界」里那五条）逐条摆出来：
  //   ① 已结算（idle）② mode=continuable ③ R-1 观测到手里有工具 ④ 掩码指纹一致 ⑤ 未声明复用上限
  TASK163.seedChild(childSessionId, 'TASK-16300', maskFingerprint('developer'))
  TASK163.observe(childSessionId)
  writeYamlTask(TASK163.card('TASK-16301'))

  // 读数面（本卡落点一）：`childrenSource` / `childrenTotal` / 各桶 / cap / freeSlots 都要在场
  const pools = office.poolView(call)
  const dev = pools.find((pool) => pool.role === 'developer')
  assert.ok(dev !== undefined, '夹具前提：developer 池必须在池视图里（否则下面全是空断言）')
  assert.equal(dev.idle.length, 1, '五条判据全过 ⇒ 它必须是"空闲可复用"')
  assert.equal(dev.unusable.length, 0, '不许有"额外理由"把它挡在门外（挡了就说明判据多了一条）')
  assert.equal(dev.busy.length, 0, '已结算 ⇒ 不在飞')
  assert.equal(dev.cap, 4, '上限取 `maxParallelDispatch` 缺省（配置没写 developer）')
  assert.equal(dev.freeSlots, 3, `freeSlots = cap − busy − idle = 4 − 0 − 1 = 3（现算 ${String(dev.freeSlots)}）`)

  const events = office.journalFor(WORKSPACE).read().events
  const children = [...foldPoolChildren(events.map((event) => ({ type: event.type, data: event.data, at: event.at }))).values()]
  const reading = poolReading({ role: 'developer', childrenSource: 'journal', children, pools })
  assert.equal(reading.childrenSource, 'journal', '口径名必须写清（journal 折叠 / 宿主实时列表 / 两者合并）')
  assert.equal(reading.childrenTotal, children.length, 'childrenTotal = 喂进池的折叠结果大小（现算，不写死）')
  assert.equal(reading.buckets.idle, 1)
  assert.equal(reading.buckets.idleSameParent, 1, '父会话 = 观察者 ⇒ 派发器真的能投')
  assert.equal(reading.freeSlots, 3)

  // 准入面：真的会挑它
  const plan = office.poolPlan(call, { reuseIdle: true })
  assert.equal(plan.dispatch.find((row) => row.task.id === 'TASK-16301')?.reuseChildId, childSessionId, '判据全过 ⇒ 复用（不许新起）')
  assert.equal(plan.reuseSkipped.length, 0, '没有孩子被拒 ⇒ 清单必须为空（不许凭空造理由）')

  // **真派发路径**：走 `sdo_plan action=next`（宿主桩），真源里那笔必须记 `reused=true` 且复用同一个 id
  const tools = TASK163.mount()
  const receipt = await TASK163.callTool(tools, 'sdo_plan', { action: 'next', limit: 1 })
  const started = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'dispatch/started').at(-1)
  assert.equal(started?.data['childSessionId'], childSessionId, '复用的就是那个空闲孩子（不是新起一个）')
  assert.equal(started?.data['reused'], true, '`dispatch/started.reused` 必须为 true（真源可查）')
  assert.match(receipt, /复用/u, `回执必须写明复用：${receipt.slice(0, 400)}`)
})

test('M206-05 ② 每个桶各一条 ⇒ 桶计数逐项正确（含 freeSlots 的算式）', () => {
  const NOW = Date.parse('2026-10-09T00:05:00.000Z')
  const children: PoolChild[] = [
    // 在飞且未超时（TTL 5 分钟，1 分钟前起）
    TASK163.child('bucket-busy', 'M', { state: 'busy', finishedAt: '', startedAt: '2026-10-09T00:04:00.000Z' }),
    // 在飞且超时 ⇒ stale（不占池位、也绝不进 idle）
    TASK163.child('bucket-stale', 'M', { state: 'busy', finishedAt: '', startedAt: '2026-01-01T00:00:00.000Z' }),
    TASK163.child('bucket-same', 'M'),
    TASK163.child('bucket-foreign', 'M', { parentSessionId: 'another-parent' }),
    TASK163.child('bucket-unknown', 'M', { parentSessionId: '' }),
    TASK163.child('bucket-retired', 'M', { mode: 'one-shot' }),
    // 掩码不一致 ⇒ unusable（"空闲但过不了闸门"那一桶）
    TASK163.child('bucket-unusable', 'OLD-MASK'),
  ]
  const pools = rolePools({
    children,
    roles: ['developer'],
    caps: { developer: 4 },
    defaultCap: 4,
    orphanTtlMs: 5 * 60_000,
    nowMs: NOW,
    viewerSessionId: 's-m206',
    maskHashOf: () => 'M',
  })
  const dev = pools.find((pool) => pool.role === 'developer')
  assert.ok(dev !== undefined)
  assert.equal(dev.busy.length, 1, '在飞 1（stale 不算在飞）')
  assert.equal(dev.stale.length, 1, '超时未结算 1')
  assert.equal(dev.retired, 1, 'one-shot 已结算 1（不可复用，如实记）')
  assert.equal(dev.unusable.length, 1, '过不了闸门的空闲 1')
  assert.equal(dev.idle.length, 3, '可复用空闲 3（同父 1 + 跨父 1 + 父未知 1）')
  assert.equal(dev.idleSameParent.length, 1, '同父会话 1')
  assert.equal(dev.idleForeign.length, 1, '跨父会话 1（宿主会拒，必须分栏）')
  assert.equal(dev.idleUnknownParent, 1, '父会话未知 1（老事件，不当成可复用）')
  assert.equal(dev.freeSlots, 0, `freeSlots = max(0, 4 − 1 − 3) = 0（现算 ${String(dev.freeSlots)}；不可复用的 1 个不占位）`)

  const reading = poolReading({ role: 'developer', childrenSource: 'journal', children, pools })
  assert.equal(reading.childrenTotal, 7, '折叠出来的孩子总数（7 条，现算）')
  assert.deepEqual(reading.buckets, {
    idle: 3, idleSameParent: 1, idleForeign: 1, idleUnknownParent: 1,
    stale: 1, retired: 1, unusable: 1, busy: 1,
  }, '八个桶逐项：idle / idleSameParent / idleForeign / idleUnknownParent / stale / retired / unusable / busy')
  assert.equal(reading.cap, 4)
  assert.equal(reading.freeSlots, 0)
  // 反例（防"来源写死成 journal"这类退化）：口径名必须跟着入参走
  assert.equal(poolReading({ role: 'developer', childrenSource: 'host-live', children, pools }).childrenSource, 'host-live', '来源口径不许写死')
  // 该角色在池里没有条目 ⇒ 全 0，**不是**"不限量"
  const absent = poolReading({ role: 'tester', childrenSource: 'journal', children, pools })
  assert.deepEqual(absent.buckets, { idle: 0, idleSameParent: 0, idleForeign: 0, idleUnknownParent: 0, stale: 0, retired: 0, unusable: 0, busy: 0 }, '没有池 ⇒ 各桶 0（不许读成不限量）')
  assert.equal(absent.cap, 0, '没有池 ⇒ cap 0')
})

test('M206-06 ③ 被闸门拒的孩子：`reason` 逐条（三字段）落进 `reuseSkipped`、进回执、并能被读侧回读', async () => {
  const childSessionId = 'bbbb1630-2222-4bbb-8ccc-dddddddddd02'
  // 掩码过期（判据④不过）+ 观测齐全（判据③过）⇒ 只该被**一条**理由挡住
  TASK163.seedChild(childSessionId, 'TASK-16302', 'stale-mask-0000')
  TASK163.observe(childSessionId)
  writeYamlTask(TASK163.card('TASK-16303'))

  const plan = office.poolPlan(call, { reuseIdle: true })
  const rows = plan.reuseSkipped
  assert.equal(rows.length, 1, `被闸门拒的孩子必须**逐条**露面（修前这里恒为空）：${JSON.stringify(rows)}`)
  assert.equal(rows[0]?.childSessionId, childSessionId)
  assert.equal(rows[0]?.role, 'developer', '三条字段之一：角色（跨角色混在一起正是看不清的主因）')
  assert.match(rows[0]?.reason ?? '', /掩码/u, `三条字段之一：理由（要读得出是哪道闸门）：${rows[0]?.reason ?? ''}`)
  // 回执面：三字段逐条打出来，**不许只打数量**
  const lines = reuseSkippedLines(rows)
  assert.equal(lines.length, 1, '每条一行')
  assert.match(lines[0] ?? '', new RegExp(`childSessionId=${childSessionId}`, 'u'), '回执行必须带 childSessionId')
  assert.match(lines[0] ?? '', /role=developer/u, '回执行必须带 role')
  assert.match(lines[0] ?? '', /reason=.*掩码/u, '回执行必须带 reason')

  // 真派发路径的回执里也要能看到「谁没被复用、为什么」（这一条今天由 `sdo_plan` 的正常回执承担）
  const tools = TASK163.mount()
  const receipt = await TASK163.callTool(tools, 'sdo_plan', { action: 'next', limit: 1 })
  assert.match(receipt, new RegExp(childSessionId, 'u'), `回执必须点名那个没被复用的孩子：${receipt.slice(0, 500)}`)
  assert.match(receipt, /掩码/u, '回执必须带理由（"为什么没复用"这句话要有答案）')

  // **事件面**：形状由这两处唯一决定（接线方 `src/office.ts` 直接并进 `dispatch/started`）；
  // 读侧两种承载都认（`dispatch/started.reuseSkipped` 与独立事件 `dispatch/reuse-skipped`）。
  const events = office.journalFor(WORKSPACE).read().events
  const children = [...foldPoolChildren(events.map((event) => ({ type: event.type, data: event.data, at: event.at }))).values()]
  const reading = poolReading({ role: 'developer', childrenSource: 'journal', children, pools: office.poolView(call) })
  const fields = dispatchReadingFields(reading, { reuseIdle: plan.reuseIdle, forceNew: plan.forceNew })
  assert.deepEqual(Object.keys(fields).sort(), ['buckets', 'cap', 'childrenSource', 'childrenTotal', 'forceNew', 'freeSlots', 'reuseIdle'], '读数五件（桶在里面）+ 两个定案键：字段名就是接线契约，不许悄悄改名')
  assert.deepEqual(Object.keys(fields['buckets'] as Record<string, number>).sort(), ['busy', 'idle', 'idleForeign', 'idleSameParent', 'idleUnknownParent', 'retired', 'stale', 'unusable'], '八个桶一个都不许少')
  assert.equal(fields['reuseIdle'], true, '这一轮**试过**复用（定案键：不试的话 reuseSkipped 为空是正确行为）')
  assert.equal(fields['forceNew'], false, '这一轮不是强制新起')
  const skippedFields = reuseSkippedFields(rows)
  assert.deepEqual(skippedFields, [{ childSessionId, role: 'developer', reason: rows[0]?.reason ?? '' }], '三字段原样落盘（不聚合、不改写）')

  const journal = office.journalFor(WORKSPACE)
  journal.append('dispatch/started', {
    task: 'TASK-16304', role: 'developer', childSessionId: 'cccc1630-3333', reused: false,
    ...fields, reuseSkipped: skippedFields,
  })
  const back = reuseSkippedOf(journal).filter((row) => row.childSessionId === childSessionId && row.task === 'TASK-16304')
  // **按卡过滤**（不是按孩子）：同一个孩子会被**多次派发**各留一次痕（接线之后真派发那笔也留了，
  // 见 `M206-09`）—— 读侧**不去重**是刻意的（历史读数照实回放），聚合是渲染层的事。
  assert.equal(back.length, 1, `读侧必须能回读"没被复用"的留痕（按卡过滤后只该有手工那一条）：${JSON.stringify(back)}`)
  assert.equal(back[0]?.via, 'dispatch/started', '承载①：挂在派发事件上（今天就能落地，不需要新事件类型）')
  assert.equal(back[0]?.task, 'TASK-16304', '要能反查是哪张卡的那一笔')
  assert.ok((back[0]?.seq ?? 0) > 0, '要带可引用的序号')
  const readings = readDispatchReadings(journal).filter((row) => row.task === 'TASK-16304')
  assert.equal(readings.length, 1, '读数必须能回读（否则"为什么没复用"仍然要反推）')
  assert.equal(readings[0]?.childrenSource, 'journal')
  assert.equal(readings[0]?.buckets['unusable'], 1, '桶读数回读后仍是那个数（不是只剩一个总数）')
  assert.equal(readings[0]?.cap, 4)
  assert.equal(readings[0]?.reuseIdle, true, '定案键回读：这一轮试过复用')
  // 老事件没有这两个键 ⇒ 读出 `undefined`（**"没记" ≠ "记了 false"**，不许静默补默认值）
  journal.append('dispatch/started', { task: 'TASK-16308', role: 'developer', childSessionId: 'ffff1630', ...dispatchReadingFields(reading) })
  const legacy = readDispatchReadings(journal).find((row) => row.task === 'TASK-16308')
  assert.equal(legacy?.reuseIdle, undefined, '没记就是没记（不许读成"没试过"）')
  // 承载②：独立事件（`src/types.ts` 的闭合联合里已登记，接线之后真派发那笔也会落一条，见 `M206-09`）
  journal.append(REUSE_SKIPPED_EVENT as unknown as Parameters<typeof journal.append>[0], reuseSkippedEventData(rows[0] ?? { childSessionId, role: 'developer', reason: '' }, { task: 'TASK-16305' }))
  const viaEvent = reuseSkippedOf(journal).filter((row) => row.via === REUSE_SKIPPED_EVENT && row.task === 'TASK-16305')
  assert.equal(viaEvent.length, 1, '承载②（独立事件）读侧同样认（两种承载同一份读数）')
  assert.equal(viaEvent[0]?.task, 'TASK-16305', '独立事件自身要带所属卡（读者不必再拼上下文）')
})

test('M206-07 ④ 同一台账两次调用逐字节相同（`REQ-035` / `REQ-037` 可复现性口径），且读数有判别力', () => {
  const childSessionId = 'dddd1630-4444-4bbb-8ccc-dddddddddd03'
  TASK163.seedChild(childSessionId, 'TASK-16306', maskFingerprint('developer'))
  TASK163.observe(childSessionId)

  // 两次**独立**折叠同一台账（不是复用同一个对象），时间基准固定 ⇒ 读数必须逐字节相同
  const NOW = Date.parse('2026-10-09T00:20:00.000Z')
  const readOnce = () => {
    const events = office.journalFor(WORKSPACE).read().events
    const children = [...foldPoolChildren(events.map((event) => ({ type: event.type, data: event.data, at: event.at }))).values()]
    const pools = rolePools({
      children, roles: ['developer'], caps: {}, defaultCap: 4,
      orphanTtlMs: 5 * 60_000, nowMs: NOW, viewerSessionId: 's-m206',
      maskHashOf: () => maskFingerprint('developer'),
      reuseBlockedOf: (child) => (office.childObservations(call).some((row) => row.childSessionId === child.childSessionId) ? undefined : '没有观测'),
    })
    return [poolReading({ role: 'developer', childrenSource: 'journal', children, pools })]
  }
  const first = readOnce()
  const second = readOnce()
  assert.equal(poolReadingsFingerprint(second), poolReadingsFingerprint(first), '同一台账两次读数必须逐字节相同（不许夹带 Date.now()/随机量）')
  assert.equal(JSON.stringify(second), JSON.stringify(first), '逐字节：JSON 文本也要一致（键序由读数的字面量固定）')
  assert.equal(first[0]?.buckets.idle, 1, '前置：这个夹具里确实有 1 个可复用空闲（否则"相同"是空断言）')

  // 判别力：改掉一个桶 ⇒ 指纹必须变（否则"相同"什么也没证明）
  const mutated = [{ ...(first[0] as NonNullable<(typeof first)[0]>), buckets: { ...(first[0] as NonNullable<(typeof first)[0]>).buckets, idle: 2 } }]
  assert.notEqual(poolReadingsFingerprint(mutated), poolReadingsFingerprint(first), '桶变了一个 ⇒ 指纹必须变（判据有判别力）')
  // 反例：`reuseSkipped` 结构恒空不许回来（它是"为什么没复用"的唯一出口）
  const gate = rolePools({
    children: [TASK163.child('eeee1630-5555', 'OLD')],
    roles: ['developer'], caps: {}, defaultCap: 4, nowMs: NOW, viewerSessionId: 's-m206',
    maskHashOf: () => 'NEW',
  })
  const admission = admitDispatch({ ready: [TASK163.card('TASK-16307')], pools: gate, globalRoom: 4, reuseIdle: true, maskHashOf: () => 'NEW' })
  assert.equal(admission.reuseSkipped.length, 1, `被闸门拒的孩子必须进清单（恒空会把"为什么没复用"重新变成反推）：${JSON.stringify(admission.reuseSkipped)}`)
  assert.equal(admission.reuseIdle, true, '回显"这一轮试过复用"（定案键）')
  assert.equal(admission.forceNew, false)

  // **反向格（不许把"没打算复用"记成"复用被拒"）**：两条路都为真，且清单为空
  const notTried = admitDispatch({ ready: [TASK163.card('TASK-16308')], pools: gate, globalRoom: 4, reuseIdle: false, maskHashOf: () => 'NEW' })
  assert.equal(notTried.reuseIdle, false, '宿主没有续聊入口 ⇒ 回显 false')
  assert.equal(notTried.reuseSkipped.length, 0, '没打算复用 ⇒ 清单必须为空（否则回执会说"这些孩子不合格"）')
  const forcedNew = admitDispatch({ ready: [TASK163.card('TASK-16309')], pools: gate, globalRoom: 4, reuseIdle: true, forceNew: true, maskHashOf: () => 'NEW' })
  assert.equal(forcedNew.forceNew, true, '本轮换人 ⇒ 回显 forceNew')
  assert.equal(forcedNew.reuseSkipped.length, 0, '强制新起 ≠ 复用被拒（两种"不复用"必须在读数上分得开）')
})

/* ————————————————————————————————————————————————————————————————————————————————
 * **增量 206 续②：`DEF-139` 落点一/二** —— 读数与「没复用」必须**落进事件**（`TASK-163`）
 *
 * 为什么要这三条：上四条守的是**纯函数**（`poolReading` / `admitDispatch`），
 * 而真机上的问题恰恰在**接线**：函数算得再对，只要派发那一刻没把读数并进 `dispatch/started`、
 * 没把 `reuseSkipped` 落成事件、回执只打数量，驾驶舱仍然只能拿掩码哈希反推（并反推错过两次）。
 * 因此这三条一律走**真派发路径**（`sdo_plan action=next` + 宿主桩），断言台账与回执。
 *
 * 红侧就在这：现盘 `dispatch/started` 里没有 `childrenSource` / `buckets` / `reuseIdle` / `forceNew`
 * 任何一个字，`dispatch/reuse-skipped` 事件类型不存在，`why=true` 回执对 `reuseSkipped` 一字不提。
 * ———————————————————————————————————————————————————————————————————————————————— */

test('M206-08 ①b 真派发路径：`dispatch/started` 必须带上现场读数（来源 + 总数 + 八桶 + cap/freeSlots + 两个定案键）', async () => {
  const childSessionId = 'aaaa1630-6666-4bbb-8ccc-dddddddddd06'
  TASK163.seedChild(childSessionId, 'TASK-16310', maskFingerprint('developer'))
  TASK163.observe(childSessionId)
  writeYamlTask(TASK163.card('TASK-16311'))

  const pools = office.poolView(call)
  const expected = poolReading({
    role: 'developer',
    childrenSource: 'journal',
    children: [...foldPoolChildren(office.journalFor(WORKSPACE).read().events.map((event) => ({ type: event.type, data: event.data, at: event.at }))).values()],
    pools,
  })

  const tools = TASK163.mount()
  await TASK163.callTool(tools, 'sdo_plan', { action: 'next', limit: 1, why: false })

  const journal = office.journalFor(WORKSPACE)
  const started = journal.read().events.filter((event) => event.type === 'dispatch/started').at(-1)
  assert.ok(started !== undefined, '必须真的派发出去（否则下面全是空断言）')
  assert.equal(started.data['task'], 'TASK-16311', '最后一条 `dispatch/started` 就是这一轮派的那张卡')
  // **落点一**：来源口径 + 总数 + 八桶 + cap/freeSlots
  assert.equal(started.data['childrenSource'], 'journal', '口径名必须写进事件（三种口径各自能读，读者不必猜）')
  assert.equal(started.data['childrenTotal'], expected.childrenTotal, `孩子总数必须与折叠结果一致（现算 ${String(expected.childrenTotal)}）`)
  const buckets = started.data['buckets'] as Record<string, number> | undefined
  assert.ok(buckets !== undefined && typeof buckets === 'object', `八桶必须进事件（实际：${JSON.stringify(started.data['buckets'])}）`)
  assert.deepEqual(Object.keys(buckets).sort(), ['busy', 'idle', 'idleForeign', 'idleSameParent', 'idleUnknownParent', 'retired', 'stale', 'unusable'], '八个桶一个都不许少（少一个就是又一次"靠反推"）')
  assert.deepEqual(buckets, expected.buckets, '桶必须与同一份池快照算出来的逐项相同（两套口径必然分叉）')
  assert.equal(started.data['cap'], expected.cap, '该角色的并行上限要进事件')
  assert.equal(started.data['freeSlots'], expected.freeSlots, '还能新建几个要进事件')
  // **定案键**：为什么没复用 —— 先要知道这一轮到底试没试
  assert.equal(started.data['reuseIdle'], true, '`reuseIdle` 必须进事件（不试与试过被拒必须分得开）')
  assert.equal(started.data['forceNew'], false, '`forceNew` 必须进事件（本轮换人 ≠ 复用被拒）')

  // 读侧闭环：以后问"为什么没复用"，读这一行就够（不必再反推掩码哈希）
  const back = readDispatchReadings(journal).filter((row) => row.task === 'TASK-16311')
  assert.equal(back.length, 1, '这条读数必须能被读侧回读（否则事件写了也白写）')
  assert.equal(back[0]?.childrenSource, 'journal')
  assert.deepEqual(back[0]?.buckets, expected.buckets, '回读的桶与写进去的一致')
  assert.equal(back[0]?.reuseIdle, true, '定案键回读')
})

test('M206-09 ②b 被闸门拒的孩子 ⇒ `dispatch/reuse-skipped` **事件**逐条落盘（三字段 + 所属卡），读侧可回读', async () => {
  const childSessionId = 'bbbb1630-7777-4bbb-8ccc-dddddddddd07'
  TASK163.seedChild(childSessionId, 'TASK-16312', 'stale-mask-9999')
  TASK163.observe(childSessionId)
  writeYamlTask(TASK163.card('TASK-16313'))

  const tools = TASK163.mount()
  await TASK163.callTool(tools, 'sdo_plan', { action: 'next', limit: 1, why: false })

  const journal = office.journalFor(WORKSPACE)
  const events = journal.read().events.filter((event) => event.type === REUSE_SKIPPED_EVENT)
  assert.equal(events.length, 1, `被闸门拒的孩子必须**落一条事件**（不落事件 = 读数只活在这一轮的内存里）：${JSON.stringify(events.map((event) => event.data))}`)
  assert.equal(events[0]?.data['childSessionId'], childSessionId, '三条字段之一：孩子 id')
  assert.equal(events[0]?.data['role'], 'developer', '三条字段之一：角色')
  assert.match(String(events[0]?.data['reason'] ?? ''), /掩码/u, `三条字段之一：理由（要读得出是哪道闸门）：${String(events[0]?.data['reason'] ?? '')}`)
  assert.equal(events[0]?.data['task'], 'TASK-16313', '要能反查是哪张卡的那一笔派发')
  assert.equal(typeof events[0]?.data['decidedAt'], 'string', '判定时刻要落盘（否则"那一刻"无从复现）')
  // 读侧：事件承载同样认得（两种承载同一份读数）
  const viaEvent = reuseSkippedOf(journal).filter((row) => row.via === REUSE_SKIPPED_EVENT)
  assert.equal(viaEvent.length, 1, '读侧必须回读得到这条留痕')
  assert.equal(viaEvent[0]?.task, 'TASK-16313', '独立事件自身带所属卡')
})

test('M206-10 ③b `why=true` 回执与正常回执都**逐条三字段**打出「谁没被复用、为什么」', async () => {
  const childSessionId = 'cccc1630-8888-4bbb-8ccc-dddddddddd08'
  TASK163.seedChild(childSessionId, 'TASK-16314', 'stale-mask-7777')
  TASK163.observe(childSessionId)
  writeYamlTask(TASK163.card('TASK-16315'))

  const tools = TASK163.mount()
  // ① 诊断面（`why=true` 不派发）：三条字段必须逐条在回执里
  const why = await TASK163.callTool(tools, 'sdo_plan', { action: 'next', limit: 1, why: true })
  assert.match(why, new RegExp(`childSessionId=${childSessionId}`, 'u'), `诊断面必须点名那个孩子（不许只打数量）：${why.slice(0, 600)}`)
  assert.match(why, /role=developer/u, `诊断面必须带角色（跨角色混在一起正是看不清的主因）：${why.slice(0, 600)}`)
  assert.match(why, /reason=.*掩码/u, `诊断面必须带理由：${why.slice(0, 600)}`)

  // ② 主路径（真派发）：回执同样逐条，不许退化成"有 N 个没被复用"
  const receipt = await TASK163.callTool(tools, 'sdo_plan', { action: 'next', limit: 1, why: false })
  assert.match(receipt, new RegExp(`childSessionId=${childSessionId}`, 'u'), `主路径回执必须逐条列出：${receipt.slice(0, 700)}`)
  assert.match(receipt, /role=developer/u, `主路径回执必须带角色：${receipt.slice(0, 700)}`)
  assert.match(receipt, /reason=.*掩码/u, `主路径回执必须带理由：${receipt.slice(0, 700)}`)
})

test('M206-11 ③c `freshChild=true` 跳过复用 ⇒ 主路径回执**必须点名**并给出可复用孩子的读数（不许静默跳过）', async () => {
  const childSessionId = 'eeee1630-9999-4bbb-8ccc-dddddddddd09'
  // 这个孩子**五条判据全过**（否则"跳过"与"被拒"又混在一起了）
  TASK163.seedChild(childSessionId, 'TASK-16316', maskFingerprint('developer'))
  TASK163.observe(childSessionId)
  writeYamlTask(TASK163.card('TASK-16317'))

  const tools = TASK163.mount()
  // `freshChild=true` 是**调用期参数**（本轮就换人）——插件不能替调用方决定，但也**不许让它静默**：
  // 真机事故（`DEF-139`）就是这条参数把复用分支整个跳过，而台账与回执一个字都没有。
  const receipt = await TASK163.callTool(tools, 'sdo_plan', { action: 'next', limit: 1, freshChild: true })
  assert.match(receipt, /forceNew=true/u, `回执必须点名"本轮强制新起"（否则池里有空闲却新起又成了无解之谜）：${receipt.slice(0, 800)}`)
  // 两个键的口径（`reuseIdle` = **本轮允不允许复用**，`freshChild` 会把它按成 false）：
  // `forceNew=true` ⇒ 被**调用参数**跳过；`reuseIdle=false && forceNew=false` ⇒ 宿主没有续聊入口。
  assert.match(receipt, /reuseIdle=false/u, `两个键必须同屏（本次是"被参数跳过"而不是"宿主没入口"）：${receipt.slice(0, 800)}`)
  assert.match(receipt, /reusableIdle=1/u, `回执必须给出"其实躺着几个可复用孩子"（现算 1 个）：${receipt.slice(0, 800)}`)
  assert.match(receipt, /childrenSource=journal/u, '读数行必须带上 children 来源（来源与结论要同屏）')
  // **不许把"没打算复用"说成"R-1 没有观测证据"**：那个孩子明明被观测过，R-1 那句在这里是假话
  assert.doesNotMatch(receipt, /没有任何可引用/u, '本轮根本没试复用 ⇒ 不许把原因归到 R-1 观测缺失上（用推断替换事实）')
  // 并且真的没复用它（参数被尊重：不许因为"有可复用"就自作主张复用）
  const started = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'dispatch/started').at(-1)
  assert.equal(started?.data['reused'], false, '`freshChild=true` ⇒ 本轮必须新起（复用是优化，不许覆盖调用方的决定）')
  assert.notEqual(started?.data['childSessionId'], childSessionId, '新起的子会话与那个可复用孩子不是同一个')
  assert.equal(started?.data['forceNew'], true, '定案键必须落进事件（回执只是同屏投影）')
})
