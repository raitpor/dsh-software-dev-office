/**
 * **增量 153：落点必须落在写范围内（DEF-018，§3E 族 9，minor）**。
 *
 * 缺陷原文（三份 re-verify 的现盘读数）：`validatePlan` 的判据码全集里有写范围**相交**（并行卡之间）
 * 与写范围**非空**两条，却**没有一条**核"卡自己声明的落点与自己的写范围对不对得上"——原探针两张卡
 * （DoD 点名 `src/domain/records.ts` / `test/m94.test.ts` / `src/domain/gates.ts`，写范围分别是
 * `src/interface/` / `docs/`）⇒ 码集 `[]`，落地时才发现根本写不了那些文件。卡上也只有 `inputs`/`outputs`
 * （自由文本），**没有**落点类结构化字段。
 *
 * **先钉红**（修前 `lib/` 上跑，可复算）：上述两张卡 ⇒ `validatePlan` 码集 **`[]`**；
 * 判据码全集 = 9 条（无任何落点判据）。
 *
 * **修法（结构化声明 + 对账，不解析散文）**：卡上新增 `TaskCard.landing`（本卡声称要落地的路径），
 * 第 10 条判据 `landing-outside-scope` 逐条核对它是否落在自己的 `writeScopes` 内 ——
 * 路径代数走 `scopeOverlaps` **唯一出口**（ADR-009），在外者**逐条点名**；缺省不声明 = 不判（存量卡零噪声）；
 * 只在**未落地**卡上判（与 DEF-036/055 同口径）。
 * ⚠️ **本卡最容易被后人做坏的地方**（M153-03 专门钉住）：判据只核**卡自己声明的**两样东西，
 * **绝不解析 DoD 散文**里的路径 —— 那会让判据绑死在某种写法上（语言无关是长期约束）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
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

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m153/', import.meta.url))
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

function card(writeScopes: string[], landing?: string[], dod: string[] = ['d']): string {
  return createTask(store, journal, {
    title: '夹具卡',
    goal: 'g',
    dod,
    role: 'developer',
    size: 'small',
    writeScopes,
    ...(landing === undefined ? {} : { landing }),
  } as never).id
}

const issues = (id: string): { code: string; detail: string }[] =>
  office.planIssues(call).filter((issue) => issue.taskId === id).map((issue) => ({ code: issue.code, detail: issue.detail }))

beforeEach(async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'src', 'a'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M153 落点判据', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['落点与写范围对账'],
    scopeOut: ['解析 DoD 散文里的路径'],
    metricsSuccess: ['落点写在范围外时拆卡期就判红'],
    glossary: { 落点: '本卡声称要落地的路径' },
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
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M153-01 两态：落点在写范围内 ⇒ 绿；在外 ⇒ 判红并只点名**那一条**（修前一律绿）', () => {
  // 两张卡的写范围必须**互斥** —— 否则会先撞上另一条判据 `write-scope-disjoint`（并行卡写范围重叠）
  const inside = card(['src/a/'], ['src/a/impl.ts'])
  const outside = card(['src/b/'], ['src/domain/records.ts'])
  assert.deepEqual(issues(inside), [], '落点在写范围内 ⇒ 必须绿')
  const found = issues(outside)
  assert.equal(found.length, 1, `落点在写范围外 ⇒ 必须判红：${JSON.stringify(office.planIssues(call))}`)
  assert.equal(found[0]?.code, 'landing-outside-scope')
  assert.match(found[0]?.detail ?? '', /src\/domain\/records\.ts/u, '要点名那条落点（可核对）')
  assert.match(found[0]?.detail ?? '', /src\/b/u, '并把本卡写范围一并印出来（对比着看）')
  // 反例：补对之后转绿（把落点并进写范围）
  store.writeYaml(['tasks', `${outside}.yml`], { task: { ...readTask(store, outside), writeScopes: ['src/b/', 'src/domain/'] } })
  assert.deepEqual(issues(outside), [], '写范围补上落点后必须转绿')
})

test('M153-02 多落点：只要有一条在外就红，且只点名在外的那条', () => {
  const id = card(['src/a/'], ['src/a/one.ts', 'src/b/two.ts', 'src/a/three.ts'])
  const found = issues(id)
  assert.equal(found.length, 1, '有落点在外就要判红')
  assert.match(found[0]?.detail ?? '', /src\/b\/two\.ts/u, '在外的那条必须点名')
  assert.doesNotMatch(found[0]?.detail ?? '', /one\.ts|three\.ts/u, '在内的那些不该被拉进判词（点名要精确）')
})

test('M153-03 ⚠️ 不解析 DoD 散文：DoD 里写了路径但卡上没声明 landing ⇒ **不判**（语言无关的底线）', () => {
  const id = card(['src/a/'], undefined, ['改 src/domain/records.ts 里的 recordTestResult', '补 test/m94.test.ts 断言'])
  assert.deepEqual(issues(id), [], '判据只核卡自己声明的落点 —— 从散文里认路径会把判据绑死在某种写法上')
})

test('M153-04 时机：已落地（done/verified）的卡不追溯', () => {
  const id = card(['src/a/'], ['src/domain/gates.ts'])
  assert.equal(issues(id).length, 1, '夹具前提：未落地时会判红')
  store.writeYaml(['tasks', `${id}.yml`], { task: { ...readTask(store, id), status: 'done' } })
  assert.deepEqual(issues(id), [], 'done 卡不追溯（落地后是历史，不重写历史）')
})

test('M153-05 工具面（真实注册的工具）：landing 写得进读得回、判据随动；schema 收两种形状', async () => {
  const id = card(['src/a/'])
  assert.deepEqual(issues(id), [], '夹具前提：未声明时绿')
  const receipt = await callTool('sdo_task', { action: 'update', id, landing: '["src/domain/plan.ts"]' })
  assert.deepEqual(readTask(store, id)?.landing, ['src/domain/plan.ts'], `工具面写的落点必须真的落盘：${receipt.slice(0, 220)}`)
  assert.equal(issues(id).length, 1, '声明之后判据立刻开口（工具面 → 落盘 → 判据 一条链）')
  await callTool('sdo_task', { action: 'update', id, landing: '[]' })
  assert.deepEqual(readTask(store, id)?.landing, [], '空数组 = 撤回声明（整份替换）')
  assert.deepEqual(issues(id), [], '撤回后回到绿')
  const tool = tools.find((item) => item.name === 'sdo_task')
  const properties = (tool?.parameters as { properties?: Record<string, Record<string, unknown>> } | undefined)?.properties ?? {}
  assert.ok(Array.isArray((properties['landing'] as { oneOf?: unknown }).oneOf), 'schema 必须接受 JSON 文本或真数组两种形状')
})

test('M153-06 TC-101：`landing` 形状不合法 ⇒ 可读拒绝 + **零写盘**（原先全仓没有这条）', async () => {
  const id = card(['src/a/'], ['src/a/impl.ts'])
  const path = ['tasks', `${id}.yml`]
  const before = store.readText(...path)
  assert.equal(typeof before, 'string', '夹具前提：卡文件在盘上')

  // 形状坏（不是合法 JSON）⇒ 由 `jsonOr` 可读报，且**在写盘之前**就返回
  const receipt = await callTool('sdo_task', { action: 'update', id, landing: 'src/domain/plan.ts' })
  assert.match(receipt, /landing/u, `回执要点名是哪个参数：${receipt.slice(0, 240)}`)
  assert.match(receipt, /形状不对/u, '要说清是**形状**问题（不是"值不合法"）')
  assert.match(receipt, /没有写入任何东西/u, '要如实声明本次没有写入')
  assert.equal(store.readText(...path), before, '形状不合法时卡文件必须逐字节不变（零写盘）')
  assert.deepEqual(issues(id), [], '被拒的写入不许留下半条判据读数')
})

test('M153-07 TC-101：判据块内无正则/字符串解析（不靠"从散文里认路径"）', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const source = readFileSync(join(root, 'src', 'domain', 'plan.ts'), 'utf8')
  const start = source.indexOf('const landings = (task.landing ?? [])')
  const end = source.indexOf("code: 'landing-outside-scope'")
  assert.equal(start > 0 && end > start, true, '夹具前提：判据块在 `src/domain/plan.ts` 里找得到')
  const block = source.slice(start, end)
  for (const forbidden of ['.match(', '.replace(', '.split(', '.search(', 'new RegExp', '.exec(']) {
    assert.equal(block.includes(forbidden), false, `判据块里不许出现 \`${forbidden}\`（那是"解析散文"的入口）`)
  }
  assert.match(block, /scopeOverlaps\(task\.writeScopes/u, '判据只能走写范围包含判定这台唯一出口（ADR-009）')
  // 反向对照：块里确实在做判定（不是把整段切空了才"无正则"）
  assert.match(block, /landings\.filter/u, '块里必须真的在逐条核落点（不是把整段切空才"无正则"）')
})
