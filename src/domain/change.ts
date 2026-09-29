/**
 * 基线与变更控制（CCB-lite，设计 §5.5）。
 *
 * 纪律：
 *   · **基线后**任何需求修改都必须走变更请求（CR），不允许直接改（否则门禁形同虚设）；
 *   · CR 必须含：变更内容、理由、**影响分析**、决策（批准/拒绝/延期）；
 *   · 影响分析**自动**来自追溯图（M2 建图；此处先读已存在的 `.sdo/trace/links.jsonl`）。
 */
import { nextId } from '../infra/ids.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { ChangeRequest, Requirement } from '../types.js'

export const TRACE_FILE = 'trace/links.jsonl'

interface TraceLink {
  from: string
  to: string
  kind?: string
}

export function listChangeIds(store: SdoStore): string[] {
  return store
    .listNames('changes')
    .filter((name) => /^CR-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

export function readChange(store: SdoStore, id: string): ChangeRequest | undefined {
  return store.readYaml<{ change: ChangeRequest }>('changes', `${id}.yml`)?.change
}

export function listChanges(store: SdoStore): ChangeRequest[] {
  const out: ChangeRequest[] = []
  for (const id of listChangeIds(store)) {
    const change = readChange(store, id)
    if (change !== undefined) out.push(change)
  }
  return out
}

export function writeChange(store: SdoStore, change: ChangeRequest): void {
  store.writeYaml(['changes', `${change.id}.yml`], { change })
}

/** 读追溯图（不存在就返回空；M2 起由 `sdo_trace` 写入）。 */
export function readTraceLinks(store: SdoStore): TraceLink[] {
  const text = store.readText(TRACE_FILE)
  if (text === undefined) return []
  const links: TraceLink[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as TraceLink
      if (typeof parsed.from === 'string' && typeof parsed.to === 'string') links.push(parsed)
    } catch {
      // 追溯图里的坏行不影响变更流程
    }
  }
  return links
}

/** 影响分析：从追溯图里找出引用了该需求的 DES / TASK / TC。 */
export function traceImpact(store: SdoStore, requirementId: string): ChangeRequest['impact'] {
  const links = readTraceLinks(store)
  const design: string[] = []
  const tasks: string[] = []
  const tests: string[] = []
  for (const link of links) {
    const touches = link.from === requirementId || link.to === requirementId
    if (!touches) continue
    const other = link.from === requirementId ? link.to : link.from
    if (other.startsWith('DES-') || other.startsWith('ADR-') || other.startsWith('CT-')) design.push(other)
    else if (other.startsWith('TASK-')) tasks.push(other)
    else if (other.startsWith('TC-')) tests.push(other)
  }
  const note =
    links.length === 0
      ? '追溯图为空（M2 起由 `sdo_trace` 自动维护），本次影响分析只能给出空集——批准前请人工确认受影响范围'
      : `基于追溯图（${links.length} 条链接）自动算出`
  return {
    design: [...new Set(design)],
    tasks: [...new Set(tasks)],
    tests: [...new Set(tests)],
    note,
  }
}

export interface CreateChangeInput {
  requirement: string
  reason: string
  changes: string[]
  /** 批准时要应用到需求上的字段补丁（拒绝/延期时不应用） */
  patch?: Partial<Pick<Requirement, 'title' | 'statement' | 'rationale' | 'priority' | 'kind'>> | undefined
  /** 决策；`rejected` 时**不应用**变更（只留档） */
  decision: ChangeRequest['decision']
  decidedBy: string
}

/** 建立一条变更请求（`change/requested`，并按其决策写 `change/decided`）。 */
export function createChange(store: SdoStore, journal: Journal, input: CreateChangeInput): ChangeRequest {
  const change: ChangeRequest = {
    id: nextId('CR', listChangeIds(store)),
    requirement: input.requirement,
    reason: input.reason,
    changes: input.changes,
    impact: traceImpact(store, input.requirement),
    decision: input.decision,
    decidedBy: input.decidedBy,
    at: new Date().toISOString(),
  }
  writeChange(store, change)
  journal.append('change/requested', {
    id: change.id,
    requirement: change.requirement,
    impact: change.impact,
  })
  journal.append('change/decided', { id: change.id, decision: change.decision, by: change.decidedBy })
  return change
}
