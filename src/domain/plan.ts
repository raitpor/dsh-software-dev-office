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

/** 结构通道：按"需求 → 设计元素"生成卡片。 */
export function structuralDrafts(store: SdoStore, requirements: Requirement[]): TaskDraft[] {
  const links = readLinks(store)
  const elements = new Map(listElements(store).map((element) => [element.id, element]))
  const drafts: TaskDraft[] = []
  for (const requirement of requirements) {
    const designIds = links.filter((item) => item.kind === 'req-des' && item.from === requirement.id).map((item) => item.to)
    for (const designId of designIds) {
      const element: DesignElement | undefined = elements.get(designId)
      if (element === undefined) continue
      const role: Role = VIEW_KIND_OF_ELEMENT[element.kind] ?? 'developer'
      const slug = designId.toLowerCase()
      drafts.push({
        title: `实现 ${element.name}（${designId}）`,
        goal: `让 ${element.name} 满足 ${requirement.id} 的验收标准`,
        inputs: [`${designId} 的职责：${element.responsibility}`, `${requirement.id} 的验收标准`],
        outputs: [`${element.name} 的实现`, `针对 ${requirement.id} 的测试用例`],
        dod: [`${requirement.id} 的每条 Given/When/Then 都能通过`, '改动有产物证据（路径 + 哈希）'],
        evidenceRequired: ['artifact'],
        writeScopes: [`src/${slug}/`, `test/${slug}/`],
        role,
        size: 'medium',
        requirements: [requirement.id],
      })
    }
  }
  // 契约边 → 集成卡片
  const contracts = links.filter((item) => item.kind === 'des-ct')
  for (const edge of contracts) {
    drafts.push({
      title: `对接契约 ${edge.to}`,
      goal: `按 ${edge.to} 的契约实现调用与失败语义`,
      inputs: [`契约 ${edge.to}`],
      outputs: ['调用方实现', '失败语义（超时/重试/幂等）的测试'],
      dod: ['契约的失败语义被测试覆盖'],
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
    if (!isRole(task.role)) {
      issues.push({
        code: 'single-role',
        taskId: task.id,
        detail: `角色 ${task.role} 不在 8 个角色里`,
        remedy: `改成其中之一：${ROLES.join(' / ')}`,
      })
    }
    if (task.dod.length === 0 || task.dod.some((item) => item.trim() === '')) {
      issues.push({
        code: 'dod-nonempty',
        taskId: task.id,
        detail: 'DoD 为空或含空条目',
        remedy: '给这张卡写出可判定的完成定义（至少 1 条，能明确通过/失败）',
      })
    }
    if (task.size === 'large') {
      issues.push({
        code: 'size-cap',
        taskId: task.id,
        detail: '卡规模为 large（等于没拆完）',
        remedy: '继续拆成 medium 及以下（一张卡 = 一个可独立验证的增量）',
      })
    }
    if (task.evidenceRequired.length === 0) {
      issues.push({
        code: 'evidence-required',
        taskId: task.id,
        detail: '没有证据要求',
        remedy: "至少给一项（'artifact' 最常用；涉及多文件改动时用 'workspace-changes'）",
      })
    }
    for (const dependency of task.blockedBy) {
      if (!byId.has(dependency)) {
        issues.push({
          code: 'acyclic',
          taskId: task.id,
          detail: `依赖 ${dependency} 不存在`,
          remedy: '修正依赖，或先把被依赖的卡建出来',
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
        detail: `依赖成环：${[...path, id].join(' → ')}`,
        remedy: '打断环（通常意味着这两张卡应该合成一张）',
      })
      return
    }
    state.set(id, 'visiting')
    for (const dependency of byId.get(id)?.blockedBy ?? []) visit(dependency, [...path, id])
    state.set(id, 'done')
  }
  for (const task of tasks) visit(task.id, [])

  // 可能并行的卡之间写范围互斥（同迭代、无依赖关系视为可能并行）
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i] as TaskCard
      const b = tasks[j] as TaskCard
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
          detail: `${a.id} 与 ${b.id} 可能并行，但写范围重叠：${overlap.join('、')}`,
          remedy: '收窄写范围，或把它们串成依赖（blockedBy）——写范围互斥是并行安全的前提',
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
): { tasks: TaskCard[]; issues: PlanIssue[] } {
  const selected = input.requirements === undefined
    ? requirements
    : requirements.filter((requirement) => input.requirements?.includes(requirement.id))
  const drafts = [
    ...structuralDrafts(store, selected),
    ...(input.suggestions ?? []),
  ]
  const existing = listTasks(store)
  const created: TaskCard[] = []
  for (const draft of drafts) {
    // 去重：同标题同角色不重复建卡
    if (existing.some((task) => task.title === draft.title && task.role === draft.role)) continue
    created.push(
      createTask(store, journal, {
        ...draft,
        ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
      }),
    )
  }
  const tasks = listTasks(store)
  return { tasks, issues: validatePlan(tasks) }
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
  total: number
  byStatus: Record<string, number>
  done: number
  allDone: boolean
  unowned: number
} {
  const byStatus: Record<string, number> = {}
  for (const task of tasks) byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
  const done = tasks.filter((task) => task.status === 'done' || task.status === 'verified').length
  return {
    total: tasks.length,
    byStatus,
    done,
    allDone: tasks.length > 0 && done === tasks.length,
    unowned: tasks.filter((task) => task.status === 'in-progress' && task.owner === undefined).length,
  }
}
