/**
 * **`TASK-271`：角色池段把「本次准入」与「在飞」分开印**（从 `TASK-245` DoD 第 2 条移出）。
 *
 * 立案形状（`DEF-229` 的**显示面**那一半）：`TASK-245` 已经把「计划 vs 事实」在**数据面**拆开了 ——
 * 准入的复用位子只进 `PoolAdmission.reuseAdmissions`，`pool.busy` 只放由 `dispatch/started` 折叠出来的
 * 事实。但**显示面**没跟上：池段只印事实，于是「准入通过、被 `limit` 挡下」的那一态会出现
 * 「在飞 0/3、空闲可复用 0」—— 三行读数都在，**没有一行说这一轮的位子已经许出去了**。
 *
 * 本文件守四件事（卡上的落点二/三）：
 *   · `M271-01` **双态守卫①**：账态「准入 2 张、其中 1 张复用被 `limit` 挡下」⇒ 池段必须出现
 *     「本次已先准入 1 张（复用）」这一行（读 `reuseAdmissions`），且**不得**把那张卡印成在飞
 *     （池段里连卡号都不出现 —— 这一行是计数，定位仍只由 `busy` 那一路给）；
 *   · `M271-02` **双态守卫②（反向格）**：真的 `started{reused:true}` ⇒ 它**必须**还在在飞里
 *     （别为了消歧义把真在飞也赶出去）；`limit` 挡下的那张与它**不同**才是这一卡要的形状；
 *   · `M271-03` **双态守卫③**：零准入 ⇒ 池段与不改之前**逐字节相同**（不许多出一行空话）；
 *   · `M271-04` **不许措辞回退**：`kPoolLine` / `kPoolBusyMap` 的字形一个字节不动 ——
 *     判据是「加了计划面之后，除新增的行以外，其余每一行与不加时逐字相同」（只许追加）；
 *     同时把「不是在飞」这半句钉住（英文侧用固定字面量，中文侧按键取值 —— 见 `M271-05` 的边界）。
 *   · `M271-05` **接线**：上面四格都直接调渲染器，**证明不了** `src/index.ts` 真的把
 *     `plan.reuseAdmissions` 交进去了 ⇒ 这一格走真装配链（`sdo_plan action=next`），
 *     回执里必须出现那一行，且被 `limit` 挡下的卡不得以「卡号→子会话」的在飞定位形态出现。
 *
 * ⚠️ **本文件的写作纪律**（否则会把 `test/m189` 的散文清单顶红，而那张表不在本卡写范围）：
 *   断言行**一律英文消息**、**不出现内联中文串**（`test/proseInventory.ts` 的抽取器把
 *   「含读文本调用的行 + 内联中文」记成站点，站点要按文件登记条数）。中文只写在**注释**里，
 *   而且要避开同一行出现读文本调用；中文侧的**渲染判据**一律用 `fmt()` / `t()` 现取值，
 *   **不抄字形**。这是一条有代价的取舍，边界写在 `M271-05` 的注释里。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { admitDispatch, foldPoolChildren, rolePools } from '../src/domain/pool.js'
import { maskFingerprint } from '../src/domain/roles.js'
import { fmt, setLocale, t } from '../src/domain/i18n.js'
import { apply } from '../src/index.js'
import { describePoolBlock } from '../src/interface/describe.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { PoolEvent, RolePool } from '../src/domain/pool.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm271')
const WORKSPACE = join(BASE, 'proj')
const SESSION = 'cockpit-m271'
const MASK = 'm271-mask'
const CALL = { sessionId: SESSION, cwd: WORKSPACE } as unknown as OfficeCall

afterEach(() => {
  // 语言是**进程级**状态：本文件会临时切到英文（见 `M271-02`/`M271-04`），收工必须切回来，
  // 否则同进程里后面跑到的用例会读到英文渲染 —— 那种红与本卡无关，却会记在本卡账上。
  setLocale('zh-CN')
  rmSync(BASE, { recursive: true, force: true })
})

/* ———————————————————————————— 夹具：一张最小可派的卡 / 两笔台账事件 ———————————————————————————— */

function card(id: string, role: 'developer' | 'tester' = 'developer'): TaskCard {
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
    role,
    size: 'small',
    revision: 1,
    status: 'ready',
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
  }
}

/** 一笔**真的**派发：`reused: true` = 投给已有的空闲会话（`reused: false` = 新起）。 */
function startedEvent(task: string, child: string, at: string, reused: boolean): PoolEvent {
  return {
    type: 'dispatch/started',
    data: { task, childSessionId: child, role: 'developer', mode: 'continuable', maskHash: MASK, reused },
    at,
  }
}

/** 一笔结算（把孩子退回空闲）。 */
function finishedEvent(task: string, child: string, at: string): PoolEvent {
  return { type: 'dispatch/finished', data: { childSessionId: child, task, role: 'developer' }, at }
}

function poolsOf(events: PoolEvent[], roles: string[]): RolePool[] {
  return rolePools({
    children: foldPoolChildren(events).values(),
    roles,
    caps: { developer: 3, tester: 3 },
    defaultCap: 3,
    maskHashOf: () => MASK,
  })
}

/**
 * `DEF-229` 的账态（与 `test/m250.test.ts` 的 `admissionFixture` 同构）：池 `cap=3`、**0 真在飞**、
 * 1 个空闲可复用孩子 `c-old`（接过 3 轮 3 张）。
 *
 * 两张候选卡一起进准入，顺序与真机一致：第 1 张 `tester`（那个池空着）⇒ 走新起支；
 * 第 2 张 `developer` ⇒ 走**复用支**（摘走 `c-old`）。真机 `limit=1` 只派第 1 张，
 * 于是第 2 张**准入通过却没派** —— 它零 `dispatch/started`，只能在计划面读到。
 */
function heldAdmissionFixture(): {
  pools: ReturnType<typeof rolePools>
  admission: ReturnType<typeof admitDispatch>
  held: string
} {
  const ledger: PoolEvent[] = []
  for (const round of [1, 2, 3]) {
    ledger.push(startedEvent(`TASK-OLD-${String(round)}`, 'c-old', `2026-10-25T0${String(round)}:00:00Z`, true))
    ledger.push(finishedEvent(`TASK-OLD-${String(round)}`, 'c-old', `2026-10-25T0${String(round)}:30:00Z`))
  }
  const pools = poolsOf(ledger, ['developer', 'tester'])
  const admission = admitDispatch({
    ready: [card('TASK-FRESH', 'tester'), card('TASK-REUSE')],
    pools,
    globalRoom: 4,
    reuseIdle: true,
    maskHashOf: () => MASK,
    reuseBlockedOf: () => undefined,
  })
  return { pools, admission, held: 'TASK-REUSE' }
}

/**
 * 渲染期望值**一律现取**（`fmt` / `t`）：中文侧不抄字形 —— 抄一次就把"文案改了、判据没改"
 * 变成一条会静默过期的注释，而内联中文串会额外造一个 `test/m189` 的未登记站点。
 */
function planLineOf(role: string, seats: number): string {
  return fmt('uiDescribe.kPoolAdmissionPlan', {
    p1: role,
    p2: String(seats),
    p3: t('uiDescribe.kPoolAdmissionNotInFlight'),
  })
}

/** `kPoolLine` 的期望字形（参数由夹具给定时可知 —— 这样"既有字形不改"也是现算而不是抄写）。 */
function poolLineOf(role: string, busy: number, cap: number, idle: number, retired: number, stale: number): string {
  return fmt('uiDescribe.kPoolLine', {
    p1: role,
    p2: String(busy),
    p3: String(cap),
    p4: String(idle),
    p5: String(retired),
    p6: String(stale),
  })
}

/* ———————————————————————————— 落点二①：计划面必须说出来，且不冒充在飞 ———————————————————————————— */

test('M271-01 admission seats are printed from reuseAdmissions, and never as in-flight', () => {
  const { admission, held } = heldAdmissionFixture()
  // 前置（否则测不到这一支）：复用位子真的落在计划面，`busy` 里一格都没有它
  const seatRows = admission.reuseAdmissions.map((row) => `${row.task}->${row.childSessionId}`).join(',')
  assert.equal(seatRows, `${held}->c-old`, `the reuse seat must live on the plan face: ${seatRows}`)
  const busyRow = (admission.pools.find((pool) => pool.role === 'developer')?.busy ?? [])
    .map((child) => `${child.task}->${child.childSessionId}`).join(',')
  assert.equal(busyRow, '', `busy must hold folded facts only, got: ${busyRow}`)
  assert.equal(admission.dispatch.length, 2, 'premise: two cards were admitted this round (one fresh, one reuse)')

  const block = describePoolBlock(admission.pools, [], true, 0, { reuseAdmissions: admission.reuseAdmissions })
  const planLine = planLineOf('developer', 1)
  const hasPlanLine = block.includes(planLine)
  assert.equal(hasPlanLine, true, `the pool block must state the admission seat count: ${block}`)
  // 这一行是**计数**，不是定位：被 `limit` 挡下的那张卡连卡号都不许出现
  // （卡号只由 `busy` 的定位行与逐卡复用依据行给 —— `test/m250` 的 M250-13 ② 盯的正是这一点）
  const printsHeldCard = block.includes(held)
  assert.equal(printsHeldCard, false, `the plan line is a count, not an identity: ${block}`)
  // 「不是在飞」这半句必须在（按**键**取值，两语言同判；字面量那一侧见 M271-05）
  const phrase = t('uiDescribe.kPoolAdmissionNotInFlight')
  assert.ok(phrase.length > 0, 'the not-in-flight phrase must carry text in the active locale')
  const saysNotInFlight = block.includes(phrase)
  assert.equal(saysNotInFlight, true, `the plan line must say explicitly it is NOT in flight: ${block}`)
  // 占位符没被替换 = 模板接错
  const leavesPlaceholder = block.includes('{p3}')
  assert.equal(leavesPlaceholder, false, `every placeholder must be substituted: ${block}`)
})

/* ———————————————————————————— 落点二②：反向格 —— 真在飞不许被赶出去 ———————————————————————————— */

test('M271-02 a real started{reused:true} stays in flight (the disambiguation must not evict facts)', () => {
  const events = [startedEvent('TASK-A', 'c-old', '2026-10-25T07:19:00Z', true)]
  const pools = poolsOf(events, ['developer'])
  const dev = pools.find((pool) => pool.role === 'developer')
  const busyRow = (dev?.busy ?? []).map((child) => `${child.task}->${child.childSessionId}`).join(',')
  assert.equal(busyRow, 'TASK-A->c-old', `a real reuse dispatch must fold into busy: ${busyRow}`)

  // 最坏情形：这张卡**同时**还有一条计划面记录（准入那一行确实存在过）—— 两桶都要如实印，互不吞
  const planRows = [{ task: 'TASK-A', childSessionId: 'c-old', role: 'developer' }]
  const block = describePoolBlock(pools, [], true, 0, { reuseAdmissions: planRows })
  // 英文档做字形判据（ASCII 常量 ⇒ 不属于散文棘轮的面），中文档只按键取值
  setLocale('en')
  const enBlock = describePoolBlock(pools, [], true, 0, { reuseAdmissions: planRows })
  const enInFlight = /in flight 1\/3/u.test(enBlock)
  assert.equal(enInFlight, true, `the fact face must still say one session is in flight: ${enBlock}`)
  const enIdentity = enBlock.includes('TASK-A→c-old')
  assert.equal(enIdentity, true, `the in-flight identity line must survive: ${enBlock}`)
  const enPlanLine = enBlock.includes(planLineOf('developer', 1))
  assert.equal(enPlanLine, true, `the plan line must be there too: ${enBlock}`)
  // 不加计划面时，在飞那一路的输出必须**一模一样**（busy 语义一个字节不改）
  const enFactOnly = describePoolBlock(pools, [], true, 0)
  const factOnlyIdentity = enFactOnly.includes('TASK-A→c-old')
  assert.equal(factOnlyIdentity, true, `without the plan face the identity line is still there: ${enFactOnly}`)
  setLocale('zh-CN')
  // 中文档同一件事：计划行与在飞定位行**同时**在场（两条都现取，不抄字形）
  const zhIdentity = block.includes('TASK-A→c-old')
  assert.equal(zhIdentity, true, `identity line must be printed in the base locale as well: ${block}`)
})

/* ———————————————————————————— 落点二③：零准入不许多一行空话 ———————————————————————————— */

test('M271-03 zero admissions leaves the block byte-identical (no filler line)', () => {
  const pools = poolsOf([], ['developer'])
  const without = describePoolBlock(pools, [], true, 0)
  const emptyRows = describePoolBlock(pools, [], true, 0, { reuseAdmissions: [] })
  assert.equal(emptyRows, without, 'passing an empty plan face must change nothing')
  setLocale('en')
  const enEmpty = describePoolBlock(pools, [], true, 0, { reuseAdmissions: [] })
  const enFiller = enEmpty.includes('NOT in flight')
  assert.equal(enFiller, false, `no plan seats must mean no extra wording: ${enEmpty}`)
  setLocale('zh-CN')
  // 同一个池**有**准入时才多一行：行数差恰好 1（不是 0，也不是两行）
  const withSeat = describePoolBlock(pools, [], true, 0, {
    reuseAdmissions: [{ task: 'TASK-X', childSessionId: 'c-old', role: 'developer' }],
  })
  const delta = withSeat.split('\n').length - without.split('\n').length
  assert.equal(delta, 1, `one admission state must add exactly one line, got delta ${String(delta)}`)
})

/* ———————————————————————————— 落点三：只许追加，既有字形一个字节不改 ———————————————————————————— */

test('M271-04 the plan face is appended only: every pre-existing line stays byte-identical', () => {
  // 用一条**有在飞、有未结算超时、有排队**的池（既有四类行都在场），两语言各跑一遍
  const pools = poolsOf(
    [
      startedEvent('TASK-A', 'c-old', '2026-10-25T07:19:00Z', true),
      startedEvent('TASK-Z', 'c-dead', '2020-01-01T00:00:00Z', false),
    ],
    ['developer', 'tester'],
  )
  const planRows = [
    { task: 'TASK-B', childSessionId: 'c-idle-1', role: 'developer' },
    { task: 'TASK-C', childSessionId: 'c-idle-2', role: 'tester' },
  ]
  for (const locale of ['zh-CN', 'en']) {
    setLocale(locale)
    const queued = ['TASK-Q']
    const base = describePoolBlock(pools, queued, true, 60)
    const withPlan = describePoolBlock(pools, queued, true, 60, { reuseAdmissions: planRows })
    const baseRows = base.split('\n')
    const extra = withPlan.split('\n').filter((row) => !baseRows.includes(row))
    const expectedExtra = [planLineOf('developer', 1), planLineOf('tester', 1)]
    assert.deepEqual(extra, expectedExtra, `[${locale}] only the plan lines may be new: ${withPlan}`)
    const dropped = baseRows.filter((row) => !withPlan.split('\n').includes(row))
    assert.deepEqual(dropped, [], `[${locale}] no pre-existing line may be rewritten or dropped`)
    // 既有字形还在（参数从**池对象现取**，不抄写 —— 抄一份数字就等于把判据钉在夹具的偶然上）
    const devPool = pools.find((pool) => pool.role === 'developer')
    assert.ok(devPool !== undefined, `[${locale}] premise: the developer pool must be present`)
    const factLine = poolLineOf('developer', devPool.busy.length, devPool.cap, devPool.idle.length, devPool.retired, devPool.stale.length)
    const keepsFactLine = withPlan.split('\n').includes(factLine)
    assert.equal(keepsFactLine, true, `[${locale}] the in-flight pool line must stay byte-identical: ${withPlan}`)
    const keepsIdentity = withPlan.includes('TASK-A→c-old')
    assert.equal(keepsIdentity, true, `[${locale}] the in-flight identity line must stay byte-identical`)
  }
  // 英文侧把「不是在飞」这句话**按字面量**钉住（ASCII 常量，非散文站点）：
  // 只靠按键取值等于让实现与用例共变 —— 把整句删掉也照样绿。
  setLocale('en')
  const enBlock = describePoolBlock(pools, ['TASK-Q'], true, 60, { reuseAdmissions: planRows })
  const enClaim = /NOT in flight/u.test(enBlock)
  assert.equal(enClaim, true, `the English wording must literally claim it is not in flight: ${enBlock}`)
  setLocale('zh-CN')
})

/* ———————————————————————————— 接线：真装配链上必须真的交进这份计划 ———————————————————————————— */

/** 一个「派过、结算了、观测到手里有工具」的孩子（复用要**正面证据**，`R-1`）。 */
function seedIdleChild(office: SoftwareDevOffice, childSessionId: string, taskId: string): void {
  office.recordDispatchStarted(CALL, {
    taskId,
    provider: 'spawn',
    childSessionId,
    parentSessionId: SESSION,
    tools: 3,
    role: 'developer',
    mode: 'continuable',
    maskHash: maskFingerprint('developer'),
  })
  office.journalFor(WORKSPACE).append('dispatch/finished', { task: taskId, childSessionId })
  office.noteChildFace(CALL, { childSessionId, tools: ['bash', 'edit', 'read'], violations: [], calls: [], callCount: 0 })
}

const delivered: string[] = []

/** 宿主桩：`sendMessage` 是**复用**的投递原语，`start`/`startContinuable` 是新起的两条路。 */
function mount(): { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[] {
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
    start: async () => ({ id: 'child-oneshot-m271' }),
    startContinuable: async () => ({ childId: 'child-fresh-m271' }),
    sendMessage: async (_sender: unknown, targetId: string) => {
      delivered.push(targetId)
      return { messageId: 'msg-m271' }
    },
    getProvider: () => ({ capabilities: { toolFilter: true } }),
    listDescendants: async () => [],
  }
  apply(makeCtx() as unknown as Context, Config({ poolCaps: { developer: 3, tester: 3 } } as unknown as SdoConfig))
  return tools
}

async function callTool(
  tools: { name: string; parameters: unknown; execute: (args: unknown, ctx: { agent?: unknown }) => unknown }[],
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `tool face is missing ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: SESSION, session: { header: { id: SESSION, cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub }))
}

test('M271-05 the real assembly chain passes plan.reuseAdmissions into the receipt pool block', async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession(SESSION, WORKSPACE)
  office.init(CALL, { name: 'M271 准入与在飞分开印', scale: 'normal', stakeholders: ['业务方'] })
  office.journalFor(WORKSPACE).append('phase/entered', { phase: 'construction' })
  seedIdleChild(office, 'c-old', 'TASK-OLD')
  // 卡 id 必须是 `TASK-<数字>`：`listTaskIds` 只认这个形态的文件名（`domain/plan.ts` 的既有口径），
  // 写成 `TASK-FRESH` 会让 `listTasks()` 全空 —— 那会变成"这一格测的是空池"的假绿。
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-27101.yml'], { task: card('TASK-27101', 'tester') })
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-27102.yml'], { task: card('TASK-27102') })

  // 前置：`c-old` 在池视图里真的是**空闲可复用**候选（否则准入压根走不到复用支，
  // 这一格测的就不是本卡的形状 —— 绿得没意义）
  const devView = office.poolView(CALL).find((pool) => pool.role === 'developer')
  const candidateIds = (devView?.idle ?? []).map((child) => child.childSessionId).join(',')
  assert.equal(candidateIds, 'c-old', `premise: the idle child must be offered for reuse, got: ${candidateIds}`)

  const tools = mount()
  // `limit=1`：准入处理两张、只派一张 —— 另一张**准入通过却没派**（真机 `DEF-229` 那一态）
  const receipt = await callTool(tools, 'sdo_plan', { action: 'next', backend: 'subagent', limit: 1 })

  // ① 接线：回执里必须出现计划那一行（渲染器本身在 M271-01 已经验过 ⇒ 这一条只验"真的交进去了"）
  const planLine = planLineOf('developer', 1)
  const wired = receipt.includes(planLine)
  assert.equal(wired, true, `the receipt must carry the plan face from plan.reuseAdmissions: ${receipt.slice(-1200)}`)
  // ② 回执的被挡下那半张卡**不得**以「卡号→子会话」的**在飞定位**形态出现（那是事实面的字形）
  const startedIds = office.journalFor(WORKSPACE).read().events
    .filter((event) => event.type === 'dispatch/started')
    .map((event) => String(event.data['task'] ?? ''))
  const dispatchedIds = startedIds.filter((id) => id === 'TASK-27101' || id === 'TASK-27102')
  assert.equal(dispatchedIds.length, 1, `limit=1 must really dispatch exactly one of the two cards: ${JSON.stringify(dispatchedIds)}`)
  const heldId = dispatchedIds[0] === 'TASK-27102' ? 'TASK-27101' : 'TASK-27102'
  const heldPrintedAsInFlight = receipt.includes(`${heldId}→`)
  assert.equal(heldPrintedAsInFlight, false, `a card with zero started events must not get an in-flight identity: ${receipt.slice(-1200)}`)
})
