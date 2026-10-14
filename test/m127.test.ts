/**
 * **增量 127：派发健康度（DEF-053，2026-10-14 机制缺陷批 §3B）**。
 *
 * 两个形状（缺陷 evidence 里的真机现场，journal 序号可复算）：
 *
 * | # | 形状 | 真机读数 |
 * |---|---|---|
 * | ① | 派发成功 ≠ 卡被认领 | 4 条 `dispatch/started`（界面 4 个子代理在跑）而台账只有 **1 张 `in-progress`** |
 * | ② | **锁的持有者是卡的状态字段，不是活着的会话** | owner 会话已 `dispatch/finished(completed/error)`（seq 2748 / 2762），卡仍 `in-progress` 攥着写范围 |
 *
 * **先钉红**：修前没有任何地方读"owner 会话最近一次派发的终态" —— `claim` 只看 `other.status === 'in-progress'`
 * 与 `writeScopes`（`staleClaims` 按 `updatedAt` 的 TTL 只在状态读数里用，**认领路径不读**）；
 * "派发未认领"也没有任何机械读数与事件。
 *
 * **修法**（不动"失联 owner 不自动释放"这条保守口径 —— 防误抢在跑的人）：
 *   · `orphanLocks()`：卡 `in-progress` 且时间线上**最后一条**相关事件是子会话终态 ⇒ 孤儿锁；
 *   · `claimMissing()`：最近一笔 `dispatch/started` 之后没有 `task/claimed` 且超过窗口 ⇒ 静默失败候选；
 *   · 两者都在 `next` 回执**主动**提示并给**可执行**命令（不再靠撞锁才暴露）；
 *   · 认领被孤儿锁挡住时，回执**就地说明**并给 `release` 命令；
 *   · 静默失败落 `dispatch/claim-missing` 事件（同一笔派发只落一次）——**必须**同时进中性表，
 *     否则 G3 的黑名单口径会把它当成真源变更、误伤已签的字（DEF-039/040 同族）。
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
import { claimMissing, orphanLocks } from '../src/domain/dispatchHealth.js'
import { isSignatureInvalidatingEvent } from '../src/types.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m127/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string, status: TaskCard['status'], writeScopes: string[], overrides: Partial<TaskCard> = {}): TaskCard {
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
    status,
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub }))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M127 派发健康度', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['派发健康度'],
    scopeOut: ['自动释放失联 owner 的锁'],
    metricsSuccess: ['孤儿锁与静默失败都能被点名'],
    glossary: { 孤儿锁: '卡在 in-progress 但拥有它的子会话已结束' },
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

function writeCard(task: TaskCard): void {
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${task.id}.yml`], { task })
}

test('M127-01 孤儿锁：卡在 in-progress 而 owner 会话已结算 ⇒ 点名（含真机两形状）', () => {
  // 形状二之甲（真机 TASK-090）：owner 因上下文耗尽 reason=completed，之后还有 reported
  writeCard(card('TASK-090', 'in-progress', ['src/a.ts'], { owner: 'subagent:developer:1' }))
  // 形状二之乙（真机 TASK-104）：owner 以 reason=error 终态、零产品改动
  writeCard(card('TASK-104', 'in-progress', ['src/b.ts'], { owner: 'subagent:developer:2' }))
  // 反向：**活着**的会话（started 之后没有终态）⇒ 不是孤儿
  writeCard(card('TASK-105', 'in-progress', ['src/c.ts'], { owner: 'subagent:developer:3' }))

  const journal = office.journalFor(WORKSPACE)
  journal.append('task/claimed', { id: 'TASK-090', by: '20af1d60' })
  journal.append('dispatch/started', { task: 'TASK-090', childSessionId: '20af1d60', role: 'developer' })
  journal.append('task/claimed', { id: 'TASK-104', by: '37fd75f0' })
  journal.append('dispatch/started', { task: 'TASK-104', childSessionId: '37fd75f0', role: 'developer' })
  journal.append('dispatch/finished', { task: 'TASK-104', childSessionId: '37fd75f0', reason: 'error' })
  journal.append('dispatch/finished', { task: 'TASK-090', childSessionId: '20af1d60', reason: 'completed' })
  journal.append('dispatch/reported', { task: 'TASK-090', childSessionId: '20af1d60' })
  journal.append('task/claimed', { id: 'TASK-105', by: 'live-session' })
  journal.append('dispatch/started', { task: 'TASK-105', childSessionId: 'live-session', role: 'developer' })

  const orphans = orphanLocks(office.tasks(call), office.journalFor(WORKSPACE).read().events)
  assert.deepEqual(
    orphans.map((row) => row.taskId).sort(),
    ['TASK-090', 'TASK-104'],
    '活着的会话（started 之后没有终态）不得判成孤儿锁',
  )
  const t104 = orphans.find((row) => row.taskId === 'TASK-104')
  assert.equal(t104?.reason, 'error', '要给出终态原因')
  assert.equal(t104?.childSessionId, '37fd75f0', '要给出子会话 id（便于追溯）')
  assert.ok((t104?.atSeq ?? 0) > 0, '要给出可复算的 journal 序号')
  assert.match(t104?.command ?? '', /sdo_task action=release id=TASK-104/u, '要给可执行命令')

  // 释放之后不再是孤儿（时间线上最后一条变成 task/released）
  office.releaseTask(call, { taskId: 'TASK-104', actor: 'office', reason: '所有者会话已死' })
  const after = orphanLocks(office.tasks(call), office.journalFor(WORKSPACE).read().events)
  assert.equal(after.some((row) => row.taskId === 'TASK-104'), false, 'release 之后锁就没了')
})

test('M127-02 认领被孤儿锁挡住 ⇒ 回执就地说明并给 release 命令', async () => {
  writeCard(card('TASK-111', 'in-progress', ['.sdo/reviews/'], { owner: 'subagent:reviewer:4' }))
  const journal = office.journalFor(WORKSPACE)
  journal.append('task/claimed', { id: 'TASK-111', by: 'dead-session' })
  journal.append('dispatch/started', { task: 'TASK-111', childSessionId: 'dead-session', role: 'reviewer' })
  journal.append('dispatch/finished', { task: 'TASK-111', childSessionId: 'dead-session', reason: 'completed' })

  writeCard(card('TASK-112', 'ready', ['.sdo/reviews/']))
  const denied = office.claimTask(call, { taskId: 'TASK-112', owner: 'subagent:reviewer:9', expectedRevision: 1 })
  assert.equal(denied.ok, false)
  if (denied.ok) assert.fail('写范围冲突必须拒绝')
  assert.equal(denied.code, 'write-scope-conflict')
  assert.match(denied.detail, /孤儿锁/u, `要点明这是孤儿锁：${denied.detail}`)
  assert.match(denied.detail, /sdo_task action=release id=TASK-111/u, '要给可执行的释放命令')
  assert.match(denied.detail, /completed/u, '要给出 owner 会话的终态原因')
})

test('M127-03 派发未认领：窗口后仍无 task/claimed ⇒ 点名；认领或终态都改变结论', () => {
  writeCard(card('TASK-121', 'ready', ['src/a.ts']))
  writeCard(card('TASK-122', 'ready', ['src/b.ts']))
  writeCard(card('TASK-123', 'ready', ['src/c.ts']))
  const journal = office.journalFor(WORKSPACE)
  journal.append('dispatch/started', { task: 'TASK-121', childSessionId: 'c1', role: 'developer' })
  journal.append('dispatch/started', { task: 'TASK-122', childSessionId: 'c2', role: 'developer' })
  journal.append('task/claimed', { id: 'TASK-122', by: 'c2' })
  journal.append('dispatch/started', { task: 'TASK-123', childSessionId: 'c3', role: 'developer' })

  const events = office.journalFor(WORKSPACE).read().events
  // 用**事件自身的时间**推算，避免依赖"现在是几点"（journal 的 at 由写入时刻决定）
  const startedAtMs = events.find((event) => event.type === 'dispatch/started' && event.data['task'] === 'TASK-121')?.at
  const baseMs = Date.parse(String(startedAtMs))
  assert.ok(Number.isFinite(baseMs), '夹具前提：要能取到 dispatch/started 的时间')
  const rows = claimMissing(office.tasks(call), events, { nowMs: baseMs + 20 * 60_000, windowMs: 5 * 60_000 })
  assert.deepEqual(rows.map((row) => row.taskId), ['TASK-121', 'TASK-123'], '认领过的 TASK-122 不得算静默失败')
  assert.equal(rows[0]?.ended, false, '刚派出去、会话还在跑 ⇒ ended=false')
  assert.ok((rows[0]?.minutes ?? 0) >= 0)

  // 窗口内不判（避免把"刚派出去"误报）
  const early = claimMissing(office.tasks(call), events, { nowMs: baseMs + 60_000, windowMs: 5 * 60_000 })
  assert.deepEqual(early.map((row) => row.taskId), [], '窗口内不报（那时它还没到"静默失败"）')

  // 会话结算了但没认领 ⇒ 仍是静默失败，且原因可诊断
  journal.append('dispatch/finished', { task: 'TASK-121', childSessionId: 'c1', reason: 'completed' })
  const withTerminal = claimMissing(office.tasks(call), office.journalFor(WORKSPACE).read().events, {
    nowMs: baseMs + 20 * 60_000,
    windowMs: 5 * 60_000,
  })
  const t121 = withTerminal.find((row) => row.taskId === 'TASK-121')
  assert.equal(t121?.ended, true, '会话已结算 ⇒ ended=true')
  assert.equal(t121?.reason, 'completed', '原因要带出来')
})

test('M127-04 静默失败落事件：幂等 + 必须否掉 G3 失效（否则误伤已签的字）', () => {
  writeCard(card('TASK-131', 'ready', ['src/a.ts']))
  office.journalFor(WORKSPACE).append('dispatch/started', { task: 'TASK-131', childSessionId: 'c1', role: 'developer' })

  const health = office.dispatchHealth(call, { nowMs: Date.now() + 60 * 60_000, claimWindowMs: 5 * 60_000 })
  assert.equal(health.claimMissing.length, 1, '夹具前提：窗口后应有一条静默失败')

  assert.equal(office.noteClaimMissing(call, health.claimMissing), 1, '第一次落一条')
  assert.equal(office.noteClaimMissing(call, health.claimMissing), 0, '同一笔派发只落一次（按 startedSeq 去重）')
  const events = office.journalFor(WORKSPACE).read().events
  const noted = events.filter((event) => event.type === 'dispatch/claim-missing')
  assert.equal(noted.length, 1)
  assert.equal(noted[0]?.data['task'], 'TASK-131')

  // **关键**：G3 用黑名单口径（不在中性表里即视为真源变更）⇒ 新事件必须在中性表里
  assert.equal(
    isSignatureInvalidatingEvent('G3', 'dispatch/claim-missing'),
    false,
    'dispatch/claim-missing 必须进中性表，否则每次静默失败都会作废 G3 签字',
  )
})

test('M127-05 主动面：`next` 回执要点名孤儿锁并给出可执行命令', async () => {
  writeCard(card('TASK-141', 'in-progress', ['src/a.ts'], { owner: 'subagent:developer:1' }))
  const journal = office.journalFor(WORKSPACE)
  journal.append('task/claimed', { id: 'TASK-141', by: 'dead' })
  journal.append('dispatch/started', { task: 'TASK-141', childSessionId: 'dead', role: 'developer' })
  journal.append('dispatch/finished', { task: 'TASK-141', childSessionId: 'dead', reason: 'completed' })
  writeCard(card('TASK-142', 'ready', ['src/b.ts']))

  const receipt = await callTool('sdo_plan', { action: 'next', limit: 1, why: true })
  assert.match(receipt, /孤儿锁/u, `回执必须主动提示孤儿锁（不再靠撞锁才暴露）：${receipt.slice(0, 300)}`)
  assert.match(receipt, /TASK-141/u, '要点名是哪张卡的锁')
  assert.match(receipt, /sdo_task action=release id=TASK-141/u, '要给可执行命令')

  // 源码级防回退：回执必须把这段接上（四条返回路径都接）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.ok((index.match(/healthSection/gu) ?? []).length >= 4, 'healthSection 必须接进各条回执路径')
  // 域层防回退：认领拒绝必须能说孤儿
  const collab = readFileSync(join(ROOT, 'src', 'domain', 'collab.ts'), 'utf8')
  assert.match(collab, /kScopeConflictOrphan/u, '认领拒绝的孤儿分支不得被删')
})
