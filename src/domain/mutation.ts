/**
 * **变异读数复用 / 存活变异体逐条处置 / 缺陷根因与发现级别**（REQ-055、REQ-057，TASK-021）。
 *
 * ## 本模块解决什么
 *
 * 变异测试是"断言面真的能分对错"的度量。但**跑一遍变异很贵**，所以 REQ-055 的第一句是
 * 「**复用**实现侧已落盘的变异记录（同源，不另造一份真相）」——
 * 复用要成立，唯一稳的锚是**内容哈希**：读数记下「我按这份变异记录读、我读的是这一版产物」，
 * 只要两个哈希都还现算得上，**这条读数不重跑也算数**；产物一改立刻判 `stale`（AC-217）。
 *
 * 另一半是**逐条处置**：存活变异体不许用"kill 率达标"整体掩盖。每条存活变异体要么
 * 补一条能杀死它的用例（并指向那条用例），要么显式声明等价并给理由（AC-215），
 * 否则**判红并点名该变异体**（AC-216）。
 *
 * ## 词表同源（TASK-003 撤卡时发现的"两处各写一份"）
 *
 * 未覆盖项（`coverage.yml`，REQ-057）与存活变异体（`report.yml` 的 `mutation.survived`，REQ-055）
 * 的处置**是同一套词表**（`types.ts` 的 `TESTING_DISPOSITIONS`，全仓唯一一份），
 * 校验也必须是**同一套规则**。历史上这两处各自内联过一份枚举与一条 if 链
 * （`coverage.ts` 的 `assessUncovered`、`testingShapes.ts` 的 `checkUncovered` 与 `checkReport`
 * 的变异分支），于是同一个取值在三处的待遇可以不同。**本模块就是那份唯一来源**：
 *
 * | 导出 | 是什么 |
 * |---|---|
 * | `DISPOSITION_RULES` | 处置 → **必填字段**的映射（数据，不是 if 链） |
 * | `resolveDisposition` | 唯一的处置校验器（覆盖项 / 存活变异体 / 落盘形状三处都调它） |
 * | `DISPOSITION_SCOPE_RULE` | 两侧允许集合的**差异**（显式声明，不靠各自默认） |
 *
 * ## 唯一的语义差异（有意为之，守卫用例逐条断言）
 *
 * **「不可达」只对未覆盖项开放，存活变异体不接受**：
 *   · 未覆盖项可能是**死代码**（真跑不到）⇒ REQ-057 明确给了这一档（要理由）；
 *   · 存活变异体是**被植入的**改动，它活下来只说明"这条分支被跑到过、而断言没看出来" ⇒
 *     标成"不可达"等于用不可达掩盖断言缺口（REQ-055 的正文里**没有**这一档）。
 * 差异由 `DISPOSITION_SCOPE_RULE` 声明、由 `resolveDisposition({ scope })` 强制、
 * 由 `test/m40.test.ts` 断言。
 *
 * ## 四条纪律（与 `coverage.ts` / `regression.ts` 逐字同规）
 *
 * ① **fail-closed**：不抛异常。读不动 ⇒ `unknown`，**`unknown` 不是 `ok`**；
 * ② **只读**：不写盘、不落 journal（变异记录由 `sdo_test action=record mutation=…` 落账，本模块只判）；
 * ③ **点名到字段**：每条问题带点号路径（`survived[1].disposition`）；
 * ④ **不判"该不该达标"**：阈值定得合不合理属人的判断，本模块只核"能不能核对"。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { textOf } from '../infra/scalar.js'
import { TESTING_DISPOSITIONS } from '../types.js'
import { CONSTRUCTION_DIR, CONSTRUCTION_TDD_FILE, readMutations } from './construction.js'
import { pathFingerprint, sameHash } from './coverage.js'
import { TESTING_SOURCE_FILES, readTestingSource } from './testingStore.js'

import type { SdoStore } from '../infra/store.js'
import type { MutationRecord } from './construction.js'
import type { CoverageIssueCode } from './coverage.js'

// —————————————————————— 一、处置词表：唯一来源 ——————————————————————

/**
 * 处置词表（**唯一一份**）。
 *
 * 值与 `types.ts` 的 `TESTING_DISPOSITIONS` 同源：这里**再导出**而不是重写一份数组
 * （重写一份 = 多一个会漂移的真相，正是本卡要消灭的东西）。
 */
export const MUTATION_DISPOSITIONS = TESTING_DISPOSITIONS
export type MutationDisposition = (typeof MUTATION_DISPOSITIONS)[number]

/** 处置的两侧（未覆盖项 / 存活变异体）。差异只由 `DISPOSITION_SCOPE_RULE` 声明。 */
export const DISPOSITION_SCOPES = ['coverage-item', 'surviving-mutant'] as const
export type DispositionScope = (typeof DISPOSITION_SCOPES)[number]

/**
 * **两侧允许集合的规则**（有意差异，显式声明）。
 *
 * 为什么不干脆两边都用全词表：那会让存活变异体也能被标成"不可达"，
 * 把"断言没看出来"洗成"代码跑不到"——判据就松了。差异写在这里，守卫用例逐条断言。
 */
export const DISPOSITION_SCOPE_RULE: Record<DispositionScope, { allowed: readonly MutationDisposition[]; why: string }> = {
  'coverage-item': {
    allowed: MUTATION_DISPOSITIONS,
    why: 'REQ-057：未覆盖项可能是死代码，三档全开（各档的必填项不同）',
  },
  'surviving-mutant': {
    allowed: ['补用例', '等价'],
    why: 'REQ-055：存活变异体是被植入的改动，它活下来只说明断言没看出来 —— 「不可达」会掩盖断言缺口',
  },
}

/** 处置 → 必填字段（**数据**，校验器与守卫用例读同一张表）。 */
export const DISPOSITION_RULES: Record<MutationDisposition, { requires: readonly ('useCase' | 'reason')[]; why: string }> = {
  补用例: { requires: ['useCase'], why: '处置要能**指到**那条用例（REQ-057 AC-223）' },
  不可达: { requires: ['reason'], why: 'REQ-057 降级口径：无法判定是否不可达时不得声明不可达 —— 声明了就必须给依据' },
  等价: { requires: ['reason'], why: '没有理由的等价声明不算处置（REQ-055 / REQ-057）' },
}

/** 词表里的人话集合（判红时点名合法集合：只说"不合法"是不可执行的结论）。 */
export function legalDispositionsText(scope: DispositionScope): string {
  return DISPOSITION_SCOPE_RULE[scope].allowed.join(' / ')
}

// —————————————————————— 二、问题码 ——————————————————————

/**
 * 处置与存活变异体的问题码。
 *
 * 前五个与 `coverage.ts` 的 `COVERAGE_ISSUE_CODES` **同名同义**（同一个字段出现同一种毛病，
 * 在覆盖侧与变异侧必须长得一样 —— 否则"同一套校验函数"就只是口号）；
 * 其余是变异侧独有的毛病。
 */
export const MUTATION_ISSUE_CODES = [
  /** 缺处置（未覆盖项 / 存活变异体都必须逐条处置）。 */
  'disposition-missing',
  /** 处置取值不在词表里。 */
  'disposition-unknown',
  /** 声明"补用例"却没给用例 id。 */
  'usecase-missing',
  /** 补的用例不在用例登记表里。 */
  'usecase-unknown',
  /** 声明不可达 / 等价却没给依据。 */
  'reason-missing',
  /** 给了依据，但这一档按 `DISPOSITION_RULES` **不需要**依据。 */
  'reason-unnecessary',
  /** 存活变异体声明了「不可达」—— `DISPOSITION_SCOPE_RULE` 的差异，这一档不开放。 */
  'unreachable-not-allowed',
  /** 变异读数缺"存活变异体逐条处置"这一段（有存活数却没有处置清单）。 */
  'survived-missing',
  /** 变异读数没绑变异记录 / 记录路径读不出来。 */
  'record-missing',
  /** 变异记录绑定的内容哈希与盘上那份不一致（读数是**另一份**记录的，过期）。 */
  'record-stale',
  /** 缺被测产物路径（没有它，读数与"哪一版产物"对不上）。 */
  'artifact-missing',
  /** 被测产物已改（哈希不符）⇒ **读数过期**并点名产物。 */
  'artifact-stale',
  /**
   * 被测产物路径指向工作区之外。
   *
   * 复用 `coverage.ts` 的码名（它把"路径在工作区之外"叫 `report-outside`，`artifact` 位用的是同一个码）：
   * **同一件事在两处不许长出两个名字**，哪怕被点的字段名不同。
   */
  'report-outside',
  /** kill 率读不出数（只写"八成"不算读数）。 */
  'killrate-invalid',
  /** 阈值读不出数（没有阈值就没有"达标"可言）。 */
  'threshold-invalid',
  /** 现算 kill 率低于阈值。 */
  'killrate-below-threshold',
  /** 能对齐（kill 率与阈值都在手）却没给被测产物哈希 ⇒ 无从判过期（判 `unknown`，不假装过期也不判绿）。 */
  'artifact-hash-missing',
  /** 收尾兜底：意外抛错被收敛（**不是** ok）。 */
  'unknown',
] as const
export type MutationIssueCode = (typeof MUTATION_ISSUE_CODES)[number]

/**
 * **两处共用的五个码**（编译期就钉住，不靠人记得）。
 *
 * 同一个字段出现同一种毛病，在覆盖侧与变异侧必须**同名** —— 否则"同一套校验函数"只是口号，
 * 回执里同一件事会长出两个名字。这份校验是双向的：任一侧改了名字，`tsc` 立刻报错。
 */
type SharedIssueCodes = 'disposition-missing' | 'disposition-unknown' | 'usecase-missing' | 'usecase-unknown' | 'reason-missing'
type SharedWithCoverage = Extract<MutationIssueCode, SharedIssueCodes>
type CoverageHasShared = Extract<CoverageIssueCode, SharedIssueCodes>
/** `true` = 五个共用语在两个词表里都存在（类型不等时会编译失败）。 */
export type SharedCodesAligned = [SharedWithCoverage] extends [CoverageHasShared]
  ? [CoverageHasShared] extends [SharedWithCoverage]
    ? true
    : never
  : never

/**
 * 一条**可执行**的问题。
 *
 * 形状与 `coverage.ts` 的 `CoverageIssue` 一致（`field` / `code` / `message`），
 * 但没有用 `extends` 硬绑：变异侧的问题码是**超集**（多出 `unreachable-not-allowed` /
 * `survived-missing` / `killrate-*` 一族），强行 extends 会把两侧的码集合绑成一个 —— 那才是
 * 真正会漂移的耦合。共用面由上面的 `SharedCodesAligned` 在编译期钉住。
 */
export interface MutationIssue {
  /** 点号路径（`survived[0].disposition`）。 */
  field: string
  code: MutationIssueCode
  message: string
}

/** kill 率读数：`ok` 可用 / `stale` **过期**（产物或记录变了）/ `invalid` 不成立 / `unknown` 判不动。 */
export type MutationReadingOutcome = 'ok' | 'stale' | 'invalid' | 'unknown'

// —————————————————————— 三、唯一的处置校验器 ——————————————————————

/** 一条待校验的处置（未覆盖项与存活变异体的公共形状）。 */
export interface DispositionInput {
  /** 点号路径前缀（`uncovered[0]` / `survived[1]`）。 */
  field: string
  /** 声明的处置（原样带上，不合法时要点名它）。 */
  disposition: string
  /** 补用例的用例 id。 */
  useCase?: string | undefined
  /** 不可达 / 等价的依据。 */
  reason?: string | undefined
  /** 哪一侧（决定允许集合与差异话术）。 */
  scope: DispositionScope
  /** 用例登记表：**给了才查**（查不到不许凭空判红，与 `coverage.ts` 同口径）。 */
  knownCaseIds?: readonly string[] | undefined
}

/** 一条处置的结论（`ok` 之外都不算处置 —— 逐条判红，不许整体掩盖）。 */
export interface DispositionResolution {
  disposition: string
  useCase: string
  reason: string
  /** 是否落在本侧允许集合里（`false` ⇒ 一定判红，取值合法与否都算）。 */
  allowed: boolean
  outcome: 'ok' | 'invalid'
  issues: MutationIssue[]
}

function textAt(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? textOf(value).trim() : ''
}

/** 收集器：同一（字段, 码）只报一次（避免同义重复淹没真正的第一条）。 */
class IssueList {
  private readonly items: MutationIssue[] = []
  private readonly seen = new Set<string>()

  add(field: string, code: MutationIssueCode, message: string): void {
    const key = `${field}\u0000${code}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.items.push({ field, code, message })
  }

  get list(): MutationIssue[] {
    return this.items
  }
}

/**
 * **校验一条处置**（未覆盖项与存活变异体共用，唯一实现）。
 *
 * 规则全部读 `DISPOSITION_RULES` 与 `DISPOSITION_SCOPE_RULE`（数据表），不在函数体里写死取值：
 * 加一档处置、改一处必填项，只需要动那张表。
 */
export function resolveDisposition(input: DispositionInput): DispositionResolution {
  const issues = new IssueList()
  const scope = input.scope
  const rule = DISPOSITION_SCOPE_RULE[scope]
  const side = scope === 'surviving-mutant' ? '存活变异体' : '未覆盖项'
  const disposition = input.disposition.trim()
  const useCase = textAt(input.useCase)
  const reason = textAt(input.reason)
  let allowed = false

  if (disposition === '') {
    issues.add(
      `${input.field}.disposition`,
      'disposition-missing',
      `${input.field} 缺处置：${side}必须逐条处置（${legalDispositionsText(scope)}），不许用整体达标掩盖个别项（REQ-055 / REQ-057）`,
    )
  } else if (!(MUTATION_DISPOSITIONS as readonly string[]).includes(disposition)) {
    issues.add(
      `${input.field}.disposition`,
      'disposition-unknown',
      `${input.field}.disposition 的取值「${disposition}」不在词表里：合法集合是 ${legalDispositionsText(scope)}（显式豁免是人的决定，不在这张表里）`,
    )
  } else if (!(rule.allowed as readonly string[]).includes(disposition)) {
    // 词表里的取值、但**这一侧不开放** —— 两侧唯一的差异，就在这里被强制
    issues.add(
      `${input.field}.disposition`,
      'unreachable-not-allowed',
      `${input.field}.disposition 的「${disposition}」在词表里、但${side}这一侧不开放：${rule.why}（要么补一条能杀死它的用例，要么声明等价并给理由）`,
    )
  } else {
    allowed = true
    const table = DISPOSITION_RULES[disposition as MutationDisposition]
    if (table.requires.includes('useCase')) {
      if (useCase === '') {
        issues.add(`${input.field}.useCase`, 'usecase-missing', `${input.field} 声明"补用例"却没给用例 id：处置要能指到那条用例（REQ-057 AC-223）`)
      } else if (input.knownCaseIds !== undefined && !input.knownCaseIds.includes(useCase)) {
        issues.add(
          `${input.field}.useCase`,
          'usecase-unknown',
          `${input.field}.useCase 的「${useCase}」不在用例登记表里（现有：${input.knownCaseIds.length === 0 ? '（无）' : input.knownCaseIds.join(' ')}）`,
        )
      }
    }
    if (table.requires.includes('reason')) {
      if (reason.length < 2) {
        issues.add(`${input.field}.reason`, 'reason-missing', `${input.field} 声明「${disposition}」却没给依据：${table.why}`)
      }
    } else if (reason !== '') {
      issues.add(
        `${input.field}.reason`,
        'reason-unnecessary',
        `${input.field}.reason 在「${disposition}」这一档不参与判定（该档的必填项是 ${table.requires.join(' + ')}）：删掉它，或改成一档需要依据的处置 —— 留着会让人以为它是依据`,
      )
    }
  }

  return { disposition, useCase, reason, allowed, outcome: issues.list.length === 0 ? 'ok' : 'invalid', issues: issues.list }
}

// —————————————————————— 四、未覆盖项 / 存活变异体的逐条结论 ——————————————————————

/** 一条未覆盖项的逐条结论（形状与 `coverage.ts` 的 `CoverageUncoveredAssessment` 一致）。 */
export interface CoveredItemAssessment {
  id: string
  item: string
  disposition: string
  outcome: 'ok' | 'invalid'
  issues: MutationIssue[]
}

/** 一条存活变异体的逐条结论。 */
export interface SurvivingMutantAssessment {
  id: string
  /** 一句人话（这条变异体改了什么）—— 有就印出来，没有不判红。 */
  summary: string
  disposition: string
  useCase: string
  reason: string
  outcome: 'ok' | 'invalid'
  issues: MutationIssue[]
}

/**
 * 判一条**未覆盖项**（`coverage.yml` 的 `uncovered[i]`）。
 *
 * 与 `coverage.ts` 的 `assessUncovered` 同一套规则（读同一张 `DISPOSITION_RULES` /
 * `DISPOSITION_SCOPE_RULE`，调用同一个 `resolveDisposition`）。
 */
export function assessCoverageItem(
  field: string,
  item: Record<string, unknown>,
  options: { knownCaseIds?: readonly string[] | undefined } = {},
): CoveredItemAssessment {
  const id = textAt(item.id)
  const statement = textAt(item.item)
  const resolution = resolveDisposition({
    field,
    disposition: textAt(item.disposition),
    useCase: textAt(item.useCase),
    reason: textAt(item.reason),
    scope: 'coverage-item',
    knownCaseIds: options.knownCaseIds,
  })
  const issues = [...resolution.issues]
  if (statement === '') {
    issues.unshift({
      field: `${field}.item`,
      code: 'disposition-missing',
      message: `${field} 缺未覆盖项本身（是哪条语句 / 判定分支 / 路径 / 定义-使用对）—— 点不到具体项就无法逐条处置`,
    })
  }
  return { id, item: statement, disposition: resolution.disposition, outcome: issues.length === 0 ? 'ok' : 'invalid', issues }
}

/**
 * 判一条**存活变异体**（`report.yml` 的 `mutation.survived[i]`）。
 *
 * 与未覆盖项**同一套校验函数**，差异只有一处：`scope`（「不可达」不开放）。
 */
export function assessMutationItem(
  field: string,
  item: Record<string, unknown>,
  options: { knownCaseIds?: readonly string[] | undefined } = {},
): SurvivingMutantAssessment {
  const id = textAt(item.id)
  const summary = textAt(item.summary) || textAt(item.title) || textAt(item.mutant)
  const resolution = resolveDisposition({
    field,
    disposition: textAt(item.disposition),
    useCase: textAt(item.useCase),
    reason: textAt(item.reason),
    scope: 'surviving-mutant',
    knownCaseIds: options.knownCaseIds,
  })
  const issues = [...resolution.issues]
  if (id === '') {
    issues.unshift({
      field: `${field}.id`,
      code: 'disposition-missing',
      message: `${field} 缺变异体 id —— 判红要点名到**具体哪一条**变异体（AC-216），没有 id 就点不到`,
    })
  }
  return {
    id,
    summary,
    disposition: resolution.disposition,
    useCase: resolution.useCase,
    reason: resolution.reason,
    outcome: issues.length === 0 ? 'ok' : 'invalid',
    issues,
  }
}

// —————————————————————— 五、变异读数：复用 + 现算 kill 率 + 逐条处置 ——————————————————————

/** 一条变异读数的形状（`report.yml` 的 `mutation`）。 */
export interface MutationReadingSource {
  killRate?: string | undefined
  threshold?: string | undefined
  /** 变异记录路径（默认 `.sdo/construction/tdd.yml` —— 实现侧落的那一份，同源，不另造）。 */
  record?: string | undefined
  /** 记录时那份变异记录的哈希（绑住"读的是哪一份"）。 */
  recordHash?: string | undefined
  /** 被测产物（相对工作区根）。 */
  artifact?: string | undefined
  /** 记录时那版被测产物的哈希（**不重跑也算数**的锚）。 */
  artifactHash?: string | undefined
  survived?: readonly (Record<string, unknown> | string)[] | undefined
}

export interface MutationAssessmentInput {
  workspace: string
  source: MutationReadingSource
  /** 用例登记表（`req-tc` 的另一端）：给了才查"补的用例在不在表里"。 */
  knownCaseIds?: readonly string[] | undefined
  /**
   * 实现侧落盘的变异记录。**不给就用 `store` 现读**（`readMutations`，复用同源）；
   * 显式给值时用它（守卫用例据此离线跑，也便于钉住"读的是哪一份"）。
   */
  records?: readonly MutationRecord[] | undefined
  /** `.sdo/` 的只读视图（`records` 没给时用来现读变异记录）。 */
  store?: SdoStore | undefined
  /** 用哪张卡的记录复算（缺省 = 全部）。 */
  taskId?: string | undefined
}

export interface MutationAssessment {
  /** 读数在不在盘上（给的是空对象 ⇒ `false`）。 */
  present: boolean
  outcome: MutationReadingOutcome
  /** 现算的 kill 率（分子/分母都是现算的；分母 0 ⇒ `ratio: null`）。 */
  killRate: { killed: number; surviving: number; total: number; ratio: number | null }
  /** 声明的 kill 率与阈值（原样带上，回执里现算与声明并排印）。 */
  recordedKillRate: string
  threshold: string
  survived: SurvivingMutantAssessment[]
  /** 逐条判红的存活变异体 id（点名用；不许用整体达标掩盖个别项）。 */
  unsettled: string[]
  issues: MutationIssue[]
  unknownReason: string
  /** 复用到的变异记录（同源证据：读了哪几条、来自哪份、是现读还是调用方给的）。 */
  reused: { records: number; killed: number; survived: number; source: string; fromCaller: boolean }
}

/** 把 `80%` / `0.8` / `80` 读成数（读不出 ⇒ `undefined`，不假装 0）。 */
export function parseRate(value: string): number | undefined {
  const text = value.trim().replace(/\s+/gu, '')
  if (text === '') return undefined
  const match = /^(-?\d+(?:\.\d+)?)([%％]?)$/u.exec(text)
  if (match === null) return undefined
  const number = Number(match[1])
  if (!Number.isFinite(number)) return undefined
  if (match[2] !== '') return number / 100
  return number <= 1 ? number : number / 100
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 文件 / 目录的内容指纹（读不动 ⇒ 空串；与 `pathFingerprint` 同族的"不抛"口径）。 */
function hashOfPath(workspace: string, relative: string): string {
  const target = join(workspace, relative)
  try {
    if (statSync(target).isDirectory()) return pathFingerprint(workspace, relative)
    return createHash('sha256').update(readFileSync(target)).digest('hex')
  } catch {
    return ''
  }
}

/**
 * **判定一条变异读数**（REQ-055 的四件事一次做完）。
 *
 * ① **复用**：读实现侧落盘的变异记录（`readMutations`，同源），按测试者口径**现算** kill 率
 *    并与阈值比较 —— 不重跑也算数，因为"哪一版产物 / 哪一份记录"由哈希锚住（AC-215）；
 * ② **过期**：产物哈希或记录哈希对不上 ⇒ `stale` 并要求重跑，**不得用旧读数充数**（AC-217）；
 * ③ **逐条处置**：每个存活变异体走 `assessMutationItem`（与覆盖项**同一套校验器**）；
 * ④ **点名**：未处置的存活变异体进 `unsettled`，判红时逐条点名（AC-216）。
 */
export function assessMutation(input: MutationAssessmentInput): MutationAssessment {
  const source = input.source
  const issues = new IssueList()
  const keys = Object.keys(source as Record<string, unknown>)
  const present = keys.length > 0
  const declaredRecordPath = textAt(source.record)
  const recordPath = (declaredRecordPath === '' ? `.sdo/${CONSTRUCTION_DIR}/${CONSTRUCTION_TDD_FILE}` : declaredRecordPath).replace(/^\.\//u, '')
  const artifact = textAt(source.artifact)
  const recordedArtifactHash = textAt(source.artifactHash)
  const recordedRecordHash = textAt(source.recordHash)

  // —— ① 复用实现侧的变异记录（同源；调用方给了就用它） ——
  let records: readonly MutationRecord[] = []
  let recordsUnreadable = false
  if (input.records !== undefined) {
    records = input.records
  } else {
    try {
      records = readMutations(storeOf(input))
    } catch {
      recordsUnreadable = true
    }
  }
  const taskId = textAt(input.taskId)
  const scoped = taskId === '' ? records : records.filter((item) => item.task === taskId)
  const killed = scoped.reduce((total, item) => total + (Number.isFinite(item.killed) ? item.killed : 0), 0)
  const surviving = scoped.reduce((total, item) => total + (Number.isFinite(item.survived) ? item.survived : 0), 0)
  const total = killed + surviving
  const ratio = total === 0 ? null : killed / total

  if (recordsUnreadable) {
    return {
      present,
      outcome: 'unknown',
      killRate: { killed: 0, surviving: 0, total: 0, ratio: null },
      recordedKillRate: textAt(source.killRate),
      threshold: textAt(source.threshold),
      survived: [],
      unsettled: [],
      issues: issues.list,
      unknownReason: `读不动变异记录（${recordPath}）：形状坏了 / 权限不足 —— 判不动不等于达标（REQ-055 降级口径）`,
      reused: { records: 0, killed: 0, survived: 0, source: recordPath, fromCaller: input.records !== undefined },
    }
  }

  // —— ② 时效：产物 / 记录两份哈希（过期优先，先重跑再谈别的） ——
  let actualArtifactHash = ''
  if (artifact === '') {
    issues.add(
      'artifact',
      'artifact-missing',
      '变异读数缺被测产物（`artifact`）：读数必须绑到"这一版产物"上，否则产物一改就无从判过期（REQ-055 降级口径）',
    )
  } else {
    actualArtifactHash = pathFingerprint(input.workspace, artifact)
    if (actualArtifactHash === 'outside') {
      issues.add('artifact', 'report-outside', `artifact 指向工作区之外的路径「${artifact}」：被测产物必须是本工作区里的产物`)
    } else if (recordedArtifactHash === '') {
      issues.add(
        'artifact',
        'artifact-hash-missing',
        '变异读数没记被测产物哈希（`artifactHash`）：哈希不在手就判不出"这条读数还算不算数" —— 补上记录时那版产物的 sha256',
      )
    } else if (!sameHash(recordedArtifactHash, actualArtifactHash)) {
      issues.add(
        'artifact',
        'artifact-stale',
        `变异读数已过期：被测产物 ${artifact} 已变（记录时 ${recordedArtifactHash}，现在 ${actualArtifactHash}）—— 重跑变异并重记这条读数，不得用旧读数充数（AC-217）`,
      )
    }
  }

  const actualRecordHash = hashOfPath(input.workspace, recordPath)
  if (actualRecordHash === '') {
    issues.add('record', 'record-missing', `变异读数绑的变异记录 ${recordPath} 在盘上找不到：复用要指向**真实存在**的那一份记录（REQ-055 同源）`)
  } else if (recordedRecordHash !== '' && !sameHash(recordedRecordHash, actualRecordHash)) {
    issues.add(
      'record',
      'record-stale',
      `变异记录 ${recordPath} 已变（记录时 ${recordedRecordHash}，现在 ${actualRecordHash}）—— 这条读数绑的不是当前那一份，重算再记`,
    )
  }

  // —— ③ kill 率与阈值（现算，只做比较，不做加权合并 —— 同 REQ-050 纪律） ——
  const thresholdText = textAt(source.threshold)
  const threshold = parseRate(thresholdText)
  if (thresholdText === '') {
    issues.add('threshold', 'threshold-invalid', '变异读数缺阈值：没有阈值就没有"达标"可言（REQ-055 的第一件事就是与阈值比较）')
  } else if (threshold === undefined) {
    issues.add('threshold', 'threshold-invalid', `threshold 读不出数（如 \`80%\`），当前是「${thresholdText}」`)
  }
  const recordedKillRate = textAt(source.killRate)
  if (recordedKillRate !== '' && parseRate(recordedKillRate) === undefined) {
    issues.add('killRate', 'killrate-invalid', `mutation.killRate 读不出数（如 \`80%\`），当前是「${recordedKillRate}」`)
  }
  if (scoped.length === 0) {
    issues.add(
      'record',
      'record-missing',
      `没有可复用的变异记录（${recordPath} 里匹配 ${taskId === '' ? '（不限卡）' : taskId} 的记录 0 条）：变异读数必须来自实现侧落盘的那一份，不许凭空写一个数`,
    )
  } else if (ratio !== null && threshold !== undefined && ratio < threshold) {
    issues.add(
      'killRate',
      'killrate-below-threshold',
      `变异 kill 率 ${(ratio * 100).toFixed(1)}% 低于阈值 ${(threshold * 100).toFixed(1)}%（现算：杀 ${killed} / 总 ${total}，来自 ${recordPath}）`,
    )
  }

  // —— ④ 存活变异体逐条处置（与未覆盖项同一套校验器） ——
  const rawSurvived = source.survived
  const survived: SurvivingMutantAssessment[] = []
  if (rawSurvived === undefined) {
    if (surviving > 0) {
      issues.add(
        'survived',
        'survived-missing',
        `变异记录里有 ${surviving} 个存活变异体，读数却没给处置清单（\`mutation.survived\`）：存活变异体必须逐条处置（REQ-055 / AC-216）`,
      )
    }
  } else if (!Array.isArray(rawSurvived)) {
    issues.add('survived', 'survived-missing', `mutation.survived 必须是列表，当前是 ${typeof rawSurvived}`)
  } else {
    rawSurvived.forEach((raw, index) => {
      const field = `survived[${index}]`
      const item: Record<string, unknown> = typeof raw === 'string' ? { id: raw } : isRecord(raw) ? raw : {}
      const one = assessMutationItem(field, item, { knownCaseIds: input.knownCaseIds })
      survived.push(one)
      // **逐条的问题必须汇总到读数上**：否则"存活变异体未处置"只活在 `unsettled` 里，
      // 回执看不到**为什么**不算处置（点号路径与文案都丢在数组元素里）
      for (const issue of one.issues) issues.add(issue.field, issue.code, issue.message)
    })
    if (rawSurvived.length < surviving) {
      issues.add(
        'survived',
        'survived-missing',
        `变异记录里有 ${surviving} 个存活变异体，处置清单只列了 ${rawSurvived.length} 条（少 ${surviving - rawSurvived.length} 条）：逐条处置的前提是**逐条列出来**，缺的那几条要点名到 \`survived[${rawSurvived.length}]\` 及以后（AC-216）`,
      )
    }
  }
  const unsettled = survived.filter((item) => item.outcome !== 'ok').map((item) => (item.id === '' ? '（缺 id 的存活变异体）' : item.id))
  // **少列的那几条也算未处置**：清单比记录短时，"没列出来"绝不能被读成"处置了"
  for (let index = survived.length; index < surviving; index += 1) unsettled.push(`survived[${index}]（记录称有存活，处置清单未列）`)

  return {
    present,
    outcome: readingOutcome(issues.list, actualArtifactHash),
    killRate: { killed, surviving, total, ratio },
    recordedKillRate,
    threshold: thresholdText,
    survived,
    unsettled,
    issues: issues.list,
    unknownReason: '',
    reused: { records: scoped.length, killed, survived: surviving, source: recordPath, fromCaller: input.records !== undefined },
  }
}

/**
 * 一条读数的结论（**与 `coverage.ts` 的 `readingOutcome` 逐字同规**）：
 * `stale`（产物变了）> `unknown`（判不动）> `invalid`（不成立）> `ok`。
 *
 * 为什么过期优先：产物一改，`ok` 立刻不许再算数 —— 哪怕同一条读数里还有别的毛病，
 * 先说"过期"才是对的处置顺序（先重跑，再看写没写全）。
 */
function readingOutcome(issues: readonly MutationIssue[], actualArtifactHash: string): MutationReadingOutcome {
  if (issues.some((issue) => issue.code === 'artifact-stale' || issue.code === 'record-stale')) return 'stale'
  if (issues.length === 0) return actualArtifactHash === '' ? 'unknown' : 'ok'
  const undecidable = issues.filter((issue) => issue.code === 'artifact-hash-missing')
  if (undecidable.length === issues.length) return 'unknown'
  return 'invalid'
}

/**
 * `MutationAssessmentInput.records` 缺省时的读盘入口。
 *
 * 复用路径的意义在这里：调用方可以只给"读数 + 工作区"，由本模块**现读**实现侧那份记录
 * （同源，不另造）；守卫用例则直接给 `records`，两态都能钉住。
 */
function storeOf(input: MutationAssessmentInput): SdoStore {
  if (input.store !== undefined) return input.store
  throw new Error(`assessMutation：既没给 records 也没给 store（workspace=${input.workspace}）`)
}

// —————————————————————— 六、位置常量与读取入口 ——————————————————————

/** 变异记录真源位置（回执里点名用；与 `construction.ts` 同一份路径）。 */
export const MUTATION_RECORD_PATH = `.sdo/${CONSTRUCTION_DIR}/${CONSTRUCTION_TDD_FILE}`

/** `report.yml` 里变异读数的点号路径（回执与守卫共用一个串，免得各写一串）。 */
export function mutationSourceLocation(): string {
  return `${TESTING_SOURCE_FILES.report[0]?.path ?? 'testing/report.yml'}#mutation`
}

/** 读 `report.yml` 的变异读数段（读不动 ⇒ 空对象，由 `assessMutation` 判 `present: false`）。 */
export function readMutationReading(store: SdoStore): MutationReadingSource {
  const ref = TESTING_SOURCE_FILES.report[0]
  if (ref === undefined) return {}
  const read = readTestingSource(store, ref)
  const mutation = (read.value as Record<string, unknown>).mutation
  return isRecord(mutation) ? (mutation as MutationReadingSource) : {}
}

/** 从 store 现读变异记录（`.sdo/construction/tdd.yml`）—— 复用同源的那一份。 */
export function mutationRecordsOf(store: SdoStore): MutationRecord[] {
  return readMutations(store)
}

/** 记录文件字节数（诊断用：`0` = 读不到）。 */
export function mutationRecordBytes(store: SdoStore): number {
  try {
    return statSync(join(store.root, CONSTRUCTION_DIR, CONSTRUCTION_TDD_FILE)).size
  } catch {
    return 0
  }
}
