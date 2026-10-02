/**
 * 预算回执（`/sdo-budget --set` / `--decide`）。
 *
 * 为什么单独成模块：与 `designReceipt.ts` 同一个理由 —— 命令面（`/sdo-budget`）的
 * **校验 + 留痕 + 文案**必须是可被测试直接复用的**同一份实现**，而不是在测试里再抄一遍
 * （抄一遍的话，"非法选择被拒绝"这类行为只能在真实宿主里手测，回归时没人守得住）。
 * 本模块只依赖 {@link SoftwareDevOffice} 与语言包。
 *
 * 纪律：超预算**绝不自动停** —— `decide` 只留痕（写 `budget/decision`），开发继续。
 */
import { BUDGET_CHOICES } from '../integration/cost.js'
import type { BudgetChoice } from '../integration/cost.js'
import { fmt, t } from '../domain/i18n.js'
import type { OfficeCall, SoftwareDevOffice } from '../office.js'

/** `--set` 的输入（与 `OfficeCommandDeps.setBudget` 的结构一致）。 */
export interface BudgetInput {
  total?: number | undefined
  currency?: string | undefined
  tiers?: number[] | undefined
}

/**
 * `--set` 回执：总预算 + 档位 + 单价表来源。
 * `prices` 由装配层传入（`settings.cost.prices`），本模块不读配置。
 */
export function setBudgetReceipt(
  office: SoftwareDevOffice,
  call: OfficeCall,
  input: BudgetInput,
  prices: Record<string, number>,
): string {
  const budget = office.setBudget(call, input)
  return [
    fmt('uiIndex.m1', { p1: budget.total === undefined ? t('uiIndex.m2') : `${budget.currency} ${budget.total}` }),
    fmt('uiIndex.k10', { p1: budget.tiers.join(' / ') }),
    t('uiIndex.k11') + (Object.keys(prices).length === 0 ? t('uiIndex.k120') : Object.entries(prices).map(([model, price]) => `${model}=${price}`).join(' ')),
  ].join('\n')
}

/**
 * `--decide` 回执：三选一留痕。
 *
 * **非法值必须在这里被拒绝**（返回语言包里的 `uiIndex.k12`），且**不得**写进 `budget.yml`：
 * 放宽参数解析（裸 `choice=` 兼容）时最容易踩的坑，就是把非法值也当成合法决策放行。
 */
export function decideBudgetReceipt(office: SoftwareDevOffice, call: OfficeCall, choice: string, note: string): string {
  if (!(BUDGET_CHOICES as readonly string[]).includes(choice)) return t('uiIndex.k12')
  const budget = office.decideBudget(call, choice as BudgetChoice, note)
  const labels: Record<string, string> = { 'add-budget': t('uiIndex.k13'), waive: t('uiIndex.k14'), 'narrow-scope': t('uiIndex.k15') }
  return fmt('uiIndex.k16', { p1: labels[choice], p2: note, p3: budget.decisions.length })
}
