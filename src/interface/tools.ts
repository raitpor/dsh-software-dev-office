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
  requirement(call: OfficeCall, args: RequirementArgs): Promise<string>
  redteam(call: OfficeCall, args: RedTeamArgs): Promise<string>
  render(call: OfficeCall, args: { target?: string | undefined }): Promise<string>
  design(call: OfficeCall, args: { action?: string | undefined }): Promise<string>
}

export interface InitArgs {
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
  limit?: number | undefined
  quick?: boolean | undefined
}

export interface RedTeamArgs {
  action: string
  ids?: string[] | undefined
  limit?: number | undefined
  reason?: string | undefined
}

/** 从一次工具执行里取出调用上下文（会话身份）。 */
export function callOf(exec: ToolRunContext): OfficeCall {
  const agent = exec.agent
  return agent === undefined ? {} : { sessionId: String(agent.id) }
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
        'Initialize the software-dev-office project in the current working directory (creates `.sdo/` with an '
        + 'append-only journal as the single source of truth). Idempotent: with no fields it only returns the existing '
        + 'record; with explicit fields it fills in / updates exactly those project-ledger fields (name, process, scale, '
        + 'scope, stakeholders, metrics, glossary). Call this first, and again later to complete the ledger.',
      parameters: {
        name: { type: 'string', description: 'Project name; defaults to the working directory name.' },
        process: { type: 'string', description: "Process: 'waterfall' (default), 'prototype', 'agile' or 'spiral'." },
        scale: { type: 'string', description: "Scale: 'trivial', 'normal' (default) or 'critical'. Drives tailoring and the red-team default." },
        scopeIn: { type: 'string', description: 'Comma-separated in-scope items.' },
        scopeOut: { type: 'string', description: 'Comma-separated explicit non-goals (at least one is required at G0/G2).' },
        stakeholders: { type: 'string', description: 'Comma-separated stakeholder roles (become STK-01, STK-02, ...).' },
        metricsSuccess: { type: 'string', description: 'Comma-separated measurable success metrics (feeds the goal dimension).' },
        glossary: { type: 'string', description: 'JSON object of domain terms, e.g. {"差异":"同一笔业务在两侧系统的不一致记录"}. Gate G2 requires a non-empty glossary.' },
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
          metricsSuccess: parseList(args.metricsSuccess),
          glossary: (() => {
            const parsed = parseJson<Record<string, string>>(args.glossary)
            return parsed === undefined ? undefined : parsed
          })(),
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
      name: 'sdo_requirement',
      description:
        'Requirement lifecycle and the interrogation engine (the core of "grill the user until the requirement is '
        + 'unambiguous"). '
        + "Actions: 'capture' (create a draft requirement), 'grill' (produce up to 4 ranked questions with options and "
        + 'costs — never an open-ended dump; each question states why it is asked and the consequence of not asking), '
        + "'answer' (record an answer, or `assume:true` to take the recommended default as an explicit assumption), "
        + "'update' (patch fields, attach Given/When/Then acceptance criteria, or apply the semantic dimension scores), "
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
      name: 'sdo_design',
      description:
        'Enter architecture/design work. Gated: refuses unless every requirement is baselined at gate G2. '
        + 'The architecture engine itself lands in M2; in M1 this tool exists to enforce the gate (and to make the '
        + 'refusal path testable end to end).',
      parameters: {
        action: { type: 'string', description: "'create' (default) | 'view'." },
      },
      output: OUTPUT,
      async execute(args, exec) {
        return deps.design(callOf(exec), { action: typeof args.action === 'string' ? args.action : 'create' })
      },
    }),
  ]
}
