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
import { renderEntry, shortName } from './reviewView.js'
import { HASH_PREFIX, shortHash } from './hash.js'
import type { ReviewPayloadSection } from './reviewPayload.js'
import type { SdoStore } from '../infra/store.js'
import {
  TESTING_DOC_META,
  currentJournalSeq,
  docSourceFingerprint,
  lastDocRecord,
  renderStale,
} from './testingStore.js'
import { renderTestReport } from './testingRender.js'

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
 *
 * **2026-10-13 增补（REQ-044 / AC-228、AC-229，DEF-004）**：产物分**必需**与**建议**两类，
 * 并显式给出「建议名 ↔ 实际渲染名」的**对齐关系**：
 *   · `required`：判据**强制**（缺了判据就红）还是流程数据的**建议**（缺了只是提醒）；
 *   · `canonical`：这份内容在仓里的**规范渲染名/路径**（同一份文档只允许一个规范名）。
 * 为什么必须分开：历史上"建议 SDD.md、判据要 DESIGN.md"，单栏表把两者混在一起 ⇒ 签字人看到
 * 一个永远补不上的"缺失"（假缺失）。分栏 + 对齐关系 + 逐条可执行修法才是可判断的呈现。
 */
export interface SignReviewArtifact {
  /** 流程数据里声明的名字（如 `SDD.md`）。 */
  name: string
  /** 相对工作区的路径（如 `docs/SDD.md`）或"哪里都没找到"的候选路径。 */
  path: string
  exists: boolean
  /** 文件字节数（不存在时为 0）。 */
  bytes: number
  /**
   * `true` = **必需**产物（判据强制）；`false` = 流程数据里的建议产物。
   *
   * **可选**：旧记录/旧夹具里没有这一位时不冒充"建议"，渲染层按 `=== true` 认必需 ——
   * 缺字段读成 `false` 只会少一栏，不会把判据强制的产物误标成建议。
   */
  required?: boolean | undefined
  /**
   * **规范渲染名**（`DESIGN.md`）：与 `name` 不同的建议名靠它对账（DEF-004 的"假缺失"）。
   * 空/缺省 = 没有规范名可对齐（纯建议文件，如 `VISION.md`）。
   */
  canonical?: string | undefined
  /** **规范渲染路径**（`docs/DESIGN.md`）—— 同一份内容唯一允许的落点。 */
  canonicalPath?: string | undefined
  /** 缺失项的**可执行修法**（AC-229：补文件 / 把名字对齐到规范名）；缺省时渲染层给一句通用修法。 */
  remedy?: string | undefined
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
 * **规范渲染名 ↔ 落点**：这份内容在仓里唯一允许的名字与它真正被渲染到哪。
 *
 * 为什么要有它（REQ-044 / AC-228、AC-229，DEF-004）：流程数据的建议名与判据/渲染器要的名字**可以不同**
 * （历史事故：流程数据建议 `SDD.md`，而内容其实由 `docs/DESIGN.md` 承载）⇒ 审核单若只按建议名找文件，
 * 就会长期显示一个永远补不上的"缺失"。这张表让审核单能把两者**对齐**地摆出来，而不是各说各话。
 * **跨模块唯一真源**：`office.signReview` 只调 `canonicalArtifactOf`，不另抄一份映射。
 */
export const CANONICAL_ARTIFACTS: Readonly<Record<string, { path: string }>> = {
  'DESIGN.md': { path: 'docs/DESIGN.md' },
  'DECISIONS.md': { path: 'docs/DECISIONS.md' },
  'QUALITY.md': { path: 'docs/QUALITY.md' },
  'TESTREPORT.md': { path: 'docs/TESTREPORT.md' },
}

/** 某个**声明名**对应的规范产物（没有规范名时返回 `undefined` ⇒ 它只是建议文件）。 */
export function canonicalArtifactOf(name: string): { name: string; path: string } | undefined {
  const entry = CANONICAL_ARTIFACTS[name]
  return entry === undefined ? undefined : { name, path: entry.path }
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
    // **两栏（AC-228）**：必需产物（判据强制）与建议产物（流程数据里的建议）**分栏呈现** ——
    // 单栏时签字人分不出"缺了就红"与"只是建议"，历史事故正是把建议名当成判据名去补（假缺失）。
    const required = doc.artifacts.filter((item) => item.required === true)
    const suggested = doc.artifacts.filter((item) => item.required !== true)
    lines.push(t('uiSignReview.requiredHeading'))
    lines.push('')
    if (required.length === 0) {
      lines.push(t('uiSignReview.noRequiredArtifacts'))
    } else {
      lines.push(`| ${t('uiSignReview.colArtifact')} | ${t('uiSignReview.colRequired')} | ${t('uiSignReview.colState')} | ${t('uiSignReview.colBytes')} |`)
      lines.push('| --- | --- | --- | --- |')
      for (const item of required) {
        const state = item.exists ? t('uiSignReview.artifactExists') : t('uiSignReview.artifactMissing')
        lines.push(`| \`${cell(item.path)}\` | \`${cell(item.canonical ?? item.name)}\` | ${state} | ${item.exists ? String(item.bytes) : '—'} |`)
      }
    }
    lines.push('')
    lines.push(t('uiSignReview.suggestedHeading'))
    lines.push('')
    if (suggested.length === 0) {
      lines.push(t('uiSignReview.noSuggestedArtifacts'))
    } else {
      lines.push(`| ${t('uiSignReview.colArtifact')} | ${t('uiSignReview.colState')} | ${t('uiSignReview.colBytes')} |`)
      lines.push('| --- | --- | --- | --- |')
      for (const item of suggested) {
        const state = item.exists ? t('uiSignReview.artifactExists') : t('uiSignReview.artifactMissing')
        const alignment = item.canonicalPath !== undefined && item.canonicalPath !== item.path
          ? ` ${fmt('uiSignReview.artifactAlignment', { p1: item.canonical ?? '', p2: item.canonicalPath })}`
          : ''
        lines.push(`| \`${cell(item.path)}\` | ${state}（${t('uiSignReview.suggestedTag')}）${alignment} | ${item.exists ? String(item.bytes) : '—'} |`)
      }
    }
    lines.push('')
    // **对齐关系（AC-228 后半句）**：同一份文档只允许一个规范名；建议名与规范名不一致时，
    // 行里要**同时**给出两者 —— 只标一个孤立缺失会让签字人误判（DEF-004 的"假缺失"）。
    const aligned = doc.artifacts.filter((item) => item.canonicalPath !== undefined && item.canonicalPath !== '' && item.canonicalPath !== item.path)
    if (aligned.length > 0) {
      lines.push(t('uiSignReview.alignmentHeading'))
      lines.push('')
      for (const item of aligned) {
        lines.push(
          fmt('uiSignReview.alignmentItem', {
            p1: item.name,
            p2: item.path,
            p3: item.canonical ?? '',
            p4: item.canonicalPath ?? '',
            p5: item.exists ? t('uiSignReview.artifactExists') : t('uiSignReview.artifactMissing'),
          }),
        )
      }
      lines.push('')
    }
    // **AC-229**：缺失项必须给**可执行修法**（补文件 / 把名字对齐到规范名 / 重新渲染），
    // 不得只标一个「缺失」就完事 —— 签字人据此才知道下一步做什么。
    const missing = doc.artifacts.filter((item) => !item.exists)
    if (missing.length > 0) {
      lines.push(t('uiSignReview.remedyHeading'))
      lines.push('')
      for (const item of missing) {
        const remedy = (item.remedy ?? '') !== '' ? (item.remedy ?? '') : fmt('uiSignReview.artifactRemedyMissing', { p1: item.path })
        lines.push(fmt('uiSignReview.remedyItem', { p1: item.path, p2: remedy }))
      }
      lines.push('')
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
  // **代名索引**：把 `REQ-001`/`Q-0007`/`RISK-003` 这类代号解析成「代号+名称」，
  // 解决用户提的"只写 REQ-12，但没说这个需求的内容是什么"。
  const refs = new Map<string, string>()
  /**
   * **递归收代号**：`DES-006`（视图元素）、`TYPE-001`（方法产物条目）、`SCR-001`（界面页）这类
   * 都嵌在条目**内部**，只收顶层 id 的话引用它们时解析不出名称（真机症状：`- 涉及 DES-006`）。
   */
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    const id = record['id']
    if (typeof id === 'string' && id !== '') {
      const name = shortName(record)
      if (name !== '' && name !== id) refs.set(id, name)
    }
    for (const item of Object.values(record)) collect(item)
  }
  for (const section of doc.payload) {
    for (const item of section.items) {
      refs.set(item.id, shortName(item.content))
      collect(item.content)
    }
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
      // **渲染稿分支（TASK-007 / REQ-051）**：受审正文有时**不是** YAML 字段树，而是一份渲染好的
      // 文档 —— 例如测试总结报告（`renderTestReportSignable` 交出的 `docs/TESTREPORT.md` 正文）。
      // 这类条目若走 `renderEntry`，`unwrapEntry` 对字符串返回 `{}` ⇒ **正文整段消失**（已实测），
      // 用户看到"有这一段、但没有内容"，即"报告在签字面不可见"的另一种形态。
      // 故按文本原样内联：它是**已经渲染好的稿**（自带 `# ` 标题与渲染头），再套字段渲染只会把
      // Markdown 拆散；指纹与源路径仍按既有 `provenance` 口径印出来（指纹绑定口径不变）。
      if (typeof item.content === 'string') {
        lines.push(
          fmt('uiSignPayload.provenance', {
            p1: item.path,
            p2: `${HASH_PREFIX}${shortHash(item.hash)}`,
          }),
        )
        lines.push(item.content.replace(/\n+$/u, ''))
        lines.push('')
        continue
      }
      lines.push(
        ...renderEntry(
          section.collection,
          item.id,
          item.content,
          refs,
          new Set<string>(),
          fmt('uiSignPayload.provenance', {
            p1: item.path,
            p2: `${HASH_PREFIX}${shortHash(item.hash)}`,
          }),
          // **工件分派靠它**：`design/` 下有六种工件，不看路径就分不出来
          item.path,
        ),
      )
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

  // 折叠多余空行（逐条渲染会各自留空行，攒起来读着"散"）
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\n+$/u, '')}\n`
}

// —————————————————————— 测试总结报告 → 签字通道（REQ-051 / TASK-018） ——————————————————————
//
// ## 这一段补的是哪条缝
//
// `renderTestReport` / `renderStale`（`testingRender.ts` / `testingStore.ts`，TASK-001）已经交付了
// **报告本身**：真源渲染、渲染头、内容指纹、幂等写入、`改真源 ⇒ 过期`。但**交付期的签字通道看不见它**：
// 签字审核单（本模块）读的是门禁判据与受审集合，测试总结报告在此之前**从未进过签字面**
// （`grep TESTREPORT|report.yml` 在 testing 三个模块之外零命中）。于是"报告交用户签字"这件事
// 只有渲染、没有签字入口 —— 用户可能在一份**已经与真源对不上**的报告上签字。
//
// 本段就做这一件事：把测试总结报告**投影成签字面可用的形态**，并把"这份报告是不是当前真源的渲染"
// 一并交出去。三条口径**全部复用 TASK-001**，不另造：
//   · 内容指纹 = `docSourceFingerprint(store,'report')`（规范 JSON 的内容哈希，绑内容不绑历史）；
//   · 过期判定 = `renderStale(store,'report')`（`missing` / `sourceChanged` / `unregistered` 三态）；
//   · 正文 = `renderTestReport`（渲染头自带 `source:` 与 `@ journal seq N`）。
//
// ## 两个容易踩的点（写在这里免得后人再踩）
//
// ① **幂等的前提是"同一个 seq"**：渲染头里写着 `@ journal seq N`，而 seq 是**整个 journal** 的游标 ——
//    每次渲染/登记都会让它前进。因此"同源两次逐字节一致"只有在**两次都用同一个 seq** 时成立
//    （已实测：同 seq 逐字节一致；seq 变 1 则正文随之变）。所以这里默认取**登记里的那个 seq**
//    （`lastDocRecord().seq`），使"同一份真源 + 同一次登记"恒等 —— 这才是可复现的幂等口径。
// ② **没登记也算过期**（`unregistered`）：盘上有报告却查不到渲染登记 ⇒ 它不可能是"当前真源的渲染"，
//    与"真源改了"是两件事，回执必须说清是哪一种（否则用户会去改真源，而正确动作是重渲染）。

/** 测试总结报告投影到签字面的形态（数据面；展示文案由调用方与 `uiSignPayload.*` 键提供）。 */
export interface TestReportSignable {
  /** 承重三份里的 `report`。 */
  kind: 'report'
  /** 工作区相对路径（`docs/TESTREPORT.md`）。 */
  path: string
  /** 报告标题（真源元信息里的规范名，非硬编码文案）。 */
  title: string
  /** **真源内容指纹**（比较键：与本值不一致 ⇒ 报告与真源对不上，不许签）。 */
  fingerprint: string
  /** 渲染登记时的 journal 序号（渲染头的幂等口径就钉在它上）。 */
  renderSeq: number
  /** 真源是否不在盘上（没真源就没有可签的报告）。 */
  missing: boolean
  /** 真源改了（指纹与登记不符）。 */
  sourceChanged: boolean
  /** 盘上有报告却没有渲染登记 ⇒ 来路不明，同样不许签。 */
  unregistered: boolean
  /** 需要重新渲染才能作为"当前真源的渲染"被签。 */
  stale: boolean
  /**
   * 受审载荷（正文 + 机器可校验的指纹行），可直接作为 `ReviewPayloadSection` 塞进审核单。
   * 正文是**渲染头 + 元信息 + 逐条结论**的完整报告，用户签的就是它。
   */
  payload: ReviewPayloadSection
}

/** 受审集合名（与 `SignReviewRecord.collections` 的比对口径共用同一个字符串）。 */
export const TEST_REPORT_PAYLOAD_COLLECTION = 'testing/report.yml'

/**
 * 把测试总结报告投影成签字面可用的形态（纯函数；只读真源，不写盘、不留事件）。
 *
 * `renderSeq` 不给时取**登记里的序号**（幂等口径见文件内注释①）；真源没登记过就取当前序号。
 */
export function renderTestReportSignable(input: {
  store: SdoStore
  renderSeq?: number | undefined
  locale?: string | undefined
  projectName?: string | undefined
  process?: string | undefined
  phase?: string | undefined
}): TestReportSignable {
  const { store } = input
  const meta = TESTING_DOC_META.report
  const recorded = lastDocRecord(store, 'report')
  const seq = input.renderSeq ?? recorded?.seq ?? currentJournalSeq(store)
  const rendered = renderTestReport({
    store,
    seq,
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(input.projectName === undefined ? {} : { projectName: input.projectName }),
    ...(input.process === undefined ? {} : { process: input.process }),
    ...(input.phase === undefined ? {} : { phase: input.phase }),
  })
  const stale = renderStale(store, 'report')
  // `unregistered` 是 TASK-029（REV-001 F4）之后才有的字段：这里**宽松取值**，而不是 `stale.unregistered`。
  // 原因不是"怕运行时没有"，而是 `test/task001-red-baseline.test.ts` 会把本模块与一份**冻结的**
  // 修正前 `testingStore.ts` 组合成一棵树再 `tsc` —— 那份旧类型里没有这个字段，硬写属性名会让
  // 那棵树**编译不过**（TASK-029 的守卫踩过同一个坑，手法与 `test/m43.test.ts:715` 一致）。
  const unregistered = (stale as unknown as { unregistered?: boolean }).unregistered === true
  return {
    kind: 'report',
    path: meta.relativePath,
    title: meta.title,
    fingerprint: stale.currentFingerprint,
    renderSeq: seq,
    missing: stale.missing,
    sourceChanged: stale.sourceChanged,
    unregistered,
    stale: stale.stale || stale.missing,
    payload: {
      collection: TEST_REPORT_PAYLOAD_COLLECTION,
      items: [{
        collection: TEST_REPORT_PAYLOAD_COLLECTION,
        id: meta.relativePath,
        path: meta.relativePath,
        hash: docSourceFingerprint(store, 'report'),
        content: rendered,
      }],
    },
  }
}
