/**
 * **增量 158：复用投递的收据与消费观测（DEF-014 / §3E 族 8）**。
 *
 * 缺陷现场（现盘可复算）：`src/integration/dispatch.ts` 的复用分支 `await runtime.sendMessage(...)`
 * 把**返回值丢掉**，`dispatch/started` 只记 `reused: true` ⇒「指令到底投出去没有」在真源里无从查证；
 * 而「有没有**被消费**」更是零观测面 —— `claimMissing`（DEF-053）**只对 planned/ready 的卡成立**
 * （源码逐字如此），复用到**在飞**卡这条路它盖不到。
 *
 * 本刀只做两件**诚实**的事：
 *   ① 把宿主回执**留下**（`dispatch/started.messageReceipt`）——可查"投出去没有"；
 *   ② 现算**可观测**的消费**四态**（`reuseDeliveries`：held / claimed / ended / no-signal）——**不**把"受理了投递"
 *      说成"消费了"，也**不**把"未见消费"说成"没消费"。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { createTask } from '../src/domain/plan.js'
import { startDispatch } from '../src/integration/dispatch.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { Journal } from '../src/infra/journal.js'
import type { SdoStore } from '../src/infra/store.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m158/', import.meta.url))

interface Fixture {
  office: SoftwareDevOffice
  store: SdoStore
  journal: Journal
  call: OfficeCall
  workspace: string
}

function fixture(name: string): Fixture {
  const workspace = join(BASE, name)
  mkdirSync(workspace, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const sessionId = `s-${name}`
  office.noteSession(sessionId, workspace)
  const call = { sessionId, cwd: workspace } as unknown as OfficeCall
  office.init(call, { name: `M158 ${name}`, scale: 'normal', stakeholders: ['业务方'] })
  return { office, store: office.storeFor(workspace), journal: office.journalFor(workspace), call, workspace }
}

function newCard(f: Fixture, scope: string): TaskCard {
  return createTask(f.store, f.journal, {
    title: `卡 ${scope}`,
    goal: 'g',
    dod: ['d'],
    role: 'developer',
    size: 'small',
    writeScopes: [scope],
  } as never)
}

function claimAs(f: Fixture, childSessionId: string, card: TaskCard): void {
  const outcome = f.office.claimTask(
    { sessionId: childSessionId, cwd: f.workspace } as unknown as OfficeCall,
    { taskId: card.id, owner: 'dev', expectedRevision: card.revision },
  )
  assert.equal(outcome.ok, true, `夹具前提：${card.id} 必须能被认领：${JSON.stringify(outcome)}`)
}

/** 记一笔**复用投递**（`reused: true`）或新起（`reused: false`）。 */
function dispatchAs(f: Fixture, card: TaskCard, childSessionId: string, reused: boolean, receipt?: string): void {
  f.office.recordDispatchStarted(f.call, {
    taskId: card.id,
    provider: 'spawn',
    childSessionId,
    parentSessionId: f.call.sessionId ?? '',
    tools: 3,
    role: 'developer',
    mode: 'continuable',
    reused,
    ...(receipt === undefined ? {} : { messageReceipt: receipt }),
  })
}

function requestOf(card: TaskCard): Parameters<typeof startDispatch>[0]['request'] {
  return { task: card, prompt: 'p', owner: 'dev', persona: undefined, sdoAllow: [], deny: [] } as never
}

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M158-01 投递收据不丢：宿主返回值归一成一行留在 outcome 里（旧实现直接丢弃）', async () => {
  const seen: { target?: string } = {}
  const runtime = {
    start: async () => ({ id: 'child-fallback' }),
    list: () => ['spawn'],
    sendMessage: async (_sender: unknown, targetId: string) => {
      seen.target = targetId
      return { id: 'MSG-7' }
    },
  }
  const outcome = await startDispatch({
    runtime: runtime as never,
    provider: 'spawn',
    agent: { fake: true } as never,
    request: requestOf({ id: 'TASK-001' } as never),
    deny: [],
    maxDepth: 1,
    reuseChildId: 'child-1',
  })
  assert.equal(seen.target, 'child-1', '复用时必须投给指定的那个子会话')
  assert.equal(outcome.started, true, `前置：复用必须成功：${JSON.stringify(outcome)}`)
  assert.equal(
    (outcome as { messageReceipt?: string }).messageReceipt,
    'id=MSG-7',
    '宿主回执必须带回（旧实现连返回值都丢掉）',
  )

  // 返回值不可识别 ⇒ 记 `accepted`（**受理了**，不是"读了"）：不许静默成空
  const plain = await startDispatch({
    runtime: { ...runtime, sendMessage: async () => undefined } as never,
    provider: 'spawn',
    agent: { fake: true } as never,
    request: requestOf({ id: 'TASK-002' } as never),
    deny: [],
    maxDepth: 1,
    reuseChildId: 'child-2',
  })
  assert.equal((plain as { messageReceipt?: string }).messageReceipt, 'accepted', '认不出标识也要记"受理了"')

  // 投递抛错 ⇒ 仍走既有 `reuseFailed`（如实回报 + 降级新起），**不**留假收据
  const failed = await startDispatch({
    runtime: { ...runtime, sendMessage: async () => { throw new Error('boom') } } as never,
    provider: 'spawn',
    agent: { fake: true } as never,
    request: requestOf({ id: 'TASK-003' } as never),
    deny: [],
    maxDepth: 1,
    reuseChildId: 'child-3',
  })
  assert.equal((failed as { reuseFailed?: string }).reuseFailed, 'boom', '投递失败必须如实回报')
  assert.equal((failed as { messageReceipt?: string }).messageReceipt, undefined, '失败不得留收据')
})

test('M158-02 消费观测四态：投递前已持卡 ⇒ held（不报警）；投递后认领/结算 ⇒ 正面证据；都没有 ⇒ no-signal', () => {
  const f = fixture('states')
  // ① 追加指令给**在飞**会话（投递前就已持卡）⇒ `held`：不该再要求一次认领
  const held = newCard(f, 'src/held/')
  claimAs(f, 'child-1', held)
  dispatchAs(f, held, 'child-1', true, 'id=MSG-1')
  // ② 投递给空闲会话，之后认领 ⇒ `claimed`
  const claimed = newCard(f, 'src/claimed/')
  dispatchAs(f, claimed, 'child-2', true, 'accepted')
  claimAs(f, 'child-2', claimed)
  // ③ 投递后结算 ⇒ `ended`
  const ended = newCard(f, 'src/ended/')
  dispatchAs(f, ended, 'child-3', true)
  f.journal.append('dispatch/reported', { task: ended.id, childSessionId: 'child-3', reason: 'completed' })
  // ④ **新起**（不是复用）⇒ 本条不适用（没有任何"投给谁"的问题）
  const fresh = newCard(f, 'src/fresh/')
  dispatchAs(f, fresh, 'child-4', false)
  // ⑤ 复用投递后什么都没发生 ⇒ `no-signal`（窗口外才报）
  const silent = newCard(f, 'src/silent/')
  dispatchAs(f, silent, 'child-5', true, 'id=MSG-5')

  const byTask = new Map(f.office.reuseDeliveries(f.call, 0).map((row) => [row.taskId, row]))
  assert.equal(byTask.get(held.id)?.state, 'held', '投递前已持卡 ⇒ held（不许当成"未见消费"报警）')
  assert.equal(byTask.get(claimed.id)?.state, 'claimed', '投递后被认领 ⇒ 消费的正面证据')
  assert.equal(byTask.get(ended.id)?.state, 'ended', '投递后结算 ⇒ 至少跑过一轮')
  assert.equal(byTask.has(fresh.id), false, '新起（reused=false）不属于"复用投递"这一族')
  assert.equal(byTask.get(silent.id)?.state, 'no-signal', '既没认领也没结算 ⇒ no-signal')
  assert.equal(byTask.get(silent.id)?.messageReceipt, 'id=MSG-5', '回执必须随身带出（可复算"投出去没有"）')
  assert.equal(byTask.get(claimed.id)?.messageReceipt, 'accepted', '认不出标识的投递也要能查')

  // **不虚报**：默认窗口（5 分钟）内刚投出去的 `no-signal` **不报**（"刚投出去还没动静"不是缺陷）
  const withinWindow = f.office.reuseDeliveries(f.call).map((row) => row.taskId)
  assert.equal(withinWindow.includes(silent.id), false, '窗口内不得把"刚投出去"报成"未见消费"')
  // 旧事件没有 `messageReceipt` 字段 ⇒ 如实回空串（不是伪造一个收据）
  assert.equal(byTask.get(ended.id)?.messageReceipt, '', '当年的投递没有收据就如实说没有')
})

test('M158-03 回执面：复用投递的收据与"未见消费"必须现算进回执（不再只有"静默失败"一条路）', () => {
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.equal(source.includes('office\n          .reuseDeliveries(call)'), true, '回执必须现算复用投递状态')
  assert.equal(source.includes("row.state === 'no-signal'"), true, '只把"未见消费"那一类报警（其余是正常路径）')
  assert.equal(source.includes('kReuseDeliveryNoSignal'), true, '报警文案必须走语言包')
  // 两包同步：新增键在 zh/en 都在（i18n 的键对齐守卫之外再钉一遍，防只改一包）
  for (const pack of ['zh-CN.yml', 'en.yml']) {
    const text = readFileSync(join(ROOT, 'src', 'data', 'lang', pack), 'utf8')
    assert.equal(text.includes('kReuseDeliveryNoSignal'), true, `${pack} 缺少 kReuseDeliveryNoSignal`)
    assert.equal(text.includes('kReuseReceiptMissing'), true, `${pack} 缺少 kReuseReceiptMissing`)
  }
})

test('M158-04 真源留痕：收据必须落进 `dispatch/started`（可复算锚点），而不是只活在内存里', () => {
  const f = fixture('journal')
  const card = newCard(f, 'src/j/')
  dispatchAs(f, card, 'child-9', true, 'id=MSG-9')
  const started = f.journal.read().events.filter((event) => event.type === 'dispatch/started')
  assert.equal(started.length, 1, '夹具前提：只有一笔派发')
  assert.equal(started[0]?.data['reused'], true, '必须标出"这是复用投递"')
  assert.equal(started[0]?.data['messageReceipt'], 'id=MSG-9', '宿主回执必须进真源')
  assert.equal(typeof started[0]?.seq, 'number', '序号即"可复算锚点"（回执里要印出来）')
})
