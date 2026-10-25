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
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { unsettledDispatches } from '../src/domain/changeFeed.js'
import {
  sessionHasNoUnsettledDispatch,
  sessionIdleByFinished,
  unsettledDispatch,
} from '../src/domain/dispatchHealth.js'
import { foldPoolChildren } from '../src/domain/pool.js'
import {
  DISPATCH_ABORTED_EVENT,
  DISPATCH_TERMINAL_EVENTS,
  isTerminalDispatch,
} from '../src/types.js'
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
