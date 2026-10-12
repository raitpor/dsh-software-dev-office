/**
 * 门禁签字的**审核单**（完整 Markdown）。
 *
 * 为什么要有它：`sdo_gate action=sign channel=question` 过去只把一句固定文案
 * （`uiSign.detail`）放进问答卡，用户"签字"时其实**看不到自己签的是什么**。
 * 真机教训（2026-10-09）正是"看起来同意了"与"有留痕的用户同意"两件事被混为一谈。
 * 这里把**本次要签的对象**渲染成一份可通读的审核单：逐条判据（三态）+ 未通过项与修法
 * + 本门相关产物的原文。它在问答卡的 `detail` 里，同时被客户端半镜像到右侧边栏。
 *
 * 分工：本模块**只负责渲染**（纯函数，好测）；判据与产物的采集在 `office.signReviewDoc`。
 * 文案一律走语言包（棘轮基线 0），本模块不许出现硬编码中文。
 */
import { fmt, t } from './i18n.js'
import type { ReviewPayloadSection } from './reviewPayload.js'

/** 一条判据在审核单里的样子（三态与 `describeGate` 同口径）。 */
export interface SignReviewCriterion {
  id: string
  ok: boolean
  na: boolean
  desc: string
  detail: string
  remedy: string
  warnings: string[]
}

/**
 * 一件本门相关产物。
 *
 * **只列清单，不内联原文**（2026-10-09 真机反馈：内联产物原文会让问答卡变成一堵墙）。
 * 签字要看的"审核内容"是**判据与未通过项**；原文到该文件里看（右侧边栏的标签页标题与
 * 卡片正文都指向它）。
 */
export interface SignReviewArtifact {
  /** 流程数据里声明的名字（如 `SDD.md`）。 */
  name: string
  /** 相对工作区的路径（如 `docs/SDD.md`）或"哪里都没找到"的候选路径。 */
  path: string
  exists: boolean
  /** 文件字节数（不存在时为 0）。 */
  bytes: number
}

export interface SignReviewDoc {
  gate: string
  /** 门禁显示名（已本地化，如"架构门禁"）。 */
  gateText: string
  /** 阶段显示名（已本地化）。 */
  phaseText: string
  /** 判定状态文案（已本地化）。 */
  statusText: string
  at: string
  criteria: SignReviewCriterion[]
  artifacts: SignReviewArtifact[]
  /** `true` = 真源读不出来，判据没有逐条判定（`office.truthFailure` 的路径）。 */
  unjudged: boolean
  /**
   * **受审载荷全文**（方案 3，2026-10-12）：按流程数据的 `reviewPayload` 声明逐条内联。
   * 空 = 该阶段没有声明受审集合（或真源读不出来），此时审核单只有判据与产物清单。
   */
  payload: ReviewPayloadSection[]
  /**
   * **整篇指纹**（`sha256:` + 规范化 JSON of `{gate, payload}`）。
   *
   * 绑的是**内容**（与确认戳 F-19 同口径），不是文件字节、不是 mtime：
   * 真源一变指纹就变 ⇒ 审核单失效 ⇒ 签字前拦下（"不许拿过期审核单签字"）。
   */
  fingerprint: string
  /** 生成时的 journal 序号（审计用：审核单对应真源的第几号事件之后）。 */
  seq: number
}

/**
 * 真源对象的**通用渲染**：把任意 YAML 结构展开成 Markdown 嵌套列表。
 *
 * 为什么用通用规则而不是逐集合做字段映射：**结构上不可能漏字段** —— 漏字段就是漏审，
 * 而签字人要判断的正是"逐条正文"。守卫会把"叶子键是否都出现在渲染结果里"机械对一遍。
 * 不截断：审核单的价值就是全文（体积由调用方按集合控制）。
 */
function renderTruth(value: unknown, indent: string): string[] {
  if (value === undefined || value === null) return [`${indent}${t('uiSignPayload.empty')}`]
  if (typeof value === 'string') {
    const text = value.replace(/\r\n/gu, '\n')
    if (text.trim() === '') return [`${indent}${t('uiSignPayload.empty')}`]
    const lines = text.split('\n')
    return [indent + lines[0], ...lines.slice(1).map((line) => `${indent}  ${line}`)]
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [`${indent}${String(value)}`]
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}${t('uiSignPayload.empty')}`]
    return value.flatMap((item) =>
      item !== null && typeof item === 'object'
        ? [`${indent}-`, ...renderTruth(item, `${indent}  `)]
        : [`${indent}- ${String(item)}`],
    )
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return [`${indent}${t('uiSignPayload.empty')}`]
  return entries.flatMap(([key, item]) =>
    item !== null && typeof item === 'object'
      ? [`${indent}- **${key}**${t('uiSignPayload.keyColon')}`, ...renderTruth(item, `${indent}  `)]
      : [`${indent}- **${key}**${t('uiSignPayload.keyColon')}${String(item ?? '')}`],
  )
}

/** 表格单元：竖线会破表格结构、换行会破行结构，两者都要收敛。 */
function cell(text: string): string {
  return text.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ').trim()
}

function markerOf(row: SignReviewCriterion): string {
  if (row.na) return t('uiDescribe.gateNa')
  return row.ok ? '✅' : '❌'
}

/** 三条计数（总/通过/未通过/不适用）—— 总览与"未通过项"两处共用，**只保留一份口径**。 */
export function signReviewCounts(doc: SignReviewDoc): { total: number; passed: number; failed: number; na: number } {
  return {
    total: doc.criteria.length,
    passed: doc.criteria.filter((row) => row.ok && !row.na).length,
    failed: doc.criteria.filter((row) => !row.ok && !row.na).length,
    na: doc.criteria.filter((row) => row.na).length,
  }
}

/** 判定总览那 5 行（审核单与"卡片摘要"共用 —— 两处文案必须永远一致）。 */
function metaLines(doc: SignReviewDoc): string[] {
  const counts = signReviewCounts(doc)
  return [
    fmt('uiSignReview.metaGate', { p1: doc.gate, p2: doc.gateText }),
    fmt('uiSignReview.metaPhase', { p1: doc.phaseText }),
    fmt('uiSignReview.metaStatus', { p1: doc.statusText }),
    fmt('uiSignReview.metaCounts', {
      p1: String(counts.total),
      p2: String(counts.passed),
      p3: String(counts.failed),
      p4: String(counts.na),
    }),
    fmt('uiSignReview.metaAt', { p1: doc.at }),
  ]
}

/**
 * **卡片摘要**（用户裁定 2026-10-10：提问卡别再摊开全文 —— 只留判定总览那 5 行）。
 *
 * 全文（逐条判据 + 未通过项与修法 + 产物清单）改走**侧边栏**：由 `office.saveSignReview`
 * 落盘到 `.sdo/reviews/`（顺带成为"用户签字时看到过什么"的审计件），客户端半再经只读通道取。
 * 两处用的是**同一个** `metaLines`，所以摘要永远不会和全文的总览对不上。
 */
export function renderSignReviewSummary(doc: SignReviewDoc): string {
  return `${metaLines(doc).join('\n')}\n`
}

/** 渲染审核单。返回的 Markdown **首行必须是 `# ` 标题**（客户端用它当侧边栏标签页标题）。 */
export function renderSignReviewDoc(doc: SignReviewDoc): string {
  const lines: string[] = []
  lines.push(fmt('uiSignReview.title', { p1: doc.gateText }))
  lines.push('')
  lines.push(...metaLines(doc))
  lines.push('')

  if (doc.unjudged || doc.criteria.length === 0) {
    lines.push(t('uiSignReview.unjudged'))
  } else {
    lines.push(t('uiSignReview.criteriaHeading'))
    lines.push('')
    lines.push(`| ${t('uiSignReview.colResult')} | ${t('uiSignReview.colId')} | ${t('uiSignReview.colReq')} | ${t('uiSignReview.colActual')} |`)
    lines.push('| --- | --- | --- | --- |')
    for (const row of doc.criteria) {
      lines.push(`| ${markerOf(row)} | ${cell(row.id)} | ${cell(row.desc)} | ${cell(row.detail)} |`)
    }
    lines.push('')

    lines.push(t('uiSignReview.failedHeading'))
    lines.push('')
    if (signReviewCounts(doc).failed === 0) {
      lines.push(t('uiSignReview.noFailures'))
    } else {
      for (const row of doc.criteria.filter((item) => !item.ok && !item.na)) {
        lines.push(fmt('uiSignReview.failedItem', { p1: row.id, p2: row.desc }))
        if (row.detail !== '') lines.push(fmt('uiSignReview.failedActual', { p1: row.detail }))
        if (row.remedy !== '') lines.push(fmt('uiSignReview.failedRemedy', { p1: row.remedy }))
      }
    }
    for (const row of doc.criteria) {
      for (const warning of row.warnings) lines.push(fmt('uiSignReview.warningItem', { p1: row.id, p2: warning }))
    }
    lines.push('')
  }

  lines.push(t('uiSignReview.artifactHeading'))
  lines.push('')
  if (doc.artifacts.length === 0) {
    lines.push(t('uiSignReview.noArtifacts'))
  } else {
    lines.push(`| ${t('uiSignReview.colArtifact')} | ${t('uiSignReview.colState')} | ${t('uiSignReview.colBytes')} |`)
    lines.push('| --- | --- | --- |')
    for (const item of doc.artifacts) {
      const state = item.exists ? t('uiSignReview.artifactExists') : t('uiSignReview.artifactMissing')
      lines.push(`| \`${cell(item.path)}\` | ${state} | ${item.exists ? String(item.bytes) : '—'} |`)
    }
  }
  lines.push('')

  // ③ 受审载荷（方案 3）：逐条内联真源正文，每条带源路径与指纹
  lines.push(t('uiSignPayload.heading'))
  lines.push('')
  lines.push(t('uiSignPayload.intro'))
  lines.push('')
  if (doc.payload.length === 0) {
    lines.push(t('uiSignPayload.none'))
    lines.push('')
  }
  for (const section of doc.payload) {
    lines.push(
      fmt('uiSignPayload.section', {
        p1: t(`uiSignPayload.col_${section.collection}`),
        p2: String(section.items.length),
      }),
    )
    lines.push('')
    if (section.items.length === 0) {
      lines.push(t('uiSignPayload.none'))
      lines.push('')
      continue
    }
    for (const item of section.items) {
      lines.push(`#### ${item.id}`)
      lines.push('')
      lines.push(fmt('uiSignPayload.source', { p1: item.path }))
      lines.push(fmt('uiSignPayload.itemHash', { p1: item.hash }))
      lines.push(...renderTruth(item.content, ''))
      lines.push('')
    }
  }

  // ④ 指纹与失效规则（签字前会机械核对，不一致即拒签）
  lines.push(t('uiSignPayload.fingerprintHeading'))
  lines.push('')
  lines.push(fmt('uiSignPayload.fingerprintLine', { p1: doc.fingerprint, p2: String(doc.seq) }))
  lines.push(
    fmt('uiSignPayload.fingerprintScope', {
      p1: doc.payload.map((section) => section.collection).join(' / ') || '—',
    }),
  )
  lines.push(t('uiSignPayload.fingerprintRule'))

  return `${lines.join('\n').replace(/\n+$/u, '')}\n`
}
