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

export interface TestCase {
  id: string
  title: string
  kind: 'unit' | 'integration' | 'e2e'
  requirement?: string | undefined
  steps: string[]
  expected: string
  at: string
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
}

export interface Defect {
  id: string
  title: string
  severity: 'blocker' | 'major' | 'minor'
  caseId?: string | undefined
  status: 'open' | 'fixed' | 'closed' | 'wontfix'
  at: string
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

export function recordTestCase(store: SdoStore, journal: Journal, input: Omit<TestCase, 'id' | 'at'>): TestCase {
  const testCase: TestCase = { ...input, id: idOf(store, journal, 'tests', 'TC-'), at: new Date().toISOString() }
  store.writeYaml(['tests', `${testCase.id}.yml`], { testCase })
  journal.append('test/recorded', { id: testCase.id, kind: testCase.kind, requirement: testCase.requirement ?? '' })
  return testCase
}

export function listTestResults(store: SdoStore): TestResult[] {
  return store
    .listNames('tests/results')
    .filter((name) => /^TR-\d+\.yml$/u.test(name))
    .map((name) => store.readYaml<{ result: TestResult }>('tests/results', name)?.result)
    .filter((item): item is TestResult => item !== undefined)
}

export function recordTestResult(store: SdoStore, journal: Journal, input: Omit<TestResult, 'id' | 'at'>): TestResult {
  const result: TestResult = { ...input, id: idOf(store, journal, 'tests/results', 'TR-'), at: new Date().toISOString() }
  store.writeYaml(['tests', 'results', `${result.id}.yml`], { result })
  journal.append('test/recorded', {
    id: result.id,
    caseId: result.caseId,
    status: result.status,
    // **SDO-57**：时点归 `at`，前置归 `env`/`artifact` —— 审计要能看到"这条结论是在什么环境下得出的"
    ...(result.env === undefined ? {} : { env: result.env, envSource: result.envSource ?? 'declared' }),
    ...(result.artifact === undefined ? {} : { artifact: result.artifact, artifactSha256: result.artifactSha256 ?? '' }),
  })
  return result
}

export function listDefects(store: SdoStore): Defect[] {
  return store
    .listNames('defects')
    .filter((name) => /^DEF-\d+\.yml$/u.test(name))
    .map((name) => store.readYaml<{ defect: Defect }>('defects', name)?.defect)
    .filter((item): item is Defect => item !== undefined)
}

export function recordDefect(store: SdoStore, journal: Journal, input: Omit<Defect, 'id' | 'at'>): Defect {
  const defect: Defect = { ...input, id: idOf(store, journal, 'defects', 'DEF-'), at: new Date().toISOString() }
  store.writeYaml(['defects', `${defect.id}.yml`], { defect })
  journal.append('defect/recorded', { id: defect.id, severity: defect.severity, status: defect.status })
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
  for (const result of listTestResults(store)) {
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

/** 验证统计（G5/G6 用）。 */
export function verificationStats(store: SdoStore, journal?: Journal | undefined): {
  cases: number
  results: number
  passed: number
  failed: number
  skipped: number
  defectsOpen: number
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
} {
  const allResults = listTestResults(store)
  // **SDO-50（真机，判据层自锁）**：旧实现把所有历史结果**平铺**统计 ⇒ 一条用例历史上出现过一次 fail
  // 就**永远**留在红名单里，而门禁给的补救话术是「修好并重跑」——重跑只能新增一条 pass，
  // 旧 fail 不会被替代 ⇒ **补救动作在机制上不可能奏效**（真机 TC-053：TR-061 fail 01:04 / TR-066 pass 08:01，
  // G6 判定 08:12 仍红）。现在按 `caseId` 分组、取 `at` **最新**的一条（latest-wins）；
  // 完整历史仍留在 `tests/results/` 与 journal 里（「失败→修复→改判」的证据链不丢）。
  const latest = new Map<string, (typeof allResults)[number]>()
  for (const result of allResults) {
    const previous = latest.get(result.caseId)
    if (previous === undefined || String(result.at) >= String(previous.at)) latest.set(result.caseId, result)
  }
  const results = [...latest.values()]
  const defects = listDefects(store)
  const failed = results.filter((result) => result.status === 'fail')
  // **D4**：逐条核对"这条结果有没有 `test/recorded` 事件佐证"
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
    passed: results.filter((result) => result.status === 'pass').length,
    failed: failed.length,
    skipped: results.filter((result) => result.status === 'skip').length,
    defectsOpen: defects.filter((defect) => defect.status === 'open' || defect.status === 'fixed').length,
    blockersOpen: defects.filter((defect) => defect.severity === 'blocker' && defect.status !== 'closed' && defect.status !== 'wontfix').length,
    failedCaseIds: failed.map((result) => result.caseId),
    unjournaled,
    tampered,
  }
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
 */
export function reviewContentHash(review: Review): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: textOf(review.id),
        taskId: textOf(review.taskId),
        reviewer: textOf(review.reviewer),
        verdict: textOf(review.verdict),
        findings: (review.findings ?? []).map((item) => textOf(item)),
      }),
    )
    .digest('hex')
}

export interface Review {
  id: string
  taskId: string
  reviewer: string
  verdict: 'pass' | 'changes-requested' | 'reject'
  findings: string[]
  at: string
  /**
   * **记录这条评审的会话**（2026-10-08 评审核实口径）。
   *
   * 用途只有一个但很关键：核实发现的人**不能是记录评审的人**（自己核实自己 = 自证）。
   * 老评审没有这个字段 ⇒ 那条规则只在拿得到会话时才生效（与"用户原话核对"同口径）。
   */
  sessionId?: string | undefined
}

export function listReviews(store: SdoStore): Review[] {
  return store
    .listNames('reviews')
    .filter((name) => /^REV-\d+\.yml$/u.test(name))
    .map((name) => store.readYaml<{ review: Review }>('reviews', name)?.review)
    .filter((item): item is Review => item !== undefined)
}

export function recordReview(store: SdoStore, journal: Journal, input: Omit<Review, 'id' | 'at'>): Review {
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
    ...(review.sessionId === undefined ? {} : { sessionId: review.sessionId }),
  })
  return review
}

// —————————————————————— 交付包 ——————————————————————

export interface DeliveryArtifact {
  path: string
  kind: 'source' | 'docs' | 'config' | 'schema' | 'test'
  sha256: string
}

export interface AcceptanceRow {
  requirement: string
  criterion: string
  evidence: string
  /** **SDO-41**：`unverified` / `blocked` 是一等公民 —— 交付门禁按「未通过」处理，不许被改写成 `pass` */
  verdict: 'pass' | 'fail' | 'unverified' | 'blocked' | 'waived'
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
  // 于是既有的"产物缺失"判据会**可读地**判红，而不是悄悄放行一条空哈希
  const artifacts = recordListOf<DeliveryArtifact>(record.artifacts, (text) => ({ path: text, kind: 'source', sha256: 'missing' }))
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
    })),
    acceptance: acceptance.value.map((row) => ({
      requirement: textOf(row.requirement),
      criterion: textOf(row.criterion),
      evidence: textOf(row.evidence),
      verdict: textOf(row.verdict) as AcceptanceRow['verdict'],
    })),
    rollbackPoint: textOf(record.rollbackPoint),
    prototypeExcluded: prototypeExcluded.value === true,
    notes: textOf(record.notes),
  }
}

/** 读一个交付清单文件（`id` 只在正文缺 id 时兜底；`manifest.yml` 传空串）。 */
function readManifestFileChecked(
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

/** 读真机运行记录（`.sdo/delivery/runs.yml`，手可编辑真源）。 */
export function listRuns(store: SdoStore): RunRecord[] {
  const record = store.readYaml<{ runs?: unknown }>('delivery', 'runs.yml')
  return recordListOf<RunRecord>(record?.runs, (text) => ({
    id: text, target: '', command: '', outcome: 'fail', evidence: '', artifact: '', artifactSha256: '', at: '', by: '',
  })).value.map((run) => ({
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
  }))
}

export interface RunInput {
  workspace: string
  target: string
  command: string
  outcome: 'pass' | 'fail'
  evidence: string
  artifact?: string | undefined
  exitCode?: string | undefined
  by: string
}

/**
 * 记一条真机运行（`sdo_deliver action=run`）。
 *
 * 目标 / 命令 / 证据为空一律**拒绝**（「跑过了」必须可复跑、可核对）；给了产物就**当场绑定哈希**
 * （`artifactSha256`），交付时用它判「跑的是不是这一份」。
 */
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
  const existing = listRuns(store)
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
    artifactSha256: artifact === '' ? '' : hashArtifact(input.workspace, artifact),
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
  const artifacts: DeliveryArtifact[] = input.artifacts.map((artifact) => ({
    path: artifact.path,
    kind: artifact.kind,
    sha256: hashArtifact(input.workspace, artifact.path),
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
    if (row.verdict !== 'pass') return row
    if (passingRequirements.has(row.requirement)) return row
    if (!caseGaps.includes(row.requirement)) {
      caseGaps.push(`${row.requirement}：没有任何已执行并通过的用例结果（\`sdo_test action=record\`）`)
    }
    return { ...row, verdict: 'unverified' as const }
  })
  const gaps = [...runGaps, ...phaseGaps, ...caseGaps]
  // **任何一类证据缺口都要降级**（运行证据 / 阶段 / 用例链）—— 初版写成"只在相位或用例有缺口时降级"，
  // 于是"产物变了、旧运行记录不再绑定"这条路径照样放行 pass（被 M44 的用例当场咬住）。
  const finalAcceptance = gaps.length === 0
    ? acceptance
    : acceptance.map((row) => (row.verdict === 'pass' ? { ...row, verdict: 'unverified' as const } : row))
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
    const mark = row.verdict === 'pass' ? '' : ' ⚠️'
    lines.push(`| ${row.requirement} | ${row.criterion} | ${row.evidence} | ${row.verdict}${mark} |`)
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
