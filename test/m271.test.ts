/**
 * **`TASK-271`：角色池段把「本次准入」与「在飞」分开印**（从 `TASK-245` DoD 第 2 条移出）。
 *
 * 立案形状（`DEF-229` 的**显示面**那一半）：`TASK-245` 已经把「计划 vs 事实」在**数据面**拆开了 ——
 * 准入的复用位子只进 `PoolAdmission.reuseAdmissions`，`pool.busy` 只放由 `dispatch/started` 折叠出来的
 * 事实。但**显示面**没跟上：池段只印事实，于是「准入通过、被 `limit` 挡下」的那一态会出现
 * 「在飞 0/3、空闲可复用 0」—— 三行读数都在，**没有一行说这一轮的位子已经许出去了**。
 *
 * 本文件守六件事：
 *   · `M271-01` **守卫①**：账态「准入 2 张、其中 1 张复用被 `limit` 挡下」⇒ 池段必须出现
 *     「已先准入 1 张（复用）」这一行（读 `reuseAdmissions`），且**不得**把那张卡印成在飞
 *     （池段里连卡号都不出现 —— 这一行是计数，定位仍只由 `busy` 那一路给）；
 *   · `M271-02` **守卫②（反向格）**：真的 `started{reused:true}` ⇒ 它**必须**还在在飞里，且
 *     **计划行必须不出现**（`REV-123#3`：对真在飞的位子说「不是在飞」是与 `DEF-229` 同族的假话）；
 *     同格再证**两态印出的东西不同**（旧实现两态印同一行 ⇒ 对这两种状态零区分力）；
 *   · `M271-03` **守卫③**：零准入 ⇒ 传空计划面与不传**输出相同**（不许多出一行空话）；
 *   · `M271-04` **版面**：加了计划面之后，除新增的那几行以外**没有任何既有行被改写或删除**。
 *     ⚠️ 这一格证的是**代码路径**的追加性（`REV-123#5`）：既有的硬字形锚不在本文件里 ——
 *     `kPoolLine` 的中文取值自带前导全角空格，抽取器会把它 `trim()` 掉 ⇒ 那种「整串等于语言包取值」
 *     的 label 豁免对它不成立，钉它就会造出未登记的散文站点。硬字形锚仍在 `test/m36.test.ts`；
 *   · `M271-05` **接线**：上面四格都直接调渲染器，**证明不了** `src/index.ts` 真的把
 *     `plan.reuseAdmissions` 交进去了 ⇒ 这一格走真装配链（`sdo_plan action=next`）：回执里必须出现
 *     那一行，且被 `limit` 挡下的卡不得以「卡号→子会话」的在飞定位形态出现；
 *   · `M271-06` **状态面不印计划行**（`REV-123#6`）：`sdo_status` 的 `poolPlan` 是**读数探针**，
 *     这次调用没有派发任何东西 ⇒ 回执里**不许**出现计划行。这条边界以前只有注释，没有守卫。
 *
 * ⚠️ **本文件的写作纪律（两条，都是被评审教过的）**：
 *   ① 断言行**一律英文消息**，中文只出现在两处**字面量锚**里；
 *   ② 中文侧的判据**不再从同一个键现取**（旧版 `t(key)` ⇒ 期望值与渲染同源 ⇒ 文案被反写也全绿，
 *      `REV-123#1`）。现在写成**整串等于语言包取值**的字面量：`test/proseInventory.ts` 的
 *      `classifySite` 对这种串判 `label`（不是 `prose`），而 `KNOWN_PROSE_GAP` 只统计 `prose`
 *      站点 ⇒ `test/m189` 的 `M189-08` 不变红（`REV-123#2`）。写**子串**才会造出未登记站点。
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
import { fmt, locale, setLocale, t } from '../src/domain/i18n.js'
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

/**
 * **中文侧的整串字面量锚**（`REV-123#1/#4`）：逐字等于 `src/data/lang/zh-CN.yml` 里那条取值。
 *
 * 为什么必须整串：抽取器把「含读文本调用 + 内联中文」记成站点，`classifySite` 只对**逐字等于语言包取值**
 * 的串判 `label`（免登记），子串一律判 `prose`（要登记进 `KNOWN_PROSE_GAP`，而那张表不在本卡写范围）。
 */
const ZH_PLAN_TEMPLATE = '准入计划（{p1}）：已先准入 {p2} 张（复用）—— {p3}：这些位子还没落到台账（真派发还要有一笔 dispatch/started）；「在飞」只数那个'
const ZH_NOT_IN_FLIGHT = '**不是在飞**'
/** 英文侧同两件（ASCII 之外只为可读；英文串本来就不进散文站点）。 */
const EN_PLAN_TEMPLATE = 'admission plan ({p1}): {p2} seat(s) admitted this round (reuse) — {p3}: these seats have not reached the ledger yet (a real dispatch needs a dispatch/started); "in flight" counts only those'
const EN_NOT_IN_FLIGHT = '**NOT in flight**'

type Locale = 'zh-CN' | 'en'

function pinsOf(which: Locale): { template: string; phrase: string } {
  return which === 'zh-CN'
    ? { template: ZH_PLAN_TEMPLATE, phrase: ZH_NOT_IN_FLIGHT }
    : { template: EN_PLAN_TEMPLATE, phrase: EN_NOT_IN_FLIGHT }
}

/** 计划行的**期望整行**：由上面的字面量锚拼出（**不是**从同一个键现取 —— 否则文案被反写也全绿）。 */
function planLineOf(which: Locale, role: string, seats: number): string {
  const { template, phrase } = pinsOf(which)
  const body = template.replace('{p1}', role).replace('{p2}', String(seats)).replace('{p3}', phrase)
  return `　${body}`
}

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

/** `kPoolLine` 的期望字形（参数由池对象现给 —— 这一格证的是**代码路径**，见文件头的 `REV-123#5`）。 */
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

/* ———————————————————————————— 守卫①：计划面必须说出来，且不冒充在飞 ———————————————————————————— */

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
  // ① 计划行按**整串字面量锚**核对（文案被反写 ⇒ 这里红）
  const planLine = planLineOf('zh-CN', 'developer', 1)
  const hasPlanLine = block.includes(planLine)
  assert.equal(hasPlanLine, true, `the pool block must state the admission seat count: ${block}`)
  // ② 这一行是**计数**，不是定位：被 `limit` 挡下的那张卡连卡号都不许出现
  // （卡号只由 `busy` 的定位行与逐卡复用依据行给 —— `test/m250` 的 M250-13 ② 盯的正是这一点）
  const printsHeldCard = block.includes(held)
  assert.equal(printsHeldCard, false, `the plan line is a count, not an identity: ${block}`)
  // ③ 模板与那句话**各按整串**核对（`REV-123#1/#4`：这两条是中文侧唯一的字面量锚）
  // ⚠️ 这两条的字面量必须**内联在断言行上**（不能只引用本文件的 const）：`test/m189` 的 M189-13 钉着
  // 「哪 6 个站点允许『行内没有该中文但被登记』」—— 引用 const 会新增这种站点，直接顶红那张固定名单。
  assert.equal(t('uiDescribe.kPoolAdmissionPlan'), '准入计划（{p1}）：已先准入 {p2} 张（复用）—— {p3}：这些位子还没落到台账（真派发还要有一笔 dispatch/started）；「在飞」只数那个', 'the zh plan template must stay this exact sentence')
  assert.equal(t('uiDescribe.kPoolAdmissionNotInFlight'), '**不是在飞**', 'the zh "not in flight" phrase must stay this exact phrase')
  // ④ 占位符没被替换 = 模板接错
  const leavesPlaceholder = block.includes('{p3}')
  assert.equal(leavesPlaceholder, false, `every placeholder must be substituted: ${block}`)
})

/* ———————————————————————————— 守卫②：反向格 —— 真在飞不许被说成「不是在飞」 ———————————————————————————— */

test('M271-02 a real started{reused:true} stays in flight, and no plan line may claim otherwise', () => {
  const events = [startedEvent('TASK-A', 'c-old', '2026-10-25T07:19:00Z', true)]
  const pools = poolsOf(events, ['developer'])
  const dev = pools.find((pool) => pool.role === 'developer')
  const busyRow = (dev?.busy ?? []).map((child) => `${child.task}->${child.childSessionId}`).join(',')
  assert.equal(busyRow, 'TASK-A->c-old', `a real reuse dispatch must fold into busy: ${busyRow}`)

  // 最坏情形：这张卡**同时**还有一条计划面记录（准入那一行确实存在过）——
  // 但它的孩子此刻已经在 `busy` 里 ⇒ 这个位子**就在飞**，计划行必须**不出现**
  const planRows = [{ task: 'TASK-A', childSessionId: 'c-old', role: 'developer' }]
  const zhBlock = describePoolBlock(pools, [], true, 0, { reuseAdmissions: planRows })
  const zhClaim = zhBlock.includes('**不是在飞**')
  assert.equal(zhClaim, false, `a seat that IS in flight must not be called "not in flight": ${zhBlock}`)
  // 在飞那两行必须逐字还在（别为了消歧义把事实面赶出去）
  const zhIdentity = zhBlock.includes('TASK-A→c-old')
  assert.equal(zhIdentity, true, `the in-flight identity line must survive: ${zhBlock}`)
  // 不加计划面时输出必须**逐字节相同**（busy 语义一个字节不改）
  assert.equal(zhBlock, describePoolBlock(pools, [], true, 0), 'without the plan face the block must be byte-identical')

  // 英文档做字形判据（ASCII 常量 ⇒ 不是散文站点）
  setLocale('en')
  const enBlock = describePoolBlock(pools, [], true, 0, { reuseAdmissions: planRows })
  const enInFlight = /in flight 1\/3/u.test(enBlock)
  assert.equal(enInFlight, true, `the fact face must still say one session is in flight: ${enBlock}`)
  const enClaim = enBlock.includes(EN_NOT_IN_FLIGHT)
  assert.equal(enClaim, false, `no "NOT in flight" claim may be printed for an in-flight seat: ${enBlock}`)
  setLocale('zh-CN')

  // **区分力**（`REV-123#3`）：被 `limit` 挡下那一态与真派出去那一态，池段印出的东西**必须不同**。
  // 旧实现两态印同一行（`p2` 都是 1）⇒ 这一行对两态零区分力，等于没测。
  const { admission } = heldAdmissionFixture()
  const heldBlock = describePoolBlock(admission.pools, [], true, 0, { reuseAdmissions: admission.reuseAdmissions })
  assert.notEqual(heldBlock, zhBlock, 'the two states must not print the same block (that would be zero discrimination)')
  const heldPlanRow = planLineOf('zh-CN', 'developer', 1)
  const heldLines = heldBlock.split('\n').filter((row) => row === heldPlanRow)
  const realLines = zhBlock.split('\n').filter((row) => row === heldPlanRow)
  assert.equal(heldLines.length, 1, `the held state prints exactly one plan line: ${heldBlock}`)
  assert.equal(realLines.length, 0, `the real-dispatch state prints none: ${zhBlock}`)
})

/* ———————————————————————————— 守卫③：零准入不许多一行空话 ———————————————————————————— */

test('M271-03 zero admissions adds nothing (an empty plan face changes no output)', () => {
  const pools = poolsOf([], ['developer'])
  const without = describePoolBlock(pools, [], true, 0)
  const emptyRows = describePoolBlock(pools, [], true, 0, { reuseAdmissions: [] })
  assert.equal(emptyRows, without, 'passing an empty plan face must not change the output')
  setLocale('en')
  const enEmpty = describePoolBlock(pools, [], true, 0, { reuseAdmissions: [] })
  const enFiller = enEmpty.includes(EN_NOT_IN_FLIGHT)
  assert.equal(enFiller, false, `no plan seats must mean no extra wording: ${enEmpty}`)
  setLocale('zh-CN')
  // 同一个池**有**准入时才多一行：行数差恰好 1（不是 0，也不是两行）
  const withSeat = describePoolBlock(pools, [], true, 0, {
    reuseAdmissions: [{ task: 'TASK-X', childSessionId: 'c-old', role: 'developer' }],
  })
  const delta = withSeat.split('\n').length - without.split('\n').length
  assert.equal(delta, 1, `one admission state must add exactly one line, got delta ${String(delta)}`)
})

/* ———————————————————————————— 版面：只许追加，既有行一行不少 ———————————————————————————— */

test('M271-04 the plan face only adds lines: no pre-existing line is rewritten or dropped', () => {
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
  for (const which of ['zh-CN', 'en'] as const) {
    setLocale(which)
    const queued = ['TASK-Q']
    const base = describePoolBlock(pools, queued, true, 60)
    const withPlan = describePoolBlock(pools, queued, true, 60, { reuseAdmissions: planRows })
    const baseRows = base.split('\n')
    const extra = withPlan.split('\n').filter((row) => !baseRows.includes(row))
    const expectedExtra = [planLineOf(which, 'developer', 1), planLineOf(which, 'tester', 1)]
    assert.deepEqual(extra, expectedExtra, `[${which}] only the plan lines may be new: ${withPlan}`)
    const dropped = baseRows.filter((row) => !withPlan.split('\n').includes(row))
    assert.deepEqual(dropped, [], `[${which}] no pre-existing line may be rewritten or dropped`)
    // 既有池行仍在（参数从池对象现取；**硬**字形锚在 `test/m36.test.ts`，见文件头的 `REV-123#5`）
    const devPool = pools.find((pool) => pool.role === 'developer')
    assert.ok(devPool !== undefined, `[${which}] premise: the developer pool must be present`)
    const factLine = poolLineOf('developer', devPool.busy.length, devPool.cap, devPool.idle.length, devPool.retired, devPool.stale.length)
    const keepsFactLine = withPlan.split('\n').includes(factLine)
    assert.equal(keepsFactLine, true, `[${which}] the in-flight pool line must stay: ${withPlan}`)
    const keepsIdentity = withPlan.includes('TASK-A→c-old')
    assert.equal(keepsIdentity, true, `[${which}] the in-flight identity line must stay byte-identical`)
    // 计划行落在**本角色池行之后**（`REV-123#8`：不许排在全部池行之后，也不许与池行同形开头）
    const rows = withPlan.split('\n')
    const factAt = rows.indexOf(factLine)
    const planAt = rows.indexOf(planLineOf(which, 'developer', 1))
    assert.ok(factAt >= 0 && planAt === factAt + 1, `[${which}] the plan line must follow its own pool line: ${withPlan}`)
  }
  // 英文侧把「不是在飞」这句话**按字面量**钉住（ASCII 常量，非散文站点）
  setLocale('en')
  const enBlock = describePoolBlock(pools, ['TASK-Q'], true, 60, { reuseAdmissions: planRows })
  const enClaim = enBlock.includes(EN_NOT_IN_FLIGHT)
  assert.equal(enClaim, true, `the English phrase must literally be there: ${enBlock}`)
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
  office.journalFor(WORKSPACE).append('dispatch/finished', { taskId, childSessionId })
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

/**
 * 真装配链的公共夹具：一个已结算、已观测到有工具的空闲孩子 + 两张候选卡（1 tester 新起 / 1 developer 复用）。
 *
 * 卡 id 必须是 `TASK-<数字>`：`listTaskIds` 只认这个形态的文件名（`domain/plan.ts` 的既有口径），
 * 写成 `TASK-FRESH` 会让 `listTasks()` 全空 —— 那会变成「这一格测的是空池」的假绿。
 */
function mountAssembly(): {
  office: SoftwareDevOffice
  tools: ReturnType<typeof mount>
} {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession(SESSION, WORKSPACE)
  office.init(CALL, { name: 'M271 准入与在飞分开印', scale: 'normal', stakeholders: ['业务方'] })
  office.journalFor(WORKSPACE).append('phase/entered', { phase: 'construction' })
  seedIdleChild(office, 'c-old', 'TASK-OLD')
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-27101.yml'], { task: card('TASK-27101', 'tester') })
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-27102.yml'], { task: card('TASK-27102') })
  return { office, tools: mount() }
}

test('M271-05 the real assembly chain passes plan.reuseAdmissions into the receipt pool block', async () => {
  const { office, tools } = mountAssembly()
  // 前置：`c-old` 在池视图里真的是**空闲可复用**候选（否则准入压根走不到复用支，
  // 这一格测的就不是本卡的形状 —— 绿得没意义）
  const devView = office.poolView(CALL).find((pool) => pool.role === 'developer')
  const candidateIds = (devView?.idle ?? []).map((child) => child.childSessionId).join(',')
  assert.equal(candidateIds, 'c-old', `premise: the idle child must be offered for reuse, got: ${candidateIds}`)

  // `limit=1`：准入处理两张、只派一张 —— 另一张**准入通过却没派**（真机 `DEF-229` 那一态）
  const receipt = await callTool(tools, 'sdo_plan', { action: 'next', backend: 'subagent', limit: 1 })
  // ① 接线：回执里必须出现计划那一行（渲染器本身在 M271-01 已经验过 ⇒ 这一条只验"真的交进去了"）
  const planLine = planLineOf('zh-CN', 'developer', 1)
  const wired = receipt.includes(planLine)
  assert.equal(wired, true, `the receipt must carry the plan face from plan.reuseAdmissions: ${receipt.slice(-1200)}`)
  // ② 回执里被挡下的那半张卡**不得**以「卡号→子会话」的**在飞定位**形态出现（那是事实面的字形）
  const startedIds = office.journalFor(WORKSPACE).read().events
    .filter((event) => event.type === 'dispatch/started')
    .map((event) => String(event.data['task'] ?? ''))
  const dispatchedIds = startedIds.filter((id) => id === 'TASK-27101' || id === 'TASK-27102')
  assert.equal(dispatchedIds.length, 1, `limit=1 must really dispatch exactly one of the two cards: ${JSON.stringify(dispatchedIds)}`)
  const heldId = dispatchedIds[0] === 'TASK-27102' ? 'TASK-27101' : 'TASK-27102'
  const heldPrintedAsInFlight = receipt.includes(`${heldId}→`)
  assert.equal(heldPrintedAsInFlight, false, `a card with zero started events must not get an in-flight identity: ${receipt.slice(-1200)}`)
})

/* ———————————————————————————— 状态面：探针不是派发决定，不许印计划行 ———————————————————————————— */

test('M271-06 sdo_status must not print the admission plan line (its poolPlan is a read probe)', async () => {
  const { office, tools } = mountAssembly()
  // 前置：这一份账态**有能力**印出计划行 —— 探针跑出来的准入里确实有一个复用位子。
  // 没有这条前提，这一格会因为"本来就没事"而恒绿（`REV-123#6` 要的正是"有人顺手传进去就会红"）。
  const plan = office.poolPlan(CALL, { reuseIdle: true })
  const seats = plan.reuseAdmissions.map((row) => `${row.task}->${row.childSessionId}`).join(',')
  assert.equal(seats, 'TASK-27102->c-old', `premise: the probe admission really has a reuse seat, got: ${seats}`)
  const probePending = plan.reuseAdmissions.filter((row) => (plan.pools.find((pool) => pool.role === row.role)?.busy ?? [])
    .every((child) => child.childSessionId !== row.childSessionId)).length
  assert.equal(probePending, 1, 'premise: that seat is not in flight, so the renderer WOULD print it if handed over')

  const status = await callTool(tools, 'sdo_status', {})
  const planLine = planLineOf('zh-CN', 'developer', 1)
  const printsPlanLine = status.includes(planLine)
  assert.equal(printsPlanLine, false, `sdo_status is a read probe, it must not claim an admission: ${status.slice(-1200)}`)
  const printsClaim = status.includes('**不是在飞**')
  assert.equal(printsClaim, false, `sdo_status must not carry the "not in flight" claim either: ${status.slice(-1200)}`)
  // 同一份回执里池段本身必须还在（否则"没有计划行"可能只是因为没有池段 —— 假绿）
  const hasPoolHeader = status.includes(t('uiDescribe.kPoolHeader'))
  assert.equal(hasPoolHeader, true, 'premise: the status receipt must really carry the pool block')
  assert.equal(locale(), 'zh-CN', 'the locale must be the base one for these literal anchors')
})
