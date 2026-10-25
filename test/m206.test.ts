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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import {
  EXECUTOR_DENIED_TOOLS,
  MASK_FINGERPRINT_VERSION,
  READ_ONLY_INSPECTION_TOOLS,
  isSdoTool,
  listRoleCards,
  maskBacktrack,
  maskFaceOf,
  maskFingerprint,
  maskFingerprintOf,
  maskHashVersion,
} from '../src/domain/roles.js'
import { DELIVERY_FAILED_PREFIX, admitDispatch, foldPoolChildren, poolReading, poolReadingsFingerprint, reuseBlockedReason, reuseSkippedLines, rolePools, reuseSkippedRowsFromEvents } from '../src/domain/pool.js'
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
  /**
   * 宿主桩：`start` 新起、`startContinuable` 建可续聊、`sendMessage` 是**复用**的投递原语。
   *
   * `overrides.sendMessage`（`TASK-208`）：按**候选**逐条决定受理/拒绝 —— 候选重试那条守卫要能踩到
   * "第 1 个不可投、第 2 个可用"与"全部不可投"两种结局，而默认桩一律成功，踩不到。
   */
  mount(overrides: { sendMessage?: (target: string) => Promise<unknown> } = {}): { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[] {
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
      sendMessage: async (_sender: unknown, target: string) => (
        overrides.sendMessage === undefined ? { messageId: 'msg-m206' } : overrides.sendMessage(target)
      ),
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
  /**
   * **`TASK-228`（`REV-116` 必核三② 的连带）之后这一格必须换个桶。**
   *
   * 夹具里那个孩子的掩码是**旧口径**（`stale-mask-0000`）⇒ 本轮真派发时它被判成**永久**不可复用并
   * 一次性退役（`pool/retired`，本卡落点一）⇒ 它已经**不在池里**了，所以 `unusable` 桶现在是 **0**
   * （修前是 1：那时没有退役，它一直躺在"过不了闸门"那一桶里，每轮被重判重记）。
   *
   * 这条断言原本守的是**机制面**——"桶读数能原样穿过台账往返，不是只剩一个总数"——那个机制面一个字
   * 没变，只是要钉**还在池里**的那个桶（真派发新起的那个孩子在飞 ⇒ `busy`），并把"退役真的发生了"
   * 一起钉住（否则"桶变成 0"与"读数坏了"两种现象分不开，正是本卡返工要防的那一类）。
   */
  assert.equal(readings[0]?.buckets['unusable'], 0, 'the legacy-mask candidate is retired in this very round, so it is OUT of the pool (the unusable bucket is 0, not 1)')
  assert.equal(readings[0]?.buckets['busy'], 1, 'the bucket readback still carries a number (the freshly started child is busy) — it is not reduced to a single total')
  assert.equal(
    journal.read().events.filter((event) => String(event.type) === 'pool/retired').length,
    1,
    'and exactly one retirement event records it once (otherwise "bucket is 0" cannot be told apart from "the reading broke")',
  )
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
  /**
   * **`TASK-224` 换了取值入口，断言强度一条没降**：`dispatch/reuse-skipped` 现在是"一行一个原因"
   *（`{ candidates, reasons: [{ reason, count, sampleChildIds }] }`），孩子 id 落在这批候选里而不是事件顶层。
   * 所以三字段与所属卡改为从**读侧展开**（`reuseSkippedRowsFromEvents`，本卡新增的唯一读出口）取 ——
   * 这同时就是"读侧两种形状都认"的正面证据。
   */
  const expanded = reuseSkippedRowsFromEvents(events).rows
  assert.equal(expanded.length, 1, `展开后必须正好一个候选：${JSON.stringify(expanded)}`)
  assert.equal(expanded[0]?.childSessionId, childSessionId, '三条字段之一：孩子 id')
  assert.equal(expanded[0]?.role, 'developer', '三条字段之一：角色')
  assert.match(String(expanded[0]?.reason ?? ''), /掩码/u, `三条字段之一：理由（要读得出是哪道闸门）：${String(expanded[0]?.reason ?? '')}`)
  assert.equal(events[0]?.data['task'], 'TASK-16313', '要能反查是哪张卡的那一笔派发')
  assert.equal(typeof events[0]?.data['decidedAt'], 'string', '判定时刻要落盘（否则"那一刻"无从复现）')
  // **`TASK-224` 核心收益**：这一次派发只写了 1 条事件（修前是一行一个候选）
  assert.equal(events.length, 1, `一次派发只写一条聚合事件：${JSON.stringify(events.map((event) => event.data))}`)
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

/* ————————————————————————————————————————————————————————————————————————————————
 * **增量 208：复用修复（`DEF-185` 候选重试 + `DEF-194` 指纹两段式）**
 *
 * 真机两条读数（复现先行，台账现查）：
 *   ① seq 5298（`dispatch/started`，TASK-185，22:52:20Z）：role=developer、`reused=false`、
 *      `buckets{idle:77, idleSameParent:38, unusable:0}`、`reuseIdle=true`、`forceNew=false`，
 *      而 `reuseSkipped` **只有 1 条**（`b5e60eac… is unavailable`）——「池里有 77 个空闲、全过闸门、
 *      仍然不复用」在台账上**没有任何解释**；
 *   ② 同一候选 `b5e60eac-971a-4da8-866d-ccd9c66abb72` 在 seq **5251 / 5277 / 5299** 三笔派发里
 *      三次被挑中、三次 unavailable、三次新起 —— 准入只挑**一个**候选，失败即降级，池里其余候选
 *      一次都没被投过。
 *
 * 这两格要挡住的退化方向：
 *   · 退回"只试第 1 个候选"（池子看着满、复用事实上关闭）；
 *   · 投递被拒只活在回执里（`idle>0` 与 `reused=false` 又变成无解之谜）；
 *   · 指纹为"无关工具登记"买单（`DEF-194`：整池一次性作废），或反过来把禁令集从指纹里拿掉（`R-7` 回归）。
 * ———————————————————————————————————————————————————————————————————————————————— */

test('M206-12 守卫① 候选重试：第 1 个不可投递、第 2 个可用 ⇒ 复用第 2 个，且 skip 记 1 条（真装配链）', async () => {
  const first = 'aaaa2080-1111-4bbb-8ccc-dddddddd01'
  const second = 'aaaa2080-2222-4bbb-8ccc-dddddddd02'
  // 两个孩子**五条判据全过**（否则"投递失败"与"判据没过"又混在一起）
  TASK163.seedChild(first, 'TASK-20800', maskFingerprint('developer'))
  TASK163.observe(first)
  TASK163.seedChild(second, 'TASK-20801', maskFingerprint('developer'))
  TASK163.observe(second)
  writeYamlTask(TASK163.card('TASK-20802'))

  // ① 准入面：候选是**一条有序队列**（修前只有一个 id —— `reuseCandidateOrder(...).find(...)`）
  const plan = office.poolPlan(call, { reuseIdle: true })
  const row = plan.dispatch.find((item) => item.task.id === 'TASK-20802')
  assert.deepEqual(
    row?.reuseCandidates,
    [first, second],
    `候选必须是**有序队列**（同父优先、其余保持台账顺序）：${JSON.stringify(row)}`,
  )
  assert.equal(row?.reuseChildId, first, '队列第 0 项就是 `reuseChildId`（快路径与队列不许各说一套）')

  // ② 真装配链（`office.poolPlan` + `sdo_plan`）：宿主对第 1 个候选报 unavailable，对第 2 个受理
  const tried: string[] = []
  const tools = TASK163.mount({
    sendMessage: async (target: string) => {
      tried.push(target)
      if (target === first) throw new Error(`subagent "${target}" is unavailable`)
      return { messageId: `msg-${target}` }
    },
  })
  const receipt = await TASK163.callTool(tools, 'sdo_plan', { action: 'next', limit: 1 })

  assert.deepEqual(
    tried,
    [first, second],
    `必须**逐条试**：修前只试第 1 个就降级新起（实际试了 ${tried.join(' → ')}）`,
  )
  const journal = office.journalFor(WORKSPACE)
  const started = journal.read().events.filter((event) => event.type === 'dispatch/started').at(-1)
  assert.equal(started?.data['reused'], true, '第 2 个候选投递成功 ⇒ `reused=true`（修前这里必然 false + 新起一个）')
  assert.equal(started?.data['childSessionId'], second, '复用成功的是**第 2 个**候选（不是第 1 个，也不是新起的）')
  const skipped = started?.data['reuseSkipped'] as { childSessionId: string; role: string; reason: string }[] | undefined
  assert.equal(
    skipped?.length,
    1,
    `第 1 个候选的失败必须**逐条落账**（修前 reused=true ⇒ 恰好零条，池子退化的方向被掩盖）：${JSON.stringify(skipped)}`,
  )
  assert.equal(skipped?.[0]?.childSessionId, first, '落的是**被拒的那个候选**')
  assert.equal(skipped?.[0]?.role, 'developer', '三字段之一：角色')
  assert.match(skipped?.[0]?.reason ?? '', /delivery-failed/u, '稳定字形前缀：读侧靠它把"投递拒"与"闸门拒"分流')
  assert.match(skipped?.[0]?.reason ?? '', /is unavailable/u, '必须带**宿主原话**（不是我们自己编的理由）')
  // 独立事件承载同样逐条（同一份三字段投影，不许一处有一处没有）
  const viaEvent = journal.read().events.filter((event) => String(event.type) === REUSE_SKIPPED_EVENT)
  /**
   * **`TASK-224` 换取值入口、不降强度**：事件从"一行一个候选"变成"一行一个原因"（候选落在
   * `reasons[].sampleChildIds` 里）⇒ 孩子 id 改从**读侧展开**取；同时**新增**"这次只写了 1 条事件"的断言
   * —— 那正是本卡的核心收益（修前每候选一条）。
   */
  assert.equal(viaEvent.length, 1, `一次派发只写一条聚合事件：${JSON.stringify(viaEvent.map((event) => event.data))}`)
  assert.deepEqual(
    reuseSkippedRowsFromEvents(viaEvent).rows.map((row) => row.childSessionId),
    [first],
    `独立事件也要落（读侧两种承载都认）：${JSON.stringify(viaEvent.map((event) => event.data))}`,
  )
  // 回执面：逐条打出"谁没被复用、为什么"
  assert.match(receipt, new RegExp(`childSessionId=${first}`, 'u'), `回执必须点名被拒的候选：${receipt.slice(0, 700)}`)
  assert.match(receipt, /delivery-failed/u, `回执必须带宿主原话那一行：${receipt.slice(0, 700)}`)
  // 读侧回读
  // **`REV-092` #2（作者自核后收紧）**：这里原先是 `back.length >= 1` —— 是**下限**，抓不住"重复落账"。
  // 但**不能**直接照评审建议写成 `=== 1`：实测读侧折出 **2** 条，因为 `reuseSkippedOf` 认**两种承载**
  // 且**刻意不去重**（append-only 的历史读数照实回放）⇒ 承载① `dispatch/started.reuseSkipped` 1 条
  // ＋ 承载② 独立事件 `dispatch/reuse-skipped` 1 条。所以收紧成**逐承载的等式**（严格强于 `=== 1`）：
  // 重复落账 ⇒ 3 条 ⇒ 红；丢一个承载 ⇒ 1 条 ⇒ 红。下面还现场演示这一格的判别力。
  const back = reuseSkippedOf(journal).filter((item) => item.childSessionId === first)
  assert.deepEqual(
    back.map((row) => row.via),
    ['dispatch/started', REUSE_SKIPPED_EVENT],
    `逐承载各一条（读侧不去重是刻意的）：${JSON.stringify(back.map((row) => row.via))}`,
  )
  assert.equal(back.length, 2, `读侧条数是**等式**（不是下限）：${JSON.stringify(back.map((row) => row.via))}`)
  assert.match(back[0]?.reason ?? '', /delivery-failed/u, '回读的那条也要带字形前缀（写侧/读侧不许各说一套）')
  // 判别力自证：往同一承载再落一条"重复记账"，读侧必须变 3 ⇒ 上面的等式立刻红（`>= 1` 抓不住这一格）
  journal.append(REUSE_SKIPPED_EVENT as unknown as Parameters<typeof journal.append>[0], reuseSkippedEventData(
    { childSessionId: first, role: 'developer', reason: `${DELIVERY_FAILED_PREFIX}duplicate bookkeeping (mutation probe)` },
    { task: 'TASK-20802' },
  ))
  const duplicated = reuseSkippedOf(journal).filter((item) => item.childSessionId === first)
  assert.equal(duplicated.length, 3, `重复落账必须让等式失败（否则"下限"这一格等于没断言）：${String(duplicated.length)}`)
})

test('M206-13 守卫② 全部候选不可投递 ⇒ 逐条记 skip + 才新起，且读数能解释（`idle>0` 与 `reused=false` 不再无解释并存）', async () => {
  const first = 'bbbb2080-1111-4bbb-8ccc-dddddddd01'
  const second = 'bbbb2080-2222-4bbb-8ccc-dddddddd02'
  TASK163.seedChild(first, 'TASK-20810', maskFingerprint('developer'))
  TASK163.observe(first)
  TASK163.seedChild(second, 'TASK-20811', maskFingerprint('developer'))
  TASK163.observe(second)
  writeYamlTask(TASK163.card('TASK-20812'))

  const tried: string[] = []
  const tools = TASK163.mount({
    sendMessage: async (target: string) => {
      tried.push(target)
      throw new Error(`subagent "${target}" is unavailable`)
    },
  })
  await TASK163.callTool(tools, 'sdo_plan', { action: 'next', limit: 1 })

  assert.deepEqual(tried, [first, second], `全部候选都要被试过（修前只试第 1 个）：${tried.join(' → ')}`)
  const journal = office.journalFor(WORKSPACE)
  const started = journal.read().events.filter((event) => event.type === 'dispatch/started').at(-1)
  assert.equal(started?.data['reused'], false, '全部候选不可投 ⇒ 不复用')
  assert.equal(started?.data['childSessionId'], 'child-fresh-m206', '全部失败**才**新起（不是第 1 个失败就新起）')
  const skipped = (started?.data['reuseSkipped'] ?? []) as { childSessionId: string; reason: string }[]
  assert.deepEqual(
    skipped.map((item) => item.childSessionId),
    [first, second],
    `**每一条失败各落一行**（修前只有第 1 个候选一条）：${JSON.stringify(skipped)}`,
  )
  assert.ok(skipped.every((item) => /is unavailable/u.test(item.reason)), '每一条都要带宿主原话')

  // **账实一致（落点二）**：下一轮读数里，这两个孩子必须从 `idle` 挪进 `unusable` 桶并带原因 ——
  // 于是「idle>0 且 unusable=0 且 reused=false」这一格**不可能再出现**（`DEF-185` 的症状面被关掉）。
  const dev = office.poolView(call).find((pool) => pool.role === 'developer')
  assert.equal(dev?.idle.length, 0, '投递被拒的两个孩子不许再算"空闲可复用"（它们投不进去）')
  assert.equal(dev?.unusable.length, 2, `两个都得进 unusable 桶（现算 ${String(dev?.unusable.length)}）：${JSON.stringify(dev?.unusable)}`)
  for (const item of dev?.unusable ?? []) {
    assert.match(item.reason, /is unavailable/u, `桶里的原因必须带宿主原话：${item.reason}`)
  }
  // 池容量口径不变：不可复用的孩子**不占池位**（R-1）
  assert.equal(dev?.freeSlots, 4 - (dev?.busy.length ?? 0), `freeSlots = cap − 在飞（不可复用的不占位）：cap=${String(dev?.cap)} busy=${String(dev?.busy.length)}`)
})

test('M206-14 守卫③ 指纹三态：office 登记新工具不动别人 / 某角色 allow 真变只动自己 / 改禁令集 8 个全变（R-7 不回归）', () => {
  const cards = listRoleCards()
  const pick = (code: string): (typeof cards)[number] => {
    const found = cards.find((item) => String(item.code) === code)
    assert.ok(found !== undefined, `角色卡缺 ${code}`)
    return found
  }
  const fingerprintOf = (allow: string[], deny: string[]): string => maskFingerprintOf(maskFaceOf({ allow, deny }))
  const base = new Map(cards.map((card) => [String(card.code), fingerprintOf(card.allow, card.deny)]))

  // (a) **只给 office 登记一个新工具** ⇒ 其余角色的指纹**逐字不变**（`DEF-194` 的病根就从这里关掉）
  const officeCard = pick('office')
  const officeAfter = fingerprintOf([...officeCard.allow, 'sdo_probe_registered'], officeCard.deny)
  assert.notEqual(officeAfter, base.get('office'), 'office 自己的面真变了 ⇒ 它的指纹必须变（保守方向）')
  for (const code of ['developer', 'reviewer', 'tester']) {
    const card = pick(code)
    assert.equal(
      fingerprintOf(card.allow, card.deny),
      base.get(code),
      `${code} 的面一个字没变 ⇒ 指纹必须**逐字不变**（修前它跟着别人一起变，整池作废）`,
    )
  }

  // (b) **某角色 allow 真变** ⇒ 只有它自己变（有效面变宽 ⇒ 旧会话缺这项能力，拒复用是对的）
  const developer = pick('developer')
  // 取一个**没被任何角色声明**的名字（`bash` 已经在 developer 的 allow 里，加它是空操作 ⇒ 测不出东西）
  const developerAfter = fingerprintOf([...developer.allow, 'sdo_allow_probe'], developer.deny)
  assert.notEqual(developerAfter, base.get('developer'), 'developer 的面真变了 ⇒ 它自己的指纹必须变')
  for (const code of ['reviewer', 'tester', 'office']) {
    const card = pick(code)
    assert.equal(fingerprintOf(card.allow, card.deny), base.get(code), `${code} 没变 ⇒ 不许被连坐`)
  }

  // (c) **改禁令集 ⇒ 8 个角色一起变**（`R-7`：禁令上线前创建的会话不许被判"指纹一致"）
  const before = new Map(cards.map((card) => [String(card.code), maskFingerprint(card.code)]))
  const forbidden = EXECUTOR_DENIED_TOOLS as unknown as string[]
  forbidden.push('probe_forbidden_tool')
  try {
    for (const card of cards) {
      assert.notEqual(
        maskFingerprint(card.code),
        before.get(String(card.code)),
        `${String(card.code)} 的指纹必须随禁令集一起变（把禁令从指纹里拿掉就是 R-7 回归）`,
      )
    }
    // 行为面：禁令变化**之前**算出来的指纹不再被承认（旧会话公告面里握着被禁工具）
    const staleChild: PoolChild = {
      childSessionId: 'forbidden-stale', role: 'developer', task: 'TASK-20820', mode: 'continuable',
      state: 'idle', rounds: 1, startedAt: '', finishedAt: '', maskHash: before.get('developer') ?? '',
    }
    const pools = rolePools({
      children: [staleChild], roles: ['developer'], caps: {}, defaultCap: 4,
      maskHashOf: (role) => maskFingerprint(role as Parameters<typeof maskFingerprint>[0]),
    })
    assert.equal(pools[0]?.idle.length, 0, '禁令变化前的会话不算可复用')
    assert.match(pools[0]?.unusable[0]?.reason ?? '', /掩码已变更/u, '理由要读得出来')
  } finally {
    forbidden.pop()
  }
  // 撤销变异后必须**逐字回到原值**（否则同文件后面的用例读到脏状态）
  for (const card of cards) {
    assert.equal(maskFingerprint(card.code), before.get(String(card.code)), `撤销变异之后 ${String(card.code)} 必须回到原值`)
  }
})

test('M206-15 落点五 v2 回溯：从已存的 `sdoAllow`/`deny` 现算面 —— 能证成才放行，禁令变过就判版本不可比', () => {
  const developer = listRoleCards().find((card) => String(card.code) === 'developer')
  assert.ok(developer !== undefined)
  const sdoFace = maskFaceOf(developer).filter((name) => (
    isSdoTool(name) || (READ_ONLY_INSPECTION_TOOLS as readonly string[]).includes(name)
  ))
  // 旧事件的**真实形状**：`sdoAllow` = 当时的 SDO 流程面白名单；`deny` = 当时实际下发的完整 deny 面
  const coveringDeny = [...EXECUTOR_DENIED_TOOLS, ...developer.deny]

  // ① 能证成 ⇒ 放行（不需要重建池：面是从**已存事件**现算的）
  const ok = maskBacktrack('developer', { sdoAllow: sdoFace, deny: coveringDeny })
  assert.equal(ok.reusable, true, `禁令集与角色 deny 都被已存 deny 覆盖 + 子面相等 ⇒ 可以放行：${ok.detail}`)
  assert.deepEqual(ok.face, [...sdoFace].sort(), '现算的面就是"只读检视面 ∪ 已存 sdoAllow − 已存 deny"')
  const legacyHash = createHash('sha1').update('legacy-mask-v1').digest('hex').slice(0, 12)
  const reusableChild: PoolChild = {
    childSessionId: 'legacy-ok', role: 'developer', task: 'TASK-20830', mode: 'continuable', state: 'idle',
    rounds: 1, startedAt: '', finishedAt: '', maskHash: legacyHash, sdoAllow: sdoFace, deny: coveringDeny,
  }
  assert.equal(
    reuseBlockedReason(reusableChild, maskFingerprint('developer')),
    undefined,
    '旧口径会话在"面能被证成一致"时必须**放行**（否则口径升级 = 整池一次性作废，正是 DEF-194 反对的代价）',
  )

  // ② 反例（诚实边界）：已存 deny 里少了今天的一条禁令 ⇒ **版本不可比 ⇒ 保守不复用**，并点名是哪条
  const missingForbid = coveringDeny.filter((name) => name !== 'failure_forgive')
  const notComparable = maskBacktrack('developer', { sdoAllow: sdoFace, deny: missingForbid })
  assert.equal(notComparable.reusable, false, '旧事件没有当时禁令集的副本 ⇒ 证不成就不许放行')
  assert.match(notComparable.detail, /failure_forgive/u, '理由必须点名缺的是哪一条禁令')
  assert.match(notComparable.detail, /版本不可比/u, '回执口径：版本不可比（不是"面一定变了"）')
  const blocked = reuseBlockedReason(
    { ...reusableChild, childSessionId: 'legacy-forbid', deny: missingForbid },
    maskFingerprint('developer'),
  )
  assert.match(blocked ?? '', /掩码已变更/u, '不放行时仍走既有的"掩码已变更"理由（与池视图逐字同源）')
  assert.match(blocked ?? '', /failure_forgive/u, '坑在哪要写在台账上，别让人再反推一次')

  // ③ 反例：已存面少了该角色的一条 sdo 工具 ⇒ 面不等（旧会话缺这项能力）⇒ 也不放行
  const droppedSdo = sdoFace.find(isSdoTool)
  assert.ok(droppedSdo !== undefined, '前置：developer 的 sdo 面里确实有工具')
  const narrower = maskBacktrack('developer', { sdoAllow: sdoFace.filter((name) => name !== droppedSdo), deny: coveringDeny })
  assert.equal(narrower.reusable, false, `旧会话缺 ${droppedSdo} ⇒ 面不等 ⇒ 不复用`)

  // ④ 版本号三态：v2 带前缀、旧值认不出（"两种口径长得一样"就是 DEF-194 的病根）
  assert.equal(maskHashVersion(maskFingerprint('developer')), MASK_FINGERPRINT_VERSION, 'v2 指纹必须自带版本号')
  assert.equal(maskHashVersion('214659061731'), 0, '台账里的旧值（12 位十六进制、无前缀）按版本未知读')
})

test('M206-16 守卫⑤ 创建时的指纹**不被复用那笔覆盖**（覆盖 ⇒ 旧会话被洗白、R-7 的雪球口子）', () => {
  const childSessionId = 'ffff2080-1111-4bbb-8ccc-dddddddd01'
  // 创建时那一笔：一个**与当前不同**的 v2 指纹（代表"这个会话诞生于旧面"）
  const createdWith = '2:000000000000'
  office.recordDispatchStarted(call, {
    taskId: 'TASK-20840', provider: 'spawn', childSessionId, parentSessionId: 's-m206',
    tools: 3, role: 'developer', mode: 'continuable', maskHash: createdWith,
  })
  office.journalFor(WORKSPACE).append('dispatch/finished', { task: 'TASK-20840', childSessionId })
  // 之后这个会话被**成功复用**一次：那一笔记的是"派发那一刻的角色面"（当前指纹），**不是**这个会话的面
  office.recordDispatchStarted(call, {
    taskId: 'TASK-20841', provider: 'spawn', childSessionId, parentSessionId: 's-m206',
    tools: 3, role: 'developer', mode: 'continuable', maskHash: maskFingerprint('developer'), reused: true,
  })
  office.journalFor(WORKSPACE).append('dispatch/finished', { task: 'TASK-20841', childSessionId })

  const children = [...foldPoolChildren(office.journalFor(WORKSPACE).read().events.map((event) => ({
    type: event.type, data: event.data, at: event.at,
  }))).values()]
  const child = children.find((item) => item.childSessionId === childSessionId)
  assert.equal(
    child?.maskHash,
    createdWith,
    `复用那一笔**不许覆盖**创建时指纹（覆盖之后这个会话就被"洗白"了）：${String(child?.maskHash)}`,
  )
  // 行为面：所以它仍然被判"掩码已变更"，不会被永久复用（修前那种雪球）
  const pools = rolePools({
    children, roles: ['developer'], caps: {}, defaultCap: 4,
    maskHashOf: () => maskFingerprint('developer'),
  })
  assert.equal(pools[0]?.idle.length, 0, '创建于旧面的会话不许因为"被复用成功过一次"就变成可复用')
  assert.match(pools[0]?.unusable[0]?.reason ?? '', /掩码已变更/u, `理由要读得出来：${pools[0]?.unusable[0]?.reason ?? ''}`)
})
