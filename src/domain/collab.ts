import { dirname } from 'node:path'
/**
 * 协同协议（设计 §8.4 / T-M4-05）。
 *
 * 四条硬规则：
 *   ① **认领走 CAS**：必须带 `expectedRevision`，对不上就是冲突（不做"后写覆盖"）；
 *   ② **只有 owner 能回报**：别人不能替它结单；
 *   ③ **done 必须带证据**：没有证据的"完成"不算完成；
 *   ④ **失联不自动释放**：超时只报告"疑似失联"，释放必须显式 `release` / `reassign`（留痕）。
 */
import type { Journal } from '../infra/journal.js'
import { textOf } from '../infra/scalar.js'
import type { SdoStore } from '../infra/store.js'
import type { EvidenceItem, TaskCard } from '../types.js'
import { listTasks, writeTask } from './plan.js'
import { auditDoneEvidence } from './evidence.js'
import { changedFilesSince } from './workspaceChanges.js'
import { describeTestFirstGaps, testFirstGaps } from './testFirst.js'
import type { EvidenceAuditCode } from './evidence.js'
import { auditWriteScopes } from '../integration/orchestrator.js'

function now(): string {
  return new Date().toISOString()
}

function save(store: SdoStore, task: TaskCard): TaskCard {
  writeTask(store, task)
  return task
}

export interface ClaimInput {
  /** 认领发生在哪个会话（A2：`done` 用它取"本会话的变更清单"做写范围对账）。 */
  sessionId?: string | undefined
  taskId: string
  owner: string
  /** 认领者看到的版本号（CAS） */
  expectedRevision: number
}

export type ClaimResult =
  | { ok: true; task: TaskCard }
  | { ok: false; code: 'not-found' | 'revision-mismatch' | 'not-claimable' | 'write-scope-conflict' | 'test-case-missing'; detail: string; current?: TaskCard | undefined }

/** 认领一张任务卡（CAS + 写范围互斥兜底）。 */
export function claim(store: SdoStore, journal: Journal, input: ClaimInput): ClaimResult {
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return { ok: false, code: 'not-found', detail: `找不到任务卡 ${input.taskId}` }
  if (task.revision !== input.expectedRevision) {
    return {
      ok: false,
      code: 'revision-mismatch',
      detail: `${task.id} 已变到 r${task.revision}（你看到的是 r${input.expectedRevision}）——重新读一遍再认领`,
      current: task,
    }
  }
  if (task.status !== 'planned' && task.status !== 'ready') {
    return {
      ok: false,
      code: 'not-claimable',
      detail: `${task.id} 当前状态 ${task.status}${task.owner === undefined ? '' : `（owner=${task.owner}）`}，不可认领`,
      current: task,
    }
  }
  // 写范围互斥的运行时兜底：同一时刻只有一张卡能写同一范围
  const clash = listTasks(store).find(
    (other) =>
      other.id !== task.id &&
      other.status === 'in-progress' &&
      other.writeScopes.some((scope) => task.writeScopes.some((mine) => textOf(mine).startsWith(textOf(scope)) || textOf(scope).startsWith(textOf(mine)))),
  )
  if (clash !== undefined) {
    return {
      ok: false,
      code: 'write-scope-conflict',
      detail: `写范围与正在进行的 ${clash.id}（owner=${clash.owner ?? '?'}）冲突：${clash.writeScopes.join('、')}`,
      current: task,
    }
  }
  // C7：测试先行 —— `normal`/`critical` 档的项目里，卡上的需求在**认领前**就要有用例计划
  const claimGaps = testFirstGaps(store, task, 'claim')
  if (claimGaps.length > 0) {
    return { ok: false, code: 'test-case-missing', detail: describeTestFirstGaps(task.id, 'claim', claimGaps), current: task }
  }
  const next: TaskCard = { ...task, status: 'in-progress', owner: input.owner, revision: task.revision + 1, updatedAt: now() }
  // A2：认领事件**自身**就是写范围对账的基线（它带 sessionId，seq 由 journal 分配）
  journal.append('task/claimed', {
    id: next.id,
    owner: input.owner,
    revision: next.revision,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  })
  return { ok: true, task: save(store, next) }
}

export interface ReportInput {
  taskId: string
  owner: string
  status: 'done' | 'blocked'
  evidence?: EvidenceItem[] | undefined
  note?: string | undefined
}

export type ReportResult =
  | { ok: true; task: TaskCard; workspaceAudit?: { checked: boolean; changed: number } }
  | { ok: false; code: 'not-found' | 'not-owner' | 'no-evidence' | 'write-scope-violation' | 'test-case-missing' | 'test-result-missing' | 'test-failing' | 'test-skip-unjustified' | EvidenceAuditCode; detail: string }

/** 回报：done 必须有证据；blocked 必须说明原因。 */
export function report(store: SdoStore, journal: Journal, input: ReportInput): ReportResult {
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return { ok: false, code: 'not-found', detail: `找不到任务卡 ${input.taskId}` }
  if (task.owner !== input.owner) {
    return {
      ok: false,
      code: 'not-owner',
      detail: `${task.id} 的 owner 是 ${task.owner ?? '（无）'}，不是 ${input.owner}——只有 owner 能回报（设计 §8.4）`,
    }
  }
  if (input.status === 'done') {
    const evidence = input.evidence ?? []
    if (evidence.length === 0) {
      return { ok: false, code: 'no-evidence', detail: 'done 必须带证据（命令输出 / 产物路径 / workspace-changes 引用），空口完成不算完成' }
    }
    // A1：证据与**卡上声明的种类**、以及**工作区里真实存在的东西**对账（越界/缺种类/哈希不符/命令非 0 都判红）。
    const audit = auditDoneEvidence(task, evidence, dirname(store.root))
    if (!audit.ok) return { ok: false, code: audit.code, detail: audit.detail }
    // C7：测试先行 —— 卡上的需求在 **done 前**必须有结果（pass，或 skip + 理由）
    const doneGaps = testFirstGaps(store, task, 'done')
    if (doneGaps.length > 0) {
      const code = doneGaps.some((gap) => gap.kind === 'failing')
        ? 'test-failing'
        : doneGaps.some((gap) => gap.kind === 'no-result')
          ? 'test-result-missing'
          : doneGaps.some((gap) => gap.kind === 'skip-unjustified')
            ? 'test-skip-unjustified'
            : 'test-case-missing'
      return { ok: false, code, detail: describeTestFirstGaps(task.id, 'done', doneGaps) }
    }
    // A2：写范围对账 —— 拿"认领基线"之后本会话真实改动的文件，与卡的 writeScopes 比。
    const baseline = claimBaseline(journal, task.id)
    const changed = changedFilesSince(store, baseline?.sessionId, baseline?.seq)
    const scopeAudit = auditWriteScopes(changed.files, task.writeScopes.map((scope) => textOf(scope)).filter((scope) => scope !== ''))
    if (changed.entries > 0 && !scopeAudit.ok) {
      return {
        ok: false,
        code: 'write-scope-violation',
        detail: `${task.id} 越界写：${scopeAudit.violations.join('、')}（写范围：${task.writeScopes.join('、') || '（未限定）'}）；把改动挪回写范围，或让流程官改卡后重新认领`,
      }
    }
    const next: TaskCard = {
      ...task,
      status: 'done',
      evidence: [...task.evidence, ...evidence],
      revision: task.revision + 1,
      updatedAt: now(),
    }
    journal.append('task/done', { id: next.id, owner: input.owner, evidence: evidence.length, note: input.note ?? '' })
    return {
      ok: true,
      task: save(store, next),
      // 采不到数据、或采到的条目**没有文件信息**，都如实报告"未对账"（不判红也不冒充已核对）
      workspaceAudit: { checked: changed.audited, changed: changed.files.length },
    }
  }
  const next: TaskCard = {
    ...task,
    status: 'blocked',
    blockedReason: input.note ?? '（未说明）',
    revision: task.revision + 1,
    updatedAt: now(),
  }
  journal.append('task/blocked', { id: next.id, owner: input.owner, reason: next.blockedReason })
  return { ok: true, task: save(store, next) }
}

/**
 * 取某卡最近一次认领基线（A2）：直接用 `task/claimed` 事件自己的 `seq` 与它带的 `sessionId`。
 * 没有就返回 undefined —— 对账会如实报"未对账"，而不是猜一个基线。
 */
export function claimBaseline(journal: Journal, taskId: string): { sessionId: string; seq: number } | undefined {
  const events = journal.read().events.filter((event) => event.type === 'task/claimed' && event.data.id === taskId)
  const last = events[events.length - 1]
  if (last === undefined) return undefined
  const sessionId = textOf(last.data.sessionId)
  if (sessionId === '') return undefined
  return { sessionId, seq: last.seq }
}

/** 显式释放（回到 ready，清空 owner）。 */
export function release(store: SdoStore, journal: Journal, input: { taskId: string; actor: string; reason: string }): TaskCard | undefined {
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return undefined
  const { owner: _owner, blockedReason: _blocked, ...rest } = task
  const next: TaskCard = { ...rest, status: 'ready', revision: task.revision + 1, updatedAt: now() }
  journal.append('task/released', { id: next.id, actor: input.actor, reason: input.reason, previousOwner: task.owner ?? '' })
  return save(store, next)
}

/** 显式改派（换 owner，状态保持 in-progress）。 */
export function reassign(store: SdoStore, journal: Journal, input: { taskId: string; actor: string; owner: string; reason: string }): TaskCard | undefined {
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return undefined
  const next: TaskCard = { ...task, owner: input.owner, revision: task.revision + 1, updatedAt: now() }
  journal.append('task/released', {
    id: next.id,
    actor: input.actor,
    reason: input.reason,
    reassignedTo: input.owner,
    previousOwner: task.owner ?? '',
  })
  return save(store, next)
}

/**
 * 疑似失联的卡：**只报告，不自动释放**（设计 §8.4）。
 * 自动释放会让"正在写"的 agent 与接管者同时改同一批文件。
 */
export function staleClaims(tasks: TaskCard[], ttlMs: number, at = Date.now()): TaskCard[] {
  return tasks.filter((task) => task.status === 'in-progress' && at - Date.parse(task.updatedAt) > ttlMs)
}
