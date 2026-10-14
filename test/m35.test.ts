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
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import {
  assessCoverage,
  assessCoverageFromStore,
  coverageCriterionLabel,
  coverageRemedy,
  describeCoverage,
  meetsThresholdText,
  pathFingerprint,
  sameHash,
} from '../src/domain/coverage.js'
import { recordTestCase, recordTestResult } from '../src/domain/records.js'
import { link } from '../src/domain/trace.js'
import type { CoverageAssessment, CoverageReading, CoverageSource, CoverageUncoveredEntry } from '../src/domain/coverage.js'
import { CHECKERS, assessExitCriteria } from '../src/domain/gates.js'
import { validateTestingSource, writeValidatedTestingSource } from '../src/domain/testingShapes.js'
// **TASK-053**：读数侧的准则别名只在**内容层**有一张表（`testDesignWhitebox.CRITERION_ALIASES`）——
// 本用例拿它当"两侧该不该收下"的**唯一**裁判，谁再抄一份映射表，等价式那几条立刻红。
import { canonicalCriterion } from '../src/domain/testDesignWhitebox.js'
import { COVERAGE_CRITERIA } from '../src/domain/testingStore.js'
import { describeChange } from '../src/interface/describe.js'
import type { Context } from '@deepseek-ai/cordis'
import type { SdoConfig } from '../src/config.js'
import type { ConstructionProfile } from '../src/domain/construction.js'
import type { GateContext } from '../src/domain/gates.js'
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
  // **D-22 连带**：`changes[]` 是人读摘要，**不算变更内容**；而且"同一个值再提交一遍"也不算变更。
  // 所以每次调用给一句**新的**陈述（真实用法本来就是"每次变更改点东西"）。
  changeRound += 1
  return office.change(call, {
    requirement: 'REQ-012',
    reason: `上游把计量口径改成第 ${changeRound} 版`,
    changes: [`计量口径 → 第 ${changeRound} 版`],
    decision,
    decidedBy: 'human',
    patch: { statement: `系统应支持计量口径（第 ${changeRound} 版）` },
  })
}
let changeRound = 0

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
    // **D-22**：变更内容要真的给出来（`changes[]` 只是人读摘要）—— 空载荷的批准不再回退阶段。
    statement: '系统应支持计量口径 B',
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

// ——————————————————————————————————————————————————————————————
// 覆盖读数与产物哈希绑定（TASK-016 / REQ-049 + REQ-057）
//
// 这一段的被测面是 `src/domain/coverage.ts`（判定）与 `src/domain/gates.ts`（接线）。
// 三件事各自要能证伪：
//   ① **读数八项齐备**：准则 / 阈值 / 实测 / 工具与命令 / 报告路径 / 报告哈希 / 被测产物 / 产物哈希；
//      缺报告（AC-199）、报告被改（哈希不符）、实测未达阈值 ⇒ 逐项判红并点名；
//   ② **过期由哈希判**（AC-198）：产物改动 ⇒ 读数 `stale` 且**点名产物路径**（不是"整体不达标"）；
//   ③ **守卫两态**：哈希一致可用 / 改动后过期 —— 走 `CHECKERS['tests.passed']`（G6 C-50 的真实接线）。
//
// 断言纪律（本卡的 DoD 踩在三种"假绿"上，逐条防）：
//   · **恒真断言**：`sameHash` 被变异成"永远返回 true"后，过期用例必须**变红**（M35-16 自证）；
//   · **空集合断言**：凡是"全部满足"型断言，先断言集合非空（`readings.length > 0`）；
//   · **负向对照空转**：判红的用例先证它在**修好之前**确实红（同一份真源改一处即转绿）。
// ——————————————————————————————————————————————————————————————

/** 覆盖读数用例的独立工作区（与上面的变更回退场景分开，免得两处台账互相串）。 */
const COV_BASE = join(ROOT, 'node_modules', '.sdo-test', 'm35-coverage')

/** 夹具里那条用例的编号（`recordTestCase` 按登记顺序分配，工作区每次清空 ⇒ 从 TC-001 起）。 */
const KNOWN_CASE = 'TC-001'

function covClean(): void {
  rmSync(COV_BASE, { recursive: true, force: true })
  mkdirSync(join(COV_BASE, '.sdo', 'testing'), { recursive: true })
}

function writeText(relativePath: string, text: string): void {
  const absolute = join(COV_BASE, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, text, 'utf8')
}

function sha256(relativePath: string): string {
  return createHash('sha256').update(readFileSync(join(COV_BASE, relativePath))).digest('hex')
}

/** 测出来的产物哈希（`sha256:<hex>`；与形状校验 `hashOf` 认的写法一致）。 */
function artifactHash(relativePath: string): string {
  return `sha256:${sha256(relativePath)}`
}

/** 一份"齐备"的读数（本用例的**绿侧基准**：每一项都真在盘上、哈希真算出来的）。 */
function validReading(overrides: Partial<CoverageReading> = {}): CoverageReading {
  return {
    id: 'COV-001',
    criterion: 'statement',
    threshold: '80%',
    measured: '91%',
    command: 'node --test lib/test/m35.test.js',
    report: 'reports/coverage.txt',
    reportHash: artifactHash('reports/coverage.txt'),
    artifact: 'artifacts/widget.txt',
    artifactHash: artifactHash('artifacts/widget.txt'),
    ...overrides,
  }
}

/**
 * **历史写法**的读数：`artifact` 里直接写产物哈希、没有 `artifactHash`（仓内既有夹具与存量真源的口径）。
 *
 * 为什么要单独一份：形状层对 `artifact` 的冻结口径是"产物哈希"（`testingShapes.hashOf`），
 * 因此走真实落盘闸门的用例只能用这种写法；而本卡新增的 `artifactHash` 承担"产物**路径**"那一半语义。
 * 两种写法都必须能被判定，见 M35-17 的四步。
 */
function legacyReading(overrides: Partial<CoverageReading> = {}): CoverageReading {
  return validReading({ artifact: artifactHash('artifacts/widget.txt'), artifactHash: '', ...overrides })
}

/** 未覆盖项（本用例的**绿侧基准**：处置逐条齐备）。 */
function uncoveredFixture(): CoverageUncoveredEntry[] {
  return [
    { id: 'UN-001', item: 'readings[3] 的判定分支', disposition: '补用例', useCase: 'TC-001' },
    { id: 'UN-002', item: 'never 分支（死代码）', disposition: '不可达', reason: '该分支由 `never` 收尾，运行时不可达' },
    { id: 'UN-003', item: 'def-use 对（同一条语句的两次取值）', disposition: '等价', reason: '等价于 UN-002 已覆盖的那条路径' },
  ]
}

/** 建一整套绿侧盘面：报告、产物、读数（八项齐备）、未覆盖项处置。 */
function greenCoverage(): void {
  covClean()
  writeText('reports/coverage.txt', 'statement coverage: 91% (91/100)\n')
  writeText('artifacts/widget.txt', 'widget v1\n')
  const store = new SdoStore(join(COV_BASE, '.sdo'))
  store.writeYaml(['testing', 'coverage.yml'], {
    coverage: { readings: [validReading()], uncovered: uncoveredFixture() },
  })
}

/** 把上面那套夹具接进 G6 判据：**判据本来是绿的**（用例 + 真源结果事件 + 追溯边齐备），
 * 这样"读数过期把它拖红"才是判别性的结论 —— 否则红的可能是"没有用例"这类前置关口。 */
function coverageGateFixture(): { ctx: GateContext; store: SdoStore; journal: Journal } {
  // **顺序要紧**：`greenCoverage()` 会清空整个工作区，必须在它**之后**写用例与结果，
  // 否则刚登记的真源会被下一次清空带走（实测踩到：读数凭空变成 0 条，用例变成"没有用例"）。
  greenCoverage()
  const store = new SdoStore(join(COV_BASE, '.sdo'))
  const journal = new Journal(store)
  store.writeYaml(['requirements', 'REQ-049.yml'], {
    requirement: {
      id: 'REQ-049',
      title: '覆盖读数',
      kind: 'functional',
      statement: '系统须接受自报测量 + 机械核对的覆盖率证据',
      rationale: 'r',
      priority: 'must',
      status: 'baselined',
      version: 0.2,
      acceptance: [{ id: 'AC-197', given: 'g', when: 'w', then: 't' }],
    },
  })
  const testCase = recordTestCase(store, journal, {
    title: '覆盖读数守卫',
    kind: 'unit',
    requirement: 'REQ-049',
    steps: ['s'],
    expected: 'e',
    // **TASK-039 落点七（2026-10-13）**：判据 `C-50` 现在按 REQ-053 读"**已独立采纳**的通过数"
    // （`passedAdopted`），未采纳的 pass 会被判红并点名。本夹具要测的是"**覆盖读数过期**不许把 C-50
    // 拖红"，与采纳无关 ⇒ 夹具必须自带**判定基准**，否则它会先因"没有登记判定基准"被判未采纳，
    // 让本用例红在一个与被测结论无关的关口上（那是假红，不是本用例想守的东西）。
    oracle: { kind: 'expert', expert: '夹具评审员' },
  })
  assert.equal(testCase.id, KNOWN_CASE, '用例编号按登记顺序走，夹具与读数共用它')
  // 同上：执行者与采纳者必须不同（REQ-053），否则这条夹具自己就落在 `unadopted` 里。
  recordTestResult(store, journal, {
    caseId: testCase.id,
    status: 'pass',
    evidence: '夹具：节点断言全绿',
    executedBy: 'fixture-runner',
    adoptedBy: 'fixture-adopter',
  })
  // 追溯边：must 需求要有 req-tc（否则 `tests.passed` 会先被追溯覆盖拦下，测不到本卡这条判据）
  link(store, journal, { from: 'REQ-049', to: testCase.id, kind: 'req-tc' })
  const requirements = [store.readYaml<{ requirement: Requirement }>('requirements', 'REQ-049.yml')?.requirement]
  assert.equal(requirements[0]?.id, 'REQ-049', '夹具需求必须读得回来')
  const ctx = {
    workspace: COV_BASE,
    store,
    journal,
    requirements: requirements.filter((item): item is Requirement => item !== undefined),
  } as unknown as GateContext
  return { ctx, store, journal }
}

function assessHere(source: CoverageSource, knownCaseIds: readonly string[] = ['TC-001']): CoverageAssessment {
  return assessCoverage({ workspace: COV_BASE, source, knownCaseIds })
}

/** 手写真源可以有**漏字段**（这正是要判红的那些情形）：测试里显式绕过类型，让运行时去判。 */
function loose(uncoveredItem: Record<string, unknown>): CoverageUncoveredEntry {
  return uncoveredItem as unknown as CoverageUncoveredEntry
}

/** 取点号路径对应的问题码集合（判红要能指到**具体字段**，不是"整条不对"）。 */
function codesOf(assessment: CoverageAssessment, field: string, index = 0): string[] {
  const reading = assessment.readings[index]
  return (reading?.issues ?? []).filter((issue) => issue.field === field).map((issue) => issue.code)
}

afterEach(covClean)

test('M35-11 覆盖读数八项齐备 ⇒ 可用；缺报告 / 报告被改 / 未达阈值 ⇒ 逐条判红并点名（REQ-049）', () => {
  greenCoverage()
  const store = new SdoStore(join(COV_BASE, '.sdo'))
  const green = assessCoverageFromStore(store, COV_BASE, ['TC-001'])

  // ① 绿侧：先证明**非空**（"全部满足"型断言必须先把空集合挡掉）
  assert.equal(green.readings.length, 1, '绿侧必须有且只有一条读数（空集合不许算通过）')
  assert.equal(green.uncovered.length, 3, '绿侧三条未覆盖项都要读到')
  assert.equal(green.outcome, 'ok', `八项齐备的读数应当可用：${describeCoverage(green)}`)
  assert.deepEqual(green.offenders, [], '绿侧不许有点名的读数')
  assert.deepEqual(green.unsettled, [], '绿侧不许有未处置项')
  assert.equal(green.readings[0]?.outcome, 'ok')
  assert.equal(green.readings[0]?.measured, '91%', '实测值要原样带出来（回执里逐条现算）')
  assert.equal(green.readings[0]?.threshold, '80%')
  assert.ok(green.readings[0]?.actualArtifactHash !== '', '现算产物哈希要给出（否则"过期"无从判定）')

  // ② **只有数字没有报告**（AC-199）：判红并点名缺失的报告
  const noReport = assessHere({ readings: [validReading({ report: '', reportHash: '' })] })
  assert.equal(noReport.outcome, 'invalid', '缺报告路径的读数不许算可用')
  assert.deepEqual(codesOf(noReport, 'readings[0].report'), ['report-missing'])
  assert.match(describeCoverage(noReport), /report-missing|报告/u, '回执要能说清是"缺报告"')

  // ③ 报告**存在但哈希不符**（报告被改过 / 换过一份）⇒ 判红
  writeText('reports/coverage.txt', 'statement coverage: 91% (91/100)  ← 有人事后改了报告\n')
  const drifted = assessCoverageFromStore(store, COV_BASE, ['TC-001'])
  assert.equal(drifted.outcome, 'invalid', '报告哈希不符 ⇒ 读数不成立')
  assert.deepEqual(codesOf(drifted, 'readings[0].reportHash'), ['report-hash-mismatch'])

  // ④ 报告**路径对但文件不在盘上** ⇒ 判红（"数字留下来了、依据没留下来"）
  const gone = assessHere({ readings: [validReading({ report: 'reports/not-there.txt', reportHash: `sha256:${'a'.repeat(64)}` })] })
  assert.deepEqual(codesOf(gone, 'readings[0].report'), ['report-not-found'])

  // ⑤ 实测**未达阈值** ⇒ 判红（实测达标与否逐条现算，不做加权合并）
  const below = assessHere({ readings: [validReading({ measured: '62%' })] })
  assert.deepEqual(codesOf(below, 'readings[0].measured'), ['measured-below-threshold'])
  assert.match(describeCoverage(below), /62%/u, '判红要点名实测值')

  // ⑥ 阈值缺 / 实测读不出数 / 命令缺或占位 ⇒ 各自点名到字段
  assert.deepEqual(codesOf(assessHere({ readings: [validReading({ threshold: '' })] }), 'readings[0].threshold'), ['threshold-missing'])
  assert.deepEqual(codesOf(assessHere({ readings: [validReading({ measured: '差不多达标' })] }), 'readings[0].measured'), ['measured-invalid'])
  assert.deepEqual(codesOf(assessHere({ readings: [validReading({ command: '' })] }), 'readings[0].command'), ['command-missing'])
  assert.deepEqual(codesOf(assessHere({ readings: [validReading({ command: 'TODO' })] }), 'readings[0].command'), ['command-placeholder'])

  // ⑦ 准则非法 ⇒ 点名**合法集合**（含中文标签）；缺准则 ⇒ 单独一个码
  const illegal = assessHere({ readings: [validReading({ criterion: 'coverage' })] })
  assert.deepEqual(codesOf(illegal, 'readings[0].criterion'), ['criterion-unknown'])
  assert.match(describeCoverage(illegal), /legalCoverageCriteriaText|合法集合/u)
  assert.match(describeCoverage(illegal), /statement/u, '合法集合要逐条列出来')
  assert.match(describeCoverage(illegal), /语句/u, '合法集合要带中文标签（人读得懂）')
  assert.deepEqual(codesOf(assessHere({ readings: [validReading({ criterion: '' })] }), 'readings[0].criterion'), ['criterion-missing'])

  // ⑧ 缺被测产物 / 缺产物哈希：**没有哈希就没有过期判定**，因此不许算可用
  assert.deepEqual(codesOf(assessHere({ readings: [validReading({ artifact: '' })] }), 'readings[0].artifact'), ['artifact-missing'])
  // 「artifact 写**路径**、只是没写 artifactHash」⇒ 缺的是"记录时那一版"⇒ 判不动（不是"过期"，也不是"可用"）
  assert.deepEqual(codesOf(assessHere({ readings: [validReading({ artifactHash: '' })] }), 'readings[0].artifactHash'), ['artifact-hash-missing'])
  // 「哈希没记」这一条**单独**来看就是"判不动"：整体 outcome 还受别的毛病影响，所以这里直接钉那条读数本身
  assert.equal(assessHere({ readings: [validReading({ artifactHash: '' })] }).readings[0]?.outcome, 'unknown', '哈希没记 ⇒ 该读数判不动')
  assert.match(describeCoverage(assessHere({ readings: [validReading({ artifactHash: '' })] })), /判不动/u, '回执要说清是"判不动"而不是"过期"')
  // 「artifact 里直接写哈希、没写 artifactHash」（历史写法）⇒ 哈希在手但不知道产物在哪 ⇒ 同样判不动
  const legacyOnlyHash = assessHere({ readings: [validReading({ artifact: artifactHash('artifacts/widget.txt'), artifactHash: '' })] })
  assert.deepEqual(codesOf(legacyOnlyHash, 'readings[0].artifactHash'), ['artifact-hash-missing'])
  assert.equal(legacyOnlyHash.readings[0]?.outcome, 'unknown', '历史写法也不许算可用（它查不动）')
  assert.match(describeCoverage(legacyOnlyHash), /不知道产物在哪/u, '要点名缺的是产物路径')

  // ⑨ 百分比与占比两种写法必须能对着比（`0.62` 不该被当成"62 倍"）
  assert.equal(assessHere({ readings: [validReading({ measured: '0.91', threshold: '0.8' })] }).outcome, 'ok', '占比写法：0.91 ≥ 0.8')
  assert.equal(assessHere({ readings: [validReading({ measured: '0.62', threshold: '80%' })] }).outcome, 'invalid', '混写：0.62 < 80% ⇒ 判红')
  assert.equal(assessHere({ readings: [validReading({ measured: '91/100', threshold: '0.8' })] }).outcome, 'ok', '分母写法：91/100 ≥ 0.8')

  // ⑩ 中英取值与标签：准则的中文标签经 testingStore 的标签表取（不另造第二套词表）
  assert.equal(coverageCriterionLabel('statement'), '语句')
  assert.equal(coverageCriterionLabel('def-use'), '定义-使用对')
  assert.equal(coverageCriterionLabel('不存在的准则'), '不存在的准则', '查不到时回落原文，绝不印空串')
})

test('M35-12 未覆盖项逐条处置：补用例 / 不可达 / 等价各自要依据，未处置即判红（REQ-057）', () => {
  greenCoverage()
  const ok = assessHere({ readings: [validReading()], uncovered: uncoveredFixture() })
  assert.equal(ok.uncovered.length, 3, '三条处置都要读到（空集合不许算通过）')
  assert.deepEqual(ok.unsettled, [], '三条各自齐备 ⇒ 无未处置项')

  // ① 缺处置（漏写 disposition）⇒ 判红并点名
  const missing = assessHere({
    uncovered: [loose({ id: 'UN-001', item: '判定分支' })],
  })
  assert.equal(missing.uncovered[0]?.outcome, 'invalid')
  assert.deepEqual(missing.uncovered[0]?.issues.map((issue) => issue.code), ['disposition-missing'])
  assert.deepEqual(missing.unsettled, ['UN-001'])

  // ①b **点不到具体项**也判红（`item` 为空）：处置要挂在"哪条语句/分支/路径/def-use 对"上。
  //     这条是变异自证逼出来的 —— 把 `item` 为空的判定去掉后，本用例**全绿**（变异体存活），
  //     说明原断言集在这条路径上是空的（"空集合断言"那一类假绿）。
  const bare = assessHere({ uncovered: [loose({ id: 'UN-001', disposition: '不可达', reason: '由 never 收尾' })] })
  assert.equal(bare.uncovered[0]?.outcome, 'invalid', '未覆盖项本身没写清 ⇒ 不许算已处置')
  assert.deepEqual(bare.uncovered[0]?.issues.map((issue) => issue.code), ['disposition-missing'])
  assert.equal(bare.uncovered[0]?.item, '', '空 item 要原样带出来（回执据此点名）')
  assert.deepEqual(bare.unsettled, ['UN-001'])
  assert.match(describeCoverage(bare), /缺未覆盖项本身/u, '回执要说清缺的是"未覆盖项本身"')

  // ② 处置取值不在词表里（想用"豁免"把没处置洗成已处置）⇒ 判红
  const unknown = assessHere({ uncovered: [{ id: 'UN-001', item: '判定分支', disposition: '豁免' }] })
  assert.deepEqual(unknown.uncovered[0]?.issues.map((issue) => issue.code), ['disposition-unknown'])
  assert.match(unknown.uncovered[0]?.issues[0]?.message ?? '', /补用例 \/ 不可达 \/ 等价/u, '要列合法集合')

  // ③ 声明"补用例"却没给用例 / 给的用例查不到 ⇒ 判红（AC-223：处置要能指到那条用例）
  const noCase = assessHere({ uncovered: [{ id: 'UN-001', item: '判定分支', disposition: '补用例' }] })
  assert.deepEqual(noCase.uncovered[0]?.issues.map((issue) => issue.code), ['usecase-missing'])
  const ghostCase = assessHere({ uncovered: [{ id: 'UN-001', item: '判定分支', disposition: '补用例', useCase: 'TC-999' }] })
  assert.deepEqual(ghostCase.uncovered[0]?.issues.map((issue) => issue.code), ['usecase-unknown'])
  // 反向：同一份处置把用例 id 改成登记表里真有的 ⇒ 立刻转绿（证明上面判的不是"永远红"）
  assert.equal(assessHere({ uncovered: [{ id: 'UN-001', item: '判定分支', disposition: '补用例', useCase: 'TC-001' }] }).outcome, 'ok')

  // ④ 不可达 / 等价**没有依据**（AC-222）⇒ 判红，不得计为已处置
  for (const disposition of ['不可达', '等价']) {
    const bare = assessHere({ uncovered: [{ id: 'UN-001', item: '死代码分支', disposition }] })
    assert.equal(bare.uncovered[0]?.outcome, 'invalid', `${disposition} 没依据不许算已处置`)
    assert.deepEqual(bare.uncovered[0]?.issues.map((issue) => issue.code), ['reason-missing'])
  }
  // 反向：补上依据 ⇒ 转绿
  assert.equal(assessHere({ uncovered: [{ id: 'UN-002', item: '死代码分支', disposition: '不可达', reason: '由 never 收尾' }] }).outcome, 'ok')

  // ⑤ **整体达标不许掩盖个别未处置项**（这条纪律的不对称处）：读数全绿 + 一条未处置 ⇒ 整体判红
  const mixed = assessHere({ readings: [validReading()], uncovered: [...uncoveredFixture().slice(0, 2), { id: 'UN-004', item: '另一条分支', disposition: '等价' }] })
  assert.equal(mixed.readings.every((item) => item.outcome === 'ok'), true, '读数侧确实全绿')
  assert.equal(mixed.outcome, 'invalid', '整体达标不许把个别未处置项盖过去')
  assert.deepEqual(mixed.unsettled, ['UN-004'])
  assert.match(describeCoverage(mixed), /UN-004/u)
})

test('M35-13 守卫两态（哈希一致可用 / 产物改动后过期并点名产物）：走 G6 C-50 的真实接线（AC-197/198）', () => {
  const { ctx, store } = coverageGateFixture()

  /** G6 的判据集里，只有 `C-50 tests.passed` 会被 `coverage.yml` 影响；这里只测这条判据本身。 */
  const checker = CHECKERS['tests.passed']
  assert.equal(typeof checker, 'function', 'tests.passed 必须在 CHECKERS 里注册（否则过期读数拦不住门禁）')
  if (checker === undefined) throw new Error('tests.passed 未注册')

  // **负向对照不许空转**：先证明这条判据**本来是绿的** —— 否则下面的"判红"可能来自别的关口，
  // 而"读数过期"这条判据根本没被走到（那样用例是假绿）。
  const green = checker(ctx)
  assert.equal(green.ok, true, `哈希一致的读数不许把判据拖红：${green.detail}`)
  assert.equal(green.na, undefined, '不许用 N/A 蒙过去（N/A 既不算过也不算不过）')

  // ① 绿侧（守卫态一）：哈希一致 ⇒ **可用**
  const available = assessCoverageFromStore(store, COV_BASE, ['TC-001'])
  assert.equal(available.readings.length, 1, '绿侧必须真有一条读数（空集合不许算通过）')
  assert.equal(available.outcome, 'ok', `哈希一致 ⇒ 读数可用：${describeCoverage(available)}`)
  assert.equal(available.readings[0]?.recordedArtifactHash, available.readings[0]?.actualArtifactHash, '记录哈希与现算哈希必须相等')

  // ② 改动被测产物（一个字节）⇒ 旧读数**过期**，判定点名产物路径
  writeText('artifacts/widget.txt', 'widget v2\n')
  const stale = assessCoverageFromStore(store, COV_BASE, ['TC-001'])
  assert.equal(stale.readings[0]?.outcome, 'stale', '产物改动 ⇒ 读数过期')
  assert.equal(stale.outcome, 'stale')
  assert.deepEqual(stale.offenders, ['COV-001'], '过期要逐条点名到读数 id')
  assert.deepEqual(codesOf(stale, 'readings[0].artifact', 0), ['artifact-stale'])
  assert.match(describeCoverage(stale), /artifacts\/widget\.txt/u, '过期必须点名**产物路径**')
  assert.match(describeCoverage(stale), /COV-001/u, '过期必须点名读数 id')
  assert.notEqual(stale.readings[0]?.recordedArtifactHash, stale.readings[0]?.actualArtifactHash, '两侧哈希要真的不同')

  // ③ 同一份真源进判据（守卫态二）：判红，且 detail 与补救都落到人话上、可执行
  const after = checker(ctx)
  assert.equal(after.ok, false, '产物改动后旧读数不许再让判据判绿')
  assert.match(after.detail, /artifacts\/widget\.txt/u, `判据 detail 要点名产物：${after.detail}`)
  assert.match(after.detail, /COV-001/u)
  assert.ok((after.remedy ?? '').includes('重跑'), '判红必须给可执行的补救（重跑测量并重记读数）')

  // ④ 重跑重记（把报告与产物两条哈希都刷新到当前内容、实测也更新）⇒ 判据转绿（"过期"有修复路径）
  writeText('reports/coverage.txt', 'statement coverage: 92% (92/100)\n')
  store.writeYaml(['testing', 'coverage.yml'], {
    coverage: { readings: [validReading({ measured: '92%' })], uncovered: uncoveredFixture() },
  })
  const healed = checker(ctx)
  assert.equal(healed.ok, true, `重记后判据要能恢复：${healed.detail}`)
  assert.equal(assessCoverageFromStore(store, COV_BASE, ['TC-001']).outcome, 'ok')

  // ⑤ 收窄的边界：**没记过读数**（真源不在盘上）不因此判红 —— "没记"与"记了但过期"是两件事
  const bareStore = new SdoStore(join(COV_BASE, '.sdo'))
  rmSync(join(COV_BASE, '.sdo', 'testing', 'coverage.yml'), { force: true })
  const empty = assessCoverageFromStore(bareStore, COV_BASE, ['TC-001'])
  assert.equal(empty.present, false, '真源不在盘上 ⇒ present: false')
  assert.equal(empty.readings.length, 0)
  assert.equal(empty.outcome, 'ok', '没记过读数 ⇒ 不是"过期"（不当成判红的理由）')
  const noReadings = checker(ctx)
  assert.equal(noReadings.ok, true, `没有读数不该把判据拖红（判据本来就绿）：${noReadings.detail}`)
})

test('M35-16 断言强度：哈希比对必须能区分两版产物（否则 M35-13 是恒真断言）', () => {
  greenCoverage()
  const store = new SdoStore(join(COV_BASE, '.sdo'))
  const { ctx } = coverageGateFixture()

  // **负向对照不许空转**：先证明"改一个字节就过期"这件事**在改之前**确实是红的
  writeText('artifacts/widget.txt', 'widget v2\n')
  const stale = assessCoverageFromStore(store, COV_BASE, ['TC-001'])
  assert.equal(stale.outcome, 'stale')
  assert.equal(CHECKERS['tests.passed']!(ctx).ok, false, '过期读数必须把判据判红')

  // **断言强度**：把哈希比对换成"永远相等"，上面那条断言必须失去判别力 ——
  // 这里用 `sameHash` 本身的真值表来钉死这件事（`coverage.ts` 的过期判定**只有这一处**比较键，
  // 因此"它能区分两版产物"就是"过期判定不是恒真"的充分依据）：
  const recorded = stale.readings[0]?.recordedArtifactHash ?? ''
  const actual = stale.readings[0]?.actualArtifactHash ?? ''
  assert.ok(recorded !== '' && actual !== '', '两侧哈希都要非空（空集合/空串不许算通过）')
  assert.equal(sameHash(recorded, actual), false, '两版产物的哈希必须被判为不同')
  assert.equal(sameHash(actual, actual), true, '同一份内容必须被判为相同（不是"永远返回 false"的反向变异）')
  assert.equal(sameHash(`sha256:${actual}`, actual), true, '带/不带 sha256: 前缀要认作同一份（写形不同、内容相同）')
  assert.equal(sameHash(actual.toUpperCase(), actual), true, '大小写不影响比对')
  assert.equal(sameHash('', actual), false, '空哈希一律不一致（否则"缺哈希"会静默算过）')
  assert.equal(sameHash(recorded, 'missing'), false, '产物在盘上找不到时也不许算一致')

  // 补一条**结构性**依据：过期与否只由 `sameHash` 拍板（这条断言跟着实现走，改坏了会红）
  const fresh = assessCoverageFromStore(store, COV_BASE, ['TC-001'])
  assert.equal(fresh.readings[0]?.issues.filter((issue) => issue.code === 'artifact-stale').length, 1, '过期问题码有且只有一条（不是靠别的毛病凑出来的红）')

  // 恢复成新的一版（重跑重记）⇒ 判据转绿：证明上面判的红确实来自"产物变了"，而不是别的关口
  store.writeYaml(['testing', 'coverage.yml'], { coverage: { readings: [validReading()], uncovered: uncoveredFixture() } })
  assert.equal(assessCoverageFromStore(store, COV_BASE, ['TC-001']).outcome, 'ok')
  assert.equal(CHECKERS['tests.passed']!(ctx).ok, true, '重记后判据必须转绿（否则判红另有原因，M35-13 的结论不成立）')
})

test('M35-17 报告哈希与产物哈希的落盘往返：读数记了能读回来，且改名/换值立刻判过期', () => {
  covClean()
  const store = new SdoStore(join(COV_BASE, '.sdo'))
  const journal = new Journal(store)
  writeText('reports/coverage.txt', 'statement coverage: 91% (100/110)\n')
  writeText('artifacts/widget.txt', 'widget v1\n')
  // 手写真源的原样（**不是**先经一道自动写入）——这才是真机上的路径：`.sdo/testing/coverage.yml` 由人/工具写下
  store.writeYaml(['testing', 'coverage.yml'], {
    coverage: { readings: [validReading()], uncovered: uncoveredFixture() },
  })

  // ① 落盘 → 读回 → 判定，两个哈希字段全程不丢（否则"报告哈希"与"过期判定"都无从谈起）
  const roundTrip = assessCoverageFromStore(store, COV_BASE, [KNOWN_CASE])
  assert.equal(roundTrip.readings.length, 1, '落盘往返后必须还是一条读数（空集合不许算通过）')
  assert.equal(roundTrip.outcome, 'ok', `落盘往返后仍应可用：${describeCoverage(roundTrip)}`)
  assert.equal(roundTrip.readings[0]?.recordedArtifactHash, sha256('artifacts/widget.txt'), '读回来的产物哈希要与盘上一致')
  const onDisk = readFileSync(join(COV_BASE, '.sdo', 'testing', 'coverage.yml'), 'utf8')
  assert.match(onDisk, /reportHash:/u, 'reportHash 必须是落盘字段（否则报告哈希无从核对）')
  assert.match(onDisk, /artifactHash:/u, 'artifactHash 必须是落盘字段（否则产物改动后无从判过期）')

  // ② **走真实形状闸门**（`writeValidatedTestingSource`）：写法合法 ⇒ 收下，且 `reportHash` / `artifactHash`
  //    不被写入路径吞掉。这里用**历史写法**（`artifact` 直接写哈希、没有 `artifactHash`）——
  //    TASK-035 落点一之后，形状层只核"**哪个位写什么**"（`artifact` = 产物路径、`artifactHash` = 产物哈希），
  //    历史写法是**合法写法**（形状层不许替判定层拒收一条意思正确的读数）；它算不算数由判定层说了算。
  const legacySource = { readings: [legacyReading()], uncovered: uncoveredFixture() }
  const written = writeValidatedTestingSource(
    store,
    { class: 'coverage', file: 'coverage', value: legacySource as unknown as Record<string, unknown> },
    { journal, known: { testCaseIds: [KNOWN_CASE] } },
  )
  assert.equal(written.ok, true, `写法合法的读数应当能落盘：${(written.report?.issues ?? []).map((issue) => `${issue.field}:${issue.message}`).join('；')}`)
  const rewritten = readFileSync(join(COV_BASE, '.sdo', 'testing', 'coverage.yml'), 'utf8')
  assert.match(rewritten, /reportHash: sha256:[0-9a-f]{64}/u, '过闸门后 reportHash 必须还在（不许被写入路径吞掉）')
  assert.match(rewritten, /artifactHash: /u, '过闸门后 artifactHash 这个键必须还在（不许被写入路径吞掉）')
  // 过闸门后读回来：历史写法（哈希在 `artifact`、`artifactHash` 空）如实归 `unknown` ——
  // 它**查不动**（不知道产物在哪），所以既不算可用、也不算过期。这与下面 ②b 的**新口径**是一对
  // 负向对照：写法合法（闸门收下）≠ 读数算数（判定层说了算）。
  const afterGate = assessCoverageFromStore(store, COV_BASE, [KNOWN_CASE])
  assert.equal(afterGate.readings.length, 1)
  assert.equal(afterGate.readings[0]?.outcome, 'unknown', `过闸门后读回来要如实归「判不动」：${describeCoverage(afterGate)}`)
  assert.deepEqual(codesOf(afterGate, 'readings[0].artifactHash'), ['artifact-hash-missing'])

  // ②b **哨兵转绿（TASK-035 落点一/落点三）：原来钉住缺口的那条断言，按新口径改成绿。**
  //
  //   · **它原来的意图**：TASK-016 的写范围里没有 `types.ts` / `testingShapes.ts`，而形状层当时把
  //     `artifact` **冻结**成"产物哈希"（`testingShapes.hashOf`）⇒ 判定侧已经支持的
  //     「`artifact` 写**路径** + `artifactHash` 写**哈希**」会被**形状闸门拒收**。本卡改不动形状层，
  //     于是**故意把它断言成红的**（`ok === false`，并点名 `readings[0].artifact` 的 `format`）：
  //     形状位一补上，这条断言就必然失败 —— 哨兵的作用是**叫醒下一个接手的人回来改口径**，
  //     不是"认可这个拒收行为"。
  //   · **为什么现在转绿**：TASK-035 落点一把缺口补上了（`TestingCoverageReading` 增
  //     `reportHash` / `artifactHash`；形状层 `artifact` 只核"是不是一个写下来的字符串"、哈希写法
  //     交给 `artifactHash` / `reportHash`）⇒ 形状侧与判定侧（`coverage.ts`：`pathFingerprint(artifact)`
  //     + `sameHash(artifactHash, …)`）同口径。于是把哨兵按新口径改写，并补一条**同源复核**：
  //     过闸门的那份真源，判定层必须判**可用**（`ok`），而不是"收下但判不动"。
  const pathForm = writeValidatedTestingSource(
    store,
    { class: 'coverage', file: 'coverage', value: { readings: [validReading()], uncovered: uncoveredFixture() } as unknown as Record<string, unknown> },
    { journal, known: { testCaseIds: [KNOWN_CASE] } },
  )
  assert.equal(
    pathForm.ok,
    true,
    `新口径下「artifact 写路径 + artifactHash 写哈希」必须能过形状闸门：${(pathForm.report?.issues ?? []).map((issue) => `${issue.field}[${issue.code}]`).join(' ')}`,
  )
  assert.deepEqual(
    (pathForm.report?.issues ?? []).filter((issue) => issue.field.startsWith('readings[0].artifact')),
    [],
    '新口径下这两个位都不许再报问题（旧口径在 `readings[0].artifact` 上报 format）',
  )
  const pathBack = assessCoverageFromStore(store, COV_BASE, [KNOWN_CASE])
  assert.equal(pathBack.readings.length, 1, '过闸门后必须还是一条读数（空集合不算通过）')
  assert.equal(pathBack.readings[0]?.outcome, 'ok', `同一份真源过闸门后判定层必须判可用：${describeCoverage(pathBack)}`)
  assert.equal(pathBack.outcome, 'ok', `形状层与判定层同结论（都收下/都可用）：${describeCoverage(pathBack)}`)

  // ③ 反向：把盘上的产物哈希换成别的值（模拟"读数绑的是另一版产物"）⇒ 判过期并点名产物
  store.writeYaml(['testing', 'coverage.yml'], {
    coverage: { readings: [validReading({ artifactHash: `sha256:${'c'.repeat(64)}` })], uncovered: uncoveredFixture() },
  })
  const tampered = assessCoverageFromStore(store, COV_BASE, [KNOWN_CASE])
  assert.equal(tampered.outcome, 'stale')
  assert.match(describeCoverage(tampered), /artifacts\/widget\.txt/u)

  // ④ 历史写法（`artifact` 里直接写哈希、没有 `artifactHash`）**不许判红**：意思完全正确的读数不该被拒
  store.writeYaml(['testing', 'coverage.yml'], {
    coverage: {
      readings: [validReading({ artifact: artifactHash('artifacts/widget.txt'), artifactHash: '' })],
      uncovered: uncoveredFixture(),
    },
  })
  const legacy = assessCoverageFromStore(store, COV_BASE, [KNOWN_CASE])
  assert.equal(legacy.readings[0]?.outcome, 'unknown', `历史写法不许算可用（哈希在手但查不动产物）：${describeCoverage(legacy)}`)
  assert.deepEqual(codesOf(legacy, 'readings[0].artifactHash'), ['artifact-hash-missing'], '缺的是产物路径/配对哈希，要指名道姓')
  assert.match(describeCoverage(legacy), /不知道产物在哪/u)

  // 补救文案要给出**可执行**的下一步（门禁 remedy 的原话）
  assert.match(coverageRemedy(), /sha256sum|dir:/u, '补救要给出算哈希的办法')
  assert.match(coverageRemedy(), /artifactHash/u, '补救要点名八个字段里的关键项')

  // `pathFingerprint` 的三态（判定"在不在盘上"的那一层）：文件 / 目录 / 找不到 / 越出工作区
  assert.equal(pathFingerprint(COV_BASE, 'artifacts/widget.txt'), sha256('artifacts/widget.txt'))
  assert.equal(pathFingerprint(COV_BASE, 'reports'), `dir:1:${createHash('sha256').update(`coverage.txt:${sha256('reports/coverage.txt')}`).digest('hex').slice(0, 12)}`, '目录型产物给稳定摘要')
  assert.equal(pathFingerprint(COV_BASE, 'nope.txt'), 'missing')
  assert.equal(pathFingerprint(COV_BASE, '../outside.txt'), 'outside', '越出工作区的路径要单独一态（不是"找不到"）')
})

// ——————————————————————————————————————————————————————————————
// 阈值比较收敛到一处（TASK-050 / REQ-049 + REQ-050）
//
// 为什么要有这一段：**同一个阈值、同一段实测**，在两侧各判一次 ——
//   · **覆盖读数侧**（`coverage.ts` 的 `assessReading`）：判这条读数算不算数（八项齐备 + 达阈）；
//   · **准出准则侧**（`gates.ts` 的 `exit.criteria` / `C-53`）：判项目自己声明的准则达没达标。
// 两侧判的是**同一件事**（`实测 ≥ 阈值`），却曾经各写一份 parse/compare（`parseMeasure` +
// `meetsThreshold` vs `exitMeasure` + `exitMeets`）—— 那就是"同一规则两处实现"：改一处不一定会改
// 另一处，而且**没有任何机械判据会报红**（两侧的既有用例各自都是绿的）。
// 本用例的断言面就是那句"必须有而原先没有"的判据：**两侧对同一组样本必须给出同一结论**。
//
// 与 M36-09（"不重复实现 coverage 判定"）的区别：那条守的是"**读数成立与否**（八项齐备 / 哈希 / 过期）
// 由 `coverage.ts` 一份承担"；本条守的是更下一层的"**阈值怎么比**"（解析 / 边界 / 一边带 `%` 一边不带）。
// ——————————————————————————————————————————————————————————————

/**
 * **已知的、且是规则层面的**一处不对称（本卡**不**自行统一，见它的说明与报告）。
 *
 * 只对"**阈值读不出数**"这一类成立：覆盖率侧不拿阈值当约束（这条读数仍可判 `ok`），
 * 准出准则侧 fail-closed（`measure-unparsable` ⇒ 判红）。两边都"有道理"（REQ-045 的降级口径说
 * 门禁不判"阈值定得合不合理"），所以统一它等于**改规则**，属人的决定。
 * 守卫按样本上的 `divergence` 字段逐条核对**实际**观察到的分歧 —— 不是"放宽断言"，是**把分歧钉死**：
 * 任何**新**的分歧（例如"实测读不出数"那几条）都不在这个清单里，照样判红。
 */
const KNOWN_DIVERGENCE = 'threshold-unparsable-fail-open-vs-fail-closed'

/**
 * 一组**只差阈值与实测**的样本。读数其余六项（准则 / 命令 / 报告 + 哈希 / 产物 + 哈希）恒为绿侧写法，
 * 因此两侧的结论**只可能**来自阈值比较 —— 否则红的可能是别的毛病，比对两侧就是假绿。
 * 这一组是本卡 DoD 点名的三类：**边界值 / 非法值 / 缺阈值**。
 *
 * `divergence` 一栏只给**已知的、规则层面的**那一处不对称（见 `KNOWN_DIVERGENCE`）：它的两侧结论
 * **注定不同**，守卫改成按该标记逐条核对"分歧确实发生了、且形态与登记一致"。
 */
const THRESHOLD_SAMPLES: { threshold: string; measured: string; note: string; divergence?: string }[] = [
  { threshold: '80%', measured: '91%', note: '明显超过' },
  { threshold: '80%', measured: '80%', note: '**边界**：恰好达阈（≥ 才算达标）' },
  { threshold: '80%', measured: '79%', note: '**边界**：差一个百分点 ⇒ 不达标' },
  { threshold: '0.8', measured: '0.91', note: '占比写法' },
  { threshold: '0.8', measured: '0.8', note: '**边界**：占比写法恰好达阈' },
  { threshold: '0.8', measured: '0.79', note: '**边界**：占比写法略低' },
  { threshold: '80/100', measured: '82/100', note: '分母写法' },
  { threshold: '80/100', measured: '4/5', note: '**边界**：分母写法等值（4/5 = 80/100）' },
  { threshold: '80%', measured: '0.91', note: '**混写**：阈值带 %、实测是占比' },
  { threshold: '0.8', measured: '91%', note: '**混写**：反过来' },
  { threshold: '80%', measured: '0.62', note: '**混写**：0.62 是占比 ⇒ 62% < 80%，不许当成"62 倍"' },
  { threshold: '0.8', measured: '62%', note: '**混写**：62% < 80%' },
  { threshold: ' 80 % ', measured: '  82 %  ', note: '空白无害（解析前 trim）' },
  { threshold: '0%', measured: '0%', note: '零阈值：0 ≥ 0 ⇒ 达标' },
  { threshold: '100%', measured: '100%', note: '满阈：100 ≥ 100 ⇒ 达标' },
  { threshold: '100%', measured: '99.9%', note: '**边界**：满分阈值差一点 ⇒ 不达标' },
  { threshold: '80%', measured: '差不多达标', note: '**非法值**：实测读不出数 ⇒ 判不动' },
  { threshold: '八成', measured: '91%', note: '**非法值**：阈值读不出数（两侧规则不同，见 KNOWN_DIVERGENCE）', divergence: KNOWN_DIVERGENCE },
  { threshold: '80%', measured: '82/0', note: '**非法值**：分母为 0 ⇒ 判不动（不得当成 0）' },
  { threshold: '80%', measured: '', note: '**缺阈值 / 缺实测**：实测为空 ⇒ 判不动' },
  { threshold: '', measured: '91%', note: '**缺阈值**：阈值为空 ⇒ 判不动（不是"达标"）' },
]

/**
 * 覆盖读数侧的三态裁定：`true` 达标 / `false` 不达标 / `undefined` 判不动。
 *
 * 读数**只认这两个结构化码**，不另读一行文案：`measured-below-threshold`（不达标）与
 * 整体 `outcome`（`invalid` = 这条读数不成立 ⇒ 阈值结论无从谈起）。
 */
function coverageVerdict(assessment: CoverageAssessment): boolean | undefined {
  const reading = assessment.readings[0]
  if (reading === undefined) return undefined
  if ((reading.issues ?? []).some((issue) => issue.code === 'measured-below-threshold')) return false
  return assessment.outcome === 'ok' ? true : undefined
}

/** 准出准则侧的三态裁定（取自**逐条现算**的 `verdict` + 稳定码 `reason`，不读人话）。 */
function exitSideVerdict(criterion: { verdict: string; reason: string } | undefined): boolean | undefined {
  if (criterion === undefined) return undefined
  if (criterion.verdict === 'pass') return true
  if (criterion.verdict !== 'fail') return undefined
  return criterion.reason === 'below-threshold' ? false : undefined
}

/**
 * **两条路径**（两侧判据**实际**会走到的那两条）下的裁定对照 —— 这是本用例的核心断言面。
 *
 * 为什么必须分两条路径而不是"一个预期值"：两侧的**实测来源**不同，因此对同一对原文走的是两条路：
 *   · **覆盖读数侧**（`coverage.ts` 的 `assessReading`）：阈值为空 ⇒ `threshold-missing`（判不动）；
 *     否则读实测，**实测达阈 ⇒ 该读数可用**，不达阈 ⇒ `measured-below-threshold`（该读数不成立）；
 *   · **准出准则侧**（`gates.ts` 的 `exit.criteria`）：阈值为空 ⇒ 直接 `fail / threshold-missing`（**不取实测**）；
 *     否则先看**读数成立与否**（不成立 ⇒ `fail / reading-invalid`，此时两边都不比大小），
 *     读数可用 ⇒ 拿**项目声明的阈值**与实测比 ⇒ `pass / ok` 或 `fail / below-threshold`。
 * 两条路径各自都必须**同一结论**，而它们合起来才覆盖全部样本（含阈值/实测为空的那几条）。
 */
function bothSidesAgree(
  readingSide: CoverageAssessment,
  criterion: { verdict: string; reason: string } | undefined,
): { coverage: boolean | undefined; exit: boolean | undefined } {
  // 准则侧给出 `pass/fail` 时，它的结论由**覆盖率侧的那条读数**背书：`ok` ⇒ 比出来的达标、
  // `reading-invalid` ⇒ 读数本来就不成立。但"不成立"**不等于"不达标"**（实测读不出数也是不成立），
  // 因此这里判的是**码**：只有 `measured-below-threshold` 才是"比出来发现不达标"，其余一律判不动。
  const exit = criterion?.verdict === 'fail' && criterion.reason === 'reading-invalid'
    ? (readingSide.readings[0]?.issues ?? []).some((issue) => issue.code === 'measured-below-threshold') ? false : undefined
    : exitSideVerdict(criterion)
  return { coverage: coverageVerdict(readingSide), exit }
}

/** 盘上源码（源码面的"两侧取同一实现"断言用；静态读，不执行）。 */
function sourceOf(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

test('M35-18 阈值比较收敛：同一组样本在「覆盖读数侧」与「准出准则侧」给出同一结论（含边界 / 非法 / 缺阈值）', () => {
  // 盘上夹具：报告与产物**真在盘上**（哈希现算），这样两侧的结论只可能来自阈值比较
  greenCoverage()

  // 先证夹具本身是绿的（读数八项齐备）：否则下面任何一条红都可能来自别的毛病，比对两侧就没有判别性
  const base = assessHere({ readings: [validReading()] })
  assert.equal(base.readings.length, 1, '夹具必须有且只有一条读数（空集合不许算通过）')
  assert.equal(base.outcome, 'ok', `夹具的其余六项必须齐备：${describeCoverage(base)}`)

  const rows: string[] = []
  for (const [index, sample] of THRESHOLD_SAMPLES.entries()) {
    // ① 覆盖读数侧：同一份**盘上**夹具（报告 / 产物都在、哈希现算），只换阈值与实测两个字段
    const readingSide = assessHere({ readings: [validReading({ threshold: sample.threshold, measured: sample.measured })] })
    // ② 准出准则侧：**同一对原文**过 `assessExitCriteria` 的现算（准则侧只按覆盖率侧的结论 + 共享的比大小走）
    const exit = assessExitCriteria({
      criteria: [{ id: 'C-1', criterion: 'statement', threshold: sample.threshold }],
      coverage: readingSide,
    })
    const verdict = exit.criteria[0]
    const sides = bothSidesAgree(readingSide, verdict)
    const shared = meetsThresholdText(sample.threshold, sample.measured)
    const where = `样本 ${index}（阈值「${sample.threshold}」/ 实测「${sample.measured}」，「${sample.note}」）`
    const observed = `读数侧 ${String(sides.coverage)} / 准则侧 ${String(sides.exit)}`
      + `，reason=${verdict?.reason ?? '（无）'}，码=${codesOf(readingSide, 'readings[0].measured').join(',') || '（无）'}`

    if (sample.divergence === undefined) {
      // ③ 两侧逐条比对：**结论必须相同**（不各写一份期望 —— 期望只有一个：两侧一致）
      assert.equal(sides.coverage, sides.exit, `${where}：两侧结论必须一致（${observed}）`)
      // ④ **同一份共享实现**（TASK-050 落点一）对同一对原文的三态裁定必须与两侧都一致 ⇒
      //    "两侧调用同一实现"不只是源码里的一行 import，而是可观察的：它等于两侧的结论。
      assert.deepEqual(shared, sides.coverage, `${where}：共享实现（coverage.ts 的 meetsThresholdText）必须与读数侧同结论`)
      assert.deepEqual(shared, sides.exit, `${where}：共享实现必须与准出准则侧同结论（准则侧不许另有一套 parse/compare）`)
    } else {
      // ③' **已知分歧**：不许"统一"，只许**逐条钉死它的形态** —— 一旦形态变了（例如有人顺手把
      //     覆盖率侧也改成 fail-closed），这条断言立刻红，逼下一棒回来看这里的分歧需不需要改卡。
      assert.equal(sample.divergence, KNOWN_DIVERGENCE, `${where}：样本只许标登记在案的那一处分歧`)
      assert.equal(
        sides.coverage,
        true,
        `${where}：覆盖率侧对"阈值读不出数"的现状是**不拿它当约束**（读数仍可 ok）—— 现状一变就该回来改这张单子（${observed}）`,
      )
      assert.equal(sides.exit, undefined, `${where}：准出准则侧的现状是 fail-closed（measure-unparsable ⇒ 判红），不是"达标/不达标"（${observed}）`)
      assert.equal(shared, undefined, `${where}：共享的比大小原语在两侧都无法解析时一律判不动`)
      assert.equal(
        verdict?.reason,
        'measure-unparsable',
        `${where}：准则侧走的必须是"阈值读不出数"这条路（不是别的毛病凑出来的红）`,
      )
      rows.push(`| ${index} | ${sample.threshold} | ${sample.measured} | ${sample.note} | ${String(shared)} | ⚠ 已知分歧：${sample.divergence} |`)
      continue
    }

    rows.push(`| ${index} | ${sample.threshold === '' ? '（空）' : sample.threshold} | ${sample.measured === '' ? '（空）' : sample.measured} | ${sample.note} | ${String(shared)} |`)
  }

  // ⑤ **判别性不许空转**：样本集里三态都要出现，否则"全部一致"可能只是因为两侧**永远同一种结论**
  const comparable = THRESHOLD_SAMPLES.filter((sample) => sample.divergence === undefined)
  assert.equal(comparable.length, THRESHOLD_SAMPLES.length - 1, '已知分歧有且只有一条（多于一条就是"随手续期"，得回来看为什么）')
  const verdicts = comparable.map((sample) => String(meetsThresholdText(sample.threshold, sample.measured)))
  assert.equal(
    new Set(verdicts).size,
    3,
    `可比对的样本必须同时覆盖"达标 / 不达标 / 判不动"三态（实际 ${new Set(verdicts).size} 种）：\n${rows.join('\n')}`,
  )

  // ⑥ 边界与三态各钉一条**逐字**的原文（是**断言强度**，不是第二套期望：它们与两侧比对用的是同一份
  //    样本原文；不把口径写明，实现被改成"一律达标"也照样算过）
  assert.equal(meetsThresholdText('80%', '80%'), true, '恰好达阈要算达标（≥ 的边界）')
  assert.equal(meetsThresholdText('80%', '79.999%'), false, '差一丁点也算不达标（不许四舍五入宽松）')
  assert.equal(meetsThresholdText('80/100', '4/5'), true, '分母写法的等值要认（4/5 = 0.8）')
  assert.equal(meetsThresholdText('0.8', '0.8'), true, '占比写法恰好达阈')
  assert.equal(meetsThresholdText('80%', '82/0'), undefined, '分母为 0 ⇒ 判不动（不是"0 达标"）')
  assert.equal(meetsThresholdText('80%', ''), undefined, '实测为空 ⇒ 判不动')
  assert.equal(meetsThresholdText('', '91%'), undefined, '阈值为空 ⇒ 判不动（不是"不达标"，也不是"达标"）')
  assert.equal(meetsThresholdText('八成', '91%'), undefined, '阈值读不出数 ⇒ 判不动')
  assert.equal(meetsThresholdText('80%', '差不多达标'), undefined, '实测读不出数 ⇒ 判不动')

  // ⑦ **源码面**：两侧必须取**同一个**共享实现（防的是"收敛一次，下一个人又抄回去"——
  //    纯运行时断言看不见一份**没用上**的平行实现，而那种重复正是本卡要消灭的东西）
  const coverageSrc = sourceOf('src/domain/coverage.ts')
  const gatesSrc = sourceOf('src/domain/gates.ts')
  assert.match(coverageSrc, /export function meetsThresholdText\(/u, '共享实现必须在 coverage.ts 里导出（唯一一份）')
  assert.match(gatesSrc, /meetsThresholdText/u, 'gates.ts 必须引用共享实现')
  assert.match(
    gatesSrc,
    /import\s*\{[^}]*meetsThresholdText[^}]*\}\s*from\s*'\.\/coverage\.js'/u,
    'gates.ts 只能从 coverage.ts import 共享实现（不许另起一份）',
  )
  // 旧的两份私有实现的特征串（`exitMeasure` / `exitMeets`）一个都不许剩
  assert.doesNotMatch(gatesSrc, /function exitMeasure\(/u, 'gates.ts 不许再留私有的 `exitMeasure`（这就是被收敛掉的那一份）')
  assert.doesNotMatch(gatesSrc, /function exitMeets\(/u, 'gates.ts 不许再留私有的 `exitMeets`')
  assert.doesNotMatch(gatesSrc, /percent: text\.includes\('%'\)/u, 'gates.ts 里不许再留第二份"取数 + 看有没有 %"的解析体')
  // 覆盖读数侧也走的是同一份（否则共享实现只是"准则侧在用"，收敛没落地）
  assert.match(coverageSrc, /meetsThresholdText\(/u, 'coverage.ts 自己的读数判定也必须走共享实现（不许旁路）')
})

/**
 * **TASK-053（来源 CT-006 ③ 的 schema 示例 `criterion: 'branch'`）：读数侧准则别名跨层同结论。**
 *
 * ## 病灶（契约与实现相扭）
 *
 * CT-006 ③ 把覆盖读数的形状写成 `coverage.yml { criterion, … }`，**示例逐字写着**
 * `criterion: 'branch'`；而读数侧的两层都用**裸枚举**（`COVERAGE_CRITERIA` /
 * `TESTING_COVERAGE_CRITERIA`）拒它 —— 契约给的例子，落到盘上被判非法枚举。
 * 内容层（`testDesignWhitebox.canonicalCriterion`）早就有唯一一张别名表
 * （`branch` / `branch-coverage` / `decision_coverage` → `decision`），读数侧只要**调它**即可，
 * 不该再抄一份枚举或映射表。
 *
 * ## 这条守卫钉住什么
 *
 * · 正例：`branch` ⇒ **形状层（落盘闸门）与判定层（读数判定）都收下**，且判定层**归一成 `decision`**
 *   （带出来的取值与中文标签都是规范值那一份，未达阈值时点名量的也是规范口径）；
 * · 逐值等价：`形状层收下 ⇔ 判定层收下 ⇔ canonicalCriterion 有解（或本就在词表里）`；
 * · 反例（防"两边一起放空"）：`coverage` / `分支` 这类**真非法**取值两层都拒、各自点名到同一位；
 * · 源码面：别名表只有内容层一份，读数侧两层都只是调用它（谁再写一张表，这里就红）。
 */
test('M35-19 读数侧准则别名：写 branch ⇒ 形状层与判定层同结论（都收下并归一成 decision）；非法取值两层都拒（CT-006 ③）', () => {
  greenCoverage()
  const known = { testCaseIds: [KNOWN_CASE] }

  /** 形状层（落盘闸门）对 `readings[0].criterion` 这一位的结论。 */
  const shapeOf = (criterion: string): { accepted: boolean; codes: string[]; message: string } => {
    const reading = { ...validReading({ criterion }) } as unknown as Record<string, unknown>
    const report = validateTestingSource('coverage', { readings: [reading], uncovered: [] }, known)
    const mine = report.issues.filter((issue) => issue.field === 'readings[0].criterion')
    return { accepted: mine.length === 0, codes: mine.map((issue) => issue.code), message: mine.map((issue) => issue.message).join(' ｜ ') }
  }
  /** 判定层（`assessCoverage`）对同一位的结论（并把它**归一后**的取值带出来）。 */
  const judgedOf = (criterion: string): { accepted: boolean; codes: string[]; normalized: string } => {
    const assessment = assessHere({ readings: [validReading({ criterion })] })
    const reading = assessment.readings[0]
    const mine = (reading?.issues ?? []).filter((issue) => issue.field === 'readings[0].criterion')
    return { accepted: mine.length === 0, codes: mine.map((issue) => issue.code), normalized: reading?.criterion ?? '' }
  }

  // ① 判别性基线：两层对**规范取值**都不报这一位（否则下面的"收下"可能只是"这一位根本没人看"）
  assert.equal(shapeOf('decision').accepted, true, '规范取值 decision 在形状层不许报问题（基线非空）')
  assert.equal(judgedOf('statement').accepted, true, '规范取值 statement 在判定层不许报问题（基线非空）')

  // ② 本卡正例：CT-006 ③ 的示例取值 branch ⇒ **两层都收下**
  const branchShape = shapeOf('branch')
  const branchJudged = judgedOf('branch')
  assert.equal(
    branchShape.accepted,
    true,
    `形状层必须收下 CT-006 ③ 的示例取值 branch（契约给的例子不该被判非法）：${branchShape.codes.join(',')} ${branchShape.message}`,
  )
  assert.equal(branchJudged.accepted, true, `判定层必须收下 branch：${branchJudged.codes.join(',')}`)
  // 收下不只是"不报错"：判定层把它**归一成 decision**（别名表只有一份 —— 内容层的 canonicalCriterion）
  assert.equal(canonicalCriterion('branch'), 'decision', '别名表在内容层只有一份：branch → decision')
  assert.equal(branchJudged.normalized, 'decision', 'branch 必须被归一成仓内规范取值 decision（不是原样带着走）')
  assert.equal(coverageCriterionLabel(branchJudged.normalized), coverageCriterionLabel('decision'), '归一之后取的是 decision 那一份人话标签')
  // 归一真的落在**结论链**上：别名读数没达阈值时，回执里量的是规范口径（其余判定照旧走，不是"整条放行"）
  const belowAlias = assessHere({ readings: [validReading({ criterion: 'branch', measured: '62%' })] })
  assert.deepEqual(codesOf(belowAlias, 'readings[0].measured'), ['measured-below-threshold'], '别名收下后阈值判定照旧现算')
  assert.match(describeCoverage(belowAlias), new RegExp(coverageCriterionLabel('decision'), 'u'), '判红回执里点名的是归一后的口径')

  // ③ **逐值等价**：两层同结论，且形状层的结论等于"词表认它 ∨ 别名表有解"
  const values = [
    'statement', 'decision', 'condition', 'decision-condition', 'mc-dc', 'path', 'def-use',
    'branch', 'branch-coverage', 'decision_coverage',
    'coverage', '分支', '', '   ',
  ]
  for (const raw of values) {
    const shape = shapeOf(raw)
    const judged = judgedOf(raw)
    const canonical = canonicalCriterion(raw)
    const expected = canonical !== undefined || (COVERAGE_CRITERIA as readonly string[]).includes(raw.trim())
    assert.equal(
      shape.accepted,
      judged.accepted,
      `「${raw}」同一份真源在两层必须同结论：形状=${shape.accepted}（${shape.codes.join(',')}）判定=${judged.accepted}（${judged.codes.join(',')}）`,
    )
    assert.equal(
      shape.accepted,
      expected,
      `「${raw}」收下 ⇔ 在词表里或有规范值（别名表只有一份，闸门不许另写枚举）：实际形状=${shape.accepted} 规范值=${canonical ?? '（无）'}`,
    )
    if (canonical !== undefined) {
      assert.equal(judged.normalized, canonical, `「${raw}」判定层归一到的是 canonicalCriterion 给的同一个值`)
    }
  }

  // ④ 反例（防"两边一起放空"：两层同时收下一切也满足不了这条）：真非法取值两层都拒、各自点名到同一位
  const bogusShape = shapeOf('coverage')
  const bogusJudged = judgedOf('coverage')
  assert.equal(bogusShape.accepted, false, '「coverage」既不在词表也不是别名 ⇒ 形状层必须拒（收下一切 = 放空）')
  assert.equal(bogusJudged.accepted, false, '判定层同样必须拒')
  assert.deepEqual(bogusShape.codes, ['enum'], '形状层判红用形状层自己的码（它的公共面）')
  assert.deepEqual(bogusJudged.codes, ['criterion-unknown'], '判定层判红用它自己的码')
  for (const legal of COVERAGE_CRITERIA) {
    assert.match(bogusShape.message, new RegExp(legal, 'u'), `形状层判红要点名合法集合里的「${legal}」：${bogusShape.message}`)
  }
  assert.equal(shapeOf('分支').accepted, false, '中文标签「分支」不是取值（词表与别名表都不认）⇒ 形状层拒')
  assert.equal(judgedOf('分支').accepted, false, '判定层同样拒')
  // 缺准则与非法取值是两件事：两层都拒，但各自的码不同（空串走"必填/缺失"，不是"枚举非法"）
  assert.deepEqual(shapeOf('').codes, ['empty'], '形状层对空串报 empty')
  assert.deepEqual(judgedOf('').codes, ['criterion-missing'], '判定层对空准则报 criterion-missing')

  // ⑤ **源码面**：别名表只有内容层一份 —— 读数侧两层都只是"调它"，谁再抄一张表这里就红
  const shapesSrc = sourceOf('src/domain/testingShapes.ts')
  const covSrc = sourceOf('src/domain/coverage.ts')
  assert.match(covSrc, /export function canonicalReadingCriterion\(/u, '读数侧规范化入口由 coverage.ts 导出（唯一一份）')
  assert.match(covSrc, /canonicalCriterion\(/u, 'coverage.ts 必须复用内容层的 canonicalCriterion')
  assert.match(shapesSrc, /canonicalReadingCriterion/u, '形状层的覆盖读数口径必须走同一份规范化入口')
  assert.match(shapesSrc, /from '\.\/coverage\.js'/u, '形状层只能从 coverage.ts 取这一份（与判定侧同源）')
  assert.doesNotMatch(shapesSrc, /branch\s*:\s*'decision'/u, '形状层不许再写第二张别名映射表')
  assert.doesNotMatch(covSrc, /branch\s*:\s*'decision'/u, '判定层也不许再写第二张别名映射表')
})
