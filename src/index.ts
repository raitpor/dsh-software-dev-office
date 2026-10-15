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
import { dirname } from 'node:path'
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'

import { boardModelFor, renderBoard } from './board/render.js'
import { describeExemptions } from './interface/describe.js'
import { exemptionLines } from './domain/construction.js'
import { ACCEPTANCE_VERDICTS, DEFECT_DISCOVERY_LEVELS, isDefectDiscoveryLevel, ReviewDefectError, ReviewReproError } from './domain/records.js'
import type { AcceptanceVerdict, Review } from './domain/records.js'
// **REQ-054（TASK-054）**：判定基准（oracle）—— 词表与逐类核对实现都只有一处（`evidence.ts`），
// 工具面只负责"把参数搬到位 + 把缺口原话说出来"，**不在这里另写一份判定语义**。
import { artifactEchoRows, evidenceTally, oracleGaps } from './domain/evidence.js'
import type { OracleRef } from './domain/evidence.js'
import { textOf } from './infra/scalar.js'
import { Config, resolveSettings } from './config.js'
import { registerRoleCardsSkill } from './domain/skills.js'
import type { SdoConfig } from './config.js'
import { contractCoverage } from './domain/contracts.js'
import { describeUndigestedChanges } from './domain/change.js'
import { listRequirementIds, makeAcceptanceIds } from './domain/requirements.js'
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
  describeStructuralPlan,
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
import { callOf, compositeArg, createOfficeTools, parseList } from './interface/tools.js'
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
// **TASK-108**：`sdo_review action=append` 的域层入口在 `collab.ts`（它已持有 `reviewAdoption` ——
// 篡改判据只此一份，不在这里另写）；`office.storeFor` / `office.journalFor` 是 index.ts 能拿到的公开入口。
import { appendReviewFindings } from './domain/collab.js'
import { attributeRole, claimsBySession, filterKnownTools, maskFingerprint, roleCardPath, roleMaskDecision, toolAllowList, curatedDenyPhantoms } from './domain/roles.js'
import { PLUGIN_PACKAGE_NAME, loadedBuild, sameBuild, worktreeBuildOf } from './domain/buildInfo.js'

/**
 * **构建读数行**（DEF-070）：本会话**实际加载**的插件路径 + 构建指纹；能判定"与工作树不同"时如实提示。
 *
 * 两件事分开讲：① 加载位置与指纹（机械事实，读不到就说读不到）；② 与工作树的比对（只在
 * 能确认那个目录就是本插件工作树时才比 —— 否则明说"不可比"，不硬凑结论）。
 */
function buildReadout(cwd: string): string {
  const loaded = loadedBuild()
  if (loaded.source === 'unavailable' || loaded.fingerprint === '') {
    return fmt('uiIndex.kBuildUnavailable', { p1: loaded.packageRoot === '' ? t('uiIndex.kBuildNoPath') : loaded.packageRoot })
  }
  const base = fmt('uiIndex.kBuildInfo', {
    p1: loaded.packageRoot,
    p2: loaded.fingerprint,
    p3: loaded.version === '' ? t('uiIndex.kBuildNoVersion') : loaded.version,
  })
  const tree = worktreeBuildOf(cwd)
  if (tree === undefined) return base
  const same = sameBuild(loaded, tree)
  if (same === undefined) return base + '\n' + fmt('uiIndex.kBuildNotComparable', { p1: tree.packageRoot })
  if (same) return base + '\n' + fmt('uiIndex.kBuildSameAsWorktree', { p1: tree.packageRoot })
  return base + '\n' + fmt('uiIndex.kBuildMismatch', {
    p1: tree.packageRoot,
    p2: tree.fingerprint === '' ? t('uiIndex.kBuildNoFingerprint') : tree.fingerprint,
    p3: PLUGIN_PACKAGE_NAME,
  })
}
import type { RoleAttribution } from './domain/roles.js'
import { reuseCapability, startDispatch } from './integration/dispatch.js'
import type { SubagentRuntimeLike } from './integration/dispatch.js'
import { isRole, mitigatesWaiverOf } from './domain/plan.js'
import type { NonDispatchablePlan } from './domain/plan.js'
import type { MitigatesWaiver } from './types.js'
import { sessionIdOf } from './interface/scope.js'
import { toolCallNameOf, toolNamesOfHeader } from './domain/dispatchFace.js'
import { reviewAdoptionLabel } from './domain/reviewVerification.js'
import { excerpt as excerptOf } from './domain/dispatchReports.js'
import type { DispatchFinished } from './domain/dispatchReports.js'
import { maskAllows } from './domain/roles.js'
import { isAdrId } from './domain/adr.js'
import { evaluateWriteScope, isDevicePath, normalizeWorkspacePath } from './domain/writeScope.js'
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
/**
 * **值被打断类**解析失败的可操作诊断（DEF-046 落点一）。
 *
 * 为什么要有：`JSON.parse` 的报错**只说形状**（`Unexpected token …`），而本仓实测最常发生的失败
 * 是**值里出现未转义的 ASCII 引号**（引用标识符/命令/路径几乎必然用到）——这类输入常常
 * **形状看着没问题**，报错却让人不知道改哪里。
 *
 * **判别式（可机械复算，不靠猜）**：解析器几乎都给出 `position N`。
 * 在 N 附近看**同类引号的奇偶**：
 *   - **奇数**（引号没配对）⇒ 就是"值里多写了一个未转义的 ASCII 引号"（**值被打断**）⇒ 点名它；
 *   - **偶数**（引号配平）⇒ 引号不是元凶，是**形状**问题（裸换行 / 逗号 / 不是数组…）⇒ 归形状类。
 * 另外：值里出现**裸换行**时 Node 会报 `Bad control character`，直接归形状类。
 *
 * 返回 `undefined` = 不是"值被打断" ⇒ 按**形状类**报错（不是数组 / 逗号 / 裸换行）。
 */
function jsonQuoteDiagnosis(value: string, shape: string): { index: number; char: string } | undefined {
  if (/control character/i.test(shape)) return undefined
  const at = /position (\d+)/.exec(shape)
  const reported = at === null ? value.length - 1 : Number(at[1])
  // 只看报错位置附近一小段（再远就与这次失败无关了）
  const from = Math.max(0, reported - 4)
  const to = Math.min(value.length, reported + 1)
  const window = value.slice(from, to)
  for (const char of ['"', "'"]) {
    const hits: number[] = []
    for (let index = 0; index < window.length; index += 1) if (window[index] === char) hits.push(from + index)
    // 附近同类引号**奇数** ⇒ 少了个配对的（值里的引号把字符串提前结束了）
    if (hits.length % 2 === 1) return { index: hits[hits.length - 1] ?? reported, char }
  }
  return undefined
}

/**
 * 解析一条 JSON 文本参数；失败时给**可操作**报错（DEF-046 落点一：两处唯一实现面，覆盖 37 个调用点）。
 *
 * 两类失败分流：
 *   - **值被打断**（值里有未转义的 ASCII 引号）⇒ 点名**第 N 个字符**与该字符，建议改用中文引号；
 *   - **形状错误**（不是数组 / 逗号 / 裸换行…）⇒ 报宿主给的形状报错正文。
 * 两类都明说「本次调用没有写入任何东西」（避免操作静默未执行）。
 *
 * 导出是为了让守卫能直接钉这两类的**可区分性**；本模块在 m7 棘轮里余量为 0 ⇒ 文案一律走语言包。
 *
 * **DEF-065（TASK-107）**：入口从 `string | undefined` 放宽到 `unknown` —— 工具面已把
 * `suggestions` / `findings` 声明成 `string | array` 的**联合**（宿主 schema 的 `oneOf`），
 * 数组形态现在能到达这里；先经 `compositeArg` 归一（字符串原样 / 数组转 JSON 文本）再解析，
 * 以免"宿主改宽容了、插件反而把数组读成坏 JSON"。
 */
export function jsonOr<T>(value: unknown, label: string): { value?: T; error?: string } {
  const text = compositeArg(value)
  if (text === undefined || text.trim() === '') return {}
  try {
    return { value: JSON.parse(text) as T }
  } catch (error) {
    const shape = error instanceof Error ? error.message : String(error)
    const quote = jsonQuoteDiagnosis(text, shape)
    if (quote !== undefined) {
      return {
        error: fmt('uiIndex.kJsonParseFailedQuote', {
          p1: label,
          p2: String(quote.index + 1),
          p3: quote.char,
          p4: shape,
        }),
      }
    }
    return { error: fmt('uiIndex.kJsonParseFailed', { p1: label, p2: shape }) }
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
 * **"这一轮为什么一张都没派出去"的回执**（DEF-049 / TASK-078 落点二）。
 *
 * 病灶：以前这里只有一句笼统的"没有可派发的任务卡（都已认领/完成）"，于是**有 blocked 卡**的情形
 * 被读成"活干完了" —— 真机上驾驶舱为此白走两轮（`sdo_plan action=next` 连回两次，
 * 实际上有卡只是被 `block` 住了）。
 *
 * 三条纪律：
 *   · **blocked 与"写范围冲突 / 依赖未满足"分列**：两者的处置完全不同（前者要 `unblock` 或 `drop`，
 *     后者要么等依赖、要么腾范围），混成一句就等于没分辨能力；
 *   · **blocked 类必须点名"需要处置"并给出动作**（`unblock` / `drop`），因为 blocked 卡**不会**
 *     自己回到派发队列；
 *   · 真的一张卡都没有原因时，才回到那句"没有可派发的任务卡"（`kNonDispatchableIdle`，
 *     与旧 `k30` 同义但明确说"本轮"）。
 *
 * 分类由域层给（`office.nonDispatchable` → `plan.classifyNonDispatchable`），这里**只排版**：
 * 本文件与 `plan.ts` 在 m7 的 i18n 棘轮基线都是 **0**，一个中文字面量都不许加。
 */
function describeNonDispatchable(plan: NonDispatchablePlan): string {
  // **DEF-040**：门禁失效这一类**必须排除在"本轮没有可派发的任务卡"之外** —— 失效时
  // `readyForDispatch` 返回空，回落成那句闲话就等于把"被拦住"说成"活干完了"（本缺陷的成因）。
  // **DEF-007** 同理：独占窗口排队也是"被拦住"，不是"没活干"。
  if (
    plan.gateStale === undefined
    && plan.exclusive === undefined
    && plan.blocked.length === 0
    && plan.scope.length === 0
    && plan.dependencies.length === 0
  ) {
    return t('uiIndex.kNonDispatchableIdle')
  }
  const sections: string[] = []
  // 上游原因先报：门禁失效时下面几类未必为空，但"为什么一张都不派"的答案在这一条
  if (plan.gateStale !== undefined) {
    sections.push(fmt('uiIndex.kNonDispatchableGateStaleHead', {
      p1: plan.gateStale.gate,
      p2: plan.gateStale.reason,
      p3: String(plan.gateStale.tasks.length),
    }))
  }
  // **DEF-007**：同一独占窗口组被挡下的卡 —— 与其余各类并列单列一行
  if (plan.exclusive !== undefined) {
    sections.push(fmt('uiIndex.kNonDispatchableExclusiveHead', {
      p1: String(plan.exclusive.length),
      p2: plan.exclusive.map((row) => `${row.task.id}←${row.other}`).join('；'),
    }))
  }
  if (plan.blocked.length > 0) {
    sections.push(fmt('uiIndex.kNonDispatchableBlockedHead', {
      p1: String(plan.blocked.length),
      p2: plan.blocked
        .map((task) => fmt('uiIndex.kNonDispatchableBlockedItem', {
          p1: task.id,
          p2: (task.blockedReason ?? '').trim() === '' ? t('uiIndex.kTaskUnblockNoReason') : (task.blockedReason ?? ''),
        }))
        .join('；'),
    }))
  }
  if (plan.dependencies.length > 0) {
    sections.push(fmt('uiIndex.kNonDispatchableDependencyHead', {
      p1: String(plan.dependencies.length),
      p2: plan.dependencies
        .map((item) => fmt('uiIndex.kNonDispatchableDependencyItem', { p1: item.task.id, p2: item.waitingOn.join(' ') }))
        .join('；'),
    }))
  }
  if (plan.scope.length > 0) {
    sections.push(fmt('uiIndex.kNonDispatchableScopeHead', {
      p1: String(plan.scope.length),
      p2: plan.scope
        .map((item) => `${item.task.id} ↔ ${item.other}（${item.overlap.join('、')}）`)
        .join('；'),
    }))
  }
  return sections.join('\n')
}

/**
 * 判定基准四类的**人读名字**（与 `evidence.ts` 的 `ORACLE_KINDS` 一一对应，缺一不可）。
 *
 * 文案一律走语言包（`uiIndex.kOracleKind*`）：本模块在 m7 棘轮基线里的余量是 **0** ——
 * 在这里写一份中文兜底表就会立刻把棘轮顶红（而"给中文加白名单"正是那条守卫要防的事）。
 */
const ORACLE_KIND_KEYS: Record<string, string> = {
  acceptance: 'uiIndex.kOracleKindAcceptance',
  contract: 'uiIndex.kOracleKindContract',
  baseline: 'uiIndex.kOracleKindBaseline',
  expert: 'uiIndex.kOracleKindExpert',
}

/** 某一类的人读名字（词表外的取值原样返回：它本来就要被判红点名）。 */
function oracleKindLabel(kind: string): string {
  const key = ORACLE_KIND_KEYS[kind]
  return key === undefined ? kind : t(key)
}

/** 四类取值渲染成人读文本：`acceptance（需求验收标准） / contract（…）`（schema 说明与回执共用一份词表）。 */
function oracleKindsText(): string {
  return fmt('uiIndex.kOracleKindsList', {
    p1: oracleKindLabel('acceptance'),
    p2: oracleKindLabel('contract'),
    p3: oracleKindLabel('baseline'),
    p4: oracleKindLabel('expert'),
  })
}

/** 把一条判定基准渲染成人读短语（回执里说清"这条凭什么判定"）。 */
function describeOracle(oracle: OracleRef): string {
  const kind = textOf(oracle.kind).trim()
  const parts = [
    ...(textOf(oracle.ref).trim() === '' ? [] : [textOf(oracle.ref).trim()]),
    ...(textOf(oracle.criterion).trim() === '' ? [] : [textOf(oracle.criterion).trim()]),
    ...(textOf(oracle.baselineSha256).trim() === ''
      ? []
      : [fmt('uiIndex.kOracleSha12', { p1: textOf(oracle.baselineSha256).trim().slice(0, 12) })]),
    ...(textOf(oracle.expert).trim() === '' ? [] : [textOf(oracle.expert).trim()]),
  ]
  const head = fmt('uiIndex.kOracleKindText', { p1: kind, p2: oracleKindLabel(kind) })
  return parts.length === 0 ? head : fmt('uiIndex.kOracleScope', { p1: head, p2: parts.join(' · ') })
}

/**
 * 解析 `oracle` 这个**JSON 文本参数**（REQ-054 / TASK-054）。
 *
 * 为什么不在这里就地判"四类取值"：取值域与逐类核对**只有一处实现**（`evidence.ts` 的
 * `oracleGaps()`），本卡**不动判定语义**。这里只负责三件事，且都要**可读拒绝**（不许静默丢弃）：
 *   ① 不是合法 JSON ⇒ 点名参数名 + 宿主给的解析错误 + 明确"本次没有写入任何东西"；
 *   ② 解析出来不是对象（数组 / 字符串 / 数字）⇒ 判红（那不是一条判定基准）；
 *   ③ 形状合法 ⇒ 原样交给域层核对（`acceptance` 的 `ref` 允许缺省回落成覆盖需求，见 `stampOracleRequirement`）。
 *
 * 注意：**空串**按"没给"处理（复合参数的老口径，与 `jsonOr` 一致）——"给了个空串"不该被读成
 * "给了一条空判定基准"，否则回执会说"判定基准没有给类别"，而调用方其实什么都没说。
 */
function oracleArg(raw: string | undefined): { value?: OracleRef; error?: string } {
  if (raw === undefined || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { error: fmt('uiIndex.kOracleParseFailed', { p1: error instanceof Error ? error.message : String(error) }) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: fmt('uiIndex.kOracleNotObject', { p1: Array.isArray(parsed) ? 'array' : typeof parsed, p2: oracleKindsText() }) }
  }
  return { value: parsed as OracleRef }
}

/**
 * `acceptance` 类的 `ref` **缺省回落**（REQ-054 / TASK-054）。
 *
 * 卡上的口径：「AC 编号须属于**所指需求**」。调用方常常只在 `oracle` 里写 `criterion`，把"哪条需求"
 * 交给用例本身（`plan` 的 `requirement=`）——那就回落；**显式给了 `ref` 就不改**（以它为准，
 * 比对不符时 `oracleGaps()` 会判红并点名，正是 `AC-212 / AC-999` 那类可核对的话）。
 * 非 `acceptance` 类一律原样返回（兜底只服务验收标准类，不越界改别的类别）。
 */
function stampOracleRequirement(oracle: OracleRef | undefined, requirement: string | undefined, fallback: string | undefined): OracleRef | undefined {
  if (oracle === undefined) return undefined
  if (textOf(oracle.kind).trim() !== 'acceptance') return oracle
  if (textOf(oracle.ref).trim() !== '') return oracle
  const target = textOf(requirement).trim() !== '' ? requirement : fallback
  return textOf(target).trim() === '' ? oracle : { ...oracle, ref: textOf(target).trim() }
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

// —————————————————————— DEF-047 落点二：命令类写入形态的静态扫描 ——————————————————————
//
// **为什么需要**（缺陷背景）：写范围闸门（`evaluateWriteScope`）靠"目标路径"参数工作，而 `bash`
// 没有路径参数 ⇒ 它见到空 `paths` 就早退（`allow(false)`，如实标"判不了"）。于是
// `echo x > 任意路径`、`tee`、`sed -i`、`cp`/`mv`/`rm` 可以写**任何**文件（含 `.sdo/` 真源与
// 别人卡的产物）—— 写范围从**机制**退化为**自觉**（真机实测：本批发生过多起跨卡改同文件，
// 以及驾驶舱自己用 bash 落盘）。
//
// **做法**：对命令串做**静态**扫描，把命中的写入目标当作"本次要写的路径"，交给**同一条**闸门
// （`evaluateWriteScope`，判定语义一处不改）判。目标路径来自命令串，因此必须先按**会话工作目录**
// 归一（`normalizeWorkspacePath`），否则绝对路径比不过相对的卡写范围。
//
// **⚠️ 非穷举，而且不许假装全封**（"假安全比无安全更危险"——用户口径）。静态扫描只能覆盖**已知**
// 写入形态；下面 `COMMAND_WRITE_RISKS` 列的剩余风险是**如实披露**，不是待办清单。
// 真正的兜底仍是 `done` 关的写范围对账（`workspace/changes`）与人类复核。
//
// **清单为什么用英文/ASCII 写**：`src/index.ts` 在 m7 的 i18n 棘轮基线里余量是 **0**
// （`test/m7.test.ts` 的 `'src/index.ts': 0`）——这些是**给审计者与 reviewer 看的边界声明**，
// 不是本插件产出的用户可见文案。要中文版请走语言包键（属另一张卡：本卡写范围不含 `src/data/lang/`，
// 实测想改 `zh-CN.yml` 会被钩子以「越界写」直接拒绝）。
const COMMAND_WRITE_RISKS: readonly string[] = [
  'paths built by command substitution / variable expansion: $(...), ${VAR}, eval, xargs',
  'nested shells: sh -c, bash -c, env ... bash, curl | sh',
  // **TASK-090 假阳性修复的代价（如实披露）**：把"引号内 / heredoc 体内"的字面量排除出判定，
  // 就必然把"真命令写在引号里"的写法一起放过 —— 它们不是漏扫，是**有意的**：那两处是数据，
  // 当成命令就会把纯读命令（grep 探针文本）与"写用例文件"误拒。
  'command text INSIDE quotes is not scanned: bash -c "...", eval "...", sh -c \'...\', ssh host "..."',
  'heredoc bodies are not scanned: a script written via heredoc (cat > s.sh <<EOF ... EOF) is only judged at the redirect; what it does when RUN is not re-scanned',
  'arithmetic `<<` (shift) looks like a heredoc start to this scanner and may hide following lines from judgment',
  // 后半那张卡的范围（**本卡不做**，但必须如实列在风险里，不能因为"待办"就假装已封）
  'command wrappers / prefixes are not recognised: env X=1 cmd, sudo cmd, nice cmd, time cmd, xargs cmd, nohup cmd',
  'git subcommands that write into a worktree are not recognised: git worktree add/remove, git -C <dir> checkout/restore',
  'device paths under /dev are deliberately NOT judged (they are not workspace files); the same applies to every other path outside the workspace that no listed form produces',
  'interpreter write forms not listed here: perl -i, ruby -e, awk redirection, install, truncate of a symlink',
  'write a script first, then run it (the script write itself is judged; writes inside it are not re-scanned)',
  'any write performed through a tool API rather than a shell form',
]

/**
 * 这条闸门的**剩余风险**（如实披露用；报告与回执都引用它，避免两处各写一份）。
 *
 * 为什么要有这个导出：DoD 明确要求"拦不住的一律如实列出"（宁要诚实的部分覆盖，不要假装全封）。
 * 它同时是给 reviewer 与后续卡看的**边界声明**：静态扫描不构成沙箱。
 */
export function commandWriteRisks(): readonly string[] {
  return COMMAND_WRITE_RISKS
}

/** 从工具参数里取命令串（宿主 `bash` 工具的字段是 `command`；`cmd` 作兼容）。 */
function commandTextOf(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const holder = args as { command?: unknown; cmd?: unknown }
  if (typeof holder.command === 'string') return holder.command
  return typeof holder.cmd === 'string' ? holder.cmd : ''
}

/**
 * **引号感知的 shell 词法切分**（TASK-090 假阳性修复②③；**不是**完整解释器）。
 *
 * 为什么必须做（实现会话一手现场，两次都是**误拒**）：
 *   · 旧实现按 `\s+` 切词、再逐个剥首尾引号 ⇒ `sed -i 's/a b/c d/' f.ts` 被切成
 *     `b/c`、`d/` 两个**幽灵目标**，于是"改写范围内的文件"这条命令被判成越界；
 *   · 引号里的 `>` 也被当成重定向 ⇒ `grep -n 'echo x > f.ts' t.ts` 这种**纯读**命令被拒
 *     （实测把"给这条守卫写用例"这件事本身挡在闸门外）。
 *
 * 切分规则（只求够本闸门用，且**方向保守**：分不出来就当一个词，绝不当成两个目标）：
 *   · 引号内的空白**不切词**（`'a b'` 是一个词），引号本身剥掉；`"…"` 里认 `\` 转义；
 *   · 重定向算符**只在引号外**成立，单独成一个 `op` 词法单元；fd 前缀（`2>`）只在本词
 *     恰好是数字或 `&` 时并入算符（`echo 2>/dev/null` 是重定向，`echo 2 >f` 不是）；
 *   · `;` `|` `||` `&&` `&` `(` `)` 与换行单独成 `op`（分段用）。
 *
 * 记录 `start`/`end` 偏移，是为了让调用方还能取回**原始片段文本**（解释器内联写文件那一支的
 * 目标本来就在引号里，是函数调用而不是裸字面量，必须按原文匹配）。
 */
interface ShellToken {
  kind: 'word' | 'op'
  /** 词法单元的去引号文本（`op` 是算符原文） */
  text: string
  /** 是否**含有**引号段（引号内的字面量不参与重定向判定） */
  quoted: boolean
  /** 在被扫描文本里的原始偏移（取回片段用） */
  start: number
  end: number
}

/** 分段算符（不是写入形态，只用来切命令段）。 */
const SHELL_SEPARATORS: readonly string[] = [';', '|', '||', '&&', '&', '(', ')']

/** 写入形态的重定向算符（`>` `>>` `&>` `&>>`，可带 `2` 这类 fd 前缀；`>&`/`<<`/`<>` 不是）。 */
const WRITE_REDIRECT = /^(?:\d{0,2})?(?:>>?|&>>?)$/u

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let word = ''
  let quoted = false
  let started = false
  let wordStart = 0
  let wordEnd = 0
  let index = 0
  const flush = (): void => {
    if (!started) return
    tokens.push({ kind: 'word', text: word, quoted, start: wordStart, end: wordEnd })
    word = ''
    quoted = false
    started = false
  }
  const begin = (): void => {
    if (!started) {
      started = true
      wordStart = index
    }
  }
  const pushOp = (text: string, from: number, to: number): void => {
    flush()
    tokens.push({ kind: 'op', text, quoted: false, start: from, end: to })
  }
  while (index < command.length) {
    const ch = command[index] as string
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush()
      index += 1
      continue
    }
    if (ch === '\n') {
      pushOp(';', index, index + 1)
      index += 1
      continue
    }
    if (ch === '\\') {
      const next = command[index + 1]
      if (next === undefined || next === '\n') {
        index += 1
        continue
      }
      begin()
      word += next
      index += 2
      wordEnd = index
      continue
    }
    if (ch === "'" || ch === '"') {
      begin()
      index += 1
      while (index < command.length && command[index] !== ch) {
        const inner = command[index] as string
        if (ch === '"' && inner === '\\' && index + 1 < command.length) {
          word += command[index + 1] as string
          index += 2
          continue
        }
        word += inner
        index += 1
      }
      // 收尾引号（缺失时也前进一格，避免在未闭合引号上死循环）
      index += 1
      quoted = true
      wordEnd = index
      continue
    }
    if (ch === '&' && command[index + 1] === '>') {
      const from = index
      index += 2
      let text = '&>'
      if (command[index] === '>') {
        text = '&>>'
        index += 1
      }
      pushOp(text, from, index)
      continue
    }
    if ((ch === '|' && command[index + 1] === '|') || (ch === '&' && command[index + 1] === '&')) {
      const from = index
      index += 2
      pushOp(`${ch}${ch}`, from, index)
      continue
    }
    if (ch === '>' || ch === '<') {
      const prefix = started && /^(?:\d{1,2}|&)$/u.test(word) ? word : ''
      const opStart = prefix === '' ? index : wordStart
      if (prefix !== '') {
        started = false
        word = ''
        quoted = false
      }
      index += 1
      let op: string = ch
      if (ch === '>' && command[index] === '>') {
        op = '>>'
        index += 1
      } else if (ch === '>' && command[index] === '&') {
        op = '>&'
        index += 1
      } else if (ch === '<' && command[index] === '<') {
        op = '<<'
        index += 1
        if (command[index] === '-') {
          op = '<<-'
          index += 1
        }
      } else if (ch === '<' && command[index] === '&') {
        op = '<&'
        index += 1
      } else if (ch === '<' && command[index] === '>') {
        op = '<>'
        index += 1
      }
      pushOp(`${prefix}${op}`, opStart, index)
      continue
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      pushOp(ch, index, index + 1)
      index += 1
      continue
    }
    begin()
    word += ch
    index += 1
    wordEnd = index
  }
  flush()
  return tokens
}

/** 按 `op` 分隔符切段（重定向 `op` 留在段内，不切）。 */
function shellSegments(tokens: readonly ShellToken[]): ShellToken[][] {
  const segments: ShellToken[][] = []
  let current: ShellToken[] = []
  for (const token of tokens) {
    if (token.kind === 'op' && SHELL_SEPARATORS.includes(token.text)) {
      if (current.length > 0) segments.push(current)
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/**
 * 摘掉 **heredoc 体**（TASK-090 假阳性修复③）。
 *
 * 为什么：heredoc 体是**喂给命令的数据**，不是命令本身 —— `cat > x.ts <<'EOF' … EOF` 里
 * 出现 `echo y > z.ts` 只是文件内容（实测：给这条守卫写用例时，用例正文里的探针字面量
 * 被当成真实写入，整条 `cat > …` 被拒）。起始行的重定向仍在（它才是真正的写入）。
 *
 * 边界（如实披露）：本函数只认 `<<[-]定界符`（可带引号）这一种写法；算术左移 `(( x << y ))`
 * 会被误当 heredoc 起始而吃掉后续行 —— 宁可少判（保守方向），已在剩余风险里列出。
 */
function stripHeredocBodies(command: string): string {
  const kept: string[] = []
  let pending: { delim: string; dash: boolean }[] = []
  for (const line of command.split('\n')) {
    if (pending.length > 0) {
      const head = pending[0] as { delim: string; dash: boolean }
      const candidate = head.dash ? line.replace(/^\t+/u, '') : line
      if (candidate.trim() === head.delim) pending.shift()
      continue
    }
    kept.push(line)
    for (const match of line.matchAll(/<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/gu)) {
      pending.push({ delim: match[3] ?? '', dash: match[1] === '-' })
    }
  }
  return kept.join('\n')
}

/** 取一段里"非选项"的词（跳过以 `-` 开头的 flag；引号已由词法器剥掉）。 */
function shellWords(segment: readonly ShellToken[]): string[] {
  return segment.filter((token) => token.kind === 'word').map((token) => token.text).filter((word) => word !== '')
}

/** 命令串里的目标路径是否是指向别处的变量/替换（`$VAR` / `$(...)`）—— 静态判不了，如实跳过。 */
function isOpaqueTarget(word: string): boolean {
  return word.includes('$') || word.startsWith('`')
}

/**
 * 扫描命令串里的**已知写入形态**，返回写入目标与命中的形态名。
 *
 * 形态表（DoD 要求"至少覆盖"的这些，逐条都有对应用例）：
 *   · 重定向 `>` / `>>` / `&>`（含 `2>`、`&>` 这类带 fd 前缀的写法）—— **只在引号外成立**
 *   · `tee`（含 `-a`）
 *   · `sed -i`（就地编辑）
 *   · `cp` / `mv` / `rm` / `truncate` / `touch` / `dd of=`
 *   · `python -c` / `python3 -c` 里的 `open(..., 'w'/'a')`、`node -e` 里的 `writeFileSync(...)`
 *
 * 不参与判定的三类（都是**误拒**的来源，TASK-090 修复）：`/dev` 下的设备节点、
 * 引号内的字面量、heredoc 体内的一切。
 *
 * 返回的 `shapes` 只含**触发拦截的**形态名（供回执点名"是哪种写法被拦"），不含路径。
 */
export function detectCommandWrites(command: string): { targets: string[]; shapes: string[] } {
  const targets: string[] = []
  const shapes: string[] = []
  if (command.trim() === '') return { targets, shapes }
  const push = (target: string, shape: string): void => {
    if (target === '' || isOpaqueTarget(target)) return
    // **假阳性修复①**：设备节点不是工作区文件（`/dev/null` 归一后会长成不存在的相对路径 `dev/null`）。
    if (isDevicePath(target)) return
    if (!targets.includes(target)) targets.push(target)
    if (!shapes.includes(shape)) shapes.push(shape)
  }

  const source = stripHeredocBodies(command)
  for (const segment of shellSegments(tokenizeShell(source))) {
    const words = shellWords(segment)
    const head = words[0] ?? ''
    const rest = words.slice(1)

    // ① 重定向（`>` / `>>` / `&>`，含 `2>` 这类 fd 前缀）：算符**只在引号外**成立 ——
    //    引号里的 `>` 是字面量（`grep -n 'echo x > f' t` 是纯读命令），不参与判定。
    for (let index = 0; index < segment.length; index += 1) {
      const token = segment[index] as ShellToken
      if (token.kind !== 'op' || !WRITE_REDIRECT.test(token.text)) continue
      const next = segment[index + 1]
      if (next !== undefined && next.kind === 'word') push(next.text, token.text)
    }
    // ② tee（`tee -a file` / `tee file1 file2`）
    if (head === 'tee') for (const word of rest.filter((item) => !item.startsWith('-'))) push(word, 'tee')
    // ③ sed -i（就地编辑：`sed -i 's/a/b/' file`）—— 第一个非选项操作数是**脚本**，不是文件
    if (head === 'sed' && rest.some((item) => item === '-i' || item.startsWith('-i'))) {
      const operands = rest.filter((item) => !item.startsWith('-'))
      for (const word of operands.slice(1)) push(word, 'sed -i')
    }
    // ④ cp / mv（多个源 + 最后一个目标）/ rm / truncate / touch
    if (head === 'cp' || head === 'mv') {
      const operands = rest.filter((item) => !item.startsWith('-'))
      const last = operands[operands.length - 1]
      if (last !== undefined && operands.length >= 2) push(last, head)
    }
    if (head === 'rm' || head === 'truncate' || head === 'touch' || head === 'install' || head === 'dd') {
      for (const word of rest.filter((item) => !item.startsWith('-'))) push(word, head === 'dd' ? 'dd' : head)
    }
    // ⑤ 解释器内联写文件（`python -c "open('x','w')"`、`node -e "fs.writeFileSync(...)"`）：
    //    这一支的目标**本来就在引号里**（是函数调用，不是裸字面量），故按**原始片段文本**匹配。
    if ((head === 'python' || head === 'python3' || head === 'node' || head === 'nodejs') && rest.includes('-c')) {
      const first = segment[0] as ShellToken
      const last = segment[segment.length - 1] as ShellToken
      const raw = source.slice(first.start, last.end)
      for (const match of raw.matchAll(/open\(\s*[^)]*?['"]([^'"]+)['"][^)]*?['"][wa]/gu)) push(match[1] ?? '', `${head} -c open(w)`)
      for (const match of raw.matchAll(/writeFileSync\(\s*['"]([^'"]+)['"]/gu)) push(match[1] ?? '', `${head} -e fs.write`)
    }
  }
  return { targets, shapes }
}

/** 回执里那句"剩余风险"（如实列出拦不住的形态；`shapes` 为空时不显示）。 */
function describeCommandWriteRisks(shapes: readonly string[]): string {
  return shapes.length === 0 ? '' : shapes.join('/')
}

export function apply(ctx: Context, config: SdoConfig): void {
  // **客户端半的投递锚点**（`clientHalfOnly: true`）：这一行只用于把本包带进浏览器的模块图，
  // 由 bundle patch 里那条 **profile 顶层行**（裸包名）设置。这里必须**立刻返回、什么都不注册** ——
  // 否则"未选 preset 的会话完全不加载 SDO"（E2E-09 / AC-007）就被这一行破坏了。
  // 为什么锚点行不能写成 `disabled: true` 或子路径名：宿主 `client-modules` 组图时会
  // **跳过 disabled 行与没有 fiber 的行**，且只认**裸包名**（子路径在 `locatePkgJson` 里直接判不可解析）。
  if (config.clientHalfOnly === true) return
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
      // **DEF-070**：`sdo_status` 的第一行必须是**本会话实际加载的那份构建**（端到端验证最容易验到旧构建）
      const buildLine = buildReadout(call.cwd ?? '')
      // **③b（本轮核实）**：旧实现把 `office.rebuild()` 的返回值**丢掉**了 —— 用户显式 `--rebuild` 之后，
      // 回执既不说明"已强制重建"，也不说明"真源被截断、本次只折叠到最后一致前缀（可能回退阶段）"，
      // 而 `status.rebuilt` 在这一次读取里必然是 false（投影刚被写过），于是回执看起来"什么都没发生"。
      const forced = args.rebuild === true ? office.rebuild(call) : undefined
      // **DEF-030**：状态面同样要能一次列全豁免（否则"豁免可以静默发生"）
      const exemptionReadout = describeExemptions(exemptionLines(office.constructionProfile(call).profile))
      const text = describeStatus(office.status(call), settings.projectDirName, office.shapeNotes(call))
        + exemptionReadout
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
      // **DEF-070**：普通状态回执也要报构建读数（这条才是 `sdo_status` 的常走路径）
      if (forced === undefined) return buildLine + '\n' + text + pendingBlock + poolBlock + faceMismatchBlock + faceBlock + finishedBlock + deadBlock
      const note = forced.truncated
        ? fmt('uiIndex.kRebuildTruncated', { p1: String(forced.badLine ?? '?') })
        : t('uiIndex.kRebuildForced')
      // **DEF-070**：构建读数放在最前面（第一眼就该知道这份回执出自哪份构建）
      return buildLine + '\n' + `${note}\n${text}` + pendingBlock + poolBlock + faceMismatchBlock + faceBlock + finishedBlock + deadBlock
    },

    async board(
      call: OfficeCall,
      args: { expand?: boolean | undefined; all?: boolean | undefined; write?: boolean | undefined },
    ): Promise<string> {
      const status = office.status(call)
      // **§4.1/§4.2（评审员）**：看板装配抽到 `boardModelFor`（可测、读不动也能出图、truthError 进正文）
      const { model } = boardModelFor(office, status, call, settings.projectDirName)
      // **DEF-030**：豁免清单是看板的状态面之一（唯一产出口在 `exemptionLines`）
      const text = renderBoard(
        { ...model, exemptions: exemptionLines(office.constructionProfile(call).profile) },
        { expand: args.expand === true, all: args.all === true },
      )
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
        const exempt = jsonOr<{ task?: unknown; check?: unknown; why?: unknown; approvedBy?: unknown; impact?: unknown }[]>(args.exempt, 'exempt')
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
            // **DEF-030**：多出来的键过去在这里被**静默丢弃**（写了等于没写）——两处一起映射。
            approvedBy: typeof item.approvedBy === 'string' ? item.approvedBy : '',
            impact: typeof item.impact === 'string' ? item.impact : '',
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
        }) + describeExemptions(exemptionLines(outcome.profile))
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
                    // **DEF-050 / TASK-072**：结构/模型通道建卡时也能带上 `fixes`（同 G-03 的教训：
                    // 白名单会**静默丢弃**未列出的字段，`fixes` 还没落盘就被吃掉）。
                    // 语义校验不在这一层：`createTask` 不查台账，落盘后由 `updateTask` /
                    // 判据 C-63 各自按同一套口径处理（不存在的 id 一定判红并点名）。
                    ...(list(row.fixes) === undefined ? {} : { fixes: list(row.fixes) as string[] }),
                    // **DEF-051 / TASK-080**：同一条教训（G-03）的第三次应用 —— 结构/模型通道建卡时
                    // `mitigates` / `mitigatesWaiver` 也必须能落盘，否则卡面上写了、值在进库前就被吃掉。
                    ...(list(row.mitigates) === undefined ? {} : { mitigates: list(row.mitigates) as string[] }),
                    ...(mitigatesWaiverOf(row.mitigatesWaiver).length === 0
                      ? {}
                      : { mitigatesWaiver: mitigatesWaiverOf(row.mitigatesWaiver) }),
                    ...(list(row.blockedBy) === undefined ? {} : { blockedBy: list(row.blockedBy) as string[] }),
                    ...(list(row.writeScopes) === undefined ? {} : { writeScopes: list(row.writeScopes) as string[] }),
                    ...(list(row.evidenceRequired) === undefined ? {} : { evidenceRequired: list(row.evidenceRequired) as never }),
                    // **DEF-027**：声明的变异条数同理不得在进库前被白名单吃掉（G-03 教训的第四次应用）
                    ...(typeof row.mutationExpected === 'number' && Number.isInteger(row.mutationExpected) && row.mutationExpected >= 0
                      ? { mutationExpected: row.mutationExpected } : {}),
                    // **DEF-036**：影响面声明同理不得在进库前被白名单吃掉 —— 模型通道给的
                    // `impact` / `undecidable` 必须在建卡时落进卡面，否则判据永远看不到它（静默丢弃）
                    ...(list(row.impact) === undefined ? {} : { impact: list(row.impact) as string[] }),
                    ...(typeof row.undecidable === 'string' && row.undecidable.trim() !== '' ? { undecidable: row.undecidable } : {}),
                    // **DEF-055**：模型通道声明「本卡产出用户可见文案」同理不得在进库前被吃掉
                    ...(row.uiText === true ? { uiText: true } : {}),
                    // **DEF-018**：模型通道声明的落点同理不得在进库前被吃掉
                    ...(list(row.landing) === undefined ? {} : { landing: list(row.landing) as string[] }),
                    // **DEF-007**：独占窗口组名同理不得在进库前被吃掉
                    ...(typeof row.exclusive === 'string' && row.exclusive.trim() !== '' ? { exclusive: row.exclusive.trim() } : {}),
                    ...(row.size === 'small' || row.size === 'medium' || row.size === 'large' ? { size: row.size } : {}),
                  }
                }),
              }),
          ...(office.iteration(call) === undefined ? {} : { iteration: office.iteration(call)?.number }),
        })
        // **TASK-074 落点三**：结构通道的**逐条明细**（卡标题 + 写范围 + 判定依据、以及没建卡的原因）
        // 挂在计划正文里 —— 旧回执只印一个数量，驾驶舱不翻看板就发现不了写范围荒谬的卡（DEF-052）
        const planSummary = describePlan(result.tasks, result.issues, office.shapeNotes(call), result.structural)
        // **D-12**：结构通道的粒度/范围提示（不改粒度 —— 那是方法学选择，但必须说出来）。
        // **TASK-104（DEF-063）**：只按**真的落盘**的结构卡算（`result.structural.created`）——
        // 依据为空的元素在新口径下**一张都不落盘**，此时不能再印「本批有 N 张卡来自结构通道」
        // （那句话本身就成了误报）。旧实现数的是 `structuralCount`（"该建几张"），与本条无关。
        const structuralLanded = result.structural?.created.length ?? 0
        const structuralNote = structuralLanded === 0
          ? ''
          : `\n${fmt('uiIndex.kStructuralGranularity', { p1: String(structuralLanded) })}`
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
      // **TASK-074 落点三**：`next` 的回执也要**逐条列出**这批结构卡（标题 + 写范围 + 判定依据）——
      // `next` 自己不拆卡，所以从**同一份判定**（`structuralPlanOf`）现算，而不是各处再写一套口径。
      // 它同时是"没派出去"时的解释面：真机上被结构卡堵住时，先看得到"这批卡是什么、写范围多大"。
      const structuralBlock = describeStructuralPlan(office.structuralPlan(call))
      const structuralSection = structuralBlock === '' ? '' : '\n' + structuralBlock
      // **DEF-067 落点一**：写范围被在飞卡挡住的卡**不派**，但必须在回执里**单列一行**点名
      // （卡 id、挡路的卡与其 owner、**重叠的那个路径**）—— 否则复现 DEF-058 的误判：
      // 首屏看不到派发行就以为"没派"。（判定与两条派发路径共用 `scopeHeldTasks`，不另写一套。）
      const heldRows = plan.heldByScope ?? []
      const heldByScopeSection = heldRows.length === 0 ? '' : '\n' + heldRows.map((row) => fmt('uiIndex.kDispatchHeldByScopeLine', {
        p1: row.taskId,
        p2: row.holderId,
        p3: row.holderOwner === '' ? t('uiCollab.unblockNoOwner') : row.holderOwner,
        p4: row.overlap.join(t('uiCollab.kListSep')),
      })).join('\n') + '\n'
      // **DEF-053**：孤儿锁（卡在 in-progress 但拥有它的子会话已结算）与"派发未认领"必须**主动**提示
      //（不再靠撞锁才暴露）；每条都给可执行命令。这里是**只读判定**，落事件在真正派发那条路径上做。
      const health = office.dispatchHealth(call)
      const healthLines = [
        ...health.orphans.map((row) => fmt('uiIndex.kOrphanLockLine', {
          p1: row.taskId,
          p2: row.reason === '' ? t('uiIndex.kOrphanReasonUnknown') : row.reason,
          p3: row.owner === '' ? t('uiCollab.unblockNoOwner') : row.owner,
          p4: row.command,
        })),
        ...health.claimMissing.map((row) => fmt('uiIndex.kClaimMissingLine', {
          p1: row.taskId,
          p2: row.childSessionId === '' ? t('uiCollab.unblockNoOwner') : row.childSessionId,
          p3: String(row.minutes),
          p4: row.ended ? (row.reason === '' ? t('uiIndex.kOrphanReasonUnknown') : row.reason) : t('uiIndex.kClaimMissingRunning'),
        })),
        // **DEF-014**：复用投递（`reused=true`）后**未见消费**的那一批 —— `claimMissing` 只对 planned/ready
        // 成立，复用到**在飞**卡这条路它盖不到。这一行同时回显**宿主回执**与**可复算锚点**（序号），
        // 于是"指令投出去没有 / 有没有被消费"第一次在回执里可答（只报观测，不说"没消费"）。
        ...office
          .reuseDeliveries(call)
          .filter((row) => row.state === 'no-signal')
          .map((row) => fmt('uiIndex.kReuseDeliveryNoSignal', {
            p1: row.taskId,
            p2: row.childSessionId === '' ? t('uiCollab.unblockNoOwner') : row.childSessionId,
            p3: String(row.minutes),
            p4: row.messageReceipt === '' ? t('uiIndex.kReuseReceiptMissing') : row.messageReceipt,
            p5: String(row.startedSeq),
          })),
      ]
      const healthSection = healthLines.length === 0 ? '' : '\n' + healthLines.join('\n') + '\n'
      // **DEF-059**：认领被拒的次数要**看得见**（真机 TASK-106 被拒两次却无人知晓）。
      // 只报**当前就绪/计划中**那些卡 —— 历史卡被拒过几次，用 `task/claim-rejected` 事件随时可数。
      const claimRowIds = new Set(office.tasks(call).filter((task) => task.status === 'ready' || task.status === 'planned').map((task) => task.id))
      const rejectedRows = office.claimRejections(call).rows.filter((row) => claimRowIds.has(row.taskId))
      const rejectedSection = rejectedRows.length === 0 ? '' : '\n' + rejectedRows.slice(0, 5).map((row) => fmt('uiIndex.kClaimRejectedNote', {
        p1: row.taskId,
        p2: String(row.count),
        p3: row.code,
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
          if (args.why === true) return verdict + '\n' + diagnostics + heldByScopeSection + healthSection + rejectedSection + structuralSection
          return verdict + '\n' + diagnostics + '\n' + describePlan(office.tasks(call), [], office.shapeNotes(call)) + structuralSection
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
          return infeasibleBlock + heldByScopeSection + healthSection + rejectedSection + describeNonDispatchable(office.nonDispatchable(call)) + structuralSection
        }
        // **DEF-049 / TASK-078 落点二**：走队列分支时也把分类带上 —— "排队"是"池满"，
        // 与"卡是 blocked / 依赖未满足"是**不同**的原因，不能只报前者（否则读者仍分不清
        // "这一轮为什么没派到那张卡"）。真机症状：ready 卡被 blocked 卡占着范围，回执却只说容量。
        const nonDispatchableNote = describeNonDispatchable(office.nonDispatchable(call))
        // 排队不是"没卡"，而是**被上限挡住**：必须说清是哪个池满，否则用户会以为流程卡住了
        const blocked = plan.blocked.map((item) => fmt('uiIndex.kPoolBlockedLine', { p1: item.task.id, p2: item.task.role, p3: item.detail })).join('\n')
        return heldByScopeSection + healthSection + rejectedSection + fmt('uiIndex.k31', { p1: plan.queued.length, p2: settings.maxParallelDispatch })
          + '\n' + blocked
          + '\n' + describePoolBlock(plan.pools, plan.queued.map((task) => task.id), reuse.supported, settings.dispatchOrphanTtlMinutes)
          + '\n' + nonDispatchableNote
          + structuralSection
      }

      // **DEF-049 / TASK-078 落点二（`why=true`）**：`why` 是**为什么这一轮派不出去**的诊断面，
      // 因此它**不派发**任何卡（以前它只在"一张都没派出去"时才生效，于是"有 ready 卡 ⇒ 照派"
      // 把 blocked 卡的原因整个吞掉 —— 真机上驾驶舱连问两轮都没看见"有卡被 block 住了"）。
      if (args.why === true) {
        const nonDispatchable = office.nonDispatchable(call)
        const take = Math.max(1, Math.min(args.limit ?? 1, plan.dispatch.length))
        const held = plan.queued.map((task) => task.id)
        const lines = [
          fmt('uiIndex.kWhyNoDispatch', { p1: String(plan.dispatch.length), p2: String(plan.queued.length) }),
          describeNonDispatchable(nonDispatchable),
        ]
        if (held.length > 0) lines.push(fmt('uiIndex.kWhyQueued', { p1: String(held.length), p2: held.join(' ') }))
        if (plan.dispatch.length > take) {
          lines.push(fmt('uiIndex.kWhyHeldByLimit', {
            p1: String(plan.dispatch.length - take),
            p2: plan.dispatch.slice(take).map((entry) => entry.task.id).join(' '),
          }))
        }
        return infeasibleBlock + heldByScopeSection + healthSection + rejectedSection + lines.filter((line) => line !== '').join('\n') + structuralSection
      }

      const preference = args.backend === 'subagent' || args.backend === 'native-team' || args.backend === 'inline' ? args.backend : 'auto'
      const iteration = office.iteration(call)
      const decision = pickBackend(preference, backendProbe(), lastBackend, iteration?.number)
      const take = Math.max(1, Math.min(args.limit ?? 1, plan.dispatch.length))
      const picked = plan.dispatch.slice(0, take)
      // **DEF-041**：回执必须**自述复用判定** —— 池内计数与"每个未复用候选的原因"都要看得见，
      // 否则默认路径（每次新起）与池化口径长期背离而无人察觉（真机连续 22 次不复用）。
      const idleSameParentTotal = plan.pools.reduce((sum, pool) => sum + pool.idleSameParent.length, 0)
      // **DEF-015**：名单体检的结果（与卡无关，循环里只算一次；探针盲态时**不得**回报）
      let denyPhantoms: string[] = []
      const reuseSkipSummary = plan.reuseSkipped.length === 0
        ? t('uiDescribe.kFreshNoSkip')
        : plan.reuseSkipped.map((row) => `${row.childSessionId.slice(0, 8)}（${row.reason}）`).join('；')
      // **R-5C（sdo-test-new 2026-10-08）**：被 `limit` 截掉的卡**既不在"已派发"也不在"排队"**里
      // （它们已通过容量准入，只是这一轮没派）⇒ 回执里凭空消失。如实点名，并说明下次还会再挑。
      const held = plan.dispatch.slice(take)
      const out: string[] = []
      for (const [index, entry] of picked.entries()) {
        const task = entry.task
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
        // **DEF-015**：名单体检必须在**任何后端**下都算 —— inline 降级路径会 `continue`，
        // 若只在 subagent 路径算，"这次派发是降级的"就同时也把名单漂移藏掉了（两件事无关）。
        // 盲态判定用**机械底线**：探针连 `read`（人人可用的基础面）都不认得 ⇒ 不回报（那是探针的错觉）。
        if (denyPhantoms.length === 0) {
          const auditProbe = toolsProbe(call.agent)
          if (auditProbe('read')) denyPhantoms = curatedDenyPhantoms(auditProbe)
        }


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
            // **DEF-066**：记下**派的那个父会话** —— 宿主只允许父会话复用自己起的子会话，
            // 不记它，池读数就分不清"本会话真能投"与"跨父会话会被拒"（真机 31 vs 永远 spawn）。
            ...(call.sessionId === undefined ? {} : { parentSessionId: call.sessionId }),
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
            // **DEF-014**：复用投递的宿主回执进真源（旧实现把 `sendMessage` 的返回值丢了）
            ...(outcome.messageReceipt === undefined ? {} : { messageReceipt: outcome.messageReceipt }),
          })
          // 复用/降级**如实写出来**：静默复用与静默降级都会让"池"变成看不见的行为
          const childRows = office.dispatchedChildren(call).filter((child) => child.childSessionId === outcome.childSessionId)
          const rounds = childRows.length
          // **DEF-069**：轮数**与**卡数都要印 —— 真机把同一会话用到 34 轮 / 20 张卡，只看轮数看不出"任务面被榨干"
          const cardsTaken = new Set(childRows.map((row) => row.taskId)).size
          const stuck = office.unresolvedBlock(call, task.id)
          const notes = [
            stuck === undefined ? '' : fmt('uiDescribe.kDispatchRepeatBlocked', { p1: task.id, p2: stuck.reason.slice(0, 200) }),
            outcome.reused
              ? fmt('uiDescribe.kReusedChild', {
                  p1: task.id,
                  p2: outcome.childSessionId.slice(0, 8),
                  p3: task.role,
                  p4: String(rounds),
                  p5: String(cardsTaken),
                })
              : fmt('uiDescribe.kDispatchFreshSelf', {
                  p1: task.id,
                  p2: outcome.childSessionId.slice(0, 8),
                  p3: String(idleSameParentTotal),
                  p4: reuseSkipSummary,
                }),
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
      // **DEF-041**：`freshChild=true` 且池里有**本会话可复用**的空闲会话 ⇒ **劝阻**（只提示，不改决策）
      if (freshChild && idleSameParentTotal > 0) {
        out.push(fmt('uiDescribe.kFreshChildDissuade', { p1: String(idleSameParentTotal) }))
      }
      // **DEF-070**：派发回执也要报**本会话加载的那份构建**（真机验到旧构建却不自知）
      const buildNote = '\n' + buildReadout(call.cwd ?? '') + '\n'
      const denyDriftNote = denyPhantoms.length === 0
        ? ''
        : '\n' + fmt('uiIndex.kDenyListDrift', { p1: denyPhantoms.join(' '), p2: String(denyPhantoms.length) }) + '\n'
      // **DEF-058**：批量派发回执会被逐卡详情撑爆（真机 `limit=3` 时首屏只有一张卡，差点误报「只派出 1 张」）
      // ⇒ **首屏先给摘要**：本次派发的**全部卡号 + 计数**（摘要与计数两者齐备），详情在后。
      const dispatchSummary = fmt('uiIndex.kDispatchSummary', {
        p1: String(picked.length),
        p2: picked.map((entry) => entry.task.id).join(' '),
        p3: held.length === 0 ? '' : fmt('uiIndex.kDispatchSummaryHeld', { p1: String(held.length) }),
      })
      const tail = plan.queued.length === 0 ? '' : fmt('uiIndex.k32', { p1: plan.queued.length })
      // 池视图（在飞/空闲可复用/已退役）+ 还在排队的卡：一次派发之后"池子长什么样"要能看见
      const freshNote = freshChild ? '\n' + t('uiIndex.kFreshChild') : ''
      const poolBlock = describePoolBlock(plan.pools, plan.queued.map((task) => task.id), reuse.supported, settings.dispatchOrphanTtlMinutes)
      // **DEF-067 落点一**：真正派发这条回执同样要带上「暂不可派」段 —— 否则某张卡没派出去这件事
      // 只在诊断面（`why=true`）可见，而 `why` 恰恰**不派发**（TASK-078 的设计）⇒ 主路径上看不见。
      // **DEF-053**：静默失败（派发后窗口内没有认领）在这里落一条**可审计**事件（同一笔派发只落一次）。
      // 只在**真派发**这条路径上写：`why=true` 是纯诊断，不改台账。
      office.noteClaimMissing(call, health.claimMissing)
      return `${dispatchSummary}\n\n${out.join('\n\n')}${tail}${freshNote}${poolBlock === '' ? '' : `\n${poolBlock}`}${buildNote}${denyDriftNote}${heldByScopeSection}${healthSection}${rejectedSection}${structuralSection}`
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
            // **DEF-012**：追加通道。走 `compositeArg`（字符串或真数组都收）+ `json`（形状错误可读报）
            addWriteScopes: json<string[]>(compositeArg(args.addWriteScopes), 'addWriteScopes'),
            blockedBy: json<string[]>(args.blockedBy, 'blockedBy'),
            evidenceRequired: json<string[]>(args.evidenceRequired, 'evidenceRequired'),
            requirements: json<string[]>(args.requirements, 'requirements'),
            // **DEF-050 / TASK-072**：`fixes` 与 `requirements` 同族（都是"本卡挂在哪些台账实体上"
            // 的声明通道）。形状走 `jsonOr`（JSON 文本，规范化前的形状错误由它报），
            // 语义（重复 / 空串 / 台账里不存在的 id）由 `updateTask` 可读拒绝。
            fixes: json<string[]>(args.fixes, 'fixes'),
            // **DEF-051 / TASK-080**：`mitigates` 与 `fixes` 同族（都是"本卡挂在哪些台账实体上"的
            // 声明通道，只是换了一本台账）。形状走同一个 `jsonOr`，语义（重复 / 空串）由
            // `updateTask` 可读拒绝；"台账里没有这条风险"留给判据 C-64 判红点名（见 updateTask 注释）。
            mitigates: json<string[]>(args.mitigates, 'mitigates'),
            // 豁免是**记录列表**（对象数组），不是字符串数组 —— 形状错误由 `jsonOr` 报（含 ASCII 引号那类）。
            mitigatesWaiver: json<MitigatesWaiver[]>(args.mitigatesWaiver, 'mitigatesWaiver'),
            // **DEF-018**：落点（字符串或真数组都收；形状错误可读报）
            landing: json<string[]>(compositeArg(args.landing), 'landing'),
            // **DEF-036**：影响面声明（字符串或真数组都收 —— 与 `addWriteScopes` 同款走 `compositeArg`，
            // 形状错误由 `jsonOr` 可读报；语义（空白/重复）由 `updateTask` 可读拒绝，不静默丢弃）。
            impact: json<string[]>(compositeArg(args.impact), 'impact'),
            // `undecidable` 是**普通字符串**（不是 JSON），不走 `jsonOr`：它的一句人话不该被 JSON 转义规则绊住。
            undecidable: { value: typeof args.undecidable === 'string' ? args.undecidable : undefined, error: undefined },
            // **DEF-007**：独占组名同样是普通字符串（不是 JSON）
            exclusive: { value: typeof args.exclusive === 'string' ? args.exclusive : undefined, error: undefined },
          }
          for (const item of Object.values(fields)) if (item.error !== undefined) return item.error
          const updated = office.updateTask(call, {
            taskId: args.id,
            by: args.actor ?? args.owner ?? 'human',
            ...(args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision }),
            ...(args.title === undefined ? {} : { title: args.title }),
            ...(fields.dod.value === undefined ? {} : { dod: fields.dod.value }),
            ...(fields.writeScopes.value === undefined ? {} : { writeScopes: fields.writeScopes.value }),
            ...(fields.addWriteScopes.value === undefined ? {} : { addWriteScopes: fields.addWriteScopes.value }),
            ...(args.reason === undefined ? {} : { reason: args.reason }),
            ...(fields.blockedBy.value === undefined ? {} : { blockedBy: fields.blockedBy.value }),
            ...(fields.evidenceRequired.value === undefined ? {} : { evidenceRequired: fields.evidenceRequired.value }),
            ...(fields.requirements.value === undefined ? {} : { requirements: fields.requirements.value }),
            ...(fields.fixes.value === undefined ? {} : { fixes: fields.fixes.value }),
            ...(fields.mitigates.value === undefined ? {} : { mitigates: fields.mitigates.value }),
            ...(fields.mitigatesWaiver.value === undefined ? {} : { mitigatesWaiver: fields.mitigatesWaiver.value }),
            ...(args.mutationExpected === undefined ? {} : { mutationExpected: args.mutationExpected }),
            // **DEF-036**：影响面两条出口（`impact` 点名 / `undecidable` 声明推不出来）
            ...(fields.impact.value === undefined ? {} : { impact: fields.impact.value }),
            ...(fields.undecidable.value === undefined ? {} : { undecidable: fields.undecidable.value }),
            // **DEF-055**：声明「本卡产出用户可见文案」（布尔；`false` = 撤回声明）
            ...(args.uiText === undefined ? {} : { uiText: args.uiText }),
            // **DEF-018**：落点声明（JSON 文本或真数组都收，形状错误由 `jsonOr` 可读报）
            ...(fields.landing.value === undefined ? {} : { landing: fields.landing.value }),
            // **DEF-007**：独占窗口组名（空串 = 撤回声明）
            ...(fields.exclusive.value === undefined ? {} : { exclusive: fields.exclusive.value }),
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
            // **DEF-043 落点一/二**：双写两个基准（参数第 N 条 ⇒ 台账 index N-1），
            // 并写出**该条发现的首句** —— 使用者不必回读台账才能确认证词挂到了哪条。
            p7: String(result.disposition.index),
            p8: result.findingExcerpt,
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
            // **DEF-068**：调用方常把理由写在 `reason` 里（`param.reason` 一直存在），而旧实现只读 `note`
            // ⇒ 卡上记「（未说明）」、事件里零命中：台账里一条**假陈述**。这里做 `note ?? reason` 兜底。
            ...((args.note ?? args.reason) === undefined ? {} : { note: args.note ?? args.reason }),
            // **DEF-016 降级路径**：宿主观测拿不到子会话写入 ⇒ 由执行者自报清单，插件用同一出口核对
            ...(args.reportedFiles === undefined ? {} : { reportedFiles: parseList(args.reportedFiles) ?? [] }),
            // **DEF-033**：本次 done 未冻结的兄弟卡（逐条点名"哪些在飞卡的工作没并进来"）
            ...(args.unfrozen === undefined ? {} : { unfrozen: parseList(args.unfrozen) ?? [] }),
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
          // **DEF-045**：一次结算正常**不能**遮住更早那笔的残缺 —— 逐笔点名（含残片自己的结果与条数）
          const fragmentWarning = (health.fragments ?? []).length > 1
            ? '\n' + fmt('uiIndex.kChildReportFragments', {
                p1: result.task.id,
                p2: String((health.fragments ?? []).length),
                p3: (health.fragments ?? []).map((item) => `${item.reason}:${item.bytes}B`).join(' '),
              })
            : ''
          // **TASK-056 落点三**：该判 N/A 的判据必须把**为什么**印出来 —— "没判红"不等于
          // "什么都没发生"：判据自己按写范围路径认出"本卡没有对应对象"时，回执里要看得见，
          // 否则就是把漏判伪装成 N/A（DEF-009 / DEF-019 / DEF-026 的成因）。
          const naNotes = result.naNotes ?? []
          const naBlock = naNotes.length === 0
            ? ''
            : '\n' + t('uiIndex.kNaNotesHeader') + '\n' + naNotes.map((note) => `- ${note}`).join('\n')
          // **DEF-050 落点三**：卡含 `fixes` 时，`done` 的回执**逐条回显**该缺陷的台账现状态 ——
          // 「文档说已修」与「台账状态」当场对齐，不靠人记得去 `.sdo/defects/*.yml` 查。
          // 内容由域层算（`report()` 的 `fixEcho`，与判据 C-63 共用 `fixStatusRows` 一个出口），
          // 这里只负责排版：回显不等于拦截 —— 拦截是 C-63 的活（未闭合的卡在这里**照常** done，
          // 门禁那关才判红；两处口径一致所以不会互相打脸）。
          const fixEcho = result.fixEcho ?? []
          const fixBlock = fixEcho.length === 0
            ? ''
            : '\n' + t('uiIndex.kFixCards') + '\n' + fixEcho.join('\n')
          // **DEF-013（§3E 族 3）**：产物证据的**回显面** —— 每条 `artifact` 证据现算**完整 64 位** sha256
          // 与**文件 mtime**，并把「本次自述条数」与「台账累计条数」**并列**印出（不一致就点名差额）。
          // 只印不判：判据（`evidence-artifact-hash` / `evidence-artifact-missing` …）在域层照旧拦，
          // 这里既不改它们的口径、也不因为多印一行而放宽。`note` 是自然语言 ⇒ **不解析、不判红**。
          const artifactRows = artifactEchoRows(office.requireWorkspace(call), items)
          const tally = evidenceTally(items, result.task.evidence)
          const artifactBlock = artifactRows.length === 0
            ? ''
            : '\n' + fmt('uiIndex.kArtifactEchoHeader', { p1: String(tally.selfArtifact), p2: String(tally.ledgerArtifact) })
              + '\n' + artifactRows
                .map((row) =>
                  row.sha256 === undefined
                    ? fmt('uiIndex.kArtifactEchoUnreadableRow', {
                        p1: row.path === '' ? row.detail : row.path,
                        p2: row.unreadable ?? '',
                      })
                    : fmt('uiIndex.kArtifactEchoRow', { p1: row.path, p2: row.sha256, p3: row.mtime ?? '' })
                      + (row.declared === undefined ? '' : fmt('uiIndex.kArtifactEchoDeclared', { p1: row.declared })),
                )
                .join('\n')
              + '\n' + fmt('uiIndex.kArtifactEchoCounts', {
                p1: String(tally.selfTotal),
                p2: String(tally.selfArtifact),
                p3: String(tally.selfCommand),
                p4: String(tally.selfOther),
                p5: String(tally.ledgerTotal),
                p6: String(tally.ledgerArtifact),
              })
              + (tally.ledgerTotal === tally.selfTotal
                ? ''
                : '\n' + fmt('uiIndex.kArtifactEchoLedgerExtra', { p1: String(tally.ledgerTotal - tally.selfTotal) }))
          // A2：采集不到变更清单时**如实说**"写范围未对账"，不让"没数据"读成"已核对"
          // **DEF-016**：自报对账必须**标注来源**（自报是声明，不是宿主观测）
          const selfReportNote = result.workspaceAudit?.selfReported === true
            ? '\n' + fmt('uiIndex.kWorkScopeSelfReported', { p1: String(result.workspaceAudit.changed) })
            : ''
          // **R5（第三批 §3.7）**：`impact` 的 done 面对账 —— 声明过却没被"处理过"的影响面逐条点名
          //（本卡改过 / 有 pass 结果绑着它 / 在自报清单里，三者之一即视为处理过）。
          // 与 `fixBlock` 同款：**回显不拦截**（拦截会让"改既有语义"的卡永远收不了工），判据面归 G 门禁。
          // **DEF-033（第三批 §3.13；第四批 §3.4 收紧）**：完成语义的读数 —— 局部绿（含未冻结清单）／全量冻结。
          // **漏声明不再是一条"回执提醒"**：它现在**当场拒绝**（域层 `unfrozen-undeclared`，零写盘，
          // 见 `ADR-014`）⇒ 能走到这里的只有"声明齐备"或"没有在飞兄弟卡"两态。
          // 假声明（写错 / 已 done / 本卡自己）由 `unfrozen-bad-id` 拒绝，两类文案不混。
          const unfrozenDeclared = result.unfrozen ?? []
          const unfrozenBlock = unfrozenDeclared.length > 0
            ? '\n' + fmt('uiIndex.kUnfrozenLocal', { p1: unfrozenDeclared.join(t('uiCollab.kListSep')) })
            : '\n' + t('uiIndex.kUnfrozenFrozen')
          const impactGaps = result.impactGaps ?? []
          const impactBlock = impactGaps.length === 0
            ? ''
            : '\n' + fmt('uiIndex.kImpactGapsHeader', { p1: String(impactGaps.length) })
              + '\n' + impactGaps.map((path) => `- ${path}`).join('\n')
              + '\n' + t('uiIndex.kImpactGapsRemedy')
          return (result.workspaceAudit !== undefined && !result.workspaceAudit.checked
            ? taskText + '\n' + t('uiIndex.kWorkScopeNotAudited')
            : taskText + selfReportNote) + fixBlock + artifactBlock + naBlock + impactBlock + unfrozenBlock + reportWarning + fragmentWarning
        }
        case 'errata': {
          // **DEF-071**：done 卡的**追加式**勘误通道 —— 历史不重写，但"本卡不做的说明"必须能补。
          if (args.id === undefined) return t('uiIndex.k33')
          const outcome = office.addErrata(call, {
            taskId: args.id,
            by: args.actor ?? args.owner ?? 'human',
            note: args.note ?? args.reason ?? '',
          })
          if (!outcome.ok) return fmt('uiIndex.k35', { p1: outcome.code, p2: outcome.detail })
          return fmt('uiIndex.kErrataAdded', {
            p1: outcome.task.id,
            p2: String(outcome.count),
            p3: String(outcome.task.revision),
          })
        }
        case 'unblock': {
          // **DEF-049 / TASK-078 落点一**：把卡从 `blocked` 恢复为 `ready`。
          //
          // 为什么需要它：`blocked` 在修复前是卡生命周期的**死胡同** —— `readyTasks` 的派发准入
          // 只认 `planned`/`ready`，工具面又没有恢复动作，而 `block` 恰恰是本项目在每张卡派发协议里
          // **鼓励**的行为（"做不下去就 block，不要硬撑也不要静默改范围"）⇒ 鼓励的动作把人送进死胡同：
          // 真机上驾驶舱只能**语义外地**用 `release` 把卡捞回来（release 的语义是"放手"，
          // 不是"阻塞条件已解除"）。
          //
          // 授权：**驾驶舱，或该卡原 owner**（认领会话，与 `release`/`update` 同一口径）。
          // 判定放在这里而不是域层：只有工具层拿得到 `call.sessionId`。
          if (args.id === undefined) return t('uiIndex.k33')
          const reason = args.reason ?? ''
          if (reason.trim() === '') return t('uiIndex.kTaskUnblockNeedsReason')
          const by = args.actor ?? 'cockpit'
          const outcome = office.unblockTask(call, { taskId: args.id, reason, by })
          if (!outcome.ok) return fmt('uiIndex.kTaskUnblockRejected', { p1: outcome.code, p2: outcome.detail })
          return fmt('uiIndex.kTaskUnblocked', {
            p1: outcome.blockedReason === '' ? t('uiIndex.kTaskUnblockNoReason') : outcome.blockedReason,
            p2: reason,
            p3: outcome.previousOwner === '' ? t('uiCollab.unblockNoOwner') : outcome.previousOwner,
          }) + '\n' + describeTask(outcome.task, office.shapeNotes(call))
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
        default: {
          // **DEF-050 / TASK-072**：`fixes` 必须在 **`list` 的回执**里可见（可见即约束）——
          // 一条只存在于 YAML 里的声明，读回执的人（流程官/用户）看不到就等于没有。
          // 这里不重写看板本体（`describeTaskBoard` 的行格式是别的卡的判据面），只在其后**补一段**
          // 逐卡列出声明：`TASK-xxx → DEF-1, DEF-2`；没有任何卡声明时一个字都不加。
          const declared = office.tasks(call).filter((task) => (task.fixes ?? []).length > 0)
          const fixBoard = declared.length === 0
            ? ''
            : '\n' + t('uiIndex.kFixCards') + '\n'
              + declared.map((task) => `- ${task.id}（${task.status}）→ ${(task.fixes ?? []).join('、')}`).join('\n')
          return describeTaskBoard({
            tasks: office.tasks(call),
            ready: office.readyForDispatch(call, 64),
            stale: office.staleTasks(call),
            issues: office.planIssues(call),
            iteration: office.iteration(call),
            shapeNotes: office.shapeNotes(call),
          }) + fixBoard
        }
      }
    },

    async test(call: OfficeCall, args: TestArgs): Promise<string> {
      switch (args.action) {
        case 'plan': {
          if ((args.title ?? '') === '' || (args.expected ?? '') === '') return t('uiIndex.k38')
          const steps = jsonOr<string[]>(args.steps, 'steps')
          if (steps.error !== undefined) return steps.error
          // **REQ-054（TASK-054）**：判定基准（oracle）逐类机械核对 —— 核对实现仍只有
          // `evidence.ts` 的 `oracleGaps()` 一处（本卡**不动判定语义**，只让工具面有出口）。
          // **plan 侧不强制**：缺失的降级扣在**结果**上（"缺判定基准的用例不计入通过覆盖"，
          // `isAdopted()` 的第四步）—— 建用例时还没有结果，它仍然是有用的台账条目（老台账也这样）；
          // `record` 侧才是必填（没有判定基准的结果就是走过场）。
          const oracle = oracleArg(args.oracle)
          if (oracle.error !== undefined) return oracle.error
          // `acceptance` 类的 `ref` 缺省回落成这条用例覆盖的需求（口径与 `isAdopted()` 的
          // `result.oracle ?? testCase.oracle` 同族：**只在真缺时兜底，显式给了就不改**）
          const oracleRef = stampOracleRequirement(oracle.value, args.requirement, args.requirement)
          // **只在真给了判定基准时才核对**：`plan` 不强制（缺判定基准的用例照样是合法的台账条目，
          // 降级扣在结果上）—— 但**给了就必须成立**（引用不存在的 AC / 契约 / 基线一律判红点名）。
          if (oracleRef !== undefined) {
            const gaps = oracleGaps(office.storeFor(office.requireWorkspace(call)), oracleRef, {
              workspace: office.requireWorkspace(call),
              ...(args.requirement === undefined ? {} : { requirement: args.requirement }),
            })
            if (gaps.length > 0) return fmt('uiIndex.kOracleRejected', { p1: gaps.join('；') })
          }
          const testCase = office.addTestCase(call, {
            title: args.title ?? '',
            kind: args.kind ?? 'unit',
            ...(args.requirement === undefined ? {} : { requirement: args.requirement }),
            steps: steps.value ?? [],
            expected: args.expected ?? '',
            // 没给就是没给：**不落一个空 oracle 键**（老台账照样读得出来）
            ...(oracleRef === undefined ? {} : { oracle: oracleRef }),
          })
          const oracleNote = testCase.oracle === undefined ? '' : fmt('uiIndex.kOraclePlanned', { p1: describeOracle(testCase.oracle) })
          return fmt('uiIndex.k39', { p1: testCase.id, p2: testCase.kind, p3: testCase.title, p4: testCase.requirement === undefined ? '' : fmt('uiIndex.k116', { p1: testCase.requirement }) }) + oracleNote
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
          // —————— **REQ-054（TASK-054）**：判定基准的参数面 ——————
          // 这条是本卡存在的理由：域层早就认 `result.oracle ?? testCase.oracle`，但工具面没这个参数 ⇒
          // 真机上「执行者 ≠ 采纳者 + 判定基准成立」**无出口**，`passedAdopted` 永远是 0、C-50 恒红。
          const { store, workspace } = office.contextFor(call)
          const existingCase = office.testCases(call).find((item) => item.id === args.caseId)
          const oracle = oracleArg(args.oracle)
          if (oracle.error !== undefined) return oracle.error
          // 回落链的口径与 `isAdopted()` 的 `result.oracle ?? testCase.oracle` **同族**：
          //   结果级（本次给的）> 用例级（plan 时登记的）> 覆盖需求（供 `acceptance` 类兜底 ref）
          const fallbackCaseOracle = existingCase?.oracle
          const resolvedOracle = stampOracleRequirement(
            oracle.value ?? fallbackCaseOracle,
            args.oracle === undefined ? undefined : args.requirement,
            args.requirement ?? fallbackCaseOracle?.ref ?? existingCase?.requirement,
          )
          const oracleSource = args.oracle !== undefined ? 'result' : (fallbackCaseOracle === undefined ? 'none' : 'case')
          // **缺判定基准只能判红**（缺 = 这条结果不计入通过覆盖，不是"先记下、以后再说"）：
          // 工具面必须当场说清缺哪一类、怎么补，否则 C-50 的补救动作仍然没有出口。
          if (resolvedOracle === undefined) {
            return fmt('uiIndex.kOracleMissing', {
              p1: args.caseId,
              p2: oracleKindsText(),
            })
          }
          const oracleGapList = oracleGaps(store, resolvedOracle, {
            workspace,
            caseId: existingCase?.id ?? args.caseId,
            ...(existingCase?.requirement === undefined ? {} : { requirement: existingCase.requirement }),
          })
          if (oracleGapList.length > 0) {
            return fmt('uiIndex.kOracleRejected', {
              p1: oracleGapList.join('；') + t('uiIndex.kOracleNothingWritten'),
            })
          }
          // **DEF-075**：先解析"这条结论依据于哪些已修缺陷"（数组 / JSON 文本二选一）。
          // 形状不对 ⇒ **可读拒绝**（不把异常抛到工具边界）：`defects` 是绑定，静默丢它等于没绑。
          const defectsParsed = ((): { ids?: string[]; error?: string } => {
            if (args.defects === undefined) return {}
            const parsed = jsonOr<unknown>(args.defects, 'defects')
            if (parsed.error !== undefined) return { error: parsed.error }
            const list = parsed.value
            if (list === undefined) return {}
            if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
              return { error: t('uiIndex.kBadDefects') }
            }
            const ids = list.map((item) => String(item).trim()).filter((item) => item !== '')
            return ids.length === 0 ? {} : { ids }
          })()
          if (defectsParsed.error !== undefined) return fmt('uiIndex.k35', { p1: 'bad-defects', p2: defectsParsed.error })
          const declaredDefects = defectsParsed.ids
          const outcome = office.addTestResult(call, {
            caseId: args.caseId,
            status: args.status,
            evidence: args.evidence ?? '',
            // **SDO-57（C）**：证据自带**时点（at）+ 前置（env/被检产物）** ⇒ 限定语不再静默过期
            ...(args.env === undefined ? {} : { env: args.env }),
            ...(args.artifact === undefined ? {} : { artifact: args.artifact }),
            // **DEF-011**：调用方声明了哈希就透传给域层对账（一致才落盘）
            ...(args.artifactSha256 === undefined ? {} : { artifactSha256: args.artifactSha256 }),
            ...(declaredDefects === undefined ? {} : { defects: declaredDefects }),
            // **DEF-033 第三面（第四批 §3.5）**：这条结论自称覆盖**全量**（C-67 在 G7 读它）。
            // 漏这一行 = 声明在工具层被**静默丢弃** ⇒「全量绿」永远立不起来（`tq_ff348198` 的老坑）。
            ...(args.fullSuite === true ? { fullSuite: true } : {}),
            // **R-3**：断言面指纹（红绿必须一致；不给就只按"出现过 fail、后有 pass"判，与旧行为一致）
            ...(args.harness === undefined ? {} : { harness: args.harness }),
            // **REQ-053（TASK-039）**：执行者与采纳者逐字段搬进域层 —— 漏一行就等于工具层**静默丢弃**
            // （工具面看得见参数、回执说成功、`test/recorded` 里却没有它们 ⇒ REQ-053 在真机上够不着）。
            ...(args.executedBy === undefined ? {} : { executedBy: args.executedBy }),
            ...(args.adoptedBy === undefined ? {} : { adoptedBy: args.adoptedBy }),
            // **REQ-054（TASK-054）**：判定基准同样逐字段搬 —— 它进 `tests/results/*.yml` 与
            // `test/recorded` 的 `oracleKind`（"这条凭什么判定"必须能从真源回读）
            oracle: resolvedOracle,
          })
          // **DEF-037**：幽灵/空 `caseId` 一律**可读拒绝**（结果是"用例的"结果，写盘前必须对得上）
          if (!outcome.ok) return fmt('uiIndex.k35', { p1: outcome.code, p2: outcome.detail })
          const result = outcome.result
          const stats = office.verification(call)
          // 记完这一条就把"时效"摆出来（只告警、不拦）：过期的证据与没记环境的结果都要被看见
          const fresh = office.evidenceFreshness(call)
          const notes: string[] = []
          // **REQ-054（TASK-054）**：回执回显"这条凭什么判定"+ 它是从哪来的（本次给的 / 用例上登记的）——
          // 判定基准现在**必填**，不给就进不来；给了就要让它看得见（不然"记成功了"读不出凭证是什么）。
          notes.push('\n' + fmt('uiIndex.kOracleRecorded', {
            p1: describeOracle(resolvedOracle),
            p2: oracleSource === 'result' ? t('uiIndex.kOracleSourceResult') : t('uiIndex.kOracleSourceCase'),
          }))
          for (const item of fresh.stale) notes.push('\n' + fmt('uiIndex.kEvidenceStale', { p1: item.resultId, p2: item.caseId, p3: item.reason }))
          if ((result.env ?? '') === '') {
            notes.push('\n' + t('uiIndex.kEvidenceNoEnv'))
          } else if (result.envSource === 'inherited') {
            notes.push('\n' + fmt('uiIndex.kEvidenceEnvInherited', { p1: result.env ?? '' }))
          }
          // **REQ-053（TASK-039）**：独立性是**判据**不是备注 —— 缺参数当场说清"这条进不了 passedAdopted"，
          // 而不是等 G6 的 C-50 判红才回来找（"静默丢弃"正是本卡要消灭的形态）。
          const missingAdoption = [
            ...(args.executedBy === undefined ? ['executedBy'] : []),
            ...(args.adoptedBy === undefined ? ['adoptedBy'] : []),
          ]
          if (missingAdoption.length > 0) {
            notes.push('\n' + fmt('uiIndex.kRecordAdoptionMissing', { p1: missingAdoption.join(' / ') }))
          } else if (args.executedBy === args.adoptedBy) {
            // 自执行自采纳：域层**不予计入**（`isAdopted` 第 4 条）。当场点名，别让它静默变成一条"通过"
            notes.push('\n' + fmt('uiIndex.kRecordSelfAdopted', { p1: String(args.executedBy ?? '') }))
          } else if (stats.unadopted.includes(result.id)) {
            // 两个端点都给了、也不是自采纳，域层却仍**不予计入** ⇒ 剩下的就是判定基准（REQ-054）那一族。
            // 不许回一句"已记录"就完事：这条进不了 `passedAdopted`，G6 的 C-50 会点名它。
            // （TASK-054 之后 oracle 已经是**必填**且逐类核对过，所以正常路径到不了这里；
            //  留着它是因为"域层不予计入"与"工具面以为成立"可能因别的原因分叉 —— 那种分叉必须说出来。）
            notes.push('\n' + fmt('uiIndex.kRecordStillUnadopted', { p1: result.id }))
          } else {
            notes.push('\n' + fmt('uiIndex.kRecordAdoptionRecorded', { p1: String(args.executedBy ?? ''), p2: String(args.adoptedBy ?? '') }))
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
          //
          // **DEF-025（第三批 §3.10）**：不给 `env` ⇒ **只读回显当前环境串**（旧实现是可读拒绝，
          // 于是"当前环境到底是什么"除了翻台账没别的办法拿到）；登记时回执必须**点名影响面**
          //（会让哪些既有结果变成"证据过期"）并给**可执行的补做/重跑出路**。
          if (args.env === undefined || args.env.trim() === '') {
            const current = office.environmentStatus(call)
            return current.env === ''
              ? t('uiIndex.kEnvNeverRegistered')
              : fmt('uiIndex.kEnvCurrent', { p1: current.env, p2: current.at })
          }
          const recorded = office.noteEnvironment(call, {
            env: args.env,
            ...(args.reason === undefined ? {} : { note: args.reason }),
            by: 'human',
          })
          if (!recorded.ok) return t('uiIndex.kEnvMissing')
          if (recorded.newlyStale.length === 0) {
            return fmt('uiIndex.kEnvRecorded', { p1: recorded.env, p2: recorded.at }) + '\n' + fmt('uiIndex.kEnvNoImpact', { p1: recorded.env })
          }
          return fmt('uiIndex.kEnvRecorded', { p1: recorded.env, p2: recorded.at })
            + '\n' + fmt('uiIndex.kEnvImpact', {
              p1: String(recorded.newlyStale.length),
              p2: recorded.newlyStale.map((row) => `${row.resultId}（${row.caseId}）：${row.reason}`).join('；'),
            })
            + '\n' + t('uiIndex.kEnvRemedy')
        }
        case 'defect': {
          // **REQ-055（TASK-039）**：根因面三字段只在**新建**时可用（`DefectUpdate` 没有它们 —— 域模型边界
          // 不在本卡里改）。给了却到不了域层 = 静默丢弃，所以这里**可读拒绝**并说清该怎么改。
          const rootFields = [
            ...(args.rootCause === undefined ? [] : ['rootCause']),
            ...(args.discoveryLevel === undefined ? [] : ['discoveryLevel']),
            ...(args.escaped === undefined ? [] : ['escaped']),
          ]
          // **DEF-038（TASK-063）**：免责依据两字段与根因面一族**同族同纪律**，但有一条有意的差别 ——
          // 它们在**更新路径上也受理**（`DefectUpdate` 有它们）：根因答的是"这条缺陷怎么来的"（历史事实，
          // 事后改＝篡改），免责依据答的是"**现在**要不要放过它、谁拍的板"（一个决定，本就会被补/被改/被撤销，
          // 拒绝受理只会把"改决定"逼成"重建一条缺陷"，反而销毁审计链）。契约见 `records.ts` 的 `DefectUpdate`。
          // 共同纪律：**空串不等于填了** —— 空白一律可读拒绝（否则 C-51 会读到"齐备"的假象：
          // `isBlockerWaived` 判的正是"去空白后非空"）。
          const blankWaive = ([
            ['waiveReason', args.waiveReason],
            ['waiveApprovedBy', args.waiveApprovedBy],
          ] as const).filter(([, value]) => value !== undefined && value.trim() === '').map(([name]) => name)
          if (blankWaive.length > 0) {
            return fmt('uiIndex.kDefectWaiveBlank', { p1: blankWaive.join(' / ') })
          }
          if (args.defectId !== undefined) {
            if (rootFields.length > 0) {
              return fmt('uiIndex.kDefectRootFieldsNotUpdatable', { p1: rootFields.join(' / ') })
            }
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
              // **DEF-038（TASK-063）**：免责依据两字段在更新路径上受理（空白已在上面可读拒绝；
              // 与现值相同 ⇒ 域层报 `no-op-update`，不假装"已更新"）
              ...(args.waiveReason === undefined ? {} : { waiveReason: args.waiveReason }),
              ...(args.waiveApprovedBy === undefined ? {} : { waiveApprovedBy: args.waiveApprovedBy }),
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
          // **REQ-055（TASK-039）**：发现级别先过**词表**再入账 —— 词表只有一份（`DEFECT_DISCOVERY_LEVELS`，
          // 域层同一处），非法取值**可读拒绝并点名合法集合**：自由文本的发现级别机械核不动（逃逸判定就悬空了）。
          const level = (args.discoveryLevel ?? '').trim()
          if (level !== '' && !isDefectDiscoveryLevel(level)) {
            return fmt('uiIndex.kDefectBadDiscoveryLevel', { p1: String(args.discoveryLevel ?? ''), p2: DEFECT_DISCOVERY_LEVELS.join(' / ') })
          }
          const defect = office.addDefect(call, {
            title: args.title ?? '',
            severity: args.severity,
            ...(args.caseId === undefined ? {} : { caseId: args.caseId }),
            status: createdStatus,
            // **REQ-055（TASK-039）**：根因面三字段逐字段搬进域层（漏一行 = 工具层静默丢弃；
            // 归一化口径只有一处实现 —— `records.ts` 的 `recordDefect`：空串不落键、`escaped` 只认真布尔）
            ...(args.rootCause === undefined ? {} : { rootCause: args.rootCause }),
            ...(level === '' ? {} : { discoveryLevel: level }),
            ...(args.escaped === undefined ? {} : { escaped: args.escaped }),
            // **DEF-038（TASK-063）**：免责依据两字段同样逐字段搬进域层（漏一行 = 工具层静默丢弃；
            // 归一化只有 `records.ts` 的 `recordDefect` 一处：空串不落键）
            ...(args.waiveReason === undefined ? {} : { waiveReason: args.waiveReason }),
            ...(args.waiveApprovedBy === undefined ? {} : { waiveApprovedBy: args.waiveApprovedBy }),
          })
          // 回执**回显真被接收了什么**：没给的字段如实说"没有登记"（不许让"没给"读成"已给"）
          const received = [
            ...(defect.rootCause === undefined ? [] : [`rootCause=${defect.rootCause}`]),
            ...(defect.discoveryLevel === undefined ? [] : [`discoveryLevel=${defect.discoveryLevel}`]),
            ...(defect.escaped === undefined ? [] : [`escaped=${String(defect.escaped)}`]),
            ...(defect.waiveReason === undefined ? [] : [`waiveReason=${defect.waiveReason}`]),
            ...(defect.waiveApprovedBy === undefined ? [] : [`waiveApprovedBy=${defect.waiveApprovedBy}`]),
          ]
          const rootNote = received.length === 0
            ? '\n' + t('uiIndex.kDefectRootFieldsMissing')
            : '\n' + fmt('uiIndex.kDefectRootFieldsRecorded', { p1: received.join('; ') })
          // **DEF-038**：阻塞级 + wontfix 且**理由与批准人没齐** ⇒ 当场把话说清（别等 G6 才由 C-51 判红）。
          // 这不是拒绝写入：缺陷照常入账，只是回执如实告警"这条现在拦门禁"。
          const waiveGap = defect.severity === 'blocker' && defect.status === 'wontfix'
            && (defect.waiveReason === undefined || defect.waiveApprovedBy === undefined)
          const waiveNote = !waiveGap
            ? ''
            : '\n' + fmt('uiIndex.kDefectWaiveRequired', {
              p1: defect.id,
              p2: [
                ...(defect.waiveReason === undefined ? ['waiveReason'] : []),
                ...(defect.waiveApprovedBy === undefined ? ['waiveApprovedBy'] : []),
              ].join(' / '),
            })
          return fmt('uiIndex.k45', { p1: defect.id, p2: defect.severity, p3: defect.status, p4: defect.title }) + rootNote + waiveNote
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
      if (args.action === 'append') {
        // **TASK-108 / DEF-065 拆出项**：向**既有**评审追加发现项 —— 补录不再另起一条同 verdict 的记录。
        // 只追加、不改写：这里**不读** `taskId` / `reviewer` / `verdict`（原评审的结论与归属由文件说话）。
        if (args.id === undefined) return t('uiIndex.kReviewAppendNoId')
        const findings = jsonOr<unknown>(args.findings, 'findings')
        if (findings.error !== undefined) return findings.error
        const workspace = office.requireWorkspace(call)
        const result = appendReviewFindings(office.storeFor(workspace), office.journalFor(workspace), {
          reviewId: args.id,
          findings: findings.value,
          by: args.actor ?? 'human',
          // **DEF-072**：条号声明（成对；缺一个由域层可读拒绝，不静默丢弃）
          ...(args.originalIndex === undefined ? {} : { originalIndex: args.originalIndex }),
          ...(args.originalTotal === undefined ? {} : { originalTotal: args.originalTotal }),
          // **DEF-048**：补录也可以**补上**"当前仍失败的复现命令"（或"无法复现"声明）——
          // 存量非 pass 评审缺这两条出路时，这是把它补齐的通道
          ...(args.repro === undefined ? {} : { repro: args.repro }),
          ...(args.unreproducible === undefined ? {} : { unreproducible: args.unreproducible }),
          ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
        })
        if (!result.ok) return `${result.code}：${result.detail}`
        const review = result.review
        return fmt('uiIndex.kReviewAppended', {
          p1: review.id,
          p2: String(result.appendCount),
          p3: String(result.appended.length),
          p4: String(result.fromIndex + 1),
          p5: String(result.total),
          p6: review.verdict,
        })
          // **Z-3**：schema 上有、这个动作不消费的入参必须**点名**（不得静默）——
          // 尤其 `verdict`：追加路径改不了它，用户传了也要当场说清"它没被用上"。
          + unusedArgsNote(['taskId', 'reviewer', 'verdict'], [args.taskId, args.reviewer, args.verdict])
          + fmt('uiIndex.kReviewAppendCaliber', {
            p1: review.id,
            p2: String(result.fromIndex + 1),
            p3: String(result.total),
            p4: review.taskId,
          })
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
      // **DEF-048（第三批 §3.16）**：非 `pass` 的待修主张必须带 `repro`（当前仍失败的复现命令）
      // 或 `unreproducible`（显式声明无法复现 + 为什么）—— 缺则**可读拒绝**（零写盘）。
      // 判据在域层唯一出口（`reviewReproIssue`），这里只把抛出的 `ReviewReproError` 转成回执。
      // **DEF-076（第四批 §3.3）**：这条评审**点名了哪些缺陷**（JSON 文本或真数组，`parseList` 两种都收）。
      // 形状不对 ⇒ 当场可读拒绝；未知 id 由**域层唯一出口** `reviewDefectIssue` 拦（这里只转回执）。
      const namedDefects = args.defectId === undefined ? undefined : (parseList(args.defectId) ?? [])
      let review: Review
      try {
        review = office.addReview(call, {
          taskId: args.taskId,
          reviewer: args.reviewer,
          verdict: args.verdict,
          findings: findings.value ?? [],
          ...(args.repro === undefined ? {} : { repro: args.repro }),
          ...(args.unreproducible === undefined ? {} : { unreproducible: args.unreproducible }),
          // **DEF-076**：点名的缺陷进真源；缺省则不写这个键（存量形状不变）
          ...(namedDefects === undefined ? {} : { defects: namedDefects }),
          // 记下"谁记的"：同会话不许自己核实自己（域层据此拒）
          ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
        })
      } catch (error) {
        if (error instanceof ReviewReproError) return error.detail
        // **DEF-076**：点名的缺陷不存在 ⇒ 与 `ReviewReproError` 同一个出口（可读拒绝、零写盘）
        if (error instanceof ReviewDefectError) return error.detail
        throw error
      }
      return fmt('uiIndex.k51', { p1: review.id, p2: review.taskId, p3: review.verdict, p4: review.reviewer, p5: task.owner === undefined ? '' : fmt('uiIndex.k117', { p1: task.owner }) })
        // **DEF-076**：点名了缺陷就把名单回显（否则"这条评审点了谁"只写在文件里，回执读者看不见）
        + ((review.defects ?? []).length === 0 ? '' : '\n' + fmt('uiIndex.kReviewDefects', { p1: review.defects?.join(t('uiCollab.kListSep')) ?? '' }))
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
          artifactSha256: args.artifactSha256,
          exitCode: args.exitCode,
          by: args.by ?? 'human',
        })
        if (!recorded.ok) return fmt('uiIndex.kRunRejected', { p1: recorded.detail })
        const bound = recorded.run.artifactSha256 === ''
          ? t('uiIndex.kRunUnbound')
          // **DEF-013**：这里过去 `slice(0, 12)` —— 完整 64 位在回执里**不可见**，读者无法自己核对
          // 「跑的就是这份」。改为回显**完整 sha256**（只是回显变全，绑定语义与判据一字未动）。
          : fmt('uiIndex.kRunBound', { p1: recorded.run.artifact, p2: recorded.run.artifactSha256 })
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
          // **交互优化（2026-10-10 定稿）**：签字前摆出待签对象，**卡片只放摘要、全文走侧边栏**。
          //  · 摘要是判定总览那 5 行 —— 由本工具从真源现读现渲染，**不经过模型**；
          //  · 全文（逐条判据 + 未通过项修法 + 产物清单）落盘到 `.sdo/reviews/**`，
          //    客户端半按**固定路径**只读取它并放进右侧边栏（顺带成为"签字时看到过什么"的审计件）。
          const review = office.signReview(call, args.gate)
          const answer = await deps.gateSignQuestion?.(call, args.gate, review.summary)
          if (answer === undefined) return t('uiIndex.kSignNoChannel')
          if (answer.selectedLabel !== t('uiSign.signOption')) {
            // **次要 2（2026-10-09 整体评审）**：question 通道的"用户拒绝"以前**不留痕** ⇒
            // 台账上"问过、被拒"与"没问过"长得一样。与陈述式拒绝同口径记一条中性事件。
            office.noteSignRejected(call, args.gate, 'question', answer.selectedLabel)
            return fmt('uiIndex.kSignDeclined', { p1: gateLabel(args.gate), p2: answer.selectedLabel })
          }
          // **审核单新鲜度**（2026-10-12）：用户从看到卡片到作答可能过了几分钟，
          // 期间真源若被改动，用户签的就是**过期审核单**。这里在落签字之前重算指纹核对，
          // 不一致就**拒签并逐条点名差异**（不许静默按旧审核单存证）。
          const drift = office.signReviewDrift(call, args.gate, review.record)
          if (drift.length > 0) {
            office.noteSignRejected(call, args.gate, 'question', answer.selectedLabel)
            return fmt('uiIndex.kSignReviewStale', {
              p1: gateLabel(args.gate),
              p2: drift.join('；'),
            })
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
        // **无审核单 ⇒ 不许盲签**（2026-10-12）：`channel=statement` 的依据是用户"以前说过的话"，
        // 他可能根本没看过审核单。要求该门禁**先有审核单**且**与当前真源一致**。
        const record = office.signReviewRecord(call, args.gate)
        if (record === undefined) {
          return fmt('uiIndex.kSignNoReview', { p1: gateLabel(args.gate) })
        }
        const drift = office.signReviewDrift(call, args.gate, record)
        if (drift.length > 0) {
          return fmt('uiIndex.kSignReviewStale', { p1: gateLabel(args.gate), p2: drift.join('；') })
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
    async gateSignQuestion(call: OfficeCall, gate: string, detail?: string): Promise<GateSignAnswer | undefined> {
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
            // **交互优化（2026-10-09）**：`detail` 里放的是**本次要签的审核单全文**
            //（`office.signReviewDoc` 从真源现读现渲染），用户在卡片里就能通读、
            // 客户端半还会把它镜像到右侧边栏。没给 detail 时才退回原来那句固定说明。
            detail: detail ?? t('uiSign.detail'),
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
      // **DEF-004 / DEF-005**：架构阶段声明的 `QUALITY.md`（质量场景与 ATAM）与 `DECISIONS.md`
      // （ADR 汇总）此前**没有任何渲染入口**；审核单的「本门相关产物」因此长期显示永远补不上的"缺失"。
      const allowed: Record<string, { which: 'srs' | 'decisions' | 'quality'; label: string }> = {
        srs: { which: 'srs', label: 'SRS' },
        decisions: { which: 'decisions', label: 'DECISIONS' },
        quality: { which: 'quality', label: 'QUALITY' },
      }
      const spec = allowed[target]
      if (spec === undefined) return fmt('uiIndex.k90', { p1: target })
      const path = office.render(call, spec.which)
      const seq = office.journalFor(office.requireWorkspace(call)).read().events.length
      return describeRender(spec.label, path, seq)
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
        // **DEF-056 / §3E 族 4**：`requires` 的写侧通路（这里是第四处：工具面解析 + 语义校验，全部**零写盘**）。
        // 为什么必须在这里拒而不是只存下来：`requires` 是**判据的输入面**（`contractsOfCard` 拿它与卡的
        // `requirements` 求交），写错一个号 = 那张卡永远拿不到「契约对象」⇒ `contract-test-missing` 对它
        // 是**永久 N/A** —— 静默漏过正是本批要消灭的形态（处置口径与 `fixes` 的"不许落空"同款）。
        const requires = parseList(args.requires) ?? []
        const duplicateRequires = [...new Set(requires.filter((id, index) => requires.indexOf(id) !== index))]
        if (duplicateRequires.length > 0) {
          return fmt('uiIndex.kContractRequiresDuplicate', { p1: duplicateRequires.join('、') })
        }
        const knownRequirements = new Set(listRequirementIds(office.storeFor(office.requireWorkspace(call))))
        const unknownRequires = requires.filter((id) => !knownRequirements.has(id))
        if (unknownRequires.length > 0) {
          return fmt('uiIndex.kContractRequiresUnknown', { p1: unknownRequires.join('、'), p2: String(knownRequirements.size) })
        }
        const contract = office.recordContract(call, {
          ...(args.id === undefined ? {} : { id: args.id }),
          // D4-2：方向按字段语义写（producer → consumer），避免被误读成「方向写反」
          name: `${args.producer} → ${args.consumer}`,
          kind: parseContractKind(args.contractKind),
          producer: args.producer ?? '',
          consumer: args.consumer ?? '',
          schema: args.schema ?? '',
          requires,
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
            const snapshot = office.status(injectionCall(context?.scope))
            // **DEF-070**：状态回执必须报**本会话实际加载的那份构建**（端到端验证最容易验到旧构建）。
            // 比对基准取**本会话的工作区**（不是进程 cwd）—— 那是"这份构建要服务哪个仓"的事实。
            const buildLine = buildReadout(dirname(snapshot.dataDir))
            return buildLine + '\n' + renderStatusBlock(
              snapshot,
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
            // **DEF-047 落点一（其零）**：认领归属与卡的查找也必须按**工作区根** —— 会话 cwd 是子目录时
            // `<子目录>/.sdo` 不存在，按会话 cwd 查 `claimsBySession` 会**一条认领都读不到** ⇒ 角色被判成
            // "子会话但没认领" ⇒ `cardId` 缺席 ⇒ 闸门拿不到卡的写范围 ⇒ **在范围内的路径被误拒**。
            //
            // **DEF-054（第三批 §3.17）**：这里原用 `findProjectRoot(call.cwd, …)` —— 它会**向上爬**，
            // 会话 cwd 在 `<祖先项目>/proj/sub` 时会认到**祖先项目**的 `.sdo/` ⇒ **跨项目串账**
            //（`dab49d5` 引入的回归，`git log -S 'findProjectRoot(call.cwd' -- src/index.ts` 一笔可查）。
            // 现在改用**唯一出口** `office.workspaceRootFor`：只认"本次 cwd"或"本会话登记的 cwd"
            // **本身**（谁真的含 `.sdo/` 用谁），**绝不向上爬**、绝不猜别的项目。
            const workspaceRoot = ((): string => {
              try {
                return office.workspaceRootFor(call) ?? ''
              } catch {
                return ''
              }
            })()
            // **DEF-054 ②（fail-closed）**：归属不到工作区时**不许 fail-open** ——
            // 修前 `call.cwd === undefined` ⇒ `kind='unknown'` ⇒ **掩码与写范围两段一起跳过**。
            // 驾驶舱不受影响（它本就不受角色掩码约束、也没有卡的写范围）；**执行者子会话**一律拒绝。
            if (isChildSession && workspaceRoot === '') {
              return { kind: 'deny', reason: t('uiIndex.kWorkspaceUnknownExecutor') }
            }
            // **DEF-054 ③（第四批 §3.1：两道门必须同一个判据）**：`.sdo/`、认领、卡都扎根在**工作区根**，
            // 所以本次调用的有效 `cwd` 就是它 —— 本次 cwd 与会话 cwd 相同（含都拿不到）时原样传，零行为差；
            // 不同时（子目录会话、或本次调用没带 cwd 而工作区靠登记/凭据解析出来）才改写成工作区根。
            const rootCall = workspaceRoot === '' || workspaceRoot === call.cwd
              ? call
              : { ...call, cwd: workspaceRoot }
            const attributed = ((): RoleAttribution => {
              // **DEF-054 残余（第四批 §3.1）**：归属判定改为按**已解析的 `workspaceRoot`**，
              // 不再按 `call.cwd === undefined`。修前：工作区**能**解析（凭据/登记）但本次调用没带 cwd 时，
              // 第一道门放行、这一道却退回 `{kind:'unknown', role:'cockpit'}` ⇒ 掩码与写范围**两段一起跳过**
              // （同一会话、同一张卡，只差 `call.cwd` 就一拒一放）。现在两道门**同一个判据**：
              // 工作区能解析 ⇒ 照判（该 deny 的 deny）；解析不到时执行者已被上面那道门拒掉，
              // 走到这里的只可能是**非执行者（驾驶舱）** ⇒ 退回驾驶舱态（驾驶舱本就不受限，DoD ④）。
              // 台账基准：工作区根优先；解析不到时退回本次 cwd（老行为，只对非执行者可达）。
              const ledgerAt = workspaceRoot === '' ? call.cwd : workspaceRoot
              if (ledgerAt === undefined || ledgerAt === '') return { kind: 'unknown', role: 'cockpit' }
              // 缓存键用**工作区根**（台账所在处）：同一工作区里的不同子目录会话共享一份认领读数
              const cacheKey = `${ledgerAt}#${office.roleCacheVersion}`
              if (roleCacheKey !== cacheKey || Date.now() - roleCacheAt > ROLE_CACHE_TTL_MS) {
                roleCacheKey = cacheKey
                roleCacheAt = Date.now()
                roleClaims = claimsBySession(office.storeFor(ledgerAt), office.journalFor(ledgerAt))
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
                dispatchedRole: office.dispatchedRoleOf(rootCall),
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
            // **DEF-054 残余（第四批 §3.1）**：解析基准 = **会话 cwd**；本次调用没带 cwd 时用**已解析的
            // 工作区根**兜底（此时它是唯一可得的基准 —— 两者相同 ⇒ 退回"单基准"判定，与只给一个基准的
            // 调用方语义一致）。修前这里恒用 `call.cwd`：cwd 缺省 ⇒ 归一拿不到基准（绝对路径被洗成
            // `home/…` 这种**幽灵相对路径**）且闸门整段 fail-open。
            const sessionCwd = call.cwd === undefined || call.cwd === ''
              ? (workspaceRoot === '' ? undefined : workspaceRoot)
              : call.cwd
            const paths = rawPaths.map((path) => normalizeWorkspacePath(path, sessionCwd))

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
            // 只对认得出的角色生效（驾驶舱/未知 ⇒ fail-open）。
            //
            // **DEF-047 落点一（路径基准：两个，不是一个）**：闸门内部是**两个基准**，分工不同 ——
            //   · **会话工作目录**（`agent.session.header.cwd`，经 `injectionCall(resolveScopeCall)` 的既有
            //     取法，不新造口径）负责"**相对路径往哪解析**"；
            //   · **工作区根**（`office.workspaceRootFor`，DEF-054 起不再向上爬）负责"**写范围与公共面的前缀拿谁比**"
            //     —— 卡的 `writeScopes` 与 `disciplineAllowPaths` 都是相对工作区根声明的。
            // 会话 cwd 是子目录时二者不等：旧实现把一个字段同时当两者用 ⇒ 相对路径解析对了、前缀却比不中
            // ⇒ **在范围内的路径被误拒**（真机现象：绝对路径被拒、相对路径通过）。故分别传
            // `workspace`（会话 cwd）与 `workspaceRoot`（工作区根），**判定语义一处不改**。
            // 这里**必须**把**原始路径**交给它（`evaluateWriteScope` 内部自己做归一）—— 先归一一次再交会
            // "双重归一"：把已经是相对的路径按同一前缀**再剥一次**，于是一个不小心的路径被洗白/误判。
            //
            // `.sdo/` 与卡的查找同样按**工作区根**：会话工作目录是子目录时 `<子目录>/.sdo` 并不存在，
            // 用会话 cwd 去找会**查不到认领卡** ⇒ 在范围内的路径被判"没有活着的认领卡"。
            //
            // **DEF-047 落点二（命令类也要过闸）**：`bash` 没有路径参数，静态扫描出的写入目标
            // 与文件类路径**合并进同一次判定**（判定语义一处不改）。
            if (attributed.kind !== 'unknown') {
              // `workspaceRoot` / `rootCall` 已在上面（认领归属之前）算好并复用 —— 一个基准只解析一次
              const claimCard = attributed.kind === 'dispatched' && attributed.cardId !== undefined
                ? office.taskById(rootCall, attributed.cardId)
                : undefined
              const commandWrites = detectCommandWrites(commandTextOf(exec.arguments))
              const guardedPaths = [...rawPaths, ...commandWrites.targets]
              // **DEF-047 落点一**：把**两个基准分别**交给闸门（`exactOptionalPropertyTypes` ⇒ 不可用时
              // 整键省略，而不是塞 `undefined`）：
              //   · `workspace` = **会话 cwd**（`call.cwd`；本次调用没带 cwd 时用已解析的工作区根兜底，
              //     见上面的 `sessionCwd`）—— 相对路径按它解析；
              //   · `workspaceRoot` = **工作区根**（`office.workspaceRootFor`；DEF-054 起**不向上爬**）—— 卡的 `writeScopes`
              //     与公共面是相对工作区根声明的，前缀比对只能拿它比。
              // 判定**语义**一处不改（`evaluateWriteScope` 仍是唯一实现）：这里只是把两个本来就被挤在
              // 一个字段上的基准分开。两个基准都拿不到（工作区彻底不可知、且不是执行者）⇒ 不传 `workspace`
              // ⇒ 闸门 fail-open —— 那一态只对驾驶舱可达（执行者已被上面的 fail-closed 门拒掉）。
              const scopeDecision = evaluateWriteScope({
                role: attributed.role,
                tool,
                paths: guardedPaths,
                ...(sessionCwd === undefined ? {} : { workspace: sessionCwd }),
                ...(workspaceRoot === '' ? {} : { workspaceRoot }),
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
                    : scopeDecision.code === 'write-scope-outside-workspace'
                      ? 'uiIndex.kWriteScopeOutside'
                      : 'uiIndex.kWriteScopeViolation'
                // **DEF-047**：命令类命中时，把**形态名**（`>` / `tee` / `sed -i` / `python -c open(w)` …）
                // 追加进回执 —— 执行者要能一眼看出"是哪种写法被拦"，而不是只被告知"越界"。
                // 形态名是语言无关的算符/命令名（不为它新增中文文案键：本卡的写范围不含语言包）。
                const shapes = describeCommandWriteRisks(commandWrites.shapes)
                const base = fmt(key, {
                  p1: attributed.role,
                  p2: scopeDecision.detail,
                  p3: scopeDecision.scope.join(' / ') || t('uiDescribe.k169'),
                })
                return {
                  kind: 'deny',
                  reason: shapes === '' ? base : `${base} [shell write forms: ${shapes}]`,
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
