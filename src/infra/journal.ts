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

/** 追加日志与投影的唯一入口。 */
export class Journal {
  constructor(private readonly store: SdoStore) {}

  /** 读取全部事件；遇到损坏行即停止并标记。 */
  read(): JournalReadResult {
    const text = this.store.readText(JOURNAL_FILE)
    if (text === undefined) return { events: [], truncated: false }

    const events: JournalEvent[] = []
    const lines = text.split('\n')
    let expected = 1
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? ''
      if (raw.trim() === '') continue
      // 最后一行可能正在写：长度不足视为截断
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { events, truncated: true, badLine: i + 1 }
      }
      const event = parsed as Partial<JournalEvent>
      if (
        typeof event.seq !== 'number' ||
        event.seq !== expected ||
        typeof event.at !== 'string' ||
        typeof event.type !== 'string' ||
        typeof event.data !== 'object' ||
        event.data === null
      ) {
        return { events, truncated: true, badLine: i + 1 }
      }
      events.push(event as JournalEvent)
      expected++
    }
    return { events, truncated: false }
  }

  /**
   * 盘上**所有**可解析事件里最大的 `seq`（坏行跳过）。
   *
   * **§3.1 二阶（第四份评审员报告）**：`read()` 在坏行处截断，若用「截断前缀长度 + 1」分配新 `seq`，
   * 截断期写入的事件会拿到一个**与既有事件重复（甚至更小）的 seq** —— 那不仅让"签字之后改过真源"
   * 这类**基于 seq 比较**的判定继续瞎（实测：修好 journal 后失效事件仍被忽略、签字继续报 `valid`），
   * 还破坏了本条真源"seq 单调"的硬不变量。所以分配 `seq` 必须看**盘上全文**，而不是截断后的视图。
   */
  private maxSeqOnDisk(): number {
    const text = this.store.readText(JOURNAL_FILE)
    if (text === undefined) return 0
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

  /** 追加一条事件，返回落盘后的事件（含分配到的 seq）。 */
  append(type: SdoEventType, data: Record<string, unknown>, actor = 'sdo'): JournalEvent {
    const last = this.read()
    // 截断期也不能分配重复 seq：取「截断前缀长度」与「盘上最大 seq」的较大者 + 1
    const event: JournalEvent = {
      seq: Math.max(last.events.length, this.maxSeqOnDisk()) + 1,
      at: new Date().toISOString(),
      actor,
      type,
      data,
    }
    // **D2**：坏行是**半写行**（文件末尾无换行）时直接 append 会把新事件**粘在坏行后面** ⇒ 一行里两个 seq。
    // 先把行边界补齐（坏行留成独立的一行），再**重新**按补边界后的盘面算 seq。
    const existing = this.store.readText(JOURNAL_FILE)
    if (existing !== undefined && existing !== '' && !existing.endsWith('\n')) {
      this.store.appendLine([JOURNAL_FILE], '\n')
    }
    event.seq = Math.max(this.read().events.length, this.maxSeqOnDisk()) + 1
    this.store.appendLine([JOURNAL_FILE], JSON.stringify(event))
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
