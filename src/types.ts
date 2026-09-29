/**
 * SDO 的领域类型（真源形状）——严格对齐设计正文的实体 YAML：
 *   · project：§4.4 `.sdo/project.json` 示例
 *   · requirement：§4.4 `.sdo/requirements/REQ-001.yml` 示例
 *   · question：§5.2.4 问题对象
 *   · 评分卡与禁词：§5.2.1 / §5.2.2；DoR：§5.2.5；门禁准则：§15.3
 */

/** 流程 ID（设计 §4.4 / §7.2）。 */
export const PROCESSES = ['waterfall', 'prototype', 'agile', 'spiral'] as const
export type ProcessId = (typeof PROCESSES)[number]

/** 项目规模档（设计 §7.5 / Q-03 / Q-15）。 */
export const SCALES = ['trivial', 'normal', 'critical'] as const
export type Scale = (typeof SCALES)[number]

/** 需求优先级（MoSCoW）。 */
export const PRIORITIES = ['must', 'should', 'could', 'wont'] as const
export type Priority = (typeof PRIORITIES)[number]

/** 需求类型（设计 §4.4：functional | quality | constraint）。 */
export const REQUIREMENT_KINDS = ['functional', 'quality', 'constraint'] as const
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]

/** 需求生命周期状态（设计 §4.4）。 */
export const REQUIREMENT_STATUSES = ['draft', 'grilled', 'baselined', 'changed', 'dropped'] as const
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number]

/** 八维歧义评分卡的维度键（设计 §5.2.1）。 */
export const DIMENSIONS = [
  'goal',
  'user',
  'scenario',
  'data',
  'interface',
  'constraint',
  'acceptance',
  'boundary',
] as const
export type Dimension = (typeof DIMENSIONS)[number]

/** 问题严重度（设计 §5.2.4：P0 阻塞基线 | P1 影响设计 | P2 改善）。 */
export const SEVERITIES = ['P0', 'P1', 'P2'] as const
export type Severity = (typeof SEVERITIES)[number]

/** 问题状态（设计 §5.2.4）。 */
export const QUESTION_STATUSES = ['open', 'answered', 'assumed', 'obsolete'] as const
export type QuestionStatus = (typeof QUESTION_STATUSES)[number]

/** 问题来源：问题库 | 禁词强制量化 | 红队攻击。 */
export type QuestionOrigin = 'bank' | 'banned-word' | 'red-team'

/** 流程阶段（设计 §7.1 的瀑布主干；敏捷/原型由流程数据裁剪）。 */
export const PHASES = [
  'intake',
  'feasibility',
  'requirements',
  'architecture',
  'design',
  'construction',
  'verification',
  'delivery',
] as const
export type Phase = (typeof PHASES)[number]

/** 门禁判定结果。 */
export type GateStatus = 'passed' | 'failed' | 'waived'

/** 裁剪记录（设计 §7.5 / AC-003）。 */
export interface Tailoring {
  scale: Scale
  waivedGates: string[]
  reason: string
  approver: string
  at: string
}

/** 红队开关状态：会话内可停用/重开，需留痕（设计 Q-03 / Q-15 / AC-017）。 */
export interface RedTeamState {
  enabled: boolean
  scope: 'session'
  reason?: string | undefined
  at?: string | undefined
}

/** 干系人（设计 §4.4：`{id, role, concerns}`）。 */
export interface Stakeholder {
  id: string
  role: string
  concerns: string[]
}

/** 阶段历史（设计 §4.4：`{phase, entered, exited}`）。 */
export interface PhaseRecord {
  phase: Phase
  entered: string
  exited?: string | undefined
}

/** 项目台账（`.sdo/project.json`，由 journal 折叠得到）。 */
export interface SdoProject {
  id: string
  name: string
  created: string
  process: ProcessId
  phase: Phase
  phaseHistory: PhaseRecord[]
  scope: {
    in: string[]
    out: string[]
  }
  stakeholders: Stakeholder[]
  glossary: Record<string, string>
  metrics: {
    success: string[]
    guardrail: string[]
  }
  tailoring?: Tailoring | undefined
  redTeam?: RedTeamState | undefined
}

/** 验收标准：Given/When/Then（设计 §4.4）。 */
export interface AcceptanceCriterion {
  id: string
  given: string
  when: string
  then: string
}

/** 歧义评分（设计 §4.4 / §5.2.1）。 */
export interface Ambiguity {
  /** 0..16，越低越含糊 */
  score: number
  dimensions: Partial<Record<Dimension, number>>
  /** 未决问题 id */
  open: string[]
  /** 双通道（规则/模型）判分不一致时为 true */
  needsReview?: boolean | undefined
}

/** 需求条目（`.sdo/requirements/REQ-*.yml` 的 `requirement` 字段）。 */
export interface Requirement {
  id: string
  title: string
  kind: RequirementKind
  statement: string
  rationale: string
  source: {
    stakeholder?: string | undefined
    raw?: string | undefined
  }
  /** DoR 要求必须给出；未给出即视为未就绪 */
  priority?: Priority | undefined
  ambiguity: Ambiguity
  acceptance: AcceptanceCriterion[]
  status: RequirementStatus
  version: number
  baseline?: {
    at: string
    by: string
    evidence: string
  } | null | undefined
  createdAt: string
  updatedAt: string
}

/** 问题的一个选项及其代价（设计 §5.2.4）。 */
export interface GrillOption {
  label: string
  cost: string
}

/** 审讯问题（`.sdo/questions/Q-*.yml` 的 `question` 字段）。 */
export interface GrillQuestion {
  id: string
  /**
   * 问题正文。
   * ⚠️ 设计 §5.2.4 的示例字段里没有它（只有 why／consequence），但问题必须能被问出来，
   * 因此这里作为**必要扩展**保留（已登记为任务计划 §9 的 D-03）。
   */
  text: string
  targets: string[]
  dimension: Dimension
  severity: Severity
  /** 为什么问（影响哪条 REQ / 哪个决策） */
  why: string
  /** 不问的后果 */
  consequenceIfUnasked: string
  options: GrillOption[]
  defaultRecommendation: string
  answer: string | null
  status: QuestionStatus
  askedAt: string | null
  answeredBy: string | null
  origin: QuestionOrigin
}

/** journal 事件类型（真源的唯一写入形态）。 */
export type SdoEventType =
  | 'project/created'
  | 'project/updated'
  | 'phase/entered'
  | 'phase/exited'
  | 'requirement/captured'
  | 'requirement/updated'
  | 'requirement/baselined'
  | 'question/asked'
  | 'question/answered'
  | 'redteam/mode'
  | 'redteam/attack'
  | 'gate/result'
  | 'evidence/recorded'
  | 'cost/sample'
  | 'budget/decision'
  | 'plan/review-blocked'

/** journal 中的一条事件。 */
export interface JournalEvent {
  seq: number
  at: string
  actor: string
  type: SdoEventType
  data: Record<string, unknown>
}

/** 读取 journal 的结果（含损坏尾部信息）。 */
export interface JournalReadResult {
  events: JournalEvent[]
  truncated: boolean
  badLine?: number | undefined
}
