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
  /** 表格化字段：列顺序（数组 of 对象）。 */
  tables: Record<string, string[]>
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
    metaFields: ['id', 'kind', 'status'],
    bodyFields: ['responsibility', 'summary'],
    tables: {},
    refFields: ['dependsOn', 'requires', 'elements'],
  },
  contracts: {
    titleFields: ['name', 'id'],
    metaFields: ['id', 'kind', 'status'],
    bodyFields: ['schema', 'failureSemantics', 'droppedReason'],
    tables: {},
    refFields: ['producer', 'consumer', 'requires'],
  },
  quality: {
    titleFields: ['attribute', 'id'],
    metaFields: ['id', 'priority'],
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
    metaFields: ['id', 'status', 'priority'],
    bodyFields: [],
    tables: {},
    refFields: ['requirement', 'targets', 'covers'],
  },
  defects: {
    titleFields: ['title'],
    metaFields: ['id', 'severity', 'status'],
    bodyFields: ['symptom', 'rootCause', 'remedy', 'reason'],
    tables: {},
    refFields: ['requirement', 'targets', 'origin'],
  },
  changes: {
    titleFields: ['requirement', 'reason'],
    metaFields: ['id', 'status', 'decidedBy'],
    bodyFields: ['reason', 'changes', 'impact', 'decision'],
    tables: {},
    refFields: ['requirement'],
  },
  issues: {
    titleFields: ['questionIds', 'id'],
    metaFields: ['id', 'status', 'disposition'],
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
  for (const value of Object.values(record)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const inner = value as Record<string, unknown>
      if (typeof inner['id'] === 'string' || typeof inner['title'] === 'string' || typeof inner['text'] === 'string') return inner
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
  return ''
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
      lines.push(`- ${resolveRefs(typeof item === 'string' ? item : JSON.stringify(item), refs)}`)
    }
    return lines
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    // 只有一两个键的小对象（如 source/ambiguity）压成一行，可读性优先
    const entries = Object.entries(record).filter(([, item]) => item !== undefined)
    if (entries.length > 0 && entries.every(([, item]) => typeof item !== 'object')) {
      const text = entries
        .map(([key, item]) => `${fieldLabel(key)} ${scalarText(item, refs, false)}`)
        .join(t('uiSignPayload.metaSep'))
      lines.push(`**${label}**：${text}`)
      return lines
    }
  }
  return []
}

function tableBlock(label: string, rows: readonly unknown[], columns: readonly string[], refs: RefIndex): string[] {
  const lines = [`**${label}**：`, '', `| ${columns.map((column) => fieldLabel(column)).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`]
  for (const row of rows) {
    const record = row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : {}
    lines.push(`| ${columns.map((column) => scalarText(record[column], refs, false)).join(' | ')} |`)
  }
  return lines
}

/**
 * 渲染一条台账条目（人读形态）。
 *
 * 已覆盖字段按 `view` 的规则展开；**未覆盖字段照样展开**（进"其他字段"），漏字段即漏审。
 */
export function renderEntry(
  collection: string,
  id: string,
  content: unknown,
  refs: RefIndex,
  used: Set<string>,
  provenance?: string,
): string[] {
  const view = COLLECTION_VIEWS[collection] ?? VIEW_DEFAULT
  const record = { ...unwrapEntry(content) }
  const lines: string[] = []
  // 代号已经写在标题行里，不再作为字段重复出现
  used.add('id')

  // ① 标题行：`### <代号>　<人类可读名称>`
  let title = ''
  for (const key of view.titleFields) {
    const text = scalarText(record[key], refs, false)
    if (text !== '' && text !== t('uiSignPayload.empty')) {
      title = text
      used.add(key)
      break
    }
  }
  lines.push(`#### ${id}${title === '' ? '' : `${t('uiSignPayload.entryTitleSep')}${title}`}`)
  lines.push('')
  if (provenance !== undefined && provenance !== '') {
    lines.push(provenance)
    lines.push('')
  }

  // ② 元信息一行：`- 优先级 **must** ｜ 类型 functional`（关联字段解析成代号带名称）
  const meta: string[] = []
  for (const key of view.metaFields) {
    if (isEmptyValue(record[key])) {
      used.add(key)
      continue
    }
    const value = view.refFields.includes(key)
      ? resolveRefs(String(record[key]), refs)
      : scalarText(record[key], refs, true)
    if (value === '') continue
    meta.push(`${fieldLabel(key)} ${value}`)
    used.add(key)
  }
  for (const key of view.derivedConsumes ?? []) used.add(key)
  for (const extra of view.derived?.(record, refs) ?? []) {
    // derived 行的字段已被消费（如 ambiguity/targets），不必再进「其他字段」
    if (extra.trim() !== '') meta.push(extra)
  }
  if (meta.length > 0) {
    lines.push(`- ${meta.join(t('uiSignPayload.metaSep'))}`)
    lines.push('')
  }

  // ③ 正文块
  for (const key of view.bodyFields) {
    // 字段无论有没有内容都算"已消费"，否则空字段会掉进「其他字段」重复一遍
    used.add(key)
    if (isEmptyValue(record[key])) continue
    const block = bodyBlock(fieldLabel(key), view.refFields.includes(key) ? resolveRefs(JSON.stringify(record[key]), refs) : record[key], refs)
    if (block.length === 0) continue
    lines.push(...block)
    lines.push('')
    used.add(key)
  }

  // ④ 表格（验收标准 / 选项这类，结构化后比嵌套列表清楚得多）
  for (const [key, columns] of Object.entries(view.tables)) {
    const value = record[key]
    used.add(key)
    if (!Array.isArray(value) || value.length === 0) continue
    lines.push(...tableBlock(fieldLabel(key), value, columns, refs))
    lines.push('')
    used.add(key)
  }

  // ⑤ 关联字段单独一行（`- 涉及需求：REQ-001「标题」`）
  const refsOnly = view.refFields.filter((key) => !used.has(key) && !isEmptyValue(record[key]))
  if (refsOnly.length > 0) {
    const parts = refsOnly.map((key) => `${fieldLabel(key)} ${resolveRefs(String(record[key]), refs)}`)
    lines.push(`- ${parts.join(t('uiSignPayload.metaSep'))}`)
    lines.push('')
    for (const key of refsOnly) used.add(key)
  }

  // ⑥ 剩余字段（**不许丢**）：字典没覆盖的照原样展开在"其他字段"下
  // **剩余字段里剔除「与审核无关」的那些**（时间戳/内部版本/归一评分…）：真源里仍可查，
  // 但不占审核单篇幅。这张忽略清单是唯一的增删点。
  const leftovers = Object.entries(record).filter(
    ([key, item]) => !used.has(key) && !isIgnoredField(key) && !isEmptyValue(item),
  )
  if (leftovers.length > 0) {
    lines.push(`**${t('uiSignPayload.otherFields')}**：`)
    for (const [key, item] of leftovers) {
      if (item !== null && typeof item === 'object') {
        lines.push(`- ${fieldLabel(key)}：`)
        lines.push(...renderGeneric(item, '  ', refs))
      } else {
        lines.push(`- ${fieldLabel(key)}：${scalarText(item, refs, false)}`)
      }
    }
    lines.push('')
  }
  return lines
}

/** 通用展开（"其他字段"里用；也可能被别处复用）。 */
export function renderGeneric(value: unknown, indent: string, refs: RefIndex): string[] {
  if (value === undefined || value === null) return [`${indent}${t('uiSignPayload.empty')}`]
  if (typeof value === 'string') {
    const text = resolveRefs(value, refs)
    return text.trim() === '' ? [`${indent}${t('uiSignPayload.empty')}`] : text.split('\n').map((line, i) => (i === 0 ? `${indent}${line}` : `${indent}  ${line}`))
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [`${indent}${String(value)}`]
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${t('uiSignPayload.empty')}`]
    return value.flatMap((item) =>
      item !== null && typeof item === 'object' ? [`${indent}-`, ...renderGeneric(item, `${indent}  `, refs)] : [`${indent}- ${scalarText(item, refs, false)}`],
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
