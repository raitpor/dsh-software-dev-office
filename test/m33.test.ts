/**
 * 增量 3：**实现阶段方法包**（Half 1 = 词表/落盘/选择）。
 *
 * 这一层最容易犯的错是"看起来在管，其实没有据"：
 *   · 决策依据（`derivedFrom`）必须**至少一条能被机械核对**，否则"模型自选"就是暗箱；
 *   · 坏结构必须**判 invalid 并给出原因**，不得静默兜底成"没选包"；
 *   · 红→绿时序与契约冻结都必须从 **journal 现算**（不许在 yml 里再写一份）。
 * 所以每个方向都断言：该拒的拒、该过的过，且拒的理由要点到具体条目。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { PLAN_ACTIONS } from '../src/types.js'
import { claim, report } from '../src/domain/collab.js'
import { CHECKERS } from '../src/domain/gates.js'
import { apply } from '../src/index.js'
import type { Context } from '@deepseek-ai/cordis'
import { listRoleCards } from '../src/domain/roles.js'
import type { GateContext } from '../src/domain/gates.js'
import { countCjkLiterals } from '../src/domain/langScan.js'
import {
  claimGaps,
  doneGaps,
  doneNaNotes,
  readContractTests,
  readConstructionProfile,
  readMutations,
  recordContractTest,
  recordMutation,
  redGreenGaps,
  validateDerivation,
  writeConstructionProfile,
} from '../src/domain/construction.js'
import {
  collectKnownFacts,
  emptyKnownFacts,
  rawTestDesignText,
  readTestDesign,
  testDesignCoverage,
  testDesignFingerprint,
  testDesignTraceability,
  validateTestDesign,
  writeValidatedTestDesign,
  TEST_DESIGN_PATH,
  TEST_DESIGN_ROOT_KEY,
} from '../src/domain/testDesign.js'
import type {
  TestDesignReport,
  TestDesignTechniqueCoverage,
  TestDesignWriteResult,
  ValidateTestDesignOptions,
} from '../src/domain/testDesign.js'
import type { SdoConfig } from '../src/config.js'
import type { ConstructionProfile } from '../src/domain/construction.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm33')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function writeCard(id: string, requirements: string[] = [], evidenceRequired: TaskCard['evidenceRequired'] = ['artifact']): TaskCard {
  const card: TaskCard = {
    id,
    title: `${id} 的标题`,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired,
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

function writeRequirement(id: string, kind: string): void {
  store.writeYaml(['requirements', `${id}.yml`], { requirement: { id, title: id, kind, statement: 's', rationale: 'r' } })
}

function writeContract(id: string, requires: string[]): void {
  store.writeYaml(['contracts', `${id}.yml`], {
    contract: { id, name: id, kind: 'http', producer: 'a', consumer: 'b', schema: 'x', failureSemantics: {}, requires, at: '' },
  })
}

function writeCase(id: string, requirement: string): void {
  store.writeYaml(['tests', `${id}.yml`], { testCase: { id, title: id, kind: 'unit', requirement, steps: ['s'], expected: 'e', at: '' } })
}

function writeResult(id: string, caseId: string, status: 'pass' | 'fail' | 'skip'): void {
  // 与 `recordTestResult` 同路径：**文件 + journal 事件**（少任何一半都会被来源可追溯检查抓到，见 M33-12）
  store.writeYaml(['tests', 'results', `${id}.yml`], { result: { id, caseId, status, evidence: 'e', at: '' } })
  journal.append('test/recorded', { id, caseId, status })
}

/** 只写文件、不写 journal：用来测"来源不可追溯"这一路。 */
function writeResultFileOnly(id: string, caseId: string, status: 'pass' | 'fail' | 'skip'): void {
  store.writeYaml(['tests', 'results', `${id}.yml`], { result: { id, caseId, status, evidence: 'e', at: '' } })
}

function profileOf(overrides: Partial<ConstructionProfile> = {}): ConstructionProfile {
  return {
    version: 1,
    decidedAt: '2026-10-03T00:00:00.000Z',
    decidedBy: 'office',
    packages: ['tdd'],
    scope: 'all',
    derivedFrom: ['scale=normal'],
    reason: 'r',
    exempt: [],
    history: [],
    ...overrides,
  }
}

test('M33-01 落盘与读回：字段保真；坏结构判 invalid 且给出原因（不静默当成"没选包"）', () => {
  assert.equal(readConstructionProfile(store).status, 'missing', '没写过就是 missing')

  writeConstructionProfile(store, profileOf({ packages: ['tdd', 'contract-first'], scope: ['TASK-001'], exempt: [{ task: 'TASK-001', check: 'tdd-red-green-missing', why: '纯文档卡', approvedBy: '用户', impact: '夹具' }] }))
  const read = readConstructionProfile(store)
  assert.equal(read.status, 'ok')
  assert.deepEqual(read.profile?.packages, ['tdd', 'contract-first'])
  assert.deepEqual(read.profile?.scope, ['TASK-001'])
  assert.equal(read.profile?.exempt[0]?.why, '纯文档卡')

  // 未知包 ⇒ invalid（不是"忽略这一条"）
  store.writeYaml(['construction', 'profile.yml'], { profile: { packages: ['nope'], scope: 'all', derivedFrom: ['scale=normal'] } })
  const bad = readConstructionProfile(store)
  assert.equal(bad.status, 'invalid')
  assert.ok(bad.problems.some((item) => item.includes('nope')), `要指名未知的包：${bad.problems.join('；')}`)

  // 豁免缺理由 ⇒ invalid（豁免必须可追责）
  store.writeYaml(['construction', 'profile.yml'], { profile: { packages: ['tdd'], scope: 'all', derivedFrom: ['scale=normal'], exempt: [{ task: 'TASK-001', check: 'tdd-mutation-missing' }] } })
  const noReason = readConstructionProfile(store)
  assert.equal(noReason.status, 'invalid')
  assert.ok(noReason.problems.some((item) => item.includes('exempt')), noReason.problems.join('；'))
})

test('M33-02 决策依据必须可核对：空/全不可核对/与事实不符都拒，对得上才算 checked', () => {
  writeRequirement('REQ-001', 'functional')
  writeContract('CT-001', ['REQ-001'])
  writeContract('CT-002', ['REQ-001'])

  const empty = validateDerivation(store, [])
  assert.ok(empty.problems.length > 0, '空依据要拒')

  const uncheckedOnly = validateDerivation(store, ['stack=typescript'])
  assert.deepEqual(uncheckedOnly.unchecked, ['stack=typescript'], '非核对项如实记下')
  assert.ok(uncheckedOnly.problems.some((item) => item.includes('至少要有一条')), `全不可核对要拒：${uncheckedOnly.problems.join('；')}`)

  const wrongCount = validateDerivation(store, ['contractCount=5'])
  assert.ok(wrongCount.problems.some((item) => item.includes('实际是 2')), `数量不符要拒并给出实际值：${wrongCount.problems.join('；')}`)

  const wrongKind = validateDerivation(store, ['reqKind=perf(REQ-001)'])
  assert.ok(wrongKind.problems.some((item) => item.includes('functional')), `类型不符要拒：${wrongKind.problems.join('；')}`)

  const missing = validateDerivation(store, ['reqKind=functional(REQ-999)'])
  assert.ok(missing.problems.some((item) => item.includes('REQ-999')), '需求不存在要拒')

  const okDerivation = validateDerivation(store, ['reqKind=functional(REQ-001)', 'contractCount=2', 'stack=typescript'])
  assert.deepEqual(okDerivation.problems, [])
  assert.deepEqual(okDerivation.checked, ['reqKind=functional(REQ-001)', 'contractCount=2'])
  assert.deepEqual(okDerivation.unchecked, ['stack=typescript'])
})

test('M33-03 office 决定：非法输入整次拒绝（不写盘）；成功写 yml + journal；复议追加历史', () => {
  writeRequirement('REQ-001', 'functional')
  writeCard('TASK-001', ['REQ-001'])
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 'cockpit', cwd: BASE }

  const rejected = office.decideConstructionProfile(call, {
    packages: [],
    scope: 'all',
    derivedFrom: ['reqKind=functional(REQ-001)'],
    reason: '',
    exempt: [],
    by: 'office',
  })
  assert.equal(rejected.ok, false)
  assert.equal(readConstructionProfile(store).status, 'missing', '拒绝时不得留下半份 profile')

  const unknownExempt = office.decideConstructionProfile(call, {
    packages: ['tdd'],
    scope: 'all',
    derivedFrom: ['reqKind=functional(REQ-001)'],
    reason: '',
    exempt: [{ task: 'TASK-001', check: 'nope-check', why: 'x', approvedBy: '用户', impact: '夹具' }],
    by: 'office',
  })
  assert.equal(unknownExempt.ok, false, '未知检查码要拒')

  const first = office.decideConstructionProfile(call, {
    packages: ['tdd'],
    scope: 'all',
    derivedFrom: ['reqKind=functional(REQ-001)'],
    reason: '有需求就该有测试先行',
    exempt: [],
    by: 'office',
  })
  assert.equal(first.ok, true)
  assert.deepEqual(first.ok ? first.checked : [], ['reqKind=functional(REQ-001)'])
  assert.equal(readConstructionProfile(store).profile?.reason, '有需求就该有测试先行')

  const again = office.decideConstructionProfile(call, {
    packages: ['tdd', 'contract-first'],
    scope: ['TASK-001'],
    derivedFrom: ['reqKind=functional(REQ-001)'],
    reason: '补上契约优先',
    exempt: [],
    by: 'office',
  })
  assert.equal(again.ok, true)
  const after = readConstructionProfile(store).profile
  assert.deepEqual(after?.packages, ['tdd', 'contract-first'], '复议覆盖当前选择')
  assert.equal(after?.history.length, 1, '复议把上一次记进历史')
  const journalTypes = journal.read().events.map((event) => event.type)
  assert.equal(journalTypes.filter((type) => type === 'plan/profile-decided').length, 2, '每次决定都落一条 journal（append-only）')
})

test('M33-04 claim 关：契约必须先冻结（冻结序号 < 认领序号），豁免与未选包都要正确绕过', () => {
  writeRequirement('REQ-001', 'functional')
  writeContract('CT-001', ['REQ-001'])
  const card = writeCard('TASK-001', ['REQ-001'])
  const withPackage = profileOf({ packages: ['contract-first'] })

  // ① 没冻结 ⇒ 拒
  const noFreeze = claimGaps(store, journal, card, 10, withPackage)
  assert.equal(noFreeze.length, 1)
  assert.equal(noFreeze[0]?.check, 'contract-not-frozen')
  assert.ok(noFreeze[0]?.detail.includes('CT-001'), '要点到具体契约')

  // ② 冻结**在认领之前** ⇒ 过（严格晚于才算违规）
  journal.append('design/confirmed', { target: 'CT-001', basis: 'review', by: 'cockpit' })
  const frozenAt = journal.read().events.length
  assert.deepEqual(claimGaps(store, journal, card, frozenAt + 1, withPackage), [], '冻结序号 < 认领序号 ⇒ 过')
  // 边界：**同一条**不算"先冻结"（冻结与认领同一序号 ⇒ 拒）
  assert.equal(claimGaps(store, journal, card, frozenAt, withPackage).length, 1, '序号相等也要拒')

  // ③ 冻结晚于认领 ⇒ 拒：另起一张卡 + 一个"认领之后才冻结"的契约
  writeRequirement('REQ-002', 'functional')
  writeContract('CT-002', ['REQ-002'])
  const card2 = writeCard('TASK-002', ['REQ-002'])
  const claimSeq = journal.read().events.length + 1
  journal.append('design/confirmed', { target: 'CT-002', basis: 'review', by: 'cockpit' })
  assert.equal(claimGaps(store, journal, card2, claimSeq, withPackage).length, 1, '契约在认领之后才冻结 ⇒ 拒')

  // ④ 豁免 ⇒ 跳过；⑤ 没选 contract-first ⇒ 不检查
  const exempt = profileOf({ packages: ['contract-first'], exempt: [{ task: 'TASK-002', check: 'contract-not-frozen', why: '契约在别处冻结', approvedBy: '用户', impact: '夹具' }] })
  assert.deepEqual(claimGaps(store, journal, card2, claimSeq, exempt), [])
  assert.deepEqual(claimGaps(store, journal, card2, claimSeq, profileOf({ packages: ['tdd'] })), [], '没选这个包就不检查')
  assert.deepEqual(claimGaps(store, journal, card2, claimSeq, undefined), [])
})

test('M33-05 红→绿时序读结果文件、按 id 数字序（与 C7 同源）：只记 pass 不算 TDD；顺序反了也不算', () => {
  const card = writeCard('TASK-001', ['REQ-001', 'REQ-002'])
  writeCase('TC-001', 'REQ-001')
  writeCase('TC-002', 'REQ-002')

  // REQ-001：fail → pass ⇒ 过；REQ-002：只 pass（没红过）⇒ 拒
  writeResult('TR-001', 'TC-001', 'fail')
  writeResult('TR-002', 'TC-001', 'pass')
  writeResult('TR-003', 'TC-002', 'pass')
  const gaps = readGaps(card)
  assert.equal(gaps.length, 1)
  assert.ok(gaps[0]?.detail.includes('REQ-002'), `只该报 REQ-002：${gaps.map((item) => item.detail).join('；')}`)
  assert.ok(gaps[0]?.detail.includes('先 fail 后 pass'), '理由要说清时序口径')

  // REQ-002 换一条**新的、先红后绿**的用例 ⇒ 需求被满足（旧用例的"先绿"不能被追溯改写）
  writeCase('TC-004', 'REQ-002')
  writeResult('TR-004', 'TC-004', 'fail')
  writeResult('TR-005', 'TC-004', 'pass')
  assert.deepEqual(readGaps(card), [])

  // 第一条就是 pass、之后才 fail ⇒ **第一条 pass 已经"绿过"**，不算"先红后绿"
  const case3 = writeCard('TASK-002', ['REQ-003'])
  writeCase('TC-003', 'REQ-003')
  writeResult('TR-006', 'TC-003', 'pass')
  writeResult('TR-007', 'TC-003', 'fail')
  assert.equal(readGaps(case3).length, 1, '先 pass 后 fail 不算"先红后绿"')

  // 需求没有用例 ⇒ 拒
  const noCase = writeCard('TASK-003', ['REQ-004'])
  assert.equal(readGaps(noCase).length, 1)

  function readGaps(target: TaskCard) {
    return redGreenGaps(store, journal, target)
  }
})

test('M33-06 done 关：critical 要变异自证、contract-first 要契约测试；豁免与范围都要正确绕过', () => {
  const card = writeCard('TASK-001', [])
  const tdd = profileOf({ packages: ['tdd'] })

  // 非 critical：不要变异证据
  assert.deepEqual(doneGaps(store, journal, card, tdd, { scale: 'normal' }), [])

  // critical：缺 ⇒ 拒
  const missing = doneGaps(store, journal, card, tdd, { scale: 'critical' })
  assert.equal(missing.length, 1)
  assert.equal(missing[0]?.check, 'tdd-mutation-missing')

  // N3（评审）：`tool` 为空的记录不算数（证不了"用什么杀的"）
  recordMutation(store, { task: 'TASK-001', tool: '', target: '', killed: 1, survived: 0, at: '' })
  assert.equal(doneGaps(store, journal, card, tdd, { scale: 'critical' }).length, 1, 'tool 为空不算变异自证')

  // 记一条 killed=1（tool 非空）⇒ 过
  recordMutation(store, { task: 'TASK-001', tool: 'node --test', target: 'lib/x.js', killed: 1, survived: 0, at: '' })
  assert.equal(readMutations(store).length, 2, '落盘可读回（含上一条 tool 为空的）')
  assert.deepEqual(doneGaps(store, journal, card, tdd, { scale: 'critical' }), [])

  // 豁免 ⇒ 跳过
  const other = writeCard('TASK-002', [])
  const exempt = profileOf({ packages: ['tdd'], exempt: [{ task: 'TASK-002', check: 'tdd-mutation-missing', why: '纯文档卡', approvedBy: '用户', impact: '夹具' }] })
  assert.deepEqual(doneGaps(store, journal, other, exempt, { scale: 'critical' }), [], '豁免按卡+检查码生效')
  const third = writeCard('TASK-003', [])
  assert.equal(doneGaps(store, journal, third, exempt, { scale: 'critical' }).length, 1, '豁免只对写明的卡生效（TASK-003 没有豁免、也没有变异记录）')

  // contract-first：**本卡挂着一份契约**却缺契约测试 ⇒ 拒
  //
  // **TASK-056（判据自适性）**：这条夹具原先用 `writeCard('TASK-001', [])` —— 那张卡
  // **没有需求、也没有契约对象**，按新口径属于"N/A（本卡没有对应对象）"，不该再判红。
  // 现改成**真正挂在契约上**的卡（需求 REQ-910 被 CT-901 的 `requires` 命中）：
  // 判不判红只看**有没有契约对象**，与角色工具面无关。
  writeRequirement('REQ-910', 'functional')
  writeContract('CT-901', ['REQ-910'])
  const contractCard = writeCard('TASK-910', ['REQ-910'])
  const contractFirst = profileOf({ packages: ['contract-first'] })
  const noTest = doneGaps(store, journal, contractCard, contractFirst)
  assert.equal(noTest.length, 1)
  assert.equal(noTest[0]?.check, 'contract-test-missing')
  recordContractTest(store, { task: 'TASK-910', contract: 'CT-901', tool: 'node --test', cmd: 'node --test test/ct901.test.js', at: '' })
  assert.deepEqual(doneGaps(store, journal, contractCard, contractFirst), [])

  // **N/A 侧（同一份 profile 下的反面对照）**：没有契约对象的卡**不判**，
  // 且必须给出理由 —— 不许静默跳过（那是把漏判伪装成 N/A，正是本卡要修的病）
  const noObject = writeCard('TASK-911', [])
  assert.deepEqual(doneGaps(store, journal, noObject, contractFirst), [], '没有契约对象 ⇒ 不判')
  const naNotes = doneNaNotes(store, noObject, contractFirst)
  assert.equal(naNotes.length, 1, `该给一条 N/A 理由：${JSON.stringify(naNotes)}`)
  assert.ok(naNotes[0]?.includes('contractsOfCard'), '理由要写清判定依据')

  // 范围不覆盖 ⇒ 不检查（别的卡不受这份 profile 影响）
  const scoped = profileOf({ packages: ['contract-first'], scope: ['TASK-999'] })
  assert.deepEqual(doneGaps(store, journal, card, scoped), [])
})

test('M33-07 接线：动作词表 / 处理器 / README / 事件类型四处同源', () => {
  assert.ok((PLAN_ACTIONS as readonly string[]).includes('profile'), 'sdo_plan 要有 profile 动作')
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /args\.action === 'profile'/u, '处理器要真的实现它')
  assert.match(index, /office\.decideConstructionProfile\(/u, '要接到 office 的领域方法')
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /`sdo_plan`（decompose \/ iteration \/ next \/ profile）/u, 'README 的动作清单要同源')
  const types = readFileSync(join(ROOT, 'src', 'types.ts'), 'utf8')
  assert.match(types, /'plan\/profile-decided'/u, 'journal 事件类型要注册（否则 append 编不过）')
  // 用项目自己的扫描口径（只数**字符串字面量**里的中文，注释不算），与 m7 棘轮同源
  const construction = readFileSync(join(ROOT, 'src', 'domain', 'construction.ts'), 'utf8')
  assert.equal(countCjkLiterals(construction), 0, '新模块不许有硬编码中文（棘轮基线 0）')
})

test('M33-08 接线·开工关：构造阶段缺 profile 一律不给认领；显式不选包 = N/A；契约必须先冻结', () => {
  writeRequirement('REQ-001', 'functional')
  writeContract('CT-001', ['REQ-001'])
  writeCard('TASK-001', ['REQ-001'])
  writeCase('TC-900', 'REQ-001') // C7 会先拦"没有用例计划"，这里先把 C7 满足掉，才能测到方法包这道门
  // 每次认领前复位（成功认领会把 revision +1，CAS 会挡住复用同一份期望版本）
  const claimArgs = () => {
    writeCard('TASK-001', ['REQ-001'])
    return { taskId: 'TASK-001', owner: 'dev-a', expectedRevision: 1, phase: 'construction' }
  }

  // ① 构造阶段 + 没 profile ⇒ 拒（这就是设计里的 C-33 在开工关上的体现）
  const noProfile = claim(store, journal, claimArgs())
  assert.equal(noProfile.ok, false)
  assert.equal(noProfile.ok === false ? noProfile.code : '', 'construction-profile-missing')

  // ② 显式不选任何包（合法 N/A，但要理由）⇒ 放行
  store.writeYaml(['construction', 'profile.yml'], {
    profile: { version: 1, decidedAt: '', decidedBy: 'office', packages: [], scope: 'all', derivedFrom: [], reason: '本项目不启用', exempt: [], history: [] },
  })
  assert.equal(claim(store, journal, claimArgs()).ok, true, '显式不选包时开工关不拦')

  // ③ 选了 contract-first 但契约没冻结 ⇒ 拒，并点到具体契约
  writeConstructionProfile(store, profileOf({ packages: ['contract-first'] }))
  const unfrozen = claim(store, journal, claimArgs())
  assert.equal(unfrozen.ok, false)
  assert.equal(unfrozen.ok === false ? unfrozen.code : '', 'contract-not-frozen')
  assert.ok(unfrozen.ok === false && unfrozen.detail.includes('CT-001'), '理由要点到契约')

  // ④ 先把契约冻结（它排在认领之前）⇒ 放行
  journal.append('design/confirmed', { target: 'CT-001', basis: 'review', by: 'cockpit' })
  assert.equal(claim(store, journal, claimArgs()).ok, true)

  // ⑤ 非构造阶段不检查（升级前的项目行为不变）
  const other = writeCard('TASK-002', ['REQ-001'])
  assert.equal(claim(store, journal, { taskId: other.id, owner: 'dev-b', expectedRevision: 1, phase: 'design-plan' }).ok, true)
})

test('M33-09 接线·收工关：红→绿 / critical 变异 / 契约测试三条都在 done 上真的拦人', () => {
  writeRequirement('REQ-001', 'functional')
  writeContract('CT-001', ['REQ-001'])
  writeCase('TC-001', 'REQ-001')
  const card = writeCard('TASK-001', ['REQ-001'], ['command'])
  const doneArgs = {
    taskId: card.id,
    owner: 'dev-a',
    status: 'done' as const,
    evidence: [{ kind: 'command' as const, detail: 'node --test', at: 'x', exitCode: 0 }],
  }
  const claimNow = () => {
    // 每轮把卡复位成"正在做"（done 成功过会把 revision 与状态都改掉）
    store.writeYaml(['tasks', `${card.id}.yml`], { task: { ...card, status: 'in-progress', owner: 'dev-a', revision: 1, evidence: [] } })
    journal.append('task/claimed', { id: card.id, owner: 'dev-a', revision: 1, sessionId: 's1' })
  }

  // ① tdd：用例只 pass（没红过）⇒ 收工关拒
  writeConstructionProfile(store, profileOf({ packages: ['tdd'] }))
  writeResult('TR-001', 'TC-001', 'pass')
  claimNow()
  const redMissing = report(store, journal, doneArgs)
  assert.equal(redMissing.ok, false)
  assert.equal(redMissing.ok === false ? redMissing.code : '', 'tdd-red-green-missing')

  // ② 补上"先红后绿"的新用例 ⇒ 红点消失；critical 档位转而缺变异证据
  writeCase('TC-002', 'REQ-001')
  writeResult('TR-002', 'TC-002', 'fail')
  writeResult('TR-003', 'TC-002', 'pass')
  store.writeYaml(['config.yml'], { scale: 'critical' }) // readProjectConfig 读的是顶层 scale
  claimNow()
  const mutationMissing = report(store, journal, doneArgs)
  assert.equal(mutationMissing.ok, false)
  assert.equal(mutationMissing.ok === false ? mutationMissing.code : '', 'tdd-mutation-missing')

  // ③ 记一条变异（killed ≥ 1）⇒ tdd 侧全过；但选了 contract-first ⇒ 缺契约测试
  recordMutation(store, { task: card.id, tool: 'node --test', target: 'lib/x.js', killed: 2, survived: 0, at: '' })
  writeConstructionProfile(store, profileOf({ packages: ['tdd', 'contract-first'] }))
  claimNow()
  const contractMissing = report(store, journal, doneArgs)
  assert.equal(contractMissing.ok, false)
  assert.equal(contractMissing.ok === false ? contractMissing.code : '', 'contract-test-missing')

  // ④ 补上契约测试 ⇒ 全过
  recordContractTest(store, { task: card.id, contract: 'CT-001', tool: 'node --test', cmd: 'node --test test/ct001.test.js', at: '' })
  claimNow()
  const ok = report(store, journal, doneArgs)
  assert.equal(ok.ok, true, ok.ok === false ? ok.detail : '')

  // ⑤ profile 坏结构 ⇒ 收工也要拒（坏数据不许被静默忽略）
  store.writeYaml(['construction', 'profile.yml'], { profile: { packages: ['nope'], scope: 'all', derivedFrom: ['scale=normal'], reason: 'x' } })
  claimNow()
  const broken = report(store, journal, doneArgs)
  assert.equal(broken.ok, false)
  assert.equal(broken.ok === false ? broken.code : '', 'construction-profile-missing')
})

test('M33-10 门禁判据：C-33/C-83（方法包已决定，三态）与 C-43/C-84（范围内卡满足所选包）', () => {
  const ctx = { workspace: BASE, store, journal } as unknown as GateContext
  const profileDecided = CHECKERS['construction.profile-decided']
  const packagesSatisfied = CHECKERS['construction.packages-satisfied']
  assert.ok(profileDecided !== undefined && packagesSatisfied !== undefined, '两个检查器都要注册')

  // ① 没 profile ⇒ 判红（并给 remedy）
  const missing = profileDecided(ctx)
  assert.equal(missing.ok, false)
  assert.ok((missing.remedy ?? '').length > 0, '判红要给补救指引')

  // ② 坏结构 ⇒ 判红并点名问题；③ 显式不选包 ⇒ N/A（两条判据都 N/A）
  store.writeYaml(['construction', 'profile.yml'], { profile: { packages: ['nope'], scope: 'all', derivedFrom: ['scale=normal'], reason: 'x' } })
  assert.equal(profileDecided(ctx).ok, false)
  assert.ok((profileDecided(ctx).detail ?? '').includes('nope'), '要点名未知的包')
  writeConstructionProfile(store, profileOf({ packages: [] }))
  const optOut = profileDecided(ctx)
  // 本仓库的 N/A 口径：`ok === false` + `na === true`（见 m11 对未选包的断言）
  assert.equal(optOut.na, true, '显式不选包 ⇒ N/A')
  assert.equal(optOut.ok, false, 'N/A 不是"通过"（不会被算进全绿分子）')
  assert.equal(packagesSatisfied(ctx).na, true, '从判据同样 N/A')

  // ④ 选了 tdd 且有一张 done 卡不满足（需求只 pass 过）⇒ 判红并点名卡
  writeRequirement('REQ-001', 'functional')
  writeCase('TC-001', 'REQ-001')
  writeResult('TR-001', 'TC-001', 'pass')
  store.writeYaml(['tasks', 'TASK-001.yml'], { task: { ...taskOf('TASK-001', ['REQ-001']), status: 'done' } })
  writeConstructionProfile(store, profileOf({ packages: ['tdd'] }))
  assert.equal(profileDecided(ctx).ok, true)
  const bad = packagesSatisfied(ctx)
  assert.equal(bad.ok, false)
  assert.ok((bad.detail ?? '').includes('TASK-001'), `要点名是哪张卡：${bad.detail}`)

  // ⑤ 补齐"先红后绿"的用例 ⇒ 判据过
  writeCase('TC-002', 'REQ-001')
  writeResult('TR-002', 'TC-002', 'fail')
  writeResult('TR-003', 'TC-002', 'pass')
  const good = packagesSatisfied(ctx)
  assert.equal(good.ok, true, good.detail)
  assert.ok((good.detail ?? '').includes('1'), '要报范围内复核了几张卡')

  // ⑥ 范围不覆盖的 done 卡不受影响
  store.writeYaml(['tasks', 'TASK-002.yml'], { task: { ...taskOf('TASK-002', ['REQ-002']), status: 'done' } })
  writeConstructionProfile(store, profileOf({ packages: ['tdd'], scope: ['TASK-001'] }))
  assert.equal(packagesSatisfied(ctx).ok, true, '范围外的卡不检查')

  // ⑦ 流程数据里判据确实挂对了门（顺序流程 G4/G5；agile 无 construction ⇒ 挂在 GI）
  for (const process of ['waterfall', 'prototype', 'spiral']) {
    const text = readFileSync(join(ROOT, 'src', 'data', 'processes', `${process}.yml`), 'utf8')
    assert.match(text, /C-33, check: "construction\.profile-decided"/u, `${process} 的 G4 要有 C-33`)
    assert.match(text, /C-43, check: "construction\.packages-satisfied"/u, `${process} 的 G5 要有 C-43`)
  }
  const agile = readFileSync(join(ROOT, 'src', 'data', 'processes', 'agile.yml'), 'utf8')
  assert.match(agile, /C-83, check: "construction\.profile-decided"/u, 'agile 的 GI 要有 C-83')
  assert.match(agile, /C-84, check: "construction\.packages-satisfied"/u, 'agile 的 GI 要有 C-84')
})

function taskOf(id: string, requirements: string[]): TaskCard {
  return {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: 'developer', size: 'small', revision: 1,
    status: 'ready', requirements, evidence: [], createdAt: '', updatedAt: '',
  }
}

test('M33-11 交付物通道：变异自证与契约测试都能记（写 yml + journal），非法输入整次拒收不写盘', () => {
  writeRequirement('REQ-001', 'functional')
  writeContract('CT-001', ['REQ-001'])
  const card = writeCard('TASK-001', ['REQ-001'], ['command'])
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 'cockpit', cwd: BASE }

  // ① 变异：非法输入（缺 task / killed 为负）⇒ 拒且**什么都不写**
  const noTask = office.recordMutation(call, { task: '', tool: 'node --test', target: '', killed: 1, survived: 0 })
  assert.equal(noTask.ok, false)
  const negative = office.recordMutation(call, { task: card.id, tool: 'node --test', target: '', killed: -1, survived: 0 })
  assert.equal(negative.ok, false)
  assert.deepEqual(readMutations(store), [], '被拒时不得留下半条记录')

  // ② 变异：合法 ⇒ 写进 tdd.yml + 落一条 journal
  const ok = office.recordMutation(call, { task: card.id, tool: 'node --test', target: 'lib/x.js', killed: 3, survived: 1 })
  assert.equal(ok.ok, true)
  assert.deepEqual(readMutations(store).map((item) => [item.task, item.killed, item.survived]), [[card.id, 3, 1]])
  assert.equal(journal.read().events.filter((event) => event.type === 'test/mutation-recorded').length, 1)

  // ③ 契约测试：契约不存在 ⇒ 拒且不写盘
  const unknown = office.recordContractTest(call, { task: card.id, contract: 'CT-999', tool: 'node --test', cmd: 'x' })
  assert.equal(unknown.ok, false)
  assert.deepEqual(readContractTests(store), [])

  // ④ 合法 ⇒ 写进 contract-first.yml；且收工关能看到（critical 档 + contract-first 都满足）
  const recorded = office.recordContractTest(call, { task: card.id, contract: 'CT-001', tool: 'node --test', cmd: 'node --test test/ct001.test.js' })
  assert.equal(recorded.ok, true)
  assert.deepEqual(readContractTests(store).map((item) => item.contract), ['CT-001'])
  assert.equal(journal.read().events.filter((event) => event.type === 'test/contract-test-recorded').length, 1)
  // 只断言**契约测试这一路**：这张卡还没有 tdd 的"先红后绿"用例结果，tdd 那一路报红是对的
  assert.deepEqual(doneGaps(store, journal, card, profileOf({ packages: ['contract-first'] }), { scale: 'critical' }), [], '契约测试齐了就放行')
  assert.equal(
    doneGaps(store, journal, card, profileOf({ packages: ['tdd'] }), { scale: 'critical' }).some((item) => item.check === 'tdd-mutation-missing'),
    false,
    '变异交付物已记（killed ≥ 1）⇒ 不再报缺变异证据',
  )

  // ⑤ 接线与掩码：处理器分流 + developer 有 sdo_test（TDD 要能记录）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /office\.recordMutation\(call/u, 'record 要分流到变异交付物')
  assert.match(index, /office\.recordContractTest\(call/u, 'record 要分流到契约测试交付物')
  const developer = listRoleCards().find((item) => item.code === 'developer')
  assert.ok(developer?.allow.includes('sdo_test') === true, 'developer 的掩码要含 sdo_test（TDD 记录交付物）')
})

test('M33-12 结果来源可追溯（N2）：文件必须在 journal 里有对应事件；文件与 journal 冲突时以**文件**为准', () => {
  const card = writeCard('TASK-001', ['REQ-001'])
  writeCase('TC-001', 'REQ-001')

  // ① 只写文件、不写 journal ⇒ 来源不可追溯，判红（这就是评审指出的伪造口）
  writeResultFileOnly('TR-001', 'TC-001', 'fail')
  writeResultFileOnly('TR-002', 'TC-001', 'pass')
  const forged = redGreenGaps(store, journal, card)
  assert.equal(forged.length, 1)
  assert.equal(forged[0]?.check, 'tdd-result-untraceable')
  assert.ok(forged[0]?.detail.includes('TR-001'), '要点名是哪些结果文件')

  // ② 补上对应 journal 事件（与生产路径一致）⇒ 同一批文件立刻通过
  journal.append('test/recorded', { id: 'TR-001', caseId: 'TC-001', status: 'fail' })
  journal.append('test/recorded', { id: 'TR-002', caseId: 'TC-001', status: 'pass' })
  assert.deepEqual(redGreenGaps(store, journal, card), [])

  // ③ **判别性用例**：让文件顺序与 journal 顺序相反 —— 判据必须以**文件 id 序**为准（不是 journal 序）
  //    文件：TR-003 pass → TR-004 fail（不是"先红后绿"）；journal：先 fail 后 pass
  writeResultFileOnly('TR-003', 'TC-002', 'pass')
  writeResultFileOnly('TR-004', 'TC-002', 'fail')
  journal.append('test/recorded', { id: 'TR-003', caseId: 'TC-002', status: 'pass' })
  journal.append('test/recorded', { id: 'TR-004', caseId: 'TC-002', status: 'fail' })
  writeCard('TASK-002', ['REQ-002'])
  writeCase('TC-002', 'REQ-002')
  const fileWins = redGreenGaps(store, journal, writeCard('TASK-002', ['REQ-002']))
  assert.equal(fileWins.length, 1, '按文件序（pass 在前）⇒ 不算"先红后绿"；若改读 journal 序，这条会变绿')
  assert.equal(fileWins[0]?.check, 'tdd-red-green-missing')
})

test('M33-13 评审建议 2：变异交付物的 `target` 允许为空，但回执要给"建议写清"的提示（不判红）', () => {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 'cockpit', cwd: BASE }

  const empty = office.recordMutation(call, { task: 'TASK-001', tool: 'node --test', target: '', killed: 1, survived: 0 })
  assert.equal(empty.ok, true, 'target 为空**不判红**（只是证据弱）')
  assert.equal(empty.ok ? empty.targetMissing : false, true, '要如实回报 target 缺失，回执才好提示')

  const filled = office.recordMutation(call, { task: 'TASK-001', tool: 'node --test', target: 'lib/x.js', killed: 1, survived: 0 })
  assert.equal(filled.ok ? filled.targetMissing : true, false)

  // 接线：回执确实会带上提示行（文案在语言包里）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /outcome\.targetMissing/u, '处理器要消费这个信号')
  assert.match(index, /uiIndex\.kMutationTargetHint/u, '提示文案要走语言包')
})

test('M33-14 工具层端到端：经**真实注册的 sdo_test** 记交付物（B1 回归：参数不许在工具边界被丢掉）', async () => {
  // 为什么要这条：M33-11/13 直接调 `office.*`，**绕过了工具边界** —— 评审正是据此发现
  // `sdo_test` 的 `parameters`/`execute` 里没有这两个字段，模型照 README 写也写不进去（blocker）。
  writeRequirement('REQ-001', 'functional')
  writeContract('CT-001', ['REQ-001'])

  const captured: { name: string; execute: (args: unknown, exec: unknown) => unknown; parameters: unknown }[] = []
  const services: Record<string, unknown> = {
    tools: { register: (definition: never) => { captured.push(definition as never); return () => {} } },
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

  const tool = captured.find((item) => item.name === 'sdo_test')
  assert.ok(tool !== undefined, 'sdo_test 必须注册进工具表')
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  assert.ok('mutation' in properties, 'schema 必须有 mutation（否则工具层静默丢弃——B1）')
  assert.ok('contractTest' in properties, 'schema 必须有 contractTest')
  const exec = { agent: { id: 's1', session: { header: { cwd: BASE } } } }

  // ① 经工具记变异：回执是"已记"，且真的落盘 + 落 journal
  const mutationReceipt = String(await tool.execute({
    action: 'record',
    mutation: JSON.stringify({ task: 'TASK-001', tool: 'node --test', target: '', killed: 2, survived: 0 }),
  }, exec))
  assert.match(mutationReceipt, /已记变异自证/u, `工具层必须真的记下：${mutationReceipt}`)
  assert.match(mutationReceipt, /建议写清/u, 'target 为空时要带提示（不判红）')
  assert.deepEqual(readMutations(store).map((item) => item.killed), [2], 'tdd.yml 要写出')
  assert.equal(journal.read().events.filter((event) => event.type === 'test/mutation-recorded').length, 1)

  // ② 经工具记契约测试：合法契约 ⇒ 落盘；未知契约 ⇒ 拒收且不写盘
  const badContract = String(await tool.execute({
    action: 'record',
    contractTest: JSON.stringify({ task: 'TASK-001', contract: 'CT-999', tool: 'node --test', cmd: 'x' }),
  }, exec))
  assert.match(badContract, /被拒/u, `未知契约要拒收：${badContract}`)
  assert.deepEqual(readContractTests(store), [], '拒收时不得写盘')

  const contractReceipt = String(await tool.execute({
    action: 'record',
    contractTest: JSON.stringify({ task: 'TASK-001', contract: 'CT-001', tool: 'node --test', cmd: 'node --test test/ct001.test.js' }),
  }, exec))
  assert.match(contractReceipt, /已记契约测试/u, contractReceipt)
  assert.deepEqual(readContractTests(store).map((item) => item.contract), ['CT-001'])

  // ③ 分流不误伤："用例结果"分支的要求照旧（缺 caseId/status 时给那句老提示）
  const asResult = String(await tool.execute({ action: 'record' }, exec))
  assert.match(asResult, /caseId/u, '没给交付物时仍走用例结果分支')
})

test('M33-15 工具层端到端：经**真实注册的 sdo_plan** 决定方法包（PLAN-1 回归：决策入口不许在边界被丢掉）', async () => {
  // 为什么要这条：M33-03/07/10 直接调 `office.decideConstructionProfile`，**绕过了工具边界** ——
  // sdo-test 会话正是因此发现 `sdo_plan` 的 schema/映射里没有 profile 参数，`action=profile` 根本不可达（同类于 B1）。
  writeRequirement('REQ-001', 'functional')
  const captured: { name: string; execute: (args: unknown, exec: unknown) => unknown; parameters: unknown }[] = []
  const services: Record<string, unknown> = {
    tools: { register: (definition: never) => { captured.push(definition as never); return () => {} } },
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

  const tool = captured.find((item) => item.name === 'sdo_plan')
  assert.ok(tool !== undefined, 'sdo_plan 必须注册进工具表')
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  for (const key of ['packages', 'scope', 'derivedFrom', 'reason', 'exempt']) {
    assert.ok(key in properties, `schema 必须有 ${key}（否则工具层静默丢弃——PLAN-1）`)
  }
  const exec = { agent: { id: 's1', session: { header: { cwd: BASE } } } }

  // ① 经工具决定方法包 ⇒ 回执是"已决定"，且 profile.yml + journal 都真的写了
  const receipt = String(await tool.execute({
    action: 'profile',
    packages: JSON.stringify(['tdd', 'contract-first']),
    derivedFrom: JSON.stringify(['reqKind=functional(REQ-001)']),
    reason: '经工具层决定',
    exempt: JSON.stringify([]),
  }, exec))
  assert.match(receipt, /已决定实现阶段方法包/u, `工具层必须真的决定：${receipt}`)
  assert.match(receipt, /tdd \+ contract-first/u, '回执要报出选了哪些包')
  const read = readConstructionProfile(store)
  assert.equal(read.status, 'ok', 'profile.yml 要写出')
  assert.deepEqual(read.profile?.packages, ['tdd', 'contract-first'])
  assert.equal(journal.read().events.filter((event) => event.type === 'plan/profile-decided').length, 1)

  // ② 经工具拒绝：packages 为空且没理由 ⇒ 回执说"不能这样决定"，且不写盘
  const rejected = String(await tool.execute({ action: 'profile', packages: JSON.stringify([]) }, exec))
  assert.match(rejected, /不能这样决定/u, `非法输入要拒：${rejected}`)
  assert.deepEqual(readConstructionProfile(store).profile?.packages, ['tdd', 'contract-first'], '拒绝时保留原 profile')
})


// ——————————————————————————————————————————————————————————————————————————————
// 增量 TASK-014：**测试设计规格·黑盒技术**（REQ-048 / AC-194 AC-195 AC-196）
//
// 本段与上面的「实现阶段方法包」共用 m33 这个测试工作区（`node_modules/.sdo-test/m33`），
// 但测的是**另一个模块**（`src/domain/testDesign.ts`）—— 之所以落在同一个文件里，
// 是因为本卡的 writeScopes 只给了 `src/domain/testDesign.ts` + `test/m33.test.ts`：
// 测试不动实现，也不再新开测试面（新开就得改 `test/` 之外的派发面）。
//
// 黑盒四类技术各自的**必产项**是本段的主轴，三条 AC 逐条有对应用例：
//   · AC-194（等价类：有效类 + 无效类，缺项点名）—— M33-17 / M33-18
//   · AC-195（判定表：规则数不齐则逐条标注不可能 + 理由）—— M33-19 / M33-20
//   · AC-196（域的出处查不到即判红，不得凭空发明）—— M33-21 / M33-22 / M33-23
//   另有本卡 DoD 的三条：四类技术（M33-16）、用例可回溯（M33-26）、缺技术标注即拒落盘（M33-24）。
//
// 追溯（DoD 第 2 条的机器可核部分）—— 逐条用例 → 需求/设计元素：
//   M33-16 → REQ-048 + DES-031 ｜ M33-17 → REQ-048 / AC-194 ｜ M33-18 → REQ-048 / AC-194
//   M33-19 → REQ-048 / AC-195 ｜ M33-20 → REQ-048 / AC-195 ｜ M33-21 → REQ-048 / AC-196
//   M33-22 → REQ-048 / AC-196 ｜ M33-23 → REQ-048 / AC-196 ｜ M33-24 → REQ-048（DoD 守卫）
//   M33-25 → REQ-048（DoD 第 2 条）｜ M33-26 → REQ-048（DoD 第 2 条）｜ M33-27 → REQ-048
//   M33-28 → REQ-048 ｜ M33-29 → REQ-048 ｜ M33-30 → REQ-048 ｜ M33-31 → REQ-048
// ——————————————————————————————————————————————————————————————————————————————

/** 域出处的**对手方**：需求编号 → 验收标准（与 `.sdo/requirements/*.yml` 同形状）。 */
const TD_FACTS = emptyKnownFacts()
TD_FACTS.requirements.set('REQ-048', ['AC-194', 'AC-195', 'AC-196'])
TD_FACTS.contracts.set('CT-024', ['schema', 'failureSemantics', 'requires'])
TD_FACTS.designElements.set('DES-031', ['profile', 'plan', 'design'])

/** 本段所有用例 id：第一次调用时写进 store 的 `tests/`（M33-16 的"用例确实存在"那一闸）。 */
const TD_CASES = [
  'TC-TD-01', 'TC-TD-02', 'TC-TD-03', 'TC-TD-04', 'TC-TD-05', 'TC-TD-06',
  'TC-TD-07', 'TC-TD-08', 'TC-TD-09', 'TC-TD-10', 'TC-TD-11', 'TC-TD-12',
]
/** 种子是否已写进**当前**工作区 —— 由 `tdSeed` 按盘上文件判定（见那里的注释）。 */

function tdSeed(): void {
  // 为什么不用一个模块级布尔量当"种过了"的标志：本文件的 `beforeEach` 每个用例都**清掉并重建**
  // 测试工作区，标志却活在模块里 ⇒ 只有第一个用例真的写了盘，后面所有用例都拿到空台账
  //（实测踩到过：M33-23 扫台账扫出空集）。判据必须是**盘上还在不在**，不是"这个模块想过没有"。
  if (store.exists('tests', 'TC-TD-01.yml')) return
  store.writeYaml(['requirements', 'REQ-048.yml'], {
    requirement: {
      id: 'REQ-048',
      title: '测试设计规格（黑盒技术集）',
      kind: 'functional',
      statement: 's',
      rationale: 'r',
      acceptance: [{ id: 'AC-194' }, { id: 'AC-195' }, { id: 'AC-196' }],
    },
  })
  store.writeYaml(['contracts', 'CT-024.yml'], {
    contract: {
      id: 'CT-024',
      name: 'CT-024',
      kind: 'http',
      producer: 'a',
      consumer: 'b',
      schema: { reason: 'string', at: 'string' },
      failureSemantics: { timeout: 'reject' },
      requires: ['REQ-048'],
      at: '',
    },
  })
  store.writeYaml(['design', 'component.yml'], {
    component: {
      id: 'DES-031',
      name: '测试域真源',
      enums: ['profile', 'plan', 'design'],
    },
  })
  for (const id of TD_CASES) store.writeYaml(['tests', `${id}.yml`], { testCase: { id, title: id, kind: 'unit', requirement: 'REQ-048', steps: ['s'], expected: 'e', at: '' } })
}

/** 基线**合法**的黑盒必产项集（四类技术各一条）；每个返例只改一处 —— 方便断言"只报这一处"。 */
function tdBase(): Record<string, unknown>[] {
  return [
    {
      id: 'ART-001',
      technique: 'equivalence',
      artifact: '句柄状态的等价类划分',
      domain: '句柄状态（AC-194）',
      domainSource: 'AC-194',
      requirementRef: ['REQ-048'],
      useCases: ['TC-TD-01', 'TC-TD-02'],
      classes: [
        { kind: 'valid', value: '在飞', useCases: ['TC-TD-01'] },
        { kind: 'invalid', value: '已退役', useCases: ['TC-TD-02'] },
      ],
    },
    {
      id: 'ART-002',
      technique: 'boundary',
      artifact: '会话存活时长边界点',
      domain: '会话存活时长 0–86400 秒（CT-024.failureSemantics）',
      domainSource: 'CT-024.failureSemantics',
      requirementRef: ['REQ-048'],
      useCases: ['TC-TD-03'],
      boundaries: [
        { point: '0', kind: 'min', useCases: ['TC-TD-03'] },
        { point: '86400', kind: 'max', useCases: ['TC-TD-03'] },
      ],
    },
    {
      id: 'ART-003',
      technique: 'decision-table',
      artifact: '认领守卫的判定表',
      domain: '认领守卫的条件组合（DES-031）',
      domainSource: 'DES-031',
      requirementRef: ['REQ-048'],
      useCases: ['TC-TD-04', 'TC-TD-05'],
      conditions: [
        { id: 'C1', when: '卡已被认领' },
        { id: 'C2', when: '版本号对得上' },
      ],
      actions: [
        { id: 'A1', then: '拒绝' },
        { id: 'A2', then: '接受' },
      ],
      rules: [
        { id: 'R1', conditions: ['1', '1'], actions: ['A2'], useCases: ['TC-TD-04'] },
        { id: 'R2', conditions: ['1', '0'], actions: ['A1'], useCases: ['TC-TD-05'] },
        { id: 'R3', conditions: ['0', '1'], actions: ['A2'], useCases: ['TC-TD-04'] },
        { id: 'R4', conditions: ['0', '0'], actions: ['A1'], useCases: ['TC-TD-05'] },
      ],
    },
    {
      id: 'ART-004',
      technique: 'state-transition',
      artifact: '任务卡状态迁移',
      domain: '任务卡状态机（AC-194）',
      domainSource: 'AC-194',
      requirementRef: ['REQ-048'],
      useCases: ['TC-TD-06', 'TC-TD-07'],
      states: [
        { id: 'ready', meaning: '可认领' },
        { id: 'in-progress', meaning: '已被认领' },
        { id: 'done', meaning: '已完成' },
      ],
      transitions: [
        { id: 'T1', from: 'ready', to: 'in-progress', on: 'claim', useCases: ['TC-TD-06'] },
        { id: 'T2', from: 'in-progress', to: 'done', on: 'done', useCases: ['TC-TD-06'] },
      ],
      invalidTransitions: [
        { id: 'T2', reason: '未认领不能直接完成', useCases: ['TC-TD-07'] },
        { id: 'T1', reason: '已认领的卡不能被再次认领', useCases: ['TC-TD-07'] },
      ],
    },
  ]
}

/** 改基线的第 `index` 条（其余原样）：断言"只报这一处"用。 */
function tdPatch(index: number, patch: Record<string, unknown>): Record<string, unknown>[] {
  const artifacts = tdBase()
  const target = artifacts[index]
  if (target === undefined) throw new Error(`基线里没有第 ${index} 条必产项`)
  artifacts[index] = { ...target, ...patch }
  return artifacts
}

function tdDesign(artifacts: unknown[]): Record<string, unknown> {
  return { artifacts }
}

function tdRow(report: TestDesignReport, technique: string): TestDesignTechniqueCoverage {
  const row = report.coverage.find((item) => item.technique === technique)
  assert.ok(row !== undefined, `覆盖读数里必须有「${technique}」一行：${report.coverage.map((item) => item.technique).join(' ')}`)
  return row
}

function tdExpect(report: TestDesignReport, code: string, field: string, hint: string): void {
  assert.ok(
    report.issues.some((issue) => issue.code === code && issue.field === field),
    `${hint}\n实际：${report.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ｜ ') || '（无问题）'}`,
  )
  assert.ok(
    report.issues.some((issue) => issue.code === code && issue.field === field && issue.message.length >= 8),
    `${hint}（问题说明要能照着改，不能只有码）`,
  )
}

/** 经**落盘闸门**写一份设计（统一带上台账事实与用例清单）。 */
function tdWriteValidated(design: unknown, options: ValidateTestDesignOptions = {}): TestDesignWriteResult {
  return writeValidatedTestDesign(store, design, { known: TD_FACTS, testCaseIds: TD_CASES, ...options })
}

test('M33-16 四类黑盒技术的必产项齐备时落盘：覆盖读数逐技术计数，用例反向引用可核（REQ-048）', () => {
  tdSeed()
  const before = rawTestDesignText(store)
  assert.equal(before, '', '前置：盘上还没有 design.yml')

  const result = tdWriteValidated(tdDesign(tdBase()))
  assert.equal(result.written, true, `四类技术齐备 + 用例可核 ⇒ 必须落盘：${JSON.stringify(result.report.issues)}`)
  assert.equal(result.outcome, 'ok')
  assert.equal(result.path, 'testing/design.yml')
  assert.match(result.hash, /^sha256:[0-9a-f]{64}$/u, '落盘要给出内容指纹（带算法前缀）')
  assert.equal(result.replaced, false, '首次落盘不是覆盖')

  // 覆盖读数：四类技术各声明 1 条、各**真的**给出 1 条
  assert.deepEqual(tdRow(result.report, 'equivalence'), { technique: 'equivalence', label: '等价类划分', declared: 1, covered: 1 })
  assert.deepEqual(tdRow(result.report, 'boundary'), { technique: 'boundary', label: '边界值分析', declared: 1, covered: 1 })
  assert.deepEqual(tdRow(result.report, 'decision-table'), { technique: 'decision-table', label: '判定表', declared: 1, covered: 1 })
  assert.deepEqual(tdRow(result.report, 'state-transition'), { technique: 'state-transition', label: '状态迁移', declared: 1, covered: 1 })
  const declared = result.report.coverage.filter((item) => item.declared > 0).map((item) => item.technique).sort()
  assert.deepEqual(declared, ['boundary', 'decision-table', 'equivalence', 'state-transition'], '四类技术逐条都要有必产项')

  // 读了回来 + 指纹与落盘时一致（幂等/可复核）
  const read = readTestDesign(store)
  assert.equal(read.status, 'ok', read.reason)
  assert.equal(testDesignFingerprint(store), result.hash, '读回来的指纹必须与落盘时一致')

  // 用例确实存在这一闸：基线里的 12 条用例都能在 .sdo/tests/ 里查到
  const cases = new Set(store.listNames('tests').map((name) => name.replace(/\.yml$/u, '')))
  assert.equal(cases.size, TD_CASES.length, `用例要先落盘才可核：${[...cases].join(' ')}`)
  for (const id of ['TC-TD-01', 'TC-TD-04', 'TC-TD-07']) assert.ok(cases.has(id), `${id} 必须在台账里`)
})

test('M33-17 AC-194：输入域缺有效类或缺无效类都要点名判红，且不准落盘（每条用例都要挂住）', () => {
  tdSeed()

  // ① 只有有效类 ⇒ 判红，点名"没有无效类"
  const onlyValid = validateTestDesign(tdDesign(tdPatch(0, {
    classes: [{ kind: 'valid', value: '在飞', useCases: ['TC-TD-01'] }],
  })), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(onlyValid.outcome, 'invalid')
  tdExpect(onlyValid, 'class-absent', 'artifacts[0].classes', '缺无效类要判红并点到 classes')

  // ② 只有无效类 ⇒ 判红，点名"没有有效类"
  const onlyInvalid = validateTestDesign(tdDesign(tdPatch(0, {
    classes: [{ kind: 'invalid', value: '已退役', useCases: ['TC-TD-02'] }],
  })), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(onlyInvalid.outcome, 'invalid')
  tdExpect(onlyInvalid, 'class-absent', 'artifacts[0].classes', '缺有效类要判红并点到 classes')

  // ③ 类的 `kind` 写了同义词 ⇒ 不猜，判红
  const synonym = validateTestDesign(tdDesign(tdPatch(0, {
    classes: [
      { kind: '有效', value: '在飞', useCases: ['TC-TD-01'] },
      { kind: 'invalid', value: '已退役', useCases: ['TC-TD-02'] },
    ],
  })), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(synonym.outcome, 'invalid')
  tdExpect(synonym, 'artifact-incomplete', 'artifacts[0].classes[0].kind', '非法 kind 要判红（不猜"有效"=valid）')

  // ④ 合法基线在这一条上必须是绿的（否则上面三条证明不了什么）
  const green = validateTestDesign(tdDesign(tdBase()), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(green.outcome, 'ok', `合法基线要绿：${green.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)
})

test('M33-18 等价类的每条类都要有自己的用例：只挂整条、不挂类 ⇒ 逐类点名（防凑数）', () => {
  tdSeed()
  const perClass = tdPatch(0, {
    useCases: ['TC-TD-01'],
    classes: [
      { kind: 'valid', value: '在飞' },
      { kind: 'invalid', value: '已退役', useCases: ['TC-TD-02'] },
    ],
  })
  const report = validateTestDesign(tdDesign(perClass), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(report.outcome, 'invalid')
  tdExpect(report, 'artifact-incomplete', 'artifacts[0].classes[0].useCases', '有效类缺 useCases 字段 ⇒ 点到该类自己（`artifact-incomplete` = 字段缺失）')

  // 类上给了**台账里没有**的用例 ⇒ 用另一条码（`usecase-unknown`）点名
  const ghost = tdPatch(0, {
    useCases: ['TC-TD-01'],
    classes: [
      { kind: 'valid', value: '在飞', useCases: ['TC-TD-01'] },
      { kind: 'invalid', value: '已退役', useCases: ['TC-999'] },
    ],
  })
  const ghostReport = validateTestDesign(tdDesign(ghost), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(ghostReport.outcome, 'invalid')
  tdExpect(ghostReport, 'usecase-unknown', 'artifacts[0].classes[1].useCases[0]', '类挂的用例查不到要点名')

  // 反向对照：两条类各自挂上用例 ⇒ 这一段不再报（证明上一条确实是这一处引起的）
  const fixed = tdPatch(0, {
    useCases: ['TC-TD-01'],
    classes: [
      { kind: 'valid', value: '在飞', useCases: ['TC-TD-01'] },
      { kind: 'invalid', value: '已退役', useCases: ['TC-TD-02'] },
    ],
  })
  const ok = validateTestDesign(tdDesign(fixed), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(ok.outcome, 'ok', `补上后要绿：${ok.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)
})

test('M33-19 AC-195：规则数与条件数的 2 次方不等且没逐条标注不可能 ⇒ 判红，缺失的组合逐条点名', () => {
  tdSeed()
  // 2 个条件 ⇒ 应有 4 条规则；这里只给 3 条，且没写 impossible
  const short = tdPatch(2, {
    rules: [
      { id: 'R1', conditions: ['1', '1'], actions: ['A2'], useCases: ['TC-TD-04'] },
      { id: 'R2', conditions: ['1', '0'], actions: ['A1'], useCases: ['TC-TD-05'] },
      { id: 'R3', conditions: ['0', '1'], actions: ['A2'], useCases: ['TC-TD-04'] },
    ],
  })
  const report = validateTestDesign(tdDesign(short), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(report.outcome, 'invalid')
  tdExpect(report, 'rule-incomplete', 'artifacts[2].rules', '规则不齐要判红并点到 rules')
  const message = report.issues.find((issue) => issue.code === 'rule-incomplete')?.message ?? ''
  assert.match(message, /0-0/u, `缺失的组合要逐条点名「0-0」：${message}`)
  assert.match(message, /4 种/u, `要点出应有 4 种组合：${message}`)
})

test('M33-20 AC-195：标注不可能（impossible）必须逐条给理由；给了理由就放过，重复标注仍判红', () => {
  tdSeed()
  // ① 缺理由 ⇒ 判红
  const noReason = tdPatch(2, {
    rules: [
      { id: 'R1', conditions: ['1', '1'], actions: ['A2'], useCases: ['TC-TD-04'] },
      { id: 'R2', conditions: ['1', '0'], actions: ['A1'], useCases: ['TC-TD-05'] },
      { id: 'R3', conditions: ['0', '1'], actions: ['A2'], useCases: ['TC-TD-04'] },
      { id: 'R4', conditions: ['0', '0'], impossible: true, useCases: ['TC-TD-05'] },
    ],
  })
  const missing = validateTestDesign(tdDesign(noReason), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(missing.outcome, 'invalid')
  tdExpect(missing, 'rule-incomplete', 'artifacts[2].rules', 'impossible 缺 reason 要判红')
  assert.match(missing.issues.find((issue) => issue.code === 'rule-incomplete')?.message ?? '', /第 4 条/u, '要点名是第几条')

  // ② 给了理由 ⇒ 这条技术过（其余不动）
  const withReason = tdPatch(2, {
    rules: [
      { id: 'R1', conditions: ['1', '1'], actions: ['A2'], useCases: ['TC-TD-04'] },
      { id: 'R2', conditions: ['1', '0'], actions: ['A1'], useCases: ['TC-TD-05'] },
      { id: 'R3', conditions: ['0', '1'], actions: ['A2'], useCases: ['TC-TD-04'] },
      { id: 'R4', conditions: ['0', '0'], impossible: true, reason: '未认领时无版本号可比，组合不可达', useCases: ['TC-TD-05'] },
    ],
  })
  const ok = validateTestDesign(tdDesign(withReason), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(ok.outcome, 'ok', `标注了不可能 + 理由 ⇒ 不齐也是合法的判定表：${ok.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)

  // ③ 同一条规则被标注两次 ⇒ 判红（重复计数会让"不齐"看起来齐）
  const twice = tdPatch(2, {
    rules: [
      { id: 'R1', conditions: ['1', '1'], actions: ['A2'], useCases: ['TC-TD-04'] },
      { id: 'R2', conditions: ['1', '0'], actions: ['A1'], useCases: ['TC-TD-05'] },
      { id: 'R3', conditions: ['0', '1'], actions: ['A2'], useCases: ['TC-TD-04'] },
      { id: 'R4', conditions: ['0', '0'], impossible: true, reason: '组合不可达' },
      { id: 'R5', conditions: ['0', '0'], impossible: true, reason: '同上（重复标注）' },
    ],
  })
  const dup = validateTestDesign(tdDesign(twice), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(dup.outcome, 'invalid')
  tdExpect(dup, 'rule-incomplete', 'artifacts[2].rules', '同一组合标注两次要判红')
})

test('M33-21 AC-196：域的出处指不到真源即判红（需求/契约/设计元素三张台账逐一对）', () => {
  tdSeed()
  // ① 需求台账里没有的验收标准
  const badAc = validateTestDesign(tdDesign(tdPatch(0, { domain: '句柄状态（AC-999）', domainSource: 'AC-999' })), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(badAc.outcome, 'invalid')
  tdExpect(badAc, 'domain-unknown', 'artifacts[0].domain', 'AC 不在需求台账 ⇒ 点到 domain')

  // ② 契约台账里没有的字段
  const badContract = validateTestDesign(tdDesign(tdPatch(1, { domainSource: 'CT-024.noSuchField' })), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(badContract.outcome, 'invalid')
  tdExpect(badContract, 'domain-unknown', 'artifacts[1].domain', '契约里没有这个字段 ⇒ 判红')

  // ③ 设计台账里没有的元素
  const badDesign = validateTestDesign(tdDesign(tdPatch(2, { domainSource: 'DES-999.values' })), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(badDesign.outcome, 'invalid')
  tdExpect(badDesign, 'domain-unknown', 'artifacts[2].domain', '设计元素不存在 ⇒ 判红')

  // ④ 光有文字说明、没有任何编号 ⇒ 判红（"纯文字无法核对"）
  const prose = validateTestDesign(tdDesign(tdPatch(0, { domain: '我们讨论过的那些句柄状态', domainSource: '' })), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(prose.outcome, 'invalid')
  tdExpect(prose, 'domain-source-missing', 'artifacts[0].domain', '缺 domainSource ⇒ 与"写了但查不到"分开点名')

  // ⑤ 三张台账各自的正例都认（需求 / 契约字段 / 设计元素）
  for (const [index, domain, source] of [
    [0, '句柄状态的取值域（AC-194）', 'AC-194'],
    [1, '会话存活时长 0–86400 秒（CT-024.failureSemantics）', 'CT-024.failureSemantics'],
    [2, '认领守卫的条件组合（DES-031）', 'DES-031.values'],
  ] as const) {
    const one = validateTestDesign(tdDesign(tdPatch(index, { domain, domainSource: source })), { known: TD_FACTS, testCaseIds: TD_CASES })
    assert.equal(one.outcome, 'ok', `${source} 是真源里的出处，必须认：${one.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)
  }

  // ⑥ 域描述里"顺嘴提了一句编号"不算出处 —— 出处只认 `domainSource` 字段（免得整句送核把合法真源误判红）
  const proseDomain = validateTestDesign(tdDesign(tdPatch(1, { domain: '会话存活时长（AC-999 提了一句）', domainSource: 'CT-024.failureSemantics' })), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(proseDomain.outcome, 'ok', `域描述是给人读的，出处只认 domainSource：${proseDomain.issues.map((issue) => issue.message).join('；')}`)
})

test('M33-22 AC-196：不给台账事实时只核形态（不凭空判红）；给了就按台账对', () => {
  tdSeed()
  const design = tdDesign(tdBase())
  const noFacts = validateTestDesign(design, { testCaseIds: TD_CASES })
  assert.equal(noFacts.outcome, 'ok', `没给事实就不许凭空判红：${noFacts.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)

  // 形态还是核：连编号都没有的纯文字，在"没给事实"时也判红
  const prose = validateTestDesign(tdDesign(tdPatch(0, { domain: '一些状态', domainSource: '一些状态' })), {})
  assert.equal(prose.outcome, 'invalid')
  tdExpect(prose, 'domain-unknown', 'artifacts[0].domain', '纯文字出处连形态都不对 ⇒ 无论有没有台账都判红')
})

test('M33-23 域出处可经**台账扫描**自动收集（collectKnownFacts）：落盘的需求/契约/设计元素能被认出来', () => {
  tdSeed()
  const facts = collectKnownFacts(store)
  assert.deepEqual(facts.requirements.get('REQ-048'), ['AC-194', 'AC-195', 'AC-196'], '需求 → 验收标准')
  assert.ok((facts.contracts.get('CT-024') ?? []).includes('failureSemantics'), `契约字段要扫出来：${[...(facts.contracts.get('CT-024') ?? [])].join(' ')}`)
  assert.ok(facts.designElements.has('DES-031'), '设计元素要扫出来')

  // 用**扫来的**事实当对手方：基线必须绿（证明扫描与手写事实在口径上一致）
  const scanned = validateTestDesign(tdDesign(tdBase()), { known: facts, testCaseIds: TD_CASES })
  assert.equal(scanned.outcome, 'ok', `扫来的事实必须能当对手方：${scanned.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)

  // 台账里没有的需求编号照样判红（扫描不是"什么都认"）
  const unknown = validateTestDesign(tdDesign(tdPatch(0, { requirementRef: ['REQ-999'] })), { known: facts })
  assert.equal(unknown.outcome, 'invalid')
  tdExpect(unknown, 'traceability-unknown', 'artifacts[0].requirementRef[0]', '台账里没有的需求要判红')
})

test('M33-24 【守卫】缺技术标注即拒绝落盘：一个字节都不写（本卡 DoD 第 3 条）', () => {
  tdSeed()
  // 四类技术的必产项都在（否则"缺技术"会先被判成"技术集不齐"这一条：unknown）
  // 另加一条**没写 technique** 的必产项 —— 它就是本卡守卫要拦的对象
  const spare: Record<string, unknown> = {
    id: 'ART-005',
    artifact: '第二张等价类表（技术标注故意留空）',
    domain: '会话存活时长的等价类（AC-194）',
    domainSource: 'AC-194',
    requirementRef: ['REQ-048'],
    useCases: ['TC-TD-08'],
    classes: [
      { kind: 'valid', value: '正常存活', useCases: ['TC-TD-08'] },
      { kind: 'invalid', value: '负时长', useCases: ['TC-TD-09'] },
    ],
  }
  const untechniqued: Record<string, unknown> = { ...spare }
  delete untechniqued.technique

  const result = tdWriteValidated(tdDesign([...tdBase(), untechniqued]))
  assert.equal(result.written, false, '缺技术标注必须拒绝落盘')
  assert.equal(result.outcome, 'invalid')
  assert.equal(rawTestDesignText(store), '', '拒绝时盘上不许出现设计真源（不落半成品）')
  tdExpect(result.report, 'technique-missing', 'artifacts[4].technique', '新守卫要逐条点名缺技术标注')

  // 反向对照：把技术标注补成**尚未校验的**技术 ⇒ 仍不许落盘（unknown：没验过的不许当 ok）
  const scenario = tdWriteValidated(tdDesign([...tdBase(), { ...spare, technique: 'scenario' }]))
  assert.equal(scenario.written, false, 'scenario 尚未被校验 ⇒ 仍然不许落盘')
  assert.equal(scenario.outcome, 'unknown', '没验过的技术必须判 unknown（不能假装 ok）')
  tdExpect(scenario.report, 'technique-deferred', 'artifacts[4].technique', '未校验的技术要显式报未覆盖')

  // 补成本卡交付的四类之一 ⇒ 落盘（证明拦住前两次的确实是"技术标注"这一处）
  const ok = tdWriteValidated(tdDesign([...tdBase(), { ...spare, technique: 'equivalence' }]))
  assert.equal(ok.written, true, `补上四类技术之内的标注就应该落盘：${JSON.stringify(ok.report.issues)}`)
  assert.notEqual(rawTestDesignText(store), '', '这次要真的写出来')

  // 词表外的技术值 ⇒ 另一条码（与"没写"分开点名）
  const bogus = validateTestDesign(tdDesign(tdPatch(0, { technique: 'fuzz' })), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(bogus.outcome, 'unknown', '未知技术 ⇒ 判 unknown（没得可判），不是静默 ok')
  tdExpect(bogus, 'technique-unknown', 'artifacts[0].technique', '词表外的值要点名')
})

test('M33-25 四类技术缺一即判 unknown 并点名（没得可判 ≠ 判红）；空清单与"整份没必产项"各有码', () => {
  tdSeed()
  const artifacts = tdBase().filter((item) => item.technique !== 'state-transition')
  const missing = validateTestDesign(tdDesign(artifacts), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(missing.outcome, 'unknown', '缺一类技术 ⇒ unknown（不是 invalid：问题不在"写错了"，在"没写"）')
  assert.match(missing.unknownReason, /state-transition/u, `unknown 的原因要点到缺哪一类：${missing.unknownReason}`)
  tdExpect(missing, 'technique-missing', 'artifacts', '缺的技术要点名')

  const empty = validateTestDesign(tdDesign([]), { known: TD_FACTS })
  assert.equal(empty.outcome, 'unknown')
  tdExpect(empty, 'technique-missing', 'artifacts', '空清单要判 unknown 并点名')

  const hollow = validateTestDesign({}, { known: TD_FACTS })
  assert.equal(hollow.outcome, 'unknown')
  tdExpect(hollow, 'technique-missing', 'artifacts', '整份真源没有 artifacts 要判 unknown 并点名')
})

test('M33-26 每条用例可回溯到需求或设计元素（DoD 第 2 条）：读数矩阵逐条给出需求/设计元素', () => {
  tdSeed()
  const design = tdDesign(tdBase())
  const report = validateTestDesign(design, { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(report.outcome, 'ok', report.issues.map((issue) => issue.message).join('；'))

  const rows = testDesignTraceability(design)
  const ids = rows.map((row) => row.useCase)
  // 基线四类技术一共引用了 7 条用例（其余 5 条是本段为"台账里必须有"准备的陪衬）
  assert.deepEqual([...ids].sort(), ['TC-TD-01', 'TC-TD-02', 'TC-TD-03', 'TC-TD-04', 'TC-TD-05', 'TC-TD-06', 'TC-TD-07'], `矩阵要覆盖全部被引用的用例：${ids.join(' ')}`)
  assert.equal(testDesignCoverage(design).filter((row) => row.declared > 0).length, 4, '覆盖读数要逐技术给行')
  for (const id of ['TC-TD-01', 'TC-TD-04', 'TC-TD-07']) {
    const row = rows.find((item) => item.useCase === id)
    assert.ok(row !== undefined, `${id} 要有追溯行`)
    assert.ok(row.requirements.includes('REQ-048'), `${id} 必须回溯到 REQ-048：${row.requirements.join(' ')}`)
    assert.deepEqual(row.untechniqued, [], `${id} 的引用方都不该缺技术标注`)
  }
  // 用例 ↔ 必产项的双向都读得出来
  assert.ok((rows.find((item) => item.useCase === 'TC-TD-04')?.artifacts ?? []).includes('ART-003'), '判定表的用例要能反查到必产项 id')

  // 回溯不到需求/设计元素 ⇒ 判红
  const orphan = validateTestDesign(tdDesign(tdPatch(0, { requirementRef: [], designRef: [] })), { known: TD_FACTS })
  assert.equal(orphan.outcome, 'invalid')
  tdExpect(orphan, 'traceability-missing', 'artifacts[0].requirementRef', '回溯不到需求或设计元素要判红')

  // 挂到设计元素上也认（DoD 说"需求**或**设计元素"）
  const byDesign = validateTestDesign(tdDesign(tdPatch(0, { requirementRef: [], designRef: ['DES-031'] })), { known: TD_FACTS })
  assert.equal(byDesign.outcome, 'ok', `只挂设计元素也要算可回溯：${byDesign.issues.map((issue) => issue.message).join('；')}`)

  // 用例引用链的另一端缺技术标注 ⇒ 点名（"缺项点名"，不静默）
  const mixed = tdBase()
  const head = mixed[0]
  assert.ok(head !== undefined)
  delete head.technique
  const named = validateTestDesign(tdDesign(mixed), { known: TD_FACTS, testCaseIds: TD_CASES })
  tdExpect(named, 'technique-missing', 'artifacts[0].technique', '缺标注的那条要被点名')

  // 引用了**台账里没有**的用例 ⇒ 判红
  const ghost = validateTestDesign(tdDesign(tdPatch(0, { useCases: ['TC-TD-01', 'TC-999'] })), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(ghost.outcome, 'invalid')
  tdExpect(ghost, 'usecase-unknown', 'artifacts[0].useCases[1]', '台账里没有的用例要点名')
})

test('M33-27 边界值：域不适用时写 `na` + 理由可放过（整条不必给边界表）；理由只有一个字则判红', () => {
  tdSeed()
  const na = tdPatch(1, { na: '该域无有序取值：枚举型，没有"边界点"可言', boundaries: undefined })
  const ok = validateTestDesign(tdDesign(na), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(ok.outcome, 'ok', `显式声明不适用 + 理由 ⇒ 放过：${ok.issues.map((issue) => `${issue.code}@${issue.field}`).join(' ')}`)
  // `na` 只算声明、不算"给出了必产项"
  assert.equal(tdRow(ok, 'boundary').declared, 1, '声明数照算')
  assert.equal(tdRow(ok, 'boundary').covered, 0, '`na` 不能被读数洗成"给出了必产项"')

  const stub = validateTestDesign(tdDesign(tdPatch(1, { na: '无' })), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(stub.outcome, 'invalid')
  tdExpect(stub, 'artifact-incomplete', 'artifacts[1].na', '理由只有一个字要判红')

  const empty = validateTestDesign(tdDesign(tdPatch(1, { boundaries: [] })), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(empty.outcome, 'invalid')
  tdExpect(empty, 'artifact-incomplete', 'artifacts[1].boundaries', '既没说 `na` 也没有边界点 ⇒ 判红')
})

test('M33-28 状态迁移表要自洽：迁移端点必须在状态表里、非法迁移必须点名表里真有的迁移', () => {
  tdSeed()
  const ghostState = tdPatch(3, {
    transitions: [
      { id: 'T1', from: 'ready', to: 'ghost', on: 'claim', useCases: ['TC-TD-06'] },
      { id: 'T2', from: 'in-progress', to: 'done', on: 'done', useCases: ['TC-TD-06'] },
    ],
  })
  const report = validateTestDesign(tdDesign(ghostState), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(report.outcome, 'invalid')
  tdExpect(report, 'transition-inconsistent', 'artifacts[3].transitions[0].to', '状态表里没有的目标状态要点名')

  const ghostTransition = tdPatch(3, {
    invalidTransitions: [{ id: 'T9', reason: '不该发生', useCases: ['TC-TD-07'] }],
  })
  const bad = validateTestDesign(tdDesign(ghostTransition), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(bad.outcome, 'invalid')
  tdExpect(bad, 'transition-inconsistent', 'artifacts[3].invalidTransitions[0].id', '非法迁移必须点名表里真有的迁移')

  const noInvalid = tdPatch(3, { invalidTransitions: [] })
  const none = validateTestDesign(tdDesign(noInvalid), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(none.outcome, 'invalid')
  tdExpect(none, 'artifact-incomplete', 'artifacts[3].invalidTransitions', '不给非法迁移清单要判红（只测合法迁移会漏掉"该拒的拒了没有"）')
})

test('M33-29 判定表的动作桩与规则必须对得上：规则引用了桩里没有的动作即判红', () => {
  tdSeed()
  const bad = tdPatch(2, {
    rules: [
      { id: 'R1', conditions: ['1', '1'], actions: ['A9'], useCases: ['TC-TD-04'] },
      { id: 'R2', conditions: ['1', '0'], actions: ['A1'], useCases: ['TC-TD-05'] },
      { id: 'R3', conditions: ['0', '1'], actions: ['A2'], useCases: ['TC-TD-04'] },
      { id: 'R4', conditions: ['0', '0'], actions: ['A1'], useCases: ['TC-TD-05'] },
    ],
  })
  const report = validateTestDesign(tdDesign(bad), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(report.outcome, 'invalid')
  tdExpect(report, 'artifact-incomplete', 'artifacts[2].rules[0].actions[0]', '规则引用了动作桩里没有的动作要点名')

  const noConditions = tdPatch(2, { conditions: [] })
  const hollow = validateTestDesign(tdDesign(noConditions), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(hollow.outcome, 'invalid')
  tdExpect(hollow, 'artifact-incomplete', 'artifacts[2].conditions', '没有条件桩要判红')
})

test('M33-30 fail-closed：读不动/形状怪一律 unknown（不是 ok）；落盘闸门只认 ok', () => {
  tdSeed()
  // ① 整份不是映射
  const notMap = validateTestDesign('artifacts: []', { known: TD_FACTS })
  assert.equal(notMap.outcome, 'unknown')
  assert.notEqual(notMap.unknownReason, '')
  tdExpect(notMap, 'unknown', '', '整份不是映射要点名')

  // ② artifacts 不是列表
  const notList = validateTestDesign({ artifacts: { a: 1 } }, { known: TD_FACTS })
  assert.equal(notList.outcome, 'unknown')
  tdExpect(notList, 'unknown', 'artifacts', 'artifacts 不是列表要点名')

  // ③ 列表项不是映射：该项点名，其余照旧核
  const mixed: unknown[] = [...tdBase(), '这不是一条必产项']
  const report = validateTestDesign(tdDesign(mixed), { known: TD_FACTS, testCaseIds: TD_CASES })
  assert.equal(report.outcome, 'invalid')
  tdExpect(report, 'unknown', 'artifacts[4]', '列表项不是映射要逐项点名')

  // ④ 落盘闸门：unknown 与 invalid 都不写盘（盘上已有的那份不许被动过）
  const first = tdWriteValidated(tdDesign(tdBase()))
  assert.equal(first.written, true)
  const onDisk = rawTestDesignText(store)
  const blocked = tdWriteValidated(notMap)
  assert.equal(blocked.written, false)
  assert.equal(blocked.outcome, 'unknown')
  assert.equal(rawTestDesignText(store), onDisk, 'unknown 不许动盘上已有的真源')
})

test('M33-31 渲染面同址：真源落在 testing/design.yml（与 testingStore 的 design 类第一个文件一致）', () => {
  tdSeed()
  const result = tdWriteValidated(tdDesign(tdBase()))
  assert.equal(result.written, true)
  assert.equal(result.path, TEST_DESIGN_PATH)
  assert.equal(TEST_DESIGN_PATH, 'testing/design.yml')
  assert.deepEqual(store.listNames('testing'), ['design.yml'], '只写黑盒那一个文件（白盒是 TASK-015 的事）')
  // 根键与 testingStore 的口径一致：`design`
  const raw = store.readYaml<Record<string, unknown>>('testing', 'design.yml')
  assert.ok(raw !== undefined && TEST_DESIGN_ROOT_KEY in raw, `根键必须是 design：${JSON.stringify(raw)}`)
  // 读回后再次落盘：内容没变 ⇒ 指纹不变（幂等）
  const again = tdWriteValidated(tdDesign(tdBase()))
  assert.equal(again.hash, result.hash, '同一内容两次落盘必须同一指纹')
  assert.equal(again.replaced, true, '第二次是覆盖')
})
