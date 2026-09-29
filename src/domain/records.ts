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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { nextId } from '../infra/ids.js'
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
}

export interface Defect {
  id: string
  title: string
  severity: 'blocker' | 'major' | 'minor'
  caseId?: string | undefined
  status: 'open' | 'fixed' | 'closed' | 'wontfix'
  at: string
}

function idOf(store: SdoStore, dir: string, prefix: string): string {
  const names = store.listNames(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.yml'))
  return nextId(prefix.replace(/-$/u, ''), names.map((name) => name.replace(/\.yml$/u, '')))
}

export function listTestCases(store: SdoStore): TestCase[] {
  return store
    .listNames('tests')
    .filter((name) => /^TC-\d+\.yml$/u.test(name))
    .map((name) => store.readYaml<{ testCase: TestCase }>('tests', name)?.testCase)
    .filter((item): item is TestCase => item !== undefined)
}

export function recordTestCase(store: SdoStore, journal: Journal, input: Omit<TestCase, 'id' | 'at'>): TestCase {
  const testCase: TestCase = { ...input, id: idOf(store, 'tests', 'TC-'), at: new Date().toISOString() }
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
  const result: TestResult = { ...input, id: idOf(store, 'tests/results', 'TR-'), at: new Date().toISOString() }
  store.writeYaml(['tests', 'results', `${result.id}.yml`], { result })
  journal.append('test/recorded', { id: result.id, caseId: result.caseId, status: result.status })
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
  const defect: Defect = { ...input, id: idOf(store, 'defects', 'DEF-'), at: new Date().toISOString() }
  store.writeYaml(['defects', `${defect.id}.yml`], { defect })
  journal.append('defect/recorded', { id: defect.id, severity: defect.severity, status: defect.status })
  return defect
}

export function updateDefect(store: SdoStore, journal: Journal, id: string, status: Defect['status']): Defect | undefined {
  const defect = listDefects(store).find((item) => item.id === id)
  if (defect === undefined) return undefined
  const next: Defect = { ...defect, status }
  store.writeYaml(['defects', `${id}.yml`], { defect: next })
  journal.append('defect/recorded', { id, status })
  return next
}

/** 验证统计（G5/G6 用）。 */
export function verificationStats(store: SdoStore): {
  cases: number
  results: number
  passed: number
  failed: number
  skipped: number
  defectsOpen: number
  blockersOpen: number
  failedCaseIds: string[]
} {
  const results = listTestResults(store)
  const defects = listDefects(store)
  const failed = results.filter((result) => result.status === 'fail')
  return {
    cases: listTestCases(store).length,
    results: results.length,
    passed: results.filter((result) => result.status === 'pass').length,
    failed: failed.length,
    skipped: results.filter((result) => result.status === 'skip').length,
    defectsOpen: defects.filter((defect) => defect.status === 'open' || defect.status === 'fixed').length,
    blockersOpen: defects.filter((defect) => defect.severity === 'blocker' && defect.status !== 'closed' && defect.status !== 'wontfix').length,
    failedCaseIds: failed.map((result) => result.caseId),
  }
}

// —————————————————————— 评审 ——————————————————————

export interface Review {
  id: string
  taskId: string
  reviewer: string
  verdict: 'pass' | 'changes-requested' | 'reject'
  findings: string[]
  at: string
}

export function listReviews(store: SdoStore): Review[] {
  return store
    .listNames('reviews')
    .filter((name) => /^REV-\d+\.yml$/u.test(name))
    .map((name) => store.readYaml<{ review: Review }>('reviews', name)?.review)
    .filter((item): item is Review => item !== undefined)
}

export function recordReview(store: SdoStore, journal: Journal, input: Omit<Review, 'id' | 'at'>): Review {
  const review: Review = { ...input, id: idOf(store, 'reviews', 'REV-'), at: new Date().toISOString() }
  store.writeYaml(['reviews', `${review.id}.yml`], { review })
  journal.append('review/recorded', { id: review.id, taskId: review.taskId, verdict: review.verdict, findings: review.findings.length })
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
  verdict: 'pass' | 'fail' | 'waived'
}

export interface DeliveryManifest {
  id: string
  at: string
  by: string
  artifacts: DeliveryArtifact[]
  acceptance: AcceptanceRow[]
  /** 回滚点：能退回到哪个已知状态 */
  rollbackPoint: string
  /** 显式声明原型内容已排除（Q-05 / AC-016） */
  prototypeExcluded: boolean
  notes: string
}

export function readManifest(store: SdoStore): DeliveryManifest | undefined {
  return store.readYaml<{ manifest: DeliveryManifest }>('delivery', 'manifest.yml')?.manifest
}

/** 计算文件哈希（sha256；文件不存在时返回 `missing`）。 */
export function hashArtifact(workspace: string, relative: string): string {
  try {
    return createHash('sha256').update(readFileSync(join(workspace, relative))).digest('hex')
  } catch {
    return 'missing'
  }
}

export interface PackageInput {
  workspace: string
  by: string
  artifacts: { path: string; kind: DeliveryArtifact['kind'] }[]
  acceptance: AcceptanceRow[]
  rollbackPoint: string
  prototypeDir: string
  notes?: string | undefined
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
  const manifest: DeliveryManifest = {
    id: idOf(store, 'delivery', 'DLV-'),
    at: new Date().toISOString(),
    by: input.by,
    artifacts,
    acceptance: input.acceptance,
    rollbackPoint: input.rollbackPoint,
    prototypeExcluded: !input.artifacts.some((artifact) => artifact.path.startsWith(`${input.prototypeDir}/`)),
    notes: input.notes ?? '',
  }
  store.writeYaml(['delivery', 'manifest.yml'], { manifest })
  journal.append('delivery/packaged', {
    id: manifest.id,
    artifacts: artifacts.length,
    acceptance: input.acceptance.length,
    missing,
  })
  return { manifest, missingArtifacts: missing }
}

/** 交付完整性（G7 的 `delivery.manifest` 准则）。 */
export function deliveryCompleteness(
  store: SdoStore,
  requirements: Requirement[],
  prototypeDir: string,
): { ok: boolean; problems: string[]; manifest: DeliveryManifest | undefined } {
  const manifest = readManifest(store)
  if (manifest === undefined) return { ok: false, problems: ['还没有交付清单（`sdo_deliver action=package`）'], manifest }
  const problems: string[] = []
  if (manifest.artifacts.length === 0) problems.push('交付清单为空')
  const missing = manifest.artifacts.filter((artifact) => artifact.sha256 === 'missing').map((artifact) => artifact.path)
  if (missing.length > 0) problems.push(`产物缺失（哈希算不出来）：${missing.join(' ')}`)
  if (manifest.rollbackPoint.trim() === '') problems.push('没有回滚点')
  if (!manifest.prototypeExcluded) problems.push(`交付清单里含 \`${prototypeDir}/\` 下的内容（Q-05）`)
  const musts = requirements.filter((requirement) => requirement.priority === 'must')
  const uncovered = musts.filter((requirement) => !manifest.acceptance.some((row) => row.requirement === requirement.id)).map((requirement) => requirement.id)
  if (uncovered.length > 0) problems.push(`must 需求没有验收行：${uncovered.join(' ')}`)
  const failed = manifest.acceptance.filter((row) => row.verdict === 'fail').map((row) => row.requirement)
  if (failed.length > 0) problems.push(`验收未通过：${failed.join(' ')}`)
  return { ok: problems.length === 0, problems, manifest }
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
  lines.push('## 验收矩阵')
  lines.push('')
  lines.push('| 需求 | 验收标准 | 证据 | 结论 |')
  lines.push('| --- | --- | --- | --- |')
  for (const row of manifest.acceptance) {
    lines.push(`| ${row.requirement} | ${row.criterion} | ${row.evidence} | ${row.verdict} |`)
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
