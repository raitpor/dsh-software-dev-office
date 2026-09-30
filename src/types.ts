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

/**
 * 流程阶段 id。
 * ⚠️ **由流程数据决定**（设计 §7.1「流程即数据」）：瀑布是
 * `intake/feasibility/requirements/architecture/design-plan/construction/verification/delivery`，
 * 原型与敏捷各有自己的阶段序列与专属门禁（GP/GI/GR），因此这里是字符串而不是联合类型。
 */
export type Phase = string

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
    /**
     * 该需求是从**原型结论回填**而来（设计 §7.2：原型结束必须回填需求）。
     * 是设计示例 `source` 形状的小扩展（供 G7/GP 的"原型已回填"准则判定）。
     */
    prototype?: boolean | undefined
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
  /**
   * 该"假设"是否由**用户**授权。
   * 未授权的假设 = agent 自问自答：门禁仍按"未决"处理（见 `dor.isEffectivelyOpen`）。
   */
  authorizedByUser?: boolean | undefined
  askedAt: string | null
  answeredBy: string | null
  origin: QuestionOrigin
}

/** 阶段循环说明（设计 §7.1：`loop: {tool, action, until}`）。 */
export interface LoopSpec {
  tool: string
  action: string
  until: string
}

/** 流程里的一个阶段（设计 §7.1 的 phases 项）。 */
export interface PhaseDef {
  id: string
  /** 展示名（设计示例没有该字段，这里是便于展示的扩展） */
  name?: string | undefined
  role: string
  entry: string[]
  exit: string[]
  artifacts: string[]
  loop?: LoopSpec | undefined
}

/** 门禁准则定义（设计 §7.1 的 gates[].criteria 项）。 */
export interface GateCriterionDef {
  id: string
  /** 代码里的检查器键（src/domain/gates.ts 的 CHECKERS） */
  check: string
  desc?: string | undefined
}

/** 门禁定义。 */
export interface GateDef {
  id: string
  name: string
  criteria: GateCriterionDef[]
}

/** 流程定义（纯数据，NFR-005：新增流程不改代码）。 */
export interface ProcessDef {
  id: string
  name: string
  description: string
  phases: PhaseDef[]
  gates: GateDef[]
}

/** 一条准则的判定结果（设计 §7.3 的门禁结果对象）。 */
export interface GateCriterionResult {
  id: string
  ok: boolean
  detail: string
  remedy?: string | undefined
  /** 准则中文说明（来自流程定义数据文件；用户可见文案不摆 C-xx 编号） */
  desc?: string | undefined
}

/** 门禁判定结果（落 `.sdo/gates/<id>.json`）。 */
export interface GateEvaluation {
  gate: string
  phase: string
  status: GateStatus
  at: string
  criteria: GateCriterionResult[]
  remedy: string[]
}

/** TELOS 可行性评估（设计 §2.1 / §9.1 的 `sdo_feasibility`）。 */
export interface FeasibilityAssessment {
  id: string
  at: string
  by: string
  /** 五个维度：技术/经济/法律/运营/进度 */
  telos: Record<'technical' | 'economic' | 'legal' | 'operational' | 'schedule', { verdict: string; rationale: string }>
  /** Go / No-Go / Conditional */
  verdict: 'go' | 'no-go' | 'conditional'
  rationale: string
  /** PoC / 验证建议（高风险项） */
  poc: string[]
}

/** 风险条目（`.sdo/risks/RISK-*.yml`）。 */
export interface RiskItem {
  id: string
  title: string
  level: 'low' | 'medium' | 'high' | 'blocker'
  probability: 'low' | 'medium' | 'high'
  impact: string
  mitigation: string
  owner: string
  status: 'open' | 'mitigated' | 'closed'
  /** 来源（例如红队议题 id、需求 id） */
  origin?: string | undefined
  at: string
}

/** 红队议题（`.sdo/issues/REQ-ISSUE-*.yml`，设计 §5.4）。 */
export interface RedTeamIssue {
  id: string
  /** 归属需求 */
  target: string
  /** 覆盖的攻击角度（`redteam-*`） */
  angles: string[]
  /** 该议题衍生的质询问题 id */
  questionIds: string[]
  status: 'open' | 'closed'
  /** 处置方式：仍未处置 / 转为风险 / 回到需求 */
  disposition: 'none' | 'risk' | 'requirement'
  note: string
  at: string
}

/** 变更请求（`.sdo/changes/CR-*.yml`，设计 §5.5 CCB-lite）。 */
export interface ChangeRequest {
  id: string
  requirement: string
  reason: string
  /** 变更内容摘要（前后对比的人类可读描述） */
  changes: string[]
  /** 影响分析（追溯引擎给出；M2 前为空并注明） */
  impact: {
    design: string[]
    tasks: string[]
    tests: string[]
    note: string
  }
  decision: 'approved' | 'rejected' | 'deferred'
  decidedBy: string
  at: string
}

/** 架构视图的种类（设计 §6.1 的五视图）。 */
export const VIEW_KINDS = ['context', 'component', 'runtime', 'data', 'deployment'] as const
export type ViewKind = (typeof VIEW_KINDS)[number]

/** 视图里的一个设计元素（`DES-*`）。 */
export interface DesignElement {
  id: string
  name: string
  /** 元素类型：system / service / store / queue / external … 自由取值 */
  kind: string
  responsibility: string
  /** 它依赖的元素 id（用于契约完整性与追溯） */
  dependsOn: string[]
}

/** 一张架构视图（设计 §6.1）。 */
export interface DesignView {
  kind: ViewKind
  summary: string
  elements: DesignElement[]
  updatedAt: string
}

/** 架构决策记录（设计 §6.3）。 */
export interface Adr {
  id: string
  title: string
  status: 'proposed' | 'accepted' | 'superseded' | 'rejected'
  context: string
  decision: string
  alternatives: { option: string; pros: string; cons: string }[]
  consequences: string[]
  supersededBy?: string | undefined
  at: string
}

/** 质量属性场景（设计 §6.2）。 */
export interface QualityScenario {
  id: string
  /** 质量属性：性能/安全/可用性/可维护性/易用性… */
  attribute: string
  stimulus: string
  response: string
  /** 可测的度量（指标 + 条件 + 阈值） */
  measure: string
  priority: 'high' | 'medium' | 'low'
  /** 相关设计元素 id */
  targets: string[]
  at: string
}

/** ATAM-lite 评估结论（设计 §6.2）。 */
export interface QualityAssessment {
  at: string
  by: string
  /** 风险点：哪些场景在现有设计下可能不达标 */
  risks: string[]
  /** 敏感点：影响该场景的关键设计决策 */
  sensitivities: string[]
  /** 权衡点：为满足 A 而牺牲 B 的取舍 */
  tradeoffs: string[]
}

/** 接口契约（设计 §6.4，Schema-first）。 */
export interface Contract {
  id: string
  /** 已作废（口径踩坑/写错留下的记录）：**不参与覆盖判定**，但保留在真源里留痕 */
  dropped?: boolean | undefined
  droppedReason?: string | undefined
  name: string
  kind: 'http' | 'event' | 'rpc' | 'schema'
  producer: string
  consumer: string
  /** 契约正文（结构、字段、示例） */
  schema: string
  failureSemantics: {
    timeout: string
    retry: string
    idempotency: string
  }
  at: string
}

/** 追溯链接（`.sdo/trace/links.jsonl` 的一行，设计 §4.4 / §10.1b）。 */
export interface TraceLink {
  from: string
  to: string
  /** 边的语义：req→des、req→task、req→tc、des→task … */
  kind: string
  at: string
}

/** 追溯报告（覆盖率与孤儿检测）。 */
export interface TraceReport {
  total: number
  /** 每条需求的覆盖情况 */
  perRequirement: { id: string; design: string[]; tasks: string[]; tests: string[]; covered: boolean }[]
  orphans: {
    /** 没有任何 REQ 来源的 DES */
    design: string[]
    /** 没有任何 REQ 来源的 TASK */
    tasks: string[]
    /** 没有任何 REQ 来源的 TC */
    tests: string[]
  }
  /** must 需求里还没有测试用例的 */
  uncoveredMust: string[]
  coverage: number
}

/** 任务卡规模（设计 §8.6：一张卡至少是一个可独立验证的增量）。 */
export type TaskSize = 'small' | 'medium' | 'large'

/** 任务卡状态。 */
export type TaskStatus = 'planned' | 'ready' | 'in-progress' | 'blocked' | 'done' | 'verified' | 'dropped'

/** 证据项（设计 §9.1 的三档证据）。 */
export interface EvidenceItem {
  /** ① 命令+输出摘要 ② 产物路径+哈希 ③ workspace/changes 的 (sessionId, seq) */
  kind: 'command' | 'artifact' | 'workspace-changes'
  detail: string
  at: string
}

/** 任务卡（`.sdo/tasks/TASK-*.yml`，设计 §8.6）。 */
export interface TaskCard {
  id: string
  title: string
  goal: string
  /** 输入契约（要读什么） */
  inputs: string[]
  /** 输出契约（要产出什么） */
  outputs: string[]
  /** 完成定义（可判定） */
  dod: string[]
  /** 证据要求（最低档） */
  evidenceRequired: EvidenceItem['kind'][]
  /** 依赖的任务卡（DAG） */
  blockedBy: string[]
  /** 写范围（互斥用；相对工作区的路径前缀） */
  writeScopes: string[]
  /** 负责角色（§8.1 的 8 个角色） */
  role: string
  size: TaskSize
  /** 乐观并发版本：每次状态变更 +1（claim 走 CAS） */
  revision: number
  status: TaskStatus
  /** 当前 owner（子代理/teammate 名或 'cockpit'） */
  owner?: string | undefined
  /** 追溯：来源需求 */
  requirements: string[]
  /** 迭代号（敏捷/螺旋） */
  iteration?: number | undefined
  evidence: EvidenceItem[]
  blockedReason?: string | undefined
  createdAt: string
  updatedAt: string
}

/** 派发记录（`.sdo/dispatch/*.yml` 的投影形态；真源在 journal）。 */
export interface DispatchRecord {
  taskId: string
  backend: 'subagent' | 'native-team' | 'inline'
  owner: string
  at: string
  /** 降级原因（例如宿主机没有可用后端） */
  degradedReason?: string | undefined
}

/** 迭代（设计 §7.2 敏捷/螺旋）。 */
export interface Iteration {
  number: number
  goal: string
  status: 'planned' | 'active' | 'closed'
  startedAt: string
  closedAt?: string | undefined
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
  | 'redteam/propose'
  | 'redteam/model-proposed'
  | 'redteam/file'
  | 'issue/opened'
  | 'issue/closed'
  | 'feasibility/assessed'
  | 'risk/logged'
  | 'risk/updated'
  | 'change/requested'
  | 'change/decided'
  | 'tailoring/updated'
  | 'design/updated'
  | 'adr/recorded'
  | 'quality/recorded'
  | 'contract/recorded'
  | 'contract/updated'
  | 'contract/dropped'
  | 'trace/linked'
  | 'plan/mode'
  | 'plan/review-blocked'
  | 'task/dropped'
  | 'plan/review-approved'
  | 'plan/review-waived'
  | 'task/created'
  | 'task/updated'
  | 'task/claimed'
  | 'task/released'
  | 'task/done'
  | 'task/blocked'
  | 'dispatch/decided'
  | 'iteration/updated'
  | 'review/recorded'
  | 'test/recorded'
  | 'defect/recorded'
  | 'delivery/packaged'
  | 'cost/updated'
  | 'budget/decision'
  | 'gate/result'
  | 'evidence/recorded'
  | 'cost/sample'
  | 'budget/decision'
  | 'plan/review-blocked'
  | 'plan/review-approved'
  | 'plan/review-waived'
  | 'task/created'
  | 'task/updated'
  | 'task/claimed'
  | 'task/released'
  | 'task/done'
  | 'task/blocked'
  | 'dispatch/decided'
  | 'iteration/updated'
  | 'review/recorded'
  | 'test/recorded'
  | 'defect/recorded'
  | 'delivery/packaged'
  | 'cost/updated'
  | 'budget/decision'

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
