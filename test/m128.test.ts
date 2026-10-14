/**
 * **增量 128：池读数与派发器同源（DEF-066，2026-10-14 机制缺陷批 §3B）**。
 *
 * 缺陷现场（驾驶舱 2026-10-14 补证，逐条可复算）：
 *   · 本会话共派发 6 次，`dispatch/started` **全部** `provider=spawn`、回执逐字写「新起了一个子代理（未复用）」，
 *     而**从未传过** `freshChild=true`；
 *   · 与此同时 `sdo_status` 报「developer：**空闲可复用 31**」⇒ **读数与行为直接矛盾**；
 *   · 根因：那 31 个空闲子会话是**上一任驾驶舱**（另一个父会话）派的，宿主对跨父会话一律拒
 *     （原文 `belongs to another parent session`）⇒ 它们**永远不可能**被本会话复用。
 *
 * 另半个形状：owner 记的是**槽位名**（`subagent:developer:N`），实测同一槽位被 33 个会话用过
 * ⇒ 无法唯一定位实现者，唯一定位靠**会话 uuid**。
 *
 * **先钉红**：修前 `dispatch/started` **不记父会话**、`RolePool` 也没有"本会话/跨父/未知"分栏
 * ⇒ 读数只能把所有 continuable 空闲都算成"可复用"（31 vs 永远 spawn）。
 *
 * **修法**（不改容量语义：`idle` 与 `freeSlots` 与修前逐字一致，只**如实分栏**）：
 *   · `dispatch/started` 追加 `parentSessionId`；`PoolChild.parentSessionId` 从事件折叠；
 *   · `RolePool` 增 `idleSameParent` / `idleForeign` / `idleUnknownParent`；
 *   · 回执分栏打印 + 在飞给 `卡→子会话前 8 位`（owner 槽位名不唯一）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { foldPoolChildren, rolePools } from '../src/domain/pool.js'
import { describePoolBlock } from '../src/interface/describe.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m128/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 'me', cwd: WORKSPACE } as unknown as OfficeCall

/** 造一条 `dispatch/started`（带掩码指纹 ⇒ 通过"可复用形状"这一关）。 */
function started(child: string, parent: string, extra: Record<string, unknown> = {}): { type: string; data: Record<string, unknown>; at: string } {
  return {
    type: 'dispatch/started',
    data: { childSessionId: child, role: 'developer', task: `TASK-${child}`, maskHash: 'H', mode: 'continuable', ...(parent === '' ? {} : { parentSessionId: parent }), ...extra },
    at: '2026-10-14T10:00:00.000Z',
  }
}

function finished(child: string, parent: string): { type: string; data: Record<string, unknown>; at: string } {
  return { type: 'dispatch/finished', data: { childSessionId: child, parentSessionId: parent }, at: '2026-10-14T10:01:00.000Z' }
}

function poolsOf(events: readonly { type: string; data: Record<string, unknown>; at: string }[], viewer: string) {
  return rolePools({
    children: [...foldPoolChildren(events).values()],
    roles: ['developer'],
    caps: { developer: 4 },
    defaultCap: 4,
    maskHashOf: () => 'H',
    viewerSessionId: viewer,
  })
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M128 池读数', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['池读数与派发器同源'],
    scopeOut: ['改容量语义'],
    metricsSuccess: ['跨父会话不再算作可复用'],
    glossary: { 跨父会话: '宿主只允许父会话复用自己起的子会话' },
  })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M128-01 派发记录带父会话：写了就落、没写就不落（老事件兼容）', () => {
  office.recordDispatchStarted(call, {
    taskId: 'TASK-201',
    provider: 'spawn',
    childSessionId: 'aaaa1111',
    parentSessionId: 'me',
    tools: 3,
    role: 'developer',
    mode: 'continuable',
    maskHash: 'H',
  })
  office.recordDispatchStarted(call, {
    taskId: 'TASK-202',
    provider: 'spawn',
    childSessionId: 'bbbb2222',
    tools: 3,
    role: 'developer',
    mode: 'continuable',
    maskHash: 'H',
  })
  const events = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'dispatch/started')
  assert.equal(events[0]?.data['parentSessionId'], 'me', '派发记录必须能答"谁派的"')
  assert.equal('parentSessionId' in (events[1]?.data ?? {}), false, '没给就不写（老事件形态，读侧当未知）')
})

test('M128-02 池分栏：本会话 / 跨父会话 / 父会话未知 —— 且容量语义一字不改', () => {
  const events = [
    started('aaaa1111', 'other'),
    finished('aaaa1111', 'other'),
    started('bbbb2222', 'other'),
    finished('bbbb2222', 'other'),
    started('cccc3333', 'me'),
    finished('cccc3333', 'me'),
    started('dddd4444', 'me'), // 在飞
    started('eeee5555', ''), // 老事件：父会话未知
    finished('eeee5555', ''),
  ]
  const pool = poolsOf(events, 'me')[0]
  assert.ok(pool !== undefined)
  assert.equal(pool.idle.length, 4, '`idle`（可复用形状）与修前一致：4 个（含"父会话未知"那个）')
  // **真不变量**：分栏必须**穷尽** `idle`（漏一个就等于又把"看起来能复用"混回去了）
  assert.equal(
    pool.idleSameParent.length + pool.idleForeign.length + pool.idleUnknownParent,
    pool.idle.length,
    '三分之和必须等于 idle 总数',
  )
  assert.deepEqual(pool.idleSameParent.map((child) => child.childSessionId), ['cccc3333'], '只有本会话派的那一个是真能投的')
  assert.deepEqual(pool.idleForeign.map((child) => child.childSessionId).sort(), ['aaaa1111', 'bbbb2222'], '跨父会话如实分栏')
  assert.equal(pool.idleUnknownParent, 1, '老事件（无父会话）保守算未知')
  assert.equal(pool.busy.length, 1, '在飞仍只有 dddd4444')
  assert.equal(pool.freeSlots, Math.max(0, pool.cap - pool.busy.length - pool.idle.length), 'freeSlots 口径不变（容量语义不动）')

  // 不传观察者 ⇒ 不分栏（行为与加字段之前一致）
  const legacy = poolsOf(events, '')[0]
  assert.equal(legacy?.idleForeign.length, 0)
  assert.equal(legacy?.idleUnknownParent, 0)
})

test('M128-03 回执：分栏行 + 在飞 `卡→子会话前 8 位` 都要出现（owner 槽位名不唯一）', () => {
  const events = [
    started('aaaa1111', 'other'),
    finished('aaaa1111', 'other'),
    started('cccc3333', 'me'),
    finished('cccc3333', 'me'),
    started('dddd4444', 'me'),
  ]
  const pools = poolsOf(events, 'me')
  const text = describePoolBlock(pools, [], true, 60)
  assert.match(text, /本会话/u, `必须分栏说明哪些真能投：${text}`)
  assert.match(text, /跨父会话/u, '必须如实标注跨父会话不可达')
  assert.match(text, /cccc3333/u, '本会话可复用的子会话要点名（前 8 位）')
  assert.match(text, /dddd4444/u, '在飞定位要给子会话 uuid 前 8 位')

  for (const name of ['zh-CN.yml', 'en.yml']) {
    const lang = readFileSync(join(ROOT, 'src', 'data', 'lang', name), 'utf8')
    for (const key of ['kPoolIdleScope', 'kPoolBusyMap', 'kPoolIdleNone']) {
      assert.match(lang, new RegExp(`${key}:`, 'u'), `${name} 缺 ${key}`)
    }
  }
})

test('M128-04 真机矛盾的正面判据：跨父会话**绝不**落进"本会话可复用"', () => {
  // 31 个上一任驾驶舱派的空闲会话（这里缩成 3 个，形状一致）
  const events = ['x1', 'x2', 'x3'].flatMap((id) => [started(id, 'previous-cockpit'), finished(id, 'previous-cockpit')])
  events.push(started('mine0001', 'me'), finished('mine0001', 'me'))
  const pool = poolsOf(events, 'me')[0]
  assert.equal(pool?.idle.length, 4)
  assert.equal(pool?.idleSameParent.length, 1, '只有本会话那一个算"真能投"')
  assert.equal(pool?.idleForeign.length, 3, '上一任驾驶舱派的必须单列（否则读数又会与行为矛盾）')
  const text = describePoolBlock(poolsOf(events, 'me'), [], true, 60)
  assert.match(text, /空闲可复用 4/u, '总数照旧如实报')
  assert.match(text, /属于\*\*本会话\*\*（真能投：mine0001）/u, '并说清只有一个真能投')
})

test('M128-05 防回退：派发必须记父会话、池读数必须传观察者', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /parentSessionId: call\.sessionId/u, '派发路径必须把父会话写进记录')
  const officeText = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  assert.match(officeText, /viewerSessionId: call\.sessionId/u, '池快照必须把观察者会话传下去（否则分栏永远为空）')
  const pool = readFileSync(join(ROOT, 'src', 'domain', 'pool.ts'), 'utf8')
  assert.match(pool, /idleSameParent/u, '分栏字段不得被删')
})
