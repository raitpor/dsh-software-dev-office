/**
 * **增量 144：豁免必须带**批准人 + 影响面**，并且要进回执/状态面（DEF-030，§3E 族 1）**。
 *
 * 缺陷原文（B 组 re-verify，四点结构证据，本用例前已逐点复现）：
 *   ① schema 逐字只有 `{task, check, why}`（`tools.ts`）—— 无 `approvedBy`/`quote`/`impact`；
 *   ② `index.ts` 只映射这三键 ⇒ 多给的键**静默丢弃**（写了等于没写）；
 *   ③ `office.ts` 的校验只有"`why` 非空 + check 码在册"两条；
 *   ④ 状态面 `grep exempt src/board/render.ts src/interface/describe.ts src/domain/coverage.ts` = **0**；
 *      `grep -c approvedBy src/domain/construction.ts` = **0**。
 * 结论：**豁免可以静默发生** —— 跳过一条判据的动作既没有批准人、也不出现在任何状态面。
 *
 * 对照面（词与形状照抄，不另造）：`sdo_gate action=waive` 与缺陷豁免（`trace.ts`）都用 `approvedBy`。
 * 口径：**旧的既有条目宽容读取**（读出来是空串，状态面显式标"未署名/未记影响面"供用户追认或撤销），
 * **新写进来的缺一即整次拒绝**（不写盘）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { exemptionLines, readConstructionProfile } from '../src/domain/construction.js'
import { renderBoard } from '../src/board/render.js'
import { describeExemptions } from '../src/interface/describe.js'
import { createTask } from '../src/domain/plan.js'
import { SoftwareDevOffice } from '../src/office.js'
import { Config, resolveSettings } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m144/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')
let office: SoftwareDevOffice
let store: SdoStore
let journal: Journal
let taskId: string
const call = { sessionId: 's-dev', cwd: WORKSPACE } as unknown as OfficeCall

const decide = (exempt: unknown[]): ReturnType<SoftwareDevOffice['decideConstructionProfile']> =>
  office.decideConstructionProfile(call, {
    packages: ['tdd'], scope: 'all', derivedFrom: ['scale=critical'], reason: '夹具', exempt: exempt as never, by: 'office',
  })

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, '.sdo'), { recursive: true })
  store = new SdoStore(join(WORKSPACE, '.sdo'))
  journal = new Journal(store)
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-dev', WORKSPACE)
  office.init(call, { name: 'M144 豁免署名', scale: 'critical', stakeholders: ['业务方'] })
  taskId = createTask(store, journal, {
    title: '夹具卡', goal: '夹具', inputs: [], outputs: [], dod: ['夹具'], role: 'developer', size: 'small',
    writeScopes: ['src/x.ts'],
  } as never).id
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M144-01 缺批准人 ⇒ 整次拒绝、点名卡与检查码、不写盘（红侧：旧实现照收）', () => {
  const outcome = decide([{ task: taskId, check: 'tdd-mutation-missing', why: '文档卡', impact: '跳过变异自证' }])
  assert.equal(outcome.ok, false, '没有批准人的豁免不得落盘')
  if (outcome.ok) assert.fail('应拒绝')
  assert.equal(outcome.problems.some((line) => line.includes(taskId) && line.includes('tdd-mutation-missing')), true, `拒因要点名卡与检查码：${outcome.problems.join('；')}`)
  assert.equal(readConstructionProfile(store).profile, undefined, '拒绝时零写入（profile 仍不存在）')
})

test('M144-02 缺影响面 ⇒ 整次拒绝（"放掉的是什么"必须写清）', () => {
  const outcome = decide([{ task: taskId, check: 'tdd-mutation-missing', why: '文档卡', approvedBy: '用户' }])
  assert.equal(outcome.ok, false)
  if (outcome.ok) assert.fail('应拒绝')
  assert.equal(readConstructionProfile(store).profile, undefined, '拒绝时零写入')
})

test('M144-03 反例：批准人 + 影响面齐备 ⇒ 接受并读回（不许修成"全拒绝"）', () => {
  const outcome = decide([{ task: taskId, check: 'tdd-mutation-missing', why: '文档卡', approvedBy: '用户（2026-10-14 追认）', impact: '放弃该卡的变异自证，风险由评审覆盖' }])
  assert.equal(outcome.ok, true, `齐备的豁免必须能落盘：${outcome.ok ? '' : outcome.problems.join('；')}`)
  const item = readConstructionProfile(store).profile?.exempt[0]
  assert.equal(item?.approvedBy, '用户（2026-10-14 追认）')
  assert.match(item?.impact ?? '', /风险由评审覆盖/u)
})

test('M144-04 状态面：豁免清单带批准人/影响面；历史条目显式标"未署名/未记影响面"', () => {
  // 历史条目（旧 profile：只有三键）——直接写盘模拟存量
  store.writeYaml(['construction', 'profile.yml'], {
    profile: {
      version: 1, decidedAt: '2026-01-01T00:00:00.000Z', decidedBy: 'office', packages: ['tdd'], scope: 'all',
      derivedFrom: ['scale=critical'], reason: '历史', history: [],
      exempt: [{ task: taskId, check: 'tdd-mutation-missing', why: '历史条目' }],
    },
  })
  const lines = exemptionLines(readConstructionProfile(store).profile)
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? '', /未署名/u, '旧条目必须显式标"未署名（待追认）"')
  assert.match(lines[0] ?? '', /未记影响面/u, '旧条目必须显式标"未记影响面"')
  assert.equal(describeExemptions([]), '', '没有豁免时不占一行')
  assert.match(describeExemptions(lines), /逐条豁免 1 条/u, '状态面要给出条数')
  // 看板首屏同样摊开（豁免不是静默开关）
  const board = renderBoard({
    project: undefined, config: {} as never, counts: {} as never, gates: [], process: {} as never,
    pendingGate: undefined, exemptions: lines,
  } as never)
  assert.match(board, /豁免/u, '看板必须印出豁免块')
  assert.match(board, /未署名/u, '看板要能看到"未署名"这一事实')
})
