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
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { Requirement, TraceLink, TraceReport } from '../types.js'

export const TRACE_DIR = 'trace'
export const LINKS_FILE = 'links.jsonl'

/** 允许的边语义（写错就报错，避免图里混进无意义边）。 */
export const TRACE_KINDS = ['req-des', 'req-task', 'req-tc', 'des-task', 'des-ct'] as const

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
  const elementUniverse = new Set(listElements(store).map((element) => element.id))
  const contractUniverse = new Set(listContracts(store).map((contract) => contract.id))
  for (const id of [input.from, input.to]) {
    if (id.startsWith('DES-') && !elementUniverse.has(id)) {
      throw new Error(`引用了不存在的设计元素 ${id}：先用 \`sdo_design action=create\` 创建它，再建追溯边`)
    }
    if (id.startsWith('CT-') && !contractUniverse.has(id)) {
      throw new Error(`引用了不存在的契约 ${id}：先用 \`sdo_design action=contract\` 创建它，再建追溯边`)
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
      return { id: requirement.id, design, tasks, tests, covered: design.length > 0 }
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
  return {
    total: links.length,
    badLines,
    totalLines,
    perRequirement,
    orphans: {
      design: [...orphanOf('req-des', 'DES-', designUniverse), ...methodOrphans],
      tasks: orphanOf('req-task', 'TASK-', []),
      tests: orphanOf('req-tc', 'TC-', []),
    },
    uncoveredMust,
    coverage: requirements.length === 0 ? 0 : Math.round((coveredCount / requirements.length) * 100) / 100,
  }
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
  lines.push(`- must 需求缺测试用例：${data.uncoveredMust.length === 0 ? '无' : data.uncoveredMust.join(' ')}`)
  lines.push(`- 真源 seq：${input.seq}`)
  lines.push('')
  lines.push('## 逐条需求')
  lines.push('')
  for (const item of data.perRequirement) {
    lines.push(`- ${item.id}：设计 ${item.design.join(' ') || '（无）'} ｜ 任务 ${item.tasks.join(' ') || '（无）'} ｜ 测试 ${item.tests.join(' ') || '（无）'}`)
  }
  return `${lines.join('\n')}\n`
}
