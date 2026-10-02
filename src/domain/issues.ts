/**
 * 红队议题（`.sdo/issues/REQ-ISSUE-*.yml`，设计 §5.4）。
 *
 * 设计纪律：**红队输出缺陷式条目，每条必须回到需求或转为风险，不允许"仅供参考"**。
 * 因此本模块的闭环规则是硬的：
 *   · 议题覆盖的全部质询问题都已回答/作废 → 视为闭环（回到需求）；
 *   · 或者议题被显式处置为 `risk` / `requirement`（带说明）→ 视为闭环。
 * 两者都不满足时，门禁 G2 的 `redteam.closed` 会拒绝基线。
 */
import { nextId } from '../infra/ids.js'
import { pushShapeNote, textListOf, textOf, typeNameOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import { isEffectivelyOpen } from './dor.js'
import type { GrillQuestion, RedTeamIssue, RiskItem } from '../types.js'

export function listIssueIds(store: SdoStore): string[] {
  return store
    .listNames('issues')
    .filter((name) => /^REQ-ISSUE-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

/**
 * 读一条红队议题并**做形状归一化**（F-21 ①）。
 *
 * `.sdo/issues/REQ-ISSUE-*.yml` 是手可编辑真源，两个列表位置：`angles` 与 `questionIds`
 * （闭环判定用 `issue.questionIds.includes(...)`，手写成标量即抛异常）。标量 → 单元素 + 提示；
 * 映射 → 空 + 提示（**不猜**）。
 */
export function readIssueChecked(store: SdoStore, id: string): { issue: RedTeamIssue | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ issue: unknown }>('issues', `${id}.yml`)?.issue
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) {
      pushShapeNote(notes, 'issue', id, 'issue', { position: 'map', actualType: typeNameOf(raw), handling: 'empty', text: textOf(raw) })
    }
    return { issue: undefined, notes }
  }
  const record = raw as Record<string, unknown>
  const angles = textListOf(record.angles)
  pushShapeNote(notes, 'issue', id, 'angles', angles.issue)
  const questionIds = textListOf(record.questionIds)
  pushShapeNote(notes, 'issue', id, 'questionIds', questionIds.issue)
  const declaredId = textOf(record.id)
  const issue: RedTeamIssue = {
    ...(record as unknown as RedTeamIssue),
    id: declaredId.trim() === '' ? id : declaredId,
    target: textOf(record.target),
    angles: angles.value,
    questionIds: questionIds.value,
    status: textOf(record.status) as RedTeamIssue['status'],
    disposition: textOf(record.disposition) as RedTeamIssue['disposition'],
    note: textOf(record.note),
    at: textOf(record.at),
  }
  return { issue, notes }
}

export function readIssue(store: SdoStore, id: string): RedTeamIssue | undefined {
  return readIssueChecked(store, id).issue
}

/** 全部红队议题上的形状提示（回执 / 门禁详情共用）。 */
export function issueShapeNotes(store: SdoStore): FieldShapeNote[] {
  const notes: FieldShapeNote[] = []
  for (const id of listIssueIds(store)) notes.push(...readIssueChecked(store, id).notes)
  return notes
}

export function listIssues(store: SdoStore): RedTeamIssue[] {
  const out: RedTeamIssue[] = []
  for (const id of listIssueIds(store)) {
    const issue = readIssue(store, id)
    if (issue !== undefined) out.push(issue)
  }
  return out
}

export function writeIssue(store: SdoStore, issue: RedTeamIssue): void {
  store.writeYaml(['issues', `${issue.id}.yml`], { issue })
}

export interface OpenIssueInput {
  target: string
  angles: string[]
  questionIds: string[]
}

/** 为一条需求开一个红队议题（同一需求同时只保留一个未闭环议题）。 */
export function openIssue(store: SdoStore, journal: Journal, input: OpenIssueInput): RedTeamIssue {
  const existing = listIssues(store).find((issue) => issue.target === input.target && issue.status === 'open')
  if (existing !== undefined) {
    const merged: RedTeamIssue = {
      ...existing,
      angles: [...new Set([...existing.angles, ...input.angles])],
      questionIds: [...new Set([...existing.questionIds, ...input.questionIds])],
    }
    writeIssue(store, merged)
    return merged
  }
  const issue: RedTeamIssue = {
    id: nextId('REQ-ISSUE', listIssueIds(store)),
    target: input.target,
    angles: input.angles,
    questionIds: input.questionIds,
    status: 'open',
    disposition: 'none',
    note: '',
    at: new Date().toISOString(),
  }
  writeIssue(store, issue)
  journal.append('issue/opened', { id: issue.id, target: issue.target, angles: issue.angles.length })
  return issue
}

/**
 * 闭环判定：返回还差什么。
 *
 * **N-1**：未决口径必须与 G2 的 C2（`dor.ts` 的 `isEffectivelyOpen`）**同一把尺子** ——
 * 旧实现只看 `status === 'open'`，于是把质询问题手改成 `status: assumed` 而不带
 * `authorizedByUser: true` 时，C2 判红而这里判"已全部回答"：同一个门禁里两条判据对同一份
 * 数据给出相反语义，理由还写着错的（"已回答"，其实是"被降级成未授权假设"）。
 */
export function issueClosure(
  issue: RedTeamIssue,
  questions: GrillQuestion[],
  risks: RiskItem[] = [],
): { closed: boolean; openQuestionIds: string[]; reason: string } {
  const related = questions.filter((question) => issue.questionIds.includes(question.id))
  const openQuestionIds = related.filter((question) => isEffectivelyOpen(question)).map((question) => question.id)
  const downgraded = related.filter((question) => question.status === 'assumed' && !isEffectivelyOpen(question))
  if (issue.disposition !== 'none') {
    return { closed: true, openQuestionIds, reason: `已处置为 ${issue.disposition}` }
  }
  // 「转为风险」也算闭环：风险登记里有一条 origin 指向本议题即可（设计 §5.4：回到需求或转为风险）
  const converted = risks.filter((risk) => risk.origin === issue.id)
  if (converted.length > 0) {
    return { closed: true, openQuestionIds, reason: `已转为风险 ${converted.map((risk) => risk.id).join(' ')}` }
  }
  if (openQuestionIds.length === 0) {
    return {
      closed: true,
      openQuestionIds,
      reason: downgraded.length === 0
        ? '质询问题已全部回答（回到需求）'
        : `质询问题已全部回答（回到需求）；其中 ${downgraded.length} 条被记为未获用户授权的假设，按未决口径处理`,
    }
  }
  return { closed: false, openQuestionIds, reason: `仍有 ${openQuestionIds.length} 个质询问题未回答` }
}

/** 未闭环的议题（门禁与展示用）。 */
export function openIssues(
  store: SdoStore,
  questions: GrillQuestion[],
  risks: RiskItem[] = [],
): { issue: RedTeamIssue; reason: string }[] {
  const out: { issue: RedTeamIssue; reason: string }[] = []
  for (const issue of listIssues(store)) {
    const closure = issueClosure(issue, questions, risks)
    if (!closure.closed) out.push({ issue, reason: closure.reason })
  }
  return out
}

/** 显式处置一个议题（转为风险 / 回到需求），写 `issue/closed`。 */
export function disposeIssue(
  store: SdoStore,
  journal: Journal,
  id: string,
  disposition: 'risk' | 'requirement',
  note: string,
): RedTeamIssue | undefined {
  const current = readIssue(store, id)
  if (current === undefined) return undefined
  const next: RedTeamIssue = { ...current, disposition, note, status: 'closed' }
  writeIssue(store, next)
  journal.append('issue/closed', { id, disposition, note })
  return next
}
