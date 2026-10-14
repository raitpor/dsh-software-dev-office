/**
 * **增量 159：独占构建窗口（DEF-007 / §3E 族 2）—— 本批最后一条**。
 *
 * 缺陷现场（三份 re-verify 的原探针，逐条可复算）：两张都要跑**全量构建**的卡，写范围**不相交**
 * （`src/domain/` × `src/interface/`）⇒ `validatePlan` **无 issue**、`readyTasks(…, 4)` **同时返回两张**、
 * `scopeHeldTasks` **空** —— 于是两份构建各自读到对方写了一半的源。旧口径只能靠人工给某张卡写
 * `blockedBy: ['*']`（"等所有其它卡"，既是另一条语义、也没人保证写得对）。
 *
 * 修法：把"独占窗口"变成**一等声明** —— 卡声明一个**组名**（自由文本，插件**不内置任何组名**，红线 4），
 * 同组**同时只能有一张卡在跑**：`readyTasks` 按组串行，`classifyNonDispatchable` 增第五类 `exclusive`
 * 点名挡路者。**静态面不动**（同组允许多张卡存在 —— 排队顺序执行才是它的用途），所以 `validatePlan`
 * **不加**判据；缺陷在**动态派发**那一面。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { classifyNonDispatchable, createTask, listTasks, readyTasks, scopeHeldTasks, validatePlan } from '../src/domain/plan.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { Journal } from '../src/infra/journal.js'
import type { SdoStore } from '../src/infra/store.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m159/', import.meta.url))

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
  office.init(call, { name: `M159 ${name}`, scale: 'normal', stakeholders: ['业务方'] })
  return { office, store: office.storeFor(workspace), journal: office.journalFor(workspace), call, workspace }
}

function newCard(f: Fixture, scope: string, extra: Record<string, unknown> = {}): TaskCard {
  return createTask(f.store, f.journal, {
    title: `卡 ${scope}`,
    goal: 'g',
    dod: ['d'],
    role: 'developer',
    size: 'small',
    writeScopes: [scope],
    ...extra,
  } as never)
}

function markDone(f: Fixture, cardId: string): void {
  const card = listTasks(f.store).find((item) => item.id === cardId)
  assert.ok(card !== undefined, `夹具前提：卡 ${cardId} 必须存在`)
  f.store.writeYaml(['tasks', `${cardId}.yml`], { task: { ...card, status: 'done' } })
}

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M159-01 行为两态：同组只派一张（写范围不相交也拦），另一张进 exclusive 类并点名挡路者；异组照常都给', () => {
  const f = fixture('pair')
  const a = newCard(f, 'src/a/', { exclusive: 'full-build' })
  const b = newCard(f, 'src/b/', { exclusive: 'full-build' })
  const c = newCard(f, 'src/c/', { exclusive: 'other-window' })

  // **静态面不动**（这正是原探针的前半段：写范围不相交 ⇒ `validatePlan` 与 `scopeHeldTasks` 都没意见）
  assert.deepEqual(scopeHeldTasks(f.office.tasks(f.call)), [], '夹具前提：两张卡写范围不相交（本条不是写范围那一轴）')
  const issues = validatePlan(f.office.tasks(f.call))
  assert.deepEqual(
    issues.filter((issue) => String(issue.code).includes('scope')),
    [],
    `夹具前提：静态判据不得报写范围问题：${JSON.stringify(issues)}`,
  )

  // ① 同组：**只派一张**（先到先得，按与回执同一排序）
  const ready = f.office.readyForDispatch(f.call, 4).map((task) => task.id)
  assert.equal(ready.includes(a.id), true, `先到先得的那张必须可派：${JSON.stringify(ready)}`)
  assert.equal(ready.includes(b.id), false, `同组第二张**不得**同轮派出（缺陷本体：两张同时被派）：${JSON.stringify(ready)}`)
  // ② 异组：照常可派（反例：不得把"独占"误伤成"一次只能派一张"）
  assert.equal(ready.includes(c.id), true, `不同组名的卡必须照常可派：${JSON.stringify(ready)}`)

  // ③ 回执必须点名"谁挡着谁"，且不回落成"没有可派发的卡"
  const plan = f.office.nonDispatchable(f.call)
  assert.equal(plan.exclusive?.length, 1, `被挡下的必须单列一类：${JSON.stringify(plan.exclusive)}`)
  assert.equal(plan.exclusive?.[0]?.task.id, b.id, '被挡的是同组第二张')
  assert.equal(plan.exclusive?.[0]?.other, a.id, '必须点名挡路的那张卡（同排序口径）')
  assert.equal(f.office.readyForDispatch(f.call, 4).length > 0, true, '有卡可派时不得回落到"没有可派发的卡"')
})

test('M159-02 反例（两态恢复）：在飞的那张收工/作废后 ⇒ 排队的那张自动放行；撤回声明后 ⇒ 不再互斥', () => {
  const f = fixture('recover')
  const first = newCard(f, 'src/one/', { exclusive: 'full-build' })
  const second = newCard(f, 'src/two/', { exclusive: 'full-build' })
  // 先让第一张**在飞**（真认领）：第二张必须被挡（在飞那一张就是这个窗口的持有者）
  const claimed = f.office.claimTask(f.call, { taskId: first.id, owner: 'dev', expectedRevision: first.revision })
  assert.equal(claimed.ok, true, `夹具前提：第一张必须能认领：${JSON.stringify(claimed)}`)
  assert.deepEqual(f.office.readyForDispatch(f.call, 4).map((task) => task.id), [], '同组已有在飞 ⇒ 一张都不派')
  assert.equal(f.office.nonDispatchable(f.call).exclusive?.[0]?.other, first.id, '挡路者必须是那张在飞卡')

  // ① 收工 ⇒ 放行
  markDone(f, first.id)
  assert.deepEqual(f.office.readyForDispatch(f.call, 4).map((task) => task.id), [second.id], '持有者收工后必须自动放行')
  assert.equal(f.office.nonDispatchable(f.call).exclusive, undefined, '没有挡路者时这一类**键都不出现**')

  // ② 撤回声明（`exclusive: ''`）⇒ 不再互斥
  const updated = f.office.updateTask(f.call, { taskId: second.id, by: 'human', exclusive: '' })
  assert.equal(updated.ok, true, `撤回声明必须可写：${JSON.stringify(updated)}`)
  assert.equal(listTasks(f.store).find((task) => task.id === second.id)?.exclusive, undefined, '撤回后卡面不得留空值')
  const other = newCard(f, 'src/three/', { exclusive: 'full-build' })
  assert.deepEqual(
    f.office.readyForDispatch(f.call, 4).map((task) => task.id),
    [second.id, other.id],
    '撤回声明后两张都不再互斥（先到先得口径不得留下"幽灵组"）',
  )
})

test('M159-03 字段面（五处同步的实证）：建卡/读回/改卡/撤回都能落，且不传时形状逐字节不变', () => {
  const f = fixture('field')
  const card = newCard(f, 'src/x/', { exclusive: 'full-build' })
  assert.equal(listTasks(f.store).find((task) => task.id === card.id)?.exclusive, 'full-build', '建卡即落（createTask 映射）')

  const renamed = f.office.updateTask(f.call, { taskId: card.id, by: 'human', exclusive: 'release-window' })
  assert.equal(renamed.ok, true, `改卡必须可写：${JSON.stringify(renamed)}`)
  assert.equal(listTasks(f.store).find((task) => task.id === card.id)?.exclusive, 'release-window', 'updateTask 必须真的改到卡面')

  // **零破坏**：没有任何卡声明独占组时，分类结果的键集合与以前逐字节相同
  const g = fixture('zero')
  const plain = newCard(g, 'src/p/')
  const plan = classifyNonDispatchable(g.office.tasks(g.call))
  assert.equal('exclusive' in plan, false, '没人声明独占组时不得多出这一类')
  assert.deepEqual(Object.keys(plan).sort(), ['blocked', 'dependencies', 'scope'], '键集合与以前逐字相同')
  assert.deepEqual(readyTasks(g.office.tasks(g.call), 4).map((task) => task.id), [plain.id], '不声明独占组的卡行为不变')

  // 工具面/入口面：五处同步（schema + Args、execute、index 行映射、index update 分支、两包文案）
  // ⚠️ **这里不许用"出现次数"这种松断言**：本用例第一版写的是 `>= 3`，于是 MUT-07f（删掉 `execute`
  // 那一处映射）**存活**了 —— 参数会被静默丢弃（`tq_ff348198` 的正是不见的那一处）。改成**逐点钉住**。
  const tools = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  assert.equal(tools.includes('exclusive?: string | undefined'), true, 'Args 面必须声明这个参数')
  assert.equal(/\n {8}exclusive: \{\n/u.test(tools), true, 'schema 面必须暴露这个参数')
  assert.equal(
    tools.includes("exclusive: typeof args.exclusive === 'string' ? args.exclusive : undefined"),
    true,
    'execute 面必须把它映射下去（缺这一处 = 参数被静默丢弃）',
  )
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.equal(index.includes('row.exclusive'), true, 'index.ts 的建卡行映射必须带上它（否则静默丢弃）')
  assert.equal(index.includes('fields.exclusive.value'), true, 'index.ts 的 update 分支必须透传它')
  for (const pack of ['zh-CN.yml', 'en.yml']) {
    const text = readFileSync(join(ROOT, 'src', 'data', 'lang', pack), 'utf8')
    assert.equal(text.includes('kNonDispatchableExclusiveHead'), true, `${pack} 缺少 kNonDispatchableExclusiveHead`)
  }
})

test('M159-04 回执面：独占组被挡下**不得**回落成"没有可派发的卡"（与 DEF-040 同款陷阱）', () => {
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const renderer = source.slice(source.indexOf('function describeNonDispatchable'), source.indexOf('const ORACLE_KIND_KEYS'))
  assert.equal(renderer.includes('plan.exclusive'), true, '渲染侧必须单列这一行')
  assert.equal(
    /plan\.exclusive === undefined\s*\n?\s*&& plan\.blocked\.length === 0/u.test(renderer),
    true,
    '"本次没有派发：没有可派发的任务卡"那句必须排除"独占窗口排队"这种情形',
  )
})
