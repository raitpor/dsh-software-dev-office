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
import { blockingReview } from './reviewVerification.js'
import { describeUndigestedChanges, undigestedChanges } from './change.js'
import { loadProcess } from './process.js'
import { fmt, t } from './i18n.js'
import {
  CONSTRUCTION_PHASES,
  claimGaps as constructionClaimGaps,
  doneGaps as constructionDoneGaps,
  readConstructionProfile,
} from './construction.js'
import { readProjectConfig } from '../config.js'
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
  /** 当前阶段（增量 3：构造阶段才检查实现阶段方法包；不传则从台账现读）。 */
  phase?: string | undefined
}

export type ClaimResult =
  | { ok: true; task: TaskCard }
  | {
      ok: false
      code: 'not-found' | 'revision-mismatch' | 'not-claimable' | 'change-not-digested' | 'write-scope-conflict' | 'test-case-missing' | 'construction-profile-missing' | 'contract-not-frozen'
      detail: string
      current?: TaskCard | undefined
    }

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
  // **语义 A（2026-10-04）**：批准但**未消化**的需求变更 ⇒ 拒绝认领。
  // 为什么必须拦在这里：`claim` 是唯一"不需要动文件就能开工"的入口，**不受阶段纪律约束**
  // （阶段纪律只管 `write`/`edit` 打到 `src/`、`test/`）—— 真机上 `CR-001` 批准 23 秒后
  // `task/claimed` 照常发生，正是从这个口子漏过去的。
  // 消化的定义（现算，不新增真源）：批准之后**重新基线**覆盖了该需求，且此后**重过设计门**。
  const process = loadProcess(journal.loadProject().project?.process ?? 'waterfall')
  const pendingChanges = undigestedChanges(store, journal, process)
  // **SDO-16 / SDO-17（2026-10-05 真机，blocker）**：**解冻路径不能被自己要解的冻锁住**。
  // 消化路径是「更新需求 → 重签 G2 → 重走设计过 G3」，而这条路上的卡（需求/架构角色）本身
  // 也要先认领 —— 真机上 TASK-128「重新冻结需求基线」被同一检查连拒 4 轮，6 张卡零开工，
  // 只能靠"无卡直接执行 + 流程官显式授权"绕行（那不是产品，是临场发挥）。
  // ⇒ 冻结只针对**施工/验证/交付**角色；流程侧角色（analyst / architect / office）可以开工去消化它。
  const digestingRole = task.role === 'analyst' || task.role === 'architect' || task.role === 'office'
  if (pendingChanges.length > 0 && !digestingRole) {
    return {
      ok: false,
      code: 'change-not-digested',
      detail: describeUndigestedChanges(pendingChanges, process) + '\n' + t('uiChange.notDigestedDigestPath'),
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
  const claimGaps = testFirstGaps(store, task, 'claim', journal)
  if (claimGaps.length > 0) {
    return { ok: false, code: 'test-case-missing', detail: describeTestFirstGaps(task.id, 'claim', claimGaps), current: task }
  }
  // 增量 3：**实现阶段方法包**的开工关（只在构造阶段生效；没到构造/没这套机制的项目行为不变）
  const phase = input.phase ?? journal.loadProject().project?.phase
  if (phase !== undefined && CONSTRUCTION_PHASES.has(String(phase))) {
    const read = readConstructionProfile(store)
    if (read.status !== 'ok') {
      return {
        ok: false,
        code: 'construction-profile-missing',
        detail:
          read.status === 'invalid'
            ? fmt('uiConstruction.c22', { p1: read.problems.join('；') })
            : t('uiConstruction.c23'),
        current: task,
      }
    }
    // 认领事件自身还没写：用"当前最后一条 + 1"估计本次认领的序号。
    // 估低只会让检查更严（fail-safe）；正常台账下它与 journal 的分配一致。
    const events = journal.read().events
    const thisClaimSeq = (events[events.length - 1]?.seq ?? 0) + 1
    const contractGaps = constructionClaimGaps(store, journal, task, thisClaimSeq, read.profile)
    if (contractGaps.length > 0) {
      return { ok: false, code: 'contract-not-frozen', detail: contractGaps.map((item) => item.detail).join('；'), current: task }
    }
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
  /** 当前阶段（增量 3：收工关按所选方法包检查时用得到；不传则从台账现读）。 */
  phase?: string | undefined
}

export type ReportResult =
  | { ok: true; task: TaskCard; workspaceAudit?: { checked: boolean; changed: number } }
  | {
      ok: false
      code:
        | 'not-found'
        | 'not-owner'
        | 'no-evidence'
        | 'write-scope-violation'
        | 'test-case-missing'
        | 'test-result-missing'
        | 'test-failing'
        | 'test-skip-unjustified'
        | 'construction-profile-missing'
        | 'tdd-red-green-missing'
        | 'review-open-findings'
        | 'tdd-result-untraceable'
        | 'tdd-mutation-missing'
        | 'contract-test-missing'
        | EvidenceAuditCode
      detail: string
    }

/** 回报：done 必须有证据；blocked 必须说明原因。 */
export function report(store: SdoStore, journal: Journal, input: ReportInput): ReportResult {
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return { ok: false, code: 'not-found', detail: `找不到任务卡 ${input.taskId}` }
  if (task.owner !== input.owner) {
    // **SDO-21（2026-10-05 真机）**：认领被门禁拒后卡**没有 owner**，于是 `block` 也被 `not-owner` 拒
    // ⇒ 台账上看不出"这张卡被机制卡住了"，同角色池还会反复派它（真机 6 张卡连拒 4 轮）。
    // 允许**无主卡**上报阻塞：记为 `task/claim-blocked`（与真正的 block 分开，便于审计）。
    if (input.status === 'blocked' && (task.owner === undefined || task.owner === '')) {
      const blocked: TaskCard = {
        ...task,
        status: 'blocked',
        blockedReason: input.note ?? '（未说明）',
        revision: task.revision + 1,
        updatedAt: now(),
      }
      journal.append('task/claim-blocked', { id: blocked.id, by: input.owner, reason: blocked.blockedReason })
      return { ok: true, task: save(store, blocked) }
    }
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
    // **2026-10-08 评审核实口径**：卡上**最新一条**评审还在要求改动（changes-requested / reject）且发现
    // 没被逐条核实时，不许 `done` —— "没核实就改、改完就说完成"这条路要被堵死。
    // 评审是**主张**不是结论：实现方要自己复现（reproduced）或给出反证（refuted），逐条留痕。
    const blocking = blockingReview(store, journal, task.id)
    if (blocking !== undefined) {
      const open = [...blocking.pending, ...blocking.stale, ...blocking.forged].map((index) => String(index + 1))
      return {
        ok: false,
        code: 'review-open-findings',
        detail: fmt('uiReview.openFindings', {
          p1: task.id,
          p2: blocking.review.id,
          p3: blocking.review.verdict,
          p4: open.join('、'),
          p5: task.id,
        }),
      }
    }
    // C7：测试先行 —— 卡上的需求在 **done 前**必须有结果（pass，或 skip + 理由）
    const doneGaps = testFirstGaps(store, task, 'done', journal)
    if (doneGaps.length > 0) {
      const code = doneGaps.some((gap) => gap.kind === 'untraceable')
        ? 'tdd-result-untraceable'
        : doneGaps.some((gap) => gap.kind === 'failing')
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
    // **SDO-34（真机）**：`.sdo/` 下的**台账写入**（`sdo_test` / `sdo_gate` / `sdo_risk` 等工具自己落的）
    // **不占卡的写范围** —— 真机上「DoD 要求如实闭合缺陷」的卡因此与写范围打架，执行者只能二选一
    // （要么违写范围、要么违 DoD）。台账由工具负责，卡只对**产品文件**负责。
    const auditable = changed.files.filter((file) => !String(file).replace(/^\.\//u, '').startsWith('.sdo/'))
    const scopeAudit = auditWriteScopes(auditable, task.writeScopes.map((scope) => textOf(scope)).filter((scope) => scope !== ''))
    if (changed.entries > 0 && !scopeAudit.ok) {
      return {
        ok: false,
        code: 'write-scope-violation',
        detail: `${task.id} 越界写：${scopeAudit.violations.join('、')}（写范围：${task.writeScopes.join('、') || '（未限定）'}）；把改动挪回写范围，或让流程官改卡后重新认领`,
      }
    }
    // 增量 3：**实现阶段方法包**的收工关（按所选包逐条检查；豁免已写进 profile 的 exempt）
    const profileRead = readConstructionProfile(store)
    if (profileRead.status === 'invalid') {
      return { ok: false, code: 'construction-profile-missing', detail: fmt('uiConstruction.c22', { p1: profileRead.problems.join('；') }) }
    }
    if (profileRead.status === 'ok') {
      const packageGaps = constructionDoneGaps(store, journal, task, profileRead.profile, { scale: readProjectConfig(store).config.scale })
      if (packageGaps.length > 0) {
        const first = packageGaps[0]
        const code =
          first !== undefined
          && (first.check === 'tdd-red-green-missing'
            || first.check === 'tdd-result-untraceable'
            || first.check === 'tdd-mutation-missing'
            || first.check === 'contract-test-missing')
          ? first.check
          : 'tdd-red-green-missing'
        return { ok: false, code, detail: packageGaps.map((item) => item.detail).join('；') }
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
/**
 * **改卡**（`sdo_task action=update`，SDO-14(3) / SDO-15(3)）。
 *
 * 为什么需要：真机上「写范围与 DoD 打架」「关键卡排序被同类卡挤掉」都只能靠**人肉改 YAML** 或重新立卡 ——
 * 卡是流程真源，却没有一个受约束的修改入口。这里给出入口，并守住三条：
 *   · 已完成/已核销/已作废的卡**不改**（历史不重写）；
 *   · 卡**有人在做**时不得改 `writeScopes`（会造出两个写者）—— 除非调用方就是 owner；
 *   · 给了 `expectedRevision` 就按 CAS 判（防并发覆盖）。
 */
export function updateTask(
  store: SdoStore,
  journal: Journal,
  input: {
    taskId: string
    by: string
    expectedRevision?: number | undefined
    title?: string | undefined
    dod?: string[] | undefined
    writeScopes?: string[] | undefined
    blockedBy?: string[] | undefined
    evidenceRequired?: string[] | undefined
    requirements?: string[] | undefined
    size?: string | undefined
  },
):
  | { ok: true; task: TaskCard; changed: string[] }
  | { ok: false; code: 'not-found' | 'not-updatable' | 'revision-mismatch' | 'scope-locked'; detail: string } {
  const task = listTasks(store).find((item) => item.id === input.taskId)
  if (task === undefined) return { ok: false, code: 'not-found', detail: `找不到任务卡 ${input.taskId}` }
  if (task.status === 'done' || task.status === 'verified' || task.status === 'dropped') {
    return { ok: false, code: 'not-updatable', detail: `${task.id} 已是 ${task.status}：历史不重写（要改就新立一张卡）` }
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== task.revision) {
    return { ok: false, code: 'revision-mismatch', detail: `${task.id} 已变到 r${task.revision}（你看到的是 r${input.expectedRevision}）` }
  }
  if (input.writeScopes !== undefined && task.owner !== undefined && task.owner !== '' && task.owner !== input.by) {
    return {
      ok: false,
      code: 'scope-locked',
      detail: `${task.id} 正被 ${task.owner} 做着：改写范围会造出两个写者（先 release，或让 owner 来改）`,
    }
  }
  const changed: string[] = []
  const next: TaskCard = { ...task, revision: task.revision + 1, updatedAt: now() }
  const record = next as unknown as Record<string, unknown>
  const apply = (key: string, value: unknown): void => {
    if (value === undefined) return
    changed.push(key)
    record[key] = value
  }
  apply('title', input.title)
  apply('dod', input.dod)
  apply('writeScopes', input.writeScopes)
  apply('blockedBy', input.blockedBy)
  apply('evidenceRequired', input.evidenceRequired)
  apply('requirements', input.requirements)
  apply('size', input.size)
  if (changed.length === 0) return { ok: false, code: 'not-updatable', detail: '没有给出要改的字段' }
  const saved = save(store, next)
  journal.append('task/updated', { id: saved.id, by: input.by, fields: changed })
  return { ok: true, task: saved, changed }
}

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
