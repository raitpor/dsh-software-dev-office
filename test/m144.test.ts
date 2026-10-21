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
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { exemptionLines, readConstructionProfile } from '../src/domain/construction.js'
import { renderBoard } from '../src/board/render.js'
import { describeExemptions } from '../src/interface/describe.js'
import { createTask } from '../src/domain/plan.js'
import { apply } from '../src/index.js'
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

/** `profile.yml` 的**三值**快照（mtime / size / sha256）：零写盘的唯一可核对读数。 */
function profileStamp(): { mtimeMs: number; size: number; sha: string } {
  const file = store.path('construction', 'profile.yml')
  const stat = statSync(file)
  return { mtimeMs: stat.mtimeMs, size: stat.size, sha: createHash('sha256').update(readFileSync(file)).digest('hex') }
}

test('M144-05 TC-112：三次拒绝前后 `profile.yml` 的 mtime/size/sha256 三值**完全一致**（真零写盘）', () => {
  // 先落一份合法 profile —— 文件必须**先存在**，否则"没变化"是废话（现在 m144-01/02 只断 `profile === undefined`）
  const seeded = decide([{ task: taskId, check: 'tdd-mutation-missing', why: '先落一份', approvedBy: '用户', impact: '影响面 A' }])
  assert.equal(seeded.ok, true, `夹具前提：先落一份合法 profile（${seeded.ok ? '' : seeded.problems.join('；')}）`)
  const before = profileStamp()

  // 三种残缺：缺批准人 / 缺影响面 / 两者都缺
  for (const [label, payload] of [
    ['缺批准人', [{ task: taskId, check: 'tdd-mutation-missing', why: '文档卡', impact: '跳过变异自证' }]],
    ['缺影响面', [{ task: taskId, check: 'tdd-mutation-missing', why: '文档卡', approvedBy: '用户' }]],
    ['两者都缺', [{ task: taskId, check: 'tdd-mutation-missing', why: '文档卡' }]],
  ] as const) {
    const outcome = decide(payload as unknown as unknown[])
    assert.equal(outcome.ok, false, `${label} 必须被拒`)
    assert.deepEqual(profileStamp(), before, `${label} 被拒后三值必须完全一致（mtime 也不许动）`)
  }
})

test('M144-06 TC-112：写入成功时**回执**也落影响面（不只是状态面），且已署名条目在三面都能读到', async () => {
  // 工具面（真实注册的 `sdo_plan action=profile`）：回执是"人实际看到的那一面"
  const tools: { name: string; parameters: { properties?: Record<string, unknown> }; execute: (a: Record<string, unknown>, c: unknown) => unknown }[] = []
  const services: Record<string, unknown> = { tools: { register: (tool: never) => { tools.push(tool); return () => {} } } }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const plan = tools.find((item) => item.name === 'sdo_plan')
  assert.ok(plan !== undefined, '工具面缺 sdo_plan')
  const agent = { id: 's-dev', session: { header: { id: 's-dev', cwd: WORKSPACE, delegationDepth: 0 } } }
  const receipt = String(await plan.execute({
    action: 'profile', packages: '["tdd"]', derivedFrom: '["scale=critical"]', reason: '夹具',
    exempt: JSON.stringify([{ task: taskId, check: 'tdd-mutation-missing', why: '文档卡', approvedBy: '用户（追认）', impact: '放弃变异自证，由评审覆盖' }]),
  }, { agent }))

  assert.match(receipt, /放弃变异自证，由评审覆盖/u, `回执必须落影响面（读者不该只能去看文件）：${receipt.slice(-300)}`)
  assert.match(receipt, /用户（追认）/u, '回执同样要落批准人')

  // 状态面 + 看板：已署名条目的影响面同样可见（与历史条目的「未记影响面」形成对照）
  const lines = exemptionLines(readConstructionProfile(store).profile)
  assert.match(lines[0] ?? '', /放弃变异自证，由评审覆盖/u, '状态面必须印影响面')
  const board = renderBoard({
    project: undefined, config: {} as never, counts: {} as never, gates: [], process: {} as never,
    pendingGate: undefined, exemptions: lines,
  } as never)
  assert.match(board, /放弃变异自证，由评审覆盖/u, '看板首屏也要能看到影响面')
})
