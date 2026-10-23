/**
 * **增量 129：认领被拒必须入账（DEF-059，2026-10-14 机制缺陷批 §3B）**。
 *
 * 缺陷现场（作者本人更正后的定稿，逐条可复算）：TASK-106 的会话被 `write-scope-conflict` **连拒两次**
 * （逐字回执在 `.sdo/evidence/child-reports/TASK-106-e386d180.md`），而全库 `task/claim-blocked`
 * 只有 4 条（seq 1387/2173/2251/2283，分别属于 TASK-038/063/072）——**没有一条属于 TASK-106**。
 * 机理：`task/claim-blocked` 是**已认领会话的 block 动作**触发的；认领失败者没有 owner ⇒ 拒签
 * **零事件** ⇒「这张卡被争用了多少次」在真源里**数不出**。
 *
 * **红线**：**不得**复用 `task/claim-blocked`（那是 `block` 的语义，混用会毁掉审计可分性）
 * ⇒ 新增**独立事件类型** `task/claim-rejected`，载荷带**拒绝码**（可按种类计数）。
 *
 * **先钉红**：修前 `claim()` 的 8 条拒绝路径全部 `return { ok: false, … }` —— 一条事件都不写。
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
import { isSignatureInvalidatingEvent } from '../src/types.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m129/', import.meta.url))
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

function card(id: string, status: TaskCard['status'], overrides: Partial<TaskCard> = {}): TaskCard {
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

function rejections(): { type: string; data: Record<string, unknown> }[] {
  return office
    .journalFor(WORKSPACE)
    .read()
    .events.filter((event) => event.type === 'task/claim-rejected')
    .map((event) => ({ type: event.type, data: event.data }))
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
  office.init(call, { name: 'M129 认领被拒入账', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['认领被拒入账'],
    scopeOut: ['复用 task/claim-blocked'],
    metricsSuccess: ['争用次数可按种类数出'],
    glossary: { 拒签: '认领被拒且没有产生任何事件' },
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

test('M129-01 每条拒绝路径都落一条带**拒绝码**的事件（不再有零事件的拒签）', () => {
  // ① not-found
  office.claimTask(call, { taskId: 'TASK-999', owner: 'x', expectedRevision: 1 })
  // ② revision-mismatch
  writeCard(card('TASK-301', 'ready'))
  office.claimTask(call, { taskId: 'TASK-301', owner: 'x', expectedRevision: 7 })
  // ③ not-claimable（已 done）
  writeCard(card('TASK-302', 'done'))
  office.claimTask(call, { taskId: 'TASK-302', owner: 'x', expectedRevision: 1 })
  // ④ write-scope-conflict（真机 TASK-106 的形状：同范围被在飞卡占着）
  //    **0.1.7 批3（`ADR-025`）**：相交默认照派/照认领 ⇒ 只有**声明独占窗口**这一类仍会拒签，
  //    夹具因此显式声明 `exclusive`（本条验的是「拒签必须入账」，不是「相交该不该拒」）。
  writeCard(card('TASK-303', 'ready', { writeScopes: ['src/shared/'], exclusive: 'full-suite' }))
  writeCard(card('TASK-304', 'in-progress', { writeScopes: ['src/shared/'], owner: 'other' }))
  office.claimTask(call, { taskId: 'TASK-303', owner: 'victim', expectedRevision: 1 })
  // ⑤ 第二次同型拒绝（真机是"连拒两次"，争用次数要能数出 2）
  office.claimTask(call, { taskId: 'TASK-303', owner: 'victim', expectedRevision: 1 })

  const rows = rejections()
  assert.deepEqual(
    rows.map((row) => row.data['code']),
    ['not-found', 'revision-mismatch', 'not-claimable', 'write-scope-conflict', 'write-scope-conflict'],
    `每条拒绝都要留痕且带拒绝码（实际：${JSON.stringify(rows.map((row) => row.data['code']))}）`,
  )
  assert.equal(rows[3]?.data['id'], 'TASK-303', '事件要点名是哪张卡')
  assert.equal(rows[3]?.data['by'], 'victim', '事件要记是谁想认领（便于找人与复盘）')
  assert.ok(String(rows[3]?.data['detail'] ?? '').length > 0, '要留可读原因')
})

test('M129-02 审计可分性：不得复用 `task/claim-blocked`', () => {
  writeCard(card('TASK-311', 'ready', { writeScopes: ['src/s/'], exclusive: 'full-suite' }))
  writeCard(card('TASK-312', 'in-progress', { writeScopes: ['src/s/'], owner: 'other' }))
  office.claimTask(call, { taskId: 'TASK-311', owner: 'blocked-session', expectedRevision: 1 })

  const types = office.journalFor(WORKSPACE).read().events.map((event) => event.type)
  assert.equal(types.includes('task/claim-rejected'), true, '必须有独立事件')
  assert.equal(types.includes('task/claim-blocked'), false, '拒签**不得**伪装成 block 动作（那会毁掉审计可分性）')
})

test('M129-03 新事件必须否掉 G3 失效（拒签不改真源，不该作废已签的字）', () => {
  assert.equal(isSignatureInvalidatingEvent('G3', 'task/claim-rejected'), false)
  const types = readFileSync(join(ROOT, 'src', 'types.ts'), 'utf8')
  assert.match(types, /'task\/claim-rejected'/u, '事件类型要进联合类型')
})

test('M129-04 可数读数 + 回执提示：就绪卡被拒过几次要看得见', async () => {
  writeCard(card('TASK-321', 'ready', { writeScopes: ['src/z/'], exclusive: 'full-suite' }))
  writeCard(card('TASK-322', 'in-progress', { writeScopes: ['src/z/'], owner: 'other' }))
  office.claimTask(call, { taskId: 'TASK-321', owner: 'victim', expectedRevision: 1 })
  office.claimTask(call, { taskId: 'TASK-321', owner: 'victim', expectedRevision: 1 })

  const reading = office.claimRejections(call)
  assert.equal(reading.total, 2, '两次拒签都要数出来')
  assert.deepEqual(
    reading.rows.map((row) => [row.taskId, row.code, row.count]),
    [['TASK-321', 'write-scope-conflict', 2]],
    '按「卡 × 拒绝码 × 谁」聚合',
  )

  const receipt = await callTool('sdo_plan', { action: 'next', limit: 1, why: true })
  assert.match(receipt, /TASK-321/u, `就绪卡被拒过必须出现在回执里：${receipt.slice(0, 400)}`)
  assert.match(receipt, /2/u, '要点名被拒次数')
  assert.match(receipt, /write-scope-conflict/u, '要点名最近一次的拒绝码')
})

test('M129-05 防回退：claim 的拒绝出口必须唯一（9 条路径全走它）', () => {
  const text = readFileSync(join(ROOT, 'src', 'domain', 'collab.ts'), 'utf8')
  const start = text.indexOf('export function claim(store: SdoStore, journal: Journal, input: ClaimInput): ClaimResult {')
  const end = text.indexOf("  return { ok: true, task: save(store, next) }", start)
  const body = text.slice(start, end)
  const outlets = (body.match(/reject\(/gu) ?? []).length
  // 原 8 条 + **DEF-040**（族 6）的 `gate-stale` 一条 = 9（新增路径同样必须走统一出口留痕）
  assert.equal(outlets, 9, `9 条拒绝路径都要走统一出口（实际 ${outlets}）`)
  for (const code of [
    'not-found',
    'revision-mismatch',
    'not-claimable',
    'change-not-digested',
    'gate-stale',
    'write-scope-conflict',
    'test-case-missing',
    'construction-profile-missing',
    'contract-not-frozen',
  ]) {
    assert.match(body, new RegExp(`reject\\(\\s*'${code}'`, 'u'), `拒绝码 ${code} 必须经统一出口留痕`)
  }
  // 体内不得再有**多行裸拒绝**（helper 自己的返回是单行、且它就是出口本身）
  const rawReturns = (body.match(/return \{\s*\n\s*ok: false,/gu) ?? []).length
  assert.equal(rawReturns, 0, `不得再有绕过出口的裸拒绝（实际 ${rawReturns}）`)
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /claimRejections\(call\)/u, '回执要接上读数')
})
