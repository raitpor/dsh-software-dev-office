/**
 * M94：**缺陷三字段与结果执行者/采纳者 —— 工具参数面收口**（TASK-039 / REQ-055 / REQ-053 / 判据 `C-50`）。
 *
 * 为什么整个文件都走**真实注册的工具**（`apply()` → 注册表 → `execute`）而不是直接调 `office.*`：
 * 本卡要修的缺陷正好长在**工具边界**上 —— 参数只在 `execute` 里解构、没进 `parameters` schema（或反之），
 * 或者工具面拿到了、`deps` 映射没搬，值都会**静默丢弃**：不报错、回执还说成功、域层产物零写入。
 * 只调 `office.*` 的用例**绕过注册表边界**，照不出这类缺陷（知识库 `tq_ff348198` 的真机教训）。
 * 因此本文件的证据一律是**从 append-only 事件回读**：`defect/recorded` / `test/recorded` 的事件载荷里
 * 有没有那几个字段，才是"参数真的被接收"；回执说成功不算。
 *
 * 两态守卫（每条都先证伪、再证真）：
 *
 * | # | 情形 | 期望 |
 * |---|---|---|
 * | ① | defect 给全三字段 | 入账，且 `defect/recorded` 事件里**读得回**三字段（回执同时回显） |
 * | ② | defect 给非法 `discoveryLevel` | 判红 + **点名六个合法词** + 不入账；换合法值 ⇒ 入账 |
 * | ③ | record 给 `executedBy`/`adoptedBy` | 真被接收：`test/recorded` 事件里读得回，采纳时刻由记录端盖上 |
 * | ④ | 自执行自采纳 | 回执当场点名；`C-50` 判红并**点名该结果 id** |
 * | ⑤ | 不给字段 | **不落值**（事件与 YAML 里都没有这些键）、也不假装 `false` |
 * | ⑥ | `C-50` 读 `passedAdopted` | 未采纳 ⇒ 判红并点名；补齐采纳三件套 ⇒ 转绿；既有 `passed` 口径不变 |
 *
 * 夹具是本仓**自己的**工作区（`node_modules/.sdo-test/m94/proj`）：项目也用真实工具 `sdo_init` 建，
 * 不手写 `.sdo/` —— 手写真源在本仓是"不算证据"的形态（D4），用在这里会让"参数被接收"这一结论失去效力。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'

import { Config } from '../src/config.js'
import type { SdoConfig } from '../src/config.js'
import { CHECKERS } from '../src/domain/gates.js'
import type { GateContext } from '../src/domain/gates.js'
import { DEFECT_DISCOVERY_LEVELS, listDefects, verificationStats } from '../src/domain/records.js'
import type { Defect } from '../src/domain/records.js'
import { Journal } from '../src/infra/journal.js'
import { SdoStore } from '../src/infra/store.js'
import { apply } from '../src/index.js'
import type { JournalEvent } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm94')
const WORKSPACE = join(BASE, 'proj')
const SESSION = 'm94-session'

/** 一次**真实装配**：`apply()` 注册进宿主工具表的那一份定义（含 clamp 包装），不是手工拼的假工具。 */
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
  const tool = (name: string): RegisteredTool => {
    const found = registered.get(name)
    if (found === undefined) throw new Error(`真实装配没有注册 ${name}（注册表里只有：${[...registered.keys()].join(', ')}）`)
    return found
  }
  return {
    tool,
    // **取会话工作目录只能读 `agent.session.header.cwd`**（dsh-agent 0.2.0-rc.1 上没有顶层 cwd）
    exec: () => ({ name: 'sdo_test', arguments: {}, agent: { session: { header: { id: SESSION, cwd: WORKSPACE, delegationDepth: 0 } } } }),
    fire: (event, payload) => listeners.get(event)?.(payload as never),
  }
}

/** 走真实注册的工具：`sdo_test`。 */
async function sdoTest(args: Record<string, unknown>): Promise<string> {
  return String(await harness.tool('sdo_test').execute(args, harness.exec()))
}

function store(): SdoStore {
  return new SdoStore(join(WORKSPACE, '.sdo'))
}

function journal(): Journal {
  return new Journal(store())
}

/** **真源回读**：只要事件（append-only），不看回执怎么说。 */
function events(type: string): JournalEvent[] {
  return journal().read().events.filter((event) => event.type === type)
}

function lastEvent(type: string): Record<string, unknown> {
  const hit = events(type).at(-1)
  assert.ok(hit !== undefined, `真源里必须有 ${type} 事件（没有就是工具面把值丢了）`)
  return (hit as { data: Record<string, unknown> }).data
}

/** G6 的 `C-50 tests.passed` 真实接线（判据集里注册的那一个，不是本文件另写一份口径）。 */
function gateContext(): GateContext {
  return { workspace: WORKSPACE, store: store(), journal: journal(), requirements: [] } as unknown as GateContext
}

function c50(): { ok: boolean; detail: string; remedy?: string } {
  const checker = CHECKERS['tests.passed']
  assert.equal(typeof checker, 'function', 'tests.passed 必须在 CHECKERS 里注册')
  if (checker === undefined) throw new Error('tests.passed 未注册')
  const verdict = checker(gateContext())
  return { ok: verdict.ok === true, detail: verdict.detail ?? '', ...(verdict.remedy === undefined ? {} : { remedy: verdict.remedy }) }
}

beforeEach(async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  harness = makeHarness()
  // 会话 → 工作目录：真实装配靠 `session/created` 记住它（这里发同一条事件，不走后门）
  harness.fire('session/created', { id: SESSION, header: { cwd: WORKSPACE } })
  // 项目也用真实工具建（`sdo_init` 要求四要素齐备，缺一个就只回问询单）
  const receipt = await harness.tool('sdo_init').execute(
    { name: 'M94 夹具', process: 'waterfall', scale: 'normal', stakeholders: '执行者,采纳者' },
    harness.exec(),
  )
  assert.match(String(receipt), /PRJ-001/u, `夹具立项失败：${String(receipt)}`)
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

// —————————————————————— ① 三字段经工具面入账，从事件回读 ——————————————————————

test('M94-01 缺陷三字段经真实注册的工具入账，并从 defect/recorded 事件读回（落点一/二）', async () => {
  const receipt = await sdoTest({
    action: 'defect',
    title: '采纳者没登记在门禁里',
    severity: 'major',
    rootCause: '工具面没把 executedBy/adoptedBy 搬进域层',
    discoveryLevel: '集成',
    escaped: true,
  })
  assert.match(receipt, /DEF-001/u, `回执要点名缺陷 id：${receipt}`)

  // **机械证据**：值必须在 append-only 真源里（工具面静默丢弃的话，这里读不出来）
  const data = lastEvent('defect/recorded')
  assert.equal(data.rootCause, '工具面没把 executedBy/adoptedBy 搬进域层', '根因必须从真源事件读得回')
  assert.equal(data.discoveryLevel, '集成', '发现级别必须从真源事件读得回')
  assert.equal(data.escaped, true, '是否逃逸必须从真源事件读得回，且要是**真布尔**')
  assert.equal(typeof data.escaped, 'boolean', '不许落成字符串 "true"')

  // 人读视图（`.sdo/defects/DEF-001.yml`）同样落盘
  const defect = store().readYaml<{ defect: Defect }>('defects', 'DEF-001.yml')?.defect
  assert.equal(defect?.rootCause, '工具面没把 executedBy/adoptedBy 搬进域层')
  assert.equal(defect?.discoveryLevel, '集成')
  assert.equal(defect?.escaped, true)
  assert.equal(listDefects(store()).length, 1)

  // 回执回显「真被接收了什么」——不回显就等于让调用方猜（回执层也是同改点之一）
  assert.match(receipt, /rootCause/u, `回执要回显被接收的字段名：${receipt}`)
  assert.match(receipt, /discoveryLevel/u, `回执要回显被接收的字段名：${receipt}`)
  assert.match(receipt, /escaped/u, `回执要回显被接收的字段名：${receipt}`)
})

// —————————————————————— ② 非法发现级别：判红 + 点名合法集合 ——————————————————————

test('M94-02 非法 discoveryLevel 判红并点名六个合法词，且不入账；换合法值即入账（两态）', async () => {
  const before = events('defect/recorded').length
  const bad = await sdoTest({ action: 'defect', title: '发现级别写错', severity: 'minor', discoveryLevel: '回归' })

  assert.match(bad, /❌/u, `非法取值必须**可读拒绝**：${bad}`)
  assert.match(bad, /回归/u, '要点名那个非法值本身（不许只说"非法"）')
  for (const level of DEFECT_DISCOVERY_LEVELS) {
    assert.ok(bad.includes(level), `回执要点名合法取值「${level}」：${bad}`)
  }
  assert.equal(events('defect/recorded').length, before, '判红时**不许**入账（判红却落盘 = 假拒绝）')
  assert.equal(listDefects(store()).length, 0, '拒绝的缺陷不许留在台账里')

  // 绿态：同一份夹具、只把发现级别换成词表内的值 ⇒ 入账
  const good = await sdoTest({ action: 'defect', title: '发现级别写错', severity: 'minor', discoveryLevel: '系统' })
  assert.match(good, /DEF-001/u, `合法取值必须入账：${good}`)
  assert.equal(events('defect/recorded').length, before + 1, '合法取值要落一条 defect/recorded')
  assert.equal(lastEvent('defect/recorded').discoveryLevel, '系统')
})

// —————————————————————— ③ 执行者/采纳者经工具面真的被接收 ——————————————————————

test('M94-03 经工具面传 executedBy/adoptedBy 真的被接收：test/recorded 事件里读得回（落点一/三）', async () => {
  // 用例与它的**判定基准**都经工具面登记（oracle 的参数面由 **TASK-054** 补齐；此前这条只能先用
  // 域层把基准备好 —— 那正是"域层可用、真机够不着"的形态，见 tq_24527f46）
  const planned = await sdoTest({
    action: 'plan',
    kind: 'unit',
    title: '独立采纳的用例',
    steps: '["跑断言"]',
    expected: '全绿',
    oracle: '{"kind":"expert","expert":"评审员"}',
  })
  assert.match(planned, /TC-001/u, `用例编号按登记顺序走：${planned}`)

  const receipt = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test lib/test/m94.test.js ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
  })
  assert.match(receipt, /TR-001/u, `回执要点名结果 id：${receipt}`)

  // **机械证据**：值必须在 append-only 真源里（工具面静默丢弃的话，这里读不出来）
  const data = lastEvent('test/recorded')
  assert.equal(data.executedBy, 'dev-a', '执行者必须从真源事件读得回（REQ-053 的一端）')
  assert.equal(data.adoptedBy, 'qa-b', '采纳者必须从真源事件读得回（REQ-053 的一端）')
  assert.equal(typeof data.adoptedAt, 'string', '采纳动作要由记录端盖上采纳时刻（不许要求调用方自己记得写）')

  const stats = verificationStats(store(), journal())
  assert.equal(stats.passed, 1, '既有口径不变：passed 仍数"台账里有几条最新 pass"')
  assert.equal(stats.passedAdopted, 1, '执行者 ≠ 采纳者 + 判定基准成立 ⇒ 计入通过（参数不只是被收下，还真起了作用）')
  assert.deepEqual(stats.unadopted, [], '不该有未采纳的结果')
  assert.match(receipt, /dev-a/u, `回执要回显执行者/采纳者：${receipt}`)
  assert.match(receipt, /qa-b/u, `回执要回显执行者/采纳者：${receipt}`)
})

test('M94-03b 有执行者/采纳者但**没有判定基准**时，工具面判红并点名（TASK-054 交付的出口）', async () => {
  // **TASK-054 之后语义收紧了**：判定基准是必填 —— 不再"先记一条、回执提醒它不计入"（那种
  // "记了却不算数"的记录正是走过场），而是**当场可读拒绝、零写入**，并点名缺哪一类与怎么补。
  const planned = await sdoTest({ action: 'plan', kind: 'unit', title: '没有判定基准的用例', steps: '[]', expected: 'ok' })
  assert.match(planned, /TC-001/u, `用例要建出来：${planned}`)
  const before = events('test/recorded').length
  const receipt = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
  })
  // 两个端点都给了 ⇒ 不许再回"没有登记 executedBy/adoptedBy"（那是另一条回执的事）
  assert.doesNotMatch(receipt, /没有登记 (executedBy|adoptedBy)/u, `端点齐了就不该报缺端点：${receipt}`)
  assert.match(receipt, /❌/u, `缺判定基准必须判红：${receipt}`)
  assert.match(receipt, /oracle/u, `要点名缺的那一环（判定基准）：${receipt}`)
  for (const kind of ['acceptance', 'contract', 'baseline', 'expert']) {
    assert.ok(receipt.includes(kind), `要点名四类合法取值「${kind}」：${receipt}`)
  }
  assert.equal(events('test/recorded').length, before, '判红时零写入（真源里没有这条结果）')

  const stats = verificationStats(store(), journal())
  assert.equal(stats.passed, 0, '判红 ⇒ 台账里没有这条 pass（不再有"记了但不算"的中间态）')
  assert.equal(stats.passedAdopted, 0, '判定基准不成立 ⇒ 不予计入（REQ-054）')
  assert.deepEqual(stats.unadopted, [], '零写入 ⇒ 没有需要点名的未采纳结果')
})

// —————————————————————— ④ 自执行自采纳：判红 + 点名 ——————————————————————

test('M94-04 自执行自采纳被判红并点名（回执当场点名 + C-50 判红点名该结果）', async () => {
  // 判定基准先给齐（TASK-054 起必填）⇒ 这条结果**记得下来**，红的是"采纳者 = 执行者"那一条
  await sdoTest({ action: 'plan', kind: 'unit', title: '自跑自盖章的用例', steps: '["跑断言"]', expected: '全绿', oracle: '{"kind":"expert","expert":"评审员"}' })

  // ① 回执当场点名（不许等 G6 判红才让模型知道这条不算数）
  const receipt = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test lib/test/m94.test.js ⇒ 全绿',
    executedBy: 'dev-a',
    adoptedBy: 'dev-a',
    // **TASK-054**：判定基准必填 —— 这条钉的是"自己给自己盖章"，所以要先把判定基准这一关过掉，
    // 让拒绝的理由只剩"采纳者 = 执行者"这一条（否则红得不明不白）
    oracle: '{"kind":"expert","expert":"评审员"}',
  })
  assert.match(receipt, /dev-a/u, `回执要点名那个人：${receipt}`)
  assert.match(receipt, /不算独立采纳/u, `回执要说清后果（自己给自己盖章不算独立采纳）：${receipt}`)

  // ② 判据层：C-50 判红并点名该结果 id
  const stats = verificationStats(store(), journal())
  assert.equal(stats.passed, 1, '既有口径不变：台账里确实有一条 pass')
  assert.equal(stats.passedAdopted, 0, '新口径：自执行自采纳**不予计入**')
  assert.deepEqual(stats.unadopted, ['TR-001'], '未采纳名单要逐条点名')

  const red = c50()
  assert.equal(red.ok, false, `未独立采纳的 pass 不许让 C-50 判绿：${red.detail}`)
  assert.match(red.detail, /TR-001/u, `C-50 要点名是哪条结果：${red.detail}`)
  assert.match(red.detail ?? '', /TR-001/u)
  assert.ok((red.remedy ?? '').includes('executedBy'), `修法要给出可执行动作（点名参数）：${red.remedy ?? ''}`)
})

// —————————————————————— ⑤ 不给字段：不落值、也不假装 false ——————————————————————

test('M94-05 未给字段时**不落值**（事件与 YAML 里都没有这些键），且 record 侧给明确回执', async () => {
  const receipt = await sdoTest({ action: 'defect', title: '没给根因面', severity: 'minor' })
  assert.match(receipt, /DEF-001/u)

  const data = lastEvent('defect/recorded')
  for (const key of ['rootCause', 'discoveryLevel', 'escaped']) {
    assert.equal(key in data, false, `没给 ${key} 时不许落键（更不许假装 false / 空串）`)
  }
  const defect = store().readYaml<{ defect: Defect }>('defects', 'DEF-001.yml')?.defect
  for (const key of ['rootCause', 'discoveryLevel', 'escaped']) {
    assert.equal(key in (defect ?? {}), false, `YAML 侧同样不许凭空落键：${key}`)
  }
  assert.match(receipt, /没有落盘/u, `三个字段一个都没给时要如实说（不许让"没给"读成"已给"）：${receipt}`)

  // record 侧：缺 executedBy/adoptedBy ⇒ **明确回执**（点名参数 + 说清它进不了 passedAdopted）
  await sdoTest({ action: 'plan', kind: 'unit', title: '缺参数的用例', steps: '[]', expected: 'ok', oracle: '{"kind":"expert","expert":"评审员"}' })
  const rec = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿',
    // 判定基准（TASK-054 起必填）先给齐，这条才测得到"缺 executedBy/adoptedBy"那一族回执
    oracle: '{"kind":"expert","expert":"评审员"}',
  })
  assert.match(rec, /executedBy/u, `缺参数要明确回执而不是静默丢弃：${rec}`)
  assert.match(rec, /adoptedBy/u, `缺参数要明确回执而不是静默丢弃：${rec}`)
  assert.match(rec, /REQ-053|passedAdopted/u, `要说清后果（进不了 passedAdopted / G6 会点名）：${rec}`)

  const rdata = lastEvent('test/recorded')
  for (const key of ['executedBy', 'adoptedBy', 'adoptedAt']) {
    assert.equal(key in rdata, false, `没给 ${key} 时不许落键（更不许假装成某个人）`)
  }
})

// —————————————————————— ⑥ C-50 读 passedAdopted 并点名 unadopted ——————————————————————

test('M94-06 C-50 在 unadopted 非空时判红并点名；补齐采纳三件套 ⇒ 转绿；既有 passed 口径不变（落点四）', async () => {
  // 红侧：**自跑自记**的真机形态 —— 通过工具面登记用例与结果，不给执行者/采纳者/判定基准
  await sdoTest({ action: 'plan', kind: 'unit', title: '只跑不采纳的用例', steps: '["跑断言"]', expected: '全绿', oracle: '{"kind":"expert","expert":"评审员"}' })
  // 判定基准（TASK-054 起必填）先给齐 ⇒ 这条结果**记下来了**，但缺执行者/采纳者 ⇒ 仍不予计入
  await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿',
    oracle: '{"kind":"expert","expert":"评审员"}',
  })

  const before = verificationStats(store(), journal())
  assert.equal(before.passed, 1, '既有口径不变：passed 仍数"台账里有几条最新 pass"（m52/m56/m85 同一口径）')
  assert.equal(before.passedAdopted, 0, '新口径：一条都没被独立采纳（缺执行者/采纳者/判定基准）')

  const red = c50()
  assert.equal(red.ok, false, `未采纳的 pass 不许让 C-50 判绿：${red.detail}`)
  assert.match(red.detail, /TR-001/u, `要点名未采纳的结果：${red.detail}`)

  // 绿侧：补齐"采纳三件套"（执行者 / 采纳者 / 判定基准）⇒ 同一条用例的最新结果被独立采纳。
  // **TASK-054 之前**这一步只能用域层函数（`recordTestResult`）搭出来 —— 工具面根本没有 `oracle`
  // 这个参数，"补齐三件套"在真机上**无出口**。现在它走**真实注册的工具**（这也是那条出口的回归）。
  const greenReceipt = await sdoTest({
    action: 'record',
    caseId: 'TC-001',
    status: 'pass',
    evidence: 'node --test ⇒ 全绿（由独立采纳者复核）',
    executedBy: 'dev-a',
    adoptedBy: 'qa-b',
    oracle: '{"kind":"expert","expert":"评审员"}',
  })
  assert.match(greenReceipt, /TR-002/u, `补齐三件套必须能经工具面入账：${greenReceipt}`)

  const after = verificationStats(store(), journal())
  assert.equal(after.passed, 1, '既有口径仍不变（latest-wins：仍是一条 pass）')
  assert.equal(after.passedAdopted, 1, '执行者 ≠ 采纳者 + 判定基准成立 ⇒ 计入通过')
  assert.deepEqual(after.unadopted, [], '未采纳名单要清空')

  const green = c50()
  assert.equal(green.ok, true, `采纳三件套齐备后 C-50 必须能绿（绿态可达）：${green.detail}`)
  assert.doesNotMatch(green.detail, /TR-001/u, '转绿后不该再点名该结果')

  // ── **TASK-068：绿路径的回执读数**（处置 TASK-039 探针②的那半条 survived）──
  // 探针② = 「删掉本判据的 unadopted 判红块 + 把绿路径读物从 `stats.passedAdopted` 退回 `stats.passed`」。
  // 判红那一半有 M94-04/M94-06 承托（本文件两条被杀）；**"读物退回"那一半在本判据上等价** ——
  // 走到这一行的前提是 `stats.unadopted.length === 0`，而 `verificationStats` 的口径是
  // `passedAdopted = passed - unadopted.length`（见 `src/domain/records.ts` 的该字段文档）
  // ⇒ 前提成立时 `stats.passed === stats.passedAdopted`，两个表达式的**逐字回执、判定与补救动作全同**。
  // 所以这不是"断言面缺口"，是**等价变异体**（证明可复算：grep unadopted 的判红前置 + 读该字段口径）。
  // 这里仍然把绿路径的**可观察回执**钉住（它此前确实没有任何断言承托），顺带记下等价判读的依据：
  assert.match(
    green.detail,
    new RegExp(`用例\\s*\\d+\\s*条全部有结果（通过\\s*${after.passedAdopted}）`, 'u'),
    `绿路径回执必须报**已采纳**的通过数（${after.passedAdopted}）：${green.detail}`,
  )
  assert.doesNotMatch(green.detail, /未独立采纳|unadopted/iu, `转绿后不该再报未采纳：${green.detail}`)
})
