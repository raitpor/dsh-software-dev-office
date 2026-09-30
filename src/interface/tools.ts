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
import { PRIORITIES, REQUIREMENT_KINDS, SCALES } from '../types.js'
import type { Priority, RequirementKind, Scale } from '../types.js'

/** 工具行为依赖，由插件入口注入。 */
export interface LangArgs {
  action?: string | undefined
  lang?: string | undefined
}

export interface OfficeToolDeps {
  init(call: OfficeCall, args: InitArgs): Promise<string>
  lang(call: OfficeCall, args: LangArgs): Promise<string>
  status(call: OfficeCall, args: { rebuild?: boolean | undefined }): Promise<string>
  project(call: OfficeCall, args: ProjectArgs): Promise<string>
  gate(call: OfficeCall, args: GateArgs): Promise<string>
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
}

export interface GateArgs {
  action: string
  /** check / waive 时的门禁 id（advance 不用） */
  gate?: string | undefined
  /** 人类签字（G2 的签字准则；advance 时也用于临时判定） */
  approvedBy?: string | undefined
  reason?: string | undefined
  approver?: string | undefined
  /** 螺旋流程：本圈风险结论（仅在 gate=GR 时使用） */
  conclusion?: 'continue' | 'adjust' | 'stop' | undefined
  /** 结论理由 */
  rationale?: string | undefined
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
  /** 视图：context | component | runtime | data | deployment */
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
        })
      },
    }),

    defineTool({
      name: 'sdo_lang',
      description: t('tool.sdo_lang'),
      parameters: {
        action: { type: 'string', required: true, description: t('param.langAction') },
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
        action: { type: 'string', required: true, description: "'update' | 'show'." },
        name: { type: 'string', description: t('param.name') },
        process: { type: 'string', description: "Process: 'waterfall' | 'prototype' | 'agile' | 'spiral'." },
        scale: { type: 'string', description: "Scale: 'trivial' | 'normal' | 'critical' (drives tailoring and the red-team default)." },
        scopeIn: { type: 'string', description: t('param.scopeIn') },
        scopeOut: { type: 'string', description: t('param.scopeOut') },
        stakeholders: { type: 'string', description: t('param.stakeholders') },
        metricsSuccess: { type: 'string', description: t('param.metricsSuccess') },
        glossary: { type: 'string', description: t('uiTools.k1') },
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
        })
      },
    }),

    defineTool({
      name: 'sdo_requirement',
      description: t('tool.sdo_requirement'),
      parameters: {
        action: { type: 'string', required: true, description: "'capture' | 'grill' | 'answer' | 'update' | 'list' | 'baseline'." },
        id: { type: 'string', description: t('param.id') },
        title: { type: 'string', description: t('param.title') },
        statement: { type: 'string', description: t('uiTools.k2') },
        rationale: { type: 'string', description: t('param.rationale') },
        kind: { type: 'string', description: "'functional' (default) | 'quality' | 'constraint'." },
        priority: { type: 'string', description: "MoSCoW: 'must' | 'should' | 'could' | 'wont'. Required for DoR." },
        sourceStakeholder: { type: 'string', description: t('param.sourceStakeholder', 'Stakeholder id such as STK-01 (traceability source).') },
        sourceRaw: { type: 'string', description: t('param.sourceRaw', 'The raw ask, in the requester\'s own words.') },
        dimensions: { type: 'string', description: 'JSON object of the eight semantic dimension scores, e.g. {"goal":2,"user":1,...}. The deterministic rule channel caps these; stricter wins.' },
        acceptance: { type: 'string', description: 'JSON array of acceptance criteria: [{"given":"…","when":"…","then":"…"}].' },
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
        })
      },
    }),

    defineTool({
      name: 'sdo_redteam',
      description: t('tool.sdo_redteam'),
      parameters: {
        action: { type: 'string', required: true, description: t('param.redteamAction') },
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
        action: { type: 'string', required: true, description: "'decompose' | 'iteration' | 'next'." },
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
        action: { type: 'string', required: true, description: "'list' | 'claim' | 'done' | 'block' | 'drop' | 'release' | 'reassign'." },
        id: { type: 'string', description: t('param.id') },
        owner: { type: 'string', description: t('param.owner') },
        expectedRevision: { type: 'number', description: t('param.expectedRevision') },
        evidence: { type: 'string', description: 'done: JSON array [{"kind":"artifact|command|workspace-changes","detail":"…"}].' },
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
        action: { type: 'string', required: true, description: "'plan' | 'record' | 'defect' | 'list'." },
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
        action: { type: 'string', required: true, description: "'record' | 'list'." },
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
        action: { type: 'string', required: true, description: "'package' | 'show'." },
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
        action: { type: 'string', required: true, description: "'report'." },
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
        action: { type: 'string', required: true, description: "'check' | 'advance' | 'waive'." },
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
        })
      },
    }),

    defineTool({
      name: 'sdo_feasibility',
      description: t('tool.sdo_feasibility'),
      parameters: {
        action: { type: 'string', required: true, description: "'assess'." },
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
        action: { type: 'string', required: true, description: "'log' | 'update' | 'list' | 'conclude'." },
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
        action: { type: 'string', required: true, description: "'create' | 'contract' |  | 'drop-contract''view'." },
        kind: { type: 'string', description: "View: 'context' | 'component' | 'runtime' | 'data' | 'deployment' (required by create)." },
        id: { type: 'string', description: t('param.id') },
        name: { type: 'string', description: t('param.name') },
        elementKind: { type: 'string', description: "Free-form element kind: 'system' | 'service' | 'store' | 'queue' | 'external' …" },
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
        })
      },
    }),

    defineTool({
      name: 'sdo_adr',
      description: t('tool.sdo_adr'),
      parameters: {
        action: { type: 'string', required: true, description: "'record' | 'list' | 'supersede'." },
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
        action: { type: 'string', required: true, description: "'scenario' | 'evaluate' | 'list'." },
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
        action: { type: 'string', required: true, description: "'link' | 'query' | 'report'." },
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
