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
  /** 实际 `JSON.parse` 过的台账行数 —— 本卡最有说服力的那一个数 */
  parsedLines: 0,
}

/** 清零计数器（守卫与复现脚本用；不影响缓存内容）。 */
export function resetJournalReadStats(): void {
  journalReadStats.readCalls = 0
  journalReadStats.cacheHits = 0
  journalReadStats.tailParses = 0
  journalReadStats.fullParses = 0
  journalReadStats.parsedLines = 0
}

/** 丢掉某个台账的缓存（缺省 = 全部）。**显式失效入口**，`append` 之后也会自动调它。 */
export function invalidateJournalCache(path?: string): void {
  if (path === undefined) JOURNAL_CACHE.clear()
  else JOURNAL_CACHE.delete(path)
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

/** 追加日志与投影的唯一入口。 */
export class Journal {
  constructor(private readonly store: SdoStore) {}

  /** 本台账文件路径（缓存键）。 */
  private journalPath(): string {
    return this.store.path(JOURNAL_FILE)
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
    if (entry === undefined) return
    entry.size = -1
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
    if (stat === undefined || !stat.isFile()) {
      JOURNAL_CACHE.delete(path)
      return { events: [], truncated: false }
    }

    const cached = JOURNAL_CACHE.get(path)
    const sameIdentity = cached !== undefined && cached.dev === stat.dev && cached.ino === stat.ino
    const sameSize = sameIdentity && cached.size === stat.size
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
     * 「变长」本身不证明"前面那段没被改写"，所以续读前先回读 `consumed` 之前的最后一行，
     * 与缓存里记的原文逐字比对：对不上就是改写，直接走全量重解析。
     */
    const grew = cached !== undefined && sameIdentity && stat.size > cached.consumed
    const appendOnly = grew && cached !== undefined && this.anchorMatches(path, cached)
    const start = appendOnly ? (cached?.consumed ?? 0) : 0
    const baseEvents = appendOnly ? copyEvents(cached?.events ?? []) : []
    const baseNewlines = appendOnly ? (cached?.newlines ?? 0) : 0
    if (appendOnly) journalReadStats.tailParses += 1
    else journalReadStats.fullParses += 1

    let chunk = ''
    if (stat.size > start) {
      const length = stat.size - start
      const fd = openSync(path, 'r')
      try {
        const buffer = Buffer.allocUnsafe(length)
        const got = readSync(fd, buffer, 0, length, start)
        chunk = buffer.subarray(0, got).toString('utf8')
      } finally {
        closeSync(fd)
      }
    }

    const events = baseEvents
    let expected = baseEvents.length + 1
    let committed = start
    let committedNewlines = baseNewlines
    const committedEvents = copyEvents(baseEvents)
    // 只把**完整行**（以 `\n` 结尾）交给缓存；最后一段没终结的字节留给下一次读
    const lastBreak = chunk.lastIndexOf('\n')
    const complete = lastBreak === -1 ? '' : chunk.slice(0, lastBreak + 1)
    const partial = lastBreak === -1 ? chunk : chunk.slice(lastBreak + 1)
    const parts = complete === '' ? [] : complete.split('\n').slice(0, -1)
    // 锚点 = **最后一个被提交的完整行**（空行没有可比的原文，沿用上一个非空行）
    let anchor = appendOnly ? (cached?.anchor ?? '') : ''
    for (const [index, raw] of parts.entries()) {
      const lineNumber = baseNewlines + index + 1
      const bytes = Buffer.byteLength(raw) + 1
      if (raw.trim() !== '') {
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return this.truncateAt(stat, events, lineNumber, committed, committedNewlines)
        }
        journalReadStats.parsedLines += 1
        const event = parsed as Partial<JournalEvent>
        if (!isJournalEvent(event, expected)) {
          return this.truncateAt(stat, events, lineNumber, committed, committedNewlines)
        }
        events.push(event as JournalEvent)
        committedEvents.push(event as JournalEvent)
        expected += 1
        anchor = raw
      }
      committed += bytes
      committedNewlines += 1
    }
    // 末行未终结（正在写）：**可以返回**（与慢路径一致），但**不进缓存**（它还会被续写）
    if (partial.trim() !== '') {
      const lineNumber = baseNewlines + parts.length + 1
      let parsed: unknown
      try {
        parsed = JSON.parse(partial)
      } catch {
        return this.truncateAt(stat, events, lineNumber, committed, committedNewlines)
      }
      journalReadStats.parsedLines += 1
      const event = parsed as Partial<JournalEvent>
      if (!isJournalEvent(event, expected)) {
        return this.truncateAt(stat, events, lineNumber, committed, committedNewlines)
      }
      events.push(event as JournalEvent)
    }
    this.commit(path, stat, committed, committedNewlines, committedEvents, anchor)
    return { events, truncated: false }
  }

  /**
   * **锚点复算**：缓存里"末个完整行"的原文，与盘上 `[consumed - 该行长度, consumed)` 逐字相同吗？
   *
   * 只读那一行（几十~几百字节），比全量重解析便宜两三个数量级，却能把「就地整份重写且更长」这种
   * 靠 `size` 看不出来的形态挡住。任何异常（读不到/长度对不上）一律判 **不匹配**（保守方向）。
   */
  private anchorMatches(path: string, cached: JournalCacheEntry): boolean {
    if (cached.anchor === '' || cached.consumed <= 0) return cached.consumed === 0
    const bytes = Buffer.byteLength(cached.anchor)
    // `consumed` 是**行尾换行之后**的偏移 ⇒ 该行正文在 [consumed - bytes - 1, consumed - 1)
    if (cached.consumed < bytes + 1) return false
    let fd: number | undefined
    try {
      fd = openSync(path, 'r')
      const buffer = Buffer.allocUnsafe(bytes)
      const got = readSync(fd, buffer, 0, bytes, cached.consumed - bytes - 1)
      return got === bytes && buffer.toString('utf8') === cached.anchor
    } catch {
      return false
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
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
      anchor: JOURNAL_CACHE.get(this.journalPath())?.anchor ?? '',
    })
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
    })
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
