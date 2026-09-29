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

import type { OfficeCall } from '../office.js'
import { PRIORITIES, REQUIREMENT_KINDS, SCALES } from '../types.js'
import type { Priority, RequirementKind, Scale } from '../types.js'

/** 工具行为依赖，由插件入口注入。 */
export interface OfficeToolDeps {
  init(call: OfficeCall, args: InitArgs): Promise<string>
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
}

/** 从一次工具执行里取出调用上下文（会话身份 + 不透明的 agent 引用，后者供 plan mode 适配器用）。 */
export function callOf(exec: ToolRunContext): OfficeCall {
  const agent = exec.agent
  return agent === undefined ? {} : { sessionId: String(agent.id), agent }
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
      description:
        'Create the software-dev-office project in the current working directory (creates `.sdo/` with an append-only '
        + 'journal as the single source of truth). Create-only and idempotent: if the project exists it returns the '
        + 'existing record and changes nothing. Use `sdo_project` afterwards to maintain the project ledger.',
      parameters: {
        name: { type: 'string', description: 'Project name; defaults to the working directory name.' },
        process: { type: 'string', description: "Process: 'waterfall' (default), 'prototype', 'agile' or 'spiral'." },
        scale: { type: 'string', description: "Scale: 'trivial', 'normal' (default) or 'critical'. Drives tailoring and the red-team default." },
        scopeIn: { type: 'string', description: 'Comma-separated in-scope items.' },
        scopeOut: { type: 'string', description: 'Comma-separated explicit non-goals (at least one is required at G0/G2).' },
        stakeholders: { type: 'string', description: 'Comma-separated stakeholder roles (become STK-01, STK-02, ...).' },
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
      name: 'sdo_status',
      description:
        'Read the state of the software-dev-office project: phase, pending gate, requirement/question counts, '
        + 'the latest gate result and whether the derived projection had to be rebuilt from the journal. Read-only.',
      parameters: {
        rebuild: { type: 'boolean', description: 'Force rebuilding the derived projection (`project.json`) from the journal.' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.status(callOf(exec), { rebuild: args.rebuild === true })
      },
    }),

    defineTool({
      name: 'sdo_project',
      description:
        'Maintain the project ledger (the inputs every gate depends on): in-scope items and explicit non-goals, '
        + 'stakeholders, the domain glossary, measurable success metrics, and the process/scale. Gate G2 refuses while '
        + 'the non-goal list or the glossary is empty, so this is the tool that closes those gaps after `sdo_init`. '
        + "Actions: 'update' (writes exactly the fields you pass; nothing is overwritten implicitly) | 'show'.",
      parameters: {
        action: { type: 'string', required: true, description: "'update' | 'show'." },
        name: { type: 'string', description: 'Project name (update).' },
        process: { type: 'string', description: "Process: 'waterfall' | 'prototype' | 'agile' | 'spiral'." },
        scale: { type: 'string', description: "Scale: 'trivial' | 'normal' | 'critical' (drives tailoring and the red-team default)." },
        scopeIn: { type: 'string', description: 'Comma-separated in-scope items (replaces the list).' },
        scopeOut: { type: 'string', description: 'Comma-separated explicit non-goals (replaces the list; required by G0/G2).' },
        stakeholders: { type: 'string', description: 'Comma-separated stakeholder roles (rewrites STK-01, STK-02, ...).' },
        metricsSuccess: { type: 'string', description: 'Comma-separated measurable success metrics.' },
        glossary: { type: 'string', description: 'JSON object of domain terms, e.g. {"差异":"同一笔业务在两侧系统的不一致记录"} (merged into the existing glossary).' },
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
      description:
        'Requirement lifecycle and the interrogation engine (the core of "grill the user until the requirement is '
        + 'unambiguous"). '
        + "Actions: 'capture' (create a draft requirement), 'grill' (produce up to 4 ranked questions with options and "
        + 'costs — never an open-ended dump; each question states why it is asked and the consequence of not asking), '
        + "'answer' (record an answer, or `assume:true` to take the recommended default as an explicit assumption), "
        + "'update' (patch fields, attach Given/When/Then acceptance criteria, or apply the semantic dimension scores), "
        + "'change' (after baselining, every edit goes through a change request with a reason, an automatic impact "
        + "analysis and a decision — 'approved' applies it, 'rejected'/'deferred' only files it), "
        + "'list', 'baseline' (freeze the requirement set at gate G2 — refuses unless DoR passes: score >= 14/16, no zero "
        + 'dimension, no open P0, must-requirements have Given/When/Then, non-goals declared, red team run, human sign-off).',
      parameters: {
        action: { type: 'string', required: true, description: "'capture' | 'grill' | 'answer' | 'update' | 'list' | 'baseline'." },
        id: { type: 'string', description: 'Requirement id (e.g. REQ-001); required for update/answer-to-requirement flows.' },
        title: { type: 'string', description: 'Requirement title (capture/update).' },
        statement: { type: 'string', description: 'The requirement statement — what must be true ("系统须…").' },
        rationale: { type: 'string', description: 'Why this requirement exists (the value behind it).' },
        kind: { type: 'string', description: "'functional' (default) | 'quality' | 'constraint'." },
        priority: { type: 'string', description: "MoSCoW: 'must' | 'should' | 'could' | 'wont'. Required for DoR." },
        sourceStakeholder: { type: 'string', description: 'Stakeholder id such as STK-01 (traceability source).' },
        sourceRaw: { type: 'string', description: 'The raw ask, in the requester\'s own words.' },
        dimensions: { type: 'string', description: 'JSON object of the eight semantic dimension scores, e.g. {"goal":2,"user":1,...}. The deterministic rule channel caps these; stricter wins.' },
        acceptance: { type: 'string', description: 'JSON array of acceptance criteria: [{"given":"…","when":"…","then":"…"}].' },
        limit: { type: 'number', description: 'Max questions per grill batch (default 4, hard cap 4).' },
        quick: { type: 'boolean', description: 'Quick mode: only P0 questions (used by the trivial tailoring path).' },
        answer: { type: 'string', description: 'Answer text for the question being answered.' },
        pickedOption: { type: 'number', description: 'Zero-based index of the chosen option; recorded together with the answer.' },
        assume: { type: 'boolean', description: 'The user does not know: take the question\'s recommended default and record it as an explicit assumption.' },
        by: { type: 'string', description: 'Who answered (default "human").' },
        approvedBy: { type: 'string', description: 'Human sign-off name required by `baseline` (gate G2).' },
        source: { type: 'string', description: "Provenance: 'prototype' marks the requirement as backfilled from a throwaway prototype (design §7.2); any other value is treated as a stakeholder id such as STK-01." },
        reason: { type: 'string', description: 'Change reason (action=change).' },
        decision: { type: 'string', description: "Change decision (action=change): 'approved' applies the change; 'rejected'/'deferred' only files the request." },
        decidedBy: { type: 'string', description: 'Who decided the change (action=change).' },
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
      description:
        'Adversarial requirement review (design §5.4): attacks the requirement set from seven angles (missing '
        + 'stakeholders, hidden assumptions, cost, testability, internal conflicts, harmful-but-correct behaviour, and '
        + 'the missing non-goals/fallback/rollback check) and turns each attack into a P0 question in the ledger. '
        + "Actions: 'attack' | 'off' | 'on' | 'status'. `off`/`on` switch the red team for THIS SESSION only (written to "
        + 'the journal as `redteam/mode`); on `normal`/`critical` scale the red team runs by default, on `trivial` it does not.',
      parameters: {
        action: { type: 'string', required: true, description: "'attack' | 'off' | 'on' | 'status'." },
        ids: { type: 'string', description: 'Comma-separated requirement ids to attack (default: all requirements).' },
        limit: { type: 'number', description: 'Max attack questions per requirement (default 4).' },
        reason: { type: 'string', description: 'Why the red team is being switched off/on (recorded in the journal).' },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.redteam(callOf(exec), {
          action: typeof args.action === 'string' ? args.action : 'status',
          ids: asArray(args.ids) ?? parseList(args.ids),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          reason: typeof args.reason === 'string' ? args.reason : undefined,
        })
      },
    }),

    defineTool({
      name: 'sdo_render',
      description:
        'Render human-readable documents from `.sdo/` sources (design §10.1). Every generated file starts with a '
        + '"DO NOT EDIT" header naming the source and the journal seq, and re-rendering the same state is byte-identical. '
        + "M1 renders `docs/SRS.md`.",
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
      description:
        "Task decomposition and dispatch planning. 'decompose' builds cards through two channels — the structural "
        + 'channel (one card per design element reachable from a baselined requirement, plus one per contract edge) '
        + "and the model channel (`suggestions`) — and then runs six mechanical checks: single role, non-empty DoD, "
        + 'acyclic dependencies, size cap (a `large` card means it was not decomposed), write-scope disjointness '
        + 'between cards that could run in parallel, and at least one evidence requirement. '
        + "'iteration' opens a new iteration (agile/spiral) with a goal. 'next' picks the dispatchable cards within "
        + 'the parallel capacity budget and returns the hand-off request (the backend is chosen per §8.3 and degrades '
        + "to inline execution when no dispatch backend is available).",
      parameters: {
        action: { type: 'string', required: true, description: "'decompose' | 'iteration' | 'next'." },
        requirements: { type: 'string', description: 'decompose: JSON array of requirement ids to decompose (default: all).' },
        suggestions: { type: 'string', description: 'decompose: JSON array of extra cards from the model channel: [{title, dod:[…], role, writeScopes:[…], size}]' },
        goal: { type: 'string', description: 'iteration: the goal of this iteration.' },
        limit: { type: 'number', description: 'next: how many cards to hand off (default 1).' },
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
      description:
        'Task cards and the collaboration protocol. Claiming uses compare-and-set (`expectedRevision`) so two '
        + 'workers never take the same card; only the owner may report; `done` REQUIRES evidence (command output, an '
        + 'artifact path, or a workspace-changes reference) — a bare "finished" is not accepted; a stuck card is '
        + 'reported as `block` with a reason. Stalled owners are never released automatically: use `release` or '
        + '`reassign`, both of which leave a trace.',
      parameters: {
        action: { type: 'string', required: true, description: "'list' | 'claim' | 'done' | 'block' | 'release' | 'reassign'." },
        id: { type: 'string', description: 'Task id (TASK-001).' },
        owner: { type: 'string', description: 'Who claims / reports / takes over the card.' },
        expectedRevision: { type: 'number', description: 'claim: the revision you read (CAS).' },
        evidence: { type: 'string', description: 'done: JSON array [{"kind":"artifact|command|workspace-changes","detail":"…"}].' },
        note: { type: 'string', description: 'block: why it is stuck.' },
        reason: { type: 'string', description: 'release/reassign: the reason (recorded).' },
        actor: { type: 'string', description: 'release/reassign: who performs the action.' },
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
      description:
        "Test plan, results and defects. 'plan' writes a test case (unit/integration/e2e) and may bind it to a "
        + "requirement id — gate G4 requires every must requirement to have at least one case. 'record' records a "
        + "result with evidence; a failing result must be fixed, not waived. 'defect' records or updates a defect "
        + "(severity blocker/major/minor, status open/fixed/closed/wontfix); an open blocker stops G6.",
      parameters: {
        action: { type: 'string', required: true, description: "'plan' | 'record' | 'defect' | 'list'." },
        title: { type: 'string', description: 'plan: case title. defect: defect title.' },
        kind: { type: 'string', description: "plan: 'unit' | 'integration' | 'e2e'." },
        requirement: { type: 'string', description: 'plan: the requirement this case covers (REQ-001).' },
        steps: { type: 'string', description: 'plan: JSON array of steps.' },
        expected: { type: 'string', description: 'plan: the expected outcome.' },
        caseId: { type: 'string', description: 'record: which case ran (TC-001).' },
        status: { type: 'string', description: "record: 'pass' | 'fail' | 'skip'. defect: 'open' | 'fixed' | 'closed' | 'wontfix'." },
        evidence: { type: 'string', description: 'record: the evidence (command + output digest, or artifact path).' },
        severity: { type: 'string', description: "defect: 'blocker' | 'major' | 'minor'." },
        defectId: { type: 'string', description: 'defect: existing defect id to update.' },
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
      description:
        'Review records for finished task cards. The reviewer must differ from the card owner (independence is '
        + "checked mechanically, not trusted). 'record' files a verdict (pass / changes-requested / reject) with "
        + "findings; 'list' shows them. Gate G6 requires every finished card to carry a passing review.",
      parameters: {
        action: { type: 'string', required: true, description: "'record' | 'list'." },
        taskId: { type: 'string', description: 'The task card under review.' },
        reviewer: { type: 'string', description: 'Who reviews (must differ from the card owner).' },
        verdict: { type: 'string', description: "'pass' | 'changes-requested' | 'reject'." },
        findings: { type: 'string', description: 'JSON array of findings.' },
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
      description:
        "Delivery package: a manifest with the sha256 of every artifact, the acceptance matrix (one row per must "
        + 'requirement, with evidence and a verdict), an explicit rollback point, and a statement that no '
        + '`prototype/` content is included (Q-05). `show` lists the current package. Gate G7 refuses an incomplete '
        + 'manifest — publishing and operations are deliberately out of scope.',
      parameters: {
        action: { type: 'string', required: true, description: "'package' | 'show'." },
        artifacts: { type: 'string', description: 'JSON array: [{"path":"src/x.ts","kind":"source|docs|config|schema|test"}].' },
        acceptance: { type: 'string', description: 'JSON array: [{"requirement":"REQ-001","criterion":"AC-001","evidence":"…","verdict":"pass"}].' },
        rollbackPoint: { type: 'string', description: 'How to roll back (e.g. the git commit or the previous package id).' },
        by: { type: 'string', description: 'Who packages it (default "human").' },
        notes: { type: 'string', description: 'Anything the receiver must know.' },
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
      name: 'sdo_gate',
      description:
        'Gate engine (process is data, gates are checked, never inferred). '
        + "'check' evaluates one gate's criteria and records the verdict; 'advance' moves to the next phase only when "
        + "every exit gate of the current phase passed (or was waived); 'waive' records an explicit, attributed waiver "
        + "(`tailoring.waivedGates` + gate record) instead of silently skipping a gate. Criteria whose checker is not "
        + 'implemented yet fail on purpose — a gate never passes because nothing could be checked. '
        + "For the spiral risk quadrant gate (GR) pass `conclusion=continue|adjust|stop` with a `rationale`.",
      parameters: {
        action: { type: 'string', required: true, description: "'check' | 'advance' | 'waive'." },
        gate: { type: 'string', description: "Gate id, e.g. 'G0', 'G1', 'G2', 'G3', 'G7', 'GP' (prototype), 'GI' (agile) or 'GR' (spiral)." },
        approvedBy: { type: 'string', description: 'Human sign-off used by gates that require it (G2).' },
        reason: { type: 'string', description: 'Why this gate is waived (required by `waive`).' },
        approver: { type: 'string', description: 'Who approved the waiver (required by `waive`).' },
        conclusion: { type: 'string', description: "Spiral GR gate: this round's risk conclusion — 'continue' | 'adjust' | 'stop'." },
        rationale: { type: 'string', description: 'Rationale for the round conclusion (spiral GR gate).' },
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
      description:
        "TELOS feasibility assessment (technical / economic / legal / operational / schedule) plus the Go/No-Go verdict, "
        + 'its rationale and the PoC or validation suggestions for the risky parts. Recorded as the truth source for '
        + 'gate G1, and the risks you log with `sdo_risk` become G1 evidence too.',
      parameters: {
        action: { type: 'string', required: true, description: "'assess'." },
        telos: { type: 'string', description: 'JSON array: [{"dimension":"technical","verdict":"可行","rationale":"…"}, …]; dimensions are technical/economic/legal/operational/schedule.' },
        verdict: { type: 'string', description: "'go' | 'no-go' | 'conditional'." },
        rationale: { type: 'string', description: 'Why this verdict (the honest summary, including what remains uncertain).' },
        poc: { type: 'string', description: 'JSON array of PoC / validation suggestions for the risky parts, e.g. ["用 1 天验证 X 的吞吐上限"].' },
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
      description:
        'Risk register (`.sdo/risks/`). `log` records a risk (level low/medium/high/blocker, probability, impact, '
        + 'mitigation, owner, and an optional `origin` such as a red-team issue id — a risk whose origin points at an '
        + 'issue closes that issue). `update` moves a risk to mitigated/closed or fixes its mitigation/owner. `list` '
        + 'shows the register. Gate G1 requires the register to be non-empty and every high/blocker risk to have a '
        + 'mitigation and an owner; the spiral gate GR also needs a per-round `conclusion`.',
      parameters: {
        action: { type: 'string', required: true, description: "'log' | 'update' | 'list' | 'conclude'." },
        id: { type: 'string', description: 'Risk id (RISK-001) — required by update.' },
        title: { type: 'string', description: 'Risk title (log).' },
        level: { type: 'string', description: "'low' | 'medium' | 'high' | 'blocker'." },
        probability: { type: 'string', description: "'low' | 'medium' | 'high'." },
        impact: { type: 'string', description: 'What happens if it materialises.' },
        mitigation: { type: 'string', description: 'Mitigation / response (required for high and blocker risks at G1).' },
        owner: { type: 'string', description: 'Who owns the risk (required for high and blocker risks at G1).' },
        origin: { type: 'string', description: 'Source of the risk, e.g. a red-team issue id (REQ-ISSUE-001) — this closes that issue.' },
        status: { type: 'string', description: "'open' | 'mitigated' | 'closed' (update)." },
        conclusion: { type: 'string', description: "Spiral per-round risk conclusion ('conclude'): 'continue' | 'adjust' | 'stop'." },
        rationale: { type: 'string', description: 'Rationale for the round conclusion.' },
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
      description:
        'Architecture work, gated twice: gate G2 must have passed AND the plan must have been reviewed by an '
        + 'interactive reviewer (SDO drives plan mode itself; when no interactive reviewer exists the architecture '
        + "phase is blocked on purpose and a `plan/review-blocked` event is recorded — design Q-20). "
        + "Actions: 'create' (upsert a design element in one of the five views: context | component | runtime | data | "
        + "deployment; elements get DES-* ids and their `dependsOn` edges drive contract completeness), "
        + "'contract' (record a cross-component contract with its schema and failure semantics: timeout / retry / "
        + "idempotency), 'view' (read the current views).",
      parameters: {
        action: { type: 'string', required: true, description: "'create' | 'contract' | 'view'." },
        kind: { type: 'string', description: "View: 'context' | 'component' | 'runtime' | 'data' | 'deployment' (required by create)." },
        id: { type: 'string', description: 'Existing element id (DES-001) to update; omit to create.' },
        name: { type: 'string', description: 'Element name (create).' },
        elementKind: { type: 'string', description: "Free-form element kind: 'system' | 'service' | 'store' | 'queue' | 'external' …" },
        responsibility: { type: 'string', description: 'What this element is responsible for.' },
        dependsOn: { type: 'string', description: 'Comma-separated element NAMES this element depends on (each edge needs a contract).' },
        summary: { type: 'string', description: 'View summary (create).' },
        producer: { type: 'string', description: 'Contract producer element name (contract).' },
        consumer: { type: 'string', description: 'Contract consumer element name (contract).' },
        schema: { type: 'string', description: 'Contract body: structure, fields, example payload (contract).' },
        contractKind: { type: 'string', description: "'http' | 'event' | 'rpc' | 'schema' (contract)." },
        timeout: { type: 'string', description: 'Failure semantics: timeout behaviour (contract).' },
        retry: { type: 'string', description: 'Failure semantics: retry policy (contract).' },
        idempotency: { type: 'string', description: 'Failure semantics: idempotency key / expectation (contract).' },
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
      description:
        'Architecture decision records. Every ADR must carry the alternatives you rejected (with pros/cons) and the '
        + 'consequences you accept — gate G3 refuses ADRs that only state a conclusion. '
        + "Actions: 'record' | 'list' | 'supersede' (records a new ADR and marks the old one superseded without "
        + 'rewriting history).',
      parameters: {
        action: { type: 'string', required: true, description: "'record' | 'list' | 'supersede'." },
        title: { type: 'string', description: 'Decision title (record).' },
        context: { type: 'string', description: 'The forces at play: what makes this a decision at all.' },
        decision: { type: 'string', description: 'What we decided.' },
        alternatives: { type: 'string', description: 'JSON array: [{"option":"…","pros":"…","cons":"…"}].' },
        consequences: { type: 'string', description: 'JSON array of accepted consequences (including the bad ones).' },
        supersedes: { type: 'string', description: 'ADR id this new record supersedes (supersede).' },
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
      description:
        'Quality attribute scenarios and a lightweight ATAM. Each scenario states stimulus → response plus a '
        + 'MEASURABLE measure (metric + condition + threshold); a scenario without numbers is not a scenario. '
        + "'evaluate' records the ATAM output as three explicit lists — risks, sensitivities and tradeoffs — which "
        + 'are what later gates and the risk register consume.',
      parameters: {
        action: { type: 'string', required: true, description: "'scenario' | 'evaluate' | 'list'." },
        attribute: { type: 'string', description: "Quality attribute: 'performance' | 'security' | 'reliability' | 'maintainability' | … (scenario)." },
        stimulus: { type: 'string', description: 'What arrives (the stimulus).' },
        response: { type: 'string', description: 'What the system does in response.' },
        measure: { type: 'string', description: 'Measurable response: metric + condition + threshold, e.g. "单日 100 万条下 P99 < 500 毫秒".' },
        priority: { type: 'string', description: "'high' | 'medium' | 'low'." },
        targets: { type: 'string', description: 'Comma-separated design element ids this scenario targets.' },
        risks: { type: 'string', description: 'JSON array of risks found by the ATAM (evaluate).' },
        sensitivities: { type: 'string', description: 'JSON array of sensitivities (evaluate).' },
        tradeoffs: { type: 'string', description: 'JSON array of tradeoffs (evaluate).' },
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
      description:
        'Traceability graph (`.sdo/trace/links.jsonl`) — the engine change-impact analysis and the G3/G5 orphan and '
        + "coverage checks read from. Actions: 'link' (build edges: req-des | req-task | req-tc | des-task | des-ct; "
        + "either one edge via from/to/kind or several via a JSON `links` array), 'query' (coverage, orphans, and the "
        + "must-requirements still missing tests), 'report' (render `docs/TRACE.md`).",
      parameters: {
        action: { type: 'string', required: true, description: "'link' | 'query' | 'report'." },
        from: { type: 'string', description: 'Edge source id, e.g. REQ-001 (link).' },
        to: { type: 'string', description: 'Edge target id, e.g. DES-001 (link).' },
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
