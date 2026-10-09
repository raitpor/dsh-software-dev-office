/**
 * 设计阶段的交互闭环 + 界面视图 + 可审查设计文档（增量 1：A + C + D）。
 *
 * 分工：
 *   · **问题**复用需求阶段的同一套存储与结构（`.sdo/questions/Q-*.yml`，`GrillQuestion`），
 *     只用 `origin === 'design'` 区分来源；门禁侧照旧用 `gates.ts` 的 `questions`/`issueClosure`
 *     —— **不另造一套问题机制**（规格 §1.2）。
 *   · **「含 UI」判定**是纯函数：只看需求真源（`kind: ui`）与项目级 `surfaces`，
 *     每次门禁检查现算，不缓存、不看模型自述、不按项目类型猜（规格 §2.1）。
 *   · **确认戳**是本模块独有的东西（`DesignConfirmation`）：用户 `confirm` 过哪些条目，
 *     以及 `docs/DESIGN.md` 是**派生视图**（绝不反向写台账）。
 *   · **确认戳绑定内容指纹**（F-19，见 `contentHash`）：内容改了旧确认即失效（`C-24`/`C-27` 判红
 *     并要求重新确认），与门禁签字按 journal 序号失效同源 —— 背书必须绑定它背书的那个版本。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { SdoStore } from '../infra/store.js'
import { loadPackagedYaml } from '../infra/data.js'
import { renderHeader, renderMeta } from '../infra/render.js'
import { pushShapeNote, recordListOf, recordOf, textListOf, textMapOf, textOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'

import { fmt, locale, t } from './i18n.js'
import { nextId } from '../infra/ids.js'
import type { Journal } from '../infra/journal.js'
import type {
  Adr,
  Contract,
  DesignConfirmation,
  DesignElement,
  DesignView,
  Dimension,
  GrillQuestion,
  Requirement,
  RiskItem,
  SdoProject,
  Severity,
  UiBreakpoint,
  UiScreen,
  UiStyleSource,
  UiView,
  ViewKind,
} from '../types.js'
import { METHOD_IDS, UI_STACK_DIRECTIONS, UI_STYLE_SOURCES } from '../types.js'
import type { MethodArtifact, MethodArtifactKind, MethodId, UiStackDirection } from '../types.js'
import { readView, VIEW_KINDS } from './architecture.js'
import { applicabilityLines, readApplicability } from './applicability.js'
import { listAdrs } from './adr.js'
import { derivedConfidence } from './architecture.js'
import { listContracts } from './contracts.js'
import { readQuestion } from './grill.js'
import { isEffectivelyOpen } from './dor.js'
import {
  METHOD_TARGET,
  artifactKindLabel,
  listMethodArtifacts,
  methodLabel,
  methodProducts,
  methodQuestion,
  methodSelection,
  refreshMethodSnapshot,
} from './method.js'
import { report as traceReport } from './trace.js'
import {
  plantUmlSkeleton,
  renderWireframes,
  screenWireframe,
  type WireframeStrings,
} from './wireframe.js'

/** 方法论选择题的目标标记与读取（实现落在 `method.ts`；这里再导出，保持既有调用方不变）。 */
export { METHOD_TARGET, methodQuestion }

// —————————————————————— 含 UI 判定（唯一真源 = 需求） ——————————————————————

export interface UiDecision {
  /** 判定：本项目是否含界面 */
  hasUi: boolean
  /** 判定依据（回执与 DESIGN.md 的 §5 都要如实写出来） */
  reason: string
  /** 触发判定的需求 id（需求侧真源） */
  requirementIds: string[]
  /** 触发判定的项目级界面面（项目侧真源） */
  surfaces: string[]
}

/** 项目级界面面里"算界面"的取值（§2.1）。 */
export const UI_SURFACES = ['web', 'desktop', 'mobile'] as const

/**
 * 「含 UI」判定：**每次现算**，不缓存。
 *
 * ```text
 * 含UI := 任一需求条目声明了界面/页面面（kind: ui）
 *      OR 项目级 surfaces 声明含 web/desktop/mobile
 * ```
 *
 * 需求后期新增 UI 需求 → 判定立刻翻真，无需人工开关（§2.1）。
 */
export function uiDecision(project: SdoProject | undefined, requirements: Requirement[]): UiDecision {
  const requirementIds = requirements.filter((requirement) => requirement.kind === 'ui').map((requirement) => requirement.id)
  const surfaces = (project?.surfaces ?? []).filter((surface) =>
    (UI_SURFACES as readonly string[]).includes(surface),
  )
  const hasUi = requirementIds.length > 0 || surfaces.length > 0
  const reason = hasUi
    ? t('uiDesign.uiReasonYes')
        .replaceAll('{reqs}', requirementIds.length === 0 ? t('uiDesign.uiNoReqs') : requirementIds.join(' '))
        .replaceAll('{surfaces}', surfaces.length === 0 ? t('uiDesign.uiNoSurfaces') : surfaces.join(' '))
    : t('uiDesign.uiReasonNo')
  return { hasUi, reason, requirementIds, surfaces }
}

// —————————————————————— 问题存储（复用 grill 的格式） ——————————————————————

/** 设计问题的目标不是需求，而是这条伪需求 id 或界面条目 id。 */
export const UI_TARGET = 'design:ui'

/**
 * 全部设计问题（按 id 字典序）。
 *
 * **§7.2 时机迁移**：方法论选择题现在由**需求阶段**提出（`origin === 'requirements'`），
 * 但它仍然是"设计阶段要用的那个决定"，必须出现在设计回执 / `docs/DESIGN.md` /
 * `design.no-open-questions` 的账本里 —— 否则迁移会让它从设计侧彻底消失。
 * 因此这里同时收 `design` 与 `requirements` 两种来源。
 */
export function listDesignQuestions(store: SdoStore): GrillQuestion[] {
  return listQuestionIdsSafe(store)
    .map((id) => readQuestion(store, id))
    .filter(
      (question): question is GrillQuestion =>
        question !== undefined && (question.origin === 'design' || question.origin === 'requirements'),
    )
}

function listQuestionIdsSafe(store: SdoStore): string[] {
  return store
    .listNames('questions')
    .filter((name) => /^Q-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

export function readDesignQuestion(store: SdoStore, id: string): GrillQuestion | undefined {
  const question = readQuestion(store, id)
  // 与 `listDesignQuestions` 同口径：需求阶段提出的规划级问题（方法论选择题）也算"设计问题"
  return question !== undefined && (question.origin === 'design' || question.origin === 'requirements')
    ? question
    : undefined
}

export function writeDesignQuestion(store: SdoStore, question: GrillQuestion): void {
  store.writeYaml(['questions', `${question.id}.yml`], { question })
}

/** 未决设计问题（`open`，或未获用户授权的 `assumed`）。 */
export function openDesignQuestions(store: SdoStore): GrillQuestion[] {
  return listDesignQuestions(store).filter((question) => isEffectivelyOpenDesign(question))
}

/** 本地别名：设计侧的"未决"一律走 `dor.ts` 那一份口径（单一实现，不再各写一份）。 */
function isOpen(question: GrillQuestion): boolean {
  return isEffectivelyOpen(question)
}

/**
 * 与 `dor.ts` 的 `isEffectivelyOpen` 同一口径（未获用户授权的"假设"仍算未决），
 * 但这里**只服务设计问题**：门禁 G2 与 G3 各管自己的问题账本，判定不互相污染。
 *
 * **M6（本报告）**：两份实现合并成一份 —— 旧实现各写各的，需求侧评审曾指出
 * "两个门禁对同一份数据用两套口径"的风险；现在设计侧直接复用需求侧那份。
 */
export function isEffectivelyOpenDesign(question: GrillQuestion): boolean {
  return isEffectivelyOpen(question)
}

// —————————————————————— 缺口检测器 ——————————————————————

/** 一个缺口模板 → 一个问题。 */
export interface DesignGap {
  /** 稳定标识（写进 why 的 `#key`，用于判重） */
  key: string
  text: string
  why: string
  consequence: string
  options: { label: string; cost: string }[]
  recommendation: string
  /** 推荐理由（**必须带**，见规格 §1.2"我的建议（含推荐理由）"） */
  recommendationWhy: string
  /** 推荐理由是否**来自模型**（false = 插件兜底，回执必须标注，F-6） */
  recommendationFromModel: boolean
  /** 已有定案的 ADR id（F-5）：有值 = 本题降级为"仅确认"，不是开放题 */
  decidedBy?: string | undefined
  dimension: Dimension
  severity: Severity
  target: string
}

/** 设计问题的严重度：方法选择是全局阻塞（P0），其余是设计期阻塞（P1）。 */
function gap(
  key: string,
  textKey: string,
  whyKey: string,
  consequenceKey: string,
  options: [string, string][],
  recommendationKey: string,
  recommendationWhyKey: string,
  dimension: Dimension,
  target: string,
  severity: Severity = 'P1',
  recommendationWhyKeyFromModel = false,
): DesignGap {
  return {
    key,
    text: t(textKey),
    why: t(whyKey),
    consequence: t(consequenceKey),
    options: options.map(([label, cost]) => ({ label: t(label), cost: t(cost) })),
    recommendation: t(recommendationKey),
    recommendationWhy: t(recommendationWhyKey),
    recommendationFromModel: recommendationWhyKeyFromModel,
    dimension,
    severity,
    target,
  }
}

/**
 * **方法论选择题**（唯一的定义处）。
 *
 * **2026-09-30 时机迁移（§6 决策 1 / §7.2）**：这个问题属于**需求/规划决策**，
 * 却在架构阶段才问 → 现在由**需求阶段**提出（`sdo_requirement action=design-questions`，
 * 复用**同一个**问题账本 `Q-*.yml`，`origin` 记为 `requirements`）。
 * `designGaps()` **不再**重复造这道题（同一账本里只会有一道，避免"两套问答"）。
 *
 * 选项**固定**为 structured / oo / evolutionary / porting / none（可多选 = 取并集）；
 * 标签里带规范标识符，答案才能被 `parseMethodChoice` 机械解析（不许"不选就蒙过去"）。
 */
export function methodGap(
  recommendation?: { method?: string | undefined; rationale?: string | undefined } | undefined,
): DesignGap {
  const recommended = recommendation?.method
  return {
    key: 'method',
    text: t('uiDesign.qMethodText'),
    why: `#method ${t('uiDesign.qMethodWhy')}`,
    consequence: t('uiDesign.qMethodConsequence'),
    options: [
      { label: t('uiDesign.methodStructured'), cost: t('uiDesign.methodStructuredCost') },
      { label: t('uiDesign.methodOo'), cost: t('uiDesign.methodOoCost') },
      { label: t('uiDesign.methodAgile'), cost: t('uiDesign.methodAgileCost') },
      { label: t('uiDesign.methodPorting'), cost: t('uiDesign.methodPortingCost') },
      { label: t('uiDesign.methodNoneOpt'), cost: t('uiDesign.methodNoneCost') },
    ],
    recommendation: recommended === undefined || recommended.trim() === ''
      ? t('uiDesign.methodRecommendDefault')
      : recommended.trim(),
    // F-6：模型没给理由时，回执必须**显式标注**这是插件的兜底建议（`recommendationFromModel=false`），
    // 而不是把兜底理由冒充成"基于需求的分析"——兜底建议甚至可能与项目相反（照它填会写反设计）。
    recommendationWhy: recommendation?.rationale !== undefined && recommendation.rationale.trim() !== ''
      ? recommendation.rationale.trim()
      : t('uiDesign.methodRecommendWhy'),
    recommendationFromModel: recommendation?.rationale !== undefined && recommendation.rationale.trim() !== '',
    dimension: 'goal',
    // **§7.2 时机迁移后的严重度口径**：这道题在需求阶段提出，但**不阻塞 G2 基线**
    // （否则"需求还没收集完就要先定设计方法"会把规划决策塞进需求门禁）。
    // 它仍然阻塞 G3（`design.method-selected` 未回答即红），逃不掉。
    severity: 'P1',
    target: METHOD_TARGET,
  }
}

/**
 * 缺口 key → **既有决策**（ADR）的识别关键词（F-5）。
 *
 * 为什么要比：`grill` 以前不看 ADR，把早已定案的题（形态/存储/一致性/并发…）重新当开放题问，
 * 19 题里 4 题是重复确认 —— 用户会把问答当例行公事，真正该拍板的新问题被淹没。
 *
 * 关键词是**随包数据**（`src/data/decided-hints.yml`，中英写法都收）：它是匹配数据而非
 * 用户可见文案，放语言包里会随语言切换而丢掉另一种语言的 ADR 匹配能力。
 * 只在 `title`/`context`/`decision` 里找，不扫备选与后果，避免把"考虑过但否决了"当成已定案。
 */
function decidedHints(): Record<string, string[]> {
  return loadPackagedYaml<{ hints: Record<string, string[]> }>('src/data/decided-hints.yml').hints
}

/**
 * 这题是否在既有 ADR 里已有定案（F-5）。返回那条 ADR 的 id。
 *
 * 只认**仍然有效**的 ADR（proposed / accepted）；被否决或被取代的不算"已定案"。
 */
export function decidedByAdr(adrs: Adr[], key: string): string | undefined {
  const hints = decidedHints()[key]
  if (hints === undefined) return undefined
  for (const adr of adrs) {
    if (adr.status === 'rejected' || adr.status === 'superseded') continue
    const haystack = `${adr.title} ${adr.context} ${adr.decision}`.toLowerCase()
    if (hints.some((hint) => haystack.includes(hint.toLowerCase()))) return adr.id
  }
  return undefined
}

/**
 * 缺口检测器：按「项目事实 → 缺失项 → 生成问题」机械推导（§1.2）。
 *
 * `recommendation`：模型基于需求给出的**方法论推荐**（§1.3 第 3 条要求必须附带推荐与理由）；
 * 未给出时用确定性默认推荐（推荐从来不是编造的要求，而是可被用户覆盖的建议）。
 *
 * ⚠️ **方法选择题不在这里生成**（§7.2 时机迁移）：它由需求阶段经
 * `askDesignQuestions()` 提出。设计阶段若账本里还没有它，`design.no-open-questions`
 * 会因"一条设计问题都没有"判红，模型据此回去补问 —— 不需要这里再补一道重复的题。
 */
/**
 * **D-19 ①（sdo-test-new 2026-10-09，用户裁定"按 1 做"）**：设计问卷的**适用性裁剪表**。
 *
 * 病因（真机）：`grill` 一次抛 13 问，其中 10 问对一个"读两个夹具、打一份计数"的 trivial 增量毫无关系；
 * 而裁剪档只省掉了 G1/G4/G6 三道门，13 次问答原样留下 —— 省的那头小、留的这头大。
 *
 * 口径（**不新增真源**）：
 *   · `view` = 该问题归属的视图（与 `design:<view>` 的 target 后缀一致）；`view === undefined` 表示
 *     "与视图无关、总是要问"（形态 / 外部依赖 / 错误口径 / 技术债）；
 *   · 有**适用性声明**时：只问"总是要问的" + `viewsPresent` 里声明过的视图；
 *     未声明相关视图的问题**跳过**，并在回执里点名"跳过了哪些、因为没声明哪个视图"；
 *   · `trivial` 档再收一层：只留 `core: true` 的那几问（形态 / 错误口径 / 技术债）。
 *
 * ⚠️ **表必须与产出的题双向对齐**（`test/m83.test.ts` 的 M83-10 机械核对）：本表登记的是
 * "这道题什么时候问"；key 写错会让这道题**悄悄落到"表里没有 ⇒ 照旧要问"的兜底分支上** ——
 * 首次实现就把技术债登记成 `tech-debt`，而产出用的 key 是 `techdebt`，那一行于是成了**死条目**
 * （行为碰巧一样，表却在说谎；日后想给它挂视图就会静默失效）。
 */
export const GRILL_GAP_SCOPE: Record<string, { view?: ViewKind | undefined; core: boolean }> = {
  form: { core: true },
  deployment: { view: 'deployment', core: false },
  external: { core: true },
  store: { view: 'data', core: false },
  consistency: { view: 'data', core: false },
  retention: { view: 'data', core: false },
  concurrency: { view: 'runtime', core: false },
  performance: { view: 'runtime', core: false },
  failure: { view: 'runtime', core: false },
  errors: { core: true },
  observability: { view: 'deployment', core: false },
  evolution: { view: 'component', core: false },
  // 实际产出的 key 就是 `techdebt`（无连字符，见下方 `gap('techdebt', …)`）
  techdebt: { core: true },
  // 界面五问：问不问由 `uiDecision().hasUi` 决定（判定为假时**一题都不生成**），与适用性声明无关
  // ⇒ 在"要问"的前提下它们总是要问，故 core。
  'ui-style': { core: true },
  'ui-columns': { core: true },
  'ui-layout': { core: true },
  'ui-breakpoint': { core: true },
  'ui-a11y': { core: true },
}

export function designGaps(
  store: SdoStore,
  project: SdoProject | undefined,
  requirements: Requirement[],
  recommendation?: { method?: string | undefined; rationale?: string | undefined } | undefined,
  /** **D-19 ①**：把"按适用性/裁剪档跳过了哪些问题、为什么"交回回执（不静默） */
  skippedOut?: { key: string; reason: 'view-not-declared' | 'trivial-core-only' }[] | undefined,
): DesignGap[] {
  void recommendation
  const decision = uiDecision(project, requirements)
  const gaps: DesignGap[] = []

  gaps.push(
    gap(
      'form',
      'uiDesign.qFormText',
      'uiDesign.qFormWhy',
      'uiDesign.qFormConsequence',
      [
        ['uiDesign.formMonolith', 'uiDesign.formMonolithCost'],
        ['uiDesign.formLayered', 'uiDesign.formLayeredCost'],
        ['uiDesign.formMicro', 'uiDesign.formMicroCost'],
      ],
      'uiDesign.formRecommend',
      'uiDesign.formRecommendWhy',
      'constraint',
      'design:form',
    ),
    gap(
      'deployment',
      'uiDesign.qDeployText',
      'uiDesign.qDeployWhy',
      'uiDesign.qDeployConsequence',
      [
        ['uiDesign.deploySingle', 'uiDesign.deploySingleCost'],
        ['uiDesign.deployContainer', 'uiDesign.deployContainerCost'],
        ['uiDesign.deployManaged', 'uiDesign.deployManagedCost'],
      ],
      'uiDesign.deployRecommend',
      'uiDesign.deployRecommendWhy',
      'constraint',
      'design:deployment',
    ),
    gap(
      'external',
      'uiDesign.qExternalText',
      'uiDesign.qExternalWhy',
      'uiDesign.qExternalConsequence',
      [
        ['uiDesign.externalMin', 'uiDesign.externalMinCost'],
        ['uiDesign.externalReuse', 'uiDesign.externalReuseCost'],
        ['uiDesign.externalBuild', 'uiDesign.externalBuildCost'],
      ],
      'uiDesign.externalRecommend',
      'uiDesign.externalRecommendWhy',
      'constraint',
      'design:external',
    ),
    gap(
      'store',
      'uiDesign.qStoreText',
      'uiDesign.qStoreWhy',
      'uiDesign.qStoreConsequence',
      [
        ['uiDesign.storeRelational', 'uiDesign.storeRelationalCost'],
        ['uiDesign.storeDocument', 'uiDesign.storeDocumentCost'],
        ['uiDesign.storeFile', 'uiDesign.storeFileCost'],
      ],
      'uiDesign.storeRecommend',
      'uiDesign.storeRecommendWhy',
      'data',
      'design:store',
    ),
    gap(
      'consistency',
      'uiDesign.qConsistencyText',
      'uiDesign.qConsistencyWhy',
      'uiDesign.qConsistencyConsequence',
      [
        ['uiDesign.consistencyStrong', 'uiDesign.consistencyStrongCost'],
        ['uiDesign.consistencyEventual', 'uiDesign.consistencyEventualCost'],
        ['uiDesign.consistencyNone', 'uiDesign.consistencyNoneCost'],
      ],
      'uiDesign.consistencyRecommend',
      'uiDesign.consistencyRecommendWhy',
      'data',
      'design:consistency',
    ),
    gap(
      'retention',
      'uiDesign.qRetentionText',
      'uiDesign.qRetentionWhy',
      'uiDesign.qRetentionConsequence',
      [
        ['uiDesign.retentionKeep', 'uiDesign.retentionKeepCost'],
        ['uiDesign.retentionArchive', 'uiDesign.retentionArchiveCost'],
        ['uiDesign.retentionPurge', 'uiDesign.retentionPurgeCost'],
      ],
      'uiDesign.retentionRecommend',
      'uiDesign.retentionRecommendWhy',
      'data',
      'design:retention',
    ),
    gap(
      'concurrency',
      'uiDesign.qConcurrencyText',
      'uiDesign.qConcurrencyWhy',
      'uiDesign.qConcurrencyConsequence',
      [
        ['uiDesign.concurrencySimple', 'uiDesign.concurrencySimpleCost'],
        ['uiDesign.concurrencyPerUser', 'uiDesign.concurrencyPerUserCost'],
        ['uiDesign.concurrencyPool', 'uiDesign.concurrencyPoolCost'],
      ],
      'uiDesign.concurrencyRecommend',
      'uiDesign.concurrencyRecommendWhy',
      'constraint',
      'design:concurrency',
    ),
    gap(
      'performance',
      'uiDesign.qPerfText',
      'uiDesign.qPerfWhy',
      'uiDesign.qPerfConsequence',
      [
        ['uiDesign.perfDefault', 'uiDesign.perfDefaultCost'],
        ['uiDesign.perfStrict', 'uiDesign.perfStrictCost'],
        ['uiDesign.perfLater', 'uiDesign.perfLaterCost'],
      ],
      'uiDesign.perfRecommend',
      'uiDesign.perfRecommendWhy',
      'interface',
      'design:performance',
    ),
    gap(
      'failure',
      'uiDesign.qFailureText',
      'uiDesign.qFailureWhy',
      'uiDesign.qFailureConsequence',
      [
        ['uiDesign.failureIdempotent', 'uiDesign.failureIdempotentCost'],
        ['uiDesign.failureRetry', 'uiDesign.failureRetryCost'],
        ['uiDesign.failureManual', 'uiDesign.failureManualCost'],
      ],
      'uiDesign.failureRecommend',
      'uiDesign.failureRecommendWhy',
      'boundary',
      'design:failure',
    ),
    gap(
      'errors',
      'uiDesign.qErrorText',
      'uiDesign.qErrorWhy',
      'uiDesign.qErrorConsequence',
      [
        ['uiDesign.errorFailFast', 'uiDesign.errorFailFastCost'],
        ['uiDesign.errorTolerant', 'uiDesign.errorTolerantCost'],
        ['uiDesign.errorSilent', 'uiDesign.errorSilentCost'],
      ],
      'uiDesign.errorRecommend',
      'uiDesign.errorRecommendWhy',
      'boundary',
      'design:errors',
    ),
    gap(
      'observability',
      'uiDesign.qObserveText',
      'uiDesign.qObserveWhy',
      'uiDesign.qObserveConsequence',
      [
        ['uiDesign.observeLog', 'uiDesign.observeLogCost'],
        ['uiDesign.observeMetrics', 'uiDesign.observeMetricsCost'],
        ['uiDesign.observeFull', 'uiDesign.observeFullCost'],
      ],
      'uiDesign.observeRecommend',
      'uiDesign.observeRecommendWhy',
      'constraint',
      'design:observability',
    ),
    gap(
      'evolution',
      'uiDesign.qEvolveText',
      'uiDesign.qEvolveWhy',
      'uiDesign.qEvolveConsequence',
      [
        ['uiDesign.evolveNoBreak', 'uiDesign.evolveNoBreakCost'],
        ['uiDesign.evolveWindow', 'uiDesign.evolveWindowCost'],
        ['uiDesign.evolveFree', 'uiDesign.evolveFreeCost'],
      ],
      'uiDesign.evolveRecommend',
      'uiDesign.evolveRecommendWhy',
      'constraint',
      'design:evolution',
    ),
    gap(
      'techdebt',
      'uiDesign.qDebtText',
      'uiDesign.qDebtWhy',
      'uiDesign.qDebtConsequence',
      [
        ['uiDesign.debtZero', 'uiDesign.debtZeroCost'],
        ['uiDesign.debtTracked', 'uiDesign.debtTrackedCost'],
        ['uiDesign.debtIgnore', 'uiDesign.debtIgnoreCost'],
      ],
      'uiDesign.debtRecommend',
      'uiDesign.debtRecommendWhy',
      'constraint',
      'design:tech-debt',
    ),
  )

  // ② 界面维度：**仅当判定为真**（§1.2 / §2.1）——判定为假时一个问题都不生成。
  if (decision.hasUi) {
    gaps.push(
      gap(
        'ui-style',
        'uiDesign.qUiStyleText',
        'uiDesign.qUiStyleWhy',
        'uiDesign.qUiStyleConsequence',
        [
          ['uiDesign.uiStyleFollowHost', 'uiDesign.uiStyleFollowHostCost'],
          ['uiDesign.uiStyleMinimal', 'uiDesign.uiStyleMinimalCost'],
          ['uiDesign.uiStyleEnterprise', 'uiDesign.uiStyleEnterpriseCost'],
        ],
        'uiDesign.uiStyleRecommend',
        'uiDesign.uiStyleRecommendWhy',
        'user',
        'design:ui-style',
      ),
      gap(
        'ui-columns',
        'uiDesign.qUiColumnsText',
        'uiDesign.qUiColumnsWhy',
        'uiDesign.qUiColumnsConsequence',
        [
          ['uiDesign.uiColumnsMinimal', 'uiDesign.uiColumnsMinimalCost'],
          ['uiDesign.uiColumnsStandard', 'uiDesign.uiColumnsStandardCost'],
          ['uiDesign.uiColumnsRich', 'uiDesign.uiColumnsRichCost'],
        ],
        'uiDesign.uiColumnsRecommend',
        'uiDesign.uiColumnsRecommendWhy',
        'scenario',
        'design:ui-columns',
      ),
      gap(
        'ui-layout',
        'uiDesign.qUiLayoutText',
        'uiDesign.qUiLayoutWhy',
        'uiDesign.qUiLayoutConsequence',
        [
          ['uiDesign.uiLayoutList', 'uiDesign.uiLayoutListCost'],
          ['uiDesign.uiLayoutTable', 'uiDesign.uiLayoutTableCost'],
          ['uiDesign.uiLayoutSplit', 'uiDesign.uiLayoutSplitCost'],
        ],
        'uiDesign.uiLayoutRecommend',
        'uiDesign.uiLayoutRecommendWhy',
        'scenario',
        'design:ui-layout',
      ),
      gap(
        'ui-breakpoint',
        'uiDesign.qUiBreakpointText',
        'uiDesign.qUiBreakpointWhy',
        'uiDesign.qUiBreakpointConsequence',
        [
          ['uiDesign.uiBreakpointDesktop', 'uiDesign.uiBreakpointDesktopCost'],
          ['uiDesign.uiBreakpointResponsive', 'uiDesign.uiBreakpointResponsiveCost'],
          ['uiDesign.uiBreakpointMobile', 'uiDesign.uiBreakpointMobileCost'],
        ],
        'uiDesign.uiBreakpointRecommend',
        'uiDesign.uiBreakpointRecommendWhy',
        'interface',
        'design:ui-breakpoint',
      ),
      gap(
        'ui-a11y',
        'uiDesign.qUiA11yText',
        'uiDesign.qUiA11yWhy',
        'uiDesign.qUiA11yConsequence',
        [
          ['uiDesign.uiA11yBasic', 'uiDesign.uiA11yBasicCost'],
          ['uiDesign.uiA11yStrict', 'uiDesign.uiA11yStrictCost'],
          ['uiDesign.uiA11yLater', 'uiDesign.uiA11yLaterCost'],
        ],
        'uiDesign.uiA11yRecommend',
        'uiDesign.uiA11yRecommendWhy',
        'constraint',
        'design:ui-a11y',
      ),
    )
  }

  // ③ 已经问过（或已回答）的缺口不再问 —— 复用同一套判重口径（按 `#key`）。
  const asked = new Set(
    listDesignQuestions(store)
      .filter((question) => question.status !== 'obsolete')
      .map((question) => templateKeyOf(question))
      .filter((key): key is string => key !== undefined),
  )
  // ④ F-5：与**既有 ADR** 比对 —— 已定案的题仍然要问（用户可能想改），但降级为"仅确认"：
  // 题面与回执都标出「已有决策：ADR-xxx」，不再假装这是一个新决策。
  const adrs = listAdrs(store)
  // **D-19 ①**：按**适用性声明 + 裁剪档**收窄问卷（不新增真源：声明本来就存在 `design/applicability.yml`）
  const declaration = readApplicability(store)
  const declared = new Set<string>(declaration?.viewsPresent ?? [])
  const trivial = project?.tailoring?.scale === 'trivial'
  const kept: DesignGap[] = []
  for (const item of gaps) {
    const scope = GRILL_GAP_SCOPE[item.key]
    // 表里没有的题（新增题、方法题等）**照旧要问** —— 宁可多问，不许因为"忘了登记"而静默漏问
    if (scope === undefined) {
      kept.push(item)
      continue
    }
    if (trivial && !scope.core) {
      skippedOut?.push({ key: item.key, reason: 'trivial-core-only' })
      continue
    }
    // 有声明时：未声明相关视图 ⇒ 跳过（没有声明就照旧全问 —— 声明缺失不该变成"问卷消失"）
    if (declaration !== undefined && scope.view !== undefined && !declared.has(scope.view)) {
      skippedOut?.push({ key: item.key, reason: 'view-not-declared' })
      continue
    }
    kept.push(item)
  }
  return kept
    .filter((item) => !asked.has(item.key))
    .map((item) => {
      const decidedBy = decidedByAdr(adrs, item.key)
      return decidedBy === undefined ? item : { ...item, decidedBy }
    })
}

/** 从 `why` 里取出模板 key（`#method …` → `method`）。 */
export function templateKeyOf(question: GrillQuestion): string | undefined {
  const match = /#([a-z0-9-]+)/u.exec(question.why)
  return match?.[1]
}

// —————————————————————— 生成问题（grill） ——————————————————————

export interface GrillDesignInput {
  /** 模型给出的方法论推荐（§1.3 要求"必须附带模型推荐与理由"） */
  recommendation?: { method?: string | undefined; rationale?: string | undefined } | undefined
  /** 本次最多新增几个问题（默认不设上限：节奏是"一次给全 + 一次性批注"） */
  limit?: number | undefined
  by?: string | undefined
}

export interface GrillDesignResult {
  created: GrillQuestion[]
  open: GrillQuestion[]
  answered: GrillQuestion[]
  /** 本轮新增（差异的"本轮变化"） */
  added: string[]
  /** 上一轮未决、这一轮仍未决 */
  stillOpen: string[]
  /**
   * **D-19 ①（sdo-test-new 2026-10-09）**：被**适用性声明 / 裁剪档**跳过的问题与原因
   * （`view-not-declared` = 没声明相关视图；`trivial-core-only` = trivial 档只问核心几问）。
   * 跳过必须**可见** —— 否则"问卷没问"与"问卷问了但没人答"在回执上分不出来。
   */
  skipped: { key: string; reason: 'view-not-declared' | 'trivial-core-only' }[]
  /** 这一轮里由你回答掉的 */
  resolved: string[]
  ui: UiDecision
}

/**
 * **需求阶段**提出设计阶段要用的那几道"规划级"问题（目前只有方法论选择题）。
 *
 * 为什么要有这个入口（§6 决策 1 / §7.2）：方法论选择是**需求/规划决策**，
 * 原有的 `METHOD_TARGET` 挂在设计阶段提问 → 阶段错位。现在改由需求阶段提出，
 * **复用同一个问题账本**（`.sdo/questions/Q-*.yml`），只是 `origin` 记为 `requirements`；
 * 判定侧（`methodSelection`）只看 `targets`、不看 origin，所以门禁行为不变。
 *
 * 幂等：账本里已有该题（无论 origin）就原样返回，不重复造题。
 */
export function askDesignQuestions(
  store: SdoStore,
  journal: Journal,
  project: SdoProject | undefined,
  requirements: Requirement[],
  input: { recommendation?: { method?: string | undefined; rationale?: string | undefined } | undefined; by?: string | undefined } = {},
): { question: GrillQuestion; created: boolean } | undefined {
  if (project === undefined || requirements.length === 0) return undefined
  const existing = methodQuestion(store)
  if (existing !== undefined) return { question: existing, created: false }
  const gap = methodGap(input.recommendation)
  // **编号必须对全部问题唯一**（`listQuestionIdsSafe` 列的是账本里的全部 Q-*）：
  // 只按"设计问题"取下一个号会与红队/库题**撞号**（实测：撞号后同一 id 读到的是别人的题，
  // 门禁读到的答案自然对不上）。
  const id = nextId('Q', listQuestionIdsSafe(store), 4)
  const askedAt = new Date().toISOString()
  const question: GrillQuestion = {
    id,
    text: gap.text,
    targets: [gap.target],
    dimension: gap.dimension,
    severity: gap.severity,
    why: gap.why.includes(`#${gap.key}`) ? gap.why : `#${gap.key} ${gap.why}`,
    consequenceIfUnasked: gap.consequence,
    options: gap.options,
    defaultRecommendation: gap.recommendation,
    recommendationRationale: gap.recommendationWhy,
    recommendationFromModel: gap.recommendationFromModel,
    ...(gap.decidedBy === undefined ? {} : { decidedBy: gap.decidedBy }),
    answer: null,
    status: 'open',
    askedAt,
    answeredBy: null,
    // **需求阶段**提出的规划级问题
    origin: 'requirements',
  }
  writeDesignQuestion(store, question)
  journal.append('design/grill', {
    ids: [id],
    targets: [gap.target],
    phase: 'requirements',
    by: input.by ?? 'sdo',
  })
  journal.append('design/rendered', {
    kind: 'method-recommendation',
    question: id,
    recommendation: gap.recommendation,
    rationale: input.recommendation?.rationale ?? '',
  })
  return { question, created: true }
}

/**
 * 生成设计问题并落盘（`sdo_design action=grill`）。
 *
 * 返回体给界面层用来拼"① 完整设计草案 + ② 问题清单 + ③ 增量差异"（§1.4）。
 *
 * **§7.2 时机迁移的兼容动作**：若账本里还没有方法论选择题（需求阶段没提），
 * 本函数会把它**补提**出来（`origin: 'requirements'`）并计入 `created` ——
 * 这样"先设计后补问"的老路径不会因为迁移而出现"本题永远问不出来"的死角。
 */
export function grillDesign(
  store: SdoStore,
  journal: Journal,
  project: SdoProject | undefined,
  requirements: Requirement[],
  input: GrillDesignInput = {},
): GrillDesignResult {
  const before = listDesignQuestions(store)
  const openBefore = new Set(before.filter((question) => isOpen(question)).map((question) => question.id))
  const skipped: { key: string; reason: 'view-not-declared' | 'trivial-core-only' }[] = []
  const gaps = designGaps(store, project, requirements, input.recommendation, skipped)
  const limited = input.limit === undefined ? gaps : gaps.slice(0, Math.max(1, input.limit))

  // **§7.2 兼容**：方法论选择题本应在需求阶段提出；若还没有，这里补提（不重复造题）。
  const method = askDesignQuestions(store, journal, project, requirements, {
    ...(input.recommendation === undefined ? {} : { recommendation: input.recommendation }),
    ...(input.by === undefined ? {} : { by: input.by }),
  })
  // ⚠️ `usedIds` 必须在**补提之后**再取：补提会往账本里写一个新的 `Q-*`，
  // 用补提前的快照编号会让下面第一个缺口与它**撞号**（实测：设计缺口把方法题的文件覆盖掉，
  // 于是方法题"凭空消失"、门禁读到的答案属于另一道题）。
  const usedIds = listQuestionIdsSafe(store)
  const askedAt = new Date().toISOString()
  const created: GrillQuestion[] = []
  if (method?.created === true) created.push(method.question)
  for (const item of limited) {
    const id = nextId('Q', usedIds, 4)
    usedIds.push(id)
    const question: GrillQuestion = {
      id,
      text: item.text,
      targets: [item.target],
      dimension: item.dimension,
      severity: item.severity,
      why: item.why.includes(`#${item.key}`) ? item.why : `#${item.key} ${item.why}`,
      consequenceIfUnasked: item.consequence,
      options: item.options,
      defaultRecommendation: item.recommendation,
      recommendationRationale: item.recommendationWhy,
      recommendationFromModel: item.recommendationFromModel,
      ...(item.decidedBy === undefined ? {} : { decidedBy: item.decidedBy }),
      answer: null,
      status: 'open',
      askedAt,
      answeredBy: null,
      origin: 'design',
    }
    writeDesignQuestion(store, question)
    created.push(question)
  }

  const after = listDesignQuestions(store)
  const open = after.filter((question) => isOpen(question))
  const resolved = [...openBefore].filter((id) => !open.some((question) => question.id === id))
  const added = created.map((question) => question.id)

  if (created.length > 0) {
    journal.append('design/grill', {
      ids: added,
      targets: [...new Set(created.map((question) => question.targets[0] ?? ''))],
      by: input.by ?? 'sdo',
    })
  }

  // 推荐理由也要留在真源里（增量 2 的方法包要读它）
  // 推荐理由也要留在真源里（增量 2 的方法包要读它）。
  // ⚠️ 只有"本题是**本函数**刚造出来的"才补一条 recommendation 事件 ——
  // `askDesignQuestions()` 造题时已经写过一条，避免同一决定留两条重复真源。
  const methodCreated = created.find(
    (question) => question.targets.includes(METHOD_TARGET) && method?.created === true && question.id === method.question.id,
  )
  if (methodCreated !== undefined) {
    journal.append('design/rendered', {
      kind: 'method-recommendation',
      question: methodCreated.id,
      recommendation: methodCreated.defaultRecommendation,
      rationale: input.recommendation?.rationale ?? '',
    })
  }

  return {
    created,
    open,
    answered: after.filter((question) => !isOpen(question)),
    added,
    // **D-19 ①**：跳过的问题与原因（回执要点名；空数组表示没跳过）
    skipped,
    stillOpen: open.map((question) => question.id),
    resolved,
    ui: uiDecision(project, requirements),
  }
}

/** 回答一个设计问题（`sdo_design action=answer`）。 */
export function answerDesign(
  store: SdoStore,
  journal: Journal,
  id: string,
  choice: string,
  note?: string | undefined,
  by?: string | undefined,
): GrillQuestion | undefined {
  const question = readDesignQuestion(store, id)
  if (question === undefined) return undefined

  // 选项既接受下标（`0` / `1`…），也接受选项原文；都不匹配时按"自定义"记录原文。
  const normalized = choice.trim()
  const index = /^\d+$/u.test(normalized) ? Number(normalized) : question.options.findIndex((option) => option.label === normalized)
  const picked = index >= 0 && index < question.options.length ? question.options[index] : undefined
  const text = picked === undefined ? normalized : picked.label
  const answer = [
    text,
    ...(picked === undefined ? [] : [`（${t('uiDesign.answerPicked')}：${picked.cost}）`]),
    ...(note === undefined || note.trim() === '' ? [] : [`｜${t('uiDesign.answerNote')}：${note.trim()}`]),
  ].join('')

  const next: GrillQuestion = {
    ...question,
    answer,
    status: 'answered',
    answeredBy: by ?? 'human',
  }
  writeDesignQuestion(store, next)
  journal.append('design/question-answered', { id, answer, by: next.answeredBy, target: question.targets[0] ?? '' })
  // 增量 2：方法题的答案另存一份「本项目启用方法」快照（门禁仍从账本现算，快照只供查询/渲染）
  if (question.targets.includes(METHOD_TARGET)) refreshMethodSnapshot(store, journal)
  return next
}

/** 把一个设计问题记为"用户授权按建议处理"（`assumed` + `authorizedByUser`）。 */
export function assumeDesign(store: SdoStore, journal: Journal, id: string, by: string): GrillQuestion | undefined {
  const question = readDesignQuestion(store, id)
  if (question === undefined) return undefined
  const next: GrillQuestion = {
    ...question,
    answer: question.defaultRecommendation,
    status: 'assumed',
    authorizedByUser: true,
    answeredBy: by,
  }
  writeDesignQuestion(store, next)
  journal.append('design/question-answered', { id, answer: next.answer, by, target: question.targets[0] ?? '', assumed: true })
  if (question.targets.includes(METHOD_TARGET)) refreshMethodSnapshot(store, journal)
  return next
}

// —————————————————————— 用户确认戳 ——————————————————————

/**
 * 读确认戳台账并**做形状归一化**（F-21 ①）。
 *
 * `.sdo/design/confirmed.yml` 是手可编辑真源：`confirmations` 是记录列表，
 * 手写成标量会让 `listConfirmations().find` 抛异常（`?? []` 只挡住 null/undefined）。
 */
export function readConfirmationsChecked(
  store: SdoStore,
): { confirmations: DesignConfirmation[]; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ confirmations: unknown }>('design', 'confirmed.yml')?.confirmations
  if (raw === undefined || raw === null) return { confirmations: [], notes: [] }
  const read = recordListOf<DesignConfirmation>(raw, (text) => ({ target: text, basis: '', by: '', at: '' }))
  pushShapeNote(notes, 'confirmation', 'confirmed.yml', 'confirmations', read.issue)
  const confirmations = read.value.map((item) => ({
    ...item,
    target: textOf(item.target),
    basis: textOf(item.basis),
    by: textOf(item.by),
    at: textOf(item.at),
    ...(item.contentHash === undefined ? {} : { contentHash: textOf(item.contentHash) }),
  }))
  return { confirmations, notes }
}

export function listConfirmations(store: SdoStore): DesignConfirmation[] {
  return readConfirmationsChecked(store).confirmations
}

/** 确认戳台账上的形状提示（回执 / 门禁详情共用）。 */
export function confirmationShapeNotes(store: SdoStore): FieldShapeNote[] {
  return readConfirmationsChecked(store).notes
}

/** target 是否**有效确认**：存在确认戳且指纹与当前内容一致（F-19）。 */
export function isConfirmed(store: SdoStore, target: string): boolean {
  const record = listConfirmations(store).find((item) => item.target === target)
  if (record === undefined) return false
  const current = confirmationFingerprint(store, target)
  // 内容不可解析（目标已删除/作废）→ 不参与"关键条目"判定，按"没确认"返回（调用方另有清单）
  if (current === undefined) return false
  return record.contentHash === current
}

/**
 * 指纹计算用的**一次读盘快照**。
 *
 * 为什么要它：`staleConfirmations` 要对每条确认戳算指纹，逐条 `readYaml` 会让代价随
 * 「契约数 × 确认戳数」膨胀（实测 60 条 = 15 ms/次）。快照让每个真源文件只读一次。
 */
interface ConfirmationSource {
  views: DesignView[]
  contracts: Contract[]
  ui: UiView | undefined
}

function confirmationSource(store: SdoStore): ConfirmationSource {
  return { views: listViewsSafe(store), contracts: listContracts(store), ui: readUiView(store) }
}

/**
 * 被确认内容的**规范化表示**（只取内容，不取时间戳）——F-19 的指纹取它。
 *
 * 为什么显式挑字段而不是整对象：`Contract.at` / `UiView.updatedAt` / 视图 `updatedAt`
 * 是**元数据**，重写一次就变；把它们算进指纹会让"原样重写"也失效，把确认戳变成噪声。
 */
function confirmationContent(source: ConfirmationSource, target: string): unknown {
  const { ui, contracts, views } = source
  if (target.startsWith('ui:') && target.endsWith(':style')) {
    if (ui === undefined || uiTarget(ui.id, 'style') !== target) return undefined
    return { kind: 'ui-style', style: ui.style }
  }
  if (target.endsWith(':columns')) {
    const screen = ui?.screens.find((item) => `${item.id}:columns` === target)
    return screen === undefined ? undefined : { kind: 'ui-columns', screen: screen.id, columns: screen.columns }
  }
  if (target.endsWith(':layout')) {
    const screen = ui?.screens.find((item) => `${item.id}:layout` === target)
    return screen === undefined ? undefined : { kind: 'ui-layout', screen: screen.id, layout: screen.layout }
  }
  if (/^CT-/u.test(target)) {
    const contract = contracts.find((item) => item.id === target)
    // 已作废的契约不再是"关键条目"（与 `confirmGaps` 同一口径）
    if (contract === undefined || contract.dropped === true) return undefined
    return {
      kind: 'contract',
      id: contract.id,
      name: contract.name,
      contractKind: contract.kind,
      producer: contract.producer,
      consumer: contract.consumer,
      schema: contract.schema,
      failureSemantics: contract.failureSemantics,
      requires: contract.requires ?? [],
    }
  }
  for (const view of views) {
    const element = view.elements.find((item) => item.id === target)
    if (element !== undefined) {
      return {
        kind: 'element',
        id: element.id,
        name: element.name,
        elementKind: element.kind,
        responsibility: element.responsibility,
        dependsOn: element.dependsOn,
        requires: element.requires ?? [],
        confidence: element.confidence ?? '',
      }
    }
  }
  return undefined
}

/** 稳定的 JSON 序列化（键排序、跳过 `undefined`），保证同一内容永远同一指纹。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
}

/**
 * 指纹的**存储形态**带算法前缀（`sha256:<hex>`）。
 *
 * 为什么必须带前缀：纯十六进制里"全是数字"的哈希会被 YAML 解析成 number，
 * 于是"指纹不相等"永远成立 → 确认戳永远失效（活锁）。带前缀即永远是字符串。
 */
export const CONFIRMATION_HASH_PREFIX = 'sha256:'

function fingerprintOf(source: ConfirmationSource, target: string): string | undefined {
  const content = confirmationContent(source, target)
  if (content === undefined) return undefined
  return CONFIRMATION_HASH_PREFIX + createHash('sha256').update(canonicalJson(content)).digest('hex')
}

/** 指纹的短显示（去掉算法前缀，回执里人眼比对用）。 */
export function shortConfirmationHash(hash: string): string {
  const hex = hash.startsWith(CONFIRMATION_HASH_PREFIX) ? hash.slice(CONFIRMATION_HASH_PREFIX.length) : hash
  return hex.slice(0, 8)
}

/**
 * target 的**当前内容指纹**（sha256，十六进制）。目标不可解析（不存在/已作废）时返回 `undefined`。
 */
export function confirmationFingerprint(store: SdoStore, target: string): string | undefined {
  return fingerprintOf(confirmationSource(store), target)
}

/** 一个因内容变更而失效的确认戳（F-19 回执要说清"哪条确认因内容变更而失效"）。 */
export interface StaleConfirmation {
  target: string
  /** 用户当时确认的依据（原话/批注）与时间、确认人——原样保留，便于回执复述 */
  basis: string
  by: string
  at: string
  /** 确认时记录的指纹（旧数据可能为 `''` = 从未绑定） */
  confirmedHash: string
  /** 当前内容指纹 */
  currentHash: string
}

/**
 * 一个**已找不到对应条目**的确认戳（Y-7）。
 *
 * 与失效戳的区别：失效戳的目标**仍然存在**（内容变了）；孤儿戳的目标**在当前真源里
 * 已经解析不出来**（被删 / 改了 id / 清空了 `requires` 于是退出关键条目集合）。
 * 这类戳既不会被要求重新确认，也不会出现在失效清单里 —— 用户以为确认过，门禁也不再提它。
 * 因此单独列出来（**不判红**：条目本来就可能合法地下线），但必须让人看见。
 */
export interface OrphanConfirmation {
  target: string
  basis: string
  by: string
  at: string
}

/**
 * **内容已变、确认戳因此失效**的条目（F-19）。
 *
 * 口径：
 *   · 只统计**当前仍可解析**（存在且未作废）的 target —— 已删除/作废的条目不再是要确认的对象；
 *   · 指纹缺失（旧构建写的确认戳）或与当前内容不符 → 判失效，必须重新确认。
 * 与门禁签字按 journal 序号失效同源：**背书必须绑定它背书的那个版本**。
 */
export function staleConfirmations(store: SdoStore): StaleConfirmation[] {
  const out: StaleConfirmation[] = []
  const source = confirmationSource(store)
  for (const record of listConfirmations(store)) {
    const current = fingerprintOf(source, record.target)
    if (current === undefined) continue
    const confirmed = record.contentHash ?? ''
    if (confirmed === current) continue
    out.push({
      target: record.target,
      basis: record.basis,
      by: record.by,
      at: record.at,
      confirmedHash: confirmed,
      currentHash: current,
    })
  }
  return out
}

/**
 * **已退出关键条目集合**的确认戳（Y-7）。
 *
 * 两类都算：
 *   · 目标在当前真源里**解析不出内容**（被删 / 改了 id / 契约已作废）；
 *   · 目标仍能解析，但**已不在关键条目集合里**（例如把元素的 `requires` 清空 →
 *     它不再需要确认，可旧确认戳还留在台账里）。
 * 单独列出、进回执与门禁详情，**不判红** —— 条目下线本身可能是合法的，
 * 但"用户以为确认过、门禁不再提"必须被看见。
 */
export function orphanConfirmations(store: SdoStore, required: readonly string[]): OrphanConfirmation[] {
  const source = confirmationSource(store)
  const requiredSet = new Set(required)
  return listConfirmations(store)
    .filter((record) => fingerprintOf(source, record.target) === undefined || !requiredSet.has(record.target))
    .map((record) => ({ target: record.target, basis: record.basis, by: record.by, at: record.at }))
    .sort((a, b) => a.target.localeCompare(b.target))
}

/** 关键条目（必须确认的 target）集合：`confirmGaps` 与孤儿判定**共用同一份口径**。 */
export function requiredConfirmTargets(
  store: SdoStore,
  project: SdoProject | undefined,
  requirements: Requirement[],
): string[] {
  const required: string[] = []
  for (const view of listViewsSafe(store)) {
    for (const element of view.elements) {
      // 无需求来源的元素是 agent 推测，本来就不该被"确认"掉；先由追溯孤儿抓
      if ((element.requires ?? []).length > 0) required.push(element.id)
    }
  }
  for (const contract of listContracts(store)) {
    if (contract.dropped !== true) required.push(contract.id)
  }
  const ui = readUiView(store)
  if (uiDecision(project, requirements).hasUi && ui !== undefined) {
    required.push(uiTarget(ui.id, 'style'))
    for (const screen of ui.screens) {
      required.push(`${screen.id}:columns`)
      required.push(`${screen.id}:layout`)
    }
  }
  return required
}

/**
 * 记录一次确认戳。
 *
 * **Y-1（本报告）**：目标在当前真源里解析不出内容时**拒绝写入**并返回 `undefined` ——
 * 旧实现照写一条 `contentHash: ''` 的记录，回执却说"确认成功"：指纹永远对不上，
 * 这条确认**永远不被承认**（`isConfirmed` 要求指纹相等），而 `design/confirmed`
 * 又恰好是签字失效事件 —— 用户白签一次还顺手作废了 G3 签字。
 */
export function confirmDesign(
  store: SdoStore,
  journal: Journal,
  target: string,
  basis: string,
  by: string,
  basisSource: 'user' | 'proxy' = 'user',
  /** **R-27 连带（sdo-test-new 2026-10-09）**：调用方对这句"用户原话"的核对结果 */
  basisChecked?: 'session' | 'unavailable' | undefined,
): { confirmation: DesignConfirmation } | { refused: 'no-basis' | 'replayed-basis' | 'unresolvable' } {
  const existing = listConfirmations(store)
  // F-19：确认戳**绑定被确认内容的指纹**。目标不可解析 → **拒绝**（绝不凭空背书）。
  const contentHash = fingerprintOf(confirmationSource(store), target)
  if (contentHash === undefined) return { refused: 'unresolvable' }
  const text = basis.trim()
  // **R-27 连带 ①：没有依据就不许盖"用户确认"戳**。旧实现的默认文案是**插件自己写的**
  // 「用户在会话中确认」—— 模型空手调用就能在真源里留下一条"用户本人确认过"，而 G3 的
  // `design.confirmed` 认它（真机实测：`basis: 用户在会话中确认, by: human, basisSource: user`）。
  if (text === '') return { refused: 'no-basis' }
  // **R-27 连带 ③：同一句旧授权不许在**内容已变**之后继续用** —— 戳绑内容只保证"内容没变时仍有效"，
  // 不保证"内容变了之后用户还认账"。同一 target 上一次确认用的是同一句话、而内容指纹不同 ⇒ 拒绝。
  const previous = existing.find((item) => item.target === target)
  if (previous !== undefined && previous.basis.trim() === text && (previous.contentHash ?? '') !== contentHash) {
    return { refused: 'replayed-basis' }
  }
  const record: DesignConfirmation = {
    target,
    basis: text,
    by,
    basisSource,
    at: new Date().toISOString(),
    contentHash,
    ...(basisChecked === undefined ? {} : { basisChecked }),
  }
  const next = existing.some((item) => item.target === target)
    ? existing.map((item) => (item.target === target ? record : item))
    : [...existing, record]
  store.writeYaml(['design', 'confirmed.yml'], { confirmations: next })
  journal.append('design/confirmed', {
    target,
    basis: text,
    by,
    // **SDO-48**：`basisSource=proxy` 时这一戳是**代盖**，审计读 journal 也能分辨（此前只写死了用户口径）
    basisSource,
    // **R-27 连带**：这次"用户原话"有没有真的和会话里的用户发言核对过（与门禁签字同口径）
    ...(basisChecked === undefined ? {} : { basisChecked }),
    contentHash: record.contentHash ?? '',
  })
  return { confirmation: record }
}

/**
 * 关键条目的确认缺口（G3 `design.confirmed` 判据用）。
 *
 * 关键条目 = 设计元素（`DES-*`）+ 契约（`CT-*`）+ 界面条目
 * （`ui:<UI id>:style`、`<SCR id>:columns`、`<SCR id>:layout`）。
 * **界面条目只在含 UI 时计入**（否则它们不存在）。
 */
export interface ConfirmGap {
  required: string[]
  /** 没有**有效**确认的条目：既含"从未确认"，也含"内容已变、旧确认失效"（F-19） */
  missing: string[]
  /** 其中**因内容变更而失效**的子集（回执要单独说清是哪一种，不能混作"没确认过"） */
  stale: StaleConfirmation[]
  /** 已找不到对应条目的旧确认戳（Y-7）：不判红，但必须在回执/门禁详情里被看见 */
  orphan: OrphanConfirmation[]
}

export function confirmGaps(store: SdoStore, project: SdoProject | undefined, requirements: Requirement[]): ConfirmGap {
  const required = requiredConfirmTargets(store, project, requirements)
  // F-19：`missing` 的口径从"没有确认戳"收紧为"没有**有效**确认"——
  // 内容改过的旧戳与从未确认一样过不了门禁，但回执能通过 `stale` 区分两者。
  const staleByTarget = new Map(staleConfirmations(store).map((item) => [item.target, item]))
  const confirmed = new Set(listConfirmations(store).map((item) => item.target))
  const missing = required.filter((target) => !confirmed.has(target) || staleByTarget.has(target))
  return {
    required,
    missing,
    stale: missing.map((target) => staleByTarget.get(target)).filter((item): item is StaleConfirmation => item !== undefined),
    orphan: orphanConfirmations(store, required),
  }
}

export function uiTarget(uiId: string, part: string): string {
  return `ui:${uiId}:${part}`
}

/**
 * 关键条目 target 的**类别**（「必须确认哪些条目」的可读清单用）。
 *
 * target 字符串由 {@link confirmGaps} 生成，形态只有这五种；识别不看调用方自述。
 */
export function confirmTargetKind(target: string): 'element' | 'contract' | 'ui-style' | 'ui-columns' | 'ui-layout' {
  const raw = target.trim()
  if (raw.endsWith(':columns')) return 'ui-columns'
  if (raw.endsWith(':layout')) return 'ui-layout'
  if (/^ui:[^:]+:style$/u.test(raw)) return 'ui-style'
  if (/^CT-/u.test(raw)) return 'contract'
  return 'element'
}

/** 关键条目类别的可读名（走语言包；取不到时回落基准，绝不出现键名/空白）。 */
export function confirmTargetLabel(target: string): string {
  switch (confirmTargetKind(target)) {
    case 'contract':
      return t('uiDesign.confirmKindContract')
    case 'ui-style':
      return t('uiDesign.confirmKindUiStyle')
    case 'ui-columns':
      return t('uiDesign.confirmKindUiColumns')
    case 'ui-layout':
      return t('uiDesign.confirmKindUiLayout')
    case 'element':
    default:
      return t('uiDesign.confirmKindElement')
  }
}

/**
 * 「必须确认但尚未确认」清单的行（`sdo_design action=issues` 回执与 `docs/DESIGN.md` §7 共用）。
 *
 * **没有可确认的条目时返回空数组**（两种情况都空）：
 *   · 没有任何关键条目（没有设计元素/契约/界面条目）——不许凭空造 target；
 *   · 关键条目都已确认 —— "必须确认但尚未确认"的清单本来就是空的。
 * 因此调用方据此整段省略，不出现空标题（空清单 = 没有输出，而不是一个空列表）。
 */
export function confirmGapLines(gaps: ConfirmGap): string[] {
  if (gaps.missing.length === 0) return []
  const lines = [`- ${fmt('uiDesign.confirmGapsMissing', { p1: gaps.missing.length, p2: gaps.required.length })}`]
  const stale = new Set(gaps.stale.map((item) => item.target))
  for (const target of gaps.missing) {
    // 内容变过的条目**必须与"从未确认"分开说**（F-19）：否则用户以为自己没确认过，
    // 实际是"确认过 A 版本、现在要确认 B 版本"。
    lines.push(
      stale.has(target)
        ? `  - ${target}｜${confirmTargetLabel(target)}｜${t('uiDesign.confirmGapsStale')}`
        : `  - ${target}｜${confirmTargetLabel(target)}`,
    )
  }
  if (gaps.stale.length > 0) lines.push(`  - ${t('uiDesign.confirmGapsStaleHint')}`)
  lines.push(`  - ${t('uiDesign.confirmGapsHint')}`)
  return lines
}

/**
 * 「已找不到对应条目的旧确认戳」的清单行（Y-7）。
 *
 * 与 `confirmGapLines` 分开：那份是"必须确认但尚未确认"的**动作清单**，没有缺口就必须为空；
 * 孤儿戳不是待办，是**只读的事实** —— 用户以为确认过，可那个条目已经不在真源里了。
 * 单独成段，**不判红**（条目下线本身可能是合法的），但必须让人看见。
 */
export function orphanConfirmationLines(gaps: ConfirmGap): string[] {
  if (gaps.orphan.length === 0) return []
  return [
    `- ${fmt('uiDesign.orphanConfirmations', {
      p1: gaps.orphan.length,
      p2: gaps.orphan.map((item) => item.target).join(' '),
    })}`,
    `- ${t('uiDesign.orphanConfirmationsHint')}`,
  ]
}

function listViewsSafe(store: SdoStore): DesignView[] {
  const out: DesignView[] = []
  for (const kind of VIEW_KINDS) {
    const view = readView(store, kind)
    if (view !== undefined) out.push(view)
  }
  return out
}

// —————————————————————— 界面视图（第 6 个视图） ——————————————————————

/**
 * 界面视图的**读取边界归一化**（F-21 ①）。
 *
 * `.sdo/design/ui.yml` 是手可编辑真源，容器位置很多：`screens` / `breakpoints`（记录列表）、
 * 每页的 `columns` / `interactions` / `requires`（列表）、`layout` / `states`（映射）、
 * 断点的 `changes`（列表）、`accessibility` / `style` 的 `tokens`（映射）。
 * 旧实现 `ui.screens.every((screen) => screen.columns.length > 0)` 在 `screens: 差异清单`
 * 或 `layout: 单列` 这样的手写下会抛异常。口径与其它实体一致：
 *   · 标量写在列表位置 → **单元素列表**（记录列表按最自然的字段落地）+ 提示；
 *   · 映射写在列表位置 / 任何东西写在映射位置 → **不猜**，按空处理 + 提示。
 */
function normalizeUiScreen(raw: unknown, index: number, notes: FieldShapeNote[], viewId: string): UiScreen {
  const id = `screens[${index}]`
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    pushShapeNote(notes, 'view', viewId, id, {
      position: 'map',
      actualType: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
      handling: 'empty',
      text: uiText(raw),
    })
    return { id: '', name: uiText(raw), columns: [], layout: { grid: '', regions: [] }, interactions: [], states: {}, requires: [] }
  }
  const screen = raw as Record<string, unknown>
  const columns = recordListOf<{ name: string; kind: string; region?: string | undefined }>(screen.columns, (text) => ({ name: text, kind: '' }))
  pushShapeNote(notes, 'view', viewId, `${id}.columns`, columns.issue)
  const layout = recordOf(screen.layout)
  pushShapeNote(notes, 'view', viewId, `${id}.layout`, layout.issue)
  const regions = textListOf(layout.value['regions'])
  pushShapeNote(notes, 'view', viewId, `${id}.layout.regions`, regions.issue)
  const interactions = textListOf(screen.interactions)
  pushShapeNote(notes, 'view', viewId, `${id}.interactions`, interactions.issue)
  const states = textMapOf(screen.states)
  pushShapeNote(notes, 'view', viewId, `${id}.states`, states.issue)
  const requires = textListOf(screen.requires)
  pushShapeNote(notes, 'view', viewId, `${id}.requires`, requires.issue)
  const grid = uiText(layout.value['grid'])
  const stackRaw = uiText(layout.value['stack']).trim()
  return {
    id: uiText(screen.id).trim() === '' ? `SCR-${String(index + 1).padStart(3, '0')}` : uiText(screen.id).trim(),
    name: uiText(screen.name),
    // **F-2**：栏目可以声明 `region`（必须是本屏 `layout.regions` 里的名字）。
    // 这里**原样保留**声明值：不存在的区域名由线框图/骨架**在图里报出**
    // （`regionBuckets` 的新开区域 + `screenWireframe` 的 unknown 注记），不静默丢弃。
    columns: columns.value.map((column) => {
      const region = uiText((column as { region?: unknown }).region).trim()
      return { name: uiText(column.name), kind: uiText(column.kind), ...(region === '' ? {} : { region }) }
    }),
    layout: {
      grid,
      regions: regions.value,
      ...(stackRaw === '' ? {} : { stack: stackRaw as UiStackDirection }),
    },
    interactions: interactions.value,
    states: states.value,
    requires: requires.value,
  }
}

function normalizeUiView(raw: unknown, notes: FieldShapeNote[]): UiView | undefined {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) {
      pushShapeNote(notes, 'view', 'ui', 'ui', {
        position: 'map',
        actualType: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
        handling: 'empty',
        text: uiText(raw),
      })
    }
    return undefined
  }
  const record = raw as Record<string, unknown>
  const id = uiText(record.id).trim() === '' ? 'UI-001' : uiText(record.id).trim()
  const screens = recordListOf<unknown>(record.screens, (text) => ({ name: text }))
  pushShapeNote(notes, 'view', id, 'screens', screens.issue)
  const breakpoints = recordListOf<UiBreakpoint>(record.breakpoints, (text) => ({ name: text, width: '', changes: [] }))
  pushShapeNote(notes, 'view', id, 'breakpoints', breakpoints.issue)
  const style = recordOf(record.style)
  pushShapeNote(notes, 'view', id, 'style', style.issue)
  const tokens = textMapOf(style.value['tokens'])
  pushShapeNote(notes, 'view', id, 'style.tokens', tokens.issue)
  const accessibility = recordOf(record.accessibility)
  pushShapeNote(notes, 'view', id, 'accessibility', accessibility.issue)
  return {
    id,
    style: {
      source: uiText(style.value['source']) as UiView['style']['source'],
      tokens: tokens.value,
      rationale: uiText(style.value['rationale']),
    },
    screens: screens.value.map((screen, index) => normalizeUiScreen(screen, index, notes, id)),
    breakpoints: breakpoints.value.map((breakpoint, index) => {
      const changes = textListOf((breakpoint as unknown as Record<string, unknown>).changes)
      pushShapeNote(notes, 'view', id, `breakpoints[${index}].changes`, changes.issue)
      return { name: uiText(breakpoint.name), width: uiText(breakpoint.width), changes: changes.value }
    }),
    accessibility: {
      contrast: uiText(accessibility.value['contrast']),
      keyboard: accessibility.value['keyboard'] === true,
      screenReader: uiText(accessibility.value['screenReader']),
    },
    updatedAt: uiText(record.updatedAt),
  }
}

/** 读界面视图 + 它的形状提示（F-21）。 */
export function readUiViewChecked(store: SdoStore): { view: UiView | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const view = normalizeUiView(store.readYaml<{ ui: unknown }>('design', 'ui.yml')?.ui, notes)
  return { view, notes }
}

export function readUiView(store: SdoStore): UiView | undefined {
  return readUiViewChecked(store).view
}

/** 界面视图上的形状提示（回执 / 只读视图 / 门禁详情共用）。 */
export function uiViewShapeNotes(store: SdoStore): FieldShapeNote[] {
  return readUiViewChecked(store).notes
}

/** 边界取值助手：不是字符串就取空串（数值会被字符串化，例如断点宽度 `768`）。 */
function uiText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function uiTextList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => uiText(item)).filter((item) => item !== '') : []
}

function uiRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const text = uiText(item)
    if (text !== '') out[key] = text
  }
  return out
}

/**
 * 工具面 `ui` 参数的**边界归一**（F-9）。
 *
 * 为什么需要它：`ui` 是模型传来的 JSON 字符串，直接 `as UiView` 写入会让下游
 * （线框图 / DESIGN.md / 门禁）在缺字段时崩掉或静默当成空。这里做两件事：
 *   ① **类型错误显式报错**（绝不静默丢弃模型给的字段）；
 *   ② **缺的可选字段补空、页面 id 顺序分配**，让回执里的确认清单能给出真实 target。
 */
export function parseUiViewInput(raw: string): { view: UiView } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { error: fmt('uiDesign.uiInputInvalid', { p1: error instanceof Error ? error.message : String(error) }) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: t('uiDesign.uiInputNotObject') }
  }
  const input = parsed as Record<string, unknown>

  const styleRaw = input.style
  if (styleRaw === null || typeof styleRaw !== 'object' || Array.isArray(styleRaw)) {
    return { error: t('uiDesign.uiInputBadStyle') }
  }
  const style = styleRaw as Record<string, unknown>
  const source = uiText(style.source).trim()
  if (!(UI_STYLE_SOURCES as readonly string[]).includes(source)) {
    return { error: fmt('uiDesign.uiInputBadStyleSource', { p1: UI_STYLE_SOURCES.join(' / ') }) }
  }
  const tokensRaw = style.tokens
  if (tokensRaw !== undefined && (tokensRaw === null || typeof tokensRaw !== 'object' || Array.isArray(tokensRaw))) {
    return { error: t('uiDesign.uiInputBadTokens') }
  }

  const screensRaw = input.screens ?? []
  if (!Array.isArray(screensRaw)) return { error: t('uiDesign.uiInputBadScreens') }
  const screens: UiScreen[] = []
  for (const [index, item] of screensRaw.entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { error: fmt('uiDesign.uiInputBadScreen', { p1: String(index) }) }
    }
    const screen = item as Record<string, unknown>
    const id = uiText(screen.id).trim() === '' ? `SCR-${String(index + 1).padStart(3, '0')}` : uiText(screen.id).trim()
    const columnsRaw = screen.columns ?? []
    if (!Array.isArray(columnsRaw)) return { error: fmt('uiDesign.uiInputBadColumns', { p1: id }) }
    const columns: { name: string; kind: string }[] = []
    for (const columnRaw of columnsRaw) {
      if (columnRaw === null || typeof columnRaw !== 'object' || Array.isArray(columnRaw)) {
        return { error: fmt('uiDesign.uiInputBadColumns', { p1: id }) }
      }
      const column = columnRaw as Record<string, unknown>
      columns.push({ name: uiText(column.name), kind: uiText(column.kind) })
    }
    const layoutRaw = screen.layout
    if (layoutRaw !== undefined && (layoutRaw === null || typeof layoutRaw !== 'object' || Array.isArray(layoutRaw))) {
      return { error: fmt('uiDesign.uiInputBadLayout', { p1: id }) }
    }
    const layout = (layoutRaw ?? {}) as Record<string, unknown>
    // F-15：`layout.stack` 是**显式**的堆叠方向；给了非法值必须当面报错（不静默丢弃、
    // 也不去猜 `grid` 的自由文本）。缺省（未给）时线框图按 vertical 渲染并注明"缺省"。
    const stackRaw = uiText(layout.stack).trim()
    if (stackRaw !== '' && !(UI_STACK_DIRECTIONS as readonly string[]).includes(stackRaw)) {
      return { error: fmt('uiDesign.uiInputBadStack', { p1: id, p2: stackRaw, p3: UI_STACK_DIRECTIONS.join(' / ') }) }
    }
    screens.push({
      id,
      name: uiText(screen.name),
      columns,
      layout: {
        grid: uiText(layout.grid),
        regions: uiTextList(layout.regions),
        ...(stackRaw === '' ? {} : { stack: stackRaw as UiStackDirection }),
      },
      interactions: uiTextList(screen.interactions),
      states: uiRecord(screen.states),
      requires: uiTextList(screen.requires),
    })
  }

  const breakpointsRaw = input.breakpoints ?? []
  if (!Array.isArray(breakpointsRaw)) return { error: t('uiDesign.uiInputBadBreakpoints') }
  const breakpoints: UiBreakpoint[] = []
  for (const item of breakpointsRaw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { error: t('uiDesign.uiInputBadBreakpoints') }
    }
    const breakpoint = item as Record<string, unknown>
    breakpoints.push({ name: uiText(breakpoint.name), width: uiText(breakpoint.width), changes: uiTextList(breakpoint.changes) })
  }

  const a11yRaw = input.accessibility
  if (a11yRaw !== undefined && (a11yRaw === null || typeof a11yRaw !== 'object' || Array.isArray(a11yRaw))) {
    return { error: t('uiDesign.uiInputBadAccessibility') }
  }
  const a11y = (a11yRaw ?? {}) as Record<string, unknown>
  const id = uiText(input.id).trim() === '' ? 'UI-001' : uiText(input.id).trim()
  return {
    view: {
      id,
      style: { source: source as UiStyleSource, tokens: uiRecord(tokensRaw), rationale: uiText(style.rationale) },
      screens,
      breakpoints,
      accessibility: {
        contrast: uiText(a11y.contrast),
        keyboard: a11y.keyboard === true,
        screenReader: uiText(a11y.screenReader),
      },
      updatedAt: new Date().toISOString(),
    },
  }
}

export function writeUiView(store: SdoStore, journal: Journal, view: UiView): UiView {
  const next: UiView = { ...view, updatedAt: new Date().toISOString() }
  store.writeYaml(['design', 'ui.yml'], { ui: next })
  journal.append('design/ui-updated', { id: next.id, screens: next.screens.length, style: next.style.source })
  return next
}

// —————————————————————— 界面线框图 + PlantUML 骨架（只从 ui 视图机械推导） ——————————————————————

/** 线框图/`puml` 需要的文案（全部来自语言包；`wireframe.ts` 自己不写文案）。 */
function wireframeStrings(): WireframeStrings {
  return {
    emptyColumns: t('uiDesign.docWireframeEmpty'),
    noRegions: t('uiDesign.docWireframeNoRegions'),
    screenNote: t('uiDesign.docWireframePumlNote'),
    breakpoints: t('uiDesign.docUiBreakpoints'),
    noScreens: t('uiDesign.docUiNoScreens'),
    assignmentGuessed: t('uiDesign.docUiAssignmentGuessed'),
    regionUnknown: (column, declared, regions) => fmt('uiDesign.docUiRegionUnknown', { p1: column, p2: declared, p3: regions }),
    // F-15：方向来源注记 —— 显式声明与缺省是两句不同的话，图旁必须能分辨
    stackNote: (stack) => (stack === undefined
      ? t('uiDesign.docWireframeStackDefault')
      : fmt('uiDesign.docWireframeStackDeclared', { p1: stack })),
  }
}

/**
 * 界面方案章节里的**线框图段**（每屏一块）。
 *
 * 判定为假时不画（该章已经有 N/A 说明）；判真但还没有页面时只说"还没有页面"。
 * 栏目一律逐项来自 `screens[].columns` —— **线框里不会出现台账里没有的栏目**。
 */
export function renderUiWireframes(view: UiView | undefined): string[] {
  if (view === undefined || view.screens.length === 0) return []
  const lines: string[] = ['', `**${t('uiDesign.docWireframe')}**`, '', '```text']
  for (const block of renderWireframes(view, wireframeStrings())) {
    lines.push(...block.lines)
    lines.push('')
  }
  lines.push('```')
  return lines
}

/** 一屏的线框文本（回执里贴单屏用）。 */
export function screenWireframeLines(screen: UiScreen): string[] {
  return screenWireframe(screen, wireframeStrings()).lines
}

/** 无障碍注记的整行文本（PlantUML note 用；文案来自语言包）。 */
function a11yNoteText(view: UiView): string {
  const a11y = view.accessibility
  return `${t('uiDesign.docUiA11y')}：${t('uiDesign.docUiContrast')} ${a11y.contrast}；${t('uiDesign.docUiKeyboard')} `
    + `${a11y.keyboard ? t('uiDesign.docYes') : t('uiDesign.docNo')}；${a11y.screenReader}`
}

/**
 * `ui` 视图 → **PlantUML 骨架**源码（`.puml` 文本，**不渲染成图** —— 本仓库没有渲染器）。
 *
 * 传 `view === undefined`（还没有界面视图）也返回一份合法骨架：里面只有一条
 * 「尚无界面视图」的注记，绝不编造页面。
 */
export function plantUmlText(view: UiView | undefined): string {
  const strings = wireframeStrings()
  const title = t('uiDesign.docS5')
  return plantUmlSkeleton(view, strings, title, view === undefined ? title : a11yNoteText(view))
}

/**
 * 校验用户给的 `.puml` 落点：只允许**工作区内的相对路径**。
 *
 * 拒绝绝对路径与 `..` 越界（与插件别处的路径沙箱同一口径）；空值回落到
 * {@link DEFAULT_PUML_PATH}。返回值是归一化后的相对路径（`/` 分隔）。
 */
export const DEFAULT_PUML_PATH = '.sdo/design/ui.puml'

export function resolvePumlPath(raw: string | undefined): { path: string } | { error: string } {
  const value = (raw ?? '').trim()
  if (value === '') return { path: DEFAULT_PUML_PATH }
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)) {
    return { error: fmt('uiDesign.uiRenderPumlBadPath', { p1: value }) }
  }
  const parts = value.replaceAll('\\', '/').split('/').filter((part) => part !== '' && part !== '.')
  if (parts.length === 0 || parts.includes('..')) {
    return { error: fmt('uiDesign.uiRenderPumlBadPath', { p1: value }) }
  }
  return { path: parts.join('/') }
}

/** 写 `.puml` 骨架（**只写文件**；调用方负责回执里说明"不渲染成图"）。 */
export function writePlantUml(workspace: string, path: string, text: string): number {
  const store = new SdoStore(workspace)
  store.writeText(path.split('/'), text)
  return Buffer.byteLength(text, 'utf8')
}

export interface UiDecisionCheck {
  ok: boolean
  /** 缺什么（风格 / 每页栏目 / 每页布局） */
  missing: string[]
  reason: string
  /** 没有**有效**确认的界面条目 id（含"内容已变、旧戳失效"的，F-19） */
  unconfirmed: string[]
  /** 其中因**内容变更**而失效的条目 id（回执要说清是哪一种） */
  stale: string[]
}

/**
 * `ui.confirmed` 判据的判定核心：风格 + **每页**栏目 + **每页**布局三者都齐备且经用户 `confirm`。
 * 只在含 UI 时被调用（含 UI 判定的三态在 `gates.ts` 里处理）。
 *
 * F-19：`confirm` 过但**内容已改**的条目与"从未确认"一样算未确认（`unconfirmed`），
 * 同时单独记进 `stale`——两者在回执里是不同的说法，不能混。
 */
export function uiConfirmation(store: SdoStore): UiDecisionCheck {
  const ui = readUiView(store)
  if (ui === undefined) {
    return { ok: false, missing: [t('uiDesign.uiMissingView')], reason: t('uiDesign.uiMissingView'), unconfirmed: [], stale: [] }
  }
  const missing: string[] = []
  const unconfirmed: string[] = []
  const stale: string[] = []
  const staleTargets = new Set(staleConfirmations(store).map((item) => item.target))
  const valid = (target: string): boolean => isConfirmed(store, target)
  const check = (target: string): void => {
    if (valid(target)) return
    unconfirmed.push(target)
    if (staleTargets.has(target)) stale.push(target)
  }

  check(uiTarget(ui.id, 'style'))
  if (!ui.style.source) missing.push(t('uiDesign.uiMissingStyle'))

  for (const screen of ui.screens) {
    if ((screen.columns ?? []).length === 0) missing.push(`${screen.id}:${t('uiDesign.uiMissingColumns')}`)
    if ((screen.layout?.regions ?? []).length === 0 || (screen.layout?.grid ?? '') === '') {
      missing.push(`${screen.id}:${t('uiDesign.uiMissingLayout')}`)
    }
    check(`${screen.id}:columns`)
    check(`${screen.id}:layout`)
  }
  if (ui.screens.length === 0) missing.push(t('uiDesign.uiMissingScreens'))

  const ok = missing.length === 0 && unconfirmed.length === 0
  return { ok, missing, unconfirmed, stale, reason: ok ? t('uiDesign.uiConfirmedOk') : t('uiDesign.uiConfirmedNo') }
}

/** 界面视图的栏目/布局/风格是否"齐备"（不看确认戳，供草稿与文档提示缺项）。 */
export function uiCompleteness(store: SdoStore): { style: boolean; screens: boolean; columns: boolean; layout: boolean } {
  const ui = readUiView(store)
  if (ui === undefined) return { style: false, screens: false, columns: false, layout: false }
  return {
    style: Boolean(ui.style.source),
    screens: ui.screens.length > 0,
    columns: ui.screens.length > 0 && ui.screens.every((screen) => screen.columns.length > 0),
    layout: ui.screens.length > 0 && ui.screens.every((screen) => screen.layout.regions.length > 0 && screen.layout.grid !== ''),
  }
}

/** 读一个界面条目（`kind=ui` 的展示与 `confirm` 校验用）。 */
export function parseUiToken(raw: string): { screenId: string; part: 'columns' | 'layout' } | undefined {
  const match = /^(SCR-[0-9]+):(columns|layout)$/u.exec(raw.trim())
  if (match === null) return undefined
  return { screenId: match[1] as string, part: match[2] as 'columns' | 'layout' }
}

export function newUiView(id: string, style: UiView['style']): UiView {
  return {
    id,
    style,
    screens: [],
    breakpoints: [],
    accessibility: { contrast: '', keyboard: false, screenReader: '' },
    updatedAt: new Date().toISOString(),
  }
}

export function newScreen(id: string, name: string, columns: UiScreen['columns'], layout: UiScreen['layout']): UiScreen {
  return { id, name, columns, layout, interactions: [], states: {}, requires: [] }
}

export function newBreakpoint(name: string, width: string, changes: string[]): UiBreakpoint {
  return { name, width, changes }
}

// —————————————————————— 设计草案（grill 返回体的第 ① 段） ——————————————————————

export interface DraftElement {
  id: string
  name: string
  kind: string
  confidence: 'high' | 'medium' | 'low'
  /** 来源需求（追溯矩阵与"标注来源"用） */
  requires: string[]
  /**
   * 职责正文（**SDO-24**）：`DESIGN.md` 是人审交付物，只写「ID｜名称（类型）｜来源｜置信度」
   * 等于**证明不了「真源变更在文档里可见」** —— 现在随文档一起渲染（空则不占位）。
   */
  responsibility?: string | undefined
}

export interface DraftView {
  kind: ViewKind
  summary: string
  elements: DraftElement[]
}

export interface DesignDraft {
  views: DraftView[]
  /** 界面视图（含 UI 时为真实内容，否则为 undefined） */
  ui: UiView | undefined
  /** 界面条目的确认状态 */
  uiCheck: UiDecisionCheck | undefined
  contracts: Contract[]
  adrs: Adr[]
  risks: RiskItem[]
  trace: ReturnType<typeof traceReport>
  uiDecision: UiDecision
}

/** 组装设计草案：按视图组织，标注每条的来源需求与置信度（§1.4 的第 ① 段）。 */
export function designDraft(
  store: SdoStore,
  project: SdoProject | undefined,
  requirements: Requirement[],
): DesignDraft {
  // F-4：来源判定**与 C-21 同源** —— 先建追溯图，再用它补元素的"来源需求"。
  // 旧实现只读元素自带的 `requires` 字段：0.1.2 之前建的存量项目里该字段是空的（来源记在
  // 追溯边 `req-des` 上），于是草案把**全部**元素误报成「无来源 / 低置信度 / 需重看」，
  // 而同一插件的 C-21 报「无孤儿、覆盖率 100%」—— 两个读数互相矛盾。
  const trace = traceReport(store, requirements)
  const views: DraftView[] = []
  for (const view of listViewsSafe(store)) {
    views.push({
      kind: view.kind,
      summary: view.summary,
      elements: view.elements.map((element) => {
        const requires = elementRequires(element, trace)
        return {
          id: element.id,
          name: element.name,
          kind: element.kind,
          // 置信度按**解析出来的来源**现算：元素自带的 `confidence` 是建元素时按（当时为空的）
          // `requires` 推导的，直接沿用会把"有追溯来源"的元素继续写成 low（与 C-21 自相矛盾）。
          confidence: requires.length > 0 ? derivedConfidence({ requires }) : (element.confidence ?? 'low'),
          requires,
          responsibility: typeof element.responsibility === 'string' ? element.responsibility : '',
        }
      }),
    })
  }
  const decision = uiDecision(project, requirements)
  const ui = readUiView(store)
  return {
    views,
    ui,
    uiCheck: decision.hasUi ? uiConfirmation(store) : undefined,
    contracts: listContracts(store).filter((contract) => contract.dropped !== true),
    adrs: listAdrs(store),
    risks: listRisksSafe(store),
    trace,
    uiDecision: decision,
  }
}

function listRisksSafe(store: SdoStore): RiskItem[] {
  const out: RiskItem[] = []
  for (const name of store.listNames('risks')) {
    if (!/^RISK-\d+\.yml$/u.test(name)) continue
    const risk = store.readYaml<{ risk: RiskItem }>('risks', name)?.risk
    if (risk !== undefined) out.push(risk)
  }
  return out
}

/** 设计元素 id → 来源需求（追溯矩阵用）。 */
export function elementRequires(element: DesignElement, trace: DesignDraft['trace']): string[] {
  if ((element.requires ?? []).length > 0) return element.requires ?? []
  const hit = trace.perRequirement.filter((row) => row.design.includes(element.id)).map((row) => row.id)
  return hit
}

// —————————————————————— D：可审查的设计文档 docs/DESIGN.md ——————————————————————

/** `docs/DESIGN.md` 的 11 个固定章节（G3 `design.doc` 判据按它校验）。 */
export const DESIGN_DOC_SECTIONS = [
  'uiDesign.docS1',
  'uiDesign.docS2',
  // 增量 2：设计方法与本项目采用的理由 + 各方法产物
  'uiDesign.docSMethod',
  'uiDesign.docSProducts',
  'uiDesign.docS3',
  'uiDesign.docS4',
  'uiDesign.docS5',
  'uiDesign.docS6',
  'uiDesign.docS7',
  'uiDesign.docS8',
  'uiDesign.docS9',
] as const

/** 每个方法包的最小必产项（渲染与检查器共用同一份映射，避免两处口径分叉）。 */
const PACKAGE_PRODUCTS: Record<MethodId, MethodArtifactKind[]> = {
  structured: ['dictionary', 'dfd', 'erd'],
  oo: ['classes', 'sequences', 'layers'],
  evolutionary: ['debt', 'reversibility', 'increments'],
  // `porting`（§7.3）：旧→新映射 / 不变量清单 / 差分验证策略
  porting: ['mapping', 'invariants', 'diffVerify'],
}

/** §3「设计方法与采用理由」。 */
function renderMethodChapter(store: SdoStore): string[] {
  const lines: string[] = []
  lines.push(`## 3. ${t('uiDesign.docSMethod')}`)
  lines.push('')
  const selection = methodSelection(store)
  const question = methodQuestion(store)
  if (question !== undefined) {
    lines.push(`- ${t('uiDesign.docMethodQuestion')}：${question.id}`)
    lines.push(`- ${t('uiDesign.docMethodRecommend')}：${question.defaultRecommendation}`)
    lines.push(`- ${t('uiDesign.docMethodAnswer')}：${selection.raw === '' ? t('uiDesign.docEmpty') : selection.raw}`)
  }
  if (selection.status === 'chosen') {
    lines.push(`- ${t('uiDesign.docMethodSelected')}：${selection.methods.map((id) => methodLabel(id)).join(' + ')}`)
    const unselected = METHOD_IDS.filter((id) => !selection.methods.includes(id))
    if (unselected.length > 0) {
      lines.push(`- ${t('uiDesign.docMethodUnselected')}：${unselected.map((id) => methodLabel(id)).join('；')}`)
    }
  } else if (selection.status === 'none') {
    lines.push(`- ${t('uiDesign.docMethodNone')}`)
    lines.push(`- ${t('uiDesign.docMethodUnselected')}：${METHOD_IDS.map((id) => methodLabel(id)).join('；')}`)
  } else {
    lines.push(`- ${fmt('uiDesign.docMethodUndecided', { p1: selection.reason })}`)
  }
  lines.push(`- ${t('uiDesign.docMethodReason')}：${selection.reason}`)
  // **§7.1「不得静默」的第三处**：设计适用性声明（哪些视图做、哪些不做及理由 + 必需工件 + 签字）
  // 必须写进 `docs/DESIGN.md`。为此**不新增章节**（`design.doc` 判据固定 11 章），
  // 而是并进"设计方法与采用理由"章 —— 声明本身就是设计方法这一层的适用性表态。
  lines.push('')
  lines.push(`### ${t('uiDesign.docApplicability')}`)
  for (const line of applicabilityLines(readApplicability(store))) lines.push(`- ${line}`)
  return lines
}

/** 一份产物的逐条明细（人读；只读台账）。 */
function renderArtifactLines(artifact: MethodArtifact): string[] {
  const lines: string[] = []
  const requires = (value: string[] | undefined): string =>
    value === undefined || value.length === 0 ? t('uiDesign.docNoSource') : value.join(' ')
  switch (artifact.kind) {
    case 'dictionary':
      for (const item of artifact.dictionary ?? []) {
        lines.push(
          `  - ${item.id ?? ''}｜${item.name}｜${t('uiMethod.fieldType')}=${item.type}`
          + `｜${t('uiMethod.fieldSource')}=${item.source}｜${t('uiMethod.fieldSink')}=${item.sink}`
          + `｜${t('uiMethod.fieldValidation')}=${item.validation}｜${t('uiDesign.docRequires')}：${requires(item.requires)}`,
        )
      }
      break
    case 'dfd':
      for (const level of [...(artifact.levels ?? [])].sort((a, b) => a.level - b.level)) {
        lines.push(`  - ${t('uiDesign.docDfdLevel')} ${level.level}｜${level.name}`)
        for (const flow of level.flows ?? []) lines.push(`    - ${t('uiDesign.docDfdFlows')}：${flow.name}（${flow.from} → ${flow.to}）`)
        for (const process of level.processes ?? []) {
          lines.push(
            `    - ${t('uiDesign.docDfdProcesses')}：${process.name}`
            + `（${(process.inputs ?? []).join(' ') || t('uiDesign.docEmpty')} → ${(process.outputs ?? []).join(' ') || t('uiDesign.docEmpty')}）`,
          )
        }
      }
      break
    case 'erd':
      for (const entity of artifact.entities ?? []) {
        lines.push(`  - ${entity.id ?? ''}｜${entity.name}｜${t('uiDesign.docErdIdentifier')}：${entity.identifier}｜${t('uiDesign.docRequires')}：${requires(entity.requires)}`)
      }
      for (const relation of artifact.relations ?? []) {
        lines.push(`  - ${t('uiDesign.docErdRelations')}：${relation.name}｜${relation.from} ${relation.cardinality} ${relation.to}`)
      }
      break
    case 'classes':
      for (const type of artifact.types ?? []) {
        lines.push(
          `  - ${type.id ?? ''}｜${type.name}（${type.kind}）｜${t('uiDesign.docTypeResp')}：${type.responsibility}`
          + `｜${t('uiDesign.docTypeCollab')}：${(type.collaborators ?? []).join(' ') || t('uiDesign.docEmpty')}`
          + `｜${t('uiDesign.docRequires')}：${requires(type.requires)}`,
        )
      }
      break
    case 'sequences':
      for (const sequence of artifact.sequences ?? []) {
        lines.push(
          `  - ${sequence.id ?? ''}｜${sequence.name}｜${t('uiDesign.docSeqRequirement')}：${sequence.requirement}`
          + `｜${t('uiDesign.docRequires')}：${requires(sequence.requires)}`,
        )
        for (const message of sequence.messages ?? []) {
          lines.push(`    - ${message.name}：${message.from} → ${message.to}｜${t('uiDesign.docMsgTrigger')}：${message.trigger}`)
        }
      }
      break
    case 'layers': {
      const rules = artifact.rules
      lines.push(`  - ${t('uiDesign.docLayerList')}：${(rules?.layers ?? []).join(' / ') || t('uiDesign.docEmpty')}`)
      lines.push(
        `  - ${t('uiDesign.docLayerAllowed')}：`
        + ((rules?.allowed ?? []).map((rule) => `${rule.from} → ${rule.to}`).join('；') || t('uiDesign.docEmpty')),
      )
      break
    }
    case 'debt':
      for (const debt of artifact.debts ?? []) {
        lines.push(
          `  - ${debt.id ?? ''}｜${debt.title}｜${t('uiDesign.docDebtType')}：${debt.type}`
          + `｜${t('uiMethod.fieldImpact')}：${debt.impact}｜${t('uiMethod.fieldTrigger')}：${debt.trigger}`
          + `｜${t('uiMethod.fieldPlan')}：${debt.plan}`,
        )
      }
      break
    case 'reversibility':
      for (const decision of artifact.decisions ?? []) {
        lines.push(
          `  - ${decision.id ?? ''}｜${decision.decision}｜${t('uiDesign.docRevGrade')}：${decision.grade}`
          + `｜${t('uiDesign.docRevWhyNow')}：${decision.whyNow === undefined || decision.whyNow === '' ? t('uiDesign.docEmpty') : decision.whyNow}`,
        )
      }
      break
    case 'increments':
      for (const increment of artifact.increments ?? []) {
        lines.push(
          `  - ${increment.id ?? ''}｜${increment.iteration}｜${t('uiDesign.docIncrementElements')}：`
          + `${(increment.elements ?? []).join(' ') || t('uiDesign.docEmpty')}｜${increment.note}`,
        )
      }
      break
    default:
      break
  }
  if (lines.length === 0) lines.push(`  - ${t('uiDesign.docNoArtifact')}`)
  return lines
}

/** §4「各方法产物」：选中的包列产物，未选中的包写「不适用 + 理由」（不留空）。 */
function renderProductsChapter(store: SdoStore, requirements: Requirement[]): string[] {
  const lines: string[] = []
  lines.push(`## 4. ${t('uiDesign.docSProducts')}`)
  lines.push('')
  const result = methodProducts(store, requirements)
  const artifacts = listMethodArtifacts(store)
  for (const id of METHOD_IDS) {
    lines.push(`### ${methodLabel(id)}`)
    const check = result.packages.find((item) => item.id === id)
    if (check === undefined || !check.selected) {
      lines.push(`- ${t('uiDesign.docProductNa')}：${check?.naReason ?? result.selection.reason}`)
      continue
    }
    for (const kind of PACKAGE_PRODUCTS[id]) {
      const artifact = artifacts.find((item) => item.kind === kind)
      if (artifact === undefined) {
        lines.push(`- ${artifactKindLabel(kind)}：${t('uiDesign.docNoArtifact')}`)
        continue
      }
      lines.push(`- ${artifactKindLabel(kind)}`)
      lines.push(...renderArtifactLines(artifact))
    }
  }
  return lines
}

/** 渲染 `docs/DESIGN.md`（**派生视图**，绝不反向写台账）。 */
export function renderDesignDoc(input: {
  workspace: string
  store: SdoStore
  project: SdoProject | undefined
  requirements: Requirement[]
  questions: GrillQuestion[]
  seq: number
  /**
   * 元信息行里要写的**阶段**（P-15）。
   *
   * 阶段是**说明性元数据**、与真源无关，因此判据按**文档头里声明的阶段**重渲染整份文件
   * （否则每次 advance/rollback 都会把文档判成"与真源不一致"）。写盘路径不传它 → 用当前阶段。
   */
  meta?: { phase?: string | undefined } | undefined
}): string {
  const { store, project, requirements } = input
  const draft = designDraft(store, project, requirements)
  const lines: string[] = []

  // X-1：**机器可读的渲染头**。判据 C-25 只有能证明"这份文档由当前真源渲染"才有意义；
  // 旧的判定只查 11 个标题字符串，于是任意一份含这些标题的旧文件都能过门禁。
  // 头里写清真源位置与渲染时的 journal 序号，`design.doc` 据此比对（与 `docs/SRS.md` 同款格式）。
  // N-8：另加**元信息行**（语言 / 阶段）。判据按头里的语言重渲染正文并逐字节比对 —— 语言与阶段
  // 因此必须**在正文之外**，否则切语言、推进阶段都会把文档判成"与真源不一致"（假红）。
  lines.push(renderHeader('.sdo/design', input.seq))
  lines.push(renderMeta(locale(), input.meta?.phase ?? project?.phase ?? ''))
  lines.push('')
  lines.push(`# ${t('uiDesign.docTitle')}`)
  lines.push('')
  lines.push(t('uiDesign.docDerived'))
  lines.push('')

  // ① 范围与关键约束
  lines.push(`## 1. ${t('uiDesign.docS1')}`)
  lines.push('')
  if (project === undefined) {
    lines.push(t('uiDesign.docNoProject'))
  } else {
    lines.push(`- ${t('uiDesign.docProject')}：${project.id} ${project.name}`)
    // **N-8**：这里只写**流程**。`阶段` 属易变元数据（每次 advance/rollback 都变），
    // 写进正文会让"正文 == 当前真源重渲染"这条判据在每次推进后假红 —— 它已挪到元信息头行。
    lines.push(`- ${t('uiDesign.docProcess')}：${project.process}`)
    lines.push(`- ${t('uiDesign.docScopeIn')}：${project.scope.in.length === 0 ? t('uiDesign.docEmpty') : project.scope.in.join('；')}`)
    lines.push(`- ${t('uiDesign.docScopeOut')}：${project.scope.out.length === 0 ? t('uiDesign.docEmpty') : project.scope.out.join('；')}`)
    lines.push(`- ${t('uiDesign.docMetrics')}：${project.metrics.success.length === 0 ? t('uiDesign.docEmpty') : project.metrics.success.join('；')}`)
    lines.push(`- ${t('uiDesign.docStakeholders')}：${project.stakeholders.map((item) => item.role).join('；')}`)
    lines.push(`- ${t('uiDesign.docSurfaces')}：${(project.surfaces ?? []).length === 0 ? t('uiDesign.docEmpty') : (project.surfaces ?? []).join('；')}`)
  }
  // **P-6**：与门禁同源（未授权假设仍算未决；同模块的 `openDesignQuestions()` 用的就是这条）
  const open = input.questions.filter((question) => isEffectivelyOpen(question) && question.origin === 'design')
  lines.push(`- ${t('uiDesign.docOpenCount')}：${open.length}`)

  // ② 视图与元素
  lines.push('')
  lines.push(`## 2. ${t('uiDesign.docS2')}`)
  lines.push('')
  for (const view of draft.views) {
    lines.push(`### ${view.kind}`)
    lines.push(`- ${t('uiDesign.docSummary')}：${view.summary === '' ? t('uiDesign.docEmpty') : view.summary}`)
    if (view.elements.length === 0) {
      lines.push(`- ${t('uiDesign.docEmptyView')}`)
      continue
    }
    for (const element of view.elements) {
      const requires = element.requires.length === 0 ? t('uiDesign.docNoSource') : element.requires.join(' ')
      // **SDO-24（2026-10-05 真机）**：只输出「ID｜名称（类型）｜来源需求｜置信度」时，人审文档
      // **证明不了「真源变更在文档里可见」**（C-25 只能证明渲染序号不早于真源变更）——真机上架构师
      // 改的 6 处职责正文在 DESIGN.md 里零命中，评审只能去读 `.sdo/design/*.yml`。现在一并渲染职责正文。
      const responsibility = String(element.responsibility ?? '').trim()
      lines.push(`- ${element.id}｜${element.name}（${element.kind}）｜${t('uiDesign.docRequires')}：${requires}｜${t('uiDesign.docConfidence')}：${element.confidence}`
        + (responsibility === '' ? '' : `｜${t('uiDesign.docElementResp')}：${responsibility}`))
    }
  }
  if (draft.views.length === 0) lines.push(`- ${t('uiDesign.docEmptyView')}`)
  // **ui 是第 6 个视图**：判真写真内容，判假也要出现并写明不适用（与界面方案章节同一做法）
  lines.push(`### ui`)
  if (!draft.uiDecision.hasUi) {
    lines.push(`- ${t('uiDesign.docUiNa')}：${draft.uiDecision.reason}`)
  } else if (draft.ui === undefined) {
    lines.push(`- ${t('uiDesign.docUiMissing')}`)
  } else {
    lines.push(`- ${draft.ui.id}｜${t('uiDesign.docUiStyle')}：${draft.ui.style.source}｜${t('uiDesign.docUiScreens')}：${draft.ui.screens.length}`)
  }

  // ③ 设计方法与采用理由（增量 2）
  lines.push('')
  lines.push(...renderMethodChapter(store))

  // ④ 各方法产物（增量 2）
  lines.push('')
  lines.push(...renderProductsChapter(store, requirements))

  // ⑤ 接口与契约
  lines.push('')
  lines.push(`## 5. ${t('uiDesign.docS3')}`)
  lines.push('')
  if (draft.contracts.length === 0) lines.push(`- ${t('uiDesign.docNoContracts')}`)
  for (const contract of draft.contracts) {
    lines.push(
      `- ${contract.id}｜${contract.name}（${contract.kind}）｜${contract.producer} → ${contract.consumer}`
        // **SDO-24**：契约此前只输出失败语义、不输出 `schema` 正文 —— 人审文档同样无法自证内容。
        + (String(contract.schema ?? '').trim() === '' ? '' : `\n    - ${t('uiDesign.docContractSchema')}：${String(contract.schema).trim()}`)
      + `｜${t('uiDesign.docTimeout')}：${contract.failureSemantics.timeout === '' ? t('uiDesign.docEmpty') : contract.failureSemantics.timeout}`
      + `｜${t('uiDesign.docRetry')}：${contract.failureSemantics.retry === '' ? t('uiDesign.docEmpty') : contract.failureSemantics.retry}`
      + `｜${t('uiDesign.docIdempotency')}：${contract.failureSemantics.idempotency === '' ? t('uiDesign.docEmpty') : contract.failureSemantics.idempotency}`,
    )
  }

  // ④ 关键决策（ADR）
  lines.push('')
  lines.push(`## 6. ${t('uiDesign.docS4')}`)
  lines.push('')
  if (draft.adrs.length === 0) lines.push(`- ${t('uiDesign.docNoAdr')}`)
  for (const adr of draft.adrs) {
    lines.push(`- ${adr.id}｜${adr.title}（${adr.status}）`)
    lines.push(`  - ${t('uiDesign.docDecision')}：${adr.decision === '' ? t('uiDesign.docEmpty') : adr.decision}`)
    lines.push(`  - ${t('uiDesign.docRejected')}：${adr.alternatives.length === 0 ? t('uiDesign.docEmpty') : adr.alternatives.map((item) => item.option).join('；')}`)
    // **D-17**：后果是记录项（`item` + 可选 `mitigation`）—— 渲染时把缓解也带上，别丢字段
    lines.push(
      `  - ${t('uiDesign.docConsequences')}：${
        adr.consequences.length === 0
          ? t('uiDesign.docEmpty')
          : adr.consequences
              .map((row) => (row.mitigation === undefined ? row.item : `${row.item}${fmt('uiDesign.docMitigation', { p1: row.mitigation })}`))
              .join('；')
      }`,
    )
  }

  // ⑤ 界面方案：判假时**不省略、不留空**
  lines.push('')
  lines.push(`## 7. ${t('uiDesign.docS5')}`)
  lines.push('')
  if (!draft.uiDecision.hasUi) {
    lines.push(`- ${t('uiDesign.docUiNa')}：${draft.uiDecision.reason}`)
    lines.push(`- ${t('uiDesign.docUiNaBasis')}：${t('uiDesign.docUiNaRule')}`)
  } else if (draft.ui === undefined) {
    lines.push(`- ${t('uiDesign.docUiMissing')}`)
    lines.push(`- ${draft.uiDecision.reason}`)
  } else {
    lines.push(`- ${t('uiDesign.docUiStyle')}：${draft.ui.style.source}（${draft.ui.style.rationale === '' ? t('uiDesign.docEmpty') : draft.ui.style.rationale}）`)
    const tokens = Object.entries(draft.ui.style.tokens)
    lines.push(`- ${t('uiDesign.docUiTokens')}：${tokens.length === 0 ? t('uiDesign.docEmpty') : tokens.map(([key, value]) => `${key}=${value}`).join('；')}`)
    if (draft.ui.screens.length === 0) lines.push(`- ${t('uiDesign.docUiNoScreens')}`)
    for (const screen of draft.ui.screens) {
      lines.push(`- ${screen.id}｜${screen.name}｜${t('uiDesign.docUiColumns')}：${screen.columns.map((column) => `${column.name}(${column.kind})`).join('、')}`)
      lines.push(`  - ${t('uiDesign.docUiLayout')}：${screen.layout.grid}｜${screen.layout.regions.join(' / ')}`)
      lines.push(`  - ${t('uiDesign.docUiInteractions')}：${screen.interactions.length === 0 ? t('uiDesign.docEmpty') : screen.interactions.join('、')}`)
      lines.push(`  - ${t('uiDesign.docUiStates')}：${Object.keys(screen.states).length === 0 ? t('uiDesign.docEmpty') : Object.entries(screen.states).map(([key, value]) => `${key}=${value}`).join('；')}`)
      lines.push(`  - ${t('uiDesign.docRequires')}：${screen.requires.length === 0 ? t('uiDesign.docNoSource') : screen.requires.join(' ')}`)
    }
    lines.push(`- ${t('uiDesign.docUiBreakpoints')}：${draft.ui.breakpoints.length === 0 ? t('uiDesign.docEmpty') : draft.ui.breakpoints.map((item) => `${item.name}(${item.width})`).join('、')}`)
    lines.push(`- ${t('uiDesign.docUiA11y')}：${t('uiDesign.docUiContrast')} ${draft.ui.accessibility.contrast === '' ? t('uiDesign.docEmpty') : draft.ui.accessibility.contrast}｜${t('uiDesign.docUiKeyboard')} ${draft.ui.accessibility.keyboard ? t('uiDesign.docYes') : t('uiDesign.docNo')}｜${draft.ui.accessibility.screenReader === '' ? t('uiDesign.docEmpty') : draft.ui.accessibility.screenReader}`)
    const check = uiConfirmation(store)
    lines.push(`- ${t('uiDesign.docUiConfirm')}：${check.ok ? t('uiDesign.docUiConfirmed') : `${t('uiDesign.docUiUnconfirmed')}（${[...check.missing, ...check.unconfirmed].join(' ')}）`}`)
    // **线框图**：从 `screens[].columns` 与 `layout.regions` 机械推导（看着实物审）。
    // 栏目逐项对应：台账里没有的栏目不会出现在线框里；空栏目屏由线框自己给可读提示。
    lines.push(...renderUiWireframes(draft.ui))
  }

  // ⑧ 追溯矩阵
  lines.push('')
  lines.push(`## 8. ${t('uiDesign.docS6')}`)
  lines.push('')
  lines.push(`| ${t('uiDesign.docMatrixReq')} | ${t('uiDesign.docMatrixDesign')} | ${t('uiDesign.docMatrixContract')} | ${t('uiDesign.docMatrixUi')} |`)
  lines.push('| --- | --- | --- | --- |')
  const uiRows = new Map<string, string[]>()
  for (const screen of draft.ui?.screens ?? []) {
    for (const requirement of screen.requires) {
      const list = uiRows.get(requirement) ?? []
      list.push(screen.id)
      uiRows.set(requirement, list)
    }
  }
  for (const row of draft.trace.perRequirement) {
    const design = row.design.length === 0 ? t('uiDesign.docEmpty') : row.design.join(' ')
    const contracts = draft.contracts.filter((contract) => contract.consumer === row.id || contract.producer === row.id).map((contract) => contract.id)
    const ui = uiRows.get(row.id) ?? []
    lines.push(`| ${row.id} | ${design} | ${contracts.length === 0 ? t('uiDesign.docEmpty') : contracts.join(' ')} | ${ui.length === 0 ? t('uiDesign.docEmpty') : ui.join(' ')} |`)
  }
  if (draft.trace.perRequirement.length === 0) lines.push(`| ${t('uiDesign.docEmpty')} | ${t('uiDesign.docEmpty')} | ${t('uiDesign.docEmpty')} | ${t('uiDesign.docEmpty')} |`)

  // ⑨ 待你确认的问题清单
  lines.push('')
  lines.push(`## 9. ${t('uiDesign.docS7')}`)
  lines.push('')
  if (open.length === 0) {
    lines.push(`- ${t('uiDesign.docNoOpenQuestions')}`)
  } else {
    for (const question of open) {
      lines.push(`- ${question.id}｜${question.text}`)
      lines.push(`  - ${t('uiDesign.docQuestionWhy')}：${question.why}`)
      lines.push(`  - ${t('uiDesign.docQuestionCost')}：${question.consequenceIfUnasked}`)
      lines.push(`  - ${t('uiDesign.docQuestionSuggest')}：${question.defaultRecommendation}`)
      lines.push(`  - ${t('uiDesign.docQuestionOptions')}：${question.options.map((option) => `${option.label}（${option.cost}）`).join('；')}`)
    }
  }
  // 关键条目的确认缺口也进"待你确认"（这才是"哪些条目必须确认"的可见入口）。
  // 与 `sdo_design action=issues` 共用同一套措辞：**没有关键条目时整段不出现**（不造 target）。
  const gaps = confirmGaps(store, project, requirements)
  const gapLines = confirmGapLines(gaps)
  if (gapLines.length > 0) {
    lines.push(`- ${t('uiDesign.docUnconfirmedTargets')}`)
    for (const line of gapLines) lines.push(`  ${line}`)
  }

  // ⑩ 与上一版差异
  lines.push('')
  lines.push(`## 10. ${t('uiDesign.docS8')}`)
  lines.push('')
  lines.push(`- ${t('uiDesign.docDiffSeq')}：${input.seq}`)
  lines.push(`- ${t('uiDesign.docDiffAdded')}：${draft.views.flatMap((view) => view.elements.map((element) => element.id)).join(' ') || t('uiDesign.docEmpty')}`)
  lines.push(`- ${t('uiDesign.docDiffDropped')}：${listContracts(store).filter((contract) => contract.dropped === true).map((contract) => contract.id).join(' ') || t('uiDesign.docEmpty')}`)

  // ⑪ 未决与已知风险
  lines.push('')
  lines.push(`## 11. ${t('uiDesign.docS9')}`)
  lines.push('')
  if (draft.risks.length === 0) lines.push(`- ${t('uiDesign.docNoRisk')}`)
  for (const risk of draft.risks) {
    lines.push(`- ${risk.id}｜${risk.title}（${risk.level} / ${risk.status}）｜${risk.mitigation === '' ? t('uiDesign.docEmpty') : risk.mitigation}`)
  }
  if (gaps.missing.length > 0) lines.push(`- ${t('uiDesign.docUnconfirmedRisk')}：${gaps.missing.length}`)
  lines.push(`- ${t('uiDesign.docOpenRisk')}：${open.length}`)
  lines.push('')

  return lines.join('\n')
}

/**
 * 渲染后写盘（`docs/DESIGN.md`）。
 *
 * ⚠️ 路径是**工作区根**下的 `docs/`，不是 `.sdo/docs/` —— 它要和人读的
 * `docs/SRS.md` / `docs/TRACE.md` 放一起；写进 `.sdo/` 的话人翻不到（真机症状：门禁报"还没有 docs/DESIGN.md"）。
 */
export function writeDesignDoc(workspace: string, text: string): void {
  new SdoStore(workspace).writeText(['docs', 'DESIGN.md'], text)
}

/** `docs/DESIGN.md` 是否已生成（G3 `design.doc` 判据用）。 */
export function designDocExists(workspace: string): boolean {
  return existsSync(join(workspace, 'docs', 'DESIGN.md'))
}

/**
 * 从渲染头里解出 `journal seq N`（X-1）。
 *
 * 约定与 `docs/SRS.md` 一致：`<!-- source: <位置> @ journal seq N -->`。
 * 取不到 → `undefined`（调用方必须据此**判红**："无法证明由当前真源渲染"）。
 */
export function parseRenderSeq(text: string): number | undefined {
  const matched = /<!--\s*source:\s*[^>]*?@\s*journal seq\s+(\d+)\s*-->/u.exec(text)
  if (matched === null) return undefined
  const value = Number(matched[1])
  return Number.isFinite(value) ? value : undefined
}

/**
 * 渲染头里的**语言**（N-11）：`<!-- meta: lang zh-CN ; phase architecture -->`。
 *
 * 判据按它重渲染正文，因此"中文渲染的文档在 en 会话里"不会被当成缺章节（假红）。
 * 老文档没有这一行 → 返回 `undefined`，调用方回落到**当前进程语言**（尽力而为，不做假绿）。
 */
export function parseRenderLang(text: string): string | undefined {
  const matched = /<!--\s*meta:[^>]*?\blang\s+([A-Za-z][A-Za-z0-9-]*)/u.exec(text)
  return matched?.[1]
}

/**
 * 渲染头里的**阶段**（P-15）：判据按它重渲染整份文件，因此推进/回退不会让文档"不一致"。
 * 老文档没有这一行 → 返回 `undefined`，调用方回落当前阶段。
 */
export function parseRenderPhase(text: string): string | undefined {
  const matched = /<!--\s*meta:[^>]*?\bphase\s+([^\s;>]+)/u.exec(text)
  return matched?.[1]
}

/**
 * 进程内渲染缓存（**P-1**，2026-10-02 **R-1 修正**）。
 *
 * 为什么安全（修正后的论证）：`renderDesignDoc` 是纯函数，而它的**全部输入**都进了缓存键 ——
 * `journal`（序号 + 文件指纹）**以及 `.sdo/` 下所有手写真源文件的指纹**。
 *
 * ⚠️ 上一版只把 `journal` 放进键，并用"任何真源写入都会留一条 journal 事件"当安全前提 ——
 * **那个前提是错的**：`.sdo/` 下的 `*.yml` 是**给人手改的真源**（插件自己的六处注释都这么写），
 * 手改不会产生任何事件。实测复现的后果是**假绿**：手改 `design/component.yml` 里一个
 * 文档可见字段后，缓存把编辑前的渲染端了上来，C-25 拿旧正文与盘上旧文档比对 → **PASS**，
 * 而"按当前真源真渲染"的结果与盘上文档并不一致。本轮把真源文件指纹纳进键，堵掉这条路径。
 *
 * 只在**只读的判据路径**用（写盘路径不缓存，避免任何"忘了失效"的可能）；
 * 容量有上界，超了直接清空（比 LRU 简单，且这里的访问模式是"同一 seq 反复命中"）。
 */
const designDocCache = new Map<string, string>()
const DESIGN_DOC_CACHE_LIMIT = 16

/**
 * 缓存键里的"真源版本"：`journal` 文件 + **`.sdo/` 下全部手写真源**的**内容哈希**（`count:size:sha16`）。
 *
 * 为什么要遍历真源：`renderDesignDoc` 读的不只是 journal —— 它还读 `design/`、`contracts/`、
 * `decisions/`、`requirements/`、`questions/`、`trace/links.jsonl`、`risk`、`applicability`、
 * `confirmed`、`project.json` 等。手改其中任何一个**不会**产生 journal 事件，只按 journal 建键就会命中旧渲染。
 *
 * **§3.1（第二轮评审 HIGH）**：旧实现用 `count:size:maxMtime` 做指纹 ⇒ **同字节数**的原地改写，
 * 只要 mtime 不越过当时的最大值（git checkout / rsync / 备份还原 / 同毫秒两次写都会这样），
 * 键就完全不变 ⇒ **命中旧渲染**（真机复现：281B 原地改写 + mtime 调回 ⇒ 真门禁 G3 仍 ok 的假绿）。
 * 现在指纹取**内容哈希**（路径排序后逐个喂 sha256）：内容变则键必变；只动 mtime 不再产生假失配。
 *
 * 代价：一次递归 `readdir` + 逐个读文件（真源都很小，约百来个文件）。相比一次几十毫秒的重渲染依然划算。
 * 注意**排除 journal 本身**（它另有更细的指纹，且它每次都变，重复无益）。
 */
export function truthRevision(root: string): string {
  const files: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (entry.name === 'journal.jsonl' || entry.name.startsWith('.tmp-')) continue
      files.push(full)
    }
  }
  walk(root)
  // 排序保证同一集合得到同一个键（目录遍历顺序依赖文件系统，不能当指纹的一部分）
  files.sort()
  const hash = createHash('sha256')
  let size = 0
  for (const full of files) {
    try {
      const bytes = readFileSync(full)
      size += bytes.length
      hash.update(full.slice(root.length)).update('\u0000').update(bytes).update('\u0000')
    } catch {
      /* 并发删除/无权限：忽略这一个文件（与旧实现同口径） */
    }
  }
  return `${files.length}:${size}:${hash.digest('hex').slice(0, 16)}`
}

function journalRevision(store: SdoStore): string {
  try {
    const info = statSync(join(store.root, 'journal.jsonl'))
    return `${info.size}:${Math.round(info.mtimeMs)}`
  } catch {
    return '0:0'
  }
}

export function renderDesignDocCached(input: Parameters<typeof renderDesignDoc>[0]): string {
  const lang = locale()
  const phase = input.meta?.phase ?? input.project?.phase ?? ''
  const key = `${input.workspace}|${input.seq}|${lang}|${phase}|${journalRevision(input.store)}|${truthRevision(input.store.root)}`
  const hit = designDocCache.get(key)
  if (hit !== undefined) return hit
  const text = renderDesignDoc(input)
  if (designDocCache.size >= DESIGN_DOC_CACHE_LIMIT) designDocCache.clear()
  designDocCache.set(key, text)
  return text
}

/**
 * 设计问题的三态展示用：`issueClosure` 的输入就是**全量**问题账本，
 * 但这里给出"只算设计问题"的口径（门禁 G3 用它，G2 不受影响）。
 */
export function designQuestionClosure(store: SdoStore): { open: GrillQuestion[]; closed: GrillQuestion[] } {
  const all = listDesignQuestions(store)
  const open = all.filter((question) => isOpen(question))
  const closed = all.filter((question) => !isOpen(question))
  return { open: open.sort((a, b) => a.id.localeCompare(b.id)), closed: closed.sort((a, b) => a.id.localeCompare(b.id)) }
}

/** 供状态块/看板用的一行：设计问题未决数。 */
export function openDesignCount(store: SdoStore): number {
  return openDesignQuestions(store).length
}
