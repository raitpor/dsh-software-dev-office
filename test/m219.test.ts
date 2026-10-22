/**
 * `M219`（`TASK-171` / 0.1.7 批 2）：**声明—判据覆盖（`C-70`）** ＋ 发布计划层三条判据的接线
 * ＋ `DEF-162` 的三个落点（认领面 / 建卡面 / 收口面）。
 *
 * 这一格守的是批 2 的 `U1`（「被写 = 被遵守」）与 `DEF-162`（「流程官只记账」）。四类反例，
 * 每一类都写成**四态**（合法绿 / 去掉守卫即红 / 控制组 / 反空转），不写"改回去会红"这类注释级承诺：
 *
 * | 格 | 合法绿 | 反例（必红） | 控制组 | 反空转 |
 * |---|---|---|---|---|
 * | `C-70` 需求有守 | 登记的用例真跑出 `pass` | 零边（`DEF-105`）/ 幽灵端点（`DEF-115`）/ 只 `skip`（`DEF-126`）/ 只登记不跑（`DEF-149`） | 非 must 不参与 | 基线棘轮：基线外的**新增**未设防点名 |
 * | `C-70` 验收准则 | 署名豁免（判据键真实存在） | 豁免缺批准人 / 引不存在的判据键（`DEF-135` 的机械化） | 需求级 pass **不给** AC 镀金 | 同一条声明只能被豁免一次 |
 * | `C-70` 契约 / 元素 / 纪律 | `contractTest` 记录 / `des-task` 边 / 掩码挡住 | 缺记录 / 缺边（`DEF-106`） | 纪律条目按 `roles.yml` 现算 | 三类计数各自非空 |
 * | `C-71`/`C-72`/`C-73`/`C-75` 接线 | 数据声明 + 引擎不补 | 缺声明 / 引擎补挂 ⇒ 点名 | 无 release 文件 ⇒ 不参与 / N/A | 判据 id 在流程内唯一 |
 * | `DEF-162` ① 认领面 | `subagent:developer:1` 认领 developer 卡 | `cockpit` 认领 developer 卡（真机样本 TASK-170） | 认不出形态的 owner 放行（fail-open） | 拒绝必须落 `task/claim-rejected` 且带 `cause` |
 * | `DEF-162` ② 建卡面 | 合法 role 建卡成功 | `role: cockpit` 的 suggestion **一张卡都不建** | `createTask` 直接抛错（防御纵深） | issue 点名合法集 |
 * | `DEF-162` ③ 收口面 | owner 角色 == 卡的角色 | `cockpit` 做的 developer 卡 / 认不出的 owner | 进行中的卡不判 | N/A 只在没有已收口卡时 |
 *
 * 写作约定（与 `test/m214.test.ts` 同规）：夹具里的字符串一律用英文（取值会被断言比较）；
 * 中文只出现在用例名与**断言消息**里 —— `test/m189.test.ts` 的读散文站点按身份登记，
 * 本文件的读散文站点必须是 **0**（所以要断言中文判词时一律走 `t()`/`fmt()` 取基准语言包，
 * 不用内联中文字面量）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { Config, resolveSettings } from '../src/config.js'
import {
  CLAIM_KINDS,
  OWNER_ROLE_FORMS,
  assessClaimCoverage,
  ownerClaimVerdict,
  ownerRoleFindings,
  ownerRoleOf,
} from '../src/domain/claimCoverage.js'
import { recordContractTest } from '../src/domain/construction.js'
import {
  CHECKERS,
  CLAIM_KIND_LABELS,
  GAP_PARITY_CHECK,
  DEFER_TRACE_CHECK,
  FREEZE_TRACE_CHECK,
  OWNER_ROLE_CHECK,
  OWNER_ROLE_CRITERION_ID,
  VERSION_SCOPE_CHECK,
  evaluateGate,
} from '../src/domain/gates.js'
import type { GateContext } from '../src/domain/gates.js'
import { fmt, locale as i18nLocale, setLocale, t } from '../src/domain/i18n.js'
import { CLAIM_COVERAGE_CHECK, CLAIM_COVERAGE_CRITERION_ID } from '../src/domain/claimCoverage.js'
import { countCjkLiterals } from '../src/domain/langScan.js'
import { createTask, writeTask } from '../src/domain/plan.js'
import { loadProcess } from '../src/domain/process.js'
import { recordTestCase, recordTestResult } from '../src/domain/records.js'
import { writeRelease } from '../src/domain/release.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { SoftwareDevOffice } from '../src/office.js'
import { readFileSync } from 'node:fs'
import type { Release, Requirement, TaskCard } from '../src/types.js'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

interface Env {
  dir: string
  store: SdoStore
  journal: Journal
}

/** 每格一个临时工作区（`dir` 是工作区根：`CHANGELOG.md` 在这里；台账在 `dir/.sdo`）。 */
function withEnv<T>(run: (env: Env) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m219-'))
  try {
    const store = new SdoStore(join(dir, '.sdo'))
    store.ensureLayout()
    return run({ dir, store, journal: new Journal(store) })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const waterfall = () => {
  const process = loadProcess('waterfall')
  assert.equal(process !== undefined, true, 'packaged waterfall process must load')
  return process as NonNullable<ReturnType<typeof loadProcess>>
}

/** 需求夹具（判据只读 `id` / `priority` / `acceptance`）。 */
function requirement(id: string, priority = 'must', acs: readonly string[] = []): Requirement {
  return {
    id,
    title: id,
    kind: 'functional',
    statement: 's',
    rationale: 'r',
    status: 'baselined',
    priority,
    source: 'user',
    acceptance: acs.map((ac) => ({ id: ac, given: 'g', when: 'w', then: 't' })),
    revision: 1,
    version: 1,
    createdAt: '',
    updatedAt: '',
  } as unknown as Requirement
}

function cardOf(id: string, status: TaskCard['status'], role = 'developer', owner?: string): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes: [],
    role,
    size: 'small',
    revision: 1,
    status,
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
    ...(owner === undefined ? {} : { owner }),
  } as unknown as TaskCard
}

function link(env: Env, from: string, to: string, kind: string): void {
  env.store.appendLine(['trace', 'links.jsonl'], JSON.stringify({ from, to, kind, at: '2026-10-22T00:00:00.000Z' }))
}

/** 登记一条用例 + 记一条结果（`status` 可给 `skip`：`DEF-126` 的标本形态）。 */
function caseWith(env: Env, requirementId: string, status: 'pass' | 'fail' | 'skip'): string {
  const testCase = recordTestCase(env.store, env.journal, {
    title: 'case',
    kind: 'unit',
    steps: ['s'],
    expected: 'e',
    requirement: requirementId,
  })
  const recorded = recordTestResult(env.store, env.journal, {
    caseId: testCase.id,
    status,
    evidence: 'node --test',
    executedBy: 'dev-1',
    adoptedBy: 'rev-1',
  })
  assert.equal(recorded.ok, true, `result fixture must land: ${recorded.ok ? '' : recorded.detail}`)
  return testCase.id
}

/** 只登记、不跑（`DEF-149` 的标本形态）。 */
function registeredCase(env: Env, requirementId: string): string {
  return recordTestCase(env.store, env.journal, {
    title: 'case',
    kind: 'unit',
    steps: ['s'],
    expected: 'e',
    requirement: requirementId,
  }).id
}

function ctxOf(env: Env, requirements: readonly Requirement[]): GateContext {
  return {
    workspace: env.dir,
    store: env.store,
    journal: env.journal,
    process: waterfall(),
    project: undefined,
    requirements,
    questions: [],
    risks: [],
    issues: [],
    feasibility: undefined,
    redTeamExecuted: false,
    redTeamDisabled: false,
    waivedGates: [],
    prototypeDir: 'prototype',
    prototypeThrowaway: false,
    riskConclusion: undefined,
  } as unknown as GateContext
}

function claimCriterion(env: Env, requirements: readonly Requirement[]): { ok: boolean; na: boolean; detail: string; remedy: string } {
  const result = CHECKERS[CLAIM_COVERAGE_CHECK]?.(ctxOf(env, requirements))
  assert.equal(result !== undefined, true, 'claims.gate-coverage must be registered in CHECKERS')
  return {
    ok: result?.ok === true,
    na: result?.na === true,
    detail: String(result?.detail ?? ''),
    remedy: String(result?.remedy ?? ''),
  }
}

function criterionOf(gate: { criteria: { id: string; ok: boolean; na?: boolean | undefined; detail: string; remedy?: string | undefined }[] }, id: string) {
  const found = gate.criteria.find((item) => item.id === id)
  assert.equal(found !== undefined, true, `gate must declare ${id}: ${gate.criteria.map((item) => item.id).join(' ')}`)
  return found as { id: string; ok: boolean; na?: boolean | undefined; detail: string; remedy?: string | undefined }
}

function releaseOf(id: string, scope: readonly string[], extra: Partial<Release> = {}): Release {
  return { id, packageVersion: id.replace(/^r-/u, ''), scope: { requirements: [...scope], acceptance: [] }, ...extra }
}

function frozen(release: Release): Release {
  return { ...release, frozenAtSeq: 1, frozenBy: 'human' }
}

/* ════════════════════════════════════════════════════════════════════════════════════════
 * `C-70`：声明—判据覆盖（元判据）
 * ════════════════════════════════════════════════════════════════════════════════════════ */

test('M219-01 C-70 四态：需求有守 / 零边必红（REQ-060 形态）/ 基线棘轮 / 补上守卫即绿', () => {
  withEnv((env) => {
    // 夹具：REQ-060（零边、零用例）+ REQ-061（有登记的用例且真跑出 pass）
    caseWith(env, 'REQ-061', 'pass')
    const requirements = [requirement('REQ-060', 'must', ['AC-900']), requirement('REQ-061', 'must', ['AC-901'])]

    // ① 没有基线 + 有未设防 ⇒ 判红，且**点名** REQ-060（本批的第一条验证）
    const red = claimCriterion(env, requirements)
    assert.equal(red.ok, false, `unguarded declarations must fail: ${red.detail}`)
    assert.equal(red.detail.includes('REQ-060'), true, `the receipt must name REQ-060: ${red.detail}`)
    assert.equal(red.detail.includes(t('uiGates.kClaimNoBaseline')), true, 'the receipt must say the baseline is not declared')

    // ② 登记基线（已知缺口）⇒ 绿；**点名仍然在**（可见即约束，不许因为进了基线就闭嘴）
    env.store.writeYaml(['config.yml'], { claimCoverage: { baseline: ['REQ-060', 'AC-900', 'AC-901'] } })
    const green = claimCriterion(env, requirements)
    assert.equal(green.ok, true, `baselined gaps must not fail (ratchet): ${green.detail}`)
    assert.equal(green.detail.includes('REQ-060'), true, `baselined gaps stay visible: ${green.detail}`)

    // ③ 反空转：基线外的**新增**未设防 ⇒ 立刻红并点名（这是棘轮的方向）
    const grown = [...requirements, requirement('REQ-062', 'must')]
    const regressed = claimCriterion(env, grown)
    assert.equal(regressed.ok, false, `a new unguarded declaration must fail: ${regressed.detail}`)
    assert.equal(regressed.detail.includes('REQ-062'), true, `the receipt must name the new one: ${regressed.detail}`)

    // ④ 控制组：给 REQ-062 补上守卫 ⇒ 绿，且它从基线可退役名单里出现
    caseWith(env, 'REQ-062', 'pass')
    const fixed = claimCriterion(env, grown)
    assert.equal(fixed.ok, true, `after adding a guard it must be green: ${fixed.detail}`)
    const assessment = assessClaimCoverage({ store: env.store, requirements: grown, knownChecks: Object.keys(CHECKERS) })
    assert.equal(assessment.newUnguarded.some((row) => row.id === 'REQ-062'), false, 'REQ-062 is guarded now')
    assert.equal(assessment.unguarded.some((row) => row.id === 'REQ-061'), false, 'REQ-061 was guarded from the start')

    // ⑤ 非 must 不参与（控制组：判据不替人扩大战线）
    const onlyShould = assessClaimCoverage({
      store: env.store,
      requirements: [requirement('REQ-999', 'should')],
      knownChecks: Object.keys(CHECKERS),
    })
    assert.equal(onlyShould.rows.some((row) => row.kind === 'requirement'), false, 'should-requirements are out of scope')
  })
})

test('M219-02 假绿 ①（DEF-115 幽灵端点 / DEF-126 只 skip / DEF-149 只登记）：三种"看着有守卫"都不算数', () => {
  withEnv((env) => {
    const checks = Object.keys(CHECKERS)
    // 幽灵端点：`req-tc` 指向**未登记**的用例（ID 形态真，台账里没有它）
    link(env, 'REQ-070', 'TC-900', 'req-tc')
    // 只 skip：登记的用例 + 一条 skip 结果
    const skipped = caseWith(env, 'REQ-071', 'skip')
    link(env, 'REQ-071', skipped, 'req-tc')
    // 只登记不跑：登记的用例，零结果
    const registered = registeredCase(env, 'REQ-072')
    link(env, 'REQ-072', registered, 'req-tc')

    const requirements = [requirement('REQ-070'), requirement('REQ-071'), requirement('REQ-072')]
    const ghost = assessClaimCoverage({ store: env.store, requirements, knownChecks: checks })
    for (const id of ['REQ-070', 'REQ-071', 'REQ-072']) {
      assert.equal(ghost.unguarded.some((row) => row.id === id), true, `${id} must not count as guarded: ${ghost.unguarded.map((row) => row.id).join(' ')}`)
    }
    assert.deepEqual(ghost.ghostEdges, [{ requirement: 'REQ-070', caseId: 'TC-900' }], 'the ghost endpoint must be named as a ghost edge')

    const receipt = claimCriterion(env, requirements)
    assert.equal(receipt.detail.includes('REQ-070'), true, `the receipt must name the ghost-holding requirement: ${receipt.detail}`)
    assert.equal(receipt.detail.includes(fmt('uiGates.kClaimGhostEdge', { p1: 'REQ-070->TC-900', p2: '1' })), true, `the receipt must name the ghost edge itself: ${receipt.detail}`)

    // 补"登记 + 真跑" ⇒ 三处需求都有守；但**幽灵边本身还在**（修法①是清边，不是等它自己消失）
    caseWith(env, 'REQ-070', 'pass')
    caseWith(env, 'REQ-071', 'pass')
    caseWith(env, 'REQ-072', 'pass')
    const healed = assessClaimCoverage({ store: env.store, requirements, knownChecks: checks })
    for (const id of ['REQ-070', 'REQ-071', 'REQ-072']) {
      assert.equal(healed.unguarded.some((row) => row.id === id), false, `${id} must be guarded now`)
    }
    assert.deepEqual(healed.ghostEdges, [{ requirement: 'REQ-070', caseId: 'TC-900' }], 'the ghost edge keeps being named until the edge itself is removed (fix path 1)')
  })
})

test('M219-03 假绿 ②（DEF-135 / DEF-149 的 AC 面）：验收准则只能靠署名豁免，需求级 pass 不给它镀金', () => {
  withEnv((env) => {
    const checks = Object.keys(CHECKERS)
    caseWith(env, 'REQ-080', 'pass')
    const requirements = [requirement('REQ-080', 'must', ['AC-910', 'AC-911'])]
    const before = assessClaimCoverage({ store: env.store, requirements, knownChecks: checks })
    const acs = before.unguarded.filter((row) => row.kind === 'acceptance').map((row) => row.id)
    assert.deepEqual(acs, ['AC-910', 'AC-911'], `ACs without a channel must be unguarded: ${acs.join(' ')}`)

    // ② 有效豁免（判据键真实存在 + 理由 + 批准人）⇒ 只豁免一条，另一条照旧未设防
    env.store.writeYaml(['config.yml'], {
      claimCoverage: {
        exempt: [{ id: 'AC-910', criterion: 'tests.passed', reason: 'covered at requirement level', approvedBy: 'human' }],
      },
    })
    const after = assessClaimCoverage({ store: env.store, requirements, knownChecks: checks })
    const exempted = after.rows.find((row) => row.id === 'AC-910')
    assert.equal(exempted?.verdict, 'exempted', 'a complete exemption must be accepted')
    assert.equal(exempted?.guard, 'tests.passed', 'the exemption must point at the real criterion key')
    assert.equal(after.unguarded.some((row) => row.id === 'AC-911'), true, 'the other AC stays unguarded')

    // ③ 反例：豁免引用的判据键**不存在** ⇒ 不成立、逐条点名（散文不算豁免）
    env.store.writeYaml(['config.yml'], {
      claimCoverage: {
        exempt: [{ id: 'AC-910', criterion: 'claims.made-up', reason: 'because', approvedBy: 'human' }],
      },
    })
    const broken = assessClaimCoverage({ store: env.store, requirements, knownChecks: checks })
    assert.equal(broken.issues.some((issue) => issue.code === 'exemption-unknown-criterion' && issue.id === 'AC-910'), true, 'an unknown criterion key must be rejected')
    assert.equal(broken.rows.find((row) => row.id === 'AC-910')?.verdict, 'unguarded', 'a broken exemption leaves the row unguarded')
    const receipt = claimCriterion(env, requirements)
    assert.equal(receipt.ok, false, `a broken exemption must fail: ${receipt.detail}`)
    assert.equal(receipt.detail.includes(fmt('uiGates.kClaimIssueUnknownCriterion', { p1: 'AC-910', p2: 'claims.made-up' })), true, `the receipt must name the unknown key: ${receipt.detail}`)

    // ④ 反例：缺批准人 / 缺理由 ⇒ 同样不成立
    env.store.writeYaml(['config.yml'], { claimCoverage: { exempt: [{ id: 'AC-910', criterion: 'tests.passed' }] } })
    const incomplete = assessClaimCoverage({ store: env.store, requirements, knownChecks: checks })
    assert.equal(incomplete.issues.some((issue) => issue.code === 'exemption-no-reason'), true, 'missing reason must be rejected')
    assert.equal(incomplete.issues.some((issue) => issue.code === 'exemption-no-approver'), true, 'missing approver must be rejected')
    assert.equal(incomplete.rows.find((row) => row.id === 'AC-910')?.verdict, 'unguarded', 'an incomplete exemption leaves the row unguarded')

    // ⑤ 反例：豁免指向不存在的声明（写错号）
    env.store.writeYaml(['config.yml'], {
      claimCoverage: { exempt: [{ id: 'AC-999', criterion: 'tests.passed', reason: 'r', approvedBy: 'human' }] },
    })
    const stray = assessClaimCoverage({ store: env.store, requirements, knownChecks: checks })
    assert.equal(stray.issues.some((issue) => issue.code === 'exemption-no-target' && issue.id === 'AC-999'), true, 'an exemption for a missing declaration must be rejected')
  })
})

test('M219-04 假绿 ③（DEF-106 契约 / 设计元素 / 纪律条目）：三类声明的机判器各有各的证据', () => {
  withEnv((env) => {
    const checks = Object.keys(CHECKERS)
    env.store.writeYaml(['contracts', 'CT-900.yml'], {
      contract: {
        id: 'CT-900',
        name: 'CT-900',
        kind: 'http',
        producer: 'a',
        consumer: 'b',
        schema: 's',
        failureSemantics: { timeout: 't', retry: 'r', idempotency: 'i' },
        requires: [],
        at: '2026-10-22T00:00:00.000Z',
      },
    })
    env.store.writeYaml(['design', 'component.yml'], {
      view: {
        kind: 'component',
        name: 'component',
        elements: [{ id: 'DES-900', name: 'DES-900', kind: 'component', responsibility: 'r', requires: [] }],
      },
    })

    const before = assessClaimCoverage({ store: env.store, requirements: [], knownChecks: checks })
    assert.equal(before.unguarded.some((row) => row.id === 'CT-900'), true, 'a contract without a contractTest record must be unguarded')
    assert.equal(before.unguarded.some((row) => row.id === 'DES-900'), true, 'a design element without a des-task edge must be unguarded')
    // 纪律条目：机器面就是掩码表 —— 它们必须**全部**有守（不然 C-70 就在指控自己的运行时）
    const discipline = before.counts.discipline
    assert.equal(discipline.declared > 0, true, 'discipline entries come from packaged roles.yml')
    assert.equal(discipline.gated, discipline.declared, `every deny row must be enforced by the mask: ${discipline.gated}/${discipline.declared}`)

    // 补守卫 ⇒ 绿
    recordContractTest(env.store, { task: 'TASK-900', contract: 'CT-900', tool: 'node --test', cmd: 'node --test', at: '2026-10-22T00:00:00.000Z' })
    link(env, 'DES-900', 'TASK-900', 'des-task')
    const after = assessClaimCoverage({ store: env.store, requirements: [], knownChecks: checks })
    assert.equal(after.unguarded.some((row) => row.id === 'CT-900'), false, 'a contractTest record guards the contract')
    assert.equal(after.unguarded.some((row) => row.id === 'DES-900'), false, 'a des-task edge guards the design element')
    assert.equal(after.unguarded.length, 0, `nothing else may be unguarded: ${after.unguarded.map((row) => row.id).join(' ')}`)
    const receipt = claimCriterion(env, [])
    assert.equal(receipt.ok, true, `all guarded => green: ${receipt.detail}`)
    for (const kind of CLAIM_KINDS) {
      assert.equal(receipt.detail.includes(t(CLAIM_KIND_LABELS[kind])) || after.counts[kind].declared === 0, true, `the receipt must name the kind ${kind}`)
    }
  })
})

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 发布计划层三条判据的**接线**（数据声明 + 引擎不补）
 * ════════════════════════════════════════════════════════════════════════════════════════ */

test('M219-05 接线：四条判据写在流程数据里（id + check + 中文 desc），引擎不再补充挂载', () => {
  const process = waterfall()
  const declared = process.gates.flatMap((gate) => gate.criteria.map((criterion) => ({ gate: gate.id, ...criterion })))
  const wanted = [
    { id: 'C-71', check: VERSION_SCOPE_CHECK, gate: 'G6' },
    { id: 'C-72', check: GAP_PARITY_CHECK, gate: 'G7' },
    { id: 'C-73', check: DEFER_TRACE_CHECK, gate: 'G4' },
    { id: 'C-75', check: FREEZE_TRACE_CHECK, gate: 'G6' },
    { id: CLAIM_COVERAGE_CRITERION_ID, check: CLAIM_COVERAGE_CHECK, gate: 'G5' },
    { id: OWNER_ROLE_CRITERION_ID, check: OWNER_ROLE_CHECK, gate: 'G5' },
  ]
  for (const item of wanted) {
    const hits = declared.filter((criterion) => criterion.check === item.check)
    assert.equal(hits.length, 1, `${item.check} must be declared exactly once in process data (found ${hits.length})`)
    assert.equal(hits[0]?.id, item.id, `the criterion id of ${item.check} must be ${item.id}`)
    assert.equal(hits[0]?.gate, item.gate, `${item.check} must hang on ${item.gate}`)
    assert.equal(typeof CHECKERS[item.check], 'function', `${item.check} must be registered in CHECKERS`)
    const desc = String(hits[0]?.desc ?? '').trim()
    assert.equal(desc.length > 0, true, `${item.id} must carry a description`)
    assert.equal(/\p{Script=Han}/u.test(desc), true, `${item.id} must carry a Chinese description (data is the source of truth)`)
  }
  // 判据 id 在流程内唯一（M32-15 的同口径，这里独立再算一次）
  const ids = process.gates.flatMap((gate) => gate.criteria.map((criterion) => criterion.id))
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), [], 'criterion ids must be unique inside a process')

  withEnv((env) => {
    const ctx = ctxOf(env, [])
    // **引擎不再补充挂载**：每个门禁逐条判定的 id 必须**全部**来自流程数据（多一条就是引擎又补了）
    const declaredIds = new Set(declared.map((criterion) => criterion.id))
    for (const gateId of ['G4', 'G5', 'G6', 'G7']) {
      for (const criterion of evaluateGate(process, gateId, ctx).criteria) {
        assert.equal(declaredIds.has(criterion.id), true, `gate ${gateId} judged ${criterion.id}, which is not declared in process data (engine must not add criteria)`)
      }
    }
    // **没有 release 文件**：`C-71` 的激活条件不成立 ⇒ 它不参与；另外三条挂着但 N/A
    const g6 = evaluateGate(process, 'G6', ctx)
    assert.equal(g6.criteria.some((criterion) => criterion.id === 'C-71'), false, 'C-71 must not participate before the release layer is adopted')
    assert.equal(criterionOf(g6, 'C-75').na, true, 'C-75 is mounted but not applicable without release files')
    assert.equal(criterionOf(g6, 'C-75').detail.includes(t('uiGates.kReleaseLayerNotAdopted')), true, 'the N/A reason must name the release layer')
    assert.equal(criterionOf(evaluateGate(process, 'G4', ctx), 'C-73').na, true, 'C-73 is mounted but not applicable without release files')
    assert.equal(criterionOf(evaluateGate(process, 'G7', ctx), 'C-72').na, true, 'C-72 is mounted but not applicable without release files')

    // **有 release 文件**：C-71 参与（数据声明的 `when: releases` 生效）；这一格故意写成**没签**的草稿
    writeRelease(env.store, env.journal, releaseOf('r-0.1.7', ['REQ-001']))
    const withRelease = evaluateGate(process, 'G6', ctx)
    assert.equal(withRelease.criteria.some((criterion) => criterion.id === 'C-71'), true, 'C-71 must participate once a release file exists')
    assert.equal(criterionOf(withRelease, 'C-75').na !== true, true, 'C-75 must be judged once release files exist')
    assert.equal(criterionOf(withRelease, 'C-75').ok, false, 'the release written here is unsigned, so C-75 must fail')
  })
})

/* ════════════════════════════════════════════════════════════════════════════════════════
 * `C-73` / `C-75` / `C-72` 的四态
 * ════════════════════════════════════════════════════════════════════════════════════════ */

test('M219-06 C-73 四态：留痕合规 / 超上限必红 / 静默顺延必红 / 补留痕即绿', () => {
  withEnv((env) => {
    const process = waterfall()
    const ctx = ctxOf(env, [])
    // 旧版已冻结：`scope` 里承诺过 DEF-900；当前版一个字没提它（既不 scope、也不 nonScope）
    writeRelease(env.store, env.journal, frozen(releaseOf('r-0.1.6', ['REQ-001', 'DEF-900'])))
    writeRelease(env.store, env.journal, frozen(releaseOf('r-0.1.7', ['REQ-001'], {
      nonScope: [{ id: 'DEF-800', reason: 'later', deferCount: 1, approvedBy: 'human' }],
    })))
    // ① 静默顺延：DEF-900 从已冻结旧版的 scope 里消失，且真源没有 release/deferred 留痕 ⇒ 红并点名
    const silent = criterionOf(evaluateGate(process, 'G4', ctx), 'C-73')
    assert.equal(silent.ok, false, `a silent deferral must fail: ${silent.detail}`)
    assert.equal(silent.detail.includes('DEF-900'), true, `the receipt must name the silently deferred id: ${silent.detail}`)
    assert.equal(silent.detail.includes('defer-silent'), true, 'the finding kind is the machine face and must be printed')

    // ② 补一条真源留痕（`release/deferred`）⇒ 绿（这一路豁免读的是真源，不是调用方传的集合）
    env.journal.append('release/deferred', {
      ids: ['DEF-900'],
      fromVersion: '0.1.6',
      toVersion: '0.1.7',
      deferCount: 1,
      approvedBy: 'human',
      reason: 'moved out',
    })
    const healed = criterionOf(evaluateGate(process, 'G4', ctx), 'C-73')
    assert.equal(healed.ok, true, `a recorded deferral must clear the silent finding: ${healed.detail}`)

    // ③ 超上限：当前版 nonScope 的 deferCount 超过上限 ⇒ 红，且点名"需要用户裁决"
    env.store.writeYaml(['releases', 'r-0.1.7.yml'], {
      release: {
        id: 'r-0.1.7',
        packageVersion: '0.1.7',
        scope: { requirements: ['REQ-001'], acceptance: [] },
        nonScope: [{ id: 'DEF-800', reason: 'later', deferCount: 3, approvedBy: 'human' }],
        frozenBy: 'human',
        frozenAtSeq: 1,
      },
    })
    env.store.writeYaml(['config.yml'], { release: { deferLimit: 2 } })
    const over = criterionOf(evaluateGate(process, 'G4', ctx), 'C-73')
    assert.equal(over.ok, false, `exceeding the defer limit must fail: ${over.detail}`)
    assert.equal(over.detail.includes('DEF-800'), true, `the receipt must name the over-limit entry: ${over.detail}`)
    assert.equal(over.detail.includes('defer-count-over-limit'), true, 'the finding kind must be printed')
  })
})

test('M219-07 C-75 四态：没签必红 / 人签合规即绿 / 冻结后手改集合必红 / 走了变更即绿', () => {
  withEnv((env) => {
    const process = waterfall()
    const ctx = ctxOf(env, [])
    // ① 当前版没签（草稿）⇒ 红
    writeRelease(env.store, env.journal, releaseOf('r-0.1.7', ['REQ-001']))
    const unsigned = criterionOf(evaluateGate(process, 'G6', ctx), 'C-75')
    assert.equal(unsigned.ok, false, `an unsigned collection must fail: ${unsigned.detail}`)
    assert.equal(unsigned.detail.includes('collections-unsigned'), true, 'the finding kind must be printed')

    // ② 人签 + `frozenAtSeq` 指向真实发生的那一次落盘 ⇒ 绿
    const first = env.journal.read().events.at(-1)?.seq ?? 0
    const signed = { ...frozen(releaseOf('r-0.1.7', ['REQ-001'])), frozenAtSeq: first + 1 }
    writeRelease(env.store, env.journal, signed)
    const green = criterionOf(evaluateGate(process, 'G6', ctx), 'C-75')
    assert.equal(green.ok, true, `a human-signed collection must pass: ${green.detail}`)

    // ③ 冻结之后手改集合（不走 change）⇒ 红
    env.store.writeYaml(['releases', 'r-0.1.7.yml'], {
      release: {
        id: 'r-0.1.7',
        packageVersion: '0.1.7',
        scope: { requirements: ['REQ-001', 'REQ-002'], acceptance: [] },
        frozenBy: 'human',
        frozenAtSeq: signed.frozenAtSeq,
      },
    })
    const rewritten = criterionOf(evaluateGate(process, 'G6', ctx), 'C-75')
    assert.equal(rewritten.ok, false, `rewriting a frozen collection must fail: ${rewritten.detail}`)
    assert.equal(rewritten.detail.includes('collections-rewritten-after-freeze'), true, 'the finding kind must be printed')

    // ④ 冻结之后改集合 + 一条已决策的变更 ⇒ 绿（变更控制这条后路是通的）
    env.journal.append('change/decided', { id: 'CR-900', decision: 'approved' })
    const viaChange = criterionOf(evaluateGate(process, 'G6', ctx), 'C-75')
    assert.equal(viaChange.ok, true, `a decided change legitimises the rewrite: ${viaChange.detail}`)
  })
})

test('M219-08 C-72 四态：清单与集合相等即绿 / 隐瞒必红 / 粉饰必红 / 与脚本判定同源', async () => {
  const script = await import(new URL('../../scripts/gen-changelog.mjs', import.meta.url).href) as {
    checkGapParity: (input: { changelogText: string; releaseId: string; declaredIds: string[] }) => { ok: boolean }
  }
  const block = (release: string, rows: readonly string[]): string =>
    ['# CHANGELOG', '', `<!-- sdo:gap:begin release=${release} -->`, '### known gaps', ...rows, '<!-- sdo:gap:end -->', ''].join('\n')
  withEnv((env) => {
    const process = waterfall()
    const ctx = ctxOf(env, [])
    writeRelease(env.store, env.journal, frozen(releaseOf('r-0.1.7', ['REQ-001'], {
      nonScope: [{ id: 'DEF-900', reason: 'later', deferCount: 1, approvedBy: 'human' }],
    })))
    const cases: { text: string; ok: boolean; label: string }[] = [
      { text: block('r-0.1.7', ['- `DEF-900` - later']), ok: true, label: 'exactly equal' },
      { text: block('r-0.1.7', []), ok: false, label: 'hidden (set has it, list does not)' },
      { text: block('r-0.1.7', ['- `DEF-900` - later', '- `DEF-901` - padded']), ok: false, label: 'padding (list has what the set does not)' },
      { text: block('r-0.1.6', ['- `DEF-900` - later']), ok: false, label: 'marker belongs to another release' },
      { text: block('r-0.1.7', ['- some prose row without an id']), ok: false, label: 'prose row hides the id' },
    ]
    for (const row of cases) {
      writeFileSync(join(env.dir, 'CHANGELOG.md'), row.text)
      const judged = criterionOf(evaluateGate(process, 'G7', ctx), 'C-72')
      assert.equal(judged.ok, row.ok, `case ${row.label}: ${judged.detail}`)
      // **同源**：脚本的 `checkGapParity` 与门禁判据必须给同一个结论（两处实现不许分叉）
      const byScript = script.checkGapParity({ changelogText: row.text, releaseId: 'r-0.1.7', declaredIds: ['DEF-900'] })
      assert.equal(byScript.ok, row.ok, `case ${row.label}: the script and the gate must agree (script ok=${byScript.ok})`)
    }
    // 没有 CHANGELOG 文件 ⇒ 判红并点名当前版（无从对账）
    rmSync(join(env.dir, 'CHANGELOG.md'), { force: true })
    const missing = criterionOf(evaluateGate(process, 'G7', ctx), 'C-72')
    assert.equal(missing.ok, false, `a missing CHANGELOG must fail: ${missing.detail}`)
    assert.equal(missing.detail.includes('r-0.1.7'), true, 'the receipt must name the release it could not reconcile')
  })
})

/* ════════════════════════════════════════════════════════════════════════════════════════
 * `DEF-162`：三个面（认领 / 建卡 / 收口）
 * ════════════════════════════════════════════════════════════════════════════════════════ */

function officeAt(dir: string): SoftwareDevOffice {
  const office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', dir)
  return office
}

test('M219-09 DEF-162 ① 认领面：驾驶舱不得认领实现/测试卡（真机样本形态），认不出形态的 owner 放行', () => {
  withEnv((env) => {
    const office = officeAt(env.dir)
    const ctx = { sessionId: 's1' }
    office.init(ctx, { name: 'M219', scale: 'normal', stakeholders: ['user'] })
    writeTask(env.store, cardOf('TASK-910', 'planned', 'developer'))

    // ① 反例必红：`owner=cockpit` 认领 `role=developer`（真机 TASK-170 的形态）
    const denied = office.claimTask(ctx, { taskId: 'TASK-910', owner: 'cockpit', expectedRevision: 1 })
    assert.equal(denied.ok, false, 'the cockpit must not claim an implementation card')
    if (!denied.ok) {
      assert.equal(denied.detail.includes('developer'), true, `the receipt must name the card role: ${denied.detail}`)
      assert.equal(denied.detail.includes(OWNER_ROLE_FORMS), true, `the receipt must name the legal forms: ${denied.detail}`)
    }
    // 拒绝必须**留痕**，且这一类能单独聚合（`cause` 字段）
    const rejected = env.journal.read().events.filter((event) => event.type === 'task/claim-rejected')
    assert.equal(rejected.length, 1, 'a refused claim must leave exactly one event')
    assert.equal(rejected[0]?.data['cause'], 'owner-role', 'the rejection must be attributable to the owner role')

    // ② 控制组：认不出形态的 owner 放行（fail-open：认不出人不该变成干不了活）
    const anonymous = office.claimTask(ctx, { taskId: 'TASK-910', owner: 'dev-a', expectedRevision: 1 })
    assert.equal(anonymous.ok, true, `an unrecognisable owner must pass the claim face: ${anonymous.ok ? '' : anonymous.detail}`)

    // ③ 合法形态：`subagent:developer:1` 可以认领
    writeTask(env.store, cardOf('TASK-911', 'planned', 'developer'))
    const legal = office.claimTask(ctx, { taskId: 'TASK-911', owner: 'subagent:developer:1', expectedRevision: 1 })
    assert.equal(legal.ok, true, `a matching owner must claim: ${legal.ok ? '' : legal.detail}`)

    // ④ 流程官自己的卡照旧能认领（`office` 角色 == 卡的 role）
    writeTask(env.store, cardOf('TASK-912', 'planned', 'office'))
    const staff = office.claimTask(ctx, { taskId: 'TASK-912', owner: 'office', expectedRevision: 1 })
    assert.equal(staff.ok, true, `the process officer may claim its own cards: ${staff.ok ? '' : staff.detail}`)
  })
})

test('M219-10 DEF-162 ② 建卡面：非法 role 在**建卡那一刻**被拒并点名合法集，一张卡都不建', () => {
  withEnv((env) => {
    const office = officeAt(env.dir)
    const ctx = { sessionId: 's1' }
    office.init(ctx, { name: 'M219', scale: 'normal', stakeholders: ['user'] })

    // ① 反例必红：`role: cockpit` 的 suggestion
    const outcome = office.planDecompose(ctx, {
      suggestions: [{ title: 'impl', dod: ['d'], role: 'cockpit', writeScopes: ['src/x/'] } as never],
    })
    const issue = outcome.issues.find((item) => item.code === 'role-not-a-role')
    assert.equal(issue !== undefined, true, `the illegal role must be refused at creation: ${outcome.issues.map((item) => item.code).join(' ')}`)
    assert.equal(issue?.detail.includes('cockpit'), true, 'the issue must name the illegal role')
    assert.equal(issue?.detail.includes('developer'), true, 'the issue must name the legal set')
    assert.equal(outcome.tasks.some((task) => task.title === 'impl'), false, 'no card may be created for an illegal role')

    // ② 控制组：合法 role 照建（issuse 里没有这一条）
    const good = office.planDecompose(ctx, {
      suggestions: [{ title: 'impl-ok', dod: ['d'], role: 'developer', writeScopes: ['src/y/'] } as never],
    })
    assert.equal(good.tasks.some((task) => task.title === 'impl-ok'), true, 'a legal role must still create its card')
    assert.equal(good.issues.some((item) => item.code === 'role-not-a-role'), false, 'a legal role must not raise the issue')

    // ③ 防御纵深：直接调 `createTask` 也必须拒（唯一建卡入口，漏一层就是后门）
    assert.throws(
      () => createTask(env.store, env.journal, { title: 'x', dod: ['d'], role: 'cockpit' } as never),
      /cockpit/u,
      'createTask itself must refuse an illegal role',
    )
  })
})

test('M219-11 DEF-162 ③ 收口面（C-76）：已 done 卡的 owner 角色必须等于卡的 role；进行中的卡不判', () => {
  assert.equal(ownerRoleOf('subagent:developer:1'), 'developer', 'the真机 mainstream form must resolve')
  assert.equal(ownerRoleOf('cockpit'), 'cockpit', 'the cockpit form must resolve')
  // 真机台账里的形态是 `cockpit（代记：…）`（全角括号）；这里用 ASCII 括号做等价夹具，
  // 避免在**取值**里出现中文字面量（`test/m189.test.ts` 的读散文站点按身份登记，本文件必须是 0）。
  assert.equal(ownerRoleOf('cockpit(stand-in: legacy)'), 'cockpit', 'a bracketed note must not hide the role')
  assert.equal(ownerRoleOf('tester-V20-closure'), 'tester', 'the dash form must resolve')
  assert.equal(ownerRoleOf('dev-a'), undefined, 'an unrecognisable form must stay unrecognised (never guessed)')
  assert.equal(ownerClaimVerdict('cockpit', 'reviewer').ok, true, 'the claim face only blocks implementation/test cards')

  withEnv((env) => {
    const process = waterfall()
    const ctx = ctxOf(env, [])
    // ① N/A：一张已收口的卡都没有
    const none = criterionOf(evaluateGate(process, 'G5', ctx), OWNER_ROLE_CRITERION_ID)
    assert.equal(none.na, true, `no closed card => N/A: ${none.detail}`)

    // ② 反例必红：cockpit 做的 developer 卡 + 认不出的 owner + 无 owner，三种逐条点名
    writeTask(env.store, cardOf('TASK-920', 'done', 'developer', 'cockpit'))
    writeTask(env.store, cardOf('TASK-921', 'done', 'developer', 'settler'))
    writeTask(env.store, cardOf('TASK-922', 'done', 'developer'))
    // 控制组：角色对得上的、以及**进行中**的卡都不许被点名
    writeTask(env.store, cardOf('TASK-923', 'done', 'developer', 'subagent:developer:1'))
    writeTask(env.store, cardOf('TASK-924', 'in-progress', 'developer', 'cockpit'))

    const red = criterionOf(evaluateGate(process, 'G5', ctx), OWNER_ROLE_CRITERION_ID)
    assert.equal(red.ok, false, `mismatched owners must fail at close-out: ${red.detail}`)
    for (const id of ['TASK-920', 'TASK-921', 'TASK-922']) {
      assert.equal(red.detail.includes(id), true, `the receipt must name ${id}: ${red.detail}`)
    }
    assert.equal(red.detail.includes('TASK-923'), false, 'a matching owner must not be named')
    assert.equal(red.detail.includes('TASK-924'), false, 'an in-progress card is not judged')
    const findings = ownerRoleFindings([
      { id: 'TASK-920', status: 'done', role: 'developer', owner: 'cockpit' },
      { id: 'TASK-923', status: 'done', role: 'developer', owner: 'subagent:developer:1' },
    ])
    assert.deepEqual(findings.map((row) => row.reason), ['role-mismatch'], 'the machine face of the finding is the reason code')

    // ③ 修好 owner ⇒ 绿
    writeTask(env.store, { ...cardOf('TASK-920', 'done', 'developer', 'subagent:developer:2') } as TaskCard)
    writeTask(env.store, { ...cardOf('TASK-921', 'done', 'developer', 'developer-1') } as TaskCard)
    writeTask(env.store, { ...cardOf('TASK-922', 'done', 'developer', 'subagent:developer:3') } as TaskCard)
    const green = criterionOf(evaluateGate(process, 'G5', ctx), OWNER_ROLE_CRITERION_ID)
    assert.equal(green.ok, true, `all owners match => green: ${green.detail}`)
  })
})

/* ════════════════════════════════════════════════════════════════════════════════════════
 * 语言键 / i18n 棘轮：C-71 回执不再有硬编码技术串
 * ════════════════════════════════════════════════════════════════════════════════════════ */

test('M219-12 语言键：`uiGates.kScope*` 两包都有且非空，C-71 回执来自语言包，gates.ts 硬编码中文仍为 0', () => {
  const scopeKeys = ['kScopeLabel', 'kScopeNoRelease', 'kScopeNone', 'kScopeHeadline', 'kScopeFailClosed', 'kScopeLanded', 'kScopeTokens']
  const packs = ['src/data/lang/zh-CN.yml', 'src/data/lang/en.yml']
  for (const pack of packs) {
    const text = readFileSync(join(ROOT, pack), 'utf8')
    for (const key of scopeKeys) {
      const line = text.split('\n').find((row) => row.startsWith(`  ${key}: `))
      assert.equal(line !== undefined, true, `${pack} must carry ${key} (two packs move together)`)
      assert.equal((line ?? '').trim().length > `${key}: `.length, true, `${pack}.${key} must not be empty`)
    }
  }
  // 基准语言下回执逐句来自语言包（不是代码里的拼串）
  const base = i18nLocale()
  try {
    assert.equal(t('uiGates.kScopeTokens').includes('failClosed=['), true, 'the machine token must live in the lang pack, not in gates.ts')
    assert.equal(t('uiGates.kScopeTokens').includes('landedFrom=['), true, 'the machine token must live in the lang pack, not in gates.ts')
    assert.equal(t('uiGates.kScopeHeadline').includes('{p1}'), true, 'the human line must be a lang template')
  } finally {
    setLocale(base)
  }
  // 英文包也必须覆盖这些键（不是回退中文）
  try {
    setLocale('en')
    for (const key of scopeKeys) {
      const value = t(`uiGates.${key}`)
      assert.equal(/\p{Script=Han}/u.test(value), false, `en.${key} must not fall back to Chinese: ${value}`)
    }
  } finally {
    setLocale('zh-CN')
  }
  // i18n 棘轮：`gates.ts` 的硬编码中文必须仍是 0（口径未放宽）
  const gates = readFileSync(join(ROOT, 'src/domain/gates.ts'), 'utf8')
  assert.equal(countCjkLiterals(gates), 0, 'gates.ts must keep zero hard-coded Chinese literals')
  // 新模块也在同一份纪律里（判据文案一律走语言包）
  const claimCoverage = readFileSync(join(ROOT, 'src/domain/claimCoverage.ts'), 'utf8')
  assert.equal(countCjkLiterals(claimCoverage), 0, 'claimCoverage.ts is a domain module: no hard-coded user-facing Chinese')
  // `fmt` 与 `t` 的用法对齐（占位符模板必须用 `fmt`）
  assert.equal(fmt('uiGates.kScopeLabel', { p1: 'r-0.1.7', p2: '0.1.7' }), 'r-0.1.7@0.1.7', 'the scope label template must render')
})

test('M219-13 C-71 回执两行并存：人读一行来自语言包 + 机器 token 保留（m214 逐字钉住它）', () => {
  withEnv((env) => {
    const process = waterfall()
    const ctx = ctxOf(env, [])
    writeRelease(env.store, env.journal, frozen(releaseOf('r-0.1.7', ['REQ-001'])))
    const scope = criterionOf(evaluateGate(process, 'G6', ctx), 'C-71')
    assert.equal(scope.detail.includes(fmt('uiGates.kScopeLabel', { p1: 'r-0.1.7', p2: '0.1.7' })), true, `the human line must name the release: ${scope.detail}`)
    assert.equal(scope.detail.includes('scope=r-0.1.7@0.1.7'), true, 'the machine token must stay parseable')
    assert.equal(scope.detail.includes('failClosed=[]'), true, 'the machine token must carry the fail-closed list')
    assert.equal(scope.detail.includes(t('uiGates.kScopeNone')), true, 'the human line must render the empty marker from the pack')
  })
})
