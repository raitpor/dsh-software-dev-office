/**
 * **增量 131：列表型参数的联合形态（DEF-073，2026-10-14 机制缺陷批 §3C）**。
 *
 * 缺陷现场：工具面仍有大量**列表型参数**被声明成纯 `string`（交接文档统计 24 处；只有
 * `findings`/`suggestions` 改过联合类型）⇒ 模型按自然形态传**数组**时，**宿主在 schema 校验阶段
 * 就拒签**、插件根本收不到调用；而描述里那句「Do NOT pass an array」是**规避**不是修复。
 * 这是本项目**复发次数最高**的一类故障（`tq_ff348198` 就是它的教训卡）。
 *
 * **先钉红**：修前 `sdo_task` 的 `dod`/`writeScopes`/`blockedBy`/`evidenceRequired` 等声明为
 * `{ type: 'string' }` 且描述带「Do NOT pass an array」⇒ 传数组时 `oneOf` 不存在（宿主层拒签）。
 *
 * **修法（DEF-073 原样）**：**一处归一**（不逐个手改 24 处声明 —— 历史证明那样必然分叉）：
 *   · schema 面：注册出口把列表型参数的 `{type:'string'}` 升成 `oneOf:[string,array]`，并**删掉**反模式文案；
 *   · 调用面：把真数组转成 JSON 文本再交给既有解析器（字符串原样透传 ⇒ 对既有行为零影响）。
 *
 * **修法（DEF-077，第四批 §3.2：把"一处归一"从名单改成按声明推导）**：原实现是**名单**
 * （`LIST_PARAM_NAMES` + 注册前升级）—— 「名单内 + 纯 `string`」才升联合 ⇒ 新参数不加名单就**静默**
 * 退回纯 string（`unfrozen` 正是这么漏的）。现在**声明即承诺**：列表形态在参数声明处由 `listDecl`
 * 声明，`listParamNames` 从**已声明的 `properties`** 反推调用面归一集合 ⇒ 两处判据同源、没有第二份名单。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { listDecl, listParamNames, withListArgs } from '../src/interface/tools.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { TaskCard } from '../src/types.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m131/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition {
  name: string
  parameters: { properties?: Record<string, Record<string, unknown>> }
  execute: (args: Record<string, unknown>, ctx: { agent?: unknown }) => unknown
}

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

function card(id: string, writeScopes: string[]): TaskCard {
  return {
    id,
    title: id,
    goal: 'g',
    inputs: [],
    outputs: [],
    dod: ['d'],
    evidenceRequired: ['command'],
    blockedBy: [],
    writeScopes,
    role: 'developer',
    size: 'small',
    revision: 1,
    status: 'ready',
    requirements: [],
    evidence: [],
    createdAt: '',
    updatedAt: '',
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(args, { agent: agentStub }))
}

beforeEach(() => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(WORKSPACE, { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M131 参数联合形态', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['列表参数两形态等价'],
    scopeOut: ['Do NOT pass an array 这类规避'],
    metricsSuccess: ['传数组不被宿主拒签'],
    glossary: { 两形态: 'JSON 文本与真数组' },
  })
  tools = []
  services = {}
  const makeCtx = (): Record<string, unknown> => ({
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
    plugin: () => {},
    on: () => () => {},
    get: (name: string) => services[name],
    inject: (names: string[], cb: (sub: unknown) => void) => {
      if (names.every((name) => name in services)) cb(makeCtx())
    },
    effect: (fn: () => unknown) => {
      fn()
      return () => {}
    },
  })
  services['tools'] = { register: (tool: ToolDefinition) => { tools.push(tool); return () => {} } }
  apply(makeCtx() as unknown as Context, Config({} as unknown as SdoConfig))
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M131-01 列表型参数**全部**由声明给出联合形态，且反模式文案已消失（名单已删除）', () => {
  const legacyText: string[] = []
  let seen = 0
  for (const tool of tools) {
    const properties = tool.parameters.properties ?? {}
    // **DEF-077**：列表参数名由**声明**推导（`listParamNames`），不再有人工名单可比对 ——
    // 这里反过来核：凡是声明了 `oneOf` 的名字，必须被推导函数认出来（两处判据同源）。
    const derived = listParamNames(properties)
    for (const name of derived) {
      seen += 1
      const param = properties[name] ?? {}
      assert.ok(Array.isArray(param['oneOf']), `推导出来的列表参数必须有联合声明：${tool.name}.${name}`)
    }
    for (const [name, param] of Object.entries(properties)) {
      const oneOf = (param as { oneOf?: unknown }).oneOf
      if (Array.isArray(oneOf) && (oneOf as { type?: unknown }[]).some((branch) => branch?.type === 'array')) {
        assert.ok(derived.includes(name), `声明了联合却没进归一集合（两处判据分叉）：${tool.name}.${name}`)
      }
      const description = typeof param['description'] === 'string' ? param['description'] : ''
      if (description.includes('Do NOT pass an array') || description.includes('not an array')) {
        legacyText.push(`${tool.name}.${name}`)
      }
    }
  }
  assert.ok(seen >= 20, `夹具前提：推导出的列表型参数应出现多次（实际 ${seen}）`)
  assert.deepEqual(legacyText, [], '不得再用「Do NOT pass an array」这类规避文案')
})

test('M131-02 两形态**端到端等价**：数组与 JSON 文本到达域层后完全一致', async () => {
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-901.yml'], { task: card('TASK-901', ['src/a.ts']) })
  office.storeFor(WORKSPACE).writeYaml(['tasks', 'TASK-902.yml'], { task: card('TASK-902', ['src/b.ts']) })

  await callTool('sdo_task', { action: 'update', id: 'TASK-901', dod: ['甲', '乙'], writeScopes: ['src/one/'] })
  await callTool('sdo_task', {
    action: 'update',
    id: 'TASK-902',
    dod: '["甲","乙"]',
    writeScopes: '["src/one/"]',
  })
  const first = office.tasks(call).find((task) => task.id === 'TASK-901')
  const second = office.tasks(call).find((task) => task.id === 'TASK-902')
  assert.deepEqual(first?.dod, ['甲', '乙'], '数组形态必须真的落到卡上')
  assert.deepEqual(second?.dod, ['甲', '乙'], '文本形态照旧')
  assert.deepEqual(first?.writeScopes, second?.writeScopes, '两种形态的写范围必须等价')
})

test('M131-03 声明助手与归一：联合来自声明，非列表参数一字不改', () => {
  const properties: Record<string, unknown> = {
    dod: listDecl('JSON text. Do NOT pass an array.'),
    title: { type: 'string', description: 'plain title' },
    count: { type: 'number', description: 'n' },
  }
  const dod = properties['dod'] as Record<string, unknown>
  assert.ok(dod['oneOf'] !== undefined, '`listDecl` 必须给出联合形态')
  assert.equal(String(dod['description']).includes('Do NOT pass an array'), false, '反模式文案必须删掉')
  assert.deepEqual(properties['title'], { type: 'string', description: 'plain title' }, '非列表参数不得被改')
  assert.deepEqual(listParamNames(properties), ['dod'], '列表集合由声明推导')

  const names = listParamNames(properties)
  const args = withListArgs({ dod: ['a', 'b'], title: 'x', other: 3 }, names)
  assert.equal(args['dod'], '["a","b"]', '数组转 JSON 文本')
  assert.equal(args['title'], 'x', '字符串原样透传')
  assert.equal(args['other'], 3)
  assert.equal(withListArgs({ dod: '["a"]' }, names)['dod'], '["a"]', '已是文本就不要再包一层')
  // **边界（修前靠名单时的行为）**：没声明联合的参数**不**被归一 —— 判决跟着声明走
  assert.deepEqual(withListArgs({ title: ['x'] }, names)['title'], ['x'], '非列表参数的数组原样留着（由宿主 schema 拒）')
})

test('M131-04 防回退：注册出口从声明推导（名单必须不存在）', () => {
  const text = readFileSync(join(ROOT, 'src', 'interface', 'tools.ts'), 'utf8')
  assert.match(text, /withListParamTools/u, '注册出口必须做归一')
  assert.match(text, /return withListParamTools\(tools\)/u, '归一必须真的接在返回上')
  assert.match(text, /export function listParamNames/u, '列表集合必须由声明推导')
  assert.match(text, /export function listDecl/u, '列表形态必须在声明处表达')
  assert.match(text, /export function withListArgs/u)
  // **DEF-077 的根因**：人工名单是"会漏"的那一层；回来一次就再漏一次。
  // 只在**代码行**上扫（注释里会引用这个名字讲历史，不算实现）。
  const code = text.split('\n').filter((line) => !/^\s*(\*|\/\*|\/\/)/u.test(line)).join('\n')
  assert.equal(/LIST_PARAM_NAMES/u.test(code), false, '人工名单必须删除（漏点就出在它身上）')
})
