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
import { ACCEPTANCE_VERDICTS } from './domain/records.js'
import type { AcceptanceVerdict } from './domain/records.js'
import { Config, resolveSettings } from './config.js'
import { registerRoleCardsSkill } from './domain/skills.js'
import type { SdoConfig } from './config.js'
import { contractCoverage } from './domain/contracts.js'
import { describeUndigestedChanges } from './domain/change.js'
import { makeAcceptanceIds } from './domain/requirements.js'
import { SdoStore } from './infra/store.js'
import {
  deviationsNote,
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
  describeDispatchStarted,
  childFaceLines,
  describePoolBlock,
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
import { callOf, createOfficeTools, parseList } from './interface/tools.js'
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
import { attributeRole, claimsBySession, filterKnownTools, maskFingerprint, roleCardPath, roleMaskDecision, toolAllowList } from './domain/roles.js'
import type { RoleAttribution } from './domain/roles.js'
import { reuseCapability, startDispatch } from './integration/dispatch.js'
import type { SubagentRuntimeLike } from './integration/dispatch.js'
import { isRole } from './domain/plan.js'
import { sessionIdOf } from './interface/scope.js'
import { toolCallNameOf, toolNamesOfHeader } from './domain/dispatchFace.js'
import { reviewAdoptionLabel } from './domain/reviewVerification.js'
import { excerpt as excerptOf } from './domain/dispatchReports.js'
import type { DispatchFinished } from './domain/dispatchReports.js'
import { maskAllows } from './domain/roles.js'
import { isAdrId } from './domain/adr.js'
import { evaluateWriteScope, normalizeWorkspacePath } from './domain/writeScope.js'
import type { ProposedQuestion } from './domain/grill.js'

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

/**
 * 解析 JSON 参数；失败时给出可读错误。
 *
 * **D-7（sdo-test-new 2026-10-08，major）**：旧实现用的是 `uiIndex.k1`，而那个键的文案是
 * **「预算已更新：{p1}」**（同一个 `uiIndex` 段里的预算回执），且模板里**没有 `{p2}`** ⇒
 * 任何一个复合 JSON 参数写坏（`jsonOr` 有 34 个调用点：`alternatives`/`consequences`/
 * `dimensions`/`steps`/`findings`…），用户看到的都是一句**与事实无关的"预算已更新"**，
 * 真正的解析错误被丢掉，操作静默未执行 —— 真机上因此把一次解析失败误判成"并行写台账踩踏"。
 * 现在：专用的解析失败键 + 带上宿主给的错误正文 + 明说"本次没有写入任何东西"。
 */
function jsonOr<T>(value: string | undefined, label: string): { value?: T; error?: string } {
  if (value === undefined || value.trim() === '') return {}
  try {
    return { value: JSON.parse(value) as T }
  } catch (error) {
    return { error: fmt('uiIndex.kJsonParseFailed', { p1: label, p2: error instanceof Error ? error.message : String(error) }) }
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
  /**
   * plan-mode 服务（由 preset 的 `planning` 组声明挂载，本插件只消费）。
   * 拿不到 ⇒ 退回 `sdo_design action=review|waive-plan` 两条手动出口，并在回执里如实说明。
   */
  let planMode: PlanModeLike | undefined

  // **plan-mode 由 preset 声明挂载**（2026-10-09 改为标准写法）：
  // `presets/sdo-office.patch.yml` 里有一个 `planning` 组（`cordis:group` + `isolate: { planMode: true }`），
  // 组内 **`plan-mode` 行与本插件行 `sdo` 同组** —— 官方的 `standard` preset 是同形。
  //
  // 为什么必须是这样（三段都有真机/读码证据）：
  //   ① 宿主层 `dsh-web-app/cordis.patch.yml` 把 `- id: plan-mode` 设为 `disabled: true` ⇒ web profile 里
  //      **本来就没有** `planMode` 服务，必须由 preset 自己补挂（与 tool-skill / tool-fs-search 同类）。
  //   ② `isolate` 让 planMode 成为**本组私有**的实例；`designPrecondition` 依赖 `ctx.planMode`，
  //      所以消费者（本插件）**必须与服务同组**，否则取不到（历史缺陷：架构阶段永久阻塞）。
  //   ③ 0.2.1 起 preset 注册表会审计"preset 子树里注册进 root realm 的服务"（`mountPreset` → `leakedServices`）：
  //      以前那种"代码里 `ctx.plugin(...)` 自挂"会被判 `Preset services require isolate realms: planMode`
  //      而**整个 preset 注册失败**（真机实测）。改成声明式之后，本插件**一个服务都不自挂**。
  //
  // 本插件仍然只做**消费**：`planMode` 现取现用（拿不到就退回 `sdo_design action=review|waive-plan` 两条出口）。
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
  // 子代理**最后一条助手消息**的缓存（取汇报 ②：`turn/end` 时落盘）。
  // 只放在内存里：一次性运行的子会话与插件实例同生命周期；插件重载会丢，这属已知边界（README 写明）。
  const childLastMessage = new Map<string, string>()
  const rememberChildMessage = (sessionId: string, text: string): void => {
    if (text.trim() === '') return
    childLastMessage.set(sessionId, text)
    if (childLastMessage.size > 32) {
      const oldest = childLastMessage.keys().next().value
      if (oldest !== undefined) childLastMessage.delete(oldest)
    }
  }

  ctx.on('session/event', (session, event) => {
    const rawType = String((event as { type?: unknown }).type ?? '')
    const rawSessionId = sessionIdOf(session)
    const rawCwd = ((session as { header?: { cwd?: unknown } }).header)?.cwd
    try {
      const eventType: string = String((event as { type?: unknown }).type ?? '')
      const header = (session as { header?: { id?: unknown; cwd?: unknown } }).header
      // 采集用的会话 id 与 `callOf`（claim 基线）读**同一个字段**，否则两边对不上号
      const sessionId = sessionIdOf(session)
      const cwd = typeof header?.cwd === 'string' ? header.cwd : undefined
      // **评审 §4.2：把「宿主有没有真的收窄工具面」从断言变成观察** —— 只认我们自己派发出去的子会话，
      // 看它 `request/header` 里**实际拿到**的工具清单。这条不受 `captureWorkspaceChanges` 开关影响
      // （它观测的是掩码是否生效，与写范围对账是两件事）。
      if (eventType === 'request/header') {
        if (sessionId === undefined || cwd === undefined) return
        const dispatched = office.dispatchedChildren({ sessionId, cwd })
        const mine = dispatched.find((item) => item.childSessionId === sessionId)
        if (mine === undefined) return
        const tools = toolNamesOfHeader((event as { data?: { header?: unknown } }).data?.header)
        // **D-14 连带①（blocker 同案）**：旧实现在这里**直接 return** —— 于是"子代理一个工具都没有"
        // 这一态在台账里**完全静默**：`child-tools.jsonl` 不生成、journal 里也没有 `dispatch/observe-failed`，
        // 而 README §9.1c 的承诺是"观测失败不再静默"（真机上因此只能靠读子会话原始记录才发现零工具）。
        // 采集失败仍然 fail-open（不阻塞任何东西），但**必须留痕**。
        if (tools.length === 0) {
          office.noteObserveFailure({ sessionId, cwd }, {
            childSessionId: sessionId,
            eventType: 'request/header',
            error: fmt('uiIndex.kObserveEmptyToolFace', { p1: mine.taskId }),
          })
          return
        }
        const role = mine.role
        // 这是**我们自己派发的子会话** ⇒ 按执行者判（`subagent`/`workflow`/`sdo_plan` 出现在它的公告面
        // 就是一条该被抓到的越界：那条路能派出不带掩码的子代理）
        const violations = isRole(role) ? tools.filter((tool) => !maskAllows(role, tool, { executor: true })) : []
        office.noteChildFace({ sessionId, cwd }, { childSessionId: sessionId, tools, violations })
        return
      }
      // **取汇报 ②③**：子代理的结算与它的最终报告。
      //  - `assistant/message`：记住最后一条（带全文）；
      //  - `turn/end`：one-shot 子会话**没有** `session/end`，这就是结算信号 ⇒ 落报告 + 记 `dispatch/finished`。
      if (eventType === 'assistant/message' || eventType === 'turn/end') {
        if (sessionId === undefined || cwd === undefined) return
        // 取**最新**一条（复用方案 3：同一子会话会服务多张卡，`find` 会一直认第一张卡 ⇒ 报告落点撞车）
        const mine = office.dispatchedChildren({ sessionId, cwd }).filter((item) => item.childSessionId === sessionId).at(-1)
        if (mine === undefined) return
        if (eventType === 'assistant/message') {
          const message = (event as { data?: { message?: { content?: unknown } } }).data?.message?.content
          const text = Array.isArray(message)
            ? message.map((block) => (block as { type?: string; text?: string }).type === 'text' ? String((block as { text?: string }).text ?? '') : '').join('')
            : ''
          rememberChildMessage(sessionId, text)
          return
        }
        const turn = Number((event as { data?: { turn?: unknown } }).data?.turn ?? 0)
        const reason = String(((event as { data?: { reason?: { kind?: unknown } } }).data?.reason)?.kind ?? '')
        office.noteDispatchFinished({ sessionId, cwd }, {
          childSessionId: sessionId,
          task: mine.taskId,
          role: mine.role,
          turn: Number.isFinite(turn) ? turn : 0,
          reason,
          startedAt: mine.startedAt,
          report: childLastMessage.get(sessionId) ?? '',
        })
        childLastMessage.delete(sessionId)
        return
      }
      // **执行面**：模型可能对**未被公告**的工具发起调用（宿主会把它路由到工具层，只有钩子拦得住）。
      // 只统计我们自己派发出去的子会话里、落在掩码之外的调用。
      if (eventType === 'tool/call') {
        if (sessionId === undefined || cwd === undefined) return
        const mine = office.dispatchedChildren({ sessionId, cwd }).find((item) => item.childSessionId === sessionId)
        if (mine === undefined || !isRole(mine.role)) return
        const called = toolCallNameOf(event)
        if (called === undefined || maskAllows(mine.role, called)) return
        office.noteChildFace({ sessionId, cwd }, { childSessionId: sessionId, tools: [], violations: [], calls: [called], callCount: 1 })
        return
      }
      if (!settings.captureWorkspaceChanges) return
      if (eventType !== 'workspace/changes') return
      if (sessionId === undefined || cwd === undefined) return
      office.noteSession(sessionId, cwd)
      const store = office.storeFor(cwd)
      if (!existsSync(store.path())) return
      const changes = (ctx as unknown as { get?: (name: string) => unknown }).get?.('workspaceChanges') as
        | { summary?: (id: string, seq: number) => { turn?: number; files?: { path?: string; display?: string }[] } | undefined }
        | undefined
      const seq = Number((event as { seq?: unknown }).seq)
      if (!Number.isFinite(seq)) return
      // **SDO-15**：同时记下**采集这一刻的 journal 序号** —— 写范围对账必须与 `task/claimed`
      // 的判断序号同量纲（真机反例：宿主 seq 883 vs journal 444，导致任何卡都被判越界）。
      const journalSeq = office.journalFor(cwd).read().events.length
      recordWorkspaceChanges({ store, sessionId, seq, journalSeq, summary: changes?.summary?.(sessionId, seq), enabled: true })
    } catch (error) {
      // 采集/观测仍然 **fail-open**（不阻塞任何写操作），但**必须留痕**：
      // 真机上就丢过三次派发的观测，而"没数据"与"没问题"从回执上分不出来（禁止静默的原则）。
      try {
        if (rawSessionId !== undefined && typeof rawCwd === 'string') {
          office.noteObserveFailure({ sessionId: rawSessionId, cwd: rawCwd }, {
            childSessionId: rawSessionId,
            eventType: rawType,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      } catch {
        /* 连留痕都失败时不再递归；采集本身从不影响写路径 */
      }
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
    /** P-1：真派发所需的最小面（缺失即降级为"让流程官自己转交"）。 */
    list?: () => string[]
    start?: SubagentRuntimeLike['start']
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

  /**
   * **本插件真实注册的 `sdo_*` 工具名**（在下面的注册循环里填充）。
   *
   * 用途：算每个角色的 **deny 面**（SDO 流程面白名单的补集）。从**真实注册表**取而不是硬编码一张名单 ——
   * 硬编码会随工具增减而漂移，而 deny 面里多一个/少一个名字的后果是"某个 sdo 工具对所有角色都不可达"
   * 或"某个角色拿到了本不该有的流程工具"，两种都是静默的（2026-10-08 真机口径纠正）。
   */
  const officeToolNames: string[] = []

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
      // **观测的事后出口（评审第三轮 C）**：派发回执那一刻子代理还没跑，观测数据只有到了这里（或看板）才看得到
      const faces = office.childFaces(call)
      // **取汇报 ①③**：最近完成的派发（卡 / 子会话 / 结论 / 耗时 / 报告落点 + 报告摘要）
      const finished = office.finishedDispatches(call).slice(-5).reverse()
      const finishedBlock = finished.length === 0
        ? ''
        : '\n' + t('uiDispatch.kFinishedHeader') + '\n' + finished.map((item) => {
            const report = office.reportText(call, item.report)
            const excerpt = report === undefined ? '' : '\n  ' + excerptOf(report)
            return fmt('uiDispatch.kFinishedLine', {
              p1: item.task === '' ? item.childSessionId.slice(0, 8) : item.task,
              p2: item.childSessionId.slice(0, 8),
              p3: item.reason === '' ? '?' : item.reason,
              p4: String(Math.round(item.durationMs / 1000)),
              p5: item.report,
            }) + excerpt
          }).join('\n')
      // **语义 A 的事后出口**：批准但未消化的需求变更。认领会被拒（`change-not-digested`），
      // 但"为什么"必须能主动看到 —— 重启/压缩之后那条回执已经不在上下文里了。
      // 文案直接复用 `describeUndigestedChanges`（与拒认领同一份口径，一处定义两处使用）。
      const pending = office.undigestedChanges(call)
      const pendingBlock = pending.length === 0 ? '' : '\n' + describeUndigestedChanges(pending, office.process(call)) + '\n'
      // **角色池**（子代理复用）：谁在飞、谁空闲可复用、还有几张卡排队 —— 与派发回执同一份渲染
      const poolReuse = reuseCapability((subagentsApi ?? {}) as unknown as SubagentRuntimeLike).supported
      // **§2.2（第二轮评审 HIGH）**：状态路径不传 `maskHashOf` ⇒ 与派发路径**两套口径**
      // （真机：同一状态下 `queued/blocked=pool-full` 而派发路径 `dispatch=[TASK-9/复用]`）。
      // **R-6**：掩码指纹判据收敛到 office 内部（`maskFingerprint` 是纯函数，池视图与准入共用一处）
      const poolPlan = office.poolPlan(call, { reuseIdle: poolReuse })
      const poolText = describePoolBlock(poolPlan.pools, poolPlan.queued.map((task) => task.id), poolReuse, settings.dispatchOrphanTtlMinutes)
      const poolBlock = poolText === '' ? '' : '\n' + poolText + '\n'
      // **SDO-53**：公告清单 ≠ 实际可调 —— 把「我们声明的面」与「子代理实测拿到的面」的差集摆出来
      const faceMismatches = office.faceMismatches(call)
      const faceMismatchBlock = faceMismatches.length === 0
        ? ''
        : '\n' + faceMismatches.map((row) => fmt('uiIndex.kFaceMismatch', {
          p1: row.childSessionId.slice(0, 8),
          p2: row.task,
          p3: row.role,
          p4: row.missing.join(' ') || '-',
          p5: row.extra.join(' ') || '-',
        })).join('\n') + '\n'
      const faceBlock =
        faces.length === 0
          ? ''
          : '\n' + fmt('uiDescribe.k208FaceBlockHeader', { p1: String(faces.length) }) + '\n' + childFaceLines(faces).join('\n')
      // **R-8 附录**：死豁免（卡不存在 / 已 dropped）主动说 —— 否则"用 drop+重建绕限制"会白花一轮
      const deadExempt = office.deadExemptions(call)
      const deadBlock = deadExempt.length === 0
        ? ''
        : '\n' + fmt('uiIndex.kDeadExemption', {
            p1: String(deadExempt.length),
            p2: deadExempt.map((item) => `${item.task}(${item.check})`).join(' '),
          }) + '\n'
      if (forced === undefined) return text + pendingBlock + poolBlock + faceMismatchBlock + faceBlock + finishedBlock + deadBlock
      const note = forced.truncated
        ? fmt('uiIndex.kRebuildTruncated', { p1: String(forced.badLine ?? '?') })
        : t('uiIndex.kRebuildForced')
      return `${note}\n${text}` + pendingBlock + poolBlock + faceMismatchBlock + faceBlock + finishedBlock + deadBlock
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
      // **决定实现阶段方法包**（增量 3）：模型自选、不问用户，但必须有据可查（derivedFrom 至少一条可核对）。
      if (args.action === 'profile') {
        const packages = jsonOr<string[]>(args.packages, 'packages')
        if (packages.error !== undefined) return packages.error
        const derivedFrom = jsonOr<string[]>(args.derivedFrom, 'derivedFrom')
        if (derivedFrom.error !== undefined) return derivedFrom.error
        const exempt = jsonOr<{ task?: unknown; check?: unknown; why?: unknown }[]>(args.exempt, 'exempt')
        if (exempt.error !== undefined) return exempt.error
        const scopeRaw = (args.scope ?? '').trim()
        let scope: 'all' | string[] = 'all'
        if (scopeRaw !== '' && scopeRaw !== 'all') {
          const parsed = jsonOr<string[]>(scopeRaw, 'scope')
          if (parsed.error !== undefined) return parsed.error
          scope = parsed.value ?? []
        }
        const outcome = office.decideConstructionProfile(call, {
          packages: packages.value ?? [],
          scope,
          derivedFrom: derivedFrom.value ?? [],
          reason: args.reason ?? '',
          exempt: (exempt.value ?? []).map((item) => ({
            task: typeof item.task === 'string' ? item.task : '',
            check: typeof item.check === 'string' ? item.check : '',
            why: typeof item.why === 'string' ? item.why : '',
          })),
          by: 'office',
        })
        if (!outcome.ok) return fmt('uiIndex.kProfileRejected', { p1: outcome.problems.join('；') })
        return fmt('uiIndex.kProfileDecided', {
          p1: outcome.profile.packages.join(' + '),
          p2: outcome.profile.scope === 'all' ? 'all' : outcome.profile.scope.join(' '),
          p3: outcome.profile.derivedFrom.join('；'),
          p4: String(outcome.checked.length),
          p5: String(outcome.unchecked.length),
          p6: outcome.profile.reason === '' ? t('uiIndex.kProfileNoReason') : outcome.profile.reason,
        })
      }
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
        // **D-12**：结构通道的粒度/范围提示（不改粒度 —— 那是方法学选择，但必须说出来）
        const structuralNote = (result.structuralCount ?? 0) === 0
          ? ''
          : `\n${fmt('uiIndex.kStructuralGranularity', { p1: String(result.structuralCount ?? 0) })}`
        const scopeNote = (result.notes ?? []).length === 0
          ? ''
          : `\n${fmt('uiIndex.scopeDerivedNote', { p1: (result.notes ?? []).join('、') })}`
        return planSummary + scopeNote + structuralNote
      }

      if (args.action === 'iteration') {
        if ((args.goal ?? '').trim() === '') return t('uiIndex.k27')
        const iteration = office.startIteration(call, args.goal ?? '')
        return fmt('uiIndex.k28', { p1: iteration.number, p2: iteration.goal, p3: iteration.status })
      }

      if (args.action !== 'next') return fmt('uiIndex.k29', { p1: args.action, p2: PLAN_ACTIONS.join(' | ') })

      // **子代理复用（角色池 + 卡队列，2026-10-04）**：投递仍由驾驶舱触发（本工具调用），
      // 但"这一轮能派几张"由池决定 —— 逐角色并行上限、池满排队（不丢卡）。
      const reuse = reuseCapability((subagentsApi ?? {}) as unknown as SubagentRuntimeLike)
      // **SDO-27（真机）**：`freshChild=true` ⇒ 这一轮**不复用**空闲子代理（强制新起一个）。
      // 真机上单一子代理被复用 19 轮直至上下文耗尽（多次交付只剩部分内容），需要一个"换人"入口。
      const freshChild = args.freshChild === true
      // **SDO-52**：复用空闲子代理前必须比对**工具面指纹**（掩码改过 ⇒ 旧会话还是旧面）。
      // 一次 plan 可能横跨多个角色 ⇒ 传**取指纹的函数**，由池在逐卡判定时就地取。
      const plan = office.poolPlan(call, {
        reuseIdle: reuse.supported && !freshChild,
        freshChild,
        // **R-9 逃生口**：卡被未结算派发冻住时，这一轮就能覆盖孤儿 TTL，不必改 preset 重启
        ...(args.orphanTtlMinutes === undefined ? {} : { orphanTtlMinutes: args.orphanTtlMinutes }),
      })
      // **R-14**：派发前把「卡的要求 ∩ 该角色的能力」矛盾摆出来（不阻断派发，但绝不允许它静默）
      const infeasibleBlock = (plan.infeasible ?? []).length === 0
        ? ''
        : '\n' + (plan.infeasible ?? []).map((row) => fmt('uiIndex.kCapabilityGap', {
            p1: row.taskId,
            p2: row.role,
            p3: row.gaps.map((gap) => t(`uiIndex.kGap_${gap}`)).join(' / '),
          })).join('\n') + '\n'
      if (plan.dispatch.length === 0) {
        const issues = office.planIssues(call)
        if (issues.length > 0) {
          // **SDO-46（真机）**：以前这里直接回落到"打印看板"，于是「派发成功」与「没派发」在回执上
          // 难以区分（真机上被误判为"新卡没建成"，在自动化流水线上就是**静默停摆**）。
          // 现在先给一句**明确的裁决**，再附看板与原因。
          const ready = office.tasks(call).filter((task) => task.status === 'planned' || task.status === 'ready')
          const conflicts = issues.filter((issue) => issue.code === 'write-scope-disjoint')
          const held = ready
            .map((task) => conflicts.find((issue) => issue.taskId === task.id))
            .filter((issue): issue is (typeof conflicts)[number] => issue !== undefined)
          const verdict = held.length > 0
            ? fmt('uiIndex.kDispatchHeldByScope', {
              p1: String(held.length),
              p2: held.map((issue) => issue.taskId).join(' '),
              p3: held.map((issue) => issue.detail).join(' ｜ '),
            })
            : fmt('uiIndex.kDispatchBlockedByPlan', { p1: String(issues.length) })
          // **SDO-54**：真机回执是「⛔ 本次没有派发：计划有 10 处问题（见下）」，而「见下」的 10 条诊断
          // 被随后的看板长文淹没/截断 ⇒ 流程官分不清"计划有问题"还是"通道坏了"。
          // 现在诊断**紧跟裁决**（看板在后），且 `why=true` 时只输出裁决 + 诊断。
          const diagnostics = issues
            .map((issue) => fmt('uiIndex.kPlanIssueLine', { p1: issue.code, p2: issue.taskId, p3: issue.detail, p4: issue.remedy }))
            .join('\n')
          if (args.why === true) return verdict + '\n' + diagnostics
          return verdict + '\n' + diagnostics + '\n' + describePlan(office.tasks(call), [], office.shapeNotes(call))
        }
        if (plan.queued.length === 0) {
          // **R-9**：真机在这里印「没有可派发的任务卡（都已认领/完成）」，而实际上是 4 张 ready 卡
          // 被**停止的子会话**留下的未结算派发冻着 ⇒ 回执必须点名「被谁冻着、冻了多久、怎么解」。
          const frozen = plan.heldByDispatch ?? []
          if (frozen.length > 0) {
            return fmt('uiIndex.kDispatchFrozen', {
              p1: String(frozen.length),
              p2: frozen
                .map((item) => fmt('uiIndex.kDispatchFrozenItem', {
                  p1: item.taskId,
                  p2: item.childSessionId.slice(0, 8),
                  p3: String(item.minutes),
                }))
                .join(' '),
              p3: String(settings.dispatchOrphanTtlMinutes),
            })
          }
          return infeasibleBlock + t('uiIndex.k30')
        }
        // 排队不是"没卡"，而是**被上限挡住**：必须说清是哪个池满，否则用户会以为流程卡住了
        const blocked = plan.blocked.map((item) => fmt('uiIndex.kPoolBlockedLine', { p1: item.task.id, p2: item.task.role, p3: item.detail })).join('\n')
        return fmt('uiIndex.k31', { p1: plan.queued.length, p2: settings.maxParallelDispatch })
          + '\n' + blocked
          + '\n' + describePoolBlock(plan.pools, plan.queued.map((task) => task.id), reuse.supported, settings.dispatchOrphanTtlMinutes)
      }

      const preference = args.backend === 'subagent' || args.backend === 'native-team' || args.backend === 'inline' ? args.backend : 'auto'
      const iteration = office.iteration(call)
      const decision = pickBackend(preference, backendProbe(), lastBackend, iteration?.number)
      const take = Math.max(1, Math.min(args.limit ?? 1, plan.dispatch.length))
      const picked = plan.dispatch.slice(0, take)
      // **R-5C（sdo-test-new 2026-10-08）**：被 `limit` 截掉的卡**既不在"已派发"也不在"排队"**里
      // （它们已通过容量准入，只是这一轮没派）⇒ 回执里凭空消失。如实点名，并说明下次还会再挑。
      const held = plan.dispatch.slice(take)
      const out: string[] = []
      for (const [index, entry] of picked.entries()) {
        const task = entry.task
        const owner = decision.backend === 'inline' ? 'cockpit' : `${decision.backend}:${task.role}:${index + 1}`
        const request = buildDispatch({
          task,
          backend: decision.backend,
          owner,
          projectName: office.status(call).project?.name ?? '',
          // **真实注册名**（见 `officeToolNames` 注释）：算 deny 面必须按它来，绝不硬编码
          sdoNames: officeToolNames,
        })
        office.recordDispatch(call, {
          taskId: task.id,
          backend: decision.backend,
          owner,
          ...(decision.degradedReason === undefined ? {} : { degradedReason: decision.degradedReason }),
          // **D-15**：显式指定覆盖了本迭代锁 —— 与降级一样必须留痕（同一份事件里两个不同语义的字段）
          ...(decision.overrideNote === undefined ? {} : { overrideNote: decision.overrideNote }),
        })
        lastBackend = { backend: decision.backend, iteration: iteration?.number }
        if (decision.backend === 'inline') {
          out.push(describeInlineHandoff(request, decision.degradedReason, decision.overrideNote))
          continue
        }
        // P-1：真的把请求交给宿主的 subagents 服务起一次运行；失败如实说明原因（不假装派出去了）
        // **工具面必须先按宿主注册表过滤**：宿主 `tools.restrict()` 对未注册的名字**直接抛错**
        // （`names unknown global tool "pdf"`）⇒ 整份工具面失效、子代理连 `read_image` 都拿不到。
        // 探针拿不到（服务缺失/抛错）时**保持原样**（fail-open）：宁可少拦，也不能让整份工具面炸掉。
        //
        // **D-14（sdo-test-new 2026-10-08，blocker）**：探针**必须带上调用方 agent 的作用域**。
        // 宿主 `tools.get(name)` 省略 scope = **只查全局层**（dsh-tools 的 `get(name, scope?)`：
        // "omitted = the global view"），而 `sdo-office` preset 挂的工具是 **agent 平面**注册
        // （宿主源码注释：preset 工具是 "ANCESTOR contribution"）⇒ 旧写法对 15 个名字**全部**返回
        // undefined，白名单被清空成 `[]` 原样下发，子代理**一个工具都没有**（子会话描述符
        // `toolFilter.allow: []`，整轮只能把工具调用写成正文，卡零变化、回执却写"已真正派发"）。
        // 两条一起修：① 按 agent 作用域问（查不到再退回全局视图，取并集）；② 全未知时不当事实用。
        const toolsProbe = (scope: unknown): ((name: string) => boolean) => {
          try {
            const api = ctx.get('tools') as { get?: ((name: string, scope?: unknown) => unknown) | undefined } | undefined
            if (api === undefined || typeof api.get !== 'function') return () => true
            return (name: string): boolean => {
              try {
                if (scope !== undefined && api.get?.(name, scope) !== undefined) return true
                return api.get?.(name) !== undefined
              } catch {
                return true
              }
            }
          } catch {
            return () => true
          }
        }
        const probe = toolsProbe(call.agent)
        // **2026-10-08 口径纠正**：下发的是 **deny 面**，不是 allow 白名单。
        // 旧写法把 `request.toolFilter`（角色声明的十几个名字）当 allow 下发 ⇒ 宿主把**整个通用面**也隐藏掉，
        // 子代理连 `technique_apply`/记忆/联网都没有（真机原话「无法使用 technique_apply」）。
        // 现在：通用面**继承宿主默认**（只有 `roles.yml` 的 deny 明写挡住的才挡），
        // SDO 流程面用白名单的补集（`toolDenyList`）。
        const denyFiltered = filterKnownTools(request.toolDeny, probe)
        const probeBlind = denyFiltered.blind
        // 盲态没有"剔掉了什么"可言（那批 dropped 是探针的错觉）—— 不许当事实回报。
        const droppedTools = probeBlind ? [] : denyFiltered.dropped
        const outcome = await startDispatch({
          runtime: subagentsApi,
          provider: settings.dispatchProvider,
          agent: call.agent,
          request,
          deny: denyFiltered.applied,
          maxDepth: settings.dispatchMaxDepth,
          ...(entry.reuseChildId === undefined ? {} : { reuseChildId: entry.reuseChildId }),
        })
        if (held.length > 0) {
          out.push(fmt('uiDescribe.kDispatchLimitHeld', {
            p1: String(held.length),
            p2: String(take),
            p3: held.map((item) => item.task.id).join(' '),
          }))
        }
        if (plan.reuseSkipped.length > 0) {
          out.push(fmt('uiIndex.kReuseSkipped', {
            p1: String(plan.reuseSkipped.length),
            p2: plan.reuseSkipped.map((item) => `${item.childSessionId}（${item.reason}）`).join('；'),
          }))
        }
        if (probeBlind) {
          // 盲态时**原样下发**（对 deny 面来说，丢掉一条 deny = 给子代理多开一项权限 ⇒ 必须原名单发出）
          out.push(fmt('uiIndex.kToolFilterProbeBlind', { p1: task.id, p2: String(denyFiltered.applied.length) }))
        }
        if (droppedTools.length > 0) {
          out.push(fmt('uiIndex.kToolFilterDropped', { p1: [...new Set(droppedTools)].join(' '), p2: task.id }))
        }
        if (outcome.started) {
          office.recordDispatchStarted(call, {
            taskId: task.id,
            provider: outcome.provider,
            childSessionId: outcome.childSessionId,
            // **SDO 流程面白名单**条数（这才是"角色面"里真正受控的那部分）
            tools: request.sdoAllow.length,
            // deny 面：通用面的硬禁止 ∪ SDO 补集 —— **实际下发**的那份（审计与"掩码到哪一层"的唯一台账线索）
            denyTools: denyFiltered.applied.length,
            deny: denyFiltered.applied,
            sdoAllow: request.sdoAllow,
            ...(isRole(task.role) ? { maskHash: maskFingerprint(task.role) } : {}),
            ...(isRole(task.role) ? { role: task.role } : {}),
            mode: outcome.mode,
            reused: outcome.reused,
          })
          // 复用/降级**如实写出来**：静默复用与静默降级都会让"池"变成看不见的行为
          const rounds = office.dispatchedChildren(call).filter((child) => child.childSessionId === outcome.childSessionId).length
          const stuck = office.unresolvedBlock(call, task.id)
          const notes = [
            stuck === undefined ? '' : fmt('uiDescribe.kDispatchRepeatBlocked', { p1: task.id, p2: stuck.reason.slice(0, 200) }),
            outcome.reused
              ? fmt('uiDescribe.kReusedChild', { p1: task.id, p2: outcome.childSessionId.slice(0, 8), p3: task.role, p4: String(rounds) })
              : '',
            outcome.reuseFailed === undefined ? '' : fmt('uiDescribe.kReuseFailed', { p1: outcome.reuseFailed }),
            outcome.continuableFailed === undefined ? '' : fmt('uiDescribe.kContinuableFailed', { p1: outcome.continuableFailed }),
          ].filter((line) => line !== '')
          out.push(
            describeDispatchStarted(
              request,
              outcome.provider,
              outcome.childSessionId,
              // **实际下发的 deny 面**（D-14 连带 ② 的教训：回执必须报"真发出去的那份"）
              denyFiltered.applied,
              outcome.toolFilterDeclared,
              outcome.reuseSupported,
              office.childFaces(call),
              { reused: outcome.reused, mode: outcome.mode },
              decision.degradedReason,
              decision.overrideNote,
            )
              + (notes.length === 0 ? '' : '\n' + notes.join('\n')),
          )
          continue
        }
        out.push(
          describeDispatch(request, decision.degradedReason) +
            '\n' +
            fmt('uiIndex.kDispatchNotStarted', { p1: outcome.reason, p2: outcome.detail }),
        )
      }
      const tail = plan.queued.length === 0 ? '' : fmt('uiIndex.k32', { p1: plan.queued.length })
      // 池视图（在飞/空闲可复用/已退役）+ 还在排队的卡：一次派发之后"池子长什么样"要能看见
      const freshNote = freshChild ? '\n' + t('uiIndex.kFreshChild') : ''
      const poolBlock = describePoolBlock(plan.pools, plan.queued.map((task) => task.id), reuse.supported, settings.dispatchOrphanTtlMinutes)
      return `${out.join('\n\n')}${tail}${freshNote}${poolBlock === '' ? '' : `\n${poolBlock}`}`
    },

    async task(call: OfficeCall, args: TaskArgs): Promise<string> {
      switch (args.action) {
        case 'update': {
          // **D6**：改卡同属流程官职权；**认领会话本人**可以改自己正在做的卡（改完仍需重新认领）
          {
            const ownSession = args.id !== undefined && office.claimSession(call, args.id) === call.sessionId
            if (!ownSession && office.isDispatchedChild(call)) return t('uiIndex.kTaskAdminOnly')
          }
          // **SDO-14(3) / SDO-15(3)（真机）**：卡是流程真源，却没有受约束的修改入口 —— 真机只能人肉改 YAML
          // 或重新立卡。这里给出入口，三条约束见 `updateTask`。
          if (args.id === undefined) return t('uiIndex.k33')
          const json = <T,>(raw: string | undefined, label: string): { value: T | undefined; error: string | undefined } => {
            if (raw === undefined) return { value: undefined, error: undefined }
            const parsed = jsonOr<T>(raw, label)
            return { value: parsed.error === undefined ? parsed.value : undefined, error: parsed.error }
          }
          const fields = {
            dod: json<string[]>(args.dod, 'dod'),
            writeScopes: json<string[]>(args.writeScopes, 'writeScopes'),
            blockedBy: json<string[]>(args.blockedBy, 'blockedBy'),
            evidenceRequired: json<string[]>(args.evidenceRequired, 'evidenceRequired'),
            requirements: json<string[]>(args.requirements, 'requirements'),
          }
          for (const item of Object.values(fields)) if (item.error !== undefined) return item.error
          const updated = office.updateTask(call, {
            taskId: args.id,
            by: args.actor ?? args.owner ?? 'human',
            ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(fields.dod.value === undefined ? {} : { dod: fields.dod.value }),
            ...(fields.writeScopes.value === undefined ? {} : { writeScopes: fields.writeScopes.value }),
            ...(fields.blockedBy.value === undefined ? {} : { blockedBy: fields.blockedBy.value }),
            ...(fields.evidenceRequired.value === undefined ? {} : { evidenceRequired: fields.evidenceRequired.value }),
            ...(fields.requirements.value === undefined ? {} : { requirements: fields.requirements.value }),
            ...(args.size === undefined ? {} : { size: args.size }),
          })
          if (!updated.ok) return fmt('uiIndex.kTaskUpdateRejected', { p1: updated.code, p2: updated.detail })
          return fmt('uiIndex.kTaskUpdated', { p1: updated.task.id, p2: updated.changed.join('、'), p3: String(updated.task.revision) })
        }
        case 'drop': {
          // D3-3 回收路径：建错的卡置为 dropped（留痕不删除），把「误拆不可逆」变成可回收
          if (args.id === undefined) return t('uiIndex.k33')
          // **D6（整仓评审 major）**：`sdo_task` 对全部 8 个角色可见，而 `drop` 旧实现**没有任何角色/owner 校验**
          // —— 真机上 developer 子代理 `drop` 掉未完成的卡后，`C-40` 立刻由 fail 变 ok（"已显式放弃，不计入完成率"）。
          // 卡是**计划产物**：放弃/改派属流程官职权（驾驶舱或 office 角色）。
          if (office.isDispatchedChild(call)) return t('uiIndex.kTaskAdminOnly')
          const dropped = office.dropTask(call, args.id, args.reason ?? t('uiIndex.dropNoReason'))
          return dropped === undefined ? fmt('uiIndex.k34', { p1: args.id }) : describeTask(dropped, office.shapeNotes(call))
        }
        case 'verify-review': {
          // **2026-10-08 口径**：评审发现要由**该卡的实现会话**逐条核实（复现 / 反驳）后才被采纳。
          // 为什么挂在 `sdo_task` 而不是 `sdo_review`：`sdo_review` 是**评审员的工具**（掩码里
          // developer / tester / delivery 都显式 deny —— 职责分离），而"核实这张卡上的发现"
          // 本来就是卡的生命周期动作（它还挡着 `done`）。挂在协议通道 `sdo_task` 上，
          // 8 个角色都够得着，且不必放宽任何一条职责分离。
          if (args.id === undefined) return t('uiIndex.kReviewVerifyNoTask')
          if (args.review === undefined) return t('uiIndex.kReviewVerifyNoId')
          if (args.index === undefined) return t('uiIndex.kReviewVerifyNoIndex')
          if (args.outcome === undefined) return t('uiIndex.kReviewVerifyNoOutcome')
          const result = office.verifyReviewFinding(call, {
            reviewId: args.review,
            index: args.index - 1,
            outcome: args.outcome,
            evidence: args.proof ?? '',
            by: args.actor ?? '',
            // **R-19 A**：默认拒绝"再次核实"（真机：同一条发现先代核、后实现者核，视图静默留后写的那条）
            ...(args.revise === true ? { revise: true } : {}),
          })
          if (!result.ok) return `${result.code}：${result.detail}`
          // **R-16**：不是实现者本人核的 ⇒ 如实标注"代核"+ 代核者的角色与局限（只复现/反证，不替作者处置）
          const proxyNote = result.disposition.ownerChecked === 'session'
            ? ''
            : '\n' + fmt('uiIndex.kReviewProxyVerified', {
                p1: result.disposition.ownerChecked,
                p2: result.disposition.verifierRole ?? '?',
                p3: result.disposition.roleMatch ?? 'unknown',
                p4: args.id,
              })
          return proxyNote + fmt('uiIndex.kReviewVerified', {
            p1: args.review,
            p2: String(args.index),
            p3: result.disposition.outcome,
            p4: String(result.coverage.verified),
            p5: String(result.coverage.total),
            p6: result.adopted ? t('uiIndex.kReviewAdopted') : t('uiIndex.kReviewNotAdoptedYet'),
          // **R-19 B**：回执直接印"核实者是谁 + 凭什么身份"，不必回读台账（真机 `by: human` 与
          // `sessionId`/`ownerChecked: session` 自相矛盾，审计按 `by` 读会得出错误结论）
          }) + '\n' + fmt('uiIndex.kReviewVerifierLine', {
            p1: result.disposition.by,
            p2: result.disposition.ownerChecked,
            p3: result.disposition.roleMatch ?? 'unknown',
          })
        }
        case 'claim': {
          if (args.id === undefined || args.owner === undefined || args.expectedRevision === undefined) {
            return t('uiIndex.k33')
          }
          const result = office.claimTask(call, {
            taskId: args.id,
            owner: args.owner,
            expectedRevision: args.expectedRevision,
            // 增量 3：构造阶段才检查实现阶段方法包（阶段从投影现读，避免"测试专用参数"）
            phase: office.status(call).project?.phase,
          })
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
          // ——— A2 竞态修法：宿主"先 append 事件、后写摘要"，所以采集当时必然拿不到文件清单。
          // `done` 这一刻会话通常还活着，再取一次并补记（取不到就照旧如实报"未对账"）。
          if (args.action === 'done') {
            try {
              const resolution = office.pendingWorkspaceChanges(call, args.id)
              const service = (ctx as unknown as { get?: (name: string) => unknown }).get?.('workspaceChanges') as
                | { summary?: (id: string, seq: number) => { files?: { path?: string; display?: string }[] } | undefined }
                | undefined
              for (const item of resolution) {
                const summary = service?.summary?.(item.sessionId, item.seq)
                const files = (summary?.files ?? [])
                  .map((file) => (typeof file.path === 'string' && file.path !== '' ? file.path : typeof file.display === 'string' ? file.display : ''))
                  .filter((path) => path !== '')
                if (files.length > 0) office.noteResolvedWorkspaceChanges(call, { sessionId: item.sessionId, seq: item.seq, files })
              }
            } catch {
              /* fail-open：补不到就照旧"未对账"，绝不因此拦下 done */
            }
          }
          const result = office.reportTask(call, {
            taskId: args.id,
            owner: args.owner,
            status: args.action === 'done' ? 'done' : 'blocked',
            phase: office.status(call).project?.phase,
            ...(items.length === 0 ? {} : { evidence: items }),
            ...(args.note === undefined ? {} : { note: args.note }),
          })
          if (!result.ok) return fmt('uiIndex.k35', { p1: result.code, p2: result.detail })
          const taskText = describeTask(result.task, office.shapeNotes(call))
          // **SDO-58**：结算后量一下子代理报告 —— 异常短/缺失就显式告警（真机 235 字节的残片报告
          // 是事后才被复评员发现的，审计链断在这里）
          const health = args.action === 'done' ? office.childReportHealth(call, args.id) : { state: 'none' as const }
          const reportWarning = health.state === 'short'
            ? '\n' + fmt('uiIndex.kChildReportShort', { p1: result.task.id, p2: String(health.bytes ?? 0), p3: health.report ?? '' })
            : health.state === 'missing'
              ? '\n' + fmt('uiIndex.kChildReportMissing', { p1: result.task.id })
              : ''
          // A2：采集不到变更清单时**如实说**"写范围未对账"，不让"没数据"读成"已核对"
          return (result.workspaceAudit !== undefined && !result.workspaceAudit.checked
            ? taskText + '\n' + t('uiIndex.kWorkScopeNotAudited')
            : taskText) + reportWarning
        }
        case 'release':
        case 'reassign': {
          if (args.id === undefined) return t('uiIndex.k36')
          const actor = args.actor ?? 'cockpit'
          const reason = args.reason ?? t('uiIndex.k37')
          // **D6**：`reassign`（改派）属流程官；`release`（自己放手）允许**认领会话本人**或流程官。
          {
            const ownSession = args.id !== undefined && office.claimSession(call, args.id) === call.sessionId
            if (!ownSession && office.isDispatchedChild(call)) return t('uiIndex.kTaskAdminOnly')
            if (!ownSession && office.isDispatchedChild(call) === false && args.action === 'reassign' && office.roleOf(call) !== 'cockpit') return t('uiIndex.kTaskAdminOnly')
          }
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
          // 增量 3：**交付物通道**（变异自证 / 契约测试）—— 与"用例结果"是两类记录，先分流。
          // 它们不要求 caseId/status（那两个是"用例结果"的必填项）。
          if (args.mutation !== undefined || args.contractTest !== undefined) {
            // **§2.5c（第二轮评审）**：旧实现在 mutation 分支里**直接 return** ⇒ 同时给 `mutation` 与
            // `contractTest` 时后者被静默丢弃（工具面声明了两个参数，模型照 README 写也写不进去）。
            // 现在两条各自落账、回执按顺序拼接。
            const parts: string[] = []
            if (args.mutation !== undefined) {
              const payload = jsonOr<Record<string, unknown>>(args.mutation, 'mutation')
              if (payload.error !== undefined) return payload.error
              const item = payload.value ?? {}
              const outcome = office.recordMutation(call, {
                task: typeof item.task === 'string' ? item.task : '',
                tool: typeof item.tool === 'string' ? item.tool : '',
                target: typeof item.target === 'string' ? item.target : '',
                killed: Number(item.killed ?? 0),
                survived: Number(item.survived ?? 0),
              })
              if (!outcome.ok) return fmt('uiIndex.kMutationRejected', { p1: outcome.problems.join('；') })
              const receipt = fmt('uiIndex.kMutationRecorded', {
                p1: outcome.record.task,
                p2: outcome.record.tool,
                p3: String(outcome.record.killed),
                p4: String(outcome.record.survived),
              })
              // 建议非空（不判红）：写清 target 复核者才能跟着复跑
              parts.push(outcome.targetMissing ? `${receipt}\n${t('uiIndex.kMutationTargetHint')}` : receipt)
            }
            if (args.contractTest !== undefined) {
            const payload = jsonOr<Record<string, unknown>>(args.contractTest, 'contractTest')
            if (payload.error !== undefined) return payload.error
            const item = payload.value ?? {}
            const outcome = office.recordContractTest(call, {
              task: typeof item.task === 'string' ? item.task : '',
              contract: typeof item.contract === 'string' ? item.contract : '',
              tool: typeof item.tool === 'string' ? item.tool : '',
              cmd: typeof item.cmd === 'string' ? item.cmd : '',
            })
            if (!outcome.ok) return fmt('uiIndex.kContractTestRejected', { p1: outcome.problems.join('；') })
            parts.push(fmt('uiIndex.kContractTestRecorded', { p1: outcome.record.task, p2: outcome.record.contract }))
            }
            return parts.join('\n')
          }
          if (args.caseId === undefined || args.status === undefined) return t('uiIndex.k40')
          if (args.status === 'pass' && (args.evidence ?? '').trim() === '') {
            return t('uiIndex.k41')
          }
          // **D5（整仓评审）**：旧三元把**非法/缺失**的 `status` 一律落成 `pass`（真机 `status="passed"` ⇒ pass）。
          // 与 SDO-41/SDO-59 同一口径：取值集合之外 ⇒ 可读拒绝，绝不默认「通过」。
          if (args.status !== 'pass' && args.status !== 'fail' && args.status !== 'skip') {
            return fmt('uiIndex.kRecordBadStatus', { p1: String(args.status ?? '') })
          }
          const result = office.addTestResult(call, {
            caseId: args.caseId,
            status: args.status,
            evidence: args.evidence ?? '',
            // **SDO-57（C）**：证据自带**时点（at）+ 前置（env/被检产物）** ⇒ 限定语不再静默过期
            ...(args.env === undefined ? {} : { env: args.env }),
            ...(args.artifact === undefined ? {} : { artifact: args.artifact }),
            // **R-3**：断言面指纹（红绿必须一致；不给就只按"出现过 fail、后有 pass"判，与旧行为一致）
            ...(args.harness === undefined ? {} : { harness: args.harness }),
          })
          const stats = office.verification(call)
          // 记完这一条就把"时效"摆出来（只告警、不拦）：过期的证据与没记环境的结果都要被看见
          const fresh = office.evidenceFreshness(call)
          const notes: string[] = []
          for (const item of fresh.stale) notes.push('\n' + fmt('uiIndex.kEvidenceStale', { p1: item.resultId, p2: item.caseId, p3: item.reason }))
          if ((result.env ?? '') === '') {
            notes.push('\n' + t('uiIndex.kEvidenceNoEnv'))
          } else if (result.envSource === 'inherited') {
            notes.push('\n' + fmt('uiIndex.kEvidenceEnvInherited', { p1: result.env ?? '' }))
          }
          if (stats.unjournaled.includes(result.id)) {
            // **D4**：真源里查不到"这条结果是被跑出来的" ⇒ 不能当证据（手写文件 / 事后改写都在这里现形）
            notes.push('\n' + fmt('uiIndex.kTestUnjournaled', { p1: '1', p2: result.id }))
          }
          return fmt('uiIndex.k42', { p1: result.id, p2: result.caseId, p3: result.status, p4: stats.cases, p5: stats.passed, p6: stats.failed, p7: stats.defectsOpen }) + notes.join('')
        }
        case 'env': {
          // **SDO-57（C）**：环境**时序账本** —— 换 JDK/升探针/改类路径就再登记一条，
          // 此后"这条证据是不是在当前环境下得出的"可判（限定语不再静默过期）。
          const recorded = office.noteEnvironment(call, {
            env: args.env ?? '',
            ...(args.reason === undefined ? {} : { note: args.reason }),
            by: 'human',
          })
          if (!recorded.ok) return t('uiIndex.kEnvMissing')
          return fmt('uiIndex.kEnvRecorded', { p1: recorded.env, p2: recorded.at })
        }
        case 'defect': {
          if (args.defectId !== undefined) {
            // **SDO-55**：旧实现只取 `status`，`title` **被静默丢掉**（回执说「已更新」、文件一字未改 ⇒
            // 流程官据此对外误称「已更正」）。现在把给出的字段**都**送进去，并回显**有效差异**；
            // 与现值完全相同 ⇒ 报 `no-op-update`（不得回「已更新」）。
            // **SDO-59（真机 2026-10-07）**：旧实现把**省略** `status` 解释成 `open` ⇒ 只补 `evidence`/只清标题前缀
            // 的更正会**静默把已关闭缺陷重开**（真机 DEF-022/023/024 被重开，seq 2139-2141 留痕）。
            // 现在：**省略 = 保持不变**；给了但取值非法 ⇒ **可读拒绝**（不再悄悄当成 `open`）。
            const requestedStatus = args.status === undefined ? undefined : (['open', 'fixed', 'closed', 'wontfix'] as const).find((item) => item === args.status)
            if (args.status !== undefined && requestedStatus === undefined) {
              return fmt('uiIndex.kDefectBadStatus', { p1: String(args.status) })
            }
            const updated = office.updateDefect(call, args.defectId, {
              ...(requestedStatus === undefined ? {} : { status: requestedStatus }),
              ...(args.title === undefined ? {} : { title: args.title }),
              ...(args.severity === undefined ? {} : { severity: args.severity }),
              ...(args.caseId === undefined ? {} : { caseId: args.caseId }),
              // **追加实测（2026-10-07）**：`evidence=` 曾被静默丢弃（回执说「已更新」、journal 零命中）
              ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
              ...(args.reason === undefined ? {} : { reason: args.reason }),
            }, 'human')
            if (!updated.ok) {
              return updated.code === 'no-op-update'
                ? fmt('uiIndex.kDefectNoOp', { p1: args.defectId, p2: updated.detail })
                : fmt('uiIndex.k122', { p1: args.defectId })
            }
            const diffs = updated.changes.map((change) => `${change.field}: ${change.from} -> ${change.to}`).join('; ')
            const payload = (args.evidence ?? '').trim() === '' && (args.reason ?? '').trim() === ''
              ? ''
              : '\n' + t('uiIndex.kDefectPayloadRecorded')
            return fmt('uiIndex.k43', { p1: updated.defect.id, p2: updated.defect.status }) + '\n' + fmt('uiIndex.kDefectDiff', { p1: diffs }) + payload
          }
          if ((args.title ?? '') === '' || args.severity === undefined) return t('uiIndex.k44')
          // **SDO-59**：**新建**时省略 `status` 仍默认 `open`（新缺陷本来就是 open），但取值非法同样拒绝
          const createdStatus = args.status === undefined ? 'open' : (['open', 'fixed', 'closed', 'wontfix'] as const).find((item) => item === args.status)
          if (createdStatus === undefined) return fmt('uiIndex.kDefectBadStatus', { p1: String(args.status) })
          const defect = office.addDefect(call, {
            title: args.title ?? '',
            severity: args.severity,
            ...(args.caseId === undefined ? {} : { caseId: args.caseId }),
            status: createdStatus,
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
          for (const defect of office.defects(call)) {
            // **SDO-56**：状态标记**由字段派生**；标题里若还写着过时的 `[open]` 之类，如实告警（不改写历史）
            const stale = /^\s*\[(open|fixed|closed|wontfix)\]/u.exec(defect.title)?.[1]
            lines.push(`- ${defect.id}　[${defect.severity}/${defect.status}]　${defect.title}`
              + (stale === undefined ? '' : '\n' + fmt('uiIndex.kDefectTitleStale', { p1: defect.id, p2: stale, p3: defect.status })))
          }
          return lines.join('\n')
        }
      }
    },

    async review(call: OfficeCall, args: ReviewArgs): Promise<string> {
      if (args.action === 'rehash') {
        // **G-2**：老格式评审（记录时没有内容指纹）补记一条 `review/hashed` —— 之后改 verdict / 改发现正文
        // 就能判 `tampered`。**不许洗白**：已有指纹且与当前内容不一致 ⇒ 拒绝（那正是"改过"的证据）。
        if (args.id === undefined) return t('uiIndex.kReviewRehashNoId')
        const result = office.rehashReview(call, { reviewId: args.id, by: args.actor ?? 'human' })
        if (!result.ok) return `${result.code}：${result.detail}`
        // **N-8（D-23③）**：把"比的是哪一套哈希"写在回执里（语义 vs 字节是两个量，读者不该猜）
        const caliber = t('uiIndex.kReviewRehashCaliber')
        return (result.alreadySealed
          ? fmt('uiIndex.kReviewRehashAlready', { p1: args.id })
          : fmt('uiIndex.kReviewRehashed', { p1: args.id, p2: result.contentHash.slice(0, 12) })) + caliber
      }
      if (args.action !== 'record') {
        const reviews = office.reviews(call)
        if (reviews.length === 0) return t('uiIndex.k46')
        const adoptions = new Map(office.reviewAdoptions(call).map((item) => [item.review.id, item]))
        return [
          fmt('uiIndex.m3', { p1: reviews.length }),
          ...reviews.map((review) => {
            const adoption = adoptions.get(review.id)
            const total = review.findings.length
            const open = (adoption?.pending.length ?? 0) + (adoption?.stale.length ?? 0) + (adoption?.forged.length ?? 0)
            // **G-2 可见性**：老格式评审必须写明"不具备防篡改保护"（不许静默当正常条目）
            const guard = adoption?.tamperGuard === 'none-legacy' ? t('uiIndex.kReviewNoTamperGuard') : ''
            // **D-23**：`tampered` / `unrecorded` 在"看发现"之前就返回了 ⇒ 三个下标数组恒为空。
            // 旧写法按"总数 - 0"打印「核实 8/8」，于是同一条回执里既写"被改过"又写"核实 8/8"（假绿）。
            const state = reviewAdoptionLabel(adoption?.state ?? 'unverified')
            const counted = (adoption?.examined ?? false) === true
              ? fmt('uiIndex.kReviewState', { p1: String(total - open), p2: String(total), p3: state })
              : fmt('uiIndex.kReviewNotExamined', { p1: state })
            return `- ${review.id}　${review.taskId}　${review.verdict}（${review.reviewer}）` + counted + guard
          }),
          ...office.reviewViolations(call).map((item) => fmt('uiIndex.k47', { p1: item.detail })),
          // **N-8（D-23③）**：有指纹保护的评审存在时，把**口径**写在回执末尾 ——
          // 真机 D-23 的误判就来自"以为比的是文件字节哈希"，读者不该靠猜。
          ...([...adoptions.values()].some((item) => item.tamperGuard === 'content-hash') ? [t('uiIndex.kReviewTamperCaliber')] : []),
        ].join('\n')
      }
      if (args.taskId === undefined || args.reviewer === undefined || args.verdict === undefined) {
        return t('uiIndex.k48')
      }
      const findings = jsonOr<string[]>(args.findings, 'findings')
      if (findings.error !== undefined) return findings.error
      // **D9（整仓评审）**：`verdict=pass` + **零 findings** 的"空评审"会把 C-42 翻绿（真机复现：空评审前
      // G5/C-42 fail → 一条 findings=[] 的 pass 之后 ok）。评审可以「无发现」，但必须**显式写出来**。
      // **2026-10-08 扩到所有 verdict**：`changes-requested` / `reject` 不写发现，就没有任何可核实、可改的东西，
      // 而"逐条核实"正是评审判定被采纳的前提 —— 空壳评审在这里就该被拒。
      if ((findings.value ?? []).filter((item) => String(item).trim() !== '').length === 0) {
        return t('uiIndex.kReviewEmptyPass')
      }
      const task = office.taskById(call, args.taskId)
      if (task === undefined) return fmt('uiIndex.k49', { p1: args.taskId })
      if (task.owner === args.reviewer) {
        return fmt('uiIndex.k50', { p1: args.taskId, p2: args.reviewer })
      }
      // **SDO-36（真机 REV-031）**：`reviewer` 是**调用方自报的字符串** —— 同一个人把名字从 `reviewer:1`
      // 改成 `reviewer:2` 就过了上面那道护栏（"同人自评"）。这里加一条**可验证**的身份判据：
      // 调用方会话 id 与这张卡的**认领会话 id** 相同 ⇒ 就是同一会话在自评，直接拒。
      const claimSession = office.claimSession(call, args.taskId)
      if (call.sessionId !== undefined && claimSession !== undefined && call.sessionId === claimSession) {
        return fmt('uiIndex.kSelfReviewSameSession', { p1: args.taskId, p2: claimSession })
      }
      const review = office.addReview(call, {
        taskId: args.taskId,
        reviewer: args.reviewer,
        verdict: args.verdict,
        findings: findings.value ?? [],
        // 记下"谁记的"：同会话不许自己核实自己（域层据此拒）
        ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
      })
      return fmt('uiIndex.k51', { p1: review.id, p2: review.taskId, p3: review.verdict, p4: review.reviewer, p5: task.owner === undefined ? '' : fmt('uiIndex.k117', { p1: task.owner }) })
        + '\n' + fmt('uiIndex.kReviewAwaitingVerification', { p1: String(review.findings.length), p2: review.id })
    },

    async deliver(call: OfficeCall, args: DeliverArgs): Promise<string> {
      // **真机运行记录**（用户要求 2026-10-06：「要真机测试才能交付」，其他系统同理）：
      // `action=run` 记一条「在真实环境跑过」的证据，并**当场绑定被运行产物的 sha256**。
      // 交付（`action=package`）只有在存在「通过 + 哈希与本次交付产物相等」的运行记录时，
      // 才允许 `pass` 行；否则全部降级为 `unverified`（绝不默认通过）。
      if (args.action === 'run') {
        // **D11（整仓评审）**：旧实现「不是 fail 就是 pass」⇒ **省略/写错 `outcome`** 会被记成 `pass`，
        // 而交付只认 `outcome==='pass'` 的运行 ⇒ 忘记声明结论就抹掉了真机证据缺口。现在必须显式给。
        if (args.outcome !== 'pass' && args.outcome !== 'fail') {
          return fmt('uiIndex.kRunBadOutcome', { p1: String(args.outcome ?? '') })
        }
        const recorded = office.recordRun(call, {
          target: args.target ?? '',
          command: args.command ?? '',
          outcome: args.outcome === 'fail' ? 'fail' : 'pass',
          evidence: args.evidence ?? '',
          artifact: args.artifact,
          exitCode: args.exitCode,
          by: args.by ?? 'human',
        })
        if (!recorded.ok) return fmt('uiIndex.kRunRejected', { p1: recorded.detail })
        const bound = recorded.run.artifactSha256 === ''
          ? t('uiIndex.kRunUnbound')
          : fmt('uiIndex.kRunBound', { p1: recorded.run.artifact, p2: recorded.run.artifactSha256.slice(0, 12) })
        return fmt('uiIndex.kRunRecorded', {
          p1: recorded.run.id,
          p2: recorded.run.target,
          p3: recorded.run.outcome,
          p4: bound,
        })
      }
      if (args.action !== 'package') {
        const manifest = office.manifest(call)
        return manifest === undefined ? t('uiIndex.k123') : describeManifest(manifest, office.shapeNotes(call))
      }
      const artifacts = jsonOr<{ path: string; kind?: string }[]>(args.artifacts, 'artifacts')
      if (artifacts.error !== undefined) return artifacts.error
      if ((artifacts.value ?? []).length === 0) return t('uiIndex.k52')
      const acceptance = jsonOr<{ requirement: string; criterion: string; evidence: string; verdict?: string; deviation?: string }[]>(args.acceptance, 'acceptance')
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
        // **SDO-41（真机，最严重）**：旧实现把**非法/缺失**的 `verdict` 一律落成 `pass`
        // ⇒ 提交 `unverified` 被静默改写成「通过」（框架主动生产假绿记录），且没有任何提示。
        // 现在：取值集合之外一律落 `unverified`（**不是** `pass`），并在回执里逐行点名被改写的那些。
        acceptance: (acceptance.value ?? []).map((row) => ({
          requirement: row.requirement,
          criterion: row.criterion,
          evidence: row.evidence,
          verdict: verdictOf(row.verdict),
          // **R-21（连带）**：逐字段重建行时**必须带上 `deviation`** —— 否则 `pass-with-deviation`
          // 到了域层就变成"缺偏差说明"，守卫会把如实声明偏差的行判红（真机就是这个形状）。
          ...(typeof row.deviation === 'string' && row.deviation.trim() !== '' ? { deviation: row.deviation } : {}),
        })),
        rollbackPoint: args.rollbackPoint ?? '',
        runsRequired: (args.runsRequired ?? '').split(',').map((item) => item.trim()).filter((item) => item !== ''),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
      })
      const docs = office.renderVerificationDocs(call)
      const lines = [describeManifest(result.manifest, office.shapeNotes(call))]
      if (result.missingArtifacts.length > 0) lines.push(fmt('uiIndex.k54', { p1: result.missingArtifacts.join(' ') }))
      // **SDO-41**：被改写的 verdict 必须逐行点名（真机症状：13 行 `unverified` 变成 15/15 pass，零提示）
      const rewritten = (acceptance.value ?? []).filter((row) => verdictOf(row.verdict) !== row.verdict)
      if (rewritten.length > 0) {
        lines.push(fmt('uiIndex.kAcceptanceVerdictRewritten', {
          p1: String(rewritten.length),
          // **R-21**：合法取值从常量生成（手抄一份就是下一次漂移的来源）
          p2: rewritten.map((row) => `${row.requirement}:${row.verdict}→${verdictOf(row.verdict)}`).join(' '),
          p3: ACCEPTANCE_VERDICTS.join('/'),
        }))
      }
      // **R-22**：交付回执也必须把"带已知偏差通过"说出来（报告把这条标为未核实 —— 核实后：那边确实没有；
      // 于是"交付文档里看得见、回执里看不见"，人最常看的那处仍然与干净通过长得一样）
      const deviationNote = deviationsNote(result.manifest)
      if (deviationNote !== undefined) lines.push(deviationNote)
      // **真机运行证据**：缺证据时交付回执必须**先**说这件事（它解释了下游为什么一片 unverified）
      for (const gap of result.manifest.runGaps) lines.push(fmt('uiIndex.kRunGap', { p1: gap }))
      // **SDO-57（C）**：交付回执必须摆出**证据时效**（过期 / 没记环境）—— 限定语过期的代价，
      // 真机上是一整轮复评 + 一次"唯一失败项"的误判
      const freshness = office.evidenceFreshness(call)
      for (const item of freshness.stale) lines.push(fmt('uiIndex.kEvidenceStale', { p1: item.resultId, p2: item.caseId, p3: item.reason }))
      if (freshness.unrecorded.length > 0) {
        lines.push(fmt('uiIndex.kEvidenceUnrecorded', { p1: String(freshness.unrecorded.length), p2: freshness.unrecorded.join(' ') }))
      }
      const notPass = result.manifest.acceptance.filter((row) => row.verdict !== 'pass')
      if (notPass.length > 0) {
        lines.push(fmt('uiIndex.kAcceptanceNotPass', {
          p1: String(notPass.length),
          p2: notPass.map((row) => `${row.requirement}:${row.verdict}`).join(' '),
        }))
      }
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
      /**
       * **N-18（推进记录里的"白签一次"）**：签完立刻**现算**本门还缺哪些判据，并把它们写进回执。
       *
       * 为什么不"签前拦"：G2/G3 的判据里**包含签字本身**（C7），签前现算必然把"缺签字"当成未满足 ⇒
       * 要么噪声、要么死锁（G2 本来就是先签后 baseline）。所以口径是：**签字照记**，但当场告诉你
       * 剩下的洞与"不必再签"（除非期间真源又变）。
       */
      const signPrecheck = (gate: string): string => {
        const evaluation = office.evaluate(call, gate)
        const unmet = evaluation.criteria.filter((item) => item.ok !== true && item.na !== true)
        if (unmet.length === 0 || evaluation.criteria.length === 0) return ''
        return fmt('uiIndex.kSignPrecheckUnmet', {
          p1: String(unmet.length),
          p2: unmet.map((item) => item.id).join(' '),
          p3: gateLabel(gate),
        })
      }
      if (args.action === 'sign') {
        // §7.2 门禁级签字：**只承认两种来源**，且必须带上用户原话／所选选项原文
        if (args.gate === undefined) return t('uiIndex.k60')
        if (args.channel === 'question') {
          const answer = await deps.gateSignQuestion?.(call, args.gate)
          if (answer === undefined) return t('uiIndex.kSignNoChannel')
          if (answer.selectedLabel !== t('uiSign.signOption')) {
            // **次要 2（2026-10-09 整体评审）**：question 通道的"用户拒绝"以前**不留痕** ⇒
            // 台账上"问过、被拒"与"没问过"长得一样。与陈述式拒绝同口径记一条中性事件。
            office.noteSignRejected(call, args.gate, 'question', answer.selectedLabel)
            return fmt('uiIndex.kSignDeclined', { p1: gateLabel(args.gate), p2: answer.selectedLabel })
          }
          const signature = office.signGate(call, {
            gate: args.gate,
            by: args.approvedBy ?? 'human',
            // 引用 = **用户所选选项原文**（由本工具自己取回，不经过模型）
            basis: answer.selectedLabel,
            channel: 'question',
            // **R-27（回归修正）**：question 通道的依据是**本次当场取回**的（工具自己问的用户），
            // 选项标签逐字重复是设计使然 ⇒ 不参与重放判定（否则第二次点选会被误拒）。
            basisFresh: true,
            ...(args.turn === undefined ? {} : { turn: args.turn }),
          })
          return describeSignature(signature, office.signatureState(call, signature.gate)) + signPrecheck(signature.gate)
        }
        // `channel=statement`（默认）：用户在会话中明确表述过 → 必须给出用户原话
        const quote = (args.quote ?? '').trim()
        if (quote === '') return t('uiIndex.kSignNoQuote')
        // 引用要能在**会话记录**里找到（拿不到会话历史时退回"引用非空"的规格最低要求）；
        // **R-7**：核对口径随签字一起落台账，回执与门禁 detail 会如实标注"未核对"。
        const quoteCheck = office.checkUserQuote(call, quote)
        if (!quoteCheck.ok) {
          office.noteSignRejected(call, args.gate, 'command', quote)
          return t('uiIndex.kSignQuoteMismatch')
        }
        // **R-27（major）**：依据不许重放 —— 同一句用户原话只代表**一次**表态。旧实现只校验"这句话
        // 在会话里出现过"，于是任何旧话都能在任意时刻、对任意门禁反复铸成新签字（真机 `#1132` 复用了
        // `#1099` 的「确认签字」）。这里给出可操作的拒绝：让用户**重新表态**，或改用 `channel=question`
        // 由工具当场问（引用不经过模型）。`recordSignature` 里另有一道强制拒绝。
        // **H2a/H4**：重放判定用**消息身份**（`basisMsgId`，跨压缩稳定）；下标只作审计
        const replay = office.basisReplay(call, args.gate, quote, {
          ...(quoteCheck.basisAt === undefined ? {} : { basisAt: quoteCheck.basisAt }),
          ...(quoteCheck.basisMsgId === undefined ? {} : { basisMsgId: quoteCheck.basisMsgId }),
        })
        if (replay.replayed) {
          // **R-28 建议 5**：被拒的签字尝试也要落痕（审计要能看见"有人试图签字并被拦"）。
          // 该事件在 `SIGNATURE_NEUTRAL_EVENTS` 里 —— **被拒不等于真源变更**，不许顺带作废已签的字。
          office.noteSignRejected(call, args.gate, 'command', quote)

          return fmt('uiIndex.kSignBasisReplayed', {
            p1: gateLabel(args.gate),
            p2: String(replay.usedAtSeq ?? '?'),
            p3: String(replay.lastInvalidation ?? '?'),
          })
        }
        const signature = office.signGate(call, {
          gate: args.gate,
          by: args.approvedBy ?? 'human',
          basis: quote,
          channel: 'command',
          basisChecked: quoteCheck.basisChecked,
          ...(quoteCheck.basisMsgId === undefined ? {} : { basisMsgId: quoteCheck.basisMsgId }),
          ...(quoteCheck.basisAt === undefined ? {} : { basisAt: quoteCheck.basisAt }),
          ...(args.turn === undefined ? {} : { turn: args.turn }),
        })
        return describeSignature(signature, office.signatureState(call, signature.gate)) + signPrecheck(signature.gate)
      }
      if (args.action === 'waive') {
        if (args.gate === undefined) return t('uiIndex.k56')
        if ((args.reason ?? '').trim() === '' || (args.approver ?? '').trim() === '') {
          return t('uiIndex.k57')
        }
        // **R-27 连带**：豁免给了用户原话就核对它（给了而核不过 ⇒ 拒绝，与签字同口径）；
        // 没给也不拦（自救出口），但台账与回执必须说清"这条批准人没有用户原话依据"。
        const waiveQuote = (args.quote ?? '').trim()
        let basis: { quote: string; checked: 'session' | 'role-only' | 'unavailable' } | undefined
        if (waiveQuote !== '') {
          const check = office.checkUserQuote(call, waiveQuote)
          if (!check.ok) return fmt('uiIndex.kWaiveQuoteMismatch', { p1: waiveQuote })
          basis = { quote: waiveQuote, checked: check.basisChecked }
        }
        const recorded = office.waiveGate(call, args.gate, args.reason ?? '', args.approver ?? '', basis)
        // **R-29**：对**当前流程不存在**的门禁，"已豁免…"这个断言是假的（真正发生的只有"被拒"）——
        // 回执只给判定 + 可用清单，不许先说"已豁免"、也不许说"判定记录已写入"（那条已由
        // `describeGate` 的 `persisted` 条件行收口，这里再挡住开篇的假断言）。
        if (recorded.status === 'failed') {
          return fmt('uiIndex.kWaiveRefused', { p1: gateLabel(recorded.gate), p2: describeGate(recorded) })
        }
        const basisLine = basis === undefined
          ? '\n' + fmt('uiIndex.kWaiveNoBasis', { p1: args.approver ?? '' })
          : '\n' + fmt('uiIndex.kWaiveBasis', { p1: basis.quote, p2: t(`uiIndex.kWaiveChecked_${basis.checked}`) })
        return fmt('uiIndex.k58', { p1: gateLabel(recorded.gate), p2: args.approver, p3: args.reason, p4: describeGate(recorded) }) + basisLine
      }
      if (args.action === 'unwaive') {
        // **N-10（R-23③ / R-29③）**：撤销一条豁免 —— 误探自愈的唯一出口（`waivedGates` 只增不减）。
        if (args.gate === undefined) return t('uiIndex.k56')
        if ((args.reason ?? '').trim() === '') return t('uiIndex.kUnwaiveNoReason')
        const approver = (args.approver ?? '').trim() === '' ? 'human' : (args.approver ?? '').trim()
        const removed = office.unwaiveGate(call, args.gate, args.reason ?? '', approver)
        if (!removed.ok) return `${removed.code}：${removed.detail}`
        const process = office.process(call)
        const lines = [
          fmt('uiIndex.kUnwaiveDone', {
            p1: gateLabel(removed.gate),
            p2: removed.waivedGates.length === 0 ? t('uiIndex.kUnwaiveNone') : removed.waivedGates.join(' '),
          }),
        ]
        if (!removed.inProcess && process !== undefined) {
          lines.push(fmt('uiIndex.kUnwaiveNotInProcess', { p1: gateLabel(removed.gate), p2: process.id ?? '' }))
        }
        lines.push(t('uiIndex.kUnwaiveSignatureNote'))
        return lines.join('\n')
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
          // **R-25**：改号是 `replace` 的自然结果，但**必须报出来** —— AC 编号是交付验收矩阵的追溯键。
          // 旧实现在这里静默换号：真机"只改 AC 文本"就把已出的交付包判红（六条引用全部失配）。
          const beforeAcceptance = office
            .requirements(call)
            .find((item) => item.id === args.id)
            ?.acceptance.map((ac) => ac.id) ?? []
          // **N-7（D-21④）**：动的是不是**受控字段**（已冻结需求上的 AC）—— 规范路径是 `change`。
          const controlledAcceptance =
            criteria.length > 0
            && (office.requirements(call).find((item) => item.id === args.id)?.status === 'baselined')
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
          const renumbered = replace
            ? result.requirement.acceptance
                .map((ac, index) => ({ from: beforeAcceptance[index] ?? '', to: ac.id }))
                .filter((item) => item.from !== '' && item.from !== item.to)
            : []
          return describeRequirementUpdate(
            {
              ...result,
              ...(renumbered.length === 0 ? {} : { acceptanceRenumbered: renumbered }),
              ...(controlledAcceptance ? { controlledAcceptance: true } : {}),
            },
            office.shapeNotes(call),
          )
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
          // **D-21**：schema 里 `acceptance`/`acceptanceMode` 一直都声明着，但旧实现只给
          // `capture`/`update` 读 ⇒「基线后 AC 变了」既进不了 CR 摘要、也不会被应用。
          // 这里与 `update` 逐字同口径：同一份 JSON 形状、同一套发号、同一个 `acceptanceMode` 校验。
          const acceptance = jsonOr<{ given?: string; when?: string; then?: string }[]>(args.acceptance, 'acceptance')
          if (acceptance.error !== undefined) return acceptance.error
          const mode = args.acceptanceMode ?? 'append'
          if (mode !== 'append' && mode !== 'replace') {
            return fmt('uiIndex.kAcceptanceModeInvalid', { p1: mode })
          }
          const replace = mode === 'replace'
          const acRows = acceptance.value ?? []
          const acIds = acRows.length === 0
            ? []
            : makeAcceptanceIds(office.storeFor(office.requireWorkspace(call)), acRows.length)
          const criteria: AcceptanceCriterion[] = acRows.map((row, index) => ({
            id: acIds[index] ?? `AC-${index + 1}`,
            given: row.given ?? '',
            when: row.when ?? '',
            then: row.then ?? '',
          }))
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
          // **D-21**：AC 变更必须进 CR 摘要 —— `changes[]` 是这份变更单"改了什么"的唯一人读记录，
          // 否则一条只改 AC 的 CR 会写成「仅记录变更请求，未给出具体字段」（真机核实：批准后 AC 一条没动）。
          if (criteria.length > 0) {
            if (replace) {
              changes.push(fmt('uiIndex.kChangeAcceptanceReplace', {
                p1: criteria.length,
                p2: criteria.map((item) => item.id).join(' '),
              }))
            } else {
              for (const item of criteria) {
                changes.push(fmt('uiIndex.kChangeAcceptanceAdd', {
                  p1: item.id,
                  p2: item.given,
                  p3: item.when,
                  p4: item.then,
                }))
              }
            }
          }
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
              ...(criteria.length === 0 ? {} : replace ? { replaceAcceptance: criteria } : { addAcceptance: criteria }),
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
          // **D-3**：`options`/`recommendation` 也在这里接受（模型通道以前结构上不可能带选项）
          const parsed = jsonOr<ProposedQuestion[]>(args.questions, 'questions')
          if (parsed.error !== undefined) return parsed.error
          const result = office.fileRedTeam(call, args.requirementId, parsed.value ?? [])
          const lines = [
            t('redteam.fileAccepted').replace('{n}', String(result.accepted.length)),
          ]
          for (const question of result.accepted) {
            const options = question.options === undefined || question.options.length === 0
              ? ''
              : fmt('redteam.fileOptionCount', { p1: String(question.options.length) })
            lines.push(`- ${question.id}｜${question.text}${options}`)
          }
          if (result.rejected.length > 0) {
            lines.push(t('redteam.fileRejected').replace('{n}', String(result.rejected.length)))
            for (const item of result.rejected) lines.push(`- ✗ ${item.text}｜${item.reason}`)
          }
          lines.push(t('redteam.fileAskHint'))
          return lines.join('\n')
        }
        // **D-5（sdo-test-new 2026-10-08，major）**：显式处置一个红队议题 —— 这条路径以前**完全不可达**
        // （`disposeIssue()` 是唯一写 `issue/closed` 的地方，却没有任何 action 接到它），于是议题文件
        // 永远停在 `status: open`，而 C8 从问题/风险**现算**闭环 ⇒ 文件与门禁给出相反结论。
        case 'dispose': {
          if (args.id === undefined || args.id.trim() === '') return t('uiIndex.kIssueDisposeNeedId')
          const disposition = args.disposition === 'risk' || args.disposition === 'requirement' ? args.disposition : undefined
          if (disposition === undefined) return t('uiIndex.kIssueDisposeNeedDisposition')
          // 处置**前**它是"现算未闭环"还是"现算已闭环"必须分开说：
          //  · 现算未闭环 ⇒ 这次是真的把它闭环了（文件与门禁同时变）；
          //  · 现算已闭环 ⇒ 只是把**文件**追平（门禁结论没变），这正是真机 D-5 的形态。
          const stillOpen = office.openIssues(call).some((item) => item.issue.id === args.id)
          const disposed = office.disposeIssue(call, args.id.trim(), disposition, args.note ?? '')
          if (disposed === undefined) return fmt('uiIndex.kIssueDisposeMissing', { p1: args.id })
          return fmt('uiIndex.kIssueDisposed', {
            p1: disposed.id,
            p2: disposition === 'risk' ? t('uiIndex.kIssueDispositionRisk') : t('uiIndex.kIssueDispositionRequirement'),
            p3: stillOpen ? t('uiIndex.kIssueDisposeWasOpen') : t('uiIndex.kIssueDisposeAlreadyClosed'),
          })
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
        // **D10（整仓评审）**：这一分支拿到 `approvedBy` 却用 `t()` 打印 ⇒ 回执漏出占位符 `{x}`
        return fmt('uiIndex.planReviewed', { p1: args.approvedBy ?? 'human' })
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
            fmt('uiIndex.planLoadDiag', { p1: t('uiIndex.planLoadNone') }),
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
          // **§4.4（第二轮评审 HIGH）**：旧实现无论目标存不存在都先记新 ADR，只有找到旧记录才标记它，
          // 而回执文案却是「已取代 {p1}」⇒ 取代一个不存在的 ADR 会**静默不生效却报已取代**。先做存在性校验。
          if (args.supersedes !== undefined && !office.adrs(call).some((item) => item.id === args.supersedes)) {
            return fmt('uiIndex.kAdrSupersedeMissing', { p1: args.supersedes })
          }
          // **D-8（sdo-test-new 2026-10-08，major）**：schema 上的 `id` 以前**从不被读**（传 ADR-999 落 ADR-006）。
          // 现在显式给了就用它，但必须先把两件事挡在前面：形状（它直接变成文件名）与冲突（会覆盖决策史）。
          if (args.id !== undefined && args.id.trim() !== '') {
            const wanted = args.id.trim()
            if (!isAdrId(wanted)) return fmt('uiIndex.kAdrIdBad', { p1: wanted })
            if (office.adrs(call).some((item) => item.id === wanted)) return fmt('uiIndex.kAdrIdTaken', { p1: wanted })
            if (args.action === 'supersede' && args.supersedes === wanted) return fmt('uiIndex.kAdrIdTaken', { p1: wanted })
          }
          const adr = office.recordAdr(call, {
            title: args.title ?? '',
            context: args.context ?? '',
            decision: args.decision ?? '',
            alternatives: alternatives.value ?? [],
            consequences: consequences.value ?? [],
            ...(args.id !== undefined && args.id.trim() !== '' ? { id: args.id.trim() } : {}),
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
      // B5 的角色缓存：`roleCacheVersion` 变化（认领/回报）或**超过 TTL** 才重算，避免每次工具调用都读 journal。
      // TTL 是给"台账被别的进程/实例改写"留的兜底（本进程的版本号不会因外部写入而变）——最多陈旧 5 秒。
      const ROLE_CACHE_TTL_MS = 5_000
      let roleCacheKey = ''
      let roleCacheAt = 0
      let roleClaims: ReturnType<typeof claimsBySession> = []

      toolCtx.effect(() => {
        const off = (
          toolCtx as unknown as {
            on(event: string, listener: (exec: { name?: string; arguments?: unknown; agent?: { id?: unknown } }, next: () => Promise<unknown>) => Promise<unknown>): () => void
          }
        ).on('tools/pre-execute', async (exec, next) => {
          try {
            // ——— B5：先认出"这次调用是谁发的" ———
            // 宿主在 `ToolExecution.agent` 上给了发起者（"the agent on whose behalf the call runs"）。
            // 老实现把 role 写死成 `cockpit`，而阶段纪律对 cockpit 首行放行 ⇒ 纪律与掩码都不生效。
            const agent = (exec as { agent?: unknown }).agent
            const call = injectionCall(agent)
            const tool = String(exec.name ?? '')
            // **执行者禁令**的判据：这个会话是不是**被派发的子会话**（血缘来自会话首部）。
            // 驾驶舱（depth 0 / 无 parentSession）不是执行者 ⇒ 即使认领了卡也仍能派发。
            const sessionHeader = (agent as { session?: { header?: { delegationDepth?: unknown; parentSession?: unknown } } } | undefined)?.session?.header
            const delegationDepth = sessionHeader?.delegationDepth
            const parentSessionId = sessionHeader?.parentSession
            const isChildSession = typeof delegationDepth === 'number' ? delegationDepth >= 1 : typeof parentSessionId === 'string'
            const attributed = ((): RoleAttribution => {
              if (call.cwd === undefined) return { kind: 'unknown', role: 'cockpit' }
              const cacheKey = `${call.cwd}#${office.roleCacheVersion}`
              if (roleCacheKey !== cacheKey || Date.now() - roleCacheAt > ROLE_CACHE_TTL_MS) {
                roleCacheKey = cacheKey
                roleCacheAt = Date.now()
                roleClaims = claimsBySession(office.storeFor(call.cwd), office.journalFor(call.cwd))
              }
              const depth = delegationDepth
              const parentSession = parentSessionId
              return attributeRole({
                sessionId: call.sessionId,
                delegationDepth: typeof depth === 'number' ? depth : undefined,
                // **R-1**：把血缘一起传进去 —— 根会话不该因为"认领过 developer 卡"而被判成 developer
                parentSessionId: typeof parentSession === 'string' ? parentSession : undefined,
                claims: roleClaims,
                // **§2 第 1 条**：卡离开 `in-progress` 后认领归属会失效，这时用**派发时记下的角色**兜底
                // （否则掩码整段消失：实测 drop 掉卡 + 等过角色缓存 TTL ⇒ reviewer 子会话 `write` 变 ALLOW）
                dispatchedRole: office.dispatchedRoleOf(call),
              })
            })()

            // **D1**：宿主 `@deepseek-ai/dsh-tool-fs` 的 `write`/`edit` **只声明 `file_path`**（全包 41 处，
            // 没有 `path`/`file`/`paths`）⇒ 旧代码读的是插件「期望」的键、`paths` 恒为空，于是
            // 快照 / `truth/file-written` / L3 路径纪律在真机上**一次都没跑过**。宿主真实键放首位，旧键保留兼容。
            const args = (exec.arguments ?? {}) as { file_path?: unknown; path?: unknown; file?: unknown; paths?: unknown }
            const rawPaths = [
              ...(typeof args.file_path === 'string' ? [args.file_path] : []),
              ...(typeof args.path === 'string' ? [args.path] : []),
              ...(typeof args.file === 'string' ? [args.file] : []),
              ...(Array.isArray(args.paths) ? args.paths.filter((item): item is string => typeof item === 'string') : []),
            ]
            // **写范围纪律的前置**：真机传的是**绝对路径**，而卡写范围是相对路径 ——
            // 不归一就永远比不上（原 L3 纪律的 `startsWith('src/')` 就是这么空转的）。归一一次，三处共用。
            const paths = rawPaths.map((path) => normalizeWorkspacePath(path, call.cwd))

            // ——— B6：认得出的派发角色 ⇒ 掩码**硬拦**（两层语义：`sdo_*` 白名单 + 通用面黑名单） ———
            // **执行者禁令**只对**子会话**生效：驾驶舱即使认领了卡（inline 后端就是这么跑的）仍是流程官，
            // 派发是它的本职（真机 F2：单会话模式下驾驶舱被自己的角色归属锁死，连 sdo_gate 都调不了）。
            if (settings.enforceRoleMask && attributed.kind === 'dispatched') {
              const mask = roleMaskDecision(attributed.role, tool, { executor: isChildSession })
              if (mask.kind === 'deny') {
                return {
                  kind: 'deny',
                  reason: mask.reason === 'executor-forbidden'
                    ? fmt('uiIndex.kMaskExecutorForbidden', { p1: attributed.role, p2: mask.tool, p3: roleCardPath(attributed.role) })
                    : mask.reason === 'executor-denied'
                      ? fmt('uiIndex.kMaskExecutorDenied', { p1: attributed.role, p2: mask.tool, p3: roleCardPath(attributed.role) })
                      : fmt('uiIndex.kMaskDenied', {
                        p1: attributed.role,
                        p2: mask.tool,
                        p3: toolAllowList(attributed.role).join(' / '),
                        p4: roleCardPath(attributed.role),
                      }),
                }
              }
            }

            // ——— **写入范围纪律（3a 公共面 + 3b 卡级，2026-10-08 用户裁定）** ———
            // "谁能写"是角色掩码的事；"能写到哪里"是这一层。两者的失效方向不同，必须分开：
            //   · `disciplineAllowPaths`（公共面：台账/派生文档/测试）不受卡范围约束；
            //   · 其余路径必须落在**这张活卡的 writeScopes** 内，没认领就只能写公共面。
            // 只对认得出的角色生效（驾驶舱/未知 ⇒ fail-open）；`bash` 没有路径参数 ⇒ 判不了（如实标 unchecked，
            // 靠 `done` 的 A2 写范围对账兜底）。
            if (attributed.kind !== 'unknown') {
              const claimCard = attributed.kind === 'dispatched' && attributed.cardId !== undefined
                ? office.taskById(call, attributed.cardId)
                : undefined
              const scopeDecision = evaluateWriteScope({
                role: attributed.role,
                tool,
                paths: rawPaths,
                workspace: call.cwd,
                guardedTools: settings.disciplineTools,
                sharedPaths: settings.disciplineAllowPaths,
                ...(attributed.kind === 'dispatched' && attributed.cardId !== undefined
                  ? { cardScopes: claimCard?.writeScopes.map((scope) => String(scope)) ?? [] }
                  : {}),
              })
              if (scopeDecision.kind === 'deny') {
                const key = scopeDecision.code === 'write-scope-no-claim'
                  ? 'uiIndex.kWriteScopeNoClaim'
                  : scopeDecision.code === 'write-scope-empty-scope'
                    ? 'uiIndex.kWriteScopeEmptyScope'
                    : 'uiIndex.kWriteScopeViolation'
                return {
                  kind: 'deny',
                  reason: fmt(key, {
                    p1: attributed.role,
                    p2: scopeDecision.detail,
                    p3: scopeDecision.scope.join(' / ') || t('uiDescribe.k169'),
                  }),
                }
              }
            }

            // ——— L3 阶段纪律：用**真实角色**判（认不出时按驾驶舱 fail-open） ———
            const status = office.status(call.cwd === undefined ? office.callForScope(undefined) : call)
            // **SDO-19 / SDO-26（真机事故）**：直接 `write`/`edit` 覆盖 `.sdo/` 下**手可编辑真源**之前
            // 先把旧内容快照到 `.sdo/evidence/file-history/`。真机上 `.sdo/design/deviations.yml` 被整篇
            // 重写 ⇒ 27 条 DEV 与 A1–A10 正文**永久丢失**（journal 无正文、宿主存档也没有）。
            // 只留可恢复副本、不改行为：任何异常都 fail-open（绝不因为快照失败挡住写操作）。
            if (tool === 'write' || tool === 'edit') {
              for (const path of paths) {
                try {
                  office.snapshotTruthFile(call, path)
                  // R2：记下写入前的哈希（读不到就当空串 = 新文件）
                  try {
                    preWriteHashes.set(`${String(exec.agent?.id ?? '')}|${path}`, office.truthFileHash(call, path))
                  } catch {
                    /* fail-open */
                  }
                } catch {
                  /* fail-open */
                }
              }
            }
            const decision = disciplineOrAllow({
              gateLevel: settings.gateLevel,
              phase: status.project?.phase ?? '',
              role: attributed.role,
              tool,
              paths,
              initialized: status.project !== undefined,
            })
            if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason }
          } catch {
            /* fail-open：钩子异常一律放行（认不出人不能变成干不了活） */
          }
          return next()
        })
        return () => off()
      }, 'sdo:discipline-guard')

      // **SDO-19（2026-10-05 真机）**：写**成功之后**把"绕过 SDO 直接改 `.sdo/` 真源"记成真源事件
      // （`truth/file-written`）。为什么必须在 post 阶段：pre 阶段拿不到结果，把**被拒**的写也记成
      // "真源变了"是另一种撒谎。fail-open：任何异常都照原样放行结果。
      // R2：pre 阶段记下"写入前的文件哈希"（key = 会话 + 路径），post 只有**真变了**才记账
      const preWriteHashes = new Map<string, string>()
      toolCtx.effect(() => {
        const off = (
          toolCtx as unknown as {
            on(
              event: string,
              listener: (exec: { name?: string; arguments?: unknown; agent?: unknown }, result: unknown, next: () => Promise<unknown>) => Promise<unknown>,
            ): () => void
          }
        ).on('tools/post-execute', async (exec, result, next) => {
          try {
            const tool = String(exec.name ?? '')
            // **R2（复审 major）**：宿主明确「tool failures still receive post-execute」——
            // 旧实现不判失败 ⇒ 一次**失败**的 `.sdo` 写入照样记 `truth/file-written`，把 G3 签字作废。
            // fail-open 的方向是"照原样放行结果"，不是"照原样记账"：写失败 = 真源没变 ⇒ 不记。
            const failed = typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true
            if ((tool === 'write' || tool === 'edit') && !failed) {
              // **D1**：同上 —— 宿主真实键是 `file_path`（post 记账这一处以前也恒空）
              const raw = (exec.arguments ?? {}) as { file_path?: unknown; path?: unknown; file?: unknown; paths?: unknown }
              const paths = [
                ...(typeof raw.file_path === 'string' ? [raw.file_path] : []),
                ...(typeof raw.path === 'string' ? [raw.path] : []),
                ...(typeof raw.file === 'string' ? [raw.file] : []),
                ...(Array.isArray(raw.paths) ? raw.paths.filter((item): item is string => typeof item === 'string') : []),
              ]
              const postCall = injectionCall(exec.agent)
              // R2：只记**内容真的变了**的路径（内容相同的重写不该作废签字）
              const changed = paths.filter((path) => {
                const key = `${String((exec.agent as { id?: unknown } | undefined)?.id ?? '')}|${path}`
                const before = preWriteHashes.get(key)
                preWriteHashes.delete(key)
                if (before === undefined) return true
                try {
                  return office.truthFileHash(postCall, path) !== before
                } catch {
                  return true
                }
              })
              if (postCall.cwd !== undefined && changed.length > 0) office.noteTruthFileWrites(postCall, changed)
            }
          } catch {
            /* fail-open */
          }
          return next()
        })
        return () => off()
      }, 'sdo:truth-write-observer')

      for (const tool of createOfficeTools(deps)) {
        // 记下**真实注册名**：派发时用它算 deny 面（SDO 流程面白名单的补集）
        officeToolNames.push(tool.name)
        // 工具输出统一截断（防上下文膨胀）：完整内容在 .sdo/ 真源，回执里会说明如何重取
        const clampExecute = tool.execute as unknown as (args: unknown, exec: unknown) => unknown
        const clamped = {
          ...tool,
          execute: async (args: unknown, exec: unknown) => {
            const result = clampToolResult(String(await clampExecute(args, exec)))
            // **子代理报告推送（③ 的"推"半）**：把驾驶舱还没看过的报告**贴在下一次工具回执**上。
            // 宿主不给子会话→父会话的投递通道（`agent/inbox/splice` 是宿主侧事件），所以用回执当载体：
            // 模型在下一次调用里就会看到"某某子代理完成了 + 报告摘要"，不必自己去 `sdo_status` 拉。
            try {
              const call = callOf(exec as never)
              const pending = office.pendingDispatchReports(call as never)
              if (pending.length === 0) return result
              const shown = pending.slice(0, 3)
              const lines = shown.map((item: DispatchFinished) => {
                const report = office.reportText(call, item.report)
                return fmt('uiDispatch.kReportedLine', {
                  p1: item.task === '' ? item.childSessionId.slice(0, 8) : item.task,
                  p2: item.reason === '' ? '?' : item.reason,
                  p3: item.report,
                }) + (report === undefined ? '' : `\n  ${excerptOf(report, 900)}`)
              })
              office.markDispatchReported(call, shown.map((item) => ({ childSessionId: item.childSessionId, report: item.report, seq: item.seq })))
              const more = pending.length > shown.length ? '\n' + fmt('uiDispatch.kReportedMore', { p1: String(pending.length - shown.length) }) : ''
              return result + '\n\n' + t('uiDispatch.kReportedHeader') + '\n' + lines.join('\n') + more
            } catch {
              return result // 推送失败绝不影响工具本身的结果
            }
          },
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

/**
 * 验收行的 `verdict` 取值（**SDO-41**）。
 *
 * 合法取值**只有一份**：`ACCEPTANCE_VERDICTS`（域层）—— **R-21（sdo-test-new 2026-10-08，major）**：
 * 这里曾自己抄了一份枚举，R-15 新加的 `pass-with-deviation` 没跟上 ⇒ 行**在到达 `packageDelivery` 之前**
 * 就被改写成 `unverified` ⇒ 新档位端到端不可用，而"缺 `deviation` 判红"那条守卫**永远不可达**。
 * 现在从常量派生（与 R-20「描述 vs schema」同一类病的同一个治法）。
 * 原则不变：**其它一律归 `unverified`**（宁可说「未验证」，绝不默认「通过」）；被改写哪些行由回执逐行点名。
 */
function verdictOf(value: unknown): AcceptanceVerdict {
  const text = String(value ?? '').trim()
  return (ACCEPTANCE_VERDICTS as readonly string[]).includes(text) ? (text as AcceptanceVerdict) : 'unverified'
}
