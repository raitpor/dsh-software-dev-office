/**
 * 需求仓库：`.sdo/requirements/REQ-*.yml` 的读写 + 评分联动 + 基线冻结。
 *
 * 设计对应：§4.4（实体形状）、§5.2.1（评分）、§5.5（基线）、§5.2.5（DoR 输入）。
 *
 * 纪律：所有写入都经 {@link SdoStore}（路径沙箱 + 原子写），并在 {@link Journal} 留事件；
 * 实体文件是**真源**，`project.json` 只是投影。
 */
import { formatId, nextId } from '../infra/ids.js'
import { boolField, pushShapeNote, recordListOf, recordOf, textListOf, textMapOf, textOf, typeNameOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
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

/** 列出全部需求 ID（按文件名字典序）。 */
export function listRequirementIds(store: SdoStore): string[] {
  return store
    .listNames('requirements')
    .filter((name) => /^REQ-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

/**
 * 读取一条需求并**做形状归一化**（F-21 ①）。
 *
 * `.sdo/requirements/REQ-*.yml` 是手可编辑真源，容器位置有：
 * `acceptance`（记录列表；`dor.ts` 会 `.every` / `.some` 逐条判真）、
 * `ambiguity.dimensions`（映射）/ `ambiguity.open`（列表）、`source`（映射，含布尔 `prototype`）。
 * 旧实现直接 `.every` / `.some` / `Object.entries`，手写 `acceptance: 通过` 就抛异常。
 * 口径与其它实体一致：标量写在列表位置 → 单元素（放进最自然的字段）+ 提示；
 * 映射位置或映射写在列表位置 → **不猜**，按空 + 提示。
 */
export function readRequirementChecked(
  store: SdoStore,
  id: string,
): { requirement: Requirement | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ requirement: unknown }>('requirements', `${id}.yml`)?.requirement
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) {
      pushShapeNote(notes, 'requirement', id, 'requirement', {
        position: 'map',
        actualType: typeNameOf(raw),
        handling: 'empty',
        text: textOf(raw),
      })
    }
    return { requirement: undefined, notes }
  }
  const record = raw as Record<string, unknown>
  // 标量 AC 放进 `then` —— 它是"结论"字段，`dor.ts` 的 given/when/then 非空判据会照旧判红（可读失败）
  const acceptance = recordListOf<AcceptanceCriterion>(record.acceptance, (text) => ({ id: '', given: '', when: '', then: text }))
  pushShapeNote(notes, 'requirement', id, 'acceptance', acceptance.issue)
  const ambiguityRaw = recordOf(record.ambiguity)
  pushShapeNote(notes, 'requirement', id, 'ambiguity', ambiguityRaw.issue)
  const dimensionMap = textMapOf(ambiguityRaw.value['dimensions'])
  pushShapeNote(notes, 'requirement', id, 'ambiguity.dimensions', dimensionMap.issue)
  const dimensions: Partial<Record<Dimension, number>> = {}
  for (const [key, value] of Object.entries(dimensionMap.value)) {
    const score = Number(value)
    if (Number.isFinite(score)) dimensions[key as Dimension] = score
  }
  // §6.7：模型通道的**原始**语义分也落盘（变更控制重算评分时沿用），形状与 `dimensions` 同款校验。
  const modelDimensionMap = textMapOf(ambiguityRaw.value['modelDimensions'])
  pushShapeNote(notes, 'requirement', id, 'ambiguity.modelDimensions', modelDimensionMap.issue)
  const modelDimensions: Partial<Record<Dimension, number>> = {}
  for (const [key, value] of Object.entries(modelDimensionMap.value)) {
    const score = Number(value)
    if (Number.isFinite(score)) modelDimensions[key as Dimension] = score
  }
  const open = textListOf(ambiguityRaw.value['open'])
  pushShapeNote(notes, 'requirement', id, 'ambiguity.open', open.issue)
  const source = recordOf(record.source)
  pushShapeNote(notes, 'requirement', id, 'source', source.issue)
  // `source.prototype` 是布尔位置：只有布尔才算数（与 `dropped` 同一助手口径）
  const prototype = boolField(source.value['prototype'])
  pushShapeNote(notes, 'requirement', id, 'source.prototype', prototype.issue)
  const scoreRaw = ambiguityRaw.value['score']
  const score = typeof scoreRaw === 'number' && Number.isFinite(scoreRaw) ? scoreRaw : Number(textOf(scoreRaw)) || 0
  const declaredId = textOf(record.id)
  const requirement: Requirement = {
    ...(record as unknown as Requirement),
    id: declaredId.trim() === '' ? id : declaredId,
    title: textOf(record.title),
    statement: textOf(record.statement),
    rationale: textOf(record.rationale),
    acceptance: acceptance.value.map((criterion) => ({
      id: textOf(criterion.id),
      given: textOf(criterion.given),
      when: textOf(criterion.when),
      then: textOf(criterion.then),
    })),
    ambiguity: {
      score,
      dimensions,
      open: open.value,
      ...(typeof ambiguityRaw.value['needsReview'] === 'boolean' ? { needsReview: ambiguityRaw.value['needsReview'] } : {}),
      ...(Object.keys(modelDimensions).length === 0 ? {} : { modelDimensions }),
    },
    source: {
      ...(source.value['stakeholder'] === undefined ? {} : { stakeholder: textOf(source.value['stakeholder']) }),
      ...(source.value['raw'] === undefined ? {} : { raw: textOf(source.value['raw']) }),
      ...(prototype.value === undefined ? {} : { prototype: prototype.value }),
    },
    status: textOf(record.status) as Requirement['status'],
    version: typeof record.version === 'number' ? record.version : Number(textOf(record.version)) || 1,
    createdAt: textOf(record.createdAt),
    updatedAt: textOf(record.updatedAt),
  }
  return { requirement, notes }
}

/** 读取一条需求（形状已归一化）。 */
export function readRequirement(store: SdoStore, id: string): Requirement | undefined {
  return readRequirementChecked(store, id).requirement
}

/** 全部需求上的形状提示（回执 / 只读视图 / 门禁详情共用）。 */
export function requirementShapeNotes(store: SdoStore): FieldShapeNote[] {
  const notes: FieldShapeNote[] = []
  for (const id of listRequirementIds(store)) notes.push(...readRequirementChecked(store, id).notes)
  return notes
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
  // N-2：显式给号的旁路必须在落盘前堵掉（自动发号那条路由 `makeAcceptanceIds` 保证全局唯一）
  assertAcceptanceIdsUnique(store, acceptance)
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
  /**
   * **R-2**：**替换**整份验收标准（与 `addAcceptance` 互斥，给了它就忽略 add）。
   *
   * 为什么必须有：`addAcceptance` 只**追加**，所以"存量 AC 重号"（G2 的 C9 判红）按旧 remedy
   * 根本修不完 —— 传新号只是又追加一份，旧重号原样留着，C9 会一直红。
   * 改号/删除必须有入口，否则判据给出的补救是**按提示做不完**的。
   */
  replaceAcceptance?: AcceptanceCriterion[] | undefined
  modelDimensions?: Partial<Record<Dimension, number>> | undefined
  /**
   * 本次要写回的"未决问题 id 列表"（**m2**）。
   *
   * 回答路径本来要写它：旧实现先 `updateRequirement`（算一次分）再 `setOpenQuestions`
   * （又算一次分）—— 同一需求被派发两次评分。当前是覆盖式赋值所以结果一致，
   * 一旦评分改成累加就会翻倍。现在回答路径把未决列表**一次带进来**，只算一次。
   */
  openQuestions?: string[] | undefined
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

  const open = input.openQuestions ?? current.ambiguity.open
  // N-2：`update` 的显式 AC 编号同样必须全局唯一（自动发号那条路由调用方用
  // `makeAcceptanceIds` 保证）。检查时把**本需求已有的号**排除，否则"重传自己已有的号"会误报。
  const replacement = input.replaceAcceptance
  const own = new Set(current.acceptance.map((ac) => ac.id))
  assertAcceptanceIdsUnique(
    store,
    (replacement ?? input.addAcceptance ?? []).filter((ac) => !(replacement === undefined && own.has(ac.id))),
  )
  // **P-12**：内容被改过的需求必须**退出"已冻结"状态**（`changed`）——
  // 否则它的 `status` 仍是 `baselined`，而下一次 `baseline` 会因"已冻结"把它整条跳过：
  // `baseline.{at,by,evidence}` 停在**上一个内容版本**上（审计读到的冻结时间/签字人与真实版本不符），
  // 且不会重写 `requirement/baselined`。这是本项目最忌讳的"无声"。
  // 只认**内容字段**：`modelDimensions`/`openQuestions` 只是评分与问题账本的投影，不算内容变更
  // （否则每次答题都会把需求打回 `changed`）。`change` 路径本来就会写 `changed`，这里补齐 `update` 这条。
  const CONTENT_FIELDS = ['title', 'kind', 'statement', 'rationale', 'priority', 'source'] as const
  const patch = input.patch ?? {}
  const contentTouched =
    CONTENT_FIELDS.some((field) => field in patch) || (input.addAcceptance ?? []).length > 0
  // **R-8**：内容判定**优先于** `patch.status`（旧写法把 `patch.status` 放在前面 ⇒
  // "改 statement + patch.status='baselined'" 能让内容变了却仍标已冻结，冻结事实随之停在旧版本上）。
  // `status` 仍留在 `UpdateInput.patch` 的类型里（内部调用方要用），但内容变更不可被它绕过。
  const contentChangedBaselined = contentTouched && current.status === 'baselined'
  const status = contentChangedBaselined ? 'changed' : (patch.status ?? current.status)
  // **R-9**：内容变过，版本号就必须表达它（M3 的口径是"版本号只表达内容改过"）。
  // 旧实现只有 `change` 路径会 +0.1，而 P-12 让 `update` 改内容成了**被认可的路径** ——
  // 于是出现"内容换了、版本号没换"。这里只在"已冻结的需求被改内容"这一种情形递增，
  // 与首次基线（`baselineRequirements` 的 neverBaselined 分支）和变更控制（`change`）口径一致。
  const version = contentChangedBaselined
    ? Math.round((current.version + 0.1) * 10) / 10
    : current.version
  const merged: Requirement = {
    ...current,
    ...patch,
    status,
    version,
    acceptance: replacement ?? [...current.acceptance, ...(input.addAcceptance ?? [])],
    ambiguity: { ...current.ambiguity, open },
    updatedAt: new Date().toISOString(),
  }
  // **§6.7**：没显式重给语义分时，**沿用**该需求**已落盘**的模型通道分数 ——
  // 否则一次"只改标题"的 update 就会用规则基线把语义分抹掉，变更/重基线随之被误拦。
  const modelDimensions = input.modelDimensions ?? current.ambiguity.modelDimensions
  const scored = scoreRequirement({
    requirement: merged,
    model,
    ...(modelDimensions === undefined ? {} : { modelDimensions }),
    context: scoringContext(project),
  })
  // 评分卡不产出 `open`（它是问题账本的投影），写回时保留本次传入/既有的列表
  merged.ambiguity = { ...scored.ambiguity, open }
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
    // **§6.7**：重算只刷新**规则维度**，模型通道的语义分沿用（否则账本一动、语义分全丢）。
    const modelDimensions = requirement.ambiguity.modelDimensions
    const scored = scoreRequirement({
      requirement,
      model,
      ...(modelDimensions === undefined ? {} : { modelDimensions }),
      context: scoringContext(project),
    })
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
  // **§6.7**：与 `updateRequirement` 同一口径 —— 没显式给就沿用已落盘的模型维度。
  const effective = modelDimensions ?? requirement.ambiguity.modelDimensions
  const scored = scoreRequirement({
    requirement: next,
    model,
    ...(effective === undefined ? {} : { modelDimensions: effective }),
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
    // **N-14**：**已经冻结且没有新内容**的需求不再重新冻结 —— 否则每次"重新基线"都会对全部需求
    // 无条件写一条 `requirement/baselined`，而该事件在 G3 的失效集合里 → 已经签好的架构签字
    // 被一次"与我无关的重新基线"顺手作废（用户视角："我什么都没动，签字就废了"）。
    // 真正的内容变更由 `change` / `update` 写 `requirement/updated` 背书，那才是该失效的事件。
    if (requirement.status === 'baselined' && requirement.baseline !== null && requirement.baseline !== undefined) continue
    // **M3（本报告）**：版本号只表达"内容改过"，不表达"又冻了一次"。
    // 旧实现无条件全量 `version + 0.1`：内容一字未改的需求也会从 v0.2 涨到 v0.3
    // （变更历史被版本号抹平）；改过一次的需求再基一次还会变成 v0.4。
    // 现在只有**从未基线过**的需求（`baseline` 为空）才递增 —— 内容变更由 `change`
    // 路径自己 `+0.1`，重新基线只刷新 `baseline`（冻结时间/签名/证据）。
    const neverBaselined = requirement.baseline === null || requirement.baseline === undefined
    const next: Requirement = {
      ...requirement,
      status: 'baselined',
      version: neverBaselined ? Math.round((requirement.version + 0.1) * 10) / 10 : requirement.version,
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

/**
 * **AC 编号必须全局唯一**（N-2，M8 的收口）。
 *
 * M8 修掉了"自动发号不查全局"，但 `item.id` **显式给号**仍是旁路：两次 capture 各传
 * `AC-001` 照样得到两条同号 AC，而 G2 的 C3 只查 given/when/then 非空、查不出重号 ——
 * 交付验收矩阵按 AC-id 追溯即错配。这里在**落盘前**机械拒绝：点名冲突号与已占用它的需求。
 * 不静默改名：改名会让调用方（以及它写下的其它引用）失真，用户必须自己决定要哪个号。
 */
export function acceptanceIdConflicts(
  store: SdoStore,
  criteria: AcceptanceCriterion[],
): { id: string; owner: string }[] {
  const owners = new Map<string, string>()
  for (const requirement of listRequirements(store)) {
    for (const ac of requirement.acceptance) if (!owners.has(ac.id)) owners.set(ac.id, requirement.id)
  }
  const conflicts: { id: string; owner: string }[] = []
  const seen = new Set<string>()
  for (const criterion of criteria) {
    const id = textOf(criterion.id).trim()
    if (id === '') continue
    const owner = owners.get(id)
    if (owner !== undefined) conflicts.push({ id, owner })
    else if (seen.has(id)) conflicts.push({ id, owner: '（本次提交内重复）' })
    seen.add(id)
  }
  return conflicts
}

/** 冲突即抛（可读失败）——落盘前的最后一道。 */
export function assertAcceptanceIdsUnique(store: SdoStore, criteria: AcceptanceCriterion[]): void {
  const conflicts = acceptanceIdConflicts(store, criteria)
  if (conflicts.length === 0) return
  const detail = conflicts.map((item) => `${item.id}（已属于 ${item.owner}）`).join('、')
  throw new Error(
    `验收标准编号重复：${detail}。AC 编号是交付验收矩阵的追溯键，全局必须唯一 —— `
    + '请改用其它编号，或不传 id 让插件自动发号。',
  )
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
