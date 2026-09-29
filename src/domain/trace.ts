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
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { Requirement, TraceLink, TraceReport } from '../types.js'

export const TRACE_DIR = 'trace'
export const LINKS_FILE = 'links.jsonl'

/** 允许的边语义（写错就报错，避免图里混进无意义边）。 */
export const TRACE_KINDS = ['req-des', 'req-task', 'req-tc', 'des-task', 'des-ct'] as const

export function readLinks(store: SdoStore): TraceLink[] {
  const text = store.readText(TRACE_DIR, LINKS_FILE)
  if (text === undefined) return []
  const links: TraceLink[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as TraceLink
      if (typeof parsed.from === 'string' && typeof parsed.to === 'string' && typeof parsed.kind === 'string') {
        links.push(parsed)
      }
    } catch {
      // 坏行不影响其余追溯（但要靠 report 的 total 与文件行数对不上时被发现）
    }
  }
  return links
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
  // 引用了不存在的设计元素 = 悬空边：必须当场报错，否则覆盖率会被虚增
  const designUniverse = new Set(listElements(store).map((element) => element.id))
  for (const id of [input.from, input.to]) {
    if ((id.startsWith('DES-') || id.startsWith('CT-')) && !designUniverse.has(id)) {
      throw new Error(`引用了不存在的设计元素 ${id}：先用 \`sdo_design action=create\` 创建它，再建追溯边`)
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
  const links = readLinks(store)
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

  const uncoveredMust = requirements
    .filter((requirement) => requirement.priority === 'must')
    .filter((requirement) => !links.some((item) => item.kind === 'req-tc' && item.from === requirement.id))
    .map((requirement) => requirement.id)

  const coveredCount = perRequirement.filter((item) => item.covered).length
  return {
    total: links.length,
    perRequirement,
    orphans: {
      design: orphanOf('req-des', 'DES-', designUniverse),
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
