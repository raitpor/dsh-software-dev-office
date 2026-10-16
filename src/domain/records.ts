/**
 * 验证、评审与交付的记录类产物（设计 §9.1 的 sdo_test / sdo_review / sdo_deliver）。
 *
 * 为什么放一起：它们都是**门禁的证据来源**，形状都很小，且都要被 G5/G6/G7 读。
 * 纪律：
 *   · 用例结果必须带证据（命令输出摘要 / 产物路径）；
 *   · 缺陷有严重度与状态，`blocker` 未关闭就不能过 G6；
 *   · 交付清单里的每个产物都要有 **sha256**，并显式声明原型内容已排除、回滚点在哪。
 */
import { createHash } from 'node:crypto'
import { fmt, t } from './i18n.js'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { nextId } from '../infra/ids.js'
import { phaseIndex } from './process.js'
import { loadProcess } from './process.js'
import { boolField, pushShapeNote, recordListOf, textOf } from '../infra/scalar.js'
import type { FieldShapeNote } from '../infra/scalar.js'
import type { Journal } from '../infra/journal.js'
import type { SdoStore } from '../infra/store.js'
import type { Requirement } from '../types.js'
import { oracleGaps } from './evidence.js'
import type { OracleRef } from './evidence.js'

export interface TestCase {
  id: string
  title: string
  kind: 'unit' | 'integration' | 'e2e'
  requirement?: string | undefined
  steps: string[]
  expected: string
  at: string
  /**
   * **判定基准来源（oracle）**（REQ-054 / TASK-020）。
   *
   * 病根：用例只记「期望」，不记「凭什么说这个期望是对的」⇒ 期望是作者随手写的也没人看得出来，
   * 用例于是退化成走过场。四类取值（需求验收标准 / 契约的成功与失败语义 / 冻结的旧实现基线 /
   * 专家判断）**都能机械核对**，核对实现只有一处：`oracleGaps()`（`evidence.ts`）。
   *
   * 与 `env` / `harness` 同口径：老台账没有这个字段照样读得出来（形状不是必填），
   * 但**缺它的用例不计入通过覆盖**（降级口径在 `supportedOracle()` 里，一类一处、不重写）。
   */
  oracle?: OracleRef | undefined
}

export interface TestResult {
  id: string
  caseId: string
  status: 'pass' | 'fail' | 'skip'
  evidence: string
  at: string
  /**
   * **环境指纹**（SDO-57 的 C 口径）：产生这条结果的运行环境（如 `jdk=21.0.2; probe=run_checks.py@v3`）。
   * 限定语的病根是「没有时点/前置绑定、会静默过期」——这里把**时点**（`at`）与**前置**（`env`）钉在证据上。
   */
  env?: string | undefined
  /** `declared` = 记录时显式声明；`inherited` = 未声明，按**最近登记的环境**归属（如实标注，不假装是声明的） */
  envSource?: 'declared' | 'inherited' | undefined
  /** 被检产物（相对路径）——记录时绑定 sha256，交付时**重算比对** ⇒ 产物一变，"过期"立刻可判 */
  artifact?: string | undefined
  artifactSha256?: string | undefined
  /**
   * **断言面指纹**（R-3，sdo-test-new 2026-10-08）：这一轮跑的**那套断言**（命令/harness 的 sha256 或稳定标识）。
   *
   * 病根：`redGreenGaps` 只看"同一 case 先有 fail、后有 pass"，而真机上"红灯之后**改断言**"与
   * "改实现"在台账上**完全等价**（5 个实例：TASK-023 改了一句断言公式、TASK-025 修了断言面自身的管道 bug…）。
   * 记下指纹后，红与绿**必须同指纹**才算是同一次实验。
   */
  harness?: string | undefined
  /**
   * **执行者**（REQ-053 / TASK-020）：跑出这条结果的人/会话（如 `subagent:tester:1`）。
   *
   * 与 `adoptedBy` 一起构成**独立性**这条判据的两个端点：两个值相同 = 自己给自己盖章。
   * 老台账没有它 ⇒ `isAdopted()` 判"未采纳"而不是"默认通过"（宁可不计入，也不放行）。
   */
  executedBy?: string | undefined
  /**
   * **采纳者**（REQ-053 / TASK-020）：独立评审并采纳这条结果的人/会话。**采纳即终点**：
   * 采纳动作本身不产生新的待采纳物（不得形成"评审自身还要被评审"的递归，C-42/C-52 那个坑）。
   */
  adoptedBy?: string | undefined
  /** 采纳时刻（采纳动作的留痕；缺它就是还没采纳） */
  adoptedAt?: string | undefined
  /** 采纳依据说明（采纳者凭什么采纳：自己的复跑、报告、评审记录…） */
  adoptionNote?: string | undefined
  /**
   * 结果级的判定基准**覆盖**（可选）：同一条用例在不同环境下判定基准会变时用它改判；
   * 没给就回落到用例上登记的那份（回落顺序只有 `supportedOracle()` 一处实现）。
   */
  oracle?: OracleRef | undefined
  /**
   * **这条测试结论覆盖的缺陷**（DEF-075 / 第三批 §3.8，绑定方式 (a)）。
   *
   * 为什么把绑定长在**结论**上（而不是新增 `defect-tc` 追溯边）：闭合的**依据**就是"跑过、且通过了"，
   * 依据与结论同生共死；而追溯边指向**用例**、依据却在**结果**上，读的时候还要再绕一层。
   * 形状：缺陷 id 列表（`DEF-xxx`）；**未知 id 在记录时被可读拒绝**（免得打错一个字就"绑上了"）。
   * 老台账没有这个字段照样读得出来（形状不是必填）。
   */
  defects?: string[] | undefined
  /**
   * **这条结论自称覆盖「全量」**（DEF-033 第三面 / 第四批 §3.5）。
   *
   * 为什么要一个**结构化声明**：`done` 的语义是"**本卡范围**绿"，`unfrozen` 记下"还有谁在飞"；
   * 于是"全局到底冻结了没有"只能靠**一次覆盖全量的跑**来回答 —— 而"哪条结论覆盖全量"过去无从机械判断
   * （只能靠 `evidence` 里的散文，或者让插件去认 `npm test` 这种**跑法**：那正是 DoD 明令不许硬编码的东西）。
   * 声明是调用方的事（谁跑的自己最清楚），核对自洽是插件的事 —— 与 `env` / `harness` 同一口径。
   *
   * 判据 `defects.unfrozen-full-green`（C-67，挂 **G7 交付门禁**）读它：有 `unfrozen` 非空的卡时，
   * 必须存在一条 `status=pass` 且本字段为 `true`、且时刻**晚于**最后一次未冻结完成的 `done` 的结论。
   * 缺省（老台账）= 不是全量结论，既有行为一字不变。
   */
  fullSuite?: boolean | undefined
}

/**
 * **缺陷的发现级别**（TASK-021）：这条缺陷是在哪一道验证面上被发现的。
 *
 * 与"严重度"是**两个维度**：严重度说"它有多坏"，发现级别说"谁逮住它的"。
 * 两者分开记，才判得出一件事：**断言面有没有漏**（漏了就是逃逸）。
 *
 * 为什么是这五档：V 模型左侧每落一级就有一道可分辨的验证面，
 * 右侧的"生产"是最后一道（那时发现的都是逃逸）。档位是**词表**，
 * 守卫用例按它逐条断言 —— 自由文本无法机械核对。
 */
export const DEFECT_DISCOVERY_LEVELS = ['评审', '单元', '集成', '系统', '验收', '生产'] as const
export type DefectDiscoveryLevel = (typeof DEFECT_DISCOVERY_LEVELS)[number]

export function isDefectDiscoveryLevel(value: string): value is DefectDiscoveryLevel {
  return (DEFECT_DISCOVERY_LEVELS as readonly string[]).includes(value)
}

/**
 * **缺陷记录**（`.sdo/defects/DEF-*.yml`）。
 *
 * 必填的仍是「标题 + 严重度 + 状态」——那是这条缺陷**是什么/多坏/还开不开**。
 * 本轮（TASK-021，REQ-055）补上三个"**根因面**"字段，它们是可选的（老台账不受影响），
 * 但给了就必须自洽：**逃逸**是"本该被前面的验证面逮住、却漏到后面才发现"，
 * 所以它要求 `discoveryLevel` 与 `rootCause` 都在手，否则"是否逃逸"这个结论无从核对。
 */
export interface Defect {
  id: string
  title: string
  severity: 'blocker' | 'major' | 'minor'
  caseId?: string | undefined
  status: 'open' | 'fixed' | 'closed' | 'wontfix'
  at: string
  /** **根因**（不是现象）：为什么它会进来 —— 缺判据 / 判据写错 / 断言面缺口 / 契约不清…… */
  rootCause?: string | undefined
  /** **发现级别**（`DEFECT_DISCOVERY_LEVELS` 之一）：这道缺陷是在哪一张验证面上被发现的。 */
  discoveryLevel?: DefectDiscoveryLevel | string | undefined
  /** **是否逃逸**：本该被更早的验证面逮住、却漏到了后面（`discoveryLevel` 越靠右越可疑）。 */
  escaped?: boolean | undefined
  // —————— §DEF-038（TASK-063）：**免责依据**两字段 ——————
  // 与上面三个"根因面"字段**同族同纪律**：可选、空串不落键、不假装有值。
  // 语义差别（不许混为一谈）：`rootCause` 答"**怎么进来的**"，这两个答"**为什么不修、谁拍的板**"。
  /**
   * **免责理由**（`status === 'wontfix'` 时的"为什么不修"）。
   *
   * 病根（DEF-038）：旧实现把 `wontfix` 与 `closed` 一起排除在"阻塞"之外 ⇒ **阻塞级缺陷标一个
   * `wontfix` 就让计数归零**，验证门禁的 C-51 直接判绿。用户 2026-10-13 裁定：**不该放过** ——
   * 语义从「放弃即不存在」改成「**放弃必须有人署名**」：阻塞级 + `wontfix` 必须**理由与批准人齐备**才放行。
   */
  waiveReason?: string | undefined
  /**
   * **免责批准人**（谁批准"这条阻塞级缺陷不修"）—— 与 `waiveReason` **缺一不可**。
   *
   * 只写理由不写人 = 没人负责；只写人不写理由 = 无从复核。两者齐备才进 C-51 的
   * 「以 wontfix 放行的阻塞级缺陷」清单（**可见即约束**）。
   */
  waiveApprovedBy?: string | undefined
}

/** 阻塞级缺陷**尚未闭合**（`closed` 之外的四态都算）—— `blockersOpen` 与 C-51 的同一处口径。 */
export function isBlockerOpen(defect: Defect): boolean {
  return defect.severity === 'blocker' && defect.status !== 'closed'
}

/**
 * **以 `wontfix` 放行的阻塞级缺陷**（DEF-038 / 用户 2026-10-13 裁定）。
 *
 * 「放行」只有一个成立条件：**`waiveReason` 与 `waiveApprovedBy` 两个字段都非空**
 * （去空白后非空 —— 空串等于没写，与 `recordDefect` 的归一化口径一致）。
 * 缺任一条都**不算免责成立**，该缺陷仍按"未关闭的阻塞级缺陷"计入 C-51 的判红名单。
 *
 * 为什么两字段必须一起判：只给理由 ⇒ 没人负责；只给批准人 ⇒ 无从复核。
 * 这两条都是"放弃即不存在"的旧语义想掩盖的东西，所以判据不接受单边。
 */
export function isBlockerWaived(defect: Defect): boolean {
  return isBlockerOpen(defect)
    && defect.status === 'wontfix'
    && textOf(defect.waiveReason).trim() !== ''
    && textOf(defect.waiveApprovedBy).trim() !== ''
}

/**
 * **阻塞级缺陷的四态分类**（防御门禁 C-51 与读数共用的**唯一出口**）。
 *
 * 为什么不把这件事散在 `gates.ts` 与 `records.ts` 各写一遍：`blockersOpen` 是既有读数、
 * C-51 是判据 —— 两处过滤条件历史上就是这么分叉的（DEF-038：`records.ts` 排除 wontfix、
 * `gates.ts` 一模一样再抄一遍）。这里收成一处，判据与读数不再各有一套"什么算阻塞"。
 */
export function blockerBreakdown(defects: Defect[]): {
  /** 尚未闭合的阻塞级缺陷（含已用 wontfix 放行的） */
  open: Defect[]
  /** 免责依据**齐备**、以 `wontfix` 放行的 */
  waived: Defect[]
  /** 仍**拦住**门禁的：未闭合且免责依据不成立的 */
  blocking: Defect[]
} {
  const open = defects.filter(isBlockerOpen)
  const waived = open.filter(isBlockerWaived)
  const blocking = open.filter((defect) => !isBlockerWaived(defect))
  return { open, waived, blocking }
}

/**
 * **真源里的 id**（D3，整仓评审 blocker）。
 *
 * 病根：id 只从"可手改的文件列表"分配 ⇒ **删掉文件后号会回落**（实测 TR：记两条 → 删 TR-002.yml → 再记
 * **又是 TR-002**，journal 里同 id 两条事实；`RUN-` 更是按 `existing.length + 1` 数条数）。
 * 追加式真源（journal）才是"这个号用过没有"的权威，所以分配时必须**取文件与真源事件的并集**。
 */
function journalIds(journal: Journal, prefix: string): string[] {
  const re = new RegExp(`^${prefix}-\\d+$`)
  const found: string[] = []
  for (const event of journal.read().events) {
    for (const value of Object.values(event.data)) {
      if (typeof value === 'string') {
        if (re.test(value)) found.push(value)
      } else if (Array.isArray(value)) {
        for (const item of value) if (typeof item === 'string' && re.test(item)) found.push(item)
      }
    }
  }
  return found
}

function idOf(store: SdoStore, journal: Journal, dir: string, prefix: string): string {
  const bar = prefix.replace(/-$/u, '')
  const names = store.listNames(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.yml'))
  const fromFiles = names.map((name) => name.replace(/\.yml$/u, ''))
  return nextId(bar, [...fromFiles, ...journalIds(journal, bar)])
}

export function listTestCases(store: SdoStore): TestCase[] {
  return store
    .listNames('tests')
    .filter((name) => /^TC-\d+\.yml$/u.test(name))
    .map((name) => store.readYaml<{ testCase: TestCase }>('tests', name)?.testCase)
    .filter((item): item is TestCase => item !== undefined)
}

export function recordTestCase(
  store: SdoStore,
  journal: Journal,
  input: Omit<TestCase, 'id' | 'at'>,
  /**
   * **建案者**（`DEF-079` / 第六批 §3.3）。缺省 `'sdo'` = 旧口径（合成调用/脚本）。
   *
   * 病根（核过后收窄）：建案**本来就会**落 `test/recorded`（真源有痕、且该事件**本来就在**
   * `SIGNATURE_NEUTRAL_EVENTS` 里 ⇒ 不作废签字）—— 缺的只是"**谁**建的"：事件里的 `actor`
   * 一律是缺省 `'sdo'`，与"是哪个会话在什么时候建的"对不上。所以修法不是新增事件类型，
   * 而是把调用方的身份**如实记进 `actor`**（`TestCase` 文件形状一字不动 ⇒ 存量 149 条不追溯）。
   */
  actor = 'sdo',
): TestCase {
  const testCase: TestCase = { ...input, id: idOf(store, journal, 'tests', 'TC-'), at: new Date().toISOString() }
  store.writeYaml(['tests', `${testCase.id}.yml`], { testCase })
  journal.append('test/recorded', { id: testCase.id, kind: testCase.kind, requirement: testCase.requirement ?? '' }, actor)
  return testCase
}

export function listTestResults(store: SdoStore): TestResult[] {
  return store
    .listNames('tests/results')
    .filter((name) => /^TR-\d+\.yml$/u.test(name))
    .map((name) => store.readYaml<{ result: TestResult }>('tests/results', name)?.result)
    .filter((item): item is TestResult => item !== undefined)
}

/**
 * **结果是「用例的」结果**（DEF-037）：写入前必须能对上一个**真实存在**的用例。
 *
 * 病根是"只核有没有、不核与对象对不对得上"：旧实现逐字段透传后直接落盘 ⇒ 台账**不可区分**
 * "指向不存在的用例"与"指向真实用例"（`cases=0 results=1 passed=1` 就是这么来的）。
 * 两条可读拒绝，都点名可执行修法；**不**猜、**不**自动造用例。
 */
/**
 * **已修但无测试结论的缺陷**（DEF-075 / 第三批 §3.8）—— 判据的唯一出口。
 *
 * 病根：`fixed` 的缺陷可以**永久不被测试**而门禁不判红任何一格（C-51 只管**阻塞级**；C-63 只遍历
 * **卡上声明 `fixes`** 的行 —— 外部会话直接修的缺陷**没有卡** ⇒ `checked = 0` ⇒ 判 N/A ⇒ 盲区
 * 正好覆盖本项目的修复主力通道）。用户的长期准则是"凡能机械强制的纪律，不要靠提醒记住"。
 *
 * 口径：
 *   · **依据 = 一条 `pass` 的测试结论（TR）把它绑进 `defects`**（`fail`/`skip` 不算依据 —— 那说明它还坏着）；
 *   · 只看 `status === 'fixed'` 的缺陷（`wontfix` 由 C-51/C-63 的免责两字段那套管；`closed` 不在本条范围，
 *     措辞不写成"必须 closed"：`closed` 是**结果**、TR 是**依据**，只要求依据才可操作）；
 *   · 有 `fail` 结果绑着它时**如实一并点名**（读者要看得见"它现在还是坏的"）。
 */
export function fixedDefectsWithoutTestResult(store: SdoStore): { id: string; failingResults: string[] }[] {
  const passing = new Set<string>()
  const failing = new Map<string, string[]>()
  for (const result of listTestResults(store)) {
    for (const raw of result.defects ?? []) {
      const id = textOf(raw).trim()
      if (id === '') continue
      if (result.status === 'pass') passing.add(id)
      else if (result.status === 'fail') failing.set(id, [...(failing.get(id) ?? []), result.id])
    }
  }
  return listDefects(store)
    .filter((defect) => defect.status === 'fixed')
    .filter((defect) => !passing.has(defect.id))
    .map((defect) => ({ id: defect.id, failingResults: failing.get(defect.id) ?? [] }))
}

export function recordTestResult(
  store: SdoStore,
  journal: Journal,
  input: Omit<TestResult, 'id' | 'at'>,
  /**
   * **对账用上下文**（DEF-011）：给了 `workspace` 才能把调用方声明的 `artifactSha256` 与现算值对账。
   * 不传 ⇒ 维持旧行为（不做核对，直接落调用方给的值）—— 直连域层的既有用例不受影响。
   */
  options: { workspace?: string | undefined } = {},
): { ok: true; result: TestResult } | { ok: false; code: 'case-id-required' | 'case-not-found' | 'artifact-hash-mismatch' | 'unknown-defect'; detail: string } {
  const caseId = textOf(input.caseId).trim()
  if (caseId === '') {
    return { ok: false, code: 'case-id-required', detail: fmt('uiTest.kResultCaseIdRequired') }
  }
  const known = listTestCases(store)
  if (!known.some((item) => item.id === caseId)) {
    return {
      ok: false,
      code: 'case-not-found',
      detail: fmt('uiTest.kResultCaseNotFound', {
        p1: caseId,
        p2: known.length === 0 ? t('uiTest.kResultNoCases') : known.map((item) => item.id).join(t('uiTest.kListSep')),
      }),
    }
  }
  // **DEF-075**：`defects` 是"这条结论依据于哪些缺陷已修"的**绑定** —— 打错一个字就静默绑不上，
  // 所以未知 id 在写盘前**可读拒绝**（点名那几个 id 与台账里现有的缺陷数）。
  const declaredDefects = (input.defects ?? []).map((id) => textOf(id).trim()).filter((id) => id !== '')
  if (declaredDefects.length > 0) {
    const known = new Set(listDefects(store).map((defect) => defect.id))
    const unknown = declaredDefects.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      return {
        ok: false,
        code: 'unknown-defect',
        detail: fmt('uiTest.kResultUnknownDefect', { p1: unknown.join('、'), p2: String(known.size) }),
      }
    }
  }
  const adoptedBy = textOf(input.adoptedBy).trim()
  // **DEF-011**：声明了被检产物的哈希就必须与现算值对账（不一致 / 读不到 ⇒ 可读拒绝、零写盘）。
  // 有 `workspace` 才核对得起来；没给就维持旧口径（直连域层的调用方拿不到路径上下文）。
  const workspace = options.workspace ?? ''
  const artifact = textOf(input.artifact).trim()
  const bound = workspace === ''
    ? { ok: true as const, sha256: textOf(input.artifactSha256).trim() }
    : reconcileArtifactSha256(workspace, artifact, input.artifactSha256)
  if (!bound.ok) return { ok: false, code: 'artifact-hash-mismatch', detail: bound.detail }
  const result: TestResult = {
    ...input,
    ...(artifact === '' ? {} : { artifact, artifactSha256: bound.sha256 }),
    ...(declaredDefects.length === 0 ? {} : { defects: declaredDefects }),
    // **REQ-053**：`adoptedBy` 一给就是一次**采纳动作** ⇒ 由记录端盖上采纳时刻
    // （不要求调用方自己记得写：会忘的字段迟早会忘，而"采纳了却说不出什么时候"就核不动了）。
    ...(adoptedBy === '' || textOf(input.adoptedAt).trim() !== '' ? {} : { adoptedAt: new Date().toISOString() }),
    id: idOf(store, journal, 'tests/results', 'TR-'),
    at: new Date().toISOString(),
  }
  store.writeYaml(['tests', 'results', `${result.id}.yml`], { result })
  journal.append('test/recorded', {
    id: result.id,
    caseId: result.caseId,
    status: result.status,
    // **SDO-57**：时点归 `at`，前置归 `env`/`artifact` —— 审计要能看到"这条结论是在什么环境下得出的"
    ...(result.env === undefined ? {} : { env: result.env, envSource: result.envSource ?? 'declared' }),
    ...(result.artifact === undefined ? {} : { artifact: result.artifact, artifactSha256: result.artifactSha256 ?? '' }),
    // **R-3**：断言面指纹也进真源事件（红绿必须同指纹，判据从事件/记录都能复算）
    ...(result.harness === undefined ? {} : { harness: result.harness }),
    // **DEF-075**：绑定进真源（"这条结论依据于哪些缺陷已修"离线可读）
    ...(declaredDefects.length === 0 ? {} : { defects: declaredDefects.join(',') }),
    // **DEF-033 第三面**：`fullSuite` 也进真源事件（文件可手改，只有 append-only 的事件挡得住事后补标）
    ...(result.fullSuite === true ? { fullSuite: true } : {}),
    // **REQ-053（TASK-020）**：「谁执行的 / 谁采纳的」必须进 append-only 的事件 ——
    // `tests/results/*.yml` 是手可改的，独立性这条判据的两个端点只能靠真源佐证
    // （与 D4/R1 的"文件 vs journal"同一纪律：文件里把 `adoptedBy` 改成另一个人也查得出来）。
    ...(result.executedBy === undefined ? {} : { executedBy: result.executedBy }),
    ...(result.adoptedBy === undefined ? {} : { adoptedBy: result.adoptedBy }),
    ...(result.adoptedAt === undefined ? {} : { adoptedAt: result.adoptedAt }),
    ...(result.oracle === undefined ? {} : { oracleKind: textOf(result.oracle.kind) }),
  })
  return { ok: true, result }
}

export function listDefects(store: SdoStore): Defect[] {
  return store
    .listNames('defects')
    .filter((name) => /^DEF-\d+\.yml$/u.test(name))
    .map((name) => store.readYaml<{ defect: Defect }>('defects', name)?.defect)
    .filter((item): item is Defect => item !== undefined)
}

/**
 * 登记一条缺陷。
 *
 * **根因面三个字段**（TASK-021 / REQ-055）与"缺陷是什么"一起落盘，并**一并写进 `defect/recorded`
 * 事件**：`defects/*.yml` 可手改，唯一挡得住事后改写的仍是 append-only 的真源事件
 * （与 `recordTestResult` 把 `env`/`artifact`/`harness` 写进事件同一条纪律）。
 *
 * 归一化（免得磁盘上出现 `'true'` 这种"看着像真、其实是字符串"的值）：
 *   · `rootCause` / `discoveryLevel` 去空白，空串 ⇒ 不写这个键（"没写"与"写了空"分开）；
 *   · `escaped` 走 `boolField`：只认真正的布尔值，认不出的**原样带上**（不假装 false）。
 */
export function recordDefect(store: SdoStore, journal: Journal, input: Omit<Defect, 'id' | 'at'>): Defect {
  const rootCause = textOf(input.rootCause).trim()
  const discoveryLevel = textOf(input.discoveryLevel).trim()
  // **DEF-038（TASK-063）**：免责依据两字段走**同一套归一化**（去空白、空串不落键）——
  // 判据侧 `isBlockerWaived` 判的正是"去空白后非空"，两边口径同源，不会出现
  // "盘上写了空串、读数以为齐备"这种假放行。
  const waiveReason = textOf(input.waiveReason).trim()
  const waiveApprovedBy = textOf(input.waiveApprovedBy).trim()
  // `boolField` 只认**真正的布尔值**：写成 `'true'` / `'yes'` 一律归 `undefined`
  // （宁可不写，也不要把"看着像真"的字符串落成真值 —— 逃逸判定会因此说反）
  const escaped = boolField(input.escaped).value
  const defect: Defect = {
    ...input,
    // 没写就不落键（`undefined` 在本仓的 YAML 子集里**不支持序列化**，落键即抛：
    //  "没写"与"写了空"必须分开，靠"有没有这个键"表达）
    ...(rootCause === '' ? {} : { rootCause }),
    ...(discoveryLevel === '' ? {} : { discoveryLevel }),
    ...(escaped === undefined ? {} : { escaped }),
    ...(waiveReason === '' ? {} : { waiveReason }),
    ...(waiveApprovedBy === '' ? {} : { waiveApprovedBy }),
    id: idOf(store, journal, 'defects', 'DEF-'),
    at: new Date().toISOString(),
  }
  store.writeYaml(['defects', `${defect.id}.yml`], { defect })
  journal.append('defect/recorded', {
    id: defect.id,
    severity: defect.severity,
    status: defect.status,
    // **根因 / 发现级别 / 是否逃逸**：审计要能从真源重建"这条是逃逸还是本道面自己逮住的"
    ...(defect.rootCause === undefined ? {} : { rootCause: defect.rootCause }),
    ...(defect.discoveryLevel === undefined ? {} : { discoveryLevel: defect.discoveryLevel }),
    ...(defect.escaped === undefined ? {} : { escaped: defect.escaped }),
    // **免责依据**（DEF-038）：同样进 append-only 真源 —— "谁批的、凭什么批"必须能离线回读，
    // 否则 C-51 的放行就只是 `defects/*.yml` 上的一句可手改的话。
    ...(defect.waiveReason === undefined ? {} : { waiveReason: defect.waiveReason }),
    ...(defect.waiveApprovedBy === undefined ? {} : { waiveApprovedBy: defect.waiveApprovedBy }),
  })
  return defect
}

/** 一次缺陷更正要改的字段（SDO-55：`title` 以前被静默丢掉）。 */
export interface DefectUpdate {
  status?: Defect['status'] | undefined
  title?: string | undefined
  severity?: Defect['severity'] | undefined
  caseId?: string | undefined
  /**
   * **事件载荷**（真机追加实测）：调用方把更正说明写进 `evidence=`，旧实现**静默丢弃**
   * （回执说「已更新」，而 journal 里零命中 —— 更正内容只能活在 `defects/*.yml`，审计链看不到）。
   * 现在它与 `reason` 一起**原样写进 `defect/updated` 事件**；给了它就是一次**有内容的更正**（不算 no-op）。
   */
  evidence?: string | undefined
  reason?: string | undefined
  // —————— §DEF-038（TASK-063）：免责依据两字段**在更新路径上也受理** ——————
  // 与 `rootCause` 一族**不同**的一处（有意为之，理由如下）：根因面三个字段答的是"这条缺陷怎么来的"，
  // 是**历史事实**，事后改它等于篡改历史 ⇒ 更新路径可读拒绝。而免责依据答的是"**现在**要不要放过它、
  // 谁拍的板" —— 那是一个**决定**，决定本来就会被补、被改、被撤销（撤销 = 改回 `status=fixed` 并
  // 把理由换成"决定返工"）。若这里也拒绝，修法就只剩"重建一条缺陷"，反而销毁审计链。
  // 纪律仍与一族**同源**：空串不许当"填了"（调用方给空白 ⇒ 可读拒绝，见 `index.ts`），
  // 与现值相同 ⇒ `no-op-update`，改动逐条写进 append-only 的 `defect/updated` 事件。
  /** **免责理由**（"为什么不修"）—— 与 `waiveApprovedBy` 一起决定阻塞级 `wontfix` 能否放行 */
  waiveReason?: string | undefined
  /** **免责批准人**（谁批准不修）—— 与 `waiveReason` 缺一不可 */
  waiveApprovedBy?: string | undefined
}

/**
 * 标题里的**状态前缀由 `status` 派生，不写死在文本里**（SDO-56）。
 *
 * 真机现象：`DEF-022/023/024` 的 `title` 以 `[open]` 开头，而三者 `status` 都是 `closed`
 * —— 前缀写死在文本里就一定会和字段打架，而读者只看标题那一眼。
 */
export function stripStatusPrefix(title: string): { title: string; stripped: string } {
  const match = /^\s*\[(open|fixed|closed|wontfix)\]\s*/u.exec(title)
  if (match === null) return { title: title.trim(), stripped: '' }
  return { title: title.slice(match[0].length).trim(), stripped: match[1] ?? '' }
}

/**
 * 更正一条缺陷（**SDO-55 补丁规格**）。
 *
 * 1. 更正必须落 **append-only 事件**（`defect/updated { id, changes:[{field,from,to}], by }`）——
 *    旧实现只发 `{id,status}`，于是「改过 title」这件事在真源里**根本不存在**
 *    （回执说「已更新」、文件一字未改 ⇒ 流程官据此对外误称「已更正」）；
 * 2. **no-op 更新必须报错**（`no-op-update`），不得回一句「已更新」；
 * 3. 标题里写死的状态前缀（`[open]` 等）写入时**剥掉**（状态由字段派生），并作为一次真实更正入账。
 */
export function updateDefect(
  store: SdoStore,
  journal: Journal,
  id: string,
  patch: DefectUpdate,
  by = 'human',
):
  | { ok: true; defect: Defect; changes: { field: string; from: string; to: string }[] }
  | { ok: false; code: 'not-found' | 'no-op-update'; detail: string } {
  const defect = listDefects(store).find((item) => item.id === id)
  if (defect === undefined) return { ok: false, code: 'not-found', detail: `没有这条缺陷：${id}` }
  const next: Defect = { ...defect }
  const changes: { field: string; from: string; to: string }[] = []
  const apply = (field: string, from: string, to: string | undefined): void => {
    if (to === undefined || from === to) return
    changes.push({ field, from, to })
  }
  if (patch.status !== undefined) {
    apply('status', defect.status, patch.status)
    next.status = patch.status
  }
  if (patch.severity !== undefined) {
    apply('severity', defect.severity, patch.severity)
    next.severity = patch.severity
  }
  if (patch.caseId !== undefined) {
    apply('caseId', defect.caseId ?? '', patch.caseId)
    next.caseId = patch.caseId
  }
  // **DEF-038（TASK-063）**：免责依据两字段就在这条更正链上改 —— 与 `status` 同一种处置
  // （"从空到有"与"改写理由"都算**真实差异**，逐条进 `defect/updated` 的 `changes`）。
  if (patch.waiveReason !== undefined) {
    apply('waiveReason', defect.waiveReason ?? '', patch.waiveReason)
    next.waiveReason = patch.waiveReason
  }
  if (patch.waiveApprovedBy !== undefined) {
    apply('waiveApprovedBy', defect.waiveApprovedBy ?? '', patch.waiveApprovedBy)
    next.waiveApprovedBy = patch.waiveApprovedBy
  }
  // **SDO-56**：标题里的状态前缀**由 status 派生**。两条都要做：
  // ① 调用方写进来的新标题若带前缀 ⇒ 剥掉；
  // ② **存量**标题里写死的过时前缀（`[open]` 而 status=closed）⇒ 借这次更正一并清掉（作为一次真实更正入账）。
  const storedPrefix = stripStatusPrefix(defect.title).stripped
  const incomingTitle = stripStatusPrefix(patch.title ?? defect.title)
  if (patch.title !== undefined || storedPrefix !== '' || incomingTitle.stripped !== '') {
    apply('title', defect.title, incomingTitle.title)
    next.title = incomingTitle.title
    const strippedPrefix = incomingTitle.stripped !== '' ? incomingTitle.stripped : storedPrefix
    if (strippedPrefix !== '') {
      changes.push({ field: 'titleStatusPrefix', from: `[${strippedPrefix}]`, to: 'derived-from-status' })
    }
  }
  const payloadEvidence = (patch.evidence ?? '').trim()
  const payloadReason = (patch.reason ?? '').trim()
  if (payloadEvidence !== '' || payloadReason !== '') {
    changes.push({ field: 'evidence', from: '', to: 'event-payload' })
  }
  if (changes.length === 0) {
    return {
      ok: false,
      code: 'no-op-update',
      detail: `${id} 的这些字段与现值完全相同 —— 没有可更正的内容（回执不得说「已更新」`,
    }
  }
  store.writeYaml(['defects', `${id}.yml`], { defect: next })
  journal.append('defect/updated', {
    id,
    changes,
    by,
    // 载荷原样入账（`evidence`/`reason` 缺省不写键，保持事件紧凑）
    ...(payloadEvidence === '' ? {} : { evidence: payloadEvidence }),
    ...(payloadReason === '' ? {} : { reason: payloadReason }),
  })
  return { ok: true, defect: next, changes }
}

/**
 * **证据时效判定**（SDO-57 的 C 口径）。
 *
 * 真机病根：卡面普遍引用一句「唯一失败项是 spell_pieces」的限定语，而探针/环境一变它就**静默过期**了
 * （复跑后失败项变成 real-registry）。这里把"过期"变成可机械判定的东西：
 *   · 结果绑了 `artifact` ⇒ **重算哈希比对**（产物变了就是过期，最强的一种）；
 *   · 结果记了 `env` 且当前环境也有 ⇒ 不等即过期；
 *   · 结果没记 `env` ⇒ 归入 `unrecorded`（**如实说"无法机械核验"**，不判红 —— 否则历史证据全红）。
 */
export function evidenceFreshness(
  store: SdoStore,
  workspace: string | undefined,
  currentEnv: string | undefined,
): { stale: { resultId: string; caseId: string; reason: string }[]; unrecorded: string[] } {
  const stale: { resultId: string; caseId: string; reason: string }[] = []
  const unrecorded: string[] = []
  // **P-7（2026-10-09 复测建议评估，真机复跑实证）**：这里旧实现是 `for (const result of listTestResults(store))`
  // —— 平铺**全部历史**。于是"某用例早年的 pass 绑着旧产物哈希"会被**永久**算作过期证据，
  // 哪怕同一用例早已有更新的 pass（真机 9 条告警里 7 条属这种）。时效问的是"**我们现在依赖的那份**证据
  // 还新鲜吗"，所以只看每条用例的**最新**结果 —— 与 `verificationStats` 用**同一份** latest-wins 实现。
  for (const result of latestResultPerCase(listTestResults(store))) {
    if (result.status !== 'pass') continue
    if ((result.env ?? '') === '') {
      unrecorded.push(result.id)
    } else if (workspace !== undefined && currentEnv !== undefined && currentEnv !== '' && result.env !== currentEnv) {
      stale.push({
        resultId: result.id,
        caseId: result.caseId,
        reason: `环境指纹已变（结果记于 ${result.env}，当前是 ${currentEnv}）`,
      })
    }
    if (workspace !== undefined && (result.artifact ?? '') !== '') {
      const now = hashArtifact(workspace, result.artifact ?? '')
      if (now !== (result.artifactSha256 ?? '')) {
        stale.push({
          resultId: result.id,
          caseId: result.caseId,
          reason: `被检产物 ${result.artifact} 已变（记录时 ${(result.artifactSha256 ?? '').slice(0, 12)}…，现在 ${now.slice(0, 12)}…）`,
        })
      }
    }
  }
  return { stale, unrecorded }
}

/**
 * **每条用例只保留最新的一条结果**（latest-wins 的**唯一实现**）。
 *
 * 排序口径：`at` 更大的更新；`at` 拿不到（老台账手写的记录）时按 **id 的数字序**兜底 ——
 * `idOf` 保证 id 递增分配，所以"更大的 TR 号 = 更晚记录"。两者都拿不到就保留先遇到的那条。
 *
 * **为什么必须只有一份实现**（D-24 级别的教训）：`verificationStats`（SDO-50 修过）与
 * `evidenceFreshness`（**漏改**）本来是同一件事的两处代码 —— 后者一直平铺遍历全部历史，
 * 于是"同用例早已有更新的 pass"的旧记录被**永久**算作过期证据：真机 9 条过期告警里 7 条属这种，
 * 每份交付都带一串必然出现、且**没有任何动作可做**的告警（报警疲劳，正是本项目反复警惕的那种）。
 */
export function latestResultPerCase<T extends { id: string; caseId: string; at?: string | undefined }>(
  results: readonly T[],
): T[] {
  const numeric = (id: string): number => {
    const match = /(\d+)/u.exec(id)
    return match === null ? -1 : Number(match[1])
  }
  const newer = (candidate: T, current: T): boolean => {
    const a = textOf(candidate.at)
    const b = textOf(current.at)
    if (a !== '' && b !== '' && a !== b) return a > b
    return numeric(candidate.id) >= numeric(current.id)
  }
  const latest = new Map<string, T>()
  for (const result of results) {
    const previous = latest.get(result.caseId)
    if (previous === undefined || newer(result, previous)) latest.set(result.caseId, result)
  }
  return [...latest.values()]
}

/** 验证统计（G5/G6 用）。 */
export function verificationStats(store: SdoStore, journal?: Journal | undefined): {
  cases: number
  results: number
  passed: number
  failed: number
  skipped: number
  defectsOpen: number
  /**
   * **仍拦住门禁的阻塞级缺陷数**（DEF-038 / TASK-063 起）。
   *
   * 语义修正：`wontfix` **不再**与 `closed` 同等放过 —— 只有 `waiveReason` 与
   * `waiveApprovedBy` **齐备**的阻塞级 `wontfix` 才不算（`isBlockerWaived`）。
   * 读数与 C-51 共用 `blockerBreakdown` 一处过滤，不会再出现两套口径。
   */
  blockersOpen: number
  failedCaseIds: string[]
  /**
   * **D4（整仓评审 major）**：`tests/results/*.yml` 里有、但真源 journal **没有 `test/recorded`** 的结果 id。
   * 实测：手写 `TR-001.yml(status=pass, evidence='')` + journal 零事件 ⇒ `passed=1`，G6/C-50 照绿；
   * `recordTestResult(fail)` 之后把文件改成 `pass` 也查不出来（journal 里仍是 fail）。
   * 有了这份名单，"证据是跑出来的"与"证据是写出来的"才分得开。
   */
  unjournaled: string[]
  /**
   * **R1（复审 major）**：文件里的 `status` 与真源 `test/recorded` 事件里的 `status` **不一致**的结果。
   * 复审实测：journal 记 `fail`、把结果文件改成 `pass` ⇒ 旧实现（连 D4 硬化后的 `unjournaled` 都算上）看不出
   * 问题，`passed=1`、`unjournaled=[]` ⇒ 纯 waterfall 项目里"把红改成绿"这条捷径仍然存在。
   */
  tampered: { id: string; file: string; journal: string }[]
  /**
   * **REQ-053（TASK-020）**：`status=pass` 但**没被独立采纳**的结果 id（执行者缺登记 / 采纳者缺登记 /
   * 采纳者就是执行者 / 判定基准缺或不成立）。
   *
   * 病根：`passed` 此前等于"有一条 pass 结果"⇒ **开发者自己跑一遍自己盖章**就算通过，
   * 门禁只看得见一个数字。降级口径与 REQ-053 一致：**不予计入 + 在门禁里点名**，
   * 所以这份名单不是告警而是判据的输入（`passedAdopted` 就是"扣掉这些之后还剩几条"）。
   */
  unadopted: string[]
  /**
   * **真正计入通过**的结果数（`passed` 扣掉 `unadopted` 之后的条数）。
   *
   * 为什么与 `passed` 并存而不是改写 `passed`：`passed` 是**既有读数**（"台账里有几条 pass"），
   * 多个历史用例与回执按它断言（m56/m52/m85 明写「统计口径不变」）—— 悄悄改它的语义就是
   * 让既有结论换了个意思，正是本项目最忌讳的那种静默。**新语义用新字段**，
   * 判据（G6 的 C-50 一族）要用"已采纳"时读 `passedAdopted` 并点名 `unadopted`。
   */
  passedAdopted: number
} {
  const allResults = listTestResults(store)
  // **SDO-50（真机，判据层自锁）**：旧实现把所有历史结果**平铺**统计 ⇒ 一条用例历史上出现过一次 fail
  // 就**永远**留在红名单里，而门禁给的补救话术是「修好并重跑」——重跑只能新增一条 pass，
  // 旧 fail 不会被替代 ⇒ **补救动作在机制上不可能奏效**（真机 TC-053：TR-061 fail 01:04 / TR-066 pass 08:01，
  // G6 判定 08:12 仍红）。现在按 `caseId` 分组取**最新**一条（latest-wins）；
  // 完整历史仍留在 `tests/results/` 与 journal 里（「失败→修复→改判」的证据链不丢）。
  const results = latestResultPerCase(allResults)
  const defects = listDefects(store)
  const failed = results.filter((result) => result.status === 'fail')
  // **REQ-053（TASK-020）**：「通过集只取已采纳的结果」——采纳判据的实现只有一处
  // （`isAdopted()`，下面），这里按最新结果逐条问它；未采纳的**点名**而不是静默扣分。
  const casesById = new Map(listTestCases(store).map((item) => [item.id, item]))
  const adoptedPass = results.filter(
    (result) => result.status === 'pass' && isAdopted(store, result, casesById.get(result.caseId)).adopted,
  )
  const unadopted = results
    .filter((result) => result.status === 'pass' && !adoptedPass.includes(result))
    .map((result) => result.id)  // **D4**：逐条核对"这条结果有没有 `test/recorded` 事件佐证"
  const recordedIds = new Set(
    (journal?.read().events ?? [])
      .filter((event) => event.type === 'test/recorded')
      .map((event) => String(event.data.id ?? '')),
  )
  const unjournaled = journal === undefined ? [] : allResults.filter((result) => !recordedIds.has(result.id)).map((result) => result.id)
  // **R1**：事件里的状态 vs 文件里的状态（事件是追加式的、文件是可手改的 ⇒ 不一致就是被改写）
  const recordedStatus = new Map<string, string>()
  for (const event of journal?.read().events ?? []) {
    if (event.type !== 'test/recorded') continue
    recordedStatus.set(String(event.data.id ?? ''), String(event.data.status ?? ''))
  }
  const tampered = allResults
    .filter((result) => recordedStatus.has(result.id) && recordedStatus.get(result.id) !== result.status)
    .map((result) => ({ id: result.id, file: result.status, journal: recordedStatus.get(result.id) ?? '' }))
  return {
    cases: listTestCases(store).length,
    results: results.length,
    // **口径不变**：`passed` 仍是"台账里有几条最新 pass"（既有回执与用例按它断言）
    passed: results.filter((result) => result.status === 'pass').length,
    // **新语义用新字段**：真正计入通过的是"已被独立采纳"的那些（REQ-053）
    passedAdopted: adoptedPass.length,
    failed: failed.length,
    skipped: results.filter((result) => result.status === 'skip').length,
    defectsOpen: defects.filter((defect) => defect.status === 'open' || defect.status === 'fixed').length,
    // **DEF-038（TASK-063，用户 2026-10-13 裁定）**：旧口径把 `wontfix` 与 `closed` 一起排除
    // ⇒ **阻塞级缺陷标一个 `wontfix` 就让计数归零**，C-51（缺陷闭合）直接判绿。
    // 新口径：`wontfix` **不再自动放过** —— 只有"理由与批准人齐备"的才不算阻塞（`isBlockerWaived`）。
    // 过滤条件全部收在 `blockerBreakdown` 一处（判据与读数不再各抄一份，免得再次分叉）。
    blockersOpen: blockerBreakdown(defects).blocking.length,
    failedCaseIds: failed.map((result) => result.caseId),
    unjournaled,
    tampered,
    unadopted,
  }
}

/**
 * **一条结果是否已被独立采纳**（REQ-053 / TASK-020 的**唯一**判定入口）。
 *
 * 四条判据逐条机械核对，任何一条不过都返回 `adopted: false` **并给出理由**（降级口径：
 * 「不予计入 + 在门禁里点名未采纳的结果」，所以理由必须能被人看懂、能被人复算）：
 *
 *   ① **执行者缺登记** ⇒ 无从判断独立性（宁可不计入，也不把"没登记"读成"独立"）；
 *   ② **采纳者缺登记 / 采纳时刻缺登记** ⇒ 还没有采纳动作，不算通过；
 *   ③ **执行者与采纳者相同** ⇒ 自己给自己盖章（守卫用例钉的就是这条）；
 *   ④ **判定基准（oracle）缺或不成立** ⇒ 没有判定基准的用例只是走过场（REQ-054）。
 *
 * 「采纳是终点」的落点也在这里：本函数**只看**一条结果自身的执行者/采纳者/判定基准，
 * 不认识"谁采纳了采纳者"这种第二层 —— 采纳不产生新的待采纳物，不形成递归（C-42/C-52 那个坑）。
 */
export function isAdopted(
  store: SdoStore,
  result: Pick<TestResult, 'executedBy' | 'adoptedBy' | 'adoptedAt' | 'oracle' | 'status'>,
  testCase?: TestCase | undefined,
): { adopted: boolean; reason: string } {
  const executedBy = textOf(result.executedBy).trim()
  const adoptedBy = textOf(result.adoptedBy).trim()
  if (executedBy === '') return { adopted: false, reason: '没有登记**执行者**（无从判断独立性）' }
  if (adoptedBy === '') return { adopted: false, reason: '没有**采纳者**（尚未被独立采纳）' }
  if (textOf(result.adoptedAt).trim() === '') return { adopted: false, reason: '没有采纳时刻（采纳动作未留痕）' }
  if (executedBy === adoptedBy) {
    return { adopted: false, reason: `采纳者就是执行者（${executedBy}）—— 自己给自己盖章不算独立采纳` }
  }
  // 缺口文案带上**用例号与它覆盖的需求**：REQ-054 的降级口径要求"在门禁里点名未采纳的结果"，
  // 而点名只有在这一层拿得到 `caseId`/`requirement`（判定基准的核对实现仍在 `evidence.ts` 一处）。
  const gaps = oracleGaps(store, result.oracle ?? testCase?.oracle, {
    ...(testCase?.id === undefined ? {} : { caseId: testCase.id }),
    ...(testCase?.requirement === undefined ? {} : { requirement: testCase.requirement }),
  })
  if (gaps.length > 0) return { adopted: false, reason: `判定基准不成立：${gaps.join('；')}` }
  return { adopted: true, reason: `由 ${adoptedBy} 独立采纳（执行者 ${executedBy}）` }
}

// —————————————————————— 评审 ——————————————————————

/** 发现正文的指纹（两侧都先 trim：尾空白不该让核实失效）。 */
export function findingHashOf(text: string): string {
  return createHash('sha256').update(JSON.stringify(textOf(text).trim())).digest('hex')
}

/**
 * 评审的**判断内容指纹**：改 `verdict` / 改发现正文 / 改任务归属都会变（`at` 等元数据不算）。
 *
 * 两个用途（都在 `reviewVerification.ts` 收口）：① 记进 `review/recorded`，让"手改 verdict 再补核实"
 * 变成可判定的 `tampered`；② 核实记录绑**逐条发现**的指纹，发现被换掉 ⇒ 旧核实失效。
 *
 * **封印前缀（TASK-108 / `sdo_review action=append`）**：指纹覆盖的是 `findings[0, sealedFindings)` ——
 * 追加路径在**第一次追加时**把"记录当时有几条"钉进 `sealedFindings`，此后新增的发现项落在封印之外。
 * 为什么必须这样：指纹是**记录那一刻**的封印，而 `append` 只允许**只增不改**；若让新增的发现项也进指纹，
 * 追加后算出来的值必然 ≠ 已记录的指纹 ⇒ 同一条评审会立刻被判 `tampered`，等于用"补录"把评审作废。
 * 反过来说，**已封印前缀**（原 verdict + 原有发现正文）的任何改动仍然逐字判得出来 —— 这正是本检查要挡的东西；
 * 新增发现项的部分由**逐条核实**兜底（核实记录绑每条正文的 `findingHashOf`，被换掉即 `stale`）。
 *
 * 没有 `sealedFindings` 的旧评审**逐字节等价**于旧实现（切片长度 = 全量 ⇒ JSON 一字不差），
 * 所以既有的 `review/recorded.contentHash` 不会因为这次改动集体失效。
 */
export function reviewContentHash(review: Review): string {
  const findings = (review.findings ?? []).map((item) => textOf(item))
  const sealed = review.sealedFindings === undefined
    ? findings.length
    : Math.max(0, Math.min(Math.trunc(review.sealedFindings), findings.length))
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: textOf(review.id),
        taskId: textOf(review.taskId),
        reviewer: textOf(review.reviewer),
        verdict: textOf(review.verdict),
        findings: findings.slice(0, sealed),
        // **DEF-076**：点名的缺陷也是**主张**，必须一起进指纹；缺省（老评审）时整个键不出现
        // ⇒ JSON 逐字节与修前相同 ⇒ 既有指纹一个都不失效（历史不重写）。
        ...(review.defects === undefined ? {} : { defects: review.defects.map((item) => textOf(item)) }),
      }),
    )
    .digest('hex')
}

export interface Review {
  id: string
  taskId: string
  reviewer: string
  verdict: 'pass' | 'changes-requested' | 'reject'
  /**
   * **原卡所属角色**（2026-10-08 用户口径）：记录评审时从卡上抄下来。
   *
   * 用途：核实（`verify-review`）的首选是**该卡的认领会话**；它退役之后，**代核必须是同角色** ——
   * 而卡会被 drop/重建/改角色，所以"该由哪个角色来核"必须在**评审自己**身上留一份，
   * 不能每次现算（现算在卡已不存在时会退化成"谁都能核"，正是 R-16 说的那个滑动）。
   */
  taskRole?: string | undefined
  findings: string[]
  /**
   * **内容指纹覆盖到的前缀长度**（TASK-108 / `sdo_review action=append`）：只记"封印到第几条"，**不改正文**。
   *
   * 第一次追加时写入（值 = 当时已有的条数）；此后再追加保持不变。缺省（老评审、没追加过）= 覆盖全部发现项，
   * 于是 `reviewContentHash` 对它们逐字节等价于旧实现。语义见 `reviewContentHash` 的注释。
   */
  sealedFindings?: number | undefined
  /**
   * **这条评审点名的缺陷**（DEF-076 / 第四批 §3.3）—— 让"缺陷已被评审"有**结构化真源**。
   *
   * 病根：`sdo_review` 过去只能绑卡（`taskId`）、**没有点名缺陷的入口** ⇒ 一条 `fixed` 缺陷可以跳过评审
   * 直接拿到 `pass` 测试结论并 `closed`，而判据无从察觉（`C-65` 只看"有没有 pass 的 TR 绑定"）。
   * 用户裁决是**先评审、后测试**（`ADR-013`），本条把这句话变成机械后果：`defects.fixed-reviewed`
   * 对"有 pass TR 却无**已采纳**的评审点名它"的 `fixed` 缺陷判红并点名。
   *
   * 每个 id 必须**真实存在**（`reviewDefectIssue` 是唯一出口；未知 id ⇒ 可读拒绝、零写盘）。
   * 进**内容指纹**（`reviewContentHash`）：`defects` 缺省的老评审指纹逐字节不变（历史不重写），
   * 新评审改了这份名单就会被判 `tampered` —— 否则"事后往评审里补一个缺陷号"就是伪造评审凭证。
   */
  defects?: string[] | undefined
  /**
   * **这次补录的原文（来源评审）共几条**（DEF-072 / §3E 族 5「条号自洽」）。
   *
   * 缺陷本体：追加/补录路径**没有任何可校验的条号字段** —— `appendReviewFindings` 的 `fromIndex`
   * 是"当前已有几条"**自算**出来的，调用方"这是在补原文第几条"的**声明**根本没地方写，
   * 于是"标题写原第 4 条、正文写原第 2 条"这种矛盾在写盘时**没有任何东西能拦**（真机 REV-047 / REV-053
   * 两条逐字还在）。本字段与 `sdo_review action=append` 的 `originalIndex`/`originalTotal` 一起，
   * 让"原第 k 条 / 原共 m 条"成为**可校验的声明**：重号 / 跳号 / 超界在写入前**可读拒绝**。
   *
   * **存量不追溯**：旧评审没有这个键 ⇒ 读回来是 `undefined`，既有追加记录不受影响（历史不重写）。
   */
  originalTotal?: number | undefined
  /**
   * **当前仍然失败的复现命令**（DEF-048 / 第三批 §3.16）—— 非 `pass` 类主张**二选一**必填之一。
   *
   * 病根：`changes-requested` / `reject` 这类待修主张过去可以**不带复现命令**就落盘 ⇒ 已收敛的问题
   * 被记成未决，后人照着修一个不存在的缺口，而且门禁不会变红、读者也无从复核。
   * 写一条能跑的复现命令，等于把"现在还坏着"变成**可当场验证**的陈述。
   */
  repro?: string | undefined
  /** 另一条出路：**显式声明"无法复现"+为什么**（把不确定性写成声明，而不是省略）。与 `repro` 二选一。 */
  unreproducible?: string | undefined
  at: string
  /**
   * **记录这条评审的会话**（2026-10-08 评审核实口径）。
   *
   * 用途只有一个但很关键：核实发现的人**不能是记录评审的人**（自己核实自己 = 自证）。
   * 老评审没有这个字段 ⇒ 那条规则只在拿得到会话时才生效（与"用户原话核对"同口径）。
   */
  sessionId?: string | undefined
}

/** 非 `pass` 评审缺复现命令（或两条出路都给了）时抛的错 —— 让**最低层**写入也拦得住。 */
export class ReviewReproError extends Error {
  constructor(readonly code: 'repro-missing' | 'repro-ambiguous', readonly detail: string) {
    super(detail)
    this.name = 'ReviewReproError'
  }
}

/**
 * **待修主张必须带"当前仍失败的复现命令"**（DEF-048 / 第三批 §3.16）—— **唯一出口**。
 *
 * 病根：`changes-requested` / `reject` 这类**待修主张**过去可以**不带复现命令**就落盘
 * （真机：一条待修主张被原样接受，落盘键只有 `taskId/reviewer/verdict/findings/id/at`）⇒
 * 已收敛的问题被记成未决，后人照着去修一个不存在的缺口；而且**门禁不会变红**，读者也无从复核。
 *
 * 口径（**结构化，不解析散文**）：非 `pass` 的评审必须**二选一** ——
 *   · `repro`：一条**当前仍然失败**的复现命令（后人照着跑，能看见它现在还是坏的）；
 *   · `unreproducible`：显式声明「无法复现」+ 为什么（把不确定性写成**声明**，而不是省略）。
 * 两个都给 ⇒ 读者判不出哪个作准 ⇒ 同样可读拒绝（`repro-ambiguous`）。
 * `pass` 评审不受约束（没有"未决缺口"要复现）。
 *
 * 三处共用它：`recordReview`（最低层，违反即抛）、`office.recordReview`（工具面，可读拒绝）、
 * `appendReviewFindings`（补录面，可读拒绝）。**不许任何一处另写一套判据**。
 */
export function reviewReproIssue(input: {
  verdict: string
  repro?: string | undefined
  unreproducible?: string | undefined
}): { code: 'repro-missing' | 'repro-ambiguous'; detail: string } | undefined {
  if (input.verdict === 'pass') return undefined
  const repro = textOf(input.repro).trim()
  const unreproducible = textOf(input.unreproducible).trim()
  if (repro === '' && unreproducible === '') {
    return { code: 'repro-missing', detail: fmt('uiReview.kReproMissing', { p1: input.verdict }) }
  }
  if (repro !== '' && unreproducible !== '') {
    return { code: 'repro-ambiguous', detail: fmt('uiReview.kReproAmbiguous') }
  }
  return undefined
}

/**
 * 评审点名了**不存在**的缺陷时抛的错 —— 与 {@link ReviewReproError} 同一路数（域层抛、工具面转可读回执）。
 */
export class ReviewDefectError extends Error {
  constructor(readonly code: 'defect-unknown', readonly detail: string) {
    super(detail)
    this.name = 'ReviewDefectError'
  }
}

/**
 * **评审点名的缺陷必须真实存在**（DEF-076 / 第四批 §3.3）—— **唯一出口**。
 *
 * 为什么不只在工具面核：与 `DEF-048` 同一课 —— **最低层**（`recordReview`）也得拦，别处不许绕开。
 * 口径：`defects` 每一项都要能在 `.sdo/defects/` 里对上；空白项也算不上去（点不了名的 id 不能被容忍，
 * 否则"评审点名"这件主张就退化成了散文）。**未知就拒，不猜、不自动建缺陷**（建缺陷是 `sdo_test action=defect`
 * 的事，评审不许顺手造真源）。
 */
export function reviewDefectIssue(
  store: SdoStore,
  input: { defects?: string[] | undefined },
): { code: 'defect-unknown'; detail: string } | undefined {
  const ids = (input.defects ?? []).map((item) => textOf(item).trim())
  if (ids.length === 0) return undefined
  const known = new Set(listDefects(store).map((defect) => defect.id))
  const unknown = ids.filter((id) => id === '' || !known.has(id))
  if (unknown.length === 0) return undefined
  const named = unknown.map((id) => (id === '' ? t('uiReview.kDefectBlankId') : id)).join(t('uiCollab.kListSep'))
  return { code: 'defect-unknown', detail: fmt('uiReview.kDefectUnknown', { p1: named }) }
}

export function listReviews(store: SdoStore): Review[] {
  return store
    .listNames('reviews')
    .filter((name) => /^REV-\d+\.yml$/u.test(name))
    .map((name) => store.readYaml<{ review: Review }>('reviews', name)?.review)
    .filter((item): item is Review => item !== undefined)
}

export function recordReview(store: SdoStore, journal: Journal, input: Omit<Review, 'id' | 'at'>): Review {
  // **DEF-048**：待修主张必须带复现命令（或显式声明无法复现）—— **最低层**也拦，别处不许绕开
  const issue = reviewReproIssue({ verdict: input.verdict, repro: input.repro, unreproducible: input.unreproducible })
  if (issue !== undefined) throw new ReviewReproError(issue.code, issue.detail)
  // **DEF-076**：评审点名的缺陷必须真实存在 —— 同一份判据（`reviewDefectIssue`）在最低层也拦
  const defectIssue = reviewDefectIssue(store, { defects: input.defects })
  if (defectIssue !== undefined) throw new ReviewDefectError(defectIssue.code, defectIssue.detail)
  const review: Review = { ...input, id: idOf(store, journal, 'reviews', 'REV-'), at: new Date().toISOString() }
  store.writeYaml(['reviews', `${review.id}.yml`], { review })
  // **评审核实口径（2026-10-08）**：事件里同时记下"谁记的"与**判断内容的指纹** ——
  // ① 记的人不能自己核实自己；
  // ② 评审文件是手可编辑的，把 `changes-requested` 改成 `pass` 再补一套核实就能凭空造出通过评审；
  //    指纹让这种改动在采纳判定里直接判 `tampered`（与 D4/R1 的"文件 vs journal"同一纪律）。
  journal.append('review/recorded', {
    id: review.id,
    taskId: review.taskId,
    verdict: review.verdict,
    findings: review.findings.length,
    contentHash: reviewContentHash(review),
    // **DEF-048**：两条出路随事件一起留痕（真源里能看出"当时是怎么复现的/为什么复现不了"）
    ...(review.repro === undefined ? {} : { repro: review.repro }),
    ...(review.unreproducible === undefined ? {} : { unreproducible: review.unreproducible }),
    // **DEF-076**：点名的缺陷随事件留痕（判据读的是评审文件 + 采纳状态，事件用于对账/回溯）
    ...(review.defects === undefined ? {} : { defects: review.defects }),
    ...(review.sessionId === undefined ? {} : { sessionId: review.sessionId }),
  })
  return review
}

// —————————————————————— 交付包 ——————————————————————

export interface DeliveryArtifact {
  path: string
  kind: 'source' | 'docs' | 'config' | 'schema' | 'test'
  sha256: string
  /**
   * **这个哈希「截至何时」**（DEF-031 / 第三批 §3.12）—— 打包那一刻**现算**到的时刻（ISO 8601）。
   *
   * 为什么必须有：交付清单里只有「路径 + 哈希」，没有「截至何时」⇒ 事后发现产物与哈希不符时，
   * **分不清"签完之后漂移了"与"从来就没一致过"**（用户 2026-10-13 追认 13 条「不修历史」时，
   * 依据的正是"后续由 DEF-031 的修法承担"——本条就是兑现那句话）。
   *
   * 与 `manifest.at`（清单头的记账时刻）**不是一回事**：`at` 是"这份清单什么时候写的"，
   * `asOf` 是"每个哈希是对**哪一刻**的产物现算的"。逐条记的原因：一次打包可以包含多个产物，
   * 而"截至时刻"要能逐条核对（尤其事后补算/人工核对时）。
   *
   * 旧清单（或手写清单）里没有这个键 ⇒ 读出来是**空串**（与 `at`/`by` 同款：**不回写历史**），
   * 回执显式标「未记时刻」——不假装它有一个"大致时刻"。
   */
  asOf: string
}

/**
 * **验收结论的合法取值**（R-21，sdo-test-new 2026-10-08）：**只有这一份**。
 *
 * 病因（真机）：工具层的 `verdictOf` 自己抄了一份枚举（`pass`/`fail`/`unverified`/`blocked`/`waived`），
 * R-15 新加的 `pass-with-deviation` 没跟上 ⇒ 行**在到达 `packageDelivery` 之前**就被改写成 `unverified`
 * ⇒ 新档位端到端不可用（"如实声明偏差"反而把交付判死），而 `deviationGaps` 那条守卫**永远不可达**。
 * 与 R-20（描述 vs schema）同一类病：**两处各写一份枚举**。现在两处都从这里派生。
 */
export const ACCEPTANCE_VERDICTS = ['pass', 'pass-with-deviation', 'fail', 'unverified', 'blocked', 'waived'] as const
export type AcceptanceVerdict = (typeof ACCEPTANCE_VERDICTS)[number]

export interface AcceptanceRow {
  requirement: string
  criterion: string
  evidence: string
  /**
   * **SDO-41**：`unverified` / `blocked` 是一等公民 —— 交付门禁按「未通过」处理，不许被改写成 `pass`。
   *
   * **R-15（sdo-test-new 2026-10-08）**：新增 **`pass-with-deviation`（带已知偏差通过）** ——
   * 真机上"验收通过、但与契约/ADR 有一处已知冲突"（举例 URL 与 ADR-008 冲突）只能填 `pass`、
   * 把偏差塞进 `evidence` 文本 ⇒ 渲染出来的 `DELIVERY.md` 读起来是**无偏差通过**，偏差在交付物里消失。
   * 该档位**必须**带 `deviation`（偏差说明），否则拒收 —— 不许用一个新档位再制造一次静默。
   */
  verdict: AcceptanceVerdict
  /** `pass-with-deviation` 必填：偏差是什么、为什么接受它、谁批的 */
  deviation?: string | undefined
}

/**
 * **真机运行记录**（用户要求 2026-10-06：「要真机测试才能交付」；MC 模组 = `runServer` + `runClient`）。
 *
 * 为什么必须绑**产物哈希**：离线判据全绿而交付产物启动就崩，是「同一对象不同路径给出不同读数」的
 * 最新一例（SDO-33/49）。只记「我跑过」仍可拿旧产物/别的产物充数，所以每条运行记录在写入时
 * **绑定当时被运行的产物 sha256**；交付时只有哈希与本次交付清单里某个产物相等的通过记录才算数。
 */
export interface RunRecord {
  id: string
  /** 运行目标（自由字符串，通用系统同样适用）：`server` / `client` / `desktop` / `device`… */
  target: string
  /** 真实执行的命令（可复跑） */
  command: string
  outcome: 'pass' | 'fail'
  exitCode?: string | undefined
  /** 证据：日志路径 / 截图路径 / 人工确认说明 */
  evidence: string
  /** 被运行的产物（相对路径）与其**当时**的 sha256 —— 只有与交付清单里的哈希相等才算「跑的就是这份」 */
  artifact: string
  artifactSha256: string
  at: string
  by: string
}

export interface DeliveryManifest {
  id: string
  at: string
  by: string
  artifacts: DeliveryArtifact[]
  acceptance: AcceptanceRow[]
  /** 打包时已记录的真机运行记录（快照进清单，便于产物自证） */
  runs: RunRecord[]
  /** 本次交付**要求**覆盖的运行目标（调用方声明；空数组 = 只要求「至少一条绑定到交付产物的通过运行」） */
  runsRequired: string[]
  /** 缺哪些运行证据（非空 ⇒ 所有 `pass` 行已被降级为 `unverified`） */
  runGaps: string[]
  /** 回滚点：能退回到哪个已知状态 */
  rollbackPoint: string
  /** 显式声明原型内容已排除（Q-05 / AC-016） */
  prototypeExcluded: boolean
  notes: string
}

/**
 * 交付清单的**形状归一化**（F-21 ①）。
 *
 * `.sdo/delivery/manifest.yml` 与 `.sdo/delivery/DLV-*.yml` 都是手可编辑的真源，
 * 两个列表位置：`artifacts`（记录列表）与 `acceptance`（记录列表）。
 * 旧实现 `manifest.artifacts.filter` / `manifest.acceptance.some` 在手写成标量时抛
 * `… is not a function`。口径：
 *   · 记录列表写成标量 → **单元素列表**（标量放进最自然的字段：产物放进 `path`、
 *     验收行放进 `requirement`），保住作者意图；哈希按"算不出来"处理 → 既有判据照常判红，
 *     是可读的失败而不是崩溃；
 *   · 写成映射（少写了 `-`）→ **不猜**，按空列表 + 提示；
 *   · 数组里的非映射项 → 丢弃但报出（绝不静默）。
 */
function normalizeManifest(raw: unknown, id: string, notes: FieldShapeNote[]): DeliveryManifest | undefined {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) {
      pushShapeNote(notes, 'manifest', id, 'manifest', {
        position: 'map',
        actualType: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
        handling: 'empty',
        text: textOf(raw),
      })
    }
    return undefined
  }
  const record = raw as Record<string, unknown>
  // 提示里点名的 id 要**先**确定（正文 id 优先、文件名兜底），否则形状提示会点不到实体
  const declaredId = textOf(record.id)
  const entityId = declaredId.trim() === '' ? id : declaredId
  // 标量写成的产物行没有哈希可算：`sha256: 'missing'` 与 `hashArtifact()` 的"算不出来"同口径，
  // 于是既有的"产物缺失"判据会**可读地**判红，而不是悄悄放行一条空哈希。
  // **DEF-031**：标量形态同样没有"截至时刻" ⇒ `asOf: ''`（回执标「未记时刻」）。
  const artifacts = recordListOf<DeliveryArtifact>(record.artifacts, (text) => ({ path: text, kind: 'source', sha256: 'missing', asOf: '' }))
  pushShapeNote(notes, 'manifest', entityId, 'artifacts', artifacts.issue)
  // 标量写成的验收行放进 `requirement`：既有的"验收未通过"判据会点名它（可读失败，不是静默通过）
  const acceptance = recordListOf<AcceptanceRow>(record.acceptance, (text) => ({
    requirement: text,
    criterion: '',
    evidence: '',
    verdict: 'fail',
  }))
  pushShapeNote(notes, 'manifest', entityId, 'acceptance', acceptance.issue)
  // `prototypeExcluded` 是布尔位置：旧实现用真值判断，手写 `yes` 会被当成"已排除"（静默放行 Q-05）；
  // 现在只有 `true` 才算"已排除"，非布尔 → 按未声明处理 + 提示（门禁照旧判红，不静默放行）
  const prototypeExcluded = boolField(record.prototypeExcluded)
  pushShapeNote(notes, 'manifest', entityId, 'prototypeExcluded', prototypeExcluded.issue)
  return {
    ...(record as unknown as DeliveryManifest),
    id: entityId,
    at: textOf(record.at),
    by: textOf(record.by),
    artifacts: artifacts.value.map((artifact) => ({
      path: textOf(artifact.path),
      kind: textOf(artifact.kind) as DeliveryArtifact['kind'],
      sha256: textOf(artifact.sha256),
      // **DEF-031**：旧清单没有这个键 ⇒ 空串（宽容读、不回写历史），回执标「未记时刻」
      asOf: textOf(artifact.asOf),
    })),
    acceptance: acceptance.value.map((row) => ({
      requirement: textOf(row.requirement),
      criterion: textOf(row.criterion),
      evidence: textOf(row.evidence),
      verdict: textOf(row.verdict) as AcceptanceRow['verdict'],
      ...(textOf(row.deviation) === '' ? {} : { deviation: textOf(row.deviation) }),
    })),
    rollbackPoint: textOf(record.rollbackPoint),
    prototypeExcluded: prototypeExcluded.value === true,
    notes: textOf(record.notes),
  }
}

/** 读一个交付清单文件（`id` 只在正文缺 id 时兜底；`manifest.yml` 传空串）。 */
export function readManifestFileChecked(
  store: SdoStore,
  file: string,
  fallbackId: string,
): { manifest: DeliveryManifest | undefined; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const raw = store.readYaml<{ manifest: unknown }>('delivery', file)?.manifest
  return { manifest: normalizeManifest(raw, fallbackId, notes), notes }
}

export function readManifestChecked(
  store: SdoStore,
): { manifest: DeliveryManifest | undefined; notes: FieldShapeNote[] } {
  return readManifestFileChecked(store, 'manifest.yml', '')
}

export function readManifest(store: SdoStore): DeliveryManifest | undefined {
  return readManifestChecked(store).manifest
}

/**
 * 全部交付清单上的形状提示（回执 / 门禁详情共用）。
 *
 * **只读带版本号的文件**（`DLV-*.yml`）：`manifest.yml` 只是"最新一版"的指针，
 * 内容与对应版本文件相同 —— 两个都读会把同一条提示报两遍。
 */
export function manifestShapeNotes(store: SdoStore): FieldShapeNote[] {
  const notes: FieldShapeNote[] = []
  const names = store.listNames('delivery').filter((name) => /^DLV-\d+\.yml$/u.test(name))
  if (names.length === 0) return readManifestChecked(store).notes
  for (const name of names) {
    notes.push(...readManifestFileChecked(store, name, name.replace(/\.yml$/u, '')).notes)
  }
  return notes
}

/** 全部历史交付版本（按编号升序）：**G-06** 的证据链 —— 每一版清单都能被取回。 */
export function listManifests(store: SdoStore): DeliveryManifest[] {
  return store
    .listNames('delivery')
    .filter((name) => /^DLV-\d+\.yml$/u.test(name))
    .map((name) => readManifestFileChecked(store, name, name.replace(/\.yml$/u, '')).manifest)
    .filter((manifest): manifest is DeliveryManifest => manifest !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 读真机运行记录（`.sdo/delivery/runs.yml`，手可编辑真源）**并交回形状提示**。
 *
 * **B-1（2026-10-09 建议评估的机械普查）**：本文件里只有这一处列表读取**没有 Checked 变体** ——
 * 形状写坏（`runs:` 写成映射/标量，或列表里混进一个标量）时 `recordListOf` 会把坏元素**丢掉**，
 * 而调用方只取 `.value` ⇒ 悄无声息地"一条运行记录都没有"。更糟的是 `recordRun` 会以这份读回结果
 * 为基底**整份重写** `runs.yml` ⇒ 手写坏一行就**永久丢掉**其余历史运行记录。
 * 现在与其它实体同口径：`*Checked` 交回 notes，`listRuns` 仍只取 runs，`runsShapeNotes` 供回执/门禁，
 * 而**写入端在形状坏时拒绝覆盖**（读不出就别写，这是本项目"最好的不静默"）。
 */
export function readRunsChecked(store: SdoStore): { runs: RunRecord[]; notes: FieldShapeNote[] } {
  const notes: FieldShapeNote[] = []
  const record = store.readYaml<{ runs?: unknown }>('delivery', 'runs.yml')
  const read = recordListOf<RunRecord>(record?.runs, (text) => ({
    id: text, target: '', command: '', outcome: 'fail', evidence: '', artifact: '', artifactSha256: '', at: '', by: '',
  }))
  pushShapeNote(notes, 'runs', 'runs.yml', 'runs', read.issue)
  return {
    runs: read.value.map((run) => ({
      id: textOf(run.id),
      target: textOf(run.target),
      command: textOf(run.command),
      outcome: textOf(run.outcome) === 'pass' ? 'pass' : 'fail',
      exitCode: textOf(run.exitCode),
      evidence: textOf(run.evidence),
      artifact: textOf(run.artifact),
      artifactSha256: textOf(run.artifactSha256),
      at: textOf(run.at),
      by: textOf(run.by),
    })),
    notes,
  }
}

/** `runs.yml` 上的形状提示（回执 / 门禁共用）。 */
export function runsShapeNotes(store: SdoStore): FieldShapeNote[] {
  return readRunsChecked(store).notes
}

/** 读真机运行记录（`.sdo/delivery/runs.yml`，手可编辑真源）。 */
export function listRuns(store: SdoStore): RunRecord[] {
  return readRunsChecked(store).runs
}

export interface RunInput {
  workspace: string
  target: string
  command: string
  outcome: 'pass' | 'fail'
  evidence: string
  artifact?: string | undefined
  /**
   * **调用方手里那个哈希**（DEF-011）：给了就必须与现算值一致（不一致 ⇒ 可读拒绝并点名两值），
   * 一致 ⇒ 记它；不给 ⇒ 由 `recordRun` 现算（旧行为）。
   */
  artifactSha256?: string | undefined
  exitCode?: string | undefined
  by: string
}

/**
 * 记一条真机运行（`sdo_deliver action=run`）。
 *
 * 目标 / 命令 / 证据为空一律**拒绝**（「跑过了」必须可复跑、可核对）；给了产物就**当场绑定哈希**
 * （`artifactSha256`），交付时用它判「跑的是不是这一份」。
 */
/**
 * **调用方声明的产物哈希与现算值对账**（DEF-011 / 第三批 §3.9）—— 唯一出口。
 *
 * 病根：`record` 类入口一律在**记录时刻现算**哈希，而**入参面根本没有这个参数**
 *（`grep -c artifactSha256 src/interface/tools.ts` = 0）⇒「跑完必须逐字节恢复」的纪律在这条路上落不了地：
 * 调用方**手里**就有哈希（构建脚本刚算过），却没有任何通路把它交进来，只能靠事后重算；
 * 更糟的形态是"传了却被丢"（`RunInput.artifactSha256` 早就存在，写端直接覆盖成现算值）。
 *
 * 口径：给了就必须**可核对** ——
 *   · 一致 ⇒ 记它（与记现算值等价，但"声明被核对过"这件事本身留下了）；
 *   · 不一致 ⇒ **可读拒绝并点名两值**（绝不静默取现算值 —— 那等于把调用方的声明当没说过）；
 *   · 读不到产物 / 给了哈希却没给路径 ⇒ 同样可读拒绝（无从核对）。
 * 未声明（空）⇒ 维持旧行为（现算），零破坏。
 */
export function reconcileArtifactSha256(
  workspace: string,
  artifact: string,
  declared: string | undefined,
): { ok: true; sha256: string } | { ok: false; detail: string } {
  const path = artifact.trim()
  const claim = textOf(declared).trim()
  if (claim === '') return { ok: true, sha256: path === '' ? '' : hashArtifact(workspace, path) }
  if (path === '') {
    return { ok: false, detail: '给了 `artifactSha256` 却没给 `artifact`：没有路径就无从核对这个哈希（补上 artifact，或去掉 artifactSha256）' }
  }
  const actual = hashArtifact(workspace, path)
  if (actual === 'missing') {
    return { ok: false, detail: `读不到被检产物 ${path}（现算 = missing）⇒ 无法核对调用方声明的 artifactSha256=${claim}；本次**没有写入**` }
  }
  if (actual !== claim) {
    return {
      ok: false,
      detail: `artifactSha256 与现算值不符：声明 ${claim}，现算 ${actual}（产物 ${path}）—— 二者必须一致才落盘`
        + '（不一致说明声明的不是这一份产物；静默取现算值等于丢掉了调用方的声明）；本次**没有写入**',
    }
  }
  return { ok: true, sha256: claim }
}

export function recordRun(
  store: SdoStore,
  journal: Journal,
  input: RunInput,
): { ok: true; run: RunRecord } | { ok: false; detail: string } {
  const target = input.target.trim()
  const command = input.command.trim()
  const evidence = input.evidence.trim()
  if (target === '') return { ok: false, detail: '运行目标不能为空（例：server / client / desktop）' }
  if (command === '') return { ok: false, detail: '必须写下真实执行的命令（要可复跑）' }
  if (evidence === '') return { ok: false, detail: '必须给出运行证据（日志路径 / 截图 / 人工确认说明）' }
  const artifact = (input.artifact ?? '').trim()
  // **DEF-011**：声明的哈希必须**可核对**（一致 ⇒ 记它；不一致 / 读不到 ⇒ 可读拒绝、零写盘）
  const bound = reconcileArtifactSha256(input.workspace, artifact, input.artifactSha256)
  if (!bound.ok) return { ok: false, detail: bound.detail }
  // **B-1**：`runs.yml` 形状坏时**拒绝写入** —— 这份写入是"整份重写"，以读回结果为基底，
  // 坏形状会让它把没读出来的历史记录**永久抹掉**（本项目最忌讳的静默丢内容）。
  const checked = readRunsChecked(store)
  if (checked.notes.length > 0) {
    return {
      ok: false,
      detail: 'runs.yml 的形状读不动（见形状提示）—— 本次**没有写入**，以免整份覆盖把历史运行记录抹掉；'
        + '请先按 YAML 子集修好 `.sdo/delivery/runs.yml`（`runs:` 必须是记录列表）再重试',
    }
  }
  const existing = checked.runs
  const run: RunRecord = {
    // **D3**：`RUN-` 旧实现按 `existing.length + 1` 数条数 ⇒ 删一条就复用号；改走并集分配
    id: nextId('RUN', [...existing.map((item) => item.id), ...journalIds(journal, 'RUN')]),
    target,
    command,
    outcome: input.outcome,
    // YAML 子集不接受 `undefined`（写盘会抛）⇒ 没给退出码就**不写这个键**
    ...((input.exitCode ?? '').trim() === '' ? {} : { exitCode: (input.exitCode ?? '').trim() }),
    evidence,
    artifact,
    artifactSha256: bound.sha256,
    at: new Date().toISOString(),
    by: input.by,
  }
  store.writeYaml(['delivery', 'runs.yml'], { runs: [...existing, run] })
  journal.append('delivery/run-recorded', {
    id: run.id,
    target: run.target,
    outcome: run.outcome,
    artifact: run.artifact,
    artifactSha256: run.artifactSha256,
    evidence: run.evidence,
    by: run.by,
  })
  return { ok: true, run }
}

/** 计算文件哈希（sha256；文件不存在时返回 `missing`）。 */
export function hashArtifact(workspace: string, relative: string): string {
  const target = join(workspace, relative)
  try {
    if (statSync(target).isDirectory()) return `dir:${digestDir(target)}`
  } catch {
    return 'missing'
  }
  try {
    return createHash('sha256').update(readFileSync(target)).digest('hex')
  } catch {
    return 'missing'
  }
}

/**
 * 目录条目的递归摘要 + 文件数（**SDO-37**）。
 *
 * 真机实测：交付清单里传目录（`src/main/java/...`、`tools/checks`）时，旧实现一律给 `missing`
 * 并让回执说「这些产物在盘上找不到」—— **把「目录不参与文件哈希」误读成「产物缺失」**。
 * 交付场景「缺一个就是事故」，措辞必须区分：现在目录回 `dir:<文件数>:<递归摘要前 12 位>`。
 */
function digestDir(root: string): string {
  const entries: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const rel = prefix === '' ? name : `${prefix}/${name}`
      if (statSync(full).isDirectory()) walk(full, rel)
      else entries.push(`${rel}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
    }
  }
  walk(root, '')
  const digest = createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 12)
  return `${entries.length}:${digest}`
}

export interface PackageInput {
  workspace: string
  by: string
  artifacts: { path: string; kind: DeliveryArtifact['kind'] }[]
  acceptance: AcceptanceRow[]
  rollbackPoint: string
  prototypeDir: string
  notes?: string | undefined
  /** 本次交付要求覆盖的真机运行目标（用户要求：真机测试才能交付） */
  runsRequired?: string[] | undefined
}

/** 打交付包：清单（含 sha256）+ 验收矩阵 + 回滚点 + 原型排除声明。 */
export function packageDelivery(
  store: SdoStore,
  journal: Journal,
  input: PackageInput,
): { manifest: DeliveryManifest; missingArtifacts: string[] } {
  // **R-15**：`pass-with-deviation` 必须带 `deviation` —— 档位存在的意义就是"偏差不许消失"，
  // 允许空偏差等于给它一个更体面的 `pass`。
  const deviationGaps = input.acceptance
    .filter((row) => row.verdict === 'pass-with-deviation' && (row.deviation ?? '').trim() === '')
    .map((row) => `${row.requirement}/${row.criterion}：\`pass-with-deviation\` 必须给 \`deviation\`（偏差是什么、为何接受、谁批的）`)
  const artifacts: DeliveryArtifact[] = input.artifacts.map((artifact) => ({
    path: artifact.path,
    kind: artifact.kind,
    sha256: hashArtifact(input.workspace, artifact.path),
    // **DEF-031**：逐条记「这个哈希是**截至这一刻**现算的」——
    // 与 `hashArtifact` 调用**同一轮**取时刻（不提前、不延后），于是"时刻晚于写盘"可机械核对。
    asOf: new Date().toISOString(),
  }))
  const missing = artifacts.filter((artifact) => artifact.sha256 === 'missing').map((artifact) => artifact.path)
  // ——— **真机运行证据**（用户要求 2026-10-06：「要真机测试才能交付」，其他系统同理） ———
  // 只有「通过 + 绑定哈希与本次交付某个产物相等」的运行记录才算数：否则拿旧产物跑一遍就能把
  // 「没验证」洗成「验证过」。缺证据时**把 pass 全部降级为 unverified**（绝不默认通过，SDO-41 同款口径）。
  const allRuns = listRuns(store)
  const deliveredHashes = new Set(artifacts.map((artifact) => artifact.sha256))
  const usableRuns = allRuns.filter(
    (run) => run.outcome === 'pass' && run.artifactSha256 !== '' && deliveredHashes.has(run.artifactSha256),
  )
  const runsRequired = (input.runsRequired ?? []).map((item) => item.trim()).filter((item) => item !== '')
  const runGaps: string[] = []
  if (usableRuns.length === 0) {
    runGaps.push(
      allRuns.length === 0
        ? '没有任何真机运行记录（`sdo_deliver action=run`）—— 离线判据全绿不等于产物能跑'
        : '没有一条运行记录绑定到本次交付的产物（产物的 sha256 与运行记录不符）',
    )
  }
  for (const target of runsRequired) {
    if (!usableRuns.some((run) => run.target === target)) runGaps.push(`缺少运行目标「${target}」的通过记录`)
  }
  // ——— **SDO-40（真机）缺口一：交付包可以抢在验证之前出** ———
  // 真机上阶段仍是"开发"（G6 未过、正被缺陷挡住）就成功产出了 DLV-001，工具没提任何异议。
  // 这里按**流程真源**算：交付门禁（含 `delivery.manifest` 检查）所在阶段的前一个阶段 = 验证阶段，
  // 项目必须至少走到那一步；并且**验证门禁本身要有一次 passed/waived 的判定留痕**。
  const project = journal.loadProject().project
  const process = loadProcess(project?.process ?? 'waterfall') ?? loadProcess('waterfall')
  const currentPhase = project?.phase ?? ''
  const phaseGaps: string[] = []
  const deliveryGate = process?.gates.find((gate) => gate.criteria.some((criterion) => criterion.check === 'delivery.manifest'))?.id
  const deliveryPhase = process === undefined || deliveryGate === undefined
    ? -1
    : process.phases.findIndex((phase) => (phase.exit ?? []).includes(deliveryGate))
  const verifyPhase = process !== undefined && deliveryPhase > 0 ? process.phases[deliveryPhase - 1] : undefined
  if (process !== undefined && project !== undefined && verifyPhase !== undefined && phaseIndex(process, currentPhase) < phaseIndex(process, verifyPhase.id)) {
    phaseGaps.push(`交付应在验证之后：当前阶段「${currentPhase}」早于验证阶段「${verifyPhase.name ?? verifyPhase.id}」（先过验证门禁）`)
  }
  const verifyGate = verifyPhase === undefined ? undefined : (verifyPhase.exit ?? [])[0]
  if (verifyGate !== undefined && project !== undefined) {
    const passed = journal.read().events.some(
      (event) => event.type === 'gate/result'
        && String(event.data.gate ?? '') === verifyGate
        && (event.data.status === 'passed' || event.data.status === 'waived'),
    )
    if (!passed) phaseGaps.push(`验证门禁 ${verifyGate} 从未通过 —— 交付前必须先过一次验证门禁`)
  }
  // ——— **SDO-40 缺口三：验收矩阵不要求 `AC → 用例 → 结果` 链** ———
  // 真机上 15 行 `pass` 里多条 AC 的 Given/When/Then **从未被执行过**（"游戏内可见""能打开界面"），
  // 却因为"该需求有别的证据"被判 pass —— 机械上无从发现。这里要求：`pass` 行的需求必须有
  // **至少一条已执行并通过**的用例结果；否则该行降级为 `unverified`（没有用例覆盖就不许填 pass）。
  const cases = listTestCases(store)
  const results = listTestResults(store)
  const passingRequirements = new Set(
    results
      .filter((result) => result.status === 'pass')
      .map((result) => cases.find((item) => item.id === result.caseId)?.requirement ?? '')
      .filter((requirement) => requirement !== ''),
  )
  const caseGaps: string[] = []
  const acceptance = input.acceptance.map((row) => {
    if (row.verdict !== 'pass' && row.verdict !== 'pass-with-deviation') return row
    if (passingRequirements.has(row.requirement)) return row
    if (!caseGaps.includes(row.requirement)) {
      caseGaps.push(`${row.requirement}：没有任何已执行并通过的用例结果（\`sdo_test action=record\`）`)
    }
    return { ...row, verdict: 'unverified' as const }
  })
  const gaps = [...deviationGaps, ...runGaps, ...phaseGaps, ...caseGaps]
  // **任何一类证据缺口都要降级**（运行证据 / 阶段 / 用例链）—— 初版写成"只在相位或用例有缺口时降级"，
  // 于是"产物变了、旧运行记录不再绑定"这条路径照样放行 pass（被 M44 的用例当场咬住）。
  const finalAcceptance = gaps.length === 0
    ? acceptance
    : acceptance.map((row) =>
        row.verdict === 'pass' || row.verdict === 'pass-with-deviation' ? { ...row, verdict: 'unverified' as const } : row)
  // 目录条目不是「缺失」：单独列出来，回执与门禁都不许混为一谈（SDO-37）
  const dirs = artifacts.filter((artifact) => artifact.sha256.startsWith('dir:')).map((artifact) => artifact.path)
  const manifest: DeliveryManifest = {
    id: idOf(store, journal, 'delivery', 'DLV-'),
    at: new Date().toISOString(),
    by: input.by,
    artifacts,
    acceptance: finalAcceptance,
    runs: allRuns,
    runsRequired,
    runGaps: gaps,
    rollbackPoint: input.rollbackPoint,
    prototypeExcluded: !input.artifacts.some((artifact) => artifact.path.startsWith(`${input.prototypeDir}/`)),
    notes: input.notes ?? '',
  }
  // **G-06**：按**版本**落盘（`delivery/<DLV-xxx>.yml`），`manifest.yml` 只作为"最新一版"的指针。
  // 旧实现原地覆盖同一个文件 ⇒ 同一交付号被反复重出包、上一版清单只能去 journal 里翻，
  // "交付包"的冻结含义被无声削弱（而 C-60 仍报通过）。
  store.writeYaml(['delivery', `${manifest.id}.yml`], { manifest })
  store.writeYaml(['delivery', 'manifest.yml'], { manifest })
  journal.append('delivery/packaged', {
    id: manifest.id,
    artifacts: artifacts.length,
    acceptance: finalAcceptance.length,
    missing,
    runs: usableRuns.length,
    runsRecorded: allRuns.length,
    runsRequired,
    runGaps,
    ...(dirs.length === 0 ? {} : { directoryArtifacts: dirs }),
    // **SDO-41 ②**：旧事件只存计数（`acceptance: 15`）⇒ 验收矩阵**无法由真源重建**
    // （正文只存在于渲染产物，而渲染产物自述「派生视图、请勿手改」）。现在把行内容整体入账。
    acceptanceRows: finalAcceptance.map((row) => ({
      requirement: row.requirement,
      criterion: row.criterion,
      evidence: row.evidence,
      verdict: row.verdict,
    })),
  })
  return { manifest, missingArtifacts: missing }
}

/** 交付完整性（G7 的 `delivery.manifest` 准则）。 */
export function deliveryCompleteness(
  store: SdoStore,
  requirements: Requirement[],
  prototypeDir: string,
  /** SDO-57（C）：给了工作区与当前环境指纹就顺带算「证据时效」告警（**只告警，不判红**） */
  evidence?: { workspace?: string | undefined; currentEnv?: string | undefined } | undefined,
): { ok: boolean; problems: string[]; warnings: string[]; manifest: DeliveryManifest | undefined } {
  const manifest = readManifest(store)
  if (manifest === undefined) return { ok: false, problems: ['还没有交付清单（`sdo_deliver action=package`）'], warnings: [], manifest }
  const problems: string[] = []
  if (manifest.artifacts.length === 0) problems.push('交付清单为空')
  const missing = manifest.artifacts.filter((artifact) => artifact.sha256 === 'missing').map((artifact) => artifact.path)
  if (missing.length > 0) problems.push(`产物缺失（哈希算不出来）：${missing.join(' ')}`)
  if (textOf(manifest.rollbackPoint).trim() === '') problems.push('没有回滚点')
  // **真机运行证据**（用户要求）：没有「绑定到交付产物的通过运行」就**不许交付**。
  const deliveredHashes = new Set(manifest.artifacts.map((artifact) => artifact.sha256))
  const usable = (manifest.runs ?? []).filter(
    (run) => run.outcome === 'pass' && run.artifactSha256 !== '' && deliveredHashes.has(run.artifactSha256),
  )
  if (usable.length === 0) {
    problems.push('没有真机运行证据：交付前必须在真实环境跑过（`sdo_deliver action=run` 记一条绑定产物的通过运行）')
  }
  for (const gap of manifest.runGaps ?? []) problems.push(gap)
  if (!manifest.prototypeExcluded) problems.push(`交付清单里含 \`${prototypeDir}/\` 下的内容（Q-05）`)
  const musts = requirements.filter((requirement) => requirement.priority === 'must')
  const uncovered = musts.filter((requirement) => !manifest.acceptance.some((row) => row.requirement === requirement.id)).map((requirement) => requirement.id)
  if (uncovered.length > 0) problems.push(`must 需求没有验收行：${uncovered.join(' ')}`)
  // **SDO-41**：`fail` / `unverified` / `blocked` 都算「未通过」（只有显式 `waived` 放过）——
  // 否则「未验证」会被门禁当成通过，交付门禁这最后一道防线就失守。
  const failed = manifest.acceptance
    .filter((row) => row.verdict === 'fail' || row.verdict === 'unverified' || row.verdict === 'blocked')
    .map((row) => `${row.requirement}:${row.verdict}`)
  if (failed.length > 0) problems.push(`验收未通过或未验证：${failed.join(' ')}`)
  // **R-15**：`pass-with-deviation` 放行（它是"通过"），但**必须出声** —— 否则"带偏差通过"在交付门禁上
  // 与"干净通过"长得一模一样，偏差就只活在矩阵里（人读渲染产物时才可能发现）。
  const deviations = manifest.acceptance.filter((row) => row.verdict === 'pass-with-deviation')
  // **P-3**：验收行引用的 **AC 编号必须真实存在、且属于它声明的那条需求**。
  // 旧实现只查"每条 must 需求**有**验收行"，从不看 `row.criterion` —— 于是验收矩阵可以引用
  // 一个不存在的 `AC-999` 或指错需求，交付门禁照样绿。而 N-2/P-5 的立论正是
  // "AC 编号是交付验收矩阵的追溯键"，追溯键指空等于没追溯。
  const acceptanceIdsByRequirement = new Map(
    requirements.map((requirement) => [requirement.id, new Set(requirement.acceptance.map((ac) => ac.id))]),
  )
  const unknownCriteria = manifest.acceptance
    .filter((row) => row.criterion.trim() !== '' && !acceptanceIdsByRequirement.get(row.requirement)?.has(row.criterion))
    .map((row) => `${row.requirement}:${row.criterion}`)
  if (unknownCriteria.length > 0) {
    problems.push(`验收行引用了不存在的验收标准（或指错需求）：${unknownCriteria.join(' ')}`)
  }
  const emptyCriteria = manifest.acceptance.filter((row) => row.criterion.trim() === '').map((row) => row.requirement)
  if (emptyCriteria.length > 0) problems.push(`验收行没有写验收标准编号：${emptyCriteria.join(' ')}`)
  const warnings: string[] = []
  const freshness = evidenceFreshness(store, evidence?.workspace, evidence?.currentEnv)
  for (const item of freshness.stale) warnings.push(`证据 ${item.resultId}（用例 ${item.caseId}）已过期：${item.reason}`)
  if (freshness.unrecorded.length > 0) {
    warnings.push(`有 ${freshness.unrecorded.length} 条通过结果没有环境指纹（${freshness.unrecorded.join(' ')}）—— 无法机械核验时效（见 \`sdo_test action=env\`）`)
  }
  // **R-15**：`pass-with-deviation` 放行（它是"通过"），但**必须出声** —— 否则"带偏差通过"在交付门禁上
  // 与"干净通过"长得一模一样，偏差只活在矩阵里（人读渲染产物时才可能发现）。
  if (deviations.length > 0) {
    warnings.push(
      `带已知偏差通过 ${deviations.length} 条：${deviations.map((row) => `${row.requirement}/${row.criterion}`).join(' ')}`,
    )
  }
  return { ok: problems.length === 0, problems, warnings, manifest }
}

/** 渲染 `docs/DELIVERY.md`。 */
export function renderDelivery(manifest: DeliveryManifest, header: string): string {
  const lines = [header, '', '# 交付包与验收矩阵', '']
  lines.push(`- 交付号：${manifest.id}（${manifest.at}，by ${manifest.by}）`)
  lines.push(`- 回滚点：${manifest.rollbackPoint}`)
  lines.push(`- 原型内容已排除：${manifest.prototypeExcluded ? '是' : '否（交付门禁会拒绝）'}`)
  lines.push('')
  lines.push('## 产物（sha256）')
  lines.push('')
  for (const artifact of manifest.artifacts) {
    lines.push(`- \`${artifact.path}\`　[${artifact.kind}]　\`${artifact.sha256}\``)
  }
  lines.push('')
  lines.push('## 真机运行记录')
  lines.push('')
  if ((manifest.runs ?? []).length === 0) {
    lines.push('- ⚠️ **没有真机运行记录** —— 离线判据全绿不等于产物能跑（SDO-33：交付产物启动即崩而离线全绿）')
  } else {
    lines.push('| 序号 | 目标 | 命令 | 结论 | 产物 @ sha256 | 证据 | 时间 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const run of manifest.runs) {
      const mark = run.outcome === 'pass' ? '' : ' ⚠️'
      lines.push(`| ${run.id} | ${run.target} | ${run.command} | ${run.outcome}${mark} | ${run.artifact} @ ${run.artifactSha256.slice(0, 12)} | ${run.evidence} | ${run.at} |`)
    }
  }
  for (const gap of manifest.runGaps ?? []) lines.push(`- ⚠️ ${gap}`)
  lines.push('')
  lines.push('## 验收矩阵')
  lines.push('')
  lines.push('| 需求 | 验收标准 | 证据 | 结论 |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of manifest.acceptance) {
    // **SDO-41 ③**：非 `pass` 的结论必须**显著标注**（真机症状：13 行 `unverified` 被写成 pass，
    // 人读产物时看到"一片绿"）。标记放在结论列，读者扫一眼就能看出哪些没验证过。
    // **R-15**：`pass-with-deviation` 不是干净通过 —— 矩阵里必须同时看到档位与**偏差正文**
    const mark = row.verdict === 'pass' ? '' : row.verdict === 'pass-with-deviation' ? ' ⚠️（带已知偏差）' : ' ⚠️'
    const deviation = row.verdict === 'pass-with-deviation' && (row.deviation ?? '') !== ''
      ? `<br>偏差：${row.deviation}`
      : ''
    lines.push(`| ${row.requirement} | ${row.criterion} | ${row.evidence}${deviation} | ${row.verdict}${mark} |`)
  }
  if (manifest.notes !== '') {
    lines.push('')
    lines.push(`## 备注`)
    lines.push('')
    lines.push(manifest.notes)
  }
  return `${lines.join('\n')}\n`
}

/** 渲染 `docs/TESTPLAN.md`。 */
export function renderTestPlan(input: { cases: TestCase[]; defects: Defect[]; header: string }): string {
  const byKind: Record<string, TestCase[]> = {}
  for (const testCase of input.cases) (byKind[testCase.kind] ??= []).push(testCase)
  const lines = [input.header, '', '# 测试计划与用例', '']
  for (const kind of ['unit', 'integration', 'e2e']) {
    const cases = byKind[kind] ?? []
    lines.push(`## ${kind}（${cases.length}）`)
    lines.push('')
    for (const testCase of cases) {
      lines.push(`- ${testCase.id}　${testCase.title}${testCase.requirement === undefined ? '' : `　（覆盖 ${testCase.requirement}）`}`)
      if (testCase.steps.length > 0) lines.push(`    - 步骤：${testCase.steps.join(' → ')}`)
      lines.push(`    - 期望：${testCase.expected}`)
    }
    lines.push('')
  }
  lines.push(`## 缺陷（${input.defects.length}）`)
  lines.push('')
  if (input.defects.length === 0) lines.push('- 无')
  for (const defect of input.defects) {
    lines.push(`- ${defect.id}　[${defect.severity}/${defect.status}]　${defect.title}`)
  }
  return `${lines.join('\n')}\n`
}
