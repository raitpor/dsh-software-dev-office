/**
 * **增量 244（`TASK-231` / `DEF-214`）：`dispatch/decided` 的收口，与「在飞 / 容量」的唯一口径。**
 *
 * 病灶（`DEF-214` 的三层危害）：
 *   ① **决定与收口脱钩**：派发路径修前**先**落 `dispatch/decided`、**再**尝试起会话；
 *      「起会话」失败（宿主没服务 / provider 不在 / `start` 抛错）时**没有任何收口事件** ⇒
 *      台账里留下一条「决议了但没发生」的中间态，与「正在派发」长得一模一样；
 *   ② **读数口径**：回执的「在飞」与容量若各自推导一遍，就会出现「回执说在飞、卡却是 planned、
 *      `owner` 空」（`DEF-214` 的真机形状）；
 *   ③ **没有守卫**：那个中间态**任何判据都发现不了** —— 只能靠人顺手 grep。
 *
 * 本文件守的是**修完之后的稳定事实**（不是把缺陷形状断言成期望值）：
 *   · `M244-01`（判据① / 落点二）造一个「只 decided 不 started」的账态 ⇒ 回执**不再**把它印成在飞、
 *     容量**不占位**，而守卫**判红并点名**卡与决定锚点；
 *   · `M244-02`（判据② / 落点二）真派一张卡 ⇒ 在飞定位与占位读数**都对**（占位 +1、`live` 点名它）；
 *   · `M244-03`（判据③ / 落点三）`TASK-221` / `TASK-224` 那种历史悬空决定**一次体检就列出来**，
 *     且**两态**：没有悬空时 `ok === true`（判据不会为了"看起来有用"而恒红）；
 *   · `M244-04`（反例格）真有 in-flight 的卡（`decided` + `started`）**不得**被算成悬空；
 *   · `M244-05`（落点一）起会话失败 ⇒ 同一笔 `dispatch/decided` 上带 `outcome: failed` + 原因；
 *     降级 `inline` ⇒ 带 `outcome: inline`；**生产路径不再产生悬空决定**；
 *   · `M244-06`（落点二）占位 = `in-progress` ∪ 真在飞（去重），悬空决定**一个位子都不占**。
 *
 * 与 `m128` 的分工：`m128` 守的是**池视图的分栏**（本会话可复用 / 跨父会话）；本文件守的是
 * 「谁算在飞」这件事在**回执、容量、守卫**三处的**同源性**。
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
import { seatLine, seatNeedsLine, seatReading } from '../src/integration/orchestrator.js'
import {
  DANGLING_LINES_SHOWN,
  DECIDED_SETTLE_SECONDS,
  danglingDecisionLine,
  danglingDecisionLines,
  danglingDecisions,
  dispatchDecisionRows,
  liveDispatchReading,
} from '../src/domain/pool.js'
import type { DispatchDecisionRow, DispatchLedgerEvent } from '../src/domain/pool.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm244')
const WORKSPACE = join(BASE, 'proj')
const SESSION = 'session-0000m244-0000-4000-8000-00000000244a'

let office: SoftwareDevOffice
const call = { sessionId: SESSION, cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string, over: Partial<TaskCard> = {}): TaskCard {
  return {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/m244/${id}.ts`], role: 'developer', size: 'small', revision: 1,
    status: 'planned', requirements: [], evidence: [], createdAt: '', updatedAt: '',
    ...over,
  } as unknown as TaskCard
}

function writeCard(item: TaskCard): void {
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${item.id}.yml`], { task: item })
}

/**
 * 把一笔「派发决定」**原样写进台账**（绕过收口入口）。
 *
 * 为什么必须能绕过：`Journal.append()` 只给"现在"的时间戳，而要造的正是
 * 「**几小时前**决定、至今没有收口」—— 那正是 `DEF-214` 里 `TASK-221` / `TASK-224` 的形状。
 * 这也是**老台账唯一的形状**（`outcome` 字段是 `TASK-231` 才有的）。
 */
function seedDecision(taskId: string, at: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const store = office.storeFor(WORKSPACE)
  const text = store.readText('journal.jsonl') ?? ''
  const seq = text.split('\n').filter((line) => line !== '').length + 1
  const data = {
    task: taskId, backend: 'subagent', owner: 'developer', degradedReason: '', overrideNote: '',
    orderBasis: 'sizeRank->lastDispatched->id', candidates: [], selectedWhy: 'seed', ...extra,
  }
  store.appendLine(['journal.jsonl'], JSON.stringify({ seq, at, actor: 'sdo', type: 'dispatch/decided', data }))
  return { seq, data }
}

const isoAgo = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString()

/** 宿主桩：`start` / `startContinuable` 直接给一个子会话 id（真派发），或抛错（起会话失败）。 */
function mount(mode: 'ok' | 'start-throws' | 'throws-list' = 'ok'): {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}[] {
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
  const boom = async (): Promise<never> => { throw new Error('宿主拒绝：无法创建子代理（夹具）') }
  const subagents: Record<string, unknown> = {
    start: mode === 'start-throws' ? boom : async () => ({ id: 'm244-child-0000-4000-8000-00000000aa01' }),
    startContinuable: mode === 'start-throws' ? boom : async () => ({ childId: 'm244-fresh-0000-4000-8000-00000000aa02' }),
    sendMessage: mode === 'start-throws' ? boom : async () => ({ messageId: 'm244-msg' }),
    getProvider: () => ({ capabilities: { toolFilter: true } }),
    listDescendants: async () => [],
  }
  /**
   * `throws-list`：让 `runtime.list` 的**属性访问本身**抛错 —— 这是适配层里唯一没有 try/catch 包住的
   * 一段（`typeof runtime.list === 'function'` 会先触发 getter），异常会直接逃出 `startDispatch`
   * （`REV-104` #1）。必须用 `defineProperty`：写进对象字面量会在**造桩那一刻**就抛（spread 会求值）。
   */
  if (mode === 'throws-list') {
    Object.defineProperty(subagents, 'list', { get(): () => string[] { throw new Error('boom: list getter exploded') }, configurable: true })
  } else {
    subagents['list'] = () => ['spawn']
  }
  services['subagents'] = subagents
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

const linesWith = (text: string, needle: string): string[] =>
  text.split('\n').filter((line) => line.includes(needle))

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession(SESSION, WORKSPACE)
  office.init(call, { name: 'M244 派发决定的收口', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/* ————————————————————— 判据① / 落点二：幽灵决定不进在飞、不占位 ————————————————————— */

test('M244-01 (criterion 1) a decided-without-started card is neither in-flight nor occupying a seat, and the guard names it', async () => {
  writeCard(card('TASK-931'))
  const seeded = seedDecision('TASK-931', isoAgo(900))
  writeCard(card('TASK-932', { status: 'ready' }))

  // ① 池读数（唯一出口）：只 decided ⇒ **不在**真在飞集合里
  const live = office.liveDispatch(call)
  assert.deepEqual(live.taskIds, [], `只有 decided 的卡不许算在飞：${JSON.stringify(live.taskIds)}`)

  // ② 回执：不印成在飞、容量也不被它占掉（真卡照样派得出去）
  const receipt = await callTool(mount('ok'), 'sdo_plan', { action: 'next', limit: 1 })
  assert.deepEqual(linesWith(receipt, '在飞定位'), [], `幽灵决定不许出现在「在飞定位」里：${receipt}`)
  assert.equal(receipt.includes('TASK-932'), true, '真卡必须照常被派出去（说明容量没被幽灵占掉）')
  const seats = linesWith(receipt, 'dispatch-seats:')
  assert.equal(seats.length, 1, `占位读数必须每轮可见（且只有一行）：${receipt}`)
  assert.match(seats[0] ?? '', /occupied=0\/4/u, `幽灵决定一个位子都不许占：${seats[0] ?? ''}`)
  assert.match(seats[0] ?? '', /dangling=TASK-931/u, `占位读数要点名悬空的卡：${seats[0] ?? ''}`)

  // ③ 守卫：判红 + 点名卡 **与**决定锚点（序号）/ 声明面 / 年龄
  const dangling = linesWith(receipt, 'dangling-decided:')
  assert.equal(dangling.length, 1, `悬空决定必须判红并点名：${receipt}`)
  assert.match(dangling[0] ?? '', /task=TASK-931/u, '要点名卡')
  assert.match(dangling[0] ?? '', new RegExp(`decidedSeq=${String(seeded.seq)}`, 'u'), '要点名决定锚点（可复算序号）')
  assert.match(dangling[0] ?? '', /owner=developer/u, '要点名声明的角色面')
  assert.match(dangling[0] ?? '', /closure=pending/u, '要点名"没有收口"这件事本身')

  const health = office.dispatchDecisionHealth(call)
  assert.equal(health.ok, false, '有悬空决定 ⇒ 体检判红')
  assert.deepEqual(health.pending.map((row) => row.taskId), ['TASK-931'])
})

/* ————————————————————— 判据②：真派发 ⇒ 在飞与占位都对 ————————————————————— */

test('M244-02 (criterion 2) a real dispatch lands in the in-flight line and in exactly one seat', async () => {
  writeCard(card('TASK-921', { status: 'ready' }))
  const tools = mount('ok')
  const dispatch = await callTool(tools, 'sdo_plan', { action: 'next', limit: 1 })
  assert.equal(linesWith(dispatch, '已真正派发').length, 1, `夹具前提：这一轮要真派出一张卡：${dispatch}`)

  const started = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'dispatch/started')
  assert.equal(started.length, 1, '夹具前提：台账里要有一笔 dispatch/started')
  const childSessionId = String(started[0]?.data['childSessionId'] ?? '')
  assert.notEqual(childSessionId, '')

  /**
   * ① **占位行进回执预算**（`TASK-231` 返工 / `TASK-218` 的口径）：这一轮既没有"卡没认领但子会话在跑"
   * 的真在飞、也没有悬空决定 ⇒ 占位与卡状态计数**一致**，读者照着卡表就能算出来 ⇒ **不占字符**。
   * 两态都断言：该静的必须静（否则吃掉 `M232-06` 只剩两百来字符的余量），该说的必须说（下面②）。
   */
  const seatsBefore = linesWith(dispatch, 'dispatch-seats:')
  assert.deepEqual(seatsBefore, [], `占位与卡表一致时不许占回执字符：${seatsBefore.join(' | ')}`)

  // ② 下一份状态读数里：占位 +1 且 `live` 点名它；它出现在「在飞定位」（`卡→子会话前 8 位`）
  const status = await callTool(tools, 'sdo_status', {})
  const seats = linesWith(status, 'dispatch-seats:')
  assert.equal(seats.length, 1, `状态面也要印占位读数：${status}`)
  assert.match(seats[0] ?? '', /occupied=1\/4/u, `真派发必须占一个位子：${seats[0] ?? ''}`)
  assert.match(seats[0] ?? '', /live=TASK-921\b/u, `真派发必须计入真在飞：${seats[0] ?? ''}`)
  const statusInflight = linesWith(status, '在飞定位')
  assert.equal(statusInflight.length, 1, `真在飞的卡必须出现在「在飞定位」里：${status}`)
  assert.match(statusInflight[0] ?? '', new RegExp(`TASK-921→${childSessionId.slice(0, 8)}`, 'u'), `要点名卡与子会话前 8 位：${statusInflight[0] ?? ''}`)

  // ③ 有真在飞、且它已经收口（`decided` + `started`）⇒ 守卫**不许**把它算成悬空
  assert.deepEqual(office.dispatchDecisionHealth(call).pending, [], '真派发的决定已经收口，不该进悬空清单')
})

/* ————————————————————— 判据③ / 落点三：历史悬空决定一次列出 ————————————————————— */

test('M244-03 (criterion 3) the two historical dangling decisions are listed by ONE checkup, and a clean ledger is green', () => {
  // 两态之一：干净台账 ⇒ 判据不红（不许"为了看起来有用"而恒红）
  assert.equal(office.dispatchDecisionHealth(call).ok, true, '没有任何决定 ⇒ 体检必须绿')

  // `DEF-214` 点名的两笔：卡 planned、owner 空、零 started
  writeCard(card('TASK-221'))
  writeCard(card('TASK-224'))
  const a = seedDecision('TASK-221', isoAgo(3600))
  const b = seedDecision('TASK-224', isoAgo(3600))

  const health = office.dispatchDecisionHealth(call)
  assert.equal(health.ok, false, '两笔历史悬空决定 ⇒ 判红')
  assert.deepEqual(health.pending.map((row) => row.taskId).sort(), ['TASK-221', 'TASK-224'], '一次体检要列出这两张卡')
  assert.deepEqual(health.pending.map((row) => row.seq).sort((x, y) => x - y), [a.seq, b.seq], '每笔都要点名决定锚点')
  assert.equal(health.lines.length, 2, '判红要给出逐行可读的理由（不静默）')
  for (const line of health.lines) assert.match(line, /ageSeconds=3[0-9]{3}/u, `要点名年龄：${line}`)

  // 反例面：窗口没到就不许判红（判据只判"悬空"，不判"慢"）
  const fresh = office.dispatchDecisionHealth(call, { settleSeconds: 7200 })
  assert.equal(fresh.ok, true, `收口窗口内的决定不许判成悬空（窗口=${String(7200)} 秒）`)
})

/* ————————————————————— 反例格：真在飞不得被判成悬空 ————————————————————— */

test('M244-04 (counterexample) a live card with decided+started is never reported as dangling', () => {
  const seeded = seedDecision('TASK-911', isoAgo(3600))
  office.recordDispatchStarted(call, {
    taskId: 'TASK-911', provider: 'spawn', childSessionId: 'm244-live-0000-4000-8000-00000000bb01',
    tools: 3, role: 'developer', mode: 'continuable',
  })

  const events = office.journalFor(WORKSPACE).read().events
    .map((event) => ({ type: event.type, data: event.data, at: event.at, seq: event.seq }))
  const rows = dispatchDecisionRows(events)
  const row = rows.find((item) => item.seq === seeded.seq)
  assert.equal(row?.closure, 'started', '老台账（无 outcome）靠"之后有没有 started"收口')
  assert.equal(row?.startedSeq !== undefined, true, '收口要给出 started 的序号（可复算锚点）')
  assert.deepEqual(danglingDecisions(events), [], '真在飞的卡绝不进悬空清单（反例格）')
  assert.deepEqual(office.dispatchDecisionHealth(call).pending, [])
  // 同时：它确实算「真在飞」
  assert.deepEqual(office.liveDispatch(call).taskIds, ['TASK-911'])
})

/* ————————————————————— 落点一：失败/降级也当场收口 ————————————————————— */

test('M244-05 (landing 1) a failed start closes in the SAME decided event with a reason; inline closes as inline', async () => {
  writeCard(card('TASK-941', { status: 'ready' }))
  const receipt = await callTool(mount('start-throws'), 'sdo_plan', { action: 'next', limit: 1 })
  assert.equal(linesWith(receipt, '未真正派发').length, 1, `夹具前提：这一轮要真的起不来：${receipt}`)

  const decisions = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'dispatch/decided')
  assert.equal(decisions.length, 1, '一次派发尝试只落一笔决定')
  const data = decisions[0]?.data ?? {}
  assert.equal(String(data['outcome'] ?? ''), 'failed', '起会话失败必须在同一笔决定上收口成 failed')
  assert.match(String(data['failureReason'] ?? ''), /宿主拒绝|无法创建/u, `失败原因原话必须落账：${String(data['failureReason'] ?? '')}`)
  assert.equal(office.journalFor(WORKSPACE).read().events.some((event) => event.type === 'dispatch/started'), false,
    '失败的那一笔不许留下 dispatch/started')
  assert.deepEqual(office.dispatchDecisionHealth(call).pending, [], '生产路径不许留下悬空决定')

  /**
   * 降级 `inline`（就地执行，**没有**子会话可起）同样当场收口 —— 否则它会被守卫永远判成悬空。
   * 卡号不写死：准入按唯一键排序，上一轮的失败卡会排在最前（那是正确行为，不是夹具问题），
   * 所以这里断言的是"这一轮落了一笔 `inline` 收口"，而不是"挑到了某张卡"。
   */
  writeCard(card('TASK-942', { status: 'ready' }))
  const inlineTools = mount('ok')
  const receiptInline = await callTool(inlineTools, 'sdo_plan', { action: 'next', limit: 1, backend: 'inline' })
  assert.match(receiptInline, /就地执行|inline/iu, `夹具前提：这一轮要走 inline 降级：${receiptInline}`)
  const inline = office.journalFor(WORKSPACE).read().events
    .filter((event) => event.type === 'dispatch/decided' && String(event.data['backend']) === 'inline')
  assert.equal(inline.length, 1, 'inline 降级也要落一笔决定（不留白）')
  assert.equal(String(inline[0]?.data['outcome'] ?? ''), 'inline', 'inline 降级必须当场收口成 inline')
  assert.deepEqual(office.dispatchDecisionHealth(call).pending, [], 'inline 收口不许被当成悬空')
})

/* ————————————————————— 落点二·补：悬空点名有界（进回执预算） ————————————————————— */

test('M244-07 (landing 2 + budget) the dangling list is bounded: N show lines plus one folded count line', () => {
  // 5 张悬空卡：逐行点名只印前 `DANGLING_LINES_SHOWN` 张，其余折成一行**计数 + 卡#锚点**
  const rows: DispatchDecisionRow[] = Array.from({ length: 5 }, (_unused, index) => ({
    seq: 100 + index, at: isoAgo(3600), taskId: `TASK-97${String(index)}`, backend: 'subagent', owner: 'developer',
    outcome: undefined, failureReason: '', closure: 'pending' as const, startedSeq: undefined,
    pendingReason: 'no-closure' as const, ageSeconds: 3600,
  }))
  const lines = danglingDecisionLines(rows)
  assert.equal(lines.length, DANGLING_LINES_SHOWN + 1, `逐行 + 折叠 = 上限 + 1 行（得到 ${String(lines.length)} 行）`)
  assert.equal(lines.slice(0, DANGLING_LINES_SHOWN).every((line) => line.includes('closure=pending')), true,
    '前几张必须是完整点名行（卡 + 锚点 + 声明面 + 年龄）')
  assert.match(lines.at(-1) ?? '', new RegExp(`\\+${String(5 - DANGLING_LINES_SHOWN)} more`, 'u'),
    `折叠行必须给出剩余条数：${lines.at(-1) ?? ''}`)
  assert.match(lines.at(-1) ?? '', /TASK-974#104/u, '折叠行还要给出剩余卡的 卡#锚点（反查够用）')
  // 有界：整块字符数是**常数级**（不随悬空卡数线性增长）
  const many: DispatchDecisionRow[] = Array.from({ length: 200 }, (_unused, index) => ({
    ...rows[0] as DispatchDecisionRow, seq: index, taskId: `TASK-8${String(index).padStart(3, '0')}`,
  }))
  const wide = danglingDecisionLines(many).join('\n')
  assert.ok(wide.length <= 3 * 200 + 200, `200 张悬空卡也只许常数级（实际 ${String(wide.length)} 字符）`)
  assert.equal(danglingDecisionLines([]).length, 0, '没有悬空 ⇒ 一个字都不许印')
})

/* ————————————————— `REV-104` #2：outcome='started' 也要台账事件背书 ————————————————— */

test('M244-08 (REV-104 #2) outcome=started without a matching dispatch/started is treated as dangling', () => {
  /**
   * 两次独立 append：`recordDispatch`（decided）与 `recordDispatchStarted`（started）。
   * 第二笔失败时，台账长成「决定说起来了、started 事件没有」。修前 `closure` 直接采信
   * `outcome='started'` ⇒ 悬空守卫（看 closure）与容量守卫（看 live）**都放过它**。
   */
  const nowMs = Date.now()
  const broken = [
    { seq: 10, at: new Date(nowMs - 3600_000).toISOString(), type: 'dispatch/decided',
      data: { task: 'TASK-971', backend: 'subagent', owner: 'developer', outcome: 'started' } },
  ]
  const row = dispatchDecisionRows(broken, { nowMs })[0]
  assert.equal(row?.closure, 'pending', '没有对应 started 的 outcome=started 不许算收口')
  assert.equal(row?.pendingReason, 'started-event-missing', '要说清缺的是哪一笔')
  assert.equal(danglingDecisions(broken, { nowMs }).length, 1, '它必须进悬空清单')
  assert.match(danglingDecisionLine(row as DispatchDecisionRow), /reason=outcome=started-but-no-dispatch-started/u,
    '点名理由要与"什么都没有"分开（那是两种不同的故障）')

  // 反例格：真有那一笔 started ⇒ 必须收口（不许把正常的派发判红）
  const healthy = [...broken, { seq: 11, at: new Date(nowMs - 3599_000).toISOString(), type: 'dispatch/started',
    data: { task: 'TASK-971', childSessionId: 'm244-971-0000-4000-8000-000000000971' } }]
  const okRow = dispatchDecisionRows(healthy, { nowMs })[0]
  assert.equal(okRow?.closure, 'started')
  assert.equal(okRow?.startedSeq, 11, '收口要给出 started 的序号（可复算锚点）')
  assert.deepEqual(danglingDecisions(healthy, { nowMs }), [])
})

test('M244-08b (REV-104 #1) a throw escaping startDispatch still leaves a closed failed decision', async () => {
  writeCard(card('TASK-972', { status: 'ready' }))
  const tools = mount('throws-list')
  const receipt = await callTool(tools, 'sdo_plan', { action: 'next', limit: 1 })
  assert.match(receipt, /TASK-972/u, `夹具前提：这一轮要挑到 TASK-972：${receipt}`)
  const decisions = office.journalFor(WORKSPACE).read().events.filter((event) => event.type === 'dispatch/decided')
  assert.equal(decisions.length, 1, '抛出也必须留下决定（修前：零痕迹）')
  assert.equal(String(decisions[0]?.data['outcome'] ?? ''), 'failed', '抛出要收口成 failed')
  assert.match(String(decisions[0]?.data['failureReason'] ?? ''), /startDispatch threw|boom/u, `要写异常原话：${String(decisions[0]?.data['failureReason'] ?? '')}`)
  assert.deepEqual(office.dispatchDecisionHealth(call).pending, [], '收口过的失败决定不是悬空')
})

/* —————————————— `REV-104` #7：窗口只对老形状/别的写者有意义（真时间戳四态） —————————————— */

test('M244-09 (REV-104 #7) the settle window is judged on real timestamps: four states', () => {
  const nowMs = Date.parse('2026-10-25T12:00:00.000Z')
  const at = (secondsAgo: number): string => new Date(nowMs - secondsAgo * 1000).toISOString()
  const decided = (seq: number, secondsAgo: number, extra: Record<string, unknown> = {}): DispatchLedgerEvent => ({
    seq, at: at(secondsAgo), type: 'dispatch/decided',
    data: { task: `TASK-98${String(seq)}`, backend: 'subagent', owner: 'developer', ...extra },
  })
  const started = (seq: number, secondsAgo: number, task: string): DispatchLedgerEvent => ({
    seq, at: at(secondsAgo), type: 'dispatch/started', data: { task, childSessionId: `c${String(seq)}` },
  })

  // ① 窗口内（100s）还没 started ⇒ 还不算悬空（判据只判"没有收口"，不判"慢"）
  assert.deepEqual(danglingDecisions([decided(1, 100)], { nowMs }), [])
  // ② 过了窗口（301s）仍没有 started ⇒ 判红
  assert.equal(danglingDecisions([decided(1, 301)], { nowMs }).length, 1)
  // ③ started 迟到（决定 400s 前、started 99s 前 = 迟 301s）⇒ **已收口，不许判红**
  const late = [decided(1, 400), started(2, 99, 'TASK-981')]
  assert.deepEqual(danglingDecisions(late, { nowMs }), [], '迟到但到了 = 收口，不许误报')
  assert.equal(dispatchDecisionRows(late, { nowMs })[0]?.closure, 'started')
  // ④ outcome=started 但 started 永不到 ⇒ 仍判红（`REV-104` #2 那一格的时间戳版本）
  assert.equal(danglingDecisions([decided(1, 400, { outcome: 'started' })], { nowMs }).length, 1)
})

/* —————————————— `REV-104` #4/#6：重启窗口的可见量（stale 进 seats 行） —————————————— */

test('M244-10 (REV-104 #4/#6) stale dispatches do not occupy a seat but must be visible in the seats line', () => {
  /**
   * 重启窗口：宿主重启后 TTL（默认 60 分钟）内，所有 `started` 无 `finished` 的都算 live ⇒
   * `free` 可能是 0 而卡表上一张 `in-progress` 都没有（真账 seq 2488 就是这个形状：
   * live = TASK-081/082/083/084、in-progress = 0）。超 TTL 之后它们进 `stale`（不占位），
   * 但"曾经占过"这件事必须看得见。
   */
  const reading = seatReading({
    inProgress: [],
    liveDispatches: [],
    staleDispatches: ['TASK-981', 'TASK-982'],
    budget: 4,
  })
  assert.equal(reading.occupied, 0, '超 TTL 的派发不占位')
  assert.equal(seatNeedsLine(reading), true, '有 stale ⇒ 必须印（否则 free 的变化无从归因）')
  const line = seatLine(reading)
  assert.match(line, /stale=TASK-981 TASK-982/u, `seats 行要点名 stale：${line}`)
})

/* ————————————————— `REV-104` #5：recover/inflight 不许用"全部 started" ————————————————— */

test('M244-11 (REV-104 #5) recoverView/inflightView judge orphans on live dispatches, not on every started ever', () => {
  // 卡还在 in-progress，但它的子会话**已经结算**（started + finished 都走过）
  writeCard(card('TASK-991', { status: 'in-progress', owner: 'developer-deadbee' }))
  office.recordDispatchStarted(call, {
    taskId: 'TASK-991', provider: 'spawn', childSessionId: 'm244-991-0000-4000-8000-000000000991',
    tools: 3, role: 'developer', mode: 'continuable',
  })
  const before = office.recoverView(call)
  assert.deepEqual(before.orphanFlying.map((row) => row.id), [], '还在飞的卡不是孤儿（反例面：不许恒红）')
  assert.match(office.inflightView(call).rows[0]?.child ?? '', /^m244-991/u, '在飞视图要给子会话前 8 位')

  office.journalFor(WORKSPACE).append('dispatch/finished', {
    task: 'TASK-991', childSessionId: 'm244-991-0000-4000-8000-000000000991',
  })
  const after = office.recoverView(call)
  assert.deepEqual(after.orphanFlying.map((row) => row.id), ['TASK-991'],
    '孩子已结算、卡仍 in-progress ⇒ 必须判成孤儿（修前是假绿：注释说"活派发 = started 未 finished"，代码却用全部 started）')
  assert.equal(office.inflightView(call).rows[0]?.child, '', '已结算的孩子不许再出现在在飞视图里')
})

/* ———————————— `REV-104` #6：两条 early return 也要印（有界）悬空点名 ———————————— */

test('M244-12 (REV-104 #6) the "no dispatch + plan issues" branch also names dangling decisions (bounded)', async () => {
  /**
   * 修前这一支（`plan.dispatch = 0` 且有计划问题）**没有健康区** ⇒ 悬空的派发决定一个字都不印
   * （评审推翻了我上一版"所有分支可见"的说法）。夹具：一张声明了 `fixes` 却没声明 `impact` 的卡
   * ⇒ `planIssues` 非空、`dispatch` 为空 ⇒ 恰好走那一支；另加两笔悬空决定。
   */
  // 占满 4 个位子（预算默认 4）⇒ 这一轮一张都派不出去，于是回执落到"没有派发"那一支
  for (const id of ['TASK-980', 'TASK-981', 'TASK-982', 'TASK-983']) {
    writeCard(card(id, { status: 'in-progress', owner: 'developer-busy01' }))
  }
  // 一张"声明了 fixes 却没声明 impact"的卡 ⇒ `planIssues` 非空（这一支的另一半条件）
  writeCard(card('TASK-995', { status: 'ready', fixes: ['DEF-214'] } as Partial<TaskCard>))
  seedDecision('TASK-996', isoAgo(3600))
  seedDecision('TASK-997', isoAgo(3600))
  const receipt = await callTool(mount('ok'), 'sdo_plan', { action: 'next', limit: 1 })
  assert.match(receipt, /本次没有派发|没有派发/u, `夹具前提：这一轮要走"没有派发"那一支：${receipt.slice(0, 200)}`)
  const dangling = linesWith(receipt, 'dangling-decided:')
  assert.equal(dangling.length, 2, `这一支必须点名悬空（有界）：${receipt}`)
  assert.match(dangling[0] ?? '', /TASK-99[67]/u, '要点名卡')
  assert.match(dangling[0] ?? '', /decidedSeq=/u, '要点名决定锚点')
})

/* ————————————————————— 落点二：占位只有一份口径 ————————————————————— */

test('M244-06 (landing 2) seats = in-progress ∪ live dispatches, deduped; dangling decisions occupy nothing', () => {
  const reading = seatReading({
    inProgress: ['TASK-951', 'TASK-952', 'TASK-952'],
    liveDispatches: ['TASK-952', 'TASK-954'],
    danglingDecisions: ['TASK-221', 'TASK-931'],
    budget: 4,
  })
  assert.equal(reading.occupied, 3, '去重后占位 = {951, 952, 954}（重复项不许重复计数）')
  assert.equal(reading.free, 1)
  assert.deepEqual(reading.both, ['TASK-952'], '两边都在的卡必须可分辨（它只占一个位子）')
  assert.deepEqual(reading.danglingDecisions, ['TASK-221', 'TASK-931'], '悬空决定只点名，不参与算术')
  assert.equal(reading.occupied + reading.free, reading.budget)

  /**
   * **该静的必须静 / 该说的必须说**（`TASK-231` 返工：占位行进回执预算）。
   * 三种形态逐条钉住 —— 免得下一轮又把"读者照着卡表就能算出来的数"印回回执里。
   */
  assert.equal(seatNeedsLine(seatReading({ inProgress: ['TASK-951'], liveDispatches: ['TASK-951'], budget: 4 })), false,
    '在飞卡本身就是那张 in-progress 卡 ⇒ 占位与卡表一致 ⇒ 不印')
  assert.equal(seatNeedsLine(seatReading({ inProgress: [], liveDispatches: ['TASK-954'], budget: 4 })), true,
    '子会话在跑但卡没认领 ⇒ 卡表算不出 ⇒ 必须印')
  assert.equal(seatNeedsLine(seatReading({ inProgress: [], liveDispatches: [], danglingDecisions: ['TASK-931'], budget: 4 })), true,
    '有悬空决定 ⇒ 卡表上完全看不到 ⇒ 必须印')
  assert.equal(seatNeedsLine(seatReading({ inProgress: ['TASK-951', 'TASK-952'], liveDispatches: [], budget: 4 })), false,
    '只有已认领的卡 ⇒ 不印（那是卡状态计数的同义反复）')

  // 唯一出口：真在飞只由 started 推导 —— 只有 decided 的台账给出空集合
  const decidedOnly = [{ type: 'dispatch/decided', data: { task: 'TASK-931' }, at: isoAgo(900), seq: 1 }]
  assert.deepEqual(liveDispatchReading(decidedOnly).taskIds, [], '只有 decided ⇒ 零在飞')
  // 超 TTL 的孤儿不进在飞（它不占位，也不能被当空闲复用）
  const stale = [{ type: 'dispatch/started', data: { task: 'TASK-961', childSessionId: 'm244-old-0000-4000-8000-00000000cc01' }, at: isoAgo(7200), seq: 1 }]
  const staleReading = liveDispatchReading(stale, { ttlMs: 60 * 60_000 })
  assert.deepEqual(staleReading.taskIds, [], '超过孤儿 TTL 的派发不算真在飞')
  assert.equal(staleReading.stale.length, 1, '但它必须如实出现在 stale 里（不静默）')
  // 窗口常量就是判据的 N 秒：钉住它，免得有人把它改成"几秒"而让正常派发全红
  assert.equal(DECIDED_SETTLE_SECONDS, 300)
})
