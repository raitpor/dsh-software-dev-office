/**
 * `M214`（`TASK-174` / `REQ-063` 批 1②）：**`C-71 作用域闭合`** —— 实现/验证/交付类门禁（G4/G6/G7）
 * 只对「本版 scope」判定，需求/设计类门禁（G2/G3）仍对全基线。
 *
 * 这一格守的是规格 `docs/plan/2026-10-22-规格-0.1.7批1-版本作用域.md` 的 §3.1 / §3.4 与反例表：
 *
 * | 守卫态 | 构造 | 期望 | 反例 |
 * |---|---|---|---|
 * | ① 作用域内 + 未闭合 | 本版 `scope` 含一条 `major/open` 缺陷 | 判红并**点名**该 id | `R1` |
 * | ② 本版明确不进 | 同一条移进 `nonScope`（reason / deferCount / `approvedBy: human`） | **绿**（本版不判它） | `R2` |
 * | ③ 没规划过 | 既不在 scope 也不在 nonScope | **判红**（缺省归入当前版本，不许当空集放过） | `R8` / `R9` |
 * | ④ 作用域内 + 全闭合 | 四类对象全部闭合 | **绿**，且把「缺省归入者」与「顺延到账者」**分开点名** | — |
 *
 * 另外三条独立守点（都不是上面四态的重复）：
 *   · **没有 release 文件 ⇒ fail-closed**：一份 release 都没有时"一切属于当前版本"（规格 R8/R9）——
 *     红侧不许因为"没有集合"就放过，绿侧也不许误伤（那不是"作用域为空集"）；
 *   · **`R11` 双向可观察**：只属 `r-0.1.7` 的 must 需求往 `r-0.1.6` 的 **G6** 丢 ⇒ **不判红**；
 *     往 **G2** 丢 ⇒ **进判定**（同一份夹具、同一次运行的两个结论）；
 *   · **既有语义不变**：`C-51` / `C-65` / `C-66` 的判定口径一字不动，变的是它们看到的**名单**
 *     （`C-51` 仍只管阻塞级；`wontfix` 仍只认 `waiveReason` + `waiveApprovedBy` 两字段）。
 *
 * 写作约定（与 `test/m213.test.ts` 同规）：夹具里的字符串一律用英文（取值会被断言比较），
 * 中文只出现在用例名与**断言消息**里 —— 散文站点棘轮（`test/m189.test.ts`）按身份登记，
 * 本文件的读散文站点数是 0，新增中文一律只进消息、不进取值。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { recordContractTest } from '../src/domain/construction.js'
import {
  CHECKERS,
  VERSION_SCOPED_GATE_IDS,
  VERSION_SCOPE_CHECK,
  VERSION_SCOPE_CRITERION_ID,
  evaluateGate,
  versionScopeOf,
} from '../src/domain/gates.js'
import type { GateContext } from '../src/domain/gates.js'
import { loadProcess } from '../src/domain/process.js'
import { recordTestCase, recordTestResult } from '../src/domain/records.js'
import { writeTask } from '../src/domain/plan.js'
import { writeRelease } from '../src/domain/release.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import type {
  GateCriterionDef,
  GateCriterionResult,
  GateDef,
  ProcessDef,
  Release,
  TaskCard,
} from '../src/types.js'

/** 每格一个临时 `.sdo`（不碰真账；`store` 与 `journal` 绑同一个根）。 */
function withStore<T>(run: (env: { store: SdoStore; journal: Journal; dir: string }) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'sdo-m214-'))
  try {
    const store = new SdoStore(join(dir, '.sdo'))
    store.ensureLayout()
    return run({ store, journal: new Journal(store), dir })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 夹具一律走**工厂函数**：每格一份新对象（`REV-076` findingIndex 第 11 条的同一条纪律）。 */
function releaseOf(id: string, scope: readonly string[], extra: Partial<Release> = {}): Release {
  return {
    id,
    packageVersion: id.replace(/^r-/u, ''),
    scope: { requirements: [...scope], acceptance: [] },
    ...extra,
  }
}

/** 已冻结的一版（`AC-276`：冻结是一次人签，`frozenBy` 只认 human）。 */
function frozen(release: Release): Release {
  return { ...release, frozenAtSeq: 100, frozenBy: 'human' }
}

function writeDefect(store: SdoStore, id: string, status: string, extra: Record<string, unknown> = {}): void {
  store.writeYaml(['defects', `${id}.yml`], {
    defect: { id, title: id, severity: 'major', status, at: '2026-10-22T00:00:00.000Z', ...extra },
  })
}

function cardOf(id: string, status: TaskCard['status']): TaskCard {
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
    role: 'developer',
    size: 'small',
    revision: 1,
    status,
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
  }
}

function writeCard(store: SdoStore, id: string, status: TaskCard['status']): void {
  writeTask(store, cardOf(id, status))
}

/** 一份契约（只钉作用域关心的那格：`requires` = 它的需求来源）。 */
function writeContract(store: SdoStore, id: string, requires: readonly string[]): void {
  store.writeYaml(['contracts', `${id}.yml`], {
    contract: {
      id,
      name: id,
      kind: 'http',
      producer: 'a',
      consumer: 'b',
      schema: 's',
      failureSemantics: { timeout: 't', retry: 'r', idempotency: 'i' },
      requires: [...requires],
      at: '2026-10-22T00:00:00.000Z',
    },
  })
}

function link(store: SdoStore, from: string, to: string, kind: string): void {
  store.appendLine(['trace', 'links.jsonl'], JSON.stringify({ from, to, kind, at: '2026-10-22T00:00:00.000Z' }))
}

/** 需求夹具（判据只读 `id` / `priority` 与追溯图）。 */
function requirementsOf(...rows: readonly { id: string; priority: string }[]): GateContext['requirements'] {
  return rows.map((row) => ({ id: row.id, priority: row.priority, title: row.id, statement: '', status: 'baselined' })) as unknown as GateContext['requirements']
}

/**
 * 判据级上下文（**不含** `versionScope`）：模拟"直接调检查器"/"非作用域门禁"那一侧。
 *
 * 给 `versionScope` 的走 `evaluateGate`（引擎在 G4/G6/G7 上注入），这里只负责全基线口径。
 */
function ctxOf(
  store: SdoStore,
  journal: Journal,
  dir: string,
  requirements: GateContext['requirements'] = [],
): GateContext {
  return {
    workspace: dir,
    store,
    journal,
    requirements,
    waivedGates: [],
  } as unknown as GateContext
}

/** `C-71` 的**真实接线**（判据集里注册的那一个，不是本文件另写一份口径）。 */
function scopeClosure(ctx: GateContext): GateCriterionResult {
  const checker = CHECKERS[VERSION_SCOPE_CHECK]
  assert.equal(typeof checker, 'function', `${VERSION_SCOPE_CHECK} 必须注册在 CHECKERS 里（C-71 的挂点是它）`)
  if (checker === undefined) throw new Error('release.scope-closure 未注册')
  return checker(ctx)
}

function verdict(ctx: GateContext): { ok: boolean; detail: string; remedy: string } {
  const result = scopeClosure(ctx)
  return { ok: result.ok === true, detail: result.detail, remedy: result.remedy ?? '' }
}

/** 判据的详情里点没点到这些 id（点名是本判据唯一可执行的修法来源，缺了就"红得没法下手"）。 */
function namesAll(detail: string, ids: readonly string[]): boolean {
  return ids.every((id) => detail.includes(id))
}

const waterfall = (): ProcessDef => {
  const process = loadProcess('waterfall')
  // **消息必须单独一行**：散文站点抽取器只按**行**取实参，`assert.ok(cond, '…')` 只有两个实参 ⇒
  // 消息会被当成"取值"读进去（`test/m189.test.ts` 的棘轮按身份登记，本文件必须零站点）。
  assert.ok(
    process !== undefined,
    '随包流程数据必须读得到（src/data/processes/waterfall.yml）',
  )
  return process
}

/** 某一条判据的结论（找不到就当场红：判据没挂上 = 这条约束不存在）。 */
function criterionOf(gate: { criteria: GateCriterionResult[] }, id: string): GateCriterionResult {
  const found = gate.criteria.find((item) => item.id === id)
  assert.ok(
    found !== undefined,
    `门禁的逐条判定里必须有 ${id}：${gate.criteria.map((item) => item.id).join(' ')}`,
  )
  return found
}

test('M214-01 守卫态①（R1）：本版 scope 里的 major/open 缺陷 ⇒ C-71 判红并点名', () => {
  withStore(({ store, journal, dir }) => {
    writeRelease(store, journal, frozen(releaseOf('r-0.1.7', ['REQ-001', 'DEF-001'])))
    writeDefect(store, 'DEF-001', 'open')

    const red = verdict(ctxOf(store, journal, dir, requirementsOf({ id: 'REQ-001', priority: 'should' })))
    assert.equal(red.ok, false, `作用域内的未闭合缺陷必须判红：${red.detail}`)
    assert.equal(namesAll(red.detail, ['DEF-001']), true, `判红必须点名那条缺陷：${red.detail}`)
    assert.equal(
      red.detail.includes('failClosed=[]'),
      true,
      `它是 scope 直接点名的成员 —— 不许再被算成"缺省归入"或"顺延到账"（三种归属互斥）：${red.detail}`,
    )
    assert.ok(
      red.remedy.length > 0,
      '判红必须给可执行修法（空口红等于没法收拾）',
    )
  })
})

test('M214-02 守卫态②（R2）：同一条移进本版 nonScope ⇒ C-71 绿（本版明确不进，不判它）', () => {
  withStore(({ store, journal, dir }) => {
    writeRelease(store, journal, frozen(releaseOf('r-0.1.7', ['REQ-001'], {
      nonScope: [{ id: 'DEF-001', reason: 'later', deferCount: 1, approvedBy: 'human' }],
    })))
    writeDefect(store, 'DEF-001', 'open')

    const green = verdict(ctxOf(store, journal, dir, requirementsOf({ id: 'REQ-001', priority: 'should' })))
    assert.equal(green.ok, true, `本版明确不进的缺陷不该在本版判红：${green.detail}`)
    // 反向对照：它**确实**在台账里、状态也确实是 open —— 绿是"本版不判它"，不是"台账里没有它"
    assert.equal(green.detail.includes('DEF-001'), false, `不参与的实体不该出现在作用域回执里：${green.detail}`)
    assert.equal(versionScopeOf(store).classify('DEF-001'), 'deferred', '派生侧必须把它判成"本版明确不进"')
  })
})

test('M214-03 守卫态③（R8/R9）：既不在 scope 也不在 nonScope ⇒ 缺省归入当前版并判红', () => {
  withStore(({ store, journal, dir }) => {
    writeRelease(store, journal, frozen(releaseOf('r-0.1.7', ['REQ-001'])))
    writeDefect(store, 'DEF-002', 'open')
    writeCard(store, 'TASK-002', 'planned')

    const red = verdict(ctxOf(store, journal, dir, requirementsOf({ id: 'REQ-001', priority: 'should' })))
    assert.equal(red.ok, false, `没规划过的对象必须按 fail-closed 判红：${red.detail}`)
    assert.equal(namesAll(red.detail, ['DEF-002', 'TASK-002']), true, `缺陷与卡都要点名：${red.detail}`)
    assert.equal(
      red.detail.includes('failClosed=[DEF-002 TASK-002]'),
      true,
      `"缺省归入者"必须能被单独读出来（与顺延到账不混同）：${red.detail}`,
    )
  })
})

test('M214-04 守卫态④：作用域内四类全闭合 ⇒ 绿；"缺省归入"与"顺延到账"分开点名', () => {
  withStore(({ store, journal, dir }) => {
    // 当前版＝r-0.1.7（最新已冻结）；r-0.1.6 的 nonScope 里登记过 DEF-009 ⇒ 顺延到账者。
    writeRelease(store, journal, frozen(releaseOf('r-0.1.6', ['REQ-001'], {
      nonScope: [{ id: 'DEF-009', reason: 'later', deferCount: 1, approvedBy: 'human' }],
    })))
    writeRelease(store, journal, frozen(releaseOf('r-0.1.7', ['REQ-001', 'DEF-001', 'TASK-001'])))
    writeDefect(store, 'DEF-001', 'fixed')
    writeDefect(store, 'DEF-009', 'closed')
    writeCard(store, 'TASK-001', 'done')

    const view = versionScopeOf(store)
    assert.equal(view.releaseId, 'r-0.1.7', `当前版＝最新已冻结的那一版：${view.releaseId}`)
    assert.equal(view.classify('DEF-009'), 'landed', '只在旧版 nonScope 里、目标已到账 ⇒ 顺延到账者')
    assert.equal(view.classify('DEF-010'), 'failClosed', '谁都没点名 ⇒ 缺省归入者')

    const green = verdict(ctxOf(store, journal, dir, requirementsOf({ id: 'REQ-001', priority: 'should' })))
    assert.equal(green.ok, true, `四类都闭合 ⇒ 判据必须绿：${green.detail}`)
    assert.equal(green.detail.includes('landedFrom=[DEF-009]'), true, `顺延到账者要单独点名：${green.detail}`)
    assert.equal(green.detail.includes('failClosed=[]'), true, `这一格没有缺省归入者：${green.detail}`)
    assert.equal(green.detail.includes('scope=r-0.1.7@0.1.7'), true, `回执要写清判的是哪一版：${green.detail}`)
  })
})

test('M214-05 没有 release 文件 ⇒ 一切属于当前版本（fail-closed）：红侧不放过、绿侧不误伤', () => {
  withStore(({ store, journal, dir }) => {
    const view = versionScopeOf(store)
    assert.equal(view.hasReleases, false, '这一格故意一份 release 都没有')
    assert.equal(view.classify('DEF-003'), 'failClosed', '没有集合可对 ⇒ 一律缺省归入当前版本（不是"作用域为空"）')
    assert.equal(view.includes('DEF-003'), true, 'fail-closed 的方向是"拉进判定"，不是"放过去"')

    // 红侧：open 缺陷照样判红（**不许**因为"没有 release 文件"就放过）
    writeDefect(store, 'DEF-003', 'open')
    const red = verdict(ctxOf(store, journal, dir))
    assert.equal(red.ok, false, `没有 release 文件时 open 缺陷仍必须判红（fail-closed）：${red.detail}`)
    assert.equal(red.detail.includes('scope=no-release-files'), true, `回执要说清"没有 release 文件"这一态：${red.detail}`)
    assert.equal(red.detail.includes('DEF-003'), true, `要点名那条缺陷：${red.detail}`)

    // 绿侧：闭合了就绿（证明这一态是"全部归入"，不是"全部不判"）
    writeDefect(store, 'DEF-003', 'closed')
    const green = verdict(ctxOf(store, journal, dir))
    assert.equal(green.ok, true, `全部闭合 ⇒ 绿（fail-closed 不等于永久判红）：${green.detail}`)
    assert.equal(green.detail.includes('defects=1'), true, `它确实参与了判定：${green.detail}`)
  })
})

test('M214-06 顺延到账者参与判定并单独点名（与缺省归入者不混同）', () => {
  withStore(({ store, journal, dir }) => {
    writeRelease(store, journal, frozen(releaseOf('r-0.1.6', ['REQ-001'], {
      nonScope: [{ id: 'DEF-020', reason: 'later', deferCount: 1, approvedBy: 'human' }],
    })))
    writeRelease(store, journal, frozen(releaseOf('r-0.1.7', ['REQ-001'])))
    writeDefect(store, 'DEF-020', 'open')

    const red = verdict(ctxOf(store, journal, dir, requirementsOf({ id: 'REQ-001', priority: 'should' })))
    assert.equal(red.ok, false, `顺延到账者本版要判，未闭合就判红：${red.detail}`)
    assert.equal(red.detail.includes('landedFrom=[DEF-020]'), true, `要点名"它是顺延到账进来的"：${red.detail}`)
    assert.equal(red.detail.includes('failClosed=[]'), true, `不许把它同时算成"缺省归入"（两义混同就失去点名意义）：${red.detail}`)
  })
})

test('M214-07 四类逐类闭合：缺陷 / 卡 / must 需求 / 契约各自点名，补齐后转绿', () => {
  withStore(({ store, journal, dir }) => {
    writeRelease(store, journal, frozen(releaseOf('r-0.1.7', ['REQ-001', 'DEF-030', 'TASK-030'])))
    // 契约面：项目声明启用（`contractTests.enforce`），契约 CT-030 的需求来源在作用域内 ⇒ 本版要判
    store.writeYaml(['config.yml'], { contractTests: { enforce: true } })
    writeContract(store, 'CT-030', ['REQ-001'])
    writeDefect(store, 'DEF-030', 'open')
    writeCard(store, 'TASK-030', 'planned')

    const red = verdict(ctxOf(store, journal, dir, requirementsOf({ id: 'REQ-001', priority: 'must' })))
    assert.equal(red.ok, false, `四类都有缺口 ⇒ 判红：${red.detail}`)
    assert.equal(
      namesAll(red.detail, ['DEF-030', 'TASK-030', 'REQ-001', 'CT-030']),
      true,
      `四类缺口必须逐类点名（否则读者不知道该补哪一类）：${red.detail}`,
    )

    // 逐类补齐：缺陷闭合、卡完成、must 需求有「pass 且已采纳」的用例、契约有 contractTest 记录
    writeDefect(store, 'DEF-030', 'closed')
    writeCard(store, 'TASK-030', 'done')
    // 用例 id 由 `recordTestCase` 自己发号（`idOf`），夹具**不许假设**它是 TC-030
    const testCase = recordTestCase(store, journal, { title: 'case-for-REQ-001', kind: 'unit', steps: ['s'], expected: 'e', requirement: 'REQ-001' })
    link(store, 'REQ-001', testCase.id, 'req-tc')
    const recorded = recordTestResult(store, journal, {
      caseId: testCase.id,
      status: 'pass',
      evidence: 'node --test',
      executedBy: 'dev-1',
      adoptedBy: 'reviewer-1',
      adoptedAt: '2026-10-22T00:00:00.000Z',
      oracle: { kind: 'expert', expert: 'm214' },
    })
    assert.equal(recorded.ok, true, `夹具的测试结论必须能落盘：${recorded.ok ? '' : recorded.detail}`)
    recordContractTest(store, { task: 'TASK-030', contract: 'CT-030', tool: 'node --test', cmd: 'node --test', at: '2026-10-22T00:00:00.000Z' })

    const green = verdict(ctxOf(store, journal, dir, requirementsOf({ id: 'REQ-001', priority: 'must' })))
    assert.equal(green.ok, true, `逐类补齐之后必须转绿：${green.detail}`)
    assert.equal(green.detail.includes('must=1'), true, `本版确实判了那条 must 需求：${green.detail}`)
    assert.equal(green.detail.includes('contracts=1'), true, `本版确实判了那份契约：${green.detail}`)
  })
})

test('M214-08 must 需求的两种缺口：没有用例 / 有用例但没有「pass 且已采纳」的结论', () => {
  withStore(({ store, journal, dir }) => {
    writeRelease(store, journal, frozen(releaseOf('r-0.1.7', ['REQ-001'])))
    const requirements = requirementsOf({ id: 'REQ-001', priority: 'must' })

    const noCase = verdict(ctxOf(store, journal, dir, requirements))
    assert.equal(noCase.ok, false, `must 需求一条用例都没有 ⇒ 判红：${noCase.detail}`)
    assert.equal(noCase.detail.includes('REQ-001'), true, `要点名那条需求：${noCase.detail}`)

    // 补上边（有用例）但**没有**结论 ⇒ 第三态（边只证明"有用例"，不证明"跑过且被采纳"）
    recordTestCase(store, journal, { title: 'TC-001', kind: 'unit', steps: ['s'], expected: 'e', requirement: 'REQ-001' })
    link(store, 'REQ-001', 'TC-001', 'req-tc')
    const unverified = verdict(ctxOf(store, journal, dir, requirements))
    assert.equal(unverified.ok, false, `有边但没有「pass 且已采纳」的结论 ⇒ 仍判红：${unverified.detail}`)
    assert.equal(unverified.detail.includes('REQ-001<-TC-001'), true, `要点名"哪条需求 <- 哪条用例"：${unverified.detail}`)
  })
})

test('M214-09 R11 双向可观察：0.1.7 的 must 需求往 0.1.6 的 G6 丢不判红，往 G2 丢进判定', () => {
  withStore(({ store, journal, dir }) => {
    // 旧版已冻结、新版**起草中**（`AC-275` 的场景：当前版＝签过字的那一版，不是版本最高的那一版）
    writeRelease(store, journal, frozen(releaseOf('r-0.1.6', ['REQ-001'])))
    writeRelease(store, journal, releaseOf('r-0.1.7', ['REQ-002']))
    store.writeYaml(['config.yml'], { trace: { mustCoverage: true } })

    recordTestCase(store, journal, { title: 'TC-001', kind: 'unit', steps: ['s'], expected: 'e', requirement: 'REQ-001' })
    link(store, 'REQ-001', 'TC-001', 'req-tc')
    const recorded = recordTestResult(store, journal, {
      caseId: 'TC-001',
      status: 'pass',
      evidence: 'node --test',
      executedBy: 'dev-1',
      adoptedBy: 'reviewer-1',
      adoptedAt: '2026-10-22T00:00:00.000Z',
      oracle: { kind: 'expert', expert: 'm214' },
    })
    assert.equal(recorded.ok, true, `夹具的测试结论必须能落盘：${recorded.ok ? '' : recorded.detail}`)

    const requirements = requirementsOf({ id: 'REQ-001', priority: 'must' }, { id: 'REQ-002', priority: 'must' })
    const ctx = ctxOf(store, journal, dir, requirements)
    assert.equal(versionScopeOf(store).classify('REQ-002'), 'otherVersion', 'REQ-002 只属 0.1.7 ⇒ 不在本版作用域')

    // ① G6 侧：**不判红** —— `C-50` 看到的 must 只剩 REQ-001（它有用例也有已采纳的 pass）
    const g6 = evaluateGate(waterfall(), 'G6', ctx)
    const passed = criterionOf(g6, 'C-50')
    assert.equal(passed.ok, true, `G6 的 tests.passed 只问本版的 must 需求（REQ-002 不参与）：${passed.detail}`)
    assert.equal(passed.detail.includes('REQ-002'), false, `作用域外的需求不该出现在 G6 的判红名单里：${passed.detail}`)
    const scoped = criterionOf(g6, 'C-71')
    assert.equal(scoped.ok, true, `作用域内四类都闭合 ⇒ C-71 绿：${scoped.detail}`)

    // ② 控制组：同一份台账走**全基线**口径（不注入作用域）⇒ 同一判据立刻点名 REQ-002
    const unfiltered = CHECKERS['tests.passed']?.(ctx) as GateCriterionResult
    assert.equal(unfiltered.ok, false, `对照：全基线口径下 REQ-002 的用例缺口必须判红：${unfiltered.detail}`)
    assert.equal(unfiltered.detail.includes('REQ-002'), true, `对照组必须点名它（否则上面那条绿是假绿）：${unfiltered.detail}`)

    // ③ G2 侧：**进判定** —— 需求基线门禁对整条基线判，不看版本切片（AC-267）
    const g2 = evaluateGate(waterfall(), 'G2', ctx)
    const mustCoverage = criterionOf(g2, 'C-must-coverage')
    assert.equal(mustCoverage.ok, false, `G2 的 must 覆盖判据必须看见全基线：${mustCoverage.detail}`)
    assert.equal(mustCoverage.detail.includes('REQ-002'), true, `G2 侧必须点名那条只属新版的 must 需求：${mustCoverage.detail}`)
  })
})

test('M214-10 既有语义不变：C-51 仍只管阻塞级；C-65/C-66 只收窄名单', () => {
  withStore(({ store, journal, dir }) => {
    writeRelease(store, journal, frozen(releaseOf('r-0.1.7', ['REQ-001', 'DEF-040'], {
      nonScope: [{ id: 'DEF-041', reason: 'later', deferCount: 1, approvedBy: 'human' }],
    })))
    // DEF-040：作用域内的 **major**（非阻塞）open ⇒ C-51 语义不变（它只管阻塞级），C-71 才判它
    writeDefect(store, 'DEF-040', 'open', { severity: 'major' })
    // DEF-041：**阻塞级** open，但本版明确不进 ⇒ 作用域过滤放过它（C-51 的判定口径没动）
    writeDefect(store, 'DEF-041', 'open', { severity: 'blocker' })
    const ctx = ctxOf(store, journal, dir, requirementsOf({ id: 'REQ-001', priority: 'should' }))

    const g6 = evaluateGate(waterfall(), 'G6', ctx)
    const c51 = criterionOf(g6, 'C-51')
    assert.equal(c51.ok, true, `C-51 仍只管阻塞级、且作用域外的阻塞缺陷不该在本版判红：${c51.detail}`)
    const c71 = criterionOf(g6, 'C-71')
    assert.equal(c71.ok, false, `作用域内的 major open 由 C-71 逮住：${c71.detail}`)
    assert.equal(namesAll(c71.detail, ['DEF-040']), true, `C-71 要点名那条 major：${c71.detail}`)

    // 对照：去掉作用域过滤 ⇒ 同一份台账的 C-51 立刻点名那条阻塞缺陷（过滤才是差异的来源）
    const unfilteredC51 = CHECKERS['defects.closed']?.(ctx) as GateCriterionResult
    assert.equal(unfilteredC51.ok, false, `对照：全基线口径下 DEF-041 必须让 C-51 判红：${unfilteredC51.detail}`)
    assert.equal(unfilteredC51.detail.includes('DEF-041'), true, `对照组要点名它：${unfilteredC51.detail}`)
  })
})

test('M214-11 C-65 / C-66 只收窄名单：作用域外的不判红，口径与修法一字不动', () => {
  withStore(({ store, journal, dir }) => {
    writeRelease(store, journal, frozen(releaseOf('r-0.1.7', ['REQ-001', 'DEF-050'], {
      nonScope: [{ id: 'DEF-051', reason: 'later', deferCount: 1, approvedBy: 'human' }],
    })))
    // 先把缺陷登记进台账（结论里的 `defects` 只认已存在的 id），再把它们改成 fixed
    writeDefect(store, 'DEF-050', 'open')
    writeDefect(store, 'DEF-051', 'open')
    const testCase = recordTestCase(store, journal, { title: 'case-for-C66', kind: 'unit', steps: ['s'], expected: 'e', requirement: 'REQ-001' })
    const result = recordTestResult(store, journal, {
      caseId: testCase.id,
      status: 'pass',
      evidence: 'node --test',
      executedBy: 'dev-1',
      adoptedBy: 'reviewer-1',
      adoptedAt: '2026-10-22T00:00:00.000Z',
      oracle: { kind: 'expert', expert: 'm214' },
      defects: ['DEF-050', 'DEF-051'],
    })
    assert.equal(result.ok, true, `夹具的测试结论必须能落盘：${result.ok ? '' : result.detail}`)
    // 两条都是 fixed；作用域外那条（DEF-051）不该让 C-66 判红（"先评审、后测试"没被满足）
    writeDefect(store, 'DEF-050', 'fixed')
    writeDefect(store, 'DEF-051', 'fixed')
    const requirements = requirementsOf({ id: 'REQ-001', priority: 'should' })
    const ctx = ctxOf(store, journal, dir, requirements)

    const g6 = evaluateGate(waterfall(), 'G6', ctx)
    const c65 = criterionOf(g6, 'C-65')
    assert.equal(c65.ok, true, `作用域内的 fixed 缺陷已有 pass 结论 ⇒ C-65 绿：${c65.detail}`)
    const c66 = criterionOf(g6, 'C-66')
    assert.equal(c66.ok, false, `作用域内的 fixed 缺陷没有已采纳评审 ⇒ C-66 仍判红（口径没被放松）：${c66.detail}`)
    assert.equal(c66.detail.includes('DEF-050'), true, `要点名作用域内那条：${c66.detail}`)
    assert.equal(c66.detail.includes('DEF-051'), false, `本版明确不进的那条不该出现在本版判红名单里：${c66.detail}`)
  })
})

test('M214-12 C-71 的挂载面：只有 G4/G6/G7 有它；流程数据自己声明时不重复挂', () => {
  withStore(({ store, journal, dir }) => {
    writeRelease(store, journal, frozen(releaseOf('r-0.1.7', ['REQ-001'])))
    const ctx = ctxOf(store, journal, dir, requirementsOf({ id: 'REQ-001', priority: 'should' }))
    const process = waterfall()
    assert.deepEqual([...VERSION_SCOPED_GATE_IDS], ['G4', 'G6', 'G7'], '作用域门禁就是这三道（规格 §3.4）')

    const idsOf = (gateId: string): string[] => evaluateGate(process, gateId, ctx).criteria.map((item) => item.id)
    for (const gateId of ['G4', 'G6', 'G7']) {
      assert.equal(idsOf(gateId).includes(VERSION_SCOPE_CRITERION_ID), true, `${gateId} 必须挂上 C-71：${idsOf(gateId).join(' ')}`)
    }
    for (const gateId of ['G2', 'G3', 'G5']) {
      assert.equal(idsOf(gateId).includes(VERSION_SCOPE_CRITERION_ID), false, `${gateId} 不许切片（对整条基线判定）：${idsOf(gateId).join(' ')}`)
    }

    // 流程数据将来自己声明了同一个 check ⇒ 引擎不再补充（逐条判定里只能有一条 C-71）
    const declared: GateCriterionDef = { id: 'C-71', check: VERSION_SCOPE_CHECK, desc: 'declared-by-data' }
    const g6 = process.gates.find((gate) => gate.id === 'G6')
    assert.ok(
      g6 !== undefined,
      '基准：waterfall 必须有 G6',
    )
    const synthetic: GateDef = { id: 'G6', name: g6.name, criteria: [...g6.criteria, declared] }
    const rewritten: ProcessDef = { ...process, gates: [...process.gates.filter((gate) => gate.id !== 'G6'), synthetic] }
    const criteria = evaluateGate(rewritten, 'G6', ctx).criteria.map((item) => item.id)
    assert.equal(criteria.filter((id) => id === VERSION_SCOPE_CRITERION_ID).length, 1, `C-71 只许出现一次：${criteria.join(' ')}`)
  })
})

test('M214-13 没有 release 文件时 G4/G6/G7 不补充 C-71（老项目判定面不变），但检查器仍 fail-closed', () => {
  withStore(({ store, journal, dir }) => {
    writeDefect(store, 'DEF-060', 'open')
    const ctx = ctxOf(store, journal, dir)
    const criteria = evaluateGate(waterfall(), 'G6', ctx).criteria.map((item) => item.id)
    assert.equal(
      criteria.includes(VERSION_SCOPE_CRITERION_ID),
      false,
      `发布计划层尚未被采纳时不在老项目的门禁上加新判据：${criteria.join(' ')}`,
    )
    // 但检查器本身不许把"没有集合"当"没有问题"（fail-closed，见 M214-05 的红侧）
    assert.equal(verdict(ctx).ok, false, '直接调用 C-71 时，没有 release 文件仍按"全部属于当前版本"判红')
  })
})

test('M214-14 判不动（release 文件写坏）⇒ 照样挂上 C-71 并判红点名文件', () => {
  withStore(({ store, journal, dir }) => {
    store.writeYaml(['releases', 'r-0.1.7.yml'], { release: 123 })
    const ctx = ctxOf(store, journal, dir)
    const g6 = evaluateGate(waterfall(), 'G6', ctx)
    const c71 = criterionOf(g6, 'C-71')
    assert.equal(c71.ok, false, `读不动不等于没有作用域 ⇒ 必须判红：${c71.detail}`)
    assert.equal(c71.detail.includes('r-0.1.7.yml'), true, `判红要点名那个文件：${c71.detail}`)
  })
})

test('M214-15 夹具自洽：作用域视图对同一实体稳定（缓存不许让两次判定给出不同结论）', () => {
  withStore(({ store, journal }) => {
    writeRelease(store, journal, frozen(releaseOf('r-0.1.7', ['REQ-001', 'DEF-070'])))
    const view = versionScopeOf(store)
    const first = view.classify('DEF-070')
    const second = view.classify('DEF-070')
    assert.equal(first, second, '同一实体在同一视图里必须给出同一个归属')
    assert.equal(first, 'scope', '被本版 scope 点名 ⇒ scope')
    assert.equal(view.includes('DEF-071'), true, '谁都没点名的实体按 fail-closed 归入本版')
  })
})
