/**
 * **增量 143：变异自证条数必须与卡上的**声明**逐条对账（DEF-027，§3E 族 1「对账判据」）**。
 *
 * 缺陷原文（B 组 re-verify，真卡 `TASK-034`）：台账 3 条、killed 合计 3，而把声明从 0 条改成 5 条，
 * `doneGaps` **两次输出完全相同**（都是 `[]`）—— 判据逐字只有 `if (killed === 0)`，DoD 一个字都没读
 * ⇒「报告说 3 条、台账只有 2 条」这类差额任何门禁都看不见（**自述大于台账**）。
 *
 * **先钉红**（修复前，读真卡）：
 *   ```
 *   TASK-034: status= done | 台账记录条数: 3 | killed 合计: 3
 *   DoD 原样     ⇒ []
 *   DoD=0 条声明 ⇒ []
 *   DoD=5 条声明 ⇒ []
 *   ```
 *
 * **修法（含一条设计裁决，写清理由）**：判据要语言无关、格式无关（长期约束）⇒ **不**去解析 DoD 散文里
 * 的「做 N 条」，而是给卡一个**结构化声明** `mutationExpected: N`：
 * 缺省 = 不声明（维持旧口径，只要求 `killed ≥ 1`，历史卡不受影响）；声明 N ⇒ 与台账实到**条数逐条对账**
 * （多了少了都判红、点名差额与记录清单，含「声明 0 条却有记录」）。
 *
 * 修复后同一条探针 ⇒ 声明 5 与声明 0 均判红 `tdd-mutation-count-mismatch`，声明 3（=实到）保持 `[]`。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { doneGaps, readMutations, recordMutation } from '../src/domain/construction.js'
import { createTask, readTask } from '../src/domain/plan.js'
import { createOfficeTools } from '../src/interface/tools.js'
import type { ConstructionProfile } from '../src/domain/construction.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m143/', import.meta.url))
let store: SdoStore
let journal: Journal

const profile: ConstructionProfile = {
  version: 1, decidedAt: '2026-10-14T00:00:00.000Z', decidedBy: 'office', packages: ['tdd'],
  scope: 'all', derivedFrom: ['scale=critical'], reason: 'm143', exempt: [], history: [],
} as unknown as ConstructionProfile

const makeCard = (mutationExpected?: number): string => {
  const card = createTask(store, journal, {
    title: '夹具卡', goal: '夹具', inputs: [], outputs: [], dod: ['夹具'], role: 'developer', size: 'small',
    // 必须是**触及产品代码**的卡，否则走 TASK-056 的 N/A 分支（那分支不判变异条数）
    writeScopes: ['src/x.ts'],
    ...(mutationExpected === undefined ? {} : { mutationExpected }),
  } as never)
  return card.id
}

const addMutation = (task: string, target: string, killed: number, tool = 'node scripts/mutate.mjs'): void => {
  recordMutation(store, { task, tool, target, killed, survived: 0, at: new Date().toISOString() })
}

const checks = (id: string): string[] => doneGaps(store, journal, readTask(store, id) as never, profile, { scale: 'critical' }).map((gap) => gap.check)

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M143-01 反例：声明 3 条、台账实到 3 条（killed 均 ≥1） ⇒ 判据转绿', () => {
  const id = makeCard(3)
  addMutation(id, 'src/a.ts:1', 1)
  addMutation(id, 'src/a.ts:2', 2)
  addMutation(id, 'src/b.ts:1', 1)
  assert.equal(readMutations(store).filter((item) => item.task === id).length, 3, '夹具前提：实到 3 条')
  assert.deepEqual(checks(id), [], '声明与实到一致时必须绿（不许修成"全判红"）')
})

test('M143-02 声明 5、实到 3 ⇒ 判红并点名差额与记录清单（红侧：旧判据返回 []）', () => {
  const id = makeCard(5)
  addMutation(id, 'src/a.ts:1', 1)
  addMutation(id, 'src/a.ts:2', 1)
  addMutation(id, 'src/b.ts:1', 1)
  const gap = doneGaps(store, journal, readTask(store, id) as never, profile, { scale: 'critical' })
    .find((item) => item.check === 'tdd-mutation-count-mismatch')
  assert.ok(gap !== undefined, `声明与实到不符必须判红：${JSON.stringify(checks(id))}`)
  assert.match(gap.detail, /5/u, '要点名声明条数')
  assert.match(gap.detail, /3/u, '要点名实到条数')
  assert.match(gap.detail, /src\/a\.ts:1/u, '要点名台账里的记录（可核对）')
})

test('M143-03 声明 0 条而台账有记录 ⇒ 判红（"自述小于台账"同样要看得见）', () => {
  const id = makeCard(0)
  addMutation(id, 'src/a.ts:1', 1)
  assert.equal(checks(id).includes('tdd-mutation-count-mismatch'), true, `声明 0 却有记录必须判红：${JSON.stringify(checks(id))}`)
})

test('M143-04 缺省不声明 ⇒ 维持旧口径（历史卡不受影响）；两条判据互不替代', () => {
  const id = makeCard()
  addMutation(id, 'src/a.ts:1', 1)
  assert.equal(checks(id).includes('tdd-mutation-count-mismatch'), false, '没声明就不得凭空要求一个数字')
  // 声明与实到一致但 killed=0 ⇒ 仍由旧判据兜住
  const id2 = makeCard(1)
  addMutation(id2, 'src/c.ts:1', 0)
  assert.equal(checks(id2).includes('tdd-mutation-missing'), true, 'killed=0 仍必须报"没做变异自证"')
})

test('M143-05 写侧通路：声明能落盘并读回（防"白名单静默丢弃"）；schema 声明为 number', () => {
  const id = makeCard(4)
  // 读端白名单是这份缺陷的同族风险点：写下去、读不回来 = 判据永远看不见
  assert.equal(readTask(store, id)?.mutationExpected, 4, 'YAML 写入后必须能读回（读端白名单）')
  const tool = createOfficeTools({} as never).find((item) => item.name === 'sdo_task')
  const prop = (tool?.parameters as { properties?: Record<string, { type?: string }> } | undefined)?.properties?.mutationExpected
  assert.equal(prop?.type, 'number', '工具 schema 必须以数字形态收这个声明（否则 DSH 侧形状校验先拒）')
})
