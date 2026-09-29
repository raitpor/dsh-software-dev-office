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
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { GrillQuestion, RedTeamIssue, RiskItem } from '../types.js'

export function listIssueIds(store: SdoStore): string[] {
  return store
    .listNames('issues')
    .filter((name) => /^REQ-ISSUE-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

export function readIssue(store: SdoStore, id: string): RedTeamIssue | undefined {
  return store.readYaml<{ issue: RedTeamIssue }>('issues', `${id}.yml`)?.issue
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

/** 闭环判定：返回还差什么。 */
export function issueClosure(
  issue: RedTeamIssue,
  questions: GrillQuestion[],
  risks: RiskItem[] = [],
): { closed: boolean; openQuestionIds: string[]; reason: string } {
  const openQuestionIds = questions
    .filter((question) => issue.questionIds.includes(question.id) && question.status === 'open')
    .map((question) => question.id)
  if (issue.disposition !== 'none') {
    return { closed: true, openQuestionIds, reason: `已处置为 ${issue.disposition}` }
  }
  // 「转为风险」也算闭环：风险登记里有一条 origin 指向本议题即可（设计 §5.4：回到需求或转为风险）
  const converted = risks.filter((risk) => risk.origin === issue.id)
  if (converted.length > 0) {
    return { closed: true, openQuestionIds, reason: `已转为风险 ${converted.map((risk) => risk.id).join(' ')}` }
  }
  if (openQuestionIds.length === 0) {
    return { closed: true, openQuestionIds, reason: '质询问题已全部回答（回到需求）' }
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
