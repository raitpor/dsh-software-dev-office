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
import { listTasks } from './plan.js'
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

/**
 * **死豁免诊断**（R-8 附录，sdo-test-new 2026-10-08）：`exempt` 按 `{task, check}` 绑卡 id，
 * 卡被 `drop` 之后用同内容**重建**（新 id）时豁免**不跟随、也不提示** —— 只有人肉比对
 * "卡状态 vs 豁免列表"才看得出来。本项目实证：TASK-030 因 R-9 被 drop 并重建为 TASK-043
 * ⇒ 旧豁免成死条目，新卡又撞同一堵墙，白花一轮（多花：block → 裁决 → release → 补豁免）。
 */
export function deadExemptions(store: SdoStore): { task: string; check: string; why: string; reason: 'missing' | 'dropped' }[] {
  const read = readConstructionProfile(store)
  const profile = read.profile
  if (read.status !== 'ok' || profile === undefined) return []
  const byId = new Map(listTasks(store).map((task) => [task.id, task]))
  const dead: { task: string; check: string; why: string; reason: 'missing' | 'dropped' }[] = []
  for (const item of profile.exempt) {
    const found = byId.get(item.task)
    if (found === undefined) dead.push({ ...item, reason: 'missing' })
    else if (found.status === 'dropped') dead.push({ ...item, reason: 'dropped' })
  }
  return dead
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
 * **这个 env 是不是"机器指纹"**（R-17 补充，sdo-test-new 2026-10-08）。
 *
 * 真机数据：`env` 是**自由文本** —— 同一张卡的红灯写「断言面=/tmp/tc003-harness.mjs（先于实现写好，…）」、
 * 绿灯写「断言面=TC-003（31 条，本次以临时目录内脚本重放…）」⇒ 文字不同但其实是**同一次实验**。
 * 把"env 必须逐字相等"当硬判据 ⇒ 本项目 46 张卡全红（越往后越红），而它**不是执行者的问题**。
 * 结论：只有长得像指纹的 env（`k=v; k=v`、无中文、不过长）才参与"同一次实验"的判定；
 * 散文 env 一律**不判**（判据不许对着它判死）。`harness` 是专门为此加的机器指纹字段，不受此限。
 */
function fingerprintLikeEnv(env: string): boolean {
  const text = env.trim()
  if (text === '') return false
  if (text.length > 300) return false
  if (/[\u4e00-\u9fff]/u.test(text)) return false
  if (!text.includes('=')) return false
  return text.split(';').every((part) => {
    const item = part.trim()
    return item === '' || /^[A-Za-z0-9_.-]+\s*=/u.test(item)
  })
}

/**
 * 红→绿时序：卡覆盖的**每条需求**，其用例必须**先记 `fail`、后有 `pass`**（从 journal 现算）。
 * 只记 pass 的用例说明"测试没红过"，按 TDD 口径不算数。
 */
export function redGreenGaps(
  store: SdoStore,
  journal: Journal,
  card: TaskCard,
  /**
   * **逐条判据的豁免**（R-8 ②）：`exempt(check) === true` 就跳过该条。
   *
   * 为什么必须给：规则③（红绿之间产物必须变化）对"验证/复算类卡片"是**结构性不可满足**的 ——
   * 它们的 DoD 恰恰要求产物**不变**（冻结基线；本项目 INV-005）。缺这个口子，执行者只能去改台账或放弃。
   */
  options: { exempt?: ((check: string) => boolean) | undefined } = {},
): CardCheck[] {
  const skip = (check: string): boolean => options.exempt?.(check) === true
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
  // **R-8 + R-17（sdo-test-new 2026-10-08）**：「最新」与「同一次实验」是**两个维度**，必须分开。
  //
  // R-8 修的是"按 id 取历史第一条"（历史结果不可变 ⇒ 后续卡继承别人当年的不一致）；
  // 但"`fail` 与 `pass` 各自独立取最新"又引入 R-17：红灯取本卡的 TR-053，绿灯却取**别人 4 小时后**的
  // TR-070（env 口径不同，因为 env 里带着会话/角色标记）⇒ 判据必然红，**而且越往后越红**（每轮验证都会
  // 产生"更晚的、env 不同的通过记录"）。
  //
  // 正确语义（R-17 建议 1+2 的合并）：
  //   ① 先筛「同一次实验」：`env` 与 `harness` 任一侧缺失 ⇒ 视为兼容（不判，老台账不受影响）；
  //      两侧都有且不等 ⇒ **不是同一次实验**；
  //   ② 在同实验的候选对（i<j：fail 在前、pass 在后）里取**最新**的一对；
  //   ③ 一组同实验对都没有 ⇒ 退回"最新的一对"（任何），让三条判据把**最接近的那对**的差异原因报出来。
  const envComparable = (red: (typeof results)[number], green: (typeof results)[number]): boolean =>
    fingerprintLikeEnv(red.env ?? '') && fingerprintLikeEnv(green.env ?? '')
  const harnessComparable = (red: (typeof results)[number], green: (typeof results)[number]): boolean =>
    (red.harness ?? '') !== '' && (green.harness ?? '') !== ''
  const sameExperiment = (red: (typeof results)[number], green: (typeof results)[number]): boolean => {
    if (envComparable(red, green) && red.env !== green.env) return false
    if (harnessComparable(red, green) && red.harness !== green.harness) return false
    return true
  }
  const pairOf = (caseId: string): { red: number; green: number } | undefined => {
    const indexes = (status: 'fail' | 'pass'): number[] =>
      results.map((item, index) => (item.caseId === caseId && item.status === status ? index : -1)).filter((index) => index >= 0)
    const fails = indexes('fail')
    const passes = indexes('pass')
    const latestFail = fails[fails.length - 1]
    if (latestFail !== undefined) {
      const after = passes.filter((index) => index > latestFail)
      // **本卡这次实验的绿灯**：之后第一条与之同实验的 pass（TR-053 → TR-054）
      const same = after.find((index) => {
        const green = results[index]
        const red = results[latestFail]
        return green !== undefined && red !== undefined && sameExperiment(red, green)
      })
      if (same !== undefined) return { red: latestFail, green: same }
      // 之后有 pass 但都不是同一次实验（别人更晚的运行）⇒ 用它作**诊断对**，把差异原因报出来
      const first = after[0]
      if (first !== undefined) return { red: latestFail, green: first }
    }
    // 最近一次红灯之后没有绿灯（还在红）：退回"最新的一对"，保住"曾经红→绿"这个语义
    for (let j = passes.length - 1; j >= 0; j -= 1) {
      const green = passes[j] as number
      const red = [...fails].reverse().find((index) => index < green)
      if (red !== undefined) return { red, green }
    }
    return undefined
  }
  const gaps: CardCheck[] = []
  const untraceable = results.filter((item) => !traceable.has(item.id))
  if (untraceable.length > 0 && !skip('tdd-result-untraceable')) {
    gaps.push({
      check: 'tdd-result-untraceable',
      ok: false,
      detail: fmt('uiConstruction.c32', { p1: untraceable.map((item) => item.id).join(' ') }),
    })
  }
  for (const requirement of card.requirements) {
    const owned = cases.filter((item) => item.requirement === requirement)
    const verified = owned.find((item) => pairOf(item.id) !== undefined)
    if (verified !== undefined) {
      // **R-3（sdo-test-new 2026-10-08，major）**：只看"先 fail 后 pass"分不清
      // 「实现由红转绿」与「**断言被改到能过**」—— 真机上五个实例都属于后者（执行者都主动披露了，
      // 缺的不是诚实而是判据）。三条机械判据把"同一次实验"钉住：
      //   ① 环境指纹一致（`env` 已有值，等于白送）；② 断言面指纹一致（`harness`，R-3 新增字段）；
      //   ③ **产物必须变化**（代码没变却转绿 ⇒ 直接判可疑）。
      // 任一侧缺字段就不判（不许凭空判红：老台账没有这些字段，`tdd-red-green-missing` 仍然照旧生效）。
      const pair = pairOf(verified.id) ?? { red: 0, green: 0 }
      const red = results[pair.red]
      const green = results[pair.green]
      if (red !== undefined && green !== undefined) {
        if (envComparable(red, green) && red.env !== green.env) {
          if (!skip('tdd-env-changed')) gaps.push({
            check: 'tdd-env-changed',
            ok: false,
            detail: fmt('uiConstruction.c33', { p1: verified.id, p2: red.env, p3: green.env }),
          })
        }
        if (harnessComparable(red, green) && red.harness !== green.harness) {
          if (!skip('tdd-harness-changed')) gaps.push({
            check: 'tdd-harness-changed',
            ok: false,
            detail: fmt('uiConstruction.c34', { p1: verified.id, p2: red.harness, p3: green.harness }),
          })
        }
        // **只有先确立了"同一次实验"（有可比指纹）**，才谈得上"产物没变却转绿" ——
        // 否则红的可能是另一次实验，判"产物没变"就是误判（真机 46 张卡的红里有一半是这么来的）。
        if ((envComparable(red, green) || harnessComparable(red, green))
          && (red.artifactSha256 ?? '') !== '' && red.artifactSha256 === green.artifactSha256) {
          if (!skip('tdd-artifact-unchanged')) gaps.push({
            check: 'tdd-artifact-unchanged',
            ok: false,
            detail: fmt('uiConstruction.c35', { p1: verified.id, p2: red.artifact ?? '' }),
          })
        }
      }
      continue
    }
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
    // **R-8 ②**：红绿的三条"同实验"判据各自可豁免（`tdd-env-changed` / `tdd-harness-changed` /
    // `tdd-artifact-unchanged`）—— 验证类卡片的产物必须不变，是结构性豁免而不是放水
    if (!exempt('tdd-red-green-missing')) gaps.push(...redGreenGaps(store, journal, card, { exempt }))
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
