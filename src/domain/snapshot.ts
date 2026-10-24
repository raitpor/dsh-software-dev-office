/**
 * **驾驶舱的权威状态快照 + 派发队列的有序全表**（`TASK-185`：可观测性①）。
 *
 * ## 这个模块解决的是什么
 *
 * 修前驾驶舱回答"在飞几张 / 本轮交付了啥 / 下一张派谁 / 谁挡着谁"，只能读 `.sdo/tasks/*.yml`
 * 加记忆再复算 —— 真机上因此**说错话**（"183/184 的成果已生效"）且**无法自检**；派发顺序更是只能猜
 * （`DEF-174`：实测第 1/3/6 次派发都是 `medium` 先于 `small`，回执从来没打印过有序全表）。
 *
 * 两件成品：
 *   ① {@link renderStatusSnapshot} —— 一份**固定五行**、总体积钉在 {@link SNAPSHOT_CHAR_BUDGET} 以内的快照；
 *   ② {@link renderQueueTable} —— 本轮候选的**完整有序全表**，每行带规模秩与"这条为什么没进队列"。
 *
 * ## 为什么读数在这里拼、在这里渲染
 *
 * 纯函数层（本模块）只做**格式化**：读数由 `office.poolPlan` 一次算好后交给 {@link queueEntriesOf}
 * 分类 —— 快照、`sdo_status` 与 `sdo_plan action=next` 的回执读的是**同一份** {@link QueueEntry}，
 * 因此三处不可能各说一套（本仓"读数与决策同源"的一贯口径，见 `DEF-139` / `DEF-185`）。
 *
 * ## 两种行文，两个消费者（i18n 是硬约束，不是风格）
 *
 *   · {@link renderQueueTable} —— 进 `sdo_plan action=next` 的回执。`src/index.ts` 被 i18n 棘轮钉在
 *     "零硬编码中文"，而**语言包文件不在本卡写范围**（`src/data/lang/*.yml`），并且有一条既有守卫
 *     （`en` 语言下 `next` 的回执必须零中文）⇒ 这张表**只能是语言中立的 ASCII 投影**：
 *     `TASK-184 small(1) developer -> dispatch`。与 `domain/pool.ts` 的 `poolReadingLine` 先例同口径
 *     （那里也是"给复验者的读数"，不是给终端用户的散文）。
 *   · {@link renderStatusSnapshot} —— 进 `sdo_status`。它要给人**一眼读懂**，所以有中文标签；
 *     标签表在 {@link ZH} / {@link EN} 里按语言各一份（`en` 侧不含汉字 ⇒ 切到 en 不会漏出中文）。
 *     **没有走语言包**的原因如实交代：本卡写范围不含 `src/data/lang/*.yml`；同一类处置在 `collab.ts`
 *     的完成点评审拒绝文案里已有先例。迁移面见交付说明里的跟卡建议。
 */
import { locale } from './i18n.js'
import type { TaskCard } from '../types.js'

import { sizeRankOf } from './plan.js'

/**
 * **快照的字符预算**（`TASK-185` 落点一，钉成可测阈值）。
 *
 * 为什么必须有这条：`DEF-175` 的病根就是"读数面没有上限"，一份 22748 字符的 `next` 回执被宿主截到
 * 8000，**派发结论（派了谁/为什么/谁被挡）正好落在截断之外**。快照是"第一眼要看到的五件事"，
 * 所以它必须是**有界**的：超出这个预算就是设计错了（要么砍行数，要么砍字段），不是"再长一点也没关系"。
 */
export const SNAPSHOT_CHAR_BUDGET = 4000

/**
 * **派发排序键的登记名**（`TASK-185` / `DEF-174`）：写进 `dispatch/decided` 的 `orderBasis`。
 *
 * 它不是"当前顺序"，而是"当时用哪把键"的**名字** —— 键一改，历史读数的解释方式跟着改，
 * 不必考古（`DEF-174` 的复现难点正是"当时用哪把键"在台账上不可见）。
 * 具体取值与理由见 `plan.ts` 的 `compareDispatchOrder`（唯一实现）。
 */
export const ORDER_BASIS_LABEL = 'sizeRank->lastDispatched->id'

/** 快照里"前 N 张"的缺省 N（有界读数的旋钮，不在调用点各写一个数字）。 */
export const SNAPSHOT_QUEUE_ROWS = 8

/** 快照里"阻塞项"的缺省条数。 */
export const SNAPSHOT_BLOCKED_ROWS = 6

/**
 * 快照里"在飞子会话心跳"的缺省条数（`DEF-177` 的另一半）。
 *
 * 为什么也要有上限：一份读数按子会话数线性长，就会重演 `DEF-175` —— 别的东西被挤出截断之外。
 */
export const SNAPSHOT_HEARTBEAT_ROWS = 4

/**
 * 快照里**易变行**的字形标记（心跳行以它起首）。
 *
 * 为什么要有这个标记：快照的确定性守卫（"同一台账两次快照除时间戳外逐字节相同"）必须能**机械地**
 * 把易变行剔掉 —— 靠"第二行"这种位置约定会被任何一次插行悄悄改掉判定（守卫变绿而不再守着东西）。
 * 判据集中在 {@link isVolatileSnapshotLine} 一处，渲染与守卫读同一个函数。
 */
export const SNAPSHOT_HEARTBEAT_MARK = '⏱'

/** `next` 回执里有序全表的缺省行数（完整列表的硬上限；超出时如实印"另有 N 张"）。 */
export const QUEUE_TABLE_ROWS = 24

/**
 * 一张卡**这一轮为什么不在待派名单里** —— 分类取值（`TASK-185` 落点二）。
 *
 * 这些码是**结构面**（ASCII）：分类由 `office.ts` 现算，回执按码印行、快照按码给标签
 * ⇒ 判据与话术不会各改一处，也不会因为换语言而改变判定。
 */
export type QueueVerdict =
  /** 本轮准入通过（会真的派出去） */
  | 'dispatch'
  /** 通过准入但被排队（含池满/预算满之外的一切"没取到"） */
  | 'queued'
  /** `blockedBy` 里还有未完成的卡 */
  | 'blockedBy'
  /** 卡状态本身就是 `blocked`（要 `unblock` 或 `drop`，不是等） */
  | 'task-blocked'
  /** 写范围与在飞卡相交且**必须串行**（独占窗口 / 写范围无法判定） */
  | 'write-scope'
  /** 同一独占窗口组里已经有一张占了位（先到先得） */
  | 'exclusive'
  /** 被未结算的派发冻着（子会话还活着或没超 TTL） */
  | 'frozen'
  /** 写范围压在未提交的被跟踪改动上 */
  | 'dirty-scope'
  /** 全局并行预算已满 */
  | 'capacity'
  /** 角色池满 */
  | 'pool-full'
  /** 当前阶段入口门禁的签字已失效（一张都不派） */
  | 'gate-stale'

/** 队列里的一行（**不可变**读数；行的顺序就是派发顺序）。 */
export interface QueueEntry {
  id: string
  role: string
  /** 规模档位原文；缺失时是空串（秩仍给出兜底值，见 `sizeRankOf`） */
  size: string
  /** 规模秩：`trivial` 0 / `small` 1 / `medium` 2 / `large` 3 / 未知 4 */
  rank: number
  /** 在这张表里的位次（**从 1 起**，即派发顺序的第几位） */
  position: number
  verdict: QueueVerdict
  /**
   * **结构化的"谁挡着谁"**（ASCII：卡 id / 路径 / `role=developer` 这类读数）。
   *
   * 回执只印这一栏 —— 于是 `en` 语言下的回执里不会混进中文（守卫在 `test/m105.test.ts`）。
   */
  refs: string[]
  /** **人读补充**（可含中文；只进快照的中文行，`en` 侧用 `refs` 代替） */
  detail: string
}

/** 构造队列全表的**输入**（全部由 `office.poolPlan` 的同一份读数填，见模块注释）。 */
export interface QueueBuildInput {
  /** 候选卡：`planned` / `ready` 全部，**已按唯一键排好序**（`candidateQueue` 的结果） */
  candidates: readonly TaskCard[]
  /** 本轮真的会派出去的卡 id（`admission.dispatch` 的顺序） */
  admitted: readonly string[]
  /** 准入给出的排队结论（卡 id → 原因码 + 结构化读数 + 人读细节） */
  blocked: readonly { taskId: string; reason: 'capacity' | 'pool-full'; detail: string; refs: string[] }[]
  /** 被未结算派发冻着（卡 id → 结构化读数 + 人读细节） */
  frozen: ReadonlyMap<string, { refs: string[]; detail: string }>
  /** 依赖未满足（卡 id → 等谁） */
  waiting: ReadonlyMap<string, readonly string[]>
  /** 串行写范围（卡 id → 结构化读数 + 人读细节） */
  serialScope: ReadonlyMap<string, { refs: string[]; detail: string }>
  /** 脏工作树拦截（卡 id → 结构化读数 + 人读细节） */
  dirtyScope: ReadonlyMap<string, { refs: string[]; detail: string }>
  /** 独占窗口同组的落选者（卡 id → 结构化读数 + 人读细节） */
  exclusive: ReadonlyMap<string, { refs: string[]; detail: string }>
  /** 入口门禁失效的读数（非空 ⇒ 整表判 `gate-stale`） */
  gateStale: { gate: string; reason: string } | undefined
}

/** 非候选但快照要单列的卡：状态就是 `blocked` 的那些（要 `unblock`/`drop`，与"等依赖"不同）。 */
export interface SnapshotBlockedTask {
  id: string
  role: string
  size: string
  reason: string
}

/** 在飞的一张卡（`TASK-185` 落点一 ①；`DEF-177` 的"活没活着"至少要有耗时读数）。 */
export interface SnapshotFlying {
  id: string
  role: string
  owner: string
  /**
   * 这笔派发已经过去多少分钟。
   *
   * **`undefined` = 读不出**（没有可解析的 `dispatch/started`）—— 必须与"0 分钟"分开：
   * 把"读不出"印成"刚派"就是一次假读数（本卡要治的正是这一类）。
   */
  minutes: number | undefined
  /** 已超过孤儿 TTL（子会话可能早就没了，卡却还 `in-progress`）—— 回执要点名，别让人以为还活着 */
  stale: boolean
  /** 子会话前 8 位（定位"到底是谁在做"，`DEF-066` 同一口径）；未知时空串 */
  child: string
}

/** 本轮已交付的一张卡（`TASK-185` 落点一 ②）。 */
export interface SnapshotDelivered {
  id: string
  /** 合并提交的**短哈希**（`worktree/merged.commit` 的前 8 位）；没有合并记录时是空串 */
  commit: string
}

/**
 * **心跳读数**（`DEF-177` 的另一半）：被派发的子代理"还活着还是卡住了"，在工具面上要能答。
 *
 * 三个字段全是**台账里已有的时刻**（不新写任何事件 —— 快照是**只读**读数，写心跳就会让"同一台账
 * 两次快照逐字节相同"这条守卫失效）。相对量（"距今 N 分钟"）由渲染器按快照自己的 `at` 现算，
 * 于是 `statusSnapshot` 本身仍是 `now` 的纯函数。
 */
export interface SnapshotHeartbeat {
  /** **台账最近落笔**：`journal.jsonl` 最后一条事件的时刻与序号（读不出 ⇒ `undefined`，不猜） */
  ledger: { at: string; seq: number } | undefined
  /** **最近一次派发观测**（`dispatch/observed`）：子代理最近一次"还在发请求"的心跳；一条都没有 ⇒ `undefined` */
  observed: { at: string; child: string } | undefined
  /** **在飞子会话各自的最近一次观测**（前 8 位 → 时刻）；没观测过的**不给项**（不伪造"刚观测到"） */
  children: readonly { child: string; at: string | undefined }[]
}

/** 状态快照（**结构化**；渲染见 {@link renderStatusSnapshot}）。 */
export interface StatusSnapshot {
  /** 取这份读数的时刻（**唯一**随时间变化的部分 —— 同一台账两次快照除它之外逐字节相同） */
  at: string
  /** 当前迭代号（没有迭代 ⇒ `undefined`） */
  iteration: number | undefined
  /** ① 在飞 */
  flying: readonly SnapshotFlying[]
  /** ② 本轮已交付（按完成时间倒序，最多的 N 张；全量条数见 `deliveredTotal`） */
  delivered: readonly SnapshotDelivered[]
  deliveredTotal: number
  /** ③ 有序全表的**表头读数**（含被挡的卡：渲染只取前 N 行） */
  queue: readonly QueueEntry[]
  /** ④ 下一张会派谁（= 准入首位；一张都派不出去时是 `undefined`） */
  next: string | undefined
  /** ⑤ 阻塞项：队列里非 `dispatch`/`queued` 的行 */
  blocked: readonly QueueEntry[]
  /** 卡状态就是 `blocked` 的那些（单列，不与"等依赖"混） */
  taskBlocked: readonly SnapshotBlockedTask[]
  /**
   * **⑥ 心跳**（`DEF-177` 的另一半；可选是因为老调用点构造快照时可能还没有这份读数 ——
   * 缺了就是缺了，渲染会如实说"读不出"，不会编一个出来）。
   */
  heartbeat?: SnapshotHeartbeat | undefined
  /** 计数 */
  counts: { inFlight: number; ready: number; planned: number; done: number; blocked: number }
}

/** 一个"挡路者"的结构化读数 + 人读细节（两栏同生同死，避免回执与快照各说一半）。 */
interface BlockerRead {
  refs: string[]
  detail: string
}

/**
 * **分类**：把"候选卡 + 准入读数"折成有序全表（`TASK-185` 落点二）。
 *
 * 判据**互斥且优先级固定**：门禁失效 > 被冻着 > 依赖 > 串行写范围 > 脏工作树 > 独占组 > 准入结论。
 * 前几条是"再等也不会好"或"必须先处置"，后面的才是"这一轮没排上" —— 与 `classifyNonDispatchable`
 * 的处置紧急度同序（那里是 blocked/scope/dependencies 三档，这里加上派发面独有的事实）。
 *
 * ⚠️ **`admitted` 优先于任何猜测**：一张卡只要在 `admission.dispatch` 里，它的结论就是 `dispatch`
 * —— 分类绝不允许与"真被派出去"分叉（否则又回到 `DEF-174` 那种"回执说 A、派的是 B"）。
 */
export function queueEntriesOf(input: QueueBuildInput): QueueEntry[] {
  const admitted = new Set(input.admitted)
  const blockedOf = new Map(input.blocked.map((row) => [row.taskId, row]))
  const rows: QueueEntry[] = []
  for (const task of input.candidates) {
    const id = task.id
    const verdict: QueueVerdict = ((): QueueVerdict => {
      if (input.gateStale !== undefined) return 'gate-stale'
      if (input.frozen.has(id)) return 'frozen'
      if (input.waiting.has(id)) return 'blockedBy'
      if (input.serialScope.has(id)) return 'write-scope'
      if (input.dirtyScope.has(id)) return 'dirty-scope'
      if (input.exclusive.has(id)) return 'exclusive'
      if (admitted.has(id)) return 'dispatch'
      const queuedRow = blockedOf.get(id)
      if (queuedRow !== undefined) return queuedRow.reason
      // 走到这里说明"既没准入、也没有任何一条已知原因" —— 如实标成 `queued`（不是"没事"）。
      // 这条分支的存在本身就是读数：真出现它，说明准入面多了一条没人记录的闸门。
      return 'queued'
    })()
    const blocker = blockerOf(verdict, id, input)
    rows.push({
      id,
      role: task.role,
      size: task.size,
      rank: sizeRankOf(task),
      position: rows.length + 1,
      verdict,
      refs: blocker.refs,
      detail: blocker.detail,
    })
  }
  return rows
}

/** 每种结论的**结构化读数 + 人读细节**（查不到就回落到空，绝不编造）。 */
function blockerOf(verdict: QueueVerdict, id: string, input: QueueBuildInput): BlockerRead {
  const empty: BlockerRead = { refs: [], detail: '' }
  switch (verdict) {
    case 'gate-stale':
      return input.gateStale === undefined
        ? empty
        : { refs: [`gate=${input.gateStale.gate}`], detail: input.gateStale.reason }
    case 'frozen':
      return input.frozen.get(id) ?? empty
    case 'write-scope':
      return input.serialScope.get(id) ?? empty
    case 'dirty-scope':
      return input.dirtyScope.get(id) ?? empty
    case 'exclusive':
      return input.exclusive.get(id) ?? empty
    case 'blockedBy': {
      const waiting = input.waiting.get(id) ?? []
      return { refs: [...waiting], detail: waiting.join(' ') }
    }
    case 'capacity':
    case 'pool-full': {
      const row = input.blocked.find((item) => item.taskId === id)
      return row === undefined ? empty : { refs: [...row.refs], detail: row.detail }
    }
    case 'dispatch':
    case 'queued':
    case 'task-blocked':
      return empty
  }
}

/* ———————————————————————————————— 语言中立的回执行 ———————————————————————————————— */

/**
 * **排序键的短写**（`TASK-184 small(1)`）—— 回执里每张候选卡都带它，秩值不许省。
 *
 * ASCII：进台账（`dispatch/decided.candidates`）也进回执，两处同形。
 */
export function orderKeyLabel(entry: QueueEntry): string {
  const size = entry.size === '' ? '?' : entry.size
  return `${entry.id} ${size}(${String(entry.rank)})`
}

/**
 * **"这一张为什么被选中"**的登记行（`TASK-185` / `DEF-174` 的 `dispatch/decided.selectedWhy`）。
 *
 * ASCII：台账是跨版本 append-only 的，读数不该随语言包变（同 `poolReadingLine` 的口径）。
 */
export function selectedWhyLabel(position: number, admitted: number): string {
  return `candidate#${String(position)} of ${String(admitted)} admitted`
}

/** 一行的 ASCII 投影：` 1. TASK-184 small(1) developer -> dispatch [refs]`。 */
function queueRowLine(entry: QueueEntry): string {
  const refs = entry.refs.length === 0 ? '' : ` [${entry.refs.join(' ')}]`
  return `  ${String(entry.position)}. ${orderKeyLabel(entry)} ${entry.role} -> ${entry.verdict}${refs}`
}

/**
 * **本轮候选的完整有序全表**（`sdo_plan action=next` 的回执用）。
 *
 * 一行一卡：位次 + 排序键 + 角色 + **结论码**（+ 结构化的挡路者）。超过 `max` 行时**如实印出**
 * "另有 N 张"（不许只报数量、也不许悄悄截断 —— 后者会让"我的卡去哪了"重新变成猜）。
 *
 * 行文是**语言中立 ASCII**（理由见模块注释：`en` 语言下回执必须零中文）。
 */
export function renderQueueTable(entries: readonly QueueEntry[], options: { max?: number | undefined } = {}): string {
  const max = Math.max(1, Math.floor(options.max ?? QUEUE_TABLE_ROWS))
  const shown = entries.slice(0, max)
  const lines = [
    `dispatch queue (ordered, ${String(entries.length)} cards; key=${ORDER_BASIS_LABEL})`,
    ...shown.map((entry) => queueRowLine(entry)),
  ]
  if (entries.length > shown.length) {
    lines.push(`  ... ${String(entries.length - shown.length)} more not shown (cap ${String(max)}; full list: .sdo/tasks/*.yml)`)
  }
  return lines.join('\n')
}

/* ———————————————————————————————— 快照（固定五行） ———————————————————————————————— */

/** 快照的行文标签：**两种语言各一份**（不走语言包，理由见模块注释）。 */
interface SnapshotLabels {
  flying: string
  delivered: string
  queue: string
  next: string
  blocked: string
  none: string
  deliveredNone: string
  queueNone: string
  nextNoneIdle: string
  nextNoneBlocked: string
  blockNone: string
  merged: string
  justDispatched: string
  minutes: string
  staleMinutes: string
  unknownMinutes: string
  more: string
  sizeLine: string
  /** ⑥ 心跳（`DEF-177`）：易变行的标签与三段相对量 */
  heartbeat: string
  ledgerAgo: string
  ledgerNone: string
  observedAgo: string
  observedNone: string
  childQuiet: string
  childNoSignal: string
  justNow: string
  /** 结论码 → 人读短语 */
  verdicts: Record<QueueVerdict, string>
  /** "为什么是它"的三条理由 */
  whyRank: (rank: number, size: string) => string
  whySameRank: (n: number) => string
  whyOnlyOne: string
  whyAdmitted: string
}

const ZH: SnapshotLabels = {
  flying: '在飞',
  delivered: '本轮已交付',
  queue: 'ready 队列（有序，键=规模秩→最近派发→id）',
  next: '下一张',
  blocked: '阻塞',
  none: '无',
  deliveredNone: '本轮已交付 0',
  queueNone: 'ready 队列 0 张',
  unknownMinutes: '派发时间读不出',
  nextNoneIdle: '下一张：无（候选池为空）',
  nextNoneBlocked: '下一张：无（有阻塞项挡在前面，见阻塞行）',
  blockNone: '阻塞 0',
  merged: '无合并记录',
  justDispatched: '刚派',
  minutes: '已 %N 分钟',
  staleMinutes: '已 %N 分钟（超孤儿 TTL %M）',
  more: '另有 %N 张',
  sizeLine: '体积 %N/%M 字符',
  heartbeat: '心跳',
  ledgerAgo: '台账最近落笔 %N 分钟前（seq=%M）',
  ledgerNone: '台账最近落笔：读不出（台账为空）',
  observedAgo: '最近派发观测 %N 分钟前',
  observedNone: '最近派发观测：无（还没有一次工具面观测落账）',
  childQuiet: '在飞 %N 已静 %M 分钟',
  childNoSignal: '在飞 %N 从未观测到（只有派发那一刻）',
  justNow: '刚刚',
  verdicts: {
    dispatch: '派发',
    queued: '排队（这一轮没取到）',
    blockedBy: '依赖未满足',
    'task-blocked': '卡状态 blocked（要 unblock 或 drop）',
    'write-scope': '写范围串行',
    exclusive: '独占窗口同组已被占',
    frozen: '被未结算的派发冻着',
    'dirty-scope': '写范围压在未提交改动上',
    capacity: '容量：全局并行预算已满',
    'pool-full': '容量：角色池满',
    'gate-stale': '入口门禁签字失效',
  },
  whyRank: (rank, size) => `规模秩 ${String(rank)}（${size === '' ? '未知' : size}）`,
  whySameRank: (n) => `同档里排最前（同档共 ${String(n)} 张）`,
  whyOnlyOne: '同档里只有它',
  whyAdmitted: '通过准入（无闸门挡路）',
}

const EN: SnapshotLabels = {
  flying: 'in-flight',
  delivered: 'delivered this iteration',
  queue: 'ready queue (ordered; key=sizeRank->lastDispatched->id)',
  next: 'next',
  blocked: 'blocked',
  none: 'none',
  deliveredNone: 'delivered this iteration: 0',
  queueNone: 'ready queue: 0 cards',
  unknownMinutes: 'dispatch time unreadable',
  nextNoneIdle: 'next: none (empty candidate pool)',
  nextNoneBlocked: 'next: none (blockers in the way, see the blocked line)',
  blockNone: 'blocked 0',
  merged: 'no-merge-record',
  justDispatched: 'just dispatched',
  minutes: '%N min elapsed',
  staleMinutes: '%N min elapsed (past orphan TTL %M)',
  more: '%N more',
  sizeLine: 'size %N/%M chars',
  heartbeat: 'heartbeat',
  ledgerAgo: 'last ledger write %N min ago (seq=%M)',
  ledgerNone: 'last ledger write: unreadable (empty ledger)',
  observedAgo: 'last dispatch observation %N min ago',
  observedNone: 'last dispatch observation: none yet',
  childQuiet: 'in-flight %N quiet for %M min',
  childNoSignal: 'in-flight %N never observed (dispatch moment only)',
  justNow: 'just now',
  verdicts: {
    dispatch: 'dispatch',
    queued: 'queued (not taken this round)',
    blockedBy: 'dependencies unmet',
    'task-blocked': 'card status blocked (unblock or drop)',
    'write-scope': 'write scope serialized',
    exclusive: 'exclusive window already taken',
    frozen: 'held by an unsettled dispatch',
    'dirty-scope': 'write scope over uncommitted changes',
    capacity: 'capacity: global budget full',
    'pool-full': 'capacity: role pool full',
    'gate-stale': 'entry gate signature stale',
  },
  whyRank: (rank, size) => `sizeRank ${String(rank)} (${size === '' ? 'unknown' : size})`,
  whySameRank: (n) => `first among its rank (${String(n)} in this rank)`,
  whyOnlyOne: 'only card in its rank',
  whyAdmitted: 'admitted (no gate in the way)',
}

/** 取当前语言的标签表（`en` 之外一律按基准语言中文渲染 —— 与 `locale()` 的回落口径一致）。 */
function labels(): SnapshotLabels {
  return locale() === 'en' ? EN : ZH
}

/** 标签里唯一的占位替换（`%N` / `%M`），避免为一个字符串引入整套 `fmt`。 */
function fill(template: string, values: readonly string[]): string {
  let out = template
  const marks = ['%N', '%M']
  for (const [index, mark] of marks.entries()) out = out.split(mark).join(values[index] ?? '')
  return out
}

/** 结论 → **给人看的短语**（快照用；回执用 ASCII 的结论码 —— 两处读同一字段）。 */
function verdictText(entry: QueueEntry, label: SnapshotLabels): string {
  const base = label.verdicts[entry.verdict]
  const refs = entry.refs.length === 0 ? '' : `（${entry.refs.join(' ')}）`
  return `${base}${refs}`
}

/** ②的渲染：`TASK-183(2ef357c)`，超过 `max` 张时补一句"另有 N 张"。 */
function deliveredLine(snapshot: StatusSnapshot, label: SnapshotLabels, max = 5): string {
  if (snapshot.delivered.length === 0) {
    return snapshot.deliveredTotal === 0
      ? label.deliveredNone
      : `${label.delivered} ${String(snapshot.deliveredTotal)}`
  }
  const shown = snapshot.delivered.slice(0, max)
  const items = shown.map((item) => `${item.id}(${item.commit === '' ? label.merged : item.commit})`)
  const more = snapshot.deliveredTotal > shown.length
    ? `；${fill(label.more, [String(snapshot.deliveredTotal - shown.length)])}`
    : ''
  return `${label.delivered} ${String(snapshot.deliveredTotal)}：${items.join(' ')}${more}`
}

/** ③的渲染：有序前 N 张（**带秩值**）+ 一行"另有 N 张"。 */
function queueLine(snapshot: StatusSnapshot, label: SnapshotLabels, max = SNAPSHOT_QUEUE_ROWS): string {
  if (snapshot.queue.length === 0) return label.queueNone
  const shown = snapshot.queue.slice(0, max)
  const items = shown.map((entry) => `${String(entry.position)} ${orderKeyLabel(entry)}`)
  const more = snapshot.queue.length > shown.length
    ? ` …${fill(label.more, [String(snapshot.queue.length - shown.length)])}`
    : ''
  return `${label.queue}，共 ${String(snapshot.queue.length)} 张：${items.join('｜')}${more}`
}

/** ④的渲染：下一张是谁 + **为什么是它**。 */
function nextLine(snapshot: StatusSnapshot, label: SnapshotLabels): string {
  if (snapshot.next === undefined) {
    return snapshot.blocked.length === 0 ? label.nextNoneIdle : label.nextNoneBlocked
  }
  const head = snapshot.queue.find((entry) => entry.id === snapshot.next)
  if (head === undefined) return `${label.next}：${snapshot.next}`
  const sameRank = snapshot.queue.filter((entry) => entry.rank === head.rank && entry.verdict === 'dispatch')
  const reasons = [
    label.whyRank(head.rank, head.size),
    sameRank.length > 1 ? label.whySameRank(sameRank.length) : label.whyOnlyOne,
    head.verdict === 'dispatch' ? label.whyAdmitted : verdictText(head, label),
  ]
  return `${label.next}：${snapshot.next} —— ${reasons.join('、')}`
}

/** ⑤的渲染：阻塞项**逐条点名**（哪个挡哪个）。 */
function blockedLine(snapshot: StatusSnapshot, label: SnapshotLabels, max = SNAPSHOT_BLOCKED_ROWS): string {
  const rows = [
    ...snapshot.blocked.map((entry) => `${entry.id} ← ${verdictText(entry, label)}`),
    ...snapshot.taskBlocked.map((item) => `${item.id} ← ${label.verdicts['task-blocked']}（${item.reason === '' ? label.none : item.reason}）`),
  ]
  if (rows.length === 0) return label.blockNone
  const shown = rows.slice(0, max)
  const more = rows.length > shown.length ? `；${fill(label.more, [String(rows.length - shown.length)])}` : ''
  return `${label.blocked} ${String(rows.length)}：${shown.join('；')}${more}`
}

/** ①的渲染：`TASK-185 developer/developer-c38f64e2（已 37 分钟，c38f64e2）`。 */
function flyingLine(snapshot: StatusSnapshot, label: SnapshotLabels, ttlMinutes = 0): string {
  if (snapshot.flying.length === 0) return `${label.flying} 0`
  const elapsed = (item: SnapshotFlying): string => {
    if (item.minutes === undefined) return label.unknownMinutes
    if (item.minutes <= 0) return label.justDispatched
    return item.stale
      ? fill(label.staleMinutes, [String(item.minutes), String(ttlMinutes)])
      : fill(label.minutes, [String(item.minutes)])
  }
  const items = snapshot.flying.map((item) =>
    `${item.id} ${item.role}/${item.owner === '' ? '-' : item.owner}`
    + `（${elapsed(item)}${item.child === '' ? '' : `，${item.child}`}）`)
  return `${label.flying} ${String(snapshot.flying.length)}：${items.join('；')}`
}

/**
 * **⑥ 心跳**（`DEF-177` 的另一半）：台账最近落笔 / 最近派发观测 / 在飞子会话各自的静默时长。
 *
 * 三条纪律：
 *   ① **只读**：读数全部来自台账已有事件，快照不写任何事件（否则"同一台账两次快照逐字节相同"失效）；
 *   ② **相对量**：所有时刻都换算成"距今 N 分钟"（按快照自己的 `at` 现算），未来时刻夹到 0 并写"刚刚"；
 *   ③ **它自己就是一条易变行**：本行以 {@link SNAPSHOT_HEARTBEAT_MARK} 起首，确定性守卫按
 *      {@link isVolatileSnapshotLine} 把它与时间戳行一并剔除 —— 剥离后剩下的才是必须逐字节相同的正文。
 */
function heartbeatLine(snapshot: StatusSnapshot, label: SnapshotLabels): string {
  const beat = snapshot.heartbeat
  const nowMs = Date.parse(snapshot.at)
  const ago = (at: string | undefined): number | undefined => {
    if (at === undefined || at === '') return undefined
    const parsed = Date.parse(at)
    return Number.isFinite(parsed) && Number.isFinite(nowMs) ? Math.max(0, Math.round((nowMs - parsed) / 60_000)) : undefined
  }
  const parts: string[] = []
  if (beat?.ledger === undefined) {
    parts.push(label.ledgerNone)
  } else {
    const minutes = ago(beat.ledger.at)
    parts.push(minutes === undefined
      ? label.ledgerNone
      : fill(label.ledgerAgo, [minutes <= 0 ? label.justNow : String(minutes), String(beat.ledger.seq)]))
  }
  if (beat?.observed === undefined) {
    parts.push(label.observedNone)
  } else {
    const minutes = ago(beat.observed.at)
    parts.push(minutes === undefined
      ? label.observedNone
      : fill(label.observedAgo, [minutes <= 0 ? label.justNow : String(minutes)]))
  }
  const children = (beat?.children ?? []).slice(0, SNAPSHOT_HEARTBEAT_ROWS).map((item) => {
    const minutes = ago(item.at)
    return minutes === undefined
      ? fill(label.childNoSignal, [item.child])
      : fill(label.childQuiet, [item.child, minutes <= 0 ? label.justNow : String(minutes)])
  })
  const folded = (beat?.children ?? []).length - children.length
  if (folded > 0) children.push(fill(label.more, [String(folded)]))
  if (children.length > 0) parts.push(children.join('；'))
  // 本行**自带时间戳**：它既是"这份心跳读数是什么时候取的"，也保证同一台账的两次快照在这一行上
  // 必然不同（确定性守卫的**反空转**断言靠它 —— 剔除易变行之后若还能读出"完全相同"就是判据写错了）。
  return `${SNAPSHOT_HEARTBEAT_MARK} ${label.heartbeat} at=${snapshot.at}｜${parts.join('｜')}`
}

/**
 * **这一行是不是易变行**（快照确定性守卫的唯一判据）。
 *
 * 两类：时间戳行（`snapshot …at=`）与 ⑥ 心跳行（以 {@link SNAPSHOT_HEARTBEAT_MARK} 起首）。
 * 渲染与守卫读**同一个函数** ⇒ 任何人把心跳换个位置、换个标记，守卫立刻跟着变（不会静默失效）。
 */
export function isVolatileSnapshotLine(line: string): boolean {
  return line.startsWith('snapshot ') || line.startsWith(SNAPSHOT_HEARTBEAT_MARK)
}

/**
 * **渲染整份快照**（固定行：①在飞 ②已交付 ③有序队列 ④下一张 ⑤阻塞 + 一行体积读数）。
 *
 * 纪律：**只有时间戳行与 ⑥ 心跳行是易变的**（两者都由 {@link isVolatileSnapshotLine} 认出来）——
 * 于是"同一台账两次快照除易变行外逐字节相同"是可断言的（守卫见 `test/m224.test.ts` 的 M224-S4）。
 * 体积行只算**正文**（不含时间戳行，也**不含**心跳行）：它是"这份读数有没有超出预算"的自证，
 * 必须与取数时刻无关 —— 否则同一份台账的两次读数会给出两个体积。
 */
export function renderStatusSnapshot(
  snapshot: StatusSnapshot,
  options: { orphanTtlMinutes?: number | undefined } = {},
): string {
  const label = labels()
  const body = [
    `① ${flyingLine(snapshot, label, options.orphanTtlMinutes ?? 0)}`,
    `② ${deliveredLine(snapshot, label)}`,
    `③ ${queueLine(snapshot, label)}`,
    `④ ${nextLine(snapshot, label)}`,
    `⑤ ${blockedLine(snapshot, label)}`,
  ]
  const header = `snapshot${snapshot.iteration === undefined ? '' : ` iteration=#${String(snapshot.iteration)}`} at=${snapshot.at}`
  const beat = heartbeatLine(snapshot, label)
  // 体积读数**只算正文**：它是"这份读数有没有超出预算"的自证，必须与时间戳无关。
  const bodyText = body.join('\n')
  return [
    header,
    beat,
    bodyText,
    fill(label.sizeLine, [String(bodyText.length), String(SNAPSHOT_CHAR_BUDGET)]),
  ].join('\n')
}
