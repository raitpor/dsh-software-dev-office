/**
 * **派发健康度**（DEF-053，2026-10-14 机制缺陷批 §3B）：两个把"界面看到的"与"台账记着的"分开的读数。
 *
 * 缺陷的两个形状（都有真机现场，journal 序号可复算）：
 *
 * **形状一 · 派发成功 ≠ 卡被认领**：4 条 `dispatch/started`（界面上确实有 4 个子代理在跑）而台账里
 * **只有 1 张卡 `in-progress`** ⇒ 3 个子代理跑完一轮却**从未认领**（`task/claimed` 零事件）。
 * 单看界面或单看台账都不构成全称事实；需要一条**机械**读数 + 一条可审计事件。
 *
 * **形状二 · 锁的持有者是"卡的状态字段"而不是"活着的会话"**：owner 会话早已
 * `dispatch/finished`（`reason=completed` 因上下文耗尽 / `reason=error`），卡却仍停在 `in-progress`
 * 攥着写范围 ⇒ 别的卡认领时被 `write-scope-conflict` 拒（真机两例：TASK-090 的 owner `20af1d60`、
 * TASK-104 的 owner `37fd75f0`；后者零产品改动）。**判定必须现读 owner 会话最近一次派发的终态**，
 * 而不是读卡上的 `owner` 字符串。
 *
 * 本模块只做**判定与读数**（纯函数）：发布/自动释放由调用方决定 —— 真源纪律是"失联 owner 不自动释放"
 * （防误抢），所以这里产出的是**可执行的下一步**（`release` 命令）而不是替人释放。
 *
 * **形状三 · 一张卡被放手，它那一轮派发没人收口**（`TASK-237` / `DEF-224` 落点二）：
 * `release` 把卡放回 `ready`、清空 `owner`，但台账里那笔 `dispatch/started` **没有任何终态** ⇒
 * 留下"started 还在、卡却 ready 无 owner"的第四种不一致形态（现盘实测：20 次 `release` 落在
 * 未结算的派发上 —— 15 分钟内 14 次 / 30 分钟内 15 次、涉 13 张卡，逐条 seq 见 `test/m247.test.ts`）。
 * 收口事件是 `dispatch/aborted`：`release` 是唯一写者，{@link unsettledDispatch} 是写侧与读侧共用的判定。
 *
 * **不变量 · 同一子会话的在飞卡 ≤ 1**（同卡落点三）：一个 continuable 子会话只有一条工作线索，
 * 两张卡同时"进行中"时写范围互斥实际被绕过（它写的是两卡范围的并集）。
 * {@link doubleStartedSessions} 是这条不变量的**唯一判定**（按**口径乙**，见下）。
 *
 * **两条口径必须分开**（`REV-103` F2，2026-10-25 —— `DEF-224` 的修法就栽在这上面）：
 *   · **口径甲 · 这一轮派发在台账里还悬着吗** —— 终态 = 会话自己结算（`dispatch/finished` /
 *     `dispatch/reported`）**或**写者主动收口（`dispatch/aborted`）。{@link unsettledDispatch}
 *     与既有的 `claimMissing` / `reuseDeliveries` 用这一档。
 *   · **口径乙 · 这个子会话还占着位子吗** —— **只认** `dispatch/finished`（与 `pool.ts` 的 busy
 *     折叠同一档）。`dispatch/aborted` 只说明"卡不归它了"，**不说明它停了**：一个被 release 收口、
 *     但仍可能在跑的会话，按口径乙**依然是忙的**。
 * 把两档混成一份表就会交出一个**方向相反的零件**：本模块早期版本那个"会话空闲"谓词把 aborted 当出栈
 * ⇒ 被 release 但仍在跑的会话被判"空闲" ⇒ 接线之后正会把第二张卡投进去（`DEF-224` 的形态）。
 * 因此那一族谓词现在**只回答口径甲**，名字也改成口径甲的名字（{@link unsettledCardsBySession} /
 * {@link sessionHasNoUnsettledDispatch}，注释里逐条写明**不可用于"会话空闲"判定**）。
 *
 * **"派发前检查候选会话空闲"不在本卡交付**（`REV-103` 裁定 ①）：它要接进 `office.ts` 的会话选择与
 * `pool.ts` 的 busy 折叠（都不在 `TASK-237` 写范围）⇒ 已降级为**另立补线卡**，判据用**口径乙**。
 *
 * **`TASK-240`：两档终态表搬进 `src/types.ts`**（`DISPATCH_TERMINAL_EVENTS` + `isTerminalDispatch`），
 * 本模块的表**从它派生**，不再各写一份；`pool.ts` 的 busy 折叠也改成读同一处（`session` 档）。
 * 同时补上口径乙那个**方向正确**的会话谓词 {@link sessionIdleByFinished}（按 `dispatch/finished` 判，
 * `dispatch/aborted` 不参与），旧的口径甲谓词 {@link sessionHasNoUnsettledDispatch} 标 `@deprecated`
 * 并写明它为什么不能当空闲判定。三个读侧的改前/改后对账与两态读数在 `test/m248.test.ts`。
 */
import { textOf } from '../infra/scalar.js'
import {
  DISPATCH_ABORTED_EVENT,
  DISPATCH_REPORTED_EVENT,
  DISPATCH_TERMINAL_EVENTS,
  isTerminalDispatch,
} from '../types.js'
import type { JournalEvent, TaskCard } from '../types.js'

/**
 * **收口事件名**（写侧与读侧共用一份）：`domain/collab.ts` 的 `release` 写它，本模块判它。
 *
 * 为什么要一个常量而不是两处各写一个字符串：写侧与读侧对不上时**不会有任何报错**
 * —— 事件照写、读数照旧"未结算"，那种不一致只能在很久以后被人发现。
 * `TASK-240` 起字符串的真源搬进 `src/types.ts`（`DISPATCH_TERMINAL_EVENTS` 的 `card` 档要用它），
 * 本模块**再导出**：`domain/collab.ts` 与 `test/m247.test.ts` 的导入路径因此不用改。
 */
export { DISPATCH_ABORTED_EVENT }

/**
 * **口径甲**的终态：这一轮派发在台账里**不再悬着**了。
 *
 * `dispatch/aborted`（`TASK-237` / `DEF-224` 落点二）记的是"这一轮派发被主动放弃了"（卡的 `release`
 * 是唯一写者）。它进这张表之后，`claimMissing` 的那一行会从"不知道后来怎样了"变成"已作废、理由在此"
 * （`ended: true` + `reason`）。
 *
 * **`TASK-240`：这张表从 `src/types.ts` 派生**（`DISPATCH_TERMINAL_EVENTS` 的 `card` 档），
 * 再加一档 {@link DISPATCH_REPORTED_EVENT}。多收 `reported` 是**故意与 `card` 档不同**：
 * 它记的是"子会话把报告交回来了"—— 写者已经交差，这一轮不必再收口；`claimMissing` 与
 * `reuseDeliveries` 问"后来怎样了"时必须认它。反例见 `test/m248.test.ts` 的那一格
 * 「只有一条 dispatch/reported 的派发」。
 *
 * **诚实的边界（`REV-103` F7）：它 ≠ 噪声已消。** `claimMissing` 不按终态过滤 —— `ended` 翻真之后
 * **仍然 push 一行候选**；`office.noteClaimMissing` 也照旧把它写成 `dispatch/claim-missing` 事件，
 * 回执仍印"⇒ 视为静默失败"。真消掉这条噪声要动 `office.ts` / `index.ts` / 语言包（都不在本卡写范围）
 * ⇒ 另立卡。本卡只做"把这一轮标成已收口 + 带上理由"，**不声称更多**。
 */
const SETTLED_DISPATCH_EVENTS: readonly string[] = [...DISPATCH_TERMINAL_EVENTS.card, DISPATCH_REPORTED_EVENT]

/**
 * **口径乙**的终态表：把子会话从"忙"里释放出来的那一档 —— 就是 `session` 档
 * （`src/types.ts` 的一份真源，本模块从它派生，不再各写一份）。
 *
 * 与 `pool.ts` 的 busy 折叠**同一档**（那里也读 `session` 档）。为什么**不**含 `aborted`：
 * 收口只说明写者放弃了这张卡，会话本身可能还在跑；把它当"空闲"就会把第二张卡投给一个仍在干活的会话。
 * 为什么**不**含 `dispatch/reported`：那条只说明"交回了报告"，`pool.ts` 同样不拿它释放位子。
 */
const SESSION_FREEING_EVENTS: readonly string[] = DISPATCH_TERMINAL_EVENTS.session

/** 参与"这张卡由谁在做"时间线的全部事件（用于取**最后一条**）。 */
const TIMELINE_EVENTS: readonly string[] = [
  'task/claimed',
  'task/released',
  'task/reassigned',
  'task/dropped',
  'task/blocked',
  'dispatch/started',
  ...SETTLED_DISPATCH_EVENTS,
]

/** 卡 `in-progress`，但**拥有它的子会话已经结算** ⇒ 这把写锁没有活着的持有者。 */
export interface OrphanLock {
  taskId: string
  /** 卡上记的 owner（可能是槽位名，`DEF-066` 会把它升级成 uuid） */
  owner: string
  /** 终态事件给出的结束原因（`completed` / `error` / …） */
  reason: string
  childSessionId: string
  /** 终态事件在 journal 里的序号（**可复算锚点**） */
  atSeq: number
  /** 交接文档要求的**可执行下一步**（不替人释放，只给命令） */
  command: string
}

/** 派发已发生，但窗口内没有该卡的 `task/claimed` ⇒ **静默失败**候选。 */
export interface ClaimMissing {
  taskId: string
  childSessionId: string
  /** 那一笔 `dispatch/started` 的序号 */
  startedSeq: number
  /** 距派发已经过去多少分钟 */
  minutes: number
  /** 子会话是否已经结算（结算了 ⇒ 原因已知，更可诊断） */
  ended: boolean
  reason: string
}

/** 从事件里取它提到的卡 id（`dispatch/*` 用 `task`，`task/*` 用 `id`）。 */
function cardOf(event: JournalEvent): string {
  return textOf(event.data['task'] ?? event.data['id'] ?? event.data['taskId'] ?? '')
}

/** 按卡分组的事件时间线（journal 是追加式的，天然按 seq 有序）。 */
function timelines(events: readonly JournalEvent[]): Map<string, JournalEvent[]> {
  const byCard = new Map<string, JournalEvent[]>()
  for (const event of events) {
    if (!TIMELINE_EVENTS.includes(event.type)) continue
    const card = cardOf(event)
    if (card === '') continue
    const list = byCard.get(card) ?? []
    list.push(event)
    byCard.set(card, list)
  }
  return byCard
}

/** `sdo_task action=release id=<卡> actor=<你> reason=<理由>` —— 孤儿锁的**唯一安全出路**。 */
export function releaseCommand(taskId: string): string {
  return `sdo_task action=release id=${taskId} actor=<you> reason=<why>`
}

/**
 * **孤儿写锁**：卡 `in-progress`，而它时间线上**最后一条**相关事件是子会话终态
 * （`dispatch/finished` / `dispatch/reported`）—— 期间既没有 `task/released`，也没有再次认领。
 */
export function orphanLocks(tasks: readonly TaskCard[], events: readonly JournalEvent[]): OrphanLock[] {
  const byCard = timelines(events)
  const out: OrphanLock[] = []
  for (const task of tasks) {
    if (task.status !== 'in-progress') continue
    const timeline = byCard.get(task.id)
    const last = timeline?.at(-1)
    if (last === undefined) continue
    if (!SETTLED_DISPATCH_EVENTS.includes(last.type)) continue
    out.push({
      taskId: task.id,
      owner: textOf(task.owner ?? ''),
      reason: textOf(last.data['reason']),
      childSessionId: textOf(last.data['childSessionId']),
      atSeq: last.seq,
      command: releaseCommand(task.id),
    })
  }
  return out
}

/**
 * **派发未认领**：卡的最近一笔 `dispatch/started` 之后**没有** `task/claimed`，
 * 且距派发已超过 `windowMs`（默认 5 分钟）⇒ 视为**静默失败**（界面在跑、台账没动）。
 *
 * 只对**尚未认领**的卡成立（`planned` / `ready`）：已 `in-progress` 的卡显然认领过。
 */
export function claimMissing(
  tasks: readonly TaskCard[],
  events: readonly JournalEvent[],
  options: { nowMs?: number | undefined; windowMs?: number | undefined } = {},
): ClaimMissing[] {
  const nowMs = options.nowMs ?? Date.now()
  const windowMs = options.windowMs ?? 5 * 60_000
  const byCard = timelines(events)
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const out: ClaimMissing[] = []
  for (const [card, timeline] of byCard) {
    const task = byId.get(card)
    if (task === undefined) continue
    if (task.status !== 'planned' && task.status !== 'ready') continue
    const lastStart = [...timeline].reverse().find((event) => event.type === 'dispatch/started')
    if (lastStart === undefined) continue
    const after = timeline.filter((event) => event.seq > lastStart.seq)
    if (after.some((event) => event.type === 'task/claimed')) continue
    const startedMs = Date.parse(lastStart.at ?? '')
    const minutes = Number.isFinite(startedMs) ? Math.floor((nowMs - startedMs) / 60_000) : 0
    if (Number.isFinite(startedMs) && nowMs - startedMs < windowMs) continue
    const terminal = [...after].reverse().find((event) => SETTLED_DISPATCH_EVENTS.includes(event.type))
    out.push({
      taskId: card,
      childSessionId: textOf(lastStart.data['childSessionId']),
      startedSeq: lastStart.seq,
      minutes: Number.isFinite(startedMs) ? minutes : 0,
      ended: terminal !== undefined,
      reason: terminal === undefined ? '' : textOf(terminal.data['reason']),
    })
  }
  return out.sort((a, b) => a.startedSeq - b.startedSeq)
}

/**
 * **复用投递的消费观测**（DEF-014 / §3E 族 8）—— 「追加/复用投递的指令，子会话到底消费了没有？」
 *
 * 为什么需要它：旧实现把 `sendMessage` 的返回值**丢掉**，`dispatch/started` 只记 `reused: true`
 * ⇒「指令投出去没有」在真源里**无从查证**，而「有没有被消费」更是**完全没有观测面**
 * （`claimMissing` 只对 **planned/ready** 的卡成立 —— 源码逐字如此 —— 复用到**在飞**卡这条路它盖不到）。
 *
 * 口径（**只报观测，不报结论**）：`sendMessage` 解决只能证明**宿主受理了投递**，不能证明子会话读了、
 * 更不能证明它照做了。所以这里**现算**一个可观测的**四态**，宁说「未见消费」，不说「没消费」：
 *   · `held`       该子会话在投递**之前**就持有这张卡（追加指令给在飞会话）⇒ 不该再要求一次认领；
 *   · `claimed`    投递之后该子会话**认领了**这张卡（消费的正面证据）；
 *   · `ended`      投递之后该子会话**结算了这一轮**（至少跑过一轮）；
 *   · `no-signal`  窗口内两者都没有 —— **未见消费**（`windowMs` 内不报，避免"刚投出去"就报警）。
 *
 *（**R4**：本段与 `test/m158` 曾把这条口径写成「三态」，而类型/实现/§9 都是**四态**
 *（held / claimed / ended / no-signal）—— 行为正确、只是措辞；现已统一为四态。）
 */
export interface ReuseDelivery {
  taskId: string
  childSessionId: string
  /** 那一笔**复用投递** `dispatch/started` 的序号（可复算锚点） */
  startedSeq: number
  /** 宿主对那次投递的回执（旧事件没有这个字段 ⇒ 空串，如实说"当年的投递没有收据"） */
  messageReceipt: string
  /** 距投递已经过去多少分钟 */
  minutes: number
  state: 'held' | 'claimed' | 'ended' | 'no-signal'
}

export function reuseDeliveries(
  tasks: readonly TaskCard[],
  events: readonly JournalEvent[],
  options: { nowMs?: number | undefined; windowMs?: number | undefined } = {},
): ReuseDelivery[] {
  const nowMs = options.nowMs ?? Date.now()
  const windowMs = options.windowMs ?? 5 * 60_000
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const out: ReuseDelivery[] = []
  for (const [card, timeline] of timelines(events)) {
    if (!byId.has(card)) continue
    const lastStart = [...timeline].reverse().find((event) => event.type === 'dispatch/started')
    if (lastStart === undefined) continue
    // 只看**复用投递**：新起一个子代理没有"投给谁"的问题（投递本身即创建）
    if (lastStart.data['reused'] !== true) continue
    const child = textOf(lastStart.data['childSessionId'])
    const claimedBy = (event: JournalEvent): boolean =>
      event.type === 'task/claimed' && (child === '' || textOf(event.data['sessionId']) === child)
    const after = timeline.filter((event) => event.seq > lastStart.seq)
    const heldBefore = timeline.some((event) => event.seq < lastStart.seq && claimedBy(event))
    const claimedAfter = after.some(claimedBy)
    const endedAfter = after.some((event) => SETTLED_DISPATCH_EVENTS.includes(event.type))
    const state: ReuseDelivery['state'] = heldBefore
      ? 'held'
      : claimedAfter
        ? 'claimed'
        : endedAfter
          ? 'ended'
          : 'no-signal'
    const startedMs = Date.parse(lastStart.at ?? '')
    const minutes = Number.isFinite(startedMs) ? Math.floor((nowMs - startedMs) / 60_000) : 0
    // 窗口内没动静属正常（刚投出去）⇒ 不报；窗口外才是"未见消费"
    if (state === 'no-signal' && Number.isFinite(startedMs) && nowMs - startedMs < windowMs) continue
    out.push({
      taskId: card,
      childSessionId: child,
      startedSeq: lastStart.seq,
      messageReceipt: textOf(lastStart.data['messageReceipt']),
      minutes,
      state,
    })
  }
  return out.sort((a, b) => a.startedSeq - b.startedSeq)
}

/* ————————————————————————————————————————————————————————————————————————————————
 * **形状三 / 不变量**（`TASK-237` / `DEF-224` 落点二与落点三）
 *
 * 三个判定，**两条口径**（`REV-103` F2 之后不再混用）：
 *   · 口径甲 —— {@link unsettledDispatch}（某张卡"最后一轮派发还悬着吗"）与
 *     {@link unsettledCardsBySession} / {@link sessionHasNoUnsettledDispatch}（按会话聚合的同一件事）；
 *   · 口径乙 —— {@link doubleStartedSessions}（"同一会话在飞卡 ≤ 1"这条不变量**被违反的时刻**）。
 * ⚠️ 口径甲的两个会话谓词**不可用于"会话空闲"判定**（名字里也已经不出现了）：`dispatch/aborted`
 * 会把它们翻成"干净"，而写者放弃这张卡并不代表子会话停了。派发前检查必须用口径乙（见模块头）。
 * ———————————————————————————————————————————————————————————————————————————————— */

/** 一笔**还没结算**的派发（口径甲）：那张卡的最后一笔 `dispatch/started` 之后没有任何终态事件。 */
export interface UnsettledDispatch {
  /** 那一笔派发起时的子会话（旧事件可能没有 ⇒ 空串，如实说"不知道投给了谁"） */
  childSessionId: string
  /** 那一笔 `dispatch/started` 的序号（**可复算锚点**，收口事件也带它） */
  startedSeq: number
}

/** 口径甲的一行：某会话手上**这一轮还没收口**的卡。 */
export interface UnsettledCard {
  taskId: string
  childSessionId: string
  /** 那一笔 `dispatch/started` 的序号（可复算锚点） */
  startedSeq: number
  /** 距发起已经过去多少分钟（时间戳解析不出来时按 0 记，与既有读数同口径） */
  minutes: number
}

/** {@link unsettledCardsBySession} / {@link sessionHasNoUnsettledDispatch} 的入参。 */
export interface UnsettledOptions {
  nowMs?: number | undefined
  /** 只统计 `started` 距今不超过这个窗口的（默认 15 分钟 = `office.ts` 的 `staleTasks` 默认值）；**`<= 0` = 不按 TTL 过滤** */
  ttlMs?: number | undefined
}

/** {@link doubleStartedSessions} 的入参（口径乙）。 */
export interface OccupancyOptions {
  nowMs?: number | undefined
  /**
   * 判"违反"时的窗口：`second.started` 那一刻回头看，`first` 是否还在窗口内（默认 15 分钟；**`<= 0` = 不按 TTL 过滤**）。
   * 为什么要窗口：十小时前的老 `started` 不是**这次**派发决策的输入；`ttlMs: 0` 用来做"任何时刻"的体检。
   */
  ttlMs?: number | undefined
}

const DEFAULT_TTL_MS = 15 * 60_000

/** 口径乙的一行：某会话手上**`started` 未 `finished`** 的卡（会话仍占着位子）。 */
export interface OccupiedCard {
  taskId: string
  childSessionId: string
  /** 那一笔 `dispatch/started` 的序号（可复算锚点） */
  startedSeq: number
  /** 距发起已经过去多少分钟 */
  minutes: number
}

/** 把一个会话的在飞清单里的**结算**项摘掉（按卡 id；结算事件的 `childSessionId` 可能缺 ⇒ 全表找）。 */
function settle(
  map: Map<string, { taskId: string; childSessionId: string; startedSeq: number; startedAt: number }[]>,
  event: JournalEvent,
): void {
  const card = cardOf(event)
  const child = textOf(event.data['childSessionId'])
  const sessions = child === '' ? [...map.keys()] : [child]
  for (const key of sessions) {
    const list = map.get(key)
    if (list === undefined) continue
    const index = list.map((row) => row.taskId).lastIndexOf(card)
    if (index < 0) continue
    list.splice(index, 1)
    if (list.length === 0) map.delete(key)
    else map.set(key, list)
    return
  }
}

/**
 * 某张卡**当前是否还有未结算的派发**（口径甲；`TASK-237` 落点二的唯一判定，写侧与读侧同源）。
 *
 * 口径：按 `seq` 顺序折叠这张卡的全部派发相关事件 —— `dispatch/started` 记下"开着的那一笔"，
 * 口径甲的任一终态（{@link SETTLED_DISPATCH_EVENTS}，含 `dispatch/aborted` 自身）把它清掉。
 * **不设 TTL**：这里回答的是"这一笔要不要收口"，不是"它还算不算新鲜" ——
 * 十小时前放手、至今没结算的派发同样要收口（否则那笔 started 永远悬着）。
 */
export function unsettledDispatch(events: readonly JournalEvent[], taskId: string): UnsettledDispatch | undefined {
  let open: UnsettledDispatch | undefined
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (cardOf(event) !== taskId) continue
    if (event.type === 'dispatch/started') {
      open = { childSessionId: textOf(event.data['childSessionId']), startedSeq: event.seq }
      continue
    }
    if (SETTLED_DISPATCH_EVENTS.includes(event.type)) open = undefined
  }
  return open
}

/**
 * 按会话聚合的**口径甲**读数：每个会话手上还有哪些"这一轮没收口"的卡。
 *
 * ⚠️ **不可用于"这个会话空闲吗"**（`REV-103` F2）：`dispatch/aborted` 会把它清空，而收口只说明
 * 写者放弃了卡、**不说明子会话停了**。要看"忙不忙"用口径乙（`pool.ts` 的 busy 折叠 / 将来的补线卡）。
 * 本函数今天的用途只有一个：让"台账里还有没有悬空决定"这件事能按会话看（回执/体检），不是派发决策。
 */
export function unsettledCardsBySession(
  events: readonly JournalEvent[],
  options: UnsettledOptions = {},
): Map<string, UnsettledCard[]> {
  const nowMs = options.nowMs ?? Date.now()
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  type Open = { taskId: string; childSessionId: string; startedSeq: number; startedAt: number }
  const open = new Map<string, Open[]>()
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (SETTLED_DISPATCH_EVENTS.includes(event.type)) {
      settle(open, event)
      continue
    }
    if (event.type !== 'dispatch/started') continue
    const child = textOf(event.data['childSessionId'])
    if (child === '') continue
    const list = open.get(child) ?? []
    const card = cardOf(event)
    const row = { taskId: card, childSessionId: child, startedSeq: event.seq, startedAt: Date.parse(event.at ?? '') }
    // 同一张卡的复投（追加指令）只更新那一笔的序号，不叠第二行
    const index = list.map((item) => item.taskId).lastIndexOf(card)
    if (index >= 0) list[index] = row
    else list.push(row)
    open.set(child, list)
  }
  const map = new Map<string, UnsettledCard[]>()
  for (const [child, list] of open) {
    const alive = list.filter((row) => ttlMs <= 0 || !Number.isFinite(row.startedAt) || nowMs - row.startedAt <= ttlMs)
    if (alive.length > 0) {
      map.set(child, alive.map((row) => ({
        taskId: row.taskId,
        childSessionId: row.childSessionId,
        startedSeq: row.startedSeq,
        minutes: Number.isFinite(row.startedAt) ? Math.max(0, Math.floor((nowMs - row.startedAt) / 60_000)) : 0,
      })))
    }
  }
  return map
}

/**
 * 该会话手上有**没有收口的派发**（口径甲）。
 *
 * ⚠️ **名字里不许出现「空闲 / idle」（`REV-103` F2）**：`true` 只意味着"台账里没有悬着没交代的派发"，
 * **不**意味着"这个会话可以再派一张卡"。真机教训：`dispatch/aborted` 把这里翻成 `true` 之后，
 * 若拿它当派发前检查，就会把第二张卡投给一个仍在跑上一张卡的会话（`DEF-224` 的形态）。
 * 派发前的判据见 {@link doubleStartedSessions} 的口径乙与补线卡的说明。
 *
 * @deprecated **不可用作"会话空闲"判定**（`TASK-240`）。它建在口径甲上：`dispatch/aborted`
 * 一出栈它就翻成 `true`，而 `release` 收口一张卡**不说明会话停了** —— 拿它判空闲，就会把第二张卡
 * 投给一个仍在跑上一张卡的会话（`DEF-224` 重演）。会话空闲请用 {@link sessionIdleByFinished}
 * （按 `dispatch/finished` 判，`aborted` 不参与）；两档口径的真源是 `src/types.ts` 的
 * {@link isTerminalDispatch}。本函数保留给**只回答口径甲**的读数（回执/体检里的"还有没有悬空决定"）。
 */
export function sessionHasNoUnsettledDispatch(
  events: readonly JournalEvent[],
  childSessionId: string,
  options: UnsettledOptions = {},
): boolean {
  const id = textOf(childSessionId)
  if (id === '') return true
  return !unsettledCardsBySession(events, options).has(id)
}

/**
 * **这个子会话空闲吗** —— 按 `finished` 口径判（`TASK-240` 落点二，口径乙的会话级谓词）。
 *
 * 判据（从**台账事件**现算，不读卡上的 `owner`）：该 `sessionId` 的**最近一笔** `dispatch/started`
 * 之后还没有 `dispatch/finished` ⇒ **忙**。`dispatch/aborted` / `dispatch/reported` 都**不参与**：
 * 它们说明的是"卡不归它了 / 报告交回了"，**不**说明会话停了。
 *
 * 与 {@link sessionHasNoUnsettledDispatch} 的区别就是**口径**（那一档含 `aborted`），所以两个函数
 * 对同一份台账可以给出相反的答案 —— 那正是它存在的理由：被 `release` 收口、但仍在跑上一张卡的会话，
 * 这里判**忙**（`DEF-224` 重演的那条防线）。
 *
 * 为什么按"最近一笔"比而不是"有 `started` 且没有 `finished`"的字面实现：`sessionId` 会**复用**
 * （同一子会话接多轮卡），第一轮留下的 `finished` 会把第二轮正在跑的 `started` 洗成空闲。
 * 单轮会话下两种写法等价；`test/m248.test.ts` 三格逐格钉住（含"已 `aborted` 但未 `finished` ⇒ 忙"）。
 *
 * **接驳状态（如实写）**：本卡只交付**判据**，零生产调用点 —— 派发前"哪个候选会话空闲"的接线在
 * `office.ts` 的会话选择里，那个文件不在本卡写范围（`REV-103` 裁定 ① 已降级为补线卡）。
 */
export function sessionIdleByFinished(events: readonly JournalEvent[], childSessionId: string): boolean {
  const id = textOf(childSessionId)
  if (id === '') return true
  let lastStarted = -1
  let lastFinished = -1
  for (const event of events) {
    if (textOf(event.data['childSessionId']) !== id) continue
    if (event.type === 'dispatch/started') lastStarted = Math.max(lastStarted, event.seq)
    else if (isTerminalDispatch(event.type, 'session')) lastFinished = Math.max(lastFinished, event.seq)
  }
  return !(lastStarted >= 0 && lastStarted > lastFinished)
}

/** "同一会话在飞卡 ≤ 1"被违反的**那一刻**：两张卡同时挂在一个子会话上（口径乙）。 */
export interface DoubleStartedSession {
  childSessionId: string
  /** 先发起的那一张（判红要点名它） */
  first: OccupiedCard
  /** 后发起的那一张（它就是"派第二张卡给忙碌会话"的那一刻） */
  second: OccupiedCard
}

interface FoldResult {
  violations: DoubleStartedSession[]
}

/**
 * **口径乙**的唯一实现：`dispatch/started` 入栈、**`dispatch/finished`** 出栈。
 *
 * 为什么出栈只认 `finished`（而 `aborted` 不算）：见模块头的两条口径 —— 收口是"卡不归它了"，
 * 不是"它停了"。把 `aborted` 当出栈会让守卫对"被 release 但仍在跑的会话"瞎掉。
 * 判"违反"用**事件自己的时刻**（`second.started` 那一刻回头看 `first` 是否还在 TTL 内）：
 * 这样"十小时前的老 started + 今天的第二张卡"不会被算成违反，而"刚刚两次连派"一定算。
 */
function foldOccupancy(events: readonly JournalEvent[], options: OccupancyOptions): FoldResult {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const nowMs = options.nowMs ?? Date.now()
  type Open = { taskId: string; childSessionId: string; startedSeq: number; startedAt: number }
  const open = new Map<string, Open[]>()
  const violations: DoubleStartedSession[] = []
  const row = (item: Open): OccupiedCard => ({
    taskId: item.taskId,
    childSessionId: item.childSessionId,
    startedSeq: item.startedSeq,
    minutes: Number.isFinite(item.startedAt) ? Math.max(0, Math.floor((nowMs - item.startedAt) / 60_000)) : 0,
  })
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (SESSION_FREEING_EVENTS.includes(event.type)) {
      settle(open, event)
      continue
    }
    if (event.type !== 'dispatch/started') continue
    const child = textOf(event.data['childSessionId'])
    if (child === '') continue
    const at = Date.parse(event.at ?? '')
    const started = { taskId: cardOf(event), childSessionId: child, startedSeq: event.seq, startedAt: at }
    const previous = open.get(child) ?? []
    const live = previous.filter((item) => ttlMs <= 0 || !Number.isFinite(at) || !Number.isFinite(item.startedAt) || at - item.startedAt <= ttlMs)
    // **同一张卡的复投不是违反**：追加指令给"正握着这张卡"的会话（`reuseDeliveries` 的 `held` 那一格）
    // 只该更新那一笔的序号，不该叠出第二张"在飞卡"—— 不变量说的是"两张**卡**"，不是"两次投递"。
    const sameCard = live.findIndex((item) => item.taskId === started.taskId)
    if (sameCard >= 0) {
      live[sameCard] = started
      open.set(child, live)
      continue
    }
    if (live.length > 0) {
      const first = live[0] as Open
      violations.push({
        childSessionId: child,
        first: row(first),
        second: { taskId: started.taskId, childSessionId: child, startedSeq: event.seq, minutes: 0 },
      })
    }
    live.push(started)
    open.set(child, live)
  }
  return { violations }
}

/**
 * **不变量判定**（`TASK-237` 落点三，口径乙）：台账里任何时刻「同一 `childSessionId` 的
 * **`started` 未 `finished`** 的卡数 ≤ 1」。
 *
 * 返回每一次**违反**（空数组 = 绿）：每条点名会话 + 先发起的卡（`first`）与后派进去的卡（`second`），
 * 两张卡都带自己的 `startedSeq` —— 判红时人可以直接按序号回读台账。
 * 判据只读 `dispatch/*` 的事件顺序与时间，**不读任何措辞**，也不读卡上的 `owner` 字符串
 * （那是 `orphanLocks` 的坑，见模块头）。
 *
 * **两态**（卡面 DoD 点名）：
 *   · 红格：同会话两张卡各有 `started`、中间没有 `finished` ⇒ 一条违反（`test/m247.test.ts` 的 `M247-03`）；
 *   · 绿格：**同一会话先后**完成两张卡（先 `dispatch/finished` 再 `dispatch/started`）⇒ 无违反（`M247-04`）；
 *     同一张卡的复投（`started` 两次同一张卡）⇒ 也不算"两张卡"（`M247-09`）。
 * **已知边界**：`dispatch/reported` 不释放位子（与 `pool.ts` 同档）；`dispatch/aborted` **也不释放**
 * —— 被 release 但会话仍在跑时，守卫照旧认为它忙（这正是要的方向）。
 */
export function doubleStartedSessions(
  events: readonly JournalEvent[],
  options: OccupancyOptions = {},
): DoubleStartedSession[] {
  return foldOccupancy(events, options).violations
}
