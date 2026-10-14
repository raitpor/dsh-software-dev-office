/**
 * **回归一等纪律**（REQ-052：变更集 → 影响集 → 回归集）。
 *
 * ## 这条纪律解决什么
 *
 * 别的判据问"我们测过了吗"，本条问**"这一次改动之后，我们该重跑的东西重跑了吗"**。
 * 三件事连成一条链，缺一环就判红：
 *
 * | # | 环节 | 机械判据 |
 * |---|---|---|
 * | ① | **变更集** | 从**台账**里现取（变更请求 / 已修缺陷 / 工作区改动），不是人手抄一份清单 |
 * | ② | **影响集** | 由**追溯图**多跳闭包推出（`trace.traceClosure`），不是人手罗列 |
 * | ③ | **回归集** | 影响集里的**每条用例**都要有结果；每条结果绑**被测产物哈希** |
 *
 * ## 三条降级口径（都是"不许静默"那一类）
 *
 * ① **追溯图为空 / 种子一条边都走不出去 ⇒ 影响面不可推导**，显式报出来并给人工确认入口
 *   （`undecidable` / `notice`），**不默认"无影响"** —— REQ-052 的降级口径原文。
 *   反过来，图**非空且确实推出 0 条用例**（例如影响集里只有设计元素还没有用例）**不算不可推导**：
 *   那是"推出来了、就是没有"，把它当不可推导会让判据永远发不出绿。这两种要分得开。
 * ② **图上补不了"改了哪些文件"**：`workspace/changes` 记的是**文件路径**，图里是**实体 id**。
 *   只有图里恰好出现了该路径时才能补成实体；补不上就如实记成 `file` 项并把这件事说出来
 *   （`rawFileCount`）—— **不假装文件归属某个需求**（那是凭空造影响面）。
 * ③ **产物路径没记**（`artifact` 位只写了哈希）：哈希在手但读不出产物在哪 ⇒ 判 `unknown`
 *   并点名缺什么，**不假装过期、也不判绿**（与 `coverage.ts` 的处置逐字同口径）。
 *
 * ## 判红的优先序（有意为之）
 *
 * `stale`（跑的是**上一版**产物）> `not-run`（该跑没跑）> `failed` > `unbound` > `unknown`。
 * 先重跑、再补跑、最后回头补记录 —— "跑过了"这件事本身是后面所有讨论的前提。
 *
 * ## 与相邻模块的分工（免得后人重复造）
 *
 * · `trace.ts`（TASK-019 的图面）：**怎么从图里走**（邻接面 + 多跳闭包），本模块**不自己走边**。
 * · `coverage.ts`（TASK-016）：覆盖**读数**的时效判定（八项齐备 / 报告哈希 / 产物哈希）。
 *   与本模块**同一套哈希口径**（`pathFingerprint` / `sameHash`），判的**对象不同**（读数 vs 回归跑的结果）。
 * · `records.ts` 的 `evidenceFreshness`（SDO-57）：**用例结果**的时效判定（latest-wins + 环境指纹）。
 * · `testingShapes.ts`（TASK-012）：`regression.yml` 的**形状**（键在不在、枚举认不认、哈希写法对不对）。
 *   它明确不管"产物是否真的对得上"—— 那正是本模块。
 *
 * ## 四条纪律（与 `coverage.ts` 逐字同规）
 *
 * ① **fail-closed**：不抛异常。读不动 / 没给 / 对不上，一律落进 `issues` 并给 `unknown`，
 *   绝不当 `ok`（`ok` 只有一个来源：逐条核过且都对得上）。
 *   真源**读不动**（文件在盘上却解析不出对象）判**红**，不降级成 N/A —— 见 `assessRegressionFromStore`。
 * ② **只读**：不写盘、不落 journal（回归结果由人经 `sdo_test` 记录，本模块只判它算不算数）。
 * ③ **点名到字段**：每条问题带点号路径（`cases[1].artifact`）。
 * ④ **不判"该不该跑全"**：回归**范围收窄**（显式声明不跑的项与理由）是人的决定，
 *   本模块只要求它**留痕**（`narrow`）；把范围判断塞进机械判据只会逼人编造。
 *
 * ## TASK-055：把"有变更却无真源"这一档收回来
 *
 * 本模块只如实报"真源在不在盘上"，**"该不该有真源"由变更集决定**，判定在门禁侧
 * （`gates.ts` 的 `assessRegressionCriterion`）：变更集非空 ⇒ 真源缺失 / 为空 / 读不动**一律判红**
 * （`source-not-recorded`）；变更集为空 ⇒ 才按 **N/A**（没有变更就没有回归义务），
 * 免得一张只改文档、连一条变更都没有的卡被这条纪律误伤。
 */
import { listChanges } from './change.js'
import { pathFingerprint, sameHash } from './coverage.js'
import { listDefects } from './records.js'
import { TESTING_SOURCE_FILES, readTestingSource } from './testingStore.js'
import { traceClosure, traceGraph, traceGraphOf, traceNeighbors } from './trace.js'
import { readWorkspaceChanges } from './workspaceChanges.js'
import { textOf } from '../infra/scalar.js'
import type { SdoStore } from '../infra/store.js'
import type { TraceEdge, TraceGraph } from './trace.js'

/** 真源位置（`.sdo/testing/regression.yml` / 它的根键 `regression:`）。 */
export const REGRESSION_FILE = 'regression'
export const REGRESSION_ROOT_KEY = 'regression'

// —————————————————————— 一、三类结论的形状 ——————————————————————

/** 回归链上的三个环节（回执按它分段，问题按它归类）。 */
export const REGRESSION_STAGES = ['change-set', 'impact-set', 'regression-set'] as const
export type RegressionStage = (typeof REGRESSION_STAGES)[number]

/**
 * 问题码：**稳定标识**（回执 / 守卫 / 后续准出准则按它分类），人话在 `message` 里。
 */
export const REGRESSION_ISSUE_CODES = [
  /** 追溯图**为空**（一条边都没有）⇒ 影响面不可推导。 */
  'impact-underivable',
  /** 种子在图上**一条边也走不出去** ⇒ 这一项的归属判不动（点名到种子）。 */
  'seed-unconnected',
  /** 影响集里的用例**根本不在回归集里**（该重跑没重跑）。 */
  'case-missing',
  /** 回归集里有这条用例，但没有结果（跑了没记，或干脆没跑）。 */
  'not-run',
  /** 跑了但没通过。 */
  'run-failed',
  /** 结果没绑被测产物哈希 ⇒ 无从判"跑的是哪一版"。 */
  'artifact-unbound',
  /** 结果绑的产物哈希与当前产物**不一致** ⇒ 结果**过期**（点名产物路径）。 */
  'artifact-stale',
  /** `artifact` 位只写了哈希、没写产物路径 ⇒ 判不动。 */
  'artifact-path-missing',
  /** 产物路径指向工作区之外。 */
  'artifact-outside',
  /** 绑定的产物在盘上找不到（路径写错 / 产物被删）。 */
  'artifact-missing',
  /** 影响面推不出来又**没有**显式声明不可推导（静默当作"无影响"）。 */
  'undecidable-missing',
  /** 追溯图里有坏行 ⇒ 图不完整（"没这条边"与"这条边读不出来"分不开）。 */
  'graph-unreadable',
  /** 变更集为空 ⇒ 没有变更就没有回归可言（如实说明，不判红）。 */
  'change-set-empty',
  /**
   * **有变更却完全没记回归**（TASK-055 / REQ-052）：变更集非空，而回归真源缺失 / 为空
   * ⇒ 判红并点名「本次变更未记回归」，不许降级成 N/A。
   */
  'source-not-recorded',
  /** 收尾兜底：意外抛错被收敛（**不是** ok）。 */
  'unknown',
] as const
export type RegressionIssueCode = (typeof REGRESSION_ISSUE_CODES)[number]

/** 链上三个环节的结论。`unknown` = 判不动（凭据不齐），与 `invalid`（它不成立）分开。 */
export type RegressionOutcome = 'ok' | 'stale' | 'incomplete' | 'unknown'

/** 一条**可执行**的问题：说什么位置、错在哪、为什么非改不可。 */
export interface RegressionIssue {
  stage: RegressionStage
  /** 点号路径（`cases[1].artifact`）；无法定位到字段时给实体 id。 */
  field: string
  code: RegressionIssueCode
  message: string
}

/** 一条跑记录的逐条结论（回执里逐条现算，**不做加权合并** —— 同 REQ-050 纪律）。 */
export interface RegressionCaseAssessment {
  caseId: string
  /** 声明的结果（`pass` / `fail` / 空……原样带上）。 */
  result: string
  outcome: 'ok' | 'stale' | 'failed' | 'not-run' | 'unbound' | 'missing-artifact'
  artifact: string
  /** 产物路径（只写哈希时为**空**：判不动就要看得见"缺的是哪一样"）。 */
  artifactPath: string
  recordedHash: string
  actualHash: string
  issues: RegressionIssue[]
}

// —————————————————————— 二、变更集（CHANGE SET） ——————————————————————

/** 变更集里的一项：一个实体 id，**或**一个补不成实体的文件路径。 */
export interface ChangeSetItem {
  /** `REQ-` / `DES-` / `TASK-` / `TC-` / `CT-` / `DEF-` / `CR-` …（文件项时为空串）。 */
  id: string
  /** 补不成实体时原样带上**文件路径**（不假装它属于某条需求）。 */
  file: string
  /** 从哪来：`CR-003` / `DEF-004` / `session-x` / …（留痕用）。 */
  from: string
}

export interface ChangeSet {
  items: ChangeSetItem[]
  /** 三路来源各自的条数（回执里现算，看得见"这份变更集是从哪几处凑出来的"）。 */
  sources: { changes: number; defects: number; workspaceFiles: number }
  /**
   * 图里补不成实体的文件数（图里是实体 id、工作区记的是路径）。
   * >0 时必须说出来：这些文件的归属**没有被机械推导**过。
   */
  rawFileCount: number
}

/**
 * 取这次变更的**实体种子**（顺序稳定、去重）。
 *
 * 为什么把 `CR-` / `DEF-` 也当种子：图里没有 `CR-` / `DEF-` 这种节点（`TRACE_KINDS` 里没有它们的边），
 * 它们只是"从哪个动作出发"的入口 —— 真正的种子是 `CR.requirement` 与
 * `req-defect` 边的 `from`。**这一点必须在代码里写清楚**，否则下一个人会以为图里能走 `CR-`。
 */
export function changeSetSeeds(changeSet: ChangeSet, edges: readonly TraceEdge[]): string[] {
  const seeds = new Set<string>()
  for (const item of changeSet.items) {
    if (item.id !== '') {
      seeds.add(item.id)
      continue
    }
    // 文件补成实体：只在图里**恰好出现过该路径**时（不猜、不按目录前缀硬套）
    for (const edge of edges) {
      if (edge.from === item.file) seeds.add(edge.from)
      if (edge.to === item.file) seeds.add(edge.to)
    }
  }
  return [...seeds].sort()
}

/**
 * 从**台账**现取变更集（不是人手罗列）。
 *
 * 三路来源（任一缺席都只是少一路，不回退成"无影响"）：
 *   · `CR-*` 且 `decision === 'approved'` ⇒ 种子是 `CR.requirement`（变更控制已确立的口径）；
 *   · `DEF-*` 且 `status === 'fixed'` ⇒ 修复的**后果**由 `req-defect` 边去推（图里有这条边）；
 *   · `workspace/changes` 台账里的改动文件 ⇒ 能补成实体的补、补不上的如实记成文件项。
 *
 * @param sessionId 只看某会话的改动窗口；不传则取台账里全部（`workspace/changes` 本来就按会话记）
 */
export function changeSetFromLedger(store: SdoStore, sessionId?: string | undefined): ChangeSet {
  const items: ChangeSetItem[] = []
  const seen = new Set<string>()
  const push = (id: string, file: string, from: string): void => {
    const key = `${id}\u0000${file}`
    if (seen.has(key)) return
    seen.add(key)
    items.push({ id, file, from })
  }

  const changes = listChanges(store)
  let approved = 0
  for (const change of changes) {
    if (change.decision !== 'approved') continue
    approved += 1
    push(textOf(change.requirement).trim(), '', change.id)
  }

  const defects = listDefects(store)
  let fixed = 0
  for (const defect of defects) {
    if (defect.status !== 'fixed') continue
    fixed += 1
    push(defect.id, '', defect.id)
  }

  const { entries } = readWorkspaceChanges(store)
  const files: string[] = []
  for (const entry of entries) {
    if (sessionId !== undefined && entry.sessionId !== sessionId) continue
    for (const file of entry.files) if (!files.includes(file)) files.push(file)
  }
  for (const file of files) push('', file, sessionId === undefined ? 'workspace/changes' : sessionId)

  const sorted = [...items].sort((a, b) => (a.id === b.id ? a.file.localeCompare(b.file) : a.id.localeCompare(b.id)))
  return {
    items: sorted,
    sources: { changes: approved, defects: fixed, workspaceFiles: files.length },
    rawFileCount: sorted.filter((item) => item.id === '').length,
  }
}

// —————————————————————— 三、影响集（IMPACT SET） ——————————————————————

/** 影响集：由追溯图**多跳闭包**推出（`trace.traceClosure`），并按前缀归类点名。 */
export interface ImpactSet {
  /** 能不能推：图里有边、且种子至少走得出一条边。 */
  derivable: boolean
  /** 推不出来时的人话原因（可直接进回执；`derivable` 为真时是空串）。 */
  undecidable: string
  /** 种子（从变更集取的实体；文件补不成实体的不进这里）。 */
  seeds: string[]
  /** 在图上一跳都走不出去的种子（点名：它们的归属判不动）。 */
  unconnected: string[]
  /** 闭包里的**全部**节点（排序；含种子）。 */
  nodes: string[]
  /** 按前缀归类（点名的原料）。 */
  byPrefix: {
    requirements: string[]
    design: string[]
    /** 接口条目 / 契约 / 方法产物 —— `change.ts` 的 `traceImpact` 同口径（`DES-` / `ADR-` / `CT-` / `MA-`）。 */
    artifacts: string[]
    tasks: string[]
    cases: string[]
    defects: string[]
    others: string[]
  }
  /** 走过的边数（推导强度：0 = 什么也没推出来）。 */
  walked: number
  /** 图里的坏行数（>0 ⇒ 图不完整）。 */
  badLines: number
  /** 非空行总数（与 `total` 一起给出，"少了几条"看得见）。 */
  totalLines: number
  /** 图里的边总数（与 `walked` 一起给出：走了几步 / 一共有几步）。 */
  edges: number
  /** 有效种子一条边都走不出**且**图上没有任何边 —— 与"图非空但推不出用例"要分得开。 */
  graphEmpty: boolean
}

/** 影响集推不出来时的**人工确认入口**（REQ-052：不许默认无影响，要给出路）。 */
export function impactManualConfirmHint(): string {
  return (
    '影响面由追溯图推导不出来 ⇒ 先补图（`sdo_trace action=link` 建 `req-des` / `req-task` / `req-tc` / `req-defect` 边），'
    + '或在本轮**人工确认**影响范围后写进 `.sdo/testing/regression.yml` 的 `undecidable`（写清：为什么推不出来、'
    + '人工确认了哪些、谁确认的）—— 不许留空当作"无影响"'
  )
}

/** 从**边数组**推影响集（纯函数：守卫用例直接喂边，不碰盘）。 */
export function deriveImpact(seeds: readonly string[], edges: readonly TraceEdge[], badLines = 0, totalLines = 0): ImpactSet {
  const graph = traceGraphOf(edges, badLines, totalLines)
  const unique = [...new Set(seeds.map((seed) => seed.trim()).filter((seed) => seed !== ''))].sort()
  const closure = traceClosure(graph, unique)
  const unconnected = unique.filter((seed) => traceNeighbors(graph, seed).length === 0)
  const graphEmpty = graph.edges.length === 0
  const derivable = unique.length > 0 && !graphEmpty && unconnected.length === 0
  const nodes = [...closure.nodes].sort()

  const pick = (...prefixes: string[]): string[] => nodes.filter((id) => prefixes.some((item) => id.startsWith(item)))
  const cases = pick('TC-')
  const byPrefix = {
    requirements: pick('REQ-'),
    design: pick('DES-'),
    artifacts: pick('ADR-', 'CT-', 'MA-'),
    tasks: pick('TASK-'),
    cases,
    defects: pick('DEF-'),
    others: nodes.filter((id) => !/^(REQ|DES|ADR|CT|MA|TASK|TC|DEF)-/u.test(id)),
  }

  let undecidable = ''
  if (unique.length === 0) {
    undecidable = '变更集里没有任何实体 id（只有补不成实体的文件）⇒ 影响面无从推导：先在图里把这些文件挂到实体上，或明确这次改的是哪条需求 / 设计 / 卡'
  } else if (graphEmpty) {
    undecidable = `追溯图为空（${totalLines} 行、0 条可用的边）⇒ 影响面不可推导（不许默认"无影响"）`
  } else if (unconnected.length > 0) {
    undecidable = `追溯图里有 ${graph.edges.length} 条边，但种子 ${unconnected.join(' ')} 一条都走不出去 ⇒ 这一项的影响面判不动（是"真的没有下游"还是"图里漏了边"，机械判不出来）`
  }

  return {
    derivable,
    undecidable,
    seeds: unique,
    unconnected,
    nodes,
    byPrefix,
    walked: closure.walked,
    badLines,
    totalLines,
    edges: graph.edges.length,
    graphEmpty,
  }
}

/** 从盘上的追溯图推影响集（`traceGraph` + {@link deriveImpact}）。 */
export function deriveImpactFromStore(store: SdoStore, seeds: readonly string[]): ImpactSet {
  const graph: TraceGraph = traceGraph(store)
  return deriveImpact(seeds, graph.edges, graph.badLines, graph.totalLines)
}

// —————————————————————— 四、回归集判定（REGRESSION SET） ——————————————————————

/** 一条跑记录的形状（本模块判定所依赖的那一份；与 `types.ts` 的 `TestingRegressionCase` 同形）。 */
export interface RegressionRunInput {
  case: string
  result: string
  /**
   * 被测产物：**产物哈希**（`sha256:<hex>` / 裸 hex / `dir:…`）或**产物路径** —— 两种写法都认
   * （见 `assessRun` 的表）。哈希写法要与 `artifactPath` 配对才判得动过期，否则只能如实报"判不动"。
   */
  artifact?: string | undefined
  /** 产物**路径**（与 `artifact` 里的哈希配对；`artifact` 直接写路径时不需要）。 */
  artifactPath?: string | undefined
  command?: string | undefined
}

/** 一份回归真源（`.sdo/testing/regression.yml` 的根键正文）。 */
export interface RegressionSourceInput {
  impact?: readonly string[] | undefined
  undecidable?: string | undefined
  narrow?: string | undefined
  cases?: readonly RegressionRunInput[] | undefined
}

export interface RegressionAssessment {
  /** 真源在不在盘上。 */
  present: boolean
  outcome: RegressionOutcome
  /** 链上三个环节各自的条数（逐条现算，**不做加权合并**）。 */
  counts: { impacted: number; cases: number; passed: number; failed: number; notRun: number; stale: number; unbound: number; artifactMissing: number }
  /** 逐条判红的用例 id（点名用；**不许用整体结论掩盖个别项**）。 */
  offenders: string[]
  /** 过期结果的产物路径（AC-208：点名产物路径）。 */
  staleArtifacts: string[]
  /** 影响集里**该重跑却没进回归集**的用例（AC-206：有未跑项就判红）。 */
  missing: string[]
  violations: RegressionIssue[]
  /** 如实记下但不判红的事（例如变更集为空：没有变更就没有回归）。 */
  notices: RegressionIssue[]
  impact: ImpactSet
  cases: RegressionCaseAssessment[]
  /** 判不动的原因（读不动真源、图上坏行过不去等）。 */
  unknownReason: string
}

/** 判定输入：**显式给三项**，读盘由 `assessRegressionFromStore` 负责。 */
export interface RegressionAssessmentInput {
  workspace: string
  changeSet: ChangeSet
  source: RegressionSourceInput
  /** 追溯图的边（来自 `trace.traceGraph`）。 */
  edges: readonly TraceEdge[]
  badLines?: number | undefined
  totalLines?: number | undefined
  /** 用例登记表（`TC-*`）——用于"影响集里的用例到底存不存在"的点名（缺省不核）。 */
  knownCaseIds?: readonly string[] | undefined
}

/** `result` 位里能接受的"跑过了且通过"—— 只有 `pass`（其余一律按"没跑通过"处置）。 */
function isPass(result: string): boolean {
  return result.trim().toLowerCase() === 'pass'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textAt(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? textOf(value).trim() : ''
}

/**
 * 一条跑记录的逐条判定（产物哈希现算比对；判不动就点名缺什么，不假装过期也不判绿）。
 *
 * ## `artifact` 位是**哈希**，产物**路径**用 `artifactPath` 补（两种历史写法都认）
 *
 * | 写法 | 出处 | 处置 |
 * |---|---|---|
 * | `artifact` = **产物哈希**（`sha256:<hex>` / 裸 hex / `dir:…`）+ `artifactPath` = 路径 | `types.ts` 的 `TestingRegressionCase.artifact`（既有夹具 `test/m31.test.ts` 也是这个口径） | `pathFingerprint` 现算路径的哈希，与 `artifact` 逐字比对：不一致 ⇒ **过期并点名该路径**（AC-208） |
 * | `artifact` = **产物路径**（`artifactPath` 缺省） | 人直接把路径写进 `artifact` 位 | 同上（把路径先当哈希位读不出来时，按路径现算） |
 * | `artifact` = 哈希、**没有路径** | 只记了"跑的是哪一版"、没记"产物在哪" | **判不动**（`artifact-path-missing`）：既不假装过期、也不判绿 |
 *
 * 为什么两种都认：判红一条**意思完全正确**的记录比接受它更糟（与 `coverage.ts` 的同一条理由）。
 * 一条记录"算不算数"必须能机械判出来，判不出来就如实说判不动 —— 这是本模块唯一允许的保守方向。
 */
function assessRun(workspace: string, field: string, item: RegressionRunInput): RegressionCaseAssessment {
  const issues: RegressionIssue[] = []
  const caseId = textOf(item.case).trim()
  const result = textOf(item.result).trim()
  const artifact = textAt(item.artifact)
  const declaredPath = textAt(item.artifactPath)
  // 产物路径：优先 `artifactPath`；`artifact` 位里写的若不是哈希，就按路径读（历史写法）
  const artifactPath = declaredPath !== '' ? declaredPath : looksLikeHash(artifact) ? '' : artifact
  // 记录下来的哈希：`artifact` 位是哈希就用它；`artifact` 位写的是路径时，哈希改由 `artifactPath` 的现算值承担
  const recordedHash = looksLikeHash(artifact) ? artifact : ''
  let actualHash = ''

  if (isPass(result)) {
    // 只有"通过"的结果才谈得上时效：没过的东西的处置是"去修"，不是"去重跑"
    if (artifact === '' && recordedHash === '') {
      issues.push({ stage: 'regression-set', field: `${field}.artifact`, code: 'artifact-unbound', message: `${field} 通过了却没记被测产物：结果必须绑到"这一版产物"上（REQ-052），否则产物一改无从判过期 —— 补 \`artifact\`（产物哈希）` })
    } else if (artifactPath === '') {
      issues.push({ stage: 'regression-set', field: `${field}.artifactPath`, code: 'artifact-path-missing', message: `${field} 只记了产物哈希（${shorten(recordedHash === '' ? artifact : recordedHash)}）、没记产物路径：哈希在手但不知道产物在哪，无法核对"它有没有被改动" —— 补产物路径才判得动过期（REQ-052 / AC-208）` })
    } else {
      actualHash = pathFingerprint(workspace, artifactPath)
      if (actualHash === 'outside') {
        issues.push({ stage: 'regression-set', field: `${field}.artifactPath`, code: 'artifact-outside', message: `${field}.artifactPath 指向工作区之外的路径「${artifactPath}」：被测产物必须是本工作区里的产物` })
        actualHash = ''
      } else if (actualHash === 'missing') {
        issues.push({ stage: 'regression-set', field: `${field}.artifactPath`, code: 'artifact-missing', message: `${field} 绑定的被测产物在盘上找不到：「${artifactPath}」—— 产物没了 / 路径写错了，这条结果不再算数（先确认产物，再重跑重记）` })
        actualHash = ''
      }
      // 现场现算的值与记录下来的值**逐字比对**（`sameHash` 归一化 `sha256:` 前缀与大小写）。
      // 这是 AC-208 的机械判据：产物一改，哈希就对不上 ⇒ 判过期并**点名产物路径**。
      // `artifact` 位写路径（历史写法）时没有单独的哈希位可比 —— 那时"路径能现算"就是全部判据
      if (recordedHash !== '' && actualHash !== '' && !sameHash(recordedHash, actualHash)) {
        issues.push({
          stage: 'regression-set',
          field: `${field}.artifactPath`,
          code: 'artifact-stale',
          message: `${field} 的结果已过期：被测产物 ${artifactPath} 已变（记录时 ${shorten(recordedHash)}，现在 ${shorten(actualHash)}）—— 重跑这条回归并重记结果，不许改哈希迁就旧结论`,
        })
      }
    }
  } else if (result === '') {
    issues.push({ stage: 'regression-set', field: `${field}.result`, code: 'not-run', message: `${field}（用例 ${caseId === '' ? '（未编号）' : caseId}）没有结果：回归集里的每一条都要有结果 —— 跑了记结果，没跑就别写进 \`cases[]\`（写进 \`narrow\` 说明为什么不跑）` })
  } else {
    issues.push({ stage: 'regression-set', field: `${field}.result`, code: 'run-failed', message: `${field}（用例 ${caseId}）的结果是「${result}」：回归**没通过**就不许声称本次变更已完成` })
  }

  const outcome: RegressionCaseAssessment['outcome'] = issues.some((issue) => issue.code === 'artifact-stale')
    ? 'stale'
    : issues.some((issue) => issue.code === 'run-failed')
      ? 'failed'
      : issues.some((issue) => issue.code === 'not-run')
        ? 'not-run'
        : issues.some((issue) => issue.code === 'artifact-unbound' || issue.code === 'artifact-path-missing')
          ? 'unbound'
          : issues.some((issue) => issue.code === 'artifact-outside' || issue.code === 'artifact-missing')
            ? 'missing-artifact'
            : 'ok'
  return { caseId, result, outcome, artifact, artifactPath, recordedHash, actualHash, issues }
}

/** 一个字段里写的是**哈希**而不是路径？（与 `coverage.ts` 的 `looksLikeHash` 同形）。 */
function looksLikeHash(value: string): boolean {
  const text = value.trim()
  if (/^sha256:[0-9a-fA-F]{64}$/u.test(text)) return true
  if (/^[0-9a-fA-F]{64}$/u.test(text)) return true
  return /^dir:\d+:[0-9a-f]{12}$/u.test(text)
}

function shorten(value: string): string {
  const text = value.trim()
  return text.length > 16 ? `${text.slice(0, 16)}…` : text
}

/**
 * 空结论（真源**不在盘上** / **读不动** / **没有内容**时用）。
 *
 * `present` 区分"文件在不在盘上"；`unknownReason` 非空 ⇒ `unknown`（**判不动**：读不出对象 / 意外抛错）。
 * 两者都为假 ⇒ `ok` —— 这一支**只有一个正当来源**：真源不在盘上**且变更集为空**
 * （没有变更就没有回归义务，判据据此转 N/A）。**真源在盘上但没有内容**由调用方显式改判成
 * `incomplete` + `source-not-recorded`（TASK-055）——"写了但等于没写"不是"没有回归义务"。
 */
function emptyAssessment(present: boolean, unknownReason: string, impact: ImpactSet): RegressionAssessment {
  return {
    present,
    outcome: unknownReason === '' ? 'ok' : 'unknown',
    counts: { impacted: impact.byPrefix.cases.length, cases: 0, passed: 0, failed: 0, notRun: 0, stale: 0, unbound: 0, artifactMissing: 0 },
    offenders: [],
    staleArtifacts: [],
    missing: [],
    violations: [],
    notices: [],
    impact,
    cases: [],
    unknownReason,
  }
}

/**
 * 判定一份回归真源（**只读**）。
 *
 * `outcome` 的口径：
 *   · `ok`         —— 影响面推得出来、影响集里的用例都在、每条都通过且产物哈希对得上；
 *   · `stale`      —— 至少一条结果**过期**（被测产物被改动）；
 *   · `incomplete` —— 影响面推不出来 / 有没跑的 / 有没通过的 / 结果没绑产物；
 *   · `unknown`    —— 判不动（真源解析不出对象、图上坏行、产物只有哈希没有路径）。
 *
 * 优先级：`stale` > `incomplete` > `unknown` > `ok`。**过期优先**（产物变了是先重跑的信号）。
 */
export function assessRegression(input: RegressionAssessmentInput): RegressionAssessment {
  const raw: RegressionSourceInput = isRecord(input.source) ? (input.source as RegressionSourceInput) : {}
  const seeds = changeSetSeeds(input.changeSet, input.edges)
  const impact = deriveImpact(seeds, input.edges, input.badLines ?? 0, input.totalLines ?? 0)
  const notices: RegressionIssue[] = []
  const violations: RegressionIssue[] = []

  if (input.changeSet.items.length === 0) {
    notices.push({ stage: 'change-set', field: '', code: 'change-set-empty', message: '变更集为空（没有已批准的变更请求、没有已修缺陷、工作区台账也没有改动）⇒ 没有变更就没有回归要跑；这一步如实说明，不判红' })
  }
  if (input.changeSet.rawFileCount > 0 && impact.derivable) {
    notices.push({
      stage: 'impact-set',
      field: input.changeSet.items.filter((item) => item.id === '').map((item) => item.file).join(' '),
      code: 'impact-underivable',
      message: `变更集里有 ${input.changeSet.rawFileCount} 个文件在图里补不成实体（图里是实体 id、工作区台账记的是文件路径）⇒ 这些文件的归属**没有被机械推导**过；要它们进影响面，先把文件挂到实体上（或改用实体 id 记变更）`,
    })
  }
  if (impact.badLines > 0) {
    violations.push({ stage: 'impact-set', field: 'trace/links.jsonl', code: 'graph-unreadable', message: `追溯图里有 ${impact.badLines} 行读不出来（非空行共 ${impact.totalLines} 行）⇒ 图**不完整**，"没这条边"与"这条边读不出来"分不开 —— 先修 \`trace/links.jsonl\` 再判回归` })
  }
  if (!impact.derivable) {
    violations.push({ stage: 'impact-set', field: 'impact', code: 'impact-underivable', message: `${impact.undecidable}。${impactManualConfirmHint()}` })
    for (const seed of impact.unconnected) {
      violations.push({ stage: 'impact-set', field: seed, code: 'seed-unconnected', message: `种子 ${seed} 在追溯图上一跳都走不出去 ⇒ 它的影响面判不动（补图，或在本轮人工确认后写进 \`undecidable\`）` })
    }
  }

  const declaredUndecidable = textAt(raw.undecidable)
  if (!impact.derivable && declaredUndecidable === '') {
    violations.push({ stage: 'impact-set', field: 'undecidable', code: 'undecidable-missing', message: '影响面推不出来，而 `undecidable` 是空的：REQ-052 的降级口径要求**显式声明**并给人工确认入口（不许默认"无影响"）' })
  }

  const declaredImpact = (Array.isArray(raw.impact) ? raw.impact : []).map((item) => textAt(item)).filter((item) => item !== '')
  if (impact.derivable && declaredImpact.length > 0 && !sameSet(declaredImpact, impact.nodes)) {
    notices.push({
      stage: 'impact-set',
      field: 'impact',
      code: 'impact-underivable',
      message: `真源里的 \`impact\` 与图上现推的影响集不一致（真源 ${declaredImpact.length} 项、图 ${impact.nodes.length} 项）—— 影响集的**权威来源是图**，真源里那份只作留痕：不一致时以现推结果为准（要它一致就重记）`,
    })
  }

  const runs = Array.isArray(raw.cases) ? raw.cases.filter(isRecord).map((item) => item as unknown as RegressionRunInput) : []
  const cases = runs.map((item, index) => assessRun(input.workspace, `cases[${index}]`, item))
  for (const item of cases) violations.push(...item.issues)

  // **TASK-055 落点一（空真源那一半）**：变更集非空 ⇒ 回归真源要么**记下来**、要么**显式声明无影响面**。
  // 文件在盘上、根键也在，但既没有回归集、也没有记下来的影响面 ⇒ 这份真源等于没有内容：
  // 它挡不住 REQ-052 的核心纪律（回归集未跑即不得声称变更完成），于是与"真源缺失"同一档处置。
  //
  // 什么叫"记下来了"（判据只用这两处，**不猜**）：
  //   · `cases[]` **非空** —— 回归集正文（形状层对它逐字段校验）；
  //   · `impact[]` **非空** —— 影响面的留痕（形状层在"没有 cases"时**强制**要求它非空，
  //     所以一份"照规矩写下来"的真源必然至少落一处）。
  // 反之：`{impact: [], cases: []}` / `{}` 这种**四位全空**的写法是"写了等于没写" —— 判红。
  //
  // 两条边界（有意为之）：
  //   · **变更集为空**时不判这一支：没有变更就没有回归义务，由门禁侧转 N/A（不误伤）。
  //   · `cases: []` + `impact: [...]` + `undecidable: ...`（显式声明影响面不可推导并给理由）
  //     是**有效留痕**：由上面既有的 `impact-underivable` / `undecidable-missing` 判据各自处置，
  //     本规则不去重复判它（不同的病不同的药）。
  const recordedCases = runs.length > 0
  const recordedImpact = declaredImpact.length > 0
  if (input.changeSet.items.length > 0 && !recordedCases && !recordedImpact) {
    violations.push({
      stage: 'change-set',
      field: `${REGRESSION_FILE}.yml`,
      code: 'source-not-recorded',
      message: `**本次变更未记回归**：变更集里有 ${input.changeSet.items.length} 项（已批准的 \`CR-*\` / 已修 \`DEF-*\` / 工作区台账的改动文件），而回归真源 \`.sdo/testing/${REGRESSION_FILE}.yml\` 没有内容（\`cases[]\` 与 \`impact[]\` 都空 ⇒ \`impact\` / \`cases\` / \`undecidable\` / \`narrow\` 四位全空）⇒ 按 REQ-052 不许声称本次变更已完成：补记回归链（变更集 → 影响集 → 回归集），或在 \`undecidable\` 里**显式声明无影响面并给理由**（不许留空当作"无影响"）`,
    })
  }

  // 有结果 ≠ 通过了：三种"不算数"分开点名（过期的先重跑，没跑的补跑，没通过的去修）
  const stale = cases.filter((item) => item.outcome === 'stale').map((item) => item.caseId).filter((id) => id !== '')
  const failed = cases.filter((item) => item.outcome === 'failed').map((item) => item.caseId).filter((id) => id !== '')
  const notRun = cases.filter((item) => item.outcome === 'not-run').map((item) => item.caseId).filter((id) => id !== '')
  const unbound = cases.filter((item) => item.outcome === 'unbound').map((item) => item.caseId).filter((id) => id !== '')
  const artifactMissing = cases.filter((item) => item.outcome === 'missing-artifact').map((item) => item.caseId).filter((id) => id !== '')

  // **机械对账**：影响集里的每条用例都要在回归集里（AC-206 的"有未跑项则判红"）。
  // 只在影响面推得出来时对账 —— 推不出来时"该跑什么"本身是未知，硬对账会退化成"图上没写=不用跑"
  // （那正是 REQ-052 降级口径要挡的东西）。
  const ranIds = new Set(cases.map((item) => item.caseId))
  const missing = impact.derivable
    ? impact.byPrefix.cases.filter((id) => !ranIds.has(id)).sort()
    : []
  for (const id of missing) {
    const known = input.knownCaseIds !== undefined && input.knownCaseIds.includes(id)
    violations.push({
      stage: 'regression-set',
      field: id,
      code: 'case-missing',
      message: `影响集里的用例 ${id}${known ? '' : '（⚠️ 不在用例登记表里）'}既没跑也没声明不跑 ⇒ 回归集不完整：补一条 \`cases[]\`（含结果与产物哈希），或写进 \`narrow\` 说明为什么这次不跑（范围收窄是人的决定，但必须留痕）`,
    })
  }

  const staleArtifacts = [...new Set(cases.filter((item) => item.outcome === 'stale' && item.artifactPath !== '').map((item) => item.artifactPath))]
  const counts = {
    impacted: impact.byPrefix.cases.length,
    cases: cases.length,
    passed: cases.filter((item) => item.outcome === 'ok').length,
    failed: failed.length,
    notRun: notRun.length,
    stale: stale.length,
    unbound: unbound.length,
    artifactMissing: artifactMissing.length,
  }
  const offenders = [...new Set([...cases.filter((item) => item.outcome !== 'ok').map((item) => item.caseId).filter((id) => id !== ''), ...missing])].sort()

  const outcome: RegressionOutcome = stale.length > 0
    ? 'stale'
    : violations.length > 0
      ? 'incomplete'
      : 'ok'

  return {
    present: true,
    outcome,
    counts,
    offenders,
    staleArtifacts,
    missing,
    violations,
    notices,
    impact,
    cases,
    unknownReason: '',
  }
}

/** 两个字符串集合是否逐项相等（顺序无关）。 */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort()
  const right = [...new Set(b)].sort()
  return left.length === right.length && left.every((item, index) => item === right[index])
}

/**
 * 从 `<store>/.sdo/testing/regression.yml` 读真源并判定。
 *
 * 真源**不在盘上** ⇒ `present: false`。**这一支的处置由调用方按变更集决定**（TASK-055：
 * 本模块只如实报"没有真源"，它不凭空知道"这次该不该有回归"）：
 *   · 变更集**为空** ⇒ 没有变更就没有回归义务 ⇒ 门禁转 **N/A**（不误伤无变更的项目）；
 *   · 变更集**非空** ⇒ 有变更却完全没记回归 ⇒ 门禁**判红**并点名「本次变更未记回归」（REQ-052）。
 *
 * 真源**读不动**（文件在盘上但解析不出对象）⇒ `present: true` + `unknown`：判**红**（fail-closed），
 * 绝不降级成 N/A —— "查不动"比"没记"更严重，与 `coverage.ts` / `journal` 坏行的口径一致。
 */
export function assessRegressionFromStore(store: SdoStore, workspace: string, changeSet: ChangeSet, knownCaseIds?: readonly string[]): RegressionAssessment {
  const ref = TESTING_SOURCE_FILES.regression[0]
  const graph = traceGraph(store)
  const seeds = changeSetSeeds(changeSet, graph.edges)
  if (ref === undefined) return emptyAssessment(false, '', deriveImpact(seeds, graph.edges, graph.badLines, graph.totalLines))
  const read = readTestingSource(store, ref)
  if (!read.present) return emptyAssessment(false, '', deriveImpact(seeds, graph.edges, graph.badLines, graph.totalLines))
  if (read.unreadable) {
    return emptyAssessment(true, `.sdo/${read.path} 读不出对象：文件在盘上但解析失败（先修 YAML，再看回归集）`, deriveImpact(seeds, graph.edges, graph.badLines, graph.totalLines))
  }
  try {
    return assessRegression({
      workspace,
      changeSet,
      source: read.value as unknown as RegressionSourceInput,
      edges: graph.edges,
      badLines: graph.badLines,
      totalLines: graph.totalLines,
      ...(knownCaseIds === undefined ? {} : { knownCaseIds }),
    })
  } catch (error) {
    // fail-closed：意外抛错收敛成 unknown（**不是** ok），并如实给出原因
    return emptyAssessment(true, `判定回归集时意外出错：${error instanceof Error ? error.message : String(error)}`, deriveImpact(seeds, graph.edges, graph.badLines, graph.totalLines))
  }
}

// —————————————————————— 五、人读文案（门禁 detail / remedy） ——————————————————————

function outcomeText(outcome: RegressionOutcome): string {
  switch (outcome) {
    case 'ok':
      return '可用'
    case 'stale':
      return '已过期'
    case 'incomplete':
      return '不完整'
    case 'unknown':
      return '判不动'
    default:
      return String(outcome)
  }
}

/**
 * 把判定结论翻成**用户可见的**一句话（门禁判据的 `detail`）。
 *
 * @param notRecorded **有变更却没记回归**（TASK-055 落点一 / 落点二）：真源不在盘上、或读不动。
 *   由门禁接线传入（它手里才有变更集）。**只有那一条路径**可以传 `true` —— 判定层自己算出来的
 *   结论（含变更集为空的 N/A 与图上不可推导）走的仍是下面那一段，两种情形不会互相洗白。
 *
 * 为什么放在本模块而不是 `gates.ts`：那个文件被 i18n 棘轮钉在「零硬编码中文」，
 * 而语言包不在本卡写范围 —— 与 `coverage.ts` 的 `describeCoverage` 同一处置。
 */
export function describeRegression(assessment: RegressionAssessment, notRecorded = false): string {
  if (!assessment.present) {
    if (notRecorded) {
      return '**本次变更未记回归**：变更集非空，而回归真源 .sdo/testing/regression.yml 不在盘上 ⇒ 按 REQ-052 不许声称本次变更已完成：补记一轮回归链（变更集 → 影响集 → 回归集），或在真源里用 `undecidable` 显式声明无影响面并给理由'
    }
    return '回归真源 .sdo/testing/regression.yml 不在盘上（没记回归就不判回归：先按 REQ-052 记一轮变更集 → 影响集 → 回归集）'
  }
  if (assessment.unknownReason !== '') return assessment.unknownReason
  const chain = `变更集 ${assessment.impact.seeds.length} 项 → 影响集 ${assessment.impact.nodes.length} 项（走过 ${assessment.impact.walked} 条边 / 图里共 ${assessment.impact.edges} 条）→ 影响集内用例 ${assessment.counts.impacted} 条`
  if (assessment.outcome === 'ok') {
    const passed = assessment.counts.passed === 0 ? '（尚无跑记录）' : `、${assessment.counts.passed} 条通过且产物哈希与当前一致`
    return `回归链可用：${chain}；回归集 ${assessment.counts.cases} 条${passed}`
  }
  const problems = assessment.violations.map((issue) => `［${issue.stage}${issue.field === '' ? '' : `·${issue.field}`}］${issue.message}`)
  const notices = assessment.notices.map((issue) => issue.message)
  const head = `回归链不通过（${outcomeText(assessment.outcome)}）：${chain}；回归集 ${assessment.counts.cases} 条（通过 ${assessment.counts.passed} / 未通过 ${assessment.counts.failed} / 没跑 ${assessment.counts.notRun} / 过期 ${assessment.counts.stale} / 未绑产物 ${assessment.counts.unbound} / 产物找不到 ${assessment.counts.artifactMissing}）`
  const tail = notices.length === 0 ? '' : ` ｜ 另记：${notices.join(' | ')}`
  return `${head}｜${problems.join(' ｜ ')}${tail}`
}

/**
 * 判红的**补救办法**（门禁回执的 `remedy`；可执行、点名入口）。
 *
 * `notRecorded` = **有变更却没记回归**（TASK-055）：这时补救的**第一步是"把真源记下来"**，
 * 而不是"重走一遍链" —— 真源都不在盘上，谈"重跑 / 重记"没有对象。两条路都写出来：
 * ① 补记回归链；② 确实无影响面就在真源里显式声明并给理由（REQ-052 的降级口径原文）。
 */
export function regressionRemedy(notRecorded = false): string {
  const record = notRecorded
    ? '① **先补记回归真源**（`.sdo/testing/regression.yml` 不在盘上**或没有内容**，都等于没记回归 —— `sdo_test` 的回归类真源出口形状合法才落盘）：'
      + '把影响集里的用例写进 `cases[]`；确实没有影响面时在真源里写 `undecidable`（写清：为什么推不出来、人工确认了哪些、谁确认的）**并给理由** —— 不许留空当作"无影响"；'
    : '① 取变更集（已批准的 `CR-*` / 已修 `DEF-*` / `workspace/changes` 台账）；'
  return (
    '按 REQ-052 重走一遍回归链：'
    + record
    + '② 用追溯图推影响集（`sdo_trace action=link` 补 `req-des` / `req-task` / `req-tc` / `req-defect` 边 —— 图空或种子走不出去时先补图，'
    + '推不出来就在 `.sdo/testing/regression.yml` 的 `undecidable` 里显式声明并记人工确认入口）；'
    + '③ 把影响集里的**每条用例**写进 `cases[]`（`case` / `result` / `command` / `artifact` 指到被测产物路径）；'
    + '④ 产物改动之后旧结果一律过期，必须**重跑重记**，不许改哈希迁就旧结论；'
    + '⑤ 范围收窄（这次不跑哪些）写进 `narrow`，写清理由'
  )
}

/** 供 `types.ts` 未补形状位前对齐用（本卡写范围外时的**唯一**类型出口）。 */
export type RegressionTraceLink = TraceEdge
