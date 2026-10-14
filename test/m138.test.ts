/**
 * **增量 138：done 卡的**追加式**勘误通道（DEF-071，2026-10-14 机制缺陷批 §3D 收口）**。
 *
 * 缺陷原文：done 卡**不可改**（对，历史不重写），但**没有勘误通道** ⇒ 拆卡之后
 * 「说明说本卡不做」与「落点原文要求做」永久并存，下一位读卡人会判「没做完」。
 *
 * **修法**：`sdo_task action=errata` —— **只能追加**（`{at, by, note}`），
 * **绝不改写**任何历史正文（`dod` / 落点 / `status` 一个字都不动），并落 `task/errata` 事件。
 *
 * **先钉红**：修前 `TASK_ACTIONS` 里没有 `errata`，卡面上也没有任何追加式说明字段。
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
import { TASK_ACTIONS, isSignatureInvalidatingEvent } from '../src/types.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m138/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
let tools: { name: string; parameters: unknown; execute: (a: Record<string, unknown>, c: { agent?: unknown }) => unknown }[]
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string, status: TaskCard['status']): TaskCard {
  return {
    id,
    title: `${id} 原始标题`,
    goal: '原始目标',
    inputs: [],
    outputs: [],
    dod: ['原始 DoD 条目'],
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
  office.init(call, { name: 'M138 追加式勘误', scale: 'normal', stakeholders: ['业务方'] })
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

test('M138-01 done 卡可追加勘误：只增不改（历史正文一个字都不动）', () => {
  const original = card('TASK-981', 'done')
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-981.yml'], { task: original })

  const outcome = office.addErrata(call, { taskId: 'TASK-981', by: 'office', note: '落点③已拆给 TASK-999，本卡只做落点①②' })
  assert.equal(outcome.ok, true, `done 卡必须能追加勘误：${JSON.stringify(outcome).slice(0, 160)}`)
  if (!outcome.ok) assert.fail('应成功')
  assert.equal(outcome.task.errata?.length, 1, '勘误入卡')
  assert.equal(outcome.task.errata?.[0]?.note, '落点③已拆给 TASK-999，本卡只做落点①②')
  assert.equal(outcome.task.errata?.[0]?.by, 'office')
  assert.equal(outcome.task.revision, 2, '追加勘误要推进 revision（留痕）')

  // **历史正文一字不改**：标题 / 目标 / DoD / 状态
  assert.equal(outcome.task.title, original.title, '标题不得被改写')
  assert.equal(outcome.task.goal, original.goal, '目标不得被改写')
  assert.deepEqual(outcome.task.dod, original.dod, 'DoD 不得被改写')
  assert.equal(outcome.task.status, 'done', '状态不得被改写（勘误不是状态迁移）')
})

test('M138-02 两条可读拒绝：空说明 / 卡不存在', () => {
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-982.yml'], { task: card('TASK-982', 'verified') })
  const empty = office.addErrata(call, { taskId: 'TASK-982', by: 'office', note: '   ' })
  assert.equal(empty.ok, false)
  if (empty.ok) assert.fail('空说明必须拒绝')
  assert.equal(empty.code, 'note-required', '空说明等于没写 —— 必须可读拒绝')

  const missing = office.addErrata(call, { taskId: 'TASK-404', by: 'office', note: 'x' })
  assert.equal(missing.ok, false)
  if (missing.ok) assert.fail('不存在的卡必须拒绝')
  assert.equal(missing.code, 'not-found')
})

test('M138-03 工具级：`action=errata` 可用，回执说清「只能追加」，事件入账', async () => {
  assert.ok((TASK_ACTIONS as readonly string[]).includes('errata'), '`errata` 必须在动作清单里（schema/动作面同源）')
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-983.yml'], { task: card('TASK-983', 'done') })
  const receipt = await callTool('sdo_task', {
    action: 'errata',
    id: 'TASK-983',
    actor: 'office',
    note: '本条落点改为「下一轮单独一张卡」',
  })
  assert.match(receipt, /只能追加/u, `回执必须说清这是追加式通道：${receipt.slice(0, 240)}`)
  assert.match(receipt, /TASK-983/u, '要点名是哪张卡')
  const after = office.tasks(call).find((task) => task.id === 'TASK-983')
  assert.equal(after?.errata?.length, 1, '卡上必须有这条勘误')
  assert.equal(after?.status, 'done', '状态不变')

  const events = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'task/errata')
  assert.equal(events.length, 1, '必须落 `task/errata` 事件')
  assert.equal(events[0]?.data['note'], '本条落点改为「下一轮单独一张卡」', '事件里要能逐字复核')
})

test('M138-04 防回退：事件在中性表（勘误不作废已签的字）+ 源码只有一个追加出口', () => {
  assert.equal(isSignatureInvalidatingEvent('G3', 'task/errata'), false, '勘误是追加记录，不得作废 G3 签字')
  const collab = readFileSync(join(ROOT, 'src', 'domain', 'collab.ts'), 'utf8')
  assert.match(collab, /export function addErrata/u, '追加出口不得被删')
  // 只能追加：实现里不得出现对历史字段的赋值
  const body = collab.slice(collab.indexOf('export function addErrata'))
  const upTo = body.slice(0, body.indexOf('\n}\n'))
  for (const field of ['title:', 'goal:', 'dod:', 'status:', 'writeScopes:']) {
    assert.equal(upTo.includes(field), false, `勘误实现不得改写 ${field}（只能追加 errata）`)
  }
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /case 'errata':/u, '工具面必须接上 errata 分支')
})
