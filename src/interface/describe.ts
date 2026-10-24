/**
 * 面向模型/人的文本输出（工具与命令共用一套口径）。
 *
 * 设计对应：§9.1（`sdo_status` 要给阶段、门禁缺口、开环问题、追溯覆盖率、产物清单）、
 * NFR-009（只出现相对路径）、NFR-012（成本类数字必须标注"估算"——M5 起）。
 */
import { DIMENSIONS } from '../types.js'
import { textOf } from '../infra/scalar.js'
import type { DeliveryManifest } from '../domain/records.js'
import type { Adr, ChangeRequest, ChangeRollback, Contract, DesignApplicability, DesignElement, DesignView, FeasibilityAssessment, GateEvaluation, GateSignature, GrillQuestion, QualityAssessment, QualityScenario, Requirement, RiskItem, SdoProject, StructuralCardPlan, StructuralPlan, StructuralSkip, StructuralSkipReason, TaskCard, TraceReport } from '../types.js'
import type { StructuralGapRow, CoverageBasisItem } from '../domain/plan.js'
import type { SignatureState } from '../domain/signature.js'
import { channelLabel, signatureInvalidatingEventLine } from '../domain/signature.js'
import { applicabilityLines } from '../domain/applicability.js'
import type { BaselineOutcome, InitResult, StatusSnapshot } from '../office.js'
import type { DorResult } from '../domain/dor.js'
import { TELOS_DIMENSIONS, TELOS_LABEL } from '../domain/feasibility.js'
import { riskStats } from '../domain/risks.js'
import { VIEW_KINDS } from '../types.js'
import { VIEW_LABEL } from '../domain/architecture.js'
import { fmt, gateLabel, gateWithId, label, phaseText, t, textOrProcess } from '../domain/i18n.js'
import { contractFieldNoteHeader, contractFieldNoteLines } from '../domain/contracts.js'
import type { ContractFieldNote } from '../domain/contracts.js'
import { shapeNoteBlock } from '../domain/shapeNotes.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import { defectLinksExemptionLines, describeDefectLinks, readDefectLinksOf } from '../domain/trace.js'
import { planStats } from '../domain/plan.js'
import type { PlanIssue } from '../domain/plan.js'
import type { RolePool } from '../domain/pool.js'
import type { DispatchRequest } from '../integration/orchestrator.js'

/** `sdo_init` 的回执。 */
/**
 * 语言状态回执（用户可见）：当前语言、可选语言包、覆盖率与**如何永久设置**。
 * 覆盖率是判别性的：它来自"目标语言包实际有多少键"，而不是"能取到多少文案"（后者永远 100%，因为会回退）。
 */
export function describeLang(state: {
  locale: string
  base: string
  languages: readonly string[]
  covered: number
  total: number
  extra: number
}): string {
  const lines = [
    fmt('uiLang.current', { p1: state.locale, p2: state.base }),
    fmt('uiLang.available', { p1: state.languages.join(' / ') }),
  ]
  if (state.locale !== state.base) {
    lines.push(fmt('uiLang.coverage', { p1: state.covered, p2: state.total }))
    if (state.extra > 0) lines.push(fmt('uiLang.extraKeys', { p1: state.extra }))
  }
  lines.push(t('uiLang.usage'))
  return lines.join('\n')
}

export function describeInit(result: InitResult, dataDirName: string): string {
  const lines: string[] = []
  if (result.created) {
    // **F-3（sdo-test 回归报告，major）**：本回执此前**复用** `uiDescribe.m1..m7` —— 那几个键
    // 分属另外两个消费者（`m1` = 「更新项目但没改任何字段」、`m4/m5/m6` = 设计门禁回执的
    // 「…设计被拒：<原因>」/「查看」/「进入」），于是立项回执打出"本次没有写入任何字段"、
    // "已记录质量场景 waterfall"、"{p2} 已渲染 .sdo → `{p2}`" 这类**语义错位**文本。
    // 现在立项回执有自己的一组键（`uiDescribe.init*`），与其它消费者彻底分开。
    lines.push(fmt('uiDescribe.initCreated', { p1: result.project.id, p2: result.project.name }))
    // 观察 1（评审员）：同一屏不能两种口径 —— 进程/规模/阶段一律用本地化标签
    // （与注入块、`sdo_status` 的 `label()`/`phaseText()` 同源），不裸露 `waterfall`/`normal`/`intake`
    lines.push(fmt('uiDescribe.initProcess', {
      p1: label('process', result.project.process),
      p2: label('scale', result.project.tailoring?.scale ?? 'normal'),
      p3: phaseText(result.project.phase),
    }))
    lines.push(fmt('uiDescribe.initDataDir', { p1: dataDirName }))
    if (result.project.scope.out.length === 0) {
      lines.push(t('uiDescribe.initNoNonGoals'))
    }
    lines.push(t('uiDescribe.initNext'))
  } else {
    lines.push(fmt('uiDescribe.initExisting', { p1: result.project.id, p2: result.project.name }))
    lines.push(fmt('uiDescribe.initPhase', { p1: result.project.phase, p2: phaseText(result.project.phase) }))
    lines.push(fmt('uiDescribe.k8', { p1: dataDirName }))
  }
  return lines.join('\n')
}

/** 看板写盘等附加说明（单独成段，避免污染看板正文的确定性）。 */
export function describeBoardNote(note: string): string {
  return `> ${note}`
}

/** `sdo_status` / `/sdo-status` 的文本。 */
export function describeStatus(status: StatusSnapshot, dataDirName: string, shapeNotes: FieldShapeNote[] = []): string {
  const lines: string[] = [t('uiDescribe.k177')]
  const { project } = status

  if (project === undefined) {
    // **§5.1（评审员）**：`project` 读不出 ≠ 没有账本。旧实现早返回「尚未初始化：当前工作目录下没有 `.sdo/`」，
    // 连告警都不打印（告警在早返回之后），对用户是**假陈述**（实测 `.sdo/` 里有 861 条事件）。
    if (status.truthError !== undefined && status.truthError !== '') {
      lines.push(fmt('uiDescribe.truthError', { p1: status.truthError }))
      lines.push(fmt('uiDescribe.k9Unverified', { p1: dataDirName }))
      return lines.join('\n')
    }
    lines.push(fmt('uiDescribe.k9', { p1: dataDirName }))
    lines.push(t('uiDescribe.k10'))
    return lines.join('\n')
  }

  // **R-7 可见性**：`sdo_status` 是用户直接看的回执，同样必须说明"读不出真源"。
  if (status.truthError !== undefined && status.truthError !== '') {
    lines.push(fmt('uiDescribe.truthError', { p1: status.truthError }))
  }
  const pending = status.pendingGate ?? t('uiDescribe.k11')
  lines.push(fmt('uiDescribe.k12', { p1: project.id, p2: project.name }))
  lines.push(
    fmt('uiDescribe.k13', { p1: project.process, p2: project.tailoring?.scale ?? status.config.scale, p3: project.phase }),
  )
  lines.push(fmt('uiDescribe.k14', { p1: pending, p2: status.lastGate === undefined ? t('uiDescribe.k207') : `${status.lastGate.gate} ${status.lastGate.status} @ ${status.lastGate.at}` }))
  lines.push(
    fmt('uiDescribe.k15', { p1: status.counts.requirements, p2: status.counts.openQuestions, p3: status.counts.questions })
    + t('uiDescribe.k16'),
  )
  lines.push(
    fmt('uiDescribe.k17', { p1: status.feasibilityVerdict ?? t('uiDescribe.k152'), p2: status.risks.total, p3: status.risks.open, p4: status.risks.high, p5: status.risks.blockers }),
  )
  lines.push(fmt('uiDescribe.k18', { p1: status.openIssues, p2: status.changes }))
  lines.push(fmt('uiDescribe.k19', { p1: status.counts.evidence }))
  lines.push(
    fmt('uiDescribe.k20', { p1: status.rebuilt ? t('uiDescribe.k208') : t('uiDescribe.k153') })
    + fmt('uiDescribe.k237', { p1: status.truncated ? fmt('uiDescribe.k235', { p1: status.badLine ?? '?' }) : t('uiDescribe.k236') }),
  )
  if (status.configSource === 'default') {
    lines.push(fmt('uiDescribe.k21', { p1: dataDirName, p2: status.config.process, p3: status.config.scale }))
  }

  lines.push(t('uiDescribe.k22'))
  lines.push(fmt('uiDescribe.k23', { p1: dataDirName }))
  lines.push(fmt('uiDescribe.k24', { p1: dataDirName }))
  lines.push(fmt('uiDescribe.k25', { p1: dataDirName, p2: dataDirName }))
  lines.push(fmt('uiDescribe.k154', { p1: dataDirName }))
  // F-21：只读状态视图也要摆出"手写真源的形状提示"（有才出现，无则逐字不变）
  lines.push(...shapeNoteBlock(shapeNotes))

  return lines.join('\n')
}

/** `sdo_project action=update` 的回执。 */
export function describeProjectUpdate(result: { project: SdoProject; changed: string[] }): string {
  if (result.changed.length === 0) {
    return [
      t('uiDescribe.m1'),
      t('uiDescribe.k26'),
    ].join('\n')
  }
  const lines: string[] = [fmt('uiDescribe.k178', { p1: result.project.id, p2: result.project.name })]
  lines.push(fmt('uiDescribe.k27', { p1: result.changed.join('、') }))
  lines.push(fmt('uiDescribe.k28', { p1: result.project.scope.in.length === 0 ? t('uiDescribe.k209') : result.project.scope.in.join('；') }))
  lines.push(fmt('uiDescribe.k29', { p1: result.project.scope.out.length === 0 ? t('uiDescribe.k210') : result.project.scope.out.join('；') }))
  lines.push(fmt('uiDescribe.k30', { p1: Object.keys(result.project.glossary).length }))
  lines.push(fmt('uiDescribe.k31', { p1: result.project.metrics.success.length === 0 ? t('uiDescribe.k211') : result.project.metrics.success.join('；') }))
  return lines.join('\n')
}

/** `sdo_project action=show` 的回执。 */
export function describeProject(status: StatusSnapshot, dataDirName: string): string {
  const project = status.project
  if (project === undefined) return fmt('uiDescribe.k32', { p1: dataDirName })
  const lines: string[] = [fmt('uiDescribe.k179', { p1: project.id, p2: project.name })]
  lines.push(fmt('uiDescribe.k33', { p1: project.process, p2: project.tailoring?.scale ?? status.config.scale, p3: project.phase }))
  lines.push(fmt('uiDescribe.k34', { p1: project.scope.in.length === 0 ? t('uiDescribe.k212') : project.scope.in.join('；') }))
  lines.push(fmt('uiDescribe.k35', { p1: project.scope.out.length === 0 ? t('uiDescribe.k213') : project.scope.out.join('；') }))
  lines.push(fmt('uiDescribe.k36', { p1: project.stakeholders.length === 0 ? t('uiDescribe.k214') : project.stakeholders.map((item) => `${item.id} ${item.role}`).join('；') }))
  lines.push(fmt('uiDescribe.k37', { p1: Object.keys(project.glossary).length === 0 ? t('uiDescribe.k215') : Object.entries(project.glossary).map(([term, definition]) => `${term}：${definition}`).join('；') }))
  lines.push(fmt('uiDescribe.k38', { p1: project.metrics.success.length === 0 ? t('uiDescribe.k216') : project.metrics.success.join('；') }))
  lines.push(fmt('uiDescribe.k39', { p1: project.tailoring === undefined ? t('uiDescribe.k217') : fmt('uiDescribe.k156', { p1: project.tailoring.scale, p2: project.tailoring.waivedGates.join(' ') || t('uiDescribe.k155') }) }))
  return lines.join('\n')
}

/** `sdo_gate action=check` 的回执。 */
/**
 * **交付回执里的"带已知偏差通过"那一行**（R-22，sdo-test-new 2026-10-08）。
 *
 * 抽成纯函数的原因有二：① 交付回执与门禁告警**同源**（同一批行、同一句话）；
 * ② 它**可被行为断言**（真机教训：只断源码文本的守卫会被"条件改成恒假"这类变异绕过去 —— 变异 V3 就存活过）。
 * 没有带偏差的行 ⇒ 返回 `undefined`（干净通过**不许**挂这条噪音）。
 */
export function deviationsNote(manifest: { acceptance: { requirement: string; criterion: string; verdict: string }[] }): string | undefined {
  const deviations = manifest.acceptance.filter((row) => row.verdict === 'pass-with-deviation')
  if (deviations.length === 0) return undefined
  return fmt('uiIndex.kDeviationsAccepted', {
    p1: String(deviations.length),
    p2: deviations.map((row) => `${row.requirement}/${row.criterion}`).join(' '),
  })
}

export function describeGate(evaluation: GateEvaluation): string {
  const head = fmt('uiDescribe.k40', { p1: gateWithId(evaluation.gate), p2: phaseText(evaluation.phase), p3: evaluation.status === 'passed' ? t('uiDescribe.k218') : evaluation.status === 'waived' ? t('uiDescribe.k219') : t('uiDescribe.k157') })
  const lines: string[] = [head]
  for (const criterion of evaluation.criteria) {
    // **三态**：✅ 通过 / ❌ 失败 / ➖ N/A（不适用）—— N/A 必须显式出现并带上理由，
    // 否则"没做"会被读成"做对了"（增量 1 / §2.1）。
    const na = criterion.na === true
    const marker = na ? t('uiDescribe.gateNa') : criterion.ok ? '✅' : '❌'
    lines.push(
      `- ${marker} ${textOrProcess(`criterion.${criterion.id}`, criterion.desc)}`
      + `（${criterion.id}）　${criterion.detail}`,
    )
    if (na) lines.push(fmt('uiDescribe.k41', { p1: t('uiDescribe.gateNaNote') }))
    else if (criterion.remedy !== undefined) lines.push(fmt('uiDescribe.k41', { p1: criterion.remedy }))
    // **R-22**：通过但必须出声的告警（如"带已知偏差通过 3 条：…"）—— 不许被吞掉
    for (const warning of criterion.warnings ?? []) lines.push(fmt('uiDescribe.kGateWarning', { p1: warning }))
  }
  if (evaluation.status === 'failed') {
    lines.push(fmt('uiDescribe.k42', { p1: evaluation.criteria.filter((criterion) => !criterion.ok && criterion.na !== true).map((criterion) => criterion.id).join(', ') }))
  }
  // **R-29**：只有**真的落盘**了才印"判定记录已写入"（提前返回、不落盘的路径不许说假话）
  if (evaluation.persisted !== false) lines.push(fmt('uiDescribe.k43', { p1: evaluation.gate }))
  return lines.join('\n')
}

/** `sdo_gate action=advance` 的回执。 */
export function describeAdvance(result: {
  advanced: boolean
  from: string
  to?: string | undefined
  blockedBy?: string | undefined
  remedy?: string[] | undefined
  /** **R-26**：推进成功也要如实说的"还没重新基线"（判定通过 ≠ 已重新冻结） */
  notes?: string[] | undefined
}): string {
  // **R-26**：notes 必须跟着回执走（真机：G2 判 ✅、阶段也推进了，可变更其实还没消化）
  const notes = (result.notes ?? []).map((note) => fmt('uiDescribe.kAdvanceNote', { p1: note }))
  if (result.advanced) {
    const head = fmt('uiDescribe.k44', { p1: phaseText(result.from), p2: phaseText(result.to ?? ''), p3: result.to === undefined ? t('uiDescribe.k220') : '' })
    return [head, ...notes].join('\n')
  }
  if (result.blockedBy === undefined) return [fmt('uiDescribe.k45', { p1: phaseText(result.from) }), ...notes].join('\n')
  const lines = [fmt('uiDescribe.k180', { p1: phaseText(result.from), p2: gateWithId(result.blockedBy) })]
  for (const remedy of result.remedy ?? []) lines.push(fmt('uiDescribe.k46', { p1: remedy }))
  lines.push(fmt('uiDescribe.k47', { p1: gateLabel(result.blockedBy) }))
  lines.push(...notes)
  return lines.join('\n')
}

/** `sdo_feasibility action=assess` 的回执。 */
export function describeFeasibility(assessment: FeasibilityAssessment, shapeNotes: FieldShapeNote[] = []): string {
  const lines: string[] = [fmt('uiDescribe.k181', { p1: assessment.id, p2: assessment.verdict })]
  for (const dimension of TELOS_DIMENSIONS) {
    const item = assessment.telos[dimension]
    lines.push(`- ${TELOS_LABEL[dimension]}：${item.verdict}${item.rationale === '' ? '' : `　${item.rationale}`}`)
  }
  lines.push(fmt('uiDescribe.k48', { p1: assessment.rationale }))
  if (assessment.poc.length > 0) {
    lines.push(fmt('uiDescribe.k49', { p1: assessment.poc.join('；') }))
  } else {
    lines.push(t('uiDescribe.k50'))
  }
  lines.push(t('uiDescribe.k51'))
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** 风险登记表。 */
export function describeRisks(risks: RiskItem[]): string {
  if (risks.length === 0) return t('uiDescribe.k52')
  const stats = riskStats(risks)
  const lines: string[] = [fmt('uiDescribe.k182', { p1: stats.total, p2: stats.open, p3: stats.high, p4: stats.blockers })]
  for (const risk of risks) {
    lines.push(fmt('uiDescribe.k239', { p1: risk.id, p2: risk.level, p3: risk.probability, p4: risk.status, p5: risk.title, p6: risk.origin === undefined ? '' : fmt('uiDescribe.k238', { p1: risk.origin }) }))
    if (textOf(risk.mitigation).trim() === '' || textOf(risk.owner).trim() === '') {
      lines.push(t('uiDescribe.k53'))
    }
  }
  return lines.join('\n')
}

/** `sdo_requirement action=change` 的回执。 */
export function describeChange(
  result: {
    change: ChangeRequest
    applied: boolean
    reason?: string | undefined
    /** §6.7：本次重算评分时语义分的来源（显式重给 / 沿用 / 本来就没有） */
    dimensionsFrom?: 'explicit' | 'carried' | 'none' | undefined
    /** 语义 A：批准触发的强制回退结果（未触发时不给） */
    rollback?: ChangeRollback | undefined
    /** **D-21 / R-25**：变更单里 `replaceAcceptance` 造成的 AC 编号变动（交付矩阵追溯键会失配） */
    acceptanceRenumbered?: { from: string; to: string }[] | undefined
  },
  shapeNotes: FieldShapeNote[] = [],
): string {
  const { change } = result
  const lines: string[] = [fmt('uiDescribe.k183', { p1: change.id, p2: change.requirement, p3: change.decision })]
  lines.push(fmt('uiDescribe.k54', { p1: change.reason }))
  for (const item of change.changes) lines.push(fmt('uiDescribe.k55', { p1: item }))
  lines.push(fmt('uiDescribe.k56', { p1: change.impact.design.length, p2: change.impact.tasks.length, p3: change.impact.tests.length }))
  lines.push(`  （${change.impact.note}）`)
  lines.push(fmt('uiDescribe.k57', { p1: change.decidedBy }))
  lines.push(result.applied ? t('uiDescribe.k221') : fmt('uiDescribe.k58', { p1: result.reason ?? change.decision }))
  // **D-21 / R-25**：变更单换掉整份 AC ⇒ 编号会变。变更路径此前没有这条提示，
  // 而它与 `update` 路径毁掉的是同一件东西（交付验收矩阵的追溯键）。
  const renumberedChange = result.acceptanceRenumbered ?? []
  if (renumberedChange.length > 0) {
    lines.push(fmt('uiDescribe.kAcceptanceRenumbered', {
      p1: String(renumberedChange.length),
      p2: renumberedChange.map((item) => `${item.from}→${item.to}`).join(' '),
    }))
  }
  // §6.7：变更后评分是怎么算的必须说清 —— 「语义分被规则基线抹掉」正是先在这里暴露出来的
  if (result.applied && result.dimensionsFrom !== undefined) {
    lines.push(t(
      result.dimensionsFrom === 'explicit'
        ? 'uiDescribe.changeDimsExplicit'
        : result.dimensionsFrom === 'carried'
          ? 'uiDescribe.changeDimsCarried'
          : 'uiDescribe.changeDimsNone',
    ))
  }
  // 语义 A（2026-10-04）：批准的需求变更必须把"接下来做什么"写进回执 ——
  // 只报"已回退"会让用户以为"回到需求阶段"就够了，而真正决定能不能继续开发的是
  // "重新基线 + 重过设计门"这两步（`claim` 由 `change-not-digested` 拦着）。
  if (result.rollback !== undefined) {
    const rollback = result.rollback
    if (rollback.error !== undefined) {
      lines.push(fmt('uiDescribe.changeRollbackNoEdge', { p1: rollback.from, p2: rollback.error }))
    } else if (rollback.alreadyThere) {
      lines.push(fmt('uiDescribe.changeRollbackAlready', { p1: rollback.from }))
    } else {
      lines.push(fmt('uiDescribe.changeRolledBack', { p1: rollback.from, p2: rollback.to }))
      if (rollback.invalidatedGates.length > 0) {
        lines.push(fmt('uiDescribe.changeRollbackGates', { p1: rollback.invalidatedGates.join(' ') }))
      }
      if (rollback.stillWaivedGates.length > 0) {
        lines.push(fmt('uiDescribe.changeRollbackWaived', { p1: rollback.stillWaivedGates.join(' ') }))
      }
      // **N-5（D-22 验收口径③）**：设计门为什么也一起作废，必须写出**依据**（真机踩点：只看到
      // "作废了 G3"会以为插件在无差别惩罚）。依据 = 追溯图里这条需求的设计引用；图里没有时也如实说
      // "仍按默认口径作废"，不把"图里没写"当放行理由。
      const designRefs = change.impact.design
      lines.push(
        designRefs.length === 0
          ? t('uiDescribe.changeRollbackDesignWhyNoTrace')
          : fmt('uiDescribe.changeRollbackDesignWhy', {
              p1: String(designRefs.length),
              p2: designRefs.slice(0, 5).join(' ') + (designRefs.length > 5 ? ' …' : ''),
            }),
      )
    }
    lines.push(t('uiDescribe.changeRollbackSteps'))
  }
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** `sdo_design action=view` 的回执：五视图 + 契约覆盖。 */
export function describeDesign(
  views: DesignView[],
  contracts: Contract[],
  fieldNotes: ContractFieldNote[] = [],
  shapeNotes: FieldShapeNote[] = [],
): string {
  const lines: string[] = []
  if (views.length === 0) {
    // 注意：**不能提前 return** —— 视图为空时契约字段的类型提示同样要出现（F-20 的"不静默"）
    lines.push(t('uiDescribe.k59'))
  } else {
    lines.push(fmt('uiDescribe.k184', { p1: views.length }))
    for (const view of views) {
      lines.push(fmt('uiDescribe.k60', { p1: VIEW_LABEL[view.kind], p2: view.kind, p3: view.elements.length, p4: view.summary === '' ? '' : `　${view.summary}` }))
      for (const element of view.elements) {
        lines.push(fmt('uiDescribe.k241', { p1: element.id, p2: element.name, p3: element.kind, p4: element.dependsOn.length === 0 ? '' : fmt('uiDescribe.k240', { p1: element.dependsOn.join('、') }) }))
      }
    }
    const missing = VIEW_KINDS.filter((kind) => !views.some((view) => view.kind === kind))
    if (missing.length > 0) lines.push(fmt('uiDescribe.k61', { p1: missing.join(' ') }))
    lines.push(fmt('uiDescribe.k62', { p1: contracts.length }))
  }
  lines.push(...contractFieldNoteBlock(fieldNotes))
  // F-21：容器族（列表/映射位置被写成别的形状）与 `dropped` 非布尔的提示
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** 写入设计元素的回执。 */
export function describeDesignElement(result: { element: DesignElement; view: DesignView; created: boolean }): string {
  const { element, view, created } = result
  const lines: string[] = [fmt('uiDescribe.k186', { p1: created ? t('uiDescribe.k222') : t('uiDescribe.k185'), p2: element.id, p3: element.name, p4: VIEW_LABEL[view.kind] })]
  lines.push(fmt('uiDescribe.k63', { p1: element.kind, p2: element.responsibility === '' ? t('uiDescribe.k223') : element.responsibility }))
  if (element.dependsOn.length > 0) {
    lines.push(fmt('uiDescribe.k64', { p1: element.dependsOn.join('、') }))
  }
  lines.push(fmt('uiDescribe.k65', { p1: element.id }))
  return lines.join('\n')
}

/**
 * 契约字段类型提示块（F-20）。
 *
 * 无提示时返回空数组 —— 回执与修复前**逐字一致**（不引入噪声）；有提示时点名
 * 契约 / 字段 / 当前类型 / 建议写法（可执行）。
 */
function contractFieldNoteBlock(notes: ContractFieldNote[]): string[] {
  const lines = contractFieldNoteLines(notes)
  if (lines.length === 0) return []
  return [contractFieldNoteHeader(), ...lines.map((line) => `- ${line}`)]
}

/** 契约记录的回执。 */
export function describeContract(
  contract: Contract,
  coverage: { totalEdges: number; covered: number; missing: { consumer: string; producer: string }[]; incompleteSemantics: string[] },
  fieldNotes: ContractFieldNote[] = [],
  shapeNotes: FieldShapeNote[] = [],
): string {
  const lines = [fmt('uiDescribe.k187', { p1: contract.id, p2: contract.name, p3: contract.kind })]
  lines.push(fmt('uiDescribe.k66', { p1: contract.failureSemantics.timeout || t('uiDescribe.k158'), p2: contract.failureSemantics.retry || t('uiDescribe.k159'), p3: contract.failureSemantics.idempotency || t('uiDescribe.k160') }))
  lines.push(fmt('uiDescribe.k67', { p1: coverage.covered, p2: coverage.totalEdges }))
  if (coverage.missing.length > 0) {
    lines.push(fmt('uiDescribe.k68', { p1: coverage.missing.map((edge) => `${edge.consumer}→${edge.producer}`).join(' ') }))
    // D4-1：口径写死并**逐条给出该填的值**（consumer = 依赖方元素 name；producer = 被依赖方的 dependsOn 原串）
    lines.push(
      coverage.missing
        .slice(0, 6)
        .map((edge) => fmt('uiDescribe.contractMissingExact', { p1: edge.consumer, p2: edge.producer }))
        .join('\n'),
    )
  }
  if (coverage.incompleteSemantics.length > 0) {
    lines.push(fmt('uiDescribe.k69', { p1: coverage.incompleteSemantics.join(' ') }))
  }
  // F-20：手写 YAML 把字段写成 number/boolean/对象时，回执必须点名（**全量**报出，与 F-16 的
  // 方向矛盾清单同口径：写入后报的是"当前真源的整体状态"，只报本次那条会漏掉手改坏的其他契约）
  lines.push(...contractFieldNoteBlock(fieldNotes))
  // F-21：`dropped` 不是布尔、`requires` 不是列表等形状提示同样全量报出
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** ADR 的回执。 */
export function describeAdr(adr: Adr, supersedes?: string | undefined, shapeNotes: FieldShapeNote[] = []): string {
  const lines = [fmt('uiDescribe.k188', { p1: adr.id, p2: adr.title, p3: adr.status })]
  if (supersedes !== undefined) lines.push(fmt('uiDescribe.k70', { p1: supersedes }))
  lines.push(fmt('uiDescribe.k71', { p1: adr.alternatives.length, p2: adr.consequences.length }))
  lines.push(fmt('uiDescribe.k72', { p1: adr.decision }))
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** ADR 列表。 */
export function describeAdrList(adrs: Adr[], shapeNotes: FieldShapeNote[] = []): string {
  if (adrs.length === 0) return t('uiDescribe.k73')
  const lines = [fmt('uiDescribe.k189', { p1: adrs.length })]
  for (const adr of adrs) {
    lines.push(fmt('uiDescribe.k74', { p1: adr.id, p2: adr.status, p3: adr.title, p4: adr.alternatives.length, p5: adr.consequences.length }))
  }
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** 质量场景的回执。 */
export function describeScenario(scenario: QualityScenario, shapeNotes: FieldShapeNote[] = []): string {
  return [
    fmt('uiDescribe.m2', { p1: scenario.id, p2: scenario.attribute, p3: scenario.priority }),
    fmt('uiDescribe.k75', { p1: scenario.stimulus, p2: scenario.response }),
    fmt('uiDescribe.k76', { p1: scenario.measure }),
    scenario.targets.length === 0 ? t('uiDescribe.k224') : fmt('uiDescribe.k77', { p1: scenario.targets.join(' ') }),
    ...shapeNoteBlock(shapeNotes),
  ].join('\n')
}

/** 质量场景列表。 */
export function describeScenarioList(scenarios: QualityScenario[], shapeNotes: FieldShapeNote[] = []): string {
  if (scenarios.length === 0) return t('uiDescribe.k78')
  const lines = [fmt('uiDescribe.k190', { p1: scenarios.length })]
  for (const scenario of scenarios) {
    const measurable = /\d/u.test(scenario.measure) || /[≥≤<>]=?/u.test(scenario.measure)
    lines.push(fmt('uiDescribe.k243', { p1: scenario.id, p2: scenario.attribute, p3: scenario.priority, p4: scenario.measure, p5: measurable ? '' : t('uiDescribe.k242') }))
  }
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** ATAM-lite 回执。 */
export function describeAssessment(assessment: QualityAssessment, shapeNotes: FieldShapeNote[] = []): string {
  const lines = [t('uiDescribe.k191')]
  lines.push(fmt('uiDescribe.k79', { p1: assessment.risks.length, p2: assessment.risks.length === 0 ? t('uiDescribe.k225') : '' }))
  for (const risk of assessment.risks) lines.push(`    · ${risk}`)
  lines.push(fmt('uiDescribe.k80', { p1: assessment.sensitivities.length }))
  for (const item of assessment.sensitivities) lines.push(`    · ${item}`)
  lines.push(fmt('uiDescribe.k81', { p1: assessment.tradeoffs.length }))
  for (const item of assessment.tradeoffs) lines.push(`    · ${item}`)
  lines.push(fmt('uiDescribe.k82', { p1: assessment.by }))
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** 追溯查询回执。 */
export function describeTrace(data: TraceReport): string {
  const lines = [t('uiDescribe.k192')]
  lines.push(fmt('uiDescribe.k83', { p1: data.total, p2: Math.round(data.coverage * 100) }))
  lines.push(fmt('uiDescribe.k84', { p1: data.orphans.design.length === 0 ? t('uiDescribe.k226') : data.orphans.design.join(' ') }))
  lines.push(fmt('uiDescribe.k85', { p1: data.orphans.tasks.length === 0 ? t('uiDescribe.k227') : data.orphans.tasks.join(' ') }))
  lines.push(fmt('uiDescribe.k86', { p1: data.orphans.tests.length === 0 ? t('uiDescribe.k228') : data.orphans.tests.join(' ') }))
  /**
   * **TASK-038 落点三/四**：缺陷这一类的缺口此前**既不可见也不可拦**（`describeTrace` 只列设计 /
   * 任务 / 用例三类）—— 现在回执要给出孤儿缺陷、指向失效需求的边与**豁免清单**，以及覆盖率读数。
   *
   * 形状取自 `readDefectLinksOf`（`trace.ts` 的唯一现算出口的**读数消费面**，本文件不重算）；
   * 老夹具手工拼的 `TraceReport` 没有这一位 ⇒ 退回只印孤儿 id，**不编造**覆盖率。
   */
  const defectLinks = readDefectLinksOf(data)
  if (defectLinks === undefined) {
    lines.push(fmt('uiDescribe.k86b', { p1: data.orphans.defects.length === 0 ? t('uiDescribe.k226') : data.orphans.defects.join(' ') }))
  } else {
    lines.push(`- ${describeDefectLinks(defectLinks)}`)
    for (const line of defectLinksExemptionLines(defectLinks)) lines.push(`- ${line}`)
  }
  lines.push(fmt('uiDescribe.k87', { p1: data.uncoveredMust.length === 0 ? t('uiDescribe.k229') : data.uncoveredMust.join(' ') }))
  for (const item of data.perRequirement) {
    lines.push(fmt('uiDescribe.k88', { p1: item.id, p2: item.design.join(' ') || t('uiDescribe.k161'), p3: item.tasks.join(' ') || t('uiDescribe.k162'), p4: item.tests.join(' ') || t('uiDescribe.k163') }))
  }
  return lines.join('\n')
}

/**
 * **结构通道的逐条回执**（TASK-074 落点三 / 缺陷 DEF-052）。
 *
 * 病根是"只说数量"：旧回执只印一句「本批有 N 张卡来自结构通道」，驾驶舱**不翻看板就发现不了**
 * 那批卡写范围荒谬 —— 真机上就是这么放过了一张独占 **10 个模块**的卡（TASK-069，其写范围含
 * `src/domain/plan.ts`，一度把真修卡堵在派发队列外）。所以这里**逐条**给出三样东西：
 * ① 卡标题（含设计 id）② 写范围 ③ **判定依据**（命中/未命中哪条覆盖判定）；
 * 另外把**没建卡**的元素也逐条印出来（被覆盖的 / 显式无需卡的 / **写范围超限被拒的**）——
 * "拒绝生成"如果只写在代码里、不写进回执，用户会以为卡建好了。
 *
 * 纯渲染：判定与数据全部由域层（`structuralPlanOf` / `decompose`）给，文案全部走语言包
 * （本文件在 m7 棘轮基线表内，允许的新增硬编码中文数为 0）。
 */
function structuralBasis(how: StructuralCardPlan['how']): string {
  if (how === 'des-task') return t('uiIndex.kStructuralHowDesTask')
  if (how === 'title-marker') return t('uiIndex.kStructuralHowTitleMarker')
  if (how === 'no-card-element') return t('uiIndex.kStructuralHowNoCardElement')
  return t('uiIndex.kStructuralHowNone')
}

/**
 * **三态可辨**（TASK-104 落点一 / DEF-063）：把"凭什么说这个元素已经有卡了"与"压根没依据"
 * 拆成两句不同的话。
 *
 * 为什么非拆不可：旧回执对 `how: 'none'` 印的是「未命中任何覆盖判定 ⇒ 所以才建卡」——
 * 它把**"找不到覆盖证据"**说成了**"这个元素没人做"**。存量补录项目里追溯边（`des-task`）**天然缺失**
 * （本仓 0 条），于是每轮 `decompose` 都按这句话长出一批废卡。三态与"依据为空"必须彼此可辨：
 * `already-covered`（覆盖证据存在）／`no-card-needed`（人已裁决无需卡）／**依据为空**（上面两条都不是）。
 */
function structuralBasisState(row: StructuralCardPlan): string {
  if (row.how === 'none') return t('uiIndex.kStructuralBasisEmpty')
  return fmt('uiIndex.kStructuralBasisEvidence', { p1: structuralBasis(row.how) })
}

/**
 * 依据为空的元素**缺哪几条依据**（逐条点名，不给一句笼统的"没依据"）。
 *
 * 为什么是**静态查表**而不是 `t(\`…_${item}\`)` 拼键名：`lang 守卫`（`test/m7.test.ts`）扫描的是
 * 源码里**字面量**形态的 `t('…')` 引用 —— 拼出来的键名它看不见，于是"键漏了"会在真机上变成
 * 一句 `kStructuralMissing_des-task`（本用例第一版就是这么红的）。查表让三条依据的键名
 * 全部以字面量出现，漏键当场被扫出来。
 */
const MISSING_BASIS_LABEL: Record<CoverageBasisItem, string> = {
  'des-task': t('uiIndex.kStructuralMissingDesTask'),
  'title-marker': t('uiIndex.kStructuralMissingTitleMarker'),
  'no-card-element': t('uiIndex.kStructuralMissingNoCardElement'),
}

function missingBasisText(row: StructuralGapRow): string {
  return row.missing.map((item) => MISSING_BASIS_LABEL[item]).join(' / ')
}

/**
 * **待裁决小节**（TASK-104 落点二/三）：依据为空的元素逐条列名 + 缺哪几条依据 + 三条出路 +
 * **一次性收口动作**（把这次列出的 id 全部写进 `plan.noCardElements` 的现成片段）。
 *
 * 为什么把 `config.yml` 片段直接印在回执里：本仓的实测收口方式是**人工逐条列举** 12 个元素
 * （`.sdo/config.yml` 的 `plan.noCardElements`）—— 那是**一次动作**，但不该由人去 `decompose`
 * 的输出里一条条抄。回执给出"贴上就能用"的片段（含维护纪律注释），收口就从"逐条抄"变成"贴一次"。
 * 注意这条动作**不写盘**：插件只给命令，改 `config.yml` 的是人（写配置属另一条线）。
 */
function structuralDispositionBlock(rows: StructuralGapRow[], policy: 'required' | 'advisory'): string[] {
  const lines: string[] = []
  lines.push(fmt('uiIndex.kStructuralDispositionHeader', { p1: String(rows.length) }))
  for (const row of rows) {
    lines.push(fmt('uiIndex.kStructuralDispositionLine', {
      p1: row.designId,
      p2: row.name,
      p3: missingBasisText(row),
    }))
  }
  lines.push(t(policy === 'required' ? 'uiIndex.kStructuralDispositionRefused' : 'uiIndex.kStructuralDispositionAdvisory'))
  lines.push(t('uiIndex.kStructuralDispositionRemedies'))
  lines.push(fmt('uiIndex.kStructuralDispositionCollect', { p1: rows.map((row) => row.designId).join('\n    - ') }))
  return lines
}

/**
 * 未建卡的原因：`no-basis` = 判重依据为空 ⇒ 拒绝生成（TASK-104 / DEF-063）。
 *
 * **R6（第三批 §3.19）**：`no-basis` 原先**不在** `StructuralSkipReason` 联合里 —— 域层用
 * `as unknown as` 强塞、本文件只好**就地加宽**（曾有一个 `StructuralSkipReasonWithBasis`）⇒
 * **运行期正确、类型面说谎**。现在 `no-basis` 已是 `types.ts` 里的正式取值：
 * 局部加宽已删除，这里直接吃 `StructuralSkipReason`（强转也一并从域层删掉）。
 */
function structuralReason(row: StructuralSkip, reason: StructuralSkipReason): string {
  if (reason === 'no-basis') return t('uiIndex.kStructuralReasonNoBasis')
  if (reason === 'scope-too-broad') {
    return t('uiIndex.kStructuralReasonScopeTooBroad') + fmt('uiIndex.kStructuralScopeTooBroadDetail', { p1: (row.scopes ?? []).join('、') })
  }
  if (reason === 'no-card-needed') return t('uiIndex.kStructuralReasonNoCardNeeded')
  return t('uiIndex.kStructuralReasonAlreadyCovered')
}

export function describeStructuralPlan(plan: StructuralPlan | undefined): string {
  if (plan === undefined) return ''
  const { created, skipped } = plan
  // **TASK-104**：`basisPolicy` / `needsDisposition` 是同一份判定的新增读数（`StructuralPlanResult`）。
  // 这里的读取刻意**退化**成可选：老夹具手工拼的 `StructuralPlan` 没有这两位 ⇒ 退回旧口径，
  // 而不是抛错或编造（同 `readDefectLinksOf` 的处理方式）。
  const extended = plan as StructuralPlan & { basisPolicy?: 'required' | 'advisory' | undefined; needsDisposition?: StructuralGapRow[] | undefined }
  const policy = extended.basisPolicy ?? 'advisory'
  const gaps = extended.needsDisposition ?? []
  if (created.length === 0 && skipped.length === 0 && gaps.length === 0) return ''
  const lines: string[] = []
  lines.push(fmt('uiIndex.kStructuralHeader', { p1: String(created.length), p2: String(skipped.length) }))
  lines.push(t(policy === 'required' ? 'uiIndex.kStructuralPolicyRequired' : 'uiIndex.kStructuralPolicyAdvisory'))
  for (const row of created) {
    lines.push(fmt('uiIndex.kStructuralCreatedLine', { p1: row.title, p2: row.designId, p3: row.writeScopes.join('、') }))
    lines.push(fmt('uiIndex.kStructuralCreatedBasis', { p1: structuralBasisState(row) }))
  }
  if (created.length === 0) lines.push(t('uiIndex.kStructuralNone'))
  for (const row of skipped) {
    // **R6**：`StructuralSkip.reason` 现在是完整的 `StructuralSkipReason`（含 `no-basis`）⇒ 直接用，
    // 不再需要"按运行时值加宽"的局部类型
    const reason: StructuralSkipReason = row.reason
    lines.push(fmt('uiIndex.kStructuralSkippedLine', {
      p1: row.designId,
      p2: row.name,
      p3: structuralReason(row, reason),
      p4: row.how === undefined ? '' : fmt('uiIndex.kStructuralHitBasis', { p1: structuralBasis(row.how) }),
    }))
  }
  if (gaps.length > 0) lines.push(...structuralDispositionBlock(gaps, policy))
  lines.push(t('uiIndex.kStructuralHint'))
  return lines.join('\n')
}

/**
 * **摘要行（一行一张）**：`id` / `role` / `size` / `status` / `owner` / **标题**。
 *
 * **DEF-169（列举面两档化）**：这个形状只有**一处实现** —— `sdo_task action=list` 的看板
 * （{@link describeTaskBoard}）与 `sdo_plan` 的看板（{@link describePlan}）共用它；各写一份就会
 * 让"摘要长什么样"分成两种口径。
 *
 * 为什么**不含** DoD / 写范围 / 证据要求 / 追溯：那四项是**逐卡线性成本**（本仓 187 张卡时
 * `describePlan` 实测 188715 字符），而列举面随卡数增长 ⇒ 必然撞宿主 8000 字符截断，读回执的人
 * 只看到前几张卡，其余只能进 `.sdo/tasks/` 自己找。所以列举面只留"这张卡是谁、谁的角色、多大、
 * 到哪一步、谁在做、叫什么"，全文走**详情档**（`describePlan` 的 `detail: true` 与
 * {@link describeTask}）。
 *
 * 只用**全角空格 / 全角括号**（不是汉字）⇒ `src/interface/describe.ts` 的 i18n 棘轮基线仍是 0
 * （文案仍全部来自语言包；这一行是**排版**，不是句子）。
 */
function taskSummaryLine(task: TaskCard): string {
  return `- ${task.id}　[${task.role}/${task.size}]　${task.status}${task.owner === undefined ? '' : `（${task.owner}）`}　${task.title}`
}

/**
 * `describePlan` 的档位开关（**DEF-169**）。
 *
 * - 缺省 = **摘要档**：逐卡一行（{@link taskSummaryLine}）+ 只补「受阻 / 依赖未满足」两件事；
 *   逐卡 DoD / 写范围 / 证据要求**不进看板**（它们让看板随卡数线性膨胀）。
 * - `detail: true` = **详情档**：与 DEF-169 之前**逐字一致**的全文（`k245` / `k89` / `k90` 三行）。
 *   既有消费方（回执示例、人工核对"这张卡的 DoD 到底写了什么"）依赖这个形状 ⇒ 渲染代码一行没动，
 *   只**新增加**一个开关把它显式要回来。
 */
export interface DescribePlanOptions {
  /** `true` = 详情档（逐卡 DoD / 写范围 / 证据要求全文）。缺省 = 摘要档。 */
  detail?: boolean | undefined
}

/** 拆分结果：卡片 + 六条机械校验结果 + 结构通道的逐条明细（TASK-074）。 */
export function describePlan(
  tasks: TaskCard[],
  issues: PlanIssue[],
  shapeNotes: FieldShapeNote[] = [],
  structural: StructuralPlan | undefined = undefined,
  options: DescribePlanOptions = {},
): string {
  const detail = options.detail === true
  const stats = planStats(tasks)
  const lines: string[] = [fmt('uiDescribe.k194', { p1: stats.total, p2: Object.entries(stats.byStatus).map(([status, count]) => `${status} ${count}`).join('，') || t('uiDescribe.k193') })]
  /**
   * 摘要档只展开**这一轮还要管的卡**（`DEF-169` 落点三：「只保留本次派发 / 受阻 / 依赖未满足的关键信息」）。
   *
   * 为什么 `done` / `dropped` 不上板：两张终态卡对"这一轮派得到什么"零信息量，却各占一行 ——
   * 真账 205 张里 127 done + 一堆 dropped，光它们就 200 行（实测摘要档 21537 字符，超 20000 阈值）。
   * 藏起来**不是静默**：下面用 `uiDescribe.k253` 把"另有 N 张已完成/已作废"现算出来并给两条出路。
   */
  const live = detail ? tasks : tasks.filter((task) => task.status !== 'done' && task.status !== 'dropped')
  for (const task of live) {
    // **摘要档**：一行一张 + 「受阻 / 依赖未满足」——这两件事决定"这一轮能不能派到它"，
    // 所以留在看板上；DoD / 写范围 / 证据要求按 id 单取才给（DEF-169 落点三）。
    if (!detail) {
      const dependency = task.blockedBy.length === 0 ? '' : fmt('uiDescribe.k165', { p1: task.blockedBy.join(' ') })
      lines.push(taskSummaryLine(task) + dependency)
      if (task.status === 'blocked' && task.blockedReason !== undefined) lines.push(fmt('uiDescribe.k96', { p1: task.blockedReason }))
      continue
    }
    lines.push(taskSummaryLine(task))
    lines.push(fmt('uiDescribe.k245', { p1: task.dod.join('；') || t('uiDescribe.k244') }))
    lines.push(fmt('uiDescribe.k89', { p1: task.writeScopes.join('、') || t('uiDescribe.k164'), p2: task.blockedBy.length === 0 ? '' : fmt('uiDescribe.k165', { p1: task.blockedBy.join(' ') }) }))
    lines.push(fmt('uiDescribe.k90', { p1: task.evidenceRequired.join('/'), p2: task.requirements.join(' ') || t('uiDescribe.k166') }))
  }
  // 「没上板的有多少」必须现算着说出来（`retired` = 总数 − 本次展开数；不是写死的句子）
  const retired = tasks.length - live.length
  if (!detail && retired > 0) {
    lines.push(fmt('uiDescribe.k253', {
      p1: String(retired),
      p2: String((stats.byStatus['done'] ?? 0) + (stats.byStatus['verified'] ?? 0)),
      p3: String(stats.byStatus['dropped'] ?? 0),
    }))
  }
  if (issues.length === 0) {
    lines.push(t('uiDescribe.k91'))
  } else {
    lines.push(fmt('uiDescribe.k92', { p1: issues.length }))
    for (const issue of issues) lines.push(`    · [${issue.code}] ${issue.taskId}：${issue.detail}　→ ${issue.remedy}`)
  }
  const structuralBlock = describeStructuralPlan(structural)
  if (structuralBlock !== '') lines.push(structuralBlock)
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** 单张任务卡。 */
export function describeTask(task: TaskCard, shapeNotes: FieldShapeNote[] = []): string {
  const lines = [`${task.id}　[${task.role}/${task.size}]　${task.status}${task.owner === undefined ? '' : `（owner=${task.owner}）`}　r${task.revision}`]
  lines.push(fmt('uiDescribe.k93', { p1: task.goal }))
  lines.push(fmt('uiDescribe.k247', { p1: task.dod.join('；') || t('uiDescribe.k246') }))
  lines.push(fmt('uiDescribe.k94', { p1: task.writeScopes.join('、') || t('uiDescribe.k167') }))
  if (task.evidence.length > 0) {
    lines.push(fmt('uiDescribe.k95', { p1: task.evidence.length, p2: task.evidence.map((item) => `${item.kind}:${item.detail}`).join('；') }))
  }
  if (task.blockedReason !== undefined) lines.push(fmt('uiDescribe.k96', { p1: task.blockedReason }))
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/**
 * **未复用候选的列示档位**（`DEF-175` 的另一半：读数面必须有**上限**，否则它按历史会话数线性膨胀）。
 *
 * 为什么是"按原因归并"而不是"掐掉后 N 条"：`DEF-041` 要求「为什么没复用它」可解释，而真机形状是
 * **上百个候选、只有两三种原因** ⇒ 归并既保住了**原因**，又把体积钉在「原因种数 × 一句原话」的
 * 量级上，与子会话个数**脱钩**。所以要砍的是**数量**，不是原因本身。
 *
 * ⚠️ **`REV-093#3` 的教训（这条判据的第一版错了）**：第一版按「**组数**」封顶（只印前 3 组），
 * 于是出现第 4 种原因时，那种原因**整段消失**——只剩"还有 N 个"的计数。那是把**原因**砍掉了，
 * 与「砍数量不砍原因」自相矛盾。现在改成按**字符预算**封顶：按原因出现顺序累加到预算为止，
 * 于是常见形状（几种原因、每种一句原话）**一定全部印全**；只有在原因**又多又长**时才会折叠，
 * 且折叠时明写「未展开的原因还有 K 种」（种数必须说出来 —— 读者至少知道"原因被折叠了"这件事）。
 */
export const POOL_UNUSABLE_CHARS = 600

/** 每个原因分组里最多点几个子会话（前 8 位：定位够用，逐条仍走 `verbose`）。 */
export const POOL_UNUSABLE_IDS_PER_REASON = 3

/**
 * 原因原话的**硬上限**（字符）：只防"宿主原话无界"这一种极端；归并才是主要手段。
 *
 * 定 200 的依据是**现盘最长的原因原话 168 字符**（掩码回溯判不了时点名缺哪几条禁令）——
 * 上限必须**大于真实形状**，否则默认档会把"缺哪几条禁令"这句最有价值的话切掉；
 * 它只是最后一道保险，不是常规路径（守卫见 `M232-05` 的截断分支两态）。
 */
export const POOL_UNUSABLE_REASON_CHARS = 200

/** 观测面**逐条**列示的缺省条数（`DEF-175` 另一半：`DEF-041` 的逐条面同样需要有上限）。 */
export const FACE_DETAIL_ROWS = 3

/**
 * 池块/观测面的列示档位：缺省有界，`verbose: true` 才展开逐条。
 *
 * ⚠️ **`REV-093#2`**：`verbose` 目前**只有函数级入口**（`sdo_plan` 的参数表里没有它，
 * `src/interface/tools.ts` 与 `src/index.ts` 不在本卡写范围）⇒ 回执正文**不许**再教读者去传它。
 */
export interface ReadoutOptions {
  /** `true` = 逐条展开（人手排查用）；缺省**有界汇总**（回执默认档）。 */
  verbose?: boolean | undefined
}

/** 一个原因分组的一段文本：`原因原话×条数（样本 前8位 … +其余）`。 */
function unusableGroupPiece(reason: string, ids: readonly string[]): string {
  const why = reason.length > POOL_UNUSABLE_REASON_CHARS ? `${reason.slice(0, POOL_UNUSABLE_REASON_CHARS)}…` : reason
  const sampleIds = ids.slice(0, POOL_UNUSABLE_IDS_PER_REASON)
  const more = ids.length > sampleIds.length ? ` +${String(ids.length - sampleIds.length)}` : ''
  return `${why}×${String(ids.length)}（${sampleIds.join(' ')}${more}）`
}

/**
 * **未复用候选的缺省档文本**：按原因原话归并 + 每个原因点几个样本 + **字符预算封顶**。
 *
 * 有界性由三个常量钉住（{@link POOL_UNUSABLE_CHARS} / {@link POOL_UNUSABLE_IDS_PER_REASON} /
 * {@link POOL_UNUSABLE_REASON_CHARS}）⇒ 文本长度与候选个数无关；原因种数在预算内**全部印全**
 * （守卫见 `test/m230.test.ts` 的 `M232-01` / `M232-02` / `M232-05`）。
 *
 * 折叠时必须**把被折叠的规模说出来**：候选条数用语言包的既有键，**原因种数**用 ASCII 投影
 * （语言包文件不在本卡写范围，见 `uiDescribe.kPoolUnusableMore` 的同类处置）。
 */
function unusableFoldText(rows: readonly { childSessionId: string; reason: string }[]): string {
  const groups = new Map<string, string[]>()
  for (const row of rows) {
    const ids = groups.get(row.reason) ?? []
    ids.push(row.childSessionId.slice(0, 8))
    groups.set(row.reason, ids)
  }
  const entries = [...groups.entries()]
  const parts: string[] = []
  let spent = 0
  let index = 0
  for (; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry === undefined) break
    const piece = unusableGroupPiece(entry[0], entry[1])
    // 第一段**无条件印**（哪怕它自己就超预算）：一条原因都不印，那块读数就等于没解释为什么没复用。
    if (parts.length > 0 && spent + piece.length + 1 > POOL_UNUSABLE_CHARS) break
    parts.push(piece)
    spent += piece.length + 1
  }
  const folded = entries.slice(index)
  if (folded.length > 0) {
    const count = folded.reduce((sum, [, ids]) => sum + ids.length, 0)
    parts.push(`${fmt('uiDescribe.kPoolUnusableMore', { p1: String(count) })}[reasons-not-shown=${String(folded.length)}]`)
  }
  return parts.join('；')
}

/** 一条观测的**逐条**两行（公告面 + 执行面）—— 与修前逐字相同，`verbose` 档与样本档共用。 */
function childFaceDetailLines(face: {
  childSessionId: string
  tools: string[]
  violations: string[]
  calls?: string[] | undefined
  callCount?: number | undefined
}): string[] {
  const lines: string[] = []
  lines.push(
    face.violations.length === 0
      ? fmt('uiDescribe.k203FaceAnnouncedClean', { p1: face.childSessionId, p2: String(face.tools.length) })
      : fmt('uiDescribe.k204FaceAnnouncedViolations', { p1: face.childSessionId, p2: face.violations.join(' ') }),
  )
  const called = face.calls ?? []
  if (called.length === 0) {
    lines.push(fmt('uiDescribe.k205FaceCalledClean', { p1: face.childSessionId }))
    return lines
  }
  // 文案里的"N 次"必须是**次数**（`calls` 是去重名 —— 两者口径不同，评审第三轮 B）
  lines.push(
    fmt('uiDescribe.k206FaceCalledViolations', {
      p1: face.childSessionId,
      // 旧条目（没有 callCount）用去重名字数兜底：方向**保守**（不夸大次数），
      // 新条目都带 callCount ⇒ 正常路径不会走到兜底（评审第四轮 §3）。
      p2: String(face.callCount ?? called.length),
      p3: String(called.length),
      p4: called.join(' '),
    }),
  )
  return lines
}

/**
 * **角色池块**（子代理复用）：派发回执与 `sdo_status` 共用同一份渲染 —— 口径只有一份。
 *
 * 为什么必须有这一块：池上限与排队是**限制**，限制必须在回执里可见（否则用户只会看到
 * "有几张卡这次没派出去"，猜不出是池满了还是在等预算）。
 *
 * **有界（`DEF-175`）**：缺省档把"不可复用"那批按**原因**归并（见 {@link unusableFoldText}），
 * 体积与候选个数脱钩；要逐条看原始清单（`verbose: true`）—— 那条路一字不少。
 */
export function describePoolBlock(
  pools: RolePool[],
  queued: string[],
  reuseSupported: boolean,
  orphanTtlMinutes = 0,
  options: ReadoutOptions = {},
): string {
  if (pools.length === 0) return ''
  const lines = [t('uiDescribe.kPoolHeader')]
  for (const pool of pools) {
    lines.push(
      fmt('uiDescribe.kPoolLine', {
        p1: pool.role,
        p2: String(pool.busy.length),
        p3: String(pool.cap),
        p4: String(pool.idle.length),
        p5: String(pool.retired),
        p6: String(pool.stale.length),
      }),
    )
  }
  // **DEF-066**：把"空闲可复用"按**宿主会不会拒**如实分栏 —— 真机矛盾：`sdo_status` 报
  // 「空闲可复用 31」而派发器**永远新起**（那 31 个是上一任驾驶舱派的，宿主一律拒 `belongs to
  // another parent session`）。分栏后读数与行为同源。
  for (const pool of pools) {
    if (pool.idleForeign.length === 0 && pool.idleUnknownParent === 0) continue
    const same = pool.idleSameParent.map((child) => child.childSessionId.slice(0, 8)).join(' ')
    lines.push(
      fmt('uiDescribe.kPoolIdleScope', {
        p1: pool.role,
        p2: String(pool.idleSameParent.length),
        p3: String(pool.idleForeign.length),
        p4: String(pool.idleUnknownParent),
        p5: same === '' ? t('uiDescribe.kPoolIdleNone') : same,
      }),
    )
  }
  // **DEF-066 落点一**：在飞子会话给出 `卡 → 子会话前 8 位` —— owner 槽位名（`subagent:角色:序`）
  // 会被多个会话用过（实测一槽位 33 个会话），**唯一定位实现者靠的是 uuid**。
  const busyRows = pools.flatMap((pool) => pool.busy.map((child) => ({ role: pool.role, child })))
  if (busyRows.length > 0) {
    const shown = busyRows.slice(0, 4).map((row) =>
      `${row.child.task === '' ? t('uiDescribe.kPoolIdleNone') : row.child.task}→${row.child.childSessionId.slice(0, 8)}`
      + fmt('uiDescribe.kPoolBusyLoad', {
        p1: String(row.child.rounds),
        p2: String(row.child.cards ?? row.child.rounds),
      }),
    )
    lines.push(
      fmt('uiDescribe.kPoolBusyMap', {
        p1: shown.join(' '),
        p2: busyRows.length > shown.length ? fmt('uiDescribe.kPoolUnusableMore', { p1: String(busyRows.length - shown.length) }) : '',
      }),
    )
  }
  const stale = pools.reduce((sum, pool) => sum + pool.stale.length, 0)
  if (stale > 0) lines.push(fmt('uiDescribe.kPoolOrphanNote', { p1: String(stale), p2: String(orphanTtlMinutes) }))
  // **R-1**：不能复用、也**不占池位**的空闲子代理必须看得见（否则"池里明明有人却新起了一个"无法解释）
  const unusable = pools.flatMap((pool) => pool.unusable.map((item) => ({ ...item, role: pool.role })))
  if (unusable.length > 0) {
    // **DEF-041**：**每个**未复用候选都要给出原因（旧实现只印前 3 个，其余折成"还有 N 个" ——
    // 而"为什么没复用它"恰恰是判断池化有没有生效的关键）。
    // **DEF-175**：但"每个都印一整行"会按历史会话数线性膨胀（现盘 101 个候选 ⇒ 一万六千字符，
    // 把派发结论挤到宿主的 8000 截断之外）⇒ 缺省档**按原因归并**（原因整句保留、样本给前几个），
    // 要**逐条**原始清单就带 `verbose`（那条路一字不少，见 {@link unusableFoldText}）。
    const detail = options.verbose === true
      ? unusable.map((item) => `${item.childSessionId.slice(0, 8)}（${item.reason}）`).join('；')
      : unusableFoldText(unusable)
    lines.push(fmt('uiDescribe.kPoolUnusable', { p1: String(unusable.length), p2: detail }))
  }
  if (queued.length > 0) lines.push(fmt('uiDescribe.kPoolQueued', { p1: String(queued.length), p2: queued.join(' ') }))
  if (!reuseSupported) lines.push(t('uiDescribe.kPoolNoReuse'))
  return lines.join('\n')
}

/** 认领冲突（CAS 失败等）。 */
export function describeTaskConflict(detail: string, current: TaskCard | undefined, code: string): string {
  const lines = [fmt('uiDescribe.k195', { p1: code, p2: detail })]
  if (current !== undefined) {
    lines.push(fmt('uiDescribe.k97', { p1: current.status, p2: current.revision, p3: current.owner === undefined ? '' : `　owner=${current.owner}` }))
    lines.push(fmt('uiDescribe.k98', { p1: current.revision }))
  }
  return lines.join('\n')
}

/**
 * **列举面的收窄参数**（**DEF-169** 落点二）：`sdo_task action=list` 的四个过滤条件。
 *
 * 为什么必须有：卡数随时间线性长（本仓已 205 张），而宿主把单次回执截在 8000 字符
 * （`clampToolResult`）⇒ **"默认全量"= 把后面的卡静默丢掉**。收窄不是可选项，是让回执能读全的
 * 唯一办法；而收窄本身**也必须说出来**（见 {@link selectTaskBoard} 的 `filters` 与尾部提示）。
 */
export interface TaskBoardFilter {
  /** 精确匹配卡状态（`ready` / `in-progress` / `blocked` / `done` / `dropped`…）。 */
  status?: string | undefined
  /** 精确匹配 owner 串（`developer-0aff6e4b` 这类；不再做前缀/模糊匹配 —— 猜错的过滤比不过滤更坏）。 */
  owner?: string | undefined
  /** 精确匹配角色（`developer` / `tester` / `reviewer`…）。 */
  role?: string | undefined
  /** 显示上限；缺省 {@link TASK_BOARD_DEFAULT_LIMIT}，`0` = 显式要全量（回执里看得见 `limit=0`）。 */
  limit?: number | undefined
}

/**
 * 缺省显示张数（`sdo_task action=list` 与 `sdo_plan` 看板共用**这一个数**）。
 *
 * 依据：摘要行实测约 130 字符/行 ⇒ 50 行 ≈ 6500 字符，仍在宿主 8000 上限之内；定 50 而不是"全部"，
 * 是因为"全部"在卡数超过 ~60 张时就必然被截断，而截断点由宿主决定、插件看不见（读者只会以为卡就那么多）。
 */
export const TASK_BOARD_DEFAULT_LIMIT = 50

/** 一次筛选的读数：显示哪些、命中多少、截掉多少、哪些条件生效了。 */
export interface TaskBoardSelection {
  /** 实际要渲染的卡（已按 `limit` 截断；顺序与入参一致 —— 排序是调用方的事）。 */
  shown: TaskCard[]
  /** 命中条件的卡数（**未**截断）。 */
  matched: number
  /** 命中但没显示的张数（= `matched - shown.length`）。 */
  hidden: number
  /** 生效条件的可读串（如 `status=done` / `limit=50`）；**空数组** = 一个字都没筛（全量缺省）。 */
  filters: string[]
}

/**
 * 按 {@link TaskBoardFilter} 选卡 —— 列举面的**唯一**筛选实现。
 *
 * 三条口径（都是 DEF-169 的验收面，写成注释是因为它们不写在类型里）：
 *   ① **精确匹配**：`status`/`owner`/`role` 都只认全等；给空串 = 没给（不许"空串等于筛空"）。
 *   ② **`limit` 只截断、不排序**：先过滤后截断 —— 反过来会得到"筛到的卡不在前 N 张里"的假空。
 *   ③ **截断必须可数**：`hidden` 是现算的差，尾部提示直接印它（守卫按这个差核对，不许写死）。
 */
export function selectTaskBoard(tasks: TaskCard[], filter: TaskBoardFilter = {}): TaskBoardSelection {
  const filters: string[] = []
  const wanted = { status: filter.status, owner: filter.owner, role: filter.role }
  for (const [key, value] of Object.entries(wanted)) {
    if (value !== undefined && value !== '') filters.push(`${key}=${value}`)
  }
  const matchedTasks = tasks.filter((task) =>
    (wanted.status === undefined || wanted.status === '' || task.status === wanted.status)
    && (wanted.owner === undefined || wanted.owner === '' || task.owner === wanted.owner)
    && (wanted.role === undefined || wanted.role === '' || task.role === wanted.role))
  const limit = filter.limit ?? TASK_BOARD_DEFAULT_LIMIT
  if (filter.limit !== undefined) filters.push(`limit=${limit}`)
  // `limit=0` = 显式要全量（调用方写明了，就不是"静默省略"）；负数按 0 处理，不静默变成"显示一张"。
  const shown = limit > 0 ? matchedTasks.slice(0, limit) : matchedTasks
  return { shown, matched: matchedTasks.length, hidden: matchedTasks.length - shown.length, filters }
}

/**
 * 任务看板（文本）= `sdo_task action=list` 的**摘要档**。
 *
 * **DEF-169**：这张看板本来就是一行一张（不含 DoD），所以它天然就是摘要档；它做三件事 ——
 * ① 行格式收敛到 {@link taskSummaryLine}（与 `sdo_plan` 看板同一处实现，防止两份摘要漂移）；
 * ② 在类型面把「这里是列举面」写清楚：本看板**没有**逐卡全文这一档，逐卡全文只有
 * {@link describeTask} 一个渲染面（`sdo_task action=list id=<卡>` 就走它）；
 * ③ 收窄与截断**都说出来**：生效条件一行（`uiDescribe.k250`）+ 截断一行（`uiDescribe.k251`）。
 *   「另有 N 张未显示」是**现算的差**（{@link selectTaskBoard} 的 `hidden`），不是写死的句子。
 *
 * 计数行（`k196`）数的是**全部**卡 —— 筛选只影响逐卡行，不改变这一行的总数口径
 * （"全库 205 张、这次筛出 12 张"必须同时可读，否则筛选会伪装成"库里就这么点卡"）。
 *
 * `extraLines` 是**调用方**要在尾部提示**之前**补的段（本仓的用法是 `index.ts` 的 `fixes` 逐卡声明）——
 * 放在这里是因为尾部提示必须是**最后一行**（读者按"最后一行"找它），而这一段不能跑到它后面去。
 */
export function describeTaskBoard(input: {
  tasks: TaskCard[]
  ready: TaskCard[]
  stale: TaskCard[]
  issues: PlanIssue[]
  iteration?: { number: number; goal: string; status: string } | undefined
  shapeNotes?: FieldShapeNote[] | undefined
  filter?: TaskBoardFilter | undefined
  extraLines?: string[] | undefined
}): string {
  const { tasks, ready, stale, issues, iteration } = input
  const shapeNotes = input.shapeNotes ?? []
  const extraLines = input.extraLines ?? []
  if (tasks.length === 0) {
    // 任务为空时形状提示同样要出现（F-21 的"不静默"，与 describeDesign 同口径）
    return [t('uiDescribe.k99'), ...shapeNoteBlock(shapeNotes)].join('\n')
  }
  const selection = selectTaskBoard(tasks, input.filter)
  // 筛选后为空 ≠ 库里没有卡：两张回执必须读得不一样（否则"筛错了"会被读成"卡没了"）。
  if (selection.shown.length === 0) {
    return [
      fmt('uiDescribe.k252', { p1: String(selection.matched), p2: String(tasks.length), p3: selection.filters.join('、') || t('uiDescribe.k193') }),
      ...shapeNoteBlock(shapeNotes),
      ...extraLines,
    ].join('\n')
  }
  const shownIds = new Set(selection.shown.map((task) => task.id))
  // 可派发 / 失联两行跟着**筛选**走（不跟 `limit`）：它们是"这一轮派不派得到"的判断面，
  // 被筛掉的卡本来就不是这次问的对象；但 `limit` 只是显示上限，不该改变这条读数。
  const byFilter = (task: TaskCard): boolean => (selection.filters.length === 0 ? true : shownIds.has(task.id))
  const shownReady = ready.filter(byFilter)
  const shownStale = stale.filter(byFilter)
  const stats = planStats(tasks)
  const lines = [fmt('uiDescribe.k196', { p1: stats.total, p2: stats.done, p3: stats.byStatus['in-progress'] ?? 0, p4: stats.byStatus['blocked'] ?? 0 })]
  if (iteration !== undefined) lines.push(fmt('uiDescribe.k100', { p1: iteration.number, p2: iteration.status, p3: iteration.goal }))
  lines.push(fmt('uiDescribe.k101', { p1: shownReady.length, p2: shownReady.map((task) => task.id).join(' ') || t('uiDescribe.k168') }))
  // 生效条件：一条都不筛时**一个字都不印**（否则每份回执都多一行固定噪音，读者会当它没信息）
  if (selection.filters.length > 0) {
    lines.push(fmt('uiDescribe.k250', {
      p1: selection.filters.join('、'),
      p2: String(stats.total),
      p3: String(selection.matched),
      p4: String(selection.shown.length),
    }))
  }
  for (const task of selection.shown) {
    lines.push(taskSummaryLine(task))
  }
  if (shownStale.length > 0) {
    lines.push(fmt('uiDescribe.k102', { p1: shownStale.length, p2: shownStale.map((task) => task.id).join(' ') }))
  }
  if (issues.length > 0) lines.push(fmt('uiDescribe.k103', { p1: issues.length }))
  lines.push(...shapeNoteBlock(shapeNotes))
  lines.push(...extraLines)
  // **尾部提示必须是最后一行**：读者按"最后一行"找它，中间夹别的东西就等于没提示。
  if (selection.hidden > 0) lines.push(fmt('uiDescribe.k251', { p1: String(selection.hidden) }))
  return lines.join('\n')
}

/**
 * **工具面的两条口径**（2026-10-08 纠正后）：SDO 流程面是**白名单**，通用面是**黑名单**。
 *
 * 回执必须把这两层分开说 —— 之前只有一句"工具面：read write …"，读的人无法知道
 * "通用面（技能/记忆/联网…）到底给没给"，而真机缺陷正是**通用面被静默清空**。
 */
export function maskPlaneLine(request: DispatchRequest): string {
  return fmt('uiDescribe.kMaskSdoPlane', { p1: request.sdoAllow.join(' ') || t('uiDescribe.k169') })
}

/**
 * 派发请求（宿主后端）——**这是"没派出去"时的回执**：提示词与掩码都在这儿，交给流程官自行转交。
 * 真派发成功走 {@link describeDispatchStarted}（P-1）。
 */
export function describeDispatch(request: DispatchRequest, degradedReason?: string | undefined): string {
  const lines = [fmt('uiDescribe.k197', { p1: request.task.id, p2: request.owner, p3: request.backend, p4: request.persona })]
  lines.push(
    t('uiDescribe.k104')
    + t('uiDescribe.k105'),
  )
  if (degradedReason !== undefined) lines.push(fmt('uiDescribe.kDispatchDegraded', { p1: degradedReason }))
  lines.push(maskPlaneLine(request))
  lines.push(fmt('uiDescribe.k106', { p1: request.writeScopes.join('、') || t('uiDescribe.k169') }))
  lines.push(fmt('uiDescribe.k107', { p1: request.expectedRevision }))
  lines.push('')
  lines.push(request.prompt)
  return lines.join('\n')
}

/**
 * **已真正派发**（P-1）：宿主起了子代理运行 —— 回执给子会话 id、provider、下发的工具数与写范围，
 * 提示词仍然附上（便于留档与人工核对），但**不再**让流程官自己转交。
 *
 * **口径（2026-10-03 评审纠正后）**：只陈述**能证明**的两件事 —— ① 我们把 `toolFilter` 下发了（附 provider
 * 与它声明的能力值）；② **子代理的工具面是否真的收窄，本插件无法自证**。真机反例见
 * sdo-test §8.4②（`spawn` 派发出去的子代理仍然调用了 `sdo_plan`/`sdo_review`/`sdo_gate`，被钩子拒绝）。
 * 所以这里**不再**写"它看不到掩码外的工具" —— 那是替宿主打包票。
 *
 * **D-14（sdo-test-new 2026-10-08，blocker）连带②**：`dispatched` 必须是**实际下发**的那份名单
 * （过滤后的 `applied`），不是"角色意图"的名单 —— 旧写法把 `request.toolFilter` 当已下发事实写进
 * 回执，于是同一份回执里「下发给它的工具面共 11 个」与「`dispatch/started.tools: 0`」并存，
 * 而子会话实录证明**真正发出去的是空集**；读回执的人无法知道真相。空集必须显式告警。
 */
export function describeDispatchStarted(
  request: DispatchRequest,
  provider: string,
  childSessionId: string,
  /**
   * **实际下发的 deny 面**（只发 deny、不发 allow —— 见 `DispatchRequest.toolDeny`）。
   * 空数组 = 什么都没挡（在真机上这本身就是可疑信号，回执会告警）。
   */
  denyFace: readonly string[],
  toolFilterDeclared = false,
  reuseSupported = false,
  faces: { childSessionId: string; tools: string[]; violations: string[]; calls?: string[] | undefined; callCount?: number | undefined }[] = [],
  /** 本次派发的复用事实（F-4：能力与"本次是否复用"必须分开说，别让回执变成假阳性） */
  dispatch?: { reused: boolean; mode: 'continuable' | 'one-shot' } | undefined,
  /** **D-15**：降级/覆盖原因在**成功路径**上也要回显（旧实现只有失败路径才渲染它） */
  degradedReason?: string | undefined,
  /** **D-15**：显式指定覆盖了本迭代锁时的留痕说明 */
  overrideNote?: string | undefined,
): string {
  const lines = [fmt('uiDescribe.k199DispatchStarted', { p1: request.task.id, p2: request.owner, p3: provider, p4: childSessionId })]
  lines.push(fmt('uiDescribe.k200DispatchTools', {
    p1: String(request.sdoAllow.length),
    p2: request.persona,
    p3: String(denyFace.length),
  }))
  if (denyFace.length === 0) lines.push(t('uiDescribe.kDispatchEmptyFace'))
  if (degradedReason !== undefined) lines.push(fmt('uiDescribe.kDispatchDegraded', { p1: degradedReason }))
  if (overrideNote !== undefined) lines.push(fmt('uiDescribe.kDispatchDegraded', { p1: overrideNote }))
  // 只报"我们做了什么"与"provider 声明了什么"，并**明说本插件不能自证生效**（越界由钩子兜底）
  lines.push(fmt('uiDescribe.k201MaskHandedOver', { p1: provider, p2: toolFilterDeclared ? t('uiDescribe.k231Yes') : t('uiDescribe.k232No') }))
  lines.push(t('uiDescribe.k202MaskNotSelfVerifiable'))
  // 复用（方案 1）：宿主今天没有 continuable 入口 ⇒ 如实说 one-shot；探到就自动改口径
  lines.push(reuseSupported ? t('uiDescribe.k203ReuseSupported') : t('uiDescribe.k204ReuseOneShot'))
  // **F-4（2026-10-05 真机）**：只报"宿主有可续聊入口"会让模型读成"这次复用了" —— 真机 10 次派发
  // 全 `reused:false` 却只看到「复用：可用」。所以能力与本次事实分两句，并写出观测到的取值。
  if (dispatch !== undefined) {
    lines.push(fmt('uiDescribe.kReuseThisDispatch', {
      p1: dispatch.reused ? t('uiDescribe.kReuseThisYes') : t('uiDescribe.kReuseThisNo'),
      p2: dispatch.mode,
    }))
  }
  lines.push(maskPlaneLine(request))
  lines.push(fmt('uiDescribe.kDispatchDenyFace', { p1: String(denyFace.length), p2: denyFace.join(' ') || t('uiDescribe.k169') }))
  lines.push(fmt('uiDescribe.k106', { p1: request.writeScopes.join('、') || t('uiDescribe.k169') }))
  lines.push(...childFaceLines(faces))
  // 观测是**持续**写入的：派发这一刻子代理还没跑，所以这里必然可能"未观测到"——指路，别让它成为死数据
  lines.push(t('uiDescribe.k207FaceLedgerPointer'))
  lines.push(fmt('uiDescribe.k107', { p1: request.expectedRevision }))
  lines.push('')
  lines.push(request.prompt)
  return lines.join('\n')
}

/**
 * **公告面 + 执行面**的观测渲染（派发回执与 `sdo_status` 共用一处 —— 口径只能有一份）。
 *
 * - 公告面：`request/header` 里它被公告的工具与掩码外项（宿主收窄的是**公告清单**）；
 * - 执行面：本会话里**实际发起**的掩码外调用次数与去重后的工具名（模型对**未公告**工具仍能调用，钩子兜底拒绝）。
 *
 * **有界（`DEF-175` 的另一半）**：一个子会话两行，而历史子会话有上百个（现盘 103 个 ⇒ 一万五千
 * 字符）⇒ 缺省档只**逐条**打印前 {@link FACE_DETAIL_ROWS} 条（**有问题的排在前面**：公告面越界、
 * 执行面有掩码外调用 —— 这两类才是"工具面到底收窄了没有"的直接证据），其余折成一行计数归纳；
 * 函数级的 `verbose` 档与修前逐字相同。
 *
 * ⚠️ **`REV-093#2`（回执不许教读者一个不存在的参数）**：归纳行**不再**写「raise to every line:
 * verbose=true」—— `sdo_plan` 的参数表里没有 `verbose`（`src/interface/tools.ts` 与 `src/index.ts`
 * 不在本卡写范围），照那句话做只会拿到宿主 schema 里没有的参数。归纳行改为指一条**真有的**出路：
 * 逐条原始观测就在台账原件 `evidence/child-tools.jsonl` 里（同一份数据，只是不经回执）。
 *
 * 归纳行是**语言中立 ASCII**：语言包文件不在本卡写范围内（`src/data/lang/*.yml`），
 * 而这条是给复验者的读数、不是终端用户的散文 —— 与 `domain/snapshot.ts` 的 `renderQueueTable` 同口径。
 */
export function childFaceLines(
  faces: { childSessionId: string; tools: string[]; violations: string[]; calls?: string[] | undefined; callCount?: number | undefined }[],
  options: ReadoutOptions = {},
): string[] {
  const hot = faces.filter((face) => face.violations.length > 0 || (face.calls ?? []).length > 0)
  const cold = faces.filter((face) => face.violations.length === 0 && (face.calls ?? []).length === 0)
  // 逐条档：原顺序、全部；缺省档：**有问题的先打**、条数钉在 `FACE_DETAIL_ROWS`。
  const shown = options.verbose === true ? faces : [...hot, ...cold].slice(0, FACE_DETAIL_ROWS)
  const lines: string[] = []
  for (const face of shown) lines.push(...childFaceDetailLines(face))
  const folded = faces.length - shown.length
  if (folded > 0) {
    // 归纳行必须**自己说清被折掉的是什么**：条数 + 三类计数 + 去哪看全量（否则读者以为"只观测到 3 个"）
    const outsideCalls = faces.reduce((sum, face) => sum + (face.callCount ?? (face.calls ?? []).length), 0)
    const announcedViolations = faces.filter((face) => face.violations.length > 0).length
    lines.push(
      `faces: ${String(faces.length)} observed; announced-with-violations ${String(announcedViolations)};`
      + ` outside-mask calls ${String(outsideCalls)}; detailed ${String(shown.length)}, folded ${String(folded)}`
      + ' (every line lives in .sdo/evidence/child-tools.jsonl)',
    )
  }
  return lines
}

/** 就地执行（inline 降级）：把任务卡交给主模型。 */
export function describeInlineHandoff(
  request: DispatchRequest,
  degradedReason?: string | undefined,
  /** **D-15**：显式指定覆盖了本迭代锁时的留痕说明（与降级是两件事，都要看得见） */
  overrideNote?: string | undefined,
): string {
  const lines = [fmt('uiDescribe.k198', { p1: request.task.id, p2: degradedReason === undefined ? '' : `：${degradedReason}` })]
  if (overrideNote !== undefined) lines.push(fmt('uiDescribe.kDispatchDegraded', { p1: overrideNote }))
  lines.push(fmt('uiDescribe.k108', { p1: request.owner, p2: request.task.id, p3: request.owner }))
  lines.push('')
  lines.push(request.prompt)
  return lines.join('\n')
}

/** 交付清单。 */
export function describeManifest(manifest: DeliveryManifest, shapeNotes: FieldShapeNote[] = []): string {
  const lines = [fmt('uiDescribe.k199', { p1: manifest.id, p2: manifest.by, p3: manifest.at })]
  lines.push(fmt('uiDescribe.k109', { p1: manifest.artifacts.length }))
  for (const artifact of manifest.artifacts) {
    // **DEF-031**：逐条印出「这个哈希截至何时」；旧清单没有该键 ⇒ 显式说「未记时刻」，不假装有
    const asOf = artifact.asOf === '' ? t('uiDescribe.kDeliveryAsOfUnknown') : artifact.asOf
    lines.push(`    · ${artifact.path}　[${artifact.kind}]　${artifact.sha256.slice(0, 12)}…　${fmt('uiDescribe.kDeliveryAsOf', { p1: asOf })}`)
  }
  lines.push(fmt('uiDescribe.k110', { p1: manifest.acceptance.length, p2: manifest.acceptance.map((row) => `${row.requirement}:${row.verdict}`).join(' ') }))
  lines.push(fmt('uiDescribe.k111', { p1: manifest.rollbackPoint }))
  lines.push(fmt('uiDescribe.k112', { p1: manifest.prototypeExcluded ? t('uiDescribe.k230') : t('uiDescribe.k170') }))
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** `sdo_requirement action=update` 的回执（**不能**复用 capture 的"已捕获"，那是误导）。 */
export function describeRequirementUpdate(
  result: {
    requirement: Requirement
    flags: string[]
    /** **R-25**：`acceptanceMode=replace` 造成的验收标准编号变动（交付矩阵的追溯键会失配） */
    acceptanceRenumbered?: { from: string; to: string }[] | undefined
    /**
     * **N-7（D-21④）**：这次 update 动的是**受控字段**（已冻结需求上的验收标准）——
     * 规范路径是 `action=change`（带影响分析与决策）。这里不拦（`update` 是既有合法路径），
     * 但必须**出声**，否则「绕过变更控制」这件事在回执上完全不可见。
     */
    controlledAcceptance?: boolean | undefined
  },
  shapeNotes: FieldShapeNote[] = [],
): string {
  const { requirement, flags } = result
  const lines = [fmt('uiDescribe.k200', { p1: requirement.id, p2: requirement.title })]
  lines.push(
    fmt('uiDescribe.k113', { p1: label('requirementKind', String(requirement.kind ?? 'functional')), p2: label('priority', String(requirement.priority ?? 'should')) })
    + fmt('uiDescribe.k114', { p1: label('requirementStatus', String(requirement.status ?? 'draft')), p2: requirement.ambiguity.score }),
  )
  lines.push(fmt('uiDescribe.k115', { p1: requirement.acceptance.length }))
  // **R-25**：编号变了必须当场说 —— AC 编号是交付验收矩阵的追溯键，静默改号会**作废已出的交付包**
  // （真机：改三处 AC 文本 ⇒ 六条引用全部失配 ⇒ G7 判红，而回执全程没提编号）
  const renumbered = result.acceptanceRenumbered ?? []
  if (renumbered.length > 0) {
    lines.push(fmt('uiDescribe.kAcceptanceRenumbered', {
      p1: String(renumbered.length),
      p2: renumbered.map((item) => `${item.from}→${item.to}`).join(' '),
    }))
  }
  // **N-7**：受控字段被直接改过 ⇒ 点明规范路径（不拦，只提示；这是"绕过变更控制"唯一的可见点）
  if (result.controlledAcceptance === true) {
    lines.push(t('uiDescribe.acControlledHint'))
  }
  if (flags.length > 0) lines.push(`- ⚠️ ${flags.join('；')}`)
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** 需求评分的一行摘要。 */
export function describeScore(requirement: Requirement): string {
  const parts = DIMENSIONS.map((dimension) => `${dimension} ${requirement.ambiguity.dimensions[dimension] ?? 0}`)
  const review = requirement.ambiguity.needsReview === true ? t('uiDescribe.k231') : ''
  return `${requirement.ambiguity.score}/16${review} ｜ ${parts.join(' ｜ ')}`
}

/** `sdo_requirement action=capture` 的回执。 */
export function describeCapture(result: { requirement: Requirement; flags: string[] }, shapeNotes: FieldShapeNote[] = []): string {
  const { requirement, flags } = result
  const lines: string[] = [fmt('uiDescribe.k201', { p1: requirement.id, p2: requirement.title })]
  lines.push(fmt('uiDescribe.k116', { p1: requirement.kind, p2: requirement.priority ?? t('uiDescribe.k171'), p3: requirement.status }))
  lines.push(fmt('uiDescribe.k117', { p1: describeScore(requirement) }))
  if (flags.length > 0) {
    lines.push(fmt('uiDescribe.k118', { p1: flags.join('、') }))
  }
  lines.push(fmt('uiDescribe.k119', { p1: requirement.id }))
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** 一批问题的渲染（工具与命令共用）。 */
export function describeQuestions(questions: GrillQuestion[], skipped: string[] = [], shapeNotes: FieldShapeNote[] = []): string {
  if (questions.length === 0) {
    const lines = [t('uiDescribe.k202')]
    if (skipped.length > 0) lines.push(fmt('uiDescribe.k120', { p1: skipped.join(' ') }))
    lines.push(t('uiDescribe.k121'))
    lines.push(...shapeNoteBlock(shapeNotes))
    return lines.join('\n')
  }
  const lines: string[] = [fmt('uiDescribe.k203', { p1: questions.length })]
  questions.forEach((question, index) => {
    lines.push('')
    lines.push(`${index + 1}. [${question.severity}／${question.dimension}] ${question.id}　${question.text}`)
    lines.push(fmt('uiDescribe.k122', { p1: question.targets.join(' ') }))
    lines.push(fmt('uiDescribe.k123', { p1: question.why }))
    lines.push(fmt('uiDescribe.k124', { p1: question.consequenceIfUnasked }))
    question.options.forEach((option, optionIndex) => {
      lines.push(fmt('uiDescribe.k125', { p1: optionIndex, p2: option.label, p3: option.cost }))
    })
    lines.push(fmt('uiDescribe.k126', { p1: question.defaultRecommendation }))
    // **D-2 残留**：撞上项目声明的非目标 ⇒ 当场点名（不静默跳过：非目标也可能需要确认，
    // 但使用者必须知道"这条问的是一件项目已明确不做的事"）
    if (question.nonGoalConflict !== undefined) {
      lines.push(fmt('uiDescribe.kNonGoalConflict', { p1: question.nonGoalConflict }))
    }
  })
  lines.push('')
  lines.push(t('uiDescribe.k127'))
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** `sdo_requirement action=answer` 的回执。 */
export function describeAnswer(
  result: { question: GrillQuestion; updated: Requirement[] },
  shapeNotes: FieldShapeNote[] = [],
  options: { dimensionsGiven?: boolean | undefined } = {},
): string {
  const { question, updated } = result
  const lines: string[] = [fmt('uiDescribe.k204', { p1: question.id, p2: question.status })]
  lines.push(fmt('uiDescribe.k128', { p1: question.answer ?? t('uiDescribe.k172') }))
  lines.push(fmt('uiDescribe.k129', { p1: question.answeredBy ?? 'human' }))
  for (const requirement of updated) {
    lines.push(fmt('uiDescribe.k130', { p1: requirement.id, p2: describeScore(requirement) }))
  }
  if (question.status === 'assumed') {
    lines.push(t('uiDescribe.k131'))
  }
  // **M1（本报告）**：回执此前教人"回答并更新语义分"，而答案正文**根本不进评分文本**
  // （评分只由 statement + rationale + acceptance 组成）——不显式给 `dimensions` 时，
  // 回答再多也不会移动分数（实测：11 → 11）。这里如实说明，不再让人误以为"回答了就有分"。
  if (options.dimensionsGiven !== true) {
    lines.push(t('uiDescribe.answerNoDimensions'))
  }
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** `sdo_requirement action=list` 的回执。 */
export function describeRequirementList(requirements: Requirement[], shapeNotes: FieldShapeNote[] = []): string {
  if (requirements.length === 0) return [t('uiDescribe.k132'), ...shapeNoteBlock(shapeNotes)].join('\n')
  const lines: string[] = [fmt('uiDescribe.k205', { p1: requirements.length })]
  for (const requirement of requirements) {
    lines.push(
      fmt('uiDescribe.k249', { p1: requirement.id, p2: requirement.priority ?? t('uiDescribe.k248'), p3: requirement.kind, p4: requirement.status })
      + fmt('uiDescribe.k133', { p1: requirement.ambiguity.score, p2: requirement.ambiguity.open.length, p3: requirement.title }),
    )
  }
  const below = requirements.filter((requirement) => requirement.ambiguity.score < 14)
  if (below.length > 0) {
    lines.push(fmt('uiDescribe.k134', { p1: below.map((requirement) => requirement.id).join(' ') }))
  }
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** `sdo_requirement action=baseline` 的回执（含门禁负例的 remedy）。 */
export function describeBaseline(outcome: BaselineOutcome, next?: { applicabilityDeclared?: boolean | undefined } | undefined): string {
  if (outcome.ok) {
    // N-14：只对"本次真的被冻结"的需求逐个列出；一条都没有（内容未改、已冻结过）时如实说明，
    // 不能让回执印一个空列表却声称"已冻结"。
    const lines = [
      outcome.baselined.length > 0
        ? fmt('uiDescribe.k206', { p1: outcome.baselined.length })
        : t('uiDescribe.kBaselineNothingToFreeze'),
    ]
    for (const requirement of outcome.baselined) {
      lines.push(fmt('uiDescribe.k135', { p1: requirement.id, p2: requirement.version, p3: requirement.baseline?.by ?? 'human' }))
    }
    // **R-2**：只有**真的**写了 `phase/entered` 才能说"进入 architecture"；
    // 内容未变、都已冻结时（D-6 起不再重放阶段转移）必须如实说"阶段未变 + 当前是哪个阶段"。
    lines.push(outcome.phaseEntered === true ? t('uiDescribe.k136') : fmt('uiDescribe.k136b', { p1: outcome.phase ?? '' }))
    // **§7.1**：需求基线通过后，下一步是"在需求阶段定设计适用性"——
    // 这条提示必须出现在回执里，否则模型会径直推进到架构阶段、跳过声明（存量项目就在此列）。
    if (next?.applicabilityDeclared !== true) lines.push(t('uiDescribe.kApplicabilityNext'))
    lines.push(t('uiDescribe.k137'))
    return lines.join('\n')
  }
  // **N-9**：拦得住还要说得清 —— DoR 之外的判据（如 C8 红队议题闭环）判红时，
  // 旧回执只印 DoR 的 7 条，于是"7 条全 ✅ 却过不去"，用户找不到原因。
  const lines = [fmt('uiDescribe.k138', { p1: describeDor(outcome.dor) })]
  const failedCriteria = outcome.evaluation?.criteria.filter((item) => !item.ok && item.na !== true) ?? []
  const outsideDor = failedCriteria.filter((item) => outcome.dor.criteria.every((dor) => dor.id !== item.id))
  if (outsideDor.length > 0) {
    lines.push(fmt('uiDescribe.kBaselineGateBlocked', { p1: outcome.evaluation?.gate ?? 'G2' }))
    for (const item of outsideDor) {
      lines.push(`- ❌ ${item.id}　${item.detail}`)
      if (item.remedy !== undefined && item.remedy !== '') lines.push(fmt('uiDescribe.k140', { p1: item.remedy }))
    }
  }
  return lines.join('\n')
}

/** DoR 判定文本（失败时逐条给 remedy）。 */
export function describeDor(dor: DorResult): string {
  const lines: string[] = []
  for (const criterion of dor.criteria) {
    lines.push(`- ${criterion.ok ? '✅' : '❌'} ${criterion.id}　${criterion.label}`)
    lines.push(fmt('uiDescribe.k139', { p1: criterion.detail }))
    if (criterion.remedy !== undefined) lines.push(fmt('uiDescribe.k140', { p1: criterion.remedy }))
  }
  if (!dor.ok) lines.push(fmt('uiDescribe.k141', { p1: dor.failed.join(', ') }))
  return lines.join('\n')
}

/** 红队动作的回执。 */
export function describeRedTeam(action: string, payload: { questions?: GrillQuestion[]; skipped?: string[]; enabled?: boolean; executed?: boolean; reason?: string | undefined }): string {
  const lines: string[] = []
  if (action === 'attack') {
    lines.push(fmt('uiDescribe.k142', { p1: payload.questions?.length ?? 0 }))
    lines.push('')
    lines.push(describeQuestions(payload.questions ?? [], payload.skipped ?? []))
    return lines.join('\n')
  }
  if (action === 'off' || action === 'on') {
    lines.push(fmt('uiDescribe.k143', { p1: action === 'off' ? t('uiDescribe.k232') : t('uiDescribe.k173'), p2: payload.reason === undefined ? '' : fmt('uiDescribe.k174', { p1: payload.reason }) }))
    lines.push(t('uiDescribe.k144'))
    return lines.join('\n')
  }
  lines.push(fmt('uiDescribe.k145', { p1: payload.enabled === false ? t('uiDescribe.k233') : t('uiDescribe.k175'), p2: payload.executed === true ? t('uiDescribe.k234') : t('uiDescribe.k176') }))
  lines.push(t('uiDescribe.k146'))
  return lines.join('\n')
}

/** `sdo_render` 的回执。 */
export function describeRender(target: string, path: string, seq: number): string {
  return [
    fmt('uiDescribe.m3', { p1: target, p2: path }),
    fmt('uiDescribe.k147', { p1: seq }),
    t('uiDescribe.k148'),
  ].join('\n')
}

/** `sdo_design` 的门禁回执。 */
export function describeDesignGate(check: { allowed: boolean; reason: string; remedy?: string | undefined; dor: DorResult }, action: string): string {
  if (!check.allowed) {
    return [
      fmt('uiDescribe.m4', { p1: action === 'view' ? t('uiDescribe.m5') : t('uiDescribe.m6'), p2: check.reason }),
      check.remedy === undefined ? '' : fmt('uiDescribe.k149', { p1: check.remedy }),
      '',
      t('uiDescribe.k150'),
      describeDor(check.dor),
    ].join('\n')
  }
  return [
    fmt('uiDescribe.m7', { p1: check.reason }),
    t('uiDescribe.k151'),
  ].join('\n')
}

// —————————————— §6.1 / §7.1 / §7.2：回退 / 适用性声明 / 门禁签字 ——————————————

/** `sdo_requirement action=design-questions` 的回执（需求阶段提出规划级设计问题）。 */
export function describeDesignQuestions(question: GrillQuestion, created: boolean): string {
  const lines = [
    created ? t('uiDescribe.mApplicabilityQuestionsCreated') : t('uiDescribe.mApplicabilityQuestionsExisting'),
    fmt('uiDescribe.kApplicabilityQuestion', { p1: question.id, p2: question.text }),
    fmt('uiDescribe.kApplicabilityRecommend', { p1: question.defaultRecommendation }),
  ]
  // F-6：建议理由**必须**说清是模型给的还是插件兜底的。
  // 旧实现把 `defaultRecommendation` 当作"建议理由"再打印一遍（标签复述），
  // 模型没给理由时也看不出来 —— 兜底建议甚至可能与项目相反，照它填会写反设计。
  const rationale = textOf(question.recommendationRationale).trim()
  if (rationale === '') {
    lines.push(t('uiDescribe.kApplicabilityRecommendWhyMissing'))
  } else if (question.recommendationFromModel === true) {
    lines.push(fmt('uiDescribe.kApplicabilityRecommendWhy', { p1: rationale }))
  } else {
    lines.push(fmt('uiDescribe.kApplicabilityRecommendWhyFallback', { p1: rationale }))
  }
  for (const option of question.options) {
    lines.push(fmt('uiDescribe.kApplicabilityOption', { p1: option.label, p2: option.cost }))
  }
  lines.push(t('uiDescribe.kApplicabilityAskHint'))
  return lines.join('\n')
}

/** `sdo_requirement action=applicability|applicability-confirm` 的回执。 */
export function describeApplicability(declaration: DesignApplicability, problems: string[], shapeNotes: FieldShapeNote[] = []): string {
  const lines = [t('uiDescribe.mApplicabilityHeader'), ...applicabilityLines(declaration)]
  if (problems.length > 0) {
    lines.push(fmt('uiDescribe.kApplicabilityProblems', { p1: problems.join('；') }))
  }
  lines.push(t('uiDescribe.kApplicabilityVisible'))
  lines.push(...shapeNoteBlock(shapeNotes))
  return lines.join('\n')
}

/** `sdo_gate action=sign` 的回执（带引用文本与来源通道）。 */
/** 签字依据出处那一行的"本门最近一次失效"部分（R-27）。 */
function basisInvalidationNote(state: SignatureState): string {
  return state.status === 'stale' ? t('uiDescribe.kSignBasisStale') : t('uiDescribe.kSignBasisFresh')
}

export function describeSignature(signature: GateSignature, state: SignatureState): string {
  const lines = [
    fmt('uiDescribe.kSignRecorded', {
      p1: gateLabel(signature.gate),
      p2: signature.by,
      p3: channelLabel(signature.channel),
    }),
    fmt('uiDescribe.kSignBasis', { p1: signature.basis }),
  ]
  // **R-27**：依据的出处（首次用于哪条签字；本门最近一次失效是哪条）—— 审计者一眼可辨是否重放
  lines.push(fmt('uiDescribe.kSignBasisRef', {
    p1: String(signature.atSeq),
    p2: String(signature.basisFirstSeq ?? signature.atSeq),
    p3: basisInvalidationNote(state),
  }))
  if (signature.turn !== undefined && textOf(signature.turn).trim() !== '') {
    lines.push(fmt('uiDescribe.kSignTurn', { p1: signature.turn }))
  }
  lines.push(
    state.status === 'valid'
      ? t('uiDescribe.kSignValid')
      // **§3.1**：`unknown`（journal 截断，无法确认是否失效）必须与「签字无效」分开说 ——
      // 否则回执会把「查不动」读成「签字废了」，用户会去重签一个其实可能有效的签字。
      : state.status === 'unknown'
        ? fmt('uiDescribe.kSignUnknown', { p1: state.reason })
        : fmt('uiDescribe.kSignNotValid', { p1: state.reason }),
  )
  // R-7：拿不到会话历史时**必须当场告警** —— 只在"有效"那一行里带过，用户不会注意到，
  // 于是防线静默降级成"引用非空"这件事就没人知道。
  if (signature.basisChecked === 'unavailable') lines.push(t('uiDescribe.kSignBasisUnchecked'))
  // D1：签字回执必须写出**该门禁自己的**失效事件集合（与判定同源）——
  // "签完之后什么会让它失效"是流程承诺的一部分，不能只在源码注释里。
  lines.push(signatureInvalidatingEventLine(signature.gate))
  // §2.5/§3.4（评审员）：签字范围必须在**用户可见处**写明 —— 否则用户以为签了字就覆盖了
  // 质量属性场景（它们是补充证据，`quality/recorded` 属中性事件，改它们不会让签字失效）。
  lines.push(t('uiDescribe.kSignScope'))
  // **SDO-05 / SDO-13（2026-10-05 真机）**：失效集合只是"事后列举"，用户看不出**顺序**要求 ——
  // 真机上「签 G2 后再登记一条风险」「签 G3 后再补 20 条契约（G4 强制）都各自当场作废签字。
  // 所以按门禁把"签之前该做完什么"直接写在回执里（承诺必须可读，而不是靠读失效集合倒推）。
  if (signature.gate === 'G2') lines.push(t('uiDescribe.kSignBeforeG2'))
  else if (signature.gate === 'G3') lines.push(t('uiDescribe.kSignBeforeG3'))
  return lines.join('\n')
}

/** G3 未签字时的明确提示（规格 §7.2：回执要写「等待用户签字确认」）。 */
export function describeSignatureWaiting(state: SignatureState): string {
  return [
    t('uiDescribe.kSignWaiting'),
    fmt('uiDescribe.kSignWaitingWhy', { p1: state.reason }),
    t('uiDescribe.kSignWaitingHow'),
  ].join('\n')
}

/** `sdo_gate action=rollback` 的回执。 */
export function describeRollback(result: {
  from: string
  to: string
  invalidatedGates: string[]
  /** 被作废、但**仍处于豁免状态**的门禁（回退不撤销用户的豁免决定，它们不会重新判红）。 */
  stillWaivedGates?: string[] | undefined
}): string {
  const gates = result.invalidatedGates.length === 0
    ? t('uiDescribe.kRollbackNoGates')
    : fmt('uiDescribe.kRollbackGates', { p1: result.invalidatedGates.join(' ') })
  const lines = [
    fmt('uiDescribe.kRollbackDone', { p1: phaseText(result.from), p2: phaseText(result.to) }),
    gates,
  ]
  // §3.5-3：豁免是用户的决定，回退不撤销它 —— 但"这些门禁不会重新判红"必须说出来，
  // 否则用户会把"必须重新通过"理解成"包括豁免的那些"。
  const waived = result.stillWaivedGates ?? []
  if (waived.length > 0) {
    lines.push(fmt('uiDescribe.kRollbackStillWaived', { p1: waived.join(' ') }))
  }
  lines.push(t('uiDescribe.kRollbackReenter'))
  return lines.join('\n')
}

/** 回退边清单（拒绝非法回退时给出可用目标）。 */
export function describeRollbackTargets(targets: string[]): string {
  return targets.length === 0
    ? t('uiDescribe.kRollbackNoEdge')
    : fmt('uiDescribe.kRollbackTargets', { p1: targets.map((target) => phaseText(target)).join(' ') })
}

/**
 * **豁免清单的读出口**（DEF-030）：没有豁免就**不占一行**；有就整块列出（含"未署名/未记影响面"的历史条目）。
 * 为什么在这里：豁免是"跳过一条判据"的动作，状态面必须能**一次列全**供用户追认或撤销。
 */
export function describeExemptions(lines: string[]): string {
  if (lines.length === 0) return ''
  const header = fmt('uiDescribe.kExemptions', { p1: String(lines.length) })
  return `\n${header}\n` + lines.map((line) => `  ${line}`).join('\n')
}
