/**
 * 八维歧义评分卡（设计 §5.2.1 / §5.2.2）。
 *
 * 双通道：
 *   · **规则通道**（确定性）：硬信号 → 维度**硬上限**（禁词、缺 AC、无来源、无优先级、无非目标），
 *     以及每个维度的启发式基线分（关键词证据，完全可复现）。
 *   · **模型通道**（语义）：调用方（模型）可给出每个维度的 0/1/2 判分。
 *   两者不一致时**取更严者**（维度分 = min(基线, 硬上限, 模型分)）并标 `needsReview`。
 *
 * 权重固定：八维等权、阈值 14/16、且**任何维度为 0 即不就绪**——全部来自随包
 * `src/data/scoring.yml`，项目改不动（Q-02）。
 */
import { loadPackagedYaml } from '../infra/data.js'
import { DIMENSIONS } from '../types.js'
import type { AcceptanceCriterion, Ambiguity, Dimension, Requirement, Severity } from '../types.js'

/** 评分卡模型（随包数据）。 */
export interface ScoringModel {
  threshold: number
  max: number
  requireNoZeroDimension: boolean
  dimensions: Record<Dimension, { label: string; two: string; one: string; zero: string }>
  bannedWords: { goal: string[]; constraint: string[] }
  severityWeight: Record<Severity, number>
}

/** 读取随包评分卡（带缓存；缺失即抛错——门禁刻度不能被静默替换）。 */
export function loadScoring(): ScoringModel {
  const raw = loadPackagedYaml<ScoringModel>('src/data/scoring.yml')
  for (const dimension of DIMENSIONS) {
    if (raw.dimensions?.[dimension] === undefined) {
      throw new Error(`sdo: scoring.yml 缺少维度 ${dimension}`)
    }
  }
  return raw
}

/** 命中的禁词。 */
export interface BannedWordHit {
  word: string
  dimension: Dimension
}

/** 扫描文本里的禁词（返回命中的词与它攻击的维度）。 */
export function detectBannedWords(text: string, model: ScoringModel): BannedWordHit[] {
  const hits: BannedWordHit[] = []
  for (const [dimension, words] of Object.entries(model.bannedWords) as [Dimension, string[]][]) {
    for (const word of words) {
      if (text.includes(word)) hits.push({ word, dimension })
    }
  }
  return hits
}

/** 评分输入。 */
export interface ScoreInput {
  requirement: Pick<Requirement, 'statement' | 'rationale' | 'acceptance' | 'source' | 'priority'>
  model: ScoringModel
  /** 模型通道的语义判分（可选） */
  modelDimensions?: Partial<Record<Dimension, number>> | undefined
  context: {
    /** 项目是否已声明非目标（`scope.out` 非空） */
    nonGoalsDeclared: boolean
    /** 项目是否已给出成功度量 */
    hasSuccessMetrics: boolean
  }
}

/** 评分结果。 */
export interface ScoreResult {
  ambiguity: Ambiguity
  /** 硬信号标记（人可读） */
  flags: string[]
  /** 每个维度实际生效的硬上限 */
  caps: Partial<Record<Dimension, number>>
  /** 规则通道给出的基线分（未经模型通道） */
  base: Record<Dimension, number>
}

const KEYWORDS = {
  measurable: /\d/u,
  role: /权限|可见|角色|干系人|用户/u,
  scenario: /流程|步骤|状态|迁移|异常|重试|降级|阻断/u,
  data: /数据|字段|记录|实体|生命周期|删除|归档|去重|幂等键/u,
  iface: /接口|调用|协议|上游|下游|对接|集成|超时|幂等/u,
  constraint: /毫秒|秒|分钟|QPS|吞吐|峰值|并发|容量|可用性|准确率|覆盖率|P5|P9|分位/u,
  boundary: /非目标|不做|降级|回退|回滚|例外|极端|上限|兜底/u,
} as const

function countMatches(text: string, pattern: RegExp): number {
  const matched = text.match(new RegExp(pattern.source, 'gu'))
  return matched === null ? 0 : matched.length
}

function acceptanceComplete(criteria: AcceptanceCriterion[]): boolean {
  return criteria.length > 0 && criteria.every((ac) => ac.given !== '' && ac.when !== '' && ac.then !== '')
}

/**
 * 规则通道：硬上限 + 启发式基线。
 * 基线只用**文本证据**（关键词 + 结构化字段），因此完全可复现。
 */
export function ruleChannel(input: ScoreInput): { caps: Partial<Record<Dimension, number>>; base: Record<Dimension, number>; flags: string[] } {
  const { requirement, model, context } = input
  const text = `${requirement.statement}\n${requirement.rationale}\n${requirement.acceptance
    .map((ac) => `${ac.given} ${ac.when} ${ac.then}`)
    .join('\n')}`
  const caps: Partial<Record<Dimension, number>> = {}
  const flags: string[] = []

  // —— 硬信号：禁词（设计 §5.2.2：命中即生成强制量化待问项并扣分）——
  for (const hit of detectBannedWords(text, model)) {
    const current = caps[hit.dimension]
    caps[hit.dimension] = current === undefined ? 1 : Math.min(current, 1)
    flags.push(`banned:${hit.word}`)
  }

  // —— 硬信号：验收标准 ——
  if (requirement.acceptance.length === 0) {
    caps.acceptance = 0
    flags.push('no-ac')
  } else if (!acceptanceComplete(requirement.acceptance)) {
    caps.acceptance = Math.min(caps.acceptance ?? 2, 1)
    flags.push('ac-incomplete')
  }

  // —— 硬信号：来源 / 优先级 / 非目标 ——
  if (requirement.source.stakeholder === undefined && (requirement.source.raw ?? '') === '') {
    caps.user = 0
    flags.push('no-source')
  }
  if (requirement.priority === undefined) {
    caps.goal = Math.min(caps.goal ?? 2, 1)
    flags.push('no-priority')
  }
  if (!context.nonGoalsDeclared) {
    caps.boundary = Math.min(caps.boundary ?? 2, 1)
    flags.push('no-non-goal')
  }

  // —— 启发式基线 ——
  const measurable = KEYWORDS.measurable.test(text) || context.hasSuccessMetrics
  const base: Record<Dimension, number> = {
    goal: measurable ? 2 : requirement.rationale.trim() !== '' || requirement.statement.length >= 12 ? 1 : 0,
    user:
      requirement.source.stakeholder !== undefined && KEYWORDS.role.test(text)
        ? 2
        : KEYWORDS.role.test(text) || requirement.source.stakeholder !== undefined || (requirement.source.raw ?? '') !== ''
          ? 1
          : 0,
    scenario:
      countMatches(text, KEYWORDS.scenario) >= 2 || (countMatches(text, KEYWORDS.scenario) >= 1 && requirement.acceptance.length >= 2)
        ? 2
        : requirement.statement.length >= 20
          ? 1
          : 0,
    data: countMatches(text, KEYWORDS.data) >= 2 ? 2 : countMatches(text, KEYWORDS.data) === 1 ? 1 : 0,
    interface: countMatches(text, KEYWORDS.iface) >= 2 ? 2 : countMatches(text, KEYWORDS.iface) === 1 ? 1 : 0,
    constraint: measurable && KEYWORDS.constraint.test(text) ? 2 : KEYWORDS.constraint.test(text) ? 1 : 0,
    acceptance: acceptanceComplete(requirement.acceptance) ? 2 : requirement.acceptance.length > 0 ? 1 : 0,
    boundary: context.nonGoalsDeclared && KEYWORDS.boundary.test(text) ? 2 : context.nonGoalsDeclared ? 1 : 0,
  }

  return { caps, base, flags }
}

/** 计算一条需求的歧义评分（双通道取更严者）。 */
export function scoreRequirement(input: ScoreInput): ScoreResult {
  const { caps, base, flags } = ruleChannel(input)
  const dimensions: Partial<Record<Dimension, number>> = {}
  let needsReview = false

  for (const dimension of DIMENSIONS) {
    const cap = caps[dimension]
    const modelScore = input.modelDimensions?.[dimension]
    // 语义分由模型通道给；没给才用启发式基线。**硬上限对两者都生效**（规则通道是天花板）。
    let value = modelScore === undefined ? (base[dimension] ?? 0) : modelScore
    if (cap !== undefined) value = Math.min(value, cap)
    value = Math.max(0, Math.min(2, Math.round(value)))
    dimensions[dimension] = value
    if (modelScore !== undefined && modelScore !== base[dimension]) needsReview = true
  }

  const score = DIMENSIONS.reduce((sum, dimension) => sum + (dimensions[dimension] ?? 0), 0)
  const ambiguity: Ambiguity = { score, dimensions, open: [] }
  if (needsReview) ambiguity.needsReview = true
  return { ambiguity, flags: [...new Set(flags)], caps, base }
}

/** 该评分是否达到 DoR 阈值（并满足"无 0 分维度"）。 */
export function meetsThreshold(ambiguity: Ambiguity, model: ScoringModel): { ok: boolean; zeroDimensions: Dimension[] } {
  const zeroDimensions = DIMENSIONS.filter((dimension) => (ambiguity.dimensions[dimension] ?? 0) === 0)
  const ok =
    ambiguity.score >= model.threshold && (!model.requireNoZeroDimension || zeroDimensions.length === 0)
  return { ok, zeroDimensions }
}

/** 最弱的若干维度（用于选择审讯问题）。 */
export function weakestDimensions(ambiguity: Ambiguity, limit = 3): Dimension[] {
  return [...DIMENSIONS]
    .sort((a, b) => (ambiguity.dimensions[a] ?? 0) - (ambiguity.dimensions[b] ?? 0) || a.localeCompare(b))
    .slice(0, limit)
}
