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
import type { DesignElement, EvidenceItem, Iteration, MitigatesWaiver, Requirement, StructuralCardPlan, StructuralPlan, StructuralSkip, TaskCard, TaskSize } from '../types.js'
import { listElements, VIEW_KIND_OF_ELEMENT } from './architecture.js'
import { linkMany, readLinks } from './trace.js'
import { scopeOverlaps } from './scopePaths.js'

/** 设计 §8.1 的八个角色（拆分器只允许这些值）。 */
export const ROLES = ['analyst', 'red-team', 'architect', 'office', 'developer', 'tester', 'reviewer', 'delivery'] as const
export type Role = (typeof ROLES)[number]

/**
 * **这张卡是否产出产品工件**（R-12，sdo-test-new 2026-10-08）。
 *
 * 起因：C-42/C-45 的覆盖集只排 `role === 'reviewer'`，排不掉**实质在做复核的卡** ——
 * 本项目里「代核别人的评审」那张卡（TASK-045）因为 R-11（reviewer 掩码没有 `bash`，跑不了复现命令）
 * 只能挂在 `tester` 下，于是一 `done` 就落进覆盖集，判据立刻要求**它自己也要有一条被采纳的评审** ⇒ 自我递归。
 *
 * 机械判据（不靠 role）：看 `writeScopes` —— 全部落在 `.sdo/` 与 `docs/` 之下 ⇒ **不产出产品工件**
 * （复核 / 代核 / 文书 / 收尾卡天然如此），不该进"必须被评审核实"的集合。
 * 产品路径由卡自己声明（`bin/ lib/ src/ test/ tools/ fixtures/ public/ …`），因此不需要新增字段。
 */
export function producesProductArtifacts(card: { writeScopes?: readonly unknown[] | undefined }): boolean {
  const scopes = (card.writeScopes ?? []).map((item) => String(item).replace(/^\.\//u, '').trim()).filter((item) => item !== '')
  if (scopes.length === 0) return false
  return scopes.some((scope) => !scope.startsWith('.sdo/') && !scope.startsWith('docs/'))
}

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
 * 归一化卡上的 `mitigatesWaiver`（DEF-051 / TASK-080）。
 *
 * 为什么单独一个函数、而不是直接 `record.mitigatesWaiver as MitigatesWaiver[]`：卡是**手可编辑的真源**，
 * 这个位置是**记录列表**（对象数组），手写成标量/字符串时直接当数组用会抛
 * `….map is not a function`（同一个坑 F-21 ① 已经在别的六个列表位置踩过）。
 * 所以这里逐条读、逐字段 `textOf`，缺字段的空串由判据按"没人署名"处理（口径同 `C-63`）。
 */
export function mitigatesWaiverOf(raw: unknown): MitigatesWaiver[] {
  if (raw === undefined || raw === null) return []
  const items = Array.isArray(raw) ? raw : [raw]
  const out: MitigatesWaiver[] = []
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      // 标量项：给它一个最自然的落点（`id`），理由与批准人留空 ⇒ 判据判红（不静默丢失、也不猜）
      const text = textOf(item).trim()
      if (text !== '') out.push({ id: text, waiveReason: '', waiveApprovedBy: '' })
      continue
    }
    const row = item as Record<string, unknown>
    out.push({
      id: textOf(row.id).trim(),
      waiveReason: textOf(row.waiveReason).trim(),
      waiveApprovedBy: textOf(row.waiveApprovedBy).trim(),
    })
  }
  return out
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
    // **DEF-050 / TASK-072**：`fixes` 必须进这份**显式白名单重建**——这份重建就是"读端真源形状"，
    // 名单里没有的字段在 `list()` 归一化 / 形状提示里被绕过（YAML 里写了也读不回来 = 静默丢弃）。
    fixes: list('fixes'),
    // **DEF-051 / TASK-080**：`mitigates` / `mitigatesWaiver` 同理必须进这份读端白名单 ——
    // 名单里没有的字段在 YAML 里写了也读不回来（静默丢弃），判据 `C-64` 就永远只看到空集，
    // 于是"卡做完了、风险还开着"这件事继续没有人说话（本缺陷要消灭的正是这个形态）。
    mitigates: list('mitigates'),
    mitigatesWaiver: mitigatesWaiverOf(record.mitigatesWaiver),
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
  /** 本卡声称修好的缺陷 id（`DEF-*`；DEF-050 / TASK-072） */
  fixes?: string[] | undefined
  /** 本卡声称消除的风险 id（`RISK-*`；DEF-051 / TASK-080） */
  mitigates?: string[] | undefined
  /** 仍要开着的风险及其署名理由（DEF-051 / TASK-080） */
  mitigatesWaiver?: MitigatesWaiver[] | undefined
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
    fixes: draft.fixes ?? [],
    mitigates: draft.mitigates ?? [],
    mitigatesWaiver: draft.mitigatesWaiver ?? [],
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

/**
 * **派生写范围的模块数上限**（TASK-074 落点二 / DEF-052）。
 *
 * 为什么是 3：写范围 = "这张卡可以独占哪些文件"（并行安全的租约），不是"这个元素大概归哪个目录"。
 * 真机反例：元素的 `responsibility` 是自由文本，`parseWriteScopes` 把它解析成 **10 个模块**
 * （`src/domain/{gates,process,records,…}.ts`）——一张卡独占 10 个模块等于**授权整块重写**，
 * 与"一张卡 = 一个可独立验证的增量"（§8.6）直接冲突；而 TASK-069 的写范围含
 * `src/domain/plan.ts`，一度把真修卡 TASK-071 堵在派发队列外。
 *
 * 为什么不是别的数：上限只拦"明显不是一张卡的活"，不替人判断粒度 —— 本仓真机上**正常的**
 * 结构卡写范围通常是 1~2 个模块（典型 `scopeTemplate` 是 `src/<slug>/,test/<slug>/` = 2 个），
 * 3 给它留一格余量；4 及以上在真机上已出现"整块重写"反例，而 2 会把合法的
 * 「实现 + 测试」双目录模板误判成超限（那是常态，不是缺陷）。超限时**拒绝生成**并在回执里点名，
 * 出路是人在元素职责里写明更窄的「写范围：<glob> 独占」（`parseWriteScopes`）或改 `scopeTemplate`。
 */
export const SCOPE_MODULE_LIMIT = 3

/** `.sdo/config.yml` 的 `plan` 段（结构通道读的三项：写范围模板 + 显式「无需卡」元素 + 依据口径）。 */
interface PlanConfig {
  plan?: { scopeTemplate?: unknown; noCardElements?: unknown; requireCoverageBasis?: unknown } | undefined
}

/**
 * **结构通道是否需要「判重依据」才建卡**（TASK-104 落点二 / 缺陷 DEF-063）。
 *
 * 判据**只有一个**：`.sdo/config.yml` 的 `plan.requireCoverageBasis` 显式写 `true`。
 * 不写 ⇒ `false`（**历史行为**：依据为空即建卡），而回执会**如实**印出「判重依据为空」
 * 与"本项目尚未采纳依据门槛、怎么采纳"（`kStructuralPolicyAdvisory`）。
 *
 * **为什么必须显式，而不是自动推断**（这条是写下来的取舍，不是疏漏）：
 *   · **不能默认 `true`**：实测（本卡的探针，改动前先跑）—— 把"依据为空即拒绝"设成默认，会让
 *     **所有**只造了 `req-des` 边、没有 `des-task` 边的项目/夹具**一张卡都建不出来**，全量
 *     1059 条用例里 **18 条**立刻转红（M101-04/07/08/10/12/13/14、M4 三条、M14-10、M80-06…）。
 *     那是一次**破坏性变更**，得由驾驶舱按项目逐个批准，一张卡的写范围容不下那些文件。
 *   · **也不能拿 `noCardElements` 非空当"已采纳"的信号**（本卡试过，是错的）：`noCardElements`
 *     的语义是**逐元素**的「这个元素无需卡」，它在真源里已经写着 12 个具体 id；把"列表非空"
 *     当成全局模式开关，等于**静默改变已有逐元素裁决的含义** —— 实测立刻打红 M101-10
 *     （`noCardElements` 只点名 `DES-777`，却导致另一个元素不再建卡）。两种语义必须分开表达。
 *
 * 于是：**门槛是显式的、回执是自解释的、收口是一次性的**（落点三）。本仓当前正是"未采纳"，
 * 所以它不会自动生效 —— 采纳动作由驾驶舱把 `plan.requireCoverageBasis: true` 写进 `.sdo/config.yml`
 * （那是 `.sdo/` 公共面，不在本卡写范围）。
 */
function requireCoverageBasisOf(config: PlanConfig | undefined): boolean {
  return config?.plan?.requireCoverageBasis === true
}

/** 「依据为空」的元素**缺哪几条依据**（回执要逐条点名，不给一句笼统的"没依据"）。 */
export const COVERAGE_BASIS_ITEMS = ['des-task', 'title-marker', 'no-card-element'] as const

/** `missing` 的元素类型（回执按语言包渲染成"缺哪条依据"）。 */
export type CoverageBasisItem = (typeof COVERAGE_BASIS_ITEMS)[number]

/**
 * **待裁决的元素**（TASK-104 落点二）：判重依据为空 ⇒ 没落盘、没进派发队列，
 * 等人在三条出路里选一条。`missing` 就是"缺哪几条依据"。
 *
 * 为什么单独一条读数而不是塞进 `StructuralSkip`：`skip` 是"这个元素**不需要**卡"
 * （已有卡 / 明确无需卡 / 写范围超限），而这条是"**不知道**它有没有人做、要人来裁"——
 * 两者混在一起读者就分不出"拒绝"与"待裁决"（DEF-063 要消灭的正是这个混同）。
 */
export interface StructuralGapRow {
  /** 哪个设计元素 */
  designId: string
  /** 元素名（回执点名用） */
  name: string
  /** 缺哪几条依据（`des-task` / `title-marker` / `no-card-element`） */
  missing: CoverageBasisItem[]
}

/** 依据为空的元素会缺哪几条（`des-task` / 标题 marker / `noCardElements` **都没命中**）。 */
function missingBasisOf(): CoverageBasisItem[] {
  return [...COVERAGE_BASIS_ITEMS]
}

/**
 * **结构通道一次判定的完整读数**（`StructuralPlan` + TASK-104 的两样）：
 * `basisPolicy` 是"本项目走哪条口径"，`needsDisposition` 是"这批元素等着被裁"。
 */
export type StructuralPlanResult = StructuralPlan & {
  basisPolicy: 'required' | 'advisory'
  needsDisposition?: StructuralGapRow[] | undefined
}

/**
 * `plan.noCardElements` 的取值归一化：只认可读的字符串 id（容忍单值字符串），其余忽略。
 *
 * 为什么去重：回执要按元素逐条列名，同一 id 写两遍会让"跳过了哪些元素"这条读数虚高。
 */
function noCardElementsOf(value: unknown): Set<string> {
  const raw = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const ids = raw
    .map((item) => textOf(item).trim())
    .filter((item) => item !== '')
  return new Set(ids)
}

/**
 * **某个设计元素是否已经"有卡了"**（TASK-074 落点一：三种任一即算覆盖）。
 *
 * `titleMarker` 由调用方（`structuralDrafts`）预先在**卡标题快照**上算一次 —— 它是"矩阵"，
 * 每元素 × 每卡都去 `includes` 会让判定与卡数平方相关。三条口径的来历：
 *   ① `des-task` 边（**主口径**）：追溯图里"这个设计元素已经有卡在做"的第一类关系，
 *      与 C-21（覆盖率按边算）同源；手工功能卡不带标题标记，只有这条边认得出来（DEF-052 的漏判方向）；
 *   ② 标题 marker（**历史兜底**）：本仓有 23 张 dropped 的「实现 X（DES-yyy）」卡**没有** `des-task` 边，
 *      去掉这条会让它们被重复生成（本卡不为存量卡补边 —— 那是数据迁移，另有其卡）；
 *   ③ `noCardElements`（**显式「无需卡」**）：元素确实不需要独立的卡时，由人写进 `config.yml` 说清楚，
 *      而不是靠"建一张卡再 drop 掉"来表达。
 *
 * **TASK-104 落点一（DEF-063）把"查无依据"与上面三态分开**：三者都不命中时返回 `'missing'`，
 * 而**不是**含糊的 `undefined`（旧实现里 `undefined` 与"从未查过"无法区分，于是回执把
 * 「找不到覆盖证据」说成了「没人做」—— 在存量补录项目里每轮必长废卡）。三态与"依据为空"的
 * **第四种读数**必须彼此可辨：
 *   · `already-covered` = **覆盖证据存在**（凭 `des-task` 边或标题 marker 跳过）；
 *   · `no-card-needed`  = **人已明确裁决"无需卡"**（凭 `noCardElements` 跳过）；
 *   · `missing`         = **判重依据为空**（`des-task` 边 / 标题 marker / `noCardElements` **都没命中**）
 *     —— 它只证明"找不到覆盖证据"，**不证明"没人做"**：出处是三条依据本身，不是事实。
 */
function coverageOf(
  designId: string,
  titleMarker: ReadonlySet<string>,
  linkTargets: ReadonlySet<string>,
  noCardElements: ReadonlySet<string>,
): 'already-covered' | 'no-card-needed' | 'missing' {
  if (linkTargets.has(designId)) return 'already-covered'
  if (titleMarker.has(designId)) return 'already-covered'
  if (noCardElements.has(designId)) return 'no-card-needed'
  return 'missing'
}

/**
 * **写范围护栏**（TASK-074 落点二）：派生写范围不得含 `{}` 展开语法、且模块数不得超过
 * {@link SCOPE_MODULE_LIMIT}。返回**被拒的那一组**（原样回报，便于人核）+ 是否违规。
 *
 * 为什么把两个条件合并成一个读数：`{}` 展开语法（`src/{domain,interface}/`、`src/{a,b}/`）
 * 本质上是**把一张卡写成一批模块**的写法 —— 它和"模块数超限"是同一个病（授权整块重写），
 * 只是前者把数量藏进了文件名里，机械数不出来 ⇒ 必须**独立**判一次，不能靠数模块数兜住。
 *
 * 为什么被拒时报**原始文本**而不是解析出的数组：`scopeTemplate` 本身就按逗号切分，而
 * `{}` 里也有逗号（`src/{a,b}/` 会被切成 `src/{a` + `b}/`）—— 这时"解析结果"是解析器的
 * 伪影，读者要核的是**他写下的那串模板**。所以含 `{}` 的那一组一律按原文回报。
 */
function scopeGuardOf(candidates: { raw?: string | undefined; scopes: string[] }[]): { rejected: string[]; violates: boolean } {
  let rejected: string[] = []
  let violates = false
  const shown = (candidate: { raw?: string | undefined; scopes: string[] }): string[] =>
    candidate.raw !== undefined && candidate.scopes.some((scope) => scope.includes('{') || scope.includes('}'))
      ? [candidate.raw]
      : candidate.scopes
  for (const candidate of candidates) {
    const bad = candidate.scopes.some((scope) => scope.includes('{') || scope.includes('}')) || candidate.scopes.length > SCOPE_MODULE_LIMIT
    if (!bad) continue
    violates = true
    if (shown(candidate).length > rejected.length || rejected.length === 0) rejected = shown(candidate)
  }
  return { rejected, violates }
}

/**
 * 结构通道的**草稿**：只有该建的元素才有草稿（覆盖/无需卡/写范围超限的元素在这里被跳过，
 * 判定与理由由 {@link structuralPlanOf} 给出 —— 两处同源，不各写一套）。
 *
 * `derived`：收集"写范围是按模板派生的"元素（调用方把它交回回执，见 `decompose` 的 `notes`）。
 */
export function structuralDrafts(
  store: SdoStore,
  requirements: Requirement[],
  derived: string[] = [],
): { drafts: TaskDraft[]; plan: StructuralPlanResult } {
  const links = readLinks(store)
  const elements = new Map(listElements(store).map((element) => [element.id, element]))
  const drafts: TaskDraft[] = []
  const created: StructuralCardPlan[] = []
  const plan = structuralPlanOf(store, requirements)
  const coverages = new Map(plan.created.map((row) => [row.designId, row]))
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
    const row = coverages.get(designId)
    // **G-04 + DEF-052**：被覆盖 / 被显式标记「无需卡」/ 写范围超限 ⇒ 这张卡不生成
    // （判定与理由都由 `structuralPlanOf` 给出，本函数只负责把"该生成的"变成草稿）
    if (row === undefined) continue
    const element = bucket.element
    const role: Role = VIEW_KIND_OF_ELEMENT[element.kind] ?? 'developer'
    const title = fmt('uiPlan.t2', { p1: element.name, p2: designId })
    if (row.how === 'none') created.push(row)
    // 写范围**不是**元素自己声明的（`parseWriteScopes` 没解析出来）⇒ 它是按模板派生的：
    // 把这件事交回回执（`decompose` 的 `notes` → `scopeDerivedNote`），否则人不知道范围从哪来
    if (parseWriteScopes(element.responsibility).length === 0) derived.push(fmt('uiPlan.t1', { p1: designId, p2: element.name }))
    drafts.push({
      title,
      goal: fmt('uiPlan.t3', { p1: element.name, p2: bucket.requirements.join('、') }),
      inputs: [fmt('uiPlan.t4', { p1: designId, p2: element.responsibility }), fmt('uiPlan.t5', { p1: bucket.requirements.join('、') })],
      outputs: [fmt('uiPlan.t6', { p1: element.name })],
      dod: [
        ...bucket.requirements.map((id) => fmt('uiPlan.t7', { p1: id })),
        t('uiPlan.k1'),
      ],
      evidenceRequired: ['artifact'],
      writeScopes: row.writeScopes,
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
  // 没建卡的明细来自 `structuralPlanOf`（同源，含覆盖 / 无需卡 / 写范围超限 / **依据为空**四种原因）
  return {
    drafts,
    plan: {
      created,
      skipped: plan.skipped,
      basisPolicy: plan.basisPolicy,
      ...(plan.needsDisposition === undefined ? {} : { needsDisposition: plan.needsDisposition }),
    },
  }
}

/**
 * **结构通道的判定/护栏本身**（TASK-074 落点一 + 落点二 + TASK-104 落点一/二）—— 与
 * `structuralDrafts` **同源**，输出的是**计划**而不是草稿：
 *   · `created`：这个元素**该建卡**（还没建），带标题 + 写范围 + `how`（`none` = 未命中任何覆盖判定）；
 *   · `skipped`：这个元素**不建卡**，带原因（`already-covered` / `no-card-needed` /
 *     `scope-too-broad` / **`no-basis`**= 判重依据为空被拒）。
 *
 * **TASK-104（DEF-063）新增的三样读数**（都在同一个返回值里，界面层只渲染不判定）：
 *   · `basisPolicy`：本项目走的是哪条口径（`required` = 依据为空即**拒绝生成** /
 *     `advisory` = 历史行为建卡但如实标注）—— 回执要写明，否则读者不知道"为什么这次没拒"；
 *   · `needsDisposition`：**依据为空**的元素逐条（id + 名字 + **缺哪几条依据**）。
 *     有这个字段就是"待裁决"：这批元素什么都没落盘，等着人三选一（补边 / 写 `noCardElements` /
 *     明确要建卡）—— 绝不许混进正常派发队列，所以它既不进 `created` 也不进 `skipped` 的
 *     "已有卡"那一族。
 *
 * 为什么要单独导出：`sdo_plan action=next` 的回执也要**逐条列出**这批结构卡（落点三），
 * 而 `next` 自己不拆卡 —— 它必须能**从同一份判定**重新算出"这批卡是什么、写范围是什么、
 * 为什么没建"，否则两处口径会各写一套（那正是 DEF-052 的病灶形状）。判定只读真源
 * （追溯边 / 卡标题 / `config.yml`），不写盘。
 */
export function structuralPlanOf(store: SdoStore, requirements: Requirement[]): StructuralPlanResult {
  const links = readLinks(store)
  const elements = new Map(listElements(store).map((element) => [element.id, element]))
  const skipped: StructuralSkip[] = []
  const created: StructuralCardPlan[] = []
  // **一次读卡，两次用**：覆盖判定的标题 marker 口径要的是"当前卡标题"快照
  const tasks = listTasks(store)
  const titleMarker = new Set<string>()
  const linkTargets = new Set<string>()
  for (const task of tasks) {
    for (const match of task.title.matchAll(/（(DES-\d+)）/gu)) {
      const designId = match[1]
      if (designId !== undefined) titleMarker.add(designId)
    }
  }
  // **主口径**：追溯图里的 `des-task` 边（`links` 在函数开头已读到，不新增读取路径）
  for (const item of links) if (item.kind === 'des-task') linkTargets.add(item.from)
  const config = store.readYaml<PlanConfig>('config.yml')
  const noCardElements = noCardElementsOf(config?.plan?.noCardElements)
  const scopeTemplate = config?.plan?.scopeTemplate
  // **落点二（DEF-063）**：本项目的口径 —— 依据为空时是**拒绝生成**还是按历史行为建卡（见函数注释）
  const requireBasis = requireCoverageBasisOf(config)
  const gaps: StructuralGapRow[] = []
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
    // **G-04 + DEF-052**：元素已有卡（任何状态）或曾被显式放弃 → 不重建；口径见 `coverageOf`
    const basis = coverageOf(designId, titleMarker, linkTargets, noCardElements)
    if (basis === 'already-covered') {
      skipped.push({
        designId,
        name: element.name,
        reason: 'already-covered',
        how: linkTargets.has(designId) ? 'des-task' : 'title-marker',
      })
      continue
    }
    if (basis === 'no-card-needed') {
      skipped.push({ designId, name: element.name, reason: 'no-card-needed', how: 'no-card-element' })
      continue
    }
    // **落点二 / 三态可辨（DEF-063）**：`basis === 'missing'` = **判重依据为空** ——
    // 三条依据（`des-task` 边 / 标题 marker / `noCardElements`）**都没命中**。这只证明
    // "找不到覆盖证据"，**不证明"没人做"**（存量补录项目里追溯边天然缺失）。
    // 采纳了依据口径的项目（见 `requireCoverageBasisOf`）⇒ **拒绝生成**：不落盘、不进派发队列，
    // 并把这个元素连同"缺哪几条依据"与三条处置出路交回回执（界面层渲染，域层不塞中文）。
    // 未采纳的项目 ⇒ 保持历史行为建卡，但 `how: 'none'` 仍**如实**标出"未命中任何覆盖判定"，
    // 回执同样印出这条读数 —— 静默是缺陷的一半，两处都不许静默。
    const basisEmpty = basis === 'missing'
    const declared = parseWriteScopes(element.responsibility)
    const slug = designId.toLowerCase()
    const derivedScopes =
      typeof scopeTemplate === 'string' && scopeTemplate.trim() !== ''
        ? scopeTemplate
            .split(',')
            .map((item) => item.replaceAll('{{slug}}', slug).replaceAll('{{id}}', designId).trim())
            .filter((item) => item !== '')
        : [`src/${slug}/`, `test/${slug}/`]
    const scopes = declared.length > 0 ? declared : derivedScopes
    // **落点二**：派生写范围超限（> SCOPE_MODULE_LIMIT 个模块或含 `{}` 展开语法）⇒ **拒绝生成该卡**
    // 并点名元素与解析出的写范围（等于授权整块重写，见 SCOPE_MODULE_LIMIT 的注释）；
    // 两条来源都查：元素职责里声明的（`parseWriteScopes` 的产物）与 `config.yml` 的模板
    const guard = declared.length > 0
      ? scopeGuardOf([{ scopes: declared }, { raw: typeof scopeTemplate === 'string' ? scopeTemplate : undefined, scopes: derivedScopes }])
      : scopeGuardOf([{ raw: typeof scopeTemplate === 'string' ? scopeTemplate : undefined, scopes }])
    if (guard.violates) {
      // **判据顺序（写下来的取舍）**：写范围超限在"依据为空"**之前**判 —— 它是**更具体**的拒因
      // （点名的是"什么被拒了"），而"依据为空"说的是"凭什么立这张卡"。反过来会让超限元素
      // 只报 `no-basis`、把既有的写范围读数吃掉（本卡的回归用例 M107-10/11 就钉在这一点上）。
      skipped.push({ designId, name: element.name, reason: 'scope-too-broad', scopes: guard.rejected })
      continue
    }
    if (basisEmpty && requireBasis) {
      gaps.push({ designId, name: element.name, missing: missingBasisOf() })
      // **`reason: 'no-basis'` 是新的一位读数**（`StructuralSkipReason` 在 `types.ts`，不在本卡写范围）：
      // 用显式断言把它放进去 —— 渲染层（`describe.ts`）已按运行时值加宽了联合类型并渲染它；
      // 这里**不**把它降级成既有的某一位（那会让"拒绝"与"已有卡/无需卡/写范围超限"重新混同，
      // 正是 DEF-063 要消灭的形态）。
      skipped.push({ designId, name: element.name, reason: 'no-basis' } as unknown as StructuralSkip)
      continue
    }
    created.push({ designId, title: fmt('uiPlan.t2', { p1: element.name, p2: designId }), writeScopes: scopes, how: 'none' })
  }
  // `needsDisposition` 只在真的有"依据为空"的元素时出现（空数组不入回执，免得回执长出无用小节）
  return { created, skipped, basisPolicy: requireBasis ? 'required' : 'advisory', ...(gaps.length === 0 ? {} : { needsDisposition: gaps }) }
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
      // **ADR-009 / DEF-057**：唯一出口（归一 + 目录边界前缀）—— 旧的双向 `startsWith`
      // 把 `src/a.ts` × `src/a.tsx` 判成"可能并行但写范围重叠"（假阳性，评审卡因此被无谓推迟）。
      const overlap = scopeOverlaps(a.writeScopes, b.writeScopes)
      if (overlap.length > 0) {
        // **SDO-46**：把"挡住你的那张卡是什么状态"和"怎么腾范围"直接写给读者 —— 真机上被挡住的新卡
        // 只看到一张看板，误判成"卡没建成"；确认后显式 `drop` 阻塞卡即立刻可派。
        const holderNote = a.status === 'blocked' || b.status === 'blocked' ? t('uiPlan.kBlockedHolderNote') : ''
        issues.push({
          code: 'write-scope-disjoint',
          taskId: a.id,
          detail: fmt('uiPlan.t15', { p1: a.id, p2: b.id, p3: overlap.join('、') }) + holderNote,
          remedy: t('uiPlan.k13') + t('uiPlan.kScopeReleaseHint') + t('uiPlan.kScopeSplitSuggestion'),
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
): {
  tasks: TaskCard[]
  issues: PlanIssue[]
  notes?: string[] | undefined
  structuralCount?: number | undefined
  /**
   * **结构通道的逐条明细**（TASK-074 落点三）：本次生成了哪些结构卡（标题 + 写范围 + 判定依据）、
   * 哪些元素**没有**生成卡及原因。域层只给数据 —— 面向用户的文案由界面层按语言包渲染
   * （本文件在 m7 棘轮基线表内，允许的新增硬编码中文数为 **0**）。
   *
   * **TASK-104 落点一/二**：`structural` 里另带 `basisPolicy`（本项目走哪条依据口径）与
   * `needsDisposition`（**依据为空**因此**没有落盘**的元素：id + 名字 + 缺哪几条依据）。
   * 有一张卡落盘就必须有一条判重依据 —— 没有依据的元素**不落盘、不进派发队列**，
   * 只以"待裁决"的身份出现在回执里（见 `StructuralGapRow`）。
   */
  structural?: (StructuralPlan & { basisPolicy: 'required' | 'advisory'; needsDisposition?: StructuralGapRow[] | undefined }) | undefined
} {
  const selected = input.requirements === undefined
    ? requirements
    : requirements.filter((requirement) => input.requirements?.includes(requirement.id))
  const derived: string[] = []
  const structural = structuralDrafts(store, selected, derived)
  // **D-12（设计取舍，不改粒度）**：结构通道按「每设计元素一张」产出，写范围由模板推导 ——
  // 粒度与范围**可能与项目布局不符**（真机：7/21 张对应 actor/实体/外部系统，不可独立实现）。
  // 插件不替人判断"哪些元素可独立实现"，但**必须把这件事说出来**，否则那批卡只能靠人肉发现。
  // **D-12**：把"这批卡从结构通道来、粒度与模板范围可能不符"如实交回回执（文案在界面层，
  // 域层不塞用户可见中文）—— 插件不替人判断哪些元素可独立实现，但必须把这件事说出来。
  const structuralCount = structural.drafts.length
  const drafts = [
    ...structural.drafts,
    ...(input.suggestions ?? []),
  ]
  const existing = listTasks(store)
  // **D3-1**：去重集合必须**包含本批新建的卡**（旧实现只比对调用前的卡集 → 批内重复照样建）
  const seen = new Set(
    existing.filter((task) => task.status !== 'dropped').map((task) => `${task.title}|${task.role}`),
  )
  const created: TaskCard[] = []
  // **落点三**：回执要"逐条列出本次生成的结构卡"——只有**真的落盘**的才算数，所以按标题把
  // 结构卡的明细对上（`D3-1` 的批内去重可能吃掉一张，那时它不该出现在回执里）
  const planByTitle = new Map(structural.plan.created.map((row) => [row.title, row]))
  const structuralCreated: StructuralCardPlan[] = []
  for (const draft of drafts) {
    const key = `${draft.title}|${draft.role}`
    if (seen.has(key)) continue
    seen.add(key)
    const task = createTask(store, journal, {
      ...draft,
      ...(input.iteration === undefined ? {} : { iteration: input.iteration }),
    })
    created.push(task)
    const planRow = planByTitle.get(draft.title)
    if (planRow !== undefined) structuralCreated.push(planRow)
    // **D-12（sdo-test-new 2026-10-08，major）**：拆卡时就把 `req-task` 边建起来。
    // 旧实现只 `createTask`，追溯边要等卡**完成**才由 `office.ts` 补 —— 于是 G5 的 C-41（需求→任务覆盖）
    // 在开发期永远是 0，真机上只能人工补 22 条边。`linkMany` 自带去重，与完成时的补边不会重复。
    const reqIds = draft.requirements ?? []
    if (reqIds.length > 0) {
      linkMany(store, journal, reqIds.map((requirement) => ({ from: requirement, to: task.id, kind: 'req-task' })))
    }
  }
  const tasks: TaskCard[] = listTasks(store)
  const structuralResult: StructuralPlan & { basisPolicy: 'required' | 'advisory'; needsDisposition?: StructuralGapRow[] | undefined } = {
    created: structuralCreated,
    skipped: structural.plan.skipped,
    basisPolicy: structural.plan.basisPolicy,
    ...(structural.plan.needsDisposition === undefined ? {} : { needsDisposition: structural.plan.needsDisposition }),
  }
  return {
    tasks,
    issues: validatePlan(tasks),
    notes: derived,
    structuralCount,
    structural: structuralResult,
  }
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

/**
 * 派发优先级的**显式秩**（DEF-008 / TASK-071）：`trivial`=0 < `small`=1 < `medium`=2 < `large`=3。
 *
 * 为什么不用字符串序：`a.size.localeCompare(b.size)` 的真实次序是 `'large' < 'medium' < 'small'`
 * （l < m < s），与"小→大"**正好相反** ⇒ `large` 先派、`small` 垫底。真机症状：评审卡是 `small`，
 * 排在 4 张 `medium` 之后，`readyTasks(tasks, 4)` 时**根本取不到** ⇒ 评审被系统性推迟。秩表是显式的，
 * 不再让"字母表"决定调度意图。
 */
const SIZE_RANK: Record<string, number> = { trivial: 0, small: 1, medium: 2, large: 3 }

/**
 * 未知 / 缺失规模值的**兜底秩 = 4（排最后）**，理由：
 *   · 判据是"小步快跑、先把小卡落地"；把**认不出**的档位塞进队首，正好是 DEF-008 的病灶重演
 *     （未知值插队到 `small` 之前 ✗）；
 *   · 排最后是最保守的落位：只要 limit 没被已知档位占满，它照样会被取到（不会静默消失），
 *     但不会抢在已知的更小卡前面占掉名额。
 * 缺失（`undefined`）走同一档（统一 rank 4）：本函数对一个"规模非法"的卡不 panic、不抛错，
 * 排序保持全序、可比较 —— 规模的合法性由 `validatePlan` 负责（本函数不做字段校验）。
 */
const UNKNOWN_SIZE_RANK = 4

/** 依赖已满足、可以派发的卡（按规模小→大 = `trivial` < `small` < `medium` < `large`；同档按 id 升序；未知档排最后）。 */
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
  // 排序键：**规模秩（显式）→ id 升序**。规模秩的取值与兜底理由见上方 `SIZE_RANK` / `UNKNOWN_SIZE_RANK`。
  const rank = (task: TaskCard): number => SIZE_RANK[task.size] ?? UNKNOWN_SIZE_RANK
  return tasks
    .filter((task) => (task.status === 'planned' || task.status === 'ready') && task.blockedBy.every((id) => satisfied(task, id)))
    .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
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

/**
 * **"为什么这张卡这一轮派不出去"的分类**（DEF-049 / TASK-078 的落点二）。
 *
 * 病灶：`sdo_plan action=next` 以前对"一张都没派出去"只有一句笼统的"没有可派发的任务卡
 * （都已认领/完成）"，于是**有 blocked 卡**的情形被读成"活干完了"——真机上驾驶舱为此白走两轮。
 * `blocked` 与"写范围冲突 / 依赖未满足"是**两种完全不同的处置**（前者要 `unblock` 或 `drop`，
 * 后者要么等依赖、要么腾范围），所以必须**分列**，不能混成一句。
 *
 * 返回**结构化**结果、不返回文案：本模块（`plan.ts`）在 m7 的 i18n 棘轮表里基线为 **0** ——
 * 一个中文字面量都不许加。渲染在 `src/index.ts`（同样基线 0）与语言包里做。
 *
 * 分类口径（互斥优先，按处置紧急度排序）：
 *   ① `blocked` —— 状态就是 `blocked`：**只有 unblock 或 drop 能解开**，最需要被看见；
 *   ② `scope` —— 状态上本可派，但 1:1 独占写范围与另一张未结束的卡重叠（`write-scope-disjoint`）；
 *   ③ `dependencies` —— `blockedBy` 里还有未完成的卡。
 */
/** 一张计划卡被**在飞卡**的写范围挡住（DEF-067 派发前置检查的读数）。 */
export interface ScopeHold {
  task: TaskCard
  holder: TaskCard
  /** 重叠的路径（**点名**，不是倒出对方的全量写范围） */
  overlap: string[]
}

/**
 * **派发前置检查**（DEF-067 / ADR-009 的不变量「派发可认领」，2026-10-14 机制缺陷批）。
 *
 * 不变量：一张卡被派出时它必须**能够认领成功** —— 即「可派发」= 依赖已满足 ∧
 * **写范围不与任何在飞卡相交**。旧实现只查 `blockedBy`，于是派出注定认领失败的卡
 * （真机：三张核实卡写同一个 `.sdo/reviews/`，两张认领失败、各白烧一轮会话）。
 *
 * 判定走**唯一出口** `scopeOverlaps`（归一 + 目录边界前缀，与认领期/计划期同一套语义）；
 * 不含任何语言/格式假设（REQ-060）—— 它只用到插件已有的两个事实：依赖图与路径集合。
 *
 * 显式声明过先后的（`blockedBy` 任一方向）不算"意外挡路"：那是人的裁决，不是争用。
 */
export function scopeHeldTasks(tasks: readonly TaskCard[]): ScopeHold[] {
  const inFlight = tasks.filter((task) => task.status === 'in-progress')
  if (inFlight.length === 0) return []
  const out: ScopeHold[] = []
  for (const task of tasks) {
    if (task.status !== 'planned' && task.status !== 'ready') continue
    for (const holder of inFlight) {
      if (holder.id === task.id) continue
      if (task.blockedBy.includes(holder.id) || holder.blockedBy.includes(task.id)) continue
      const overlap = scopeOverlaps(task.writeScopes, holder.writeScopes)
      if (overlap.length > 0) {
        out.push({ task, holder, overlap })
        break
      }
    }
  }
  return out
}

export interface NonDispatchablePlan {
  /** ① 需要 unblock / drop 的 blocked 卡 */
  blocked: TaskCard[]
  /** ② 写范围与别的未结束卡重叠（1:1 独占的卡才有意义） */
  scope: { task: TaskCard; other: string; overlap: string[] }[]
  /** ③ 依赖未满足 */
  dependencies: { task: TaskCard; waitingOn: string[] }[]
}

export function classifyNonDispatchable(tasks: TaskCard[]): NonDispatchablePlan {
  const ended = (task: TaskCard): boolean =>
    task.status === 'done' || task.status === 'verified' || task.status === 'dropped'
  const blocked = tasks.filter((task) => task.status === 'blocked')

  // ② 写范围重叠：与 `validatePlan` 的 `write-scope-disjoint` **同一口径**（未结束 × 前缀重叠
  // × 已声明依赖关系则不算冲突）。这里只看 `planned` / `ready` —— blocked 卡已归 ①，
  // `in-progress` 的卡有自己的认领主线，混进来只会让"该谁让路"读不清。
  const scope: NonDispatchablePlan['scope'] = []
  for (const task of tasks) {
    if (task.status !== 'planned' && task.status !== 'ready') continue
    // 1:1 独占的口径与设计一致：**单一路径**的写范围才谈得上互斥；多路径是"共同公约"声明，
    // 它本来就不阻止别人也写同一片（否则任何共同面都会把计划钉死）。
    if (task.writeScopes.length !== 1) continue
    for (const other of tasks) {
      if (other.id === task.id || ended(other)) continue
      if (other.status === 'blocked') continue
      if (task.blockedBy.includes(other.id) || other.blockedBy.includes(task.id)) continue
      // **ADR-009 / DEF-057**：与 `validatePlan` 同一个出口。这里保留"**对方**参与重叠的路径"
      // （回执要说清挡住你的是哪条路径）。
      const overlap = scopeOverlaps(other.writeScopes, task.writeScopes)
      if (overlap.length > 0) {
        scope.push({ task, other: other.id, overlap: overlap.map((item) => textOf(item)) })
        break
      }
    }
  }

  // 一次算好，避免对同一批卡重复走两遍依赖判定
  const waiting = blockedTasks(tasks)
  return {
    blocked,
    scope,
    // ③ 依赖未满足：blocked 卡已归 ①，别在两类里各报一次（否则读者会以为有两张卡）
    dependencies: waiting
      .filter((item) => item.task.status !== 'blocked')
      .map((item) => ({ task: item.task, waitingOn: item.waitingOn })),
  }
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
