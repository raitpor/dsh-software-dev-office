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
 */
import { textOf } from '../infra/scalar.js'
import type { JournalEvent, TaskCard } from '../types.js'

/** 子会话的**终态**事件：出现它就意味着那个 owner 会话已经结束。 */
const TERMINAL_DISPATCH_EVENTS: readonly string[] = ['dispatch/finished', 'dispatch/reported']

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
