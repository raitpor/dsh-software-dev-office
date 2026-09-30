/**
 * 任务拆分与任务卡（设计 §8.6）。
 *
 * 拆分走**两个通道**：
 *   · 结构通道（确定性）：按追溯图里"需求→设计元素"的边，为每个元素/契约边生成一张卡；
 *   · 模型通道（语义）：模型可以补充/合并卡片建议，但必须过**六条机械校验**。
 *
 * 六条机械校验（这是"拆分质量"的硬底线，不靠人盯）：
 *   ① 单卡单角色 ② DoD 非空 ③ 依赖无环且引用存在 ④ 规模不超上限（large = 没拆完）
 *   ⑤ 可能并行的卡之间写范围互斥 ⑥ 每卡至少一项证据要求
 */
import { nextId } from '../infra/ids.js'
import { fmt, t } from './i18n.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { DesignElement, EvidenceItem, Iteration, TaskCard, TaskSize, Requirement } from '../types.js'
import { listElements, VIEW_KIND_OF_ELEMENT } from './architecture.js'
import { readLinks } from './trace.js'

/** 设计 §8.1 的八个角色（拆分器只允许这些值）。 */
export const ROLES = ['analyst', 'red-team', 'architect', 'office', 'developer', 'tester', 'reviewer', 'delivery'] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}

export function listTaskIds(store: SdoStore): string[] {
  return store
    .listNames('tasks')
    .filter((name) => /^TASK-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

export function readTask(store: SdoStore, id: string): TaskCard | undefined {
  return store.readYaml<{ task: TaskCard }>('tasks', `${id}.yml`)?.task
}

export function listTasks(store: SdoStore): TaskCard[] {
  const out: TaskCard[] = []
  for (const id of listTaskIds(store)) {
    const task = readTask(store, id)
    if (task !== undefined) out.push(task)
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

export function writeTask(store: SdoStore, task: TaskCard): void {
  store.writeYaml(['tasks', `${task.id}.yml`], { task })
}

/** 新建一张任务卡（不做校验；校验由 {@link validatePlan} 统一做）。 */
export interface TaskDraft {
  title: string
  goal?: string | undefined
  inputs?: string[] | undefined
  outputs?: string[] | undefined
  dod: string[]
  evidenceRequired?: EvidenceItem['kind'][] | undefined
  blockedBy?: string[] | undefined
  writeScopes?: string[] | undefined
  role: string
  size?: TaskSize | undefined
  requirements?: string[] | undefined
  iteration?: number | undefined
}

export function createTask(store: SdoStore, journal: Journal, draft: TaskDraft): TaskCard {
  const now = new Date().toISOString()
  const task: TaskCard = {
    id: nextId('TASK', listTaskIds(store)),
    title: draft.title,
    goal: draft.goal ?? draft.title,
    inputs: draft.inputs ?? [],
    outputs: draft.outputs ?? [],
    dod: draft.dod,
    evidenceRequired: draft.evidenceRequired ?? ['artifact'],
    blockedBy: draft.blockedBy ?? [],
    writeScopes: draft.writeScopes ?? [],
    role: draft.role,
    size: draft.size ?? 'small',
    revision: 1,
    status: 'planned',
    requirements: draft.requirements ?? [],
    evidence: [],
    createdAt: now,
    updatedAt: now,
    ...(draft.iteration === undefined ? {} : { iteration: draft.iteration }),
  }
  writeTask(store, task)
  journal.append('task/created', { id: task.id, role: task.role, size: task.size, requirements: task.requirements })
  return task
}

/** 拆分的输入。 */
export interface DecomposeInput {
  /** 只拆这些需求（默认全部已基线需求） */
  requirements?: string[] | undefined
  iteration?: number | undefined
  /** 模型通道补充的卡片建议 */
  suggestions?: TaskDraft[] | undefined
}

export interface PlanIssue {
  code: 'single-role' | 'dod-nonempty' | 'acyclic' | 'size-cap' | 'write-scope-disjoint' | 'evidence-required'
  taskId: string
  detail: string
  remedy: string
}

/** 从设计元素的职责文本里解析写范围（D3-2）：识别职责里的「写范围：<glob> 独占」这类声明。 */
export function parseWriteScopes(responsibility: string): string[] {
  const match = /写范围[：:]\s*([^\n。；;]+)/u.exec(responsibility)
  if (match === null) return []
  const matched = match[1] ?? ''
  return matched
    .split(/[、,，]/u)
    .map((item) =>
      item
        .replace(/`/gu, '')
        .replace(/[（(][^）)]*[）)]/gu, '')
        .replace(/[）)]/gu, '')
        .replace(/独占|只读|可写/gu, '')
        .trim(),
    )
    .filter((item) => item !== '')
}

/** 结构通道：按「需求 → 设计元素」生成卡片（**每元素一张**，多条需求聚合进同一张卡）。 */
export function structuralDrafts(
  store: SdoStore,
  requirements: Requirement[],
  derived: string[] = [],
): TaskDraft[] {
  const links = readLinks(store)
  const elements = new Map(listElements(store).map((element) => [element.id, element]))
  const drafts: TaskDraft[] = []
  const byElement = new Map<string, { element: DesignElement; requirements: string[] }>()
  for (const requirement of requirements) {
    const designIds = links.filter((item) => item.kind === 'req-des' && item.from === requirement.id).map((item) => item.to)
    for (const designId of designIds) {
      const element: DesignElement | undefined = elements.get(designId)
      if (element === undefined) continue
      const bucket = byElement.get(designId) ?? { element, requirements: [] }
      if (!bucket.requirements.includes(requirement.id)) bucket.requirements.push(requirement.id)
      byElement.set(designId, bucket)
    }
  }
  for (const [designId, bucket] of byElement) {
    const element = bucket.element
    const role: Role = VIEW_KIND_OF_ELEMENT[element.kind] ?? 'developer'
    // **G-04**：元素已有卡（任何状态）或曾被显式放弃 → 不重建（否则"放弃越多噪声越多"）
    const marker = `（${designId}）`
    const history = listTasks(store).filter((task) => task.title.includes(marker))
    if (history.length > 0) continue
    const declared = parseWriteScopes(element.responsibility)
    const slug = designId.toLowerCase()
    const custom = store.readYaml<{ plan?: { scopeTemplate?: unknown } }>('config.yml')?.plan?.scopeTemplate
    const derivedScopes =
      typeof custom === 'string' && custom.trim() !== ''
        ? custom
            .split(',')
            .map((item) => item.replaceAll('{{slug}}', slug).replaceAll('{{id}}', designId).trim())
            .filter((item) => item !== '')
        : [`src/${slug}/`, `test/${slug}/`]
    const scopes = declared.length > 0 ? declared : derivedScopes
    if (declared.length === 0) derived.push(fmt('uiPlan.t1', { p1: designId, p2: element.name }))
    drafts.push({
      title: fmt('uiPlan.t2', { p1: element.name, p2: designId }),
      goal: fmt('uiPlan.t3', { p1: element.name, p2: bucket.requirements.join('、') }),
      inputs: [fmt('uiPlan.t4', { p1: designId, p2: element.responsibility }), fmt('uiPlan.t5', { p1: bucket.requirements.join('、') })],
      outputs: [fmt('uiPlan.t6', { p1: element.name })],
      dod: [
        ...bucket.requirements.map((id) => fmt('uiPlan.t7', { p1: id })),
        t('uiPlan.k1'),
      ],
      evidenceRequired: ['artifact'],
      writeScopes: scopes,
      role,
      size: 'medium',
      requirements: bucket.requirements,
    })
  }
  // 契约边 → 集成卡片
  const contracts = links.filter((item) => item.kind === 'des-ct')
  for (const edge of contracts) {
    drafts.push({
      title: fmt('uiPlan.t8', { p1: edge.to }),
      goal: fmt('uiPlan.t9', { p1: edge.to }),
      inputs: [fmt('uiPlan.t10', { p1: edge.to })],
      outputs: [t('uiPlan.k2'), t('uiPlan.k3')],
      dod: [t('uiPlan.k4')],
      evidenceRequired: ['artifact'],
      writeScopes: [`src/${edge.to.toLowerCase()}/`],
      role: 'developer',
      size: 'medium',
      requirements: [],
    })
  }
  return drafts
}

/** 六条机械校验。 */
export function validatePlan(tasks: TaskCard[]): PlanIssue[] {
  const issues: PlanIssue[] = []
  const byId = new Map(tasks.map((task) => [task.id, task]))

  for (const task of tasks) {
    // **D3-3**：已 drop 的卡不参与校验（它们只是留痕，不是待办）
    if (task.status === 'dropped') continue
    if (!isRole(task.role)) {
      issues.push({
        code: 'single-role',
        taskId: task.id,
        detail: fmt('uiPlan.t11', { p1: task.role }),
        remedy: fmt('uiPlan.t12', { p1: ROLES.join(' / ') }),
      })
    }
    if (task.dod.length === 0 || task.dod.some((item) => item.trim() === '')) {
      issues.push({
        code: 'dod-nonempty',
        taskId: task.id,
        detail: t('uiPlan.k5'),
        remedy: t('uiPlan.k6'),
      })
    }
    if (task.size === 'large') {
      issues.push({
        code: 'size-cap',
        taskId: task.id,
        detail: t('uiPlan.k7'),
        remedy: t('uiPlan.k8'),
      })
    }
    if (task.evidenceRequired.length === 0) {
      issues.push({
        code: 'evidence-required',
        taskId: task.id,
        detail: t('uiPlan.k9'),
        remedy: t('uiPlan.k10'),
      })
    }
    for (const dependency of task.blockedBy) {
      if (!byId.has(dependency)) {
        issues.push({
          code: 'acyclic',
          taskId: task.id,
          detail: fmt('uiPlan.t13', { p1: dependency }),
          remedy: t('uiPlan.k11'),
        })
      }
    }
  }

  // 依赖环
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') {
      issues.push({
        code: 'acyclic',
        taskId: id,
        detail: fmt('uiPlan.t14', { p1: [...path, id].join(' → ') }),
        remedy: t('uiPlan.k12'),
      })
      return
    }
    state.set(id, 'visiting')
    for (const dependency of byId.get(id)?.blockedBy ?? []) visit(dependency, [...path, id])
    state.set(id, 'done')
  }
  for (const task of tasks) visit(task.id, [])

  // 可能并行的卡之间写范围互斥（同迭代、无依赖关系视为可能并行）
  // **D5-1**：成对循环只看**未作废**的卡；**D6-1（写范围租约）**：done/verified 也必须释放范围
  const active = tasks.filter(
    (task) => task.status !== 'dropped' && task.status !== 'done' && task.status !== 'verified',
  )
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i] as TaskCard
      const b = active[j] as TaskCard
      const related = a.blockedBy.includes(b.id) || b.blockedBy.includes(a.id)
      if (related) continue
      if (a.iteration !== b.iteration && (a.iteration !== undefined || b.iteration !== undefined)) continue
      const overlap = a.writeScopes.filter((scope) =>
        b.writeScopes.some((other) => scope.startsWith(other) || other.startsWith(scope)),
      )
      if (overlap.length > 0) {
        issues.push({
          code: 'write-scope-disjoint',
          taskId: a.id,
          detail: fmt('uiPlan.t15', { p1: a.id, p2: b.id, p3: overlap.join('、') }),
          remedy: t('uiPlan.k13'),
        })
      }
    }
  }

  return issues
}

/** 拆分：结构通道 + 模型建议 + 落盘（返回卡片与校验结果）。 */
export function decompose(
  store: SdoStore,
  journal: Journal,
  requirements: Requirement[],
  input: DecomposeInput = {},
): { tasks: TaskCard[]; issues: PlanIssue[]; notes?: string[] | undefined } {
  const selected = input.requirements === undefined
    ? requirements
    : requirements.filter((requirement) => input.requirements?.includes(requirement.id))
  const derived: string[] = []
  const drafts = [
    ...structuralDrafts(store, selected, derived),
    ...(input.suggestions ?? []),
  ]
  const existing = listTasks(store)
  // **D3-1**：去重集合必须**包含本批新建的卡**（旧实现只比对调用前的卡集 → 批内重复照样建）
  const seen = new Set(
    existing.filter((task) => task.status !== 'dropped').map((task) => `${task.title}|${task.role}`),
  )
  const created: TaskCard[] = []
  for (const draft of drafts) {
    const key = `${draft.title}|${draft.role}`
    if (seen.has(key)) continue
    seen.add(key)
    created.push(
      createTask(store, journal, {
        ...draft,
        ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
      }),
    )
  }
  const tasks = listTasks(store)
  return { tasks, issues: validatePlan(tasks), notes: derived }
}

/** **D3-3 回收路径**：把建错/作废的卡置为 dropped 并留痕（真源仍是追加式，不删除记录）。 */
export function dropTask(store: SdoStore, journal: Journal, taskId: string, reason: string): TaskCard | undefined {
  const task = listTasks(store).find((item) => item.id === taskId)
  if (task === undefined) return undefined
  const dropped: TaskCard = { ...task, status: 'dropped', revision: task.revision + 1 }
  writeTask(store, dropped)
  journal.append('task/dropped', { id: taskId, reason })
  return dropped
}

/** 当前迭代（`.sdo/iteration.yml`）。 */
export function readIteration(store: SdoStore): Iteration | undefined {
  return store.readYaml<{ iteration: Iteration }>('iteration.yml')?.iteration
}

export function writeIteration(store: SdoStore, journal: Journal, iteration: Iteration): Iteration {
  store.writeYaml(['iteration.yml'], { iteration })
  journal.append('iteration/updated', { number: iteration.number, status: iteration.status, goal: iteration.goal })
  return iteration
}

/** 开一个新迭代（编号自增）。 */
export function startIteration(store: SdoStore, journal: Journal, goal: string): Iteration {
  const previous = readIteration(store)
  return writeIteration(store, journal, {
    number: (previous?.number ?? 0) + 1,
    goal,
    status: 'active',
    startedAt: new Date().toISOString(),
  })
}

/** 关闭当前迭代。 */
export function closeIteration(store: SdoStore, journal: Journal): Iteration | undefined {
  const current = readIteration(store)
  if (current === undefined) return undefined
  return writeIteration(store, journal, { ...current, status: 'closed', closedAt: new Date().toISOString() })
}

/** 某迭代的任务卡。 */
export function iterationTasks(store: SdoStore, number?: number | undefined): TaskCard[] {
  const tasks = listTasks(store)
  return number === undefined ? tasks : tasks.filter((task) => task.iteration === number)
}

/** 依赖已满足、可以派发的卡（按规模小→大、id 升序）。 */
export function readyTasks(tasks: TaskCard[], limit = 4): TaskCard[] {
  const done = new Set(tasks.filter((task) => task.status === 'done' || task.status === 'verified').map((task) => task.id))
  return tasks
    .filter((task) => (task.status === 'planned' || task.status === 'ready') && task.blockedBy.every((id) => done.has(id)))
    .sort((a, b) => a.size.localeCompare(b.size) || a.id.localeCompare(b.id))
    .slice(0, limit)
}

/** 依赖未满足的卡（给人看"为什么还不能派"）。 */
export function blockedTasks(tasks: TaskCard[]): { task: TaskCard; waitingOn: string[] }[] {
  const done = new Set(tasks.filter((task) => task.status === 'done' || task.status === 'verified').map((task) => task.id))
  return tasks
    .filter((task) => task.status === 'planned' || task.status === 'ready')
    .map((task) => ({ task, waitingOn: task.blockedBy.filter((id) => !done.has(id)) }))
    .filter((item) => item.waitingOn.length > 0)
}

/** 计划概览（看板与门禁用）。 */
export function planStats(tasks: TaskCard[]): {
  /** 全部卡（含已放弃，台账口径） */
  total: number
  /** **未放弃**的卡（门禁判据一律用它） */
  active: number
  byStatus: Record<string, number>
  done: number
  allDone: boolean
  unowned: number
} {
  const byStatus: Record<string, number> = {}
  for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
  // **D7**：dropped 是显式放弃的终态，不得计入完成率分母（否则放弃越多越不可能过门禁）
  const activeTasks = tasks.filter((task) => task.status !== 'dropped')
  const done = activeTasks.filter((task) => task.status === 'done' || task.status === 'verified').length
  return {
    total: tasks.length,
    active: activeTasks.length,
    byStatus,
    done,
    allDone: activeTasks.length > 0 && done === activeTasks.length,
    unowned: activeTasks.filter((task) => task.status === 'in-progress' && task.owner === undefined).length,
  }
}
