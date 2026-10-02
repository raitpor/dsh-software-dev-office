/**
 * 基线与变更控制（CCB-lite，设计 §5.5）。
 *
 * 纪律：
 *   · **基线后**任何需求修改都必须走变更请求（CR），不允许直接改（否则门禁形同虚设）；
 *   · CR 必须含：变更内容、理由、**影响分析**、决策（批准/拒绝/延期）；
 *   · 影响分析**自动**来自追溯图（M2 建图；此处先读已存在的 `.sdo/trace/links.jsonl`）。
 */
import { nextId } from '../infra/ids.js'
import { fmt, t } from './i18n.js'
import { readLinksChecked } from './trace.js'
import { pushShapeNote, recordOf, textListOf, textOf, typeNameOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { ChangeRequest, Dimension, Requirement } from '../types.js'

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

/**
 * 读一条变更请求并**做形状归一化**（F-21 ①）。
 *
 * `.sdo/changes/CR-*.yml` 是手可编辑真源：`changes`（列表）与 `impact`（映射，内含
 * design/tasks/tests 三个列表 + note）。回执与门禁会读 `impact.design.join` 这类表达式，
 * 手写 `impact: 无影响` 即抛异常。口径与其它实体一致（标量→单元素 + 提示；映射→空 + 提示）。
 */
export function readChangeChecked(
  store: SdoStore,
  id: string,
): { change: ChangeRequest | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ change: unknown }>('changes', `${id}.yml`)?.change
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) {
      pushShapeNote(notes, 'change', id, 'change', { position: 'map', actualType: typeNameOf(raw), handling: 'empty', text: textOf(raw) })
    }
    return { change: undefined, notes }
  }
  const record = raw as Record<string, unknown>
  const changes = textListOf(record.changes)
  pushShapeNote(notes, 'change', id, 'changes', changes.issue)
  const impactRaw = recordOf(record.impact)
  pushShapeNote(notes, 'change', id, 'impact', impactRaw.issue)
  const impactList = (field: string): string[] => {
    const read = textListOf(impactRaw.value[field])
    pushShapeNote(notes, 'change', id, `impact.${field}`, read.issue)
    return read.value
  }
  const declaredId = textOf(record.id)
  const change: ChangeRequest = {
    ...(record as unknown as ChangeRequest),
    id: declaredId.trim() === '' ? id : declaredId,
    requirement: textOf(record.requirement),
    reason: textOf(record.reason),
    changes: changes.value,
    impact: {
      design: impactList('design'),
      tasks: impactList('tasks'),
      tests: impactList('tests'),
      note: textOf(impactRaw.value['note']),
    },
    decision: textOf(record.decision) as ChangeRequest['decision'],
    decidedBy: textOf(record.decidedBy),
    at: textOf(record.at),
  }
  return { change, notes }
}

export function readChange(store: SdoStore, id: string): ChangeRequest | undefined {
  return readChangeChecked(store, id).change
}

/** 全部变更请求上的形状提示（回执 / 门禁详情共用）。 */
export function changeShapeNotes(store: SdoStore): FieldShapeNote[] {
  const notes: FieldShapeNote[] = []
  for (const id of listChangeIds(store)) notes.push(...readChangeChecked(store, id).notes)
  return notes
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

/**
 * 读追溯图（**P-10：只保留一份解析器**）。
 *
 * 旧实现自己抄了一份 JSON 解析：两边口径不同 —— 这里只查 `from`/`to` 是字符串、
 * 不查 `kind`，于是"缺 kind"的行会被本函数当**正常边**计入（影响面虚增），
 * 却被 `trace.ts` 算作坏行（喂 C-21）。现在直接复用 `trace.readLinksChecked`。
 */
export function readTraceLinksChecked(store: SdoStore): { links: TraceLink[]; badLines: number } {
  const { links, badLines } = readLinksChecked(store)
  return { links, badLines }
}

/** 读追溯图（只取链接；需要知道坏行数时用 {@link readTraceLinksChecked}）。 */
export function readTraceLinks(store: SdoStore): TraceLink[] {
  return readTraceLinksChecked(store).links
}

/** 影响分析：从追溯图里找出引用了该需求的 DES / TASK / TC。 */
export function traceImpact(store: SdoStore, requirementId: string): ChangeRequest['impact'] {
  const { links, badLines } = readTraceLinksChecked(store)
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
      ? t('uiChange.impactNoteEmpty')
      : badLines === 0
        ? fmt('uiChange.impactNoteOk', { p1: String(links.length) })
        : `${fmt('uiChange.impactNoteOk', { p1: String(links.length) })}${fmt('uiChange.impactNoteBadLines', { p1: String(badLines) })}`
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
  /**
   * 变更后重算评分时，**模型通道**的语义分（§6.7）。
   *
   * 不给则**沿用需求上已落盘的** `ambiguity.modelDimensions`（规则维度照旧按新内容重算）。
   * 旧实现两条都没做：重算时完全不传模型维度 → 语义分被规则基线抹掉
   * （实测 15 → 9，`data`/`interface` 归零），"变更 → 重新基线"随即被 C1 误拦。
   */
  dimensions?: Partial<Record<Dimension, number>> | undefined
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
