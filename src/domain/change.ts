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
import { designExitGates } from './process.js'
import { readLinksChecked } from './trace.js'
import { pushShapeNote, recordOf, textListOf, textOf, typeNameOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { ChangeRequest, Dimension, ProcessDef, Requirement } from '../types.js'

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

/**
 * **未消化的需求变更**（语义 A，2026-10-04）。
 *
 * 动机（真机证据）：`CR-001` 批准后 23 秒，`TASK-041` 照常被认领并被派发 —— 变更控制只
 * "登记 + 决策 + 算影响面"，**不改阶段、不碰基线**，于是"需求变了"对开发阶段没有任何约束，
 * 受影响的那条需求就变成"让模型自由发挥"。本函数把"变了但还没重走一遍"变成**可机械判定**的事实。
 *
 * 判据（全部从 journal 现算，不新增真源；两侧都满足才算消化）：
 *   ① **重新基线**：批准之后存在一条 `requirement/baselined`，且它覆盖该 CR 的受影响需求
 *      （`ids` 含它）。注意 N-14：内容没变的需求重新基线**不写事件** —— 因此"没真改需求就重基线"
 *      消化不掉，这正是我们要的；
 *   ② **重过设计门**：那条重新基线**之后**还有一条设计门（需求阶段之后那个阶段的 exit，
 *      四个随包流程都是 G3）的 `gate/result`，且结论是 `passed` / `waived`。
 *      只看 ① 是不够的：G2 重签后阶段回到架构，但设计一行没动、G3 没重过，这时仍不许开工。
 *
 * 口径与失效机制**同源**：`requirement/updated` / `requirement/baselined` 本来就让旧 G3 签字失效，
 * 所以"重签"不是本函数额外要求的仪式，而是既有签字机制的必然结果。
 */
export interface UndigestedChange {
  id: string
  /** 受影响需求（以变更单文件为准；读不到时退回 `change/requested` 事件里的那份） */
  requirement: string
  /** `change/decided(approved)` 的 journal 序号 */
  approvedSeq: number
  /** 批准之后覆盖该需求的重新基线序号；`undefined` = 还没重签 G2 */
  rebaselinedSeq?: number | undefined
}

/** `requirement/baselined` 事件的 `ids` 归一（手写坏形状只当"没覆盖"）。 */
function eventIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => textOf(item)).filter((item) => item !== '')
}

/**
 * 列出**已批准但尚未消化**的需求变更（空数组 = 可以继续开发）。
 *
 * `process` 用于取"设计门"；`undefined` 或流程数据里找不到需求阶段时只按 ① 判定
 * （拿不到设计门 ≠ 设计门不存在，此时不假装它过了 —— 见回执里的口径说明）。
 */
export function undigestedChanges(
  store: SdoStore,
  journal: Journal,
  process: ProcessDef | undefined,
): UndigestedChange[] {
  const read = journal.read()
  const requested = new Map<string, string>()
  const approved: { id: string; seq: number }[] = []
  for (const event of read.events) {
    if (event.type === 'change/requested') {
      const id = textOf(event.data['id'])
      const requirement = textOf(event.data['requirement'])
      if (id !== '' && requirement !== '') requested.set(id, requirement)
      continue
    }
    if (event.type !== 'change/decided') continue
    // 只有 `approved` 才逼着重走：「拒绝/延期」不动阶段，也不该拦住正在进行的开发
    if (textOf(event.data['decision']) !== 'approved') continue
    const id = textOf(event.data['id'])
    if (id !== '') approved.push({ id, seq: event.seq })
  }
  if (approved.length === 0) return []
  const designGates = new Set(process === undefined ? [] : designExitGates(process))
  const baselines = read.events.filter((event) => event.type === 'requirement/baselined')
  const designPassed = read.events.filter(
    (event) =>
      event.type === 'gate/result' &&
      designGates.has(textOf(event.data['gate'])) &&
      (event.data['status'] === 'passed' || event.data['status'] === 'waived'),
  )
  const out: UndigestedChange[] = []
  for (const item of approved) {
    const declared = textOf(readChange(store, item.id)?.requirement)
    const requirement = declared.trim() !== '' ? declared : (requested.get(item.id) ?? '')
    const baseline = baselines.find(
      (event) => event.seq > item.seq && (requirement === '' || eventIds(event.data['ids']).includes(requirement)),
    )
    if (baseline === undefined) {
      out.push({ id: item.id, requirement, approvedSeq: item.seq })
      continue
    }
    // 设计门拿不到时（流程数据没有需求阶段）不假装它过了，也不假红：只按 ① 判定。
    if (designGates.size > 0 && !designPassed.some((event) => event.seq > baseline.seq)) {
      out.push({ id: item.id, requirement, approvedSeq: item.seq, rebaselinedSeq: baseline.seq })
    }
  }
  return out
}

/** 未消化的变更 → 人读详情（`claim` 的拒绝理由；点名 CR 与下一步做什么，不含糊）。 */
export function describeUndigestedChanges(changes: UndigestedChange[], process: ProcessDef | undefined): string {
  const designGates = (process === undefined ? [] : designExitGates(process)).join(' / ') || 'G3'
  const lines = [fmt('uiChange.notDigestedTitle', { p1: changes.map((item) => item.id).join('、') })]
  for (const item of changes) {
    lines.push(
      item.rebaselinedSeq === undefined
        ? fmt('uiChange.notDigestedNoBaseline', {
            p1: item.id,
            p2: item.requirement === '' ? t('uiChange.notDigestedNoRequirement') : item.requirement,
          })
        : fmt('uiChange.notDigestedNoRedesign', { p1: item.id, p2: item.requirement, p3: designGates }),
    )
  }
  lines.push(t('uiChange.notDigestedSteps'))
  return lines.join('\n')
}
