/**
 * 成本归集与预算（设计 §10.2 / M5）。
 *
 * 三条纪律（都来自设计，且都是"不骗人"的约束）：
 *   ① dsh 只给 **token 计量**，没有货币能力：单价表由**用户手填**；没填单价时**只显示 token**，
 *      绝不猜金额；任何金额都标注「估算」。
 *   ② `budget` 整块**可选**；没填 `total` 时只展示"已消耗"，**不显示剩余/百分比、不触发阈值**。
 *   ③ 预算**永不硬停**（C-08）：跨阈值只**问一次**（每档一次），由人选择追加/豁免/收敛。
 *
 * 本模块是纯函数（无 IO、无宿主依赖），因此可以用夹具把预算语义钉死。
 */

import { pushShapeNote, recordListOf, textListOf, textOf, typeNameOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'

/** 用量的一行（来自 tokenMeter 的测量结果）。 */
export interface UsageRow {
  sessionId: string
  /** `<provider>/<model>`；未知时用 'unknown' */
  model: string
  promptTokens: number
  completionTokens: number
}

/** 单价表：用户手填，`<provider>/<model>` → 每 `perTokens` 个 token 的价格。 */
export interface PriceTable {
  currency: string
  perTokens: number
  prices: Record<string, number>
}

export const DEFAULT_PRICE_TABLE: PriceTable = { currency: 'CNY', perTokens: 1_000_000, prices: {} }

export interface UsageSummary {
  at: string
  sessions: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  perModel: { model: string; tokens: number; priced: boolean }[]
  /** 只有**全部**用量都能定价时才给金额；否则 undefined（宁可不说） */
  estimatedCost?: { amount: number; currency: string; label: '估算' } | undefined
  /** 有 token 但没单价的部分（说明为什么没有金额） */
  unpricedTokens: number
}

/** 汇总用量。缺单价时不给金额，并说明有多少 token 无法定价。 */
export function summarize(rows: UsageRow[], table: PriceTable = DEFAULT_PRICE_TABLE, at = new Date().toISOString()): UsageSummary {
  const byModel = new Map<string, number>()
  let promptTokens = 0
  let completionTokens = 0
  const sessions = new Set<string>()
  for (const row of rows) {
    const tokens = row.promptTokens + row.completionTokens
    byModel.set(row.model, (byModel.get(row.model) ?? 0) + tokens)
    promptTokens += row.promptTokens
    completionTokens += row.completionTokens
    sessions.add(row.sessionId)
  }
  let amount = 0
  let priced = true
  let unpricedTokens = 0
  for (const [model, tokens] of byModel) {
    const price = priceFor(model, table)
    if (price === undefined) {
      priced = false
      unpricedTokens += tokens
      continue
    }
    amount += (tokens / table.perTokens) * price
  }
  const totalTokens = promptTokens + completionTokens
  return {
    at,
    sessions: sessions.size,
    promptTokens,
    completionTokens,
    totalTokens,
    perModel: [...byModel.entries()].map(([model, tokens]) => ({ model, tokens, priced: priceFor(model, table) !== undefined })).sort((a, b) => b.tokens - a.tokens),
    ...(priced && totalTokens > 0 ? { estimatedCost: { amount: Math.round(amount * 100) / 100, currency: table.currency, label: '估算' as const } } : {}),
    unpricedTokens,
  }
}

export function priceFor(model: string, table: PriceTable): number | undefined {
  return table.prices[model]
}

/** 预算（`.sdo/budget.yml`）。`total` 可选——没填就只报消耗。 */
export interface Budget {
  /** 总预算（可选）；不填则不显示剩余/百分比、不触发阈值 */
  total?: number | undefined
  currency: string
  /** 阈值档位（百分比），默认 [50, 80, 100] */
  tiers: number[]
  /** 已经问过的档位（"每档只问一次"靠它） */
  askedTiers: string[]
  /** 人的决定（追加/豁免/收敛） */
  decisions: { at: string; tier: string; choice: BudgetChoice; note: string }[]
}

export type BudgetChoice = 'add-budget' | 'waive' | 'narrow-scope'

export const BUDGET_CHOICES: BudgetChoice[] = ['add-budget', 'waive', 'narrow-scope']

export const CHOICE_LABEL: Record<BudgetChoice, string> = {
  'add-budget': '追加预算',
  waive: '继续并记豁免',
  'narrow-scope': '收敛范围',
}

export function defaultBudget(): Budget {
  return { currency: 'CNY', tiers: [50, 80, 100], askedTiers: [], decisions: [] }
}

/** 当前消耗占预算的比例（没有 total 或金额未知时 undefined）。 */
export function usedRatio(used: number, budget: Budget): number | undefined {
  if (budget.total === undefined || budget.total <= 0) return undefined
  return used / budget.total
}

/**
 * 是否跨过了一个**尚未问过**的阈值档。
 * 预算未设 `total` 时恒返回 undefined（不触发阈值——审慎原则）。
 */
export function crossingTier(
  used: number,
  budget: Budget,
): { tier: string; percent: number; message: string } | undefined {
  const ratio = usedRatio(used, budget)
  if (ratio === undefined) return undefined
  const percent = ratio * 100
  const crossed = [...budget.tiers].sort((a, b) => a - b).filter((tier) => percent >= tier)
  const fresh = crossed.find((tier) => !budget.askedTiers.includes(`${tier}%`))
  if (fresh === undefined) return undefined
  return {
    tier: `${fresh}%`,
    percent: Math.round(percent * 10) / 10,
    message: `已用 ${Math.round(percent)}%（${crossed.join('%、')}% 档），达到 ${fresh}% 阈值`,
  }
}

/** 成本快照（落 `.sdo/cost.yml`，状态块只读它）。 */
export interface CostSnapshot {
  at: string
  totalTokens: number
  currency: string
  unpricedTokens: number
  /** 只有填了单价才有金额（估算） */
  amount?: number | undefined
}

/** 从 `.sdo/` 读成本快照（没有就是没测过）。 */
export function readCostSnapshot(store: { readYaml<T>(...segments: string[]): T | undefined }): CostSnapshot | undefined {
  return store.readYaml<{ cost: CostSnapshot }>('cost.yml')?.cost
}

/**
 * 读预算并**做形状归一化**（F-21 ①）。
 *
 * `.sdo/budget.yml` 是手可编辑真源，三个列表位置：`tiers`（数字列表）、`askedTiers`（字符串列表）、
 * `decisions`（记录列表）。旧实现 `[...budget.tiers]` 在 `tiers: 50` 这类手写下会把字符串
 * **展开成字符**（`['5','0']`），阈值提醒随之变成静默的胡说；`decisions` 被展开同理。
 * 口径：标量 → 单元素 + 提示；映射写在列表位置 → 空 + 提示（**不猜**）。
 */
export function readBudgetChecked(store: { readYaml<T>(...segments: string[]): T | undefined }): {
  budget: Budget | undefined
  notes: FieldShapeNote[]
} {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ budget: unknown }>('budget.yml')?.budget
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) {
      pushShapeNote(notes, 'budget', 'budget.yml', 'budget', { position: 'map', actualType: typeNameOf(raw), handling: 'empty', text: textOf(raw) })
    }
    return { budget: undefined, notes }
  }
  const record = raw as Record<string, unknown>
  // 数字列表：标量 → 单元素（解析不出数字的项丢掉，但形状问题已经报出）
  const tiersRead = textListOf(record.tiers)
  pushShapeNote(notes, 'budget', 'budget.yml', 'tiers', tiersRead.issue)
  const askedRead = textListOf(record.askedTiers)
  pushShapeNote(notes, 'budget', 'budget.yml', 'askedTiers', askedRead.issue)
  const decisionsRead = recordListOf<Budget['decisions'][number]>(record.decisions, (text) => ({ at: '', tier: text, choice: 'waive', note: '' }))
  pushShapeNote(notes, 'budget', 'budget.yml', 'decisions', decisionsRead.issue)
  const budget: Budget = {
    ...(record as unknown as Budget),
    currency: textOf(record.currency),
    tiers: tiersRead.value.map((item) => Number(item)).filter((tier) => Number.isFinite(tier)),
    askedTiers: askedRead.value,
    decisions: decisionsRead.value.map((decision) => ({
      at: textOf(decision.at),
      tier: textOf(decision.tier),
      choice: textOf(decision.choice) as BudgetChoice,
      note: textOf(decision.note),
    })),
  }
  // 用 `delete` 而不是赋 undefined：YAML 写入器不支持值为 undefined 的键
  if (typeof record.total === 'number' && Number.isFinite(record.total)) budget.total = record.total
  else delete budget.total
  return { budget, notes }
}

/** 预算上的形状提示（回执 / 只读视图 / 门禁详情共用）。 */
export function budgetShapeNotes(store: { readYaml<T>(...segments: string[]): T | undefined }): FieldShapeNote[] {
  return readBudgetChecked(store).notes
}

/** 预算面板行：**没有 total 时不给剩余/百分比**。 */
export function describeBudgetLine(summary: UsageSummary, budget: Budget | undefined): string {
  const tokens = `${summary.totalTokens} tokens`
  const money = summary.estimatedCost === undefined ? '' : `（估算 ${summary.estimatedCost.currency} ${summary.estimatedCost.amount.toFixed(2)}）`
  if (budget === undefined || budget.total === undefined) {
    return `成本：已消耗 ${tokens}${money}${summary.unpricedTokens > 0 ? `；其中 ${summary.unpricedTokens} tokens 未填单价，故不给金额` : ''}`
  }
  const ratio = usedRatio(summary.estimatedCost?.amount ?? 0, budget)
  const remaining = budget.total - (summary.estimatedCost?.amount ?? 0)
  if (ratio === undefined) return `成本：已消耗 ${tokens}${money}`
  return `成本：已消耗 ${tokens}${money} ｜ 剩余（估算）${budget.currency} ${remaining.toFixed(2)}（${Math.round((1 - ratio) * 100)}%）`
}

/** 派发前的容量/成本提示：预算超了也**不阻止**，只提醒（C-08）。 */
export function budgetAdvice(summary: UsageSummary, budget: Budget | undefined): string | undefined {
  if (budget === undefined || budget.total === undefined || summary.estimatedCost === undefined) return undefined
  const ratio = usedRatio(summary.estimatedCost.amount, budget)
  if (ratio === undefined || ratio < 1) return undefined
  const lastDecision = budget.decisions.at(-1)
  return lastDecision === undefined
    ? `成本已超预算（估算 ${summary.estimatedCost.amount.toFixed(2)} / ${budget.total} ${budget.currency}）：请选择追加预算、继续并记豁免或收敛范围（设计 §10.2，**不会自动停**）`
    : `成本仍超预算；最近一次决定：${CHOICE_LABEL[lastDecision.choice]}（${lastDecision.at}）`
}
