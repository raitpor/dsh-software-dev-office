/**
 * **增量 181：第六批 §3.1（`R13`②，最高优先）+ §3.2（`R11` 的 `steps`）。**
 *
 * §3.1 的教训（我上一批**改反了方向**）：`sdo_plan action=profile` 的 `exempt` 描述被我从"写侧强制两键"
 * 改成了"宽容映射"——而现盘行为是**写侧强制**（`office.decideConstructionProfile` 的 `c40`/`c41`：
 * 缺键或非字符串 ⇒ **整次拒绝、零写盘**），只有**读端**对旧条目宽容。本用例两半都要：
 *   · **行为**：真注册面三态（缺 `approvedBy` ⇒ 拒 / 缺 `impact` ⇒ 拒 / 两键齐 ⇒ 落盘）；
 *   · **结构**：出厂描述必须写"必须/拒绝"语义（不许再写"映射成空串"那套）。
 * `M180-03` 只读描述文本、**一次 `execute` 都没有** —— 所以这里必须走真机面。
 *
 * §3.2：`steps` 语义上是列表却声明成纯 `string`（调用方只能传 JSON 文本，且**含 `", "` 分隔符的文本
 * 会被宿主拒**）⇒ 改 `listDecl` + 调用面 `compositeArg`。三态：真数组 / JSON 文本 / 都不给。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config } from '../src/config.js'
import { apply } from '../src/index.js'
import { readConstructionProfile } from '../src/domain/construction.js'
import { createOfficeTools, listParamNames } from '../src/interface/tools.js'
import { SdoStore } from '../src/infra/store.js'
import type { SdoConfig } from '../src/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm181')

interface ToolDefinition { name: string; parameters: { properties?: Record<string, unknown> }; execute: (args: Record<string, unknown>, exec: unknown) => unknown }

function tools(): ToolDefinition[] {
  const registered: ToolDefinition[] = []
  const services: Record<string, unknown> = { tools: { register: (tool: ToolDefinition) => { registered.push(tool); return () => {} } }, sessions: {} }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
  return registered
}
const execStub = { agent: { id: 's1', session: { header: { id: 's1', cwd: join(BASE, 'proj'), delegationDepth: 0 } } } }
const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
  const tool = tools().find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  return String(await tool.execute(args, execStub))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(BASE, 'proj', '.sdo', 'construction'), { recursive: true })
})
afterEach(() => { rmSync(BASE, { recursive: true, force: true }) })

test('M181-01 §3.1 行为（真注册面三态）：`exempt` 缺 `approvedBy` / 缺 `impact` ⇒ 拒绝且零写盘；两键齐 ⇒ 落盘', async () => {
  const store = new SdoStore(join(BASE, 'proj', '.sdo'))
  const base = { action: 'profile', packages: '["tdd"]', derivedFrom: '["scale=normal"]' }
  // ① 缺 approvedBy ⇒ 拒
  const noApprover = await call('sdo_plan', { ...base, exempt: JSON.stringify([{ task: 'TASK-001', check: 'tdd-mutation-missing', why: '文档卡', impact: '放弃变异证据' }]) })
  assert.match(noApprover, /缺\*\*批准人\*\*/u, `缺批准人要拒并点名（可读文案，不印内部码）：${noApprover.slice(0, 300)}`)
  assert.equal(readConstructionProfile(store).profile, undefined, '被拒时零写盘（profile 不存在）')
  // ② 缺 impact ⇒ 拒
  const noImpact = await call('sdo_plan', { ...base, exempt: JSON.stringify([{ task: 'TASK-001', check: 'tdd-mutation-missing', why: '文档卡', approvedBy: '用户' }]) })
  assert.match(noImpact, /缺\*\*影响面\*\*/u, `缺影响面要拒并点名：${noImpact.slice(0, 300)}`)
  assert.equal(readConstructionProfile(store).profile, undefined, '被拒时零写盘')
  // ②b 非字符串（把 `impact` 照抄成数组形态）⇒ 同样按"没写"拒绝（可读，不崩栈）
  const badType = await call('sdo_plan', { ...base, exempt: JSON.stringify([{ task: 'TASK-001', check: 'tdd-mutation-missing', why: '文档卡', approvedBy: '用户', impact: ['x'] }]) })
  assert.match(badType, /缺\*\*影响面\*\*/u, `非字符串要按"没写"拒绝：${badType.slice(0, 300)}`)
  assert.equal(readConstructionProfile(store).profile, undefined, '被拒时零写盘')
  // ③ 两键齐 ⇒ 落盘
  const ok = await call('sdo_plan', { ...base, exempt: JSON.stringify([{ task: 'TASK-001', check: 'tdd-mutation-missing', why: '文档卡', approvedBy: '用户', impact: '放弃变异证据' }]) })
  assert.match(ok, /已决定实现阶段方法包/u, `两键齐必须落盘：${ok.slice(0, 300)}`)
  const written = readConstructionProfile(store).profile
  assert.equal(written?.exempt?.length, 1, '落盘后应有 1 条豁免')
  assert.equal(written?.exempt?.[0]?.approvedBy, '用户', '批准人必须落盘')
  assert.equal(written?.exempt?.[0]?.impact, '放弃变异证据', '影响面必须落盘')
})

test('M181-02 §3.1 结构：出厂描述与"写侧强制"同口径（不许再写"映射成空串"那套）', () => {
  const plan = createOfficeTools({} as never).find((item) => item.name === 'sdo_plan') as unknown as { parameters: { properties: Record<string, { description?: string }> } }
  const description = String(plan.parameters.properties['exempt']?.description ?? '')
  assert.match(description, /must carry both/u, `描述必须写"两键都是必须"：${description.slice(0, 200)}`)
  assert.match(description, /rejected/u, '描述必须写"会被拒绝"')
  assert.match(description, /nothing is written/u, '描述必须写"零写盘"')
  assert.equal(description.includes('mapped through'), false, '不许再写"只是映射"（那是上一批改反的那句）')
  assert.equal(description.includes('the **required** fields of every entry are `task` / `check` / `why`'), false, '不许再把必填说成只有三键')
  assert.match(description, /tolerantly/u, '宽容只属于**读端**（旧条目），描述要说清')
  assert.match(description, /\*\*read\*\*|read/u, '描述要点名"读端"')
})

test('M181-03 §3.2 行为：`steps` 真数组 / JSON 文本 / 都不给 三态（真注册工具）', async () => {
  const store = new SdoStore(join(BASE, 'proj', '.sdo'))
  // ① 真数组（宿主 schema 面必须收 —— 修前 `invalid arguments: "steps" must be a string`）
  const viaArray = await call('sdo_test', { action: 'plan', title: 'A', kind: 'unit', steps: ['先登录', '再下单'], expected: 'x' })
  assert.match(viaArray, /TC-001/u, `真数组必须建案成功：${viaArray.slice(0, 300)}`)
  // ② JSON 文本（既有 149 条 TC 的写法，不许坏）
  const viaText = await call('sdo_test', { action: 'plan', title: 'B', kind: 'unit', steps: '["先登录", "再下单"]', expected: 'x' })
  assert.match(viaText, /TC-002/u, `文本形态必须照旧可用：${viaText.slice(0, 300)}`)
  // ③ 都不给 ⇒ 空步骤（不是崩、也不是塞 undefined）
  const none = await call('sdo_test', { action: 'plan', title: 'C', kind: 'unit', expected: 'x' })
  assert.match(none, /TC-003/u, `不给步骤也要能建案：${none.slice(0, 300)}`)
  const first = store.readYaml<{ testCase: { steps: string[] } }>('tests', 'TC-001.yml')?.testCase
  const second = store.readYaml<{ testCase: { steps: string[] } }>('tests', 'TC-002.yml')?.testCase
  const third = store.readYaml<{ testCase: { steps: string[] } }>('tests', 'TC-003.yml')?.testCase
  assert.deepEqual(first?.steps, ['先登录', '再下单'], '真数组形态必须逐条落盘')
  assert.deepEqual(second?.steps, ['先登录', '再下单'], '文本形态必须逐条落盘（两形态等价）')
  assert.deepEqual(third?.steps, [], '不给 ⇒ 空数组')
  // 结构：消费面判据认得出 `steps` 是被当列表用的参数
  const test = createOfficeTools({} as never).find((item) => item.name === 'sdo_test') as unknown as { parameters: { properties: Record<string, unknown> } }
  assert.equal(listParamNames(test.parameters.properties).includes('steps'), true, '`steps` 必须进"声明即联合"的推导集合（消费面判据据此守）')
})
