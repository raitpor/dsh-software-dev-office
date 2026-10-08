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

/**
 * 需求类型（设计 §4.4：functional | quality | constraint）。
 *
 * `ui`（增量 1 / §2.1）：**「含 UI」判定的需求侧真源** —— 任一条需求声明
 * 界面/页面面时，界面视图才进入门禁。它不是另一种需求写法，而是一个显式声明：
 * "这条需求交付的东西里有给人看的界面/页面"。
 */
export const REQUIREMENT_KINDS = ['functional', 'quality', 'constraint', 'ui'] as const
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number]

/** 项目级界面面（§2.1 的项目侧真源：web / desktop / mobile）。 */
export const SURFACES = ['web', 'desktop', 'mobile'] as const
export type Surface = (typeof SURFACES)[number]

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

/** 问题来源：问题库 | 禁词强制量化 | 红队攻击 | 设计缺口（增量 1）。 */
export type QuestionOrigin = 'bank' | 'banned-word' | 'red-team' | 'design' | 'requirements'

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
  /** 该阶段因**回退**而结束时，退回到哪个阶段（§6.1） */
  rolledBackTo?: string | undefined
  /** 回退原因（§6.1：回退必须有 reason，写清发现了什么需求缺口） */
  rollbackReason?: string | undefined
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
  /**
   * 项目级界面面声明（§2.1）：在 G0/G2 由用户选定，取值 `web` / `desktop` / `mobile`。
   * 「含 UI」判定 = 任一需求 `kind: ui` **或** 本字段含三个值之一。
   * 老项目没有这个字段（`undefined`）——判定时按空数组处理，不报错。
   */
  surfaces?: string[] | undefined
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
  /**
   * **模型通道**当时给出的语义分（§6.7）。
   *
   * 为什么必须落盘：`dimensions` 是"规则基线 / 硬上限 / 模型分"三者取严后的**合成值**，
   * 单看它已经分不出哪些维度是模型给的。而变更控制（`sdo_requirement action=change`）
   * 重算评分时只能**重算规则维度**、**沿用模型维度** —— 没有这份原始输入，
   * 语义分会在变更时被规则通道抹掉（实测 15 → 9，`data`/`interface` 归零），
   * 于是"变更 → 重新基线"被 C1 误拦。
   */
  modelDimensions?: Partial<Record<Dimension, number>> | undefined
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
  /**
   * 这条"建议"的**理由**（F-6）。
   *
   * 有 `recommendationFromModel === true` 时它是模型基于需求给出的分析；
   * 否则它是插件的兜底建议理由 —— 回执必须**显式标注**，不能让兜底理由冒充分析结论。
   */
  recommendationRationale?: string | undefined
  /** `recommendationRationale` 是否来自模型（false/缺 = 插件兜底，回执要警示） */
  recommendationFromModel?: boolean | undefined
  /**
   * 该题在**既有决策**（ADR）里已有定案时，记下那条 ADR 的 id（F-5）。
   *
   * 有值 = 这题降级为"确认项"：题面与回执都写「已有决策：ADR-xxx（本次仅确认，如要改请说明）」，
   * 不再是开放题。答/不答的口径不变（门禁仍要求它被回答），只是不再假装这是新决策。
   */
  decidedBy?: string | undefined
  answer: string | null
  /**
   * **D-1（sdo-test-new 2026-10-08，major）**：用户实际选中项的**结构化留痕**。
   *
   * 真机症状：`answer` 正文与「（选择：…）」互相矛盾（正文是题库第 2 项，括号里是第 0 项）——
   * 因为模型把题目转述给用户时**会重排/改写选项**，而 `pickedOption` 的下标绑的是**插件自己的**
   * `options` 表。只把两者拼成一句话写进 `answer`，事后无法复原"用户到底选了什么"。
   * 因此下标与标签**各记一份**（标签按插件表解析 = 台账可复算的那一份；正文仍是模型写的自由文本）。
   */
  pickedOption?: number | undefined
  /** 与 `pickedOption` 同一份记录的**选项标签**（按插件 `options` 表解析）。 */
  pickedLabel?: string | undefined
  /**
   * **D-2 残留（sdo-test-new 2026-10-08 复测）**：这条问题与项目**声明的非目标**（`scope.out`）撞了，
   * 这里记下撞上的那个词（如「鉴权」）。
   *
   * 真机：`scope.out` 明写「鉴权与多用户」，`grill` 却仍生成 4 条「谁不能看到这些数据？」。
   * 口径选择：**不静默跳过**（"问的是非目标"不等于"这条问题没有价值"——非目标也可能需要确认），
   * 而是把冲突**记进真源并在回执里点名**，由人来决定答/降级为假设/作废。
   */
  nonGoalConflict?: string | undefined
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
  /**
   * **合法回退边**（§6.1）：`from 阶段 → 允许退回的阶段`。
   *
   * 回退边**按流程数据声明**，不硬编码 —— 新增流程只要在 YAML 里写 `rollback:` 即可。
   * 设计阶段发现需求缺口时只允许沿这里声明的边走（不允许任意跳阶段）。
   */
  rollback?: Record<string, string[]> | undefined
}

/** 一条准则的判定结果（设计 §7.3 的门禁结果对象）。 */
export interface GateCriterionResult {
  id: string
  ok: boolean
  detail: string
  remedy?: string | undefined
  /** 准则中文说明（来自流程定义数据文件；用户可见文案不摆 C-xx 编号） */
  desc?: string | undefined
  /**
   * **不适用（N/A）**：准则对该项目根本没有意义（例如项目不含 UI 时的 `ui.confirmed`）。
   *
   * 三态语义（增量 1 / §2.1）：
   *   · `ok: true`       → 通过；
   *   · `ok: false`      → 失败（门禁因此不放行）；
   *   · `na: true`       → **不适用**：既不算失败，也不算通过 —— 回执必须显式打印 N/A 与理由。
   * 门禁整体判定里 N/A 按"不阻止放行"处理（它不可能失败），但**绝不**计入"通过数"，
   * 否则"没做"会被读成"做对了"。
   */
  na?: boolean | undefined
  /** N/A 的理由（`na: true` 时必填，回执要如实显示） */
  naReason?: string | undefined
  /**
   * **判据通过、但必须出声的告警**（R-22，sdo-test-new 2026-10-08）：
   * 交付门禁现算出的 `deliveryCompleteness().warnings`（如「带已知偏差通过 3 条：…」）过去被**丢掉** ——
   * 于是"带 3 条偏差通过"的门禁回执与"干净通过"长得**一模一样**，而 R-15 的原始动机正是"不许长得一样"。
   * 判据口径不变（仍然通过），只是回执要把这些话印出来。
   */
  warnings?: string[] | undefined
}

/** 门禁判定结果（落 `.sdo/gates/<id>.json`）。 */
export interface GateEvaluation {
  gate: string
  phase: string
  status: GateStatus
  at: string
  criteria: GateCriterionResult[]
  remedy: string[]
  /**
   * **R-14**：`true` = 判据**没有逐条判定**（读真源失败，`criteria` 里只有一条 `gate.unreadable`）。
   *
   * 有它时 `failed` 里的 id 不是流程数据里声明的判据 —— 审计必须据此分辨"查不动"与"判不过"，
   * 看板/回执也不能把它当成"13 条判据里挂了 1 条"。
   */
  unjudged?: boolean | undefined
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

/**
 * 批准的变更触发的**阶段回退结果**（语义 A，2026-10-04）。
 *
 * 「需求变更后必须重走需求 → 设计」由两半承担：① 阶段被拉回需求阶段（本结构描述这一半）；
 * ② 未消化期间 `claim` 被拒（`change-not-digested`）。因此回执**不能只报"已回退"** ——
 * 那会让用户以为"回到需求阶段"就够了，而真正决定能不能继续开发的是第 ② 半。
 */
export interface ChangeRollback {
  from: string
  to: string
  /** 被作废（回来必须重新通过）的门禁判定留痕 */
  invalidatedGates: string[]
  /** 其中**仍处于豁免状态**的（豁免是用户的显式决定，回退不撤销它） */
  stillWaivedGates: string[]
  /** 当前已经在目标阶段：没有可回退的边，也不需要回退 */
  alreadyThere: boolean
  /** 回退没做成的原因（没有合法回退边等）—— 如实回报，不静默 */
  error?: string | undefined
}

/** 架构视图的种类（设计 §6.1 的五视图）。 */
export const VIEW_KINDS = ['context', 'component', 'runtime', 'data', 'deployment'] as const
export type ViewKind = (typeof VIEW_KINDS)[number]

/**
 * 设计**适用性声明**里合法的视图取值 = 五视图 + **界面视图** `ui`（本版正式引入的第 6 个视图）。
 *
 * 为什么不直接把 `ui` 并进 `VIEW_KINDS`：`VIEW_KINDS` 是「五视图齐备」（C-20）与设计元素
 * 落盘的对齐依据；界面视图成立与否由 `uiDecision`（需求真源）与 C-27 现算，它不是一个"元素视图"。
 * 但**声明层面必须接受 `ui`** —— 否则调用方写它会被静默丢弃（F-8 正是如此）。
 */
export const APPLICABILITY_VIEW_KINDS = [...VIEW_KINDS, 'ui'] as const
export type ApplicabilityViewKind = (typeof APPLICABILITY_VIEW_KINDS)[number]

/** 视图里的一个设计元素（`DES-*`）。 */
export interface DesignElement {
  id: string
  name: string
  /** 元素类型：system / service / store / queue / external … 自由取值 */
  kind: string
  responsibility: string
  /** 它依赖的元素 id（用于契约完整性与追溯） */
  dependsOn: string[]
  /** 追溯到的需求 id（草稿里用来标"来源需求"，也是置信度的依据） */
  requires?: string[] | undefined
  /** 设计置信度：high（有需求来源）/ medium（有依据但待确认）/ low（agent 推测，必须重看） */
  confidence?: 'high' | 'medium' | 'low' | undefined
}

/** 一张架构视图（设计 §6.1）。 */
export interface DesignView {
  kind: ViewKind
  summary: string
  elements: DesignElement[]
  updatedAt: string
}

/**
 * 界面视图（增量 1 / §2「第 6 个视图」）。
 *
 * 存法：`.sdo/design/ui.yml`，**不复用 `DesignView`** —— 界面维度是
 * 风格 + 页面栏目 + 布局 + 响应式 + 无障碍，硬塞进 `elements` 会把门禁判据做成假的。
 */
export interface UiStyle {
  source: UiStyleSource
  tokens: Record<string, string>
  rationale: string
}

/**
 * 界面风格来源的合法取值（**唯一定义处**）。
 *
 * 边界（工具面 `ui` JSON / 命令面）与类型都从这一个常量推导 —— 否则
 * 「schema 声明一套、handler 认另一套」又会脱节（F-7 的同类病根）。
 */
export const UI_STYLE_SOURCES = ['follow-host', 'minimal', 'enterprise', 'custom'] as const
export type UiStyleSource = (typeof UI_STYLE_SOURCES)[number]

/** 一页的栏目定义。 */
export interface UiColumn {
  name: string
  kind: string
  /**
   * **F-2**：栏目所属的布局区域（必须是 `layout.regions` 里的一个名字）。
   *
   * 不声明时线框图只能按"数量均分"猜 —— 那个猜测在「区域数 ≠ 栏目数」的屏上必然错
   * （实测：5 栏 3 区会把表单字段放进页头；7 栏 7 区整体错位一格）。声明了就以声明为准。
   */
  region?: string | undefined
}

/** 一页布局区域的堆叠方向（F-15）。 */
export const UI_STACK_DIRECTIONS = ['vertical', 'horizontal'] as const
export type UiStackDirection = (typeof UI_STACK_DIRECTIONS)[number]

/**
 * 一页的布局定义。
 *
 * F-15：`grid` 是**自由文本**（例如「单列纵向堆叠：每个功能块一个 panel，宽度 100%」），
 * 线框图无法（也不该）去猜它的语义 —— 此前一律按横向并排画，与声明相反、会误导审阅者。
 * 因此新增**显式**的 {@link UiLayout.stack}：`vertical` / `horizontal`；
 * **缺省按 `vertical` 渲染**，并在图旁注明方向来源（声明 / 缺省）。
 */
export interface UiLayout {
  grid: string
  regions: string[]
  /** 区域堆叠方向（可选；缺省 = vertical，线框图会注明"缺省"） */
  stack?: UiStackDirection | undefined
}

/** 一个页面（`SCR-*`）。 */
export interface UiScreen {
  id: string
  name: string
  columns: UiColumn[]
  layout: UiLayout
  interactions: string[]
  states: Record<string, string>
  /** 该页面对应的需求 id（追溯孤儿检查会抓） */
  requires: string[]
}

/** 响应式断点。 */
export interface UiBreakpoint {
  name: string
  width: string
  changes: string[]
}

/** 无障碍要求。 */
export interface UiAccessibility {
  contrast: string
  keyboard: boolean
  screenReader: string
}

/** 界面视图台账（`.sdo/design/ui.yml`）。 */
export interface UiView {
  id: string
  style: UiStyle
  screens: UiScreen[]
  breakpoints: UiBreakpoint[]
  accessibility: UiAccessibility
  updatedAt: string
}

/**
 * 设计确认戳（`.sdo/design/confirmed.yml`）——**用户确认**的唯一真源。
 * `target` 是元素/契约/界面条目 id（`DES-*` / `CT-*` / `UI-*` / `SCR-*:columns` / `SCR-*:layout`）。
 */
export interface DesignConfirmation {
  target: string
  /** 确认依据（用户的原话或批注） */
  basis: string
  /**
   * **SDO-48**：这一戳是**用户本人**确认的，还是**别人代盖**的（`proxy`）。
   * 真机上流程官授权架构师代盖，工具却把 basis 强制写成「用户在会话中确认」，而 journal 追加式**不可改写**
   * ⇒ 真源里永久留下与事实相反的措辞。现在代盖必须自报 `basisSource=proxy`，事件里可辨。
   */
  basisSource?: 'user' | 'proxy' | undefined
  by: string
  at: string
  /**
   * **被确认内容的指纹**（F-19）：确认时该 target 内容的规范化哈希。
   *
   * 为什么必须有：此前确认戳只按 `target` 记账，**改内容后旧戳仍算"已确认"** ——
   * 用户确认的是 A 版本、门禁背书的是 B 版本，"用户确认过"在内容层面不成立。
   * 现在 `C-24`/`C-27` 校验「当前内容指纹 == 确认时的指纹」，不符即判红并要求重新确认
   * （与门禁签字按 journal 序号失效是同一套「背书绑定真源」机制）。
   *
   * 缺省（旧数据）视为**未绑定**：内容可解析时一律判"需重新确认"，绝不静默背书。
   */
  contentHash?: string | undefined
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
  /** 该契约对应的需求 id（界面/草稿与追溯用） */
  requires?: string[] | undefined
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
  /** 解析不出来的坏行数（N-3：>0 时覆盖率/孤儿判据必须判红，不得静默） */
  badLines: number
  /** 非空行总数（回执里与 `total` 一起给出，让"少了几条"看得见） */
  totalLines: number
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
  /**
   * `command` 证据的退出码（A1，可选）：给了就必须为 0，否则不作为完成证据。
   * 不给也不判红 —— 没有可机械判定的输出格式约定，硬编只会逼人编造。
   */
  exitCode?: number | undefined
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

// —————————————————————— 增量 2：设计方法论方法包（结构化 / 面向对象 / 敏捷-演进式） ——————————————————————

/**
 * 方法包标识（规格 §1 / §2）。**取值固定为这三个**：
 *   · `structured`   结构化（数据字典 + 分层 DFD + ERD）
 *   · `oo`           面向对象（类与职责 + 时序 + 依赖规则）
 *   · `evolutionary` 敏捷-演进式（技术债 + 可逆性分级 + 迭代增量）
 */
export const METHOD_IDS = ['structured', 'oo', 'evolutionary', 'porting'] as const
export type MethodId = (typeof METHOD_IDS)[number]

/** 选择题的可选值：四个方法包 + 显式的「不做方法产物」（`none`）。 */
export const METHOD_CHOICES = ['structured', 'oo', 'evolutionary', 'porting', 'none'] as const
export type MethodChoice = (typeof METHOD_CHOICES)[number]

/** 方法产物的种类（一个种类一个文件：`.sdo/design/method-<kind>.yml`）。 */
export const METHOD_ARTIFACT_KINDS = [
  'dictionary',
  'dfd',
  'erd',
  'classes',
  'sequences',
  'layers',
  'debt',
  'reversibility',
  'increments',
  // `porting` 包的三类最小必产项（§7.3）：旧→新映射 / 不变量清单 / 差分验证策略
  'mapping',
  'invariants',
  'diffVerify',
] as const
export type MethodArtifactKind = (typeof METHOD_ARTIFACT_KINDS)[number]

/**
 * **工具动作清单的单点定义**（F-17 / F-18）。
 *
 * 为什么必须单点：同一份「这个工具支持哪些 action」以前散在**三处**——
 *   ① 工具 JSON schema 的 `action.description`（模型据此决定怎么调）；
 *   ② handler 里的 `case '…'` / `if (action === '…')` 分支；
 *   ③ 「未知 action」报错回执里的「可用：…」列表。
 * 三处各错一边（实测）：`sdo_requirement` 的 schema 漏 `change`、报错列表漏
 * `design-questions`/`applicability`/`applicability-confirm`；`sdo_gate` 的 schema 与
 * 报错列表都漏 `sign`/`rollback`；`sdo_design` 的报错列表只列 3 个（实现有 13 个）。
 *
 * 现在三处都读这里：schema 用 {@link actionList} 生成描述，报错回执把清单原文
 * （`常量.join(' | ')`）作为 `{p2}` 传入，`test/m17.test.ts` 的守卫再从**编译产物**里
 * 静态核对「分支集合 == 常量集合」。
 */
export const PROJECT_ACTIONS = ['update', 'show'] as const
export const COST_ACTIONS = ['report'] as const
export const PLAN_ACTIONS = ['decompose', 'iteration', 'next', 'profile'] as const

/**
 * **实现阶段方法包**（增量 3）：词表集中在这里，落盘与判据只引用这些常量。
 *
 * MVP 只实现 `tdd` 与 `contract-first`（两者都有可现算的硬检查）；
 * `small-batch`/`hardened-critical` 已在词表里，属阶段 2。
 */
export const CONSTRUCTION_PACKAGES = ['tdd', 'contract-first', 'small-batch', 'hardened-critical'] as const
export type ConstructionPackage = (typeof CONSTRUCTION_PACKAGES)[number]

/** 实现阶段方法包的检查码：回执与判据用它做稳定标识（文案在语言包里）。 */
export const CONSTRUCTION_CHECKS = [
  'construction-profile-missing',
  'contract-not-frozen',
  'tdd-red-green-missing',
  'tdd-result-untraceable',
  'tdd-mutation-missing',
  'contract-test-missing',
] as const
export type ConstructionCheck = (typeof CONSTRUCTION_CHECKS)[number]

export const TASK_ACTIONS = ['list', 'claim', 'done', 'block', 'drop', 'release', 'reassign', 'update', 'verify-review'] as const
export const TEST_ACTIONS = ['plan', 'record', 'defect', 'list', 'env'] as const
export const REVIEW_ACTIONS = ['record', 'rehash', 'list'] as const
export const DELIVER_ACTIONS = ['run', 'package', 'show'] as const
export const GATE_ACTIONS = ['check', 'advance', 'sign', 'waive', 'rollback'] as const
export const FEASIBILITY_ACTIONS = ['assess'] as const
export const RISK_ACTIONS = ['log', 'update', 'list', 'conclude'] as const
export const REQUIREMENT_ACTIONS = [
  'capture',
  'grill',
  'answer',
  'update',
  'change',
  'list',
  'baseline',
  'design-questions',
  'applicability',
  'applicability-confirm',
] as const
/**
 * 红队动作面。
 *
 * **D-5（sdo-test-new 2026-10-08，major）**：`dispose` 是**新增**的 —— 在此之前
 * `disposeIssue()`（唯一写 `issue/closed` 的地方）被 `office.ts` 包了一层却**没有任何 action 接到它**：
 * 议题文件永远停在 `status: open` / `disposition: none`，而 C8 用 `issueClosure()` 从问题/风险**现算**闭环
 * ⇒ 读者看到"还有 6 个未闭环议题"，门禁说"已全部闭环"，两份真源给出相反结论；
 * 同时 `issue/closed` 还挂在 G2 的签字失效事件集合里 —— 一个**不可达事件**。
 */
export const REDTEAM_ACTIONS = ['attack', 'propose', 'file', 'dispose', 'on', 'off', 'status'] as const
export const DESIGN_ACTIONS = [
  'view',
  'create',
  'contract',
  'drop-contract',
  'grill',
  'answer',
  'confirm',
  'issues',
  'render',
  'method',
  'artifact',
  'review',
  'waive-plan',
] as const
export const ADR_ACTIONS = ['record', 'list', 'supersede'] as const
export const QUALITY_ACTIONS = ['scenario', 'evaluate', 'list'] as const
export const TRACE_ACTIONS = ['link', 'unlink', 'query', 'report'] as const
export const LANG_ACTIONS = ['show', 'set'] as const

/**
 * 动作清单 → 工具 schema 里 `action.description` 的原文（`'a' | 'b' | …`）。
 *
 * 只有**动作标识**进这里（ASCII，不是文案），因此不需要进语言包；面向用户的句子仍是
 * 语言包里的键（报错回执把 {@link actionList} 之外的清单作为 `{p2}` 参数传入）。
 */
export function actionList(actions: readonly string[]): string {
  return `${actions.map((action) => `'${action}'`).join(' | ')}.`
}

/** ① 数据字典的一条数据项（结构化最小必产项）。 */
export interface DataDictionaryItem {
  /** 条目 id（不填则写入时自动分配） */
  id?: string | undefined
  name: string
  type: string
  source: string
  sink: string
  validation: string
  /** 追溯到的需求 id（无来源条目由既有 trace.orphans 抓） */
  requires?: string[] | undefined
}

/** DFD 上的一条数据流（`from`/`to` 为加工或外部实体名）。 */
export interface DfdFlow {
  name: string
  from: string
  to: string
}

/** DFD 的一个加工（每个加工必须有输入与输出）。 */
export interface DfdProcess {
  id?: string | undefined
  name: string
  inputs: string[]
  outputs: string[]
  requires?: string[] | undefined
}

/**
 * DFD 的一层。
 * `flows` 是**本层边界流**（父子平衡检查的集合：父层流必须分解到子层，子层不得凭空多出流）；
 * 层内部新出现的数据流写在 `internalFlows`，不参与平衡。
 */
export interface DfdLevel {
  level: number
  name: string
  flows: DfdFlow[]
  internalFlows?: DfdFlow[] | undefined
  processes: DfdProcess[]
}

/** ERD 的一个实体（每个实体必须有主标识）。 */
export interface ErdEntity {
  id?: string | undefined
  name: string
  identifier: string
  attributes?: string[] | undefined
  requires?: string[] | undefined
}

/** ERD 的一条关系（基数必须是 1:1 / 1:N / M:N）。 */
export interface ErdRelation {
  id?: string | undefined
  name: string
  from: string
  to: string
  cardinality: string
}

/**
 * 类/接口清单的一条（不许只有名字：必须有职责与协作方）。
 *
 * F-14：`collaborators` 只对**非叶子**类型必填。叶子身份必须**显式声明**
 * （`leaf: true`），插件**绝不**按"没有协作方 / 分层在末端"静默推断 —— 因为
 * 「每个类型都要有协作方」与分层方向规则对叶子层是互斥的（给叶子编协作方就会方向违规）。
 * 回执会逐条说明哪些类型被当作叶子（见 `MethodPackageCheck.exemptions`）。
 */
export interface OoType {
  id?: string | undefined
  name: string
  kind: 'class' | 'interface'
  /** 所属分层（依赖方向检查用；未声明即无法检查 → 违规） */
  layer: string
  responsibility: string
  /** 协作方（**非叶子**类型必须能解析到已登记的类/接口；叶子声明 `leaf: true` 后不要求） */
  collaborators: string[]
  /**
   * 叶子类型（F-14）：只放常量/错误码等，没有真实协作方 → 豁免「必须有协作方」。
   * **必须显式写 `leaf: true`**；缺省（undefined）一律按非叶子处理（不放宽、不静默放行）。
   */
  leaf?: boolean | undefined
  /** 该类型操作的数据项（必须能解析到数据字典条目） */
  data?: string[] | undefined
  requires?: string[] | undefined
}

/** 时序里的一条消息（发送者/接收者/触发条件都必须写明）。 */
export interface SequenceMessage {
  name: string
  from: string
  to: string
  trigger: string
}

/**
 * 一个关键用例的时序（参与者必须是已登记类型）。
 *
 * F-11：需求来源有**两套字段**（单数 `requirement` 与复数 `requires`），历史上两者并存、
 * 追溯只认 `requires` → 只写 `requirement` 的条目被误判成孤儿（实测 9 个假孤儿）。
 * 现在的口径：
 *   · **写入时归一**（`method.ts` 的 `normalizeSequences`）：两者都接受，落盘后
 *     `requires` 与 `requirement` 一定互相一致（`requires` = 并集，`requirement` = 第一个）；
 *   · **读取时两者都认**（`sequenceRequirementIds`）：手改过盘上文件 / 老数据也能正确追溯。
 * 因此两个字段都可选；但至少要写一个，否则该时序没有需求来源（既有的孤儿检查会抓）。
 */
export interface SequenceSpec {
  id?: string | undefined
  name: string
  /**
   * 覆盖的需求 id（**单数别名**，与 `requires` 等价）。
   * must 需求必须都有时序 —— 但 `kind: constraint` / `quality` 的需求按 F-13 豁免。
   */
  requirement?: string | undefined
  participants: string[]
  messages: SequenceMessage[]
  /** 覆盖的需求 id（**复数主字段**；与 `requirement` 等价，写入时归一） */
  requires?: string[] | undefined
}

/** 分层/包依赖规则：声明允许的依赖方向（方向违规即失败）。 */
export interface LayerRules {
  layers: string[]
  /** 类型/元素名（或 id）→ 分层 */
  assignments: Record<string, string>
  allowed: { from: string; to: string }[]
  requires?: string[] | undefined
}

/** 技术债台账的一条。 */
export interface DebtItem {
  id?: string | undefined
  title: string
  type: 'design' | 'code' | 'test' | 'docs'
  impact: string
  /** 偿还触发器（非空才算字段齐备） */
  trigger: string
  plan: string
  requires?: string[] | undefined
}

/** 架构决策的可逆性分级（不可逆必须写明为何现在必须定）。 */
export interface ReversibilityItem {
  id?: string | undefined
  decision: string
  grade: 'reversible' | 'costly' | 'irreversible'
  whyNow?: string | undefined
  requires?: string[] | undefined
}

/** 每个迭代（无迭代的项目按阶段）的设计增量。 */
export interface DesignIncrement {
  id?: string | undefined
  /** 迭代号或阶段名 */
  iteration: string
  /** 本迭代新增/变更的设计元素 id（必须真实存在） */
  elements: string[]
  note: string
  requires?: string[] | undefined
}

// —————————————— `porting` 方法包（§7.3）：映射 / 不变量 / 差分验证 ——————————————

/**
 * 旧→新映射的一条（§7.3 ①）。
 *
 * 「两侧非空且引用真实存在的模块/类型」里的**目标是可机械校验的那一侧**：
 * `to` 必须解析到一个真实存在的模块/类型（`src/**` 下的模块路径、设计元素、类清单类型、
 * ERD 实体或 DFD 加工之一）。`from` 是旧世界的名字，新仓库里通常查不到 → **只要求非空**，
 * 用 `evidence` 记录旧侧出处（规格只要求「引用真实存在的模块/类型」，不要求旧侧可解析）。
 */
export interface MappingEntry {
  id?: string | undefined
  /** 旧世界的模块/类/API（自由文本，旧仓库里可能已不存在） */
  from: string
  /** 目标世界的模块/类型（必须能被机械校验解析到真实存在的模块/类型） */
  to: string
  /** 旧写法 → 目标写法的转换说明 */
  rewrite: string
  /** 考虑过的替代方案（规格 §7.3 要求含替代方案与被否决原因） */
  alternatives?: MappingAlternative[] | undefined
  /** 追溯到的需求 id（无来源条目由既有 trace.orphans 抓） */
  requires?: string[] | undefined
}

/** 映射条目的一条被否决替代方案。 */
export interface MappingAlternative {
  option: string
  rejectedBecause: string
}

/**
 * 不变量清单的一条（§7.3 ②）。
 *
 * `category` 覆盖规格点名的四类：行为 / 数值 / 存档格式 / 协议与 id 映射。
 * `verify` 是**必填**的验证方法（机械检查：为空即判红）。
 */
export interface InvariantItem {
  id?: string | undefined
  /** 必须保持不变的东西 */
  statement: string
  category: 'behaviour' | 'numeric' | 'save-format' | 'protocol-id'
  /** **每条必须带**的验证方法（空 → `design.method-products` 判红） */
  verify: string
  requires?: string[] | undefined
}

/**
 * 差分验证策略（§7.3 ③）：必须有**可比对的基线来源**。
 *
 * `baselineSource` 是机械检查的键：空即判红；取值必须落在
 * `DIFF_BASELINE_SOURCES` 里（测试 / 黄金样本 / 对照版本仓库）。
 */
export interface DiffVerifyStrategy {
  /** 同输入同输出的比对口径 */
  sameInputSameOutput: string
  /** 回归基线来源（机械检查键，取值见 `DIFF_BASELINE_SOURCES`） */
  baselineSource: string
  /** 基线来源的具体位置（测试路径 / 黄金样本目录 / 上游分支名） */
  baselineRef: string
  /** 对照版本仓库（可选；`baselineSource === 'upstream-branch'` 时必须有值） */
  controlRepo?: string | undefined
}

/** 差分验证的基线来源取值（机械检查的合法集合）。 */
export const DIFF_BASELINE_SOURCES = ['tests', 'golden-samples', 'upstream-branch'] as const
export type DiffBaselineSource = (typeof DIFF_BASELINE_SOURCES)[number]

/**
 * 一份方法产物（一个种类一个文件）。
 *
 * 形状照 `architecture.ts` 的「一个视图一个文件」先例：只有对应 `kind` 的字段非空。
 */
export interface MethodArtifact {
  id: string
  kind: MethodArtifactKind
  summary: string
  requires?: string[] | undefined
  updatedAt: string
  /** dictionary */
  dictionary?: DataDictionaryItem[] | undefined
  /** dfd */
  levels?: DfdLevel[] | undefined
  /** erd */
  entities?: ErdEntity[] | undefined
  relations?: ErdRelation[] | undefined
  /** classes */
  types?: OoType[] | undefined
  /** sequences */
  sequences?: SequenceSpec[] | undefined
  /** layers */
  rules?: LayerRules | undefined
  /** debt */
  debts?: DebtItem[] | undefined
  /** reversibility */
  decisions?: ReversibilityItem[] | undefined
  /** increments */
  increments?: DesignIncrement[] | undefined
  /** mapping（`porting` ①） */
  mappings?: MappingEntry[] | undefined
  /** invariants（`porting` ②） */
  invariants?: InvariantItem[] | undefined
  /** diffVerify（`porting` ③） */
  diffVerify?: DiffVerifyStrategy | undefined
}

/** 「本项目启用了哪些方法」快照（`.sdo/design/method.yml`；门禁仍从问题账本现算）。 */
export interface MethodSnapshot {
  question: string
  answer: string
  status: 'chosen' | 'none'
  methods: MethodId[]
  updatedAt: string
}

// —————————————— 设计适用性声明 + 门禁签字（§7.1 / §7.2） ——————————————

/**
 * **设计适用性声明**（`.sdo/design/applicability.yml`，§7.1）。
 *
 * 需求阶段产出、设计阶段受它约束：**由模型起草**，但**不得静默** —— 必须在
 * 注入块 + `sdo_design action=issues` + `docs/DESIGN.md` 三处向用户列出
 * 「本项目要做哪些视图、哪些不做及理由」（§7.1 的规则）。
 *
 * 门禁**不做性质到判据的机械映射**：只按本声明逐视图 / 逐工件判真（§7.1）。
 */
export interface DesignApplicability {
  /** 本项目性质与设计重点（自由文本，模型写） */
  focus: string
  /** 模型声明：本项目要做哪些视图（每个都必须**非空**；含第 6 个视图 `ui`） */
  viewsPresent: ApplicabilityViewKind[]
  /** 模型声明：本项目不做哪些视图（每条都必须带 why，且必须让用户看到） */
  viewsAbsent: ApplicabilityAbsentView[]
  /** 本次必需的非视图工件（取值见 `APPLICABILITY_ARTIFACTS`） */
  artifacts: string[]
  /**
   * 模型声明：本次**不做**哪些非视图工件（D5）。
   *
   * 与 `viewsAbsent` **完全同口径**：逐条必须给 `why`，缺理由即由
   * `applicabilityState()` 列成结构问题、并由 C-2C（`design.artifacts`）判红。
   * 为什么需要它：只有 `artifacts`（要做的清单）时，"不做"是**沉默的**——
   * 读声明的人与门禁都分不清"评估过决定不做"与"压根没想过"。
   */
  artifactsAbsent: ApplicabilityAbsentArtifact[]
  /**
   * 归一化时**不认识的视图名**（原样保留，不给静默丢弃的机会）。
   *
   * 非空即由 `applicabilityState()` 逐条列成问题 → C-2B 判红。这样"写了非法视图名"
   * 会当场变成可读错误，而不是"声明里少了它、回执也不说"。
   */
  ignoredViews?: string[] | undefined
  /** 归一化时不认识的**工件名**（与 `ignoredViews` 同口径，D5） */
  ignoredArtifacts?: string[] | undefined
  /** 用户签字绑定这份声明（缺 → 声明未确认，G3 红） */
  confirmed?: ApplicabilityConfirmation | undefined
  draftedAt: string
  updatedAt: string
}

/** 一个被声明为「本项目不做」的视图及其理由。 */
export interface ApplicabilityAbsentView {
  kind: ApplicabilityViewKind
  /** 为什么不做（门禁回执与 `docs/DESIGN.md` 都要原样展示） */
  why: string
}

/** 一个被声明为「本项目不做」的非视图工件及其理由（D5，与 `ApplicabilityAbsentView` 同口径）。 */
export interface ApplicabilityAbsentArtifact {
  kind: ApplicabilityArtifact
  /** 为什么不做（门禁回执与 `docs/DESIGN.md` 都要原样展示） */
  why: string
}

/** 声明的用户签字（绑定声明内容：声明变了 → 签字失效）。 */
export interface ApplicabilityConfirmation {
  by: string
  at: string
  /** 依据：用户原话或所选选项原文（防伪造，§7.1 要求「必须让用户看到」） */
  basis: string
}

/**
 * 声明的非视图工件（`applicability.artifacts` 的取值）。
 *
 * 语义**不是**「性质→判据表」，而是「本项目要不要这些工件」的显式表态：
 * 列进来的必须齐备，没列的不要求（§7.1 的规则）。
 */
export const APPLICABILITY_ARTIFACTS = ['invariants', 'mapping', 'diffVerify'] as const
export type ApplicabilityArtifact = (typeof APPLICABILITY_ARTIFACTS)[number]

/**
 * **门禁级用户签字**（§7.2）。
 *
 * 来源只承认两种：① 用户在会话中**明确表述**签字确认；② 用户在**人机关口问答**里
 * **明确选择**签字选项。记录必须同时写入**用户原话引用 / 所选选项原文**（`basis`）
 * 才能成立 —— 无引用的签字**视为无效**（这是防代签的唯一可审计保障）。
 */
export interface GateSignature {
  gate: string
  by: string
  /** 用户原话引用或所选选项原文（**空 → 签字无效**） */
  basis: string
  /** 来源通道：命令面（强）或人机关口问答面（弱） */
  channel: 'command' | 'question'
  at: string
  /** 会话轮次引用（`session:turn`，可空但建议填写） */
  turn?: string | undefined
  /**
   * **R-7**：这次签字有没有真的和"本次会话的用户发言"核对过。
   *
   * `session` = 核对过（引用确实出自用户）；`unavailable` = 宿主没有提供会话历史
   * （旧实现在这种情况下**静默放行**，于是"防代签"的强度随宿主而变，且用户与审计都不知道）。
   * 口令留痕后，回执与门禁 detail 都会显式标注"本次签字未经过会话历史核对"。
   */
  basisChecked?: 'session' | 'unavailable' | undefined
  /** 签字时的 journal 序号（用于「签字后声明/需求变更 → 签字失效」） */
  atSeq: number
}

/**
 * **G2（需求基线）签字**的失效事件集合（D1）。
 *
 * 口径：**凡是会改变 G2 判据所见真源的事件，都让 G2 签字失效**。G2 的判据读四类真源：
 *   · 需求本身（C1 / C3）→ `requirement/captured`、`requirement/updated`；
 *   · 项目与裁剪（C4 术语表 / C5 非目标 / C6 红队档位）→ `project/created`、`project/updated`、`tailoring/updated`；
 *   · 问题账本（C2 未决问题、D4 的 P1→风险关联）→ `question/asked`、`question/answered`、`risk/logged`、`risk/updated`；
 *   · 红队（C6 已执行 / C8 议题闭环）→ `redteam/*`、`issue/opened`、`issue/closed`。
 *
 * **有意不列**的事件（列进去会造成自相矛盾或无效失效）：
 *   · `requirement/baselined` —— 它是**消费**签字的动作本身（重新基线不该让刚签的字立刻失效，
 *     否则 M3 的"内容未改重新冻结"永远无法通过）；
 *   · `phase/*`、`gate/*`、`gate/signed` —— 阶段流转与门禁留痕不是需求真源；
 *   · `requirement/updated` 之外的读/渲染类事件。
 */
export const G2_SIGNATURE_INVALIDATING_EVENTS = [
  'project/created',
  'project/updated',
  // **SDO-08**：插件/宿主/node 版本入账（跨版本复现的外部线索）—— 元数据，不作废签字
  'project/environment',
  'tailoring/updated',
  'requirement/captured',
  'requirement/updated',
  'question/asked',
  'question/answered',
  'risk/logged',
  'risk/updated',
  'redteam/attack',
  'redteam/file',
  'redteam/mode',
  'redteam/propose',
  'redteam/model-proposed',
  'issue/opened',
  'issue/closed',
] as const

/**
 * 「签字何时失效」的口径（§7.2）—— **G3（设计）用黑名单**（N-7）。
 *
 * 为什么反着列：白名单**漏一个真源就留一个洞**。实测（独立复核实证）：签字之后新增一条
 * "只写结论"的 ADR，`C-2D` 仍报"签字有效"（`adr/recorded` 不在白名单里），只有 C-22 判红 ——
 * 等于"签字之后仍可塞进门禁明确会拒绝的条目"。同族还漏过 `trace/linked`（喂 C-21）与
 * `quality/recorded`（设计真源）。
 *
 * 黑名单的默认方向是**保守**：新增事件类型自动被当作失效事件，不会再悄悄开洞。
 * 列在这里的都是**不改设计真源**的事件：派生视图的渲染、门禁/签字自身的产物、阶段记账、
 * 计划与执行记账、验证/交付/证据、成本与预算、变更单的记录本身（内容变更由
 * `requirement/updated` 之类背书）、G2 之前的可行性评估。
 */
// **观察（评审员 2026-10-02）**：`trace/linked` 与 `trace/unlinked` **有意不在此表** ——
// 追溯边喂 C-21（覆盖率）与孤儿判定，撤销/新增一条边会改变门禁输入，因此必须让设计签字失效
// （与 `adr/recorded`、`contract/recorded` 同类：改的是"设计承诺"，不是记账）。
// 代价是"仅撤销一条边"也要重签；若将来认为不该，把它加进本表并在此写明依据即可。
export const SIGNATURE_NEUTRAL_EVENTS = [
  // 派生视图 / 渲染（不反向写台账）
  'design/rendered',
  // 门禁与签字自身的产物
  'gate/result',
  'gate/signed',
  // 阶段记账（设计内容不变；DESIGN.md 正文里已不含阶段，见 N-8/N-13）
  'phase/entered',
  'phase/exited',
  'phase/rolled-back',
  // 计划模式 / 派发 / 任务执行记账（不改设计真源）
  'plan/mode',
  'plan/review-blocked',
  'plan/review-approved',
  'plan/review-waived',
  'dispatch/decided',
  'dispatch/started',
  // 派发的收尾与回报（2026-10-05 真机）：子代理干完活 / 交回报告都不改 `DESIGN.md`
  // （实测：设计文档里没有派发台账，只有 ADR 正文出现过"派发"这个词），属纯记账。
  'dispatch/finished',
  'dispatch/reported',
  // 采集失败留痕（真机曾整段静默吞异常）：同样是台账记账，与 `DESIGN.md` 无关。
  'dispatch/observe-failed',
  // 实现阶段**方法包**的选择（tdd / contract-first）：`DESIGN.md` 的「设计方法与采用理由」讲的是
  // **设计**方法（结构化 / OO），不含实现包（真机实测 grep 命中 0），故属记账。
  'plan/profile-decided',
  'iteration/updated',
  'task/created',
  'task/updated',
  'task/claimed',
  'task/released',
  'task/done',
  'task/blocked',
  // **SDO-21**：认领被门禁拒后卡没有 owner，`block` 也要能留痕（与 task/blocked 同类的记账）
  'task/claim-blocked',
  'task/dropped',
  // 验证 / 交付 / 证据（发生在设计之后，不改设计内容）
  'review/recorded',
  // **评审核实**与 review/recorded 同类：它只决定「评审能不能被采纳」，不改设计真源
  'review/verified',
  // **补记评审指纹**（G-2）：纯记账，同样不改设计真源
  'review/hashed',
  'test/recorded',
  // 施工期的**交付物**记录（变异证据、契约测试）：与 `test/recorded` 同类 ——
  // `DESIGN.md` 的 11 个固定章节里没有它们（真机实测 grep：变异 / 契约测试命中 0）。
  // **`risk/logged` / `risk/updated` 不在此列**：§11 会把风险渲染进设计文档（实测 §11 列有 RISK-006），
  // 登记风险确实改文档 ⇒ 仍须重签。
  'test/mutation-recorded',
  'test/contract-test-recorded',
  'defect/recorded',
  // **SDO-55**：更正走 append-only 差异事件（与创建分开，审计能看出改过什么）
  'defect/updated',
  'delivery/packaged',
  // **真机运行记录**：它是**证据**而非真源变更 —— 记一条不该把 G3 签字作废
  'delivery/run-recorded',
  'evidence/recorded',
  // 成本与预算：只计量，不是真源
  'cost/updated',
  'cost/sample',
  'budget/decision',
  // 变更控制单的**记录**本身（其内容变更由 `requirement/updated` 等背书）
  'change/requested',
  'change/decided',
  // **`change/rollback` 有意不在本表**（语义 A，2026-10-04）：它是"批准的需求变更把阶段拉回需求阶段"，
  // 标志设计必须**重签**（旧 G3 签字随需求变更失效正是本机制要的效果）；放进中性表会把它静默抹掉。
  // 可行性评估：G2 之前的真源，不属于架构签字背书的内容
  'feasibility/assessed',
  // **P-16**：红队/议题/质量场景这三类**跑一轮并不会改变 `DESIGN.md` 的渲染结果**
  // （实测：固定同一 seq 重渲染，正文逐字节不变；对照组 `adr/recorded`、`contract/recorded`、
  // `question/answered` 都会变）。它们是"写入但不改设计内容"的动作，而在设计阶段很常见
  // （`sdo_redteam` / `sdo_quality` 不受阶段门禁约束），按黑名单口径会带来无谓的重签 ——
  // 插件在排除 `phase/*` 时用的正是"报警疲劳"这个理由，这里同一口径。
  // 注意：**`design/grill` 与 `question/*` 不在这里** —— 它们会改变文档（未决数 / 已确认答案），
  // 因此仍然让签字失效。
  'redteam/mode',
  'redteam/attack',
  'redteam/propose',
  'redteam/model-proposed',
  'redteam/file',
  'issue/opened',
  'issue/closed',
  'quality/recorded',
] as const

/**
 * 某事件类型**是否让该门禁的签字失效**（唯一的判定入口，回执与门禁同源）。
 *
 * G2 用白名单（需求侧真源；改设计/契约不该作废需求基线签字）；
 * 其余门禁（当前只有 G3）用**黑名单**：不在 {@link SIGNATURE_NEUTRAL_EVENTS} 里即失效。
 */
export function isSignatureInvalidatingEvent(gate: string, type: string, data?: unknown): boolean {
  if (gate === 'G2') return (G2_SIGNATURE_INVALIDATING_EVENTS as readonly string[]).includes(type)
  // **追溯边按作用域区分（2026-10-05 真机）**：设计侧边（`kind: req-des`）进 `DESIGN.md` 的
  // 「追溯矩阵」§8，改的是设计承诺 ⇒ 失效；施工期覆盖边（`req-task` / `req-tc`）**不进设计文档**
  // （实测：§8 只有需求↔设计元素/契约/界面条目四列）⇒ 属记账。开发者一开工就要挂这两类边，
  // 若它们也作废签字，"签完 G3 再开发"在机械上就不成立（真机：签 G3 后仅因 3 条 `req-task/req-tc`
  // 边 #591-593 就被判 stale）。原口径担心的"新边喂 C-21"由 C-21 每次判定**现算**兜底。
  // **不传 `data` 的调用保守失效**（黑名单默认方向不变，老调用与既有断言口径不变）。
  if (type === 'trace/linked' || type === 'trace/unlinked') {
    const kind = (data as { kind?: unknown } | undefined)?.kind
    return !(kind === 'req-task' || kind === 'req-tc')
  }
  return !(SIGNATURE_NEUTRAL_EVENTS as readonly string[]).includes(type)
}

/**
 * **`DESIGN.md` 的真源路径**（SDO-19 复审，2026-10-05）。
 *
 * 为什么需要它：`truth/file-written` 会被记在**任意** `.sdo/` 真源写入上，而 C-25（文档新鲜度）
 * 把该事件类型整类算作"会改文档"。于是**手改一个构造期文件**（`.sdo/construction/*.yml`、
 * `.sdo/tests/*`、`.sdo/costs/*`…）也会把 `DESIGN.md` 判陈旧 —— 正是本表注释里自己警告过的
 * "报警疲劳"（那里特意不列 `phase/*` 就是这个理由）。所以 C-25 侧**按路径前缀**收敛到设计文档
 * 真正渲染的那些真源；**G3 签字失效那一面不变**（任何真源直写都失效：宁可重签，也别静默放过）。
 */
export const DESIGN_DOC_TRUTH_PREFIXES = [
  '.sdo/design/',
  '.sdo/contracts/',
  '.sdo/decisions/',
  '.sdo/quality/',
  '.sdo/requirements/',
  '.sdo/questions/',
  '.sdo/risks/',
] as const

/** 单文件形态的设计真源（`.sdo/project.json`：名称/范围/干系人都会进文档）。 */
export const DESIGN_DOC_TRUTH_FILES = ['.sdo/project.json'] as const

/** 该 `.sdo/` 真源路径是否属于 `DESIGN.md` 的来源（决定 C-25 是否判它陈旧）。 */
export function isDesignDocTruthPath(path: string): boolean {
  const normalized = String(path).replace(/^\.\//u, '')
  if ((DESIGN_DOC_TRUTH_FILES as readonly string[]).includes(normalized)) return true
  return (DESIGN_DOC_TRUTH_PREFIXES as readonly string[]).some((prefix) => normalized.startsWith(prefix))
}

/** 该事件类型是否**明确**属于"不改真源"的中性表（P-13：用于给失效理由标注"未分类"）。 */
export function isNeutralEvent(type: string): boolean {
  return (SIGNATURE_NEUTRAL_EVENTS as readonly string[]).includes(type)
}

/**
 * **`docs/DESIGN.md` 的内容来源事件**（X-1）。
 *
 * `docs/DESIGN.md` 是**派生视图**：它由 `sdo_design action=render` 从真源渲染。
 * 渲染头会写下 `<!-- source: .sdo/design @ journal seq N -->`；判定时若之后又出现
 * 下表中的任一事件，说明真源已经变了而文档没重渲染 → **判红**。
 *
 * 口径：**列进来的都是会改变文档内容的事件**；纯读/渲染/门禁/签字/成本类事件不在其中
 * （`design/rendered` 尤其不能进来，否则渲染动作会立刻把自己判陈旧）。
 */
export const DESIGN_DOC_SOURCE_EVENTS = [
  'project/created',
  'project/updated',
  'tailoring/updated',
  // **有意不列 `phase/*`**：文档里只有一行"当前阶段"是阶段元数据，而阶段推进/回退很频繁 ——
  // 把它算作"内容变更"会让 C-25 在每次 advance/rollback 后翻红，诱导用户忽略这条判据
  // （报警疲劳），而 X-1 要堵的是**设计真源**变了文档不重渲染。设计内容类事件都在下表内。
  'requirement/captured',
  'requirement/updated',
  'requirement/baselined',
  'question/asked',
  'question/answered',
  'contract/recorded',
  'contract/updated',
  'contract/dropped',
  'adr/recorded',
  'trace/linked',
  'risk/logged',
  'risk/updated',
  'design/updated',
  'design/ui-updated',
  'design/artifact-updated',
  // **SDO-19（2026-10-05 真机）**：绕过 SDO 直接 `write`/`edit` 改真源也是真源变更 —— 必须让 `DESIGN.md` 判陈旧（签字侧它会自然失效：不在中性表里）
  'truth/file-written',
  'design/applicability-drafted',
  'design/applicability-updated',
  'design/applicability-confirmed',
  'design/confirmed',
  'design/method-selected',
  'design/question-answered',
  'design/grill',
] as const

/** journal 事件类型（真源的唯一写入形态）。 */
export type SdoEventType =
  | 'project/created'
  | 'project/updated'
  | 'project/environment'
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
  | 'change/rollback'
  | 'tailoring/updated'
  | 'design/updated'
  | 'design/ui-updated'
  | 'design/grill'
  | 'design/question-answered'
  | 'design/confirmed'
  | 'design/rendered'
  | 'design/method-selected'
  | 'design/artifact-updated'
  | 'truth/file-written'
  | 'design/applicability-drafted'
  | 'design/applicability-updated'
  | 'design/applicability-confirmed'
  | 'gate/signed'
  | 'phase/rolled-back'
  | 'adr/recorded'
  | 'quality/recorded'
  | 'contract/recorded'
  | 'contract/updated'
  | 'contract/dropped'
  | 'trace/linked'
  | 'trace/unlinked'
  | 'plan/profile-decided'
  | 'dispatch/finished'
  | 'dispatch/reported'
  | 'dispatch/observe-failed'
  | 'test/mutation-recorded'
  | 'test/contract-test-recorded'
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
  | 'task/claim-blocked'
  | 'dispatch/decided'
  | 'dispatch/started'
  | 'iteration/updated'
  | 'review/recorded'
  // **评审核实**（2026-10-08 口径：评审结果要由实现方逐条核实才能采纳）
  | 'review/verified'
  // **G-2**：给老格式评审**补记**内容指纹（补记之后才能检出「改 verdict」这类篡改）
  | 'review/hashed'
  | 'test/recorded'
  | 'defect/recorded'
  | 'defect/updated'
  | 'delivery/packaged'
  | 'delivery/run-recorded'
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
  | 'task/claim-blocked'
  | 'dispatch/decided'
  | 'dispatch/started'
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
