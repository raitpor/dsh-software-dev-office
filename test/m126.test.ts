/**
 * **增量 126：写范围的追加通道（DEF-012，2026-10-14 机制缺陷批 §3A）**。
 *
 * 缺陷原文（A 组现盘复现）：`sdo_task action=update writeScopes=…` 由**流程官**发起时被
 * `scope-locked` 拒绝 ——「改写范围会造出两个写者（先 release，或让 owner 来改）」，
 * 而 `release` 会**丢掉 in-progress 与认领痕迹**（真机实测：改一次写范围要绕三道手续）。
 *
 * **修法**：给一条**无损**的正规通道 —— `addWriteScopes`（**追加**，不替换），
 * 三条机械约束（都当场可读拒绝）：
 *   ① 调用方是**流程官**（`human`/`office`/`cockpit`）或**本卡 owner**；
 *   ② 必须带 `reason`（计划变更要留痕进 `task/updated`）；
 *   ③ 追加的每条范围**不得与另一张在飞卡相交**（判定走 `scopeOverlaps` —— 与认领期同一出口，
 *      不然等于造出两个写者，正是那把锁要防的事）。
 *
 * **先钉红**：修前 `addWriteScopes` 这个参数**根本不存在**（工具 schema 里没有它，
 * 域层 `updateTask` 也不认）⇒ 流程官想扩范围只能先 `release`（丢状态）。
 *
 * **不得回退**：`writeScopes`（整份替换）在别人 owner 时**仍然** `scope-locked` —— 本批不放宽它。
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
import { createOfficeTools } from '../src/interface/tools.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m126/', import.meta.url))
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

function writeCard(task: TaskCard): void {
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${task.id}.yml`], { task })
}

function live(id: string, writeScopes: string[], owner: string): void {
  writeCard(card(id, 'ready', writeScopes))
  const claimed = office.claimTask(call, { taskId: id, owner, expectedRevision: 1 })
  assert.equal(claimed.ok, true, `夹具前提：${id} 必须认领成功（${JSON.stringify(claimed).slice(0, 120)}）`)
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
  office.init(call, { name: 'M126 追加通道', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['写范围追加通道'],
    scopeOut: ['放宽整份替换的锁'],
    metricsSuccess: ['流程官无需 release 即可扩范围'],
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

test('M126-01 流程官可不经 release 追加写范围：状态与 owner 无损，理由进事件', () => {
  live('TASK-961', ['src/a.ts'], 'subagent:developer:1')
  const before = office.tasks(call).find((task) => task.id === 'TASK-961')?.revision ?? 0
  const updated = office.updateTask(call, {
    taskId: 'TASK-961',
    by: 'office',
    addWriteScopes: ['src/b.ts', './src/b.ts', 'src/b.ts/'],
    reason: 'DoD 落点跨了第二个文件',
  })
  assert.equal(updated.ok, true, `流程官追加必须成功：${JSON.stringify(updated).slice(0, 160)}`)
  if (!updated.ok) assert.fail('追加被拒')
  assert.deepEqual(updated.task.writeScopes, ['src/a.ts', 'src/b.ts'], '追加并进**新**路径，重复/异形写法归一后去重')
  assert.equal(updated.task.status, 'in-progress', '追加是**无损**的：in-progress 必须保留')
  assert.equal(updated.task.owner, 'subagent:developer:1', 'owner 必须保留（认领痕迹不丢）')
  assert.equal(updated.task.revision, before + 1, '计划变更要推进 revision（相对认领后那一次）')

  const events = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'task/updated')
  const last = events.at(-1)
  assert.deepEqual(last?.data['added'], ['src/b.ts'], '留痕：追加了哪些路径')
  assert.equal(last?.data['reason'], 'DoD 落点跨了第二个文件', '留痕：为什么追加')
})

test('M126-02 三条机械约束：无理由 / 无权限 / 与在飞卡相交 —— 都当场可读拒绝', () => {
  live('TASK-971', ['src/a.ts'], 'subagent:developer:1')
  live('TASK-972', ['src/z.ts'], 'subagent:developer:2')

  const noReason = office.updateTask(call, { taskId: 'TASK-971', by: 'office', addWriteScopes: ['src/c.ts'] })
  assert.equal(noReason.ok, false)
  if (noReason.ok) assert.fail('无 reason 必须拒绝')
  assert.equal(noReason.code, 'add-scope-reason-required')
  assert.match(noReason.detail, /reason/u)

  const stranger = office.updateTask(call, {
    taskId: 'TASK-971',
    by: 'subagent:developer:9',
    addWriteScopes: ['src/c.ts'],
    reason: '我只是路过的另一个子代理',
  })
  assert.equal(stranger.ok, false, '既不是流程官也不是 owner ⇒ 不得追加')
  if (stranger.ok) assert.fail('无权限必须拒绝')
  assert.equal(stranger.code, 'add-scope-forbidden')
  assert.match(stranger.detail, /subagent:developer:1/u, '要点名当前 owner')

  const conflict = office.updateTask(call, {
    taskId: 'TASK-971',
    by: 'office',
    addWriteScopes: ['src/z.ts'],
    reason: '想顺手改别人的文件',
  })
  assert.equal(conflict.ok, false, '与在飞卡相交必须拒绝（那会造出两个写者）')
  if (conflict.ok) assert.fail('相交必须拒绝')
  assert.equal(conflict.code, 'add-scope-conflict')
  assert.match(conflict.detail, /src\/z\.ts/u, '要点名重叠的那个路径')
  assert.match(conflict.detail, /TASK-972/u, '要点名与之相交的在飞卡')

  const ambiguous = office.updateTask(call, {
    taskId: 'TASK-971',
    by: 'office',
    writeScopes: ['src/a.ts', 'src/c.ts'],
    addWriteScopes: ['src/d.ts'],
    reason: '两种意图一起给',
  })
  assert.equal(ambiguous.ok, false, '替换与追加互斥')
  if (ambiguous.ok) assert.fail('互斥必须拒绝')
  assert.equal(ambiguous.code, 'add-scope-ambiguous')
})

test('M126-03 不得回退：整份替换在别人 owner 时**仍然**被锁；owner 本人可追加', () => {
  live('TASK-981', ['src/a.ts'], 'subagent:developer:1')

  const replaceByOfficer = office.updateTask(call, { taskId: 'TASK-981', by: 'office', writeScopes: ['src/a.ts', 'src/b.ts'] })
  assert.equal(replaceByOfficer.ok, false, '整份替换的锁是既有语义，本批**不放宽**')
  if (replaceByOfficer.ok) assert.fail('替换应被锁')
  assert.equal(replaceByOfficer.code, 'scope-locked')

  const ownerAppend = office.updateTask(call, {
    taskId: 'TASK-981',
    by: 'subagent:developer:1',
    addWriteScopes: ['src/own.ts'],
    reason: 'owner 自己扩范围',
  })
  assert.equal(ownerAppend.ok, true, 'owner 原地扩范围是一等动作（无损）')
  if (!ownerAppend.ok) assert.fail('owner 追加应成功')
  assert.equal(ownerAppend.task.owner, 'subagent:developer:1')
})

test('M126-04 工具面：数组与 JSON 文本**两形态等价**（DEF-073 的联合类型纪律）', async () => {
  live('TASK-991', ['src/a.ts'], 'subagent:developer:1')
  const viaArray = await callTool('sdo_task', {
    action: 'update',
    id: 'TASK-991',
    actor: 'office',
    addWriteScopes: ['src/arr.ts'],
    reason: '数组形态',
  })
  assert.match(assertSuccess(viaArray), /TASK-991/u, `数组形态必须被接受：${viaArray.slice(0, 220)}`)

  const viaText = await callTool('sdo_task', {
    action: 'update',
    id: 'TASK-991',
    actor: 'office',
    addWriteScopes: '["src/text.ts"]',
    reason: 'JSON 文本形态',
  })
  assert.match(assertSuccess(viaText), /TASK-991/u, `JSON 文本形态必须被接受：${viaText.slice(0, 220)}`)

  const cardAfter = office.tasks(call).find((task) => task.id === 'TASK-991')
  assert.deepEqual(cardAfter?.writeScopes, ['src/a.ts', 'src/arr.ts', 'src/text.ts'], '两形态都要真的并进写范围')
})

function assertSuccess(receipt: string): string {
  assert.equal(/被拒|rejected|❌/u.test(receipt), false, `回执不得是拒绝：${receipt.slice(0, 220)}`)
  return receipt
}

test('M126-05 防回退：两包语言包都有新键，且腾范围提示指向追加通道', () => {
  for (const name of ['zh-CN.yml', 'en.yml']) {
    const text = readFileSync(join(ROOT, 'src', 'data', 'lang', name), 'utf8')
    for (const key of [
      'kAddScopeAmbiguous',
      'kAddScopeEmpty',
      'kAddScopeForbidden',
      'kAddScopeReasonRequired',
      'kAddScopeConflict',
    ]) {
      assert.match(text, new RegExp(`${key}:`, 'u'), `${name} 缺 ${key}`)
    }
    assert.match(text, /addWriteScopes/u, `${name} 的腾范围提示必须指向追加通道（DEF-012）`)
  }
  // 工具面：schema 声明为**联合类型**（不是纯 string —— 那正是 DEF-073 那一类故障）。
  // **第五批 §3.3（R11）**：声明形态从手写 `oneOf` 统一成 `listDecl(...)`（行为一字不变），
  // 所以这里不再 pin 源码串，改成**行为面读数**：真注册工具的 schema 必须真的收两种形态。
  const taskTool = createOfficeTools({} as never).find((item) => item.name === 'sdo_task') as unknown as
    | { parameters: { properties: Record<string, Record<string, unknown>> } }
    | undefined
  assert.ok(taskTool !== undefined, '工具面必须有 sdo_task')
  const addScope = taskTool.parameters.properties['addWriteScopes'] ?? {}
  const branches = Array.isArray(addScope['oneOf']) ? (addScope['oneOf'] as { type?: unknown }[]) : []
  assert.equal(branches.some((branch) => branch?.type === 'array'), true, '工具面 schema 必须声明成 oneOf（string | array）')
  assert.equal(branches.some((branch) => branch?.type === 'string'), true, '联合里必须有 string 分支（JSON 文本形态）')
  // 执行面：走 `compositeArg` 归一（数组与 JSON 文本两形态等价）
  const wire = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(wire, /compositeArg\(args\.addWriteScopes\)/u, '执行面必须经 compositeArg 归一（不是只认字符串）')
  // 域层：追加通道的存在性（防有人把参数删了却留着回执文案）
  const domain = readFileSync(join(ROOT, 'src', 'domain', 'collab.ts'), 'utf8')
  assert.match(domain, /addWriteScopes !== undefined/u, '域层必须真的处理 addWriteScopes')
})
