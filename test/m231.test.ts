/**
 * **增量 231（`TASK-196`）：复用**决策**与**读数**同源 + 「没复用」必须自带原因。**
 *
 * 三条缺陷（`DEF-185` / `DEF-186` / `DEF-139`）在真台上的共同形状 —— **同一次 `dispatch/started`**
 * 里同时出现：
 *
 *   ```text
 *   role=developer reuseIdle=true forceNew=false
 *   buckets={idle:68, idleSameParent:29, idleUnknownParent:39, unusable:0, busy:0}
 *   reused=false
 *   reuseSkipped=<absent>    且 .sdo/journal.jsonl 里 dispatch/reuse-skipped 0 条
 *   ```
 *
 * 真源出处（本卡复现时实录）：TASK-188 seq 4982、TASK-196 seq 4998（developer）；
 * 同条件的 reviewer seq 4986 是 `idle=1/unusable=5` 且 `reused=true`。
 * 也就是说：**读数说「有一堆可复用」，决策却每次都新起，而且台账里一个字都不解释**。
 *
 * 本文件守的是**修完之后的**稳定事实，**不是**把缺陷形状断言成期望值：
 *   · `M231-01`（DoD 落点三① + 落点一）真装配链（`office.poolPlan` → `index.ts` 的 `sdo_plan`）
 *     上，池里同时有「本会话起的、宿主真能投的」与「老会话」两个候选时，**必须复用前者**，
 *     且 `dispatch/started` 的桶读数与准入用的那份池**逐字段相等**；
 *   · `M231-02`（落点二）自洽判据**两态**：自洽 ⇒ 放行；不自洽 ⇒ 判红并**把两边的值点名**；
 *   · `M231-03`（落点二）投递被拒**不许静默**：`idle>0 && unusable=0 && reused=false` 时，
 *     事件里**必须**有一条带原因的 `reuseSkipped`，并逐条落 `dispatch/reuse-skipped`；
 *   · `M231-04`（落点三②）闸门拒掉的孩子 ⇒ `dispatch/reuse-skipped` 事件非空且**三字段逐条**。
 *
 * 与 `m206` 的分工（`DEF-186` 的「守卫只覆盖夹具路径」）：`m206` 走的是**单候选**夹具
 * （一个同父空闲孩子），真机的分布是**68 个候选混在一起**，所以它的绿证明不了真路径绿。
 * 本文件的候选是**两个**（未知父会话在前 / 同父在后），与真机 `pool.idle` 的顺序同构。
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
import { maskFingerprint } from '../src/domain/roles.js'
import { REUSE_SKIPPED_EVENT, readDispatchReadings, reuseSkippedOf } from '../src/domain/dispatchFace.js'
import { reuseSkippedRowsFromEvents } from '../src/domain/pool.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm231')
const WORKSPACE = join(BASE, 'proj')
/** 观察者（派发器）会话 id —— 与真机同形：`session-<uuid>`。 */
const SESSION = 'session-0000m231-0000-4000-8000-00000000231a'

/** **父会话未知**的老会话（真机上 `idleUnknownParent` 那一桶：老事件没有 `parentSessionId`）。 */
const LEGACY = 'aaaa2310-1111-4bbb-8ccc-dddddddddd01'
/** **本会话起的**子代理（`idleSameParent`：池视图自己标注「派发器真的能投」）。 */
const OWN = 'bbbb2310-2222-4bbb-8ccc-dddddddddd02'
/** 掩码过期的孩子（闸门拒 ⇒ 必须有逐条理由）。 */
const STALE_MASK = 'cccc2310-3333-4bbb-8ccc-dddddddddd03'

let office: SoftwareDevOffice
const call = { sessionId: SESSION, cwd: WORKSPACE } as unknown as OfficeCall

function writeYamlTask(task: TaskCard): void {
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${task.id}.yml`], { task })
}

function card(id: string): TaskCard {
  return {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: ['src/m231/pool.ts'], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements: [], evidence: [], createdAt: '', updatedAt: '',
  } as unknown as TaskCard
}

/**
 * 在**台账**里造一个「派过、结算了」的孩子（真源形状与真机一致）。
 *
 * `parentSessionId === ''` ⇒ **不写这个字段**：真机老事件就是这样（`text(event.data.parentSessionId)`
 * 折叠成空串 ⇒ 进 `idleUnknownParent`）。写空串反而会伪造一种真机不存在的事件形状。
 */
function seedChild(childSessionId: string, taskId: string, parentSessionId: string, mask = maskFingerprint('developer')): void {
  office.recordDispatchStarted(call, {
    taskId,
    provider: 'spawn',
    childSessionId,
    ...(parentSessionId === '' ? {} : { parentSessionId }),
    tools: 3,
    role: 'developer',
    mode: 'continuable',
    maskHash: mask,
  })
  office.journalFor(WORKSPACE).append('dispatch/finished', { task: taskId, childSessionId })
  // R-1：复用要求**正面证据**（观测到手里有工具）。没有它，所有候选都会被"没有观测"挡掉，
  // 那样本文件守的就变成"全被拒"而不是"该复用的复用"。
  office.noteChildFace(call, {
    childSessionId, tools: ['bash', 'edit', 'read'], violations: [], calls: [], callCount: 0,
  })
}

/** 宿主桩回执里记下**谁被投递过**（复用是否真的投给了那个孩子，靠它判，不靠猜）。 */
const delivered: string[] = []

/**
 * 挂一个宿主桩：`start` 新起 / `startContinuable` 建可续聊 / `sendMessage` 是**复用**的投递原语。
 *
 * `undeliverable` 模拟"这个候选其实已经投不进去了"（宿主冷恢复失败 / 会话不在了）——
 * 真机上这就是 `pool.idle` 里躺着 68 个候选、却每次都被拒的那类老会话。
 * 它在真源里**查不到**（`dispatch/started` 至今不记 `reuseFailed`），所以本文件顺带守住
 * 「投递失败必须留下原因」这件事（`M231-03`）。
 */
function mount(undeliverable: readonly string[] = []): {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}[] {
  delivered.length = 0
  const tools: { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[] = []
  const services: Record<string, unknown> = {}
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
  services['tools'] = { register: (tool: unknown) => { tools.push(tool as (typeof tools)[number]); return () => {} } }
  services['subagents'] = {
    list: () => ['spawn'],
    start: async () => ({ id: 'child-oneshot-m231' }),
    startContinuable: async () => ({ childId: 'child-fresh-m231' }),
    sendMessage: async (_sender: unknown, targetId: string) => {
      if (undeliverable.includes(targetId)) {
        throw new Error(`宿主拒绝：子会话 ${targetId} 已不在（冷恢复失败）`)
      }
      delivered.push(targetId)
      return { messageId: 'msg-m231' }
    },
    getProvider: () => ({ capabilities: { toolFilter: true } }),
    listDescendants: async () => [],
  }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  return tools
}

async function callTool(
  tools: { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[],
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: SESSION, session: { header: { id: SESSION, cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub }))
}

function lastStarted(): Record<string, unknown> {
  const event = office.journalFor(WORKSPACE).read().events.filter((row) => row.type === 'dispatch/started').at(-1)
  assert.ok(event !== undefined, '必须落了 dispatch/started（否则下面全是空断言）')
  return event.data
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession(SESSION, WORKSPACE)
  office.init(call, { name: 'M231 复用决策与读数同源', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/* —————————————————————————————— 落点二：自洽判据（两态） —————————————————————————————— */

/**
 * **复用自洽判据**（`DEF-185` 落点二）。
 *
 * 规则：**`idle>0` 且 `unusable=0` 且 `reused=false` ⇒ 必须至少有一条 `reuseSkipped` 带原因。**
 * 违反它就意味着「池里明明有可复用的、闸门一个都没拦、最后却没复用、台账还不解释」——
 * 这正是真机反推错过两次的那个形状。返回 `undefined` = 自洽；返回字符串 = **判红并点名两边值**。
 *
 * 刻意**不**把 `reuseIdle=false` / `forceNew=true` 判成不自洽：那两种是"没打算复用"，
 * 由事件上的两个**定案键**另行说明（它们为空才是缺陷，见 `M231-02` 的第三态）。
 */
function inconsistencyOf(data: Record<string, unknown>): string | undefined {
  const reuseIdle = data['reuseIdle'] === true
  const forceNew = data['forceNew'] === true
  const reused = data['reused'] === true
  const buckets = (data['buckets'] ?? {}) as Record<string, unknown>
  const idle = Number(buckets['idle'] ?? 0)
  const unusable = Number(buckets['unusable'] ?? 0)
  const skipped = Array.isArray(data['reuseSkipped']) ? data['reuseSkipped'] : []
  // 没试过复用 ⇒ 清单为空是正确的（"没打算复用"≠"判据全过却不复用"）
  if (!reuseIdle || forceNew) return undefined
  if (reused) return undefined
  if (idle <= 0 || unusable > 0) return undefined
  const withReason = skipped.filter((row) => {
    const reason = (row as { reason?: unknown }).reason
    return typeof reason === 'string' && reason.trim() !== ''
  })
  if (withReason.length > 0) return undefined
  return `不自洽：reuseIdle=true forceNew=false 但 reused=false，而 buckets.idle=${String(idle)}、buckets.unusable=${String(unusable)}（闸门一个都没拦），reuseSkipped=${String(skipped.length)} 条 —— 「为什么没复用」在台账里没有答案`
}

test('M231-02 落点二 自洽判据**两态**：自洽 ⇒ 放行；不自洽 ⇒ 判红并把两边值点名', () => {
  // ① 真机缺陷形状（`DEF-185` 的原样读数：TASK-188 seq 4982）⇒ 必须判红，且把 idle / unusable / reuseSkipped 三个数点名
  const defective = inconsistencyOf({
    reuseIdle: true, forceNew: false, reused: false,
    buckets: { idle: 68, idleSameParent: 29, idleUnknownParent: 39, unusable: 0, busy: 0 },
  })
  assert.ok(defective !== undefined, 'idle=68 / unusable=0 / reused=false 且零条 reuseSkipped ⇒ 必须判红（这就是 DEF-185）')
  assert.match(defective, /idle=68/u, `判红必须点名 idle 的实际值：${defective}`)
  assert.match(defective, /unusable=0/u, `判红必须点名 unusable 的实际值：${defective}`)
  assert.match(defective, /reuseSkipped=0/u, `判红必须点名 reuseSkipped 的条数：${defective}`)

  // ② 自洽态：同一个不复用的决定，但**带了原因** ⇒ 放行（不许把"没复用但有解释"也判红）
  assert.equal(inconsistencyOf({
    reuseIdle: true, forceNew: false, reused: false,
    buckets: { idle: 68, idleSameParent: 29, idleUnknownParent: 39, unusable: 0, busy: 0 },
    reuseSkipped: [{ childSessionId: LEGACY, role: 'developer', reason: '宿主拒绝：该子会话已不在' }],
  }), undefined, '有原因 ⇒ 自洽（判据守的是"没有答案"，不是"不许不复用"）')

  // ③ 三态互斥：`reuseIdle=false`（宿主没有续聊入口）/ `forceNew=true`（本轮就换人）⇒ 不算不自洽
  assert.equal(inconsistencyOf({ reuseIdle: false, forceNew: false, reused: false, buckets: { idle: 9, unusable: 0 } }), undefined, '没打算复用 ⇒ 空清单正确')
  assert.equal(inconsistencyOf({ reuseIdle: true, forceNew: true, reused: false, buckets: { idle: 9, unusable: 0 } }), undefined, '强制新起 ⇒ 空清单正确')
  // ④ 闸门拦了人（unusable>0）⇒ 由闸门那批 reuseSkipped 解释，不算不自洽
  assert.equal(inconsistencyOf({ reuseIdle: true, forceNew: false, reused: false, buckets: { idle: 0, unusable: 5 } }), undefined, '没有可复用候选 ⇒ 不算不自洽')
  // ⑤ 真复用了 ⇒ 不需要解释
  assert.equal(inconsistencyOf({ reuseIdle: true, forceNew: false, reused: true, buckets: { idle: 1, unusable: 0 } }), undefined, '复用了 ⇒ 自洽')
})

/* ———————————————————— 落点一 + 落点三①：真装配链上真的复用同一个孩子 ———————————————————— */

test('M231-01 落点三① 真装配链：老会话排在前、同父孩子在后 ⇒ **必须复用同父那个**，且事件读数与准入同一份池', async () => {
  // 候选顺序与真机 `pool.idle` 同构：未知父会话的**老会话**在前（journal 折叠顺序），本会话起的在后。
  // 真机实录（`office.poolPlan` 现跑）：idle[0..5] 全是 parentSessionId="" 的老会话。
  seedChild(LEGACY, 'TASK-23100', '')
  seedChild(OWN, 'TASK-23101', SESSION)
  writeYamlTask(card('TASK-23102'))

  // 决策面：准入必须挑**本会话起的**那个候选（池视图自己标注它「派发器真的能投」），
  // 而不是 `pool.idle[0]` 那个老会话（真机上它一投就被宿主拒 ⇒ 每次都新起、且台账不解释）。
  const plan = office.poolPlan(call, { reuseIdle: true })
  // **准入前**那份池：`plan.pools` 是准入**之后**的（复用支只把它从 `idle` 摘走、记进 `reuseAdmissions`，
  // **不写** `busy`，那是决定的结果 —— `TASK-245` / `DEF-229`），
  // 所以"池里有几个候选"必须读准入前的那一份 —— 拿结果当原因就是循环论证。
  const view = office.poolView(call).find((pool) => pool.role === 'developer')
  assert.ok(view !== undefined, '夹具前提：developer 池必须在场（否则下面全是空断言）')
  assert.equal(view.idle.length, 2, `两个候选都必须算作"空闲可复用"：${JSON.stringify(view.idle.map((row) => row.childSessionId))}`)
  assert.equal(view.unusable.length, 0, '两个候选的观测与掩码都齐 ⇒ 闸门不许拦任何人')
  assert.equal(view.idleSameParent.length, 1, '同父候选 1 个（这是宿主真能投的那一桶）')
  assert.equal(view.idleUnknownParent, 1, '父会话未知的老候选 1 个')
  const picked = plan.dispatch.find((row) => row.task.id === 'TASK-23102')?.reuseChildId
  assert.equal(picked, OWN, `必须优先复用**同父**的那个候选（修前挑 idle[0] = 老会话）：${JSON.stringify(plan.dispatch)}`)

  // **落点一（读数与决策同源）**：事件里的桶读数必须与池视图**逐字段**相等，一项不等就要点名两边值。
  const reading = plan.readings?.find((row) => row.role === 'developer')
  assert.ok(reading !== undefined, '读数必须在场（没有读数就答不了"孩子是不是根本没取到"）')
  const fieldPairs: [string, number, number][] = [
    ['idle', reading.buckets.idle, view.idle.length],
    ['idleSameParent', reading.buckets.idleSameParent, view.idleSameParent.length],
    ['idleForeign', reading.buckets.idleForeign, view.idleForeign.length],
    ['idleUnknownParent', reading.buckets.idleUnknownParent, view.idleUnknownParent],
    ['stale', reading.buckets.stale, view.stale.length],
    ['retired', reading.buckets.retired, view.retired],
    ['unusable', reading.buckets.unusable, view.unusable.length],
    ['busy', reading.buckets.busy, view.busy.length],
  ]
  for (const [name, fromReading, poolValue] of fieldPairs) {
    assert.equal(
      fromReading,
      poolValue,
      `落点一：桶 ${name} 两边必须是同一份快照（读数 ${String(fromReading)} / 池视图 ${String(poolValue)}）`,
    )
  }
  assert.equal(reading.freeSlots, view.freeSlots, `落点一：freeSlots 两边同源（读数 ${String(reading.freeSlots)} / 池 ${String(view.freeSlots)}）`)
  assert.equal(reading.cap, view.cap, '落点一：cap 两边同源')
  assert.equal(reading.childrenSource, 'journal', '口径名必须写清（孩子从 append-only 台账折叠而来）')
  // **决策消费的就是读数报的那一份**：恰好 1 个孩子从 `idle` 挪进**计划面**（`TASK-245` / `DEF-229`：
  // 准入是计划、`dispatch/started` 才是事实 ⇒ 它**不**进 `busy`），而且挪走的正是读数在 `idle` 里报的
  // 那一个（不是从别的桶里挑的）。修前这里断言的是「准入后 busy 必须 +1」—— 那条恰好编码了本卡要修的
  // 行为（把准入写成在飞），所以它被换成下面三条：同一条意图（决策消费读数报的那一份）在三处同时成立。
  const after = plan.pools.find((pool) => pool.role === 'developer')
  assert.ok(after !== undefined, '准入后的池必须在场')
  assert.equal(after.idle.length, view.idle.length - 1, `可复用候选恰好被摘走 1 个（准入前 ${String(view.idle.length)} ⇒ 准入后 ${String(after.idle.length)}）`)
  const seat = plan.reuseAdmissions.find((row) => row.task === 'TASK-23102')
  assert.equal(
    seat?.childSessionId,
    picked,
    `准入的复用分配必须落在计划面（reuseAdmissions）且与 dispatch 同一份：${JSON.stringify(plan.reuseAdmissions)}`,
  )
  const consumedFromIdle = view.idle.some((row) => row.childSessionId === seat?.childSessionId)
  assert.equal(consumedFromIdle, true, 'consumed candidate must be the one the readings reported in idle')
  // **消费身份**（`REV-119` #1）：上一条只判「这个 id 当初在 idle 名单里」、且 `seat` 与 `picked` 同源赋值
  // ⇒ 摘错人时两边一起错也照样绿。这里补上「摘走的是它、不是别人」：准入之后 `idle` 里**不再有它**
  // （夹具的 idle 顺序是老会话 LEGACY 在前 ⇒ 把 `findIndex(...)` 换成 `splice(0, 1)` 会被这条抓住）。
  const stillIdle = (after.idle ?? []).some((row) => row.childSessionId === seat?.childSessionId)
  assert.equal(stillIdle, false, `the consumed candidate must be gone from idle (identity, not membership): ${JSON.stringify((after.idle ?? []).map((row) => row.childSessionId))}`)
  assert.equal(
    after.busy.length,
    view.busy.length,
    `busy must hold folded facts only (a plan seat is not in-flight): 准入前 ${String(view.busy.length)} ⇒ 准入后 ${String(after.busy.length)}`,
  )

  // 真派发路径：走 `sdo_plan action=next`（宿主桩），真的复用同一个孩子
  const tools = mount([LEGACY])
  await callTool(tools, 'sdo_plan', { action: 'next', limit: 1 })
  const started = lastStarted()
  assert.deepEqual(delivered, [OWN], `投递必须落在同父那个孩子上（修前投的是老会话 LEGACY，被宿主拒后静默新起）：${JSON.stringify(delivered)}`)
  assert.equal(started['childSessionId'], OWN, `复用的就是那个空闲孩子（不是新起一个）：${String(started['childSessionId'])}`)
  assert.equal(started['reused'], true, '`dispatch/started.reused` 必须为 true（`DEF-139` 的关闭条件：developer 真的被复用一次）')
  assert.equal(started['reuseIdle'], true, '定案键：这一轮**试过**复用')
  assert.equal(started['forceNew'], false, '定案键：不是强制新起')

  // **DoD ②（`REV-119` #2）**：真派发**之后**回头读池视图 —— 复用成功的那一个必须**真的**出现在 busy 里。
  // 为什么必须在这一格：`M250-14` 用的是手写事件、零真派发，抓不住「真复用派发成功后 busy 没有它」
  // （那正是本卡把 busy 停写之后最可能踩的坑）。
  const afterDispatch = office.poolView(call).find((pool) => pool.role === 'developer')
  const busyIds = (afterDispatch?.busy ?? []).map((row) => row.childSessionId)
  assert.equal(
    busyIds.includes(OWN),
    true,
    `真复用派发之后该会话必须出现在 busy（投递 ${JSON.stringify(delivered)} / busy ${JSON.stringify(busyIds)}）`,
  )

  // 事件上的读数与计划里的读数一致（同一份快照写进台账，不是另算一次）
  const eventBuckets = (started['buckets'] ?? {}) as Record<string, unknown>
  assert.deepEqual(eventBuckets, reading.buckets, '台账里的八桶必须与计划里那份读数逐字段相同')

  // 复用成功 ⇒ 台账必须**自洽**（判据放行）；且不允许出现"复用被拒"的凭空理由
  assert.equal(inconsistencyOf(started), undefined, `复用成功的一笔必须自洽：${String(inconsistencyOf(started))}`)
  assert.equal(
    office.journalFor(WORKSPACE).read().events.filter((row) => row.type === REUSE_SKIPPED_EVENT).length,
    0,
    '没人被拒 ⇒ 不许凭空造 `dispatch/reuse-skipped`（理由必须是事实）',
  )
})

/* ————————————————— 落点二：投递被拒不许静默（缺陷形状必须自带原因） ————————————————— */

test('M231-03 落点二 投递被拒**不许静默**：`idle>0 && unusable=0 && reused=false` ⇒ 事件里必须有一条带原因的 reuseSkipped', async () => {
  // 唯一候选是个"还在池里、但已经投不进去"的老会话 —— 真机上 `pool.idle` 里 68 个候选就是这么躺着的。
  seedChild(LEGACY, 'TASK-23110', '')
  writeYamlTask(card('TASK-23111'))

  const tools = mount([LEGACY])
  await callTool(tools, 'sdo_plan', { action: 'next', limit: 1 })
  const started = lastStarted()

  // 这一笔事实上没复用到（宿主拒了，只能新起）—— 那是允许的；**不允许的是不解释**。
  assert.equal(started['reused'], false, '宿主拒了复用 ⇒ 如实记 reused=false（不假装复用成功）')
  assert.equal(started['reuseIdle'], true, '这一轮确实试过复用')
  assert.equal(started['forceNew'], false, '不是强制新起')

  // **核心断言**：判据必须放行 —— 即"没复用"必须带原因（修前这里 `reuseSkipped` 是缺席的）
  const verdict = inconsistencyOf(started)
  assert.equal(verdict, undefined, `投递被拒必须留下原因（否则就是 DEF-185 的形状）：${String(verdict)}`)

  const skipped = (started['reuseSkipped'] ?? []) as { childSessionId?: string; role?: string; reason?: string }[]
  assert.ok(skipped.length >= 1, `事件上必须带逐条理由：${JSON.stringify(started['reuseSkipped'])}`)
  const row = skipped.find((item) => item.childSessionId === LEGACY)
  assert.ok(row !== undefined, `被拒的那个候选必须被点名：${JSON.stringify(skipped)}`)
  assert.equal(row.role, 'developer', '三字段之一：角色')
  assert.match(row.reason ?? '', /宿主|拒绝|不在|失败/u, `理由要能照着读（宿主给的原话要带上）：${String(row.reason)}`)

  // 独立事件也必须逐条落盘（承载②：一行一条、三字段不聚合），读侧才数得清
  const events = office.journalFor(WORKSPACE).read().events.filter((e) => e.type === REUSE_SKIPPED_EVENT)
  assert.ok(events.length >= 1, `必须落 dispatch/reuse-skipped 事件（修前恒 0 条）：${JSON.stringify(events.map((e) => e.data))}`)
  const recorded = reuseSkippedOf(office.journalFor(WORKSPACE)).find((item) => item.childSessionId === LEGACY)
  assert.ok(recorded !== undefined, '读侧必须能按子会话反查到这条理由')
  assert.match(recorded.reason, /宿主|拒绝|不在|失败/u, `读回来的理由要带宿主原话：${recorded.reason}`)
})

/* ————————————————————— 落点三②：闸门拒掉的孩子逐条落事件 ————————————————————— */

test('M231-04 落点三② 闸门拒掉的孩子 ⇒ `dispatch/reuse-skipped` 事件非空且**三字段逐条**', async () => {
  // 掩码过期（判据不过）+ 观测齐全 ⇒ 只该被**掩码**那一条理由挡住
  seedChild(STALE_MASK, 'TASK-23120', SESSION, 'stale-mask-0000')
  // 同时给一个真能用的候选：闸门拒一个、复用另一个 —— 两件事同一次派发里都要看得见
  seedChild(OWN, 'TASK-23121', SESSION)
  writeYamlTask(card('TASK-23122'))

  const plan = office.poolPlan(call, { reuseIdle: true })
  const gateRows = plan.reuseSkipped.filter((row) => row.childSessionId === STALE_MASK)
  assert.equal(gateRows.length, 1, `闸门拒的孩子必须**逐条**露面：${JSON.stringify(plan.reuseSkipped)}`)
  assert.equal(gateRows[0]?.role, 'developer', '三字段之一：角色（跨角色混在一起正是看不清的主因）')
  assert.match(gateRows[0]?.reason ?? '', /掩码/u, `理由要与池视图逐字同源：${String(gateRows[0]?.reason)}`)

  const tools = mount()
  await callTool(tools, 'sdo_plan', { action: 'next', limit: 1 })
  const started = lastStarted()
  // 闸门拒 ≠ 不复用：另一个候选照常复用（不许"一有人不合格就整体新起"）
  assert.equal(started['childSessionId'], OWN, '另一个候选合格 ⇒ 照常复用它')
  assert.equal(started['reused'], true, '复用成功')

  const events = office.journalFor(WORKSPACE).read().events.filter((e) => e.type === REUSE_SKIPPED_EVENT)
  assert.ok(events.length >= 1, `闸门拒的孩子必须落独立事件：${JSON.stringify(events.map((e) => e.data))}`)
  /**
   * **`TASK-224`**：事件形状改成"一行一个原因"，孩子 id 落在 `reasons[].sampleChildIds` 里 ⇒
   * 改从**读侧展开**取（断言对象与强度不变：仍然要求"事件里点名了那个孩子"），并新增"只写 1 条"。
   */
  assert.equal(events.length, 1, `一次派发只写一条聚合事件：${JSON.stringify(events.map((e) => e.data))}`)
  const expanded = reuseSkippedRowsFromEvents(events).rows
  const event = expanded.find((row) => row.childSessionId === STALE_MASK)
  assert.ok(event !== undefined, `事件里必须点名那个孩子：${JSON.stringify(events.map((e) => e.data))}`)
  // 三字段仍逐一断言（role / reason / task / decidedAt 一条不少），只是前两个取自**展开后的行**
  assert.equal(event.role, 'developer', '事件三字段之一：role')
  assert.match(String(event.reason ?? ''), /掩码/u, '事件三字段之一：reason（逐字同源）')
  const carrier = events[0]?.data ?? {}
  assert.equal(carrier['task'], 'TASK-23122', '事件必须带所属卡（读者不必再去别处拼装上下文）')
  assert.equal(typeof carrier['decidedAt'], 'string', '事件必须带判定时刻')
  // 读侧回读：同一份台账两次读数一致（`REQ-035` / `REQ-037` 可复现性口径）
  assert.deepEqual(
    reuseSkippedOf(office.journalFor(WORKSPACE)),
    reuseSkippedOf(office.journalFor(WORKSPACE)),
    '同一台账两次读侧回读必须逐字节相同',
  )
  // 读数面（`readDispatchReadings`）也必须读得回这一笔的现场
  const readings = readDispatchReadings(office.journalFor(WORKSPACE)).filter((row) => row.task === 'TASK-23122')
  assert.equal(readings.length, 1, `派发那一笔的现场读数必须可回读：${JSON.stringify(readings)}`)
})
