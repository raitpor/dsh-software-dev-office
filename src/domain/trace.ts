/**
 * 追溯引擎（设计 §4.4 的 `trace/links.jsonl` + §10.1b 的追溯图与孤儿检测）。
 *
 * 为什么先建追溯：变更影响分析、G3 的孤儿检测、G5 的覆盖率都从这一张图算出来——
 * 它是"先建追溯"的回报，而不是事后的文档工作。
 *
 * 规则（与 §10.1b 一致）：
 *   · 每个 `DES-*` 必须追溯到 ≥1 条需求（否则是孤儿设计）；
 *   · 每条 `must` 需求必须有 ≥1 个测试用例（否则覆盖率不达标）；
 *   · `TASK-*` / `TC-*` 同样要能回到需求。
 */
import { listElements } from './architecture.js'
import { listContracts } from './contracts.js'
import { methodTraceables } from './method.js'
import { listDefects } from './records.js'
import { fmt, t } from './i18n.js'
import { textOf } from '../infra/scalar.js'
import { existsSync, statSync } from 'node:fs'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { Requirement, TraceLink, TraceReport } from '../types.js'

export const TRACE_DIR = 'trace'
export const LINKS_FILE = 'links.jsonl'

/**
 * 允许的边语义（写错就报错，避免图里混进无意义边）。
 *
 * **`req-defect`（TASK-022）**：缺陷挂到需求上 —— 于是"这条需求出过哪些缺陷"可以从图里现算，
 * 而不是靠人去缺陷正文里搜关键字。它同时让"没有任何需求来源的缺陷"成为可检出的孤儿。
 */
export const TRACE_KINDS = ['req-des', 'req-task', 'req-tc', 'des-task', 'des-ct', 'req-defect'] as const

/**
 * @deprecated 会**丢掉坏行计数**（P-9）：新消费者请用 {@link readLinksChecked}。
 *
 * 保留只为两处不喂判据的内部调用（建边时的幂等判重）；任何把结果喂给门禁/报告的调用
 * 都必须走 `readLinksChecked`，否则"静默缩短的集合"会重新长出来。
 */
export function readLinks(store: SdoStore): TraceLink[] {
  return readLinksChecked(store).links
}

/**
 * 读追溯边并**如实回报坏行**（N-3）。
 *
 * 旧实现 `catch {}` 只留一行注释、连计数都没有，注释还自称"靠 report 的 total 与文件行数
 * 对不上时被发现"——而 `report()` 从不给文件行数，前提根本不成立。后果不是"少一条边"：
 * `trace.coverage` / `trace.orphans` 正是拿这份**被静默缩短的集合**判绿/判红，
 * 一行坏 JSON 就能让覆盖率无声变小。
 */
export function readLinksChecked(store: SdoStore): { links: TraceLink[]; badLines: number; totalLines: number } {
  const text = store.readText(TRACE_DIR, LINKS_FILE)
  if (text === undefined) return { links: [], badLines: 0, totalLines: 0 }
  const links: TraceLink[] = []
  let badLines = 0
  let totalLines = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    totalLines += 1
    try {
      const parsed = JSON.parse(line) as TraceLink
      if (typeof parsed.from === 'string' && typeof parsed.to === 'string' && typeof parsed.kind === 'string') {
        links.push(parsed)
      } else {
        // 解析得动但形状不对（缺 from/to/kind）= 同样不可信，不能只当"没这条边"
        badLines += 1
      }
    } catch {
      badLines += 1
    }
  }
  return { links, badLines, totalLines }
}

// —————————————————————— 一之二、图的邻接面（TASK-019） ——————————————————————

/**
 * 一条边的**无向引用对**（图是**有向**的，但"改了它就影响了谁"要两个方向都能走）。
 *
 * 为什么两个方向都要：`req-des` 是需求 → 设计，可反过来问"这个设计属于哪条需求"
 * （回归时改的是 `DES-`，而回归集按需求族收）同样成立。`change.ts` 的 `traceImpact`
 * 早就用 `link.from === id || link.to === id` 表达了同一件事 —— 那是**单点**版本，
 * 这里是它的**图**版本（可跨多跳，见 {@link traceClosure}）。
 */
export interface TraceEdge {
  from: string
  to: string
  kind: string
}

/**
 * 追溯图的**邻接面**：正反两个方向 + 如实回报坏行。
 *
 * 与 `readLinksChecked` 的分工：那个给"边的全集"（覆盖率/孤儿判据用），
 * 这个给"从某个 id 出发能走到谁"（影响面推导用）。
 */
export interface TraceGraph {
  /** 起点 → 终点（按 `kind` 分别索引：`kind → from → to[]`）。 */
  forward: Map<string, Map<string, string[]>>
  /** 终点 → 起点（同上）。`from`/`to` 都当成可走的一步。 */
  reverse: Map<string, Map<string, string[]>>
  /** 坏行数（>0 ⇒ 图**不完整**，"没这条边"与"这条边读不出来"分不开）。 */
  badLines: number
  /** 非空行总数（与 `total` 一起给出，让"少了几条"看得见）。 */
  totalLines: number
  /** 去重后的边（按 `from`/`kind`/`to` 排序；喂判据的是这一份）。 */
  edges: TraceEdge[]
}

function pushAdjacent(index: Map<string, Map<string, string[]>>, kind: string, key: string, value: string): void {
  let byKind = index.get(key)
  if (byKind === undefined) {
    byKind = new Map<string, string[]>()
    index.set(key, byKind)
  }
  const bucket = byKind.get(kind)
  if (bucket === undefined) byKind.set(kind, [value])
  else if (!bucket.includes(value)) bucket.push(value)
}

/**
 * 建图的**唯一一份实现**（`m38` 的守卫用例直接喂边数组调它，因此它不碰盘）。
 *
 * 去重口径：`from`/`kind`/`to` 三者都相同才是同一条边（`links.jsonl` 理论上幂等，
 * 但手改/迁移后的文件里可能有重复行 —— 重复边不该让影响集里出现两次）。
 */
export function traceGraphOf(links: readonly TraceEdge[], badLines: number, totalLines: number): TraceGraph {
  const forward = new Map<string, Map<string, string[]>>()
  const reverse = new Map<string, Map<string, string[]>>()
  const edges: TraceEdge[] = []
  const seen = new Set<string>()
  for (const item of links) {
    const key = `${item.from}\u0000${item.kind}\u0000${item.to}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ from: item.from, to: item.to, kind: item.kind })
    pushAdjacent(forward, item.kind, item.from, item.to)
    pushAdjacent(reverse, item.kind, item.to, item.from)
  }
  edges.sort((a, b) => (a.from === b.from ? (a.kind === b.kind ? a.to.localeCompare(b.to) : a.kind.localeCompare(b.kind)) : a.from.localeCompare(b.from)))
  return { forward, reverse, badLines, totalLines, edges }
}

/** 从盘上建图（`readLinksChecked` 的图视图；坏行**不在这里拒收**，由消费者决定怎么处置）。 */
export function traceGraph(store: SdoStore): TraceGraph {
  const { links, badLines, totalLines } = readLinksChecked(store)
  return traceGraphOf(links, badLines, totalLines)
}

/** 从一个 id 出发的**一跳**邻居（两个方向都算），按 `kind` 分组。 */
export function traceNeighbors(graph: TraceGraph, id: string): { kind: string; id: string }[] {
  const out: { kind: string; id: string }[] = []
  for (const index of [graph.forward, graph.reverse]) {
    const byKind = index.get(id)
    if (byKind === undefined) continue
    for (const [kind, ids] of byKind) for (const other of ids) if (other !== id) out.push({ kind, id: other })
  }
  out.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)))
  return out
}

/**
 * **闭包**：从种子集合出发，沿**两个方向**反复走，直到再走不出新节点。
 *
 * 这就是"影响面由追溯图机械推导"里的那个"推导"：
 *   · 走**多跳**而不是一跳 —— 改了需求 → 设计 → 卡 → 用例是一串（只走一跳会漏掉下游的用例）；
 *   · 环（`A→B→A`）由 `visited` 收敛，不会转不出来（图是人手维护的，环是常态）；
 *   · 结果**排序**（同一张图永远同一份影响集 ⇒ 判据可复算、报告可 diff）。
 *
 * 返回的 `walked` 是"走过的边数"，用于回执里给出"推导强度"（0 条边 = 什么也没推出来）。
 */
export function traceClosure(
  graph: TraceGraph,
  seeds: readonly string[],
): { nodes: Set<string>; walked: number } {
  const nodes = new Set<string>()
  const visited = new Set<string>()
  const queue: string[] = []
  for (const seed of [...seeds].sort()) {
    if (seed === '' || visited.has(seed)) continue
    visited.add(seed)
    queue.push(seed)
    nodes.add(seed)
  }
  let walked = 0
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const hit of traceNeighbors(graph, current)) {
      walked += 1
      if (visited.has(hit.id)) continue
      visited.add(hit.id)
      nodes.add(hit.id)
      queue.push(hit.id)
    }
  }
  return { nodes, walked }
}

/** 建立一条追溯边（幂等：同一条边不重复写）。 */
export function link(
  store: SdoStore,
  journal: Journal,
  input: { from: string; to: string; kind: string },
): { link: TraceLink; created: boolean } {
  if (!(TRACE_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`非法追溯边类型 ${input.kind}（可用：${TRACE_KINDS.join(' / ')}）`)
  }
  // 引用了不存在的对象 = 悬空边：必须当场报错，否则覆盖率会被虚增。
  //
  // **F-5（sdo-test 回归报告，minor）**：旧实现把 `DES-` 与 `CT-` **一起**拿去和"设计元素全集"
  // 比对，而契约存在 `<dir>/contracts/` 里 → `CT-*` 永远命中不了，于是 `TRACE_KINDS` 里声明的
  // `des-ct` 是一条**永远建不起来的边类型**（声明的能力与实际不符）。现在**按 id 前缀选全集**：
  // `DES-` → 设计元素，`CT-` → 契约；报错也点名是哪一类。
  //
  // **TASK-022**：把同一口径补齐到**全部**实体类别 + **整条拒绝**。旧实现只校验 `DES-` 与 `CT-`，
  // 于是 `req-task` / `req-tc` 指向不存在的卡或用例、以及任何指向不存在需求的边，都能**静默建起来** ——
  // 图里多一条指向空气的边，覆盖率就被虚增一次（"有边=被覆盖"），这正是当年漏掉 `CT-` 时警告过的同一类错。
  // 现在：任何一端指向不存在的实体（或 id 不属于任何已知类别）⇒ **整条边抛错、不落盘**（不是跳过那一端）。
  const elementUniverse = new Set(listElements(store).map((element) => element.id))
  const contractUniverse = new Set(listContracts(store).map((contract) => contract.id))
  const defectUniverse = new Set(listDefects(store).map((defect) => defect.id))
  /**
   * **可校验存在性的类别**（有实现侧台账、且建边时一定已经存在）。
   *
   * ⚠️ 这里**故意只有三类**，不是"能想到的都校验一下"。另三类（`REQ-` / `TASK-` / `TC-`）**不加**，
   * 原因是本仓既有流程会在**实体登记之前**就有引用它们的地方，硬校验会误伤既有用例（实测两处）：
   *   · `m73` 的 `decompose` 建卡时先建 `req-task` 边（`REQ-001` 当时还没有需求台账条目）；
   *   · `m2` 的覆盖计算夹具直接连一条 `TC-001`（只为一个链接，不登记真用例）。
   * 也就是说"这几个前缀的 id 在本层拿不到权威全集"——它们的存在性由各自的门禁判据管
   * （`trace.orphans` / `uncoveredMust` / `tests.passed`），不在这里拦。
   * 而 `DEF-` 是**本卡新增的边类型**，它的台账（`.sdo/defects/`）在链接之前必然已经存在，
   * 因此可以、也应当校验：一条指向不存在缺陷的边就是一条虚增覆盖的悬空边。
   */
  const universes: readonly { prefix: string; label: string; hint: string; ids: ReadonlySet<string> }[] = [
    { prefix: 'DES-', label: '设计元素', hint: '先用 `sdo_design action=create` 创建它', ids: elementUniverse },
    { prefix: 'CT-', label: '契约', hint: '先用 `sdo_design action=contract` 创建它', ids: contractUniverse },
    { prefix: 'DEF-', label: '缺陷', hint: '先用 `sdo_test action=defect` 登记它', ids: defectUniverse },
  ]
  /**
   * **已知但不校验**的前缀：这些 id 在本层拿不到权威全集（实体登记可能晚于建边），
   * 所以只要求"认得出它是什么"，不要求"它已经存在"。
   */
  const knownUnvalidated = ['REQ-', 'TASK-', 'TC-'] as const
  const knownPrefixes = [...universes.map((entry) => entry.prefix), ...knownUnvalidated]
  for (const id of [input.from, input.to]) {
    const matched = universes.find((entry) => id.startsWith(entry.prefix))
    if (matched !== undefined) {
      if (!matched.ids.has(id)) {
        throw new Error(`引用了不存在的${matched.label} ${id}：${matched.hint}，再建追溯边（悬空边整条拒绝）`)
      }
      continue
    }
    if (!knownUnvalidated.some((prefix) => id.startsWith(prefix))) {
      throw new Error(
        `追溯边的一端 ${id} 不属于任何已知实体类别（可用前缀：${knownPrefixes.join(' / ')}）：悬空边不落盘`,
      )
    }
  }
  const existing = readLinks(store)
  if (existing.some((item) => item.from === input.from && item.to === input.to && item.kind === input.kind)) {
    return { link: { ...input, at: '' }, created: false }
  }
  const entry: TraceLink = { ...input, at: new Date().toISOString() }
  store.appendLine([TRACE_DIR, LINKS_FILE], JSON.stringify(entry))
  journal.append('trace/linked', { from: entry.from, to: entry.to, kind: entry.kind })
  return { link: entry, created: true }
}

/**
 * **F-5**：撤销一条追溯边。
 *
 * 关键点：`links.jsonl` 里可能有**读不出来的坏行**（`readLinksChecked` 会统计 `badLines`），
 * 因此这里**原样保留所有坏行**，只移除命中的那一条 —— 撤销边不该顺手"修好"或抹掉坏行证据。
 */
export function unlink(
  store: SdoStore,
  journal: Journal,
  input: { from: string; to: string; kind?: string | undefined },
): { removed: number } {
  const text = store.readText(TRACE_DIR, LINKS_FILE)
  if (text === undefined) return { removed: 0 }
  const keep: string[] = []
  let removed = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let hit = false
    try {
      const parsed = JSON.parse(line) as { from?: unknown; to?: unknown; kind?: unknown }
      hit =
        String(parsed.from) === input.from &&
        String(parsed.to) === input.to &&
        (input.kind === undefined || String(parsed.kind) === input.kind)
    } catch {
      hit = false // 坏行一律保留（它是"追溯坏行"判据的证据）
    }
    if (hit) removed += 1
    else keep.push(line)
  }
  if (removed === 0) return { removed: 0 }
  store.writeText([TRACE_DIR, LINKS_FILE], keep.length === 0 ? '' : `${keep.join('\n')}\n`)
  journal.append('trace/unlinked', { from: input.from, to: input.to, kind: input.kind ?? '', removed })
  return { removed }
}

/** 批量建边（拆分/派发时用）。 */
export function linkMany(
  store: SdoStore,
  journal: Journal,
  inputs: { from: string; to: string; kind: string }[],
): { created: number } {
  let created = 0
  for (const input of inputs) {
    if (link(store, journal, input).created) created++
  }
  return { created }
}

// —————————————————————— 一之三、缺陷追溯：孤儿缺陷与显式豁免（TASK-038 / REQ-058） ——————————————————————

/**
 * **一条缺陷的显式豁免**（落 `.sdo/defects/DEF-*.yml` 的 `exemption`）。
 *
 * 豁免是**人的决定**：它必须同时给出「为什么可以不管」（`reason`）与「谁批准的」（`approvedBy`）。
 * 两者任一为空 ⇒ **不算豁免**（按孤儿处理并点名）—— 与 `applicability` 的 "absent 必须给理由"
 * 同一条纪律：显式放过也必须有据可查，否则"沉默"就会伪装成"豁免"。
 */
export interface DefectExemption {
  reason: string
  approvedBy: string
}

/**
 * 台账里一条缺陷的**最小读面**（不是 `records.ts` 的 `Defect` 全貌，只是本判据用得到的四位）。
 *
 * 为什么单独给一个读面而不是直接吃 `Defect`：本判据要在**读不动**时判红（fail-closed），
 * 因此它必须自己看得见"文件读不出来"这件事，而不是让上游的 `listDefects` 静默丢掉坏文件。
 */
export interface DefectLedgerRecord {
  id: string
  exemption?: DefectExemption | undefined
}

/** 台账的整体可读性：`ok` 读得动 / `missing` 没有台账（等价于空台账）/ `unreadable` 读不动。 */
export type DefectLedgerStatus = 'ok' | 'missing' | 'unreadable'

/** 缺陷台账的读面（判据、TRACE.md、BOARD.md **共用**这一个形状与同一份现算结果）。 */
export interface DefectLedger {
  status: DefectLedgerStatus
  defects: DefectLedgerRecord[]
  /** 读不动时的原始报错（含文件名，由 `SdoStore.readYaml` 补上）。 */
  error?: string | undefined
}

/**
 * 一条指向失效目标的 `req-defect` 边（**悬空 / 已作废**）。
 *
 * `target` 是边上的那个 id；`reason` 是稳定码（`missing-requirement` / `withdrawn-requirement`），
 * 人话由语言包给。`defect` 是发起这条边的缺陷 —— 回执要能同时点名缺陷与目标。
 */
export interface DanglingDefectLink {
  defect: string
  target: string
  reason: string
}

/** 一条被**认可**的豁免（理由与批准人都非空）。 */
export interface RecognizedDefectExemption {
  defect: string
  reason: string
  approvedBy: string
}

/** 缺陷追溯的判定结论（**唯一现算出口**：判据 / TRACE.md / BOARD.md 三处都读它）。 */
export interface DefectLinkAssessment {
  /** 读数成立吗：`ok` 或 `empty` 为真；`unreadable` / `violations` 为假。 */
  ok: boolean
  /**
   * `ok` 全绿 / `empty` 台账为空（没有缺陷 = 100%，不是"判不动"）/
   * `unreadable` 台账读不动（fail-closed）/ `violations` 存在孤儿缺陷或悬空边。
   */
  status: 'ok' | 'empty' | 'unreadable' | 'violations'
  /** 台账里的缺陷总数。 */
  total: number
  /** 有**有效**边（指向已基线且未作废的需求）的缺陷 id。 */
  linked: string[]
  /**
   * **孤儿缺陷**：既没有有效边、也没有合规豁免的缺陷 id。
   *
   * 注意口径：**有边但边指向失效目标**的缺陷不在这里，而在 `dangling` —— 判红是一样的，
   * 但可执行修法不同（"补一条边" vs "改掉那条指向失效目标的边"），回执必须分开说。
   */
  orphans: string[]
  /** 指向失效目标（不存在 / 已作废或者未基线）的边，逐条点名。 */
  dangling: DanglingDefectLink[]
  /** 合规豁免（不计入孤儿），逐条带理由与批准人 —— 回执**必须**把它单列出来。 */
  exempted: RecognizedDefectExemption[]
  /**
   * 有豁免字段但**缺理由或缺批准人**的缺陷 id ⇒ 按未豁免处理，并单独点名
   * （不能与"孤儿"混作一句：它的修法是"把豁免补齐"，不是"补一条边"）。
   */
  invalidExemptions: string[]
  /** **缺陷追溯覆盖率**（有有效边或合规豁免的缺陷占比，0..1；台账为空时为 1）。 */
  coverage: number
  /** 读不动时的原始报错。 */
  readError?: string | undefined
  /** `req-defect` 边的坏行数（>0 ⇒ 图不完整，"没这条边"与"读不出来"分不开）。 */
  badLines: number
}

/** 台账读面的空实现（供纯函数入口与"没有台账"的路径共用）。 */
const EMPTY_DEFECT_LEDGER: DefectLedger = { status: 'missing', defects: [] }

/**
 * 判一个对象的文本字段（**不看形状**：`exemption` 写成字符串/数组一律按"没写"处理，
 * 绝不因为形状写坏而把一条孤儿缺陷静默放过）。
 */
function exemptionOf(value: unknown): { reason: string; approvedBy: string } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return { reason: textOf(record['reason']).trim(), approvedBy: textOf(record['approvedBy']).trim() }
}

/**
 * **缺陷台账的读面**（`.sdo/defects/DEF-*.yml`）。
 *
 * 与 `records.listDefects` 的分工：那个是"把台账读成 `Defect[]`"，读不动的文件**静默跳过**
 * （对"这条缺陷是什么"是对的，对**判据**是危险的 —— "文件坏了"会变成"没有这条缺陷"）。
 * 本函数如实回报三种状态，让判据能 fail-closed。
 *
 * 非 `DEF-<数字>.yml` 的文件（README、临时文件）不参与 —— 与 `listDefects` 同一筛选口径。
 */
export function readDefectLedger(store: SdoStore): DefectLedger {
  const dir = store.path('defects')
  if (!existsSync(dir)) return EMPTY_DEFECT_LEDGER
  try {
    if (!statSync(dir).isDirectory()) {
      return { status: 'unreadable', defects: [], error: `${store.root}/defects` }
    }
    const names = store.listNames('defects').filter((name) => /^DEF-\d+\.yml$/u.test(name))
    const defects: DefectLedgerRecord[] = []
    for (const name of names) {
      const raw = store.readYaml<Record<string, unknown>>('defects', name)
      const value = raw?.['defect']
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { status: 'unreadable', defects: [], error: `defects/${name}` }
      }
      const record = value as Record<string, unknown>
      // 没有 id 的缺陷记录**不能**被跳过：跳过等于放它过门禁。按文件名兜底（文件名就是 id）。
      const id = textOf(record['id']).trim() === '' ? name.replace(/\.yml$/u, '') : textOf(record['id']).trim()
      const exemption = exemptionOf(record['exemption'])
      defects.push({ id, ...(exemption === undefined ? {} : { exemption }) })
    }
    defects.sort((a, b) => a.id.localeCompare(b.id))
    return { status: 'ok', defects }
  } catch (error) {
    return { status: 'unreadable', defects: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * **缺陷追溯的判定核心**（纯函数：只吃"台账读面 + 追溯边 + 需求表"，不碰盘）。
 *
 * 判定三件事，都只问"**存在性与指向有效性**"（REQ-058 明写：不判链接质量）：
 *   · 孤儿 —— 既没有指向**已基线且未作废**需求的边，也没有合规豁免；
 *   · 悬空 —— 边指到不存在 / 已作废 / 未基线的需求（"有边"≠"有效"，AC-234）；
 *   · 豁免 —— 合规的（理由 + 批准人齐备）不计孤儿但**逐条列出**；缺字段的按孤儿处理并单独点名。
 *
 * 为什么判据不自己重写这套逻辑：TRACE.md、BOARD.md、门禁回执三处必须**同一读数**
 * （卡上那句"三处同源，不得各处再算一份"）—— 于是只有这一个出口，三处都调它。
 */
export function assessDefectLinksFrom(
  accessor: (requirementId: string) => Requirement | undefined,
  defects: readonly DefectLedgerRecord[],
  links: readonly TraceLink[],
): DefectLinkAssessment {
  const base = { total: 0, linked: [], orphans: [], dangling: [], exempted: [], invalidExemptions: [], badLines: 0 }
  if (defects.length === 0) {
    // 台账为空 = 没有缺陷要挂 ⇒ 100%（与"判不动"是两件事，必须在回执里分开说）
    return { ...base, ok: true, status: 'empty', coverage: 1 }
  }

  // ① 一条边算不算"有效"：目标需求**存在**、**已基线**、且**未作废**（REQ-058 的指向有效性）。
  //    判据只问这三件（"存在性与优先级有效性"），不问这条边挂得合不合理 —— 后者是人的判断。
  //    `dropped` 刻意不算 active：作废的需求不该再承担"这条缺陷归它"的义务。
  const isActive = (id: string): boolean => accessor(id)?.status === 'baselined'

  const linked: string[] = []
  const orphans: string[] = []
  const dangling: DanglingDefectLink[] = []
  const exempted: RecognizedDefectExemption[] = []
  const invalidExemptions: string[] = []

  for (const defect of defects) {
    const targets = links.filter((item) => item.kind === 'req-defect' && item.to === defect.id).map((item) => item.from)
    if (targets.some((target) => isActive(target))) {
      linked.push(defect.id)
      continue
    }
    // 有边、但没有一条落在有效需求上 ⇒ 逐条点名失效目标（AC-234：不许把"有边"当成"有效"）
    for (const target of targets.filter((item) => !isActive(item))) {
      dangling.push({
        defect: defect.id,
        target,
        reason: accessor(target) === undefined ? 'missing-requirement' : 'withdrawn-requirement',
      })
    }
    // 豁免：理由与批准人**都**非空才算数（缺任一个 ⇒ 按未豁免处理，并单独点名）
    const exemption = defect.exemption
    if (exemption !== undefined && exemption.reason !== '' && exemption.approvedBy !== '') {
      exempted.push({ defect: defect.id, reason: exemption.reason, approvedBy: exemption.approvedBy })
      continue
    }
    orphans.push(defect.id)
    if (exemption !== undefined) invalidExemptions.push(defect.id)
  }

  orphans.sort()
  dangling.sort((a, b) => (a.defect === b.defect ? a.target.localeCompare(b.target) : a.defect.localeCompare(b.defect)))
  exempted.sort((a, b) => a.defect.localeCompare(b.defect))
  const ok = orphans.length === 0 && dangling.length === 0
  return {
    ok,
    status: ok ? 'ok' : 'violations',
    total: defects.length,
    linked,
    orphans,
    dangling,
    exempted,
    invalidExemptions: [...invalidExemptions].sort(),
    // 覆盖率 = （有有效边或合规豁免）/ 全部缺陷。无孤儿即 100%（AC-230…AC-235 的读数口径）。
    coverage: Math.round(((linked.length + exempted.length) / defects.length) * 100) / 100,
    badLines: 0,
  }
}

/**
 * 台账**读不动**时的判定（fail-closed：判不动不许判绿）。
 *
 * 与"台账为空"严格分开：空是 100%（没有缺陷要挂），读不动是 0% + `ok: false` + 点名读不动的原因。
 */
export function unreadableDefectLinks(error: string): DefectLinkAssessment {
  return {
    ok: false,
    status: 'unreadable',
    total: 0,
    linked: [],
    orphans: [],
    dangling: [],
    exempted: [],
    invalidExemptions: [],
    coverage: 0,
    readError: error,
    badLines: 0,
  }
}

/**
 * 从盘上现算（**判据 / TRACE.md / BOARD.md 的唯一入口**）：
 * 读缺陷台账（`readDefectLedger`）+ 追溯边（`readLinksChecked`）⇒ `assessDefectLinksFrom`。
 *
 * ⚠️ 本函数**只读**：卡上写明判据「只读、不写盘」。豁免字段的落盘路径是
 * `.sdo/defects/DEF-*.yml` 的 `exemption: { reason, approvedBy }`（人写或工具写，不由本模块代写）。
 */
export function assessDefectLinks(store: SdoStore, requirements: Requirement[]): DefectLinkAssessment {
  const { links, badLines } = readLinksChecked(store)
  const ledger = readDefectLedger(store)
  // 台账读不动 ⇒ fail-closed（判不动不许判绿），但仍把坏行数带出去
  if (ledger.status === 'unreadable') {
    return { ...unreadableDefectLinks(ledger.error ?? ''), badLines }
  }
  const byId = new Map(requirements.map((item) => [item.id, item]))
  const assessment = assessDefectLinksFrom((id) => byId.get(id), ledger.defects, links)
  // 坏行数与"孤儿"是两件事：坏行说明图不完整，必须如实带出去（同 trace.orphans 的 P-8 口径）
  return { ...assessment, badLines }
}

/**
 * 从**已经算好的追溯报告**里取缺陷追溯读数（BOARD.md 走这条路）。
 *
 * 为什么是"取"而不是"再算一遍"：卡上落点四要求门禁回执 / TRACE.md / BOARD.md **同一读数**
 * （"不得各处再算一份"）。报告本来就带着这一位，看板直接取用即可 —— 这里不重算、不补齐、
 * 也不造假：报告里没有这一位（老夹具手工拼的报告）就返回 `undefined`，由调用方决定怎么显式说明。
 */
export function readDefectLinksOf(reportValue: object): DefectLinkAssessment | undefined {
  const value = (reportValue as { defectLinks?: unknown }).defectLinks
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<DefectLinkAssessment>
  return typeof candidate.status === 'string' && typeof candidate.coverage === 'number'
    ? (candidate as DefectLinkAssessment)
    : undefined
}

/**
 * 缺陷追溯判定的人话（**统一出口**：门禁回执、TRACE.md 的调用方都读它）。
 *
 * 文案一律走语言包（`uiTrace.*`）：`trace.ts` 自己不在 i18n 棘轮基线里（它有历史存量中文），
 * 但**新增**的面向用户文案按卡上落点六一律进语言包 —— 棘轮的宽严不是"可以随手加中文"的许可。
 */
export function describeDefectLinks(assessment: DefectLinkAssessment): string {
  const pct = Math.round(assessment.coverage * 100)
  if (assessment.status === 'unreadable') {
    return fmt('uiTrace.defectTraceUnreadable', { p1: assessment.readError ?? '' })
  }
  if (assessment.status === 'empty') return t('uiTrace.defectTraceEmpty')
  if (assessment.status === 'ok') {
    return fmt('uiTrace.defectTraceOk', { p1: String(assessment.total), p2: String(pct) })
  }
  const parts: string[] = []
  if (assessment.orphans.length > 0) {
    parts.push(fmt('uiTrace.defectTraceOrphans', { p1: assessment.orphans.join(' ') }))
  }
  if (assessment.dangling.length > 0) {
    parts.push(
      fmt('uiTrace.defectTraceDangling', {
        p1: assessment.dangling
          .map((item) => `${item.defect}\u2192${item.target}${item.reason === 'missing-requirement' ? t('uiTrace.defectTargetMissing') : t('uiTrace.defectTargetWithdrawn')}`)
          .join(' '),
      }),
    )
  }
  if (assessment.invalidExemptions.length > 0) {
    parts.push(fmt('uiTrace.defectTraceInvalidExemption', { p1: assessment.invalidExemptions.join(' ') }))
  }
  parts.push(fmt('uiTrace.defectTraceCoverage', { p1: String(assessment.total), p2: String(pct) }))
  return parts.join('；')
}

/**
 * 合规豁免的**逐条清单**（理由与批准人必须可见）。
 *
 * 卡上落点三写明「回执**必须单列豁免清单**……不得静默放过」：这个函数就是那一列的**唯一**来源 ——
 * 门禁回执与 TRACE.md 都调它，不各写一份措辞。
 */
export function defectLinksExemptionLines(assessment: DefectLinkAssessment): string[] {
  if (assessment.exempted.length === 0) return []
  const items = assessment.exempted.map((item) => `${item.defect}（${item.reason}／${item.approvedBy}）`)
  return [fmt('uiTrace.defectTraceExemptedList', { p1: items.join('，') })]
}

/** 判红时的**可执行修法**（AC-233）：补哪条边、或走哪条豁免（含字段形状）。 */
export function defectLinksRemedy(): string {
  return t('uiTrace.defectTraceRemedy')
}

/** 生成追溯报告：覆盖率 + 三类孤儿 + must 需求的测试缺口。 */
export function report(store: SdoStore, requirements: Requirement[]): TraceReport {
  // **N-3**：坏行必须一路带到判据 detail 里 —— 覆盖率/孤儿是拿这份集合判的，
  // "静默变短"等于让门禁在一份不完整的图上判绿。
  const { links, badLines, totalLines } = readLinksChecked(store)
  const reqIds = new Set(requirements.map((requirement) => requirement.id))

  const perRequirement = requirements
    .map((requirement) => {
      const design = links.filter((item) => item.kind === 'req-des' && item.from === requirement.id).map((item) => item.to)
      const tasks = links.filter((item) => item.kind === 'req-task' && item.from === requirement.id).map((item) => item.to)
      const tests = links.filter((item) => item.kind === 'req-tc' && item.from === requirement.id).map((item) => item.to)
      // **TASK-022**：这条需求出过哪些缺陷 —— 从图里现算，不去缺陷正文里搜关键字。
      const defects = links.filter((item) => item.kind === 'req-defect' && item.from === requirement.id).map((item) => item.to)
      return { id: requirement.id, design, tasks, tests, defects, covered: design.length > 0 }
    })
    .sort((a, b) => a.id.localeCompare(b.id))

  /**
   * 孤儿 = **全量元素**里没有"需求来源"的那些。
   * 关键：孤儿的全集来自各自的仓库（设计元素来自五视图），而不是来自链接——
   * 一个从未被链接过的元素恰恰是典型的孤儿。
   * `TASK-*` / `TC-*` 的仓库在 M4 落地，因此现在只按链接里出现过的 id 统计（并在此注明口径）。
   */
  const orphanOf = (kind: string, prefix: string, universe: string[]): string[] => {
    const linked = universe.length > 0
      ? universe
      : [
          ...new Set([
            ...links.filter((item) => item.kind === kind).map((item) => item.to),
            ...links.filter((item) => item.kind === kind).map((item) => item.from),
          ]),
        ]
    return linked
      .filter((id) => id.startsWith(prefix))
      .filter((id) => !links.some((item) => item.kind === kind && item.to === id && reqIds.has(item.from)))
      .sort()
  }

  const designUniverse = listElements(store).map((element) => element.id)

  /**
   * 增量 2：**方法产物条目**也进同一张孤儿检查（不新造判据）。
   *
   * 口径与设计元素一致："有需求来源"= 写了 `requires: [REQ-xxx]` **或** 建了 `req-des` 追溯边；
   * 两者都没有的条目就是孤儿，由既有 `trace.orphans` 抓出来。
   */
  const methodOrphans = methodTraceables(store)
    .filter((entry) => entry.requires.length === 0)
    .filter((entry) => !links.some((item) => item.kind === 'req-des' && item.to === entry.id && reqIds.has(item.from)))
    .map((entry) => entry.id)
    .sort()

  const uncoveredMust = requirements
    .filter((requirement) => requirement.priority === 'must')
    .filter((requirement) => !links.some((item) => item.kind === 'req-tc' && item.from === requirement.id))
    .map((requirement) => requirement.id)

  const coveredCount = perRequirement.filter((item) => item.covered).length
  /**
   * **TASK-038 / REQ-058**：缺陷那一类的孤儿**不再由 `orphanOf` 现算** —— 它多了两个必须一起看的因素：
   * 「边指向失效目标」（有边 ≠ 有效）与「显式豁免」（不计孤儿但必须列出来）。
   * 口径只允许有一份，于是走本模块的**唯一出口** `assessDefectLinksFrom`。
   *
   * ⚠️ 台账必须走 `readDefectLedger`（**不是** `listDefects`）：`listDefects` 返回的 `Defect`
   * 没有豁免位，用它拼台账会让"带豁免的缺陷"在这条路径上被当成孤儿 —— 于是 `docs/TRACE.md`
   * 与门禁回执会给出**两个不同的覆盖率**（实测：同一份盘上数据，TRACE.md 报 50%、回执报 100%）。
   * 这正是卡上那句"同一现算口径，不得各写一份"要防的东西：数据来源也必须同一份。
   */
  const ledger = readDefectLedger(store)
  const defectLinks = ledger.status === 'unreadable'
    // 台账读不动 ⇒ fail-closed（判不动不许判绿），但坏行数照旧如实带出去
    ? { ...unreadableDefectLinks(ledger.error ?? ''), badLines }
    : { ...assessDefectLinksFrom((id) => requirements.find((item) => item.id === id), ledger.defects, links), badLines }
  // **TASK-035 落点五**：`TraceReport`（`src/types.ts`）此前没有 `perRequirement[].defects` 与
  // `orphans.defects` 两个位，这里当时只能靠一次 `as TraceReport` 断言绕过对象字面量的多余属性检查。
  // 类型位补上之后**断言已删**：下面就是普通的结构化返回，字段对不上会由 tsc 当场拦下。
  const built = {
    total: links.length,
    badLines,
    totalLines,
    perRequirement,
    orphans: {
      design: [...orphanOf('req-des', 'DES-', designUniverse), ...methodOrphans],
      tasks: orphanOf('req-task', 'TASK-', []),
      tests: orphanOf('req-tc', 'TC-', []),
      // **TASK-022**：缺陷也要能回到需求。全集取**缺陷台账**（不是图）——
      // 一条从未被链接过的缺陷恰恰是典型的孤儿，只看图会漏掉它。
      // **TASK-038**：豁免过的缺陷**不再**算孤儿（把豁免读进来，而不是把台账丢给 `orphanOf`）。
      defects: defectLinks.orphans,
    },
    uncoveredMust,
    coverage: requirements.length === 0 ? 0 : Math.round((coveredCount / requirements.length) * 100) / 100,
    // **TASK-038 落点四**：读数随报告一起出去 —— 判据 / TRACE.md / BOARD.md 都读这一份（三处同源）。
    defectLinks,
  }
  /**
   * ⚠️ **这里为什么要一次类型收窄**（TASK-038 的写范围逼出来的，与 TASK-037 同款的取舍）：
   * 本卡的写范围不含 `src/types.ts`（实测：往 `TraceReport` 加一个字段会被钩子以「越界写」直接拒绝），
   * 而"三处同源"又要求读数**随报告一起**出去。于是形状在**本模块**声明（`DefectLinkAssessment`），
   * 收窄只用于把多出来的那一位交给 `TraceReport` 的调用方 —— 判定与数据**都不在这里**，
   * 它们各自只有一份（`assessDefectLinksFrom`）。补 `types.ts` 的形状位属后续卡。
   */
  return built as TraceReport & { defectLinks: DefectLinkAssessment }
}

/** 渲染 `TRACE.md`（派生视图，设计 §10.1 的产物链）。 */
export function renderTraceReport(input: { report: TraceReport; seq: number; header: string }): string {
  const { report: data } = input
  const lines: string[] = [input.header, '', '# 追溯矩阵与覆盖率', '']
  lines.push(`- 追溯边总数：${data.total}`)
  lines.push(`- 需求覆盖率（有设计元素的需求占比）：${Math.round(data.coverage * 100)}%`)
  lines.push(`- 孤儿设计元素：${data.orphans.design.length === 0 ? '无' : data.orphans.design.join(' ')}`)
  lines.push(`- 无需求来源的任务：${data.orphans.tasks.length === 0 ? '无' : data.orphans.tasks.join(' ')}`)
  lines.push(`- 无需求来源的测试用例：${data.orphans.tests.length === 0 ? '无' : data.orphans.tests.join(' ')}`)
  // **TASK-022**：缺陷的溯源缺口必须**在文档里看得见** —— 只在数据里存在、文档与判据都不列，
  // 等于"缺陷可挂需求"这件事对读者与门禁都不存在（那正是 DEF-005 那类"只以真源存在、没人读"的老问题）。
  // **TASK-035 落点五**：类型位补上后这里**不再需要** `as unknown as { defects?: string[] }` 绕行。
  //
  // **TASK-038 落点四**：同一读数还要带**覆盖率**与**豁免清单** —— 数据由 `report.defectLinks` 给
  // （与门禁回执、BOARD.md 同一个出口），文案由 `describeDefectLinks` / `defectLinksExemptionLines`
  // 给（与门禁回执**同一份措辞**，不在这里另写一套）。
  // 取法走 `readDefectLinksOf`（同一份收窄逻辑，三处消费面共用）—— 少了它这里就得各写一次断言。
  const defectLinks = readDefectLinksOf(data)
  const defectOrphans = data.orphans.defects
  lines.push(`- 无需求来源的缺陷：${defectOrphans.length === 0 ? '无' : defectOrphans.join(' ')}`)
  if (defectLinks !== undefined) {
    lines.push(`- 缺陷追溯：${describeDefectLinks(defectLinks)}`)
    lines.push(...defectLinksExemptionLines(defectLinks))
  }
  lines.push(`- must 需求缺测试用例：${data.uncoveredMust.length === 0 ? '无' : data.uncoveredMust.join(' ')}`)
  lines.push(`- 真源 seq：${input.seq}`)
  lines.push('')
  lines.push('## 逐条需求')
  lines.push('')
  for (const item of data.perRequirement) {
    const itemDefects = item.defects
    lines.push(`- ${item.id}：设计 ${item.design.join(' ') || '（无）'} ｜ 任务 ${item.tasks.join(' ') || '（无）'} ｜ 测试 ${item.tests.join(' ') || '（无）'} ｜ 缺陷 ${itemDefects.join(' ') || '（无）'}`)
  }
  return `${lines.join('\n')}\n`
}
