/**
 * **测试域真源形状校验**（DES-031 的数据契约，REQ-045/046/047/048/049/050/051/052/055/056/057 的落盘入口）。
 *
 * 本模块回答**一个**问题：这份 `.sdo/testing/*.yml` 是不是"能用的真源"？
 * 答"不是"时给**逐字段点名**的问题清单；答"是"时调用方才允许落盘。
 *
 * ## 三条纪律（与全仓既有口径一致，不另造一套）
 *
 * ① **fail-closed**：校验器**自己不抛异常**。读不动 / 意外抛错都收敛成 `unknown` 结论，
 *    而 `unknown` **不是** `ok` —— 落盘闸门只认 `ok`（与 REQ-041「未实现判据一律判失败」同源）。
 * ② **整次拒绝、不落半成品**：`writeValidatedTestingSet` 先校验**整组**，
 *    任一文件非法 ⇒ **一个字节都不写**（不写盘、不留事件）。这是"半成品真源比没有真源更危险"的直接推论：
 *    渲染与判据只认真源，半成品会让文档与门禁一起说谎。
 * ③ **点名到字段**：每条问题带**点号路径**（`levels[1].exit`），不是"形状不对"这种不可执行的结论。
 *
 * ## 与相邻模块的分工（免得后人重复造）
 *
 * · `testingStore.ts`（TASK-001）：读、写、内容指纹、journal 序号、渲染登记与过期判定。
 *   它**宽容**——读路径永不抛异常（F-20 口径），形状走样只报提示；
 *   本模块**严格**——它决定"这次写入算不算数"。两者是"读得下去"与"写得进去"的分界。
 * · `testingRender.ts`（TASK-001）：真源 → 承重三份文档。
 *
 * ## 本模块**不**校验什么（写明边界，免得被当成整条需求的验收）
 *
 * · **不判选得对不对**：方法包选得是否恰当、覆盖阈值定得是否合理，都属人的判断
 *   （REQ-045 降级口径原文：门禁只核"依据是否可核对"，不判选得对不对）。这里只核**能不能核对**
 *   （依据非空、阈值非空、出处非空）。
 * · **不判内容的语义**：`item` 写得够不够好、`baseline` 能不能真的判定，都超出机械可判范围。
 * · **不查产物是否存在**：`artifact` 只核哈希**形状**与"非空"；产物在不在盘上、是否过期，
 *   是 `testingStore` 的 `renderStale` 与后续判据（REQ-049 AC-198）的事。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SdoStore } from '../infra/store.js'
import { textOf } from '../infra/scalar.js'
import { stringifyYaml } from '../infra/yaml.js'
import { TRACE_KINDS } from './trace.js'
import {
  TESTING_BLACKBOX_TECHNIQUES,
  // 注意：覆盖读数的准则词表（`TESTING_COVERAGE_CRITERIA`）**不再从本文件直接引用** ——
  // 形状层不再自己判"这个词表认不认"，改由读数侧的唯一规范化入口
  // （`./coverage.js` 的 `canonicalReadingCriterion`，它再调内容层的别名表）判（TASK-053）。
  // 注意：处置词表（`TESTING_DISPOSITIONS`）**不再从本文件直接引用** —— 落盘形状不再自己判处置，
  // 改由 `./mutation.js` 的唯一校验器（它从 `types.ts` 取那一份词表）判。字面量留在这里就是第三份副本。
  TESTING_METHOD_PACKAGES,
  TESTING_REVIEW_STATUSES,
  TESTING_SOURCE_CLASSES,
  TESTING_SOURCE_FILE_KINDS,
  TESTING_VERDICTS,
  TESTING_WHITEBOX_TECHNIQUES,
} from '../types.js'
import type {
  TestingShapeIssueCode,
  TestingSourceClass,
  TestingSourceFileKind,
  TestingValidationScope,
} from '../types.js'
// **处置词表与校验器的唯一来源**（TASK-021 收口）：`uncovered` 与 `mutation.survived` 两处都不再
// 自己写枚举与 if 链，而是调用 `mutation.ts` 的 `resolveDisposition`（与 `coverage.ts` 同一个函数）。
// 形状层仍按自己的问题码（missing / enum / ref…）报 —— 码名是形状层的公共面，改它会动渲染与既有用例。
import { resolveDisposition } from './mutation.js'
import type { MutationIssue } from './mutation.js'
// **口径取值的唯一来源**（TASK-035 落点七）：`branch`→`decision` 的历史别名表只在内容层
// （`testDesignWhitebox.ts` 的 `CRITERION_ALIASES` / `canonicalCriterion`）存在一份；
// 形状层**复用这个函数**，不另写枚举、也不另写映射表 —— 否则同一份真源会在两层得到相反结论
// （REV-007：写盘收下、体检判非法枚举）。
import { WHITEBOX_COVERAGE_CRITERIA, WHITEBOX_CRITERION_LABEL, canonicalCriterion } from './testDesignWhitebox.js'
// **读数侧准则取值的唯一规范化入口**（TASK-053）：覆盖读数的形状位与判定位（`coverage.ts` 的
// `assessReading`）调的是**同一个**函数 —— 别名（`branch` → `decision`）两层一起收下，
// 非法取值两层一起拒。形状层因此不自己写枚举、也不自己写映射表：抄第二份就必然分叉
// （症状：CT-006 ③ 的示例 `criterion: 'branch'` 被落盘闸门判非法枚举）。
import { canonicalReadingCriterion, legalCoverageCriteriaText } from './coverage.js'
import {
  TESTING_SOURCE_FILES,
  currentJournalSeq,
  rootKeyOf,
  sourceFingerprintOf,
  sourceHashOf,
} from './testingStore.js'
import type { Journal } from '../infra/journal.js'

// 校验面的公共类型：调用方（工具层 / 守卫 / 后续判据）从**同一个模块**取，避免各自重新声明一份。
export type { TestingShapeIssueCode, TestingSourceClass, TestingSourceFileKind, TestingValidationScope } from '../types.js'

// —————————————————————— 一、结论的形状 ——————————————————————

/**
 * 一条**可执行**的形状问题：说什么位置、错在哪、为什么非改不可。
 *
 * `path` 用点号路径且**对数组下标显式编号**（`levels[1].exit`）：人拿着它就能在 YAML 里定位，
 * 不必先学会读代码。
 */
export interface TestingShapeIssue {
  /** 出问题的真源文件（`.sdo/testing/plan.yml`）。 */
  path: string
  /** 点号路径（空串 = 整份文件层面，例如文件不存在）。 */
  field: string
  code: TestingShapeIssueCode
  /** 面向人的说明：**这条为什么会拒**。 */
  message: string
}

/** 一次校验的结论。`outcome !== 'ok'` ⇒ 不许落盘。 */
export interface TestingShapeReport {
  scope: TestingValidationScope
  outcome: 'ok' | 'invalid' | 'unknown'
  issues: TestingShapeIssue[]
  /** 校验过的文件（相对 `.sdo/` 的路径，顺序稳定）。 */
  checked: string[]
}

/** 校验时可选提供的**交叉引用登记表**：给了就查，没给就只核格式（不凭空判红）。 */
export interface TestingShapeKnown {
  /** 已落盘的需求 id → 该需求的验收标准 id 列表。 */
  requirements?: Map<string, string[]> | undefined
  /** 已落盘的用例 id（`req-tc` 的另一端）。 */
  testCaseIds?: string[] | undefined
  /** 已落盘的设计元素 id。 */
  designIds?: string[] | undefined
}

/** 落盘闸门的输入：一条真源 + 它属于哪一类。 */
export interface TestingSourceEntry {
  class: TestingSourceClass
  file: TestingSourceFileKind
  value: unknown
}

// —————————————————————— 二、正则与基础判定 ——————————————————————

/** 编号形如 `PP-001`（两位以上大写前缀 + 3~6 位数字；与 `ids.ts` 的口径同族）。 */
const ID_RE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{3,6}$/u
const REQ_RE = /^REQ-\d{3,6}$/u
const AC_RE = /^AC-\d{3,6}$/u
/** 产物哈希：`sha256:<64 位十六进制>`（全仓口径，见 `hash.ts` 的 `HASH_PREFIX`）。 */
const HASH_RE = /^sha256:[0-9a-f]{64}$/u
/** 目录型产物的摘要形态（`hashArtifact` 对目录给 `dir:<条目数>:<12 位>`）。 */
const DIR_HASH_RE = /^dir:\d+:[0-9a-f]{12}$/u
/** 百分比或数值（覆盖读数、kill 率）。 */
const MEASURE_RE = /\d/u
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** YAML 值的类型名（与 `scalar.ts` 的 `typeNameOf` 同口径，这里只用来写清问题）。 */
function typeNameOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 集合类问题的收集器（去重：同一路径同一码只报一次，避免同义重复）。 */
class Issues {
  private readonly items: TestingShapeIssue[] = []
  private readonly seen = new Set<string>()

  constructor(private readonly file: string) {}

  add(field: string, code: TestingShapeIssueCode, message: string): void {
    const key = `${field}\u0000${code}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.items.push({ path: this.file, field, code, message })
  }

  get list(): TestingShapeIssue[] {
    // 排序稳定：先按字段路径，再按码 —— 回执与用例可以逐字比对
    return [...this.items].sort((a, b) => (a.field === b.field ? a.code.localeCompare(b.code) : a.field.localeCompare(b.field)))
  }
}

/** 该键在 YAML 里最可能想写的是"列表"（少写一对 `[]` 是最常见的手写走样）。 */
function asListField(issues: Issues, field: string, value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    issues.add(
      field,
      'type',
      `${field} 必须是列表（写成 \`- 值\` 的多行列表或 \`[值]\`），当前是 ${typeNameOf(value)}`
      + (textOf(value).trim() === '' ? '' : `（值：${textOf(value).trim()}）`),
    )
    return undefined
  }
  return value
}

/** 取一个**必填字符串**：缺失、类型不对、空串都点名字段。 */
function requiredText(issues: Issues, field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) {
    issues.add(field, 'missing', `${field} 必填（${field} 为空会让这条真源无法被渲染与判定）`)
    return undefined
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    issues.add(field, 'type', `${field} 必须是字符串，当前是 ${typeNameOf(value)}`)
    return undefined
  }
  const text = String(value).trim()
  if (text === '') {
    issues.add(field, 'empty', `${field} 不能是空串`)
    return undefined
  }
  return text
}

/** 取一个**可选字符串**：给了就必须是字符串（类型不对要报，不能静默当没写）。 */
function optionalText(issues: Issues, field: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    issues.add(field, 'type', `${field} 必须是字符串，当前是 ${typeNameOf(value)}`)
    return undefined
  }
  return String(value).trim()
}

/** 取值必须在词表里（词表来自 `types.ts`，与落盘/渲染共用一份）。 */
function enumOf(issues: Issues, field: string, value: string | undefined, allowed: readonly string[]): string | undefined {
  if (value === undefined) return undefined
  if (!allowed.includes(value)) {
    issues.add(field, 'enum', `${field} 取值必须是 ${allowed.join(' / ')} 之一，当前是「${value}」`)
  }
  return value
}

function idOf(issues: Issues, field: string, value: unknown): string | undefined {
  const text = requiredText(issues, field, value)
  if (text === undefined) return undefined
  if (!ID_RE.test(text)) issues.add(field, 'format', `${field} 必须是编号（形如 PP-001），当前是「${text}」`)
  return text
}

function reqRefOf(issues: Issues, field: string, value: unknown): string | undefined {
  const text = requiredText(issues, field, value)
  if (text === undefined) return undefined
  if (!REQ_RE.test(text)) issues.add(field, 'format', `${field} 必须是需求编号（形如 REQ-045），当前是「${text}」`)
  return text
}

function acRefOf(issues: Issues, field: string, value: unknown): string | undefined {
  const text = requiredText(issues, field, value)
  if (text === undefined) return undefined
  if (!AC_RE.test(text)) issues.add(field, 'format', `${field} 必须是验收标准编号（形如 AC-185），当前是「${text}」`)
  return text
}

function hashOf(issues: Issues, field: string, value: unknown): string | undefined {
  const text = requiredText(issues, field, value)
  if (text === undefined) return undefined
  if (!HASH_RE.test(text) && !DIR_HASH_RE.test(text)) {
    issues.add(field, 'format', `${field} 必须是产物哈希（\`sha256:<64 位十六进制>\` 或目录摘要 \`dir:<条目数>:<12 位>\`），当前是「${text}」`)
  }
  return text
}

/** 读数要有"数"：`80%` / `0.8` / `12 个` 都行，纯文字不行。 */
function measureOf(issues: Issues, field: string, value: unknown): string | undefined {
  const text = requiredText(issues, field, value)
  if (text === undefined) return undefined
  if (!MEASURE_RE.test(text)) issues.add(field, 'format', `${field} 必须含实测数值（如 \`80%\`、\`0.8\`），当前是「${text}」`)
  return text
}

/** 查交叉引用：登记表给了才查（没给就只核格式，不凭空判红）。 */
function refOf(
  issues: Issues,
  field: string,
  id: string | undefined,
  universe: readonly string[] | undefined,
  what: string,
): void {
  if (id === undefined || universe === undefined) return
  if (!universe.includes(id)) {
    issues.add(field, 'ref', `${field} 指向的 ${what}「${id}」在台账里不存在（不许把找不到出处的引用计为覆盖）`)
  }
}

/** 记录列表的公共骨架：非数组 → 点名；数组项不是映射 → 逐项点名（并跳过该项）。 */
function recordItems(issues: Issues, field: string, value: unknown): Record<string, unknown>[] | undefined {
  const list = asListField(issues, field, value)
  if (list === undefined) return undefined
  const out: Record<string, unknown>[] = []
  list.forEach((item, index) => {
    if (isRecord(item)) {
      out.push(item)
      return
    }
    issues.add(`${field}[${index}]`, 'type', `${field}[${index}] 必须是映射（\`- 键: 值\`），当前是 ${typeNameOf(item)}`)
  })
  return out
}

/**
 * **必填**记录列表：键缺失判 `missing`，空数组判 `empty`。
 *
 * 为什么要单列这一个入口：`recordItems` 对"键没写"返回 `undefined`，调用方若直接 `return`，
 * 就会把"整份真源缺了必产项"**静默放过** —— 实测踩到过（`design: {}` 被判 ok，
 * 而"没有必产项"正是这条需求最该拦的形状）。必产项位置一律走这里。
 */
function requiredRecordItems(
  issues: Issues,
  field: string,
  value: unknown,
  what: string,
): Record<string, unknown>[] | undefined {
  if (value === undefined || value === null) {
    issues.add(field, 'missing', `${field} 必填：${what}（整份真源缺了它，渲染与判据都无从下手）`)
    return undefined
  }
  const list = recordItems(issues, field, value)
  if (list !== undefined && list.length === 0) {
    issues.add(field, 'empty', `${field} 不能为空：${what}`)
  }
  return list
}

/** 编号在**本次校验内**唯一（重复编号会让"点名该条目"变得没有唯一解）。 */
function uniqueIds(issues: Issues, field: string, ids: (string | undefined)[]): void {
  const seen = new Map<string, number>()
  ids.forEach((id, index) => {
    if (id === undefined) return
    const first = seen.get(id)
    if (first === undefined) {
      seen.set(id, index)
      return
    }
    issues.add(`${field}[${index}].id`, 'dup', `${field} 里编号「${id}」重复（首次出现在第 ${first + 1} 条）：编号是点名的唯一解`)
  })
}

// —————————————————————— 三、逐类校验 ——————————————————————

/** `profile.yml`：方法包选择（REQ-045）。 */
function checkProfile(issues: Issues, value: Record<string, unknown>): void {
  const packages = requiredRecordItems(
    issues,
    'packages',
    value.packages,
    '验证阶段必须显式选出方法包（未选中的包也要逐条给 N/A 理由）',
  )
  if (packages === undefined) return
  if (packages.length === 0) return
  const ids: (string | undefined)[] = []
  packages.forEach((item, index) => {
    const field = `packages[${index}]`
    const id = requiredText(issues, `${field}.id`, item.id)
    enumOf(issues, `${field}.id`, id, TESTING_METHOD_PACKAGES)
    ids.push(id)
    if (item.selected === undefined) {
      issues.add(`${field}.selected`, 'missing', `${field}.selected 必填（true/false 明确表态；缺了它无法区分"没选"与"忘了写"）`)
    } else if (typeof item.selected !== 'boolean') {
      issues.add(`${field}.selected`, 'type', `${field}.selected 必须是 true / false（不猜 yes/no），当前是 ${typeNameOf(item.selected)}`)
    }
    // REQ-045：未选中的包一律 N/A **并给理由** ⇒ 无论选中与否都要求理由
    optionalReason(issues, `${field}.reason`, item.reason, '方法包的选择理由')
    if (item.selected === true) {
      optionalReason(issues, `${field}.basis`, item.basis, '可核对的依据（档位 / 风险条数 / 契约失败面…）')
    }
  })
  uniqueIds(issues, 'packages', ids)
  const selected = packages.filter((item) => item.selected === true)
  if (selected.length === 0) {
    issues.add('packages', 'empty', '至少要选中一个方法包：全不选等于没有测试方法论（未选中的包仍需逐条给理由）')
  }
}

/** 「有理由」的判定：缺失或空串都点名（空理由 = 没说明，不等于"不需要"）。 */
function optionalReason(issues: Issues, field: string, value: unknown, what: string): void {
  const text = optionalText(issues, field, value)
  if (text === undefined && value !== undefined && value !== null) return // 类型问题已经报过
  if (text === undefined || text === '') {
    issues.add(field, 'missing', `${field} 必填：${what} —— 没有它这条记录只是一句断言，无法核对`)
  }
}

/** `plan.yml`：层级 / 环境与数据 / 回归范围 / 准出准则 / 计划评审（REQ-047 + REQ-050）。 */
function checkPlan(issues: Issues, value: Record<string, unknown>): void {
  // ① 层级划分与每层入口/出口准则（REQ-047）
  const levels = requiredRecordItems(issues, 'levels', value.levels, '测试层级划分是测试计划的骨架')
  if (levels !== undefined) {
    const ids: (string | undefined)[] = []
    levels.forEach((item, index) => {
      const field = `levels[${index}]`
      ids.push(idOf(issues, `${field}.id`, item.id))
      requiredText(issues, `${field}.level`, item.level)
      requiredText(issues, `${field}.entry`, item.entry)
      requiredText(issues, `${field}.exit`, item.exit)
      const trace = optionalText(issues, `${field}.traceability`, item.traceability)
      enumOf(issues, `${field}.traceability`, trace, TRACE_KINDS)
    })
    uniqueIds(issues, 'levels', ids)
  }
  // ② 环境与数据来源
  optionalText(issues, 'environment', value.environment)
  optionalText(issues, 'data', value.data)
  // ③ 回归范围（REQ-052 的范围声明）
  const scope = asListField(issues, 'regressionScope', value.regressionScope)
  scope?.forEach((item, index) => {
    if (textOf(item).trim() === '') {
      issues.add(`regressionScope[${index}]`, 'empty', `regressionScope[${index}] 不能是空串（写清哪一部分要重跑）`)
    }
  })
  // ④ 准出准则（REQ-050：逐条声明，缺阈值即判红）
  const criteria = requiredRecordItems(issues, 'exitCriteria', value.exitCriteria, '测够了没有必须由流程官逐条声明')
  if (criteria !== undefined) {
    const ids: (string | undefined)[] = []
    criteria.forEach((item, index) => {
      const field = `exitCriteria[${index}]`
      ids.push(idOf(issues, `${field}.id`, item.id))
      requiredText(issues, `${field}.criterion`, item.criterion)
      optionalText(issues, `${field}.metric`, item.metric)
      requiredText(issues, `${field}.threshold`, item.threshold)
      optionalText(issues, `${field}.scope`, item.scope)
    })
    uniqueIds(issues, 'exitCriteria', ids)
  }
  // ⑤ 计划评审（REQ-047：批准 / 豁免 / 待评审三态都要留痕）
  if (value.review !== undefined) {
    if (!isRecord(value.review)) {
      issues.add('review', 'type', `review 必须是映射（\`status / by / at / note\`），当前是 ${typeNameOf(value.review)}`)
    } else {
      const status = optionalText(issues, 'review.status', value.review.status)
      enumOf(issues, 'review.status', status, TESTING_REVIEW_STATUSES)
      optionalText(issues, 'review.by', value.review.by)
      const at = optionalText(issues, 'review.at', value.review.at)
      if (at !== undefined && at !== '' && !ISO_RE.test(at)) {
        issues.add('review.at', 'format', `review.at 必须是 ISO 时间（如 2026-10-12T13:51:48.474Z），当前是「${at}」`)
      }
      optionalText(issues, 'review.note', value.review.note)
      // 批准/豁免必须有人与时间 —— 否则这是"自己批自己"或"批了但不知何时"
      if (status === 'approved' || status === 'waived') {
        requiredText(issues, 'review.by', value.review.by)
        requiredText(issues, 'review.at', value.review.at)
      }
    }
  }
}

/** `design.yml`：黑盒技术的最小必产项（REQ-048）。 */
function checkDesign(issues: Issues, value: Record<string, unknown>): void {
  const artifacts = requiredRecordItems(issues, 'artifacts', value.artifacts, '声明使用黑盒技术就必须交付其最小必产项')
  if (artifacts === undefined) return
  if (artifacts.length === 0) return
  const ids: (string | undefined)[] = []
  artifacts.forEach((item, index) => {
    const field = `artifacts[${index}]`
    ids.push(idOf(issues, `${field}.id`, item.id))
    const technique = requiredText(issues, `${field}.technique`, item.technique)
    enumOf(issues, `${field}.technique`, technique, TESTING_BLACKBOX_TECHNIQUES)
    const na = optionalText(issues, `${field}.na`, item.na)
    // 必产项本体：声明"不适用"时也要给理由（REQ-048 的降级口径）
    if (na === undefined || na === '') {
      requiredText(issues, `${field}.artifact`, item.artifact)
    } else if (textOf(item.na).trim().length < 2) {
      issues.add(`${field}.na`, 'empty', `${field}.na 要写清"为什么不适用"，不能只有一个字`)
    }
    // 域出处（不许凭空发明） + 反向引用（至少一条用例）
    optionalText(issues, `${field}.domainSource`, item.domainSource)
    const refs = asListField(issues, `${field}.requirementRef`, item.requirementRef)
    refs?.forEach((entry, refIndex) => {
      const id = reqRefOf(issues, `${field}.requirementRef[${refIndex}]`, entry)
      refOf(issues, `${field}.requirementRef[${refIndex}]`, id, KNOWN?.requirements === undefined ? undefined : [...KNOWN.requirements.keys()], '需求')
    })
    const cases = asListField(issues, `${field}.useCases`, item.useCases)
    if (na === undefined || na === '') {
      if (cases === undefined || cases.length === 0) {
        issues.add(`${field}.useCases`, 'empty', `${field}.useCases 至少要有一条用例：必产项没有被用例反向引用就等于凑数（REQ-048）`)
      }
    }
    cases?.forEach((entry, caseIndex) => {
      if (textOf(entry).trim() === '') issues.add(`${field}.useCases[${caseIndex}]`, 'empty', `${field}.useCases[${caseIndex}] 不能是空串`)
    })
  })
  uniqueIds(issues, 'artifacts', ids)
}

/**
 * 白盒必产项的**口径位**（`criterion`）—— **TASK-035 落点七：与内容层同结论**。
 *
 * 取值与归一化都**不在本模块**：调 `testDesignWhitebox.ts` 的 `canonicalCriterion`
 * （`branch` / `branch-coverage` / `decision_coverage` 是 `decision` 的历史别名，被**收下并纠正**）。
 * 形状层因此只做两件事：把"缺失/空串/类型不对"按形状层的码点名（`requiredText`），
 * 以及把"规范化函数认不出"翻成形状层的 `enum` 码（合法集合的文案取自内容层的词表与标签表）。
 *
 * 为什么必须复用而不是照抄一份枚举：别名表是**一处口径**，抄第二份就必然会在某次改动后分叉，
 * 表现为"写盘收下、体检判非法枚举"（REV-007 的原始症状）。
 */
function criterionOf(issues: Issues, field: string, value: unknown): string | undefined {
  const text = requiredText(issues, field, value)
  if (text === undefined) return undefined
  const canonical = canonicalCriterion(text)
  if (canonical === undefined) {
    issues.add(
      field,
      'enum',
      `${field} 的口径取值「${text}」不合法：合法集合是 ${legalWhiteboxCriteriaText()}`
      + '（历史别名 branch / branch-coverage / decision_coverage 会被收下并纠正成 decision —— 与内容层同一个规范化函数）',
    )
  }
  return canonical
}

/** 合法集合的点名文案（词表与标签都取自内容层，不在形状层另造一份）。 */
function legalWhiteboxCriteriaText(): string {
  return WHITEBOX_COVERAGE_CRITERIA.map((value) => `${value}（${WHITEBOX_CRITERION_LABEL[value] ?? value}）`).join(' / ')
}

/** `design-whitebox.yml`：白盒技术的最小必产项（REQ-056）。 */
function checkDesignWhitebox(issues: Issues, value: Record<string, unknown>): void {
  const artifacts = requiredRecordItems(issues, 'artifacts', value.artifacts, '声明使用白盒技术就必须交付其最小必产项')
  if (artifacts === undefined) return
  if (artifacts.length === 0) return
  const ids: (string | undefined)[] = []
  artifacts.forEach((item, index) => {
    const field = `artifacts[${index}]`
    ids.push(idOf(issues, `${field}.id`, item.id))
    const technique = requiredText(issues, `${field}.technique`, item.technique)
    enumOf(issues, `${field}.technique`, technique, TESTING_WHITEBOX_TECHNIQUES)
    // 口径位：内容层（`validateWhiteboxDesign`）同一处也在核它 —— 两层必须同结论（TASK-035 落点七）
    criterionOf(issues, `${field}.criterion`, item.criterion)
    const na = optionalText(issues, `${field}.na`, item.na)
    if (na === undefined || na === '') {
      requiredText(issues, `${field}.artifact`, item.artifact)
      // 结构元素必须能核对到真实代码出处（函数/分支/变量/复杂度至少一个）
      const anchors = ['function', 'element', 'branch', 'condition', 'variable', 'complexity'].filter(
        (key) => textOf(item[key]).trim() !== '',
      )
      if (anchors.length === 0) {
        issues.add(
          `${field}.function`,
          'missing',
          `${field} 必须给出结构元素出处（function / branch / condition / variable / complexity 至少一个）：`
          + '引用不到代码真源的必产项不许计入覆盖（REQ-056）',
        )
      }
    }
    const cases = asListField(issues, `${field}.useCases`, item.useCases)
    if (na === undefined || na === '') {
      if (cases === undefined || cases.length === 0) {
        issues.add(`${field}.useCases`, 'empty', `${field}.useCases 至少要有一条用例：独立路径与 def-use 对都必须被用例覆盖（REQ-056）`)
      }
    }
    cases?.forEach((entry, caseIndex) => {
      if (textOf(entry).trim() === '') issues.add(`${field}.useCases[${caseIndex}]`, 'empty', `${field}.useCases[${caseIndex}] 不能是空串`)
    })
  })
  uniqueIds(issues, 'artifacts', ids)
}

/** `acceptance.yml`：验收大纲（REQ-046）。 */
function checkAcceptance(issues: Issues, value: Record<string, unknown>): void {
  const outline = requiredRecordItems(
    issues,
    'outline',
    value.outline,
    '基线冻结时每条 must 需求的每条 AC 都要有验收项与其判定基准',
  )
  if (outline === undefined) return
  if (outline.length === 0) return
  const ids: (string | undefined)[] = []
  const seenAc = new Map<string, number>()
  outline.forEach((item, index) => {
    const field = `outline[${index}]`
    ids.push(idOf(issues, `${field}.id`, item.id))
    const requirement = reqRefOf(issues, `${field}.requirement`, item.requirement)
    refOf(issues, `${field}.requirement`, requirement, KNOWN?.requirements === undefined ? undefined : [...KNOWN.requirements.keys()], '需求')
    const ac = acRefOf(issues, `${field}.ac`, item.ac)
    requiredText(issues, `${field}.item`, item.item)
    requiredText(issues, `${field}.baseline`, item.baseline)
    // 验收大纲里同一条 AC 只该有一行（两行会让 G7 矩阵对不上大纲）
    if (ac !== undefined) {
      const first = seenAc.get(ac)
      if (first === undefined) seenAc.set(ac, index)
      else issues.add(`${field}.ac`, 'dup', `验收大纲里「${ac}」出现了两次（首次在第 ${first + 1} 条）：一条 AC 只允许一个验收项`)
    }
    // 交叉核对：该 AC 必须真的挂在这条需求上（REQ-046 的机械可判部分）
    if (KNOWN?.requirements !== undefined && requirement !== undefined && ac !== undefined) {
      const acs = KNOWN.requirements.get(requirement)
      if (acs !== undefined && !acs.includes(ac)) {
        issues.add(`${field}.ac`, 'ref', `${requirement} 上不存在验收标准「${ac}」（该需求有：${acs.length === 0 ? '（无）' : acs.join(' ')}）`)
      }
    }
  })
  uniqueIds(issues, 'outline', ids)
}

/**
 * 覆盖读数的一条（`coverage.yml` 与 `report.yml` 共用：同一形状不许两套口径）。
 *
 * ## 两个位各写什么（**TASK-035 落点一**：与判定侧 `coverage.ts` 统一）
 *
 * | 位 | 写什么 | 谁核它 |
 * |---|---|---|
 * | `artifact` | 被测产物**路径**（相对工作区根） | 判定侧 `coverage.ts`：`pathFingerprint(artifact)` 现算，与 `artifactHash` 比对 ⇒ 不符判 `stale` 并点名 |
 * | `artifactHash` | 被测产物**哈希** | 判定侧 `sameHash(artifactHash, 现算值)`；形状层核**写法**（`sha256:` / `dir:`） |
 * | `reportHash` | 报告内容哈希 | 判定侧 `report-hash-mismatch`；形状层核写法 |
 *
 * **旧口径（`artifact` 直接写哈希、没有 `artifactHash`）是"合法写法"**：形状层只回答
 * "哪个位写什么"，不替判定层拒收一条意思正确的读数（判定侧对它会如实归"判不动"并点名
 * `artifactHash`）。这正是 TASK-016 那句"判红一条意思完全正确的读数比接受它更糟"的落地。
 */
function checkCoverageReading(issues: Issues, field: string, item: Record<string, unknown>): void {
  idOf(issues, `${field}.id`, item.id)
  const criterion = requiredText(issues, `${field}.criterion`, item.criterion)
  // **口径位：与判定层同结论**（TASK-053）：收不收下由读数侧的规范化入口
  // （`canonicalReadingCriterion` ← 内容层唯一的别名表）说了算 —— `branch` 这类历史别名
  // **收下并纠正**成 `decision`（CT-006 ③ 的 schema 示例自己就这么写），非法取值照旧判红。
  // 形状层在这里只做一件事：把"规范化函数认不出"翻成形状层自己的码（`enum`）与合法集合文案。
  if (criterion !== undefined && canonicalReadingCriterion(criterion) === undefined) {
    issues.add(
      `${field}.criterion`,
      'enum',
      `${field}.criterion 的取值「${criterion}」不合法：合法集合是 ${legalCoverageCriteriaText()}`
      + '（历史别名 branch / branch-coverage / decision_coverage 会被收下并纠正成 decision —— 与判定层同一个规范化函数）',
    )
  }
  measureOf(issues, `${field}.measured`, item.measured)
  optionalText(issues, `${field}.threshold`, item.threshold)
  optionalText(issues, `${field}.command`, item.command)
  optionalText(issues, `${field}.report`, item.report)
  // 两个哈希位：给了就必须是哈希**写法**（在不在、对不对是判定侧的事，见本函数注释的表）
  hashIfPresent(issues, `${field}.reportHash`, item.reportHash)
  hashIfPresent(issues, `${field}.artifactHash`, item.artifactHash)
  // **`artifact` 写的是路径**：路径没有"写法"可言，形状层只保证它是一个写下来的字符串
  // （旧口径下这里曾跑 `hashOf` 把它冻结成"产物哈希"，导致判定侧已支持的路径写法被闸门拒收）。
  optionalText(issues, `${field}.artifact`, item.artifact)
}

/** **可选**哈希位：没写不判红；写了就必须是哈希写法（`sha256:<64 位>` / 目录摘要 `dir:…`）。 */
function hashIfPresent(issues: Issues, field: string, value: unknown): void {
  const text = optionalText(issues, field, value)
  if (text === undefined || text === '') return
  if (!HASH_RE.test(text) && !DIR_HASH_RE.test(text)) {
    issues.add(field, 'format', `${field} 必须是产物哈希（\`sha256:<64 位十六进制>\` 或目录摘要 \`dir:<条目数>:<12 位>\`），当前是「${text}」`)
  }
}

/**
 * 未覆盖项的一条处置（REQ-057）：三种处置各自的必填项不同。
 *
 * **判定不在本函数里**：调 `mutation.ts` 的 `resolveDisposition`（与 `coverage.ts` 的
 * `assessUncovered` 同一个函数、同一张 `DISPOSITION_RULES`）。本函数只做两件事：
 *   · 形状层的字段级校验（id 格式、item / disposition 必填、useCase 必填、reason 文案）——
 *     这些是**形状层自己的公共面**（问题码 `missing` / `empty` / `ref`），保持原样；
 *   · 把共享校验器给出的**规则级**问题翻译成形状层的码（见 `shapeIssuesOf`）。
 */
function checkUncovered(issues: Issues, field: string, item: Record<string, unknown>): void {
  idOf(issues, `${field}.id`, item.id)
  requiredText(issues, `${field}.item`, item.item)
  const disposition = requiredText(issues, `${field}.disposition`, item.disposition)
  adoptDispositionIssues(issues, resolveDisposition({
    field,
    disposition: disposition ?? '',
    useCase: optionalText(issues, `${field}.useCase`, item.useCase),
    reason: optionalText(issues, `${field}.reason`, item.reason),
    scope: 'coverage-item',
    knownCaseIds: KNOWN?.testCaseIds,
  }).issues)
  if (disposition === '补用例') {
    const useCase = requiredText(issues, `${field}.useCase`, item.useCase)
    refOf(issues, `${field}.useCase`, useCase, KNOWN?.testCaseIds, '用例')
  }
  if (disposition === '不可达' || disposition === '等价') {
    // REQ-057 降级口径：声明不可达/等价**必须**有依据，否则不算已处置（文案是形状层的）
    optionalReason(issues, `${field}.reason`, item.reason, `声明「${disposition}」的依据（没有依据的不许计为已处置）`)
  }
}

/**
 * 共享校验器的码 → **形状层**的码。
 *
 * 为什么要有这张表：形状层的码是落盘闸门与渲染的公共面（`missing` / `empty` / `type` / `enum` /
 * `ref` / `format`），既有用例与文档都按它说话；共享校验器的码是**规则**的名字
 * （`disposition-unknown` / `usecase-unknown` / `reason-missing`…）。两者不是同一层的东西，
 * 所以翻译一次，而不是把形状层的码改掉（那会动渲染与 55 条用例的断言）。
 *
 * `usecase-missing` 与 `reason-missing` 交给形状层自己报（`requiredText` / `optionalReason`），
 * 因为它们连带要给出**形状层特有**的文案与位置；这里只接规则层能判、形状层判不了的那几条。
 */
function shapeIssuesOf(list: readonly MutationIssue[]): { field: string; code: TestingShapeIssueCode; message: string }[] {
  const out: { field: string; code: TestingShapeIssueCode; message: string }[] = []
  for (const issue of list) {
    if (issue.code === 'disposition-unknown' || issue.code === 'unreachable-not-allowed') {
      // 「取值不合法」与「这一侧不开放」在形状层是同一件事：**这个值不能用在这里**
      out.push({ field: issue.field, code: 'enum', message: issue.message })
    } else if (issue.code === 'usecase-unknown') {
      // 补的用例不在登记表里 —— 形状层用 `ref`（与 `refOf` 同码）
      out.push({ field: issue.field, code: 'ref', message: issue.message })
    }
    // 其余（usecase-missing / reason-missing / reason-unnecessary）各有形状层的出口，不重复报
  }
  return out
}

/** 收下共享校验器的问题（去重交给形状层的 `Issues`）。 */
function adoptDispositionIssues(issues: Issues, list: readonly MutationIssue[]): void {
  for (const item of shapeIssuesOf(list)) issues.add(item.field, item.code, item.message)
}

/** `coverage.yml`：覆盖读数与未覆盖项处置（REQ-049 + REQ-057）。 */
function checkCoverage(issues: Issues, value: Record<string, unknown>): void {
  const readings = requiredRecordItems(issues, 'readings', value.readings, '写了覆盖真源就要有读数（没有报告的数字不算证据）')
  if (readings !== undefined) {
    const ids: (string | undefined)[] = []
    readings.forEach((item, index) => {
      const field = `readings[${index}]`
      checkCoverageReading(issues, field, item)
      ids.push(textOf(item.id).trim() === '' ? undefined : textOf(item.id).trim())
    })
    uniqueIds(issues, 'readings', ids)
  }
  const uncovered = recordItems(issues, 'uncovered', value.uncovered)
  if (uncovered !== undefined) {
    const ids: (string | undefined)[] = []
    uncovered.forEach((item, index) => {
      const field = `uncovered[${index}]`
      checkUncovered(issues, field, item)
      ids.push(textOf(item.id).trim() === '' ? undefined : textOf(item.id).trim())
    })
    uniqueIds(issues, 'uncovered', ids)
  }
}

/**
 * `regression.yml`：影响面推导出的回归集与结果（REQ-052）。
 *
 * **两个位（TASK-035 落点六）**：`artifact` 写**产物哈希**、`artifactPath` 写**产物路径** ——
 * 与判定侧 `regression.ts`（`assessRun`：`looksLikeHash(artifact)` + `pathFingerprint(artifactPath)`）
 * 同口径。缺任一位置都判红并**点名到那一个字段**（缺哈希 ⇒ `cases[i].artifact`；缺路径 ⇒
 * `cases[i].artifactPath`）—— 判定侧对"只记哈希、没有路径"的处置是 `artifact-path-missing`
 * （判不动，既不假装过期也不判绿），形状层在这里先把"写全"拦下来。
 */
function checkRegression(issues: Issues, value: Record<string, unknown>): void {
  const impact = asListField(issues, 'impact', value.impact)
  impact?.forEach((entry, index) => {
    if (textOf(entry).trim() === '') issues.add(`impact[${index}]`, 'empty', `impact[${index}] 不能是空串（影响面要逐项点名）`)
  })
  const undecidable = optionalText(issues, 'undecidable', value.undecidable)
  const cases = requiredRecordItems(issues, 'cases', value.cases, '回归集是这条纪律的正文（未跑不许声称已完成）')
  if (cases !== undefined) {
    // 影响面推不出来时必须**显式声明**（REQ-052：不许默认"无影响"）
    if ((impact === undefined || impact.length === 0) && (undecidable === undefined || undecidable === '')) {
      issues.add('impact', 'missing', 'impact 不能为空：影响面为空时必须显式声明「不可推导」并给人工确认入口（不许默认无影响）')
    }
    const ids: (string | undefined)[] = []
    cases.forEach((item, index) => {
      const field = `cases[${index}]`
      const caseId = requiredText(issues, `${field}.case`, item.case)
      refOf(issues, `${field}.case`, caseId, KNOWN?.testCaseIds, '用例')
      const result = requiredText(issues, `${field}.result`, item.result)
      enumOf(issues, `${field}.result`, result, TESTING_VERDICTS)
      // REQ-052：结果必须绑产物哈希（否则"跑过了"无法与"跑的是哪一版"对上）
      hashOf(issues, `${field}.artifact`, item.artifact)
      // **TASK-035 落点六**：产物**路径**同样是必填位 —— 只有哈希没有路径 ⇒ 不知道产物在哪，
      // "它有没有被改动"判不动（AC-208 落不了地）。两位配对，缺任一位都判红并**点名到那一位**。
      requiredText(issues, `${field}.artifactPath`, item.artifactPath)
      optionalText(issues, `${field}.command`, item.command)
      ids.push(caseId)
    })
    uniqueIds(issues, 'cases', ids)
  }
}

/** `report.yml`：测试总结报告真源（REQ-049/050/051/055/057 的汇总面）。 */
function checkReport(issues: Issues, value: Record<string, unknown>): void {
  const criteria = requiredRecordItems(issues, 'exitCriteria', value.exitCriteria, '报告要逐条给出准出准则的实测与结论')
  if (criteria !== undefined) {
    const ids: (string | undefined)[] = []
    criteria.forEach((item, index) => {
      const field = `exitCriteria[${index}]`
      ids.push(idOf(issues, `${field}.id`, item.id))
      requiredText(issues, `${field}.criterion`, item.criterion)
      optionalText(issues, `${field}.threshold`, item.threshold)
      // 实测与结论都要有：只写"达标"没有数、只写数没有结论，都不算现算过
      measureOf(issues, `${field}.measured`, item.measured)
      const verdict = requiredText(issues, `${field}.verdict`, item.verdict)
      enumOf(issues, `${field}.verdict`, verdict, TESTING_VERDICTS)
    })
    uniqueIds(issues, 'exitCriteria', ids)
  }
  const coverage = recordItems(issues, 'coverage', value.coverage)
  if (coverage !== undefined) {
    const ids: (string | undefined)[] = []
    coverage.forEach((item, index) => {
      checkCoverageReading(issues, `coverage[${index}]`, item)
      ids.push(textOf(item.id).trim() === '' ? undefined : textOf(item.id).trim())
    })
    uniqueIds(issues, 'coverage', ids)
  }
  const uncovered = recordItems(issues, 'uncovered', value.uncovered)
  if (uncovered !== undefined) {
    const ids: (string | undefined)[] = []
    uncovered.forEach((item, index) => {
      checkUncovered(issues, `uncovered[${index}]`, item)
      ids.push(textOf(item.id).trim() === '' ? undefined : textOf(item.id).trim())
    })
    uniqueIds(issues, 'uncovered', ids)
  }
  // 变异读数（REQ-055）：存活变异体必须逐条处置
  if (value.mutation !== undefined) {
    if (!isRecord(value.mutation)) {
      issues.add('mutation', 'type', `mutation 必须是映射（\`killRate / threshold / record / survived\`），当前是 ${typeNameOf(value.mutation)}`)
    } else {
      const killRate = optionalText(issues, 'mutation.killRate', value.mutation.killRate)
      if (killRate !== undefined && killRate !== '' && !MEASURE_RE.test(killRate)) {
        issues.add('mutation.killRate', 'format', `mutation.killRate 必须含数值（如 \`80%\`），当前是「${killRate}」`)
      }
      optionalText(issues, 'mutation.threshold', value.mutation.threshold)
      optionalText(issues, 'mutation.record', value.mutation.record)
      const survived = recordItems(issues, 'mutation.survived', value.mutation.survived)
      survived?.forEach((item, index) => {
        const field = `mutation.survived[${index}]`
        requiredText(issues, `${field}.id`, item.id)
        // **与未覆盖项同一套词表与同一个校验器**（TASK-021 收口）：`scope: 'surviving-mutant'`
        // 是两侧唯一的差异 —— 存活变异体不接受「不可达」（REQ-055 没有这一档；理由见
        // `mutation.ts` 的 `DISPOSITION_SCOPE_RULE`）。形状层只把它翻译成自己的码。
        const disposition = optionalText(issues, `${field}.disposition`, item.disposition)
        if (disposition === undefined || disposition === '') {
          issues.add(`${field}.disposition`, 'missing', `${field}.disposition 必填：存活变异体要么补一条能杀死它的用例，要么显式声明等价并给理由（REQ-055）`)
        } else {
          adoptDispositionIssues(issues, resolveDisposition({
            field,
            disposition,
            useCase: optionalText(issues, `${field}.useCase`, item.useCase),
            reason: optionalText(issues, `${field}.reason`, item.reason),
            scope: 'surviving-mutant',
            knownCaseIds: KNOWN?.testCaseIds,
          }).issues)
          if (disposition === '补用例') requiredText(issues, `${field}.useCase`, item.useCase)
          if (disposition === '等价') optionalReason(issues, `${field}.reason`, item.reason, '等价变异体的理由（没有理由的等价声明不算处置）')
        }
      })
    }
  }
  const risks = asListField(issues, 'residualRisks', value.residualRisks)
  risks?.forEach((entry, index) => {
    if (textOf(entry).trim() === '') issues.add(`residualRisks[${index}]`, 'empty', `residualRisks[${index}] 不能是空串（残余风险要写清是什么）`)
  })
  const escapes = recordItems(issues, 'escapes', value.escapes)
  escapes?.forEach((item, index) => {
    const field = `escapes[${index}]`
    idOf(issues, `${field}.id`, item.id)
  })
  if (value.signature !== undefined) {
    if (!isRecord(value.signature)) {
      issues.add('signature', 'type', `signature 必须是映射（\`status / by / at / waiver\`），当前是 ${typeNameOf(value.signature)}`)
    } else {
      optionalText(issues, 'signature.status', value.signature.status)
      optionalText(issues, 'signature.by', value.signature.by)
      const at = optionalText(issues, 'signature.at', value.signature.at)
      if (at !== undefined && at !== '' && !ISO_RE.test(at)) {
        issues.add('signature.at', 'format', `signature.at 必须是 ISO 时间，当前是「${at}」`)
      }
      optionalText(issues, 'signature.waiver', value.signature.waiver)
    }
  }
}

/**
 * 交叉引用登记表：**进程内**的当前校验上下文。
 *
 * 为什么用模块级变量而不是参数一路传：校验是**一次性**的落盘闸门（同步、单线程），
 * 把它显式穿过七八层 `check*` 只会让签名变噪音；但**每次入口都重置**（见 `withKnown`），
 * 因此不会跨调用泄漏。
 */
let KNOWN: TestingShapeKnown | undefined

function withKnown<T>(known: TestingShapeKnown | undefined, run: () => T): T {
  const previous = KNOWN
  KNOWN = known
  try {
    return run()
  } finally {
    KNOWN = previous
  }
}

/** 按文件类型分派到对应的校验器。 */
function checkValue(issues: Issues, file: TestingSourceFileKind, value: unknown): void {
  if (value === undefined || value === null) {
    issues.add('', 'missing', `${file} 真源不能是空的（没有内容的真源会让渲染与判据一起说谎）`)
    return
  }
  if (!isRecord(value)) {
    issues.add('', 'type', `${file} 真源的根必须是映射（\`${rootKeyOf(file)}:\` 下的键值对），当前是 ${typeNameOf(value)}`)
    return
  }
  switch (file) {
    case 'profile':
      checkProfile(issues, value)
      break
    case 'plan':
      checkPlan(issues, value)
      break
    case 'design':
      checkDesign(issues, value)
      break
    case 'design-whitebox':
      checkDesignWhitebox(issues, value)
      break
    case 'acceptance':
      checkAcceptance(issues, value)
      break
    case 'coverage':
      checkCoverage(issues, value)
      break
    case 'regression':
      checkRegression(issues, value)
      break
    case 'report':
      checkReport(issues, value)
      break
    default:
      // 到这里说明 `TestingSourceFileKind` 新增了成员却漏了分支 —— fail-closed，不静默放行
      issues.add('', 'unknown', `没有为真源类型「${file}」实现校验器（新增类型必须同时补校验，否则不许落盘）`)
  }
}

// —————————————————————— 四、三个入口 ——————————————————————

/** 该文件在校验面上的完整路径（`.sdo/testing/plan.yml`）。 */
export function shapePathOf(file: TestingSourceFileKind): string {
  const ref = TESTING_SOURCE_CLASSES.flatMap((cls) => TESTING_SOURCE_FILES[cls]).find((item) => item.file === file)
  return `.sdo/${ref?.path ?? `testing/${file}.yml`}`
}

/** 校验**一个文件**的形状（不做任何落盘）。 */
export function validateTestingSource(
  file: TestingSourceFileKind,
  value: unknown,
  known?: TestingShapeKnown,
): TestingShapeReport {
  const issues = new Issues(shapePathOf(file))
  // **fail-closed 的入口守卫**：文件种类不认识就**不猜** —— 报 `unknown` 而不是"当成某一类去校验"。
  // 实测踩过：把 `not-a-file` 当 `plan` 校验会得到 `invalid`，看着像"拦住了"，其实是**拿错了规则**；
  // 真遇到新增或拼错的文件名时，回执必须说"我没有这个种类的校验器"，而不是甩一堆不相干的字段问题。
  if (!isKnownTestingFile(file)) {
    return {
      scope: 'file',
      outcome: 'unknown',
      issues: [
        {
          path: shapePathOf(file),
          field: '',
          code: 'unknown',
          message: `没有为真源类型「${String(file)}」实现校验器（按"未判定"处理，不放行）：可用的是 ${TESTING_SOURCE_FILE_KINDS.join(' / ')}`,
        },
      ],
      checked: [shapePathOf(file)],
    }
  }
  try {
    withKnown(known, () => checkValue(issues, file, value))
  } catch (error) {
    // 校验器自己崩了：如实报 unknown（**不是** ok）——落盘闸门只认 ok
    issues.add('', 'unknown', `校验器异常（按"未判定"处理，不放行）：${error instanceof Error ? error.message : String(error)}`)
    return { scope: 'file', outcome: 'unknown', issues: issues.list, checked: [shapePathOf(file)] }
  }
  const list = issues.list
  return { scope: 'file', outcome: list.length === 0 ? 'ok' : 'invalid', issues: list, checked: [shapePathOf(file)] }
}

/** 校验**一类真源**（`design` 一类含黑盒 + 白盒两个文件）；`files` 缺省取该类全部文件。 */
export function validateTestingClass(
  cls: TestingSourceClass,
  values: Partial<Record<TestingSourceFileKind, unknown>>,
  known?: TestingShapeKnown,
): TestingShapeReport {
  const refs = TESTING_SOURCE_FILES[cls]
  const issues: TestingShapeIssue[] = []
  const checked: string[] = []
  let sawUnknown = false
  for (const ref of refs) {
    const value = values[ref.file]
    if (value === undefined) continue // 该类里没给的文件不参与本次校验（缺文件由调用方按需求判）
    const report = validateTestingSource(ref.file, value, known)
    checked.push(...report.checked)
    issues.push(...report.issues)
    if (report.outcome === 'unknown') sawUnknown = true
  }
  const outcome = issues.length === 0 ? 'ok' : sawUnknown ? 'unknown' : 'invalid'
  return { scope: 'class', outcome, issues, checked }
}

/**
 * 校验**一整组**真源（落盘前的那一道）。
 *
 * `entries` 里**没给**的文件不参与校验：本条只管"我要写的这些" —— 例如补写白盒真源时，
 * 不该因为黑盒那份还没写就把整组判红。
 */
export function validateTestingSet(entries: readonly TestingSourceEntry[], known?: TestingShapeKnown): TestingShapeReport {
  const issues: TestingShapeIssue[] = []
  const checked: string[] = []
  let sawUnknown = false
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.file)) {
      issues.push({
        path: shapePathOf(entry.file),
        field: '',
        code: 'dup',
        message: `同一组里「${entry.file}」出现了两次：后一份会静默覆盖前一份（每组每文件只允许一条）`,
      })
      continue
    }
    seen.add(entry.file)
    const report = validateTestingSource(entry.file, entry.value, known)
    checked.push(...report.checked)
    issues.push(...report.issues)
    if (report.outcome === 'unknown') sawUnknown = true
  }
  const outcome = issues.length === 0 ? 'ok' : sawUnknown ? 'unknown' : 'invalid'
  return { scope: 'set', outcome, issues, checked }
}

// —————————————————————— 五、落盘闸门 ——————————————————————

export interface TestingValidatedWrite {
  /** 写到盘上的文件（相对 `.sdo/` 的路径）。 */
  paths: string[]
  /** 本组写完之后，各真源类的内容指纹（渲染头与过期判定用）。 */
  fingerprints: Partial<Record<TestingSourceClass, string>> | undefined
  /** 整组写入留了一条 `truth/file-written` 事件的 seq（没给 journal 时为 `undefined`）。 */
  seq?: number | undefined
}

export type TestingValidatedWriteResult =
  | { ok: true; report: TestingShapeReport; written: TestingValidatedWrite }
  | { ok: false; report: TestingShapeReport; written: undefined }

/** `class` → 该类的第一个文件名（`design` 第一个是黑盒）。用于从文件反推类。 */
function classOf(file: TestingSourceFileKind): TestingSourceClass {
  for (const cls of TESTING_SOURCE_CLASSES) {
    if (TESTING_SOURCE_FILES[cls].some((ref) => ref.file === file)) return cls
  }
  return 'plan'
}

/**
 * **校验通过才落盘**（整组、原子、fail-closed）。
 *
 * 顺序是硬性的：**先校验整组 → 全绿才写**。任一文件非法 ⇒ `ok: false` 且**一个字节都不写**
 * （连 journal 事件都不留）—— 这是 DoD 的"不落半成品，不写盘"。
 *
 * 落盘形态与 `testingStore.writeTestingSource` 一致（`root:` 单键包裹 + `writeYaml` 的原子写），
 * 但**只留一条** `truth/file-written` 事件（`files: [...]`）：一组真源是一次写入动作，
 * 留 N 条事件会让"这次写入"在 journal 里没有唯一锚点。
 */
export function writeValidatedTestingSet(
  store: SdoStore,
  entries: readonly TestingSourceEntry[],
  options: { known?: TestingShapeKnown | undefined; journal?: Journal | undefined; actor?: string | undefined } = {},
): TestingValidatedWriteResult {
  const report = validateTestingSet(entries, options.known)
  if (report.outcome !== 'ok') return { ok: false, report, written: undefined }

  const paths: string[] = []
  const fingerprints: Partial<Record<TestingSourceClass, string>> = {}
  for (const entry of entries) {
    const cls = classOf(entry.file)
    const path = shapePathOf(entry.file).replace(/^\.sdo\//u, '')
    store.writeYaml([...path.split('/')], { [rootKeyOf(entry.file)]: entry.value })
    paths.push(path)
    fingerprints[cls] = sourceFingerprintOf(store, cls)
  }
  let seq: number | undefined
  if (options.journal !== undefined) {
    const event = options.journal.append(
      'truth/file-written',
      {
        paths: paths.map((path) => `.sdo/${path}`),
        files: entries.map((entry) => entry.file),
        fingerprint: fingerprints,
        seq: currentJournalSeq(store, options.journal),
      },
      options.actor ?? 'sdo',
    )
    seq = event.seq
  }
  return {
    ok: true,
    report,
    written: { paths, fingerprints: entries.length === 0 ? undefined : fingerprints, ...(seq === undefined ? {} : { seq }) },
  }
}

/**
 * 便捷：校验**一个文件**的形状，通过才写它（单文件的落盘闸门）。
 *
 * 与 `writeValidatedTestingSet` 的区别只在粒度：这条只管自己那一个文件。
 * **想一次写多份就用整组入口** —— 那个才是"不落半成品"的完整语义。
 */
export function writeValidatedTestingSource(
  store: SdoStore,
  entry: TestingSourceEntry,
  options: { known?: TestingShapeKnown | undefined; journal?: Journal | undefined; actor?: string | undefined } = {},
): TestingValidatedWriteResult {
  return writeValidatedTestingSet(store, [entry], options)
}

// —————————————————————— 六、读数与台账的缝隙说明 ——————————————————————

/**
 * **真源与落盘是否一致**（写入前的自检）：把"我要写的值"与盘上那份比一比。
 *
 * 用途：工具层在"用户只是重放同一条命令"时给出"没变"，而不是每次都留一条写入事件。
 * 返回 `same === true` 表示盘上那份与本次要写的**内容等价**（按规范化 JSON 比）。
 */
export function sameAsOnDisk(store: SdoStore, file: TestingSourceFileKind, value: unknown): boolean {
  const path = shapePathOf(file).replace(/^\.sdo\//u, '')
  if (!store.exists(path)) return false
  const text = store.readText(path)
  if (text === undefined) return false
  try {
    const parsed = store.readYaml<Record<string, unknown>>(path)
    const root = rootKeyOf(file)
    return JSON.stringify(parsed?.[root] ?? null) === JSON.stringify(value ?? null)
  } catch {
    return false
  }
}

/** 便捷：把校验结论写成一行回执（人读；不进真源）。 */
export function describeShapeReport(report: TestingShapeReport): string {
  const head = report.outcome === 'ok' ? '形状校验通过' : report.outcome === 'invalid' ? '形状非法，已整次拒绝' : '无法判定（按不放行处理）'
  if (report.outcome === 'ok') return `${head}（${report.checked.length} 个文件）`
  const lines = report.issues.map((issue) => `· ${issue.path}${issue.field === '' ? '' : ` → ${issue.field}`}［${issue.code}］${issue.message}`)
  return [`${head}：${report.issues.length} 处问题`, ...lines].join('\n')
}

/** 该真源文件是否已经在盘上（工具层据此决定"新建"还是"覆盖"）。 */
export function testingSourceOnDisk(store: SdoStore, file: TestingSourceFileKind): boolean {
  return existsSync(join(store.root, ...shapePathOf(file).replace(/^\.sdo\//u, '').split('/')))
}

/** 盘上那份的哈希（与 `testingStore.sourceHashOf` 同口径；工具层留痕用）。 */
export function testingSourceHashOnDisk(store: SdoStore, file: TestingSourceFileKind): string | undefined {
  const path = shapePathOf(file).replace(/^\.sdo\//u, '')
  const text = store.readText(path)
  return text === undefined ? undefined : sourceHashOf(text)
}

/** 只读：把真源按 YAML 文本渲染出来（无副作用；工具层做"将要写入什么"的预览）。 */
export function previewTestingSource(file: TestingSourceFileKind, value: unknown): string {
  return stringifyYaml({ [rootKeyOf(file)]: value })
}

/** 只读：确认一条真源文件的**根键**（`design-whitebox.yml` → `designWhitebox`）。 */
export function testingRootKey(file: TestingSourceFileKind): string {
  return rootKeyOf(file)
}

/** 只读：某个文件属于哪一类（`design-whitebox` → `design`）。 */
export function testingClassOf(file: TestingSourceFileKind): TestingSourceClass {
  return classOf(file)
}

/** 只读：本模块认识的**全部**真源文件（顺序与 `types.ts` 的词表一致）。 */
export function testingSourceFileKinds(): readonly TestingSourceFileKind[] {
  return TESTING_SOURCE_FILE_KINDS
}

/** 只读：某个映射键**允许**在哪一类真源里出现（形状说明用）。 */
export function isKnownTestingFile(value: unknown): value is TestingSourceFileKind {
  return typeof value === 'string' && (TESTING_SOURCE_FILE_KINDS as readonly string[]).includes(value)
}

/** 只读：读一份盘上的真源并与校验器对一遍（工具层"体检"用，不写盘）。 */
export function inspectTestingSourceOnDisk(
  store: SdoStore,
  file: TestingSourceFileKind,
  known?: TestingShapeKnown,
): TestingShapeReport {
  const path = shapePathOf(file).replace(/^\.sdo\//u, '')
  if (!store.exists(path)) {
    return {
      scope: 'file',
      outcome: 'invalid',
      issues: [{ path: shapePathOf(file), field: '', code: 'missing', message: `${shapePathOf(file)} 不存在` }],
      checked: [shapePathOf(file)],
    }
  }
  let parsed: unknown
  try {
    const raw = store.readYaml<Record<string, unknown>>(path)
    parsed = raw?.[rootKeyOf(file)]
  } catch (error) {
    return {
      scope: 'file',
      outcome: 'unknown',
      issues: [
        {
          path: shapePathOf(file),
          field: '',
          code: 'unknown',
          message: `压不出来（YAML 子集解析失败，按未判定处理）：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      checked: [shapePathOf(file)],
    }
  }
  return validateTestingSource(file, parsed, known)
}

/** 只读：从 `.sdo/requirements/*.yml` 建交叉引用登记表（缺文件时给空表，不抛）。 */
export function knownFromStore(store: SdoStore): TestingShapeKnown {
  const requirements = new Map<string, string[]>()
  for (const name of store.listNames('requirements')) {
    if (!name.endsWith('.yml')) continue
    const raw = store.readYaml<{ requirement?: { id?: unknown; acceptance?: unknown } }>('requirements', name)
    const requirement = raw?.requirement
    const id = textOf(requirement?.id).trim()
    if (id === '') continue
    const acs = Array.isArray(requirement?.acceptance)
      ? requirement.acceptance.map((item) => textOf((item as { id?: unknown } | null)?.id).trim()).filter((item) => item !== '')
      : []
    requirements.set(id, acs)
  }
  const testCaseIds: string[] = []
  for (const name of store.listNames('tests')) {
    if (!/^TC-\d+\.yml$/u.test(name)) continue
    const raw = store.readYaml<{ testCase?: { id?: unknown } }>('tests', name)
    const id = textOf(raw?.testCase?.id).trim()
    if (id !== '') testCaseIds.push(id)
  }
  const designIds: string[] = []
  for (const name of store.listNames('design')) {
    if (!name.endsWith('.yml')) continue
    // 设计元素散在各视图里：这里只抽 `id:` 形态（尽力而为，取不到就不参校验）
    try {
      const text = readFileSync(join(store.root, 'design', name), 'utf8')
      for (const matched of text.matchAll(/^\s*-?\s*id:\s*(DES-\d+)\s*$/gmu)) designIds.push(matched[1] as string)
    } catch {
      /* 读不动就不参与校验 */
    }
  }
  return { requirements, testCaseIds, designIds }
}
