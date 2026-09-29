/**
 * 审讯引擎：问题库 → 提问批次（≤4 问）→ 问题账本 → 回答 → 重算评分。
 *
 * 设计对应：§5.2.3（提问四纪律）、§5.2.2（禁词强制量化）、§5.2.4（问题对象）、§5.4（红队，M1 只做"生成质询问题"）。
 *
 * 排序公式（设计 §5.2.3 第 1 条）：**架构影响 × 不确定性 × 阻塞程度**
 *   impact      = 问题库里的 1..3
 *   uncertainty = 该维度当前得分越低越不确定（0→3、1→2、2→1）
 *   blocking    = severityWeight（P0=3 / P1=2 / P2=1）
 */
import { loadPackagedYaml } from '../infra/data.js'
import { nextId } from '../infra/ids.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { Dimension, GrillOption, GrillQuestion, Requirement, SdoProject, Severity } from '../types.js'
import { listRequirementIds, readRequirement, setOpenQuestions, updateRequirement } from './requirements.js'
import { loadScoring, weakestDimensions } from './scoring.js'
import type { ScoringModel } from './scoring.js'

/** 问题库里的一条模板。 */
export interface BankQuestion {
  id: string
  dimension: Dimension
  severity: Severity
  impact: number
  text: string
  why: string
  consequenceIfUnasked: string
  options: GrillOption[]
  defaultRecommendation: string
}

interface BankFile {
  questions: BankQuestion[]
}

/** 读取随包问题库。 */
export function loadBank(): BankQuestion[] {
  return loadPackagedYaml<BankFile>('src/data/questions/grill-bank.yml').questions
}

/** 问题账本：列出全部问题（按 ID 字典序）。 */
export function listQuestionIds(store: SdoStore): string[] {
  return store
    .listNames('questions')
    .filter((name) => /^Q-\d+\.yml$/u.test(name))
    .map((name) => name.replace(/\.yml$/u, ''))
}

export function readQuestion(store: SdoStore, id: string): GrillQuestion | undefined {
  return store.readYaml<{ question: GrillQuestion }>('questions', `${id}.yml`)?.question
}

export function listQuestions(store: SdoStore): GrillQuestion[] {
  const out: GrillQuestion[] = []
  for (const id of listQuestionIds(store)) {
    const question = readQuestion(store, id)
    if (question !== undefined) out.push(question)
  }
  return out
}

export function writeQuestion(store: SdoStore, question: GrillQuestion): void {
  store.writeYaml(['questions', `${question.id}.yml`], { question })
}

/** 某条需求上的未决问题。 */
export function openQuestionsFor(store: SdoStore, requirementId: string): GrillQuestion[] {
  return listQuestions(store).filter(
    (question) => question.status === 'open' && question.targets.includes(requirementId),
  )
}

/** 该模板是否已经就这条需求问过（避免重复追问同一问法）。 */
function alreadyAsked(questions: GrillQuestion[], templateId: string, requirementId: string): boolean {
  return questions.some(
    (question) =>
      question.why.includes(`#${templateId}`) &&
      question.targets.includes(requirementId) &&
      question.status !== 'obsolete',
  )
}

/** 选出一批要问的问题（设计 §5.2.3：批量上限 4、P0 优先、禁止无选项追问）。 */
export interface SelectInput {
  requirements: Requirement[]
  existing: GrillQuestion[]
  model: ScoringModel
  /** quick 档：只问 P0（设计 §7.5 的 trivial 裁剪） */
  quick?: boolean | undefined
  limit?: number | undefined
}

export interface SelectedQuestion {
  template: BankQuestion
  target: string
  score: number
}

export function selectQuestions(input: SelectInput): SelectedQuestion[] {
  const bank = loadBank()
  const limit = input.limit ?? 4
  const candidates: SelectedQuestion[] = []

  for (const requirement of input.requirements) {
    const weak = new Set(weakestDimensions(requirement.ambiguity, 4))
    for (const template of bank) {
      if (!weak.has(template.dimension)) continue
      if (input.quick === true && template.severity !== 'P0') continue
      if (alreadyAsked(input.existing, template.id, requirement.id)) continue
      const dimensionScore = requirement.ambiguity.dimensions[template.dimension] ?? 0
      const uncertainty = dimensionScore === 0 ? 3 : dimensionScore === 1 ? 2 : 1
      const blocking = input.model.severityWeight[template.severity] ?? 1
      candidates.push({ template, target: requirement.id, score: template.impact * uncertainty * blocking })
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.target.localeCompare(b.target) || a.template.id.localeCompare(b.template.id))
  return candidates.slice(0, limit)
}

/** 禁词 → 强制量化问题（设计 §5.2.2）。 */
export function bannedWordQuestions(requirement: Requirement, model: ScoringModel): BankQuestion[] {
  const text = `${requirement.statement}\n${requirement.rationale}`
  const hits = new Set<string>()
  for (const [dimension, words] of Object.entries(model.bannedWords) as [Dimension, string[]][]) {
    for (const word of words) if (text.includes(word)) hits.add(`${dimension}\u0000${word}`)
  }
  return [...hits].map((key) => {
    const [dimension, word] = key.split('\u0000') as [Dimension, string]
    return {
      id: `banned-${word}`,
      dimension,
      severity: 'P0' as Severity,
      impact: 2,
      text: `「${word}」必须量化为「指标 + 条件 + 阈值」：在什么数据量/什么条件下，达到多少？`,
      why: `命中禁词「${word}」，DoR 要求强制量化（设计 §5.2.2）`,
      consequenceIfUnasked: '该需求无法验收，且会在 G2 被拒',
      options: [
        { label: '给出量化指标（数值 + 条件）', cost: '需要基线数据与度量口径' },
        { label: '降级为非目标（本次不做）', cost: '需要与干系人确认范围' },
        { label: '记为假设，按默认阈值推进', cost: '假设进风险登记；后续可能返工' },
      ],
      defaultRecommendation: '给出量化指标（数值 + 条件）',
    } satisfies BankQuestion
  })
}

/** 红队质询（设计 §5.4 的七个攻击角度；M1 只把攻击转成 P0 问题）。 */
const RED_TEAM_ANGLES: { id: string; dimension: Dimension; text: string; why: string; consequence: string }[] = [
  {
    id: 'redteam-stakeholder',
    dimension: 'user',
    text: '谁会被这个功能伤害？谁的操作会因此变多？',
    why: '红队：遗漏干系人（设计 §5.4）',
    consequence: '上线后出现抵触或隐性人工成本',
  },
  {
    id: 'redteam-assumption',
    dimension: 'boundary',
    text: '哪些话没说但被当作前提？若不成立会怎样？',
    why: '红队：隐含假设（设计 §5.4）',
    consequence: '假设破裂时系统行为未定义',
  },
  {
    id: 'redteam-cost',
    dimension: 'goal',
    text: '哪条需求最贵？可以用 1/5 成本满足 80% 价值吗？',
    why: '红队：成本攻击（设计 §5.4）',
    consequence: '成本失控或价值错配',
  },
  {
    id: 'redteam-testability',
    dimension: 'acceptance',
    text: '这条验收标准能被伪造通过吗？给出一个"假通过"的例子。',
    why: '红队：可测性攻击（设计 §5.4）',
    consequence: '验收形同虚设',
  },
  {
    id: 'redteam-conflict',
    dimension: 'scenario',
    text: '哪两条需求在极端情况下互斥？',
    why: '红队：内部冲突（设计 §5.4）',
    consequence: '实现时被迫二选一，返工',
  },
  {
    id: 'redteam-harmful',
    dimension: 'scenario',
    text: '什么输入会让系统做出「正确但有害」的行为？',
    why: '红队：反面场景（设计 §5.4）',
    consequence: '产生合规或业务事故',
  },
  {
    id: 'redteam-triple-none',
    dimension: 'boundary',
    text: '这条需求有没有非目标、降级策略与回滚手段？缺哪个？',
    why: '红队：三无检查（设计 §5.4）',
    consequence: '故障时无路可退',
  },
]

/** 生成红队问题（附带 `origin='red-team'`）。 */
export function redTeamQuestions(): BankQuestion[] {
  return RED_TEAM_ANGLES.map((angle) => ({
    id: angle.id,
    dimension: angle.dimension,
    severity: 'P0' as Severity,
    impact: 3,
    text: angle.text,
    why: `#${angle.id} ${angle.why}`,
    consequenceIfUnasked: angle.consequence,
    options: [
      { label: '给出明确回答并写入需求', cost: '需要额外讨论时间' },
      { label: '转成风险登记（本次接受）', cost: '风险留到实现期暴露' },
      { label: '确认为非目标', cost: '需要与干系人确认' },
    ],
    defaultRecommendation: '给出明确回答并写入需求',
  }))
}

export interface AskInput {
  requirementIds: string[]
  limit?: number | undefined
  quick?: boolean | undefined
  /** 是否附带禁词强制量化问题（capture 之后默认带） */
  includeBanned?: boolean | undefined
  /** 是否附带红队质询（`sdo_redteam action=attack` 调用） */
  includeRedTeam?: boolean | undefined
  /**
   * 只出红队质询（不掺问题库的普通问题）。
   * `sdo_redteam action=attack` 必须用这个：红队那一轮的语义是"对抗式质询"，
   * 掺进库题会让"红队已执行"这件事的含义变模糊。
   */
  onlyRedTeam?: boolean | undefined
}

/** 把一批模板落成问题账本条目（`question/asked` 留痕）。 */
export function askQuestions(
  store: SdoStore,
  journal: Journal,
  project: SdoProject | undefined,
  input: AskInput,
): { questions: GrillQuestion[]; skipped: string[] } {
  const model = loadScoring()
  const existing = listQuestions(store)
  const requirements = input.requirementIds
    .map((id) => readRequirement(store, id))
    .filter((requirement): requirement is Requirement => requirement !== undefined)
  const skipped: string[] = []
  for (const id of input.requirementIds) {
    if (readRequirement(store, id) === undefined) skipped.push(id)
  }

  const selected: SelectedQuestion[] =
    input.onlyRedTeam === true
      ? []
      : selectQuestions({
          requirements,
          existing,
          model,
          ...(input.quick === undefined ? {} : { quick: input.quick }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        })

  const templates: { template: BankQuestion; target: string }[] = selected.map((item) => ({
    template: item.template,
    target: item.target,
  }))

  // 禁词问题先于库题（它们是 P0 硬阻塞），但**总批量仍受 limit 约束**（设计 §5.2.3：批量上限 4 问）
  if (input.onlyRedTeam !== true) {
    const bannedTemplates: { template: BankQuestion; target: string }[] = []
    if (input.includeBanned === true) {
      for (const requirement of requirements) {
        for (const template of bannedWordQuestions(requirement, model)) {
          if (alreadyAsked(existing, template.id, requirement.id)) continue
          bannedTemplates.push({ template, target: requirement.id })
        }
      }
    }
    templates.unshift(...bannedTemplates)
    const budget = Math.max(1, Math.min(4, input.limit ?? 4))
    templates.splice(budget)
  }

  if (input.includeRedTeam === true) {
    const limit = Math.max(1, Math.min(redTeamQuestions().length, input.limit ?? redTeamQuestions().length))
    for (const requirement of requirements) {
      for (const template of redTeamQuestions().slice(0, limit)) {
        if (alreadyAsked(existing, template.id, requirement.id)) continue
        templates.push({ template, target: requirement.id })
      }
    }
  }

  const askedAt = new Date().toISOString()
  const usedIds = existing.map((question) => question.id)
  const created: GrillQuestion[] = []
  for (const { template, target } of templates) {
    const id = nextId('Q', usedIds, 4)
    usedIds.push(id)
    const question: GrillQuestion = {
      id,
      text: template.text,
      targets: [target],
      dimension: template.dimension,
      severity: template.severity,
      why: template.why.includes(`#${template.id}`) ? template.why : `#${template.id} ${template.why}`,
      consequenceIfUnasked: template.consequenceIfUnasked,
      options: template.options,
      defaultRecommendation: template.defaultRecommendation,
      answer: null,
      status: 'open',
      askedAt,
      answeredBy: null,
      origin: template.id.startsWith('banned-')
        ? 'banned-word'
        : template.id.startsWith('redteam-')
          ? 'red-team'
          : 'bank',
    }
    writeQuestion(store, question)
    created.push(question)
  }

  if (created.length > 0) {
    journal.append('question/asked', {
      ids: created.map((question) => question.id),
      targets: [...new Set(created.map((question) => question.targets[0] ?? ''))],
    })
  }

  // 把未决问题回写到需求的 ambiguity.open，并在状态块/看板上可见
  for (const requirement of requirements) {
    const open = listQuestions(store)
      .filter((question) => question.status === 'open' && question.targets.includes(requirement.id))
      .map((question) => question.id)
    setOpenQuestions(store, requirement.id, open, undefined, project)
  }

  return { questions: created, skipped }
}

export interface AnswerInput {
  id: string
  answer: string
  /** 用户选中的选项下标（0 基）；给出时把选项文本一起记入答案 */
  pickedOption?: number | undefined
  by?: string | undefined
  /** 用户答"不知道"：采用默认建议并记为假设（设计 §5.2.3 第 3 条） */
  assume?: boolean | undefined
  /** 该答案带来的语义分更新（模型通道） */
  modelDimensions?: Partial<Record<Dimension, number>> | undefined
}

/** 回答一个问题，并把它带来的语义分更新应用到目标需求。 */
export function answerQuestion(
  store: SdoStore,
  journal: Journal,
  project: SdoProject | undefined,
  input: AnswerInput,
): { question: GrillQuestion; updated: Requirement[] } | undefined {
  const question = readQuestion(store, input.id)
  if (question === undefined) return undefined

  const picked = input.pickedOption === undefined ? undefined : question.options[input.pickedOption]
  const text = input.assume === true ? question.defaultRecommendation : input.answer
  const answerText = picked === undefined ? text : `${text}（选择：${picked.label}）`

  const next: GrillQuestion = {
    ...question,
    answer: answerText,
    status: input.assume === true ? 'assumed' : 'answered',
    answeredBy: input.by ?? 'human',
  }
  writeQuestion(store, next)
  journal.append('question/answered', {
    id: next.id,
    status: next.status,
    by: next.answeredBy,
    targets: next.targets,
  })

  const updated: Requirement[] = []
  for (const target of next.targets) {
    const result = updateRequirement(store, journal, project, {
      id: target,
      ...(input.modelDimensions === undefined ? {} : { modelDimensions: input.modelDimensions }),
    })
    if (result !== undefined) updated.push(result.requirement)
  }

  // 回答后重算未决集合
  for (const target of next.targets) {
    const open = listQuestions(store)
      .filter((item) => item.status === 'open' && item.targets.includes(target))
      .map((item) => item.id)
    const refreshed = setOpenQuestions(store, target, open, input.modelDimensions, project)
    if (refreshed !== undefined) {
      const index = updated.findIndex((requirement) => requirement.id === target)
      if (index >= 0) updated[index] = refreshed
      else updated.push(refreshed)
    }
  }

  return { question: next, updated }
}

/** 便捷：把尚未处理的 `open` 问题按 P0 → P2 排序。 */
export function sortBySeverity(questions: GrillQuestion[]): GrillQuestion[] {
  const order: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 }
  return [...questions].sort((a, b) => order[a.severity] - order[b.severity] || a.id.localeCompare(b.id))
}

/** 便捷：全部需求 id（供工具默认作用域）。 */
export function allRequirementIds(store: SdoStore): string[] {
  return listRequirementIds(store)
}
