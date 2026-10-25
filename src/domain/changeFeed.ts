/**
 * **变更增量推送**（`TASK-186`：可观测性②）—— 「自上次我读到以来，变了什么？」
 *
 * ## 这个模块解决的是什么
 *
 * 修前子代理交付后，**没有任何工具主动说「变了什么」**：它的报告是自由文本，驾驶舱只能信或不信；
 * 想知道「自上次读到以来变了什么」，只能自己把 184 张卡重扫一遍再复算。本模块把这件事变成一次
 * **按端点取的增量**：调用方给出「上次读到的指针」，回执逐条一行列出那之后**卡状态**的变化。
 *
 * ## 三条口径（都不是风格问题，是可判定的）
 *
 *   ① **真源是 journal 事件，不是投影**：读数只从 `journal.jsonl` 的事件流折出来，
 *      **不读** `project.json`（派生视图，可重建、也可与真源不一致），也不读 `.sdo/tasks/*.yml`
 *      （手可编辑）。守卫用"把 `project.json` 改成一个谎"来证明这一点（`test/m225.test.ts`）。
 *   ② **指针由调用方给，工具不猜起点**：没有 `since` ⇒ **可读拒绝**（不是"默认从 0 开始"——
 *      那样每次都会把整本台账当增量倒给人）。两种形态都收：`seq`（journal 序号）与 ISO 时间
 *      （折算成"该时刻之前（含）的最后一个 seq"，见 {@link parseSince}）。
 *   ③ **状态变化与内容修改分开报**：`task/updated` / `task/errata` 只改内容（DoD、写范围、勘误…），
 *      **不产生状态迁移** ⇒ 它们绝不进 {@link ChangeFeed.changes}，只进单独的一栏
 *      {@link ChangeFeed.contentEdits}。否则「改了一次 DoD」会把「卡认领/交付」淹掉。
 *
 * ## 为什么行文是 ASCII 结构化 + 一份本地标签表
 *
 * 与 `domain/snapshot.ts` 同一处置（那里是 `TASK-185` 的先例，理由逐字相同）：本卡写范围不含
 * `src/data/lang/*.yml`，而 `src/index.ts` 被 i18n 棘轮钉在「零硬编码中文」，另有一条既有守卫
 * （`en` 语言下回执必须零中文）。因此：
 *   · **数据行**（`id` / `from->to` / `owner` / `at` / `event` / `seq`）是**语言中立 ASCII**
 *     —— 判据与话术不会各改一处，换语言也不改判定；
 *   · **标签**（栏目名、空读数那句话）走 {@link ZH} / {@link EN} 两份本地表，按 `locale()` 取；
 *   · 首行**永远是 ASCII 读数**（`changes since=… head=… changed=N …`），于是"有没有变化"这件事
 *     不依赖任何自然语言就能判（守卫②正是这么断言的）。
 * 迁移面（把标签搬进语言包）见交付说明的跟卡建议——**不是**这里不做，是本卡写不到那些文件。
 */
import { locale } from './i18n.js'
import { textOf } from '../infra/scalar.js'
import { DISPATCH_REPORTED_EVENT, DISPATCH_TERMINAL_EVENTS } from '../types.js'
import type { JournalEvent } from '../types.js'

/**
 * 子会话的**终态**事件：出现在某笔派发之后 ⇒ 那笔派发已结算。
 *
 * `TASK-240` 起这张表从 `src/types.ts` 派生（`DISPATCH_TERMINAL_EVENTS` 的 `card` 档 =
 * `dispatch/finished` + `dispatch/aborted`），再加一档 {@link DISPATCH_REPORTED_EVENT}。
 *
 * **改后与改前的两处差别，都是对账过的事实**：
 *   · 多收 `aborted`：修前它**没有**在这张表里，靠 `unsettledDispatches` 另一条判据
 *     （同一张卡的 `task/released` / `task/dropped`）顺带盖住 —— 而 `release` 是 `aborted` 在本仓
 *     的写者、同一笔里还会落 `task/released`，所以现盘读数不变；差别只在"只有 `aborted`、没有
 *     `task/released`"的台账（合成夹具里能造出来），修后它与 `dispatchHealth.ts` 的口径一致。
 *   · `reported` **故意与 `card` 档不同**：它记的是"子会话把报告交回来了"，写者已经交差，本轮不该
 *     再当"未结算"报一遍。两处（本文件与 `dispatchHealth.ts`）都多收它，反例见 `test/m248.test.ts`。
 */
const TERMINAL_DISPATCH_EVENTS: readonly string[] = [...DISPATCH_TERMINAL_EVENTS.card, DISPATCH_REPORTED_EVENT]

/** 调用方给的起点（原样回声 + 折算后的 seq，便于核对"工具没猜起点"）。 */
export interface ChangeFeedQuery {
  /** 调用方给的原值（`190` 或 `2026-10-24T01:00:00.000Z`） */
  raw: string
  /** 形态：`seq` = journal 序号；`at` = ISO 时间（已折算成 seq） */
  kind: 'seq' | 'at'
  /** 折算后的下限：**只报 `seq > this` 的事件** */
  seq: number
}

/** 一条**卡状态迁移**（逐条一行）。 */
export interface CardChange {
  id: string
  /** 迁移前状态；`''` = 本台账里第一次出现（**不编造前态**，行文印 `none`） */
  from: string
  /** 迁移后状态 */
  to: string
  /** 迁移后卡上的 owner（事件里没记 ⇒ `''`，行文印 `-`） */
  owner: string
  /** 事件时刻（**真源里那一刻**，不是读的时刻） */
  at: string
  /** 触发这次迁移的事件类型（`task/claimed` 一类） */
  event: string
  /** 该事件的 journal 序号（**可复算锚点**） */
  seq: number
}

/** 一笔**本轮未结算的派发**（`dispatch/started` 之后没有终态、也没有被 release/drop）。 */
export interface UnsettledDispatch {
  taskId: string
  childSessionId: string
  at: string
  seq: number
}

/** 一条**证据缺失的 done**（`task/done` 事件自己记的 `evidence` 条数为 0）。 */
export interface DoneWithoutEvidence {
  taskId: string
  owner: string
  at: string
  seq: number
}

/** 一栏**内容修改**（不是状态迁移；单独一栏，不与 {@link ChangeFeed.changes} 混）。 */
export interface ContentEdit {
  id: string
  /** 窗口内这类事件的条数 */
  count: number
  /** 涉及的字段名（`task/updated.fields` 的并集；`task/errata` 记为 `errata`） */
  fields: string[]
}

/** 一份增量读数。 */
export interface ChangeFeed {
  query: ChangeFeedQuery
  /** 现盘 journal 的最大 seq（`0` = 台账为空） */
  headSeq: number
  /** 扫过的事件条数（可复算：与 `journal.read().events.length` 相等） */
  scanned: number
  /** **真源被截断**（journal 有坏行，读到最后一个一致前缀）—— 念出来，别让读者以为是全量 */
  truncated: boolean
  /** 状态迁移（**seq 升序**） */
  changes: CardChange[]
  /** 本轮未结算的派发（**seq 升序**） */
  unsettled: UnsettledDispatch[]
  /** 证据缺失的 done（**seq 升序**） */
  unevidenced: DoneWithoutEvidence[]
  /** 内容修改（单独一栏：**不是**状态变化） */
  contentEdits: ContentEdit[]
}

/** {@link parseSince} 的结果：要么给出起点，要么给出**可读拒绝**。 */
export type SinceParse = { ok: true; since: ChangeFeedQuery } | { ok: false; detail: string }

/** 一段读数的组装结果（`office.changeFeed` 的返回形状）。 */
export type ChangeFeedResult = { ok: true; feed: ChangeFeed } | { ok: false; detail: string }

/* ———————————————————————————————— 标签（两种语言各一份） ———————————————————————————————— */

interface FeedLabels {
  /** 首行的空读数句（只在 `changed=0` 时追加） */
  noChanges: (seq: number) => string
  changes: (count: number) => string
  unsettled: (count: number) => string
  unsettledNone: string
  unevidenced: (count: number) => string
  unevidencedNone: string
  content: (count: number) => string
  contentNone: string
  truncated: string
  /** 没有给指针 */
  missingSince: string
  /** 指针给了但认不出 */
  badSince: (raw: string) => string
}

const ZH: FeedLabels = {
  noChanges: (seq) => `seq ${String(seq)} 之后没有卡改过状态（无变化）。`,
  changes: (count) => `卡状态变化 ${String(count)} 条（seq 升序）：`,
  unsettled: (count) => `本轮未结算的派发 ${String(count)}：`,
  unsettledNone: '本轮未结算的派发 0：无',
  unevidenced: (count) => `证据缺失的 done ${String(count)}：`,
  unevidencedNone: '证据缺失的 done 0：无',
  content: (count) => `内容修改（非状态变化，单独一栏）${String(count)}：`,
  contentNone: '内容修改（非状态变化，单独一栏）0',
  truncated: '⚠️ 真源被截断（journal 有坏行）：本读数只到最后一致前缀，之后的事件不在里面。',
  missingSince: '必须给出起点：`since=<journal seq>`（如 `since=190`）或 `since=<ISO 时间>`（如 `since=2026-10-24T01:00:00.000Z`）。'
    + '工具**不替你猜起点** —— 猜出来的增量是假的。',
  badSince: (raw) => `认不出起点 \`${raw}\`：只收 \`since=<journal 序号>\`（非负整数，如 \`since=190\`）或 \`since=<ISO 时间>\`（如 \`since=2026-10-24T01:00:00.000Z\`）。`,
}

const EN: FeedLabels = {
  noChanges: (seq) => `no changes: no card changed status after seq ${String(seq)}.`,
  changes: (count) => `card status changes (${String(count)}, seq ascending):`,
  unsettled: (count) => `unsettled dispatches this round (${String(count)}):`,
  unsettledNone: 'unsettled dispatches this round: 0 (none)',
  unevidenced: (count) => `done without evidence (${String(count)}):`,
  unevidencedNone: 'done without evidence: 0 (none)',
  content: (count) => `content edits (NOT status changes, separate section) (${String(count)}):`,
  contentNone: 'content edits (NOT status changes, separate section): 0',
  truncated: 'WARNING: the source of truth is truncated (bad line in journal): this reading stops at the last consistent prefix.',
  missingSince: 'a start pointer is required: `since=<journal seq>` (e.g. `since=190`) or `since=<ISO time>` (e.g. `since=2026-10-24T01:00:00.000Z`).'
    + ' The tool does NOT guess the start: a guessed increment is a fake one.',
  badSince: (raw) => `cannot read the start pointer \`${raw}\`: only \`since=<journal seq>\` (non-negative integer, e.g. \`since=190\`) or \`since=<ISO time>\` (e.g. \`since=2026-10-24T01:00:00.000Z\`) is accepted.`,
}

/** 取当前语言的标签表（`en` 之外一律按基准语言渲染 —— 与 `locale()` 的回落口径一致）。 */
function labels(): FeedLabels {
  return locale() === 'en' ? EN : ZH
}

/* ———————————————————————————————— 起点解析 ———————————————————————————————— */

/**
 * **把调用方给的指针折成 seq 下限**（`TASK-186` 口径②：工具不猜起点）。
 *
 * 三种输入三态，**没有第四种**：
 *   · 非负整数 ⇒ `kind='seq'`，原样当下限；
 *   · 能被 `Date.parse` 认出的时间 ⇒ `kind='at'`，折成"该时刻**之前（含）**的最后一个 seq"
 *     （一条都不早于它 ⇒ `0`；此时 `seq > 0` 的**全部**事件都是增量，这是"从最开始读"的如实含义）；
 *   · 其它（空串 / 负数 / 小数 / 胡写）⇒ **可读拒绝**，绝不退回默认值。
 *
 * ⚠️ 未来时刻/未来 seq **不是错误**：它只是"没有增量"（守卫②），由 {@link buildChangeFeed} 让
 * `changes` 为空、由 {@link renderChangeFeed} 明说"无变化"。
 */
export function parseSince(events: readonly JournalEvent[], raw: string | undefined): SinceParse {
  const label = labels()
  if (raw === undefined || raw.trim() === '') return { ok: false, detail: label.missingSince }
  const text = raw.trim()
  if (/^\d+$/u.test(text)) {
    const seq = Number(text)
    if (Number.isSafeInteger(seq)) return { ok: true, since: { raw: text, kind: 'seq', seq } }
  }
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return { ok: false, detail: label.badSince(text) }
  let seq = 0
  for (const event of events) {
    const at = Date.parse(event.at)
    if (Number.isFinite(at) && at <= ms && event.seq > seq) seq = event.seq
  }
  return { ok: true, since: { raw: text, kind: 'at', seq } }
}

/* ———————————————————————————————— 折叠：journal → 增量 ———————————————————————————————— */

/** 事件提到的那张卡（`task/*` 用 `id`，`dispatch/*` 用 `task`/`taskId`）。 */
function cardOf(event: JournalEvent): string {
  return textOf(event.data['id'] ?? event.data['task'] ?? event.data['taskId'] ?? '').trim()
}

/** 事件提到的子会话。 */
function childOf(event: JournalEvent): string {
  return textOf(event.data['childSessionId'] ?? '').trim()
}

/**
 * **状态迁移表**（唯一实现）：一条事件若改变卡状态，就给出**迁移后**的 status；否则 `undefined`。
 *
 * 逐条都有出处，且**只认真正改 status 的那几条**（`collab.ts` / `plan.ts` 里的 append 点）：
 *   · `task/created`         → `planned`（`createTask` 落盘时就是 `planned`）
 *   · `task/claimed`         → `in-progress`
 *   · `task/released`        → `ready`，**但** `reassign` 也落 `task/released`（带 `reassignedTo`）
 *                             并显式保持 `in-progress` ⇒ 那条**不是**状态迁移（只换 owner）
 *   · `task/blocked` / `task/claim-blocked` → `blocked`（后者是无主卡的记账，状态同样是 blocked）
 *   · `task/unblocked`       → `ready`
 *   · `task/done`            → `done`
 *   · `task/dropped`         → `dropped`
 *   · `task/reopened`        → 事件里的 `to`（缺省 `in-progress`，与 `reopenTask` 同口径）
 *   · `task/restored`        → 事件里的 `to`（缺省 `ready`，与 `restoreTask` 的兜底同口径）
 * 其余（`task/updated` / `task/errata` / `task/claim-rejected` / `dispatch/*` / …）**不迁移状态**。
 */
function transitionOf(event: JournalEvent): string | undefined {
  switch (event.type) {
    case 'task/created':
      return 'planned'
    case 'task/claimed':
      return 'in-progress'
    case 'task/released':
      return textOf(event.data['reassignedTo'] ?? '').trim() === '' ? 'ready' : undefined
    case 'task/blocked':
    case 'task/claim-blocked':
      return 'blocked'
    case 'task/unblocked':
      return 'ready'
    case 'task/done':
      return 'done'
    case 'task/dropped':
      return 'dropped'
    case 'task/reopened': {
      const to = textOf(event.data['to'] ?? '').trim()
      return to === '' ? 'in-progress' : to
    }
    case 'task/restored': {
      const to = textOf(event.data['to'] ?? '').trim()
      return to === '' ? 'ready' : to
    }
    default:
      return undefined
  }
}

/**
 * 迁移后卡上的 owner（**只取事件自己记的**，读不到就是 `''`）。
 *
 * `task/released` / `task/unblocked` / `task/dropped` 的语义就是"这张卡此刻**没有** owner"
 * （`task/unblocked` 把 owner 清掉、`task/dropped` 同理）⇒ 它们一律 `''`，**不**把 `previousOwner`
 * 当成现 owner（那正是"读出一张早就没人的卡还有 owner"的经典假读数）。
 */
function ownerAfter(event: JournalEvent): string {
  switch (event.type) {
    case 'task/released':
    case 'task/unblocked':
    case 'task/dropped':
      return ''
    default:
      return textOf(event.data['owner'] ?? event.data['by'] ?? '').trim()
  }
}

/** 按 seq 升序（journal 本就升序；这里显式排一次，免得调用方塞进来的是别处的视图）。 */
function bySeq(events: readonly JournalEvent[]): JournalEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq)
}

/**
 * **卡状态迁移**（`since` 之后逐条一条，**seq 升序**）。
 *
 * 折叠**从第一条事件开始**（不是从 `since` 开始）：`since` 之前的迁移是"迁移前状态"的唯一来源，
 * 少了它，增量里每条都会印成 `none->in-progress` 那种半截读数。**只输出** `seq > since` 的部分。
 *
 * 同状态的重放（例如 release 后又 release）不算迁移 ⇒ 不报（否则噪声淹没有效信息）。
 */
export function cardStatusChanges(events: readonly JournalEvent[], since = 0): CardChange[] {
  const status = new Map<string, string>()
  const out: CardChange[] = []
  for (const event of bySeq(events)) {
    const to = transitionOf(event)
    if (to === undefined) continue
    const id = cardOf(event)
    if (id === '') continue
    const from = status.get(id) ?? ''
    status.set(id, to)
    if (from === to) continue
    if (event.seq <= since) continue
    out.push({ id, from, to, owner: ownerAfter(event), at: event.at, event: event.type, seq: event.seq })
  }
  return out
}

/**
 * **本轮未结算的派发**：`since` 之后起始的 `dispatch/started`，之后**既没有**终态事件
 * （`dispatch/finished` / `dispatch/reported`，按子会话 id 对），**也没有**被人工结算
 * （该卡的 `task/released` / `task/dropped`）。
 *
 * 为什么"被 release/drop 也算结算"：那是孤儿锁的**合法出路**（真源纪律：失联 owner 不自动释放，
 * 由操作者显式 `release`）—— 走了那条路还继续报"未结算"就是把已处置的事重新报一遍。
 */
export function unsettledDispatches(events: readonly JournalEvent[], since = 0): UnsettledDispatch[] {
  const ordered = bySeq(events)
  const out: UnsettledDispatch[] = []
  for (const event of ordered) {
    if (event.type !== 'dispatch/started') continue
    if (event.seq <= since) continue
    const card = cardOf(event)
    const child = childOf(event)
    const settled = ordered.some((later) => {
      if (later.seq <= event.seq) return false
      if (TERMINAL_DISPATCH_EVENTS.includes(later.type)) {
        // 子会话比对：两边都有 id 才比（缺 id 的那一侧**不构成"已结算"证据** —— 宁可多报，不可漏报）
        const laterChild = childOf(later)
        return child !== '' && laterChild === child
      }
      if (later.type === 'task/released' || later.type === 'task/dropped') return card !== '' && cardOf(later) === card
      return false
    })
    if (settled) continue
    out.push({ taskId: card, childSessionId: child, at: event.at, seq: event.seq })
  }
  return out
}

/** 子会话比对见 {@link unsettledDispatches} 内联注释（缺 id 的一侧不构成结算证据）。 */

/**
 * **证据缺失的 done**：`since` 之后的 `task/done` 事件里 `evidence` 条数为 0 的那些。
 *
 * 只认事件自己记的 `evidence`（`collab.ts` 里写的是 `evidence.length`）：**没有这个键就不报**
 * ——"读不出"与"是 0"是两回事，把老事件的"没记"当成"缺证据"就是编造。
 */
export function doneWithoutEvidence(events: readonly JournalEvent[], since = 0): DoneWithoutEvidence[] {
  const out: DoneWithoutEvidence[] = []
  for (const event of bySeq(events)) {
    if (event.type !== 'task/done') continue
    if (event.seq <= since) continue
    const raw = event.data['evidence']
    if (raw === undefined) continue
    const count = Number(raw)
    if (!Number.isFinite(count) || count > 0) continue
    out.push({
      taskId: cardOf(event),
      owner: textOf(event.data['owner'] ?? '').trim(),
      at: event.at,
      seq: event.seq,
    })
  }
  return out
}

/**
 * **内容修改**（单独一栏）：`task/updated` 与 `task/errata` —— 它们**不改状态**，但"改了什么"
 * 也是驾驶舱要看的（`TASK-186` 口径③：两栏分开报，别让改 DoD 淹掉认领/交付）。
 *
 * 按卡聚合（不逐事件列）：`count` 是窗口内条数，`fields` 是 `task/updated` 声明字段的并集
 * （`task/errata` 记 `errata`）。
 */
export function contentEdits(events: readonly JournalEvent[], since = 0): ContentEdit[] {
  const rows = new Map<string, { count: number; fields: Set<string> }>()
  for (const event of bySeq(events)) {
    if (event.type !== 'task/updated' && event.type !== 'task/errata') continue
    if (event.seq <= since) continue
    const id = cardOf(event)
    if (id === '') continue
    const row = rows.get(id) ?? { count: 0, fields: new Set<string>() }
    row.count += 1
    if (event.type === 'task/errata') row.fields.add('errata')
    else {
      const fields = event.data['fields']
      if (Array.isArray(fields)) for (const field of fields) row.fields.add(textOf(field).trim())
      else {
        const added = event.data['added']
        if (Array.isArray(added)) row.fields.add('writeScopes')
      }
    }
    rows.set(id, row)
  }
  return [...rows.entries()].map(([id, row]) => ({
    id,
    count: row.count,
    fields: [...row.fields].filter((field) => field !== '').sort(),
  }))
}

/** 台账头部 seq（空台账 ⇒ `0`）。 */
export function headSeqOf(events: readonly JournalEvent[]): number {
  let head = 0
  for (const event of events) if (event.seq > head) head = event.seq
  return head
}

/**
 * **从一次 journal 读取折出增量**（`office.changeFeed` 的唯一实现）。
 *
 * `since` 缺失 ⇒ 可读拒绝（口径②）；未来指针 ⇒ 空的 `changes`（守卫②，**不是**错误）；
 * 真源截断 ⇒ `truncated: true` 并在行文里念出来（别让读者把"读到最后一个一致前缀"当全量）。
 */
export function changeFeedOf(
  read: { events: readonly JournalEvent[]; truncated?: boolean | undefined },
  sinceRaw: string | undefined,
): ChangeFeedResult {
  const parsed = parseSince(read.events, sinceRaw)
  if (!parsed.ok) return parsed
  const since = parsed.since.seq
  return {
    ok: true,
    feed: {
      query: parsed.since,
      headSeq: headSeqOf(read.events),
      scanned: read.events.length,
      truncated: read.truncated === true,
      changes: cardStatusChanges(read.events, since),
      unsettled: unsettledDispatches(read.events, since),
      unevidenced: doneWithoutEvidence(read.events, since),
      contentEdits: contentEdits(read.events, since),
    },
  }
}

/* ———————————————————————————————— 渲染 ———————————————————————————————— */

/** 一条迁移的**数据行**（语言中立 ASCII：`- TASK-181 planned->in-progress owner=… at=… event=… seq=…`）。 */
function changeLine(change: CardChange): string {
  const from = change.from === '' ? 'none' : change.from
  const owner = change.owner === '' ? '-' : change.owner
  return `- ${change.id} ${from}->${change.to} owner=${owner} at=${change.at} event=${change.event} seq=${String(change.seq)}`
}

/**
 * **渲染一份增量读数**。
 *
 * 首行**永远是 ASCII 的结构化读数**：`changes since=<形态>:<原值> at-seq=<下限> head=<最大 seq>
 * scanned=<扫过条数> changed=<状态变化条数> unsettled=<未结算派发笔数> unevidenced=<证据缺失 done 数>
 * content=<内容修改条数>`。于是"有没有变化"不依赖任何自然语言（`changed=0` 就是没有）。
 *
 * 之后依次是四栏：卡状态变化（逐条一行，seq 升序）/ 本轮未结算的派发 / 证据缺失的 done /
 * 内容修改（**单独一栏**，明确标注"不是状态变化"）。`changed=0` 时追加一句**的人话**"无变化"
 * （中英各一份，见 {@link ZH} / {@link EN}）。
 */
export function renderChangeFeed(feed: ChangeFeed): string {
  const label = labels()
  const query = feed.query
  const lines = [
    `changes since=${query.kind}:${query.raw} at-seq=${String(query.seq)} head=${String(feed.headSeq)}`
    + ` scanned=${String(feed.scanned)} changed=${String(feed.changes.length)}`
    + ` unsettled=${String(feed.unsettled.length)} unevidenced=${String(feed.unevidenced.length)}`
    + ` content=${String(feed.contentEdits.length)}`,
  ]
  if (feed.truncated) lines.push(label.truncated)
  if (feed.changes.length === 0) lines.push(label.noChanges(query.seq))
  else {
    lines.push(label.changes(feed.changes.length))
    for (const change of feed.changes) lines.push(changeLine(change))
  }
  if (feed.unsettled.length === 0) lines.push(label.unsettledNone)
  else {
    lines.push(label.unsettled(feed.unsettled.length))
    for (const row of feed.unsettled) {
      lines.push(`- ${row.taskId === '' ? '-' : row.taskId} child=${row.childSessionId === '' ? '-' : row.childSessionId}`
        + ` at=${row.at} event=dispatch/started seq=${String(row.seq)}`)
    }
  }
  if (feed.unevidenced.length === 0) lines.push(label.unevidencedNone)
  else {
    lines.push(label.unevidenced(feed.unevidenced.length))
    for (const row of feed.unevidenced) {
      lines.push(`- ${row.taskId} owner=${row.owner === '' ? '-' : row.owner} at=${row.at}`
        + ` event=task/done evidence=0 seq=${String(row.seq)}`)
    }
  }
  if (feed.contentEdits.length === 0) lines.push(label.contentNone)
  else {
    lines.push(label.content(feed.contentEdits.length))
    for (const row of feed.contentEdits) {
      const fields = row.fields.length === 0 ? '' : ` fields=${row.fields.join(',')}`
      lines.push(`- ${row.id} edits=${String(row.count)}${fields}`)
    }
  }
  return lines.join('\n')
}
