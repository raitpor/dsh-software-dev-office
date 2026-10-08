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
import { pushShapeNote, recordListOf, textListOf, textOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import { fmt, t } from './i18n.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { DesignElement, EvidenceItem, Iteration, TaskCard, TaskSize, Requirement } from '../types.js'
import { listElements, VIEW_KIND_OF_ELEMENT } from './architecture.js'
import { linkMany, readLinks } from './trace.js'

/** 设计 §8.1 的八个角色（拆分器只允许这些值）。 */
export const ROLES = ['analyst', 'red-team', 'architect', 'office', 'developer', 'tester', 'reviewer', 'delivery'] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}

export function listTaskIds(store: SdoStore): string[] {
// **卡 id 规范（评审员 2026-10-05）**：只认 `TASK-…` 形态的**文件名** —— 合成夹具里把卡命名成
// `T-A` / `T-DEV` 会让 `listTasks()` 全空、`claim` 报 `not-found`（排查很费时间）。
  return store
    .listNames('tasks')
    .filter((name) => /^TASK-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

/**
 * 读一张任务卡并**做形状归一化**（F-21 ①）。
 *
 * `.sdo/tasks/TASK-*.yml` 是给人手改的真源，卡上有**七个列表位置**：
 * `inputs` / `outputs` / `dod` / `evidenceRequired` / `blockedBy` / `writeScopes` /
 * `requirements`，加一个记录列表 `evidence`。旧实现直接把它们当数组用：
 * `dod.some` / `blockedBy.includes` / `blockedBy.every` / `writeScopes.filter` 都会因
 * `dod: 完成即可` 这类手写而抛 `… is not a function`。这里把形状收敛在读入处：
 *   · 标量 → **单元素列表**（意图明确）+ 提示；
 *   · 映射 / 对象 → 空列表 + 提示（**不猜**）；
 *   · 记录列表里的标量项 → 放进最自然的字段（`detail`）保留，同样给提示。
 */
export function readTaskChecked(
  store: SdoStore,
  id: string,
): { task: TaskCard | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ task: unknown }>('tasks', `${id}.yml`)?.task
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) {
      pushShapeNote(notes, 'task', id, 'task', {
        position: 'map',
        actualType: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
        handling: 'empty',
        text: textOf(raw),
      })
    }
    return { task: undefined, notes }
  }
  const record = raw as Record<string, unknown>
  const list = (field: string): string[] => {
    const read = textListOf(record[field])
    pushShapeNote(notes, 'task', id, field, read.issue)
    return read.value
  }
  const evidence = recordListOf<EvidenceItem>(record.evidence, (text) => ({ kind: 'command', detail: text, at: '' }))
  pushShapeNote(notes, 'task', id, 'evidence', evidence.issue)
  const declaredId = textOf(record.id)
  const task: TaskCard = {
    ...(record as unknown as TaskCard),
    id: declaredId.trim() === '' ? id : declaredId,
    title: textOf(record.title),
    goal: textOf(record.goal),
    inputs: list('inputs'),
    outputs: list('outputs'),
    dod: list('dod'),
    evidenceRequired: list('evidenceRequired') as EvidenceItem['kind'][],
    blockedBy: list('blockedBy'),
    writeScopes: list('writeScopes'),
    role: textOf(record.role),
    status: textOf(record.status) as TaskCard['status'],
    requirements: list('requirements'),
    evidence: evidence.value.map((item) => ({
      kind: textOf(item.kind) as EvidenceItem['kind'],
      detail: textOf(item.detail),
      at: textOf(item.at),
      // A1：退出码是 `command` 证据的一部分，读回时不能丢（丢了就等于没校验）
      ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
    })),
  }
  return { task, notes }
}

export function readTask(store: SdoStore, id: string): TaskCard | undefined {
  return readTaskChecked(store, id).task
}

/** 全部任务卡上的形状提示（回执 / 只读视图 / 门禁详情共用）。 */
export function taskShapeNotes(store: SdoStore): FieldShapeNote[] {
  const notes: FieldShapeNote[] = []
  for (const id of listTaskIds(store)) notes.push(...readTaskChecked(store, id).notes)
  return notes
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
  code: 'single-role' | 'dod-nonempty' | 'acyclic' | 'size-cap' | 'write-scope-disjoint' | 'write-scope-empty' | 'evidence-required'
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
    // **D7（整仓评审 major）**：`waterfall.yml` 的 C-31 写「任务卡齐备（DoD/依赖/**写范围**）」，但旧实现**不校验
    // 写范围非空** —— 而空写范围在下面的互斥判断里不冲突、在 `auditWriteScopes` 里"写哪儿都不算越界"
    // （实测：`auditWriteScopes(['outside/x.ts'], [])` = ok）。卡可以既不占位也不受审计 ⇒ 这里判成计划问题。
    if (task.writeScopes.filter((scope) => textOf(scope).trim() !== '').length === 0) {
      issues.push({
        code: 'write-scope-empty',
        taskId: task.id,
        detail: t('uiPlan.kWriteScopeEmpty'),
        remedy: t('uiPlan.kWriteScopeEmptyRemedy'),
      })
    }
    if (task.dod.length === 0 || task.dod.some((item) => textOf(item).trim() === '')) {
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
      // **SDO-30b（2026-10-05 真机）**：`'*'` 是**通配依赖**（"排在所有其它卡之后"），不是"不存在的卡"。
      if (dependency === '*') continue
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
    for (const dependency of (byId.get(id)?.blockedBy ?? []).filter((item) => item !== '*')) visit(dependency, [...path, id])
    state.set(id, 'done')
  }
  for (const task of tasks) visit(task.id, [])

  // 可能并行的卡之间写范围互斥（同迭代、无依赖关系视为可能并行）
  // **D5-1**：成对循环只看**未作废**的卡；**D6-1（写范围租约）**：done/verified 也必须释放范围
  // **SDO-46（真机）的口径（显式写在这里）**：`blocked` 的卡**继续持有写范围** —— 它只是等外部条件，
  // 随时可能继续写同一范围，静默把范围让给别人会造出两个写者。真机上这条口径挡掉过一次派发
  // （TASK-165 因容量停手却占着 `tools/checks/`，新卡 TASK-167 同范围派不出去）；
  // 该修的不是"静默放行"，而是**把原因与解除动作说出来**（见冲突 issue 的 detail/remedy 与 `next` 的回执）。
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
        b.writeScopes.some((other) => textOf(scope).startsWith(textOf(other)) || textOf(other).startsWith(textOf(scope))),
      )
      if (overlap.length > 0) {
        // **SDO-46**：把"挡住你的那张卡是什么状态"和"怎么腾范围"直接写给读者 —— 真机上被挡住的新卡
        // 只看到一张看板，误判成"卡没建成"；确认后显式 `drop` 阻塞卡即立刻可派。
        const holderNote = a.status === 'blocked' || b.status === 'blocked' ? t('uiPlan.kBlockedHolderNote') : ''
        issues.push({
          code: 'write-scope-disjoint',
          taskId: a.id,
          detail: fmt('uiPlan.t15', { p1: a.id, p2: b.id, p3: overlap.join('、') }) + holderNote,
          remedy: t('uiPlan.k13') + t('uiPlan.kScopeReleaseHint'),
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
    const task = createTask(store, journal, {
      ...draft,
      ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
    })
    created.push(task)
    // **D-12（sdo-test-new 2026-10-08，major）**：拆卡时就把 `req-task` 边建起来。
    // 旧实现只 `createTask`，追溯边要等卡**完成**才由 `office.ts` 补 —— 于是 G5 的 C-41（需求→任务覆盖）
    // 在开发期永远是 0，真机上只能人工补 22 条边。`linkMany` 自带去重，与完成时的补边不会重复。
    const reqIds = draft.requirements ?? []
    if (reqIds.length > 0) {
      linkMany(store, journal, reqIds.map((requirement) => ({ from: requirement, to: task.id, kind: 'req-task' })))
    }
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
  // **SDO-30b（2026-10-05 真机）**：`blockedBy: ['*']` = **排在所有其它卡之后**（"我需要独占写窗口"的
  // 表达方式）。真机场景：最终全量构建卡（TASK-132）与写卡同时就绪时被并发派出，跑出的 jar 必然过期
  // （少了同批写卡的改动）；`blockedBy` 只能表达"排在某几张卡之后"，表达不了"排在**所有**卡之后"。
  const pending = tasks.filter((task) => task.status !== 'done' && task.status !== 'verified' && task.status !== 'dropped')
  const satisfied = (task: TaskCard, id: string): boolean => {
    if (id !== '*') return done.has(id)
    return pending.every((other) => other.id === task.id || done.has(other.id))
  }
  return tasks
    .filter((task) => (task.status === 'planned' || task.status === 'ready') && task.blockedBy.every((id) => satisfied(task, id)))
    .sort((a, b) => a.size.localeCompare(b.size) || a.id.localeCompare(b.id))
    .slice(0, limit)
}

/** 依赖未满足的卡（给人看"为什么还不能派"）。 */
export function blockedTasks(tasks: TaskCard[]): { task: TaskCard; waitingOn: string[] }[] {
  const done = new Set(tasks.filter((task) => task.status === 'done' || task.status === 'verified').map((task) => task.id))
  const pending = tasks.filter((task) => task.status !== 'done' && task.status !== 'verified' && task.status !== 'dropped')
  return tasks
    .filter((task) => task.status === 'planned' || task.status === 'ready')
    .map((task) => ({
      task,
      // `'*'` 如实显示（UI 文案会说明它是"等所有其它卡"）
      waitingOn: task.blockedBy.filter((id) => (id === '*' ? pending.some((other) => other.id !== task.id && !done.has(other.id)) : !done.has(id))),
    }))
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
