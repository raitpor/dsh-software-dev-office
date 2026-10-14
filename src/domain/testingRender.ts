/**
 * **测试域派生文档**（承重三份）：`.sdo/testing/` 真源 → `docs/TESTPLAN.md` /
 * `docs/TESTDESIGN.md` / `docs/TESTREPORT.md`。
 *
 * 设计对应：**DES-031** 的渲染侧，以及 REQ-047（计划）、REQ-048 + REQ-056（设计规格：黑盒与白盒
 * **并入同一份文档**，不另造第二份）、REQ-051（报告：渲染自真源、绑定真源序号）。
 *
 * 口径与 `docs/SRS.md` / `docs/DESIGN.md` / `docs/DECISIONS.md` **完全一致**（不另造一套）：
 *   ① 真源永远在 `.sdo/`：文档只是**渲染快照**，绝不反向写台账；
 *   ② 头里绑**真源位置 + journal 序号**（`<!-- source: … @ journal seq N -->`），
 *      判据据此证明"这份文档由当前真源渲染"；
 *   ③ **幂等**：同一真源 + 同一 `seq` + 同一语言 ⇒ 逐字节相同的文本（渲染是纯函数，不含时钟）；
 *   ④ 覆盖前若盘上那份**不是我们写的**（有人手改）⇒ 先留副本再覆盖，并如实回报。
 *
 * 真源改了会怎样（本卡 DoD 的守卫）：`testingStore.renderStale(store, kind)` 拿**真源内容指纹**
 * 与最近一次渲染登记比对 ⇒ 判过期；新一次渲染会带上前进后的 `seq`，于是**序号前进**这条也可观察。
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { renderHeader, renderMeta } from '../infra/render.js'
import { textOf } from '../infra/scalar.js'
import { SdoStore } from '../infra/store.js'
import type { Journal } from '../infra/journal.js'

import {
  TESTING_DOC_META,
  currentJournalSeq,
  docHandEdited,
  docSha256,
  docSourceLocation,
  docSourceFingerprint,
  label,
  readTestingClass,
  recordListOfKey,
  stringListOf,
} from './testingStore.js'
import type { TestingDocKind } from './testingStore.js'

/** 渲染输入（**纯函数**：同输入 ⇒ 同输出，不含时钟、不含环境）。 */
export interface TestingRenderInput {
  store: SdoStore
  /** 当前 journal 序号（写进渲染头；由调用方从真源历史取，见 `currentJournalSeq`）。 */
  seq: number
  /** 语言（默认基准语言 zh-CN）。 */
  locale?: string | undefined
  /** 说明性元信息（不进正文）：项目名 / 流程 / 阶段。 */
  projectName?: string | undefined
  process?: string | undefined
  phase?: string | undefined
}

// —————————————————————— 排版小工具（确定性：只依赖输入） ——————————————————————

/** 表格单元格里的 `|` 会破坏 Markdown 表格：转义掉（真源是手写的，必须防）。 */
function cell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\n/gu, ' ').trim()
}

/** 定宽表格：宽度按内容算 ⇒ 同一输入逐字节一致（渲染幂等的基本条件）。 */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const width = headers.map((_header, index) =>
    Math.max(...[headers[index] ?? '', ...rows.map((row) => row[index] ?? '')].map((text) => cell(text).length), 1),
  )
  const pad = (text: string, index: number): string => {
    const value = cell(text)
    // CJK 一个字在等宽字体里占两格：按**显示宽度**补齐才能对齐（不影响字节一致性）
    const shown = [...value].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
    return value + ' '.repeat(Math.max(0, (width[index] ?? 1) - shown))
  }
  const line = (row: readonly string[]): string => `| ${row.map((text, index) => pad(text, index)).join(' | ')} |`
  return [
    line(headers),
    `| ${width.map((size) => '-'.repeat(Math.max(3, size))).join(' | ')} |`,
    ...rows.map((row) => line(headers.map((_header, index) => row[index] ?? ''))),
  ]
}

/** 单元格取文本（YAML 值可能是 number/boolean —— 走 F-20 的字符串口径，绝不崩）。 */
function text(value: unknown): string {
  return textOf(value).trim()
}

/** 记录项里的字段（支持 `key` 与中文键，取到第一个）。 */
function field(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = text(record[key])
    if (value !== '') return value
  }
  return ''
}

/**
 * 列表项取一串文本（兼容 `a b c` 这种空格分隔的手写形态）——**只用于 ID 列表**。
 *
 * ⚠️ 不要拿它读散文：`未覆盖分支 UN-001 尚未重算` 会被空格切碎，渲染成三条互不相干的短句。
 * 散文位置用 `lineList()`（**不切空格**）。
 */
function tokens(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of list) {
    const one = text(item)
    if (one === '') continue
    // 手写时常用空格分隔（`.sdo/` 其它真源同款），逐个收下
    for (const part of one.split(/\s+/u)) if (part !== '') out.push(part)
  }
  return out
}

/** 列表项取**整行**文本（不按空格切分）：散文位置用它（名字避开各渲染函数里的行缓冲 `lines`）。 */
function lineList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of list) {
    const one = text(item)
    if (one !== '') out.push(one)
  }
  return out
}

function section(lines: string[], index: number, key: string, locale: string): void {
  lines.push(`## ${index}. ${label(key, locale)}`)
  lines.push('')
}

function pair(lines: string[], key: string, value: string, locale: string): void {
  lines.push(`- ${label(key, locale)}：${value === '' ? label('none', locale) : value}`)
}

// —————————————————————— 通用头 ——————————————————————

function header(kind: TestingDocKind, input: TestingRenderInput): string[] {
  const locale = input.locale ?? 'zh-CN'
  const meta = TESTING_DOC_META[kind]
  return [
    renderHeader(docSourceLocation(kind), input.seq),
    renderMeta(locale, input.phase ?? ''),
    '',
    `# ${label(`doc.${kind}`, locale)}　${meta.title}`,
    '',
    label('doc.derivedNote', locale),
    '',
  ]
}

/** 正文公共的元信息段（**真源驱动**：项目/流程/阶段只是说明，不进指纹比较）。 */
function metaBlock(kind: TestingDocKind, input: TestingRenderInput, count: { key: string; value: string }[]): string[] {
  const locale = input.locale ?? 'zh-CN'
  const lines: string[] = []
  pair(lines, 'col.project', input.projectName ?? label('none', locale), locale)
  pair(lines, 'col.process', input.process ?? label('none', locale), locale)
  pair(lines, 'col.phase', input.phase ?? label('none', locale), locale)
  pair(lines, 'col.source', docSourceLocation(kind), locale)
  pair(lines, 'col.sourceFingerprint', docSourceFingerprint(input.store, kind), locale)
  pair(lines, 'col.renderSeq', String(input.seq), locale)
  for (const item of count) pair(lines, item.key, item.value, locale)
  lines.push('')
  return lines
}

function finish(lines: string[]): string {
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').replace(/\n+$/u, '')}\n`
}

// —————————————————————— 一、测试计划（REQ-047 / REQ-050） ——————————————————————

/** 渲染 `docs/TESTPLAN.md`（真源：`.sdo/testing/plan.yml`）。 */
export function renderTestPlan(input: TestingRenderInput): string {
  const locale = input.locale ?? 'zh-CN'
  const read = readTestingClass(input.store, 'plan')[0]
  const plan = read?.value ?? {}
  const levels = recordListOfKey('levels', plan.levels, read?.notes ?? [], 'plan')
  const exitCriteria = recordListOfKey('exitCriteria', plan.exitCriteria, read?.notes ?? [], 'plan')
  const lines: string[] = []

  lines.push(...header('plan', input))
  lines.push(
    ...metaBlock('plan', input, [
      { key: 'col.levels', value: String(levels.length) },
      { key: 'col.criteria', value: String(exitCriteria.length) },
    ]),
  )
  if (read !== undefined && !read.present) {
    lines.push(`_${label('none', locale)}（.sdo/testing/plan.yml）_`)
    lines.push('')
  }

  // ① 层级与准则（REQ-047：层级划分 + 每层入口/出口准则）
  section(lines, 1, 'section.levels', locale)
  if (levels.length === 0) {
    lines.push(label('none', locale))
  } else {
    lines.push(
      ...table(
        [label('col.id', locale), label('col.level', locale), label('col.entry', locale), label('col.exit', locale), label('col.source', locale)],
        levels.map((level) => [
          field(level, 'id'),
          field(level, 'level', 'name', 'title'),
          field(level, 'entry', 'entryCriteria'),
          field(level, 'exit', 'exitCriteria'),
          field(level, 'traceability', 'source', 'refs'),
        ]),
      ),
    )
  }
  lines.push('')

  // ② 环境与数据来源
  section(lines, 2, 'section.env', locale)
  const environment = text(plan.environment)
  const dataSource = field(plan, 'data', 'dataSource', 'dataSources')
  pair(lines, 'col.environment', environment, locale)
  pair(lines, 'col.scope', dataSource, locale)
  lines.push('')

  // ③ 回归范围（REQ-052 的范围声明落在这里）
  //
  // ⚠️ 用 `lineList()` 而**不是** `tokens()`（REV-001 F3）：这一节是**散文位置** ——
  // `.sdo/testing/plan.yml` 是给人手写的真源，手写一句「回归到 REQ-045 与 REQ-051 这两条需求的用例」
  // 若按空白切分，会被渲成 5 条互不相干的短条目（实测）。`tokens()` 只留给 ID 列表位置。
  section(lines, 3, 'section.regressionScope', locale)
  const regressionScope = lineList(plan.regressionScope ?? plan.regression)
  if (regressionScope.length === 0) {
    lines.push(`- ${label('none', locale)}`)
  } else {
    for (const item of regressionScope) lines.push(`- ${item}`)
  }
  lines.push('')

  // ④ 准出准则（REQ-050：逐条现算，禁止加权）
  section(lines, 4, 'section.exitCriteria', locale)
  if (exitCriteria.length === 0) {
    lines.push(`- ${label('none', locale)}`)
  } else {
    lines.push(
      ...table(
        [label('col.id', locale), label('col.criterion', locale), label('col.metric', locale), label('col.threshold', locale), label('col.scope', locale)],
        exitCriteria.map((criterion) => [
          field(criterion, 'id'),
          field(criterion, 'criterion', 'title'),
          field(criterion, 'metric', 'indicator'),
          field(criterion, 'threshold', 'target'),
          field(criterion, 'scope', 'range'),
        ]),
      ),
    )
  }
  lines.push('')

  // ⑤ 计划评审（REQ-047：批准后才开始测试阶段；无通道时阻塞并留痕）
  section(lines, 5, 'section.review', locale)
  const review = plan.review !== null && typeof plan.review === 'object' ? (plan.review as Record<string, unknown>) : {}
  const reviewStatus = text(review.status)
  pair(
    lines,
    'col.status',
    reviewStatus === 'approved'
      ? label('review.approved', locale)
      : reviewStatus === ''
        ? label('review.pending', locale)
        : reviewStatus,
    locale,
  )
  pair(lines, 'col.approvedBy', text(review.by), locale)
  pair(lines, 'col.approvedAt', text(review.at), locale)
  lines.push('')

  return finish(lines)
}

// —————————————————————— 二、测试设计规格（REQ-048 黑盒 + REQ-056 白盒） ——————————————————————

/** 渲染 `docs/TESTDESIGN.md`（真源：`design.yml` + `design-whitebox.yml`）。 */
export function renderTestDesign(input: TestingRenderInput): string {
  const locale = input.locale ?? 'zh-CN'
  const sources = readTestingClass(input.store, 'design')
  const black = sources.find((item) => item.file === 'design')
  const white = sources.find((item) => item.file === 'design-whitebox')
  const artifacts = recordListOfKey('artifacts', black?.value.artifacts, black?.notes ?? [], 'design')
  const whiteArtifacts = recordListOfKey('artifacts', white?.value.artifacts, white?.notes ?? [], 'design-whitebox')
  const lines: string[] = []

  lines.push(...header('design', input))
  lines.push(
    ...metaBlock('design', input, [
      { key: 'col.technique', value: String(artifacts.length) },
      { key: 'col.artifact', value: String(whiteArtifacts.length) },
    ]),
  )

  // ① 黑盒技术的最小必产项（REQ-048）：每条必产项都要**被至少一条用例反向引用**、域能指到出处
  section(lines, 1, 'section.blackbox', locale)
  if (artifacts.length === 0) {
    lines.push(label('none', locale))
  } else {
    lines.push(
      ...table(
        [
          label('col.id', locale),
          label('col.technique', locale),
          label('col.artifact', locale),
          label('col.requirementRef', locale),
          label('col.domainSource', locale),
          label('col.useCase', locale),
        ],
        artifacts.map((artifact) => [
          field(artifact, 'id'),
          field(artifact, 'technique'),
          field(artifact, 'artifact', 'title'),
          tokens(artifact.requirementRef ?? artifact.requirement ?? artifact.refs).join(' '),
          field(artifact, 'domainSource', 'domain'),
          tokens(artifact.useCases ?? artifact.cases ?? artifact.testCases).join(' '),
        ]),
      ),
    )
  }
  lines.push('')

  // ② 白盒技术的最小必产项（REQ-056）：结构元素要能核对到真实代码出处
  section(lines, 2, 'section.whitebox', locale)
  if (whiteArtifacts.length === 0) {
    lines.push(label('none', locale))
  } else {
    lines.push(
      ...table(
        [
          label('col.id', locale),
          label('col.technique', locale),
          label('col.artifact', locale),
          label('col.source', locale),
          label('col.baseline', locale),
          label('col.useCase', locale),
        ],
        whiteArtifacts.map((artifact) => [
          field(artifact, 'id'),
          field(artifact, 'technique'),
          field(artifact, 'artifact', 'title'),
          field(artifact, 'function', 'element', 'source'),
          field(artifact, 'branch', 'condition', 'variable', 'complexity', 'metric'),
          tokens(artifact.useCases ?? artifact.cases ?? artifact.testCases).join(' '),
        ]),
      ),
    )
  }
  lines.push('')

  return finish(lines)
}

// —————————————————————— 三、测试总结报告（REQ-049 / REQ-050 / REQ-051 / REQ-055 / REQ-057） ——————————————————————

/** 渲染 `docs/TESTREPORT.md`（真源：`.sdo/testing/report.yml`）。 */
export function renderTestReport(input: TestingRenderInput): string {
  const locale = input.locale ?? 'zh-CN'
  const read = readTestingClass(input.store, 'report')[0]
  const report = read?.value ?? {}
  const criteria = recordListOfKey('exitCriteria', report.exitCriteria, read?.notes ?? [], 'report')
  const coverage = recordListOfKey('coverage', report.coverage, read?.notes ?? [], 'report')
  const uncovered = recordListOfKey('uncovered', report.uncovered, read?.notes ?? [], 'report')
  const lines: string[] = []

  lines.push(...header('report', input))
  const allPass = criteria.length > 0 && criteria.every((criterion) => text(criterion.verdict) === 'pass')
  lines.push(
    ...metaBlock('report', input, [
      { key: 'col.criteria', value: String(criteria.length) },
      { key: 'col.allPass', value: criteria.length === 0 ? label('na', locale) : allPass ? label('yes', locale) : label('no', locale) },
      { key: 'col.mutationKill', value: field(report, 'mutationKillRate', 'mutationKill') },
    ]),
  )

  // ① 准出准则逐条结论（REQ-050：逐条现算，禁止取平均/加权/多数达标）
  section(lines, 1, 'section.exitVerdict', locale)
  if (criteria.length === 0) {
    lines.push(`- ${label('none', locale)}`)
  } else {
    lines.push(
      ...table(
        [label('col.id', locale), label('col.criterion', locale), label('col.threshold', locale), label('col.measured', locale), label('col.verdict', locale)],
        criteria.map((criterion) => [
          field(criterion, 'id'),
          field(criterion, 'criterion', 'title'),
          field(criterion, 'threshold', 'target'),
          field(criterion, 'measured', 'actual'),
          field(criterion, 'verdict', 'result') || label('col.notRun', locale),
        ]),
      ),
    )
  }
  lines.push('')

  // ② 覆盖读数（REQ-049：准则 / 阈值 / 实测 / 工具与命令 / 报告路径与哈希 / 被测产物哈希）
  section(lines, 2, 'section.coverage', locale)
  if (coverage.length === 0) {
    lines.push(`- ${label('none', locale)}`)
  } else {
    lines.push(
      ...table(
        [
          label('col.id', locale),
          label('col.coverageCriterion', locale),
          label('col.threshold', locale),
          label('col.measured', locale),
          label('col.command', locale),
          label('col.report', locale),
          label('col.artifact', locale),
        ],
        coverage.map((reading) => [
          field(reading, 'id'),
          field(reading, 'criterion'),
          field(reading, 'threshold', 'target'),
          field(reading, 'measured', 'actual'),
          field(reading, 'command', 'cmd'),
          field(reading, 'report', 'reportPath'),
          field(reading, 'artifact', 'target', 'artifactHash'),
        ]),
      ),
    )
  }
  lines.push('')

  // ③ 未覆盖项逐条处置（REQ-057：补用例 / 不可达 / 等价，均须理由）
  section(lines, 3, 'section.uncovered', locale)
  if (uncovered.length === 0) {
    lines.push(`- ${label('none', locale)}`)
  } else {
    lines.push(
      ...table(
        [label('col.id', locale), label('col.path', locale), label('col.disposition', locale), label('col.useCase', locale), label('col.reason', locale)],
        uncovered.map((item) => [
          field(item, 'id'),
          field(item, 'item', 'branch', 'path'),
          field(item, 'disposition', 'handling', 'action'),
          field(item, 'useCase', 'case'),
          field(item, 'reason', 'why'),
        ]),
      ),
    )
  }
  lines.push('')

  // ④ 变异读数（REQ-055：复用实现侧记录 + 存活变异体逐条处置）
  section(lines, 4, 'section.mutation', locale)
  const mutation = report.mutation !== null && typeof report.mutation === 'object' ? (report.mutation as Record<string, unknown>) : {}
  pair(lines, 'mutation.killRate', text(mutation.killRate), locale)
  pair(lines, 'mutation.threshold', text(mutation.threshold), locale)
  pair(lines, 'col.report', text(mutation.record ?? mutation.path), locale)
  const survived = recordListOfKey('survived', mutation.survived, read?.notes ?? [], 'mutation')
  if (survived.length === 0) {
    lines.push(`- ${label('col.survived', locale)}：${label('none', locale)}`)
  } else {
    lines.push('')
    lines.push(
      ...table(
        [label('col.id', locale), label('col.disposition', locale), label('col.useCase', locale), label('col.reason', locale)],
        survived.map((item) => [
          field(item, 'id', 'mutant'),
          field(item, 'disposition', 'handling', 'action'),
          field(item, 'useCase', 'case'),
          field(item, 'reason', 'why'),
        ]),
      ),
    )
  }
  lines.push('')

  // ⑤ 回归（REQ-052：影响面推导出的回归集与结果，结果绑产物哈希）
  section(lines, 5, 'section.regression', locale)
  const regression = readTestingClass(input.store, 'regression')[0]
  const cases = recordListOfKey('cases', regression?.value.cases, regression?.notes ?? [], 'regression')
  const impact = tokens(regression?.value.impact ?? regression?.value.impacted)
  pair(lines, 'col.scope', impact.length === 0 ? label('none', locale) : impact.join(' '), locale)
  if (cases.length === 0) {
    lines.push(`- ${label('col.useCase', locale)}：${label('none', locale)}`)
  } else {
    lines.push('')
    lines.push(
      ...table(
        [label('col.useCase', locale), label('col.result', locale), label('col.artifact', locale), label('col.command', locale)],
        cases.map((item) => [
          field(item, 'case', 'id'),
          field(item, 'result', 'status'),
          field(item, 'artifact', 'artifactHash'),
          field(item, 'command', 'cmd'),
        ]),
      ),
    )
  }
  lines.push('')

  // ⑥ 残余风险与逃逸缺陷
  section(lines, 6, 'section.residual', locale)
  const risks = lineList(report.residualRisks ?? report.residual)
  const escapes = recordListOfKey('escapes', report.escapes, read?.notes ?? [], 'report')
  if (risks.length === 0) lines.push(`- ${label('col.residualRisk', locale)}：${label('none', locale)}`)
  for (const risk of risks) lines.push(`- ${label('col.residualRisk', locale)}：${risk}`)
  if (escapes.length === 0) {
    lines.push(`- ${label('col.escape', locale)}：${label('none', locale)}`)
  } else {
    for (const escape of escapes) {
      lines.push(`- ${label('col.escape', locale)}：${field(escape, 'id')} ${field(escape, 'title', 'reason')}`.trimEnd())
    }
  }
  lines.push('')

  // ⑦ 报告签字（REQ-051：签字是验证门禁通过的必要条件；签字不改变机械判定）
  section(lines, 7, 'section.signature', locale)
  const signature = report.signature !== null && typeof report.signature === 'object' ? (report.signature as Record<string, unknown>) : {}
  pair(lines, 'col.status', text(signature.status) === '' ? label('signature.none', locale) : text(signature.status), locale)
  pair(lines, 'col.approvedBy', text(signature.by), locale)
  pair(lines, 'col.approvedAt', text(signature.at), locale)
  pair(lines, 'col.waiver', text(signature.waiver), locale)
  lines.push('')

  return finish(lines)
}

// —————————————————————— 统一入口：渲染 + 写盘 + 登记 ——————————————————————

/**
 * 文档正文的 sha256（`sha256:<hex>`，与 `derivedDocs.docHash` 同口径）。
 *
 * 实现落在 `testingStore.ts`（写与判要**同一个口径**：`docHandEdited` 拿它比对上次记下的值），
 * 这里再导出一次，方便渲染侧调用方只 import 一个模块。
 */
export { docSha256 } from './testingStore.js'

/**
 * 原子写**工作区根下**的文件（临时文件 + 同目录 rename，0600/0700）。
 *
 * 为什么不直接用 `SdoStore.writeText`：那个写入器是 **`.sdo/` 根的路径沙箱**，按设计拒绝绝对路径
 * （`docs/TESTPLAN.md` 在 `.sdo/` 之外，本就该被拒）。口径照抄 store：先写临时文件再 rename，
 * 避免半截文档被人当成证据读走。
 */
function writeDocFile(abs: string, text: string): void {
  const dir = dirname(abs)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.tmp-${process.pid}-${randomUUID()}`)
  const body = text.endsWith('\n') ? text : `${text}\n`
  writeFileSync(tmp, body, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, abs)
}

/** 按种类渲染（统一入口：判据与工具都走它，避免三处口径分叉）。 */
export function renderTestingDoc(kind: TestingDocKind, input: TestingRenderInput): string {
  if (kind === 'plan') return renderTestPlan(input)
  if (kind === 'design') return renderTestDesign(input)
  return renderTestReport(input)
}

export interface TestingDocWrite {
  kind: TestingDocKind
  path: string
  seq: number
  /** 真源内容指纹（判"改真源 ⇒ 旧渲染过期"的比较键）。 */
  fingerprint: string
  /** 渲染正文的 sha256（判"盘上这份是不是我们写的"）。 */
  sha256: string
  bytes: number
  /** 盘上那份**不是我们写的**（有人手改，已先留副本）。 */
  handEdited: boolean
  snapshot?: string
}

/**
 * 渲染 → 写盘（覆盖式）→ 登记（journal `doc/rendered`）。
 *
 * **幂等**：同一真源 + 同一 `seq` 反复调用 ⇒ 盘上字节不变（`sha256` 相同）；
 * 真源改了之后调用方传入前进的 `seq` ⇒ 渲染头里的序号与登记一起前进（可观察）。
 */
export function writeTestingDoc(
  store: SdoStore,
  kind: TestingDocKind,
  input: Omit<TestingRenderInput, 'store'> & { store?: SdoStore | undefined },
  journal?: Journal,
): TestingDocWrite {
  // 入参里重复给 `store` 也接受（调用方常把一份 `TestingRenderInput` 直接透传过来）——
  // 以**第一个参数**为准，避免两处 store 不一致时静默用错沙箱。
  const text = renderTestingDoc(kind, { ...input, store })
  const meta = TESTING_DOC_META[kind]
  // ⚠️ `docs/TESTPLAN.md` 是相对**工作区**的路径，而 `SdoStore` 的根是 `.sdo/`：
  // 交给 `store.path()` 会写成 `.sdo/docs/…`（实测踩过），因此这里自己解到工作区根上。
  const abs = join(store.root, '..', ...meta.relativePath.split('/'))
  const previous = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined
  let snapshot: string | undefined
  if (previous !== undefined && docHandEdited(store, kind)) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const file = meta.relativePath.split('/').pop() ?? 'doc.md'
    const copyPath = ['evidence', 'hand-edits', `${file}.${stamp}.bak`]
    store.writeText(copyPath, previous)
    snapshot = copyPath.join('/')
  }
  // 文档在工作区根下（不在 `.sdo/` 内）：`SdoStore` 是 **`.sdo/` 根的路径沙箱**，按设计拒绝绝对路径
  // （`SdoPathError`：所有 `.sdo/` 写入必须落在根内），因此这里用临时文件 + rename 自己落盘，
  // 权限口径与 store 一致（文件 0600、目录 0700）。写进 `.sdo/` 的只有 journal 登记与手改副本。
  writeDocFile(abs, text)
  const fingerprint = docSourceFingerprint(store, kind)
  const sha256 = docSha256(text)
  const written: TestingDocWrite = {
    kind,
    path: meta.relativePath,
    seq: input.seq,
    fingerprint,
    sha256,
    bytes: Buffer.byteLength(text, 'utf8'),
    handEdited: snapshot !== undefined,
    ...(snapshot === undefined ? {} : { snapshot }),
  }
  if (journal !== undefined) {
    // 登记进 journal：`doc/rendered` 已是一等事件（`derivedDocs` 同款），不新造事件种类。
    journal.append(
      'doc/rendered',
      {
        doc: meta.relativePath,
        path: meta.relativePath,
        kind,
        seq: input.seq,
        fingerprint,
        sha256,
      },
      'sdo',
    )
  }
  return written
}

/** 便利：取"当前应写进渲染头的序号"（工具层与单测共用）。 */
export function renderSeqFor(store: SdoStore, journal?: Journal): number {
  return currentJournalSeq(store, journal)
}

/** 便利：一行摘要（回执/报告里人读用；不进真源）。 */
export function docSummary(write: TestingDocWrite): string {
  return `${write.path}　seq=${write.seq}　${write.sha256.slice(0, 16)}　真源指纹 ${write.fingerprint.slice(0, 16)}`
}

/** 便利：把真源里的字符串列表读出来（渲染与回执共用；形状不对时报出）。 */
export function testingStringList(store: SdoStore, cls: 'plan' | 'coverage' | 'regression', key: string): string[] {
  const read = readTestingClass(store, cls)[0]
  if (read === undefined) return []
  return stringListOf(key, read.value[key], read.notes, cls)
}
