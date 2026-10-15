/**
 * **增量 176：DEF-077（major，第四批 §3.2）—— `unfrozen` 只有文本形态可用；根因是"一处归一"被做成白名单**。
 *
 * 现象（复验 V6）：`sdo_task action=done` 的 `unfrozen` 参数**描述**写着 `JSON **text** (or a real array)`，
 * 但 schema 是 `type:'string'` ⇒ 传真数组时**宿主在 schema 阶段就拒**：
 * `invalid arguments: "unfrozen" must be a string`（插件 `execute` 从未被调用）。
 *
 * 根因：注册出口的"一处归一"是**白名单**（`LIST_PARAM_NAMES` + 注册前升级）——
 * 「名单内 + 纯 `string`」才升 `oneOf:[string,array]` ⇒ **每新增一个列表型参数，不加名单就静默退回纯 string**。
 * 同族的 `impact`/`landing` 因为手写联合而逃过名单（而且在名单**外**）；`defects`（第三批 `DEF-075` 新增）
 * 也正是这么漏的 —— 它的注释写着"数组 / JSON 文本二选一"，schema 却是 `type:'string'`。
 *
 * 为什么本批自己的守卫（`m174`）没抓住（`escaped=true`）：它只断言"参数在注册面"，且夹具直调 `tool.execute`、
 * **跳过宿主 schema 校验** ⇒ 走的是比真机**更宽**的路（`tq_ff348198`："参数在注册面 ≠ 真机可用"）。
 * 所以本用例**必须喂真形态给真注册的工具**，并用宿主的 `validateJsonSchemaValue` 复现那道门。
 *
 * 修法（第四批 §3.2 的 (b)：**按声明推导**，不是往名单里补一行）：列表形态在**参数声明处**由 `listDecl`
 * 声明，`listParamNames` 从已声明的 `properties` 反推调用面归一集合 ⇒ schema 面与调用面同源，没有第二份名单。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { apply } from '../src/index.js'
import { listParamNames } from '../src/interface/tools.js'
import { SoftwareDevOffice } from '../src/office.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = join(ROOT, 'node_modules', '.sdo-test', 'm176')
const WORKSPACE = join(BASE, 'proj')

/** 第三批 `DEF-073` 的名单（已删除）覆盖的名字：本批转换后**一个都不许掉**（反回归下界，不是实现）。 */
const LEGACY_LIST_NAMES = [
  'sourceRaw', 'dimensions', 'acceptance', 'packages', 'scope', 'derivedFrom', 'exempt', 'dod',
  'writeScopes', 'addWriteScopes', 'blockedBy', 'evidenceRequired', 'reportedFiles', 'requirements',
  'fixes', 'mitigates', 'mitigatesWaiver', 'runsRequired', 'artifacts', 'alternatives', 'links',
  'findings', 'suggestions',
]

interface ToolDefinition {
  name: string
  parameters: { properties?: Record<string, Record<string, unknown>> }
  execute: (args: Record<string, unknown>, exec: unknown) => unknown
}

let office: SoftwareDevOffice
let tools: ToolDefinition[]
const call = { sessionId: 's-dev-a', cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string, status: TaskCard['status']): void {
  const task: TaskCard = {
    id, title: id, goal: 'g', inputs: [], outputs: [], dod: ['d'], evidenceRequired: ['command'],
    owner: 'dev-a', blockedBy: [], writeScopes: ['src/a/'], role: 'developer', size: 'small', revision: 1,
    status, requirements: [], evidence: [], createdAt: '', updatedAt: '',
  }
  office.storeFor(WORKSPACE).writeYaml(['tasks', `${id}.yml`], { task })
}

/** 真装配：走 `apply()` 的 `tools.register` 面（真注册的工具定义），**不过滤**参数。 */
function toolHarness(): void {
  tools = []
  const services: Record<string, unknown> = {
    tools: { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } },
  }
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {}, on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => { if (names.every((name) => name in services)) cb(makeCtx()) },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  })
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
}

function registered(name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  return tool
}

/** **宿主那一跳**：注册面的 schema 校验（`unfrozen` 曾被拒的正是这处）。 */
function hostViolations(tool: ToolDefinition, args: Record<string, unknown>): string[] {
  return validateJsonSchemaValue(tool.parameters as never, args)
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const exec = { agent: { id: 's-dev-a', session: { header: { id: 's-dev-a', cwd: WORKSPACE, delegationDepth: 1, parentSession: 'cockpit' } } } }
  return String(await registered(name).execute(args, exec))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s-dev-a', WORKSPACE)
  office.init(call, { name: 'M176 列表参数声明', scale: 'normal', stakeholders: ['业务方'] })
  card('TASK-001', 'in-progress')
  toolHarness()
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M176-01 宿主 schema 面：真注册的工具里，每个列表参数的**真数组**都不被拒（含 `unfrozen`/`defects`）', () => {
  let derivedTotal = 0
  for (const tool of tools) {
    assertSupportedJsonSchema(tool.parameters)
    const properties = tool.parameters.properties ?? {}
    const derived = listParamNames(properties)
    derivedTotal += derived.length
    for (const name of derived) {
      const violations = hostViolations(tool, { [name]: ['x'] })
      const aboutThis = violations.filter((violation) => new RegExp(`"value\\.${name}(?![\\w])`, 'u').test(violation))
      assert.deepEqual(aboutThis, [], `真数组必须过宿主 schema 校验：${tool.name}.${name} ⇒ ${JSON.stringify(violations)}`)
    }
  }
  assert.ok(derivedTotal >= 24, `推导出的列表参数应覆盖旧名单（实际 ${derivedTotal}）`)
  // `unfrozen`（本条的现场）与 `defects`（第三批新增、同样漏在名单外）：三态都过宿主校验
  const task = registered('sdo_task')
  for (const [label, args] of [
    ['真数组', { action: 'done', id: 'TASK-001', unfrozen: ['TASK-002'] }],
    ['JSON 文本', { action: 'done', id: 'TASK-001', unfrozen: '["TASK-002"]' }],
    ['都不给', { action: 'done', id: 'TASK-001' }],
  ] as const) {
    assert.deepEqual(hostViolations(task, { ...args }), [], `unfrozen 的${label}形态不许被宿主拒`)
  }
  const testTool = registered('sdo_test')
  assert.deepEqual(hostViolations(testTool, { action: 'record', defects: ['DEF-001'] }), [], '`defects` 的真数组不许被宿主拒')
})

test('M176-02 行为（真数组 == JSON 文本）：`done` 的 `unfrozen` 两形态落进同一处，且真数组真的到达域层', async () => {
  card('TASK-002', 'in-progress')
  const viaArray = await callTool('sdo_task', {
    action: 'done', id: 'TASK-001', owner: 'dev-a',
    evidence: '[{"kind":"command","detail":"npm test","exitCode":0}]',
    unfrozen: ['TASK-002'],
  })
  assert.match(viaArray, /局部绿/u, `真数组必须到达域层（回执说"局部绿"）：${viaArray.slice(0, 300)}`)
  assert.match(viaArray, /TASK-002/u, '未冻结清单要出现在回执里')
  const stored = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-001.yml')?.task
  assert.deepEqual(stored?.unfrozen, ['TASK-002'], '真数组形态必须真的落进卡（不是被静默丢掉）')

  // 文本形态（后向兼容）：同一张卡、同一件事，读数必须一致
  card('TASK-003', 'in-progress')
  const viaText = await callTool('sdo_task', {
    action: 'done', id: 'TASK-003', owner: 'dev-a',
    evidence: '[{"kind":"command","detail":"npm test","exitCode":0}]',
    unfrozen: '["TASK-002"]',
  })
  assert.match(viaText, /局部绿/u, `文本形态照旧可用：${viaText.slice(0, 300)}`)
  const storedText = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-003.yml')?.task
  assert.deepEqual(storedText?.unfrozen, stored?.unfrozen, '两种形态的落盘读数必须等价')

  // 都不给 ⇒ 不写这个键（存量形状不变）。为了不受"有在飞兄弟卡"影响，先把前面的卡收口
  card('TASK-002', 'done')
  card('TASK-004', 'in-progress')
  const viaNone = await callTool('sdo_task', {
    action: 'done', id: 'TASK-004', owner: 'dev-a',
    evidence: '[{"kind":"command","detail":"npm test","exitCode":0}]',
  })
  assert.equal(/局部绿/u.test(viaNone), false, '没声明未冻结 ⇒ 不是局部绿')
  const storedNone = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-004.yml')?.task
  // **形状变化（第四批 §7.7 预告）**：卡一旦被回写，`unfrozen` 会以**空数组**落盘（读端白名单的缺省），
  // 这是**形状**变化、不是行为变化 —— 语义仍是"本次没有未冻结的卡"。
  assert.deepEqual(storedNone?.unfrozen ?? [], [], '不给 ⇒ 语义上是空清单（落盘可能是 [] 或缺键）')
})

test('M176-03 反例：真数组的**假声明**照样可读拒绝、零写盘（形态不改变判定）', async () => {
  card('TASK-002', 'in-progress')
  const bad = await callTool('sdo_task', {
    action: 'done', id: 'TASK-001', owner: 'dev-a',
    evidence: '[{"kind":"command","detail":"npm test","exitCode":0}]',
    unfrozen: ['TASK-999'],
  })
  assert.match(bad, /TASK-999/u, `拒因必须点名那条交代不清的 id：${bad.slice(0, 300)}`)
  assert.match(bad, /没有写入/u, '拒因必须说清零写盘')
  const stored = office.storeFor(WORKSPACE).readYaml<{ task: TaskCard }>('tasks', 'TASK-001.yml')?.task
  assert.equal(stored?.status, 'in-progress', '被拒时卡状态不许变')
  assert.equal(stored?.unfrozen, undefined, '被拒时不许落键')
})

test('M176-04 机械判据（DoD ④）：承诺数组就必须声明联合；声明了联合就必须进归一集合；名单不存在', () => {
  // ① **声明承诺数组却仍是纯 string ⇒ 判红**（这正是 `unfrozen`/`defects` 当初漏掉的形态）
  const promised: string[] = []
  const promise = /real array|两种形态都收|array of|as an array/iu
  for (const tool of tools) {
    for (const [name, param] of Object.entries(tool.parameters.properties ?? {})) {
      const description = typeof param['description'] === 'string' ? param['description'] : ''
      const oneOf = param['oneOf']
      const declaredUnion = Array.isArray(oneOf)
        && (oneOf as { type?: unknown }[]).some((branch) => branch?.type === 'array')
      if (promise.test(description)) {
        promised.push(`${tool.name}.${name}`)
        assert.equal(declaredUnion, true, `描述承诺了数组形态，声明就必须是联合（否则宿主在 schema 阶段拒签）：${tool.name}.${name}`)
      }
      if (declaredUnion) {
        assert.ok(listParamNames(tool.parameters.properties ?? {}).includes(name), `声明了联合却不在推导集合里（两处判据分叉）：${tool.name}.${name}`)
      }
    }
  }
  assert.ok(promised.length >= 5, `夹具前提：承诺数组的参数应有多处（实际 ${promised.length}）`)
  assert.ok(promised.includes('sdo_task.unfrozen'), '本条的现场必须在被守之列')

  // ② 反回归：旧名单覆盖的名字**一个都不许掉**（转换只许等价或更宽）
  const allNames = new Set<string>()
  for (const tool of tools) for (const name of listParamNames(tool.parameters.properties ?? {})) allNames.add(name)
  const missing = LEGACY_LIST_NAMES.filter((name) => !allNames.has(name))
  assert.deepEqual(missing, [], `旧名单覆盖的列表参数不得在推导中掉队：${missing.join(' ')}`)
  assert.ok(allNames.has('unfrozen') && allNames.has('defects'), '本条新增覆盖的两个参数必须在推导集合里')

  // ③ 人工名单必须删除（只在**代码行**上扫：注释里会引用这个名字讲历史）
  const text = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  const code = text.split('\n').filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line)).join('\n')
  assert.equal(/LIST_PARAM_NAMES/u.test(code), false, '人工名单是"会漏"的那一层，必须删除')

  // ④ `defects` 的**注释与 schema 一致**（`src/index.ts` 写着"数组 / JSON 文本二选一"）
  const index = readFileSync(join(ROOT, 'src', 'index.ts'), 'utf8')
  assert.match(index, /数组 \/ JSON 文本二选一/u, '夹具前提：`defects` 的注释确实承诺两形态（第四批 §3.2 点名的就是这处）')
  const testTool = registered('sdo_test')
  const defectsDecl = (testTool.parameters.properties ?? {})['defects'] as Record<string, unknown>
  assert.ok(Array.isArray(defectsDecl['oneOf']), '注释承诺两形态 ⇒ schema 必须是联合（否则注释是假陈述）')
})
