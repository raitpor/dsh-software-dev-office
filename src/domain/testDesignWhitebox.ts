/**
 * **测试设计规格·白盒技术**（REQ-056 / DES-031 的 `design-whitebox.yml` 类真源）。
 *
 * 本模块回答**一个**问题：这份白盒设计规格，是不是"真从代码结构推出来的用例设计"？
 * 答"不是"或"答不上来"时，**一个字节都不许落盘**。
 *
 * ## 五类口径（本卡 DoD 逐字：语句 / 分支 / 路径 / 条件 / 定义-使用对）
 *
 * 白盒侧的"五类口径"不是五条覆盖读数，而是**五类设计技术各自要回答的口径**——
 * 每一类都有一张「口径 → 技术键 → 最小必产项」的映射（`WHITEBOX_CRITERION_TECHNIQUES`）：
 *
 * | 口径 | 技术键 | 最小必产项（REQ-056） |
 * |---|---|---|
 * | 语句（`statement`） | `control-flow` | 控制流图：判定节点与汇合节点 |
 * | 分支（`decision`） | `cyclomatic` | 圈复杂度：每个被测单元的复杂度读数与计算口径 |
 * | 路径（`path`） | `basis-paths` | 独立路径集：基本路径法的独立路径清单 |
 * | 条件（`condition`） | `condition-combination` | 条件桩与真值组合表（或 MC/DC 独立影响对） |
 * | 定义-使用对（`def-use`） | `def-use` | 定义-使用对清单 |
 *
 * ⚠️ 「分支」一栏的取值是 **`decision`** 而不是 `branch`：仓内的覆盖准则词表
 * （`types.ts` 的 `TESTING_COVERAGE_CRITERIA`）用的是 `decision`，而准出准则与覆盖读数都引它。
 * 本模块**不另造第二套词表**，只把中文标签「分支」映射到仓内既有的 `decision`；
 * `branch` 作为历史别名被**收下并纠正**回 `decision`（见 `canonicalCriterion`），而不是判红 ——
 * 判红一条意思完全正确的口径，比接受它更糟。
 *
 * ## 与相邻模块的分工（免得后人重复造）
 *
 * · `testingShapes.ts`（TASK-012）：**形状**校验（键在不在、类型对不对、枚举值认不认）。
 * · `testDesign.ts`（TASK-014）：**黑盒**侧的内容校验与落盘闸门。
 * · **本模块**：**白盒**侧的内容校验 —— 五类口径逐类给出最小必产项，必产项里的
 *   函数 / 分支 / 变量必须能核对到**真实代码出处**，且每条独立路径与每个 def-use 对
 *   都要有用例反向引用（REQ-056 的两条防凑数条款）。
 *
 * ## 四条纪律
 *
 * ① **fail-closed**：校验器自己不抛异常；读不动一律 `unknown`，而落盘闸门只认 `ok`。
 * ② **整次拒绝、不落半成品**：校验不过就**不写盘**。
 * ③ **点名到字段**：每条问题带点号路径（`artifacts[1].paths[0].useCases`）。
 * ④ **防凑数**：路径与 def-use 对逐条要用例；结构元素逐条要代码出处（查不到即判红）。
 *
 * ## 本模块**不**判什么
 *
 * · **不判设计得好不好**：控制流图划得对不对、复杂度算得准不准，属人的判断。
 * · **不解析 TypeScript 语法树**：代码出处核对走的是**词法索引**（`collectWhiteboxCodeIndex`），
 *   它回答"这个符号在这个文件里出现过吗"，不回答"它是不是真的函数"。
 *   这是有意的取舍：本插件语言无关，装一个每种语言的解析器不在本轮范围（见变更单 §8）。
 * · **不写台账 journal**：落盘留痕由调用方决定（与 `testDesign.ts` 同口径）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { contentHash } from './hash.js'
import { SdoStore } from '../infra/store.js'
import { textOf } from '../infra/scalar.js'

// —————————————————————— 一、五类口径 ——————————————————————

/**
 * **本卡交付的五类结构覆盖口径**（DoD 逐字：语句 / 分支 / 路径 / 条件 / 定义-使用对）。
 *
 * 取值取自仓内既有的 `TESTING_COVERAGE_CRITERIA`（不另造第二套），
 * 中文标签见 `WHITEBOX_CRITERION_LABEL`。
 */
export const WHITEBOX_COVERAGE_CRITERIA = ['statement', 'decision', 'path', 'condition', 'def-use'] as const

export type WhiteboxCoverageCriterion = (typeof WHITEBOX_COVERAGE_CRITERIA)[number]

/** 口径 → 人话标签（回执与文档共用，不另造第二份）。 */
export const WHITEBOX_CRITERION_LABEL: Record<string, string> = {
  statement: '语句',
  decision: '分支',
  path: '路径',
  condition: '条件',
  'def-use': '定义-使用对',
}

/**
 * **口径 → 技术 → 最小必产项**的映射表（REQ-056 的五类技术逐条落座）。
 *
 * 这张表是本模块的中心：它让「五类口径可声明」变成**机械可判**的一句话 ——
 * 说得出 `statement`，就要交得出控制流图的判定节点与汇合节点；说得出 `path`，
 * 就要交得出独立路径清单。写不出必产项的口径不是"还没写"，是"没做设计"。
 */
export const WHITEBOX_CRITERION_TECHNIQUES: Record<WhiteboxCoverageCriterion, string> = {
  statement: 'control-flow',
  decision: 'cyclomatic',
  path: 'basis-paths',
  condition: 'condition-combination',
  'def-use': 'def-use',
}

/** 本卡交付的五类白盒技术（＝映射表的值域，保持与 `types.ts` 词表同源）。 */
export const WHITEBOX_TECHNIQUES = ['control-flow', 'cyclomatic', 'basis-paths', 'condition-combination', 'def-use'] as const

export type WhiteboxTechnique = (typeof WHITEBOX_TECHNIQUES)[number]

/** 技术 → 人话标签。 */
export const WHITEBOX_TECHNIQUE_LABEL: Record<string, string> = {
  'control-flow': '控制流图',
  cyclomatic: '圈复杂度',
  'basis-paths': '独立路径集',
  'condition-combination': '条件组合',
  'def-use': '定义-使用对',
}

/**
 * 历史别名 → 规范取值。
 *
 * 为什么收 `branch`：它表达的意思与 `decision` 完全一致（分支/判定），只是叫法不同。
 * 判红一条**意思正确**的口径，只会逼人改词，不会提高设计质量。
 * 而真的非法取值（`coverage` / `语句` 这种既非词表也非别名的）照旧判红并点名合法集合。
 */
const CRITERION_ALIASES: Record<string, WhiteboxCoverageCriterion> = {
  branch: 'decision',
  'branch-coverage': 'decision',
  decision_coverage: 'decision',
}

// —————————————————————— 二、结论的形状 ——————————————————————

/**
 * 白盒内容校验的问题码。
 *
 * 与 `TEST_DESIGN_ISSUE_CODES`（黑盒）**分开**：两者混用会让"黑盒缺项"与"白盒缺项"
 * 在回执里长得一模一样，读的人分不清该去补哪一面。
 */
export const WHITEBOX_ISSUE_CODES = [
  /** 必产项缺 `technique`，或整份缺必产项（"整类没做"）。 */
  'technique-missing',
  /**
   * 必产项漏写了 `criterion`（"这条写漏了一个字段"）。
   *
   * 为什么与 `technique-missing` 分开：两者都会让某类口径**不被声明**，但处置完全不同 ——
   * 缺口径是补一个字段，缺技术/缺必产项是补一整类设计。混用一个码，回执就会把
   * "补一个字段"说成"补一整类"，而且会把本该 invalid 的结论压成 unknown（实测踩到过）。
   */
  'criterion-missing',
  /** 技术或口径的取值不在词表里（**点名合法集合**）。 */
  'criterion-unknown',
  /** 该技术的最小必产项缺字段。 */
  'artifact-incomplete',
  /** 必产项 / 独立路径 / def-use 对没有被用例反向引用（防凑数）。 */
  'no-usecase',
  /** 用例 id 查不到。 */
  'usecase-unknown',
  /** 结构元素在代码真源里查不到（不许凭空发明）。 */
  'code-unknown',
  /** 必产项没有给出任何结构元素出处。 */
  'code-anchor-missing',
  /** 同一结构元素重复声明（重复计数会让覆盖看起来更全）。 */
  'duplicate-anchor',
  /** 收尾兜底：读不动或意外抛错。 */
  'unknown',
] as const

export type WhiteboxIssueCode = (typeof WHITEBOX_ISSUE_CODES)[number]

export interface WhiteboxIssue {
  /** 点号路径（空串 = 整份真源层面）。 */
  field: string
  code: WhiteboxIssueCode
  message: string
}

/** 一类口径的覆盖读数：声明了几个必产项 / 其中几个真的给出了必产项。 */
export interface WhiteboxCriterionCoverage {
  criterion: WhiteboxCoverageCriterion
  label: string
  technique: string
  declared: number
  covered: number
}

export interface WhiteboxReport {
  outcome: 'ok' | 'invalid' | 'unknown'
  issues: WhiteboxIssue[]
  coverage: WhiteboxCriterionCoverage[]
  unknownReason: string
}

// —————————————————————— 三、基础判定（一律不抛） ——————————————————————

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textAt(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? textOf(value) : ''
}

function listAt(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 问题收集器：同一（路径, 码）只报一次。 */
class Issues {
  private readonly items: WhiteboxIssue[] = []
  private readonly seen = new Set<string>()

  add(field: string, code: WhiteboxIssueCode, message: string): void {
    const key = `${field}\u0000${code}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.items.push({ field, code, message })
  }

  get list(): WhiteboxIssue[] {
    return this.items
  }
}

function missing(issues: Issues, field: string, what: string, why: string): void {
  issues.add(field, 'artifact-incomplete', `${field} 必填：${what} —— ${why}`)
}

/** 合法集合的点名文案（REQ-056 的"非法取值被拒**并点名合法集合**"）。 */
function legalCriteriaText(): string {
  return WHITEBOX_COVERAGE_CRITERIA.map((value) => `${value}（${WHITEBOX_CRITERION_LABEL[value] ?? value}）`).join(' / ')
}

/**
 * 口径取值规范化：别名收下并纠正，非法取值返回 `undefined`（由调用方点名合法集合）。
 */
export function canonicalCriterion(raw: string): WhiteboxCoverageCriterion | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  if ((WHITEBOX_COVERAGE_CRITERIA as readonly string[]).includes(value)) return value as WhiteboxCoverageCriterion
  return CRITERION_ALIASES[value]
}

// —————————————————————— 四、代码真源索引（结构元素的对手方） ——————————————————————

/**
 * **结构元素的对手方**：从代码真源里抽出来的符号清单。
 *
 * 设计取舍（写在明处）：这是**词法索引**，不是语法树 —— 它回答"这个符号在这个文件里出现过吗"，
 * 不回答"它是不是真的函数、这个分支是不是真的在这个函数里"。理由：插件语言无关，
 * 装解析器不在本轮范围；而 REQ-056 AC-220 要拦的是**凭空发明**（写了代码里根本没有的东西），
 * 词法索引足以拦住这一类，且判红的方向不会因此变松（符号不存在 ⇒ 一定查不到）。
 */
export interface WhiteboxCodeIndex {
  /** `相对路径:符号` → 该符号出现过的行号（含函数名、类名、导出名）。 */
  targets: Map<string, number[]>
  /** `相对路径#分支id` → 出现过的行号（`if`/`case`/`&&`/`||`/`?` 之类）。 */
  branches: Map<string, number[]>
  /** `相对路径:变量名` → 出现过的行号。 */
  variables: Map<string, number[]>
  /** `相对路径:变量@行` → 定义-使用对的锚点。 */
  defUse: Map<string, number[]>
}

export function emptyWhiteboxCodeIndex(): WhiteboxCodeIndex {
  return { targets: new Map(), branches: new Map(), variables: new Map(), defUse: new Map() }
}

/** 代码真源目录（相对仓库根）。 */
const DEFAULT_CODE_ROOTS = ['src', 'lib', 'test', 'scripts'] as const

/** 递归时跳过的重目录（索引只要"符号出现过没有"，不值得为它遍历依赖树）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.sdo-test'])

/** 递归列出某个目录下的代码文件（相对仓库根的正斜杠路径；读不动的目录跳过）。 */
function listCodeFiles(repoRoot: string, roots: readonly string[]): string[] {
  const out: string[] = []
  const walk = (absolute: string, relative: string, depth: number): void => {
    if (depth > 8) return
    let entries: { name: string; isDirectory: () => boolean; isFile: () => boolean }[] = []
    try {
      entries = readdirSync(absolute, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue
        walk(join(absolute, name), `${relative}/${name}`, depth + 1)
        continue
      }
      if (!entry.isFile() || !/\.(?:ts|js|mjs|cjs)$/u.test(name)) continue
      out.push(`${relative}/${name}`)
    }
  }
  for (const root of roots) walk(join(repoRoot, root), root, 0)
  return out.sort()
}

function push(map: Map<string, number[]>, key: string, line: number): void {
  const lines = map.get(key)
  if (lines === undefined) map.set(key, [line])
  else if (!lines.includes(line)) lines.push(line)
}

/**
 * 从代码真源里**收集**结构元素索引（只读；读不动的文件跳过而不是抛）。
 *
 * @param repoRoot 仓库根（绝对路径）
 * @param roots 相对仓库根的代码目录（缺省 `src` / `lib` / `test` / `scripts`）
 */
export function collectWhiteboxCodeIndex(repoRoot: string, roots: readonly string[] = DEFAULT_CODE_ROOTS): WhiteboxCodeIndex {
  const index = emptyWhiteboxCodeIndex()

  for (const relative of listCodeFiles(repoRoot, roots)) {
    let text = ''
    try {
      text = readFileSync(join(repoRoot, relative), 'utf8')
    } catch {
      continue
    }
    text.split('\n').forEach((line, at) => {
      const lineNumber = at + 1
      // 函数 / 类 / 接口 / 类型 / 变量声明（含 `export`）
      for (const match of line.matchAll(/\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) {
        const symbol = match[1]
        if (symbol !== undefined) push(index.targets, `${relative}:${symbol}`, lineNumber)
      }
      // 分支：控制流关键字与逻辑/三元运算符
      if (/\b(?:if|else\s+if|switch|case|catch)\b/u.test(line) || /&&|\|\||\?(?![.?])/u.test(line)) {
        push(index.branches, `${relative}#${line.trim().slice(0, 60)}`, lineNumber)
      }
      // 变量：声明即定义点（def-use 对的锚点）
      for (const match of line.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gu)) {
        const name = match[1]
        if (name !== undefined) {
          push(index.variables, `${relative}:${name}`, lineNumber)
          push(index.defUse, `${relative}:${name}@${lineNumber}`, lineNumber)
        }
      }
    })
  }
  return index
}

/**
 * 结构元素出处的解析（REQ-056 / AC-220）。
 *
 * 形态：`相对路径:符号` / `相对路径:符号#位置` / `相对路径#分支片段` / `相对路径:变量@行`。
 * 给得出形态但**索引里没有 ⇒ 判红并点名**；索引为空（`targets` 与 `branches` 都为空，
 * 说明代码真源不可读）⇒ **不判红**，交由调用方把整份判 `unknown`（不许凭空判红）。
 */
export function resolveCodeAnchor(
  issueField: string,
  raw: unknown,
  index: WhiteboxCodeIndex | undefined,
  issues: Issues,
): string | undefined {
  const value = textAt(raw).trim()
  if (value === '') {
    issues.add(issueField, 'code-anchor-missing', `${issueField} 必填：结构元素出处（\`相对路径:符号\`，如 \`src/domain/x.ts:myFn\`）—— 引用不到代码真源的必产项不许计入覆盖（REQ-056 AC-220）`)
    return undefined
  }
  if (index === undefined) return value
  const usable = index.targets.size > 0 || index.branches.size > 0
  if (!usable) return value

  const files = [...new Set([...index.targets.keys(), ...index.branches.keys(), ...index.variables.keys()].map((key) => key.split(/[:#]/u)[0] ?? ''))]
  const file = value.split(/[:#]/u)[0] ?? ''
  const candidates = [value, value.split('#')[0] ?? value, file]
  for (const candidate of candidates) {
    if (candidate === '') continue
    if (index.targets.has(candidate) || index.branches.has(candidate) || index.variables.has(candidate) || index.defUse.has(candidate)) {
      return value
    }
  }
  // 只给了文件名也可以（"这个文件存在"是个弱但真实的出处）；文件都不存在才判红
  if (files.includes(file)) {
    issues.add(
      issueField,
      'code-unknown',
      `${issueField} 的「${value}」只指到了文件、没指到文件里的符号：要写 \`${file}:符号名\` 才能核对（该文件里可核对的符号有：${[...index.targets.keys()].filter((key) => key.startsWith(`${file}:`)).slice(0, 6).join(' ') || '（未索引到）'}）`,
    )
    return undefined
  }
  issues.add(
    issueField,
    'code-unknown',
    `${issueField} 的「${value}」在代码真源里查不到：结构元素必须能核对到真实代码出处，不得凭空发明（REQ-056 AC-220；已索引的文件示例：${files.slice(0, 6).join(' ')}）`,
  )
  return undefined
}

// —————————————————————— 五、校验器 ——————————————————————

export interface WhiteboxKnownFacts {
  /** 需求 id → 验收标准 id。 */
  requirements: Map<string, string[]>
  /** 设计元素 id → 该元素里出现过的枚举取值。 */
  designElements: Map<string, string[]>
  /** 代码真源索引（结构元素的对手方）。 */
  code: WhiteboxCodeIndex
}

export function emptyWhiteboxKnownFacts(): WhiteboxKnownFacts {
  return { requirements: new Map(), designElements: new Map(), code: emptyWhiteboxCodeIndex() }
}

/** 从 `.sdo/` 台账收集域出处的对手方（坏文件跳过，读路径永不抛异常）。 */
export function collectWhiteboxKnownFacts(store: SdoStore): WhiteboxKnownFacts {
  const facts = emptyWhiteboxKnownFacts()
  for (const name of store.listNames('requirements')) {
    if (!name.endsWith('.yml')) continue
    const text = store.readText('requirements', name) ?? ''
    const id = /^\s*id\s*:\s*(REQ-\d{3,6})\s*$/mu.exec(text)?.[1]
    if (id === undefined) continue
    const acs: string[] = []
    for (const match of text.matchAll(/^\s*(?:-\s*)?id\s*:\s*(AC-\d{3,6})\s*$/gmu)) {
      const ac = match[1]
      if (ac !== undefined && !acs.includes(ac)) acs.push(ac)
    }
    facts.requirements.set(id, acs)
  }
  for (const name of store.listNames('design')) {
    if (!name.endsWith('.yml')) continue
    const text = store.readText('design', name) ?? ''
    for (const match of text.matchAll(/^\s*(?:-\s*)?id\s*:\s*(DES-\d{3,6})\s*$/gmu)) {
      const id = match[1]
      if (id !== undefined && !facts.designElements.has(id)) facts.designElements.set(id, [])
    }
  }
  // 代码真源在 `.sdo/` 的上一级（仓库根）
  facts.code = collectWhiteboxCodeIndex(join(store.root, '..'))
  return facts
}

/** 逐技术的校验上下文（含跨必产项的兄弟表：独立路径要能对上控制流图的判定节点）。 */
interface WhiteboxContext {
  issues: Issues
  field: string
  item: Record<string, unknown>
  notApplicable: boolean
  known: WhiteboxKnownFacts | undefined
  knownCases: readonly string[] | undefined
  /** 该必产项声明的用例（回填给"反向引用"这道闸）。 */
  usedCases: string[]
  /** 同一次校验里的兄弟必产项（技术 → 条目），供跨表核对。 */
  siblings: Map<string, Record<string, unknown>>
}

function checkUseCases(context: WhiteboxContext, field: string, value: unknown, what: string): void {
  const entries = listAt(value)
  if (entries.length === 0) {
    missing(context.issues, field, `${what}（至少一条用例）`, '白盒必产项没有被用例反向引用就等于凑数（REQ-056）')
    return
  }
  entries.forEach((entry, index) => {
    const id = textAt(entry).trim()
    if (id === '') {
      context.issues.add(`${field}[${index}]`, 'no-usecase', `${field}[${index}] 不能是空串`)
      return
    }
    context.usedCases.push(id)
    const known = context.knownCases
    if (known === undefined) return
    if (!known.includes(id)) {
      context.issues.add(`${field}[${index}]`, 'usecase-unknown', `${field}[${index}] 的用例「${id}」在已落盘用例里查不到（已有：${known.length === 0 ? '（无）' : known.join(' ')}）`)
    }
  })
}

/** 控制流图（口径·语句）：判定节点与汇合节点都要有，且判定节点要能被独立路径引用。 */
function checkControlFlow(context: WhiteboxContext): void {
  if (context.notApplicable) return
  const decisions = listAt(context.item.decisions)
  const merges = listAt(context.item.merges)
  if (decisions.length === 0) {
    missing(context.issues, `${context.field}.decisions`, '判定节点清单（id + 条件出处）', '没有判定节点的控制流图回答不了"分支从哪分出去的"（REQ-056）')
  }
  if (merges.length === 0) {
    missing(context.issues, `${context.field}.merges`, '汇合节点清单（id + 位置）', '没有汇合节点的控制流图回答不了"分支在哪合回来"（REQ-056）')
  }
  const decisionIds: string[] = []
  decisions.forEach((entry, index) => {
    const field = `${context.field}.decisions[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`id: …\` / \`at: …\`）`)
      return
    }
    const id = textAt(entry.id).trim()
    if (id === '') missing(context.issues, `${field}.id`, '判定节点 id', '独立路径要按 id 引用它')
    else decisionIds.push(id)
    resolveCodeAnchor(`${field}.at`, entry.at, context.known?.code, context.issues)
  })
  merges.forEach((entry, index) => {
    const field = `${context.field}.merges[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`id: …\` / \`at: …\`）`)
      return
    }
    if (textAt(entry.id).trim() === '') missing(context.issues, `${field}.id`, '汇合节点 id', '它是路径描述的一端')
    resolveCodeAnchor(`${field}.at`, entry.at, context.known?.code, context.issues)
  })
  checkUseCases(context, `${context.field}.useCases`, context.item.useCases, '该必产项反向引用的用例')
}

/** 圈复杂度（口径·分支）：每个被测单元的复杂度读数 + 计算口径。 */
function checkCyclomatic(context: WhiteboxContext): void {
  if (context.notApplicable) return
  const complexity = textAt(context.item.complexity).trim()
  if (complexity === '') {
    missing(context.issues, `${context.field}.complexity`, '圈复杂度读数', '没有读数的复杂度分析等于没测（REQ-056）')
  } else if (!/\d/u.test(complexity)) {
    context.issues.add(`${context.field}.complexity`, 'artifact-incomplete', `${context.field}.complexity 必须含**数**（如 \`7\` 或 \`E-N+2=7\`），当前是「${complexity}」：只有口径没有读数无法核对`)
  }
  if (textAt(context.item.method).trim() === '') {
    missing(context.issues, `${context.field}.method`, '计算口径（如 `E-N+2` / `判定数+1`）', '不知口径的复杂度读数没法复核（REQ-056）')
  }
  checkUseCases(context, `${context.field}.useCases`, context.item.useCases, '该必产项反向引用的用例')
}

/** 独立路径集（口径·路径）：基本路径法的清单；每条路径至少被一条用例覆盖。 */
function checkBasisPaths(context: WhiteboxContext): void {
  if (context.notApplicable) return
  const paths = listAt(context.item.paths)
  if (paths.length === 0) {
    missing(context.issues, `${context.field}.paths`, '独立路径清单', '没有路径清单就没有基本路径法（REQ-056）')
    return
  }
  const controlFlow = context.siblings.get('control-flow')
  const decisionIds = new Set(
    listAt(controlFlow?.decisions).filter(isRecord).map((entry) => textAt(entry.id).trim()).filter((id) => id !== ''),
  )
  const seen = new Map<string, number>()
  paths.forEach((entry, index) => {
    const field = `${context.field}.paths[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`id: …\` / \`via: [D1, D2]\`）`)
      return
    }
    const id = textAt(entry.id).trim()
    if (id === '') missing(context.issues, `${field}.id`, '路径 id', '点名"哪条路径没被覆盖"要按 id')
    else {
      const first = seen.get(id)
      if (first === undefined) seen.set(id, index)
      else context.issues.add(`${field}.id`, 'duplicate-anchor', `${field}.id 的「${id}」重复（首次在第 ${first + 1} 条）：路径重复会让独立路径集看起来更全`)
    }
    const via = listAt(entry.via).map((value) => textAt(value).trim()).filter((value) => value !== '')
    if (via.length === 0) {
      missing(context.issues, `${field}.via`, '该路径经过的判定节点', '不写经过哪几个判定的"路径"无法与图对上（REQ-056）')
    } else if (decisionIds.size > 0) {
      via.forEach((decision, viaIndex) => {
        if (!decisionIds.has(decision)) {
          context.issues.add(`${field}.via[${viaIndex}]`, 'code-unknown', `${field}.via[${viaIndex}] 的判定节点「${decision}」不在控制流图的判定节点里（控制流图有：${[...decisionIds].join(' ')}）：路径与图必须对得上`)
        }
      })
    }
    checkUseCases(context, `${field}.useCases`, entry.useCases, '该独立路径的用例')
  })
}

/** 条件组合（口径·条件）：条件桩 + 真值组合表；或用 MC/DC 的独立影响对。 */
function checkConditionCombination(context: WhiteboxContext): void {
  if (context.notApplicable) return
  const conditions = listAt(context.item.conditions)
  if (conditions.length === 0) {
    missing(context.issues, `${context.field}.conditions`, '条件桩（id + 条件内容）', '没有条件桩的组合表无从判定覆盖（REQ-056）')
  }
  const conditionIds: string[] = []
  conditions.forEach((entry, index) => {
    const field = `${context.field}.conditions[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`id: …\` / \`when: …\`）`)
      return
    }
    const id = textAt(entry.id).trim()
    if (id === '') missing(context.issues, `${field}.id`, '条件 id', '组合表要按 id 引用它')
    else conditionIds.push(id)
    if (textAt(entry.when).trim() === '') missing(context.issues, `${field}.when`, '条件内容', '只给 id 不给人话，读的人不知道这个条件是什么')
  })

  const combinations = listAt(context.item.combinations)
  const mcdc = listAt(context.item.mcdc)
  if (combinations.length === 0 && mcdc.length === 0) {
    missing(
      context.issues,
      `${context.field}.combinations`,
      '真值组合表（或 `mcdc` 独立影响对）',
      '条件组合技术要么给组合表、要么给 MC/DC 独立影响对，二者必居其一（REQ-056）',
    )
  }
  combinations.forEach((entry, index) => {
    const field = `${context.field}.combinations[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`conditions: [1,0]\` / \`expect: …\`）`)
      return
    }
    const values = listAt(entry.conditions)
    if (values.length === 0) missing(context.issues, `${field}.conditions`, '该组合的取值', '空组合不构成一次组合覆盖')
    values.forEach((value, valueIndex) => {
      const symbol = textAt(value).trim()
      if (!['0', '1', 'x', 'T', 'F', 'true', 'false'].includes(symbol)) {
        context.issues.add(`${field}.conditions[${valueIndex}]`, 'artifact-incomplete', `${field}.conditions[${valueIndex}] 只能是 1 / 0（或 x 表示不关心），当前是「${symbol}」`)
      }
    })
    if (textAt(entry.expect).trim() === '') missing(context.issues, `${field}.expect`, '该组合的期望结果', '组合不给期望就无法判定')
    checkUseCases(context, `${field}.useCases`, entry.useCases, '该组合的用例')
  })
  const seenPair = new Map<string, number>()
  mcdc.forEach((entry, index) => {
    const field = `${context.field}.mcdc[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`condition: C1\` / \`pair: [C1, C2]\`）`)
      return
    }
    const condition = textAt(entry.condition).trim()
    const pair = listAt(entry.pair).map((value) => textAt(value).trim()).filter((value) => value !== '')
    if (condition === '' && pair.length < 2) {
      missing(context.issues, field, '独立影响对（`condition` + `pair`，或直接给两个条件）', 'MC/DC 的核心是"独立影响对"，缺了它就不是 MC/DC')
    }
    if (condition !== '' && conditionIds.length > 0 && !conditionIds.includes(condition)) {
      context.issues.add(`${field}.condition`, 'code-unknown', `${field}.condition 的「${condition}」不在条件桩里（条件桩：${conditionIds.join(' ')}）`)
    }
    for (const id of pair) {
      if (conditionIds.length > 0 && !conditionIds.includes(id)) {
        context.issues.add(`${field}.pair`, 'code-unknown', `${field}.pair 里的「${id}」不在条件桩里（条件桩：${conditionIds.join(' ')}）`)
      }
    }
    const key = `${condition}|${[...pair].sort().join(',')}`
    const first = seenPair.get(key)
    if (first === undefined) seenPair.set(key, index)
    else context.issues.add(field, 'duplicate-anchor', `${field} 与第 ${first + 1} 条是同一个独立影响对：重复计数会让 MC/DC 看起来更全`)
    checkUseCases(context, `${field}.useCases`, entry.useCases, '该独立影响对的用例')
  })
  checkUseCases(context, `${context.field}.useCases`, context.item.useCases, '该必产项反向引用的用例')
}

/** 定义-使用对（口径·定义-使用对）：每对至少被一条用例覆盖。 */
function checkDefUse(context: WhiteboxContext): void {
  if (context.notApplicable) return
  const pairs = listAt(context.item.pairs)
  if (pairs.length === 0) {
    missing(context.issues, `${context.field}.pairs`, '定义-使用对清单', '没有 def-use 对就没有数据流覆盖（REQ-056）')
    return
  }
  const seen = new Map<string, number>()
  pairs.forEach((entry, index) => {
    const field = `${context.field}.pairs[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`variable: …\` / \`def: …\` / \`use: …\`）`)
      return
    }
    const variable = textAt(entry.variable).trim()
    if (variable === '') missing(context.issues, `${field}.variable`, '变量名', 'def-use 对至少要说得清是哪个变量')
    if (textAt(entry.def).trim() === '') missing(context.issues, `${field}.def`, '定义处（`相对路径:变量@行`）', '没有定义处的对无法核对')
    if (textAt(entry.use).trim() === '') missing(context.issues, `${field}.use`, '使用处（`相对路径:变量@行`）', '没有使用处的对无法核对')
    const key = `${variable}|${textAt(entry.def).trim()}|${textAt(entry.use).trim()}`
    const first = seen.get(key)
    if (first === undefined) seen.set(key, index)
    else context.issues.add(field, 'duplicate-anchor', `${field} 与第 ${first + 1} 条是同一对（${variable}）：重复计数会让数据流覆盖看起来更全`)
    checkUseCases(context, `${field}.useCases`, entry.useCases, '该定义-使用对的用例')
  })
  checkUseCases(context, `${context.field}.useCases`, context.item.useCases, '该必产项反向引用的用例')
}

const TECHNIQUE_CHECKERS: Record<WhiteboxTechnique, (context: WhiteboxContext) => void> = {
  'control-flow': checkControlFlow,
  cyclomatic: checkCyclomatic,
  'basis-paths': checkBasisPaths,
  'condition-combination': checkConditionCombination,
  'def-use': checkDefUse,
}

// —————————————————————— 六、必产项与整份真源 ——————————————————————

function checkArtifact(
  issues: Issues,
  index: number,
  item: Record<string, unknown>,
  known: WhiteboxKnownFacts | undefined,
  knownCases: readonly string[] | undefined,
  coverage: Map<WhiteboxCoverageCriterion, number>,
  declared: Map<WhiteboxCoverageCriterion, number>,
  siblings: Map<string, Record<string, unknown>>,
): void {
  const field = `artifacts[${index}]`

  // ① 技术标注
  const technique = textAt(item.technique).trim()
  if (technique === '') {
    issues.add(`${field}.technique`, 'technique-missing', `${field} 缺技术标注：必产项必须写清用了哪类白盒技术（${WHITEBOX_TECHNIQUES.join(' / ')}）—— 没有它，"这条是从结构推出来的还是抄的"无从判断`)
  } else if (!(WHITEBOX_TECHNIQUES as readonly string[]).includes(technique)) {
    issues.add(`${field}.technique`, 'technique-missing', `${field}.technique 的值「${technique}」不在白盒技术词表里（合法集合：${WHITEBOX_TECHNIQUES.join(' / ')}）`)
  } else {
    siblings.set(technique, item)
  }

  // ② 口径（五类可声明；非法取值点名合法集合）
  const rawCriterion = textAt(item.criterion).trim()
  const criterion = canonicalCriterion(rawCriterion)
  if (rawCriterion === '') {
    issues.add(
      `${field}.criterion`,
      'criterion-missing',
      `${field} 缺覆盖口径：白盒必产项要声明它服务哪一类口径 —— 合法集合：${legalCriteriaText()}`,
    )
  } else if (criterion === undefined) {
    issues.add(
      `${field}.criterion`,
      'criterion-unknown',
      `${field}.criterion 的取值「${rawCriterion}」不合法：合法集合是 ${legalCriteriaText()}（要改的是这一处取值，不是另造一套词表）`,
    )
  } else {
    declared.set(criterion, (declared.get(criterion) ?? 0) + 1)
    const expected = WHITEBOX_CRITERION_TECHNIQUES[criterion]
    if (technique !== '' && technique !== expected) {
      issues.add(
        `${field}.technique`,
        'artifact-incomplete',
        `${field} 的技术「${technique}」与口径「${criterion}」对不上：口径「${WHITEBOX_CRITERION_LABEL[criterion] ?? criterion}」要的是「${expected}」的必产项（映射见 WHITEBOX_CRITERION_TECHNIQUES）`,
      )
    }
  }

  // ③ 结构元素的**根出处**：这条必产项被测的是哪个函数/单元
  //    （REQ-056 AC-220 的第一道闸：连"测的是哪个单元"都指不到代码里，后面全是空谈）
  const rootAnchor = textAt(item.function).trim() !== '' ? item.function : item.target
  resolveCodeAnchor(`${field}.target`, rootAnchor, known?.code, issues)

  // ④ `na`（不适用）也要求有理由
  const na = textAt(item.na).trim()
  const notApplicable = na !== ''
  if (notApplicable && na.length < 2) {
    issues.add(`${field}.na`, 'artifact-incomplete', `${field}.na 要写清"为什么不适用"，不能只有一个字`)
  }
  if (!notApplicable && textAt(item.artifact).trim() === '') {
    missing(issues, `${field}.artifact`, '必产项本体（一行说清这份必产项是什么）', '空必产项等于没做设计')
  }

  // ⑤ 逐技术的最小必产项
  const context: WhiteboxContext = { issues, field, item, notApplicable, known, knownCases, usedCases: [], siblings }
  if ((WHITEBOX_TECHNIQUES as readonly string[]).includes(technique)) {
    TECHNIQUE_CHECKERS[technique as WhiteboxTechnique](context)
  } else if (notApplicable) {
    // 未标注 / 未知技术：上面已点名；`na` 的不必再追必产项
  } else if (listAt(item.useCases).length === 0) {
    issues.add(`${field}.useCases`, 'no-usecase', `${field}.useCases 至少要有一条用例：必产项没有被用例反向引用就等于凑数（REQ-056）`)
  }

  // ⑥ 覆盖计数：给出必产项本体（非 `na`）才计入 covered
  if (criterion !== undefined && !notApplicable && context.usedCases.length > 0) {
    coverage.set(criterion, (coverage.get(criterion) ?? 0) + 1)
  }
}

/** 整份真源：`design-whitebox.yml` 的根映射（`{ designWhitebox: { artifacts: [...] } }`）。 */
function validateRoot(
  design: unknown,
  known: WhiteboxKnownFacts | undefined,
  knownCases: readonly string[] | undefined,
  requireCriteria: readonly WhiteboxCoverageCriterion[],
  requireUseCase: boolean,
): WhiteboxReport {
  const issues = new Issues()
  const coverage = new Map<WhiteboxCoverageCriterion, number>()
  const declared = new Map<WhiteboxCoverageCriterion, number>()
  const siblings = new Map<string, Record<string, unknown>>()

  /**
   * 结论口径（两句话，都要能说清"我到底判了什么"）：
   *
   * ① **缺项 = unknown，不是 invalid**：一类口径的必产项**根本没写**时，没有"错误的内容"可指认 ——
   *    "没得可判"与"判它错"是两件事，混成一件会让回执谎称"内容有错"。
   * ② **有具体问题时报 invalid，即使同时还缺项**：一份真源既缺一类口径、又有一条口径取值非法时，
   *    回执必须说得出"哪条取值非法"（改一处就能修），不能被"缺项"一句盖住。
   *
   * 判据（两条，都是机械的）：
   *   · `EXPLANATORY_CODES` 里的码**全部**是"没得可判"（缺项 / 整份读不动）⇒ `unknown`；
   *   · 但只要出现**一个**"内容有问题"的码（取值非法、字段类型不对、结构元素查不到…）⇒ `invalid`，
   *     并且那条问题会原样留在 `issues` 里（回执因此永远说得出"改哪一处"）。
   *   · 形状层读不动（整份不是映射、`artifacts` 不是列表、列表项不是映射）由 `structureUnreadable`
   *     单独兜住 ⇒ 无论还收集到什么都判 `unknown`（连结构都没读出来，谈不上"判它错"）。
   */
  const EXPLANATORY_CODES: readonly WhiteboxIssueCode[] = ['technique-missing']
  let structureUnreadable = false
  const finish = (unknownReason: string): WhiteboxReport => {
    const onlyExplanatory = issues.list.length > 0 && issues.list.every((issue) => EXPLANATORY_CODES.includes(issue.code))
    const outcome: WhiteboxReport['outcome'] =
      structureUnreadable ? 'unknown' : issues.list.length === 0 ? 'ok' : onlyExplanatory ? 'unknown' : 'invalid'
    const reason = structureUnreadable ? unknownReason || '这份真源的形状读不出来' : onlyExplanatory ? unknownReason || '必产项缺项：没有可判的内容' : ''
    return {
      outcome,
      issues: issues.list,
      coverage: WHITEBOX_COVERAGE_CRITERIA.map((criterion) => ({
        criterion,
        label: WHITEBOX_CRITERION_LABEL[criterion] ?? criterion,
        technique: WHITEBOX_CRITERION_TECHNIQUES[criterion],
        declared: declared.get(criterion) ?? 0,
        covered: coverage.get(criterion) ?? 0,
      })),
      // 结论是 unknown 时必须说得出为什么
      unknownReason: reason,
    }
  }

  if (!isRecord(design)) {
    issues.add('', 'unknown', `design 必须是映射（\`designWhitebox: { artifacts: [...] }\`），当前是 ${design === null ? 'null' : Array.isArray(design) ? 'array' : typeof design}`)
    structureUnreadable = true
    return finish('整份真源不是映射，读不出必产项')
  }
  const raw = design.artifacts
  if (raw === undefined || raw === null) {
    issues.add('artifacts', 'technique-missing', 'artifacts 必填：声明使用白盒技术就必须交付其最小必产项 —— 整份真源缺了它，等于没有白盒设计规格')
    return finish('没有 artifacts：没有任何必产项可核对')
  }
  if (!Array.isArray(raw)) {
    issues.add('artifacts', 'unknown', `artifacts 必须是列表，当前是 ${typeof raw}`)
    structureUnreadable = true
    return finish('artifacts 不是列表')
  }
  if (raw.length === 0) {
    issues.add('artifacts', 'technique-missing', 'artifacts 不能为空：至少要有五类口径（语句 / 分支 / 路径 / 条件 / 定义-使用对）对应的必产项 —— 空清单不是"还没写"，是"没有设计"')
    return finish('artifacts 为空')
  }

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.add(`artifacts[${index}]`, 'unknown', `artifacts[${index}] 必须是映射（\`- id: …\` / \`technique: …\`），当前是 ${Array.isArray(entry) ? 'array' : entry === null ? 'null' : typeof entry}`)
      structureUnreadable = true
      return
    }
    checkArtifact(issues, index, entry, known, knownCases, coverage, declared, siblings)
  })

  // 五类口径齐不齐（缺 ⇒ unknown：不是"判红"，是"没得可判"）
  const missingCriteria = requireCriteria.filter((criterion) => !declared.has(criterion))
  // 只有在**没有更具体的问题**时才报"缺一类口径"：那条是对症状的概括（"你少了一类"），
  // 而具体问题（某条口径取值非法 / 某条必产项缺字段）才是病因。两者一起报会让回执把
  // "改一个词"说成"补一整类"，也会把本该 invalid 的结论压成 unknown（实测踩到过）。
  const hasConcreteIssue = issues.list.some((issue) => issue.code !== 'technique-missing')
  if (!hasConcreteIssue) {
    for (const criterion of missingCriteria) {
      issues.add(
        'artifacts',
        'technique-missing',
        `artifacts 里没有口径「${WHITEBOX_CRITERION_LABEL[criterion] ?? criterion}」(${criterion}) 的必产项：本卡交付的五类结构覆盖口径逐类都要有（REQ-056）`,
      )
    }
  }

  if (requireUseCase) {
    const anyCase = raw.some((entry) => isRecord(entry) && listAt(entry.useCases).some((value) => textAt(value).trim() !== ''))
    if (!anyCase) {
      issues.add('artifacts[].useCases', 'no-usecase', '没有任何必产项带用例反向引用：REQ-056 的防凑数条款要求每条必产项被至少一条用例引用')
    }
  }

  const unknownReason =
    missingCriteria.length > 0 && !hasConcreteIssue
      ? `artifacts 里缺 ${missingCriteria.length} 类口径的必产项（${missingCriteria.map((criterion) => WHITEBOX_CRITERION_LABEL[criterion] ?? criterion).join(' / ')}）：没得可判，不是判红`
      : ''
  return finish(unknownReason)
}

export interface ValidateWhiteboxOptions {
  known?: WhiteboxKnownFacts | undefined
  /** 要求齐备的口径（默认五类）。 */
  requireCriteria?: readonly WhiteboxCoverageCriterion[] | undefined
  /** 是否要求存在用例反向引用（默认 true）。 */
  requireUseCase?: boolean | undefined
  /** 已落盘的用例 id（给了就核"用例确实存在"）。 */
  testCaseIds?: readonly string[] | undefined
}

/** 校验一份白盒设计规格（`design-whitebox.yml` 的根映射）。fail-closed：意外一律 `unknown`。 */
export function validateWhiteboxDesign(design: unknown, options: ValidateWhiteboxOptions = {}): WhiteboxReport {
  try {
    return validateRoot(
      design,
      options.known,
      options.testCaseIds,
      options.requireCriteria ?? WHITEBOX_COVERAGE_CRITERIA,
      options.requireUseCase ?? true,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      outcome: 'unknown',
      issues: [{ field: '', code: 'unknown', message: `校验器读不动这份真源：${message}（按 fail-closed 口径判 unknown，不是 ok）` }],
      coverage: [],
      unknownReason: `校验过程抛出异常：${message}`,
    }
  }
}

// —————————————————————— 七、读写与落盘闸门 ——————————————————————

/** 真源位置（相对 `.sdo/`；与 `testingStore` 的 `design-whitebox` 文件同址）。 */
export const WHITEBOX_DESIGN_PATH = 'testing/design-whitebox.yml'

/** 根键（`testingStore.rootKeyOf` 的口径：`design-whitebox` → `designWhitebox`）。 */
export const WHITEBOX_DESIGN_ROOT_KEY = 'designWhitebox'

export interface WhiteboxReadResult {
  status: 'ok' | 'missing' | 'invalid' | 'unknown'
  design?: unknown
  reason: string
}

/** 只读：读回真源（永不抛）。 */
export function readWhiteboxDesign(store: SdoStore): WhiteboxReadResult {
  try {
    const raw = store.readYaml<Record<string, unknown>>('testing', 'design-whitebox.yml')
    if (raw === undefined) return { status: 'missing', reason: '`.sdo/testing/design-whitebox.yml` 不存在' }
    const root = isRecord(raw) ? raw[WHITEBOX_DESIGN_ROOT_KEY] : undefined
    if (root === undefined) return { status: 'missing', reason: '`.sdo/testing/design-whitebox.yml` 里没有 `designWhitebox:` 根键（半成品真源）' }
    if (!isRecord(root)) return { status: 'invalid', design: root, reason: '`designWhitebox:` 根键不是映射（应当是 `artifacts: [...]`）' }
    return { status: 'ok', design: root, reason: '' }
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}

export interface WhiteboxWriteResult {
  written: boolean
  outcome: WhiteboxReport['outcome']
  report: WhiteboxReport
  hash: string
  path: string
  replaced: boolean
}

/**
 * **落盘闸门**：先校验整份，`outcome==='ok'` 才写；否则如实回报并**不写盘**。
 *
 * 两态守卫（本卡 DoD 第 3 条）：**合法必产项 ⇒ 写；非法取值 / 缺必产项 / 出处查不到 ⇒ 一个字节都不写**。
 */
export function writeValidatedWhiteboxDesign(
  store: SdoStore,
  design: unknown,
  options: ValidateWhiteboxOptions = {},
): WhiteboxWriteResult {
  const report = validateWhiteboxDesign(design, options)
  if (report.outcome !== 'ok') {
    return { written: false, outcome: report.outcome, report, hash: '', path: WHITEBOX_DESIGN_PATH, replaced: false }
  }
  const hash = contentHash(design)
  const replaced = store.exists('testing', 'design-whitebox.yml')
  store.writeYaml(['testing', 'design-whitebox.yml'], { [WHITEBOX_DESIGN_ROOT_KEY]: design })
  return { written: true, outcome: 'ok', report, hash, path: WHITEBOX_DESIGN_PATH, replaced }
}

/** 已落盘真源的内容指纹（未落盘给空串）。 */
export function whiteboxDesignFingerprint(store: SdoStore): string {
  const read = readWhiteboxDesign(store)
  if (read.status !== 'ok') return ''
  return contentHash(read.design)
}

/** 真源在盘上的原始字节（`written=false` 的反证用：文件不存在 ⇒ 空串）。 */
export function rawWhiteboxDesignText(store: SdoStore): string {
  try {
    return readFileSync(join(store.root, 'testing', 'design-whitebox.yml'), 'utf8')
  } catch {
    return ''
  }
}
