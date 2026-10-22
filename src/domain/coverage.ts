/**
 * **覆盖读数与未覆盖项处置**（REQ-049「自报测量 + 机械核对 + 产物哈希绑定」/ REQ-057「逐条处置」，
 * 真源 `.sdo/testing/coverage.yml`）。
 *
 * 本模块回答**两个**问题，答不上来就判红：
 *
 * | # | 问题 | 判据（全部机械可判） |
 * |---|---|---|
 * | ① | 这条覆盖读数**还算数吗**？ | 准则合法 · 阈值非空 · 实测达阈 · 命令非空 · 报告在盘上且哈希一致 · 被测产物哈希一致 |
 * | ② | 这些**未覆盖项**处置了吗？ | 补用例（且用例在登记表里）/ 不可达（且给依据）/ 等价（且给依据）—— 逐条 |
 *
 * ## 为什么"过期"必须由**产物哈希**来判（而不是 mtime、也不是人自觉）
 *
 * 插件是**语言与技术栈无关**的：它不内置插桩、不绑定工具链（REQ-049 的原文），
 * 所以覆盖率只能"自报测量"。自报的东西要能被机械核对，唯一稳的锚是**内容哈希**：
 *   · mtime 会被 `git checkout` / 重新生成 / 复制文件无意义地改掉（假过期）；
 *   · 只写数字没有报告 ⇒ 无法核对（REQ-049 降级口径：**不接受只有数字没有报告的读数**）。
 * 于是读数记录三样东西：`report` + `reportHash`（"我按这份报告读数"）、`artifact` + `artifactHash`
 * （"我读的是这一版产物"）。产物一改，哈希就对不上 ⇒ **判过期并点名产物路径**（AC-198）。
 *
 * ## 与相邻模块的分工（免得后人重复造）
 *
 * · `testingShapes.ts`（TASK-012）：**形状**校验（键在不在、类型对不对、枚举认不认、哈希的**写法**
 *   对不对）。它明确声明"不查产物是否存在、是否过期"—— 那正是本模块。
 * · `testingStore.ts`（TASK-001）：真源读写、内容指纹、渲染过期判定。
 * · `testDesignWhitebox.ts`（TASK-015）：白盒**设计**技术与结构覆盖**口径**（用例是怎么推出来的）。
 *   它管"设计"，本模块管"**读数**"：同一个准则词表（`types.ts` 的 `TESTING_COVERAGE_CRITERIA`），
 *   两处都不另造第二套。
 * · `records.ts` 的 `evidenceFreshness`（SDO-57）：**用例结果**绑产物哈希的时效判定。
 *   同一口径（产物变了 ⇒ 过期 + 点名），只是被判的对象不同（结果 vs 覆盖读数）。
 *
 * ## 四条纪律
 *
 * ① **fail-closed**：本模块**不抛异常**；读不动 / 没给 / 对不上，一律落进 `issues` 而不是 throw。
 * ② **只读**：不写盘、不落 journal（与 `acceptance.ts` 的 `assessOutline` 同口径）。
 * ③ **点名到字段**：每条问题带点号路径（`readings[1].artifact`）。
 * ④ **不判"该不该达标"**：阈值定得合不合理、命名的准则选得对不对，属人的判断
 *   （REQ-045 的降级口径：门禁只核"依据是否可核对"）。这里只核**能不能核对**。
 *
 * ## 本模块**不**判什么
 *
 * · **不重算覆盖率**：不插桩、不跑工具链（那会把"语言无关"这条设计前提打破）。
 * · **不执行 `command`**：判据是"命令**给了**且非占位"（可复跑的前提），执行是人的动作 ——
 *   门禁里跑任意命令既不可预期（副作用、耗时），也不是本插件的职责。
 *   ⚠️ 这条是**有意收窄**：REQ-049 的原文是"命令可复跑"，本模块只机械核验"命令写下来了、不是占位串"，
 *   真正的复跑由执行者做、由 `command` 证据（退出码）留痕。
 * · **不判豁免**："显式豁免"是人的决定（要理由与批准人），不在本模块的处置枚举里（见 `types.ts`
 *   的 `TESTING_DISPOSITIONS` 注释）。
 *
 * ⚠️ **本文件的恢复说明（2026-10-13，诚实留痕）**：本轮执行中一次 `mv` 失误把源文件移进了
 * 沙箱临时目录（不可取回），随后**按 `lib/src/domain/coverage.js`（编译产物，逐字节保留了原文件
 * 的全部注释与文案）与 `lib/src/domain/coverage.d.ts`（类型面）逐段重建**。行为口径、导出面、
 * 全部中文文案与问题码与原版一致；**私有的内部类型标注**是重建的（编译产物不保留类型注解，
 * 但保留了全部注释）。因此本文件的内容哈希与原版**不同** —— 这正是本卡自身判据说的那种
 * "产物变了，绑在旧哈希上的读数就过期"，见 TASK-016 的报告与 `.sdo/testing/coverage.yml` 的用法。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { SdoStore } from '../infra/store.js'
import { textOf } from '../infra/scalar.js'
import { TESTING_SOURCE_FILES, label, readTestingSource } from './testingStore.js'
// **DEF-034**：准则词表**直接从唯一来源取**（`types.ts` 的 `TESTING_COVERAGE_CRITERIA`）——
// 本文件上面的注释一直这么写，修前 import 的却是 `testingStore.ts` 里**另一份**逐字相同的 `as const`
// ⇒ 注释与实现相反，而"两份内容相同"挡不住将来改一处漏一处。现在全仓只有这一份定义。
import { TESTING_COVERAGE_CRITERIA } from '../types.js'
// **处置词表与校验器的唯一来源**（TASK-021 收口）：本模块的未覆盖项判定不再自己写一份枚举与 if 链，
// 而是调用 `mutation.ts` 的 `assessCoverageItem` —— 它又调用同一份 `resolveDisposition`。
// 两侧唯一的差异（「不可达」只对未覆盖项开放）由 `DISPOSITION_SCOPE_RULE` 声明，示例见 test/m40.test.ts 的 M40-21g。
import { assessCoverageItem as assessCoverageItemShared } from './mutation.js'
// **准则别名的唯一一份表**（TASK-053）：`branch` / `branch-coverage` / `decision_coverage` → `decision`
// 由内容层（`testDesignWhitebox.ts` 的 `CRITERION_ALIASES` / `canonicalCriterion`）承担。
// 读数侧**只调它**，不另抄枚举、也不另抄映射表 —— 否则同一份真源会在两层得到相反结论（REV-007 的症状）。
import { canonicalCriterion } from './testDesignWhitebox.js'

// —————————————————————— 一、词表与人话标签 ——————————————————————

/**
 * 准则 → 人话标签。
 *
 * 中文标签**优先**取 `testingStore.ts` 的 `TESTING_ZH`（`col.coverageCriterion` 一族的唯一来源），
 * 取不到时用本模块的兜底表 —— 兜底只为"语言包/标签表被改瘦"时不至于印出裸键，
 * 不构成第二套词表（取值仍只有 `TESTING_COVERAGE_CRITERIA` 一份）。
 *
 * **与设计侧措辞的关系（DEF-034）**：同一个 token 在两层可能印不同中文词 —— 例 `decision`
 * 在这里是**判定**，而 `testDesignWhitebox.ts` 的 `WHITEBOX_CRITERION_LABEL` 是**分支**。
 * 后者是**那张卡的 DoD 逐字**（`语句 / 分支 / 路径 / 条件 / 定义-使用对`，写在 `testDesignWhitebox.ts`
 * 的三处注释与 `test/m34` 的守卫里）⇒ 属**需求基线口径**，本批不擅改；前者取"判定"是因为本仓的
 * 别名表把 `branch` 当**待纠正的别名**（`CRITERION_ALIASES: branch → decision`），
 * 且同表的 `decision-condition`（判定-条件）/ `mc-dc`（修正条件判定）已按"判定"成体系。
 * 两层是**不同用途的两份词表**（读数 7 类 / 设计 5 类），**不是错抄**；差异由 `test/m161` 机械钉住
 * （设计侧 5 类必须是读数侧的子集 ⇒ 加准则只加一边会红）。**若要统一成同一个中文词，请驾驶舱裁决**
 *（改哪一处都只动一个映射 + 一条用例；但设计侧那 5 个词有 DoD 逐字出处）。
 *
 * **第四批 §3.7：裁决已到（`ADR-014`「语义应统一」），落法是分层的**（如实上报，见 DoD ② 的停手条款）：
 *   · **统一的那一层 = 词表 / token**：两层共用 `types.ts` 的 `TESTING_COVERAGE_CRITERIA` 一份取值，
 *     `branch` 只是历史别名（`canonicalCriterion` 一处归一到 `decision`）；本表**不另造第二套词表**。
 *   · **差的那一层 = 一个中文标签**：`decision` 在这里「判定」、设计侧当时是「分支」，而设计侧那五个词
 *     是**那张卡 DoD 的逐字**（需求基线口径，第四批红线 §4.3 明令不动基线）⇒ 第四批**不硬统一**、
 *     如实上报；**第五批 §3.2** 驾驶舱把卡面勘误追加进 `TASK-015`（DoD 里的「分支」统一为「判定」）后，
 *     代码侧（`testDesignWhitebox.ts`）也改印「判定」⇒ 两层中文标签**零差异**。
 *   · "差异从一处变零处"由 `test/m161` 的 `M161-05` 机械钉住（它断言**两层逐条同词**，不写死字面）。
 */
const CRITERION_FALLBACK_LABEL: Record<string, string> = {
  statement: '语句',
  decision: '判定',
  condition: '条件',
  'decision-condition': '判定-条件',
  'mc-dc': '修正条件判定',
  path: '路径',
  'def-use': '定义-使用对',
}

/** 取准则的人话标签（查不到就回落准则原文，绝不印空串）。 */
export function coverageCriterionLabel(criterion: string): string {
  const fromStore = label(`criterion.${criterion}`)
  if (fromStore !== `criterion.${criterion}`) return fromStore
  return CRITERION_FALLBACK_LABEL[criterion] ?? criterion
}

/**
 * **读数的形状（本模块判定所依赖的那一份）**。
 *
 * 与 `types.ts` 的 `TestingCoverageReading` 相比多两个**必填**字段 —— 它们是 REQ-049 的正文
 * （"报告路径与其哈希，以及本次被测产物的哈希"），却**没有**形状位：
 *
 * | 字段 | 为什么必须有 | 没有它会怎样 |
 * |---|---|---|
 * | `reportHash` | 读数说"我按这份报告读数" | 报告被改过 / 被换过也查不出来（只有数字没有可核对的依据） |
 * | `artifactHash` | 读数说"我读的是这一版产物" | **产物改动后无从判过期**（AC-198 落不了地） |
 *
 * ⚠️ **缺口已闭合（原注释写于 TASK-011，DEF-034 复核时更正 —— 注释与实现相反正是这条最容易被
 * 后人误信的部分）**：`TestingCoverageReading`（`types.ts`）与 `testingShapes.checkCoverageReading`
 * （形状校验）**现在都有了** `reportHash` / `artifactHash`：形状层核**写法**（`sha256:` / `dir:`），
 * 判定层核**值**（与现算指纹比对）。本模块仍是**判定侧的唯一出口**：读得出来就判，读不出来就判红
 *（`artifact-hash-missing` / `report-hash-mismatch`）。
 */
export interface CoverageReading {
  id: string
  criterion: string
  measured: string
  threshold: string
  /** 工具与命令（不执行；判据是"写下来了且不是占位串"）。 */
  command: string
  /** 报告路径（相对工作区根）。 */
  report: string
  /** 报告内容哈希（`sha256:<hex>` 或裸 hex 都认）。 */
  reportHash: string
  /** 被测产物路径（相对工作区根；也可以是产物哈希 —— 见 `artifactHash` 缺失时的兜底）。 */
  artifact: string
  /** 本次被测产物哈希（`sha256:<hex>` / 裸 hex / 目录摘要 `dir:<条目数>:<12 位>`）。 */
  artifactHash: string
}

/** 未覆盖项的形状（同 `types.ts` 的 `TestingUncoveredItem`，这里只声明判定要用的字段）。 */
export interface CoverageUncoveredEntry {
  id: string
  item: string
  disposition: string
  useCase?: string | undefined
  reason?: string | undefined
}

/** 覆盖真源（`.sdo/testing/coverage.yml` 的根键正文）。 */
export interface CoverageSource {
  readings?: readonly CoverageReading[] | undefined
  uncovered?: readonly CoverageUncoveredEntry[] | undefined
}

/** 合法准则的人话集合（判红时**点名合法集合**：只说"不合法"是不可执行的结论）。 */
export function legalCoverageCriteriaText(): string {
  return TESTING_COVERAGE_CRITERIA.map((item) => `${item}（${coverageCriterionLabel(item)}）`).join(' / ')
}

/**
 * **读数侧准则取值的唯一规范化入口**（TASK-053）：合法词表 **∪** 内容层那一张别名表。
 *
 * 为什么要有它：**CT-006 ③ 的 schema 示例自己写着 `criterion: 'branch'`**，而读数侧原先两层
 * 都用裸枚举（**同一份**词表 `TESTING_COVERAGE_CRITERIA`：判定侧在本模块、形状层在 `testingShapes.ts`；
 * DEF-034 之前它被抄成了两份逐字相同的 `as const`）拒它 ——
 * 契约给的例子落到盘上被判"非法枚举"（契约与实现相扭）。按契约统一：别名被**收下并纠正**。
 *
 * 归一化**不在本模块另写**：`branch` / `branch-coverage` / `decision_coverage` → `decision`
 * 由内容层 `testDesignWhitebox.ts` 的 `CRITERION_ALIASES`（`canonicalCriterion`）唯一承担；
 * 本函数只做"先认词表、再不认就问内容层"这一次接线。形状层与判定层**都调它** ⇒ 同一位同结论。
 *
 * 返回 `undefined` = 既不在词表也不是已知别名（调用方据此判红并点名合法集合）。
 * 含义明确的别名不该被判红（判红一条意思完全正确的口径，只会逼人改词，不会提高证据质量）；
 * 而 `coverage` / `分支` 这类真非法取值照旧判红。
 */
export function canonicalReadingCriterion(raw: string): string | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  if ((TESTING_COVERAGE_CRITERIA as readonly string[]).includes(value)) return value
  return canonicalCriterion(value)
}

// —————————————————————— 二、结论的形状 ——————————————————————

/**
 * 覆盖读数 / 未覆盖项的问题码。
 *
 * 码是**稳定标识**（回执、守卫、后续准出准则都按它分类），人话在 `message` 里。
 * 与 `WHITEBOX_ISSUE_CODES`（设计侧）分开：混用会让"读数过期"与"设计缺必产项"在回执里长得一样。
 */
export const COVERAGE_ISSUE_CODES = [
  /** 真源文件在，但形状读不出对象（手写坏了）。 */
  'source-unreadable',
  /** 缺准则，或准则不在 `TESTING_COVERAGE_CRITERIA` 里（点名合法集合）。 */
  'criterion-missing',
  'criterion-unknown',
  /** 缺阈值（没有阈值就没有"达标"可言）。 */
  'threshold-missing',
  /** 实测值缺 / 读不出数（只写"差不多达标"不算读数）。 */
  'measured-invalid',
  /** 实测值达标与否与阈值对不上（**实测未达阈值**）。 */
  'measured-below-threshold',
  /** 缺可复跑的命令。 */
  'command-missing',
  /** 命令是占位串（`TODO` / `（待定）`），不是可复跑的命令。 */
  'command-placeholder',
  /** 缺报告路径（REQ-049 降级口径：不接受只有数字没有报告的读数）。 */
  'report-missing',
  /** 报告路径在工作区之外（证据只认本工作区里的产物）。 */
  'report-outside',
  /** 报告文件在盘上找不到。 */
  'report-not-found',
  /** 报告现算哈希与读数记录的不一致。 */
  'report-hash-mismatch',
  /** 缺被测产物路径。 */
  'artifact-missing',
  /** 缺本次被测产物的哈希（没有它，"读数还算不算数"无法机械判定）。 */
  'artifact-hash-missing',
  /** 被测产物已改（哈希不符）⇒ **读数过期**并点名产物。 */
  'artifact-stale',
  /** 未覆盖项缺处置。 */
  'disposition-missing',
  /** 处置取值不在词表里（补用例 / 不可达 / 等价）。 */
  'disposition-unknown',
  /** 声明"补用例"却没给用例 id。 */
  'usecase-missing',
  /** 补的用例在登记表里查不到（查得到才知道"补了哪条"）。 */
  'usecase-unknown',
  /** 声明不可达 / 等价却没给依据（REQ-057 降级口径）。 */
  'reason-missing',
  /** 收尾兜底：意外抛错被收敛（**不是** ok）。 */
  'unknown',
] as const

export type CoverageIssueCode = (typeof COVERAGE_ISSUE_CODES)[number]

/** 一条**可执行**的问题：说什么位置、错在哪、为什么非改不可。 */
export interface CoverageIssue {
  /** 点号路径（`readings[0].report`）。 */
  field: string
  code: CoverageIssueCode
  message: string
}

/** 一条读数的结论：`ok` 可用 / `stale` **过期**（产物变了）/ `invalid` 不成立 / `unknown` 判不动。 */
export type CoverageReadingOutcome = 'ok' | 'stale' | 'invalid' | 'unknown'

export interface CoverageReadingAssessment {
  id: string
  criterion: string
  outcome: CoverageReadingOutcome
  issues: CoverageIssue[]
  /** 实测与阈值（回执里逐条现算，不做加权合并 —— 同 REQ-050 纪律）。 */
  measured: string
  threshold: string
  /** 现算的被测产物哈希与读数记录的哈希（`stale` 时两者都要印出来给人比对）。 */
  artifact: string
  recordedArtifactHash: string
  actualArtifactHash: string
}

export interface CoverageUncoveredAssessment {
  id: string
  item: string
  disposition: string
  outcome: 'ok' | 'invalid'
  issues: CoverageIssue[]
}

export interface CoverageAssessment {
  /** 真源在不在盘上（`.sdo/testing/coverage.yml`）。 */
  present: boolean
  outcome: 'ok' | 'stale' | 'invalid' | 'unknown'
  readings: CoverageReadingAssessment[]
  uncovered: CoverageUncoveredAssessment[]
  /** 逐条判红的读数 id（点名用；**不许用整体达标掩盖个别项** —— REQ-057 的同一纪律）。 */
  offenders: string[]
  /** 逐条判红的未覆盖项 id。 */
  unsettled: string[]
  /** 无法判定时的原因（读不动）。 */
  unknownReason: string
}

/** 判定输入。`knownCaseIds` 给了就查"补的用例在不在登记表里"（没给只核非空，不凭空判红）。 */
export interface CoverageAssessmentInput {
  workspace: string
  source: CoverageSource
  /** 用例登记表（`req-tc` 的另一端）。 */
  knownCaseIds?: readonly string[] | undefined
}

// —————————————————————— 三、基础判定（一律不抛） ——————————————————————

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textAt(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? textOf(value).trim() : ''
}

function listAt(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 问题收集器：同一（字段, 码）只报一次（避免同义重复淹没真正的第一条）。 */
class Issues {
  private readonly items: CoverageIssue[] = []
  private readonly seen = new Set<string>()

  add(field: string, code: CoverageIssueCode, message: string): void {
    const key = `${field}\u0000${code}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.items.push({ field, code, message })
  }

  get list(): CoverageIssue[] {
    return this.items
  }
}

// —————————————————————— 四、哈希 ——————————————————————

function sha256File(target: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(target)).digest('hex')
  } catch {
    return undefined
  }
}

/** 目录的递归摘要（与 `records.ts` 的 `hashArtifact` 同口径的简化版：`dir:<条目数>:<12 位>`）。 */
function digestDir(target: string): string | undefined {
  const entries: string[] = []
  const walk = (dir: string, prefix: string): boolean => {
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      return false
    }
    for (const name of names) {
      const child = join(dir, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      let info
      try {
        info = statSync(child)
      } catch {
        return false
      }
      if (info.isDirectory()) {
        if (!walk(child, rel)) return false
        continue
      }
      const hash = sha256File(child)
      if (hash === undefined) return false
      entries.push(`${rel}:${hash}`)
    }
    return true
  }
  if (!walk(target, '')) return undefined
  const digest = createHash('sha256').update(entries.join('\n')).digest('hex')
  return `dir:${entries.length}:${digest.slice(0, 12)}`
}

/**
 * 现算一个**被读的对象**（报告文件 / 被测产物）的指纹。
 *
 * 返回三态：`missing` 找不到 / `outside` 越出工作区 / `dir:…` 目录摘要 / 64 位十六进制文件哈希。
 */
export function pathFingerprint(workspace: string, rawPath: string): string {
  const target = rawPath.trim()
  if (target === '') return 'missing'
  const absolute = isAbsolute(target) ? target : resolve(workspace, target)
  const within = relative(workspace, absolute).replace(/\\/gu, '/')
  if (within.startsWith('..') || isAbsolute(within)) return 'outside'
  if (!existsSync(absolute)) return 'missing'
  try {
    if (statSync(absolute).isDirectory()) return digestDir(absolute) ?? 'missing'
  } catch {
    return 'missing'
  }
  return sha256File(absolute) ?? 'missing'
}

/** 记录下来的哈希可能与现算值**同形不同写**（`sha256:` 前缀 / 大小写）⇒ 归一化后比对。 */
function canonicalHash(value: string): string {
  const text = value.trim()
  if (text.toLowerCase().startsWith('sha256:')) return text.slice('sha256:'.length).toLowerCase()
  return text.toLowerCase()
}

/**
 * 一个字段里写的是**哈希**而不是路径？（64 位十六进制、`sha256:` 形式、或目录摘要 `dir:…`）
 *
 * 为什么要判它：`artifact` 在仓内既有真源与夹具里被当成"哈希位"用（`coverageFixture` 写
 * `sha256:<hex>`），而 REQ-049 要求的是"**本次被测产物的哈希**"—— 两者都能表达同一件事。
 * 本模块把 `artifact` 一律先当**路径**（能现算、能点名），只有在它明显是哈希、且没有
 * `artifactHash` 时才按历史写法收下（见 `assessReading` 的对应分支）。
 */
function looksLikeHash(value: string): boolean {
  const text = value.trim()
  if (/^sha256:[0-9a-fA-F]{64}$/u.test(text)) return true
  if (/^[0-9a-fA-F]{64}$/u.test(text)) return true
  return /^dir:\d+:[0-9a-f]{12}$/u.test(text)
}

/** 两个哈希是否一致（归一化后逐字比对；空串一律不一致）。 */
export function sameHash(recorded: string, actual: string): boolean {
  const a = canonicalHash(recorded)
  const b = canonicalHash(actual)
  if (a === '' || b === '') return false
  return a === b
}

// —————————————————————— 五、数值（实测 vs 阈值） ——————————————————————

/**
 * 一个"数"的两种写法（**阈值比较的唯一一份口径**，见下面的 `parseMeasure` / `meetsThresholdText`）。
 */
export interface Measure {
  value: number
  /** 带 `%` 的读数按百分数比（`82%` vs `80%`），纯小数按占比比（`0.82` vs `0.8`）。 */
  percent: boolean
}

/**
 * 解析一个"数"：`82%` / `82` / `0.82` / `82/100` 都认，`差不多达标` 不认。
 *
 * 分母写法（`82/100`）折成占比。`xx 个` 这类带量词的照样取数（覆盖读数里"12 个未覆盖"是常见写法）。
 *
 * ⚠️ **本函数是"阈值解析"的唯一一份**（TASK-050 收敛）：`gates.ts` 的准出准则现算
 * （`exit.criteria` / `C-53`）**直接 import 本函数**，不再自带一份等价的 `exitMeasure`。
 * 曾经两边各写一份，原因写在旧注释里（当时 `coverage.ts` 不在那卡写范围）—— 那就是"同一规则两份实现"，
 * 一处改了另一处不会跟着改；本文件是**覆盖读数侧**的唯一出口，阈值口径由它一份承担。
 */
export function parseMeasure(raw: string): Measure | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  const fraction = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/u.exec(text)
  if (fraction !== null) {
    const numerator = Number(fraction[1])
    const denominator = Number(fraction[2])
    if (denominator === 0) return undefined
    return { value: numerator / denominator, percent: false }
  }
  const number = /\d+(?:\.\d+)?/u.exec(text)
  if (number === null) return undefined
  return { value: Number(number[0]), percent: text.includes('%') }
}

/**
 * 实测是否达到阈值：`undefined` = 判不动（调用方据此报 `threshold-missing` / `measured-invalid`）。
 *
 * **语义一处不落**：两边都带 `%` 或都不带 ⇒ 直接比；一边带一边不带（`82%` vs `0.8`）⇒ 把不带 `%`
 * 的那个当占比折成百分数再比。本函数只做**比较**，不做解析（解析在 `parseMeasure`）。
 */
export function meetsThreshold(measured: Measure, threshold: Measure): boolean {
  if (measured.percent === threshold.percent) return measured.value >= threshold.value
  // 一边带 % 一边不带（`82%` vs `0.8`）：把不带 % 的那个当作占比，折成百分数再比
  const asPercent = measured.percent ? measured.value : measured.value * 100
  const baseline = threshold.percent ? threshold.value : threshold.value * 100
  return asPercent >= baseline
}

/**
 * **阈值比较的唯一一份入口**：给两段**原文**（声明阈值 + 实测），回一个三态裁定。
 *
 * 它把 `parseMeasure` + `meetsThreshold` 合成**一次调用**，专供"同一组样本必须给出同一结论"的那两处：
 *   · **覆盖读数侧**：`assessReading` 判 `measured-below-threshold`；
 *   · **准出准则侧**：`gates.ts` 的 `exit.criteria`（`C-53`）判 `below-threshold` / `measure-unparsable`。
 *
 * 两边**共用这一份**（TASK-050 的收敛点，`test/m35.test.ts` 的 M35-18 逐样本比对两侧 verdict）：
 * 阈值 / 实测任一读不出数 ⇒ `undefined`（判不动，**不是**"不达标"，也**不是**"达标"）。
 *
 * @param thresholdText 阈值原文（`80%` / `0.8` / `80/100`）
 * @param measuredText  实测原文（同上写法）
 */
export function meetsThresholdText(thresholdText: string, measuredText: string): boolean | undefined {
  const threshold = parseMeasure(thresholdText)
  const measured = parseMeasure(measuredText)
  if (threshold === undefined || measured === undefined) return undefined
  return meetsThreshold(measured, threshold)
}

// —————————————————————— 六、读数逐条判定 ——————————————————————

function assessReading(issues: Issues, field: string, item: Record<string, unknown>, workspace: string): CoverageReadingAssessment {
  const id = textAt(item.id)

  // ① 准则（**别名收下并纠正**、非法取值点名合法集合 —— TASK-053：与形状层同一个规范化入口）
  const rawCriterion = textAt(item.criterion)
  let criterion = rawCriterion
  if (rawCriterion === '') {
    issues.add(`${field}.criterion`, 'criterion-missing', `${field} 缺覆盖准则：读数必须说清量的是哪一类（合法集合：${legalCoverageCriteriaText()}）`)
  } else {
    const canonical = canonicalReadingCriterion(rawCriterion)
    if (canonical === undefined) {
      issues.add(
        `${field}.criterion`,
        'criterion-unknown',
        `${field}.criterion 的取值「${rawCriterion}」不合法：合法集合是 ${legalCoverageCriteriaText()}（历史别名 branch / branch-coverage / decision_coverage 会被收下并纠正成 decision —— 与形状层同一个规范化函数；要改的是这一处取值，不是另造一套词表）`,
      )
    }
    // 别名的规范化结果要真的**带着走**：后面点名"量的是哪一类"用的是归一后的口径
    criterion = canonical ?? rawCriterion
  }

  // ② 阈值与实测（没有阈值就没有"达标"可言；数字读不出来就不是读数）
  const measuredText = textAt(item.measured)
  const thresholdText = textAt(item.threshold)
  if (thresholdText === '') {
    issues.add(`${field}.threshold`, 'threshold-missing', `${field} 缺阈值：没有阈值的读数无法判定"达没达标"（阈值定得合不合理属人的判断，但必须写下来）`)
  }
  const measured = parseMeasure(measuredText)
  if (measured === undefined) {
    issues.add(`${field}.measured`, 'measured-invalid', `${field}.measured 读不出数值：「${measuredText || '（空）'}」不是读数（写成 82% / 0.82 / 82/100 这类）`)
  }
  const threshold = parseMeasure(thresholdText)
  if (measured !== undefined && threshold !== undefined && !meetsThreshold(measured, threshold)) {
    issues.add(
      `${field}.measured`,
      'measured-below-threshold',
      `${field} 实测「${measuredText}」未达阈值「${thresholdText}」（量的是「${coverageCriterionLabel(criterion)}」）`,
    )
  }

  // ③ 命令：必须是写下来的、可复跑的那一条（不执行；见模块头的"有意收窄"）
  const command = textAt(item.command)
  if (command === '') {
    issues.add(`${field}.command`, 'command-missing', `${field} 缺工具与命令：没有命令就无法复跑核对（REQ-049 要求"命令可复跑"）`)
  } else if (isPlaceholder(command)) {
    issues.add(`${field}.command`, 'command-placeholder', `${field}.command 是占位串「${command}」：占位串不能作为"可复跑"的依据`)
  }

  // ④ 报告：路径 + 哈希 + 在盘上 + 哈希一致（缺报告 ⇒ 不接受这条读数）
  const report = textAt(item.report)
  const reportHash = textAt(item.reportHash)
  if (report === '') {
    issues.add(`${field}.report`, 'report-missing', `${field} 缺报告路径：不接受只有数字没有报告的读数（REQ-049 降级口径）`)
  } else {
    const actual = pathFingerprint(workspace, report)
    if (actual === 'outside') {
      issues.add(`${field}.report`, 'report-outside', `${field}.report 指向工作区之外的路径「${report}」：报告必须是本工作区里的产物`)
    } else if (actual === 'missing') {
      issues.add(`${field}.report`, 'report-not-found', `${field}.report 的报告在盘上找不到：「${report}」（先跑命令生成报告，再记读数）`)
    } else if (reportHash === '') {
      issues.add(`${field}.reportHash`, 'report-hash-mismatch', `${field} 缺报告哈希：报告「${report}」现算 ${actual}，读数里没有可核对的哈希（把 reportHash 补上）`)
    } else if (!sameHash(reportHash, actual)) {
      issues.add(
        `${field}.reportHash`,
        'report-hash-mismatch',
        `${field} 报告哈希不符：${report} 现算 ${actual}，读数记的是 ${canonicalHash(reportHash)}（报告改过就重算哈希，别改数字）`,
      )
    }
  }

  // ⑤ 被测产物：路径 + 哈希 + **现算比对**（不符 ⇒ 过期并点名产物）
  const artifact = textAt(item.artifact)
  const recordedArtifactHash = textAt(item.artifactHash)
  let actualArtifactHash = ''
  if (artifact === '') {
    issues.add(`${field}.artifact`, 'artifact-missing', `${field} 缺被测产物：读数必须绑到"这一版产物"上，否则改动后无从判过期`)
  } else if (recordedArtifactHash === '') {
    // **两种历史写法**都在盘上见过，处置不同（判红一条意思完全正确的读数比接受它更糟）：
    //   · `artifact` 里写的是**产物路径**、只是没写哈希 ⇒ 缺的是"记录时的那一版"（`artifact-hash-missing`）；
    //   · `artifact` 里直接写**哈希**（仓内既有夹具与存量真源的口径）⇒ 哈希在手，但读不出产物在哪，
    //     于是"它有没有被改动"**判不动** ⇒ 如实归 `unknown` 并点名缺 `artifactHash`（不假装过期、也不判绿）。
    if (looksLikeHash(artifact)) {
      issues.add(
        `${field}.artifactHash`,
        'artifact-hash-missing',
        `${field} 只记了产物哈希（${canonicalHash(artifact)}）、没记产物路径：哈希在手但不知道产物在哪，`
        + '无法核对「它有没有被改动」 —— 补 `artifactHash`（与 `artifact` 里的产物路径配对）才能判过期',
      )
    } else {
      issues.add(`${field}.artifactHash`, 'artifact-hash-missing', `${field} 缺被测产物哈希：没有它就无法判定这条读数还算不算数（产物一改就该过期）`)
    }
  } else {
    actualArtifactHash = pathFingerprint(workspace, artifact)
    if (actualArtifactHash === 'outside') {
      issues.add(`${field}.artifact`, 'report-outside', `${field}.artifact 指向工作区之外的路径「${artifact}」：被测产物必须是本工作区里的产物`)
    } else if (!sameHash(recordedArtifactHash, actualArtifactHash)) {
      issues.add(
        `${field}.artifact`,
        'artifact-stale',
        `${field} 读数已过期：被测产物 ${artifact} 已变（记录时 ${canonicalHash(recordedArtifactHash)}，现在 ${actualArtifactHash}）—— 重跑测量并重记这条读数`,
      )
    }
  }

  const outcome = readingOutcome(issues.list, field, actualArtifactHash)
  return {
    id,
    criterion,
    outcome,
    issues: issues.list.filter((issue) => issue.field.startsWith(field)),
    measured: measuredText,
    threshold: thresholdText,
    artifact,
    recordedArtifactHash: canonicalHash(recordedArtifactHash),
    actualArtifactHash,
  }
}

/** 占位串：写下来但没人能复跑的那些（`TODO` / `待定` / `—` / `n/a`）。 */
function isPlaceholder(command: string): boolean {
  const text = command.trim().toLowerCase()
  if (['-', '--', '—', 'n/a', 'na', 'none', 'todo', 'tbd', '待定', '无', '略'].includes(text)) return true
  return text.length < 3
}

/**
 * 一条读数的结论（判据的**优先序**是有意为之）：
 *
 *   · 有 `artifact-stale` ⇒ `stale`（产物变了，这条读数**过期**，与"写得对不对"无关）；
 *   · 其余**判不动**类问题（只有 `artifact-hash-missing`：哈希在手但不知道产物在哪）⇒ `unknown`；
 *   · 其余任何问题 ⇒ `invalid`；
 *   · 无问题 ⇒ `ok`。
 *
 * 为什么过期优先：产物一改，`ok` 立刻不许再算数（REQ-049 的原文）——
 * 哪怕同一条读数里还有别的毛病，先说"过期"才是对的处置顺序（先重跑，再看写没写全）。
 * 为什么 `unknown` 与 `invalid` 分开：前者是"我查不动"（补一个字段就能查），
 * 后者是"它不成立"（数没达标、报告没了）。两者都不许算达标，但补救动作完全不同。
 */
function readingOutcome(issues: CoverageIssue[], field: string, actualArtifactHash: string): CoverageReadingOutcome {
  const mine = issues.filter((issue) => issue.field.startsWith(field))
  if (mine.some((issue) => issue.code === 'artifact-stale')) return 'stale'
  // 没算出现算值（= 没走到比对那一步）却又一个问题都没报：状态不明，不许当 `ok`
  if (mine.length === 0) return actualArtifactHash === '' ? 'unknown' : 'ok'
  const undecidable = mine.filter((issue) => issue.code === 'artifact-hash-missing')
  if (undecidable.length === mine.length) return 'unknown'
  return 'invalid'
}

// —————————————————————— 七、未覆盖项逐条判定 ——————————————————————

/**
 * 逐条判定**未覆盖项的处置**（REQ-057）。
 *
 * 判定本身**不在本模块**：调 `mutation.ts` 的 `assessCoverageItem`（= 同一份
 * `DISPOSITION_RULES` / `DISPOSITION_SCOPE_RULE` + 同一个 `resolveDisposition`）。
 * 本函数只负责把结论**收进本模块的问题收集器**（`Issues`，按「字段 + 码」去重）并保持
 * 既有顺序：先点"缺未覆盖项本身"，再点处置列的问题（`assessCoverageItem` 已按此顺序给出）。
 *
 * 为什么要"只收结论"而不是"自己判"：TASK-003 撤卡时发现同一个取值在这里、在
 * `testingShapes.checkUncovered`、在 `report.yml` 的变异分支三处待遇可以不同 ——
 * 病灶就是每个文件各写一份枚举 + 一条 if 链。词表与规则**只有一份**（`types.ts` 的
 * `TESTING_DISPOSITIONS` + `mutation.ts` 的表），本函数不再持有任何取值字面量。
 */
function assessUncovered(
  issues: Issues,
  field: string,
  item: Record<string, unknown>,
  knownCaseIds: readonly string[] | undefined,
): CoverageUncoveredAssessment {
  const shared = assessCoverageItemShared(field, item, { knownCaseIds })
  for (const issue of shared.issues) {
    // **唯一需要断言的一点**：`mutation.ts` 的码集合是覆盖侧的超集（多出 `unreachable-not-allowed` /
    // `survived-missing` / `killrate-*` 一族，它们只在变异侧出现）。这里的转换是**显式**的，
    // 不是"两边随便借个名字"：两侧共用的五个码（disposition-* / usecase-* / reason-missing）
    // 由 `mutation.ts` 的 `SharedCodesAligned` 在**编译期**钉住同名。
    // 变异侧独有的码若真从这条路漏进来，那是 `assessment` 用完忘了判的红 —— 不让它静默变成"另一个码"。
    issues.add(issue.field, issue.code as CoverageIssueCode, issue.message)
  }

  const mine = issues.list.filter((issue) => issue.field.startsWith(field))
  return {
    id: shared.id,
    item: shared.item,
    disposition: shared.disposition,
    outcome: mine.length === 0 ? 'ok' : 'invalid',
    issues: mine,
  }
}

// —————————————————————— 八、整份真源 ——————————————————————

function asRecords(value: unknown): Record<string, unknown>[] {
  return listAt(value).filter(isRecord)
}

/** 空结论（真源不在盘上 / 读不动时用；`present` 区分"没写"与"写了但空"）。 */
function emptyAssessment(present: boolean, unknownReason: string): CoverageAssessment {
  return {
    present,
    outcome: unknownReason === '' ? 'ok' : 'unknown',
    readings: [],
    uncovered: [],
    offenders: [],
    unsettled: [],
    unknownReason,
  }
}

/** 一条读数的 outcome 是"判红"（`ok` 之外都算：过期 / 不成立 / 判不动，一律不许当达标）。 */
function readingOk(outcome: CoverageReadingOutcome): boolean {
  return outcome === 'ok'
}

/**
 * 判定一份覆盖真源（**只读**：不写盘、不改台账）。
 *
 * `outcome` 的口径：
 *   · `ok`      —— 每条读数都可用、每个未覆盖项都处置了；
 *   · `stale`   —— 至少一条读数**过期**（被测产物被改动）；
 *   · `invalid` —— 至少一条读数不成立、或至少一个未覆盖项未处置；
 *   · `unknown` —— 判不动（真源解析不出对象）。
 *
 * 优先级：`stale` > `invalid` > `ok`。**过期优先**（产物变了是"先重跑"的信号，
 * 而不是"先把读数补全"的信号）。
 */
export function assessCoverage(input: CoverageAssessmentInput): CoverageAssessment {
  const issues = new Issues()
  const readings: CoverageReadingAssessment[] = []
  const uncovered: CoverageUncoveredAssessment[] = []

  const raw: Record<string, unknown> = isRecord(input.source) ? input.source : {}
  asRecords(raw.readings).forEach((item, index) => readings.push(assessReading(issues, `readings[${index}]`, item, input.workspace)))
  asRecords(raw.uncovered).forEach((item, index) => uncovered.push(assessUncovered(issues, `uncovered[${index}]`, item, input.knownCaseIds)))

  const offenders = readings.filter((item) => !readingOk(item.outcome)).map((item) => item.id)
  const unsettled = uncovered.filter((item) => item.outcome !== 'ok').map((item) => item.id)
  const stale = readings.filter((item) => item.outcome === 'stale')
  const unknown = readings.filter((item) => item.outcome === 'unknown')

  const outcome: CoverageAssessment['outcome'] =
    stale.length > 0 ? 'stale' : offenders.length > 0 || unsettled.length > 0 ? 'invalid' : unknown.length > 0 ? 'unknown' : 'ok'

  return { present: true, outcome, readings, uncovered, offenders, unsettled, unknownReason: '' }
}

/** 从 `<store>/.sdo/testing/coverage.yml` 读真源并判定。真源不在盘上 ⇒ `present: false`（不算判红）。 */
export function assessCoverageFromStore(store: SdoStore, workspace: string, knownCaseIds?: readonly string[]): CoverageAssessment {
  const ref = TESTING_SOURCE_FILES.coverage[0]
  if (ref === undefined) return emptyAssessment(false, '')
  const read = readTestingSource(store, ref)
  if (!read.present) return emptyAssessment(false, '')
  if (read.unreadable) {
    return emptyAssessment(true, `.sdo/${read.path} 读不出对象：文件在盘上但解析失败（先修 YAML，再看读数）`)
  }
  try {
    return assessCoverage({ workspace, source: read.value as unknown as CoverageSource, ...(knownCaseIds === undefined ? {} : { knownCaseIds }) })
  } catch (error) {
    // fail-closed：意外抛错收敛成 unknown（**不是** ok），并如实给出原因
    return emptyAssessment(true, `判定覆盖读数时意外出错：${error instanceof Error ? error.message : String(error)}`)
  }
}

// —————————————————————— 九、人读文案（门禁 detail / remedy） ——————————————————————

/**
 * 把判定结论翻成**用户可见的**一句话（门禁判据的 `detail`）。
 *
 * 为什么放在本模块而不是 `gates.ts`：那个文件被 i18n 棘轮钉在「零硬编码中文」
 * （`test/m7.test.ts` 的基线 `src/domain/gates.ts: 0`），而语言包不在本卡写范围 ——
 * 与 `acceptance.ts` 的 `describeOutlineVerdict` 同一处置。
 */
export function describeCoverage(assessment: CoverageAssessment): string {
  if (!assessment.present) {
    return '覆盖真源 .sdo/testing/coverage.yml 不在盘上（没有读数就不判覆盖：先按 REQ-049 记一条读数，再回来判）'
  }
  if (assessment.unknownReason !== '') return assessment.unknownReason

  const problems: string[] = []
  for (const reading of assessment.readings) {
    if (reading.outcome === 'ok') continue
    const labelText = reading.id === '' ? '（未编号读数）' : reading.id
    const why = reading.issues.map((issue) => `${issue.field}：${issue.message}`).join('；')
    problems.push(`${labelText}［${outcomeText(reading.outcome)}］${why}`)
  }
  for (const item of assessment.uncovered) {
    if (item.outcome === 'ok') continue
    const labelText = item.id === '' ? '（未编号未覆盖项）' : item.id
    problems.push(`${labelText}［未处置］${item.issues.map((issue) => issue.message).join('；')}`)
  }
  if (problems.length > 0) {
    return `覆盖读数与未覆盖项处置不通过（共 ${assessment.readings.length} 条读数、${assessment.uncovered.length} 条未覆盖项）：${problems.join(' | ')}`
  }
  const staleNote = assessment.readings.length === 0 ? '（尚无读数）' : `；每条读数都被测产物哈希与当前一致`
  return `覆盖读数可用：${assessment.readings.length} 条读数逐条达标、${assessment.uncovered.length} 条未覆盖项逐条有处置${staleNote}`
}

function outcomeText(outcome: CoverageReadingOutcome): string {
  switch (outcome) {
    case 'ok':
      return '可用'
    case 'stale':
      return '已过期'
    case 'invalid':
      return '不成立'
    case 'unknown':
      return '判不动'
    default:
      return String(outcome)
  }
}

/** 判红的**补救办法**（门禁回执的 `remedy`；可执行、点名入口）。 */
export function coverageRemedy(): string {
  return (
    '按 REQ-049 重记覆盖读数：重跑测量命令 → 更新报告文件 → 现算报告哈希与被测产物哈希 '
    + '（`sha256sum <文件>`；目录用 `dir:<条目数>:<12 位>`）→ 写回 `.sdo/testing/coverage.yml` 的 `readings[]` '
    + '（criterion / threshold / measured / command / report / reportHash / artifact / artifactHash 八项齐备）；'
    + '被测产物改动之后**旧读数一律过期**，必须重跑重记，不许改哈希迁就旧数字；'
    + '未覆盖项按 REQ-057 逐条处置（补一条能覆盖它的用例，或声明不可达 / 等价并给依据），'
    + '处置记录写回同一文件的 `uncovered[]`'
  )
}
