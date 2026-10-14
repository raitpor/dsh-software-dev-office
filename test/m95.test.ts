/**
 * M95：**判定基准（oracle）的参数面收口**（TASK-054 / REQ-054 / 判据 `C-50`）。
 *
 * 本卡存在的理由（`C-50 tests.passed passedAdopted` 的补救动作在工具面**没有出口**）：
 * 域层早就认 `oracle`（`records.ts` 的 `TestCase.oracle` / `TestResult.oracle`，判定实现只有
 * `evidence.ts` 的 `oracleGaps()` 一处），但**工具边界**上根本没有这个参数 ——
 * `sdo_test` 的 `parameters` schema 没有它、`TestArgs` 没有它、`src/index.ts` 的 `deps.test`
 * 分支也不搬它。于是真机上「执行者 ≠ 采纳者 + 判定基准成立」这条路**走不通**：
 * 调用方能做的一切都做了，`isAdopted()` 仍然报「判定基准不成立」，`passedAdopted` 永远是 0。
 *
 * 因此本文件的用例一律走**真实注册的工具**（`apply()` → 注册表 → `execute`），而不是直接调
 * `office.*` / 域函数：缺陷正好长在工具边界上（schema / 类型 / `deps` 映射三处缺一处，值都会
 * **静默丢弃** —— 不报错、回执还说成功）。只调内部方法的用例照不出这类缺陷（知识库 `tq_ff348198`）。
 * 「参数真的被接收」的证据一律是**从 append-only 真源回读**，回执说成功不算。
 *
 * 两态守卫：
 *
 * | # | 情形 | 期望 |
 * |---|---|---|
 * | ① | plan 传 oracle + record 传 executedBy/adoptedBy | 结果**真的**计入 `passedAdopted`；`isAdopted()` 不报缺口；事件里 `oracleKind` 读得回 |
 * | ② | plan 不传 oracle | `record` 判红并**点名**缺的是判定基准（不许静默记成"通过"）；补上即入账 |
 * | ③ | 非法 oracle kind | 判红 + **点名合法集合**（四类）+ 修法；换合法值即入账 |
 * | ④ | 只给 `result.oracle`（用例上没登记） | 同样成立（优先级口径：`result.oracle ?? testCase.oracle ?? requirement`） |
 * | ⑤ | 四类 oracle 逐类取值 | 每类各自的机械核对都对得上（含基线**现算比对**） |
 * | ⑥ | 经工具面传的 oracle | 落进 `test/recorded` 事件（回读验证）与 `tests/results/*.yml` |
 *
 * 边界（卡上写死）：**不改 `isAdopted()` / `evidence.ts` 的判定语义** —— 本文件只证明
 * 「域层已有的判据在工具面上有出口」，判定规则本身仍由 TASK-020 那一处实现说了算。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { ORACLE_KINDS } from '../src/domain/evidence.js'
import { isAdopted, listTestResults, verificationStats } from '../src/domain/records.js'
import type { TestCase, TestResult } from '../src/domain/records.js'
import { writeRequirement } from '../src/domain/requirements.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import type { Requirement } from '../src/types.js'
import type { JournalEvent } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm95')
const WORKSPACE = join(BASE, 'proj')
const SESSION = 'm95-session'

interface RegisteredTool {
  name: string
  parameters?: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
}

interface Harness {
  tool: (name: string) => RegisteredTool
  exec: () => unknown
  fire: (event: string, payload: unknown) => void
}

let harness: Harness

/** 一次**真实装配**：`apply()` 注册进宿主工具表的那一份定义，不是手工拼的假工具。 */
function makeHarness(): Harness {
  const listeners = new Map<string, (payload: never) => void>()
  const registered = new Map<string, RegisteredTool>()
  const services: Record<string, unknown> = {
    tools: { register: (tool: RegisteredTool) => registered.set(tool.name, tool) },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: (event: string, listener: never) => { listeners.set(event, listener); return () => {} },
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as never, Config({} as unknown as SdoConfig))
  return {
    tool: (name: string): RegisteredTool => {
      const found = registered.get(name)
      if (found === undefined) throw new Error(`真实装配没有注册 ${name}（注册表里只有：${[...registered.keys()].join(', ')}）`)
      return found
    },
    // **取会话工作目录只能读 `agent.session.header.cwd`**（dsh-agent 0.2.0-rc.1 上没有顶层 cwd）
    exec: () => ({ name: 'sdo_test', arguments: {}, agent: { session: { header: { id: SESSION, cwd: WORKSPACE, delegationDepth: 0 } } } }),
    fire: (event, payload) => listeners.get(event)?.(payload as never),
  }
}

/** 走真实注册的工具。 */
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  return String(await harness.tool(name).execute(args, harness.exec()))
}

function sdoTest(args: Record<string, unknown>): Promise<string> {
  return callTool('sdo_test', args)
}

function store(): SdoStore {
  return new SdoStore(join(WORKSPACE, '.sdo'))
}

function journal(): Journal {
  return new Journal(store())
}

/** **真源回读**：只认 append-only 的事件，不看回执怎么说。 */
function events(type: string): JournalEvent[] {
  return journal().read().events.filter((event) => event.type === type)
}

function lastEvent(type: string): Record<string, unknown> {
  const hit = events(type).at(-1)
  assert.ok(hit !== undefined, `真源里必须有 ${type} 事件（没有就是工具面把值丢了）`)
  return (hit as { data: Record<string, unknown> }).data
}

/** 一条**真实存在**的需求（验收标准类 oracle 要指到它的 AC 编号）。 */
function requirement(id: string, acIds: string[]): Requirement {
  const now = new Date().toISOString()
  const item: Requirement = {
    id, title: id, kind: 'functional', statement: 's', rationale: 'r',
    source: { stakeholder: 'STK-01' }, priority: 'must',
    ambiguity: { score: 0, dimensions: {}, open: [], needsReview: false, modelDimensions: {} } as Requirement['ambiguity'],
    acceptance: acIds.map((acId) => ({ id: acId, given: 'g', when: 'w', then: 't' })),
    status: 'baselined', version: 1, baseline: null,
    createdAt: now, updatedAt: now,
  }
  writeRequirement(store(), item)
  return item
}

function caseOf(id: string): TestCase | undefined {
  return store().readYaml<{ testCase: TestCase }>('tests', `${id}.yml`)?.testCase
}

function resultOf(id: string): TestResult | undefined {
  return store().readYaml<{ result: TestResult }>('tests/results', `${id}.yml`)?.result
}

/** `tests/results/*.yml` 里**真有**这条结果（人读视图，与事件是真源的两侧）。 */
function resultFiles(): string[] {
  try {
    return readdirSync(join(WORKSPACE, '.sdo', 'tests', 'results')).filter((name) => name.endsWith('.yml'))
  } catch {
    return []
  }
}

/** `isAdopted()` 的原话（域层唯一判定入口，本文件不另写一份口径）。 */
function adoptedVerdict(resultId: string): { adopted: boolean; reason: string } {
  const result = resultOf(resultId)
  assert.ok(result !== undefined, `台账里必须有结果 ${resultId}`)
  return isAdopted(store(), result as TestResult, caseOf((result as TestResult).caseId))
}

beforeEach(async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  harness = makeHarness()
  harness.fire('session/created', { id: SESSION, header: { cwd: WORKSPACE } })
  const receipt = await callTool('sdo_init', { name: 'M95 夹具', process: 'waterfall', scale: 'normal', stakeholders: '执行者,采纳者' })
  assert.match(receipt, /PRJ-001/u, `夹具立项失败：${String(receipt)}`)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// —————————————————————— ① 工具面能走通「独立采纳」，且 isAdopted() 不报缺口 ——————————————————————

test('M95-01 工具面走通 oracle：plan 传 + record 传 ⇒ 真的计入 passedAdopted，isAdopted() 不报缺口（落点一/三）', async () => {
  requirement('REQ-054', ['AC-212', 'AC-213', 'AC-214'])

  const plan = await sdoTest({
    action: 'plan',
    kind: 'unit',
    requirement: 'REQ-054',
    title: '判定基准齐备的用例',
    steps: '["跑断言"]',
    expected: '全绿',
    oracle: '{"kind":"acceptance","ref":"REQ-054","criterion":"AC-213"}',
  })
  assert.match(plan, /TC-001/u, `plan 要点名用例 id：${plan}`)

  // 用例侧：`tests/TC-001.yml` 里**真有**判定基准（工具面静默丢弃的话这里读不出来）
  assert.deepEqual(caseOf('TC-001')?.oracle, { kind: 'acceptance', ref: 'REQ-054', criterion: 'AC-213' }, 'oracle 必须落进用例台账')

  const record = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test lib/test/m95.test.js ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
  })
  assert.match(record, /TR-001/u, `record 要点名结果 id：${record}`)
  assert.doesNotMatch(record, /仍不计入|仍未计入/u, `判定基准成立时不许再报"未计入"：${record}`)

  const data = lastEvent('test/recorded')
  assert.equal(data.executedBy, 'dev-a', '执行者必须能从真源事件读回')
  assert.equal(data.adoptedBy, 'qa-b', '采纳者必须能从真源事件读回')
  assert.equal(data.oracleKind, 'acceptance', '**判定基准的类别也要进真源事件**（否则"这条凭什么判定"在事件里查不到）')

  // **落点三（本卡存在的理由）**：工具面记下的结果确实可能被采纳
  const verdict = adoptedVerdict('TR-001')
  assert.equal(verdict.adopted, true, `经工具面记录的结果必须可能 adopted:true：${verdict.reason}`)

  const stats = verificationStats(store(), journal())
  assert.equal(stats.passed, 1, '`passed` 口径不变')
  assert.equal(stats.passedAdopted, 1, '执行者 ≠ 采纳者 + 判定基准成立 ⇒ 计入通过（参数真起了作用）')
  assert.deepEqual(stats.unadopted, [], '不该有未采纳的结果')
})

// —————————————————————— ② 缺判定基准：判红并点名 ——————————————————————

test('M95-02 缺判定基准时 record **判红**并点名缺的这一类；补上即入账（两态，落点二）', async () => {
  requirement('REQ-054', ['AC-212'])
  await sdoTest({ action: 'plan', kind: 'unit', requirement: 'REQ-054', title: '没有判定基准的用例', steps: '[]', expected: 'ok' })

  const before = events('test/recorded').length
  const red = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
  })
  assert.match(red, /❌/u, `缺判定基准必须**可读拒绝**（不许静默记成一条"通过"）：${red}`)
  assert.match(red, /oracle/u, `要点名缺的是判定基准参数本身：${red}`)
  assert.match(red, /REQ-054/u, '要点名它覆盖的需求（判定基准要指到那条需求的验收标准）')
  for (const kind of ORACLE_KINDS) assert.ok(red.includes(kind), `要点名四类取值之一「${kind}」：${red}`)
  assert.equal(events('test/recorded').length, before, '判红时**不许**入账（判红却落盘 = 假拒绝）')
  assert.deepEqual(resultFiles(), [], '被拒的结果不许留在台账里')

  // 绿态：同一份夹具、只补上判定基准 ⇒ 入账并计入通过
  const green = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
    oracle: '{"kind":"expert","expert":"张三"}',
  })
  assert.match(green, /TR-001/u, `补上判定基准必须入账：${green}`)
  assert.equal(events('test/recorded').length, before + 1, '合法判定基准要落一条 test/recorded')
  assert.equal(lastEvent('test/recorded').oracleKind, 'expert')
  assert.equal(verificationStats(store(), journal()).passedAdopted, 1, '补齐后必须真的计入通过')
})

// —————————————————————— ③ 非法 kind：判红 + 点名合法集合 ——————————————————————

test('M95-03 非法 oracle kind 判红并点名**四类合法集合**与修法；换合法值即入账（落点二）', async () => {
  requirement('REQ-054', ['AC-212'])
  await sdoTest({ action: 'plan', kind: 'unit', requirement: 'REQ-054', title: '类别写错的用例', steps: '[]', expected: 'ok' })

  const before = events('test/recorded').length
  const bad = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
    oracle: '{"kind":"vibes","expert":"张三"}',
  })
  assert.match(bad, /❌/u, `非法类别必须判红：${bad}`)
  assert.match(bad, /vibes/u, '要点名那个非法取值本身（不许只说"非法"）')
  for (const kind of ORACLE_KINDS) assert.ok(bad.includes(kind), `要点名合法集合「${kind}」：${bad}`)
  assert.match(bad, /acceptance|contract|baseline|expert/u, '要给出修法（合法集合本身即修法指引）')
  assert.equal(events('test/recorded').length, before, '判红时不许入账')

  // 同一份夹具换合法类别 ⇒ 入账（证明前面拒的是"类别"，不是把这条用例整体拒了）
  const good = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
    oracle: '{"kind":"expert","expert":"张三"}',
  })
  assert.match(good, /TR-001/u, `合法类别必须入账：${good}`)
  assert.equal(lastEvent('test/recorded').oracleKind, 'expert')

  // 非法 kind 同样不许从 **plan** 这一侧溜进台账
  const badPlan = await sdoTest({ action: 'plan', kind: 'unit', title: '类别写错的用例', steps: '[]', expected: 'ok', oracle: '{"kind":"vibes"}' })
  assert.match(badPlan, /❌/u, `plan 侧的非法类别也要判红：${badPlan}`)
  assert.equal(caseOf('TC-002'), undefined, '被判红的用例不许留在台账里')
})

// —————————————————————— ④ 只给 result.oracle：优先级口径 ——————————————————————

test('M95-04 只给 `result.oracle`（用例上没登记）同样成立 —— 优先级 = result.oracle ?? testCase.oracle（落点一/三）', async () => {
  // 用例侧**故意不给**判定基准（老台账 / 上游漏登记的真机形态）
  await sdoTest({ action: 'plan', kind: 'unit', title: '用例上没登记判定基准', steps: '[]', expected: 'ok' })
  assert.equal(caseOf('TC-001')?.oracle, undefined, '夹具前提：用例侧确实没有判定基准')

  const receipt = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
    oracle: '{"kind":"contract","ref":"CT-999"}',
  })
  // `CT-999` 不存在 ⇒ 引用不成立，判红并点名（这一条同时证明"记录侧给的值真的被核对过"）
  assert.match(receipt, /❌/u, `引用不存在的契约必须判红：${receipt}`)
  assert.match(receipt, /CT-999/u, '要点名那个不存在的契约 id')

  // 换成成立的取值 ⇒ 结果级判定基准独立成立（**不要求**用例侧也登记）
  const ok = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
    oracle: '{"kind":"expert","expert":"评审员李四"}',
  })
  assert.match(ok, /TR-001/u, `结果级判定基准必须能单独成立：${ok}`)
  assert.deepEqual(resultOf('TR-001')?.oracle, { kind: 'expert', expert: '评审员李四' }, '结果级判定基准要落进结果台账')
  assert.equal(adoptedVerdict('TR-001').adopted, true, `用例侧没登记、结果侧登记了 ⇒ 同样采纳：${adoptedVerdict('TR-001').reason}`)
  assert.equal(verificationStats(store(), journal()).passedAdopted, 1)

  // 反向：结果侧登记得**更靠前** ⇒ 以它为准（用例侧那份不作数）
  await sdoTest({ action: 'plan', kind: 'unit', title: '两侧都登记', steps: '[]', expected: 'ok', oracle: '{"kind":"expert","expert":"用例侧的人"}' })
  await sdoTest({
    action: 'record', caseId: 'TC-002', status: 'pass', evidence: 'node --test ⇒ 全绿',
    executedBy: 'dev-a', adoptedBy: 'qa-b', oracle: '{"kind":"expert","expert":"结果侧的人"}',
  })
  assert.equal(resultOf('TR-002')?.oracle?.expert, '结果侧的人', '两侧都有时以 `result.oracle` 为准（口径与 `isAdopted()` 的 ?? 一致）')
})

// —————————————————————— ⑤ 四类 oracle 逐类核对 ——————————————————————

test('M95-05 四类 oracle 经工具面逐类机械核对（含基线**现算比对**与专家判断人）', async () => {
  requirement('REQ-054', ['AC-212', 'AC-213'])
  writeFileSync(join(WORKSPACE, 'frozen.js'), 'frozen-baseline\n', 'utf8')
  const goodHash = createHash('sha256').update(readFileSync(join(WORKSPACE, 'frozen.js'))).digest('hex')

  const rows: { oracle: string; caseId: string }[] = []
  const plan = async (oracle: string): Promise<string> => {
    const receipt = await sdoTest({ action: 'plan', kind: 'unit', requirement: 'REQ-054', title: `判定基准 ${oracle}`, steps: '[]', expected: 'ok', oracle })
    const hit = /TC-\d+/u.exec(receipt)
    assert.ok(hit !== null, `plan 要点名用例 id：${receipt}`)
    rows.push({ oracle, caseId: hit[0] })
    return hit[0]
  }

  // ① 验收标准类：AC 编号必须**属于所指需求**
  const acceptanceId = await plan('{"kind":"acceptance","ref":"REQ-054","criterion":"AC-212"}')
  assert.deepEqual(caseOf(acceptanceId)?.oracle, { kind: 'acceptance', ref: 'REQ-054', criterion: 'AC-212' })
  const foreign = await sdoTest({ action: 'plan', kind: 'unit', requirement: 'REQ-054', title: 'AC 不属于这条需求', steps: '[]', expected: 'ok', oracle: '{"kind":"acceptance","ref":"REQ-054","criterion":"AC-999"}' })
  assert.match(foreign, /❌/u, `AC 不属于所指需求必须判红：${foreign}`)
  assert.match(foreign, /AC-999/u, '要点名那个不属于它的 AC 编号')
  assert.match(foreign, /AC-212/u, '要点名它真正拥有的 AC（可核对）')

  // ② 契约类：必须存在**且有失败语义**
  writeContractFixture('CT-001', true)
  writeContractFixture('CT-002', false)
  const contractId = await plan('{"kind":"contract","ref":"CT-001"}')
  assert.deepEqual(caseOf(contractId)?.oracle, { kind: 'contract', ref: 'CT-001' })
  const noSemantics = await sdoTest({ action: 'plan', kind: 'unit', title: '契约没有失败语义', steps: '[]', expected: 'ok', oracle: '{"kind":"contract","ref":"CT-002"}' })
  assert.match(noSemantics, /❌/u, `没有失败语义的契约不能当判定基准：${noSemantics}`)
  assert.match(noSemantics, /失败语义/u, `要点名缺的是失败语义：${noSemantics}`)

  // ③ 基线类：必须绑 64 位哈希，且**现算比对**
  const missingHash = await sdoTest({ action: 'plan', kind: 'unit', title: '基线没绑哈希', steps: '[]', expected: 'ok', oracle: '{"kind":"baseline","ref":"frozen.js"}' })
  assert.match(missingHash, /❌/u, `基线类必须绑哈希：${missingHash}`)
  assert.match(missingHash, /baselineSha256/u, '要点名缺的字段是 `baselineSha256`')
  const wrongHash = await sdoTest({ action: 'plan', kind: 'unit', title: '基线哈希对不上', steps: '[]', expected: 'ok', oracle: `{"kind":"baseline","ref":"frozen.js","baselineSha256":"${'f'.repeat(64)}"}` })
  assert.match(wrongHash, /❌/u, `基线哈希与现算不符必须判红：${wrongHash}`)
  assert.match(wrongHash, /现算/u, '要讲清是"与现算不符"（而不是"文件不存在"）')
  const baselineId = await plan(`{"kind":"baseline","ref":"frozen.js","baselineSha256":"${goodHash}"}`)
  assert.equal(caseOf(baselineId)?.oracle?.baselineSha256, goodHash, '现算一致的基线哈希要落进台账')

  // ④ 专家判断类：必须写明**判断人**
  const noName = await sdoTest({ action: 'plan', kind: 'unit', title: '专家没写名字', steps: '[]', expected: 'ok', oracle: '{"kind":"expert"}' })
  assert.match(noName, /❌/u, `专家判断必须写判断人：${noName}`)
  assert.match(noName, /expert/u, '要点名缺的字段是 `expert`')
  const expertId = await plan('{"kind":"expert","expert":"张三"}')
  assert.equal(caseOf(expertId)?.oracle?.expert, '张三')

  // 四类都登记成功（合法取值不被一刀切拒掉）
  assert.equal(rows.length, 4, `四类合法判定基准都必须能通过工具面入账：${JSON.stringify(rows)}`)
})

// —————————————————————— ⑥ 参数真的落进 append-only 真源 ——————————————————————

test('M95-06 经工具面传的 oracle 真的落进 `test/recorded` 事件与结果台账（回读验证）', async () => {
  await sdoTest({ action: 'plan', kind: 'unit', title: '真源回读', steps: '[]', expected: 'ok' })
  const before = events('test/recorded').length

  const receipt = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
    oracle: '{"kind":"expert","ref":"REQ-054","expert":"张三"}',
  })
  assert.match(receipt, /TR-001/u)
  assert.equal(events('test/recorded').length, before + 1, '要落一条 test/recorded')

  const data = lastEvent('test/recorded')
  assert.equal(data.id, 'TR-001')
  assert.equal(data.oracleKind, 'expert', '类别要能从真源事件读回（工具面静默丢弃的话这里为空）')
  assert.equal(data.executedBy, 'dev-a')
  assert.equal(data.adoptedBy, 'qa-b')

  // 人读视图侧同样落盘（事件是"有没有被接收"，YAML 是"值是什么"）
  const result = resultOf('TR-001')
  assert.deepEqual(result?.oracle, { kind: 'expert', ref: 'REQ-054', expert: '张三' }, '完整判定基准要落进 `.sdo/tests/results/TR-001.yml`')
  assert.deepEqual(resultFiles(), ['TR-001.yml'], '结果文件按真源事件一一对应')

  // 反向：**形状非法**的判定基准判红、零写入（不是只有"缺"才拒）。
  const beforeBad = events('test/recorded').length
  const broken = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
    oracle: '{kind:expert}',
  })
  assert.match(broken, /❌/u, `不是合法 JSON 的 oracle 要判红：${broken}`)
  assert.equal(events('test/recorded').length, beforeBad, '形状非法 ⇒ 零写入（真源里仍只有 TR-001 那条）')
  assert.equal(resultOf('TR-002'), undefined, '判红时不许留下结果 YAML')

  // 解析出来不是对象（数组 / 字符串）同样判红
  const notObject = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
    oracle: '["expert"]',
  })
  assert.match(notObject, /❌/u, `不是对象的 oracle 要判红：${notObject}`)
  assert.equal(events('test/recorded').length, beforeBad, '形状非法同样零写入')
  assert.equal(listTestResults(store()).length, 1, '判红的调用不许落第 2 条结果')
})

// —————————————————————— 夹具：契约台账 ——————————————————————

function writeContractFixture(id: string, withSemantics: boolean): void {
  store().writeYaml(['contracts', `${id}.yml`], {
    contract: {
      id,
      name: id,
      kind: 'rpc',
      producer: 'a',
      consumer: 'b',
      schema: '{}',
      failureSemantics: withSemantics
        ? { timeout: '3s 后报超时', retry: '最多 2 次', idempotency: '按 caseId 幂等' }
        : { timeout: '', retry: '', idempotency: '' },
      at: new Date().toISOString(),
    },
  })
}
