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
// **`TASK-224`**：聚合/引用/老形状的展开只有一处实现（`pool.reuseSkippedRowsFromEvents`）
import { reuseSkippedRowsFromEvents } from './pool.js'
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
      /**
       * **`TASK-224` 落点：两种事件形状都要读得回来。**
       *
       * 修前这里只认"一行一个候选"（`data.childSessionId`）；`DEF-210` 之后写入端改成
       * **一行一个原因**（`{ candidates, reasons: [{ reason, count, sampleChildIds }] }`）或
       * **引用形态**（`{ sameAsSeq }`）⇒ 老读口会把它们**整条跳过**（真机上就是"回读 0 条"）。
       * 现在把展开交给唯一出口 `pool.reuseSkippedRowsFromEvents`（它同时处理老形状/聚合/引用，
       * 并如实返回解不开的 `sameAsSeq`，不编造原因），这里只负责补上 `seq` / `via` / `task`。
       *
       * ⚠️ **不做去重**：逐承载各一条是刻意语义（append-only 的历史读数照实回放），
       * `M206-12` 钉的就是这条。
       */
      const expanded = reuseSkippedRowsFromEvents([{ seq: event.seq, type: String(event.type), data: event.data }])
      for (const row of expanded.rows) {
        out.push({
          childSessionId: row.childSessionId,
          role: row.role,
          reason: row.reason,
          task: textOfValue(event.data.task),
          seq: event.seq,
          via: event.type,
        })
      }
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

/**
 * 读回观测（坏行跳过并计数；同一子会话保留**最后**一条）。
 *
 * **`TASK-221` 起：同一个文件里还有第二种行 —— 调用流水**（{@link ChildToolCallEntry} /
 * {@link ChildToolCallFoldRow}，见本文件下半段）。它们**不是宣告面**，所以这里按**形状**跳过
 * （不是按"坏行"跳过：它们是本产品自己写的，算坏行会把 `badLines` 变成噪音）——
 * 于是 `childFaceLines` 的渲染面与修前**逐字相同**（阈值 ④ 的机械保证）。
 */
export function readChildFaces(store: SdoStore): { faces: ChildFaceEntry[]; badLines: number; callLines: number } {
  if (!existsSync(store.path(...CHILD_FACE_SEGMENTS))) return { faces: [], badLines: 0, callLines: 0 }
  const text = store.readText(...CHILD_FACE_SEGMENTS) ?? ''
  const latest = new Map<string, ChildFaceEntry>()
  let badLines = 0
  let callLines = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as ChildFaceEntry
      // 调用流水行（本文件的第二种行）：不当宣告面、也不当坏行 —— 由 `readChildToolCalls` 去读
      if (isToolCallLine(parsed) || isToolCallFoldLine(parsed)) {
        callLines += 1
        continue
      }
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
  return { faces: [...latest.values()], badLines, callLines }
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

/* —————————————————— 调用流水：把「用了什么工具」变成可测的读数（TASK-221 / DEF-205） —————————————————— */

/**
 * **为什么要第二种行**（`DEF-205` 的真读数）：今天的台账只有**宣告面** ——
 * 现盘 `.sdo/evidence/child-tools.jsonl` 的字段只有 `at` / `childSessionId` / `tools` / `violations`，
 * `tools` 是"宿主公告给它哪些工具"（不是它用了什么），`violations` 是"掩码外的调用"（越界面）。
 * 于是「子代理多频繁地用 `bash` 去读台账状态」在台账上**不可回答**，给它们补只读工具之后
 * 「`bash` 用量是否真的降下来」也**没有判据**。
 *
 * 这里落的是**调用流水**：每发生一次工具调用，追加一条精简行（见 {@link ChildToolCallEntry}）。
 *
 * **三条硬约束（都是安全/体积面，不是风格）**：
 *   ① **不记参数内容** —— 只留"路径"（`targetPath`）与"命令首词形态"（`shape`），
 *      参数里的密钥/正文**一律不落盘**（守卫：把哨兵串塞进参数，流水行里不得出现它）；
 *   ② **不过每会话 {@link CALLS_PER_SESSION_CAP} 条明细** —— 超出后每次调用折成一条
 *      `{ tool, n }` **计数行**（{@link ChildToolCallFoldRow}），并在回执里点名折了多少；
 *   ③ **单条 < {@link CALL_LINE_MAX_BYTES} 字节** —— 写侧按"先截路径、再丢形态"的顺序降级，
 *      保证任何输入都写不出超限的一条。
 *
 * 落点**为什么是同一个文件**（不另开 `child-tool-calls.jsonl`）：`evidence/child-tools.jsonl` 已经在
 * 归档保护的"产品要读的原件"名单里（`EVIDENCE_PROTECTED`，`m220` 咬住）。另开一个文件的话，
 * 归档演练会把它当可删的过程产物 —— 那是"删掉即删功能"。读侧按**形状**区分两种行
 * （{@link readChildFaces} 跳过流水行），所以既有渲染面一个字节都不变。
 */

/** 单条流水的体积硬上限（**字节**，UTF-8）。 */
export const CALL_LINE_MAX_BYTES = 300

/** 每会话的**逐条明细**上限；超出后每次调用折成一条计数行。 */
export const CALLS_PER_SESSION_CAP = 200

/** `shape` 的最长字符数（只留命令首词，见 {@link commandShape}）。 */
export const CALL_SHAPE_MAX_CHARS = 24

/** `targetPath` 的最长字符数（写侧超限会继续缩短，直到整条 < {@link CALL_LINE_MAX_BYTES}）。 */
export const CALL_PATH_MAX_CHARS = 120

/** `tool` / `role` / `task` 的字符上限（不让异常输入把一行撑开）。 */
const CALL_TOOL_MAX_CHARS = 40
const CALL_ROLE_MAX_CHARS = 24
const CALL_TASK_MAX_CHARS = 16
const CALL_SESSION_MAX_CHARS = 64

/**
 * **一条调用流水**（明细行）。字段面就是 DoD 里那一组：`{ at, childSessionId, role, task, tool,
 * targetPath?, shape?, exitCode?, ms?, ok }`。
 *
 * `shape` 是 DoD 字段表之外**新增的一个可选字段**，理由是可判据：落点二要求给出
 * "`bash` 里最频繁的命令形态前 3（按首词归一）"，而形态**不是**参数内容 ——
 * 它是从命令里归一出的一小段受限字形（见 {@link commandShape}）。不记它，"补工具 ⇒ `bash` 下降"
 * 只能读到"`bash` 次数"，读不到"它们用 `bash` 干什么"（那正是这条缺陷要回答的第二问）。
 */
export interface ChildToolCallEntry {
  at: string
  childSessionId: string
  role: string
  task: string
  tool: string
  /** 只留**路径**（写/读类工具的目标），**不留内容** */
  targetPath?: string | undefined
  /** 命令类工具的**首词形态**（`grep` / `git` / `node`…），不是命令原文 */
  shape?: string | undefined
  exitCode?: number | undefined
  ms?: number | undefined
  ok: boolean
}

/**
 * **计数行**：某会话的明细条数已经用满 {@link CALLS_PER_SESSION_CAP} 之后，每次调用只追加
 * `{ tool, n }`（不再逐条留明细）。**读侧把全部计数行相加** —— append-only 文件不许改写，
 * 所以累加式（而不是"最新一条覆盖"）是唯一在**并发写**下也不会丢计数的方式；
 * 总和守恒因此在读侧可判定：明细条数 + 计数之和 == 实际调用数（守卫 `M237-02`）。
 */
export interface ChildToolCallFoldRow {
  at: string
  childSessionId: string
  role: string
  task: string
  folded: { tool: string; n: number }[]
}

/**
 * 写一条流水的入参。
 *
 * `args` 是宿主给的**原始参数对象**：本模块只从里面取「路径」（{@link targetPathOfArgs}）与
 * 「命令首词」（{@link commandShape}），**其余一律丢弃** —— 这是硬约束 ① 的机械保证
 * （密钥/正文不进台账，守卫 `M237-05` 拿哨兵串去撞）。
 */
export interface ChildToolCallInput {
  childSessionId: string
  role: string
  task: string
  tool: string
  /** 宿主原始参数（只取路径 / 命令首词，见上面的说明） */
  args?: unknown
  /** 只留路径；调用方给**相对工作区**的路径更好（绝对路径会把 `$HOME` 写进台账） */
  targetPath?: string | undefined
  /** 命令类工具的**原始命令**（本模块只取首词，其余丢弃） */
  command?: string | undefined
  /** 已经归一好的形态（给了就用它，不再从 `command` 算） */
  shape?: string | undefined
  exitCode?: number | undefined
  ms?: number | undefined
  ok?: boolean | undefined
  at?: string | undefined
}

/** 一次写入的结果（`kind` 区分明细行与计数行）。 */
export interface ChildToolCallWrite {
  /** 写进文件的那一行（不含换行） */
  line: string
  kind: 'detail' | 'fold'
  /** 写入**之后**该会话的明细条数 */
  detailed: number
}

/**
 * **命令形态**：只留命令的**首词**、去掉目录前缀、只留 `[A-Za-z0-9_.-]`、定长
 * （`/usr/bin/git --no-pager log foo` ⇒ `git`）。
 *
 * 为什么不整条记：硬约束 ① —— 命令里可能有令牌/正文；而"它用 `bash` 干什么"这个问句
 * 只需要形态（`grep`/`cat`/`git`/`node`）就能回答（落点二的判据正是按首词归一）。
 */
export function commandShape(command: string): string {
  const first = command.trim().split(/\s+/u)[0] ?? ''
  const base = first.split(/[\\/]/u).pop() ?? ''
  const cleaned = base.replace(/[^A-Za-z0-9_.-]/gu, '')
  return cleaned.slice(0, CALL_SHAPE_MAX_CHARS)
}

/** 从宿主参数里取**路径**（宿主 `@deepseek-ai/dsh-tool-fs` 的真实键是 `file_path`，其余键兼容）。 */
export function targetPathOfArgs(args: unknown): string {
  const raw = (args ?? {}) as { file_path?: unknown; path?: unknown; file?: unknown; paths?: unknown }
  const candidates = [
    ...(typeof raw.file_path === 'string' ? [raw.file_path] : []),
    ...(typeof raw.path === 'string' ? [raw.path] : []),
    ...(typeof raw.file === 'string' ? [raw.file] : []),
    ...(Array.isArray(raw.paths) ? raw.paths.filter((item): item is string => typeof item === 'string') : []),
  ]
  return candidates.find((item) => item.trim() !== '') ?? ''
}

/** 从宿主参数里取**命令原文**（`bash` 的 `command`；别的工具没有）—— 只给 {@link commandShape} 用。 */
export function commandOfArgs(args: unknown): string {
  const raw = (args ?? {}) as { command?: unknown; cmd?: unknown }
  if (typeof raw.command === 'string') return raw.command
  if (typeof raw.cmd === 'string') return raw.cmd
  return ''
}

function clipText(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max)
}

function byteSize(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 把一条输入压成**有界且不含参数内容**的明细行（体积保证：< {@link CALL_LINE_MAX_BYTES} 字节）。
 *
 * 降级顺序：先截 `targetPath`（120 ⇒ 24 ⇒ 8），再丢 `shape`；到这一步仍超限的只能是
 * 字段本身超长（各字段都已按上限裁剪），因此直接返回最后那一版（并仍然满足上限）。
 */
export function toolCallLine(input: ChildToolCallInput): { entry: ChildToolCallEntry; json: string } {
  const base: ChildToolCallEntry = {
    at: input.at ?? new Date().toISOString(),
    childSessionId: clipText(input.childSessionId, CALL_SESSION_MAX_CHARS),
    role: clipText(input.role, CALL_ROLE_MAX_CHARS),
    task: clipText(input.task, CALL_TASK_MAX_CHARS),
    tool: clipText(input.tool, CALL_TOOL_MAX_CHARS),
    ok: input.ok ?? true,
    ...(typeof input.exitCode === 'number' && Number.isFinite(input.exitCode) ? { exitCode: Math.trunc(input.exitCode) } : {}),
    ...(typeof input.ms === 'number' && Number.isFinite(input.ms) ? { ms: Math.max(0, Math.round(input.ms)) } : {}),
  }
  const path = input.targetPath === undefined
    ? clipText(targetPathOfArgs(input.args), CALL_PATH_MAX_CHARS)
    : clipText(input.targetPath, CALL_PATH_MAX_CHARS)
  const shape = input.shape ?? commandShape(input.command ?? commandOfArgs(input.args))
  const caps = [path === '' ? 0 : CALL_PATH_MAX_CHARS, 24, 8]
  for (const cap of caps) {
    const entry: ChildToolCallEntry = {
      ...base,
      ...(cap === 0 ? {} : { targetPath: path.slice(0, cap) }),
      ...(shape === '' ? {} : { shape }),
    }
    const json = JSON.stringify(entry)
    if (byteSize(json) < CALL_LINE_MAX_BYTES) return { entry, json }
  }
  const last: ChildToolCallEntry = { ...base, ...(path === '' ? {} : { targetPath: path.slice(0, 8) }) }
  return { entry: last, json: JSON.stringify(last) }
}

/** 一行 JSON 的**形状归类**（读侧两种行共用一个判据，避免两处各写一套）。 */
function isToolCallLine(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const row = value as { tool?: unknown; tools?: unknown; folded?: unknown }
  return typeof row.tool === 'string' && !Array.isArray(row.tools) && !Array.isArray(row.folded)
}

function isToolCallFoldLine(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const row = value as { folded?: unknown; tools?: unknown }
  return Array.isArray(row.folded) && !Array.isArray(row.tools)
}

/** 本会话已经写了多少条**明细**（计数行不算）。 */
export function countChildToolCallDetails(store: SdoStore, childSessionId: string): number {
  if (!existsSync(store.path(...CHILD_FACE_SEGMENTS))) return 0
  const text = store.readText(...CHILD_FACE_SEGMENTS) ?? ''
  let count = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!isToolCallLine(parsed)) continue
      if ((parsed as ChildToolCallEntry).childSessionId === childSessionId) count += 1
    } catch {
      continue
    }
  }
  return count
}

/**
 * 追加一条调用流水（append-only）。
 *
 * `options.detailedSoFar` 是**本会话已写下的明细条数** —— 调用方（`office.noteChildToolCall`）在内存里
 * 缓存它，于是每次工具调用**不必重读整份文件**（这个钩子在最热的路径上：每次工具调用一次）。
 * 不给就现读（口径相同，只是慢）；两者都只决定"这条该记明细还是记计数行"，
 * **不影响**读侧的总和守恒（守恒由读侧的"明细 + Σ计数"给出，与写侧怎么选无关）。
 */
export function writeChildToolCall(
  store: SdoStore,
  input: ChildToolCallInput,
  options: { cap?: number | undefined; detailedSoFar?: number | undefined } = {},
): ChildToolCallWrite {
  const cap = options.cap ?? CALLS_PER_SESSION_CAP
  const detailed = options.detailedSoFar ?? countChildToolCallDetails(store, input.childSessionId)
  if (detailed < cap) {
    const { json } = toolCallLine(input)
    store.appendLine([...CHILD_FACE_SEGMENTS], json + '\n')
    return { line: json, kind: 'detail', detailed: detailed + 1 }
  }
  const fold: ChildToolCallFoldRow = {
    at: input.at ?? new Date().toISOString(),
    childSessionId: clipText(input.childSessionId, CALL_SESSION_MAX_CHARS),
    role: clipText(input.role, CALL_ROLE_MAX_CHARS),
    task: clipText(input.task, CALL_TASK_MAX_CHARS),
    folded: [{ tool: clipText(input.tool, CALL_TOOL_MAX_CHARS), n: 1 }],
  }
  const json = JSON.stringify(fold)
  store.appendLine([...CHILD_FACE_SEGMENTS], json + '\n')
  return { line: json, kind: 'fold', detailed }
}

/** 读回调用流水（坏行跳过并计数；`badLines` **不含**宣告面行与流水行本身）。 */
export interface ChildToolCallRead {
  /** 明细行（台账顺序 = 时间顺序） */
  calls: ChildToolCallEntry[]
  /** 计数行摊平后的一条条 `{ childSessionId, tool, n }` */
  folds: { at: string; childSessionId: string; role: string; task: string; tool: string; n: number }[]
  badLines: number
  /** 宣告面行数（旧格式条目；**它们没有 usage**，读侧不得为它们编造流水） */
  faceLines: number
  detailedRows: number
  foldedTotal: number
}

export function readChildToolCalls(store: SdoStore): ChildToolCallRead {
  const out: ChildToolCallRead = { calls: [], folds: [], badLines: 0, faceLines: 0, detailedRows: 0, foldedTotal: 0 }
  if (!existsSync(store.path(...CHILD_FACE_SEGMENTS))) return out
  const text = store.readText(...CHILD_FACE_SEGMENTS) ?? ''
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      out.badLines += 1
      continue
    }
    if (isToolCallFoldLine(parsed)) {
      const row = parsed as ChildToolCallFoldRow
      if (typeof row.childSessionId !== 'string') {
        out.badLines += 1
        continue
      }
      for (const item of row.folded) {
        const n = Number(item?.n ?? 0)
        if (typeof item?.tool !== 'string' || !Number.isFinite(n) || n <= 0) continue
        out.folds.push({
          at: typeof row.at === 'string' ? row.at : '',
          childSessionId: row.childSessionId,
          role: typeof row.role === 'string' ? row.role : '',
          task: typeof row.task === 'string' ? row.task : '',
          tool: item.tool,
          n: Math.trunc(n),
        })
        out.foldedTotal += Math.trunc(n)
      }
      continue
    }
    if (isToolCallLine(parsed)) {
      const row = parsed as ChildToolCallEntry
      if (typeof row.childSessionId !== 'string' || row.childSessionId === '' || row.tool === '') {
        out.badLines += 1
        continue
      }
      out.calls.push({
        at: typeof row.at === 'string' ? row.at : '',
        childSessionId: row.childSessionId,
        role: typeof row.role === 'string' ? row.role : '',
        task: typeof row.task === 'string' ? row.task : '',
        tool: row.tool,
        ...(typeof row.targetPath === 'string' ? { targetPath: row.targetPath } : {}),
        ...(typeof row.shape === 'string' ? { shape: row.shape } : {}),
        ...(typeof row.exitCode === 'number' ? { exitCode: row.exitCode } : {}),
        ...(typeof row.ms === 'number' ? { ms: row.ms } : {}),
        ok: row.ok !== false,
      })
      out.detailedRows += 1
      continue
    }
    if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { tools?: unknown }).tools)) {
      out.faceLines += 1
      continue
    }
    out.badLines += 1
  }
  return out
}

/** 一种工具的调用次数。 */
export interface ToolUseCount {
  tool: string
  count: number
}

/** 一个角色的工具使用面。 */
export interface RoleToolUsage {
  role: string
  /** 该角色的**全部**调用次数（`tools` 只是它的前若干项） */
  total: number
  /** 按次数降序（并列按工具名升序） */
  tools: ToolUseCount[]
  /**
   * `bash` 的**单列读数**（落点二的判据）：次数、占该角色总调用的比例（0–1）、
   * 以及最频繁的命令形态前若干（**只来自明细行**：计数行不留形态，这一点不假装）。
   */
  bash?: { count: number; share: number; shapes: { shape: string; n: number }[] } | undefined
}

/** 按角色的工具使用统计（`sdo_status view=tools` 的数据面）。 */
export interface ToolUsage {
  /** 流水行覆盖到的调用总数（明细 + 计数之和） */
  calls: number
  /** 有流水的会话数 */
  sessions: number
  detailedRows: number
  foldedRows: number
  badLines: number
  /** 按调用总数降序（并列按角色名升序） */
  roles: RoleToolUsage[]
  /**
   * **有工具面观测、但一条流水都没有**的会话 id —— 旧格式条目（`DEF-205` 之前）就是这样。
   * 它们**不得被伪造**成"0 次调用"或"没用 bash"：如实显示"该会话无流水"（落点三）。
   */
  withoutFlow: string[]
}

/**
 * 按角色 × 工具聚合调用流水（落点二）。
 *
 * 口径（写清楚，否则回执与判据会各说一套）：
 *   · 次数 = 明细行 1 次 + 计数行的 `n`（计数行是"超出上限后的调用"，不是一类新调用）；
 *   · `bash` 的次数同样如此，但**形态**只能来自明细行（计数行不留形态）—— 不足时不动声色，
 *     回执由渲染层如实说"形态只统计明细行"；
 *   · `withoutFlow` 从**宣告面**条目里取（那些会话被观测过、却没有流水）。
 */
export function toolUsageOf(store: SdoStore): ToolUsage {
  const read = readChildToolCalls(store)
  const totals = new Map<string, Map<string, number>>()
  const bashShapes = new Map<string, Map<string, number>>()
  const add = (role: string, tool: string, n: number): void => {
    const key = role === '' ? '(unknown)' : role
    const inner = totals.get(key) ?? new Map<string, number>()
    inner.set(tool, (inner.get(tool) ?? 0) + n)
    totals.set(key, inner)
  }
  const sessions = new Set<string>()
  for (const call of read.calls) {
    sessions.add(call.childSessionId)
    add(call.role, call.tool, 1)
    if (call.tool === 'bash' && (call.shape ?? '') !== '') {
      const key = call.role === '' ? '(unknown)' : call.role
      const inner = bashShapes.get(key) ?? new Map<string, number>()
      inner.set(call.shape as string, (inner.get(call.shape as string) ?? 0) + 1)
      bashShapes.set(key, inner)
    }
  }
  for (const fold of read.folds) {
    sessions.add(fold.childSessionId)
    add(fold.role, fold.tool, fold.n)
  }
  const roles: RoleToolUsage[] = [...totals.entries()].map(([role, inner]) => {
    const tools = [...inner.entries()]
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => (b.count - a.count) || a.tool.localeCompare(b.tool))
    const total = tools.reduce((sum, item) => sum + item.count, 0)
    const bashCount = inner.get('bash') ?? 0
    const shapes = [...(bashShapes.get(role) ?? new Map<string, number>()).entries()]
      .map(([shape, n]) => ({ shape, n }))
      .sort((a, b) => (b.n - a.n) || a.shape.localeCompare(b.shape))
    return {
      role,
      total,
      tools,
      ...(bashCount === 0
        ? {}
        : { bash: { count: bashCount, share: total === 0 ? 0 : bashCount / total, shapes } }),
    }
  }).sort((a, b) => (b.total - a.total) || a.role.localeCompare(b.role))
  const faces = readChildFaces(store).faces
  const withoutFlow = faces.map((face) => face.childSessionId).filter((id) => !sessions.has(id))
  return {
    calls: read.detailedRows + read.foldedTotal,
    sessions: sessions.size,
    detailedRows: read.detailedRows,
    foldedRows: read.folds.length,
    badLines: read.badLines,
    roles,
    withoutFlow,
  }
}
