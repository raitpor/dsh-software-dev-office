/**
 * **测试先行**（C7）：`normal` / `critical` 档的项目里，任务卡的**需求在认领前就要有用例计划**，
 * 完成前要**有结果**（通过，或显式跳过 + 理由）。
 *
 * 为什么卡在这两步：`claim` 是执行者开工的关口、`done` 是收工的关口 —— 只有在这两处拦，
 * 才能既避免"实现完才补用例"，又避免"用例全是 fail 还能把卡标完成"。
 *
 * 三条豁免（不做就是不做，写清楚而不是悄悄跳过）：
 *   · 项目规模 `trivial`：这套流程对小项目是负担；
 *   · 卡上没有需求（`requirements` 为空，例如纯工程整治卡）：没有可对应的验收标准；
 *   · 用例的 `requirement` 字段留空：本判据只看"有没有对应该需求的用例"，不猜。
 */
import { fmt } from './i18n.js'
import { listTestCases, listTestResults } from './records.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { SdoProject, TaskCard } from '../types.js'

export type TestFirstGap =
  | { kind: 'no-case'; requirement: string }
  | { kind: 'no-result'; requirement: string }
  | { kind: 'failing'; requirement: string }
  /** 有用例、也有结果，但结果是 `skip` 而**没写理由** —— 这不是"没跑"，是"没说明"，文案必须分开。 */
  | { kind: 'skip-unjustified'; requirement: string }
  /** 结果文件在 journal 里**没有对应事件**（手写/伪造）：`.sdo/tests/results/*.yml` 可手改，这是唯一的来源凭据。 */
  | { kind: 'untraceable'; ids: string[] }

/** 项目规模（`trivial` 档豁免本判据）。读不到就按 `normal` 处理（更严，不放过）。 */
export function projectScale(store: SdoStore): string {
  const project = store.readJson<SdoProject>('project.json')
  const scale: unknown = project?.tailoring?.scale
  return typeof scale === 'string' && scale !== '' ? scale : 'normal'
}

/**
 * 该卡还缺什么（空数组 = 满足）。
 *
 * @param phase `claim`：只要求"有用例计划"；`done`：还要求"有结果"（pass，或 skip + 非空理由）
 */
export function testFirstGaps(store: SdoStore, task: TaskCard, phase: 'claim' | 'done', journal: Journal): TestFirstGap[] {
  if (projectScale(store) === 'trivial') return []
  const requirements = task.requirements.map((item) => String(item)).filter((item) => item !== '')
  if (requirements.length === 0) return []
  const cases = listTestCases(store)
  const results = listTestResults(store)
  const gaps: TestFirstGap[] = []
  // **来源核对**（与 `redGreenGaps` 同一道，评审建议 1）：`recordTestResult` 文件与 journal 两处都写；
  // 只有文件、没有事件的结果**不算数**。只核对**本卡用例**的结果，不牵连无关卡。
  if (phase === 'done') {
    const caseIds = new Set(cases.filter((item) => requirements.includes(String(item.requirement))).map((item) => item.id))
    const traceable = new Set(
      journal
        .read()
        .events.filter((event) => event.type === 'test/recorded' && String(event.data.caseId ?? '') !== '')
        .map((event) => String(event.data.id ?? '')),
    )
    const untraceable = results.filter((item) => caseIds.has(item.caseId) && !traceable.has(item.id)).map((item) => item.id)
    if (untraceable.length > 0) gaps.push({ kind: 'untraceable', ids: untraceable })
  }
  for (const requirement of requirements) {
    const mine = cases.filter((item) => item.requirement === requirement)
    if (mine.length === 0) {
      gaps.push({ kind: 'no-case', requirement })
      continue
    }
    if (phase === 'claim') continue
    const ids = new Set(mine.map((item) => item.id))
    const mineResults = results.filter((item) => ids.has(item.caseId))
    const passed = mineResults.some((item) => item.status === 'pass')
    // 显式 N/A：skip 也算"有结果"，但必须给理由（空理由就是没说明）
    const skippedWithReason = mineResults.some((item) => item.status === 'skip' && item.evidence.trim() !== '')
    if (passed || skippedWithReason) continue
    const unjustifiedSkip = mineResults.some((item) => item.status === 'skip' && item.evidence.trim() === '')
    gaps.push({
      kind: mineResults.length === 0 ? 'no-result' : unjustifiedSkip && !mineResults.some((item) => item.status === 'fail') ? 'skip-unjustified' : 'failing',
      requirement,
    })
  }
  return gaps
}

/** 把缺口翻译成一句可执行的说明（回执直接用它）。 */
export function describeTestFirstGaps(taskId: string, phase: 'claim' | 'done', gaps: TestFirstGap[]): string {
  const noCase = gaps.filter((gap) => gap.kind === 'no-case').map((gap) => gap.requirement)
  const noResult = gaps.filter((gap) => gap.kind === 'no-result').map((gap) => gap.requirement)
  const failing = gaps.filter((gap) => gap.kind === 'failing').map((gap) => gap.requirement)
  const unjustifiedSkip = gaps.filter((gap) => gap.kind === 'skip-unjustified').map((gap) => gap.requirement)
  const untraceable = gaps.flatMap((gap) => (gap.kind === 'untraceable' ? gap.ids : []))
  const parts: string[] = []
  if (untraceable.length > 0) parts.push(fmt('uiTestFirst.kUntraceable', { p1: untraceable.join(' ') }))
  if (noCase.length > 0) parts.push('这些需求还没有用例计划：' + noCase.join('、') + '（先 sdo_test action=plan）')
  if (noResult.length > 0) parts.push('这些需求的用例还没跑出结果：' + noResult.join('、') + '（跑 sdo_test action=record）')
  if (failing.length > 0) parts.push('这些需求的用例结果是 fail：' + failing.join('、') + '（修好重跑）')
  if (unjustifiedSkip.length > 0) parts.push('这些需求的用例是 skip 但**没写理由**：' + unjustifiedSkip.join('、') + '（确实不做就补一句理由，那是显式 N/A）')
  const head = phase === 'claim' ? '测试先行：认领前要先有用例计划' : '测试先行：完成前要有结果'
  return `${taskId} ${head} —— ${parts.join('；')}`
}
