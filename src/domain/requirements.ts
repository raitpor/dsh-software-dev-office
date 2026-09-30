/**
 * 需求仓库：`.sdo/requirements/REQ-*.yml` 的读写 + 评分联动 + 基线冻结。
 *
 * 设计对应：§4.4（实体形状）、§5.2.1（评分）、§5.5（基线）、§5.2.5（DoR 输入）。
 *
 * 纪律：所有写入都经 {@link SdoStore}（路径沙箱 + 原子写），并在 {@link Journal} 留事件；
 * 实体文件是**真源**，`project.json` 只是投影。
 */
import { formatId, nextId } from '../infra/ids.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import { DIMENSIONS } from '../types.js'
import type {
  AcceptanceCriterion,
  Ambiguity,
  Dimension,
  Priority,
  Requirement,
  RequirementKind,
  SdoProject,
} from '../types.js'
import { loadScoring, scoreRequirement } from './scoring.js'

/** 实体文件的包封键（设计 §4.4：`requirement:` 根键）。 */
interface RequirementEnvelope {
  requirement: Requirement
}

/** 列出全部需求 ID（按文件名字典序）。 */
export function listRequirementIds(store: SdoStore): string[] {
  return store
    .listNames('requirements')
    .filter((name) => /^REQ-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

/** 读取一条需求。 */
export function readRequirement(store: SdoStore, id: string): Requirement | undefined {
  const envelope = store.readYaml<RequirementEnvelope>('requirements', `${id}.yml`)
  return envelope?.requirement
}

/** 列出全部需求。 */
export function listRequirements(store: SdoStore): Requirement[] {
  const out: Requirement[] = []
  for (const id of listRequirementIds(store)) {
    const requirement = readRequirement(store, id)
    if (requirement !== undefined) out.push(requirement)
  }
  return out
}

/** 写回一条需求（原子写）。 */
export function writeRequirement(store: SdoStore, requirement: Requirement): void {
  store.writeYaml(['requirements', `${requirement.id}.yml`], { requirement })
}

/** 评分上下文：来自项目台账的硬信号。 */
export function scoringContext(project: SdoProject | undefined): {
  nonGoalsDeclared: boolean
  hasSuccessMetrics: boolean
} {
  return {
    nonGoalsDeclared: (project?.scope.out.length ?? 0) > 0,
    hasSuccessMetrics: (project?.metrics.success.length ?? 0) > 0,
  }
}

/** 收集全部已用验收标准 ID（保证 AC 编号全局唯一）。 */
export function usedAcceptanceIds(store: SdoStore): string[] {
  const ids: string[] = []
  for (const requirement of listRequirements(store)) {
    for (const ac of requirement.acceptance) ids.push(ac.id)
  }
  return ids
}

/** 捕获一条新需求（draft）。 */
export interface CaptureInput {
  title: string
  statement: string
  rationale?: string | undefined
  kind?: RequirementKind | undefined
  priority?: Priority | undefined
  sourceStakeholder?: string | undefined
  sourceRaw?: string | undefined
  /** 该需求来自原型回填（设计 §7.2：`source=prototype`） */
  prototypeSource?: boolean | undefined
  modelDimensions?: Partial<Record<Dimension, number>> | undefined
  /** 验收标准（D2 修复：旧实现声明了该通道却从不读取，导致静默丢 AC） */
  acceptance?: AcceptanceCriterion[] | undefined
}

export interface CaptureResult {
  requirement: Requirement
  flags: string[]
}

export function captureRequirement(
  store: SdoStore,
  journal: Journal,
  project: SdoProject | undefined,
  input: CaptureInput,
): CaptureResult {
  // **来源硬约束（需求阶段的核心纪律）**：一条需求必须能回答"这是谁说的"。
  // 实测教训（酒店系统会话）：模型只听到"做房间预定系统"，就自行 capture 了 6 条需求并往下推。
  const hasRaw = (input.sourceRaw ?? '').trim() !== ''
  const hasStakeholder = (input.sourceStakeholder ?? '').trim() !== ''
  // 原型回填也是合法来源（设计 §7.2：原型结论回填为需求）
  const fromPrototype = input.prototypeSource === true
  if (!hasRaw && !hasStakeholder && !fromPrototype) {
    throw new Error(
      '这条需求没有来源，不能落账：请先用提问工具向用户确认，并把**用户原话**放进 `sourceRaw`'
      + '（或指明具名干系人 `sourceStakeholder`）。不要替用户发明需求——需求阶段是问人最多的阶段。',
    )
  }
  const model = loadScoring()
  const now = new Date().toISOString()
  const acceptance = input.acceptance ?? []
  const requirement: Requirement = {
    id: nextId('REQ', listRequirementIds(store)),
    title: input.title,
    kind: input.kind ?? 'functional',
    statement: input.statement,
    rationale: input.rationale ?? '',
    source: {
      ...(input.sourceStakeholder === undefined ? {} : { stakeholder: input.sourceStakeholder }),
      ...(input.sourceRaw === undefined ? {} : { raw: input.sourceRaw }),
      ...(input.prototypeSource === true ? { prototype: true } : {}),
    },
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    ambiguity: { score: 0, dimensions: {}, open: [] },
    acceptance,
    status: 'draft',
    version: 0.1,
    baseline: null,
    createdAt: now,
    updatedAt: now,
  }

  const scored = scoreRequirement({
    requirement,
    model,
    modelDimensions: input.modelDimensions,
    context: scoringContext(project),
  })
  requirement.ambiguity = scored.ambiguity

  writeRequirement(store, requirement)
  journal.append('requirement/captured', { id: requirement.id, title: requirement.title, score: scored.ambiguity.score })
  return { requirement, flags: scored.flags }
}

/** 追加/替换一条需求的部分字段并重算评分。 */
export interface UpdateInput {
  id: string
  patch?: Partial<Pick<Requirement, 'title' | 'kind' | 'statement' | 'rationale' | 'priority' | 'source' | 'status'>> | undefined
  addAcceptance?: AcceptanceCriterion[] | undefined
  modelDimensions?: Partial<Record<Dimension, number>> | undefined
}

export function updateRequirement(
  store: SdoStore,
  journal: Journal,
  project: SdoProject | undefined,
  input: UpdateInput,
): { requirement: Requirement; flags: string[] } | undefined {
  const current = readRequirement(store, input.id)
  if (current === undefined) return undefined
  const model = loadScoring()

  const merged: Requirement = {
    ...current,
    ...(input.patch ?? {}),
    acceptance: [...current.acceptance, ...(input.addAcceptance ?? [])],
    updatedAt: new Date().toISOString(),
  }
  const scored = scoreRequirement({
    requirement: merged,
    model,
    ...(input.modelDimensions === undefined ? {} : { modelDimensions: input.modelDimensions }),
    context: scoringContext(project),
  })
  merged.ambiguity = scored.ambiguity
  writeRequirement(store, merged)
  journal.append('requirement/updated', { id: merged.id, score: scored.ambiguity.score, flags: scored.flags })
  return { requirement: merged, flags: scored.flags }
}

/** 重算全部需求的评分（问题账本变化后调用）。 */
export function rescoreAll(
  store: SdoStore,
  journal: Journal,
  project: SdoProject | undefined,
): Requirement[] {
  const model = loadScoring()
  const requirements = listRequirements(store)
  for (const requirement of requirements) {
    const scored = scoreRequirement({ requirement, model, context: scoringContext(project) })
    requirement.ambiguity = scored.ambiguity
    writeRequirement(store, requirement)
  }
  journal.append('requirement/updated', { rescored: requirements.length })
  return requirements
}

/** 把某条需求的未决问题列表写进 `ambiguity.open`。 */
export function setOpenQuestions(
  store: SdoStore,
  requirementId: string,
  openIds: string[],
  modelDimensions?: Partial<Record<Dimension, number>> | undefined,
  project?: SdoProject | undefined,
): Requirement | undefined {
  const requirement = readRequirement(store, requirementId)
  if (requirement === undefined) return undefined
  const model = loadScoring()
  const next: Requirement = { ...requirement, ambiguity: { ...requirement.ambiguity, open: openIds } }
  const scored = scoreRequirement({
    requirement: next,
    model,
    ...(modelDimensions === undefined ? {} : { modelDimensions }),
    context: scoringContext(project),
  })
  next.ambiguity = { ...scored.ambiguity, open: openIds }
  next.updatedAt = new Date().toISOString()
  writeRequirement(store, next)
  return next
}

/** 基线冻结：状态置 baselined、版本 +0.1、写入证据（设计 §5.5）。 */
export function baselineRequirements(
  store: SdoStore,
  journal: Journal,
  ids: string[],
  evidence: { by: string; evidence: string },
): Requirement[] {
  const at = new Date().toISOString()
  const baselined: Requirement[] = []
  for (const id of ids) {
    const requirement = readRequirement(store, id)
    if (requirement === undefined) continue
    const next: Requirement = {
      ...requirement,
      status: 'baselined',
      version: Math.round((requirement.version + 0.1) * 10) / 10,
      baseline: { at, by: evidence.by, evidence: evidence.evidence },
      updatedAt: at,
    }
    writeRequirement(store, next)
    baselined.push(next)
  }
  if (baselined.length > 0) {
    journal.append('requirement/baselined', { ids: baselined.map((r) => r.id), by: evidence.by })
  }
  return baselined
}

/** 未被任何维度覆盖的维度（用于追问提示）。 */
export function zeroScoreDimensions(requirement: Requirement): Dimension[] {
  return DIMENSIONS.filter((dimension) => (requirement.ambiguity.dimensions[dimension] ?? 0) === 0)
}

/** 生成一条按当前最大 AC 编号续编的新验收标准骨架。 */
export function makeAcceptanceIds(store: SdoStore, count: number): string[] {
  const base = [...usedAcceptanceIds(store)]
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = nextId('AC', base)
    base.push(id)
    ids.push(id)
  }
  return ids
}

/** 便于测试与展示：把评分压成一行。 */
export function scoreLine(ambiguity: Ambiguity): string {
  const parts = DIMENSIONS.map((dimension) => `${dimension}:${ambiguity.dimensions[dimension] ?? 0}`)
  return `${ambiguity.score}/16（${parts.join(' ')}）`
}

/** 便捷：按 id 集合取需求。 */
export function requirementsById(store: SdoStore, ids: string[]): Requirement[] {
  const out: Requirement[] = []
  for (const id of ids) {
    const requirement = readRequirement(store, id)
    if (requirement !== undefined) out.push(requirement)
  }
  return out
}

/** 便捷：AC 骨架。 */
export function acceptance(id: string, given: string, when: string, then: string): AcceptanceCriterion {
  return { id, given, when, then }
}

/** 便捷：把序号补成 REQ-xxx（供测试与提示使用）。 */
export function formatRequirementId(n: number): string {
  return formatId('REQ', n)
}
