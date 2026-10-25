/**
 * **增量 248：派发终态口径统一 + 会话空闲改用 `finished` 口径**（`TASK-240`，`REV-103` 卡外三项）。
 *
 * 立案现场（三个洞，修前都有读数）：
 *   ① **中性表没有守卫** —— `dispatch/aborted` 在 `SIGNATURE_NEUTRAL_EVENTS` 里，而 `test/m37.test.ts`
 *      的账本清单是**手挑**的、漏了它：把 `src/types.ts` 那一行删掉，m37 一格都不红，而
 *      `isSignatureInvalidatingEvent('G3', …)` 会翻成 `true`（每次 `release` 都把 G3 签字判失效）。
 *      修法在 m37（整表派生 + 身份快照两向对账）。
 *   ② **三处终态口径各写一份** —— `domain/dispatchHealth.ts` 认 `aborted`、`domain/pool.ts` 的 busy
 *      折叠只认 `finished`（有意：会话照旧占位）、`domain/changeFeed.ts` 认 `finished` + `reported`。
 *      三份各写、零反例 ⇒ 修法是把两档口径收进 `src/types.ts`（`DISPATCH_TERMINAL_EVENTS` +
 *      `isTerminalDispatch`），三处改成读同一处。
 *   ③ **会话空闲没有方向正确的谓词** —— 旧的 `sessionHasNoUnsettledDispatch` 建在口径甲上
 *      （`aborted` 会出栈）⇒ 把"已 release 但仍在跑"的会话判成空闲（`DEF-224` 的形态）。
 *      修法见 `sessionIdleByFinished`：只认 `dispatch/finished`。
 *
 * **本文件的纪律**：每格都**双态**（红的那个方向 + 它的对照），断言只读**结构化值**
 * （事件 field / 判定结果 / 折叠出来的 state），不读任何渲染散文；三处读侧的对账用**同一张表**跑，
 * 于是"某一处偷偷多收/少收一档"会当场点名到那一处。
 *
 * **`TASK-261` 续（落点一/二/三）**：本文件的下半场把上面的判据从"两个谓词"收成"一处增量真源"，
 * 并给 TTL 立一条**只读数、不改判定**的边界：
 *   · 落点一 —— `domain/pool.ts` 的 busy 折叠与 `sessionIdleByFinished` 曾是同一件事的两份实现
 *     （状态机 vs 序号比大小）。修后折叠层读 `sessionIdleAfterEvent` / `sessionIdleTracker`
 *     （`M248-07` 逐事件一致：三处逐前缀相同）；
 *   · 落点二 —— **TTL 不参与空闲判定**：超时只多一条「悬置 N 分钟」读数（`suspendedDispatches`，
 *     经 `office.dispatchHealth` 交健康区），空闲判定在超时前后**同一答案**（`M248-09` / `M248-10`）；
 *   · 落点三 —— 守卫打**真实路径**（`rolePools` / `reuseCandidateOrder` 的输出集合），
 *     断言"只有 `started` 没有 `finished` 的会话**不进可复用集**"，而不是断言某个函数返回布尔值
 *     （`M248-08`）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { unsettledDispatches } from '../src/domain/changeFeed.js'
import {
  sessionHasNoUnsettledDispatch,
  sessionIdleAfterEvent,
  sessionIdleByFinished,
  sessionIdleTracker,
  suspendedDispatches,
  unsettledDispatch,
} from '../src/domain/dispatchHealth.js'
import { foldPoolChildren, rolePools, reuseCandidateOrder } from '../src/domain/pool.js'
import {
  DISPATCH_ABORTED_EVENT,
  DISPATCH_TERMINAL_EVENTS,
  isTerminalDispatch,
} from '../src/types.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { PoolChild, RolePool } from '../src/domain/pool.js'
import type { JournalEvent, SdoEventType } from '../src/types.js'

const AT = '2026-10-25T12:00:00.000Z'
const SESSION = 'S1'
const CARD = 'TASK-900'

/** 一条合成事件（只造判据读得到的字段：`type` / `data.childSessionId` / `data.task`）。 */
function ev(seq: number, type: SdoEventType, data: Record<string, unknown> = {}): JournalEvent {
  return { seq, at: AT, actor: 'test', type, data }
}

/** 一笔"某卡派给某会话"的开始。 */
function started(seq: number, session = SESSION, task = CARD): JournalEvent {
  return ev(seq, 'dispatch/started', { childSessionId: session, task })
}

/** 某个终态事件（`finished` / `aborted` / `reported` …）。 */
function terminal(seq: number, type: SdoEventType, session = SESSION, task = CARD): JournalEvent {
  return ev(seq, type, { childSessionId: session, task, reason: 'test' })
}

// —————————————————————— 落点二：会话空闲按 `finished` 判 ——————————————————————

test('M248-01 「已 aborted 但未 finished」的会话 ⇒ 判**忙**（`DEF-224` 重演的那条防线）', () => {
  const released = [started(1), terminal(2, 'dispatch/aborted')]
  assert.equal(
    sessionIdleByFinished(released, SESSION),
    false,
    '`release` 只说明卡不归它了，不说明会话停了 ⇒ 必须判忙（判空闲就会把第二张卡投进去）',
  )
  // 双态：真结算之后才允许判空闲 —— 否则上面那条断言可能只是"恒假"
  const settled = [...released, terminal(3, 'dispatch/finished')]
  assert.equal(sessionIdleByFinished(settled, SESSION), true, '补上 `dispatch/finished` 之后判空闲')
})

test('M248-02 「已 finished」的会话 ⇒ 判空闲（双态：去掉那条 finished 就判忙）', () => {
  const settled = [started(1), terminal(2, 'dispatch/finished')]
  assert.equal(sessionIdleByFinished(settled, SESSION), true, '会话真的停了 ⇒ 空闲')
  assert.equal(sessionIdleByFinished([started(1)], SESSION), false, '只有 `dispatch/started` ⇒ 忙（对照：证明上一条不是恒真）')
  // 边界：没被派发过的会话、空 id ⇒ 空闲（与 `sessionHasNoUnsettledDispatch` 的既有口径一致）
  assert.equal(sessionIdleByFinished(settled, 'S-never-dispatched'), true, '台账里没这个会话 ⇒ 空闲')
  assert.equal(sessionIdleByFinished(settled, ''), true, '空 id ⇒ 空闲（不凭空造一个"忙"的会话）')
})

test('M248-03 真在跑的面：同一会话接过第二张卡之后，`aborted` 不许把它判成空闲', () => {
  // 卡 A 被 release 收口（aborted），卡 B 紧接着派给**同一个**会话且尚未结算
  const second = [started(1, SESSION, 'TASK-900'), terminal(2, 'dispatch/aborted', SESSION, 'TASK-900'), started(3, SESSION, 'TASK-901')]
  assert.equal(sessionIdleByFinished(second, SESSION), false, '第二张卡还在跑 ⇒ 忙（`aborted` 不参与判定）')
  // 双态：第二张卡自己结算 ⇒ 空闲
  assert.equal(sessionIdleByFinished([...second, terminal(4, 'dispatch/finished', SESSION, 'TASK-901')], SESSION), true)
  // 复用多轮：第一轮的 finished 不许把第二轮的 started 洗成空闲（否则"最近一笔"就没在起作用）
  const reuse = [started(1), terminal(2, 'dispatch/finished'), started(3)]
  assert.equal(sessionIdleByFinished(reuse, SESSION), false, '第二轮的 started 晚于第一轮的 finished ⇒ 忙')
})

test('M248-04 `@deprecated` 的依据：同一份台账上口径甲说"没有悬着的派发"、口径乙仍说"忙"', () => {
  const released = [started(1), terminal(2, 'dispatch/aborted')]
  assert.equal(
    sessionHasNoUnsettledDispatch(released, SESSION),
    true,
    '口径甲：这一轮已经收口 ⇒ 台账里没有悬空决定（这是它**唯一**该回答的问题）',
  )
  assert.equal(
    sessionIdleByFinished(released, SESSION),
    false,
    '口径乙：会话可能还在跑 ⇒ 忙 —— 两个谓词对同一份台账给出相反答案，正是 @deprecated 的理由',
  )
})

// —————————————————————— 落点一：三处读侧与共享谓词对账 ——————————————————————

/** 参与对账的事件类型（终态三档 + 两条"不是终态"的对照）。 */
const SCOPE_TABLE: readonly SdoEventType[] = [
  'dispatch/finished',
  'dispatch/aborted',
  'dispatch/reported',
  'dispatch/observed',
  'dispatch/reuse-skipped',
]

test('M248-05 三处读侧与共享谓词对账：差别只有"故意多收 reported"这一处', () => {
  // ① 两档真值表（这就是 `src/types.ts` 的那一份真源，读侧必须与它一致）
  assert.deepEqual([...DISPATCH_TERMINAL_EVENTS.session], ['dispatch/finished'], '`session` 档只认 dispatch/finished')
  assert.deepEqual([...DISPATCH_TERMINAL_EVENTS.card], ['dispatch/finished', DISPATCH_ABORTED_EVENT], '`card` 档认 finished 或 aborted')
  assert.equal(isTerminalDispatch('dispatch/aborted', 'session'), false, '会话档不收 aborted（收口 ≠ 停）')
  assert.equal(isTerminalDispatch('dispatch/aborted', 'card'), true, '卡档收 aborted（写者已收口这张卡）')
  assert.equal(isTerminalDispatch('dispatch/reported', 'card'), false, 'reported 不入 card 档：它是两处读侧各自多收的那一档')

  // ② 逐类型跑三处读侧，与"该档口径 + 记录的额外一档"逐格比
  for (const type of SCOPE_TABLE) {
    const settlesSession = isTerminalDispatch(type, 'session')
    const settlesCard = isTerminalDispatch(type, 'card') || type === 'dispatch/reported'

    // `domain/pool.ts` 的 busy 折叠读 `session` 档（会话照旧占位）
    const pool = foldPoolChildren([started(1), { type, data: { childSessionId: SESSION, task: CARD } }])
    assert.equal(
      pool.get(SESSION)?.state,
      settlesSession ? 'idle' : 'busy',
      `pool 的 busy 折叠与 session 档不符（${type}）：收口不等于停，被 release 的会话照旧占位`,
    )

    // `domain/changeFeed.ts` 与 `domain/dispatchHealth.ts` 读 `card` 档 + `reported`
    const events = [started(1), terminal(2, type)]
    assert.equal(
      unsettledDispatches(events).length,
      settlesCard ? 0 : 1,
      `changeFeed 的终态口径与 card 档 + reported 不符（${type}）`,
    )
    assert.equal(
      unsettledDispatch(events, CARD) === undefined,
      settlesCard,
      `dispatchHealth 的终态口径与 card 档 + reported 不符（${type}）`,
    )
  }

  // ③ 那一处"故意不同"的正面读数：`reported` 收口卡档的读数，但**不**释放会话
  assert.equal(isTerminalDispatch('dispatch/reported', 'card'), false, '前提：reported 不在 card 档里')
  assert.equal(unsettledDispatch([started(1), terminal(2, 'dispatch/reported')], CARD) === undefined, true, '卡侧：交回报告 ⇒ 这一轮不必再收口')
  assert.equal(foldPoolChildren([started(1), { type: 'dispatch/reported', data: { childSessionId: SESSION, task: CARD } }]).get(SESSION)?.state, 'busy', '会话侧：交回报告不等于停了 ⇒ 照旧占位')
})

test('M248-06 changeFeed 现在直接认 aborted：只有 aborted、没有 task/released 的台账也判已收口（双态）', () => {
  const withAbort = [started(1), terminal(2, 'dispatch/aborted')]
  assert.equal(unsettledDispatches(withAbort).length, 0, 'aborted ⇒ 这一轮已收口（修前这条只被同卡的 task/released 顺带盖住）')
  const noTerminal = [started(1), terminal(2, 'dispatch/observed')]
  assert.equal(unsettledDispatches(noTerminal).length, 1, '非终态事件不得被当成收口（对照：证明上一条不是恒真）')
})

// —————————————————————— `TASK-261` 落点一：双实现收成一处的**逐事件**读数 ——————————————————————

/** 一条带自定义时刻的事件（TTL 那两格要用"这一刻"）。 */
function evAt(seq: number, at: string, type: SdoEventType, data: Record<string, unknown> = {}): JournalEvent {
  return { seq, at, actor: 'test', type, data }
}

/** 一份"每个会话都走到不同格子"的台账：复用多轮 / `aborted` / `reported` / `observed` 各有。 */
function mixedLedger(): JournalEvent[] {
  return [
    started(1, 'S-reuse', 'TASK-901'),
    terminal(2, 'dispatch/finished', 'S-reuse', 'TASK-901'),
    started(3, 'S-reuse', 'TASK-902'),
    started(4, 'S-aborted', 'TASK-903'),
    terminal(5, 'dispatch/aborted', 'S-aborted', 'TASK-903'),
    terminal(6, 'dispatch/reported', 'S-aborted', 'TASK-903'),
    started(7, 'S-clean', 'TASK-904'),
    terminal(8, 'dispatch/finished', 'S-clean', 'TASK-904'),
    started(9, 'S-hang', 'TASK-905'),
    ev(10, 'dispatch/observed', { childSessionId: 'S-hang', task: 'TASK-905' }),
  ]
}

/** 只走**增量真源**单独折一个会话（不经过 `foldPoolChildren`，两处因此可以互相对账）。 */
function foldBySource(events: readonly JournalEvent[], id: string): boolean {
  const tracker = sessionIdleTracker()
  let idle = true
  for (const event of events) {
    if (event.data['childSessionId'] !== id) continue
    idle = tracker.step(id, event).idle
  }
  return idle
}

test('M248-07 逐事件一致性：折叠层 / 增量真源 / 整体谓词逐前缀同解（`TASK-261` 落点一）', () => {
  const ledgerEvents = mixedLedger()
  let cells = 0
  for (let k = 1; k <= ledgerEvents.length; k += 1) {
    const prefix = ledgerEvents.slice(0, k)
    for (const [id, child] of foldPoolChildren(prefix)) {
      cells += 1
      const byPredicate = sessionIdleByFinished(prefix, id)
      assert.equal(foldBySource(prefix, id), byPredicate, `第 ${k} 笔之后 ${id}：增量真源与整体谓词不一致`)
      assert.equal(child.state, byPredicate ? 'idle' : 'busy', `第 ${k} 笔之后 ${id}：折叠层与谓词不一致 —— 两份实现分叉就是这个形状`)
    }
  }
  assert.equal(cells > 0, true, '夹具前提：逐前缀至少要折出一些格子（否则这格什么都没比）')

  // 末态正面读数（每个会话一个对照，证明上面那圈不是"恒真"）
  const fold = foldPoolChildren(ledgerEvents)
  assert.equal(fold.get('S-reuse')?.state, 'busy', '复用第二轮尚未结算 ⇒ 忙（第一轮的 finished 不许把它洗成空闲）')
  assert.equal(fold.get('S-aborted')?.state, 'busy', 'aborted / reported 都不释放会话')
  assert.equal(fold.get('S-clean')?.state, 'idle', '真结算 ⇒ 空闲')
  assert.equal(fold.get('S-hang')?.state, 'busy', '只有 started ⇒ 忙')
})

// —————————————————————— `TASK-261` 落点三：真实路径（池视图 / 可复用集） ——————————————————————

const VIEWER = 'S-parent'
const NOW_MS = Date.parse('2026-10-25T12:00:00.000Z')

/**
 * 把折叠出来的孩子改成"看起来可复用"的样子（掩码一致、同父会话、continuable、余量够）
 * —— 于是这一格**只剩忙闲**这一个变量能把它们挡在可复用集之外。
 */
function poolable(events: readonly JournalEvent[]): PoolChild[] {
  return [...foldPoolChildren(events).values()].map((child) => ({
    ...child,
    // 池视图按 `role` 分桶：夹具里的 `started` 不带角色，这里补上（否则一个孩子都进不了池）
    role: 'developer',
    mode: 'continuable',
    parentSessionId: VIEWER,
    maskHash: 'same',
    rounds: 1,
    cards: 1,
  }))
}

/** 走**真实路径**：`rolePools` 折叠出池视图（可注入"现在"与孤儿 TTL）。 */
function devPool(children: readonly PoolChild[], options: { nowMs?: number | undefined; orphanTtlMs?: number | undefined } = {}): RolePool {
  const pool = rolePools({
    children,
    roles: ['developer'],
    caps: { developer: 4 },
    defaultCap: 4,
    maskHashOf: () => 'same',
    reuseBlockedOf: () => undefined,
    viewerSessionId: VIEWER,
    nowMs: options.nowMs ?? NOW_MS,
    ...(options.orphanTtlMs === undefined ? {} : { orphanTtlMs: options.orphanTtlMs }),
  })[0]
  // 夹具前提（不是判据）：developer 角色必须在池里；失败原因用 ASCII，免得被读散文棘轮算成一个"读自由文本"的站点
  if (pool === undefined) throw new Error('fixture precondition: the developer pool must exist')
  return pool
}

/** 可复用集（`reuseCandidateOrder` 的输出顺序）—— 断言读它，而不是读某个布尔返回值。 */
function reusable(pool: RolePool): string[] {
  return reuseCandidateOrder(pool).map((child) => child.childSessionId)
}

test('M248-08 真实路径：只有 `started` 没有 `finished` 的会话不进可复用集（`rolePools` × `reuseCandidateOrder`，双态）', () => {
  const ledgerEvents = [
    started(1, 'S-hang', 'TASK-911'),
    started(2, 'S-reuse', 'TASK-912'),
    terminal(3, 'dispatch/finished', 'S-reuse', 'TASK-912'),
    started(4, 'S-reuse', 'TASK-913'),
    started(5, 'S-aborted', 'TASK-914'),
    terminal(6, 'dispatch/aborted', 'S-aborted', 'TASK-914'),
    started(7, 'S-clean', 'TASK-915'),
    terminal(8, 'dispatch/finished', 'S-clean', 'TASK-915'),
  ]
  const pool = devPool(poolable(ledgerEvents))
  assert.deepEqual(reusable(pool), ['S-clean'], '可复用集里只该有真结算过的那一个（悬空的、复用第二轮的、被 aborted 收口的都在外面）')
  assert.deepEqual(pool.idle.map((child) => child.childSessionId), ['S-clean'], '空闲可复用栏与可复用集同源')
  assert.deepEqual(
    pool.busy.map((child) => child.childSessionId).sort(),
    ['S-aborted', 'S-hang', 'S-reuse'],
    '三个仍占着位子的会话都要在在飞栏里',
  )

  // 双态 ①：给悬空那个补一笔 `finished` ⇒ 它进可复用集（证明上面那一格不是"恒空"）
  const settledHang = [...ledgerEvents, terminal(9, 'dispatch/finished', 'S-hang', 'TASK-911')]
  assert.deepEqual(reusable(devPool(poolable(settledHang))).sort(), ['S-clean', 'S-hang'], '真结算之后才进可复用集')

  // 双态 ②：把真结算过的那一个的 `finished` 拿掉 ⇒ 可复用集为空
  const withoutFinish = ledgerEvents.filter((event) => !(event.type === 'dispatch/finished' && event.data['childSessionId'] === 'S-clean'))
  assert.deepEqual(reusable(devPool(poolable(withoutFinish))), [], '一个都没结算过 ⇒ 可复用集为空（对照：证明上一格靠的是 settled 读数）')
})

// —————————————————————— `TASK-261` 落点二：TTL 只出读数、不改判空闲 ——————————————————————

test('M248-09 TTL 双态：超时只多一条「悬置 N 分钟」读数，空闲判定与可复用集一个字不变（`TASK-261` 落点二）', () => {
  const ttl = 15 * 60_000
  const hanging = [evAt(1, '2026-10-25T11:50:00.000Z', 'dispatch/started', { childSessionId: 'S-hang', task: 'TASK-921' })]
  const earlyMs = NOW_MS // 悬了 10 分钟
  const lateMs = NOW_MS + 10 * 60_000 // 悬了 20 分钟

  // ① 超时前：读数里没有它
  assert.deepEqual(suspendedDispatches(hanging, { nowMs: earlyMs, ttlMs: ttl }), [], '悬了 10 分钟（TTL 15）⇒ 还不算悬置超时')
  // ② 超时后：读数出现，四项都点名
  const rows = suspendedDispatches(hanging, { nowMs: lateMs, ttlMs: ttl })
  assert.equal(rows.length, 1, '悬了 20 分钟 ⇒ 恰一条读数')
  assert.deepEqual(
    [rows[0]?.childSessionId, rows[0]?.taskId, rows[0]?.startedSeq, rows[0]?.minutes],
    ['S-hang', 'TASK-921', 1, 20],
    '读数要点名会话 / 卡 / 可复算序号 / 分钟数',
  )

  // ③ **判定不变**：空闲判据没有时间入参 ⇒ 超时前与超时后同一答案（判忙）
  assert.equal(sessionIdleByFinished(hanging, 'S-hang'), false, '超时之后照旧判忙 —— 把"悬了很久"读成"空闲了"正是 `DEF-224` 的形状')
  const step = sessionIdleAfterEvent(true, hanging[0] as JournalEvent)
  assert.deepEqual([step.idle, step.settled], [false, false], '增量真源对同一笔也判忙（收不到时间入参）')

  // ④ 池视图两态：超时前在飞、超时后进 `stale` 栏 —— 两个时点都**不在**可复用集里
  const earlyPool = devPool(poolable(hanging), { nowMs: earlyMs, orphanTtlMs: ttl })
  assert.deepEqual(earlyPool.busy.map((child) => child.childSessionId), ['S-hang'], '超时前：在飞')
  assert.deepEqual(earlyPool.stale, [], '超时前：还不到孤儿 TTL')
  assert.deepEqual(reusable(earlyPool), [], '超时前不在可复用集')
  const latePool = devPool(poolable(hanging), { nowMs: lateMs, orphanTtlMs: ttl })
  assert.deepEqual(latePool.stale.map((child) => child.childSessionId), ['S-hang'], '超时后：进 stale 栏（"不能确定它还在不在"如实标注）')
  assert.equal(latePool.busy.length, 0, '超时后不算在飞（既有口径：孤儿不占池位）')
  assert.deepEqual(reusable(latePool), [], '**超时后仍不在可复用集** —— stale 那一栏不进 idle')

  // ⑤ 对照（这就是本卡要防的那一步）：拿带 TTL 的口径甲当判据，同一份台账会读出"没有悬着的派发"
  assert.equal(sessionHasNoUnsettledDispatch(hanging, 'S-hang', { nowMs: earlyMs }), false, 'TTL 窗口内：口径甲也说"悬着"')
  assert.equal(sessionHasNoUnsettledDispatch(hanging, 'S-hang', { nowMs: lateMs }), true, 'TTL 一过：口径甲翻成"没有悬着的派发" ⇒ 按它接线就会把第二张卡投进这个会话（`DEF-224`）')
})

// —————————————————————— `TASK-261` 落点二：读数交到健康区入口 ——————————————————————

test('M248-10 健康区入口交出「悬置超时 N 分钟」（真实 `SoftwareDevOffice`，双态）', () => {
  const base = fileURLToPath(new URL('../../node_modules/.sdo-test/m248/', import.meta.url))
  const workspace = join(base, 'proj')
  rmSync(base, { recursive: true, force: true })
  mkdirSync(workspace, { recursive: true })
  try {
    const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
    office.noteSession('s1', workspace)
    const call = { sessionId: 's1', cwd: workspace } as unknown as OfficeCall
    office.journalFor(workspace).append('dispatch/started', { task: 'TASK-931', childSessionId: 'S-hang', role: 'developer' })

    // ① 窗口内：读数空（刚派出去不算悬置超时）
    assert.deepEqual(office.dispatchHealth(call).suspended, [], '刚派出去 ⇒ 不报悬置超时')
    // ② 窗口后：交出一行，卡与会话都被点名，分钟数现算
    // 窗口取项目设置的口径（`dispatchOrphanTtlMinutes` 默认 60 分钟）：注入"现在"= 90 分钟后
    const lateMs = Date.now() + 90 * 60_000
    const late = office.dispatchHealth(call, { nowMs: lateMs })
    assert.deepEqual(late.suspended.map((row) => [row.taskId, row.childSessionId]), [['TASK-931', 'S-hang']], '健康区入口要点名"哪张卡的哪一笔派发"')
    assert.equal((late.suspended[0]?.minutes ?? 0) >= 89, true, '分钟数要现算（注入"现在"= 90 分钟后）')
    // ③ 真结算之后读数消失（双态：证明它不是一个恒有的常量）
    office.journalFor(workspace).append('dispatch/finished', { task: 'TASK-931', childSessionId: 'S-hang', reason: 'completed' })
    assert.deepEqual(office.dispatchHealth(call, { nowMs: lateMs }).suspended, [], '真结算 ⇒ 读数消失')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
