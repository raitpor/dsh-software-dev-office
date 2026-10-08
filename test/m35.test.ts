/**
 * 需求变更**强制回退**（语义 A，2026-10-04）。
 *
 * 动机是真机缺陷（sdo-test 台账）：
 * ```text
 * 12:36:24Z change/requested CR-001
 * 12:36:24Z change/decided   CR-001 → approved
 * 12:36:24Z requirement/updated REQ-012
 * 12:36:47Z task/claimed     TASK-041   ← 批准后 23 秒，开发照常继续
 * ```
 * 变更控制只"登记 + 决策 + 算影响面"（`change.ts` 里 `phase` 出现 0 次）⇒ 需求变了对开发阶段毫无约束，
 * 受影响的那条需求就变成"让模型自由发挥"。本套用例钉住两半：
 *   ① 批准 ⇒ 阶段被拉回需求阶段（`change/rollback` 留痕，合法边来自流程数据）；
 *   ② 未消化期间 `claim` 被拒（`change-not-digested`），直到"重新基线 + 重过设计门"两件都做完。
 *
 * 为什么每个方向都要有**反向用例**：这是收紧类改动，宁可用例多一条，也不要"拦错了没人发现"——
 * 拒绝/延期、无关需求、仅重新基线，四种情形都必须各自有断言。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import { claim } from '../src/domain/collab.js'
import { undigestedChanges } from '../src/domain/change.js'
import { writeConstructionProfile } from '../src/domain/construction.js'
import { describeChange } from '../src/interface/describe.js'
import type { Context } from '@deepseek-ai/cordis'
import type { SdoConfig } from '../src/config.js'
import type { ConstructionProfile } from '../src/domain/construction.js'
import type { OfficeCall } from '../src/office.js'
import type { Requirement, TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm35')
let store: SdoStore
let journal: Journal

/** 每个场景一块干净工作区（同一用例里要跑多个场景时必须显式重置，否则台账会串）。 */
function freshWorkspace(): void {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
}

beforeEach(freshWorkspace)

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function writeRequirement(id: string, status: Requirement['status'] = 'baselined'): void {
  store.writeYaml(['requirements', `${id}.yml`], {
    requirement: { id, title: `${id} 的标题`, kind: 'functional', statement: '系统应支持计量口径 A', rationale: 'r', status, version: 0.2 },
  })
}

function writeCard(id: string, requirements: string[]): TaskCard {
  const card: TaskCard = {
    id,
    title: `${id} 的标题`,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes: [`src/${id}/`],
    role: 'developer',
    size: 'small',
    revision: 1,
    status: 'ready',
    requirements,
    evidence: [],
    createdAt: '',
    updatedAt: '',
  }
  store.writeYaml(['tasks', `${id}.yml`], { task: card })
  return card
}

function writeCase(id: string, requirement: string): void {
  store.writeYaml(['tests', `${id}.yml`], { testCase: { id, title: id, kind: 'unit', requirement, steps: ['s'], expected: 'e', at: '' } })
}

function profileOf(overrides: Partial<ConstructionProfile> = {}): ConstructionProfile {
  return {
    version: 1,
    decidedAt: '2026-10-04T00:00:00.000Z',
    decidedBy: 'office',
    packages: [],
    scope: 'all',
    derivedFrom: [],
    reason: '显式不选实现阶段方法包（本用例只练变更回退）',
    exempt: [],
    history: [],
    ...overrides,
  }
}

/**
 * 「正在开发、随时能开工」的初始状态：阶段 construction + 已基线需求 + 可认领的卡 + 用例 + 方法包决策。
 *
 * 故意把**能开工**这件事搭齐：M35-02/03 的断言才有判别性 —— 拒绝只可能来自变更未消化，
 * 而不是被测试先行 / 方法包这些旁边的关口顺手拦下（那样用例会"绿得没有道理"）。
 */
function readyToBuild(): { office: SoftwareDevOffice; call: OfficeCall; card: TaskCard; spare: TaskCard } {
  freshWorkspace()
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call: OfficeCall = { sessionId: 'cockpit', cwd: BASE }
  office.init(call, { process: 'waterfall' })
  journal.append('phase/entered', { phase: 'construction' })
  writeRequirement('REQ-012')
  const card = writeCard('TASK-041', ['REQ-012'])
  // 第二张卡：用来断言"同一道判据拦住**新**的认领"——已认领的卡会先撞上 `not-claimable`，测不出本判据
  const spare = writeCard('TASK-042', ['REQ-012'])
  writeCase('TC-001', 'REQ-012')
  writeConstructionProfile(store, profileOf())
  return { office, call, card, spare }
}

function approveChange(office: SoftwareDevOffice, call: OfficeCall, decision: 'approved' | 'rejected' | 'deferred' = 'approved') {
  /** 让**变更前**的状态真的经过一次 G3：这样"回退作废了它"才有东西可作废。 */
  journal.append('gate/result', { gate: 'G3', status: 'passed', phase: 'construction' })
  return office.change(call, {
    requirement: 'REQ-012',
    reason: '上游把计量口径从 A 改成 B',
    changes: ['计量口径 A → B'],
    decision,
    decidedBy: 'human',
  })
}

/** 「只冻结 G2」：批准之后的重新基线（内容已改由 `requirement/updated` 背书，这里只补冻结事实）。 */
function rebaselineOnly(): void {
  journal.append('requirement/baselined', { ids: ['REQ-012'], by: 'human' })
  journal.append('phase/entered', { phase: 'architecture' })
}

/** 重过设计门（流程数据里需求阶段之后那个阶段的 exit，waterfall 是 G3）。 */
function redoDesign(): void {
  journal.append('gate/result', { gate: 'G3', status: 'passed', phase: 'architecture' })
  journal.append('phase/entered', { phase: 'construction' })
}

/** 认领（版本号从台账现读：前一次认领会把 revision +1，写死版本号会撞 CAS）。 */
function claimNow(card: TaskCard, phase = 'construction') {
  const current = store.readYaml<{ task: TaskCard }>('tasks', `${card.id}.yml`)?.task
  return claim(store, journal, { taskId: card.id, owner: 'dev-a', expectedRevision: current?.revision ?? card.revision, phase })
}

test('M35-01 批准的需求变更 ⇒ 强制回退到需求阶段（合法边来自流程数据、留痕可审计），拒绝/延期不动阶段', () => {
  const { office, call } = readyToBuild()
  const result = approveChange(office, call, 'approved')

  assert.equal(result.applied, true, '批准必须生效（否则本用例测的是另一条路）')
  assert.equal(result.rollback?.error, undefined, `回退不该失败：${result.rollback?.error ?? ''}`)
  assert.equal(result.rollback?.alreadyThere, false, 'construction 不是需求阶段，必须真回退')
  assert.equal(result.rollback?.from, 'construction')
  assert.equal(result.rollback?.to, 'requirements')
  assert.ok(result.rollback?.invalidatedGates.includes('G3') === true, `要作废 G3（回来必须重新通过）：${result.rollback?.invalidatedGates.join(' ')}`)
  assert.ok(result.rollback?.invalidatedGates.includes('G5') === true, '目标阶段之后的门禁（G5/G6/G7）也要作废，否则重走被陈旧留痕直接放行')

  // 真源侧：阶段真的回去了（读投影），且两条留痕都在
  assert.equal(journal.loadProject().project?.phase, 'requirements', '阶段的真源是 journal → 投影必须跟着回到 requirements')
  const rolled = journal.read().events.filter((event) => event.type === 'phase/rolled-back')
  assert.equal(rolled.length, 1)
  assert.equal(rolled[0]?.data.from, 'construction')
  assert.equal(rolled[0]?.data.to, 'requirements')
  assert.match(String(rolled[0]?.data.reason ?? ''), /CR-001/u, '回退理由必须点名是哪条变更')

  const marked = journal.read().events.filter((event) => event.type === 'change/rollback')
  assert.equal(marked.length, 1, '`change/rollback` 是"这次回退由变更触发"的可 grep 留痕')
  assert.equal(marked[0]?.data.id, 'CR-001')
  assert.equal(marked[0]?.data.requirement, 'REQ-012')
  assert.equal(marked[0]?.data.from, 'construction')
  assert.equal(marked[0]?.data.to, 'requirements')

  // 回执：必须把"接下来三步走"写出来，否则用户以为回到需求阶段就够了
  const receipt = describeChange(result)
  assert.match(receipt, /construction → requirements/u, `要写清从哪退到哪：${receipt}`)
  assert.match(receipt, /重新冻结 G2/u)
  assert.match(receipt, /change-not-digested/u, '要写清"未消化期间认领会被拒"这第二半')

  // 反向：拒绝的变更**不动阶段**（打断当前工作是最容易误伤的一侧）
  const { office: office2, call: call2 } = readyToBuild()
  const rejected = approveChange(office2, call2, 'rejected')
  assert.equal(rejected.applied, false)
  assert.equal(rejected.rollback, undefined, '拒绝不触发回退')
  assert.equal(journal.loadProject().project?.phase, 'construction', '拒绝不得打断当前阶段')
  assert.equal(journal.read().events.filter((event) => event.type === 'change/rollback').length, 0)
  assert.equal(journal.read().events.filter((event) => event.type === 'phase/rolled-back').length, 0)
})

test('M35-02 未消化期间 `claim` 被拒：错误码 change-not-digested，且点名 CR 与受影响需求', () => {
  const { office, call, card, spare } = readyToBuild()
  assert.equal(claimNow(card).ok, true, '先证明这套初始状态本来能开工（否则拒绝没有判别性）')

  approveChange(office, call, 'approved')
  const blocked = claimNow(spare, 'requirements')
  assert.equal(blocked.ok, false)
  assert.equal(blocked.ok ? '' : blocked.code, 'change-not-digested')
  const detail = blocked.ok ? '' : blocked.detail
  assert.match(detail, /CR-001/u, `要点名是哪条变更：${detail}`)
  assert.match(detail, /REQ-012/u, '要点名受影响需求')
  assert.match(detail, /重新冻结 G2/u, '要写清下一步做什么（三步走）')

  // 直接问判定函数：同一份台账下"未消化"必须与拦人一致（回执与判据同源）
  const pending = undigestedChanges(store, journal, undefined)
  assert.deepEqual(pending.map((item) => [item.id, item.requirement, item.rebaselinedSeq]), [['CR-001', 'REQ-012', undefined]])
})

test('M35-03 只冻结 G2 仍不能开发；重新基线 + 重过设计门之后才放行（语义 A 的"两步"缺一不可）', () => {
  const { office, call, card, spare } = readyToBuild()
  approveChange(office, call, 'approved')

  // ① 只重新基线（G2 重签）—— 设计一行没动、G3 没重过 ⇒ 仍然拒绝
  rebaselineOnly()
  const afterBaseline = claimNow(spare, 'architecture')
  assert.equal(afterBaseline.ok, false, '只冻结 G2 就放行 = 需求变了却不重新设计（本用例要挡的正是这一半）')
  assert.equal(afterBaseline.ok ? '' : afterBaseline.code, 'change-not-digested')
  assert.match(afterBaseline.ok ? '' : afterBaseline.detail, /已重新基线/u, '理由要指出"基线有了，缺的是设计重过"')
  assert.match(afterBaseline.ok ? '' : afterBaseline.detail, /G3/u, '要点名要重过的那道设计门')

  // ② 重过设计门 ⇒ 放行
  redoDesign()
  const allowed = claimNow(card, 'construction')
  assert.equal(allowed.ok, true, `两步都做完就该放行：${allowed.ok ? '' : `${allowed.code} / ${allowed.detail}`}`)

  // ③ 反向：放行之后**又批准一条**变更 ⇒ 新的认领重新被拦住（放行不是"一次性开关"）
  const again = approveChange(office, call, 'approved')
  assert.equal(again.change.id, 'CR-002')
  const blockedAgain = claimNow(spare, 'requirements')
  assert.equal(blockedAgain.ok, false, '再次变更必须再次回退重走')
  assert.equal(blockedAgain.ok ? '' : blockedAgain.code, 'change-not-digested')
})

test('M35-04 反向（不得误伤）：无变更 / 拒绝 / 延期 / 已消化 / 基线不覆盖该需求 —— 各自断言', () => {
  // ① 完全没有变更 ⇒ 放行
  const fresh = readyToBuild()
  assert.equal(claimNow(fresh.card).ok, true, '没有变更时不许拦（否则整个流程被这条判据卡死）')

  // ② 延期 ⇒ 放行（defrred 不改真源，也不该打断开发）
  const deferred = readyToBuild()
  approveChange(deferred.office, deferred.call, 'deferred')
  assert.equal(claimNow(deferred.card).ok, true, '延期不是批准，不拦')

  // ③ 批准 + 重新基线 + 重过设计门 ⇒ 放行
  const digested = readyToBuild()
  approveChange(digested.office, digested.call, 'approved')
  rebaselineOnly()
  redoDesign()
  assert.equal(claimNow(digested.card).ok, true, '已消化 ⇒ 放行')

  // ④ 批准 + 重新基线**没覆盖该需求** + 重过设计门 ⇒ 仍拒（否则"随便基一次"就能洗白）
  const other = readyToBuild()
  approveChange(other.office, other.call, 'approved')
  journal.append('requirement/baselined', { ids: ['REQ-099'], by: 'human' })
  journal.append('phase/entered', { phase: 'architecture' })
  redoDesign()
  const notCovered = claimNow(other.card)
  assert.equal(notCovered.ok, false, '重新基线必须覆盖受影响需求')
  assert.equal(notCovered.ok ? '' : notCovered.code, 'change-not-digested')

  // ⑤ 批准 + `ids` 形状坏掉（标量/空） + 重过设计门 ⇒ 仍拒（手写坏形状不得洗白）
  const broken = readyToBuild()
  approveChange(broken.office, broken.call, 'approved')
  journal.append('requirement/baselined', { ids: 'REQ-012', by: 'human' })
  journal.append('phase/entered', { phase: 'architecture' })
  redoDesign()
  const malformed = claimNow(broken.card)
  assert.equal(malformed.ok, false, '`ids` 不是列表 ⇒ 不能当"覆盖了"')
  assert.equal(malformed.ok ? '' : malformed.code, 'change-not-digested')
})

// —————————————————————— 工具层：回执与接线 ——————————————————————

interface Harness {
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
}

function harness(): Harness {
  const registered: { name: string; execute: (args: unknown, exec: unknown) => unknown }[] = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: never) => { registered.push(tool as never); return () => {} } },
    sessions: {},
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  const exec = { agent: { id: 'cockpit', session: { header: { cwd: BASE } } } }
  return {
    callTool: async (name, args) => {
      const tool = registered.find((item) => item.name === name)
      assert.ok(tool !== undefined, `${name} 必须注册进工具表`)
      return String(await tool.execute(args, exec))
    },
  }
}

test('M35-05 工具层接线：`sdo_requirement action=change` 的回执写清三步走；紧接着 `sdo_task action=claim` 被拒', async () => {
  const h = harness()
  // 立项有自己的"不许拿默认值代替用户决定"关口 → 参数必须给全，否则项目根本没建（本用例会误判成"回退失败"）
  await h.callTool('sdo_init', { name: '变更回退演练', process: 'waterfall', scale: 'normal', stakeholders: '运维' })
  journal.append('phase/entered', { phase: 'construction' })
  writeRequirement('REQ-012')
  writeCard('TASK-041', ['REQ-012'])
  writeCase('TC-001', 'REQ-012')
  writeConstructionProfile(store, profileOf())

  const receipt = await h.callTool('sdo_requirement', {
    action: 'change',
    id: 'REQ-012',
    reason: '上游把计量口径从 A 改成 B',
    decision: 'approved',
  })
  assert.match(receipt, /CR-001/u, `回执要点名变更单：${receipt}`)
  assert.match(receipt, /requirements/u, '回执要写清退到了需求阶段')
  assert.match(receipt, /重新冻结 G2/u, '回执要给出三步走')
  assert.match(receipt, /change-not-digested/u, '回执要提前说清下一步会被什么拦住')
  assert.equal(journal.loadProject().project?.phase, 'requirements', '工具路径也必须真回退（不是只写在回执里）')

  const refused = await h.callTool('sdo_task', { action: 'claim', id: 'TASK-041', owner: 'dev-a', expectedRevision: 1 })
  assert.match(refused, /change-not-digested/u, `认领必须被同一道判据拦住：${refused}`)
  assert.match(refused, /CR-001/u)

  // 事后出口：`sdo_status` 也要能看到这条"未消化"——重启/上下文压缩后，拒绝回执已经不在上下文里了
  const status = await h.callTool('sdo_status', {})
  assert.match(status, /已批准但尚未消化/u, `状态块要能说出卡在哪：${status.slice(-400)}`)
  assert.match(status, /CR-001/u)
  assert.match(status, /重新冻结 G2/u, '状态块要一并给出下一步（与拒认领同一份文案）')

  // 反向：驳回一次变更不打断阶段（工具层的拒绝分支同样不许动阶段）
  journal.append('phase/entered', { phase: 'construction' })
  const rejected = await h.callTool('sdo_requirement', {
    action: 'change',
    id: 'REQ-012',
    reason: '这次不改了',
    decision: 'rejected',
  })
  assert.doesNotMatch(rejected, /强制回退/u, `驳回不得报回退：${rejected}`)
  assert.equal(journal.loadProject().project?.phase, 'construction', '驳回不得打断当前阶段')
})
