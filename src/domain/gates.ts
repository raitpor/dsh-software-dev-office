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
import { DESIGN_DOC_SOURCE_EVENTS, isDesignDocTruthPath } from '../types.js'
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
import { claimGaps, doneGaps, readConstructionProfile, scopeCovers } from './construction.js'
import { readProjectConfig } from '../config.js'
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
import type { Review } from './records.js'
import { reviewAdoptionLabel, reviewAdoptions } from './reviewVerification.js'
import { producesProductArtifacts } from './plan.js'

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

function ok(id: string, detail: string, warnings?: string[] | undefined): GateCriterionResult {
  return { id, ok: true, detail, ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }) }
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

/** 被采纳、但**没有内容指纹**（老格式）的 `pass` 评审 id（G-2 的可见性标注）。 */
function adoptedPassIds(
  taskIds: string[],
  reviews: Review[],
  adoptions: Map<string, { state: string; tamperGuard?: string }>,
): string[] {
  const wanted = new Set(taskIds)
  return reviews
    .filter((review) => wanted.has(review.taskId) && review.verdict === 'pass')
    .filter((review) => adoptions.get(review.id)?.state === 'adopted' && adoptions.get(review.id)?.tamperGuard === 'none-legacy')
    .map((review) => review.id)
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
    // **R3**：同上 —— 与真源事件对不上的签字不得算有效
    if (ledger.status === 'valid' && ledger.inconsistent !== true) {
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
   *
   * **§3.2（第二轮整体评审）**：方向 ① 只堵了一半 —— 声明 `viewsAbsent:[{kind:ui}]`（"不做界面视图"）
   * 时 `ui` 照样**不产生规则**，于是"项目 `surfaces:[web]` + 声明说不做界面"能一路 N/A/绿，
   * 而把同一件事写成 `viewsPresent:[ui]` 却判红（同一份声明换个方向结论相反）。修后口径只有一句：
   * **声明里的 `ui` 必须与 `uiDecision` 方向一致（`present ⟺ hasUi`）**；两个方向矛盾都判红。
   * `ui` 方向一致时本条不重复判"界面是否确认"——那是 C-27（`ui.confirmed`）的职责。
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
    // 声明里的 `ui` 与界面真源必须**方向一致**：present ⟺ hasUi
    const ui = uiDecision(ctx.project, ctx.requirements)
    const uiAbsent = app.viewsAbsent.some((item) => item.kind === 'ui')
    if (app.viewsPresent.includes('ui') && !ui.hasUi) {
      return fail('design.views', t('uiGates.kViewsUiDeclaredButAbsent'), t('uiGates.kViewsUiRemedy'))
    }
    // §3.2：说要"不做"、真源里却有界面（surfaces / 界面类需求）⇒ 同样判红。N/A 会让人以为门禁默认同意，
    // 而这里的真相是"你签字绑定的声明与项目自己的声明打架"。
    if (uiAbsent && ui.hasUi) {
      return fail(
        'design.views',
        fmt('uiGates.kViewsUiAbsentButReal', { p1: ui.reason }),
        t('uiGates.kViewsUiAbsentButRealRemedy'),
      )
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
    // **R3（复审 minor）**：`inconsistent` 以前没有任何判据消费 ⇒ 手写的签字照样 `valid`（只是理由多一句 ⚠️）。
    // 现在：台账与真源事件对不上 ⇒ 不算有效签字（理由里已经写清是哪一种不一致）。
    if (state.status === 'valid' && state.inconsistent !== true) {
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
      // **SDO-18（2026-10-05 真机）**：`trace/linked` 也在这张"会改文档"的表里，但**施工期覆盖边**
      // （`req-task` / `req-tc`）不进 `DESIGN.md` 的追溯矩阵（§8 只有设计侧四列）。真机上子代理
      // 补两条覆盖边就把刚渲染好的文档判陈旧（`#1279 trace/linked` 让 C-25 翻红），流程官自己也踩过。
      // 这里与 C-2D（`isSignatureInvalidatingEvent`）**同一口径**：按 `kind` 分流；拿不到 `kind` 时保守
      // 视为"会改文档"（黑名单方向不变）。
      .filter((event) => isDesignDocSourceEvent(event))
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

  /**
   * **实现阶段方法包已决定**（C-33 / C-83）：进构造阶段前必须跑过 `sdo_plan action=profile`。
   *
   * 三态口径与 `design.method-selected` 一致：**显式不选任何包**是合法 N/A（但必须写理由）；
   * profile **坏结构一律判红**（查不到就当过是禁止的）。
   */
  'construction.profile-decided': (ctx) => {
    const read = readConstructionProfile(ctx.store)
    if (read.status === 'invalid') {
      return fail('construction.profile-decided', read.problems.join('；'), t('uiGates.kConstructionProfileRemedy'))
    }
    if (read.status === 'missing' || read.profile === undefined) {
      return fail('construction.profile-decided', t('uiGates.kConstructionProfileMissing'), t('uiGates.kConstructionProfileRemedy'))
    }
    const profile = read.profile
    if (profile.packages.length === 0) {
      return na('construction.profile-decided', fmt('uiGates.kConstructionProfileOptOut', { p1: profile.reason }))
    }
    return ok(
      'construction.profile-decided',
      fmt('uiGates.kConstructionProfileOk', {
        p1: profile.packages.join(' + '),
        p2: profile.scope === 'all' ? 'all' : fmt('uiGates.kConstructionScopeTasks', { p1: String(profile.scope.length) }),
      }),
    )
  },

  /**
   * **范围内的卡满足所选包**（C-43 / C-84）：按**当前** profile 复核范围内**已完成**的卡。
   *
   * 用的是与 `claim`/`done` **同一套**检查器（现算）：开工侧"契约先冻结"（拿台账里那次认领的序号比）、
   * 收工侧"红→绿 / critical 变异 / 契约测试"。复议本身不追溯，但要放过历史卡请写**豁免**（有据可查）。
   */
  'construction.packages-satisfied': (ctx) => {
    const read = readConstructionProfile(ctx.store)
    if (read.status !== 'ok' || read.profile === undefined) {
      return na('construction.packages-satisfied', t('uiGates.kConstructionProfileNa'))
    }
    const profile = read.profile
    if (profile.packages.length === 0) {
      return na('construction.packages-satisfied', t('uiGates.kConstructionProfileNa'))
    }
    const scale = readProjectConfig(ctx.store).config.scale
    const inScope = listTasks(ctx.store).filter((card) => card.status === 'done' && scopeCovers(profile, card.id))
    const gaps: string[] = []
    for (const card of inScope) {
      const claims = ctx.journal.read().events.filter((event) => event.type === 'task/claimed' && event.data.id === card.id)
      const claimSeq = claims[claims.length - 1]?.seq
      if (claimSeq !== undefined) {
        gaps.push(...claimGaps(ctx.store, ctx.journal, card, claimSeq, profile).map((item) => `${card.id}：${item.detail}`))
      }
      gaps.push(...doneGaps(ctx.store, ctx.journal, card, profile, { scale }).map((item) => `${card.id}：${item.detail}`))
    }
    return gaps.length === 0
      ? ok('construction.packages-satisfied', fmt('uiGates.kConstructionPackagesOk', { p1: String(inScope.length) }))
      : fail('construction.packages-satisfied', gaps.join('；'), t('uiGates.kConstructionPackagesRemedy'))
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
    const stats = verificationStats(ctx.store, ctx.journal)
    if (stats.cases === 0) return fail('tests.passed', t('uiGates.k100'), t('uiGates.k101'))
    if (stats.results === 0) return fail('tests.passed', t('uiGates.k102'), t('uiGates.k103'))
    // **D4 硬化（整仓评审 major）**：结果必须有真源事件（`test/recorded`）佐证 ——
    // 旧实现只读 `tests/results/*.yml`，于是「手写一条 pass 的 YAML」（journal 零事件）就能把这条判据判绿，
    // 而 `recordTestResult(fail)` 之后把文件改成 pass 也查不出来。
    // 判据：
    //   ① journal 被坏行**截断** ⇒ 无法证明（可能只是记在坏行之后）⇒ 按"无法判定"判红（附修法，不假装绿）；
    //   ② 有结果文件却查不到事件 ⇒ 判红并点名，话术给出"用工具重记/重跑"的补救动作。
    // **R1（复审 major）**：文件状态 ≠ 真源事件状态 ⇒ 结果文件被改写（"把红改成绿"）⇒ 判红并点名
    if (stats.tampered.length > 0) {
      const list = stats.tampered.map((item) => fmt('uiGates.kTestsTamperedItem', { p1: item.id, p2: item.journal, p3: item.file })).join('; ')
      return fail('tests.passed', fmt('uiGates.kTestsTampered', { p1: list }), t('uiGates.kTestsTamperedRemedy'))
    }
    if (stats.unjournaled.length > 0) {
      if (ctx.journal.read().truncated) {
        return fail('tests.passed', fmt('uiGates.kTestsUnknown', { p1: String(stats.unjournaled.length) }), t('uiGates.kTestsUnknownRemedy'))
      }
      return fail(
        'tests.passed',
        fmt('uiGates.kTestsUnjournaled', { p1: String(stats.unjournaled.length), p2: stats.unjournaled.join(' ') }),
        t('uiGates.kTestsUnjournaledRemedy'),
      )
    }
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
    // **2026-10-08 口径**：评审「任务」完成不需要被评审，但**评审结果要被核实才能采纳** ——
    //   · `role === 'reviewer'` 的卡不在此列（与 SDO-35 / C-42 同一理由：评审卡自我递归没有意义）；
    //   · 其余完成卡的 `pass` 评审必须是**已采纳**的（每条发现都由实现会话核实过，评审与核实都能被真源佐证）。
    // **R-12**：不只排 `role === 'reviewer'`，还排掉**不产出产品工件**的卡（复核/代核/文书）。
    // 只排 role 的旧口径漏掉了"实质在做复核、却因 R-11 挂在 tester 下"的卡 ⇒ 它一 done 就要求自己被评审（自我递归）。
    const doneTasks = tasks.filter(
      (task) => (task.status === 'done' || task.status === 'verified')
        && task.role !== 'reviewer'
        && producesProductArtifacts(task),
    )
    const adoptions = new Map(reviewAdoptions(ctx.store, ctx.journal).map((item) => [item.review.id, item]))
    const unreviewed: string[] = []
    const unadopted: string[] = []
    for (const task of doneTasks) {
      const pass = reviews.filter((review) => review.taskId === task.id && review.verdict === 'pass')
      if (pass.some((review) => adoptions.get(review.id)?.state === 'adopted')) continue
      if (pass.length === 0) {
        unreviewed.push(task.id)
        continue
      }
      unadopted.push(
        `${task.id}（${pass
          .map((review) => `${review.id}：${reviewAdoptionLabel(adoptions.get(review.id)?.state ?? 'unverified')}`)
          .join('，')}）`,
      )
    }
    // **G-1（sdo-test 2026-10-08 报告）**：两个桶**一起报** —— 旧实现先在 `unreviewed` 上提前 return，
    // 于是"有 pass 评审但永远采纳不了"的那几张卡被挡在身后（真机：22 张无评审的卡把 2 张死锁卡藏了）。
    if (unreviewed.length > 0 || unadopted.length > 0) {
      const parts: string[] = []
      const remedies: string[] = []
      if (unreviewed.length > 0) {
        parts.push(fmt('uiGates.k115', { p1: unreviewed.join(' ') }))
        remedies.push(t('uiGates.k116'))
      }
      if (unadopted.length > 0) {
        parts.push(fmt('uiGates.kReviewUnadopted', { p1: unadopted.join(' ') }))
        remedies.push(t('uiGates.kReviewUnadoptedRemedy'))
      }
      return fail('review.independent', parts.join('；'), remedies.join('；'))
    }
    // **G-2 可见性**：被采纳的 `pass` 评审里若有**老格式**（没有内容指纹）的，如实标注 ——
    // 否则"已采纳"会读成"已防篡改"，而老条目其实检出不了"改 verdict / 改正文"。
    const legacy = adoptedPassIds(doneTasks.map((task) => task.id), reviews, adoptions)
    return ok(
      'review.independent',
      fmt('uiGates.k117', { p1: reviews.length })
        + (legacy.length === 0 ? '' : '；' + fmt('uiGates.kReviewLegacyAdopted', { p1: legacy.join(' ') })),
    )
  },

  /**
   * **D9：中大卡在完成前就要有通过评审**（`size ≥ medium`）。
   *
   * 与 G6 的 `review.independent` 的分工：那条在**验证门禁**要求"所有完成卡都有 pass 评审 + 作者≠评审者"；
   * 这条把**大卡**的评审要求**提前到开发完成门禁**，小卡（trivial/small）不在 G5 被拦。
   * 两条的口径不冲突：G5 更早、更窄；G6 更晚、更全。
   */
  'review.required': (ctx) => {
    const tasks = listTasks(ctx.store)
    // **SDO-35（真机）**：**评审卡不参与这条判据**，否则每批评审卡又要被评审（自我递归：TASK-142/147 先后被点名）；
    // 而"再评一次"在池子里不成立（可复用的 reviewer 只有一个，派发器无法保证评审者 ≠ 卡 owner）。
    // **R-12**：同一条机械判据（不产出产品工件的卡不进这个集合）
    const big = tasks.filter(
      (task) => task.status === 'done' && (task.size === 'medium' || task.size === 'large')
        && task.role !== 'reviewer'
        && producesProductArtifacts(task),
    )
    if (big.length === 0) return ok('review.required', t('uiGates.kWorkReviewNone'))
    // 与 G6/C-52 **同一份采纳口径**（2026-10-08）：`pass` 评审必须**已核实采纳**才算数 ——
    // 否则"有通过评审"的账在那里、发现却没人核实过，G5 就先放行了（两条判据不许各写一份）。
    const reviews = listReviews(ctx.store)
    const adoptions = new Map(reviewAdoptions(ctx.store, ctx.journal).map((item) => [item.review.id, item]))
    const missing: string[] = []
    const unadopted: string[] = []
    for (const task of big) {
      const pass = reviews.filter((review) => review.taskId === task.id && review.verdict === 'pass')
      if (pass.some((review) => adoptions.get(review.id)?.state === 'adopted')) continue
      if (pass.length === 0) {
        missing.push(task.id)
        continue
      }
      unadopted.push(
        `${task.id}（${pass
          .map((review) => `${review.id}：${reviewAdoptionLabel(adoptions.get(review.id)?.state ?? 'unverified')}`)
          .join('，')}）`,
      )
    }
    if (missing.length > 0 || unadopted.length > 0) {
      const parts: string[] = []
      const remedies: string[] = []
      if (missing.length > 0) {
        parts.push(fmt('uiGates.kWorkReviewMissing', { p1: missing.join(' ') }))
        remedies.push(t('uiGates.kWorkReviewRemedy'))
      }
      if (unadopted.length > 0) {
        parts.push(fmt('uiGates.kReviewUnadopted', { p1: unadopted.join(' ') }))
        remedies.push(t('uiGates.kReviewUnadoptedRemedy'))
      }
      return fail('review.required', parts.join('；'), remedies.join('；'))
    }
    const legacy = adoptedPassIds(big.map((task) => task.id), reviews, adoptions)
    return ok(
      'review.required',
      fmt('uiGates.kWorkReviewOk', { p1: String(big.length) })
        + (legacy.length === 0 ? '' : '；' + fmt('uiGates.kReviewLegacyAdopted', { p1: legacy.join(' ') })),
    )
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
      // **R-22**：通过也要把 warnings 交出去（"带已知偏差通过"必须与"干净通过"在回执上区分开）
      return ok(
        'delivery.manifest',
        fmt('uiGates.k134', { p1: result.manifest?.id ?? '', p2: result.manifest?.artifacts.length ?? 0, p3: result.manifest?.acceptance.length ?? 0 }),
        result.warnings,
      )
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

/**
 * 该事件是否算「会改 `DESIGN.md` 的真源变更」（C-25 的唯一判据，导出以便单测）。
 *
 * 三条口径（都由真机缺陷换来，缺一条就会误判）：
 *   · 类型不在 {@link DESIGN_DOC_SOURCE_EVENTS} 里 ⇒ 不算；
 *   · `trace/linked|unlinked` 按 `kind` 分流：施工期覆盖边（`req-task`/`req-tc`）不进文档（SDO-18）；
 *   · `truth/file-written` 按**路径**分流：只有设计文档真正渲染的那几个真源目录算（SDO-19 复审），
 *     手改构造/测试/成本类真源不再让文档判陈旧（报警疲劳）。缺 `docSource` 的旧事件回退到路径判定；
 *     路径也读不出 ⇒ **保守算作会改文档**（黑名单方向不变）。
 */
export function isDesignDocSourceEvent(event: { type: string; data?: unknown }): boolean {
  if (!(DESIGN_DOC_SOURCE_EVENTS as readonly string[]).includes(event.type)) return false
  if (nonDocTraceEdge(event)) return false
  if (event.type !== 'truth/file-written') return true
  const data = (event.data ?? {}) as { docSource?: unknown; path?: unknown }
  if (typeof data.docSource === 'boolean') return data.docSource
  return typeof data.path === 'string' ? isDesignDocTruthPath(data.path) : true
}

/** `trace/linked|unlinked` 且 `kind` 是施工期覆盖边（`req-task`/`req-tc`）⇒ 不进设计文档（SDO-18）。 */
function nonDocTraceEdge(event: { type: string; data?: unknown }): boolean {
  if (event.type !== 'trace/linked' && event.type !== 'trace/unlinked') return false
  const kind = (event.data as { kind?: unknown } | undefined)?.kind
  return kind === 'req-task' || kind === 'req-tc'
}

