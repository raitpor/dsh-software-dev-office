/**
 * **实现阶段方法包**（增量 3，2026-10-03）。
 *
 * 形状（设计文档 §0）：实现阶段的"产物"（用例/评审/证据/追溯/缺陷/卡）**已经是一等公民**，
 * 所以这里**不发明第二套产物族**，只做两件事：
 *   1. 把"选了哪些包、依据是什么、范围与豁免"落成真源 `.sdo/construction/profile.yml`；
 *   2. 提供**可机械判定**的检查器（红→绿时序、变异自证、契约冻结、契约测试），供 `claim`/`done`/门禁调用。
 *
 * 落盘原则（设计文档 §3）：**能从既有真源现算的一律不落盘** ——
 * 红→绿时序与契约冻结序号都从 journal 现算；只有"无法从既有真源现算"的事实（变异记录、契约测试记录）才落盘。
 */
import { existsSync } from 'node:fs'

import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import { readProjectConfig } from '../config.js'
import { fmt, t } from './i18n.js'
import { toolAllowList } from './roles.js'
import { CONSTRUCTION_PACKAGES, SCALES } from '../types.js'
import type { ConstructionPackage, TaskCard } from '../types.js'
import { listContracts } from './contracts.js'
import { listTestCases, listTestResults } from './records.js'
import { listRequirements } from './requirements.js'

/** `.sdo/construction/`：本机制的全部交付物。 */
export const CONSTRUCTION_DIR = 'construction'
export const CONSTRUCTION_PROFILE_FILE = 'profile.yml'
export const CONSTRUCTION_TDD_FILE = 'tdd.yml'
export const CONSTRUCTION_CONTRACT_FILE = 'contract-first.yml'

/** 构造发生在这些阶段：顺序流程的 `construction`；敏捷/螺旋的 `iteration`（无 construction 阶段）。 */
export const CONSTRUCTION_PHASES = new Set(['construction', 'iteration'])

/** 范围的两种写法。 */
export const SCOPE_ALL = 'all'

export interface ConstructionExemption {
  task: string
  /** 被豁免的检查码（`ConstructionCheck` 的字符串形式）。 */
  check: string
  why: string
}

export interface ConstructionHistoryItem {
  at: string
  packages: string[]
  reason: string
}

export interface ConstructionProfile {
  version: number
  decidedAt: string
  /** 决策者（角色码）。 */
  decidedBy: string
  packages: ConstructionPackage[]
  scope: typeof SCOPE_ALL | string[]
  /** 决策依据（模型自选的可审计化：至少一条要能被机械核对）。 */
  derivedFrom: string[]
  reason: string
  exempt: ConstructionExemption[]
  history: ConstructionHistoryItem[]
}

export interface ProfileRead {
  status: 'missing' | 'invalid' | 'ok'
  /** 仅在 `status === 'ok'` 时有值。 */
  profile?: ConstructionProfile | undefined
  /** `status === 'invalid'` 时给出原因（坏结构不得静默）。 */
  problems: string[]
}

const PACKAGE_SET = new Set<string>(CONSTRUCTION_PACKAGES)

/** 读 profile（坏结构如实回报，不静默兜底）。 */
export function readConstructionProfile(store: SdoStore): ProfileRead {
  if (!existsSync(store.path(CONSTRUCTION_DIR, CONSTRUCTION_PROFILE_FILE))) {
    return { status: 'missing', problems: [] }
  }
  const raw = store.readYaml<{ profile?: unknown }>(CONSTRUCTION_DIR, CONSTRUCTION_PROFILE_FILE)
  const candidate = raw?.profile
  if (candidate === undefined || candidate === null || typeof candidate !== 'object') {
    return { status: 'invalid', problems: [fmt('uiConstruction.c01', { p1: `${CONSTRUCTION_DIR}/${CONSTRUCTION_PROFILE_FILE}` })] }
  }
  const record = candidate as Record<string, unknown>
  const problems: string[] = []
  const packages = Array.isArray(record.packages) ? record.packages.filter((item): item is string => typeof item === 'string') : []
  for (const item of packages) if (!PACKAGE_SET.has(item)) problems.push(fmt('uiConstruction.c02', { p1: item }))
  const scopeRaw = record.scope
  const scope: typeof SCOPE_ALL | string[] =
    scopeRaw === SCOPE_ALL ? SCOPE_ALL : Array.isArray(scopeRaw) ? scopeRaw.filter((item): item is string => typeof item === 'string') : []
  if (scopeRaw !== SCOPE_ALL && !Array.isArray(scopeRaw)) problems.push(t('uiConstruction.c03'))
  const derivedFrom = Array.isArray(record.derivedFrom) ? record.derivedFrom.filter((item): item is string => typeof item === 'string') : []
  const reason = typeof record.reason === 'string' ? record.reason : ''
  // 选了包 ⇒ 必须留依据（模型自选要可审计）；**显式不选任何包** ⇒ 合法的 N/A，但必须写明理由
  if (packages.length > 0 && derivedFrom.length === 0) problems.push(t('uiConstruction.c04'))
  if (packages.length === 0 && reason.trim() === '') problems.push(t('uiConstruction.c24'))
  const exempt: ConstructionExemption[] = []
  if (Array.isArray(record.exempt)) {
    for (const item of record.exempt) {
      const entry = item as Record<string, unknown>
      if (typeof entry.task !== 'string' || typeof entry.check !== 'string' || typeof entry.why !== 'string' || entry.why.trim() === '') {
        problems.push(t('uiConstruction.c05'))
        continue
      }
      exempt.push({ task: entry.task, check: entry.check, why: entry.why })
    }
  }
  const history: ConstructionHistoryItem[] = []
  if (Array.isArray(record.history)) {
    for (const item of record.history) {
      const entry = item as Record<string, unknown>
      if (typeof entry.at !== 'string') continue
      history.push({
        at: entry.at,
        packages: Array.isArray(entry.packages) ? entry.packages.filter((value): value is string => typeof value === 'string') : [],
        reason: typeof entry.reason === 'string' ? entry.reason : '',
      })
    }
  }
  if (problems.length > 0) return { status: 'invalid', problems }
  return {
    status: 'ok',
    problems: [],
    profile: {
      version: typeof record.version === 'number' ? record.version : 1,
      decidedAt: typeof record.decidedAt === 'string' ? record.decidedAt : '',
      decidedBy: typeof record.decidedBy === 'string' ? record.decidedBy : '',
      packages: packages as ConstructionPackage[],
      scope,
      derivedFrom,
      reason,
      exempt,
      history,
    },
  }
}

export function writeConstructionProfile(store: SdoStore, profile: ConstructionProfile): void {
  store.writeYaml([CONSTRUCTION_DIR, CONSTRUCTION_PROFILE_FILE], { profile })
}

/**
 * 校验"决策依据"：**至少一条能被机械核对**（设计文档 §2.3）。
 *
 * 可核对形式：
 *   - `reqKind=<kind>(<REQ-id>)`：该需求存在，且 kind 与之相符；
 *   - `contractCount=<n>`：与台账里契约数一致；
 *   - `scale=<trivial|normal|critical>`：与当前档位一致（调用方给了才核）。
 * 其余形式（如 `stack=…`）记入 `unchecked`，不判错 —— 只要**至少一条**可核对即可。
 */
export function validateDerivation(
  store: SdoStore,
  entries: string[],
  options: { scale?: string | undefined } = {},
): { checked: string[]; unchecked: string[]; problems: string[] } {
  const checked: string[] = []
  const unchecked: string[] = []
  const problems: string[] = []
  for (const entry of entries) {
    const reqKind = /^reqKind=([a-zA-Z-]+)\(([^)]+)\)$/u.exec(entry)
    if (reqKind !== null) {
      const kind = reqKind[1] ?? ''
      const id = reqKind[2] ?? ''
      const requirement = listRequirements(store).find((item) => item.id === id)
      if (requirement === undefined) problems.push(fmt('uiConstruction.c06', { p1: entry, p2: id }))
      else if (String(requirement.kind).toLowerCase() !== String(kind).toLowerCase()) {
        problems.push(fmt('uiConstruction.c07', { p1: entry, p2: id, p3: String(requirement.kind), p4: kind }))
      } else checked.push(entry)
      continue
    }
    const contractCount = /^contractCount=(\d+)$/u.exec(entry)
    if (contractCount !== null) {
      const actual = listContracts(store).filter((item) => item.dropped !== true).length
      if (Number(contractCount[1]) !== actual) problems.push(fmt('uiConstruction.c08', { p1: entry, p2: String(actual) }))
      else checked.push(entry)
      continue
    }
    const scale = /^scale=([a-z]+)$/u.exec(entry)
    if (scale !== null) {
      const declared = scale[1] ?? ''
      // 档位的真源是项目 `.sdo/config.yml`（不是插件设置）——能现算的就现算
      const expected = options.scale ?? readProjectConfig(store).config.scale
      if (!(SCALES as readonly string[]).includes(declared)) problems.push(fmt('uiConstruction.c09', { p1: entry, p2: SCALES.join('/') }))
      else if (expected !== declared) problems.push(fmt('uiConstruction.c10', { p1: entry, p2: expected }))
      else checked.push(entry)
      continue
    }
    unchecked.push(entry)
  }
  if (checked.length === 0 && problems.length === 0) {
    problems.push(t('uiConstruction.c11'))
  }
  return { checked, unchecked, problems }
}

/** `TR-007` → 7（取不到数字就当 0，排在最前，宁可判严）。 */
function orderOf(id: string): number {
  const digits = /(\d+)/u.exec(id)
  return digits === null ? 0 : Number(digits[1])
}

export function scopeCovers(profile: ConstructionProfile, taskId: string): boolean {
  return profile.scope === SCOPE_ALL || profile.scope.includes(taskId)
}

export function findExemption(profile: ConstructionProfile, taskId: string, check: string): ConstructionExemption | undefined {
  return profile.exempt.find((item) => item.task === taskId && item.check === check)
}

/** 卡涉及哪些契约：契约声明了 `requires`，与卡覆盖的需求有交集即算涉及（不新增真源）。 */
export function contractsOfCard(store: SdoStore, card: TaskCard): string[] {
  const requirements = new Set(card.requirements)
  return listContracts(store)
    .filter((item) => item.dropped !== true)
    .filter((item) => (item.requires ?? []).some((id) => requirements.has(id)))
    .map((item) => item.id)
}

/**
 * 契约的"冻结"序号：`design/confirmed` 事件里 `target` 命中该契约的**最新一条**。
 *
 * **第一轮整仓评审 §2 第 3 条（"签后重签"）**：旧实现用 `.find` 取**第一条**，理由是"真源只有一份"。
 * 但同一份契约可以被**重复确认**（改了契约再签一次），这时"第一条"会把**认领之后的重签**藏起来：
 * 门禁 `construction.packages-satisfied`（C-43/C-84）是**事后**拿"那次认领的序号"复核已完成卡的，
 * 于是"签(50) → 认领(60) → 改契约并重签(120)"在旧实现下 50 < 60 ⇒ 无 gap（卡是在契约变更前动的工，
 * 却查不出来）。取**最新**一条才符合这条检查的本意（"卡开工时生效的那版契约已冻结"）：重签晚于认领
 * ⇒ 点名出来，历史卡要走**豁免**（门禁注释里写明的那条路）。
 */
export function frozenSeq(journal: Journal, contractId: string): number | undefined {
  const events = journal
    .read()
    .events.filter((item) => item.type === 'design/confirmed' && String(item.data.target ?? '') === contractId)
  return events[events.length - 1]?.seq
}

export interface CardCheck {
  check: string
  ok: boolean
  detail: string
}

/**
 * `claim` 关：契约必须先冻结（冻结序号 < 认领序号）。
 * 返回**未通过**的检查（空数组 = 全过）。契约先冻结是"接口先行"最有价值的那一半。
 */
export function claimGaps(
  store: SdoStore,
  journal: Journal,
  card: TaskCard,
  claimSeq: number,
  profile: ConstructionProfile | undefined,
): CardCheck[] {
  if (profile === undefined || !profile.packages.includes('contract-first') || !scopeCovers(profile, card.id)) return []
  const gaps: CardCheck[] = []
  for (const contractId of contractsOfCard(store, card)) {
    if (findExemption(profile, card.id, 'contract-not-frozen') !== undefined) continue
    const seq = frozenSeq(journal, contractId)
    if (seq === undefined) {
      gaps.push({ check: 'contract-not-frozen', ok: false, detail: fmt('uiConstruction.c12', { p1: contractId }) })
      continue
    }
    if (seq >= claimSeq) {
      gaps.push({ check: 'contract-not-frozen', ok: false, detail: fmt('uiConstruction.c13', { p1: contractId, p2: String(seq), p3: String(claimSeq) }) })
    }
  }
  return gaps
}

/**
 * 红→绿时序：卡覆盖的**每条需求**，其用例必须**先记 `fail`、后有 `pass`**（从 journal 现算）。
 * 只记 pass 的用例说明"测试没红过"，按 TDD 口径不算数。
 */
export function redGreenGaps(store: SdoStore, journal: Journal, card: TaskCard): CardCheck[] {
  const cases = listTestCases(store)
  // 结果真源与 C7（`testFirstGaps`）**同一个**：append-only 的 `.sdo/tests/results/TR-*.yml`。
  // 顺序用 id 的数字序（`idOf` 递增分配）——比时间戳稳，也不会因为"有人手写了结果文件"而漏看。
  const results = listTestResults(store).slice().sort((a, b) => orderOf(a.id) - orderOf(b.id))
  // **来源可追溯**：`.sdo/tests/results/*.yml` 可手改，唯一挡得住伪造的是**它必须在 journal 里有对应事件**
  // （`recordTestResult` 两处都写：文件 + `test/recorded{id, caseId, status}`）。文件有、事件没有 ⇒ 判红。
  const traceable = new Set(
    journal
      .read()
      .events.filter((event) => event.type === 'test/recorded' && String(event.data.caseId ?? '') !== '')
      .map((event) => String(event.data.id ?? '')),
  )
  const firstFail = new Map<string, number>()
  const firstPass = new Map<string, number>()
  for (const [index, result] of results.entries()) {
    if (result.status === 'fail' && !firstFail.has(result.caseId)) firstFail.set(result.caseId, index)
    if (result.status === 'pass' && !firstPass.has(result.caseId)) firstPass.set(result.caseId, index)
  }
  const gaps: CardCheck[] = []
  const untraceable = results.filter((item) => !traceable.has(item.id))
  if (untraceable.length > 0) {
    gaps.push({
      check: 'tdd-result-untraceable',
      ok: false,
      detail: fmt('uiConstruction.c32', { p1: untraceable.map((item) => item.id).join(' ') }),
    })
  }
  for (const requirement of card.requirements) {
    const owned = cases.filter((item) => item.requirement === requirement)
    const verified = owned.find((item) => {
      const red = firstFail.get(item.id)
      const green = firstPass.get(item.id)
      return red !== undefined && green !== undefined && red < green
    })
    if (verified !== undefined) continue
    gaps.push({
      check: 'tdd-red-green-missing',
      ok: false,
      detail:
        owned.length === 0
          ? fmt('uiConstruction.c14', { p1: requirement })
          : fmt('uiConstruction.c15', { p1: requirement, p2: owned.map((item) => item.id).join(' ') }),
    })
  }
  return gaps
}

export interface MutationRecord {
  task: string
  tool: string
  target: string
  killed: number
  survived: number
  at: string
}

export interface ContractTestRecord {
  task: string
  contract: string
  tool: string
  cmd: string
  at: string
}

export function readMutations(store: SdoStore): MutationRecord[] {
  const raw = store.readYaml<{ mutation?: unknown }>(CONSTRUCTION_DIR, CONSTRUCTION_TDD_FILE)
  if (!Array.isArray(raw?.mutation)) return []
  const out: MutationRecord[] = []
  for (const item of raw.mutation) {
    const entry = item as Record<string, unknown>
    if (typeof entry.task !== 'string' || typeof entry.tool !== 'string') continue
    out.push({
      task: entry.task,
      tool: entry.tool,
      target: typeof entry.target === 'string' ? entry.target : '',
      killed: typeof entry.killed === 'number' ? entry.killed : 0,
      survived: typeof entry.survived === 'number' ? entry.survived : 0,
      at: typeof entry.at === 'string' ? entry.at : '',
    })
  }
  return out
}

export function recordMutation(store: SdoStore, entry: MutationRecord): void {
  const existing = readMutations(store)
  store.writeYaml([CONSTRUCTION_DIR, CONSTRUCTION_TDD_FILE], { mutation: [...existing, entry] })
}

export function readContractTests(store: SdoStore): ContractTestRecord[] {
  const raw = store.readYaml<{ contractTests?: unknown }>(CONSTRUCTION_DIR, CONSTRUCTION_CONTRACT_FILE)
  if (!Array.isArray(raw?.contractTests)) return []
  const out: ContractTestRecord[] = []
  for (const item of raw.contractTests) {
    const entry = item as Record<string, unknown>
    if (typeof entry.task !== 'string' || typeof entry.contract !== 'string') continue
    out.push({
      task: entry.task,
      contract: entry.contract,
      tool: typeof entry.tool === 'string' ? entry.tool : '',
      cmd: typeof entry.cmd === 'string' ? entry.cmd : '',
      at: typeof entry.at === 'string' ? entry.at : '',
    })
  }
  return out
}

export function recordContractTest(store: SdoStore, entry: ContractTestRecord): void {
  const existing = readContractTests(store)
  store.writeYaml([CONSTRUCTION_DIR, CONSTRUCTION_CONTRACT_FILE], { contractTests: [...existing, entry] })
}

/**
 * `done` 关：按所选包逐条检查。
 *
 * - `tdd`：红→绿时序；**关键档位**（`scale=critical`）额外要变异自证（`killed ≥ 1`）；
 * - `contract-first`：本卡必须有契约测试记录。
 * 返回**未通过**的检查；`exempt` 命中的项跳过（豁免必须带理由，读写两侧都校验）。
 */
export function doneGaps(
  store: SdoStore,
  journal: Journal,
  card: TaskCard,
  profile: ConstructionProfile | undefined,
  options: { scale?: string | undefined } = {},
): CardCheck[] {
  if (profile === undefined || !scopeCovers(profile, card.id)) return []
  const gaps: CardCheck[] = []
  const wants = (name: ConstructionPackage): boolean => profile.packages.includes(name)
  const exempt = (check: string): boolean => findExemption(profile, card.id, check) !== undefined

  if (wants('tdd')) {
    if (!exempt('tdd-red-green-missing')) gaps.push(...redGreenGaps(store, journal, card))
    if (!exempt('tdd-mutation-missing') && options.scale === 'critical') {
      // N3（评审）：规格要求 `killed ≥ 1` **且 `tool` 非空** —— 空 tool 的记录证不了"用什么杀的"
      const killed = readMutations(store)
        .filter((item) => item.task === card.id && item.tool.trim() !== '')
        .reduce((total, item) => total + item.killed, 0)
      if (killed === 0) {
        gaps.push({
          check: 'tdd-mutation-missing',
          ok: false,
          detail: fmt('uiConstruction.c16', { p1: card.id, p2: `.sdo/${CONSTRUCTION_DIR}/${CONSTRUCTION_TDD_FILE}` }),
        })
      }
    }
  }
  // **SDO-20（2026-10-05 真机，复发 7 次）**：`exempt` 的 schema 只有 `{task, check, why}`，
  // **表达不了类别**（评审 / 架构裁决 / 需求侧修正这类"零产品文件改动、工具面里没有 `sdo_test`"的卡）。
  // 逐卡插豁免已经复发 7 次，所以这里按**角色工具面**判：没有 `sdo_test` 的角色 ⇒ 该项 N/A。
  const canRecordContractTest = toolAllowList(card.role as never).length === 0 || toolAllowList(card.role as never).includes('sdo_test')
  if (wants('contract-first') && !exempt('contract-test-missing') && canRecordContractTest) {
    const hasTest = readContractTests(store).some((item) => item.task === card.id)
    if (!hasTest) {
      gaps.push({
        check: 'contract-test-missing',
        ok: false,
        detail: fmt('uiConstruction.c17', { p1: card.id, p2: `.sdo/${CONSTRUCTION_DIR}/${CONSTRUCTION_CONTRACT_FILE}` }),
      })
    }
  }
  return gaps
}
