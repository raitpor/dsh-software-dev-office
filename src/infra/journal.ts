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

  /** 追加一条事件，返回落盘后的事件（含分配到的 seq）。 */
  append(type: SdoEventType, data: Record<string, unknown>, actor = 'sdo'): JournalEvent {
    const last = this.read()
    const event: JournalEvent = {
      seq: last.events.length + 1,
      at: new Date().toISOString(),
      actor,
      type,
      data,
    }
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
    if (project !== undefined) this.store.writeJson([PROJECT_FILE], project)
    return { ...result, project, rebuilt: project !== undefined }
  }

  /** 显式重建投影并落盘；返回重建结果。 */
  rebuild(): { project: SdoProject | undefined; truncated: boolean } {
    const read = this.read()
    const project = Journal.fold(read.events)
    if (project !== undefined) this.store.writeJson([PROJECT_FILE], project)
    return { project, truncated: read.truncated }
  }
}
