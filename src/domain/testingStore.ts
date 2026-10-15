/**
 * **测试域真源**（`.sdo/testing/`）：七类真源的读写、指纹与过期判定。
 *
 * 设计对应：**DES-031**（数据视图的「测试真源」元素）—— 真源清单与职责就是它给定的：
 *
 * | 类 | 真源文件 | 承载的需求 |
 * |---|---|---|
 * | `profile` | `.sdo/testing/profile.yml` | REQ-045 验证阶段方法包（四包 + 未知包 N/A + 探索式只登记） |
 * | `plan` | `.sdo/testing/plan.yml` | REQ-047 计划与计划评审 / REQ-050 准出准则 |
 * | `design` | `.sdo/testing/design.yml` + `design-whitebox.yml` | REQ-048 黑盒 / REQ-056 白盒（**一类两文件**：供同一份设计规格文档渲染） |
 * | `acceptance` | `.sdo/testing/acceptance.yml` | REQ-046 验收大纲（AC → 验收项 + 判定基准） |
 * | `coverage` | `.sdo/testing/coverage.yml` | REQ-049 覆盖读数 / REQ-057 未覆盖项逐条处置 |
 * | `regression` | `.sdo/testing/regression.yml` | REQ-052 回归集与结果 |
 * | `report` | `.sdo/testing/report.yml` | REQ-051 测试总结报告真源 |
 *
 * 三类纪律（与 `.sdo/` 其它真源**同一口径**，不另造一套）：
 *   ① **真源在手改面**：`*.yml` 是给人手改的，读路径永不抛异常（`scalar.ts` 的 F-20 口径）；
 *      形状不对时**报出**而不是静默兜底。
 *   ② **指纹绑内容**：同一真源字节 ⇒ 同一指纹（换行归一化、文件按路径排序），
 *      这是"改真源 ⇒ 旧渲染判过期"（`renderStale`）唯一的比较键。
 *   ③ **写是覆盖式且幂等**：内容没变就不动盘上的字节（`changed: false`）；盘上那份**不是我们写的**
 *      （有人手改）⇒ 先留副本再覆盖，并如实回报 `handEdited`（同 `derivedDocs.ts`）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { contentHash } from './hash.js'
import { pushShapeNote } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import { recordListOf, textListOf } from '../infra/scalar.js'
import { SdoStore } from '../infra/store.js'
import { stringifyYaml } from '../infra/yaml.js'
import { JOURNAL_FILE } from '../infra/journal.js'
import type { Journal } from '../infra/journal.js'

// —————————————————————— 一、七类真源 ——————————————————————

/** 测试域的**七类**真源（`design` 一类含黑盒/白盒两个文件）。 */
export const TESTING_CLASSES = [
  'profile',
  'plan',
  'design',
  'acceptance',
  'coverage',
  'regression',
  'report',
] as const

export type TestingClass = (typeof TESTING_CLASSES)[number]

/** 派生人读文档的种类：测试计划 / 测试设计规格 / 测试总结报告（承重三份）。 */
export const TESTING_DOC_KINDS = ['plan', 'design', 'report'] as const

export type TestingDocKind = (typeof TESTING_DOC_KINDS)[number]

/** 一类真源里的**单个文件**（`design` 有两个，其余各一个）。 */
export type TestingSourceFile =
  | 'profile'
  | 'plan'
  | 'design'
  | 'design-whitebox'
  | 'acceptance'
  | 'coverage'
  | 'regression'
  | 'report'

export interface TestingSourceRef {
  class: TestingClass
  file: TestingSourceFile
  /** 相对 `.sdo/` 根的路径（正斜杠，与全仓路径键口径一致）。 */
  path: string
}

/**
 * 七类真源 → 文件清单（**唯一映射表**：读写、指纹、渲染三处都读它，避免口径分叉）。
 *
 * 顺序即指纹的计算顺序（路径排序在一次指纹里再做一次，这里只是稳定书写）。
 */
export const TESTING_SOURCE_FILES: Record<TestingClass, readonly TestingSourceRef[]> = {
  profile: [{ class: 'profile', file: 'profile', path: 'testing/profile.yml' }],
  plan: [{ class: 'plan', file: 'plan', path: 'testing/plan.yml' }],
  design: [
    { class: 'design', file: 'design', path: 'testing/design.yml' },
    { class: 'design', file: 'design-whitebox', path: 'testing/design-whitebox.yml' },
  ],
  acceptance: [{ class: 'acceptance', file: 'acceptance', path: 'testing/acceptance.yml' }],
  coverage: [{ class: 'coverage', file: 'coverage', path: 'testing/coverage.yml' }],
  regression: [{ class: 'regression', file: 'regression', path: 'testing/regression.yml' }],
  report: [{ class: 'report', file: 'report', path: 'testing/report.yml' }],
}

/** 承重三份文档 → 真源类（渲染与判据共用同一份映射）。 */
export const TESTING_DOC_KIND_OF_CLASS: Record<TestingDocKind, TestingClass> = {
  plan: 'plan',
  design: 'design',
  report: 'report',
}

/** 承重三份文档的**规范名**、真源位置与标题（渲染头按它写 `source:`，人据此知道去哪改）。 */
export const TESTING_DOC_META: Record<
  TestingDocKind,
  { relativePath: string; source: string; title: string }
> = {
  plan: {
    relativePath: 'docs/TESTPLAN.md',
    source: '.sdo/testing/plan.yml',
    title: '测试计划（Test Plan）',
  },
  design: {
    relativePath: 'docs/TESTDESIGN.md',
    source: '.sdo/testing/design.yml + design-whitebox.yml',
    title: '测试设计规格（Test Design Specification）',
  },
  report: {
    relativePath: 'docs/TESTREPORT.md',
    source: '.sdo/testing/report.yml',
    title: '测试总结报告（Test Summary Report）',
  },
}

/** 该文档的真源位置（写进渲染头的 `source:`）。 */
export function docSourceLocation(kind: TestingDocKind): string {
  return TESTING_DOC_META[kind].source
}

/** 该类真源的文件清单（只读副本语义：调用方不得就地改）。 */
export function sourceFilesOf(cls: TestingClass): readonly TestingSourceRef[] {
  return TESTING_SOURCE_FILES[cls]
}

// —————————————————————— 二、已知取值 ——————————————————————

/**
 * 验证阶段的**方法包词表**（REQ-045 的四包 + 探索式）。
 *
 * `exploratory` 在词表里但**不是**「选中即算通过证据」的包：它只登记（章程 / 时间盒 / 发现），
 * 不得计入 must 需求的通过覆盖（REQ-045 AC-187）—— 判定由门禁侧做，这里只给词表与标签。
 */
export const TESTING_PACKAGES = ['v-model', 'risk-based', 'mutation-driven', 'static-analysis', 'exploratory'] as const

export type TestingPackage = (typeof TESTING_PACKAGES)[number]

/** 黑盒设计技术的**最小必产项键**（REQ-048）。 */
export const BLACKBOX_TECHNIQUES = [
  'equivalence',
  'boundary',
  'decision-table',
  'state-transition',
  'scenario',
  'combination',
] as const

/** 白盒设计技术的**最小必产项键**（REQ-056）。 */
export const WHITEBOX_TECHNIQUES = [
  'control-flow',
  'cyclomatic',
  'basis-paths',
  'condition-combination',
  'def-use',
] as const

// **DEF-034**：覆盖读数准则的词表**只有一份定义** —— `types.ts` 的 `TESTING_COVERAGE_CRITERIA`
// （类型 `TestingCoverageCriterion`）。这里**不再**留第二份 `as const`：修前本文件另有一份
// `COVERAGE_CRITERIA`，与本文件之外的 `TESTING_COVERAGE_CRITERIA` **逐字相同**，却是**两个来源** ——
// "内容相同"不等于"同一个来源"：改一处漏一处就是漏判，而 `coverage.ts` 的注释还写着"同一个准则词表
// （`types.ts` 的 …）"、import 的却是这一份。现在消费方一律直接 import `types.ts` 那一份。

// —————————————————————— 三、双语标签 ——————————————————————

/**
 * 本模块自己带的**双语标签**（zh-CN 为基准）。
 *
 * ⚠️ **诚实说明（留给 0.1.7 的一步）**：SDO 的既有口径是"面向用户的文案一律来自
 * `src/data/lang/<locale>.yml`"，而本卡的写范围**只有** `testingStore.ts` / `testingRender.ts` /
 * `test/m43.test.ts` —— 语言包不在范围内。因此这里把标签内联成两张表（渲染与回执共用，
 * 不散落成字面量），术语即 REQ-045…057 的原文用词。**下一步（写范围外）**：把 `uiTesting.*`
 * 键补进语言包后，本表退化为键表（`t('uiTesting.…')`）。
 */
export const TESTING_ZH: Record<string, string> = {
  'doc.plan': '测试计划',
  'doc.design': '测试设计规格',
  'doc.report': '测试总结报告',
  'doc.derivedNote': '> 本文由 `.sdo/testing/` 的真源渲染生成，**禁止手改**：手改会在下次渲染前留副本，判据只认真源。',
  'col.project': '项目',
  'col.process': '流程',
  'col.phase': '阶段',
  'col.renderSeq': '渲染序号',
  'col.sourceFingerprint': '真源指纹',
  'col.source': '真源',
  'col.level': '测试层级',
  'col.levels': '层级数',
  'col.criterion': '准则',
  'col.metric': '指标',
  'col.threshold': '阈值',
  'col.scope': '范围',
  'col.measured': '实测',
  'col.verdict': '结论',
  'col.id': '编号',
  'col.title': '标题',
  'col.given': '前置',
  'col.when': '触发',
  'col.then': '期望',
  'col.baseline': '判定基准',
  'col.requirement': '需求',
  'col.useCase': '用例',
  'col.technique': '技术',
  'col.artifact': '必产项',
  'col.domainSource': '域出处',
  'col.packages': '方法包',
  'col.package': '方法包',
  'col.selected': '选中',
  'col.reason': '理由',
  'col.basis': '依据',
  'col.entry': '入口准则',
  'col.exit': '出口准则',
  'col.environment': '环境',
  'col.decisionRule': '判定基准',
  'col.coverageCriterion': '覆盖准则',
  'col.report': '报告',
  'col.command': '命令',
  'col.criteria': '准出准则',
  'col.allPass': '全部达标',
  'col.pass': '达标',
  'col.fail': '不达标',
  'col.notRun': '未跑',
  'col.residualRisk': '残余风险',
  'col.mutationKill': '变异 kill 率',
  'col.escape': '逃逸缺陷',
  'col.pending': '未达标项',
  'col.startedAt': '开始时间',
  'col.approvedBy': '批准人',
  'col.approvedAt': '批准时间',
  'col.intent': '意图',
  'col.args': '入参',
  'col.expected': '期望结果',
  'col.oracle': '判定基准',
  'col.requirementRef': '需求',
  'col.ac': '验收标准',
  'col.acceptanceItem': '验收项',
  'col.covered': '覆盖',
  'col.path': '路径',
  'col.accept': '处置',
  'col.disposition': '处置',
  'col.scopeFiles': '范围',
  'col.reason2': '理由',
  'col.result': '结果',
  'col.survived': '存活变异体',
  'col.status': '状态',
  'col.count': '条数',
  'col.metric2': '指标',
  'col.waiver': '豁免',
  'col.signature': '签字',
  'section.levels': '测试层级',
  'section.exitCriteria': '准出准则',
  'section.regressionScope': '回归范围',
  'section.project': '项目',
  'section.review': '计划评审',
  'section.acceptance': '验收大纲',
  'section.blackbox': '黑盒设计技术',
  'section.whitebox': '白盒设计技术',
  'section.coverage': '覆盖读数',
  'section.uncovered': '未覆盖项处置',
  'section.mutation': '变异读数',
  'section.regression': '回归',
  'section.exitVerdict': '准出准则逐条结论',
  'section.residual': '残余风险与逃逸',
  'section.signature': '报告签字',
  'section.summary': '结论',
  'section.acCoverage': 'AC 级覆盖',
  'section.env': '测试环境与数据',
  'section.levelsAndCriteria': '层级与准则',
  'none': '（无）',
  'na': 'N/A',
  'unselected': '未选中',
  'selected': '选中',
  'reasons.none': '（未给理由）',
  'reason.na': '未选中该包，故不适用',
  'yes': '是',
  'no': '否',
  'review.approved': '已批准',
  'review.notApproved': '未批准',
  'review.pending': '待评审',
  'mutation.killRate': 'kill 率',
  'mutation.threshold': '阈值',
  'signature.none': '（尚未签字）',
}

/** 英文对照表（键集合必须与 `TESTING_ZH` 一致；缺键回落基准语言）。 */
export const TESTING_EN: Record<string, string> = {
  'doc.plan': 'Test Plan',
  'doc.design': 'Test Design Specification',
  'doc.report': 'Test Summary Report',
  'doc.derivedNote': '> This document is rendered from the sources under `.sdo/testing/` and **must not be hand-edited**; a hand edit is snapshotted before the next render, and criteria read the sources only.',
  'col.project': 'Project',
  'col.process': 'Process',
  'col.phase': 'Phase',
  'col.renderSeq': 'Render seq',
  'col.sourceFingerprint': 'Source fingerprint',
  'col.source': 'Source',
  'col.level': 'Test level',
  'col.levels': 'Levels',
  'col.criterion': 'Criterion',
  'col.metric': 'Metric',
  'col.threshold': 'Threshold',
  'col.scope': 'Scope',
  'col.measured': 'Measured',
  'col.verdict': 'Verdict',
  'col.id': 'Id',
  'col.title': 'Title',
  'col.given': 'Given',
  'col.when': 'When',
  'col.then': 'Then',
  'col.baseline': 'Oracle',
  'col.requirement': 'Requirement',
  'col.useCase': 'Test case',
  'col.technique': 'Technique',
  'col.artifact': 'Artifact',
  'col.domainSource': 'Domain source',
  'col.packages': 'Packages',
  'col.package': 'Package',
  'col.selected': 'Selected',
  'col.reason': 'Reason',
  'col.basis': 'Basis',
  'col.entry': 'Entry criteria',
  'col.exit': 'Exit criteria',
  'col.environment': 'Environment',
  'col.decisionRule': 'Oracle',
  'col.coverageCriterion': 'Coverage criterion',
  'col.report': 'Report',
  'col.command': 'Command',
  'col.criteria': 'Exit criteria',
  'col.allPass': 'All pass',
  'col.pass': 'pass',
  'col.fail': 'fail',
  'col.notRun': 'not run',
  'col.residualRisk': 'Residual risk',
  'col.mutationKill': 'Mutation kill rate',
  'col.escape': 'Escaped defects',
  'col.pending': 'Not met',
  'col.startedAt': 'Started',
  'col.approvedBy': 'Approved by',
  'col.approvedAt': 'Approved at',
  'col.intent': 'Intent',
  'col.args': 'Arguments',
  'col.expected': 'Expected',
  'col.oracle': 'Oracle',
  'col.requirementRef': 'Requirement',
  'col.ac': 'Acceptance criterion',
  'col.acceptanceItem': 'Acceptance item',
  'col.covered': 'Covered',
  'col.path': 'Path',
  'col.accept': 'Disposition',
  'col.disposition': 'Disposition',
  'col.scopeFiles': 'Scope',
  'col.reason2': 'Reason',
  'col.result': 'Result',
  'col.survived': 'Survived mutants',
  'col.status': 'Status',
  'col.count': 'Count',
  'col.metric2': 'Metric',
  'col.waiver': 'Waiver',
  'col.signature': 'Signature',
  'section.levels': 'Test levels',
  'section.exitCriteria': 'Exit criteria',
  'section.regressionScope': 'Regression scope',
  'section.project': 'Project',
  'section.review': 'Plan review',
  'section.acceptance': 'Acceptance outline',
  'section.blackbox': 'Black-box techniques',
  'section.whitebox': 'White-box techniques',
  'section.coverage': 'Coverage readings',
  'section.uncovered': 'Uncovered items',
  'section.mutation': 'Mutation readings',
  'section.regression': 'Regression',
  'section.exitVerdict': 'Exit criteria verdicts',
  'section.residual': 'Residual risk and escapes',
  'section.signature': 'Report signature',
  'section.summary': 'Summary',
  'section.acCoverage': 'AC level coverage',
  'section.env': 'Test environment and data',
  'section.levelsAndCriteria': 'Levels and criteria',
  'none': '(none)',
  'na': 'N/A',
  'unselected': 'not selected',
  'selected': 'selected',
  'reasons.none': '(no reason given)',
  'reason.na': 'not selected, therefore N/A',
  'yes': 'yes',
  'no': 'no',
  'review.approved': 'approved',
  'review.notApproved': 'not approved',
  'review.pending': 'pending review',
  'mutation.killRate': 'kill rate',
  'mutation.threshold': 'threshold',
  'signature.none': '(not signed yet)',
}

/**
 * 取一条标签。`locale` 给出非基准语言时走对照表（缺键回落基准语言，与 i18n 同一条回退链）。
 */
export function label(key: string, locale = 'zh-CN'): string {
  if (locale !== 'zh-CN' && TESTING_EN[key] !== undefined) return TESTING_EN[key] as string
  return TESTING_ZH[key] ?? key
}

// —————————————————————— 四、读（永不抛异常） ——————————————————————

/**
 * 每类真源里**已知的容器位置**（`record` = 记录列表，`strings` = 字符串列表）。
 *
 * 为什么要有这张表：`.sdo/testing/*.yml` 是给人手写的真源，最常见的手写走样是**少写一对 `[]`**
 * （`levels: 单元` 而不是 `levels: [单元]`）。这类走样不该静默：读的时候就把形状提示收进
 * `TestingSourceRead.notes`，调用方（渲染 / 回执 / 后续门禁）据此点名到**具体字段**。
 *
 * 表只列**本类真源的必产项容器**（DES-031 的字段面）；没列到的键按普通标量处理，不产生噪声。
 */
export const TESTING_CONTAINERS: Record<TestingSourceFile, Record<string, 'record' | 'strings'>> = {
  profile: { packages: 'record' },
  plan: { levels: 'record', exitCriteria: 'record', regressionScope: 'strings' },
  design: { artifacts: 'record' },
  'design-whitebox': { artifacts: 'record' },
  acceptance: { outline: 'record' },
  coverage: { readings: 'record', uncovered: 'record' },
  regression: { impact: 'strings', cases: 'record' },
  report: { exitCriteria: 'record', coverage: 'record', uncovered: 'record', escapes: 'record' },
}

/** 一次真源读的结果：有没有写、内容、形状提示。 */
export interface TestingSourceRead<T = Record<string, unknown>> {
  class: TestingClass
  file: TestingSourceFile
  /** 相对 `.sdo/` 的路径（点名用）。 */
  path: string
  present: boolean
  /** 根键（`profile` / `plan` / `design` / …）下的对象；文件不存在或形状不可读时为 `{}`。 */
  value: T
  /** 文件存在但**解析不出对象**（手写坏了 / 根是标量或列表）。 */
  unreadable: boolean
  /** 容器位置的形状提示（F-21：`levels: x` 少写一对 `[]` 这类），由调用方决定怎么呈现。 */
  notes: FieldShapeNote[]
}

/** 该真源文件在 YAML 里的**根键**（与文件同名，`design-whitebox.yml` 的根键是 `designWhitebox`）。 */
export function rootKeyOf(file: TestingSourceFile): string {
  if (file === 'design-whitebox') return 'designWhitebox'
  return file
}

/** 读一类真源里的一个文件（**绝不抛异常**：解析失败 → `unreadable: true` + 空值）。 */
export function readTestingSource(store: SdoStore, ref: TestingSourceRef): TestingSourceRead {
  const notes: FieldShapeNote[] = []
  const base: TestingSourceRead = {
    class: ref.class,
    file: ref.file,
    path: ref.path,
    present: false,
    value: {},
    unreadable: false,
    notes,
  }
  if (!store.exists(ref.path)) return base
  base.present = true
  let raw: unknown
  try {
    raw = store.readYaml(ref.path)
  } catch {
    // YAML 子集解析不了（或根不是映射）⇒ **报出**而不是崩，也不是静默当成"没写"
    base.unreadable = true
    return base
  }
  const root = rootKeyOf(ref.file)
  const wrapped = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const body = wrapped[root]
  if (body === undefined && Object.keys(wrapped).length > 0 && wrapped[root] === undefined) {
    // 写了内容但没有根键（例如直接把字段写在顶层）：按"形状不对"报出，值仍给顶层对象（宽容读）
    pushShapeNote(notes, ref.class, ref.file, root, {
      position: 'map',
      actualType: 'missing',
      handling: 'empty',
      text: '',
    })
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    if (body !== undefined) {
      pushShapeNote(notes, ref.class, ref.file, root, {
        position: 'map',
        actualType: Array.isArray(body) ? 'array' : typeof body,
        handling: 'empty',
        text: '',
      })
    }
    // 根键形状不对时，顶层对象也不像本类的正文（`{profile: ...}` 该有的样子）——按空处理，
    // 但值退回顶层对象，让"字段直接写顶层"的手改仍能被读出来（宽容读，不静默）
    base.value = body === undefined ? wrapped : {}
    return base
  }
  base.value = body as Record<string, unknown>
  // 读的时候就**报出**已知容器位置的手写走样（`levels: 单元` 少写一对 `[]`）——
  // 与 F-21 同口径：能读回（按单元素列表）但必须点名到具体字段，不静默。
  for (const [key, kind] of Object.entries(TESTING_CONTAINERS[ref.file])) {
    const value = base.value[key]
    if (value === undefined) continue
    const read = kind === 'record' ? recordListOf<Record<string, unknown>>(value, (textName) => ({ id: textName })) : textListOf(value)
    if (read.issue !== undefined) pushShapeNote(notes, ref.class, ref.file, key, read.issue)
  }
  return base
}

/** 读一类真源的全部文件（顺序与 `TESTING_SOURCE_FILES` 一致）。 */
export function readTestingClass(store: SdoStore, cls: TestingClass): TestingSourceRead[] {
  return TESTING_SOURCE_FILES[cls].map((ref) => readTestingSource(store, ref))
}

/** 便捷：读一个文件（按类 + 文件名）。 */
export function readTestingFile(store: SdoStore, cls: TestingClass, file: TestingSourceFile): TestingSourceRead {
  const ref = TESTING_SOURCE_FILES[cls].find((item) => item.file === file)
  if (ref === undefined) {
    return { class: cls, file, path: `testing/${file}.yml`, present: false, value: {}, unreadable: false, notes: [] }
  }
  return readTestingSource(store, ref)
}

/** 归一化换行（指纹必须对"CRLF vs LF"免疫：同一内容同一指纹）。 */
function normalized(text: string): string {
  return text.replace(/\r\n/gu, '\n')
}

/**
 * 一类真源的**内容指纹**（`sha256:<hex>`）。
 *
 * 口径：取该类每个文件（按路径排序）的**归一化内容**，与路径一起进 `contentHash` ——
 *   · 同一真源字节 ⇒ 同一指纹（幂等渲染的判定键）；
 *   · 文件不存在 ⇒ 记 `null`（于是"删了真源"也会改指纹，不会与"空真源"混同）；
 *   · 只看内容，不看 mtime / 字节数：换行与键序的变化不该改指纹（`hash.ts` 的口径）。
 */
export function sourceFingerprintOf(store: SdoStore, cls: TestingClass): string {
  const entries: Record<string, string | null> = {}
  for (const ref of [...TESTING_SOURCE_FILES[cls]].sort((a, b) => a.path.localeCompare(b.path))) {
    const text = store.readText(ref.path)
    entries[ref.path] = text === undefined ? null : normalized(text)
  }
  return contentHash(entries)
}

/** 承重三份文档对应的真源指纹（`design` 文档取黑盒 + 白盒两个文件的合并指纹）。 */
export function docSourceFingerprint(store: SdoStore, kind: TestingDocKind): string {
  return sourceFingerprintOf(store, TESTING_DOC_KIND_OF_CLASS[kind])
}

/** 便利：**根键级字符串列表**的宽容读法（`textListOf` + 形状提示；`id` 是提示里点名的实体）。 */
export function stringListOf(
  key: string,
  value: unknown,
  notes: FieldShapeNote[],
  id: string,
): string[] {
  const read = textListOf(value)
  if (read.issue !== undefined) pushShapeNote(notes, 'testing', id, key, read.issue)
  return read.value
}

/**
 * 便利：读**记录列表**（形如 `- id: …`）的宽容口径：
 *   · 数组 → 只收映射项；   · 标量 → 按"整条只有名字"收一条；   · 形状不对 → 空 + 提示。
 */
export function recordListOfKey(
  key: string,
  value: unknown,
  notes: FieldShapeNote[],
  id: string,
): Record<string, unknown>[] {
  const read = recordListOf<Record<string, unknown>>(value, (text) => ({ id: text }))
  if (read.issue !== undefined) pushShapeNote(notes, 'testing', id, key, read.issue)
  return read.value
}

// —————————————————————— 五、journal 序号 ——————————————————————

/** 盘上**所有**可解析事件里最大的 `seq`（与 `Journal.maxSeqOnDisk` 同口径：坏行也扫它的 seq）。 */
export function journalSeqOnDisk(store: SdoStore): number {
  const text = store.readText(JOURNAL_FILE)
  if (text === undefined) return 0
  let max = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as { seq?: unknown }
      if (typeof parsed.seq === 'number' && Number.isFinite(parsed.seq) && parsed.seq > max) max = parsed.seq
    } catch {
      const claimed = /"seq"\s*:\s*(\d+)/u.exec(trimmed)
      if (claimed !== null) {
        const value = Number(claimed[1])
        if (Number.isFinite(value) && value > max) max = value
      }
    }
  }
  return max
}

/** journal 需要的最小面（渲染只读它的序号，便于单测注入）。 */
export interface SeqSource {
  read(): { events: { seq: number }[]; truncated: boolean; badLine?: number | undefined }
}

/**
 * 当前 journal 序号：**取盘上最大 seq**，读不到时回落到"最后一次一致前缀的长度"。
 *
 * 口径与 `Journal.maxSeqOnDisk` 一致（截断期也不许倒着走）：渲染头里的 `journal seq N`
 * 是"这份渲染绑定到哪一版真源历史"的锚点，只能单调前进。
 */
export function currentJournalSeq(store: SdoStore, journal?: SeqSource): number {
  const onDisk = journalSeqOnDisk(store)
  if (onDisk > 0) return onDisk
  return journal?.read().events.length ?? 0
}

// —————————————————————— 六、写（覆盖式 + 幂等 + 手改留副本） ——————————————————————

export interface TestingSourceWrite {
  class: TestingClass
  file: TestingSourceFile
  /** 相对 `.sdo/` 的路径。 */
  path: string
  /** 是否真的写了盘（内容与旧字节一致时 `false`：**幂等写入不动盘**）。 */
  changed: boolean
  bytes: number
  /** 写后真源的指纹（渲染头与过期判定用它）。 */
  fingerprint: string
  /** 盘上那份**不是我们写的**（有人手改，已先留副本）。 */
  handEdited: boolean
  /** 留副本的相对 `.sdo/` 路径。 */
  snapshot?: string
}

/**
 * 相对 `.sdo/` 根的路径（`testing/profile.yml`）→ 工作区绝对路径。
 *
 * ⚠️ 只用于**根内**路径。`docs/TESTPLAN.md` 这类路径是相对**工作区**的 ——
 * `SdoStore` 的根是 `.sdo/`，把它交给 `store.path()` 会写成 `.sdo/docs/…`（实测踩过）。
 */
function workspacePathOf(store: SdoStore, path: string): string {
  return join(store.root, ...path.split('/'))
}

/** 相对**工作区**的路径（`docs/TESTPLAN.md`）→ 绝对路径。 */
function rootPathOf(store: SdoStore, relative: string): string {
  return join(store.root, '..', ...relative.split('/'))
}

/**
 * 写一个测试域真源文件。
 *
 * 三条语义（都有单测覆盖）：
 *   ① **幂等**：内容与盘上字节一致 ⇒ 不写（`changed: false`），文件 mtime 不动；
 *   ② **手改留副本**：盘上那份与**上次渲染/写入记下的哈希**不一致 ⇒ 先留副本再覆盖
 *      （`evidence/hand-edits/<file>.<stamp>.bak`，与 `derivedDocs.ts` 同款）；
 *   ③ **指纹随写回报**：`fingerprint` 是写后该类真源的合并指纹（多文件类含另一个文件）。
 */
export function writeTestingSource(
  store: SdoStore,
  cls: TestingClass,
  file: TestingSourceFile,
  value: unknown,
  journal?: Journal,
): TestingSourceWrite {
  const ref = TESTING_SOURCE_FILES[cls].find((item) => item.file === file)
  const path = ref?.path ?? `testing/${file}.yml`
  const root = rootKeyOf(file)
  const abs = workspacePathOf(store, path)

  // ① **幂等**：先在内存里算出"该写下的字节"，与盘上那份**逐字节**比 ——
  //    一样就既不落盘也不留事件（事件是"真源被写过"的留痕，不该由无副作用的重复写产生）。
  const next = stringifyYaml({ [root]: value })
  const previous = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined

  let snapshot: string | undefined
  if (previous === next) {
    return {
      class: cls,
      file,
      path,
      changed: false,
      bytes: Buffer.byteLength(next, 'utf8'),
      fingerprint: sourceFingerprintOf(store, cls),
      handEdited: false,
    }
  }

  // ② **手改留副本**：上次写/渲染若记了哈希，就能判"盘上这份是不是我们写的"；对不上 ⇒ 先留副本
  const recorded = lastRecordedSourceHash(store, path)
  if (previous !== undefined && recorded !== undefined && sourceHashOf(previous) !== recorded) {
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
    const copyPath = ['evidence', 'hand-edits', `${file}.${stamp}.bak`]
    store.writeText(copyPath, previous)
    snapshot = copyPath.join('/')
  }

  // 落盘形状与既有真源一致：`root:` 单键包裹（`.sdo/design/component.yml` 的 `view:` 同款），
  // 走 `writeYaml`（YAML 子集 + 原子写 + 0600；与全仓其它真源同一写路径）。
  store.writeYaml([...path.split('/')], { [root]: value })

  const fingerprint = sourceFingerprintOf(store, cls)
  if (journal !== undefined) {
    // `truth/file-written` 已是一等事件（全仓口径），不新造事件种类。
    // `sourceHash` 是"我们写下的那份"的哈希：下一次写它时用来判**手改**（与 derivedDocs 同款）。
    journal.append(
      'truth/file-written',
      { path: `.sdo/${path}`, class: cls, file, sourceHash: sourceHashOf(next), fingerprint },
      'sdo',
    )
  }
  return {
    class: cls,
    file,
    path,
    changed: true,
    bytes: Buffer.byteLength(next, 'utf8'),
    fingerprint,
    handEdited: snapshot !== undefined,
    ...(snapshot === undefined ? {} : { snapshot }),
  }
}

/**
 * 文本的字节哈希（`sha256:<hex>`，先归一 CRLF/LF）。
 *
 * 口径与 `testingRender.docSha256` **完全一致** —— 两个模块一个写、一个判，
 * 必须能互相认出"这是我们写下的那份"（见 `docHandEdited` 的注释：口径不一致会假报手改）。
 */
export function sourceHashOf(text: string): string {
  return docSha256(text)
}

/** 文档正文的 sha256（`sha256:<hex>`；`derivedDocs.docHash` 同口径 —— 归一 CRLF 后取字节摘要）。 */
export function docSha256(text: string): string {
  return `sha256:${createHash('sha256').update(normalized(text), 'utf8').digest('hex')}`
}

/** 从 journal 取上一次记录的该真源哈希（读不到就 `undefined`：此时不判手改、不留副本）。 */
function lastRecordedSourceHash(store: SdoStore, path: string): string | undefined {
  try {
    const journalPath = join(store.root, JOURNAL_FILE)
    if (!existsSync(journalPath)) return undefined
    const lines = readFileSync(journalPath, 'utf8').split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (line === undefined || line.trim() === '') continue
      try {
        const event = JSON.parse(line) as { type?: string; data?: { path?: unknown; sourceHash?: unknown } }
        if (event.type !== 'truth/file-written') continue
        if (String(event.data?.path ?? '') === `.sdo/${path}` && typeof event.data?.sourceHash === 'string') {
          return event.data.sourceHash
        }
      } catch {
        /* 半写行忽略：真源可信性由 journal 读取路径负责 */
      }
    }
  } catch {
    /* 读不到 journal 就不判手改 */
  }
  return undefined
}

// —————————————————————— 七、派生文档：登记与过期判定 ——————————————————————

/** 一份派生文档**登记**（落进 journal `doc/rendered`，判定据此知道"盘上这份是不是我们写的"）。 */
export interface TestingDocRecord {
  kind: TestingDocKind
  path: string
  seq: number
  fingerprint: string
  sha256: string
}

/** 从 journal 里读承重三份文档最近一次渲染登记（没有就 `undefined`）。 */
export function lastDocRecord(store: SdoStore, kind: TestingDocKind): TestingDocRecord | undefined {
  const path = TESTING_DOC_META[kind].relativePath
  try {
    const journalPath = join(store.root, JOURNAL_FILE)
    if (!existsSync(journalPath)) return undefined
    const lines = readFileSync(journalPath, 'utf8').split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (line === undefined || line.trim() === '') continue
      try {
        const event = JSON.parse(line) as {
          type?: string
          data?: { path?: unknown; seq?: unknown; fingerprint?: unknown; sha256?: unknown }
        }
        if (event.type !== 'doc/rendered') continue
        if (String(event.data?.path ?? '') !== path) continue
        return {
          kind,
          path,
          seq: typeof event.data?.seq === 'number' ? event.data.seq : 0,
          fingerprint: String(event.data?.fingerprint ?? ''),
          sha256: String(event.data?.sha256 ?? ''),
        }
      } catch {
        /* 半写行忽略 */
      }
    }
  } catch {
    /* 读不到 journal：当作"没有登记" */
  }
  return undefined
}

/** 过期判定的结论。 */
export interface RenderStale {
  /** 需要重新渲染才能当"当前真源的渲染"。 */
  stale: boolean
  /**
   * **真源**内容指纹与登记不一致 —— 真源改了。
   *
   * ⚠️ 没有登记时**恒为 `false`**（REV-001 F4）：那时根本不存在可比对的登记指纹，
   * 该情形由 `unregistered` 表达。按这个字段渲染「真源已改，请重渲染」的调用方，
   * 因此不会在"来路不明的文档"上误报。
   */
  sourceChanged: boolean
  /**
   * 盘上有文档、但 journal 里**没有它的渲染登记** ⇒ 来路不明（REV-001 F4 新增）。
   *
   * 与 `sourceChanged` **正交**：没有登记（不知道它从哪来）≠ 真源改了（知道它从哪来、但已经对不上）。
   * 两者都判过期，但回执要说清是哪一种 —— 否则用户会去改真源，而真正该做的是删掉那份来路不明的文档并重渲染。
   */
  unregistered: boolean
  /**
   * journal 序号已前进到登记之后 —— **说明性**字段，不是过期理由（见 `renderStale` 的论证）。
   * 回执用它解释"真源历史前进过"，判据用 `sourceChanged` 定红绿。
   */
  seqAdvanced: boolean
  recordedSeq: number
  currentSeq: number
  recordedFingerprint: string
  currentFingerprint: string
  /** 盘上没有这份文档。 */
  missing: boolean
}

/**
 * **改真源 ⇒ 旧渲染判过期**（本卡 DoD 的守卫，也是 REQ-051 的「报告与真源不一致即拒绝签字」的地基）。
 *
 * 判过期只有两个理由：
 *   · `missing`：盘上没有这份文档；
 *   · `sourceChanged`：**真源内容指纹**与登记不符 —— 真源改了。
 * 没有登记（`lastDocRecord` 为空）而盘上**有**文档 ⇒ 也判过期（`stale: true`），但理由标为
 * `unregistered: true` 而**不是** `sourceChanged` —— 来路不明的文档不算"当前真源的渲染"，
 * 而"来路不明"与"真源改了"是两件事（REV-001 F4：早先这里返回 `sourceChanged: true`，
 * 与字段注释"真源内容指纹与登记不一致"自相矛盾，会让按该措辞渲染的回执误报）。
 *
 * ⚠️ **为什么不拿"序号前进"当过期理由**（设计与实现的取舍，写在这里免得后人再踩）：
 * 序号是**整个 journal** 的游标，不是本类真源的版本号 —— 任何无关事件（记一条用例结果、判一次门禁、
 * 甚至渲染另外两份承重文档）都会让它前进。若以它定红绿，则"渲染完三份文档"这一刻，前两份立刻过期，
 * 判据永远红，只能靠反复重渲染去追一个与真源无关的数字（**假红**，与 P-15 的"阶段推进造成假红"同族）。
 * 因此 `seqAdvanced` 只作**说明**保留在回执里，红绿由内容指纹说了算 ——
 * 这也与 `hash.ts` 的既有口径一致：**指纹绑内容，不绑历史**。
 */
export function renderStale(store: SdoStore, kind: TestingDocKind, journal?: SeqSource): RenderStale {
  const meta = TESTING_DOC_META[kind]
  const recorded = lastDocRecord(store, kind)
  const currentFingerprint = docSourceFingerprint(store, kind)
  const currentSeq = currentJournalSeq(store, journal)
  const missing = !existsSync(rootPathOf(store, meta.relativePath))
  if (recorded === undefined) {
    return {
      // 盘上有文档却没有登记 ⇒ 过期（它不可能是"当前真源的渲染"）；盘上也没有 ⇒ 只是"没有可过期的对象"，
      // 由缺文档本身表达（`missing: true`），不再叠一个 stale
      stale: !missing,
      // 没有登记 ⇒ 没有可比对的指纹 ⇒ **不是**"真源改了"
      sourceChanged: false,
      unregistered: true,
      seqAdvanced: false,
      recordedSeq: 0,
      currentSeq,
      recordedFingerprint: '',
      currentFingerprint,
      missing,
    }
  }
  const sourceChanged = recorded.fingerprint !== currentFingerprint
  return {
    stale: missing || sourceChanged,
    sourceChanged,
    unregistered: false,
    seqAdvanced: currentSeq > recorded.seq,
    recordedSeq: recorded.seq,
    currentSeq,
    recordedFingerprint: recorded.fingerprint,
    currentFingerprint,
    missing,
  }
}

/** 便利：写派生文档前判"盘上这份是不是我们写的"（手改留副本用）。 */
export function docHandEdited(store: SdoStore, kind: TestingDocKind): boolean {
  const meta = TESTING_DOC_META[kind]
  const abs = rootPathOf(store, meta.relativePath)
  if (!existsSync(abs)) return false
  const recorded = lastDocRecord(store, kind)
  if (recorded === undefined || recorded.sha256 === '') return false
  // ⚠️ 必须用**同一个哈希口径**比：`docSha256`（归一化文本的 sha256）。实测踩过 ——
  // 早先这里用 `sourceHashOf`（走 `contentHash` 的 JSON 规范化）去比 `docSha256` 记下的值，
  // 两者**永远不等** ⇒ 每次渲染都假报"有人手改"，副本噪声会盖掉真问题。
  return docSha256(readFileSync(abs, 'utf8')) !== recorded.sha256
}
