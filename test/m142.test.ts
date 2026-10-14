/**
 * **增量 142：TDD 红绿必须**绑在同一个被检产物上**（DEF-024，§3E 族 1「对账判据」）**。
 *
 * 缺陷原文（B 组 re-verify）：真卡 `TASK-020`（`status=done`）的两条判据都报 `[]`，而它的
 * `TR-080/081/082` 三份结果**连 `artifact`/`artifactSha256` 键都没有** ⇒ 判据只核"有没有红→绿"，
 * 不核"红绿绑没绑在同一个产物上"；「两侧都空」正好落在既有条件之外。
 *
 * **先钉红**（修复前，读真卡）：
 *   ```
 *   真卡 TASK-020: status = done | reqs = ["REQ-053","REQ-054"]
 *   真卡 redGreenGaps: []
 *   真卡 doneGaps   : []
 *   ```
 * 修复后同一条探针 ⇒ `["tdd-artifact-unbound","tdd-artifact-unbound"]`（两个需求各一对）。
 *
 * **口径边界**（防"凭空判红"）：只有**能证成同一次实验**（env 或 harness 指纹**可比且相等**）
 * 且**未两侧都绑**时才判 —— 老台账没有这些字段 ⇒ 不判；跨实验 ⇒ 由 `tdd-env-changed` /
 * `tdd-harness-changed` 负责，不在这里重复报。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { doneGaps, redGreenGaps } from '../src/domain/construction.js'
import { recordTestCase, recordTestResult } from '../src/domain/records.js'
import type { TestResult } from '../src/domain/records.js'
import type { TaskCard } from '../src/types.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m142/', import.meta.url))
let store: SdoStore
let journal: Journal
let caseId: string

const card = (): TaskCard => ({
  id: 'TASK-900', title: '夹具卡', status: 'in-progress', role: 'developer', size: 'small',
  requirements: ['REQ-001'], writeScopes: ['src/x.ts'], dod: ['夹具'], blockedBy: [], revision: 1,
} as unknown as TaskCard)

const record = (input: Partial<TestResult> & { status: 'fail' | 'pass' }): void => {
  const outcome = recordTestResult(store, journal, {
    caseId: input.caseId ?? caseId, evidence: input.evidence ?? 'x', ...input,
  } as never)
  assert.equal(outcome.ok, true, `夹具前提：用例必须存在（${outcome.ok ? '' : outcome.detail}）`)
}

const checks = (): string[] => redGreenGaps(store, journal, card()).map((gap) => gap.check)

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
  const created = recordTestCase(store, journal, {
    kind: 'unit', title: '夹具用例', requirement: 'REQ-001', steps: ['跑'], expected: '通过',
  } as never)
  caseId = created.id
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M142-01 同一次实验、两侧都没绑产物 ⇒ 判红并点名"两侧"（红侧：旧判据返回 []）', () => {
  const env = 'node=26; suite=m142'
  record({ status: 'fail', env })
  record({ status: 'pass', env })
  const gaps = redGreenGaps(store, journal, card())
  const unbound = gaps.filter((gap) => gap.check === 'tdd-artifact-unbound')
  assert.equal(unbound.length, 1, `必须恰好报一条未绑产物：${JSON.stringify(gaps.map((g) => g.check))}`)
  assert.equal(gaps.some((gap) => gap.check === 'tdd-artifact-unchanged'), false, '没绑产物时"产物没变"这条无从谈起，不该混报')
  assert.match(unbound[0]?.detail ?? '', /两侧/u, '要点名是**两侧**都没绑')
  assert.match(unbound[0]?.detail ?? '', new RegExp(caseId, 'u'), '要点名是哪条用例')
})

test('M142-02 只缺一侧 ⇒ 点名缺的是哪一侧（红侧/绿侧分开说）', () => {
  const env = 'node=26; suite=m142'
  // 只绑红灯侧 ⇒ 缺绿灯侧
  record({ status: 'fail', env, artifact: 'lib/x.js', artifactSha256: 'h1' })
  record({ status: 'pass', env })
  const redBound = redGreenGaps(store, journal, card()).find((gap) => gap.check === 'tdd-artifact-unbound')
  assert.match(redBound?.detail ?? '', /绿灯侧/u, `要指名绿灯侧缺绑定：${redBound?.detail ?? '(无)'}`)

  // 换成只绑绿灯侧 ⇒ 缺红灯侧
  rmSync(join(BASE, '.sdo', 'tests', 'results'), { recursive: true, force: true })
  journal = new Journal(new SdoStore(join(BASE, '.sdo')))
  record({ status: 'fail', env })
  record({ status: 'pass', env, artifact: 'lib/x.js', artifactSha256: 'h2' })
  const greenBound = redGreenGaps(store, journal, card()).find((gap) => gap.check === 'tdd-artifact-unbound')
  assert.match(greenBound?.detail ?? '', /红灯侧/u, `要指名红灯侧缺绑定：${greenBound?.detail ?? '(无)'}`)
})

test('M142-03 反例：两侧都绑且哈希不同 ⇒ 不报未绑（不许修成"全判红"）', () => {
  const env = 'node=26; suite=m142'
  record({ status: 'fail', env, artifact: 'lib/x.js', artifactSha256: 'hRed' })
  record({ status: 'pass', env, artifact: 'lib/x.js', artifactSha256: 'hGreen' })
  assert.deepEqual(checks(), [], '绑好产物的同实验红绿必须转绿')
})

test('M142-04 口径边界：老台账（红绿都没指纹）不判 —— 不许对历史结果凭空判红', () => {
  record({ status: 'fail' })
  record({ status: 'pass' })
  assert.deepEqual(checks(), [], '没有可比指纹时不得判"未绑产物"（否则全库历史结果一起红）')
})

test('M142-05 done 面同源 + 逐条可豁免（逃生口与既有纪律一致）', () => {
  const env = 'node=26; suite=m142'
  record({ status: 'fail', env })
  record({ status: 'pass', env })
  // profile 必须"覆盖该卡"（`scopeCovers`）且选中 tdd 包，done 面才会跑这条判据
  const profile = {
    scope: 'all', packages: ['tdd', 'contract-first'], scale: 'critical', exempt: [], decidedAt: '', by: '',
  } as never
  const done = doneGaps(store, journal, card(), profile, { scale: 'critical' }).map((gap) => gap.check)
  assert.equal(done.includes('tdd-artifact-unbound'), true, `done 面必须并入同一条缺口：${JSON.stringify(done)}`)
  const skipped = redGreenGaps(store, journal, card(), { exempt: (check) => check === 'tdd-artifact-unbound' })
  assert.equal(skipped.some((gap) => gap.check === 'tdd-artifact-unbound'), false, '逐条豁免必须仍然有效')
})
