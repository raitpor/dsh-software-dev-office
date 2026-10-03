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
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'

import { boardModelFor, renderBoard } from './board/render.js'
import { Config, resolveSettings } from './config.js'
import { registerRoleCardsSkill } from './domain/skills.js'
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
  describeApplicability,
  describeBaseline,
  describeBoardNote,
  describeCapture,
  describeRequirementUpdate,
  describeChange,
  describeContract,
  describeDesign,
  describeDesignElement,
  describeDesignGate,
  describeDesignQuestions,
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
  describeRollback,
  describeRollbackTargets,
  describeScenario,
  describeScenarioList,
  describeSignature,
  describeSignatureWaiting,
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
import {
  designInteraction,
  joinReceiptParts,
  renderContractDirectionAnomalies,
  renderInvalidatedConfirmations,
  writeUiViewReceipt,
} from './interface/designReceipt.js'
import { decideBudgetReceipt, setBudgetReceipt } from './interface/budgetReceipt.js'
import { createOfficeCommands } from './interface/commands.js'
import { createOfficeTools, parseList } from './interface/tools.js'
import type { GateSignAnswer, LangArgs } from './interface/tools.js'
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
import {
  COST_ACTIONS,
  DESIGN_ACTIONS,
  FEASIBILITY_ACTIONS,
  GATE_ACTIONS,
  PLAN_ACTIONS,
  PROJECT_ACTIONS,
  REQUIREMENT_ACTIONS,
  VIEW_KINDS,
} from './types.js'
import type { AcceptanceCriterion, Dimension, EvidenceItem, ViewKind } from './types.js'
import { recordWorkspaceChanges } from './domain/workspaceChanges.js'

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

/**
 * 给"schema 上有、但这个动作不消费"的入参点名（**Z-3**）。
 *
 * 纪律：**不得静默**。旧实现里 `sdo_design action=create/contract` 传 `by` / `note`
 * 会被无声吞掉，调用方以为留了痕。返回空串表示没有这类入参（回执里整段不出现）。
 */
function unusedArgsNote(names: string[], values: (string | undefined)[]): string {
  const unused = names.filter((_name, index) => (values[index] ?? '').trim() !== '')
  return unused.length === 0 ? '' : fmt('uiIndex.unusedArgs', { p1: unused.join(' / ') })
}

/**
 * `viewsAbsent` 的入参归一（**m4**）。
 *
 * 旧实现的形状容错过宽：写 `["context"]`（数组项是字符串）会读成 `{kind: undefined}` →
 * 一个 `kind:''` 的幽灵条目（既不报"这是什么视图"，也不报"缺理由"）。
 * 现在与**文件侧读取**同一口径（`readApplicabilityChecked`）：字符串项 = `{ kind: 该字符串, why: '' }`，
 * 于是"没写理由"会被既有判据 `absentNoWhy` 明确判红；其它形状按原样报出（走 `viewIgnored`）。
 */
function normalizeAbsentView(item: unknown): { kind: string; why: string } {
  if (typeof item === 'string') return { kind: item, why: '' }
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const record = item as { kind?: unknown; why?: unknown }
    return {
      kind: typeof record.kind === 'string' ? record.kind : record.kind === undefined || record.kind === null ? '' : String(record.kind),
      why: typeof record.why === 'string' ? record.why : '',
    }
  }
  return { kind: item === undefined || item === null ? '' : String(item), why: '' }
}

/** 插件入口。 */
/**
 * **§4.2（评审员）**：只读入口的"读不动也要说得出话"包装。
 *
 * `status`/`evaluate`/`advance` 已在 office 层兜底，但 `office.requirements()` 这类**列表读取**
 * （以及 `boardRequirements`）仍会裸抛 —— 于是 `sdo_requirement action=list`、`/sdo-board`
 * 会以异常收场。这里统一转成**可读失败**（带相对路径，NFR-009）。
 */
function guardedRead<T>(label: string, read: () => T): { ok: true; value: T } | { ok: false; text: string } {
  try {
    return { ok: true, value: read() }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, text: fmt('uiIndex.truthReadFailed', { p1: label, p2: message }) }
  }
}

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
  /**
   * **角色卡索引技能（B2）**：把随包的 8 张角色卡注册为**一个**索引型 skill，让执行者按需加载。
   *
   * 为什么是可选、且用 `inject`：`skills` 是宿主服务，不在本包依赖里（不引入
   * `@deepseek-ai/dsh-skill`）；`inject` 在服务就绪时才跑回调 —— 服务不存在就静默不注册，
   * **绝不让本插件装配失败**（与 `planMode` / `subagents` 同一先例）。
   * 为什么只注册一个索引：技能目录（名字 + 描述）进每个会话的系统提示，8 条就是 8 行常驻 token。
   */
  ctx.inject(['skills'], (skillsCtx) => {
    // **disposer 归属**：`skills.register()` 的 effect 挂在**技能服务自己的 ctx** 上，
    // 所以返回值不会被本插件的 fiber 自动回收（插件热重载后目录里可能留旧正文，
    // 同层同名又是"首个胜出 + 告警"）。这里用 `skillsCtx.effect(...)` 把它挂到本插件的
    // fiber 上：卸载/重载时按逆序执行，注册随之撤销。
    skillsCtx.effect(() => {
      const outcome = registerRoleCardsSkill(skillsCtx.get('skills'))
      logger.debug({ registered: outcome.registered, reason: outcome.reason }, 'sdo: role-cards skill')
      return outcome.dispose ?? (() => {})
    }, 'sdo:role-cards-skill')
  })

  /**
   * **A2：采集 `workspace/changes`**（宿主 `session/event` 追加流的其中一个事件类型）。
   *
   * 只给**已经存在 `.sdo/`** 的工作区记账（不给无关会话造垃圾）；拿不到 `workspaceChanges` 服务
   * 或拿不到会话 cwd 就静默跳过 —— 采集失败只会让 `done` 如实回一句「本会话的写范围未对账」，
   * 绝不假装核对过。
   */
  ctx.on('session/event', (session, event) => {
    try {
      if (!settings.captureWorkspaceChanges) return
      if ((event as { type?: string }).type !== 'workspace/changes') return
      const header = (session as { header?: { id?: unknown; cwd?: unknown } }).header
      const sessionId = typeof header?.id === 'string' ? header.id : undefined
      const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
      if (sessionId === undefined || cwd === undefined) return
      office.noteSession(sessionId, cwd)
      const store = office.storeFor(cwd)
      if (!existsSync(store.path())) return
      const changes = (ctx as unknown as { get?: (name: string) => unknown }).get?.('workspaceChanges') as
        | { summary?: (id: string, seq: number) => { turn?: number; files?: { path?: string; display?: string }[] } | undefined }
        | undefined
      const seq = Number((event as { seq?: unknown }).seq)
      if (!Number.isFinite(seq)) return
      recordWorkspaceChanges({ store, sessionId, seq, summary: changes?.summary?.(sessionId, seq), enabled: true })
    } catch {
      /* fail-open：采集失败不影响任何写操作（只是 `done` 会如实报"未对账"） */
    }
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

  // —————————————— 增量 1：设计阶段的交互回执（全部文案走语言包） ——————————————
  //
  // 回执渲染与交互校验统一在 `interface/designReceipt.ts`：**模型工具与斜杠命令共用同一份
  // 实现**，否则两条入口迟早说法不一致。这里只保留界面视图（`view kind=ui`）的渲染。

  /** `sdo_design action=view kind=ui`：界面视图 + 含 UI 判定（三态）。 */
  const renderUiView = (call: OfficeCall): string => {
    const { view, check, decision } = office.uiView(call)
    const lines: string[] = [t('uiDesign.uiViewHeader')]
    lines.push(`- ${t('uiDesign.docUiNaBasis')}：${decision.reason}`)
    if (!decision.hasUi) {
      // 判定为假：显式 N/A + 理由（既不是失败，也不是通过）
      lines.push(`- ${fmt('uiDesign.uiViewNa', { p1: decision.reason })}`)
      return lines.join('\n')
    }
    if (view === undefined) {
      lines.push(`- ${t('uiDesign.uiViewEmpty')}`)
      return lines.join('\n')
    }
    lines.push(`- ${view.id}｜${t('uiDesign.uiViewStyle')}：${view.style.source}（${view.style.rationale}）`)
    const tokens = Object.entries(view.style.tokens)
    lines.push(`- ${t('uiDesign.docUiTokens')}：${tokens.length === 0 ? t('uiDesign.docEmpty') : tokens.map(([k, v]) => `${k}=${v}`).join('；')}`)
    lines.push(`- ${t('uiDesign.uiViewScreens')}：${view.screens.length === 0 ? t('uiDesign.uiScreensNa') : ''}`)
    for (const screen of view.screens) {
      lines.push(`- ${screen.id}｜${screen.name}`)
      lines.push(`  - ${t('uiDesign.docUiColumns')}：${screen.columns.map((column) => `${column.name}(${column.kind})`).join('、')}`)
      lines.push(`  - ${t('uiDesign.docUiLayout')}：${screen.layout.grid}｜${screen.layout.regions.join(' / ')}`)
      lines.push(`  - ${t('uiDesign.docRequires')}：${screen.requires.length === 0 ? t('uiDesign.uiDraftNoSource') : screen.requires.join(' ')}`)
    }
    lines.push(`- ${t('uiDesign.docUiBreakpoints')}：${view.breakpoints.length === 0 ? t('uiDesign.docEmpty') : view.breakpoints.map((item) => `${item.name}(${item.width})`).join('、')}`)
    lines.push(`- ${t('uiDesign.docUiA11y')}：${t('uiDesign.docUiContrast')} ${view.accessibility.contrast === '' ? t('uiDesign.docEmpty') : view.accessibility.contrast}｜${t('uiDesign.docUiKeyboard')} ${view.accessibility.keyboard ? t('uiDesign.docYes') : t('uiDesign.docNo')}`)
    lines.push(`- ${t('uiDesign.uiViewConfirm')}：${check.ok ? t('uiDesign.uiViewConfirmed') : `${t('uiDesign.uiViewUnconfirmed')}（${[...check.missing, ...check.unconfirmed].join(' ')}）`}`)
    lines.push(t('uiDesign.uiViewAuthorHint'))
    return lines.join('\n')
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
      // **③b（本轮核实）**：旧实现把 `office.rebuild()` 的返回值**丢掉**了 —— 用户显式 `--rebuild` 之后，
      // 回执既不说明"已强制重建"，也不说明"真源被截断、本次只折叠到最后一致前缀（可能回退阶段）"，
      // 而 `status.rebuilt` 在这一次读取里必然是 false（投影刚被写过），于是回执看起来"什么都没发生"。
      const forced = args.rebuild === true ? office.rebuild(call) : undefined
      const text = describeStatus(office.status(call), settings.projectDirName, office.shapeNotes(call))
      if (forced === undefined) return text
      const note = forced.truncated
        ? fmt('uiIndex.kRebuildTruncated', { p1: String(forced.badLine ?? '?') })
        : t('uiIndex.kRebuildForced')
      return `${note}\n${text}`
    },

    async board(
      call: OfficeCall,
      args: { expand?: boolean | undefined; all?: boolean | undefined; write?: boolean | undefined },
    ): Promise<string> {
      const status = office.status(call)
      // **§4.1/§4.2（评审员）**：看板装配抽到 `boardModelFor`（可测、读不动也能出图、truthError 进正文）
      const { model } = boardModelFor(office, status, call, settings.projectDirName)
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
      if (args.action !== 'update') return fmt('uiIndex.k9', { p1: args.action, p2: PROJECT_ACTIONS.join(' | ') })
      const result = office.updateProject(call, {
        name: args.name,
        process: args.process,
        scale: args.scale,
        scopeIn: args.scopeIn,
        scopeOut: args.scopeOut,
        stakeholders: args.stakeholders,
        metricsSuccess: args.metricsSuccess,
        glossary: args.glossary,
        surfaces: args.surfaces,
      })
      return describeProjectUpdate(result)
    },

    setBudget(call: OfficeCall, input: { total?: number | undefined; currency?: string | undefined; tiers?: number[] | undefined }): string {
      // 与命令面同一份实现（`budgetReceipt.ts`）：回执与"非法选择被拒绝"都在那里，测试可直接复用
      return setBudgetReceipt(office, call, input, settings.cost.prices)
    },

    decideBudget(call: OfficeCall, choice: string, note: string): string {
      return decideBudgetReceipt(office, call, choice, note)
    },

    async cost(call: OfficeCall, args: { action: string }): Promise<string> {
      if (args.action !== 'report') return fmt('uiIndex.k17', { p1: args.action, p2: COST_ACTIONS.join(' | ') })
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
        const planSummary = describePlan(result.tasks, result.issues, office.shapeNotes(call))
        return (result.notes ?? []).length === 0
          ? planSummary
          : `${planSummary}\n${fmt('uiIndex.scopeDerivedNote', { p1: (result.notes ?? []).join('、') })}`
      }

      if (args.action === 'iteration') {
        if ((args.goal ?? '').trim() === '') return t('uiIndex.k27')
        const iteration = office.startIteration(call, args.goal ?? '')
        return fmt('uiIndex.k28', { p1: iteration.number, p2: iteration.goal, p3: iteration.status })
      }

      if (args.action !== 'next') return fmt('uiIndex.k29', { p1: args.action, p2: PLAN_ACTIONS.join(' | ') })

      const plan = office.dispatchPlan(call)
      if (plan.dispatch.length === 0) {
        const issues = office.planIssues(call)
        if (issues.length > 0) return describePlan(office.tasks(call), issues, office.shapeNotes(call))
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
          return dropped === undefined ? fmt('uiIndex.k34', { p1: args.id }) : describeTask(dropped, office.shapeNotes(call))
        }
        case 'claim': {
          if (args.id === undefined || args.owner === undefined || args.expectedRevision === undefined) {
            return t('uiIndex.k33')
          }
          const result = office.claimTask(call, { taskId: args.id, owner: args.owner, expectedRevision: args.expectedRevision })
          return result.ok ? describeTask(result.task, office.shapeNotes(call)) : describeTaskConflict(result.detail, result.current, result.code)
        }
        case 'done':
        case 'block': {
          if (args.id === undefined || args.owner === undefined) return t('uiIndex.k34')
          const evidence = jsonOr<{ kind: string; detail: string; exitCode?: unknown }[]>(args.evidence, 'evidence')
          if (evidence.error !== undefined) return evidence.error
          const items: EvidenceItem[] = (evidence.value ?? []).map((row) => ({
            kind: row.kind === 'command' || row.kind === 'workspace-changes' ? row.kind : 'artifact',
            detail: String(row.detail ?? ''),
            at: new Date().toISOString(),
            // A1：`command` 证据可带退出码（给了就必须为 0 才算完成）
            ...(row.exitCode === undefined ? {} : { exitCode: Number(row.exitCode) }),
          }))
          const result = office.reportTask(call, {
            taskId: args.id,
            owner: args.owner,
            status: args.action === 'done' ? 'done' : 'blocked',
            ...(items.length === 0 ? {} : { evidence: items }),
            ...(args.note === undefined ? {} : { note: args.note }),
          })
          if (!result.ok) return fmt('uiIndex.k35', { p1: result.code, p2: result.detail })
          const taskText = describeTask(result.task, office.shapeNotes(call))
          // A2：采集不到变更清单时**如实说**"写范围未对账"，不让"没数据"读成"已核对"
          return result.workspaceAudit !== undefined && !result.workspaceAudit.checked
            ? taskText + '\n' + t('uiIndex.kWorkScopeNotAudited')
            : taskText
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
          return fmt('uiIndex.k135', { p1: args.action === 'release' ? t('uiIndex.k133') : t('uiIndex.k134'), p2: describeTask(task, office.shapeNotes(call)) })
        }
        case 'list':
        default:
          return describeTaskBoard({
            tasks: office.tasks(call),
            ready: office.readyForDispatch(call, 64),
            stale: office.staleTasks(call),
            issues: office.planIssues(call),
            iteration: office.iteration(call),
            shapeNotes: office.shapeNotes(call),
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
        return manifest === undefined ? t('uiIndex.k123') : describeManifest(manifest, office.shapeNotes(call))
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
      const lines = [describeManifest(result.manifest, office.shapeNotes(call))]
      if (result.missingArtifacts.length > 0) lines.push(fmt('uiIndex.k54', { p1: result.missingArtifacts.join(' ') }))
      lines.push(fmt('uiIndex.k55', { p1: docs.join('、') }))
      return lines.join('\n')
    },

    async gate(call: OfficeCall, args: GateArgs): Promise<string> {
      if (args.action === 'advance') {
        return describeAdvance(office.advance(call))
      }
      if (args.action === 'rollback') {
        // §6.1 阶段回退：设计阶段发现需求问题 → 回退需求阶段（须有 reason + 合法回退边）
        if (args.to === undefined) return t('uiIndex.kRollbackNoTarget')
        const result = office.rollbackPhase(call, {
          to: args.to,
          reason: args.reason ?? '',
          ...(args.approvedBy === undefined ? {} : { by: args.approvedBy }),
        })
        return result.ok
          ? describeRollback(result)
          : `${result.error ?? ''}\n${describeRollbackTargets(office.rollbackTargets(call))}`
      }
      if (args.action === 'sign') {
        // §7.2 门禁级签字：**只承认两种来源**，且必须带上用户原话／所选选项原文
        if (args.gate === undefined) return t('uiIndex.k60')
        if (args.channel === 'question') {
          const answer = await deps.gateSignQuestion?.(call, args.gate)
          if (answer === undefined) return t('uiIndex.kSignNoChannel')
          if (answer.selectedLabel !== t('uiSign.signOption')) {
            return fmt('uiIndex.kSignDeclined', { p1: gateLabel(args.gate), p2: answer.selectedLabel })
          }
          const signature = office.signGate(call, {
            gate: args.gate,
            by: args.approvedBy ?? 'human',
            // 引用 = **用户所选选项原文**（由本工具自己取回，不经过模型）
            basis: answer.selectedLabel,
            channel: 'question',
            ...(args.turn === undefined ? {} : { turn: args.turn }),
          })
          return describeSignature(signature, office.signatureState(call, args.gate))
        }
        // `channel=statement`（默认）：用户在会话中明确表述过 → 必须给出用户原话
        const quote = (args.quote ?? '').trim()
        if (quote === '') return t('uiIndex.kSignNoQuote')
        // 引用要能在**会话记录**里找到（拿不到会话历史时退回"引用非空"的规格最低要求）；
        // **R-7**：核对口径随签字一起落台账，回执与门禁 detail 会如实标注"未核对"。
        const quoteCheck = office.checkUserQuote(call, quote)
        if (!quoteCheck.ok) return t('uiIndex.kSignQuoteMismatch')
        const signature = office.signGate(call, {
          gate: args.gate,
          by: args.approvedBy ?? 'human',
          basis: quote,
          channel: 'command',
          basisChecked: quoteCheck.basisChecked,
          ...(args.turn === undefined ? {} : { turn: args.turn }),
        })
        return describeSignature(signature, office.signatureState(call, args.gate))
      }
      if (args.action === 'waive') {
        if (args.gate === undefined) return t('uiIndex.k56')
        if ((args.reason ?? '').trim() === '' || (args.approver ?? '').trim() === '') {
          return t('uiIndex.k57')
        }
        const recorded = office.waiveGate(call, args.gate, args.reason ?? '', args.approver ?? '')
        return fmt('uiIndex.k58', { p1: gateLabel(recorded.gate), p2: args.approver, p3: args.reason, p4: describeGate(recorded) })
      }
      if (args.action !== 'check') return fmt('uiIndex.k59', { p1: args.action, p2: GATE_ACTIONS.join(' | ') })
      if (args.gate === undefined) return t('uiIndex.k60')
      // 螺旋流程的风险象限门：先落本圈风险结论，再判定
      if (args.conclusion !== undefined) {
        office.concludeRisk(call, args.conclusion, args.rationale ?? args.reason ?? '', args.approvedBy ?? 'human')
      }
      const evaluation = office.checkGate(call, args.gate, args.approvedBy)
      const blocks = [describeGate(evaluation)]
      // §7.2：G3 未签字时，回执必须明确写「等待用户签字确认」——而不是让模型自己猜
      if (evaluation.gate === 'G3') {
        const signature = office.signatureState(call, 'G3')
        if (signature.status !== 'valid') blocks.push(describeSignatureWaiting(signature))
      }
      return blocks.join('\n')
    },

    /**
     * **门禁签字的人机关口问答通道**（§7.2 来源②）。
     *
     * 与 `@deepseek-ai/dsh-plan-mode` 的先例一致：`ctx.get('userQuestions')` 现取服务、
     * 带上**活的 agent** 与取消信号发问，再把**用户所选选项的原文**原样返回。
     * 关键：`basis` 由此**不经过模型** —— 模型无法凭空调出这句话。
     *
     * 宿主没装配该服务（headless / 精简装配）时返回 `undefined`：
     * 回执会要求改用 `channel=statement` 并给出用户原话（规格承认的第二来源）。
     */
    async gateSignQuestion(call: OfficeCall, gate: string): Promise<GateSignAnswer | undefined> {
      // 动态取服务：本包**不**把 dsh-user-questions 声明为依赖（只有 plan-mode 的依赖树里才有），
      // 静态 import 会在未装配它的宿主上让整个插件模块加载失败。
      const interaction = (ctx as unknown as {
        get?: (name: string) => {
          ask?: (request: {
            questions: {
              id: string
              header?: string
              question: string
              detail?: string
              options?: { label: string; description?: string }[]
            }[]
            agent?: unknown
            signal?: AbortSignal
          }) => Promise<{ answers?: { id?: string; selected?: string[]; custom?: string }[] }>
        } | undefined
      }).get?.('userQuestions')
      const ask = interaction?.ask
      if (ask === undefined) return undefined
      const questionId = 'sdo-gate-sign'
      const signLabel = t('uiSign.signOption')
      const declineLabel = t('uiSign.declineOption')
      const answer = await ask.call(interaction, {
        questions: [
          {
            id: questionId,
            header: t('uiSign.header'),
            question: fmt('uiSign.question', { p1: gateLabel(gate) }),
            detail: t('uiSign.detail'),
            options: [
              { label: signLabel, description: t('uiSign.signCost') },
              { label: declineLabel, description: t('uiSign.declineCost') },
            ],
          },
        ],
        ...(call.agent === undefined ? {} : { agent: call.agent }),
      })
      const item = (answer.answers ?? []).find((entry) => entry.id === questionId)
      if (item === undefined) return undefined
      const selected = (item.selected ?? [])[0]
      if (selected === undefined || selected === '') {
        const custom = (item.custom ?? '').trim()
        return custom === '' ? undefined : { selectedLabel: custom, custom }
      }
      return { selectedLabel: selected, ...(item.custom === undefined ? {} : { custom: item.custom }) }
    },

    async feasibility(call: OfficeCall, args: FeasibilityArgs): Promise<string> {
      if (args.action !== 'assess') return fmt('uiIndex.k61', { p1: args.action, p2: FEASIBILITY_ACTIONS.join(' | ') })
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
      return describeFeasibility(assessment, office.shapeNotes(call))
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
          const riskList = guardedRead('risks', () => office.risks(call))
          if (!riskList.ok) return riskList.text
          return describeRisks(riskList.value)
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
          // **M8（本报告）**：旧实现在 `item.id` 缺失时用 `AC-${index+1}` 补齐、**不查全局** ——
          // 两条需求各自的第一条 AC 都会叫 `AC-001`（实测台账里 REQ-001 与 REQ-012 重号），
          // 交付验收矩阵按 AC-id 追溯即错配，而 C3 不做唯一性检查所以不会红。
          // 现在与 `update` 路径一样用 `makeAcceptanceIds` 统一发号（全局唯一）。
          const captureRows = acceptance.value ?? []
          const captureIds = makeAcceptanceIds(office.storeFor(office.requireWorkspace(call)), captureRows.length)
          const criteria: AcceptanceCriterion[] = captureRows.map((item, index) => ({
            id: item.id ?? captureIds[index] ?? `AC-${String(index + 1).padStart(3, '0')}`,
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
          const text = describeCapture(result, office.shapeNotes(call))
          const withAcceptance = criteria.length === 0
            ? text
            : `${text}\n${fmt('uiIndex.acWritten', { n: criteria.length })}`
          return fromPrototype ? fmt('uiIndex.k124', { p1: withAcceptance }) : withAcceptance
        }

        case 'grill': {
          const grillIds = guardedRead('requirements', () => office.requirements(call))
          if (!grillIds.ok) return grillIds.text
          const ids = args.id === undefined ? grillIds.value.map((requirement) => requirement.id) : [args.id]
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
            describeQuestions(result.questions, result.skipped, office.shapeNotes(call)),
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
          return describeAnswer(result, office.shapeNotes(call), { dimensionsGiven: dims.value !== undefined })
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
          // **R-2**：`acceptanceMode=replace` 走"整份替换"入口 —— 存量 AC 重号（C9 判红）
          // 必须有可执行的改号/删除路径，否则判据给的补救按提示做不完。
          const mode = args.acceptanceMode ?? 'append'
          if (mode !== 'append' && mode !== 'replace') {
            return fmt('uiIndex.kAcceptanceModeInvalid', { p1: mode })
          }
          const replace = mode === 'replace'
          const result = office.update(call, {
            id: args.id,
            ...(Object.keys(patch).length === 0 ? {} : { patch }),
            ...(criteria.length === 0
              ? {}
              : replace
                ? { replaceAcceptance: criteria }
                : { addAcceptance: criteria }),
            modelDimensions: dims.value,
          })
          if (result === undefined) return fmt('uiIndex.k79', { p1: args.id })
          return describeRequirementUpdate(result, office.shapeNotes(call))
        }

        case 'baseline': {
          // D1：`approvedBy` **不再是必填、也不再放行** —— 放行依据是签字台账里的 G2 签字
          // （`sdo_gate action=sign gate=G2 quote=…`）。传了就在 C7 的 detail 里作为
          // 附加信息如实显示，不静默忽略；没传也不拦（真正的门槛在 C7）。
          const outcome = office.baseline(call, {
            ...(args.approvedBy === undefined ? {} : { approvedBy: args.approvedBy }),
          })
          return describeBaseline(outcome, { applicabilityDeclared: office.applicability(call) !== undefined })
        }

        case 'change': {
          if (args.id === undefined) return t('uiIndex.k81')
          if ((args.reason ?? '').trim() === '') return t('uiIndex.k82')
          if (args.decision === undefined) return t('uiIndex.k83')
          // §6.7：变更路径可以**显式重给**语义分；不给则沿用需求上已落盘的模型维度。
          const dims = jsonOr<Partial<Record<Dimension, number>>>(args.dimensions, 'dimensions')
          if (dims.error !== undefined) return dims.error
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
              ...(dims.value === undefined ? {} : { dimensions: dims.value }),
            }),
            office.shapeNotes(call),
          )
        }

        case 'list':
          const list = guardedRead('requirements', () => office.requirements(call))
          if (!list.ok) return list.text
          return describeRequirementList(list.value, office.shapeNotes(call))

        // —————————————— §7.1 / §7.2：需求阶段的规划级设计问题 + 设计适用性声明 ——————————————

        case 'design-questions': {
          // 方法论选择题属于**需求/规划决策**，在这里（需求阶段）提出，复用同一个问题账本。
          const asked = office.askDesignQuestions(call, {
            ...(args.rationale === undefined
              ? {}
              : { recommendation: { method: args.answer ?? '', rationale: args.rationale } }),
            ...(args.by === undefined ? {} : { by: args.by }),
          })
          if (asked === undefined) return t('uiIndex.kApplicabilityNoProject')
          return describeDesignQuestions(asked.question, asked.created)
        }

        case 'applicability': {
          if ((args.focus ?? '').trim() === '') return t('uiIndex.kApplicabilityNoFocus')
          const present = jsonOr<string[]>(args.viewsPresent, 'viewsPresent')
          if (present.error !== undefined) return present.error
          const absent = jsonOr<unknown[]>(args.viewsAbsent, 'viewsAbsent')
          if (absent.error !== undefined) return absent.error
          const artifacts = jsonOr<string[]>(args.artifacts, 'artifacts')
          if (artifacts.error !== undefined) return artifacts.error
          // D5：`artifactsAbsent` 与 `viewsAbsent` 同一份入参归一（同一口径、同一报错方式）。
          const artifactsAbsent = jsonOr<unknown[]>(args.artifactsAbsent, 'artifactsAbsent')
          if (artifactsAbsent.error !== undefined) return artifactsAbsent.error
          const declaration = office.draftApplicability(call, {
            focus: args.focus ?? '',
            ...(present.value === undefined ? {} : { viewsPresent: present.value }),
            ...(absent.value === undefined ? {} : { viewsAbsent: absent.value.map((item) => normalizeAbsentView(item)) }),
            ...(artifacts.value === undefined ? {} : { artifacts: artifacts.value }),
            ...(artifactsAbsent.value === undefined
              ? {}
              : { artifactsAbsent: artifactsAbsent.value.map((item) => normalizeAbsentView(item)) }),
            ...(args.by === undefined ? {} : { by: args.by }),
          })
          const check = office.applicabilityCheck(call)
          return describeApplicability(declaration, check.problems, office.shapeNotes(call))
        }

        case 'applicability-confirm': {
          if ((args.basis ?? '').trim() === '') return t('uiIndex.kApplicabilityNoBasis')
          const confirmed = office.confirmApplicability(call, args.basis ?? '', args.by ?? 'human')
          if (confirmed === undefined) return t('uiIndex.kApplicabilityMissingToConfirm')
          return describeApplicability(confirmed, [], office.shapeNotes(call))
        }

        default:
          return fmt('uiIndex.k88', { p1: args.action, p2: REQUIREMENT_ACTIONS.join(' | ') })
      }
    },

    async redteam(call: OfficeCall, args: RedTeamArgs): Promise<string> {
      switch (args.action) {
        case 'attack': {
          const reqIds = guardedRead('requirements', () => office.requirements(call))
          if (!reqIds.ok) return reqIds.text
          const ids = args.ids ?? reqIds.value.map((requirement) => requirement.id)
          if (ids.length === 0) return t('uiIndex.k89')
          const limit = Math.max(1, Math.min(7, args.limit ?? 4))
          const result = office.redTeamAttack(call, ids, limit)
          if (result.blocked !== undefined) return result.blocked
          return describeRedTeam('attack', { questions: result.questions, skipped: result.skipped })
        }
        case 'propose': {
          const reqIds = guardedRead('requirements', () => office.requirements(call))
          if (!reqIds.ok) return reqIds.text
          const ids = args.ids ?? reqIds.value.map((requirement) => requirement.id)
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
      // —————————————— 增量 1：设计交互闭环（A）+ 界面视图（C）+ 设计文档（D） ——————————————
      // 这五个动作**必须在门禁之前**处理：它们正是用来把门禁缺的东西问出来、确认掉的。
      // 若它们也被 G3 前置拦住，"未与我交流"就永远无解（§1.3）。
      if (
        action === 'grill'
        || action === 'answer'
        || action === 'issues'
        || action === 'confirm'
        || action === 'render'
        // 增量 2：方法包的选择查看与产物写入同样必须在门禁之前（否则缺产物无法补齐）
        || action === 'method'
        || action === 'artifact'
      ) {
        return designInteraction(office, call, action, args)
      }
      if (action === 'view') {
        if (args.kind === 'ui') return renderUiView(call)
        // F-16：只读视图也要把"名字与字段矛盾"的存量契约摆出来 —— 否则读 producer/consumer
        // 做影响分析的人（或模型）拿到的方向是反的却毫无提示。
        return joinReceiptParts([
          // F-20：只读视图也要摆出契约字段的 YAML 类型提示（手写 `retry: 2` 时不能静默）
          describeDesign(office.views(call), office.contracts(call), office.contractFieldNotes(call), office.shapeNotes(call)),
          renderContractDirectionAnomalies(office.contractDirectionAnomalies(call)),
        ])
      }
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
        const staleBefore = office.staleConfirmations(call).map((item) => item.target)
        const dropped = office.dropContract(call, args.id as string, args.reason ?? t('uiIndex.dropNoReason'))
        if (dropped === undefined) return fmt('uiIndex.dropContractNotFound', { p1: args.id as string })
        return joinReceiptParts([
          fmt('uiIndex.dropContractDone', { p1: dropped.id, p2: dropped.name }),
          renderInvalidatedConfirmations(office, call, staleBefore),
        ])
      }
      if (action === 'contract') {
        if ((args.producer ?? '') === '' || (args.consumer ?? '') === '' || (args.schema ?? '') === '') {
          return t('uiIndex.k101')
        }
        const staleBefore = office.staleConfirmations(call).map((item) => item.target)
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
        return joinReceiptParts([
          // F-20：本次写入/更新后该契约的字段类型提示（手写 YAML 写坏了也能在回执里看到）
          describeContract(contract, coverage, office.contractFieldNotes(call), office.shapeNotes(call)),
          // **Z-3（本报告）**：`by` / `note` 这两个入参在 create/contract 上**不被消费**
          // （契约台账没有"记录人/批注"字段）。旧实现静默吞掉，调用方以为写进去了。
          // 依"不得静默"纪律：当场点名，别让人以为留了痕。
          unusedArgsNote(['by', 'note'], [args.by, args.note]),
          // F-16：D4-2 只修了写入路径 —— 存量里"名字与字段矛盾"的记录（早期构建残留）
          // 必须在回执里显式报出（只检测、不自动对调：报告 §6.6.1 证明自动判定会改错一半）。
          renderContractDirectionAnomalies(office.contractDirectionAnomalies(call)),
          renderInvalidatedConfirmations(office, call, staleBefore),
        ])
      }

      if (action !== 'create') return fmt('uiIndex.k102', { p1: action, p2: DESIGN_ACTIONS.join(' | ') })
      // —————————————— F-9：界面视图（第 6 个视图）的**写入入口** ——————————————
      // 必须**先于** `kind` 校验分流：`ui` 不在五视图白名单里，走下面的 `parseViewKind`
      // 只会得到"创建元素需要 kind"。`ui` 是死参数时，含界面的项目 C-27 永远红。
      if (args.ui !== undefined) {
        // 同时给了五视图 kind 与 ui：不许静默丢一个 —— 明确报冲突让调用方选。
        if (parseViewKind(args.kind) !== undefined) return t('uiIndex.kUiConflict')
        return writeUiViewReceipt(office, call, args.ui)
      }
      // `kind=ui` 但没给 `ui` 正文：同样不许静默当成"缺 kind"，要给可执行的下一步。
      if (args.kind === 'ui') return t('uiIndex.kUiMissing')
      const kind = parseViewKind(args.kind)
      if (kind === undefined) return t('uiIndex.k103')
      if ((args.name ?? '') === '') return t('uiIndex.k104')
      const staleBefore = office.staleConfirmations(call).map((item) => item.target)
      const result = office.upsertElement(call, {
        kind,
        ...(args.id === undefined ? {} : { id: args.id }),
        name: args.name ?? '',
        elementKind: args.elementKind,
        responsibility: args.responsibility,
        dependsOn: parseList(args.dependsOn),
        summary: args.summary,
      })
      // F-19：按 id 改写了已确认元素 → 旧确认戳当场失效并点名（改内容不会自动重新盖章）
      return joinReceiptParts([
        describeDesignElement(result),
        renderInvalidatedConfirmations(office, call, staleBefore),
        // Z-3：`by` / `note` 在 create 上不被消费（元素台账没有"记录人/批注"字段）→ 当场点名
        unusedArgsNote(['by', 'note'], [args.by, args.note]),
      ])
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
          return describeAdr(adr, args.supersedes, office.shapeNotes(call))
        }
        case 'list':
        default:
          return describeAdrList(office.adrs(call), office.shapeNotes(call))
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
          return describeScenario(scenario, office.shapeNotes(call))
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
          return describeAssessment(assessment, office.shapeNotes(call))
        }
        case 'list':
        default:
          return describeScenarioList(office.scenarios(call), office.shapeNotes(call))
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
        case 'unlink': {
          if (args.from === undefined || args.to === undefined) return t('uiIndex.kUnlinkNeeds')
          const removed = office.unlinkTrace(call, { from: args.from, to: args.to, ...(args.kind === undefined ? {} : { kind: args.kind }) })
          if (removed.removed === 0) return fmt('uiIndex.kUnlinkNone', { p1: args.from, p2: args.to })
          const after = office.traceReport(call)
          return [
            fmt('uiIndex.kUnlinkDone', { p1: removed.removed, p2: args.from, p3: args.to }),
            fmt('uiIndex.k111', { p1: Math.round(after.coverage * 100), p2: after.orphans.design.length, p3: after.orphans.tasks.length, p4: after.orphans.tests.length }),
          ].join('\n')
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
