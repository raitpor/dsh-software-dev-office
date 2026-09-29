import assert from 'node:assert/strict'
import { test } from 'node:test'

import { detectBannedWords, loadScoring, meetsThreshold, ruleChannel, scoreRequirement } from '../src/domain/scoring.js'
import type { AcceptanceCriterion, Requirement } from '../src/types.js'

const model = loadScoring()

function draft(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: 'REQ-001',
    title: '示例',
    kind: 'functional',
    statement: '系统须在每日对账后识别出金额或状态不一致的记录',
    rationale: '人工核对成本高',
    source: { stakeholder: 'STK-01' },
    priority: 'must',
    ambiguity: { score: 0, dimensions: {}, open: [] },
    acceptance: [],
    status: 'draft',
    version: 0.1,
    baseline: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  }
}

const ac = (given: string, when: string, then: string): AcceptanceCriterion => ({ id: 'AC-001', given, when, then })

test('随包评分卡：八维等权、阈值 14/16、维度齐全', () => {
  assert.equal(model.threshold, 14)
  assert.equal(model.max, 16)
  assert.equal(model.requireNoZeroDimension, true)
  assert.deepEqual(Object.keys(model.dimensions).sort(), [
    'acceptance',
    'boundary',
    'constraint',
    'data',
    'goal',
    'interface',
    'scenario',
    'user',
  ])
  assert.deepEqual(model.severityWeight, { P0: 3, P1: 2, P2: 1 })
})

test('禁词：按维度命中（goal / constraint）', () => {
  const hits = detectBannedWords('系统要尽快上线，且必须稳定可靠', model)
  const words = hits.map((hit) => hit.word)
  assert.ok(words.includes('尽快'))
  assert.ok(words.includes('稳定'))
  assert.ok(words.includes('可靠'))
  assert.equal(hits.find((hit) => hit.word === '尽快')?.dimension, 'goal')
  assert.equal(hits.find((hit) => hit.word === '稳定')?.dimension, 'constraint')
})

test('规则通道：硬信号给出维度硬上限', () => {
  const vague = draft({ statement: '系统要尽快支持对账', rationale: '', source: {}, priority: undefined, acceptance: [] })
  const { caps, flags } = ruleChannel({ requirement: vague, model, context: { nonGoalsDeclared: false, hasSuccessMetrics: false } })
  assert.equal(caps.acceptance, 0, '无 AC → acceptance 硬 0')
  assert.equal(caps.user, 0, '无来源 → user 硬 0')
  assert.equal(caps.goal, 1, '无优先级 → goal ≤1')
  assert.equal(caps.boundary, 1, '无非目标 → boundary ≤1')
  assert.equal(caps.constraint, undefined, '「尽快」只压 goal，不压 constraint')
  assert.ok(flags.includes('no-ac') && flags.includes('no-source') && flags.includes('no-priority') && flags.includes('no-non-goal'))
  assert.ok(flags.includes('banned:尽快'))
})

test('规则通道：AC 不完整 → acceptance ≤1', () => {
  const partial = draft({ acceptance: [{ id: 'AC-001', given: 'g', when: '', then: 't' }] })
  const { caps, flags } = ruleChannel({ requirement: partial, model, context: { nonGoalsDeclared: true, hasSuccessMetrics: false } })
  assert.equal(caps.acceptance, 1)
  assert.ok(flags.includes('ac-incomplete'))
})

test('双通道：取更严者，并在不一致时标记 needsReview', () => {
  const requirement = draft({
    statement: '系统须在每日对账后识别出金额或状态不一致的记录，输出差异清单',
    acceptance: [ac('已导入 T 日与 T-1 日对账文件', '执行对账', '输出差异清单，含记录 ID 与差异类型')],
  })
  const strict = scoreRequirement({
    requirement,
    model,
    modelDimensions: { goal: 0, user: 0 },
    context: { nonGoalsDeclared: true, hasSuccessMetrics: false },
  })
  assert.equal(strict.ambiguity.dimensions.goal, 0)
  assert.equal(strict.ambiguity.needsReview, true, '模型分低于规则基线 → 标记复核')

  const generous = scoreRequirement({
    requirement,
    model,
    modelDimensions: { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 },
    context: { nonGoalsDeclared: true, hasSuccessMetrics: false },
  })
  assert.equal(generous.ambiguity.dimensions.boundary, 2, '没有硬上限时模型分生效')
  assert.equal(generous.ambiguity.needsReview, true, '与启发式基线不同 → 标记复核')

  // 硬上限优先于模型分：未声明非目标时，模型给 2 也只能得 1
  const capped = scoreRequirement({
    requirement,
    model,
    modelDimensions: { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 },
    context: { nonGoalsDeclared: false, hasSuccessMetrics: false },
  })
  assert.equal(capped.ambiguity.dimensions.boundary, 1, '硬上限必须压过模型分')
})

test('阈值：14/16 且不允许 0 分维度', () => {
  const good = scoreRequirement({
    requirement: draft({
      statement: '系统须在每日对账后识别金额或状态不一致的记录；QPS 峰值 200，P99 < 500 毫秒',
      acceptance: [ac('已导入两日对账文件', '执行对账', '输出差异清单')],
    }),
    model,
    modelDimensions: { goal: 2, user: 2, scenario: 2, data: 2, interface: 2, constraint: 2, acceptance: 2, boundary: 2 },
    context: { nonGoalsDeclared: true, hasSuccessMetrics: true },
  })
  assert.equal(good.ambiguity.score, 16)
  assert.equal(meetsThreshold(good.ambiguity, model).ok, true)

  const zeroDim = { score: 15, dimensions: { ...good.ambiguity.dimensions, data: 0 }, open: [] }
  const verdict = meetsThreshold(zeroDim, model)
  assert.equal(verdict.ok, false, '有 0 分维度即使总分 15 也不就绪')
  assert.deepEqual(verdict.zeroDimensions, ['data'])
})

test('E2E-01 的规则侧：含糊需求必然低于阈值', () => {
  const vague = scoreRequirement({
    requirement: draft({ statement: '系统要尽快支持对账', rationale: '人工太慢', source: {}, priority: undefined, acceptance: [] }),
    model,
    context: { nonGoalsDeclared: false, hasSuccessMetrics: false },
  })
  assert.ok(vague.ambiguity.score < model.threshold, `含糊需求得分 ${vague.ambiguity.score} 应低于阈值`)
  assert.equal(meetsThreshold(vague.ambiguity, model).ok, false)
})
