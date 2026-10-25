/**
 * **增量 247：`release` 必须收口 + 「同一子会话在飞卡 ≤ 1」不变量**（`TASK-237` / `DEF-224`）。
 *
 * 背景（`DEF-224` 的下半，本轮**实测成立**的那一半）：
 *   · `release` 一张"已派发但未结算"的卡时，旧实现只落 `task/released` ⇒ 台账里那笔
 *     `dispatch/started` **永远没有终态**，于是出现第四种不一致形态：「started 还在、卡却 `ready` 无 `owner`」
 *     （现盘实测 20 次：15 分钟内 14 次 / 30 分钟内 15 次、涉 13 张卡）。
 *   · 修法：`release` 先落一条 `dispatch/aborted`（收口事件，带 `startedSeq` 与 `reason`），再改卡状态。
 *
 * 上半（"同一子会话同时两条 started"）在本轮**不复现**（该卡的第一条 DoD 已由上一轮实现会话证伪，
 * `DEF-224` 有更正留痕）：`TASK-231` 的 `dispatch/finished` 早于 `TASK-234` 的 `dispatch/started`，
 * 重叠窗口为 0。因此本文件**不**把"双 started 发生过"当事实，只把「≤ 1」这条不变量**钉成守卫** ——
 * 台账里任何时刻违反它都必红（`M247-05` 扫现盘全账），并用一格反例证明"同一会话**先后**两张卡"是绿的。
 *
 * **口径**：本文件的断言只读**结构化值**（事件 `type` / 字段 / 判定结果），不读任何渲染散文；
 * 台账体检直接折叠 `dispatch/started` → 终态，不读卡上的 `owner` 字符串（那是 `orphanLocks` 的坑）。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { release } from '../src/domain/collab.js'
import {
  DISPATCH_ABORTED_EVENT,
  claimMissing,
  doubleStartedSessions,
  inFlightCardsBySession,
  sessionIsIdle,
  unsettledDispatch,
} from '../src/domain/dispatchHealth.js'
import { listTasks } from '../src/domain/plan.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { realLedgerSkip } from './support/real-ledger.js'
import type { JournalEvent, SdoEventType, TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m247/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

interface Ledger { store: SdoStore; journal: Journal }

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
})
afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 一份**新台账**（每个用例一份：夹具走工厂函数，互不串味）。 */
function freshLedger(name: string): Ledger {
  const store = new SdoStore(join(BASE, name, '.sdo'))
  store.ensureLayout()
  return { store, journal: new Journal(store) }
}

/** 卡夹具（只填判定要读的字段；其余按真实形状补齐）。 */
function card(id: string, status: TaskCard['status'], overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes: ['src/a.ts'],
    role: 'developer',
    size: 'small',
    revision: 1,
    status,
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

function seedCard(store: SdoStore, task: TaskCard): void {
  store.writeYaml(['tasks', `${task.id}.yml`], { task })
}

const eventsOf = (journal: Journal, type: string): JournalEvent[] =>
  journal.read().events.filter((event) => String(event.type) === type)

/** 手造一条事件（TTL / 时间窗那一类判定必须能喂**指定时刻**，而 `journal.append` 只会写"现在"）。 */
function at(seq: number, minutesAgo: number, type: SdoEventType, data: Record<string, unknown>, nowMs: number): JournalEvent {
  return { seq, at: new Date(nowMs - minutesAgo * 60_000).toISOString(), actor: 'sdo', type, data }
}

/* ——————————————————————————————— 落点二：release 收口 ——————————————————————————————— */

test('M247-01 release 一张「已派发未结算」的卡 ⇒ 先落 dispatch/aborted（带 startedSeq 与 reason），再改卡状态', () => {
  const { store, journal } = freshLedger('a')
  seedCard(store, card('TASK-901', 'in-progress', { owner: 'developer-aaaa1111' }))
  const started = journal.append('dispatch/started', { task: 'TASK-901', childSessionId: 'aaaa1111-wire', role: 'developer', reused: true })

  const released = release(store, journal, { taskId: 'TASK-901', actor: 'cockpit', reason: 'handover-to-fresh-session' })
  const events = journal.read().events
  const aborted = events.filter((event) => String(event.type) === DISPATCH_ABORTED_EVENT)

  // ① 收口事件**恰好一条**，四个字段能把它锚回那笔派发
  assert.equal(aborted.length, 1, 'release 必须落一条收口事件')
  assert.equal(aborted[0]?.data['task'], 'TASK-901')
  assert.equal(aborted[0]?.data['childSessionId'], 'aaaa1111-wire')
  assert.equal(aborted[0]?.data['startedSeq'], started.seq, '收口事件必须指回那一笔 started 的序号')
  assert.equal(aborted[0]?.data['reason'], 'handover-to-fresh-session', '理由要进真源（不写理由的收口等于没说）')
  assert.equal(aborted[0]?.data['actor'], 'cockpit')

  // ② 收口之后这张卡**没有**未结算派发（这也是写侧幂等的前提）
  assert.equal(unsettledDispatch(events, 'TASK-901'), undefined, '收口之后再问「还有未结算派发吗」必须是否')

  // ③ 顺序：收口在前、状态变更在后 ⇒ 卡的**最后一条**事件仍是 `task/released`（既有读者读数不变）
  const last = [...events].reverse().find((event) => String(event.data['task'] ?? event.data['id'] ?? '') === 'TASK-901')
  assert.equal(String(last?.type), 'task/released')
  assert.equal((aborted[0]?.seq ?? 0) < (last?.seq ?? 0), true, '收口事件的序号必须小于 task/released')

  // ④ 卡回到 ready、owner 清空（既有语义不变）
  assert.equal(released?.status, 'ready')
  assert.equal(released?.owner, undefined)

  // ⑤ 第四形态消失：台账里**没有**「ready/planned 且无 owner、却还挂着未结算派发」的卡
  const ghosts = listTasks(store)
    .filter((task) => (task.status === 'ready' || task.status === 'planned') && (task.owner ?? '') === '')
    .filter((task) => unsettledDispatch(events, task.id) !== undefined)
  assert.deepEqual(ghosts.map((task) => task.id), [], 'release 之后不许留下 started 还在、卡 ready 无 owner 的形态')
})

test('M247-02 收口不制造噪声：已结算的派发 / 从未派发的卡 / 重复 release 都不落 dispatch/aborted', () => {
  const { store, journal } = freshLedger('b')
  seedCard(store, card('TASK-902', 'in-progress', { owner: 'developer-bbbb2222' }))
  seedCard(store, card('TASK-903', 'in-progress', { owner: 'developer-cccc3333' }))
  journal.append('dispatch/started', { task: 'TASK-902', childSessionId: 'bbbb2222-wire', role: 'developer' })
  journal.append('dispatch/finished', { task: 'TASK-902', childSessionId: 'bbbb2222-wire', reason: 'completed' })

  release(store, journal, { taskId: 'TASK-902', actor: 'cockpit', reason: 'r1' })
  release(store, journal, { taskId: 'TASK-903', actor: 'cockpit', reason: 'r2' })
  assert.equal(eventsOf(journal, DISPATCH_ABORTED_EVENT).length, 0, '已结算 / 未派发的卡 release 时不许补收口事件')

  // 重复 release：第一次收口，第二次没有可收口的东西 ⇒ 仍然只有一条
  const { store: store2, journal: journal2 } = freshLedger('c')
  seedCard(store2, card('TASK-904', 'in-progress', { owner: 'developer-dddd4444' }))
  journal2.append('dispatch/started', { task: 'TASK-904', childSessionId: 'dddd4444-wire', role: 'developer' })
  release(store2, journal2, { taskId: 'TASK-904', actor: 'cockpit', reason: 'r3' })
  release(store2, journal2, { taskId: 'TASK-904', actor: 'cockpit', reason: 'r4' })
  assert.equal(eventsOf(journal2, DISPATCH_ABORTED_EVENT).length, 1, '重复 release 不许重复收口')
})

/* ——————————————————————————————— 落点三：不变量守卫 ——————————————————————————————— */

test('M247-03 守卫判红：同一会话两条在飞卡 ⇒ 点名会话与两张卡（各带 startedSeq）', () => {
  const { store, journal } = freshLedger('d')
  seedCard(store, card('TASK-911', 'in-progress', { owner: 'developer-eeee5555' }))
  seedCard(store, card('TASK-912', 'in-progress', { owner: 'developer-eeee5555' }))
  const first = journal.append('dispatch/started', { task: 'TASK-911', childSessionId: 'eeee5555-wire', role: 'developer' })
  const second = journal.append('dispatch/started', { task: 'TASK-912', childSessionId: 'eeee5555-wire', role: 'developer' })
  const events = journal.read().events

  const violations = doubleStartedSessions(events)
  assert.equal(violations.length, 1, '一批违反都不许漏（这一格只要一条）')
  const row = violations[0]
  assert.equal(row?.childSessionId, 'eeee5555-wire', '判红必须点名会话')
  assert.equal(row?.first.taskId, 'TASK-911', '先发起的卡要被点名')
  assert.equal(row?.first.startedSeq, first.seq)
  assert.equal(row?.second.taskId, 'TASK-912', '后派进去的卡要被点名')
  assert.equal(row?.second.startedSeq, second.seq)

  // 同一份台账的"此刻"读数：该会话手上有两张在飞卡，且**不**空闲（派发前检查要看的就是这个）
  assert.equal(inFlightCardsBySession(events).get('eeee5555-wire')?.length, 2)
  assert.equal(sessionIsIdle(events, 'eeee5555-wire'), false, '持有在飞卡的会话不得被当空闲候选')
})

test('M247-04 反例格必须绿：同一会话**先后**完成两张卡（先 finished 再 started）；不同会话各持一张也绿', () => {
  const { store, journal } = freshLedger('e')
  seedCard(store, card('TASK-921', 'done', { owner: 'developer-ffff6666' }))
  seedCard(store, card('TASK-922', 'in-progress', { owner: 'developer-ffff6666' }))
  journal.append('dispatch/started', { task: 'TASK-921', childSessionId: 'ffff6666-wire', role: 'developer' })
  journal.append('dispatch/finished', { task: 'TASK-921', childSessionId: 'ffff6666-wire', reason: 'completed' })
  journal.append('dispatch/started', { task: 'TASK-922', childSessionId: 'ffff6666-wire', role: 'developer' })

  const events = journal.read().events
  assert.deepEqual(doubleStartedSessions(events), [], '同一会话先后两张卡不是违反（终态先摘掉了第一张）')
  assert.equal(inFlightCardsBySession(events).get('ffff6666-wire')?.length, 1, '此刻只该有一张在飞')

  // 不同会话各持一张在飞卡：不是违反
  seedCard(store, card('TASK-923', 'in-progress', { owner: 'developer-gggg7777' }))
  journal.append('dispatch/started', { task: 'TASK-923', childSessionId: 'gggg7777-wire', role: 'tester' })
  const more = journal.read().events
  assert.deepEqual(doubleStartedSessions(more), [])
  assert.equal(sessionIsIdle(more, 'gggg7777-wire'), false)
  assert.equal(sessionIsIdle(more, 'hhhh8888-wire'), true, '没有在飞卡的会话必须判空闲（否则派发永远找不到人）')
})

test('M247-05 现盘全账体检：「同一会话在飞卡 ≤ 1」在任何时刻都成立（TTL 之外也算）', realLedgerSkip() ?? {}, () => {
  const journalPath = join(ROOT, '.sdo', 'journal.jsonl')
  assert.equal(existsSync(journalPath), true, '体检要读真台账（`realLedgerSkip()` 已保证本机有真账）')
  const events = readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as JournalEvent)

  // `ttlMs: 0` = 不按 TTL 过滤 ⇒ 回答"任何时刻有没有过重叠"，而不是"最近 15 分钟有没有"
  assert.deepEqual(doubleStartedSessions(events, { ttlMs: 0 }), [], '台账里任何时刻同一子会话的在飞卡数必须 ≤ 1')
  // 卡片名的那一对（`TASK-231` / `TASK-234` / 会话 `7e1069c4`）逐事件复算：前者结算在前，重叠窗口为 0
  const key = (event: JournalEvent): string => String(event.data['task'] ?? event.data['id'] ?? '')
  const start234 = events.find((event) => String(event.type) === 'dispatch/started' && key(event) === 'TASK-234')
  assert.equal(start234 !== undefined, true, '夹具前提：台账里要有 TASK-234 的派发')
  const finished231 = events.filter(
    (event) => String(event.type) === 'dispatch/finished' && key(event) === 'TASK-231' && event.seq < (start234 as JournalEvent).seq,
  )
  assert.equal(finished231.length >= 1, true, 'TASK-231 必须在 TASK-234 派发之前就结算过（这就是"双 started 不复现"的机械读数）')
  assert.equal(
    events.some((event) => String(event.type) === 'dispatch/started' && key(event) === 'TASK-231' && event.seq > (start234 as JournalEvent).seq && event.seq < (start234 as JournalEvent).seq + 1),
    false,
    '两张卡在台账里不许有重叠的 started 窗口',
  )
})

/* ————————————————————— 落点一：候选会话空闲判定（只给谓词，接线不在本卡范围） ————————————————————— */

test('M247-06 候选会话空闲谓词：TTL 内算占用、TTL 外不算、结算后不算', () => {
  const nowMs = Date.parse('2026-10-25T12:00:00.000Z')
  const fresh = at(1, 2, 'dispatch/started', { task: 'TASK-931', childSessionId: 'iiii9999-wire' }, nowMs)
  assert.equal(sessionIsIdle([fresh], 'iiii9999-wire', { nowMs }), false, '刚投出去（TTL 内）⇒ 占着位子')
  const stale = at(1, 30, 'dispatch/started', { task: 'TASK-932', childSessionId: 'jjjj0000-wire' }, nowMs)
  assert.equal(sessionIsIdle([stale], 'jjjj0000-wire', { nowMs }), true, '超 TTL 的旧 started 不再挡派发（默认 15 分钟）')
  assert.equal(sessionIsIdle([stale], 'jjjj0000-wire', { nowMs, ttlMs: 0 }), false, '口径反过来：不按 TTL 过滤时它仍算在飞（看全账用这一档）')
  // 结算之后就空闲（不论 TTL）
  const settled = [stale, at(2, 29, DISPATCH_ABORTED_EVENT, { task: 'TASK-932', childSessionId: 'jjjj0000-wire' }, nowMs)]
  assert.equal(sessionIsIdle(settled, 'jjjj0000-wire', { nowMs, ttlMs: 0 }), true, '收口之后必须判空闲')
  // 两条 started 的时间差在 TTL 内 ⇒ 违反；相差超过 TTL ⇒ 不报（老 started 不是派发决策的输入）
  const close = [at(1, 10, 'dispatch/started', { task: 'TASK-933', childSessionId: 'kkkk1111-wire' }, nowMs), at(2, 9, 'dispatch/started', { task: 'TASK-934', childSessionId: 'kkkk1111-wire' }, nowMs)]
  assert.equal(doubleStartedSessions(close, { nowMs }).length, 1)
  const far = [at(1, 40, 'dispatch/started', { task: 'TASK-935', childSessionId: 'llll2222-wire' }, nowMs), at(2, 1, 'dispatch/started', { task: 'TASK-936', childSessionId: 'llll2222-wire' }, nowMs)]
  assert.deepEqual(doubleStartedSessions(far, { nowMs }), [], 'TTL 之外的旧 started 不算"同时持两张"')
  assert.equal(doubleStartedSessions(far, { nowMs, ttlMs: 0 }).length, 1, '同一份事件在"不过滤 TTL"的口径下必须报出来')
})

test('M247-09 不误伤「同一张卡的复投」（追加指令给正握着这张卡的会话）：不是违反，只在飞一条且序号更新', () => {
  const nowMs = Date.parse('2026-10-25T12:00:00.000Z')
  const first = at(1, 6, 'dispatch/started', { task: 'TASK-961', childSessionId: 'oooo5555-wire' }, nowMs)
  const again = at(2, 5, 'dispatch/started', { task: 'TASK-961', childSessionId: 'oooo5555-wire', reused: true }, nowMs)
  const same = [first, again]
  assert.deepEqual(doubleStartedSessions(same, { nowMs, ttlMs: 0 }), [], '同一张卡投第二次不是"同时持两张"')
  const rows = inFlightCardsBySession(same, { nowMs }).get('oooo5555-wire') ?? []
  assert.equal(rows.length, 1, '在飞清单只该有一条（复投是更新，不是叠加）')
  assert.equal(rows[0]?.startedSeq, again.seq, '清单留住的是**最新**那一笔（后续按它回读台账）')
  assert.equal(sessionIsIdle(same, 'oooo5555-wire', { nowMs }), false)
})

/* ——————————————————————————————— 读侧计入：收口事件是终态 ——————————————————————————————— */

test('M247-07 读侧计入 dispatch/aborted：release 过的卡不再被当成"派发未认领"的静默失败候选', () => {
  const nowMs = Date.parse('2026-10-25T12:00:00.000Z')
  const started = at(1, 10, 'dispatch/started', { task: 'TASK-941', childSessionId: 'mmmm3333-wire' }, nowMs)
  const ready = card('TASK-941', 'ready')
  const before = claimMissing([ready], [started], { nowMs, windowMs: 5 * 60_000 })
  assert.equal(before.length, 1, '没有终态事件时它确实是"静默失败候选"')
  assert.equal(before[0]?.ended, false)

  const aborted = at(2, 9, DISPATCH_ABORTED_EVENT, { task: 'TASK-941', childSessionId: 'mmmm3333-wire', startedSeq: 1, reason: 'released' }, nowMs)
  const after = claimMissing([ready], [started, aborted], { nowMs, windowMs: 5 * 60_000 })
  assert.equal(after.length, 1)
  assert.equal(after[0]?.ended, true, '收口事件必须被读成"这一轮派发已经结束"')
  assert.equal(after[0]?.reason, 'released')
})

test('M247-08 反例格（修前的旧形态）：只落 task/released、不落收口 ⇒ 判定必须抓住它（证明读数不是恒绿）', () => {
  const { store, journal } = freshLedger('f')
  // 手造"旧实现的行为"：派发 → 只改卡状态（release 不写收口事件）
  seedCard(store, card('TASK-951', 'in-progress', { owner: 'developer-nnnn4444' }))
  const started = journal.append('dispatch/started', { task: 'TASK-951', childSessionId: 'nnnn4444-wire', role: 'developer' })
  journal.append('task/released', { id: 'TASK-951', actor: 'cockpit', reason: 'old path', previousOwner: 'developer-nnnn4444' })
  seedCard(store, card('TASK-951', 'ready'))

  const events = journal.read().events
  // ① 旧形态在真源里就是"未结算"：判定必须仍看得见那笔 started（否则修复前后的读数没有差别）
  const open = unsettledDispatch(events, 'TASK-951')
  assert.equal(open?.startedSeq, started.seq)
  assert.equal(open?.childSessionId, 'nnnn4444-wire')
  // ② 于是"ready 无 owner 却还有未结算派发"的体检能把它点出来（正例修好、反例照红）
  const ghosts = listTasks(store)
    .filter((task) => (task.status === 'ready' || task.status === 'planned') && (task.owner ?? '') === '')
    .filter((task) => unsettledDispatch(events, task.id) !== undefined)
  assert.deepEqual(ghosts.map((task) => task.id), ['TASK-951'], '第四形态必须被点出来（这条读数是判据的底座）')
})
