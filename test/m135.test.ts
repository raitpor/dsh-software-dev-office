/**
 * **增量 135：`block`/`done` 必须读理由（DEF-068，2026-10-14 机制缺陷批 §3D）**。
 *
 * 缺陷原文：`sdo_task` 的 `block`/`done` **不读 `reason`** —— 调用方给了理由，卡上却记「（未说明）」、
 * 事件里零命中 ⇒ 台账里一条**假陈述**（比"没记"更糟：它把"没人说"写成了事实）。
 *
 * 处置（交接文档给的 (a) 案）：**`note ?? reason` 兜底** —— 两个参数都收，`note` 优先。
 *
 * **先钉红**：修前只有 `note` 被读，`reason` 落到地上。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
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
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m135/', import.meta.url))
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
  office.init(call, { name: 'M135 理由必须入账', scale: 'normal', stakeholders: ['业务方'] })
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

function live(id: string): void {
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${id}.yml`], { task: card(id) })
  assert.equal(office.claimTask(call, { taskId: id, owner: 'dev', expectedRevision: 1 }).ok, true)
}

test('M135-01 `block` 只给 `reason` ⇒ 阻塞理由必须入账（不得记成「未说明」）', async () => {
  live('TASK-981')
  await callTool('sdo_task', {
    action: 'block',
    id: 'TASK-981',
    owner: 'dev',
    reason: '等 G3 签字，设计没冻结',
  })
  const after = office.tasks(call).find((task) => task.id === 'TASK-981')
  assert.equal(after?.status, 'blocked', '夹具前提：卡应转 blocked')
  assert.equal(after?.blockedReason, '等 G3 签字，设计没冻结', `理由必须逐字入账（实际：${String(after?.blockedReason)}）`)
  assert.notEqual(after?.blockedReason, '（未说明）', '不得把"调用方说了"记成"没人说"')
})

test('M135-02 `done` 只给 `reason` ⇒ 事件里的理由字段不得为空', async () => {
  live('TASK-982')
  await callTool('sdo_task', {
    action: 'done',
    id: 'TASK-982',
    owner: 'dev',
    reason: 'DoD 全部落点已验证',
    evidence: '[{"kind":"command","detail":"node -e 1 → 0","at":"2026-10-14T00:00:00.000Z","exitCode":0}]',
  })
  const events = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'task/done')
  const last = events.at(-1)
  assert.equal(last?.data['note'], 'DoD 全部落点已验证', `task/done 事件的 note 必须是调用方给的理由（实际：${String(last?.data['note'])}）`)
})

test('M135-03 `note` 仍然优先（两参数都给时不改变既有语义）', async () => {
  live('TASK-983')
  await callTool('sdo_task', {
    action: 'block',
    id: 'TASK-983',
    owner: 'dev',
    note: '正式理由',
    reason: '随手写的理由',
  })
  const after = office.tasks(call).find((task) => task.id === 'TASK-983')
  assert.equal(after?.blockedReason, '正式理由', 'note 优先（既有语义不变）')

  // 源码级防回退：两个参数都要被读（只读 note 是这条缺陷的本体）
  const { readFileSync } = await import('node:fs')
  const index = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
  assert.match(index, /args\.note \?\? args\.reason/u, '兜底写法不得被改回只读 note')
})

test('M135-04 TC-145：理由必须**进回执**（原守卫只看卡与事件），且中英 `param.reason` 描述同步', async () => {
  // ① `block`：调用方给的理由要在**回执**里看得到（读者不该去翻卡文件才知道为什么停）
  live('TASK-984')
  const blockReceipt = await callTool('sdo_task', {
    action: 'block', id: 'TASK-984', owner: 'dev', reason: '等上游契约 CT-010 冻结',
  })
  assert.match(blockReceipt, /等上游契约 CT-010 冻结/u, `block 回执必须带出理由（原实现丢弃了 callTool 的返回值）：${blockReceipt.slice(0, 300)}`)

  // ② `done` 的回执**不带**理由 —— 这是**行为缺口**，不是断言缺口（见交付回执 §发现）。
  //    `done` 的理由只进 `task/done` 事件（`M135-02` 已钉住），回执里没有对应字段；
  //    要补就得改回执版式 + 两个语言包，属于需要裁定的范围，这里**不自行扩大**。

  // ③ 两个语言包的 `param.reason` 描述必须**同义**：都点名 `block`/`done` 两个动作 + 同一条缺陷号
  const packs = ['zh-CN.yml', 'en.yml'].map((pack) =>
    readFileSync(join(ROOT, 'src', 'data', 'lang', pack), 'utf8')
      .split('\n')
      .find((line) => line.trimStart().startsWith('reason:') && line.includes('DEF-068')) ?? '')
  for (const [index, line] of packs.entries()) {
    const name = index === 0 ? 'zh-CN.yml' : 'en.yml'
    assert.notEqual(line, '', `${name} 缺 param.reason 的 DEF-068 描述`)
    assert.ok(line.includes('block') && line.includes('done'), `${name} 的 param.reason 要点名 block/done 两个动作：${line}`)
    assert.ok(line.includes('DEF-068'), `${name} 要带上缺陷号（可溯源）：${line}`)
  }
  // 两侧说的是同一件事（不是一边写"备注"一边写"理由"的两种口径）
  assert.ok(packs[0]?.includes('note') && packs[1]?.includes('note'), '两包都要说清它与 note 的等价关系')
})
