/**
 * dsh-software-dev-office（SDO）—— deepseek-harness (dsh) 原生 Cordis 插件。
 *
 * 基于软件工程方法论的 Agent 研发办公室：把「可行性 → 需求审讯 → 架构设计 → 拆分派发 →
 * 开发 → 验证 → 交付」做成可留痕、可门禁、可重放的流程，全部落在项目内的 `.sdo/`。
 *
 * 本文件只做**装配**：把配置、领域门面（{@link SoftwareDevOffice}）与三个界面
 * （提示注入 / 工具 / 命令）接起来。业务规则都在 `src/domain`、`src/infra`、`src/interface` 里。
 *
 * 入口纪律（C-07）：本插件**不在 profile 层插入自己**，只出现在 `sdo-office` preset 的
 * `config.plugins` 里；未选择该 preset 的会话完全不加载本插件。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'

import { renderBoard } from './board/render.js'
import { Config, resolveSettings } from './config.js'
import type { SdoConfig } from './config.js'
import { contractCoverage } from './domain/contracts.js'
import { makeAcceptanceIds } from './domain/requirements.js'
import { SdoStore } from './infra/store.js'
import {
  describeAdr,
  describeAdrList,
  describeAdvance,
  describeAnswer,
  describeAssessment,
  describeBaseline,
  describeBoardNote,
  describeCapture,
  describeRequirementUpdate,
  describeChange,
  describeContract,
  describeDesign,
  describeDesignElement,
  describeDesignGate,
  describeFeasibility,
  describeGate,
  describeInit,
  describeProject,
  describeProjectUpdate,
  describeQuestions,
  describeRedTeam,
  describeRender,
  describeRequirementList,
  describeRisks,
  describeScenario,
  describeScenarioList,
  describeStatus,
  describeDispatch,
  describeInlineHandoff,
  describeManifest,
  describePlan,
  describeTask,
  describeTaskBoard,
  describeTaskConflict,
  describeTrace,
} from './interface/describe.js'
import { renderStatusBlock } from './interface/inject.js'
import { createOfficeCommands } from './interface/commands.js'
import { createOfficeTools, parseList } from './interface/tools.js'
import type { LangArgs } from './interface/tools.js'
import { clampToolResult } from './interface/clamp.js'
import { resolveScopeCall } from './interface/scope.js'
import { disciplineOrAllow } from './domain/discipline.js'
import { describeLang } from './interface/describe.js'
import { LANGUAGES, baseKeyCount, coveredBaseKeys, extraKeys, fmt, gateLabel, locale, setLocale, t } from './domain/i18n.js'
import { initGaps, renderInitQuestions } from './domain/onboarding.js'
import { buildDispatch, pickBackend } from './integration/orchestrator.js'
import type { UsageRow } from './integration/cost.js'
import type { BackendProbe, BackendKind } from './integration/orchestrator.js'
import type {
  AdrArgs,
  DeliverArgs,
  DesignArgs,
  FeasibilityArgs,
  GateArgs,
  InitArgs,
  PlanArgs,
  ProjectArgs,
  QualityArgs,
  RedTeamArgs,
  RequirementArgs,
  ReviewArgs,
  RiskArgs,
  TaskArgs,
  TestArgs,
  TraceArgs,
} from './interface/tools.js'
import { SoftwareDevOffice } from './office.js'
import type { OfficeCall } from './office.js'
import { VIEW_KINDS } from './types.js'
import type { AcceptanceCriterion, Dimension, EvidenceItem, ViewKind } from './types.js'

export const name = 'dsh-software-dev-office'

/** 需要会话存储来定位工作目录（设计 §11.6 的依赖清单）。 */
export const inject = ['sessions']

export { Config }
export type { SdoConfig }

/** 系统提示的 section 注册表（结构式读取，避免绑死内部类型）。 */
interface PromptSectionRegistry {
  // 取数回调可拿到装配上下文（只有 `scope`，没有 agent/session）
  context(section: {
    name: string
    order: number
    text: string | ((context: { scope?: unknown }) => string)
  }): () => void
}

/** 读取会话的工作目录（结构式读取；缺失表示该会话没有工作目录）。 */
function cwdOf(session: Session): string | undefined {
  const header = (session as { header?: { cwd?: unknown } }).header
  return typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined
}

/** 视图种类解析（非法值返回 undefined，由调用方给可读错误）。 */
function parseViewKind(value: string | undefined): ViewKind | undefined {
  return value !== undefined && (VIEW_KINDS as readonly string[]).includes(value) ? (value as ViewKind) : undefined
}

/** 契约种类解析。 */
function parseContractKind(value: string | undefined): 'http' | 'event' | 'rpc' | 'schema' {
  return value === 'http' || value === 'event' || value === 'rpc' ? value : 'schema'
}

/** 解析 JSON 参数；失败时给出可读错误。 */
function jsonOr<T>(value: string | undefined, label: string): { value?: T; error?: string } {
  if (value === undefined || value.trim() === '') return {}
  try {
    return { value: JSON.parse(value) as T }
  } catch (error) {
    return { error: fmt('uiIndex.k1', { p1: label, p2: error instanceof Error ? error.message : String(error) }) }
  }
}

/** 插件入口。 */
export function apply(ctx: Context, config: SdoConfig): void {
  // 显示语言由插件行配置驱动（`lang`，默认 `zh-CN`；另有随包的 `en`）。
  // 必须在**注册工具/命令与注入状态块之前**设定：工具描述、命令描述、状态块都取自语言包。
  // 未知语言一律回落到基准语言（`zh-CN`），不会出现空白或键名。
  // 语言优先级：环境变量 `SDO_LANG` > 插件行配置 `lang` > 基准语言。
  // 环境变量便于"临时试一下英文"而不改配置（与 `SDO_COMMAND_ECHO` 同一先例）。
  const envLang = process.env['SDO_LANG']
  setLocale(envLang !== undefined && envLang.trim() !== '' ? envLang : config.lang)
  const settings = resolveSettings(config)
  const logger = ctx.logger(name)
  const office = new SoftwareDevOffice(settings)

  /**
   * plan mode 适配器（设计 §8.5 / Q-17 / Q-20）。
   * `dsh-plan-mode` 只在装了它的组合里存在，因此这里**软探测**：拿不到就让设计阶段按 Q-20 阻塞。
   */
  interface PlanModeLike {
    get(agent: unknown): { active: boolean }
    set(agent: unknown, active: boolean): string
  }
  /** plan-mode 自行装载失败的原因（用于回执自诊断） */
  let planModeLoadError: string | undefined
  /** 是否尝试过自行装载（用于区分「没试过」与「试了但服务没注册」） */
  let planModeLoadAttempted = false
  let planMode: PlanModeLike | undefined

  // **方案 A（DEF-11 修复）**：preset 里**不能**引用 `@deepseek-ai/dsh-plan-mode`（外部包的
  // preset 行解析不到它 → 整个 preset 注册失败），但**代码依赖**可以解析：把它作为本包依赖装载，
  // 于是 sdo-office 会话里也有 `planMode` 服务，SDO 便能在**会话中途** `set(agent, true)` 切进计划评审。
  // 装载失败不影响其它功能（退回 `sdo_design action=review|waive-plan` 两条出口）。
  planModeLoadAttempted = true
  // 【关键设计】plan-mode / session-projection 是**可选**能力：用**动态 import + try/catch**，
  // 缺包或解析失败只记录原因，**绝不让本插件模块加载失败**。
  // 教训：曾经用顶层静态 import —— 一旦该包在宿主侧解析不到，整个插件模块 import 失败，
  // 连带 bundle 注册失败 → **preset 从会话列表消失**（症状离根因极远，排查代价很高）。
  void (async () => {
    try {
      const mod = (await import('@deepseek-ai/dsh-session-projection')) as { default?: unknown }
      // plan-mode 的依赖服务之一（sessionProjections）；它自身不需要额外服务，先装它。
      ctx.plugin((mod.default ?? mod) as never, {} as never)
    } catch (error) {
      planModeLoadError = 'sessionProjections: ' + (error instanceof Error ? error.message : String(error))
    }
    if (planModeLoadError === undefined) {
      try {
        const mod = (await import('@deepseek-ai/dsh-plan-mode')) as { default?: unknown }
        // 方案 D：section 必须是非空字符串（空配置会让构造在子 fiber 抛错、服务永不注册）
        ctx.plugin((mod.default ?? mod) as never, { section: t('planMode.section') } as never)
      } catch (error) {
        planModeLoadError = 'plan-mode: ' + (error instanceof Error ? error.message : String(error))
      }
    }
  })()

  ctx.inject(['planMode'], (planCtx) => {
    planMode = planCtx.get('planMode') as PlanModeLike
  })
  /** 派发后端探测（软探测：宿主没有对应服务就降级为 inline）。 */
  let subagentsService: unknown
  ctx.inject(['subagents'], (subCtx) => {
    subagentsService = subCtx.get('subagents')
  })
  const backendProbe = (): BackendProbe => ({
    subagent: subagentsService !== undefined,
    nativeTeam: false,
    inline: true,
  })
  let lastBackend: { backend: BackendKind; iteration?: number | undefined } | undefined

  /** 成本适配（M5）：tokenMeter 只给 token，没有货币能力；拿不到就如实说"不可得"。 */
  interface TokenMeterLike {
    measure(session: unknown): { promptTokens?: number; completionTokens?: number; inputTokens?: number; outputTokens?: number }
  }
  interface SubagentsLike {
    listDescendants(rootSessionId: unknown, signal?: AbortSignal): Promise<{ sessionId?: unknown }[]>
  }
  let tokenMeter: TokenMeterLike | undefined
  let subagentsApi: SubagentsLike | undefined
  /** 会话服务（备选 A）：注入路径只拿得到 scope，用它可以按 sessionId 反查会话头里的 cwd */
  let sessionsService: { get(id: string): { header?: { cwd?: unknown } } | undefined } | undefined
  ctx.inject(['sessions'], (sessionCtx) => {
    sessionsService = sessionCtx.get('sessions') as typeof sessionsService
  })
  ctx.inject(['tokenMeter'], (meterCtx) => {
    tokenMeter = meterCtx.get('tokenMeter') as TokenMeterLike
  })
  ctx.inject(['subagents'], (subCtx) => {
    subagentsApi = subCtx.get('subagents') as SubagentsLike
  })

  /**
   * 归集用量（设计 §10.2 / T-M5-01）。
   * 结算时刻 = **读取时刻**（不做增量累积，避免重复计数）。
   * 驾驶舱会话可直接测；子代理会话需要 session 树枚举 —— 拿不到就只报驾驶舱，并说明。
   */
  const collectUsage = async (agent: unknown): Promise<{ rows: UsageRow[]; available: boolean; note?: string | undefined }> => {
    if (tokenMeter === undefined) return { rows: [], available: false, note: t('uiIndex.k2') }
    const session = (agent as { session?: unknown } | undefined)?.session
    if (session === undefined) return { rows: [], available: false, note: t('uiIndex.k3') }
    const rows: UsageRow[] = []
    try {
      const measured = tokenMeter.measure(session)
      rows.push({
        sessionId: String((agent as { id?: unknown }).id ?? 'lead'),
        model: (settings as { model?: string }).model ?? 'unknown',
        promptTokens: measured.promptTokens ?? measured.inputTokens ?? 0,
        completionTokens: measured.completionTokens ?? measured.outputTokens ?? 0,
      })
    } catch (error) {
      return { rows: [], available: false, note: fmt('uiIndex.k4', { p1: error instanceof Error ? error.message : String(error) }) }
    }
    let note: string | undefined = t('uiIndex.k5')
    if (subagentsApi !== undefined) {
      try {
        const descendants = await subagentsApi.listDescendants((agent as { id?: unknown }).id)
        if (descendants.length > 0) {
          note = fmt('uiIndex.k6', { p1: descendants.length })
        } else {
          note = undefined
        }
      } catch {
        /* fail-open：枚举失败不影响主流程 */
      }
    }
    return { rows, available: true, ...(note === undefined ? {} : { note }) }
  }

  /**
   * 注入路径的定位：`AssembleContext` 只给 `scope`。
   * 1) 先按 scope 找到已登记会话（office.callForScope）；
   * 2) 若仍没有 cwd，用 `sessions.get(sessionId).header.cwd` 补上（诊断建议 A）——
   *    读不到就**不给 cwd**（宁可不出状态块，也不显示别的项目）。
   */
  // 注入路径与工具路径共用同一套解析（见 `interface/scope.ts` 的真机教训：宿主传的 scope 就是 agent 对象）
  const injectionCall = (scope: unknown): OfficeCall =>
    resolveScopeCall(scope, {
      fromMap: (id) => office.callForScope(id),
      fromSessions: (id) => {
        if (sessionsService === undefined) return undefined
        try {
          const cwd = sessionsService.get(id)?.header?.cwd
          return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
        } catch {
          return undefined
        }
      },
    })

  const planAdapter = {
    status(agent: unknown): { available: boolean; active: boolean } {
      // 没有 plan mode 服务、或这次调用拿不到 agent 引用 ⇒ 我们既不能驱动也不能查询计划评审，
      // 因此按 Q-20 视为"无交互评审通道"（绝不能假装进入了 plan mode）
      if (planMode === undefined || agent === undefined) return { available: false, active: false }
      try {
        return { available: true, active: planMode.get(agent).active === true }
      } catch {
        return { available: true, active: false }
      }
    },
    enter(agent: unknown): string {
      if (planMode === undefined || agent === undefined) return 'unavailable'
      try {
        return planMode.set(agent, true)
      } catch (error) {
        return `error:${error instanceof Error ? error.message : String(error)}`
      }
    },
  }

  // 会话 → 工作目录：所有 .sdo/ 操作都以此定位项目。
  ctx.on('session/created', (session: Session) => {
    office.noteSession(String(session.id), cwdOf(session))
  })

  /**
   * 语言：`show` 看当前语言与覆盖率；`set lang=<x>` 立即切换（**进程级**，重启前一直有效）。
   * 三条用户路径共用它：聊天里让模型调 `sdo_lang`、斜杠命令 `/sdo-lang`、配置 `lang` / 环境变量 `SDO_LANG`。
   */
  const langAction = async (input: { action?: string | undefined; lang?: string | undefined } | string): Promise<string> => {
    const requested = typeof input === 'string' ? input.trim() : input.action === 'set' ? (input.lang ?? '').trim() : ''
    if (requested !== '') {
      if (!LANGUAGES.includes(requested)) {
        return fmt('uiLang.unknown', { p1: requested, p2: LANGUAGES.join(' / ') })
      }
      setLocale(requested)
      return `${fmt('uiLang.switched', { p1: requested })}\n${describeLang({
        locale: locale(),
        base: LANGUAGES[0] ?? 'zh-CN',
        languages: LANGUAGES,
        covered: coveredBaseKeys(),
        extra: extraKeys(),
        total: baseKeyCount(),
      })}`
    }
    return describeLang({
      locale: locale(),
      base: LANGUAGES[0] ?? 'zh-CN',
      languages: LANGUAGES,
      covered: coveredBaseKeys(),
      extra: extraKeys(),
      total: baseKeyCount(),
    })
  }

  const deps = {
    lang: async (_call: OfficeCall, args: LangArgs): Promise<string> => langAction(args),
    langSwitch: async (input?: string | undefined): Promise<string> => langAction(input ?? ''),
    async init(call: OfficeCall, args: InitArgs): Promise<string> {
      // 缺关键参数时**先问**，不许用默认值悄悄立项（需求 2026-09-29）
      const gaps = initGaps({
        name: args.name,
        process: args.process,
        scale: args.scale,
        stakeholders: args.stakeholders,
      })
      if (gaps.length > 0) return renderInitQuestions(gaps)
      const result = office.init(call, args)
      return (
        describeInit(result, settings.projectDirName)
        + t('uiIndex.k7')
        + t('uiIndex.k8')
      )
    },

    async status(call: OfficeCall, args: { rebuild?: boolean | undefined }): Promise<string> {
      if (args.rebuild === true) office.rebuild(call)
      return describeStatus(office.status(call), settings.projectDirName)
    },

    async board(
      call: OfficeCall,
      args: { expand?: boolean | undefined; all?: boolean | undefined; write?: boolean | undefined },
    ): Promise<string> {
      const status = office.status(call)
      const model = {
        project: status.project,
        config: status.config,
        counts: status.counts,
        gates: office.gatesFor(call),
        requirements: office.boardRequirements(call),
        process: office.process(call),
        pendingGate: status.pendingGate,
        tasks: office.tasks(call),
        iteration: office.iteration(call),
        dataDirName: settings.projectDirName,
        truncated: status.truncated,
        ...(status.badLine === undefined ? {} : { badLine: status.badLine }),
      }
      const text = renderBoard(model, { expand: args.expand === true, all: args.all === true })
      if (args.write !== true) return text
      if (!settings.board.text) {
        return fmt('uiIndex.k139', { p1: text, p2: describeBoardNote(t('uiIndex.k138')) })
      }
      const workspace = office.requireWorkspace(call)
      const target = new SdoStore(workspace).writeText(['docs', 'BOARD.md'], text)
      return fmt('uiIndex.k127', { p1: text, p2: describeBoardNote(fmt('uiIndex.k126', { p1: office.relativize(workspace, target) })) })
    },

    async project(call: OfficeCall, args: ProjectArgs): Promise<string> {
      if (args.action === 'show') return describeProject(office.status(call), settings.projectDirName)
      if (args.action !== 'update') return fmt('uiIndex.k9', { p1: args.action })
      const result = office.updateProject(call, {
        name: args.name,
        process: args.process,
        scale: args.scale,
        scopeIn: args.scopeIn,
        scopeOut: args.scopeOut,
        stakeholders: args.stakeholders,
        metricsSuccess: args.metricsSuccess,
        glossary: args.glossary,
      })
      return describeProjectUpdate(result)
    },

    setBudget(call: OfficeCall, input: { total?: number | undefined; currency?: string | undefined; tiers?: number[] | undefined }): string {
      const budget = office.setBudget(call, input)
      return [
        fmt('uiIndex.m1', { p1: budget.total === undefined ? t('uiIndex.m2') : `${budget.currency} ${budget.total}` }),
        fmt('uiIndex.k10', { p1: budget.tiers.join(' / ') }),
        t('uiIndex.k11') + (Object.keys(settings.cost.prices).length === 0 ? t('uiIndex.k120') : Object.entries(settings.cost.prices).map(([model, price]) => `${model}=${price}`).join(' ')),
      ].join('\n')
    },

    decideBudget(call: OfficeCall, choice: string, note: string): string {
      if (choice !== 'add-budget' && choice !== 'waive' && choice !== 'narrow-scope') {
        return t('uiIndex.k12')
      }
      const budget = office.decideBudget(call, choice, note)
      const labels: Record<string, string> = { 'add-budget': t('uiIndex.k13'), waive: t('uiIndex.k14'), 'narrow-scope': t('uiIndex.k15') }
      return fmt('uiIndex.k16', { p1: labels[choice], p2: note, p3: budget.decisions.length })
    },

    async cost(call: OfficeCall, args: { action: string }): Promise<string> {
      if (args.action !== 'report') return fmt('uiIndex.k17', { p1: args.action })
      const source = await collectUsage(call.agent)
      const report = office.costReport(call, source)
      const lines = [report.line]
      if (!source.available) {
        lines.push(fmt('uiIndex.k18', { p1: source.note ?? t('uiIndex.k114') }) + t('uiIndex.k19'))
        return lines.join('\n')
      }
      if (source.note !== undefined) lines.push(fmt('uiIndex.k20', { p1: source.note }))
      if (report.summary.perModel.length > 0) {
        lines.push(fmt('uiIndex.k21', { p1: report.summary.perModel.map((row) => fmt('uiIndex.k129', { p1: row.model, p2: row.tokens, p3: row.priced ? '' : t('uiIndex.k128') })).join('；') }))
      }
      if (report.budget === undefined) {
        lines.push(t('uiIndex.k22'))
      } else {
        lines.push(fmt('uiIndex.k23', { p1: report.budget.total === undefined ? t('uiIndex.k121') : `${report.budget.currency} ${report.budget.total}`, p2: report.budget.askedTiers.join(' ') || t('uiIndex.k115') }))
        lines.push(fmt('uiIndex.k24', { p1: report.budget.tiers.join(' / ') }))
      }
      if (report.tier !== undefined) {
        office.markTierAsked(call, report.tier.tier)
        lines.push(fmt('uiIndex.k25', { p1: report.tier.message }))
      }
      if (report.advice !== undefined) lines.push(`- ${report.advice}`)
      return lines.join('\n')
    },

    async plan(call: OfficeCall, args: PlanArgs): Promise<string> {
      if (args.action === 'decompose') {
        const requirements = jsonOr<string[]>(args.requirements, 'requirements')
        if (requirements.error !== undefined) return requirements.error
        const suggestions = jsonOr<Record<string, unknown>[]>(args.suggestions, 'suggestions')
        if (suggestions.error !== undefined) return suggestions.error
        const result = office.planDecompose(call, {
          ...(requirements.value === undefined ? {} : { requirements: requirements.value }),
          ...(suggestions.value === undefined
            ? {}
            : {
                // **G-03**：改为「校验 + 透传」——旧实现是白名单，把 `requirements`/`goal`/`inputs`/
                // `outputs`/`blockedBy`/`evidenceRequired` 等**静默丢弃**，导致建议通道建出的卡
                // 永远没有需求链接（追溯静默漏掉这些卡）。
                suggestions: suggestions.value.map((row) => {
                  const list = (value: unknown): string[] | undefined =>
                    Array.isArray(value) ? value.map(String) : undefined
                  return {
                    title: String(row.title ?? t('uiIndex.k26')),
                    dod: Array.isArray(row.dod) ? row.dod.map(String) : [],
                    role: String(row.role ?? t('uiIndex.defaultRole')),
                    ...(typeof row.goal === 'string' ? { goal: row.goal } : {}),
                    ...(list(row.inputs) === undefined ? {} : { inputs: list(row.inputs) as string[] }),
                    ...(list(row.outputs) === undefined ? {} : { outputs: list(row.outputs) as string[] }),
                    ...(list(row.requirements) === undefined ? {} : { requirements: list(row.requirements) as string[] }),
                    ...(list(row.blockedBy) === undefined ? {} : { blockedBy: list(row.blockedBy) as string[] }),
                    ...(list(row.writeScopes) === undefined ? {} : { writeScopes: list(row.writeScopes) as string[] }),
                    ...(list(row.evidenceRequired) === undefined ? {} : { evidenceRequired: list(row.evidenceRequired) as never }),
                    ...(row.size === 'small' || row.size === 'medium' || row.size === 'large' ? { size: row.size } : {}),
                  }
                }),
              }),
          ...(office.iteration(call) === undefined ? {} : { iteration: office.iteration(call)?.number }),
        })
        const planSummary = describePlan(result.tasks, result.issues)
        return (result.notes ?? []).length === 0
          ? planSummary
          : `${planSummary}\n${fmt('uiIndex.scopeDerivedNote', { p1: (result.notes ?? []).join('、') })}`
      }

      if (args.action === 'iteration') {
        if ((args.goal ?? '').trim() === '') return t('uiIndex.k27')
        const iteration = office.startIteration(call, args.goal ?? '')
        return fmt('uiIndex.k28', { p1: iteration.number, p2: iteration.goal, p3: iteration.status })
      }

      if (args.action !== 'next') return fmt('uiIndex.k29', { p1: args.action })

      const plan = office.dispatchPlan(call)
      if (plan.dispatch.length === 0) {
        const issues = office.planIssues(call)
        if (issues.length > 0) return describePlan(office.tasks(call), issues)
        return plan.queued.length === 0
          ? t('uiIndex.k30')
          : fmt('uiIndex.k31', { p1: plan.queued.length, p2: settings.maxParallelDispatch })
      }

      const preference = args.backend === 'subagent' || args.backend === 'native-team' || args.backend === 'inline' ? args.backend : 'auto'
      const iteration = office.iteration(call)
      const decision = pickBackend(preference, backendProbe(), lastBackend, iteration?.number)
      const take = Math.max(1, Math.min(args.limit ?? 1, plan.dispatch.length))
      const picked = plan.dispatch.slice(0, take)
      const out: string[] = []
      for (const [index, task] of picked.entries()) {
        const owner = decision.backend === 'inline' ? 'cockpit' : `${decision.backend}:${task.role}:${index + 1}`
        const request = buildDispatch({ task, backend: decision.backend, owner, projectName: office.status(call).project?.name ?? '' })
        office.recordDispatch(call, {
          taskId: task.id,
          backend: decision.backend,
          owner,
          ...(decision.degradedReason === undefined ? {} : { degradedReason: decision.degradedReason }),
        })
        lastBackend = { backend: decision.backend, iteration: iteration?.number }
        out.push(
          decision.backend === 'inline'
            ? describeInlineHandoff(request, decision.degradedReason)
            : describeDispatch(request, decision.degradedReason),
        )
      }
      const tail = plan.queued.length === 0 ? '' : fmt('uiIndex.k32', { p1: plan.queued.length })
      return `${out.join('\n\n')}${tail}`
    },

    async task(call: OfficeCall, args: TaskArgs): Promise<string> {
      switch (args.action) {
        case 'drop': {
          // D3-3 回收路径：建错的卡置为 dropped（留痕不删除），把「误拆不可逆」变成可回收
          if (args.id === undefined) return t('uiIndex.k33')
          const dropped = office.dropTask(call, args.id, args.reason ?? t('uiIndex.dropNoReason'))
          return dropped === undefined ? fmt('uiIndex.k34', { p1: args.id }) : describeTask(dropped)
        }
        case 'claim': {
          if (args.id === undefined || args.owner === undefined || args.expectedRevision === undefined) {
            return t('uiIndex.k33')
          }
          const result = office.claimTask(call, { taskId: args.id, owner: args.owner, expectedRevision: args.expectedRevision })
          return result.ok ? describeTask(result.task) : describeTaskConflict(result.detail, result.current, result.code)
        }
        case 'done':
        case 'block': {
          if (args.id === undefined || args.owner === undefined) return t('uiIndex.k34')
          const evidence = jsonOr<{ kind: string; detail: string }[]>(args.evidence, 'evidence')
          if (evidence.error !== undefined) return evidence.error
          const items: EvidenceItem[] = (evidence.value ?? []).map((row) => ({
            kind: row.kind === 'command' || row.kind === 'workspace-changes' ? row.kind : 'artifact',
            detail: String(row.detail ?? ''),
            at: new Date().toISOString(),
          }))
          const result = office.reportTask(call, {
            taskId: args.id,
            owner: args.owner,
            status: args.action === 'done' ? 'done' : 'blocked',
            ...(items.length === 0 ? {} : { evidence: items }),
            ...(args.note === undefined ? {} : { note: args.note }),
          })
          return result.ok ? describeTask(result.task) : fmt('uiIndex.k35', { p1: result.code, p2: result.detail })
        }
        case 'release':
        case 'reassign': {
          if (args.id === undefined) return t('uiIndex.k36')
          const actor = args.actor ?? 'cockpit'
          const reason = args.reason ?? t('uiIndex.k37')
          const task =
            args.action === 'release'
              ? office.releaseTask(call, { taskId: args.id, actor, reason })
              : args.owner === undefined
                ? undefined
                : office.reassignTask(call, { taskId: args.id, actor, owner: args.owner, reason })
          if (task === undefined) return fmt('uiIndex.k132', { p1: args.action === 'reassign' && args.owner === undefined ? t('uiIndex.k130') : fmt('uiIndex.k131', { p1: args.id }) })
          return fmt('uiIndex.k135', { p1: args.action === 'release' ? t('uiIndex.k133') : t('uiIndex.k134'), p2: describeTask(task) })
        }
        case 'list':
        default:
          return describeTaskBoard({
            tasks: office.tasks(call),
            ready: office.readyForDispatch(call, 64),
            stale: office.staleTasks(call),
            issues: office.planIssues(call),
            iteration: office.iteration(call),
          })
      }
    },

    async test(call: OfficeCall, args: TestArgs): Promise<string> {
      switch (args.action) {
        case 'plan': {
          if ((args.title ?? '') === '' || (args.expected ?? '') === '') return t('uiIndex.k38')
          const steps = jsonOr<string[]>(args.steps, 'steps')
          if (steps.error !== undefined) return steps.error
          const testCase = office.addTestCase(call, {
            title: args.title ?? '',
            kind: args.kind ?? 'unit',
            ...(args.requirement === undefined ? {} : { requirement: args.requirement }),
            steps: steps.value ?? [],
            expected: args.expected ?? '',
          })
          return fmt('uiIndex.k39', { p1: testCase.id, p2: testCase.kind, p3: testCase.title, p4: testCase.requirement === undefined ? '' : fmt('uiIndex.k116', { p1: testCase.requirement }) })
        }
        case 'record': {
          if (args.caseId === undefined || args.status === undefined) return t('uiIndex.k40')
          if (args.status === 'pass' && (args.evidence ?? '').trim() === '') {
            return t('uiIndex.k41')
          }
          const result = office.addTestResult(call, {
            caseId: args.caseId,
            status: args.status === 'fail' ? 'fail' : args.status === 'skip' ? 'skip' : 'pass',
            evidence: args.evidence ?? '',
          })
          const stats = office.verification(call)
          return fmt('uiIndex.k42', { p1: result.id, p2: result.caseId, p3: result.status, p4: stats.cases, p5: stats.passed, p6: stats.failed, p7: stats.defectsOpen })
        }
        case 'defect': {
          if (args.defectId !== undefined) {
            const status = args.status === 'fixed' || args.status === 'closed' || args.status === 'wontfix' ? args.status : 'open'
            const defect = office.setDefectStatus(call, args.defectId, status)
            return defect === undefined ? fmt('uiIndex.k122', { p1: args.defectId }) : fmt('uiIndex.k43', { p1: defect.id, p2: defect.status })
          }
          if ((args.title ?? '') === '' || args.severity === undefined) return t('uiIndex.k44')
          const defect = office.addDefect(call, {
            title: args.title ?? '',
            severity: args.severity,
            ...(args.caseId === undefined ? {} : { caseId: args.caseId }),
            status: args.status === 'fixed' || args.status === 'closed' || args.status === 'wontfix' ? args.status : 'open',
          })
          return fmt('uiIndex.k45', { p1: defect.id, p2: defect.severity, p3: defect.status, p4: defect.title })
        }
        case 'list':
        default: {
          const stats = office.verification(call)
          const lines = [fmt('uiIndex.k118', { p1: stats.cases, p2: stats.results, p3: stats.passed, p4: stats.failed, p5: stats.skipped, p6: stats.defectsOpen, p7: stats.blockersOpen })]
          for (const testCase of office.testCases(call)) {
            lines.push(fmt('uiIndex.k137', { p1: testCase.id, p2: testCase.kind, p3: testCase.title, p4: testCase.requirement === undefined ? '' : fmt('uiIndex.k136', { p1: testCase.requirement }) }))
          }
          for (const defect of office.defects(call)) lines.push(`- ${defect.id}　[${defect.severity}/${defect.status}]　${defect.title}`)
          return lines.join('\n')
        }
      }
    },

    async review(call: OfficeCall, args: ReviewArgs): Promise<string> {
      if (args.action !== 'record') {
        const reviews = office.reviews(call)
        if (reviews.length === 0) return t('uiIndex.k46')
        return [
          fmt('uiIndex.m3', { p1: reviews.length }),
          ...reviews.map((review) => `- ${review.id}　${review.taskId}　${review.verdict}（${review.reviewer}）`),
          ...office.reviewViolations(call).map((item) => fmt('uiIndex.k47', { p1: item.detail })),
        ].join('\n')
      }
      if (args.taskId === undefined || args.reviewer === undefined || args.verdict === undefined) {
        return t('uiIndex.k48')
      }
      const findings = jsonOr<string[]>(args.findings, 'findings')
      if (findings.error !== undefined) return findings.error
      const task = office.taskById(call, args.taskId)
      if (task === undefined) return fmt('uiIndex.k49', { p1: args.taskId })
      if (task.owner === args.reviewer) {
        return fmt('uiIndex.k50', { p1: args.taskId, p2: args.reviewer })
      }
      const review = office.addReview(call, {
        taskId: args.taskId,
        reviewer: args.reviewer,
        verdict: args.verdict,
        findings: findings.value ?? [],
      })
      return fmt('uiIndex.k51', { p1: review.id, p2: review.taskId, p3: review.verdict, p4: review.reviewer, p5: task.owner === undefined ? '' : fmt('uiIndex.k117', { p1: task.owner }) })
    },

    async deliver(call: OfficeCall, args: DeliverArgs): Promise<string> {
      if (args.action !== 'package') {
        const manifest = office.manifest(call)
        return manifest === undefined ? t('uiIndex.k123') : describeManifest(manifest)
      }
      const artifacts = jsonOr<{ path: string; kind?: string }[]>(args.artifacts, 'artifacts')
      if (artifacts.error !== undefined) return artifacts.error
      if ((artifacts.value ?? []).length === 0) return t('uiIndex.k52')
      const acceptance = jsonOr<{ requirement: string; criterion: string; evidence: string; verdict?: string }[]>(args.acceptance, 'acceptance')
      if (acceptance.error !== undefined) return acceptance.error
      if ((args.rollbackPoint ?? '').trim() === '') return t('uiIndex.k53')
      const result = office.packageDelivery(call, {
        by: args.by ?? 'human',
        artifacts: (artifacts.value ?? []).map((row) => ({
          path: row.path,
          kind:
            row.kind === 'docs' || row.kind === 'config' || row.kind === 'schema' || row.kind === 'test'
              ? row.kind
              : 'source',
        })),
        acceptance: (acceptance.value ?? []).map((row) => ({
          requirement: row.requirement,
          criterion: row.criterion,
          evidence: row.evidence,
          verdict: row.verdict === 'fail' || row.verdict === 'waived' ? row.verdict : 'pass',
        })),
        rollbackPoint: args.rollbackPoint ?? '',
        ...(args.notes === undefined ? {} : { notes: args.notes }),
      })
      const docs = office.renderVerificationDocs(call)
      const lines = [describeManifest(result.manifest)]
      if (result.missingArtifacts.length > 0) lines.push(fmt('uiIndex.k54', { p1: result.missingArtifacts.join(' ') }))
      lines.push(fmt('uiIndex.k55', { p1: docs.join('、') }))
      return lines.join('\n')
    },

    async gate(call: OfficeCall, args: GateArgs): Promise<string> {
      if (args.action === 'advance') {
        return describeAdvance(office.advance(call))
      }
      if (args.action === 'waive') {
        if (args.gate === undefined) return t('uiIndex.k56')
        if ((args.reason ?? '').trim() === '' || (args.approver ?? '').trim() === '') {
          return t('uiIndex.k57')
        }
        const recorded = office.waiveGate(call, args.gate, args.reason ?? '', args.approver ?? '')
        return fmt('uiIndex.k58', { p1: gateLabel(recorded.gate), p2: args.approver, p3: args.reason, p4: describeGate(recorded) })
      }
      if (args.action !== 'check') return fmt('uiIndex.k59', { p1: args.action })
      if (args.gate === undefined) return t('uiIndex.k60')
      // 螺旋流程的风险象限门：先落本圈风险结论，再判定
      if (args.conclusion !== undefined) {
        office.concludeRisk(call, args.conclusion, args.rationale ?? args.reason ?? '', args.approvedBy ?? 'human')
      }
      return describeGate(office.checkGate(call, args.gate, args.approvedBy))
    },

    async feasibility(call: OfficeCall, args: FeasibilityArgs): Promise<string> {
      if (args.action !== 'assess') return fmt('uiIndex.k61', { p1: args.action })
      if (args.verdict === undefined) return t('uiIndex.k62')
      const telosRows = jsonOr<{ dimension?: string; verdict?: string; rationale?: string }[]>(args.telos, 'telos')
      if (telosRows.error !== undefined) return telosRows.error
      const telos: Partial<Record<'technical' | 'economic' | 'legal' | 'operational' | 'schedule', { verdict: string; rationale: string }>> = {}
      for (const row of telosRows.value ?? []) {
        const dimension = row.dimension
        if (dimension === 'technical' || dimension === 'economic' || dimension === 'legal' || dimension === 'operational' || dimension === 'schedule') {
          telos[dimension] = { verdict: row.verdict ?? t('uiIndex.k63'), rationale: row.rationale ?? '' }
        }
      }
      const poc = jsonOr<string[]>(args.poc, 'poc')
      if (poc.error !== undefined) return poc.error
      const assessment = office.assessFeasibility(
        call,
        {
          verdict: args.verdict,
          rationale: args.rationale ?? '',
          ...(Object.keys(telos).length === 0 ? {} : { telos }),
          ...(poc.value === undefined ? {} : { poc: poc.value }),
        },
        args.by ?? 'human',
      )
      return describeFeasibility(assessment)
    },

    async risk(call: OfficeCall, args: RiskArgs): Promise<string> {
      switch (args.action) {
        case 'log': {
          if ((args.title ?? '').trim() === '' || args.level === undefined) {
            return t('uiIndex.k64')
          }
          const risk = office.logRisk(call, {
            title: args.title ?? '',
            level: args.level,
            probability: args.probability ?? 'medium',
            impact: args.impact ?? '',
            mitigation: args.mitigation ?? '',
            owner: args.owner ?? '',
            ...(args.origin === undefined ? {} : { origin: args.origin }),
          })
          const lines = [fmt('uiIndex.k119', { p1: risk.id, p2: risk.level, p3: risk.title })]
          if (risk.mitigation.trim() === '' || risk.owner.trim() === '') {
            lines.push(t('uiIndex.k65'))
          }
          if (risk.origin !== undefined && risk.origin.startsWith('REQ-ISSUE-')) {
            lines.push(fmt('uiIndex.k66', { p1: risk.origin }))
          }
          return lines.join('\n')
        }
        case 'update': {
          if (args.id === undefined) return t('uiIndex.k67')
          const updated = office.updateRisk(call, args.id, {
            ...(args.status === undefined ? {} : { status: args.status }),
            ...(args.mitigation === undefined ? {} : { mitigation: args.mitigation }),
            ...(args.owner === undefined ? {} : { owner: args.owner }),
            ...(args.level === undefined ? {} : { level: args.level }),
            ...(args.impact === undefined ? {} : { impact: args.impact }),
          })
          if (updated === undefined) return fmt('uiIndex.k68', { p1: args.id })
          return fmt('uiIndex.k69', { p1: updated.id, p2: updated.status, p3: updated.level, p4: updated.title })
        }
        case 'conclude': {
          if (args.conclusion === undefined) return t('uiIndex.k70')
          const record = office.concludeRisk(call, args.conclusion, args.rationale ?? '', args.owner ?? 'human')
          return fmt('uiIndex.k71', { p1: record.conclusion, p2: record.rationale })
        }
        case 'list':
        default:
          return describeRisks(office.risks(call))
      }
    },

    async requirement(call: OfficeCall, args: RequirementArgs): Promise<string> {
      switch (args.action) {
        case 'capture': {
          if (typeof args.statement !== 'string' || args.statement.trim() === '') {
            return t('uiIndex.k72')
          }
          const dims = jsonOr<Partial<Record<Dimension, number>>>(args.dimensions, 'dimensions')
          if (dims.error !== undefined) return dims.error
          // **D2 修复**：schema 声明了 `acceptance`，旧实现从不读取 → 静默丢验收标准。
          // 现在解析并在**落盘时**写入（office 层支持，可测）。
          const acceptance = jsonOr<{ id?: string; given?: string; when?: string; then?: string }[]>(
            args.acceptance,
            'acceptance',
          )
          if (acceptance.error !== undefined) return acceptance.error
          const criteria: AcceptanceCriterion[] = (acceptance.value ?? []).map((item, index) => ({
            id: item.id ?? `AC-${String(index + 1).padStart(3, '0')}`,
            given: item.given ?? '',
            when: item.when ?? '',
            then: item.then ?? '',
          }))
          const fromPrototype = args.source === 'prototype'
          const result = office.capture(call, {
            title: args.title ?? args.statement.slice(0, 40),
            statement: args.statement,
            rationale: args.rationale,
            kind: args.kind,
            priority: args.priority,
            sourceStakeholder: fromPrototype ? undefined : (args.source ?? args.sourceStakeholder),
            sourceRaw: args.sourceRaw,
            prototypeSource: fromPrototype,
            modelDimensions: dims.value,
            acceptance: criteria,
          })
          const text = describeCapture(result)
          const withAcceptance = criteria.length === 0
            ? text
            : `${text}\n${fmt('uiIndex.acWritten', { n: criteria.length })}`
          return fromPrototype ? fmt('uiIndex.k124', { p1: withAcceptance }) : withAcceptance
        }

        case 'grill': {
          const ids = args.id === undefined ? office.requirements(call).map((requirement) => requirement.id) : [args.id]
          if (ids.length === 0) return t('uiIndex.k73')
          const limit = Math.max(1, Math.min(4, args.limit ?? 4))
          const result = office.grill(call, {
            requirementIds: ids,
            limit,
            quick: args.quick === true,
            includeBanned: true,
          })
          return [
            t('uiIndex.m4'),
            t('uiIndex.k74'),
            '',
            describeQuestions(result.questions, result.skipped),
          ].join('\n')
        }

        case 'answer': {
          if (args.id === undefined) return t('uiIndex.k75')
          const dims = jsonOr<Partial<Record<Dimension, number>>>(args.dimensions, 'dimensions')
          if (dims.error !== undefined) return dims.error
          if ((args.answer ?? '') === '' && args.assume !== true) {
            return t('uiIndex.k76')
          }
          const result = office.answer(call, {
            id: args.id,
            answer: args.answer ?? '',
            pickedOption: args.pickedOption,
            by: args.by,
            assume: args.assume === true,
            authorizedByUser: args.authorizedByUser === true,
            modelDimensions: dims.value,
          })
          if (result === undefined) return fmt('uiIndex.k77', { p1: args.id })
          return describeAnswer(result)
        }

        case 'update': {
          if (args.id === undefined) return t('uiIndex.k78')
          const acceptance = jsonOr<{ given?: string; when?: string; then?: string }[]>(args.acceptance, 'acceptance')
          if (acceptance.error !== undefined) return acceptance.error
          const dims = jsonOr<Partial<Record<Dimension, number>>>(args.dimensions, 'dimensions')
          if (dims.error !== undefined) return dims.error

          const store = office.storeFor(office.requireWorkspace(call))
          const rows = acceptance.value ?? []
          const ids = makeAcceptanceIds(store, rows.length)
          const criteria: AcceptanceCriterion[] = rows.map((row, index) => ({
            id: ids[index] ?? `AC-${index + 1}`,
            given: row.given ?? '',
            when: row.when ?? '',
            then: row.then ?? '',
          }))

          const patch = {
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.statement === undefined ? {} : { statement: args.statement }),
            ...(args.rationale === undefined ? {} : { rationale: args.rationale }),
            ...(args.kind === undefined ? {} : { kind: args.kind }),
            ...(args.priority === undefined ? {} : { priority: args.priority }),
            ...(args.sourceStakeholder === undefined && args.sourceRaw === undefined
              ? {}
              : {
                  source: {
                    ...(args.sourceStakeholder === undefined ? {} : { stakeholder: args.sourceStakeholder }),
                    ...(args.sourceRaw === undefined ? {} : { raw: args.sourceRaw }),
                  },
                }),
          }
          const result = office.update(call, {
            id: args.id,
            ...(Object.keys(patch).length === 0 ? {} : { patch }),
            ...(criteria.length === 0 ? {} : { addAcceptance: criteria }),
            modelDimensions: dims.value,
          })
          if (result === undefined) return fmt('uiIndex.k79', { p1: args.id })
          return describeRequirementUpdate(result)
        }

        case 'baseline': {
          if ((args.approvedBy ?? '').trim() === '') {
            return t('uiIndex.k80')
          }
          const outcome = office.baseline(call, { approvedBy: args.approvedBy })
          return describeBaseline(outcome)
        }

        case 'change': {
          if (args.id === undefined) return t('uiIndex.k81')
          if ((args.reason ?? '').trim() === '') return t('uiIndex.k82')
          if (args.decision === undefined) return t('uiIndex.k83')
          const patch = {
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(args.statement === undefined ? {} : { statement: args.statement }),
            ...(args.rationale === undefined ? {} : { rationale: args.rationale }),
            ...(args.priority === undefined ? {} : { priority: args.priority }),
            ...(args.kind === undefined ? {} : { kind: args.kind }),
          }
          const changes: string[] = []
          if (args.statement !== undefined) changes.push(fmt('uiIndex.k84', { p1: args.statement }))
          if (args.priority !== undefined) changes.push(fmt('uiIndex.k85', { p1: args.priority }))
          if (args.title !== undefined) changes.push(fmt('uiIndex.k86', { p1: args.title }))
          if (changes.length === 0) changes.push(t('uiIndex.k87'))
          return describeChange(
            office.change(call, {
              requirement: args.id,
              reason: args.reason ?? '',
              changes,
              decision: args.decision,
              decidedBy: args.decidedBy ?? args.by ?? 'human',
              ...(Object.keys(patch).length === 0 ? {} : { patch }),
            }),
          )
        }

        case 'list':
          return describeRequirementList(office.requirements(call))

        default:
          return fmt('uiIndex.k88', { p1: args.action })
      }
    },

    async redteam(call: OfficeCall, args: RedTeamArgs): Promise<string> {
      switch (args.action) {
        case 'attack': {
          const ids = args.ids ?? office.requirements(call).map((requirement) => requirement.id)
          if (ids.length === 0) return t('uiIndex.k89')
          const limit = Math.max(1, Math.min(7, args.limit ?? 4))
          const result = office.redTeamAttack(call, ids, limit)
          if (result.blocked !== undefined) return result.blocked
          return describeRedTeam('attack', { questions: result.questions, skipped: result.skipped })
        }
        case 'propose': {
          const ids = args.ids ?? office.requirements(call).map((requirement) => requirement.id)
          if (ids.length === 0) return t('redteam.proposeNone')
          return office.proposeRedTeam(call, ids, args.limit ?? 3)
        }
        case 'file': {
          if (args.requirementId === undefined) return t('redteam.fileNeedId')
          const parsed = jsonOr<{ text: string; dimension?: string }[]>(args.questions, 'questions')
          if (parsed.error !== undefined) return parsed.error
          const result = office.fileRedTeam(call, args.requirementId, parsed.value ?? [])
          const lines = [
            t('redteam.fileAccepted').replace('{n}', String(result.accepted.length)),
          ]
          for (const question of result.accepted) lines.push(`- ${question.id}｜${question.text}`)
          if (result.rejected.length > 0) {
            lines.push(t('redteam.fileRejected').replace('{n}', String(result.rejected.length)))
            for (const item of result.rejected) lines.push(`- ✗ ${item.text}｜${item.reason}`)
          }
          lines.push(t('redteam.fileAskHint'))
          return lines.join('\n')
        }
        case 'off':
        case 'on': {
          office.setRedTeam(call, args.action === 'on', args.reason)
          return describeRedTeam(args.action, { reason: args.reason })
        }
        case 'status':
        default:
          return describeRedTeam('status', {
            enabled: !office.redTeamDisabled(call),
            executed: office.redTeamExecuted(call),
          })
      }
    },

    async render(call: OfficeCall, args: { target?: string | undefined }): Promise<string> {
      const target = args.target ?? 'srs'
      if (target !== 'srs') return fmt('uiIndex.k90', { p1: target })
      const path = office.render(call, 'srs')
      const seq = office.journalFor(office.requireWorkspace(call)).read().events.length
      return describeRender('SRS', path, seq)
    },

    async design(call: OfficeCall, args: DesignArgs): Promise<string> {
      const action = args.action === '' ? 'view' : args.action
      if (action === 'view') return describeDesign(office.views(call), office.contracts(call))
      if (action === 'review') {
        // 出口之一：用户在本会话内评审完计划（无 plan mode 的宿主用它）
        office.markPlanApproved(call, args.approvedBy ?? 'human', args.note)
        return t('uiIndex.planReviewed')
      }
      if (action === 'waive-plan') {
        // 出口之二：显式豁免（设计 §8.5："可显式豁免并留痕"）
        office.waivePlanReview(call, args.reason ?? t('uiIndex.planWaiveNoReason'), args.by ?? 'human')
        return t('uiIndex.planWaived')
      }

      // 两道门：G2 已过 + 计划评审已完成（无交互评审通道时按 Q-20 阻塞）
      const outcome = office.designPrecondition(call, planAdapter.status(call.agent))
      switch (outcome.kind) {
        case 'no-project':
          return t('uiIndex.k91')
        case 'blocked-no-reviewer':
          return [
            t('uiIndex.planBlockedHead'),
            t('uiIndex.planExitReview'),
            t('uiIndex.planExitWaive'),
            fmt('uiIndex.planLoadDiag', {
              p1: planModeLoadError ?? (planModeLoadAttempted ? t('uiIndex.planLoadDeferred') : t('uiIndex.planLoadNone')),
            }),
            t('uiIndex.k92'),
            t('uiIndex.k93'),
            t('uiIndex.k94'),
            t('uiIndex.k95'),
          ].join('\n')
        case 'needs-plan-mode': {
          const result = planAdapter.enter(call.agent)
          if (result === 'unavailable' || result.startsWith('error')) {
            // 驱动失败也必须阻塞并留痕，而不是"以为进入了 plan mode"
            office.markPlanBlocked(call, 'plan mode could not be entered for this call')
            return [
              t('uiIndex.m5'),
              t('uiIndex.k96'),
              t('uiIndex.k97'),
            ].join('\n')
          }
          office.markPlanEntered(call)
          return [
            fmt('uiIndex.m6', { p1: result }),
            t('uiIndex.planChecklist'),
            t('uiIndex.k98'),
            t('uiIndex.k99'),
          ].join('\n')
        }
        case 'plan-review-pending':
          return t('uiIndex.k100')
        case 'gate-blocked':
          return describeDesignGate(outcome.check, action)
        case 'ready':
          break
      }

      if (action === 'drop-contract') {
        if ((args.id ?? '') === '') return t('uiIndex.dropContractMissing')
        const dropped = office.dropContract(call, args.id as string, args.reason ?? t('uiIndex.dropNoReason'))
        return dropped === undefined
          ? fmt('uiIndex.dropContractNotFound', { p1: args.id as string })
          : fmt('uiIndex.dropContractDone', { p1: dropped.id, p2: dropped.name })
      }
      if (action === 'contract') {
        if ((args.producer ?? '') === '' || (args.consumer ?? '') === '' || (args.schema ?? '') === '') {
          return t('uiIndex.k101')
        }
        const contract = office.recordContract(call, {
          ...(args.id === undefined ? {} : { id: args.id }),
          // D4-2：方向按字段语义写（producer → consumer），避免被误读成「方向写反」
          name: `${args.producer} → ${args.consumer}`,
          kind: parseContractKind(args.contractKind),
          producer: args.producer ?? '',
          consumer: args.consumer ?? '',
          schema: args.schema ?? '',
          failureSemantics: {
            timeout: args.timeout ?? '',
            retry: args.retry ?? '',
            idempotency: args.idempotency ?? '',
          },
        })
        const coverage = contractCoverage(office.storeFor(office.requireWorkspace(call)))
        return describeContract(contract, coverage)
      }

      if (action !== 'create') return fmt('uiIndex.k102', { p1: action })
      const kind = parseViewKind(args.kind)
      if (kind === undefined) return t('uiIndex.k103')
      if ((args.name ?? '') === '') return t('uiIndex.k104')
      const result = office.upsertElement(call, {
        kind,
        ...(args.id === undefined ? {} : { id: args.id }),
        name: args.name ?? '',
        elementKind: args.elementKind,
        responsibility: args.responsibility,
        dependsOn: parseList(args.dependsOn),
        summary: args.summary,
      })
      return describeDesignElement(result)
    },

    async adr(call: OfficeCall, args: AdrArgs): Promise<string> {
      switch (args.action) {
        case 'record':
        case 'supersede': {
          if ((args.title ?? '') === '' || (args.decision ?? '') === '') return t('uiIndex.k105')
          const alternatives = jsonOr<{ option: string; pros: string; cons: string }[]>(args.alternatives, 'alternatives')
          if (alternatives.error !== undefined) return alternatives.error
          const consequences = jsonOr<string[]>(args.consequences, 'consequences')
          if (consequences.error !== undefined) return consequences.error
          if ((alternatives.value ?? []).length === 0) {
            return t('uiIndex.k106')
          }
          if ((consequences.value ?? []).length === 0) {
            return t('uiIndex.k107')
          }
          const adr = office.recordAdr(call, {
            title: args.title ?? '',
            context: args.context ?? '',
            decision: args.decision ?? '',
            alternatives: alternatives.value ?? [],
            consequences: consequences.value ?? [],
            ...(args.action === 'supersede' && args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
          })
          return describeAdr(adr, args.supersedes)
        }
        case 'list':
        default:
          return describeAdrList(office.adrs(call))
      }
    },

    async quality(call: OfficeCall, args: QualityArgs): Promise<string> {
      switch (args.action) {
        case 'scenario': {
          if ((args.attribute ?? '') === '' || (args.measure ?? '') === '') {
            return t('uiIndex.k108')
          }
          if (!/\d/u.test(args.measure ?? '') && !/[≥≤<>]=?/u.test(args.measure ?? '')) {
            return fmt('uiIndex.k109', { p1: args.measure })
          }
          const scenario = office.recordScenario(call, {
            attribute: args.attribute ?? '',
            stimulus: args.stimulus ?? '',
            response: args.response ?? '',
            measure: args.measure ?? '',
            priority: args.priority,
            targets: parseList(args.targets),
          })
          return describeScenario(scenario)
        }
        case 'evaluate': {
          const risks = jsonOr<string[]>(args.risks, 'risks')
          if (risks.error !== undefined) return risks.error
          const sensitivities = jsonOr<string[]>(args.sensitivities, 'sensitivities')
          const tradeoffs = jsonOr<string[]>(args.tradeoffs, 'tradeoffs')
          const assessment = office.assessQuality(call, {
            risks: risks.value ?? [],
            sensitivities: sensitivities.value ?? [],
            tradeoffs: tradeoffs.value ?? [],
            by: args.by ?? 'human',
          })
          return describeAssessment(assessment)
        }
        case 'list':
        default:
          return describeScenarioList(office.scenarios(call))
      }
    },

    async trace(call: OfficeCall, args: TraceArgs): Promise<string> {
      switch (args.action) {
        case 'link': {
          const batch = jsonOr<{ from: string; to: string; kind: string }[]>(args.links, 'links')
          if (batch.error !== undefined) return batch.error
          const inputs =
            batch.value ??
            (args.from !== undefined && args.to !== undefined && args.kind !== undefined
              ? [{ from: args.from, to: args.to, kind: args.kind }]
              : [])
          if (inputs.length === 0) return t('uiIndex.k110')
          try {
            const result = office.linkTrace(call, inputs)
            const data = office.traceReport(call)
            return [
              fmt('uiIndex.m7', { p1: result.created, p2: inputs.length }),
              fmt('uiIndex.k111', { p1: Math.round(data.coverage * 100), p2: data.orphans.design.length, p3: data.orphans.tasks.length, p4: data.orphans.tests.length }),
              fmt('uiIndex.k112', { p1: data.uncoveredMust.length === 0 ? t('uiIndex.k125') : data.uncoveredMust.join(' ') }),
            ].join('\n')
          } catch (error) {
            return error instanceof Error ? error.message : String(error)
          }
        }
        case 'report': {
          const path = office.renderTrace(call)
          return fmt('uiIndex.k113', { p1: path })
        }
        case 'query':
        default:
          return describeTrace(office.traceReport(call))
      }
    },
  }

  if (settings.injectStatus) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      const systemPrompt = promptCtx.get('systemPrompt') as PromptSectionRegistry
      promptCtx.effect(() => systemPrompt.context({
        name: 'sdo-status',
        order: settings.promptOrder,
        // 取数回调只拿到 `AssembleContext.scope`：按作用域定位工作区（**不跨会话兜底、不用 process.cwd()**）。
        // 工作区未知（作用域对不上会话）时返回空文本 —— "空文本不贡献内容"，绝不显示别的项目。
        text: (context: { scope?: unknown }) => {
          try {
            return renderStatusBlock(
              office.status(injectionCall(context?.scope)),
              settings.projectDirName,
              settings.statusChars,
            )
          } catch {
            return ''
          }
        },
      }), 'sdo:status-block')
    })
  }

  if (settings.registerTools) {
    ctx.inject(['tools'], (toolCtx) => {
      const tools = toolCtx.get('tools') as ToolRuntime

      /**
       * L3 阶段纪律守卫（设计 §8.6 / T-M7-03）。
       * 只在 `gateLevel: strict` 下拦；**fail-open**：钩子自身异常一律放行
       * （纪律守卫绝不能变成"插件坏了就干不了活"）。
       */
      toolCtx.effect(() => {
        const off = (
          toolCtx as unknown as {
            on(event: string, listener: (exec: { name?: string; arguments?: unknown }, next: () => Promise<unknown>) => Promise<unknown>): () => void
          }
        ).on('tools/pre-execute', async (exec, next) => {
          try {
            const status = office.status(office.callForScope(undefined))
            const args = (exec.arguments ?? {}) as { path?: unknown; file?: unknown; paths?: unknown }
            const paths = [
              ...(typeof args.path === 'string' ? [args.path] : []),
              ...(typeof args.file === 'string' ? [args.file] : []),
              ...(Array.isArray(args.paths) ? args.paths.filter((item): item is string => typeof item === 'string') : []),
            ]
            const decision = disciplineOrAllow({
              gateLevel: settings.gateLevel,
              phase: status.project?.phase ?? '',
              role: 'cockpit',
              tool: String(exec.name ?? ''),
              paths,
              initialized: status.project !== undefined,
            })
            if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
          } catch {
            /* fail-open：钩子异常一律放行 */
          }
          return next()
        })
        return () => off()
      }, 'sdo:discipline-guard')

      for (const tool of createOfficeTools(deps)) {
        // 工具输出统一截断（防上下文膨胀）：完整内容在 .sdo/ 真源，回执里会说明如何重取
        const clampExecute = tool.execute as unknown as (args: unknown, exec: unknown) => unknown
        const clamped = {
          ...tool,
          execute: async (args: unknown, exec: unknown) => clampToolResult(String(await clampExecute(args, exec))),
        } as typeof tool
        toolCtx.effect(() => tools.register(clamped), `sdo:tool:${tool.name}`)
      }
    })
  }

  if (settings.registerCommands) {
    ctx.inject(['commands'], (commandCtx) => {
      const commands = commandCtx.get('commands') as CommandRuntime
      for (const command of createOfficeCommands(deps, settings.commandEcho === 'echo')) {
        commandCtx.effect(() => commands.register(command), `sdo:command:${command.name}`)
      }
    })
  }

  logger.debug(
    `sdo: ready (projectDir=${settings.projectDirName}, gateLevel=${settings.gateLevel}, `
    + `orchestrator=${settings.orchestrator}, tools=${settings.registerTools}, commands=${settings.registerCommands})`,
  )
}
