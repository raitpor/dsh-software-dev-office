/**
 * 门禁检查器注册表 + 判定引擎（设计 §7.1 的 `criteria[].check` / §7.3 的判定与证据）。
 *
 * 分工：
 *   · **流程数据**（`src/data/processes/*.yml`）声明"这个门禁由哪些准则构成"；
 *   · **本模块**实现每条准则的检查（确定性、可复现）；
 *   · 未实现的检查器**一律判失败并说明**——门禁绝不允许"检查不到就算通过"。
 *
 * G2 的 7 条准则直接复用 DoR 实现（`evaluateDor`），保证"需求基线门禁"只有一份判定逻辑。
 */
import { LANGUAGES, fmt, locale, t, withLocale } from './i18n.js'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { SdoStore } from '../infra/store.js'
import { stripTrailingNewlines } from '../infra/render.js'
import { textOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import type { Journal } from '../infra/journal.js'
import { DESIGN_DOC_SOURCE_EVENTS } from '../types.js'
import type {
  FeasibilityAssessment,
  GateCriterionResult,
  GateEvaluation,
  GrillQuestion,
  JournalEvent,
  ProcessDef,
  RedTeamIssue,
  Requirement,
  RiskItem,
  SdoProject,
} from '../types.js'
import { adrCompleteness } from './adr.js'
import {
  absentArtifacts,
  applicabilityLines,
  applicabilityState,
  artifactLabel,
  missingArtifacts,
  requiredArtifacts,
  viewLabel,
  viewRules,
} from './applicability.js'
import { contractCoverage, contractDirectionAnomalies, contractFieldNoteLines, contractFieldNotes, listContracts } from './contracts.js'
import { viewsCompleteness } from './architecture.js'
import {
  DESIGN_DOC_SECTIONS,
  confirmGaps,
  isEffectivelyOpenDesign as isEffectivelyOpen,
  listDesignQuestions,
  parseRenderLang,
  parseRenderPhase,
  parseRenderSeq,
  renderDesignDocCached,
  uiConfirmation,
  uiDecision,
} from './design.js'
import { evaluateDor } from './dor.js'
import { issueClosure } from './issues.js'
import { methodConsistency, methodLabel, methodProducts, methodSelection } from './method.js'
import { methodDocHeader, methodDocStatus } from './methodDocs.js'
import { gateDef, gatePhase, legalRollbackTargets } from './process.js'
import { riskStats } from './risks.js'
import { channelLabel, signoffInput, signatureInvalidatingEventLine, signatureState } from './signature.js'
import { checkWantsShapeNotes, collectShapeNotes, shapeNoteLines, shapeNotesForCheck } from './shapeNotes.js'
import { report } from './trace.js'
import { iterationTasks, listTasks, planStats, readIteration, validatePlan } from './plan.js'
import { independenceViolations } from '../integration/orchestrator.js'
import {
  deliveryCompleteness,
  listDefects,
  listReviews,
  listTestCases,
  listTestResults,
  verificationStats,
} from './records.js'

/** 判定所需的全部输入（由 office 组装）。 */
export interface GateContext {
  workspace: string
  /** 读盘用（视图、契约、追溯图、ADR 都在文件里） */
  store: SdoStore
  /** 真源日志：门禁签字按 journal 序号判失效、阶段回退留痕都要读它 */
  journal: Journal
  /** 当前流程定义（阶段回退的**合法回退边**按流程数据声明，不硬编码） */
  process: ProcessDef
  project: SdoProject | undefined
  requirements: Requirement[]
  questions: GrillQuestion[]
  risks: RiskItem[]
  issues: RedTeamIssue[]
  feasibility: FeasibilityAssessment | undefined
  redTeamExecuted: boolean
  redTeamDisabled: boolean
  approvedBy?: string | undefined
  /** 已豁免的门禁（来自 tailoring.waivedGates） */
  waivedGates: string[]
  /** 原型目录名与 discard 标记（`.sdo/config.yml`） */
  prototypeDir: string
  prototypeThrowaway: boolean
  /** 螺旋流程的本圈风险结论 */
  riskConclusion: string | undefined
}

function ok(id: string, detail: string): GateCriterionResult {
  return { id, ok: true, detail }
}

function fail(id: string, detail: string, remedy: string): GateCriterionResult {
  return { id, ok: false, detail, remedy }
}

/**
 * **不适用**（N/A）：该准则对这个项目没有意义（增量 1 / §2.1）。
 *
 * 三态语义：`ok: true` 通过 / `ok: false` 失败 / `na: true` 不适用。
 * N/A **既不算失败也不算通过** —— `evaluateGate` 里它不阻止放行，但也不计入通过数；
 * 回执必须显式打印 N/A 与理由（`describeGate` 负责）。
 */
function na(id: string, reason: string): GateCriterionResult {
  return { id, ok: false, na: true, naReason: reason, detail: reason }
}

/** 该目录下是否有"实质内容"（忽略 README.md 与隐藏文件）。 */
function hasSubstantiveContent(dir: string): boolean {  if (!existsSync(dir)) return false
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    if (name === 'README.md') continue
    const target = join(dir, name)
    if (statSync(target).isDirectory()) {
      if (hasSubstantiveContent(target)) return true
      continue
    }
    return true
  }
  return false
}

/** 读文本；读不到返回 undefined（调用方必须据此**判失败**，不允许"查不到就算过"）。 */
function readFileSyncSafe(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 门禁检查器：键与流程数据里的 `criteria[].check` 一一对应。 */
/** 原型是否在本项目「在局」：流程是原型流程，或工作区里已有原型目录（**D3**）。 */
export function prototypeInPlay(ctx: GateContext): boolean {
  if (ctx.project?.process === 'prototype') return true
  return existsSync(join(ctx.workspace, ctx.prototypeDir))
}

/**
 * 一条回退事件**发生时**合法的回退边集合（R-3）。
 *
 * 新事件自带 `legalAtThatTime`（回退当时由流程数据算出的合法边）→ **以事件自证为准**：
 * 之后流程数据把某条边改名/删掉，也不会追溯性地把一条当时合法的回退判红。
 * 老事件（本字段引入之前写的）没有它 → 退回用**当前**流程数据复核，即旧行为，
 * 因此兼容期内不会比过去更严（不会因为"缺字段"本身把历史事件判红）。
 */
function legalRollbackEdgesAtEvent(event: JournalEvent, process: ProcessDef, from: string): string[] {
  const recorded = event.data['legalAtThatTime']
  if (Array.isArray(recorded)) {
    return recorded.filter((item): item is string => typeof item === 'string')
  }
  return legalRollbackTargets(process, from)
}

/**
 * 追溯坏行的**统一前置检查**（P-8）。
 *
 * 凡是用 `report()` 的判据（`trace.orphans` / `trace.coverage` / `tests.passed`）都必须先过它 ——
 * 旧实现只有前两条查坏行，"must 需求都有通过的用例"那条会在同一份**不完整的图**上判绿。
 * 现在只有一处实现（口径不可能再分叉）。
 */
function traceBadLinesFailure(ctx: GateContext, criterionId: string): GateCriterionResult | undefined {
  const data = report(ctx.store, ctx.requirements)
  if (data.badLines === 0) return undefined
  return fail(
    criterionId,
    fmt('uiGates.kTraceBadLines', { p1: String(data.badLines), p2: String(data.totalLines), p3: String(data.total) }),
    t('uiGates.kTraceBadLinesRemedy'),
  )
}

/**
 * **§3（第四份评审员报告，2026-10-02）**：`journal` 被坏行截断时，「以事件流为证据」的判据
 * **不得自信作答** —— `read()` 只返回最后一致前缀，坏行之后的事件一条都读不到，
 * 于是「签字之后改过真源」「渲染过」「跑过红队」这类结论都会**静默冻结在坏行之前**（实测：截断期改需求后
 * G3 签字仍报 `valid`；截断期合法重渲染后 C-25 反而宣布「从来没有任何 `design/rendered` 事件」，
 * 而且按 remedy 再渲染一次也修不好）。
 *
 * 这里统一转成**判红 + 点名坏行**：不是「判不过」，而是「**查不动**」（口径同 `gate.unreadable`）。
 * 修好 `journal.jsonl` 那一行之后，判据自然恢复。
 */
function journalTruncatedFailure(ctx: GateContext, criterionId: string): GateCriterionResult | undefined {
  const read = ctx.journal.read()
  if (!read.truncated) return undefined
  return fail(
    criterionId,
    fmt('uiGates.kJournalTruncated', { p1: String(read.badLine ?? '?') }),
    t('uiGates.kJournalTruncatedRemedy'),
  )
}

export const CHECKERS: Record<string, (ctx: GateContext) => GateCriterionResult> = {
  // —————————————— G2 的 DoR 判据：**按 check 键**挂载（B1） ——————————————
  //
  // 旧实现把 `evaluateDor` 的产出按**判据 id** 顶掉同名判据，于是"配置假装数据驱动，
  // 实际被硬编码劫持"：任何门禁里只要出现同 id 的判据，无论声明的 `check` 是什么都会被顶掉；
  // 而 `baseline` 又根本不走 `evaluateGate`，自己拼一个 `status:'passed'` 落盘 →
  // 流程数据里声明的第 8 条判据（C8 红队议题闭环）**从不被判定**。
  // 现在每个判据都由它自己的 `check` 键唯一决定，`baseline` 走 `evaluateGate` 现算。
  'dor.per_requirement': (ctx) => dorCriterion(ctx, 'C1-dor-per-requirement'),
  'questions.open_p0': (ctx) => dorCriterion(ctx, 'C2-open-questions'),
  'dor.must_has_ac': (ctx) => dorCriterion(ctx, 'C3-must-has-ac'),

  /**
   * **P-5**：验收标准编号**全局唯一**。
   *
   * N-2 只堵住了"以后写不进来"，存量重号（实测某项目 `AC-001`…`AC-005` 被两条需求各用一遍）
   * 既查不出、也没有任何判据会报 —— 而 AC 编号正是交付验收矩阵的追溯键，重号即错配。
   * 这条判据让"查一查"变成一次 `sdo_gate action=check gate=G2`（并点名每一个重号与其归属）。
   */
  'dor.ac_ids_unique': (ctx) => {
    const owners = new Map<string, string[]>()
    for (const requirement of ctx.requirements) {
      for (const ac of requirement.acceptance) {
        owners.set(ac.id, [...(owners.get(ac.id) ?? []), requirement.id])
      }
    }
    const duplicated = [...owners.entries()].filter(([, ids]) => ids.length > 1)
    if (duplicated.length === 0) {
      return ok('dor.ac_ids_unique', fmt('uiGates.kAcIdsUnique', { p1: String(owners.size) }))
    }
    return fail(
      'dor.ac_ids_unique',
      fmt('uiGates.kAcIdsDuplicated', {
        p1: duplicated.map(([id, ids]) => `${id}（${ids.join(' ')}）`).join('；'),
      }),
      t('uiGates.kAcIdsDuplicatedRemedy'),
    )
  },

  'project.scope.in': (ctx) =>
    (ctx.project?.scope.in.length ?? 0) > 0
      ? ok('project.scope.in', fmt('uiGates.k1', { p1: ctx.project?.scope.in.length ?? 0 }))
      : fail('project.scope.in', t('uiGates.k2'), t('uiGates.k3')),

  'project.scope.out': (ctx) =>
    (ctx.project?.scope.out.length ?? 0) > 0
      ? ok('project.scope.out', fmt('uiGates.k4', { p1: ctx.project?.scope.out.length ?? 0 }))
      : fail('project.scope.out', t('uiGates.k5'), t('uiGates.k6')),

  'project.stakeholders': (ctx) =>
    (ctx.project?.stakeholders.length ?? 0) > 0
      ? ok('project.stakeholders', fmt('uiGates.k7', { p1: ctx.project?.stakeholders.length ?? 0 }))
      : fail('project.stakeholders', t('uiGates.k8'), t('uiGates.k9')),

  'project.metrics': (ctx) => {
    const metrics = ctx.project?.metrics.success ?? []
    if (metrics.length === 0) {
      return fail('project.metrics', t('uiGates.k10'), t('uiGates.k11'))
    }
    const measurable = metrics.some((metric) => /\d/u.test(metric))
    return measurable
      ? ok('project.metrics', fmt('uiGates.k12', { p1: metrics.length }))
      : fail('project.metrics', fmt('uiGates.k13', { p1: metrics.join('；') }), t('uiGates.k14'))
  },

  'project.glossary': (ctx) => {
    const terms = Object.keys(ctx.project?.glossary ?? {})
    return terms.length > 0
      ? ok('project.glossary', fmt('uiGates.k15', { p1: terms.length }))
      : fail('project.glossary', t('uiGates.k16'), t('uiGates.k17'))
  },

  'feasibility.verdict': (ctx) => {
    const assessment = ctx.feasibility
    if (assessment === undefined) return fail('feasibility.verdict', t('uiGates.k18'), t('uiGates.k19'))
    return assessment.verdict === 'go'
      ? ok('feasibility.verdict', t('uiGates.k20'))
      : fail('feasibility.verdict', fmt('uiGates.k21', { p1: assessment.verdict }), t('uiGates.k22'))
  },

  'feasibility.risks': (ctx) => {
    const stats = riskStats(ctx.risks)
    if (stats.total === 0) return fail('feasibility.risks', t('uiGates.k23'), t('uiGates.k24'))
    if (stats.unmitigated.length > 0) {
      return fail(
        'feasibility.risks',
        fmt('uiGates.k25', { p1: stats.unmitigated.map((risk) => risk.id).join(' ') }),
        t('uiGates.k26'),
      )
    }
    return ok('feasibility.risks', fmt('uiGates.k27', { p1: stats.total, p2: stats.high, p3: stats.blockers }))
  },

  'feasibility.poc': (ctx) => {
    const poc = ctx.feasibility?.poc ?? []
    return poc.length > 0
      ? ok('feasibility.poc', fmt('uiGates.k28', { p1: poc.length }))
      : fail('feasibility.poc', t('uiGates.k29'), t('uiGates.k30'))
  },

  'redteam.executed': (ctx) => {
    // §3：截断期不得拿「最后一致前缀」自信作答（先报「查不动」）
    const truncated = journalTruncatedFailure(ctx, 'redteam.executed')
    if (truncated !== undefined) return truncated
    const scale = ctx.project?.tailoring?.scale ?? 'normal'
    if (scale === 'trivial') return ok('redteam.executed', t('uiGates.k31'))
    if (ctx.redTeamExecuted) return ok('redteam.executed', t('uiGates.k32'))
    if (ctx.redTeamDisabled) return ok('redteam.executed', t('uiGates.k33'))
    return fail('redteam.executed', t('uiGates.k34'), t('uiGates.k35'))
  },

  'redteam.closed': (ctx) => {
    if (ctx.issues.length === 0) {
      return fail('redteam.closed', t('uiGates.k36'), t('uiGates.k37'))
    }
    const open = ctx.issues.filter((issue) => !issueClosure(issue, ctx.questions, ctx.risks).closed)
    if (open.length === 0) return ok('redteam.closed', fmt('uiGates.k38', { p1: ctx.issues.length }))
    return fail(
      'redteam.closed',
      fmt('uiGates.k39', { p1: open.map((issue) => issue.id).join(' ') }),
      t('uiGates.k40'),
    )
  },

  /**
   * 人类签字（G2 的 C7）—— **以签字台账为准**（D1）。
   *
   * 旧实现只看 `approvedBy` 这个**入参字符串**（模型能自授）。现在：
   *   · 通过与失败**只**由 `signatureState(store, journal, 'G2')` 决定；
   *   · `approvedBy` 作为**附加信息**照实写进 detail（不静默忽略，但不再是放行依据）；
   *   · detail 里同时给出该门禁的**失效事件集合**（与判定同源），
   *     读回执的人一眼能看到"签字之后哪些真源变更会让它失效"。
   */
  'human.signoff': (ctx) => {
    const ledger = signatureState(ctx.store, ctx.journal, 'G2')
    const signer = (ctx.approvedBy ?? '').trim()
    const extra = signer === '' ? t('uiGates.kSignoffApprovedByAbsent') : fmt('uiGates.kSignoffApprovedByExtra', { p1: signer })
    const events = signatureInvalidatingEventLine('G2')
    if (ledger.status === 'valid') {
      return ok('human.signoff', `${ledger.reason}${extra}${events}`)
    }
    return fail('human.signoff', `${ledger.reason}${extra}${events}`, t('uiGates.kSignoffRemedy'))
  },

  'prototype.timebox': (ctx) => {
    // **D3 / §一.5 统一**：本流程不涉及原型（且没有原型目录）时判 **N/A + 理由**。
    // 旧写法在这里返回 `ok`：语义上把"不适用"混进了"通过"，回执看不出区别，
    // 也会让"通过数"虚高。现在与 `ui.confirmed` 同一口径（三态 N/A）。
    if (!prototypeInPlay(ctx)) return na('prototype.timebox', t('uiGates.kPrototypeNa'))
    const dir = join(ctx.workspace, ctx.prototypeDir)
    const hasContent = hasSubstantiveContent(dir)
    if (!hasContent) {
      return fail('prototype.timebox', fmt('uiGates.k44', { p1: ctx.prototypeDir }), t('uiGates.k45'))
    }
    return ctx.prototypeThrowaway
      ? ok('prototype.timebox', t('uiGates.k47'))
      : fail('prototype.timebox', t('uiGates.k48'), t('uiGates.k49'))
  },

  'prototype.backfilled': (ctx) => {
    // 同上：不适用 → N/A + 理由（不是"通过"）
    if (!prototypeInPlay(ctx)) return na('prototype.backfilled', t('uiGates.kPrototypeBackfilledNa'))
    const fromPrototype = ctx.requirements.filter((requirement) => requirement.source.prototype === true)
    if (fromPrototype.length > 0) {
      return ok('prototype.backfilled', fmt('uiGates.k51', { p1: fromPrototype.length }))
    }
    const protoExists = existsSync(join(ctx.workspace, ctx.prototypeDir))
    return fail(
      'prototype.backfilled',
      protoExists ? t('uiGates.k52') : t('uiGates.k53'),
      t('uiGates.k54'),
    )
  },

  'prototype.excluded': (ctx) => {
    const dir = join(ctx.workspace, ctx.prototypeDir)
    if (!existsSync(dir)) return ok('prototype.excluded', fmt('uiGates.k55', { p1: ctx.prototypeDir }))
    if (!hasSubstantiveContent(dir)) return ok('prototype.excluded', fmt('uiGates.k56', { p1: ctx.prototypeDir }))
    return fail(
      'prototype.excluded',
      fmt('uiGates.k57', { p1: ctx.prototypeDir }),
      fmt('uiGates.k58', { p1: ctx.prototypeDir }),
    )
  },

  'risks.logged': (ctx) => {
    const stats = riskStats(ctx.risks)
    return stats.total > 0
      ? ok('risks.logged', fmt('uiGates.k59', { p1: stats.total, p2: stats.open }))
      : fail('risks.logged', t('uiGates.k60'), t('uiGates.k61'))
  },

  'risks.mitigated': (ctx) => {
    const stats = riskStats(ctx.risks)
    return stats.unmitigated.length === 0
      ? ok('risks.mitigated', t('uiGates.k62'))
      : fail(
          'risks.mitigated',
          fmt('uiGates.k63', { p1: stats.unmitigated.map((risk) => risk.id).join(' ') }),
          t('uiGates.k64'),
        )
  },

  /**
   * **设计适用性声明**（§7.1 / §7.5）—— 本判据只查"声明本身"。
   *
   * 存量项目没有声明 → **判红**，detail 必须写「未声明适用性」（§7.6 第 6 条要求
   * 提示是"未声明适用性"而不是其它原因）。
   * 声明有结构问题（缺 focus / 某个视图**既未列入 present 也未说明 absent** /
   * `viewsAbsent` 缺理由）→ 判红并逐条列出（§7.4「必须显式二选一」）。
   */
  'design.applicability': (ctx) => {
    const state = applicabilityState(ctx.store)
    if (state.status === 'missing') return fail('design.applicability', t('uiGates.kApplicabilityMissing'), t('uiGates.kApplicabilityRemedy'))
    // 声明的**逐条内容**（哪些视图做、哪些不做及理由）必须出现在回执里 ——
    // 「不得静默」是 §7.1 的硬要求，回执是模型唯一能读到它的地方之一。
    const shown = applicabilityLines(state.declaration).join('；')
    if (state.status === 'incomplete') {
      return fail(
        'design.applicability',
        fmt('uiGates.kApplicabilityIncomplete', { p1: state.problems.join('；') }),
        t('uiGates.kApplicabilityRemedy'),
      )
    }
    const app = state.declaration
    return ok(
      'design.applicability',
      fmt('uiGates.kApplicabilityOk', {
        p1: app?.viewsPresent.length ?? 0,
        p2: app?.viewsAbsent.length ?? 0,
        p3: shown,
      }),
    )
  },

  /**
   * 五视图（§7.4）：`viewsPresent` 的视图必须**非空**（受影响部分有内容即可）；
   * `viewsAbsent` 的视图判 **N/A + 该条声明理由**；既未列入 present 也未说明 absent 的视图
   * → 判红（必须显式二选一）。没有声明时不在这里重复判红（由 `design.applicability` 负责）。
   *
   * **Y-4（本报告）**：声明里还可以写第 6 个视图 `ui`，而它此前**不产生任何规则** ——
   * 声明说"界面视图：做"，门禁却一个字都不查（只靠 C-27 兜底；而 C-27 在
   * `surfaces` 未声明时直接 N/A），于是"声明了但无人检查"。现在：声明 `ui` 为 present
   * 就必须真有界面证据（`uiDecision`），否则判红。
   */
  'design.views': (ctx) => {
    const app = applicabilityState(ctx.store).declaration
    if (app === undefined) return fail('design.views', t('uiGates.kApplicabilityMissing'), t('uiGates.kApplicabilityRemedy'))
    const rules = viewRules(app)
    if (rules.length === 0) return fail('design.views', t('uiGates.kNoPresentView'), t('uiGates.kNoPresentViewRemedy'))
    // M7：同一份声明里既 present 又 absent = 自相矛盾 → 判红（不再静默取 present）
    const conflicted = rules.filter((rule) => rule.conflict === true).map((rule) => viewLabel(rule.kind))
    if (conflicted.length > 0) {
      return fail('design.views', fmt('uiGates.kViewConflict', { p1: conflicted.join(' ') }), t('uiGates.kViewConflictRemedy'))
    }
    // Y-4：声明要做的界面视图必须有界面证据
    if (app.viewsPresent.includes('ui') && !uiDecision(ctx.project, ctx.requirements).hasUi) {
      return fail('design.views', t('uiGates.kViewsUiDeclaredButAbsent'), t('uiGates.kViewsUiRemedy'))
    }
    const views = viewsCompleteness(ctx.store)
    const presentRules = rules.filter((rule) => rule.state === 'present')
    const missing: string[] = []
    const empty: string[] = []
    for (const rule of presentRules) {
      if (!views.present.includes(rule.kind)) missing.push(viewLabel(rule.kind))
      else if (views.empty.includes(rule.kind)) empty.push(viewLabel(rule.kind))
    }
    if (missing.length > 0) return fail('design.views', fmt('uiGates.k66', { p1: missing.join(' ') }), t('uiGates.k68'))
    if (empty.length > 0) return fail('design.views', fmt('uiGates.k67', { p1: empty.join(' ') }), t('uiGates.k68'))
    const absent = rules.filter((rule) => rule.state === 'absent')
    if (absent.length === 0) {
      return ok('design.views', fmt('uiGates.k65', { p1: presentRules.length }))
    }
    // 有 absent 视图：**判 N/A + 逐条理由**（"不适用"必须让用户看见，不是静默通过）
    return na(
      'design.views',
      fmt('uiGates.kViewsNa', {
        p1: presentRules.length,
        p2: absent.map((rule) => `${viewLabel(rule.kind)}（${rule.why}）`).join('；'),
      }),
    )
  },

  /**
   * **声明的必需工件**（§7.1「`artifacts` 里的工件必须齐备；未列入的不要求」）。
   *
   * 三态：
   *   · 声明里 `artifacts` 与 `artifactsAbsent` **都没列** → **N/A + 理由**（本项目不做这些工件）；
   *   · `artifactsAbsent` 有条目但**缺 why** → **判红并点名**（D5：声明为不做却没写理由，
   *     与 `viewsAbsent` 同口径 —— "不做"必须给得出理由，不能沉默）；
   *   · 声明了要做但缺 → 判红。更严的同类检查在 `design.method-products`（`porting` 包）。
   */
  'design.artifacts': (ctx) => {
    const app = applicabilityState(ctx.store).declaration
    if (app === undefined) return fail('design.artifacts', t('uiGates.kApplicabilityMissing'), t('uiGates.kApplicabilityRemedy'))
    const required = requiredArtifacts(app)
    const absent = absentArtifacts(app)
    // D5：逐条 why 必填 —— 先于"要不要工件"判定，因为"不做"本身也要给理由。
    const noWhy = absent.filter((item) => textOf(item.why).trim() === '')
    if (noWhy.length > 0) {
      return fail(
        'design.artifacts',
        fmt('uiGates.kArtifactsAbsentNoWhy', { p1: noWhy.map((item) => artifactLabel(item.kind)).join('、') }),
        t('uiGates.kArtifactsRemedy'),
      )
    }
    if (required.length === 0 && absent.length === 0) {
      return na('design.artifacts', t('uiGates.kArtifactsNa'))
    }
    // D5：也不许"既说做又说不做"自相矛盾（`normalizeApplicability` 会去掉这种写法，
    // 但手写真源能绕过去 —— 门禁必须判红而不是静默取一边）。
    const both = required.filter((kind) => absent.some((item) => item.kind === kind))
    if (both.length > 0) {
      return fail(
        'design.artifacts',
        fmt('uiGates.kArtifactsBoth', { p1: both.map((kind) => artifactLabel(kind)).join('、') }),
        t('uiGates.kArtifactsRemedy'),
      )
    }
    if (required.length === 0) {
      // 只声明了"不做"：这是**显式的**不做（逐条带理由），与"一个都没声明"不同 —— 回执要写出理由。
      return ok(
        'design.artifacts',
        fmt('uiGates.kArtifactsAbsentOk', {
          p1: absent.map((item) => `${artifactLabel(item.kind)}（${item.why}）`).join('；'),
        }),
      )
    }
    const missing = missingArtifacts(app, ctx.store)
    if (missing.length === 0) {
      return ok('design.artifacts', fmt('uiGates.kArtifactsOk', { p1: required.map((kind) => artifactLabel(kind)).join('、') }))
    }
    return fail(
      'design.artifacts',
      fmt('uiGates.kArtifactsMissing', { p1: missing.map((kind) => artifactLabel(kind)).join('、') }),
      t('uiGates.kArtifactsRemedy'),
    )
  },

  /**
   * **门禁级用户签字**（§7.2）—— 未签字 / 无引用 / 签字后真源变更 → **判红**，
   * 即便其余判据全绿也不可通过。
   *
   * 「无引用文本的签字视为无效」是本检查器的核心：`signatureState` 只承认带
   * 用户原话引用或所选选项原文的签字记录（防模型代签）。
   */
  'design.signed': (ctx) => {
    const state = signatureState(ctx.store, ctx.journal, 'G3')
    if (state.status === 'valid') {
      const signature = state.signature
      return ok(
        'design.signed',
        fmt('uiGates.kSigned', {
          p1: signature?.by ?? '',
          p2: signature?.basis ?? '',
          p3: channelLabel(signature?.channel ?? 'question'),
        }),
      )
    }
    return fail('design.signed', state.reason, t('uiGates.kSignedRemedy'))
  },

  /**
   * 阶段回退留痕（§6.1 / R-3）：回退必须有 reason，且只能沿**事件发生时**声明的合法边。
   *
   * 与旧实现的区别有两点，都是为了可追溯性：
   *   · **逐条校验全部**回退事件（旧实现只看最后一条，中间某条非法不会被发现）；
   *   · 合法性以**事件自证**（`legalAtThatTime`）为准，不再用「当前」流程数据追溯历史
   *     （旧实现会在流程数据改名/删边后，把一条当时合法的历史回退判红，诊断指向错误对象）。
   */
  'phase.rollback-recorded': (ctx) => {
    // §3：截断期不得拿「最后一致前缀」自信作答（先报「查不动」）
    const truncated = journalTruncatedFailure(ctx, 'phase.rollback-recorded')
    if (truncated !== undefined) return truncated
    const rolled = ctx.journal.read().events.filter((event) => event.type === 'phase/rolled-back')
    if (rolled.length === 0) return ok('phase.rollback-recorded', t('uiGates.kRollbackNone'))

    // **Z-4**：本判据的**强度**必须让审计者看得见 —— 合法性以事件自带的 `legalAtThatTime` 自证，
    // 不用当前流程数据追溯历史（有意如此：流程数据改名/删边不该把当时合法的回退追溯判非法）。
    // 代价是"手写一条自证合法的事件"能过，所以详情里必须写明来源，而不是让人以为它校验了流程数据。
    const evidenceNote = t('uiGates.kRollbackEvidenceNote')
    const problems: string[] = []
    const recorded: string[] = []
    for (const event of rolled) {
      const from = String(event.data['from'] ?? '')
      const to = String(event.data['to'] ?? '')
      if (String(event.data['reason'] ?? '').trim() === '') {
        problems.push(fmt('uiGates.kRollbackNoReasonAt', { p1: from, p2: to }))
        continue
      }
      const legal = legalRollbackEdgesAtEvent(event, ctx.process, from)
      if (!legal.includes(to)) {
        problems.push(fmt('uiGates.kRollbackIllegal', { p1: from, p2: to, p3: legal.join(' ') }))
        continue
      }
      recorded.push(fmt('uiGates.kRollbackOk', { p1: from, p2: to }))
    }
    if (problems.length > 0) {
      return fail('phase.rollback-recorded', `${problems.join('\n')}\n${evidenceNote}`, t('uiGates.kRollbackRemedy'))
    }
    // 全部合规：把每一条都列出来（不是只报最后一条）
    return ok('phase.rollback-recorded', `${recorded.join('\n')}\n${evidenceNote}`)
  },

  'design.adr': (ctx) => {
    const result = adrCompleteness(ctx.store)
    if (result.ok) return ok('design.adr', fmt('uiGates.k69', { p1: result.total }))
    if (result.total === 0) return fail('design.adr', t('uiGates.k70'), t('uiGates.k71'))
    return fail('design.adr', fmt('uiGates.k72', { p1: result.incomplete.join(' ') }), t('uiGates.k73'))
  },

  'trace.orphans': (ctx) => {
    const data = report(ctx.store, ctx.requirements)
    const orphans = [...data.orphans.design, ...data.orphans.tasks, ...data.orphans.tests]
    if (ctx.requirements.length === 0) return fail('trace.orphans', t('uiGates.k74'), t('uiGates.k75'))
    // **N-3 / P-8**：坏行不得静默（判红而不是只告警：本项目纪律是"查不到不能算过"）
    const bad = traceBadLinesFailure(ctx, 'trace.orphans')
    if (bad !== undefined) return bad
    if (orphans.length === 0) return ok('trace.orphans', fmt('uiGates.k76', { p1: Math.round(data.coverage * 100) }))
    return fail(
      'trace.orphans',
      fmt('uiGates.k77', { p1: orphans.join(' ') }),
      t('uiGates.k78'),
    )
  },

  'design.contracts': (ctx) => {
    const result = contractCoverage(ctx.store)
    // F-16：**名字与字段方向矛盾**的存量契约（D4-2 之前的写入）只做提示，不改判据通过与否 ——
    // 报告 §6.6.1 证明自动判定哪边错会改错一半记录，所以只把它摆到门禁详情里让人核对。
    const anomalies = contractDirectionAnomalies(ctx.store)
    const anomalyNote = anomalies.length === 0
      ? ''
      : `；${fmt('uiGates.kContractsDirectionAnomaly', { p1: String(anomalies.length), p2: anomalies.slice(0, 8).map((item) => item.id).join(' ') })}`
    // F-20：手写 YAML 把契约字段写成 number/boolean/对象时的类型提示。
    // number/boolean 只提示写法（已按字符串使用，**不判红**）；对象/数组按空缺处理（判红，但给可读的修正办法）。
    const fieldNoteLines = contractFieldNoteLines(contractFieldNotes(ctx.store))
    const fieldNote = fieldNoteLines.length === 0
      ? ''
      : `；${fmt('uiGates.kContractsFieldNote', { p1: fieldNoteLines.join('；') })}`
    if (result.ok) return ok('design.contracts', fmt('uiGates.k79', { p1: result.covered, p2: result.totalEdges }) + anomalyNote + fieldNote)
    const problems: string[] = []
    if (result.totalEdges === 0) problems.push(t('uiGates.k80'))
    if (result.missing.length > 0) {
      problems.push(fmt('uiGates.k81', { p1: result.missing.map((edge) => `${edge.consumer}→${edge.producer}`).join(' ') }))
    }
    if (result.incompleteSemantics.length > 0) problems.push(fmt('uiGates.k82', { p1: result.incompleteSemantics.join(' ') }))
    return fail('design.contracts', problems.join('；') + anomalyNote + fieldNote, t('uiGates.k83'))
  },

  // —————————————— 增量 1：设计交互闭环（A）+ 界面视图（C）+ 设计文档（D） ——————————————

  /**
   * 开放设计问题 = 0（§5）。
   *
   * 口径：**只看设计问题**（`origin === 'design'`）。需求问题由 G2 的 DoR 判据管，
   * 两条门禁各管自己的问题账本，不互相污染。
   * 未回答、或"未获用户授权的假设"都算未决（`isEffectivelyOpen` 口径）。
   */
  'design.no-open-questions': (ctx) => {
    const all = listDesignQuestions(ctx.store)
    const open = all.filter((question) => isEffectivelyOpen(question))
    if (all.length === 0) {
      // 一条设计问题都没有 = 从来没问过 —— 这不是"通过"，而是**没做交互**（§1.3 的根因所在）
      return fail('design.no-open-questions', t('uiGates.kNoQuestionsAsked'), t('uiGates.kNoOpenQuestionsRemedy'))
    }
    return open.length === 0
      ? ok('design.no-open-questions', t('uiGates.kNoOpenQuestions'))
      : fail(
          'design.no-open-questions',
          fmt('uiGates.kOpenQuestions', { p1: open.length }) + `（${open.map((question) => question.id).join(' ')}）`,
          t('uiGates.kNoOpenQuestionsRemedy'),
        )
  },

  /** 关键条目（元素 / 契约 / 界面条目）均有用户确认戳（§5）。 */
  'design.confirmed': (ctx) => {
    const gaps = confirmGaps(ctx.store, ctx.project, ctx.requirements)
    // Y-7：**已找不到对应条目的旧确认戳**不进"必须确认"清单（它们不是待办），
    // 但必须在门禁详情里被看见 —— 否则"用户以为确认过、门禁不再提"就是静默。
    const orphanNote = gaps.orphan.length === 0
      ? ''
      : `；${fmt('uiGates.kOrphanConfirmations', {
          p1: String(gaps.orphan.length),
          p2: gaps.orphan.map((item) => item.target).join(' '),
        })}`
    if (gaps.required.length === 0) {
      return na('design.confirmed', t('uiGates.kNoKeyItems') + orphanNote)
    }
    const ui = uiDecision(ctx.project, ctx.requirements)
    const uiItems = ui.hasUi
      ? gaps.required.filter((target) => target.startsWith('ui:') || target.includes(':columns') || target.includes(':layout')).length
      : 0
    const structural = gaps.required.length - uiItems
    if (gaps.missing.length === 0) {
      return ok('design.confirmed', fmt('uiGates.kConfirmed', { p1: structural, p2: listContracts(ctx.store).filter((contract) => contract.dropped !== true).length, p3: uiItems }) + orphanNote)
    }
    // F-19：把"从未确认"与"确认过但**内容已变**"分开说 —— 后者是"你的确认被静默作废了"，
    // 与"你还没确认"是完全不同的两件事，混作一句会让用户以为自己在原地踏步。
    const staleTargets = new Set(gaps.stale.map((item) => item.target))
    const never = gaps.missing.filter((target) => !staleTargets.has(target))
    const changed = gaps.missing.filter((target) => staleTargets.has(target))
    const problems: string[] = []
    if (never.length > 0) problems.push(fmt('uiGates.kUnconfirmed', { p1: never.join(' ') }))
    if (changed.length > 0) problems.push(fmt('uiGates.kUnconfirmedStale', { p1: changed.join(' ') }))
    return fail('design.confirmed', problems.join('；'), t('uiGates.kConfirmedRemedy'))
  },

  /**
   * `docs/DESIGN.md` 存在、含 11 个固定章节，**且由当前真源渲染**（X-1）。
   *
   * 旧实现只做两件事：`existsSync` + 检查 11 个标题字符串是否出现 ——
   * 于是"任意一份含这 11 个标题的旧文件"都能过门禁：文档里与真源**直接相反**的陈述
   * （实测：文档写"缺省未声明 layout.stack"，而真源已有 6 处 `stack: vertical`）照样判绿。
   * 现在渲染头写入 `<!-- source: .sdo/design @ journal seq N -->`，判定比对：
   *   · 头缺失 → 无法证明由真源渲染 → **判红**；
   *   · 渲染之后又出现会改变文档内容的事件（`DESIGN_DOC_SOURCE_EVENTS`）→ **判红**。
   */
  'design.doc': (ctx) => {
    // §3：截断期不得拿「最后一致前缀」自信作答（先报「查不动」）
    const truncated = journalTruncatedFailure(ctx, 'design.doc')
    if (truncated !== undefined) return truncated
    const path = join(ctx.workspace, 'docs', 'DESIGN.md')
    if (!existsSync(path)) {
      return fail('design.doc', t('uiGates.kDesignDocMissing'), t('uiGates.kDesignDocRemedy'))
    }
    const text = readFileSyncSafe(path)
    if (text === undefined) {
      // 读不到就是查不了 —— 不允许"查不到就算过"
      return fail('design.doc', fmt('uiGates.kDesignDocUnreadable', { p1: 'docs/DESIGN.md' }), t('uiGates.kDesignDocRemedy'))
    }
    // **P-15**：声明的语言必须是**随包语言**之一。旧实现接受任意串并静默回落当前语言，
    // 于是 `<!-- meta: lang en -->` 配中文正文会报"缺英文标题"、remedy 指向"重新渲染"——
    // 原因（头在撒谎/写错）与提示完全不符。
    const declaredLang = parseRenderLang(text)
    if (declaredLang !== undefined && !LANGUAGES.includes(declaredLang)) {
      return fail(
        'design.doc',
        fmt('uiGates.kDesignDocLangUnknown', { p1: declaredLang, p2: LANGUAGES.join(' / ') }),
        t('uiGates.kDesignDocRemedy'),
      )
    }
    // **R-10**：阶段声明必须是**当前流程里真实存在**的 id（语言那一侧早有白名单，阶段这侧此前没有）。
    // 阶段只出现在渲染头里、不进正文，所以"整份文件比对"拦不住伪造 —— 实测把它改成
    // `delivery` / `99` 都照样判绿，于是文档在审计上可以说"我是在交付阶段渲染的"。
    const declaredPhase = parseRenderPhase(text)
    if (declaredPhase !== undefined && declaredPhase !== '' && !ctx.process.phases.some((item) => item.id === declaredPhase)) {
      return fail(
        'design.doc',
        fmt('uiGates.kDesignDocPhaseUnknown', { p1: declaredPhase, p2: ctx.process.phases.map((item) => item.id).join(' / ') }),
        t('uiGates.kDesignDocRemedy'),
      )
    }
    // **N-11：先定"这份文档是哪种语言渲染的"**，后面每一关都按它取文案 ——
    // 否则中文渲染的文档在 en 会话里会因为"找不到英文标题"被判缺章节（假红），
    // 照着 remedy 重渲染成英文后，切回 zh-CN 又反向假红。
    const lang = declaredLang ?? locale()
    const missing = withLocale(lang, () => DESIGN_DOC_SECTIONS.filter((key) => !text.includes(t(key))))
    if (missing.length > 0) {
      return fail('design.doc', withLocale(lang, () => fmt('uiGates.kDesignDocIncomplete', { p1: missing.map((key) => t(key)).join('；') })), t('uiGates.kDesignDocRemedy'))
    }
    const seq = parseRenderSeq(text)
    if (seq === undefined) {
      return fail('design.doc', t('uiGates.kDesignDocUnproven'), t('uiGates.kDesignDocRemedy'))
    }
    // **N-8 ①：序号必须有上界。** 旧实现只做 `event.seq > seq` 的单侧比较，
    // 于是把渲染头伪造成一个**未来序号**（`journal seq 99999999`）就能让任何陈旧/伪造文档
    // 永久判绿 —— "文档即证据"变成了"文档对自己的声明"。
    const events = ctx.journal.read().events
    const maxSeq = events.at(-1)?.seq ?? 0
    if (seq < 1 || seq > maxSeq) {
      return fail(
        'design.doc',
        fmt('uiGates.kDesignDocSeqOutOfRange', { p1: String(seq), p2: String(maxSeq) }),
        t('uiGates.kDesignDocRemedy'),
      )
    }
    // **P-14 / R-10**：让"渲染过"与"渲染时的阶段"都**可证**。
    //
    // **F-1（sdo-test 回归报告，blocker）**：一次渲染会写**两条**同 `seq` 的 `design/rendered`
    // 事件 —— 文档一条（`kind: DESIGN.md`，带 `phase`）、可选的 puml 骨架一条（`kind: <路径>.puml`）。
    // 旧实现只按 `type + seq` 过滤后取 `.at(-1)`，于是**后写的 puml 事件顶替了文档事件**：
    // 它的 `phase` 为空 → 判据报"头里的阶段被改过"，把工具自身的行为说成用户伪造（`render --puml` 后必红）。
    // 现在：只让**文档自己**的事件参与背书（`kind` 是文档；同 seq 的其它产物一律不参与）。
    const renderEvents = events.filter(
      (event) => event.type === 'design/rendered' && Number(event.data['seq']) === seq,
    )
    const docEvents = renderEvents.filter((event) => String(event.data['kind'] ?? '') === 'DESIGN.md')
    const attested = (docEvents.length > 0 ? docEvents : renderEvents).at(-1)
    if (renderEvents.length === 0) {
      return fail(
        'design.doc',
        fmt('uiGates.kDesignDocNoRenderEvent', { p1: String(seq) }),
        t('uiGates.kDesignDocRemedy'),
      )
    }
    // 头里写了阶段时，必须与事件载荷里的阶段**完全一致**（事件在追加式真源里，伪造不了）
    const attestedPhase = String(attested?.data['phase'] ?? '')
    if (declaredPhase !== undefined && declaredPhase !== '' && declaredPhase !== attestedPhase) {
      return fail(
        'design.doc',
        fmt('uiGates.kDesignDocPhaseForged', { p1: declaredPhase, p2: attestedPhase === '' ? t('uiGates.kDesignDocPhaseNone') : attestedPhase }),
        t('uiGates.kDesignDocRemedy'),
      )
    }
    // **P-14**：让"渲染过"这件事**可证**。旧实现只认头里的数字，没有任何一处校验该序号上
    // 真的发生过一次 `design/rendered` —— 于是"头声称渲染过"与"真的渲染过"在判据眼里没有区别。
    // 注意事件**自身**的 seq 是下一条，这里比的是事件载荷里的 `seq`（= 渲染前的序号）。
    const changed = events
      .filter((event) => event.seq > seq)
      .filter((event) => (DESIGN_DOC_SOURCE_EVENTS as readonly string[]).includes(event.type))
    if (changed.length > 0) {
      const first = changed[0]
      return fail(
        'design.doc',
        fmt('uiGates.kDesignDocStale', { p1: String(seq), p2: String(first?.seq ?? 0), p3: first?.type ?? '' }),
        t('uiGates.kDesignDocRemedy'),
      )
    }
    // **N-8 ② + P-15：整份文件必须等于"当前真源按头里的元信息重渲染"的结果。**
    // 比的是**整份文件**（含开头注释区）而不只是正文 —— 旧实现剥掉头部注释再比，
    // 于是任何人都能在文档顶部写任意声明（实测 `<!-- 已人工核对… -->`）而门禁一个字都不看。
    // 语言、阶段都取**头里声明的值**（它们是说明性元数据，与真源无关，见 N-8 的设计说明），
    // 因此 advance/rollback 或切语言都不会把文档判成"与真源不一致"。
    const expected = withLocale(lang, () =>
      renderDesignDocCached({
        workspace: ctx.workspace,
        store: ctx.store,
        project: ctx.project,
        requirements: ctx.requirements,
        questions: ctx.questions,
        seq,
        meta: { phase: parseRenderPhase(text) ?? ctx.project?.phase ?? '' },
      }),
    )
    // 写盘会补一个尾换行（`SdoStore.writeText`），比对前把两侧的尾空白归一。
    // **R-12**：行尾也要归一 —— Windows 编辑器把整份文档存成 CRLF 时，内容一字未改却会判红，
    // 而错误文案只说"被手工改过"（用户在 Windows 上会看到"什么都没改却一直红"）。
    const normalize = (value: string): string => stripTrailingNewlines(value.replace(/\r\n?/gu, '\n'))
    if (normalize(text) !== normalize(expected)) {
      return fail('design.doc', t('uiGates.kDesignDocBodyMismatch'), t('uiGates.kDesignDocRemedy'))
    }
    return ok('design.doc', fmt('uiGates.kDesignDoc', { p1: String(seq) }))
  },

  // —————————————— 增量 2：设计方法论方法包（结构化 / 面向对象 / 敏捷-演进式） ——————————————

  /**
   * 方法答案**必须能机械解析**成 `structured|oo|evolutionary|none`（含可多选）。
   *
   * 未回答 / 空答案 / 解析不出来 → **判失败** —— 这是增量 2 要堵的漏洞：
   * 不允许"不选方法就全 N/A 蒙过去"。只有**显式**选择 `none` 才合法。
   *
   * **2026-09-30 合并（C-26 → C-28 的唯一判据）**：此前另有一条 `design.method-chosen`
   * （"选择题已回答"）与它并存，于是同一个问题上回执出现**两条相关判据**，其中一条
   * 还更松（不校验答案能不能解析）。现在只保留本检查器：它的语义严格覆盖前者
   * （未回答 = reason 说明未回答 → 失败），流程数据里也只挂这一条。
   */
  'design.method-selected': (ctx) => {
    const selection = methodSelection(ctx.store)
    if (selection.status === 'chosen') {
      return ok(
        'design.method-selected',
        fmt('uiGates.kMethodSelectedOk', { p1: selection.methods.map((id) => methodLabel(id)).join(' + ') }),
      )
    }
    if (selection.status === 'none') return ok('design.method-selected', t('uiGates.kMethodSelectedNone'))
    return fail('design.method-selected', selection.reason, t('uiGates.kMethodSelectedRemedy'))
  },

  /**
   * 对**每个选中的包**逐条检查最小必产项；缺任一即失败。
   *
   * 三态：显式 `none` → N/A + 理由；未选中的包在 `detail` 里逐包写 N/A + 理由；
   * 方法未回答/非法 → 失败（查不到就算过是禁止的）。
   */
  'design.method-products': (ctx) => {
    const result = methodProducts(ctx.store, ctx.requirements, ctx.workspace)
    if (result.na) return na('design.method-products', result.naReason ?? '')
    return result.ok
      ? ok('design.method-products', result.detail)
      : fail('design.method-products', result.detail, t('uiGates.kMethodProductsRemedy'))
  },

  /**
   * **方法包的人审文档**（用户要求）：选中某包时，`docs/METHOD-<包>.md` 必须存在，
   * 且与台账一致 —— 文档头写 `<!-- method-doc: package=<包> basis=<指纹> -->`，
   * 指纹由插件按该包产物内容现算；台账一改指纹就变 → 旧文档判红（与 C-25 同口径）。
   * 正文还必须提到该包每个条目的 id（否则"文档"可能只是一段感想）。
   */
  'design.method-docs': (ctx) => {
    // 与 `design.method-products` 同源：选择状态现算（没回答/非法 → 该判据 N/A，由方法选择判据去报红）
    const selection = methodSelection(ctx.store)
    if (selection.status === 'none') return na('design.method-docs', t('uiMethod.selectionNone'))
    if (selection.status !== 'chosen') return na('design.method-docs', fmt('uiMethod.pkgUndecided', { p1: '', p2: selection.reason }))
    const packages = selection.methods
    if (packages.length === 0) return na('design.method-docs', t('uiMethod.selectionNone'))
    const problems: string[] = []
    const okLines: string[] = []
    for (const pkg of packages) {
      const label = methodLabel(pkg)
      const status = methodDocStatus(ctx.store, ctx.workspace, pkg)
      if (!status.exists) {
        problems.push(
          fmt('uiGates.kMethodDocMissing', { p1: label, p2: status.path, p3: status.expectedBasis, p4: methodDocHeader(pkg, status.expectedBasis) }),
        )
        continue
      }
      if (status.stale) {
        problems.push(fmt('uiGates.kMethodDocStale', { p1: status.path, p2: status.declaredBasis ?? t('uiGates.kMethodDocNoHeader'), p3: status.expectedBasis }))
        continue
      }
      if (status.missingIds.length > 0) {
        problems.push(fmt('uiGates.kMethodDocIncomplete', { p1: status.path, p2: status.missingIds.join(' ') }))
        continue
      }
      okLines.push(fmt('uiMethod.pkgDocOk', { p1: label, p2: status.path }))
    }
    if (problems.length > 0) return fail('design.method-docs', problems.join('；'), t('uiGates.kMethodDocRemedy'))
    return ok('design.method-docs', okLines.join('；'))
  },

  /** 选中包的产物之间不得自相矛盾（悬空引用 / DFD 流不在数据字典 / 依赖方向违规）。 */
  'design.method-consistency': (ctx) => {
    const result = methodConsistency(ctx.store, ctx.requirements)
    if (result.na) return na('design.method-consistency', result.naReason ?? '')
    return result.ok
      ? ok('design.method-consistency', t('uiGates.kMethodConsistencyOk'))
      : fail(
          'design.method-consistency',
          fmt('uiGates.kMethodConsistencyFail', { p1: result.problems.join('；') }),
          t('uiGates.kMethodConsistencyRemedy'),
        )
  },

  /**
   * 界面确认（§2.1 / §5）：**仅当「含 UI」判定为真**。
   *
   * 判定为假 → **N/A + 理由**（不是失败、也不是通过）。
   * 判定为真但视图为空/未确认 → **判失败**（该做没做）。
   * 判定每次都从需求真源现算（`uiDecision`），所以后期新增 UI 需求立刻翻真。
   */
  'ui.confirmed': (ctx) => {
    const decision = uiDecision(ctx.project, ctx.requirements)
    if (!decision.hasUi) return na('ui.confirmed', decision.reason)
    const result = uiConfirmation(ctx.store)
    if (result.ok) return ok('ui.confirmed', t('uiGates.kUiConfirmed'))
    const stale = new Set(result.stale)
    const problems = [...result.missing, ...result.unconfirmed.filter((target) => !stale.has(target))]
    const parts: string[] = []
    if (problems.length > 0) parts.push(fmt('uiGates.kUiMissing', { p1: problems.join(' ') }))
    // F-19：界面条目确认过但内容改了 → 与"从未确认"分开报。
    if (result.stale.length > 0) parts.push(fmt('uiGates.kUiMissingStale', { p1: result.stale.join(' ') }))
    return fail('ui.confirmed', parts.join('；'), t('uiGates.kUiRemedy'))
  },

  'plan.tasks': (ctx) => {
    const tasks = listTasks(ctx.store)
    if (tasks.length === 0) {
      return fail('plan.tasks', t('uiGates.k84'), t('uiGates.k85'))
    }
    const issues = validatePlan(tasks)
    if (issues.length === 0) return ok('plan.tasks', fmt('uiGates.k86', { p1: tasks.length }))
    return fail(
      'plan.tasks',
      fmt('uiGates.k87', { p1: issues.map((issue) => `${issue.taskId}:${issue.detail}`).join('；') }),
      issues[0]?.remedy ?? t('uiGates.kFixCards'),
    )
  },

  'plan.testplan': (ctx) => {
    const cases = listTestCases(ctx.store)
    if (cases.length === 0) return fail('plan.testplan', t('uiGates.k88'), t('uiGates.k89'))
    const musts = ctx.requirements.filter((requirement) => requirement.priority === 'must')
    const uncovered = musts
      .filter((requirement) => !cases.some((testCase) => testCase.requirement === requirement.id))
      .map((requirement) => requirement.id)
    if (uncovered.length === 0) return ok('plan.testplan', fmt('uiGates.k90', { p1: cases.length, p2: musts.length }))
    return fail('plan.testplan', fmt('uiGates.k91', { p1: uncovered.join(' ') }), fmt('uiGates.k92', { p1: uncovered.join(' ') }))
  },

  'tasks.all_done': (ctx) => {
    const stats = planStats(listTasks(ctx.store))
    if (stats.total === 0) return fail('tasks.all_done', t('uiGates.k93'), t('uiGates.k94'))
    if (stats.allDone) {
      // **D7**：dropped 卡本就没有证据，不得算进"完成但无证据"
      const missingEvidence = listTasks(ctx.store).filter(
        (task) => task.status !== 'dropped' && task.evidence.length === 0,
      )
      const droppedNote = stats.total === stats.active ? '' : t('gate.tasksDroppedNote').replace('{n}', String(stats.total - stats.active))
      return missingEvidence.length === 0
        ? ok('tasks.all_done', `${fmt('gate.tasksAllDone', { n: stats.active })}${droppedNote}`)
        : fail(
            'tasks.all_done',
            `${fmt('gate.tasksMissingEvidence', { ids: missingEvidence.map((task) => task.id).join(' ') })}`,
            t('gate.tasksMissingEvidenceRemedy'),
          )
    }
    return fail(
      'tasks.all_done',
      fmt('gate.tasksIncomplete', {
        list: Object.entries(stats.byStatus)
          // **D7**：dropped 是显式放弃的终态，不是"未完成"
          .filter(([status]) => status !== 'done' && status !== 'verified' && status !== 'dropped')
          .map(([status, count]) => `${t(`taskStatus.${status}`, status)} ${count}`)
          .join('，'),
      }),
      t('gate.tasksAllDoneRemedy'),
    )
  },

  'trace.coverage': (ctx) => {
    const data = report(ctx.store, ctx.requirements)
    const orphans = [...data.orphans.design, ...data.orphans.tasks, ...data.orphans.tests]
    // **N-3 / P-8**：同 `trace.orphans` —— 覆盖率也不得在坏行上判绿。
    const bad = traceBadLinesFailure(ctx, 'trace.coverage')
    if (bad !== undefined) return bad
    if (orphans.length > 0) return fail('trace.coverage', fmt('uiGates.k95', { p1: orphans.join(' ') }), t('uiGates.k96'))
    if (data.uncoveredMust.length > 0) return fail('trace.coverage', fmt('uiGates.k97', { p1: data.uncoveredMust.join(' ') }), t('uiGates.k98'))
    return ok('trace.coverage', fmt('uiGates.k99', { p1: Math.round(data.coverage * 100) }))
  },

  'tests.passed': (ctx) => {
    const stats = verificationStats(ctx.store)
    if (stats.cases === 0) return fail('tests.passed', t('uiGates.k100'), t('uiGates.k101'))
    if (stats.results === 0) return fail('tests.passed', t('uiGates.k102'), t('uiGates.k103'))
    if (stats.failed > 0) return fail('tests.passed', fmt('uiGates.k104', { p1: stats.failedCaseIds.join(' ') }), t('uiGates.k105'))
    const unrun = listTestCases(ctx.store)
      .filter((testCase) => !listTestResults(ctx.store).some((result) => result.caseId === testCase.id))
      .map((testCase) => testCase.id)
    if (unrun.length > 0) return fail('tests.passed', fmt('uiGates.k106', { p1: unrun.join(' ') }), t('uiGates.k107'))
    // **G-02**：判据描述承诺「全部 must REQ 有通过的测试用例」，实现却只数用例计数 ——
    // 于是"删掉一条用例"或"新增 must 需求"都不会让这条判据变红（假保证）。这里补上真覆盖校验。
    // **P-8**：同族判据的坏行前置检查也要有 —— 否则一旦 C-21 被豁免，这条就会在坏行上判绿。
    const bad = traceBadLinesFailure(ctx, 'tests.passed')
    if (bad !== undefined) return bad
    const trace = report(ctx.store, ctx.requirements)
    if (trace.uncoveredMust.length > 0) {
      return fail(
        'tests.passed',
        fmt('uiGates.k108', { p1: trace.uncoveredMust.join(' ') }),
        t('uiGates.k109'),
      )
    }
    return ok('tests.passed', fmt('uiGates.k110', { p1: stats.cases, p2: stats.passed }))
  },

  'defects.closed': (ctx) => {
    const stats = verificationStats(ctx.store)
    if (stats.blockersOpen > 0) {
      const open = listDefects(ctx.store)
        .filter((defect) => defect.severity === 'blocker' && defect.status !== 'closed' && defect.status !== 'wontfix')
        .map((defect) => defect.id)
      return fail('defects.closed', fmt('uiGates.k111', { p1: open.join(' ') }), t('uiGates.k112'))
    }
    return ok('defects.closed', fmt('uiGates.k113', { p1: stats.defectsOpen }))
  },

  'review.independent': (ctx) => {
    const reviews = listReviews(ctx.store)
    const tasks = listTasks(ctx.store)
    const violations = independenceViolations(reviews, tasks)
    if (violations.length > 0) {
      return fail('review.independent', violations.map((item) => item.detail).join('；'), t('uiGates.k114'))
    }
    const doneTasks = tasks.filter((task) => task.status === 'done' || task.status === 'verified')
    const unreviewed = doneTasks.filter((task) => !reviews.some((review) => review.taskId === task.id && review.verdict === 'pass')).map((task) => task.id)
    if (unreviewed.length > 0) {
      return fail('review.independent', fmt('uiGates.k115', { p1: unreviewed.join(' ') }), t('uiGates.k116'))
    }
    return ok('review.independent', fmt('uiGates.k117', { p1: reviews.length }))
  },

  'iteration.increment': (ctx) => {
    const current = readIteration(ctx.store)
    if (current === undefined) return fail('iteration.increment', t('uiGates.k118'), t('uiGates.k119'))
    const tasks = iterationTasks(ctx.store, current.number)
    if (tasks.length === 0) return fail('iteration.increment', fmt('uiGates.k120', { p1: current.number }), t('uiGates.k121'))
    const unfinished = tasks.filter((task) => task.status !== 'done' && task.status !== 'verified').map((task) => task.id)
    if (unfinished.length > 0) return fail('iteration.increment', fmt('uiGates.k122', { p1: unfinished.join(' ') }), t('uiGates.k123'))
    return ok('iteration.increment', fmt('uiGates.k124', { p1: current.number, p2: tasks.length }))
  },

  'iteration.dod': (ctx) => {
    const current = readIteration(ctx.store)
    if (current === undefined) return fail('iteration.dod', t('uiGates.k125'), t('uiGates.k126'))
    if (textOf(current.goal).trim() === '') return fail('iteration.dod', t('uiGates.k127'), t('uiGates.k128'))
    const tasks = iterationTasks(ctx.store, current.number)
    const noEvidence = tasks.filter((task) => task.status === 'done' && task.evidence.length === 0).map((task) => task.id)
    if (noEvidence.length > 0) return fail('iteration.dod', fmt('uiGates.k129', { p1: noEvidence.join(' ') }), t('uiGates.k130'))
    const stats = verificationStats(ctx.store)
    if (stats.results === 0) return fail('iteration.dod', t('uiGates.k131'), t('uiGates.k132'))
    return ok('iteration.dod', fmt('uiGates.k133', { p1: current.number, p2: stats.results }))
  },

  'delivery.manifest': (ctx) => {
    const result = deliveryCompleteness(ctx.store, ctx.requirements, ctx.prototypeDir)
    if (result.ok) {
      return ok('delivery.manifest', fmt('uiGates.k134', { p1: result.manifest?.id ?? '', p2: result.manifest?.artifacts.length ?? 0, p3: result.manifest?.acceptance.length ?? 0 }))
    }
    return fail('delivery.manifest', result.problems.join('；'), t('uiGates.k135'))
  },

  'risks.conclusion': (ctx) =>
    ctx.riskConclusion === undefined
      ? fail('risks.conclusion', t('uiGates.k136'), t('uiGates.k137'))
      : ok('risks.conclusion', fmt('uiGates.k138', { p1: ctx.riskConclusion })),
}

/** G2 的 DoR 判据：**按"检查器键"取**，不按判据 id 硬编码匹配。 */
function dorCriterion(ctx: GateContext, id: string): GateCriterionResult {
  const dor = evaluateDor({
    project: ctx.project,
    requirements: ctx.requirements,
    questions: ctx.questions,
    risks: ctx.risks,
    redTeamExecuted: ctx.redTeamExecuted,
    redTeamDisabled: ctx.redTeamDisabled,
    signoff: signoffInput(ctx.store, ctx.journal, 'G2'),
    ...(ctx.approvedBy === undefined ? {} : { approvedBy: ctx.approvedBy }),
  })
  const found = dor.criteria.find((criterion) => criterion.id === id)
  if (found === undefined) {
    // 语言包/流程数据脱节：绝不"查不到就算过"
    return fail(id, fmt('uiGates.kDorCriterionUnknown', { p1: id }), t('uiGates.kGateUnknownRemedy'))
  }
  return {
    id,
    ok: found.ok,
    detail: found.detail,
    ...(found.remedy === undefined ? {} : { remedy: found.remedy }),
  }
}

/** 判定一个门禁。 */
/**
 * 判定一个门禁（**P-11：整条调用都不允许把异常抛给调用方**）。
 *
 * 为什么需要**外层**兜底：判据检查器只是读取真源的一部分 —— 判据之后的**形状提示收集**
 * （`collectShapeNotes`，F-21）同样要读全部手写真源。实测：把 `design/component.yml` 的缩进写坏，
 * `design.views` 检查器那条 try/catch 还没轮到，异常就在形状提示收集里抛了出来，
 * 于是 `evaluateGate` 直接冒泡 → **连 `office.status()` 的注入状态块都一起失败**。
 * 两层兜底各司其职：内层让"某一条判据查不动"只影响那一条（其余照常判定、信息最多），
 * 外层保证"无论哪里抛，都是一条可读的判红"。
 */
export function evaluateGate(process: ProcessDef, gateId: string, ctx: GateContext): GateEvaluation {
  try {
    return evaluateGateInner(process, gateId, ctx)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const phase = gatePhase(process, gateId) ?? ctx.project?.phase ?? ''
    const detail = fmt('uiGates.kCheckerThrew', { p1: message })
    return {
      gate: gateId,
      phase,
      status: 'failed',
      at: new Date().toISOString(),
      criteria: [{ id: 'gate.internal', ok: false, detail, remedy: t('uiGates.kCheckerThrewRemedy') }],
      remedy: [t('uiGates.kCheckerThrewRemedy')],
    }
  }
}

function evaluateGateInner(process: ProcessDef, gateId: string, ctx: GateContext): GateEvaluation {
  const definition = gateDef(process, gateId)
  const at = new Date().toISOString()
  const phase = gatePhase(process, gateId) ?? ctx.project?.phase ?? ''

  if (definition === undefined) {
    return {
      gate: gateId,
      phase,
      status: 'failed',
      at,
      criteria: [
        {
          id: 'gate.unknown',
          ok: false,
          detail: fmt('uiGates.k139', { p1: process.id, p2: gateId }),
          remedy: fmt('uiGates.k140', { p1: process.gates.map((gate) => gate.id).join(' ') }),
        },
      ],
      remedy: [fmt('uiGates.k141', { p1: process.id, p2: gateId })],
    }
  }

  const criteria: GateCriterionResult[] = definition.criteria.map((criterion) => {
    const checker = CHECKERS[criterion.check]
    if (checker === undefined) {
      return fail(
        criterion.id,
        fmt('uiGates.k142', { p1: criterion.check }),
        t('uiGates.k143'),
      )
    }
    // **P-11**：检查器自己抛异常（典型来源：手写真源 YAML 写坏，`readYaml` 抛 `YamlSubsetError`）
    // 绝不能冒泡出去 —— 那会让**整条门禁说不出话**（`evaluateGate` 的调用方没有 try/catch），
    // 而 `office.status()` 的"待判定门禁"走同一条现算路径，于是连注入状态块都会一起失败。
    // 本项目纪律是"查不到不能算过"：转成**该判据判红 + 带上异常信息与补救**，其余判据照常判定。
    let result: GateCriterionResult
    try {
      result = checker(ctx)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(criterion.id, fmt('uiGates.kCheckerThrew', { p1: message }), t('uiGates.kCheckerThrewRemedy'))
    }
    // 三态：`ok: true` 通过 / `ok: false` 失败 / `na: true` 不适用（不阻止放行，也不计入通过）
    return { ...result, id: criterion.id }
  })
  // F-21：手写 YAML 的**形状提示**（列表/映射位置写成了别的形状、`dropped` 不是布尔）
  // 必须出现在**相关判据**的详情里 —— 否则作者改了 YAML 却只看到"判据不通过"，
  // 不知道是形状写坏了。按判据的 `check` 键匹配实体（编号在不同流程里不同）。
  //
  // **R-7 后半**：这一段在判据循环**之后**、且要读**全部**手写真源（`collectShapeNotes`）——
  // 之前它没有 try/catch，坏 YAML 会从这里冒泡到外层兜底，于是**整门塌成一条 `gate.internal`**
  // （实测 G3：14 条判据 → 1 条），与 remedy 承诺的"其余判据照常判定"正相反。
  // 现在形状提示查不动**只影响它自己**：判据照常逐条判定，并在相关判据的 detail 里写明"查不动"。
  let shapeNoteError: string | undefined
  const shapeNotesByCheck = new Map<string, FieldShapeNote[]>()
  for (const criterion of criteria) {
    const defined = definition.criteria.find((candidate) => candidate.id === criterion.id)
    if (criterion.desc === undefined && defined?.desc !== undefined) criterion.desc = defined.desc
    const check = defined?.check ?? ''
    if (!checkWantsShapeNotes(check)) continue
    try {
      let notes = shapeNotesByCheck.get(check)
      if (notes === undefined) {
        notes = collectShapeNotes(ctx.store)
        shapeNotesByCheck.set(check, notes)
      }
      const lines = shapeNoteLines(shapeNotesForCheck(check, notes))
      if (lines.length > 0) {
        criterion.detail = `${criterion.detail}；${fmt('uiGates.kShapeNote', { p1: lines.join('；') })}`
      }
    } catch (error) {
      // R-14：区分"查不动"与"判不过"，并把原始报错（含文件名）带出来
      shapeNoteError ??= error instanceof Error ? error.message : String(error)
      criterion.detail = `${criterion.detail}；${fmt('uiGates.kShapeNoteFailed', { p1: shapeNoteError })}`
    }
  }

  const waived = ctx.waivedGates.includes(gateId)
  // N/A **不算失败**（它对这个项目没有意义），但也**不写进通过数** —— 它自成一态。
  const allOk = criteria.every((criterion) => criterion.ok || criterion.na === true)
  const status = waived ? 'waived' : allOk ? 'passed' : 'failed'
  const remedy = criteria
    .filter((criterion) => !criterion.ok && criterion.na !== true)
    .map((criterion) => criterion.remedy ?? criterion.detail)
  return { gate: gateId, phase, status, at, criteria, remedy }
}

/** 已通过/已豁免的门禁集合（用于算"待判定门禁"与阶段推进）。 */
export function satisfiedGates(evaluations: Iterable<GateEvaluation>): Set<string> {
  const set = new Set<string>()
  for (const evaluation of evaluations) {
    if (evaluation.status === 'passed' || evaluation.status === 'waived') set.add(evaluation.gate)
  }
  return set
}
