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
