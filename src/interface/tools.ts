/**
 * 暴露给模型的原生 dsh 工具（设计 §9.1）。
 *
 * M0：`sdo_init` / `sdo_status`；M1：`sdo_requirement` / `sdo_redteam` / `sdo_render`，
 * 以及一个**被 G2 门禁拦截**的 `sdo_design`（真正实现在 M2，这里先立好门禁与负例路径）。
 *
 * 本模块只声明**工具契约**（名称、参数、输出渲染），行为委托给 {@link OfficeToolDeps}。
 * 复杂结构（八维评分、验收标准）用 **JSON 字符串**传参，避免工具 schema 嵌套带来的歧义。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { t } from '../domain/i18n.js'
import type { OfficeCall } from '../office.js'
import {
  ADR_ACTIONS,
  COST_ACTIONS,
  DELIVER_ACTIONS,
  DESIGN_ACTIONS,
  FEASIBILITY_ACTIONS,
  GATE_ACTIONS,
  LANG_ACTIONS,
  PLAN_ACTIONS,
  PRIORITIES,
  PROJECT_ACTIONS,
  QUALITY_ACTIONS,
  REDTEAM_ACTIONS,
  REQUIREMENT_ACTIONS,
  REQUIREMENT_KINDS,
  REVIEW_ACTIONS,
  RISK_ACTIONS,
  SCALES,
  TASK_ACTIONS,
  TEST_ACTIONS,
  TRACE_ACTIONS,
  actionList,
} from '../types.js'
import type { Priority, RequirementKind, Scale } from '../types.js'

/** 工具行为依赖，由插件入口注入。 */
export interface LangArgs {
  action?: string | undefined
  lang?: string | undefined
}

/**
 * 门禁签字的**人机关口问答**通道（§7.2 来源②）。
 *
 * 工具自己把"是否签字"问给用户，并把**用户所选选项的原文**原样取回 ——
 * 引用文本因此不经过模型之手，这是本方案里"防代签"最关键的一环。
 * 宿主没装配该通道时返回 `undefined`（回执要求改用 `channel=statement` + 原话）。
 */
export interface GateSignAnswer {
  /** 用户所选选项的**原文**（直接落 basis，模型无法编造） */
  selectedLabel: string
  /** 用户自填的自由文本（选择"其他"时） */
  custom?: string | undefined
}

export interface OfficeToolDeps {
  init(call: OfficeCall, args: InitArgs): Promise<string>
  lang(call: OfficeCall, args: LangArgs): Promise<string>
  status(call: OfficeCall, args: { rebuild?: boolean | undefined }): Promise<string>
  project(call: OfficeCall, args: ProjectArgs): Promise<string>
  gate(call: OfficeCall, args: GateArgs): Promise<string>
  /**
   * 门禁签字的**人机关口问答**通道（§7.2 来源②）。
   *
   * 工具自己把"是否签字"问给用户，并把**用户所选选项的原文**原样取回 ——
   * 引用文本因此不经过模型之手，这是本方案里"防代签"最关键的一环。
   * 宿主没装配该通道时返回 `undefined`（回执要求改用 `channel=statement` + 原话）。
   */
  gateSignQuestion?(call: OfficeCall, gate: string): Promise<GateSignAnswer | undefined>
  feasibility(call: OfficeCall, args: FeasibilityArgs): Promise<string>
  risk(call: OfficeCall, args: RiskArgs): Promise<string>
  requirement(call: OfficeCall, args: RequirementArgs): Promise<string>
  redteam(call: OfficeCall, args: RedTeamArgs): Promise<string>
  render(call: OfficeCall, args: { target?: string | undefined }): Promise<string>
  design(call: OfficeCall, args: DesignArgs): Promise<string>
  adr(call: OfficeCall, args: AdrArgs): Promise<string>
  quality(call: OfficeCall, args: QualityArgs): Promise<string>
  trace(call: OfficeCall, args: TraceArgs): Promise<string>
  plan(call: OfficeCall, args: PlanArgs): Promise<string>
  task(call: OfficeCall, args: TaskArgs): Promise<string>
  test(call: OfficeCall, args: TestArgs): Promise<string>
  review(call: OfficeCall, args: ReviewArgs): Promise<string>
  deliver(call: OfficeCall, args: DeliverArgs): Promise<string>
  cost(call: OfficeCall, args: { action: string }): Promise<string>
}

export interface InitArgs {
  name?: string | undefined
  process?: string | undefined
  scale?: Scale | undefined
  scopeIn?: string[] | undefined
  scopeOut?: string[] | undefined
  stakeholders?: string[] | undefined
  /** 项目级界面面（§2.1）：comma-separated web/desktop/mobile */
  surfaces?: string[] | undefined
}

export interface ProjectArgs {
  action: string
  name?: string | undefined
  process?: string | undefined
  scale?: Scale | undefined
  scopeIn?: string[] | undefined
  scopeOut?: string[] | undefined
  stakeholders?: string[] | undefined
  metricsSuccess?: string[] | undefined
  /** JSON：{"术语":"定义"} */
  glossary?: Record<string, string> | undefined
  /** 项目级界面面（§2.1）：web / desktop / mobile */
  surfaces?: string[] | undefined
}

export interface GateArgs {
  action: string
  /** check / waive / sign 时的门禁 id（advance / rollback 不用） */
  gate?: string | undefined
  /** 人类签字（G2 的签字准则；advance 时也用于临时判定） */
  approvedBy?: string | undefined
  reason?: string | undefined
  approver?: string | undefined
  /** 螺旋流程：本圈风险结论（仅在 gate=GR 时使用） */
  conclusion?: 'continue' | 'adjust' | 'stop' | undefined
  /** 结论理由 */
  rationale?: string | undefined
  /**
   * **门禁签字来源通道**（§7.2）：
   *   · `statement` = 用户在会话中**明确表述**过签字确认（模型须给出 `quote` 原话，
   *     工具会拿去**会话记录**里核对，对不上即拒绝 —— 防模型凭空代签）；
   *   · `question`  = 走**人机关口问答**让用户亲自选（工具自己发问，不接受模型自述的引用）。
   */
  channel?: 'statement' | 'question' | undefined
  /** `channel=statement` 时的**用户原话引用**（必填） */
  quote?: string | undefined
  /** 会话轮次引用（可选，落 journal 便于审计） */
  turn?: string | undefined
  /** 阶段回退的目标阶段（action=rollback） */
  to?: string | undefined
  /**
   * 调用方 agent（**只为签字通道传**：人机关口问答必须带上活的 agent 才能问出去）。
   * 不解读它，原样交给 handler。
   */
  agent?: unknown
}

export interface FeasibilityArgs {
  action: string
  /** JSON：[{"dimension":"technical","verdict":"Go","rationale":"…"}] */
  telos?: string | undefined
  verdict?: 'go' | 'no-go' | 'conditional' | undefined
  rationale?: string | undefined
  /** JSON 字符串数组：PoC / 验证建议 */
  poc?: string | undefined
  by?: string | undefined
}

export interface RiskArgs {
  action: string
  id?: string | undefined
  title?: string | undefined
  level?: 'low' | 'medium' | 'high' | 'blocker' | undefined
  probability?: 'low' | 'medium' | 'high' | undefined
  impact?: string | undefined
  mitigation?: string | undefined
  owner?: string | undefined
  /** 关联来源（例如红队议题 REQ-ISSUE-001） */
  origin?: string | undefined
  status?: 'open' | 'mitigated' | 'closed' | undefined
  conclusion?: 'continue' | 'adjust' | 'stop' | undefined
  rationale?: string | undefined
}

export interface DesignArgs {
  action: string
  /** 视图：context | component | runtime | data | deployment | ui */
  kind?: string | undefined
  /** 元素 id（更新既有元素时给） */
  id?: string | undefined
  name?: string | undefined
  elementKind?: string | undefined
  responsibility?: string | undefined
  /** 逗号分隔的**元素名**（依赖谁） */
  dependsOn?: string | undefined
  summary?: string | undefined
  /** action=contract */
  producer?: string | undefined
  consumer?: string | undefined
  schema?: string | undefined
  contractKind?: string | undefined
  timeout?: string | undefined
  retry?: string | undefined
  idempotency?: string | undefined
  approvedBy?: string | undefined
  note?: string | undefined
  by?: string | undefined
  reason?: string | undefined
  // —————————————— 增量 1：设计交互闭环 ——————————————
  /** action=grill：模型基于需求给出的**设计方法推荐**（§1.3 要求必须带推荐与理由） */
  method?: string | undefined
  /** action=grill：推荐理由 */
  rationale?: string | undefined
  /** action=grill：本轮最多新增几个问题（不填 = 一次给全） */
  round?: number | undefined
  /** action=answer：问题 id */
  questionId?: string | undefined
  /** action=answer：选项下标（0 基）或选项原文，也可以是自定义答复 */
  choice?: string | undefined
  /** action=answer：用户明确授权"按你的建议办"（未授权不得自问自答） */
  assume?: boolean | undefined
  /** action=confirm：元素/契约/界面条目 id */
  target?: string | undefined
  /** action=issues：open | all */
  state?: string | undefined
  /** view=create 时：界面视图 JSON（风格/页面/断点/无障碍） */
  ui?: string | undefined
  // —————————————— 增量 2：设计方法论方法包 ——————————————
  /** action=artifact：方法产物种类（dictionary|dfd|erd|classes|sequences|layers|debt|reversibility|increments） */
  artifactKind?: string | undefined
  /** action=artifact：产物正文 JSON */
  artifactData?: string | undefined
  // —————————————— 界面线框图 / PlantUML 骨架 ——————————————
  /**
   * `action=render`：**可选**。`true` 走默认落点 `.sdo/design/ui.puml`，也可以给相对路径。
   *
   * ⚠️ 只写 `.puml` **骨架源码**（本仓库没有 PlantUML 渲染器，不出图）；不能是绝对路径或 `..`。
   */
  puml?: string | undefined
}

export interface AdrArgs {
  action: string
  id?: string | undefined
  title?: string | undefined
  context?: string | undefined
  decision?: string | undefined
  /** JSON：[{"option":"…","pros":"…","cons":"…"}] */
  alternatives?: string | undefined
  /** JSON：["…"] */
  consequences?: string | undefined
  /** 取代哪条 ADR */
  supersedes?: string | undefined
}

export interface QualityArgs {
  action: string
  attribute?: string | undefined
  stimulus?: string | undefined
  response?: string | undefined
  measure?: string | undefined
  priority?: 'high' | 'medium' | 'low' | undefined
  targets?: string | undefined
  /** action=evaluate：JSON 数组 */
  risks?: string | undefined
  sensitivities?: string | undefined
  tradeoffs?: string | undefined
  by?: string | undefined
}

export interface TraceArgs {
  action: string
  from?: string | undefined
  to?: string | undefined
  /** req-des | req-task | req-tc | des-task | des-ct */
  kind?: string | undefined
  /** JSON 数组：一次建多条边 */
  links?: string | undefined
}

export interface PlanArgs {
  action: string
  /** decompose：只拆这些需求（JSON 数组） */
  requirements?: string | undefined
  /** decompose：模型通道的卡片建议（JSON 数组） */
  suggestions?: string | undefined
  /** iteration：迭代目标 */
  goal?: string | undefined
  /** next：派发几条 */
  limit?: number | undefined
  /** next：后端偏好 auto | subagent | native-team | inline */
  backend?: string | undefined
}

export interface TaskArgs {
  action: string
  id?: string | undefined
  owner?: string | undefined
  expectedRevision?: number | undefined
  /** done 的证据（JSON 数组：[{"kind":"artifact","detail":"…"}]） */
  evidence?: string | undefined
  note?: string | undefined
  reason?: string | undefined
  actor?: string | undefined
}

export interface TestArgs {
  action: string
  title?: string | undefined
  kind?: 'unit' | 'integration' | 'e2e' | undefined
  requirement?: string | undefined
  steps?: string | undefined
  expected?: string | undefined
  caseId?: string | undefined
  status?: string | undefined
  evidence?: string | undefined
  severity?: 'blocker' | 'major' | 'minor' | undefined
  /** defect：更新既有缺陷的状态时给 id */
  defectId?: string | undefined
}

export interface ReviewArgs {
  action: string
  taskId?: string | undefined
  reviewer?: string | undefined
  verdict?: 'pass' | 'changes-requested' | 'reject' | undefined
  findings?: string | undefined
}

export interface DeliverArgs {
  action: string
  /** JSON：[{"path":"src/x.ts","kind":"source"}] */
  artifacts?: string | undefined
  /** JSON：[{"requirement":"REQ-001","criterion":"…","evidence":"…","verdict":"pass"}] */
  acceptance?: string | undefined
  rollbackPoint?: string | undefined
  by?: string | undefined
  notes?: string | undefined
}

export interface RequirementArgs {
  action: string
  id?: string | undefined
  title?: string | undefined
  statement?: string | undefined
  rationale?: string | undefined
  kind?: RequirementKind | undefined
  priority?: Priority | undefined
  sourceStakeholder?: string | undefined
  sourceRaw?: string | undefined
  /** JSON：{"goal":2,...} 八维语义分（模型通道） */
  dimensions?: string | undefined
  /** JSON：[{"given":"","when":"","then":""}] 追加的验收标准 */
  acceptance?: string | undefined
  /** `append`（默认，追加）或 `replace`（整份替换，用于改号/删除存量验收标准 —— R-2） */
  acceptanceMode?: string | undefined
  answer?: string | undefined
  pickedOption?: number | undefined
  assume?: boolean | undefined
  /** 记为\"假设\"时必须为 true（表示**用户授权**，否则拒绝） */
  authorizedByUser?: boolean | undefined
  /** 回答者（默认 human） */
  by?: string | undefined
  /** 基线签字人（人类） */
  approvedBy?: string | undefined
  /** 来源：`prototype` 表示原型回填；否则视为干系人 id（STK-xx） */
  source?: string | undefined
  /** 变更理由（action=change） */
  reason?: string | undefined
  /** 变更决策（action=change）：approved 才应用 */
  decision?: 'approved' | 'rejected' | 'deferred' | undefined
  decidedBy?: string | undefined
  limit?: number | undefined
  quick?: boolean | undefined
  // —————— §7.1 设计适用性声明（需求阶段产出） ——————
  /** 声明：本项目性质与设计重点（自由文本，模型起草） */
  focus?: string | undefined
  /** 声明要做的视图（JSON 数组：["context","component",…]） */
  viewsPresent?: string | undefined
  /** 声明不做的视图 + 理由（JSON 数组：[{"kind":"data","why":"…"}]） */
  viewsAbsent?: string | undefined
  /** 声明必需的非视图工件（JSON 数组：["invariants","mapping","diffVerify"]） */
  artifacts?: string | undefined
  /**
   * 声明**不做**的非视图工件 + 理由（D5；JSON 数组：[{"kind":"mapping","why":"…"}]）。
   * 与 `viewsAbsent` 同口径：逐条 `why` 必填，缺理由 C-2C 判红。
   */
  artifactsAbsent?: string | undefined
  /** 用户签字绑定声明的依据（用户原话／所选选项原文；action=applicability-confirm 必填） */
  basis?: string | undefined
}

export interface RedTeamArgs {
  action: string
  ids?: string[] | undefined
  limit?: number | undefined
  reason?: string | undefined
  requirementId?: string | undefined
  questions?: string | undefined
}

/** 从一次工具执行里取出调用上下文（会话身份 + 不透明的 agent 引用，后者供 plan mode 适配器用）。 */
export function callOf(exec: ToolRunContext): OfficeCall {
  const agent = exec.agent
  if (agent === undefined) return {}
  // cwd 尽量从 agent 上现取（比"创建会话时记录"更新、更可靠），多处字段容错
  // **实测结论（dsh-agent 0.2.0-rc.1）**：Agent 上**没有** `cwd`/`workspace.cwd`/`session.cwd`；
  // 会话工作目录在 `agent.session.header.cwd`。此前读错字段 → 工作区恒为 undefined
  // （症状：requireWorkspace 抛「无法确定本会话的工作区」）。旧字段作为兜底保留，代价为零。
  const holder = agent as unknown as {
    cwd?: unknown
    workspace?: { cwd?: unknown }
    session?: { cwd?: unknown; header?: { cwd?: unknown } }
  }
  const cwd = [holder.session?.header?.cwd, holder.cwd, holder.workspace?.cwd, holder.session?.cwd].find(
    (value): value is string => typeof value === 'string' && value !== '',
  )
  return { sessionId: String(agent.id), agent, ...(cwd === undefined ? {} : { cwd }) }
}

/** 宽松解析枚举；非法值返回 undefined（由行为层决定是否报错）。 */
export function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

export function parseScale(value: unknown): Scale | undefined {
  return parseEnum(value, SCALES)
}

/** 把逗号/分号分隔的文本解析为列表（中文标点也接受）。 */
export function parseList(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value
    .split(/[,，;；]/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** 解析 JSON 字符串参数；失败返回 undefined（调用方负责给可读错误）。 */
export function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

const OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
}

/** 创建 SDO 的工具定义数组。 */
export function createOfficeTools(deps: OfficeToolDeps): ToolDefinition[] {
  const asArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined

  return [
    defineTool({
      name: 'sdo_init',
      description: t('tool.sdo_init'),
      parameters: {
        name: { type: 'string', description: t('param.name') },
        process: { type: 'string', description: "Process: 'waterfall' (default), 'prototype', 'agile' or 'spiral'." },
        scale: { type: 'string', description: "Scale: 'trivial', 'normal' (default) or 'critical'. Drives tailoring and the red-team default." },
        scopeIn: { type: 'string', description: t('param.scopeIn') },
        scopeOut: { type: 'string', description: t('param.scopeOut') },
        stakeholders: { type: 'string', description: t('param.stakeholders') },
        surfaces: { type: 'string', description: t('param.surfaces') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.init(callOf(exec), {
          name: typeof args.name === 'string' ? args.name : undefined,
          process: typeof args.process === 'string' ? args.process : undefined,
          scale: parseScale(args.scale),
          scopeIn: parseList(args.scopeIn),
          scopeOut: parseList(args.scopeOut),
          stakeholders: parseList(args.stakeholders),
          surfaces: parseList(args.surfaces),
        })
      },
    }),

    defineTool({
      name: 'sdo_lang',
      description: t('tool.sdo_lang'),
      parameters: {
        action: { type: 'string', required: true, description: `${actionList(LANG_ACTIONS)} ${t('param.langAction')}` },
        lang: { type: 'string', description: t('param.lang') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.lang(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'show',
          lang: typeof args.lang === 'string' ? args.lang : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_status',
      description: t('tool.sdo_status'),
      parameters: {
        rebuild: { type: 'boolean', description: t('param.rebuild') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.status(callOf(exec), { rebuild: args.rebuild === true })
      },
    }),

    defineTool({
      name: 'sdo_project',
      description: t('tool.sdo_project'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(PROJECT_ACTIONS) },
        name: { type: 'string', description: t('param.name') },
        process: { type: 'string', description: "Process: 'waterfall' | 'prototype' | 'agile' | 'spiral'." },
        scale: { type: 'string', description: "Scale: 'trivial' | 'normal' | 'critical' (drives tailoring and the red-team default)." },
        scopeIn: { type: 'string', description: t('param.scopeIn') },
        scopeOut: { type: 'string', description: t('param.scopeOut') },
        stakeholders: { type: 'string', description: t('param.stakeholders') },
        metricsSuccess: { type: 'string', description: t('param.metricsSuccess') },
        glossary: { type: 'string', description: t('uiTools.k1') },
        surfaces: { type: 'string', description: t('param.surfaces') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        const parsed = parseJson<Record<string, string>>(args.glossary)
        return deps.project(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'show',
          name: typeof args.name === 'string' ? args.name : undefined,
          process: typeof args.process === 'string' ? args.process : undefined,
          scale: parseScale(args.scale),
          scopeIn: parseList(args.scopeIn),
          scopeOut: parseList(args.scopeOut),
          stakeholders: parseList(args.stakeholders),
          metricsSuccess: parseList(args.metricsSuccess),
          glossary: parsed,
          surfaces: parseList(args.surfaces),
        })
      },
    }),

    defineTool({
      name: 'sdo_requirement',
      description: t('tool.sdo_requirement'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(REQUIREMENT_ACTIONS) },
        id: { type: 'string', description: t('param.id') },
        title: { type: 'string', description: t('param.title') },
        statement: { type: 'string', description: t('uiTools.k2') },
        rationale: { type: 'string', description: t('param.rationale') },
        kind: { type: 'string', description: "'functional' (default) | 'quality' | 'constraint' | 'ui' (declares a UI/screen surface; drives the UI gate)." },
        priority: { type: 'string', description: "MoSCoW: 'must' | 'should' | 'could' | 'wont'. Required for DoR." },
        sourceStakeholder: { type: 'string', description: t('param.sourceStakeholder', 'Stakeholder id such as STK-01 (traceability source).') },
        sourceRaw: { type: 'string', description: t('param.sourceRaw', 'The raw ask, in the requester\'s own words.') },
        dimensions: { type: 'string', description: 'JSON object of the eight semantic dimension scores, e.g. {"goal":2,"user":1,...}. The deterministic rule channel caps these; stricter wins.' },
        acceptance: { type: 'string', description: 'JSON array of acceptance criteria: [{"given":"…","when":"…","then":"…"}].' },
        acceptanceMode: { type: 'string', enum: ['append', 'replace'], description: 'How `acceptance` is applied: append (default) or replace (use replace to renumber/remove existing criteria, e.g. when C9 reports duplicate AC ids).' },
        limit: { type: 'number', description: t('param.limit') },
        quick: { type: 'boolean', description: t('param.quick') },
        answer: { type: 'string', description: t('param.answer') },
        pickedOption: { type: 'number', description: t('param.pickedOption', 'Zero-based index of the chosen option; recorded together with the answer.') },
        assume: { type: 'boolean', description: t('param.assume') },
        authorizedByUser: { type: 'boolean', description: t('uiTools.k3') },
        by: { type: 'string', description: 'Who answered (default "human").' },
        approvedBy: { type: 'string', description: t('param.approvedBy') },
        source: { type: 'string', description: "Provenance: 'prototype' marks the requirement as backfilled from a throwaway prototype (design §7.2); any other value is treated as a stakeholder id such as STK-01." },
        reason: { type: 'string', description: t('param.reason') },
        decision: { type: 'string', description: "Change decision (action=change): 'approved' applies the change; 'rejected'/'deferred' only files the request." },
        decidedBy: { type: 'string', description: t('param.decidedBy') },
        focus: { type: 'string', description: t('uiTools.kApplicabilityFocus') },
        viewsPresent: { type: 'string', description: t('uiTools.kApplicabilityPresent') },
        viewsAbsent: { type: 'string', description: t('uiTools.kApplicabilityAbsent') },
        artifacts: { type: 'string', description: t('uiTools.kApplicabilityArtifacts') },
        artifactsAbsent: { type: 'string', description: t('uiTools.kApplicabilityArtifactsAbsent') },
        basis: { type: 'string', description: t('uiTools.kApplicabilityBasis') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.requirement(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          id: typeof args.id === 'string' ? args.id : undefined,
          title: typeof args.title === 'string' ? args.title : undefined,
          statement: typeof args.statement === 'string' ? args.statement : undefined,
          rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
          kind: parseEnum(args.kind, REQUIREMENT_KINDS),
          priority: parseEnum(args.priority, PRIORITIES),
          sourceStakeholder: typeof args.sourceStakeholder === 'string' ? args.sourceStakeholder : undefined,
          sourceRaw: typeof args.sourceRaw === 'string' ? args.sourceRaw : undefined,
          dimensions: typeof args.dimensions === 'string' ? args.dimensions : undefined,
          acceptance: typeof args.acceptance === 'string' ? args.acceptance : undefined,
          acceptanceMode: typeof args.acceptanceMode === 'string' ? args.acceptanceMode : undefined,
          answer: typeof args.answer === 'string' ? args.answer : undefined,
          pickedOption: typeof args.pickedOption === 'number' ? args.pickedOption : undefined,
          assume: args.assume === true,
          authorizedByUser: args.authorizedByUser === true,
          by: typeof args.by === 'string' ? args.by : undefined,
          approvedBy: typeof args.approvedBy === 'string' ? args.approvedBy : undefined,
          source: typeof args.source === 'string' ? args.source : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          decision: parseEnum(args.decision, ['approved', 'rejected', 'deferred'] as const),
          decidedBy: typeof args.decidedBy === 'string' ? args.decidedBy : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          quick: args.quick === true,
          focus: typeof args.focus === 'string' ? args.focus : undefined,
          viewsPresent: typeof args.viewsPresent === 'string' ? args.viewsPresent : undefined,
          viewsAbsent: typeof args.viewsAbsent === 'string' ? args.viewsAbsent : undefined,
          artifacts: typeof args.artifacts === 'string' ? args.artifacts : undefined,
          artifactsAbsent: typeof args.artifactsAbsent === 'string' ? args.artifactsAbsent : undefined,
          basis: typeof args.basis === 'string' ? args.basis : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_redteam',
      description: t('tool.sdo_redteam'),
      parameters: {
        action: { type: 'string', required: true, description: `${actionList(REDTEAM_ACTIONS)} ${t('param.redteamAction')}` },
        requirementId: { type: 'string', description: t('param.requirementId') },
        questions: { type: 'string', description: t('param.questions') },
        ids: { type: 'string', description: t('param.ids', 'Comma-separated requirement ids to attack (default: all requirements).') },
        limit: { type: 'number', description: t('param.limit') },
        reason: { type: 'string', description: t('param.reason') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.redteam(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'status',
          ids: asArray(args.ids) ?? parseList(args.ids),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          requirementId: typeof args.requirementId === 'string' ? args.requirementId : undefined,
          questions: typeof args.questions === 'string' ? args.questions : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_render',
      description: t('tool.sdo_render'),
      parameters: {
        target: { type: 'string', description: "What to render: 'srs' (default) — more targets land in later milestones." },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.render(callOf(exec), { target: typeof args.target === 'string' ? args.target : undefined })
      },
    }),

    defineTool({
      name: 'sdo_plan',
      description: t('tool.sdo_plan'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(PLAN_ACTIONS) },
        requirements: { type: 'string', description: t('param.requirements') },
        suggestions: { type: 'string', description: t('param.suggestions') },
        goal: { type: 'string', description: t('param.goal') },
        limit: { type: 'number', description: t('param.limit') },
        backend: { type: 'string', description: "next: 'auto' | 'subagent' | 'native-team' | 'inline'." },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.plan(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'next',
          requirements: typeof args.requirements === 'string' ? args.requirements : undefined,
          suggestions: typeof args.suggestions === 'string' ? args.suggestions : undefined,
          goal: typeof args.goal === 'string' ? args.goal : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          backend: typeof args.backend === 'string' ? args.backend : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_task',
      description: t('tool.sdo_task'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(TASK_ACTIONS) },
        id: { type: 'string', description: t('param.id') },
        owner: { type: 'string', description: t('param.owner') },
        expectedRevision: { type: 'number', description: t('param.expectedRevision') },
        evidence: { type: 'string', description: t('param.evidence') },
        note: { type: 'string', description: t('param.note') },
        reason: { type: 'string', description: t('param.reason') },
        actor: { type: 'string', description: t('param.actor') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.task(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          id: typeof args.id === 'string' ? args.id : undefined,
          owner: typeof args.owner === 'string' ? args.owner : undefined,
          expectedRevision: typeof args.expectedRevision === 'number' ? args.expectedRevision : undefined,
          evidence: typeof args.evidence === 'string' ? args.evidence : undefined,
          note: typeof args.note === 'string' ? args.note : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          actor: typeof args.actor === 'string' ? args.actor : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_test',
      description: t('tool.sdo_test'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(TEST_ACTIONS) },
        title: { type: 'string', description: t('param.title') },
        kind: { type: 'string', description: "plan: 'unit' | 'integration' | 'e2e'." },
        requirement: { type: 'string', description: t('param.requirement') },
        steps: { type: 'string', description: t('param.steps') },
        expected: { type: 'string', description: t('param.expected') },
        caseId: { type: 'string', description: t('param.caseId') },
        status: { type: 'string', description: "record: 'pass' | 'fail' | 'skip'. defect: 'open' | 'fixed' | 'closed' | 'wontfix'." },
        evidence: { type: 'string', description: t('param.evidence') },
        severity: { type: 'string', description: "defect: 'blocker' | 'major' | 'minor'." },
        defectId: { type: 'string', description: t('param.defectId') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.test(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          title: typeof args.title === 'string' ? args.title : undefined,
          kind: parseEnum(args.kind, ['unit', 'integration', 'e2e'] as const),
          requirement: typeof args.requirement === 'string' ? args.requirement : undefined,
          steps: typeof args.steps === 'string' ? args.steps : undefined,
          expected: typeof args.expected === 'string' ? args.expected : undefined,
          caseId: typeof args.caseId === 'string' ? args.caseId : undefined,
          status: typeof args.status === 'string' ? args.status : undefined,
          evidence: typeof args.evidence === 'string' ? args.evidence : undefined,
          severity: parseEnum(args.severity, ['blocker', 'major', 'minor'] as const),
          defectId: typeof args.defectId === 'string' ? args.defectId : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_review',
      description: t('tool.sdo_review'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(REVIEW_ACTIONS) },
        taskId: { type: 'string', description: t('param.taskId') },
        reviewer: { type: 'string', description: t('param.reviewer') },
        verdict: { type: 'string', description: "'pass' | 'changes-requested' | 'reject'." },
        findings: { type: 'string', description: t('param.findings') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.review(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          taskId: typeof args.taskId === 'string' ? args.taskId : undefined,
          reviewer: typeof args.reviewer === 'string' ? args.reviewer : undefined,
          verdict: parseEnum(args.verdict, ['pass', 'changes-requested', 'reject'] as const),
          findings: typeof args.findings === 'string' ? args.findings : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_deliver',
      description: t('tool.sdo_deliver'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(DELIVER_ACTIONS) },
        artifacts: { type: 'string', description: 'JSON array: [{"path":"src/x.ts","kind":"source|docs|config|schema|test"}].' },
        acceptance: { type: 'string', description: 'JSON array: [{"requirement":"REQ-001","criterion":"AC-001","evidence":"…","verdict":"pass"}].' },
        rollbackPoint: { type: 'string', description: t('param.rollbackPoint') },
        by: { type: 'string', description: 'Who packages it (default "human").' },
        notes: { type: 'string', description: t('param.notes') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.deliver(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'show',
          artifacts: typeof args.artifacts === 'string' ? args.artifacts : undefined,
          acceptance: typeof args.acceptance === 'string' ? args.acceptance : undefined,
          rollbackPoint: typeof args.rollbackPoint === 'string' ? args.rollbackPoint : undefined,
          by: typeof args.by === 'string' ? args.by : undefined,
          notes: typeof args.notes === 'string' ? args.notes : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_cost',
      description: t('tool.sdo_cost'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(COST_ACTIONS) },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.cost(callOf(exec), { action: typeof args.action === 'string' ? args.action : 'report' })
      },
    }),

    defineTool({
      name: 'sdo_gate',
      description: t('tool.sdo_gate'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(GATE_ACTIONS) },
        gate: {
          type: 'string',
          description:
            t('uiTools.k4')
            + t('uiTools.k5')
            + t('uiTools.k6'),
        },
        approvedBy: { type: 'string', description: t('param.approvedBy') },
        reason: { type: 'string', description: t('param.reason') },
        approver: { type: 'string', description: t('param.approver') },
        conclusion: { type: 'string', description: "Spiral GR gate: this round's risk conclusion — 'continue' | 'adjust' | 'stop'." },
        rationale: { type: 'string', description: t('param.rationale') },
        channel: { type: 'string', description: t('uiTools.kGateChannel') },
        quote: { type: 'string', description: t('uiTools.kGateQuote') },
        turn: { type: 'string', description: t('uiTools.kGateTurn') },
        to: { type: 'string', description: t('uiTools.kGateRollbackTo') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.gate(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'check',
          gate: typeof args.gate === 'string' ? args.gate : undefined,
          approvedBy: typeof args.approvedBy === 'string' ? args.approvedBy : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          approver: typeof args.approver === 'string' ? args.approver : undefined,
          conclusion:
            args.conclusion === 'continue' || args.conclusion === 'adjust' || args.conclusion === 'stop'
              ? args.conclusion
              : undefined,
          rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
          channel: args.channel === 'statement' || args.channel === 'question' ? args.channel : undefined,
          quote: typeof args.quote === 'string' ? args.quote : undefined,
          turn: typeof args.turn === 'string' ? args.turn : undefined,
          to: typeof args.to === 'string' ? args.to : undefined,
          // 人机关口问答通道需要活的 agent 与取消信号（由调用方注入的 answerer 处理）
          agent: exec.agent,
        })
      },
    }),

    defineTool({
      name: 'sdo_feasibility',
      description: t('tool.sdo_feasibility'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(FEASIBILITY_ACTIONS) },
        telos: { type: 'string', description: t('uiTools.k7') },
        verdict: { type: 'string', description: "'go' | 'no-go' | 'conditional'." },
        rationale: { type: 'string', description: t('param.rationale') },
        poc: { type: 'string', description: t('uiTools.k8') },
        by: { type: 'string', description: 'Who assessed (default "human").' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.feasibility(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'assess',
          telos: typeof args.telos === 'string' ? args.telos : undefined,
          verdict: parseEnum(args.verdict, ['go', 'no-go', 'conditional'] as const),
          rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
          poc: typeof args.poc === 'string' ? args.poc : undefined,
          by: typeof args.by === 'string' ? args.by : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_risk',
      description: t('tool.sdo_risk'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(RISK_ACTIONS) },
        id: { type: 'string', description: t('param.id') },
        title: { type: 'string', description: t('param.title') },
        level: { type: 'string', description: "'low' | 'medium' | 'high' | 'blocker'." },
        probability: { type: 'string', description: "'low' | 'medium' | 'high'." },
        impact: { type: 'string', description: t('param.impact') },
        mitigation: { type: 'string', description: t('param.mitigation') },
        owner: { type: 'string', description: t('param.owner') },
        origin: { type: 'string', description: t('param.origin') },
        status: { type: 'string', description: "'open' | 'mitigated' | 'closed' (update)." },
        conclusion: { type: 'string', description: "Spiral per-round risk conclusion ('conclude'): 'continue' | 'adjust' | 'stop'." },
        rationale: { type: 'string', description: t('param.rationale') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.risk(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          id: typeof args.id === 'string' ? args.id : undefined,
          title: typeof args.title === 'string' ? args.title : undefined,
          level: parseEnum(args.level, ['low', 'medium', 'high', 'blocker'] as const),
          probability: parseEnum(args.probability, ['low', 'medium', 'high'] as const),
          impact: typeof args.impact === 'string' ? args.impact : undefined,
          mitigation: typeof args.mitigation === 'string' ? args.mitigation : undefined,
          owner: typeof args.owner === 'string' ? args.owner : undefined,
          origin: typeof args.origin === 'string' ? args.origin : undefined,
          status: parseEnum(args.status, ['open', 'mitigated', 'closed'] as const),
          conclusion: parseEnum(args.conclusion, ['continue', 'adjust', 'stop'] as const),
          rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_design',
      description: t('tool.sdo_design'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(DESIGN_ACTIONS) },
        kind: { type: 'string', description: t('param.designKind') },
        id: { type: 'string', description: t('param.id') },
        name: { type: 'string', description: t('param.name') },
        elementKind: { type: 'string', description: t('param.elementKind') },
        responsibility: { type: 'string', description: t('param.responsibility') },
        dependsOn: { type: 'string', description: t('param.dependsOn') },
        summary: { type: 'string', description: t('param.summary') },
        producer: { type: 'string', description: t('param.producer') },
        consumer: { type: 'string', description: t('param.consumer') },
        schema: { type: 'string', description: t('param.schema') },
        contractKind: { type: 'string', description: "'http' | 'event' | 'rpc' | 'schema' (contract)." },
        timeout: { type: 'string', description: t('param.timeout') },
        retry: { type: 'string', description: t('param.retry') },
        idempotency: { type: 'string', description: t('param.idempotency') },
        method: { type: 'string', description: t('param.designMethod') },
        rationale: { type: 'string', description: t('param.designRationale') },
        round: { type: 'number', description: t('param.designRound') },
        questionId: { type: 'string', description: t('param.designQuestionId') },
        choice: { type: 'string', description: t('param.designChoice') },
        assume: { type: 'boolean', description: t('param.designAssume') },
        target: { type: 'string', description: t('param.designTarget') },
        state: { type: 'string', description: t('param.designState') },
        ui: { type: 'string', description: t('param.designUi') },
        // F-7：这两个参数此前只在 TS 类型与 handler 里存在，schema 里漏了 → 宿主按 schema
        // 过滤入参后 handler 收到空种类，`action=artifact` 在工具通道上根本不可用。
        // 由 `test/m15.test.ts` 的「schema ↔ handler」机械守卫防回归。
        artifactKind: { type: 'string', description: t('param.designArtifactKind') },
        artifactData: { type: 'string', description: t('param.designArtifactData') },
        puml: { type: 'string', description: t('param.designPuml') },
        approvedBy: { type: 'string', description: t('param.approvedBy') },
        note: { type: 'string', description: t('param.note') },
        by: { type: 'string', description: t('param.by') },
        reason: { type: 'string', description: t('param.reason') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.design(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'view',
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          id: typeof args.id === 'string' ? args.id : undefined,
          name: typeof args.name === 'string' ? args.name : undefined,
          elementKind: typeof args.elementKind === 'string' ? args.elementKind : undefined,
          responsibility: typeof args.responsibility === 'string' ? args.responsibility : undefined,
          dependsOn: typeof args.dependsOn === 'string' ? args.dependsOn : undefined,
          summary: typeof args.summary === 'string' ? args.summary : undefined,
          producer: typeof args.producer === 'string' ? args.producer : undefined,
          consumer: typeof args.consumer === 'string' ? args.consumer : undefined,
          schema: typeof args.schema === 'string' ? args.schema : undefined,
          contractKind: typeof args.contractKind === 'string' ? args.contractKind : undefined,
          timeout: typeof args.timeout === 'string' ? args.timeout : undefined,
          retry: typeof args.retry === 'string' ? args.retry : undefined,
          idempotency: typeof args.idempotency === 'string' ? args.idempotency : undefined,
          method: typeof args.method === 'string' ? args.method : undefined,
          rationale: typeof args.rationale === 'string' ? args.rationale : undefined,
          round: typeof args.round === 'number' ? args.round : undefined,
          questionId: typeof args.questionId === 'string' ? args.questionId : undefined,
          choice: typeof args.choice === 'string' ? args.choice : undefined,
          assume: args.assume === true,
          target: typeof args.target === 'string' ? args.target : undefined,
          state: typeof args.state === 'string' ? args.state : undefined,
          ui: typeof args.ui === 'string' ? args.ui : undefined,
          artifactKind: typeof args.artifactKind === 'string' ? args.artifactKind : undefined,
          artifactData: typeof args.artifactData === 'string' ? args.artifactData : undefined,
          puml: typeof args.puml === 'string' ? args.puml : undefined,
          approvedBy: typeof args.approvedBy === 'string' ? args.approvedBy : undefined,
          note: typeof args.note === 'string' ? args.note : undefined,
          by: typeof args.by === 'string' ? args.by : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_adr',
      description: t('tool.sdo_adr'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(ADR_ACTIONS) },
        title: { type: 'string', description: t('param.title') },
        context: { type: 'string', description: t('param.context', 'The forces at play: what makes this a decision at all.') },
        decision: { type: 'string', description: t('param.decision') },
        alternatives: { type: 'string', description: 'JSON array: [{"option":"…","pros":"…","cons":"…"}].' },
        consequences: { type: 'string', description: t('param.consequences') },
        supersedes: { type: 'string', description: t('param.supersedes') },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.adr(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          title: typeof args.title === 'string' ? args.title : undefined,
          context: typeof args.context === 'string' ? args.context : undefined,
          decision: typeof args.decision === 'string' ? args.decision : undefined,
          alternatives: typeof args.alternatives === 'string' ? args.alternatives : undefined,
          consequences: typeof args.consequences === 'string' ? args.consequences : undefined,
          supersedes: typeof args.supersedes === 'string' ? args.supersedes : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_quality',
      description: t('tool.sdo_quality'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(QUALITY_ACTIONS) },
        attribute: { type: 'string', description: "Quality attribute: 'performance' | 'security' | 'reliability' | 'maintainability' | … (scenario)." },
        stimulus: { type: 'string', description: t('param.stimulus') },
        response: { type: 'string', description: t('param.response') },
        measure: { type: 'string', description: t('uiTools.k9') },
        priority: { type: 'string', description: "'high' | 'medium' | 'low'." },
        targets: { type: 'string', description: t('param.targets') },
        risks: { type: 'string', description: t('param.risks') },
        sensitivities: { type: 'string', description: t('param.sensitivities') },
        tradeoffs: { type: 'string', description: t('param.tradeoffs') },
        by: { type: 'string', description: 'Who evaluated (default "human").' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.quality(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'list',
          attribute: typeof args.attribute === 'string' ? args.attribute : undefined,
          stimulus: typeof args.stimulus === 'string' ? args.stimulus : undefined,
          response: typeof args.response === 'string' ? args.response : undefined,
          measure: typeof args.measure === 'string' ? args.measure : undefined,
          priority: parseEnum(args.priority, ['high', 'medium', 'low'] as const),
          targets: typeof args.targets === 'string' ? args.targets : undefined,
          risks: typeof args.risks === 'string' ? args.risks : undefined,
          sensitivities: typeof args.sensitivities === 'string' ? args.sensitivities : undefined,
          tradeoffs: typeof args.tradeoffs === 'string' ? args.tradeoffs : undefined,
          by: typeof args.by === 'string' ? args.by : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_trace',
      description: t('tool.sdo_trace'),
      parameters: {
        action: { type: 'string', required: true, description: actionList(TRACE_ACTIONS) },
        from: { type: 'string', description: t('param.from') },
        to: { type: 'string', description: t('param.to') },
        kind: { type: 'string', description: "'req-des' | 'req-task' | 'req-tc' | 'des-task' | 'des-ct'." },
        links: { type: 'string', description: 'JSON array for batch linking: [{"from":"REQ-001","to":"DES-001","kind":"req-des"}].' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.trace(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'query',
          from: typeof args.from === 'string' ? args.from : undefined,
          to: typeof args.to === 'string' ? args.to : undefined,
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          links: typeof args.links === 'string' ? args.links : undefined,
        })
      },
    }),
  ]
}
