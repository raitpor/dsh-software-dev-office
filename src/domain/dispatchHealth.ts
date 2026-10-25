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
 * {@link doubleStartedSessions} 是这条不变量的**唯一判定**；{@link inFlightCardsBySession} 给
 * "派发前先看候选会话空不空"用（候选有在飞卡 ⇒ **跳过该会话**，不是把第二张卡投进去）。
 */
import { textOf } from '../infra/scalar.js'
import type { JournalEvent, TaskCard } from '../types.js'

/**
 * **收口事件名**（写侧与读侧共用一份）：`domain/collab.ts` 的 `release` 写它，本模块判它。
 *
 * 为什么要一个常量而不是两处各写一个字符串：写侧与读侧对不上时**不会有任何报错**
 * —— 事件照写、读数照旧"未结算"，那种不一致只能在很久以后被人发现。
 */
export const DISPATCH_ABORTED_EVENT = 'dispatch/aborted'

/**
 * 子会话的**终态**事件：出现它就意味着那一轮派发已经结算。
 *
 * **`dispatch/aborted`**（`TASK-237` / `DEF-224` 落点二）：它记的是"这一轮派发被主动放弃了"
 * （卡的 `release` 是唯一写者）。为什么它必须进这张表：没有它，一次 `release` 之后那一笔
 * `dispatch/started` 在本模块的三个读数里**永远是"未结算"** —— `claimMissing` 会把它当
 * 静默失败候选一直报（噪声），`reuseDeliveries` 则永远读成"未见消费"。
 * **它不表示子会话已经死了**：会话可能还在跑，只是这张卡不归它了 —— 所以池子那侧的 busy 判据
 * （`pool.ts` 按 `dispatch/started`→终态折叠）**故意不看**这条事件，会话照旧占着位子。
 */
const TERMINAL_DISPATCH_EVENTS: readonly string[] = ['dispatch/finished', 'dispatch/reported', DISPATCH_ABORTED_EVENT]

/** 参与"这张卡由谁在做"时间线的全部事件（用于取**最后一条**）。 */
const TIMELINE_EVENTS: readonly string[] = [
  'task/claimed',
  'task/released',
  'task/reassigned',
  'task/dropped',
  'task/blocked',
  'dispatch/started',
  ...TERMINAL_DISPATCH_EVENTS,
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
    if (!TERMINAL_DISPATCH_EVENTS.includes(last.type)) continue
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
    const terminal = [...after].reverse().find((event) => TERMINAL_DISPATCH_EVENTS.includes(event.type))
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
    const endedAfter = after.some((event) => TERMINAL_DISPATCH_EVENTS.includes(event.type))
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
 * 三个纯函数，**同一个口径**（`dispatch/started` 入栈、终态出栈）：
 *   · {@link unsettledDispatch}  某张卡"最后一笔派发还没结算"没有 ⇒ 写侧（`release`）据此补收口事件；
 *   · {@link inFlightCardsBySession}  每个子会话**此刻**手里有哪些在飞卡 ⇒ 派发前"候选会话空不空"；
 *   · {@link doubleStartedSessions}  "同一会话在飞卡 ≤ 1"这条不变量**被违反的时刻**（点名会话与两张卡）。
 * ———————————————————————————————————————————————————————————————————————————————— */

/** 一笔**还没结算**的派发：那张卡的最后一笔 `dispatch/started` 之后没有任何终态事件。 */
export interface UnsettledDispatch {
  /** 那一笔派发起时的子会话（旧事件可能没有 ⇒ 空串，如实说"不知道投给了谁"） */
  childSessionId: string
  /** 那一笔 `dispatch/started` 的序号（**可复算锚点**，收口事件也带它） */
  startedSeq: number
}

/**
 * 某张卡**当前是否还有未结算的派发**（`TASK-237` 落点二的唯一判定，写侧与读侧同源）。
 *
 * 口径：按 `seq` 顺序折叠这张卡的全部派发相关事件 —— `dispatch/started` 记下"开着的那一笔"，
 * 任何终态（{@link TERMINAL_DISPATCH_EVENTS}，含 `dispatch/aborted` 自身）把它清掉。
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
    if (TERMINAL_DISPATCH_EVENTS.includes(event.type)) open = undefined
  }
  return open
}

/** 一个子会话**此刻**手里的一张在飞卡。 */
export interface InFlightCard {
  taskId: string
  childSessionId: string
  /** 那一笔 `dispatch/started` 的序号（可复算锚点） */
  startedSeq: number
  /** 距发起已经过去多少分钟（`started` 的时间戳解析不出来时按 0 记，与既有读数同口径） */
  minutes: number
}

/** {@link inFlightCardsBySession} / {@link doubleStartedSessions} 的公共入参。 */
export interface InFlightOptions {
  nowMs?: number | undefined
  /** 在飞窗口（默认 15 分钟 = `office.ts` 的 `staleTasks` 默认值）；**`<= 0` = 不按 TTL 过滤**（看全账历史） */
  ttlMs?: number | undefined
}

const DEFAULT_TTL_MS = 15 * 60_000

/** 把一个子会话的在飞清单里的**结算**项摘掉（按卡 id；结算事件的 `childSessionId` 可能缺 ⇒ 全表找）。 */
function settle(map: Map<string, { taskId: string; childSessionId: string; startedSeq: number; startedAt: number }[]>, event: JournalEvent): void {
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
 * 每个子会话**此刻**手里的在飞卡（`started` 未结算，且在 `ttlMs` 窗口内）。
 *
 * 用途（`TASK-237` 落点一）：派发前看候选会话 —— **清单非空就跳过该会话**（换一个空闲会话或新起），
 * 而不是把第二张卡投进去。返回的 `Map` 只含**非空**会话 ⇒ `map.has(id)` 就是"它在飞"。
 *
 * **诚实的边界**：本函数只给判定，**接线不在本模块** —— 真正选会话的地方在 `office.ts` 的
 * `reuseBlockedOf` 与 `pool.ts` 的 busy 折叠（两处都不在 `TASK-237` 的写范围），
 * 所以"派发器真的会跳过"这一步仍待一张补线卡（见该卡交付说明的残余项）。
 */
export function inFlightCardsBySession(
  events: readonly JournalEvent[],
  options: InFlightOptions = {},
): Map<string, InFlightCard[]> {
  return foldInFlight(events, options).map
}

/**
 * 单个候选会话是否**空闲**（没有在飞卡）—— 派发前检查的最小谓词。
 *
 * 与 {@link inFlightCardsBySession} 同一口径；抽出来是为了让调用点读起来是"No"而不是"我遍历了一遍"。
 */
export function sessionIsIdle(
  events: readonly JournalEvent[],
  childSessionId: string,
  options: InFlightOptions = {},
): boolean {
  const id = textOf(childSessionId)
  if (id === '') return true
  return !foldInFlight(events, options).map.has(id)
}

/** "同一会话在飞卡 ≤ 1"被违反的**那一刻**：两张卡同时挂在一个子会话上。 */
export interface DoubleStartedSession {
  childSessionId: string
  /** 先发起的那一张（判红要点名它） */
  first: InFlightCard
  /** 后发起的那一张（它就是"派第二张卡给忙碌会话"的那一刻） */
  second: InFlightCard
}

interface FoldResult {
  map: Map<string, InFlightCard[]>
  violations: DoubleStartedSession[]
}

/**
 * 折叠口径的**唯一实现**：`dispatch/started` 入栈、终态出栈。
 *
 * 两处 TTL 用的是**两个不同时刻**，这是有意的：
 *   · 判"违反"时用**事件自己的时刻**（`second.started` 那一刻，`first` 是否已经 stale）——
 *     这样"十小时前的老 started + 今天的第二张卡"不会被算成违反，而"刚刚两次连派"一定算；
 *   · 判"此刻在飞"时用 `nowMs` —— 回答的是"现在这个会话忙不忙"。
 * 代价如实写在这里：TTL 之外的"历史重叠"不报（那已经不是派发决策的输入，只是旧账）。
 */
function foldInFlight(events: readonly JournalEvent[], options: InFlightOptions): FoldResult {
  const nowMs = options.nowMs ?? Date.now()
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  type Open = { taskId: string; childSessionId: string; startedSeq: number; startedAt: number }
  const open = new Map<string, Open[]>()
  const violations: DoubleStartedSession[] = []
  const card = (row: Open): InFlightCard => ({
    taskId: row.taskId,
    childSessionId: row.childSessionId,
    startedSeq: row.startedSeq,
    minutes: Number.isFinite(row.startedAt) ? Math.max(0, Math.floor((nowMs - row.startedAt) / 60_000)) : 0,
  })
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (TERMINAL_DISPATCH_EVENTS.includes(event.type)) {
      settle(open, event)
      continue
    }
    if (event.type !== 'dispatch/started') continue
    const child = textOf(event.data['childSessionId'])
    if (child === '') continue
    const at = Date.parse(event.at ?? '')
    const started = { taskId: cardOf(event), childSessionId: child, startedSeq: event.seq, startedAt: at }
    const previous = open.get(child) ?? []
    const live = previous.filter((row) => ttlMs <= 0 || !Number.isFinite(at) || !Number.isFinite(row.startedAt) || at - row.startedAt <= ttlMs)
    // **同一张卡的复投不是违反**：追加指令给"正握着这张卡"的会话（`reuseDeliveries` 的 `held` 那一格）
    // 只该更新那一笔的序号，不该叠出第二张"在飞卡"—— 不变量说的是"两张**卡**"，不是"两次投递"。
    const sameCard = live.findIndex((row) => row.taskId === started.taskId)
    if (sameCard >= 0) {
      live[sameCard] = started
      open.set(child, live)
      continue
    }
    if (live.length > 0) {
      const first = live[0] as Open
      violations.push({
        childSessionId: child,
        first: card(first),
        second: { taskId: started.taskId, childSessionId: child, startedSeq: event.seq, minutes: 0 },
      })
    }
    live.push(started)
    open.set(child, live)
  }
  // 此刻在飞：按 `nowMs` 再剪一次 TTL（清掉"已经很久没动静"的那些，它们不再是派发决策的输入）
  const map = new Map<string, InFlightCard[]>()
  for (const [child, list] of open) {
    const alive = list.filter((row) => ttlMs <= 0 || !Number.isFinite(row.startedAt) || nowMs - row.startedAt <= ttlMs)
    if (alive.length > 0) map.set(child, alive.map(card))
  }
  return { map, violations }
}

/**
 * **不变量判定**（`TASK-237` 落点三）：台账里任何时刻「同一 `childSessionId` 的 started 未结算卡数 ≤ 1」。
 *
 * 返回每一次**违反**（空数组 = 绿）：每条点名会话 + 先发起的卡（`first`）与后派进去的卡（`second`），
 * 两张卡都带自己的 `startedSeq` —— 判红时人可以直接按序号回读台账。
 *
 * 判据只读 `dispatch/*` 的事件顺序与时间，**不读任何措辞**，也不读卡上的 `owner` 字符串
 * （那是 `orphanLocks` 的坑，见模块头）。
 *
 * **反例格**（同一会话**先后**完成两张卡：先 `dispatch/finished` 再 `dispatch/started`）必须绿 ——
 * 终态先把第一张摘掉，第二次 `started` 时清单已空，因此不产生违反；`test/m247.test.ts` 钉住这一格。
 */
export function doubleStartedSessions(
  events: readonly JournalEvent[],
  options: InFlightOptions = {},
): DoubleStartedSession[] {
  return foldInFlight(events, options).violations
}
