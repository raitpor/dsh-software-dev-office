/**
 * **测试设计规格·黑盒技术**（REQ-048 / DES-031 的 `design` 类真源）。
 *
 * 本模块回答**一个**问题：这份测试设计规格里的必产项，是不是"真做过黑盒设计"？
 * 答"不是"或"答不上来"时，**一个字节都不许落盘**。
 *
 * ## 与相邻模块的分工（免得后人重复造）
 *
 * · `testingShapes.ts`（TASK-012）：**形状**校验 —— 键在不在、类型对不对、枚举值认不认。
 * · `testingStore.ts`（TASK-001）：读写、指纹、过期判定。
 * · **本模块**：**内容**校验 —— 必产项的**最小必产项**齐不齐（REQ-048 逐技术给出）、
 *   域有没有真源出处、用例有没有反向引用、迁移表/判定表内部自洽不（状态表里没有的状态、
 *   动作桩里没有的动作、规则数与条件数的 2 次方不等且没逐条标注不可能）。
 *   形状对、内容空 —— 这正是"接入了方法论却没做事"最常见的样子，故单列一层。
 *
 * ## 四条纪律
 *
 * ① **fail-closed**：校验器**自己不抛异常**。读不动、形状怪、意外抛错一律收敛成
 *    `outcome='unknown'`，而 `unknown` **不是** `ok` —— 落盘闸门只认 `ok`
 *    （与 REQ-041「未实现判据一律判失败」、`testingShapes` 的 F-20 口径同源）。
 * ② **整次拒绝、不落半成品**：`writeValidatedTestDesign` 校验不过就**不写盘**。
 *    半成品真源比没有真源更危险：渲染与门禁只认真源，半成品会让文档和判据一起说谎。
 * ③ **点名到字段**：每条问题带点号路径（`artifacts[1].classes[0].kind`），
 *    人拿着它就能在 YAML 里定位，不必先学会读代码。
 * ④ **防凑数两条**：必产项必须被**至少一条用例反向引用**；必产项的**域**必须能指到
 *    真源出处（验收标准 / 契约字段 / 设计元素里的枚举），**查不到即判红**，不许凭空发明。
 *
 * ## 本模块**不**判什么（写明边界，免得被当成整条需求的验收）
 *
 * · **不判设计得好不好**：等价类划得对不对、边界点选得准不准，都属人的判断。
 *   这里只核"必产项在不在、指的是不是真源、有没有用例引用"。
 * · **不判 scenario / combination 两个技术**：本模块只交付四类技术的必产项校验
 *   （等价类 / 边界值 / 判定表 / 状态迁移 —— 本卡的 DoD）。真源里出现了这两个技术时，
 *   报告会进 `deferred` 并**判 `unknown`**：它们已经在 REQ-048 的词表里，但"我们验过了"
 *   这句话此刻是假的 —— 与其静默放过，不如把未覆盖面**显式报出来**。
 * · **不写台账 journal**：本模块只负责"这份真源能不能落"。落盘留痕由调用方决定
 *   （与 `testingShapes` 同口径：它也不碰 journal）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { contentHash } from './hash.js'
import { SdoStore } from '../infra/store.js'
import { textOf } from '../infra/scalar.js'

// —————————————————————— 一、结论的形状 ——————————————————————

/**
 * 内容校验的问题码。
 *
 * 与 `TESTING_SHAPE_ISSUE_CODES`（形状）**分开**：两者混用会让"形状不对"与"内容不齐"
 * 在回执里长得一模一样，读的人分不清该去改 YAML 还是去补设计。
 */
export const TEST_DESIGN_ISSUE_CODES = [
  /** 缺技术标注 / 整份缺必产项 / 缺最小必产项字段 —— **本卡守卫用例**拦的就是这一码。 */
  'technique-missing',
  /** 技术标注的值不在词表里。 */
  'technique-unknown',
  /** 必产项声明的技术，本模块**还没有**内容校验器（scenario / combination）。 */
  'technique-deferred',
  /** 该技术的**最小必产项**缺字段。 */
  'artifact-incomplete',
  /** 必产项没被任何用例反向引用（防凑数）。 */
  'no-usecase',
  /** 用例 id 在已落盘用例里查不到。 */
  'usecase-unknown',
  /** 用例引用了**没标注技术**的必产项。 */
  'usecase-untechniqued',
  /** 必产项的域 / 出处**查不到真源**（不许凭空发明）。 */
  'domain-unknown',
  /** 必备产项缺 `domainSource` 字段（与"写了但查不到"分开点名）。 */
  'domain-source-missing',
  /** 回溯不到需求或设计元素。 */
  'traceability-missing',
  /** 引用的需求 / 设计元素在台账里查不到。 */
  'traceability-unknown',
  /** 等价类没有有效类，或没有无效类（REQ-048 AC-194）。 */
  'class-absent',
  /** 判定表的规则数与条件数的 2 次方不等，且没逐条标注不可能并给理由（AC-195）。 */
  'rule-incomplete',
  /** 状态迁移表内部不自洽（状态/迁移 id 对不上、非法迁移没被点名）。 */
  'transition-inconsistent',
  /** 域重复声明（同一个域两行会让"覆盖"重复计数）。 */
  'domain-dup',
  /** 收尾兜底：校验器读不动或意外抛错。 */
  'unknown',
] as const

export type TestDesignIssueCode = (typeof TEST_DESIGN_ISSUE_CODES)[number]

/**
 * 一条**可执行**的内容问题。
 *
 * `field` 用点号路径且**对数组下标显式编号**（`artifacts[1].classes[0].kind`）：
 * 与 `testingShapes` 的 `TestingShapeIssue.field` 同口径，两边的回执可以并排读。
 */
export interface TestDesignIssue {
  /** 点号路径（空串 = 整份真源层面，例如"没有必产项"）。 */
  field: string
  code: TestDesignIssueCode
  /** 面向人的说明：**这条为什么会拒**。 */
  message: string
}

/** 本卡交付的**四类**黑盒技术（DoD 逐字：等价类划分、边界值、判定表、状态迁移）。 */
export const TEST_DESIGN_TECHNIQUES = ['equivalence', 'boundary', 'decision-table', 'state-transition'] as const

export type TestDesignTechnique = (typeof TEST_DESIGN_TECHNIQUES)[number]

/** 技术键 → 人话标签（回执与文档共用，不另造第二份）。 */
export const TEST_DESIGN_TECHNIQUE_LABEL: Record<string, string> = {
  equivalence: '等价类划分',
  boundary: '边界值分析',
  'decision-table': '判定表',
  'state-transition': '状态迁移',
  scenario: '场景法',
  combination: '组合法',
}

/**
 * **词表里的全部**黑盒技术（REQ-048 六类）。
 *
 * 为什么与 `TEST_DESIGN_TECHNIQUES` 分开：四类是**验过的**，这两类是**词表里有、校验器还没有**的。
 * 出现后者时报告判 `unknown`（见 `deferred`），而不是假装验过。
 */
export const TEST_DESIGN_KNOWN_TECHNIQUES = [...TEST_DESIGN_TECHNIQUES, 'scenario', 'combination'] as const

/** 每个技术在其必产项里**必须有**的字段（回执里点名"缺什么"时按它列）。 */
export const TEST_DESIGN_MIN_FIELDS: Record<TestDesignTechnique, readonly string[]> = {
  equivalence: ['domain', 'classes[].kind', 'classes[].value', 'classes[].useCases', 'domainSource', 'requirementRef'],
  boundary: ['domain', 'boundaries[].point', 'boundaries[].kind', 'boundaries[].useCases', 'domainSource', 'requirementRef'],
  'decision-table': ['conditions[]', 'actions[]', 'rules[]', 'rules[].conditions', 'rules[].actions', 'rules[].useCases'],
  'state-transition': ['states[]', 'transitions[].from', 'transitions[].to', 'transitions[].useCases', 'invalidTransitions[].useCases'],
}

/** 一个技术的覆盖读数：声明了几条 / 其中几条**真的**给出了必产项（`na` 的算声明不算给出）。 */
export interface TestDesignTechniqueCoverage {
  technique: string
  label: string
  declared: number
  covered: number
}

/** 一次校验的结论。`outcome !== 'ok'` ⇒ 不许落盘。 */
export interface TestDesignReport {
  outcome: 'ok' | 'invalid' | 'unknown'
  issues: TestDesignIssue[]
  /** 谓词生效时（`requireUseCase`）该技术声明的必产项条数。 */
  coverage: TestDesignTechniqueCoverage[]
  /** 判 `unknown` 的人话原因（`outcome==='unknown'` 时非空）。 */
  unknownReason: string
}

// —————————————————————— 二、真源台账（域出处的对手方） ——————————————————————

/**
 * **域出处的对手方**：四张"台账里真有的东西"清单。
 *
 * REQ-048 的防凑数条款要求必产项的域能指到**验收标准 / 契约字段 / 代码里的枚举**之一。
 * 因此这里必须拿着台账**对一遍**，不能只看字符串格式像不像 —— 格式像而台账没有，
 * 正是"凭空发明"最省事的样子。
 */
export interface TestDesignKnownFacts {
  /** REQ-xxx → 该需求的验收标准 id 列表。 */
  requirements: Map<string, string[]>
  /** CT-xxx → 该契约里出现过的字段名（含 `failureSemantics` 之类的键）。 */
  contracts: Map<string, string[]>
  /** DES-xxx → 该设计元素里出现过的枚举取值。 */
  designElements: Map<string, string[]>
}

/** 空的台账（调用方没给事实时的缺省：只核格式，不凭空判红）。 */
export function emptyKnownFacts(): TestDesignKnownFacts {
  return { requirements: new Map(), contracts: new Map(), designElements: new Map() }
}

const REQ_RE = /^REQ-\d{3,6}$/u
const DES_RE = /^DES-\d{3,6}$/u

/** 文件文本里所有匹配的编号（按出现顺序、去重；结果**去空白** —— 行首缩进会被一起匹配到）。 */
function idsIn(text: string, pattern: RegExp): string[] {
  const out: string[] = []
  for (const match of text.matchAll(pattern)) {
    const id = match[0].trim()
    if (id !== '' && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 从**一行 YAML**里取某个键的值（`id: REQ-048` / `- id: AC-194`）。
 *
 * 为什么按"行"扫而不是按"编号字面"扫：真源是人手写的 YAML，编号总是**键的值**
 * （`id: REQ-048`）或**列表项**（`- id: AC-194`），行内引用也不是没有（`requires: [REQ-001]`）；
 * 光按 `REQ-\d+` 扫会把注释、说明文字里的编号一起收进来，于是"台账里有这条需求"变成
 * "文档里提过这四个字母"—— 判绿的方向一旦松，`domain-unknown` 就再也拦不住凑数了。
 */
function keyedIds(text: string, key: string, pattern: RegExp): string[] {
  const re = new RegExp(String.raw`^\s*(?:-\s*)?${key}\s*:\s*(${pattern.source})\s*$`, 'gmu')
  const out: string[] = []
  for (const match of text.matchAll(re)) {
    const id = match[1]?.trim()
    if (id !== undefined && id !== '' && !out.includes(id)) out.push(id)
  }
  return out
}

const REQ_ID = /REQ-\d{3,6}/u
const AC_ID = /AC-\d{3,6}/u
const CT_ID = /CT-\d{3,6}/u

/**
 * 从台账里**收集**域出处的对手方（只读，坏文件跳过而不是抛 —— 读路径永不抛异常）。
 *
 * 为什么扫文本而不是逐个 `readYaml`：`.sdo/` 下的人改真源文件是**给人手改**的，
 * 半截文件、缩进走样都会让解析抛错；而"域出处核对"这件事只需要**编号在不在**，
 * 不值得为此让整个校验挂掉（F-20 口径）。代价是"注释里的编号也算数" —— 可接受：
 * 判红的方向比判绿的方向危险得多，宽一点不会掩盖缺项。
 */
export function collectKnownFacts(store: SdoStore): TestDesignKnownFacts {
  const facts = emptyKnownFacts()

  for (const name of store.listNames('requirements')) {
    if (!name.endsWith('.yml')) continue
    const text = store.readText('requirements', name) ?? ''
    const id = keyedIds(text, 'id', REQ_ID)[0] ?? idsIn(text, /^\s*REQ-\d{3,6}\s*$/gmu)[0]
    if (id === undefined) continue
    facts.requirements.set(id, keyedIds(text, 'id', AC_ID))
  }

  for (const name of store.listNames('contracts')) {
    if (!name.endsWith('.yml')) continue
    const text = store.readText('contracts', name) ?? ''
    const id = keyedIds(text, 'id', CT_ID)[0]
    if (id === undefined) continue
    const fields: string[] = []
    for (const match of text.matchAll(/^\s{2,}([A-Za-z][A-Za-z0-9_-]*):/gmu)) {
      const field = match[1]
      if (field !== undefined && !fields.includes(field)) fields.push(field)
    }
    facts.contracts.set(id, fields)
  }

  for (const name of store.listNames('design')) {
    if (!name.endsWith('.yml')) continue
    const text = store.readText('design', name) ?? ''
    // 设计元素里的枚举：`id: DES-013` 之后出现的 `enum:` / `values:` / `取值:`
    let current = ''
    for (const line of text.split('\n')) {
      const element = /^\s*(?:-\s*)?id\s*:\s*(DES-\d{3,6})\s*$/u.exec(line)
      if (element?.[1] !== undefined) {
        current = element[1]
        if (!facts.designElements.has(current)) facts.designElements.set(current, [])
        continue
      }
      const enumLine = /^\s*(?:enum|values|取值|枚举)\s*:\s*(.+)$/u.exec(line)
      if (enumLine?.[1] === undefined || current === '') continue
      const values = facts.designElements.get(current)
      if (values === undefined) continue
      for (const token of enumLine[1].split(/[,\s[\]]+/u)) {
        const value = token.trim()
        if (value !== '' && !values.includes(value)) values.push(value)
      }
    }
  }

  return facts
}

// —————————————————————— 三、小工具（一律不抛） ——————————————————————

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 标量的文本（`scalar.ts` 口径），非标量给空串 —— 校验器只想知道"有没有话"。 */
function textAt(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? textOf(value) : ''
}

function listAt(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 问题收集器：同一（路径, 码）只报一次（同义重复会让人以为有很多问题）。 */
class Issues {
  private readonly items: TestDesignIssue[] = []
  private readonly seen = new Set<string>()

  add(field: string, code: TestDesignIssueCode, message: string): void {
    const key = `${field}\u0000${code}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.items.push({ field, code, message })
  }

  get list(): TestDesignIssue[] {
    return this.items
  }
}

/** 缺字段的**统一说法**：缺什么 + 为什么不能缺（同一条技术共用一句话）。 */
function missing(issues: Issues, field: string, what: string, why: string): void {
  issues.add(field, 'artifact-incomplete', `${field} 必填：${what} —— ${why}`)
}

// —————————————————————— 四、四类技术的最小必产项 ——————————————————————

/** 逐技术的校验上下文（省得每个校验器都接一长串参数）。 */
interface TechniqueContext {
  issues: Issues
  field: string
  item: Record<string, unknown>
  /** `na` 非空 ⇒ 该必产项声明"不适用"（整条不必给必产项本体）。 */
  notApplicable: boolean
  known: TestDesignKnownFacts | undefined
  /** 已落盘的用例 id（未提供 ⇒ 只核"非空"，不凭空判红）。 */
  knownCases: readonly string[] | undefined
  /** 该必产项声明的用例（回填给"反向引用"与"用例确实存在"两道闸）。 */
  usedCases: string[]
}

/**
 * 域出处的核对（REQ-048 / AC-196）。
 *
 * 三选一即可：验收标准编号（`AC-194`）、契约字段（`CT-024.schema`）、设计元素里的枚举
 * （`DES-013.values` 或直接给 `DES-013`）。**给得出编号但台账里查不到 ⇒ 判红**；
 * 台账没提供（`known` 未给）⇒ 只核格式，不凭空判红（同样是不冤枉人的方向）。
 *
 * @returns 认下来的出处（回执用），查不到给 `undefined`。
 */
export function resolveDomainSource(
  issueField: string,
  raw: string,
  known: TestDesignKnownFacts | undefined,
  issues: Issues,
): string | undefined {
  const value = raw.trim()
  if (value === '') {
    issues.add(issueField, 'domain-source-missing', `${issueField} 必填：域的出处（验收标准 / 契约字段 / 代码里的枚举）—— 凭空发明的域不许计入覆盖`)
    return undefined
  }

  // ① 验收标准：`AC-194` 或 `REQ-048:AC-194`
  const acs = idsIn(value, /AC-\d{3,6}/gu).slice(0, 1)
  if (acs.length > 0) {
    const ac = acs[0] as string
    if (known === undefined) return ac
    const hit = [...known.requirements.values()].some((list) => list.includes(ac))
    if (!hit) {
      issues.add(issueField, 'domain-unknown', `${issueField} 指向的验收标准「${ac}」在需求台账里查不到（已有：${known.requirements.size === 0 ? '（无）' : [...known.requirements.values()].flat().join(' ') || '（无）'}）：域出处必须能核对，不得凭空发明（REQ-048 AC-196）`)
      return undefined
    }
    return ac
  }

  // ② 契约字段：`CT-024.schema` / `CT-024.failureSemantics.timeout`
  const ctRaw = idsIn(value, /CT-\d{3,6}(?:\.[A-Za-z0-9_.-]+)?/gu)[0] ?? ''
  const contract = ctRaw === '' ? undefined : `${ctRaw.split('.')[0] ?? ''}|${ctRaw.split('.').slice(1).join('.')}`
  if (contract !== undefined) {
    const [id = '', path = ''] = contract.split('|')
    if (known === undefined) return ctRaw
    const fields = known.contracts.get(id)
    if (fields === undefined) {
      issues.add(issueField, 'domain-unknown', `${issueField} 指向的契约「${id}」在契约台账里查不到（已有：${known.contracts.size === 0 ? '（无）' : [...known.contracts.keys()].join(' ')}）`)
      return undefined
    }
    const root = path.split('.')[0] ?? path
    if (root !== '' && !fields.includes(root)) {
      issues.add(issueField, 'domain-unknown', `${issueField} 指向的契约字段「${id}.${root}」在 ${id} 里查不到（该契约的字段有：${fields.length === 0 ? '（无）' : fields.join(' ')}）`)
      return undefined
    }
    return ctRaw
  }

  // ③ 设计元素（含其枚举取值）
  const desRaw = idsIn(value, /DES-\d{3,6}(?:\.[A-Za-z0-9_.-]+)?/gu)[0] ?? ''
  const des = idsIn(value, /DES-\d{3,6}/gu).slice(0, 1)
  if (des.length > 0) {
    const id = des[0] as string
    if (known === undefined) return desRaw
    if (!known.designElements.has(id)) {
      issues.add(issueField, 'domain-unknown', `${issueField} 指向的设计元素「${id}」在设计台账里查不到（已有：${known.designElements.size === 0 ? '（无）' : [...known.designElements.keys()].join(' ')}）`)
      return undefined
    }
    return desRaw
  }

  issues.add(
    issueField,
    'domain-unknown',
    `${issueField} 的出处「${value}」不是可核对的形态：要写验收标准（\`AC-194\`）、契约字段（\`CT-024.schema\`）或设计元素（\`DES-013.values\`）之一 —— 纯文字说明无法核对（REQ-048 AC-196）`,
  )
  return undefined
}

/**
 * 该必产项的域与它的出处（REQ-048 AC-196）：
 * `domain` 是**人读的域描述**（必填），`domainSource` 才是**送核的出处引用**。
 *
 * 两者分开是有意的（实测踩到过）：把整句域描述丢进核对器，句子里"顺手提了一句 AC-194"
 * 就会让真正的出处（`CT-024.failureSemantics`）永远匹配不上 —— 于是**合法的真源被误判红**。
 * 判红的代价比放过高，所以出处只认 `domainSource` 这一个字段，一句一句地对。
 */
function checkDomain(context: TechniqueContext, what: string): void {
  const domain = textAt(context.item.domain)
  if (domain === '') {
    missing(context.issues, `${context.field}.domain`, what, '没有它，"覆盖了哪些域"无从谈起')
  }
  if (context.notApplicable) return
  resolveDomainSource(`${context.field}.domain`, textAt(context.item.domainSource), context.known, context.issues)
}

/** 必产项里的用例引用：非空 + 台账里查得到（REQ-048 的防凑数条款）。 */
function checkUseCases(context: TechniqueContext, field: string, value: unknown, what: string): void {
  const entries = listAt(value)
  if (entries.length === 0) {
    missing(context.issues, field, `${what}（至少一条用例）`, '必产项没有被用例反向引用就等于凑数（REQ-048）')
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

/** 等价类划分（REQ-048 / AC-194）：每个输入域至少一个有效类与一个无效类。 */
function checkEquivalence(context: TechniqueContext): void {
  checkDomain(context, '等价类划分的输入域')
  const classes = listAt(context.item.classes)
  if (classes.length === 0) {
    missing(context.issues, `${context.field}.classes`, '等价类清单（有效类与无效类）', '没有类就没有划分')
    return
  }
  let valid = 0
  let invalid = 0
  classes.forEach((entry, index) => {
    const field = `${context.field}.classes[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`kind: valid\` / \`value: …\`）`)
      return
    }
    const kind = textAt(entry.kind).trim()
    if (kind === 'valid') valid += 1
    else if (kind === 'invalid') invalid += 1
    else {
      context.issues.add(`${field}.kind`, 'artifact-incomplete', `${field}.kind 必须是 valid / invalid（不猜同义词）：当前是「${kind}」`)
    }
    if (textAt(entry.value).trim() === '') missing(context.issues, `${field}.value`, '该类的取值或描述', '空类的覆盖是假的')
    checkUseCases(context, `${field}.useCases`, entry.useCases, '该类的用例')
  })
  if (valid === 0) {
    context.issues.add(`${context.field}.classes`, 'class-absent', `${context.field}.classes 里没有**有效类**：每个输入域都要有有效类与无效类各至少一个（REQ-048 AC-194）`)
  }
  if (invalid === 0) {
    context.issues.add(`${context.field}.classes`, 'class-absent', `${context.field}.classes 里没有**无效类**：只测有效输入的划分不算等价类划分（REQ-048 AC-194）`)
  }
  // 必产项**自身**声明的用例也要核（只有逐类的用例不算：`useCases` 是"这条必产项被谁引用"的正门）
  checkUseCases(context, `${context.field}.useCases`, context.item.useCases, '该必产项反向引用的用例')
}

/** 边界值分析（REQ-048）：有序 / 范围域给出边界点表，或显式声明不适用并写理由。 */
function checkBoundary(context: TechniqueContext): void {
  // `na` 已由调用方核过"有理由" ⇒ 这里整条不必给边界点表（REQ-048 的降级口径）
  if (context.notApplicable) return
  checkDomain(context, '边界值分析的域')
  const boundaries = listAt(context.item.boundaries)
  if (boundaries.length === 0) {
    missing(context.issues, `${context.field}.boundaries`, '边界点表', '没有边界点的边界值分析是空壳；不适用请写 `na` 并给理由')
    return
  }
  boundaries.forEach((entry, index) => {
    const field = `${context.field}.boundaries[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`point: …\` / \`kind: …\`）`)
      return
    }
    if (textAt(entry.point).trim() === '') missing(context.issues, `${field}.point`, '边界点的取值或描述', '不写点位的边界表无法核对')
    if (textAt(entry.kind).trim() === '') missing(context.issues, `${field}.kind`, '边界类型（min / max / just-below / just-above …）', '不分类就看不出边界点选全了没有')
    checkUseCases(context, `${field}.useCases`, entry.useCases, '该边界点的用例')
  })
}

/** 判定表（REQ-048 / AC-195）：条件桩、动作桩与规则表；规则不齐逐条标注不可能并给理由。 */
function checkDecisionTable(context: TechniqueContext): void {
  if (context.notApplicable) return
  checkDomain(context, '判定表覆盖的条件组合域')
  const conditions = listAt(context.item.conditions)
  const actions = listAt(context.item.actions)
  const rules = listAt(context.item.rules)
  if (conditions.length === 0) {
    missing(context.issues, `${context.field}.conditions`, '条件桩（条件 id + 描述）', '没有条件桩的判定表只剩一张动作清单')
  }
  if (actions.length === 0) {
    missing(context.issues, `${context.field}.actions`, '动作桩（动作 id + 描述）', '没有动作桩就无从判定"该做什么"')
  }
  if (rules.length === 0) {
    missing(context.issues, `${context.field}.rules`, '规则表', '没有规则就不叫判定表')
  }
  if (context.issues.list.length > 0 && (conditions.length === 0 || rules.length === 0)) return

  const conditionIds: string[] = []
  conditions.forEach((entry, index) => {
    const field = `${context.field}.conditions[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`id: …\` / \`when: …\`）`)
      return
    }
    const id = textAt(entry.id).trim()
    if (id === '') missing(context.issues, `${field}.id`, '条件 id', '规则表要按 id 引用它')
    else conditionIds.push(id)
    if (textAt(entry.when).trim() === '') missing(context.issues, `${field}.when`, '条件的判断内容', '只给 id 不给人话，读的人不知道这个条件是什么')
  })
  const actionIds: string[] = []
  actions.forEach((entry, index) => {
    const field = `${context.field}.actions[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`id: …\` / \`then: …\`）`)
      return
    }
    const id = textAt(entry.id).trim()
    if (id === '') missing(context.issues, `${field}.id`, '动作 id', '规则表要按 id 引用它')
    else actionIds.push(id)
    if (textAt(entry.then).trim() === '') missing(context.issues, `${field}.then`, '动作的内容', '只给 id 不给人话，读的人不知道这个动作是什么')
  })

  // 规则表：条件取值 + 动作 + 用例
  /** 每条规则覆盖的条件取值组合（`1-0-0`；`x` = 未表态，即"不关心"）。 */
  const covered = new Map<string, number>()
  const impossible = new Map<string, number>()
  const missingReason: number[] = []
  rules.forEach((entry, index) => {
    const field = `${context.field}.rules[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`conditions: …\` / \`actions: …\`）`)
      return
    }
    const id = textAt(entry.id).trim()
    if (id === '') context.issues.add(`${field}.id`, 'artifact-incomplete', `${field}.id 必填：规则是"点名不可能"的唯一解（缺了它只能整表判红）`)
    const values = listAt(entry.conditions)
    values.forEach((value, valueIndex) => {
      const symbol = textAt(value).trim().toLowerCase()
      if (!['0', '1', 'x', 'n/a', 'none', ''].includes(symbol)) {
        context.issues.add(`${field}.conditions[${valueIndex}]`, 'artifact-incomplete', `${field}.conditions[${valueIndex}] 只能是 1 / 0 / x（未表态即"不关心"），当前是「${symbol}」`)
      }
    })
    // 列出该规则的动作，并核对动作桩里有这个 id
    const actionIdsOfRule = listAt(entry.actions).map((value) => textAt(value).trim()).filter((value) => value !== '')
    actionIdsOfRule.forEach((id2, actionIndex) => {
      if (actionIds.length > 0 && !actionIds.includes(id2)) {
        context.issues.add(`${field}.actions[${actionIndex}]`, 'artifact-incomplete', `${field}.actions[${actionIndex}] 的动作「${id2}」不在动作桩里（动作桩：${actionIds.join(' ')}）`)
      }
    })
    if (entry.impossible === true) {
      const reason = textAt(entry.reason).trim()
      if (reason === '') missingReason.push(index + 1)
      const key = values.map((value) => textAt(value).trim().toLowerCase()).join('-')
      impossible.set(key, (impossible.get(key) ?? 0) + 1)
      checkUseCases(context, `${field}.useCases`, entry.useCases, '该规则的用例')
      return
    }
    if (actionIdsOfRule.length === 0) {
      missing(context.issues, `${field}.actions`, '该规则触发的动作', '规则不指向动作就无法判定')
    }
    checkUseCases(context, `${field}.useCases`, entry.useCases, '该规则的用例')
    const key = values.map((value) => textAt(value).trim().toLowerCase()).join('-')
    covered.set(key, (covered.get(key) ?? 0) + 1)
  })

  if (missingReason.length > 0) {
    context.issues.add(
      `${context.field}.rules`,
      'rule-incomplete',
      `${context.field}.rules 里第 ${missingReason.join('、')} 条标了 impossible 却没给 reason：不可能的组合也必须写清为什么不可能（REQ-048 AC-195）`,
    )
  }
  for (const [key, count] of impossible) {
    if (count > 1) {
      context.issues.add(`${context.field}.rules`, 'rule-incomplete', `${context.field}.rules 里有 ${count} 条规则都标了同一组条件取值「${key}」为不可能：同一组合只该标注一次`)
    }
  }

  // 规则数与条件数的 2 次方不等 ⇒ 每一条**没给出的**组合都要逐条标注为不可能并给理由
  if (conditions.length > 0) {
    const total = 2 ** conditions.length
    if (rules.length !== total) {
      const gaps: string[] = []
      for (let n = 0; n < total; n += 1) {
        const key = n.toString(2).padStart(conditions.length, '0').split('').join('-')
        if (covered.has(key) || impossible.has(key)) continue
        gaps.push(key)
      }
      if (gaps.length > 0) {
        context.issues.add(
          `${context.field}.rules`,
          'rule-incomplete',
          `${context.field}.rules 只有 ${rules.length} 条，而 ${conditions.length} 个条件的组合有 ${total} 种：缺失的组合「${gaps.join('、')}」既没有规则也没有标 impossible + reason（REQ-048 AC-195）`,
        )
      }
    }
  }
}

/** 状态迁移（REQ-048）：状态表与迁移表；合法迁移与非法迁移都要有用例。 */
function checkStateTransition(context: TechniqueContext): void {
  if (context.notApplicable) return
  checkDomain(context, '状态迁移覆盖的状态机域')
  const states = listAt(context.item.states)
  const transitions = listAt(context.item.transitions)
  const invalid = listAt(context.item.invalidTransitions)

  const stateIds: string[] = []
  if (states.length === 0) {
    missing(context.issues, `${context.field}.states`, '状态表', '没有状态表就没有迁移的端点')
  }
  states.forEach((entry, index) => {
    const field = `${context.field}.states[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`id: …\` / \`meaning: …\`）`)
      return
    }
    const id = textAt(entry.id).trim()
    if (id === '') missing(context.issues, `${field}.id`, '状态 id', '迁移表要按 id 引用它')
    else stateIds.push(id)
    if (textAt(entry.meaning).trim() === '') missing(context.issues, `${field}.meaning`, '状态含义', '只给状态名不给人话，读的人不知道它是什么')
  })

  if (transitions.length === 0) {
    missing(context.issues, `${context.field}.transitions`, '迁移表（from / to / on）', '没有迁移表的状态迁移只剩状态清单')
  }
  const transitionIds: string[] = []
  transitions.forEach((entry, index) => {
    const field = `${context.field}.transitions[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`from: …\` / \`to: …\` / \`on: …\`）`)
      return
    }
    const from = textAt(entry.from).trim()
    const to = textAt(entry.to).trim()
    const on = textAt(entry.on).trim()
    const id = textAt(entry.id).trim()
    if (id !== '') transitionIds.push(id)
    if (from === '') missing(context.issues, `${field}.from`, '起始状态', '迁移必须有端点')
    if (to === '') missing(context.issues, `${field}.to`, '目标状态', '迁移必须有端点')
    if (on === '') missing(context.issues, `${field}.on`, '触发事件', '没有触发事件的迁移无法执行')
    // 自洽：`from` / `to` 必须是状态表里有的状态（对不上说明表与图已经分叉）
    if (stateIds.length > 0) {
      if (from !== '' && !stateIds.includes(from)) {
        context.issues.add(`${field}.from`, 'transition-inconsistent', `${field}.from 的「${from}」不在状态表里（状态表：${stateIds.join(' ')}）`)
      }
      if (to !== '' && !stateIds.includes(to)) {
        context.issues.add(`${field}.to`, 'transition-inconsistent', `${field}.to 的「${to}」不在状态表里（状态表：${stateIds.join(' ')}）`)
      }
    }
    checkUseCases(context, `${field}.useCases`, entry.useCases, '该迁移的用例')
  })

  if (invalid.length === 0) {
    missing(context.issues, `${context.field}.invalidTransitions`, '非法迁移清单', '只测合法迁移的状态迁移会漏掉"该拒的拒了没有"（REQ-048）')
  }
  invalid.forEach((entry, index) => {
    const field = `${context.field}.invalidTransitions[${index}]`
    if (!isRecord(entry)) {
      context.issues.add(field, 'artifact-incomplete', `${field} 必须是映射（\`id: …\` / \`reason: …\`）`)
      return
    }
    const id = textAt(entry.id).trim()
    if (id === '') missing(context.issues, `${field}.id`, '非法迁移 id', '"点名非法迁移"与"给出它的用例"都要按 id 对上')
    else if (transitionIds.length > 0 && !transitionIds.includes(id)) {
      context.issues.add(`${field}.id`, 'transition-inconsistent', `${field}.id 的「${id}」不在迁移表里：非法迁移必须点名一条**表里真有的**迁移（迁移表：${transitionIds.join(' ')}）`)
    }
    checkUseCases(context, `${field}.useCases`, entry.useCases, '该非法迁移的用例')
  })
}

const TECHNIQUE_CHECKERS: Record<TestDesignTechnique, (context: TechniqueContext) => void> = {
  equivalence: checkEquivalence,
  boundary: checkBoundary,
  'decision-table': checkDecisionTable,
  'state-transition': checkStateTransition,
}

// —————————————————————— 五、必产项与整份真源 ——————————————————————

/**
 * 一条必产项：技术标注 + 回溯 + 反向引用 + 逐技术的最小必产项。
 *
 * `useCases` 的**反向引用**与 `domain` 的**出处**是本模块的两条防凑数闸门；
 * `requirementRef` / `designRef` 是"每条用例可回溯到需求或设计元素"那一半
 * （DoD 第 2 条：回溯不到就判红）。
 */
function checkArtifact(
  issues: Issues,
  index: number,
  item: Record<string, unknown>,
  known: TestDesignKnownFacts | undefined,
  knownCases: readonly string[] | undefined,
  covered: Map<string, number>,
  deferred: Set<string>,
): void {
  const field = `artifacts[${index}]`

  // ① 技术标注 —— **本卡守卫用例拦的那一码**（缺即拒，且不落盘）
  const technique = textAt(item.technique).trim()
  if (technique === '') {
    issues.add(
      `${field}.technique`,
      'technique-missing',
      `${field} 缺技术标注：必产项必须写清用了哪类黑盒技术（${TEST_DESIGN_TECHNIQUES.join(' / ')}）—— 没有它，"这条必产项是设计还是清单"无从判断，整份真源拒绝落盘`,
    )
  } else if (!(TEST_DESIGN_KNOWN_TECHNIQUES as readonly string[]).includes(technique)) {
    issues.add(`${field}.technique`, 'technique-unknown', `${field}.technique 的值「${technique}」不在黑盒技术词表里（${TEST_DESIGN_KNOWN_TECHNIQUES.join(' / ')}）`)
  } else if (!(TEST_DESIGN_TECHNIQUES as readonly string[]).includes(technique)) {
    // 词表里有、校验器没有：**显式报未覆盖**，不静默放过，也不假装验过
    deferred.add(technique)
    issues.add(
      `${field}.technique`,
      'technique-deferred',
      `${field}.technique 的「${technique}」是 REQ-048 词表里的技术，但本模块还没有它的最小必产项校验器：这条必产项**未被核对**（不判红，整份真源判 unknown）`,
    )
  }

  // ② 回溯：至少有需求或设计元素，且台账里查得到
  const requirementRefs = listAt(item.requirementRef).map((value) => textAt(value).trim()).filter((value) => value !== '')
  const designRefs = listAt(item.designRef).map((value) => textAt(value).trim()).filter((value) => value !== '')
  if (requirementRefs.length === 0 && designRefs.length === 0) {
    issues.add(
      `${field}.requirementRef`,
      'traceability-missing',
      `${field} 回溯不到需求或设计元素：必产项要写 requirementRef: [REQ-xxx] 或 designRef: [DES-xxx] —— 回溯不到就不算覆盖（REQ-048 / 本卡 DoD）`,
    )
  }
  for (const [refField, refs, pattern, table, what] of [
    ['requirementRef', requirementRefs, REQ_RE, known?.requirements, '需求'],
    ['designRef', designRefs, DES_RE, known?.designElements, '设计元素'],
  ] as const) {
    refs.forEach((id, refIndex) => {
      if (!pattern.test(id)) {
        issues.add(`${field}.${refField}[${refIndex}]`, 'traceability-unknown', `${field}.${refField}[${refIndex}] 的「${id}」不是${what}编号`)
        return
      }
      if (table === undefined) return
      if (!table.has(id)) {
        issues.add(`${field}.${refField}[${refIndex}]`, 'traceability-unknown', `${field}.${refField}[${refIndex}] 的「${id}」在台账里查不到（已有：${table.size === 0 ? '（无）' : [...table.keys()].join(' ')}）`)
      }
    })
  }

  // ③ 逐技术的最小必产项
  if (!(TEST_DESIGN_TECHNIQUES as readonly string[]).includes(technique)) {
    // 未标注 / 未知 / 尚未校验的技术：不猜它的必产项形状（上面已经点过名）
    if (technique !== '') {
      const cases = listAt(item.useCases)
      if (cases.length === 0) {
        issues.add(`${field}.useCases`, 'no-usecase', `${field}.useCases 至少要有一条用例：必产项没有被用例反向引用就等于凑数（REQ-048）`)
      }
    }
    return
  }

  // `na`（不适用）也要求有理由 —— 形状层同样核，这里核的是"真的有话"（REQ-048 降级口径）
  const na = textAt(item.na).trim()
  const notApplicable = na !== ''
  if (notApplicable && na.length < 2) {
    issues.add(`${field}.na`, 'artifact-incomplete', `${field}.na 要写清"为什么不适用"，不能只有一个字`)
  }
  if (!notApplicable && textAt(item.artifact).trim() === '') {
    missing(issues, `${field}.artifact`, '必产项本体（一行说清这份必产项是什么）', '空必产项等于没做设计')
  }

  const context: TechniqueContext = { issues, field, item, notApplicable, known, knownCases, usedCases: [] }
  TECHNIQUE_CHECKERS[technique as TestDesignTechnique](context)

  // ④ 必产项自身也要被用例反向引用（除各技术内部已逐项要求，这里兜住"整条没引用"）
  if (notApplicable) {
    // 声明不适用 ⇒ 不必有用例（REQ-048 降级口径），但 `artifact` 已要求过
    return
  }
  if (context.usedCases.length === 0) {
    issues.add(`${field}.useCases`, 'no-usecase', `${field}.useCases 至少要有一条用例：必产项没有被用例反向引用就等于凑数（REQ-048）`)
  }
  covered.set(technique, (covered.get(technique) ?? 0) + 1)
}

/** 整份真源：`design.yml` 的根映射（`{ design: { artifacts: [...] } }`）。 */
function validateRoot(
  design: unknown,
  known: TestDesignKnownFacts | undefined,
  knownCases: readonly string[] | undefined,
  requireTechniques: readonly string[],
  requireUseCase: boolean,
): TestDesignReport {
  const issues = new Issues()
  const covered = new Map<string, number>()
  const deferred = new Set<string>()
  const declared = new Map<string, number>()

  if (!isRecord(design)) {
    issues.add('', 'unknown', `design 必须是映射（\`design: { artifacts: [...] }\`），当前是 ${design === null ? 'null' : Array.isArray(design) ? 'array' : typeof design}`)
    return finish(issues.list, covered, deferred, declared, '整份真源不是映射，读不出必产项')
  }

  const raw = design.artifacts
  if (raw === undefined || raw === null) {
    issues.add('artifacts', 'technique-missing', 'artifacts 必填：声明使用黑盒技术就必须交付其最小必产项 —— 整份真源缺了它，等于没有测试设计规格')
    return finish(issues.list, covered, deferred, declared, '没有 artifacts：没有任何必产项可核对')
  }
  if (!Array.isArray(raw)) {
    issues.add('artifacts', 'unknown', `artifacts 必须是列表，当前是 ${typeof raw}`)
    return finish(issues.list, covered, deferred, declared, 'artifacts 不是列表')
  }
  if (raw.length === 0) {
    issues.add('artifacts', 'technique-missing', 'artifacts 不能为空：至少要有四类黑盒技术（等价类 / 边界值 / 判定表 / 状态迁移）的必产项 —— 空清单不是"还没写"，而是"没有设计"')
    return finish(issues.list, covered, deferred, declared, 'artifacts 为空')
  }

  raw.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.add(`artifacts[${index}]`, 'unknown', `artifacts[${index}] 必须是映射（\`- id: …\` / \`technique: …\`），当前是 ${Array.isArray(entry) ? 'array' : entry === null ? 'null' : typeof entry}`)
      return
    }
    const technique = textAt(entry.technique).trim()
    if (technique !== '') declared.set(technique, (declared.get(technique) ?? 0) + 1)
    checkArtifact(issues, index, entry, known, knownCases, covered, deferred)
  })

  // 域重复声明：同一技术同一域两行会让"覆盖"重复计数
  const domains = new Map<string, number>()
  raw.forEach((entry) => {
    if (!isRecord(entry)) return
    const technique = textAt(entry.technique).trim()
    const domain = textAt(entry.domain).trim()
    if (technique === '' || domain === '') return
    domains.set(`${technique}\u0000${domain}`, (domains.get(`${technique}\u0000${domain}`) ?? 0) + 1)
  })
  for (const [key, count] of domains) {
    if (count <= 1) continue
    const [technique, domain] = key.split('\u0000')
    issues.add('artifacts[].domain', 'domain-dup', `域「${domain}」在「${technique}」下声明了 ${count} 次：同一个域只该有一行，否则覆盖读数会重复计数`)
  }

  // 必产项被**没标注技术**的必产项引用：点名（AC-194 的"缺项点名"）
  const untechniqued = raw.filter((entry) => isRecord(entry) && textAt(entry.technique).trim() === '')
  if (untechniqued.length > 0) {
    const referenced = new Set<string>()
    raw.forEach((entry) => {
      if (!isRecord(entry)) return
      if (textAt(entry.technique).trim() !== '') return
      for (const value of listAt(entry.useCases)) referenced.add(textAt(value).trim())
    })
    for (const [index, entry] of raw.entries()) {
      if (!isRecord(entry)) continue
      if (textAt(entry.technique).trim() === '') continue
      const used = listAt(entry.useCases).map((value) => textAt(value).trim())
      if (used.some((id) => id !== '' && referenced.has(id))) {
        issues.add(`artifacts[${index}].technique`, 'usecase-untechniqued', `artifacts[${index}] 的用例被一条**没标注技术**的必产项引用：引用链的另一端缺技术标注（REQ-048 的"缺项点名"）`)
      }
    }
  }

  // 四类技术齐不齐（缺 ⇒ unknown：不是"判红"，是"没得可判"）
  const missingTechniques = requireTechniques.filter((technique) => !declared.has(technique))
  for (const technique of missingTechniques) {
    issues.add(
      'artifacts',
      'technique-missing',
      `artifacts 里没有「${TEST_DESIGN_TECHNIQUE_LABEL[technique] ?? technique}」(${technique}) 的必产项：本卡交付的四类黑盒技术逐类都要有（REQ-048）`,
    )
  }

  if (requireUseCase) {
    const withCases = new Set<string>()
    raw.forEach((entry) => {
      if (!isRecord(entry)) return
      const cases = listAt(entry.useCases).map((value) => textAt(value).trim())
      if (cases.some((id) => id !== '')) withCases.add('declared')
    })
    if (withCases.size === 0) {
      issues.add('artifacts[].useCases', 'no-usecase', '没有任何必产项带用例反向引用：REQ-048 的防凑数条款要求每条必产项被至少一条用例引用')
    }
  }

  let reason = ''
  if (missingTechniques.length > 0) {
    reason = `artifacts 里缺 ${missingTechniques.length} 类技术的必产项（${missingTechniques.join(' / ')}）：没得可判，不是判红`
  } else if (deferred.size > 0) {
    reason = `真源里有本模块尚未校验的技术（${[...deferred].join(' / ')}）：不能报 ok`
  }
  return finish(issues.list, covered, deferred, declared, reason)
}

/** 把三张表拼成结论（`unknown` 的判据集中在这里，免得散落各处）。 */
function finish(
  issues: TestDesignIssue[],
  covered: Map<string, number>,
  deferred: Set<string>,
  declared: Map<string, number>,
  unknownReason: string,
): TestDesignReport {
  const techniques = new Set<string>([...TEST_DESIGN_TECHNIQUES, ...deferred, ...declared.keys()])
  const coverage: TestDesignTechniqueCoverage[] = [...techniques].map((technique) => ({
    technique,
    label: TEST_DESIGN_TECHNIQUE_LABEL[technique] ?? technique,
    declared: declared.get(technique) ?? 0,
    covered: covered.get(technique) ?? 0,
  }))
  const outcome: TestDesignReport['outcome'] =
    unknownReason !== '' ? 'unknown' : issues.length > 0 ? 'invalid' : 'ok'
  return { outcome, issues, coverage, unknownReason: unknownReason === '' ? '' : unknownReason }
}

/** 校验选项：默认按本卡口径（四类技术齐全 + 必须有用例反向引用）。 */
export interface ValidateTestDesignOptions {
  known?: TestDesignKnownFacts | undefined
  /** 要求齐备的技术（默认四类）。 */
  requireTechniques?: readonly string[] | undefined
  /** 是否要求存在用例反向引用（默认 true）。 */
  requireUseCase?: boolean | undefined
  /** 已落盘的用例 id（给了就核"用例确实存在"）。 */
  testCaseIds?: readonly string[] | undefined
}

/**
 * 校验一份测试设计规格（`design.yml` 的根映射）。
 *
 * **fail-closed**：任何意外都收敛成 `unknown`，绝不抛异常 ——
 * 落盘闸门只认 `ok`，因此"读不动"与"不合法"在效果上一致，但**原因分得开**（`unknownReason`）。
 */
export function validateTestDesign(design: unknown, options: ValidateTestDesignOptions = {}): TestDesignReport {
  try {
    return validateRoot(
      design,
      options.known,
      options.testCaseIds,
      options.requireTechniques ?? TEST_DESIGN_TECHNIQUES,
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

// —————————————————————— 六、读写与落盘闸门 ——————————————————————

/** 真源位置（相对 `.sdo/`；与 `testingStore` 的 `design` 第一个文件同址）。 */
export const TEST_DESIGN_PATH = 'testing/design.yml'

/** 根键（`testingStore.rootKeyOf` 的口径：`design` → `design`）。 */
export const TEST_DESIGN_ROOT_KEY = 'design'

export interface TestDesignReadResult {
  status: 'ok' | 'missing' | 'invalid' | 'unknown'
  design?: unknown
  /** 读不出来时的原因（人话）。 */
  reason: string
}

/** 只读：读回真源（永不抛）。`status='ok'` 只表示"文件在且根键是映射"。 */
export function readTestDesign(store: SdoStore): TestDesignReadResult {
  try {
    const raw = store.readYaml<Record<string, unknown>>('testing', 'design.yml')
    if (raw === undefined) return { status: 'missing', reason: '`.sdo/testing/design.yml` 不存在' }
    const root = isRecord(raw) ? raw[TEST_DESIGN_ROOT_KEY] : undefined
    if (root === undefined) {
      return { status: 'missing', reason: '`.sdo/testing/design.yml` 里没有 `design:` 根键（半成品真源）' }
    }
    if (!isRecord(root)) {
      return { status: 'invalid', design: root, reason: '`design:` 根键不是映射（应当是 `artifacts: [...]`）' }
    }
    return { status: 'ok', design: root, reason: '' }
  } catch (error) {
    return { status: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 落盘闸门的结论。`written=false` 时 `outcome !== 'ok'`，盘上**一个字节都没动**。 */
export interface TestDesignWriteResult {
  written: boolean
  outcome: TestDesignReport['outcome']
  report: TestDesignReport
  /** 落盘时的内容指纹（`sha256:…`）；未落盘为空。 */
  hash: string
  /** 相对 `.sdo/` 的路径。 */
  path: string
  /** 盘上原本就有一份不同的真源（被这次覆盖）。 */
  replaced: boolean
}

/**
 * **落盘闸门**：先校验整份，`outcome==='ok'` 才写；否则如实回报并**不写盘**。
 *
 * 守卫口径（本卡 DoD 第 3 条）：**缺技术标注即拒绝落盘** —— 判据就是上面那条
 * `technique-missing`，不是"调用方自己看着办"。
 */
export function writeValidatedTestDesign(
  store: SdoStore,
  design: unknown,
  options: ValidateTestDesignOptions = {},
): TestDesignWriteResult {
  const report = validateTestDesign(design, options)
  const path = TEST_DESIGN_PATH
  if (report.outcome !== 'ok') {
    return { written: false, outcome: report.outcome, report, hash: '', path, replaced: false }
  }
  const hash = contentHash(design)
  const replaced = store.exists('testing', 'design.yml')
  store.writeYaml(['testing', 'design.yml'], { [TEST_DESIGN_ROOT_KEY]: design })
  return { written: true, outcome: 'ok', report, hash, path, replaced }
}

/**
 * 已落盘真源的内容指纹（未落盘给空串）。
 *
 * 与 `testingStore.sourceFingerprintOf` 的分工：那个是**整类**（设计规格两个文件一起）的指纹，
 * 这个是**黑盒单个文件**的指纹 —— 判"这次改动要不要重渲设计规格文档"时用得上，
 * 且它绑的是**校验通过的那份内容**（`contentHash` 对规范化 JSON），不是文件字节。
 */
export function testDesignFingerprint(store: SdoStore): string {
  const read = readTestDesign(store)
  if (read.status !== 'ok') return ''
  return contentHash(read.design)
}

// 复读文件句柄在测试里用于"真没落盘"的反证（`readFileSync` 与 `join` 同源引入，避免再引一遍）。
/** 真源在盘上的**原始字节**（`written=false` 的反证用：文件根本不存在 ⇒ 空串）。 */
export function rawTestDesignText(store: SdoStore): string {
  try {
    return readFileSync(join(store.root, 'testing', 'design.yml'), 'utf8')
  } catch {
    return ''
  }
}

// —————————————————————— 七、可读回来的两张读数 ——————————————————————

/**
 * 全量覆盖矩阵（`design` 会话里人读的那张表）：逐技术给出声明数与**真的给出必产项**的条数。
 *
 * 与 `validateTestDesign` 的区别：那个是**闸门**（只给结论与问题），这个是**读数**
 * （给人看"四类技术各有多少条、其中几条真给了东西"）。声明了 `na` 的只算声明不算给出 ——
 * 否则"什么都不做、全部标不适用"会被读数洗成齐备。
 */
export function testDesignCoverage(design: unknown): TestDesignTechniqueCoverage[] {
  return validateTestDesign(design, { requireTechniques: [] }).coverage
}

/** 追溯矩阵的一行：一条用例被哪些必产项引用、那些必产项又挂在哪些需求/设计元素上。 */
export interface TestDesignTraceRow {
  useCase: string
  /** 引用该用例的必产项（`ART-*` 或行号 `artifacts[n]`）。 */
  artifacts: string[]
  /** 该用例回溯到的需求（去重、保序）。 */
  requirements: string[]
  /** 该用例回溯到的设计元素（去重、保序）。 */
  designs: string[]
  /** 引用它的必产项里**缺技术标注**的那些（DoD 第 2 条的缺口读数）。 */
  untechniqued: string[]
}

function refsOf(value: unknown): string[] {
  return listAt(value).map((entry) => textAt(entry).trim()).filter((entry) => entry !== '')
}

/**
 * 追溯矩阵（DoD 第 2 条「每条用例可回溯到需求或设计元素」的读数侧）。
 *
 * 只列**真被引用**的用例：没被任何必产项引用的用例不会出现在这里 ——
 * 那正是"用例写了却没进设计规格"，由 `no-usecase` 从另一侧点名。
 */
export function testDesignTraceability(design: unknown): TestDesignTraceRow[] {
  const rows = new Map<string, TestDesignTraceRow>()
  if (!isRecord(design)) return []
  const artifacts = listAt(design.artifacts)
  artifacts.forEach((entry, index) => {
    if (!isRecord(entry)) return
    const name = textAt(entry.id).trim() !== '' ? textAt(entry.id).trim() : `artifacts[${index}]`
    const requirements = refsOf(entry.requirementRef)
    const designs = refsOf(entry.designRef)
    const techniqued = textAt(entry.technique).trim() !== ''
    for (const useCase of refsOf(entry.useCases)) {
      const row = rows.get(useCase) ?? { useCase, artifacts: [], requirements: [], designs: [], untechniqued: [] }
      if (!row.artifacts.includes(name)) row.artifacts.push(name)
      for (const id of requirements) if (!row.requirements.includes(id)) row.requirements.push(id)
      for (const id of designs) if (!row.designs.includes(id)) row.designs.push(id)
      if (!techniqued && !row.untechniqued.includes(name)) row.untechniqued.push(name)
      rows.set(useCase, row)
    }
  })
  return [...rows.values()]
}
