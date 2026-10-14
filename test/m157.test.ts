/**
 * **增量 157：复用不问"该会话手上是否还有在飞卡"（DEF-021 / §3E 族 2）**。
 *
 * 缺陷现场（现盘可复算，见 M157-01 的第一步）：子代理结算了一轮（`dispatch/finished` ⇒ 池视图显示
 * **空闲可复用**），却**没回报卡**（卡仍 `in-progress`）。此时池把新卡投进**同一个会话** ——
 * 两张卡在同一会话里互相踩（真机：池把 TASK-018 复用给持在飞卡的 `20af1d60`）。
 *
 * 病根是**输入面**：`admitDispatch` 的入参只有 `ready/pools/globalRoom/reuseIdle/maskHashOf/inProgress/
 * forceNew/reuseBlockedOf/reuseBudget` —— **没有任何"该会话手上持卡"的输入**。池状态只从 `dispatch/*`
 * 事件折叠（`foldPoolChildren`），而"谁手上持卡"是**卡的状态**（`task/claimed` × 卡状态），两者会分叉。
 *
 * 修法：把**卡的在飞状态**接进复用的唯一判据 —— `office.reuseBlockedOf(call)`（`rolePools` 池视图与
 * `admitDispatch` 准入拿的是**同一个**闭包 ⇒ 读数与行为不可能分叉，R-6 的教训），数据源是
 * `claimsBySession`（"会话 ↔ 在飞卡"的唯一出口）。
 *
 * ⚠️ **与 DEF-067 不是同一轴**：那条看**写范围相交**（写者互斥），本条看**会话持卡**（同一会话不许压两张卡）。
 * 写范围不相交的卡同样不许复用同一个持卡会话 —— 本用例的夹具正是"两张写范围不相交的卡"。
 */
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { createTask, listTasks } from '../src/domain/plan.js'
import { maskFingerprint } from '../src/domain/roles.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { Journal } from '../src/infra/journal.js'
import type { SdoStore } from '../src/infra/store.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m157/', import.meta.url))

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
  office.init(call, { name: `M157 ${name}`, scale: 'normal', stakeholders: ['业务方'] })
  return { office, store: office.storeFor(workspace), journal: office.journalFor(workspace), call, workspace }
}

function newCard(f: Fixture, scope: string, role = 'developer'): TaskCard {
  return createTask(f.store, f.journal, {
    title: `卡 ${scope}`,
    goal: 'g',
    dod: ['d'],
    role,
    size: 'small',
    writeScopes: [scope],
  } as never)
}

/** 让卡被**某个子会话**认领（写 `task/claimed` 带 sessionId ⇒ `claimsBySession` 认得它）。 */
function holdCard(f: Fixture, childSessionId: string, card: TaskCard, owner = 'dev'): void {
  const outcome = f.office.claimTask(
    { sessionId: childSessionId, cwd: f.workspace } as unknown as OfficeCall,
    { taskId: card.id, owner, expectedRevision: card.revision },
  )
  assert.equal(outcome.ok, true, `夹具前提：${card.id} 必须能被 ${childSessionId} 认领：${JSON.stringify(outcome)}`)
}

/** 造一个"结算过一轮、池里显示空闲可复用"的子会话（工具面**有**观测 ⇒ 其余判据都放行）。 */
function idleChild(f: Fixture, childSessionId: string, taskId: string, role: Parameters<typeof maskFingerprint>[0] = 'developer'): void {
  f.office.recordDispatchStarted(f.call, {
    taskId,
    provider: 'spawn',
    childSessionId,
    parentSessionId: f.call.sessionId ?? '',
    tools: 3,
    role,
    mode: 'continuable',
    // 掩码指纹必须与池现算的一致，否则这条用例会被"掩码已变更"先挡住、测不到本条判据
    maskHash: maskFingerprint(role),
  })
  f.journal.append('dispatch/finished', { taskId, childSessionId })
  appendFileSync(
    join(f.workspace, '.sdo', 'evidence', 'child-tools.jsonl'),
    JSON.stringify({ childSessionId, at: new Date().toISOString(), tools: ['read'], violations: [] }) + '\n',
  )
}

function admit(f: Fixture): ReturnType<SoftwareDevOffice['poolPlan']> {
  return f.office.poolPlan(f.call, { reuseIdle: true })
}

function markDone(f: Fixture, cardId: string): void {
  const card = listTasks(f.store).find((item) => item.id === cardId)
  assert.ok(card !== undefined, `夹具前提：卡 ${cardId} 必须存在`)
  f.store.writeYaml(['tasks', `${cardId}.yml`], { task: { ...card, status: 'done' } })
}

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M157-01 行为：子会话手上还有在飞卡 ⇒ **不得**把新卡复用给它，且点名它手上那张卡（池视图同源）', () => {
  const f = fixture('holds')
  const held = newCard(f, 'src/held/')
  holdCard(f, 'child-1', held)
  idleChild(f, 'child-1', held.id)
  const candidate = newCard(f, 'src/cand/') // 写范围**不相交**：本条不是写范围那一轴

  const plan = admit(f)
  assert.equal(
    plan.dispatch[0]?.reuseChildId,
    undefined,
    `持卡会话不得被复用（缺陷现场：它被复用给 ${candidate.id} 了）：${JSON.stringify(plan.dispatch)}`,
  )
  const skipped = plan.reuseSkipped.find((row) => row.childSessionId === 'child-1')
  // 池视图与准入同一个闭包 ⇒ 原因落在两处记账面之一：池视图的 `unusable`（角色池把它排除在 `idle` 之外）
  // 或准入的 `reuseSkipped`（`idle` 里被挡下的）。**必须有一处** —— 否则就是"静默新起"。
  const pool = f.office.poolView(f.call).find((row) => row.role === 'developer')
  const viewRow = pool?.unusable.find((row) => row.childSessionId === 'child-1')
  const reason = viewRow?.reason ?? skipped?.reason
  assert.ok(
    reason !== undefined,
    `必须如实记账"为什么没复用它"（池视图 unusable / 准入 reuseSkipped 至少一处）：${JSON.stringify({ unusable: pool?.unusable, reuseSkipped: plan.reuseSkipped })}`,
  )
  assert.match(reason, new RegExp(held.id, 'u'), '原因必须点名它手上那张卡')

  // **池视图与准入同一个闭包** ⇒ 该会话也必须被排除在"可复用空闲"之外（否则回执说"可复用 N"、行为却新起）
  assert.equal(
    pool?.idle.some((row) => row.childSessionId === 'child-1'),
    false,
    `持卡会话不得算作"可复用空闲"（否则 freeSlots 被不能用的人占掉）：${JSON.stringify(pool?.idle)}`,
  )
})

test('M157-02 反例（正常路径不受误伤）：不持卡的会话照常复用', () => {
  const f = fixture('free')
  const first = newCard(f, 'src/one/')
  idleChild(f, 'child-9', first.id)
  // 这张卡**没有**被任何会话持有（只是派发过一轮并结算）⇒ 该会话可以复用
  markDone(f, first.id)
  newCard(f, 'src/two/')

  const plan = admit(f)
  assert.equal(
    plan.dispatch[0]?.reuseChildId,
    'child-9',
    `不持卡的会话必须照常复用（不得把正常复用一并误伤）：${JSON.stringify(plan.dispatch)} / ${JSON.stringify(plan.reuseSkipped)}`,
  )
})

test('M157-03 反例（两态恢复）：持卡的那张卡收工之后 ⇒ 恢复可复用', () => {
  const f = fixture('recover')
  const held = newCard(f, 'src/held/')
  holdCard(f, 'child-3', held)
  idleChild(f, 'child-3', held.id)
  newCard(f, 'src/cand/')
  assert.equal(admit(f).dispatch[0]?.reuseChildId, undefined, '前置：持卡期间不得复用')

  markDone(f, held.id)
  assert.equal(
    admit(f).dispatch[0]?.reuseChildId,
    'child-3',
    '卡收工（不再 in-progress）⇒ 必须恢复可复用（否则池位被永久占掉）',
  )
})

test('M157-04 结构：判据的唯一出口是 claimsBySession，且池视图与准入共用 office 的同一个闭包', () => {
  const source = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  const helper = source.slice(source.indexOf('private reuseBlockedOf'), source.indexOf('unresolvedBlock(call: OfficeCall'))
  assert.equal(helper.includes('claimsBySession(store, journal)'), true, '会话持卡必须取自唯一出口 claimsBySession（不得自己重fold task/claimed）')
  assert.equal(helper.includes("fmt('uiPool.kReuseHoldsCard'"), true, '原因必须走语言包（两包同步）')
  // 两处消费点拿的是**同一个**闭包：池视图 + 准入（少一处就会"读数与行为分叉"）
  const used = (source.match(/reuseBlockedOf: this\.reuseBlockedOf\(call\)/gu) ?? []).length
  assert.equal(used, 2, `池视图与准入都要接同一个闭包，实际 ${used} 处`)
})
