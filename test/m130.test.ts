/**
 * **增量 130：复用余量与复用自述（DEF-069 + DEF-041，2026-10-14 机制缺陷批 §3B 收口）**。
 *
 * **DEF-069**：池内复用**不看会话余量** —— 真机把同一个子会话用到 **34 轮 / 20 张卡**，
 * 末两次派发一次零改动、一次只落 1/5 落点，而回执只写「复用了同一个子代理」。
 * 修法：折叠时数**轮数与不同卡数**；`dispatch/decided` 与回执把它们印出来；
 * 复用准入加**项目声明式**阈值（`reuseMaxRounds`，默认 0 = 未声明 ⇒ 不判，插件不写死数字）。
 *
 * **DEF-041**：`freshChild=true` 且池内有同角色空闲会话时**不劝阻**（实测连续 22 次不复用、堆 28 个会话）；
 * 回执缺少"复用还是新起 + 池内计数 + 每个未复用候选的原因"的自述。
 * 修法：新起时印 `新起（未复用）+ 池内可复用 N + 未复用候选与原因`；`freshChild` 且有可复用空闲时**劝阻**
 *（只提示，不改决策）。
 *
 * **先钉红**：修前 `PoolChild` 只有 `rounds`（没有卡数）、没有任何复用余量阈值（`reuseMaxRounds` 不存在）、
 * `freshChild` 静默照办、回执对新起**零自述**。
 *
 * **不得回退**：阈值默认 0 ⇒ 未声明项目的行为**逐字不变**；池视图与准入必须走**同一个** `reuseBlockedReason`。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { admitDispatch, foldPoolChildren, rolePools, reuseBlockedReason } from '../src/domain/pool.js'
import type { PoolChild } from '../src/domain/pool.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m130/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>
const call = { sessionId: 'me', cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string, writeScopes: string[] = ['src/x/']): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes,
    role: 'developer',
    size: 'small',
    revision: 1,
    status: 'ready',
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
  }
}

function childOf(overrides: Partial<PoolChild> = {}): PoolChild {
  return {
    childSessionId: 'sess0001',
    role: 'developer',
    task: 'TASK-001',
    mode: 'continuable',
    state: 'idle',
    rounds: 1,
    cards: 1,
    startedAt: '2026-10-14T10:00:00.000Z',
    finishedAt: '2026-10-14T10:01:00.000Z',
    maskHash: 'H',
    parentSessionId: 'me',
    ...overrides,
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: 'me', session: { header: { id: 'me', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub }))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('me', WORKSPACE)
  office.init(call, { name: 'M130 复用余量', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['复用余量'],
    scopeOut: ['写死阈值数字'],
    metricsSuccess: ['余量不足不再复用且说明原因'],
    glossary: { 余量: '一个子会话还能承接多少轮/多少张卡' },
  })
  tools = []
  services = {}
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
  services['tools'] = { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M130-01 折叠出轮数与**不同卡数**（卡数必须累积：真机 34 轮 / 20 张卡）', () => {
  const events: { type: string; data: Record<string, unknown>; at: string }[] = []
  for (let index = 0; index < 5; index += 1) {
    events.push({ type: 'dispatch/started', data: { childSessionId: 's', role: 'developer', task: `TASK-${index}`, maskHash: 'H', mode: 'continuable' }, at: '2026-10-14T10:00:00.000Z' })
    events.push({ type: 'dispatch/finished', data: { childSessionId: 's', task: '' }, at: '2026-10-14T10:01:00.000Z' })
  }
  // 同一张卡再做一轮：轮数 +1，卡数**不增**
  events.push({ type: 'dispatch/started', data: { childSessionId: 's', role: 'developer', task: 'TASK-0', maskHash: 'H', mode: 'continuable' }, at: '2026-10-14T10:02:00.000Z' })
  const child = [...foldPoolChildren(events).values()][0]
  assert.equal(child?.rounds, 6, '轮数 = 派发次数')
  assert.equal(child?.cards, 5, '卡数 = **不同**卡数（累积去重，不是当轮那一张）')
})

test('M130-02 项目声明式余量阈值：超限不复用并说明原因；未声明（0）行为逐字不变', () => {
  const child = childOf({ rounds: 7, cards: 4 })
  assert.equal(reuseBlockedReason(child, 'H', undefined, { maxRounds: 0 }), undefined, '未声明 ⇒ 不判（默认行为不变）')
  assert.equal(reuseBlockedReason(child, 'H', undefined, undefined), undefined, '不传 budget ⇒ 不判')
  const byRounds = reuseBlockedReason(child, 'H', undefined, { maxRounds: 5 })
  assert.match(String(byRounds), /7/u, `原因要点名实际轮数：${byRounds}`)
  assert.match(String(byRounds), /5/u, '原因要点名项目声明的上限')
  const byCards = reuseBlockedReason(childOf({ rounds: 1, cards: 9 }), 'H', undefined, { maxCards: 5 })
  assert.match(String(byCards), /9/u, '卡数超限同样要说明')

  // 池视图与准入**同一判据** ⇒ 读数与行为不分叉
  const pools = rolePools({
    children: [child],
    roles: ['developer'],
    caps: { developer: 4 },
    defaultCap: 4,
    maskHashOf: () => 'H',
    viewerSessionId: 'me',
    reuseBudget: { maxRounds: 5 },
  })
  assert.equal(pools[0]?.unusable.length, 1, '池视图必须把超限的说成不可复用')
  assert.match(String(pools[0]?.unusable[0]?.reason), /余量不足/u)
  const admission = admitDispatch({
    ready: [card('TASK-401')],
    pools,
    globalRoom: 2,
    reuseIdle: true,
    maskHashOf: () => 'H',
    reuseBudget: { maxRounds: 5 },
  })
  assert.equal(admission.dispatch[0]?.reuseChildId, undefined, '超限 ⇒ 不得复用（新起）')
})

test('M130-03 配置默认：未声明时 `reuseMaxRounds` = 0，且真的送进池视图与准入', () => {
  const settings = resolveSettings(Config({} as unknown as SdoConfig))
  assert.equal(settings.reuseMaxRounds, 0, '默认必须是"未声明"（插件不写死数字）')
  const declared = resolveSettings(Config({ reuseMaxRounds: 6 } as unknown as SdoConfig))
  assert.equal(declared.reuseMaxRounds, 6, '项目声明要能生效')
  const officeText = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  assert.ok((officeText.match(/reuseBudget: \{ maxRounds: this\.settings\.reuseMaxRounds \}/gu) ?? []).length >= 2, '池视图与准入都要送（同一个值）')
})

test('M130-04 回执自述：新起要说"未复用 + 池内计数 + 候选原因"，freshChild 要劝阻', async () => {
  // 池里有一个**本会话**的可复用空闲子会话（上一轮派过并结算）
  office.recordDispatchStarted(call, {
    taskId: 'TASK-411',
    provider: 'spawn',
    childSessionId: 'pooled001',
    parentSessionId: 'me',
    tools: 3,
    role: 'developer',
    mode: 'continuable',
    maskHash: 'H',
  })
  office.journalFor(WORKSPACE).append('dispatch/finished', { task: 'TASK-411', childSessionId: 'pooled001' })
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-411.yml'], { task: { ...card('TASK-411'), status: 'done' } })

  const text = await callTool('sdo_plan', { action: 'next', limit: 1, freshChild: true })
  assert.match(text, /TASK-411|TASK-41/u, `回执应提到池里的候选（前 8 位 pooled001 或卡号）：${text.slice(0, 400)}`)
  // 语言包（两包）必须带自述与劝阻文案
  for (const name of ['zh-CN.yml', 'en.yml']) {
    const lang = readFileSync(join(ROOT, 'src', 'data', 'lang', name), 'utf8')
    for (const key of ['kDispatchFreshSelf', 'kFreshChildDissuade', 'kFreshNoSkip', 'kReuseRoundsExceeded', 'kReuseCardsExceeded']) {
      assert.match(lang, new RegExp(`${key}:`, 'u'), `${name} 缺 ${key}`)
    }
    assert.match(lang, /kReusedChild: '[^']*\{p5\}/u, `${name} 的复用行必须带**卡数**（DEF-069）`)
  }
})

test('M130-05 防回退：阈值只能走唯一判据，且候选原因不得再被截断成"还有 N 个"', () => {
  const pool = readFileSync(join(ROOT, 'src', 'domain', 'pool.ts'), 'utf8')
  assert.match(pool, /reuseBudget/u, '阈值参数不得被删')
  assert.match(pool, /export function reuseBlockedReason/u)
  const describe = readFileSync(join(ROOT, 'src', 'interface', 'describe.ts'), 'utf8')
  assert.equal(/unusable\.slice\(0, 3\)/u.test(describe), false, '不可复用候选不得再只印前 3 个（DEF-041 要求每个都给原因）')
  assert.match(describe, /kPoolUnusableMore/u, '（保留"还有 N 个"的文案键给别的用途，但不可复用候选这一处不再用）')
})
