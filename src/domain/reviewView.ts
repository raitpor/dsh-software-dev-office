/**
 * **受审载荷的呈现层**（2026-10-12 用户评审后新增）。
 *
 * 为什么要有它：第一版把台账**原样倒**进审核单 —— 字段名是 YAML 键（`statement` / `acs` / `origin`），
 * 代号是裸的（`REQ-12`、`STK-01`、`Q-0007` 都不说是什么）。用户的评价是"表达不清、看不懂关联"，
 * 参照物是项目侧自建的那份审查包：`### REQ-001　<标题>` + `**陈述**`/`**理由**` + 验收标准**表格**，
 * 风险是 `- 等级 high ｜ 概率 medium ｜ 状态 open` + `**影响**`/`**缓解**`。
 *
 * 三条口径：
 *   ① **字段名一律走语言包**（`uiSignField.<键>`），不再把 YAML 键当标签；
 *   ② **代号必须带名称**：`REQ-001「标题」`（`refWithName`），关联字段（`targets`/`origin`/
 *      `requirement`/`blockedBy`/`dependsOn`…）都要解析成人能看懂的样子；
 *   ③ **不漏字段**：字典没覆盖的字段仍旧展开（进"其他字段"小节）—— 漏字段就是漏审，
 *      守卫会把"真源叶子键是否都出现在文档里"机械对一遍。
 */
import { fmt, t } from './i18n.js'

/** 一个条目的呈现规则。 */
export interface CollectionView {
  /** 条目标题从哪个字段取（按序尝试第一个非空）。 */
  titleFields: string[]
  /** 一行元信息（`｜` 分隔，值用**粗体**）。 */
  metaFields: string[]
  /** 正文块（`**标签**` + 段落）的顺序。 */
  bodyFields: string[]
  /** 表格化字段：列顺序（数组 of 对象）；'auto' 表示按首项标量键自动定列。 */
  tables: Record<string, string[] | 'auto'>
  /**
   * **列表化字段**：数组 of 对象 ⇒ 每条渲染成带标签的子条目。
   *
   * 为什么不用表格：方法产物/视图元素的 `responsibility`/`statement` 是整段中文，
   * 塞进表格列会把表格撑成一堵墙（用户在 G3 反馈过"表述不清"）。
   */
  lists?: string[]
  /** 纯量数组字段：压成一行 `标签：a、b、c`（元素经标签映射）。 */
  inlineLists?: string[]
  /** 表格列名的**覆盖**：`{字段: {列: 语言包键}}`（同一字段名在不同工件里语义可能不同）。 */
  tableLabels?: Record<string, Record<string, string>>
  /** 标题行的**现成写法**（工件类型用；给了就不走 titleFields）。 */
  heading?: (record: Record<string, unknown>, refs: RefIndex) => string
  /** 关联代号的字段（值会解析成 `CODE「名称」`）。 */
  refFields: string[]
  /** 额外补的元信息行（例如需求的歧义评分、问答的目标需求）。 */
  derived?: (record: Record<string, unknown>, refs: RefIndex) => string[]
  /** `derived` 已经消费掉的字段（**不再进「其他字段」**，否则原始结构又会冒出来）。 */
  derivedConsumes?: string[]
}

/**
 * **与审核无关的字段**（2026-10-12 用户裁定："有些对审核没什么意义的东西可以不写进去"）。
 *
 * 判据：一个字读下去，签字人**不需要**它来判断"模型理解得对不对" —— 时间戳、内部版本号、
 * 归一后的评分明细、内部指纹与依据字段等。它们仍在 `.sdo/` 真源里（想看随时能看），
 * 只是不挤占审核单的篇幅。
 *
 * **这张表是唯一的增删点**：想收进来的字段，从这里删掉即可（守卫会要求它重新出现）。
 */
const IGNORED_FIELDS: readonly string[] = [
  'at', 'createdAt', 'updatedAt', 'askedAt', 'answeredAt', 'answeredBy', 'authorizedByUser',
  'version', 'baseline', 'revision', 'contentHash', 'basis', 'basisSource', 'basisChecked',
  'recommendationFromModel', 'prototype', 'open', 'dimensions', 'score', 'angles',
  // 模型侧打分明细、机读字段：签字人不需要它来判断"理解得对不对"（真源里仍在）
  'modelDimensions', 'needsReviewRaw', 'contentId',
]

/**
 * **工件类型**：同一个集合里可能混着好几种工件 —— `design/` 下就同时有
 * 适用性声明（`applicability.yml`）、视图（`component.yml`…）、界面方案（`ui.yml`）、
 * 方法产物（`method-*.yml`）、设计方法选择（`method.yml`）与用户确认戳（`confirmed.yml`）。
 *
 * 为什么必须分开：G3 真机上它们**全被当成"设计元素"**渲染 ⇒ 标题行只剩文件名或英文 kind
 * （`#### applicability`、`#### component`、`#### MA-001　classes`），正文整段掉进「其他字段」。
 * 分派后每类都有自己的标题与人话标签。
 */
export type ArtifactKind =
  | 'applicability'
  | 'view'
  | 'ui'
  | 'methodChoice'
  | 'artifact'
  | 'confirmations'
  | 'atam'
  | 'entry'

/** 视图类工件的文件名（`design/<stem>.yml`）。`method.yml` **不在**其中：它是设计方法选择。 */
const VIEW_KIND_FILES = new Set(['component', 'context', 'runtime', 'data', 'deployment', 'module', 'class', 'usecase', 'state'])

/** 按（集合 + 文件 + 形状）判定工件类型。 */
export function artifactOf(collection: string, path: string, record: Record<string, unknown>): ArtifactKind {
  const file = path.split('/').pop() ?? ''
  if (collection === 'design') {
    if (file === 'applicability.yml') return 'applicability'
    if (file === 'ui.yml') return 'ui'
    if (file === 'method.yml') return 'methodChoice'
    if (file.startsWith('method-')) return 'artifact'
    if (file === 'confirmed.yml') return 'confirmations'
  }
  // ATAM 是**质量属性权衡工件**（`by` / `risks` / `sensitivities`），不是质量场景 ——
  // 旧实现把它按场景渲染 ⇒ 标题行成了 `质量场景：`（属性名为空）。
  if (collection === 'quality' && file === 'atam.yml') return 'atam'
  if (collection === 'quality' && file.startsWith('atam')) return 'atam'
  // 视图按**文件名**定性（`component.yml` / `context.yml` …）：不能只靠"记录里恰好有 `elements`"，
  // 否则一旦视图还没填元素，标题行就退回文件名。
  const stem = file.replace(/\.ya?ml$/u, '')
  if (VIEW_KIND_FILES.has(stem)) return 'view'
  if (record['elements'] !== undefined && record['kind'] !== undefined) return 'view'
  return 'entry'
}

/** 该字段是否与审核无关（逐集合同样可覆盖）。 */
export function isIgnoredField(key: string): boolean {
  return IGNORED_FIELDS.includes(key)
}

const VIEW_DEFAULT: CollectionView = { titleFields: ['title', 'name', 'text'], metaFields: [], bodyFields: [], tables: {}, refFields: [] }

/** 各集合的呈现规则（键 = 台账目录名）。 */
export const COLLECTION_VIEWS: Record<string, CollectionView> = {
  requirements: {
    titleFields: ['title'],
    metaFields: ['priority', 'kind', 'status', 'needsReview'],
    bodyFields: ['statement', 'rationale', 'source'],
    tables: { acceptance: ['id', 'given', 'when', 'then'] },
    refFields: [],
    derivedConsumes: ['ambiguity'],
    // 歧义评分是需求就绪度的核心读数（参考件也放在元信息行里），压成 `歧义评分 15/16`
    derived: (record) => {
      const ambiguity = record['ambiguity']
      if (ambiguity === null || typeof ambiguity !== 'object') return []
      const score = (ambiguity as Record<string, unknown>)['score']
      if (typeof score !== 'number') return []
      return [fmt('uiSignPayload.ambiguousScore', { p1: String(score), p2: '16' })]
    },
  },
  questions: {
    titleFields: ['text'],
    metaFields: ['severity', 'dimension'],
    bodyFields: ['why', 'consequenceIfUnasked', 'answer'],
    tables: { options: ['label', 'description'] },
    refFields: ['targets', 'origin', 'nonGoalConflict'],
    derivedConsumes: ['targets'],
    // 目标需求要一眼看到（`目标 REQ-001「标题」`），别让它藏在字段里
    derived: (record, refs) => {
      const targets = record['targets']
      if (targets === undefined) return []
      const codes = Array.isArray(targets) ? targets.map((item) => String(item)) : [String(targets)]
      const text = codes.map((code) => resolveRefs(code, refs)).join('、')
      return text === '' ? [] : [`${t('uiSignPayload.target')} ${text}`]
    },
  },
  risks: {
    titleFields: ['title'],
    metaFields: ['level', 'probability', 'status', 'owner'],
    bodyFields: ['impact', 'mitigation'],
    tables: {},
    refFields: ['origin'],
  },
  decisions: {
    titleFields: ['title'],
    metaFields: ['status'],
    bodyFields: ['context', 'decision', 'alternatives', 'consequences', 'supersededBy'],
    tables: {},
    refFields: [],
  },
  design: {
    titleFields: ['name', 'kind', 'summary'],
    metaFields: ['kind', 'status'],
    bodyFields: ['responsibility', 'summary'],
    tables: {},
    refFields: ['dependsOn', 'requires', 'elements'],
  },
  contracts: {
    titleFields: ['name', 'id'],
    metaFields: ['kind', 'status'],
    bodyFields: ['schema', 'failureSemantics', 'droppedReason'],
    tables: {},
    refFields: ['producer', 'consumer', 'requires'],
  },
  quality: {
    titleFields: ['attribute', 'id'],
    heading: (record) => fmt('uiSignPayload.qualityHeading', { p1: qualityLabel(String(record['attribute'] ?? '')) }),
    metaFields: ['priority'],
    bodyFields: ['stimulus', 'response', 'measure'],
    tables: {},
    refFields: ['targets'],
  },
  tasks: {
    titleFields: ['title'],
    metaFields: ['role', 'size', 'status', 'revision'],
    bodyFields: ['goal', 'dod', 'blockedReason', 'evidence'],
    tables: {},
    refFields: ['requirements', 'blockedBy', 'writeScopes', 'inputs', 'outputs', 'evidenceRequired'],
  },
  tests: {
    titleFields: ['title', 'name'],
    metaFields: ['status', 'priority'],
    bodyFields: [],
    tables: {},
    refFields: ['requirement', 'targets', 'covers'],
  },
  defects: {
    titleFields: ['title'],
    metaFields: ['severity', 'status'],
    bodyFields: ['symptom', 'rootCause', 'remedy', 'reason'],
    tables: {},
    refFields: ['requirement', 'targets', 'origin'],
  },
  changes: {
    titleFields: ['requirement', 'reason'],
    metaFields: ['status', 'decidedBy'],
    bodyFields: ['reason', 'changes', 'impact', 'decision'],
    tables: {},
    refFields: ['requirement'],
  },
  issues: {
    titleFields: ['questionIds', 'id'],
    metaFields: ['status', 'disposition'],
    bodyFields: ['note'],
    tables: {},
    refFields: ['target', 'questionIds', 'angles'],
  },
}

/**
 * 空值判据：`undefined` / `null` / 空串 / 空数组 / 空对象都算"没内容"。
 *
 * 为什么重要：审核单里 `**理由**：` 后面空白、`（空）` 占一行，都是**噪声**——
 * 用户明确要求"对审核没什么意义的东西可以不写进去"。空字段直接不写（真源里仍在）。
 */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0
  return false
}

/** 视图 kind → 人话（`uiSignView.*`，缺失回落原词）。 */
function viewKindLabel(kind: string): string {
  return t(`uiSignView.${kind}`, kind)
}

/** 方法产物 / 工件 kind → 人话（`uiSignMethod.*`）。 */
function methodKindLabel(kind: string): string {
  return t(`uiSignMethod.${kind}`, kind)
}

/** 质量属性 → 人话（`uiSignQuality.*`）。 */
function qualityLabel(attribute: string): string {
  return t(`uiSignQuality.${attribute}`, attribute)
}

/**
 * **工件级呈现规则**（2026-10-12 用户 G3 反馈后新增）。
 *
 * 与 `COLLECTION_VIEWS` 的分工：集合级规则管"这一目录整体怎么读"，
 * 工件级规则管"同一目录里这一种工件怎么读" —— `design/` 下有六种。
 */
const ARTIFACT_VIEWS: Record<Exclude<ArtifactKind, 'entry'>, CollectionView> = {
  applicability: {
    titleFields: [],
    metaFields: [],
    heading: () => t('uiSignPayload.applicabilityHeading'),
    bodyFields: ['focus', 'confirmed'],
    tables: { artifactsAbsent: ['kind', 'why'] },
    // 同一个 `why` 在问答题里是「为什么问」，在工件缺项里是「理由」—— 列名必须按工件覆盖
    tableLabels: { artifactsAbsent: { why: 'uiSignField.absentReason' } },
    refFields: [],
    inlineLists: ['viewsPresent', 'viewsAbsent', 'artifacts'],
  },
  view: {
    titleFields: [],
    metaFields: [],
    heading: (record) => fmt('uiSignPayload.viewHeading', { p1: viewKindLabel(String(record['kind'] ?? '')) }),
    bodyFields: ['summary'],
    tables: {},
    refFields: [],
    lists: ['elements'],
  },
  ui: {
    titleFields: [],
    metaFields: [],
    heading: () => t('uiSignPayload.uiHeading'),
    bodyFields: [],
    tables: {},
    refFields: [],
    lists: ['screens', 'breakpoints'],
    inlineLists: [],
  },
  methodChoice: {
    titleFields: [],
    metaFields: [],
    heading: () => t('uiSignPayload.methodChoiceHeading'),
    bodyFields: ['question', 'answer'],
    tables: {},
    refFields: [],
    inlineLists: ['methods'],
  },
  artifact: {
    titleFields: [],
    metaFields: [],
    heading: (record) => fmt('uiSignPayload.artifactHeading', { p1: methodKindLabel(String(record['kind'] ?? '')) }),
    bodyFields: ['summary'],
    tables: {},
    refFields: [],
    lists: ['types', 'debts', 'increments', 'invariants', 'sequences', 'decisions', 'rules'],
  },
  atam: {
    titleFields: [],
    metaFields: ['by'],
    heading: () => t('uiSignPayload.atamHeading'),
    bodyFields: [],
    tables: {},
    refFields: [],
    lists: ['risks', 'sensitivities'],
  },
  confirmations: {
    titleFields: [],
    metaFields: [],
    heading: () => t('uiSignPayload.confirmationsHeading'),
    bodyFields: [],
    tables: {},
    refFields: [],
    lists: ['confirmations'],
  },
}

/** 列表条目的"主名"与"副名"字段顺序（子条目渲染用）。 */
const ITEM_PRIMARY = ['name', 'id', 'title', 'target', 'label', 'kind']
const ITEM_SECONDARY = ['id', 'kind', 'layer', 'role', 'size', 'status', 'priority', 'severity']

/**
 * 该集合用作**条目标题**的字段（按序）。
 *
 * 它们的内容已经写在 `#### <代号>　<名称>` 标题行里，不再作为字段重复出现 ——
 * 守卫据此把它们从"必须出现标签"的清单里排除，转而断言**标题值出现在标题行里**。
 */
export function titleFieldsOf(collection: string): string[] {
  return (COLLECTION_VIEWS[collection] ?? VIEW_DEFAULT).titleFields
}

/** 字段标签：先查语言包，查不到退回键名（**不留空白**）。 */
export function fieldLabel(key: string): string {
  return t(`uiSignField.${key}`, key)
}

/** 代号 → 人类可读名称（由载荷各集合的 `id` + 标题字段建索引）。 */
export type RefIndex = ReadonlyMap<string, string>

/**
 * 台账条目的外层是**包装**（`{ requirement: { … } }`）：取内层对象来渲染。
 * 找不到内层对象就用它自己（有的集合是平铺的）。
 */
export function unwrapEntry(content: unknown): Record<string, unknown> {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return {}
  const record = content as Record<string, unknown>
  if (typeof record['id'] === 'string') return record
  const values = Object.values(record)
  for (const value of values) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>
      if (typeof inner['id'] === 'string' || typeof inner['title'] === 'string' || typeof inner['text'] === 'string') return inner
    }
  }
  // **没有 id 的单键包装**（`applicability:` / `view:` / `ui:` / `scenario:` …）也要剥：
  // 不剥的话正文会整段掉进「其他字段」，标题行只剩文件名（G3 真机的病根）。
  if (values.length === 1) {
    const only = values[0]
    if (only !== null && typeof only === 'object' && !Array.isArray(only) && record['id'] === undefined) {
      return unwrapEntry(only)
    }
  }
  return record
}

/** 从一条条目里取「人类可读短名」：标题类字段优先，最后退回问题正文首句。 */
export function shortName(content: unknown): string {
  const record = unwrapEntry(content)
  for (const key of ['title', 'name', 'attribute', 'summary']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  for (const key of ['text', 'question']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') {
      const line = value.trim().split('\n')[0] ?? ''
      return line.length > 40 ? `${line.slice(0, 40)}…` : line
    }
  }
  const raw = typeof record['id'] === 'string' ? record['id'] : ''
  return raw
}

/** 把文本里的代号替换成 `CODE「名称」`（**这就是"看不懂关联"的正面修复**）。 */
export function resolveRefs(text: string, refs: RefIndex): string {
  if (refs.size === 0) return text
  return text.replace(/\b[A-Z]{2,5}-\d{2,4}\b/gu, (code) => {
    const name = refs.get(code)
    return name === undefined || name === '' ? code : fmt('uiSignPayload.refWithName', { p1: code, p2: name })
  })
}

function scalarText(value: unknown, refs: RefIndex, quote: boolean): string {
  if (value === undefined || value === null) return t('uiSignPayload.empty')
  if (typeof value === 'string') {
    const text = resolveRefs(value.trim(), refs)
    if (text === '') return t('uiSignPayload.empty')
    return quote ? `**${text}**` : text
  }
  if (typeof value === 'number' || typeof value === 'boolean') return quote ? `**${String(value)}**` : String(value)
  // 结构化值：压成一行（表格单元、内联行都用它，**不留空**）
  return compactText(value, refs)
}

/**
 * **压成一行**：数组用 `、` 连，对象用 `标签 值`／`标签：值` 连。
 *
 * 表格单元与内联行都走它 —— 旧实现遇到对象直接返回空串，于是 `screens.columns`、
 * `artifactsAbsent.why` 这类嵌套值在文档里**整个消失**（漏字段就是漏审）。
 */
function compactText(value: unknown, refs: RefIndex): string {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) {
    const parts = value.map((item) => compactText(item, refs)).filter((text) => text !== '')
    return parts.length === 0 ? t('uiSignPayload.empty') : parts.join('、')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => !isIgnoredField(key))
    const scalars = entries.filter(([, item]) => item === null || typeof item !== 'object')
    if (entries.length > 0 && scalars.length === entries.length) {
      // 递归走 `compactText`（**不是** `String(item)`）：标量分支里要做代号解析，
      // 直接 `String()` 会让 `source.raw` 里的 `REQ-001` 丢掉名称（真机 diff 抓到的回归）
      return entries
        .map(([key, item]) => `${fieldLabel(key)} ${compactText(item, refs)}`)
        .join(t('uiSignPayload.metaSep'))
    }
    return entries
      .map(([key, item]) => `${fieldLabel(key)}${t('uiSignPayload.keyColon')}${compactText(item, refs)}`)
      .join('；')
  }
  return resolveRefs(String(value), refs)
}

/** 长文块：`**标签**` + 段落（保留换行与列表）。 */
function bodyBlock(label: string, value: unknown, refs: RefIndex): string[] {
  const lines: string[] = []
  if (typeof value === 'string') {
    lines.push(`**${label}**：${resolveRefs(value, refs)}`)
    return lines
  }
  if (Array.isArray(value)) {
    lines.push(`**${label}**：`)
    for (const item of value) {
      lines.push(`- ${compactText(item, refs)}`)
    }
    return lines
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const entries = Object.entries(record).filter(([key, item]) => item !== undefined && !isIgnoredField(key))
    if (entries.length > 0) {
      lines.push(`**${label}**：${compactText(record, refs)}`)
      return lines
    }
  }
  return []
}

/**
 * **子条目**：数组 of 对象 ⇒ 每条一行主名 + 缩进的标签行。
 *
 * 为什么不表格化：`responsibility` / `statement` 是整段中文，塞进表格列会把表撑成一堵墙。
 */
function itemBlock(label: string, rows: readonly unknown[], refs: RefIndex): string[] {
  const lines = [`**${label}**：`]
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      lines.push(`- ${compactText(row, refs)}`)
      continue
    }
    const record = Object.fromEntries(
      Object.entries(row as Record<string, unknown>).filter(([key, item]) => !isIgnoredField(key) && !isEmptyValue(item)),
    )
    const primaryKey = ITEM_PRIMARY.find((key) => typeof record[key] === 'string' && String(record[key]).trim() !== '')
    const primary = primaryKey === undefined ? '' : resolveRefs(String(record[primaryKey]), refs)
    const secondary = ITEM_SECONDARY.filter((key) => key !== primaryKey && record[key] !== undefined)
      .map((key) => `${fieldLabel(key)} ${valueText(key, scalarText(record[key], refs, false))}`)
    if (primaryKey !== undefined) delete record[primaryKey]
    for (const key of ITEM_SECONDARY) delete record[key]
    const head = secondary.length === 0 ? `- **${primary}**` : `- **${primary}**（${secondary.join(t('uiSignPayload.metaSep'))}）`
    lines.push(primary === '' ? '- ' : head)
    for (const [key, item] of Object.entries(record)) {
      if (item === null || typeof item !== 'object') {
        lines.push(`  - ${fieldLabel(key)}${t('uiSignPayload.keyColon')}${valueText(key, scalarText(item, refs, false))}`)
      } else if (Array.isArray(item) && item.every((one) => one === null || typeof one !== 'object')) {
        lines.push(`  - ${fieldLabel(key)}${t('uiSignPayload.keyColon')}${compactText(item, refs)}`)
      } else {
        lines.push(`  - ${fieldLabel(key)}${t('uiSignPayload.keyColon')}`)
        lines.push(...renderGeneric(item, '    ', refs))
      }
    }
  }
  return lines
}

function tableBlock(
  label: string,
  rows: readonly unknown[],
  columns: readonly string[],
  refs: RefIndex,
  labels?: Record<string, string>,
): string[] {
  const head = columns.map((column) => (labels?.[column] === undefined ? fieldLabel(column) : t(labels[column]!)))
  const lines = [`**${label}**：`, '', `| ${head.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`]
  for (const row of rows) {
    const record = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
    lines.push(`| ${columns.map((column) => compactText(record[column], refs) || scalarText(record[column], refs, false)).join(' | ')} |`)
  }
  return lines
}

/** 表格列：给了就用给的，`'auto'` 则按首项的标量键（有 id 就放最前）。 */
function columnsFor(rows: readonly unknown[], spec: readonly string[] | 'auto'): string[] {
  if (spec !== 'auto') return [...spec]
  const first = rows.find((row) => row !== null && typeof row === 'object')
  if (first === undefined) return []
  const keys = Object.keys(first as Record<string, unknown>).filter((key) => !isIgnoredField(key))
  const ordered = [...ITEM_PRIMARY.filter((key) => keys.includes(key)), ...keys.filter((key) => !ITEM_PRIMARY.includes(key))]
  return ordered
}

/** 纯量清单字段的值映射（视图名、方法工件名要说人话）。 */
const INLINE_LABELER: Record<string, (value: string) => string> = {
  viewsPresent: viewKindLabel,
  viewsAbsent: viewKindLabel,
  artifacts: methodKindLabel,
}

/** 列表字段的行映射（`kind` 这类代号先说成人话）。 */
const LIST_ROW_TRANSFORM: Record<string, (rows: Record<string, unknown>[]) => Record<string, unknown>[]> = {
  artifactsAbsent: (rows) => rows.map((row) => ({ ...row, kind: methodKindLabel(String(row['kind'] ?? '')) })),
}

/**
 * **取值**也要说人话：这些字段的取值是受控词表（`kind: class`、`layer: infra`、`status: open`…）。
 * 查不到就回落原词（**绝不编造**）。
 */
const VALUE_LABEL_KEYS = [
  'kind', 'layer', 'role', 'status', 'priority', 'severity', 'confidence', 'attribute',
  // G2 真机扫出来的漏网取值字段（风险等级/概率、问答维度、状态机）
  'level', 'probability', 'dimension', 'state',
]

function valueText(key: string, text: string): string {
  if (!VALUE_LABEL_KEYS.includes(key) || text === '') return text
  return t(`uiSignValue.${text}`, text)
}

/** 关联值（可能是数组）→ 一行人话。 */
function refsText(value: unknown, refs: RefIndex): string {
  if (Array.isArray(value)) return value.map((item) => resolveRefs(String(item), refs)).join('、')
  return resolveRefs(String(value ?? ''), refs)
}

/**
 * 渲染一条台账条目（人读形态）。
 *
 * 已覆盖字段按 `view` 的规则展开；**未覆盖字段照样展开**（进「其他字段」），漏字段即漏审。
 * 工件类型（`design/` 下有六种）走 `ARTIFACT_VIEWS`，集合类型走 `COLLECTION_VIEWS`。
 */
export function renderEntry(
  collection: string,
  id: string,
  content: unknown,
  refs: RefIndex,
  used: Set<string>,
  provenance?: string,
  path = '',
): string[] {
  const record = { ...unwrapEntry(content) }
  const kind = artifactOf(collection, path, record)
  const view = kind === 'entry' ? (COLLECTION_VIEWS[collection] ?? VIEW_DEFAULT) : ARTIFACT_VIEWS[kind]
  const lines: string[] = []
  // 代号已经写在标题行里，不再作为字段重复出现
  used.add('id')

  // ① 标题行：`#### <代号>　<人类可读名称>`（工件类型用现成写法）
  let title = view.heading?.(record, refs) ?? ''
  for (const key of view.titleFields) used.add(key)
  if (title === '') {
    for (const key of view.titleFields) {
      const text = scalarText(record[key], refs, false)
      if (text !== '' && text !== t('uiSignPayload.empty') && String(record[key] ?? '') !== id) {
        title = text
        break
      }
    }
  }
  lines.push(`#### ${id}${title === '' ? '' : `${t('uiSignPayload.entryTitleSep')}${title}`}`)
  lines.push('')
  if (provenance !== undefined && provenance !== '') {
    lines.push(provenance)
    lines.push('')
  }

  // ② 一行元信息：`- 优先级 **must** ｜ 类型 functional`
  const meta: string[] = []
  for (const key of view.metaFields) {
    if (isEmptyValue(record[key])) {
      used.add(key)
      continue
    }
    // 先取**原值**查人话映射，再决定加不加粗（`**high**` 是查不到 `uiSignValue.high` 的）
    const raw = view.refFields.includes(key) ? refsText(record[key], refs) : scalarText(record[key], refs, false)
    if (raw === '') continue
    const mapped = valueText(key, raw)
    meta.push(`${fieldLabel(key)} ${scalarText(mapped, refs, true)}`)
    used.add(key)
  }
  for (const key of view.derivedConsumes ?? []) used.add(key)
  for (const extra of view.derived?.(record, refs) ?? []) {
    if (extra.trim() !== '') meta.push(extra)
  }
  if (meta.length > 0) {
    lines.push(`- ${meta.join(t('uiSignPayload.metaSep'))}`)
    lines.push('')
  }

  // ③ 正文块
  for (const key of view.bodyFields) {
    used.add(key)
    if (isEmptyValue(record[key])) continue
    const block = bodyBlock(fieldLabel(key), record[key], refs)
    if (block.length === 0) continue
    lines.push(...block)
    lines.push('')
  }

  // ④ 纯量清单：`- 要做的视图：上下文视图、组件视图…`
  for (const key of view.inlineLists ?? []) {
    used.add(key)
    if (isEmptyValue(record[key])) continue
    const values = (Array.isArray(record[key]) ? record[key] : [record[key]]).map((item) => String(item))
    const labeler = INLINE_LABELER[key]
    const text = values.map((item) => resolveRefs(labeler === undefined ? item : labeler(item), refs)).join('、')
    lines.push(`- ${fieldLabel(key)}${t('uiSignPayload.keyColon')}${text}`)
    lines.push('')
  }

  // ⑤ 列表：数组 of 对象 ⇒ 带标签的子条目（长中文不进表格）
  for (const key of view.lists ?? []) {
    used.add(key)
    const value = record[key]
    if (!Array.isArray(value) || value.length === 0) continue
    const transform = LIST_ROW_TRANSFORM[key]
    const rows = transform === undefined ? value : transform(value as Record<string, unknown>[])
    lines.push(...itemBlock(fieldLabel(key), rows, refs))
    lines.push('')
  }

  // ⑥ 表格：短单元的结构化清单（验收标准 / 选项 / 缺项理由）
  for (const [key, spec] of Object.entries(view.tables)) {
    const value = record[key]
    used.add(key)
    if (!Array.isArray(value) || value.length === 0) continue
    const transform = LIST_ROW_TRANSFORM[key]
    const rows = transform === undefined ? value : transform(value as Record<string, unknown>[])
    const columns = columnsFor(rows, spec)
    if (columns.length === 0) continue
    lines.push(...tableBlock(fieldLabel(key), rows, columns, refs, view.tableLabels?.[key]))
    lines.push('')
  }

  // ⑦ 关联字段单独一行（`- 涉及需求：REQ-001「标题」`）
  const refsOnly = view.refFields.filter((key) => !used.has(key) && !isEmptyValue(record[key]))
  if (refsOnly.length > 0) {
    const parts = refsOnly.map((key) => `${fieldLabel(key)} ${refsText(record[key], refs)}`)
    lines.push(`- ${parts.join(t('uiSignPayload.metaSep'))}`)
    lines.push('')
    for (const key of refsOnly) used.add(key)
  }

  // ⑧ 剩余字段（**不许丢**）：字典没覆盖的照原样展开在「其他字段」下
  const leftovers = Object.entries(record).filter(
    ([key, item]) => !used.has(key) && !isIgnoredField(key) && !isEmptyValue(item),
  )
  if (leftovers.length > 0) {
    lines.push(`**${t('uiSignPayload.otherFields')}**：`)
    for (const [key, item] of leftovers) {
      if (item !== null && typeof item === 'object') {
        lines.push(`- ${fieldLabel(key)}${t('uiSignPayload.keyColon')}`)
        lines.push(...renderGeneric(item, '  ', refs))
      } else {
        lines.push(`- ${fieldLabel(key)}${t('uiSignPayload.keyColon')}${scalarText(item, refs, false)}`)
      }
    }
    lines.push('')
  }
  return lines
}

export function renderGeneric(value: unknown, indent: string, refs: RefIndex): string[] {
  if (value === undefined || value === null) return [`${indent}${t('uiSignPayload.empty')}`]
  if (typeof value === 'string') {
    const text = resolveRefs(value, refs)
    return text.trim() === '' ? [`${indent}${t('uiSignPayload.empty')}`] : text.split('\n').map((line, i) => (i === 0 ? `${indent}${line}` : `${indent}  ${line}`))
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [`${indent}${String(value)}`]
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${t('uiSignPayload.empty')}`]
    return value.flatMap((item, index) =>
      item !== null && typeof item === 'object'
        ? [
            `${indent}- ${fmt('uiSignPayload.itemIndex', { p1: String(index + 1) })}${t('uiSignPayload.keyColon')}`,
            ...renderGeneric(item, `${indent}  `, refs),
          ]
        : [`${indent}- ${scalarText(item, refs, false)}`],
    )
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return [`${indent}${t('uiSignPayload.empty')}`]
  return entries.flatMap(([key, item]) =>
    item !== null && typeof item === 'object'
      ? [`${indent}- ${fieldLabel(key)}${t('uiSignPayload.keyColon')}`, ...renderGeneric(item, `${indent}  `, refs)]
      : [`${indent}- ${fieldLabel(key)}${t('uiSignPayload.keyColon')}${scalarText(item, refs, false)}`],
  )
}
