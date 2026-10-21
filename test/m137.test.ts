/**
 * **增量 137：批量派发回执的**首屏**必须能看到全部派发行（DEF-058，2026-10-14 机制缺陷批 §3D）**。
 *
 * 缺陷现场（驾驶舱实测）：`sdo_plan action=next limit=3` 时，逐卡详情把回执撑爆 ⇒ **首屏只看得见
 * 一张卡的详情**，差点被误报成「只派出 1 张」。回执里其实有三张，但**首屏读不出**。
 *
 * **修法**（交接文档：「分页/摘要/计数三者至少一」）：本次派发**摘要行放在最前** ——
 * 全部卡号 + 计数（摘要与计数两者齐备），逐卡详情在后；容量留到下一轮的另给一句。
 *
 * **先钉红**：修前回执**以第一张卡的详情开头**，卡号列表只散落在各处。
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
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m137/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
let tools: { name: string; parameters: unknown; execute: (a: Record<string, unknown>, c: { agent?: unknown }) => unknown }[]
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

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M137 首屏摘要', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, { scopeIn: ['x'], scopeOut: ['y'], metricsSuccess: ['z'], glossary: { a: 'b' } })
  tools = []
  const services: Record<string, unknown> = { tools: { register: (t: never) => { tools.push(t); return () => {} }, get: (n: string) => ({ n }) } }
  // **TC-136 需要"真的派出去"**：没有 `subagents` 服务时后端降级成 inline（`continue` 直接跳过
  // 「因 limit 留到下一轮」那段），那条明细行就永远渲不出来。
  services['subagents'] = {
    list: () => ['spawn'],
    startContinuable: async () => ({ childId: 'child-m137' }),
    start: async () => ({ id: 'child-m137' }),
    listDescendants: async () => [],
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
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M137-01 批量派发：首屏摘要必须**先**列出全部卡号与计数（否则会误读成"只派了 1 张"）', async () => {
  for (const id of ['TASK-991', 'TASK-992', 'TASK-993']) {
    office.storeFor(WORKSPACE).writeYaml(['tasks', `${id}.yml`], { task: card(id) })
  }
  const receipt = await callTool('sdo_plan', { action: 'next', limit: 3 })
  const lines = receipt.split('\n')
  const summaryIndex = lines.findIndex((line) => line.includes('本次派发'))
  assert.ok(summaryIndex >= 0, `回执必须有「本次派发 N 张」摘要行：${receipt.slice(0, 300)}`)
  assert.equal(summaryIndex, 0, '摘要必须在**第一行**（首屏），不得被逐卡详情压在后面')
  for (const id of ['TASK-991', 'TASK-992', 'TASK-993']) {
    assert.ok((lines[0] ?? '').includes(id), `首屏摘要要点名 ${id}：${lines[0] ?? ''}`)
  }
  assert.match(lines[0] ?? '', /3/u, '首屏要给计数')
  // 逐卡详情仍在（摘要不是替代品，而是首屏索引）
  assert.ok(receipt.includes('claim id=TASK-991') || receipt.includes('TASK-991'), '详情不得被摘要顶掉')
})

test('M137-02 反向：只有一张卡时摘要同样在首屏（口径一致，不搞两套排版）', async () => {
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-994.yml'], { task: card('TASK-994') })
  const receipt = await callTool('sdo_plan', { action: 'next', limit: 1 })
  assert.match(receipt.split('\n')[0] ?? '', /本次派发 1 张/u, `单卡也要摘要行：${receipt.slice(0, 200)}`)
})

test('M137-03 防回退：摘要行必须接在主派发回执上（源码级）+ 两包文案齐备', () => {
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /const dispatchSummary = fmt\('uiIndex\.kDispatchSummary'/u, '摘要行不得被删')
  assert.match(index, /return `\$\{dispatchSummary\}/u, '摘要必须拼在回执最前')
  for (const name of ['zh-CN.yml', 'en.yml']) {
    const lang = readFileSync(join(ROOT, 'src', 'data', 'lang', name), 'utf8')
    assert.match(lang, /kDispatchSummary:/u, `${name} 缺 kDispatchSummary`)
    assert.match(lang, /kDispatchSummaryHeld:/u, `${name} 缺 kDispatchSummaryHeld`)
  }
})

test('M137-04 TC-136：因容量留到下一轮的行在**汇总行之后**；首行卡号与同轮 `dispatch/started` **逐条一致**', async () => {
  for (const id of ['TASK-995', 'TASK-996', 'TASK-997']) {
    office.storeFor(WORKSPACE).writeYaml(['tasks', `${id}.yml`], { task: card(id) })
  }
  const journal = office.journalFor(WORKSPACE)
  const startedBefore = journal.read().events.filter((event) => event.type === 'dispatch/started').length

  const receipt = await callTool('sdo_plan', { action: 'next', limit: 1 })
  const lines = receipt.split('\n')
  const summaryIndex = lines.findIndex((line) => line.includes('本次派发'))
  assert.equal(summaryIndex, 0, '摘要必须在第一行')

  // ① 被 `limit=1` 挡下的那 2 张：**明细行在汇总行之后**（汇总行只给计数，明细不许跑到首屏前面）
  assert.match(lines[0] ?? '', /另有 2 张因容量\/上限留到下一轮/u, `汇总行要点名被挡的张数：${lines[0] ?? ''}`)
  const heldIndex = lines.findIndex((line) => line.includes('被本次 `limit=1` 挡下'))
  assert.ok(heldIndex > summaryIndex, `留到下一轮的明细行必须在汇总行**之后**（实际 index=${heldIndex}）：${receipt.slice(0, 900)}`)
  assert.ok(heldIndex > 0, '夹具前提：确实有被 limit 挡下的卡（否则这条没咬住）')

  // ② 首行卡号与同轮 journal 的 `dispatch/started` **逐条一致**（多一个少一个都算错）
  const started = journal.read().events.filter((event) => event.type === 'dispatch/started').slice(startedBefore)
  const startedIds = started.map((event) => String(event.data['task'] ?? '')).filter((id) => id !== '').sort()
  const summaryIds = [...(lines[0] ?? '').matchAll(/TASK-\d+/gu)].map((match) => match[0]).sort()
  assert.deepEqual(summaryIds, startedIds, `首行卡号必须与真源**逐条一致**（首行 ${summaryIds.join(' ')} ／ journal ${startedIds.join(' ')}）`)
  assert.equal(summaryIds.length, 1, '夹具前提：本轮只派 1 张')
})
