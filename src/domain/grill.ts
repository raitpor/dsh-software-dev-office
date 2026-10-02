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
import { fmt, t } from './i18n.js'
import { loadPackagedYaml } from '../infra/data.js'
import { pushShapeNote, recordListOf, textListOf, textOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import { nextId } from '../infra/ids.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { Dimension, GrillOption, GrillQuestion, Requirement, SdoProject, Severity } from '../types.js'
import { listRequirementIds, readRequirement, setOpenQuestions, updateRequirement } from './requirements.js'
import { isEffectivelyOpen } from './dor.js'
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

/**
 * 读一条问题并**做形状归一化**（F-21 ①）。
 *
 * `.sdo/questions/Q-*.yml` 是给人手改的真源：
 *   · `targets: REQ-001`（漏了列表写法）→ 旧实现 `question.targets.includes` 抛
 *     `includes is not a function`；现在按**单元素列表**读取（意图明确），并给出提示；
 *   · `options: {...}`（列表位置写成映射）→ **不猜**，按空列表读取 + 提示；
 *   · `targets` 写成映射同理。
 * 归一化只在读取边界做一次，消费点（`openQuestionsFor` / `alreadyAsked` / 回执）不再打补丁。
 */
export function readQuestionChecked(
  store: SdoStore,
  id: string,
): { question: GrillQuestion | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ question: unknown }>('questions', `${id}.yml`)?.question
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    // 文件在、主体不是映射：可读的失败（跳过它），但必须报出
    if (raw !== undefined) {
      pushShapeNote(notes, 'question', id, 'question', {
        position: 'map',
        actualType: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
        handling: 'empty',
        text: textOf(raw),
      })
    }
    return { question: undefined, notes }
  }
  const record = raw as Record<string, unknown>
  const targets = textListOf(record.targets)
  pushShapeNote(notes, 'question', id, 'targets', targets.issue)
  const options = recordListOf<GrillOption>(record.options, (text) => ({ label: text, cost: '' }))
  pushShapeNote(notes, 'question', id, 'options', options.issue)
  const declaredId = textOf(record.id)
  const question: GrillQuestion = {
    ...(record as unknown as GrillQuestion),
    // 文件名才是真源键：正文 id 缺失/写坏时按文件名落地
    id: declaredId.trim() === '' ? id : declaredId,
    text: textOf(record.text),
    targets: targets.value,
    why: textOf(record.why),
    consequenceIfUnasked: textOf(record.consequenceIfUnasked),
    options: options.value.map((option) => ({ label: textOf(option.label), cost: textOf(option.cost) })),
    defaultRecommendation: textOf(record.defaultRecommendation),
  }
  return { question, notes }
}

export function readQuestion(store: SdoStore, id: string): GrillQuestion | undefined {
  return readQuestionChecked(store, id).question
}

/** 全部问题上的形状提示（回执 / 只读视图 / 门禁详情共用）。 */
export function questionShapeNotes(store: SdoStore): FieldShapeNote[] {
  const notes: FieldShapeNote[] = []
  for (const id of listQuestionIds(store)) notes.push(...readQuestionChecked(store, id).notes)
  return notes
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
  // **P-6**：未决口径与门禁（G2 的 C2）同源 —— 未获用户授权的 `assumed` 仍算未决。
  return listQuestions(store).filter(
    (question) => isEffectivelyOpen(question) && question.targets.includes(requirementId),
  )
}

/** 该模板是否已经就这条需求问过（避免重复追问同一问法）。 */
function alreadyAsked(
  questions: GrillQuestion[],
  templateId: string,
  requirementId: string,
  templateText?: string,
): boolean {
  const norm = (text: string): string => text.replace(/\s+/gu, '').replace(/^针对[^：]*：/u, '')
  return questions.some((question) => {
    if (question.status === 'obsolete') return false
    if (!question.targets.includes(requirementId)) return false
    // ① 同一模板：按 why 里的 #templateId 判重
    if (textOf(question.why).includes(`#${templateId}`)) return true
    // ② **同一段文字**（实测反馈：两个模板文字相同 / 换个写法又问一遍，用户看到的就是"反复问同一题"）
    return templateText !== undefined && norm(textOf(question.text)) === norm(templateText)
  })
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
/**
 * 取一条需求**真正薄弱**的维度（歧义评分 0 分）。
 * 用途：让红队质询由需求的自身状况派生，而不是把同一句模板话复制到每条需求上
 * （实测反馈：6 条议题文字完全相同，看起来就是把模板复制了 6 份）。
 */
export function weakDimensions(requirement: Requirement | undefined): Dimension[] {
  if (requirement === undefined) return []
  const holder = requirement.ambiguity as unknown as {
    dimensions?: Record<string, number>
    scores?: Record<string, number>
  }
  const table = holder.dimensions ?? holder.scores ?? {}
  return Object.entries(table)
    .filter(([, score]) => score === 0)
    .map(([dimension]) => dimension as Dimension)
}

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
    // DEF（AsterChat 实测）：`limit` 曾被当成"每条需求问几个角度"，10 条需求 × 6 角度 = **60 问**，
    // 一次调用就把上下文与问题账本灌爆（真源：会话 session-ccda9900 出现 Q-0025…Q-0084）。
    // 正确语义：`limit` 是**本次调用的总问题数上限**，并按目标**轮转分配**，
    // 这样每条被攻击的需求都能拿到问题（议题才可能闭环），又不会失控。
    const bank = redTeamQuestions()
    // 角度排序：先问"正对这条需求薄弱维度"的角度——不同需求得到的问题因此不同，
    // 而不是每条需求都从同一个角度表头开始复制。
    const rankBank = (requirement: Requirement): typeof bank => {
      const weak = weakDimensions(requirement)
      return [...bank].sort((a, b) => Number(weak.includes(b.dimension)) - Number(weak.includes(a.dimension)))
    }
    const pools = requirements
      .map((requirement) => ({
        queue: rankBank(requirement)
          .filter((template) => !alreadyAsked(existing, template.id, requirement.id, template.text))
          .map((template) => ({ template, target: requirement.id })),
      }))
      .filter((pool) => pool.queue.length > 0)
    const total = Math.max(1, Math.min(12, input.limit ?? 4))
    let added = 0
    while (added < total) {
      let progressed = false
      for (const pool of pools) {
        const item = pool.queue.shift()
        if (item === undefined) continue
        // **让问题由需求自身派生**：带上需求标题 + 这条需求真正薄弱的维度；
        // 若该角度正对薄弱维度，措辞会进一步指向它。这样 6 条需求得到的是 6 个**不同**的问题，
        // 而不是同一句模板话复制 6 份（实测反馈的原话：看起来是同一个模板逐条复制）。
        const owner = requirements.find((requirement) => requirement.id === item.target)
        const weak = weakDimensions(owner)
        const weakLabel = weak.map((dimension) => t(`dimension.${dimension}`, dimension)).join('、')
        const focused = weak.includes(item.template.dimension)
        const head = `针对「${owner?.title ?? item.target}」`
          + (weakLabel === '' ? '' : `（该需求在「${weakLabel}」上尚未澄清）`)
          + (focused ? `【本问聚焦：${t(`dimension.${item.template.dimension}`, item.template.dimension)}】` : '')
        templates.push({ template: { ...item.template, text: `${head}：${item.template.text}` }, target: item.target })
        added += 1
        progressed = true
        if (added >= total) break
      }
      if (!progressed) break
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
      .filter((question) => isEffectivelyOpen(question) && question.targets.includes(requirement.id))
      .map((question) => question.id)
    setOpenQuestions(store, requirement.id, open, undefined, project)
  }

  return { questions: created, skipped }
}

export interface AnswerInput {
  /** 是否为"用户授权按建议记为假设"（必须真的问过用户） */
  authorizedByUser?: boolean | undefined
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
  // **不许自问自答**：把某题记为"假设"必须由用户授权（真的问过、用户说"你定"）。
  // 未授权就 assume ⇒ 拒绝，并明确要求先去问用户。实测教训：模型曾把自己的推测当答案落账，
  // 于是"审讯"变成 agent 的自问自答。
  if (input.assume === true && input.authorizedByUser !== true) {
    throw new Error(
      '不允许自问自答：要把问题记为"假设"，必须先由**用户**授权（用户明确说过"按你的建议"之类）。'
      + '请用提问工具把该问题问给用户；得到授权后再带 `authorizedByUser: true` 调用。',
    )
  }
  const question = readQuestion(store, input.id)
  if (question === undefined) return undefined

  // **m3（本报告）**：`pickedOption` 越界此前**静默**退化为普通答案 ——
  // 调用方以为记下了"用户选了第 N 项"，台账里却是一句自由文本。越界即报错（可读的失败）。
  if (input.pickedOption !== undefined) {
    if (!Number.isInteger(input.pickedOption) || input.pickedOption < 0 || input.pickedOption >= question.options.length) {
      throw new Error(fmt('uiGrill.pickedOptionOutOfRange', {
        p1: String(input.pickedOption),
        p2: question.id,
        p3: String(question.options.length),
      }))
    }
  }
  const picked = input.pickedOption === undefined ? undefined : question.options[input.pickedOption]
  const text = input.assume === true ? question.defaultRecommendation : input.answer
  const answerText = picked === undefined ? text : `${text}（选择：${picked.label}）`

  const next: GrillQuestion = {
    ...question,
    answer: answerText,
    status: input.assume === true ? 'assumed' : 'answered',
    ...(input.assume === true ? { authorizedByUser: true } : {}),
    answeredBy: input.by ?? 'human',
  }
  writeQuestion(store, next)
  journal.append('question/answered', {
    id: next.id,
    status: next.status,
    by: next.answeredBy,
    targets: next.targets,
  })

  // **m2（本报告）**：旧实现先 `updateRequirement`（一次评分）再 `setOpenQuestions`（又一次评分），
  // 同一需求被派发两次评分 —— 当前是覆盖式赋值所以结果一致，一旦评分改成累加就会翻倍。
  // 现在未决集合**先算好**，一次带进 `updateRequirement`，每条需求只算一次。
  const updated: Requirement[] = []
  for (const target of next.targets) {
    const open = listQuestions(store)
      .filter((item) => isEffectivelyOpen(item) && item.targets.includes(target))
      .map((item) => item.id)
    const result = updateRequirement(store, journal, project, {
      id: target,
      openQuestions: open,
      ...(input.modelDimensions === undefined ? {} : { modelDimensions: input.modelDimensions }),
    })
    if (result !== undefined) updated.push(result.requirement)
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


/** 需求陈述里的"可用词"：中文取 2-gram，ASCII 取长度≥2 的 token（用于校验"引用原文"）。 */
export function statementKeywords(statement: string): string[] {
  const out = new Set<string>()
  const text = textOf(statement)
  for (const token of text.match(/[A-Za-z0-9][A-Za-z0-9._-]+/gu) ?? []) out.add(token.toLowerCase())
  const cjk = text.replace(/[^\u4e00-\u9fff]/gu, ' ')
  for (const run of cjk.split(/\s+/u)) {
    for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2))
  }
  return [...out]
}

export interface ProposedQuestion { text: string; dimension?: string | undefined }
export type RejectReason = 'empty' | 'tooShort' | 'tooLong' | 'notQuestion' | 'noKeyword' | 'duplicate'

/** **方案 B 的校验闸门**：模型生成的红队问题必须引用需求原文用词，且不得重复。 */
export function validateProposed(
  questions: ProposedQuestion[],
  statement: string,
  existing: GrillQuestion[],
  count: number,
): { accepted: ProposedQuestion[]; rejected: { text: string; reason: RejectReason }[] } {
  const keywords = statementKeywords(statement)
  const norm = (text: string): string => text.replace(/\s+/gu, '').replace(/[？?！!。，,、；;：:]/gu, '')
  const seen = new Set(existing.map((question) => norm(textOf(question.text))))
  const accepted: ProposedQuestion[] = []
  const rejected: { text: string; reason: RejectReason }[] = []
  for (const question of questions) {
    const text = textOf(question.text).trim()
    if (text === '') { rejected.push({ text, reason: 'empty' }); continue }
    if (text.length < 6) { rejected.push({ text, reason: 'tooShort' }); continue }
    if (text.length > 200) { rejected.push({ text, reason: 'tooLong' }); continue }
    if (!/[？?]$/u.test(text)) { rejected.push({ text, reason: 'notQuestion' }); continue }
    const lower = text.toLowerCase()
    if (!keywords.some((keyword) => lower.includes(keyword))) { rejected.push({ text, reason: 'noKeyword' }); continue }
    if (seen.has(norm(text))) { rejected.push({ text, reason: 'duplicate' }); continue }
    seen.add(norm(text))
    accepted.push({ text, ...(question.dimension === undefined ? {} : { dimension: question.dimension }) })
    if (accepted.length >= count) break
  }
  return { accepted, rejected }
}

/** 把通过校验的模型提案写成红队问题（origin=red-team，留痕 model-proposed）。 */
export function writeProposedQuestions(
  store: SdoStore,
  journal: Journal,
  requirementId: string,
  accepted: ProposedQuestion[],
): GrillQuestion[] {
  const existing = listQuestions(store)
  const usedIds = existing.map((question) => question.id)
  const askedAt = new Date().toISOString()
  const created: GrillQuestion[] = []
  for (const item of accepted) {
    const id = nextId('Q', usedIds, 4)
    usedIds.push(id)
    const question: GrillQuestion = {
      id,
      text: item.text,
      targets: [requirementId],
      dimension: (item.dimension ?? 'boundary') as Dimension,
      severity: 'P0',
      why: `#model-proposed ${item.text}`,
      consequenceIfUnasked: t('redteam.fileConsequence'),
      options: [],
      defaultRecommendation: '',
      answer: null,
      status: 'open',
      askedAt,
      answeredBy: null,
      origin: 'red-team',
    }
    writeQuestion(store, question)
    created.push(question)
  }
  if (created.length > 0) journal.append('redteam/model-proposed', { target: requirementId, questions: created.map((q) => q.id) })
  return created
}
