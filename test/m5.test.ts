import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import {
  budgetAdvice,
  crossingTier,
  defaultBudget,
  describeBudgetLine,
  summarize,
  usedRatio,
} from '../src/integration/cost.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { UsageRow } from '../src/integration/cost.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m5/', import.meta.url))
const call = (): { sessionId: string } => ({ sessionId: 's1' })
const rows: UsageRow[] = [
  { sessionId: 'lead', model: 'deepseek-official/deepseek-chat', promptTokens: 400_000, completionTokens: 100_000 },
  { sessionId: 'sub-1', model: 'deepseek-official/deepseek-chat', promptTokens: 300_000, completionTokens: 200_000 },
]

let workspace: string
let office: SoftwareDevOffice

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  workspace = join(BASE, 'proj')
  mkdirSync(workspace, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', workspace)
  office.init(call(), { name: 'M5 测试', scale: 'normal', stakeholders: ['业务方'] })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('缺单价时只给 token，绝不猜金额', () => {
  const summary = summarize(rows, { currency: 'CNY', perTokens: 1_000_000, prices: {} })
  assert.equal(summary.totalTokens, 1_000_000)
  assert.equal(summary.sessions, 2)
  assert.equal(summary.estimatedCost, undefined, '没有单价就不给金额')
  assert.equal(summary.unpricedTokens, 1_000_000)
  assert.equal(summary.perModel.every((row) => row.priced === false), true)
  assert.match(describeBudgetLine(summary, undefined), /未填单价|不给金额/u)
})

test('填了单价才给金额，且处处标注「估算」', () => {
  const table = { currency: 'CNY', perTokens: 1_000_000, prices: { 'deepseek-official/deepseek-chat': 2 } }
  const summary = summarize(rows, table)
  assert.equal(summary.estimatedCost?.amount, 2)
  assert.equal(summary.estimatedCost?.label, '估算')
  assert.match(describeBudgetLine(summary, undefined), /估算/u)
  // 部分有价、部分没有 → 仍不给金额（宁可不说）
  const partial = summarize([...rows, { sessionId: 'x', model: 'unknown/model', promptTokens: 10, completionTokens: 0 }], table)
  assert.equal(partial.estimatedCost, undefined)
  assert.equal(partial.unpricedTokens, 10)
})

test('预算可选：没设 total 时不显示剩余/百分比、不触发阈值', () => {
  const table = { currency: 'CNY', perTokens: 1_000_000, prices: { 'deepseek-official/deepseek-chat': 100 } }
  const summary = summarize(rows, table) // 1M tokens × 100 = 100 元
  const noTotal = defaultBudget()
  const line = describeBudgetLine(summary, noTotal)
  assert.match(line, /已消耗/u)
  assert.equal(/剩余|%/u.test(line), false, '没设 total 就不许出现剩余或百分比')
  assert.equal(crossingTier(100, noTotal), undefined, '没设 total 就不触发阈值')
  assert.equal(budgetAdvice(summary, noTotal), undefined)

  const withTotal = { ...defaultBudget(), total: 80 }
  assert.equal(usedRatio(100, withTotal), 1.25)
  assert.match(describeBudgetLine(summary, withTotal), /剩余/u)
  assert.match(budgetAdvice(summary, withTotal) ?? '', /超预算/u)
})

test('阈值档位：每档只问一次', () => {
  let budget = { ...defaultBudget(), total: 100, tiers: [50, 80, 100] }
  // 60% → 命中 50% 档
  const first = crossingTier(60, budget)
  assert.equal(first?.tier, '50%')
  budget = { ...budget, askedTiers: ['50%'] }
  assert.equal(crossingTier(60, budget), undefined, '同一档不重复问')
  // 85% → 命中 80% 档
  assert.equal(crossingTier(85, budget)?.tier, '80%')
  budget = { ...budget, askedTiers: ['50%', '80%'] }
  assert.equal(crossingTier(85, budget), undefined)
  // 120% → 命中 100% 档
  assert.equal(crossingTier(120, budget)?.tier, '100%')
})

test('超支三选一留痕，且绝不自动停（office 层）', () => {
  office.setBudget(call(), { total: 10, currency: 'CNY', tiers: [50, 100] })
  const budget = office.budget(call())
  assert.equal(budget?.total, 10)
  assert.deepEqual(budget?.tiers, [50, 100])

  const decided = office.decideBudget(call(), 'waive', '本轮先做完再评估')
  assert.equal(decided.decisions.length, 1)
  assert.equal(decided.decisions[0]?.choice, 'waive')
  const events = office.journalFor(workspace).read().events
  assert.equal(events.filter((event) => event.type === 'budget/decision').length, 1)
  assert.equal(events.filter((event) => event.type === 'cost/updated').length, 1)

  // 每档只问一次：记录已问档位后再算不重复
  office.markTierAsked(call(), '50%')
  office.markTierAsked(call(), '50%')
  assert.deepEqual(office.budget(call())?.askedTiers, ['50%'])
})

test('成本报告：用量不可得时如实说明，不编数据', () => {
  const unavailable = office.costReport(call(), { rows: [], available: false, note: '宿主没有 tokenMeter 服务' })
  assert.equal(unavailable.summary.totalTokens, 0)
  assert.equal(unavailable.summary.estimatedCost, undefined)
  assert.equal(unavailable.advice, undefined)

  const available = office.costReport(call(), { rows, available: true })
  assert.equal(available.summary.totalTokens, 1_000_000)
  assert.match(available.line, /已消耗/u)
})

test('状态块：只有设了预算才出现成本行，且没设 total 时不给百分比', () => {
  assert.equal(office.status(call()).costLine, undefined, '未设预算 → 状态块不出现成本行')
  office.setBudget(call(), {}) // 只启用"报消耗"形态
  const line = office.status(call()).costLine ?? ''
  assert.match(line, /已消耗|成本/u)
  assert.equal(/%|剩余/u.test(line), false, '未设 total → 不出现百分比/剩余')
  office.setBudget(call(), { total: 1 })
  assert.match(office.status(call()).costLine ?? '', /预算|剩余/u)
})
