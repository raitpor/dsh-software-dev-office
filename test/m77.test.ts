/**
 * **增量 77：sdo-test-new 复测报告（R6-复测 批次）的插件侧缺口** —— 回归 + 变异自证。
 *
 * 每条都在这里用**可复跑的机械断言**钉住（含反例），不采信报告的自述：
 *   · **R-6（major）**：不可复用的空闲子会话**占着池位** —— `rolePools` 把它算 `idle`（于是
 *     `freeSlots = cap − busy − idle` 被占掉），`admitDispatch` 却因掩码指纹不符拒绝复用 ⇒ 两份口径，
 *     真机 developer 并发 4→2，回执还自相矛盾（池满 + 空闲可复用 N）。
 *     真机复现（`sdo-test-new` journal `seq≤583`）：busy=2 / idle=3 / unusable=0 / freeSlots=0，两张卡全 `pool-full`。
 *   · **R-5A（minor）**：`admitDispatch` 往 `pool.busy` 塞占位孩子（`childSessionId: ''`）⇒ 把"本次准入 N 张"
 *     印成"在飞 N/cap"（真机 0 真在飞 + 4 准入 = 「在飞 4/4」而只派了 1 张）。
 *   · **R-5B（minor）**：`reuseSkipped` 在"逐候选卡"的循环里 push ⇒ 候选卡 × 不可复用会话的**笛卡尔积**
 *     （真机同一 sessionId 被重复列 6 次 / 5 次，回执写「有 12 个空闲子代理没有被复用」而实际只有 2 个）。
 *   · **R-4（major）**：写范围对账的基线取"认领那一刻" ⇒ **先写后领**的写入整个在窗口之外
 *     （真机：落盘 16:23:35、认领成功 16:24:52，晚 77 秒；子代理会话本来就不发 `workspace/changes`）。
 *   · **R-3（major）**：`redGreenGaps` 只看"同一 case 先 fail 后 pass" ⇒ 「改断言转绿」与「改实现转绿」
 *     在台账上完全等价（真机 5 个实例）；补三条同实验判据：同 `env`、同断言面指纹 `harness`、**产物必须变化**。
 *   · **R-2（minor）**：`baseline` 回执尾行**无条件**说"据 `phase/entered` 进入 architecture"，
 *     与它自己刚修好的"不重放阶段转移"（D-6）结论相反。
 *
 * （R-5C「被 `limit` 截掉的卡从"排队"里消失」是工具层回执，回归在 `test/m36.test.ts` 的 M36-08。）
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { redGreenGaps } from '../src/domain/construction.js'
import { claimBaseline, reconcileBaseline } from '../src/domain/collab.js'
import { admitDispatch, reuseBlockedReason, rolePools } from '../src/domain/pool.js'
import type { PoolChild } from '../src/domain/pool.js'
import { recordTestCase, recordTestResult } from '../src/domain/records.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { changedFilesSince, recordWorkspaceChanges } from '../src/domain/workspaceChanges.js'
import { describeBaseline } from '../src/interface/describe.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm77')

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'evidence'), { recursive: true })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

/** 每个用例一份干净台账（避免 id 分配互相影响）。 */
function fresh(name: string): { store: SdoStore; journal: Journal } {
  const dir = join(BASE, name)
  mkdirSync(join(dir, '.sdo', 'tests', 'results'), { recursive: true })
  mkdirSync(join(dir, '.sdo', 'evidence'), { recursive: true })
  const store = new SdoStore(join(dir, '.sdo'))
  return { store, journal: new Journal(store) }
}

function child(id: string, role: string, maskHash: string, state: 'busy' | 'idle', task = 'T0'): PoolChild {
  return { childSessionId: id, role, task, mode: 'continuable', state, rounds: 1, startedAt: '', finishedAt: '', maskHash }
}

function card(id: string): never {
  return { id, role: 'developer', size: 'small', status: 'ready', blockedBy: [], writeScopes: ['lib/'], evidenceRequired: ['command'] } as never
}

/** 真机 `seq≤583` 的形状：2 个在飞（新掩码）+ 3 个空闲（**旧掩码**）。 */
function stalePoolShape(): PoolChild[] {
  const old = '2b211984954f'
  const now = 'c8fb0ad88c46'
  return [
    child('old-1', 'developer', old, 'idle', 'TASK-022'),
    child('old-2', 'developer', old, 'idle', 'TASK-023'),
    child('old-3', 'developer', old, 'idle', 'TASK-025'),
    child('busy-1', 'developer', now, 'busy', 'TASK-029'),
    child('busy-2', 'developer', now, 'busy', 'TASK-034'),
  ]
}

test('M77-01 R-6：池视图与准入**同一判据** —— 掩码过期的空闲会话不占池位（真机并发 4→2 的那个缺陷）', () => {
  const pools = rolePools({ children: stalePoolShape(), roles: ['developer'], caps: {}, defaultCap: 4, maskHashOf: () => 'c8fb0ad88c46' })
  const dev = pools[0]
  assert.equal(dev?.busy.length, 2, '在飞 2')
  assert.equal(dev?.idle.length, 0, '掩码过期的空闲会话**不算**空闲可复用（旧口径这里是 3）')
  assert.equal(dev?.unusable.length, 3, '要单独列出来（各带原因）')
  assert.match(dev?.unusable[0]?.reason ?? '', /掩码已变更/u)
  assert.equal(dev?.freeSlots, 2, '**不占池位**：上限 4 − 在飞 2 − 可复用空闲 0 = 2（旧口径是 0）')

  const admission = admitDispatch({
    ready: [card('TASK-038'), card('TASK-022')],
    pools,
    globalRoom: 4,
    reuseIdle: true,
    maskHashOf: () => 'c8fb0ad88c46',
    reuseBlockedOf: () => undefined,
  })
  assert.equal(admission.dispatch.length, 2, '两张卡都要派得出去（旧实现两张全 pool-full）')
  assert.equal(admission.queued.length, 0, '不该排队')
  assert.equal(admission.blocked.length, 0, '更不该出现「池满（在飞 2/4，空闲可复用 3）」这种自相矛盾的话')
  assert.deepEqual(admission.dispatch.map((item) => item.reuseChildId), [undefined, undefined], '旧会话不复用 ⇒ 新起')
})

test('M77-02 R-6 判据只有一处：`reuseBlockedReason` 的四个方向', () => {
  const freshChild = child('c1', 'developer', 'H', 'idle')
  assert.equal(reuseBlockedReason(freshChild, 'H'), undefined, '指纹一致、无额外判据 ⇒ 可复用')
  assert.match(reuseBlockedReason(freshChild, 'OTHER') ?? '', /掩码已变更/u)
  assert.match(reuseBlockedReason(child('c2', 'developer', '', 'idle'), 'H') ?? '', /没有掩码指纹/u)
  assert.match(reuseBlockedReason(freshChild, '') ?? '', /掩码/u, '取不到当前指纹 ⇒ 保守不可复用（与旧准入口径一致）')
  assert.match(reuseBlockedReason(freshChild, 'H', () => '该会话创建时拿到 0 个工具') ?? '', /0 个工具/u, '额外判据优先且不吞理由')
  // 池视图与准入对同一条判据给出**同一个**结论（这就是 R-6 的收敛）
  const pools = rolePools({ children: [freshChild], roles: ['developer'], caps: { developer: 1 }, defaultCap: 1, maskHashOf: () => 'OTHER' })
  assert.equal(pools[0]?.idle.length, 0)
  assert.equal(pools[0]?.unusable.length, 1)
})

test('M77-03 R-5A/B：`在飞` 只报折叠事实；被放弃复用的会话按 id 去重（不出现笛卡尔积）', () => {
  const idle = [child('sk1', 'developer', 'H', 'idle'), child('sk2', 'developer', 'H', 'idle')]
  // 池视图只判掩码（它看不到"工具面观测"这一层）⇒ 两个会话此刻都在可复用清单里，
  // 准入端用同一份掩码 + 观测判据把它们都拒掉（这才是"两处口径必须一致"的真实场景）
  const pools = rolePools({ children: idle, roles: ['developer'], caps: { developer: 3 }, defaultCap: 3, maskHashOf: () => 'H' })
  assert.equal(pools[0]?.idle.length, 2, '前置：掩码一致 ⇒ 都在可复用清单里')
  const admission = admitDispatch({
    ready: [card('TASK-001'), card('TASK-002'), card('TASK-003')],
    pools,
    globalRoom: 4,
    reuseIdle: true,
    maskHashOf: () => 'H',
    reuseBlockedOf: () => '没有该子会话的工具面观测（无法确认它手里有工具）',
  })
  // **R-5B**：3 张候选卡 × 2 个不可复用会话 = 旧实现的 6 条；现在按 childSessionId 去重 ⇒ 2 条
  assert.equal(admission.reuseSkipped.length, 2, `同一会话不许按候选卡重复计数（旧实现是 6 条）：${JSON.stringify(admission.reuseSkipped)}`)
  assert.equal(new Set(admission.reuseSkipped.map((item) => item.childSessionId)).size, 2)
  assert.match(admission.reuseSkipped[0]?.reason ?? '', /观测/u)
  // **R-5A**：新建的孩子不再进 `busy`（在飞是折叠事实），准入数单独讲
  const dev = admission.pools.find((pool) => pool.role === 'developer')
  assert.equal(dev?.busy.length, 0, '这一轮新建的孩子**不进** `busy`（旧实现塞占位 ⇒ 回执印「在飞 4/4」）')
  assert.equal(admission.dispatch.length, 1, '上限 3 − 2 个不可复用空闲 ⇒ 还剩 1 个新建位子')
  const blockedDetail = admission.blocked.map((item) => item.detail).join(' ')
  assert.match(blockedDetail, /本次已先准入/u, '准入数要单独讲，不能冒充"在飞"')
  assert.doesNotMatch(blockedDetail, /在飞 [1-9]/u, `在飞必须只是折叠事实：${blockedDetail}`)
})

test('M77-04 R-4：对账基线取"认领"与"派发"里更早的那个 —— 先写后领不再有窗口（含反例）', () => {
  const { store, journal } = fresh('r4')
  journal.append('dispatch/started', { task: 'TASK-001', provider: 'spawn', childSessionId: 'child-1', role: 'developer', tools: 9 })
  const dispatchSeq = journal.read().events.length
  // 派发之后、认领之前的那一轮（宿主按 turn 采集 `workspace/changes`）
  journal.append('dispatch/observe-failed', { childSessionId: 'child-1', eventType: 'turn/end', error: '（夹具：占一个窗口，让采集点严格晚于派发）' })
  const collectSeq = journal.read().events.length
  assert.ok(dispatchSeq < collectSeq, '前置：采集点晚于派发')
  // "先落盘"：这一次采集发生在**认领之前**（journalSeq 就是采集时台账里的条数）
  recordWorkspaceChanges({
    store,
    sessionId: 'child-1',
    seq: 7,
    journalSeq: collectSeq,
    summary: { files: [{ path: 'src/evil.ts' }] },
    enabled: true,
    hasProject: true,
  })
  journal.append('task/claimed', { id: 'TASK-001', owner: 'sub-1', sessionId: 'child-1', revision: 1 })
  const claimSeq = journal.read().events.length
  assert.ok(collectSeq < claimSeq, `前置：采集(${collectSeq}) 早于认领(${claimSeq})`)

  const baseline = reconcileBaseline(journal, 'TASK-001')
  assert.equal(baseline?.seq, dispatchSeq, '对账基线必须是**派发**那条（更早）')
  assert.deepEqual(changedFilesSince(store, baseline?.sessionId, baseline?.seq).files, ['src/evil.ts'], '认领前的写入必须进对账窗口')
  // **反例**（这就是缺陷本身）：旧口径只认"认领那一刻" ⇒ 同一份数据完全看不到
  const old = claimBaseline(journal, 'TASK-001')
  assert.equal(old?.seq, claimSeq)
  assert.deepEqual(changedFilesSince(store, old?.sessionId, old?.seq).files, [], '旧基线（认领）看不到认领前的写入 —— R-4 的窗口')
  // 没有派发记录时退回认领基线（不能因为找不到派发就不对账）
  assert.deepEqual(reconcileBaseline(journal, 'TASK-999'), undefined)
})

test('M77-05 R-4 接线守卫：`done` 用 `reconcileBaseline`（不是只认领的那条）', () => {
  const collab = readFileSync(join(ROOT, 'src', 'domain', 'collab.ts'), 'utf8')
  assert.match(collab, /const baseline = reconcileBaseline\(journal, task\.id\)/u, '`done` 的对账基线必须取更早的那条')
  assert.match(collab, /export function dispatchBaseline/u, '要有"本卡被派发"的基线函数')
  // 反向：不许再出现"只认领"的老写法
  assert.doesNotMatch(collab, /const baseline = claimBaseline\(journal, task\.id\)/u)
})

test('M77-06 R-3：红→绿必须是**同一次实验**（env / 断言面指纹 / 产物变化）', () => {
  const task = { id: 'TASK-001', requirements: ['REQ-001'] } as unknown as TaskCard

  // ① 同 env / 同断言面 / 产物变化 ⇒ **不判红**（正向：不许拦错）
  const ok = fresh('r3-ok')
  const tc1 = recordTestCase(ok.store, ok.journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  recordTestResult(ok.store, ok.journal, { caseId: tc1.id, status: 'fail', evidence: '红', env: 'node=26', harness: 'surface-A', artifact: 'lib/x.js', artifactSha256: 'h1' })
  recordTestResult(ok.store, ok.journal, { caseId: tc1.id, status: 'pass', evidence: '绿', env: 'node=26', harness: 'surface-A', artifact: 'lib/x.js', artifactSha256: 'h2' })
  assert.deepEqual(redGreenGaps(ok.store, ok.journal, task), [], '同一次实验 ⇒ 无缺口')

  // ② 换了环境 ⇒ 判红
  const envCase = fresh('r3-env')
  const tc2 = recordTestCase(envCase.store, envCase.journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  recordTestResult(envCase.store, envCase.journal, { caseId: tc2.id, status: 'fail', evidence: '红', env: 'node=20', harness: 'surface-A', artifact: 'lib/x.js', artifactSha256: 'h1' })
  recordTestResult(envCase.store, envCase.journal, { caseId: tc2.id, status: 'pass', evidence: '绿', env: 'node=26', harness: 'surface-A', artifact: 'lib/x.js', artifactSha256: 'h2' })
  assert.deepEqual(redGreenGaps(envCase.store, envCase.journal, task).map((gap) => gap.check), ['tdd-env-changed'])

  // ③ 红绿之间**改了断言面** ⇒ 判红（真机 5 个实例都是这一条）
  const harnessCase = fresh('r3-harness')
  const tc3 = recordTestCase(harnessCase.store, harnessCase.journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  recordTestResult(harnessCase.store, harnessCase.journal, { caseId: tc3.id, status: 'fail', evidence: '红（23 条断言）', env: 'node=26', harness: 'surface-A', artifact: 'lib/x.js', artifactSha256: 'h1' })
  recordTestResult(harnessCase.store, harnessCase.journal, { caseId: tc3.id, status: 'pass', evidence: '绿（25 条断言）', env: 'node=26', harness: 'surface-B', artifact: 'lib/x.js', artifactSha256: 'h2' })
  assert.deepEqual(redGreenGaps(harnessCase.store, harnessCase.journal, task).map((gap) => gap.check), ['tdd-harness-changed'])

  // ④ 产物在红绿之间**没变**却转绿 ⇒ 判可疑
  const artifactCase = fresh('r3-artifact')
  const tc4 = recordTestCase(artifactCase.store, artifactCase.journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  recordTestResult(artifactCase.store, artifactCase.journal, { caseId: tc4.id, status: 'fail', evidence: '红', env: 'node=26', harness: 'surface-A', artifact: 'lib/x.js', artifactSha256: 'same' })
  recordTestResult(artifactCase.store, artifactCase.journal, { caseId: tc4.id, status: 'pass', evidence: '绿', env: 'node=26', harness: 'surface-A', artifact: 'lib/x.js', artifactSha256: 'same' })
  assert.deepEqual(redGreenGaps(artifactCase.store, artifactCase.journal, task).map((gap) => gap.check), ['tdd-artifact-unchanged'])

  // ⑤ 老台账（一个指纹字段都没有）⇒ 不判红（不许凭空判红；时序判据仍照旧）
  const legacyCase = fresh('r3-legacy')
  const tc5 = recordTestCase(legacyCase.store, legacyCase.journal, { title: 'tc', kind: 'unit', requirement: 'REQ-001', steps: ['s'], expected: 'e' })
  recordTestResult(legacyCase.store, legacyCase.journal, { caseId: tc5.id, status: 'fail', evidence: '红' })
  recordTestResult(legacyCase.store, legacyCase.journal, { caseId: tc5.id, status: 'pass', evidence: '绿' })
  assert.deepEqual(redGreenGaps(legacyCase.store, legacyCase.journal, task), [])
})

test('M77-07 R-3 接线：`harness` 必须真的能被记下来（工具 schema + Args + execute 映射三处同源）', () => {
  const tools = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(tools, /harness\?: string \| undefined/u, 'TestArgs 要有 harness')
  assert.match(tools, /harness: \{ type: 'string'/u, '工具 schema 要声明 harness')
  assert.match(tools, /harness: typeof args\.harness === 'string'/u, 'execute 映射要带上它（否则参数在边界被静默丢弃）')
  assert.match(index, /args\.harness === undefined \? \{\} : \{ harness: args\.harness \}/u, '要传进 recordTestResult')
  assert.match(readFileSync(join(ROOT, 'src', 'domain', 'records.ts'), 'utf8'), /harness: result\.harness/u, '真源事件里也要有它')
})

test('M77-08 R-2：`baseline` 回执不得讲与台账相反的话（阶段没转就不能说"进入 architecture"）', () => {
  const dor = { criteria: [], score: 14, passed: true, gaps: [] } as never
  const notEntered = describeBaseline({ ok: true, dor, baselined: [], phaseEntered: false, phase: 'construction' })
  assert.match(notEntered, /本次阶段未变/u, `阶段没转就要如实说：${notEntered}`)
  assert.match(notEntered, /construction/u, '要点名当前阶段')
  assert.doesNotMatch(notEntered, /进入 `architecture`/u, '不许无条件说"进入 architecture"')
  const entered = describeBaseline({ ok: true, dor, baselined: [], phaseEntered: true, phase: 'architecture' })
  assert.match(entered, /进入 `architecture`/u)
  assert.doesNotMatch(entered, /本次阶段未变/u)
  // 接线守卫：`baseline()` 必须把"这次转没转 + 现在是哪个阶段"交给渲染层
  const office = readFileSync(join(ROOT, 'src', 'office.ts'), 'utf8')
  assert.match(office, /phaseEntered,/u, 'outcome 要带 phaseEntered')
  assert.match(office, /phaseEntered, phase: phaseEntered \? 'architecture' : currentPhase/u, '渲染层要拿到"转没转 + 当前阶段"')
})
