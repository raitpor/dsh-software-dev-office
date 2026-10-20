/**
 * **增量 200：第十四批 `DEF-125`（`sdo_test` 没有「更正既有用例」的出口）—— 落点一的守卫。**
 *
 * 病根（真机三条在册：`TC-029` / `TC-031` / `TC-034`）：`plan` **永远分配新 TC 号**
 * （`recordTestCase` 的语义），于是用例的 `requirement` 一旦挂错就**永久与追溯图打架**——
 * 图上说 `REQ-004`、用例文件里写着 `REQ-035`；唯一"出路"是手改 `.sdo/tests/TC-*.yml`，
 * 而那正是 D4/R1 要挡的手维真源（手改绕过形状校验与 append-only 事件）。
 *
 * 本文件钉住四件事（DoD ①②）：
 *   ① `update` 成功路径：改 `requirement` ⇒ 回执**逐条列出**撤销/新建的 `req-tc` 边，且
 *      `sdo_trace` 那一份实现查得到新边（旧边消失）；
 *   ② 反向对照：只改 `title`/`steps`/`expected` ⇒ 追溯边**一条都不动**（防"顺手改图"）；
 *   ③ 三种拒绝（用例不存在 / requirement 不存在 / 空 `caseId`）**逐条点名**且**零写盘**；
 *   ④ 静默丢弃的反面：给了非法 `kind` ⇒ 可读拒绝；给的字段与现值相同 ⇒ 明说"没有变化"（不回"已更新"）。
 *
 * ⚠️ 读散文棘轮（`M189-08`）：本文件的断言**期望值一律 ASCII**，中文只进三实参断言的**消息位**。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { SoftwareDevOffice } from '../src/office.js'
import { SdoStore } from '../src/infra/store.js'
import { SIGNATURE_NEUTRAL_EVENTS, TEST_ACTIONS, actionList, isSignatureInvalidatingEvent } from '../src/types.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TestCase } from '../src/domain/records.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm200')
const WORKSPACE = join(BASE, 'proj')

let office: SoftwareDevOffice
const call = { sessionId: 's-cockpit', cwd: WORKSPACE } as unknown as OfficeCall

/** 用例台账（`.sdo/tests/TC-*.yml` 的唯一读面）。 */
function store(): SdoStore {
  return office.storeFor(WORKSPACE)
}

function caseFile(caseId: string): TestCase | undefined {
  return store().readYaml<{ testCase: TestCase }>('tests', `${caseId}.yml`)?.testCase
}

/** `test/case-updated` 事件（append-only 真源那一侧）。 */
function updateEvents(): { seq: number; data: Record<string, unknown> }[] {
  return office
    .journalFor(WORKSPACE)
    .read()
    .events.filter((event) => event.type === 'test/case-updated')
    .map((event) => ({ seq: event.seq, data: event.data }))
}

/** 某条需求在追溯图上挂着哪些用例（走 `sdo_trace` 的同一份实现）。 */
function casesOf(requirement: string): string[] {
  return office.traceReport(call).perRequirement.find((row) => row.id === requirement)?.tests ?? []
}

interface ToolDefinition { name: string; parameters: { properties?: Record<string, unknown> }; execute: (args: Record<string, unknown>, exec: unknown) => unknown }

/** 真注册面（与 `apply()` 装出来的那一份同源）。 */
function toolHarness(): (name: string, args: Record<string, unknown>) => Promise<string> {
  const tools: ToolDefinition[] = []
  const services: Record<string, unknown> = { tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } } }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  return async (name, args) => {
    const tool = tools.find((item) => item.name === name)
    assert.equal(tool !== undefined, true, `工具面缺少 ${name}`)
    const exec = { agent: { id: 's-cockpit', session: { header: { id: 's-cockpit', cwd: WORKSPACE, delegationDepth: 0 } } } }
    return String(await tool!.execute(args, exec))
  }
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-cockpit', WORKSPACE)
  office.init(call, { name: 'M200 用例更正出口', scale: 'normal', stakeholders: ['业务方'] })
  // 两条需求：用例先挂 `REQ-002`（模拟"挂错了"），更正到 `REQ-001`
  for (const id of ['REQ-001', 'REQ-002']) {
    store().writeYaml(['requirements', `${id}.yml`], {
      requirement: { id, title: id, statement: `${id} 的陈述`, priority: 'must', status: 'baselined', acceptance: [] },
    })
  }
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M200-01 结构（三处同源）：`update` 进动作常量、进 handler 分支、进 schema 描述、事件进中性表', () => {
  // ① 动作常量：`tools.ts` 的 schema 描述由 `actionList(TEST_ACTIONS)` 生成 ⇒ 这里进一个就等于三处同源
  assert.equal((TEST_ACTIONS as readonly string[]).includes('update'), true, 'update 必须进 TEST_ACTIONS（动作清单的唯一来源）')
  assert.equal(actionList(TEST_ACTIONS).includes("'update'"), true, 'schema 的动作清单必须由常量生成（别在 tools.ts 另写一份词表）')
  // ② handler 分支：`m17` 的漂移守卫只认 `case 'x'` / `action === 'x'` 字面量（写成 helper 判断等于绕守卫）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.equal(index.includes("case 'update': {"), true, 'index.ts 必须有**字面量**分支 case update')
  assert.equal(index.includes('updateTestCase('), true, '分支必须调到域层唯一写入口 updateTestCase')
  // ③ 事件：更正落 append-only 真源，且是**中性事件**（改用例元数据不改设计真源 ⇒ 不作废 G3 签字）
  assert.equal((SIGNATURE_NEUTRAL_EVENTS as readonly string[]).includes('test/case-updated'), true, 'test/case-updated 必须进中性表')
  assert.equal(isSignatureInvalidatingEvent('G3', 'test/case-updated'), false, '更正用例不得作废设计签字')
})

test('M200-02 成功路径：改 requirement ⇒ 回执逐条列出撤销/新建的边，文件与追溯图一起改对', async () => {
  const callTool = toolHarness()
  // 前置：一条挂在 REQ-002 上的用例 + 图上真有那条边（= DEF-125 的伤口形态）
  const planned = await callTool('sdo_test', { action: 'plan', title: 'clamp 的边界', kind: 'unit', requirement: 'REQ-002', steps: ['跑'], expected: '通过' })
  assert.equal(planned.includes('TC-001'), true, `前置：用例必须建出来：${planned.slice(0, 200)}`)
  office.linkTrace(call, [{ from: 'REQ-002', to: 'TC-001', kind: 'req-tc' }])
  assert.deepEqual(casesOf('REQ-002'), ['TC-001'], '前置：图上 REQ-002 挂着 TC-001')
  const eventsBefore = updateEvents().length

  // 动作：把用例更正到 REQ-001（旧口径下这一步**没有出口**）
  const receipt = await callTool('sdo_test', { action: 'update', caseId: 'TC-001', requirement: 'REQ-001' })
  // ① 回执逐条列出两条边：撤销 REQ-002→TC-001、新建 REQ-001→TC-001
  assert.match(receipt, /REQ-002\W+TC-001/u, `回执必须点名被撤销的旧边：${receipt}`)
  assert.match(receipt, /REQ-001\W+TC-001/u, `回执必须点名新建的边：${receipt}`)
  // ② 用例文件真的改了
  assert.equal(caseFile('TC-001')?.requirement, 'REQ-001', '用例文件的 requirement 必须改成新值')
  // ③ 追溯图真的改了（走 `sdo_trace` 那一份实现：旧边消失、新边在）
  assert.deepEqual(casesOf('REQ-001'), ['TC-001'], '新边必须查得到（sdo_trace 的同一份读数）')
  assert.deepEqual(casesOf('REQ-002'), [], '旧边必须撤销（否则同一条用例挂两条需求 = 覆盖率虚增）')
  // ④ 真源留痕：一条 `test/case-updated`，带**前后值**
  const events = updateEvents()
  assert.equal(events.length, eventsBefore + 1, '更正必须落恰好一条 test/case-updated 事件')
  const data = events[events.length - 1]!.data
  assert.equal(data['id'], 'TC-001', '事件必须点名用例')
  assert.equal(data['previousRequirement'], 'REQ-002', '事件必须记下**更正前**的 requirement')
  const changes = data['changes'] as { field?: string; from?: string; to?: string }[]
  assert.deepEqual(changes.map((row) => row.field), ['requirement'], '只有 requirement 这一格变了')
  assert.equal(changes[0]?.to, 'REQ-001', '事件的 to 必须是新值')
})

test('M200-03 反向对照：只改 title/steps/expected ⇒ 追溯边一条都不动（防"顺手改图"）', async () => {
  const callTool = toolHarness()
  await callTool('sdo_test', { action: 'plan', title: 'old-title', kind: 'unit', requirement: 'REQ-001', steps: ['old-step'], expected: 'old-expected' })
  office.linkTrace(call, [{ from: 'REQ-001', to: 'TC-001', kind: 'req-tc' }])
  const linksBefore = readFileSync(join(WORKSPACE, '.sdo', 'trace', 'links.jsonl'), 'utf8')
  const receipt = await callTool('sdo_test', {
    action: 'update', caseId: 'TC-001', title: 'new-title', steps: ['step-a', 'step-b'], expected: 'new-expected',
  })
  assert.equal(receipt.includes('title'), true, `回执必须回显字段差异：${receipt}`)
  const updated = caseFile('TC-001')
  assert.equal(updated?.title, 'new-title', 'title 必须真的改了')
  assert.deepEqual(updated?.steps, ['step-a', 'step-b'], 'steps（真数组形态）必须逐条落盘')
  assert.equal(updated?.expected, 'new-expected', 'expected 必须真的改了')
  // 边一条都没动（`requirement` 没给 ⇒ 图的字节一字不变）
  assert.equal(readFileSync(join(WORKSPACE, '.sdo', 'trace', 'links.jsonl'), 'utf8'), linksBefore, '没动 requirement 就不许动追溯图')
})

test('M200-04 拒绝①：用例不存在 ⇒ 点名 + 零写盘（不凭空造用例）', async () => {
  const callTool = toolHarness()
  await callTool('sdo_test', { action: 'plan', title: 't', kind: 'unit', requirement: 'REQ-001', steps: [], expected: 'x' })
  const before = readFileSync(join(WORKSPACE, '.sdo', 'tests', 'TC-001.yml'), 'utf8')
  const receipt = await callTool('sdo_test', { action: 'update', caseId: 'TC-999', title: 't2' })
  assert.equal(receipt.includes('TC-999'), true, `拒绝必须点名那条不存在的用例：${receipt}`)
  assert.equal(updateEvents().length, 0, '被拒时零写盘（不得落 test/case-updated 事件）')
  assert.equal(readFileSync(join(WORKSPACE, '.sdo', 'tests', 'TC-001.yml'), 'utf8'), before, '既有用例一字不动')
  assert.equal(store().exists('tests', 'TC-999.yml'), false, '不许顺手把不存在的用例建出来')
})

test('M200-05 拒绝②：requirement 不存在 ⇒ 点名 + 零写盘（文件与追溯图都不动）', async () => {
  const callTool = toolHarness()
  await callTool('sdo_test', { action: 'plan', title: 't', kind: 'unit', requirement: 'REQ-001', steps: [], expected: 'x' })
  office.linkTrace(call, [{ from: 'REQ-001', to: 'TC-001', kind: 'req-tc' }])
  const linksBefore = readFileSync(join(WORKSPACE, '.sdo', 'trace', 'links.jsonl'), 'utf8')
  const receipt = await callTool('sdo_test', { action: 'update', caseId: 'TC-001', requirement: 'REQ-777' })
  assert.equal(receipt.includes('REQ-777'), true, `拒绝必须点名那个查不到的需求：${receipt}`)
  assert.equal(receipt.includes('REQ-001'), true, '可执行修法要点名现有需求（否则读者不知道改成什么才对）')
  assert.equal(caseFile('TC-001')?.requirement, 'REQ-001', '被拒时用例文件一字不动')
  assert.equal(updateEvents().length, 0, '被拒时零写盘')
  assert.equal(readFileSync(join(WORKSPACE, '.sdo', 'trace', 'links.jsonl'), 'utf8'), linksBefore, '被拒时追溯图一字不动')
})

test('M200-06 拒绝③：空 caseId ⇒ 点名 + 零写盘（没有对象就没有"更正"）', async () => {
  const callTool = toolHarness()
  await callTool('sdo_test', { action: 'plan', title: 't', kind: 'unit', requirement: 'REQ-001', steps: [], expected: 'x' })
  const receipt = await callTool('sdo_test', { action: 'update', title: 't2' })
  assert.equal(receipt.includes('caseId'), true, `拒绝必须点名缺的那个参数：${receipt}`)
  assert.equal(updateEvents().length, 0, '被拒时零写盘')
  assert.equal(caseFile('TC-001')?.title, 't', '既有用例一字不动')
})

test('M200-07 静默丢弃的反面：非法 kind 可读拒绝；与现值相同 ⇒ 明说"没有变化"（不回"已更新"）', async () => {
  const callTool = toolHarness()
  await callTool('sdo_test', { action: 'plan', title: 't', kind: 'unit', requirement: 'REQ-001', steps: [], expected: 'x' })
  // ① 非法 kind：`parseEnum` 会把它归一成 undefined（= "没给"）⇒ 更新路径必须从**原样值**看出来并拒绝
  const badKind = await callTool('sdo_test', { action: 'update', caseId: 'TC-001', kind: 'smoke' })
  assert.equal(badKind.includes('smoke'), true, `拒绝必须点名那个非法取值：${badKind}`)
  assert.equal(caseFile('TC-001')?.kind, 'unit', '被拒时 kind 不动')
  assert.equal(updateEvents().length, 0, '被拒时零写盘')
  // ② no-op：给的字段与现值逐字相同 ⇒ 没有真源写入，也不回"已更新"
  const noop = await callTool('sdo_test', { action: 'update', caseId: 'TC-001', title: 't' })
  assert.equal(noop.includes('TC-001'), true, `no-op 也必须点名用例：${noop}`)
  assert.equal(updateEvents().length, 0, 'no-op 不得落事件（"我改了"不许读成"它变了"）')
  // ③ 真改一格 ⇒ 有了事件（证明上面②的空事件不是因为这条路根本不通）
  const real = await callTool('sdo_test', { action: 'update', caseId: 'TC-001', kind: 'integration' })
  assert.equal(real.includes('kind'), true, `成功回执必须回显改哪一格：${real}`)
  assert.equal(caseFile('TC-001')?.kind, 'integration', 'kind 必须真的改了')
  assert.equal(updateEvents().length, 1, '成功路径必须落恰好一条事件')
})
