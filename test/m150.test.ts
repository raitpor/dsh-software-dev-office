/**
 * **增量 150：默认写范围模板不含文案面 ⇒ 卡被诱向硬编码（DEF-055，§3E 族 4）**。
 *
 * 缺陷原文（三份 re-verify 的现盘读数）：`plan.ts` 的默认模板逐字 `[src/<slug>/, test/<slug>/]`
 * （项目未声明 `scopeTemplate` 时），**不含任何文案面**；`.sdo/config.yml` 无 `scopeTemplate`；
 * 真台账 **127 卡 / 119 有 writeScopes / 仅 29 含 `data/lang`**；而"被诱向硬编码"有**现盘物证**：
 * `testingStore.ts` 的 `TESTING_ZH`/`TESTING_EN` 两张内联表，以及 `gates.ts` / `index.ts` 里
 * 逐字写着「本卡写范围不含 `src/data/lang/`」的注释。
 *
 * **先钉红**（修前 `lib/` 产物上跑，可复算）：
 *   ```
 *   lib/src/domain/plan.js 里 'ui-text-scope' 命中 = 0
 *   lib/src/domain/plan.js 里 'textPaths'     命中 = 0
 *   lib/src/types.js       里 'uiText'        命中 = 0
 *   行为：validatePlan([卡(uiText:true, writeScopes:['src/a/'])]) ⇒ 码集 []（没有任何拦阻）
 *   ```
 *
 * **修法（声明式，且**不内置任何具体路径** —— §4 红线 4）**：
 *   · 卡上结构化布尔 `uiText`（语言无关：不读"职责散文里的文案字样"）；
 *   · **项目**在 `.sdo/config.yml` 的 `plan.textPaths` 里声明"用户可见文案所在的目录"；
 *   · `validatePlan` 第 9 条判据 `ui-text-scope` **对账**：声明了 `uiText` 的卡，写范围必须含
 *     项目声明的文案面；项目**还没声明**时也判红并点名"该写哪一行配置"，remedy 给出两条出路。
 * 为什么插件**不内置** `src/data/lang/`：那等于把某个项目的目录结构写进通用判据。本用例 M150-06 用
 * **另一个项目的目录名**（`messages/`）证明这条判据完全由项目声明驱动。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { createTask, readTask } from '../src/domain/plan.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { SdoStore } from '../src/infra/store.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m150/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}

let office: SoftwareDevOffice
let tools: ToolDefinition[]
let services: Record<string, unknown>
let store: SdoStore
let journal: Journal
const call = { sessionId: 's1', cwd: WORKSPACE } as unknown as OfficeCall

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool !== undefined, `工具面缺少 ${name}`)
  const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) if (key in properties) filtered[key] = value
  const agentStub = { id: 's1', session: { header: { id: 's1', cwd: WORKSPACE, delegationDepth: 0 } } }
  return String(await tool.execute(filtered, { agent: agentStub }))
}

/** 项目声明文案面（读-改-写：不碰 init 写下的其它 config 段） */
function declareTextPaths(...paths: string[]): void {
  const existing = store.readYaml<Record<string, unknown>>('config.yml') ?? {}
  const plan = (existing['plan'] as Record<string, unknown> | undefined) ?? {}
  store.writeYaml(['config.yml'], { ...existing, plan: { ...plan, textPaths: paths } })
}

function card(writeScopes: string[], uiText?: boolean): string {
  return createTask(store, journal, {
    title: '夹具卡',
    goal: 'g',
    dod: ['d'],
    role: 'developer',
    size: 'small',
    writeScopes,
    ...(uiText === undefined ? {} : { uiText }),
  } as never).id
}

const codes = (id: string): string[] =>
  office.planIssues(call).filter((issue) => issue.taskId === id).map((issue) => issue.code)

const detailOf = (id: string): string => office.planIssues(call).find((issue) => issue.taskId === id)?.detail ?? ''

beforeEach(async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'src', 'a'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M150 文案面', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['文案面声明'],
    scopeOut: ['把某个项目的目录结构写进插件默认值'],
    metricsSuccess: ['声明产出文案的卡不再被诱向硬编码'],
    glossary: { 文案面: '用户可见文案所在的目录（由项目声明）' },
  })
  store = office.storeFor(WORKSPACE)
  journal = new Journal(store)
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
  await callTool('sdo_design', { action: 'review', approvedBy: '业务方' })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M150-01 两态：项目已声明文案面 ⇒ 写范围含它则绿、不含则红并点名（修前一律绿）', () => {
  declareTextPaths('src/data/lang/')
  const inside = card(['src/data/lang/'], true)
  const outside = card(['src/a/'], true)
  assert.deepEqual(codes(inside), [], '写范围含项目声明的文案面 ⇒ 必须绿')
  assert.deepEqual(codes(outside), ['ui-text-scope'], `写范围不含文案面 ⇒ 必须判红：${JSON.stringify(office.planIssues(call))}`)
  assert.match(detailOf(outside), /src\/data\/lang/u, '要点名项目声明的那条路径（可核对）')
})

test('M150-02 反例：项目**没**声明文案面时判红并点名那行配置；且**不内置**任何路径', () => {
  // 关键反例：即使卡的写范围里"恰好"含 `src/data/lang/`，项目没声明 ⇒ 判据**不认**
  // （这才是"插件没有内置某个项目的目录结构"的机械证据 —— 否则这里会变绿）
  const looksRight = card(['src/data/lang/'], true)
  assert.deepEqual(codes(looksRight), ['ui-text-scope'], '项目未声明 ⇒ 即使路径看着对也不许放行（fail-closed）')
  const detail = detailOf(looksRight)
  // ⚠️ 断言必须**分辨两个分支**（这是 MUT-19 存活教的一课）：`kUiTextScope` 与 `kUiTextScopeNoPaths`
  // 都含 `plan.textPaths`（remedy 也含），所以只断言"提到了配置键"抓不住"项目未声明"走错分支 ——
  // 那个分支会把路径列表印成空的 `（plan.textPaths：）`。这里只认 NoPaths 那句特有的措辞。
  assert.match(detail, /还没有声明/u, `"项目未声明"必须走它自己的分支（否则回执会印出空的路径列表）：${detail}`)
  const remedy = office.planIssues(call).find((issue) => issue.taskId === looksRight)?.remedy ?? ''
  assert.match(remedy, /plan\.textPaths/u, 'remedy 必须给出那一行配置')
  assert.match(remedy, /addWriteScopes|uiText=false/u, 'remedy 还要给出另两条出路（并入范围 / 撤回声明）')
})

test('M150-03 存量不追溯：没声明 `uiText` 的卡，项目声明与否都零噪声（真台账 127 卡的现状）', () => {
  const plain = card(['src/a/'])
  assert.deepEqual(codes(plain), [], '未声明的卡不受影响')
  declareTextPaths('src/data/lang/')
  assert.deepEqual(codes(plain), [], '项目声明了文案面之后，未声明的卡仍不受影响')
})

test('M150-04 工具面写侧（真实注册的工具）：`uiText=true` 落盘读回、`false` 撤回、schema 为 boolean', async () => {
  declareTextPaths('src/data/lang/')
  const id = card(['src/a/'])
  assert.deepEqual(codes(id), [], '夹具前提：未声明时是绿的')
  const receipt = await callTool('sdo_task', { action: 'update', id, uiText: true })
  assert.equal(readTask(store, id)?.uiText, true, `工具面写的声明必须真的落盘（静默丢弃会让判据永远看不见）：${receipt.slice(0, 200)}`)
  assert.deepEqual(codes(id), ['ui-text-scope'], '声明之后、写范围不含文案面 ⇒ 判据立刻开口')
  await callTool('sdo_task', { action: 'update', id, uiText: false })
  assert.equal(readTask(store, id)?.uiText, undefined, 'false = 撤回声明（键从卡面消失，不留"写着但为假"的形态）')
  assert.deepEqual(codes(id), [], '撤回后回到绿')
  const tool = tools.find((item) => item.name === 'sdo_task')
  const properties = (tool?.parameters as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {}
  assert.equal(properties['uiText']?.type, 'boolean', 'schema 必须声明 boolean（否则 DSH 侧先把它丢掉）')
})

test('M150-05 时机：已落地（done/verified）的卡不追溯', () => {
  declareTextPaths('src/data/lang/')
  const id = card(['src/a/'], true)
  store.writeYaml(['tasks', `${id}.yml`], { task: { ...readTask(store, id), status: 'done' } })
  assert.deepEqual(codes(id), [], 'done 卡不追溯（落地后是历史，不重写历史）')
})

test('M150-06 项目驱动、不针对本仓：换成别的项目目录名（`messages/`）照样判（语言/项目无关）', () => {
  declareTextPaths('messages/')
  const inside = card(['messages/'], true)
  const watcher = card(['src/a/'], true)
  assert.deepEqual(codes(inside), [], '项目声明 `messages/` ⇒ 写范围含它就绿（判据不认识 data/lang 这个特例）')
  assert.deepEqual(codes(watcher), ['ui-text-scope'], '不含它则红')
  assert.match(detailOf(watcher), /messages\//u, '点名的是**项目声明的**那条路径')
})
