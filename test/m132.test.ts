/**
 * **增量 132：名单与宿主实际注册面同源 + 漂移可核对（DEF-015，2026-10-14 机制缺陷批 §3C）**。
 *
 * 缺陷现场：工具面里含**宿主未注册**的工具名 ⇒ 每次派发剔除 5 个并告警（`subagent_fork workflow
 * plugin_manager create_goal update_goal`），靠兜底交集掩盖**清单偏移**。
 *
 * 现状核实（在恢复后的现盘上逐条读过）：
 *   · 派发时确实做了交集（`filterKnownTools`），并把剔除的名字**点名印在回执里** ✓（SDO 会话已修的一半）；
 *   · 但 `EXECUTOR_DENIED_TOOLS` 是 2026-10-08 对着宿主 `Tool.listTools` 逐个分类的**历史产物**，
 *     宿主每加/删工具它就漂一点，而**漂移本身**没有任何机械读数 ⇒ 早就不存在的条目永远没人清理、
 *     下一次"少挡了一个该挡的工具"也不会响（那一次是**安全**问题）。
 *
 * **修法**：`curatedDenyPhantoms(isKnown)` —— 与派发路径**同一个探针**，列出我方名单里宿主没注册的名字；
 * 派发回执**单列一行**点名（可核对），探针盲态时**不回报**（那批"未注册"是探针的错觉）。
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
import { EXECUTOR_DENIED_TOOLS, curatedDenyPhantoms } from '../src/domain/roles.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m132/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: Record<string, unknown>, ctx: { agent?: unknown }) => unknown
}

/** 本桩宿主:注册了 SDO 工具与常用通用面，但**故意不注册**这几个历史名单条目。 */
const HOST_MISSING = ['subagent_fork', 'workflow', 'plugin_manager', 'create_goal', 'update_goal']

let office: SoftwareDevOffice
let tools: ToolDefinition[]
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string): TaskCard {
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

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(args, { agent: agentStub }))
}

function boot(): void {
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M132 派发面读数', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['名单与宿主面同源'],
    scopeOut: ['静默兜底'],
    metricsSuccess: ['漂移可核对'],
    glossary: { 漂移: '名单里的名字宿主已不注册' },
  })
  tools = []
  const services: Record<string, unknown> = {
    tools: {
      register: (tool: ToolDefinition) => { tools.push(tool); return () => {} },
      // 与真实探测同形：`ctx.get('tools').get(name, scope?)` 返回工具或 undefined
      get: (name: string) => (HOST_MISSING.includes(name) ? undefined : { name }),
    },
  }
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
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  boot()
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M132-01 curatedDenyPhantoms：只列"名单里有、宿主没注册"的名字（顺序稳定）', () => {
  assert.deepEqual(curatedDenyPhantoms(() => true), [], '宿主全都有 ⇒ 无漂移')
  const phantoms = curatedDenyPhantoms((name) => !HOST_MISSING.includes(name))
  assert.deepEqual(phantoms, HOST_MISSING, '漂移必须逐名列出（顺序与名单一致）')
  // 名单本身的形状（防有人把它删空 ⇒ 体检变成空转）
  assert.ok(EXECUTOR_DENIED_TOOLS.length >= 10, '执行者禁用面不得被清空')
  for (const name of HOST_MISSING) assert.ok(EXECUTOR_DENIED_TOOLS.includes(name as never), `${name} 应仍在名单里`)
})

test('M132-02 派发回执**单列一行**点名漂移（可核对），而不是靠交集静默兜住', async () => {
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-951.yml'], { task: card('TASK-951') })
  const receipt = await callTool('sdo_plan', { action: 'next', limit: 1 })
  const drift = receipt.split('\n').filter((line) => line.includes('名单体检'))
  assert.equal(drift.length, 1, `漂移必须单列一行（实际 ${drift.length} 行）：${receipt.slice(0, 500)}`)
  for (const name of HOST_MISSING) {
    assert.match(drift[0] ?? '', new RegExp(name, 'u'), `漂移行要点名 ${name}：${drift[0] ?? ''}`)
  }
  assert.match(drift[0] ?? '', /宿主/u, '要说明"宿主这个版本没注册"，别让读者以为是我们故意挡的')
})

test('M132-03 反向：宿主全都注册时**不得**误报漂移（没有假警报）', async () => {
  // 重建一个"宿主面齐全"的实例
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M132b 派发面读数', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['z'], glossary: { a: 'b' } })
  tools = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} }, get: (name: string) => ({ name }) },
  }
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
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-952.yml'], { task: card('TASK-952') })
  const receipt = await callTool('sdo_plan', { action: 'next', limit: 1 })
  assert.equal(receipt.includes('名单体检'), false, `没有漂移就不许印这行：${receipt.slice(0, 300)}`)
})

test('M132-04 防回退：体检必须走派发路径的**同一个探针**，且两包都有文案', async () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  // 体检与派发**同一个探针工厂**（`toolsProbe(call.agent)`）—— 两处各造一个探针就是又一处口径分叉
  assert.match(index, /const probe = toolsProbe\(call\.agent\)/u, '派发路径的探针')
  assert.match(index, /const auditProbe = toolsProbe\(call\.agent\)/u, '体检的探针必须同源')
  assert.match(index, /curatedDenyPhantoms\(auditProbe\)/u, '体检必须用同源探针')
  assert.match(index, /const denyDriftNote/u, '回执必须接上漂移行')
  for (const name of ['zh-CN.yml', 'en.yml']) {
    const lang = readFileSync(join(ROOT, 'src', 'data', 'lang', name), 'utf8')
    assert.match(lang, /kDenyListDrift:/u, `${name} 缺 kDenyListDrift`)
  }
})

test('M132-05 探针盲态（连 read 都不认得）⇒ **不得**回报漂移（那是探针的错觉，不是宿主没有）', async () => {
  // 重建一个"工具服务会应答、但什么都不认得"的实例
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M132c 派发面读数', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['z'], glossary: { a: 'b' } })
  tools = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} }, get: () => undefined },
  }
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
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-953.yml'], { task: card('TASK-953') })
  const receipt = await callTool('sdo_plan', { action: 'next', limit: 1 })
  assert.equal(receipt.includes('名单体检'), false, `探针盲态不许把"全都不认得"当成"名单全漂了"：${receipt.slice(0, 300)}`)
})
