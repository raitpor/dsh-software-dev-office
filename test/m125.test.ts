/**
 * **增量 125：派发前置检查（DEF-067，2026-10-14 机制缺陷批 §3A）**。
 *
 * 不变量（ADR-009 拟定）：**一张卡被派出时，它必须能够认领成功** ——
 * 「可派发」= 依赖已满足 **∧** 写范围不与任何在飞卡相交。
 *
 * 旧实现只查 `blockedBy` ⇒ 派出**注定认领失败**的卡。真机现场（交接文档 §1.1）：
 * 驾驶舱 `next limit=3` 派三张核实卡，三张写同一批文件，两张认领失败（`scope-locked`）、
 * 各白烧一轮会话（`journal` seq 2867–2872）。
 *
 * **先钉红**（修前，`office.dispatchPlan` / `poolPlan` 的候选集）：
 *   · 在飞卡持 `src/a.ts` 时，`ready` 卡 `src/a.ts` ⇒ **仍被派**（应挡）
 *   · 回执里**没有**任何"暂不可派"行（应单列一行并点名在飞卡与重叠路径 —— DEF-058 的误判来源）
 *
 * **修后**：被挡的卡不进派发集，且回执多一行 `🔒 暂不可派 …`；`src/a.ts` × `src/a.tsx`
 * 这种**文件名前缀**不算相交（DEF-057 的口径，同一个判定出口）。
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
import { scopeHeldTasks } from '../src/domain/plan.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m125/', import.meta.url))
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

function baseCard(id: string, status: TaskCard['status'], writeScopes: string[], overrides: Partial<TaskCard> = {}): TaskCard {
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

function writeCard(task: TaskCard): void {
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${task.id}.yml`], { task })
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
  office.init(call, { name: 'M125 派发前置检查', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['派发前置检查'],
    scopeOut: ['自动改 blockedBy'],
    metricsSuccess: ['派出即能认领'],
    glossary: { 在飞卡: '已认领、正在做的卡' },
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

test('M125-01 scopeHeldTasks：同路径挡、文件名前缀不挡、显式声明先后不挡', () => {
  const tasks = [
    baseCard('TASK-911', 'in-progress', ['.sdo/reviews/']),
    baseCard('TASK-912', 'ready', ['.sdo/reviews/']),
    baseCard('TASK-913', 'ready', ['src/a.tsx']),
    baseCard('TASK-914', 'ready', ['src/a.ts'], { blockedBy: ['TASK-911'] }),
  ]
  // 让 913 与在飞卡互为文件名前缀：把在飞卡的写范围设成 src/a.ts 才能测这条
  const prefixFixture = [
    baseCard('TASK-921', 'in-progress', ['src/a.ts']),
    baseCard('TASK-922', 'ready', ['src/a.tsx']),
    baseCard('TASK-923', 'ready', ['src/a.ts']),
  ]
  const held = scopeHeldTasks(tasks).map((row) => row.task.id)
  assert.deepEqual(held, ['TASK-912'], '只有同一路径的卡被挡；blockedBy 声明过的不算意外挡路')
  const heldPrefix = scopeHeldTasks(prefixFixture).map((row) => [row.task.id, row.holder.id, row.overlap])
  assert.deepEqual(heldPrefix, [['TASK-923', 'TASK-921', ['src/a.ts']]], 'src/a.tsx 是另一个路径，不挡；重叠路径要点名')
})

test('M125-02 dispatchPlan：被在飞卡挡住的卡不进派发集，且点名 holder 与重叠路径', async () => {
  const holder = baseCard('TASK-931', 'ready', ['src/a.ts'])
  writeCard(holder)
  const claimed = office.claimTask(call, { taskId: 'TASK-931', owner: 'subagent:developer:1', expectedRevision: 1 })
  assert.equal(claimed.ok, true, `夹具前提：先有一张在飞卡（${JSON.stringify(claimed).slice(0, 120)}）`)

  writeCard(baseCard('TASK-932', 'ready', ['src/a.ts']))
  writeCard(baseCard('TASK-933', 'ready', ['src/b.ts']))

  const plan = office.dispatchPlan(call, 4)
  const dispatched = plan.dispatch.map((task) => task.id)
  assert.equal(dispatched.includes('TASK-932'), false, '写范围与在飞卡相交的卡**不得**被派出（派了也认领失败）')
  assert.equal(dispatched.includes('TASK-933'), true, '不相交的卡照旧可派')
  const row = plan.held.find((item) => item.task.id === 'TASK-932')
  assert.ok(row !== undefined, 'held 必须回读被挡的卡')
  assert.equal(row?.holder.id, 'TASK-931')
  assert.deepEqual(row?.overlap, ['src/a.ts'], '重叠路径要点名')
})

test('M125-03 poolPlan：heldByScope 回读（卡 id、挡路的卡与 owner、重叠路径）', async () => {
  writeCard(baseCard('TASK-941', 'ready', ['.sdo/reviews/']))
  const claimed = office.claimTask(call, { taskId: 'TASK-941', owner: 'subagent:developer:9', expectedRevision: 1 })
  assert.equal(claimed.ok, true)
  writeCard(baseCard('TASK-942', 'ready', ['.sdo/reviews/']))

  const admission = office.poolPlan(call, { reuseIdle: false })
  assert.equal(
    admission.dispatch.some((entry) => entry.task.id === 'TASK-942'),
    false,
    '被挡的卡不得进派发集',
  )
  const rows = admission.heldByScope ?? []
  assert.equal(rows.length, 1, `必须回读一条 heldByScope（实际 ${JSON.stringify(rows)}）`)
  assert.equal(rows[0]?.taskId, 'TASK-942')
  assert.equal(rows[0]?.holderId, 'TASK-941')
  assert.equal(rows[0]?.holderOwner, 'subagent:developer:9', 'owner 要能指向人（便于找人让路）')
  assert.deepEqual(rows[0]?.overlap, ['.sdo/reviews'])
})

test('M125-04 工具回执：主派发回执必须单列一行「暂不可派」并点名在飞卡与重叠路径', async () => {
  writeCard(baseCard('TASK-951', 'ready', ['src/a.ts']))
  const claimed = office.claimTask(call, { taskId: 'TASK-951', owner: 'subagent:developer:4', expectedRevision: 1 })
  assert.equal(claimed.ok, true)
  writeCard(baseCard('TASK-952', 'ready', ['src/a.ts']))
  writeCard(baseCard('TASK-953', 'ready', ['src/b.ts']))

  // **注意 `why`**：`why=true` 是**诊断面**（TASK-078 设计：它不派发任何卡）⇒ 要验"派出去了哪些、
  // 挡下了哪些"必须走**普通**回执（这正是主路径以前看不见"某卡没派出去"的原因）。
  const receipt = await callTool('sdo_plan', { action: 'next', limit: 1 })
  assert.match(receipt, /claim id=TASK-953/u, `可派的卡必须真的被派：${receipt.slice(0, 300)}`)
  const heldLines = receipt.split('\n').filter((line) => line.includes('暂不可派'))
  assert.equal(heldLines.length, 1, `被挡的卡必须**单列一行**点名（实际 ${heldLines.length} 行）：${receipt.slice(0, 400)}`)
  assert.match(heldLines[0] ?? '', /TASK-952/u, '要点名被挡的卡')
  assert.match(heldLines[0] ?? '', /TASK-951/u, '要点名挡住它的在飞卡')
  assert.match(heldLines[0] ?? '', /src\/a\.ts/u, '要点名重叠的那个路径')
  assert.equal(receipt.includes('claim id=TASK-952'), false, '被挡的卡不得被下发认领指令')

  // 诊断面同样可见（`why=true` 不派发，但必须说清谁被挡、被谁挡）
  const why = await callTool('sdo_plan', { action: 'next', limit: 1, why: true })
  assert.ok(why.includes('暂不可派') && why.includes('TASK-952'), `诊断面也要点名被挡的卡：${why.slice(0, 300)}`)
})

test('M125-05 落点三：计划读数的修法文案必须给"把该路径拆成独立卡"这条处置', () => {
  const zh = readFileSync(join(ROOT, 'src', 'data', 'lang', 'zh-CN.yml'), 'utf8')
  const en = readFileSync(join(ROOT, 'src', 'data', 'lang', 'en.yml'), 'utf8')
  for (const [name, text] of [['zh-CN.yml', zh], ['en.yml', en]] as const) {
    assert.match(text, /kScopeSplitSuggestion:/u, `${name} 缺 kScopeSplitSuggestion（拆卡建议）`)
    assert.match(text, /kDispatchHeldByScope:/u, `${name} 缺 kDispatchHeldByScope（暂不可派行）`)
  }
  const plan = readFileSync(join(ROOT, 'src', 'domain', 'plan.ts'), 'utf8')
  assert.match(plan, /t\('uiPlan\.kScopeSplitSuggestion'\)/u, 'write-scope-disjoint 的修法必须带上拆卡建议')
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /heldByScopeSection/u, '`next` 的回执必须接上"暂不可派"段')
})
