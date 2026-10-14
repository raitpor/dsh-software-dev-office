/**
 * **增量 156：门禁失效的认领面 + 行为两态（DEF-040 第三刀 / §3E 族 6）**。
 *
 * 前两刀：`test/m154` 落了判据逻辑（`readyTasks` / `classifyNonDispatchable` 能表达"入口门禁失效 ⇒ 不派"），
 * `test/m155` 把 `office.ts` 的三处派发调用点接上。本刀补上**认领面**（`collab.ts` 的 `claim` 增
 * 拒绝码 `gate-stale`），并把两件事补成**行为两态**：
 *   · 认领：门禁**从没签过**（`missing`）⇒ 放行；签了字后被真源变更**作废**（`stale`）⇒ 可读拒绝
 *     并点名门禁 + 补救（重签）；**重签** ⇒ 恢复（反例）；
 *   · 派发：同一个工作区里，失效 ⇒ `readyForDispatch` 一张不派，重签 ⇒ 恢复。
 *
 * 另外两条口径钉在这里（都是"不这么写就会再造一个缺陷"的地方）：
 *   · **门禁 id 必须来自流程数据**：`waterfall` 的 `design-plan` 入口是 `G3`，`construction` 是 **`G4`**，
 *     `prototype` 的 `requirements` 是 **`GP`** ⇒ 用例把非 `G3` 的入口也走一遍（写死 `G3` 会当场红）；
 *   · **解冻路径不能被自己要解的冻锁住**（SDO-16 / SDO-17 的同一课）：门禁失效时，消化变更的那条路
 *     （`analyst` / `architect` / `office`）仍可认领。
 *
 * 判据**不在这里**：装配 `StaleGate` 的唯一出口是 `src/domain/entryGate.ts` 的 `staleEntryGateOf`，
 * 派发面与认领面调的是同一个函数（`test/m155` 的 M155-02 钉住这一点）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { createTask } from '../src/domain/plan.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { ClaimResult } from '../src/domain/collab.js'
import type { Journal } from '../src/infra/journal.js'
import type { SdoStore } from '../src/infra/store.js'
import type { OfficeCall } from '../src/office.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m156/', import.meta.url))

interface Fixture {
  office: SoftwareDevOffice
  store: SdoStore
  journal: Journal
  call: OfficeCall
  workspace: string
}

/** 建一个独立工作区（`initOptions` 里给 `process` 就能**换一份流程数据**）。 */
function fixture(name: string, initOptions: Record<string, unknown> = {}): Fixture {
  const workspace = join(BASE, name)
  mkdirSync(workspace, { recursive: true })
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const sessionId = `s-${name}`
  office.noteSession(sessionId, workspace)
  const call = { sessionId, cwd: workspace } as unknown as OfficeCall
  office.init(call, { name: `M156 ${name}`, scale: 'normal', stakeholders: ['业务方'], ...initOptions })
  return { office, store: office.storeFor(workspace), journal: office.journalFor(workspace), call, workspace }
}

/**
 * 把项目推进到某个阶段。`phase/entered` 属**记账**事件（在中性表里 ⇒ 不让任何签字失效），
 * 夹具直接落一条即可 —— 这里要的是"当前阶段"这个事实，不是阶段转移的合规性（那是 G 判据的事）。
 */
function enterPhase(f: Fixture, phase: string): void {
  f.journal.append('phase/entered', { phase })
  assert.equal(f.office.status(f.call).project?.phase, phase, `夹具前提：项目必须真的落在阶段 ${phase}`)
}

/** 有效期内的签字（`basis` 必须非空，且同一句依据**不许重放** ⇒ 每次换一句）。 */
function sign(f: Fixture, gate: string, quote: string): void {
  f.office.signGate(f.call, { gate, by: '张三', basis: quote, channel: 'command' })
}

/** 一次**真源变更**（`risk/logged` 不在中性表里 ⇒ 按 §7.2 作废此前的签字）。 */
function invalidate(f: Fixture): void {
  f.office.logRisk(f.call, {
    title: '失效夹具风险',
    level: 'high',
    probability: 'medium',
    impact: '大',
    mitigation: '重签门禁',
    owner: '张三',
  })
}

function card(f: Fixture, extra: Record<string, unknown> = {}): string {
  return createTask(f.store, f.journal, {
    title: '夹具卡',
    goal: 'g',
    dod: ['d'],
    role: 'developer',
    size: 'small',
    writeScopes: ['src/a/'],
    ...extra,
  } as never).id
}

/** 认领（CAS 版本号现读，避免夹具自己算错）。 */
function claimOf(f: Fixture, id: string, owner = '张三'): ClaimResult {
  const task = f.office.tasks(f.call).find((item) => item.id === id)
  assert.ok(task !== undefined, `夹具前提：卡 ${id} 必须存在`)
  return f.office.claimTask(f.call, { taskId: id, owner, expectedRevision: task.revision })
}

function rejected(result: ClaimResult): Extract<ClaimResult, { ok: false }> {
  assert.equal(result.ok, false, `本步必须被拒：${JSON.stringify(result)}`)
  return result as Extract<ClaimResult, { ok: false }>
}

function readyIds(f: Fixture): string[] {
  return f.office.readyForDispatch(f.call, 4).map((task) => task.id)
}

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M156-01 认领面行为两态：missing 放行 / 签字有效可认领 / 真源变更后点名门禁与补救 / 重签恢复', () => {
  const f = fixture('g3')
  enterPhase(f, 'design-plan')

  // ① `missing`（从没签过）⇒ **必须放行**（否则所有还没走到该门禁的正常流程停摆）
  const missingCard = card(f, { writeScopes: ['src/a/'] })
  assert.equal(claimOf(f, missingCard).ok, true, 'missing 不得拦认领')

  // ② 签字有效 ⇒ 照常可认领
  sign(f, 'G3', '我确认这次设计可以放行')
  assert.equal(f.office.signatureState(f.call, 'G3').status, 'valid', '夹具前提：G3 签字必须有效')
  const validCard = card(f, { writeScopes: ['src/b/'] })
  assert.equal(claimOf(f, validCard).ok, true, '签字有效时必须照常可认领')

  // ③ 真源变更 ⇒ 签字失效 ⇒ 认领被**可读拒绝**（点名门禁、阶段、补救动作）
  invalidate(f)
  assert.equal(f.office.signatureState(f.call, 'G3').status, 'stale', '夹具前提：真源变更必须让 G3 失效')
  const staleCard = card(f, { writeScopes: ['src/c/'] })
  const denied = rejected(claimOf(f, staleCard))
  assert.equal(denied.code, 'gate-stale', `拒绝码必须是 gate-stale：${JSON.stringify(denied)}`)
  assert.match(denied.detail, /G3/u, '必须点名失效的是哪个门禁')
  assert.match(denied.detail, /design-plan/u, '必须点名当前阶段')
  assert.match(denied.detail, /sdo_gate action=sign/u, '必须给出补救动作（重签该门禁）')
  // 拒绝也要留痕（DEF-059 的统一出口）：按拒绝码可数
  assert.equal(
    f.journal.read().events.filter((event) => event.type === 'task/claim-rejected' && event.data['code'] === 'gate-stale').length,
    1,
    '认领被拒必须留一条带拒绝码的 `task/claim-rejected`',
  )

  // ④ 反例：重签之后**恢复**（同一张卡）
  sign(f, 'G3', '我重新签字确认设计放行（重签）')
  assert.equal(f.office.signatureState(f.call, 'G3').status, 'valid', '重签后签字必须重新有效')
  assert.equal(claimOf(f, staleCard).ok, true, '重签后必须恢复可认领')
})

test('M156-02 派发面行为两态（门禁随阶段变）：construction 的入口是 G4 —— 失效 ⇒ 一张不派；重签 ⇒ 恢复', () => {
  const f = fixture('g4')
  enterPhase(f, 'construction')
  const id = card(f)
  assert.deepEqual(readyIds(f), [id], '前置：G4 从没签过（missing）不得拦派发')

  sign(f, 'G4', '我确认构造阶段入口可以放行')
  assert.deepEqual(readyIds(f), [id], '签字有效时照常可派')

  invalidate(f)
  assert.equal(f.office.signatureState(f.call, 'G4').status, 'stale', '夹具前提：真源变更必须让 G4 失效')
  assert.equal(f.office.signatureState(f.call, 'G3').status, 'missing', '对照组：G3 不是本阶段的入口，也不曾签过')
  assert.deepEqual(readyIds(f), [], '入口门禁失效 ⇒ 一张都不派')

  sign(f, 'G4', '我重新签字确认构造阶段入口（重签）')
  assert.deepEqual(readyIds(f), [id], '重签后必须恢复派发')
})

test('M156-03 反例（不许把解冻路径锁死）：门禁失效时，消化变更的那条路（analyst / architect / office）仍可认领', () => {
  const f = fixture('digest')
  enterPhase(f, 'design-plan')
  sign(f, 'G3', '我确认这次设计可以放行')
  invalidate(f)
  assert.equal(f.office.signatureState(f.call, 'G3').status, 'stale', '夹具前提：G3 必须已失效')

  // 施工/验证角色被拦（上面的 M156-01 已证），流程侧角色必须能开工去消化它（SDO-16 / SDO-17）
  for (const [index, role] of ['analyst', 'architect', 'office'].entries()) {
    const id = card(f, { role, writeScopes: [`src/digest${String(index)}/`] })
    const outcome = claimOf(f, id)
    assert.equal(outcome.ok, true, `${role} 必须能认领去消化变更（否则解冻路径被自己锁死）：${JSON.stringify(outcome)}`)
  }
})

test('M156-04 换一份流程数据也成立：prototype 的 requirements 入口是 GP（不是 G3）—— 失效时点名 GP', () => {
  const f = fixture('proto', { process: 'prototype' })
  assert.equal(f.office.status(f.call).project?.process, 'prototype', '夹具前提：项目流程必须是 prototype')
  enterPhase(f, 'requirements')

  sign(f, 'GP', '我确认原型结论已回填为需求')
  invalidate(f)
  assert.equal(f.office.signatureState(f.call, 'GP').status, 'stale', '夹具前提：真源变更必须让 GP 失效')

  const denied = rejected(claimOf(f, card(f)))
  assert.equal(denied.code, 'gate-stale', `拒绝码必须是 gate-stale：${JSON.stringify(denied)}`)
  assert.match(denied.detail, /GP/u, '必须点名 prototype 流程这一阶段的入口门禁 GP')
  assert.equal(/G3/u.test(denied.detail), false, '不得出现写死的 G3（G3 在这份流程里根本不是入口）')
  assert.deepEqual(readyIds(f), [], '派发面与认领面同源：也必须拦')
})

test('M156-05 结构：认领面接的是**同一个**唯一出口，且拒绝码枚举里有 gate-stale', () => {
  const collab = readFileSync(join(ROOT, 'src', 'domain', 'collab.ts'), 'utf8')
  assert.equal(collab.includes("'gate-stale'"), true, '拒绝码枚举必须含 gate-stale')
  assert.equal(
    collab.includes('staleEntryGateOf(store, journal, project)'),
    true,
    '认领面必须调唯一出口 staleEntryGateOf（不得自己重算"签字失没失效"）',
  )
  // 反向：认领面**不得**直接读签字台账 —— 判据只能在 domain/entryGate.ts 里写一次
  assert.equal(collab.includes('signatureState('), false, '认领面不得直连 signatureState（判据唯一出口是 entryGate.ts）')
  // 唯一出口只有一个实现：`stale` 判别位只允许出现在 entryGate.ts
  const entryGate = readFileSync(join(ROOT, 'src', 'domain', 'entryGate.ts'), 'utf8')
  assert.equal(entryGate.includes("state.status === 'stale'"), true, '判别位必须是 stale（不是 !== valid，也不是 missing）')
})

test('M156-06 回执回显：失效时"为什么一张都不派"必须点名门禁与原因，且不再回落成"没有可派发的卡"', () => {
  const f = fixture('echo')
  enterPhase(f, 'design-plan')
  const id = card(f)

  // 门禁没失效（missing）⇒ 不得多出这一类（形状兼容面）
  assert.equal(f.office.nonDispatchable(f.call).gateStale, undefined, '门禁未失效时不得多出 gateStale 这一类')

  sign(f, 'G3', '我确认这次设计可以放行')
  invalidate(f)
  const plan = f.office.nonDispatchable(f.call)
  assert.equal(plan.gateStale?.gate, 'G3', '回执必须点名失效的是哪个门禁')
  assert.match(plan.gateStale?.reason ?? '', /G3/u, '回执必须原样带上失效原因（人读，不重算）')
  assert.deepEqual(plan.gateStale?.tasks.map((task) => task.id), [id], '被拦下的卡要逐张列出')

  // 结构：渲染侧必须把这一类与"本轮没有可派发的任务卡"**分开**（否则"被拦住"被读成"活干完了"）
  const source = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  const renderer = source.slice(source.indexOf('function describeNonDispatchable'), source.indexOf('const ORACLE_KIND_KEYS'))
  assert.equal(renderer.includes('plan.gateStale'), true, '渲染侧必须单列这一行')
  assert.equal(
    // **DEF-007 之后**：那句 idle 的守卫多了"独占窗口排队"一维 ⇒ 断言同时要求两个排除项（只强不弱）
    /plan\.gateStale === undefined[\s\S]{0,160}plan\.exclusive === undefined[\s\S]{0,160}plan\.blocked\.length === 0/u.test(renderer),
    true,
    '「本次没有派发：没有可派发的任务卡」那句必须同时排除"门禁失效"与"独占窗口排队"两种情形',
  )
})
