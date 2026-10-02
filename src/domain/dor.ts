/**
 * DoR（需求就绪定义）——门禁 G2 的判定（设计 §5.2.5 + §15.3 的 `G2 需求基线`）。
 *
 * 判定是**纯函数**：给定项目、需求集、问题账本与红队状态，输出每条准则的通过与 remedy。
 * 这样门禁既可单测，也可被工具层与（M3 的）流程状态机复用。
 */
import { DIMENSIONS } from '../types.js'
import type { GrillQuestion, Requirement, RiskItem, SdoProject } from '../types.js'
import { textOf } from '../infra/scalar.js'
import { fmt, t } from './i18n.js'

/**
 * 判定一个问题是否**实质上未决**：
 *   · `open` —— 未决；
 *   · `assumed` —— 只有**用户授权过**的假设才算已决；agent 自己填的假设仍算未决（防自问自答）。
 * 真源里的 `status` 照旧保留，判定用这个函数，二者不混。
 */
export function isEffectivelyOpen(question: GrillQuestion): boolean {
  if (question.status === 'open') return true
  if (question.status === 'assumed' && question.authorizedByUser !== true) return true
  return false
}
import { loadScoring, meetsThreshold } from './scoring.js'

/** 一条门禁准则的判定结果。 */
export interface DorCriterion {
  id: string
  label: string
  ok: boolean
  detail: string
  remedy?: string | undefined
}

export interface DorResult {
  ok: boolean
  criteria: DorCriterion[]
  /** 未通过的准则 id（便于工具层给出可执行 remedy） */
  failed: string[]
}

export interface DorInput {
  project: SdoProject | undefined
  requirements: Requirement[]
  questions: GrillQuestion[]
  /** 本会话红队是否已执行过（`redteam/attack` 事件） */
  redTeamExecuted: boolean
  /** 本会话红队是否被显式停用（`redteam/mode` 留痕） */
  redTeamDisabled: boolean
  /**
   * **G2 门禁级签字状态**（来自 `gates/signatures.yml` + journal，D1）。
   *
   * 这是 C7 **唯一**的放行依据：`approvedBy` 之类的入参字符串**不再**能让 C7 变绿。
   * 传 `undefined` 等价于"台账里没有签字"（`missing`）——**fail-closed**，不是"跳过判定"。
   */
  signoff?: { status: 'missing' | 'unquoted' | 'stale' | 'valid' | 'unknown'; reason: string; signer?: string | undefined } | undefined
  /**
   * 人类签字（设计 §15.3 G2 末条）—— **D1 之后只是附加信息**：
   * 它会被如实写进 C7 的 detail（不静默忽略），但**不参与**通过与失败的判定。
   */
  approvedBy?: string | undefined
  /** P1 未决问题的上限（设计 §5.2.5） */
  maxOpenP1?: number | undefined
  /**
   * 风险登记（D4）：未决 P1 问题必须能在这里找到**对应的风险处置**。
   *
   * 关联口径（机械可判）：某条 P1 问题 `Q` 已转风险 ⟺ 存在风险项，其 `origin`
   * **等于** `Q.id`，或**以 `Q.id` 为空白分隔的 token**（如 `origin: "Q-0035 redteam"`
   * 或 `origin: "ISSUE-1 Q-0035"`）。用 token 而不是子串：`Q-003` 不得匹配 `Q-0035`。
   */
  risks?: RiskItem[] | undefined
}

/** 每条需求的门禁画像，便于给出精确 remedy。 */
interface PerRequirement {
  id: string
  ok: boolean
  problems: string[]
}

/**
 * 一条问题**是否已转入风险登记**（D4 的机械关联口径）。
 *
 * `RiskItem.origin` 是自由文本，但流程写出来的形态是"问题 id / 议题 id"：
 * 这里按**空白分隔的 token 全等**匹配（`origin: "Q-0035"`、`origin: "Q-0035 redteam"` 都算，
 * `origin: "Q-003"` **不**匹配 `Q-0035`）—— 子串匹配会让 `Q-003` 假绿，全等又漏掉多来源写法。
 */
export function hasRiskDisposition(questionId: string, risks: RiskItem[]): boolean {
  const wanted = questionId.trim()
  if (wanted === '') return false
  return risks.some((risk) =>
    textOf(risk.origin)
      .split(/\s+/u)
      .map((token) => token.trim())
      .filter((token) => token !== '')
      .includes(wanted),
  )
}

/** C2 的人可读 detail（逐条点名：P0 未决 / P1 未决 / **未转风险的 P1**）。 */
function c2Detail(openP0: GrillQuestion[], openP1: GrillQuestion[], p1WithoutRisk: GrillQuestion[], maxOpenP1: number): string {
  if (openP0.length === 0 && openP1.length === 0) return t('uiDor.c2NoOpen')
  const parts: string[] = []
  if (openP0.length > 0) {
    parts.push(fmt('uiDor.c2P0', { p1: openP0.length, p2: openP0.map((question) => question.id).join(' ') }))
  }
  if (openP1.length > 0) {
    parts.push(fmt('uiDor.c2P1', { p1: openP1.length, p2: openP1.map((question) => question.id).join(' ') }))
  }
  if (openP1.length > maxOpenP1) parts.push(fmt('uiDor.c2OverLimit', { p1: maxOpenP1 }))
  if (p1WithoutRisk.length > 0) {
    parts.push(fmt('uiDor.c2P1NoRisk', { p1: p1WithoutRisk.map((question) => question.id).join(' ') }))
  }
  return parts.join(t('uiDor.detailSep'))
}

function inspect(requirement: Requirement): PerRequirement {
  const model = loadScoring()
  const problems: string[] = []
  const threshold = meetsThreshold(requirement.ambiguity, model)
  if (!threshold.ok) {
    problems.push(`评分 ${requirement.ambiguity.score}/16 未达 ${model.threshold}${threshold.zeroDimensions.length > 0 ? `，且维度为 0：${threshold.zeroDimensions.join('/')}` : ''}`)
  }
  if (requirement.priority === undefined) problems.push('未定优先级（must/should/could/wont）')
  if (requirement.source.stakeholder === undefined && (requirement.source.raw ?? '') === '') {
    problems.push('无来源（干系人或原始诉求）')
  }
  if (requirement.acceptance.length === 0) {
    problems.push('无验收标准')
  } else if (!requirement.acceptance.every((ac) => ac.given !== '' && ac.when !== '' && ac.then !== '')) {
    problems.push('验收标准不是完整的 Given/When/Then')
  }
  return { id: requirement.id, ok: problems.length === 0, problems }
}

/** 评估 G2（需求基线门禁）。 */
export function evaluateDor(input: DorInput): DorResult {
  const model = loadScoring()
  const criteria: DorCriterion[] = []
  const maxOpenP1 = input.maxOpenP1 ?? 2

  // C1：每条需求达到阈值、无 0 分维度、有优先级/来源/AC
  const perRequirement = input.requirements.map(inspect)
  const bad = perRequirement.filter((item) => !item.ok)
  criteria.push({
    id: 'C1-dor-per-requirement',
    label: `每条需求满足 DoR（评分 ≥ ${model.threshold}/16、无 0 分维度、有优先级/来源/Given-When-Then 验收标准）`,
    ok: input.requirements.length > 0 && bad.length === 0,
    detail:
      input.requirements.length === 0
        ? '还没有任何需求'
        : bad.length === 0
          ? `全部 ${input.requirements.length} 条通过`
          : bad.map((item) => `${item.id}：${item.problems.join('；')}`).join(' | '),
    remedy:
      bad.length === 0
        ? undefined
        : t('uiDor.c1Remedy'),
  })

  // C2：无 P0 未决；P1 未决 ≤ 上限；**且每条未决 P1 都有对应的风险处置**（D4）
  //
  // **M6**：口径必须用 `isEffectivelyOpen` —— 旧实现只认 `status === 'open'`，
  // 于是**手改 YAML 把问题标成 `assumed`（不带 `authorizedByUser`）即可绕过 G2**：
  // 需求侧"不许自问自答"的纪律存在一个手改逃生口，而设计侧早已用"未授权假设仍算未决"的口径，
  // 两个门禁对同一份数据用两套口径。现在两侧共用同一份实现。
  //
  // **D4（本报告 M5）**：判据 desc 承诺的"且转风险"这一半此前**完全没实现** ——
  // 回执可以显示"P1 未决 2 条"，而这两条一条都没进风险登记，G2 照样绿。
  // 现在逐条机械判定，并把**具体缺哪条问题**点名出来（remidy 与文案同源）。
  const open = input.questions.filter((question) => isEffectivelyOpen(question))
  const openP0 = open.filter((question) => question.severity === 'P0')
  const openP1 = open.filter((question) => question.severity === 'P1')
  const risks = input.risks ?? []
  const p1WithoutRisk = openP1.filter((question) => !hasRiskDisposition(question.id, risks))
  const c2Ok = openP0.length === 0 && openP1.length <= maxOpenP1 && p1WithoutRisk.length === 0
  criteria.push({
    id: 'C2-open-questions',
    label: fmt('uiDor.c2Label', { p1: maxOpenP1 }),
    ok: c2Ok,
    detail: c2Detail(openP0, openP1, p1WithoutRisk, maxOpenP1),
    remedy: c2Ok ? undefined : t('uiDor.c2Remedy'),
  })

  // C3：每条 must 需求至少一条 Given/When/Then 验收标准（§15.3 G2）
  const mustWithoutAc = input.requirements.filter(
    (requirement) =>
      requirement.priority === 'must' &&
      !requirement.acceptance.some((ac) => ac.given !== '' && ac.when !== '' && ac.then !== ''),
  )
  criteria.push({
    id: 'C3-must-has-ac',
    label: '每条 must 需求有 ≥1 条 Given/When/Then 验收标准',
    ok: mustWithoutAc.length === 0,
    detail: mustWithoutAc.length === 0 ? '全部 must 需求均有 AC' : `${mustWithoutAc.map((r) => r.id).join(' ')} 缺少 AC`,
    remedy: mustWithoutAc.length === 0 ? undefined : '为这些 must 需求补 AC（`sdo_requirement action=update` 带 acceptance）',
  })

  // C4：术语表（覆盖度检查依赖 M2 追溯引擎；这里先要求存在且非空，并写明局限）
  const glossaryTerms = Object.keys(input.project?.glossary ?? {})
  criteria.push({
    id: 'C4-glossary',
    label: '术语表存在且非空（完整覆盖度检查待 M2 追溯引擎）',
    ok: glossaryTerms.length > 0,
    detail: glossaryTerms.length === 0 ? '术语表为空' : `收录 ${glossaryTerms.length} 个术语`,
    remedy:
      glossaryTerms.length === 0
        ? '用 `sdo_project action=update glossary={"术语":"定义"}` 补领域术语（G2 硬条件）'
        : undefined,
  })

  // C5：非目标已声明（G0/G2 共用硬条件）
  const nonGoals = input.project?.scope.out ?? []
  criteria.push({
    id: 'C5-non-goals',
    label: '非目标已显式声明（≥1 条）',
    ok: nonGoals.length > 0,
    detail: nonGoals.length === 0 ? '未声明非目标' : `已声明 ${nonGoals.length} 条`,
    remedy: nonGoals.length === 0 ? '用 `sdo_project action=update scopeOut=…` 补非目标（G0/G2 硬条件）' : undefined,
  })

  // C6：红队质询已执行或已显式停用（normal/critical 档默认要求；设计 §15.3 G2 / Q-03）
  const scale = input.project?.tailoring?.scale ?? 'normal'
  const redTeamRequired = scale !== 'trivial'
  const redTeamOk = !redTeamRequired || input.redTeamExecuted || input.redTeamDisabled
  criteria.push({
    id: 'C6-red-team',
    label: '红队质询已执行（或本会话已显式停用并留痕）',
    ok: redTeamOk,
    detail: !redTeamRequired
      ? '规模档为 trivial，默认不要求红队'
      : input.redTeamExecuted
        ? '已执行'
        : input.redTeamDisabled
          ? '本会话已停用（留痕）'
          : '未执行',
    remedy: redTeamOk ? undefined : '调用 `sdo_redteam action=attack` 跑一轮红队，或明确要求停用（会写 `redteam/mode` 留痕）',
  })

  // C7：人类签字 —— **以签字台账为准**（D1）
  //
  // 旧实现只看 `approvedBy` 这个**入参字符串**：模型写一句 `approvedBy="human"` 就把
  // 整个流程最关键的冻结点自授了，审计上无法区分真签与人造。现在放行依据**只有**
  // `signatureState(store, journal, 'G2')`（签字必须带用户原话/所选选项原文，
  // 且签字后需求/项目/问题/风险/红队真源再变即按 journal 序号失效）。
  // `approvedBy` 不再参与判定，但**不静默丢弃** —— 它照旧写进 detail 与门禁记录。
  const signoff = input.signoff
  const signoffOk = signoff?.status === 'valid'
  const signer = (input.approvedBy ?? '').trim()
  const approvedNote = signer === '' ? t('uiDor.c7NoApprovedBy') : fmt('uiDor.c7ApprovedByExtra', { p1: signer })
  // `signoff` 缺省等价于"台账里没有签字"（fail-closed）——**不是**跳过判定。
  const signoffReason = signoff?.reason ?? fmt('uiSignature.missing', { p1: 'G2' })
  criteria.push({
    id: 'C7-signoff',
    label: t('uiDor.c7Label'),
    ok: signoffOk,
    detail: signoffOk
      ? fmt('uiDor.c7Ok', { p1: signoff?.signer ?? '', p2: signoffReason, p3: approvedNote })
      : fmt('uiDor.c7Fail', { p1: signoffReason, p2: approvedNote }),
    remedy: signoffOk ? undefined : t('uiDor.c7Remedy'),
  })

  const failed = criteria.filter((criterion) => !criterion.ok).map((criterion) => criterion.id)
  return { ok: failed.length === 0, criteria, failed }
}

/** 供状态块/看板使用：DoR 的一行摘要。 */
export function dorSummary(result: DorResult): string {
  if (result.ok) return 'DoR 通过'
  return `DoR 未通过（${result.failed.length} 条未满足：${result.failed.join(', ')}）`
}

/** 尚未达到阈值的需求（用于提示）。 */
export function belowThreshold(requirements: Requirement[]): Requirement[] {
  const model = loadScoring()
  return requirements.filter((requirement) => !meetsThreshold(requirement.ambiguity, model).ok)
}

/** 所有维度都有分的需求（便于自检）。 */
export function fullyScored(requirement: Requirement): boolean {
  return DIMENSIONS.every((dimension) => (requirement.ambiguity.dimensions[dimension] ?? 0) > 0)
}
