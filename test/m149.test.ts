/**
 * **增量 149：契约 `requires` 的写侧通路（DEF-056，§3E 族 4「契约与语言包声明面」）**。
 *
 * 缺陷原文（三份 re-verify 的现盘读数）：31 份契约 **requires 非空 = 0**（8 个 `[]`、23 无键）；
 * `RecordContractInput`、`recordContract`、`sdo_design action=contract` 的 schema **三处都没有 `requires`**
 * ⇒ **写侧三道全缺**，而 `requires` 恰恰是判据的**输入面**。
 *
 * **病根在判据那一侧**：`construction.ts` 的 `cardHasNoContractObject()` 两条：
 *   ① 写范围不含契约面路径（`src/interface/**` / `.sdo/contracts/**`），**且**
 *   ② `contractsOfCard()` 为空（**没有契约声明 `requires` 命中本卡需求**）。
 * 两条都成立才 N/A。而 ② 的输入面写不进来 ⇒ ② **恒真** ⇒
 * 「没有对象就 N/A」成了**不可反驳的合法逃逸**（判据 `contract-test-missing` 对绝大多数卡永久静默）。
 *
 * **先钉红**（修前 `lib/` 产物上跑，可复算）：
 *   ```
 *   lib/src/domain/contracts.js 里 'requires: input.requires' 命中 = 0
 *   lib/src/interface/tools.js  里 'contractRequires'          命中 = 0
 *   行为：recordContract({…, requires:['REQ-001']}) ⇒ 返回值 requires = undefined
 *        落盘后列表里读回   requires = []           ← 静默丢弃（本批要消灭的形态）
 *   ```
 *
 * **修法（写侧四处一起，缺一处就静默丢弃 —— 知识库 tq_ff348198）**：
 *   ① `RecordContractInput.requires`（类型面）② `recordContract` 落盘映射 ③ `tools.ts` 的 schema
 *   ④ `execute` 映射 + ⑤ `index.ts` 的透传与**语义校验**（未知需求 id / 重复 ⇒ **可读拒绝、零写盘**）。
 * 为什么"未知 id"必须拒：写错一个号 = 这张契约对任何卡都不算「契约对象」⇒ 那些卡的判据**永久 N/A**，
 * 正是本批反复要消灭的"静默漏过"（处置口径与 `fixes` 的"不许落空"同款）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveSettings } from '../src/config.js'
import { Journal } from '../src/infra/journal.js'
import { SoftwareDevOffice } from '../src/office.js'
import { apply } from '../src/index.js'
import { doneGaps } from '../src/domain/construction.js'
import { createTask, readTask } from '../src/domain/plan.js'
import { listContracts } from '../src/domain/contracts.js'
import type { ConstructionProfile } from '../src/domain/construction.js'
import type { SdoConfig } from '../src/config.js'
import type { OfficeCall } from '../src/office.js'
import type { SdoStore } from '../src/infra/store.js'

const BASE = fileURLToPath(new URL('../../node_modules/.sdo-test/m149/', import.meta.url))
const WORKSPACE = join(BASE, 'proj')

interface ToolDefinition {
  name: string
  parameters: unknown
  execute: (args: unknown, ctx: { agent?: unknown }) => unknown
}

const profile: ConstructionProfile = {
  version: 1,
  decidedAt: '2026-10-14T00:00:00.000Z',
  decidedBy: 'office',
  packages: ['contract-first'],
  scope: 'all',
  derivedFrom: ['scale=critical'],
  reason: 'm149',
  exempt: [],
  history: [],
} as unknown as ConstructionProfile

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

/** 直接写需求真源（`listRequirementIds` 按文件名列举；内容与判据无关） */
function requirement(id: string): void {
  store.writeYaml(['requirements', `${id}.yml`], { requirement: { id, title: id, statement: 's', status: 'baselined' } })
}

function card(requirements: string[], writeScopes = ['src/x/']): string {
  return createTask(store, journal, {
    title: '夹具卡',
    goal: 'g',
    dod: ['d'],
    role: 'developer',
    size: 'small',
    writeScopes,
    requirements,
  } as never).id
}

const gapCodes = (id: string): string[] =>
  doneGaps(store, journal, readTask(store, id) as never, profile, { scale: 'critical' }).map((gap) => gap.check)

const recordContract = (requires?: string): Promise<string> =>
  callTool('sdo_design', {
    action: 'contract',
    producer: '接口面',
    consumer: '工具调用与回执截断',
    schema: '请求/响应结构（夹具）',
    ...(requires === undefined ? {} : { requires }),
  })

beforeEach(async () => {
  rmSync(BASE, { recursive: true, force: true })
  mkdirSync(join(WORKSPACE, 'src', 'x'), { recursive: true })
  office = new SoftwareDevOffice(resolveSettings(Config({} as unknown as SdoConfig)))
  office.noteSession('s1', WORKSPACE)
  office.init(call, { name: 'M149 契约 requires', scale: 'normal', stakeholders: ['业务方'] })
  office.updateProject(call, {
    scopeIn: ['契约的 requires 写侧'],
    scopeOut: ['放宽「没有对象就 N/A」'],
    metricsSuccess: ['契约能声明它挂在哪条需求上'],
    glossary: { requires: '契约挂在哪些需求上' },
  })
  store = office.storeFor(WORKSPACE)
  journal = new Journal(store)
  // 设计阶段的**第二道**入口门：`sdo_design` 要求"至少已经收集到需求"，否则设计不可进
  // （与 m15/m17 同款夹具）。这里先落一条需求真源，让门开着；用例自己再按需加。
  requirement('REQ-001')
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
  // 设计阶段的入口门：本宿主没有交互式计划评审通道（plan mode 不可用）⇒ 走它给的正规出口
  // 「本会话内评审计划」（与 m15/m17/m19 同款夹具；不提供"跳过"开关，所以这里必须真的评审一次）。
  await callTool('sdo_design', { action: 'review', approvedBy: '业务方' })
})

afterEach(() => {
  rmSync(BASE, { recursive: true, force: true })
})

test('M149-01 写侧通路（真实注册的工具）：`requires` 写得进、读得回（修前被静默丢弃）', async () => {
  requirement('REQ-001')
  const receipt = await recordContract('["REQ-001"]')
  assert.equal(listContracts(store).length, 1, `契约必须落盘：${receipt.slice(0, 240)}`)
  assert.deepEqual(listContracts(store)[0]?.requires, ['REQ-001'], '写进去的 requires 必须读得回来（读端白名单早就支持）')
  const tool = tools.find((item) => item.name === 'sdo_design')
  const properties = (tool?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
  assert.ok(properties['requires'] !== undefined, 'schema 必须声明 requires，否则 DSH 侧先把它丢掉')
})

test('M149-02 判据按它匹配（核心）：契约点了本卡需求 ⇒ **不再走 N/A**，判据真的开口说话', async () => {
  requirement('REQ-001')
  requirement('REQ-002')
  const hit = card(['REQ-001'])
  const miss = card(['REQ-002'])
  await recordContract('["REQ-001"]')
  assert.equal(gapCodes(hit).includes('contract-test-missing'), true, `契约声明命中本卡需求 ⇒ 必须判红（不许再 N/A）：${JSON.stringify(gapCodes(hit))}`)
  assert.equal(gapCodes(miss).includes('contract-test-missing'), false, '契约与这张卡无关 ⇒ 按"没有对象"走 N/A（这是合理的 N/A，不是逃逸）')
  // 补上契约测试 ⇒ 转绿（反例：不是"一律判红"）
  office.recordContractTest(call, { task: hit, contract: listContracts(store)[0]?.id ?? 'CT-001', tool: 'npm', cmd: 'npm test' })
  assert.equal(gapCodes(hit).includes('contract-test-missing'), false, '给了契约测试记录后必须转绿')
})

test('M149-03 写侧校验（零写盘）：未知需求 id / 重复 id 都被**可读拒绝**，不静默落空', async () => {
  requirement('REQ-001')
  const unknown = await recordContract('["REQ-404"]')
  assert.match(unknown, /REQ-404/u, `未知需求 id 必须点名：${unknown.slice(0, 240)}`)
  assert.match(unknown, /N\/A/u, '要把后果说清（那些卡的判据会永久走 N/A）')
  assert.equal(listContracts(store).length, 0, '被拒的契约不得落盘（零写盘）')
  const duplicate = await recordContract('["REQ-001","REQ-001"]')
  assert.match(duplicate, /REQ-001/u, `重复 id 必须点名：${duplicate.slice(0, 240)}`)
  assert.equal(listContracts(store).length, 0, '重复也必须零写盘')
})

test('M149-04 存量口径不追溯：不带 `requires` 的契约照旧能记录，读回是空数组', async () => {
  const receipt = await recordContract()
  assert.equal(listContracts(store).length, 1, `不带 requires 必须照旧可记录：${receipt.slice(0, 200)}`)
  assert.deepEqual(listContracts(store)[0]?.requires, [], '缺省 = 空数组（不假装它挂了某条需求）')
})

test('M149-05 既有的另一条腿不许被放宽：写范围含契约面的卡，即使契约不命中也要判红', async () => {
  requirement('REQ-001')
  // 写范围落在契约面（`src/interface/**`）⇒ `cardWritesContractSurface` 直接成立 ⇒ 无论如何都不 N/A
  const surface = card(['REQ-001'], ['src/interface/'])
  assert.equal(gapCodes(surface).includes('contract-test-missing'), true, `契约面的卡必须判红（防"顺手全判 N/A"）：${JSON.stringify(gapCodes(surface))}`)
})

test('M149-06 TC-135：零写盘用 `readdirSync` **逐项**比对；真账存量「`requires` 非空」仍为 0（不回填、不据此判红）', async () => {
  requirement('REQ-001')
  const dir = join(BASE, '.sdo', 'contracts')
  const listing = (): string[] => {
    try {
      return readdirSync(dir).sort()
    } catch {
      return []
    }
  }
  const before = listing()
  // 两种被拒的写入（未知 id / 重复 id）之后，**目录逐项**不变（不是只看 `listContracts().length`）
  await recordContract('["REQ-404"]')
  await recordContract('["REQ-001","REQ-001"]')
  assert.deepEqual(listing(), before, `被拒的契约不许在盘上留下任何文件（目录逐项比对）：${listing().join(' ')}`)

  // 真账读数：存量契约里「requires 非空」必须仍是 **0**（追加式真源不回填历史；判据也不据此判红）
  const repo = fileURLToPath(new URL('../../', import.meta.url))
  const { SdoStore } = await import('../src/infra/store.js')
  const realStore = new SdoStore(join(repo, '.sdo'))
  const contracts = listContracts(realStore)
  assert.ok(contracts.length > 0, `夹具前提：真账里有契约（实际 ${contracts.length} 条）`)
  const withRequires = contracts.filter((contract) => (contract.requires ?? []).length > 0)
  assert.deepEqual(withRequires.map((contract) => contract.id), [], `真账存量「requires 非空」必须仍为 0（实际 ${withRequires.map((c) => c.id).join(' ')}）`)
})
