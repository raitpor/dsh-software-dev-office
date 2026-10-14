/**
 * rpsidease-reboren 第二份真机报告（`2026-10-05-测试报告-变更控制与门禁自锁.md`，SDO-16…SDO-30）的回归。
 *
 * 这一轮的主题是**自锁**与**类别**：
 *   · **SDO-16/17（blocker）**：消化变更这条路本身要先认领卡，而认领被 `change-not-digested` 全局封锁
 *     ⇒「用流程修流程」进不去（真机 TASK-128 连拒 4 轮，只能无卡直接执行）。修法：冻结只针对
 *     **施工/验证/交付**角色，流程侧角色（analyst/architect/office）可以开工去消化它，回执点名这条路。
 *   · **SDO-20（复发 7 次）**：`contract-test-missing` 只能逐卡豁免，而它会打到「工具面里没有
 *     `sdo_test`」的卡（评审/架构裁决/需求侧修正）⇒ 现在按**角色工具面**直接判 N/A（类别规则）。
 *   · **SDO-21**：认领被拒后卡没有 owner ⇒ `block` 也被 `not-owner` 拒，台账看不出"被机制卡住"。
 *     现在允许无主卡上报阻塞并记 `task/claim-blocked`。
 *   · **SDO-18**：`trace/linked` 里**施工期覆盖边**（`req-task`/`req-tc`）不进 `DESIGN.md`，
 *     但 C-25（文档新鲜度）此前一刀切 ⇒ 真机上补两条覆盖边就把刚渲染的文档判陈旧。
 *   · **SDO-19/26（事故）**：直接 `write` 覆盖 `.sdo/` 真源既不产生事件、又能毁掉正文（真机 23 条 DEV
 *     永久丢失）⇒ 写前**留快照**（不改行为，fail-open）。
 *   · **SDO-27**：单一子代理被复用 19 轮至上下文耗尽 ⇒ `sdo_plan action=next freshChild=true` 强制新起。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readFileSync as _rf, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { claim, report } from '../src/domain/collab.js'
import { doneGaps, doneNaNotes, readConstructionProfile, writeConstructionProfile } from '../src/domain/construction.js'
import { writeContract } from '../src/domain/contracts.js'
import { writeRequirement } from '../src/domain/requirements.js'
import { hashArtifact, isAdopted, recordTestCase, recordTestResult, verificationStats } from '../src/domain/records.js'
import type { TestResult } from '../src/domain/records.js'
import { oracleGaps, supportedOracle } from '../src/domain/evidence.js'
import type { SdoConfig } from '../src/config.js'
import type { Requirement, TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm39')
let store: SdoStore
let journal: Journal

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, '.sdo', 'tasks'), { recursive: true })
  mkdirSync(join(BASE, '.sdo', 'tests', 'results'), { recursive: true })
  store = new SdoStore(join(BASE, '.sdo'))
  journal = new Journal(store)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

function card(id: string, role: string, requirements: string[] = []): TaskCard {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    blockedBy: [], writeScopes: [`src/${id}/`], role: role as TaskCard['role'], size: 'small', revision: 1,
    status: 'ready', requirements, evidence: [], createdAt: '', updatedAt: '',
  }
  store.writeYaml(['tasks', `${id}.yml`], { task })
  return task
}

/** 造一个"已批准但未消化"的变更（真机形态）。 */
function approvedChange(): void {
  journal.append('change/requested', { id: 'CR-001', requirement: 'REQ-001' })
  journal.append('change/decided', { id: 'CR-001', decision: 'approved', by: 'human' })
}

/** **DEF-037**：`recordTestResult` 现在对账"用例是否存在" ⇒ 取成功分支（顺带断言真的成功）。 */
function recorded(outcome: ReturnType<typeof recordTestResult>): TestResult {
  assert.equal(outcome.ok, true, `夹具前提：用例必须已存在（${outcome.ok ? '' : outcome.detail}）`)
  return outcome.ok ? outcome.result : (undefined as never)
}

test('SDO-16 / SDO-17：未消化变更**不再锁死解冻路径**（流程侧角色可认领），其余角色仍被拒且回执点名出路', () => {
  approvedChange()
  // ① 施工/验证/交付角色：仍被拒（冻结是硬约束）
  const dev = card('TASK-100', 'developer')
  const blocked = claim(store, journal, { taskId: dev.id, owner: 'dev-a', expectedRevision: 1 })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.ok ? '' : blocked.code, 'change-not-digested')
  assert.match(blocked.ok ? '' : blocked.detail, /解冻路径/u, '被拒时要给出可执行的解除路径（SDO-17 的诉求）')
  assert.match(blocked.ok ? '' : blocked.detail, /analyst/u, '要点名哪些角色能开工')

  // ② 流程侧角色（需求/架构）：可以认领 —— 它们就是消化变更的那条路
  for (const [id, role] of [['TASK-128', 'analyst'], ['TASK-129', 'architect']] as const) {
    const flow = card(id, role)
    const ok = claim(store, journal, { taskId: flow.id, owner: 'cockpit', expectedRevision: 1 })
    assert.equal(ok.ok, true, `${role} 的解冻卡必须能认领（真机：TASK-128 被同一检查连拒 4 轮）`)
  }
})

test('SDO-20 / TASK-056：`contract-test-missing` 判不判看**有没有契约对象**，不看角色工具面', () => {
  // contract-first 画像 + 两张**没有契约对象**的卡（写范围 `src/<id>/`、无需求 ⇒ contractsOfCard 为空）
  writeConstructionProfile(store, {
    version: 1, decidedAt: '', decidedBy: 'office', packages: ['contract-first'], scope: 'all',
    derivedFrom: ['scale=critical'], reason: 'r', exempt: [], history: [],
  })
  const reviewer = card('TASK-200', 'reviewer')
  const developer = card('TASK-201', 'developer')
  const gapsFor = (task: TaskCard): string[] =>
    doneGaps(store, journal, task, readConstructionProfile(store).profile, { scale: 'critical' }).map((item) => item.check)

  // ① **本卡没有契约对象 ⇒ N/A**（与角色无关：developer 也一样 N/A）。
  //    旧口径靠"角色工具面里没有 sdo_test"判 —— 那是**按角色**而不是**按对象**，表达不了类别
  //    （SDO-20 因此复发 7 次）。**TASK-056** 改成按卡的写范围路径 + 契约台账判，并给出机械可核的理由。
  for (const [label, task] of [['评审角色', reviewer], ['developer 角色', developer]] as const) {
    assert.equal(gapsFor(task).includes('contract-test-missing'), false, `${label}：没有契约对象 ⇒ 不判`)
    const notes = doneNaNotes(store, task, readConstructionProfile(store).profile, { scale: 'critical' })
    const contractNote = notes.find((note) => note.includes('contract-test-missing'))
    assert.ok(contractNote !== undefined, `${label}：必须写下**为什么** N/A（不许静默跳过）`)
    assert.ok(contractNote.includes('contractsOfCard'), `${label}：理由要写清判定依据`)
  }

  // ② **本卡挂着契约对象 ⇒ 照旧判红**（不许因为"角色没有 sdo_test"就放过）。
  //    契约测试记录是**台账**，与角色工具面无关 —— 判据只对"不存在的对象"让路，不对"没权限的人"让路。
  writeRequirement(store, {
    id: 'REQ-910', title: 'm39 契约需求', kind: 'functional', statement: 's', priority: 'must',
    acceptance: [], status: 'baselined', version: 1, createdAt: '', updatedAt: '',
  } as unknown as Requirement)
  writeContract(store, {
    id: 'CT-910', name: 'm39 探针契约', kind: 'schema', producer: 'p', consumer: 'c',
    schema: 'x', requires: ['REQ-910'], at: '',
    failureSemantics: { timeout: 't', retry: 'r', idempotency: 'i' },
  })
  for (const [label, id, role] of [['评审角色', 'TASK-200', 'reviewer'], ['developer 角色', 'TASK-201', 'developer']] as const) {
    const hooked = card(id, role, ['REQ-910'])
    assert.equal(gapsFor(hooked).includes('contract-test-missing'), true, `${label}：挂在契约上 ⇒ 该检查照旧生效（不许放宽）`)
    assert.deepEqual(
      doneNaNotes(store, hooked, readConstructionProfile(store).profile, { scale: 'critical' })
        .filter((note) => note.includes('contract-test-missing')),
      [],
      `${label}：判红的那条不许同时报 N/A`,
    )
  }
})

test('SDO-21：认领被拒后卡没有 owner ⇒ `block` 仍可用，并记 `task/claim-blocked`（台账看得出"被机制卡住"）', () => {
  const task = card('TASK-300', 'developer')
  const failed = claim(store, journal, { taskId: task.id, owner: 'nobody', expectedRevision: 99 })
  assert.equal(failed.ok, false, '先用 CAS 失败制造"没有 owner 的卡"')

  const blocked = report(store, journal, { taskId: task.id, owner: 'dev-a', status: 'blocked', note: '被 change-not-digested 拦住，未开工' })
  assert.equal(blocked.ok, true, `无主卡的阻塞必须能记账：${blocked.ok ? '' : blocked.detail}`)
  assert.equal(blocked.ok ? blocked.task.status : '', 'blocked')
  const events = journal.read().events.filter((event) => event.type === 'task/claim-blocked')
  assert.equal(events.length, 1, '要与真正的 task/blocked 分开留痕')
  assert.match(String(events[0]?.data.reason ?? ''), /未开工/u)

  // 反向：**有主卡**仍只认 owner（不许借这条路径替别人挂起）
  const owned = card('TASK-301', 'developer')
  claim(store, journal, { taskId: owned.id, owner: 'owner-a', expectedRevision: 1 })
  const wrong = report(store, journal, { taskId: owned.id, owner: 'someone-else', status: 'blocked', note: 'x' })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.ok ? '' : wrong.code, 'not-owner')
})

test('SDO-18：C-25 的"文档真源变更"按 kind 分流 —— 施工期覆盖边不再把刚渲染的文档判陈旧', () => {
  const gates = _rf(join(ROOT, 'src', 'domain', 'gates.ts'), 'utf8')
  assert.match(gates, /nonDocTraceEdge/u, 'C-25 的过滤要用同一个作用域口径')
  assert.match(gates, /kind === 'req-task' \|\| kind === 'req-tc'/u)
  // 反向：拿不到 kind 时仍保守视为"会改文档"（黑名单方向不变）—— 由同一函数的两条分支保证
  assert.match(gates, /if \(event\.type !== 'trace\/linked' && event\.type !== 'trace\/unlinked'\) return false/u)
})

test('SDO-19 / SDO-26：直接写 `.sdo/` 真源前**留快照**（事故：23 条 DEV 正文永久丢失），且对非真源路径不产生噪音', () => {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  const call = { sessionId: 'cockpit', cwd: BASE }
  const target = join(BASE, '.sdo', 'design', 'deviations.yml')
  mkdirSync(join(BASE, '.sdo', 'design'), { recursive: true })
  writeFileSync(target, 'DEV-001: 原始正文（会被覆盖）\n', 'utf8')

  const snapshot = office.snapshotTruthFile(call, '.sdo/design/deviations.yml')
  assert.ok(snapshot !== undefined && snapshot.includes('file-history'), `要落到 evidence/file-history：${String(snapshot)}`)
  assert.match(readFileSync(join(BASE, String(snapshot)), 'utf8'), /原始正文/u, '快照必须是**覆盖前**的内容')

  // 反向：非 `.sdo/` 路径、以及 journal 自身，都不留快照（不制造噪音）
  writeFileSync(join(BASE, 'src-notes.md'), 'x', 'utf8')
  assert.equal(office.snapshotTruthFile(call, 'src-notes.md'), undefined)
  assert.equal(office.snapshotTruthFile(call, '.sdo/journal.jsonl'), undefined)
})

test('SDO-23 / SDO-25 / SDO-27：architect 拿到 `edit`；confirm 接受 `basis`；派发支持强制新起子代理', () => {
  const roles = _rf(join(ROOT, 'src', 'data', 'roles.yml'), 'utf8')
  const architect = roles.slice(roles.indexOf('- code: architect'), roles.indexOf('- code: office'))
  assert.match(architect, /allow: \[[^\]]*edit/u, 'architect 必须有 edit（否则只能「read 全文 → 整篇 write」，真机因此毁掉登记簿）')
  assert.doesNotMatch(architect, /deny: \[[^\]]*edit/u, 'edit 不能同时留在 deny 里')

  const receipt = _rf(join(ROOT, 'src', 'interface', 'designReceipt.ts'), 'utf8')
  assert.match(receipt, /args\.basis \?\? args\.note \?\? args\.reason/u, 'confirm 必须优先采纳 `basis`（用户授权原话）')
  const tools = _rf(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  assert.match(tools, /basis: typeof args\.basis === 'string'/u, '`basis` 要进 execute 映射（否则又在工具边界被静默丢掉）')
  assert.match(tools, /freshChild: args\.freshChild === true/u, '`freshChild` 要进 execute 映射')
  const index = _rf(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /reuseIdle: reuse\.supported && !freshChild/u, 'freshChild 要真的跳过复用')
})

// —————————————————————— TASK-020：结果采纳与判定基准（REQ-053 / REQ-054） ——————————————————————

/** 造一条**真实存在**的需求（`oracleGaps` 的验收标准类要指到它的 AC 编号）。 */
function requirement(id: string, acIds: string[] = ['AC-001']): Requirement {
  const now = new Date().toISOString()
  const item: Requirement = {
    id, title: id, kind: 'functional', statement: 's', rationale: 'r',
    source: { stakeholder: 'STK-01' }, priority: 'must',
    ambiguity: {
      score: 0, dimensions: {},
      open: [], needsReview: false,
      modelDimensions: {},
    } as Requirement['ambiguity'],
    acceptance: acIds.map((acId) => ({ id: acId, given: 'g', when: 'w', then: 't' })),
    status: 'baselined', version: 1, baseline: null,
    createdAt: now, updatedAt: now,
  }
  writeRequirement(store, item)
  return item
}

/** 造一份**真实存在且有失败语义**的契约（契约类 oracle 要指到它）。 */
function contract(id: string, failureSemantics = true): void {
  writeContract(store, {
    id, name: id, kind: 'rpc', producer: 'a', consumer: 'b', schema: '{}',
    failureSemantics: failureSemantics
      ? { timeout: '3s 后报超时', retry: '最多 2 次', idempotency: '按 caseId 幂等' }
      : { timeout: '', retry: '', idempotency: '' },
    at: new Date().toISOString(),
  })
}

test('REQ-053 / REQ-054：执行者 ≠ 采纳者机械可判 —— 自执行自采纳被拒，且**不点名不算拒**（缺执行者也不许采纳）', () => {
  const testCase = recordTestCase(store, journal, {
    title: '开发者自跑的单元结果', kind: 'unit', requirement: 'REQ-053', steps: ['跑'], expected: '通过',
    oracle: { kind: 'expert', ref: 'REQ-053', expert: '张三' },
  })
  const result = recorded(recordTestResult(store, journal, {
    caseId: testCase.id, status: 'pass', evidence: 'node --test（3 passed）',
    executedBy: 'dev-a', adoptedBy: 'dev-a', oracle: { kind: 'expert', ref: 'REQ-053', expert: '张三' },
  }))

  // ① **自执行自采纳被拒**（守卫用例：同一个人的执行与采纳不算数）
  const selfAdopted = supportedOracle(store, result, testCase)
  assert.equal(selfAdopted.ok, false, '执行者与采纳者相同必须判红')
  assert.equal(selfAdopted.ok ? '' : selfAdopted.code, 'self-adoption')
  assert.match(selfAdopted.ok ? '' : selfAdopted.detail, /dev-a/u, '拒的时候要点名是谁自采纳（可核对）')

  // ② 采纳者不同于执行者 ⇒ 通过
  const adopted = supportedOracle(store, { ...result, adoptedBy: 'reviewer-b' }, testCase)
  assert.equal(adopted.ok, true, `独立采纳者必须被接受：${adopted.ok ? '' : adopted.detail}`)

  // ②b 采纳者不同、但**采纳动作没有留痕**（采纳时刻缺失）⇒ 仍不算采纳
  //     （变异自证的存活体 M3：不钉这条，"采纳时刻必须留痕"就可以被删掉而无人察觉）
  const noStamp = supportedOracle(store, { ...result, adoptedBy: 'reviewer-b', adoptedAt: undefined }, testCase)
  assert.equal(noStamp.ok, false, '采纳必须留痕（缺采纳时刻不算采纳）')
  assert.equal(noStamp.ok ? '' : noStamp.code, 'not-adopted')

  // ③ 反向：**没有采纳者**不是"默认 OK"，而是明确判红（缺依据不予计入）
  const notAdopted = supportedOracle(store, { ...result, adoptedBy: undefined }, testCase)
  assert.equal(notAdopted.ok, false)
  assert.equal(notAdopted.ok ? '' : notAdopted.code, 'not-adopted')
  // ④ 边界：执行者缺失（老台账/未登记）同样不得被算作"独立采纳"——宁可不计入，也不许放行
  const noExecutor = supportedOracle(store, { ...result, executedBy: undefined, adoptedBy: 'reviewer-b' }, testCase)
  assert.equal(noExecutor.ok, false)
  assert.equal(noExecutor.ok ? '' : noExecutor.code, 'executor-missing')
})

test('REQ-054：判定基准四类逐类机械核对 —— 引用不存在即判红并点名；缺判定基准的用例不计入通过覆盖', () => {
  requirement('REQ-054', ['AC-212', 'AC-213'])
  contract('CT-001', true)
  contract('CT-002', false)
  writeFileSync(join(BASE, 'dist-out.js'), 'frozen-baseline\n', 'utf8')
  const baselineHash = hashArtifact(BASE, 'dist-out.js')

  const good = [
    { kind: 'acceptance', ref: 'REQ-054', criterion: 'AC-212' },
    { kind: 'contract', ref: 'CT-001' },
    { kind: 'baseline', ref: 'dist-out.js', baselineSha256: baselineHash },
    { kind: 'expert', ref: 'REQ-054', expert: '张三' },
  ] as const
  for (const oracle of good) {
    assert.deepEqual(oracleGaps(store, oracle, { workspace: BASE }), [], `${oracle.kind} 类的合法判定基准不该判红`)
  }

  // ① 验收标准类：AC 编号必须**真实存在于那条需求上**（指空 = 没判定基准）
  assert.match(oracleGaps(store, { kind: 'acceptance', ref: 'REQ-054', criterion: 'AC-999' }, { workspace: BASE })[0] ?? '', /AC-999/u)
  assert.match(oracleGaps(store, { kind: 'acceptance', ref: 'REQ-404', criterion: 'AC-212' }, { workspace: BASE })[0] ?? '', /REQ-404/u)
  // ② 契约类：契约必须真实存在，**且该契约有失败语义**
  assert.match(oracleGaps(store, { kind: 'contract', ref: 'CT-404' }, { workspace: BASE })[0] ?? '', /CT-404/u)
  const noSemantics = oracleGaps(store, { kind: 'contract', ref: 'CT-002' }, { workspace: BASE })
  assert.equal(noSemantics.length, 1)
  assert.match(noSemantics[0] ?? '', /失败语义/u)
  // ③ 基线类：必须绑哈希，且哈希要**现算对得上**（产物改动 ⇒ 判定基准过期）
  assert.match(oracleGaps(store, { kind: 'baseline', ref: 'dist-out.js' }, { workspace: BASE })[0] ?? '', /baselineSha256/u)
  assert.match(
    oracleGaps(store, { kind: 'baseline', ref: 'dist-out.js', baselineSha256: 'f'.repeat(64) }, { workspace: BASE })[0] ?? '',
    /现算/u,
  )
  // ④ 专家判断类：必须写明**判断人**（可追责），只写"专家"不算
  assert.match(oracleGaps(store, { kind: 'expert', ref: 'REQ-054' }, { workspace: BASE })[0] ?? '', /expert/u)
  // ⑤ 缺判定基准（`oracle` 没登记 / 空对象 / 取值域外的 kind）一律判红**并点名是哪条用例**
  //    （"点名"是 DoD 的原文要求：说了等于没说的缺口文案不算点名）
  const gap = oracleGaps(store, undefined, { workspace: BASE, caseId: 'TC-777', requirement: 'REQ-054' })
  assert.equal(gap.length, 1)
  assert.match(gap[0] ?? '', /TC-777/u, '必须点名是哪条用例缺判定基准')
  assert.match(gap[0] ?? '', /REQ-054/u, '并点名它覆盖的需求')
  assert.ok(oracleGaps(store, {} as never, { workspace: BASE }).length > 0, '空对象不算给了判定基准')

  // ⑥ 缺判定基准的用例**不计入通过覆盖**（降级口径），并在点名名单里可见
  const orphan = recordTestCase(store, journal, { title: '没有判定基准的用例', kind: 'unit', requirement: 'REQ-054', steps: ['跑'], expected: '通过' })
  const orphanResult = recorded(recordTestResult(store, journal, {
    caseId: orphan.id, status: 'pass', evidence: 'node --test（1 passed）', executedBy: 'dev-a', adoptedBy: 'reviewer-b',
  }))
  const stats = verificationStats(store, journal)
  assert.equal(stats.results, 1, '台账里确实有一条 pass 结果')
  assert.equal(stats.passedAdopted, 0, '**缺判定基准 ⇒ 不计入通过**（"记录了 pass"不等于"通过"）')
  assert.deepEqual(stats.unadopted, [orphanResult.id], '缺判定基准的通过结果必须进未采纳点名名单')

  // ⑦ 反向（不许一刀切）：判定基准齐备 + 独立采纳 ⇒ 计入通过、不进名单
  const sound = recordTestCase(store, journal, {
    title: '判定基准齐备', kind: 'unit', requirement: 'REQ-054', steps: ['跑'], expected: '通过',
    oracle: { kind: 'acceptance', ref: 'REQ-054', criterion: 'AC-213' },
  })
  const soundResult = recorded(recordTestResult(store, journal, {
    caseId: sound.id, status: 'pass', evidence: 'node --test（1 passed）', executedBy: 'dev-a', adoptedBy: 'reviewer-b',
  }))
  assert.equal(verificationStats(store, journal).passedAdopted, 1, '判定基准齐备 + 独立采纳的用例必须计入通过')
  assert.equal(verificationStats(store, journal).passed, 2, '`passed` 读数口径不变（仍是"台账里有几条 pass"）')
  const soundVerdict = isAdopted(store, soundResult, sound)
  assert.equal(soundVerdict.adopted, true, `独立采纳必须被接受：${soundVerdict.reason}`)
  assert.deepEqual(verificationStats(store, journal).unadopted, [orphanResult.id], '已独立采纳且判定基准齐备的结果不许被点名')
  // 反向②：**自执行自采纳**的结果同样不计入通过（守卫用例在统计这一侧的落点）
  const selfResult = recorded(recordTestResult(store, journal, {
    caseId: sound.id, status: 'pass', evidence: 'node --test（1 passed）', executedBy: 'dev-a', adoptedBy: 'dev-a',
  }))
  const selfVerdict = isAdopted(store, selfResult, sound)
  assert.equal(selfVerdict.adopted, false, '自己执行自己采纳不计入通过')
  assert.match(selfVerdict.reason, /自己给自己盖章/u, '理由要点明"自采纳"这条，而不是笼统说"未采纳"')
})
