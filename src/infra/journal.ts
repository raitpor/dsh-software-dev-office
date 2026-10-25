/**
 * 追加日志（真源）与投影（派生视图）。
 *
 * 设计对应：§4.1（真源=journal，视图=project.json/docs）、§4.4（journal.jsonl）、
 * NFR-004（投影可重建）、AC-006 / E2E-06（删掉 project.json 后能重建）。
 *
 * 关键纪律：
 *   · **编排器是唯一写者**（RISK-05）：所有写入都经由本模块；
 *   · 事件序号单调递增，从 1 开始；
 *   · 读取时遇到**损坏或不连续的尾部**就停在那里，返回最后一个一致前缀
 *     （宁可少认，不可把半截记录当成事实）。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'

import { SdoStore } from './store.js'
import type {
  JournalEvent,
  JournalReadResult,
  PhaseRecord,
  RedTeamState,
  SdoEventType,
  SdoProject,
} from '../types.js'

export const JOURNAL_FILE = 'journal.jsonl'
export const PROJECT_FILE = 'project.json'

/**
 * **已解析历史的缓存条目**（`TASK-213` 落点一）。
 *
 * 为什么缓存的是「已解析的事件」而不是「整份文件内容」：`journal.jsonl` 是 **append-only** 真源
 * （实测现盘 2.6MB / 5954 事件、单次全量 `read()` 13ms），而一次工具调用会把它读上百次
 * （实测 `pendingReviewBigCards` 一次调用 **279 次 read()**）⇒ 真正的浪费是**重复解析**，
 * 不是重复取字节。所以缓存按「文件身份 + 已消费字节数」记账，文件只是**变长**时只解析新增的那几行。
 *
 * 三条不变量（任何一条破了都会读到陈旧/错误的台账，宁可不缓存也不能读旧数据）：
 *   ① **身份变了就全丢**：`dev+ino` 变化（`store.writeText` 走 tmp+rename，**每次换 inode**）⇒ 全量重解析；
 *   ② **变短就全丢**：`size < consumed`（被截断/轮转/手改）⇒ 全量重解析；
 *   ③ **同长却被动过就全丢**：`size` 没变但 `mtimeMs` 变了（就地同长改写；`appendLine` 之外的手写路径）
 *      ⇒ 全量重解析。这一条是"保守到不划算也要加"的那一条 —— 它挡的是**静默读到旧数据**。
 */
interface JournalCacheEntry {
  dev: number
  ino: number
  /** 已消费的**字节数**：永远落在行边界（最后一个 `\n` 之后），因此续读不会切断 UTF-8 码点 */
  consumed: number
  /** 已消费字节里的 `\n` 个数 = 物理行号基数（`badLine` 靠它算，与全量慢路径逐字相同） */
  newlines: number
  /** 已消费字节解析出的**完整行**事件（尾行未终结时不进这里，见 `read`） */
  events: JournalEvent[]
  /** 记账时看到的 `size` / `mtimeMs`（用来判「同长却被动过」） */
  size: number
  mtimeMs: number
  /**
   * **末个完整行的原文**（锚点）。
   *
   * 为什么需要它：`size` 变大只说明"文件长了"，**不能**证明"前面那段没被改写" —— 就地整份重写且更长时，
   * 若只按 size 判"变长 ⇒ 续读尾部"，就会把**旧的**前缀和**新的**尾巴拼在一起（读到不存在的事件序列）。
   * 续读之前先复算这一段锚点：对得上才承认前缀还在；对不上 ⇒ 全量重解析。
   */
  anchor: string
  /**
   * **首个非空完整行的原文 + 它结束的字节偏移**（第二个锚点，`REV-095` 必核二①）。
   *
   * 为什么只钉末行不够：末行锚点的探针落在固定区间（`[consumed - len - 1, consumed)`），
   * 于是「**等长改写早期行 + 末行原样 + 再追加**」这一形态它看不见 —— 末行一个字节都没变，
   * 探针对得上 ⇒ 判"续读"⇒ **旧的早期事件被静默保留**（读到一段从未存在过的序列）。
   *
   * 为什么钉**首行**而不是随机抽样：首行是最便宜的第二探针（一次几十字节的小 read），而且
   * 「早期行被改」的绝大多数形态都从文件头部开始（手改、`sed -i`、拿模板整篇替换）。
   * **诚实的边界**：两次探测**证明不了**中间某一行没被等长改写 —— 那需要整份前缀的哈希（= 全量读，
   * 等于取消缓存）。所以覆盖范围是：**首行 / 末行被改一定全量重解析；中间行被等长改写检测不到**。
   * 台账是 append-only 真源，中间行的就地改写已经不是 append-only 了 —— 这一档取舍写在交付说明里。
   */
  head: string
  /** 首行锚点**结束**的字节偏移（与 `consumed` 同口径：行尾 `\n` 之后）。 */
  headEnd: number
}

/**
 * 缓存放**模块级**、按 journal 的**绝对路径**索引（`TASK-213` 设计要点二）。
 *
 * 为什么不能挂在 `Journal` 实例上：一次工具调用会 `new Journal(store)` 很多次（现盘 `.read()` 调用点
 * 88 处、分属不同实例），挂实例上等于没缓存。同进程内所有实例共享这一份。
 * 条数上限只为防"测试里千百个临时工作区"把内存撑爆 —— 淘汰只是丢缓存（下次重解析），不改变语义。
 */
const JOURNAL_CACHE = new Map<string, JournalCacheEntry>()
const JOURNAL_CACHE_LIMIT = 16

/**
 * **读台账的计数器**（`TASK-213` 落点三的读数面）。
 *
 * 为什么要在产品代码里放一个计数器：本卡的三条判据（read() 次数 / 解析行数 / 零解析命中）都必须是
 * **实测**而不是估算，而"解析了多少行"在进程外看不见。它只累加、不改变任何行为，也不进任何回执。
 */
export const journalReadStats = {
  /** `read()` 被调用的次数 */
  readCalls: 0,
  /** 其中**零解析**命中缓存的次数（文件没动） */
  cacheHits: 0,
  /** 其中只解析了**新增尾部**的次数 */
  tailParses: 0,
  /** 其中**全量重解析**的次数（身份变了 / 变短 / 同长被改） */
  fullParses: 0,
  /**
   * **`read()` 内**实际 `JSON.parse` 过的台账行数 —— 本卡最有说服力的那一个数。
   *
   * **口径（`REV-095` 必核五②）**：只统计 `read()`。`append()` 每次都还要跑一次
   * {@link maxSeqOfText}（对**盘上全文**逐行 `JSON.parse`，`D2` 的 seq 不变量要求它看坏行），
   * 那部分单独记在 {@link appendParsedLines} 里 —— 旧描述写成"实际 JSON.parse 过的台账行数"
   * 在 append 路径上**低估**了，读的人会以为一次 append 只解析了 1 行。
   */
  parsedLines: 0,
  /** `append()` 里 `maxSeqOfText` 对全文逐行 `JSON.parse` 的行数（与 `parsedLines` **分开记**，别混）。 */
  appendParsedLines: 0,
}

/**
 * **台账代次**（`TASK-220`）：每个台账**绝对路径**一份单调递增的计数。
 *
 * 为什么键必须是「代次」而不是「字节」：折表层（按 type 分组的事件索引 / 评审表 / 处置表 / 采纳表）
 * 吃的是 `read()` 交出来的**事件数组**，而 `read()` 每次都给一份**浅拷贝**（`copyEvents`）——
 * 内容一样、引用不同 ⇒ 拿引用或字节当键等于**永远不命中**（实测三次同价 62.5/64.4/68.7ms 就是这么来的）。
 * 代次只回答一个问题：**这份台账比上次见到的那一份变了吗**；变一次就 +1。
 *
 * 换代的三类入口（都在 {@link bumpGeneration} 里收口，**不许各算一套**）：
 *   ① **写**：`append()` 落盘（`markWritten`）、`invalidate()` / `invalidateJournalCache()` 显式失效；
 *   ② **读时发现变了**：全量重解析 / 续读尾部 / 截断（`commit` / `truncateAt`）；
 *   ③ **缓存被丢掉**：台账不见了（`read()` 的 miss 分支）。
 *
 * 与读层缓存的关系：**同一个源**。读层条目换了（任何一条解析路径），代次就换；读层零解析命中，
 * 代次就不动 —— 两者不会各算一套（这正是本卡 DoD 的硬要求）。
 */
const JOURNAL_GENERATION = new Map<string, number>()

/** 某个台账**当前代次**（从没读过 = 0；只读，不换代）。 */
export function journalGeneration(path: string): number {
  return JOURNAL_GENERATION.get(path) ?? 0
}

/** 换代：代次 +1，并把该台账的**派生表整批失效**（同一口，别处不许自己清）。 */
function bumpGeneration(path: string): void {
  JOURNAL_GENERATION.set(path, journalGeneration(path) + 1)
  invalidateDerivedTables(path)
}

/**
 * **派生表记忆化**（`TASK-220`）：键 = `(台账绝对路径, 代次)`，**另加一组来源探针**。
 *
 * 为什么还要探针：评审表 / 处置表 / 任务卡表不是从 journal 折出来的，而是 `reviews/*.yml`、`tasks/*.yml`
 * （手可编辑的真源）。产品代码写它们时会同时 append 一条事件（⇒ 换代次），但**手改**与**测试夹具直写
 * YAML** 不会 —— 只认代次就会永远读到旧表（= 静默错判采纳）。探针是对这些路径的一次 `stat`
 * （`dev:ino:size:mtimeMs`，不存在记 `-`），与读层的锚点复算同一路数：**便宜、保守、失配就重建**。
 * 代价实测：2 个 stat ≈ 0.02ms，而记忆化的收益是毫秒级。
 *
 * 三条纪律：
 *   · **计算期间又换代/又改探针 ⇒ 只交结果、不登记**（宁可下次重算，也不留一条陈旧条目）；
 *   · 换代时该台账的条目**整批删掉**（`bumpGeneration` 调的 `invalidateDerivedTables`）；
 *   · 命中/重算都计数（{@link derivedTableStats}），本卡的判据必须是**实测**而不是估算。
 */
interface DerivedMemoEntry {
  generation: number
  stamp: string
  value: unknown
}

const DERIVED_MEMO = new Map<string, DerivedMemoEntry>()
const DERIVED_MEMO_LIMIT = 64

/**
 * **派生表计数器**（只累加、不进任何回执；与 `journalReadStats` 同一路数）。
 *
 * 键是记忆化的**名字**（`events-by-type` / `reviews-table` / `dispositions-table` / `review-adoptions`
 * / `pending-review-big-cards`），值是次数：
 *   · `computes`：真的重算了多少次（门禁一次检查里「采纳表 ≤ 1 次真算」读它）；
 *   · `hits`：命中记忆化多少次；
 *   · `probeMisses`：因**来源文件被改**（或代次变了）而重建多少次。
 */
export const derivedTableStats = {
  computes: {} as Record<string, number>,
  hits: {} as Record<string, number>,
  probeMisses: {} as Record<string, number>,
}

/** 清零派生表计数器（守卫与复现脚本用；不影响记忆化内容）。 */
export function resetDerivedTableStats(): void {
  derivedTableStats.computes = {}
  derivedTableStats.hits = {}
  derivedTableStats.probeMisses = {}
}

function tally(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1
}

/** 探针戳：每个来源路径的 `dev:ino:size:mtimeMs`（读不到记 `-`）。 */
function probeStamp(probes: readonly string[]): string {
  const parts: string[] = []
  for (const probe of probes) {
    try {
      const stat = statSync(probe)
      parts.push(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`)
    } catch {
      parts.push('-')
    }
  }
  return parts.join('|')
}

/** 丢掉某个台账的派生表（缺省 = 全部）。**换代时自动调**，也可显式调。 */
export function invalidateDerivedTables(path?: string): void {
  if (path === undefined) {
    DERIVED_MEMO.clear()
    return
  }
  const prefix = `${path}\u0000`
  for (const key of [...DERIVED_MEMO.keys()]) {
    if (key.startsWith(prefix)) DERIVED_MEMO.delete(key)
  }
}

/** {@link memoDerived} 的实现（对外只经 `Journal.memoDerived` 用 —— 键里的路径由 `Journal` 给）。 */
export function memoDerivedValue<T>(
  path: string,
  name: string,
  probes: readonly string[],
  compute: () => T,
): T {
  const key = `${path}\u0000${name}`
  const generation = journalGeneration(path)
  const stamp = probeStamp(probes)
  const cached = DERIVED_MEMO.get(key)
  if (cached !== undefined) {
    if (cached.generation === generation && cached.stamp === stamp) {
      tally(derivedTableStats.hits, name)
      return cached.value as T
    }
    tally(derivedTableStats.probeMisses, name)
  }
  tally(derivedTableStats.computes, name)
  const value = compute()
  // 计算期间台账又变了（或来源文件又被动过）⇒ 只交结果、不登记：宁可不缓存，也不留陈旧条目。
  if (journalGeneration(path) === generation && probeStamp(probes) === stamp) {
    DERIVED_MEMO.set(key, { generation, stamp, value })
    if (DERIVED_MEMO.size > DERIVED_MEMO_LIMIT) {
      const oldest = DERIVED_MEMO.keys().next()
      if (!oldest.done) DERIVED_MEMO.delete(oldest.value)
    }
  }
  return value
}

/**
 * **按 type 分组的事件索引**（`TASK-220` 的第一张派生表）。
 *
 * 病根：采纳判定对每条评审要问三件事（recorded / hashed / verified），修前每次都 `filter` **整个**
 * 事件数组；真账 98 条评审 × 7454 事件 × 3 遍 ≈ 220 万次带字符串强转的比较 —— 这就是
 * `reviewAdoptions` 那 35ms 的主项。分组之后每次只看该 type 的那一小撮，判据一个字都没改。
 */
export interface EventIndex {
  /** 建索引时的那一份事件数组（`of()` 的分组都来自它） */
  readonly events: readonly JournalEvent[]
  /** 某个 type 的事件（保持台账顺序；没有就是同一个空数组） */
  of(type: string): readonly JournalEvent[]
  /** 这一份视图与 `other` 是否**同一视图**（长度 + 首尾 seq 三个指纹，挡"调用方传了子集"）。 */
  sameViewAs(other: readonly JournalEvent[]): boolean
}

const EMPTY_EVENT_GROUP: readonly JournalEvent[] = []

/** 两份事件数组是否**同一视图**（便宜的三指纹：长度 + 首 seq + 末 seq）。 */
function sameEventsView(a: readonly JournalEvent[], b: readonly JournalEvent[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  if (a.length === 0) return true
  return a[0]?.seq === b[0]?.seq && a[a.length - 1]?.seq === b[b.length - 1]?.seq
}

function buildEventIndex(events: readonly JournalEvent[]): EventIndex {
  const groups = new Map<string, JournalEvent[]>()
  for (const event of events) {
    const group = groups.get(event.type)
    if (group === undefined) groups.set(event.type, [event])
    else group.push(event)
  }
  return {
    events,
    of: (type) => groups.get(type) ?? EMPTY_EVENT_GROUP,
    sameViewAs: (other) => sameEventsView(events, other),
  }
}

/** 清零计数器（守卫与复现脚本用；不影响缓存内容）。 */
export function resetJournalReadStats(): void {
  journalReadStats.readCalls = 0
  journalReadStats.cacheHits = 0
  journalReadStats.tailParses = 0
  journalReadStats.fullParses = 0
  journalReadStats.parsedLines = 0
  journalReadStats.appendParsedLines = 0
}

/**
 * 丢掉某个台账的缓存（缺省 = 全部）。**显式失效入口**，`append` 之后也会自动调它。
 *
 * `TASK-220`：失效**同时换代次** —— 否则派生表会看着"代次没变"继续交旧表（陈旧读的第一道缺口）。
 */
export function invalidateJournalCache(path?: string): void {
  if (path === undefined) {
    JOURNAL_CACHE.clear()
    for (const known of [...JOURNAL_GENERATION.keys()]) bumpGeneration(known)
    // 没有代次记录的路径也一起清（新路径第一次读就从 0 开始，不需要留条目）
    invalidateDerivedTables()
    return
  }
  JOURNAL_CACHE.delete(path)
  bumpGeneration(path)
}

/** 把一条 `read` 结果里的事件做**浅拷贝**再交出去：调用方排序/切片都不会污染缓存数组。 */
function copyEvents(events: readonly JournalEvent[]): JournalEvent[] {
  return [...events]
}

/**
 * **一条事件是否合法**（`seq` 必须正好是期望值、四个字段齐全）。
 *
 * 从 `read()` 的旧内联判定里原样抽出来：**判定口径一个字都没变**（截断/坏行语义是本卡的红线，
 * 守卫 `M234-04` 拿它和"全量慢路径"逐字比对）。
 */
function isJournalEvent(event: Partial<JournalEvent>, expected: number): boolean {
  return typeof event.seq === 'number'
    && event.seq === expected
    && typeof event.at === 'string'
    && typeof event.type === 'string'
    && typeof event.data === 'object'
    && event.data !== null
}

/**
 * **一行锚点复算**：盘上 `[end - 该行字节数 - 1, end - 1)` 与缓存的原文逐字相同吗？
 *
 * `end` 是"该行**行尾换行之后**"的偏移（`consumed` 与 `headEnd` 都是这个口径，公式因此只有一份）。
 * 只读那一行（几十~几百字节），比全量重解析便宜两三个数量级。任何异常（读不到 / 长度对不上 /
 * 锚点为空）一律判 **不匹配** —— 保守方向：宁可全量重解析，也不交陈旧台账。
 */
function anchorLineMatches(path: string, end: number, text: string): boolean {
  if (text === '') return false
  const bytes = Buffer.byteLength(text)
  if (end < bytes + 1) return false
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.allocUnsafe(bytes)
    const got = readSync(fd, buffer, 0, bytes, end - bytes - 1)
    return got === bytes && buffer.toString('utf8') === text
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** 读 `[start, end)` 这一段字节（一次 open/read/close）。 */
function readRange(path: string, start: number, end: number): Buffer {
  const length = end - start
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const got = readSync(fd, buffer, 0, length, start)
    return got === length ? buffer : buffer.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

/**
 * **「台账不是普通文件」的错误**（`REV-095` 必核三）。
 *
 * 改前 `read()` 走 `store.readText`（`existsSync` + `readFileSync`）⇒ 台账被换成目录时**抛 `EISDIR`**。
 * 缓存层必须恢复同一口径：把一次真实错误吞成"空台账"既与改前不同，也让"台账坏了"变得不可见。
 */
function notAFile(path: string, isDirectory: boolean): NodeJS.ErrnoException {
  const error = new Error(
    `${isDirectory ? 'EISDIR: illegal operation on a directory' : 'ENOTFILE: not a regular file'}, read '${path}'`,
  ) as NodeJS.ErrnoException
  error.code = isDirectory ? 'EISDIR' : 'ENOTFILE'
  error.path = path
  return error
}

/** 追加日志与投影的唯一入口。 */
export class Journal {
  constructor(private readonly store: SdoStore) {}

  /** 本台账文件路径（缓存键）。 */
  private journalPath(): string {
    return this.store.path(JOURNAL_FILE)
  }

  /** 本台账的**代次**（单调递增；任何写盘 / 解析 / 截断 / 丢弃都会换代。只读）。 */
  generation(): number {
    return journalGeneration(this.journalPath())
  }

  /**
   * **派生表记忆化**（键 = 本台账绝对路径 + 代次，另加 `probes` 探针）：见 {@link memoDerivedValue}。
   *
   * 用法纪律：`compute` 里**不许写盘**（写盘换代次 ⇒ 这次结果不会被登记，得下次重算）；
   * 返回的数组/Map 是**共享只读视图**，调用方要改就先自己拷一份。
   */
  memoDerived<T>(name: string, probes: readonly string[], compute: () => T): T {
    return memoDerivedValue(this.journalPath(), name, probes, compute)
  }

  /**
   * **按 type 分组的事件索引**（记忆化；键 = 代次）。
   *
   * 两种吃法：
   *   · 不给 `events` ⇒ 先 `read()` 让代次落定，再建索引（**一次读**；命中缓存 0.04ms）；
   *   · 给了 `events` ⇒ 见 {@link indexOf}（**不再读**：调用方刚读过，别为了查一次索引又 stat 一遍 ——
   *     `M234-05` 的"一次 `pendingReviewBigCards` 只读一次台账"就是靠这条守住的）。
   */
  eventsIndex(events?: readonly JournalEvent[]): EventIndex {
    if (events !== undefined) return this.indexOf(events)
    const fresh = this.read().events
    return memoDerivedValue(this.journalPath(), 'events-by-type', [], () => buildEventIndex(fresh))
  }

  /**
   * 给**调用方自带的事件数组**配一份索引（**不读盘**）。
   *
   * 三指纹（长度 + 首末 seq）与读层缓存里那一份相同 ⇒ 直接用按代次记忆化的索引；
   * 不同（调用方传了子集 / 别的台账 / 本进程还没读过）⇒ **现建、不缓存**（判据仍以调用方给的那一份为准）。
   * 为什么拿读层缓存条目而不是再 `read()` 一次：`read()` 会顺手 stat + 可能续读，而这条路上
   * 调用方**刚刚**读过；再读一遍既浪费，又会让"一次调用只读一次台账"的守卫（`M234-05`）变红。
   */
  indexOf(events: readonly JournalEvent[]): EventIndex {
    const cached = this.settledEntry()
    if (cached !== undefined && sameEventsView(cached.events, events)) {
      return memoDerivedValue(this.journalPath(), 'events-by-type', [], () => buildEventIndex(events))
    }
    return buildEventIndex(events)
  }

  /** 这份事件数组是不是**本台账当次代次的规范全量视图**（三指纹；**不读盘**，口径见 {@link indexOf}）。 */
  isCanonicalView(events: readonly JournalEvent[]): boolean {
    const cached = this.settledEntry()
    return cached !== undefined && sameEventsView(cached.events, events)
  }

  /**
   * **结算过的**缓存条目（`size >= 0`）—— 写者刻意记成 `-1` 表示"已知长度作废"（{@link markWritten}）。
   *
   * 为什么要这一道：`append()` 之后缓存里的 `events` 还停在**写之前**那一份（写路径不重读），
   * 若拿它当"规范视图"去登记派生表，就会把**旧事件集**的索引记到**新代次**名下。
   * 判据只需一个字段比较：`-1` ⇒ 不认（现建不缓存，宁可下次重算）。
   */
  private settledEntry(): JournalCacheEntry | undefined {
    const entry = JOURNAL_CACHE.get(this.journalPath())
    return entry !== undefined && entry.size >= 0 ? entry : undefined
  }

  /**
   * **写者侧的失效**：保留已解析前缀，只把「已知长度」记成未知。
   *
   * 为什么不是 `invalidate()`（整条丢）：那样每次 `append` 之后的下一次读都会**全量重解析**
   * （真盘 5954 行）—— 正是本卡要消灭的那件事。台账是 append-only，写完只需让它走"变长 ⇒ 续读尾部"
   * 那一支：`size = -1` 一定小于盘上 size，于是下次读必然重新 stat 并续读，且锚点复算仍然把关。
   * 真正需要整条丢弃的场合（整份替换/回滚）用 {@link invalidate}。
   */
  private markWritten(): void {
    const entry = JOURNAL_CACHE.get(this.journalPath())
    if (entry !== undefined) entry.size = -1
    // **`TASK-220`**：写盘即换代次（派生表必须立刻失效 —— 哪怕缓存条目本来就不存在）
    bumpGeneration(this.journalPath())
  }

  /**
   * **显式失效**（`TASK-213`）：写盘之后必须调用它 —— 不依赖下一次 `stat` 去发现。
   *
   * 对外也开放：任何在本类之外改写 `journal.jsonl` 的路径都应该调它（同 `store.appendLine` 的直写者）。
   */
  invalidate(): void {
    invalidateJournalCache(this.journalPath())
  }

  /** 读取全部事件；遇到损坏行即停止并标记（语义与 `TASK-213` 之前**逐字相同**）。 */
  read(): JournalReadResult {
    journalReadStats.readCalls += 1
    const path = this.journalPath()
    let stat: ReturnType<typeof statSync> | undefined
    try {
      stat = statSync(path)
    } catch {
      stat = undefined
    }
    if (stat === undefined) {
      // **`TASK-220`**：台账**不见了**也是"变了"（空视图）⇒ 换代次，派生表不许继续按旧代次交旧表。
      // 但"本来就没有这个文件"不是变化：只有真的删掉了一条缓存条目才换代 ——
      // 否则每次读一份不存在的台账都会换代次，派生表就永远登记不上（空工作区会退化成零记忆化）。
      if (JOURNAL_CACHE.delete(path)) bumpGeneration(path)
      return { events: [], truncated: false }
    }
    /**
     * **非普通文件（等价性，`REV-095` 必核三）**：改前 `read()` 走 `store.readText`
     * （`existsSync` + `readFileSync`）—— 台账被换成**目录**时它会**抛 `EISDIR`**。
     * 缓存版最初把这一支吞成"空台账"，那等于把一次**真实错误静默**掉，且与改前不同。
     * 这里恢复改前的抛错口径（`M234-09` 钉住它）。
     */
    if (!stat.isFile()) throw notAFile(path, stat.isDirectory())

    const cached = JOURNAL_CACHE.get(path)
    const sameIdentity = cached !== undefined && cached.dev === stat.dev && cached.ino === stat.ino
    const sameSize = sameIdentity && cached !== undefined && cached.size === stat.size
    const touched = cached !== undefined && cached.mtimeMs !== stat.mtimeMs
    // ① 文件**没动**（同身份、同长度、同 mtime）⇒ 零解析
    if (cached !== undefined && sameIdentity && sameSize && !touched) {
      journalReadStats.cacheHits += 1
      return { events: copyEvents(cached.events), truncated: false }
    }
    /**
     * ② 只有**变长**（append-only 的正常路径）⇒ 从 `consumed` 续读，只解析新增行。
     *
     * 两条前提：同身份（`dev+ino`）、且 `size > consumed`。**再加一道锚点复算** ——
     * 「变长」本身不证明"前面那段没被改写"，所以续读前先回读**首行与末行**，
     * 与缓存里记的原文逐字比对：任何一处对不上就是改写，直接走全量重解析。
     */
    const grew = cached !== undefined && sameIdentity && stat.size > cached.consumed
    const appendOnly = grew && cached !== undefined && this.anchorsMatch(path, cached)
    const start = appendOnly ? (cached?.consumed ?? 0) : 0
    const baseEvents = appendOnly ? copyEvents(cached?.events ?? []) : []
    const baseNewlines = appendOnly ? (cached?.newlines ?? 0) : 0
    if (appendOnly) journalReadStats.tailParses += 1
    else journalReadStats.fullParses += 1

    const buffer = stat.size > start ? readRange(path, start, stat.size) : Buffer.alloc(0)

    const events = baseEvents
    let expected = baseEvents.length + 1
    let committed = start
    let committedNewlines = baseNewlines
    const committedEvents = copyEvents(baseEvents)
    // 锚点 = **最后一个被提交的完整行**（空行没有可比的原文，沿用上一个非空行）
    let anchor = appendOnly ? (cached?.anchor ?? '') : ''
    // 首行锚点：只在**全量重解析**时从文件头取（续读那一支沿用缓存里的，别拿尾巴冒充首行）
    let head = appendOnly ? (cached?.head ?? '') : ''
    let headEnd = appendOnly ? (cached?.headEnd ?? 0) : 0
    /**
     * 逐行：按 `\n` 的**字节位置**切（UTF-8 的多字节序列里不含 `0x0A` ⇒ 按字节切一定落在行边界），
     * 字节偏移因此**免费**得到 —— 不再对每一行算一次 `Buffer.byteLength`（那是冷路径的一笔纯开销）。
     * 只有**完整行**（以 `\n` 结尾）会被提交；最后一段没终结的字节留给下一次读。
     */
    let cursor = 0
    let lineIndex = 0
    for (let breakAt = buffer.indexOf(0x0a, 0); breakAt !== -1; breakAt = buffer.indexOf(0x0a, cursor)) {
      const raw = buffer.toString('utf8', cursor, breakAt)
      const lineNumber = baseNewlines + lineIndex + 1
      const bytes = breakAt + 1 - cursor
      if (raw.trim() !== '') {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return this.truncateAt(stat, events, lineNumber, committed, committedNewlines, head, headEnd)
        }
        journalReadStats.parsedLines += 1
        const event = parsed as Partial<JournalEvent>
        if (!isJournalEvent(event, expected)) {
          return this.truncateAt(stat, events, lineNumber, committed, committedNewlines, head, headEnd)
        }
        events.push(event as JournalEvent)
        committedEvents.push(event as JournalEvent)
        expected += 1
        anchor = raw
      }
      committed += bytes
      committedNewlines += 1
      if (!appendOnly && head === '' && raw.trim() !== '') {
        head = raw
        headEnd = committed
      }
      lineIndex += 1
      cursor = breakAt + 1
    }
    // 末行未终结（正在写）：**可以返回**（与慢路径一致），但**不进缓存**（它还会被续写）
    if (cursor < buffer.length) {
      const partial = buffer.toString('utf8', cursor, buffer.length)
      if (partial.trim() !== '') {
        const lineNumber = baseNewlines + lineIndex + 1
        let parsed: unknown
        try {
          parsed = JSON.parse(partial)
        } catch {
          return this.truncateAt(stat, events, lineNumber, committed, committedNewlines, head, headEnd)
        }
        journalReadStats.parsedLines += 1
        const event = parsed as Partial<JournalEvent>
        if (!isJournalEvent(event, expected)) {
          return this.truncateAt(stat, events, lineNumber, committed, committedNewlines, head, headEnd)
        }
        events.push(event as JournalEvent)
      }
    }
    this.commit(path, stat, committed, committedNewlines, committedEvents, anchor, head, headEnd)
    return { events, truncated: false }
  }

  /**
   * **锚点复算**：缓存里"首行 / 末行"的原文，与盘上对应区间逐字相同吗？
   *
   * 两发探针各读一行（几十~几百字节），比全量重解析便宜两三个数量级：
   *   · **末行探针**挡「就地整份重写且变长」（`size` 看不出来）；
   *   · **首行探针**挡「等长改写早期行 + 末行原样 + 再追加」—— 只钉末行时这一形态会被判成"续读"，
   *     于是**旧的早期事件被静默保留**（`REV-095` 必核二①，`M234-08` 钉住）。
   * 任何异常（读不到 / 长度对不上 / 锚点为空）一律判 **不匹配**（保守方向：宁可全量重解析）。
   */
  private anchorsMatch(path: string, cached: JournalCacheEntry): boolean {
    return anchorLineMatches(path, cached.consumed, cached.anchor)
      && anchorLineMatches(path, cached.headEnd, cached.head)
  }

  /**
   * **截断分支**：返回最后一个一致前缀，并把缓存**只登记到末个好行**为止。
   *
   * 为什么不把坏行之后的东西也缓存：文件修好之后（`store.writeText` ⇒ inode 变 ⇒ 本来也会全量重解析，
   * 但手写修复可能只是补上缺的字节、身份不变）下一次读必须能看到**完整**台账 —— 缓存停在末个好行
   * 就不会把"截断视图"固化成事实。
   */
  private truncateAt(
    stat: { dev: number; ino: number; size: number; mtimeMs: number },
    events: JournalEvent[],
    badLine: number,
    committed: number,
    committedNewlines: number,
    head: string,
    headEnd: number,
  ): JournalReadResult {
    // 缓存**停在末个好行**（`committed` = 它之后的字节偏移）；`size` 也记成这个前缀长度，
    // 于是下一次读会走「变长 ⇒ 续读尾部」那一支，从坏行处重新判定（不会把截断视图固化）。
    JOURNAL_CACHE.set(this.journalPath(), {
      dev: stat.dev,
      ino: stat.ino,
      consumed: committed,
      newlines: committedNewlines,
      events: copyEvents(events),
      size: committed,
      mtimeMs: stat.mtimeMs,
      // 两个锚点只登记到**末个好行**为止：坏行之后的字节不进缓存，也不进锚点
      anchor: committed === 0 ? '' : (JOURNAL_CACHE.get(this.journalPath())?.anchor ?? ''),
      head,
      headEnd,
    })
    // **`TASK-220`**：交出去的是**截断视图**（与全量慢路径一致的要求不变）⇒ 换代次，
    // 派生表按这一份重建（否则"截断前缀"会被缓存的派生表当成完整台账）
    bumpGeneration(this.journalPath())
    return { events, truncated: true, badLine }
  }

  /** 把一个已解析的前缀登记进缓存（`size` 记成**已消费的字节数**，不是文件大小）。 */
  private commit(
    path: string,
    stat: { dev: number; ino: number; size: number; mtimeMs: number },
    consumed: number,
    newlines: number,
    events: JournalEvent[],
    anchor: string,
    head: string,
    headEnd: number,
  ): void {
    // 尾部还有未终结的行 ⇒ 缓存只能停在最后一个完整行（`consumed` 已由调用方算好）
    JOURNAL_CACHE.set(path, {
      dev: stat.dev,
      ino: stat.ino,
      consumed,
      newlines,
      events,
      // 记账时按"已消费字节数"当 size 的等价物：只要文件不再变长、且身份与 mtime 不变，就算命中
      size: consumed,
      mtimeMs: stat.mtimeMs,
      anchor,
      head,
      headEnd,
    })
    // **`TASK-220`**：这是"真的解析过"的唯一收口（全量重解析 / 续读尾部都经过这里）⇒ 换代次。
    // 零解析命中在上面就 return 了，所以"没变就不换代"是自动成立的。
    bumpGeneration(path)
    if (JOURNAL_CACHE.size > JOURNAL_CACHE_LIMIT) {
      const oldest = JOURNAL_CACHE.keys().next()
      if (!oldest.done) JOURNAL_CACHE.delete(oldest.value)
    }
  }

  /**
   * 追加一条事件，返回落盘后的事件（含分配到的 seq）。
   *
   * **`TASK-213` 的两点改动（都在写路径上，语义不变）**：
   *   ① `seq` 分配从"读两遍 + 扫两遍全文"收成**一遍**（用同一份盘上文本同时算"截断前缀长度"与
   *      "盘上最大 seq"）—— 修前一次 `append` 要 3 次 `read()` + 2 次全文扫描；
   *   ② 落盘后**显式失效缓存**（`invalidate()`）：新鲜度不靠"下一次 stat 才发现"，
   *      而是写者自己保证 —— 这也是 DoD 里"任何 append/写入后必须失效"的那一条。
   */
  append(type: SdoEventType, data: Record<string, unknown>, actor = 'sdo'): JournalEvent {
    // **D2**：坏行是**半写行**（文件末尾无换行）时直接 append 会把新事件**粘在坏行后面** ⇒ 一行里两个 seq。
    // 先把行边界补齐（坏行留成独立的一行），再按补边界后的盘面算 seq。
    const before = this.store.readText(JOURNAL_FILE)
    if (before !== undefined && before !== '' && !before.endsWith('\n')) {
      this.store.appendLine([JOURNAL_FILE], '\n')
      this.markWritten()
    }
    // 一份文本同时给两件事用：截断前缀（`read()`，走缓存）与盘上最大 seq（坏行也要扫）
    const last = this.read()
    const text = this.store.readText(JOURNAL_FILE) ?? ''
    const event: JournalEvent = {
      // 截断期也不能分配重复 seq：取「截断前缀长度」与「盘上最大 seq」的较大者 + 1
      seq: Math.max(last.events.length, maxSeqOfText(text)) + 1,
      at: new Date().toISOString(),
      actor,
      type,
      data,
    }
    this.store.appendLine([JOURNAL_FILE], JSON.stringify(event))
    // **写者自己保证新鲜度**：不指望下一次 `stat` 才发现（缓存绝不交陈旧台账的第一道闸）。
    // 用 `markWritten()`（保留前缀、只作废长度）而不是 `invalidate()`（整条丢）——
    // 后者会让每次 append 之后的首读都全量重解析，等于白做本卡。
    this.markWritten()
    // 派生视图跟随真源：唯一写者在这里收口，避免"追加了事件但 project.json 还是旧的"。
    this.rebuild()
    return event
  }

  /** 由事件流折叠出项目台账（纯函数，便于单测）。 */
  static fold(events: readonly JournalEvent[]): SdoProject | undefined {
    let project: SdoProject | undefined
    for (const event of events) {
      switch (event.type) {
        case 'project/created': {
          const created = event.data['project'] as SdoProject | undefined
          if (created !== undefined) project = structuredClone(created)
          break
        }
        case 'project/updated': {
          if (project === undefined) break
          const patch = event.data['patch'] as Partial<SdoProject> | undefined
          if (patch === undefined) break
          project = { ...project, ...patch }
          break
        }
        case 'phase/entered': {
          if (project === undefined) break
          const phase = event.data['phase'] as SdoProject['phase']
          project = {
            ...project,
            phase,
            phaseHistory: [...project.phaseHistory, { phase, entered: event.at }],
          }
          break
        }
        case 'phase/exited': {
          if (project === undefined) break
          const phase = event.data['phase'] as SdoProject['phase']
          const history: PhaseRecord[] = project.phaseHistory.map((record) => {
            if (record.phase !== phase || record.exited !== undefined) return record
            return { ...record, exited: event.at }
          })
          project = { ...project, phaseHistory: history }
          break
        }
        case 'phase/rolled-back': {
          // **§6.1 阶段回退**：与 `phase/entered` 同口径地更新当前阶段，
          // 并在阶段历史上保留**回退原因**（谁、何时、因何回退、从哪退到哪）。
          if (project === undefined) break
          const from = event.data['from'] as string | undefined
          const to = event.data['to'] as SdoProject['phase'] | undefined
          if (typeof to !== 'string') break
          const reason = typeof event.data['reason'] === 'string' ? event.data['reason'] : ''
          const history: PhaseRecord[] = project.phaseHistory.map((record) => {
            if (record.phase !== from || record.exited !== undefined) return record
            return { ...record, exited: event.at, rolledBackTo: to, rollbackReason: reason }
          })
          project = {
            ...project,
            phase: to,
            phaseHistory: [...history, { phase: to, entered: event.at }],
          }
          break
        }
        case 'redteam/mode': {
          if (project === undefined) break
          const enabled = event.data['enabled'] === true
          const reason = event.data['reason']
          const state: RedTeamState = {
            enabled,
            scope: 'session',
            ...(typeof reason === 'string' ? { reason } : {}),
            at: event.at,
          }
          project = { ...project, redTeam: state }
          break
        }
        default:
          break
      }
    }
    return project
  }

  /** 读取投影；不存在则从 journal 重建（AC-006 / E2E-06）。 */
  loadProject(): { project: SdoProject | undefined; rebuilt: boolean; truncated: boolean; badLine?: number } {
    const cached = this.store.readJson<SdoProject>(PROJECT_FILE)
    const read = this.read()
    const result = {
      project: cached,
      rebuilt: false,
      truncated: read.truncated,
      ...(read.badLine === undefined ? {} : { badLine: read.badLine }),
    }
    if (cached !== undefined) return result
    const project = Journal.fold(read.events)
    // **§4.4**：投影缺失 **且** journal 被截断时只给内存视图、不落盘 ——
    // 否则"截断前缀"会被写成新事实，之后所有读路径都以它为准（静默回退的另一种入口）。
    if (project !== undefined && !read.truncated) this.store.writeJson([PROJECT_FILE], project)
    return { ...result, project, rebuilt: project !== undefined && !read.truncated }
  }

  /**
   * 重建投影并落盘；返回重建结果。
   *
   * **§4.4（第三份评审员报告，2026-10-02）**：`journal` 里出现**坏行**时（`read()` 会截断到
   * 最后一致前缀），**绝不能**用"截断前缀的折叠结果"覆盖已有投影 —— 实测后果是**静默回退**：
   * 崩溃半写留下一行坏 JSON 之后，任何一次写操作（`append() → rebuild()`）都会把
   * `project.json` 从 `architecture` 打回 `intake`，而 journal 里坏行之后的事件其实都还在。
   * 现在：`truncated && !force` 时**保留最后一份良好投影**，并把 `skipped` 如实回报；
   * 只有**显式入口**（`sdo_status --rebuild` → `office.rebuild` 传 `force`）才允许强制重建 ——
   * 那时是用户明确要求在"真源不完整"的前提下重建。
   */
  rebuild(options: { force?: boolean } = {}): {
    project: SdoProject | undefined
    truncated: boolean
    badLine?: number
    /** 因 journal 被截断而**拒绝覆盖**已有投影（保留了最后一份良好投影）。 */
    skipped?: boolean
  } {
    const read = this.read()
    const badLine = read.badLine === undefined ? {} : { badLine: read.badLine }
    if (read.truncated && options.force !== true) {
      // 已有投影 → 保留它（真源不可信时，派生投影不该被"部分真源"覆盖）
      const cachedProject = this.store.readJson<SdoProject>(PROJECT_FILE)
      if (cachedProject !== undefined) {
        return { project: cachedProject, truncated: true, ...badLine, skipped: true }
      }
      // 没有投影可保留：折叠出一份**内存视图**，但**不落盘**（不把截断状态固化成事实）
      return { project: Journal.fold(read.events), truncated: true, ...badLine, skipped: true }
    }
    const project = Journal.fold(read.events)
    if (project !== undefined) this.store.writeJson([PROJECT_FILE], project)
    return { project, truncated: read.truncated, ...badLine }
  }
}

/**
 * **盘上文本里最大的 `seq`**（坏行也要扫 —— `D2` 的教训；纯函数，便于单测与复用）。
 *
 * **§3.1 二阶（第四份评审员报告）**：`read()` 在坏行处截断，若用「截断前缀长度 + 1」分配新 `seq`，
 * 截断期写入的事件会拿到一个**与既有事件重复（甚至更小）的 seq** —— 那不仅让"签字之后改过真源"
 * 这类**基于 seq 比较**的判定继续瞎（实测：修好 journal 后失效事件仍被忽略、签字继续报 `valid`），
 * 还破坏了本条真源"seq 单调"的硬不变量。所以分配 `seq` 必须看**盘上全文**，而不是截断后的视图。
 *
 * 为什么它必须看**全文**而不是缓存前缀：截断期若按「前缀长度 + 1」分配，新事件会拿到一个与坏行
 * 重复的 `seq`（真机后果：签字之后改过真源仍被判 `valid`）。
 */
function maxSeqOfText(text: string): number {
  let max = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as { seq?: unknown }
      if (typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) && parsed.seq > max) max = parsed.seq
    } catch {
      // **D2（整仓评审 blocker）**：坏行**也可能声明了 seq**（半写行里 `"seq":4` 是完整的）——
      // 旧实现整行跳过 ⇒ 「截断前缀长度 + 1」正好撞上它的号。退一步扫原始文本，扫不到才真的跳过。
      const claimed = /"seq"\s*:\s*(\d+)/u.exec(trimmed)
      if (claimed !== null) {
        const value = Number(claimed[1])
        if (Number.isFinite(value) && value > max) max = value
      }
    }
  }
  return max
}
