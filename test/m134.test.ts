/**
 * **增量 134：写范围对账的降级路径（DEF-016，2026-10-14 机制缺陷批 §3C 收口）**。
 *
 * 判定（现盘机械可验）：对账输入只来自宿主的 `workspace/changes` 事件，而该事件**只为顶层轮次公告**
 * ⇒ 子会话**永远采不到**（`changedFilesSince` 返回 `{files: [], entries: 0}`）⇒ 写范围纪律退化为
 * 人工比对。**这是上游能力边界**，插件侧只能降级：让执行者**自报**实际写入的文件，再用**同一个出口**
 * （`auditWriteScopes`）机械核对，并在回执里**如实标注"自报，非宿主观测"**。
 *
 * **先钉红**：修前 `done` 没有自报入口 —— 子会话的写入既不拒也不记，只能靠人看。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m134/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
let tools: { name: string; parameters: { properties?: Record<string, { oneOf?: unknown[] }> }; execute: (a: Record<string, unknown>, c: { agent?: unknown }) => unknown }[]
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string, writeScopes: string[]): TaskCard {
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

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(args, { agent: agentStub }))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M134 写范围对账降级', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['z'], glossary: { a: 'b' } })
  tools = []
  const services: Record<string, unknown> = { tools: { register: (t: never) => { tools.push(t); return () => {} }, get: (n: string) => ({ n }) } }
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
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function live(id: string, writeScopes: string[]): void {
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${id}.yml`], { task: card(id, writeScopes) })
  const claimed = office.claimTask(call, { taskId: id, owner: 'dev', expectedRevision: 1 })
  assert.equal(claimed.ok, true, `夹具前提：${id} 必须认领成功`)
}

test('M134-01 自报越界 ⇒ 拒绝，且**点名来源是自报**（不得冒充宿主观测）', async () => {
  live('TASK-971', ['src/a/'])
  const receipt = await callTool('sdo_task', {
    action: 'done',
    id: 'TASK-971',
    owner: 'dev',
    evidence: '[{"kind":"command","detail":"node -e 1 → 0","at":"2026-10-14T00:00:00.000Z","exitCode":0}]',
    reportedFiles: ['src/b/other.ts'],
  })
  assert.match(receipt, /write-scope-violation/u, `自报越界必须被拒：${receipt.slice(0, 240)}`)
  assert.match(receipt, /src\/b\/other\.ts/u, '要点名越界路径')
  assert.match(receipt, /自报/u, '必须说清这次判据来自**自报**，不是宿主观测')
})

test('M134-02 自报合规 ⇒ 放行，且结果标注 `selfReported`（诚实标注来源）', () => {
  live('TASK-972', ['src/a/'])
  const result = office.reportTask(call, {
    taskId: 'TASK-972',
    owner: 'dev',
    status: 'done',
    evidence: [{ kind: 'command', detail: 'node -e 1 → 0', at: '2026-10-14T00:00:00.000Z', exitCode: 0 }],
    reportedFiles: ['src/a/impl.ts', '.sdo/notes.md'],
  })
  assert.equal(result.ok, true, `自报在范围内必须放行：${JSON.stringify(result).slice(0, 200)}`)
  if (!result.ok) assert.fail('应放行')
  assert.equal(result.workspaceAudit?.selfReported, true, '自报对账必须打上来源标记')
  assert.equal(result.workspaceAudit?.changed, 1, '`.sdo/` 台账不算产品文件（与既有口径一致）')
})

test('M134-03 两侧都没有 ⇒ 保持"未对账"（不假装核对过）', () => {
  live('TASK-973', ['src/a/'])
  const result = office.reportTask(call, {
    taskId: 'TASK-973',
    owner: 'dev',
    status: 'done',
    evidence: [{ kind: 'command', detail: 'node -e 1 → 0', at: '2026-10-14T00:00:00.000Z', exitCode: 0 }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) assert.fail('应放行')
  assert.equal(result.workspaceAudit?.checked, false, '没有观测也没有自报 ⇒ 如实"未对账"')
  assert.notEqual(result.workspaceAudit?.selfReported, true, '不得凭空标成自报')
})

test('M134-04 工具面：新参数是**联合形态**（DEF-073 的归一覆盖到它）+ 数组形态端到端可用', async () => {
  const schema = tools.find((item) => item.name === 'sdo_task')?.parameters.properties ?? {}
  assert.ok(schema['reportedFiles']?.oneOf !== undefined, 'reportedFiles 必须声明成 string|array（否则传数组会被宿主拒签）')

  live('TASK-974', ['src/a/'])
  const receipt = await callTool('sdo_task', {
    action: 'done',
    id: 'TASK-974',
    owner: 'dev',
    evidence: '[{"kind":"command","detail":"node -e 1 → 0","at":"2026-10-14T00:00:00.000Z","exitCode":0}]',
    reportedFiles: ['src/a/impl.ts'],
  })
  assert.equal(receipt.includes('write-scope-violation'), false, `数组形态自报不该被拒：${receipt.slice(0, 200)}`)
  const cardAfter = office.tasks(call).find((task) => task.id === 'TASK-974')
  assert.equal(cardAfter?.status, 'done', '自报合规 ⇒ 卡真的收工')
})
