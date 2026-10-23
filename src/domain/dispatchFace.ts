/**
 * **派发子代理工具面的观测**（评审 2026-10-03 §4.2）：把"宿主有没有真的收窄工具面"从**断言**变成**观察**。
 *
 * 背景：真机实测里我们带着 `toolFilter` 派发出的子代理**仍然看得见并调用**掩码外的工具（B6 钩子兜底拦下）。
 * 插件的回执因此**不能**替宿主保证"它看不到"；但子代理自己每次开新请求都会公告 `request/header`，
 * 里面带**它实际拿到的工具清单** —— SDO 监听该事件、只对**自己派发出去的子会话**记账，
 * 于是"是否收窄"变成可核对的事实（而不是谁说一句）。
 *
 * 记账只写文件（append-only），不改任何真源判定。
 */
import { existsSync } from 'node:fs'

import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { PoolReading } from './pool.js'

export const CHILD_FACE_SEGMENTS = ['evidence', 'child-tools.jsonl'] as const

export interface ChildFaceEntry {
  /** 子会话 id（== `dispatch/started` 里的 childSessionId）。 */
  childSessionId: string
  at: string
  /**
   * **公告面**：它这次请求拿到（被公告）的工具名（去重、排序）。
   * 只记 `request/header` 那种"完整清单"的条目；`tool/call` 条目这里留空。
   */
  tools: string[]
  /** 公告面里**不在**该角色掩码内的工具（真机那例子是 `[]` —— 公告清单确实被收窄了）。 */
  violations: string[]
  /**
   * **执行面**：本会话里**实际发起**过的、落在掩码之外的调用（工具名，可含重复累积）。
   *
   * 为什么必须分开记（评审 2026-10-03 第二轮 Finding 1）：真机子会话的公告面**只有掩码内 9 个**，
   * 但它仍然**调用**了 `sdo_plan`/`sdo_review`/`sdo_gate`（宿主把未公告工具的调用也路由进了工具层，
   * 只有钩子拦得住）。只看公告面会给这种会话判"全部在掩码内"—— 正是我们一直在防的假绿。
   */
  calls?: string[] | undefined
  /**
   * **执行面的次数**：本会话里落在掩码外的**调用次数**（`calls` 是去重后的工具名，两者口径不同）。
   * 文案必须与口径一致：写「N 次」就得是次数（评审第三轮 B）。
   */
  callCount?: number | undefined
}

/** 记一条观测（append-only）。 */
/**
 * **声明的工具面 vs 宿主实际给的面**（SDO-53：公告清单 ≠ 实际可调）。
 *
 * 真机上两个方向都出现过：**公告多于实际**（子代理自报 10 个，同一派发公告 12 个）与
 * **掩码外仍可调**（靠 B6 钩子兜底拦下）。这里不做猜测，只把差集摆出来：
 * `missing` = 我们声明了、子代理却没拿到（能力静默缺失，`read_image` 那次就是）；`extra` = 子代理拿到了
 * 我们没声明的（收窄没生效，安全面）。
 */
export function faceDiff(declared: readonly string[], observed: readonly string[]): { missing: string[]; extra: string[] } {
  const want = new Set(declared)
  const have = new Set(observed)
  return {
    missing: [...want].filter((name) => !have.has(name)).sort(),
    extra: [...have].filter((name) => !want.has(name)).sort(),
  }
}

export function recordChildFace(store: SdoStore, entry: Omit<ChildFaceEntry, 'at'> & { at?: string | undefined }): ChildFaceEntry {
  const full: ChildFaceEntry = { ...entry, at: entry.at ?? new Date().toISOString() }
  store.appendLine([...CHILD_FACE_SEGMENTS], JSON.stringify(full) + '\n')
  return full
}

/* —————————————————————— 观测**落事件**（DEF-165 ① / TASK-172） —————————————————————— */

/**
 * **一次观测在台账里的形状**（`dispatch/observed` 的读侧投影）。
 *
 * 为什么除了文件还要一条事件：R-1「该子会话被**观测到**手里有工具才允许复用」的证据如果只活在
 * `evidence/child-tools.jsonl` 里，那它就是**台账外的一份文件** —— 数不出"哪一次派发被观测到什么面"，
 * 也无法在回执里**引用**（`DEF-165` ① 的真机读数：journal 里含 `observ` 的事件类型计数＝0，
 * 于是复用判据对每个新子会话都只能说"没有证据"，每张卡都新起）。
 *
 * **字段面（先定窄、留扩展位）**：`childSessionId` / `toolCount` / `deniedOutsideCount` / `observedAt`
 * 四件是判定与回执共用的最小集；扩展只许**新增可选字段**，不许改这四个的语义（`M213-09` 的教训）。
 */
export interface ChildObservation {
  childSessionId: string
  /** **被公告的工具数**（`request/header` 里那份清单的长度；`tool/call` 观测记 0） */
  toolCount: number
  /** **掩码外的调用次数**（`tool/call` 判成越界时累加；观测面事件记 0） */
  deniedOutsideCount: number
  observedAt: string
  /** 该子会话**最近一条**观测事件的序号 —— 回执引用"依据哪条观测"就用它 */
  seq: number
}

/**
 * 记一条观测**事件**（append-only）。与 {@link recordChildFace} 是同一件事的两个落点：
 * 文件那份是**证据原件**（`evidence/child-tools.jsonl`，历史读数与 `faceMismatches` 还读它），
 * 事件这份是**可引用、可统计**的台账记录。两者都由 `office.noteChildFace` 一处触发（口径唯一）。
 */
export function recordChildObserved(
  journal: Journal,
  entry: { childSessionId: string; toolCount: number; deniedOutsideCount: number; observedAt?: string | undefined },
): ChildObservation {
  const observedAt = entry.observedAt ?? new Date().toISOString()
  const event = journal.append('dispatch/observed', {
    childSessionId: entry.childSessionId,
    toolCount: entry.toolCount,
    deniedOutsideCount: entry.deniedOutsideCount,
    observedAt,
  })
  return {
    childSessionId: entry.childSessionId,
    toolCount: entry.toolCount,
    deniedOutsideCount: entry.deniedOutsideCount,
    observedAt,
    seq: event.seq,
  }
}

/**
 * 读回**全部**观测事件（按子会话折叠：`toolCount` 取**最近一条带公告面**的，
 * `deniedOutsideCount` **累加** —— 与 `readChildFaces` 的合并口径逐字相同，读侧不会两套口径）。
 */
export function readChildObservations(journal: Journal): ChildObservation[] {
  const folded = new Map<string, ChildObservation>()
  for (const event of journal.read().events) {
    if (event.type !== 'dispatch/observed') continue
    const childSessionId = textOfValue(event.data.childSessionId)
    if (childSessionId === '') continue
    const toolCount = Number(event.data.toolCount ?? 0)
    const deniedOutsideCount = Number(event.data.deniedOutsideCount ?? 0)
    const observedAt = textOfValue(event.data.observedAt) || event.at
    const previous = folded.get(childSessionId)
    folded.set(childSessionId, {
      childSessionId,
      toolCount: Number.isFinite(toolCount) && toolCount > 0 ? toolCount : (previous?.toolCount ?? 0),
      deniedOutsideCount: (previous?.deniedOutsideCount ?? 0) + (Number.isFinite(deniedOutsideCount) ? Math.max(0, deniedOutsideCount) : 0),
      observedAt,
      seq: event.seq,
    })
  }
  return [...folded.values()]
}

/** 某个子会话的观测（没有 ⇒ `undefined` —— **没有证据**与"零工具"是两件事，别合并）。 */
export function observationOf(journal: Journal, childSessionId: string): ChildObservation | undefined {
  return readChildObservations(journal).find((row) => row.childSessionId === childSessionId)
}

/** 事件字段的字符串投影（结构容错：非字符串/空串一律当没有）。 */
function textOfValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/* —————————————————————— 派发现场读数与「没复用」的留痕（`TASK-163` / `DEF-139`） —————————————————————— */

/**
 * **`dispatch/started` 要带上的现场读数**（落点一：把「children 从哪来」变成可读的读数）。
 *
 * 这里只做**投影**：字段的**取值**全部来自 `pool.poolReading()`（桶取自 `rolePools()`），本模块不另立口径
 * —— 真机教训 `R-6` / `DEF-044`：同一概念两处判据必然分叉，回执就会自相矛盾。
 *
 * 形状（`childrenSource` 三种口径名见 `pool.ChildrenSource`）：
 * `{ childrenSource, childrenTotal, buckets:{…8 桶…}, cap, freeSlots }`
 *
 * **接线点（不在本文件）**：`office.recordDispatchStarted`（`src/office.ts`）把本函数的返回值并进
 * `dispatch/started` 的 data；本卡写范围不含 `src/office.ts`，见任务卡回报里的范围申请。
 */
export function dispatchReadingFields(reading: PoolReading, admitted?: { reuseIdle?: boolean | undefined; forceNew?: boolean | undefined }): Record<string, unknown> {
  return {
    childrenSource: reading.childrenSource,
    childrenTotal: reading.childrenTotal,
    buckets: {
      idle: reading.buckets.idle,
      idleSameParent: reading.buckets.idleSameParent,
      idleForeign: reading.buckets.idleForeign,
      idleUnknownParent: reading.buckets.idleUnknownParent,
      stale: reading.buckets.stale,
      retired: reading.buckets.retired,
      unusable: reading.buckets.unusable,
      busy: reading.buckets.busy,
    },
    cap: reading.cap,
    freeSlots: reading.freeSlots,
    // **`DEF-139` 定案键**：`reuseIdle=false`（宿主没有续聊入口）/ `forceNew=true`（本轮换人）时
    // `reuseSkipped` 为空是**正确**的 —— 这两个键不在，两种"不复用"就又长得一模一样。
    ...(admitted?.reuseIdle === undefined ? {} : { reuseIdle: admitted.reuseIdle }),
    ...(admitted?.forceNew === undefined ? {} : { forceNew: admitted.forceNew }),
  }
}

/**
 * **`reuseSkipped` 的事件形状**（落点二）：每条 `{childSessionId, role, reason}` 原样落盘，**不做聚合**。
 *
 * 读侧（{@link reuseSkippedOf}）两种承载都认：
 *   ① 挂在 `dispatch/started.reuseSkipped` 上（今天就能落地，**不需要新事件类型**）；
 *   ② 独立事件 {@link REUSE_SKIPPED_EVENT}（`dispatch/reuse-skipped`）—— **需先在 `src/types.ts` 的
 *      `SdoEventType` 里登记**（那是闭合联合类型，本卡写范围不含它）；登记之后把
 *      {@link reuseSkippedEventData} 交给 `journal.append(REUSE_SKIPPED_EVENT, …)` 即可。
 *
 * 为什么两种都认：真源是 append-only 的，历史读数不会因为今天选了哪条承载而变；
 * 读侧认两种，回执就能在任何一侧先落地时**立刻**说得清"谁没被复用、为什么"。
 */
export const REUSE_SKIPPED_EVENT = 'dispatch/reuse-skipped'

/** 一行的三条字段（缺字段照实投影成空串，**不编造**）。 */
export function reuseSkippedFields(rows: readonly { childSessionId: string; role: string; reason: string }[]): { childSessionId: string; role: string; reason: string }[] {
  return rows.map((row) => ({ childSessionId: row.childSessionId, role: row.role, reason: row.reason }))
}

/** 独立事件的数据面（含判定时刻与所属卡：读者不必再去别处拼装上下文）。 */
export function reuseSkippedEventData(
  row: { childSessionId: string; role: string; reason: string },
  extra?: { task?: string | undefined; decidedAt?: string | undefined },
): Record<string, unknown> {
  return {
    childSessionId: row.childSessionId,
    role: row.role,
    reason: row.reason,
    ...(extra?.task === undefined ? {} : { task: extra.task }),
    decidedAt: extra?.decidedAt ?? new Date().toISOString(),
  }
}

/** 一次 `reuseSkipped` 留痕的读侧投影。 */
export interface ReuseSkippedRecord {
  childSessionId: string
  role: string
  reason: string
  /** 所属卡（挂在 `dispatch/started` 上时取自该事件；独立事件时取自事件数据） */
  task: string
  /** 承载那条事件在台账里的序号（回执引用"依据哪条"就用它） */
  seq: number
  /** 承载事件的类型：`dispatch/started` 或 `dispatch/reuse-skipped` */
  via: string
}

/**
 * 读回**没被复用**的留痕（两种承载都认，见 {@link REUSE_SKIPPED_EVENT}）。
 *
 * 记录顺序 = 台账顺序；同一 `childSessionId` 出现多次时**不去重**（历史读数照实回放，去重是渲染层的事）。
 */
export function reuseSkippedOf(journal: Journal): ReuseSkippedRecord[] {
  const out: ReuseSkippedRecord[] = []
  for (const event of journal.read().events) {
    // **读侧按字符串比**（不是漏了类型）：`SdoEventType` 是**闭合联合**，`dispatch/reuse-skipped`
    // 还没登记进去（登记点在 `src/types.ts`，不在本卡写范围）；而台账是 append-only 的跨版本真源 ——
    // 别的构建写过的事件，本构建**照样要读得回来**，读侧因此只认**字形**，不认类型声明。
    const type: string = event.type
    if (type === REUSE_SKIPPED_EVENT) {
      const childSessionId = textOfValue(event.data.childSessionId)
      if (childSessionId === '') continue
      out.push({
        childSessionId,
        role: textOfValue(event.data.role),
        reason: textOfValue(event.data.reason),
        task: textOfValue(event.data.task),
        seq: event.seq,
        via: event.type,
      })
      continue
    }
    if (event.type !== 'dispatch/started') continue
    const rows = event.data.reuseSkipped
    if (!Array.isArray(rows)) continue
    for (const item of rows) {
      const row = item as { childSessionId?: unknown; role?: unknown; reason?: unknown }
      const childSessionId = textOfValue(row.childSessionId)
      if (childSessionId === '') continue
      out.push({
        childSessionId,
        role: textOfValue(row.role),
        reason: textOfValue(row.reason),
        task: textOfValue(event.data.task),
        seq: event.seq,
        via: event.type,
      })
    }
  }
  return out
}

/** 一次派发的现场读数（读侧：`dispatch/started` 里带的那一份）。 */
export interface DispatchReadingRecord {
  task: string
  role: string
  childrenSource: string
  childrenTotal: number
  buckets: Record<string, number>
  cap: number
  freeSlots: number
  /** 这一轮试没试复用（老事件没有这个键 ⇒ `undefined`：**"没记"与"记了 false"必须可区分**） */
  reuseIdle?: boolean | undefined
  /** 这一轮是否强制新起 */
  forceNew?: boolean | undefined
  seq: number
}

/**
 * 读回**派发时记下的现场读数**（缺字段的事件 ⇒ 不返回；**"没记"与"记了 0"必须可区分**）。
 *
 * 这条读侧就是 `DEF-139` 的定案入口：以后再问「为什么这个角色没被复用」，
 * 先看这一行 —— `childrenTotal=0` ⇒ 取不到孩子；`buckets.idle>0` 却没复用时，再看 `reuseSkipped`。
 */
export function readDispatchReadings(journal: Journal): DispatchReadingRecord[] {
  const out: DispatchReadingRecord[] = []
  for (const event of journal.read().events) {
    if (event.type !== 'dispatch/started') continue
    const source = textOfValue(event.data.childrenSource)
    if (source === '') continue
    const rawBuckets = event.data.buckets
    const buckets: Record<string, number> = {}
    if (rawBuckets !== null && typeof rawBuckets === 'object') {
      for (const [key, value] of Object.entries(rawBuckets as Record<string, unknown>)) {
        const num = Number(value)
        if (Number.isFinite(num)) buckets[key] = num
      }
    }
    out.push({
      task: textOfValue(event.data.task),
      role: textOfValue(event.data.role),
      childrenSource: source,
      childrenTotal: Number(event.data.childrenTotal ?? 0),
      buckets,
      cap: Number(event.data.cap ?? 0),
      freeSlots: Number(event.data.freeSlots ?? 0),
      ...(typeof event.data.reuseIdle === 'boolean' ? { reuseIdle: event.data.reuseIdle } : {}),
      ...(typeof event.data.forceNew === 'boolean' ? { forceNew: event.data.forceNew } : {}),
      seq: event.seq,
    })
  }
  return out
}

/** 读回观测（坏行跳过并计数；同一子会话保留**最后**一条）。 */
export function readChildFaces(store: SdoStore): { faces: ChildFaceEntry[]; badLines: number } {
  if (!existsSync(store.path(...CHILD_FACE_SEGMENTS))) return { faces: [], badLines: 0 }
  const text = store.readText(...CHILD_FACE_SEGMENTS) ?? ''
  const latest = new Map<string, ChildFaceEntry>()
  let badLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as ChildFaceEntry
      if (typeof parsed.childSessionId !== 'string' || !Array.isArray(parsed.tools)) {
        badLines += 1
        continue
      }
      // 合并：公告面取**最近一条带清单**的，执行面把历次越界调用并起来（append-only，读时归一）
      const previous = latest.get(parsed.childSessionId)
      const calls = [...new Set([...(previous?.calls ?? []), ...(parsed.calls ?? [])])]
      const callCount = (previous?.callCount ?? 0) + (parsed.callCount ?? 0)
      const announced = parsed.tools.length > 0 ? parsed : previous?.tools.length ? previous : parsed
      latest.set(parsed.childSessionId, {
        childSessionId: parsed.childSessionId,
        at: parsed.at,
        tools: announced.tools,
        violations: announced.violations,
        ...(calls.length === 0 ? {} : { calls }),
        ...(callCount === 0 ? {} : { callCount }),
      })
    } catch {
      badLines += 1
    }
  }
  return { faces: [...latest.values()], badLines }
}

/** 从宿主 `tool/call` 事件里取工具名（结构容错）。 */
export function toolCallNameOf(event: unknown): string | undefined {
  const name = (event as { data?: { name?: unknown } } | undefined)?.data?.name
  return typeof name === 'string' && name !== '' ? name : undefined
}

/** 从宿主 `request/header` 事件里取工具名（结构容错：只认字符串 `name`）。 */
export function toolNamesOfHeader(header: unknown): string[] {
  const tools = (header as { tools?: unknown } | undefined)?.tools
  if (!Array.isArray(tools)) return []
  const names: string[] = []
  for (const item of tools) {
    const name = (item as { name?: unknown } | undefined)?.name
    if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name)
  }
  return names.sort()
}
