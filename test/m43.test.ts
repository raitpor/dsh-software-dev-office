/**
 * 真机报告 2026-10-06 追加的**插件侧**三条（SDO-41 / SDO-50 / SDO-37）。
 *
 *   · **SDO-41（报告评为「最严重」）**：`sdo_deliver action=package` 把**非法/缺失**的 `verdict`
 *     一律落成 `pass` —— 流程官提交 13 行 `unverified`，得到 15/15 全 pass 且零提示
 *     （「框架主动生产假绿记录」）；且验收矩阵的行内容**不进真源**（journal 只存 `acceptance: 15` 计数），
 *     正文只存在于自述"派生视图、请勿手改"的渲染产物里。
 *   · **SDO-50（判据层自锁）**：`verificationStats` 把**所有历史结果平铺**统计 ⇒ 一条用例出现过一次 fail
 *     就永远红，而门禁给的补救是「修好并重跑」——机制上不可能奏效。
 *   · **SDO-37**：`hashArtifact` 对**目录**返回 `missing`，回执于是说「这些产物在盘上找不到」——
 *     把"目录不参与文件哈希"误读成"产物缺失"。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import {
  deliveryCompleteness,
  recordRun,
  hashArtifact,
  packageDelivery,
  renderDelivery,
  verificationStats,
} from '../src/domain/records.js'
import type { AcceptanceRow } from '../src/domain/records.js'
import type { Requirement } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm43')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function acceptance(verdict: AcceptanceRow['verdict'], requirement = 'REQ-001'): AcceptanceRow {
  return { requirement, criterion: 'AC-001', evidence: 'e', verdict }
}

function requirement(): Requirement {
  return {
    id: 'REQ-001', title: 'R', kind: 'functional', statement: 's', rationale: 'r', status: 'approved',
    priority: 'must', source: 'user', acceptance: [{ id: 'AC-001', given: 'g', when: 'w', then: 't' }],
    revision: 1, createdAt: '', updatedAt: '',
  } as unknown as Requirement
}

test('SDO-41：`unverified` 是一等公民 —— 落账原样、门禁拦下、事件带行内容、渲染打 ⚠️', () => {
  // 交付现在**还要求真机运行证据**（用户要求 2026-10-06）：先记一条绑定产物的通过运行，
  // 好让"pass 行不被降级、也不打 ⚠️"这件事能被单独观察到。
  writeFileSync(join(BASE, 'art.txt'), 'bytes', 'utf8')
  const ran = recordRun(store, journal, {
    workspace: BASE, target: 'desktop', command: './run', outcome: 'pass', evidence: 'log', artifact: 'art.txt', by: 'h',
  })
  assert.equal(ran.ok, true)
  // **SDO-40 缺口三**：`pass` 行必须能追到「用例 → 通过结果」，否则降级为 unverified
  store.writeYaml(['tests', 'TC-002.yml'], { testCase: { id: 'TC-002', title: 't', kind: 'unit', requirement: 'REQ-002', steps: [], expected: 'e', at: '' } })
  store.writeYaml(['tests', 'results', 'TR-002.yml'], { result: { id: 'TR-002', caseId: 'TC-002', status: 'pass', evidence: 'e', at: '2026-10-06T00:00:00Z' } })
  const { manifest } = packageDelivery(store, journal, {
    workspace: BASE,
    by: 'cockpit',
    artifacts: [{ path: 'art.txt', kind: 'source' }],
    acceptance: [acceptance('unverified'), acceptance('pass', 'REQ-002')],
    rollbackPoint: 'git:abc',
    prototypeDir: 'prototype',
  })
  assert.equal(manifest.acceptance[0]?.verdict, 'unverified', '未验证不许被改写成 pass')

  // ① 交付门禁把「未通过或未验证」当成问题（不能让"未验证"混过去）
  const completeness = deliveryCompleteness(store, [requirement()], 'prototype')
  assert.equal(completeness.ok, false)
  assert.match(completeness.problems.join(' '), /未通过或未验证：REQ-001:unverified/u)

  // ② 行内容进真源（可从 journal 重建矩阵，而不是只存在于渲染产物里）
  const event = journal.read().events.filter((item) => item.type === 'delivery/packaged').pop()
  const rows = event?.data.acceptanceRows
  assert.ok(Array.isArray(rows) && rows.length === 2, `验收行要整体入账：${JSON.stringify(event?.data)}`)
  assert.equal((rows as { verdict: string }[])[0]?.verdict, 'unverified')
  assert.equal((rows as { criterion: string }[])[0]?.criterion, 'AC-001', 'criterion 也要入账（追溯键）')

  // ③ 渲染时非 pass 行显著标注
  const doc = renderDelivery(manifest, '# h')
  assert.match(doc, /\| REQ-001 \| AC-001 \| e \| unverified ⚠️ \|/u)
  assert.match(doc, /\| REQ-002 \| AC-001 \| e \| pass \|/u, 'pass 行不加标记')

  // ④ 工具层：非法取值**绝不默认 pass**（源码级守卫 + 回执点名字段）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /verdict: verdictOf\(row\.verdict\)/u, '入参必须过 verdictOf')
  assert.doesNotMatch(index, /row\.verdict === 'fail' \|\| row\.verdict === 'waived' \? row\.verdict : 'pass'/u, '旧的"非法即 pass"必须消失')
  assert.match(index, /kAcceptanceVerdictRewritten/u, '被改写的行要逐行点名')
})

test('SDO-50：C-50 按用例取**最新一条**结果（latest-wins）—— 「修好并重跑」必须能变绿', () => {
  const write = (id: string, caseId: string, status: 'pass' | 'fail', at: string): void => {
    store.writeYaml(['tests', 'results', `${id}.yml`], { result: { id, caseId, status, evidence: 'e', at } })
  }
  // 真机形状：TC-053 先 fail（01:04）后 pass（08:01）⇒ 门禁判定在 08:12，不该再红
  write('TR-061', 'TC-053', 'fail', '2026-10-06T01:04:41Z')
  write('TR-066', 'TC-053', 'pass', '2026-10-06T08:01:31Z')
  const fixed = verificationStats(store)
  assert.equal(fixed.failed, 0, '最新一条是 pass ⇒ 不再算失败')
  assert.deepEqual(fixed.failedCaseIds, [])
  assert.equal(fixed.failed, 0)
  assert.equal(fixed.results, 1, '按用例去重后只算最新那一条')

  // 反向：最新一条是 fail ⇒ 仍要红（不许放宽成"有任一 pass 即通过"）
  write('TR-067', 'TC-053', 'fail', '2026-10-06T09:00:00Z')
  const regressed = verificationStats(store)
  assert.equal(regressed.failed, 1)
  assert.deepEqual(regressed.failedCaseIds, ['TC-053'])

  // 两个用例各取自己最新的一条（互不干扰）
  write('TR-070', 'TC-025', 'pass', '2026-10-06T02:00:00Z')
  write('TR-071', 'TC-025', 'fail', '2026-10-06T03:00:00Z')
  const two = verificationStats(store)
  assert.deepEqual(two.failedCaseIds.sort(), ['TC-025', 'TC-053'], '每个用例各取最新一条')
  assert.equal(two.results, 2)
})

test('SDO-37：目录型产物不再被说成「盘上找不到」—— 递归摘要 + 条目数，且不算缺失', () => {
  mkdirSync(join(BASE, 'src', 'deep'), { recursive: true })
  writeFileSync(join(BASE, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')
  writeFileSync(join(BASE, 'src', 'deep', 'b.ts'), 'export const b = 2\n', 'utf8')

  const dirHash = hashArtifact(BASE, 'src')
  assert.match(dirHash, /^dir:2:[0-9a-f]{12}$/u, `目录要给「条目数:摘要」而不是 missing：${dirHash}`)
  assert.equal(hashArtifact(BASE, 'src/a.ts').length, 64, '文件照旧给 sha256')
  assert.equal(hashArtifact(BASE, 'nope'), 'missing', '真不存在才是 missing')

  // 门禁与事件：目录条目不算「缺失」，并在事件里单独列出来
  const { missingArtifacts } = packageDelivery(store, journal, {
    workspace: BASE, by: 'cockpit', artifacts: [{ path: 'src', kind: 'source' }],
    acceptance: [], rollbackPoint: 'git:abc', prototypeDir: 'prototype',
  })
  assert.deepEqual(missingArtifacts, [], '目录不是缺失')
  const event = journal.read().events.filter((item) => item.type === 'delivery/packaged').pop()
  assert.deepEqual(event?.data.directoryArtifacts, ['src'], '目录条目要在事件里单独说明')
  const completeness = deliveryCompleteness(store, [], 'prototype')
  assert.doesNotMatch(completeness.problems.join(' '), /src/u, '不许把目录说成产物缺失')
})
