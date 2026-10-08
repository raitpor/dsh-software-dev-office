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
  readContractTests,
  readConstructionProfile,
  readMutations,
  recordContractTest,
  recordMutation,
  redGreenGaps,
  validateDerivation,
  writeConstructionProfile,
} from '../src/domain/construction.js'
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

  writeConstructionProfile(store, profileOf({ packages: ['tdd', 'contract-first'], scope: ['TASK-001'], exempt: [{ task: 'TASK-001', check: 'tdd-red-green-missing', why: '纯文档卡' }] }))
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
    exempt: [{ task: 'TASK-001', check: 'nope-check', why: 'x' }],
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
  const exempt = profileOf({ packages: ['contract-first'], exempt: [{ task: 'TASK-002', check: 'contract-not-frozen', why: '契约在别处冻结' }] })
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
  const exempt = profileOf({ packages: ['tdd'], exempt: [{ task: 'TASK-002', check: 'tdd-mutation-missing', why: '纯文档卡' }] })
  assert.deepEqual(doneGaps(store, journal, other, exempt, { scale: 'critical' }), [], '豁免按卡+检查码生效')
  const third = writeCard('TASK-003', [])
  assert.equal(doneGaps(store, journal, third, exempt, { scale: 'critical' }).length, 1, '豁免只对写明的卡生效（TASK-003 没有豁免、也没有变异记录）')

  // contract-first：缺契约测试 ⇒ 拒
  const contractFirst = profileOf({ packages: ['contract-first'] })
  const noTest = doneGaps(store, journal, card, contractFirst)
  assert.equal(noTest.length, 1)
  assert.equal(noTest[0]?.check, 'contract-test-missing')
  recordContractTest(store, { task: 'TASK-001', contract: 'CT-001', tool: 'node --test', cmd: 'node --test test/ct001.test.js', at: '' })
  assert.deepEqual(doneGaps(store, journal, card, contractFirst), [])

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

