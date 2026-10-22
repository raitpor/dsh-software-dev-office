/**
 * **声明—判据覆盖（`C-70` 元判据）**：0.1.7 批 2 的 `U1`「被写 = 被遵守」。
 *
 * ## 它治的是什么
 *
 * `REQ-060`（零判据 / 零用例 / 零追溯边）与它引出的 7 次复发说明一件事：**需求/设计/纪律被写进台账，
 * 不等于有任何机制在守它**。台账里没有一条判据会问"这条声明有没有机判器"，于是「写进去」与「被遵守」
 * 之间没有任何机械联系 —— 唯一能发现它的人，是碰巧读到它的人。
 *
 * 本模块把这件事变成一个**可现算的读数**：把"必须成立的声明"逐条取出来，逐条判它有没有
 * **机判器**（能判它红/绿的机械面），没有机判器的进「**未设防清单**」，被计数、被点名；
 * 另给一条**显式豁免**通道（理由 + 批准人 + **真实存在的判据键**），并把基线做成**棘轮**
 * （`claimCoverage.baseline`：只许减少，新增未设防即判红）。
 *
 * ## 五类声明与各自的"被守"证据（**口径只有这一份**）
 *
 * | 类 | 声明来源 | 被守（机判器）的证据 | 为什么是这一条 |
 * |---|---|---|---|
 * | `requirement` | 已基线且 `priority: must` 的需求 | **登记的**用例 + 该用例最新一条结果是 `pass`/`fail` | 只有真跑过的用例算判据；`skip` 与"只登记不跑"都不是（`DEF-126` / `DEF-149`），端点没登记的更不是（`DEF-115`） |
 * | `acceptance` | 上述需求的每条 `AC-*` | **只能**走显式豁免 | 台账里没有"用例→AC"的通道（用例只带 `requirement`）⇒ AC 级今天**没有**机判器。这正是 `DEF-135`（AC 零实现）与 `DEF-149` 的读数：不许用"需求级的 pass"给它镀金 |
 * | `designElement` | 五视图里的设计元素 | 至少一条 `des-task` 追溯边（元素 → 卡） | 元素有人做，卡上的 DoD/证据才有对手方；`.sdo/config.yml` 的 `plan.noCardElements` 是**声明**不是判据（它没有批准人） |
 * | `contract` | 未作废的 `CT-*` | 至少一条 `contractTest` 记录 | `C-contracts-tested` 已定的口径，这里不另造（`DEF-106`） |
 * | `discipline` | `src/data/roles.yml` 每条 `deny` | 掩码判定 `maskAllows(role, tool, { executor: true }) === false` | 角色卡的「禁止事项」是散文，**机器面只有这张表**（`REQ-060`：不许靠解析散文/文档布局判事） |
 *
 * ## 三条硬口径
 *
 * · **只认机器面**（`REQ-060` / `AC-241`）：本模块不读任何散文、不解析任何项目目录布局；
 *   所有输入都来自**台账**（需求、追溯边、用例、结果、契约、设计元素）与**随包数据**（`roles.yml`）。
 * · **判不动不判绿**：`config.yml` 读不动 ⇒ `configReadable: false`（调用方判红）；追溯边坏行数
 *   一路带出去（`badLines`），由调用方按既有口径判红。
 * · **豁免必须能机械核对**：`{ id, criterion, reason, approvedBy }` 四个字段，`criterion` 必须是
 *   **流程数据里真的声明了、且 `CHECKERS` 里真的注册了**的判据键；`reason` / `approvedBy` 去空白后非空。
 *   少一项就不是豁免，是散文（会被逐条点名）。
 *
 * ## 为什么"owner 角色"的解析也在这个模块里
 *
 * `DEF-162` 的三条落点（认领校验 / 建卡白名单 / 收口判据）本质上都是**同一条声明**：
 * 「流程官只记账、实现派给该角色的执行者」。这条声明过去只写在文档里（`C-70` 的第一个真实反例），
 * 现在它有了三个机械面。三个面**必须共用同一份"owner → 角色"口径**，否则认领放行、收口判红
 * （两份口径分叉正是 `DEF-044` 的教训）。所以解析函数在这里，判据 id / 文案在 `gates.ts` / 语言包。
 */
import type { SdoStore } from '../infra/store.js'
import { textOf } from '../infra/scalar.js'
import type { Requirement } from '../types.js'
import { listElements } from './architecture.js'
import { contractTestGaps } from './construction.js'
import { listContracts } from './contracts.js'
import { isRole, listTasks } from './plan.js'
import type { Role } from './plan.js'
import { listTestCases, listTestResults } from './records.js'
import { listRoleCards } from './roles.js'
import { maskAllows } from './roles.js'
import { readLinksChecked } from './trace.js'

/** `C-70` 的判据 id 与检查器键（流程数据里按这个键挂载）。 */
export const CLAIM_COVERAGE_CRITERION_ID = 'C-70'
export const CLAIM_COVERAGE_CHECK = 'claims.gate-coverage'
/** 项目声明的配置段（`.sdo/config.yml`）。 */
export const CLAIM_COVERAGE_CONFIG_KEY = 'claimCoverage'

/** 五类"必须成立"的声明。顺序即回执的点名顺序（需求在前：`REQ-060` 必须一眼可读）。 */
export const CLAIM_KINDS = ['requirement', 'acceptance', 'designElement', 'contract', 'discipline'] as const
export type ClaimKind = (typeof CLAIM_KINDS)[number]

/** 一条声明的判定结果。 */
export type ClaimVerdict = 'gated' | 'exempted' | 'unguarded'

export interface ClaimRow {
  kind: ClaimKind
  id: string
  verdict: ClaimVerdict
  /**
   * 守住它的**证据**（`gated` 时：用例 id / 追溯边 / 记录 id / 掩码；`exempted` 时：豁免引用的判据键）。
   * 空串 = 没有证据（只可能出现在 `unguarded`）。
   */
  guard: string
}

/**
 * 豁免 / 配置**不成立**的读数（机器面是 `code`，人读面由调用方按语言包渲染）。
 *
 * 为什么不在这里写文案：本模块是域层，`src/data/lang/*.yml` 才是文案真源（`gates.ts` 的 i18n 棘轮是 0）。
 */
export type ClaimIssueCode =
  | 'config-unreadable'
  /** 豁免没写 id（或不是字符串）。 */
  | 'exemption-no-id'
  /** 豁免没写理由。 */
  | 'exemption-no-reason'
  /** 豁免没写批准人。 */
  | 'exemption-no-approver'
  /** 豁免引用的判据键不存在（既不在流程数据里，也不在 `CHECKERS` 里）。 */
  | 'exemption-unknown-criterion'
  /** 豁免指向一条**不存在**的声明（写错号 = 声明落在空气上）。 */
  | 'exemption-no-target'

export interface ClaimIssue {
  code: ClaimIssueCode
  /** 相关 id（配置段本身出问题时是 `claimCoverage`）。 */
  id: string
  /** 豁免引用的判据键（其他 code 为空串）。 */
  criterion: string
}

/** `req-tc` 边指向**没有登记**的用例（幽灵端点，`DEF-115`）。 */
export interface GhostCaseEdge {
  requirement: string
  caseId: string
}

export interface ClaimKindCount {
  declared: number
  gated: number
  exempted: number
  unguarded: number
}

export interface ClaimCoverageAssessment {
  /** 逐条声明（顺序＝`CLAIM_KINDS` 顺序 + 类内 id 序）。 */
  rows: ClaimRow[]
  counts: Record<ClaimKind, ClaimKindCount>
  totals: ClaimKindCount
  unguarded: ClaimRow[]
  /** 未设防且**不在基线里**（棘轮：只减不增 ⇒ 这些才是判红的那部分）。 */
  newUnguarded: ClaimRow[]
  /** 基线里已经不再未设防的 id（可以减少基线，但不强制）。 */
  retirableBaseline: string[]
  issues: ClaimIssue[]
  ghostEdges: GhostCaseEdge[]
  /** 项目声明的基线（`.sdo/config.yml` 的 `claimCoverage.baseline`）。 */
  baseline: string[]
  /** `config.yml` 是否读得动（读不动 ⇒ 调用方判红，不许当"没有基线"放过）。 */
  configReadable: boolean
  /** 追溯图坏行数（`>0` ⇒ 调用方判红：判据在一份不完整的图上判绿等于假绿）。 */
  badLines: number
  /** 一条声明都没有 ⇒ 调用方判 N/A（不是绿）。 */
  declared: boolean
}

export interface ClaimCoverageInput {
  store: SdoStore
  /** 已基线需求（`must` 的进本判据）。 */
  requirements: readonly Requirement[]
  /**
   * **判据键白名单**：流程数据里声明的 `check` ∪ `CHECKERS` 注册的键。
   *
   * 为什么由调用方给：`gates.ts` 才知道"这条判据到底挂没挂上、实没实现"；
   * 本模块只回答"豁免引用的键在不在那份名单里"（一份口径，两处读）。
   */
  knownChecks: readonly string[]
}

/** 原始配置段（`unknown`：`.sdo/config.yml` 是人写的，判过之前什么都不是）。 */
interface RawClaimConfig {
  baseline?: unknown
  exempt?: unknown
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => textOf(item).trim()).filter((item) => item !== '')
}

/** 读配置段；读不动返回 `undefined`（调用方判红：判不动 ≠ 没有配置）。 */
function readClaimConfig(store: SdoStore): { config: RawClaimConfig; readable: boolean } {
  try {
    const raw = store.readYaml<Record<string, unknown>>('config.yml')
    const section = raw?.[CLAIM_COVERAGE_CONFIG_KEY]
    if (section === undefined || section === null) return { config: {}, readable: true }
    if (typeof section !== 'object' || Array.isArray(section)) return { config: {}, readable: false }
    return { config: section as RawClaimConfig, readable: true }
  } catch {
    return { config: {}, readable: false }
  }
}

/** 最新一条结果（`latest-wins`，与 `trace.report` / `verificationStats` 同口径）。 */
function latestResults(store: SdoStore): Map<string, string> {
  const latest = new Map<string, { status: string; at: string; id: string }>()
  for (const result of listTestResults(store)) {
    const previous = latest.get(result.caseId)
    const newer = previous === undefined
      || result.at > previous.at
      || (result.at === previous.at && result.id > previous.id)
    if (newer) latest.set(result.caseId, { status: String(result.status), at: result.at, id: result.id })
  }
  const out = new Map<string, string>()
  for (const [caseId, row] of latest) out.set(caseId, row.status)
  return out
}

/**
 * 一条需求有没有**机判器**：任一登记用例（`req-tc` 边或用例自己声明的 `requirement`）
 * 的最新结果**真的跑过**（`pass` / `fail`）。
 *
 * 三处有意排除（都是"假绿"的原型，别放宽）：
 *   · `skip` —— 只表达"这条在我这儿跑不了"，不是判定（`DEF-126`）；
 *   · 只登记、没有结果 —— "先把用例登记上、实现留到以后"（`DEF-149`）；
 *   · 结果存在但用例**没登记** —— 幽灵端点（`DEF-115`）：它连"用例"都不是，凭它抬高覆盖就是假绿。
 */
function requirementGuard(
  requirementId: string,
  edges: ReadonlyMap<string, string[]>,
  registered: ReadonlySet<string>,
  latest: ReadonlyMap<string, string>,
): string | undefined {
  const fromEdges = edges.get(requirementId) ?? []
  const candidates = [...new Set(fromEdges.filter((caseId) => registered.has(caseId)))]
  for (const caseId of candidates.sort()) {
    const status = latest.get(caseId)
    if (status === 'pass' || status === 'fail') return caseId
  }
  return undefined
}

/** 一条 `deny` 条目有没有机判器：掩码判定真的挡住它（`executor` 口径 = 子会话）。 */
function disciplineGuard(role: string, tool: string): string | undefined {
  return maskAllows(role, tool, { executor: true }) ? undefined : `${role}/deny/${tool}`
}

/** 逐类累积（保持 `CLAIM_KINDS` 的顺序）。 */
function emptyCounts(): ClaimKindCount {
  return { declared: 0, gated: 0, exempted: 0, unguarded: 0 }
}

/**
 * 现算「声明—判据覆盖」（**只读**：不写盘、不改入参）。
 *
 * 输出是**读数**而不是抛错：一次要能点名**全部**未设防项（一次只报一条，读者得来回跑 N 遍）。
 * 形状坏掉（`config.yml` 读不动、追溯边有坏行）走 `configReadable` / `badLines`，由调用方判红。
 */
export function assessClaimCoverage(input: ClaimCoverageInput): ClaimCoverageAssessment {
  const { config, readable } = readClaimConfig(input.store)
  const issues: ClaimIssue[] = []
  if (!readable) issues.push({ code: 'config-unreadable', id: CLAIM_COVERAGE_CONFIG_KEY, criterion: '' })

  const baseline = stringList(config.baseline)
  const knownChecks = new Set(input.knownChecks)

  // ① 追溯边（坏行如实带回；`req-tc` 的目标必须在用例登记表里 —— 幽灵端点单列）
  const links = readLinksChecked(input.store)
  const tests: TestCensus = (() => {
    const cases = listTestCases(input.store)
    const registered = new Set(cases.map((item) => textOf(item.id).trim()).filter((id) => id !== ''))
    const edges = new Map<string, string[]>()
    const ghosts: GhostCaseEdge[] = []
    /**
     * 「需求 → 能判它的用例」有**两条等价通路**，缺一条就会把真跑过的用例判成没守卫：
     *   · `req-tc` 追溯边（图里）；
     *   · 用例自己声明的 `requirement` 字段（台账里）。
     * 两条都只认**已登记**的用例；边的目标没登记就是幽灵端点（`DEF-115`），单列出去。
     */
    for (const item of cases) {
      const requirementId = textOf(item.requirement).trim()
      const caseId = textOf(item.id).trim()
      if (requirementId === '' || caseId === '') continue
      edges.set(requirementId, [...(edges.get(requirementId) ?? []), caseId])
    }
    for (const link of links.links) {
      if (String(link.kind) !== 'req-tc') continue
      const from = textOf(link.from).trim()
      const to = textOf(link.to).trim()
      if (from === '' || to === '') continue
      if (!registered.has(to)) {
        ghosts.push({ requirement: from, caseId: to })
        continue
      }
      edges.set(from, [...(edges.get(from) ?? []), to])
    }
    const unique = new Map<string, GhostCaseEdge>()
    for (const ghost of ghosts) unique.set(`${ghost.requirement}→${ghost.caseId}`, ghost)
    return { registered, edges, latest: latestResults(input.store), ghosts: [...unique.values()] }
  })()

  // ② 四类"台账里现成可数"的声明来源（纪律条目在 ⑤）
  const musts = input.requirements
    .filter((requirement) => textOf(requirement.priority).trim() === 'must')
    .map((requirement) => ({ id: textOf(requirement.id).trim(), acceptance: requirement.acceptance ?? [] }))
    .filter((row) => row.id !== '')
    .sort((left, right) => left.id.localeCompare(right.id))
  const elements = listElements(input.store).map((element) => textOf(element.id).trim()).filter((id) => id !== '').sort()
  const contracts = listContracts(input.store)
    .filter((contract) => contract.dropped !== true)
    .map((contract) => textOf(contract.id).trim())
    .filter((id) => id !== '')
    .sort()
  const contractTests = contractTestGaps(input.store)

  // ③ 逐条判定（先算出 `rows`，再统一套豁免 —— 豁免是"覆盖判定"，不是第四个来源）
  const rows: ClaimRow[] = []
  const push = (kind: ClaimKind, id: string, guard: string | undefined): void => {
    rows.push({ kind, id, verdict: guard === undefined ? 'unguarded' : 'gated', guard: guard ?? '' })
  }
  for (const requirement of musts) {
    push('requirement', requirement.id, requirementGuard(requirement.id, tests.edges, tests.registered, tests.latest))
    for (const ac of requirement.acceptance) {
      const acId = textOf(ac.id).trim()
      // AC 级**没有**台账通道（用例只带 `requirement`）⇒ 只有豁免这一条路（见文件头的表）
      if (acId !== '') push('acceptance', acId, undefined)
    }
  }
  for (const element of elements) {
    const guard = links.links.some((link) => String(link.kind) === 'des-task' && textOf(link.from).trim() === element)
    push('designElement', element, guard ? `des-task:${element}` : undefined)
  }
  for (const contract of contracts) {
    push('contract', contract, contractTests.recorded.includes(contract) ? `contractTest:${contract}` : undefined)
  }
  for (const card of listRoleCards()) {
    for (const tool of card.deny) {
      push('discipline', `${card.code}:deny:${tool}`, disciplineGuard(card.code, tool))
    }
  }

  // ④ 豁免：四个字段都要能机械核对；**引用的判据键必须真实存在**（否则就是散文）
  const declared = new Set(rows.map((row) => row.id))
  const exempted = new Map<string, string>()
  const rawExempt = Array.isArray(config.exempt) ? config.exempt : []
  for (const entry of rawExempt) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ code: 'exemption-no-id', id: '', criterion: '' })
      continue
    }
    const row = entry as Record<string, unknown>
    const id = textOf(row.id).trim()
    const criterion = textOf(row.criterion).trim()
    const reason = textOf(row.reason).trim()
    const approvedBy = textOf(row.approvedBy).trim()
    if (id === '') {
      issues.push({ code: 'exemption-no-id', id: '', criterion })
      continue
    }
    if (reason === '') issues.push({ code: 'exemption-no-reason', id, criterion })
    if (approvedBy === '') issues.push({ code: 'exemption-no-approver', id, criterion })
    if (criterion === '' || !knownChecks.has(criterion)) issues.push({ code: 'exemption-unknown-criterion', id, criterion })
    if (!declared.has(id)) {
      issues.push({ code: 'exemption-no-target', id, criterion })
      continue
    }
    // 三项都成立才算数（缺一项反而是"看起来有豁免"的假象）
    if (reason !== '' && approvedBy !== '' && criterion !== '' && knownChecks.has(criterion)) exempted.set(id, criterion)
  }
  for (const row of rows) {
    const criterion = exempted.get(row.id)
    if (criterion === undefined) continue
    row.verdict = 'exempted'
    row.guard = criterion
  }

  // ⑤ 汇总
  const counts = Object.fromEntries(CLAIM_KINDS.map((kind) => [kind, emptyCounts()])) as Record<ClaimKind, ClaimKindCount>
  const totals = emptyCounts()
  for (const row of rows) {
    const bucket = counts[row.kind]
    bucket.declared += 1
    totals.declared += 1
    if (row.verdict === 'gated') {
      bucket.gated += 1
      totals.gated += 1
    } else if (row.verdict === 'exempted') {
      bucket.exempted += 1
      totals.exempted += 1
    } else {
      bucket.unguarded += 1
      totals.unguarded += 1
    }
  }
  const unguarded = rows.filter((row) => row.verdict === 'unguarded')
  const baselineSet = new Set(baseline)
  const newUnguarded = unguarded.filter((row) => !baselineSet.has(row.id))
  const unguardedIds = new Set(unguarded.map((row) => row.id))
  const retirableBaseline = baseline.filter((id) => !unguardedIds.has(id))
  return {
    rows,
    counts,
    totals,
    unguarded,
    newUnguarded,
    retirableBaseline,
    issues,
    ghostEdges: tests.ghosts,
    baseline,
    configReadable: readable,
    badLines: links.badLines,
    declared: rows.length > 0,
  }
}

/** 用例普查的小结构（把"登记 / 边 / 最新结果 / 幽灵"四件读数一次算好）。 */
interface TestCensus {
  registered: ReadonlySet<string>
  edges: ReadonlyMap<string, string[]>
  latest: ReadonlyMap<string, string>
  ghosts: GhostCaseEdge[]
}

/* —————————————————————————— owner 的角色（`DEF-162` 三个面共用一份口径） —————————————————————————— */

/** 驾驶舱（流程官）。它不是 `ROLES` 里的第八个角色，但它是 owner 的一种合法形态。 */
export const COCKPIT_OWNER = 'cockpit'

/**
 * owner 的**合法形态**（写进拒绝回执，让下一棒知道该写什么）：
 *
 * · `subagent:<角色>:<标识>`（真机主流形态，如 `subagent:developer:1`）；
 * · `<角色>:<标识>` / `<角色>-<标识>`（如 `developer-1`）；
 * · `cockpit`（驾驶舱）；
 * · 八个角色码之一（`tester` 等）。
 *
 * 认不出的 owner（`dev-a` / `张三` / `x`…）**不猜**：认领面 fail-open 放行（认不出人不该变成干不了活），
 * 收口判据（`C-76`）再 fail-closed 点名 —— 两个面都写在这里，口径只有这一份。
 */
export const OWNER_ROLE_FORMS = 'subagent:<role>:<id> | <role>:<id> | <role>-<id> | cockpit | <role>'

/** 从 owner 串里认出角色；认不出返回 `undefined`（**不猜**，见 {@link OWNER_ROLE_FORMS}）。 */
export function ownerRoleOf(owner: string): Role | typeof COCKPIT_OWNER | undefined {
  const raw = textOf(owner).trim()
  if (raw === '') return undefined
  // 括号备注是"代记"的常见写法（`cockpit（代记：…）`）—— 备注不参与角色判定
  const head = (raw.split(/[\s（(]/u)[0] ?? '').trim()
  if (head === '') return undefined
  const segments = head.split(/[:：]/u).map((item) => item.trim()).filter((item) => item !== '')
  if (segments[0] === 'subagent' && segments.length >= 2) {
    const role = segments[1] ?? ''
    return isRole(role) ? role : undefined
  }
  if (segments[0] === COCKPIT_OWNER) return COCKPIT_OWNER
  const first = segments[0] ?? ''
  if (isRole(first)) return first
  const dash = first.indexOf('-')
  if (dash > 0) {
    const prefix = first.slice(0, dash)
    return isRole(prefix) ? prefix : undefined
  }
  return undefined
}

/** 分工声明里**明确禁止**的两种认领（`DEF-162` 第①条：驾驶舱/流程官不得认领实现与测试卡）。 */
const IMPLEMENTATION_ROLES: readonly string[] = ['developer', 'tester']
const PROCESS_OFFICER_ROLES: readonly string[] = ['cockpit', 'office']

export type OwnerClaim =
  | { ok: true; role: string | undefined }
  | { ok: false; role: string; reason: 'process-officer-on-implementation' }

/**
 * 认领面的角色判定（`DEF-162` 第①条）。
 *
 * 三态：
 *   · **认不出角色**（`dev-a` / `张三`…）⇒ 放行（fail-open）：认不出人不该变成干不了活；
 *     它在**收口**由 `C-76` 兜底（那里要求 "owner 的角色 == 卡的 role"，认不出即点名）。
 *   · **驾驶舱 / 流程官**认领 `developer` / `tester` 卡 ⇒ **拒绝**（这正是缺陷标本：TASK-170 由 cockpit 认领）。
 *   · 其余（角色对得上，或两个角色都不是实现类）⇒ 放行。
 */
export function ownerClaimVerdict(owner: string, cardRole: string): OwnerClaim {
  const role = ownerRoleOf(owner)
  if (role === undefined) return { ok: true, role: undefined }
  const target = textOf(cardRole).trim()
  if (role === target) return { ok: true, role }
  if (PROCESS_OFFICER_ROLES.includes(role) && IMPLEMENTATION_ROLES.includes(target)) {
    return { ok: false, role, reason: 'process-officer-on-implementation' }
  }
  return { ok: true, role }
}

/** 收口判据（`C-76`）的一行读数：谁做完了、做的角色与卡的角色对不对得上。 */
export interface OwnerRoleFinding {
  taskId: string
  status: string
  /** 卡上声明的角色。 */
  cardRole: string
  owner: string
  /** 从 owner 认出的角色（认不出为 `undefined`）。 */
  ownerRole: string | undefined
  reason: 'owner-empty' | 'owner-role-unknown' | 'role-mismatch'
}

/**
 * **收口判据（`C-76`）的读数**：已 `done` / `verified` 的卡，`owner` 的角色必须**等于**卡的 `role`。
 *
 * 为什么在**收口**才 strict（认领面 fail-open、这里 fail-closed）：认领那一刻是"这张卡归谁"，
 * 认错名字不该立刻阻断干活；而一张卡写完、验完、落了证据之后，**"谁做的"就是台账事实** ——
 * 那时"认不出 owner 的角色"与"角色对不上"都必须说出来，否则「流程官只记账」这条分工
 * 又回到"只写在文档里"（`DEF-162` 的原话）。
 *
 * 只判 `done` / `verified`：进行中的卡还在跑，`owner` 随时可能被 `reassign`（那不是记账错误）。
 */
export function ownerRoleFindings(tasks: readonly { id: string; status: string; role: string; owner?: string | undefined }[]): OwnerRoleFinding[] {
  const out: OwnerRoleFinding[] = []
  for (const task of tasks) {
    if (task.status !== 'done' && task.status !== 'verified') continue
    const owner = textOf(task.owner).trim()
    const cardRole = textOf(task.role).trim()
    if (owner === '') {
      out.push({ taskId: task.id, status: task.status, cardRole, owner, ownerRole: undefined, reason: 'owner-empty' })
      continue
    }
    const ownerRole = ownerRoleOf(owner)
    if (ownerRole === undefined) {
      out.push({ taskId: task.id, status: task.status, cardRole, owner, ownerRole, reason: 'owner-role-unknown' })
      continue
    }
    if (ownerRole !== cardRole) {
      out.push({ taskId: task.id, status: task.status, cardRole, owner, ownerRole, reason: 'role-mismatch' })
    }
  }
  return out
}

/** 现算已收口卡的角色读数（`C-76` 的直接入口；门禁按这个读数判红）。 */
export function ownerRoleFindingsOfStore(store: SdoStore): OwnerRoleFinding[] {
  return ownerRoleFindings(listTasks(store).map((task) => ({
    id: task.id,
    status: String(task.status),
    role: textOf(task.role),
    ...(task.owner === undefined ? {} : { owner: task.owner }),
  })))
}
